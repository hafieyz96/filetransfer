# encode - upload web, encode di PC

```
Browser --upload--> droplet (queue) <--poll-- PC agent --ffmpeg NVENC--> upload hasil --> Browser download
```

PC hanya buat sambungan keluar, jadi tak perlu tunnel, domain atau port forwarding.
Tiada dependency npm untuk agent (Node 22+ sahaja). Server guna express + multer.

| Folder | Jalan di | Fungsi |
|---|---|---|
| `server/` | droplet | halaman upload, queue job, download hasil |
| `agent/` | PC Windows | tarik job, ffmpeg, upload hasil |

## 1. Droplet

```bash
# salin folder server/ ke /opt/encode-server (scp / git), kemudian:
cd /opt/encode-server
npm install --omit=dev
cp .env.example .env
nano .env        # set AGENT_KEY dan UPLOAD_PASSWORD
npm i -g pm2
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

Jana AGENT_KEY: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`

Port 3000 dah dibuka di UFW. Buka `http://139.59.234.240:3000`.
Ini HTTP biasa, jadi guna video ujian sahaja sehingga ada HTTPS.

## 2. PC (agent)

```powershell
winget install Gyan.FFmpeg          # sekali sahaja, buka terminal baru lepas tu
cd C:\wamp64\www\filetransfer\encode\agent
copy .env.example .env              # isi SERVER_URL dan AGENT_KEY (sama dengan droplet)
npm run check                       # sahkan ffmpeg, NVENC dan sambungan ke droplet
npm start
```

`npm run check` patut cetak `nvenc: true` dan `server ping -> 200`.
Kalau 401, AGENT_KEY tak sama.

Agent kekal berjalan selagi terminal dibuka. Untuk auto-start selepas reboot, guna Task Scheduler
atau `pm2` + `pm2-windows-startup` (belum disediakan).

### Nota NVENC

ffmpeg 9.0.2 (winget Gyan) perlukan driver NVIDIA 610+ untuk NVENC. Dengan driver 595.95 ia gagal
("Driver does not support the required nvenc API version"). Sebab itu agent guna build
**ffmpeg n8.1** dalam `agent/vendor/ffmpeg` (NVENC + NVDEC jalan dengan driver 595). Kalau NVENC
gagal juga, Standard jatuh ke libx264 (CPU) secara automatik.

## Tetapan encode (agent/.env)

- `ENCODER=auto` cuba NVENC (GPU) dulu, jatuh ke libx264 (CPU) bila gagal.
- Output dipotong pada `MAX_SECONDS` (30), diperkecil ke `MAX_HEIGHT` (tak pernah dibesarkan),
  dengan denoise ringan dan sharpen halus. Audio AAC 128k, `+faststart`.
- `QUALITY` dan `MAX_BITRATE`: WhatsApp mampat semula output, jadi cuba beberapa nilai
  dan banding hasil selepas dihantar ke telefon.

## Premium: pipeline AI di GPU (agent/premium.js)

```
analisis -> prep (ffmpeg) -> RIFE interpolasi (Video2X) -> Real-ESRGAN x4 (Video2X) -> tangga encode HEVC 10-bit + VMAF -> pengesahan
```

| Peringkat | Alat | Apa yang dibuat |
|---|---|---|
| Analisis | ffprobe + ffmpeg (blockdetect, blurdetect, signalstats, scdet, cropdetect) | resolusi, SAR, putaran, DAR, fps/VFR, bit depth, HDR, bpp, blok, luma, gerakan, potongan babak, border -> pilih kekuatan denoise |
| Prep | ffmpeg n8.1 | potong ke `MAX_SECONDS`, autorotate, piksel persegi, HDR->SDR (zscale+hable), matriks BT.709, CFR, saiz input AI, pad 8 frame |
| Interpolasi | Video2X 6.4.0, RIFE v4.26 (Vulkan FP16) | x2/x4/x5 ke ~120fps (`max`) atau ~60fps (`balanced`), pengesanan babak 20% |
| Super-resolusi | Video2X, **realesr-general-x4v3** (ditukar dari berat rasmi) | x4, denoise 0.25/0.50/0.75 ikut analisis; master HEVC 10-bit cq12 |
| Encode | ffmpeg hevc_nvenc p7, multipass, spatial+temporal AQ, B-ref, `hvc1` | calon cq30, 33, 36, 39 (atau turun); fail **terkecil** dengan VMAF >= 97 vs master dipilih (`PREMIUM_VMAF_MIN`) |
| Pengesahan | ffprobe + decode penuh (NVDEC) | resolusi, DAR, piksel persegi, fps, tempoh, bilangan frame, audio, decode bersih, tiada border baru, 10-bit, warna setia |

Profil (`PREMIUM_PROFILE`):

| Profil | Sisi pendek output | FPS | Input AI maks |
|---|---|---|---|
| `max` | 2160 (4K-class) | ~120 | 720 |
| `balanced` | 1440 | ~60 | 540 |

