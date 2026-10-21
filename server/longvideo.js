import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateVideo } from './h3.js';
import { config } from './config.js';
import { log } from './log.js';
import { gridDuration } from './frameGrid.js';
import { injectFl2vaAlignment } from './promptHints.js';

const execFileP = promisify(execFile);

export const H3_MAX_SECONDS = 15;

// 段间交叉溶解（xfade/acrossfade）时长（秒）。
// v1.11.1：此前是硬切拼接，段边界处画面/音频瞬间跳变，视觉上就是「中间卡一下」。
// 用短交叉溶解把两段在边界处短暂叠加，接缝自然消失、听感更连贯；
// 每处溶解会让成片总时长减少 XFADE_SECONDS，这里取 0.25s（占单段 15s 的 ~1.7%，无明显内容损失）。
const XFADE_SECONDS = 0.25;

/** 清理从聊天/文档粘贴来的转义符与 Markdown 加粗标记 */
function cleanText(s) {
  return String(s ?? '')
    .replace(/\\(\-|\*|_|\.|\[|\]|#|>)/g, '$1') // Feishu 转义
    .replace(/\*\*/g, '')
    .trim();
}

/**
 * 解析"分镜脚本"式提示词：识别「镜头 N｜0:00–0:04｜4 秒｜标题」这类时间轴，
 * 把总设定（人物/服装/场景/风格/色调/声音/负面提示）与各镜头拆开。
 *
 * 返回 { header, shots:[{label,start,dur,body}], totalSeconds } 或 null（不是分镜脚本）。
 */
export function parseStoryboard(prompt) {
  const raw = String(prompt ?? '').replace(/\r/g, '');
  const lines = raw.split('\n');

  const timeRe = /(\d{1,2}):(\d{2})\s*[–\-—~至到]\s*(\d{1,2}):(\d{2})/;
  const shotRe = /(?:分镜|镜头|shot)\s*[0-9一二三四五六七八九十]+/i;

  // 镜头块起始行的识别：
  //   1) 「镜头 N｜0:00–0:15」——含镜头标记 + 时间轴（原始格式）
  //   2) 仅有时间轴「0:00–0:15」——放宽支持（很多剧本只写时间轴）
  // 放宽后仍要求 ≥2 个镜头，避免把正文里偶然出现的时间当成分镜。
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const hasTime = timeRe.test(lines[i]);
    const hasShot = shotRe.test(lines[i]);
    if (hasTime && (hasShot || /^\s*[（(]?\d{1,2}:\d{2}/.test(lines[i]))) starts.push(i);
  }
  if (starts.length < 2) return null; // 少于 2 个镜头，不必按分镜拆

  // 总设定：第一个镜头块之前的内容，去掉"分镜时间轴"这类纯标题行
  const header = lines
    .slice(0, starts[0])
    .filter((l) => !/分镜.*(时间轴|列表|脚本)/.test(l) && cleanText(l) !== '')
    .map(cleanText)
    .join('\n')
    .trim();

  // 逐镜头正文
  const shots = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const block = lines.slice(from, to).map(cleanText).filter((l) => l !== '');
    const titleLine = block[0] || '';
    const m = titleLine.match(timeRe);
    let dur = 4;
    if (m) {
      const start = Number(m[1]) * 60 + Number(m[2]);
      const end = Number(m[3]) * 60 + Number(m[4]);
      dur = Math.max(1, end - start);
    }
    // 标题里若自带「N 秒」，优先用秒数
    const secM = titleLine.match(/(\d+(?:\.\d+)?)\s*秒/);
    if (secM) dur = Math.max(1, Math.round(Number(secM[1])));
    shots.push({ label: titleLine, dur, body: block.join('\n') });
  }

  const totalSeconds = shots.reduce((a, s) => a + s.dur, 0);
  return { header, shots, totalSeconds };
}

/** 不按分镜时的普通分段：每段 ∈ [4,15]，均匀分配且不丢时长 */
export function planSegments(totalSeconds, maxTotal = config.limits.maxDurationSec, segmentMax = H3_MAX_SECONDS) {
  const max = Math.max(4, Math.min(Number(segmentMax) || H3_MAX_SECONDS, H3_MAX_SECONDS));
  const total = Math.max(4, Math.min(Number(totalSeconds) || 0, maxTotal));
  const n = Math.max(1, Math.ceil(total / max));
  const base = Math.floor(total / n);
  let remainder = total - base * n;
  const segs = [];
  for (let i = 0; i < n; i++) {
    const extra = remainder > 0 ? 1 : 0;
    if (extra) remainder--;
    segs.push(base + extra);
  }
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i] < 4 && segs.length > 1) {
      const j = i > 0 ? i - 1 : i + 1;
      segs[j] += segs[i];
      segs.splice(i, 1);
    }
  }
  return segs;
}

