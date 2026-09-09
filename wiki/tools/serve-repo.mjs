// THE SECOND ORIGIN the two-origin gates need — a stand-in for the repo CDN.
//
// Production has TWO places art can come from: the deployed image (same origin,
// only what shipped) and the repo (cross-origin, everything). Half the wiki's
// art logic exists to move between them, and against a dev server that happens
// to hold every domain on disk that logic is INVISIBLE — every URL works, so
// every gate passes and production still breaks. So the gates point
// `ml-staging-base` at this: a genuinely different origin, with the CORS header
// a CDN sends, serving the same tree.
//
//   node wiki/tools/serve-repo.mjs                 # :8903, repo root
//   PORT=9001 ROOT=/somewhere node …/serve-repo.mjs
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
const ROOT = process.env.ROOT ?? new URL("../../", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8903);
const TYPES = { ".json": "application/json", ".webp": "image/webp", ".png": "image/png",
  ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".mjs": "text/javascript",
  ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".svg": "image/svg+xml" };
createServer((req, res) => {
  // `/assets/x` and `/x` both resolve, so a base of either shape works.
  const rel = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname))
    .replace(/^\/+/, "").replace(/^assets\//, "");
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("no"); return; }
  let st; try { st = statSync(file); } catch { res.writeHead(404, { "access-control-allow-origin": "*" }).end("nope"); return; }
  if (st.isDirectory()) { res.writeHead(404, { "access-control-allow-origin": "*" }).end("dir"); return; }
  res.writeHead(200, {
    "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": st.size,
    // What makes this a useful fake: the CDN's header, so the browser takes the
    // same cross-origin path (and taints the same canvases) as production.
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=60",
  });
  createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`[repo] ${ROOT} on http://127.0.0.1:${PORT} (CORS *)`));
