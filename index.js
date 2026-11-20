require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const wa = require('./lib/whatsapp');
const { enhanceFree } = require('./lib/enhance');

const app = express();
const PORT = process.env.PORT || 3000;

// Simpan raw body untuk semakan tandatangan X-Hub-Signature-256
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/filetransfer', require('./lib/filetransfer'));

// Meta webhook verification
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

function validSignature(req) {
  const secret = process.env.APP_SECRET;
  if (!secret) return true; // dev sahaja; set APP_SECRET di produksi
  const sig = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Beri giliran: 1 vCPU, proses satu video pada satu masa
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch((e) => console.error('job error', e)));

async function handleVideo(from, mediaId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
  const inp = path.join(dir, 'in.mp4');
  const out = path.join(dir, 'out.mp4');
  try {
    await wa.sendText(from, 'Video diterima, sedang ditingkatkan kualiti... ⏳');
    await wa.downloadMedia(mediaId, inp);
    await enhanceFree(inp, out);
    const id = await wa.uploadMedia(out);
    await wa.sendVideo(from, id, 'Siap! Boleh forward ke Status anda. ✨');
  } catch (e) {
    console.error(e);
    const msg = e.message === 'TOO_LARGE'
      ? 'Video terlalu besar (maks ~16MB). Cuba video lebih pendek.'
      : 'Maaf, ada masalah memproses video. Cuba lagi.';
    await wa.sendText(from, msg).catch(() => {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

app.post('/webhook', (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200); // balas segera, proses di belakang

  const messages = (req.body.entry || [])
    .flatMap((e) => e.changes || [])
    .flatMap((c) => c.value?.messages || []);

  for (const m of messages) {
    console.log('msg', m.type, m.from);
    if (m.type === 'video') enqueue(() => handleVideo(m.from, m.video.id));
    else if (m.type === 'text') {
      enqueue(() => wa.sendText(m.from, 'Hantar video anda dan saya akan tingkatkan kualitinya untuk Status. 🎬').catch(console.error));
    }
  }
});

app.listen(PORT, () => console.log(`status-bot listening on :${PORT}`));
