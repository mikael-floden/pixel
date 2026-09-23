# CLAUDE.md — Nangijala, the game (law + pointers)

This file loads on every games2 turn, so it holds ONLY the rules and where
each subsystem's detail lives. **Measurements, traps and rejected approaches
live in `games2/docs/<topic>.md` — open the one for the subsystem you touch;
new detail goes THERE.**

## What this is

The Nangijala client + server: TypeScript npm workspaces `shared/`, `server/`
(Node + Colyseus, authoritative `WorldRoom`, 20 Hz tick, decorator-free
schema, `tsx`), `client/` (Phaser 3 + colyseus.js, Vite; prediction and
reconciliation). Art is READ from the sibling domains (`characters2/`,
`tiles/`, `maps2/`, `scenery/`) at `/assets/<domain>/…`, never copied. ONE world, `the_game` (`maps2/worlds3`), ONE tile system, `tiles/`.
Agents sharing `games2/`: this one (gameplay, netcode, world, rendering),
games-ui (`UI_AGENT.md` splits the files), games-audio (`composer/`),
games-ambient (`ambient/`), games-perf (frame time, the beacon), each
with an `<agent>-assistant` of the same remit and board. Work from `games2/`
(`npm run dev|test|typecheck`); boards `coordination/<agent>[-assistant].json`.

## The docs

| doc | holds |
|---|---|
| `docs/shipping.md` | publish policy, image root, world tree, staging, WebP, `?h=` grant, brotli, load order |
| `docs/tiles3-rendering.md` | tiles3 resolver, draw ops, plates, transitions, seams, fades, decks, wall feet, parity |
| `docs/scenery.md` | sizing, hitboxes, animation, wall windows, indoor furniture, flat pieces, fog |
| `docs/depth-sort.md` | occluder set, `depthrule.ts`, cover lines, lifts, drops |
| `docs/perf.md` | ground RT (scroll, slices, repaints, prefetch, compose), pooled occluders, capture, art queue, beacon |
| `docs/movement.md` | movement, decks, collision, steer assist, fall damage, tap/hold-to-move, dodge, swimming, gait, camera |
| `docs/monsters-combat.md` | spawn zones, shadows, gait, brain, escape, loot, backpack, levelling, death, NPCs |
| `docs/lighting.md` | night shader + CPU twins, light slots, scenery light and shadow, fog, sun, time, weather, indoor ambient |
| `docs/ui.md` | wiki HUD, chess, landscape, handedness, rotation, PWA, reconnect |
| `docs/audio.md` | composer binding |
| `docs/testing.md` | test homes, browser gates, harness traps, device geometry |
| `docs/backend.md`, `spec/ZONES.md` | one world for 10k: interest, wire positions, bus, zone rooms, ghosts, hand-off, routing |
| `INDOOR.md` | cut-away — READ IT before touching anything drawn, lit, picked or hidden indoors |
| `SURFACES.md`, `spec/*.md`, `deploy/DEPLOY.md`, `loop/LOOP.md` | surfaces runbook, agent contracts, deploy, scheduled loop |

## Laws (every one is paid for; the doc named holds the receipt)

**Repo-wide** (root `CLAUDE.md`, loaded with this one): cache safety, lossless
`exact=True` WebP, no secrets, `.dockerignore` decides what the image ships (an
asset that 404s in prod but is on GitHub IS that file), rebase before every
push, no PRs unless asked.

**Scope**
- Never edit the art domains; we may improve the RENDERER, never the art.
  Anti-tiling effects: NONE (rejected twice).
- The ONE games2 file art agents may edit is `shared/src/surfaces.ts`
  (`SURFACES.md`); `check-surfaces.mjs` fails `npm test` on an unclassified
  category.
