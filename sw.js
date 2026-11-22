// Offline play, and what makes browsers offer to install Tiltbox as an app.
// Network first, so a new version shows up as soon as the phone is online; the cache answers
// when it is not. Everything the app fetches from its own origin is cached as it goes, and
// main.js loads every mode once in the background, so all of them work offline after one visit.

const CACHE = 'tiltbox-v1';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'favicon.ico',
  'icons/favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'src/main.js', 'src/motion.js', 'src/view.js', 'src/gl.js', 'src/audio.js', 'src/modes/index.js',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      // Revalidate rather than trust the HTTP cache, so files from two versions never mix.
      // (A navigation request cannot be re-made with options; browsers revalidate those anyway.)
      const res = await (req.mode === 'navigate' ? fetch(req) : fetch(req, { cache: 'no-cache' }));
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
