// sw.js — Polyglot Service Worker
// Strategy:
//   App shell (HTML, CSS, JS, fonts, fuse.js) → Cache-first (fast loads)
//   words.json  → Network-first with cache fallback (keeps data fresh)
//
// Bump CACHE_VERSION whenever you want to force a full cache refresh.
const CACHE_VERSION = "v1";
const SHELL_CACHE   = `polyglot-shell-${CACHE_VERSION}`;
const DATA_CACHE    = `polyglot-data-${CACHE_VERSION}`;

// Files that make up the app shell (always served from cache after first load).
const SHELL_URLS = [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/favicon.ico",
  "/favicon-16.png",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/manifest.json",
  // Fuse.js (CDN) — cached so search works offline too
  "https://cdn.jsdelivr.net/npm/fuse.js@6.6.2",
  // Google Fonts stylesheets
  "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
];

// ── Install: pre-cache the app shell ───────────────────────────────────────
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache =>
      // Use individual requests with {mode:"no-cors"} for opaque cross-origin
      // resources (CDN/fonts) so a fetch error doesn't abort the whole install.
      Promise.allSettled(
        SHELL_URLS.map(url => {
          const isCrossOrigin = url.startsWith("http") && !url.startsWith(self.location.origin);
          return cache.add(new Request(url, isCrossOrigin ? { mode: "no-cors" } : {}))
            .catch(() => { /* ignore individual failures */ });
        })
      )
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ────────────────────────────────────────────
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== SHELL_CACHE && k !== DATA_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ──────────────────────────────────────────────────────────────────
self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);

  // words.json → network-first, cache fallback
  if (url.pathname.startsWith("/words.json")) {
    event.respondWith(networkFirstData(request));
    return;
  }

  // Everything else → cache-first, network fallback
  event.respondWith(cacheFirstShell(request));
});

// Network-first: try network, update data cache, fall back to cache.
async function networkFirstData(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(DATA_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response("[]", { headers: { "Content-Type": "application/json" } });
  }
}

// Cache-first: serve from cache, fall back to network and cache the result.
async function cacheFirstShell(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok || networkResponse.type === "opaque") {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    // Return a minimal offline page for navigate requests
    if (request.mode === "navigate") {
      const indexCache = await caches.match("/index.html");
      if (indexCache) return indexCache;
    }
    return new Response("Offline", { status: 503 });
  }
}
