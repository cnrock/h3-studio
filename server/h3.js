import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';

// 连接期瞬时错误（socket hang up / ECONNRESET 等）的重试次数。
// v1.11.1：排队视频里「第 1 条正常、第 2 条 0ms 报 socket hang up」的根因是
// Node 默认 keep-alive 连接池复用了已被对端关闭的旧 socket；这里禁 keep-alive
// 并把瞬时连接错误重试一次（不重试 4xx/5xx 这类业务错误）。
const H3_NET_ATTEMPTS = 2;

// v1.11.2：H3 引擎瞬时不可用（Stage-0 无可用副本 / 引擎崩溃后正在重启）的重试。
// 现象：上一段把引擎跑崩后，后面排队任务会在 0.2s 内秒失败
// 「Stage-0 has no live replica」；等引擎重启完再点「重新生成」又能成功。
// 这里对这类【秒级失败】的引擎不可用自动等待重试；若某次尝试已跑很久（说明
// 是长跑中途引擎崩掉、已消耗大量算力）则不自动重试，交给用户决定，避免重复烧算力。
const H3_ENGINE_RETRY = Math.max(0, Number(process.env.H3_ENGINE_RETRY ?? 8) || 0);            // 引擎不可用最多等待重试次数
const H3_ENGINE_RETRY_WAIT_MS = Math.max(1000, Number(process.env.H3_ENGINE_RETRY_WAIT_MS ?? 15000) || 15000); // 每次等待（引擎重启一般 1~2 分钟）
const H3_ENGINE_FAST_FAIL_MS = Math.max(0, Number(process.env.H3_ENGINE_FAST_FAIL_MS ?? 60000) || 0);  // 仅当该次失败耗时 < 该值才自动重试（秒级失败才重试）

const H3_TRANSIENT_RE = /socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket disconnected|other side closed/i;
const H3_ENGINE_DOWN_RE = /EngineCore|inline diffusion engine is dead|has no live replica|no live replica|engine is dead|engine not ready|not ready to serve|worker.*(?:restart|crash)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build and send a MiniMax H3 (vLLM-Omni) video request.
 *
 * Endpoint: POST {H3_BASE_URL}/v1/videos/sync  (multipart/form-data)
 * Blocks until generation finishes and returns raw MP4 bytes.
 *
 * 实现说明（重要）：
 *   不用 Node 内置 fetch —— 它的 undici 默认 headersTimeout=300s，长视频单段
 *   要 4~6 分钟，会在 300 秒被掐断（UND_ERR_HEADERS_TIMEOUT）。
 *   也不引入 undici npm 包 —— 它与 Node 内置的 FormData 不兼容（会被当成
 *   普通对象字符串化成 "[object FormData]"，导致 H3 报 body.prompt missing）。
 *   这里直接用内置 http/https 自己拼 multipart，超时完全可控，无额外依赖。
 *
 * Mode mapping:
 *   - t2va : text only                          -> no reference files
 *   - fl2va: text + up to 2 frames (first/last) -> input_reference (image)
 *   - ref2va: text + omni references (images / video clips / audio)
 *
 * Extra params (duration, audio_flow_shift, task) go in `extra_params` as JSON.
 */

function extraParams(obj) {
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') clean[k] = v;
  }
  return JSON.stringify(clean);
}

const ASPECTS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'Auto']);