- Never push red: `npm test` + `npm run typecheck` first. A world-reading
  test skips FIRST when `maps2/worlds3/the_game` is absent and listens inside
  the try (the deploy's sparse checkout has no world tree).

**Content and shipping** (`docs/shipping.md`)
- `config/publish.json` is the only hand-maintained list; everything the image
  ships is DERIVED from it (shipset closure + the tiles3 resolver's exact
  closure). Measure and tune against `the_game`, never a fixture world.
- Every `/assets` URL carries its content hash; the server grants `immutable`
  only after verifying it against the bytes it serves. sw.js caches nothing.
  Brotli quality stays pinned at 4.

**Rendering a maps3 world** (`docs/tiles3-rendering.md`)
- ALL ART SHIPS PACKED — monster strips (union box), scenery (one box per
  state), NPCs (one box per NPC), each `<domain>/pipeline/pack.py`,
  content-hashed; never point the game at a raw file. Anchors and boxes
  are MEASURED on the raw canvas and converted into the packed frame, so
  nothing moves (gates `verify-{scenery,npc}-pack.mjs`).
- Ground DETAILS (his approved tops) fall one in N cells by the dial (1 in
  100, his), never indoors, on a ramp or touching another; drawn as an
  OVERLAY, top face alone (`detail*.test.ts`).
- A base-set member leaves its set on his verdict on THE TILE, never on its
  `#top` detail verdict (`tiles3members.test.ts`).
- The resolver is PER CELL (`Tiles3World`), never the sweep, held deeply equal
  to the sweep and to `maps2/pipeline/render3.py` by the parity fixtures
  (`tiles3-fixture.py`); a rule changes in BOTH, then both regenerate.
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
- A BUILT slab (roof, bridge) wears ONE set (the deck's first cell's) and a
  member PER CELL; a CAVE LID asks at its own cell, matching the terrain
  beside it. Both are drawn (ground pass AND occluder copy); `thickness` is
  the contract (0 = top only); `side` is the body; the doorway crops the cap.
- A wall face wears its region's least-seamed measured set, never one tile
  (`wallregion.ts`; `wallsets.json` regenerates from today's approved walls).
- The fade has three dials and a switch; THE DEFAULTS ARE HIS (reach 4,
  amount 0.46, falloff 4). Cliff-foot and lid transitions are on.
- Regions are 24-cell chunks; a cell edit is bounded by its chunk + 5x5.
- Phaser: `textures.get` returns `__MISSING` for an unknown key (adapter via
  `exists`); terrain has its own `LoaderPlugin`, `crossOrigin` set.
- EVERYTHING STREAMED BEHIND THE LIVE WORLD goes through THE ART QUEUE
  (`artqueue.ts`): priority order, a BYTE budget per frame, no kind's strips
  before a monster of it exists, its fight art raised when a fight starts,
  scenery animations last. Decoded on a worker, uploaded in bands
  (`artworker.ts`); boxes ride the bands, alpha and pixels come from the
  worker on demand. THREE NEVERS (each a decode or a pipeline drain per strip
  on the phone): `texImage2D` an `<img>` for streamed art, measure a streamed
  image's pixels on the frame thread, read a banded texture back in the frame.
- A DynamicTexture BRACKET is the GPU cost (a capture clear + blit): an
  erase is the object's own ERASE blend inside the pass; the capture binds
  the rows in use (`coverRaster`).

**Depth, occluders, scenery** (`docs/depth-sort.md`, `docs/scenery.md`)
- ONE body pipeline: `resolveDrawDepth` + `placeBodyShadow` + `syncLitCopy`
  for players, monsters, NPCs, scenery AND DROPS. Never hand-roll a second
  depth/shadow/lighting path ("we will end up with the player's renderer").
- `depthrule.ts` is a pure function tested against DUMPED occluder records;
  never reconstruct a fixture's projection. A piece is COVERED by a footprint
  and SORTED against art (`ax0`, the hit/hitArt split), and never lifts past
  its own art (`liftMax`: a blanket 35 px drew a bed over a player in front
  of it); gate `verify-scenerysort.mjs`.
- SEE-THROUGH WALLS IS DELETED — never a per-frame occluder alpha sweep.
- The occluder set is POOLED; depth = base + creationIndex × 1e-6 in the base
  band only; tiles3's texture cache stays unbounded.
- Boundary transitions and fades are composed OFF THE FRAME THREAD
  (`composeworker.ts`), ahead of the camera, with the factory's own builders;
  the main thread only uploads. The sync path is the fallback and the tests;
  gate `__ml.composeWorker({audit:true}).audit.diff` = 0.
- The occluder set is drawn WHOLE (view cull only). Never submit a subset
  chosen per image: a shown course whose front cap is hidden paints over the
  cap's ground (proximity cull, rejected). The list is insertion-sorted.
- Scenery is sized against the 88-px person (`sceneryDrawnPx`); its bbox doc
  is gated (`check-scenery-bbox.mjs`).
- A hitbox is an ellipse OR a perspective ground rect — port the wiki's
  `rectCorners`, never re-derive; one lookup (`sceneryHitboxRec`), one
  per-facing placement (`hitboxPosFor`). THE BOX IS FIXED and the art moves
  into it (his): a facing draws through the STATE's SOUTH still's canvas
  (`anchorBox`) at the PIECE's base scale — ONLY where a footprint is
  stamped. A piece with `z` hangs on a wall, stamps none, and keeps its own
  art's foot: the height HE tuned (`anchorBoxFor`, one rule, one place).
- Indoor furniture draws while its roof is cut away and crossfades with it;
  a piece ON that roof goes with it, and its FEET are the height EVERY rule
  reads (lid fade, cover, lit copy, light, lit volume, depth `lvl`). Flat
  (`collision:false`) pieces draw under everything, no lit copy; an OUTSIDE
  piece over half the room's floor fades out (`scenerycover.ts`).
- Scenery animates once then sleeps per class; a lit clip moves its light
  (his: foliage 1-8 s, fire 0-1, water 1-4, rigid 10-30; swing 0.12x). A
  TURNED piece plays ITS OWN clip (`animFrames`) — never turn art to animate
  it. A clip plays only on frames ON THE GPU: a banded texture behind a
  context-restore refill is blank (`sceneryClipReady`; `verify-sceneryanim.mjs`).
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
  `verify-beacon.mjs` proves the POST survives it). Fields are in the doc;
  read one with `perf-read.mjs` (`--diff shaA shaB` for two builds).

**Movement** (`docs/movement.md`)
- Server-authoritative, elevation-governed (`WALK_CLIMB`, `JUMP_CLIMB`); the
  shared math lives in `shared/` once; the client predicts that grid.
- Never weaken the collision probes to fix a wedge: `unstickFromSolids` is
  the escape, the rescue never climbs, and it keeps `WALL_STANDOFF` (=
  PLAYER_RADIUS) off any face the body cannot jump onto (lateral probes read
  solids only; a refused move wedges; `wallclear.test.ts`).
- A >2-cell position correction re-checks the indoor verdict but NEVER resets
  the doorway crossfade — only a room change does; its SPEED is a dial (1.00x
  is his; slower is the one instrument for a one-frame report).
- A footprint and a body belong to the FLOOR they stand on (`lvl`); every
  query that knows the surface level passes it.
- The nav avoids fall damage at any cost: ≥6 levels is not an edge, and the
  walker never STEERS off a step it cannot undo (a drop of more than a jump
  below the route's next level is not open); a fall bills on IMPACT
  (`fallPend`), drawn on the client's predicted frame (`fallhurt.ts`); the
  slow FADES with the number.
- Water is the player's sanctuary (no monster enters or hits there), as FLAT
  underfoot as in the art (`swimlevel.test.ts`).
- The speed dial and the acceleration ramp ride PER INPUT (`InputMessage.sm`,
  `.ac`) and the SERVER clamps them; 1.1x and 0.21 s to full speed ARE HIS
  (`playerspeed.ts`, `accel.ts`).
- The stick "almost" snaps: `leanHeading` leans between the octants' run
  headings by his dial (0 snap, 1 continuous; 0.85 IS HIS); the grid-axis
  lock locks EXACT diagonals only; the bearing is games-ui's (`stickdir.ts`).
- A TERRAIN wall gets the honest walk (`wallcorner.test.ts`): within his
  "Wall assist angle" dial (10°) the run is straightened along it; past it
  the body slides at screen speed × the WORLD cosine to the wall
  (`slideShare`; thumb windows only) or stands, auto-jump hops; a push within
  his "Nav slide angle" (45° off normal) plans nothing till cornered
  (`navslide.test.ts`); a door sideways or ahead within 4 cells is a route,
  the shorter walk wins; a door sticks; a slide takes a doorway ≤1.5 cells
  behind its lean unless a corner closes the lane (`doorfirst.test.ts`); the
  tap follower holds its heading; the sprite faces its walk.
- Scenery, props and open ground walk the heading AS IT IS; the tick's glide
  slides them (a footprint is a PROP whatever the nav layer says); the
  ESCAPE is the nav.
- Never-backwards is a rule, not an absolute: after his "Nav help after"
  dial (0.1 s) without progress AT A RATE, `walkHeading` commits to an
  escape that GETS ON — the goal, or the farthest point along the ask inside
  the corridor (`findPath` progress); one TILE back before it has got on
  (`routeRetreat`), walked first (`routeStallCell`), under its roof for a
  prop's only.
- Walk or run follows the body's SCREEN speed (`gaitSpeed`): the run gait
  from 80% of the run, off below 74% (HIS).
- A tap RUNS; the beacon is the pixel touched and never moves to meet the
  walk (rejected twice); both readings of an ambiguous pixel route.
- The body dodge is a manoeuvre: engage and hold on different thresholds
  (`MONSTER_DODGE_TIGHTEN` never reaches the hold); a waypoint someone stands
  on counts as arrived.
- The ground under a point is its nearest CORNER's, not its cell's.

**Backend for 10k** (`docs/backend.md`, `spec/ZONES.md` — the wire, the
stable player key, the warm-room table, the view API and their traps live
THERE; read before touching the netcode)
- ONE world, never instances (maintainer). Zones are rooms
  (`config/zones.json`; no entry = one room), ONE per zone per process; a
  border is crossed by a HAND-OFF over the bus, and what a client sees across
  it are GHOSTS in their own maps, which no server loop steps or fights.
- A client receives only what is within `INTEREST_WU` of itself (a `StateView`
  per client); THE JOIN SNAPSHOT IS A WHOLE VIEW, what a crossing binds on;
  gate `verify-zonehop.mjs`.
- `Encoder.BUFFER_SIZE` holds EVERY client's view section of one patch (2 MB):
  an overflow freezes clients silently, never errors. `loadbot.mjs` +
  `/api/stats` are the load instrument.
- Rooms talk ONLY over `server/src/bus.ts` (ioredis when `REDIS_URL`, else
  the in-process fake, same async contract). Writes are the Firestore
  bill: a save on leave, death, level-up, the dirty flush (a 2-cell walk
  dirties) and, AWAITED, on shutdown — a rollout never sends a player back
  to spawn (`rolloutsave.test.ts`).

**Monsters, combat** (`docs/monsters-combat.md`)
- Spawn placement is maps2 data (`spawns.json`); no spawns, no monsters.
- A zone cell is a SURFACE: a stray snaps back on ITS OWN LAYER
  (`nearestZoneCell`), never through the slab it stands on.
- The tuned shadow beats everything art-measured: centre = position, size =
  hit box, one size for every facing (`monsterRadiusFor`).
- `separationPush` stays squared-distance: broad-phase, not micro-tuning.
- Passive by default; predators aggro; a provoked chase paces its victim; the
  RUN-AWAY LINE is `ESCAPE_RADIUS_WU` 390 past the zone, the give-up IS the
  rejected step.
- Monster stats come from live tuning (a content check, not truthiness);
  nothing blocks the revive press; the ask retries.
- Backpack ORDER is server state: a drag sends `invmove` — a SWAP of two filled
  slots, never an insert; the item id names the entry, not the slot.

**Lighting** (`docs/lighting.md`)
- Every twinned field has an EXACT JS twin; change both; hash noise with the
  integer chain, never `fract(sin(...))`; no GLSL `pow()` on a negative base;
  a whole number into GLSL via toFixed (`glsl{pow,float}.test.ts`).
- A pass that is "off" leaves the display list AND writes its strength
  uniform unconditionally.
- `uCam` is this frame's rectangle (`renderedWorldView`), never `worldView`.
- The light slot ledger: 12 slots, 8 world, strict reservations, tenure not
  re-ranking; a light is a candidate when its POOL can touch the view
  (`poolReachPx`); remote torches are never lights; the campfire is real at
  its peak; a sealed-room fire is indoor-only.
- Scenery lights read the manifest `light` block as given (no radius cap) and
  cast shadows; scenery occludes like a prop, own cell = contact + directional
  core; the switches are pushed on the shader being BUILT; a piece's ART
  meets the ground with contact AO (`scenerycontact.ts`, `verify-contact.mjs`).
- The light passes and the glow field render at half resolution; an
  overlay's RT ratio survives update().
- Solid objects are art, not walls (no face band); a cave mouth is no face.
- Wall wash per PIXEL, wrap dial 0.7 (his), front gate fades over 2wu (a
  pressed torch must not dim); the LOS march blends neither a wall's own
  height into its front skirt nor the skirt the LIGHT stands in; a skirt
  sample counts only beside a HARD hit, two-span (a lid over the light is
  air); a fire in a piece is an AREA source (edge rays); the trunk skip
  spares share cells; every surface marches, above a light too; a top takes
  nothing from a light well under it (`TOP_UNDER_FADE`); gates
  `verify-{wallwash,wallfoot,shadowline}.mjs`.
- Day is sky + sun; the sun is the hand; DAY == NIGHT in the phase table is
  load-bearing (equal sun/moon speed).
- Ambient is on PER ZONE, server-decided (`docs/ambient-zones.md`): a zone
  rolls per 10-min window seeded by (id, window); the clock is the sync.
- Indoor ambient: dark 40%, lit 25%; hidden outline 20% (his); the room's
  wall tops wear the wall-top dial in the light, faces fade a storey into it
  (`verify-walltop.mjs`).
- MY ROOM IS A VOLUME: the room test takes a HEIGHT — the deck over the
  SAMPLE'S OWN column (`roomCeilAt`; no deck, no line), never the one under
  my feet (`verify-cavewall.mjs`); over my own roof its lights and halo are
  blocked outright, on `occ`, which scenery reads.

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
- Compare colours unlit (`__ml.lightAtCell`); headless GL has not a phone
  GPU's precision, contents loss or lag.

**Indoor** (`INDOOR.md`): a cut-away, not an x-ray; never go back to culling;
the outside is drawn at zero ambient, never skipped; wall height 1 is his.

**Audio** (`docs/audio.md`): talk to the composer only through `gameAudio`;
emit semantic events with literal names; a sound plays only if the wiki
assigned it.

## Probes, and don't

`window.__ml` is the instrument; each doc names its probes. Counters over
pixels: a gate cannot tell a correct dark frame from a black one.

Don't hand-author world art; don't edit outside `games2/` except your own
board (unless he grants the repo); don't grow this file — a new rule is one
line here, its story in the topic doc.
