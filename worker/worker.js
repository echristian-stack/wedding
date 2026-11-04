/**
 * Cloudflare Worker — pengirim notifikasi push untuk aplikasi Erik & Oni.
 *
 * Tugasnya satu: menerima "kabari pasangan" dari aplikasi, lalu menyuruh FCM
 * mengantarkan notifikasi ke HP yang lain. Kunci rahasia Firebase disimpan di
 * sini (sebagai Secret), bukan di dalam APK.
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

/** Ambil daftar HP di ruang ini dari Firestore (REST). */
async function listDevices(env, token, room) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.PROJECT_ID}/databases/(default)/documents/weddings/${encodeURIComponent(room)}/devices?pageSize=20`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('firestore: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  return (j.documents || []).map(d => ({
    token: d.fields?.token?.stringValue || '',
    owner: d.fields?.owner?.stringValue || ''
  })).filter(d => d.token);
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
  'Access-Control-Allow-Headers': 'Content-Type'
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const cache = { token: null, exp: 0, key: null };   // berlaku selama instance Worker hidup
const seen = new Map();                          // rem sederhana: 1 kiriman / 3 detik / ruang

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return json({ error: 'POST saja' }, 405);

    let b;
    try { b = await request.json(); } catch { return json({ error: 'JSON tidak valid' }, 400); }

    if (!env.SHARED_SECRET || b.secret !== env.SHARED_SECRET) return json({ error: 'secret salah' }, 403);
    const room = String(b.room || '').replace(/[^a-z0-9-]/g, '');
    if (room.length < 12) return json({ error: 'room tidak valid' }, 400);

    const now = Date.now();
    if (now - (seen.get(room) || 0) < 3000) return json({ ok: true, skipped: 'terlalu cepat' });
    seen.set(room, now);
    if (seen.size > 100) seen.clear();

    const title = String(b.title || 'Ada perubahan').slice(0, 80);
    const body = String(b.body || '').slice(0, 160);
    const from = String(b.from || '');

    try {
      const token = await getAccessToken(env, cache);
      const devices = await listDevices(env, token, room);
      const targets = devices.filter(d => d.owner !== from);
      if (!targets.length) return json({ ok: true, sent: 0, note: 'tidak ada HP lain terdaftar' });
      const results = await Promise.all(targets.map(d => sendFcm(env, token, d.token, title, body)));
      return json({ ok: true, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok) });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};
