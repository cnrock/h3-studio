// H3 Studio front-end
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const MODE_HINTS = {
  t2va: '仅用文字描述生成视频（可带原生音频）。',
  fl2va: '上传 1 张（首帧）或 2 张（首帧 + 末帧）图片，让画面从该图开始/结束。',
  ref2va: '上传参考图片 / 视频片段（可混合，最多 9 个），模型会参考其主体、风格、动作。',
};

const state = { user: null, mode: 't2va', files: [], poll: null, aspectPresets: {}, frameGrid: { fps: 24, step: 17, offset: 5, minFrames: 124, maxFrames: 362 }, ref2vaTemplate: '', limits: { promptChars: 20000, maxImageMB: 30, maxVideoMB: 50, maxFiles: 9, maxRefVideoSec: 15, maxDurationSec: 1800, creditsMode: 'off', creditsPerSecond: 0, creditsPerJob: 0 } };

function banner(el, msg, type = 'err') {
  el.textContent = msg;
  el.className = `banner show ${type}`;
  if (type === 'ok') setTimeout(() => el.classList.remove('show'), 4000);
}
const hide = (el) => el.classList.remove('show');

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'include', ...opts });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : { error: await res.text() };
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

// ---------- auth ----------
$$('[data-auth]').forEach((btn) => {
  btn.onclick = () => {
    $$('[data-auth]').forEach((b) => b.classList.toggle('active', b === btn));
    const which = btn.dataset.auth;
    $('#loginForm').classList.toggle('hidden', which !== 'login');
    $('#registerForm').classList.toggle('hidden', which !== 'register');
    $('#forgotForm').classList.toggle('hidden', which !== 'forgot');
    hide($('#authBanner'));
  };
});

$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const d = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: f.email.value, password: f.password.value }),
    });
    state.user = d.user;
    showApp();
  } catch (err) { banner($('#authBanner'), err.message); }
};

$('#registerForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const d = await api('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: f.email.value, password: f.password.value }),
    });
    if (d.verified) { state.user = d.user; showApp(); }
    else banner($('#authBanner'), d.message || '注册成功，请到邮箱激活', 'ok');
  } catch (err) { banner($('#authBanner'), err.message); }
};

$('#forgotForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const d = await api('/api/auth/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: f.email.value }),
    });
    banner($('#authBanner'), d.message || '如果该邮箱已注册，重置邮件已发送', 'ok');
  } catch (err) { banner($('#authBanner'), err.message); }
};

$('#logoutBtn').onclick = async () => {
  await api('/api/auth/logout', { method: 'POST' });
  state.user = null;
  clearInterval(state.poll);
  $('#appView').classList.add('hidden');
  $('#userbox').style.display = 'none';
  $('#authView').classList.remove('hidden');
};

function showApp() {
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#userbox').style.display = 'flex';
  $('#useremail').textContent = state.user.email;
  loadJobs();
  state.poll = setInterval(loadJobs, 4000);
}

// ---------- resolution <-> aspect ----------
// H3 按「短边 768、面积上限 768×1344、每轴对齐 32」训练；旧版让比例与分辨率各选各的，
// 会出现 9:16 + 1344×768 这种自相矛盾的组合。这里让分辨率跟随比例，全部为合法预设。
function renderResolutions() {
  const ar = $('#aspect').value;
  const sel = $('#resolution');
  const list = state.aspectPresets[ar] || [];
  sel.innerHTML = list.map((p) => `<option value="${p.value}" data-level="${p.level}">${p.label}</option>`).join('');
  // 默认选标准档（短边 768 的原生画布，质量最好）
  const std = list.find((p) => p.level === 'standard') || list[0];
  if (std) sel.value = std.value;
  updateResHint();
}
function updateResHint() {
  const opt = $('#resolution').selectedOptions?.[0];
  const level = opt?.dataset?.level || 'standard';
  const map = {
    preview: '快速预览档，试提示词用。',
    standard: '推荐档：短边 768 原生画布，质量最好。',
    experimental: '⚠️ 2K 远超原生画布，会明显变慢且可能失真，仅供实验。',
  };
  $('#resHint').textContent = map[level] || '';
  $('#resHint').style.color = level === 'experimental' ? 'var(--danger)' : '';
}

