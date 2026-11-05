/**
 * Cloudflare Worker — pengirim notifikasi push untuk aplikasi Erik & Oni.
 *
 * Tugasnya: menerima kabar perubahan dari aplikasi, lalu menyuruh FCM mengantarkan
 * notifikasi ke HP yang berhak. Kunci rahasia Firebase disimpan di sini (sebagai Secret).
 *
 * Penerima:
 *   - perubahan utama (tanpa cid)      → HP Erik & Oni, kecuali pengirim
 *   - perubahan panitia (cid terisi)   → HP anggota panitia itu + Erik & Oni
 *                                        (kecuali yang mematikan notifikasi panitia), kecuali pengirim
 * Pengirim dikenali dari ID token Firebase (idToken). Cara lama (Push secret saja) tetap diterima
 * untuk kabar utama dari Erik & Oni.
 *
 * Secrets yang harus dipasang (wrangler secret put NAMA):
 *   SHARED_SECRET    - sama dengan "Push secret" di aplikasi
 *   SA_CLIENT_EMAIL  - client_email dari file service account JSON
 *   SA_PRIVATE_KEY   - private_key dari file service account JSON (termasuk BEGIN/END)
 *   PROJECT_ID       - project_id Firebase
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore';

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = s => b64url(enc.encode(s));

function pemToDer(pem) {
  const body = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Buat OAuth access token dari service account (JWT RS256). */
async function getAccessToken(env, cache) {
  const now = Math.floor(Date.now() / 1000);
  if (cache.token && cache.exp > now + 120) return cache.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.SA_CLIENT_EMAIL, scope: SCOPES, aud: GOOGLE_TOKEN_URL,
    iat: now, exp: now + 3600
  };
  const unsigned = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(claim))}`;
  // Kunci di-cache per instance supaya hemat waktu CPU (batas Workers Free: 10 ms/request).
  cache.key ??= await crypto.subtle.importKey(
    'pkcs8', pemToDer(env.SA_PRIVATE_KEY.replace(/\\n/g, '\n')),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cache.key, enc.encode(unsigned));
  const jwt = `${unsigned}.${b64url(sig)}`;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const j = await res.json();
  if (!res.ok) throw new Error('token: ' + (j.error_description || JSON.stringify(j)));
  cache.token = j.access_token;
  cache.exp = now + (j.expires_in || 3600);
  return cache.token;
}

/* ---------- Firestore (REST, memakai service account) ---------- */
const fsBase = (env, room) => `https://firestore.googleapis.com/v1/projects/${env.PROJECT_ID}/databases/(default)/documents/weddings/${encodeURIComponent(room)}`;
/** Ubah nilai Firestore REST menjadi nilai JS biasa. */
function val(v) {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, val(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val);
  return undefined;
}
const docData = d => ({ _id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, val(x)])) });
/** Ambil semua dokumen satu koleksi (berhalaman). */
async function listCol(env, token, room, col) {
  const out = []; let page = '';
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${fsBase(env, room)}/${col}?pageSize=300${page ? '&pageToken=' + encodeURIComponent(page) : ''}`,
      { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('firestore ' + col + ': ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    (j.documents || []).forEach(d => out.push(docData(d)));
    if (!j.nextPageToken) break;
    page = j.nextPageToken;
  }
  return out;
}

/* ---------- Verifikasi ID token Firebase (siapa pengirimnya) ---------- */
const JWK_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const fromB64url = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
async function verifyIdToken(env, idToken, cache) {
  const [h, p, sig] = String(idToken || '').split('.');
  if (!sig) return null;
  const head = JSON.parse(new TextDecoder().decode(fromB64url(h)));
  const pay = JSON.parse(new TextDecoder().decode(fromB64url(p)));
  const now = Math.floor(Date.now() / 1000);
  if (head.alg !== 'RS256' || pay.aud !== env.PROJECT_ID || pay.iss !== 'https://securetoken.google.com/' + env.PROJECT_ID
    || !(pay.exp > now) || !(pay.iat <= now + 300) || !pay.sub) return null;
  if (!cache.jwks || cache.jwksExp < now) {
    const r = await fetch(JWK_URL); const j = await r.json();
    cache.jwks = j.keys || []; cache.jwksExp = now + 3600; cache.jwkKeys = {};
  }
  const jwk = cache.jwks.find(k => k.kid === head.kid); if (!jwk) return null;
  cache.jwkKeys[jwk.kid] ??= await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cache.jwkKeys[jwk.kid], fromB64url(sig), enc.encode(h + '.' + p));
  return ok ? pay.sub : null;
}

async function sendFcm(env, accessToken, deviceToken, title, body) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.PROJECT_ID}/messages:send`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title, body },
        android: { priority: 'HIGH', notification: { channelId: 'wedding', sound: 'default' } }
      }
    })
  });
  return { ok: res.ok, status: res.status, text: res.ok ? '' : (await res.text()).slice(0, 200) };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const cache = { token: null, exp: 0, key: null, jwks: null, jwksExp: 0, jwkKeys: {} };   // berlaku selama instance Worker hidup
