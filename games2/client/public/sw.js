// Minimal service worker: exists so the game is installable as an app
// (Add to Home Screen). It deliberately caches NOTHING — this project fought
// stale-deploy bugs before, and every asset already has the right
// Cache-Control from the server — so it just passes requests to the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  e.respondWith(fetch(e.request));
});