// ---------- duration <-> frame grid ----------
// 帧数必须落在 17k+5 网格；否则 H3 会静默向上吸附（填 61 帧得 73 帧，不报错）。
// 本地预演一遍，让用户提交前就看到实际帧数与秒数。
const FPS = 24;
function snapFrames(n) {
  const { step, offset } = state.frameGrid;
  const x = Math.max(1, Math.round(n));
  if ((x - offset) % step === 0) return x;
  return Math.max(offset + step * Math.max(0, Math.ceil((x - offset) / step)), offset);
}
function gridDuration(sec) {
  const { fps, maxFrames } = state.frameGrid;
  const frames = Math.min(snapFrames(sec * fps), maxFrames);
  return { seconds: Math.round((frames / fps) * 10000) / 10000, frames };
}
function updateDurationHint() {
  const cap = state.limits.maxDurationSec || 1800;
  const raw = Number($('#duration').value) || 0;
  const v = Math.min(raw, cap);
  if (v < 4) { $('#durationHint').textContent = raw > cap ? `超过上限 ${cap} 秒，将按 ${cap} 秒生成` : ''; return; }
  const g = gridDuration(v);
  const capped = raw > cap;
  const capNote = `${capped ? `⚠️ 超过上限 ${cap} 秒，将按 ${cap} 秒生成；` : ''}`;
  if (v > 15) {
    // 长视频：分段生成，每段各自吸附；行内提示按【分段】说明，别把总时长当成单段 15.08s
    // 复刻后端 planSegments 的均匀分段（每段 ∈ [4,15]，不丢时长）
    const n0 = Math.max(1, Math.ceil(v / 15));
    const base = Math.floor(v / n0);
    let rem = v - base * n0;
    const segs = [];
    for (let i = 0; i < n0; i++) segs.push(base + (rem-- > 0 ? 1 : 0));
    const gs = segs.map((s) => gridDuration(s));
    const uniform = gs.every((g) => g.frames === gs[0].frames);
    const per = uniform
      ? `${gs[0].frames} 帧 · ${gs[0].seconds.toFixed(2)}s`
      : gs.slice(0, 3).map((g) => `${g.frames} 帧·${g.seconds.toFixed(1)}s`).join('、') + (gs.length > 3 ? '…' : '');
    const totalSec = gs.reduce((a, g) => a + g.seconds, 0);
    $('#durationHint').textContent = `${capNote}将分 ${gs.length} 段生成，每段${uniform ? '' : '约'} ${per}（合计约 ${totalSec.toFixed(0)}s）`;
    $('#durationHint').style.color = capped ? 'var(--danger, #c0392b)' : '';
    return;
  }
  const snapped = Math.abs(g.seconds - v) > 0.001;
  $('#durationHint').textContent = `${capNote}实际：${g.frames} 帧 · ${g.seconds.toFixed(2)}s${snapped ? '（自动吸附到 H3 合法帧网格）' : ''}`;
}

$('#aspect').onchange = renderResolutions;
$('#resolution').onchange = updateResHint;
$('#duration').addEventListener('input', updateDurationHint);

// ---------- ref2va tags ----------
function updateTags() {
  const box = $('#tagList');
  if (!box) return;
  if (!state.files.length) { box.textContent = '（尚未上传素材）'; return; }
  box.innerHTML = state.files
    .map((f, i) => {
      const t = f.type.startsWith('video') ? 'Video' : f.type.startsWith('audio') ? 'Audio' : 'Picture';
      return `<div>第 ${i + 1} 个 → <code>&lt;${t} ${i + 1}&gt;</code> ${escapeHtml(f.name)}</div>`;
    })
    .join('');
}

