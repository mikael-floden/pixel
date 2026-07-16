# CLAUDE.md — Nangijala working notes

## What this is

**Nangijala** is a browser-based **multiplayer** (MMO-style) pixel-art RPG.
Everyone who connects joins the **same shared isometric world**. It lives inside
the **`pixel` monorepo** at `games2/` and renders the art produced by the
sibling agent domains (`characters2/`, `tiles2/`, `maps2/`, `objects/`).
**Read-only toward the art** — never edit those directories (see
`coordination/PROTOCOL.md`; this game owns `games2/` +
`coordination/games.json`). No submodule. Developed by a self-iterating loop —
see `loop/LOOP.md`. (The first-generation `games/`+`characters/`+`maps/`+
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

## Time-of-day (server-owned world state)

- The phase index lives in WorldState.timeIdx (shared DEFAULT_TIME_IDX /
  TIME_PHASE_COUNT) and the cycle RUNS BY ITSELF (maintainer: the
  day/night cycle is a core rhythm of the game): the server's world
  clock advances the phase per TIME_PHASE_SECONDS (~14 min full day;
  long days, short dawns/dusks). The [1] key / HUD button send
  "timeofday" — a SKIP that also restarts the phase timer (room option
  phaseSeconds overrides durations for tests). Every client's state
  listener applies the change (instant + logless on the initial sync,
  2.5s fade + chat log after).
  Ambient palettes (TIME_PHASES) stay client-side; keep the array length
  == TIME_PHASE_COUNT. `__ml.timeOfDay(which)` remains a LOCAL debug
  probe (verify-timecycle drives grades headlessly without the server).
  Regression: server/test/timeofday.test.ts. TORCH is PLAYER state the
  same way (Player.torch, "torch" message): my own light flips on the
  local mirror instantly, everyone else reads the synced field, and a
  rejoin re-asserts the local value to the fresh player entry
  (server/test/torch.test.ts).
- The CELESTIAL CLOCK (client/src/clock.ts) hangs a per-phase dial
  top-centre under the frame's gem (pointer-events none, kept SUBTLE —
  maintainer sized it down from full-mock): four pre-keyed, pixel-aligned
  PNGs (ui/clock_<phase>.png, cut from the maintainer's mocks by
  scripts/build-clock.mjs — outside-flood key + largest-blob) cross-fade
  on the ambient's 2.5s clock via setClockPhase(). Assets bake at
  EXACTLY the display resolution (box ÷6, ~119px wide; the mocks have NO
  clean pixel grid — do not grid-guess) and render 1 asset px = 1 CSS px
  + pixelated so the browser never resamples (resampling = mush; a
  COARSER chunk grid was tried and rejected — it melted the art to mud).
  Dials get hard pixel-stair alpha + a baked RING=4px near-black border
  (the frame's border weight). The HAND (single img, recoloured deep
  brown so it reads on the gold rims) keeps SOFT averaged alpha — it
  rotates at runtime and a thresholded ~1px shaft shreds into a ragged
  line
  from setTimeOfDay(). The ARROW (ui/clock_hand.png, flipped by the same
  script which prints its hub/tip geometry) is its OWN layer above the
  dials — never fades, only rotates to the phase's quarter-sector
  (chronological left→right; the reading lives in the arrow). CAREFUL:
  CSS rotate() from straight-down sweeps screen-LEFT for positive
  angles — this shipped inverted once; convention is documented in
  clock.ts. The version badge sits top-LEFT (main.ts) so it stays off
  the dial.

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
  1 = "Cloudy at times") cycles via the "weather" message — the Settings
  button sends it, every client's listener applies it (instant on join,
  chat-logged after). Cloud cover EASES over ~4s (clouds roll in). The
  shader's uCloud drives a WORLD-ANCHORED 2-octave value-noise cloud
  field (feature wavelength ~550 world px) drifting on a fixed wind
  (~42/23 px/s via uAnimTime), shading the ambient (depth 0.45×cover,
  muted by the sun's strength — night clouds barely register); while
  cloudy the ambient also greys ~20% toward luminance ("the sky is not
  perfect blue"). cloudFactorAt() is the EXACT JS twin (lit-copy tints —
  characters dim as a cloud passes; change both together). uCloud is
  DECLARED in the uniforms config (see the uSun lesson). Probes:
  `__ml.weatherInfo()`, `__ml.weather(idx, instant)` (LOCAL force for
  headless QA), `__ml.cloudAt(wx,wy)`; regressions:
  scripts/verify-weather.mjs (clear=1 everywhere, patchy not overcast,
  drifts over time, night-muted) + server/test/weather.test.ts.

## Directional sun shadows (day phases)

- The night shader also carries a DIRECTIONAL SUN (uSun = cast-dir grid
  x/y, slope levels-per-cell, strength). DAYLIGHT IS SKY + SUN
  (maintainer): the phase ambient splits into a flat sky term (55%) and
  a directional term (45%) that only reaches surfaces with a clear
  line toward the sun — full authored brightness NEEDS the sun, and
  shadowed ground visibly drops toward the sky level (the first cut
  multiplied a small factor onto an already-full ambient and read as
  nothing). Every fragment marches the LINEAR heightmap toward the
  sun — terrain or solid objects above the ray shade the surface (soft
  penumbra, point-light LOS family), faces away from the sun shade via
  a Lambert gate; point lights still add in shadow. SUN_PHASES
  (WorldScene) drives it: Morning casts long shadows to screen-west,
  Day slightly-west-of-down (a straight-down cast hides under the
  south wall faces), Evening mirrors to screen-east, Night off —
  lerped with the SAME clock as the ambient fade so shadows sweep as a
  phase changes (maintainer: "the sun moves... shadows move
  accordingly"). CPU twin sunFactorAt() shades the lit-copy tints the
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
- **Two geometries, never merge them**: `world-heightmap` (NEAREST) holds
  TERRAIN levels only and drives the resolve + wall-face classification;
  `world-heightmap-linear` (LINEAR) holds terrain + solid objects and drives
  ONLY the LOS march. Solid objects (trees, boulders… `!standable &&
  !swimmable` in SURFACES) are ART, not walls: they block light and cast a
  soft shadow but must NEVER get a wall-face band — modelling them as blocks
  painted knife-edged phantom shadows outside their drawn art (the
  long-standing "shadow sticks out" bug).
- **Contract for new tile categories**: unknown categories default to plain
  walkable ground AND therefore to terrain lighting. Every new solid/decor
  category from the tiles agent must get a SURFACES entry (shared/) or its
  block shadow returns. This is ENFORCED: `npm test` runs
  `scripts/check-surfaces.mjs`, which FAILS when the world uses an
  unclassified category (across ALL maps2 worlds) and prints a name-hinted,
  ready-to-paste proposal — stand-on-it-or-not is a gameplay call.
  `WorldScene` also warns at boot. Expanding the material set = ship the
  world, run tests, paste the proposed line.
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

- **HUD (golden-ratio split)**: the game viewport is the TOP 61.8% of the
  page (index.html `#game` = `--hud-h-inv`); the bottom 38.2% (`--hud-h`)
  is the DOM HUD (`client/src/hud.ts`): a framed TAB ROW (Backpack /
  Equipment / Map / Settings / Logout) over a framed CONTENT PAGE.
  Settings hosts the toggles mobile can't reach by keyboard (the
  time-of-day button keeps the `.ml-hudbtn` hook for the smoke); Logout
  is a two-step (tab → confirm) that clears ml-last-choice/ml-rejoin and
  reloads to the select screen. Pointer events in the HUD never reach
  Phaser — e2e scripts must keep tap/drag coordinates in the top 61.8%
  (canvas centre y = `VH*0.309`). Nothing in the HUD is uiZoom'd (its
  dvh geometry must match the #game split; CSS zoom rescales viewport
  units). A `max-height:560px` media query compacts it for short
  windows.
