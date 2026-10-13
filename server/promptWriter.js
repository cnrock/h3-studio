/**
 * 提示词 AI 助手（v1.9）：把一句想法重写成 H3 可读的工业级提示词，或为参考素材生成文字描述。
 *
 * 与 promptCheck.js 共用同一套规范：重写器产出的结果，应当能通过自检。
 * 规范来源：MiniMax-H3 官方 Writing Guide（经 pytraveler/MiniMax-H3-Prompt-Rewriter-ComfyUI 工程化）。
 */

import { gridDuration } from './frameGrid.js';

/** 三种模式的写作规范摘要（拼进 system prompt） */
const MODE_GUIDE = {
  t2va: `任务类型：T2VA（纯文生音视频）。
提示词直接输出三段式字段，用空行分隔、字段名加英文冒号：
integrated_multimodal_description: 综合多模态视听流。以 [Shot 1] 起头（不带切点时间），
  镜头按 [Shot 2]、[Shot 3] 顺序编号，每个后续镜头以 "At MM:SS.mmm," 开头；
  写清摄影机运动（Pan/Tilt/Dolly In/Handheld…）、景别、主体微动作、光线与转场。
  对白写成 <d>[Chinese] 台词原文</d>，成对出现；偶发物理音效（脚步、碰撞）写成简短英文描述。
overall_soundscape: 环境音场——空间混响与持续物理底噪（雨打铁皮、远处车流、空调运转）。
non_diegetic_music: 画外配乐——风格、乐器编曲、情绪走向、调性、节拍。无配乐时写 "none"。
禁止出现任何参考标签（<Picture N>/<Video N>）。`,
  fl2va: `任务类型：FL2VA（首帧/尾帧驱动）。正文自动带一行官方对齐指令（服务端会注入，你不必写）。
提示词输出三段式字段：integrated_multimodal_description（以 [Shot 1] 起头，描述首帧→目标运动的演变）、
overall_soundscape、non_diegetic_music。
参考帧用 <Picture 1>（首帧）、<Picture 2>（尾帧）指名，只可引用 <Picture N>，不得引用 Video/Audio。
对白写成 <d>[Language] 台词</d>。`,
  ref2va: `任务类型：Ref2VA（参考素材驱动）。必须输出六段式，字段名加英文冒号：
subject_definitions: 给每个参考标签定义特征，如 <Subject 1> 是一名穿深色风衣的中年男性，<Picture 2> 是暖色调夜景街道。
summary: [Reference generation] 一句话概括任务。
retention_analysis: 逐标签声明保留程度（<Subject 1> 保留面部与服装；<Picture 2> 仅保留场景构图与色调）。
detailed_description: 主体描述，350–500 英文词，写清动作、镜头运动、光线与节奏；以 [Shot 1] 起头，后续镜头带 "At MM:SS.mmm" 切点。
overall_soundscape: 环境音场。
non_diegetic_music: 画外配乐；无则 "none"。
每个 <Subject N> 都必须在 retention_analysis 里有一行交代。`,
};

/** 构造重写用的 system prompt */
function buildRewriteSystem({ mode, duration, durationNote, refs = [] }) {
  const guide = MODE_GUIDE[mode] || MODE_GUIDE.t2va;
  const refLine = refs.length
    ? `\n可用的参考素材标签（必须全部被引用）：${refs.map((r) => `${r.tag}（${r.type}）`).join('、')}`
    : '';
  return `你是 MiniMax H3 音视频生成模型的分镜师与提示词工程师。H3 的文本编码器没有生成能力，
只能把文字压成特征向量；因此提示词必须严格解耦成独立字段，否则三类特征会在隐空间互相干涉，
导致镜头乱切、音画打架。

${guide}${refLine}

硬性约束：
- 目标时长 ${duration} 秒（已吸附到 H3 合法帧网格：${durationNote}）。所有镜头切点时间戳必须落在该时长内，且严格递增。
- 切点时间用 "At MM:SS.mmm" 三位小数毫秒格式，精确到目标时长的帧时序。
- 只输出提示词正文，不要任何解释、前言、Markdown 代码块或标题。
- 语言：镜头描述用英文（H3 对英文指令遵循更好），对白台词保留原始语种。
- 不要写负面提示词字段。`;
}

/** 构造用户消息 */
function buildUserMessage(prompt) {
  return `请把下面这段描述重写为合规的 H3 提示词。保留创意，但补齐镜头结构、运动、光线与三/六段式字段。\n\n原文：\n${prompt}`;
}

/**
 * 把一句想法重写为结构化 H3 提示词。
 * @param {object} o
 * @param {string} o.prompt
 * @param {string} o.mode
 * @param {number} o.duration
 * @param {Array<{tag:string,type:string}>} [o.refs]
 * @param {(args:object)=>Promise<{text:string}>} o.chat  注入的 LLM 调用（便于测试）
 */
export async function rewritePrompt({ prompt, mode = 't2va', duration = 5, refs = [], chat }) {
  const g = gridDuration(duration);
  const durationNote = `${g.frames} 帧 · ${g.seconds.toFixed(2)}s`;
  const messages = [
    { role: 'system', content: buildRewriteSystem({ mode, duration: g.seconds.toFixed(2), durationNote, refs }) },
    { role: 'user', content: buildUserMessage(String(prompt || '').trim()) },
  ];
  const { text, model, usage } = await chat({ messages, temperature: 0.6 });
  return { text: stripFences(text), model, usage, duration: g };
}

/** 参考素材识图描述：把图片转成结构化文字，供后续重写使用 */
export async function captionReferences({ files = [], mode = 'ref2va', chat, visionChat }) {
  const images = files.filter((f) => /^image\//.test(f.mimetype || '')).slice(0, 6);
  const others = files.filter((f) => !/^image\//.test(f.mimetype || ''));
  const lines = [];

  if (images.length) {
    const content = [
      {
        type: 'text',
        text:
          '请为这些参考素材逐张写一句便于提示词写作的描述：主体/人物（外貌、服装）、场景、色调与光线、' +
          '构图与景别。按上传顺序编号，每张一行，格式「<Picture N>：…」。只输出这些行。',
      },
      ...images.map((f) => ({ type: 'image_url', image_url: { url: f.dataUri } })),
    ];
    const { text } = await visionChat({ messages: [{ role: 'user', content }], temperature: 0.4 });
    lines.push(text);
  }
  for (const f of others) {
    const kind = /^video\//.test(f.mimetype || '') ? '视频' : '音频';
    lines.push(`${f.tag}（${kind}）：用户上传的参考${kind}，请在提示词里按用途引用。`);
  }
  return { text: stripFences(lines.join('\n')).trim() };
}

/** 去掉模型可能套上的 ``` 代码围栏 */
function stripFences(s) {
  let t = String(s || '').trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '');
  }
  return t.trim();
}
