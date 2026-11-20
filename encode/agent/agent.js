'use strict';
// PC side: outbound-only worker. Polls the droplet, downloads input, encodes, uploads result.
// No inbound port / tunnel needed on this PC.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const SERVER_URL = (process.env.SERVER_URL || '').replace(/\/+$/, '');
const AGENT_KEY = process.env.AGENT_KEY || '';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const ENCODER = (process.env.ENCODER || 'auto').toLowerCase();
const MAX_SECONDS = Number(process.env.MAX_SECONDS || 30);
const MAX_HEIGHT = Number(process.env.MAX_HEIGHT || 1280);
const QUALITY = String(process.env.QUALITY || 23);
const MAX_BITRATE = process.env.MAX_BITRATE || '4M';
const POLL_MS = Number(process.env.POLL_MS || 3000);
const WORK_DIR = path.join(os.tmpdir(), 'encode-agent');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { 'x-api-key': AGENT_KEY };

function rm(p) { try { fs.unlinkSync(p); } catch { /* ignore */ } }

function checkSetup() {
  if (!SERVER_URL) throw new Error('SERVER_URL belum diset (.env)');
  if (!AGENT_KEY || AGENT_KEY === 'tukar-ini') throw new Error('AGENT_KEY belum diset (.env)');
  const r = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`ffmpeg tak jumpa ("${FFMPEG}"). Pasang: winget install Gyan.FFmpeg, atau set FFMPEG_PATH`);
  }
  return { nvenc: /h264_nvenc/.test(r.stdout), x264: /libx264/.test(r.stdout) };
}

// ---- ffmpeg ----
// Standard = quick ffmpeg clean-up. Premium = the AI pipeline in premium.js
// (RIFE + Real-ESRGAN on the GPU via Video2X, NVENC HEVC 10-bit, VMAF-picked size).
const premium = require('./premium');

const PROFILES = {
  standard: {
    // scale down only (never upscale), keep even dimensions; light denoise + gentle sharpen
    vf: () => [
      ...(MAX_HEIGHT > 0 ? [`scale=-2:'min(${MAX_HEIGHT},ih)':flags=lanczos`] : []),
      'hqdn3d=1.5:1.5:4:4', 'unsharp=5:5:0.6:5:5:0.0',
    ],
    quality: () => QUALITY, maxrate: () => MAX_BITRATE,
  },
};

