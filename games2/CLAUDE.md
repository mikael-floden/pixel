# CLAUDE.md — Nangijala working notes

## What this is

**Nangijala** is a browser-based **multiplayer** (MMO-style) pixel-art RPG.
Everyone who connects joins the **same shared isometric world**. It lives inside
the **`pixel` monorepo** at `games2/` and renders the art produced by the
sibling agent domains (`characters2/`, `tiles2/`, `maps2/`, `objects/`).
**Read-only toward the art** — never edit those directories (see
`coordination/PROTOCOL.md`; this game owns `games2/` +
`coordination/games.json`). No submodule. Developed by a self-iterating loop —
see `loop/LOOP.md`. Since 2026-07-17 `games2/` is worked by TWO agents: the
games agent (gameplay/netcode/world/server) and the **games-ui agent** (HUD,
menus, screens, overlays — board file `coordination/games-ui.json`); the
per-file ownership split lives in `UI_AGENT.md`. (The first-generation `games/`+`characters/`+`maps/`+
`tiles/` were retired 2026-07-14; history in git.)

## Tech stack

- **TypeScript npm-workspaces**: `shared/`, `server/`, `client/`.
- **Server** (`server/`): Node + **Colyseus** authoritative `WorldRoom` holding
  the single shared `WorldState` (map of `Player`s). Clients send `input`; the
  server integrates on a 20 Hz tick (`shared/stepMovement`) and syncs state.
  Persistence in `store.ts` (returning players keep their spot by token). Runs
  with plain `tsx` — the schema is decorator-free (`defineTypes`, not `@type`),
  so no `experimentalDecorators`/Node-version fragility.
- **Client** (`client/`): **Phaser 3** + `colyseus.js` (Vite). Client-side
  prediction + reconciliation; chat + roster; renders the **isometric world**.

## Assets (served at /assets)

- Art is read from the repo-root sibling domains — NOT copied in. The dev server
  (Vite middleware in `client/vite.config.ts`) and prod server (`server/index.ts`)
  both serve `/assets/<domain>/…` from `characters2/ tiles2/ maps2/ objects/`
  (override the location with `ASSETS_ROOT`, e.g. in Docker).
- `scripts/build-manifest.mjs` scans `characters2/humans/` →
  `client/public/characters.json` (uid, name, frame size, per-anim/dir counts,
  `/assets/...` urls); `build-worlds.mjs` discovers `maps2/worlds/*/world.json`
  → `client/public/worlds.json` (the picker). Regenerate after graphics change
  (`npm run manifest`).
- **LOSSLESS WEBP IS THE PRODUCTION IMAGE FORMAT.** Every art domain the game
  loads has migrated (verified 2026-07-31 by loading the real built client:
  characters2 1419, monsters 9733, maps2 35, objects 153, items 105, wiki 12,
  tiles2 8744 — **zero PNGs** in any of them, and zero PNGs left in the Vite
  bundle). New art ships WebP; convert with `games2/scripts/to-webp.py`
  (lossless + `exact=True` — see the rules further down, they are not optional).
  The FOUR deliberate PNG exceptions, none of them misses:
  1. `client/public/icons/*.png` — PWA icons. `manifest.webmanifest` declares
     them `"type": "image/png"` and iOS `apple-touch-icon` requires PNG.
  2. `client/ui-src/**` and `scripts/assets/**` — the maintainer's hand-drawn
     SOURCE art. Build inputs, never served; the baked output in
     `client/public/ui2/` is already WebP.
  3. `server/test/fixtures/*.png` — the WebP gate's comparison pair. The whole
     point is decoding a PNG and its WebP twin and asserting they match.
  4. `tiles2/docs/`, `lore/icons/` — documentation art, not game art.
- **THE MIGRATION IS COMPLETE, and the transitional fallbacks are GONE**
  (2026-07-31). maps2 re-exported all 10 `world.json` files, so the last
  literal `.png` paths in the project are retired: 4,693 tile/prop paths are
  now `.webp`, all resolving on disk. Verified by loading **every world** in a
  real built client — 0 `.png` requested, 0 fallbacks fired, 0 4xx, across
  15,856 asset requests.
  Removed once that measured clean: the server's `.png`<->`.webp` sibling
  middleware, `WorldScene.loadImageEitherExt`/`onLoadMiss`, the campfire retry,
  and `MapPreviewScene`'s minimap fallback. **Do not reintroduce them.** They
  were migration scaffolding, and keeping them has a real cost beyond the code:
  a server-side fallback MASKS a stale path, which is exactly why maps2's
  un-re-exported worlds went unnoticed for a day — every tile was silently
  rescued. A stale extension now 404s loudly and visibly, which is what you
  want, because the fix belongs in the domain's exporter and not in a permanent
  mask in the game server. (`imagelib.resolveImg` still follows a stale
  extension at BUILD time for manifest-driven domains; that one is free, tested
  and stays.)
- **PNG *and* lossless WebP — art domains may convert freely** (games agent
  2026-07-31, unblocking the ui-agent's WebP migration: ~128 MB of art → ~69 MB,
  a cold load's art 12.8 MB → ~6.3 MB). The builders used to hand-parse the PNG
  IHDR and decode with pngjs, which is why they were the blocker. All image
  reads now go through **`scripts/imagelib.mjs`** (`imgDims` / `imgAlpha` /
  `imgRGBA` / `resolveImg` / `findImg` / `countFrames`). The PNG code inside it
  is the ORIGINAL moved verbatim, so an all-PNG repo emits a byte-identical
  manifest — verified. Rules that make the migration safe:
  - **Convert LOSSLESS only.** Verified end to end: building the manifests from
    a fully converted 11,152-file tree gives values IDENTICAL to the PNG build
    (every foot anchor, shoulder waterline, foot plant, gait rate, monster
    contact centroid, shadow size, per-frame shift/air). Both builders read
    ONLY the alpha channel, and alpha survives lossless conversion exactly.
    RGB *under fully transparent* pixels may differ (encoders normalise hidden
    bytes) — invisible, and never read.
  - **Extensions may be stale.** `resolveImg` follows `.png`↔`.webp`, so a
    `monster.json` / `world.json` still naming `.png` keeps working the moment
    the file becomes `.webp`. Nothing has to land in order, and a strip never
    silently vanishes mid-conversion.
  - **The client never guesses.** `characters.json` carries `animExt` per state
    (absent = png) and the portrait's real extension; `frameUrl` reads it.
    Monster strip URLs and world tile paths already come from data.
  - Decoder is **`@cwasm/webp`** (120 KB, synchronous WASM) — NOT sharp: these
    builders are sync top to bottom and sharp is async-only. It is also 4.7×
    faster than the pngjs path (384 strips: 1,494 ms → 319 ms), so the manifest
    build gets *quicker* as art converts.
  - **Do NOT add a conversion step to the Dockerfile** — that would re-run on
    every deploy and bust the layer cache. Convert once, at the source, commit
    the WebP.
  - Gate: `server/test/imagelib.test.ts` (in `npm test`) with committed
    PNG+WebP fixture pairs. TWO assets are still named directly in game code,
    and both queue the png stem and re-queue `.webp` on 404: the campfire strip
    (`objects/` ships no manifest, `WorldScene`) and the world minimap
    (`MapPreviewScene`). Everything else resolves through data.
  - **Serving**: prod's `express.static` knows webp from its own mime db, but
    the DEV middleware in `client/vite.config.ts` has a HAND-WRITTEN extension
    table — a format missing from it is served `application/octet-stream` and
    the browser refuses the image. `.webp` is in it now; add any future format
    there too. That middleware also honours `ASSETS_ROOT` (as prod and the
    builders always did), so a staged conversion can be driven in a browser
    before the art domain commits it.
  - The world PICKER's thumbnail (`build-worlds.mjs`) probes `webp` before
    `png` per stem, so a `maps2` world keeps its picture whether it has
    converted, hasn't, or is mid-conversion with both on disk.

## Isometric world

- `shared/parseWorld` reads `maps2/worlds/<name>/world.json` — **world@1**
  (materials/paths/top/level/mat grids + props + spawn + size; also still
  parses the legacy `rows`/bigworld@1 schemas). Geometry
  unchanged (`x=(col-row)*32`, `y=(col+row)*dy − level*lh`, painter order by
  `(col+row,row)`). World units: **32 per cell** (`CELL_WU`); WORLD_WIDTH/HEIGHT
  are sized to the current grid — update them if the map dimensions change.
- The world is far too large to bake into one texture, so `WorldScene` streams
  it: a world-anchored RenderTexture covering the screen + `GROUND_MARGIN` px is
  redrawn only when the camera nears its edge. `MapPreviewScene` (`/#map`) shows
  a maps2 world's pre-rendered `minimap.png` when it ships one. `project()`s each
  player's flat `(x,y)` onto the grid (feet lifted by elevation).
- **Anti-tiling**: NONE right now. Picking or varying the actual tiles is the
  **maps agent's** job — this repo never swaps a cell's art. (Both a shader
  seam-smear AND the brightness "ground wash" were attempted and **fully rolled
  back** — the maintainer wants the fresh, effect-free ground; a new repetition
  approach is TBD. Do NOT reintroduce any ground repetition effect while overpass
  work is in flight.)
- **world@2 decks** (elevated walkable slabs — roofs, bridge spans): a strict
  superset of world@1 (`shared/parseWorld` reads the optional `decks` array;
  `Deck`/`DeckCell`). A deck is a SECOND surface at some cells, floating over
  the unchanged base terrain (walk/swim UNDER it). `redrawGround` draws each
  deck cell right after its base cell in (x+y) order — `thickness` face tiles
  then the `top` diamond at `level`, open air below. Only `occlusion_test` ships
  decks (a flat-roof house + a bridge). Spec: `maps2/spec/WORLD_FORMAT.md`.
  DONE: parse + render + occluders (under-walkers are covered) + **"current
  layer" movement**. Each `Player` carries an explicit `elev` (surface LEVEL);
  `shared/canEnterElev`+`resolveElevAt` offer a deck cell TWO surfaces (base and
  deck) and keep you on whichever is reachable and closest to your current elev —
  so you walk ACROSS the bridge/roof (elev stays 4) instead of falling to the
  water/floor, and walking UNDER stays on the base. Non-deck cells resolve
  exactly as `canEnter`, so world@1 is unaffected. A deck stays walkable even
  over a blocked base (water/chasm/prop). **Tap-to-move is deck-aware**: `pickGround`
  returns the deck when you tap a bridge/roof top, and `findPath` searches a
  LAYERED graph (a node is (cell, base|deck)) so it routes UP a ramp and over —
  threaded through `startTrip`/`stepAutopilot` as `fromElev`/`goalLevel`. **Deck
  LIGHTING**: the night shader's SURFACE heightmap reports the deck level (not the
  base) so a deck-top pixel resolves to its real height — no phantom cast shadow
  from the plateau/walls, and the player's torch (z anchored to the avatar's
  rendered elevation) lights the deck it stands on. The avatar's LIT-COPY tint
  (its day/night brightness) also samples the light field at the avatar's
  RENDERED elevation (`a.elev` px → levels, same basis as the torch z) — NOT the
  base terrain level: on a roof/bridge the base is the floor UNDER the deck, so
  sampling there marched the sun ray up into the roof and the character rendered
  SHADED in full daylight (until a step onto a wall, whose base genuinely reaches
  the deck level, popped it bright). An under-deck walker (elev = base) still
  samples the base and stays correctly shaded beneath the roof. Gates:
  `scripts/verify-deckwalk.mjs` (in `npm test`) drives the real occlusion_test
  grid incl. layered findPath; `scripts/verify-decklight.mjs` (dev-stack browser,
  data-driven) asserts every deck TOP is lit at Day while the base under it is
  shaded — so the avatar must sample at its own elevation. Probes:
  `__ml.deckInfo()`, `__ml.me().elev`, `__ml.litInfo()` (avatar's lit sample: `l`
  at its elevation = ships, `lBase` = the old base-level shade). DECK-AWARE
  FOLLOWER (maintainer 2026-07-25 "runs up and down, can't get over the bridge"):
  the follower's per-heading OPENNESS PROBE now builds its blocked predicate with
  the deck-aware `makeBlockedElev` carrying the player's surface `elev` (resolved
  from the passed `fromElev`), the SAME rule the body integrates with — it used
  the base-only `makeBlocked`, so a player on a bridge DECK read the base cell
  UNDER the span (gap/water at level 0) as their "from" level and EVERY step off
  onto same-level land looked like a multi-level cliff (all headings probed
  blocked → steer up/down, never leave). Non-deck cells reduce to `canEnter`
  (byte-identical). The stall-replan is already deck-aware (`findPath` with
  `fromElev`/`goalLevel`). Gate: `server/test/navigation.sim.test.ts` "leave the
  bridge onto same-level ground" scans every the_island2 span cell and drives the
  real follower off it (fails on the base-only baseline, 4/40 stuck). SEEING
  YOURSELF UNDER A DECK (inside the house, inside the cave) is answered by
  INDOOR MODE — see the entry under Night lighting.
