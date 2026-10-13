import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function loadDotEnv() {
  const p = path.join(root, '.env');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv();

const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

// 计费模式：显式 CREDITS_MODE 优先；未设时按费率推断，保持与旧配置兼容。
function creditsMode() {
  const raw = String(process.env.CREDITS_MODE || '').toLowerCase();
  if (raw === 'off' || raw === 'second' || raw === 'job') return raw;
  if (num(process.env.CREDITS_PER_JOB, 0) > 0) return 'job';
  if (num(process.env.CREDITS_PER_SECOND, 0) > 0) return 'second';
  return 'off';
}

export const config = {
  root,
  deployment: process.env.DEPLOYMENT || 'internal', // internal | docker | vps
  port: int(process.env.PORT, 8787),
  // Public base URL used inside activation links. If empty, links are built from the request Host.
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
  cookieName: 'h3_token',
  // Skip email activation entirely (fastest path; useful for private/LAN use).
  skipEmailVerification: bool(process.env.SKIP_EMAIL_VERIFICATION, false),
  // 详细日志（分段时长/返回视频与音频时长/拼接结果）。设 H3_DEBUG=1 打开。
  debug: bool(process.env.H3_DEBUG, false),
  // 日志级别（v1.8.3）：debug | info（默认）| warn | error | silent。
  // 默认 info 即可看到每个请求/每个任务/每段生成；H3_DEBUG=1 等价于 debug。
  logLevel: String(process.env.LOG_LEVEL || '').toLowerCase() || (bool(process.env.H3_DEBUG, false) ? 'debug' : 'info'),
  // 计费开关：off=不计费（仅统计，默认）；second=按【秒】计费；job=按【条】计费。
  // 显式设 CREDITS_MODE 优先；未设时按费率推断（CREDITS_PER_JOB>0 则 job，CREDITS_PER_SECOND>0 则 second）。
  creditsMode: creditsMode(),
  // 按秒计费费率：生成 1 秒扣多少点（可小数）。仅 creditsMode=second 时生效。
  creditsPerSecond: num(process.env.CREDITS_PER_SECOND, 0),
  // 按条计费：每完成一条视频扣多少点（可小数）。仅 creditsMode=job 时生效。
  creditsPerJob: num(process.env.CREDITS_PER_JOB, 0),

  // ---- MiniMax H3 backend (vLLM-Omni) ----
  //
  // H3 的每个服务进程只加载一个分区，且分区决定能跑哪些任务：
  //   serve FL2VA 子目录  -> 支持 t2va / fl2va
  //   serve Ref2VA 子目录 -> 仅支持 ref2va
  // 若只有一个后端（旧配置），所有任务都发到它；
  // 若单独配置了 H3_BASE_URL_REF2VA，则 ref2va 走该后端，其余走默认后端。
  h3: {
    baseUrl: (process.env.H3_BASE_URL || 'http://10.1.10.34:32206').replace(/\/+$/, ''),
    // 可选：ref2va 专用后端（serve Ref2VA 分区的进程）
    ref2vaBaseUrl: (process.env.H3_BASE_URL_REF2VA || '').replace(/\/+$/, ''),
    apiKey: process.env.H3_API_KEY || '',
    ref2vaApiKey: process.env.H3_REF2VA_API_KEY || process.env.H3_API_KEY || '',
    // sync endpoint blocks until the clip is fully generated
    timeoutMs: int(process.env.H3_TIMEOUT_MS, 30 * 60 * 1000),
  },

  limits: {
    maxImageMB: int(process.env.MAX_IMAGE_MB, 30),
    maxVideoMB: int(process.env.MAX_VIDEO_MB, 50),
    maxFiles: int(process.env.MAX_FILES, 9),
    promptChars: int(process.env.PROMPT_CHARS, 20000),
    // H3 硬校验：ref2va 的【每个】参考视频时长必须 ∈ [2,15] 秒，且参考视频总时长 ≤15 秒。
    // 用户上传的整段长视频会被 H3 直接拒绝（500），这里用同值做前端限制与自动截取。
    maxRefVideoSec: int(process.env.MAX_REF_VIDEO_SEC, 15),
    // 单次任务允许的总时长（秒）。H3 单段上限 15 秒，超出部分自动分段续写。
    // 默认 1800（30 分钟）；调大需同步关注磁盘与生成耗时。
    maxDurationSec: int(process.env.MAX_DURATION_SEC, 1800),
  },

  smtp: {
    host: process.env.SMTP_HOST || 'smtp.88.com',
    port: int(process.env.SMTP_PORT, 25),
    secure: bool(process.env.SMTP_SECURE, false), // false => STARTTLS optional
    requireTLS: bool(process.env.SMTP_REQUIRE_TLS, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@example.com',
    fromName: process.env.SMTP_FROM_NAME || 'H3 Studio',
    // Some SMTP servers (e.g. smtp.88.com) present a cert that doesn't match the
    // hostname. Set SMTP_TLS_REJECT_UNAUTHORIZED=false to allow it.
    rejectUnauthorized: bool(process.env.SMTP_TLS_REJECT_UNAUTHORIZED, true),
  },

  // ---- 提示词 AI 助手（v1.9）----
  // 任一 OpenAI 兼容端点即可（本地 vLLM / 网关 / 云端）。留空则前端隐藏「AI 重写」按钮。
  // 模型名建议带供应商前缀（如 customonrouter/gpt-6-sol），识别能力由 visionModel 承担。
  llm: {
    baseUrl: (process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    textModel: process.env.LLM_TEXT_MODEL || '',
    visionModel: process.env.LLM_VISION_MODEL || '',
    timeoutMs: int(process.env.LLM_TIMEOUT_MS, 120000),
    // 单次重写/识图请求的图片上限（字节）；超限的参考图会被跳过
    maxImageBytes: int(process.env.LLM_MAX_IMAGE_BYTES, 8 * 1024 * 1024),
  },

  dbFile: process.env.DB_FILE || path.join(root, 'data', 'h3studio.db'),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  outputsDir: process.env.OUTPUTS_DIR || path.join(root, 'data', 'outputs'),
};
