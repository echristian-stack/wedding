import { createStore, readAllLocal } from './store.js';
import { GUIDE, GUIDE_SOURCE, guideTaskId } from './guide.js';

/* ============================================================
   1. Util
   ============================================================ */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const rupiah = n => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const PEOPLE = ['Erik', 'Oni'];
const DAY = 86400000;
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const today = () => startOfDay(new Date());
const parseISO = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const toISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function addMonths(d, n) {
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
  r.setDate(Math.min(d.getDate(), new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate()));
  return r;
}
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const fmtDate = iso => parseISO(iso).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = iso => parseISO(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtWhen = ms => new Date(ms).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });

// Pengingat disimpan sebagai waktu mutlak (epoch ms) supaya benar walau beda zona waktu.
function msToInput(ms) {
  if (!ms) return '';
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const inputToMs = v => { if (!v) return 0; const t = new Date(v).getTime(); return Number.isFinite(t) ? t : 0; };

function diffMD(from, to) {
  let m = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (addMonths(from, m) > to) m--;
  return { m, days: Math.round((to - addMonths(from, m)) / DAY), total: Math.round((to - from) / DAY) };
}
function hash32(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) % 2000000000 + 1; }

/* ============================================================
   2. Konfigurasi & state
   ============================================================ */
const CFG_KEY = 'wedding.cfg.v2';
const loadCfg = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; } };
const saveCfg = c => { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch {} };
let cfg = Object.assign({ mode: 'local', room: '', firebaseConfig: null, me: '', pushUrl: '', pushSecret: '' }, loadCfg());

const DEFAULT_GROUPS = [
  { id: 'g-zoom', name: 'Grup Zoom' },
  { id: 'g-balai', name: 'Balai Kerajaan' },
  { id: 'g-balai-makan', name: 'Balai Kerajaan + Makan Bersama' }
];
const META0 = { id: 'settings', weddingDate: '', budgetTarget: 0, groups: DEFAULT_GROUPS, autoRemind: true };
const S = { tasks: [], guests: [], budget: [], photos: {}, meta: { ...META0 } };
const live = {                       // hanya yang belum dihapus
  tasks: () => S.tasks.filter(t => !t.deletedAt),
  guests: () => S.guests.filter(g => !g.deletedAt),
  budget: () => S.budget.filter(b => !b.deletedAt)
};

let store = null;
let tab = sessionStorage.getItem('tab') || 'home';
const ui = { taskSort: 'due', taskFilter: 'open', guestGroup: 'all', guestSearch: '' };
let swReg = null, booted = false;

// mode efek (Full / Light) untuk HP yang terasa berat
const fx = localStorage.getItem('wedding.fx') || 'full';
if (fx === 'light') document.documentElement.dataset.fx = 'light';

/* ============================================================
   3. Jembatan Capacitor (hanya aktif di dalam APK)
   ============================================================ */
const Cap = window.Capacitor;
const native = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const plugin = n => (Cap && Cap.Plugins && Cap.Plugins[n]) || null;

async function initNative() {
  if (!native) return;
  // tombol Back Android
  const App = plugin('App');
  if (App) App.addListener('backButton', ({ canGoBack }) => {
    if (overlays.length || canGoBack) history.back(); else App.exitApp();
  });
  // notifikasi lokal (pengingat terjadwal — jalan walau aplikasi tertutup)
  const LN = plugin('LocalNotifications');
  if (LN) { try { await LN.requestPermissions(); } catch (e) { console.warn(e); } }
  // push (kabar dari pasangan)
  const PN = plugin('PushNotifications');
  if (PN && cfg.pushUrl) {
    try {
      // Android 8+ wajib punya channel, kalau tidak notifikasinya tidak muncul.
      if (PN.createChannel) await PN.createChannel({ id: 'wedding', name: 'Kabar dari pasangan', importance: 5, visibility: 1 }).catch(() => {});
      const p = await PN.requestPermissions();
      if (p.receive === 'granted') {
        PN.addListener('registration', t => registerDevice(t.value));
        PN.addListener('registrationError', e => console.warn('push reg error', e));
        await PN.register();
      }
    } catch (e) { console.warn(e); }
  }
}
async function registerDevice(token) {
  if (!token || !store || store.mode !== 'cloud') return;
  try {
    await store.put('devices', { id: 'd' + hash32(token), token, owner: cfg.me, ts: Date.now() });
  } catch (e) { console.warn('simpan device gagal', e); }
}

/* ============================================================
   4. Toast, notifikasi, efek confetti
   ============================================================ */
function toast(msg, ms = 4200, action) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'soft'; b.style.cssText = 'margin-left:10px;pointer-events:auto';
    b.textContent = action.label;
    b.onclick = () => { action.fn(); el.remove(); };
    el.appendChild(b);
    el.style.pointerEvents = 'auto';
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
async function notify(title, body, tag) {
  toast('🔔 ' + title + (body ? ' — ' + body : ''), 7000);
  if (navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch {} }
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const opts = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' };
      if (swReg) await swReg.showNotification(title, opts); else new Notification(title, opts);
    }
  } catch (e) { console.warn(e); }
}

const LOVE = 'cinta kamu, ade❤️!';
let cvs, ctx, parts = [], raf = 0;
const cele = e => celebrate(e && e.clientX, e && e.clientY);
function celebrate(x, y) {
  const m = document.createElement('div');
  m.className = 'love'; m.textContent = LOVE;
  document.body.appendChild(m); setTimeout(() => m.remove(), 2300);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || fx === 'light') return;
  if (!cvs) { cvs = document.createElement('canvas'); cvs.className = 'confetti'; document.body.appendChild(cvs); ctx = cvs.getContext('2d'); }
  fitCanvas();
  const ox = x ?? innerWidth / 2, oy = y ?? innerHeight * .62;
  const col = ['#ff6b9d', '#ffc94d', '#5ad1b0', '#6aa7ff', '#b58cff', '#ff8a5c', '#ffffff'];
  for (let i = 0; i < 110; i++) {
    const a = -Math.PI / 2 + (Math.random() - .5) * Math.PI * 1.15, v = 6 + Math.random() * 10;
    parts.push({ x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: .2 + Math.random() * .1,
      w: 6 + Math.random() * 6, h: 4 + Math.random() * 5, r: Math.random() * 6, vr: (Math.random() - .5) * .45,
      c: col[i % col.length], life: 0, max: 85 + Math.random() * 55, star: Math.random() < .25 });
  }
  if (!raf) raf = requestAnimationFrame(tick);
}
/* Ukuran kanvas mengikuti layar, termasuk saat keyboard HP muncul/hilang (tinggi layar berubah). */
function fitCanvas() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
  if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
}
function clearCanvas() { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cvs.width, cvs.height); }
function tick() {
  fitCanvas();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  clearCanvas(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  parts = parts.filter(p => p.life < p.max);
  for (const p of parts) {
    p.vx *= .99; p.vy += p.g; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life++;
    const k = p.life / p.max;
    ctx.globalAlpha = k > .65 ? 1 - (k - .65) / .35 : 1;
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
    if (p.star) {
      const s = p.w * (.7 + .5 * Math.abs(Math.sin(p.life * .3)));
      ctx.shadowColor = p.c; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(0, -s);
      ctx.quadraticCurveTo(0, 0, s, 0); ctx.quadraticCurveTo(0, 0, 0, s);
      ctx.quadraticCurveTo(0, 0, -s, 0); ctx.quadraticCurveTo(0, 0, 0, -s); ctx.fill();
    } else { ctx.scale(1, Math.cos(p.r * 2)); ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  raf = parts.length ? requestAnimationFrame(tick) : (clearCanvas(), 0);
}

/* ============================================================
   5. Tumpukan overlay (tombol Back Android menutup form, bukan aplikasi)
   ============================================================ */
const overlays = [];
function pushOverlay(close) { overlays.push(close); history.pushState({ ov: overlays.length }, ''); }
function popOverlay() { if (overlays.length) history.back(); }
window.addEventListener('popstate', () => { const f = overlays.pop(); if (f) f(); });

/* ============================================================
   6. Penyimpanan: tulis + kabari pasangan
   ============================================================ */
const stamp = o => ({ ...o, updatedAt: Date.now(), updatedBy: cfg.me });

async function put(col, obj, ping) { await store.put(col, stamp(obj)); pushPing(ping); }
async function patch(col, id, fields, ping) { await store.patch(col, id, stamp(fields)); pushPing(ping); }
const saveMeta = p => store.patch('meta', 'settings', stamp({ ...p, id: 'settings' }));

// Kirim kabar ke HP pasangan lewat Cloudflare Worker (opsional; gagal pun tidak mengganggu).
let pingTimer = 0, pingQueue = [];
function pushPing(text) {
  if (!text || !cfg.pushUrl || store?.mode !== 'cloud') return;
  pingQueue.push(text);
  clearTimeout(pingTimer);
  pingTimer = setTimeout(async () => {
    const list = pingQueue.splice(0);
    const body = list.length > 1 ? `${list.length} perubahan` : list[0];
    try {
      await fetch(cfg.pushUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: cfg.pushSecret, room: cfg.room, from: cfg.me, title: `${cfg.me} mengubah sesuatu`, body })
      });
    } catch (e) { console.warn('push gagal (diabaikan)', e.message); }
  }, 2500);
}

/* ============================================================
   7. Boot
   ============================================================ */
async function boot() {
  if ('serviceWorker' in navigator && !native) {
    navigator.serviceWorker.register('./sw.js').then(r => { swReg = r; }).catch(() => {});
  }
  if (!cfg.me || (cfg.mode === 'local' && !cfg.seen)) return renderOnboarding();
  await start();
}

