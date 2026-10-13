import { config } from './config.js';

/**
 * 轻量分级日志（v1.8.3）。
 *
 * 级别由 `LOG_LEVEL` 控制：debug | info | warn | error | silent（默认 info）。
 * 默认 info 就已经包含「每个 HTTP 请求 / 每个任务入队-开始-完成-失败 / 每段生成」这些
 * 关键节点，运维在 `docker logs -f h3-studio` 里无需任何改动就能排查；
 * 只有更细的逐段秒数细节（音视频对齐、字节数、拼接前后时长）才需要 LOG_LEVEL=debug。
 *
 * 兼容旧变量：`H3_DEBUG=1` 等价于 `LOG_LEVEL=debug`。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const envLevel = String(process.env.LOG_LEVEL || '').toLowerCase();
// 显式 LOG_LEVEL 优先；否则 H3_DEBUG=1 视为 debug，默认为 info。
export const LOG_LEVEL_NUM =
  LEVELS[envLevel] ?? (config.debug ? LEVELS.debug : LEVELS.info);

/**
 * 本地时间戳（含时区偏移），如 2026-10-13T14:50:25.679+08:00。
 * 容器时区由 TZ 决定（镜像默认 Asia/Shanghai）；不带 TZ 时回落到宿主/容器 UTC。
 */
const pad = (n, w = 2) => String(n).padStart(w, '0');
const ts = () => {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

function emit(stream, level, tag, args) {
  if (LEVELS[level] < LOG_LEVEL_NUM) return;
  stream(`[${ts()}] [h3:${tag}]`, ...args);
}

export const log = {
  /** 当前生效级别名（供启动横幅打印） */
  level: () => Object.keys(LEVELS).find((k) => LEVELS[k] === LOG_LEVEL_NUM) || 'info',
  debug: (...a) => emit(console.log, 'debug', 'debug', a),
  info: (...a) => emit(console.log, 'info', 'info', a),
  /** 成功节点（info 级别，前缀 [h3:ok] 便于一眼扫到） */
  ok: (...a) => emit(console.log, 'info', 'ok', a),
  warn: (...a) => emit(console.warn, 'warn', 'warn', a),
  error: (...a) => emit(console.error, 'error', 'error', a),
};
