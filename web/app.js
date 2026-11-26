// Brain web app — runs on the iPhone (installed to the home screen) and on the Mac (Safari → Add to Dock).
import { createDrafts } from './drafts.js';

// Renamed from Felipe (0.15): what this device kept under the old name moves over once
// (pairing, drafts, the open conversation), and the old file cache goes.
try {
  for (const storage of [localStorage, sessionStorage]) {
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (!key?.startsWith('felipe.')) continue;
      const renamed = `brain.${key.slice('felipe.'.length)}`;
      if (storage.getItem(renamed) === null) storage.setItem(renamed, storage.getItem(key));
      storage.removeItem(key);
    }
  }
  caches?.delete('felipe-files');
} catch { /* storage unavailable */ }

const drafts = createDrafts(localStorage);
const $ = (sel) => document.querySelector(sel);

const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICONS = {
  trash: `<svg ${ICON_ATTRS}><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/></svg>`,
  pencil: `<svg ${ICON_ATTRS}><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>`,
  check: `<svg ${ICON_ATTRS}><path d="M20 6 9 17l-5-5"/></svg>`,
  pin: `<svg ${ICON_ATTRS}><path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z"/><path d="M12 14v6"/></svg>`,
  more: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>`,
};

// ---------------- dialogs (instead of the browser's English confirm/alert) ----------------
/** Asks in Brain's own style. Resolves true when confirmed. */
function confirmDialog({ title, message = '', confirm = 'אישור', cancel = 'ביטול', danger = false }) {
  return new Promise((resolve) => {
    const d = document.getElementById('dialog');
    d.querySelector('h2').textContent = title;
    d.querySelector('p').textContent = message;
    d.querySelector('p').hidden = !message;
    const ok = d.querySelector('.dialog-ok');
    const no = d.querySelector('.dialog-cancel');
    ok.textContent = confirm;
    ok.classList.toggle('danger', danger);
    no.textContent = cancel;
    no.hidden = !cancel;
    const done = (v) => {
      d.hidden = true;
      ok.onclick = no.onclick = d.querySelector('.dialog-backdrop').onclick = document.onkeydown = null;
      resolve(v);
    };
    ok.onclick = () => done(true);
    no.onclick = d.querySelector('.dialog-backdrop').onclick = () => done(false);
    document.onkeydown = (e) => e.key === 'Escape' && done(false);
    d.hidden = false;
    ok.focus();
  });
}
const notify = (message) => confirmDialog({ title: message, confirm: 'הבנתי', cancel: '' });

const store = {
  get token() { return localStorage.getItem('brain.token'); },
  set token(v) { v ? localStorage.setItem('brain.token', v) : localStorage.removeItem('brain.token'); },
  get lastSeen() { return Number(localStorage.getItem('brain.lastSeen')) || 0; },
  set lastSeen(v) { localStorage.setItem('brain.lastSeen', String(v)); },
  get conversationId() { return (sessionStorage.getItem('brain.conversation') ?? localStorage.getItem('brain.lastConversation')) || null; },
  set conversationId(v) {
    sessionStorage.setItem('brain.conversation', v || '');
    if (v) localStorage.setItem('brain.lastConversation', v);
    else localStorage.removeItem('brain.lastConversation');
  },
};

const state = { online: null, ollama: null, status: null, streaming: null, engine: 'local' };

// ---------------- API ----------------
class Unauthorized extends Error {}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(store.token ? { authorization: `Bearer ${store.token}` } : {}),
      ...options.headers,
    },
  });
  if (res.status === 401 && path !== '/api/pair') throw new Unauthorized();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `שגיאה ${res.status}`), { status: res.status });
  }
  return res;
}

function handleUnauthorized(err) {
  if (err instanceof Unauthorized) {
    store.token = null;
    showPair('המכשיר נותק. צריך לצמד אותו מחדש.');
    return true;
  }
  return false;
}

// ---------------- formatting ----------------
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// File paths (~/Desktop/a.pdf, Desktop/CV/x.html) and URLs: kept left-to-right inside Hebrew lines.
// Only runs that look like a path (Latin letters, or starting with ~/ or /), so "חום/שיעול" stays as is.
const LTR_RUN = /((?:https?:\/\/|~\/|\/)?[\p{L}\p{N}_.\-~@%+]+(?:\/[\p{L}\p{N}_.\-~@%+]+)+\/?)/gu;
const isPathLike = (run) => /^(~\/|\/|https?:)/.test(run) || /[A-Za-z]/.test(run);

function inline(text) {
  // Inline code first; the rest gets path isolation and bold.
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) =>
      i % 2 === 1
        ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
        : escapeHtml(part)
            .replace(LTR_RUN, (run) => (isPathLike(run) ? `<bdi class="ltr" dir="ltr">${run}</bdi>` : run))
            .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>'),
    )
    .join('');
}

/** Minimal, safe markdown: paragraphs, lists, code blocks, bold, inline code. */
function renderMarkdown(text) {
  const parts = text.split(/```[^\n]*\n?/);
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      html += `<pre><code>${escapeHtml(part.replace(/\n$/, ''))}</code></pre>`;
      return;
    }
    // A list may follow a line of text with no blank line between ("**שישי**" then "- בוקר…"):
    // each block is split into runs of text, bullets and numbered items.
    const UL = /^\s*[-*•]\s+/;
    const OL = /^\s*\d+[.)]\s+/;
    const kindOf = (l) => (UL.test(l) ? 'ul' : OL.test(l) ? 'ol' : 'p');
    for (const block of part.split(/\n{2,}/)) {
      const lines = block.split('\n').filter((l) => l.trim());
      for (let i = 0; i < lines.length; ) {
        const kind = kindOf(lines[i]);
        const run = [];
        while (i < lines.length && kindOf(lines[i]) === kind) run.push(lines[i++]);
        if (kind === 'p') html += `<p>${run.map((l) => inline(l.replace(/^#{1,6}\s+/, ''))).join('<br>')}</p>`;
        else html += `<${kind}>${run.map((l) => `<li>${inline(l.replace(kind === 'ul' ? UL : OL, ''))}</li>`).join('')}</${kind}>`;
      }
    }
  });
  return html;
}

const timeFmt = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short' });
function when(ts) {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? timeFmt.format(d) : dayFmt.format(d);
}

// ---------------- screens ----------------
function showPair(message) {
  detachStream();
  drafts.clear();
  // Files kept on this phone belong to the paired device: gone with the pairing.
  try { caches.delete('brain-files'); } catch { /* no Cache Storage */ }
  store.conversationId = null;
  input.value = '';
  updateInputSize();
  $('#draft-warning').hidden = true;
  $('#chat-screen').hidden = true;
  $('#pair-screen').hidden = false;
  $('#pair-error').hidden = !message;
  $('#pair-error').textContent = message || '';
  $('#startup').hidden = true;
  for (const panel of document.querySelectorAll('.sheet,.drawer,.dialog')) panel.hidden = true;
  machineSnapshot = null;
  $('#machine-metrics').hidden = true;
  $('#machine-name').textContent = 'המק שלי';
  $('#machine-apps').replaceChildren();
  $('#machine-time').textContent = '';
  $('#pair-code').focus();
}

/** Tells the Mac to get the model ready while the user is still typing (see /api/warm). */
function warm() {
  if (!store.token || state.streaming) return;
  api('/api/warm', { method: 'POST', body: JSON.stringify({ newConversation: !store.conversationId }) }).catch(() => {});
}

async function showChat() {
  $('#pair-screen').hidden = true;
  $('#chat-screen').hidden = false;
  $('#startup').hidden = true;
  restoreDraft();
  if (!navigator.onLine) { state.online = false; renderStatus(); return; }
  warm();
  remindGoogleRenewal();
  void syncPush();
  const restore = store.conversationId;
  await Promise.all([
    refreshStatus(),
    restore && !state.streaming ? openConversation(restore) : Promise.resolve(),
  ]);
}

async function refreshStatus() {
  try {
    const res = await api('/api/status', { signal: AbortSignal.timeout(4500) });
    state.status = await res.json();
    state.ollama = state.status.ollama.ok;
    markOnline();
    renderStatus();
    if (!store.conversationId && !state.engineTouched) state.engine = defaultEngine();
    renderEngineChip();
  } catch (err) {
    if (!handleUnauthorized(err)) { state.online = false; renderStatus(); }
  }
}

// ---------------- Mac status ----------------
let healthFailures = 0;
let lastSeenWrite = 0;

function markOnline() {
  healthFailures = 0;
  if (Date.now() - lastSeenWrite > 15_000) {
    lastSeenWrite = Date.now();
    store.lastSeen = lastSeenWrite;
  }
  if (state.online !== true) {
    state.online = true;
    renderStatus();
  }
}

async function checkHealth() {
  let health = null;
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (res.ok) health = await res.json();
  } catch {
    health = null;
  }
  if (health) {
    const reconnect = state.online === false;
    state.ollama = health.ollama;
    markOnline();
    renderStatus();
    if (reconnect) void showChat();
    return;
  }
  // A reply that is still streaming proves the Mac is up; one slow check is not an outage.
  healthFailures++;
  if (state.streaming || (healthFailures < 2 && state.online !== null)) return;
  state.online = false;
  renderStatus();
}

function renderStatus() {
  const el = $('#mac-status');
  const text = $('#mac-status-text');
  const banner = $('#offline-banner');
  $('#retry-mac').hidden = state.online !== false;
  el.classList.remove('online', 'offline', 'warn');
  banner.classList.remove('warn');

  if (state.online === false) {
    if (!machineSheet.hidden) {
      $('#machine-state').textContent = 'המק לא זמין. רענן אחרי שהחיבור יחזור.';
      $('#machine-apps').replaceChildren();
      if (machineSnapshot) $('#machine-time').textContent = 'נתונים אחרונים · ' + when(machineSnapshot.sampledAt);
    }
    el.classList.add('offline');
    text.textContent = 'המק לא זמין';
    const since = store.lastSeen ? ` מאז ${when(store.lastSeen)}` : '';
    $('#offline-message').textContent = `המק לא זמין${since}. ייתכן שהוא ישן, כבוי או מנותק מהאינטרנט. ההיסטוריה תחזור כשהוא יתחבר.`;
    banner.hidden = false;
  } else if (state.online && state.ollama === false) {
    el.classList.add('warn');
    text.textContent = 'המק מחובר · Ollama כבוי';
    banner.classList.add('warn');
    $('#offline-message').textContent = 'המק מחובר, אבל Ollama לא רץ. פתח את אפליקציית Ollama במק.';
    banner.hidden = false;
  } else if (state.online) {
    el.classList.add('online');
    // The model that answers this conversation: in the cloud, the cloud's (the Mac still runs the tools).
    const cloud = state.engine === 'cloud' && state.status?.cloud?.ready ? state.status.cloud.modelName : null;
    const model = state.status?.localModel;
    text.textContent = cloud ? `המק מחובר · ענן · ${cloud}` : model ? `המק מחובר · מקומי · ${model}` : 'המק מחובר';
    if (state.status && !state.status.ollama.modelInstalled) {
      el.classList.replace('online', 'warn');
      banner.classList.add('warn');
      $('#offline-message').textContent = `המודל ${model} לא מותקן. במק: ollama pull ${model}`;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }
  updateComposer();
}

// ---------------- messages ----------------
const STATUS_TEXT = {
  pending: '',
  approved: 'מבצע…',
  done: 'בוצע ✓',
  failed: 'נכשל',
  rejected: 'בוטל',
  expired: 'לא אושר בזמן ולא בוצע',
};

function clearMessages() {
  $('#messages').replaceChildren($('#empty'));
  $('#empty').hidden = false;
}

function addUserMessage(content, attachments = []) {
  $('#empty').hidden = true;
  const el = document.createElement('div');
  el.className = 'msg user';
  if (attachments.length) {
    const box = el$('div', 'user-attachments');
    for (const a of attachments) box.append(a.kind === 'image' ? userPhoto(a) : userFile(a));
    el.append(box);
  }
  if (content) el.append(document.createTextNode(content));
  $('#messages').append(el);
  scrollToBottom();
  return el;
}

/** A photo in a message: from the phone's own copy while sending, later from the Mac (and then kept on the phone). */
function userPhoto(a) {
  const b = el$('button', 'user-photo');
  b.type = 'button';
  b.setAttribute('aria-label', `תמונה: ${a.name}`);
  const img = el$('img');
  img.alt = '';
  b.append(img);
  if (a.previewUrl) img.src = a.previewUrl;
  else void uploadBlob(a).then((blob) => { img.src = URL.createObjectURL(blob); }).catch(() => { img.alt = 'התמונה לא נטענה'; });
  b.addEventListener('click', () => openSentFile({ ...a, upload: true }));
  return b;
}
function userFile(a) {
  const b = el$('button', 'user-file', `${FILE_ICONS[a.name.split('.').pop().toLowerCase()] || '📄'} ${a.name}`);
  b.type = 'button';
  b.addEventListener('click', () => openSentFile({ ...a, upload: true }));
  return b;
}

function addAssistantMessage({ content = '', model, engine, thinking, error } = {}) {
  $('#empty').hidden = true;
  const el = document.createElement('div');
  el.className = `msg assistant${error ? ' error' : ''}`;
  const chips = document.createElement('div');
  chips.className = 'tool-chips';
  chips.hidden = true;
  const attachments = document.createElement('div');
  attachments.className = 'attachments';
  attachments.hidden = true;
  const body = document.createElement('div');
  body.className = 'body';
  body.innerHTML = renderMarkdown(content);
  const meta = document.createElement('div');
  meta.className = 'meta';
  el.append(chips, attachments, body, meta);
  setMeta(el, { model, engine, thinking });
  $('#messages').append(el);
  scrollToBottom();
  return el;
}

function addToolChip(el, { label, chip: text, ok, error }) {
  const chips = el.querySelector('.tool-chips');
  const chip = document.createElement('span');
  chip.className = `tool-chip${ok ? '' : ' failed'}`;
  const base = text || `🔧 ${label}`;
  chip.textContent = ok ? base : `${base} · נכשל${error ? `: ${error}` : ''}`;
  chips.append(chip);
  chips.hidden = false;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
}

const FILE_ICONS = { pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', csv: '📗', jpg: '🖼', jpeg: '🖼', png: '🖼', heic: '🖼', mp3: '🎵', m4a: '🎵', mp4: '🎬', mov: '🎬', zip: '🗜' };

function addAttachment(el, att) {
  const box = el.querySelector('.attachments');
  const a = document.createElement('a');
  a.className = 'file-card';
  a.href = att.url;
  a.target = '_blank';
  a.rel = 'noopener';
  const ext = att.name.split('.').pop().toLowerCase();
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = FILE_ICONS[ext] || '📄';
  const info = document.createElement('span');
  info.className = 'info';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = att.name;
  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = `${formatSize(att.size)} · הקישור תקף 15 דקות`;
  info.append(name, size);
  const open = document.createElement('span');
  open.className = 'open-label';
  open.textContent = 'פתיחה';
  a.append(icon, info, open);
  box.append(a);
  box.hidden = false;
}

// ---------------- what tools show (mail lists, events, folders, files) ----------------
const el$ = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const shortWhen = (ms) => new Date(ms).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });

