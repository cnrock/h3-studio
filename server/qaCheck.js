/**
 * 出片自检（v1.11.1）：成片落盘后自动跑一遍轻量质检，把「肉眼才发现的问题」提前报出来。
 *
 * 覆盖四类常见缺陷（均由 ffmpeg/ffprobe 本地完成，不依赖任何模型、不额外花算力）：
 *   1. 音画时长不一致 —— 分段拼接后音频比视频长出/短于阈值，播放到尾部会漂移。
 *   2. 静音段     —— 某段音轨缺失或没出声（silencedetect）。
 *   3. 爆音/削波  —— 采样值顶到 int16 上限的样本占比过高（H3 音频偶发）。
 *   4. 卡顿/重复帧 —— 连续多帧几乎完全不变（画面「卡住一下」）。
 *
 * 只做「提示」，从不拦截出片：任务照常完成，findings 附在 progress 里给前端展示。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { log } from './log.js';

const execFileP = promisify(execFile);

/** 单次 ffmpeg/ffprobe 调用的超时（毫秒）——防止异常文件卡住任务收尾 */
const PROC_TIMEOUT = 60 * 1000;
/** 自检最多分析前 N 秒，超长片只查开头，避免耗时随片长线性增长 */
const MAX_ANALYZE_SECONDS = 600;
/** 冻帧判定：帧间平均绝对差 < 该值（0–255 灰度）视为「没有变化」 */
const FREEZE_EPS = 0.5;
/** 冻帧判定：连续静帧时长 >= 该值（秒）才报卡顿 */
const FREEZE_MIN_SECONDS = 0.3;
/** 削波判定：|sample| >= 该值即视为顶到上限 */
const CLIP_LEVEL = 32700;
/** 削波占比告警阈值 */
const CLIP_RATIO_WARN = 0.001;

const ff = (args, opts = {}) =>
  execFileP('ffmpeg', ['-hide_banner', '-nostdin', ...args], {
    maxBuffer: 256 * 1024 * 1024,
    timeout: PROC_TIMEOUT,
    ...opts,
  });

async function ffprobeJson(input) {
  const { stdout } = await execFileP(
    'ffprobe',
    ['-v', 'error', '-of', 'json', '-show_format', '-show_streams', input],
    { maxBuffer: 16 * 1024 * 1024, timeout: PROC_TIMEOUT },
  );
  return JSON.parse(stdout);
}

/** 解码音频为 int16 单声道 PCM（22050Hz），返回 { samples, rate } */
async function decodeAudioPcm(input) {
  const { stdout } = await ff(
    ['-y', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '22050', '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
  );
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  // Buffer 可能未按 2 字节对齐，复制一份保证 Int16Array 读取安全
  const aligned = buf.length % 2 ? buf.subarray(0, buf.length - 1) : buf;
  const samples = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length / 2);
  return { samples: Int16Array.from(samples), rate: 22050 };
}

/** 检测静音段：返回 [{ start, end, duration }] */
async function detectSilence(input) {
  try {
    const { stderr } = await ff([
      '-i', input, '-af', 'silencedetect=n=-45dB:d=0.5', '-vn', '-f', 'null', '-',
    ]);
    const out = String(stderr);
    const segs = [];
    let cur = null;
    for (const m of out.matchAll(/silence_(start|end):\s*([0-9.]+)(?:\s*\|\s*silence_duration:\s*([0-9.]+))?/g)) {
      if (m[1] === 'start') cur = { start: Number(m[2]), end: null, duration: null };
      else if (cur) {
        cur.end = Number(m[2]);
        cur.duration = m[3] ? Number(m[3]) : cur.end - cur.start;
        segs.push(cur);
        cur = null;
      }
    }
    return segs;
  } catch {
    return [];
  }
}

/**
 * 冻帧（卡顿/重复帧）检测。
 * 把视频缩小到 32x18 灰度、抽到 12fps（足够发现 >0.3s 的卡顿，且数据量极小），
 * 逐帧求相邻帧的平均绝对差；连续 < FREEZE_EPS 的帧即视为画面停住。
 */
async function detectFreeze(input) {
  const W = 32;
  const H = 18;
  const FPS = 12;
  let raw;
  try {
    const { stdout } = await ff([
      '-y', '-loglevel', 'error', '-t', String(MAX_ANALYZE_SECONDS),
      '-i', input, '-an',
      '-vf', `fps=${FPS},scale=${W}:${H}:flags=area,format=gray`,
      '-f', 'rawvideo', '-',
    ], { encoding: 'buffer' });
    raw = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch {
    return { available: false, freezes: [] };
  }
  const frameSize = W * H;
  const count = Math.floor(raw.length / frameSize);
  if (count < 2) return { available: false, freezes: [] };

  const freezes = [];
  let prev = raw.subarray(0, frameSize);
  let runStart = 0; // 当前「画面停滞」起始帧
  const closeRun = (endExclusive) => {
    const len = endExclusive - runStart; // 停滞持续帧数
    const dur = len / FPS;
    if (dur >= FREEZE_MIN_SECONDS) {
      freezes.push({ startFrame: runStart, start: runStart / FPS, duration: dur });
    }
  };
  for (let i = 1; i < count; i++) {
    const cur = raw.subarray(i * frameSize, (i + 1) * frameSize);
    let diff = 0;
    for (let k = 0; k < frameSize; k++) diff += Math.abs(cur[k] - prev[k]);
    diff /= frameSize;
    if (diff >= FREEZE_EPS) {
      // 帧有变化：结束上一段停滞，从本帧重新开始
      closeRun(i);
      runStart = i;
    }
    prev = cur;
  }
  closeRun(count); // 收尾最后一段
  return { available: true, freezes };
}

/** 统计削波样本占比与峰值 */
function clipStats(samples) {
  if (!samples.length) return { ratio: 0, peak: 0 };
  let clipped = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    if (a >= CLIP_LEVEL) clipped++;
  }
  return { ratio: clipped / samples.length, peak };
}

