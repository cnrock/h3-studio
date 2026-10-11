import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, now } from './db.js';
import { generateVideo } from './h3.js';

fs.mkdirSync(config.outputsDir, { recursive: true });

const MAX_ATTEMPTS = 2;

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
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  return true;
}

function hydrate(row) {
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    prompt: row.prompt,
    params: safeJson(row.params_json),
    error: row.error || null,
    bytes: row.output_bytes || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    videoUrl: row.output_file ? `/api/jobs/${row.id}/video` : null,
  };
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

function setStatus(id, status, patch = {}) {
  const cols = ['status = ?', 'updated_at = ?'];
  const vals = [status, now()];
  for (const [k, v] of Object.entries(patch)) { cols.push(`${k} = ?`); vals.push(v); }
  vals.push(id);
  db.prepare(`UPDATE jobs SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
}

// Very small in-process worker: H3 serves one request at a time (max_num_seqs=1),
// so jobs are generated strictly serially.
let running = false;
const queue = [];

export function enqueue(jobId) {
  queue.push(jobId);
  pump();
}

function pump() {
  if (running) return;
  const jobId = queue.shift();
  if (!jobId) return;
  running = true;
  runJob(jobId)
    .catch((err) => setStatus(jobId, 'error', { error: String(err.message || err) }))
    .finally(() => { running = false; pump(); });
}

async function runJob(jobId) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!row) return;
  const params = safeJson(row.params_json);

  setStatus(jobId, 'running', { error: null });

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
      const { bytes } = await generateVideo({
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
      });
      const fileName = `${jobId}.mp4`;
      fs.writeFileSync(path.join(config.outputsDir, fileName), bytes);
      setStatus(jobId, 'done', { output_file: fileName, output_bytes: bytes.length });
      cleanupFiles(params);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  setStatus(jobId, 'error', { error: String(lastErr?.message || lastErr) });
  cleanupFiles(params);
}

function cleanupFiles(params) {
  for (const f of params.files || []) { try { fs.unlinkSync(f.path); } catch {} }
}
