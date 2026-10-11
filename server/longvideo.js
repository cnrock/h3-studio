import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateVideo } from './h3.js';

const execFileP = promisify(execFile);

export const H3_MAX_SECONDS = 15;

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

  // 找到所有"镜头块"的起始行
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (shotRe.test(lines[i]) && timeRe.test(lines[i])) starts.push(i);
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
export function planSegments(totalSeconds) {
  const total = Math.max(4, Math.min(Number(totalSeconds) || 0, 120));
  const n = Math.max(1, Math.ceil(total / H3_MAX_SECONDS));
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

async function extractLastFrame(mp4Path, outPng) {
  await execFileP('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-sseof', '-0.1', '-i', mp4Path,
    '-vsync', '0', '-q:v', '2', '-frames:v', '1', outPng,
  ]);
  return outPng;
}

/**
 * 把一段视频归一化：时间戳从 0 开始、固定帧率 CFR、音频重采样到统一采样率。
 * 这是保证拼接后时间轴连续的关键——H3 各段的起始时间戳/帧率/音频延迟并不一致，
 * 直接 `-c copy` 拼接会在段边界留下间隙，浏览器播放到边界即卡住。
 */
async function normalizeSegment(input, output, { withAudio }) {
  const args = [
    '-y', '-loglevel', 'error',
    '-i', input,
    '-vf', 'setpts=PTS-STARTPTS',
    // 固定帧率：用 -vsync cfr（ffmpeg 4.x 与 5+/7.x 均兼容）；
    // 不要用 -fps_mode（仅 ffmpeg 5+ 支持，旧版会 "Unrecognized option"）。
    '-r', '24', '-vsync', 'cfr',
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
  args.push('-movflags', '+faststart', output);
  await execFileP('ffmpeg', args, { maxBuffer: 1024 * 1024 * 16 });
  return output;
}

async function concatSegments(segmentPaths, outPath) {
  const workDir = path.dirname(outPath);
  const normalized = [];

  // 1) 逐段归一化
  for (let i = 0; i < segmentPaths.length; i++) {
    const out = path.join(workDir, `norm-${String(i + 1).padStart(2, '0')}.mp4`);
    let begin = segmentPaths[i];
    try {
      await normalizeSegment(begin, out, { withAudio: true });
      begin = out;
    } catch (err) {
      // 某段无音轨等异常：仅归一化视频
      console.warn(`⚠️ 第 ${i + 1} 段音频归一化失败，退回仅视频：${err.message}`);
      await normalizeSegment(begin, out, { withAudio: false });
      begin = out;
    }
    normalized.push(begin);
  }

  // 2) 拼接（此时各段时间戳已归零且编码参数一致，可安全流拷贝）
  const listFile = path.join(workDir, `concat-${Date.now()}.txt`);
  fs.writeFileSync(listFile, normalized.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    await execFileP('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy',
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
export async function generateLongVideo(o) {
  const onProgress = o.onProgress || (() => {});
  const storyboard = parseStoryboard(o.prompt);

  let plans; // [{ prompt, mode, duration, usePrevFrame }]
  if (storyboard) {
    const groups = groupShots(storyboard.shots);
    const total = groups.length;
    plans = groups.map((g, i) => {
      const dur = Math.min(H3_MAX_SECONDS, Math.max(4, Math.round(g.dur)));
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
    const segs = planSegments(o.duration);
    const total = segs.length;
    plans = segs.map((dur, i) => {
      const cont =
        i === 0
          ? ''
          : `\n\n【连贯性】这是整条视频的第 ${i + 1}/${total} 段，紧接上一段结尾继续发展；保持人物、场景、色调一致；不要重复开头的画面与动作，直接从后续情节继续。`;
      return { prompt: o.prompt + cont, mode: i === 0 ? o.mode : 'fl2va', duration: dur, usePrevFrame: i > 0 };
    });
  }

  if (plans.length <= 1) {
    onProgress({ stage: 'video', current: 1, total: 1 });
    const { bytes } = await generateVideo({ ...o, prompt: plans[0].prompt, duration: plans[0].duration });
    return { bytes, segments: 1, seconds: plans[0].duration };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-long-'));
  const segPaths = [];

  try {
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      onProgress({ stage: 'segment', current: i + 1, total: plans.length, seconds: p.duration });

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
              console.warn(`⚠️ 第 ${i + 1} 段抽帧失败，退化为纯文本续写：${err.message}`);
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
          const segMode = i === 0 ? p.mode : (usePrev ? 'fl2va' : 't2va');
          ({ bytes } = await generateVideo({
            prompt: p.prompt,
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
          }));
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`⚠️ 第 ${i + 1}/${plans.length} 段第 ${attempt} 次失败：${err.message}`);
          if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (lastErr) throw new Error(`第 ${i + 1}/${plans.length} 段生成失败：${lastErr.message}`);

      const segPath = path.join(workDir, `seg-${String(i + 1).padStart(2, '0')}.mp4`);
      fs.writeFileSync(segPath, bytes);
      segPaths.push(segPath);
    }

    onProgress({ stage: 'concat', current: plans.length, total: plans.length });
    const outPath = path.join(workDir, 'final.mp4');
    await concatSegments(segPaths, outPath);
    const bytes = fs.readFileSync(outPath);
    return { bytes, segments: plans.length, seconds: plans.reduce((a, p) => a + p.duration, 0), storyboard: !!storyboard };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
