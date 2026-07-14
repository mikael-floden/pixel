# CLAUDE.md — Nangijala working notes

## What this is

**Nangijala** is a browser-based **multiplayer** (MMO-style) pixel-art RPG.
Everyone who connects joins the **same shared isometric world**. It lives inside
the **`pixel` monorepo** at `games/nangijala` and renders the art produced by the
sibling agent domains (`characters/`, `tiles/`, `maps/`, `objects/`). **Read-only
toward the art** — never edit those directories (see `coordination/PROTOCOL.md`;
this game owns the `games/` domain + `coordination/games.json`). No submodule.
The game is developed by a self-iterating loop — see `loop/LOOP.md`.

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
  both serve `/assets/<domain>/…` from `characters/ tiles/ maps/ objects/`
  (override the location with `ASSETS_ROOT`, e.g. in Docker).
- `scripts/build-manifest.mjs` scans `characters/skeletons/` →
  `client/public/characters.json` (uid, name, frame size, per-anim/dir counts,
  `/assets/...` urls). Regenerate after graphics change (`npm run manifest`).

## Isometric world

- `shared/parseWorld` reads `maps/world/world.json` — the **bigworld@1** schema
  (512×448; `categories`/`climates` string tables + `terr`/`variant`/`level`/
  `climate` index arrays + named `pois`) and the legacy `rows` schema. Geometry
  unchanged (`x=(col-row)*32`, `y=(col+row)*dy − level*lh`, painter order by
  `(col+row,row)`). World units: **32 per cell** (`CELL_WU`); WORLD_WIDTH/HEIGHT
  are sized to the current grid — update them if the map dimensions change.
- The world is far too large to bake into one texture, so `WorldScene` streams
  it: a world-anchored RenderTexture covering the screen + `GROUND_MARGIN` px is
  redrawn only when the camera nears its edge. `MapPreviewScene` (`/#map`) shows
  the maps agent's pre-rendered `minimap.png` with POI markers. `project()`s each
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
  corner probes apply `makeSideBlocked` (solids only). An elevation wall
  beside the path must never veto a parallel/escaping move — with full-rule
  corner probes, a player who had just descended a cliff was wedged at any
  inside corner (both axes vetoed by the two wall faces). Solid props still
  block from every side. Regression test: "no wedging at an inside cliff
  corner" in server/test/collision.test.ts.
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
  unclassified category and prints a measured, ready-to-paste proposal
  (art-decisive cases are auto-classified; stand-on-it-or-not is a gameplay
  call the tool hedges with name hints). `WorldScene` also warns at boot.
  Expanding the tileset = add art, run tests, paste the proposed line.
- **Tile self-emission** is data-driven from `tiles/emission.json`
  (`tile-emission@2`, owned by the tiles agent; every category has an entry,
  `null` = does not glow). THREE runtime layers per glowing category:
  (1) per-cell self-glow FLOOR (`max(light, color*self*anim)` — daylight
  swallows it, night reveals it; ×1.4 on side faces to cancel the art's
  baked ~0.70 face shading; per-cell hash phase so lava shimmers out of
  sync); (2) clustered SHADOW-FREE glow pools, rendered as big ELLIPTICAL
  STAMPS in the additive glow field (`buildPoolStamps` — NOT shader light
  slots: slots are capped and nearest-wins culling popped pools on/off deep
  inside the viewport while walking; the stamp walk window `EMISSION_PAD`
  exceeds any pool's reach + rebuild drift, so culled light is entirely
  off-screen. Emissive cells with exposed faces add pool samples floating
  IN FRONT of the face at mid-height so glow reaches the base ground +
  neighbouring walls; the 12 shader slots now serve only real lights —
  campfire/torches/probe); (3) per-pixel GLOW HALOS —
  `sources` in the registry (generated by `scripts/analyze-emission.mjs`)
  record each glowing pixel cluster (x/y/r/own colour/strength/dir up|sw|se);
  `buildGlowStamps` stamps a tinted radial halo per visible source into a
  world-anchored RenderTexture the shader ADDS to the light field. Halos are
  localized (a mushroom lights its patch, the forest stays dark), free of
  light-slot limits, and directional (face sources repeat on each exposed
  stacked level, biased outward). Re-run the analyzer after art changes;
  `check-surfaces.mjs` FAILS on missing/malformed entries or sources, and
  the tiles pipeline auto-appends `null` for new categories
  (`tilegen.register_emission`).
- **Emission demo world**: press [0] in game (or `/#emission`) to join the
  REAL game on a generated station world (shared `buildDemoWorld`, served by
  the second Colyseus room `demo`): every variant of every glowing category
  on a numbered station, walkable with your character — movement, z-order,
  lighting and time-of-day are the game's own code, so what you test there
  IS what the game does. [6] douses the spawn bonfire (its firelight drowns
  self-emission QA). `scripts/demo-shots.mjs` batch-captures every station
  headlessly; `__ml.lookStation(n)` jumps the camera.
- Debug: `__ml.nightCal(flip,span,test)` drives the field test patterns
  (gradient/grid/uv/classification/raw field — headless probes only; the
  old [6]-[9] calibration keys are retired);
  `__ml.probeLight(col,row,z,radius)` places a light headlessly;
  `__ml.lookAt(col,row)` detaches the camera to any cell (no args re-follows);
  numeric probes live in `scripts/verify-solidband.mjs` (no phantom bands),
  `verify-penumbra.mjs` (soft wall bases), `verify-wallspread.mjs` (lateral
  falloff parity), `verify-timecycle.mjs` (phase grades), `verify-emission.mjs`
  (glow floors/pools/animation), `verify-lit-order.mjs` (lit-copy draw
  order). Run them against a dev stack before touching the shader.

## Mobile / PWA (client)

- **Tap-to-move**: tap the ground → the player walks there; double-tap → run;
  any movement key cancels. The autopilot (`WorldScene.driveAutopilot`) emits
  the SAME 8-way screen input a keyboard would (best-of-8 by dot product
  against the target direction through the shared `screenToWorldVector`), so
  prediction, server validation and auto-jump behave identically to keys.
  Tap picking (`pickGround`) inverts the iso projection once per candidate
  LEVEL from the top down — the first cell whose level matches is the surface
  the player actually sees (tall tops in front win). Trips end on arrival
  (< ¾ player radius) or a 1.5s no-progress stall (unclimbable wall/prop).
  Double-taps are timed by DOM event time (`pointer.upTime`), NOT the game
  clock (whole steps — throttled tabs would miss them). Probes: `__ml.tapTo`,
  `__ml.target`, `__ml.pickAt`.
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
  when jumping uphill after tabbing back" bug). `room.onLeave` (WorldScene)
  reloads the page when unexpected (visibility-aware; real unloads fire
  pagehide first and are left alone), sets `ml-rejoin`, and main.ts then
  SKIPS the select screen using the `ml-last-choice` saved at commit — the
  token store restores the position. Probe: `__ml.dropConnection()`;
  regression: `scripts/verify-reconnect.mjs`.

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
