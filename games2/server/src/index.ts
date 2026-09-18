import { createServer } from "http";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import express from "express";
import compression from "compression";
import { constants as zlibConstants } from "zlib";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ROOM_NAME } from "@nangijala/shared";
import { WorldRoom, sceneryBbox, zonesConfigFor, perfStats, DEFAULT_WORLD } from "./rooms/WorldRoom.js";
import { initLive, registerLiveRoutes, sceneryHitboxOverrides } from "./live.js";
import { cacheControlFor } from "./cachepolicy.js";
import { assetHash } from "./assethash.js";
import { BundleStore, backendFromEnv, DOC } from "./bundlestore";

// Encoder.BUFFER_SIZE is set in rooms/WorldRoom.ts (the room module), so a
// test's own Server gets the same 64 KB as this one.

const PORT = Number(process.env.PORT || 2567);
// server/src/index.ts → GAME_ROOT is pixel/games2; the art domains are
// one more level up at the repo root. ASSETS_ROOT can be overridden (Docker).
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SRC_DIR, "..", "..");
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(GAME_ROOT, "..");
const ASSET_DOMAINS = [
  "characters", "tiles", "maps", "scenery", "characters2", "maps2",
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
/* THE COLLISION DOCUMENTS, SERVED BY THE AUTHORITY THAT STAMPS WITH THEM.
 * Scenery footprints are turned into blocked cells from two files, and the
 * client's prediction has to reach the SAME cells the server does or the body
 * fights the correction every frame. Neither file was reachable the way the
 * client asked for it: `/assets/games2/config/scenery-bbox.json` 404s (games2
 * is not an ASSET_DOMAIN and never was), so the client stamped NOTHING and
 * routed straight through every tree, and `/assets/live/tuning/...` is the
 * IMAGE's baked copy while the server stamps from the LIVE one off GitHub —
 * so a hitbox tuned in the wiki moved the server's trees and not the client's.
 * Both are answered here from the objects the room itself holds, which is the
 * only arrangement in which they cannot drift. ~96 KB gzipped, both together.
 * `no-cache` (not no-store): the live half changes without a redeploy, so a
 * cached copy must be REVALIDATED, and express's ETag then makes the usual
 * answer a 304. */
app.get("/api/scenery-collision", (_req, res) =>
  res.setHeader("Cache-Control", "no-cache").json({
    bbox: sceneryBbox(),
    hitbox: sceneryHitboxOverrides(),
  }),
);
// THE ZONE GRID of a world (games2/config/zones.json), for the client to pick
// the room of the world's spawn and the path a zone is served on. `null` =
// one room for the whole map.
app.get("/api/zones/:world", (req, res) =>
  res.setHeader("Cache-Control", "no-cache").json(zonesConfigFor(String(req.params.world).replace(/[^a-z0-9_-]/gi, ""))),
);
// THE SERVER'S OWN LOAD NUMBERS (tick p50/p95/max per room, CPU of one core
// since the last call, event-loop lag) — what scripts/loadbot.mjs reads.
app.get("/api/stats", (_req, res) => res.setHeader("Cache-Control", "no-store").json(perfStats()));
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
//   a tile IN-PLACE (same path, new pixels — an art agent softening edges), so a
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
    cacheControlFor({
      filePath: path,
      bundleDir: BUNDLE_DIR,
      gitSha: GIT_SHA,
      queryV: res.req?.query?.v,
      queryH: res.req?.query?.h,
      fileHash: () => assetHash(path), // the bytes about to be served, never the index
    }),
  );
}