/** A tool result the app shows by itself (kept with the conversation), so the model doesn't have to copy it. */
function addDisplay(el, d) {
  if (!el || !d) return;
  const box = el.querySelector('.attachments');
  if (d.kind === 'photo') {
    const card = el$('button', 'photo-card');
    card.type = 'button';
    const img = el$('img');
    img.alt = 'תמונה מהמצלמה של המק';
    void uploadBlob(d).then((blob) => { img.src = URL.createObjectURL(blob); }).catch(() => { img.alt = 'התמונה לא נטענה (המק לא זמין?)'; });
    card.append(img, el$('span', null, '📷 מהמצלמה של המק'));
    card.addEventListener('click', () => openSentFile({ ...d, name: d.name || 'מצלמת המק.jpg', upload: true }));
    box.append(card);
    box.hidden = false;
  } else if (d.kind === 'file') {
    box.append(fileCard(d));
  } else if (d.kind === 'mail' || d.kind === 'events' || d.kind === 'folder') {
    const card = el$('details', `data-card ${d.kind}`);
    const items = d.items || [];
    const title =
      d.kind === 'mail' ? `📧 ${items.length} מיילים` :
      d.kind === 'events' ? `📅 ${d.range || 'היומן'} · ${items.length} אירועים` :
      `📂 ${d.folder} · ${d.total ?? items.length} פריטים`;
    const summary = el$('summary', null, title);
    card.append(summary);
    const list = el$('ul', 'data-list');
    for (const it of items.slice(0, 60)) {
      const li = el$('li');
      if (d.kind === 'mail') {
        const top = el$('div', 'row-top');
        top.append(el$('span', `who${it.unread ? ' unread' : ''}`, `${it.unread ? '● ' : ''}${it.from}`), el$('span', 'when', it.date));
        li.append(top, el$('div', 'subject', it.subject || '(בלי נושא)'));
        if (it.snippet) li.append(el$('div', 'snippet', it.snippet));
        if (it.account) li.append(el$('div', 'tag', it.account));
      } else if (d.kind === 'events') {
        const top = el$('div', 'row-top');
        // "09:30–09:45" inside right-to-left text would show reversed: the range keeps left-to-right.
        const when = el$('span', 'when', `${it.day} · `);
        const range = el$('bdi', null, it.when);
        range.dir = 'ltr';
        when.append(range);
        top.append(el$('span', 'who', it.title), when);
        li.append(top);
        const more = [it.location, it.calendar].filter(Boolean).join(' · ');
        if (more) li.append(el$('div', 'snippet', more));
      } else {
        const top = el$('div', 'row-top');
        top.append(el$('span', 'who', `${it.isDir ? '📁' : '📄'} ${it.name}`), el$('span', 'when', it.isDir ? shortWhen(it.modified) : `${formatSize(it.size)} · ${shortWhen(it.modified)}`));
        li.append(top);
      }
      list.append(li);
    }
    card.append(list);
    card.open = items.length > 0 && items.length <= 12;
    box.append(card);
  }
  box.hidden = false;
}

function fileCard(d) {
  const a = el$('button', 'file-card');
  a.type = 'button';
  const ext = d.name.split('.').pop().toLowerCase();
  const info = el$('span', 'info');
  info.append(el$('span', 'name', d.name), el$('span', 'size', `${formatSize(d.size)} · נשמר בשיחה`));
  a.append(el$('span', 'icon', FILE_ICONS[ext] || '📄'), info, el$('span', 'open-label', 'פתיחה'));
  a.addEventListener('click', () => openSentFile(d));
  return a;
}

const FILE_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', heic: 'image/heic', txt: 'text/plain', csv: 'text/csv', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime' };

/** A photo or file sent from the phone (or from the Mac's camera), kept on the phone once opened. */
function uploadBlob(a) {
  return sentFileBlob({ ...a, upload: true });
}

/** Files opened once stay on the phone (Cache Storage), so they open again even when the Mac is away. */
async function sentFileBlob(d) {
  const key = d.upload ? `/upload/${d.id}` : `/sent-copy/${d.id}`;
  let cache = null;
  try {
    cache = await caches.open('brain-files');
    const hit = await cache.match(key);
    if (hit) return await hit.blob();
  } catch { /* no cache in this browser */ }
  const res = await api(d.upload ? `/api/uploads/${d.id}` : `/api/sent/${d.id}`, { signal: AbortSignal.timeout(60000) });
  const blob = await res.blob();
  try {
    await cache?.put(key, new Response(blob, { headers: { 'content-type': blob.type || 'application/octet-stream' } }));
  } catch { /* full: fine, it opens from the Mac next time */ }
  return blob;
}

let viewerUrl = null;
async function openSentFile(d) {
  const viewer = $('#file-viewer');
  const body = $('#file-viewer-body');
  $('#file-viewer-name').textContent = d.name;
  body.replaceChildren(el$('p', 'hint', 'טוען…'));
  viewer.hidden = false;
  let blob;
  try {
    blob = await sentFileBlob(d);
  } catch (err) {
    if (handleUnauthorized(err)) return;
    body.replaceChildren(el$('p', 'hint', err.message || 'לא הצלחתי לפתוח את הקובץ.'));
    return;
  }
  const ext = d.name.split('.').pop().toLowerCase();
  const type = FILE_TYPES[ext] || blob.type || 'application/octet-stream';
  const typed = blob.type === type ? blob : new Blob([blob], { type });
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(typed);
  viewer.dataset.name = d.name;
  viewer._file = typed;
  let view;
  if (type.startsWith('image/')) {
    view = el$('img');
    view.src = viewerUrl;
    view.alt = d.name;
  } else if (type === 'application/pdf') {
    if (d.upload) {
      view = el$('iframe');
      view.src = viewerUrl;
      view.title = d.name;
    } else view = await pdfPagesView(d);
  } else if (type.startsWith('text/')) {
    view = el$('pre', null, (await typed.text()).slice(0, 200000));
    view.dir = 'auto';
  } else if (type.startsWith('video/') || type.startsWith('audio/')) {
    view = el$(type.startsWith('video/') ? 'video' : 'audio');
    view.src = viewerUrl;
    view.controls = true;
  } else {
    view = el$('p', 'hint', 'אין תצוגה מקדימה לסוג הקובץ הזה. אפשר לשמור אותו או לפתוח באפליקציה אחרת בכפתור "שיתוף".');
  }
  body.replaceChildren(view);
}

/**
 * A PDF inside an iPhone app shows only its first page. So the Mac draws each page as a picture,
 * loaded as you scroll and kept on the phone. If that can't be done, the PDF itself is shown.
 */
let pageUrls = [];
async function pdfPagesView(d) {
  let cache = null;
  try { cache = await caches.open('brain-files'); } catch { /* no Cache Storage */ }
  const metaKey = `/sent-copy/${d.id}/pdf.json`;
  let pages = 0;
  try {
    const hit = await cache?.match(metaKey);
    if (hit) pages = (await hit.json()).pages;
  } catch { /* read it again */ }
  if (!pages) {
    try {
      pages = (await (await api(`/api/sent/${d.id}/pdf`, { signal: AbortSignal.timeout(30000) })).json()).pages;
      await cache?.put(metaKey, new Response(JSON.stringify({ pages }), { headers: { 'content-type': 'application/json' } }));
    } catch {
      pages = 0;
    }
  }
  if (!pages) {
    const frame = el$('iframe');
    frame.src = viewerUrl;
    frame.title = d.name;
    return frame;
  }
  const wrap = el$('div', 'pdf-pages');
  const load = async (img) => {
    const key = `/sent-copy/${d.id}/page/${img.dataset.n}`;
    let blob = null;
    try {
      const hit = await cache?.match(key);
      if (hit) blob = await hit.blob();
    } catch { /* fetch it */ }
    if (!blob) {
      try {
        blob = await (await api(`/api/sent/${d.id}/pdf/${img.dataset.n}`, { signal: AbortSignal.timeout(30000) })).blob();
        await cache?.put(key, new Response(blob, { headers: { 'content-type': 'image/jpeg' } })).catch(() => {});
      } catch {
        img.alt = `עמוד ${Number(img.dataset.n) + 1} לא נטען (המק לא זמין?)`;
        img.classList.add('failed');
        return;
      }
    }
    const url = URL.createObjectURL(blob);
    pageUrls.push(url);
    img.onload = () => img.classList.add('loaded');
    img.src = url;
  };
  const watch = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      watch.unobserve(e.target);
      load(e.target);
    }
  }, { root: $('#file-viewer-body'), rootMargin: '1200px 0px' });
  for (let i = 0; i < pages; i++) {
    const img = el$('img', 'pdf-page');
    img.alt = `עמוד ${i + 1}`;
    img.dataset.n = String(i);
    wrap.append(img);
    watch.observe(img);
  }
  wrap.append(el$('p', 'hint', `${pages} עמודים`));
  return wrap;
}

function closeViewer() {
  $('#file-viewer').hidden = true;
  $('#file-viewer-body').replaceChildren();
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = null;
  for (const u of pageUrls) URL.revokeObjectURL(u);
  pageUrls = [];
}

async function shareViewerFile() {
  const viewer = $('#file-viewer');
  const blob = viewer._file;
  if (!blob) return;
  const file = new File([blob], viewer.dataset.name || 'file', { type: blob.type });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }
  // No share sheet (a computer browser): download it.
  const a = el$('a');
  a.href = viewerUrl;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
}

function setMeta(el, { model, engine, thinking, tokensPerSecond, totalMs, note }) {
  const meta = el.querySelector('.meta');
  if (!meta) return;
  meta.replaceChildren();
  if (model) {
    const b = document.createElement('span');
    b.className = `badge ${engine === 'cloud' ? 'cloud' : 'local'}`;
    b.textContent = `${engine === 'cloud' ? 'ענן' : 'מקומי'} · ${model}`;
    meta.append(b);
  }
  if (thinking) {
    const t = document.createElement('span');
    t.className = 'badge thinking';
    t.textContent = 'חשיבה';
    meta.append(t);
  }
  if (totalMs || tokensPerSecond) {
    const s = document.createElement('span');
    const parts = [];
    if (totalMs) parts.push(`${(totalMs / 1000).toFixed(1)} שנ׳`);
    if (tokensPerSecond) parts.push(`${tokensPerSecond} טוקנים/שנייה`);
    s.textContent = parts.join(' · ');
    meta.append(s);
  }
  if (note) {
    const n = document.createElement('span');
    n.textContent = note;
    meta.append(n);
  }
}

let restoringMessages = false;
function scrollToBottom() {
  if (restoringMessages) return;
  const m = $('#messages');
  m.scrollTop = m.scrollHeight;
}
const nearBottom = () => {
  const m = $('#messages');
  return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
};