async function start() {
  try {
    store = await createStore(cfg, onStatus);
  } catch (e) {
    console.error(e);
    toast('Sinkronisasi gagal: ' + (e.code || e.message) + '. Memakai mode lokal.', 8000);
    store = await createStore({ mode: 'local' });
    setStatus('Local (cloud gagal)', 'err');
  }
  if (store.mode === 'local') setStatus('Local', '');

  store.subscribe('meta', items => {
    const m = items.find(x => x.id === 'settings');
    if (m) S.meta = { ...META0, ...m };
    render(); syncReminders();
  });
  store.subscribe('tasks', (items, ch) => { S.tasks = items; remoteToast(ch, 'tugas'); render(); syncReminders(); });
  store.subscribe('guests', (items, ch) => { S.guests = items; remoteToast(ch, 'tamu'); render(); });
  store.subscribe('budget', (items, ch) => { S.budget = items; remoteToast(ch, 'budget'); render(); });
  store.subscribe('photos', items => { S.photos = Object.fromEntries(items.map(p => [p.id, p.data])); render(); });

  if (cfg.migrate && store.mode === 'cloud') migrateLocal();
  booted = true;
  render();

  await initNative();
  setInterval(checkReminders, 20000);
  setInterval(purgeTrash, 6 * 3600 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkReminders(); syncReminders(); } });
  setTimeout(() => { checkReminders(); showSinceLastSeen(); purgeTrash(); }, 1200);
}

function onStatus(s) {
  if (s.error) setStatus('Error: ' + s.error, 'err');
  else if (s.online) setStatus('● Synced', 'ok');
  else setStatus('Offline (saved locally)', '');
}
function setStatus(text, cls) { const el = $('#status'); el.textContent = text; el.className = 'status ' + (cls || ''); }

function remoteToast(changes, label) {
  if (!booted) return;
  (changes || []).filter(c => c.data.updatedBy && c.data.updatedBy !== cfg.me).slice(0, 3)
    .forEach(c => toast(`${c.data.updatedBy} ${c.type === 'added' ? 'menambah' : 'mengubah'} ${label}: ${c.data.title || c.data.name || ''}`));
}
async function migrateLocal() {
  const rows = await readAllLocal();
  for (const r of rows) await store.put(r.col, r.obj);
  cfg.migrate = false; saveCfg(cfg);
  if (rows.length) toast(`${rows.length} data lokal diunggah ke cloud.`);
}

/* ringkasan "sejak terakhir dibuka" */
function showSinceLastSeen() {
  const key = 'wedding.lastSeen';
  const last = Number(localStorage.getItem(key) || 0);
  localStorage.setItem(key, String(Date.now()));
  if (!last || store.mode !== 'cloud') return;
  const all = [...S.tasks, ...S.guests, ...S.budget];
  const changed = all.filter(x => x.updatedBy && x.updatedBy !== cfg.me && (x.updatedAt || 0) > last);
  if (!changed.length) return;
  const who = [...new Set(changed.map(x => x.updatedBy))].join(' & ');
  const names = changed.slice(0, 4).map(x => '• ' + (x.title || x.name)).join('<br>');
  openModal(`<div class="m-head"><h2>Sejak terakhir dibuka</h2><button class="x" data-m="close">✕</button></div>
    <p class="muted small">${esc(who)} mengubah ${changed.length} hal sejak ${esc(fmtWhen(last))}.</p>
    <div class="card">${names}${changed.length > 4 ? `<div class="muted small" style="margin-top:6px">dan ${changed.length - 4} lainnya</div>` : ''}</div>
    <div class="m-foot"><button class="primary" data-m="close">Oke</button></div>`,
    { click: (e, b) => { if (b.dataset.m === 'close') closeModal(); } });
}

/* ============================================================
   8. Pengingat
   ============================================================ */
function pendingReminders() {
  const out = [], auto = S.meta.autoRemind !== false;
  for (const t of live.tasks()) {
    if (t.done) continue;
    let at = Number(t.remindAt) || 0;
    if (!at && auto && t.due) {                       // auto H-1 jam 09.00
      const d = addDays(parseISO(t.due), -1); d.setHours(9, 0, 0, 0); at = d.getTime();
    }
    if (at) out.push({ key: t.id + '|' + at, at, title: t.title, body: 'Tugas', who: t.assignee });
    for (const [sid, s] of Object.entries(t.subtasks || {})) {
      if (s.done || !s.remindAt) continue;
      out.push({ key: sid + '|' + s.remindAt, at: Number(s.remindAt), title: s.title,
        body: 'Subtugas dari "' + t.title + '"', who: s.assignee || t.assignee });
    }
  }
  return out.filter(r => !r.who || r.who === cfg.me).sort((a, b) => a.at - b.at);
}

// Dipakai saat aplikasi terbuka (dan sebagai cadangan di browser).
const FIRED_KEY = 'wedding.fired.v2';
let fired = new Set(JSON.parse(localStorage.getItem(FIRED_KEY) || '[]'));
function checkReminders() {
  if (!cfg.me || !store) return;
  const now = Date.now();
  const due = pendingReminders().filter(r => r.at <= now && !fired.has(r.key));
  if (!due.length) return;
  due.forEach(r => fired.add(r.key));
  localStorage.setItem(FIRED_KEY, JSON.stringify([...fired].slice(-500)));
  const recent = due.filter(r => now - r.at < 7 * DAY);
  recent.slice(0, 4).forEach(r => notify('Pengingat: ' + r.title, r.body, r.key));
  if (recent.length > 4) notify(`Ada ${recent.length - 4} pengingat lain`, 'Buka tab Tasks', 'more');
}

// Di APK: serahkan ke Android supaya bunyi walau aplikasi tertutup.
let lastSig = '';
async function syncReminders() {
  const LN = plugin('LocalNotifications');
  if (!native || !LN) return;
  const future = pendingReminders().filter(r => r.at > Date.now() + 5000).slice(0, 60);
  const sig = future.map(r => r.key).join(',');
  if (sig === lastSig) return;
  lastSig = sig;
  try {
    const pend = await LN.getPending();
    if (pend.notifications?.length) await LN.cancel({ notifications: pend.notifications });
    if (!future.length) return;
    await LN.schedule({
      notifications: future.map(r => ({
        id: hash32(r.key), title: 'Pengingat: ' + r.title, body: r.body,
        schedule: { at: new Date(r.at), allowWhileIdle: true }
      }))
    });
  } catch (e) { console.warn('jadwal notifikasi gagal', e); }
}

/* ============================================================
   9. Modal, lightbox, foto
   ============================================================ */
const modalEl = $('#modal'), mbody = $('#modal-body');
let mctx = null;
function openModal(html, c) {
  mctx = c || null;
  mbody.innerHTML = html;
  modalEl.classList.add('open');
  document.body.classList.add('noscroll');
  mbody.scrollTop = 0;
  pushOverlay(() => hardCloseModal());
}
const setModalHtml = h => { const s = mbody.scrollTop; mbody.innerHTML = h; mbody.scrollTop = s; };
function hardCloseModal() {
  if (mctx && mctx.onClose) { const f = mctx.onClose; mctx = null; f(); }
  modalEl.classList.remove('open');
  document.body.classList.remove('noscroll');
  mbody.innerHTML = ''; mctx = null;
}
const closeModal = () => popOverlay();

mbody.addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (b && mctx?.click) mctx.click(e, b); });
mbody.addEventListener('input', e => { if (mctx?.input) mctx.input(e); });
modalEl.addEventListener('click', e => { if (e.target === modalEl) closeModal(); });

let lbDel = null;
function openLightbox(src, onDelete) {
  $('#lb-img').src = src; $('#lightbox').hidden = false;
  lbDel = onDelete; $('#lb-del').hidden = !onDelete;
  pushOverlay(() => { $('#lightbox').hidden = true; lbDel = null; });
}
$('#lb-close').onclick = () => popOverlay();
$('#lb-del').onclick = () => { const f = lbDel; popOverlay(); if (f) f(); };

async function compress(file, max = 900, q = .72) {
  let src = await createImageBitmap(file).catch(() => null), w, h;
  if (src) { w = src.width; h = src.height; }
  else {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const r = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * r); c.height = Math.round(h * r);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  let out = c.toDataURL('image/jpeg', q);
  // Firestore membatasi ukuran satu dokumen; turunkan mutu bila perlu.
  for (let i = 0; out.length > 700000 && i < 4; i++) out = c.toDataURL('image/jpeg', q - .15 * (i + 1));
  return out;
}
function pickPhotos(onId) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
  inp.onchange = async () => {
    for (const f of inp.files) {
      try {
        const data = await compress(f);
        if (data.length > 900000) { toast('Foto terlalu besar, lewati: ' + f.name); continue; }
        const id = uid();
        S.photos[id] = data;
        await store.put('photos', { id, data, ts: Date.now(), updatedBy: cfg.me });
        onId(id);
      } catch (e) { toast('Foto gagal diproses: ' + e.message); }
    }
  };
  inp.click();
}

/* ============================================================
   10. Helper tampilan
   ============================================================ */
const whoPill = n => n
  ? `<span class="who ${n === 'Erik' ? 'erik' : 'oni'}"><i>${esc(n[0])}</i>${esc(n)}</span>`
  : `<span class="who none"><i>?</i>Unassigned</span>`;
const groupName = id => (S.meta.groups.find(g => g.id === id) || {}).name || '(grup dihapus)';
const weddingDate = () => S.meta.weddingDate ? parseISO(S.meta.weddingDate) : null;
const guideDue = g => { const w = weddingDate(); return w ? addDays(addMonths(w, -g.months), -g.days) : null; };
const guideDueISO = (g, dateStr) => toISO(addDays(addMonths(parseISO(dateStr), -g.months), -g.days));
const subList = t => Object.entries(t.subtasks || {}).map(([id, s]) => ({ id, ...s })).sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));

