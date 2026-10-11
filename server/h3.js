import { config } from './config.js';

/**
 * Build and send a MiniMax H3 (vLLM-Omni) video request.
 *
 * Endpoint: POST {H3_BASE_URL}/v1/videos/sync  (multipart/form-data)
 * Blocks until generation finishes and returns raw MP4 bytes.
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
  const fd = new FormData();

  fd.set('prompt', o.prompt ?? '');
  fd.set('width', String(o.width));
  fd.set('height', String(o.height));
  if (o.aspectRatio && ASPECTS.has(o.aspectRatio)) fd.set('aspect_ratio', o.aspectRatio);
  fd.set('fps', String(o.fps ?? 24));
  fd.set('num_inference_steps', String(o.steps ?? 50));
  fd.set('flow_shift', String(o.flowShift ?? 12));
  if (Number.isFinite(o.seed)) fd.set('seed', String(o.seed));

  // duration is required; clamp to the model's 4–15 s window.
  const duration = Math.min(15, Math.max(4, Number(o.duration) || 5));
  fd.set(
    'extra_params',
    extraParams({
      task: o.mode,
      duration,
      audio_flow_shift: o.audioFlowShift ?? 3.0,
    }),
  );

  for (const f of o.files ?? []) {
    const blob = new Blob([f.buffer], { type: f.mimetype || 'application/octet-stream' });
    fd.append(f.field, blob, f.filename || 'reference');
  }

  const url = `${config.h3.baseUrl}/v1/videos/sync`;
  const headers = {};
  if (config.h3.apiKey) headers.Authorization = `Bearer ${config.h3.apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.h3.timeoutMs);

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: fd, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`H3 请求超时（>${config.h3.timeoutMs} ms）`);
    throw new Error(`无法连接 H3 后端 ${url}：${err.message}`);
  }
  clearTimeout(timer);

  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`H3 返回 ${res.status}：${text.slice(0, 500)}`);
  }
  if (!contentType.includes('video') && !contentType.includes('octet-stream')) {
    // Some deployments return JSON on error with 200.
    const text = await res.text().catch(() => '');
    throw new Error(`H3 未返回视频（content-type=${contentType}）：${text.slice(0, 300)}`);
  }

  const arrayBuf = await res.arrayBuffer();
  return { bytes: Buffer.from(arrayBuf), contentType: contentType || 'video/mp4' };
}

export async function health() {
  try {
    const res = await fetch(`${config.h3.baseUrl}/health`, { method: 'GET' });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