function buildArgs(input, output, useNvenc, variant) {
  const p = PROFILES[variant];
  const venc = useNvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', p.quality(), '-b:v', '0', '-maxrate', p.maxrate(), '-bufsize', '16M']
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', p.quality(), '-maxrate', p.maxrate(), '-bufsize', '16M'];

  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-t', String(MAX_SECONDS),
    '-vf', p.vf().join(','),
    ...venc,
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ];
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exit ${code}`))));
  });
}

let nvencBroken = false; // once NVENC fails (old driver etc.) stop retrying it for every job
let currentAbort = null;  // lets Ctrl+C stop a long premium job cleanly (work dir kept for resume)

async function encode(input, output, caps, variant, job) {
  if (variant === 'premium') return encodePremium(input, output, job);
  const wantGpu = !nvencBroken && (ENCODER === 'nvenc' || (ENCODER === 'auto' && caps.nvenc));
  if (wantGpu) {
    try { return await runFfmpeg(buildArgs(input, output, true, variant)); }
    catch (e) {
      if (ENCODER === 'nvenc') throw e;
      nvencBroken = true;
      log('NVENC gagal, guna CPU seterusnya:', e.message.split('\n').pop());
    }
  }
  if (!caps.x264) throw new Error('ffmpeg ni tiada libx264');
  await runFfmpeg(buildArgs(input, output, false, variant));
}

async function encodePremium(input, output, job) {
  const tag = job.id.slice(0, 8);
  currentAbort = new AbortController();
  let last = 0;
  const report = (text) => {
    // heartbeat: keeps the job alive on the server (long jobs) and shows progress in the page
    api('POST', `/agent/progress/${job.id}/premium`, {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    }).catch(() => {});
  };
  try {
    const r = await premium.enhance({
      input, output, jobId: job.id, signal: currentAbort.signal,
      log: (m) => log(`${tag} premium: ${m}`),
      onProgress: (p) => {
        if (Date.now() - last < 10_000) return;
        last = Date.now();
        const eta = p.etaSec ? `, baki ~${Math.ceil(p.etaSec / 60)} min` : '';
        report(`${p.stage}${p.pct ? ` ${Math.round(p.pct)}%` : ''}${eta}`);
      },
    });
    const o = r.validation.output;
    log(`${tag} premium: ${o.width}x${o.height} ${o.fps.toFixed(2)}fps VMAF ${r.encode.chosen.vmaf} ` +
      `${(o.sizeBytes / 1048576).toFixed(1)}MB, ${Math.round(r.totalSeconds)}s, VRAM puncak ${r.gpu.peakVramMB}MB`);
  } finally {
    currentAbort = null;
  }
}

// ---- server API ----
async function api(method, p, opts = {}) {
  return fetch(SERVER_URL + p, { method, headers: { ...headers, ...(opts.headers || {}) }, body: opts.body, signal: AbortSignal.timeout(opts.timeout || 30_000) });
}

async function processJob(job, caps) {
  const inFile = path.join(WORK_DIR, job.id + '.in');
  const variants = job.todo && job.todo.length ? job.todo : ['standard'];
  const tag = job.id.slice(0, 8);
  try {
    log(`job ${tag} (${job.originalName}) [${variants.join(', ')}] - download`);
    const res = await api('GET', `/agent/input/${job.id}`, { timeout: 300_000 });
    if (!res.ok) throw new Error(`download ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(inFile));
  } catch (e) {
    // can't even get the input: fail every remaining variant
    log('GAGAL download:', e.message);
    for (const v of variants) await reportFail(job.id, v, e.message);
    rm(inFile);
    return;
  }

  // One variant at a time; standard is uploaded before premium starts, so the user gets it early.
  for (const variant of variants) {
    const outFile = path.join(WORK_DIR, `${job.id}.${variant}.mp4`);
    try {
      const t0 = Date.now();
      log(`${tag} ${variant}: encode...`);
      await encode(inFile, outFile, caps, variant, job);
      log(`${tag} ${variant}: siap ${((Date.now() - t0) / 1000).toFixed(1)}s, ${(fs.statSync(outFile).size / 1048576).toFixed(1)}MB - upload`);
      const up = await api('PUT', `/agent/output/${job.id}/${variant}`, {
        headers: { 'content-type': 'application/octet-stream' },
        body: await fs.openAsBlob(outFile),
        timeout: 300_000,
      });
      if (!up.ok) throw new Error(`upload ${up.status}`);
    } catch (e) {
      log(`${tag} ${variant}: GAGAL:`, e.message.split('\n').pop());
      await reportFail(job.id, variant, e.message);
    } finally {
      rm(outFile);
    }
  }
  rm(inFile);
  log(`${tag} selesai`);
}

async function reportFail(id, variant, message) {
  try {
    await api('POST', `/agent/fail/${id}/${variant}`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: message.split('\n').pop() }),
    });
  } catch { /* server will requeue on timeout */ }
}

async function main() {
  const caps = checkSetup();
  if (process.argv.includes('--check')) {
    const r = await api('GET', '/agent/ping').catch((e) => ({ status: 'tak boleh sambung: ' + e.message }));
    console.log(`ffmpeg OK (nvenc: ${caps.nvenc}, libx264: ${caps.x264}); server ping -> ${r.status} (200 = OK, 401 = AGENT_KEY salah)`);
    return;
  }
  fs.mkdirSync(WORK_DIR, { recursive: true });
  process.on('SIGINT', () => {
    if (currentAbort) { log('dibatalkan - kerja premium disimpan untuk disambung semula'); currentAbort.abort(); }
    setTimeout(() => process.exit(130), 1500);
  });
  log(`agent mula. server=${SERVER_URL} encoder=${ENCODER} (nvenc tersedia: ${caps.nvenc}) premium=${premium.CFG.profile}`);
  let backoff = POLL_MS;
  for (;;) {
    try {
      const res = await api('POST', '/agent/claim');
      if (res.status === 200) { backoff = POLL_MS; await processJob(await res.json(), caps); continue; }
      if (res.status === 401) throw new Error('AGENT_KEY ditolak server');
      backoff = POLL_MS;
    } catch (e) {
      log('server tak dapat dicapai:', e.message);
      backoff = Math.min(backoff * 2, 60_000);
    }
    await sleep(backoff);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
