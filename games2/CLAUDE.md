# CLAUDE.md — Nangijala, the game (law + pointers)

This file is what every games2 turn loads, so it holds ONLY the rules and where
each subsystem's detail lives. **The measurements, traps and rejected
approaches are in `games2/docs/<topic>.md` — open the one for the subsystem
you touch, and put new detail THERE.** A rule here is one or two lines: the
present-tense law, the reason in parentheses, the doc that holds the story.
(2026-09-09, maintainer: the always-loaded text had grown to 300 KB and every
turn paid for it before reading his message.)

## What this is

The Nangijala client + server: TypeScript npm workspaces `shared/`, `server/`
(Node + Colyseus, authoritative `WorldRoom`, 20 Hz tick, decorator-free
schema, plain `tsx`), `client/` (Phaser 3 + colyseus.js, Vite; prediction and
reconciliation). Art is READ from the sibling domains (`characters2/`,
`tiles/`, `maps2/`, `scenery/`) at `/assets/<domain>/…` — never copied, never
edited. ONE world, `the_game` (`maps2/worlds3`), ONE tile system, `tiles/`
(tiles2 and the world@1/@2 tree are retired, 2026-09-09). Three agents share
`games2/`: this one (gameplay, netcode, world, rendering), games-ui
(`UI_AGENT.md` is the file split) and games-audio (`composer/`, its own
`CLAUDE.md`). Work from `games2/`; `npm run dev`, `npm test`, `npm run
typecheck`. Boards: `coordination/games.json`.

## The docs

| doc | holds |
|---|---|
| `docs/shipping.md` | publish policy, the curated image root, the world tree, staging, WebP, the `?h=` cache grant, brotli pin, loading order, deploy |
| `docs/tiles3-rendering.md` | the tiles3 resolver and draw ops, plates, transitions, seams, fades, decks, wall feet, the render3 parity contract |
| `docs/scenery.md` | sizing, hitboxes, animation, windows on walls, indoor furniture, flat pieces, fog silhouettes |
| `docs/depth-sort.md` | the occluder set, `depthrule.ts`, cover lines, lifts |
| `docs/perf.md` | the ground render texture (scroll, slices, cell repaints, prefetch, compose budget), pooled occluders, the capture pool, the perf beacon |
| `docs/movement.md` | movement, decks, collision, steer assist, fall damage, tap/hold-to-move, the body dodge, swimming, footsteps, gait playback, camera |
| `docs/monsters-combat.md` | spawn zones, shadows, gait, the monster brain, escape math, loot, backpack, levelling, death, NPCs |
| `docs/lighting.md` | the night shader and its CPU twins, light slots, scenery lights and shadows, depth fog, sun, time-of-day, weather, indoor ambient |
| `docs/ui.md` | the wiki-themed HUD, chess, landscape and handedness, rotation, PWA, reconnect |
| `docs/audio.md` | the composer binding |
| `docs/testing.md` | where a test belongs, the browser gates, harness traps, device geometry |
| `docs/backend.md`, `spec/ZONES.md` | one world for 10k players: interest management, the bus, zone rooms, ghosts, hand-off, routing |
| `INDOOR.md` | the cut-away — READ IT before touching anything that draws, lights, picks or hides a cell indoors |
| `SURFACES.md`, `spec/*.md`, `deploy/DEPLOY.md`, `loop/LOOP.md` | the surfaces runbook, contracts with other agents, the deploy, the scheduled loop |

## Laws (every one is paid for; the doc named holds the receipt)

**Repo-wide** (root `CLAUDE.md`): cache safety is absolute — no regenerable
asset under a stable name; lossless `exact=True` WebP for all art; never commit
secrets; push to `main`, rebase on reject, no PRs unless asked; doc law.

**Scope**
- Never edit the art domains; the games agent may improve the RENDERER, never
  the art. Anti-tiling effects: NONE (rejected twice — the fresh ground stands).
- The ONE games2 file art agents may edit is `shared/src/surfaces.ts`
  (`SURFACES.md`). `check-surfaces.mjs` fails `npm test` on an unclassified
  category.
