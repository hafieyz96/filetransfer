'use strict';
// Premium enhancement pipeline (local, RTX GPU).
//
//   analyze -> prep (ffmpeg: trim, rotate, square pixels, HDR->SDR, CFR, AI-input size)
//           -> RIFE frame interpolation   (Video2X, Vulkan/FP16, at AI-input resolution)
//           -> Real-ESRGAN x4             (Video2X, realesr-general-x4v3, denoise picked by analysis)
//           -> final encode ladder        (ffmpeg NVENC HEVC 10-bit, picked by VMAF vs master)
//           -> validation (ffprobe + full decode + border check)
//
// Order chosen from benchmarks on the RTX 2060 6GB (see README):
//   RIFE @540x960 22 fps (+0.3GB VRAM) vs RIFE @2160x3840 2-3 fps (+4.3GB, near OOM)
//   so frames are interpolated at low resolution first, then upscaled.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const VENDOR = path.join(__dirname, 'vendor');
const CFG = {
  ffmpeg: process.env.PREMIUM_FFMPEG || path.join(VENDOR, 'ffmpeg', 'bin', 'ffmpeg.exe'),
  ffprobe: process.env.PREMIUM_FFPROBE || path.join(VENDOR, 'ffmpeg', 'bin', 'ffprobe.exe'),
  video2x: process.env.VIDEO2X_PATH || path.join(VENDOR, 'video2x', 'video2x.exe'),
  modelsLive: process.env.V2X_MODELS_LIVE || path.join(VENDOR, 'models-live'),
  modelsAnime: process.env.V2X_MODELS_ANIME || path.join(VENDOR, 'video2x'),
  workRoot: process.env.PREMIUM_WORK_DIR || path.join(os.tmpdir(), 'encode-premium'),
  profile: process.env.PREMIUM_PROFILE || 'max',
  content: (process.env.PREMIUM_CONTENT || 'auto').toLowerCase(),
  codec: (process.env.PREMIUM_CODEC || 'hevc').toLowerCase(),
  vmafMin: Number(process.env.PREMIUM_VMAF_MIN || 95),
  keepTemp: process.env.PREMIUM_KEEP_TEMP === '1',
  maxSeconds: Number(process.env.MAX_SECONDS || 30),
  rifeModel: process.env.PREMIUM_RIFE_MODEL || 'rife-v4.26',
  sceneThresh: Number(process.env.PREMIUM_SCENE_THRESH || 20),
  minFreeVramMB: Number(process.env.PREMIUM_MIN_FREE_VRAM_MB || 1500),
};

// targetShort: short side of the output (never below the source). fps: target frame rate.
// aiMaxShort: largest short side fed to Real-ESRGAN (cost grows with input pixels:
// 540p ~3.3 fps, 720p ~1.9 fps on the 2060).
const PROFILES = {
  max: { name: 'max', targetShort: 2160, fps: 120, aiMaxShort: 720 },
  balanced: { name: 'balanced', targetShort: 1440, fps: 60, aiMaxShort: 540 },
};

// Video2X only accepts fixed model names; models-live/ maps them to realesr-general-x4v3 at
// different denoise strengths (see vendor/models-live/MODELS.md).
const SR_SLOTS = {
  light: { slot: 'realesr-animevideov3', desc: 'realesr-general-x4v3 strength 0.75 (light denoise)' },
  moderate: { slot: 'realesrgan-plus-anime', desc: 'realesr-general-x4v3 strength 0.50 (medium denoise)' },
  heavy: { slot: 'realesrgan-plus', desc: 'realesr-general-x4v3 strength 0.25 (strong denoise)' },
};

const MP4_AUDIO_COPY = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'alac', 'flac']);
const NVENC_HEVC_MAX = 8192;

// ---------------------------------------------------------------- helpers
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
const parseRate = (r) => {
  const [n, d] = String(r || '0/1').split('/').map(Number);
  return d ? n / d : n || 0;
};
const fmtSec = (s) => (s >= 90 ? `${(s / 60).toFixed(1)}m` : `${s.toFixed(1)}s`);
const mb = (b) => `${(b / 1048576).toFixed(1)}MB`;