/** 把相邻镜头按 ≤15 秒聚成若干生成段 */
function groupShots(shots, maxSeconds = H3_MAX_SECONDS) {
  const groups = [];
  let cur = [];
  let curDur = 0;
  for (const s of shots) {
    const d = Math.min(maxSeconds, Math.max(1, s.dur));
    if (cur.length && curDur + d > maxSeconds) {
      groups.push({ shots: cur, dur: curDur });
      cur = [];
      curDur = 0;
    }
    cur.push(s);
    curDur += d;
  }
  if (cur.length) groups.push({ shots: cur, dur: curDur });

  // 保证每段 ≥4 秒（H3 最小 4 秒）：过短的段与相邻段合并，保持顺序
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].dur < 4 && groups.length > 1) {
      const j = i > 0 ? i - 1 : i + 1;
      if (j < i) groups[j].shots = groups[j].shots.concat(groups[i].shots);
      else groups[j].shots = groups[i].shots.concat(groups[j].shots);
      groups[j].dur += groups[i].dur;
      groups.splice(i, 1);
    }
  }
  return groups;
}

/**
 * 固定帧率选项名随 ffmpeg 版本而异：
 *   ffmpeg 4.x    -> 只有 -vsync（无 -fps_mode）
 *   ffmpeg 5~7    -> 两者都有（-vsync 为弃用别名）
 *   ffmpeg 8+/9.x -> -vsync 已移除，只有 -fps_mode
 * 写死任一个都会在某些版本上报 “Unrecognized option”。启动时探测一次并缓存。
 */
let fpsFlagCache;
async function fpsArgs() {
  if (fpsFlagCache === undefined) {
    try {
      const { stdout } = await execFileP('ffmpeg', ['-hide_banner', '-h', 'full'], {
        maxBuffer: 16 * 1024 * 1024,
      });
      const help = String(stdout);
      if (/\bfps_mode\b/.test(help)) fpsFlagCache = 'fps_mode';
      else if (/\bvsync\b/.test(help)) fpsFlagCache = 'vsync';
      else fpsFlagCache = '';
    } catch {
      fpsFlagCache = '';
    }
  }
  return fpsFlagCache ? [`-${fpsFlagCache}`, 'cfr'] : [];
}

/**
 * H3 对 ref2va 参考视频有硬校验：每个参考视频时长必须 ∈ [2,15] 秒，且所有参考视频
 * 总时长 ≤15 秒；超出会被直接拒绝（500，例如
 * "reference video 0 duration must be in [2, 15] seconds, got 157.500"）。
 * 提交前把用户上传的参考视频规整到合规范围：
 *   - 超长：从头截取到允许上限（-c copy 不重编码，秒级完成）
 *   - 过短（<2s）：明确报错，提示改用更长的片段
 * 每个视频的可用上限按剩余总时长预算动态收敛，保证合计 ≤ 上限。
 */
async function probeDurationSec(input) {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', input,
    ]);
    const d = Number(String(stdout).trim());
    return Number.isFinite(d) ? d : null;
  } catch {
    return null; // 探测失败：不阻断，交由 H3 给出明确报错
  }
}

/** 把内存中的文件落到临时文件，供 ffprobe/ffmpeg 处理（调用方负责清理） */
function bufferToTempFile(f) {
  const ext = path.extname(f.filename || '') || (/quicktime/.test(f.mimetype || '') ? '.mov' : '.mp4');
  const tmp = path.join(os.tmpdir(), `h3-ref-${crypto.randomUUID()}${ext}`);
  fs.writeFileSync(tmp, f.buffer);
  return tmp;
}

