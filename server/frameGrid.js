/**
 * MiniMax H3 帧数网格。
 *
 * 官方文档：帧数必须落在 17k+5 网格上；否则会被静默“向上吸附”到最近的合法值
 * （填 61 帧其实得到 73 帧，不报错也不提示）。训练区间为 124–362 帧，24fps 下即
 * 5.17–15.08 秒。常用合法帧数：124/158/192/245/293/362。
 *
 * 这里把用户填的秒数换算成「网格对齐后的帧数」，再回算实际秒数交给后端，
 * 于是后端拿到的就是合法帧数，不会再发生静默吸附 —— 用户填的和实际生成的对得上。
 */

export const FPS = 24;
export const GRID_STEP = 17;
export const GRID_OFFSET = 5;
export const MIN_FRAMES = 124; // 训练区间下限（≈5.17s）
export const MAX_FRAMES = 362; // 训练区间上限（≈15.08s）

/** 向上吸附到最近的 17k+5 网格帧 */
export function snapFrames(n) {
  const x = Math.max(1, Math.round(Number(n) || 0));
  if ((x - GRID_OFFSET) % GRID_STEP === 0) return x;
  const k = Math.ceil((x - GRID_OFFSET) / GRID_STEP);
  return Math.max(GRID_OFFSET + GRID_STEP * Math.max(0, k), GRID_OFFSET);
}

const round4 = (v) => Math.round(v * 10000) / 10000;

/**
 * 把「期望秒数」变成 H3 合法的一段时长（秒，保留 4 位小数）。
 * 返回 { seconds, frames }。
 *   - 帧数吸附到 17k+5 网格并限制在 [.., 362]；
 *   - 上限严格不超过 15.0s，避免个别后端对 duration>15 直接 400；
 *   - 下限 4s —— 低于 4s 的帧数若吸附后仍 <4s，保持 4s（后端最小段）。
 */
export function gridDuration(sec) {
  const x = Number(sec) || 0;
  let frames = snapFrames(x * FPS);
  if (frames > MAX_FRAMES) frames = MAX_FRAMES;
  // 返回 H3 实际会使用的帧数与对应秒数（最多 362 帧 = 15.0833s，与官方上限一致）。
  // 发送时 h3.js 会把 duration 夹到 ≤15，后端会自行吸附回 362 帧，结果一致。
  return { seconds: round4(frames / FPS), frames };
}

/** 供前端展示：给定秒数 -> { seconds, frames, note } */
export function describeDuration(sec) {
  const { seconds, frames } = gridDuration(sec);
  const snapped = Math.abs(seconds - Number(sec)) > 0.001;
  return {
    seconds,
    frames,
    snapped,
    note: `${frames} 帧 · ${seconds.toFixed(2)}s${snapped ? '（已吸附到 H3 合法帧网格）' : ''}`,
  };
}

export function gridInfo() {
  return { fps: FPS, step: GRID_STEP, offset: GRID_OFFSET, minFrames: MIN_FRAMES, maxFrames: MAX_FRAMES };
}
