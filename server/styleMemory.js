/**
 * 项目级「风格记忆」（v2.0 第一步）。
 *
 * 参考创作 Agent 的「项目记忆」：把一套贯穿始终的视觉偏好（画风、配色、光影、
 * 人物/产品外观一致性与禁忌项）一次性写下来，之后每次生成与重写都自动遵循，
 * 用户不必反复复述、也不必反复上传同一张参考图。
 *
 * 存储：per-user 一行（style_memory 表）。生成/重写时以固定前缀注入提示词，
 * 前缀带显式标记，便于去重与排障。
 */

import { db, now } from './db.js';

/** 注入到提示词头部时的标记行（用于去重与识别）。 */
export const STYLE_MARKER = '【全局风格记忆（须全程遵循，不要复述本段文字）】';

export function getStyleMemory(userId) {
  const row = db.prepare('SELECT text, updated_at FROM style_memory WHERE user_id = ?').get(userId);
  return { text: row?.text || '', updatedAt: row?.updated_at || null };
}

/** 写入（覆盖式）。返回规整后的文本。空字符串等价于清空。 */
export function setStyleMemory(userId, text) {
  const t = String(text ?? '').trim();
  db.prepare(
    `INSERT INTO style_memory (user_id, text, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
  ).run(userId, t, now());
  return { text: t, updatedAt: now() };
}

/** 该提示词是否已带风格记忆前缀（避免重复注入）。 */
export function hasStyleMemory(prompt) {
  return String(prompt || '').includes(STYLE_MARKER);
}

/**
 * 把风格记忆以固定前缀拼进提示词。
 * 已带前缀或记忆为空时原样返回（幂等），因此可安全地在生成与重写两处调用。
 */
export function withStyleMemory(prompt, styleText) {
  const style = String(styleText || '').trim();
  const body = String(prompt ?? '');
  if (!style || hasStyleMemory(body)) return body;
  return `${STYLE_MARKER}\n${style}\n\n${body}`;
}