- **UI tiles**: `client/public/ui/*.png` are cut from the maintainer's
  concept mockups by `scripts/build-ui-tiles.mjs` (sources live outside
  the repo — the tiles are committed). PIXEL-PERFECT JOINTS BY
  CONSTRUCTION: the mock's rails are thin hand-drawn lines that MEANDER
  a few px, so the frame is cut as mock-ABSOLUTE segments between
  junctions (180px corners, stretch-segments between them, fixed gems,
  divider ╠/╣ caps + stretch-segments) — the client stretches only
  segment interiors (`background-size:100% 100%`), so every joint shares
  identical adjacent mock pixels. Side-border segments are flex-
  proportioned by source height so the green gems land at the mock's
  fraction. NOTHING is mirrored; no gem on the outer bottom or divider
  B. Keying: outer pieces flood only from their INNER side (everything
  outside the border stays opaque black — the game view cannot leak past
  the frame); divider pieces flood from all edges; mock button-glow
  bleed is erased from caps/side strips; boundary pixels get soft
  ALPHA. THE ART IS THE MOCK'S ORIGINAL PIXELS, UNTOUCHED (maintainer
  round 11, "take a step back... it looks like shit"): every attempt to
  re-synthesize the art at cell resolution in pursuit of a perfect 1px
  border (grid-snapped blocks, dominant-vote cells, straightened rails,
  mirrored gems — rounds 7-10) made the border cleaner and the frame
  chunkier, until the delicate reference became fat striped tubes. Only
  ONE thing is baked on top of the original pixels: the round-8 border
  ring — on the mock-global 4px grid, blocks that contain (>=1/4
  opaque) or 8-touch art get their EMPTY px painted a flat colour = 85%
  of the block's own transparent-px page navy + 15% black at 90% ALPHA
  (outline(); crop origin passed so blocks align across joints). The
  ring wobbles 1-2 art px where the hand-drawn edge crosses a block —
  ACCEPTED; do not chase it (that is the rabbit hole).
  Tabs are PERFECT SQUARES (`--ml-tab`, capped 150px = the mock plate)
  with the three plate states 9-sliced via `border-image`; icons were
  flood-key-extracted (grey icons survive — their outlines stop the
  fill). Verify joints with the blackout trick: hide the canvas and diff
  junction crops against the mock (see the session's junction-compare
  probes).

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
  over the terrain grid: walk edges, no-corner-cut diagonals, CARDINAL
  1-level jump climbs at ~3× cost, +0.6 for cells hugging solids) so the
  character walks AROUND props and ALONG walls to a head-on jump approach.
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
  elevated). Probes: `__ml.tapTo`, `__ml.target`,
  `__ml.path`, `__ml.navLog`, `__ml.gridAround`, `__ml.pickAt`.

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
  -reconnect/-animrates/-navigation/-longwalk) remain for deep dives.
