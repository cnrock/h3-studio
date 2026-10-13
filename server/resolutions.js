/**
 * MiniMax H3 原生画布与分辨率预设。
 *
 * 官方部署文档给出的硬规则：
 *   - 模型按「短边 768、面积上限 768×1344、每轴对齐 32 的倍数」训练；
 *   - Megapixels ≈ 1.0 时 16:9 得到 1344×768，质量最好；
 *   - 低于 384p（短边 < 384）几乎必然失败。
 * 因此这里不再让「画幅比例」与「分辨率」各选各的（旧版会出现 9:16 + 1344×768
 * 这种自相矛盾的组合），而是按比例给出一致的预设，全部为 32 的倍数。
 *
 * 三档：
 *   preview      短边约 512，快速预览（试提示词用）
 *   standard     短边 768，正片推荐档（原生画布，质量最好）
 *   experimental 约 2K，远超原生画布，慢且可能失真，仅作实验
 */

export const ALIGN = 32;
export const align32 = (n) => Math.max(ALIGN, Math.ceil(Number(n) / ALIGN) * ALIGN);

// 比例 -> 预设列表（顺序：预览 / 标准 / 2K 实验）
export const ASPECT_PRESETS = {
  '16:9': [
    { id: 'preview', level: 'preview', width: 896, height: 512 },
    { id: 'standard', level: 'standard', width: 1344, height: 768 },
    { id: '2k', level: 'experimental', width: 2560, height: 1440 },
  ],
  '9:16': [
    { id: 'preview', level: 'preview', width: 512, height: 896 },
    { id: 'standard', level: 'standard', width: 768, height: 1344 },
    { id: '2k', level: 'experimental', width: 1440, height: 2560 },
  ],
  '1:1': [
    { id: 'preview', level: 'preview', width: 512, height: 512 },
    { id: 'standard', level: 'standard', width: 768, height: 768 },
    { id: '2k', level: 'experimental', width: 1440, height: 1440 },
  ],
  '4:3': [
    { id: 'preview', level: 'preview', width: 640, height: 480 },
    { id: 'standard', level: 'standard', width: 1024, height: 768 },
    { id: '2k', level: 'experimental', width: 1920, height: 1440 },
  ],
  '3:4': [
    { id: 'preview', level: 'preview', width: 480, height: 640 },
    { id: 'standard', level: 'standard', width: 768, height: 1024 },
    { id: '2k', level: 'experimental', width: 1440, height: 1920 },
  ],
  '21:9': [
    { id: 'preview', level: 'preview', width: 1024, height: 448 },
    { id: 'standard', level: 'standard', width: 1344, height: 576 },
    { id: '2k', level: 'experimental', width: 2560, height: 1088 },
  ],
};

const LABELS = {
  preview: '预览',
  standard: '标准',
  experimental: '2K（实验性）',
};

/** 供前端渲染：比例 -> [{value,label,level}]，value 为 "WxH" */
export function presetsForClient() {
  const out = {};
  for (const [ar, list] of Object.entries(ASPECT_PRESETS)) {
    out[ar] = list.map((p) => ({
      value: `${p.width}x${p.height}`,
      width: p.width,
      height: p.height,
      level: p.level,
      label: `${LABELS[p.level] || p.level} ${p.width}×${p.height}`,
    }));
  }
  return out;
}

/** 由像素尺寸反推最接近的画幅比例键（用于服务端纠偏） */
export function aspectFor(width, height) {
  const r = Number(width) / Number(height);
  let best = '16:9';
  let bestD = Infinity;
  for (const key of Object.keys(ASPECT_PRESETS)) {
    const [a, b] = key.split(':').map(Number);
    const d = Math.abs(a / b - r);
    if (d < bestD) { bestD = d; best = key; }
  }
  return best;
}

/**
 * 规整用户提交的宽高：
 *   - 每轴向上取到 32 的倍数（不对齐会被 H3 静默裁切/报错）
 *   - 记录是否发生了改动，便于服务端日志与前端提示
 *   - 短边 < 384 直接判为不可用（文档：256p 及更低完全失败）
 * 返回 { width, height, changed, error }
 */
export function normalizeSize(width, height) {
  const w = Number(width) || 1344;
  const h = Number(height) || 768;
  const aw = align32(w);
  const ah = align32(h);
  if (Math.min(aw, ah) < 384) {
    return { width: aw, height: ah, changed: aw !== w || ah !== h, error: `分辨率过低（短边 ${Math.min(aw, ah)}px），H3 要求短边至少 384px。` };
  }
  return { width: aw, height: ah, changed: aw !== w || ah !== h };
}
