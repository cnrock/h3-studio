import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { verifyMailer, sendMail } from './mail.js';
import { health as h3Health } from './h3.js';
import {
  checkPassword, createUser, findUserByEmail, findUserById, publicUser,
  ensureVerifyToken, resetPassword, setResetToken, signToken, verifyByToken, authMiddleware,
} from './auth.js';
import { createJob, deleteJob, enqueue, getJob, listJobs, regenerateJob, statsForUser } from './jobs.js';
import { presetsForClient, normalizeSize, aspectFor, ALIGN } from './resolutions.js';
import { gridInfo, gridDuration } from './frameGrid.js';
import { planSegments } from './longvideo.js';
import { ref2vaScaffold, ref2vaTagList, REF2VA_TEMPLATE } from './promptHints.js';
import { log } from './log.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const uploadsDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const app = express();
app.disable('x-powered-by');

// ---- security headers ----
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  );
  // 仅在 HTTPS 反代后面才发 HSTS，避免纯 HTTP 内网部署被锁死
  if (process.env.ENABLE_HSTS === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

// 安全兜底：绝不允许凭据出现在 URL（会进浏览器历史 / Referer / 反代与服务器访问日志）。
// 前端登录表单已改为 JS POST 提交（并显式 method=post），但若有旧页面缓存 / JS 被拦截 /
// 脚本报错导致浏览器原生 GET 提交，这里会立刻 303 到干净路径，把凭据从 URL 与历史中剔除。
// 注意：/api/auth/reset 与 /api/auth/verify 合法地使用 query（token 非密码），因此排除。
const CRED_KEYS = ['password', 'passwd', 'pass', 'pwd', 'credential', 'email'];
app.use((req, res, next) => {
  if (req.method === 'GET' && req.query && !req.path.startsWith('/api/')) {
    const leaked = CRED_KEYS.some((k) => typeof req.query[k] === 'string' && req.query[k] !== '');
    if (leaked) {
      return res.redirect(303, req.path); // 丢弃全部 query，不经处理器
    }
  }
  next();
});
// tiny cookie parser (avoids an extra dependency)
app.use((req, _res, next) => {
  req.cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  next();
});

// ---- 请求日志（v1.8.3）----
// 默认 info 级别就会记录每个请求的「方法 路径 → 状态 耗时」。日志里【不带 query】
// （避免 token/凭据进日志）；静态资源（/、/*.css、/*.js、favicon）默认跳过，避免刷屏。
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const p = req.path;
    if (p === '/' || p.endsWith('.css') || p.endsWith('.js') || p.endsWith('.ico') || p.endsWith('.png') || p.endsWith('.webp')) return;
    log.info(`${req.method} ${p} → ${res.statusCode} ${Date.now() - start}ms ip=${ipOf(req)}`);
  });
  next();
});

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  // 反代 HTTPS 时（ENABLE_HSTS=true）自动启用 Secure
  secure: process.env.ENABLE_HSTS === 'true',
  maxAge: 30 * 24 * 3600 * 1000,
};

// ---- 极简内存限速（防暴力破解/刷注册） ----
function makeLimiter({ windowMs, max, key }) {
  const hits = new Map();
  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (t - v.start > windowMs) hits.delete(k);
  }, windowMs).unref?.();
  return (req, res, next) => {
    const k = key(req);
    const t = Date.now();
    let rec = hits.get(k);
    if (!rec || t - rec.start > windowMs) {
      rec = { start: t, n: 0 };
      hits.set(k, rec);
    }
    rec.n++;
    if (rec.n > max) {
      const retry = Math.ceil((rec.start + windowMs - t) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retry)));
      return res.status(429).json({ error: `请求过于频繁，请 ${Math.max(1, retry)} 秒后再试` });
    }
    next();
  };
}

/**
 * 客户端真实 IP（用于日志与限速）。
 * - 优先反代头 x-forwarded-for / x-real-ip；
 * - 去掉 IPv4 映射前缀 ::ffff:（Node 在 IPv6 套接字上收到 IPv4 会加这个）；
 * - IPv6 环回 ::1 归一为 127.0.0.1。
 */
