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
// ★ 8/14 补进 isles/river/more-view:版本哈希会walk整个 js/ 目录,所以只改它们仨**换桶**
//   没问题(server 重启后);但不在这张单里 = 同一版本内的改动只能等下一次换桶才见效,
//   和其它 js 不同步 —— 「改了 A 生效、改了 B 像没改」这种半新半旧最难查。拉齐。
const ALWAYS_FRESH = ['/app.js', '/js/util.js', '/js/markdown.js', '/js/state.js', '/js/console-view.js', '/js/settings-view.js', '/js/memory-view.js', '/js/chat-view.js', '/js/starry.js', '/js/home-view.js', '/js/isles.js', '/js/river.js', '/js/more-view.js', '/js/stream-format.js', '/styles.css', '/index.html'];
// ★ 首屏那几张图必须 install 时就预下,不能等页面自己去要。
//   实测(慢网 400kbps + 禁缓存,连打 8 次):**2 次画面里入口图标是缺的** ——
//   一次只剩 1 颗、一次一颗都没渲出来。而且**每次缺的不是同一颗**,
//   说明不是某个文件坏了,是"还没下完就画了"的竞态。
//   用户看到的就是:银河在、文字在、圆图标一片空白。
//   ⇒ 放进 install 的预下清单之后,它们在页面第一次要之前就已经躺在缓存里。
const STATIC_ASSETS = [
  // Theme artwork is deliberately on-demand. Pre-caching all four themes on
  // first install made unrelated island/starry images compete with the active
  // home screen. The normal stale-while-revalidate path caches each asset
  // after the first time its theme is actually used.
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/app-icon.svg',
  '/icons/maskable-icon.svg',
  // 首屏视觉:背景 + 六个入口徽章
  // 浮岛主题的七张岛(六座入口 + 更多页的水晶球岛)。
  // ★ 8/14 之前它们不在预下清单里 —— badges 预下了、island 没预下,
  //   于是每发一版换缓存桶,浮岛用户的首屏都要裸等网络重拉:
  //   「一部署图片全没了」有一半是这里来的。
  // 星空聊天背景(8/14 她选定的星夜图,45KB)
];

// ★ 8/14 还了 addAll 那笔债(群账 #67):addAll 是**全有全无** —— 弱网下 20 个文件
//   挂 1 个,install 整个作废,用户静默卡在旧版,比"某张图第一次走网络"贵得多。
//   改成逐个 add + allSettled:挂掉的只是不进预缓存(之后按需走网络照样能用),
//   install 永远成功。这正是 8/14 凌晨「岛图暂不进清单」裁决里写的解锁条件 ——
//   失败面问题消解后,island 七张随本次一起进了 STATIC_ASSETS(纯收益)。
// ★ 挂掉几张在控制台报一声数目:预缓存缺张不是错,但一声不吭会让
//   「怎么还闪占位圆」查不到头 —— 沉默和死亡长得一样。
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => Promise.allSettled(STATIC_ASSETS.map((u) => cache.add(u))))
      .then((results) => {
        const missed = results.filter((r) => r.status === 'rejected').length;
        if (missed) console.warn(`[sw] 预缓存缺了 ${missed}/${results.length} 个,已放行(按需再取)`);
      })
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