// THE ASSET INDEX — one `no-cache` document naming the current content hash
// of every file under ASSETS_ROOT (scripts/build-asset-index.mjs, run in the
// image build after the curated root is complete). The client stamps art with
// `?h=<hash>` from it (client/src/assetver.ts) so an unchanged file keeps its
// URL across deploys; express's ETag turns the per-boot revalidation into a
// 304 until a deploy changes some art. Absent (dev, an old image) → 404 and
// the client stamps `?v=<sha>` exactly as before.
const ASSET_INDEX = process.env.ASSET_INDEX || join(ASSETS_ROOT, "asset-index.json");
const assetIndexJson: string | null = existsSync(ASSET_INDEX) ? readFileSync(ASSET_INDEX, "utf8") : null;
app.get("/asset-index.json", (_req, res) => {
  if (assetIndexJson === null) return res.status(404).setHeader("Cache-Control", "no-store").end();
  res.setHeader("Cache-Control", "no-cache").type("application/json").send(assetIndexJson);
});

// THE PUBLISHED CLIENT BUNDLE, if one is configured (bundlestore.ts). It takes
// precedence over the image's own client/dist, and the image remains the floor:
// nothing published, nothing readable, or anything refused by the store's laws
// and this whole block is inert.
const bundleBackend = backendFromEnv();
const bundles = bundleBackend ? new BundleStore(bundleBackend) : null;
if (bundles) {
  console.log(`[nangijala] published client bundles from ${bundles.label}`);
  void bundles.refresh();
  // Pushed, not polled — the live-notify shape (a workflow step POSTs after a
  // publish). The interval is the belt: an instance that missed a poke, or came
  // up between two, converges without one.
  setInterval(() => void bundles.refresh(), 60_000).unref();
}

/** Serve one file of a published generation. The ETag is the hash of THESE
 *  bytes (bundlestore law 1): identical on every instance, so one validator can
 *  never name two documents and a 304 can never freeze the wrong body. */
function sendBundleFile(res: express.Response, file: { bytes: Buffer; hash: string; type: string }, immutable: boolean) {
  res.setHeader("ETag", `"${file.hash}"`);
  res.setHeader("Content-Type", file.type);
  // A content-hashed asset can be cached forever BY CONSTRUCTION — the name is
  // the hash of the bytes. The document is revalidated on every load, which is
  // what makes a flip visible on a plain refresh.
  res.setHeader("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
  if (res.req?.headers["if-none-match"] === `"${file.hash}"`) {
    res.status(304).end();
    return;
  }
  res.status(200).send(file.bytes);
}

if (serveClient) {
  for (const domain of ASSET_DOMAINS) {
    app.use(
      `/assets/${domain}`,
      express.static(join(ASSETS_ROOT, domain), { maxAge: "1h", setHeaders: setCacheHeaders }),
    );
  }

  if (bundles) {
    // WHICH GENERATION IS SERVING, for the gate and for a human on a phone.
    app.get("/api/bundle", (_req, res) =>
      res.setHeader("Cache-Control", "no-store").json({
        store: bundles.label,
        pointer: bundles.pointer,
        generations: bundles.held,
        serving: bundles.current?.id ?? null,
        recent: bundles.log.slice(-8),
      }),
    );
    // THE POKE, exactly like /api/live/refresh: unauthenticated because it only
    // asks the server to re-read a store it already reads, it is idempotent, and
    // a spurious call is a no-op. The publisher calls it after the pointer flip.
    app.post("/api/bundle/refresh", async (_req, res) => {
      await bundles.refresh();
      res.setHeader("Cache-Control", "no-store").json({ serving: bundles.current?.id ?? null, pointer: bundles.pointer });
    });

    // A PUBLISHED ASSET IS SERVED BY NAME FROM ANY GENERATION THIS PROCESS HAS
    // EVER HELD (law 4), which is what keeps a page from a previous generation
    // working across a flip. Falls through to the image's static handler when
    // the store has never seen the name.
    app.get(/^\/assets\/[^/]+$/, (req, res, next) => {
      const name = req.path.slice(1); // "assets/<file>"
      const file = bundles.fileFor(name);
      if (!file) return next();
      sendBundleFile(res, file, true);
    });
  }

  if (existsSync(clientDist) || bundles) {
    // `index: false` IS LOAD-BEARING when a published bundle exists. Measured by
    // verify-fastlane arm D: express.static answers "/" with its OWN
    // index.html, and it is registered before the fallback, so the published
    // document never won and every publish looked like a no-op while
    // /api/bundle cheerfully reported the new generation. With the lane off the
    // fallback below serves the same file, so behaviour is unchanged.
    if (existsSync(clientDist)) {
      app.use(express.static(clientDist, { index: false, setHeaders: setCacheHeaders }));
    }
    // A MISSING /assets PATH ANSWERS 404 WITH `no-store`. It used to answer with
    // no Cache-Control at all, which leaves it to HEURISTIC FRESHNESS — and a
    // phone may then REMEMBER a 404. A remembered 404 on a module script is a
    // black page that survives a reload, which is the same wound as deleting a
    // hashed name (root CLAUDE.md), arriving by a different road. Still a hard
    // 404 and never HTML, so the .dockerignore diagnostic (present on GitHub,
    // 404 in prod) reads exactly as before.
    app.use("/assets", (_req, res) =>
      res.status(404).setHeader("Cache-Control", "no-store").type("text/plain").send("not found\n"),
    );
    // SPA fallback for any non-API, non-asset route — the published document
    // when there is one, the image's otherwise.
    app.get(/^(?!\/(assets|health|matchmake|api)).*/, (_req, res) => {
      const doc = bundles?.current?.files.get(DOC);
      if (doc) return sendBundleFile(res, doc, false);
      if (!existsSync(clientDist)) return res.status(503).type("text/plain").send("no client bundle\n");
      res.sendFile(join(clientDist, "index.html"), { headers: { "Cache-Control": "no-cache" } });
    });
    console.log(
      `[nangijala] serving built client from ${bundles?.current ? `${bundles.label} (${bundles.current.id})` : clientDist}` +
        `, assets from ${ASSETS_ROOT}`,
    );
  }
}

const gameServer = new Server({
  greet: false, // suppress the big Colyseus ASCII banner on start
  transport: new WebSocketTransport({ server: createServer(app) }),
});

// One WorldRoom per (world, zone): filterBy so joinOrCreate matches players
// who picked the SAME world and zone into one room and spins up a separate
// room for each other pair (spec/ZONES.md; no zone = the whole-world room).
gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);