- Never push red: `npm test` + `npm run typecheck` first. A world-reading test
  skips FIRST when `maps2/worlds3/the_game` is absent and listens inside the
  try (`docs/testing.md`; the deploy's sparse checkout has no world tree, so
  the deploy gate runs none of those tests — `docs/shipping.md`).

**Content and shipping** (`docs/shipping.md`)
- `config/publish.json` is the only hand-maintained list; everything the image
  ships is DERIVED from it (shipset closure + the tiles3 resolver's exact
  closure). Measure and tune against `the_game`, never a fixture world.
- Every `/assets` URL carries its content hash; the server grants `immutable`
  only after verifying the hash against the bytes it serves. sw.js caches
  nothing. Brotli quality stays pinned at 4.
- `.dockerignore` decides what reaches the image; an asset that 404s in prod
  but exists on GitHub is that file.

**Rendering a maps3 world** (`docs/tiles3-rendering.md`)
- The resolver is PER CELL (`Tiles3World`), never the sweep, and it is held
  deeply equal to the sweep and to `maps2/pipeline/render3.py` by the parity
  fixtures (`scripts/tiles3-fixture.py`); a resolution rule changes in
  tiles3.ts AND render3.py, then both fixtures regenerate.
- Painter order: a cell draws once and everything it wears draws in its slot;
  boundaries are NOT a second pass; decks draw last.
- SLACK, NOT EXACTNESS: a full plate overlaps 17 rows; a top-face-only plate
  is the only zero-slack seam, so only liquids take it, with `TOP_FACE_MARGIN`
  rows of their own surface. A fix that makes the geometry more exact leaves
  the seam class alive.
- A transition covers what the plate it replaces covered; the seam (0.82) is
  ON — it is what makes a transition visible (maintainer verdict).
- Every field art goes through `plate()`; a conformed plate fills every
  silhouette texel including holes inside a column.
- A liquid diamond wears `sheets.libTop`, never a formula.
- A BUILT slab (roof, bridge) wears ONE surface, anchored at the deck's first
  cell; a CAVE LID is ground and picks per cell, so it matches the terrain
  beside it. Both are drawn (ground pass AND occluder copy); `thickness` is
  the contract (0 = top only); `side` is the body, the doorway crops the cap.
- The fade has three dials and a switch; THE DEFAULTS ARE HIS (reach 4,
  amount 0.46, falloff 4). Cliff-foot and lid transitions are on by default.
- Regions are 24-cell chunks; a cell edit is bounded by its chunk plus a 5x5.
- Phaser: `textures.get` returns `__MISSING` for an unknown key (adapter via
  `exists`); terrain has its own `LoaderPlugin` with `crossOrigin` set.

**Depth, occluders, scenery** (`docs/depth-sort.md`, `docs/scenery.md`)
- ONE body pipeline: `resolveDrawDepth` + `placeBodyShadow` + `syncLitCopy`
  for players, monsters, NPCs and scenery. Never hand-roll a second
  depth/shadow/lighting path ("we will end up with the player's renderer").
- `depthrule.ts` is a pure function tested against DUMPED occluder records;
  never reconstruct a fixture's projection.
- SEE-THROUGH WALLS IS DELETED — never a per-frame occluder alpha sweep.
- The occluder set is POOLED; depth = base + creationIndex × 1e-6 in the base
  band only; tiles3's texture cache stays unbounded.
- Scenery is sized against the 88-px person this game draws
  (`sceneryDrawnPx`); the bbox doc is gated by `check-scenery-bbox.mjs`.
- A hitbox is an ellipse OR a ground rect drawn in perspective — port the
  wiki's `rectCorners`, never re-derive; ONE lookup, `sceneryHitboxRec`.
- Indoor furniture is drawn while its roof is cut away and crossfades with it;
  flat (`collision:false`) pieces draw under everything, no lit copy.
- Scenery animates once then sleeps per class; a lit clip moves its light
  (both defaults are his: foliage 1-8 s, fire 0-1, water 1-4, rigid 10-30;
  swing 0.12x).