export async function normalizeReferenceVideos(files) {
  const cap = Math.max(2, config.limits.maxRefVideoSec || 15);
  const temps = [];
  const out = [];
  let budget = cap; // 参考视频合计可用时长
  try {
    for (const f of files || []) {
      const isVideo = /^video\//.test(f.mimetype || '') || /\.(mp4|mov)$/i.test(f.filename || '');
      if (!isVideo) { out.push(f); continue; }

      const src = bufferToTempFile(f);
      temps.push(src);
      const dur = await probeDurationSec(src);
      if (!dur) { out.push(f); continue; } // 探测不到时长：原样转发
      const allowed = Math.min(cap, budget);

      if (dur < 2) {
        throw new Error(`参考视频「${f.filename}」时长仅 ${dur.toFixed(1)} 秒，低于 H3 允许的最小值 2 秒，请换用更长的片段。`);
      }
      if (dur <= allowed + 0.05) { budget -= dur; out.push(f); continue; }
      if (allowed < 2) {
        throw new Error(`参考视频合计时长超出 H3 上限 ${cap} 秒（剩余 ${Math.max(0, budget).toFixed(1)} 秒），请减少参考视频数量或时长。`);
      }

      // 必须【重编码】：`-c copy` 按关键帧切，实际会切到 15.2s 之类，仍 >上限
      // 会被 H3 拒收。重编码后时长精确可控（参考片段很短，开销可接受）。
      // 再留 0.1s 余量，避开 H3 对「恰好 15.0」的浮点边界挑剔。
      const target = Math.max(2, allowed - 0.1);
      const trimmed = path.join(os.tmpdir(), `h3-trim-${crypto.randomUUID()}.mp4`);
      temps.push(trimmed);
      await execFileP('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-i', src,
        '-t', String(target),
        '-vf', 'setpts=PTS-STARTPTS',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        trimmed,
      ]);
      const outDur = (await probeDurationSec(trimmed)) || allowed;
      budget -= Math.min(allowed, outDur);
      out.push({ ...f, buffer: fs.readFileSync(trimmed), filename: `trim-${path.basename(f.filename || 'ref.mp4')}`, mimetype: 'video/mp4' });
      log.warn(`⚠️ 参考视频「${f.filename}」${dur.toFixed(1)}s 超出上限，已自动截取为 ${outDur.toFixed(1)}s`);
    }
    return out;
  } finally {
    for (const t of temps) { try { fs.unlinkSync(t); } catch {} }
  }
}

async function extractLastFrame(mp4Path, outPng) {
  // -vsync 0 / -fps_mode passthrough 在不同 ffmpeg 版本下名称不同，抽单帧时
  // 不传该选项即可（用 -frames:v 1 已足够精确取一帧）。
  await execFileP('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-sseof', '-0.1', '-i', mp4Path,
    '-q:v', '2', '-frames:v', '1', outPng,
  ]);
  return outPng;
}

