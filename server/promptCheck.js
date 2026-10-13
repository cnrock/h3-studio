/**
 * 提示词自检（Prompt Check）——只检查、不生成、不加载模型，毫秒级返回。
 *
 * 依据 MiniMax-H3 官方写作规范（参考 pytraveler/MiniMax-H3-Prompt-Rewriter-ComfyUI
 * 的 Prompt Check 节点与官方 Writing Guide），对一段提示词做静态体检，产出：
 *   findings: [{ level:'warn'|'note', code, message }]
 *   stats:    统计信息（镜头数、时长、词数、标签数…）
 *
 * 原则：发现只被「说出来」，从不拦截。警告（!）是 H3 很可能读错的东西；
 * 提示（-）是规范仅仅建议的东西。
 */

import { gridDuration } from './frameGrid.js';

/** H3 特效嵌入的官方 10 个名字（大小写敏感，须原样嵌入）。 */
export const OFFICIAL_EFFECTS = [
  'dolly_zoom', 'vertigo', 'bullet_time', 'time_freeze', 'orbit_shot',
  'crane_shot', 'handheld', 'slow_motion', 'whip_pan', 'rack_focus',
];

const shotStartRe = /\[\s*Shot\s+(\d+)\s*\]/gi;
/** At 00:02.378 / at 2.378s / At MM:SS.mmm */
const cutTimeRe = /\bAt\s+(\d{1,2}):(\d{2})\.(\d{2,3})\b/gi;
/** 分镜脚本式时间轴：0:00–0:04 */
const rangeRe = /(\d{1,2}):(\d{2})\s*[–\-—~至到]\s*(\d{1,2}):(\d{2})/;

const isRefTask = (mode) => mode === 'ref2va';
const isFrameTask = (mode) => mode === 'fl2va';

/** 统计时间为「秒」（十进制） */
const secOf = (m) => Number(m[1]) * 60 + Number(m[2]) + Number(m[3].padEnd(3, '0')) / 1000;

/**
 * @param {object} o
 * @param {string} o.prompt    待检查的提示词
 * @param {string} [o.mode]    t2va | fl2va | ref2va
 * @param {number} [o.duration] 目标时长（秒，未吸附的用户值）
 * @param {Array<{mimetype?:string,filename?:string}>} [o.files] 已连接的参考素材
 * @returns {{findings:Array, stats:object}}
 */