// ---------------- keyboard and visible area ----------------
const composerInput = $('#input');
const messageList = $('#messages');
const viewport = window.visualViewport;
const iosHome = navigator.standalone === true ||
  (matchMedia('(display-mode: standalone)').matches && /iPhone|iPad|iPod/.test(navigator.userAgent));

// WebKit may start its native reveal before mousedown. During the first short
// tap, keep a visual copy in place and focus the real editor near the header.
// Restore it when the viewport has started shrinking. A hardware keyboard,
// cancelled focus or backgrounding must also restore the editor.
if (iosHome) {
  let touch = null;
  let mirror = null;
  let timer = 0;
  let initialHeight = 0;
  function restoreEditor() {
    clearTimeout(timer);
    mirror?.remove();
    mirror = null;
    composerInput.classList.remove('focus-staging');
    composerInput.style.removeProperty('--focus-shift');
  }
  function afterResize() {
    if (mirror && (viewport?.height ?? innerHeight) < initialHeight - 60) requestAnimationFrame(restoreEditor);
  }
  viewport?.addEventListener('resize', afterResize);
  window.addEventListener('resize', afterResize);
  window.addEventListener('pagehide', restoreEditor);
  composerInput.addEventListener('blur', restoreEditor);
  composerInput.addEventListener('input', restoreEditor);
  composerInput.addEventListener('touchstart', event => {
    const t = event.touches[0];
    touch = event.touches.length === 1 ? { x:t.clientX, y:t.clientY, time:performance.now() } : null;
  }, { passive:true });
  composerInput.addEventListener('touchcancel', () => { touch = null; });
  composerInput.addEventListener('touchend', event => {
    const start = touch;
    touch = null;
    const end = event.changedTouches[0];
    if (!start || !end || !event.cancelable || event.touches.length || document.activeElement === composerInput ||
        performance.now() - start.time > 400 || Math.hypot(end.clientX-start.x, end.clientY-start.y) > 10 ||
        (viewport && Math.abs(viewport.scale-1) > 0.01)) return;
    const box = composerInput.getBoundingClientRect();
    const targetY = $('.topbar').getBoundingClientRect().bottom + 4;
    if (box.top <= targetY) return;
    event.preventDefault();
    restoreEditor();
    initialHeight = viewport?.height ?? innerHeight;
    mirror = document.createElement('div');
    mirror.className = 'editor-mirror';
    mirror.setAttribute('aria-hidden','true');
    mirror.textContent = composerInput.value || composerInput.placeholder;
    mirror.classList.toggle('placeholder', !composerInput.value);
    mirror.style.width = box.width + 'px';
    mirror.style.height = box.height + 'px';
    composerInput.after(mirror);
    composerInput.style.setProperty('--focus-shift', (targetY-box.top) + 'px');
    composerInput.classList.add('focus-staging');
    composerInput.getBoundingClientRect();
    composerInput.focus({preventScroll:true});
    if (!composerInput.value) composerInput.setSelectionRange(0,0);
    timer = setTimeout(restoreEditor, 550);
  }, { passive:false });
}

if (matchMedia('(any-pointer: coarse)').matches || iosHome) {
  const root = document.documentElement;
  let restingHeight = window.innerHeight;
  let lastWidth = window.innerWidth;
  let restLayout = window.innerHeight;
  let frame = 0;

  function fitViewport() {
    frame = 0;
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const width = window.innerWidth;
    const layout = window.innerHeight;
    const visible = viewport?.height ?? layout;
    const editing = document.activeElement?.matches('textarea, input, [contenteditable="true"]');
    // On a full-width Home Screen iPhone the unobscured canvas is also known
    // after rotation with the keyboard still up. Do not use screen size on iPad.
    if (iosHome && /iPhone|iPod/.test(navigator.userAgent) &&
        (width === screen.width || width === screen.height)) {
      restingHeight = width === screen.width ? screen.height : screen.width;
    } else if (lastWidth !== width || (!editing && visible >= restingHeight - 1)) {
      restingHeight = layout;
    } else {
      restingHeight = Math.max(restingHeight, layout);
    }
    restLayout = lastWidth !== width ? layout : Math.max(restLayout, layout);
    lastWidth = width;
    // Keyboard closed in a Home Screen iPhone app: iOS lays the page out shorter than the screen
    // (812 of 874 points), which left a plain strip under the app and the composer too high.
    // Then the app fills the whole screen; with the keyboard up, nothing changes.
    if (iosHome && /iPhone|iPod/.test(navigator.userAgent) && restingHeight > layout &&
        layout >= restLayout - 1 && visible >= layout - 1) {
      root.style.setProperty('--scene-h', restingHeight + 'px');
      root.style.setProperty('--covered', '0px');
      root.style.setProperty('--app-h', restingHeight + 'px');
      root.style.setProperty('--app-top', '0px');
      return;
    }
    const covered = Math.max(0, restingHeight - visible);
    root.style.setProperty('--scene-h', restingHeight + 'px');
    root.style.setProperty('--covered', covered + 'px');
    // 100dvh already follows a resized layout. Only override it for a
    // visual-only resize, when the layout still extends below the keyboard.
    if (visible < layout - 1) root.style.setProperty('--app-h', visible + 'px');
    else root.style.removeProperty('--app-h');
    // The shell is in document coordinates. Account for either kind of pan
    // (document scroll or visual pan) once, on their common ancestor.
    const top = covered > 1 ? (viewport?.pageTop ?? window.scrollY) : 0;
    root.style.setProperty('--app-top', top + 'px');
  }

  function scheduleFit() {
    if (!frame) frame = requestAnimationFrame(fitViewport);
  }
  viewport?.addEventListener('resize', scheduleFit);
  viewport?.addEventListener('scroll', scheduleFit);
  window.addEventListener('resize', scheduleFit);
  window.addEventListener('scroll', scheduleFit, { passive: true });
  window.addEventListener('pageshow', scheduleFit);
  fitViewport();
}

// A focused action field may be above or below the reading area. Move only
// its own list, both on focus and as the keyboard changes the available room.
let followTail = true;
messageList.addEventListener('scroll', () => { followTail = nearBottom(); }, { passive: true });
function fitMessages() {
  if (!messageList.clientHeight) return;
  const field = document.activeElement;
  if (messageList.contains(field) && field.matches('input, textarea')) {
    const rect = field.getBoundingClientRect();
    const top = $('.topbar').getBoundingClientRect().bottom + 8;
    const bottom = messageList.getBoundingClientRect().bottom - 8;
    if (rect.top < top) messageList.scrollTop += rect.top - top;
    else if (rect.bottom > bottom) messageList.scrollTop += rect.bottom - bottom;
  } else if (followTail) {
    scrollToBottom();
  }
}
messageList.addEventListener('focusin', fitMessages);
new ResizeObserver(fitMessages).observe(messageList);

// ---------------- approval cards ----------------
function renderActionCard(action, existing) {
  const card = existing || document.createElement('div');
  card.className = `action-card ${action.status}`;
  card.dataset.id = action.id;
  card.replaceChildren();

  const head = document.createElement('div');
  head.className = 'ac-head';
  head.textContent = action.status === 'pending' ? `⚡ ${action.label} · מחכה לאישור שלך` : `⚡ ${action.label}`;
  const summary = document.createElement('div');
  summary.className = 'ac-summary';
  summary.textContent = action.summary;
  card.append(head, summary);

  // While waiting for approval the text itself is editable: tap it and type (no separate "edit" button).
  const pending = action.status === 'pending';
  if (pending && action.fields.length) {
    const hint = document.createElement('div');
    hint.className = 'ac-hint';
    hint.textContent = 'אפשר ללחוץ על הטקסט ולשנות אותו לפני האישור.';
    card.append(hint);
  }
  let approve = null;
  const changed = () =>
    [...card.querySelectorAll('.ac-input')].some((el) => el.value !== (action.fields.find((f) => f.key === el.name)?.value ?? ''));
  for (const f of action.fields) {
    if (!f.value && !pending) continue;
    const field = document.createElement('label');
    field.className = 'ac-field';
    const name = document.createElement('span');
    name.textContent = f.label;
    field.append(name);
    if (pending) {
      const input = document.createElement(f.multiline ? 'textarea' : 'input');
      input.className = 'ac-input';
      input.name = f.key;
      input.value = f.value ?? '';
      input.placeholder = f.value ? '' : 'לא חובה';
      input.enterKeyHint = 'done';
      if (f.multiline) {
        input.rows = 1;
        const grow = () => {
          input.style.height = 'auto';
          input.style.height = `${input.scrollHeight + 2}px`;
        };
        input.addEventListener('input', grow);
        requestAnimationFrame(grow);
      }
      input.addEventListener('input', () => {
        if (approve) approve.textContent = changed() ? 'אשר עם השינויים' : 'אשר';
      });
      field.append(input);
    } else {
      const v = document.createElement('div');
      v.className = 'ac-value';
      v.textContent = f.value;
      field.append(v);
    }
    card.append(field);
  }

  if (pending) {
    const buttons = document.createElement('div');
    buttons.className = 'ac-buttons';
    approve = document.createElement('button');
    approve.className = 'approve';
    approve.textContent = 'אשר';
    approve.onclick = () => decideAction(card, action, 'approve');
    const reject = document.createElement('button');
    reject.textContent = 'בטל';
    reject.onclick = () => decideAction(card, action, 'reject');
    buttons.append(approve, reject);
    card.append(buttons);
  } else {
    const status = document.createElement('div');
    status.className = 'ac-status';
    status.textContent =
      action.status === 'failed' && action.result ? `נכשל: ${action.result}` : STATUS_TEXT[action.status] || '';
    card.append(status);
  }
  return card;
}

function addActionCard(action) {
  $('#empty').hidden = true;
  const card = renderActionCard(action);
  $('#messages').append(card);
  scrollToBottom();
  return card;
}

async function decideAction(card, action, decision) {
  // Send the text only if it was changed (then it counts as an edited approval in the activity log).
  let args;
  const inputs = [...card.querySelectorAll('.ac-input')];
  if (decision === 'approve' && inputs.some((el) => el.value !== (action.fields.find((f) => f.key === el.name)?.value ?? ''))) {
    args = {};
    for (const input of inputs) args[input.name] = input.value;
  }
  card.querySelectorAll('button, .ac-input').forEach((b) => (b.disabled = true));
  const owner = store.conversationId;
  let accepted = false;
  let reply = null;
  if (decision === 'approve') setProgress(card, 'שולח את האישור למק…');
  try {
    const res = await api(`/api/actions/${action.id}?progress=1`, { method: 'POST', body: JSON.stringify({ decision, args }) });
    await consumeStream(res, {
      progress: (p) => {
        accepted = true;
        if (card.isConnected) setProgress(reply || card, p.label);
      },
      action: (a) => renderActionCard(a, card),
      // What the action brought back (a photo from the Mac's camera), above the model's words about it.
      tool: (t) => {
        if (!t.display || !card.isConnected || store.conversationId !== owner) return;
        reply ??= addAssistantMessage();
        addDisplay(reply, t.display);
      },
      meta: (m) => {
        if (!card.isConnected || store.conversationId !== owner) return;
        reply ??= addAssistantMessage();
        setMeta(reply, { model: m.model, engine: m.engine });
        reply.querySelector('.body').classList.add('cursor');
      },
      delta: (d) => appendDelta(reply, d.text),
      done: (d) => finishReply(reply, d),
      error: (e) => { if (card.isConnected) { setProgress(card); showReplyError(reply || addAssistantMessage(), e.message); } },
    });
    reply?.querySelector('.body').classList.remove('cursor');
  } catch (err) {
    if (handleUnauthorized(err)) return;
    if (!card.isConnected || owner !== store.conversationId) return;
    setProgress(card);
    if ((reply || accepted) && owner) {
      reply ??= addAssistantMessage();
      // Approved, and the app went to the background while Brain was reporting back: it goes on at the Mac.
      setMeta(reply, { note: 'ממשיך לעבוד במק…' });
      followRun(store.conversationId, reply);
      return;
    }
    card.querySelectorAll('button, .ac-input').forEach((b) => (b.disabled = false));
    notify(err.message || 'הפעולה נכשלה');
  }
}

// ---------------- local or cloud ----------------
/** Where a new conversation goes unless the switch says otherwise. */
function defaultEngine() {
  const c = state.status?.cloud;
  return c?.mode === 'cloud' && c.ready ? 'cloud' : 'local';
}

/** The switch next to the message box: shown once a cloud key exists on the Mac. */
function renderEngineChip() {
  if (state.online) renderStatus();
  const btn = $('#engine-btn');
  const cloud = state.status?.cloud;
  const visible = !!cloud && cloud.providers?.some((p) => p.hasKey);
  btn.hidden = !visible;
  if (!visible) return;
  const on = state.engine === 'cloud';
  btn.textContent = on ? 'ענן' : 'מק';
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? `עונה ${cloud.modelName} בענן. לחיצה: חזרה למק` : 'עונה המודל במק. לחיצה: מעבר לענן';
}

