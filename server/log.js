import { config } from './config.js';

/**
 * 轻量日志。`debug` 级别默认关闭，设 H3_DEBUG=1 打开（docker compose 里加到 .env 即可）。
 * 详细日志用于排查长视频分段拼接：每段的请求时长、返回字节数、返回视频/音频实际时长、
 * 归一化前后时长、拼接后总时长，都会打出来。
 */
const ts = () => new Date().toISOString();

export const log = {
  debug: (...a) => { if (config.debug) console.log(`[${ts()}] [h3:debug]`, ...a); },
  info: (...a) => console.log(`[${ts()}] [h3:info]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] [h3:warn]`, ...a),
};