// ---------- mode ----------
$$('[data-mode]').forEach((btn) => {
  btn.onclick = () => {
    state.mode = btn.dataset.mode;
    $$('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
    $('#modeHint').textContent = MODE_HINTS[state.mode];
    const multi = state.mode === 'ref2va';
    $('#fileInput').multiple = multi;
    $('#fileLabel').textContent = state.mode === 't2va' ? '参考文件（本模式无需上传）' : (multi ? `参考文件（图片/视频，可多选；单个视频 ≤${state.limits.maxRefVideoSec} 秒）` : '首帧 / 末帧图片（1–2 张）');
    $('#dropZoneWrap').style.opacity = state.mode === 't2va' ? '.5' : '1';
    $('#fileInput').accept = state.mode === 'ref2va' ? 'image/*,video/*' : 'image/*';
    // ref2va：展开标签/模板面板
    const panel = $('#ref2vaPanel');
    if (panel) panel.classList.toggle('hidden', state.mode !== 'ref2va');
    if (state.mode === 'ref2va') {
      panel.open = true;
      const btn = $('#insertTemplateBtn');
      btn.onclick = () => {
        const ta = $('#prompt');
        const cur = ta.value.trim();
        ta.value = (cur ? cur + '\n\n' : '') + state.ref2vaTemplate;
        updatePromptCount(ta.value.length);
        banner($('#genBanner'), '已插入 R2V 六段式模板，按提示替换方括号内容即可。', 'ok');
      };
      updateTags();
    }
    state.files = [];
    renderThumbs();
  };
});

// ---------- files ----------
const drop = $('#drop');
drop.onclick = () => $('#fileInput').click();
drop.ondragover = (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; };
drop.ondragleave = () => { drop.style.borderColor = ''; };
drop.ondrop = (e) => { e.preventDefault(); drop.style.borderColor = ''; addFiles(e.dataTransfer.files); };
$('#fileInput').onchange = (e) => addFiles(e.target.files);

function addFiles(list) {
  if (state.mode === 't2va') return;
  const max = state.mode === 'fl2va' ? 2 : 9;
  for (const f of list) {
    if (state.files.length >= max) { banner($('#genBanner'), `最多 ${max} 个文件`); break; }
    state.files.push(f);
  }
  renderThumbs();
  $('#fileInput').value = '';
}

function renderThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  state.files.forEach((f, i) => {
    const url = URL.createObjectURL(f);
    const el = document.createElement('div');
    el.className = 'thumb';
    el.innerHTML = `${f.type.startsWith('video') ? `<video src="${url}" muted></video>` : `<img src="${url}" />`}<button class="x" data-i="${i}">×</button>`;
    box.appendChild(el);
  });
  box.querySelectorAll('.x').forEach((b) => (b.onclick = () => { state.files.splice(+b.dataset.i, 1); renderThumbs(); }));
  if (state.mode === 'ref2va') updateTags();
}

const updatePromptCount = (len) => {
  $('#promptCount').textContent = `${len} / ${state.limits.promptChars}`;
};
$('#prompt').addEventListener('input', (e) => updatePromptCount(e.target.value.length));