function snapFps(f) {
  const std = [[24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [48, 1], [50, 1],
    [60000, 1001], [60, 1], [90, 1], [100, 1], [120000, 1001], [120, 1]];
  // closest standard rate (30.000 must stay 30/1, not snap to 30000/1001)
  let best = null, bestErr = Infinity;
  for (const [n, d] of std) {
    const err = Math.abs(f - n / d) / (n / d);
    if (err < bestErr) { best = { num: n, den: d }; bestErr = err; }
  }
  return bestErr < 0.003 ? best : { num: Math.round(f * 1000), den: 1000 };
}

function run(cmd, args, { cwd, signal, onStdout, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    const kill = () => p.kill();
    if (signal) {
      if (signal.aborted) return kill(), reject(new Error('dibatalkan'));
      signal.addEventListener('abort', kill, { once: true });
    }
    p.stdout.on('data', (d) => { out = (out + d).slice(-200_000); if (onStdout) onStdout(String(d)); });
    p.stderr.on('data', (d) => { err = (err + d).slice(-200_000); if (onStderr) onStderr(String(d)); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', kill);
      if (signal && signal.aborted) return reject(new Error('dibatalkan'));
      resolve({ code, out, err });
    });
  });
}

async function ffmpeg(args, opts) {
  const r = await run(CFG.ffmpeg, ['-hide_banner', '-nostdin', ...args], opts);
  if (r.code !== 0) throw new Error(`ffmpeg: ${r.err.trim().split('\n').slice(-3).join(' | ') || 'exit ' + r.code}`);
  return r;
}

async function probe(file) {
  const r = await run(CFG.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) throw new Error(`ffprobe: ${r.err.trim()}`);
  return JSON.parse(r.out);
}

async function countFrames(file) {
  const r = await run(CFG.ffprobe, ['-v', 'error', '-count_packets', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]);
  return Number(r.out.trim()) || 0;
}

// ---------------------------------------------------------------- GPU monitor
function nvidiaSmi() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu',
      '--format=csv,noheader,nounits'], { windowsHide: true }, (e, out) => {
      if (e) return resolve(null);
      const [used, total, util, temp] = out.trim().split('\n')[0].split(',').map(Number);
      resolve({ used, total, util, temp });
    });
  });
}

class GpuMonitor {
  constructor(log) { this.log = log; this.s = { peakMB: 0, baseMB: null, utilSum: 0, n: 0, maxTemp: 0 }; }
  start() {
    this.iv = setInterval(async () => {
      const g = await nvidiaSmi();
      if (!g) return;
      const s = this.s;
      if (s.baseMB === null) s.baseMB = g.used;
      s.peakMB = Math.max(s.peakMB, g.used); s.utilSum += g.util; s.n++; s.maxTemp = Math.max(s.maxTemp, g.temp);
      if (g.temp >= 87 && !this.warnedTemp) { this.warnedTemp = true; this.log(`AMARAN: GPU ${g.temp}C`); }
      if (g.total - g.used < 300 && !this.warnedVram) { this.warnedVram = true; this.log(`AMARAN: VRAM hampir penuh (${g.used}/${g.total}MB)`); }
    }, 2000);
    return this;
  }
  stop() {
    clearInterval(this.iv);
    const s = this.s;
    return { peakVramMB: s.peakMB, baselineVramMB: s.baseMB, avgGpuUtil: s.n ? Math.round(s.utilSum / s.n) : null, maxTempC: s.maxTemp };
  }
}

