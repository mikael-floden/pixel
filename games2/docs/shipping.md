# Shipping, assets and loading

What reaches the image and the browser: publish policy, the curated root, the world tree, staging, asset formats, cache policy, the loading order, deploy. Moved verbatim out of `games2/CLAUDE.md` (2026-09-09), which keeps the law and points here; the measurements, traps and rejected approaches live in this file. Rewrite in place under the root doc law.

## THE CONTENT SPLIT — what ships vs what is staging

The art domains generate far more than the game uses (scenery ships 2,644
files; the game reads THREE). The image contains only what the published
worlds can reach (maintainer: "the real game will only ever include what's
inside the actual real game").

- **`games2/config/publish.json`** — the ONLY hand-maintained part: published
  worlds, playable characters, the three game-referenced scenery pieces.
  Everything else is DERIVED. `userWorlds` = `the_game`, THE ONLY WORLD
  (maintainer 2026-09-09: "We will commit 100% to the new tiles3 system and
  the new map from here on ... We will never go back to the tile2 system
  again"). A name is resolved by probing `maps2/worlds3`, as the server and
  build-worlds do — so the policy names a world and nothing else.
  **MEASURE, CALIBRATE, PROFILE AND OPTIMISE AGAINST `the_game`**, and never
  let a fixture's numbers stand in for the shipped map (paid for once:
  `bench-findpath.ts` set the hold-to-move repath budget from 6k-25k-cell demo
  worlds at 0.46-10.54 ms p50, while the_game costs 38.24 ms p50 — a budget
  tuned against a map nobody plays).
  RETIRED 2026-09-09: `tiles2/` (Tiles 2.0), `maps2/worlds/` (world@1/@2 —
  the_island2, the demos, the test beds), the tile atlas, the maps2 render
  branch of `WorldScene` (`this.maps2`, `rebuildProps`, `buildEmissiveSources`,
  `tileatlas.ts`) and the tiles2 emission registry — history in git.
- **`games2/scripts/shipset.mjs`** closes over those roots: a published world
  drags in its NPCs' character art, its spawn zones' monsters and its placed
  SCENERY pieces' whole directories (the manifest names sprite, rotations,
  variations and animations and the maps2 agent places a piece as a whole:
  the_game, 187 pieces / 23.7 MB for 1,263 placements). `--report` prints the
  savings table, `--check` fails on a reachable-but-missing file, `--emit
  <dir>` materialises the curated root. The Dockerfile's **`curate` stage**
  runs `--emit`; the final image copies from it, one layer per domain.
- **A worlds3 world's TERRAIN ART is the tiles3 resolver's exact closure**,
  not the `tiles/` domain: `scripts/ship-tiles3.ts` (Dockerfile BUILD stage,
  where TypeScript exists; the curate stage has none) runs the real resolver
  over every cell, corner and deck of each published worlds3 world through the
  same `cellArtPaths`/`boundaryArtPaths`/`deckArtPaths` the scene hands its
  loader, copies exactly those files plus the `TILES3_DOCS` index documents
  from `/full` into `/assets/tiles`, and `--check` fails the build on a
  named-but-missing file — shipset's rule, applied here. The runtime stage
  copies `/assets/tiles` from the build stage. Measured on the_game: 508 files
  / 0.35 MB of a 400 MB domain, resolved in ~1.5 s. (A JSON-level
  approximation would drift from the renderer; per-ground subtrees would ship
  ~90 MB.) Module `scripts/tiles3closure.ts`; gate
  `server/test/shiptiles3.test.ts` (complete, deterministic, and STILL a
  closure — it fails if the resolver ever names whole trees).
- Filtering the asset root filters everything downstream for free — the image
  rebuilds every manifest and the wiki registry from `ASSETS_ROOT`, so
  `worlds.json`/`monsters.json`/wiki `data.json` list only shipped content and
  a player is never TOLD staging exists. That is why it is a build stage, not
  a `.dockerignore` edit.