- `projectCellCorner` is the ONE projection for anything on the ground plane;
  `projectFlat` is where feet are DRAWN (4 px body seat, never "fixed").

**Perf** (`docs/perf.md`)
- The capture pool is ALWAYS ON: no draw bracket may resize Phaser's capture
  target (that re-allocation WAS the running-into-a-new-area lag).
- The ground scrolls, paints in slices, repaints landed cells only, prefetches
  ahead, budgets compositions (`GROUND_COMPOSE_MS` 2, boundaries only) — and
  every one of those is pixel-identical to a forced full paint
  (`__ml.groundHash`). A tab-in poisons the latch. Do not remove the drop
  drain's repaint. `?ground=legacy` is the bisect.
- The beacon's `sections` are window means and its `counts` snapshots — never
  correlate them; its server side is an allowlist (add fields on both sides).

**Movement** (`docs/movement.md`)
- Server-authoritative, elevation-governed (`WALK_CLIMB` 0.5, `JUMP_CLIMB` 1);
  shared math lives in `shared/` once; client predicts the same grid.
- Never weaken the collision probes to fix a wedge — `unstickFromSolids` is
  the escape, and the rescue never climbs.
- A footprint and a body belong to the FLOOR they stand on (`lvl`); every
  query that knows the surface level passes it.
- The nav system avoids fall damage at any cost: ≥6 levels is not an edge; a
  fall bills on IMPACT (`fallPend`, `fallDurationS`), never at the edge, and
  its flinch starts early so the got-hit frame lands with the feet
  (`fallhurt.ts`).
- Water is the player's sanctuary: no monster enters, swims or is hit there.
- A tap RUNS; the beacon is the pixel you touched and never moves to meet the
  walk (rejected twice); both readings of an ambiguous pixel are routed.
- The body dodge is a manoeuvre: engage and hold on different thresholds,
  `MONSTER_DODGE_TIGHTEN` never reaches the hold; a waypoint someone stands on
  counts as arrived.
- The ground under a point is its nearest CORNER's, not its cell's.

**Backend for 10k** (`spec/ZONES.md`, `docs/backend.md`)
- ONE world, never instances (maintainer). Zones are rooms (`config/zones.json`;
  no entry = one room); entities belong to the zone containing them; the
  client sees across a border through GHOSTS, which live in their own maps
  so no server loop ever steps or fights one; a crossing is a hand-off over
  the bus (hot state under a one-shot key, `zone:go`, a fresh join, the old
  room lets go on `handoff:done`).
- A player's map key is its FIRST session id and never changes across
  hand-offs; the client finds itself by the synced `sid`, never by key.
- ONE room per zone per process (`zoneRooms`, warmed at boot, autoDispose
  off; a duplicate locks and hands its arrivals to the owner). An empty room
  runs its sim at a quarter rate (`IDLE_DIVISOR`).
- `Encoder.BUFFER_SIZE` holds EVERY client's view section of one patch (2 MB;
  an overflow freezes clients silently, never errors). `scripts/loadbot.mjs`
  + `/api/stats` are the load instrument; numbers in `docs/backend.md`.
- Positions are int16 quarter units relative to the room (`px/py`,
  `shared/worldunits.ts`); the server keeps float `x/y` and syncs before
  every patch; the client reads `x/y` through installed getters. A field only
  its owner needs (`seq`, `slow`) carries `OWNER_VIEW_TAG`.
- A client receives only what is within `INTEREST_WU` of itself (a
  `StateView` per client, recomputed every `INTEREST_TICKS`); "unlimited" is a
  view holding everything, and only a room CREATE option grants it.
- `view()` is applied as a decorator call after `defineTypes` (the `view:
  true` flag is ignored there); `Encoder.BUFFER_SIZE` is set in the room
  module, not index.ts.
- Rooms talk ONLY over `server/src/bus.ts` (ioredis when `REDIS_URL`, else the
  in-process fake with the same asynchronous contract). Writes are the
  Firestore bill: a save happens on leave, death, level-up and the dirty
  flush (a player who earned nothing is never written).