// ---------------------------------------------------------------- analysis
async function analyze(input, log, signal) {
  const j = await probe(input);
  const v = j.streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new Error('Tiada stream video');
  // Keep only audio ffmpeg can decode. iPhone .mov files can carry an extra track (e.g. Spatial
  // Audio / APAC) that probes as codec "none"; mapping it makes the final encode fail outright.
  const allAudio = j.streams.filter((s) => s.codec_type === 'audio');
  const audio = allAudio.filter((s) => s.codec_name && !['none', 'unknown'].includes(s.codec_name));
  if (audio.length < allAudio.length) log(`audio: ${allAudio.length - audio.length} trek tanpa decoder diabaikan`);

  const [sn, sd] = String(v.sample_aspect_ratio || '1:1').split(':').map(Number);
  const sar = sn > 0 && sd > 0 ? sn / sd : 1;
  let rot = 0;
  for (const s of v.side_data_list || []) if (s.rotation != null) rot = Number(s.rotation);
  if (v.tags && v.tags.rotate) rot = Number(v.tags.rotate);
  rot = (((Math.round(rot / 90) * 90) % 360) + 360) % 360;
  let dispW = v.width * sar, dispH = v.height;
  if (rot === 90 || rot === 270) [dispW, dispH] = [dispH, dispW];

  const avg = parseRate(v.avg_frame_rate), real = parseRate(v.r_frame_rate);
  const fps = snapFps(avg || real);
  const fpsVal = fps.num / fps.den;
  const duration = Math.min(Number(j.format.duration) || Number(v.duration) || 0, CFG.maxSeconds);
  const bitDepth = /(10|12)(le|be)$|p010|p012/.test(v.pix_fmt || '') ? (/(12)/.test(v.pix_fmt) ? 12 : 10) : 8;
  const hdr = ['smpte2084', 'arib-std-b67'].includes(v.color_transfer);
  const bitrate = Number(v.bit_rate) || Number(j.format.bit_rate) || 0;
  const bpp = bitrate / (v.width * v.height * fpsVal);

  // sampled frame quality (~1 frame per second, full resolution)
  const step = Math.max(1, Math.round(fpsVal));
  const q = await ffmpeg(['-t', String(duration), '-i', input, '-an', '-sn', '-vf',
    `select='not(mod(n\\,${step}))',blockdetect,blurdetect,signalstats,cropdetect=limit=24:round=2:reset=1,metadata=print`,
    '-f', 'null', '-'], { signal });
  const nums = (key) => [...q.err.matchAll(new RegExp(`lavfi\\.${key}=([\\d.]+)`, 'g'))].map((m) => Number(m[1]));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const block = mean(nums('block')), blur = mean(nums('blur')), yavg = mean(nums('signalstats\\.YAVG'));
  const cropW = Math.max(0, ...nums('cropdetect\\.w')), cropH = Math.max(0, ...nums('cropdetect\\.h'));

  // motion + scene cuts on a small copy of every frame
  const m = await ffmpeg(['-t', String(duration), '-i', input, '-an', '-sn', '-vf',
    'scale=-2:270,scdet=threshold=12,metadata=print', '-f', 'null', '-'], { signal });
  const mafd = mean([...m.err.matchAll(/lavfi\.scd\.mafd=([\d.]+)/g)].map((x) => Number(x[1])));
  const sceneCuts = (m.err.match(/lavfi\.scd\.time=/g) || []).length;

  // denoise strength for Real-ESRGAN: compression (bits per pixel), blocking, low light
  let level = bpp > 0 && bpp < 0.035 || block > 3 ? 2 : bpp < 0.09 || block > 2.2 ? 1 : 0;
  const lowLight = yavg > 0 && yavg < 45;
  if (lowLight) level = Math.min(2, level + 1);
  const noise = ['light', 'moderate', 'heavy'][level];

  const a = {
    width: v.width, height: v.height, sar, rotation: rot,
    displayWidth: Math.round(dispW), displayHeight: Math.round(dispH),
    displayAspect: +(dispW / dispH).toFixed(4),
    fps, fpsValue: +fpsVal.toFixed(3), vfr: Math.abs(avg - real) / (real || 1) > 0.01,
    duration, sourceDuration: Number(j.format.duration) || 0,
    codec: v.codec_name, pixFmt: v.pix_fmt, bitDepth, hdr,
    colorTransfer: v.color_transfer || 'unknown', colorSpace: v.color_space || 'unknown', colorPrimaries: v.color_primaries || 'unknown',
    bitrate, bitsPerPixel: +bpp.toFixed(4), blockiness: +block.toFixed(2), blur: +blur.toFixed(2),
    meanLuma: +yavg.toFixed(1), lowLight, motion: +mafd.toFixed(2), sceneCuts,
    borders: cropW && cropH ? { w: cropW, h: cropH, hasBorders: cropW < v.width * 0.98 || cropH < v.height * 0.98 } : null,
    noise,
    audio: audio.map((s) => ({ index: s.index, codec: s.codec_name, channels: s.channels })),
    sizeBytes: fs.statSync(input).size,
  };
  log(`analisis: ${a.displayWidth}x${a.displayHeight} (DAR ${a.displayAspect}, rot ${rot}, SAR ${sar.toFixed(3)}) `
    + `${a.fpsValue}fps${a.vfr ? ' VFR' : ''} ${duration.toFixed(1)}s ${a.codec} ${bitDepth}bit ${hdr ? 'HDR' : 'SDR'} `
    + `bpp=${a.bitsPerPixel} block=${a.blockiness} luma=${a.meanLuma} motion=${a.motion} cuts=${sceneCuts} -> noise=${noise}`);
  return a;
}