/** 构造 multipart/form-data 请求体（Buffer） */
function buildMultipart(fields, files) {
  const boundary = '----H3Studio' + crypto.randomBytes(16).toString('hex');
  const parts = [];

  const push = (s) => parts.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'));

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    push(String(value));
    push('\r\n');
  }

  for (const f of files) {
    push(`--${boundary}\r\n`);
    push(
      `Content-Disposition: form-data; name="${f.field}"; filename="${f.filename || 'file'}"\r\n`,
    );
    push(`Content-Type: ${f.mimetype || 'application/octet-stream'}\r\n\r\n`);
    push(f.buffer);
    push('\r\n');
  }

  push(`--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat(parts) };
}

/** One-shot HTTP request helper used by the asynchronous VDN API. */
function requestHttp(url, { method = 'GET', headers = {}, body = null, timeoutMs = config.h3.timeoutMs } = {}) {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method,
      headers,
      agent: false,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        contentType: res.headers['content-type'] || '',
        headers: res.headers,
        buffer: Buffer.concat(chunks),
      }));
    });
    req.on('timeout', () => req.destroy(new Error(`VDN 请求超时（>${timeoutMs} ms）`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseJsonResponse(response) {
  try { return JSON.parse(response.buffer.toString('utf8')); } catch { return null; }
}

/**
 * VDN 的 fl2va 必须显式给出 conditions（keyframe 条目），只上传 input_reference
 * 会被服务端判定为“没有条件帧”而 400。图片以 data URI 传递，避免依赖服务端
 * 本地路径；顺序语义固定：第 1 张 = 首帧(frame_index 0)，第 2 张 = 末帧(-1)。
 */
function buildVdnConditions(mode, files) {
  const images = (files || []).filter(
    (f) => /^image\//.test(f.mimetype || '') && f.buffer?.length,
  );
  if (!images.length) return [];
  const toUri = (f) =>
    `data:${f.mimetype || 'image/png'};base64,${f.buffer.toString('base64')}`;
  if (mode === 'fl2va') {
    const list = images.slice(0, 2).map((f, i) => ({
      type: 'image',
      uri: toUri(f),
      role: 'keyframe',
      frame_index: i === 0 ? 0 : -1,
    }));
    return list;
  }
  // VDN-H3 只服务 t2va / fl2va；ref2va 已在上游降级为 fl2va 处理。
  return images.map((f) => ({ type: 'image', uri: toUri(f), role: 'reference' }));
}

async function generateVideoVdn(o, baseUrl, apiKey) {
  const duration = Math.min(15, Math.max(4, Number(o.duration) || 5));
  const target = {
    short_edge: 768,
    aspect_ratio: o.aspectRatio || '16:9',
    duration_seconds: duration,
  };
  const conditions = buildVdnConditions(o.mode, o.files);
  if (o.mode === 'fl2va' && conditions.length === 0) {
    throw new Error('VDN fl2va 需要首帧参考图，但本次请求未携带图片');
  }
  const extra = {
    task: o.mode,
    target,
    conditions,
    audio_flow_shift: o.audioFlowShift ?? 3.0,
    quality: o.turbo ? 'high' : undefined,
  };
  const fields = {
    model: config.h3.model,
    prompt: o.prompt ?? '',
    task: o.mode,
    seconds: Math.round(duration),
    target: JSON.stringify(target),
    conditions: JSON.stringify(conditions),
    num_inference_steps: 8,
    flow_shift: o.flowShift ?? 12,
    audio_flow_shift: o.audioFlowShift ?? 3.0,
  };
  if (o.turbo) fields.quality = 'high';
  if (Number.isFinite(o.seed)) fields.seed = String(o.seed);

  const url = `${baseUrl}/v1/videos`;
  let body;
  let headers = { Accept: 'application/json' };
  if (o.files?.length) {
    // 保留 multipart 作为兼容路径：图片同时以 input_reference 提供，供只认上传字段的部署使用。
    const multipartFields = { ...fields, extra_params: JSON.stringify(extra) };
    const built = buildMultipart(multipartFields, o.files);
    body = built.body;
    headers['Content-Type'] = `multipart/form-data; boundary=${built.boundary}`;
    headers['Content-Length'] = String(body.length);
  } else {
    body = Buffer.from(JSON.stringify({ ...fields, target, conditions, task: o.mode, model: config.h3.model }), 'utf8');
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(body.length);
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const submitted = await requestHttp(url, { method: 'POST', headers, body, timeoutMs: config.h3.timeoutMs });
  const job = parseJsonResponse(submitted);
  if (submitted.status < 200 || submitted.status >= 300 || !job?.id) {
    const detail = job?.error || job?.detail || submitted.buffer.toString('utf8').slice(0, 500);
    throw new Error(`VDN 返回 ${submitted.status}：${detail}`);
  }
  const jobUrl = `${baseUrl}/v1/videos/${encodeURIComponent(job.id)}`;
  const deadline = Date.now() + config.h3.pollTimeoutMs;
  let latest = job;
  while (Date.now() < deadline) {
    const status = String(latest.status || '').toLowerCase();
    if (status === 'completed' || status === 'succeeded' || status === 'done') break;
    if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
      throw new Error(`VDN 任务失败：${latest.error || '未知错误'}`);
    }
    await sleep(Math.max(100, config.h3.pollMs));
    const polled = await requestHttp(jobUrl, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, timeoutMs: Math.min(config.h3.timeoutMs, 30_000) });
    latest = parseJsonResponse(polled) || latest;
    if (polled.status >= 400) throw new Error(`VDN 查询任务失败 ${polled.status}：${polled.buffer.toString('utf8').slice(0, 300)}`);
  }
  if (!['completed', 'succeeded', 'done'].includes(String(latest.status || '').toLowerCase())) {
    throw new Error(`VDN 任务轮询超时（>${config.h3.pollTimeoutMs} ms，任务 ${job.id}）`);
  }
  const contentUrl = latest.url && /^https?:/.test(latest.url) ? latest.url : `${jobUrl}/content`;
  const content = await requestHttp(contentUrl, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, timeoutMs: config.h3.timeoutMs });
  if (content.status < 200 || content.status >= 300 || !content.buffer.length) {
    throw new Error(`VDN 下载视频失败 ${content.status}：${content.buffer.toString('utf8').slice(0, 300)}`);
  }
  return { bytes: content.buffer, contentType: content.contentType || 'video/mp4' };
}

/**
 * @param {object} o
 * @param {string} o.prompt
 * @param {string} o.mode  t2va | fl2va | ref2va
 * @param {number} o.width
 * @param {number} o.height
 * @param {string} o.aspectRatio
 * @param {number} o.fps
 * @param {number} o.steps
 * @param {number} o.flowShift
 * @param {number} o.seed
 * @param {number} o.duration       seconds (4–15)
 * @param {number} o.audioFlowShift
 * @param {Array<{buffer:Buffer,mimetype:string,field:string,filename:string}>} o.files
 * @returns {Promise<{bytes:Buffer, contentType:string}>}
 */
export async function generateVideo(o) {
  if (config.h3.apiMode !== 'legacy') {
    const useRef2va = o.mode === 'ref2va' && config.h3.ref2vaBaseUrl;
    const baseUrl = useRef2va ? config.h3.ref2vaBaseUrl : config.h3.baseUrl;
    const apiKey = useRef2va ? config.h3.ref2vaApiKey : config.h3.apiKey;
    return generateVideoVdn(o, baseUrl, apiKey);
  }
  const t0 = Date.now();
  const fields = {
    prompt: o.prompt ?? '',
    width: String(o.width),
    height: String(o.height),
    fps: String(o.fps ?? 24),
    num_inference_steps: String(o.steps ?? 50),
    flow_shift: String(o.flowShift ?? 12),
  };
  if (o.aspectRatio && ASPECTS.has(o.aspectRatio)) fields.aspect_ratio = o.aspectRatio;
  if (Number.isFinite(o.seed)) fields.seed = String(o.seed);

  // duration is required; H3 accepts 4–15 s per single generation.
  const duration = Math.min(15, Math.max(4, Number(o.duration) || 5));
  const extra = {
    task: o.mode,
    duration,
    audio_flow_shift: o.audioFlowShift ?? 3.0,
  };
  // Turbo 模式：加 Cache-DiT quality=high（官方 1.35× 提速，SSIM 0.97）
  if (o.turbo) extra.quality = 'high';
  fields.extra_params = extraParams(extra);

  const { boundary, body } = buildMultipart(fields, o.files ?? []);

  // 按模式选后端：ref2va 需要单独的 Ref2VA 分区进程（若已配置）。
  const useRef2va = o.mode === 'ref2va' && config.h3.ref2vaBaseUrl;
  const baseUrl = useRef2va ? config.h3.ref2vaBaseUrl : config.h3.baseUrl;
  const apiKey = useRef2va ? config.h3.ref2vaApiKey : config.h3.apiKey;

  const url = new URL(`${baseUrl}/v1/videos/sync`);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': String(body.length),
  };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  // 单次 HTTP 请求。agent:false => 每次新建连接、不复用 keep-alive 连接池。
  // H3 单段要跑数分钟，长时间空闲后服务端/中间设备会先关掉这条长连接；下一个
  // 任务若复用池中这条「已被对端关闭」的 socket，就会在 0ms 内直接 socket hang up。
  const doRequest = () =>
    new Promise((resolve, reject) => {
      const req = lib.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers,
          agent: false, // 禁 keep-alive：不复用可能已被对端关闭的旧连接
          timeout: config.h3.timeoutMs, // 含连接、发送、等待响应（Node 会在超时后销毁 socket）
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              contentType: res.headers['content-type'] || '',
              buffer: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on('timeout', () => req.destroy(new Error(`H3 请求超时（>${config.h3.timeoutMs} ms）`)));
      req.on('error', reject);
      req.end(body);
    });

  let status;
  let contentType;
  let buffer;
  let netTries = 0;
  let engineTries = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tAttempt = Date.now();
    try {
      ({ status, contentType, buffer } = await doRequest());
    } catch (err) {
      netTries++;
      const transient = H3_TRANSIENT_RE.test(String(err.message || err));
      log.warn(`H3 连接失败（第 ${netTries} 次）：${err.message || err}`);
      if (!transient || netTries >= H3_NET_ATTEMPTS) throw err;
      await sleep(2000);
      continue;
    }
    if (status >= 200 && status < 300) break;

    const bodyText = buffer.toString('utf8').slice(0, 500);
    const elapsed = Date.now() - tAttempt;
    const engineDown = H3_ENGINE_DOWN_RE.test(bodyText);
    if (engineDown && elapsed < H3_ENGINE_FAST_FAIL_MS && engineTries < H3_ENGINE_RETRY) {
      engineTries++;
      const left = H3_ENGINE_RETRY - engineTries;
      log.warn(
        `H3 引擎暂不可用（第 ${engineTries}/${H3_ENGINE_RETRY} 次，${elapsed}ms，约 ${Math.round((H3_ENGINE_RETRY_WAIT_MS * (left + 1)) / 1000)}s 内继续尝试）：${bodyText.slice(0, 160)}`,
      );
      await sleep(H3_ENGINE_RETRY_WAIT_MS);
      continue;
    }

    const ms = Date.now() - t0;
    log.warn(`H3 请求失败 ${o.mode} ${o.width}x${o.height} ${duration}s → ${status}（${ms}ms）：${bodyText.slice(0, 200)}`);
    if (engineDown) {
      // 长跑中途引擎崩掉：已消耗大量算力，不自动重试，给用户可行动的中文提示。
      throw new Error(
        `H3 引擎崩溃（Stage-0 无可用副本/engine dead）。这通常是本次生成把推理引擎跑崩（常见于 2K 实验档等超原生画布分辨率），` +
          `引擎会自动重启，稍等 1~2 分钟后点「重新生成」即可；如反复出现请改用标准档分辨率。原始信息：${bodyText}`,
      );
    }
    throw new Error(`H3 返回 ${status}：${bodyText}`);
  }

  const text = () => buffer.toString('utf8').slice(0, 500);

  const ms = Date.now() - t0;
  if (status < 200 || status >= 300) {
    log.warn(`H3 请求失败 ${o.mode} ${o.width}x${o.height} ${duration}s → ${status}（${ms}ms）：${text().slice(0, 200)}`);
    throw new Error(`H3 返回 ${status}：${text()}`);
  }
  if (!contentType.includes('video') && !contentType.includes('octet-stream')) {
    log.warn(`H3 未返回视频 ${o.mode} → content-type=${contentType}（${ms}ms）`);
    throw new Error(`H3 未返回视频（content-type=${contentType}）：${text().slice(0, 300)}`);
  }
  log.debug(`H3 请求完成 ${o.mode} ${o.width}x${o.height} ${duration}s → ${(buffer.length / 1048576).toFixed(2)}MB（${ms}ms）`);
  return { bytes: buffer, contentType: contentType || 'video/mp4' };
}

export async function health(baseUrl) {
  return new Promise((resolve) => {
    const url = new URL(`${baseUrl || config.h3.baseUrl}/health`);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'GET',
        timeout: 10_000,
      },
      (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      },
    );
    req.on('timeout', () => req.destroy(new Error('health timeout')));
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}
