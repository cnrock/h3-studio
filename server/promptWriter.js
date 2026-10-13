/**
 * 提示词 AI 助手（v1.9 / v1.9.2）：把一句想法重写成 H3 可读的工业级提示词，或为参考素材生成文字描述。
 *
 * 与 promptCheck.js 共用同一套规范：重写器产出的结果，应当能通过自检。
 * 规范来源：MiniMax-H3 官方 Writing Guide（经 pytraveler/MiniMax-H3-Prompt-Rewriter-ComfyUI 工程化）。
 *
 * v1.9.2 修复：目标时长超过 H3 单段上限（15 秒）时，旧实现直接把整段时长交给
 * gridDuration()，被夹到 362 帧 / 15.08s，于是「不管多长都重写成 5.17s / 124 帧」。
 * 现在：
 *   - T2VA + 长时长 -> 输出「分镜脚本」，与 longvideo.js 的 parseStoryboard/分段对齐（服务端自动分段续写）。
 *   - FL2VA/Ref2VA + 长时长 -> 单段硬上限 15 秒，按 15 秒重写并明确告知（这两种模式不支持自动分段）。
 */

import { gridDuration } from './frameGrid.js';
import { H3_MAX_SECONDS, planSegments } from './longvideo.js';

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

/** 把秒数写成 M:SS（不足一分钟为 0:SS），与 longvideo.js 的时间轴一致 */
const fmtClock = (sec) => {
  const s = Math.max(0, Math.round(Number(sec)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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

/**
 * 长视频（T2VA）专用：要求 LLM 输出「分镜脚本」。
 * 该格式由 longvideo.js 的 parseStoryboard 解析：按 ≤15 秒把相邻镜头聚成生成段，
 * 每段只喂自己的剧本，因此总时长不再受单段 15 秒限制。
 */
function buildStoryboardSystem({ duration, refs = [] }) {
  const totalSec = Math.max(H3_MAX_SECONDS + 1, Math.round(Number(duration) || 0));
  const segGrid = planSegments(totalSec).map((s) => gridDuration(s));
  // 段边界严格按「每段吸附后的真实秒数」累加——与后端逐段生成的实际时间轴一致。
  const bounds = [0];
  for (const g of segGrid) bounds.push(bounds[bounds.length - 1] + g.seconds);
  const timelineTotal = bounds[bounds.length - 1];
  const planLines = segGrid.map(
    (g, i) => `  第 ${i + 1} 段：${fmtClock(bounds[i])}–${fmtClock(bounds[i + 1])}（${g.seconds.toFixed(2)} 秒，${g.frames} 帧）`,
  );
  const refLine = refs.length
    ? `\n- 参考素材标签（若引用须逐一点名并与上传顺序一致）：${refs.map((r) => `${r.tag}（${r.type}）`).join('、')}`
    : '';
  return `你是 MiniMax H3 音视频生成模型的分镜师与提示词工程师。H3 的文本编码器没有生成能力，只把文字压成特征向量；
提示词必须严格解耦成独立字段，否则镜头/环境音/配乐三类特征会在隐空间互相干涉，导致镜头乱切、音画打架。

【本次任务：分镜脚本（总时长超过单段上限）】
目标总时长 ${totalSec} 秒，远超 H3 单次生成硬上限 ${H3_MAX_SECONDS} 秒。服务端会把带「镜头…时间轴」的提示词
识别为分镜脚本，按 ≤${H3_MAX_SECONDS} 秒自动聚段、逐段续写并拼接成完整视频；时间轴既是分段依据，也是音画对齐依据，
必须与总时长严格一致。

输出格式（严格遵守；不要 Markdown 代码块、不要标题、不要任何解释）：
1. 先写「总设定」，每行一条、用「- 」起头：各主体/人物的外貌、服装、道具；整体画风与配色；
   全程一致性与其它硬性要求（例如人物长相/服装全程不变）。总设定里不要出现任何时间码。
2. 空一行，单独写一行：### 分镜时间轴
3. 空一行，再逐镜头写。每个镜头一段，首行严格形如：
   镜头 1｜0:00–0:04｜4 秒｜标题
   其后每行是该镜头正文。
   - 镜头编号从 1 起连续。
   - 左端时间 = 上一镜头的右端时间（首个镜头从 0:00 起）；右端时间 = 左端时间 + 镜头秒数。
   - 「N 秒」与时间轴（右端−左端）必须一致；镜头秒数取整数，最小 4、最大 ${H3_MAX_SECONDS}。
   - 时间轴严格递增、连续、不重叠；最后一个镜头的右端时间必须恰好等于时间轴总长 ${fmtClock(timelineTotal)}（即 ${timelineTotal.toFixed(2)} 秒）。
   - 「标题」用中文，简短概括该镜头。
4. 镜头正文用英文，写清：主体动作、镜头运动（Pan/Tilt/Dolly In/Handheld…）、景别、光线与转场；
   对白写成 <d>[Chinese] 台词原文</d> 且成对出现；偶发物理音效写简短英文描述。
5. 对白要分散到各镜头，不要把台词全堆在开头。

【分段计划（服务端会依时间轴自动分段；请让每段累计时长贴近下列区间，任何一段都不得超过 ${H3_MAX_SECONDS} 秒）】
共 ${segGrid.length} 段：
${planLines.join('\n')}${refLine}

硬性约束：
- 只输出分镜脚本正文，不要任何解释、前言或 Markdown 代码块。
- 总设定与标题用中文，镜头正文用英文，对白保留原始语种并加 [语言] 标签。
- 不要写负面提示词字段，不要写参考标签（除非上传了参考素材且必须引用）。`;
}

/** 长时长但当前模式不支持自动分段时的提示（附加在正文前，前端会单独展示） */
function edgeNote({ mode, requested, g }) {
  const name = { fl2va: '首尾帧（FL2VA）', ref2va: '参考素材（Ref2VA）' }[mode] || mode;
  return (
    `${name} 单个任务硬上限为 ${H3_MAX_SECONDS} 秒，不支持自动分段续写；` +
    `已按 ${H3_MAX_SECONDS} 秒（${g.frames} 帧 · ${g.seconds.toFixed(2)}s）重写为单段。` +
    `如需更长视频，请改用「文生视频（T2VA）」并保留带「镜头…时间轴」的分镜脚本格式。`
  );
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
 * @param {number} o.duration   目标总时长（秒，未吸附的用户值）
 * @param {Array<{tag:string,type:string}>} [o.refs]
 * @param {(args:object)=>Promise<{text:string}>} o.chat  注入的 LLM 调用（便于测试）
 */
export async function rewritePrompt({ prompt, mode = 't2va', duration = 5, refs = [], chat }) {
  const requested = Math.max(4, Number(duration) || 0);
  const totalGrid = gridDuration(requested);
  // 是否需要分段：沿用与生成路径同一套 planSegments 判定（>15s 才会 >1 段）
  const needsLong = planSegments(requested).length > 1;

  // —— 长时长：T2VA -> 分镜脚本；其它模式 -> 单段 15s + 明确告知 ——
  if (needsLong && mode === 't2va') {
    const messages = [
      { role: 'system', content: buildStoryboardSystem({ duration: requested, refs }) },
      { role: 'user', content: buildUserMessage(String(prompt || '').trim()) },
    ];
    const { text, model, usage } = await chat({ messages, temperature: 0.5 });
    return {
      text: stripFences(text),
      model,
      usage,
      storyboard: true,
      duration: totalGrid,
      note: `已按 ${requested} 秒改写为分镜脚本：服务端会按 ≤${H3_MAX_SECONDS} 秒自动分段续写并拼接（约 ${planSegments(requested).length} 段）。时间轴即分段依据，请勿改动格式。`,
    };
  }
  if (needsLong) {
    const g = gridDuration(H3_MAX_SECONDS);
    const messages = [
      { role: 'system', content: buildRewriteSystem({ mode, duration: g.seconds.toFixed(2), durationNote: `${g.frames} 帧 · ${g.seconds.toFixed(2)}s`, refs }) },
      { role: 'user', content: buildUserMessage(String(prompt || '').trim()) },
    ];
    const { text, model, usage } = await chat({ messages, temperature: 0.5 });
    return { text: stripFences(text), model, usage, duration: g, note: edgeNote({ mode, requested, g }) };
  }

  // —— 单段：常规重写 ——
  const durationNote = `${totalGrid.frames} 帧 · ${totalGrid.seconds.toFixed(2)}s`;
  const messages = [
    { role: 'system', content: buildRewriteSystem({ mode, duration: totalGrid.seconds.toFixed(2), durationNote, refs }) },
    { role: 'user', content: buildUserMessage(String(prompt || '').trim()) },
  ];
  const { text, model, usage } = await chat({ messages, temperature: 0.6 });
  return { text: stripFences(text), model, usage, duration: totalGrid };
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
