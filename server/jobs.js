import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, now } from './db.js';
import { generateLongVideo } from './longvideo.js';
import { analyzeVideo } from './qaCheck.js';
import { log } from './log.js';

fs.mkdirSync(config.outputsDir, { recursive: true });

// 逐段重试已在 longvideo.js 内部完成，外层不再整条重跑（避免重复消耗）
const MAX_ATTEMPTS = 1;

export function createJob(userId, { mode, prompt, params }) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO jobs (id, user_id, status, mode, prompt, params_json, created_at, updated_at)
     VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`,
  ).run(id, userId, mode, prompt, JSON.stringify(params || {}), now(), now());
  return id;
}

export function getJob(id, userId) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(id, userId);
  return row ? hydrate(row) : null;
}

export function listJobs(userId, limit = 50) {
  return db
    .prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit)
    .map(hydrate);
}

export function deleteJob(id, userId) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return false;
  if (row.output_file) {
    try { fs.unlinkSync(path.join(config.outputsDir, row.output_file)); } catch {}
  }
  cleanupFiles(safeJson(row.params_json));
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  return true;
}

/**
 * 重新生成：把失败/已完成的任务重置为排队，并重新入队。
 * 参考文件在失败时被保留（见 runJob），因此无需用户重新走一遍上传流程。
 * 若文件已丢失（例如曾被删除或重启后清理），返回 {ok:false, reason:'files_missing'}。
 */
export function regenerateJob(id, userId) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return { ok: false, reason: 'not_found' };
  // 正在排队/生成 -> 默认拒绝；仅当 running 已超时（重启残留 / 请求已死）才允许接管重跑
  if (row.status === 'running' || row.status === 'queued') {
    if (!isStale(row)) return { ok: false, reason: 'busy' };
    log.warn(`接管卡死的任务 ${id.slice(0, 8)}（running 已超时，强制重跑）`);
  }
  const params = safeJson(row.params_json);
  // 参考文件是否仍在
  for (const f of params.files || []) {
    if (f.path && !fs.existsSync(f.path)) return { ok: false, reason: 'files_missing' };
  }
  setStatus(id, 'queued', { error: null, progress: null, started_at: null, finished_at: null, seconds: null, credits: null });
  enqueue(id);
  log.info(`重新生成 ${id.slice(0, 8)}（原状态 ${row.status}）`);
  return { ok: true };
}

/** running 超过「后端请求硬超时 + 宽限」仍未落库 -> 疑似卡死（重启残留 / 请求已死） */
const runStaleMs = () => (config.h3.timeoutMs || 0) + 5 * 60 * 1000;
const isStale = (row) =>
  row.status === 'running' && !!row.started_at && now() - row.started_at > runStaleMs();

function hydrate(row) {
  const queued = row.status === 'queued';
  const created = row.created_at;
  const started = row.started_at || null;
  const finished = row.finished_at || null;
  const endPoint = finished || (row.status === 'running' ? now() : null);
  // 重启后残留的 running 任务会一直显示「生成中」，这里给出疑似卡死标志
  const stale = isStale(row);
  const qpos = queued ? Math.max(1, queue.indexOf(row.id) + 1) : null;
  // 排队预估：单 worker 串行，预计等待 ≈ 前面任务数 × 近期平均生成耗时
  const avg = queued || row.status === 'running' ? recentAvgGenMs() : 0;
  const etaMs = queued && avg ? Math.round(qpos * avg) : null;
  const stats = {
    submittedAt: created,
    startedAt: started,
    finishedAt: finished,
    // 排队等待时长（提交 -> 开始生成）
    waitMs: started ? Math.max(0, started - created) : null,
    // 生成时长（开始 -> 完成）
    genMs: started && endPoint ? Math.max(0, endPoint - started) : null,
    // 总时长（提交 -> 完成）
    totalMs: endPoint ? Math.max(0, endPoint - created) : null,
    // 成片秒数（统计用）
    seconds: row.seconds || null,
    credits: row.credits ?? null,
    // 排队中：预计还要等多久（基于近期平均生成耗时，仅供参考）
    etaMs,
  };
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    prompt: row.prompt,
    params: safeJson(row.params_json),
    error: row.error || null,
    bytes: row.output_bytes || null,
    progress: row.progress || null,
    // 排队位次：1 = 下一个执行
    queuePosition: qpos,
    queueLength: queue.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stale,
    stats,
    videoUrl: row.output_file ? `/api/jobs/${row.id}/video` : null,
    downloadUrl: row.output_file ? `/api/jobs/${row.id}/download` : null,
  };
}

// 近期已完成任务的全局平均生成耗时（单 worker 串行，队列对所有用户共享），
// 用于给排队任务估算等待时间。取最近 20 条，避免旧值拖偏。
let avgCache = { at: 0, ms: 0 };
function recentAvgGenMs() {
  if (now() - avgCache.at < 30000) return avgCache.ms;
  const r = db.prepare(
    `SELECT AVG(finished_at - started_at) AS v FROM (
       SELECT finished_at, started_at FROM jobs
       WHERE status='done' AND started_at IS NOT NULL AND finished_at IS NOT NULL
       ORDER BY finished_at DESC LIMIT 20
     )`,
  ).get();
  avgCache = { at: now(), ms: Math.max(0, Math.round(r?.v || 0)) };
  return avgCache.ms;
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

function setStatus(id, status, patch = {}) {
  const cols = ['status = ?', 'updated_at = ?'];
  const vals = [status, now()];
  for (const [k, v] of Object.entries(patch)) { cols.push(`${k} = ?`); vals.push(v); }
  vals.push(id);
  db.prepare(`UPDATE jobs SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
}