// ---------------------------------------------------------------- plan
function plan(a, profile) {
  const short = Math.min(a.displayWidth, a.displayHeight);
  const long = Math.max(a.displayWidth, a.displayHeight);
  let scale = Math.max(profile.targetShort, short) / short; // never output below the source
  if (long * scale > NVENC_HEVC_MAX) scale = NVENC_HEVC_MAX / long;
  const outW = even(a.displayWidth * scale), outH = even(a.displayHeight * scale);

  // AI super-resolution only pays off when we really enlarge the picture
  const srNeeded = Math.min(outW, outH) > short * 1.33;
  const aiShort = srNeeded ? Math.min(short, profile.aiMaxShort) : short;
  const k = aiShort / short;
  const aiW = even(a.displayWidth * k), aiH = even(a.displayHeight * k);

  const mult = profile.fps > a.fpsValue * 1.05 ? Math.max(1, Math.round(profile.fps / a.fpsValue)) : 1;
  const outFps = { num: a.fps.num * mult, den: a.fps.den };
  const content = CFG.content === 'anime' ? 'anime' : 'live';
  const sr = srNeeded ? (content === 'anime'
    ? { slot: 'realesr-animevideov3', desc: 'realesr-animevideov3 (anime)', cwd: CFG.modelsAnime }
    : { ...SR_SLOTS[a.noise], cwd: CFG.modelsLive }) : null;
  const frames = Math.round(a.duration * a.fpsValue);
  return {
    profile: profile.name, content, outW, outH, aiW, aiH, srNeeded, sr, mult, outFps,
    outFpsValue: +(outFps.num / outFps.den).toFixed(3), frames, outFrames: frames * mult,
    srW: aiW * 4, srH: aiH * 4,
    rifeUhd: Math.min(aiW, aiH) > 1080,
  };
}

// ---------------------------------------------------------------- Video2X
function video2x(args, { cwd, signal, onProgress, label }) {
  // Video2X 6.4.0 on this machine segfaults *after* writing the file, and drops the last
  // couple of frames; success = its own success line + a valid output (checked by caller).
  return run(CFG.video2x, ['--log-level', 'info', ...args], {
    cwd, signal,
    onStdout: (chunk) => {
      const all = [...chunk.matchAll(/frame=(\d+)\/(\d+) \(([\d.]+)%\); fps=([\d.inf]+);.*?remaining=(\d+):(\d+):(\d+)/g)];
      const last = all[all.length - 1];
      if (last && onProgress) {
        onProgress({ stage: label, pct: Number(last[3]), fps: Number(last[4]) || 0,
          etaSec: Number(last[5]) * 3600 + Number(last[6]) * 60 + Number(last[7]) });
      }
    },
  }).then((r) => {
    if (!/Video processed successfully/.test(r.out + r.err)) {
      throw new Error(`Video2X ${label} gagal (exit ${r.code}): ${(r.err || r.out).trim().split('\n').slice(-2).join(' | ')}`);
    }
    return r;
  });
}

// ---------------------------------------------------------------- final encode
function encoderArgs(codec, q, fps) {
  const gop = String(Math.round(fps * 2));
  if (codec === 'av1') {
    // software SVT-AV1 (RTX 20-series has no AV1 encoder); slow at 4K/120
    return ['-c:v', 'libsvtav1', '-preset', '6', '-crf', String(q), '-g', gop,
      '-svtav1-params', 'tune=0:scd=1:enable-overlays=1', '-pix_fmt', 'yuv420p10le'];
  }
  return ['-c:v', 'hevc_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q), '-b:v', '0',
    '-multipass', 'fullres', '-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '32',
    '-bf', '3', '-b_ref_mode', 'middle', '-g', gop, '-profile:v', 'main10', '-pix_fmt', 'p010le', '-tag:v', 'hvc1'];
}

// Real-ESRGAN (general-x4v3, confirmed against the PyTorch reference) plus Video2X's RGB round
// trip darken luma by ~2-3 code values. The drift is measured per job (prep vs master) and undone
// here, on 10-bit values (x4), for both the delivered file and the VMAF reference.
const lumaFix = (fixY) => (fixY ? `,format=yuv420p10le,lutyuv=y=clip(val+${(fixY * 4).toFixed(2)}\\,minval\\,maxval)` : '');

