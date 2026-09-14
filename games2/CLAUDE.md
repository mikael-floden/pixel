# CLAUDE.md — Nangijala, the game (law + pointers)

This file loads on every games2 turn, so it holds ONLY the rules and where each
subsystem's detail lives. **Measurements, traps and rejected approaches live in
`games2/docs/<topic>.md` — open the one for the subsystem you touch; new detail
goes THERE.** A rule here is one or two lines: the law, the reason in
parentheses, the doc with the story. (300 KB was once paid per message.)

## What this is

The Nangijala client + server: TypeScript npm workspaces `shared/`, `server/`
(Node + Colyseus, authoritative `WorldRoom`, 20 Hz tick, decorator-free
schema, plain `tsx`), `client/` (Phaser 3 + colyseus.js, Vite; prediction and
reconciliation). Art is READ from the sibling domains (`characters2/`,
`tiles/`, `maps2/`, `scenery/`) at `/assets/<domain>/…`, never copied or
edited. ONE world, `the_game` (`maps2/worlds3`), ONE tile system, `tiles/`.
Six agents share `games2/`: this one (gameplay, netcode, world, rendering),
games-ui (`UI_AGENT.md` splits the files), games-audio (`composer/`),
games-ambient (`ambient/`), games-perf (frame time, from the beacon) — each
with an `<agent>-assistant` of the same remit and board. Work from `games2/`
(`npm run dev|test|typecheck`); boards `coordination/<agent>[-assistant].json`.

## The docs

| doc | holds |
|---|---|
| `docs/shipping.md` | publish policy, curated image root, world tree, staging, WebP, `?h=` grant, brotli pin, loading order, deploy |
| `docs/tiles3-rendering.md` | tiles3 resolver and draw ops, plates, transitions, seams, fades, decks, wall feet, render3 parity |
| `docs/scenery.md` | sizing, hitboxes, animation, windows on walls, indoor furniture, flat pieces, fog silhouettes |
| `docs/depth-sort.md` | occluder set, `depthrule.ts`, cover lines, lifts, drops |
| `docs/perf.md` | ground render texture (scroll, slices, repaints, prefetch, compose), pooled occluders, capture pool, art queue, beacon |
| `docs/movement.md` | movement, decks, collision, steer assist, fall damage, tap/hold-to-move, dodge, swimming, gait, camera |
| `docs/monsters-combat.md` | spawn zones, shadows, gait, brain, escape math, loot, backpack, levelling, death, NPCs |
| `docs/lighting.md` | night shader and its CPU twins, light slots, scenery lights and shadows, depth fog, sun, time, weather, indoor ambient |
| `docs/ui.md` | wiki-themed HUD, chess, landscape and handedness, rotation, PWA, reconnect |
| `docs/audio.md` | composer binding |
| `docs/testing.md` | where a test belongs, browser gates, harness traps, device geometry |
| `docs/backend.md`, `spec/ZONES.md` | one world for 10k: interest management, bus, zone rooms, ghosts, hand-off, routing |
| `INDOOR.md` | cut-away — READ IT before touching anything that draws, lights, picks or hides a cell indoors |
| `SURFACES.md`, `spec/*.md`, `deploy/DEPLOY.md`, `loop/LOOP.md` | surfaces runbook, agent contracts, deploy, scheduled loop |

## Laws (every one is paid for; the doc named holds the receipt)

**Repo-wide** (root `CLAUDE.md`, loaded with this one): cache safety, lossless
`exact=True` WebP, no secrets, rebase before every push, no PRs unless asked.

**Scope**
- Never edit the art domains; we may improve the RENDERER, never the art.
  Anti-tiling effects: NONE (rejected twice).
- The ONE games2 file art agents may edit is `shared/src/surfaces.ts`
  (`SURFACES.md`); `check-surfaces.mjs` fails `npm test` on an unclassified
  category.