async function toggleEngine() {
  const cloud = state.status?.cloud;
  const next = state.engine === 'cloud' ? 'local' : 'cloud';
  if (next === 'cloud' && cloud && !cloud.ready) return notify(`אי אפשר לעבור לענן: ${cloud.reason}.`);
  if (store.conversationId) {
    try {
      const r = await (await api(`/api/conversations/${store.conversationId}/engine`, { method: 'POST', body: JSON.stringify({ engine: next }) })).json();
      state.engine = r.engine;
    } catch (err) {
      if (!handleUnauthorized(err)) notify(err.message);
      return;
    }
  } else {
    state.engine = next;
    state.engineTouched = true;
  }
  renderEngineChip();
}

/** A line under a reply, e.g. "didn't move to the cloud: local only is on". */
function addNotice(el, text) {
  if (!el || !text) return;
  el.append(el$('div', 'reply-notice', text));
}

function renderChoiceCard(d, card) {
  const pending = d.status === 'pending';
  card.choice = d;
  card.className = `action-card choice-card ${pending ? 'pending' : 'done'}`;
  card.replaceChildren(
    el$('div', 'ac-head', '☁️ לעבור לענן?'),
    el$('div', 'ac-summary', `זו נראית משימה מורכבת. לענות עליה עם ${d.model} (${d.provider}) בענן?`),
  );
  if (pending) {
    card.append(el$('div', 'ac-hint', 'נשלח רק מה שמותר בהגדרות. המפתחות והפעולות נשארים במק, ושינויים עדיין רק באישור שלך.'));
    const buttons = el$('div', 'ac-buttons');
    const toCloud = el$('button', 'approve', 'בענן');
    const toMac = el$('button', null, 'במק');
    toCloud.type = toMac.type = 'button';
    toCloud.onclick = () => chooseEngine(card, d, 'cloud');
    toMac.onclick = () => chooseEngine(card, d, 'local');
    buttons.append(toCloud, toMac);
    card.append(buttons);
  } else {
    card.append(el$('div', 'ac-status', d.status === 'cloud' ? 'עבר לענן' : d.status === 'local' ? 'נשאר במק' : 'לא נבחר (נשלחה הודעה חדשה)'));
  }
  return card;
}

function addChoiceCard(d) {
  $('#empty').hidden = true;
  const card = renderChoiceCard(d, document.createElement('div'));
  $('#messages').append(card);
  scrollToBottom();
  return card;
}

/** The answer on a suggestion card: the Mac answers the waiting question with the engine chosen. */
async function chooseEngine(card, d, engine) {
  const owner = store.conversationId;
  if (!owner || state.streaming) return;
  card.querySelectorAll('button').forEach((b) => (b.disabled = true));
  const controller = new AbortController();
  state.streaming = controller;
  updateComposer();
  let reply = null;
  try {
    const res = await api(`/api/conversations/${owner}/engine`, {
      method: 'POST',
      body: JSON.stringify({ engine, run: true, fromCard: true }),
      signal: controller.signal,
    });
    renderChoiceCard({ ...d, status: engine }, card);
    state.engine = engine;
    renderEngineChip();
    if (!res.headers.get('content-type')?.includes('event-stream')) return;
    await consumeStream(res, {
      meta: (m) => {
        if (store.conversationId !== owner) return;
        reply = addAssistantMessage({ model: m.model, engine: m.engine });
        reply.querySelector('.body').classList.add('cursor');
      },
      progress: (p) => setProgress(reply, p.label),
      notice: (n) => addNotice(reply, n.text),
      delta: (x) => appendDelta(reply, x.text),
      tool: (data) => {
        if (!reply) return;
        addToolChip(reply, data);
        if (data.attachment) addAttachment(reply, data.attachment);
        if (data.display) addDisplay(reply, data.display);
      },
      approval: (action) => {
        if (store.conversationId !== owner) return;
        const c = addActionCard(action);
        cardActions.set(c, action);
      },
      done: (x) => {
        finishReply(reply, x);
        if (x.engine && store.conversationId === owner) {
          state.engine = x.engine;
          renderEngineChip();
        }
      },
      error: (e) => {
        if (store.conversationId === owner) showReplyError(reply || addAssistantMessage(), e.message);
      },
    });
  } catch (err) {
    if (handleUnauthorized(err)) return;
    if (reply && owner === store.conversationId && !controller.stoppedByUser) {
      // The app went to the background: the Mac goes on, and the answer shows when it's ready.
      setMeta(reply, { note: 'ממשיך לעבוד במק…' });
      followRun(owner, reply);
      return;
    }
    if (card.classList.contains('pending')) card.querySelectorAll('button').forEach((b) => (b.disabled = false));
    if (err.name !== 'AbortError') notify(err.message || 'הבחירה לא נשמרה');
  } finally {
    if (!following.has(reply)) reply?.querySelector('.body')?.classList.remove('cursor');
    if (state.streaming === controller) state.streaming = null;
    updateComposer();
  }
}

function renderCloudSettings(c) {
  if (!c) return;
  for (const r of document.querySelectorAll('input[name="cloud-mode"]')) r.checked = r.value === c.mode;
  $('#cloud-provider').replaceChildren(
    ...c.providers.map((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = `${p.modelName} · ${p.name}${p.hasKey ? '' : ' (אין מפתח)'}`;
      o.selected = p.id === c.provider;
      return o;
    }),
  );
  $('#cloud-allow').replaceChildren(
    ...c.categories.map((cat) => {
      const li = document.createElement('li');
      const label = el$('label', 'toggle-row');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!c.allow[cat.id];
      input.addEventListener('change', () => saveSetting({ cloud: { allow: { [cat.id]: input.checked } } }));
      label.append(input, el$('span', null, cat.name));
      li.append(label);
      return li;
    }),
  );
  const usd = c.monthUsd < 0.01 ? 'פחות מסנט' : `$${c.monthUsd.toFixed(2)}`;
  $('#cloud-state').textContent =
    c.mode === 'local' ? 'כבוי: הכול נשאר במק.' :
    c.ready ? `${c.mode === 'cloud' ? 'כל שיחה בענן' : 'מוכן'}: ${c.modelName}. עלות משוערת החודש: ${usd}.` :
    `לא זמין: ${c.reason}.`;
}

// ---------------- notifications ----------------
// iPhone: only in the app added to the Home Screen (iOS 16.4 and later). The Mac seals every
// notification for this device's key (server/push.ts); Apple only carries it.
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let pushKey = null;

function keyBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function sameKey(sub, key) {
  const a = sub?.options?.applicationServerKey;
  if (!a) return true;
  const b = keyBytes(key);
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

async function renderPush() {
  const st = $('#push-state');
  const btn = $('#push-btn');
  const test = $('#push-test');
  btn.hidden = test.hidden = $('#push-preview-row').hidden = true;
  if (!pushSupported()) {
    st.textContent = /iPhone|iPad/.test(navigator.userAgent) && !standalone()
      ? 'התראות עובדות רק כשפותחים את בריין מהאפליקציה שבמסך הבית, לא מ־Safari.'
      : 'המכשיר או הדפדפן הזה לא תומכים בהתראות.';
    return;
  }
  try {
    const info = await (await api('/api/push')).json();
    pushKey = info.publicKey;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    const on = Notification.permission === 'granted' && sub && info.subscribed && sameKey(sub, info.publicKey);
    $('#push-preview').checked = info.preview;
    if (Notification.permission === 'denied') {
      st.textContent = 'ההתראות חסומות. אפשר להפעיל אותן בהגדרות האייפון ← התראות ← בריין.';
      return;
    }
    st.textContent = on ? 'פועלות במכשיר הזה.' : 'כבויות במכשיר הזה.';
    btn.textContent = on ? 'כיבוי התראות' : 'הפעלת התראות';
    btn.dataset.on = on ? '1' : '';
    btn.hidden = false;
    test.hidden = !on;
    $('#push-preview-row').hidden = !on;
  } catch (err) {
    if (handleUnauthorized(err)) return;
    st.textContent = err.message;
  }
}

async function togglePush() {
  const st = $('#push-state');
  if ($('#push-btn').dataset.on) {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    await sub?.unsubscribe().catch(() => {});
    await api('/api/push', { method: 'DELETE' }).catch(() => {});
    return renderPush();
  }
  // iOS asks only right after a tap: nothing may be awaited before this.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return renderPush();
  try {
    st.textContent = 'מפעיל…';
    const reg = await navigator.serviceWorker.ready;
    pushKey ??= (await (await api('/api/push')).json()).publicKey;
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, pushKey)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushKey) });
    await api('/api/push', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
  } catch (err) {
    if (handleUnauthorized(err)) return;
    st.textContent = `לא הצלחתי להפעיל: ${err.message}`;
    return;
  }
  await renderPush();
}

async function testPush() {
  const st = $('#push-state');
  st.textContent = 'שולח…';
  try {
    const r = await (await api('/api/push/test', { method: 'POST' })).json();
    st.textContent = r.delivered ? 'נשלחה. היא אמורה להופיע בעוד כמה שניות (גם כשהאפליקציה פתוחה).' : 'לא נשלחה. נסה לכבות ולהפעיל שוב.';
  } catch (err) {
    if (!handleUnauthorized(err)) st.textContent = err.message;
  }
}

/** On every opening: the Mac keeps this device's current address (it can change, or the Mac may have lost it). */
async function syncPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) await api('/api/push', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
  } catch {
    // Next time.
  }
}

/** A tapped notification names a conversation: /?c=<id>. */
function conversationFromUrl(url) {
  const c = new URL(url, location.origin).searchParams.get('c');
  return c && /^[0-9a-f-]{36}$/.test(c) ? c : null;
}

// ---------------- photos and files from the phone ----------------
// On the iPhone, the + button offers: photo library, take a photo, or choose a file. Photos are made
// smaller here (up to 1600 px, JPEG): quicker to send, and a model doesn't need more. Each one is sent
// to the Mac right away, and the message then names them by id.
const MAX_ATTACH = 6;
let pendingAttachments = [];
const attachReady = () => pendingAttachments.some((a) => a.status === 'ready');
const attachBusy = () => pendingAttachments.some((a) => a.status === 'uploading');

async function shrinkImage(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  } catch {
    return null;
  }
}

function addAttachments(files) {
  for (const file of files) {
    if (pendingAttachments.length >= MAX_ATTACH) {
      notify(`אפשר לצרף עד ${MAX_ATTACH} קבצים להודעה.`);
      break;
    }
    const item = { key: crypto.randomUUID(), status: 'uploading', kind: file.type.startsWith('image/') ? 'image' : 'file', name: file.name || 'קובץ' };
    pendingAttachments.push(item);
    void uploadAttachment(item, file);
  }
  renderTray();
}