/**
 * 启动自愈（v1.9.4）：worker 队列只存在于进程内存里，重启后不会恢复，
 * 但数据库里的 status='running'/'queued' 会保留下来——结果就是这些任务在前端
 * 永远显示「生成中」，而 GPU 其实空闲（用户白等）。
 * 启动时把这类残留状态收敛为失败，并保留参考文件，让用户点「重新生成」即可重跑。
 * 返回被收敛的任务数。
 */
export function reconcileOnBoot() {
  const leftover = db
    .prepare("SELECT id FROM jobs WHERE status IN ('running','queued')")
    .all();
  if (!leftover.length) return 0;
  const t = now();
  const msg = '服务重启，任务已中断（可点「重新生成」重跑）';
  const upd = db.prepare(
    'UPDATE jobs SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?',
  );
  for (const r of leftover) upd.run('error', msg, t, t, r.id);
  log.warn(
    `启动自愈：${leftover.length} 个任务因服务重启被标记为中断（` +
      `${leftover.map((r) => r.id.slice(0, 8)).join(', ')}）；worker 队列已重建`,
  );
  return leftover.length;
}

// Very small in-process worker: H3 serves one request at a time (max_num_seqs=1),
// so jobs are generated strictly serially.
let running = false;
const queue = [];

export function enqueue(jobId) {
  queue.push(jobId);
  log.info(`任务入队 ${jobId.slice(0, 8)} 队列长度=${queue.length}`);
  pump();
}

function pump() {
  if (running) return;
  const jobId = queue.shift();
  if (!jobId) return;
  running = true;
  log.info(`开始任务 ${jobId.slice(0, 8)}（同时排队 ${queue.length} 个）`);
  runJob(jobId)
    .catch((err) => {
      log.error(`任务异常 ${jobId.slice(0, 8)}：${err.message || err}`);
      setStatus(jobId, 'error', { error: String(err.message || err), finished_at: now() });
    })
    .finally(() => { running = false; pump(); });
}

async function runJob(jobId) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!row) return;
  const params = safeJson(row.params_json);

  setStatus(jobId, 'running', { error: null, started_at: row.started_at || now() });
  const t0 = Date.now();
  log.info(`任务 ${jobId.slice(0, 8)} 开始生成：mode=${row.mode} 提示词 ${row.prompt.length} 字`);

  // Rebuild upload files saved by the route (params.files -> {field, filename, path, mimetype})
  const files = [];
  for (const f of params.files || []) {
    try {
      files.push({
        field: f.field,
        filename: f.filename,
        mimetype: f.mimetype,
        buffer: fs.readFileSync(f.path),
      });
    } catch {}
  }

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { filePath, segments, seconds } = await generateLongVideo({
        prompt: row.prompt,
        mode: row.mode,
        width: params.width,
        height: params.height,
        aspectRatio: params.aspectRatio,
        fps: params.fps,
        steps: params.steps,
        flowShift: params.flowShift,
        seed: params.seed,
        duration: params.duration,
        audioFlowShift: params.audioFlowShift,
        files,
        onProgress: (p) => setStatus(jobId, 'running', { progress: JSON.stringify(p) }),
      });
      // 成片直接落盘到 outputs（避免整片读进内存）
      const fileName = `${jobId}.mp4`;
      const dest = path.join(config.outputsDir, fileName);
      try {
        fs.renameSync(filePath, dest);
      } catch {
        fs.copyFileSync(filePath, dest);
        try { fs.unlinkSync(filePath); } catch {}
      }
      // 出片自检（v1.11.1）：成片落盘后跑一遍轻量质检，结果附在 progress.qa 里。
      // 只提示、不拦截；自检本身失败不影响交付。
      let qa = null;
      if (config.qaEnabled) {
        try {
          qa = await analyzeVideo(dest);
          const warns = (qa.findings || []).filter((f) => f.level === 'warn').length;
          log.info(
            `出片自检 ${jobId.slice(0, 8)}：${(qa.findings || []).length} 条（警告 ${warns}）` +
              (qa.videoSeconds ? ` 视频=${qa.videoSeconds?.toFixed?.(2)}s 音频=${qa.audioSeconds?.toFixed?.(2) ?? '-'}s` : ''),
          );
        } catch (err) {
          log.warn(`出片自检失败（不影响交付）：${err.message}`);
        }
      }

      setStatus(jobId, 'done', {
        output_file: fileName,
        output_bytes: fs.statSync(dest).size,
        progress: JSON.stringify({ stage: 'done', segments, seconds, qa }),
        finished_at: now(),
        seconds,
        credits: chargeFor(jobId, row.user_id, seconds),
      });
      const mb = (fs.statSync(dest).size / 1048576).toFixed(1);
      log.ok(`任务完成 ${jobId.slice(0, 8)} 成片=${seconds}s 分段=${segments} 大小=${mb}MB 耗时=${((Date.now() - t0) / 1000).toFixed(1)}s`);
      cleanupFiles(params);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  // 失败时【不】清理参考文件，以便用户点「重新生成」直接复用；
  // 文件会在删除该任务（deleteJob）时一并清理。
  setStatus(jobId, 'error', { error: String(lastErr?.message || lastErr), finished_at: now() });
  log.error(`任务失败 ${jobId.slice(0, 8)} 耗时=${((Date.now() - t0) / 1000).toFixed(1)}s：${lastErr?.message || lastErr}`);
}

