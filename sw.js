// sw.js —— 基础离线缓存（可选增强）。
// 策略：**network-first**（在线一律取最新，离线才回退缓存）——本应用处于快速迭代期，
// cache-first 曾把旧模块喂给页面（见 notes_phone.md N-03）。版本号变更时清理旧缓存。

const CACHE = 'rmnd-webapp-v3';
const ASSETS = [
  './index.html',
  './selftest.html',
  './style.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/protocol.js',
  './js/badge-link.js',
  './js/bmp.js',
  './js/store.js',
  './js/vendor/qr.js',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {/* 个别缺失资源不阻塞安装 */}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // network-first + cache:'reload'：绕过 HTTP 缓存（GitHub Pages max-age=600 曾让部署后
  // 10 分钟内手机拿到旧模块，见 N-11）；断网时回退缓存
  e.respondWith(
    fetch(e.request, { cache: 'reload' })
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || Response.error()))
  );
});