- Never push red: `npm test` + `npm run typecheck` first. A world-reading test
  skips FIRST when `maps2/worlds3/the_game` is absent and listens inside the
  try (the deploy's sparse checkout has no world tree).

**Content and shipping** (`docs/shipping.md`)
- `config/publish.json` is the only hand-maintained list; everything the image
  ships is DERIVED from it (shipset closure + the tiles3 resolver's exact
  closure). Measure and tune against `the_game`, never a fixture world.
- Every `/assets` URL carries its content hash; the server grants `immutable`
  only after verifying it against the bytes it serves. sw.js caches nothing.
  Brotli quality stays pinned at 4.
- `.dockerignore` decides what reaches the image; an asset that 404s in prod
  but exists on GitHub is that file.

**Rendering a maps3 world** (`docs/tiles3-rendering.md`)
- ALL ART SHIPS PACKED — monster strips (union box), scenery (one box per
  state), NPCs (one box per NPC), each `<domain>/pipeline/pack.py`,
  content-hashed; never point the game at a raw file again. Anchors and boxes
  are MEASURED on the raw canvas and converted into the packed frame, so
  nothing moves (`docs/scenery.md`, `docs/monsters-combat.md`; gates
  `verify-scenery-pack.mjs`, `verify-npc-pack.mjs`).
- Ground DETAILS (his approved tops) fall one in N cells by the dial (1 in
  100, his), never indoors, on a ramp or touching another, and draw as an
  OVERLAY, top face alone (`detail*.test.ts`).
- A base-set member leaves its set on his verdict on THE TILE, never on its
  `#top` detail verdict (`tiles3members.test.ts`).
- The resolver is PER CELL (`Tiles3World`), never the sweep, held deeply equal
  to the sweep and to `maps2/pipeline/render3.py` by the parity fixtures
  (`tiles3-fixture.py`); a resolution rule changes in tiles3.ts AND
  render3.py, then both fixtures regenerate.
- Painter order: a cell draws once and everything it wears draws in its slot;
  boundaries are NOT a second pass; decks draw last.
- SLACK, NOT EXACTNESS: a full plate overlaps 17 rows; a top-face-only plate
  is the only zero-slack seam, so only liquids take it, with `TOP_FACE_MARGIN`
  rows of their own surface.
- A transition covers what the plate it replaces covered; the seam (0.82) is
  ON — it is what makes a transition visible (maintainer verdict). Water lies
  flat: a liquid corner votes only at its own level (`tiles3liquid.test.ts`).
- Every field art goes through `plate()`; a conformed plate fills every
  silhouette texel, holes inside a column included.
- A liquid diamond wears `sheets.libTop`, not a formula.
- A BUILT slab (roof, bridge) wears ONE surface, anchored at the deck's first
  cell; a CAVE LID is ground and picks per cell, matching the terrain beside
  it. Both are drawn (ground pass AND occluder copy); `thickness` is the
  contract (0 = top only); `side` is the body, the doorway crops the cap.
- A wall face wears its region's least-seamed measured set, never one tile
  (`wallregion.ts`; `wallsets.json` regenerates from today's approved walls).
- The fade has three dials and a switch; THE DEFAULTS ARE HIS (reach 4,
  amount 0.46, falloff 4). Cliff-foot and lid transitions are on.
- Regions are 24-cell chunks; a cell edit is bounded by its chunk + 5x5.
- Phaser: `textures.get` returns `__MISSING` for an unknown key (adapter via
  `exists`); terrain has its own `LoaderPlugin`, `crossOrigin` set.
- EVERYTHING STREAMED BEHIND THE LIVE WORLD goes through THE ART QUEUE
  (`artqueue.ts`, `docs/perf.md`): priority order, a BYTE budget per frame, no
  kind's strips before a monster of it exists, its fight art raised when a
  fight starts, scenery animations last. It decodes on a worker and uploads in
  bands (`artworker.ts`): never `texImage2D` an `<img>` for streamed art, never
  measure a streamed image's pixels on the frame thread, never read a banded
  texture back from the GPU inside the frame — each is a decode or a pipeline
  drain per strip on the phone; boxes ride the bands, alpha and pixels come
  from the worker on demand.
- A DynamicTexture BRACKET is the GPU cost (a capture clear + blit): an erase
  is the object's own ERASE blend inside the pass, and the capture binds the
  rows in use (`coverRaster`).

**Depth, occluders, scenery** (`docs/depth-sort.md`, `docs/scenery.md`)
- ONE body pipeline: `resolveDrawDepth` + `placeBodyShadow` + `syncLitCopy`
  for players, monsters, NPCs, scenery AND DROPS. Never hand-roll a second
  depth/shadow/lighting path ("we will end up with the player's renderer").
- `depthrule.ts` is a pure function tested against DUMPED occluder records;
  never reconstruct a fixture's projection. A piece is COVERED by a footprint
  and SORTED against art (`ax0`, the hit/hitArt split), and never lifts past
  its own art (`liftMax`) — a bed keyed on its footprint centre took the
  blanket 35 px and drew over a player standing in front of it; gate
  `verify-scenerysort.mjs`.
- SEE-THROUGH WALLS IS DELETED — never a per-frame occluder alpha sweep.
- The occluder set is POOLED; depth = base + creationIndex × 1e-6 in the base
  band only; tiles3's texture cache stays unbounded.
- Boundary transitions and fades are composed OFF THE FRAME THREAD
  (`composeworker.ts`), ahead of the camera, with the factory's own builders;
  the main thread only uploads. The sync path is the fallback and the tests.
  Gate: `__ml.composeWorker({audit:true}).audit.diff` = 0.
- The occluder set is drawn WHOLE (view cull only). Never submit a subset
  chosen per image: a shown course whose front cap is hidden paints over the
  cap's ground (proximity cull, rejected). The list is insertion-sorted.
- Scenery is sized against the 88-px person (`sceneryDrawnPx`); its bbox doc
  is gated (`check-scenery-bbox.mjs`).
- A hitbox is an ellipse OR a perspective ground rect — port the wiki's
  `rectCorners`, never re-derive; one lookup (`sceneryHitboxRec`), one
  per-facing placement (`hitboxPosFor`). THE BOX IS FIXED and the art moves
  into it (his): a facing draws through the STATE's SOUTH still's canvas
  (`anchorBox`) at the PIECE's base scale.
- Indoor furniture draws while its roof is cut away and crossfades with it; a
  piece ON that roof goes with it, and its FEET are the height EVERY rule reads
  (lid fade, cover, lit copy, light, lit volume, depth `lvl`). Flat
  (`collision:false`) pieces draw under everything, no lit copy; an OUTSIDE
  piece over half the room's floor fades out (`scenerycover.ts`).
- Scenery animates once then sleeps per class; a lit clip moves its light
  (his: foliage 1-8 s, fire 0-1, water 1-4, rigid 10-30; swing 0.12x). A TURNED
  piece plays ITS OWN clip (`animFrames`) — never turn art to animate it. A clip
  plays only on frames ON THE GPU: a banded texture behind a context-restore
  refill is blank (`sceneryClipReady`; `verify-sceneryanim.mjs`).
- `projectCellCorner` is the ONE projection for anything on the ground plane;
  `projectFlat` is where feet are DRAWN (4 px body seat, never "fixed").

**Perf** (`docs/perf.md`)
- The capture pool is ALWAYS ON: no draw bracket may resize Phaser's capture
  target (that re-allocation WAS the new-area lag).
- The ground scrolls, paints in slices, repaints landed cells only,
  prefetches ahead, budgets compositions (`GROUND_COMPOSE_MS` 2, boundaries
  only) — each pixel-identical to a forced full paint (`__ml.groundHash`). A
  tab-in poisons the latch. Keep the drop drain's repaint. `?ground=legacy`
  bisects.
- The beacon's `sections` are window means and its `counts` snapshots — never
  correlate them; its server side is an allowlist (add fields on both sides;
  `verify-beacon.mjs` proves the POST survives it). Its fields are in the doc;
  read one with `perf-read.mjs` (`--diff shaA shaB` for two builds).

**Movement** (`docs/movement.md`)
- Server-authoritative, elevation-governed (`WALK_CLIMB`, `JUMP_CLIMB`); the
  shared math lives in `shared/` once; the client predicts the same grid.
- Never weaken the collision probes to fix a wedge: `unstickFromSolids` is the
  escape, and the rescue never climbs.
- A footprint and a body belong to the FLOOR they stand on (`lvl`); every
  query that knows the surface level passes it.
- The nav avoids fall damage at any cost: ≥6 levels is not an edge; a fall
  bills on IMPACT (`fallPend`), drawn on the client's predicted frame
  (`fallhurt.ts`), and the slow FADES with the number.
- Water is the player's sanctuary (no monster enters or is hit there) and lies
  FLAT: a liquid corner votes only at its own level (`swimlevel.test.ts`).
- The speed dial and the acceleration ramp ride PER INPUT (`InputMessage.sm`,
  `.ac`) and the SERVER clamps them; 1.1x and 0.17 s to full speed ARE HIS
  (`playerspeed.ts`, `accel.ts`, `accelStep`).
- The stick "almost" snaps: `leanHeading` leans between the octants' run
  headings by his dial (0 snap, 1 continuous; 0.85 IS HIS); the grid-axis
  lock locks EXACT diagonals only; the bearing is games-ui's stick's
  (`stickdir.ts`).
- A TERRAIN wall gets the honest walk (`wallcorner.test.ts`): within his
  "Wall assist angle" dial (10°) the run is straightened along it; past it the
  body slides at its screen speed times the WORLD cosine to the wall
  (`slideShare`, 71% for a cardinal key; the thumb's windows only,
  `InputMessage.route`) or stands, auto-jump hops a jumpable one; a door
  SIDEWAYS or ahead within 4 cells is steered to, never behind. The sprite
  faces its walk.
- Scenery, props and open ground walk the heading AS IT IS; the tick's glide
  slides them (a footprint is a PROP whatever the nav layer says); no hold,
  detour or slide rule: the ESCAPE is the nav.
- Never-backwards is a rule, not an absolute: after his "Nav help after"
  dial (0.1 s) without progress AT A RATE, `walkHeading` commits to an escape
  that GETS ON — the goal, or the farthest point along the ask inside the
  corridor (`findPath` progress); one TILE back before it has got on
  (`routeRetreat`), walked first (`routeStallCell`), under its roof for a
  prop's only.
- Walk or run follows the body's SCREEN speed (`gaitSpeed`, `gaitRunning`):
  the run gait from 80% of the run, off below 74% (HIS).
- A tap RUNS; the beacon is the pixel you touched and never moves to meet
  the walk (rejected twice); both readings of an ambiguous pixel route.
- The body dodge is a manoeuvre: engage and hold on different thresholds
  (`MONSTER_DODGE_TIGHTEN` never reaches the hold); a waypoint someone stands
  on counts as arrived.
- The ground under a point is its nearest CORNER's, not its cell's.

**Backend for 10k** (`spec/ZONES.md`, `docs/backend.md`)
- ONE world, never instances (maintainer). Zones are rooms
  (`config/zones.json`; no entry = one room); entities belong to the zone
  containing them; the client sees across a border through GHOSTS, in their
  own maps so no server loop ever steps or fights one; a crossing is a
  hand-off over the bus (hot state under a one-shot key, `zone:go`, a fresh
  join, the old room lets go on `handoff:done`); the sender rewrites that
  state EVERY TICK and the client replays from the seq the new room reports.
- A player's map key is its FIRST session id and never changes across hand-
  offs; the client finds itself by the synced `sid`, never by key.
- ONE room per zone per process (`zoneRooms`, warmed at boot, autoDispose
  off; a duplicate locks and hands its arrivals to the owner). An empty one
  runs its sim at a quarter rate (`IDLE_DIVISOR`).
- `Encoder.BUFFER_SIZE` holds EVERY client's view section of one patch (2 MB;
  an overflow freezes clients silently, never errors). `loadbot.mjs`
  + `/api/stats` are the load instrument.
- Positions are int16 quarter units relative to the room (`px/py`,
  `shared/worldunits.ts`); the server keeps float `x/y` and syncs before
  every patch; the client reads `x/y` through installed getters. A field only
  its owner needs (`seq`, `slow`) carries `OWNER_VIEW_TAG`.
- A client receives only what is within `INTEREST_WU` of itself (a `StateView`
  per client, recomputed every `INTEREST_TICKS`); "unlimited" is a view of
  everything, granted only by a room CREATE option. THE JOIN SNAPSHOT IS A
  WHOLE VIEW (`attachView` runs the pass for the joiner) — a crossing binds on
  it; gate `verify-zonehop.mjs`.
- `view()` is applied as a decorator call after `defineTypes` (the `view:
  true` flag is ignored there); `Encoder.BUFFER_SIZE` is set in the room
  module.
- Rooms talk ONLY over `server/src/bus.ts` (ioredis when `REDIS_URL`, else
  the in-process fake, same asynchronous contract). Writes are the Firestore
  bill: a save on leave, death, level-up and the dirty flush (a player who
  earned nothing is never written).

**Monsters, combat** (`docs/monsters-combat.md`)
- Spawn placement is maps2 data (`spawns.json`); no spawns → no monsters.
- A zone cell is a SURFACE: a stray snaps back on ITS OWN LAYER
  (`nearestZoneCell`), never through the slab it stands on.
- The tuned shadow beats everything art-measured: centre = position, size =
  hit box, one size for all facings, via `monsterRadiusFor`.
- `separationPush` stays squared-distance: broad-phase, never micro-tuning.
- Passive by default; predators aggro; a provoked chase paces its victim, the
  RUN-AWAY LINE is `ESCAPE_RADIUS_WU` 390 past the zone, the give-up IS the
  rejected step.
- Monster stats come from live tuning (a content check, not truthiness);
  nothing may block the revive press, and the ask is retried.
- The backpack's ORDER is server state: a drag sends `invmove` — it MOVES,
  never swaps, and the item id says which entry (a slot index goes stale).

**Lighting** (`docs/lighting.md`)
- Every twinned field (clouds, aurora, mist, sun, light) has an EXACT JS twin;
  change both; hash noise with the integer chain, never `fract(sin(...))`.
- A pass that is "off" leaves the display list AND writes its strength
  uniform unconditionally.
- `uCam` is this frame's rectangle (`renderedWorldView`), never `worldView`.
- The light slot ledger: 12 slots, 8 world, strict reservations, tenure not
  re-ranking; a light is a candidate when its POOL can touch the view
  (`poolReachPx`); remote torches are never lights; a world light is a real
  light at the campfire's peak; a sealed-room fire is indoor-only.
- Scenery lights read the manifest `light` block as given (no radius cap);
  every scenery light casts shadows; scenery occludes like a prop, own cell =
  contact + directional core; the switches are pushed on the shader being
  BUILT.
- The light passes render at half resolution by default (his eye first sees
  25%), the glow field too; an overlay's RT ratio survives update().
- Solid objects are art, not walls (no face band); a cave mouth is not a face.
- The wall wash is per PIXEL (the face gate's lateral is to the pixel, not the
  cell), its wrap is his "Wall light wrap" dial (0.7), and the LOS march never
  blends a wall's own height into its front skirt, nor the skirt the LIGHT
  stands in; a skirt sample counts only beside a HARD hit. Gates:
  `verify-wallwash.mjs`, `verify-wallfoot.mjs`.
- Day is sky + sun; the sun is the hand; DAY == NIGHT in the phase table is
  load-bearing (equal sun and moon speed on the pill).
- Indoor ambient: dark room 40%, lit room 12%; hidden outline 20% — his dials.
- MY ROOM IS A VOLUME: the room test takes a HEIGHT (`indoorCeil`, held while
  the mask is), and over my own roof its lights and halo field are blocked
  outright — on `occ`, all the scenery pipeline reads.

**UI and mobile** (`docs/ui.md`, `UI_AGENT.md`)
- Wiki-themed DOM HUD, golden split, ONE 10 px edge margin; pixel art scales
  nearest-neighbour by a whole DEVICE-pixel factor; rejected: a frame around
  the game view, a bottom-right version chip.
- Dialog stability: a card's controls never move or get replaced; a DOM
  overlay does NOT keep pointers from Phaser (lock with `onUiLock`).
- Rotation snaps under a veil; anything placed against the gv vars listens to
  "ml-layout", never the raw resize.
- The wiki drawer sleeps the game loop; waking is not `TimeStep.resume()`.

**Testing** (`docs/testing.md`)
- Logic belongs in `server/test` (seconds); a browser gate is one session in
  `verify-smoke.mjs`; keep e2e viewports small (starvation fakes bugs).
- A one-pixel bug is reproduced on HIS screen (393x851, dpr 2.75, isMobile),
  judged on the SCREENSHOT, moving as well as at rest.
- Compare colours unlit (`__ml.lightAtCell`); a headless GL run cannot
  reproduce a phone GPU's precision, contents loss or lag.

**Indoor** (`INDOOR.md`): a cut-away, not an x-ray; never go back to culling;
the outside is drawn at zero ambient, never skipped; wall height 1 is his.

**Audio** (`docs/audio.md`): talk to the composer only through `gameAudio`;
emit semantic events with literal names; a sound plays only if the wiki
assigned it.

## Probes, and don't

`window.__ml` is the instrument; each doc names its probes. Counters over
pixels: a gate cannot tell a correct dark frame from a black one.

Don't touch the art domains' files or hand-author world art; don't edit outside
`games2/` except your own board (unless he grants the whole repo); don't grow
this file — a new rule is one line here, its story in the topic doc.