**Monsters, combat** (`docs/monsters-combat.md`)
- Spawn placement is maps2 data (`spawns.json`); no spawns → no monsters.
- The tuned shadow overrides everything art-measured: centre = position, size
  = hit box, ONE size for all facings, through the one seam `monsterRadiusFor`.
- `separationPush` stays squared-distance; a broad-phase, never micro-tuning.
- Passive by default; predators aggro; provoked chases pace the victim and the
  RUN-AWAY LINE is `ESCAPE_RADIUS_WU` 390 past the zone; the give-up IS the
  rejected step.
- Monster stats come from live tuning (content check, not truthiness).
- Nothing may block the revive press; the ask is retried.

**Lighting** (`docs/lighting.md`)
- Every twinned field (clouds, aurora, mist, sun, light) has an EXACT JS twin;
  change both; hash noise with the integer chain, never `fract(sin(...))`.
- A pass that is "off" leaves the display list AND writes its strength
  uniform unconditionally.
- `uCam` is this frame's rectangle (`renderedWorldView`), never `worldView`.
- The light slot ledger: 12 slots, 8 world, strict reservations, tenure not
  re-ranking; remote torches are never lights; every world light is a real
  light at the campfire's peak; a sealed-room fire is indoor-only.
- Scenery lights read the manifest `light` block as given (no radius cap);
  every scenery light casts shadows; scenery occludes like a prop, own cell =
  contact + directional core; the switches are pushed on the shader being
  BUILT.
- The light passes render at half resolution by default (his eye first sees
  25%); the glow field is half resolution; an overlay's RT ratio survives
  update().
- Solid objects are art, not walls (no face band); a cave mouth is not a face.
- Day is sky + sun; the sun is the hand; DAY == NIGHT in the phase table is
  load-bearing (equal sun and moon speed on the pill).
- Indoor ambient: dark room 40%, lit room 12%; hidden outline 60% — his dials.

**UI and mobile** (`docs/ui.md`, `UI_AGENT.md`)
- Wiki-themed DOM HUD, golden split, ONE 10 px edge margin; pixel art scales
  nearest-neighbour by a whole DEVICE-pixel factor; rejected: a frame around
  the game view, a bottom-right version chip.
- Dialog stability: a card's controls never move or get replaced; a DOM
  overlay does NOT keep pointers from Phaser (lock via `onUiLock`).
- Rotation snaps under a veil (five rounds — keep the arc); anything placed
  against the gv vars listens to "ml-layout", never the raw resize.
- The wiki drawer sleeps the game loop; waking is not `TimeStep.resume()`.

**Testing** (`docs/testing.md`)
- Logic belongs in `server/test` (seconds); a browser gate is one session in
  `scripts/verify-smoke.mjs`; keep e2e viewports small (starvation fakes
  bugs).
- A one-pixel bug is reproduced on HIS screen — 393x851, dpr 2.75, isMobile —
  and judged on the SCREENSHOT, moving as well as at rest.
- Compare colours unlit (`__ml.lightAtCell`); a headless GL run cannot
  reproduce a phone GPU's precision, contents loss, or lag.

**Indoor** (`INDOOR.md`): a cut-away, not an x-ray; never go back to culling;
the outside is drawn at zero ambient, never skipped; wall height 1 and
brightness 40% are his picks.

**Audio** (`docs/audio.md`): talk to the composer only through `gameAudio`;
emit semantic events with literal names; a sound plays only when the wiki
assigned it.

## Probes

`window.__ml` is the instrument: `tiles3()`, `t3at(col,row)`, `occDump()`,
`groundHash()`, `hitch()`, `lightAt`, `lightSlots()`, `indoor()`,
`sceneryAnims()`, `monsterInfo()`, `teleport(col,row)`, `lookAt(col,row)`,
`nearby()`, `sealedAt(col,row,lvl)` — each doc names the ones for its
subsystem. Counters over pixels:
a gate cannot tell a correct dark frame from a black one.

## Don't

- Don't touch the art domains' files; don't hand-author world art.
- Don't edit anything outside `games2/` except `coordination/games.json`
  (unless the maintainer has granted the whole repo for a run).
- Don't grow this file: a new rule is one line here and its story in the
  topic doc.
