const { spawn } = require('node:child_process');

// Tier percuma: ffmpeg sahaja. Tier bayar (AI) boleh tukar fungsi ini kemudian.
const FREE_FILTER = [
  'hqdn3d=2:1.5:3:3', // kurangkan noise
  'scale=-2:1280:flags=lanczos', // naikkan skala (portrait Status ~720x1280)
  'unsharp=5:5:0.8:3:3:0.4', // tajamkan
  'eq=contrast=1.06:saturation=1.12', // warna lebih hidup
].join(',');

function enhanceFree(inputPath, outputPath) {
  const args = [
    '-y', '-i', inputPath,
    '-vf', FREE_FILTER,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-t', '90', // Status had ~90s
    outputPath,
  ];
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(outputPath) : reject(new Error(`ffmpeg exit ${code}: ${err}`)));
  });
}

module.exports = { enhanceFree };