async function uploadAttachment(item, file) {
  let body = file;
  if (item.kind === 'image') {
    const small = await shrinkImage(file);
    if (small) {
      body = small;
      item.name = (item.name.replace(/\.[^.]*$/, '') || 'תמונה') + '.jpg';
    }
    item.previewUrl = URL.createObjectURL(body);
    renderTray();
  }
  try {
    const res = await api(`/api/uploads?name=${encodeURIComponent(item.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
      signal: AbortSignal.timeout(120000),
    });
    Object.assign(item, await res.json(), { status: 'ready' });
    if (item.kind === 'file' && item.hasText === false) notify(`לא מצאתי טקסט ב־${item.name}. בריין יידע רק את השם שלו.`);
  } catch (err) {
    if (handleUnauthorized(err)) return;
    item.status = 'failed';
    item.error = err.message || 'השליחה למק נכשלה.';
    notify(`${item.name}: ${item.error}`);
  }
  if (pendingAttachments.includes(item)) renderTray();
}

function renderTray() {
  const tray = $('#attach-tray');
  tray.replaceChildren(
    ...pendingAttachments.map((a) => {
      const el = el$('div', `attach-item ${a.status}`);
      if (a.kind === 'image' && a.previewUrl) {
        const img = el$('img');
        img.src = a.previewUrl;
        img.alt = a.name;
        el.append(img);
      } else {
        el.append(el$('span', 'file-name', `${FILE_ICONS[a.name.split('.').pop().toLowerCase()] || '📄'} ${a.name}`));
      }
      if (a.status !== 'ready') el.append(el$('span', 'state', a.status === 'failed' ? '!' : '…'));
      const remove = el$('button', 'remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `להסיר את ${a.name}`);
      remove.addEventListener('click', () => {
        pendingAttachments = pendingAttachments.filter((x) => x !== a);
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        renderTray();
      });
      el.append(remove);
      return el;
    }),
  );
  tray.hidden = !pendingAttachments.length;
  updateComposer();
}

/** The attachments that made it to the Mac go with the message; the tray empties. */
function takeAttachments() {
  const ready = pendingAttachments
    .filter((a) => a.status === 'ready')
    .map(({ id, kind, name, mime, size, previewUrl }) => ({ id, kind, name, mime, size, previewUrl }));
  for (const a of pendingAttachments) if (a.status !== 'ready' && a.previewUrl) URL.revokeObjectURL(a.previewUrl);
  pendingAttachments = [];
  renderTray();
  return ready;
}

// ---------------- the Mac's camera, live ----------------
// Frames arrive as [4-byte length][JPEG] for as long as this screen is open (up to the Mac's limit).
const cameraSheet = $('#camera-sheet');
let cameraController = null;
let cameraFrameUrl = null;
const setCameraState = (text) => { $('#camera-state').textContent = text; };

async function openCamera() {
  closeDrawer();
  cameraSheet.hidden = false;
  $('#camera-frame').hidden = true;
  $('#camera-live').hidden = true;
  $('#camera-start').hidden = $('#camera-stop').hidden = true;
  setCameraState('בודק את המצלמה של המק…');
  try {
    const info = await (await api('/api/camera')).json();
    if (cameraSheet.hidden) return;
    if (!info.available) {
      setCameraState('המצלמה של המק לא מחוברת לבריין. במק: npm run apple:setup, ולאשר את המצלמה.');
      return;
    }
    void startLive();
  } catch (err) {
    if (!handleUnauthorized(err)) setCameraState(err.message || 'המק לא זמין.');
  }
}

async function startLive() {
  stopLive();
  const controller = new AbortController();
  cameraController = controller;
  $('#camera-start').hidden = true;
  $('#camera-stop').hidden = false;
  setCameraState('מתחבר למצלמה… (במק נדלקת הנורית הירוקה)');
  let frames = 0;
  let seconds = 300;
  const started = Date.now();
  try {
    const res = await api('/api/camera/live', { signal: controller.signal });
    seconds = Number(res.headers.get('x-live-seconds')) || seconds;
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(buf.length + value.length);
      joined.set(buf);
      joined.set(value, buf.length);
      buf = joined;
      while (buf.length >= 4) {
        const len = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
        if (buf.length < 4 + len) break;
        showCameraFrame(buf.slice(4, 4 + len));
        buf = buf.slice(4 + len);
        frames++;
        const left = Math.max(0, seconds - Math.round((Date.now() - started) / 1000));
        setCameraState(`צפייה חיה · נשארו ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);
      }
    }
    if (cameraController === controller) setCameraState(`הצפייה נעצרה. כל צפייה נמשכת עד ${Math.round(seconds / 60)} דקות.`);
  } catch (err) {
    if (controller.signal.aborted || handleUnauthorized(err)) return;
    setCameraState(err.status ? err.message : frames ? 'החיבור למק נקטע.' : 'המק לא ענה.');
  } finally {
    if (cameraController === controller) {
      cameraController = null;
      $('#camera-live').hidden = true;
      $('#camera-stop').hidden = true;
      $('#camera-start').hidden = false;
      $('#camera-start').textContent = frames ? 'להמשיך לצפות' : 'לנסות שוב';
    }
  }
}

function showCameraFrame(bytes) {
  const img = $('#camera-frame');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  const previous = cameraFrameUrl;
  cameraFrameUrl = url;
  img.onload = () => { if (previous) URL.revokeObjectURL(previous); };
  img.src = url;
  img.hidden = false;
  $('#camera-live').hidden = false;
}

function stopLive(note) {
  const controller = cameraController;
  cameraController = null;
  controller?.abort();
  if (controller) {
    $('#camera-live').hidden = true;
    $('#camera-stop').hidden = true;
    $('#camera-start').hidden = false;
    $('#camera-start').textContent = 'להמשיך לצפות';
    if (note) setCameraState(note);
  }
}

// ---------------- conversations ----------------
let viewSequence = 0;
async function openConversation(id) {
  if (state.streaming && store.conversationId === id) return;
  cancelFollow();
  const sequence = ++viewSequence;
  try {
    const conv = await (await api(`/api/conversations/${id}?view=chat`, { signal: AbortSignal.timeout(8000) })).json();
    if (sequence !== viewSequence) return;
    restoringMessages = true;
    if (store.conversationId !== conv.id) detachStream();
    store.conversationId = conv.id;
    state.engine = conv.engine || 'local';
    renderEngineChip();
    restoreDraft();
    $('#chat-title').textContent = conv.title;
    clearMessages();
    const actionsByMessage = new Map();
    for (const a of conv.actions) actionsByMessage.set(a.messageId, [...(actionsByMessage.get(a.messageId) || []), a]);

    let pendingChips = [];
    let pendingDisplays = [];
    for (const m of conv.messages) {
      if (m.role === 'user') {
        addUserMessage(m.content, m.attachments || []);
      } else if (m.role === 'tool') {
        if (m.display?.kind === 'cloud-choice') addChoiceCard(m.display);
        else if (m.display) pendingDisplays.push(m.display);
        continue;
      } else if (m.tool_calls) {
        if (m.content) addAssistantMessage({ content: m.content, model: m.model, engine: m.engine, thinking: m.thinking });
        const actions = actionsByMessage.get(m.id) || [];
        for (const a of actions) addActionCard(a);
        for (const c of m.tool_calls) {
          if (!actions.some((a) => a.tool === c.name)) pendingChips.push(historyChip(c, conv.toolLabels));
        }
      } else {
        const el = addAssistantMessage({ content: m.content, model: m.model, engine: m.engine, thinking: m.thinking });
        for (const chip of pendingChips) addToolChip(el, { chip, ok: true });
        for (const d of pendingDisplays) addDisplay(el, d);
        pendingChips = [];
        pendingDisplays = [];
      }
    }
    if (conv.running) {
      // Still being worked on at the Mac (sent before the app went to the background).
      const el = addAssistantMessage();
      el.querySelector('.body').classList.add('cursor');
      for (const chip of pendingChips) addToolChip(el, { chip, ok: true });
      setProgress(el, conv.progress || 'עובד על זה במק…');
      followRun(conv.id, el);
    }
  } catch (err) {
    if (handleUnauthorized(err)) return;
    if (sequence !== viewSequence) return;
    if (err.status === 404) { drafts.write(id, ''); newConversation(); }
    else void checkHealth();
  } finally {
    if (restoringMessages) { restoringMessages = false; scrollToBottom(); }
  }
}

function historyChip(call, labels) {
  const a = call.arguments || {};
  if (call.name === 'remember' && a.fact) return `🧠 נשמר בזיכרון: ${a.fact}`;
  if (call.name === 'search_history' && a.query) return `🔎 חיפש בשיחות: ${a.query}`;
  if (call.name === 'search_files' && a.query) return `📁 חיפש קבצים: ${a.query}`;
  if (call.name === 'read_file' && a.path) return `📄 קרא: ${a.path.split('/').pop()}`;
  if (call.name === 'send_file' && a.path) return `📎 נשלח: ${a.path.split('/').pop()}`;
  return `🔧 ${labels[call.name] || call.name}`;
}

function newConversation() {
  detachStream();
  cancelFollow();
  viewSequence++;
  store.conversationId = null;
  state.engine = defaultEngine();
  state.engineTouched = false;
  renderEngineChip();
  restoreDraft();
  $('#chat-title').textContent = 'שיחה חדשה';
  clearMessages();
  composerInput.focus({ preventScroll: true });
  warm();
}

// ---------------- streaming ----------------
/** Reads a server-sent-events response and calls the handler for each event. */
async function consumeStream(res, handlers) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? 'null');
      markOnline();
      handlers[event]?.(data);
    }
  }
}

const pendingPaints = new WeakMap();
function paintReply(el) {
  const frame = pendingPaints.get(el);
  if (frame === undefined) return;
  if (frame < 0) clearTimeout(-frame);
  else cancelAnimationFrame(frame);
  pendingPaints.delete(el);
  if (!el.isConnected) return;
  const stick = nearBottom();
  el.querySelector('.body').innerHTML = renderMarkdown(el.dataset.text);
  if (stick) scrollToBottom();
}
function appendDelta(el, text) {
  if (!el) return;
  el.dataset.text = (el.dataset.text || '') + text;
  if (pendingPaints.has(el)) return;
  // While the user types (keyboard up), redraw a few times a second instead of every frame: each
  // redraw moves the page under the keyboard, which on the iPhone looked like flickering.
  if (document.activeElement === composerInput) {
    const t = setTimeout(() => {
      pendingPaints.set(el, 0);
      paintReply(el);
    }, 400);
    pendingPaints.set(el, -t);
  } else {
    pendingPaints.set(el, requestAnimationFrame(() => paintReply(el)));
  }
}

function setProgress(el, label = '') {
  if (!el) return;
  let tag = el.querySelector('.run-progress');
  if (!label) { tag?.remove(); return; }
  if (!tag) {
    tag = document.createElement('div');
    tag.className = 'run-progress';
    tag.setAttribute('role', 'status');
    el.append(tag);
  }
  if (tag.textContent !== label) tag.textContent = label;
}

function finishReply(el, d) {
  if (!el) return;
  setProgress(el);
  paintReply(el);
  el.querySelector('.body').classList.remove('cursor');
  if ((d.awaitingApproval || d.awaitingChoice) && !el.dataset.text) {
    // Nothing to say besides the card: keep only the tool chips, if any.
    if (el.querySelector('.tool-chips').hidden) el.remove();
    else setMeta(el, { model: d.model, engine: d.engine, thinking: d.thinking });
    return;
  }
  setMeta(el, { model: d.model, engine: d.engine, thinking: d.thinking, tokensPerSecond: d.tokensPerSecond, totalMs: d.totalMs });
}

function showReplyError(el, message) {
  setProgress(el);
  paintReply(el);
  el.classList.add('error');
  const text = el.dataset.text;
  el.querySelector('.body').innerHTML = renderMarkdown(text ? `${text}\n\n${message}` : message);
}

// ---------------- sending ----------------
function updateComposer() {
  const busy = !!state.streaming;
  $('#send-btn').hidden = busy;
  $('#stop-btn').hidden = !busy;
  $('#send-btn').disabled = (!$('#input').value.trim() && !attachReady()) || attachBusy() || state.online === false;
  $('#attach-btn').disabled = state.online === false || pendingAttachments.length >= MAX_ATTACH;
}

function detachStream() {
  const controller = state.streaming;
  if (!controller) return;
  controller.detached = true;
  if (controller.acknowledged) controller.abort();
  state.streaming = null;
  updateComposer();
}

async function send(text, submitted, attachments = []) {
  const origin = store.conversationId;
  const session = store.token;
  cancelFollow();
  viewSequence++;
  // A new message makes any card still waiting for approval stale.
  for (const card of document.querySelectorAll('.action-card.pending')) {
    if (card.classList.contains('choice-card')) renderChoiceCard({ ...card.choice, status: 'expired' }, card);
    else renderActionCard({ ...cardAction(card), status: 'expired' }, card);
  }
  addUserMessage(text, attachments);
  let el = addAssistantMessage();
  el.querySelector('.body').classList.add('cursor');

  setProgress(el, 'שולח למק…');
  const controller = new AbortController();
  state.streaming = controller;
  updateComposer();

  let meta = {};
  try {
    const res = await api('/api/chat', {
      method: 'POST',
      // The switch next to the box: a new conversation starts in the cloud if it's on (an existing
      // conversation already knows; the switch told the Mac).
      body: JSON.stringify({
        conversationId: store.conversationId,
        text,
        attachments: attachments.length ? attachments.map((a) => a.id) : undefined,
        engine: !store.conversationId && state.engine !== defaultEngine() ? state.engine : undefined,
      }),
      signal: controller.signal,
    });
    await consumeStream(res, {
      meta: (data) => {
        meta = data;
        controller.acknowledged = true;
        if (store.token !== session) { controller.abort(); return; }
        drafts.accepted(origin, data.conversationId, submitted, !controller.detached);
        if (controller.detached) { controller.abort(); return; }
        store.conversationId = data.conversationId;
        restoreDraft();
        $('#chat-title').textContent = data.title;
        setMeta(el, { model: data.model, engine: data.engine, thinking: data.thinking });
        state.engine = data.engine || 'local';
        renderEngineChip();
      },
      progress: (p) => setProgress(el, p.label),
      notice: (n) => addNotice(el, n.text),
      choice: (d) => {
        if (!controller.detached) addChoiceCard(d);
      },
      thinking: () => {
        meta.thinking = true;
        setMeta(el, meta);
      },
      delta: (data) => appendDelta(el, data.text),
      tool: (data) => {
        addToolChip(el, data);
        if (data.attachment) addAttachment(el, data.attachment);
        if (data.display) addDisplay(el, data.display);
      },
      approval: (action) => {
        if (controller.detached) return;
        const card = addActionCard(action);
        cardActions.set(card, action);
      },
      done: (data) => {
        finishReply(el, data);
        if (data.engine && !data.awaitingChoice && !controller.detached) {
          state.engine = data.engine;
          renderEngineChip();
        }
      },
      error: (data) => {
        showReplyError(el, data.message);
        setMeta(el, meta);
      },
    });
  } catch (err) {
    if (controller.detached || handleUnauthorized(err)) return;
    setProgress(el);
    paintReply(el);
    if (err.name === 'AbortError' && controller.stoppedByUser) {
      setMeta(el, { ...meta, note: 'נעצר' });
    } else if (meta.conversationId) {
      // The connection dropped (usually: the app went to the background). The Mac goes on working;
      // the answer is picked up from the conversation when it's ready.
      el.querySelector('.body').classList.add('cursor');
      setMeta(el, { ...meta, note: 'ממשיך לעבוד במק…' });
      followRun(meta.conversationId, el);
    } else {
      el.classList.add('error');
      el.querySelector('.body').textContent =
        err.status ? err.message : 'חסר אישור קבלה מהמק. הטיוטה נשמרה. בדוק בשיחה לפני שליחה חוזרת.';
      checkHealth();
    }
  } finally {
    if (!following.has(el)) el.querySelector('.body')?.classList.remove('cursor');
    if (state.streaming === controller) state.streaming = null;
    updateComposer();
  }
}