/* soft delete + undo */
async function softDelete(col, id, label) {
  await patch(col, id, { deletedAt: Date.now() });
  toast(`"${label}" dihapus.`, 8000, { label: 'Undo', fn: () => patch(col, id, { deletedAt: 0 }) });
}
async function purgeTrash() {
  if (!store) return;
  const cut = Date.now() - 30 * DAY;
  for (const col of ['tasks', 'guests', 'budget']) {
    for (const o of S[col]) if (o.deletedAt && o.deletedAt < cut) await store.del(col, o.id);
  }
}

/* ============================================================
   11. Render
   ============================================================ */
const view = $('#view');
function render() {
  if (!booted) return;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const keep = {};
  view.querySelectorAll('[data-keep]').forEach(el => { keep[el.id] = { v: el.value, f: document.activeElement === el, s: el.selectionStart, e: el.selectionEnd }; });
  view.innerHTML = ({ home: renderHome, tasks: renderTasks, guests: renderGuests, budget: renderBudget, settings: renderSettings }[tab])();
  view.querySelectorAll('[data-keep]').forEach(el => { const k = keep[el.id]; if (k) { el.value = k.v; if (k.f) { el.focus(); try { el.setSelectionRange(k.s, k.e); } catch {} } } });
}
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  tab = b.dataset.tab; sessionStorage.setItem('tab', tab); render(); scrollTo(0, 0);
});

/* ---------- Onboarding ---------- */
function renderOnboarding() {
  document.querySelector('.tabs').style.display = 'none';
  view.innerHTML = `<div class="hero"><div class="ring">💍</div><h1>Erik &amp; Oni</h1>
      <p class="muted">Rencana pernikahan kita, di satu tempat.</p></div>
    <div class="card"><b>Baru mulai?</b>
      <p class="muted small">Buat ruang baru, lalu kirim undangan ke pasanganmu.</p>
      <button class="primary block" data-action="ob-new">Start new</button></div>
    <div class="card"><b>Sudah dapat undangan?</b>
      <p class="muted small">Tempel teks undangan dari pasanganmu agar semua data langsung muncul.</p>
      <button class="ghost block" data-action="ob-join">Join with invite</button></div>
    <div class="card"><b>Coba dulu tanpa sinkronisasi</b>
      <p class="muted small">Data hanya tersimpan di HP ini dan tidak terhubung ke pasanganmu.</p>
      <button class="ghost block" data-action="ob-local">Pakai mode lokal</button></div>`;
}
function askWho(next) {
  openModal(`<div class="m-head"><h2>Siapa kamu?</h2></div>
    <p class="muted">Dipakai untuk label "diubah oleh" dan pengingat yang ditujukan ke kamu.</p>
    <div class="row">${PEOPLE.map(p => `<button class="primary grow" data-m="me" data-v="${p}">${p}</button>`).join('')}</div>`,
    { click(e, b) { if (b.dataset.m === 'me') { cfg.me = b.dataset.v; saveCfg(cfg); hardCloseModal(); overlays.pop(); next(); } } });
}

/* ---------- Home ---------- */
function renderHome() {
  const w = weddingDate(), t0 = today();
  const editBtn = '<button class="edit-dl" data-action="edit-deadline">✎ Edit deadline</button>';
  const BITS = '<div class="bits"><b></b><b></b><b></b><b></b><b></b></div>';
  /* Banner countdown: satu bentuk untuk semua keadaan */
  const banner = (eyebrow, num, chip, bar, soon) => `<div class="card count cdA${soon ? ' pulse' : ''}">${BITS}
    <div class="hd"><div class="ic">🥳</div><div><div class="eyebrow">${eyebrow}</div><div class="tag">Erik &amp; Oni</div></div></div>
    ${num ? `<div class="num">${num}</div>` : ''}${chip ? `<div class="chip">${chip}</div>` : ''}${bar || ''}${editBtn}</div>`;
  let count;
  if (!w) {
    count = banner('Countdown to wedding day', '', 'Deadline belum diatur · pilih tanggal pernikahan', '', false);
  } else if (w < t0) {
    count = banner('Selamat! 🎉', '', '📅 ' + esc(fmtDate(S.meta.weddingDate)) + ' sudah lewat', '', false);
  } else if (+w === +t0) {
    count = banner('Hari ini hari H 💍', '', '📅 ' + esc(fmtDate(S.meta.weddingDate)), '', true);
  } else {
    const d = diffMD(t0, w), soon = d.total <= 30;
    /* Awal perjalanan: tanggal pertama ada data (atau hari ini). Ini hanya tafsiran aplikasi untuk bar kemajuan. */
    const stamps = [...S.tasks, ...S.guests, ...S.budget].map(o => o.updatedAt).filter(x => x > 1e11);
    let start = S.meta.startDate ? parseISO(S.meta.startDate) : (stamps.length ? startOfDay(new Date(Math.min(...stamps))) : t0);
    if (!start || start > t0) start = t0;
    const span = Math.max(1, Math.round((w - start) / DAY));
    const gone = Math.min(100, Math.max(0, Math.round((Math.round((t0 - start) / DAY)) / span * 100)));
    const bar = `<div class="prog"><i style="width:${gone}%"></i></div><div class="plab">Perjalanan menuju hari H · ${gone}%</div>`;
    let num;
    if (soon) num = `<span class="n">${d.total}</span><span class="u">hari lagi</span>`;
    else {
      num = '';
      if (d.m) num += `<span class="n">${d.m}</span><span class="u">bulan</span>`;
      if (d.days || !d.m) num += `<span class="n">${d.days}</span><span class="u">hari</span>`;
    }
    const date = esc(fmtDate(S.meta.weddingDate));
    count = banner(soon ? 'Tinggal sebentar lagi! 🎊' : 'Countdown to wedding day', num,
      soon ? `📅 ${date}` : `📅 ${date} · ${d.total} hari lagi`, bar, soon);
  }
  const all = live.tasks(), done = all.filter(t => t.done).length;
  const pct = all.length ? Math.round(done / all.length * 100) : 0;
  const progress = `<div class="card"><div class="row"><b class="grow">Task progress</b><span class="muted">${done}/${all.length} · ${pct}%</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div></div>`;
  const soon = all.filter(t => !t.done && t.due && parseISO(t.due) <= addDays(t0, 7))
    .sort((a, b) => a.due.localeCompare(b.due)).slice(0, 8);
  return count + progress + (soon.length ? '<h2>Needs attention</h2>' + soon.map(taskCard).join('') : '') + renderGuide();
}