const seen = new Map();                          // rem sederhana: 1 kiriman / 3 detik / ruang

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return json({ error: 'POST saja' }, 405);

    let b;
    try { b = await request.json(); } catch { return json({ error: 'JSON tidak valid' }, 400); }

    const room = String(b.room || '').replace(/[^a-z0-9-]/g, '');
    if (room.length < 12) return json({ error: 'room tidak valid' }, 400);
    const cid = String(b.cid || '');
    const title = String(b.title || 'Ada perubahan').slice(0, 80);
    const body = String(b.body || '').slice(0, 160);
    const from = String(b.from || '');

    try {
      const token = await getAccessToken(env, cache);
      let uid = b.idToken ? await verifyIdToken(env, b.idToken, cache).catch(() => null) : null;
      const secretOk = !!env.SHARED_SECRET && b.secret === env.SHARED_SECRET;
      if (!uid && !secretOk) return json({ error: 'tidak dikenali' }, 403);

      // rem sederhana: 1 kiriman / 3 detik per pengirim per panitia
      const key = room + '|' + cid + '|' + (uid || from), now = Date.now();
      if (now - (seen.get(key) || 0) < 3000) return json({ ok: true, skipped: 'terlalu cepat' });
      seen.set(key, now); if (seen.size > 300) seen.clear();

      const [devices, members, invites, people] = await Promise.all(['devices', 'members', 'invites', 'people'].map(c => listCol(env, token, room, c).catch(() => [])));
      const codes = new Set(invites.map(i => i._id));
      const memberOf = Object.fromEntries(members.filter(m => codes.has(m.code)).map(m => [m._id, m]));
      const personOf = Object.fromEntries(people.filter(p => !p.deletedAt).map(p => [p._id, p]));
      const inC = (personId, c) => !!(personOf[personId] && personOf[personId].committees && personOf[personId].committees[c]);

      // HP Erik/Oni yang belum tercatat di members (masa peralihan) tetap boleh memakai Push secret.
      if (uid && !memberOf[uid] && secretOk && !cid) uid = null;
      let sender = null;
      if (uid) {
        sender = memberOf[uid];
        if (!sender || sender.role === 'viewer') return json({ error: 'tidak berhak' }, 403);
        if (sender.role === 'panitia' && (!cid || !inC(sender.person, cid))) return json({ error: 'bukan panitia ini' }, 403);
      } else if (cid) return json({ error: 'perlu idToken' }, 403);

      // HP lama (sebelum ada peran) dianggap milik Erik/Oni.
      const devRole = d => d.role || 'owner';
      const live = d => !d.uid ? devRole(d) === 'owner' : !!memberOf[d.uid] && memberOf[d.uid].role === devRole(d);
      const targets = devices.filter(d => d.token && live(d)).filter(d => {
        if (uid ? d.uid === uid : d.owner === from) return false;
        if (devRole(d) === 'owner') return cid ? !d.mutePanitia : true;
        if (devRole(d) === 'panitia') return !!cid && inC((memberOf[d.uid] || {}).person || d.person, cid);
        return false;
      });
      if (!targets.length) return json({ ok: true, sent: 0, note: 'tidak ada HP penerima' });
      const results = await Promise.all(targets.map(d => sendFcm(env, token, d.token, title, body)));
      return json({ ok: true, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok) });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};