// ---------- generate ----------
$('#generateBtn').onclick = async () => {
  hide($('#genBanner'));
  const prompt = $('#prompt').value.trim();
  if (!prompt) return banner($('#genBanner'), '请输入提示词');
  if (state.mode !== 't2va' && state.files.length === 0) {
    return banner($('#genBanner'), state.mode === 'fl2va' ? '请至少上传 1 张图片' : '请至少上传 1 个参考文件');
  }

  // 参考视频时长预检：H3 硬要求每个参考视频 ∈ [2,15] 秒。
  if (state.mode === 'ref2va') {
    const vids = state.files.filter((f) => f.type.startsWith('video'));
    const durs = await Promise.all(vids.map(videoDuration));
    const tooShort = vids.find((f, i) => durs[i] && durs[i] < 2);
    if (tooShort) return banner($('#genBanner'), `参考视频「${tooShort.name}」不足 2 秒，H3 要求每个参考视频至少 2 秒，请换用更长的片段。`);
    const tooLong = vids.filter((f, i) => durs[i] && durs[i] > state.limits.maxRefVideoSec);
    if (tooLong.length) {
      banner($('#genBanner'), `参考视频超过 ${state.limits.maxRefVideoSec} 秒，已自动截取前 ${state.limits.maxRefVideoSec} 秒参与生成：${tooLong.map((f) => f.name).join('、')}`, 'ok');
    }
  }

  const [w, h] = $('#resolution').value.split('x').map(Number);
  const fd = new FormData();
  fd.set('mode', state.mode);
  fd.set('prompt', prompt);
  fd.set('width', w);
  fd.set('height', h);
  fd.set('aspect_ratio', $('#aspect').value);
  fd.set('fps', $('#fps').value);
  fd.set('num_inference_steps', $('#steps').value);
  fd.set('flow_shift', $('#flowShift').value);
  fd.set('duration', $('#duration').value);
  fd.set('audio_flow_shift', $('#audioFlowShift').value);
  if ($('#seed').value) fd.set('seed', $('#seed').value);
  state.files.forEach((f) => fd.append('files', f));

  const btn = $('#generateBtn');
  btn.disabled = true;
  $('#genNote').innerHTML = '<span class="spinner"></span> 已提交，生成中（H3 逐个串行处理，请耐心等待）…';
  try {
    const res = await api('/api/generate', { method: 'POST', body: fd });
    const adj = res?.adjusted;
    const msgs = [];
    if (adj && adj.durationCapped) {
      msgs.push(`⚠️ 你填的 ${adj.requestedDuration} 秒超过上限，已按 ${adj.maxDurationSec} 秒生成（如需更长请调大 MAX_DURATION_SEC）`);
    }
    if (adj && adj.segments > 1) {
      const fs_ = adj.segmentFrames || [];
      const secs = adj.segmentSeconds || [];
      const uniform = fs_.every((v) => v === fs_[0]);
      const per = uniform
        ? `${fs_[0]} 帧 · ${secs[0].toFixed(2)}s`
        : fs_.slice(0, 3).map((v, i) => `${v} 帧·${secs[i].toFixed(1)}s`).join('、') + (fs_.length > 3 ? '…' : '');
      msgs.push(`将分 ${adj.segments} 段生成，每段${uniform ? '' : '约'} ${per}，合计约 ${(adj.totalDuration || 0).toFixed(0)}s`);
    } else if (adj && adj.durationSnapped) {
      msgs.push(`时长已吸附到 H3 合法帧网格：${adj.snappedFrames} 帧 · ${adj.snappedSeconds.toFixed(2)}s`);
    }
    banner($('#genBanner'), `任务已提交${msgs.length ? '。' + msgs.join('；') : ''}。生成完成后显示在下方。`, msgs.length ? 'err' : 'ok');
    loadJobs();
  } catch (err) {
    banner($('#genBanner'), err.message);
  } finally {
    btn.disabled = false;
    $('#genNote').textContent = '';
  }
};

// ---------- jobs ----------
$('#refreshBtn').onclick = loadJobs;

async function loadJobs() {
  try {
    const { jobs } = await api('/api/jobs');
    const box = $('#jobs');
    $('#jobsEmpty').style.display = jobs.length ? 'none' : 'block';
    box.innerHTML = '';
    for (const j of jobs) box.appendChild(jobCard(j));
  } catch { /* ignore transient */ }
  try {
    const { stats } = await api('/api/stats');
    renderStats(stats);
  } catch { /* ignore transient */ }
}