function renderGuide() {
  const w = weddingDate(), t0 = today(), src = GUIDE_SOURCE, tasks = live.tasks();
  let missing = false; const overdue = [];
  const blocks = GUIDE.map(g => {
    const due = guideDue(g);
    const rows = g.items.map((text, i) => {
      const task = tasks.find(t => t.id === guideTaskId(g.key, i));
      if (!task) missing = true;
      const isDone = task && task.done;
      if (due && due <= t0 && !isDone) overdue.push(text);
      return task
        ? `<div class="guide-item"><button class="chk ${isDone ? 'on' : ''}" data-action="toggle-task" data-id="${task.id}" aria-label="Done"></button>
            <div class="grow" data-action="open-task" data-id="${task.id}" style="${isDone ? 'text-decoration:line-through;color:var(--muted)' : ''}">${esc(text)}</div></div>`
        : `<div class="guide-item"><span class="dot">•</span><div class="grow">${esc(text)} <span class="muted small">(not in Tasks yet)</span></div></div>`;
    }).join('');
    let chip = '';
    if (due) {
      const left = g.items.filter((_, i) => { const t = tasks.find(x => x.id === guideTaskId(g.key, i)); return !(t && t.done); }).length;
      chip = due <= t0 ? (left ? `<span class="pill red">Overdue · ${left} left</span>` : '<span class="pill sage">Done</span>')
        : due <= addDays(t0, 31) ? '<span class="pill amber">Within 31 days</span>' : '<span class="pill">Upcoming</span>';
    }
    return `<div class="card"><div class="row wrap"><b class="grow">${esc(g.label)}</b>${chip}</div>
      ${due ? `<div class="muted small">Estimated deadline: ${esc(fmtShort(toISO(due)))}</div>` : ''}${rows}</div>`;
  }).join('');
  return `<h2>Preparation guide</h2>
    ${!w ? '<div class="card muted">Atur deadline dulu agar tenggat tiap tahap dihitung otomatis.</div>' : ''}
    ${overdue.length ? `<div class="card" style="border-color:var(--warn)"><b>Should be done by now (${overdue.length})</b>
      <ul style="margin:6px 0 0 18px;padding:0">${overdue.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${w && missing ? '<button class="primary block" data-action="import-guide" style="margin-bottom:10px">Import guide to Tasks</button>' : ''}
    ${blocks}
    <div class="card small muted"><b>Sumber butir tugas:</b> ${esc(src.publication)}, "${esc(src.article)}" — ${esc(src.where)}.<br>
      <a href="${src.url}" target="_blank" rel="noopener">${src.url}</a><br>${esc(src.footnote)}<br><br>
      <b>Note (app interpretation):</b> tanggal deadline dihitung otomatis dari label waktu (mis. "4 bulan" dianggap 4 bulan sebelum hari H;
      "6 bulan sebelumnya atau lebih" dianggap 6 bulan). Perhitungan ini bukan bagian dari sumber.</div>`;
}

async function importGuide() {
  let n = 0;
  const have = new Set(S.tasks.map(t => t.id));
  for (const g of GUIDE) {
    const due = guideDue(g);
    for (let i = 0; i < g.items.length; i++) {
      const id = guideTaskId(g.key, i);
      if (have.has(id)) continue;
      await store.put('tasks', stamp({ id, title: g.items[i], done: false, assignee: '', due: due ? toISO(due) : '',
        remindAt: 0, notes: '', photos: [], subtasks: {}, group: g.key, deletedAt: 0 }));
      n++;
    }
  }
  toast(n ? `${n} tugas dari panduan ditambahkan.` : 'Semua butir panduan sudah ada di Tasks.');
  if (n) { celebrate(); pushPing('mengimpor panduan persiapan'); }
}

function deadlineModal() {
  openModal(`<div class="m-head"><h2>Edit deadline</h2><button class="x" data-m="cancel">✕</button></div>
    <p class="muted small">Tanggal pernikahan adalah deadline utama. Deadline tiap tahap di Guide dihitung dari tanggal ini.</p>
    <label>Wedding date<input type="date" id="dl-date" value="${esc(S.meta.weddingDate)}"></label>
    <div class="m-foot"><button class="ghost" data-m="cancel">Cancel</button><button class="primary" data-m="save">Save</button></div>`, {
    async click(e, b) {
      if (b.dataset.m === 'cancel') return closeModal();
      if (b.dataset.m !== 'save') return;
      const v = $('#dl-date', mbody).value;
      if (!v) return toast('Pilih tanggal dulu.');
      const old = S.meta.weddingDate;
      await saveMeta({ weddingDate: v });
      if (old && old !== v) {
        const stale = live.tasks().filter(t => t.group && GUIDE.some(g => g.key === t.group && t.due === guideDueISO(g, old)));
        if (stale.length && confirm(`Hitung ulang deadline ${stale.length} tugas dari Guide mengikuti tanggal baru?`)) {
          for (const t of stale) await store.patch('tasks', t.id, stamp({ due: guideDueISO(GUIDE.find(g => g.key === t.group), v) }));
        }
      }
      pushPing('mengubah tanggal pernikahan');
      cele(e); closeModal();
    }
  });
}

/* ---------- Tasks ---------- */
function taskCard(t) {
  const subs = subList(t), sd = subs.filter(s => s.done).length;
  const over = !t.done && t.due && parseISO(t.due) < today();
  return `<div class="card task ${t.done ? 'done' : ''}" data-action="open-task" data-id="${t.id}">
    <button class="chk ${t.done ? 'on' : ''}" data-action="toggle-task" data-id="${t.id}" aria-label="Done"></button>
    <div class="grow"><div class="t-title">${esc(t.title)}</div><div>${whoPill(t.assignee)}
      ${t.due ? `<span class="pill ${over ? 'red' : ''}">${over ? 'Overdue · ' : ''}${esc(fmtShort(t.due))}</span>` : ''}
      ${subs.length ? `<span class="pill">${sd}/${subs.length} subtasks</span>` : ''}
      ${(t.photos || []).length ? `<span class="pill">📷 ${t.photos.length}</span>` : ''}
      ${t.notes ? '<span class="pill">📝</span>' : ''}${t.remindAt ? '<span class="pill">🔔</span>' : ''}</div></div></div>`;
}
function renderTasks() {
  const f = ui.taskFilter, srt = ui.taskSort, all = live.tasks(), open = all.filter(t => !t.done);
  const n = w => open.filter(t => (t.assignee || '') === w).length;
  const summary = `<div class="who-sum">
    <button class="${f === 'Erik' ? 'on' : ''} erik" data-action="task-filter" data-v="Erik"><i>E</i><b>${n('Erik')}</b><span>Erik</span></button>
    <button class="${f === 'Oni' ? 'on' : ''} oni" data-action="task-filter" data-v="Oni"><i>O</i><b>${n('Oni')}</b><span>Oni</span></button>
    <button class="${f === 'none' ? 'on' : ''} none" data-action="task-filter" data-v="none"><i>?</i><b>${n('')}</b><span>Unassigned</span></button></div>`;
  const chips = [['open', 'To do'], ['all', 'All'], ['Erik', 'Erik'], ['Oni', 'Oni'], ['none', 'Unassigned'], ['done', 'Done']]
    .map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-action="task-filter" data-v="${k}">${l}</button>`).join('');
  let list = all.slice();
  if (f === 'open') list = list.filter(t => !t.done);
  else if (f === 'done') list = list.filter(t => t.done);
  else if (f === 'Erik' || f === 'Oni') list = list.filter(t => t.assignee === f);
  else if (f === 'none') list = list.filter(t => !t.assignee && !t.done);
  list.sort(srt === 'name' ? (a, b) => a.title.localeCompare(b.title, 'id')
    : (a, b) => (a.done - b.done) || (a.due || '9999').localeCompare(b.due || '9999') || a.title.localeCompare(b.title));
  let body;
  if (!list.length) body = '<div class="empty">No tasks in this filter.<br>Tap ＋ to add one.</div>';
  else if (srt === 'who') body = [['Erik', "Erik's tasks"], ['Oni', "Oni's tasks"], ['', 'Unassigned']].map(([w, label]) => {
    const part = list.filter(t => (t.assignee || '') === w);
    return part.length ? `<h3 class="grp ${w ? w.toLowerCase() : 'none'}">${label} <span>${part.length}</span></h3>` + part.map(taskCard).join('') : '';
  }).join('');
  else body = list.map(taskCard).join('');
  return `${summary}<div class="chips">${chips}</div>
    <div class="sortbar"><span class="muted small">Sort by</span><select id="t-sort">${
      [['due', 'Deadline'], ['who', 'By person (Erik / Oni / unassigned)'], ['name', 'Name A–Z']]
        .map(([k, l]) => `<option value="${k}" ${srt === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    ${body}<button class="fab" data-action="new-task" aria-label="Add task">＋</button>`;
}

function taskModal(id) {
  const orig = id ? S.tasks.find(t => t.id === id) : null;
  const isNew = !orig;
  const d = orig ? structuredClone(orig)
    : { id: uid(), title: '', done: false, assignee: '', due: '', remindAt: 0, notes: '', photos: [], subtasks: {}, group: '', deletedAt: 0 };
  d.photos ??= []; d.subtasks ??= {};
  const added = new Set(), removed = new Set(), opened = new Set();
  let subs = subList(d);

  const opts = v => '<option value="">— Unassigned —</option>' + PEOPLE.map(p => `<option ${v === p ? 'selected' : ''}>${p}</option>`).join('');
  const photoBlock = (ids, tgt) => `<div class="photos">${ids.map(p => S.photos[p]
    ? `<img src="${S.photos[p]}" data-m="view-photo" data-pid="${p}" data-tgt="${tgt}" alt="Foto" loading="lazy">`
    : '<div class="ph"></div>').join('')}<button class="addph" data-m="add-photo" data-tgt="${tgt}">＋ Photo</button></div>`;

  const html = () => `<div class="m-head"><h2>${isNew ? 'New task' : 'Edit task'}</h2><button class="x" data-m="cancel">✕</button></div>
    <label>Title<input data-f="title" value="${esc(d.title)}" placeholder="mis. Pesan tempat resepsi"></label>
    <div class="row2"><label>Assigned to<select data-f="assignee">${opts(d.assignee)}</select></label>
      <label>Deadline<input type="date" data-f="due" value="${esc(d.due)}"></label></div>
    <label>Reminder<input type="datetime-local" data-f="remindAt" value="${msToInput(d.remindAt)}"></label>
    <label>Notes<textarea data-f="notes" rows="3" placeholder="Catatan untuk tugas ini…">${esc(d.notes)}</textarea></label>
    <label>Photos</label>${photoBlock(d.photos, 'task')}
    <h3>Subtasks</h3>
    ${subs.map((s, i) => `<div class="sub"><div class="sub-top">
        <button class="chk ${s.done ? 'on' : ''}" data-m="sub-done" data-i="${i}" aria-label="Done"></button>
        <input data-sf="title" data-i="${i}" value="${esc(s.title)}" placeholder="Subtask title">
        <button class="ico" data-m="sub-open" data-i="${i}">${opened.has(s.id) ? '▴' : '▾'}</button>
        <button class="ico" data-m="sub-del" data-i="${i}" aria-label="Delete">🗑</button></div>
      ${opened.has(s.id) ? `<div class="sub-det">
        <label>For<select data-sf="assignee" data-i="${i}">${opts(s.assignee)}</select></label>
        <label>Reminder<input type="datetime-local" data-sf="remindAt" data-i="${i}" value="${msToInput(s.remindAt)}"></label>
        <label>Notes<textarea data-sf="notes" data-i="${i}" rows="2">${esc(s.notes || '')}</textarea></label>
        <label>Photos</label>${photoBlock(s.photos || [], s.id)}</div>`
      : `<div class="small muted" style="padding:4px 4px 0">${s.assignee ? whoPill(s.assignee) : ''}${s.notes ? '📝 ' : ''}${(s.photos || []).length ? '📷 ' + s.photos.length + ' ' : ''}${s.remindAt ? '🔔 ' : ''}</div>`}
      </div>`).join('')}
    <div class="add-sub"><input id="new-sub" placeholder="Add subtask…"><button class="soft" data-m="add-sub">Add</button></div>
    <div class="m-foot">${isNew ? '' : '<button class="danger" data-m="delete">Delete</button>'}
      <button class="ghost" data-m="cancel">Cancel</button><button class="primary" data-m="save">Save</button></div>`;

  const redraw = focus => { setModalHtml(html()); if (focus) $(focus, mbody)?.focus(); };
  const listOf = tgt => tgt === 'task' ? d.photos : (subs.find(s => s.id === tgt).photos ??= []);
  const cleanupNew = () => { for (const p of added) { delete S.photos[p]; store.del('photos', p); } };
  const addSub = () => {
    const inp = $('#new-sub', mbody), v = inp.value.trim(); if (!v) return;
    subs.push({ id: uid(), title: v, done: false, assignee: '', remindAt: 0, notes: '', photos: [], ord: subs.length });
    redraw('#new-sub');
  };

  openModal(html(), {
    onClose: cleanupNew,
    input(e) {
      const t = e.target;
      if (t.dataset.f) d[t.dataset.f] = t.dataset.f === 'remindAt' ? inputToMs(t.value) : t.value;
      else if (t.dataset.sf) {
        const s = subs[+t.dataset.i];
        s[t.dataset.sf] = t.dataset.sf === 'remindAt' ? inputToMs(t.value) : t.value;
      }
    },
    async click(e, b) {
      const a = b.dataset.m, i = +b.dataset.i;
      if (a === 'cancel') return closeModal();
      if (a === 'add-sub') return addSub();
      if (a === 'sub-done') { subs[i].done = !subs[i].done; if (subs[i].done) celebrate(e.clientX, e.clientY); return redraw(); }
      if (a === 'sub-open') { const s = subs[i].id; opened.has(s) ? opened.delete(s) : opened.add(s); return redraw(); }
      if (a === 'sub-del') { (subs[i].photos || []).forEach(p => removed.add(p)); subs.splice(i, 1); subs.forEach((s, k) => s.ord = k); return redraw(); }
      if (a === 'add-photo') { const tgt = b.dataset.tgt; return pickPhotos(p => { listOf(tgt).push(p); added.add(p); redraw(); }); }
      if (a === 'view-photo') {
        const pid = b.dataset.pid, tgt = b.dataset.tgt;
        return openLightbox(S.photos[pid], () => {
          const arr = listOf(tgt), k = arr.indexOf(pid);
          if (k >= 0) arr.splice(k, 1);
          if (added.has(pid)) { added.delete(pid); delete S.photos[pid]; store.del('photos', pid); } else removed.add(pid);
          redraw();
        });
      }
      if (a === 'delete') {
        if (!confirm('Pindahkan tugas ini ke Recently deleted?')) return;
        mctx.onClose = null;
        await softDelete('tasks', d.id, d.title);
        pushPing(`menghapus tugas: ${d.title}`);
        return closeModal();
      }
      if (a === 'save') {
        if (!d.title.trim()) return toast('Judul tugas wajib diisi.');
        d.title = d.title.trim();
        d.subtasks = {};
        subs.filter(s => s.title.trim()).forEach((s, k) => {
          const { id: sid, ...rest } = s;
          d.subtasks[sid] = { ...rest, title: rest.title.trim(), ord: k };
        });
        mctx.onClose = null;                         // foto baru dipertahankan
        if (isNew) await put('tasks', d, `menambah tugas: ${d.title}`);
        else {
          const gone = Object.keys(orig.subtasks || {}).filter(k => !d.subtasks[k]);
          const diff = diffDoc(orig, d);
          if (Object.keys(diff).length) await patch('tasks', d.id, diff, `mengubah tugas: ${d.title}`);
          if (gone.length) await store.drop('tasks', d.id, gone.map(k => 'subtasks.' + k));
        }
        for (const p of removed) { delete S.photos[p]; store.del('photos', p); }
        celebrate(e.clientX, e.clientY);
        return closeModal();
      }
    }
  });
  mbody.onkeydown = e => { if (e.key === 'Enter' && e.target.id === 'new-sub') { e.preventDefault(); addSub(); } };
}

// Hanya kolom yang benar-benar berubah yang dikirim, supaya tidak menimpa editan pasangan.
function diffDoc(orig, now) {
  const out = {};
  for (const k of Object.keys(now)) {
    if (k === 'subtasks') continue;
    if (!eq(now[k], orig?.[k])) out[k] = now[k];
  }
  const subs = {};
  for (const [sid, s] of Object.entries(now.subtasks || {})) {
    const o = orig?.subtasks?.[sid];
    if (!o) { subs[sid] = s; continue; }
    const d = {};
    for (const k of Object.keys(s)) if (!eq(s[k], o[k])) d[k] = s[k];
    if (Object.keys(d).length) subs[sid] = d;
  }
  if (Object.keys(subs).length) out.subtasks = subs;
  return out;
}

/* ---------- Guests ---------- */
const RSVP = [['yes', 'Hadir', 'yes'], ['no', 'Tidak', 'no'], ['invited', 'Diundang', 'inv']];
function renderGuests() {
  const groups = S.meta.groups, gf = ui.guestGroup, q = ui.guestSearch.toLowerCase();
  const all = live.guests();
  const pax = g => Math.max(1, Number(g.pax) || 1);
  let list = all.slice().sort((a, b) => a.name.localeCompare(b.name, 'id'));
  if (gf !== 'all') list = list.filter(g => (g.groups || []).includes(gf));
  if (q) list = list.filter(g => g.name.toLowerCase().includes(q));
  const lastSel = JSON.parse(sessionStorage.getItem('lastGroups') || '[]');
  const chips = `<button class="chip ${gf === 'all' ? 'on' : ''}" data-action="guest-group" data-v="all">All (${all.length})</button>` +
    groups.map(g => `<button class="chip ${gf === g.id ? 'on' : ''}" data-action="guest-group" data-v="${g.id}">${esc(g.name)} (${all.filter(x => (x.groups || []).includes(g.id)).length})</button>`).join('');
  const scope = gf === 'all' ? all : all.filter(g => (g.groups || []).includes(gf));
  const yes = scope.filter(g => g.rsvp === 'yes');
  const stat = `<div class="stat" style="margin-bottom:10px">
    <div class="card"><div class="muted small">${gf === 'all' ? 'Semua tamu' : esc(groupName(gf))}</div><div class="n">${scope.length} undangan</div></div>
    <div class="card"><div class="muted small">Konfirmasi hadir</div><div class="n" style="color:var(--sage)">${yes.length} · ${yes.reduce((a, g) => a + pax(g), 0)} orang</div></div></div>`;
  const perGroup = gf === 'all' && groups.length ? `<div class="card"><b>Total per grup</b>${groups.map(g => {
    const m = all.filter(x => (x.groups || []).includes(g.id)), y = m.filter(x => x.rsvp === 'yes');
    return `<div class="item"><div class="grow">${esc(g.name)}<div class="muted small">${m.length} undangan</div></div>
      <div class="price">${y.reduce((a, x) => a + pax(x), 0)} orang<div class="muted small" style="font-weight:400">hadir</div></div></div>`;
  }).join('')}</div>` : '';
  return `<div class="chips">${chips}</div>${stat}
    <div class="card"><b>Quick add guest</b>
      <input id="g-name" data-keep placeholder="Guest / family name" autocomplete="off">
      <div class="checks">${groups.map(g => `<label><input type="checkbox" class="g-grp" value="${g.id}" ${lastSel.includes(g.id) ? 'checked' : ''}>${esc(g.name)}</label>`).join('')}</div>
      <div class="row" style="margin-top:10px"><button class="primary grow" data-action="add-guest">Add</button>
      <button class="soft" data-action="manage-groups">Manage groups</button></div></div>
    ${perGroup}
    <input id="g-search" data-keep placeholder="Search name…" value="${esc(ui.guestSearch)}" style="margin-bottom:10px">
    <div id="g-list">${list.length ? `<div class="card" style="padding:4px 14px">${list.map(g => `<div class="item">
      <div class="grow" data-action="open-guest" data-id="${g.id}" style="cursor:pointer"><b>${esc(g.name)}</b>
        ${pax(g) > 1 ? `<span class="pill">${pax(g)} orang</span>` : ''}
        ${g.phone ? `<span class="muted small">${esc(g.phone)}</span>` : ''}
        <div>${(g.groups || []).map(id => `<span class="pill">${esc(groupName(id))}</span>`).join('')}</div>
        ${g.note ? `<div class="muted small">${esc(g.note)}</div>` : ''}
        <div class="rsvp">${RSVP.map(([v, l, c]) => `<button class="${g.rsvp === v ? 'on ' + c : ''}" data-action="rsvp" data-id="${g.id}" data-v="${v}">${l}</button>`).join('')}</div>
      </div></div>`).join('')}</div>` : '<div class="empty">Belum ada tamu di daftar ini.</div>'}</div>`;
}
function guestModal(id) {
  const ex = S.guests.find(g => g.id === id);
  const g = ex ? structuredClone(ex) : { id: uid(), name: '', groups: [], note: '', phone: '', rsvp: 'invited', pax: 1, deletedAt: 0 };
  g.groups ??= [];
  openModal(`<div class="m-head"><h2>Edit guest</h2><button class="x" data-m="cancel">✕</button></div>
    <label>Name<input id="gm-name" value="${esc(g.name)}"></label>
    <div class="row2"><label>Phone (optional)<input id="gm-phone" type="tel" value="${esc(g.phone || '')}"></label>
      <label>Jumlah orang<input id="gm-pax" type="number" inputmode="numeric" min="1" value="${Math.max(1, Number(g.pax) || 1)}"></label></div>
    <label>RSVP<select id="gm-rsvp">${RSVP.map(([v, l]) => `<option value="${v}" ${g.rsvp === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Groups</label><div class="checks">${S.meta.groups.map(x => `<label><input type="checkbox" class="gm-grp" value="${x.id}" ${g.groups.includes(x.id) ? 'checked' : ''}>${esc(x.name)}</label>`).join('')}</div>
    <label>Notes<textarea id="gm-note" rows="2">${esc(g.note || '')}</textarea></label>
    <div class="m-foot">${ex ? '<button class="danger" data-m="delete">Delete</button>' : ''}
      <button class="ghost" data-m="cancel">Cancel</button><button class="primary" data-m="save">Save</button></div>`, {
    async click(e, b) {
      const a = b.dataset.m;
      if (a === 'cancel') return closeModal();
      if (a === 'delete') { if (confirm('Pindahkan tamu ini ke Recently deleted?')) { await softDelete('guests', g.id, g.name); closeModal(); } return; }
      if (a !== 'save') return;
      const name = $('#gm-name', mbody).value.trim();
      if (!name) return toast('Nama wajib diisi.');
      const now = { ...g, name, phone: $('#gm-phone', mbody).value.trim(), note: $('#gm-note', mbody).value.trim(),
        pax: Math.max(1, Number($('#gm-pax', mbody).value) || 1), rsvp: $('#gm-rsvp', mbody).value,
        groups: [...mbody.querySelectorAll('.gm-grp:checked')].map(x => x.value) };
      if (ex) { const d = diffDoc(ex, now); if (Object.keys(d).length) await patch('guests', g.id, d, `mengubah tamu: ${name}`); }
      else await put('guests', now, `menambah tamu: ${name}`);
      cele(e); closeModal();
    }
  });
}
function groupsModal() {
  const draw = () => `<div class="m-head"><h2>Manage guest groups</h2><button class="x" data-m="close">✕</button></div>
    <p class="muted small">Contoh: Grup Zoom, Balai Kerajaan, Balai Kerajaan + Makan Bersama. Menghapus grup tidak menghapus tamunya.</p>
    ${S.meta.groups.map(g => `<div class="row" style="margin-top:8px"><input data-gid="${g.id}" value="${esc(g.name)}"><button class="ico" data-m="gdel" data-id="${g.id}">🗑</button></div>`).join('')}
    <div class="add-sub"><input id="new-grp" placeholder="New group name…"><button class="soft" data-m="gadd">Add</button></div>
    <div class="m-foot"><button class="primary" data-m="close">Done</button></div>`;
  openModal(draw(), {
    input(e) {
      const id = e.target.dataset.gid; if (!id) return;
      S.meta.groups = S.meta.groups.map(g => g.id === id ? { ...g, name: e.target.value } : g);
      clearTimeout(groupsModal.t);
      groupsModal.t = setTimeout(() => saveMeta({ groups: S.meta.groups }), 500);
    },
    async click(e, b) {
      const a = b.dataset.m;
      if (a === 'close') { clearTimeout(groupsModal.t); await saveMeta({ groups: S.meta.groups }); return closeModal(); }
      if (a === 'gadd') {
        const v = $('#new-grp', mbody).value.trim(); if (!v) return;
        S.meta.groups = [...S.meta.groups, { id: 'g-' + uid(), name: v }];
        await saveMeta({ groups: S.meta.groups }); setModalHtml(draw());
      }
      if (a === 'gdel' && confirm('Hapus grup ini?')) {
        S.meta.groups = S.meta.groups.filter(g => g.id !== b.dataset.id);
        await saveMeta({ groups: S.meta.groups }); setModalHtml(draw());
      }
    }
  });
}

/* ---------- Budget ---------- */
const sub$ = i => (Number(i.price) || 0) * (Number(i.qty) || 1);
function budgetRow(i, optional) {
  return `<div class="item">
    <button class="chk ${optional ? (i.pick ? 'on' : '') : (i.paid ? 'on' : '')}" data-action="${optional ? 'toggle-pick' : 'toggle-paid'}" data-id="${i.id}"
      aria-label="${optional ? 'Dipertimbangkan' : 'Paid'}"></button>
    <div class="grow" data-action="open-budget" data-id="${i.id}" style="cursor:pointer"><b>${esc(i.name)}</b>
      <div class="muted small">${i.category ? esc(i.category) + ' · ' : ''}${(Number(i.qty) || 1) > 1 ? i.qty + ' × ' + rupiah(i.price) : ''}${i.notes ? ' · 📝' : ''}${(i.photos || []).length ? ' · 📷' + i.photos.length : ''}</div></div>
    <div class="price">${rupiah(sub$(i))}</div>
    ${optional ? `<button class="soft" data-action="make-sure" data-id="${i.id}">Confirm</button>` : ''}</div>`;
}
function renderBudget() {
  const all = live.budget();
  const sure = all.filter(i => i.status !== 'opsional'), opt = all.filter(i => i.status === 'opsional');
  const tSure = sure.reduce((a, i) => a + sub$(i), 0), tOpt = opt.reduce((a, i) => a + sub$(i), 0);
  const paid = sure.filter(i => i.paid).reduce((a, i) => a + sub$(i), 0);
  const picked = opt.filter(i => i.pick).reduce((a, i) => a + sub$(i), 0);
  const target = Number(S.meta.budgetTarget) || 0;
  const diff = (label, v) => target ? `<div class="row small"><span class="grow muted">${label}</span>
    <b style="color:${target - v < 0 ? 'var(--warn)' : 'var(--sage)'}">${target - v < 0 ? 'Over ' + rupiah(v - target) : 'Left ' + rupiah(target - v)}</b></div>` : '';
  const cats = {};
  sure.forEach(i => { const k = i.category || 'Lainnya'; cats[k] = (cats[k] || 0) + sub$(i); });
  const catRows = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="item">
      <div class="grow">${esc(k)}<div class="bar" style="margin-top:6px"><i style="width:${tSure ? Math.round(v / tSure * 100) : 0}%"></i></div></div>
      <div class="price">${rupiah(v)}<div class="muted small" style="font-weight:400">${tSure ? Math.round(v / tSure * 100) : 0}%</div></div></div>`).join('');
  return `<div class="stat">
      <div class="card"><div class="muted small">Total confirmed</div><div class="n">${rupiah(tSure)}</div></div>
      <div class="card"><div class="muted small">Paid</div><div class="n" style="color:var(--sage)">${rupiah(paid)}</div></div>
      <div class="card"><div class="muted small">Unpaid</div><div class="n">${rupiah(tSure - paid)}</div></div>
      <div class="card"><div class="muted small">Budget target</div><div class="n">${target ? rupiah(target) : '—'}</div></div></div>
    ${target ? `<div class="card" style="margin-top:10px">${diff('Confirmed vs target', tSure)}</div>` : ''}
    <h2>Confirmed items</h2>
    <div class="card" style="padding:4px 14px">${sure.length ? sure.map(i => budgetRow(i, false)).join('') : '<div class="empty">No items yet. Tap ＋ to add.</div>'}
      <div class="total"><span>Total confirmed</span><span>${rupiah(tSure)}</span></div></div>
    ${catRows ? `<h2>Per category</h2><div class="card" style="padding:4px 14px">${catRows}</div>` : ''}
    <h2>Optional (undecided)</h2>
    <div class="muted small" style="margin:-4px 2px 8px">Centang item yang sedang dipertimbangkan untuk melihat simulasi total.</div>
    <div class="card opt" style="padding:4px 14px">${opt.length ? opt.map(i => budgetRow(i, true)).join('') : '<div class="empty">Belum ada item opsional.</div>'}
      <div class="total"><span>Total optional</span><span>${rupiah(tOpt)}</span></div>
      <div class="row small" style="margin-top:6px"><span class="grow muted">Selected</span><b>${rupiah(picked)}</b></div></div>
    <div class="card"><div class="row"><span class="grow muted">Confirmed + selected</span><b>${rupiah(tSure + picked)}</b></div>${diff('vs target', tSure + picked)}
      <div class="row" style="margin-top:6px"><span class="grow muted">Total if all optional confirmed</span><b>${rupiah(tSure + tOpt)}</b></div>${diff('vs target', tSure + tOpt)}</div>
    <button class="fab" data-action="new-budget" aria-label="Add item">＋</button>`;
}
function budgetModal(id) {
  const ex = S.budget.find(i => i.id === id);
  const it = ex ? structuredClone(ex)
    : { id: uid(), name: '', price: '', qty: 1, category: '', status: 'pasti', paid: false, pick: false, notes: '', photos: [], deletedAt: 0 };
  it.photos ??= [];
  const added = new Set(), removed = new Set();
  const cats = [...new Set(live.budget().map(x => x.category).filter(Boolean))];
  const html = () => `<div class="m-head"><h2>${ex ? 'Edit item' : 'New item'}</h2><button class="x" data-m="cancel">✕</button></div>
    <label>Item name<input id="b-name" value="${esc(it.name)}" placeholder="mis. Sewa gedung"></label>
    <div class="row2"><label>Unit price (Rp)<input id="b-price" type="number" inputmode="numeric" min="0" value="${esc(it.price)}"></label>
      <label>Qty<input id="b-qty" type="number" inputmode="numeric" min="1" value="${esc(it.qty)}"></label></div>
    <div class="row2"><label>Category<input id="b-cat" list="b-cats" value="${esc(it.category)}" placeholder="mis. Pakaian"></label>
      <label>Status<select id="b-status"><option value="pasti" ${it.status !== 'opsional' ? 'selected' : ''}>Confirmed</option>
        <option value="opsional" ${it.status === 'opsional' ? 'selected' : ''}>Optional</option></select></label></div>
    <datalist id="b-cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <label>Notes<textarea id="b-notes" rows="2">${esc(it.notes || '')}</textarea></label>
    <label>Photos <span class="muted small">(nota, penawaran)</span></label>
    <div class="photos">${it.photos.map(p => S.photos[p] ? `<img src="${S.photos[p]}" data-m="view-photo" data-pid="${p}" alt="Foto" loading="lazy">` : '<div class="ph"></div>').join('')}
      <button class="addph" data-m="add-photo">＋ Photo</button></div>
    <div class="m-foot">${ex ? '<button class="danger" data-m="delete">Delete</button>' : ''}
      <button class="ghost" data-m="cancel">Cancel</button><button class="primary" data-m="save">Save</button></div>`;
  const grab = () => ({ ...it, name: $('#b-name', mbody).value.trim(), price: Number($('#b-price', mbody).value) || 0,
    qty: Math.max(1, Number($('#b-qty', mbody).value) || 1), category: $('#b-cat', mbody).value.trim(),
    status: $('#b-status', mbody).value, notes: $('#b-notes', mbody).value.trim() });
  const redraw = () => { Object.assign(it, grab()); setModalHtml(html()); };
  openModal(html(), {
    onClose: () => { for (const p of added) { delete S.photos[p]; store.del('photos', p); } },
    async click(e, b) {
      const a = b.dataset.m;
      if (a === 'cancel') return closeModal();
      if (a === 'add-photo') return pickPhotos(p => { it.photos.push(p); added.add(p); redraw(); });
      if (a === 'view-photo') {
        const pid = b.dataset.pid;
        return openLightbox(S.photos[pid], () => {
          const k = it.photos.indexOf(pid); if (k >= 0) it.photos.splice(k, 1);
          if (added.has(pid)) { added.delete(pid); delete S.photos[pid]; store.del('photos', pid); } else removed.add(pid);
          redraw();
        });
      }
      if (a === 'delete') {
        if (!confirm('Pindahkan item ini ke Recently deleted?')) return;
        mctx.onClose = null; await softDelete('budget', it.id, it.name); return closeModal();
      }
      if (a !== 'save') return;
      const now = grab();
      if (!now.name) return toast('Nama item wajib diisi.');
      mctx.onClose = null;
      if (ex) { const d = diffDoc(ex, now); if (Object.keys(d).length) await patch('budget', it.id, d, `mengubah budget: ${now.name}`); }
      else await put('budget', now, `menambah budget: ${now.name}`);
      for (const p of removed) { delete S.photos[p]; store.del('photos', p); }
      celebrate(e.clientX, e.clientY); closeModal();
    }
  });
}

/* ---------- Settings ---------- */
function renderSettings() {
  const cloud = cfg.mode === 'cloud';
  const perm = 'Notification' in window ? Notification.permission : 'tidak didukung';
  const trash = [...S.tasks.map(t => ({ ...t, _c: 'tasks', _n: t.title })), ...S.guests.map(g => ({ ...g, _c: 'guests', _n: g.name })),
    ...S.budget.map(b => ({ ...b, _c: 'budget', _n: b.name }))].filter(x => x.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
  return `<h2>Profile</h2><div class="card"><label style="margin-top:0">I am</label>
      <select id="s-me">${PEOPLE.map(p => `<option ${cfg.me === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
    <h2>Wedding</h2><div class="card">
      <label style="margin-top:0">Wedding date (deadline)</label><input type="date" id="s-date" value="${esc(S.meta.weddingDate)}">
      <label>Budget target (Rp)</label><input type="number" inputmode="numeric" min="0" id="s-target" value="${S.meta.budgetTarget || ''}" placeholder="opsional">
      <label class="checks" style="margin-top:12px"><span style="display:flex;align-items:center;gap:8px;color:var(--ink);font-size:15px">
        <input type="checkbox" id="s-auto" ${S.meta.autoRemind !== false ? 'checked' : ''}>Pengingat otomatis H-1 deadline (09.00)</span></label>
      <button class="primary block" data-action="save-wedding" style="margin-top:12px">Save</button></div>
    <h2>Notifications</h2><div class="card">
      <div class="small muted">Izin notifikasi: <b>${esc(perm)}</b>.${native ? ' Pengingat dijadwalkan di Android, jadi tetap bunyi walau aplikasi tertutup.' : ' Di browser, pengingat dicek saat aplikasi terbuka.'}</div>
      <div class="row wrap" style="margin-top:8px"><button class="soft" data-action="ask-notif">Allow notifications</button>
      <button class="soft" data-action="test-notif">Test notification</button></div></div>
    <h2>Sync Erik ↔ Oni</h2><div class="card">
      <div class="small">Current mode: <b>${cloud ? 'Cloud (Firebase) — room: ' + esc(cfg.room) : 'Local (this phone only)'}</b></div>
      ${cloud ? `<button class="primary block" data-action="share-invite" style="margin-top:10px">📨 Share invite ke pasangan</button>` : ''}
      <label>Room code (sama di HP Erik dan Oni, min. 12 karakter)</label>
      <div class="row"><input id="s-room" value="${esc(cfg.room)}" placeholder="mis. eo-7f3k29xq81ab" autocapitalize="off" autocorrect="off" spellcheck="false">
        <button class="soft" data-action="gen-room">Generate</button></div>
      <label>Firebase config (tempel dari Firebase console)</label>
      <textarea id="s-fb" rows="5" placeholder='{ "apiKey": "...", "projectId": "...", ... }' autocapitalize="off" spellcheck="false">${cfg.firebaseConfig ? esc(JSON.stringify(cfg.firebaseConfig, null, 1)) : ''}</textarea>
      <label>Push URL (Cloudflare Worker, opsional)</label>
      <input id="s-push" value="${esc(cfg.pushUrl)}" placeholder="https://xxx.workers.dev" autocapitalize="off" spellcheck="false">
      <label>Push secret</label>
      <input id="s-secret" value="${esc(cfg.pushSecret)}" autocapitalize="off" spellcheck="false">
      <div class="row wrap" style="margin-top:10px"><button class="primary grow" data-action="connect">${cloud ? 'Simpan & sambung ulang' : 'Enable sync'}</button>
        <button class="soft" data-action="test-conn">Test connection</button>
        ${cloud ? '<button class="ghost" data-action="disconnect">Turn off</button>' : ''}</div>
      <div class="small muted" style="margin-top:8px">Langkah lengkap ada di SETUP.md.</div></div>
    <h2>Tampilan</h2><div class="card"><label style="margin-top:0">Effects</label>
      <select id="s-fx"><option value="full" ${fx === 'full' ? 'selected' : ''}>Full (kaca + blur)</option>
        <option value="light" ${fx === 'light' ? 'selected' : ''}>Light (lebih ringan untuk HP lama)</option></select></div>
    <h2>Recently deleted</h2><div class="card" style="padding:4px 14px">
      ${trash.length ? trash.slice(0, 40).map(x => `<div class="item"><div class="grow">${esc(x._n)}
        <div class="muted small">${esc(x._c)} · dihapus ${esc(fmtWhen(x.deletedAt))}</div></div>
        <button class="soft" data-action="restore" data-col="${x._c}" data-id="${x.id}">Restore</button></div>`).join('')
      : '<div class="empty">Kosong. Item yang dihapus disimpan 30 hari di sini.</div>'}</div>
    <h2>Backup &amp; export</h2><div class="card"><div class="row wrap">
      <button class="soft grow" data-action="export">Download backup (.json)</button>
      <button class="soft grow" data-action="import">Restore from file</button></div>
      <div class="row wrap" style="margin-top:8px">
      <button class="soft grow" data-action="csv-guests">Export tamu (.csv)</button>
      <button class="soft grow" data-action="csv-budget">Export budget (.csv)</button></div></div>`;
}

function parseFirebaseConfig(text) {
  let s = String(text).trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('tidak ada tanda { }');
  s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch {}
  s = s.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":').replace(/'/g, '"').replace(/,\s*}/g, '}');
  return JSON.parse(s);
}
const normRoom = v => String(v).trim().toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9-]/g, '');

function inviteText() {
  return 'WEDDING-INVITE-V1 ' + btoa(unescape(encodeURIComponent(JSON.stringify({
    room: cfg.room, fb: cfg.firebaseConfig, push: cfg.pushUrl, sec: cfg.pushSecret
  }))));
}
function parseInvite(text) {
  const m = String(text).match(/WEDDING-INVITE-V1\s+([A-Za-z0-9+/=]+)/);
  if (!m) throw new Error('Teks undangan tidak dikenali');
  const o = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
  if (!o.room || !o.fb?.apiKey) throw new Error('Undangan tidak lengkap');
  return o;
}
function shareInviteModal() {
  const txt = inviteText();
  openModal(`<div class="m-head"><h2>Share invite</h2><button class="x" data-m="close">✕</button></div>
    <p class="muted small">Kirim teks ini ke pasanganmu lewat chat. Di HP-nya, pilih <b>Join with invite</b> lalu tempel.
    Rahasiakan seperti kata sandi: siapa pun yang punya teks ini bisa membuka data kalian.</p>
    <div class="card"><code>${esc(txt)}</code></div>
    <div class="m-foot"><button class="ghost" data-m="close">Close</button><button class="primary" data-m="copy">Copy</button></div>`, {
    async click(e, b) {
      if (b.dataset.m === 'close') return closeModal();
      try { await navigator.clipboard.writeText(txt); toast('Tersalin. Kirim ke pasanganmu.'); cele(e); }
      catch { toast('Salin manual dari kotak di atas.'); }
    }
  });
}
function joinModal() {
  openModal(`<div class="m-head"><h2>Join with invite</h2><button class="x" data-m="cancel">✕</button></div>
    <p class="muted small">Tempel teks undangan dari pasanganmu. Semua data yang sudah diisi akan langsung muncul.</p>
    <label>Teks undangan<textarea id="j-txt" rows="5" placeholder="WEDDING-INVITE-V1 ..." autocapitalize="off" spellcheck="false"></textarea></label>
    <div class="m-foot"><button class="ghost" data-m="cancel">Cancel</button><button class="primary" data-m="go">Join</button></div>`, {
    click(e, b) {
      if (b.dataset.m === 'cancel') return closeModal();
      if (b.dataset.m !== 'go') return;
      let o; try { o = parseInvite($('#j-txt', mbody).value); } catch (err) { return toast(err.message); }
      cfg = { ...cfg, mode: 'cloud', room: normRoom(o.room), firebaseConfig: o.fb, pushUrl: o.push || '', pushSecret: o.sec || '', seen: true, migrate: false };
      saveCfg(cfg);
      if (!cfg.me) { hardCloseModal(); overlays.pop(); return askWho(() => location.reload()); }
      location.reload();
    }
  });
}
async function testConnection() {
  const room = normRoom($('#s-room').value);
  if (room.length < 12) return toast('Room code minimal 12 karakter.');
  let fb; try { fb = parseFirebaseConfig($('#s-fb').value); } catch (e) { return toast('Firebase config tidak terbaca: ' + e.message); }
  if (!fb.apiKey || !fb.projectId) return toast('Config harus berisi apiKey dan projectId.');
  toast('Menguji koneksi…');
  try {
    const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
    const [A, Au, F] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')]);
    const app = A.initializeApp(fb, 'test-' + Date.now());
    await Au.signInAnonymously(Au.getAuth(app));
    const db = F.getFirestore(app);
    await F.getDocs(F.collection(db, 'weddings', room, 'meta'));
    toast('✅ Koneksi berhasil. Silakan tekan Enable sync.', 7000);
  } catch (e) {
    const c = e.code || '';
    const msg = /auth\/configuration-not-found|operation-not-allowed/.test(c) ? 'Sign-in Anonymous belum diaktifkan di Firebase → Authentication.'
      : /permission-denied/.test(c) ? 'Rules Firestore menolak. Tempel Rules dari SETUP.md lalu Publish.'
      : /api-key|invalid-api-key/.test(c) ? 'apiKey salah. Salin ulang config dari Firebase console.'
      : /unavailable|network/.test(c) ? 'Tidak ada internet atau Firestore belum dibuat.'
      : (c || e.message);
    toast('❌ Gagal: ' + msg, 9000);
  }
}
function downloadCSV(name, rows) {
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name; a.click();
}

/* ============================================================
   12. Event handler
   ============================================================ */
view.addEventListener('input', e => {
  if (e.target.id !== 'g-search') return;
  ui.guestSearch = e.target.value;
  const t = document.createElement('div'); t.innerHTML = renderGuests();
  const fresh = t.querySelector('#g-list'), cur = view.querySelector('#g-list');
  if (fresh && cur) cur.replaceWith(fresh); else render();
});
view.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 't-sort') { ui.taskSort = t.value; render(); }
  if (t.id === 's-me') { cfg.me = t.value; saveCfg(cfg); toast('Halo, ' + cfg.me + '!'); }
  if (t.id === 's-fx') { localStorage.setItem('wedding.fx', t.value); location.reload(); }
});
view.addEventListener('click', async e => {
  const b = e.target.closest('[data-action]'); if (!b) return;
  const a = b.dataset.action, id = b.dataset.id;

  if (a === 'ob-new') return askWho(() => { cfg.seen = true; saveCfg(cfg); location.reload(); });
  if (a === 'ob-join') return joinModal();
  if (a === 'ob-local') return askWho(() => { cfg.seen = true; cfg.mode = 'local'; saveCfg(cfg); location.reload(); });

  if (a === 'toggle-task') {
    e.stopPropagation();
    const t = S.tasks.find(x => x.id === id); if (!t) return;
    await patch('tasks', id, { done: !t.done }, `${t.done ? 'membuka' : 'menyelesaikan'} tugas: ${t.title}`);
    if (!t.done) cele(e);
  }
  else if (a === 'open-task') taskModal(id);
  else if (a === 'new-task') taskModal();
  else if (a === 'task-filter') { ui.taskFilter = b.dataset.v; render(); }
  else if (a === 'import-guide') importGuide();
  else if (a === 'edit-deadline') deadlineModal();
  else if (a === 'guest-group') { ui.guestGroup = b.dataset.v; render(); }
  else if (a === 'add-guest') {
    const el = $('#g-name'), name = el.value.trim();
    if (!name) return toast('Isi nama tamu.');
    const groups = [...view.querySelectorAll('.g-grp:checked')].map(x => x.value);
    sessionStorage.setItem('lastGroups', JSON.stringify(groups));
    el.value = '';
    await put('guests', { id: uid(), name, groups, note: '', phone: '', rsvp: 'invited', pax: 1, deletedAt: 0 }, `menambah tamu: ${name}`);
    cele(e); $('#g-name')?.focus();
  }
  else if (a === 'rsvp') {
    e.stopPropagation();
    const g = S.guests.find(x => x.id === id); if (!g) return;
    const v = b.dataset.v;
    await patch('guests', id, { rsvp: g.rsvp === v ? 'invited' : v }, `mengubah RSVP: ${g.name}`);
    if (v === 'yes' && g.rsvp !== 'yes') cele(e);
  }
  else if (a === 'open-guest') guestModal(id);
  else if (a === 'manage-groups') groupsModal();
  else if (a === 'new-budget') budgetModal();
  else if (a === 'open-budget') budgetModal(id);
  else if (a === 'toggle-paid' || a === 'toggle-pick') {
    const i = S.budget.find(x => x.id === id); if (!i) return;
    const k = a === 'toggle-paid' ? 'paid' : 'pick';
    await patch('budget', id, { [k]: !i[k] }, `mengubah budget: ${i.name}`);
    if (k === 'paid' && !i.paid) cele(e);
  }
  else if (a === 'make-sure') {
    const i = S.budget.find(x => x.id === id); if (!i) return;
    await patch('budget', id, { status: 'pasti', pick: false }, `konfirmasi budget: ${i.name}`);
    toast(`"${i.name}" dipindah ke Confirmed.`); cele(e);
  }
  else if (a === 'restore') { await patch(b.dataset.col, id, { deletedAt: 0 }); toast('Dikembalikan.'); }
  else if (a === 'save-wedding') {
    await saveMeta({ weddingDate: $('#s-date').value, budgetTarget: Number($('#s-target').value) || 0, autoRemind: $('#s-auto').checked });
    toast('Tersimpan.'); cele(e);
  }
  else if (a === 'ask-notif') {
    const LN = plugin('LocalNotifications');
    if (native && LN) { try { await LN.requestPermissions(); } catch {} }
    if ('Notification' in window) await Notification.requestPermission();
    render();
  }
  else if (a === 'test-notif') notify('Tes notifikasi', 'Jika ini muncul, pengingat akan berfungsi.', 'test');
  else if (a === 'gen-room') {
    const c = 'abcdefghjkmnpqrstuvwxyz23456789'; let r = 'eo-';
    crypto.getRandomValues(new Uint8Array(14)).forEach(n => { r += c[n % c.length]; });
    $('#s-room').value = r;
    if (!$('#s-secret').value) {
      let s = ''; crypto.getRandomValues(new Uint8Array(24)).forEach(n => { s += c[n % c.length]; });
      $('#s-secret').value = s;
    }
  }
  else if (a === 'test-conn') testConnection();
  else if (a === 'share-invite') shareInviteModal();
  else if (a === 'connect') {
    const room = normRoom($('#s-room').value);
    if (room.length < 12) return toast('Room code minimal 12 karakter.');
    let fb; try { fb = parseFirebaseConfig($('#s-fb').value); } catch (err) { return toast('Firebase config tidak terbaca: ' + err.message); }
    if (!fb.apiKey || !fb.projectId) return toast('Config harus berisi apiKey dan projectId.');
    const wasLocal = cfg.mode !== 'cloud';
    cfg = { ...cfg, mode: 'cloud', room, firebaseConfig: fb, pushUrl: $('#s-push').value.trim(), pushSecret: $('#s-secret').value.trim(), seen: true,
      migrate: wasLocal && live.tasks().length > 0 && confirm('Unggah data yang sudah ada di HP ini ke cloud?') };
    saveCfg(cfg); location.reload();
  }
  else if (a === 'disconnect') {
    if (!confirm('Matikan sinkronisasi? Aplikasi kembali memakai data lokal di HP ini (data cloud tidak dihapus).')) return;
    cfg = { ...cfg, mode: 'local', migrate: false }; saveCfg(cfg); location.reload();
  }
  else if (a === 'export') {
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), meta: S.meta, tasks: S.tasks, guests: S.guests, budget: S.budget, photos: S.photos }, null, 1)], { type: 'application/json' });
    const el = document.createElement('a');
    el.href = URL.createObjectURL(blob); el.download = 'cadangan-pernikahan-' + toISO(new Date()) + '.json'; el.click();
  }
  else if (a === 'csv-guests') {
    downloadCSV('tamu-' + toISO(new Date()) + '.csv', [['Nama', 'Grup', 'RSVP', 'Jumlah orang', 'HP', 'Catatan'],
      ...live.guests().map(g => [g.name, (g.groups || []).map(groupName).join(' | '), g.rsvp || 'invited', Math.max(1, Number(g.pax) || 1), g.phone || '', g.note || ''])]);
  }
  else if (a === 'csv-budget') {
    const L = live.budget();
    downloadCSV('budget-' + toISO(new Date()) + '.csv', [['Item', 'Kategori', 'Status', 'Harga satuan', 'Jumlah', 'Subtotal', 'Dibayar', 'Catatan'],
      ...L.map(i => [i.name, i.category || '', i.status === 'opsional' ? 'Optional' : 'Confirmed', Number(i.price) || 0, Number(i.qty) || 1, sub$(i), i.paid ? 'Ya' : 'Tidak', i.notes || '']),
      [], ['Total confirmed', '', '', '', '', L.filter(i => i.status !== 'opsional').reduce((a, i) => a + sub$(i), 0)],
      ['Total optional', '', '', '', '', L.filter(i => i.status === 'opsional').reduce((a, i) => a + sub$(i), 0)]]);
  }
  else if (a === 'import') {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json';
    inp.onchange = async () => {
      try {
        const j = JSON.parse(await inp.files[0].text());
        if (!confirm('Pulihkan data dari file? Item dengan ID sama akan ditimpa.')) return;
        if (j.meta) await store.patch('meta', 'settings', { ...j.meta, id: 'settings' });
        for (const col of ['tasks', 'guests', 'budget']) for (const o of j[col] || []) await store.put(col, o);
        for (const [pid, data] of Object.entries(j.photos || {})) await store.put('photos', { id: pid, data, ts: Date.now() });
        toast('Data dipulihkan.');
      } catch (err) { toast('File tidak valid: ' + err.message); }
    };
    inp.click();
  }
});

boot();
