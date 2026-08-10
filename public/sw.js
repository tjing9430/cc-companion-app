// 缓存版本号**不再靠人手改**。服务端在发 sw.js 时按被缓存文件的内容算一个哈希,
// 塞成 self.__CC_CACHE_VERSION__ 前置一行 —— 文件内容一变,版本号自动变,旧 cache
// 在 activate 时被清掉。
// 2026-08-09 踩过:忘了 bump + fetch 是 stale-while-revalidate → 用户永远慢一个刷新,
// 把已经修好的东西当成「你忘记做了」。2026-08-10 又踩过一次变体:手动 sed 改版本号,
// 日期写错导致**静默不匹配、退出码还是 0**,差点当它改成功了。
// 所以这里的原则是:能自动算出来的东西,不留给人记得。
// (回落值只在「不经本项目服务端、直接静态托管 public/」时用到,那种部署本来就得自己管缓存。)
const CACHE_VERSION = self.__CC_CACHE_VERSION__ || 'cc-companion-static-dev';
// 会天天改的代码必须每次拿最新的;其余(图标/manifest)继续走缓存优先
const ALWAYS_FRESH = ['/app.js', '/js/util.js', '/js/markdown.js', '/js/state.js', '/js/console-view.js', '/js/settings-view.js', '/styles.css', '/index.html'];
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