/** 探测某一路流的时长（秒）；失败返回 null */
async function probeStreamDuration(input, kind = 'v:0') {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error', '-select_streams', kind,
      '-show_entries', 'stream=duration', '-of', 'default=nw=1:nk=1', input,
    ]);
    const d = Number(String(stdout).trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/**
 * 把一段视频归一化：时间戳从 0 开始、固定帧率 CFR、音频重采样到统一采样率。
 * 这是保证拼接后时间轴连续的关键——H3 各段的起始时间戳/帧率/音频延迟并不一致，
 * 直接 `-c copy` 拼接会在段边界留下间隙，浏览器播放到边界即卡住。
 *
 * 关键（v1.7.2 修复）：H3 每段返回的**音频轨常常比视频轨长**（AAC 编码器补帧 +
 * 模型音频尾巴），例如视频 15.0833s 而音频 15.5s。`aresample` 与 `-shortest` 都
 * **不会**把它截回视频长度，于是每段累积约 0.3~0.6s 的音频溢出，分段拼接后越往后
 * 音画偏移越大，表现为「重音/回声、后段音画不同步」。这里用显式 `-t <本段视频实际
 * 时长>` 把每段音视频强制对齐到同一时长，从根上消除累积漂移。
 */
async function normalizeSegment(input, output, { withAudio, clampSeconds }) {
  const fps = await fpsArgs();
  const args = [
    '-y', '-loglevel', 'error',
    '-i', input,
    '-vf', 'setpts=PTS-STARTPTS',
    // 固定帧率：选项名随 ffmpeg 版本而异（fps_mode / vsync），已自动探测
    '-r', '24', ...fps,
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  ];
  if (withAudio) {
    args.push(
      '-af', 'aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '32000', '-ac', '2',
    );
  } else {
    args.push('-an');
  }
  // 音视频对齐：以本段视频实际时长为准，截掉超出的音频尾巴（消除累积漂移）
  if (withAudio && Number.isFinite(clampSeconds) && clampSeconds > 0) {
    args.push('-t', clampSeconds.toFixed(4));
  }
  args.push('-movflags', '+faststart', output);
  await execFileP('ffmpeg', args, { maxBuffer: 1024 * 1024 * 16 });
  return output;
}

async function concatSegments(segmentPaths, outPath) {
  const workDir = path.dirname(outPath);
  const normalized = [];
  const vDurs = []; // 各段归一化后的视频时长（用于计算 xfade 偏移）
  let allHaveAudio = true;

  // 1) 逐段归一化
  for (let i = 0; i < segmentPaths.length; i++) {
    const out = path.join(workDir, `norm-${String(i + 1).padStart(2, '0')}.mp4`);
    let begin = segmentPaths[i];
    const vIn = await probeStreamDuration(begin, 'v:0');
    const aIn = await probeStreamDuration(begin, 'a:0');
    log.debug(`第 ${i + 1} 段原始：video=${vIn ?? '?'}s audio=${aIn ?? '?'}s`);
    try {
      await normalizeSegment(begin, out, { withAudio: true, clampSeconds: vIn });
      begin = out;
    } catch (err) {
      // 某段无音轨等异常：仅归一化视频
      log.warn(`第 ${i + 1} 段音频归一化失败，退回仅视频：${err.message}`);
      await normalizeSegment(begin, out, { withAudio: false });
      begin = out;
    }
    const vOut = await probeStreamDuration(begin, 'v:0');
    const aOut = await probeStreamDuration(begin, 'a:0');
    log.debug(`第 ${i + 1} 段归一化后：video=${vOut ?? '?'}s audio=${aOut ?? '?'}s`);
    if (vOut && aOut && Math.abs(vOut - aOut) > 0.06) {
      log.warn(`第 ${i + 1} 段归一化后音视频仍相差 ${(aOut - vOut).toFixed(3)}s（video ${vOut} / audio ${aOut}）`);
    }
    normalized.push(begin);
    vDurs.push(vOut);
    if (!aOut) allHaveAudio = false;
  }

  // 2) 拼接。
  //    v1.11.1：段间不再硬切，改用 xfade（视频）+ acrossfade（音频）交叉溶解，
  //    消除段边界处「画面/声音瞬间跳变」造成的那一下卡顿感。
  //    每处溶解时长 XFADE_SECONDS，偏移按各段实际时长累减精确计算。
  const fps = await fpsArgs();
  const dursKnown = vDurs.length === normalized.length && vDurs.every((v) => Number.isFinite(v) && v > XFADE_SECONDS * 2);
  if (!dursKnown && normalized.length >= 2) {
    log.warn('分段时长未知或过短，退回硬切拼接（无法安全计算交叉溶解偏移）');
  }
  const useCrossfade = normalized.length >= 2 && allHaveAudio && dursKnown;

  if (useCrossfade) {
    const d = XFADE_SECONDS;
    const parts = [];
    let vPrev = '[0:v]';
    let aPrev = '[0:a]';
    let acc = vDurs[0]; // 已拼接部分的当前时长（= 下一处溶解的偏移基准）
    for (let i = 1; i < normalized.length; i++) {
      const vOut = `[v${i}]`;
      const aOut = `[a${i}]`;
      const offset = Math.max(0, acc - d);
      parts.push(`${vPrev}[${i}:v]xfade=transition=fade:duration=${d}:offset=${offset.toFixed(4)}${vOut}`);
      parts.push(`${aPrev}[${i}:a]acrossfade=d=${d}:c1=tri:c2=tri${aOut}`);
      vPrev = vOut;
      aPrev = aOut;
      acc = acc + vDurs[i] - d;
    }
    const args = ['-y', '-loglevel', 'error'];
    for (const p of normalized) args.push('-i', p);
    args.push(
      '-filter_complex', parts.join(';'),
      '-map', vPrev, '-map', aPrev,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-r', '24', ...fps,
      '-c:a', 'aac', '-b:a', '192k', '-ar', '32000', '-ac', '2',
      '-shortest',
      '-movflags', '+faststart',
      outPath,
    );
    try {
      await execFileP('ffmpeg', args, { maxBuffer: 1024 * 1024 * 16 });
    } catch (err) {
      // 交叉溶解失败（个别段异常）时退回硬切拼接，保证总能出片
      log.warn(`交叉溶解拼接失败，退回硬切拼接：${err.message}`);
      await concatHardCuts(normalized, outPath, fps);
    }
  } else {
    if (normalized.length >= 2 && !allHaveAudio) {
      log.warn('有分段缺音轨，退回硬切拼接（无法做音频交叉溶解）');
    }
    await concatHardCuts(normalized, outPath, fps);
  }
  const vOut = await probeStreamDuration(outPath, 'v:0');
  const aOut = await probeStreamDuration(outPath, 'a:0');
  log.debug(`拼接后成片：video=${vOut ?? '?'}s audio=${aOut ?? '?'}s 段数=${segmentPaths.length}`);
  return outPath;
}

/**
 * 后期 drawtext 烧字（可选步骤）。
 * 在成片上叠加文本，解决 H3 模型侧中文渲染乱码问题。
 * 两种内置字体：Noto Sans CJK SC (OTF) / WQY Zenhei (TTC)。
 * @param {string} inputPath - 输入视频路径
 * @param {string} outputPath - 输出视频路径
 * @param {object} opts - drawtext 选项
 * @returns {Promise<string>} - 输出路径
 */
async function applyDrawtext(inputPath, outputPath, opts) {
  const { text, font, fontSize, x, y, color, box, boxColor, boxBorderW } = opts || {};
  if (!text || !text.trim()) return inputPath; // 空文本直接返回原片

  // 字体文件路径映射（Dockerfile 已安装到这些路径）
  const fontPaths = {
    noto: '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    wqy: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  };
  const fontPath = fontPaths[font] || fontPaths.noto;
  const safeFontSize = Math.max(12, Math.min(200, Number(fontSize) || 48));
  const safeBoxBorderW = Math.max(0, Math.min(50, Number(boxBorderW) || 0));

  // 验证字体文件存在
  if (!fs.existsSync(fontPath)) {
    log.warn(`drawtext 字体文件不存在：${fontPath}，跳过烧字`);
    return inputPath;
  }

  // drawtext filter：转义文本中的特殊字符
  // ffmpeg drawtext 需要转义 ':' '\' "' '%' 等字符
  const escapedText = String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');

  const filter = `drawtext=fontfile=${fontPath}:text='${escapedText}':fontsize=${safeFontSize}:fontcolor=${color}:x=${x}:y=${y}${box ? `:box=1:boxcolor=${boxColor}:boxborderw=${safeBoxBorderW}` : ''}`;

  log.info(`应用 drawtext 烧字：font=${font} text="${text.slice(0, 30)}..." size=${fontSize} pos=(${x},${y}) color=${color}`);

  await execFileP('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', inputPath,
    '-vf', filter,
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outputPath,
  ], { maxBuffer: 1024 * 1024 * 16 });

  return outputPath;
}

async function maybeApplyDrawtext(inputPath, opts) {
  if (!opts?.enabled || !String(opts.text || '').trim()) return inputPath;
  const outputPath = path.join(os.tmpdir(), `h3-drawtext-${crypto.randomUUID()}.mp4`);
  try {
    await applyDrawtext(inputPath, outputPath, opts);
    try { fs.unlinkSync(inputPath); } catch {}
    return outputPath;
  } catch (err) {
    try { fs.unlinkSync(outputPath); } catch {}
    log.warn(`drawtext 烧字失败，使用原片：${err.message}`);
    return inputPath;
  }
}

/**
 * 硬切拼接（回退路径）：重新编码后用 concat demuxer 顺序拼接，无交叉溶解。
 * 即使各段已归一化（时间戳归零、CFR），`-c copy` 仍会因 AAC 编码器延时/容器
 * 时长误差在段边界留下 0.02~0.07s 间隙，故这里仍必须重新编码。
 */
async function concatHardCuts(normalized, outPath, fps) {
  const workDir = path.dirname(outPath);
  const listFile = path.join(workDir, `concat-${Date.now()}.txt`);
  fs.writeFileSync(listFile, normalized.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    await execFileP('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-r', '24', ...fps,
      '-c:a', 'aac', '-b:a', '192k', '-ar', '32000', '-ac', '2',
      '-af', 'aresample=async=1:first_pts=0',
      '-movflags', '+faststart',
      outPath,
    ], { maxBuffer: 1024 * 1024 * 16 });
  } finally {
    try { fs.unlinkSync(listFile); } catch {}
  }
  return outPath;
}

