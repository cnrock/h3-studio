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
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at DESC);
`);

export const now = () => Date.now();
