import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';

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
  fields.extra_params = extraParams({
    task: o.mode,
    duration,
    audio_flow_shift: o.audioFlowShift ?? 3.0,
  });

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

  const { status, contentType, buffer } = await new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
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
