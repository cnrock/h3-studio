import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { verifyMailer, sendMail } from './mail.js';
import { health as h3Health } from './h3.js';
import {
  checkPassword, createUser, findUserByEmail, findUserById, publicUser,
  resetPassword, setResetToken, signToken, verifyByToken, authMiddleware,
} from './auth.js';
import { createJob, deleteJob, enqueue, getJob, listJobs } from './jobs.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const uploadsDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));
// tiny cookie parser (avoids an extra dependency)
app.use((req, _res, next) => {
  req.cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  next();
});

const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 30 * 24 * 3600 * 1000 };

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
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (findUserByEmail(email)) return res.status(409).json({ error: '该邮箱已注册' });

    const { id, verifyToken } = await createUser(email, password);
    const user = findUserById(id);

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

app.get('/api/auth/verify', (req, res) => {
  const token = String(req.query.token || '');
  const user = token ? verifyByToken(token) : null;
  if (!user) return res.status(400).send(page('激活失败', '链接无效或已使用。'));
  const jwtToken = signToken(user);
  res.cookie(config.cookieName, jwtToken, COOKIE_OPTS);
  res.send(page('激活成功', '你的账号已激活，可以关闭本页并使用网站了。'));
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = email && findUserByEmail(email);
  if (!user || !(await checkPassword(password || '', user.password_hash))) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  if (!user.verified) return res.status(403).json({ error: '账号未激活，请先到邮箱点击激活链接' });
  const token = signToken(user);
  res.cookie(config.cookieName, token, COOKIE_OPTS);
  res.json({ ok: true, token, user: publicUser(user) });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(config.cookieName);
  res.json({ ok: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/auth/forgot', async (req, res) => {
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
    const files = (req.files || []).map((f) => ({
      field: mode === 'fl2va' ? 'input_reference' : 'input_reference',
      filename: f.originalname,
      path: f.path,
      mimetype: f.mimetype,
    }));

    // Image/video reference JSON payloads (mutually exclusive with input_reference uploads
    // when the model requires it — we keep uploads for binary files and JSON for URLs).
    if (req.body.image_reference) files.push({ field: 'image_reference', filename: 'image_reference', path: null, mimetype: 'application/json', inline: String(req.body.image_reference) });
    if (req.body.video_reference) files.push({ field: 'video_reference', filename: 'video_reference', path: null, mimetype: 'application/json', inline: String(req.body.video_reference) });

    const params = {
      width: num(req.body.width, 1344),
      height: num(req.body.height, 768),
      aspectRatio: req.body.aspect_ratio || '16:9',
      fps: num(req.body.fps, 24),
      steps: num(req.body.num_inference_steps, 50),
      flowShift: num(req.body.flow_shift, 12),
      seed: req.body.seed === '' || req.body.seed === undefined ? undefined : Number(req.body.seed),
      duration: num(req.body.duration, 5),
      audioFlowShift: num(req.body.audio_flow_shift, 3.0),
      files: files.filter((f) => f.path).map((f) => ({ field: f.field, filename: f.filename, path: f.path, mimetype: f.mimetype })),
      jsonRefs: files.filter((f) => f.inline).map((f) => ({ field: f.field, value: f.inline })),
    };

    const jobId = createJob(req.user.id, { mode, prompt, params });
    enqueue(jobId);
    res.json({ ok: true, jobId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs', authMiddleware, (req, res) => res.json({ jobs: listJobs(req.user.id) }));
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
app.delete('/api/jobs/:id', authMiddleware, (req, res) => {
  const ok = deleteJob(req.params.id, req.user.id);
  res.json({ ok });
});

// ---------- meta ----------
app.get('/api/health', async (_req, res) => {
  const [mail, h3] = await Promise.all([verifyMailer(), h3Health()]);
  res.json({
    ok: true,
    deployment: config.deployment,
    skipEmailVerification: config.skipEmailVerification,
    h3BaseUrl: config.h3.baseUrl,
    h3,
    smtp: { host: config.smtp.host, port: config.smtp.port, ok: mail.ok, error: mail.error },
  });
});

app.use(express.static(path.join(config.root, 'public')));

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || '请求失败' });
});

const server = app.listen(config.port, () => {
  console.log(`\n🎬 H3 Studio [${config.deployment}] http://0.0.0.0:${config.port}`);
  console.log(`   H3 后端: ${config.h3.baseUrl}`);
  console.log(`   邮箱激活: ${config.skipEmailVerification ? '已关闭（注册即可用）' : '已开启'}\n`);
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
