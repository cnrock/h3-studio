// H3 Studio front-end
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const MODE_HINTS = {
  t2va: '仅用文字描述生成视频（可带原生音频）。',
  fl2va: '上传 1 张（首帧）或 2 张（首帧 + 末帧）图片，让画面从该图开始/结束。',
  ref2va: '上传参考图片 / 视频片段（可混合，最多 9 个），模型会参考其主体、风格、动作。',
};

const state = { user: null, mode: 't2va', files: [], poll: null, limits: { promptChars: 20000, maxImageMB: 30, maxVideoMB: 50, maxFiles: 9 } };

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

// ---------- mode ----------
$$('[data-mode]').forEach((btn) => {
  btn.onclick = () => {
    state.mode = btn.dataset.mode;
    $$('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
    $('#modeHint').textContent = MODE_HINTS[state.mode];
    const multi = state.mode === 'ref2va';
    $('#fileInput').multiple = multi;
    $('#fileLabel').textContent = state.mode === 't2va' ? '参考文件（本模式无需上传）' : (multi ? '参考文件（图片/视频，可多选）' : '首帧 / 末帧图片（1–2 张）');
    $('#dropZoneWrap').style.opacity = state.mode === 't2va' ? '.5' : '1';
    $('#fileInput').accept = state.mode === 'ref2va' ? 'image/*,video/*' : 'image/*';
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
    await api('/api/generate', { method: 'POST', body: fd });
    banner($('#genBanner'), '任务已提交，生成完成后会显示在下方。', 'ok');
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
}

function jobCard(j) {
  const el = document.createElement('div');
  el.className = 'job';
  const badge = { queued: '排队中', running: '生成中', done: '已完成', error: '失败' }[j.status] || j.status;
  const queueText =
    j.status === 'queued' && j.queuePosition
      ? `第 ${j.queuePosition} 位（共 ${j.queueLength} 个排队）`
      : '';
  const prog = j.progress ? safeParse(j.progress) : null;
  const progText =
    j.status === 'running' && prog && prog.total > 1
      ? `分段生成中：第 ${prog.current}/${prog.total} 段${prog.stage === 'concat' ? '（正在拼接）' : ''}`
      : '';
  const pending = queueText || progText || '';
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
  $('#fileHint').textContent = `图片 ≤${state.limits.maxImageMB}MB，视频 ≤${state.limits.maxVideoMB}MB`;
  try {
    const cfg = await api('/api/config');
    if (cfg && cfg.limits) state.limits = { ...state.limits, ...cfg.limits };
  } catch { /* 保留默认值 */ }
  updatePromptCount($('#prompt').value.length);
  $('#fileHint').textContent = `图片 ≤${state.limits.maxImageMB}MB，视频 ≤${state.limits.maxVideoMB}MB`;
})();
