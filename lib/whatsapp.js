const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const base = () => `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v21.0'}`;
const auth = () => ({ Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` });

async function check(res) {
  if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text()}`);
  return res;
}

async function downloadMedia(mediaId, destPath) {
  const meta = await (await check(await fetch(`${base()}/${mediaId}`, { headers: auth() }))).json();
  const max = Number(process.env.MAX_INPUT_BYTES || 16000000);
  if (meta.file_size && meta.file_size > max) throw new Error('TOO_LARGE');
  const res = await check(await fetch(meta.url, { headers: auth() }));
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
}

async function uploadMedia(filePath, mime = 'video/mp4') {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([fs.readFileSync(filePath)], { type: mime }), 'hd.mp4');
  const res = await check(await fetch(`${base()}/${process.env.PHONE_NUMBER_ID}/media`, {
    method: 'POST', headers: auth(), body: form,
  }));
  return (await res.json()).id;
}

async function send(to, payload) {
  await check(await fetch(`${base()}/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...payload }),
  }));
}

const sendText = (to, body) => send(to, { type: 'text', text: { body } });
const sendVideo = (to, mediaId, caption) =>
  send(to, { type: 'video', video: { id: mediaId, caption } });

module.exports = { downloadMedia, uploadMedia, sendText, sendVideo };