export function checkPrompt({ prompt, mode = 't2va', duration = 0, files = [] } = {}) {
  const text = String(prompt ?? '');
  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });
  // 去掉「标签清单」等说明性括号内容，避免误判（保留正文）
  const body = text.replace(/\r/g, '');

  // ---------- 0) 空提示词 ----------
  if (!body.trim()) {
    add('warn', 'empty', '提示词为空。');
    return { findings, stats: emptyStats() };
  }

  const grid = duration ? gridDuration(duration) : null;
  const stats = {
    shots: 0,
    cutTimes: [],
    duration: grid ? grid.seconds : 0,
    frames: grid ? grid.frames : 0,
    words: 0,
    refTags: [],
    effects: [],
    fields: {},
    storyboard: false,
  };

  // ---------- 1) 镜头结构 ----------
  const shotMatches = [...body.matchAll(shotStartRe)];
  stats.shots = shotMatches.length;

  const cutTimes = [...body.matchAll(cutTimeRe)].map((m) => ({ at: m.index, sec: secOf(m) }));
  stats.cutTimes = cutTimes.map((c) => c.sec);

  if (shotMatches.length === 0) {
    add(
      mode === 'ref2va' ? 'note' : 'warn',
      'no_shot1',
      '未发现 [Shot 1] 镜头标记。H3 靠 [Shot N] 读取叙事结构；纯散文提示词会让镜头切分与音轨在隐空间互相干涉。',
    );
  } else {
    // 第一个镜头标记之前不应出现切点时间
    const firstShotAt = shotMatches[0].index;
    const beforeCut = cutTimes.find((c) => c.at < firstShotAt);
    if (beforeCut) {
      add('warn', 'cut_before_shot1', '[Shot 1] 之前出现了 At 切点时间；第一个镜头应直接起描述，不带切点时间。');
    }
    // 编号顺序
    const nums = shotMatches.map((m) => Number(m[1]));
    const expected = nums.map((_, i) => i + 1);
    if (nums.join(',') !== expected.join(',')) {
      add('warn', 'shot_numbering', `镜头编号不是从 1 起连续递增（读到 ${nums.join(', ')}）。`);
    }
    // 切点时间递增且在时长内
    for (let i = 1; i < cutTimes.length; i++) {
      if (cutTimes[i].sec <= cutTimes[i - 1].sec) {
        add('warn', 'cut_not_increasing', `第 ${i} 个 At 切点时间（${cutTimes[i].sec.toFixed(3)}s）没有晚于前一个，H3 可能提前切断或冻结后半段。`);
        break;
      }
    }
    if (grid && cutTimes.length && cutTimes[cutTimes.length - 1].sec > grid.seconds + 0.05) {
      add('warn', 'cut_beyond_duration', `有 At 切点时间超出目标时长（${grid.seconds.toFixed(2)}s），该镜头可能被截断。`);
    }
  }

  // ---------- 2) 时间戳 17n+5 物理网格吸附 ----------
  // 用户手写的分镜时间戳若非 17n+5 对齐，H3 会静默舍入，导致音画错位。
  const ranges = [...body.matchAll(new RegExp(rangeRe.source, 'g'))];
  if (ranges.length) stats.storyboard = true;
  for (const r of ranges) {
    const start = Number(r[1]) * 60 + Number(r[2]);
    const end = Number(r[3]) * 60 + Number(r[4]);
    const dur = end - start;
    if (dur <= 0) continue;
    const g = gridDuration(dur);
    if (Math.abs(g.seconds - dur) > 0.001) {
      add(
        'note',
        'segment_not_snapped',
        `分镜时长「${r[0]}」= ${dur}s 不在 H3 合法帧网格上，将向上吸附到 ${g.frames} 帧 · ${g.seconds.toFixed(2)}s。`,
      );
      break; // 同类只报一条，避免刷屏
    }
  }

  // ---------- 3) 对白标记 ----------
  const openD = (body.match(/<d>/g) || []).length;
  const closeD = (body.match(/<\/d>/g) || []).length;
  if (openD !== closeD) {
    add('warn', 'dialogue_unbalanced', `<d> 与 </d> 不配对（开 ${openD} / 闭 ${closeD}），对白会被解析错位。`);
  }
  // 每个 <d> 块应以 [语言] 开头
  const dBlocks = [...body.matchAll(/<d>([\s\S]*?)<\/d>/g)].map((m) => m[1].trim());
  const missingLang = dBlocks.filter((b) => !/^\[[^\]]+\]/.test(b)).length;
  if (missingLang) {
    add('warn', 'dialogue_language', `有 ${missingLang} 段对白未以 [语言] 标签开头（如 [Chinese]），H3 无法确定朗读语种。`);
  }

  // ---------- 4) 参考素材标签（双向核对） ----------
  const tagRe = /<(Picture|Video|Audio)\s+(\d+)>/gi;
  const usedTags = new Set();
  for (const m of body.matchAll(tagRe)) usedTags.add(`<${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}>`);
  stats.refTags = [...usedTags];

  // 4a) 当前任务扛不住的标签
  if (mode === 't2va' && usedTags.size) {
    add('warn', 'tag_in_t2va', `文生视频（T2VA）不接受任何参考标签，但提示词里出现了 ${[...usedTags].join('、')}，生成器会收到它们却无法使用。`);
  }
  if (mode === 'fl2va') {
    const bad = [...usedTags].filter((t) => /^<(Video|Audio)/i.test(t));
    if (bad.length) add('warn', 'tag_in_fl2va', `首尾帧模式只接受 <Picture N>，但出现了 ${bad.join('、')}。`);
  }
  if (mode === 'ref2va') {
    const vids = [...usedTags].filter((t) => /^<Video/i.test(t));
    if (vids.length > 3) add('warn', 'too_many_video_tags', `引用了 ${vids.length} 个 <Video N>，H3 单次最多接受 3 个参考视频。`);
  }

  // 4b) 接了却从未被引用的素材（生成器照样收到，却对派什么用场没有发言权）
  if (files.length) {
    const attached = files.map((f, i) => {
      const isV = /^video\//.test(f.mimetype || '');
      const isA = /^audio\//.test(f.mimetype || '');
      const name = isV ? 'Video' : isA ? 'Audio' : 'Picture';
      return { order: i + 1, tag: `<${name} ${i + 1}>` };
    });
    const unused = attached.filter((a) => !usedTags.has(a.tag) && !body.includes(a.tag));
    if (unused.length) {
      add(
        'note',
        'reference_unused',
        `已连接但从未被引用的参考素材：${unused.map((u) => u.tag).join('、')}。模型会收到它们，却不知道拿它们做什么——建议在提示词里点名。`,
      );
    }
  }

  // ---------- 5) 六段式/字段账目（ref2va） ----------
  const fieldNames = [
    'subject_definitions', 'summary', 'retention_analysis',
    'detailed_description', 'overall_soundscape', 'non_diegetic_music',
  ];
  const presentFields = fieldNames.filter((f) => new RegExp(`${f}\\s*[:：]`, 'i').test(body));
  stats.fields = Object.fromEntries(fieldNames.map((f) => [f, presentFields.includes(f)]));

  if (mode === 'ref2va') {
    const missing = fieldNames.filter((f) => !presentFields.includes(f));
    if (missing.length) {
      add('warn', 'missing_fields', `缺少 ${missing.length} 个字段：${missing.join('、')}。Ref2VA 需要六段式结构。`);
    }
    // 每个 <Subject N> 都欠 retention_analysis 一行
    const subjects = new Set();
    for (const m of body.matchAll(/<Subject\s+(\d+)>/gi)) subjects.add(`<Subject ${m[1]}>`);
    if (subjects.size) {
      const retSec = (body.match(/retention_analysis\s*[:：]([\s\S]*?)(?:\n\s*\w+\s*[:：]|$)/i) || [])[1] || '';
      const owed = [...subjects].filter((s) => !retSec.includes(s));
      if (owed.length) add('warn', 'retention_missing', `subject_definitions 引入的 ${owed.join('、')} 在 retention_analysis 里没有交代保留程度。`);
    }
  }

  // detailed_description 350–500 英文词
  const ddSec = (body.match(/detailed_description\s*[:：]([\s\S]*?)(?:\n\s*\w+\s*[:：]|$)/i) || [])[1] || '';
  if (ddSec) {
    const w = ddSec.split(/\s+/).filter(Boolean).length;
    stats.words = w;
    if (w < 350 || w > 500) {
      add('note', 'word_count', `detailed_description 有 ${w} 词，规范建议 350–500 词。`);
    }
  }

  // ---------- 6) 对齐行（I2VA / FL2VA / L2VA） ----------
  const hasAlign = /align with the target video/i.test(body) || /is fully referenced/i.test(body);
  if (isFrameTask(mode) && !hasAlign) {
    add('note', 'missing_alignment', '首尾帧模式缺少对齐指令（“...aligns with the ...-second mark of the target video”）。提交时服务端会自动注入，但请确认参考帧顺序与时长。');
  }

  // ---------- 7) 特效嵌入 token ----------
  const embRe = /(\S*?)Embedding:\s*([A-Za-z_][\w]*)\s*\.?/g;
  for (const m of body.matchAll(embRe)) {
    const glued = m[1] !== ''; // 前缀非空 => token 粘在前一个词上
    const trailingDot = /\.\s*$/.test(m[0]);
    if (glued) { add('warn', 'embedding_glued', `特效 token「Embedding:${m[2]}」粘在前一个词上（前面是「${m[1]}」），ComfyUI/H3 可能静默丢弃它。`); break; }
    if (trailingDot) { add('warn', 'embedding_dot', `特效 token「Embedding:${m[2]}」末尾带句号，会被静默丢弃。`); break; }
  }
  for (const m of body.matchAll(/Embedding:\s*([A-Za-z_][\w]*)/g)) {
    stats.effects.push(m[1]);
    if (!OFFICIAL_EFFECTS.includes(m[1])) {
      add('note', 'embedding_unknown', `特效名「${m[1]}」不在官方 10 个之列，若有对应文本反演可忽略。`);
    }
  }

  // ---------- 8) 时长提示 ----------
  if (grid && grid.seconds !== Number(duration)) {
    add('note', 'duration_snapped', `时长 ${duration}s 已吸附到 H3 合法帧网格：${grid.frames} 帧 · ${grid.seconds.toFixed(2)}s。`);
  }

  return { findings, stats };
}

function emptyStats() {
  return { shots: 0, cutTimes: [], duration: 0, frames: 0, words: 0, refTags: [], effects: [], fields: {}, storyboard: false };
}

/** 把 findings 渲染成一行行文本（`!` 警告 / `-` 提示），供前端 <pre> 或日志使用。 */
export function renderFindings(findings = []) {
  return findings.map((f) => `${f.level === 'warn' ? '!' : '-'} ${f.message}`).join('\n');
}
