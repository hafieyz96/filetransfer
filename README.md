# Status HD bot (WhatsApp video enhancer)

Droplet: `139.59.234.240`, kod di `/opt/status-bot`.

## Deploy ke droplet
```bash
rsync -av --exclude node_modules --exclude .env ./ root@139.59.234.240:/opt/status-bot/
ssh root@139.59.234.240 'cd /opt/status-bot && npm install --omit=dev'
```
Salin `.env.example` ke `.env` di server dan isi nilai.

## PM2
```bash
npm i -g pm2
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

## HTTPS untuk test (Cloudflare Tunnel, tanpa domain)
```bash
cloudflared tunnel --url http://localhost:3000
```
Guna URL `https://xxxx.trycloudflare.com/webhook` di Meta (Callback URL) dengan `VERIFY_TOKEN` dari `.env`.
Bila ada domain: Nginx + Let's Encrypt, dan tutup port 3000 di UFW.

## Meta
App Dashboard > WhatsApp > Configuration: set Callback URL + Verify token, subscribe field `messages`.
Isi `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `APP_SECRET` dalam `.env`.

## Nota
- 512MB RAM tipis untuk ffmpeg; resize ke 1GB disyorkan (atau tambah swap).
- Tier bayar (AI): gantikan `enhanceFree` dalam `lib/enhance.js`.