FPS akhir = fps sumber x gandaan integer (30 -> 120, 25 -> 125, 29.97 -> 119.88, 60 -> 120), jadi tiada
frame dibuang/diulang. Output tak pernah lebih kecil dari sumber; sisi panjang dihadkan 8192 (had NVENC HEVC).

### Kenapa enjin ini (diukur pada RTX 2060 6GB, driver 595.95)

| Ujian | Kelajuan | VRAM tambahan |
|---|---|---|
| Real-ESRGAN x4plus (RRDB) @540x960 | 0.26 fps | +1.5GB |
| realesr-general-x4v3 @540x960 | 3.2-3.4 fps | +0.85GB |
| realesr-general-x4v3 @1280x720 | 1.8-1.9 fps | +1.4GB |
| RIFE v4.26 x4 @540x960 | 22-37 fps output | +0.3GB |
| RIFE v4.26 x4 @2160x3840 | 2.2-3.0 fps output | **+4.3GB (hampir OOM)** |

**Benchmark sebenar: video 30s, 720x1280, 30fps, 1.8Mbps (gaya WhatsApp), 6.8MB**

| Profil | Output | RIFE | AI upscale | Jumlah | VRAM puncak | Suhu | Saiz akhir | VMAF vs master |
|---|---|---|---|---|---|---|---|---|
| `balanced` | 1440x2560 @60fps | 32s | 8.9 min (3.4 fps) | **14 min** | 2.8GB | 83C | 18.2MB (2.7x) | 95.2 (q36) |
| `max` | 2160x3840 @120fps | 2.3 min | 31.3 min (1.9 fps) | **52 min** | 4.1GB | 83C | 45.0MB (6.6x) | 96.1 (q36) |

Saiz tak boleh lebih kecil dari asal pada 4K/120: data 9x lebih piksel dan 4x lebih frame. Tangga VMAF
memilih q36; q39 ditolak (VMAF 93.7, ada kehilangan nyata). 9 klip ujian 4s (16:9, 9:16, 2.38:1, 4:3,
anamorphic SAR 4:3, 240p SAR ganjil, gelap+noise, 60fps, metadata putaran) semuanya lulus pengesahan.

- x4plus terlalu lambat untuk 120fps (30s = ~4 jam), jadi model kompak rasmi untuk footage sebenar dipakai.
- RIFE pada 4K hampir penuhkan VRAM, jadi interpolasi dibuat **sebelum** upscale, pada resolusi rendah.
- **TensorRT (vs-mlrt)** dinilai: perlukan Python + VapourSynth + ~3.3GB, release terkini pre-release, model
  sama (kualiti sama, cuma lebih laju). Belum dipasang; ini laluan naik taraf kelajuan seterusnya.
- **SR temporal / diffusion** (BasicVSR++, STAR, SeedVR, Upscale-A-Video) perlukan 12-24GB+ VRAM. Tak praktikal.
- **Model muka** (GFPGAN/CodeFormer) sengaja tak dipakai: risiko ubah identiti dan flicker antara frame.
- **AV1**: RTX 20-series tiada AV1 encoder. `PREMIUM_CODEC=av1` guna SVT-AV1 (CPU), sangat lambat pada 4K/120.

### Had dan pepijat yang diketahui (Video2X 6.4.0)

- Segfault **selepas** fail siap ditulis, dan buang 2-3 frame terakhir. Pipeline pad input 8 frame, potong
  ikut tempoh, dan anggap berjaya hanya jika log kata "Video processed successfully" dan output lulus ffprobe.
- Nama model dikunci; model tambahan diletak dalam slot (`vendor/models-live/MODELS.md`), dibaca dari cwd.
- realesr-general-x4v3 + laluan RGB Video2X gelapkan luma ~2-3 tahap (disahkan dengan rujukan PyTorch).
  Anjakan diukur setiap job dan dibetulkan dalam encode akhir.
- Sumber sangat kecil (contoh 240p) cuma dapat satu laluan AI x4; selebihnya ke 2160 guna lanczos.
- HDR sumber ditukar ke SDR BT.709 (tone-map hable) sebelum AI; output dilabel SDR dengan jujur.
- GPU sekitar 83C semasa SR berterusan. Kipas/aliran udara casing mempengaruhi kelajuan panjang.

### Bina semula vendor/ (tidak masuk git)

```powershell
# Video2X 6.4.0: github.com/k4yt3x/video2x/releases -> video2x-windows-amd64.zip -> vendor/video2x
# ffmpeg n8.1 gpl-shared: github.com/BtbN/FFmpeg-Builds (semak checksums.sha256) -> vendor/ffmpeg
# Model general-x4v3 (sekali, CPU cukup):
python -m venv D:\encode-work\pyenv; D:\encode-work\pyenv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cpu
D:\encode-work\pyenv\Scripts\pip install pnnx numpy
#   muat turun realesr-general-x4v3.pth + realesr-general-wdn-x4v3.pth (xinntao/Real-ESRGAN v0.2.5.0)
D:\encode-work\pyenv\Scripts\python agent\tools\convert_realesr_general.py <folder-pth> <folder-out> 0.75 0.5 0.25
#   salin ke slot ikut vendor/models-live/MODELS.md, dan salin video2x/models/rife ke models-live/models/rife
```