- **TRAP (found by simulating the curated root):** a domain is not just its
  entities — `monsters/config/roster.json` fell outside the closure and the
  first curated build emitted `[monsters] 0 monsters`, a game that built,
  deployed and looked fine. Hence `entityDomains`: every contributing domain
  ships its root-level files and its `config/` tree wholesale. A missing
  descriptor does not 404 a sprite — it **silently empties a manifest**. When
  in doubt the script INCLUDES and warns.
- Staging stays reachable for us, never players: **dev** (`npm run dev` reads
  the working tree — every world playable, every gate unaffected) and **admin
  in prod** via the public repo. Measured: `raw.githubusercontent.com` sends
  CORS `*` but only `max-age=300` EVEN commit-pinned (NOT immutable);
  `cdn.jsdelivr.net/gh/<owner>/<repo>@<sha>/<path>` is byte-identical with
  `max-age=31536000, immutable` + CORS. Sha-pinned jsDelivr first, raw as
  fallback for commits the CDN hasn't picked up.

**THE TILE ATLAS IS RETIRED** (2026-09-09, with tiles2): a maps3 world ships
no per-cell tile art to pack, the ground streams per camera window
(`Tiles3Loader`). `client/public/atlases/` holds nothing tracked; the BODY
atlas (`bodyatlas.ts`, `scripts/build-bodyatlas.py`) is a separate, still
unshipped loading strategy and falls back to per-file loads.

**STAGING WORLDS.** The image ships `userWorlds` ONLY (see the content split
above); every `devWorlds3` map (none today) is streamed from the repo when an
admin joins — a dev map costs production ZERO bytes (the leak this stops: a
57-monster demo world once dragged 16 MB of monster art in; measured 89.5 →
105.4 MB).