/**
 * 对成片跑一遍自检。
 * @returns {Promise<object>} { ok, duration, videoSeconds, audioSeconds, findings:[{level,code,message}] }
 */
export async function analyzeVideo(filePath) {
  const findings = [];
  const info = {
    ok: false,
    file: path.basename(filePath),
    bytes: null,
    duration: null,
    videoSeconds: null,
    audioSeconds: null,
    hasAudio: false,
    findings,
  };

  const add = (level, code, message) => findings.push({ level, code, message });

  try {
    info.bytes = fs.statSync(filePath).size;
  } catch {
    add('warn', 'missing', '成片文件不存在或不可读');
    return info;
  }

  // ---- 1) 容器与流信息 ----
  let probe;
  try {
    probe = await ffprobeJson(filePath);
  } catch (err) {
    add('warn', 'probe_failed', `ffprobe 读取失败：${err.message}`);
    return info;
  }
  const vStream = (probe.streams || []).find((s) => s.codec_type === 'video');
  const aStream = (probe.streams || []).find((s) => s.codec_type === 'audio');
  info.duration = Number(probe.format?.duration) || null;
  info.videoSeconds = Number(vStream?.duration) || null;
  info.audioSeconds = Number(aStream?.duration) || null;
  info.hasAudio = !!aStream;

  if (!vStream) {
    add('warn', 'no_video', '成片里没有视频流');
    return info;
  }
  if (!aStream) {
    add('warn', 'no_audio', '成片里没有音轨（静音成片）');
  } else if (info.videoSeconds && info.audioSeconds) {
    const diff = info.audioSeconds - info.videoSeconds;
    if (Math.abs(diff) > 0.3) {
      add(
        'warn',
        'av_drift',
        `音画时长不一致：视频 ${info.videoSeconds.toFixed(2)}s / 音频 ${info.audioSeconds.toFixed(2)}s` +
          `（相差 ${diff > 0 ? '+' : ''}${diff.toFixed(2)}s），尾部可能漂移。`,
      );
    }
  }

  // ---- 2) 冻帧（卡顿/重复帧）----
  try {
    const { available, freezes } = await detectFreeze(filePath);
    info.freezeAvailable = available;
    if (available) {
      const bad = freezes.filter((f) => f.duration >= FREEZE_MIN_SECONDS);
      info.freezes = bad.map((f) => ({ at: Number(f.start.toFixed(2)), duration: Number(f.duration.toFixed(2)) }));
      if (bad.length) {
        const worst = bad.reduce((a, b) => (b.duration > a.duration ? b : a));
        add(
          'note',
          'freeze',
          `检测到 ${bad.length} 处画面停滞（最长 ${worst.duration.toFixed(2)}s @ ${worst.start.toFixed(2)}s）` +
            `，可能是分段边界的重复帧/卡顿。`,
        );
      }
    }
  } catch (err) {
    log.debug(`冻帧检测失败：${err.message}`);
  }

  // ---- 3) 音频：静音 / 削波 ----
  if (aStream) {
    try {
      const { samples, rate } = await decodeAudioPcm(filePath);
      const { ratio, peak } = clipStats(samples);
      info.audioPeak = peak;
      info.clipRatio = Number(ratio.toFixed(6));
      if (ratio >= CLIP_RATIO_WARN) {
        add(
          'note',
          'clipping',
          `音频削波：${(ratio * 100).toFixed(2)}% 的采样顶到上限（峰值 ${peak}），可能出现爆音/失真。`,
        );
      }

      // 静音段（只统计 >=0.5s 的）
      const silences = await detectSilence(filePath);
      const longSil = silences.filter((s) => (s.duration || 0) >= 0.5);
      if (longSil.length) {
        info.silences = longSil.map((s) => ({
          at: Number((s.start || 0).toFixed(2)),
          duration: Number((s.duration || 0).toFixed(2)),
        }));
        const totalSil = longSil.reduce((a, s) => a + (s.duration || 0), 0);
        const dur = info.duration || (samples.length / rate);
        // 只在静音占比明显（>15%）时提示，避免正常的停顿被误报
        if (dur && totalSil / dur > 0.15) {
          add(
            'note',
            'silence',
            `静音段偏多：共 ${longSil.length} 段、合计 ${totalSil.toFixed(2)}s` +
              `（占成片 ${((totalSil / dur) * 100).toFixed(0)}%），可能有段没出声。`,
          );
        }
      }
    } catch (err) {
      log.debug(`音频自检失败：${err.message}`);
    }
  }

  info.ok = true;
  return info;
}
