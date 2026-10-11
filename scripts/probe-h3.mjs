#!/usr/bin/env node
/**
 * 探测自建 H3 后端是否可达，并可选跑一次最小生成请求。
 *
 *   node scripts/probe-h3.mjs            # 只测 /health 与 /v1/models
 *   node scripts/probe-h3.mjs --gen      # 额外发一次 4 秒 T2VA 生成（耗时较长）
 */
// config.js 自带 .env 加载，无需额外依赖
import { config } from '../server/config.js';

const base = config.h3.baseUrl;
console.log('H3_BASE_URL =', base);

async function get(path) {
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    console.log(`${path} -> HTTP ${res.status}  ${text.slice(0, 300)}`);
    return res.ok;
  } catch (err) {
    console.log(`${path} -> 失败: ${err.message}`);
    return false;
  }
}

await get('/health');
await get('/v1/models');

if (process.argv.includes('--gen')) {
  console.log('\n发起最小生成请求（4 秒 T2VA）…');
  const fd = new FormData();
  fd.set('prompt', '一只橘猫坐在窗台上看雨，镜头缓慢推近。');
  fd.set('width', '1344');
  fd.set('height', '768');
  fd.set('aspect_ratio', '16:9');
  fd.set('fps', '24');
  fd.set('num_inference_steps', '50');
  fd.set('flow_shift', '12');
  fd.set('seed', '1101');
  fd.set('extra_params', JSON.stringify({ task: 't2va', duration: 4, audio_flow_shift: 3.0 }));
  try {
    const res = await fetch(`${base}/v1/videos/sync`, {
      method: 'POST',
      body: fd,
      signal: AbortSignal.timeout(config.h3.timeoutMs),
    });
    const ct = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`生成 -> HTTP ${res.status}  content-type=${ct}  字节=${buf.length}`);
    if (res.ok && buf.length) {
      const out = 'probe-output.mp4';
      const { writeFileSync } = await import('node:fs');
      writeFileSync(out, buf);
      console.log('已保存:', out);
    }
  } catch (err) {
    console.log('生成失败:', err.message);
  }
}
