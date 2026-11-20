// Runs the premium pipeline over a folder of test clips and prints one summary table.
// usage: node tools/run-tests.js <testDir> <outDir> [profile] [filter]
const fs = require('fs');
const path = require('path');
const { enhance } = require('../premium');

const [testDir, outDir, profile = 'max', filter = ''] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const files = fs.readdirSync(testDir).filter((f) => /\.(mp4|mov|mkv)$/i.test(f) && f.includes(filter)).sort();

(async () => {
  const rows = [];
  for (const f of files) {
    const t0 = Date.now();
    const log = (m) => console.log(`[${f}] ${m}`);
    try {
      const r = await enhance({ input: path.join(testDir, f), output: path.join(outDir, f.replace(/\.\w+$/, `.${profile}.mp4`)),
        jobId: `test-${profile}-${f}`, profile, log });
      const o = r.validation.output;
      const failed = Object.entries(r.validation.checks).filter(([, v]) => !v).map(([k]) => k);
      rows.push({ file: f, src: `${r.analysis.displayWidth}x${r.analysis.displayHeight}@${r.analysis.fpsValue}`,
        out: `${o.width}x${o.height}@${o.fps.toFixed(2)}`, darSrc: r.analysis.displayAspect, darOut: o.dar,
        noise: r.analysis.noise, sr: r.plan.srNeeded ? `${r.plan.aiW}x${r.plan.aiH}` : 'skip',
        rifeFps: r.timings.rife ? (r.plan.outFrames / r.timings.rife).toFixed(1) : '-',
        srFps: r.timings.sr ? (r.plan.outFrames / r.timings.sr).toFixed(2) : '-',
        q: r.encode.chosen.q, vmaf: r.encode.chosen.vmaf, sizeX: r.sizeVsOriginal,
        vram: r.gpu.peakVramMB, temp: r.gpu.maxTempC, colour: r.validation.colour ? `${r.validation.colour.dY}/${r.validation.colour.dU}/${r.validation.colour.dV}` : 'hdr',
        total: `${((Date.now() - t0) / 1000).toFixed(0)}s`, checks: failed.length ? 'FAIL:' + failed.join(',') : 'all pass' });
    } catch (e) {
      rows.push({ file: f, checks: 'ERROR ' + e.message.slice(0, 200), total: `${((Date.now() - t0) / 1000).toFixed(0)}s` });
    }
    console.table(rows.slice(-1));
  }
  console.log('\n===== SUMMARY =====');
  console.table(rows);
  fs.writeFileSync(path.join(outDir, `summary-${profile}.json`), JSON.stringify(rows, null, 2));
})();
