import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { db, now } from './db.js';

export const hashPassword = (pw) => bcrypt.hash(pw, 10);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);
export const randomToken = () => crypto.randomBytes(32).toString('hex');

export function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

export async function createUser(email, password) {
  const hash = await hashPassword(password);
  const verified = config.skipEmailVerification ? 1 : 0;
  const verifyToken = verified ? null : randomToken();
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, created_at, verified, verify_token, credits)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(email.toLowerCase().trim(), hash, now(), verified, verifyToken, 50);
  return { id: Number(info.lastInsertRowid), verifyToken };
}

export function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
}

export function findUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function verifyByToken(token) {
  const u = db.prepare('SELECT * FROM users WHERE verify_token = ?').get(token);
  if (!u) return null;
  db.prepare('UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?').run(u.id);
  return u;
}

export function setResetToken(email) {
  const u = findUserByEmail(email);
  if (!u) return null;
  const token = randomToken();
  db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?').run(
    token,
    now() + 60 * 60 * 1000,
    u.id,
  );
  return { user: u, token };
}

export async function resetPassword(token, newPassword) {
  const u = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(token);
  if (!u || !u.reset_expires || u.reset_expires < now()) return null;
  const hash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?').run(
    hash,
    u.id,
  );
  return u;
}

// ---- express helpers ----
export function authMiddleware(req, res, next) {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const token = req.cookies?.[config.cookieName] || bearer;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: '未登录或登录已过期' });
  const user = findUserById(payload.uid);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  req.user = user;
  next();
}

export function publicUser(u) {
  return { id: u.id, email: u.email, verified: !!u.verified, credits: u.credits, createdAt: u.created_at };
}