/**
 * 生成可超过 15 秒的视频。
 *
 * 两种模式：
 *  A. 提示词是「分镜脚本」（含 镜头N 0:00–0:04 …）→ 按镜头分组，每段只喂自己那部分剧本，
 *     第 2 段起用上一段末帧续写，避免后段重复前段。
 *  B. 普通提示词 → 均匀分段，并给每段附加"承接上段、不要重复开头"的续写指令。
 */
/**
 * 只做「分段计划」的纯函数版本（不触碰文件、不调用后端）。
 * 与 generateLongVideo 共用同一套逻辑，保证「预演看到的」==「真正执行的」。
 *
 * 返回 { storyboard, plans:[{ prompt, mode, duration, usePrevFrame }] }。
 */
export function planSegmentPrompts(o) {
  const storyboard = parseStoryboard(o.prompt);

  let plans; // [{ prompt, mode, duration, usePrevFrame }]
  if (storyboard) {
    // 分镜路径同样受总时长上限约束，避免超长剧本绕过限制
    let groups = groupShots(storyboard.shots, Math.max(4, Math.min(Number(o.segmentSeconds) || H3_MAX_SECONDS, H3_MAX_SECONDS)));
    const cap = config.limits.maxDurationSec;
    let acc = 0;
    const capped = [];
    for (const g of groups) {
      if (acc + g.dur > cap && capped.length) break;
      capped.push(g);
      acc += g.dur;
    }
    groups = capped;
    const total = groups.length;
    plans = groups.map((g, i) => {
      const dur = Math.min(H3_MAX_SECONDS, gridDuration(g.dur).seconds);
      const shotText = g.shots.map((s) => s.body).join('\n');
      const parts = [];
      if (storyboard.header) parts.push(storyboard.header);
      parts.push('【本段分镜（严格按此演绎，不要演绎其他段落的内容）】');
      parts.push(shotText);
      parts.push(
        i === 0
          ? '【连贯性】这是整条视频的开场段。'
          : `【连贯性】这是整条视频的第 ${i + 1}/${total} 段，紧接上一段结尾继续发展。保持与上一段完全一致的人物脸部、发型与服装；不要重复开场画面，直接从本段分镜的情境继续。`,
      );
      return { prompt: parts.join('\n\n'), mode: i === 0 ? o.mode : 'fl2va', duration: dur, usePrevFrame: i > 0 };
    });
  } else {
    const segs = planSegments(o.duration, config.limits.maxDurationSec, o.segmentSeconds).map((s) => gridDuration(s).seconds);
    const total = segs.length;
    plans = segs.map((dur, i) => {
      const cont =
        i === 0
          ? ''
          : `\n\n【连贯性】这是整条视频的第 ${i + 1}/${total} 段，紧接上一段结尾继续发展；保持人物、场景、色调一致；不要重复开头的画面与动作，直接从后续情节继续。`;
      return { prompt: o.prompt + cont, mode: i === 0 ? o.mode : 'fl2va', duration: dur, usePrevFrame: i > 0 };
    });
  }

  return { storyboard, plans };
}