/** WARM ROOMS: every zone room of the published world exists before the
 *  first player arrives — no join waits for a terrain load, and the
 *  joinOrCreate race that made two rooms of one zone has no window. */
async function warmZoneRooms() {
  const cfg = zonesConfigFor(DEFAULT_WORLD);
  if (!cfg) return;
  const t0 = Date.now();
  for (let z = 0; z < cfg.cols * cfg.rows; z++) {
    try {
      await matchMaker.createRoom(ROOM_NAME, { world: DEFAULT_WORLD, zone: z });
    } catch (e) {
      console.error(`[zones] warm-up of zone ${z} failed:`, e);
    }
  }
  console.log(`[zones] ${cfg.cols * cfg.rows} zone rooms of ${DEFAULT_WORLD} warm in ${Date.now() - t0} ms`);
}

// THE FIRST STORE READ HAPPENS BEFORE WE ACCEPT TRAFFIC. Measured by
// verify-fastlane arm B: /health went up while the pointer was still in flight,
// so the first requests were answered from the image and /api/bundle reported
// `serving: null` — a cold instance briefly serving the previous client on
// every start. BOUNDED, because availability outranks freshness: if the store
// is slow or unreachable we start anyway on the image bundle and converge on
// the next poke or the 60 s belt.
const firstRead = bundles
  ? Promise.race([bundles.refresh(), new Promise<void>((r) => setTimeout(r, 5000).unref())]).catch(() => {})
  : Promise.resolve();

firstRead
  .then(() => gameServer.listen(PORT))
  .then(() => {
    console.log(`[nangijala] world server listening on ws://localhost:${PORT}`);
    void warmZoneRooms();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