- **SEE-THROUGH WALLS IS DELETED — do NOT reintroduce a per-frame occluder
  alpha sweep** (2026-08-06). The prototype (~196 lines, the `[7]` key, a
  Settings switch "see-through walls" and the `__ml.occFade`/`occFocus`/
  `occApply` probes) ran a GHOST PASS EVERY FRAME: it walked the whole
  occluder set and, for every image whose cell was taller than the player's
  level, inside a 14-cell bubble AND in front of the player (`col+row >`
  the player's `fSum`), dropped its alpha and pushed it behind
  the player — plus a REVEAL RenderTexture at depth −900_000 that redrew the
  player-level ground the tower was covering and stamped a BLACK diamond at
  each faded tower's root so its footprint still read as void. It was OFF by
  default and never persisted (no localStorage), so nobody but QA ever saw it.
  The maintainer removed it as SLOW and never good-looking: the sweep is a
  getData + setDepth + setAlpha over the live occluder set (3.9k images after
  the view-cull, 13k before), and every setDepth re-queues Phaser's
  display-list sort — 1.33ms/frame measured for a feature that was off. Its
  replacement shipped 2026-08-07 as INDOOR MODE + the WHITE OCCLUSION OUTLINE:
  the first decides per CELL what is indoors instead of re-tinting thousands of
  images per frame, and the second costs ONE image per COVERED body instead of
  an alpha sweep over the whole occluder set. The dead `"ot"`/`"od"` occluder
  tags went with the prototype — `tagOccluder` now stamps the cell only.
  History in git.
- **OCCLUDER VIEW-CULL + DECK EXPOSURE** (perf #2/#3, 2026-07-31 — the walking
  hitch). `rebuildOccluders` destroys and recreates the whole occluder set
  whenever the camera centre drifts `OCC_STEP` (96px), and it built **14.4
  images per cell** — 13,521 live images at the_island2's mountain, of which a
  measured **82% never intersected the camera at all**. Two subtractive fixes,
  no new runtime state:
  (#3, the bigger one) the DECK branch had **no exposure test at all** — it drew
  every face level of every deck cell, and the_island2's 12 cave decks are
  16-32 levels thick, so an interior cave cell cost 17-33 images (~65% of every
  image in the mountain window). `deckCoverFrom` gives decks the exposed-face
  rule terrain has had since the terrace-tear fix, comparing BANDS: a slab
  covers `[level-thickness, level]`, and only a CONTIGUOUS run reaching my own
  bottom actually hides my faces (a slab floating higher leaves open air, and a
  face under it is genuinely visible from below).
  (#2) each face/top image is skipped unless it lands in the camera view grown
  by `OCC_CULL_PAD` (a full rebuild step + a tile + the widest body art box).
  **DO NOT make `stackFrom` deck-aware** — it is deck-blind ON PURPOSE. Deck
  cover is a band, not a prefix, so a naive deck-aware variant cuts 4,748
  terrain faces on the_island2 that nothing covers — a worse tear than the one
  stackFrom was written to fix. Over-drawing because of a deck is the safe
  direction and costs 0 faces on every shipped world.
  WHY CULLING IS SAFE AT ALL: an occluder never contributes terrain pixels —
  the ground RT (depth −1,000,000) already paints all of it. Occluders are a
  duplicate re-issued at sprite depth purely so bodies can interleave, so
  over-culling can only mis-SORT a body, never leave a hole. The real invariant
  is therefore about `occluderMeta` (one record per CELL, never culled — it is
  what `resolveBodyDepth` reads for depth and `coverY`): **a meta record
  overlapping the view must still have drawn art behind it**, or a body clips
  against terrain that is not there. That is why the TOP image is kept whenever
  the whole COLUMN reaches the cull box (`columnShows`), not merely when the
  top tile itself does — the first cut culled per-tile and the audit found 94
  uncovered columns. Probe `__ml.occAudit()` checks this against Phaser's own
  `getBounds()` and the camera's own `worldView`, never against the cull
  arithmetic: `metaWithoutArt` must be 0 (props are excluded — they draw from
  `propImgs` and are never culled). Measured: images 13,521 → 3,885 at the
  mountain (3.5×), mean 4,000 → 1,462; `coverY` under every thick cave slab is
  **bit-identical** to the pre-cull build (13 spots, same values). Gate: the
  occluder block of `verify-smoke.mjs`, run on `occlusion_test` (the only
  compact world with BOTH level-32 terrain and decks — the other small worlds
  are flat and make the check vacuous), standing and walking.
  STILL OPEN: this cuts the image COUNT, not the churn — ~92% of the set is
  identical between consecutive rebuilds, and the worst walking frame only fell
  971 → 784ms. The remaining spike is the destroy-all/create-all itself plus
  `redrawGround`, which has the SAME unconditional deck face loop (~9,000 extra
  `batchDraw`s per redraw) on its own 256px schedule. Pooling the images or
  trimming the RT are the next moves — both need their own verification (the RT
  trim is NOT a drop-in: it skips void cells).
- `stairs` tiles act as ramps (crossing one allows a full 1-level step without
  jumping); solid structure tiles (trees, boulders, obelisks, watchtower, cactus,
  lava) are impassable — see `SURFACES`/`surfaceFor` (road_* matched by prefix).
- Movement system (#17) is server-authoritative and governed by **elevation**,
  not tile category (`shared/`): `buildTerrainGrid` reads each cell's `l` +
  category; `canEnter` allows a move only if the destination is enterable and the
  UPWARD elevation step is within the climb allowance — dropping down any
  height is always allowed (gravity is free). Design **"Option 2B"**:
  `WALK_CLIMB = 0.5` (you can't walk up a full 1-level ledge), but a **timed
  jump** (`JUMP_CLIMB = 1`, Space) climbs it. `stepMovement` resolves axis-
  separated (wall-slide) and scales by the current **surface** speed.
- **Steer assist** (`shared/steerAssist`, maintainer 2026-07-22): running with
  DIRECT input (WASD or the HUD analog stick, which synthesizes keys) into a
  SOLID PROP dead-stopped the player even when they obviously meant to pass
  beside it (wall-slide only helps while an input axis is still free).
  Deliberately NOT navigation: on a real stall it inspects ONLY the tiles
  beside the ONE blocked cell — if the object's perpendicular neighbour is
  open walkable ground (tile not solid, elevation-reachable, sideways step
  physically free), the input is deflected to the CLOSEST such side until the
  body clears the corner, then the held keys resume forward naturally. A wall
  of solids / dead end → no assist, honest collision. Elevation ledges are
  excluded (auto-jump's domain); the autopilot never uses it (findPath).
  Client-only input synthesis exactly like auto-jump — prediction and server
  get the same deflected vector, so nothing rubber-bands. Grounded in REAL
  `stepMovement` sims so trigger/release can't disagree with the collision
  probes (incl. the 0.75R corner probes — it keeps sliding until forward
  truly moves). Probe: `__ml.steerAt(x,y,ax,ay)`; tests:
  `server/test/steering.test.ts` (closest-side, fallback side, wall stays
  stuck, ledge untouched, wall-slide untouched, end-to-end corner round).
- **Auto-jump**: walking INTO a 1-level wall auto-fires the jump so you don't
  tap Space at every ledge (`WorldScene.maybeAutoJump`/`wouldAutoJump`, called
  from `predictAndSend`). The rule is exactly `!canEnter(walk) && canEnter(jump)`
  probed a leading-edge ahead in the move direction — so a 2-level+ wall (fails
  the jump check too) and solid props (impassable at any climb) are left alone,
  and flat ground never auto-jumps. Client-only (queues the same jump input the
  server validates); `tryJump` still gates on grounded+cooldown. Probe via
  `__ml.autoJumpAt(x,y,ax,ay)`.
- **Collision probes** (`stepMovement`): per axis, the forward CENTRE probe
  applies the full rule (elevation + solids, `makeBlocked`); the two LATERAL
  corner probes (±`PLAYER_RADIUS*0.75`) apply `makeSideBlocked` (solids only)
  and are STRICT — an earlier "escape-permissive" variant compared probe cells
  at current-vs-target and, for normal step sizes, both landed in the same
  cell, which effectively disabled lateral prop collision and let bodies
  drift INTO prop footprints. Integration is SUBSTEPPED (~4wu chunks): the
  probes refuse an axis whose leading edge at the step's END is blocked, and
  one 100ms run input (`MAX_INPUT_DT`, or a laggy phone frame in the client
  tail) reaches ~30wu — pre-substep it refused the whole move and froze the
  body far from the wall, where short-step probes (the autopilot's openness
  checks, the next walk tick) disagreed that anything was blocked at all.
  Test: "big-dt input advances to contact instead of freezing a step early". Bodies that nonetheless end up inside a solid's
  collision margin (fall landings, spawns, historical positions) are freed by
  **`unstickFromSolids`** (shared): a smooth, speed-limited push out along the
  away-gradient of every overlapping solid cell, run by the SERVER before each
  input integration and mirrored by the client prediction (`stepLocal`) so
  they stay in lockstep. Never weaken the probes to fix a wedge — unstick is
  the escape hatch. Regression tests: "no wedging at an inside cliff corner" /
  "…between two props (unstick loop)" / "unstickFromSolids frees overlapped
  bodies" in server/test/collision.test.ts.
- **Edge feel / falling**: walking off a ledge is forgiving — `stepMovement`
  no longer commits the drop a `PLAYER_RADIUS` early or snaps the anchor past
  the rim (the old "teleport to the floor beneath" feel). The feet just walk to
  the rim (the body billboard overhangs "slightly over the edge") and, once the
  centre crosses onto the lower cell, the descent is a **gravity FALL** animated
  client-side: `WorldScene` keeps each avatar's elevation lift (`elev` px) apart
  from the flat ground projection and integrates it with the shared pure
  `integrateFall` (`shared/`) — up-steps snap, stairs-sized down-steps ease,
  real cliffs fall (shadow stays on the landing ground, sprite drops toward it).
  `makeDrops` is now just the canonical "is this a fall" predicate the client
  mirrors. Tune via `FALL_GRAVITY`/`FALL_TRIGGER_FRAC` in `shared/`.
- **Surfaces** (`SURFACES` in `shared/`) are the *other* axis: per-category
  `{ standable, swimmable, speed, sound }` — roads faster, sand/snow slower,
  water swimmable. Unknown categories default to plain walkable ground.
- **Swimming/stamina** (`stepStamina`): entering water drains stamina (~20/s),
  land regenerates it; at 0 you **drown** → respawn on nearest land (`findSpawn`),
  server broadcasts `drown`. Client shows a swim tint, sink, and a stamina HUD.
- Client rebuilds the SAME grid and predicts jump/swim/speed so nothing rubber-
  bands. Press **C** to visualize water cells. Tune feel via the `*_CLIMB`,
  `*_STAMINA`/`SWIM_*` constants and the `SURFACES` table.
- **Direction display is hysteretic** (`WorldScene.stableDir`): walking along
  an 8-way sector boundary flips `vectorToDirection` every few frames, which
  used to restart the walk clip each flip ("jitter"). Adjacent (45°) changes
  must persist `DIR_STICK_MS` before the sprite turns; 90°+ turns switch
  instantly; and a direction-only clip change resumes at the same loop
  progress (no stride restart). This is display-only — server/movement math
  is untouched.
- **Controls are screen-relative** on the iso world: `stepMovement(..., screenInput)`
  rotates the input by the projection ratio (`ISO_DX`/`ISO_DY` in `shared/` — the
  client's `MAP_GEOMETRY` imports them so they can't drift) so pressing Up walks
  straight up on screen; facing uses the raw screen vector. **Grid-axis lock**:
  a diagonal press (both a horizontal AND a vertical key) snaps the world move
  to the nearest tile axis (`screenToWorldVector`) — down-left/up-right run along
  one iso axis, down-right/up-left the other — so corridors/bridges track true
  instead of drifting off screen-45°. Single-key presses keep screen-cardinal.
- Open follow-ups (#28): occlusion behind tall tiles; half-level (0.5) stair/ramp
  tiles from the maps agent so players can ascend without jumping. If the tile
  "house format" changes, re-measure `MAP_GEOMETRY` and update `ISO_DX/ISO_DY`.

## Animation playback (anti-moonwalk)

- **State→art mapping is the art domain's contract**: `build-manifest.mjs`
  resolves each game state (idle/walk/run/jump/kick/…) to its PixelLab folder
  via `characters2/animation_map.json` (per-hero `overrides` win; the built-in
  fallback table mirrors the file). When PixelLab renames a move, only that
  file changes — regenerate the manifest, no game edit. **ONE jump state**
  (maintainer 2026-07-29): the separate standing high-jump/`runjump` pair was
  consolidated — the steeplechase leap plays for standing AND running hops.
  Its once-through rate is DERIVED per character (`frames / JUMP_MS`) so the
  clip spans the ~500ms hop whatever the art ships (4 frames now, was 9 —
  the old fixed 18fps would freeze a 4-frame clip mid-air). Browser gates:
  `verify-jump.mjs` / the smoke's jump + anim-rate sections (both assert the
  derived rate; keep e2e viewports SMALL — at 900×600 headless starvation
  made the sampler miss the whole hop and faked "jump never plays").
- Walk/run playback rates are MEASURED, not guessed — and it's ONE rate per
  (character, gait), same cadence in all 8 directions (per-direction rates
  were measurement noise and popped on turns). `build-manifest.mjs` finds
  the foot blobs (same 2D machinery as the anchors), takes the max foot
  spread over a cycle = the STEP, and derives `fps = speed × frames /
  stride` with stride = 2 steps (screen speed is direction-uniform by
  projection design: WALK 70 / RUN 175 px/s at zoom 1). RUN divides the
  stride by a ~0.55 stance fraction: a runner also covers ground while
  AIRBORNE, which static frames can't encode — without it the formula
  demanded a frantic 22-30fps (the playtester's "playing way too fast";
  the first attempt's SAD strip-matcher also under-measured strides).
  Output: `gaitFps` in characters.json, applied per-clip in
  `buildAnimations` (fallback: ANIM_FPS).
- Rate ∝ CURRENT **WORLD** speed: `applyAnimState` sets `anims.timeScale` to
  the avatar's EMA'd world-units speed (`av.spdWu`, back-projected from the
  eased flat screen delta) over the gait's side-view reference speed
  (base·√½ ≈ 49.5/123.7 wu/s). World — not screen — speed on purpose: the
  calibrated-uniform screen speed means a screen-north walk crosses
  ISO_DX/ISO_DY ≈ 2.13× more world ground per second than east, so N/S legs
  pace 2.13× faster (playtester: "up/down walk plays too slow"), key
  diagonals 1.28×, and water slowdown / easing / autopilot pace changes keep
  footfalls on the ground — continuously, no per-direction cadence pops.
  MOVEMENT SPEED IS UNTOUCHED — only playback. Probes:
  `__ml.animRate(uid,state,dir)`, `__ml.timeScale()`, `__ml.worldSpeed()`,
  `__ml.gaitSample()`; regressions: `scripts/verify-animrates.mjs` (rates +
  live timeScale ≡ worldSpeed/ref on east AND north) and
  `scripts/verify-gaitsync.mjs` (end-to-end: world ground per animation
  cycle == the design stride on BOTH headings, starvation-immune; stance
  foot-slip reported as info — the art glides a little by design,
  cadence-true playback keeps a residual).

## Swimming (WorldScene + shared nav + build-manifest)

Water is free, sustainable locomotion (NOT a hazard). `findPath` treats water
as normal ~1.8x-slower terrain (no drown, no run cap); a tap ON water is a
valid swim destination. The server only mirrors `player.swimming` from the
surface — no stamina/drown.

The swim LOOK: the character FLOATS with a per-direction SHOULDER WATERLINE at
the water surface — head + shoulders above, everything below the line clipped
(underwater), no shadow, gentle head bob, idle clip (no water tint — the
visible head/shoulders are ABOVE the surface).
- Waterline data: `shoulders[dir]={lx,ly,rx,ry}` (two shoulder points, frame
  fractions; the line can TILT). The MAINTAINER hand-drew them (finger →
  least-squares straight-line fit, registered to frame space via the auto-detect
  dot markers); committed in `data/waterlines.json`, merged by build-manifest
  (override wins; `shoulderLine()` silhouette auto-detect is the fallback for
  un-annotated characters). Regenerate the manifest after editing waterlines.
- FLOAT: for a water cell the fall target is `surfLevel·lh − swimDrop` — the
  feet sink `swimDrop` px below the POOL'S OWN surface so the shoulder line
  lands at the water level. RELATIVE to the pool, never absolute: water can sit
  at any elevation (the_island2's plateau lagoons are level-4+ `clear_water`),
  and the original absolute `-swimDrop` target sank an elevated pool's swimmer
  the whole pool height below its surface (maintainer: "lowered too low when
  walking into the water"; for level-0 seas the two are identical). The
  existing gravity fall carries the body THROUGH the surface and STOPS
  (buoyancy) at the shoulder line — so dropping in from a ledge submerges
  progressively. `swimT` (0..1) = `(surfLevel·lh − elev)/swimDrop` (same
  pool-relative basis) drives the clip: it raises the cut from the FEET (just
  entered) to the SHOULDERS (afloat).
- CLIP: `updateWaterClip` builds a geometry mask ABOVE the waterline and applies
  it to the base sprite AND its lit night-copy. The waterline is a shallow
  downward BOW (a "smile", `BOW_FRAC` × body span), centred on the OPAQUE span
  the line crosses (`waterlineSpan`), so the cut wraps the body's volume — the
  centre-front pokes through, sides sit higher. The mask polygon samples the
  curve (concave — Phaser's `fillPoints` earcut-triangulates it) with straight
  baseline extensions beyond the body. Uses `av.dispDir` (the DISPLAYED facing).
- FOAM (`foamTexture`): a per-frame frame-space texture baked on the SAME curve
  — 1px white crest + 2px dark water per column, honouring the silhouette
  (breaks over hair↔body gaps), extended a few px past each end and faded to
  transparent so it reads as wrapping the volume. Tinted by the local night
  light (drawn above the overlay). Animated by rocking the whole curve ±≤1px in
  a random non-looping tilt (`FOAM_ANIM_MS`); light-only.
- QA: `__ml.swimming/swimT/myDispDir/swimDebug` (swimDebug returns the clip
  line in SCREEN coords — overlay it to confirm clip==line). NOTE: measure the
  clip AT REST — a mid-motion capture skews the position probe vs the
  screenshot by a few frames and fakes an offset.

## Footstep marks (client/src/footsteps.ts)

- Every foot PLANT stamps a tiny ground mark at the EXACT drawn spot the foot
  came down; different tile types leave different marks; they fade over ~5s.
- Plants are measured OFFLINE by `build-manifest.mjs:plantsOf()` — reuses the
  sole/blob machinery: a grounded blob (size ≥6, maxY within 2px of the sole
  line) is a PLANT at frame `i` when NO grounded blob sits within ±6px x at
  frame `i-1` (cyclic) but one DOES at `i+1` (a real stance persists — this
  `i+1` check killed the 6-7/cycle over-detection down to the true ~2-4).
  Shipped as `plants: {walk|run: {dir: [{f, x, y}]}}` (frame-pixel coords) in
  characters.json. Both feet emit (a dir can list the same frame twice = both
  feet down, e.g. NW f1 left + f1 right).
- Runtime: WorldScene listens to `ANIMATION_UPDATE` per avatar sprite
  (`onPlantFrame`), parses the `f:<uid>:<state>:<dir>:<n>` texture key, and for
  each plant whose `f===n` converts the frame pixel to world coords THROUGH
  the sprite origin/scale — `wx = sprite.x + (px - originX·frameW)·scaleX`,
  `wy = sprite.y + (py+1 - originY·frameH)·scaleY` — so the mark lands under
  the DRAWN foot, not the body anchor. Surface = `surfaceFor(cell.t).sound` at
  the avatar's cell; swimming avatars leave none (water → ripples idea, TBD).
  Remote players stamp too.
- Style per SURFACES sound id + MATERIAL (`styleFor(sound, material)`): tints
  are chosen for CONTRAST, not to match — on a DARK ground the print reveals a
  lighter SUB-material so it reads regardless of ground type (maintainer). The
  SOUND is the default; a near-black material that shares a sound with lighter
  siblings OVERRIDES by name. Grass is dark → DIRT through the blades (`fs-pair`,
  ≈ `#9c7d4f`, from the `lightdark_dirt` tile). Ordinary `stone` keeps its dark
  scuff (`fs-dot`, `#141418` — reads fine on grey stone); only `black_mountain`
  (near-black) overrides to lighter STONE dust (≈ `#9a9aa0`). Sand/snow/ice sit
  on light ground so a darker/cool press reads. Marks draw below the night
  overlay, so they dim with the ground and the contrast holds at night. Stamps
  are foot-width (~7px) and short (iso ground is shallow-angle). Marks
  y-sort at depth `y-0.5`; pooled + capped (240, oldest recycles); peak alpha
  held ~2s then quadratic ease-out. Probes: `__ml.footprints()` (live count),
  `__ml.footprintsList()` (world pos + style), `__ml.myScreen()` (anchors QA
  crops). QA lands on flat `trans_demo` material bands (grass/dirt/stone/snow/
  ice) — headless GL starvation is fine here since marks are instant, not eased.

## Monsters (client rendering = the SHARED body pipeline)

- **Spawn placement is MAPS2 DATA** (maintainer 2026-07-29): every world ships
  `maps2/worlds/<name>/spawns.json` (`pixel-maps2/spawns@1`, spec
  `maps2/spec/SPAWNS.md`) — polygon zones `{id, monster (roster id), area,
  elev [min,max], num}`. The game's old hardcoded rectangles near the player
  spawn were fake debug areas and are DELETED. Pipeline: `shared/monsters.ts`
  parses + does the pure geometry (`parseSpawns`/`pointInZone` even-odd/
  `zonePolygonCells` centre-inside); `shared/buildZoneRuntimes(grid, zones)`
  resolves each zone against the terrain (a cell qualifies on whichever
  surface — base OR deck — has its level in the band and is enterable; a zone
  whose swimmable cells outnumber standable ones is a WATER zone → its
  monsters get `canSwim` and only such zones ever include water cells).
  WorldRoom seeds `num` per zone from the pre-validated cell list, roams via
  zone-cell targets within `MONSTER_ROAM_RADIUS_CELLS`, and snaps the rare
  polygon escapee back to the nearest zone cell. Missing spawns.json → no
  monsters (maps2 owns placement — nothing is invented). Zone bboxes are
  published as the `spawnAreas` debug rects. `build-monsters-manifest.mjs`
  resolves each monster's walk clip through `monsters/animation_map.json`
  (states + overrides — the old hardcoded walk→"jump" predates the 24-monster
  roster whose art has walk/idle/angry/attack/die). Shadow/anchor metrics are
  MEASURED from the walk art (next bullet). Gates:
  `server/test/monsters.sim.test.ts` (pure geometry + every shipped zone
  resolves incl. the_island2's layered cave/roof-deck case + headless roam
  confinement on real zones) and `monsters.test.ts` (live room: per-zone
  seeding, confinement, cross-client agreement). TODO (next): the 5-state
  brain (idle/angry/attack/walk/die) + per-monster display scale.
- **SOFT COLLISION v2 — RADIUS-AWARE** (maintainer 2026-07-30, two rounds:
  round 1 used ONE fixed comfort distance, 18wu — an 84wu-wide mammoth pair
  fully overlapped before the nudge even ACTIVATED; screenshot of two
  mammoths on one spot: "can't see monsters avoiding each other even the
  slightest"). Monsters stay OUT of the collision grid — no network or
  findPath cost — but every distance is now PER-BODY: the manifest emits an
  art-measured `radius` per kind (shadowW/2 ≈ half the footprint; horizontal
  iso px ≈ 1wu), the server loads it via `monsterRadii()` (reads the same
  monsters.json the client renders from, dist/ fallback), and the comfort
  target between bodies is `rA + rB + MONSTER_SEP_MARGIN`. Four server
  pieces in `stepMonsters` (all validated per-axis by `canEnterElev` AND
  zone membership so a push can't shove a monster off its polygon into the
  snap-back): (1) `separationPush` (shared, pure) — POSITIONAL relaxation of
  overlap, clamped to `MONSTER_SEP_RELAX_SPEED`·dt (firm shove, no
  teleports), exactly-stacked pairs split along an id-hashed `tieBreakAngle`;
  (2) PROACTIVE dodge — each monster's own autopilot input runs through the
  SAME shared `monsterDodge` against monsters AND players (per-monster
  hysteresis in `monsterDodgeStates`), so they arc around each other instead
  of colliding-then-relaxing, and they YIELD to an approaching player
  (measured live: a mammoth backed from 98→150wu as the player walked in);
  (3) radius-aware SEED spacing (pairs must not START stacked); (4)
  radius-aware roam-TARGET spacing in `pickMonsterTarget` (arriving on a
  neighbour just hands the mess back to separation). CLIENT `monsterDodge`
  is the same function with per-monster `r`: personal space = `r +
  PLAYER_BODY_RADIUS + MONSTER_DODGE_MARGIN` (donkey ≈28wu — double the old
  14; mammoth ≈57), lookahead `max(26, personal+20)`, probe `max(12,
  personal/2)`; near-filter box ±140wu (was 48 — must admit mammoth-scale
  lookahead). Deflected input is still what gets predicted AND sent (no
  rubber-band); a raw position push stays rejected (fights reconciliation).
  Measured live on monster_demo: worst same-pad pair of EVERY kind held
  ≥97% of its comfort target over 77 samples; player minD to a donkey
  27.3wu vs its 28wu target. Tests: radius-scaled dodge + separationPush
  suites (monsters.sim.test.ts), radius-fraction pad relax
  (monsters.test.ts reads the real manifest radii).
- **`separationPush` is the server's hot loop** (perf 2026-07-31): it runs once
  per monster against every body, so the_island2's 160 monsters do ~26k pair
  tests 20× a second. Profiled at **12.9% of the server's busy CPU** — the
  biggest game-logic cost after the roam loop itself. It now rejects on the
  SQUARED distance and takes `Math.sqrt` only for a pair that actually overlaps
  (a handful per tick): `Math.hypot` is a variadic with overflow/underflow
  guards and is ~16× more expensive here, and world-unit coordinates have no
  overflow risk. `d >= target` ⟺ `d² >= target²` for non-negative values, so
  the decisions are identical — verified against the previous implementation on
  the real 161-body the_island2 layout: **0 disagreements, worst push component
  delta 8.9e-16** (last-ulp float noise). Isolated: **1.483 → 0.0915 ms per
  tick (16.2×)**. End to end, alternating server runs with one client on
  the_island2: **~19.9% → ~16.8% of a core (−15%)**. If a future change needs a
  distance here, keep it squared — this loop is O(N²) in the monster count and
  is the first thing that will hurt when worlds get busier. (The real next step
  if it ever matters again is a broad-phase, not more micro-tuning.)
- **ART-MEASURED shadows + anchors, PER DIRECTION** (maintainer 2026-07-30,
  two rounds: RED=too big, GREEN=too small, BLUE="flying"; round 2 after the
  first fix STILL floated monsters: "a constant theme ... Why does it still
  look this bad?"). `build-monsters-manifest.mjs` fully decodes every WALK
  strip (`measureWalkArt`, pngjs). THE ROUND-1 MISTAKE, do not repeat it: ONE
  pooled anchor (p90 of all frames' bottoms ÷ pooled max height) is wrong
  three ways — (a) strips differ in height/margins PER DIRECTION after
  in-place art repairs, so one fraction floats whole directions (measured up
  to 9px: lava_salamander e/w; turtle e/w 5px); (b) ~90% of frames sit above
  a p90 line BY CONSTRUCTION, so hop/bob gaits (frog 12px, diablo 17px)
  float most of the cycle; (c) bodies drawn off-centre in the frame (saber
  diagonals 22px, turtle 6px) leave the frame-centred shadow beside the
  feet. The manifest therefore emits per (walk, DIRECTION) a `ground`
  contract: `{f, cx, contact, sink}`. ROUND 3 (maintainer red/green circles:
  "the center coordinate should be between the monsters feet (between the
  foot underside). Some monsters have 2 feets, some have 4 and some have
  0"): `f`/`cx` are the CONTACT CENTROID, not the lowest opaque row — in
  low-top-down art the FAR feet stand up to ~16px higher in the frame than
  the near toe (the four feet of a quadruped form a parallelogram on the
  ground plane), so a lowest-row anchor hugged the front feet and every
  body floated behind its shadow. On the planted contact frame (chosen as
  before: bottom-3-row contact width ≥ half the dir's widest — planted legs
  are wide, tail tips/toe push-offs are slivers; frame nearest the p65 of
  ground-frame bottoms): bottom-edge profile per column → contact columns
  are within T = clamp(11% of the dir's bodyW, 6, 17) of the deepest row
  (feet pairs IN — mammoth sw rear foot at depth 14-16; trunk tips at 20 and
  bellies at 20-30 OUT); runs <3px wide are dropped (tails), runs farther
  than 0.4·fw from the silhouette's mass-centre column are dropped
  (diablo_2's flame tendril touches the frame bottom a body-width from the
  rock). Anchor = kept-run extent midpoint (cx) × mean bottom row (f), then
  ROUND 4 (maintainer: residuals were small but MIXED-direction across
  screenshots = per-frame artifacts, and the demon stone "flew"): cx blends
  50% toward the silhouette's mass-centre column (capped 12% fw) —
  eccentric contacts (crouched cat paws, a biped whose far foot leaves the
  band, the leaning monolith) pull the shadow back under the body while
  symmetric quadrupeds stay put; `sink` = px the front toes plant BELOW the
  anchor. PER-FRAME drift compensation — the SAFE equivalent of the player
  art's nadir postprocess ("movement should be handled in the game and not
  in the animation"; a rewrite script "can easily destroy the animation",
  so the art is NEVER touched): per (dir, frame) the manifest emits
  `shift[]` (origin-x per frame from the body's mass-centre column, bounded
  to the contact band ±15% so flame/effect pixels can't jitter it, clamped
  ±12% fw — cancels baked horizontal translation, e.g. diablo_2 east slides
  14px across its cycle) and `air[]` (px the frame's deepest point rose vs
  the planted frame, 2px gait deadband, cap 24 — fed into placeBodyShadow's
  hop arg so the demon stone's levitation phase and the frog's leap
  shrink/fade their shadow: intentionally airborne, never misplaced;
  vertical bob is REAL animation and is never pinned). Tall figures (figH >
  bodyW: monoliths, upright golems) use bodyW·0.4 instead of 0.55 in the
  shadow-width blend — they ground through a compact base, and a
  mass-scaled ellipse read oversized. The client applies origin(cx,f) on
  EVERY facing change, per-frame `shift[frameIdx]` each tick, parks a
  paused monster on `contact` (frame-0 parking left frogs levitating
  mid-hop), and LIFTS the shadow ellipse `max(0, h/2 − sink − 2)` px so its
  SOUTH RIM kisses the toe line — centred on the anchor, half the ellipse
  poked past the toes and still read as "shadow way too low". ROUND 5
  (maintainer: "just continue iterate until you have fixed the shadows...
  compare and see if you are done before you give up"): (a) per-frame
  anchors are FEET-BASED (each frame's own contact analysis, 3px gait
  dead-band, mass only as airborne fallback) — mass tracking chased a
  stretching cat's HEAD while its planted feet stayed put; (b) the shadow
  ellipse is PER DIRECTION (`ground[dir].w/h`): an east mammoth's footprint
  spans ~140px, its south one ~85 — the body CLASS that picks the blend
  factor is MONSTER-level (widest facing vs median figure height; per-view
  classing shrank a south mammoth to 54px): LONG bodies (cats, turtles,
  salamanders, mammoths) cast 0.8×length side-on and 0.9×girth front-on,
  TALL lean-ers (monoliths, golems, donkeys) 0.4 + contact extent, else
  0.55; (c) the toe-kiss lift is CAPPED at the contact band's height
  (`up`+3) so a monolith's compact base keeps its ellipse ON the base.
  VERIFY WITH THE CONTACT SHEETS before shipping any shadow change:
  `node scripts/monster-contact-sheets.mjs [ids] [outDir]` renders EVERY
  (monster, direction, frame) tile with the exact client shadow maths +
  a red anchor crosshair — the maintainer's-eye view, offline, exhaustive.
  Round 5 was the first round verified this way (all 24 sheets) and the
  first whose numbers caught their own bugs before a deploy.
- **CONSTANT monster shadow size** (maintainer 2026-07-30: "each monster
  should have a constant shadow size (regardless of animation or direction)
  ... some sort of average, maybe a bit bigger, more fade to smear it out"):
  the builder still computes each facing's physical footprint width but only
  their MEAN survives — `shadowW = min(150, avg(per-dir widths) × 1.12)`,
  one ellipse per monster, so the shadow never resizes on turns or
  walk↔idle. Anchors stay per-direction/per-frame (position was never the
  complaint); the hop/levitation air-shrink stays (game-wide jump pattern).
  Client spread 1.35× with an extra-soft gradient (core 0.44 →
  0.39/0.27/0.14/0.05/0.015 → 0).
- **DIFFUSE monster shadows** (maintainer 2026-07-30, closing the shadow
  arc): "when you draw a sharp shadow, it must be spot on to look good. A
  more diffuse shadow is less sensitive." Monsters render their own
  `monster:shadow` texture (`ensureMonsterShadowTexture`, 128×52 = 2× the
  avatar texture's resolution so a 139px mammoth ellipse upscales cleanly):
  core alpha 0.5 (was 0.62) decaying smoothly 0.44→0.30→0.15→0.05→0 instead
  of holding 0.42 to 65% radius and then cliffing, and drawn at
  `MONSTER_SHADOW_SPREAD` 1.25× the measured footprint so the soft tail
  falls outside the contact patch while the visible core still matches it.
  Result: the rim reads as penumbra, so a few px of anchor error stops being
  visible — deliberately trading precision-sensitivity for robustness as new
  monsters arrive. The PLAYER keeps the sharp `avatar:shadow` (its nadir is
  postprocessed in the art and is spot-on). First attempt at core 0.34 +
  1.3× spread was too weak — the grounding cue nearly vanished on mid-tone
  ground; 0.5/1.25 keeps it present. A/B tooling: scripts-free
  `style-ab`-style render (identical pose, only the gradient differs) is the
  fastest way to judge a shadow-style change; in-game A/B is unreliable
  because monsters roam between the two captures. footW = the contact-run extent (the feet
  span, e.g. mammoth ~123px across all four legs); shadow `w =
  clamp(max(footW, bodyW·0.55)·1.05, 12, 150)`, `h = max(6, 0.385·w)`,
  emitted as `shadowW/shadowH` — NEVER frameW-scaled. Collision `radius =
  min(60, 0.45·shadowW)` (a footprint-spanning shadow must not double
  gameplay distances). `stripDims` (TRUE per-strip frame size from IHDR) slices
  every spritesheet — monster.json `size` goes stale on in-place repairs (8+
  wrong, frog 34×34 claimed vs 34×42 real) and frames bleed. `hoverPx`
  (builder `HOVER_PX`) marks INTENTIONAL winged flyers (butterfly_dragon 12):
  sprite lifts, `placeBodyShadow` gets it as air height (shadow stays on the
  ground, shrinks — the bird pattern); everyone else is pinned. QA probe:
  `__ml.monsterInfo()` → originX/originY, ground (current dir), frame,
  radius, hover, shadow{w,h}, playing.
- **IDLE STATE + STOP-SHAKE** (maintainer 2026-07-30): stopped monsters PLAY
  their resolved IDLE clip (animation_map `idle`, validated against the art;
  the legacy porings have none and park on the walk contact frame). Idle
  strips are framed INDEPENDENTLY of walk — the manifest measures them
  separately (`idleAnim` + `groundIdle` per dir, same contract as `ground`)
  and the client picks the ACTIVE state's map for origin/shift/air/shadow
  dims every tick. The stop-shake ("switching direction back and forth like
  crazy ... when they have walked for a bit and stops") had two layers:
  SERVER — near a roam target the separation push jiggles position every
  tick, the 8-way bearing flips sectors and the autopilot thrashed its full
  1.5s stall window; monsters now arrive GENEROUSLY (< 0.75 cell of the
  target = done — roam targets are arbitrary cells). CLIENT — monster
  `stableDir` runs EVERY turn size through the 160ms persistence
  (`allTurns`), not just 45° ones: monsters are remote puppets, facing lag
  is invisible, and 180° per-tick thrash becomes structurally impossible
  (players keep instant large turns for input feel). QA probe: 25s room
  sweep — all 24 kinds sampled playing idle when stopped, zero frozen,
  worst flip rate 0.76/s.
- **GAIT SYNC — the walk clip is paced by DISTANCE, not by time** (maintainer
  2026-08-05: monsters "either jump or the walk forward animation is limping
  forward … adjust the position/velocity at certain times to sync with the
  animation"). A monster's speed spans **42 wu/s roaming → 105 chasing → up
  to 220 in a provoked hunt**, but every walk clip used to play ONE fixed
  rate picked from the frame count alone (6 fps at ≤6 frames, 10 above), so
  the feet could only track the ground at a single speed — measured, the old
  rate was off by 0.30× (mammoth: legs churning 3.3× faster than the ground
  moved) to 2.49× (hedgehog, skating) at ROAM, and 0.76×–6.22× at chase.
  Now: `fps = frames × speed / gait.cycleWu`, so one cycle completes per
  `cycleWu` of ground however fast the body is going.
  - `gait.cycleWu` is emitted per kind by `build-monsters-manifest.mjs`,
    derived from the art-measured body length (`0.9 × bodyW`, clamped
    26–92wu). **Do NOT try to measure it from the art's foot excursion** —
    that was tried and it does not work: the leading-contact swing is 1px on
    a poring and 18px on a saber-tooth, uncorrelated with size, because half
    the roster has no visible legs (blobs, monoliths, the tree stump). Body
    length is the one signal every kind has, and stride ∝ body size is the
    real biomechanics.
  - The rate is clamped to **3–26 fps**: a mammoth may pace slowly but must
    never freeze mid-stride, and a hunter sprinting at 195 wu/s would
    otherwise demand ~108 fps of a 16-frame clip. When a clamp binds the
    body does skate — that is the art's frame budget, not a bug, and the
    gate only asserts cadence-true playback where the clamps are slack.
  - Speed is measured from the body's OWN DRAWN motion (the eased screen
    delta back-projected to world units, exactly like the player's `spdWu`),
    so easing, water, the flee-slow and chases all pace continuously. The
    same measurement yields `scrPerWu`, the local iso scale along the current
    heading — which converts world-unit gait maths back to screen px free.
  - **HOP TRAVEL** for kinds that genuinely leap: `gait.travel[]`, per-frame
    ground-track weights (mean 1), integrated into a mean-zero lead/lag along
    the heading so a frog covers its ground DURING the leap and stands still
    while it gathers, instead of gliding evenly through a hop it is visibly
    not making. Measured by the body's vertical MASS CENTROID rise over the
    cycle ÷ figure height — **not** `air[]`, which under-reports a leap badly
    because a frog's legs DANGLE and keep its lowest pixel low. Only kinds
    over 15% rise ship a profile: water_poring .31, mystical_frog .27,
    diablo .21; everything else is ≤ .12 and glides evenly, as before.
    The offset is applied to the DRAWN anchor (sprite + shadow + lit copy),
    never to `mv.lx` — that IS the ease state and would absorb the surge —
    so it can never drift the body off its server position.
  - TRAP, paid for once: Phaser's `timeScale` lives on the sprite's
    ANIMATION STATE, not on the clip, so it survives every `play()`. Without
    an explicit reset at the top of `playMonsterAnim`, a monster that broke
    off a 3.5× chase swung, raged and DIED at 3.5× too.
  - Gate: `scripts/verify-monstergait.mjs` (dev stack) — every kind ships a
    measured stride, every sampled kind completes one cycle per that stride,
    the cadence measurably rises when a monster starts hunting, combat clips
    keep their authored rate, and the hop weights stay mean-1. Probes:
    `__ml.monsterGait()` (live speed/base fps/timeScale/effective fps/
    wuPerCycle/hopOff per body) and `__ml.monsterDefs()` (the manifest gait).
- **CAMERA GATE on the body pipeline** (perf, 2026-07-31): the_island2 ships
  **160 monsters** and every one of them used to run the full shared body
  pipeline EVERY FRAME regardless of where the camera was — stableDir + anim
  play, per-frame origin/`shift`, occluder-aware `resolveBodyDepth` (a ray
  test), `placeBodyShadow`, and a `syncLitCopy` that samples the CPU light AND
  the depth fog — plus three Phaser draws each (sprite + shadow + lit copy).
  Now a monster is ACTIVE only while its ART BOX (sprite bounds unioned with
  the — often wider — shadow ellipse) can touch `cameras.main.worldView` grown
  by `MONSTER_CULL_SLACK` (64px of pure hysteresis, so a body idling on the rim
  can't flicker). A culled body is hidden, its `lit` hidden, and its anims
  PAUSED (Phaser's UpdateList advances clips on invisible sprites too). What
  culling must NOT break, and doesn't: (a) the position still tracks the server
  every frame — the player's input-dodge reads `fx/fy` for EVERY monster, and
  culled bodies SNAP (easing off-screen is invisible work, and snapping means a
  monster re-enters the view already where it belongs instead of sliding in
  from a stale spot); (b) un-culling restores everything the same frame —
  `resolveBodyDepth` runs in the monster loop, `syncLitCopy` later in the same
  update. Measured on the_island2 at 480×320: monster pipeline self-time
  **1,587 → 160 µs/frame (−90%)** with 3 of 160 active, and Phaser's
  `batchSprite` 1,293 → 693 µs/frame. Probe `__ml.monsterGate()` AUDITS the
  decision against Phaser's own `getBounds()` × the camera's own `worldView`,
  NOT against the gate's own arithmetic (a wrong formula can't agree with
  itself): `wrongCulled` — a body that would have been drawn but was parked —
  is the only number that can be a bug and must be 0 (measured 0 across 160
  samples: 10 spots standing still at 480×320, plus 100 samples at the
  maintainer's 393×851 mobile geometry WHILE RUNNING in all four directions,
  which is when the chase trail + speed zoom-out move the view every frame).
  `wastedActive` is the harmless direction. `monsterInfo()` carries `culled` so
  QA skips parked bodies — their `playing`/`depth`/`lit` are deliberately
  stale. Gate: the monster block of `verify-smoke.mjs` asserts the invariants
  AND that culling REVERSES (pan away → those bodies drop out; pan back → the
  same ids are active and animating again) — a gate that never re-opens would
  strand every monster invisible.
- **Zone DEBUG overlay** — Settings switch "spawn areas", **OFF by default**
  (maintainer 2026-07-30) and persisted in `ml-spawn-areas`. It draws each
  zone's REAL POLYGON, lazy-fetched from the world's `spawns.json` the first
  time it's switched on (zero cost while off) — NOT the bbox the server syncs:
  zones are concave and sprawl across a habitat, so a bbox describes a
  different region entirely (monster_demo's 5×5 pads are the one case where
  the two coincide). Corners go through `projectZoneCorner`, NOT
  `project()`/`projectFlat()`: those append the CHARACTER GROUND ANCHOR
  (+tile/2, +dy) — the cell-diamond CENTRE a body standing in the cell is
  drawn at — so feeding them spawns@1 TILE-CORNER vertices drew the outline a
  half-cell (dy = 15px) down-screen of the zone it describes (maps agent
  report + maintainer screenshot). A corner is horizontally centred in the
  tile (+tile/2 stays) but sits at the diamond's TOP vertex, dy ABOVE that
  centre — hence no +dy. Verified by flood-filling monster_demo's 5×5 sand
  pad: a 640×296px blob (geometric 640×300) whose top vertex extrapolates to
  y≈107 vs 98 predicted — the ~4 world-px residual is the documented art inset
  ("tile edges are drawn slightly inside their geometric diamond", see
  artLift) — where the OLD code predicted 128, a full half-cell low. Probe:
  `__ml.spawnOverlay(on?)` → `{on, zones, corner(c,r)}`.
- **The spawn BONFIRE** (`placeCampfire`) is the gathering spot and the "you
  are home" landmark, anchored to the world's DECLARED spawn (`world.json`
  `spawn` — the same cell the server's `placeAtSpawn` scatters arrivals
  around). It used to look at the world CENTRE, but EVERY maps2 world declares
  a spawn far from its middle (the_island2 95 cells away, trans_demo 195), so
  the fire burned alone in unrelated terrain on every map (maintainer
  2026-07-30). Now 1.6-2.6 cells from spawn everywhere. Probe:
  `__ml.campfireInfo()` → `{col, row, z, spawn, distCells}`.
- Server-authoritative roamers (`WorldRoom` monsters, poring family). The
  client's `MonsterAvatar` renders through the SAME battle-tested body
  pipeline as players — `resolveBodyDepth` (occluder-aware depth: ray test,
  face-over-feet band, solid-art cover → sets depth + `coverY`),
  `placeBodyShadow` (landing-ground shadow, air-shrink while falling) and
  `syncLitCopy` (lit copy above the night overlay, tinted by the CPU light at
  the body's OWN surface height, cropped below `coverY`) — all operate on the
  structural `BodyVisual` subset both Avatar and MonsterAvatar satisfy. Never
  hand-roll a second depth/shadow/lighting path for a new entity type: the
  first monster cut used a naive painter depth + no lit copy and shipped with
  terrace tiles drawn over monsters, detached shadows and no light response
  (maintainer screenshots 2026-07-29). Shadow ellipse size is parameterized
  (avatar 34×14; monsters pass their art-measured size — see the
  ART-MEASURED bullet). Probe: `__ml.monsterInfo()` (per monster: depth,
  coverY, originY, hover, shadow anchor/size/depth, lit visible+tint).

## Combat, items & progression (RO-flavoured; maintainer 2026-07-31)

- **The player state OWNS level/xp/hp/hpMax/ep/epMax** (Player schema, synced;
  ep is reserved — no skill spends it yet). Curves + every number both sides
  must agree on live in `shared/src/combat.ts` (xpToNext, hpMaxFor, damageRoll,
  unarmedClip, the slow window, chase/orbit/drop constants). Progression +
  inventory PERSIST by token (store.ts); the backpack is PRIVATE — targeted
  "inv" messages, never schema. PERSISTENCE SHAPE (review 2026-08-05):
  position is per-world (`.data/players-<world>.json`) but progression +
  backpack are WORLD-AGNOSTIC — one shared `.data/players-progress.json`
  (store.ts progressStore(); old per-world progression seeds it once, lazily).
  Both stores DEEP-COPY at load/save — a live Player.inv aliasing the store
  record silently corrupted saves. One live session per token: a second join
  (two tabs, one localStorage token) kicks the older session and takes over
  the LIVE progression — two sessions on one record dup/eat items on
  last-writer-wins saves. savePlayer flushes on leave, death, level-up and a
  30s room timer, so a crash costs seconds, not the session.
- **Tap a monster to engage** (RO): the client autopilots into radius-aware
  reach (attackRange = rA+rB+12), then the SERVER drives the swing loop while
  the target lives, stays in reach (×1.2 grace for the circling drift) and the
  player stands still — any movement input breaks the fight. No weapons yet:
  each swing's clip is kick or punch, pseudo-random but DETERMINISTIC from the
  synced actionSeq + an id salt (shared unarmedClip) so every client shows the
  same move. Signals: Player.action/actionSeq (one-shots: attack/pickup/die),
  hitSeq (hurt flinch + damage float), dead (die clip holds → respawn snap).
- **Monster brain states** (Monster.mstate, server-only fields beside it):
  roam (the shipped wander) → chase → combat → die. PASSIVE BY DEFAULT: the
  tuning default aggro_radius_wu is 0 — everything retaliates when hit; only
  predators (saber/night_beast/diablos/snow_demon/salamanders/masked/malformed,
  64-96wu after round 2's "smaller" pass) proximity-aggro (~2 scans/s). A
  SWORD-MARKED monster (a player's engage target) also aggros when that player
  closes inside max(its radius, PROVOKE_RADIUS 4 cells) — raising your sword
  IS the provocation, passive kinds included; `player.target` persists while
  MOVING now (swings still require standing), which is what the approach scan
  reads. Monster.level + Monster.aggro are synced (target frame + debug rings).
- **ESCAPE MATH, round 2 (maintainer 2026-08-05) — two chase kinds** via the
  server-only `m.provoked` flag: UNPROVOKED (a predator noticed you) chases at
  the constant 105 — an innocent full run (175) always pulls clear, a
  hit-slowed one (96) does not. PROVOKED (retaliation or the sword mark — YOU
  started it) is personal: chase speed = provokedChaseSpeed(victim's current
  possible speed) — always ~12% above whatever the victim can do right now
  (floor 60 closes on a stander), so running never opens the gap; AND the
  victim carries the persistent FLEE_SLOW_FACTOR 0.8 for the whole hunt (the
  synced `slow` = min(hit-slow 0.55/1.5s, flee 0.8) — the client predicts from
  the synced field, pending inputs carry their factor). The way OUT is the
  RUN-AWAY LINE: ESCAPE_RADIUS_WU **390 ≈ 0.75 of a screen** (camera frames
  ~520wu, zoomFor) beyond the home ZONE bbox — crossing it makes the hunter
  give up, walk home (m.returning, aggro-scan suppressed), and the flee slow
  lifts. DE-AGGRO BY DISTANCE (round 9) is its own rule on top: ANY hunt —
  predator or provoked — ends the moment the victim is more than
  ESCAPE_RADIUS_WU from THE MONSTER. The leash box alone could not promise
  that, because it is measured from the home ZONE and a big zone's bbox is
  most of the map; a predator that noticed you at its edge would follow far
  past any sane point. combat.review.test.ts proves it on an unprovoked
  saber-tooth. HALVED from 780 (2026-08-06: "aggro monster chase the player
  for too long … cut in half"), and BOTH uses had to halve for that to be
  felt — a provoked hunter paces its victim, so the gap never opens by
  running; it opens when the monster stops at its LEASH, and shortening only
  the give-up distance would barely change how long a hunt lasts. The floor
  on this constant is the PROVOKE radius (128wu): drop it near that and a
  marked monster aggros and gives up in the same breath instead of committing
  — combat.unit.test.ts pins both the screen fraction and that margin.
  IN-FIGHT CIRCLING, rounds 4-6 ("more like a boxing fight"): BOTH bodies
  strafe tangentially with the same rotational sense (ORBIT_SPEED 6 — the
  maintainer slowed it twice) — the monster holds ~0.88 reach radially (pad
  16: the pair fights a bit farther apart), the standing engaged player is
  drifted by the SERVER around its opponent — with the OPPOSITE tangential
  formula: same-formula-on-mirrored-radius made them strafe in parallel
  (round-5 bug) (stepCombat; ground-validated, never into water,
  moving stays false so the stance is the fight idle — and the client needs
  NO prediction: with no input pending its predicted position IS the synced
  one, the render ease glides the 20Hz steps). Handedness starts id-hashed
  and RARELY flips (exponential, ~ORBIT_FLIP_MEAN_S 60s while circling).
  Facing tracks the opponent on both sides, so attack/angry directions sweep.
  ENGAGING SHOWS THE SWORD, NEVER THE BEACON: monster taps and chase repaths
  pass showMarker=false to setMoveTarget — ground taps keep the beacon and
  never the sword (maintainer round 4).
  THE GIVE-UP IS THE REJECTED STEP: chase movement is leash-gated (withinLeash
  = zone bbox + ESCAPE_RADIUS), so the monster reaches the rim but never
  crosses it — a "give up when beyond the leash" position check is provably
  dead code (pre-deploy review 2026-08-05: every fight-and-flee wedged a
  monster at the rim in chase, forever). A chase ends when (a) its contained()
  step is rejected at the rim, or (b) the victim is past the line AND out of
  reach (covers a chaser wall-wedged INSIDE the box). combat.review.test.ts
  kites a frog, asserts the give-up, the approach-provocation and the slow
  lifting on escape.
- **The two TARGET MARKERS** (rounds 2-11). Neither coexists with the walk-to
  beacon: monster taps, chase repaths and item walk-tos all pass
  showMarker=false to setMoveTarget — the ground beacon is for plain ground
  taps only. Both markers are BORDERS built from the marked body's own
  silhouette — a GENERATED outline texture per (strip, frame, palette):
  ringTextureFor reads the frame's alpha into a RING_PAD(2)px-padded canvas
  and grows a 2px TWO-TONE border (round 11) — the INNER line in the base
  colour, the OUTER line a step brighter — each line one 4-NEIGHBOUR
  dilation. SIDES ONLY, never diagonals: side-dilation leaves single
  diagonally-touching pixels across the art's diagonal steps, the thin
  connected border pixel art itself outlines with — round 10 killed the
  original 8-offset-silhouette-copies approach because dilating diagonally
  too doubled the border at every step and it read THICK. Drawn at depth
  ~900_001.44-.45 (above the darkness overlay and every lit copy, below the
  hp bar) at FULL alpha whatever the hour — the mark is UI and
  lighting/shadow/fog never touch it (round 9 matched the body's
  layer+alpha, which dimmed the red with the world; an outline has no
  interior, so nothing bleeds through the body). RED (0x8e2222 inner /
  0xb83a3a outer) marks MONSTERS — the one you clicked for the ENTIRE fight
  (round 11; it used to hide when battle began) AND every monster currently
  hunting YOU: Monster.tsid (synced, mirrored each tick from the server-only
  targetSid while mstate is chase/combat, "" otherwise) — one ring image per
  bordered monster in WorldScene.monsterRings, destroyed when the monster
  leaves. LIGHT-LIGHT-BLUE (0x9adcf0 inner / 0xc4ecfa outer) marks the
  GROUND ITEM being fetched — a tap on it or PICK UP/F's nearest target —
  until it is picked up; it REPLACED the round-8/9 hand icon
  (ui2/icon-pickup-target.webp deleted; the item itself stays an ordinary
  world-layer drop, shadow and night dimming untouched). Three traps paid
  for in screenshots: position from the LIVE sprite, never from `mv.lit` —
  lit copies sync later in the frame, so a hopping monster smeared the ring
  sideways; shift the origin by the pad ((originX·fw+RING_PAD)/(fw+2·
  RING_PAD)) so the outline tracks the per-frame walk shift[]; and set the
  canvas texture's filter to NEAREST explicitly — addCanvas does not inherit
  pixelArt's default, and LINEAR smears the thin lines into a soft halo at
  fractional camera zoom (measured: zero exact-tint pixels on screen).
  Probes: `__ml.ringInfo()` (per-monster + item outline state),
  targetOverlay().rings/itemRing/itemRingTint. TAP HITBOXES ARE FINGER-
  SIZED, not art-sized (round 12: "constantly miss clicking", explicitly
  incl. sprigling-class small bodies — sprigling = lore's name for
  forest_poring_2): tapTarget grows every box by a pad and clamps to
  minimums (drops ±26px, was ±16; monsters half-width max(26, dw·0.5+6)
  and ≥48px tall with −8/+10 vertical pads), and when fat boxes overlap
  the CLOSEST candidate wins, so generosity never selects the wrong body —
  a matching drop still beats any monster box lying across it. Probe:
  `__ml.tapAt(wx,wy)` (the exact pointerdown hit test; monsterInfo sx/sy/
  dw/dh/lx and dropsList sx/sy carry the drawn-sprite coords to aim with).
  (The retired marker art —
  the sword icons of rounds 2-8 and the round-8/9 pick-up hand — lives in
  git history.) The in-fight readout lives ON
  the monster (maintainer: keep it SMALL — he rejected a separate top-centre
  frame): updateMonsterHpBar draws a slim player-style bar (76×6 dark track,
  red fill) in a THREE-LINE stack (2026-08-05) — the monster's NAME
  left-aligned OVER the bar, then the bar, then "Lv N" left-aligned and
  "hp/max" right-aligned UNDER it, sharing one line with a middle gap that
  survives 4-digit HP (what the bar's width is sized for). All three hang off
  the BAR's own edges, so the lines share a left margin and the stack stays
  centred on the body. Rounds 5-9 had Lv/hp ON the bar's line and NO name —
  the name is the maintainer's later call, and it needed that line freed.
  The name is the ROSTER's display name (monsters.json `name` — "Dewling",
  not forest_poring), resolved ONCE in addMonster onto mv.label: this runs
  per monster per frame, and a manifest scan here would be 24 finds × 160
  monsters × 60fps. Shown while wounded, in combat, or my engaged target. Bar, texts and the target
  borders live ABOVE the darkness overlay (depths 900_001.44-1.9 — under the
  damage floats at 900_002), so day/night/shadow never touch them — combat
  UI at 890k was dimming with the world. When adding HUD chrome NEVER reuse
  .ml-bars/.ml-bar-row classes — verify-bars counts them (2 chips, 3 rows).
  The "aggro radius" settings switch (debug, off by default, ml-aggro-radius
  in localStorage) draws each monster's synced radius as a projectFlat-
  sampled ring (red; gold provoke ring on the marked target).
- **WATER IS A PLAYER SANCTUARY** (maintainer 2026-08-05: "no monster can
  enter/go on water … the player can always use the water to escape/hide").
  Enforced at every layer: buildZoneRuntimes never returns swim cells
  (canSwim is always false — a PURE-water zone polygon adopts its SHORE, the
  nearest standable ring, so pond kinds live at the water's edge instead of
  dying out); monster roam/chase/orbit/separation contexts and both monster
  startTrip call sites route with canSwim false; a SWIMMING victim instantly
  disengages its hunter (reaching water IS the escape) and swimmers can
  neither swing nor provoke (no water-sniping from the sanctuary — cuts both
  ways). Players keep canSwim true everywhere.
- **Monster combat clips**: attack/angry/die strips (525 files, ~3.1MB)
  background-load in the SAME deferred batch as the player's action states —
  boot stays walk+idle (the loading-time work must not regress). The COMPLETE
  handler re-runs buildMonsterAnimations (the single-call-site trap: a late
  texture never registers a clip by itself). attack/die are once-through (die
  paced to MONSTER_DIE_MS so the clip and the server's corpse sweep agree);
  angry loops between swings; 6 kinds ship NO angry (forest_poring x2,
  lava_poring, ice_crystal_golem, diablo x2) and park on the walk contact frame
  instead — anims.exists guards make every gap degrade to the parked pose.
  `combatClip` gates the per-frame walk drift compensation: shift[]/air[] are
  measured on walk/idle strips and must never be indexed by an attack frame.
  Corpses: the schema entry lingers MONSTER_DIE_MS, then the client fades the
  detached sprite 450ms on onRemove. Small hp bar floats over a WOUNDED
  monster only (890_000 depth, culled with the body).
- **Loot**: on the corpse sweep the tuning loot table rolls per entry
  (rollDrops, deterministic from id+diedAt). PLACEMENT (round 2, maintainer:
  "close and not on top of each other") is a pseudo-random scatter around the
  corpse/player that keeps DROP_SPACING_WU 24 from items already lying there
  (candidates scored by nearest-drop distance, the ring grows as the ground
  crowds, best-spaced wins when nothing clears; the ring STARTS ~21wu out so
  loot never covers the grave cross rising at the death spot) — deck-aware
  (the dropper's elev threads through spawnDrop so a bridge drop stays ON
  the deck), last resort ring-scans the nearest standable cell; only
  open-water corpses keep their spot, where swimmers can grab. GroundItems sync in state.drops,
  despawn after DROP_TTL 60s; the last DROP_FLASH 5s the client flashes them
  transparent FASTER AND FASTER (2→10Hz, timed from the witnessed onAdd —
  join-inherited drops restart the clock, the server sweep stays the truth).
  Freshly witnessed drops TOSS UP a few px and bounce to rest (subtle; the
  join flood lands silent). THE GRAVE CROSS (objects/grave_cross — the
  maintainer's PixelLab object, synced 2026-08-05 with config pin + README
  note in objects/): when the corpse fades, the 16-frame SOUTH "appear" clip
  rises at the death spot alongside the loot, HOLDS its last frame, and
  after a minute plays REVERSED — sinking away. Client-local decor driven by
  the synced die state; `graveCrosses()` probe + verify-combat assert it.
  A player grabbing an item TURNS TO it: predicted locally (pendingPickup
  facing) and synced for everyone (the pickup handler faces the drop).
  **THE GRAB LANDS ON THE ITEM** (maintainer 2026-08-06: walk so "the hand in
  the pick up animation is as close as possible … looking like it actually
  picks up that exact item", and the item must vanish "the exact frame the
  hand is closest to the ground"). THE ART ANSWERS BOTH QUESTIONS ITSELF: the
  pickup clip DRAWS a little item lying on the ground in front of the
  character, the hand comes down, and it disappears from the ground on the
  frame it is grabbed (re-appearing in the hands a frame or two later).
  `build-manifest.mjs grabOf` measures that per direction into `grab[dir] =
  {f, x, y}`: the drawn item's offset from the FOOT ANCHOR (frame fractions)
  and the frame it vanishes. Every candidate blob is VALIDATED before it is
  believed — it must lie at/below the foot line and on the side the character
  faces — because a late frame splits off the hair or the item already held,
  and the naive "lowest detached blob" put north's target 24px out to the
  side. SOUTH and NORTH draw the item merged into the body silhouette (the
  character is face-on/back-on), so those two are interpolated from their
  neighbours and flagged `approx` — never invented. Runtime:
  `grabStandSpot` back-projects the offset into world units and, since we get
  to choose the FACING, tries all eight and takes the stand spot that is the
  shortest walk from here; `walkToGrab` sends the autopilot THERE instead of
  at the item, and driveCombatIntent holds the grab until the body is within
  GRAB_ALIGN_WU of it (falling through the moment the trip ends, so a blocked
  path still picks up rather than standing there forever). THE ITEM OUTLIVES
  ITS OWN REMOVAL: the server deletes the drop the instant it validates the
  pickup, which is ~half a gesture EARLIER than the hand arrives, so the loot
  used to blink out while the character was still bending down. `removeDrop`
  now parks MY pickup's drop and `stepGroundDecor` retires it on the measured
  grab frame (or when the clip ends / a 1.2s valve, so an interrupted gesture
  cannot strand a phantom item). Two traps paid for: the drop's removal and
  the player's `action` field arrive in the SAME state patch and the removal
  listener runs FIRST, so requiring a live pickup clip made the deferral never
  engage at all; and character frames are PER-FRAME TEXTURES keyed
  `f:<uid>:<state>:<dir>:<n>` (only monsters use numbered spritesheet frames),
  so the frame index must come from the texture key — parsing `frame.name`
  pinned every read at 0 and the clip always ran to its end. Gate:
  `scripts/verify-pickup.mjs`; probe `__ml.grabInfo()` (stand spot, how far
  off the body is, and the client-recorded retirement — polling from outside
  cannot resolve a ~77ms animation frame).
  Item sprites are uniform `items/<id>/sprite.webp` 48×48
  (verified across all 105) — the client lazy-loads per KIND, no manifest
  fetch. TAP an item to fetch it (walk + grab), or the PICKUP button beside
  jump / the F key (nearest within 5 cells; the gamepad button synthesizes F
  exactly like jump→SPACE). Server validates PICKUP_RADIUS_WU + the elev
  band; the client's pickup intent RETRIES (~400ms) until the drop vanishes
  or 6s pass — a single fire-and-forget send loses the predicted-vs-server
  position race on laggy links. BACKPACK (hud.ts): server-owned slots render
  in the 5-col grid; DRAG a slot out over the game view to drop it —
  pointer-captured ghost (the bird-slider pattern; Phaser never sees the
  gesture); the release point only means "onto the ground" — the server
  ALWAYS scatters near the player, verifies the ITEM ID (slot indices go
  stale in flight when a stack empties) and rate-caps pickup/drop at 150ms.
  An "inv" refresh mid-drag cancels the gesture (renderInventory would
  orphan the ghost). INV_MAX_SLOTS 30, stacks of 99.
- **HOW MANY — the drop dialog** (maintainer 2026-08-05, three refinement
  rounds the same day). Every filled slot badges its count in the lower-right
  corner, **×1 included**; every drag-out then opens a card centred in the
  GAME VIEW — a stack asks how many, a lone item is the plain confirm ("this
  dialog acts as a nice confirm dialog"). ONE row: item + a TYPABLE count box
  + "of N" hugging the LEFT edge, **−** and **+** together on the RIGHT; a
  full-width **DROP** word underneath. The box is `inputMode numeric`, CLEARS
  ON FOCUS (type the number you want, never "delete the 1 first"), and junk
  or an out-of-range value leaves the amount exactly as it was — blur
  repaints from it. No cancel button and no max button — tapping OUTSIDE the
  card closes it, and −/+ WRAP AROUND, so one tap on − from ×1 is "all of
  them". The backdrop is `rgba(0,0,0,.5)` — DARKENING in both themes (a
  `color-mix` of the theme's own `--bg` brightened the light theme, which
  read as the dialog lighting the room). The card is absolutely placed off
  `--gv-left/--gv-right/--hud-h`: horizontally centred in the game view,
  vertically at **45%** of its height (**40%** in landscape, where the view is
  ~393px tall and the keyboard eats a bigger share). That step up is the whole
  number-keyboard story — it keeps the box above the keys in both
  orientations WITHOUT the card moving when they open (a `.ml-kb-up` lift was
  tried first and rejected: a dialog that jumps out from under your finger is
  worse than the few px it buys, so the drop dialog's box deliberately does
  NOT register with mountChatKeyboardLift). MOVEMENT IS FROZEN while
  it's open, and the halves are worth knowing because the obvious one is a
  LIE: a DOM overlay does NOT keep pointers away from Phaser. Its
  window-level listeners deliberately process events whose target is not the
  canvas (TouchManager.onTouchStartWindow), so a tap on the backdrop reached
  the world's tap-to-move and CANCELLING A DROP RAN THE PLAYER TO WHERE YOU
  TAPPED (maintainer 2026-08-05). So: `HudActions.onUiLock` disables Phaser's
  keyboard (which the analog stick synthesizes into), resets held keys, drops
  any trip or hold in flight, AND sets `uiLocked` — the scene's pointerdown
  returns early while a modal is up. The lock LIFTS 150ms LATE (uiLockLiftAt),
  because the tap that closes the dialog is still being dispatched: the DOM
  handler that closes it runs before Phaser's window listener sees the same
  event. Belt and braces, the backdrop also preventDefault()s its OWN events
  (never the card's — that would eat the buttons' clicks on touch), which
  Phaser skips. SERVER: `"drop"` takes an `n`, clamped to `1..entry.n` — a
  client can never drop what it does not hold — and the 150ms item cadence is
  charged PER ITEM (+20ms each) so one tap can't put a 99-stack on the ground
  6.7×/s. Gates: `scripts/verify-dropqty.mjs` (badges, both orientations, the
  wrap-around, typed junk, the movement lock) + the clamp test in
  `server/test/combat.review.test.ts`. QA probe `__ml.invFake(items)` paints a
  backpack locally (the server never hands out a ×3 on demand);
  `__ml.canWalk()` reports the movement gate.
- **LEVELLING UP — "Thunderclap"** (maintainer 2026-08-06, chosen from a page
  of eleven alternatives and tuned on it: "the level up graphics is perfect! I
  love it! Now get it into the game!"). It lives entirely in `bars.ts` and runs
  off `setLevel()` — the level going up IS the event, so no scene wiring, no
  message, nothing to keep in sync. The gauge climbs to full on the level you
  just FINISHED, then three effects peak on ONE frame (the fill flashes
  brightness 1.95, the chip recoils, the LEVEL number stamps down from ×2)
  while a shockwave ring is thrown off the chip and a light sweeps the track —
  then a beat, and the bar drains to the carry-over. What the game has to add
  on top of the approved page, because the SERVER NEVER SENDS THE FULL BAR:
  a level-up arrives as one sync carrying the NEW level and the carry-over xp,
  and WorldScene pushes `setBar("xp", …)` BEFORE `setLevel()`, so by the time
  the animation knows it is happening the frame it must start from is gone.
  setBar therefore remembers the fraction and requirement it is overwriting,
  and the animation replays from there — nothing has painted in between, so
  the jump is never seen. Same reason the LEVEL label is held on the old
  number until the stamp lands. While it runs it OWNS the gauge (a kill
  mid-animation still drains onto the newest sync), a watchdog hands the
  gauge back if a backgrounded tab freezes rAF, and reduced motion just lands
  the values. No sound — that is the audio agent's, and only when asked for.
  Gate: `scripts/verify-levelup.mjs`. QA probe `__mlBars` (its own namespace,
  since WorldScene assigns `__ml` wholesale): `levelUp(carry, need)` fakes
  exactly the pair of calls a real one arrives as, `state()` reports the label,
  the numbers, the fill and each punch's live transform.
- **Monster stats come from the LIVE TUNING channel** — the wiki agent's
  document (live/tuning/monsters.json, format @1), adopted exactly as they
  requested: server/src/tuning.ts resolves live doc <- baked file <- builtin.
  CAREFUL: liveTuning() serves an EMPTY-but-truthy placeholder before
  initLive's fetch lands — the resolver checks for CONTENT, not truthiness
  (tests run without initLive at all). Real values were written into the file
  from each monster's curated level (hp 15+10L, dmg 2+1.6L, xp 8·L^1.35);
  a wiki admin edit re-tunes live rooms with no deploy. `speed_wu` and
  `scale` resolve but have NO consumer yet — chase speed is the shared
  CHASE_SPEED_WU constant because the escape math depends on it; wiring
  per-monster speed means re-deriving that triangle first.
- **Client prediction under combat**: pending inputs carry the slow factor
  they were ORIGINALLY integrated under (exactly like `jumping`) and replays
  use it — replaying an RTT-deep buffer with the CURRENT synced slow rewrote
  history at every slow boundary (review: an uncommanded forward teleport
  right as you broke free of a chase). The server also mirrors slow into the
  synced field inside hurtPlayer (not the next tick top), and ACKS the seqs
  it swallows while dead — un-acked seqs kept replaying and rendered the
  corpse offset, then popped it off-spawn on revive.
- **Hit feedback (round 7)**: damage floats are 26px and linger 850ms
  (maintainer: twice as big, 0.2s longer); every landed hit — player or
  monster — plays a BLOOD SPATTER (objects/blood_spatter, the maintainer's
  PixelLab object stored TRIMMED to the already-scattered dispersal window he
  green-circled; see object.json:edited before any resync): one of the 8
  direction variants at random, forward or REVERSED at random, 14fps, at
  depth 900_001.95 (lighting never dims it), preloaded in the deferred batch
  with the sword marker (a lazy first-engage load lost the walk-to race).
  The got-hit flinch is FAST now (hurt 16fps, 300ms overlay). `bloodFx()`
  probe counts spawns; verify-combat asserts ≥1 during the fight.
- **Gates**: combat.unit.test.ts (curves/determinism/escape math),
  combat.test.ts (2 live rooms: full fight loop + death/respawn),
  combat.review.test.ts (leash give-up on a kited frog; world-agnostic
  progression; one-session-per-token), store.test.ts (deep-copy boundaries),
  verify-combat.mjs (dev stack: clips alternate kick+punch, monster
  attack/angry play, hp bar, loot, pickup, backpack DOM, drop-out).
  verify-bars asserts the REAL level-1 stats (40/40 HP, 20/20 EP, 0/50 XP)
  after waiting out the join race; verify-gamepad expects Jump+Pick up+Walk.

## NPCs (maps2 placement + characters2 art, client-side decor)

The maps2 agent places people (`maps2/worlds/<name>/npcs.json`,
`pixel-maps2/npcs@1`, spec `maps2/spec/NPCS.md`); characters2 owns who they
are (`characters2/npcs/<id>/`). The game just draws them (maintainer
2026-08-06: "we just have to draw them at the current location and play the
idle animation … rendered similar to monsters/players and have faked client
side collision just like monsters").

- **NO SERVER STATE AT ALL.** NPCs are client-side decor: the placement file
  says where they stand and which way they face, and that is the whole truth.
  Nothing is synced, nothing is validated, and they cost the room nothing.
- `scripts/build-npcs-manifest.mjs` -> `client/public/npcs.json`: per NPC
  character, the frame size, the eight static `base/<dir>` rotations, and the
  idle clip's frame count PER DIRECTION. Art loads LAZILY per character — a
  world places ~20 people out of a 191-strong roster, so fetching the catalog
  would be pure waste.
- **THEY ALL FACE SOUTH, and never walk** (maintainer 2026-08-06). maps2'
  `facing` is deliberately IGNORED for now: only south has an idle clip, so
  honouring the placement would leave most of a street frozen on a static
  rotation while their neighbours breathe. One line in `addNpc` goes back to
  `p.facing` the day the other rotations exist.
- **THE NADIR SHADOW SITS BETWEEN THE FEET.** The sprite origin is the
  ART-MEASURED foot anchor (`anchorlib.footAnchor`, the point between the two
  feet at their underside — the SAME function and numbers the player
  characters use), so the drawn soles land exactly on the ground point
  `placeBodyShadow` draws the shadow at. **Never eyeball this**: the first cut
  guessed `originY 0.9` and was up to 9px off, which is exactly the "flying"
  bug the monsters took three rounds to kill. Verified against the ART, not
  just the code: every one of the 191 anchors lands 1.5-3px above its own
  drawn sole line, which is the designed mid-foot lift.
  CLOAK GUARD, NPC-only: a floor-length cloak puts the frame's lowest mass at
  the HEM and the foot-blob pass then anchors on the boots ABOVE it (2 of 191
  measured ~7px high, one of them placed in five worlds). A hem that reaches
  the floor IS the ground contact, so an anchor drifting >4px above the sole
  falls back to the sole line. The player measurement is never touched by
  this — it is approved art and lives in the shared module unchanged.
- **THE IDLE IS SOUTH-ONLY** (measured: 188 of 191 characters ship a 5-frame
  idle, all of them for `south` alone). So an NPC facing any other way
  correctly stands on its static rotation. `idle` is keyed per direction
  precisely so the other seven appear with NO client change the day
  characters2 generates them — do not hardcode "south" anywhere.
- **THE CALM IDLE** (maintainer: "since the NPCs will at some point fill an
  entire city I want a more calm idle … freeze on the first frame for a
  pseudo-random duration between 0.1s and 5s so they don't repeat the idle
  animation too often and too regularly"): the clip is created with
  `repeat: 0` and `stepNpcs` plays it ONCE, then parks on frame 0 until a
  fresh random NPC_HOLD_MIN_MS..NPC_HOLD_MAX_MS deadline passes. Each NPC
  rolls its own, so a street never breathes in unison. Measured on
  the_island2: parked ~78% of samples, 16 distinct hold buckets.
- Rendering goes through the SAME shared body pipeline as players and
  monsters (`resolveBodyDepth` + `placeBodyShadow` + the lit copy) — an
  NpcAvatar satisfies BodyVisual. Never hand-roll a second path here; that
  mistake already cost the monsters a round of terrace-tile overdraw and
  detached shadows. Off-screen NPCs park exactly like culled monsters.
- **FAKED CLIENT-SIDE COLLISION**, the monster pattern: NPCs join the same
  `monsterDodge` near-list at NPC_BODY_RADIUS, so the INPUT slips around them
  and the server integrates the identical deflected vector (no rubber-band).
  They are not in the collision grid and not in findPath.
- **LOADING: standing art at BOOT, idle frames FIRST in the deferred batch**
  (maintainer 2026-08-06: "the loading restarts just before the game loads and
  once loaded it takes ~0.5s before the NPC is drawn"). Both symptoms were one
  mistake — spawnNpcs fetched the placement in create() and then started its
  OWN loader run, which re-fired the scene loader's progress events the
  loading overlay is driven by (the bar restarted) and delivered the art after
  the world was already up (the pop-in). Now: main.ts fetches the placement at
  boot beside the world; `preloadNpcArt` queues one standing image per
  DISTINCT placed character into the boot batch (measured: 0 bar restarts, 0ms
  between the world appearing and the NPCs being drawn); and the idle FRAMES
  go into the deferred batch — but FIRST in it. Queued last they landed 18.3s
  in, behind ~800 action-state frames and every monster combat strip, so a
  town stood frozen; first, they arrive in 0.2s. **Never put the idle frames
  in the boot batch** — that is the loading-bar regression.
- The idle clip is registered LAZILY, per NPC, once its frame textures exist
  — NOT on a one-shot loader COMPLETE. A world queues ~20 NPCs back to back,
  so COMPLETE fires between batches while later files are still pending and a
  one-shot handler finds its own textures missing and gives up silently:
  measured 0 of 19 clips registering. Same shape as the monsters'
  single-call-site trap.
- Gate: `scripts/verify-npcs.mjs` (dev stack, the_island2's 19 NPCs) — every
  placed NPC spawns at its cell, all face south, on-screen ones carry a sorted
  depth + a ground shadow ON their measured foot anchor, the idle is
  measurably calm, its holds measurably vary, and neighbours are out of phase.
  Probe: `__ml.npcInfo()` (incl. the drawn origin/shadow geometry).
- TRAPS: the registry's `world` key holds the parsed World OBJECT (the id is
  `worldName`), and spawning must happen in `create()` — `projectFlat` is
  meaningless in `init()`.

## Depth-fog on BODIES (syncLitCopy)

- Monsters and remote players are COLOURED by the elevation depth-fog like
  the terrain they stand on (maintainer 2026-07-30: a summit turtle rendered
  crisp inside heavy haze). Mechanism: every body draws twice — the raw
  sprite UNDER the fog overlay (the shader fogs it exactly like tiles) and
  the crisp lit copy ABOVE it (night lighting). The copy's alpha is faded by
  `night.depthFogAt(col,row,lvl).a` at the body's own surface level, which
  CROSS-FADES crisp→fogged sprite — compositing to exactly a strength-f fog
  in the terrain's own colours. NOT transparency: at heavy fog you see the
  fog-painted body, not through it. The local player is fog-0 by definition
  (the field is relative to their elevation) so their copy stays full-alpha.
  Probe: monsterInfo() lit.alpha (measured: own level 1.0, below-player teal
  band 0.735, saturated summit 0.001 — matches the terrain wash).

## Living camera (WorldScene.updateChaseCam)

- The camera CHASES the player instead of pinning them dead-centre:
  exponential ease toward the sprite (CAM_TAU 0.3s, trail capped at
  CAM_TRAIL_MAX 70px; CAM_SNAP_DIST snaps teleports/respawns), plus a
  small speed-coupled ZOOM-OUT — up to CAM_ZOOM_OUT (18%) of the base
  integer zoom at full run world-speed (CAM_ZOOM_REF_WU, driven by the
  gait EMA spdWu so water/walk scale naturally) — because the chase
  alone would show LESS in the running direction (maintainer). Ease-out
  0.45s, ease-back 0.85s (no pumping); at rest it settles back onto the
  crisp integer zoom, dead-centred. Fractional zoom while MOVING is the
  accepted trade (motion hides the shimmer; rest is always integer).
  `__ml.lookAt` detaches the chase (camDetached); no-arg re-attaches.
  Probe: `__ml.camInfo()` → {zoom, base, trail, detached}; regression
  lives in verify-smoke (trail>6px + zoom dip while running, settles to
  base within 8px).
- **`__ml.teleport(col, row)`** — drop the player at an EXACT world coordinate:
  the SAME numbers shown under the avatar's name (`fx/CELL_WU, fy/CELL_WU`), so a
  bug reported on a screenshot is one call to reproduce. Server-authoritative (a
  `"teleport"` message clamps to the world, sets `elev`, clears queued
  movement/jump); the camera re-attaches and snaps. Precise placement, NOT a
  spawn snap — it lands where asked even off standable ground. Debug only.

## Time-of-day (server-owned world state)

- The phase index lives in WorldState.timeIdx (shared DEFAULT_TIME_IDX /
  TIME_PHASE_COUNT) and the cycle RUNS BY ITSELF (maintainer: the
  day/night cycle is a core rhythm of the game): the server's world
  clock advances the phase per TIME_PHASE_SECONDS ([40, 20, 40, 20] —
  order is [Night, Morning, Day, Evening]; the maintainer's ratios AND
  durations, 2026-07-31: night 40 / morning 20 / day 40 / evening 20, a
  2-MINUTE cycle. DAY == NIGHT is load-bearing, not taste:
  the clock pill runs the sun over morning+day+evening and the moon over
  evening+night+morning, and those spans are equal ONLY while day and
  night are — which is what makes the two bodies move at the same speed.
  Superseded "night ticks 3x as fast" (40s vs a 120s sunlit sum), whose
  whole point was to keep darkness short; the 1/3 night does that too,
  without a racing moon). Time is CONTINUOUS (maintainer: "the clock arrow
  and the shadow should move continuously... not swap from day to
  evening that sudden" — the discrete jumps were why time kept LOOKING
  frozen): WorldState.phaseT (0..1 progress, written by the 20Hz sim
  loop) sweeps every client's hand/sun/ambient/torch via
  blendPhases(u = timeIdx + phaseT), which lerps the phase tables
  between MID-phase anchors — u = i + 0.5 is exactly TIME_PHASES[i]/
  SUN_PHASES[i], so every calibrated verify script still sees the
  approved keyframes (local probes pin phaseT = 0.5). Natural rollover
  enters at phaseT 0; a manual SKIP lands at 0.5 (the phase's
  characteristic look, for frozen testing); unfreeze RESUMES from the
  held phaseT (never restarts the phase). The SUNLIT sweep spans
  morning+day+evening — phases share the -90..+90 arc IN PROPORTION TO
  THEIR DURATIONS (handAngle), noon at day's middle — and its `f` is
  exactly the sun's normalised position on the clock pill, so the cast
  shadow and the drawn sun can't disagree. Night has its own sweep with
  the sun's strength pinned to 0. Nothing special happens at either
  boundary any more — see the clock pill below. THE SUN IS THE HAND
  (maintainer: "directional light always points in the clock arrow
  direction"): sunFromHand derives the grid cast from the hand angle
  by inverting the iso projection (passes exactly through the old
  keyframes: -90 -> (R2,-R2), 0 -> (R2,R2), +90 -> (-R2,R2)), slope
  0.34..0.45 by altitude, strength 0 all night (no sun = no wrong
  direction) with ~6%-of-sweep sunrise/sunset ramps; SUN_PHASES
  remains only as the sunVec(DEFAULT_TIME_IDX) init. CAREFUL: local
  probes pin phaseT via setTimeOfDay's tOverride param — reading
  state.phaseT inside setTimeOfDay once clobbered the probe keyframe
  (only worked because fresh rooms default to 0.5). WorldState.timeSpeed (settings "time speed"
  button, "timespeed" message) scales the clock: the button CYCLES
  shared TIME_SPEEDS, and THE ARRAY'S ORDER IS THE BUTTON'S ORDER —
  x1 (the boot default) -> x0 FREEZE -> x0.5 -> x2 -> x5 -> x10 -> x1
  (maintainer 2026-08-06: freeze is one tap from rest, "unlogical yes,
  makes me develop faster, yes" — do not "fix" it back to sorted).
  An explicit {v} in the message jumps straight to a valid value (tests
  use { v: 1 }); x0 is mirrored into WorldState.frozen for the
  pressed-switch look. Speed changes resume
  from the current phaseT (never restart the phase). Manual skips still
  work while frozen; tests must set a speed before expecting
  auto-advance. The settings buttons PRINT THEIR STATE (maintainer):
  "time-of-day: Day", "time speed: x2" / "time speed: frozen",
  "weather: Clear sky" — hud.ts `state` callbacks re-read on
  refreshSettings, which EVERY relevant state listener must call. The
  time-of-day one did not, and since the world clock advances by itself
  every 20-40s that button printed whatever phase happened to be current
  when the page was last built (maintainer 2026-08-06: "often gets out of
  sync with the real time"). A new synced field that a Settings button
  prints needs the same one line in its listener; verify-smoke now asserts
  the printed phase against the world's. The [1] key / HUD button send
  "timeofday" — a SKIP that also restarts the phase timer (room option
  phaseSeconds overrides durations for tests). Every client's state
  listener applies the change (instant + logless on the initial sync,
  2.5s fade + chat log after). The clock OUTLIVES rooms: rooms
  auto-dispose when empty and reconnects land in fresh ones, so
  WorldRoom keeps a per-world `worldClocks` registry (timeIdx/frozen/
  weather/aurora + phase deadline, process lifetime) that a new room
  resumes — fast-forwarding phases missed while nobody was online —
  instead of resetting to the frozen default (maintainer hit exactly
  that: "unfreezing doesn't stick"; a headless prod probe proved the
  in-room clock itself ticked fine). Tests call resetWorldClocks()
  in beforeEach — one process per file shares the registry.
  Ambient palettes (TIME_PHASES) stay client-side; keep the array length
  == TIME_PHASE_COUNT. `__ml.timeOfDay(which)` remains a LOCAL debug
  probe (verify-timecycle drives grades headlessly without the server).
  Regression: server/test/timeofday.test.ts. TORCH is PLAYER state the
  same way (Player.torch, "torch" message): my own light flips on the
  local mirror instantly, everyone else reads the synced field, and a
  rejoin re-asserts the local value to the fresh player entry
  (server/test/torch.test.ts). Torch IMPACT is CONTINUOUS, not a
  boolean (maintainer): curTorchF rides the ambient's 2.5s clock, 0 at
  full Day and 1 otherwise — the shader light's colour scales by it so
  flames melt away as daylight arrives and rekindle as it passes (the
  switch keeps the preference).
- The CLOCK PILL — "Fern starfall" (client/src/clock.ts, maintainer
  2026-07-31, chosen from a long design round: 5 -> 10 -> 20 -> 21
  candidates; the winner is the papercut family with Fern's greens, Sea
  glass's plain disc sun and Storm's starfield + falling star). A tiny
  landscape sits at the GAME VIEW's bottom-right corner, pass-through,
  10px from the right edge (the margin the XP chip keeps at the top) and
  10px above the HUD rail via `--hud-h` — mirroring the chat log on the
  left (maintainer 2026-07-31; it started top-centre between the stat
  chips, which it was too wide for). REAL PIXEL ART: a 40x16 art-pixel
  scene painted into an ImageData buffer and shown at x2 (80x32 css)
  with `image-rendering:pixelated`, so the grid is exact. Flat cut-paper
  layers, hard edges, NO dithering and NO gradients (the earlier rounds
  were rejected for exactly those: "you still use dithering and
  horizontal stripes a lot").
  THE GEOMETRY IS THE APPROVED MOCK'S, VERBATIM — AH 16, HOR 10, AMP 7,
  orb radius 3.4, the sun's radius-8 glow scaled by daylight, layer
  bases 10/12/14. The first cut squeezed it into 12 rows with r=2.8 orbs
  and no glow to save screen space, and the maintainer caught it on
  sight: "your sun and moon look more squary". A 2.8 disc is 5x5 with
  barely-nicked corners; 3.4 is 7x7 with real round shoulders, and the
  glow dissolves the remaining corner pixels into the sky. If the pill
  ever has to get smaller, drop SCALE — never re-tune the art.
  Its corner is RESERVED: chat.ts caps the log and the input with
  `--ml-chatw` (100vw - 112px) so they stop short of it.
  ONE EDGE MARGIN, 10px, for everything that hugs one (maintainer
  2026-07-31: "the same edge-margin as the pill… this will make
  everything equal"): the stat chips at the top, the chat log and its
  in-world input at the bottom-left, the pill at the bottom-right, and
  the keyboard-floated chat box (which was on 14px). verify-chat asserts
  the chat's margin against the PILL's own rect, not a literal, so the
  two can't drift apart.
  KEYBOARD: the phone keyboard covers both bottom corners, so when a
  chat box takes focus hud.ts's lift raises the log AND the pill onto one
  line above the floated input (`:root.ml-kb-up`, `--ml-inputlift + 56`,
  both with a .15s bottom transition so they glide together). The lift
  recognises BOTH chat boxes now — the Chat page's `.ml-chat-input` and
  the in-world `.ml-chatinput`; the in-world one is a direct child of
  <body>, so armLift() skips its "hold the row open" step (pinning a
  height on body would freeze the page). Placeholders hide on focus
  (`:focus::placeholder{color:transparent}`) — the prompt is an
  invitation, not a label. Gate: verify-chatpage (margins, both lifts,
  same line, placeholder).
  A TAP ON THE WORLD ALWAYS BLURS THE BOX (maintainer 2026-08-05: "select
  the input and then close the keyboard — if I now attack an enemy or click
  the game-view the keyboard will open again"). Android's ▼/Back hides the
  keyboard WITHOUT blurring the field, and Phaser preventDefault()s the
  canvas pointerdown so nothing else ever takes focus away — Chrome then
  re-opens the keyboard on the next tap anywhere. The lift's
  blur-on-outside-tap is therefore gated on FOCUS, not on the box still
  floating (it used to check `lifted`, which a device that DOES report a
  keyboard height clears the moment ▼ is pressed, leaving the field focused
  and the trap armed). ChatUI closes on blur for the same reason — an
  open-but-blurred in-world box would leave WorldScene's Phaser keyboard
  disabled forever and the player unable to walk.
  THE MOTION — TWO BODIES, NOT ONE BELT (maintainer 2026-07-31, and it is
  the design). The first cut alternated a SINGLE travelling orb on a belt
  (each body drawn three times, one pill-width apart, so an exit right was
  an entry left). It killed the hand-off, but the sun crossed on
  morning+day+evening and the moon on night alone — so with any sane
  phase lengths the moon RACED. The maintainer's insight: the sun and the
  moon are two different objects and both can be in the sky at once.

      tau (0 at sunrise, 1 a day later)
      0        1/6                 1/2        2/3                    1
      |morning |        day        | evening  |        night         |
      sun  |------------ crossing ------------|            (below)
      moon --- crossing |            (below)  |----- crossing --------

  Each body crosses the pill in 2/3 of a day — the sun over
  morning+day+evening, the moon over evening+night+morning — so they move
  at THE SAME SPEED (measured: 10.00px each over the same slice of world
  time), and they SHARE the sky at both ends: the moon rises the instant
  the sun enters evening, and hangs in the morning sky while the sun
  climbs, exactly as it does in the real one. The sun stays the main
  actor — drawn last, carrying the glow; the daylit moon washes 15%
  toward the sky and gains a rim so it reads pale but legible (washing
  harder both hid it and drifted its colour out of the QA detector).
  Hills are painted LAST, so each body enters and leaves BELOW the
  horizon: it really sets, and nothing ever pops. Position is a pure,
  continuous function of tau — including across the day's wrap — so a
  join, a phase skip and a per-frame tick are all just "paint this tau".
  `setClockTime(timeIdx + phaseT)` is the only entry point besides
  clockStar(); the pill owns the mapping (clock.ts `dayFraction`).
  DELETED ALONG THE WAY (do not resurrect): the half-dial's two
  cross-fading faces and its rotating hand, the +360 winding that kept
  the hand from ever running backwards, the 1.25s glide — and the
  SERVER-side freeze (WorldRoom.handoffHoldMs) that pinned phaseT at 0
  for 1.25s of wall time at each hand-off so the hand could catch up. A
  rendering artifact had leaked into the authoritative sim (maintainer:
  "the transition is instant so we no longer need the 'freeze time when
  animating to night' hack"). Gate: scripts/verify-clockflip.mjs reads
  the canvas BACKING STORE (art-pixel coordinates, starvation-proof) and
  asserts the whole model — sun alone at noon, moon alone at midnight,
  BOTH at opposite ends during morning and evening, moonrise starting
  with evening, EQUAL SPEED, and continuity at the sunset boundary and at
  the day's wrap (mean pixel delta 0.01/0.05 vs 14.3 for a real
  quarter-phase step). Probe: `__ml.timeOfDay(idx, instant, phaseT)` —
  the third arg parks the world clock anywhere inside a phase.
  The version badge sits bottom-centre (main.ts), clear of the pill.

- AURORA NIGHTS: WorldState.aurora (server-rolled in advanceTime — 45%
  of nights, auroraChance room option for tests; gone by morning).
  Shader uAurora (DECLARED in the uniforms config — the uSun lesson)
  ADDS drifting green/violet noise curtains to the ambient, scaled by
  (1-uSun.w) so they fade as the sun returns; auroraAt() is the EXACT
  JS twin (lit copies glow with the sky — change both). Client eases
  curAurora on the cloud's ~4s roll; chat logs "Northern lights dance
  over Nangijala." Probes: `__ml.aurora(on?, instant)` (local force),
  `__ml.auroraAt(wx,wy)`. Regression: server/test/aurora.test.ts.
- SHOOTING STARS (Nangijala is the land you ARRIVE in): every player
  join broadcasts "star" {name} — all clients draw the same streak
  across the visible sky (WorldScene.shootingStar: additive head +
  particle tail at depth 1.5M, brightest at night, chat-logs the
  arrival) with a micro-star echo on the dial (clock.ts clockStar()).
  The server also throws wild no-name stars at random during NIGHT
  (scheduleWildStar, 25-75s). Probe: `__ml.star(name?)` (local).
  Regression: server/test/star.test.ts.

## Weather (server-owned world state, layer 2)

- WorldState.weather (shared WEATHER_NAMES/COUNT; 0 = "Clear sky",
  1 = "Cloudy at times", 2 = "Mist") cycles via the "weather" message — the Settings
  button sends it, every client's listener applies it (instant on join,
  chat-logged after). Cloud cover EASES over ~4s (clouds roll in). The
  shader's uCloud drives a WORLD-ANCHORED 2-octave value-noise cloud
  field (feature wavelength ~550 world px) drifting on a fixed wind
  (~42/23 px/s via uAnimTime), shading the ambient (depth 0.45×cover,
  muted by the sun's strength — night clouds barely register); while
  cloudy the ambient also greys ~20% toward luminance ("the sky is not
  perfect blue"). cloudFactorAt() is the EXACT JS twin (lit-copy tints —
  characters dim as a cloud passes; change both together). uCloud is
  DECLARED in the uniforms config (see the uSun lesson). ALL twinned
  noise (clouds, aurora, mist) hashes with a PRECISION-EXACT integer
  chain (mod-971 quadratic residues; every intermediate an integer
  < 2^24, so GPU float32 and JS float64 agree exactly). NEVER
  fract(sin(big)*43758) in a twinned field: phone GPUs resolve sin at
  ~0.002 rad up there, the GPU/CPU lattices decorrelate, and the
  avatar's cloud tint disagreed with the drawn shade (maintainer:
  "darker before the shadow has even hit... not in sync" — headless
  SwiftShader computes sin in higher precision, so QA screenshots
  never caught it). Probes:
  `__ml.weatherInfo()`, `__ml.weather(idx, instant)` (LOCAL force for
  headless QA), `__ml.cloudAt(wx,wy)`; regressions:
  scripts/verify-weather.mjs (clear=1 everywhere, patchy not overcast,
  drifts over time, night-muted) + server/test/weather.test.ts.
- **PRECIPITATION (weathers 3-8)** — Drizzle / Rain / Heavy rain / Storm /
  Snowing / Windy (client/src/weatherfx.ts): a manually-pooled particle
  layer in WORLD space at depth 899_500 (above world art, BELOW the night
  overlay so drops dim with the night and take torch light, below the lit
  avatar copies). Drops RECYCLE inside the camera view (+margin): below
  the view -> respawn in the top band, x wraps — constant density however
  the camera moves, no lifespan pops; counts scale with view area
  (REF_AREA). Storm gusts are a GLOBAL sine on vx (every streak leans
  together) + camera-flash lightning every 5-14s (sometimes double);
  streak rotation follows the velocity vector. Snow sways per-flake and
  SETTLES: a flake falls to its own ground height, rests as a still flake
  a few seconds, then melts (fades) and recycles — EXCEPT on water, where
  it melts near-instantly (SNOW_WATER_MELT ≈320ms, no rest phase): WeatherFX
  gets a `waterAt(wx,wy)` predicate from WorldScene (`isWaterAtScreen`, the
  same iso inverse-projection as pickGround → swimmable cell) so flakes over
  a lake don't blanket it. QA: `__ml.waterAtScreen`/`camView`, and rest/shown
  is ~2.4x lower over a lake view than over land (ring_test cell 74,68).
  Windy is leaf debris (three autumn tints, deep per-leaf surge + curl
  arcs — anime wind streams, maintainer's inspiration) plus faint long
  motion-line wisps racing ahead of the leaves at 2.3x gust. Each state
  brings overcast (WEATHER_CLOUD, scales uCloud) and a flat ambient
  gloom (WEATHER_DIM -> eased curPrecipDim in ambEff) — both applied
  instantly on join sync and by the __ml.weather(idx, true) probe
  (WeatherFX.snap()); the eased path assumes a LIVE frame loop, so
  HEADLESS QA at the big phone viewport (starved to ~3fps) must use
  instant — and NOTE: starvation also stretches the 110ms lightning
  flash across seconds of wall time, so storm screenshots there often
  catch a "stuck" white wash that does NOT happen at real frame rates
  (verified: 1 flash / 10s at the fast small viewport).
  Probes: precip/precipDim in `__ml.weatherInfo()`.
- **MIST (weather 2)** — creepy ground fog (maintainer: "follows the
  ground... over lakes and open fields... can appear inside a forest...
  part of the world, close to the ground, moving in the same isotropic
  coordinate system"). Implemented in nightlight.ts as a SECOND shader
  pass (MIST_FRAG): the multiply light field can only darken, and real
  fog must COVER, so mist renders to its own RT composited with NORMAL
  blend at depth 1_000_000 — above the light overlay AND the lit avatar
  copies, so fog swallows whoever wades in. Each fragment runs the same
  exact-crossing surface resolve as the light field, and density POOLS
  by the resolved terrain height (full at ≤~0.4 levels — lakes, open
  fields — gone by ~2.4): banks hug valleys and stop at cliff lines.
  The noise banks drift along the WORLD axes = the iso diagonals on
  screen. Density is posterized into 5 bands (stylized layers, cap
  0.74); the cold-grey colour dims with the ambient so night mist looms
  instead of glowing. LESSON: posterize AFTER scaling to the band range
  — the first cut floor()'d raw density, almost everything fell below
  band 1, and the whole effect silently vanished (debug by bisecting
  the fragment with early colour returns). Eases on the clouds' ~4s
  roll (curMist), skipped entirely while clear. EXACT JS twin mistAt()
  — change together with MIST_FRAG; probes `__ml.mistAt(wx,wy)` + mist
  in `__ml.weatherInfo()`.

## Directional sun shadows (day phases)

- The night shader also carries a DIRECTIONAL SUN (uSun = cast-dir grid
  x/y, slope levels-per-cell, strength). The sun march is TWO passes
  over the same field (maintainer: "the shadow on cliffs looks perfect
  — don't change that part"): TERRAIN keeps the original multiplicative
  ramp (20×0.6-cell samples, mix(0.80,0.35) — the approved cliff
  DARKNESS, byte-identical; the prop share is subtracted from its heights
  so props can't perturb it) but now AVERAGES 3 complete marches jittered
  ±0.5 cell PERPENDICULAR to the sun ray (= along the shadow edge) to
  anti-alias the one-texel-per-tile staircase (maintainer wanted the
  straight "pyramid" shadow on hard structures too): a straight edge (the
  mountain/pyramid) samples the SAME transition at every perp offset so
  the average leaves it UNCHANGED — the "perfect" cliff is preserved
  (verified Δluma≈0.1/255, max 10) — while a staircased hard edge
  (wall/tower) straddles different zigzag phases and smooths. True
  supersampling of the real smooth field (each march complete), so it
  can't alias like sparse in-loop taps and never shortens a thin shadow
  — the earlier lateral-tap attempt aliased into a BIGGER zigzag and was
  reverted (`terrHeightSoft` = the per-sample terrain height helper).
  Meanwhile PROPS shade through one
  smooth MAX-MARGIN patch (fine 0.35 steps, margin = max over samples —
  per-sample multiplication scalloped small footprints into "x-mas
  trees"/"stacked circles"). Props occlude +1 level flat in the LINEAR
  heightmap G channel (their art `levels` 2-5 made spikes) and the
  patch amplifies the bilinear footprint into a plateau + fades reach
  out by ~2.5 cells — the raw pyramid footprint tapered the cast into
  a spiky needle (maintainer: "the top of the shadow is so
  spiky/small"); plateau + short reach ends every pool in a soft round
  fade. Terrain-only heights (faces/AO/ground z) stay untouched — prop
  art is a billboard, not a wall. There is NO separate baked
  contact-shadow overlay (a game1 relic; restored once and removed).
  DAYLIGHT IS SKY + SUN
  (maintainer): the phase ambient splits into a flat sky term (55%) and
  a directional term (45%) that only reaches surfaces with a clear
  line toward the sun — full authored brightness NEEDS the sun, and
  shadowed ground visibly drops toward the sky level (the first cut
  multiplied a small factor onto an already-full ambient and read as
  nothing). Every fragment marches the LINEAR heightmap toward the
  sun — terrain or solid objects above the ray shade the surface (soft
  penumbra, point-light LOS family), faces away from the sun shade via
  a Lambert gate; point lights still add in shadow. SUN_PHASES
  (WorldScene) drives it: Morning casts long shadows to screen-RIGHT,
  Day casts straight down-screen (synced with the celestial-clock hand
  at "12"), Evening mirrors to screen-LEFT, Night off — matching the
  clock hand's reading, lerped with the SAME clock as the ambient fade
  so shadows sweep as a phase changes (maintainer: "the sun moves...
  shadows move accordingly"). CPU twin sunFactorAt() shades the lit-copy tints the
  same way. Probes: `__ml.sunInfo()`, `__ml.sunAt(col,row[,z])`
  (z=-1 → the cell's own height); regression:
  scripts/verify-sunshadow.mjs (night=1 everywhere, morning/evening
  flip sides, noon shortest — runs on the default cliffy world).
  NOTE: verify-solidband.mjs + verify-wallspread.mjs are STALE (they
  predate the maps2 worlds and fail on baseline too — "no 5-cell wall
  run on screen"). verify-penumbra is now PINNED TO NIGHT (the day sun
  shaded its sampled wall bases); under the pin it finds PRE-EXISTING
  base defects at some ledges (fails on the pre-sun baseline
  identically — candidate-placement sensitivity, needs its own
  follow-up); timecycle/lit-order still gate clean.

## Night lighting (client/src/nightlight.ts)

- Always-night per-pixel shader: MULTIPLY overlay; per-pixel surface resolve
  (cell + height) → point lights with attenuation, LOS cast shadows, Lambert
  face gating with penumbras at both ends of every wall band.
- **DEPTH-FOG — cel-shaded EDGE-HIGHLIGHT fog** (`DEPTHFOG_FRAG`, maintainer: "see the
  exact edge where the cliff starts / the ground ends"): a THIRD, always-on NORMAL-blend
  overlay. Its JOB is to make cliff EDGES readable. TWO channels, summed then POSTERIZED
  once into snappy cel bands (teal `FOG_NEAR` → pale misty `FOG_FAR`):
  1. **SMOOTH horizontal DISTANCE** — 2D distance of the drape-reconstructed `scol/srow`
     to the player: onset at `FOG_D0` (11 cells), then +1 band every `FOG_DW` (1.2) cells.
     Fires on ALL ground, but the per-level TRANSPARENCY (below) fades it near the player's own
     level so it isn't a hard ring on the flat you stand on.
     Reconstruction is smooth (seed `sz=uPlayerZ`, iterate ×3 `sz=drape(cell(u,v0,sz))`;
     `drape()` = anisotropic blur of `terrH=uHeightL.R−G` along the col+row FOLD axis,
     half-width `DRAPE_RS=2.5`), so flat ground reads as clean concentric bands — NO
     per-tile zigzag. `terrH` uses R−G = occlusion height with PLACED PROPS removed
     (a boulder never haloes flat ground; edge-clamped so the map rim doesn't darken).
     FACE-SMOOTH: a near-vertical cliff FACE compresses those concentric rings into a few
     screen pixels, so the cel-snap (floor) STAIRCASES into diagonal bands that CHEVRON where
     two faces meet (maintainer: the "blue zigzag" vs the loved organic "red" on flats). Fix:
     `faceDepth = heightAt(cell) − z` is 0 on every flat/tread but grows DOWN a face (the pixel
     resolves to its high lip cell while the marched `z` drops); as it passes ½ level, LERP the
     distance band from `floor(distCont)` to the raw `distCont` — the face fades to the smooth
     ring value (a clean gradient, no staircase) while flats keep the crisp rings BYTE-for-byte.
  2. **HARD elevation EDGE** — `elevBand = ceil(|pLev − z|·ELEV_STEP − ELEV_EPS)` where `z`
     is the MARCH's OWN resolved fractional surface level (NOT `heightAt(cell)`: a cliff-
     FACE pixel resolves to the HIGH cell, so heightAt is constant across top+face and only
     steps at the FOOT — z instead equals the player's level on the tread and DROPS the
     instant a pixel is past the lip, so the `{z==playerLevel}` boundary lands ON the drawn
     cliff-top edge). `pLev = uPlayerZ` is the EASED (un-rounded) player elevation, so the fog
     FOLLOWS a jump/fall's z smoothly as it animates (no snap at the half-level); standing still
     it's a stable integer so flats/edges are unaffected. `abs()` ⇒ symmetric both ways (below AND above
     foggier, same palette); the `ELEV_EPS` dead-zone keeps a flat tread perfectly clear.
     `z` is constant across same-level ground ⇒ this term adds ZERO contour on flats (can't
     recreate the old zigzag) and is NOT gated by `FOG_D0` (edges pop even at the feet).
  `band = clamp(distBand + elevBand, 0, BANDS−1)` (ADDITIVE), then the fog OPACITY is scaled by a
  PER-LEVEL TRANSPARENCY: `a *= clamp(SAME_LEVEL_FOG + (1−SAME_LEVEL_FOG)·|Δz|/LEVEL_FADE_SPAN,
  SAME_LEVEL_FOG, 1)` — 10% opacity on the player's OWN level (a soft fade NOT the old hard gate,
  which was taken back), rising ~0.06/level to FULL by `LEVEL_FADE_SPAN` (15) levels of
  separation — a bridge high in the air reads at full strength (maintainer tuned the climb from
  ~0.088 to 0.06/level: it went too opaque too fast partway up a tall wall). (`ELEV_STEP=0.5` also makes the Z
  ramp gentle: +1 band every ~2 levels.) HISTORY of rejected tries: elevation-banded (v1) → then a TRUE 3D-distance
  SPHERE with drape-smoothing + `ZW` weight (killed the zigzag AND, fatally, the edge
  contrast — its bands were iso-distance rings that floated across the terrain and NEVER
  landed on an edge; maintainer: "makes it even harder to see the real edge"). So the sphere
  was dropped: `ZW` removed, the smooth channel went horizontal-only, and the HARD elevation
  term restores the edge highlight. Composited at depth **900_000.2** — ABOVE the multiply
  light overlay but BELOW the tap marker (900_000.5) and lit avatar copies (900_001): fogs
  the WORLD, never the characters. Dims with night, floored so bands read in the dark. Master
  strength `nightlight.fogStrength` (0 = off = instant rollback); tune/QA via
  `__ml.depthFog(strength?, testZ?, testCol?, testRow?)` (plants a virtual player anywhere
  headlessly — the fog radiates from it). Regression: `scripts/verify-depthfog.mjs`. Tunables
  are named GLSL consts atop `DEPTHFOG_FRAG`: **`ELEV_D0`** (=7) = elevation DEAD-ZONE — no edge
  fog until the surface is this many LEVELS from the player, so a house/roof stays clear (its
  small step is read from the map's distinct tiles) and only a real mountain fogs (NB: a drop of
  exactly `ELEV_D0` sits at the boundary — `occlusion_test` tops out at level 7 so at 7 it shows
  only the distance rings; `the_island` goes to 19 — the player's coord label prints the world
  id); **`ELEV_STEP`** (=1.5) = edge-contrast strength /
  bands per level past the dead-zone; `FOG_D0`/`FOG_DW`/`BANDS` = the horizontal distance
  onset/width/cull; `DRAPE_RS` = flat-ground smoothing; `FOG_MAX`/`FOG_NEAR`/`FOG_FAR` = look.
- **Bridge underside line = the ground AO seam, NOT the walk** (maintainer
  2026-07-23): bridges showed a static dark band + hard line on the water in
  front of every span, identical at all times of day. First theory (phantom
  wall-face from the resolve) led to a `uDeck` walk-divert that broke the
  night field into per-cell plates ("chess pattern") — REVERTED; do not
  re-attempt attribution changes casually. Real cause (maintainer's catch):
  the night shader's ground-side **ambient-occlusion seam term** reads the
  up-screen neighbour via `heightAt` (surface map = deck-inflated), so a
  floating span read as a tall WALL and stamped seam AO on the water. Fix:
  `baseTerrAt()` — B channel of `world-heightmap-linear` carries the BASE
  terrain level (never deck-inflated, texel-centre read), and only the AO
  seam term (+ its CPU sprite twin, `bArr`) uses it. Same packing expression
  as the surface R ⇒ non-deck cells byte-identical, cliffs stay locked. The
  faint 1-2px contact edge that remains under spans is the face-sliver
  attribution — known, subtle, and NOT worth another walk change without a
  pixel-proven plan.
  TERRAIN levels only and drives the resolve + wall-face classification;
  `world-heightmap-linear` (LINEAR) holds terrain + solid objects and drives
  ONLY the LOS march. A cell's LEVEL is packed into ONE 8-bit channel as
  `level*hScale`; the shaders decode with `*255/uHScale`. `hScale` is chosen
  PER WORLD in `buildHeightmap` (=16 for worlds ≤15 levels — byte-identical to
  the historical encoding — smaller when a world is taller). The old fixed *16
  SATURATED at 255/16 = 15.9 levels: `the_island2` (peak 32) clamped every high
  cell to a phantom ~16-level ceiling, so the depth-fog resolve read a bogus low
  `z` against the player's true 32 and painted a hard jagged fog SEAM across the
  whole flat peak (and night/occlusion read wrong heights too). Regression:
  `scripts/verify-heightscale.mjs` (stands on the level-32 peak via
  `__ml.teleport`, asserts the flat ground beside the player is NOT fogged). Solid objects (trees, boulders… `!standable &&
  !swimmable` in SURFACES) are ART, not walls: they block light and cast a
  soft shadow but must NEVER get a wall-face band — modelling them as blocks
  painted knife-edged phantom shadows outside their drawn art (the
  long-standing "shadow sticks out" bug).
- **Contract for new tile categories**: unknown categories default to plain
  walkable ground AND therefore to terrain lighting. Every new solid/decor
  category from the tiles agent must get a SURFACES entry or its block shadow
  returns. This is ENFORCED: `npm test` runs `scripts/check-surfaces.mjs`,
  which FAILS when the world uses an unclassified category (across ALL maps2
  worlds) and prints a name-hinted, ready-to-paste proposal — stand-on-it-or-not
  is a gameplay call. `WorldScene` also warns at boot. Expanding the material
  set = ship the world, run tests, paste the proposed line.
  - The `SURFACES` table lives in its OWN file, **`shared/src/surfaces.ts`**
    (split out of `index.ts` 2026-07-22 so it's a small, conflict-light target;
    `index.ts` re-exports it via `export * from "./surfaces"`, so every
    `@nangijala/shared` consumer is unchanged). This is the ONE games2 file the
    ART agents are authorised to edit: because `check-surfaces` is the only gate
    a `maps2`/`tiles2` push normally trips, and stalling their deploy on the game
    agent was the recurring block, the `tiles2` and `maps2` agents may now add
    their own entries and push — runbook in **`games2/SURFACES.md`** (which the
    gate's failure message, and the board messages to those agents, point at).
    Ideal: `tiles2` classifies a material WHEN it creates it, before any world
    uses it, so a deploy is never blocked. If a DIFFERENT gate fails on an art
    push, that's a real art bug — not a surfaces edit.
- **Self-emission (maps2 era)** is data-driven from `tiles2/emission.json`
  (`tiles2-emission@1`, owned by the tiles2 agent): per-MATERIAL glow params
  + per-tile-path glow `sources`. In maps2 worlds every emissive tile is a
  PROP, so `rebuildProps` stamps a tinted radial halo per visible source
  into the world-anchored additive glow RenderTexture the night shader ADDS
  to the light field (localized: a mushroom lights its patch, the forest
  stays dark). The emissive showcase world is maps2's `glow_test` (in the
  world picker) — every glowing material as walkable props; that's where
  glow/night QA happens (`verify-glow-seams.mjs` targets it).
  (RETIRED 2026-07-14 with the first-gen `tiles/` domain: the v1
  `tiles/emission.json` registry, the generated `#emission` station demo +
  its `demo` room + `buildDemoWorld`, per-cell glow floors/pools for v1
  categories, `analyze-emission.mjs`, `demo-shots.mjs`, `verify-emission*`,
  and `tile-bases.json`. History in git if the techniques are needed again.)
- The light/mist/depth-fog overlay quads BLEED ~1% past every screen edge
  (nightlight.ts spanScale = 1.02, overlays drawn at invZoom*k while uCam
  spans k× the view — the stretches cancel, so the world→screen mapping is
  EXACT and every calibrated sample is unchanged): without the bleed,
  fractional camera zooms left the quad a sub-pixel short of an edge, which
  on a high-DPR phone read as a 1px UNSHADED bright line at night
  (maintainer device screenshot, 2026-08-05). TEST PATTERNS (nightCal ≥3)
  render with k=1: the raw-field readbacks treat canvas pixels as field
  texels 1:1, and the stretch resamples rows into phantom straight seams.
- Debug: `__ml.nightCal(flip,span,test)` drives the field test patterns
  (gradient/grid/uv/classification/raw field — headless probes only; the
  old [6]-[9] calibration keys are retired);
  `__ml.probeLight(col,row,z,radius)` places a light headlessly;
  `__ml.lookAt(col,row)` detaches the camera to any cell (no args re-follows);
  numeric probes live in `scripts/verify-solidband.mjs` (no phantom bands),
  `verify-penumbra.mjs` (soft wall bases), `verify-wallspread.mjs` (lateral
  falloff parity), `verify-timecycle.mjs` (phase grades), `verify-lit-order.mjs` (lit-copy
  draw order). Run them against a dev stack before touching the shader.

## Mobile / PWA (client)

- **WIKI-STYLE UI (2026-07-30, the complete HUD remake)**: the pixel-art
  "UI kit" plates and the vine/crystal page frame are RETIRED (frame2.ts +
  plate.ts deleted; history in git). Every DOM surface — select screen,
  HUD tabs/pages/settings/backpack, gamepad stick + jump button, stat
  bars, day/night clock, chat overlay + chat page, version badge, update
  banner — is plain HTML/CSS on the SHARED WIKI THEME
  (`client/src/theme.ts` = a verbatim copy of wiki/site/wiki.css tokens:
  cream/dark palettes, serif headings, coral #d97757 accent, 1px
  var(--border) borders, 8-14px radii). DARK MODE is ONE choice for wiki
  AND game: localStorage["wiki-theme"] -> `<html data-theme>`; theme.ts
  follows the wiki drawer via `storage` events, wikipanel.ts mirrors
  game-side toggles onto the live iframe, and Settings gained a
  "theme: light|dark" button. Pixel-art ICONS stay (tab icons, gold
  nugget), pixelated; TAB icons render at their AUTHORED 1x GRID —
  hud.ts sizes each img to naturalWidth/2 (the /ui2 bakes are exact 2x
  of the maintainer's hand-drawn art on non-square canvases; a fixed
  square box distorted + fractionally scaled them — maintainer
  2026-07-30 "not pixel perfect"). Tab row + pages share 16px side
  margins; tabs are 56px tall (48 at ≤640h) and the row closes with a
  1px bottom rule (the page scrolls UNDER it). REJECTED 2026-07-30: a
  screen-edge frame around the whole game view (a `.ml-edge` overlay,
  2px rule + matted rounded corners) — "it looks bad"; the game view
  goes full-bleed to the screen edge, do not re-propose it. ALSO
  REJECTED: an in-game bottom-right chip for the version badge — the
  badge keeps ONE placement across the whole game, quiet bottom-centre
  on the select screen and in the world alike. NO
  zoom compensation in the new UI: like the wiki it is plain responsive
  CSS (uiscale.ts survives only for loading.ts + WorldScene's reconnect
  toast). Gates: verify-bars/-hudtabs/-clockflip/-chatpage/-gamepad/
  -select all assert the new DOM.
- **HUD (golden-ratio split)**: the game viewport is the TOP 61.8% of the
  page (index.html `#game` = `--hud-h-inv`); the bottom 38.2% (`--hud-h`)
  is the DOM HUD (`client/src/hud.ts`): a tab row of 6 wiki buttons
  (button.ml-tab[data-tab] + pixel icon; `.sel` = the accent state) over
  the content pages. hud.ts applyLayout() publishes --hud-h/--hud-h-inv
  in REAL px (the keyboard lift + chat overlay parse px values).
  Settings hosts the toggles mobile can't reach by keyboard (the
  time-of-day button keeps the `.ml-hudbtn` hook for the smoke) + the
  theme button; Log out is a wide two-step button. `.ml-plate-btn`
  survives as a plain-CSS wiki-button class — the ambient agent injects
  its cycler expecting it. Pointer events in the HUD never reach Phaser
  — e2e scripts must keep tap/drag coordinates in the top 61.8% (canvas
  centre y = `VH*0.309`).
- **Tap/hold-to-move**: a tap RUNS to the point (there is NO double-tap
  gesture — nobody walks when they can run, maintainer); the autopilot
  eases into a walk inside `APPROACH_WALK_RADIUS` (2.5 cells) of the
  target, so arrivals read as deliberate. HOLDING the pointer steers
  continuously: the trip starts on pointerDOWN, the beacon tracks the
  finger EVERY frame (pure projection — the instant-feel half), and the
  actual findPath replan runs on an adaptive budget (cost×8, floor 50ms:
  measured p50 3-5ms / p95 17-24ms, scripts/bench-findpath.ts — per-frame
  replans would eat whole frames on phones; a deferred replan is committed
  from the frame loop when the finger rests, and on release). `trip.slow`
  carries across hold replans (throttled tabs would re-arm the run every
  replan); release lands the beacon on the trip's true end. Holding NEAR
  the player walks — the target stays inside the walk radius. Any
  movement key cancels (keys also pause hold replanning; it resumes on
  release).
  Routes come from the shared **`findPath`** (A*
  over the terrain grid: walk edges, NEAR-LEVEL-ONLY diagonals, CARDINAL
  1-level jump climbs at ~3× cost, +0.6 for cells hugging solids) so the
  character walks AROUND props and ALONG walls to a head-on jump approach.
  A diagonal is allowed only when its destination AND both flanking cardinals
  stay within WALK_CLIMB of the current level — the round body's centre clips
  the shared CORNER cell mid-segment, so a diagonal onto/past a real drop (a
  cliff beside a bridge staircase) used to walk the body off that corner and
  FALL into the gap (maintainer: "doesn't respect sharp corners... shortcuts
  and falls"); a bigger drop now routes cardinally. Jump-climb diagonals are
  disallowed too (jumps are cardinal only). Gate: the occlusion_test
  bridge-climb trip in server/test/navigation.sim.test.ts drives the real
  follower up onto the deck and asserts the surface elevation never collapses
  to the base.
  The route is HITBOX-aware end to end: waypoints come one per cell (NOT
  merged into long legs — a quantized follower drifts off long legs into
  prop margins), each nudged away from adjacent solids; the FINAL point is
  `clearanceAdjust`ed out of any solid's collision margin (a tap 2wu from a
  prop face — or inside the prop — walks to the nearest spot the BODY can
  occupy, instead of grinding at the face like a fly at a window). A* is
  best-effort: unreachable/solid goals route to the nearest reachable rim;
  `null` (nowhere to go) ignores the tap. The FOLLOWER lives in `shared/`
  (**`startTrip`/`stepAutopilot`** — WorldScene only feeds it the predicted
  position, renders the marker, and cancels on keyboard) and emits the SAME
  8-way screen input a keyboard would (best-of-8 by dot product through the
  shared `screenToWorldVector`), so prediction, server validation and
  auto-jump behave identically to keys. The follower rules that matter:
  (1) "open heading" checks simulate a REAL `stepMovement` tick (lateral
  corner probes and all) — a centre-point probe lies exactly at 1-cell gaps
  between props, where the body must first be centred by sliding; openness is
  measured against each input's own speed-scaled displacement. (2) When the
  direct heading is body-blocked the chosen detour heading is COMMITTED
  (`trip.steer`) until the direct opens / the waypoint advances / a clearly
  better escape appears — re-picking every frame lets the two flanking
  headings' lateral components cancel and the player vibrates in place at a
  gap's mouth. (3) Waypoints advance when the movement SEGMENT since last
  step swept within the radius, and arrival/advance radii scale with the
  observed per-step distance (capped at one cell) — endpoint sampling with
  fixed radii at run speed under long frames leapfrogs/orbits forever.
  (4) Once one step exceeds a cell, the trip stickily demotes run→walk
  (`trip.slow`): 2.5fps frames cover two cells per decision, faster than any
  controller can steer. A 1.5s per-waypoint stall re-plans once, then gives
  up (stall within ~1 cell of the goal counts as arrival). Auto-jump uses the
  shared `autoJumpWanted` (probe scaled by the DOMINANT axis so concave "V"
  corners fire too). Double-taps are timed by DOM event time
  (`pointer.upTime`), NOT the game clock. The destination MARKER is a glowing
  additive beacon at depth 900_000.5 — above the darkness overlay (night
  can't dim it) and every terrain occluder (visible on clifftops), below
  the lit avatar copies; it pulses until the trip ends
  (`scripts/verify-tapmarker.mjs` samples real pixels at night, flat +
  elevated). A NORMAL-blend dark under-ring rims the additive pair:
  ADD light cannot brighten near-white ground, so on snow the beacon
  used to vanish (maintainer) — the dark outline carries the shape on
  bright terrain, the glow carries it in the dark. Probes: `__ml.tapTo`, `__ml.target`,
  `__ml.path`, `__ml.navLog`, `__ml.gridAround`, `__ml.pickAt`.
  **WEDGE-PROOFED HOLDS**: pointerdown ignores new touches while `holdPointerId`
  is armed, so a swallowed release (DOM overlays — loading screen/reconnect
  toast — racing the gesture, or an OS touchcancel Phaser doesn't re-emit)
  used to wedge the client permanently: the stale `holdGround` re-armed the
  trip every frame (player "runs to the tapped spot and gets stuck", respawn
  ran straight BACK to it) and every new tap was ignored (maintainer report).
  Three healing layers, all funnelling into `dropHold()`/`commitReleaseHold()`:
  (1) frame-loop self-heal in `predictAndSend` — hold armed but Phaser's
  pointer slot no longer down → drop (no final commit: the ground point is
  stale); (2) window-CAPTURE touchend/touchcancel (all fingers up → commit the
  release exactly like pointerup) and touchstart (fresh first finger while a
  stale hold is armed → drop, letting the new tap win); (3) a teleport/respawn
  snap cancels MY trip + hold outright — never run back toward the pre-jump
  target. Probes: `__ml.holdInfo()`, `__ml.wedgeHold(x,y)` (QA: arm the wedged
  state); gate: `scripts/verify-tapwedge.mjs` (dev stack, mouse pipeline).

## Audio (games2/composer — the games-audio agent's module)

- Since 2026-07-17 a THIRD agent works in `games2/`: **games-audio** (the
  composer actor, `sounds/spec/AUDIO_INTEGRATION.md`), sole owner of
  `games2/composer/` + `coordination/games-audio.json`. It binds `sounds/` +
  `music/` to the game: WebAudio buses, surface footsteps at gait cadence,
  jump/splash, UI clicks, thunder rumble, mood ambience, the looping score
  with ducking/night dip, scale-snapped tonal SFX. See `composer/README.md`.
- The game code talks to it ONLY via the `gameAudio` singleton — the small
  `gameAudio.*` calls sprinkled in `WorldScene`/`hud.ts`/`main.ts`/
  `ambient/thunder` are the audio agent's wiring; **don't remove them**, and
  emit new semantic events (`gameAudio.event("item.get")` etc.,
  names from `sounds/bindings.json`) when adding gameplay that should sound.
- **MUSIC BEDS, generated but NOT routed (2026-08-05)**: five new tracks
  (`battle`, `cave`, `home`, `town`, `adventure`) exist and are auditionable at
  **`/#score`**, but the IN-WORLD SCORE IS UNCHANGED (catalog bed by day, the
  `night` bed after dark) — the maintainer picks what plays where before any of
  it is wired. The routing machinery is dormant in
  `composer/engine/contextMusic.ts`. When it IS turned on: battle reads the
  monster brain's own `mstate` (`chase`/`combat`); a ROAMING monster scores zero
  however close, so the score reacts to real fights only. Cave reads world@2
  deck slabs overhead; home reads the spawn bonfire; town reads road/farm tiles.
  Selection is PURE and TESTED (`composer/engine/bedSelect.ts`,
  `composer/test/bedSelect.test.ts`): priority + Schmitt-trigger hysteresis so a
  boundary can't dither, PLACE BEATS TIME (a town at night is still a town), and
  a fallback chain so an un-generated bed degrades to the catalog track instead
  of silence. Every bed is loudness-matched (−18 LUFS) with measured loop points
  and resumes where it left off. Audition without hunting for the trigger:
  `__ml.audioBed("cave")`, `__ml.audioBed()` to release, `__ml.audioField()` for
  what the score is reading. Gate: `scripts/verify-beds.mjs` (dev stack).
- **A SOUND PLAYS ONLY WHEN IT WAS ASKED FOR — and the wiki is where it gets
  asked for** (maintainer 2026-08-05). The engine is **silent-by-default**:
  an emitted event plays NOTHING unless it is (a) on the small approved list
  (jump/fall grunts, UI clicks, chat notify) or (b) assigned by the Game
  Master in the wiki (requests land in `live/tuning/sfx_requests.json`; the
  composer wires them into `EVENT_ASSIGNMENTS` in `composer/engine/api.ts` and
  deletes the acted-on entry **in the same commit** — a request is a message,
  not a record, so once implemented it is gone and cannot be read back. The
  record of what an assigned event really plays is
  **`composer/assignments.json`** (`pixel-composer-assignments@1`, generated by
  `scripts/build-assignments.mjs`, staleness-gated by `verify-quiet`); read
  THAT rather than parsing `api.ts`, and never fall back to `EVENT_FOLEY` /
  `bindings.json` to describe an assigned event — they are outranked, so
  showing one looks like the assignment was reverted).
  `sounds/bindings.json` is a recommendation, not
  an approval — it resolves only for `BINDINGS_APPROVED` names, which is how
  unapproved catalog stand-ins got in last time. **So: EMIT semantic events
  freely** — `gameAudio.event("...")` with a LITERAL name (the wiki scans call
  sites; a ternary hides the name) — silent events are exactly what the Game
  Master assigns sounds to. Assignable actions already emitted: `combat.kick`,
  `combat.punch`, `combat.hit_taken`, `combat.monster_die`, `combat.cross_on`,
  `combat.cross_off`, `player.die`, `item.pickup`, `item.drop`. Gate:
  `scripts/verify-quiet.mjs` (source check: the can-sound surface must not
  grow without approval; the assignable actions must keep being emitted).
- **Background**: hidden page → master ducks to 50% and the score keeps
  looping (native-loop handoff in `composer/engine/music.ts` — background
  timer throttling used to kill the crossfade scheduler). Gate:
  `scripts/verify-background.mjs`.
- `gameAudio.clock()` / `__ml.audioClock()` publishes the score's live
  beat/bar phase + section intensity — use it to sync visuals to the music.
  It follows whichever score is playing (context bed or catalog track), and the
  context beds carry MEASURED key + tempo so tonal-SFX scale-snap keeps working.
- QA: `__ml.audio()` state probe; `scripts/verify-audio.mjs` (needs the dev
  stack) checks contracts→engine→footsteps→clock→ambience end to end.

## Dev-test workflow (fast loop — keep it this way)

- **Navigation/movement logic → `server/test/navigation.sim.test.ts`**, NOT
  the browser. It runs the real brain (shared `stepAutopilot`) against the
  real body (server integration: unstick + `stepMovement` + auto-jump model)
  on the REAL worlds (prop_demo from maps2, the emission station from its
  registries) at ~1000× real time — ~100 seeded walk/run trips × three frame
  cadences (16/133/400ms; the laggy rows are what catch the big-dt freeze and
  orbit classes) in ~2s inside `npm test`. A 2000-trip sweep takes ~15s in a
  scratch script. When a trip fails, print `stepAutopilot`'s debug fields —
  full decision forensics in seconds, no browser.
- **Browser = graphics + glue only, ONE session**: `scripts/verify-smoke.mjs`
  runs everything browser-bound back-to-back in a single Chromium + world
  load (~30s total): loading overlay, version badge, real-pointer tap run,
  press-and-drag hold-to-move steering, keyboard cancel, jump anim states,
  measured anim rates, in-place reconnect (last — it swaps the session),
  then one reload for a glow_test join + trip. The per-feature scripts (verify-mobile/-jump/
  -reconnect/-animrates/-navigation/-longwalk/-indoor) remain for deep dives.
- **INDOOR MODE IS A CUT-AWAY, NOT AN X-RAY** (maintainer 2026-08-07). Walk
  under a roof and the building is drawn WHOLE but TRUNCATED: every one of its
  columns — floor, near wall, far wall, corner — stops at
  `indoorTop = ceiling − <the Settings dial>` and nothing above that is drawn.
  The roof goes because it is above the cut; the near walls become a low
  parapet you look over. **Nothing is hidden, nothing is transparent, nothing
  is half a tile.** The dial is `client/src/indoorcut.ts` ("Indoor wall cut" in
  Settings, roof−1 … roof−8, default roof−3 — a body is ~4 levels tall, so a
  3-level parapet sits under the shoulder line); brightness is the separate
  `indoorlight.ts` dial. Probes `__ml.indoorCut(v?)` / `__ml.indoor()`.
  - **DO NOT GO BACK TO CULLING.** The first cut drew no roof, no near walls
    and a 32px "skirt" half of each far wall, and it shipped HOLES — wall slabs
    floating disconnected in the void, black wedges through a solid roof line
    (maintainer: "you introduced a lot of rendering bugs I have never seen
    before"). The failure is structural, not a tuning miss: culling has to ask
    "whose inward face does the camera see", and a room's own CORNER has no
    inward face, so no wall set can hold it and nobody draws it — likewise
    every T-junction where an interior partition meets an outer wall. Truncating
    has nothing to classify, so it cannot have that bug.
  - `shared/src/indoor.ts` publishes **`shell`** — the building, 8-connected,
    openings excluded. That is the ONLY set the renderer reads;
    `wallLeft`/`wallRight` survive as detector output with no consumer. The fill
    and the fringe stay 4-CONNECTED (a diagonal is not a step); `shell` is
    8-connected because a point-touch is a visible seam.
  - **The SURFACE resolve is clamped to the cut, the OCCLUSION march is not**
    (`nightlight.ts` `uIndoorTop`). What the camera sees is truncated; what the
    light travels through is not — the building is still solid to the sun, and
    a cut-away that let daylight through its own missing roof would light the
    room from above as you turned the dial. Skipping the surface clamp re-creates
    the roof-in-the-heightmap bug one level up: the floor behind a wall drawn at
    level 3 would resolve at 6 and every torch lighting it would be attenuated
    across 48px of gap that is not there.
  - **THE WHITE OCCLUSION OUTLINE** (`syncCoverOutline`) is the other half of
    the design, and it is not indoor-only: any body a parapet, cliff or tower
    covers gets a white silhouette ring (`HIDDEN_RING_COLOR`) over the hidden
    part, at depth 900_001.43. It is the exact COMPLEMENT of the lit copy —
    `syncLitCopy` crops to [0, coverY), this draws [coverY, bottom) — so the two
    tile the figure with no seam. Measured on the shipped house at 215,121:
    roof−1 hides 44% of the body, roof−3 24%, roof−4 5%, roof−6 (no walls) 0%.
- **INDOOR MODE → `scripts/verify-indoor.mjs`** (dev stack, ~3 min): the
  browser gate for "walk into a house and the roof comes off". It frames
  the_island2's house with ONE pinned camera from outside and from within and
  compares the two frames on REAL PIXELS at points derived from maps2'
  `world.json` (deck footprint + terrain levels, so a re-authored house moves
  the samples with it): the roof slab loses >40% of its luminance at every one
  of its cells; the ground outside the room is void at median 0 while the
  interior floor still carries art. Then the three that pin THIS design —
  **the mask is exactly floor + building** (the gate derives the 8-connected
  footprint from world.json itself, so a corner the client forgets is a failure
  and not a silent pass); **the building is SOLID**, every enclosure cell
  carrying art at its cut top (this is the assertion the hole bug would have
  caught); and **the dial IS the cut**, sweeping roof−1..4 and requiring the
  wall crown to fall by exactly one level (16px) each time. Then the OUTLINE,
  asserted as a monotone response rather than a magic number: a taller parapet
  must hide more of the figure and a cut that removes every wall must hide
  none. Then the LIGHT: at Day indoors the ambient is
  `[0.086,0.09,0.104]` — Rec.709 luma within 0.3% of the Night phase but
  B/R 1.21 against night's 1.87 — and the local torch is lit with the global
  day fade at 0 (a warm +0.74/+0.50/+0.28 at the feet, ~14k screen pixels
  brighter). Finally the two OUTDOOR controls: standing ON the same roof (the
  gate walks there off a wall top — teleport always lands on the base surface)
  and swimming UNDER a bridge both read outdoors with nothing blacked out.
  `SHOT_DIR=<dir>` keeps every frame it judges. TWO THINGS IT DELIBERATELY
  TOLERATES, both documented at the assertions: the ambient agent's fireflies /
  birds / bats (`games2/ambient/`, not this game agent's files) and footstep
  marks + grave crosses still paint over the void, so every "is it black?" test
  is a MEDIAN over a wide patch — scattered single pixels can't move it, a
  terrain tile that escaped the cull fills the patch and does; and the avatar
  itself is never hidden indoors, so sample points inside its drawn art box are
  dropped using Phaser's own `myScreen()` anchor.
- **Headless-GL starvation preflight**: verify-smoke measures raw keyboard
  speed first and ABORTS ("HARNESS STARVED") if the harness is too slow —
  software-GL at big viewports throttles the frame loop into slow motion
  that fakes "stuck player" bugs (this once cost an hour of ghost-chasing).
  Keep e2e viewports small (480×320); `scripts/debug-speed.mjs` measures.
- **HUD / visual QA runs at DEVICE-WIDTH mobile geometry** (the
  maintainer plays in normal mobile view since the wiki-style remake):
  Playwright `{viewport: {width: 393, height: 851}, isMobile: true,
  hasTouch: true}`. Check light AND dark (localStorage wiki-theme) when
  touching themed surfaces. Movement-timing e2e (verify-smoke) stays on
  its small fast viewport — the headless-GL starvation rule outranks
  realism there.
- Rule of thumb: if a check doesn't need pixels, pointer events, websockets,
  or Phaser anims, it belongs in `server/test` (3s), not in a browser (min).
- **Deploy** (push to main → live): the workflow runs a `test` job (typecheck
  + full unit/sim suite) IN PARALLEL with the layer-cached image build;
  `deploy` needs both. Triggers on games2/** AND on every art domain the
  image bakes (characters2/tiles2/maps2/objects) — art pushes deploy
  automatically (maintainer 2026-07-17; manual dispatches got old fast).
  The concurrency group collapses rapid art pushes into the newest run.
  NOTE: a maps2 push that uses an unclassified tile category will fail the
  check-surfaces gate and BLOCK its own deploy (prod stays on the previous
  revision) until games2 ships the SURFACES entry — watch for red runs. Dockerfile layers are ordered deps → art (per-domain)
  → game source LAST, and BuildKit's GHA cache means a code-only deploy
  uploads only the small source/build layers. Don't reorder the Dockerfile
  COPYs without thinking about which layer changes per deploy.
- **Loading screen** (`loading.ts`): select.ts shows it on "Enter world",
  WorldScene.preload feeds real asset progress, hidden when the player's own
  avatar joins (or on connection error; 60s failsafe so it can't trap).
- **Asset loading is SPLIT + deploy-pinned cached** (maintainer 2026-07-29:
  "loading for so long" after the 13-state animation overhaul ballooned boot to
  ~1200 frame PNGs): (1) preload fetches ONLY `BOOT_ANIM_STATES`
  (idle/walk/run/jump, `manifest.ts`); the 9 action states background-load via
  `loadDeferredAnims()` once the avatar joins (smoke's "deferred anims" check).
  (2) Every Phaser /assets URL is stamped `?v=<build sha>` (`assetver.ts`,
  VITE_GIT_SHA) and the server grants `immutable` 1y ONLY when the v matches
  its OWN GIT_SHA (same image bakes bundle+art, so those bytes can never
  change; mismatch → the old no-cache revalidate). Repeat loads hit the local
  cache with ~zero art requests; a new deploy = new sha = new URLs = fresh
  downloads — stale-cache-proof by construction, sw.js still caches nothing.
  Unversioned requests (dev, old clients) behave exactly as before.
  **DO NOT replace the global build sha with per-file or per-domain content
  hashes.** It looks obviously better (a tiles2 push stops invalidating monster
  strips; ~75% of deploys change no boot art at all, so the average reload
  would go ~11.2 MB → ~0.7 MB) and it was proposed and REJECTED 2026-07-31.
  The global sha is what makes the immutable grant *verifiable*: the server
  compares `?v` against its OWN GIT_SHA, so it can only ever freeze bytes it
  actually shipped. With per-file hashes it cannot verify anything cheaply, so
  it must trust any `?v` — which converts today's worst case (a 1-year cache
  entry that no deploy can heal). It also breaks the audio agent's `?v`
  stamping, leaves the ~2 MB of `client/public` art unstamped, and breaks the
  CI gate. If deploy churn ever has to be addressed, do it somewhere that
  cannot freeze a client for a year.
  (2b) **RESPONSES ARE COMPRESSED** (`server/src/index.ts`, brotli q4 / gzip 6,
  threshold 1 KB): ~2.5 MB off a cold load — the bundle 1.97 MB → 0.50 MB,
  `world.json` 737 KB → 37 KB, `monsters.json` 383 KB → 21 KB. Identical bytes
  reach the client, so nothing renders differently and nothing loads later.
  Images are NOT compressed (`compressible` returns false for `image/*`), which
  matters because a boot fetches ~940 already-compressed sprites.
  **THE BROTLI QUALITY PIN IS LOAD-BEARING — never raise it.** Measured on this
  bundle: q4 51 ms, q5 81 ms, **q11 5,252 ms**. q11 would stall a single request
  for FIVE SECONDS on this one Cloud Run core. `compression` 1.8.1 happens to
  default brotli to 4, but that is their default and not a promise, which is why
  it is pinned explicitly at the call site. If that middleware is ever swapped
  or rewritten, re-pin it. Safe for the 20 Hz sim: node's zlib STREAM api runs
  on the libuv threadpool, not the event loop — measured zero dropped ticks
  across 12 runs, including ten simultaneous cold joins (26-29% of a core).
  (3) **UI ART IS LOSSLESS WebP** (maintainer 2026-07-31, project default)
  and every piece of it is `withV()`-stamped. VP8L is bit-exact, so this is
  the same art — each conversion was verified by decoding back to RGBA and
  comparing arrays (`exact=True`, which also preserves the RGB under
  transparent pixels that libwebp is otherwise free to rewrite). The two
  logos went 1.26 MB → 922 KB; `select-bg` 1373 → 1009 KB; the tab icons and
  gold nugget to ~38% each. Stamping matters as much as the bytes: unstamped,
  every one of them cost a blocking revalidation round-trip on EVERY visit
  before the loading screen could paint. `scripts/bake-tab-icons.py` emits
  WebP — the rule for every domain is CONVERT AT THE SOURCE, never in the
  Dockerfile (that would add minutes per deploy and bust the layer cache).
  Two findings worth not re-deriving: PNG-8 palette is useless here (only 1
  of 240 sampled sprites has ≤256 colours), and the logo LOOKS like 6x pixel
  art but was upscaled SMOOTHLY — re-baking it at its native 181x105 grid
  would be 29 KB but costs a mean error of 22/255, so it is a soft render,
  not a clean pixel grid. `public/icons/*.png` deliberately STAY PNG (iOS
  ignores a WebP apple-touch-icon).
- **PWA**: `public/manifest.webmanifest` (display: fullscreen — installed app
  has no address bar; orientation: portrait-primary), `public/sw.js`
  (passthrough only, caches NOTHING — this repo fought stale-deploy bugs; the
  server's Cache-Control is the policy), icons from
  `scripts/build-pwa-icons.py` (committed). main.ts stashes
  `beforeinstallprompt` → select.ts shows "Install as an app" (Android).
  `verify-mobile.mjs` covers all of this headlessly.
- **"Desktop site"**: the CANVAS is still neutralized (dynamic integer
  camera zoom — `WorldScene.zoomFor`, probe `__ml.camZoom()`), but the
  DOM UI no longer compensates: the wiki-style UI is ordinary responsive
  CSS, exactly like the wiki page itself (the maintainer plays in normal
  mobile view). uiscale.ts remains ONLY for loading.ts + the toast.
- **LANDSCAPE + HANDEDNESS (maintainer 2026-08-05 — the WORLD plays
  landscape; title/select/loading stay portrait-only)**: in-game, on a
  TOUCH device, a landscape viewport turns the golden-ratio split on its
  side — the game view keeps 61.8% of the long axis at FULL height and
  the menu becomes a 38.2vw SIDE COLUMN with a VERTICAL tab strip
  hugging the game-view edge ("buttons always closest to the game-view").
  Which side is HANDEDNESS (`client/src/controls.ts`, localStorage
  `ml-hand`, DEFAULT RIGHT, Settings button "controls", change event
  "ml-hand", probe `__ml.hand(h?)`): the promise is the STICK's side —
  right-handed keeps the stick on the right in every orientation (the
  portrait layout the maintainer approved is exactly right-handed), so
  the landscape menu goes LEFT; left-handed mirrors everything. The
  MECHANISM is one function: `hud.ts applyLayout()` classes the root
  (`ml-ingame`/`ml-land`/`ml-lh`) and publishes px vars — `--menu-w`,
  `--hud-h` (0 in landscape, so every "above the HUD rail" consumer
  lands on the bottom edge), and `--gv-left`/`--gv-right`, the game
  view's insets. #game (index.html), the bars chips, the chat overlay
  and the clock pill all anchor off the gv vars and TRANSITION their
  anchor property, so orientation/handedness swaps glide (the animate
  nice-to-have; the column itself snaps — display swaps don't animate).
  ONE EXCEPTION to "corners stay corners": in RIGHT-handed landscape the
  time-of-day pill leaves the game view's bottom-right corner — that is
  the thumb stick's — and parks under the XP chip instead, right edges
  aligned, 10px below it (maintainer 2026-08-05). It reads --bars-r-h,
  the chip's MEASURED height, which bars.ts publishes from a
  ResizeObserver (theme font metrics + the gold row move it).
  Left-handed keeps the corner: the stick is bottom-LEFT there.
  ICONS ARE NOT ROTATED: the maintainer's "icons rotate 90°" described
  the locked-page mental model; the real re-layout keeps every icon and
  all text upright, which is the intent (a sideways backpack is not a
  backpack), and the gate PINS transform:none on them. GAMEPAD: in
  landscape the stick is REPARENTED TO <body> — visible and usable on
  EVERY tab, not just the gamepad page (maintainer 2026-08-05); a HUD
  rebuild clears strays first — floating in the game view's very BOTTOM
  CORNER on the thumb's side (gamepad.ts LAND_INSET, 38px — the centre the
  maintainer marked in red on two device screenshots, ~112 css px in from
  BOTH edges, equal margins by his instruction. MEASURE A DEVICE SCREENSHOT'S
  SCALE, NEVER ASSUME THE PORTRAIT DPR: his phone is 393 css px wide in
  portrait, dpr 2.75, but its LANDSCAPE viewport is ~988 css px = 2.28 device
  px per css px. Reading the marks at 2.75 said "move it 10px" when the real
  answer was 28 — he pushed back, and fitting a circle to the ghost's own
  blur disc in the screenshot settled it: r = 169 device px for the known
  148px well ⇒ dpr 2.284, shipped centre 186/188 device px from the edges =
  exactly the 84 css the old 10px inset gives), GHOSTED (see below) and BEHIND the corner chrome — position:fixed, z 4, under the
  chat overlay (5) and the pill/chips (8), all of which are
  pointer-events:none so the thumb steers straight through them; hidden
  with the page when another tab is up. THE GHOST IS TWO PAINTED PARTS, EACH WITH ITS OWN ALPHA
  (maintainer 2026-08-05, two rounds): .ml-pad-well (the basin) and
  .ml-pad-top (the inner ring/cap), inside a .ml-pad-stick frame that
  paints nothing. It HAS to be built that way — the cap must read
  STRONGER than the well, and a parent's group opacity can only ever
  make a child fainter (child effective = parent x child). Rest alphas:
  LIGHT well .15 / cap .25 (85% / 75% transparent), DARK well .4 /
  cap .5 (60% / 50%) — dark carries much further because a faint grey
  ghost vanishes against dark terrain. Dark is both the explicit
  data-theme AND the OS default (theme.ts deletes the attribute when
  following the OS), so every dark rule needs its prefers-color-scheme
  twin. WHILE HELD both parts go to 1 (.held on the frame; their
  opacity transitions are the only always-on ones) — and that rule is
  written :root.ml-land .ml-pad-stick.held ... ON PURPOSE: the dark
  rest rules carry an attribute selector, so the shorter form LOST the
  specificity race and the ghost stayed faint while held in dark
  (light won only by source order). It is also BACKED BY A BLUR DISC
  — the bars chips' same blur(5px), but as its OWN full-opacity
  transparent element (.ml-pad-blur, z 3) pinned to the stick's rect:
  backdrop-filter ON the stick cannot work, because the stick's opaque
  background paints over its own blurred backdrop and the 0.25 ghost
  opacity would dilute the remainder to nothing (a child or ::before
  inherits that opacity too). Portrait hides the disc — the stick sits
  on the opaque HUD page there. PICK UP stacks ABOVE JUMP on
  the menu column's centre line under the other thumb, and the vertical
  tab strip is CENTERED (equal top/bottom gaps). Portrait mirrors the
  stick/jump/pick-up fractions by hand.
  ANYTHING THAT POSITIONS ITSELF AGAINST ml-land / THE GV VARS MUST
  LISTEN TO "ml-layout", NEVER THE RAW RESIZE (maintainer 2026-08-05:
  left-handed players "always see and be able to use" the stick — but
  the bug was never handedness, it was WHICH TAB was open). applyLayout
  fires "ml-layout" as its last act; gamepad.ts's own resize listener
  is registered BEFORE hud's (WorldScene calls mountPageFrame AFTER new
  HudBar), so on rotation it read the PREVIOUS ml-land, skipped the
  landscape branch entirely and left the floating stick parented to a
  display:none page at 0x0 — invisible and untappable. A hidden page
  never resizes, so its ResizeObserver could not heal it either: the
  stick only reappeared when you opened the gamepad tab. Both hands
  were affected. Gate 4d rotates from portrait with the BACKPACK tab
  open, for each hand, and asserts the stick is body-parented,
  hit-tested at its centre, and actually steers the player.
  Page-RELATIVE writes in layout() are skipped while the page is
  display:none (its width reads 0 — the buttons would park at garbage
  coordinates and visibly correct on tab entry; the maintainer's
  backpack -> rotate -> gamepad repro is pinned frame-by-frame in the
  gate). The position glide is
  .anim-GATED and fires ONLY on a handedness change while the page is
  visible (maintainer 2026-08-05, twice refined: first "not when
  clicking from and to the game-controller page", then "the UI
  animation feels laggy when switching orientation" — a glide that runs
  DURING the rotation fights the canvas resize and the OS's own
  rotation animation).
  ROTATION SNAPS UNDER A VEIL (maintainer 2026-08-05, FIVE rounds —
  keep the arc, do not relearn it): anchor-transition glides, an
  outright snap and a FLIP pin-then-glide were ALL tried and rejected.
  The closing insight (round 5): Chrome/the OS already play their own
  rotation animation over the app's surface, so ANY chrome animation on
  top reads as a broken DOUBLE animation — "the menu shows up on the
  correct spot immediately and looks good", and the corner chrome must
  do the same. So on an orientation flip every anchor jumps straight to
  its final value (:root.ml-noanim pins the anchor transitions off for
  the whole flip); the HANDEDNESS glide stays (anchor transitions + the
  gamepad's .anim) — nothing else moves during a hand switch.
  **A TAP MUST STILL LAND WHERE YOU TAPPED AFTER A ROTATION** (maintainer
  2026-08-06). Phaser derives its pointer mapping — `displayScale` — from
  `canvasBounds`, filled from getBoundingClientRect() during ITS own resize
  pass. main.ts's fitCanvas sets the canvas CSS size AFTER that pass, so the
  cached bounds kept the PRE-rotation size: measured in landscape, the real
  canvas 526x393 against bounds still reading the portrait 393x526, giving
  displayScale 2.677/1.494 where the truth is 2.0/2.0 — every tap scaled by
  that error, ~98wu off in landscape and ~134wu after rotating back (0.0 in
  all three states now). fitCanvas calls `updateBounds()` and recomputes
  `displayScale` with Phaser's own formula (ScaleManager.js ~line 976,
  `baseSize / canvasBounds`). **Do NOT "fix" this with `scale.refresh()`**: in
  RESIZE mode its updateScale() re-derives gameSize/baseSize/canvas.width from
  the PARENT, throwing away the deliberate resolution scaling (a 393x526 box
  backed by 786x1052). fitCanvas also runs on `ml-hand`, because handedness
  MOVES the game view without resizing it — the ResizeObserver never fires and
  only the bounds POSITION goes stale. Gate: section 4e of verify-landscape
  (tap your own feet through portrait → landscape → portrait; the walk target
  must stay on you).
  What the flip machinery (hud.ts beginFlip) DOES own is the HEAVY part
  (rounds 3-4, from his frozen mid-rotation screenshots): a real
  rotation restages the viewport several times, and a full scale.resize
  per stage — framebuffer realloc + whole-world redraw, back to back,
  traced at ~2s PER resize — stalls the main thread so long the OS
  composites stale letterboxed frames. main.ts fitCanvas therefore
  holds fire while :root.ml-flip is up — AND, because the #game
  ResizeObserver delivers BEFORE the resize event that starts the flip
  (traced: it beat beginFlip by 3ms), also whenever in-game + touch +
  the viewport aspect disagrees with ml-land. A THEME-SURFACE VEIL
  (.ml-flip-veil, z 3 — over the canvas, under stick/HUD/chat/chips)
  hides the stale-sized world; at quiet (~300ms without a resize) the
  controller emits ONE "ml-flip-flush" and the canvas re-fits in a
  single resize under the veil; after two calm frames (hard cap 2.5s)
  the veil fades, revealing the world with every piece of chrome
  already exactly where it belongs. The in-game html/body also wear the
  THEME background (index.html ships #000 for the pre-game screens), so
  any page the browser exposes mid-rotation reads as surface, not a
  black hole. Gate sections 4b + 4c (verify-landscape) watch a clean
  and a STAGED rotation frame-by-frame from inside the page: zero
  transforms and zero glide classes on the chrome, the veil up during
  and gone after, ZERO canvas resizes before the flush, the single
  re-fit after, and the pill on its true final anchor. The gate's
  settle() treats a live veil as "not settled".
  LANDSCAPE COLUMN SIZING (same round, from device screenshots): tabs
  keep their full 56px in landscape — the global ≤640px-HEIGHT rule was
  written for short PORTRAIT phones but every landscape phone is under
  640px tall, so it silently shrank the strip (a media ≤388px height
  keeps 48px for genuinely tiny screens); the strip is 84px wide; the
  BACKPACK grid turns with the layout (3 wide × 5 tall via
  :root.ml-land .ml-slots, capped 320px); and the keyboard-floated Chat
  page input takes the gv insets so it floats INSIDE the game view
  instead of spanning the whole screen. The backpack grid's width cap is
  HEIGHT-derived (calc((100dvh − 72px)*0.6 + 20px)) so all five rows fit
  without the "ugly 1px scroll"; the MAP sizes itself to the SHORT
  viewport side minus margins in landscape — the same size portrait
  gives it — and .ml-map's overflow:hidden clips the open-water sides
  evenly (the frame stays == the image box, so the you-are-here dot's
  percent offsets keep landing true). A ONE-TIME help chip on the
  gamepad page points at Settings → controls; the × dismisses it forever
  (`ml-hand-help`), it's an absolute overlay so it can never move the
  controls, and its BODY is pointer-events:none so it can't eat their
  input either (on a short viewport it can lie over the stick — caught
  by verify-gamepad). Desktop (no touch — `touchDevice()`, shared with
  the keyboard lift) keeps the portrait split at ANY aspect, which is
  also what keeps every 480×320 desktop-context e2e gate on the portrait
  coordinate model. Gate: `scripts/verify-landscape.mjs` (both hands,
  portrait return, floating-stick input path, help persistence, desktop
  immunity; reads settle-polled — the anchors transition, and the
  starved compositor reports mid-flight values long after wall-clock).
- **Portrait-only OUTSIDE the world**: the `#ml-rotate` prompt
  (index.html media query — coarse pointer + landscape + max-height
  520px) still covers the title/select/loading screens; `html.ml-ingame`
  (set by mountPageFrame) suppresses it in the world. The manifest is
  `orientation: any` now (was portrait-primary), AND — the real gate —
  main.ts's boot-time `screen.orientation.lock("portrait")` (which
  covers the installed app's pre-game screens) is RE-LOCKED to "any" by
  mountPageFrame when the world mounts: that boot lock silently kept
  the phone portrait in-game no matter what the manifest said
  (maintainer: "nothing happens when I tilt"). Logout reloads, so the
  portrait lock returns for the select screen. In a browser tab both
  lock() calls reject harmlessly (not fullscreen) and rotation is
  native. An already-installed WebAPK may also need a reinstall to shed
  the OLD manifest's lock, and Android's system auto-rotate must be on.
- **Dead-connection recovery**: backgrounding a phone tab freezes JS; the
  server drops the client and the room turns into a ZOMBIE (no patches/acks
  — prediction replays an ever-growing unacked history; the old "teleport
  when jumping uphill after tabbing back" bug). `room.onLeave` (WorldScene,
  ignoring real unloads — pagehide fires first) triggers an IN-PLACE rejoin
  (`handleDrop`): "Reconnecting…" toast, joinWorld again (immediately when
  visible, else on visibilitychange), old avatars + prediction state
  dropped, `bindRoom` rewires the new room; NO page reload (phones
  background constantly — reloading meant the whole loading screen every
  time). Input sending is frozen while disconnected (flushInput guard).
  Retries back off; only after 6 failures does it fall back to a reload
  with `ml-rejoin` set (main.ts then skips the select screen using
  `ml-last-choice`). NOTE: `room.state.players` is undefined until the
  first patch — never touch it right after joinOrCreate resolves. Probe:
  `__ml.dropConnection()`; regression: `scripts/verify-reconnect.mjs`.

## Conventions

- `npm run dev` runs server + client. `npm test` = headless two-client sync test.
  `npm run typecheck` per package. Work from `games/nangijala/`.
- **PIXEL ART SCALES NEAREST-NEIGHBOUR ONLY — everywhere, always**
  (maintainer, repeatedly): `image-rendering:pixelated` on every art
  img/canvas, Phaser nearest filtering, `imageSmoothingEnabled=false` in
  canvas code, and nearest in QA/preview scripts' zoom helpers. Offline
  pipelines may box-average ONLY when BAKING an asset down to its final
  display resolution (a downscale bake whose output then renders 1:1);
  nothing ever upscales with smoothing. When KEYING/extracting art,
  finish every cut edge with SOFT ALPHA — outer silhouette AND interior
  holes (flood the outside, then clear enclosed backdrop components,
  then let the bake average the boundary) — never a hard 100%->0% alpha
  step (maintainer; the ornate clock hand's ring hole shipped opaque
  black once).
- Keep shared movement/direction math in `shared/` — never duplicate it.
- Server is authoritative; never trust client positions.
- Tests stay headless (node + Colyseus, no browser); browser checks go through
  `scripts/verify-*.mjs` (Playwright).

## The loop (loop/)

`loop/LOOP.md` is the runbook run on a schedule. Each iteration: `git pull`
(latest art from all agents) + regenerate the manifest, keep ≥15 open GitHub
issues on `mikael-floden/pixel` (label `game`), implement the best one, keep
`npm test` + typecheck green, commit + push to `main` (rebase on reject).

## Don't

- Don't touch the map/background/environment/tileset/world art (that's the maps
  and tiles agents' domains). You may improve the tile **renderer** (occlusion,
  collision, input feel — #28) but do not redesign or hand-author world art.
- Don't edit anything outside `games/` except your own `coordination/games.json`.
- Don't push red — `npm test` and `npm run typecheck` must pass first.