/**
 * The Mac is still working on an answer we're not connected to any more (the app was in the
 * background). Check now and then, and when it's done show the conversation as saved on the Mac.
 */
const following = new WeakSet();
let followTimer = 0;
let followGeneration = 0;
let followedConversation = null;
let followedElement = null;
function cancelFollow() {
  clearTimeout(followTimer);
  followGeneration++;
  followedConversation = null;
  followedElement = null;
}
function followRun(conversationId, el, immediate = false) {
  cancelFollow();
  if (el) following.add(el);
  followedConversation = conversationId;
  followedElement = el;
  const generation = followGeneration;
  const current = () => generation === followGeneration && store.conversationId === conversationId;
  const check = async () => {
    if (!current() || document.visibilityState !== 'visible') return;
    try {
      const res = await api(`/api/conversations/${conversationId}?view=run`, { signal: AbortSignal.timeout(8000) });
      const { running, progress } = await res.json();
      if (!current()) return;
      if (running) {
        setProgress(el, progress || 'עובד על זה במק…');
        followTimer = setTimeout(check, 2000);
      }
      else {
        cancelFollow();
        if (!state.streaming) void openConversation(conversationId);
      }
    } catch (err) {
      if (!current() || handleUnauthorized(err)) return;
      if (err.status === 404) { cancelFollow(); return newConversation(); }
      followTimer = setTimeout(check, 4000);
    }
  };
  if (immediate) void check();
  else followTimer = setTimeout(check, 1500);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && followedConversation && !state.streaming) {
    followRun(followedConversation, followedElement, true);
  }
});

async function stopAnswer() {
  const controller = state.streaming;
  if (!controller) return;
  controller.stoppedByUser = true;
  if (store.conversationId) {
    await api(`/api/conversations/${store.conversationId}/stop`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
  controller.abort();
}

const cardActions = new WeakMap();
function cardAction(card) {
  return cardActions.get(card) || { id: card.dataset.id, label: '', summary: '', fields: [], status: 'expired' };
}

// ---------------- history drawer ----------------
async function openDrawer() {
  $('#drawer').hidden = false;
  $('#search-input').value = '';
  $('#drawer').classList.remove('searching');
  await renderConversationList();
}

let searchTimer = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('#search-input').value.trim();
    if (!q) return renderConversationList();
    try {
      const hits = await (await api(`/api/search?q=${encodeURIComponent(q)}`)).json();
      renderSearchResults(q, hits);
    } catch (err) {
      handleUnauthorized(err);
    }
  }, 250);
}

/** Escapes the snippet and highlights the query inside it. */
function highlight(text, q) {
  const safe = escapeHtml(text);
  const needle = escapeHtml(q);
  return needle ? safe.split(needle).join(`<mark>${needle}</mark>`) : safe;
}

function renderSearchResults(q, hits) {
  const list = $('#conversation-list');
  list.replaceChildren();
  if (!hits.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.style.padding = '12px';
    li.textContent = `לא נמצא "${q}" באף שיחה.`;
    list.append(li);
    return;
  }
  for (const h of hits) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.className = 'open';
    const title = document.createElement('span');
    title.textContent = h.title;
    const snip = document.createElement('span');
    snip.className = 'snippet';
    snip.innerHTML = `${h.role === 'user' ? 'אתה: ' : 'בריין: '}${highlight(h.snippet, q)}`;
    const date = document.createElement('small');
    date.textContent = when(h.createdAt);
    open.append(title, snip, date);
    open.onclick = () => {
      closeDrawer();
      openConversation(h.conversationId);
    };
    li.append(open);
    list.append(li);
  }
}

async function renderConversationList() {
  const list = $('#conversation-list');
  list.replaceChildren();
  try {
    const items = await (await api('/api/conversations')).json();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.style.padding = '12px';
      li.textContent = 'אין עדיין שיחות.';
      list.append(li);
    }
    for (const c of items) list.append(conversationRow(c));
  } catch (err) {
    if (handleUnauthorized(err)) closeDrawer();
  }
}

/** One row in the conversation list: name, date, and a ⋯ menu (rename, delete). */
function conversationRow(c) {
  const li = document.createElement('li');
  if (c.id === store.conversationId) li.classList.add('active');
  const open = document.createElement('button');
  open.className = 'open';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = c.title;
  if (c.pinned) {
    li.classList.add('pinned');
    const pin = document.createElement('i');
    pin.className = 'pin-mark';
    pin.setAttribute('aria-label', 'מוצמדת');
    pin.innerHTML = ICONS.pin;
    title.prepend(pin);
  }
  const date = document.createElement('small');
  date.textContent = when(c.updated_at);
  open.append(title, date);
  open.onclick = () => {
    closeDrawer();
    openConversation(c.id);
  };

  const more = document.createElement('button');
  more.className = 'more';
  more.innerHTML = ICONS.more;
  more.setAttribute('aria-label', `אפשרויות לשיחה ${c.title}`);
  more.setAttribute('aria-haspopup', 'menu');
  more.onclick = (e) => {
    e.stopPropagation();
    const wasOpen = li.querySelector('.row-menu');
    closeRowMenus();
    if (wasOpen) return;
    const menu = document.createElement('div');
    menu.className = 'row-menu';
    menu.setAttribute('role', 'menu');
    const item = (icon, label, onClick, danger) => {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      if (danger) b.className = 'danger';
      b.innerHTML = icon;
      b.append(label);
      b.onclick = (ev) => {
        ev.stopPropagation();
        closeRowMenus();
        onClick();
      };
      return b;
    };
    menu.append(
      item(ICONS.pin, c.pinned ? 'ביטול הצמדה' : 'הצמדה', () => pinRow(c)),
      item(ICONS.pencil, 'שינוי שם', () => renameRow(li, c)),
      item(ICONS.trash, 'מחיקה', () => deleteRow(li, c), true),
    );
    li.append(menu);
    // Open upwards when there's no room below.
    const room = li.closest('.conversation-list').getBoundingClientRect().bottom - li.getBoundingClientRect().bottom;
    menu.classList.toggle('up', room < menu.offsetHeight + 8);
  };
  li.append(open, more);
  return li;
}

function closeRowMenus() {
  for (const m of document.querySelectorAll('.row-menu')) m.remove();
}
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('.row-menu')) closeRowMenus();
});

function renameRow(li, c) {
  const open = li.querySelector('.open');
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = c.title;
  input.maxLength = 80;
  input.setAttribute('aria-label', 'שם חדש לשיחה');
  input.enterKeyHint = 'done';
  open.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const value = input.value.replace(/\s+/g, ' ').trim();
    if (save && value && value !== c.title) {
      try {
        await api(`/api/conversations/${c.id}`, { method: 'PATCH', body: JSON.stringify({ title: value }) });
        c.title = value;
        if (c.id === store.conversationId) $('#chat-title').textContent = value;
      } catch (err) {
        if (!handleUnauthorized(err)) notify(err.message);
      }
    }
    li.replaceWith(conversationRow(c));
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
}

