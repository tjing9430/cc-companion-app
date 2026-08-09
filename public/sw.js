// ⚠️ 改了 app.js / styles.css 就要 bump 这个版本号(等价于主站的 ?v= 缓存串)。
// 2026-08-09 踩过:没 bump + 下面 fetch 是 stale-while-revalidate(先给缓存、新的只存下次用)
// → 用户永远慢一个刷新,把我已经修好的东西当成「你忘记做了」。现在核心资源改成 network-first。
const CACHE_VERSION = 'cc-companion-static-v10-20260809-paper';
// 这两个是会天天改的代码,必须每次拿最新的;其余(图标/manifest)继续走缓存优先
const ALWAYS_FRESH = ['/app.js', '/styles.css', '/index.html'];
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/app-icon.svg',
  '/icons/maskable-icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 代码类资源:network-first —— 在线永远拿最新,离线才回落缓存
  if (ALWAYS_FRESH.includes(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // 其余静态资源:stale-while-revalidate(图标之类极少变,先给缓存更快)
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetched = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