export async function generateLongVideo(o) {
  const onProgress = o.onProgress || (() => {});
  // 参考视频先规整到 H3 允许范围（每段 2–15s、合计 ≤15s），否则 H3 会 500
  o = { ...o, files: await normalizeReferenceVideos(o.files || []) };
  const { storyboard, plans } = planSegmentPrompts(o);

  if (plans.length <= 1) {
    onProgress({ stage: 'video', current: 1, total: 1 });
    log.info(`单段生成：${o.width}x${o.height} ${plans[0].duration}s mode=${plans[0].mode}`);
    let prompt = plans[0].prompt;
    if (plans[0].mode === 'fl2va') {
      prompt = injectFl2vaAlignment(prompt, { imageCount: (o.files || []).length, duration: plans[0].duration });
    }
    const { bytes } = await generateVideo({ ...o, prompt, duration: plans[0].duration, turbo: o.turbo });
    // 写入临时文件后返回路径，避免把整片常驻内存
    const singlePath = path.join(os.tmpdir(), `h3-out-${crypto.randomUUID()}.mp4`);
    fs.writeFileSync(singlePath, bytes);
    const finalPath = await maybeApplyDrawtext(singlePath, o.drawtext);
    return { filePath: finalPath, segments: 1, seconds: plans[0].duration };
  }

  const persistentWorkDir = o.workDir ? path.resolve(o.workDir) : null;
  const workDir = persistentWorkDir || fs.mkdtempSync(path.join(os.tmpdir(), 'h3-long-'));
  fs.mkdirSync(workDir, { recursive: true });
  const segPaths = [];
  let resumePrefix = true;
  const manifestPath = path.join(workDir, 'manifest.json');
  let manifest = { segments: plans.map((p, i) => ({ index: i + 1, seconds: p.duration, status: 'pending' })), updatedAt: Date.now() };
  if (persistentWorkDir && fs.existsSync(manifestPath)) {
    try {
      const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (Array.isArray(previous.segments) && previous.segments.length === plans.length) manifest = previous;
    } catch { /* 损坏的 manifest 从现有段文件重建 */ }
  }
  const saveManifest = () => { manifest.updatedAt = Date.now(); fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)); };
  saveManifest();
  log.info(`分段生成：共 ${plans.length} 段，计划时长 [${plans.map((p) => p.duration).join(', ')}]s 分镜=${!!storyboard}`);

  try {
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      const segPath = path.join(workDir, `seg-${String(i + 1).padStart(2, '0')}.mp4`);
      if (resumePrefix && fs.existsSync(segPath)) {
        const existingDuration = await probeStreamDuration(segPath, 'v:0');
        if (existingDuration && Math.abs(existingDuration - p.duration) < 0.25) {
          segPaths.push(segPath);
          manifest.segments[i] = { index: i + 1, seconds: p.duration, actualSeconds: existingDuration, status: 'done', path: segPath };
          saveManifest();
          onProgress({ stage: 'segment', current: i + 1, total: plans.length, seconds: p.duration, resumed: true });
          log.info(`第 ${i + 1}/${plans.length} 段复用已完成结果：${existingDuration.toFixed(2)}s`);
          continue;
        }
      }
      // 只能从连续前缀恢复；一旦缺段，后面的旧文件不能继续沿用。
      resumePrefix = false;
      try { fs.unlinkSync(segPath); } catch {}
      onProgress({ stage: 'segment', current: i + 1, total: plans.length, seconds: p.duration });
      log.info(`第 ${i + 1}/${plans.length} 段开始：mode=${i === 0 ? p.mode : 'fl2va?'} 请求时长=${p.duration}s`);

      // 逐段重试：只重跑失败的那一段，已成功的段不重做
      let bytes;
      let lastErr;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const files = [];
          let usePrev = p.usePrevFrame;
          if (usePrev) {
            // 抽上一段末帧作首帧；抽帧失败则退化为纯文本续写，不让整条失败
            try {
              const lastFrame = await extractLastFrame(segPaths[i - 1], path.join(workDir, `last-${i}.png`));
              files.push({
                field: 'input_reference',
                filename: `last-${i}.png`,
                mimetype: 'image/png',
                buffer: fs.readFileSync(lastFrame),
              });
            } catch (err) {
              log.warn(`第 ${i + 1} 段抽帧失败，退化为纯文本续写：${err.message}`);
              usePrev = false;
            }
          } else if (o.files?.length) {
            files.push(...o.files);
          }

          // 模式选择（关键）：
          //   第 1 段 -> 用用户所选模式（t2va/fl2va/ref2va），并带上其参考文件
          //   后续段且成功抽帧 -> fl2va（以上段末帧为首帧）
          //   后续段但抽帧失败 -> t2va（无任何参考文件）
          // 早前版本把第 1 段硬编码为 t2va，导致 ref2va/fl2va 的参考文件
          // 被发给 t2va 而报 “t2va does not accept image/video/audio conditions”。
          // VDN-H3 supports t2va/fl2va; a later segment is always fl2va when
          // its previous-frame condition is available. Ref2va-like references
          // are sent only on the first segment; VDN does not accept video refs.
          const segMode = i === 0 ? (p.mode === 'ref2va' ? 'fl2va' : p.mode) : (usePrev ? 'fl2va' : 't2va');
          // fl2va 必须在正文前注入官方对齐指令（首帧->0.00s，末帧->duration）
          const segPrompt = segMode === 'fl2va'
            ? injectFl2vaAlignment(p.prompt, { imageCount: files.filter((f) => /^image\//.test(f.mimetype || '')).length, duration: p.duration })
            : p.prompt;
          ({ bytes } = await generateVideo({
            prompt: segPrompt,
            mode: segMode,
            width: o.width,
            height: o.height,
            aspectRatio: o.aspectRatio,
            fps: o.fps,
            steps: o.steps,
            flowShift: o.flowShift,
            seed: o.seed,
            duration: p.duration,
            audioFlowShift: o.audioFlowShift,
            files,
            turbo: o.turbo,
          }));
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          log.warn(`第 ${i + 1}/${plans.length} 段第 ${attempt} 次失败：${err.message}`);
          if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (lastErr) {
        manifest.segments[i] = { index: i + 1, seconds: p.duration, status: 'error', error: lastErr.message };
        saveManifest();
        throw new Error(`第 ${i + 1}/${plans.length} 段生成失败：${lastErr.message}`);
      }

      fs.writeFileSync(segPath, bytes);
      manifest.segments[i] = { index: i + 1, seconds: p.duration, status: 'done', path: segPath };
      saveManifest();
      const vSec = await probeStreamDuration(segPath, 'v:0');
      const aSec = await probeStreamDuration(segPath, 'a:0');
      const sizeMB = (bytes.length / 1048576).toFixed(2);
      log.info(`第 ${i + 1}/${plans.length} 段完成：请求=${p.duration}s 返回 video=${vSec ?? '?'}s audio=${aSec ?? '?'}s 大小=${sizeMB}MB`);
      if (p.duration && vSec && Math.abs(vSec - p.duration) > 0.15) {
        log.warn(`第 ${i + 1} 段返回时长与请求不符：请求 ${p.duration}s，实得 video ${vSec}s`);
      }
      segPaths.push(segPath);
    }

    onProgress({ stage: 'concat', current: plans.length, total: plans.length });
    log.info(`开始拼接 ${segPaths.length} 段…`);
    const outPath = path.join(workDir, 'final.mp4');
    await concatSegments(segPaths, outPath);
    // 后期 drawtext 烧字（按本次任务的可选参数执行）
    const renderedPath = await maybeApplyDrawtext(outPath, o.drawtext);
    // 把成片移出 workDir（workDir 会在 finally 被删），返回路径而非字节，
    // 避免长视频（可能数百 MB~数 GB）整块读进内存。
    const finalPath = path.join(os.tmpdir(), `h3-out-${crypto.randomUUID()}.mp4`);
    fs.renameSync(renderedPath, finalPath);
    return { filePath: finalPath, segments: plans.length, seconds: plans.reduce((a, p) => a + p.duration, 0), storyboard: !!storyboard };
  } finally {
    if (!persistentWorkDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}