async function pinRow(c) {
  try {
    await api(`/api/conversations/${c.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: !c.pinned }) });
    await renderConversationList();
  } catch (err) {
    if (!handleUnauthorized(err)) notify(err.message);
  }
}

async function deleteRow(li, c) {
  const sure = await confirmDialog({
    title: 'למחוק את השיחה?',
    message: `"${c.title}" תימחק לגמרי. אי אפשר לשחזר.`,
    confirm: 'מחיקה',
    danger: true,
  });
  if (!sure) return;
  try {
    await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
    drafts.write(c.id, '');
    if (c.id === store.conversationId) newConversation();
    li.remove();
  } catch (err) {
    if (!handleUnauthorized(err)) notify(err.message);
  }
}

function closeDrawer() {
  $('#drawer').hidden = true;
}

// ---------------- My Mac ----------------
const machineSheet = $('#machine-sheet');
let machineRequest = 0;
let machineSnapshot = null;
let quitBusy = false;
const gib = bytes => new Intl.NumberFormat('he-IL', { maximumFractionDigits: 1 }).format(bytes / 2 ** 30);
function machineMetric(title, value, detail, percent) {
  const card = document.createElement('div');
  card.className = 'machine-metric';
  const label = document.createElement('span');
  label.textContent = title;
  const reading = document.createElement('strong');
  reading.dir = 'auto';
  reading.textContent = value;
  const caption = document.createElement('small');
  caption.textContent = detail;
  card.append(label, reading, caption);
  if (Number.isFinite(percent)) {
    const meter = document.createElement('progress');
    meter.setAttribute('aria-label', title);
    meter.max = 100;
    meter.value = Math.max(0, Math.min(100, percent));
    card.append(meter);
  }
  return card;
}
function renderMachine(data) {
  $('#machine-name').textContent = data.name;
  $('#machine-time').textContent = 'עודכן ' + new Intl.DateTimeFormat('he-IL', { hour:'2-digit', minute:'2-digit', second:'2-digit' }).format(data.sampledAt);
  const metrics = $('#machine-metrics');
  const { battery: b, ram, disk } = data;
  metrics.replaceChildren(
    machineMetric('סוללה', b ? b.percent + '%' : '—', b ? (b.plugged ? 'מחובר לחשמל' : 'על סוללה') : 'אין נתון', b?.percent),
    machineMetric('אחסון פנוי', disk ? gib(disk.free) + ' GiB' : '—', disk ? 'מתוך ' + gib(disk.total) + ' GiB' : 'אין נתון', disk && disk.free / disk.total * 100),
    machineMetric('RAM פנוי', gib(ram.free) + ' GiB', 'מתוך ' + gib(ram.total) + ' GiB', ram.free / ram.total * 100),
  );
  metrics.hidden = false;
  const list = $('#machine-apps');
  list.replaceChildren();
  if (!data.apps?.length) {
    const li = document.createElement('li');
    li.textContent = data.apps ? 'אין אפליקציות גלויות להפעלה זו.' : 'רשימת האפליקציות אינה זמינה כרגע.';
    list.append(li);
  }
  for (const app of data.apps || []) {
    const li = document.createElement('li');
    const name = document.createElement('bdi');
    name.textContent = app.name;
    li.append(name);
    if (app.canQuit) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quit-app';
      button.textContent = 'סגירה';
      button.setAttribute('aria-label', 'בקשת סגירה של ' + app.name);
      button.onclick = () => quitApplication(app);
      li.append(button);
    }
    list.append(li);
  }
}
async function refreshMachine() {
  const id = ++machineRequest;
  const label = $('#machine-state');
  label.textContent = 'בודק במק…';
  $('#machine-refresh').disabled = true;
  try {
    const data = await (await api('/api/mac', { signal: AbortSignal.timeout(9000) })).json();
    if (id !== machineRequest || machineSheet.hidden) return;
    machineSnapshot = data;
    renderMachine(data);
    label.textContent = '';
    markOnline();
  } catch (err) {
    if (id !== machineRequest || machineSheet.hidden) return;
    if (handleUnauthorized(err)) { machineSnapshot = null; $('#machine-metrics').hidden = true; $('#machine-apps').replaceChildren(); machineSheet.hidden = true; return; }
    label.textContent = err.status ? 'לא הצלחתי לקבל נתונים מהמק.' : 'המק לא זמין. אפשר לנסות שוב כשהחיבור יחזור.';
    $('#machine-apps').replaceChildren();
    if (machineSnapshot) $('#machine-time').textContent = 'נתונים אחרונים · ' + when(machineSnapshot.sampledAt);
  } finally {
    if (id === machineRequest) $('#machine-refresh').disabled = false;
  }
}
async function quitApplication(app) {
  if (quitBusy) return;
  quitBusy = true;
  const note = $('#quit-note');
  try {
    if (!await confirmDialog({ title: 'לסגור את ' + app.name + '?', message: 'תישלח בקשת סגירה רגילה. אם יש מסמך פתוח, ייתכן שתתבקש לשמור אותו על המק.', confirm:'בקש סגירה' })) return;
    await api('/api/mac/apps/quit', {method:'POST', signal:AbortSignal.timeout(16000), body:JSON.stringify({bundle:app.bundle, pid:app.pid, started:app.started, confirmed:true})});
    note.textContent = 'בקשת הסגירה נשלחה ל־' + app.name + '.';
    await refreshMachine();
  } catch (e) {
    if (!handleUnauthorized(e)) note.textContent = e.status ? e.message : 'לא התקבל אישור מהמק. רענן כדי לבדוק אם האפליקציה עדיין פתוחה.';
  } finally { quitBusy = false; }
}
function openMachine() {
  closeDrawer();
  machineSheet.hidden = false;
  $('#quit-note').textContent = '';
  void refreshMachine();
}
for (const id of ['#mac-status','#home-mac','#machine-btn']) $(id).addEventListener('click', openMachine);
$('#camera-btn').addEventListener('click', openCamera);
$('#camera-start').addEventListener('click', () => void startLive());
$('#camera-stop').addEventListener('click', () => stopLive('הצפייה נעצרה.'));
// Closing the screen (any way) or leaving the app stops the camera on the Mac.
new MutationObserver(() => {
  if (cameraSheet.hidden) {
    stopLive();
    $('#camera-frame').removeAttribute('src');
    if (cameraFrameUrl) URL.revokeObjectURL(cameraFrameUrl);
    cameraFrameUrl = null;
  }
}).observe(cameraSheet, { attributes: true, attributeFilter: ['hidden'] });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && cameraController) stopLive('הצפייה נעצרה כשיצאת מהאפליקציה.');
});
$('#machine-refresh').addEventListener('click', refreshMachine);

// Temporary, opt-in iPhone measurements. Only geometry leaves the render loop;
// the trace stays in this page's memory unless the user copies it.
let recording = false;
$('#keyboard-record').addEventListener('click', () => {
  if (recording) return;
  recording = true;
  machineSheet.hidden = true;
  const started = performance.now();
  const rows = ['v22  ms focus inner vv pageTop headerY composerBottom'];
  let previous = '';
  function sample(now) {
    const metrics = [document.activeElement === composerInput ? 1 : 0, innerHeight, viewport?.height ?? innerHeight,
      viewport?.pageTop ?? scrollY, $('.topbar').getBoundingClientRect().top, $('#composer').getBoundingClientRect().bottom];
    const row = metrics.map(Math.round).join(' ');
    if (row !== previous) { rows.push(Math.round(now - started) + ' ' + row); previous = row; }
    if (now - started < 6000) { requestAnimationFrame(sample); return; }
    recording = false;
    $('#keyboard-log').textContent = rows.join('\n');
    $('#keyboard-copy').hidden = false;
  }
  requestAnimationFrame(sample);
});
$('#keyboard-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#keyboard-log').textContent); $('#keyboard-copy').textContent = 'הועתק'; }
  catch { window.getSelection()?.selectAllChildren($('#keyboard-log')); }
});

// ---------------- settings ----------------
const THINKING_HINTS = {
  auto: 'מהיר. החשיבה נדלקת לבד רק אם המודל מסתבך עם פעולה.',
  off: 'הכי מהיר. בלי חשיבה בכלל.',
  on: 'הכי מדויק. כל תשובה לוקחת כמה שניות יותר.',
};

async function openSettings() {
  closeDrawer();
  $('#settings-sheet').hidden = false;
  $('#settings-status').textContent = '';
  void checkFileAccess();
  void checkGoogle();
  void checkApple();
  void renderPush();
  try {
    const s = await (await api('/api/settings')).json();
    const select = $('#model-select');
    select.replaceChildren(
      ...s.models.map((m) => {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = m;
        o.selected = m === s.localModel;
        return o;
      }),
    );
    if (!s.models.includes(s.localModel)) {
      const o = document.createElement('option');
      o.value = s.localModel;
      o.textContent = `${s.localModel} (לא מותקן)`;
      o.selected = true;
      select.prepend(o);
    }
    for (const r of document.querySelectorAll('input[name="thinking"]')) r.checked = r.value === s.thinking;
    $('#thinking-hint').textContent = THINKING_HINTS[s.thinking];
    renderCloudSettings(s.cloud);
  } catch (err) {
    if (handleUnauthorized(err)) return;
    $('#settings-status').textContent = err.message;
  }
}

async function checkApple() {
  const list = $('#apple-state');
  list.replaceChildren();
  const row = (ok, text) => {
    const li = document.createElement('li');
    li.className = ok ? 'ok' : '';
    li.textContent = `${ok ? '✓' : '✗'} ${text}`;
    list.append(li);
  };
  try {
    const a = await (await api('/api/apple', { signal: AbortSignal.timeout(25000) })).json();
    $('#apple-help').hidden = Boolean(a.installed && a.calendar === 'full' && a.reminders === 'full' && a.contacts === 'full');
    if (!a.installed) return row(false, 'לא מחובר');
    const state = (s) => (s === 'full' ? '' : s === 'denied' ? ' · חסום בהגדרות המק' : s === 'notDetermined' ? ' · עוד לא אושר' : ` · ${s}`);
    row(a.calendar === 'full', `יומן${state(a.calendar)}`);
    row(a.reminders === 'full', `תזכורות${state(a.reminders)}`);
    row(a.contacts === 'full', `אנשי קשר${state(a.contacts)}`);
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'פתקים והודעות: נבדקים בשימוש (npm run apple:setup מאשר אותם)';
    list.append(li);
  } catch (err) {
    if (handleUnauthorized(err)) return;
    row(false, err.message);
  }
}

const renewText = (ms) => new Date(ms).toLocaleString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

/** While the Google app is in Testing, Google cancels the permission every 7 days: say so a day before. */
let renewalShown = false;
async function remindGoogleRenewal() {
  if (renewalShown) return;
  try {
    const g = await (await api('/api/google', { signal: AbortSignal.timeout(6000) })).json();
    const soon = (g.accounts ?? []).filter((a) => a.renewBy && a.renewBy - Date.now() < 86_400_000);
    if (!soon.length) return;
    renewalShown = true;
    const names = soon.map((a) => a.label).join(' ו־');
    const past = soon.every((a) => a.renewBy < Date.now());
    confirmDialog({
      title: past ? `החיבור ל־Google פג (${names})` : `החיבור ל־Google פג בקרוב (${names})`,
      message: 'כדי שמייל ויומן ימשיכו לעבוד: במק, בטרמינל בתיקיית brain, להריץ npm run google:connect ולאשר בדפדפן. זה לוקח דקה.',
      confirm: 'הבנתי',
      cancel: '',
    });
  } catch {
    // not important enough to bother the user
  }
}

async function checkGoogle() {
  const line = $('#google-state');
  const list = $('#google-accounts');
  try {
    const g = await (await api('/api/google')).json();
    const accounts = g.accounts ?? [];
    list.replaceChildren(
      ...accounts.map((acc) => {
        const li = document.createElement('li');
        li.className = 'google-account';
        const name = document.createElement('span');
        name.dir = 'auto';
        const expired = acc.renewBy && acc.renewBy < Date.now();
        name.textContent = `${expired ? '✗' : '✓'} ${acc.label} · ${acc.email}`;
        if (acc.renewBy) {
          const when = document.createElement('small');
          when.className = 'hint';
          when.textContent = expired ? ' · פג, צריך לחבר מחדש' : ` · לחדש עד ${renewText(acc.renewBy)}`;
          name.append(when);
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'secondary danger-text';
        btn.textContent = 'ניתוק';
        btn.addEventListener('click', () => disconnectGoogle(acc));
        li.append(name, btn);
        return li;
      }),
    );
    line.textContent = g.connected
      ? accounts.length > 1 ? `מחוברים ${accounts.length} חשבונות. שליחה ברירת מחדל מ־${accounts[0].label}.` : 'מחובר.'
      : g.configured ? 'לא מחובר. קובץ ההרשאה מ־Google קיים, נשאר רק לאשר.' : 'לא מחובר.';
    $('#google-help').hidden = false;
  } catch (err) {
    if (handleUnauthorized(err)) return;
    line.textContent = err.message;
  }
}

async function disconnectGoogle(acc) {
  const sure = await confirmDialog({
    title: `לנתק את ${acc.label}?`,
    message: `בריין לא יוכל לקרוא את המייל והיומן של ${acc.email} עד שתחבר שוב במק (npm run google:connect). ההרשאה תבוטל גם אצל Google.`,
    confirm: 'ניתוק',
    danger: true,
  });
  if (!sure) return;
  try {
    await api('/api/google/disconnect', { method: 'POST', body: JSON.stringify({ account: acc.key }) });
  } catch (err) {
    if (handleUnauthorized(err)) return;
    $('#settings-status').textContent = err.message;
  }
  checkGoogle();
}

async function saveSetting(change) {
  $('#settings-status').textContent = 'שומר…';
  try {
    const s = await (await api('/api/settings', { method: 'PUT', body: JSON.stringify(change) })).json();
    $('#settings-status').textContent = 'נשמר ✓';
    $('#thinking-hint').textContent = THINKING_HINTS[s.thinking];
    if (s.cloud) {
      renderCloudSettings(s.cloud);
      if (state.status) state.status.cloud = s.cloud;
      if (!store.conversationId && !state.engineTouched) state.engine = defaultEngine();
      renderEngineChip();
    }
    if (state.status) {
      state.status.localModel = s.localModel;
      state.status.ollama.modelInstalled = true;
      renderStatus();
    }
  } catch (err) {
    if (handleUnauthorized(err)) return;
    $('#settings-status').textContent = err.message;
  }
}

async function checkFileAccess() {
  const list = $('#access-list');
  list.replaceChildren();
  try {
    const { node, folders } = await (await api('/api/files/access')).json();
    let missing = false;
    for (const f of folders) {
      if (f.missing) continue;
      const li = document.createElement('li');
      li.className = f.ok ? 'ok' : 'bad';
      li.textContent = `${f.ok ? '✓' : '✗'} ${f.name}`;
      list.append(li);
      if (!f.ok) missing = true;
    }
    $('#node-path').textContent = node;
    $('#access-hint').hidden = !missing;
  } catch (err) {
    handleUnauthorized(err);
  }
}

// ---------------- memory ----------------
async function openMemory() {
  closeDrawer();
  $('#memory-sheet').hidden = false;
  $('#memory-status').textContent = '';
  await renderMemories();
}

async function renderMemories() {
  const list = $('#memory-list');
  try {
    const items = await (await api('/api/memories')).json();
    list.replaceChildren();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'memory-empty';
      li.textContent = 'הזיכרון ריק. אפשר להוסיף כאן, או לכתוב בשיחה "תזכור ש…".';
      list.append(li);
    }
    for (const m of items.slice().reverse()) list.append(memoryItem(m));
  } catch (err) {
    handleUnauthorized(err);
  }
}

function memoryItem(m) {
  const li = document.createElement('li');
  const main = document.createElement('div');
  main.className = 'm-main';
  const text = document.createElement('span');
  text.className = 'm-text';
  text.textContent = m.text;
  const meta = document.createElement('span');
  meta.className = 'm-meta';
  meta.textContent = `#${m.id} · ${m.source === 'chat' ? 'נשמר בשיחה' : 'נוסף ידנית'} · ${dayFmt.format(new Date(m.updated_at))}`;
  main.append(text, meta);

  const actions = document.createElement('div');
  actions.className = 'm-actions';
  const edit = document.createElement('button');
  edit.innerHTML = ICONS.pencil;
  edit.setAttribute('aria-label', `עריכת: ${m.text}`);
  edit.onclick = () => {
    const area = document.createElement('textarea');
    area.value = m.text;
    area.rows = 2;
    area.maxLength = 500;
    text.replaceWith(area);
    area.focus();
    edit.innerHTML = ICONS.check;
    edit.setAttribute('aria-label', 'שמירה');
    edit.onclick = async () => {
      const value = area.value.trim();
      if (!value) return;
      try {
        await api(`/api/memories/${m.id}`, { method: 'PUT', body: JSON.stringify({ text: value }) });
        $('#memory-status').textContent = 'נשמר ✓';
        renderMemories();
      } catch (err) {
        if (!handleUnauthorized(err)) $('#memory-status').textContent = err.message;
      }
    };
  };
  const del = document.createElement('button');
  del.innerHTML = ICONS.trash;
  del.setAttribute('aria-label', `מחיקת: ${m.text}`);
  del.onclick = async () => {
    if (!(await confirmDialog({ title: 'למחוק מהזיכרון?', message: m.text, confirm: 'מחיקה', danger: true }))) return;
    try {
      await api(`/api/memories/${m.id}`, { method: 'DELETE' });
      $('#memory-status').textContent = 'נמחק';
      li.remove();
    } catch (err) {
      if (!handleUnauthorized(err)) $('#memory-status').textContent = err.message;
    }
  };
  actions.append(edit, del);
  li.append(main, actions);
  return li;
}

async function addMemory(e) {
  e.preventDefault();
  const input = $('#memory-input');
  const text = input.value.trim();
  if (!text) return;
  try {
    await api('/api/memories', { method: 'POST', body: JSON.stringify({ text }) });
    input.value = '';
    $('#memory-status').textContent = 'נוסף ✓';
    renderMemories();
  } catch (err) {
    if (!handleUnauthorized(err)) $('#memory-status').textContent = err.message;
  }
}

// ---------------- activity log ----------------
const THINKING_NAMES = { auto: 'אוטומטי', off: 'כבוי', on: 'פועל' };
function describe(a) {
  const d = a.detail;
  const tool = a.toolLabel || d.tool;
  switch (a.kind) {
    case 'chat':
      return {
        what: d.aborted ? 'תשובה שנעצרה' : 'תשובה',
        details: [d.model, d.thinking ? 'חשיבה' : null, d.sentToCloud ? 'נשלח לענן' : 'נשאר במק',
          d.costUsd ? `$${d.costUsd.toFixed(4)}` : null, a.deviceName]
          .filter(Boolean)
          .join(' · '),
      };
    case 'tool.run':
      return { what: `${tool} ${d.ok ? '✓' : '✗'}`, details: d.ok ? d.summary || 'רץ במק' : d.error, bad: !d.ok };
    case 'memory.added':
      return { what: 'נוספה עובדה לזיכרון', details: [d.text, a.deviceName].filter(Boolean).join(' · ') };
    case 'memory.edited':
      return { what: 'עובדה בזיכרון נערכה', details: `${d.before} ← ${d.text}` };
    case 'memory.deleted':
      return { what: 'עובדה נמחקה מהזיכרון', details: d.text };
    case 'tool.invalid':
      return { what: 'קריאה לא תקינה לכלי', details: d.error, bad: true };
    case 'action.proposed':
      return { what: `הוצעה פעולה: ${tool}`, details: a.deviceName };
    case 'action.approved':
      return { what: `אושרה: ${tool}${d.edited ? ' (אחרי עריכה)' : ''}`, details: a.deviceName };
    case 'action.rejected':
      return { what: `בוטלה: ${tool}`, details: a.deviceName };
    case 'action.expired':
      return { what: `לא אושרה ולא בוצעה: ${tool}` };
    case 'device.paired':
      return { what: `מכשיר חובר: ${d.name}` };
    case 'device.revoked':
      return { what: 'מכשיר נותק' };
    case 'device.pair_failed':
      return { what: 'ניסיון צימוד עם קוד שגוי', bad: true };
    case 'device.pairing_locked':
      return { what: 'יותר מדי ניסיונות צימוד: כל הקודים בוטלו', bad: true };
    case 'settings.changed':
      return {
        what: 'הגדרות שונו',
        details: [
          d.localModel && `מודל: ${d.localModel}`,
          d.thinking && `חשיבה: ${THINKING_NAMES[d.thinking] || d.thinking}`,
          d.cloud && `ענן: ${{ local: 'מקומי בלבד', ask: 'כשמבקשים', cloud: 'תמיד בענן' }[d.cloud.mode]}`,
          a.deviceName,
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'engine.changed':
      return { what: d.engine === 'cloud' ? 'שיחה עברה לענן' : 'שיחה חזרה למק', details: d.fromCard ? 'מכרטיס ההצעה' : 'מהמתג באפליקציה' };
    case 'agent.started':
      return { what: `נשלחה הודעה ל־${d.agent === 'codex' ? 'Codex' : 'Claude Code'}`, details: d.project };
    case 'agent.done':
      return { what: `${d.agent === 'codex' ? 'Codex' : 'Claude Code'} סיים`, details: d.project };
    case 'agent.failed':
      return { what: `${d.agent === 'codex' ? 'Codex' : 'Claude Code'} נעצר בשגיאה`, details: d.project };
    case 'agent.limited':
      return { what: `${d.agent === 'codex' ? 'Codex' : 'Claude Code'}: נגמר ה־usage, ימשיך כשיתחדש`, details: d.project };
    case 'memory.imported':
      return { what: `יובאו ${d.count} עובדות לזיכרון` };
    case 'cloud.failed':
      return { what: 'הענן לא ענה, ענה המק', details: d.error };
    case 'cloud.suggested':
      return { what: 'הוצע לעבור לענן' };
    case 'cloud.unavailable':
      return { what: 'לא עבר לענן', details: d.reason };
    case 'conversation.deleted':
      return { what: 'שיחה נמחקה', details: a.deviceName };
    case 'chat.error':
      return { what: 'שגיאה בתשובה', details: d.error, bad: true };
    default:
      return { what: a.kind };
  }
}

async function openActivity() {
  closeDrawer();
  $('#activity-sheet').hidden = false;
  const list = $('#activity-list');
  list.replaceChildren();
  try {
    const items = await (await api('/api/audit')).json();
    for (const a of items) {
      const { what, details, bad } = describe(a);
      const li = document.createElement('li');
      const w = document.createElement('span');
      w.className = `what${bad ? ' bad' : ''}`;
      w.textContent = what;
      li.append(w);
      if (details) {
        const det = document.createElement('span');
        det.className = 'details';
        det.textContent = details;
        li.append(det);
      }
      const t = document.createElement('span');
      t.className = 'when';
      t.textContent = `${dayFmt.format(new Date(a.ts))} ${timeFmt.format(new Date(a.ts))}`;
      li.append(t);
      list.append(li);
    }
  } catch (err) {
    handleUnauthorized(err);
  }
}

// ---------------- wiring ----------------
$('#pair-code').addEventListener('input', (e) => {
  const digits = e.target.value.replace(/\D/g, '').slice(0, 8);
  e.target.value = digits.length > 4 ? `${digits.slice(0, 4)}-${digits.slice(4)}` : digits;
});

$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    const res = await api('/api/pair', {
      method: 'POST',
      body: JSON.stringify({ code: $('#pair-code').value, deviceName: $('#pair-name').value }),
    });
    const { token } = await res.json();
    store.token = token;
    $('#pair-code').value = '';
    await showChat();
  } catch (err) {
    $('#pair-error').hidden = false;
    $('#pair-error').textContent =
      err instanceof Unauthorized ? 'קוד שגוי או שפג תוקפו.' : err.message || 'החיבור נכשל.';
  } finally {
    button.disabled = false;
  }
});

const input = $('#input');
function updateInputSize() {
  input.style.height = 'auto';
  if (input.value) input.style.height = `${input.scrollHeight}px`;
  updateComposer();
}
function saveInputDraft() {
  $('#draft-warning').hidden = drafts.write(store.conversationId, input.value);
  updateInputSize();
}
function restoreDraft() {
  const draft = drafts.read(store.conversationId);
  if (input.value !== draft) input.value = draft;
  updateInputSize();
}
input.addEventListener('input', saveInputDraft);
input.addEventListener('keydown', (e) => {
  // Enter sends on a computer; on a phone the return key adds a line.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if ((!text && !attachReady()) || attachBusy() || state.streaming || state.online === false) return;
  send(text, input.value, takeAttachments());
});
$('#attach-btn').addEventListener('click', () => $('#attach-input').click());
$('#attach-input').addEventListener('change', (e) => {
  const chosen = [...e.target.files];
  e.target.value = '';
  addAttachments(chosen);
});
$('#stop-btn').addEventListener('click', stopAnswer);
for (const b of document.querySelectorAll('.suggestion[data-text]')) {
  b.addEventListener('click', () => {
    const text = b.dataset.text;
    // Complete requests are sent at once; ones that end mid-sentence wait for the rest.
    if (/[?.]$/.test(text) || text.endsWith('שלי')) {
      input.value = text;
      saveInputDraft();
      $('#composer').requestSubmit();
    } else {
      input.value = text;
      saveInputDraft();
      input.focus({ preventScroll: true });
      input.setSelectionRange(text.length, text.length);
      updateComposer();
    }
  });
}
$('#new-btn').addEventListener('click', newConversation);
$('#menu-btn').addEventListener('click', openDrawer);
$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-backdrop').addEventListener('click', closeDrawer);
$('#settings-btn').addEventListener('click', openSettings);
$('#memory-btn').addEventListener('click', openMemory);
$('#access-btn').addEventListener('click', checkFileAccess);
$('#memory-form').addEventListener('submit', addMemory);
$('#search-input').addEventListener('input', onSearchInput);
// While searching, the results get the room (the keyboard leaves little), not the menu below them.
const markSearching = () => $('#drawer').classList.toggle('searching', document.activeElement === $('#search-input') || Boolean($('#search-input').value.trim()));
$('#search-input').addEventListener('focus', markSearching);
$('#search-input').addEventListener('blur', markSearching);
$('#search-input').addEventListener('input', markSearching);
$('#file-viewer-close').addEventListener('click', closeViewer);
$('#file-viewer-share').addEventListener('click', shareViewerFile);
$('#activity-btn').addEventListener('click', openActivity);
for (const sheet of document.querySelectorAll('.sheet')) {
  const close = () => (sheet.hidden = true);
  sheet.querySelector('.sheet-close').addEventListener('click', close);
  sheet.querySelector('.sheet-backdrop').addEventListener('click', close);
}
$('#model-select').addEventListener('change', (e) => saveSetting({ localModel: e.target.value }));
for (const r of document.querySelectorAll('input[name="cloud-mode"]')) {
  r.addEventListener('change', () => saveSetting({ cloud: { mode: r.value } }));
}
$('#cloud-provider').addEventListener('change', (e) => saveSetting({ cloud: { provider: e.target.value } }));
$('#push-btn').addEventListener('click', togglePush);
$('#push-test').addEventListener('click', testPush);
$('#push-preview').addEventListener('change', async (e) => {
  try {
    await api('/api/push', { method: 'PUT', body: JSON.stringify({ preview: e.target.checked }) });
  } catch (err) {
    if (!handleUnauthorized(err)) $('#push-state').textContent = err.message;
  }
});
// The switch next to the box must not close the keyboard: it never takes focus from the text box,
// and if iOS moved focus anyway, it goes back within the same tap.
{
  const btn = $('#engine-btn');
  let typing = false;
  btn.addEventListener('pointerdown', () => (typing = document.activeElement === $('#input')));
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    if (typing && document.activeElement !== $('#input')) $('#input').focus({ preventScroll: true });
    typing = false;
    toggleEngine();
  });
}
for (const r of document.querySelectorAll('input[name="thinking"]')) {
  r.addEventListener('change', () => saveSetting({ thinking: r.value }));
}
$('#unpair-btn').addEventListener('click', async () => {
  const sure = await confirmDialog({
    title: 'לנתק את המכשיר הזה?',
    message: 'כדי להתחבר שוב תצטרך קוד צימוד חדש מהמק.',
    confirm: 'ניתוק',
    danger: true,
  });
  if (!sure) return;
  try {
    if (state.status?.device?.id) await api(`/api/devices/${state.status.device.id}`, { method: 'DELETE' });
  } catch {
    // Even if the Mac is unreachable, forget the token locally.
  }
  store.token = null;
  store.conversationId = null;
  closeDrawer();
  showPair();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.token) {
    checkHealth();
    warm();
  }
});
window.addEventListener('online', () => store.token && showChat());
$('#retry-mac').addEventListener('click', showChat);
window.addEventListener('offline', () => {
  state.online = false;
  renderStatus();
});
setInterval(() => {
  if (store.token && document.visibilityState === 'visible') checkHealth();
}, 15_000);

