import { createServer } from "http";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import express from "express";
import compression from "compression";
import { constants as zlibConstants } from "zlib";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Encoder } from "@colyseus/schema";
import { ROOM_NAME } from "@nangijala/shared";
import { WorldRoom } from "./rooms/WorldRoom.js";
import { initLive, registerLiveRoutes } from "./live.js";
import { cacheControlFor } from "./cachepolicy.js";

// The combat schema (11 new Player fields, 4 new Monster fields, drops) put
// the_island2's FULL-STATE join snapshot past the encoder's 8KB default —
// the overflow stalls the first patch and a joiner sits on mount-default HUD
// bars. 64KB clears every world with an order of magnitude of headroom.
Encoder.BUFFER_SIZE = 64 * 1024;

const PORT = Number(process.env.PORT || 2567);
// server/src/index.ts → GAME_ROOT is pixel/games2; the art domains are
// one more level up at the repo root. ASSETS_ROOT can be overridden (Docker).
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SRC_DIR, "..", "..");
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(GAME_ROOT, "..");
const ASSET_DOMAINS = [
  "characters", "tiles", "maps", "scenery", "characters2", "tiles2", "maps2",
  "sounds", "music", "monsters", "items", "lore", "wiki", "live",
];

const app = express();
// RESPONSE COMPRESSION (perf 2026-07-31). Nothing was compressed before this:
// a request with `Accept-Encoding: gzip, br` came back with no content-encoding
// at all, so every player downloaded the raw bytes. Cloud Run does NOT compress
// for you — the container has to. Measured on the real files:
//   index-*.js     1,972,119 →   507,126  (3.89x)
//   world.json       736,812 →    34,288  (21.5x)   the_island2
//   monsters.json    382,856 →    18,510  (20.7x)
//   characters.json   20,834 →     1,956  (10.7x)
// ≈2.4 MB off a cold load, and it is INVISIBLE: identical bytes reach the
// client, so not a pixel changes and nothing loads later than it used to.
//
// THE QUALITY KNOBS ARE PINNED, and the brotli one is the important pin.
// Measured cost of compressing this bundle (isolated, sync zlib):
//   gzip-1  28ms/3.40x   gzip-6  47ms/3.89x   gzip-9    75ms/3.91x
//   brotli-q4 51ms/3.86x brotli-q5 81ms/4.26x brotli-q11 5,252ms/4.82x
// End to end over localhost (so time ≈ pure CPU): identity 8ms, gzip 65ms,
// brotli-q4 67ms. q4/level-6 are the knee — ~60ms to drop 1.47MB, which pays
// for itself on anything slower than a LAN. **NEVER let brotli quality rise**:
// q11 stalls a single request for FIVE SECONDS on this one core. compression
// 1.8.1 happens to default it to 4 (node_modules/compression/index.js:65), but
// that is their default, not a promise — pinning it here means a routine
// dependency bump cannot silently turn every bundle fetch into a 5s stall.
// If the bundle ever needs to be smaller than q4 gets it, PRE-compress at build
// time and serve the .br file; do not raise the dynamic quality.
//
// This does NOT threaten the 20Hz sim, which shares this single Cloud Run core:
// node's zlib STREAM api (what compression() uses) runs on the libuv
// threadpool, not the event loop, so a response being compressed never blocks a
// tick — it only competes for CPU, and ~60ms against the ~6s asset storm a join
// already costs is noise. There is no server-side cache of compressed output,
// so each JOIN pays it once per compressible file; that is the accepted trade
// for not adding a cache layer, and pre-compression is the escape hatch if the
// core ever gets tight.
//
// PNGs ARE NOT COMPRESSED, which matters more than it sounds: a boot loads 554
// tile PNGs + 384 monster strips, and PNG is already DEFLATE. The default
// filter consults the `compressible` module against Content-Type, so image/*
// is skipped — re-gzipping that lot would have burned CPU for ~zero bytes.
// Registered FIRST so it wraps every route below, including express.static.
// Adds `Vary: Accept-Encoding`, which composes correctly with the ?v immutable
// grant below (browsers key the cache entry per encoding).
app.use(
  compression({
    level: 6, // gzip/deflate
    brotli: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }, // see the pin note above
    threshold: 1024, // below this the framing costs more than it saves
  }),
);
app.get("/health", (_req, res) => res.json({ ok: true }));
// Live-update channel + wiki admin API (see live.ts / live/README.md).
app.use("/api", express.json({ limit: "1mb" }));
registerLiveRoutes(app);
void initLive(ASSETS_ROOT);
// Deployed build id — clients poll this to detect a newer deploy and prompt a
// refresh (see client/src/main.ts).
app.get("/version", (_req, res) =>
  res.setHeader("Cache-Control", "no-store").json({ sha: process.env.GIT_SHA || "dev" }),
);

