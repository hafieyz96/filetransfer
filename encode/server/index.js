'use strict';
// Droplet side: upload page + job queue + download.
// Flow: browser POST /upload -> job "queued" -> PC agent claims it, downloads input, then makes
// one output per variant (standard first, then premium) -> browser polls /jobs/:id.

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const AGENT_KEY = process.env.AGENT_KEY || '';
const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD || '';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100);
const RETENTION_MS = Number(process.env.RETENTION_MINUTES || 60) * 60_000;
const PROCESSING_TIMEOUT_MS = Number(process.env.PROCESSING_TIMEOUT_MINUTES || 30) * 60_000;

// Order matters: the agent works through these in order, standard first.
const VARIANTS = ['standard', 'premium'];
const SUFFIX = { standard: 'hd', premium: 'premium' };

if (!AGENT_KEY || AGENT_KEY === 'tukar-ini') {
  console.error('AGENT_KEY belum diset (.env). Berhenti.');
  process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const IN_DIR = path.join(DATA_DIR, 'in');
const OUT_DIR = path.join(DATA_DIR, 'out');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
fs.mkdirSync(IN_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- job store (in memory, persisted to a small JSON file) ----
// job = { id, status: queued|processing|done|failed, files: {variant: true}, errors: {variant: msg}, ... }
let jobs = {};
try { jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch { /* fresh start */ }
function saveJobs() {
  const tmp = JOBS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(jobs));
  fs.renameSync(tmp, JOBS_FILE);
}
const newId = () => crypto.randomBytes(16).toString('hex');
const inPath = (id) => path.join(IN_DIR, id);
const outPath = (id, variant) => path.join(OUT_DIR, `${id}.${variant}.mp4`);
const isId = (s) => /^[a-f0-9]{32}$/.test(s || '');
const isVariant = (v) => VARIANTS.includes(v);
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
function rm(p) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
// Variants the uploader asked for (jobs from before the choice existed get all of them).
const wanted = (job) => (job.want && job.want.length ? VARIANTS.filter((v) => job.want.includes(v)) : VARIANTS);
const todo = (job) => wanted(job).filter((v) => !job.files[v] && !job.errors[v]);

// After every variant result: finish the job once nothing is left to do.
function settle(job) {
  job.updatedAt = Date.now();
  if (todo(job).length === 0) {
    job.status = Object.keys(job.files).length ? 'done' : 'failed'; // at least one output exists
    rm(inPath(job.id));
  }
  saveJobs();
}

// ---- upload (streams to disk, never buffers whole file in RAM) ----
const upload = multer({
  storage: multer.diskStorage({
    destination: IN_DIR,
    filename: (_req, _file, cb) => cb(null, newId()),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith('video/') ? cb(null, true) : cb(new Error('Hanya fail video dibenarkan')),
});

const app = express();
app.disable('x-powered-by');

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- public: upload + status + download ----
// ?variant=standard|premium picks one output; checked before any bytes are accepted.
app.post('/upload', (req, res, next) => {
  // check password BEFORE accepting any bytes
  if (UPLOAD_PASSWORD && !safeEqual(req.get('x-upload-password') || '', UPLOAD_PASSWORD)) {
    return res.status(401).set('Connection', 'close').json({ error: 'Password salah' });
  }
  const v = req.query.variant;
  if (v !== undefined && !isVariant(v)) {
    return res.status(400).set('Connection', 'close').json({ error: 'Pilihan tak sah (standard atau premium)' });
  }
  next();
}, (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err || !req.file) {
      if (req.file) rm(req.file.path);
      if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Fail melebihi ${MAX_UPLOAD_MB}MB` });
      return res.status(400).json({ error: err ? err.message : 'Tiada fail video' });
    }
    const id = req.file.filename;
    jobs[id] = {
      id, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(),
      originalName: path.basename(req.file.originalname || 'video').slice(0, 120),
      inputBytes: req.file.size, files: {}, errors: {},
      want: req.query.variant ? [req.query.variant] : VARIANTS,
    };
    saveJobs();
    res.status(201).json({ id });
  });
});

app.get('/jobs/:id', (req, res) => {
  const job = isId(req.params.id) && jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job tak jumpa' });
  const variants = {};
  for (const v of wanted(job)) {
    variants[v] = job.files[v]
      ? { state: 'done', url: `/download/${job.id}/${v}` }
      : job.errors[v] ? { state: 'failed', error: job.errors[v] }
        : { state: 'pending', progress: (job.progress && job.progress[v]) || null };
  }
  res.json({ id: job.id, status: job.status, variants });
});

function sendVariant(req, res, variant) {
  const job = isId(req.params.id) && jobs[req.params.id];
  if (!job || !isVariant(variant) || !job.files[variant] || !fs.existsSync(outPath(job.id, variant))) {
    return res.status(404).json({ error: 'Fail tak tersedia' });
  }
  const base = path.parse(job.originalName).name || 'video';
  res.download(outPath(job.id, variant), `${base}-${SUFFIX[variant]}.mp4`);
}
// Page header pill: is the PC agent around, and how busy is it. No job details are exposed.
let agentSeenAt = 0;
app.get('/status', (_req, res) => {
  const all = Object.values(jobs);
  res.json({
    agentOnline: Date.now() - agentSeenAt < 60_000, // agent polls every few seconds, heartbeats every ~10s
    queued: all.filter((j) => j.status === 'queued').length,
    processing: all.filter((j) => j.status === 'processing').length,
    maxUploadMB: MAX_UPLOAD_MB,
  });
});

app.get('/download/:id/:variant', (req, res) => sendVariant(req, res, req.params.variant));
app.get('/download/:id', (req, res) => sendVariant(req, res, 'standard')); // old links

// ---- agent (PC) endpoints, protected by AGENT_KEY ----
const agent = express.Router();
agent.use((req, res, next) => {
  if (!safeEqual(req.get('x-api-key') || '', AGENT_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  agentSeenAt = Date.now();
  next();
});

agent.get('/ping', (_req, res) => res.json({ ok: true }));

// Claim oldest queued job (or 204 if none). Response lists the variants still to make.
agent.post('/claim', (_req, res) => {
  const next = Object.values(jobs)
    .filter((j) => j.status === 'queued' && fs.existsSync(inPath(j.id)))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!next) return res.status(204).end();
  next.status = 'processing'; next.updatedAt = Date.now();
  saveJobs();
  res.json({ id: next.id, originalName: next.originalName, todo: todo(next) });
});

agent.get('/input/:id', (req, res) => {
  const job = isId(req.params.id) && jobs[req.params.id];
  if (!job || !fs.existsSync(inPath(job.id))) return res.status(404).end();
  res.sendFile(inPath(job.id));
});

// Output is streamed straight to disk (raw body), no multipart, no RAM buffering.
agent.put('/output/:id/:variant', (req, res) => {
  const job = isId(req.params.id) && jobs[req.params.id];
  const variant = req.params.variant;
  if (!job || !isVariant(variant) || job.status !== 'processing') {
    return res.status(409).json({ error: 'Job bukan dalam status processing' });
  }
  const tmp = outPath(job.id, variant) + '.part';
  const ws = fs.createWriteStream(tmp);
  req.pipe(ws);
  ws.on('finish', () => {
    fs.renameSync(tmp, outPath(job.id, variant));
    job.files[variant] = true;
    settle(job);
    res.json({ ok: true });
  });
  const abort = () => { ws.destroy(); rm(tmp); };
  ws.on('error', () => { abort(); if (!res.headersSent) res.status(500).json({ error: 'Gagal simpan' }); });
  req.on('aborted', abort);
});

// Heartbeat from long jobs: keeps the job from being re-queued and gives the page a status line.
agent.post('/progress/:id/:variant', express.json(), (req, res) => {
  const job = isId(req.params.id) && jobs[req.params.id];
  if (!job || !isVariant(req.params.variant) || job.status !== 'processing') return res.status(404).end();
  job.progress = job.progress || {};
  job.progress[req.params.variant] = String((req.body && req.body.text) || '').slice(0, 120);
  job.updatedAt = Date.now(); // in memory only; no need to rewrite jobs.json every few seconds
  res.json({ ok: true });
});

agent.post('/fail/:id/:variant', express.json(), (req, res) => {
  const job = isId(req.params.id) && jobs[req.params.id];
  if (!job || !isVariant(req.params.variant)) return res.status(404).end();
  job.errors[req.params.variant] = String((req.body && req.body.error) || 'Encode gagal').slice(0, 300);
  settle(job);
  res.json({ ok: true });
});

app.use('/agent', agent);

// ---- housekeeping ----
function sweep() {
  const now = Date.now();
  let changed = false;
  for (const job of Object.values(jobs)) {
    if (job.status === 'processing' && now - job.updatedAt > PROCESSING_TIMEOUT_MS) {
      job.status = 'queued'; job.updatedAt = now; changed = true; // agent died, retry what's left
    }
    if (now - job.createdAt > RETENTION_MS && job.status !== 'processing') {
      rm(inPath(job.id));
      for (const v of VARIANTS) { rm(outPath(job.id, v)); rm(outPath(job.id, v) + '.part'); }
      delete jobs[job.id]; changed = true;
    }
  }
  // orphan files (e.g. upload rejected midway)
  for (const dir of [IN_DIR, OUT_DIR]) {
    for (const f of fs.readdirSync(dir)) {
      const id = f.slice(0, 32);
      if (!jobs[id]) {
        try { if (now - fs.statSync(path.join(dir, f)).mtimeMs > RETENTION_MS) rm(path.join(dir, f)); } catch { /* ignore */ }
      }
    }
  }
  if (changed) saveJobs();
}
setInterval(sweep, 60_000).unref();
sweep();

app.listen(PORT, () => console.log(`encode-server listening on :${PORT}`));
