# CLAUDE.md — Nangijala working notes

## THE CONTENT SPLIT — what ships vs what is staging

The art domains generate far more than the game uses (scenery ships 2,644
files; the game reads THREE). The image contains only what the published
worlds can reach (maintainer: "the real game will only ever include what's
inside the actual real game").

- **`games2/config/publish.json`** — the ONLY hand-maintained part: published
  worlds, playable characters, the three game-referenced scenery pieces.
  Everything else is DERIVED.
- **`games2/scripts/shipset.mjs`** closes over those roots: a published world
  drags in its `paths[]` tiles, its NPCs' character art, its spawn zones'
  monsters. `--report` prints the savings table, `--check` fails on a
  reachable-but-missing file, `--emit <dir>` materialises the curated root.
  The Dockerfile's **`curate` stage** runs `--emit`; the final image copies
  from it, one layer per domain. Measured: 212.7 MB → 59.7 MB.
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

**THE TILE ATLAS.** A maps2 world boots from 1-2 committed sheets instead of
one HTTP request per tile (571 for the_island2).

- `scripts/build-atlas.py` packs each world's `paths[]` into **lossless** WebP
  sheets under `client/public/atlases/` (lossless+exact per repo law — the
  maintainer reviewed a lossy q85-q95 ladder on real sheets and ruled: **stay
  lossless**), self-verified byte-for-byte per frame, two-band shelf pack
  (tiles are 64×64 / 64×128), deterministic. `npm run atlas`; `-f` forces.
- **The work is never repeated**: atlases are committed, content-addressed by
  a digest over the tile list AND every tile's bytes; the packer skips
  matching digests. Deploys only VERIFY (`scripts/check-atlas.mjs`, wired into
  `npm run manifest` and the Dockerfile). A STALE atlas is **pruned, not
  failed**: the client's index fetch 404s and it falls back to per-file tiles
  — slower, never wrong pixels, never a red pipeline.
- `client/src/tileatlas.ts` is a LOADING strategy only: sheets are sliced into
  per-path canvas textures under the exact `t2:<path>` keys per-file loads
  produced, so no draw site (ground RT, occluders, debris, flippedKey) can
  tell which path ran; any failure degrades to individual loads. Probe:
  `__ml.atlasInfo()`. Gates: `verify-atlas.mjs` (zero individual tile-art
  requests on boot, all sliced, world renders); verify-indoor doubles as the
  pixel canary against atlas-sliced textures.

**STAGING WORLDS.** The image ships `userWorlds` ONLY; every `devWorlds` map
is streamed from the repo when an admin joins — a dev map costs production
ZERO bytes (the leak this stops: 57 monsters in monster_demo dragged 16 MB of
monster art in; measured 89.5 → 105.4 MB).

- CLIENT: `client/src/staging.ts`, one chokepoint `gameUrl()` — identity
  function when inactive (a normal player's path is byte-identical). Activated
  (main.ts, chosen world not in the build) it rewrites `/assets/**`,
  `/atlases/**` and the manifests to the sha-pinned jsDelivr base;
  `mergeStagingEntries` folds the repo's full monster/NPC manifests over the
  image's, rewriting only ADDED entries' URLs.
- SERVER: `WorldRoom.readWorldDoc` — **disk first, always**; only a name the
  image lacks hits the network. Required: the server is authoritative
  (collision + spawn zones), so browser CORS alone can never make an unshipped
  map joinable.
- Both bases are INJECTABLE (`ml-staging-base`, `STAGING_WORLD_BASE`) — the
  sandbox denies headless-browser egress, so the gate points at a local
  fixture origin.
- Gate: `verify-stagingworld.mjs` joins a world existing ONLY on the fixture,
  named `staging_probe_<t>` unique per run (Colyseus keeps a room per world
  name; a reused name rejoins the old room). Asserts the server half (fixture
  spawn cell + monsters) AND client half (all tiles from the fixture, ZERO
  requests for that world to the game origin). Fixture is monster_demo, NOT
  house_demo (house_demo ships zero spawn zones — it can only fail).
- `check-atlas.mjs --ship` drops non-published worlds' atlases from the image
  (18 MB → 1.7 MB).

**AR RETENTION**: `deploy/ar-cleanup.sh` — a server-side Artifact Registry
cleanup policy (keep newest 15 versions, delete >14 days), pasted once into
Cloud Shell from a phone. No CI job, no credentials, can't break on a red
pipeline.

## What this is

**Nangijala** is a browser-based **multiplayer** (MMO-style) pixel-art RPG:
everyone joins the **same shared isometric world**. It lives in the `pixel`
monorepo at `games2/` and renders the sibling agent domains' art
(`characters2/`, `tiles2/`, `maps2/`, `scenery/`). **Read-only toward the
art** — never edit those directories (`coordination/PROTOCOL.md`; this game
owns `games2/` + `coordination/games.json`). Developed by a self-iterating
loop — `loop/LOOP.md`. Since 2026-07-17 TWO agents work `games2/`: the
**games agent** (gameplay/netcode/world/server) and the **games-ui agent**
(HUD, menus, screens, overlays; board `coordination/games-ui.json`) — the
per-file ownership split is `UI_AGENT.md`. (First-generation
`games/`+`characters/`+`maps/`+`tiles/` retired 2026-07-14; history in git.)

## Tech stack

- **TypeScript npm-workspaces**: `shared/`, `server/`, `client/`.
- **Server** (`server/`): Node + **Colyseus** authoritative `WorldRoom` with
  the single shared `WorldState` (map of `Player`s). Clients send `input`; the
  server integrates on a 20 Hz tick (`shared/stepMovement`) and syncs state.
  Persistence in `store.ts` (returning players keep their spot by token).
  Plain `tsx`; the schema is decorator-free (`defineTypes`, not `@type`) — no
  `experimentalDecorators`/Node-version fragility.
- **Client** (`client/`): **Phaser 3** + `colyseus.js` (Vite). Client-side
  prediction + reconciliation; chat + roster; renders the isometric world.

## Assets (served at /assets)

- Art is read from the repo-root sibling domains — NOT copied in. Dev (Vite
  middleware in `client/vite.config.ts`) and prod (`server/src/index.ts`) both
  serve `/assets/<domain>/…` from `characters2/ tiles2/ maps2/ scenery/`
  (`ASSETS_ROOT` overrides, e.g. in Docker).
- `scripts/build-manifest.mjs` scans `characters2/humans/` →
  `client/public/characters.json` (uid, name, frame size, per-anim/dir counts,
  urls); `build-worlds.mjs` discovers `maps2/worlds/*/world.json` →
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
  4. `tiles2/docs/`, `lore/icons/` — documentation art.
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

## Isometric world

- `shared/parseWorld` reads `maps2/worlds/<name>/world.json` — **world@1**
  (materials/paths/top/level/mat grids + props + spawn + size; legacy
  `rows`/bigworld@1 still parse). Geometry: `x=(col-row)*32`,
  `y=(col+row)*dy − level*lh`, painter order `(col+row,row)`. World units:
  **32 per cell** (`CELL_WU`); WORLD_WIDTH/HEIGHT are sized to the grid.
- The world is too large for one texture: `WorldScene` streams a
  world-anchored ground RenderTexture covering screen + `GROUND_MARGIN`,
  redrawn when the camera nears its edge. `MapPreviewScene` (`/#map`) shows a
  world's pre-rendered minimap when shipped.
- **Anti-tiling: NONE, on purpose.** Varying tiles is the maps agent's job —
  this repo never swaps a cell's art. REJECTED and fully rolled back: a shader
  seam-smear AND a brightness "ground wash" (maintainer wants the fresh,
  effect-free ground). Do not reintroduce any ground repetition effect.
- **world@2 decks** (elevated walkable slabs — roofs, bridge spans): strict
  superset of world@1 (`parseWorld` optional `decks`; `Deck`/`DeckCell`). A
  deck is a SECOND surface floating over unchanged base terrain (walk/swim
  UNDER it). `redrawGround` draws each deck cell right after its base cell:
  `thickness` face tiles then the `top` diamond at `level`. Spec:
  `maps2/spec/WORLD_FORMAT.md`; only `occlusion_test` ships decks.
  - **Current-layer movement**: each `Player` carries `elev` (surface LEVEL);
    `shared/canEnterElev`+`resolveElevAt` offer a deck cell TWO surfaces and
    keep you on whichever is reachable and closest to your current elev — you
    cross a bridge/roof instead of falling through; under-walkers stay on the
    base. Non-deck cells resolve exactly as `canEnter` (world@1 unaffected). A
    deck stays walkable over a blocked base.
  - **Tap-to-move is deck-aware**: `pickGround` returns the deck when tapped;
    `findPath` searches a LAYERED graph (node = (cell, base|deck)), threaded
    through `startTrip`/`stepAutopilot` as `fromElev`/`goalLevel`.
  - **Deck lighting**: the night shader's SURFACE heightmap reports the deck
    level, and the avatar's lit-copy tint samples the light field at the
    avatar's RENDERED elevation (`a.elev` px → levels, same basis as the torch
    z) — NEVER the base terrain level (sampling the base marched the sun ray
    into the roof and rendered a roof-walker shaded in daylight). Under-deck
    walkers sample the base. Gates: `scripts/verify-deckwalk.mjs` (in
    `npm test`), `scripts/verify-decklight.mjs` (every deck TOP lit at Day
    while the base under it is shaded). Probes: `__ml.deckInfo()`,
    `__ml.me().elev`, `__ml.litInfo()`.
  - **Deck-aware follower**: the follower's per-heading openness probe builds
    its blocked predicate with `makeBlockedElev` carrying the player's surface
    `elev` — the SAME rule the body integrates with. (Base-only `makeBlocked`
    read the water under a bridge as the "from" level and every exit looked
    like a cliff — maintainer: "runs up and down, can't get over the bridge".)
    Gate: navigation.sim.test.ts "leave the bridge onto same-level ground"
    (fails 4/40 stuck on the base-only baseline).
  - Seeing yourself under a deck (house/cave interiors) is INDOOR MODE — see
    that section.
- **SEE-THROUGH WALLS IS DELETED — never reintroduce a per-frame occluder
  alpha sweep.** The prototype ([7] key, "see-through walls" switch,
  `occFade`/`occFocus`/`occApply` probes) swept the whole live occluder set
  per frame (getData + setDepth + setAlpha over 3.9k images; every setDepth
  re-queues Phaser's display-list sort) — **1.33 ms/frame while the feature
  was OFF**, and it never looked good. Replaced by INDOOR MODE (decides per
  CELL) + the WHITE OCCLUSION OUTLINE (one image per covered body). The
  `"ot"`/`"od"` occluder tags went with it; `tagOccluder` stamps the cell
  only. History in git.
- **Occluder view-cull + deck exposure** (`rebuildOccluders` destroys and
  recreates the whole set when the camera drifts `OCC_STEP` = 96px):
  - Deck cells get the exposed-face rule via `deckCoverFrom`, comparing BANDS
    (a slab covers `[level-thickness, level]`; only a CONTIGUOUS run reaching
    my own bottom hides my faces). Without it every face level of every deck
    cell drew — the_island2's 16-32-level cave decks were ~65% of the mountain
    window's images.
  - Each face/top image is skipped unless it lands in the camera view grown by
    `OCC_CULL_PAD` (a rebuild step + a tile + the widest body art box).
  - **Do NOT make `stackFrom` deck-aware** — deck-blind ON PURPOSE. Deck cover
    is a band, not a prefix; a naive deck-aware variant cuts 4,748 terrain
    faces on the_island2 that nothing covers. Over-drawing under a deck is the
    safe direction and costs 0 faces on shipped worlds.
  - Why culling is safe: occluders never contribute terrain pixels (the ground
    RT at depth −1,000,000 paints all of it); they exist so bodies can
    interleave, so over-culling can only mis-sort, never leave a hole. The
    real invariant is `occluderMeta` (one record per CELL, never culled — what
    `resolveBodyDepth` reads for depth/`coverY`): **a meta record overlapping
    the view must still have drawn art behind it**. Hence the TOP image is
    kept whenever the whole COLUMN reaches the cull box (`columnShows`) —
    per-tile culling left 94 uncovered columns.
  - Probe `__ml.occAudit()` checks against Phaser's own `getBounds()` and the
    camera's `worldView` (never the cull arithmetic): `metaWithoutArt` must be
    0 (props excluded — they draw from `propImgs`, never culled). Measured:
    13,521 → 3,885 images at the mountain; `coverY` under every thick cave
    slab bit-identical to pre-cull. Gate: the occluder block of
    `verify-smoke.mjs` on `occlusion_test` (the only compact world with BOTH
    level-32 terrain and decks), standing and walking.
  - STILL OPEN: this cut the image COUNT, not the churn (~92% of the set is
    identical between rebuilds; worst walking frame 971 → 784 ms). The
    remaining spike is destroy-all/create-all + `redrawGround`'s own
    unconditional deck face loop (~9,000 extra `batchDraw`s per redraw).
    Next: pool the images or trim the RT — the RT trim is NOT a drop-in (it
    skips void cells).
- `stairs` tiles are ramps (crossing one allows a full 1-level step without
  jumping); solid structure tiles (trees, boulders, obelisks, watchtower,
  cactus, lava) are impassable — `SURFACES`/`surfaceFor` (`road_*` by prefix).
- **Movement (#17)** is server-authoritative and governed by **elevation**,
  not tile category: `buildTerrainGrid` reads each cell's `l` + category;
  `canEnter` allows a move if the destination is enterable and the UPWARD step
  is within the climb allowance — dropping any height is free. Design
  "Option 2B": `WALK_CLIMB = 0.5` (no walking up a full 1-level ledge); a
  timed **jump** (`JUMP_CLIMB = 1`, Space) climbs it. `stepMovement` resolves
  axis-separated (wall-slide), scaled by the current surface speed.
- **Steer assist** (`shared/steerAssist`): running DIRECT input (WASD/HUD
  stick) into a SOLID PROP dead-stops even when the player obviously meant to
  pass beside it. Deliberately NOT navigation: on a real stall, inspect ONLY
  the tiles beside the ONE blocked cell — if the perpendicular neighbour is
  open walkable ground, deflect input to the CLOSEST such side until the body
  clears the corner. Wall of solids / dead end → honest collision. Elevation
  ledges excluded (auto-jump's domain); the autopilot never uses it. Grounded
  in REAL `stepMovement` sims (incl. the 0.75R corner probes). Probe:
  `__ml.steerAt(x,y,ax,ay)`; tests: `server/test/steering.test.ts`.
- **Terrain-wall steer assist — the door-finder** (`steerAssistWall`, called
  when the stall is not a solid prop; maintainer: "find the closest path
  around taking the player forward … helps when the player doesn't aim at the
  door exactly right"): on a stall against terrain even a JUMP can't climb
  (1-level ledges stay auto-jump's), hunt up to `STEER_DOOR_RANGE` (4) cells
  laterally along the wall — nearest opening either side — and deflect purely
  sideways, re-evaluated every tick. The slide LANE is checked cell by cell (a
  door behind a boulder is not a door); the opening must LEAD FORWARD (cell
  beyond enterable at jump climb — else an alcove attracts); no candidate may
  sit a DAMAGING drop below the feet. No opening → null, honest collision.
  Tests: the terrain-wall block of steering.test.ts.
- **FALL DAMAGE + THE NO-FALL ROUTING LAW** (maintainer: "the nav system
  should at any cost avoid fall damage"). One line: `FALL_DMG_MIN_LEVELS` = 6
  (a house roof). Three layers:
  - **Curve** (`shared/combat.ts fallDamageFrac`): linear from 6 levels = 10%
    of MAX hp through 32 levels (the_island2 summit) = 95%; ~34 levels crosses
    100% and kills from full health. Monotone.
  - **Route** (`stepReach`): a step dropping ≥ 6 levels is not an edge — for
    walks, deck dismounts and diagonal flanks alike. Water landing is NOT
    exempt in routing (the pathfinder can't promise arrival IN the water).
    KNOWN CONSEQUENCE: the island house's roof and floor are reachable from
    DISJOINT regions, so beacon rule 2's real-world case became one-sided —
    its test uses a synthetic both-arrive fixture (beacon.test.ts).
  - **Landing** (WorldRoom, on the input integration's elev resolve ONLY —
    teleport/respawn/join assign elev directly and never bill a fall): a drop
    ≥ 6 levels costs `round(frac·hpMax)` through the standard `hurtPlayer`.
    Landing in SWIMMABLE water is a dive — free. Walking off a cliff manually
    is allowed; the damage is the price.
  - Gates: `server/test/falldamage.test.ts` (curve pins; the_island2 route law
    verified failing on the pre-fix baseline; live-room cliff + dive).
- **Auto-jump**: walking INTO a 1-level wall auto-fires the jump
  (`maybeAutoJump`/`wouldAutoJump` from `predictAndSend`). Rule: exactly
  `!canEnter(walk) && canEnter(jump)` probed a leading-edge ahead — 2-level+
  walls and solid props are left alone; flat ground never fires. Client-only
  (queues the same jump input the server validates); `tryJump` still gates on
  grounded+cooldown. Probe: `__ml.autoJumpAt(x,y,ax,ay)`.
- **Collision probes** (`stepMovement`): per axis, the forward CENTRE probe
  applies the full rule (`makeBlocked`); the two LATERAL corner probes
  (±`PLAYER_RADIUS*0.75`) apply `makeSideBlocked` (solids only) and are STRICT
  — the "escape-permissive" variant (compare probe cells current-vs-target)
  was REJECTED: for normal steps both land in the same cell, which disabled
  lateral prop collision and let bodies drift into footprints. Integration is
  SUBSTEPPED (~4wu chunks): probes refuse an axis whose leading edge at the
  step's END is blocked; one 100ms run input (`MAX_INPUT_DT`) reaches ~30wu
  and pre-substep froze the body far from the wall. Test: "big-dt input
  advances to contact instead of freezing a step early". Bodies inside a
  solid's margin (fall landings, spawns, history) are freed by
  **`unstickFromSolids`** (shared): smooth, speed-limited push along the
  away-gradient, run by the SERVER before each input integration and mirrored
  by client prediction (`stepLocal`). **Never weaken the probes to fix a
  wedge** — unstick is the escape hatch. Tests in collision.test.ts.
- **Edge feel / falling**: feet walk to the rim (no early commit, no anchor
  snap); once the centre crosses to the lower cell the descent is a gravity
  FALL animated client-side — `WorldScene` keeps each avatar's elevation lift
  (`elev` px) apart from the flat projection and integrates with shared
  `integrateFall` (up-steps snap, stair-sized down-steps ease, cliffs fall;
  shadow stays on the landing ground). `makeDrops` is the canonical "is this
  a fall" predicate. Tune: `FALL_GRAVITY`/`FALL_TRIGGER_FRAC`.
- **Surfaces** (`SURFACES` in `shared/`): per-category
  `{standable, swimmable, speed, sound}` — roads faster, sand/snow slower,
  water swimmable. Unknown categories default to plain walkable ground.
- **Swimming**: water is free locomotion — see the Swimming section. The old
  stamina/drown system is RETIRED server-side (`stepStamina`/`SWIM_DRAIN`
  survive in `shared/` with no live caller; WorldRoom only mirrors
  `player.swimming` from the surface — deck-aware: not when on a bridge over
  water).
- Client rebuilds the SAME grid and predicts jump/swim/speed so nothing
  rubber-bands. Tune feel via the `*_CLIMB` constants and `SURFACES`.
- **Direction display is hysteretic** (`WorldScene.stableDir`): adjacent (45°)
  changes must persist `DIR_STICK_MS` before the sprite turns; 90°+ turns
  switch instantly; a direction-only clip change resumes at the same loop
  progress (no stride restart). Display-only — movement math untouched.
- **Controls are screen-relative**: `stepMovement(..., screenInput)` rotates
  input by the projection ratio (`ISO_DX`/`ISO_DY` in `shared/`; the client's
  `MAP_GEOMETRY` imports them so they can't drift) — Up walks straight up on
  screen; facing uses the raw screen vector. **Grid-axis lock**: a diagonal
  press snaps the world move to the nearest tile axis
  (`screenToWorldVector`) so corridors/bridges track true; single keys stay
  screen-cardinal.
- Open follow-ups (#28): occlusion behind tall tiles; half-level (0.5)
  stair/ramp tiles from the maps agent. If the tile "house format" changes,
  re-measure `MAP_GEOMETRY` and update `ISO_DX/ISO_DY`.

## Animation playback (anti-moonwalk)

- **State→art mapping is the art domain's contract**: `build-manifest.mjs`
  resolves each game state to its PixelLab folder via
  `characters2/animation_map.json` (per-hero `overrides` win). A PixelLab
  rename = edit that file + regenerate the manifest; no game edit. **ONE jump
  state** (maintainer): the steeplechase leap plays for standing AND running
  hops; its once-through rate is DERIVED per character (`frames / JUMP_MS`) so
  the clip spans the ~500ms hop whatever the art ships (a fixed 18fps froze a
  4-frame clip mid-air). Gates: `verify-jump.mjs` + the smoke's jump/anim-rate
  sections (keep e2e viewports SMALL — at 900×600 headless starvation faked
  "jump never plays").
- Walk/run rates are MEASURED — ONE rate per (character, gait), same cadence
  in all 8 directions (per-direction rates were measurement noise and popped
  on turns). `build-manifest.mjs` finds foot blobs, takes max foot spread over
  a cycle = the STEP, derives `fps = speed × frames / stride`, stride = 2
  steps (screen speed is direction-uniform: WALK 70 / RUN 175 px/s at zoom 1).
  RUN divides the stride by a ~0.55 stance fraction (runners cover ground
  AIRBORNE, which static frames can't encode — without it the formula demanded
  22-30fps; a SAD strip-matcher also under-measured strides). Output `gaitFps`
  in characters.json, applied in `buildAnimations` (fallback ANIM_FPS).
- Rate ∝ CURRENT **WORLD** speed: `applyAnimState` sets `anims.timeScale` to
  the avatar's EMA'd world-units speed (`av.spdWu`, back-projected from the
  eased screen delta) over the gait's side-view reference (base·√½ ≈
  49.5/123.7 wu/s). WORLD, not screen, on purpose: uniform screen speed means
  a screen-north walk crosses ≈2.13× more world ground per second than east —
  N/S legs pace 2.13× faster, key diagonals 1.28×, and water slowdown /
  easing / autopilot pace changes keep footfalls planted. MOVEMENT SPEED IS
  UNTOUCHED — playback only. Probes: `__ml.animRate(uid,state,dir)`,
  `__ml.timeScale()`, `__ml.worldSpeed()`, `__ml.gaitSample()`; gates:
  `verify-animrates.mjs`, `verify-gaitsync.mjs` (ground per cycle == design
  stride on both headings; residual stance foot-slip is by design).

## Swimming (WorldScene + shared nav + build-manifest)

Water is free, sustainable locomotion (NOT a hazard): `findPath` treats it as
~1.8×-slower terrain; a tap ON water is a valid destination; the server only
mirrors `player.swimming` — no stamina, no drown. (Water is also the player's
combat sanctuary — see Combat.)

The swim LOOK: the character FLOATS with a per-direction SHOULDER WATERLINE at
the surface — head + shoulders above, below clipped, no shadow, head bob, idle
clip, no tint.
- Waterline data: `shoulders[dir]={lx,ly,rx,ry}` (frame fractions; the line
  can tilt). HAND-DRAWN by the maintainer (finger → least-squares fit,
  registered via dot markers), committed in `data/waterlines.json`, merged by
  build-manifest (override wins; `shoulderLine()` auto-detect is the fallback
  for un-annotated characters). Regenerate the manifest after edits.
- FLOAT: for a water cell the fall target is `surfLevel·lh − swimDrop` —
  RELATIVE TO THE POOL'S OWN SURFACE, never absolute (elevated lagoons exist;
  an absolute target sank a level-4 pool's swimmer the whole pool height).
  Gravity fall carries the body through the surface and stops at the shoulder
  line (buoyancy). `swimT` (0..1) = `(surfLevel·lh − elev)/swimDrop` drives
  the clip cut from FEET (just entered) to SHOULDERS (afloat).
- CLIP: `updateWaterClip` builds a geometry mask above the waterline on the
  base sprite AND the lit night copy. The line is a shallow downward BOW
  (`BOW_FRAC` × body span) centred on the opaque span it crosses
  (`waterlineSpan`) so the cut wraps the volume; the mask polygon samples the
  curve with straight baseline extensions. Uses `av.dispDir`.
- FOAM (`foamTexture`): per-frame frame-space texture on the SAME curve — 1px
  white crest + 2px dark water per column, honouring the silhouette, faded
  ends; tinted by local night light; animated by rocking the curve ±≤1px
  (`FOAM_ANIM_MS`); light-only.
- QA: `__ml.swimming/swimT/myDispDir/swimDebug` (swimDebug returns the clip
  line in SCREEN coords). Measure the clip AT REST — a mid-motion capture
  skews probe vs screenshot by a few frames and fakes an offset.

## Footstep marks (client/src/footsteps.ts)

- Every foot PLANT stamps a ground mark at the exact drawn spot; style by tile
  type; fades over ~5s.
- Plants are measured OFFLINE (`build-manifest.mjs:plantsOf()`): a grounded
  blob (size ≥6, maxY within 2px of the sole line) is a PLANT at frame `i`
  when no grounded blob sits within ±6px x at `i-1` (cyclic) but one does at
  `i+1` — the `i+1` persistence check killed 6-7/cycle over-detection down to
  the true ~2-4. Shipped as `plants: {walk|run: {dir: [{f,x,y}]}}`; both feet
  emit (a dir can list the same frame twice).
- Runtime: `onPlantFrame` on `ANIMATION_UPDATE`, frame index parsed from the
  `f:<uid>:<state>:<dir>:<n>` texture key; frame pixel → world THROUGH the
  sprite origin/scale (`wx = sprite.x + (px − originX·frameW)·scaleX`, `wy =
  sprite.y + (py+1 − originY·frameH)·scaleY`) so the mark lands under the
  DRAWN foot. Surface = `surfaceFor(cell.t).sound`; swimmers leave none.
  Remote players stamp too.
- Style per sound id + MATERIAL (`styleFor`): tints chosen for CONTRAST, not
  match — a dark ground reveals a lighter SUB-material (maintainer). Grass →
  DIRT through the blades (`fs-pair` ≈ `#9c7d4f`); `stone` keeps its dark
  scuff (`fs-dot` `#141418`); only near-black `black_mountain` overrides to
  lighter stone dust (≈ `#9a9aa0`); sand/snow/ice get darker/cool presses.
  Marks draw below the night overlay (contrast holds at night); foot-width
  ~7px; depth `y-0.5`; pooled + capped 240; peak alpha ~2s then quadratic
  ease-out. Probes: `__ml.footprints()`, `__ml.footprintsList()`,
  `__ml.myScreen()`. QA on trans_demo's flat material bands.

## Monsters (client rendering = the SHARED body pipeline)

- **Spawn placement is MAPS2 DATA**: every world ships
  `maps2/worlds/<name>/spawns.json` (`pixel-maps2/spawns@1`, spec
  `maps2/spec/SPAWNS.md`) — polygon zones `{id, monster, area, elev, num}`.
  The game's old hardcoded rectangles are DELETED. `shared/monsters.ts` does
  the pure geometry (`parseSpawns`/`pointInZone` even-odd/`zonePolygonCells`);
  `shared/buildZoneRuntimes(grid, zones)` resolves zones against terrain (a
  cell qualifies on whichever surface — base OR deck — has its level in band
  and is enterable; a zone with more swimmable than standable cells is a WATER
  zone → its monsters get `canSwim`). WorldRoom seeds `num` per zone, roams
  via zone-cell targets within `MONSTER_ROAM_RADIUS_CELLS`, snaps escapees
  back. **Missing spawns.json → no monsters** (maps2 owns placement; nothing
  is invented). `build-monsters-manifest.mjs` resolves each monster's clips
  through `monsters/animation_map.json`. Gates:
  `server/test/monsters.sim.test.ts`, `monsters.test.ts`.
- **Soft collision is RADIUS-AWARE** (one fixed comfort distance was rejected:
  84wu-wide mammoths fully overlapped before an 18wu nudge activated).
  Monsters stay OUT of the collision grid (no network/findPath cost); every
  distance is per-body: the manifest emits art-measured `radius` per kind
  (shadowW/2 ≈ half footprint; horizontal iso px ≈ 1wu); the server loads it
  via `monsterRadii()`; the comfort target is `rA + rB + MONSTER_SEP_MARGIN`.
  Four server pieces in `stepMonsters` (all validated per-axis by
  `canEnterElev` AND zone membership): (1) `separationPush` (shared, pure) —
  positional relaxation clamped to `MONSTER_SEP_RELAX_SPEED`·dt, stacked pairs
  split along an id-hashed `tieBreakAngle`; (2) PROACTIVE dodge — each
  monster's autopilot input runs the SAME shared `monsterDodge` against
  monsters AND players (hysteresis in `monsterDodgeStates`), so they arc and
  yield; (3) radius-aware SEED spacing; (4) radius-aware roam-target spacing
  (`pickMonsterTarget`). Client `monsterDodge` uses per-monster `r`: personal
  space = `r + PLAYER_BODY_RADIUS + MONSTER_DODGE_MARGIN` (donkey ≈28wu,
  mammoth ≈57), lookahead `max(26, personal+20)`, probe `max(12, personal/2)`,
  near-filter ±140wu (must admit mammoth-scale lookahead). Deflected input is
  what gets predicted AND sent; raw position pushes stay rejected (fight
  reconciliation). Tests: dodge + separationPush suites (sim), radius-fraction
  relax (live).
- **`separationPush` is the server's hot loop** — O(N²) in monsters (160 on
  the_island2 → ~26k pair tests at 20 Hz; profiled 12.9% of busy CPU). It
  rejects on SQUARED distance and takes `sqrt` only on actual overlap
  (`Math.hypot` is ~16× dearer; `d ≥ t ⟺ d² ≥ t²` for non-negatives — verified
  0 decision changes, worst delta 8.9e-16). Isolated 1.483 → 0.0915 ms/tick.
  **Keep any new distance here squared**; if it ever hurts again the answer is
  a broad-phase, not micro-tuning.
- **THE TUNED SHADOW OVERRIDES EVERYTHING ART-MEASURED BELOW** (maintainer
  2026-08-20, from inside the wiki's shadow editor: "the center of the shadow
  will be the monsters position. The size will be the monsters hit box").
  Where the Game Master has saved one it wins; a kind without one stays on the
  measured pipeline. It lives INSIDE the monster's entry in
  `live/tuning/monsters.json` — `shadow: {rx, ry, offsets: {"<state>#<dir>":
  {ax, ay}}}`, frame px at scale 1, offsets from the FRAME CENTRE — same doc
  as `max_hp`, same live push: a wiki save re-anchors and re-radiuses running
  rooms with no redeploy and no rejoin. `live/tuning/shadow_notes.json` is the
  FROZEN predecessor (training data for better art defaults); the game must
  never read it as an override table.
  - ONE size for all 8 facings: `shadowScreenEllipse` unsquashes the tuned
    depth, rotates on the GROUND, re-squashes. Only the diagonals show the
    rotation SIGN — cardinals hide a mirrored matrix.
  - The CENTRE is the position: the shadow is drawn at the authoritative
    (x, y) and the sprite hangs off it by the facet offset
    (`shadowAnchorOf`: `<state>#<dir>` → `idle#<dir>` → v1 base → the art
    default). The art moves; the shadow never does.
  - The SIZE is the hit box, through ONE seam: `monsterRadiusFor` in
    `server/src/tuning.ts` (`shadowBodyRadius` → else the manifest radius →
    else the default). Its consumers are seeding, the per-tick body snapshot
    that feeds BOTH `separationPush` and `monsterDodge`, melee reach in both
    directions, and roam-destination spacing. Never read `radii.get(kind)`
    into a distance directly.
  - The honest ellipse→circle reduction: the sim is circles only, so the
    ellipse collapses to the MEAN of its GROUND semi-axes — rotation-invariant,
    so a monster cannot grow a hit box by facing east. Measured melee-reach
    drift vs the art radius: diablo_2 −0.1%, forest_poring −1.4%, diablo
    +9.4%, crystal_horn +10.9% — real, and unbounded as more get tuned
    (the clamp tops out at 80 where the art path capped at 60).
    Chase/escape/aggro (`aggro_radius_wu`, `PROVOKE_RADIUS_WU`,
    `ESCAPE_RADIUS_WU`, `MAX_CHASE_WU`, the leash) are centre-to-centre and
    deliberately untouched. REJECTED: the equal-area circle (identical on
    every tuned record so far — they are all near-circles on the ground — so
    it only moves live numbers); an ellipse hit box in the sim (every
    consumer would need the facing).
  - ONE POSITION DEFINITION: zone membership, the snap-back target, elevation,
    surface speed, loot origin and every distance read (m.x, m.y) — which IS
    the shadow centre. Membership stays centre-only; making it radius-aware
    would shrink every zone polygon by each monster's body.
  - RENDER SIDE (`WorldScene`), the laws that keep the drawn shadow the one he
    placed:
    * ONE SIZE MEANS ONE SIZE — a tuned ellipse is fed **no** hop height
      (`placeTunedShadow`): neither the animation's `air[]` nor a flyer's
      `hoverPx` (already inside the tuned `ay`). Feeding them shrank and faded
      the ellipse every idle cycle (measured diablo_2: 73.575 → 64.010 px,
      −13%, alpha → 0.825 on walk south). A real FALL still shrinks it —
      `placeBodyShadow` derives that from the drawn height itself.
    * Offsets are keyed by the CANONICAL state (`idle/walk/attack/angry/die` —
      what the wiki writes), never the manifest-resolved clip alias
      (`monsterWalkKey` can answer "jump"); an alias would fall silently
      through to `idle#<dir>`.
    * The origin is applied AFTER `play()` and re-applied every frame
      (`applyTunedOriginFor` off `mv.shState`) — it is a fraction of the
      CURRENT frame's size, an attack only re-anchors on a new `actionSeq`,
      and a live save must reach a monster mid-swing. Cheap because
      `artBottom`/`hoverPx` are mirrored onto the avatar (no manifest scan).
    * The CULL BOX and the TAP BOX must stop assuming feet: a tuned anchor is
      mid-body (crystal_horn hangs 61 px of a 176 px frame below it) and the
      sprite is NOT lifted by `hoverPx`. The tap box UNIONS the drawn ellipse
      in (rotated-ellipse AABB) and never shrinks below the finger pads.
    * `onLiveTuning` also sets the drawn `setDisplaySize`/`setRotation`: the
      per-frame draw runs for ACTIVE monsters only, so a culled body would
      otherwise report and re-enter on its old ellipse.
    * KNOWN, needs the wiki/maintainer (in `coordination/games.json`): an
      INHERITED offset ignores strip framing — diablo_2 has no `walk#*`, and
      its walk strip is framed 16 px lower than idle on south, so it sinks
      through its own shadow. And the editor previews a hard rim at exactly
      p×q while the game draws the diffuse texture at
      `MONSTER_SHADOW_SPREAD` 1.35 — measured half-max contour at 0.88 of the
      placed rim, so what he tunes reads ~12% smaller in game.
  - Pinned by `server/test/monstershadow.test.ts` (junk rejection, the
    inheritance chain, the diagonal mirror sign, the clamp, the art fallback,
    and a source check that no consumer bypasses the seam). CROSS-DOMAIN:
    `wiki/tools/shadow-mirror.mts` imports `shadowScreenEllipse` /
    `shadowBodyRadius` from `shared/src/index.ts` BY PATH and
    `wiki/tools/check-shadow.mjs` gates on them — tell the wiki agent before
    touching either signature.
- **Art-measured shadows + anchors, PER DIRECTION** (`measureWalkArt` fully
  decodes every WALK strip). The manifest emits per (state, direction) a
  `ground` contract `{f, cx, contact, sink}` plus per-frame `shift[]`/`air[]`.
  Laws distilled from five maintainer rounds — do not re-derive:
  - NEVER one pooled anchor: strips differ in height/margins per direction
    (up to 9px), ~90% of frames sit above a p90 line by construction
    (hop gaits float), and off-centre bodies leave the shadow beside the feet.
  - `f`/`cx` are the CONTACT CENTROID, not the lowest opaque row: far feet
    stand up to ~16px higher in-frame than the near toe. On the planted
    contact frame (bottom-3-row contact width ≥ half the dir's widest; frame
    nearest the p65 of ground-frame bottoms): contact columns within
    T = clamp(11% bodyW, 6, 17) of the deepest row; runs <3px wide dropped
    (tails); runs farther than 0.4·fw from the mass-centre column dropped
    (flame tendrils). Anchor = kept-run extent midpoint × mean bottom row.
  - `cx` blends 50% toward the silhouette's mass-centre column (cap 12% fw) —
    eccentric contacts pull the shadow under the body; symmetric quadrupeds
    stay put. `sink` = px the front toes plant BELOW the anchor.
  - PER-FRAME drift compensation — the art is NEVER touched ("movement should
    be handled in the game and not in the animation"; a rewrite script "can
    easily destroy the animation"): `shift[]` (origin-x per frame from the
    mass-centre column, bounded to the contact band ±15%, clamped ±12% fw —
    cancels baked translation, e.g. diablo_2 east slid 14px/cycle) and `air[]`
    (px the frame's deepest point rose vs planted, 2px deadband, cap 24 — fed
    to placeBodyShadow's hop arg so levitation/leaps shrink+fade the shadow;
    vertical bob is real animation, never pinned).
  - Per-frame anchors are FEET-BASED (each frame's own contact analysis, 3px
    deadband, mass only as airborne fallback) — mass tracking chased a
    stretching cat's HEAD.
  - The shadow ellipse is PER DIRECTION (`ground[dir].w/h`); the body CLASS
    picking the blend factor is MONSTER-level (widest facing vs median figure
    height — per-view classing shrank a south mammoth): LONG bodies 0.8×length
    side-on / 0.9×girth front-on; TALL lean-ers (figH > bodyW) 0.4 + contact
    extent (they ground through a compact base; 0.55 read oversized); else
    0.55.
  - The client applies origin(cx,f) on every facing change, `shift[frameIdx]`
    per tick, parks a paused monster on `contact` (frame-0 parking left frogs
    levitating), and lifts the shadow `max(0, h/2 − sink − 2)` px so its SOUTH
    RIM kisses the toe line — capped at the contact band's height (`up`+3) so
    a monolith's ellipse stays ON its base.
  - **Verify with the contact sheets before shipping any shadow change**:
    `node scripts/monster-contact-sheets.mjs [ids] [outDir]` renders every
    (monster, direction, frame) with the exact client shadow maths + a red
    anchor crosshair — offline, exhaustive, the maintainer's-eye view.
- **CONSTANT shadow size per monster** (maintainer: constant regardless of
  animation/direction, "a bit bigger, more fade"): only the MEAN of per-dir
  footprint widths survives — `shadowW = min(150, avg × 1.12)`, one ellipse
  per monster; never resizes on turns. Anchors stay per-direction/per-frame;
  the air-shrink stays.
- **DIFFUSE monster shadows** (maintainer: "a more diffuse shadow is less
  sensitive" — precision-robustness trade): own `monster:shadow` texture
  (`ensureMonsterShadowTexture`, 128×52 = 2× the avatar texture so a 139px
  ellipse upscales cleanly), core alpha 0.44 decaying
  0.39→0.27→0.14→0.05→0.015→0, drawn at `MONSTER_SHADOW_SPREAD` 1.35× the
  measured footprint (the constant-size round softened an earlier 0.5-core/
  1.25× cut). REJECTED: core 0.34 + 1.3× spread (grounding cue vanished). The PLAYER keeps the sharp
  `avatar:shadow` (its nadir is postprocessed in the art). Judging a shadow
  style: use a style-ab render (identical pose) — in-game A/B is unreliable,
  monsters roam between captures.
- footW = the contact-run extent; shadow `w = clamp(max(footW, bodyW·0.55)
  ·1.05, 12, 150)`, `h = max(6, 0.385·w)` → `shadowW/shadowH`, NEVER
  frameW-scaled. Collision `radius = min(60, 0.45·shadowW)` — the FALLBACK only;
  a tuned shadow replaces it (above). `stripDims`
  (true per-strip size from IHDR) slices every sheet — monster.json `size`
  goes stale on in-place repairs and frames bleed. `hoverPx` marks
  INTENTIONAL winged flyers (butterfly_dragon 12): sprite lifts, shadow stays
  grounded and shrinks; everyone else is pinned. Probe: `__ml.monsterInfo()`.
- **IDLE + stop-shake**: stopped monsters play their resolved IDLE clip
  (legacy porings have none and park on the walk contact frame). Idle strips
  are framed independently — the manifest measures `idleAnim` + `groundIdle`
  per dir; the client picks the ACTIVE state's map every tick. The stop-shake
  fix, two layers: SERVER — arrive GENEROUSLY (<0.75 cell of a roam target =
  done; separation jiggle near the target flipped bearing sectors); CLIENT —
  monster `stableDir` runs EVERY turn size through the 160ms persistence
  (`allTurns`) — monsters are remote puppets, facing lag is invisible
  (players keep instant large turns).
- **GAIT SYNC — walk clips are paced by DISTANCE, not time** (speeds span 42
  roam → 105 chase → 220 provoked wu/s; a fixed rate was 0.30×–6.22× off):
  `fps = frames × speed / gait.cycleWu` — one cycle per `cycleWu` of ground.
  - `cycleWu` = `0.9 × bodyW` clamped 26–92wu, per kind. **Do NOT measure it
    from foot excursion** — tried; leading-contact swing is 1px on a poring
    vs 18px on a saber-tooth, uncorrelated with size (half the roster has no
    visible legs). Body length is the one universal signal; stride ∝ body
    size is the real biomechanics.
  - Clamped **3–26 fps**: never freeze mid-stride, never demand ~108 fps of a
    sprinter. When a clamp binds the body skates — that is the art's frame
    budget, not a bug; the gate asserts cadence only where clamps are slack.
  - Speed comes from the body's OWN drawn motion (eased screen delta
    back-projected, like the player's `spdWu`); the same measurement yields
    `scrPerWu` (local iso scale along the heading) free.
  - **HOP TRAVEL** for genuine leapers: `gait.travel[]` per-frame ground-track
    weights (mean 1) → mean-zero lead/lag along the heading, so a frog covers
    ground DURING the leap. Measured by vertical MASS-CENTROID rise ÷ figure
    height — NOT `air[]` (dangling legs under-report a leap). Only kinds over
    15% rise ship one: water_poring .31, mystical_frog .27, diablo .21.
    Applied to the DRAWN anchor (sprite + shadow + lit copy), never `mv.lx`
    (that IS the ease state and would absorb the surge).
  - TRAP paid for once: Phaser's `timeScale` lives on the sprite's ANIMATION
    STATE and survives every `play()` — reset it at the top of
    `playMonsterAnim` or a monster that broke off a 3.5× chase dies at 3.5×.
  - Gate: `scripts/verify-monstergait.mjs`. Probes: `__ml.monsterGait()`,
    `__ml.monsterDefs()`.
- **CAMERA GATE on the body pipeline**: a monster is ACTIVE only while its ART
  BOX (sprite bounds ∪ shadow ellipse) can touch `worldView` grown by
  `MONSTER_CULL_SLACK` (64px hysteresis). Culled: hidden, lit hidden, anims
  PAUSED (Phaser advances clips on invisible sprites). What culling must NOT
  break, and doesn't: (a) position still tracks the server every frame (the
  player's dodge reads `fx/fy` for EVERY monster) — culled bodies SNAP, so
  they re-enter already in place; (b) un-culling restores everything the same
  frame. Measured on the_island2 at 480×320: pipeline self-time 1,587 → 160
  µs/frame. Probe `__ml.monsterGate()` audits against Phaser's own
  `getBounds()` × the camera's `worldView` (a wrong formula can't agree with
  itself): `wrongCulled` must be 0; `wastedActive` is the harmless direction.
  `monsterInfo().culled` lets QA skip parked bodies (their state is
  deliberately stale). Gate: the monster block of verify-smoke asserts the
  invariants AND that culling REVERSES (pan away/back).
- **Zone DEBUG overlay** — Settings "spawn areas", OFF by default (maintainer)
  in `ml-spawn-areas`. Draws each zone's REAL polygon, lazy-fetched from
  spawns.json on first switch-on — NOT the synced bbox (zones are concave).
  Corners go through `projectZoneCorner`, NOT `project()`/`projectFlat()` —
  those append the CHARACTER GROUND ANCHOR (+tile/2, +dy); feeding them
  tile-corner vertices drew the outline a half-cell (dy = 15px) down-screen.
  A corner keeps +tile/2 but sits dy ABOVE the diamond centre. (~4 world-px
  residual = the documented tile-art inset, see artLift.) Probe:
  `__ml.spawnOverlay(on?)`.
- **The spawn BONFIRE** (`placeCampfire`) anchors to the world's DECLARED
  spawn (`world.json spawn` — the cell `placeAtSpawn` scatters around), 1.6-
  2.6 cells out. NOT the world centre (every maps2 world declares a spawn far
  from its middle; the fire burned alone). Probe: `__ml.campfireInfo()`.
- `MonsterAvatar` renders through the SAME body pipeline as players —
  `resolveBodyDepth` (occluder-aware depth + `coverY`), `placeBodyShadow`,
  `syncLitCopy` — via the structural `BodyVisual` subset. **Never hand-roll a
  second depth/shadow/lighting path for a new entity type**: the first
  monster cut did (naive painter depth, no lit copy) and shipped terrace tiles
  over monsters, detached shadows, no light response.

## Combat, items & progression (RO-flavoured)

- **Player state owns level/xp/hp/hpMax/ep/epMax** (schema, synced; ep
  reserved). Curves + every number both sides must agree on live in
  `shared/src/combat.ts` (xpToNext, hpMaxFor, damageRoll, unarmedClip, slow
  window, chase/orbit/drop constants). Progression + inventory PERSIST by
  token (store.ts); the backpack is PRIVATE — targeted "inv" messages, never
  schema. PERSISTENCE SHAPE: position is per-world
  (`.data/players-<world>.json`); progression + backpack are WORLD-AGNOSTIC —
  one `.data/players-progress.json` (`progressStore()`; old per-world
  progression seeds it once). Both stores DEEP-COPY at load/save (a live
  Player.inv aliasing the store silently corrupted saves). ONE live session
  per token: a second join kicks the older session and takes the LIVE
  progression (two sessions dup/eat items on last-writer-wins). savePlayer
  flushes on leave, death, level-up and a 30s timer.
- **Tap a monster to engage**: the client autopilots into radius-aware reach
  (attackRange = rA+rB+12), then the SERVER drives the swing loop while the
  target lives, stays in reach (×1.2 grace for the circling drift) and the
  player stands still — movement input breaks the fight. Swing clips are
  kick/punch, pseudo-random but DETERMINISTIC from synced actionSeq + id salt
  (shared unarmedClip) so every client shows the same move. Signals:
  Player.action/actionSeq (one-shots), hitSeq (flinch + damage float), dead.
- **Monster brain** (Monster.mstate): roam → chase → combat → die. PASSIVE BY
  DEFAULT: tuning default aggro_radius_wu = 0 — everything retaliates when
  hit; only predators (saber/night_beast/diablos/snow_demon/salamanders/
  masked/malformed, 64-96wu) proximity-aggro (~2 scans/s). A SWORD-MARKED
  monster (your engage target) also aggros when you close inside max(its
  radius, PROVOKE_RADIUS 4 cells) — raising the sword IS the provocation,
  passive kinds included; `player.target` persists while moving (swings still
  require standing). Monster.level + Monster.aggro are synced.
- **ESCAPE MATH — two chase kinds** via server-only `m.provoked`:
  - UNPROVOKED (a predator noticed you): constant chase 105 — an innocent
    full run (175) always pulls clear; a hit-slowed one (96) does not.
  - PROVOKED (retaliation or the sword mark): chase speed =
    provokedChaseSpeed(victim's current possible speed) — always ~12% above
    whatever the victim can do (floor 60), AND the victim carries
    FLEE_SLOW_FACTOR 0.8 for the whole hunt (synced `slow` = min(hit-slow
    0.55/1.5s, flee 0.8); the client predicts from the synced field; pending
    inputs carry their factor).
  - The way out is the RUN-AWAY LINE: `ESCAPE_RADIUS_WU` **390 ≈ 0.75 of a
    screen** beyond the home ZONE bbox — crossing it makes the hunter give up
    and walk home (m.returning, aggro scan suppressed), flee slow lifts.
    HALVED from 780 (maintainer: chases too long) — BOTH uses had to halve
    (a provoked hunter paces its victim; the gap opens at the LEASH, so
    shortening only the give-up distance barely changes hunt length). Floor
    on this constant = the PROVOKE radius (128wu) — near it a marked monster
    aggros and gives up in the same breath. combat.unit.test.ts pins the
    screen fraction and the margin.
  - DE-AGGRO BY DISTANCE, its own rule on top: ANY hunt ends the moment the
    victim is > ESCAPE_RADIUS_WU from THE MONSTER (a big zone's bbox is most
    of the map; the leash alone let a predator follow absurdly far).
    combat.review.test.ts proves it on an unprovoked saber-tooth.
  - **The give-up IS the rejected step**: chase movement is leash-gated
    (withinLeash = zone bbox + ESCAPE_RADIUS), so a "give up when beyond the
    leash" position check is provably dead code (it wedged monsters at the rim
    in chase forever). A chase ends when (a) its contained() step is rejected
    at the rim, or (b) the victim is past the line AND out of reach (covers a
    wall-wedged chaser). combat.review.test.ts kites a frog and asserts all
    of it.
  - IN-FIGHT CIRCLING ("more like a boxing fight"): BOTH bodies strafe
    tangentially with the same rotational sense (ORBIT_SPEED 6 — the
    maintainer slowed it twice); the monster holds ~0.88 reach radially (pad
    16); the standing engaged player is drifted by the SERVER with the
    OPPOSITE tangential formula (same-formula-on-mirrored-radius made them
    strafe in parallel). stepCombat: ground-validated, never into water,
    moving stays false (fight idle); the client needs NO prediction (no input
    pending → predicted == synced; the render ease glides the 20Hz steps).
    Handedness starts id-hashed, flips rarely (exponential,
    ORBIT_FLIP_MEAN_S 60). Facing tracks the opponent on both sides.
  - ENGAGING SHOWS THE SWORD, NEVER THE BEACON: monster taps, chase repaths
    and item walk-tos pass showMarker=false to setMoveTarget — the ground
    beacon is for plain ground taps only.
- **The two TARGET MARKERS** — borders built from the marked body's own
  silhouette: `ringTextureFor` reads the frame's alpha into a RING_PAD(2)px-
  padded canvas and grows a 2px TWO-TONE border (inner = base colour, outer a
  step brighter), each line one **4-neighbour** dilation. SIDES ONLY, never
  diagonals — side-dilation leaves the single diagonally-touching pixels
  pixel art itself outlines with; dilating diagonally doubled the border at
  every step and read THICK (the 8-offset-silhouette-copies approach was
  killed for this). Drawn at depth ~900_001.44-.45, FULL alpha at any hour —
  the mark is UI, lighting/shadow/fog never touch it (matching the body's
  layer dimmed it; an outline has no interior, nothing bleeds through).
  - RED (0x8e2222/0xb83a3a) marks MONSTERS: the one you clicked for the
    ENTIRE fight, AND every monster currently hunting YOU — Monster.tsid
    (synced from server-only targetSid while chase/combat, "" otherwise); one
    ring image per monster in WorldScene.monsterRings.
  - LIGHT-BLUE (0x9adcf0/0xc4ecfa) marks the GROUND ITEM being fetched until
    picked up; it REPLACED the hand icon (ui2/icon-pickup-target.webp deleted;
    the drop stays an ordinary world-layer item). Retired sword-icon and hand
    art live in git.
  - Three traps paid for in screenshots: position from the LIVE sprite, never
    `mv.lit` (lit copies sync later — a hopping monster smeared the ring);
    shift the origin by the pad ((originX·fw+RING_PAD)/(fw+2·RING_PAD)); set
    the canvas texture's filter to NEAREST explicitly (addCanvas does not
    inherit pixelArt; LINEAR smears the lines at fractional zoom).
  - Probes: `__ml.ringInfo()`, targetOverlay().rings/itemRing/itemRingTint.
- **Tap hitboxes are FINGER-SIZED, not art-sized** (maintainer: "constantly
  miss clicking", incl. sprigling-class small bodies — sprigling = lore's
  name for forest_poring_2): tapTarget grows every box and clamps to minimums
  (drops ±26px; monsters half-width max(26, dw·0.5+6), ≥48px tall, −8/+10
  vertical pads); overlapping fat boxes → CLOSEST candidate wins, and a
  matching drop beats any monster box across it. Probe: `__ml.tapAt(wx,wy)`
  (the exact pointerdown hit test; monsterInfo sx/sy/dw/dh/lx and dropsList
  sx/sy carry drawn-sprite coords to aim with).
- **Monster hp readout lives ON the monster** (maintainer: keep it SMALL; a
  separate top-centre frame was rejected): `updateMonsterHpBar` draws a slim
  76×6 bar in a THREE-LINE stack — NAME left-aligned over the bar, the bar,
  then "Lv N" left / "hp/max" right under it (the middle gap survives 4-digit
  HP; all three hang off the bar's edges). The name is the roster display
  name (monsters.json `name`), resolved ONCE in addMonster onto mv.label —
  this runs per monster per frame; a manifest scan would be 24×160×60fps.
  Shown while wounded, in combat, or my engaged target. Bar/texts/borders
  live ABOVE the darkness overlay (900_001.44-1.9, under damage floats at
  900_002) — at 890k they dimmed with the world. NEVER reuse
  .ml-bars/.ml-bar-row classes for new HUD chrome — verify-bars counts them
  (2 chips, 3 rows). Debug switch "aggro radius" (`ml-aggro-radius`) draws
  each monster's synced radius (red; gold provoke ring on the marked target).
- **"DISABLE AGGRO"** (Settings, off by default, `ml-no-aggro`) — a testing
  switch so a cave can be walked and looked at. Enforced on the SERVER per
  SESSION (the proximity scan runs there); the client re-sends it on every
  join. Deliberately NOT a schema field (a synced field per player for a
  debug flag); it is a `Set<sessionId>` on the room, cleared in `onLeave`.
  Suppresses UNPROVOKED aggro only — a sword-marked monster still comes, a
  hit one still fights. Flipping ON also RELEASES every unprovoked chase via
  `disengageMonster` (else you'd have to outrun what already noticed you).
  Gate: `server/test/noaggro.test.ts` — each step on a FRESH predator (a
  monster whose hunt just ended is `returning`, scan suppressed by design).
- **THE BODY-DODGE IS A MANOEUVRE, NOT A PER-FRAME OPINION** (`monsterDodge`;
  NPCs and monsters have faked client-side collision — the INPUT slips around
  their personal space). The laws, from the back-and-forth-panic reports:
  - Engage and release on DIFFERENT thresholds: engage at `dot ≥ 0.35` inside
    the personal corridor; HOLD the committed blocker until `dot < 0.0` with a
    1.35× wider corridor. Widening only the HOLD makes it hysteresis, not a
    bigger trigger.
  - The side is chosen ONCE and held; only walkability may overrule it
    (re-scoring both sides per frame with a small bias kept flipping). The
    45°-vs-90° escalation latches the same way — but see below.
  - **A waypoint somebody stands on is UNREACHABLE — count it arrived.** The
    root cause the other rules were symptoms of: routes are planned on the
    terrain grid, which knows nothing about bodies; the dodge kept the walker
    out of the spot forever while the autopilot steered at it, and the
    resultant is a CIRCLE at personal-space radius. `stepAutopilot` takes
    `standoff(wx,wy)` (`bodyStandoff` in shared), added to waypoint-advance
    and arrival radii. The client feeds it `nearBodies()` — **the same list
    the dodge gets**; if they disagree the walker orbits again.
  - **The openness test applies to the heading actually EMITTED.** Candidates
    are an ordered preference list — `[2*side, side, 2*-side, -side]` when
    wide, 45° first when not — and the first OPEN one wins. Commitment never
    outranks "can I physically move".
  - **A 90° ring rotation is a circle, not a detour** (zero progress → the
    release can never come true). It is reserved for "already inside the
    personal space, step out", and cannot persist there. A dodge gives up
    magnitude, then SIDE, never progress — so the ESCALATION must NOT latch
    even though the side does.
  - Measured (deterministic 60Hz Node replay of the maintainer's walks
    against the real world file — the right instrument; headless-GL probes
    starve and reported 178/220 false "grinds"): cross-track reversals 7 → 1
    (1 is the floor); wall stall 60 ticks → 0; dodge-engaged sweep about the
    body 231° → 116° (a close pass is ~180°; past it you went round the
    back); tap-on-her-spot 199°/4.40s → 21°/2.60s. Beware whole-trip sweep as
    a metric: it reads 254° with no NPC at all (routes curve around houses).
  - Gates: wallhug.test.ts cases 4-6 (hold ≠ wider trigger + escalation
    doesn't latch; emitted heading open and progressing; both walks + the
    own-spot tap replayed through the real brain, failing at 232° without the
    standoff).
  - **THE PASS — the special move past a body blocking the ONLY lane**
    (maintainer: no panic direction-switching; the basketball crossover).
    Bodies are soft collision, so walking through is physically free — the
    change is the BRAIN: `monsterDodge` gains a latched PASS, armed by two
    extra params (`now`, `allowPass`) that ONLY the local player's client
    call passes — the server's 7-arg monster dodge is byte-identical (pinned
    by test). Where the stuck lives: a DOORWAY (steer assist pulls to the
    opening, the dodge deflects off the body parked in it; measured 192
    heading flips in 5s parked at the door line; with the pass, through in
    ~1.5s at 31 flips). TWO TRIGGERS, ONE LATCH: STRUCTURAL — no dodge
    candidate is terrain-open while the raw heading is (fires the first
    frame); STALL — same blocker held `DODGE_PASS_STALL_MS` (450) without
    `DODGE_PASS_STALL_WU` (8) of displacement. Ends via the ordinary hold-
    release, when the lane closes (raw re-checked every frame — a pass never
    walks into terrain), or at `DODGE_PASS_MAX_MS` (1600); expiry resets the
    anchor. THE JINK (`DODGE_PASS_JINK_MS` 160): one 45° step toward
    whichever side is free, then straight — heading-relative, either side; a
    sealed lane goes straight with no feint. Gates:
    `server/test/dodgepass.test.ts` (baseline VERIFIED stuck >60 flips so the
    fixture can't go vacuous; the crossing; first-frame structural fire;
    open-field non-trigger; feint bounds; valve expiry/re-arm; server path
    never grows pass state).
- **ONE TAP, TWO MEANINGS — RESOLVED BY ROUTING BOTH** (`startBestTrip`).
  The two readings are the same PIXEL in different CELLS: screen y is
  `(col+row)*ISO_DY − level*LEVEL_PX`, so the ground drawn at a level-6
  slab's pixel is 6.4 cells up-screen. Both surfaces of the tapped cell are
  routed and scored: (1) **arriving beats giving up short** (`endLevel` vs
  `goalLevel`), then (2) **the shorter WALK wins** (`tripLength` through
  waypoints, not a beeline). Only a STRICT improvement displaces the
  incumbent (drawn surface keeps ties; a single candidate is byte-for-byte
  `startTrip`). The winner's `goalLevel` draws the beacon — choice and marker
  come from ONE decision.
  - **Never "fix" the symptom by moving the beacon to meet the walk** —
    rejected TWICE by the maintainer ("I click where I click"; "now you move
    the marker to a spot I didn't click on"). Resolving between two readings
    of the same pixel cannot move it.
  - A CLIFF is ambiguous too, not just a roof: `ignoreAtOrAbove` skips every
    surface at or above the tapped level, terrain included, so any raised
    pixel offers both readings.
  - When the second reading is a WALL, take the nearest walkable pixel —
    `nearestGroundTo` searches a small ring in SCREEN space (two cells
    equally far in world terms can be a storey apart on screen). Never "the
    floor of the clicked cell" (draws level·lh below the marker = head-height
    walking).
  - **The beacon is the pixel you touched — never a projection of the route**
    (`tapMarkerAt` pins the camera-world point; per-frame follow and drag
    respect the pin). Deriving it from `trip.target` slid it to findPath's
    best-effort rim and lifted it 6 levels (walker's head at the marker).
  - **The pick point must survive the hold**: `holdRepath` re-plans 50ms
    after every tap, so a pick point passed only at pointerdown is
    overwritten within a frame — it lives on `holdGround.at`. A probe calling
    setMoveTarget directly CANNOT see this (it shipped broken twice that
    way), so section 9 of verify-indoor ends with a real `page.mouse.click`.
  - KNOWN LIMIT, not a bug: a roof pixel over a mountain (the_island2 house)
    has NO ground reading and no route up — the walk is a best effort to the
    floor beneath, ending ~96px below the marker. A route onto the roof is
    the fix, not moving the marker.
  - `endLevel` is what makes this decidable: findPath waypoints carry `lvl`
    (the LAYER the search stood on — additive, but a `deepEqual` on a
    waypoint sees it) and the trip carries `endLevel` beside `goalLevel`
    (the WISH — a stall replan must keep re-aiming for the deck).
  - Gates: `server/test/beacon.test.ts` (unreachable roof; a roof that wins
    on distance) and section 9 of `verify-indoor.mjs` — which asserts you
    arrive AT THE BEACON, not at the tapped pixel (an earlier cut comparing
    (col+row) instead of screen Y passed against broken code).
- **THE OCCLUSION OUTLINE IS NOT A WALL-HACK.** It draws at 900_001.43, above
  the darkness overlay — only refusing to draw can hide it. Two symmetric
  gates in `syncCoverOutline`: indoors, nobody OUTSIDE my room gets one
  (`indoorOutside`); outdoors, nobody sealed INSIDE a room does
  (`inHiddenRoom`) — else a monster deep in the mountain shows a crisp
  silhouette through rock. "Room" is the indoor state machine's verdict, not
  "has a slab overhead" — a body behind a cliff/tower/BRIDGE keeps its
  outline (that IS the feature); a body in a cave MOUTH is not sealed.
  **The gate is the CUT (`indoorInside && indoorMask` — the same pair
  pickGround and aboveCut use), never the fade mask** — `roomMask` outlives
  the verdict for the ambient ease, and reading it kept cave monsters
  outlined through rock for a second after exit. One flood fill per space
  (`roomCellMemo`, filled from `space.roof`, cleared on world change); fails
  OPEN (a spare outline is cosmetic; a missing one is the feature broken).
  Gate: section 8 of verify-indoor — samples the first frame that is already
  outdoors with the fade still running (settle would wait it out), kept
  non-vacuous by `coverFrac` (≥2 sealed >50%-buried monsters required; the
  mid-fade check requires ≥1 — it once passed on "none of the 0 sealed
  monsters is outlined") and by requiring open-air-covered bodies still
  outline.
- **THE CAVE SWALLOWS THE LIGHT** (maintainer: "a thickening shadow that gets
  very dark, very fast"). Every room dims with **depth from its nearest
  entrance** — depth, not camera distance. `buildCaveDepth` BFSes from
  `space.entrances` across each room's cells once per world, skipping
  anything the indoor verdict doesn't call a room (a bridge never darkens).
  Depth rides the room mask's free GREEN channel; the shader applies ONE
  exponential `exp(-depth * uCaveK)`. It multiplies the FINAL light, after
  point lights, ON PURPOSE (maintainer: "no light source can punch in" — a
  torch at the mouth buys the first cell). Your OWN room is exempt and
  un-dims on `uIndoorMix`. 255 = "no opening reaches this cell".
  `roomDebug()` reports `depthCells`/`depthMax` (a channel written once per
  world fails silently).
  - **The depth is read from the cell that is DRAWN, not the one the ray
    stops on** (`groundCellAt`) — why five rounds of mask surgery rendered
    nothing: the surface march stops at the first column whose top the ray
    meets and `heightAt` is max(terrain, deck), so every opening pixel
    resolved to the first interior column at BFS depth 0 (measured: 0 of
    86,640 mouth pixels darkened). The GROUND field carries no decks, so an
    identical walk over `groundAt` lands on the cell whose art is painted at
    the pixel (92% of inward-wall pixels, 70% of floor pixels, depths 1..8).
    It is a SECOND march on purpose — `cell`/`z` from the surface walk still
    drive Lambert/shadows/AO/emission — and runs only for pixels already
    under the ceiling gate.
  - The GATE stays on the surface march (`z < caveUnderAt(cell) − 0.5`): `z`
    separates the opening from the lintel. The ceiling underside comes from
    `grid.deckBot` in the mask's BLUE channel — rederiving it from the deck
    table produced 0 cells and compared against zero forever.
  - The room mask marks the INWARD-FACING walls only — `space.wallLeft`/
    `wallRight` (drawn faces are a cell's +col/+row sides; the near half of a
    ring is the mountain's outside skirt — darkening it blackened houses).
    No band, no rings (a wall face is 8 levels ≈ 128px vs a 15px cell step).
    The rock bar (two levels of headroom above the ceiling) keeps house walls
    out: the_island2's cave marks 146 cells, every house/arch 0.
  - `uCaveK` = 1.2 is the single dial (mouth untouched, then 30/9/2.7/0.8%
    over four cells; 3.6 was a cliff once the depth reached drawn cells).
- **A CAVE MOUTH IS NOT A WALL FACE**: `Ha` is max(terrain, deck), so pixels
  under a roof slab classified as FACE and took face Lambert + face shadow —
  painting the open entrance like glass (maintainer: "some sort of mirror or
  force-field"). A face now also requires solid GROUND above the pixel
  (`groundAt(cell) − z > 0.05`); the uTest-4 calibration branch carries the
  same condition or the gates measure a rule that doesn't ship. Real walls
  untouched (their ground top IS their surface).
- **WATER IS A PLAYER SANCTUARY** (maintainer: "no monster can enter/go on
  water … the player can always use the water to escape/hide"). Every layer:
  buildZoneRuntimes never returns swim cells (canSwim always false — a
  pure-water zone polygon adopts its SHORE ring); monster roam/chase/orbit/
  separation and both monster startTrip sites route with canSwim false; a
  SWIMMING victim instantly disengages its hunter; swimmers can neither swing
  nor provoke (no water-sniping — cuts both ways). Players keep canSwim true.
- **Monster combat clips**: attack/angry/die strips (~525 files, ~3.1MB)
  background-load in the SAME deferred batch as the player's action states
  (boot stays walk+idle). The COMPLETE handler re-runs
  buildMonsterAnimations (a late texture never registers a clip by itself —
  the single-call-site trap). attack/die once-through (die paced to
  MONSTER_DIE_MS so clip and corpse sweep agree); angry loops between swings;
  6 kinds ship NO angry (forest_poring ×2, lava_poring, ice_crystal_golem,
  diablo ×2) and park on the walk contact frame — anims.exists guards
  degrade every gap to the parked pose. `combatClip` gates the per-frame walk
  drift compensation (shift/air are measured on walk/idle and must never be
  indexed by an attack frame). Corpses: schema entry lingers MONSTER_DIE_MS,
  client fades the detached sprite 450ms on onRemove.
- **Loot**: on the corpse sweep the tuning loot table rolls per entry
  (rollDrops, deterministic from id+diedAt). Placement: pseudo-random scatter
  keeping DROP_SPACING_WU 24 from existing drops (ring grows as ground
  crowds; STARTS ~21wu out so loot never covers the rising grave cross);
  deck-aware (dropper's elev threads through spawnDrop); last resort
  ring-scans nearest standable; only open-water corpses keep their spot
  (swimmers can grab). Drops sync in state.drops, despawn DROP_TTL 60s; the
  last DROP_FLASH 5s flashes 2→10Hz (timed from witnessed onAdd; the server
  sweep stays truth). Fresh drops toss up and bounce (join flood lands
  silent). THE GRAVE CROSS (scenery/grave_cross, config-pinned): when the
  corpse fades, the 16-frame SOUTH "appear" clip rises at the death spot,
  holds, and after a minute plays REVERSED. Client-local decor off the synced
  die state; `graveCrosses()` probe + verify-combat assert it.
- **THE GRAB LANDS ON THE ITEM** (maintainer: the hand must come down on the
  exact item, which vanishes "the exact frame the hand is closest to the
  ground"). The ART answers both: the pickup clip draws a little item on the
  ground and it disappears on the grab frame. `build-manifest.mjs grabOf`
  measures per direction `grab[dir] = {f, x, y}` (offset from the FOOT
  ANCHOR, frame fractions + vanish frame). Candidate blobs are VALIDATED
  (at/below the foot line, on the facing side) — a late frame splits off the
  hair, and "lowest detached blob" put north's target 24px out. SOUTH/NORTH
  draw the item merged into the silhouette, so both are interpolated from
  neighbours and flagged `approx` — never invented. A grabbing player TURNS
  TO the item: predicted locally (the pending-pickup facing) and synced for
  everyone (the server's pickup handler sets `player.dir` toward the drop).
  Runtime: `grabStandSpot`
  back-projects the offset and tries all EIGHT facings, taking the shortest
  walk; `walkToGrab` sends the autopilot THERE; driveCombatIntent holds the
  grab until within GRAB_ALIGN_WU (falls through when the trip ends, so a
  blocked path still picks up). THE ITEM OUTLIVES ITS OWN REMOVAL: the
  server deletes the drop ~half a gesture before the hand arrives, so
  `removeDrop` parks MY pickup's drop and `stepGroundDecor` retires it on
  the measured grab frame (or clip end / a 1.2s valve). Two traps: the
  drop's removal and `action` arrive in the SAME patch with the removal
  listener FIRST (requiring a live pickup clip made the deferral never
  engage); and character frames are PER-FRAME TEXTURES keyed
  `f:<uid>:<state>:<dir>:<n>` — take the frame index from the texture key
  (`frame.name` pinned every read at 0). Gate: `scripts/verify-pickup.mjs`;
  probe `__ml.grabInfo()`.
- Item sprites are uniform `items/<id>/sprite.webp` 48×48 (verified across
  the full set) — lazy-loaded per KIND, no manifest fetch. TAP an item to
  fetch it, or the PICKUP button / F key (nearest within 5 cells; the gamepad
  button synthesizes F like jump→SPACE). Server validates PICKUP_RADIUS_WU +
  elev band; the pickup intent RETRIES (~400ms) until the drop vanishes or 6s
  (fire-and-forget loses the predicted-vs-server race on laggy links).
  BACKPACK (hud.ts): server-owned slots in the 5-col grid; DRAG out over the
  game view to drop — pointer-captured ghost (Phaser never sees it); the
  release point only means "onto the ground" (the server ALWAYS scatters near
  the player, verifies the ITEM ID — slot indices go stale when a stack
  empties — and rate-caps pickup/drop at 150ms). An "inv" refresh mid-drag
  cancels the gesture. INV_MAX_SLOTS 30, stacks of 99.
- **The drop dialog** (HOW MANY): every filled slot badges its count, ×1
  included; every drag-out opens a card centred in the GAME VIEW (a lone item
  = the confirm). ONE row: item + typable count + "of N" left, − and +
  together right; full-width DROP underneath. The box is `inputMode numeric`,
  CLEARS ON FOCUS; junk/out-of-range leaves the amount unchanged. No cancel,
  no max button — tap OUTSIDE closes; −/+ WRAP (one tap on − from ×1 = all).
  Backdrop `rgba(0,0,0,.5)` — darkening in BOTH themes (a `color-mix` of
  `--bg` brightened light theme). Placed off `--gv-left/--gv-right/--hud-h`:
  centred, 45% of view height (40% landscape) — the whole number-keyboard
  story: the box stays above the keys WITHOUT the card moving when they open
  (a `.ml-kb-up` lift was REJECTED: a dialog that jumps out from under your
  finger; it deliberately does NOT register with mountChatKeyboardLift).
  MOVEMENT IS FROZEN while open — and the trap: **a DOM overlay does NOT keep
  pointers from Phaser** (its window-level listeners process events whose
  target isn't the canvas), so cancelling a drop used to run the player to
  the tap. `HudActions.onUiLock` disables Phaser's keyboard, resets held
  keys, drops any trip/hold, sets `uiLocked` (scene pointerdown returns
  early); the lock lifts 150ms LATE (`uiLockLiftAt` — the closing tap is
  still dispatching); the backdrop also preventDefault()s its OWN events
  (never the card's — that eats button clicks on touch). SERVER: `"drop"`
  takes `n` clamped `1..entry.n`; the 150ms cadence is charged PER ITEM
  (+20ms each). Gates: `scripts/verify-dropqty.mjs` + the clamp test in
  combat.review.test.ts. Probes: `__ml.invFake(items)`, `__ml.canWalk()`.
- **LEVELLING UP — "Thunderclap"** (maintainer, chosen from eleven: "the
  level up graphics is perfect!"). Lives entirely in `bars.ts` off
  `setLevel()` — the level going up IS the event. Gauge climbs to full on the
  finished level; three effects peak on ONE frame (fill flash 1.95, chip
  recoil, LEVEL stamp from ×2) + shockwave ring + track sweep; beat; drain to
  carry-over. The server NEVER sends the full bar: a level-up arrives as one
  sync (new level + carry) with `setBar("xp",…)` pushed BEFORE `setLevel()`,
  so setBar remembers the fraction/requirement it overwrites and the
  animation replays from there; the LEVEL label holds the old number until
  the stamp lands. While running it OWNS the gauge (a mid-animation kill
  drains onto the newest sync); a watchdog hands it back if rAF freezes;
  reduced motion lands the values. No sound (the audio agent's, on request).
  Gate: `scripts/verify-levelup.mjs`. Probe `__mlBars` (own namespace —
  WorldScene assigns `__ml` wholesale): `levelUp(carry, need)`, `state()`.
- **Monster stats come from the LIVE TUNING channel**
  (live/tuning/monsters.json, format @1; server/src/tuning.ts resolves live
  doc ← baked file ← builtin). CAREFUL: liveTuning() serves an
  EMPTY-but-truthy placeholder before initLive's fetch lands — the resolver
  checks for CONTENT, not truthiness. Baked values derive from curated level
  (hp 15+10L, dmg 2+1.6L, xp 8·L^1.35); a wiki admin edit re-tunes live
  rooms, no deploy. `speed_wu` and `scale` resolve but have NO consumer —
  chase speed is the shared CHASE_SPEED_WU constant because the escape math
  depends on it; wiring per-monster speed means re-deriving that triangle.
- **Client prediction under combat**: pending inputs carry the slow factor
  they were ORIGINALLY integrated under (like `jumping`) and replays use it —
  replaying with the CURRENT synced slow rewrote history at slow boundaries
  (uncommanded teleport when breaking free). The server mirrors slow into the
  synced field inside hurtPlayer (not next tick), and ACKS seqs swallowed
  while dead (un-acked seqs replayed the corpse offset and popped off-spawn
  on revive).
- **Hit feedback**: damage floats 26px, 850ms (maintainer: twice as big, 0.2s
  longer); every landed hit plays a BLOOD SPATTER (scenery/blood_spatter,
  stored TRIMMED to the maintainer's green-circled dispersal window — see
  scenery.json:edited before any resync): one of 8 direction variants,
  forward or REVERSED at random, 14fps, depth 900_001.95 (never dimmed),
  preloaded in the deferred batch with the sword marker (lazy first-engage
  load lost the walk-to race). Hurt flinch 16fps, 300ms overlay. `bloodFx()`
  probe; verify-combat asserts ≥1.
- **Gates**: combat.unit.test.ts (curves/determinism/escape math),
  combat.test.ts (2 live rooms: fight loop + death/respawn),
  combat.review.test.ts (leash give-up; world-agnostic progression;
  one-session-per-token), store.test.ts (deep-copy), verify-combat.mjs (dev
  stack end-to-end). verify-bars asserts the REAL level-1 stats (40/40 HP,
  20/20 EP, 0/50 XP) after the join race; verify-gamepad expects
  Jump+Pick up+Walk.

## Death (WorldScene: startDeath / stepDeath / endDeath)

Dying is a slow push into the dark that ENDS IN A PRESS. One eased 10s curve
drives all of it: camera zooms to 3× on the body; a screen-space veil ramps to
0.86 alpha, COMPOSITING over the world's own night/weather/shadow.
- **Do not put a postFX on the main camera.** A ColorMatrix monochrome pass
  re-routes the scene through its own render target, taking the night
  overlays and every body with it (screen went LIGHTER, corpse vanished).
  Monochrome, if it returns, belongs inside the night shader.
- THE PRESS IS THE REVIVE: `PLAYER_RESPAWN_MS` is the EARLIEST a press may
  land (die clip must finish); `PLAYER_DEATH_MAX_MS` is the backstop for a
  client that never presses. Both paths go through one `revivePlayer`. The
  prompt is a DOM card (wiki theme) in SCREEN space at 40% of the game view
  (world-space text was magnified into a banner by the zoom); it ARMS the
  press — a tap during the fade is swallowed, and the server refuses one
  before the clip ends.
- THE VEIL IS A VIGNETTE, NOT A FLAT WASH: a flat wash darkens the torch pool
  equally (and at 3× zoom the body sits inside the torch radius — no falloff
  on screen), which read as "very dark only". The gradient keeps
  `DEATH_DARK_CORE` of the light on the body, takes all but `DEATH_DARK` at
  the edges — it MANUFACTURES the pool the zoom flattened. ONE static
  gradient; only `opacity` animates (compositor-cheap).
- THE SEQUENCE IS DOM AND OUTLIVES THE ROOM: a backgrounded tab drops the
  connection, the server revives on its backstop, and the rejoin's state is
  ALIVE — the dead→alive transition never fires (veil + un-dismissable prompt
  hung over a healthy player). Three layers, the middle one is the rule:
  `handleDrop`'s clean slate calls `endDeath()`; `stepDeath` SELF-HEALS on
  `!selfDead`; `startDeath` sweeps strays off `<body>`.
- THE TORCH PICKS THE CORPSE OUT OF THE DARK: my own torch is exempt from
  BOTH its gates while dead (day fade `curTorchF` and the switch) and KINDLES
  on the same eased curve: `tf = max(lit ? base : 0, mine ? deathRamp : 0)`.
  My body is pushed to the FRONT of the light loop while dead (slots cap at
  `MAX_SHADER_LIGHTS`; a crowded street must not leave the corpse unlit) —
  which also brightens the corpse's lit copy for free (`lightAt` sums the
  same lights).
- The push aims at the BODY ON THE GROUND: `DEATH_AIM_FRAC` 0.12 of the frame
  above the foot anchor (the die clip lays the figure out; a 0.35 lift
  centred 10s of zoom on empty air).
- OPEN: the corpse should stay LIGHTER than the world. A second body copy
  above the veil was tried and reverted (a body drawn twice is outside the
  depth sort). The correct fix is LIGHTING: fold the death dim into
  `ambOut`/`ambEff` and divide it back out of my own `syncLitCopy` sample —
  but point lights, torch, emission floors and sun terms are NOT in ambient
  and must be scaled too, and that pipeline carries every day/night/indoor/
  weather look, so it needs a browser pass across all of them.
- Probe: `__ml.deathInfo()` (armed / zoom / veil / prompt / the MEASURED
  light on my corpse — `torch.l`, so a gate asserts the effect, not the
  switch). DEBUG `dbgkill` room message (same standing as `teleport`) runs
  the real hurtPlayer kill path.

## NPCs (maps2 placement + characters2 art, client-side decor)

maps2 places people (`maps2/worlds/<name>/npcs.json`, `pixel-maps2/npcs@1`,
spec `maps2/spec/NPCS.md`); characters2 owns who they are
(`characters2/npcs/<id>/`). The game just draws them.

- **NO SERVER STATE.** NPCs are client-side decor: the placement file is the
  whole truth; nothing synced, nothing validated, zero room cost.
- `scripts/build-npcs-manifest.mjs` → `client/public/npcs.json`: frame size,
  the eight static `base/<dir>` rotations, idle frame count PER DIRECTION.
  Art loads LAZILY per character (a world places ~20 of a ~190-strong
  roster).
- **They all face SOUTH and never walk** (maintainer). maps2's `facing` is
  deliberately IGNORED: only south has an idle clip, and honouring placement
  would freeze most of a street on static rotations. One line in `addNpc`
  goes back to `p.facing` when the other rotations exist.
- **The shadow sits between the feet**: the sprite origin is the ART-MEASURED
  foot anchor (`anchorlib.footAnchor` — the same function and numbers the
  player characters use). **Never eyeball this** — a guessed `originY 0.9`
  was up to 9px off, the exact "flying" bug the monsters took three rounds to
  kill. CLOAK GUARD, NPC-only: a floor-length hem is the ground contact, so
  an anchor drifting >4px above the sole line falls back to the sole (the
  foot-blob pass anchored 2 of the roster ~7px high on boots above the hem).
  The player measurement is untouched.
- **The idle is south-only in the art** (measured: nearly all characters ship
  a 5-frame idle, south alone). `idle` is keyed per direction so the other
  seven appear with NO client change when characters2 generates them — do
  not hardcode "south".
- **The calm idle** (maintainer: a city must not breathe in unison): clip
  created `repeat: 0`; `stepNpcs` plays it ONCE then parks on frame 0 for a
  fresh random NPC_HOLD_MIN_MS..NPC_HOLD_MAX_MS (0.1–5s) per NPC. Measured:
  parked ~78% of samples, 16 distinct hold buckets.
- Rendering goes through the SAME shared body pipeline (`resolveBodyDepth` +
  `placeBodyShadow` + lit copy; NpcAvatar satisfies BodyVisual). Never
  hand-roll a second path. Off-screen NPCs park like culled monsters.
- **Faked client-side collision**, the monster pattern: NPCs join the
  `monsterDodge` near-list at NPC_BODY_RADIUS; not in the collision grid, not
  in findPath.
- **Loading: standing art at BOOT; idle frames FIRST in the deferred batch.**
  Both original symptoms were one mistake — spawnNpcs started its OWN loader
  run in create(), which re-fired the loading overlay's progress events (bar
  restart) and delivered art late (pop-in). Now main.ts fetches placement at
  boot; `preloadNpcArt` queues one standing image per DISTINCT placed
  character into the boot batch; idle frames go FIRST in the deferred batch
  (queued last they landed 18.3s in behind ~800 action frames; first, 0.2s).
  **Never put the idle frames in the boot batch** — that is the loading-bar
  regression. (The player's own art now outranks NPC idles — see loading.)
- The idle clip registers LAZILY, per NPC, once its frame textures exist —
  NOT on a one-shot loader COMPLETE (COMPLETE fires between batches; a
  one-shot handler found its textures missing and gave up: 0 of 19 clips
  registered). Same shape as the monsters' single-call-site trap.
- Gate: `scripts/verify-npcs.mjs`. Probe: `__ml.npcInfo()`. TRAPS: the
  registry's `world` key holds the parsed World OBJECT (id is `worldName`);
  spawn in `create()` — `projectFlat` is meaningless in `init()`.

## Depth-fog on BODIES (syncLitCopy)

Monsters and remote players are coloured by the elevation depth-fog like the
terrain they stand on. Mechanism: every body draws twice — the raw sprite
UNDER the fog overlay (fogged exactly like tiles) and the crisp lit copy
ABOVE it; the copy's alpha fades by `night.depthFogAt(col,row,lvl).a` at the
body's own surface level, cross-fading crisp→fogged. NOT transparency: at
heavy fog you see the fog-painted body. The local player is fog-0 by
definition. Probe: monsterInfo() lit.alpha (own level 1.0, teal band 0.735,
saturated summit 0.001 — matches the terrain wash).

## Living camera (WorldScene.updateChaseCam)

- The camera CHASES the player: exponential ease (CAM_TAU 0.3s, trail cap
  CAM_TRAIL_MAX 70px; CAM_SNAP_DIST snaps teleports/respawns) + a
  speed-coupled ZOOM-OUT up to CAM_ZOOM_OUT (18%) of the base integer zoom at
  full run world-speed (CAM_ZOOM_REF_WU, driven by the gait EMA spdWu) —
  because the chase alone shows LESS in the running direction (maintainer).
  Ease-out 0.45s, ease-back 0.85s; at rest it settles onto crisp integer
  zoom, dead-centred. Fractional zoom while MOVING is the accepted trade.
  `__ml.lookAt` detaches the chase; no-arg re-attaches. Probe:
  `__ml.camInfo()`; regression in verify-smoke.
- **`__ml.teleport(col, row)`** — drop the player at the exact coordinates
  shown under the avatar's name (`fx/CELL_WU, fy/CELL_WU`). Server-
  authoritative ("teleport" message clamps, sets `elev`, clears queued
  movement/jump); camera snaps. Lands where asked even off standable ground.
  Debug only.

## Time-of-day (server-owned world state)

- Phase index in WorldState.timeIdx (shared DEFAULT_TIME_IDX /
  TIME_PHASE_COUNT); the cycle RUNS BY ITSELF (a core rhythm of the game).
  `TIME_PHASE_SECONDS` = **[40, 20, 40, 20]**, order **[Night, Morning, Day,
  Evening]** — the maintainer's durations, a 2-minute cycle. **DAY == NIGHT
  is load-bearing, not taste**: the clock pill runs the sun over
  morning+day+evening and the moon over evening+night+morning; those spans
  are equal ONLY while day and night are — that is what makes the two bodies
  move at the same speed. (Superseded "night ticks 3× as fast", whose point —
  short darkness — the 1/3 night also achieves, without a racing moon.)
- Time is CONTINUOUS (maintainer: no sudden swaps — discrete jumps made time
  look frozen): WorldState.phaseT (0..1, written by the 20Hz sim) sweeps
  hand/sun/ambient/torch via `blendPhases(u = timeIdx + phaseT)`, lerping the
  phase tables between MID-phase anchors — u = i + 0.5 is exactly
  TIME_PHASES[i]/SUN_PHASES[i], so every calibrated verify script still sees
  the approved keyframes (local probes pin phaseT = 0.5). Natural rollover
  enters at phaseT 0; a manual SKIP lands at 0.5 (the phase's characteristic
  look); unfreeze RESUMES from the held phaseT.
- **THE SUN IS THE HAND**: `sunFromHand` derives the grid cast from the hand
  angle by inverting the iso projection (passes exactly through the old
  keyframes: −90 → (R2,−R2), 0 → (R2,R2), +90 → (−R2,R2)), slope 0.34..0.45
  by altitude, strength 0 all night, ~6%-of-sweep sunrise/sunset ramps. The
  sunlit sweep spans morning+day+evening in proportion to their durations
  (`handAngle`, noon at day's middle); its `f` IS the sun's position on the
  clock pill, so cast shadow and drawn sun can't disagree. SUN_PHASES
  survives only as the sunVec(DEFAULT_TIME_IDX) init.
- TRAP: local probes pin phaseT via setTimeOfDay's tOverride param — reading
  state.phaseT inside setTimeOfDay clobbered the probe keyframe once.
- WorldState.timeSpeed ("time speed" button, "timespeed" message) scales the
  clock. The button cycles shared TIME_SPEEDS and **the array's order is the
  button's order**: x1 → x0 FREEZE → x0.5 → x2 → x5 → x10 → x1 (maintainer:
  freeze one tap from rest — "unlogical yes, makes me develop faster, yes";
  do not sort it). Explicit `{v}` jumps directly (tests use {v:1}); x0
  mirrors into WorldState.frozen. Speed changes resume from current phaseT.
  Manual skips work while frozen; tests must set a speed before expecting
  auto-advance.
- **Settings buttons PRINT their state** ("time-of-day: Day", "time speed:
  x2"/"frozen", "weather: Clear sky") — hud.ts `state` callbacks re-read on
  refreshSettings, which EVERY relevant state listener must call (the
  time-of-day one didn't and drifted out of sync — verify-smoke now asserts
  the printed phase against the world's). A new synced field a Settings
  button prints needs that one line in its listener.
- The [1] key / HUD button send "timeofday" — a SKIP that restarts the phase
  timer (room option phaseSeconds overrides durations for tests). State
  listeners apply changes instant+logless on initial sync, 2.5s fade + chat
  log after.
- **The clock OUTLIVES rooms**: rooms auto-dispose when empty; WorldRoom
  keeps a per-world `worldClocks` registry (timeIdx/frozen/weather/aurora +
  phase deadline, process lifetime) that a new room resumes — fast-forwarding
  missed phases — instead of resetting (maintainer hit "unfreezing doesn't
  stick"). Tests call resetWorldClocks() in beforeEach.
- Ambient palettes (TIME_PHASES) stay client-side; array length ==
  TIME_PHASE_COUNT. `__ml.timeOfDay(which)` is a LOCAL debug probe.
  Regression: server/test/timeofday.test.ts.
- TORCH is player state the same way (Player.torch, "torch" message): own
  light flips the local mirror instantly; a rejoin re-asserts the local value
  (torch.test.ts). Torch IMPACT is CONTINUOUS: `curTorchF` rides the
  ambient's 2.5s clock, 0 at full Day and 1 otherwise — flames melt away as
  daylight arrives (the switch keeps the preference).
- **The CLOCK PILL — "Fern starfall"** (client/src/clock.ts; the maintainer's
  pick from a 21-candidate design round: papercut family, Fern's greens, Sea
  glass's plain disc sun, Storm's starfield + falling star). A 40×16
  art-pixel landscape painted into ImageData, shown at ×2 (80×32 css,
  pixelated), pass-through, at the game view's bottom-right, 10px from the
  edge and 10px above the HUD rail. Flat cut-paper layers, hard edges, NO
  dithering, NO gradients (earlier rounds rejected for exactly those).
  - **The geometry is the approved mock's, VERBATIM** — AH 16, HOR 10, AMP 7,
    orb radius 3.4, sun glow radius 8 scaled by daylight, layer bases
    10/12/14. A 2.8 orb was caught on sight ("your sun and moon look more
    squary"); 3.4 is 7×7 with round shoulders. If the pill must shrink, drop
    SCALE — never re-tune the art.
  - Its corner is RESERVED: chat.ts caps log + input with `--ml-chatw`
    (100vw − 112px).
  - **ONE EDGE MARGIN, 10px, for everything that hugs an edge** (maintainer:
    "this will make everything equal"): stat chips, chat log + in-world
    input, the pill, the keyboard-floated chat box. verify-chat asserts the
    chat margin against the PILL's own rect, not a literal.
  - KEYBOARD: the phone keyboard covers both bottom corners; on chat focus
    hud.ts lifts log AND pill onto one line above the floated input
    (`:root.ml-kb-up`, `--ml-inputlift + 56`, .15s transitions). The lift
    recognises BOTH chat boxes (`.ml-chat-input` and the in-world
    `.ml-chatinput`; the latter is a direct child of `<body>`, so armLift()
    skips its hold-the-row-open step). Placeholders hide on focus. Gate:
    verify-chatpage.
  - **A tap on the world always BLURS the box**: Android's ▼ hides the
    keyboard WITHOUT blurring, and Phaser preventDefault()s the canvas
    pointerdown, so Chrome re-opened the keyboard on the next tap. The
    blur-on-outside-tap is gated on FOCUS, not on the box still floating
    (checking `lifted` left the trap armed on devices that report keyboard
    height). ChatUI closes on blur for the same reason — an open-but-blurred
    in-world box leaves Phaser's keyboard disabled forever.
  - **THE MOTION — TWO BODIES, NOT ONE BELT** (the design, after a
    single-orb belt was killed: the moon RACED, crossing on night alone). The
    sun and the moon are two objects, both can be in the sky at once:

        tau (0 at sunrise, 1 a day later)
        0        1/6                 1/2        2/3                    1
        |morning |        day        | evening  |        night         |
        sun  |------------ crossing ------------|            (below)
        moon --- crossing |            (below)  |----- crossing --------

    Each body crosses the pill in 2/3 of a day — SAME SPEED (measured
    10.00px each over the same slice) — and they share the sky at both ends.
    The sun is the main actor (drawn last, carries the glow); the daylit moon
    washes 15% toward the sky + a rim (harder washing hid it and broke the
    QA detector). Hills are painted LAST so bodies set below the horizon.
    Position is a pure continuous function of tau — join, skip and tick are
    all "paint this tau". `setClockTime(timeIdx + phaseT)` + `clockStar()`
    are the only entry points; clock.ts owns the mapping (`dayFraction`).
  - DELETED (do not resurrect): the half-dial's cross-fading faces + rotating
    hand, the +360 winding, the 1.25s glide, and the SERVER-side handoff
    freeze (WorldRoom.handoffHoldMs — a rendering artifact leaked into the
    authoritative sim).
  - Gate: scripts/verify-clockflip.mjs reads the canvas BACKING STORE
    (art-pixel coords, starvation-proof): sun alone at noon, moon alone at
    midnight, both at opposite ends morning/evening, moonrise with evening,
    equal speed, continuity at sunset and the wrap. Probe:
    `__ml.timeOfDay(idx, instant, phaseT)` (third arg parks the clock inside
    a phase). The version badge sits bottom-centre, clear of the pill.
- AURORA NIGHTS: WorldState.aurora (server-rolled in advanceTime — 45% of
  nights; auroraChance room option; gone by morning). Shader uAurora
  (DECLARED in the uniforms config — the uSun lesson) ADDS drifting
  green/violet curtains scaled by (1−uSun.w); `auroraAt()` is the exact JS
  twin (change both). Client eases curAurora on the cloud's ~4s roll; chat
  logs it. Probes: `__ml.aurora(on?, instant)`, `__ml.auroraAt(wx,wy)`.
  Regression: aurora.test.ts.
- SHOOTING STARS (Nangijala is the land you ARRIVE in): every join broadcasts
  "star" {name} — all clients draw the same streak (additive head + particle
  tail at depth 1.5M, brightest at night, chat-logged) + a micro-star echo on
  the pill (clockStar()). The server throws wild no-name stars at random
  during NIGHT (scheduleWildStar, 25-75s). Probe: `__ml.star(name?)`.
  Regression: star.test.ts.

## Weather (server-owned world state, layer 2)

- WorldState.weather (shared WEATHER_NAMES/COUNT; 0 Clear, 1 Cloudy, 2 Mist)
  cycles via the "weather" message; cloud cover EASES ~4s. The shader's
  uCloud (DECLARED in the uniforms config) drives a WORLD-ANCHORED 2-octave
  value-noise field (wavelength ~550 world px) drifting on fixed wind
  (~42/23 px/s via uAnimTime), shading ambient (depth 0.45×cover, muted by
  sun strength); cloudy ambient also greys ~20% toward luminance.
  `cloudFactorAt()` is the exact JS twin — change both together.
- **ALL twinned noise (clouds, aurora, mist) hashes with a PRECISION-EXACT
  integer chain** (mod-971 quadratic residues; every intermediate an integer
  < 2^24, so GPU float32 and JS float64 agree exactly). NEVER
  `fract(sin(big)*43758)` in a twinned field: phone GPUs resolve sin at
  ~0.002 rad up there and the lattices decorrelate (avatar tint out of sync
  with the drawn shade) — headless SwiftShader computes sin precisely, so QA
  screenshots never catch it.
- Probes: `__ml.weatherInfo()`, `__ml.weather(idx, instant)` (local force),
  `__ml.cloudAt(wx,wy)`. Regressions: scripts/verify-weather.mjs +
  weather.test.ts.
- **PRECIPITATION (weathers 3-8)** — Drizzle/Rain/Heavy rain/Storm/Snowing/
  Windy (client/src/weatherfx.ts): a manually-pooled particle layer in WORLD
  space at depth 899_500 (above world art, BELOW the night overlay — drops
  dim with night and take torch light — below the lit copies). Drops RECYCLE
  inside the camera view (+margin): constant density however the camera
  moves; counts scale with view area (REF_AREA). Storm: global sine gust on
  vx + camera-flash lightning every 5-14s; streak rotation follows velocity.
  Snow sways per-flake and SETTLES: falls to its own ground height, rests,
  melts, recycles — EXCEPT on water (SNOW_WATER_MELT ≈320ms, no rest):
  WeatherFX gets `waterAt(wx,wy)` from WorldScene (`isWaterAtScreen`; probe
  `__ml.waterAtScreen`). Windy
  is leaf debris (three autumn tints, per-leaf surge + curl arcs) + faint
  motion-line wisps at 2.3× gust. Each state brings overcast (WEATHER_CLOUD)
  and flat gloom (WEATHER_DIM → eased curPrecipDim in ambEff) — both applied
  instantly on join and by `__ml.weather(idx, true)` (WeatherFX.snap()).
  HEADLESS QA at big viewports must use instant (the eased path assumes a
  live frame loop), and starvation stretches the 110ms lightning flash across
  seconds — a "stuck" white wash that does NOT happen at real frame rates.
  Probes: precip/precipDim in `__ml.weatherInfo()`.
- **MIST (weather 2)** — creepy ground fog, part of the world (maintainer):
  a SECOND shader pass (MIST_FRAG) in nightlight.ts — the multiply light
  field can only darken; fog must COVER — rendering to its own RT composited
  NORMAL at depth 1_000_000, above the light overlay AND the lit copies (fog
  swallows whoever wades in). Each fragment runs the same exact-crossing
  surface resolve; density POOLS by resolved terrain height (full ≤~0.4
  levels, gone by ~2.4) — banks hug valleys, stop at cliff lines; banks
  drift along the WORLD axes (= iso diagonals on screen). Density posterizes
  into 5 bands (cap 0.74); the cold grey dims with ambient. LESSON:
  posterize AFTER scaling to the band range — floor() on raw density dropped
  everything below band 1 and the effect silently vanished (debug by
  bisecting the fragment with early colour returns). Eases on the ~4s cloud
  roll; skipped while clear. Exact JS twin `mistAt()` — change together.
  Probes: `__ml.mistAt(wx,wy)`, mist in weatherInfo.

## Directional sun shadows (day phases)

- The night shader carries a DIRECTIONAL SUN (uSun = cast-dir grid x/y, slope
  levels-per-cell, strength). The sun march is TWO passes over one field
  (maintainer: "the shadow on cliffs looks perfect — don't change that
  part"):
  - TERRAIN keeps the original multiplicative ramp (20×0.6-cell samples,
    mix(0.80,0.35) — the approved cliff darkness, byte-identical; prop share
    subtracted from its heights), but AVERAGES 3 complete marches jittered
    ±0.5 cell PERPENDICULAR to the ray to anti-alias the one-texel staircase:
    a straight edge samples the same transition at every offset and is
    UNCHANGED (verified Δluma≈0.1/255), a staircased hard edge smooths. True
    supersampling of complete marches — the sparse in-loop lateral-tap
    attempt aliased into a BIGGER zigzag and was reverted (`terrHeightSoft` =
    the per-sample height helper).
  - PROPS shade through one smooth MAX-MARGIN patch (fine 0.35 steps, margin
    = max over samples — per-sample multiplication scalloped small footprints
    into "x-mas trees"). Props occlude +1 level FLAT in the linear heightmap
    G channel (their art `levels` 2-5 made spikes); the patch amplifies the
    bilinear footprint into a plateau + fades reach ~2.5 cells (the raw
    pyramid tapered casts into spiky needles). Terrain-only heights
    (faces/AO/ground z) stay untouched — prop art is a billboard, not a wall.
    There is NO separate baked contact-shadow overlay (a game1 relic;
    restored once, removed).
- **DAYLIGHT IS SKY + SUN** (maintainer): the phase ambient splits 55% flat
  sky + 45% directional that only reaches surfaces with a clear line to the
  sun — full authored brightness NEEDS the sun (multiplying a small factor
  onto full ambient read as nothing). Every fragment marches the LINEAR
  heightmap toward the sun; faces away from it shade via a Lambert gate;
  point lights still add in shadow. Morning casts long shadows screen-RIGHT,
  Day straight down-screen, Evening screen-LEFT, Night off — lerped with the
  ambient clock so shadows sweep. CPU twin `sunFactorAt()` shades lit-copy
  tints. Probes: `__ml.sunInfo()`, `__ml.sunAt(col,row[,z])` (z=−1 = own
  height). Regression: scripts/verify-sunshadow.mjs.
- STALE GATES, known: verify-glow-seams (11 horizontal raw-field seams on
  glow_test, identical on the pre-light-ledger baseline — pre-existing);
  verify-solidband + verify-wallspread (predate maps2 worlds, fail on
  baseline); verify-penumbra is PINNED TO NIGHT and finds pre-existing base
  defects at some ledges (fails identically on the pre-sun baseline —
  candidate-placement sensitivity, needs its own follow-up).

## Night lighting (client/src/nightlight.ts)

- Always-night per-pixel shader: MULTIPLY overlay; per-pixel surface resolve
  (cell + height) → point lights with attenuation, LOS cast shadows, Lambert
  face gating with penumbras at both ends of every wall band.
- **DEPTH-FOG — cel-shaded EDGE-HIGHLIGHT fog** (`DEPTHFOG_FRAG`; job: make
  cliff EDGES readable — maintainer: "see the exact edge where the cliff
  starts"). A third, always-on NORMAL-blend overlay. TWO channels, summed
  then POSTERIZED into cel bands (teal FOG_NEAR → pale FOG_FAR):
  1. **Smooth horizontal DISTANCE**: 2D distance of drape-reconstructed
     `scol/srow` to the player; onset FOG_D0 (11 cells), +1 band per FOG_DW
     (1.2). Reconstruction seeds `sz=uPlayerZ`, iterates ×3 through `drape()`
     (anisotropic blur of `terrH=uHeightL.R−G` along the col+row fold axis,
     half-width DRAPE_RS 2.5) so flat ground reads as clean concentric bands.
     `terrH` uses R−G = occlusion height MINUS placed props (a boulder never
     haloes flat ground; edge-clamped). FACE-SMOOTH: `faceDepth =
     heightAt(cell) − z` grows down a near-vertical face; past ½ level the
     band lerps from `floor(distCont)` to raw `distCont` — faces fade to the
     smooth value (no chevron staircase) while flats keep crisp rings.
  2. **Hard elevation EDGE**: `elevBand = ceil(|pLev − z|·ELEV_STEP −
     ELEV_EPS)` where `z` is the MARCH'S OWN resolved fractional level — NOT
     `heightAt(cell)` (a face pixel resolves to the high cell; heightAt only
     steps at the FOOT; z drops the instant a pixel passes the lip, so the
     boundary lands ON the drawn cliff-top edge). `pLev = uPlayerZ` is the
     EASED player elevation (fog follows a jump smoothly). `abs()` =
     symmetric both ways; ELEV_EPS keeps a flat tread clear. z is constant on
     same-level ground → zero contour on flats; not gated by FOG_D0 (edges
     pop at the feet).
  - `band = clamp(distBand + elevBand, 0, BANDS−1)`; fog opacity scaled by a
    PER-LEVEL TRANSPARENCY: SAME_LEVEL_FOG (0.10) on the player's own level,
    rising (1−0.10)/LEVEL_FADE_SPAN ≈ 0.06/level to FULL by 15 levels (the
    maintainer tuned the climb down from ~0.088 — too opaque partway up a
    tall wall). ELEV_STEP = 0.5 (≈ +1 band per 2 levels); **ELEV_D0 = 7** is
    the elevation DEAD-ZONE — no edge fog until the surface is 7 LEVELS from
    the player, so a house/roof stays clear and only real mountains fog
    (occlusion_test tops at exactly 7 = boundary; the coord label prints the
    world id).
  - REJECTED history: elevation-banded v1; then a TRUE 3D-distance SPHERE
    with drape + `ZW` weight — killed the zigzag AND, fatally, the edge
    contrast (its bands floated across terrain, never landing on an edge;
    maintainer: "makes it even harder to see the real edge"). Hence:
    horizontal-only smooth channel + the hard elevation term.
  - Composited at depth **900_000.2** — above the multiply overlay, below the
    tap marker (900_000.5) and lit copies (900_001): fogs the WORLD, never
    the characters. Dims with night, floored so bands read in the dark.
    Master strength `nightlight.fogStrength` (0 = instant rollback). Probe:
    `__ml.depthFog(strength?, testZ?, testCol?, testRow?)` (plants a virtual
    player headlessly). Regression: scripts/verify-depthfog.mjs. Tunables are
    named GLSL consts atop DEPTHFOG_FRAG.
- **Bridge underside line = the ground AO seam, NOT the walk** (the
  maintainer's catch): the AO seam term read the up-screen neighbour via
  `heightAt` (deck-inflated), so a floating span read as a tall WALL and
  stamped seam AO on the water. Fix: `baseTerrAt()` — B channel of
  `world-heightmap-linear` carries the BASE terrain level (never
  deck-inflated, texel-centre read); ONLY the AO seam term (+ its CPU twin
  `bArr`) uses it — same packing expression as R, so non-deck cells are
  byte-identical. REJECTED first theory: a `uDeck` walk-divert, which broke
  the night field into per-cell plates ("chess pattern") — do not re-attempt
  attribution changes casually. The faint 1-2px contact edge under spans is
  the face-sliver attribution — known, subtle, needs a pixel-proven plan.
- Heightmaps: the NEAREST surface map holds TERRAIN levels and drives resolve
  + wall-face classification; `world-heightmap-linear` (LINEAR) holds terrain
  + solid objects and drives ONLY the LOS march. A cell's LEVEL packs into
  one 8-bit channel as `level*hScale`, decoded `*255/uHScale`; **`hScale` is
  chosen PER WORLD** in `buildHeightmap` (16 for worlds ≤15 levels —
  byte-identical to history — smaller when taller). The old fixed *16
  SATURATED at 15.9 levels: the_island2 (peak 32) clamped every high cell and
  the depth-fog painted a hard seam across the flat peak. Regression:
  scripts/verify-heightscale.mjs (teleports to the level-32 peak).
- **Solid objects are ART, not walls**: they block light and cast a soft
  shadow but must NEVER get a wall-face band — modelling them as blocks
  painted knife-edged phantom shadows outside the drawn art.
- **Contract for new tile categories**: unknown categories default to plain
  walkable ground AND terrain lighting; every new solid/decor category needs
  a SURFACES entry or its block shadow returns. ENFORCED: `npm test` runs
  `scripts/check-surfaces.mjs`, which FAILS on an unclassified category
  (across ALL maps2 worlds) and prints a ready-to-paste proposal; WorldScene
  warns at boot. The table lives in its own file
  **`shared/src/surfaces.ts`** (small, conflict-light; `index.ts` re-exports)
  — the ONE games2 file the ART agents are authorised to edit, so their
  deploys never stall on the game agent. Runbook: **`games2/SURFACES.md`**.
  If a DIFFERENT gate fails on an art push, that's a real art bug, not a
  surfaces edit.
- **EMISSIVE TILES ARE REAL LIGHTS — THE LIGHT SLOT LEDGER** (maintainer:
  "NO DIFFERENCE in how bright the bonfire [tile] is vs the campfire
  [object]"). Emission used to be additive glow STAMPS only (no attenuation/
  LOS/elevation); now `buildEmissiveSources()` resolves every emissive prop
  once per world and `pickWorldLights()` fills the world slots (free slots
  nearest first; tenure + `LIGHT_EXIT_PX` are the hysteresis — see below).
  Measured parity
  bonfire-tile/campfire 0.95. THE LEDGER (12 slots): 1 my torch + 1 ambient
  agent + 2 future fx + **8 world** — reservations STRICT, never lent.
  Write-side APIs: `client/src/lightslots.ts`; full spec
  `games2/spec/LIGHT_BUDGET.md`. The laws:
  - **Remote players' torches are NEVER lights** ("a player can only ever see
    its own torch") — 8 world slots would starve on a torch-bearing street.
    `torchLit(id)` is gone; only `this.torchOn` matters (Player.torch stays
    synced server-side).
  - A slotted source's ground-pool STAMP is filtered out per frame (`srcId` +
    `ry` tags): keeping both double-brightens ground AND characters
    (`curLights` and `curStamps` both feed `lightAt`). High per-cluster halos
    stay (the art's bloom). Losing the slot returns the pool = the OVERFLOW
    FALLBACK (over-budget spots degrade to the pre-ledger look).
  - Light params: `tiles2/emission.json` optional `lights` table (curated in
    tiles2's `pipeline/emission.py` LIGHTS — a hand-edit of the json is lost
    on regeneration). Tile-path stem beats material; `null` = stamp-only;
    absent → derived default. The bonfire tile pins the campfire's numbers
    (radius 7, [1.9,0.88,0.3] overbright, flicker 1).
  - The indoor ROOM FILTER applies to emissive lights exactly as to the
    torch — a fire in your room lights it, one outside fades on `indoorMix`.
  - `check-light-budget.mjs` (in `npm test`): no camera window may be
    reachable by >8 world pools. RATCHET: pre-existing over-budget worlds are
    pinned in `spec/light-budget-baseline.json` at their measured worst and
    fail only when WORSE. It MIRRORS the client's radius derivation —
    drifting from it audits a different set than the renderer lights. The
    LIVE the_island2 is **8/8, exactly at the line** (worst window at
    114,54) — tell maps2 before adding ANY light source near it.
  - **Derived defaults are CAMPFIRE-ANCHORED** (maintainer on glow_test:
    "IT'S FILLED WITH LIGHT SOURCES — HOW CAN THIS MAP STILL BE DARK?"; the
    autopsy: radius 3.5 was smaller than the inter-source spacing — 8 held
    lights summed to 0.002 against ambient 0.09; radius was the primary
    killer, 21.5× alone vs intensity's 5.7×). Anchor: hue = the art's
    glowColor normalized to peak 1, intensity = 1.9 · clamp(avgS·1.15, 0.45,
    1), radius = clamp(4 + avgS·4, 4, 7) — a strong source IS a campfire, a
    faint one still ~45% of one. REJECTED: full-campfire-for-everyone (99.1%
    of the screen over field 1.0 = wall-to-wall clamp plateau; strength
    scaling keeps contrast).
  - Derived defaults are **SHADOW-FREE GLOW POOLS (negative radius)**, at
    avgS·1.3: a prop OCCLUDES ITS OWN CELL in the heightmap, so a shadowed
    light at z 0.5 was eaten by its own prop before reaching the body beside
    it (the ground survived on the march's 0.22 bounce floor). A curated
    entry opting back into `shadows` must put its z ABOVE the prop's +1
    occluder (the bonfire is z 1.1).
  - **Shadow-free pools are EXEMPT from the face Lambert gate** (the `isFace
    && uLightPos[i].w > 0.0` condition): a glowing CUBE's own pool sits
    inside its cell behind both face planes, so every glowing block's faces
    were pitch dark. A pool is ambience, not a lamp a face can turn away
    from. This also removed a shader/CPU disagreement (lightAt never had a
    face gate). Positive-radius lights (torch, campfire, curated bonfire)
    keep the gate — the approved wall look.
  - **A SEALED-ROOM fire is INDOOR-ONLY** — lit to the degree I am in its
    room (indoorMix), never from outside: the LOS march's 0.22 bounce floor
    otherwise pours 22% through house walls at night, and its halo stamps
    painted an orange blob on the roof. `sealed` is probed per source at the
    4-NEIGHBOURS via `roomVerdictAt` (the prop's own cell is blocked and
    never in the roof set — the same trap the stamp gate fell into). A fire
    under a BRIDGE stays unsealed (a bridge is not a room). Stamps take the
    same gate in rebuildProps (`sealedEmissiveCells`).
  - **Slots are held by TENURE, not re-ranked** (per-frame closest-first
    popped lights mid-screen): a HOLDER keeps its slot until its pool stops
    touching the view (release needs LIGHT_EXIT_PX past the boundary;
    acquisition requires actually touching — entry strictly tighter than
    release, so a boundary hoverer can't flicker). Newcomers take only FREE
    slots, nearest first, RAMPING in over LIGHT_RAMP_MS (450) while their
    pool stamp crossfades out — a mid-view acquisition is a dissolve, never
    a swap. An over-budget map degrades to "some fires are stamp-only while
    visible" — a look, never an event.
  - **…and RETIRED under pressure, never held forever**: when a waiting
    candidate beats a fully-settled holder by LIGHT_STEAL_MARGIN (200px —
    hysteresis, no ping-pong), the worst holder DISSOLVES out (the
    acquisition crossfade reversed, 450ms), at most LIGHT_RETIRE_MAX (2) at
    once. Gate: scripts/verify-lighttenure.mjs pans glow_test (~180 sources
    vs 8 slots): every release past the view boundary, every deep
    acquisition mid-ramp. ITS TRAPS: the first lookAt is a camera TELEPORT
    that legitimately dumps spawn-side holders — settle before the baseline;
    and the probe's fairness numbers are captured AFTER the frame's
    decisions (before, a same-frame retirement reads as "pressure, nothing
    retiring").
  - The QA `probeLight` consumes a WORLD slot while set — slot-counting
    gates must expect ≤7 world holders.
  - Probes: `__ml.lightSlots()` (live ledger + overflow), `__ml.lightAt()`
    (CPU twin), `__ml.torch(on?)`. Gate: `scripts/verify-lightparity.mjs`
    (parity, indoor, budget invariants).
- **Self-emission** is data-driven from `tiles2/emission.json`
  (`tiles2-emission@1`, tiles2's): per-MATERIAL glow params + per-tile-path
  `sources`. In maps2 worlds every emissive tile is a PROP; `rebuildProps`
  stamps a tinted radial halo per visible source into the world-anchored
  additive glow RT the shader ADDS to the light field (a mushroom lights its
  patch, the forest stays dark). Showcase world: maps2's `glow_test` — where
  glow/night QA happens. (The v1 emission registry/demo retired 2026-07-14
  with `tiles/`; history in git.)
- The light/mist/depth-fog overlay quads BLEED ~1% past every screen edge
  (spanScale = 1.02; overlays drawn at invZoom*k while uCam spans k× the
  view — the stretches cancel, world→screen mapping EXACT): without it,
  fractional zoom left the quad a sub-pixel short and high-DPR phones showed
  a 1px unshaded line at night. TEST PATTERNS (nightCal ≥3) render with k=1
  (raw-field readbacks treat canvas pixels as texels 1:1; the stretch
  resamples rows into phantom seams).
- Debug: `__ml.nightCal(flip,span,test)` (field test patterns — headless
  only; the old [6]-[9] keys are retired); `__ml.probeLight(col,row,z,
  radius)`; `__ml.lookAt(col,row)`. Numeric probes: verify-solidband,
  verify-penumbra, verify-wallspread, verify-timecycle, verify-lit-order.
  Run them against a dev stack before touching the shader.

## Mobile / PWA (client)

- **WIKI-STYLE UI (the complete HUD remake, 2026-07-30)**: the pixel-art UI
  kit and vine/crystal frame are RETIRED (frame2.ts + plate.ts deleted;
  history in git). Every DOM surface is plain HTML/CSS on the SHARED WIKI
  THEME (`client/src/theme.ts` = wiki/site/wiki.css tokens: cream/dark
  palettes, serif headings, coral #d97757 accent, 1px var(--border), 8-14px
  radii). DARK MODE is one choice for wiki AND game:
  localStorage["wiki-theme"] → `<html data-theme>`; theme.ts follows the wiki
  drawer via `storage` events; wikipanel.ts mirrors game-side toggles onto
  the live iframe (`storage` doesn't fire in the writing document); Settings
  has a theme button. Pixel-art ICONS
  stay, pixelated, at their AUTHORED 1x GRID — hud.ts sizes each img to
  naturalWidth/2 (the /ui2 bakes are exact 2× of hand-drawn art on
  non-square canvases; a fixed square box distorts — maintainer: "not pixel
  perfect"). Tab row + pages share 16px side margins; tabs 56px (48 at
  ≤640h); 1px bottom rule. REJECTED (maintainer, do not re-propose): a
  screen-edge frame around the game view ("it looks bad" — full-bleed
  stands); an in-game bottom-right chip for the version badge (it keeps ONE
  quiet bottom-centre placement everywhere). NO zoom compensation in the new
  UI (uiscale.ts survives only for loading.ts + the reconnect toast). Gates:
  verify-bars/-hudtabs/-clockflip/-chatpage/-gamepad/-select.
- **THE WIKI DRAWER SLEEPS THE GAME LOOP** (`client/src/gamefreeze.ts`): the
  drawer hosts a second document on the SAME main thread, so `openWikiPanel`
  calls `freezeGame()` (TimeStep.sleep(), rAF cancelled) before the iframe
  exists; `closeWikiPanel` thaws. Measured: the wiki went 3.5fps/367ms
  stalls → 60fps/17ms worst. Nothing needed lives on that loop (Colyseus
  socket is event-driven — verified across a 30s freeze; WebAudio schedules
  itself; HUD is DOM). Input stops, which is correct (the server integrates
  only what it receives; a frozen client stands still; >2-cell movers snap on
  return under the teleport rule). **Waking is NOT `TimeStep.resume()`** —
  see UI_AGENT.md: it arms Phaser's 120-frame panic cooldown = visible slow
  motion. Gate: section 3 of verify-wikibtn.mjs; probe `__mlFreeze`.
- **HUD (golden-ratio split)**: game viewport = TOP 61.8% (`#game`,
  `--hud-h-inv`); bottom 38.2% (`--hud-h`) is the DOM HUD
  (`client/src/hud.ts`): 6 wiki-style tabs over pages. applyLayout()
  publishes --hud-h/--hud-h-inv in REAL px (consumers parseFloat). Settings
  hosts the toggles + theme; the time-of-day button keeps the `.ml-hudbtn`
  hook (smoke). `.ml-plate-btn` survives as a plain-CSS class — the ambient
  agent's cycler expects it. Pointer events in the HUD never reach Phaser —
  e2e taps stay in the top 61.8% (canvas centre y = VH*0.309).
- **Tap/hold-to-move**: a tap RUNS (no double-tap gesture — "nobody walks
  when they can run", maintainer); the autopilot eases into a walk inside
  APPROACH_WALK_RADIUS (2.5 cells). HOLDING steers continuously: trip starts
  on pointerDOWN, the beacon tracks the finger every frame (pure
  projection), the real findPath replan runs on an adaptive budget (cost×8,
  floor 50ms; measured p50 3-5ms / p95 17-24ms, scripts/bench-findpath.ts —
  per-frame replans eat phone frames); a deferred replan commits when the
  finger rests and on release. `trip.slow` carries across hold replans.
  Movement keys cancel (and pause hold replanning).
  - Routes come from shared **`findPath`** (A* over the terrain grid: walk
    edges, NEAR-LEVEL-ONLY diagonals, CARDINAL 1-level jump climbs at ~3×
    cost, +0.6 for cells hugging solids). A diagonal is allowed only when its
    destination AND both flanking cardinals stay within WALK_CLIMB of the
    current level — the round body clips the shared CORNER cell mid-segment,
    and a diagonal past a real drop walked bodies off the corner into the gap
    (maintainer: "shortcuts and falls"). Jump-climb diagonals disallowed
    (jumps are cardinal). Gate: the occlusion_test bridge-climb trip in
    navigation.sim.test.ts.
  - The route is HITBOX-aware end to end: waypoints one per cell (merged
    long legs drift a quantized follower into prop margins), each nudged
    away from adjacent solids; the FINAL point is `clearanceAdjust`ed out of
    any solid's margin (a tap at/inside a prop walks to the nearest spot the
    BODY can occupy instead of grinding at the face). A* is best-effort:
    unreachable/solid goals route to the nearest reachable rim; `null`
    ignores the tap.
  - The FOLLOWER lives in `shared/` (**`startTrip`/`stepAutopilot`**) and
    emits the SAME 8-way screen input a keyboard would (best-of-8 by dot
    product through `screenToWorldVector`) — prediction, server validation
    and auto-jump behave identically to keys. Its rules: (1) "open heading"
    checks simulate a REAL stepMovement tick (corner probes and all; a
    centre-point probe lies at 1-cell gaps), measured against each input's
    own speed-scaled displacement; (2) a body-blocked detour heading is
    COMMITTED (`trip.steer`) until the direct opens / waypoint advances / a
    clearly better escape appears (per-frame re-picking made the player
    vibrate at a gap's mouth); (3) waypoints advance when the movement
    SEGMENT swept within the radius, and radii scale with observed per-step
    distance capped at one cell (endpoint sampling at run speed under long
    frames leapfrogs/orbits forever); (4) once one step exceeds a cell the
    trip stickily demotes run→walk (`trip.slow`) — 2.5fps frames cover two
    cells per decision. A 1.5s per-waypoint stall re-plans once, then gives
    up (a stall within ~1 cell of the goal = arrival). Auto-jump uses shared
    `autoJumpWanted` (probe scaled by the DOMINANT axis so concave "V"
    corners fire). Double-taps are timed by DOM event time
    (`pointer.upTime`), never the game clock.
  - The destination MARKER is a glowing additive beacon at depth 900_000.5 —
    above the darkness overlay and terrain occluders, below the lit copies;
    pulses until the trip ends (verify-tapmarker.mjs samples real pixels at
    night). A NORMAL-blend dark under-ring rims it: ADD light cannot
    brighten near-white ground — on snow the beacon vanished (maintainer);
    the dark outline carries the shape on bright terrain. Probes:
    `__ml.tapTo`, `__ml.target`, `__ml.path`, `__ml.navLog`,
    `__ml.gridAround`, `__ml.pickAt`.
  - **Wedge-proofed holds**: pointerdown ignores new touches while
    `holdPointerId` is armed, so a swallowed release (DOM overlays racing the
    gesture, or an OS touchcancel Phaser doesn't re-emit) used to wedge the
    client permanently (stale holdGround re-armed the trip every frame;
    every new tap ignored). Three healing layers, all funnelling into
    `dropHold()`/`commitReleaseHold()`: (1) frame-loop self-heal in
    predictAndSend (hold armed but Phaser's pointer slot up → drop, no final
    commit — the ground point is stale); (2) window-CAPTURE
    touchend/touchcancel (all fingers up → commit like pointerup) and
    touchstart (fresh finger while a stale hold is armed → drop); (3) a
    teleport/respawn snap cancels MY trip + hold outright. Probes:
    `__ml.holdInfo()`, `__ml.wedgeHold(x,y)`; gate:
    `scripts/verify-tapwedge.mjs`.

## Audio (games2/composer — the games-audio agent's module)

- A THIRD agent works `games2/`: **games-audio** (the composer;
  `sounds/spec/AUDIO_INTEGRATION.md`), sole owner of `games2/composer/` +
  `coordination/games-audio.json`. It binds `sounds/` + `music/` to the game:
  WebAudio buses, surface footsteps at gait cadence, thunder, ambience, the
  looping score with ducking/night dip, scale-snapped tonal SFX. See
  `composer/README.md`.
- Game code talks to it ONLY via the `gameAudio` singleton — the calls
  sprinkled in WorldScene/hud.ts/main.ts/ambient/thunder are the audio
  agent's wiring; **don't remove them**, and emit new semantic events
  (`gameAudio.event("item.get")`, names from `sounds/bindings.json`) when
  adding gameplay that should sound.
- **Music beds generated but NOT routed**: five tracks (battle/cave/home/
  town/adventure) audition at `/#score`; the in-world score is unchanged
  until the maintainer picks what plays where. Routing is dormant in
  `composer/engine/contextMusic.ts`; selection is pure and tested
  (`composer/engine/bedSelect.ts` + test): priority + Schmitt hysteresis,
  PLACE BEATS TIME, fallback chain to the catalog track (never silence).
  When wired: battle reads the monster brain's `mstate` (chase/combat — a
  roaming monster scores zero), cave reads deck slabs overhead, home the
  spawn bonfire, town road/farm tiles. Beds are −18 LUFS with measured loop
  points and resume where they left off. Probes: `__ml.audioBed("cave")` /
  `__ml.audioBed()` / `__ml.audioField()`. Gate: scripts/verify-beds.mjs.
- **A SOUND PLAYS ONLY WHEN ASKED FOR — the wiki is where it gets asked**
  (maintainer). The engine is silent-by-default: an event plays NOTHING
  unless (a) on the small approved list (jump/fall grunts, UI clicks, chat
  notify) or (b) assigned by the Game Master in the wiki (requests land in
  `live/tuning/sfx_requests.json`; the composer wires them into
  `EVENT_ASSIGNMENTS` in `composer/engine/api.ts` and deletes the acted-on
  entry IN THE SAME COMMIT — a request is a message, not a record). The
  record of what an assigned event plays is **`composer/assignments.json`**
  (`pixel-composer-assignments@1`, built by `scripts/build-assignments.mjs`,
  staleness-gated by verify-quiet) — read THAT, never fall back to
  `EVENT_FOLEY`/`bindings.json` to describe an assigned event (they are
  outranked; showing one looks like a revert). `bindings.json` resolves only
  for `BINDINGS_APPROVED` names. **Emit semantic events freely** with
  LITERAL names (the wiki scans call sites; a ternary hides the name) —
  silent events are exactly what the GM assigns sounds to. Already emitted:
  combat.kick/.punch/.hit_taken/.monster_die/.cross_on/.cross_off,
  player.die, item.pickup, item.drop. Gate: scripts/verify-quiet.mjs (the
  can-sound surface must not grow without approval; the assignable events
  must keep being emitted).
- **Background**: hidden page → master ducks to 50%, the score keeps looping
  (native-loop handoff in composer/engine/music.ts — background timer
  throttling killed the crossfade scheduler). Gate: verify-background.mjs.
- `gameAudio.clock()` / `__ml.audioClock()` publishes live beat/bar phase +
  section intensity (context beds carry measured key + tempo, so tonal-SFX
  scale-snap keeps working). QA: `__ml.audio()`; scripts/verify-audio.mjs
  (dev stack, end to end).

## Dev-test workflow (fast loop — keep it this way)

- **Navigation/movement logic → `server/test/navigation.sim.test.ts`**, NOT
  the browser: the real brain (stepAutopilot) against the real body (unstick
  + stepMovement + auto-jump) on REAL worlds at ~1000× real time — ~100
  seeded trips × three frame cadences (16/133/400ms; the laggy rows catch
  the big-dt freeze and orbit classes) in ~2s inside `npm test`. On failure,
  print stepAutopilot's debug fields — full forensics, no browser.
- **Browser = graphics + glue only, ONE session**: `scripts/verify-smoke.mjs`
  runs everything browser-bound in a single Chromium + world load (~30s):
  loading overlay, badge, tap run, hold steering, keyboard cancel, jump anim,
  anim rates, in-place reconnect (last — it swaps the session), then one
  reload for a glow_test join. Per-feature scripts remain for deep dives.
- **Headless-GL starvation preflight**: verify-smoke measures raw keyboard
  speed first and ABORTS ("HARNESS STARVED") if slow — software-GL at big
  viewports throttles the frame loop into slow motion that fakes "stuck
  player" bugs (cost an hour of ghost-chasing once). Keep e2e viewports
  small (480×320); `scripts/debug-speed.mjs` measures.
- **HUD / visual QA at DEVICE-WIDTH mobile geometry** (the maintainer plays
  normal mobile view): Playwright `{viewport:{width:393,height:851},
  isMobile:true, hasTouch:true}`; check light AND dark when touching themed
  surfaces. Movement-timing e2e stays on the small fast viewport — the
  starvation rule outranks realism.
- Rule of thumb: no pixels/pointers/websockets/Phaser anims needed → it
  belongs in `server/test` (3s), not a browser (minutes).
- **Deploy** (push to main → live): the workflow runs `test` (typecheck +
  full suite) IN PARALLEL with the layer-cached image build; `deploy` needs
  both. Triggers on `games2/**` AND every domain the image bakes (art pushes
  deploy automatically — maintainer; the concurrency group collapses rapid
  pushes into the newest run). A maps2 push using an unclassified tile
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
  (2) Every Phaser /assets URL is stamped `?v=<build sha>` (assetver.ts,
  VITE_GIT_SHA); the server grants `immutable` 1y ONLY when v matches its
  OWN GIT_SHA (same image bakes bundle+art, so those bytes can never
  change; mismatch → no-cache revalidate). New deploy = new sha = fresh
  URLs — stale-cache-proof by construction; sw.js caches nothing.
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
  **DO NOT replace the global build sha with per-file/per-domain content
  hashes for ART** — proposed and REJECTED: the global sha is what makes the
  immutable grant VERIFIABLE (the server compares ?v against its own
  GIT_SHA and can only freeze bytes it shipped); per-file hashes force it to
  trust any ?v — converting the worst case into a 1-year cache entry no
  deploy can heal. It also breaks the audio agent's ?v stamping, leaves
  ~2 MB of client/public art unstamped, and breaks the CI gate.
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

## Indoor mode (the cut-away)

**A CUT-AWAY, NOT AN X-RAY** (maintainer). Walk under a roof and the building
is drawn WHOLE but TRUNCATED: every column stops at `indoorTop =
min(roomFloor + dial, ceiling)`. Nothing hidden, nothing transparent, nothing
half a tile. The dial is `client/src/indoorwall.ts` ("Indoor wall height",
1…6 levels, default **1**); brightness is `indoorlight.ts`, default **40%**.
Both defaults are the maintainer's own picks — do not "restore" either.
Probes: `__ml.indoorWall(v?)` / `__ml.indoor()`.

- **Measured UP FROM THE FLOOR, not down from the roof.** `ceiling − N` is a
  wall height only when every room has the same ceiling — the house's
  ceiling is 6 and the caves' 8 over the same floor, so roof−4 left walls
  twice as tall in the caves. From the floor, 2 is 2 in a cottage and a
  cathedral. The ceiling survives as a CLAMP and as the "am I above the
  room?" line (`indoorCeil`, still `deckBot`, never `roofLevel`).
- **The floor is the ROOM'S MINIMUM**, not the cell underfoot (anchoring to
  the feet made every wall jump 16px per ledge step; the minimum keeps a
  raised shelf below the cut). The MAX is 6 = the tallest shipped room
  (measure from the floor and the DEEPEST room bounds you — opposite of the
  old roof−N dial). The storage key changed with the meaning
  (`ml-indoor-cut` → `ml-indoor-wall`) so old tuned values are not misread.
- **The cut is SCOPED TO THE COVERING CONE — the neighbour's house keeps its
  roof** (maintainer: entering house_a must not show into house_b).
  `indoorCut` is the complete CONSTRAINED SET: my building (per-wall raise)
  plus every other column whose full-height art would bury one of MY
  floors/entrances (the down-screen cone, capped per cell by the 0.9375·k
  burial slope, never below the dial). Everything else draws WHOLE, deck
  included — house_b renders closed and goes black under zero ambient,
  torch-findable. Threaded consequences: absent-from-the-map = full height
  (redrawGround falls through to the outdoor draw; occluders rebuild the
  neighbour's deck; aboveCut's per-cell answer is `entry ?? Infinity`); the
  shader's R channel gained the **127 "unconstrained" sentinel** (127 =
  resolve full; 0-126 = constrained cut; 128+cut = my room; setRoom writes
  the full grid and takes `top`). The kill switch (`__ml.indoorRaise(false)`)
  means the LEGACY world-wide scalar cut — the gates' flat frames depend on
  it. My space's connected chambers are ONE space, so their floors are all
  mine (the old world-wide protectedFloor pass is gone).
  - THE DEPTH FOG IS ROOM-GATED WITH IT (DEPTHFOG_FRAG uRoom/uRoomOn/
    uIndoorMix): its pale far bands painted a glowing ring over the
    zero-ambient blackness; fog outside my room fades on the same mix.
    Outdoors byte-identical. The MIST pass still paints indoors-outside —
    pre-existing, rare, noted.
  - Gate: `scripts/verify-indoorscope.mjs` (house_demo, six roofed houses):
    no constrained cell inside house_b, sentinels published, probe-light on
    the neighbour's roof, kill-switch flat world, the transition fade.
- **The transition is a DEBRIS CROSSFADE, not a pop**: on the indoor flip the
  REMOVED art (roof slab, wall bands above each cut, the cone's tops) is
  rebuilt as ordinary world-anchored images at occluder depths
  (`buildIndoorDebris`) wearing `alpha = 1 − indoorGrade()`. ENTRY: the
  world repaints to the cut state on the flip frame under OPAQUE debris
  (picture unchanged), which then dissolves. EXIT: commitIndoor(false) does
  NOT repaint; the cut world stays drawn (mask, cuts, `night.indoor`,
  aboveCut, pickGround follow the DRAWN state) while the debris fades back
  in; the real repaint happens when the GRADE lands — opaque debris equals
  the real geometry, so the swap is invisible. Mid-doorway turns just
  reverse the fade (the mix IS the state). Instant paths stay instant (kill
  switch, world unload, QA toggle). A direct room-A→B crossing mid-fade
  keeps ≤1s of stale fade art — accepted. Probe: `__ml.indoorFade()`.
  - **The debris obeys the LAP RULE**: where a deck coincides with its own
    equal-height column (`deck.level == cell.l` — a roof lapping its walls,
    hall pillars), the real renderers draw the COLUMN's baked top and skip
    the deck; buildIndoorDebris must too (same `dk.deck.level > cell.l`
    guard as rebuildOccluders/redrawGround) — else the fade shows a dark
    slab popping to the real mixed-tile roof. `__ml.debrisAt(c,r)` lists a
    cell's pieces (lvl, key); the gate holds a lap cell to ONE piece per
    level with the wall's own top (tone-independent — a pixel bar can't see
    this).
  - **TWO SPEEDS: debris at 3×, light grade at 1.5×** (`INDOOR_DEBRIS_RATE`
    / `INDOOR_GRADE_RATE`, both maintainer-tuned separately — running
    everything at 3× was sent back). `debrisAlpha()` keeps its 3× curves
    (entry done by mix ⅓; exit by ⅔); `indoorGrade()` — the eased mix at
    1.5×, clamped — is what every LIGHT half rides (`night.indoorMix`, every
    CPU light gain: fireRoomK, torch enable, outside fade, sealed fires,
    ambEff/sunIn/fogScale). The raw `indoorMix` stays the 0.35s easing
    substrate (what `indoor().mix` reports and the pin targets); consumers
    take the grade or the alpha, never the raw mix.
  - **The exit swap lands WITH the light grade (mix ⅓), not at mix 0**: the
    debris is built once at the flip and view-culled to THAT camera; the old
    mix-0 landing sat ~1.9s later and a walking player dragged the camera
    past the build-time cull box, exposing cut-state cells that popped. The
    grade lands ~0.39s in (≤~60px drift vs OCC_CULL_PAD ~360). The swap
    frame is pixel-identical under a locked camera — LOCK THE CAMERA before
    trusting any screenshot diff (an unlocked run's "differences" were
    camera glide).
  - **The exit unclamps the RESOLVE at the flip, not at the end**
    (`night.indoor = indoorInside && mask`): with the resolve still clamped,
    the returning roof debris was LIT as the shadowed interior and the mix-0
    repaint traded a dark slab for a sunlit one. The whole exit fade is lit
    as the outdoor world; the accepted cost is the mirror image (the
    still-visible interior briefly tinted as the surfaces above it, under
    debris already covering it). Entry keeps the clamp from its own flip.
  - `__ml.indoorMixPin(v?)` parks the blend anywhere in (0,1) — how the
    starved harness photographs the crossfade deterministically (pin BEFORE
    the teleport). An exit pin ≤ ⅓ IS the landed grade — the swap fires
    under it; pin above ⅓ to hold the pre-swap frame.
  - Gate: verify-indoorscope sections 4-5 (pinned mid frame distinct from
    both endpoints >8 luma; debris gone at settle; the TWO SPEEDS are real;
    the late-exit frame matches the settled outdoor roof within a tight
    drift bar — the colour-snap regression).
- **The dial is a MINIMUM — walls rise per cell until they'd cover a floor**
  (maintainer: "as tall as they can be before they intersect with another
  floor"). `computeIndoorCuts` gives each cell of MY building its own cut
  (`indoorCut`: cell → drawn level): from min(realHeight, ceiling), walk the
  cell's up-screen cone and cap at `floor(0.9375·k + floorLevel − 1)` per
  protected floor k steps up (odd k overlaps u±1, even k the same iso
  column; 0.9375 = dy/lh, the burial slope; the −1 margin covers ZERO pixels
  of the floor diamond). Protected floors = roof + entrance cells of MY
  space (built in buildCaveDepth's space pass; a bridge protects nothing).
  What falls out free: a NEAR wall has its own room's floor 1-2 steps
  up-screen, capping it below the dial, so `cut = max(dial, cap)` keeps near
  walls at the dial with NO side classification (the culling lesson: nothing
  to classify, nothing to hole). Far/side walls rise to the ceiling;
  partitions with the next floor behind stay at the dial.
  - ALL consumers go per-cell: redrawGround + rebuildOccluders (the exposed-
    face start uses the front neighbours' DRAWN heights at the call site —
    else an occluder hole at every far-run/near-run corner), rebuildProps,
    pickGround (a raised wall drawn whole is a tappable sill; scan from the
    ceiling), aboveCut (extra fx/fy args — a body on that sill stands on
    painted ground), and the shader (per-cell cut in the room mask's R as
    128+cut; roomAt STEP-tests the top half; heightAt clamps each column).
    The cut could NOT ride the A channel: canvas uploads are premultiplied —
    A < 255 scales RGB (the pinned-alpha note in setRoom). setRoom's `cuts`
    param has its own change test (the dial moves every cut while the cell
    set is identical — set comparison alone would skip).
  - QA: `__ml.indoorRaise(on?)`, roomTex().raisedCells/maxCut; verify-indoor
    2a/2b/2c pin the FLAT frame, 2c' pins the raise, section 7's
    overhead-monster rule is per-cell.
- **DO NOT GO BACK TO CULLING.** The first cut drew no roof/near walls + a
  32px far-wall skirt and shipped HOLES — floating wall slabs, black wedges
  (maintainer: "rendering bugs I have never seen before"). Structural, not
  tuning: culling asks "whose inward face does the camera see", and a room's
  own CORNER has no inward face — no wall set can hold it; same at every
  T-junction. Truncation has nothing to classify.
- **The outside is DRAWN AT ZERO AMBIENT — never skipped** (the maintainer's
  original idea: the torch reveals the outdoors through the doorway before
  you step out; point lights from outside are off). Skipping cost three bugs
  at once (grass popping in at the door, a torch lighting nothing, missing-
  neighbour tile sides). The renderer draws every cell; the SHADER kills the
  light: a per-cell mask texture `uRoom` (`world-room-mask`, one texel per
  cell, NEAREST, unit 4, published by `setRoom()` on doorway crossings/dial
  turns — never per frame); `roomAt()` gates AMBIENT, aurora and the
  emission floor and NOTHING ELSE. Point lights stay additive — the torch
  spills through the doorway with the opening's own shadow (measured 5.2×
  brighter down the doorway than at the flanks).
  - **The cut applies to EVERY column in the world**, not just the building:
    painter order draws down-screen columns over the room (a column buries
    an interior cell once ~0.94·k levels taller at k steps). Around the
    house that never fires; in the caves the surrounding rock hid 417 of 417
    interior cells. One rule for every column; the shader's global heightAt
    clamp already assumes it. Gate: verify-indoor section 7.
  - `roomAt()` FAILS LIT (`uRoomOn`, same guard as uGlowOn): an unbound
    sampler2D reads unit 0 — the heightmap — so the failure mode is a BLACK
    ROOM on a real phone while headless SwiftShader looks fine.
  - **Nothing stands on ground the cut removed** (`aboveCut`): above the cut
    nothing is painted, so monsters/NPCs/remote players/drops whose surface
    level exceeds `indoorTop` are hidden. The threshold is the CUT, not the
    ceiling; the test is HEIGHT, not room membership (the mountain around a
    cave is outside the room AND above the cut → hidden; grass outside the
    door is outside the room at my level → drawn, torch-lightable). Gate:
    section 7 (cave only — needs a populated mountain overhead; turns
    "disable aggro" ON, else the gate gets killed mid-measurement).
  - **Anything drawn ABOVE the darkness overlay must gate itself** — zero
    ambient can't touch depth 900_001+. `indoorOutside(fx,fy,z)` is the
    predicate (NOT a visibility test; bodies are always drawn): name labels
    + chat bubbles (900_100), monster hp/Lv bars (900_001.5-1.7), the red
    ring (.45), the white outline (.43), the bonfire's blooms + full-bright
    lit copy (fireRoomK). A pitch-black villager with a crisp name tag is
    the tell.
  - **NPCs get a lit copy like every body** — without one their light came
    from the multiply overlay, which lights each pixel by the terrain cell
    resolved BEHIND it (a villager one step outside the door had black legs
    and a lit head).
  - The eased half is `uIndoorMix` (the outside FADES to black); geometry
    (`uIndoor`, `uIndoorTop`, the truncation) snaps. The CPU twin mirrors.
  - **Two ambient grades, one crossing** (`uAmbient`/`uAmbientOut`): a cell
    in my room blends outdoor→interior dial; a cell outside blends
    black→outdoor and never touches the interior grade. One shared ambient
    OVERSHOT on exit at night (interior 40% = 3.9× night's luma; the outside
    took it and eased back DOWN). Measured after: monotone rise, zero
    non-increasing steps.
  - **The light mask outlives the verdict by one roll** (`roomMask`, dropped
    in easeIndoorMix; `roomAt`/CPU twin gate on `uIndoorMix`, not
    `uIndoor`): geometry snaps back the frame you step out, the light is
    still rolling — a room that stopped existing mid-roll handed the WHOLE
    world the interior grade for a quarter second. Everything asking "is
    this outside MY room?" reads `roomMask`, never `indoorMask`.
  - The ambient agent's outdoor layer fades with it:
    `ambient/runtime/outdoor.ts` `OUTDOOR_FADE_MS` = **1050** = 3 ·
    INDOOR_TAU · 1000 (its roll is `k = 1 − exp(−(dt/fadeMs)·3)`, making it
    frame-identical to the game's). Its test asserts the relationship, so
    moving INDOOR_TAU without it fails in `npm test`.
- `shared/src/indoor.ts` publishes **`shell`** — the building, 8-connected,
  openings excluded; the ONLY set the renderer reads (`wallLeft`/`wallRight`
  survive as detector output). Fill and fringe stay 4-connected (a diagonal
  is not a step); `shell` is 8-connected because a point-touch is a visible
  seam.
- **The SURFACE resolve is clamped to the cut; the OCCLUSION march is not**
  (`uIndoorTop`): what the camera sees is truncated; what light travels
  through is not — the building stays solid to the sun (else the missing
  roof daylights the room), and skipping the surface clamp recreates the
  roof-in-the-heightmap bug one level up (a floor behind a level-3-drawn
  wall resolving at 6, torches attenuated across 48px of phantom gap).
- **A tap resolves against what is DRAWN, and only the floor is a target**:
  indoors `pickGround` starts its top-down scan at `indoorTop`, skips decks
  (the roof slab matched every indoor tap at level 6 — 6.40 cells
  down-screen of the finger), and skips building cells taller than the cut
  (a parapet's drawn top is not standable; the tap means the floor beyond —
  2.13 cells off). A wall SHORTER than the cut is untruncated and stays
  tappable — a real sill. Gate: the tap round-trip in verify-indoor.
- **THE WHITE OCCLUSION OUTLINE** (`syncCoverOutline`) — not indoor-only:
  any body a parapet/cliff/tower covers gets a white silhouette ring
  (HIDDEN_RING_COLOR) over the hidden part at 900_001.43, the exact
  COMPLEMENT of the lit copy (`syncLitCopy` crops [0, coverY); this draws
  [coverY, bottom)) — the two tile the figure seamlessly. The gate asserts
  the monotone CHAIN (5-level wall hides 61%, 3 levels 41%, 1 level 4%,
  open ground none) — something a stuck outline cannot fake.
  - **Coverage is RASTERISED, not modelled** (maintainer: "pixel perfect …
    now the effect is just a line"). `coverY` is ONE scalar (top of the
    highest covering column's 64px image box) — but an iso wall top is a
    diagonal, an arch is a hole, a prop billboard is arbitrary alpha.
    Measured: 79.8-93.7% of outlined pixels sat over ground nothing covered
    (a complete 268-texel outline around a 0%-covered body at a tree); tile
    art starts ≥6px below its box top, so `min(o.y0)` over-claims by
    construction (missed 0.0% everywhere — one-sided error). **No analytic
    field can fix this** (billboards). The covering images RASTERISE it per
    body into three DynamicTextures in a shared atlas: E (body minus
    occluders in front), C (body minus E), O (dilate(C) minus body = the
    ring). "Covered" is Phaser's own painter rule (`depth > sprite.depth`),
    executed by the renderer. Verified GPU-vs-CPU: 0 differing texels;
    E∪C == silhouette, E∩C == 0. Gated on WEBGL; the flat-crop path stays
    verbatim as fallback (`coverExact`). THREE TRAPS paid for:
    * The atlas must RECYCLE: holding slots until body-destroy froze
      allocation at 13-25 slots and every covered body after reverted to the
      flat line mid-session. Any big-enough free slot serves (smallest
      first); a body uncovered for COVER_SLOT_GRACE ticks hands its back.
    * Ask about the ART BOX, not the frame box (mirrored when `flipX`):
      a 112×112 frame around a 29×86 figure admitted ~80 occluder candidates
      vs a median ~6. Safe: C ⊆ silhouette ⊆ artBounds.
    * The flat line may not VETO the exact path: `coverY` below the art does
      NOT mean nothing is covered (a low occluder at the feet — 95 covered
      texels with no outline because the early-out fired before the slot was
      consulted). With a slot, O answers for itself.
  - **Swimming: wear the body's OWN mask** — the same GeometryMask object
    `updateWaterClip` puts on the sprite (never a second copy of BOW_FRAC,
    never `swimming`/`swimT`): structurally unable to disagree with the
    body's cut/bow/bob/exit-jump and all three bail-outs. Measured fully
    submerged: 712 ring pixels above the crest, 0 below.
- **INDOOR MODE → `scripts/verify-indoor.mjs`** (dev stack, ~3 min): frames
  the_island2's house with ONE pinned camera outside and inside, compares
  REAL pixels at points derived from maps2's world.json (a re-authored house
  moves the samples). Shot with the TORCH OFF (a lit torch legitimately
  lifts outside ground). What it pins: the mask is exactly floor + building
  (footprint derived from world.json itself); the building is SOLID at its
  cut top — sampled in the FACE tile's 16px SKIRT BAND (+39/+46 of the cap
  tile's box), never the diamond centre (transparent for a truncated column;
  it once passed only because the ground RT filled NAVY — the fill is black
  now); the dial IS the wall height (sweep 1..4, top rises exactly one level
  per step, inside changes strictly more each step, outside not at all — it
  used to hunt a "wall crown", unsound once every column draws: the topmost
  lit pixel belongs to whichever neighbour's art box overlaps). Then the
  OUTLINE as a monotone response; then the LIGHT — the gate pins the
  DERIVATION, not the maintainer's 40% (taste): at the dial's original 0.104
  the grade must land on night's own luma; the default must stay brighter
  than the tuned-dark end, well under daylight, still cool (B/R 1.21 vs
  night's 1.87); the torch lit with the day fade at 0. The indoor ambient is
  read at the ROOM CENTRE (the far outdoor cell is identically ZERO from
  indoors — 2b asserts exactly that). Sections that turn on the zero-ambient
  design: 2b; 2g the DOORWAY BEAM (torch reaches beyond the opening at 5.2×
  the flanks — a ratio, never "the flank is black" (the 0.22 bounce floor
  guarantees it isn't), then a probe light parked on those cells must turn
  them from black to real — at zero ambient a drawn and a missing tile
  composite identically and a light is the only instrument; hence probeLight
  is exempt from the room filter); 7 the CAVE (the only shipped geometry
  where "is the cut world-wide?" is answerable). Finally the outdoor
  controls: standing ON the roof (walked off a wall top — teleport lands on
  the base surface) and swimming under a bridge read outdoors, nothing
  blacked. `SHOT_DIR=<dir>` keeps every judged frame. Tolerated by design:
  the ambient agent's fireflies/birds/bats and footstep marks + grave
  crosses painting over the void — every "is it black?" test is a MEDIAN
  over a wide patch; and the avatar is never hidden indoors — sample points
  in its art box are dropped via `myScreen()`.

## Landscape, handedness, rotation (in-game only)

- **The WORLD plays landscape; title/select/loading stay portrait-only.**
  In-game, on TOUCH, a landscape viewport turns the golden split on its
  side: the game view keeps 61.8% of the long axis at FULL height; the menu
  becomes a 38.2vw side column with a VERTICAL tab strip hugging the
  game-view edge. Which side is HANDEDNESS (`client/src/controls.ts`,
  localStorage `ml-hand`, DEFAULT RIGHT, Settings "controls", event
  "ml-hand", probe `__ml.hand(h?)`): the promise is the STICK's side —
  right-handed keeps the stick right in every orientation (the approved
  portrait layout is right-handed), so the landscape menu goes LEFT;
  left-handed mirrors. Mechanism: `hud.ts applyLayout()` classes the root
  (`ml-ingame`/`ml-land`/`ml-lh`) and publishes px vars — `--menu-w`,
  `--hud-h` (0 in landscape), `--gv-left`/`--gv-right`. #game, the chips,
  the chat overlay and the pill anchor off the gv vars and TRANSITION their
  anchor property (handedness swaps glide; display swaps snap).
- ONE exception to "corners stay corners": in RIGHT-handed landscape the
  clock pill leaves the bottom-right corner (the thumb stick's) and parks
  under the XP chip, right edges aligned, 10px below — reading
  `--bars-r-h`, the chip's MEASURED height (bars.ts publishes it from a
  ResizeObserver). Left-handed keeps the corner.
- ICONS ARE NOT ROTATED (the "icons rotate 90°" ask described the
  locked-page mental model; a sideways backpack is not a backpack) — the
  gate pins transform:none.
- GAMEPAD: in landscape the stick is REPARENTED TO `<body>` — usable on
  EVERY tab (a HUD rebuild clears strays) — floating in the game view's
  bottom corner on the thumb's side (gamepad.ts LAND_INSET 38px, the centre
  the maintainer marked on two device screenshots). **MEASURE A DEVICE
  SCREENSHOT'S SCALE, never assume the portrait DPR**: his phone is 393 css
  px portrait (dpr 2.75) but its LANDSCAPE viewport is ~988 css px = 2.28
  device px per css px — reading marks at 2.75 said "move 10px" when the
  answer was 28; fitting a circle to the stick's own 148px blur disc settled
  it. Anchor measurements to something whose CSS size you KNOW.
- THE GHOST IS TWO PAINTED PARTS, EACH WITH ITS OWN ALPHA: `.ml-pad-well`
  (basin) + `.ml-pad-top` (cap) inside a paint-nothing `.ml-pad-stick` — it
  HAS to be built that way: the cap must read STRONGER than the well, and a
  parent's group opacity can only make a child fainter. Rest alphas: LIGHT
  well .15 / cap .25; DARK well .4 / cap .5 (a faint grey ghost vanishes on
  dark terrain). Dark is the explicit data-theme AND the OS default, so
  every dark rule needs its prefers-color-scheme twin. WHILE HELD both go
  to 1 — the rule is written `:root.ml-land .ml-pad-stick.held …` ON
  PURPOSE (the dark rest rules carry an attribute selector; the shorter
  form lost the specificity race and the ghost stayed faint in dark).
  Backed by a blur disc as its OWN full-opacity element (`.ml-pad-blur`,
  z 3) pinned to the stick's rect — backdrop-filter ON the stick cannot
  work (its opaque background paints over its own blurred backdrop, and the
  ghost opacity dilutes the rest). Portrait hides the disc. PICK UP stacks
  above JUMP on the column's centre line; the vertical tab strip is
  centred.
- **Anything positioning against ml-land / the gv vars listens to
  "ml-layout", NEVER the raw resize**: applyLayout fires it last;
  gamepad.ts's own resize listener registers BEFORE hud's, so on rotation
  it read the PREVIOUS ml-land and left the floating stick parented to a
  display:none page at 0×0 — invisible, untappable, unhealed (a hidden page
  never resizes, so its ResizeObserver can't fire). Gate 4d rotates with
  the BACKPACK tab open, each hand, and asserts the stick is
  body-parented, hit-tested, and steers. Page-RELATIVE writes in layout()
  are skipped while the page is display:none (width reads 0 — buttons park
  at garbage and visibly correct on tab entry).
- The position glide is `.anim`-GATED and fires ONLY on a handedness change
  while the page is visible (a glide during rotation fights the canvas
  resize and the OS's own rotation animation).
- **ROTATION SNAPS UNDER A VEIL** (FIVE rounds — keep the arc):
  anchor-transition glides, an outright snap, and a flip pin-then-glide were
  ALL rejected; the closing insight: Chrome/the OS already animate the
  rotation, so ANY chrome animation on top reads as a broken double
  animation. On an orientation flip every anchor jumps straight to final
  (`:root.ml-noanim` pins transitions off); only the handedness glide
  remains. What `hud.ts beginFlip` owns is the HEAVY part: a real rotation
  restages the viewport several times, and a full scale.resize per stage
  (framebuffer realloc + whole-world redraw, traced ~2s PER resize) stalls
  the thread into stale letterboxed frames. main.ts fitCanvas holds fire
  while `:root.ml-flip` is up — AND whenever in-game + touch + viewport
  aspect disagrees with ml-land (the #game ResizeObserver delivers BEFORE
  the resize event that starts the flip, traced 3ms). A THEME-SURFACE VEIL
  (`.ml-flip-veil`, z 3 — over the canvas, under stick/HUD/chat/chips)
  hides the stale world; at quiet (~300ms without a resize) ONE
  "ml-flip-flush" re-fits the canvas in a single resize under the veil;
  after two calm frames (cap 2.5s) the veil fades. The in-game html/body
  wear the THEME background (index.html ships #000 for pre-game screens) so
  a mid-rotation flash reads as surface. Gate sections 4b + 4c
  (verify-landscape) watch a clean and a STAGED rotation frame-by-frame:
  zero transforms/glides on chrome, veil up during and gone after, ZERO
  canvas resizes before the flush, one re-fit after, pill on its true
  anchor. settle() treats a live veil as "not settled".
- **A tap must land where you tapped after a rotation**: Phaser's
  `displayScale` derives from `canvasBounds`, filled during ITS resize
  pass; fitCanvas sets the canvas CSS size AFTER that, so the cached bounds
  kept the pre-rotation size (measured: real canvas 526×393 vs bounds
  393×526 → every tap ~98wu off in landscape, ~134wu after rotating back;
  0.0 in all three states now). fitCanvas calls `updateBounds()` and
  recomputes displayScale with Phaser's own formula (ScaleManager
  `baseSize / canvasBounds`). **Do NOT "fix" with `scale.refresh()`**: in
  RESIZE mode it re-derives gameSize/baseSize/canvas.width from the PARENT,
  discarding the deliberate resolution scaling (a 393×526 box backed by
  786×1052). fitCanvas also runs on `ml-hand` — handedness MOVES the view
  without resizing it, so only the bounds POSITION goes stale. Gate: 4e
  (tap your own feet through portrait → landscape → portrait).
- Landscape column sizing: tabs keep 56px (the global ≤640px-HEIGHT shrink
  rule was written for short PORTRAIT phones and silently shrank every
  landscape strip; a ≤388px-height media keeps 48px for tiny screens);
  strip 84px wide; the backpack grid turns 3 wide × 5 tall
  (`:root.ml-land .ml-slots`, capped 320px; width cap HEIGHT-derived —
  `calc((100dvh − 72px)*0.6 + 20px)` — so all five rows fit without the
  1px scroll); the MAP sizes to the SHORT viewport side (same size portrait
  gives it), `.ml-map` overflow:hidden clips evenly so the you-are-here
  dot's percent offsets stay true; the keyboard-floated Chat input takes
  the gv insets (floats inside the game view). A ONE-TIME help chip on the
  gamepad page points at Settings → controls (× dismisses forever,
  `ml-hand-help`); absolute overlay, its BODY pointer-events:none (on a
  short viewport it can lie over the stick — caught by verify-gamepad).
  Desktop (no touch — `touchDevice()`, shared with the keyboard lift) keeps
  the portrait split at ANY aspect — which keeps every 480×320 e2e gate on
  the portrait coordinate model. Gate: `scripts/verify-landscape.mjs` (both
  hands, portrait return, floating-stick input, help persistence, desktop
  immunity; settle-polled — the starved compositor reports mid-flight
  values long after wall-clock).
- **Portrait-only OUTSIDE the world**: `#ml-rotate` (index.html media query
  — coarse pointer + landscape + max-height 520px) covers
  title/select/loading; `html.ml-ingame` (set by mountPageFrame) suppresses
  it in-world. The manifest is `orientation: any`; the REAL gate is
  main.ts's boot-time `screen.orientation.lock("portrait")` (covers the
  installed app's pre-game screens), RE-LOCKED to "any" by mountPageFrame
  when the world mounts (the boot lock silently kept the phone portrait
  in-game whatever the manifest said). Logout reloads, so the portrait lock
  returns. In a browser tab both lock() calls reject harmlessly. An
  installed WebAPK may need a reinstall to shed an OLD manifest's lock;
  Android auto-rotate must be on.
- **Dead-connection recovery**: backgrounding freezes JS; the server drops
  the client and the room turns ZOMBIE (no patches/acks — prediction
  replays an ever-growing unacked history; the old "teleport when jumping
  uphill after tabbing back"). `room.onLeave` (ignoring real unloads —
  pagehide fires first) triggers an IN-PLACE rejoin (`handleDrop`):
  "Reconnecting…" toast, joinWorld again (immediately when visible, else on
  visibilitychange), old avatars + prediction state dropped, `bindRoom`
  rewires — NO page reload (phones background constantly). Input sending is
  frozen while disconnected (flushInput guard). Retries back off; after 6
  failures a reload with `ml-rejoin` set (main.ts then skips the select
  screen via `ml-last-choice`). NOTE: `room.state.players` is undefined
  until the first patch. Probe: `__ml.dropConnection()`; regression:
  `scripts/verify-reconnect.mjs`.

## Conventions

- `npm run dev` runs server + client. `npm test` = headless suite (node +
  Colyseus, no browser). `npm run typecheck` per package. Work from
  `games2/`.
- **PIXEL ART SCALES NEAREST-NEIGHBOUR ONLY — everywhere, always**
  (maintainer, repeatedly): `image-rendering:pixelated` on every art
  img/canvas, Phaser nearest filtering, `imageSmoothingEnabled=false`,
  nearest in QA/preview zoom helpers. Offline pipelines may box-average
  ONLY when BAKING an asset down to its final display resolution; nothing
  upscales with smoothing. When KEYING/extracting art, finish every cut
  edge with SOFT ALPHA — outer silhouette AND interior holes — never a hard
  100%→0% step (the ornate clock hand's ring hole shipped opaque black
  once).
- Keep shared movement/direction math in `shared/` — never duplicate it.
- Server is authoritative; never trust client positions.
- Tests stay headless; browser checks go through `scripts/verify-*.mjs`
  (Playwright).

## The loop (loop/)

`loop/LOOP.md` is the runbook run on a schedule. Each iteration: `git pull`
(latest art) + regenerate the manifest, keep ≥15 open GitHub issues on
`mikael-floden/pixel` (label `game`), implement the best one, keep
`npm test` + typecheck green, commit + push to `main` (rebase on reject).

## Don't

- Don't touch the map/background/environment/tileset/world art (the maps and
  tiles agents' domains). You may improve the tile **renderer** (occlusion,
  collision, input feel — #28) but never redesign or hand-author world art.
- Don't edit anything outside `games2/` except your own
  `coordination/games.json`.
- Don't push red — `npm test` and `npm run typecheck` must pass first.
