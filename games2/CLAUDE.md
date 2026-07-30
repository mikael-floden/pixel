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
  real follower off it (fails on the base-only baseline, 4/40 stuck). TODO:
  occlusion-FADE when standing under a deck (see yourself inside the house).
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
  clock advances the phase per TIME_PHASE_SECONDS ([40, 25, 70, 25] —
  NIGHT TICKS 3x AS FAST (maintainer 2026-07-22): a third of the sunlit
  sum in wall time so darkness doesn't dominate play, short dawn/dusk,
  long day; 160s full cycle). Time is CONTINUOUS (maintainer: "the clock arrow
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
  held phaseT (never restarts the phase). The hand reads the half-dial
  as a 12-HOUR face crossed TWICE per game day (maintainer's wedge
  marking): the SUNLIT sweep spans morning+day+evening — phases share
  the -90..+90 arc IN PROPORTION TO THEIR DURATIONS (handAngle), "12"
  straight down at day's middle — and the NIGHT sweep spans the night
  phase ("12" at midnight) over its OWN duration: with night now a third
  of the sunlit sum the night sweep runs the same full half-circle at 3x
  the angular speed. At each hand-off (sunset = evening's
  end; night's end) the hand JUMPS from 100% left back to 100% right
  (setClockAngle snaps backward deltas). THE SUN IS THE HAND
  (maintainer: "directional light always points in the clock arrow
  direction"): sunFromHand derives the grid cast from the hand angle
  by inverting the iso projection (passes exactly through the old
  keyframes: -90 -> (R2,-R2), 0 -> (R2,R2), +90 -> (-R2,R2)), slope
  0.34..0.45 by altitude, strength 0 all night (no sun = no wrong
  direction) with ~6%-of-sweep sunrise/sunset ramps; SUN_PHASES
  remains only as the sunVec(DEFAULT_TIME_IDX) init. The dial
  cross-fade stays the only faded discrete event. CAREFUL: local
  probes pin phaseT via setTimeOfDay's tOverride param — reading
  state.phaseT inside setTimeOfDay once clobbered the probe keyframe
  (only worked because fresh rooms default to 0.5). WorldState.timeSpeed (settings "time speed"
  button, "timespeed" message) scales the clock: the button CYCLES
  shared TIME_SPEEDS x0 (freeze) -> x0.5 -> x1 -> x2 -> x5 -> x10 -> x0
  (an explicit {v} in the message jumps straight to a valid value —
  tests use { v: 1 }); x0 is the frozen default for now, mirrored into
  WorldState.frozen for the pressed-switch look. Speed changes resume
  from the current phaseT (never restart the phase). Manual skips still
  work while frozen; tests must set a speed before expecting
  auto-advance. The settings buttons PRINT THEIR STATE (maintainer):
  "time-of-day: Day", "time speed: x2" / "time speed: frozen",
  "weather: Clear sky" — hud.ts `state` callbacks re-read on
  refreshSettings, which every relevant state listener calls. The [1] key / HUD button send
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
- The CELESTIAL CLOCK (client/src/clock.ts) hangs a per-phase half-moon
  SKY DISC top-centre under the frame's gem (pointer-events none): four
  pre-keyed, pixel-aligned PNGs (ui/clock_<phase>.png, cut from the
  maintainer's sheet-3 mocks by scripts/build-clock.mjs) cross-fade on
  the ambient's 2.5s clock via setClockPhase(). Extraction rules
  (maintainer's red marking): the dial is ONLY the connected half-disc
  below the frame rail — the mock's floating dot arcs / numerals /
  labels are detached and MUST NOT ship with the dials; the mock gem's
  tip is notched out (measured contour) and the frame's real gem covers
  the notch at mount. The DOT ARC ships separately (ui/clock_dots.png,
  cut once from the day quadrant by size+warm-colour filter) as its OWN
  static layer: the dots must NEVER fade with phase cross-fades —
  always the same. Assets bake at EXACTLY the display resolution
  (the sheet-3 mocks are 1:1 game screenshots, so DIV=1 — full mock res,
  ~204px dials; a ÷2 bake shipped once and read half-size (maintainer:
  "the scale is wrong and should be x2"); registered on one shared
  canvas by each disc's own axis + the rail row — quadrant-centre registration drifted ~10px;
  the mocks have NO clean pixel grid — do not grid-guess) and render
  1 asset px = 1 CSS px + pixelated so the browser never resamples
  (resampling = mush; a COARSER chunk grid was tried and rejected — it
  melted the art to mud). Dials get hard pixel-stair alpha; the HAND
  (sheet-3: ornate gold, points RIGHT as authored, sun-face disc = hub,
  kept in its original colours) keeps SOFT averaged alpha — it rotates
  at runtime and a thresholded shaft shreds into a ragged line. The
  hand is its OWN layer above the dials — never fades, only rotates;
  pivot = the semicircle centre (mid top edge, behind the gem). CAREFUL:
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
  1px bottom rule (the page scrolls UNDER it). The whole game view is
  framed by `.ml-edge` — ONE pointer-events-none overlay whose three
  box-shadows (a) matte the sharp screen corners with --bg so the canvas
  can't poke through the 16px rounded corners, (b) paint the 2px rule's
  OUTER px in --bg (so the background reads as wrapping the game) and
  (c) its inner px in --border. z 150: over HUD/bars/chat/badge, under
  the fade (200), loading and the wiki drawer. The version badge sits
  bottom-centre on the select screen and moves to a bordered chip at
  the GAME VIEW's bottom-right (above --hud-h) once in the world. NO
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
- `gameAudio.clock()` / `__ml.audioClock()` publishes the score's live
  beat/bar phase + section intensity — use it to sync visuals to the music.
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
  -reconnect/-animrates/-navigation/-longwalk) remain for deep dives.
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