/** 把毫秒格式化成人类可读：45.2s / 3.4 分钟 / 1 小时 12 分 */
function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${Math.round(m - h * 60)} 分`;
}
const fmtClock = (ts) => (ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—');

function renderStats(stats) {
  const box = $('#stats');
  if (!box || !stats) return;
  const mode = stats.creditsMode || 'off';
  const billing = mode === 'second' ? `按秒 ${stats.creditsPerSecond}/秒` : mode === 'job' ? `按条 ${stats.creditsPerJob}/条` : '未开启';
  const showCredits = mode !== 'off';
  const t = stats.today || {};
  const a = stats.all || {};
  // 行式：左标签、右数值；每组自带标题，杜绝「今日/累计」错位
  const row = (label, value, sub = '') =>
    `<div class="stat-row"><span class="k">${label}</span><span class="vv"><span class="v">${value}</span>${sub ? ` <span class="sub">${sub}</span>` : ''}</span></div>`;
  const group = (title, s) => `
    <div class="stats-group">
      <div class="stats-group-title">${title}</div>
      ${row('生成', `${s.done || 0} 条`, s.failed ? `失败 ${s.failed}` : '')}
      ${row('成片', `${(s.videoSeconds || 0).toFixed(0)} 秒`)}
      ${row('卡时', `${(s.genMinutes || 0).toFixed(1)} 分`, showCredits && s.credits ? `≈ ${s.credits} 点` : '')}
      ${row('总耗时', `${(s.totalMinutes || 0).toFixed(1)} 分`, s.waitMinutes ? `含排队 ${s.waitMinutes.toFixed(1)} 分` : '')}
    </div>`;
  box.innerHTML = `
    <div class="stats-cols">
      ${group('今日', t)}
      ${group('累计', a)}
    </div>
    <div class="stats-note">卡时 = 真正占用 GPU 的生成时长（不含排队）；总耗时 = 提交到完成。计费：${billing}。统计自 v1.8 起启用，更早的作品无时长数据。</div>`;
}

function jobCard(j) {
  const el = document.createElement('div');
  el.className = 'job';
  const badge = { queued: '排队中', running: '生成中', done: '已完成', error: '失败' }[j.status] || j.status;
  const queueText =
    j.status === 'queued' && j.queuePosition
      ? `第 ${j.queuePosition} 位（共 ${j.queueLength} 个排队）${j.stats?.etaMs ? ` · 预计等待约 ${fmtMs(j.stats.etaMs)}` : ''}`
      : '';
  const prog = j.progress ? safeParse(j.progress) : null;
  const progText =
    j.status === 'running' && prog && prog.total > 1
      ? `分段生成中：第 ${prog.current}/${prog.total} 段${prog.stage === 'concat' ? '（正在拼接）' : ''}`
      : '';
  const pending = queueText || progText || '';
  // 时序统计：提交时间 / 开始时间 / 完成时间 / 排队等待 / 生成耗时 / 总计
  const st = j.stats || {};
  const timing = [];
  if (st.submittedAt) timing.push(`提交 ${fmtClock(st.submittedAt)}`);
  if (st.waitMs) timing.push(`排队 ${fmtMs(st.waitMs)}`);
  if (j.status === 'running' && st.genMs) timing.push(`已生成 ${fmtMs(st.genMs)}`);
  if (j.status === 'done' || j.status === 'error') {
    if (st.finishedAt) timing.push(`完成 ${fmtClock(st.finishedAt)}`);
    if (st.genMs) timing.push(`生成 ${fmtMs(st.genMs)}`);
    if (st.totalMs) timing.push(`共 ${fmtMs(st.totalMs)}`);
  }
  const timingText = timing.length ? timing.join(' · ') : '';
  const media =
    j.status === 'done' && j.videoUrl
      ? `<video src="${j.videoUrl}" controls preload="metadata"></video>`
      : `<div style="aspect-ratio:16/9;display:grid;place-items:center;background:var(--panel-2);color:var(--muted);font-size:13px;text-align:center;padding:10px">
           ${j.status === 'error' ? '生成失败' : `<div><span class="spinner"></span>${pending ? '<br>' + pending : ''}</div>`}
         </div>`;
  el.innerHTML = `
    ${media}
    <div class="body">
      <span class="badge ${j.status}">${badge}</span>
      <div class="prompt">${escapeHtml(j.prompt)}</div>
      <div class="muted">${j.mode} · ${j.params?.duration || '?'}s${j.bytes ? ' · ' + (j.bytes / 1048576).toFixed(1) + ' MB' : ''}</div>
      ${timingText ? `<div class="muted" style="font-size:12px">${escapeHtml(timingText)}</div>` : ''}
      ${st.credits ? `<div class="muted" style="font-size:12px">消耗 ${st.credits} 点</div>` : ''}
      ${j.error ? `<div class="muted" style="color:var(--danger)">${escapeHtml(j.error)}</div>` : ''}
      <div class="actions" style="margin-top:auto">
        ${j.videoUrl ? `<a href="${j.downloadUrl}" download><button class="ghost">下载</button></a>` : ''}
        ${j.status === 'error' ? `<button class="ghost" data-regen="${j.id}">重新生成</button>` : ''}
        <button class="danger" data-del="${j.id}">删除</button>
      </div>
    </div>`;
  el.querySelector('[data-del]').onclick = async () => {
    if (!confirm('确定删除这个作品？')) return;
    await api(`/api/jobs/${j.id}`, { method: 'DELETE' });
    loadJobs();
  };
  const regenBtn = el.querySelector('[data-regen]');
  if (regenBtn) {
    regenBtn.onclick = async () => {
      regenBtn.disabled = true;
      regenBtn.textContent = '提交中…';
      try {
        await api(`/api/jobs/${j.id}/regenerate`, { method: 'POST' });
        loadJobs();
      } catch (err) {
        alert(err.message || '重新生成失败');
        regenBtn.disabled = false;
        regenBtn.textContent = '重新生成';
      }
    };
  }
  return el;
}

const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** 读取本地视频文件的时长（秒）；失败返回 null（不阻断提交） */
function videoDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { resolve(Number.isFinite(v.duration) ? v.duration : null); URL.revokeObjectURL(url); };
    v.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
    v.src = url;
  });
}

const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- boot ----------
(async () => {
  try {
    const { user } = await api('/api/auth/me');
    state.user = user;
    showApp();
  } catch {
    $('#authView').classList.remove('hidden');
  }
  $('#modeHint').textContent = MODE_HINTS.t2va;
  const hint = () => { $('#fileHint').textContent = `图片 ≤${state.limits.maxImageMB}MB，视频 ≤${state.limits.maxVideoMB}MB（参考视频单个 ≤${state.limits.maxRefVideoSec} 秒，超长自动截取）`; };
  hint();
  try {
    const cfg = await api('/api/config');
    if (cfg && cfg.limits) state.limits = { ...state.limits, ...cfg.limits };
    if (cfg && cfg.aspectPresets) state.aspectPresets = cfg.aspectPresets;
    if (cfg && cfg.frameGrid) state.frameGrid = { ...state.frameGrid, ...cfg.frameGrid };
  } catch { /* 保留默认值 */ }
  // 时长上限以服务端为准，避免 UI 填得进去、后端却静默截断
  {
    const cap = state.limits.maxDurationSec || 1800;
    $('#duration').max = String(cap);
    $('#durationLabel').textContent = `时长（秒，可超 15 秒自动分段续写，上限 ${cap}）`;
  }
  if (Object.keys(state.aspectPresets).length) renderResolutions();
  // 拉取 R2V 六段式模板（无需登录也能拿到，失败则保留默认文案）
  try {
    const t = await api('/api/prompt/ref2va?items=');
    if (t && t.template) state.ref2vaTemplate = t.template;
  } catch { /* 忽略 */ }
  updatePromptCount($('#prompt').value.length);
  updateDurationHint();
  hint();
})();