// Production single-origin serving: built client + art assets on one host/port
// as the WebSocket world server (see client/src/net.ts).
const clientDist = join(GAME_ROOT, "client", "dist");
const serveClient = process.env.SERVE_CLIENT === "1" || existsSync(clientDist);

// Cache policy so a PLAIN refresh (F5) always picks up a new deploy:
// - anything unhashed that changes across deploys (html, json manifests like
//   characters.json / world.json) → no-cache: the browser revalidates on every
//   load and gets fresh content the moment a deploy changes it (cheap 304s
//   otherwise);
// - Vite's content-hashed bundles → immutable, cache for a year. That is
//   EVERY file rollup emits into client/dist/assets, not just js/css: the 503
//   .ogg foley takes, the music .m4a/.mp3 beds and the bundled .webp are all
//   named `<name>-<contenthash>.<ext>` by the same mechanism. Until 2026-08-15
//   the rule only matched js|css, so 532 of the 535 hashed files revalidated
//   on every repeat visit — 532 pointless round trips per returning player.
//   The grant is scoped BY DIRECTORY, not by filename shape; see cachepolicy.ts
//   for why that distinction is what keeps in-place art edits safe;
// - art (tiles/characters PNGs) → no-cache BY DEFAULT. The path LOOKS
//   content-hashed (…/base_x_2_161302781/…), but the art agents routinely edit
//   a tile IN-PLACE (same path, new pixels — e.g. tiles2 softening edges), so a
//   long cache once served the OLD art for up to an hour after a deploy.
// - EXCEPT: art requested with ?v=<GIT_SHA> → immutable. The client stamps its
//   own build sha (VITE_GIT_SHA, baked with the art into the SAME image) onto
//   every /assets URL (client/src/assetver.ts), and we grant immutable ONLY
//   when it matches THIS instance's GIT_SHA — for that sha the bytes can never
//   change (in-place art edits only reach prod via a new deploy = new sha =
//   new URLs), so the cache entry is stale-proof by construction. During a
//   rollout a mixed pair (old instance, new sha or vice versa) mismatches and
//   degrades to no-cache — a revalidated fetch, never a wrongly-frozen one.
//   Repeat visits then load the world with ~zero art requests instead of ~600
//   revalidation round-trips (the maintainer's "loading for so long").
const GIT_SHA = (process.env.GIT_SHA || "").trim();
// Vite's output directory. Nothing but rollup emits can land here — client/
// public has no `assets/` folder — which is what lets the grant be safe.
const BUNDLE_DIR = join(clientDist, "assets");
function setCacheHeaders(res: express.Response, path: string) {
  res.setHeader(
    "Cache-Control",
    cacheControlFor({ filePath: path, bundleDir: BUNDLE_DIR, gitSha: GIT_SHA, queryV: res.req?.query?.v }),
  );
}

if (serveClient) {
  // The composer's own foley takes and music beds, for the wiki's sound and
  // music pages. Only those two folders are exposed — the engine sources stay
  // private. In the image the Dockerfile copies them under /assets/composer/;
  // a repo checkout serves them straight from games2/composer (second mount =
  // dev fallback).
  for (const sub of ["foley", "music"]) {
    app.use(
      `/assets/composer/${sub}`,
      express.static(join(ASSETS_ROOT, "composer", sub), { maxAge: "1h", setHeaders: setCacheHeaders }),
      express.static(join(GAME_ROOT, "composer", sub), { maxAge: "1h", setHeaders: setCacheHeaders }),
    );
  }
  for (const domain of ASSET_DOMAINS) {
    app.use(
      `/assets/${domain}`,
      express.static(join(ASSETS_ROOT, domain), { maxAge: "1h", setHeaders: setCacheHeaders }),
    );
  }
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist, { setHeaders: setCacheHeaders }));
    // SPA fallback for any non-API, non-asset route.
    app.get(/^(?!\/(assets|health|matchmake|api)).*/, (_req, res) =>
      res.sendFile(join(clientDist, "index.html"), { headers: { "Cache-Control": "no-cache" } }),
    );
    console.log(`[nangijala] serving built client from ${clientDist}, assets from ${ASSETS_ROOT}`);
  }
}

const gameServer = new Server({
  greet: false, // suppress the big Colyseus ASCII banner on start
  transport: new WebSocketTransport({ server: createServer(app) }),
});

// One WorldRoom per maps2 world: filterBy 'world' so joinOrCreate matches
// players who picked the SAME world into one shared room, and spins up a
// separate room (with that world's own grid) for each different selection.
gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world"]);

gameServer
  .listen(PORT)
  .then(() => console.log(`[nangijala] world server listening on ws://localhost:${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