- CLIENT: `client/src/staging.ts`, one chokepoint `gameUrl()` — identity
  function when inactive (a normal player's path is byte-identical). Activated
  (main.ts, chosen world not in the build) it rewrites `/assets/**` and the
  manifests to the sha-pinned jsDelivr base;
  `mergeStagingEntries` folds the repo's full monster/NPC manifests over the
  image's, rewriting only ADDED entries' URLs.
- SERVER: `WorldRoom.readWorldDoc` — **disk first, always**; only a name the
  image lacks hits the network. Required: the server is authoritative
  (collision + spawn zones), so browser CORS alone can never make an unshipped
  map joinable.

**THE WORLD TREE.** `maps2/worlds3` holds `pixel-maps3/world@1` (a ground NAME
per cell, no art — tiles3 resolves what draws at draw time). It is the ONLY
tree since 2026-09-09 (`maps2/worlds`, world@1/@2 with baked tile paths, is
retired), and exactly three places name it, each as a LIST so a second tree
can be probed again without touching the callers: `WorldRoom.WORLD_ROOTS`,
`build-worlds.mjs WORLD_ROOTS`, `shipset.mjs WORLD_TREES`.

- `scripts/build-worlds.mjs` scans it and records `root` on every entry. In
  the image this runs against the CURATED root, so production's worlds.json
  lists `userWorlds` only.
- `client/src/maps.ts` — `worldRoot`/`setWorldRoot`/`worldFileUrl` are the ONE
  place the client builds a world-file URL (world.json, spawns, npcs, places).
  A name nobody registered answers with `maps2/worlds3`; only that tree can be
  registered (a root arrives over the network). `enterStaging(world, root)`
  takes it as a parameter rather than importing it — maps.ts already imports
  `gameUrl` from staging.ts.
- `WorldRoom.worldRootFor` resolves a name's tree ONCE per process: DISK
  before any network, so a shipped world never touches GitHub; the staging
  fetch that resolves the root is the same one `stagingCache` serves to the
  read behind it. Every file of a world reads from ITS tree.
- `config/publish.json` `devWorlds3` names maps3 STAGING worlds (none today:
  `the_game` is published). A published worlds3 world ships its docs, NPC,
  monster and scenery closure through shipset and its terrain art through
  ship-tiles3 (content split above); `--check-policy` verifies a published
  name against whichever trees are checked out, and an absent tree is "not
  checked out", not a typo.
- **The tiles3 ART needs no new plumbing**: the resolver names repo-relative
  files (`tiles/plates`, `tiles/patterns`, `tiles/tops`, `tiles/fades`,
  `tiles/base_candidates`, `tiles/review`, the index JSONs) served at
  `/assets/tiles/…`, which `gameUrl`'s existing `/assets/` rule maps onto the
  CDN for a STAGING world — as it does `/assets/live/tuning/base_tile_sets.json`.
  `tiles` is in both asset-domain lists: dev serves the working tree, prod
  serves the published worlds' closure baked by ship-tiles3 and 404s
  everything else — the 400 MB domain never enters the image.
- HOW TO PLAY IT: it is the DEFAULT map (`maps.ts DEFAULT_WORLD`, the
  server's `WorldRoom.DEFAULT_WORLD`, first in the picker, preselected); dev
  worlds stay admin-only (`npm run dev` shows them unconditionally). Gate:
  `server/test/worldserve.test.ts` — disk and network, the request log,
  `gameUrl`'s identity, and a real Colyseus join landing on the maps3 spawn.

**RENDERING A MAPS3 WORLD.** `WorldScene` has a SECOND art source, not a second
renderer: the streaming RenderTexture, depth sort, occluders, painter order,
decks, indoor cut and the night shader are geometry and compositing and do not
care where the picture came from. Four modules, all pure and Phaser-free:
`client/src/tiles3.ts` (what draws on this cell), `tiles3draw.ts` (the two pixel

- Both staging bases are INJECTABLE (`ml-staging-base`, `STAGING_WORLD_BASE`)
  — the sandbox denies headless-browser egress, so a gate can point at a local
  fixture origin. (`verify-stagingworld.mjs`, which joined a fixture-only
  world@2 demo, was retired with tiles2; the server half is gated by
  `worldserve.test.ts`.)

**AR RETENTION**: `deploy/ar-cleanup.sh` — a server-side Artifact Registry
cleanup policy (keep newest 15 versions, delete >14 days), pasted once into
Cloud Shell from a phone. No CI job, no credentials, can't break on a red
pipeline.

## Assets (served at /assets)

- Art is read from the repo-root sibling domains — NOT copied in. Dev (Vite
  middleware in `client/vite.config.ts`) and prod (`server/src/index.ts`) both
  serve `/assets/<domain>/…` from `characters2/ tiles/ maps2/ scenery/`
  (`ASSETS_ROOT` overrides, e.g. in Docker).
- `scripts/build-manifest.mjs` scans `characters2/humans/` →
  `client/public/characters.json` (uid, name, frame size, per-anim/dir counts,
  urls); `build-worlds.mjs` discovers `maps2/worlds3/*/world.json` →
  `client/public/worlds.json`. Regenerate after graphics change
  (`npm run manifest`).
- **LOSSLESS WEBP IS THE PRODUCTION IMAGE FORMAT** (repo law — see root
  CLAUDE.md). Migration COMPLETE 2026-07-31, verified by loading every world
  in a real built client: zero PNGs, zero fallbacks, zero 4xx across 15,856
  asset requests. Convert with `games2/scripts/to-webp.py` (lossless +
  `exact=True`, both mandatory). The FOUR deliberate PNG exceptions:
  1. `client/public/icons/*.png` — PWA icons (`manifest.webmanifest` declares
     `image/png`; iOS `apple-touch-icon` requires PNG).
  2. `client/ui-src/**`, `scripts/assets/**` — the maintainer's hand-drawn
     SOURCE art; build inputs, never served (baked output in `ui2/` is WebP).
  3. `server/test/fixtures/*.png` — the WebP gate's comparison pair.
  4. `lore/icons/` — documentation art.
- **The transitional fallbacks are GONE — do not reintroduce them** (removed
  2026-07-31 once measured clean: the server's `.png`↔`.webp` sibling
  middleware, `WorldScene.loadImageEitherExt`/`onLoadMiss`, the campfire
  retry, `MapPreviewScene`'s minimap fallback). A server-side fallback MASKS a
  stale path — that is exactly how maps2's un-re-exported worlds went
  unnoticed for a day. A stale extension must 404 loudly; the fix belongs in
  the domain's exporter. (`imagelib.resolveImg` still follows a stale
  extension at BUILD time for manifest-driven domains — free, tested, stays.)
- All image reads in the builders go through **`scripts/imagelib.mjs`**
  (`imgDims`/`imgAlpha`/`imgRGBA`/`resolveImg`/`findImg`/`countFrames`).
  Rules that keep conversion safe:
  - **Lossless only.** A fully converted 11,152-file tree builds manifests
    IDENTICAL to the PNG build (both builders read only the alpha channel,
    which survives lossless exactly; RGB under transparent pixels may differ —
    invisible, never read).
  - **Extensions may be stale** — `resolveImg` follows `.png`↔`.webp`, so
    nothing has to land in order.
  - **The client never guesses**: `characters.json` carries `animExt` per
    state (absent = png) and the portrait's real extension; monster strips and
    world tile paths come from data.
  - Decoder is **`@cwasm/webp`** (120 KB, synchronous WASM) — NOT sharp
    (builders are sync; sharp is async-only). Also 4.7× faster than pngjs
    (384 strips: 1,494 → 319 ms).
  - **No conversion step in the Dockerfile** — it would re-run per deploy and
    bust the layer cache. Convert once at the source, commit the WebP.
  - Gate: `server/test/imagelib.test.ts` with committed PNG+WebP fixture
    pairs. TWO assets are named directly in game code and queue the png stem +
    re-queue `.webp` on 404: the campfire strip (scenery ships no manifest;
    `WorldScene`) and the world minimap (`MapPreviewScene`).
  - **Dev serving**: prod's `express.static` knows webp; the DEV middleware in
    `client/vite.config.ts` has a HAND-WRITTEN extension table — a format
    missing from it is served `application/octet-stream` and the browser
    refuses it. Add any future format there.
  - The world picker's thumbnail (`build-worlds.mjs`) probes `webp` before
    `png` per stem, so a mid-conversion world keeps its picture.

- **The deferred animation batch is THE ART QUEUE (#7)** (`client/src/
  artqueue.ts`, `docs/perf.md` THE ART QUEUE). `loadDeferredAnims` (my
  urgent clips, the NPC idles, the blood, my weapon/spell states, the other
  characters' states) and everything else streamed behind the live world go
  through one priority queue that decodes off the main thread and creates
  textures under a BYTE budget per frame (Settings dial "upload budget",
  `ml-upload-kb`, default 128 KB). Never the scene loader for anything behind
  the live world: it is one FIFO, it made every landed file a decode + upload
  the moment it arrived, and bounding the files in flight (the old
  `maxParallelDownloads = 2`) bounded the count per frame, never the bytes —
  measured 12 MB in one frame, 564 MB in a window, and every slow frame on
  his phone carrying an upload. Item icons, the grave cross and chess pieces
  still use the scene loader (small, on demand).

- **THE DEPLOY GATE AND CI MUST SEE THE SAME WORLD** — they do not, and that
  is why main can deploy while CI is red (ambient agent, 2026-09-07). The
  deploy workflow's test job uses a SPARSE CHECKOUT (`nangijala-deploy.yml`:
  `/games2/`, `/characters2/`, `/live/`, the wiki gate's two paths) and
  `maps2/worlds3/` — the directory holding the_game, the ONLY world — is NOT
  in it. Every test that reads it calls `test.skip("maps2/worlds3/the_game
  missing")`, so the gate goes green on tests it never ran (since 2026-09-09
  every world-reading test targets the_game, so the gate runs none of them).
  A skipping test is not a passing test, and a gate that cannot see its data
  cannot fail. Closing it means adding `/maps2/worlds3/` (18 MB) to that
  sparse checkout — do it the moment the fixtures are green, because until
  then it stops every deploy, and the maintainer tests in production.
  (`/tiles/` 684 MB and `/scenery/` 221 MB stay out — those tests already
  guard themselves on their own fixtures.)

- **Deploy** (push to main → live): the workflow runs `test` (typecheck +
  full suite) IN PARALLEL with the layer-cached image build; `deploy` needs
  both. Triggers on `games2/**` AND every domain the image bakes (art pushes
  deploy automatically — maintainer). EVERY PUSH IS ITS OWN RUN (a shared
  concurrency group deadlocked the pipeline for 18 hours, 2026-08-06), so runs
  finish in build order, and THE ROLLOUT GUARD ASKS PRODUCTION: it reads the
  sha the site serves (`/version`, the image's own GIT_SHA) and skips only when
  a DESCENDANT of its commit is already live; two rollouts that cross re-roll
  the newer commit once. Never main's tip — that starved production for 45
  minutes behind an art-push burst (every run found a newer tip by the time
  its build was done) and let a `live/**` save, which never deploys, cancel
  the rollout he was waiting for (2026-09-11/12). A green run whose summary
  says "Not rolled out" means the site is already PAST that commit, never
  behind it. A maps2 push using an unclassified tile
  category fails check-surfaces and BLOCKS its own deploy (prod stays on the
  previous revision) until the SURFACES entry ships — watch for red runs.
  Dockerfile layers are ordered deps → art (per-domain) → game source LAST;
  BuildKit's GHA cache makes a code-only deploy upload only the small
  source/build layers. Don't reorder the COPYs without thinking about which
  layer changes per deploy.
- **Loading screen** (`loading.ts`): select.ts shows it on "Enter world";
  WorldScene.preload feeds real progress; hidden when the player's own
  avatar joins (60s failsafe).
- **THE LOCAL PLAYER'S OWN ART IS FIRST IN EVERY QUEUE, AND REGISTERS PER
  STATE** (maintainer: "the player is the most critical graphics"). Two
  independent causes, fixing either alone did nothing:
  - ORDER: both batches iterated file order; `charsMeFirst()` (stable sort)
    puts mine at the head of the boot batch and the deferred one — ahead of
    the NPC idles now (the calm idle's frame-0 hold covers a frozen
    villager; a player with no death animation is worse).
  - REGISTRATION: `buildAnimations()` ran only on the loader's COMPLETE, so
    every clip became playable at ONE moment after the whole batch. Each of
    my states now registers the instant its OWN frames land.
  - **Counting the keys makes the early run SAFE**: a clip builds from
    whatever frames EXIST and is never repaired (`anims.exists` skips it) —
    registering mid-load would freeze an 88-frame die clip at 2 frames.
    `buildAnimations(uid, state)` may only run once every key queued for
    that state fired FILE_COMPLETE (an ERRORED file never fires; the batch's
    COMPLETE drops the listener either way).
  - `PLAYER_URGENT_STATES` = hurt/die/kick/punch/pickup — what can trigger
    seconds after spawn. Weapon/spell states deliberately queue behind the
    NPCs (nothing can play them yet; 128 of my 408 deferred frames).
    Ordering only, never a filter.
  - Measured on a throttled 12 Mbps link: hurt 1.18s, die 2.99, kick 3.77,
    punch 4.30, pickup 5.32 (weapon/spell 10.5-11.5) vs everything-together
    at the end before. Probe: `__ml.animReady()` (`mine.left` stuck >0 with
    `at` null = the fast path did nothing).
- **Asset loading is SPLIT + deploy-pinned cached** (the 13-state overhaul
  ballooned boot to ~1200 frames):
  (1) preload fetches ONLY `BOOT_ANIM_STATES` (idle/walk/run/jump,
  manifest.ts); the 9 action states background-load via
  `loadDeferredAnims()` once the avatar joins.
  (2) **Every /assets URL is stamped with its CONTENT HASH** — `?h=<sha256-16>`
  from `/asset-index.json` (assetver.ts), ONE `no-cache` document naming the
  current hash of every file under ASSETS_ROOT (`scripts/build-asset-index.mjs`,
  run in the image build after the curated root is complete; express's ETag
  makes the per-boot revalidation a 304 until a deploy changes art). The
  server grants `immutable` 1y ONLY when the hash equals the hash of THE
  BYTES IT IS ABOUT TO SEND (`server/src/assethash.ts`, memoised per file;
  `cachepolicy.ts`) — it never trusts the index. So an unchanged file keeps
  its URL across deploys and the browser never asks for it again, while a
  stale index can only earn a revalidated response, never a frozen wrong
  file (maintainer 2026-09-02: one uncached list of hashes, fetch only what
  changed — and no cache bugs). `?v=<build sha>` (VITE_GIT_SHA) remains the
  FALLBACK for whatever the index does not name — client/public art (UI,
  icons), a staging world's CDN URLs, any boot where the index
  failed — with the old rule: `immutable` only when v matches the server's
  OWN GIT_SHA, else no-cache. sw.js caches nothing. The index is fetched
  first of all in main.ts and awaited with the four boot catalogs (which
  are fetched in parallel — four serial awaits cost a round trip each).
  Gates: `cachepolicy.test.ts` (the ?h grant is verified against served
  bytes; malformed, stale and mismatched hashes never freeze; hashing is
  lazy), `assethash.test.ts`, `assetver.test.ts`.
  **THE BUNDLE IS A SEPARATE GRANT**: everything rollup emits into
  `client/dist/assets` is content-hashed by the bundler, so those URLs are
  immutable by construction. The rule matched `js|css` only, leaving 532 of
  535 emitted files (503 .ogg, 13 .m4a, 2 .mp3, 5 .wav, 9 .webp) on
  no-cache — 532 revalidation round trips per repeat visit over ~11 MB of
  bundled audio. The grant is scoped **BY DIRECTORY**, not filename shape —
  the same server serves the `/assets/<domain>` ART mounts where agents
  repaint files IN PLACE, and a filename-shape rule would freeze a repainted
  tile for a year the first time an art file looked hashed. A file inside
  `client/dist/assets` is rollup output by construction; `client/public`
  has no `assets/` dir. Policy: `server/src/cachepolicy.ts` (a pure
  function, testable without a server); regressions:
  `server/test/cachepolicy.test.ts`.
  **A per-file hash is only ever granted after VERIFICATION against the
  served bytes** — an UNVERIFIED per-file hash was proposed and REJECTED
  once for the right reason (a server that trusts any `?h` converts the
  worst case into a 1-year cache entry no deploy can heal); hashing the
  file it serves is what removed that premise. The composer keeps its own
  `withAudioV` (`?v`), and client/public art stays on `?v` — both still
  verifiable, both unchanged.
  (2b) **Responses are COMPRESSED** (server/src/index.ts, brotli q4 /
  gzip 6, threshold 1 KB): ~2.5 MB off a cold load (bundle 1.97→0.50 MB,
  world.json 737→37 KB, monsters.json 383→21 KB). Images are NOT compressed
  (`compressible` = false for image/*). **The brotli quality pin is
  LOAD-BEARING — never raise it**: measured q4 51 ms, q5 81 ms, q11
  5,252 ms — five seconds per request on the one Cloud Run core.
  `compression` 1.8.1 defaults brotli to 4, but that is their default, not
  a promise — it is pinned at the call site; re-pin if the middleware is
  ever swapped. Safe for the 20 Hz sim: node's zlib STREAM api runs on the
  libuv threadpool (measured zero dropped ticks incl. ten simultaneous cold
  joins).
  (3) **UI art is lossless WebP and every piece `withV()`-stamped**
  (unstamped, each cost a blocking revalidation before the loading screen
  painted). `scripts/bake-tab-icons.py` emits WebP — convert at the SOURCE,
  never in the Dockerfile. Findings worth not re-deriving: PNG-8 palette is
  useless here (1 of 240 sampled sprites ≤256 colours); the logo LOOKS like
  6× pixel art but was upscaled SMOOTHLY (re-baking at 181×105 costs mean
  error 22/255 — it is a soft render). `public/icons/*.png` stay PNG (iOS
  ignores WebP apple-touch-icon).
- **PWA**: `manifest.webmanifest` (display fullscreen; orientation any —
  see below), `public/sw.js` (passthrough, caches NOTHING — this repo fought
  stale-deploy bugs; the server's Cache-Control is the policy), icons from
  scripts/build-pwa-icons.py (committed). main.ts stashes
  `beforeinstallprompt` → select.ts shows "Install as an app".
  verify-mobile.mjs covers it headlessly.
- **"Desktop site"**: the CANVAS is neutralized (dynamic integer zoom —
  WorldScene.zoomFor, probe `__ml.camZoom()`); the DOM UI is ordinary
  responsive CSS (no compensation).
