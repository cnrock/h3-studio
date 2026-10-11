import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateVideo } from './h3.js';

const execFileP = promisify(execFile);

export const H3_MAX_SECONDS = 15;

/**
 * 判断是否需要分段：H3 单次生成硬上限 15 秒。
 */
export function planSegments(totalSeconds) {
  const total = Math.max(4, Math.min(Number(totalSeconds) || 0, 120));
  // 段数：向上取整，每段尽量均匀且 ∈ [4, 15]，避免出现 <4 秒而丢时长
  const n = Math.max(1, Math.ceil(total / H3_MAX_SECONDS));
  const base = Math.floor(total / n);
  let remainder = total - base * n;
  const segs = [];
  for (let i = 0; i < n; i++) {
    // 把余数尽量平均分到前几段
    const extra = remainder > 0 ? 1 : 0;
    if (extra) remainder--;
    segs.push(base + extra);
  }
  // 修正：任何 <4 的段与相邻段合并（不会发生，但保留兜底）
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i] < 4 && segs.length > 1) {
      const j = i > 0 ? i - 1 : i + 1;
      segs[j] += segs[i];
      segs.splice(i, 1);
    }
  }
  return segs;
}

async function extractLastFrame(mp4Path, outPng) {
  // 取倒数第 1 帧（-sseof 定位到结尾前 0.1s，取 1 帧）
  await execFileP('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-sseof', '-0.1', '-i', mp4Path,
    '-vsync', '0', '-q:v', '2', '-frames:v', '1', outPng,
  ]);
  return outPng;
}

async function concatSegments(segmentPaths, outPath) {
  const listFile = path.join(path.dirname(outPath), `concat-${Date.now()}.txt`);
  fs.writeFileSync(listFile, segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    // 用 concat demuxer 流拷贝（各段同为 H.264/AAC，参数一致）
    await execFileP('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', outPath,
    ]);
  } catch {
    // 流拷贝失败则转码拼接（更稳）
    await execFileP('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', outPath,
    ]);
  } finally {
    try { fs.unlinkSync(listFile); } catch {}
  }
  return outPath;
}

/**
 * 生成可超过 15 秒的视频：分段生成 + 首尾帧衔接 + 拼接。
 *
 * @param {object} o 同 generateVideo 的参数，外加 onProgress
 * @returns {Promise<{bytes: Buffer, segments: number, seconds: number}>}
 */
export async function generateLongVideo(o) {
  const segments = planSegments(o.duration);
  const onProgress = o.onProgress || (() => {});

  if (segments.length <= 1) {
    // 单段：直接生成
    onProgress({ stage: 'video', current: 1, total: 1 });
    const { bytes } = await generateVideo({ ...o, duration: segments[0] ?? o.duration });
    return { bytes, segments: 1, seconds: segments[0] ?? o.duration };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-long-'));
  const segPaths = [];

  try {
    for (let i = 0; i < segments.length; i++) {
      const idx = i + 1;
      const dur = segments[i];
      onProgress({ stage: 'segment', current: idx, total: segments.length, seconds: dur });

      const files = [];
      if (i > 0) {
        // 用上一段的最后一帧作为本段首帧，保证动作/画面延续
        const lastFrame = await extractLastFrame(segPaths[i - 1], path.join(workDir, `last-${i}.png`));
        files.push({
          field: 'input_reference',
          filename: `last-${i}.png`,
          mimetype: 'image/png',
          buffer: fs.readFileSync(lastFrame),
        });
      } else if (o.files?.length) {
        files.push(...o.files);
      }

      const { bytes } = await generateVideo({
        prompt: o.prompt,
        // 第 2 段起用 fl2va（首帧续写）；第 1 段沿用用户选择的模式
        mode: i > 0 ? 'fl2va' : o.mode,
        width: o.width,
        height: o.height,
        aspectRatio: o.aspectRatio,
        fps: o.fps,
        steps: o.steps,
        flowShift: o.flowShift,
        seed: o.seed,
        duration: dur,
        audioFlowShift: o.audioFlowShift,
        files,
      });

      const segPath = path.join(workDir, `seg-${String(idx).padStart(2, '0')}.mp4`);
      fs.writeFileSync(segPath, bytes);
      segPaths.push(segPath);
    }

    onProgress({ stage: 'concat', current: segments.length, total: segments.length });
    const outPath = path.join(workDir, 'final.mp4');
    await concatSegments(segPaths, outPath);
    const bytes = fs.readFileSync(outPath);
    return { bytes, segments: segments.length, seconds: segments.reduce((a, b) => a + b, 0) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
