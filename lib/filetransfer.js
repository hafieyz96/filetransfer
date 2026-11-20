const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const archiver = require('archiver');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data', 'filetransfer');
const MAX_BYTES = 8 * 1024 * 1024; // per gambar
const MAX_PHOTOS = 100; // per session
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 100);
const TTL_MS = Number(process.env.SESSION_TTL_HOURS || 168) * 3600 * 1000;

const ID_RE = /^[a-f0-9]{32}$/;
const NAME_RE = /^[a-f0-9]{16}\.jpg$/;
const PAGE = path.join(__dirname, '..', 'public', 'filetransfer.html');

const dirOf = (id) => path.join(DATA_DIR, id);
const metaOf = (id) => path.join(dirOf(id), 'meta.json');

async function readMeta(id) {
  try { return JSON.parse(await fsp.readFile(metaOf(id), 'utf8')); } catch { return null; }
}
const writeMeta = (id, m) => fsp.writeFile(metaOf(id), JSON.stringify(m));

async function listPhotos(id) {
  const names = (await fsp.readdir(dirOf(id))).filter((n) => NAME_RE.test(n)).sort();
  return Promise.all(names.map(async (name) => ({ name, size: (await fsp.stat(path.join(dirOf(id), name))).size })));
}

async function removeIfEmptyAndDone(id) {
  const m = await readMeta(id);
  if (m?.done && (await listPhotos(id).catch(() => [])).length === 0) {
    await fsp.rm(dirOf(id), { recursive: true, force: true });
  }
}

async function sweep() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    for (const id of await fsp.readdir(DATA_DIR)) {
      if (!ID_RE.test(id)) continue;
      const m = await readMeta(id);
      if (!m || Date.now() - m.created > TTL_MS) await fsp.rm(dirOf(id), { recursive: true, force: true });
    }
  } catch (e) { console.error('sweep error', e); }
}
setInterval(sweep, 3600 * 1000).unref();
sweep();

const router = express.Router();
const noStore = (res) => res.set('Cache-Control', 'private, no-store');

router.get(['/', '/s/:id'], (_req, res) => { noStore(res); res.sendFile(PAGE); });

// ---------- Auth: kod akses (ACCESS_PIN), cookie tandatangan ----------
const PIN = process.env.ACCESS_PIN || '';
const TOKEN = PIN ? crypto.createHmac('sha256', PIN).update('filetransfer-v1').digest('hex') : '';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
let fails = [];

function authed(req) {
  const c = (req.headers.cookie || '').split(/;\s*/).find((x) => x.startsWith('ft_auth='));
  if (!c || !TOKEN) return false;
  const a = Buffer.from(c.slice(8)), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const cookie = (req, val, age) =>
  `ft_auth=${val}; Path=/filetransfer; Max-Age=${age}; HttpOnly; SameSite=Lax${req.get('x-forwarded-proto') === 'https' ? '; Secure' : ''}`;

router.post('/api/login', (req, res) => {
  if (!TOKEN) return res.json({ ok: true }); // tiada kod akses: terbuka
  const now = Date.now();
  fails = fails.filter((t) => now - t < 10 * 60 * 1000);
  if (fails.length >= 8) return res.status(429).json({ error: 'Terlalu banyak cubaan.' });
  if (!crypto.timingSafeEqual(sha(req.body?.pin ?? ''), sha(PIN))) { fails.push(now); return res.status(401).json({ error: 'Kod salah.' }); }
  res.set('Set-Cookie', cookie(req, TOKEN, 30 * 24 * 3600)).json({ ok: true });
});
router.post('/api/logout', (req, res) => res.set('Set-Cookie', cookie(req, '', 0)).json({ ok: true }));

router.use('/api', (req, res, next) => {
  if (!TOKEN) return next(); // ACCESS_PIN tak diset: sesiapa dengan URL boleh akses
  if (!authed(req)) return res.status(401).json({ error: 'Perlu log masuk.' });
  next();
});

router.get('/api/sessions', async (_req, res, next) => {
  try {
    noStore(res);
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const sessions = [];
    for (const id of await fsp.readdir(DATA_DIR)) {
      if (!ID_RE.test(id)) continue;
      const m = await readMeta(id);
      if (!m) continue;
      const ph = await listPhotos(id).catch(() => []);
      sessions.push({ id, created: m.created, done: m.done, count: ph.length, size: ph.reduce((a, p) => a + p.size, 0) });
    }
    sessions.sort((a, b) => b.created - a.created);
    res.json({ sessions, storage: await storageInfo([]) });
  } catch (e) { next(e); }
});

router.post('/api/sessions', async (_req, res, next) => {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    if ((await fsp.readdir(DATA_DIR)).length >= MAX_SESSIONS) return res.status(429).json({ error: 'Terlalu banyak session aktif, cuba lagi nanti.' });
    const id = crypto.randomBytes(16).toString('hex');
    await fsp.mkdir(dirOf(id));
    await writeMeta(id, { created: Date.now(), done: false });
    res.json({ id });
  } catch (e) { next(e); }
});

