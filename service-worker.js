/* Service worker: оболочка приложения кэшируется, аудио, API Яндекса и шлюз авторизации — всегда из сети. */
const CACHE = "yd-audio-player-v5";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Аудио, прямые ссылки, API Яндекса и облачный шлюз не кэшируем (нужны актуальные токены и данные)
  const isMedia = req.destination === "audio" || req.destination === "video" ||
    /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)(\?|$)/i.test(url.pathname);
  const isApi = /cloud-api\.yandex\.net|downloader\.disk\.yandex\.ru|storage\.yandex\.|disk\.yandex\.|yadi\.sk|oauth\.yandex\.ru|login\.yandex\.ru|functions\.yandexcloud\.net/.test(url.hostname + url.pathname) ||
    url.searchParams.has("action");
  const isProxy = /corsproxy\.io|allorigins|codetabs\.com/.test(url.hostname);
  if (isMedia || isApi || isProxy) return;

  // Навигация: сеть, при офлайне — кэш (игнорируем ?code=... в ключе кэша)
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  // Остальное: cache-first с обновлением
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && url.origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