Uji: `node agent/premium.js <input> <output> [max|balanced]` atau `node agent/tools/run-tests.js <folder> <out> max`.
Laporan setiap job (masa, fps, VRAM puncak, suhu, calon VMAF, semakan) disimpan di `PREMIUM_WORK_DIR/reports/`.

## Ultra: SeedVR2 restore untuk video kabur/kecil (agent/premium.js, profil `ultra`)

```
analisis -> prep (kecilkan sahaja) -> SeedVR2 3B 480p -> RIFE 60fps -> Real-ESRGAN x4 (ringan) -> 4K -> tangga HEVC VMAF -> pengesahan
```

Premium cuma tajamkan detail yang ada. Ultra guna **SeedVR2** (ByteDance, diffusion satu langkah, Apache-2.0)
yang **cipta semula** detail yang hilang (muka, rambut, kain), diproses 5 frame sekali supaya tak berkelip.
Ditawarkan di page sebagai pilihan ketiga; maks `ULTRA_MAX_SECONDS` (15) saat.

**Diukur pada RTX 2060 6GB** (3B fp16, BlockSwap 32, VAE tiled):

| Ujian | Hasil |
|---|---|
| bfloat16 (default kod SeedVR2) | OOM selepas 17 min untuk 30 frame. Turing cuma emulasi bf16 |
| fp16, output 576p | 7.7 s/frame, wajah setia |
| fp16, output 480p, jubin decode 512 | 4.1 s/frame; kadang-kadang 3-5x lebih lambat (VRAM melimpah ke RAM) |
| fp16, output 480p, jubin decode 384 | **2.3-3.1 s/frame**, tiada limpahan (default) |
| fp16, output 360p + ESRGAN | 1.85 s/frame tapi **wajah bertukar jadi orang lain** (ditolak) |
| E2E 3gp 256x144 2s -> 3840x2160@60 | 3.1 min, VRAM puncak 5.6GB, 12/12 semakan lulus, VMAF 97.0 |
| E2E WhatsApp 360x640 kabur 3s -> 2160x3840@60 | 5.5 min, 5.7GB, 12/12 lulus, VMAF 97.5 |

Had yang jujur: detail **dicipta** (muka mungkin tak 100% sama dengan orang sebenar), teks kecil jadi huruf
rawak, ~2 min proses untuk setiap saat video. Video 1080p/4K dari kamera fon tak perlu Ultra (guna Premium).

**Pasang (sekali, ~10GB, di luar repo):**

```powershell
git clone --depth 1 https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler D:\encode-work\seedvr2\src
py -3.12 -m venv D:\encode-work\seedvr2\venv   # atau python.exe 3.12 penuh
D:\encode-work\seedvr2\venv\Scripts\pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
#   pasang src\requirements.txt tanpa baris torch/torchvision
# model ke D:\encode-work\seedvr2\models\SEEDVR2 dari huggingface.co/numz/SeedVR2_comfyUI:
#   seedvr2_ema_3b_fp16.safetensors (6.78GB, sha256 2fd0e03a...2b304)
#   ema_vae_fp16.safetensors (501MB, sha256 20678548...12ca1)
```

Kod upstream **tidak diubah**. `agent/tools/seedvr2_run.py` paksa fp16 pada GPU tanpa bf16 asli (compute < 8.0)
sebelum pipeline SeedVR2 diimport. Tetapan: `SEEDVR2_DIR`, `ULTRA_MAX_SECONDS`, `ULTRA_DECODE_TILE` (384),
`ULTRA_CHUNK_FRAMES` (150, had RAM). Uji: `node agent/premium.js <input> <output> ultra`.

## Keselamatan dan had

- Link download guna ID rawak 128-bit (sesiapa ada link boleh muat turun). Fail dipadam
  `RETENTION_MINUTES` (60) selepas job siap (bukan selepas upload, supaya hasil Ultra yang lama tak hilang awal).
- Upload dihadkan `MAX_UPLOAD_MB` (100), video sahaja, dan perlukan `UPLOAD_PASSWORD`.
  Password disimpan di browser (localStorage) untuk senang.
- Job "processing" tanpa heartbeat dari agent selama `PROCESSING_TIMEOUT_MINUTES` (30) dikembalikan ke
  queue. Premium hantar heartbeat setiap ~10 saat. Kalau agent mati di tengah jalan, job Premium
  disambung semula dari peringkat terakhir yang siap (fail kerja disimpan sehingga berjaya).
- Queue disimpan dalam `server/data/jobs.json`; restart server tak hilangkan job.

## Belum ada

- Integrasi WhatsApp: tukar pintu masuk (webhook cipta job) dan pintu keluar (hantar melalui Graph API).
  Bahagian agent tak perlu diubah.
- HTTPS dan domain.