/**
 * 计费：按 config.creditsMode 扣点，并把消耗写回任务。
 *   second：按成片秒数计费，cost = ceil(seconds * creditsPerSecond)
 *   job   ：按条数计费，cost = ceil(creditsPerJob)
 *   off   ：不计费，返回 null
 * 余额不足则扣到 0（允许透支，任务已生成不回收）。返回本次消耗点数。
 */
export function estimateCredits(seconds) {
  const mode = config.creditsMode;
  if (mode === 'second') return Math.ceil((seconds || 0) * config.creditsPerSecond) || null;
  if (mode === 'job') return Math.ceil(config.creditsPerJob) || null;
  return null;
}

function chargeFor(jobId, userId, seconds) {
  const cost = estimateCredits(seconds);
  if (!cost) return null;
  const u = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
  if (!u) return cost;
  const left = Math.max(0, (u.credits || 0) - cost);
  db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(left, userId);
  return cost;
}

/**
 * 统计聚合（当前用户）。
 *   today/range：条数与成片秒数合计、平均耗时、排队等待合计、卡时（生成机时）。
 *   卡时 = Σ genMs；排队总计 = Σ waitMs；总耗时 = Σ totalMs。
 *   credits = Σ 本次消耗点数（rate=0 时全为 0）。
 */
export function statsForUser(userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dayStart = startOfDay.getTime();
  const agg = (whereSql, params) => {
    const r = db.prepare(
      `SELECT
         COUNT(*)                                        AS jobs,
         SUM(CASE WHEN status='done' THEN 1 ELSE 0 END)   AS done,
         SUM(CASE WHEN status='error' THEN 1 ELSE 0 END)  AS failed,
         SUM(COALESCE(seconds,0))                         AS videoSeconds,
         SUM(CASE WHEN status='done' THEN COALESCE(gen_ms,0) ELSE 0 END)   AS genMs,
         SUM(CASE WHEN status='done' THEN COALESCE(wait_ms,0) ELSE 0 END)  AS waitMs,
         SUM(CASE WHEN status='done' THEN COALESCE(total_ms,0) ELSE 0 END) AS totalMs,
         SUM(COALESCE(credits,0))                         AS credits
       FROM (
         SELECT status, seconds, credits,
                CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL THEN finished_at - started_at ELSE 0 END AS gen_ms,
                CASE WHEN started_at IS NOT NULL THEN started_at - created_at ELSE 0 END AS wait_ms,
                CASE WHEN finished_at IS NOT NULL THEN finished_at - created_at ELSE 0 END AS total_ms
         FROM jobs WHERE user_id = ? ${whereSql}
       )`,
    ).get(...params);
    return {
      jobs: r.jobs || 0,
      done: r.done || 0,
      failed: r.failed || 0,
      videoSeconds: round1(r.videoSeconds || 0),
      genMinutes: round1((r.genMs || 0) / 60000),
      waitMinutes: round1((r.waitMs || 0) / 60000),
      totalMinutes: round1((r.totalMs || 0) / 60000),
      credits: r.credits || 0,
    };
  };
  return {
    creditsMode: config.creditsMode,
    creditsPerSecond: config.creditsPerSecond,
    creditsPerJob: config.creditsPerJob,
    today: agg('AND created_at >= ?', [userId, dayStart]),
    all: agg('', [userId]),
  };
}

const round1 = (v) => Math.round(v * 10) / 10;

function cleanupFiles(params) {
  for (const f of params.files || []) { try { fs.unlinkSync(f.path); } catch {} }
}
