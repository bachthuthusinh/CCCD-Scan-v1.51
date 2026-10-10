// Quét QR Căn cước — © 2026 Thanh Nguyen. Bảo lưu mọi quyền.
// Service worker tối giản: cache giao diện để mở nhanh và dùng được khi mạng yếu
const CACHE = 'cccd-v6';
const ASSETS = ['./', './index.html', './config.js', './manifest.webmanifest', './icon.svg',
  './vendor/html5-qrcode.min.js', './vendor/jsQR.js', './scanner.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;               // không can thiệp việc gửi lên Google Sheet
  if (new URL(req.url).hostname.includes('script.google')) return;
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req))
  );
});