// Updates: the app opens from the copy saved on the phone (sw.js). When a newer version has been
// downloaded, switch to it right away, instead of only at the next opening. Never in the middle of
// an answer or while typing: then wait until that's done.
if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  const reloadWhenIdle = () => {
    if (reloading) return;
    // Busy = an answer is streaming, or there's text the user started writing (a draft would be lost).
    const draft = [...document.querySelectorAll('textarea, input:not([type]), input[type="text"], input[type="search"]')].some(
      (el) => el.value.trim() && el.offsetParent !== null,
    );
    const busy = state.streaming || draft;
    if (busy) return setTimeout(reloadWhenIdle, 2000);
    reloading = true;
    location.reload();
  };
  // A notification tapped while the app was open.
  navigator.serviceWorker.addEventListener('message', (e) => {
    const id = e.data?.type === 'open' ? conversationFromUrl(e.data.url) : null;
    if (id && store.token) {
      closeDrawer();
      for (const sheet of document.querySelectorAll('.sheet')) sheet.hidden = true;
      void openConversation(id);
    }
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) reloadWhenIdle(); // the very first install isn't an update
  });
  navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => {
      reg.update().catch(() => {});
      // Coming back to the app also checks for a newer version.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {});
}

// Opened from a notification: start at its conversation.
{
  const id = conversationFromUrl(location.href);
  if (location.search) history.replaceState(null, '', '/');
  if (id && store.token) store.conversationId = id;
}
if (store.token) showChat();
else showPair();
