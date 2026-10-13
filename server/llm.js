/**
 * 极简 OpenAI 兼容客户端（v1.9）：只用于「提示词重写/扩写」与「参考素材识图描述」。
 *
 * 不引入 SDK，减少依赖；不落任何明文密钥（密钥只从 process.env 读入，出站请求带
 * Authorization 头）。未配置时各调用直接抛错，路由层据此返回 501。
 *
 * 端点可以是本地 vLLM、网关、或云端任何 OpenAI 兼容服务：
 *   LLM_BASE_URL   例 https://onrouter.cn/v1
 *   LLM_API_KEY    例 sk-...
 *   LLM_TEXT_MODEL 例 customonrouter/gpt-6-sol
 *   LLM_VISION_MODEL 例 customonrouter/grok-4.7
 */

import fs from 'node:fs';
import { config } from './config.js';

export function llmConfigured() {
  return Boolean(config.llm.baseUrl && config.llm.textModel);
}
export function visionConfigured() {
  return Boolean(config.llm.baseUrl && config.llm.visionModel);
}

/** 把本地文件转成 data URI（超过 maxBytes 直接抛错，避免请求体过大） */
export function fileToDataUri(filePath, mimetype) {
  const st = fs.statSync(filePath);
  if (st.size > config.llm.maxImageBytes) {
    throw new Error(`图片过大（${(st.size / 1048576).toFixed(1)}MB），上限 ${(config.llm.maxImageBytes / 1048576).toFixed(0)}MB`);
  }
  const b64 = fs.readFileSync(filePath).toString('base64');
  const mt = mimetype || 'image/jpeg';
  return `data:${mt};base64,${b64}`;
}

/**
 * 调一次 chat/completions，返回首个 choice 的文本。
 * @param {object} o
 * @param {Array} o.messages
 * @param {string} [o.model]
 * @param {number} [o.timeoutMs]
 * @param {number} [o.temperature]
 */
export async function llmChat({ messages, model, timeoutMs, temperature = 0.6 }) {
  if (!config.llm.baseUrl) throw new Error('未配置 LLM_BASE_URL');
  const useModel = model || config.llm.textModel;
  if (!useModel) throw new Error('未配置 LLM_TEXT_MODEL');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || config.llm.timeoutMs);
  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.llm.apiKey ? { Authorization: `Bearer ${config.llm.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: useModel, messages, temperature, stream: false }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // 不回显请求头；只截取一小段响应体便于排查
      throw new Error(`LLM 返回 ${res.status}：${text.slice(0, 300)}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`LLM 返回非 JSON：${text.slice(0, 300)}`);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('LLM 未返回文本内容');
    return { text: content.trim(), model: useModel, usage: data?.usage || null };
  } finally {
    clearTimeout(timer);
  }
}
