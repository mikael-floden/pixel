// The game server's /assets mount, for gates — with no dependencies.
//
// The real thing is games2/server (express + tsx). Its node_modules do not
// survive container recycling, and reinstalling a server stack to look at a
// page is a poor trade — this file was rewritten from scratch three times in
// one session before it earned a place in the repo.
//
// Serves the repo under /assets/ with `access-control-allow-origin: *`, and
// answers /api/live/state from live/** so the wiki loads its feedback and
// tuning without the game server. Everything else under /api/ answers "{}",
// which is what the gates' own route mocks expect to override.
//
//   node wiki/tools/serve-assets.mjs [port]     (default 8902)
//
// Pair it with serve-repo.mjs on 8903 for the second ORIGIN the staging paths
// resolve against — see check-groundtype.mjs, which needs both.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8902);
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif",
  ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".woff2": "font/woff2", ".ttf": "font/ttf",
};
// Kept in step with games2/server/src/live.ts by name only — a doc the gates
// read, never a second source of truth.
const FEEDBACK = ["monsters", "characters", "tiles", "objects", "sounds", "music",
  "items", "lore", "composer", "composer-music", "bindings"];
const TUNING = ["monsters", "constants", "sfx_requests", "shadow_notes", "tile_walls",
  "scenery_lights", "base_tiles"];
const readJson = async (p) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("access-control-allow-origin", "*");
  if (url.pathname === "/api/live/state") {
    const out = { tuning: {}, feedback: {} };
    for (const t of TUNING) out.tuning[t] = await readJson(join(ROOT, `live/tuning/${t}.json`));
    for (const f of FEEDBACK) out.feedback[f] = await readJson(join(ROOT, `live/feedback/${f}.json`));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  const file = join(ROOT, decodeURIComponent(url.pathname.replace(/^\/assets\//, "")));
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(PORT, () => console.log(`[serve-assets] repo on http://127.0.0.1:${PORT}/assets/`));