- **Headless-GL starvation preflight**: verify-smoke measures raw keyboard
  speed first and ABORTS ("HARNESS STARVED") if the harness is too slow —
  software-GL at big viewports throttles the frame loop into slow motion
  that fakes "stuck player" bugs (this once cost an hour of ghost-chasing).
  Keep e2e viewports small (480×320); `scripts/debug-speed.mjs` measures.
- Rule of thumb: if a check doesn't need pixels, pointer events, websockets,
  or Phaser anims, it belongs in `server/test` (3s), not in a browser (min).
- **Deploy** (push to main → live): the workflow runs a `test` job (typecheck
  + full unit/sim suite) IN PARALLEL with the layer-cached image build;
  `deploy` needs both. Dockerfile layers are ordered deps → art (per-domain)
  → game source LAST, and BuildKit's GHA cache means a code-only deploy
  uploads only the small source/build layers. Don't reorder the Dockerfile
  COPYs without thinking about which layer changes per deploy.
- **Loading screen** (`loading.ts`): select.ts shows it on "Enter world",
  WorldScene.preload feeds real asset progress, hidden when the player's own
  avatar joins (or on connection error; 60s failsafe so it can't trap).
- **PWA**: `public/manifest.webmanifest` (display: fullscreen — installed app
  has no address bar; orientation: portrait-primary), `public/sw.js`
  (passthrough only, caches NOTHING — this repo fought stale-deploy bugs; the
  server's Cache-Control is the policy), icons from
  `scripts/build-pwa-icons.py` (committed). main.ts stashes
  `beforeinstallprompt` → select.ts shows "Install as an app" (Android).
  `verify-mobile.mjs` covers all of this headlessly.
- **"Desktop site" toggle is neutralized** — the game must look the same
  regardless. Canvas side: camera zoom is dynamic (`WorldScene.zoomFor`),
  integer, targeting ~520 world-px of visible width (phone→1, desktop→2).
  DOM side: `uiscale.ts` applies a compensating CSS zoom
  (innerWidth/screen.width) to every overlay root (select, loading, chat,
  roster) — overlay CSS must use px/% only, NEVER vw/vh (they double-count
  under zoom). Probe via `__ml.camZoom()`.
- **Portrait-only (for now)**: manifest locks the installed app; in-browser
  landscape on a small touch screen shows the `#ml-rotate` prompt
  (index.html media query — coarse pointer + landscape + max-height 520px).
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
