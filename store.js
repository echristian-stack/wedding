// Lapisan penyimpanan. Dua mode dengan API yang sama:
//   "local" — IndexedDB di HP ini saja
//   "cloud" — Firebase Firestore (paket Spark, gratis)
//
// API:
//   subscribe(col, cb)      -> cb(items[], changes[])  changes = perubahan dari perangkat lain
//   put(col, obj)           -> tulis dokumen utuh (dokumen baru)
//   patch(col, id, fields)  -> tulis HANYA kolom yang berubah (deep merge) — mencegah saling timpa
//   drop(col, id, paths[])  -> hapus beberapa kolom (mis. satu subtask)
//   del(col, id)            -> hapus dokumen permanen

const FB_VER = '10.12.2';
const clone = o => JSON.parse(JSON.stringify(o));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// deep merge untuk mode lokal, meniru perilaku Firestore merge:true
function deepMerge(base, patch) {
  const out = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}
function dropPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(cur[parts[i]])) return;
    cur = cur[parts[i]];
  }
  delete cur[parts[parts.length - 1]];
}

/* ---------- IndexedDB ---------- */
const DB_NAME = 'wedding-local';
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv', { keyPath: 'k' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const os = (db, mode) => db.transaction('kv', mode).objectStore('kv');
const wrap = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function readAllLocal() {
  const db = await openDb();
  return wrap(os(db, 'readonly').getAll());
}

/* ---------- Mode lokal ---------- */
async function localStore() {
  const db = await openDb();
  const rows = await wrap(os(db, 'readonly').getAll());
  const data = {};
  rows.forEach(r => { (data[r.col] ??= {})[r.id] = r.obj; });
  const subs = {};
  const emit = col => (subs[col] || []).forEach(cb => cb(Object.values(data[col] || {}), []));
  const save = (col, id) => wrap(os(db, 'readwrite').put({ k: col + '/' + id, col, id, obj: data[col][id] }));
  return {
    mode: 'local',
    uid: 'local',
    async idToken() { return ''; },
    async getOne(col, id) { return clone((data[col] || {})[id] || null); },
    subscribe(col, cb) { (subs[col] ??= []).push(cb); cb(Object.values(data[col] || {}), []); },
    async put(col, obj) {
      (data[col] ??= {})[obj.id] = clone(obj);
      emit(col); await save(col, obj.id);
    },
    async patch(col, id, fields) {
      const cur = (data[col] ??= {})[id] || { id };
      data[col][id] = deepMerge(cur, clone(fields));
      emit(col); await save(col, id);
    },
    async drop(col, id, paths) {
      const cur = (data[col] || {})[id]; if (!cur) return;
      paths.forEach(p => dropPath(cur, p));
      emit(col); await save(col, id);
    },
    async del(col, id) {
      if (data[col]) delete data[col][id];
      emit(col); await wrap(os(db, 'readwrite').delete(col + '/' + id));
    }
  };
}

/* ---------- Mode cloud (Firebase) ---------- */
async function cloudStore(cfg, onStatus) {
  const base = `https://www.gstatic.com/firebasejs/${FB_VER}/`;
  const [appM, authM, fsM] = await Promise.all([
    import(base + 'firebase-app.js'),
    import(base + 'firebase-auth.js'),
    import(base + 'firebase-firestore.js')
  ]);
  const app = appM.initializeApp(cfg.firebaseConfig);
  const auth = authM.getAuth(app);
  try {
    await authM.signInAnonymously(auth);
  } catch (e) {
    // Offline tetap boleh jalan dari cache; error lain dilempar supaya pesannya jelas.
    if (!/network|unavailable|timeout/i.test(e.code + ' ' + e.message)) throw e;
    console.warn('Auth anonim gagal, lanjut dari cache:', e.message);
  }
  const db = fsM.initializeFirestore(app, {
    localCache: fsM.persistentLocalCache({ tabManager: fsM.persistentMultipleTabManager() })
  });
  const room = cfg.room;
  const ref = (col, id) => fsM.doc(db, 'weddings', room, col, id);
  const colRef = col => fsM.collection(db, 'weddings', room, col);
  return {
    mode: 'cloud',
    get uid() { return auth.currentUser ? auth.currentUser.uid : ''; },
    async idToken() { return auth.currentUser ? auth.currentUser.getIdToken() : ''; },
    async getOne(col, id) {
      const d = await fsM.getDoc(ref(col, id));
      return d.exists() ? d.data() : null;
    },
    subscribe(col, cb) {
      let first = true;
      fsM.onSnapshot(colRef(col), { includeMetadataChanges: true }, snap => {
        onStatus && onStatus({ online: !snap.metadata.fromCache });
        const raw = snap.docChanges();
        if (!first && raw.length === 0) return;      // hanya metadata berubah
        const changes = first ? [] : raw
          .filter(c => c.type !== 'removed' && !c.doc.metadata.hasPendingWrites)
          .map(c => ({ type: c.type, data: c.doc.data() }));
        first = false;
        cb(snap.docs.map(d => d.data()), changes);
      }, err => {
        console.error(err);
        onStatus && onStatus({ error: err.code || err.message });
      });
    },
    put(col, obj) { return fsM.setDoc(ref(col, obj.id), clone(obj)); },
    patch(col, id, fields) { return fsM.setDoc(ref(col, id), clone(fields), { merge: true }); },
    drop(col, id, paths) {
      const u = {}; paths.forEach(p => { u[p] = fsM.deleteField(); });
      return fsM.updateDoc(ref(col, id), u);
    },
    del(col, id) { return fsM.deleteDoc(ref(col, id)); }
  };
}

export async function createStore(cfg, onStatus) {
  if (cfg.mode === 'cloud' && cfg.firebaseConfig && cfg.room) return cloudStore(cfg, onStatus);
  return localStore();
}
