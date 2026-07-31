import { defineConfig, type Plugin } from "vite";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

// The game lives at pixel/games/nangijala/client; the art domains are siblings
// at the repo root (two levels up): characters/, tiles/, maps/, objects/.
const REPO_ROOT = resolve(__dirname, "../..");
const ASSET_DOMAINS = new Set([
  "characters", "tiles", "maps", "objects", "characters2", "tiles2", "maps2",
  "sounds", "music", "monsters", "items", "wiki", "live",
]);
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".json": "application/json",
  ".gif": "image/gif",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

// Serve the sibling art domains at /assets/<domain>/* in dev. Production does
// the same from the Colyseus server (see server/index.ts).
function serveAssets(): Plugin {
  return {
    name: "serve-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith("/assets/")) return next();
        const rel = normalize(decodeURIComponent(req.url.slice("/assets/".length)));
        const domain = rel.split(/[\\/]/)[0];
        if (rel.startsWith("..") || !ASSET_DOMAINS.has(domain)) return next();
        const file = join(REPO_ROOT, rel);
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", TYPES[extname(file)] || "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [serveAssets()],
  server: {
    host: true,
    port: 5173,
    // The wiki (served at /assets/wiki/site/) talks to the world server's
    // /api (live state, admin login/save) — same-origin in prod, proxied in dev.
    proxy: { "/api": "http://localhost:2567" },
  },
});
