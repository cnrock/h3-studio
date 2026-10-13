import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  verified      INTEGER NOT NULL DEFAULT 0,
  verify_token  TEXT,
  reset_token   TEXT,
  reset_expires INTEGER,
  credits       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  status        TEXT NOT NULL,            -- queued|running|done|error
  mode          TEXT NOT NULL,            -- t2va|fl2va|ref2va
  prompt        TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  output_file   TEXT,
  output_bytes  INTEGER,
  error         TEXT,
  credits       INTEGER,            -- 本次消耗的点数（config.creditsPerSecond>0 时记录）
  created_at    INTEGER NOT NULL,   -- 提交时间（入队）
  started_at    INTEGER,            -- 真正开始生成的时间（排队结束）
  finished_at   INTEGER,            -- 完成/失败时间
  seconds       REAL,               -- 成片实际秒数（用于统计，非单段吸附值）
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at DESC);
`);

// --- lightweight migrations (add columns if missing) ---
const jobCols = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
if (!jobCols.includes('progress')) db.exec('ALTER TABLE jobs ADD COLUMN progress TEXT');
if (!jobCols.includes('started_at')) db.exec('ALTER TABLE jobs ADD COLUMN started_at INTEGER');
if (!jobCols.includes('finished_at')) db.exec('ALTER TABLE jobs ADD COLUMN finished_at INTEGER');
if (!jobCols.includes('seconds')) db.exec('ALTER TABLE jobs ADD COLUMN seconds REAL');
if (!jobCols.includes('credits')) db.exec('ALTER TABLE jobs ADD COLUMN credits INTEGER');

export const now = () => Date.now();