function ipOf(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = fwd || String(req.headers['x-real-ip'] || '').trim() || req.socket.remoteAddress || 'unknown';
  const ip = raw.replace(/^::ffff:/i, '');
  return ip === '::1' ? '127.0.0.1' : ip;
}

const loginLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 10, key: ipOf });
const registerLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 5, key: ipOf });
const forgotLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 5, key: ipOf });

// ---------- uploads ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname) || ''}`),
  }),
  limits: { fileSize: config.limits.maxVideoMB * 1024 * 1024, files: config.limits.maxFiles },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image|video|audio)\//.test(file.mimetype);
    cb(ok ? null : new Error(`不支持的文件类型：${file.mimetype}`), ok);
  },
});

function baseUrl(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.headers.host}`;
}

// ---------- auth routes ----------
app.post('/api/auth/register', registerLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (findUserByEmail(email)) return res.status(409).json({ error: '该邮箱已注册' });

    const { id, verifyToken } = await createUser(email, password);
    const user = findUserById(id);
    log.info(`注册新用户 ${user.email}（跳过激活=${config.skipEmailVerification}）`);

    if (config.skipEmailVerification) {
      const token = signToken(user);
      res.cookie(config.cookieName, token, COOKIE_OPTS);
      return res.json({ ok: true, verified: true, token, user: publicUser(user) });
    }

    const link = `${baseUrl(req)}/api/auth/verify?token=${verifyToken}`;
    try {
      await sendMail({
        to: user.email,
        subject: '【H3 Studio】请激活你的账号',
        text: `点击链接激活账号：${link}\n\n如果链接无法点击，请复制到浏览器打开。`,
        html: `<p>欢迎使用 H3 Studio。</p><p>请点击下面的链接激活账号：</p><p><a href="${link}">${link}</a></p><p>若链接无法点击，请复制到浏览器打开。</p>`,
      });
    } catch (err) {
      return res.status(502).json({ error: `注册成功，但激活邮件发送失败：${err.message}` });
    }
    res.json({ ok: true, verified: false, message: '注册成功，请到邮箱点击激活链接' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 重发激活邮件：注册时激活邮件发失败后，用户自己就能补发（此前只能手动改库）。
// 统一从邮箱出发（不暴露该邮箱是否已注册/是否已激活）。
app.post('/api/auth/resend', forgotLimiter, async (req, res) => {
  const email = String((req.body || {}).email || '').trim();
  const r = email ? ensureVerifyToken(email) : null;
  if (r) {
    const link = `${baseUrl(req)}/api/auth/verify?token=${r.token}`;
    try {
      await sendMail({
        to: r.user.email,
        subject: '【H3 Studio】请激活你的账号',
        text: `点击链接激活账号：${link}\n\n如果链接无法点击，请复制到浏览器打开。`,
        html: `<p>欢迎使用 H3 Studio。</p><p>请点击下面的链接激活账号：</p><p><a href="${link}">${link}</a></p><p>若链接无法点击，请复制到浏览器打开。</p>`,
      });
      log.info(`重发激活邮件 ${r.user.email}`);
    } catch (err) {
      log.warn(`重发激活邮件失败 ${r.user.email}：${err.message}`);
      return res.status(502).json({ error: `激活邮件发送失败：${err.message}` });
    }
  }
  res.json({ ok: true, message: '如果该邮箱已注册且未激活，激活邮件已重新发送' });
});

app.get('/api/auth/verify', (req, res) => {
  const token = String(req.query.token || '');
  const user = token ? verifyByToken(token) : null;
  if (!user) return res.status(400).send(page('激活失败', '链接无效或已使用。'));
  const jwtToken = signToken(user);
  res.cookie(config.cookieName, jwtToken, COOKIE_OPTS);
  res.send(page('激活成功', '你的账号已激活，可以关闭本页并使用网站了。'));
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const user = email && findUserByEmail(email);
  if (!user || !(await checkPassword(password || '', user.password_hash))) {
    log.warn(`登录失败 ${email || '(空)'} ip=${ipOf(req)}`);
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  if (!user.verified) return res.status(403).json({ error: '账号未激活，请先到邮箱点击激活链接' });
  log.info(`登录成功 ${user.email}`);
  const token = signToken(user);
  res.cookie(config.cookieName, token, COOKIE_OPTS);
  res.json({ ok: true, token, user: publicUser(user) });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(config.cookieName);
  res.json({ ok: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/auth/forgot', forgotLimiter, async (req, res) => {
  const { email } = req.body || {};
  const r = email ? setResetToken(email) : null;
  if (r) {
    const link = `${baseUrl(req)}/reset.html?token=${r.token}`;
    try {
      await sendMail({
        to: r.user.email,
        subject: '【H3 Studio】重置密码',
        text: `点击链接重置密码（1 小时内有效）：${link}`,
        html: `<p>点击下面的链接重置密码（1 小时内有效）：</p><p><a href="${link}">${link}</a></p>`,
      });
    } catch { /* do not leak */ }
  }
  // Always the same answer (do not reveal whether the email exists)
  res.json({ ok: true, message: '如果该邮箱已注册，重置邮件已发送' });
});

app.post('/api/auth/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const u = token ? await resetPassword(token, password) : null;
  if (!u) return res.status(400).json({ error: '链接无效或已过期' });
  res.json({ ok: true, message: '密码已重置，请重新登录' });
});

// ---------- generation ----------
const MODES = new Set(['t2va', 'fl2va', 'ref2va']);

app.post('/api/generate', authMiddleware, upload.array('files', config.limits.maxFiles), (req, res) => {
  try {
    const mode = String(req.body.mode || 't2va');
    if (!MODES.has(mode)) return res.status(400).json({ error: '不支持的生成模式' });
    const prompt = String(req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: '请输入提示词' });
    if (prompt.length > config.limits.promptChars) return res.status(400).json({ error: `提示词过长（上限 ${config.limits.promptChars} 字符）` });

    const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

    // 分辨率纠偏：每轴 32 对齐 + 短边≥384；画幅比例以像素为准（避免 9:16+1344×768 这类矛盾组合）
    const size = normalizeSize(num(req.body.width, 1344), num(req.body.height, 768));
    if (size.error) return res.status(400).json({ error: size.error });

    // H3 的 multipart 参考字段名有严格区分（见 vLLM-Omni helpers.py / 官方测试）：
    //   - ref2va（参考素材，可图可视频混合）→ 复数 input_references
    //   - fl2va 单帧 → 单数 input_reference
    // 用错字段名会导致：单数字段下多文件只剩最后一个，且视频被解码成帧序列后
    // 被当成「多个视频参考」而报 “ref2va accepts at most 3 video references”。
    const uploads = req.files || [];
    const refField = mode === 'ref2va' || uploads.length > 1 ? 'input_references' : 'input_reference';
    const files = uploads.map((f) => ({
      field: refField,
      filename: f.originalname,
      path: f.path,
      mimetype: f.mimetype,
    }));

    // Image/video reference JSON payloads (mutually exclusive with input_reference uploads
    // when the model requires it — we keep uploads for binary files and JSON for URLs).
    if (req.body.image_reference) files.push({ field: 'image_reference', filename: 'image_reference', path: null, mimetype: 'application/json', inline: String(req.body.image_reference) });
    if (req.body.video_reference) files.push({ field: 'video_reference', filename: 'video_reference', path: null, mimetype: 'application/json', inline: String(req.body.video_reference) });

    // 时长：先夹到允许区间（若用户填的超过 maxDurationSec 会被截到上限，需明确回告前端），再吸附到 H3 合法帧网格
    const rawDuration = num(req.body.duration, 5);
    const cap = config.limits.maxDurationSec;
    const durClamped = Math.max(4, Math.min(rawDuration, cap));
    const durationCapped = rawDuration > cap;
    const snapped = gridDuration(durClamped);
    // 长视频会分段：提示要按【真实分段】给，而不是把总时长吸附成单段 15.08s。
    const segSecs = planSegments(durClamped);
    const segGrid = segSecs.map((s) => gridDuration(s));
    const segmentCount = segGrid.length;

    const params = {
      width: size.width,
      height: size.height,
      // 画幅比例以实际像素为准（权威）：即使客户端传了矛盾的 aspect_ratio，
      // 也以对齐后的宽高反推，从根上避免 9:16 + 16:9 像素这类组合
      aspectRatio: aspectFor(size.width, size.height),
      fps: num(req.body.fps, 24),
      steps: num(req.body.num_inference_steps, 50),
      flowShift: num(req.body.flow_shift, 12),
      seed: req.body.seed === '' || req.body.seed === undefined ? undefined : Number(req.body.seed),
      // 时长允许 4–maxDurationSec 秒（默认 1800）；超过 15 秒时后端自动分段续写并拼接；每段吸附到合法帧网格
      duration: durClamped,
      requestedDuration: durClamped,
      snappedDuration: snapped.seconds,
      audioFlowShift: num(req.body.audio_flow_shift, 3.0),
      files: files.filter((f) => f.path).map((f) => ({ field: f.field, filename: f.filename, path: f.path, mimetype: f.mimetype })),
      jsonRefs: files.filter((f) => f.inline).map((f) => ({ field: f.field, value: f.inline })),
    };

    const jobId = createJob(req.user.id, { mode, prompt, params });
    log.info(
      `提交任务 ${jobId.slice(0, 8)} user=${req.user.email} mode=${mode} ` +
      `${size.width}x${size.height} ${segClampedLabel(durClamped)} ` +
      `时长=${durClamped}s 分段=${segmentCount} 参考文件=${params.files.length + params.jsonRefs.length}`,
    );
    enqueue(jobId);
    res.json({
      ok: true,
      jobId,
      // 反馈给前端：尺寸/时长若被规整，明确告知（不静默）
      adjusted: {
        sizeChanged: size.changed,
        width: size.width,
        height: size.height,
        aspectRatio: params.aspectRatio,
        duration: durClamped,
        requestedDuration: rawDuration,
        maxDurationSec: cap,
        durationCapped,
        // 单段：直接给吸附后的帧/秒；多段：给分段数与每段帧/秒（均匀分配，通常各段相同）
        segments: segmentCount,
        segmentSeconds: segGrid.map((g) => g.seconds),
        segmentFrames: segGrid.map((g) => g.frames),
        totalDuration: segGrid.reduce((a, g) => a + g.seconds, 0),
        snappedSeconds: snapped.seconds,
        snappedFrames: snapped.frames,
        durationSnapped: segmentCount === 1 && Math.abs(snapped.seconds - durClamped) > 0.001,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs', authMiddleware, (req, res) => res.json({ jobs: listJobs(req.user.id) }));
app.get('/api/stats', authMiddleware, (req, res) => res.json({ stats: statsForUser(req.user.id) }));
app.get('/api/jobs/:id', authMiddleware, (req, res) => {
  const job = getJob(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json({ job });
});
app.get('/api/jobs/:id/video', authMiddleware, (req, res) => {
  const job = getJob(req.params.id, req.user.id);
  if (!job || !job.videoUrl) return res.status(404).json({ error: '视频未就绪' });
  res.sendFile(path.join(config.outputsDir, `${job.id}.mp4`));
});
app.get('/api/jobs/:id/download', authMiddleware, (req, res) => {
  const job = getJob(req.params.id, req.user.id);
  if (!job || !job.videoUrl) return res.status(404).json({ error: '视频未就绪' });
  res.download(path.join(config.outputsDir, `${job.id}.mp4`), `h3-${job.id.slice(0, 8)}.mp4`);
});
app.post('/api/jobs/:id/regenerate', authMiddleware, (req, res) => {
  const r = regenerateJob(req.params.id, req.user.id);
  if (r.ok) return res.json({ ok: true });
  if (r.reason === 'not_found') return res.status(404).json({ error: '任务不存在' });
  if (r.reason === 'busy') return res.status(409).json({ error: '任务正在排队或生成中' });
  if (r.reason === 'files_missing') {
    return res.status(409).json({ error: '参考文件已不在，请重新上传后再提交' });
  }
  res.status(400).json({ error: '无法重新生成' });
});

app.delete('/api/jobs/:id', authMiddleware, (req, res) => {
  const ok = deleteJob(req.params.id, req.user.id);
  res.json({ ok });
});

// ---------- meta ----------
// 公开：只回一个 ok，不泄露任何后端地址/配置
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// 公开：前端渲染所需的非敏感限制值（提示词/文件大小等）
app.get('/api/config', (_req, res) => {
  res.json({
    limits: {
      promptChars: config.limits.promptChars,
      maxImageMB: config.limits.maxImageMB,
      maxVideoMB: config.limits.maxVideoMB,
      maxFiles: config.limits.maxFiles,
      maxDurationSec: config.limits.maxDurationSec,
      maxRefVideoSec: config.limits.maxRefVideoSec,
      creditsMode: config.creditsMode,
      creditsPerSecond: config.creditsPerSecond,
      creditsPerJob: config.creditsPerJob,
    },
    // 分辨率预设（按画幅比例）、帧网格、对齐粒度 —— 供前端联动与提示
    aspectPresets: presetsForClient(),
    frameGrid: gridInfo(),
    align: ALIGN,
  });
});

// 公开：R2V 标签清单与六段式模板（非敏感，供前端展示/填充）
app.get('/api/prompt/ref2va', (req, res) => {
  // 查询参数 simple：items=image,video,image 之类（逗号分隔的类型序列）
  const items = String(req.query.items || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((t) => ({ mimetype: t.startsWith('video') ? 'video/mp4' : t.startsWith('audio') ? 'audio/mpeg' : 'image/png' }));
  res.json({ tags: ref2vaTagList(items), template: REF2VA_TEMPLATE });
});

// 详情：需登录，含 H3/SMTP 状态（供管理员排查）
app.get('/api/health/detail', authMiddleware, async (_req, res) => {
  const targets = [
    { label: '默认后端(t2va/fl2va)', url: config.h3.baseUrl },
  ];
  if (config.h3.ref2vaBaseUrl) {
    targets.push({ label: 'ref2va 后端', url: config.h3.ref2vaBaseUrl });
  }
  const [mail, ...h3Results] = await Promise.all([
    verifyMailer(),
    ...targets.map((t) => health(t.url)),
  ]);
  const h3 = targets.map((t, i) => ({ ...t, ...h3Results[i] }));
  res.json({
    ok: true,
    deployment: config.deployment,
    skipEmailVerification: config.skipEmailVerification,
    h3BaseUrl: config.h3.baseUrl,
    h3Ref2vaBaseUrl: config.h3.ref2vaBaseUrl || null,
    h3,
    smtp: { host: config.smtp.host, port: config.smtp.port, ok: mail.ok, error: mail.error },
  });
});

app.use(express.static(path.join(config.root, 'public'), {
  // HTML 不缓存：避免浏览器用旧版页面（旧版表单会原生 GET 提交，把密码带进 URL）
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

app.use((err, _req, res, _next) => {
  log.error('请求处理失败：', err?.message || err);
  res.status(400).json({ error: err.message || '请求失败' });
});

/** 任务提交日志用：单段显示「单段」，多段显示「N 段」。 */
function segClampedLabel(totalSec) {
  const n = planSegments(totalSec).length;
  return n > 1 ? `${n} 段` : '单段';
}

const server = app.listen(config.port, () => {
  log.info(`🎬 H3 Studio 启动 [${config.deployment}] http://0.0.0.0:${config.port}`);
  log.info(`   H3 后端: ${config.h3.baseUrl}`);
  if (config.h3.ref2vaBaseUrl) log.info(`   ref2va 后端: ${config.h3.ref2vaBaseUrl}`);
  log.info(`   邮箱激活: ${config.skipEmailVerification ? '已关闭（注册即可用）' : '已开启'}`);
  log.info(`   日志级别: ${log.level()}（设 LOG_LEVEL=debug 或 H3_DEBUG=1 看逐段细节）`);
  log.info(`   时区: ${process.env.TZ || '(未设，按容器 UTC)'} 本地时间 ${new Date().toLocaleString()}`);
  log.info(`   时长上限: ${config.limits.maxDurationSec}s 单段硬上限 15s`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

function page(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;background:#0b0d12;color:#e8ecf1;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#151922;border:1px solid #232a36;border-radius:16px;padding:32px 40px;text-align:center;max-width:420px}
h1{font-size:20px;margin:0 0 12px}p{color:#9aa6b5;margin:0 0 20px;line-height:1.6}
a{display:inline-block;background:#5b8cff;color:#fff;text-decoration:none;padding:10px 22px;border-radius:10px}</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p><a href="/">返回首页</a></div></body></html>`;
}