async function encodeFinal({ master, input, out, p, a, codec, q, signal, fixY }) {
  const fpsStr = `${p.outFps.num}/${p.outFps.den}`;
  const audioCopy = a.audio.length && a.audio.every((s) => MP4_AUDIO_COPY.has(s.codec));
  await ffmpeg(['-y', '-hwaccel', 'cuda', '-i', master, '-i', input,
    '-map', '0:v:0', ...a.audio.flatMap((s) => ['-map', `1:${s.index}`]), '-t', a.duration.toFixed(3),
    '-vf', `scale=${p.outW}:${p.outH}:flags=lanczos,setsar=1,fps=${fpsStr}${lumaFix(fixY)}`,
    ...encoderArgs(codec, q, p.outFpsValue),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    ...(audioCopy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
    '-movflags', '+faststart', out], { signal });
}

async function vmaf(distorted, master, p, a, signal, fixY) {
  const sub = Math.max(1, Math.round(p.outFrames / 150));
  const model = Math.min(p.outW, p.outH) >= 1440 ? 'version=vmaf_4k_v0.6.1' : 'version=vmaf_v0.6.1';
  const r = await ffmpeg(['-hwaccel', 'cuda', '-i', distorted, '-hwaccel', 'cuda', '-i', master, '-lavfi',
    `[0:v]setpts=PTS-STARTPTS[d];[1:v]trim=duration=${a.duration.toFixed(3)},scale=${p.outW}:${p.outH}:flags=lanczos,`
    + `fps=${p.outFps.num}/${p.outFps.den}${lumaFix(fixY)},setpts=PTS-STARTPTS[r];[d][r]libvmaf=model=${model}:n_subsample=${sub}:n_threads=${os.cpus().length}`,
    '-f', 'null', '-'], { signal });
  const m = r.err.match(/VMAF score: ([\d.]+)/);
  if (!m) throw new Error('VMAF tiada skor');
  return Number(m[1]);
}

// ---------------------------------------------------------------- validation
// Mean Y/U/V of the same sampled moments in source (converted to BT.709) and output.
// Catches colour-matrix mistakes (BT.601 vs 709) and level shifts introduced by the AI stages.
async function colorMeans(file, duration, toBt709, signal) {
  const n = 6;
  const sel = Array.from({ length: n }, (_, i) => `between(t\\,${((duration * (i + 0.5)) / n).toFixed(2)}\\,${((duration * (i + 0.5)) / n + 0.05).toFixed(2)})`).join('+'); // 50ms window: >= 1 frame at 24fps
  const r = await run(CFG.ffmpeg, ['-hide_banner', '-i', file, '-an', '-vf',
    `select='${sel}',scale=480:-2${toBt709 ? ':out_color_matrix=bt709' : ''},format=yuv420p,signalstats,metadata=print`, '-f', 'null', '-'], { signal });
  const avg = (k) => {
    const v = [...r.err.matchAll(new RegExp(`signalstats\\.${k}=([\\d.]+)`, 'g'))].map((m) => Number(m[1]));
    return v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN;
  };
  return { y: avg('YAVG'), u: avg('UAVG'), v: avg('VAVG') };
}

async function validate(out, a, p, signal, input) {
  const j = await probe(out);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const audio = j.streams.filter((s) => s.codec_type === 'audio');
  const dur = Number(j.format.duration);
  const dec = await run(CFG.ffmpeg, ['-hide_banner', '-v', 'error', '-hwaccel', 'cuda', '-i', out, '-f', 'null', '-'], { signal });
  const frames = await countFrames(out);
  const step = Math.max(1, Math.round(p.outFpsValue));
  const c = await run(CFG.ffmpeg, ['-hide_banner', '-i', out, '-an', '-vf',
    `select='not(mod(n\\,${step}))',cropdetect=limit=24:round=2:reset=1,metadata=print`, '-f', 'null', '-'], { signal });
  const cw = Math.max(0, ...[...c.err.matchAll(/lavfi\.cropdetect\.w=(\d+)/g)].map((x) => Number(x[1])));
  const ch = Math.max(0, ...[...c.err.matchAll(/lavfi\.cropdetect\.h=(\d+)/g)].map((x) => Number(x[1])));
  const outBorders = cw && ch && (cw < v.width * 0.98 || ch < v.height * 0.98);
  const dar = v.width / v.height;
  let colour = null;
  if (input && !a.hdr) {
    const s = await colorMeans(input, a.duration, true, signal);
    const o = await colorMeans(out, a.duration, false, signal);
    colour = { source: s, output: o, dY: +(o.y - s.y).toFixed(2), dU: +(o.u - s.u).toFixed(2), dV: +(o.v - s.v).toFixed(2) };
  }
  const checks = {
    resolution: v.width === p.outW && v.height === p.outH,
    aspectPreserved: Math.abs(dar - a.displayAspect) / a.displayAspect < 0.005,
    squarePixels: !v.sample_aspect_ratio || v.sample_aspect_ratio === '1:1' || v.sample_aspect_ratio === '0:1',
    fps: Math.abs(parseRate(v.avg_frame_rate) - p.outFpsValue) < 0.05,
    duration: Math.abs(dur - a.duration) < 0.15,
    frames: Math.abs(frames - Math.round(a.duration * p.outFpsValue)) <= 2,
    audioTracks: audio.length === a.audio.length,
    audioSync: audio.every((s) => !s.duration || Math.abs(Number(s.duration) - a.duration) < 0.15),
    decodesCleanly: dec.code === 0 && !dec.err.trim(),
    noNewBorders: !(outBorders && !(a.borders && a.borders.hasBorders)),
    tenBit: /10le$|p010/.test(v.pix_fmt || ''),
    colourFaithful: !colour || (Math.abs(colour.dY) < 2 && Math.abs(colour.dU) < 2.5 && Math.abs(colour.dV) < 2.5),
  };
  return {
    checks, ok: Object.values(checks).every(Boolean), colour,
    output: { width: v.width, height: v.height, dar: +dar.toFixed(4), fps: parseRate(v.avg_frame_rate), frames,
      duration: +dur.toFixed(3), codec: v.codec_name, pixFmt: v.pix_fmt, audioTracks: audio.length,
      sizeBytes: fs.statSync(out).size, decodeErrors: dec.err.trim().slice(0, 300) },
  };
}

// ---------------------------------------------------------------- main
/**
 * @param {object} o
 * @param {string} o.input   source video (never modified or deleted)
 * @param {string} o.output  final mp4 path
 * @param {string} o.jobId   used for the resumable work dir
 * @param {(msg:string)=>void} [o.log]
 * @param {(p:object)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 */
async function enhance({ input, output, jobId, log = console.log, onProgress = () => {}, signal, profile: profName }) {
  const profile = PROFILES[profName || CFG.profile];
  if (!profile) throw new Error(`Profil tak dikenali: ${profName || CFG.profile}`);
  for (const f of [CFG.ffmpeg, CFG.ffprobe, CFG.video2x]) if (!fs.existsSync(f)) throw new Error(`Enjin tiada: ${f}`);

  const dir = path.join(CFG.workRoot, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const timings = {};
  const gpu = new GpuMonitor(log).start();
  const report = { profile: profile.name, engines: { ffmpeg: CFG.ffmpeg, video2x: CFG.video2x, rife: CFG.rifeModel } };

  // stage helper: resumable (marker file next to its output)
  const stage = async (name, file, fn) => {
    const marker = path.join(dir, `${name}.done.json`);
    if (fs.existsSync(marker) && fs.existsSync(file)) {
      log(`sambung semula: langkau ${name}`);
      return JSON.parse(fs.readFileSync(marker, 'utf8'));
    }
    const s0 = Date.now();
    const info = (await fn()) || {};
    info.seconds = +((Date.now() - s0) / 1000).toFixed(1);
    fs.writeFileSync(marker, JSON.stringify(info));
    timings[name] = info.seconds;
    return info;
  };

  try {
    // ---- preflight
    const g = await nvidiaSmi();
    if (g && g.total - g.used < CFG.minFreeVramMB) log(`AMARAN: VRAM bebas cuma ${g.total - g.used}MB`);
    report.hardware = g ? { vramTotalMB: g.total, vramUsedAtStartMB: g.used } : null;

    onProgress({ stage: 'analisis', pct: 0 });
    const a = await analyze(input, log, signal);
    const p = plan(a, profile);
    report.analysis = a; report.plan = p;
    log(`pelan: ${p.aiW}x${p.aiH} -> RIFE x${p.mult} -> ${p.srNeeded ? `ESRGAN x4 ${p.srW}x${p.srH} [${p.sr.desc}]` : 'tiada SR'} -> ${p.outW}x${p.outH} @${p.outFpsValue}fps`);

    // disk check (lossless intermediates + 10-bit master), generous
    const need = p.aiW * p.aiH * 1.5 * 0.5 * (p.frames + p.outFrames) + p.outW * p.outH * p.outFrames * 0.06 + 200e6;
    const st = fs.statfsSync(dir);
    const free = st.bavail * st.bsize;
    if (free < need * 1.5) throw new Error(`Ruang SSD tak cukup: perlu ~${mb(need * 1.5)}, ada ${mb(free)} di ${dir}`);

    // ---- prep: trim, autorotate (ffmpeg default), square pixels, colour, CFR, AI-input size, pad
    const prep = path.join(dir, 'prep.mp4');
    await stage('prep', prep, async () => {
      onProgress({ stage: 'persediaan', pct: 0 });
      const vf = [];
      if (a.hdr) vf.push('zscale=t=linear:npl=203', 'format=gbrpf32le', 'zscale=p=bt709',
        'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
      vf.push(`scale=${p.aiW}:${p.aiH}:flags=lanczos:out_color_matrix=bt709:out_range=tv`, 'setsar=1',
        `fps=${a.fps.num}/${a.fps.den}`, 'tpad=stop_mode=clone:stop=8', 'format=yuv420p');
      await ffmpeg(['-y', '-t', a.duration.toFixed(3), '-i', input, '-an', '-sn', '-dn', '-vf', vf.join(','),
        '-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', '-colorspace', 'bt709', '-color_primaries', 'bt709',
        '-color_trc', 'bt709', prep], { signal });
      return { frames: await countFrames(prep) };
    });

    // ---- RIFE interpolation (low resolution, cheap, VRAM-safe)
    let cur = prep;
    if (p.mult > 1) {
      const interp = path.join(dir, 'interp.mp4');
      const info = await stage('rife', interp, async () => {
        await video2x(['-i', prep, '-o', interp, '-p', 'rife', '-m', String(p.mult), '--rife-model', CFG.rifeModel,
          '-t', String(CFG.sceneThresh), ...(p.rifeUhd ? ['--rife-uhd'] : []),
          '-c', 'libx264', '-e', 'qp=0', '-e', 'preset=ultrafast', '--pix-fmt', 'yuv420p', '--no-copy-streams'],
        { cwd: CFG.modelsLive, signal, label: 'interpolasi RIFE', onProgress });
        const frames = await countFrames(interp);
        if (frames < p.outFrames) throw new Error(`RIFE keluarkan ${frames} frame, jangka >= ${p.outFrames}`);
        return { frames };
      });
      log(`RIFE x${p.mult}: ${info.frames} frame, ${fmtSec(info.seconds)} (${(info.frames / info.seconds).toFixed(1)} fps)`);
      cur = interp;
    }

    // ---- Real-ESRGAN x4 -> 10-bit high quality master
    if (p.srNeeded) {
      const sr = path.join(dir, 'sr.mp4');
      const info = await stage('sr', sr, async () => {
        await video2x(['-i', cur, '-o', sr, '-p', 'realesrgan', '-s', '4', '--realesrgan-model', p.sr.slot,
          '-c', 'hevc_nvenc', '--pix-fmt', 'p010le', '-e', 'preset=p4', '-e', 'rc=vbr', '-e', 'cq=12',
          '-e', 'spatial-aq=1', '--no-copy-streams'],
        { cwd: p.sr.cwd, signal, label: 'AI upscale', onProgress });
        const frames = await countFrames(sr);
        if (frames < p.outFrames) throw new Error(`ESRGAN keluarkan ${frames} frame, jangka >= ${p.outFrames}`);
        return { frames };
      });
      log(`ESRGAN x4: ${info.frames} frame, ${fmtSec(info.seconds)} (${(info.frames / info.seconds).toFixed(2)} fps)`);
      cur = sr;
    }
    const master = cur;
    report.masterBytes = fs.statSync(master).size;

    // measured luma drift introduced by the AI stages (prep -> master), corrected in the final encode
    let fixY = 0;
    if (master !== prep) {
      const cp = await colorMeans(prep, a.duration, false, signal);
      const cm = await colorMeans(master, a.duration, false, signal);
      const dY = cm.y - cp.y;
      fixY = Math.abs(dY) >= 0.75 ? +(-dY).toFixed(2) : 0;
      report.lumaCorrection = { measuredDriftY: +dY.toFixed(2), appliedY: fixY };
      log(`anjakan luma AI: ${dY.toFixed(2)} -> pembetulan ${fixY}`);
    }

    // ---- encode ladder: smallest file whose VMAF vs the master >= vmafMin
    const codec = CFG.codec === 'av1' ? 'av1' : 'hevc';
    const ladder = codec === 'av1' ? { start: 32, step: 4, min: 20, max: 48 } : { start: 30, step: 3, min: 18, max: 39 };
    const tries = [];
    const tryQ = async (q) => {
      const f = path.join(dir, `cand-${codec}-${q}.mp4`);
      onProgress({ stage: `encode ${codec.toUpperCase()} q${q}`, pct: 0 });
      const e0 = Date.now();
      await encodeFinal({ master, input, out: f, p, a, codec, q, signal, fixY });
      const encSec = (Date.now() - e0) / 1000;
      onProgress({ stage: `VMAF q${q}`, pct: 0 });
      const score = await vmaf(f, master, p, a, signal, fixY);
      const t = { q, file: f, bytes: fs.statSync(f).size, vmaf: +score.toFixed(2), encodeSec: +encSec.toFixed(1) };
      tries.push(t);
      log(`calon ${codec} q${q}: ${mb(t.bytes)} VMAF ${t.vmaf} (${fmtSec(encSec)})`);
      return t;
    };
    let best = null;
    let t = await tryQ(ladder.start);
    if (t.vmaf >= CFG.vmafMin) {
      best = t;
      for (let q = ladder.start + ladder.step; q <= ladder.max; q += ladder.step) {
        const n = await tryQ(q);
        if (n.vmaf < CFG.vmafMin) break;
        best = n;
      }
    } else {
      for (let q = ladder.start - ladder.step; q >= ladder.min; q -= ladder.step) {
        t = await tryQ(q);
        if (t.vmaf >= CFG.vmafMin) { best = t; break; }
      }
      if (!best) best = tries[tries.length - 1];
    }
    for (const c of tries) if (c !== best) fs.rmSync(c.file, { force: true });
    fs.copyFileSync(best.file, output);
    report.encode = { codec, chosen: { q: best.q, vmaf: best.vmaf, bytes: best.bytes },
      candidates: tries.map(({ file, ...r }) => r), vmafMin: CFG.vmafMin };

    // ---- validate
    onProgress({ stage: 'pengesahan', pct: 0 });
    const val = await validate(output, a, p, signal, input);
    report.validation = val;
    report.sizeVsOriginal = +(best.bytes / a.sizeBytes).toFixed(2);
    log(`pengesahan: ${val.ok ? 'LULUS' : 'GAGAL'} ${JSON.stringify(val.checks)}`);
    log(`saiz: asal ${mb(a.sizeBytes)} -> akhir ${mb(best.bytes)} (${report.sizeVsOriginal}x)`);
    if (!val.ok) throw new Error(`Output gagal pengesahan: ${Object.entries(val.checks).filter(([, v]) => !v).map(([k]) => k).join(', ')}`);
    return report;
  } finally {
    report.gpu = gpu.stop();
    report.timings = timings;
    report.totalSeconds = +((Date.now() - t0) / 1000).toFixed(1);
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    // keep the work dir on failure so the job can resume; clean it on success
    if (report.validation && report.validation.ok && !CFG.keepTemp) {
      fs.mkdirSync(path.join(CFG.workRoot, 'reports'), { recursive: true });
      fs.copyFileSync(path.join(dir, 'report.json'), path.join(CFG.workRoot, 'reports', `${jobId}.json`));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

module.exports = { enhance, analyze, plan, PROFILES, CFG };

// CLI: node premium.js <input> <output> [max|balanced]
if (require.main === module) {
  const [input, output, prof] = process.argv.slice(2);
  if (!input || !output) { console.error('guna: node premium.js <input> <output> [max|balanced]'); process.exit(2); }
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  let lastP = 0;
  enhance({
    input: path.resolve(input), output: path.resolve(output), profile: prof,
    jobId: 'cli-' + path.basename(input).replace(/[^\w.-]/g, '_'), signal: ac.signal,
    log: (m) => console.log(new Date().toISOString().slice(11, 19), m),
    onProgress: (p) => {
      if (Date.now() - lastP < 5000) return; lastP = Date.now();
      console.log(`  .. ${p.stage} ${p.pct != null ? p.pct.toFixed(0) + '%' : ''}${p.fps ? ` ${p.fps}fps` : ''}${p.etaSec ? ` ETA ${fmtSec(p.etaSec)}` : ''}`);
    },
  }).then((r) => { console.log(JSON.stringify({ validation: r.validation, encode: r.encode, gpu: r.gpu, timings: r.timings, totalSeconds: r.totalSeconds }, null, 2)); })
    .catch((e) => { console.error('GAGAL:', e.message); process.exit(1); });
}