// semua route bawah perlukan session yang sah
router.use('/api/sessions/:id', async (req, res, next) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' });
  const meta = await readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  req.meta = meta;
  next();
});

async function storageInfo(photos) {
  let app = 0;
  for (const id of await fsp.readdir(DATA_DIR)) {
    if (!ID_RE.test(id)) continue;
    app += (await listPhotos(id).catch(() => [])).reduce((a, p) => a + p.size, 0);
  }
  const s = await fsp.statfs(DATA_DIR);
  return {
    session: photos.reduce((a, p) => a + p.size, 0), // saiz gambar session ini
    app, // semua gambar semua session
    diskTotal: s.blocks * s.bsize,
    diskUsed: (s.blocks - s.bfree) * s.bsize,
    diskFree: s.bavail * s.bsize,
  };
}

router.get('/api/sessions/:id', async (req, res, next) => {
  try {
    noStore(res);
    const photos = await listPhotos(req.params.id);
    res.json({ done: req.meta.done, created: req.meta.created, max: MAX_PHOTOS, photos, storage: await storageInfo(photos) });
  } catch (e) { next(e); }
});

router.post('/api/sessions/:id/photos', express.raw({ type: 'image/jpeg', limit: MAX_BYTES }), async (req, res, next) => {
  try {
    const { id } = req.params;
    const b = req.body;
    if (!Buffer.isBuffer(b) || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return res.status(400).json({ error: 'Bukan JPEG.' });
    if ((await listPhotos(id)).length >= MAX_PHOTOS) return res.status(413).json({ error: `Maksimum ${MAX_PHOTOS} gambar.` });
    const name = Date.now().toString(16).padStart(12, '0') + crypto.randomBytes(2).toString('hex') + '.jpg';
    await fsp.writeFile(path.join(dirOf(id), name), b);
    res.json({ name });
  } catch (e) { next(e); }
});

router.post('/api/sessions/:id/done', async (req, res, next) => {
  try {
    await writeMeta(req.params.id, { ...req.meta, done: true });
    await removeIfEmptyAndDone(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// padam gambar terpilih
router.post('/api/sessions/:id/photos/delete', async (req, res, next) => {
  try {
    const { id } = req.params;
    const names = (Array.isArray(req.body?.names) ? req.body.names : []).filter((n) => NAME_RE.test(n));
    await Promise.all(names.map((n) => fsp.rm(path.join(dirOf(id), n), { force: true })));
    await removeIfEmptyAndDone(id);
    res.json({ deleted: names.length });
  } catch (e) { next(e); }
});

// padam session beserta semua gambar
router.delete('/api/sessions/:id', async (req, res, next) => {
  try { await fsp.rm(dirOf(req.params.id), { recursive: true, force: true }); res.json({ ok: true }); } catch (e) { next(e); }
});

router.get('/api/sessions/:id/zip', async (req, res, next) => {
  try {
    const { id } = req.params;
    let photos = await listPhotos(id);
    if (req.query.names) { // muat turun gambar yang dipilih sahaja
      const want = new Set(String(req.query.names).split(',').filter((n) => NAME_RE.test(n)));
      photos = photos.filter((p) => want.has(p.name));
    }
    if (!photos.length) return res.status(404).json({ error: 'Tiada gambar.' });
    noStore(res);
    res.attachment('gambar.zip');
    const zip = archiver('zip', { store: true }); // JPEG dah termampat
    zip.on('error', () => res.destroy());
    zip.pipe(res);
    photos.forEach((p, i) => zip.file(path.join(dirOf(id), p.name), { name: `gambar-${String(i + 1).padStart(3, '0')}.jpg` }));
    // padam hanya bila muat turun habis dihantar
    res.on('finish', async () => {
      await Promise.all(photos.map((p) => fsp.rm(path.join(dirOf(id), p.name), { force: true })));
      await removeIfEmptyAndDone(id).catch(() => {});
    });
    zip.finalize();
  } catch (e) { next(e); }
});

router.get('/api/sessions/:id/photos/:name', (req, res) => {
  const { id, name } = req.params;
  if (!NAME_RE.test(name)) return res.sendStatus(404);
  const file = path.join(dirOf(id), name);
  noStore(res);
  if (req.query.download !== '1') return res.sendFile(file, (e) => { if (e && !res.headersSent) res.sendStatus(404); });
  res.download(file, `gambar-${name}`, async (err) => {
    if (err) return; // jangan padam kalau gagal / terputus
    await fsp.rm(file, { force: true });
    await removeIfEmptyAndDone(id).catch(() => {});
  });
});

router.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Gambar terlalu besar.' });
  console.error('filetransfer error', err);
  res.status(500).json({ error: 'Ralat server.' });
});

module.exports = router;
