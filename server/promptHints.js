/**
 * 提示词辅助：按官方 H3 规范为特定模式注入固定格式片段。
 *
 * 1) I2V 家族（fl2va）必须在三字段正文之前多一行「对齐指令」，否则首/尾帧
 *    与目标视频时间轴的对应关系只能靠模型猜，一致性与质量都受影响。
 *    官方三种变体：
 *      只给首帧： For the target video, at 0.00 seconds into the target video,
 *                (from [Shot 1]) is fully referenced.
 *      首尾都给： How the reference pictures align with the target video —
 *                Picture 1 (from Shot 1) aligns with the 0.00-second mark of the
 *                target video; Picture 2 (from Shot 1) aligns with the 8.00-second
 *                mark of the target video.
 *      只给尾帧： How the reference pictures align with the target video —
 *                (from [Shot N]) aligns with the 6.00-second mark of the target video.
 *    时间必须精确到两位小数，且与视频实际时长一致。
 *
 * 2) R2V（ref2va）使用六段式结构与四类标签；这里提供可填空的模板与
 *    「按连接顺序」的标签清单，帮用户把上传素材和标签对应起来。
 */

/** 两位小数、四舍五入（与官方 124 帧=5.17s 的写法一致） */
const two = (sec) => (Math.round(Number(sec) * 100) / 100).toFixed(2);

/** 是否已含对齐指令（避免对同一提示词重复注入） */
export function hasAlignment(prompt) {
  const s = String(prompt || '');
  return /align with the target video/i.test(s) || /is fully referenced/i.test(s);
}

/**
 * 生成 fl2va 的对齐指令行。
 * @param {object} o
 * @param {number} o.imageCount 该段使用的参考帧数（1 或 2）
 * @param {number} o.duration   该段实际时长（秒）
 * @param {boolean} [o.lastOnly] 只有尾帧时为 true（默认按首帧/首尾处理）
 */
export function buildAlignmentLine({ imageCount, duration, lastOnly = false }) {
  const n = Number(imageCount) || 1;
  if (n <= 1 && !lastOnly) {
    return 'For the target video, at 0.00 seconds into the target video, (from [Shot 1]) is fully referenced.';
  }
  if (n <= 1 && lastOnly) {
    return `How the reference pictures align with the target video — (from [Shot N]) aligns with the ${two(duration)}-second mark of the target video.`;
  }
  return (
    'How the reference pictures align with the target video — ' +
    'Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; ' +
    `Picture 2 (from Shot 1) aligns with the ${two(duration)}-second mark of the target video.`
  );
}

/**
 * 为 fl2va 提示词注入对齐指令（已存在则不重复注入）。
 * 注入后与正文之间空一行。
 */
export function injectFl2vaAlignment(prompt, opts) {
  const body = String(prompt ?? '');
  if (hasAlignment(body)) return body;
  const line = buildAlignmentLine(opts);
  return `${line}\n\n${body}`.trim();
}

const typeName = (mimetype = '', filename = '') => {
  if (/^image\//.test(mimetype) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(filename)) return 'Picture';
  if (/^video\//.test(mimetype) || /\.(mp4|mov|webm|mkv)$/i.test(filename)) return 'Video';
  if (/^audio\//.test(mimetype) || /\.(mp3|wav|m4a|aac|flac)$/i.test(filename)) return 'Audio';
  return 'Picture';
};

/**
 * 按「连接顺序」生成标签清单：第 1 个素材 -> Picture 1，第 2 个 -> Video 2 …
 * 编号是素材在整体序列中的位置（官方示例：第一张图 <Picture 1>、第二条视频 <Video 2>）。
 * @param {Array<{mimetype?:string,filename?:string}>} files
 */
export function ref2vaTagList(files = []) {
  return files.map((f, i) => {
    const name = typeName(f.mimetype, f.filename);
    return { order: i + 1, tag: `<${name} ${i + 1}>`, type: name };
  });
}

/**
 * 由「类型序列」生成标签清单，用于线上接口传参：items=['image','video']。
 * 复用 ref2vaTagList 的编号规则（类型名 + 整体序号），并附带 mimetype 便于下游判断。
 */
export function tagsFromTypes(types = []) {
  return ref2vaTagList(
    types.map((t) => ({ mimetype: t.startsWith('video') ? 'video/mp4' : t.startsWith('audio') ? 'audio/mpeg' : 'image/png' })),
  ).map((r) => ({ ...r, mimetype: types[r.order - 1].startsWith('video') ? 'video/mp4' : types[r.order - 1].startsWith('audio') ? 'audio/mpeg' : 'image/png' }));
}

/** R2V 六段式模板（顺序固定） */
export const REF2VA_TEMPLATE = `subject_definitions: 给每个参考内容定义标签与特征，例如 <Subject 1> 是一位穿深色风衣的中年男性，<Picture 2> 是暖色调夜景街道。
summary: [任务类型] 一句话概括你要做什么，例如 [Reference generation] 让 <Subject 1> 在 <Picture 2> 的街道场景中行走。
retention_analysis: 逐标签声明保留程度，例如 <Subject 1> 保留面部与服装，<Picture 2> 仅保留场景构图与色调。
detailed_description: 主体描述，350–500 英文词，写清动作、镜头运动、光线与节奏。
overall_soundscape: 环境音，例如夜雨落在铁皮棚顶的细密声、远处车流。
non_diegetic_music: 配乐，例如一段低回的大提琴，中速，结尾渐弱。

（可选：用 ref_image_size 控制参考图保真度——match 默认更快，max 角色更保真但慢数倍。）`;

export function ref2vaScaffold() {
  return REF2VA_TEMPLATE;
}
