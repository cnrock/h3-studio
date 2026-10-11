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

  // ---- MiniMax H3 backend (vLLM-Omni) ----
  //
  // H3 的每个服务进程只加载一个分区，且分区决定能跑哪些任务：
  //   serve FL2VA 子目录  -> 支持 t2va / fl2va
  //   serve Ref2VA 子目录 -> 仅支持 ref2va
  // 若只有一个后端（旧配置），所有任务都发到它；
  // 若单独配置了 H3_BASE_URL_REF2VA，则 ref2va 走该后端，其余走默认后端。
  h3: {
    baseUrl: (process.env.H3_BASE_URL || 'http://192.0.2.10:8003').replace(/\/+$/, ''),
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
    promptChars: int(process.env.PROMPT_CHARS, 7000),
    // 单次任务允许的总时长（秒）。H3 单段上限 15 秒，超出部分自动分段续写。
    // 默认 1800（30 分钟）；调大需同步关注磁盘与生成耗时。
    maxDurationSec: int(process.env.MAX_DURATION_SEC, 1800),
  },

  smtp: {
    host: process.env.SMTP_HOST || 'smtp.example.com',
    port: int(process.env.SMTP_PORT, 25),
    secure: bool(process.env.SMTP_SECURE, false), // false => STARTTLS optional
    requireTLS: bool(process.env.SMTP_REQUIRE_TLS, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@example.com',
    fromName: process.env.SMTP_FROM_NAME || 'H3 Studio',
    // Some SMTP servers (e.g. smtp.example.com) present a cert that doesn't match the
    // hostname. Set SMTP_TLS_REJECT_UNAUTHORIZED=false to allow it.
    rejectUnauthorized: bool(process.env.SMTP_TLS_REJECT_UNAUTHORIZED, true),
  },

  dbFile: process.env.DB_FILE || path.join(root, 'data', 'h3studio.db'),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  outputsDir: process.env.OUTPUTS_DIR || path.join(root, 'data', 'outputs'),
};
