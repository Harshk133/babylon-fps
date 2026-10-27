// Service worker: keeps the game's files on the device, so a second visit
// (especially on a phone, on mobile data) loads from storage, not the network.
//
// - /assets/* (Vite's hashed scripts and styles): cache first, they never change.
// - models, trees, textures, sounds, loading art: served from the cache at
//   once and refreshed in the background (stale-while-revalidate), so an
//   updated model shows up on the visit after it's deployed.
// - the page itself: network first (new builds point at new hashed files),
//   the cached copy when offline.
// - anything else (the relay's WebSocket, other sites): untouched.
//
// After its first load the game posts the URLs it downloaded ({ type:
// "warm", urls }), and they're stored right away (from the HTTP cache).
// Bump VERSION to drop everything cached.

const VERSION = "v1";
const CACHE = `babylon-fps-${VERSION}`;
const ASSET_DIRS = /^\/(models|trees|texture|sounds|loading)\//;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("babylon-fps-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

const storable = res => res && res.ok && res.type === "basic" && res.status === 200;

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (storable(res)) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const refresh = fetch(req).then(res => {
    if (storable(res)) return cache.put(req, res.clone()).then(() => res);
    return res;
  });
  if (hit) {
    event.waitUntil(refresh.catch(() => {}));
    return hit;
  }
  return refresh;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (storable(res)) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/ws")) return;
  if (req.mode === "navigate") event.respondWith(networkFirst(req));
  else if (url.pathname.startsWith("/assets/")) event.respondWith(cacheFirst(req));
  else if (ASSET_DIRS.test(url.pathname)) event.respondWith(staleWhileRevalidate(req, event));
});

// The first visit's files: store them now, so the next visit doesn't touch the network
self.addEventListener("message", event => {
  const msg = event.data;
  if (!msg || msg.type !== "warm" || !Array.isArray(msg.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const u of msg.urls) {
      try {
        const url = new URL(u, self.location.origin);
        if (url.origin !== self.location.origin) continue;
        if (!url.pathname.startsWith("/assets/") && !ASSET_DIRS.test(url.pathname)) continue;
        if (await cache.match(url.href)) continue;
        const res = await fetch(url.href);
        if (storable(res)) await cache.put(url.href, res);
      } catch { /* skipped; it'll be cached when next requested */ }
    }
  })());
});
