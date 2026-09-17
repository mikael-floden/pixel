# Movement, navigation and animation

Server-authoritative movement, decks, collision, steer assist, fall damage, tap/hold-to-move, the body dodge, swimming, footsteps, gait-synced playback, the camera. Moved verbatim out of `games2/CLAUDE.md` (2026-09-09), which keeps the law and points here; the measurements, traps and rejected approaches live in this file. Rewrite in place under the root doc law.

## Isometric world

- `shared/parseWorld` reads `maps2/worlds3/<name>/world.json` —
  **pixel-maps3/world@1** (`parseWorld3`: a ground NAME per cell, level, walls,
  decks, rooms, scenery, spawn, size, the world's own `iso`); a hand-built
  `{width,height,rows}` literal still parses for fixtures. (world@1/@2 and
  bigworld@1 retired 2026-09-09.) Geometry: `x=(col-row)*32`,
  `y=(col+row)*dy − level*lh`, painter order `(col+row,row)`. World units:
  **32 per cell** (`CELL_WU`); WORLD_WIDTH/HEIGHT are sized to the grid.
- The world is too large for one texture: `WorldScene` streams a
  world-anchored ground RenderTexture covering screen + `GROUND_MARGIN`,
  redrawn when the camera nears its edge. `MapPreviewScene` (`/#map`) shows a
  world's pre-rendered minimap when shipped.

- **Decks** (elevated walkable slabs — roofs, bridge spans; `parseWorld`
  optional `decks`; `Deck`/`DeckCell`). A deck is a SECOND surface floating
  over unchanged base terrain (walk/swim UNDER it). `redrawGround` draws each
  deck cell right after its base cell: `thickness` face courses then the
  slab's ONE surface at `level` (A SLAB WEARS ONE SURFACE, above). Spec:
  `maps2/spec/WORLD3.md`; the_game ships 28 decks.
  - **Current-layer movement**: each `Player` carries `elev` (surface LEVEL);
    `shared/canEnterElev`+`resolveElevAt` offer a deck cell TWO surfaces and
    keep you on whichever is reachable and closest to your current elev — you
    cross a bridge/roof instead of falling through; under-walkers stay on the
    base. Non-deck cells resolve exactly as `canEnter`. A deck stays walkable
    over a blocked base.
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
  - Seeing yourself under a deck (house/cave interiors) is INDOOR MODE —
    see `games2/INDOOR.md`.

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
- **A FOOTPRINT BELONGS TO THE FLOOR ITS PIECE STANDS ON, AND SO DOES A
  BODY** (`SceneryFootprints.lvl`, `FOOTPRINT_LEVEL_SLACK` 1.5; `nearBodies`
  in WorldScene). Position is flat (x, y) and a cave shares its x/y range with
  the mountain over it, so the cave's braziers and crystals — stamped with no
  level — stopped a body walking the cave LID 24 levels up, and the cave's
  monsters deflected its input through the rock (maintainer 2026-09-09: "as
  if the player is walking around things that doesn't exist"). Every query
  that knows the body's surface level passes it — the lateral probes
  (`makeSideBlocked`), `canEnter` through `makeBlocked`, the glide contact
  normal, `unstickFromSolids`, the stall detectors via `walkHeading`'s
  `fromElev`, the follower's openness probe, the client's dodge/standoff body
  list — and skips footprints and bodies more than the slack away; the nav
  bake and `spawnCellOk` ask at the cell's BASE level (the nav layer is the
  base surface); a caller without a level keeps the old answer. `canEnterElev`
  needed nothing: a body above a deck never reaches the base candidate.
  Measured on the_game: 1,291 footprints, 101 under a deck two or more levels
  above their floor; replayed at 267.5,184.5 on the lid, left/right/down-left
  moved 11-15 wu in 2 s with 113-117 stalled ticks before, 249 wu and 0 after
  (`scripts/_tmp-lidsim.mts`-style: the real shared tick, no browser). THE
  DETECTORS TOO: `steerAssist`, `bodyStalled`, `headingClear`, `slideAlong`,
  `steerAssistWall` and `autoJumpWanted` take the elevation and then probe
  with `canEnterElev`/`makeBlockedElev`, not the base `canEnter` — the base
  under a lid is the cave, so two lid cells over a cave wall read as a cliff,
  the door-finder hunted along it and the stick was deflected (his second
  report, same spot). Measured over every cave-lid cell of the_game, 598 x 8
  headings: 158 phantom stalls with the base rule, 0 with the surface level.
  A caller without a level keeps the base rule. AND THE RELOG: `rec.pos`
  saves `elev`, and the join resolves it against today's terrain — restoring
  the base level put a lid-walker back INSIDE the cave. NEVER ON A WALL'S
  TOP (`restoreSurface`, maintainer 2026-09-13, "your engine sent me to the
  top of the mountain" at 208.0,225.5): `resolveElevAt` answers a cell with
  no surface a walk from the saved level with the cell's BASE, and a spot
  saved a hair inside a rock cell (its west edge x = 208.0 IS the rock,
  floor()) came back on the block beside Cave III's floor at 24, the floor
  at 4 one cell west. A restore that lands more than a jump from the saved
  level is moved to the nearest cell within three whose base or deck is a
  walk from it; none → the spawn. Gate: `server/test/restore.test.ts`.
  KNOWN GAP: a piece placed ON a deck reads the base under it (none in
  the_game). Gate: the floor test in `server/test/footprint.test.ts`.
- **NEVER-BACKWARDS IS A RULE, NOT AN ABSOLUTE: SECONDS OF NO PROGRESS
  ESCALATE TO A COMMITTED ROUTE** (`walkHeading` rule 0, maintainer
  2026-09-11: held down in the dungeon at 276.6,178.9 the body ran up and
  down the wall for as long as he held — "like a fly flying into a window
  ... the nav system should be smart enough to navigate the player around").
  The walk's ONLY navigation since 2026-09-13 (the per-tick local rules — a
  deflection held for a cell, the detour planned on an instantaneous stall,
  the full-speed slide that picked a side by list order — are RETIRED: they
  judged a stall from the 8-way key, so a stick a hair off square-on read as
  square-on and the body was dragged a whole cell the way the thumb was NOT
  leaning, "pushed the wrong way when sliding against it"; the tick's glide
  and this escape cover what they existed for). The memo watches progress
  ALONG THE ASK, AS A RATE over a window of his "Nav help after" dial
  (`client/src/navhelp.ts`, `NAV_HELP_MS_*`: 0.1 s default, 0.03 s (one
  frame: below it there is no rate to measure) up to 2 s; at the floor the
  nav fires on any single frame without headway, his to feel —
  maintainer 2026-09-13: "how fast the player has to run into something
  before the nav system helps. That should be extremely fast"; the 09-11
  window was 1.5 s, "we talk seconds"): a body that kept moving along the
  ask at `STUCK_PROGRESS_RATE` (a TENTH of a walk's pace: moving at all — a
  slide's progress along the ask is its share times its cosine to the ask,
  a sixth of the run for a screen-up slide under the old screen share, and
  at the stall test's 0.35 the escape fired mid-slide)
  over the window is making progress and the window slides on ("the nav
  system should not help if the player seem to slide around the object by
  itself ... the slide should be preferred if the sliding is doing
  progress"); one that did not
  gets `startEscapeRoute`: the detour's goal fan pushed out (5-12 cells), a
  pocket-sized corridor (`ESCAPE_CORRIDOR_CELLS` 8, not the skirt's 3) and
  search (2500 nodes), and the trip marked `committed`: followed to its end
  past the no-retreat rule and the hold — a route re-litigated every tick is
  the flapping those rules exist to stop, one level up — and dropped when the
  stick changes or the route itself is held. One attempt per window, route
  or no route, and a fruitless attempt DOUBLES the window up to 2 s
  (`ESCAPE_BACKOFF_MAX_MS`): a true dead end at 0.1 s would otherwise search
  the fan ten times a second. A WAY OUT LIES AHEAD: the terrain fan is
  straight-ahead goals only (`ESCAPE_GOALS` 8, 5, 12 cells — the old 45-degree
  goals let a steep push into an endless wall "escape" eight cells along it);
  the fan round a scenery piece or a prop (`ESCAPE_GOALS_PROP`) is NEAR goals
  first — 2 and 3 cells, then 5 and 8; in a small room every goal five cells
  on lies beyond a wall, and a body square on a table stood with the way
  round one cell away — led by a half-octant pair mirrored to the side the
  finger LEANS toward (the cross product of the 8-way ask and the leaned
  heading), so the way round is the way the thumb points. The corridor is
  measured along the ASK's line whatever goal it is aimed at (a goal 45
  degrees off put the spawn house's door beside ITS line) and is by what is
  in the way: the pocket's 8 cells for terrain, `ESCAPE_PROP_CORRIDOR_CELLS`
  4.5 for a piece or a prop — a 5-cell footprint's half, findPath's buffer
  cell off it and the cell the route runs through. And a PROP's escape
  CROSSES A ROOF'S EDGE ONLY AHEAD OF THE BODY (`roofExitAhead`: "under" is
  a deck above the feet, a body on a bridge is under nothing; the crossing
  point must lie `ROOF_EXIT_AHEAD_CELLS` 0.5 ahead along the ask): the route
  from the spawn house's table out through the door and round the outside
  to a goal beyond the wall is a journey, not a way round the table — it sat
  3.7 cells off the ask's line, inside what a footprint needs, and its door
  was BESIDE the ask. But a roof is not a box: it overhangs a strip outside
  the walls, and a body on that strip pressing into a brazier at the roof's
  edge had every route refused for leaving the roof, every goal ahead lying
  out from under it (2026-09-13, 273.3,186.0 running SE: "stuck between the
  scenery and the wall ... expected the nav to run and navigate me around,
  but it doesn't" — reproduced from 273.3,184.0: 4.3 s standing on
  brazier_004, six routes planned and all refused). Leaving ahead is the
  way the thumb points; leaving beside or behind is the door. A TERRAIN
  wall's escape may leave the house any way: pressed to the big house's
  south wall, the way out is the door — "the nav try to navigate me out of
  the house" is the nav he knows — and holding every escape under the roof
  put a body that had slid to the corner there for good (2026-09-13). AND THE ROUTE IS WALKED
  BEFORE IT IS TAKEN (`routeStallCell`): the nav layer answers per CELL —
  some body position exists in it — and a cell can hold a body without
  letting one THROUGH. Between the spawn house's cupboard and its table the
  cell is open along its west edge and 20 wu wide at its middle, the body 18
  across at its corners, so findPath threaded it, the follower stood on the
  first step, the walk dropped the route and planned the same one every
  window (253.1,303.7 walking NW: "I can't fit through and was hoping the
  player would have tried to run around using the nav system, but it
  doesn't"). So an escape is followed on the movement tick itself, on a
  copy, for `ROUTE_PROVE_STEPS` (60 frames of 33 ms, 2 s): one that arrives,
  or consumes a waypoint and keeps its follower's progress clock running, is
  real; one the walk would drop names the cell its LEADING EDGE stood in
  (one radius ahead toward the waypoint, where the probe refused — not the
  waypoint's cell: a waypoint at the pinch's own centre counts as reached
  from its mouth, and the next sits in the free cell beyond), `findPath`
  keeps out of it (`avoid`, threaded through `startTrip`) and the goal is
  planned once more — the route that comes back goes round the table
  (replayed: round it and 3.7 cells on within the hold). THE DROP AND THE
  PROOF SHARE ONE CLOCK: a committed route with no progress toward its
  waypoint for `ROUTE_STALL_MS` (250 ms, the follower's own
  `progress.t`: 2 wu closer) is dropped — a stand or a dither alike — and
  the proof fails a route by the same clock, so what it passes is what the
  walk would keep. Not `bodyStalled`: its 0.08 s probe jumped a rect's
  diagonal tip that the 33 ms frame did not (measured beside a south-facing
  table: 0 wu at 0.033 and 0.05, 2.8 at 0.08) and kept a body that stood 45
  frames on a route. TRAP: the probes are points at the substep's end, so a
  frame the phone does not run at can still disagree with the proof at such
  a tip; the walk's own drop then re-plans from the spot (synthetic pinches
  of two small pieces, 378 placements: 357 round within 4 s). Gate: the
  pinch in `server/test/sceneryslide.test.ts`. Replayed on the real grid: out of the pocket in under
  six seconds (the slide to the corner is most of it, the escalation a tenth
  of a second after); the brazier at 240.5,265.3 rounded east-then-north;
  square on the tables at 252.8,303.5 and 300.1,195.1 the body is round them
  within the window; the big house's south wall beside the door, held into
  with any lean, is out through the door in 0.5-1.2 s.
  Gate: the pocket fixture in `server/test/stickdetour.test.ts` (a copy of
  the world's levels, so re-authoring cannot move it) and the open-ground
  case that must never escalate. Probe: `scripts/holdtrace.ts` (COL ROW AX
  AY) traces `walkHeading` at any spot of the real world, tick by tick.
  **AND ONE TILE BACK, NO FURTHER** (maintainer 2026-09-13: "a backwards
  navigation can only happen when ... the corner is just around the tile you
  currently is running into ... the corner was 2 tiles away from the opening
  and not 1"): the escape is the only rule that moves against the stick, and
  `routeRetreat` counts its route's backwards reach in WHOLE TILES per world
  axis from the body's cell (`ESCAPE_RETREAT_CELLS` 1) — the pocket's exit
  one tile aside passes, the spawn house's door two tiles along the wall does
  not. Tiles, not a distance: findPath nudges its points off the walls, so
  the pocket measured 1.07 cells against the door's 1.48. Counted over the
  route's points BEFORE IT HAS GOT ON (`ESCAPE_MIN_PROGRESS_CELLS`, 2 cells
  along the ask): backwards is the first move against the tile being run
  into; a step against the stick taken eleven tiles on is the way round,
  and the corridor bounds it.
  **A DOOR IN REACH IS A ROUTE TOO, AND THE SHORTER WALK WINS** (maintainer
  2026-09-17, 299.3,199.1 held straight at the house's south wall with the
  doorway one cell to the side: "the door is literally next to the player.
  Why navigate around the house when the player obviously missed the door";
  and on priority: "It should be the same priority. Closest path around the
  object should win"): sliding sideways to a door makes no progress along
  the ask, so the window fired while the door-finder was already steering
  to it (165 ms in, measured) and rule 0 committed a route west and round
  the whole house (297 ms in). Now the escape branch asks the door-finder
  too, and compares walks: the door's lateral cells plus two (the doorway
  and the cell beyond) against the escape route's length in cells; the
  shorter is taken, the door as the sideways deflection it always was, the
  route as a committed trip. Neither has precedence — a door four cells
  along a wall whose corner is one cell away loses to the corner. Gate:
  `doorfirst.test.ts` — his house synthetic and the_game's own, from both
  sides of the door (through it inside 2.5 s, never west of the door), and
  the corner case where round the house is the shorter walk.
  **THE GOAL IS GETTING ON, NOT THE POINT AHEAD** (maintainer 2026-09-13,
  285.6,208.6 held down into a level-4 plateau's notch: "It's extremely
  clear I can continue downwards if I navigate a bit backwards and left ...
  Often the player want to run S and doesn't care how we manage to get S"):
  every goal straight ahead lay on the hill, reachable only ten cells south
  and up a ramp — a 9.9-cell bulge the corridor threw away — so no route
  arrived and the body stood, with the way south one tile west of it. Now
  `findPath` takes `progress` (through `startTrip`): the SEARCH stays inside
  the escape's corridor (`ESCAPE_CORRIDOR_CELLS`, 10, beside the ask's line;
  the goal's own distance on; `ESCAPE_RETREAT_CELLS`+1 back), and a goal it
  cannot reach there ends the route at the explored point FARTHEST along the
  ask, at least `ESCAPE_MIN_PROGRESS_CELLS` on — never the rim beside the
  goal. `planRoundTheStick` takes a route that arrives OR gets that far
  (`routeProgress`); an endless wall's rim beside the body is neither, and
  the body still stands there. Replayed at his spot: one tile west, ten
  south down the plateau's side, the ramp, and on. Gate: the notch fixture
  in `server/test/wallcorner.test.ts`.
- **THE RESCUE NEVER CLIMBS** (`unstickFromSolids` with the body's elevation):
  a push that would step more than a walk can climb, or drop, onto a cell
  with no deck at the body's level is refused — a cupboard against a wall
  points its footprint's gradient into the wall, and the rescue followed it
  onto the level-6 wall ring where `resolveElevAt` stood the body on the
  wall top (the inn's corner cell 306,226, 2026-09-09; the indoor gate found
  itself outdoors on a rooftop). Callers without an elevation keep the old
  rescue. Gate: the climb test in `server/test/footprint.test.ts`; the
  indoor scenery gate stands on the room's FREEST cell for the same reason.
- **Steer assist** (`shared/steerAssist`): the prop-corner dodge — on a real
  stall against a SOLID PROP, deflect to the closest open side of the ONE
  blocked cell — is no longer a rule of the walk (2026-09-13: the glide slides
  a body round a footprint and the escape rounds a prop); the walk reaches it
  only as the door-finder's entry on a terrain stall. The function and its
  tests stay (`server/test/steering.test.ts`; probe `__ml.steerAt`).
- **THE WALL WALK** (`walkHeading`'s terrain branch, `wallContact`;
  maintainer 2026-09-13, the spawn house's corner held down: the body ran
  right along the east wall, back into the corner, then out through the door
  two cells behind it — "I feel this makes it hard to control and understand
  where the player is running"). Against a TERRAIN wall the walk is the wall's
  (a scenery footprint or a prop walks the heading as it is and lets the glide
  slide it — **a scenery footprint is a prop WHATEVER THE NAV LAYER SAYS**, asked
  at the very probe points that refused the axis (`footprintBlocks`, r = 0,
  the tick's own test) and of the contact query: `cellSolid` reads the derived
  nav cells, a small piece fills none, under a roof every cell wears the deck
  and reads walkable — the spawn house's table took the wall rules and stood —
  and the brazier at 240.5,265.3 touched only the body's corner probe, 30 wu
  from its centre and past any contact reach, so it read as terrain too and
  the planner's short way round was never followed, 2026-09-13). Asked of the
  movement tick per WORLD axis, every tick, with the
  heading the frame would walk (the finger's leaned vector: the 8-way key may
  lock onto the wall's own axis and have no push into it at all):
  - **Straight along the wall within his angle**: the thumb no more than the
    "Wall assist angle" dial off the wall's drawn direction
    (`client/src/wallassist.ts`; `WALL_ASSIST_DEG_*`, DEFAULT 10 — HIS, off
    the slider the same day — SCREEN degrees, `wallAngleDeg`; 0 = off) runs
    exactly along it at full speed:
    the diagonal key pair that locks onto that axis (`worldAxisToScreenInput`),
    flagged `deflected` so the client neither leans it back into the wall nor
    faces it — "just a little bit into the wall we can help the player to run
    straight alongside the wall (to not lose friction and looking dumb)".
  - **Past the angle the wall takes its share**: the heading is walked as it
    is and the axes resolve as ever — the body slides at the wall's own rate
    (the thumb's screen speed at the world cosine, `slideShare`: 45 degrees
    in slides at 71% of the run, 65 at 42%), stops square on, and stops in a corner
    (both axes refused): "the only correct way to navigate is to in both start
    positions run the player into the corner". A jumpable wall is then hopped
    by auto-jump (below) — "this sliding means the player will sooner or later
    jump up on that hill".
  - **A door sideways or ahead within `STEER_DOOR_RANGE`** (4) is steered to
    by the door-finder (below); one behind the run never, at any distance —
    "the door is way too far away for doing a 'run backwards' navigation".
    From that corner, bottom-left (a run straight into the south wall) has the
    door sideways and takes it; bottom-right (into the east wall) and down
    (into the corner) have it behind and stand.
  - **The sprite faces the way it WALKS** — the deflection when the nav
    deflects. Facing the STICK instead was tried the same morning and TAKEN
    BACK ("It looks much better if the player looks the way the nav system
    moves the player"), so the facing is the walked vector's on both sides
    and no facing rides on the input. Do not re-attempt.
  - **Walk or run follows the body's ACTUAL SCREEN speed** (`gaitSpeed` +
    `gaitRunning`, shared; "the player movement is not that much so the
    player should here not run ... depends on the player's speed after the
    collision with the wall has been done and the v was cut"): the client
    asks it of its predicted body's speed (an EMA over 100 ms,
    `av.gaitSpeed`), the server per input for everyone else. The speed is the
    body's SCREEN change in the walk's units — a free walk measures
    `WALK_SPEED` whichever way it goes, a free run `RUN_SPEED`, a slide its
    share of the run (world units were not one number: a screen-up walk
    covers 1.6 world units for a screen-right walk's 0.7, so the same slide
    ran or walked by which way the wall faced). THE RUN GAIT BEGINS AT 80% OF
    THE RUN AND ENDS AT 74% (`GAIT_RUN_ON` 2.0 / `GAIT_RUN_OFF` 1.85 walks,
    the run being 2.5; maintainer 2026-09-13: "we switch from walking to
    running at too low velocity. The switch should come 50% closer to max
    speed" — the line stood at 1.15 walks, 46% of the run, and every slide
    along a wall played the run). Halfway to the run is 73%, a hair above the
    71% every cardinal key slides at, and the run's own edge must sit above
    that plateau too or a run cut to the slide keeps its gait through the
    hysteresis: at 80/74 the 71% slide walks from either side, the free run
    runs, and the band holds no plateau to flicker on. Square on, going
    nowhere, walks in place. Gate: `server/test/gait.test.ts`.
  Gate: `server/test/wallcorner.test.ts` — a copy of the house's levels, his
  two start spots, the three stick directions, the angle, the hop, the tile
  cap. The world border is terrain too: a body runs into the map's corner and
  stands (the footprint test stops once its blob is behind for that reason).
- **The door-finder** (`steerAssistWall`, the terrain stall's assist;
  maintainer 2026-08-12: "find the closest path around taking the player
  forward … helps when the player doesn't aim at the door exactly right"): on
  a stall against terrain even a JUMP can't climb (1-level ledges stay
  auto-jump's) it asks the movement tick WHICH world axis refuses — never the
  intent's dominant component: screen-down is a world diagonal, and the
  dominant-axis guess hunted up and down the room's floor beside the south
  wall instead of along it — hunts up to `STEER_DOOR_RANGE` (4) cells along
  each refused wall (nearest opening first, either side, both walls in a
  corner), skips any opening whose lateral direction opposes the stick, and
  deflects purely sideways, re-evaluated every tick. The slide LANE is checked
  cell by cell (a door behind a boulder is not a door); the opening must LEAD
  FORWARD (cell beyond enterable at jump climb — else an alcove attracts); no
  candidate may sit a DAMAGING drop below the feet. No opening → null, honest
  collision. Tests: the terrain-wall block of steering.test.ts,
  wallcorner.test.ts.
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
  - **Steering** (`stepAutopilot`'s openness probe, 2026-09-14): a candidate
    heading is not open when it would put the body more than `JUMP_CLIMB`
    below BOTH its own elevation and the ROUTE's next waypoint level — a step
    it cannot undo. Movement itself is untouched (a player who walks off a
    ledge meant to); this is only about the autopilot spending the route on
    one. Measured on the_game's mountain at 133 ms frames (a struggling phone,
    navigation.sim): a run step there is 30-70 wu, wide enough to carry the
    body a cell past the rim, and it took a 5-level drop — under the damage
    line, so nothing hurt, but the route's own levels never went below 11 and
    from level 5 the single stall re-plan could not climb back. The trip
    reported ARRIVAL 2.7 cells short at the foot of the drop. The probe is
    deck-aware (`resolveElevAt`): reading the raw level would call every step
    onto a bridge a cliff and strand the walker on the span — which is what
    the first cut of this did, and the three bridge arms caught it.
  - **Landing** (WorldRoom, on the input integration's elev resolve ONLY —
    teleport/respawn/join assign elev directly and never bill a fall): a drop
    ≥ 6 levels costs `round(frac·hpMax)` through the standard `hurtPlayer`.
    Landing in SWIMMABLE water is a dive — free. Walking off a cliff manually
    is allowed; the damage is the price.
  - **THE HIT LANDS WHEN THE BODY DOES**, not when it steps off. The server
    resolves the whole drop in ONE tick while the client draws
    `fallDurationS(drop, lh)` of descent (6 levels 671 ms, 32 levels 1.55 s),
    so billing it at the resolve emptied the bar, played the flinch and
    started a fatal fall's death animation in mid-air (maintainer 2026-09-11:
    "I should take fall damage when I hit the ground and not when I start
    falling"). `fallPend` (pid → hp + due time) is settled at the top of the
    tick, before the input that follows it; a second cliff caught mid-fall
    ADDS to the pending hit and pushes it to its own landing. An ASSIGNED
    elevation drops it — spawn, teleport, revive, hand-off, leave — or the
    hit outlives its fall and kills you somewhere else. `fallDurationS` is
    the closed form of `integrateFall`'s own physics (t = √(2d/g)), so the
    two cannot drift.
  - **THE LANDING'S SLOW FADES WITH ITS NUMBER** (maintainer 2026-09-12: "The
    slowdown after a fall is too long. Should only apply when the user hit
    the ground and fade away. Maybe last as long as the dmg number but also
    fade away"). A landing went through `hurtPlayer` as a hit and so took the
    combat stagger: SLOW_FACTOR flat for SLOW_MS (1.5 s), then full speed in
    one step — a long drag with a hard end. It is its own factor now,
    `fallSlowAt` (shared `combat.ts`): SLOW_FACTOR the tick the feet are down
    (`lastFallAt`, set by `settleFalls`, never `lastHitAt`), fading linearly
    to 1 over `FALL_SLOW_MS` = `DMG_FLOAT_MS` (850 ms, the damage number's
    float — the scene's tween reads the same constant), min()ed with the
    stagger and the flee slow like before. The 1.5 s stagger stays combat's:
    it is the escape math (a hit-slowed runner cannot pull clear of a chase),
    and a fall onto a monster simply takes the deeper of the two. The client
    changes nothing — it mirrors the synced factor per patch as it always
    has, and a 20 Hz ramp reconciles in sub-pixel nudges (0.45 of speed over
    850 ms is 0.03 a tick). Gate: `fallslow.test.ts` (the curve) and the
    live landing in `falldamage.test.ts` (slowed on the hit's patch, mid-float
    strictly between, 1 once the number is gone).
  - **THE WHOLE IMPACT IS THE CLIENT'S TO SHOW** (`fallhurt.ts`), because the
    server's cannot arrive in time: it bills on landing and its patch then
    costs a 20 Hz tick, a patch interval and a round trip, so ANYTHING hung
    off `hitSeq` — flinch, blood, damage float — shows up after the feet are
    down (maintainer 2026-09-11, twice: "it's still too late and the dmg
    number over the players head is also too late"). The client runs the
    server's own rule (≥6 levels, a swimmable landing is a free dive,
    `fallDamageFrac`) against its PREDICTED fall, and:
    - the **blood, the number and the sound** fire on the frame `falling` goes
      false, which IS the frame the feet touch — no timer, no estimate;
    - the **clip** starts early by exactly the frames before the got-hit frame
      — **the 4th**, index 3, the doubled-over pose with the impact mark
      (maintainer named it) — at `FALL_HURT_RATE` 1.5× the combat rate: a
      125 ms lead over a 208 ms clip, three frames of bracing in the air and
      the fold on the ground. Combat's `ANIM_FPS.hurt` is untouched (round 7).
    - the server's hit for that fall is then SWALLOWED WHOLE
      (`fallShownUntil`) — clip, blood, sound and the number. **ONE FALL IS
      ONE NUMBER**: floating the remainder of a disagreement was tried and is
      the bug it looks like, a 16 and then a 1 over his head from one point
      (maintainer 2026-09-11: "now I take dmg two times ... WTF?"). The hp BAR
      is the server's word and already shows the truth, so a prediction a
      point out costs a slightly wrong number for half a second, never two.
    - and the two agree to the point because the client reads WHOLE levels:
      the server bills `elevBefore - player.elev`, both resolved surface levels
      and so integers, while `av.elev` is the ANIMATED pixel lift — 8.34 storeys
      where the server reads 9, and `fallDamageFrac` of that is the point that
      became the second number. Gate: "the predicted fall damage is the
      server's figure, to the point" (non-vacuous — a fractional read differs
      on 319 of the swept cases).
    Three things that were each a frame or more of lateness on their own:
    the clip's start time is RE-SOLVED every falling frame (a one-shot
    estimate drifts over a second and a half); the landing time subtracts
    `dt/2` because `integrateFall`'s semi-implicit Euler touches down that
    much sooner than the closed form; and the once-a-frame firing check
    carries `hurtFireSlackMs` (half a render frame) plus `hurtSeekFrames` so a
    late start skips the frames it missed instead of sliding the clip.
    Measured worst-case got-hit error: 60 fps 17→8 ms, 30 fps 33→17 ms,
    24 fps 41→21 ms. `hurtClipKey` is used and NEVER `resolveAnim`, whose
    "hurt" order falls back to IDLE — an idle key there would silently make
    the flinch an idle pose and take the lead off the wrong frame count. The
    arm is cancelled by a fall that ends early or a teleport. Probe:
    `__ml.fallHurt()` reports which frame of which clip was on screen at
    touchdown, which is the one thing that cannot be judged by eye;
    `__ml.fall()` now carries the ABSOLUTE col/row (the synced `px/py` are
    quarter units relative to the ZONE ROOM, so a gate reading them saw the
    body jump 99 cells sideways at a border and could not aim at a ledge).
    NOT MEASURABLE HEADLESS: the local client runs at ~2 fps under software
    GL, so the whole 775 ms fall is one frame — every number above is
    arithmetic, and the verdict is his screen.
  - Gates: `server/test/falldamage.test.ts` (curve pins; the route law
    verified failing on the pre-fix baseline; live-room cliff + dive, and the
    cliff arm asserts hp is UNTOUCHED at the edge and billed 0.5–1× the fall
    clock later — measured 822 ms on an 8-level ledge against a 775 ms
    clock); `collision.test.ts` holds `fallDurationS` to within one frame of
    the drawn descent at six drop heights, and pins the flinch arithmetic —
    the 4th frame is the frame on screen at touchdown, the frame before it is
    still the wind-up, and the clip outlasts its own lead.
- **THE PLAYER-SPEED DIAL** (`client/src/playerspeed.ts`), his instrument for
  finding a default and for crossing the map (2026-09-11: "a way for me to
  travel the map faster"). 0.5x-4x, default **1.1x — HIS NUMBER off the
  slider** (2026-09-14: "1.1x should be the new player default speed"; 1.2x
  was his pick on 2026-09-11, 1x the walk before the dial existed). He rides
  the dial and then says the number — the ONLY way this default moves; do not
  "restore" 1, and do not tune it toward anything. `localStorage`, with the "default" button
  every slider carries, injected into the Settings page from outside exactly
  like the nav dials (games-ui owns hud.ts).
  - **IT RIDES PER INPUT** (`InputMessage.sm`), not as room state. Movement is
    server-authoritative and the client replays an RTT-deep pending buffer, so
    a factor that changed mid-flight would rewrite the history of every input
    still in it — the same trap `pending.slow` is documented for. Each window
    is integrated, on BOTH sides, under the number it was sent with; absent
    means 1x, so an old client or a replayed pre-dial message walks normally.
  - **THE CLAMP IS THE SERVER'S** — `[PLAYER_SPEED_MIN, PLAYER_SPEED_MAX]` in
    the input handler. Same standing as `teleport`: a knob the maintainer
    drives, bounded by the authority rather than by the client's good manners.
- **THE ACCELERATION RAMP** (`client/src/accel.ts`, shared `accelStep`;
  maintainer 2026-09-13: "The player's acceleration from standing still to
  running fast is way way way too fast right now. It kinda feels like we go
  from 0% to 100% on a single frame. Create a slider for this and make the new
  default 5x as slow as today"): the commanded speed rises linearly from rest
  over the dial's "time to full speed" — 0 is the instant law of before, the
  default `ACCEL_S_DEFAULT` 0.17 s (five frames of 33 ms: today was one), the
  top a second — and falls at the same rate when the stick is released, so a
  press within a release's ramp resumes where it was while the body itself
  stops at once (no input, no move). The stop is not ramped: he asked for the
  start.
  - **IT RIDES PER INPUT** (`InputMessage.ac`, 0..1), the speed dial's rule
    and reason (a factor that changed mid-flight would rewrite the pending
    buffer's history). The window's number is the ramp's MEAN over it — the
    exact integral of a linear ramp (`accel.test.ts`) — which is what the
    client's not-yet-sent tail is previewed under (`WorldScene.rampMean`),
    what the window is stamped with when it closes, and what the server
    integrates: preview, replay and authority move the same distance. The
    server CLAMPS it to [0, 1]: a slowdown only, never a boost; absent = 1.
  - **ACCELERATING IS NOT STUCK**: `walkHeading` takes the ramp's factor as
    `speedFrac` and rule 0's progress ask (a tenth of a walk's pace) is at
    that share — a second-long ramp moves a walk 0.35 wu in its first window,
    half the ask, and without the share the walk planned an escape route
    across open ground. The gait needs nothing: it follows the actual speed,
    so a body accelerates through the walk into the run.
  - Nothing else needs changing, and both are measured, not assumed: the
    autopilot's advance/arrive radii already scale with the OBSERVED per-step
    distance (capped at a cell), so a 4x walk clips waypoints instead of
    orbiting them; and the gait's playback timeScale is `spdWu / base` clamped
    to 2.6x, so the legs run fast and never free-wheel.
  - Gate: `server/test/playerspeed.test.ts` — a live room integrating the same
    input stream at each dial, asserted as RATIOS AGAINST THE DEFAULT rather
    than pinned multiples, because the default is his to move and a hardcoded
    "2x is twice the baseline" would go red on his taste instead of on a bug.
    Measured at the 1.1x default: the default walk covers 147.84 wu over the
    stream, 2x = 1.818x, no dial = 1.000x, sm=99 = 3.636x (the cap, 4, over
    the default), 0.5x = 0.455x — every ratio is `sm / default`, exactly. It BURNS A WARM-UP RUN first — the real-time input
    budget starts empty on join, so the session's first run is clipped and made
    every later ratio read ~19% high. Probe: `__ml.speed()`.
- **ALMOST EIGHT DIRECTIONS** (`client/src/stickdir.ts`, `leanHeading` in
  `shared/`), the stick's direction-freedom dial. He keeps the snap and said
  why — "we only have animations in 8 directions and you will only be able to
  run in 8 directions on a keyboard" — but the snap costs FEEDBACK: "it's hard
  to see if you are close to snap to a new direction or not". So the heading
  leans toward the finger's real bearing by his dial ("Direction freedom
  (stick)"): **0 = the plain 8-way snap, 0.5 = half the lean, 1 = continuous
  all the way round; HIS DEFAULT IS 0.85** (maintainer 2026-09-11, off the
  slider — nearly free movement with a last sliver of pull toward the octant
  so the eight animations still read; it shipped at 0 only so the dial could
  not change the game before he had looked at it).
  The finger's place in its 45deg sector (residual, clamped to half an
  octant) is mapped, times the dial, onto HALF the angular gap to the
  neighbouring octant's RUN heading on that side (`octantRunDeg`).
  - **THE LEAN RUNS BETWEEN THE OCTANTS' REAL RUN HEADINGS, NOT THE SECTOR
    CENTRES.** A diagonal press does not run at 45deg on screen: the grid-axis
    lock (below) runs it along the tile axis, 23.6deg off the horizontal on a
    32x14 iso. So the diagonal's anchor is that axis, both sides of every
    sector edge meet at the same heading (half the gap), and at 1.0 the run
    is continuous round the circle — non-linear in the finger's angle, which
    is the iso remap, not a bug. (Interpolating raw screen angles put a leaned
    NE at 45deg while W+D ran the axis at 23.6: a 21deg jump the moment the
    finger left the sector's exact centre.)
  - **THE GRID-AXIS LOCK LOCKS EXACT DIAGONALS ONLY** (`screenToWorldVector`:
    |ix| == |iy| to 1e-9). It used to lock ANY vector with both components
    non-zero, so every leaned heading was a "diagonal press": a near-north
    walk snapped onto a grid axis and the body ran NE/NW while the sprite
    faced N (maintainer 2026-09-11: "almost impossible to control"). Key
    vectors are exactly (+-1, +-1) and the lock is bit-for-bit what it was
    for them; a leaned vector never is one.
  - **THE FACING IS THE THUMB'S OCTANT**: `stepMovement` takes it from the
    vector (`vectorToDirection`), quantised on the eight RUN headings — the
    iso octants the keys run along (`octantRunDeg`), not the 45-degree
    compass points of a top-down game. A diagonal key runs along a world
    axis, 23.6 degrees off horizontal on this screen: up-left is 156.4, 1.1
    degrees from the north-west/west boundary the compass points put at
    157.5, so the least lean toward left faced the sprite west while the
    body ran up-left (maintainer 2026-09-13: "the player direction is not
    perfectly tweaked with the player velocity ... how I hold the thumbstick
    vs the player sprite direction"; his stick 3 degrees left of up-left at
    the default lean walked at 157.7). On the run headings every octant's
    whole lean range (128-166 degrees for up-left) lies inside its own
    sector: eight animations, eight octants, the sprite is the octant the
    thumb is in, at every dial and bearing. The same quantiser faces a
    monster at its victim (`faceToward`), so a victim along a world axis
    gets the diagonal sprite too.
  - **THE BEARING IS READ ADDITIVELY, off games-ui's element.** Their
    `gamepad.ts` snaps to 8 and SYNTHESIZES WASD by design ("no games-agent
    file is touched"), so the finger's angle never reaches this agent's code.
    `stickdir.ts` attaches its own PASSIVE pointer listeners to
    `.ml-pad-stick` and computes `atan2(dy, dx)` off the same element rect
    their `apply()` uses. Nothing of theirs is edited and EVERY THRESHOLD
    STAYS THEIRS — dead zone, walk/run amplitude and which octant won all
    still come from the synthesized keys; this adds an angle and nothing else.
    No finger down, no lean, so a keyboard player is bit-for-bit unaffected.
    The coupling is the class name; offered on the board for games-ui to
    publish the bearing themselves instead.
  - **APPLIED LAST, AND ONLY TO AN UNDEFLECTED HEADING.** Steer assist, the
    monster dodge and the autopilot are deflections with their own reasons, so
    the lean is skipped unless the vector still equals what the keys asked for
    (`rawAx/rawAy`) — the residual is only meaningful while that vector is
    what we are walking. The leaned vector is UNIT, so a lean can never change
    pace; it goes into the input message like any heading, so the server
    integrates exactly what the client predicted.
  - Gate: `server/test/stickdir.test.ts` — his three settings in his own
    words, continuity across every sector edge, the diagonal anchored on the
    grid axis, the lock left alone by a leaned vector, the clamp, and unit
    magnitude.
- **Auto-jump**: walking INTO a wall a jump clears auto-fires the jump
  (`maybeAutoJump` from `predictAndSend`, after the stick's lean). Rule:
  exactly `!canEnter(walk) && canEnter(jump)` — taller walls and solid props
  are left alone; flat ground never fires. Client-only (queues the same jump
  input the server validates); `tryJump` still gates on grounded+cooldown.
  Probe: `__ml.autoJumpAt(x,y,ax,ay)`.
  - **THE HOP INTO THE WALL** (maintainer 2026-09-12: "even if you have a
    slight angle into the wall the player/character will never jump up the
    hill. I want it so the direction the player wants (using the thumb stick)
    will be respected and the player has to jump up to the next platform in
    order to maintain that angle. The player can't keep running along the
    wall forever"). `autoJumpWanted` probes ONE point PLAYER_RADIUS+3 out
    along the push's DOMINANT axis, so a run leaned into a wall BESIDE it
    reached the wall line only by its minor component (2.6 wu at 10 degrees,
    12 needed): the refused axis slid, the free one ran the body along the
    wall for as long as the finger held. `autoJumpProbe` keeps that probe and
    adds one per AXIS — any component at least `HOP_INTO_MIN` (0.05, ~3
    degrees: finger jitter on a run held parallel is not a lean) into a
    jumpable wall is a jump, and a LATERAL one: the airborne window moves the
    feet only `component × speed × 0.6 × 0.5 s` toward the wall (5 wu at 10
    degrees running, 12 needed), so the angle alone would take a series of
    hops along the wall. `hopIntoWall` (shared, pure; the memo is the
    caller's) steers the run INTO the wall — `worldAxisToScreenInput`, the
    diagonal key pair the grid-axis lock snaps onto that world axis, at the
    diagonal press's own pace — until the feet have climbed, the window is
    over, or the push into that wall drops below the dead band, then hands
    the angle back; the steered vector is predicted and sent like any
    deflection, the server sees ordinary input. Direct input only (keys, the
    stick — `keysActive`); the autopilot plans cardinal jump edges and keeps
    the dominant probe (`lateral` false). Measured on the real tick
    (`server/test/hop.test.ts`, the same stepMovement/makeBlockedElev/
    resolveElevAt under the server's jump semantics): a 6-degree lean running
    climbs in ONE hop, at 117 ms, steered 133 ms, and is 471 wu
    on along its angle at 3 s; the old rule is still on the low ground,
    pressed to the wall, 484 wu down it. SINCE 2026-09-13 THE WALL WALK COMES
    FIRST (above): a lean within the wall-assist angle is straightened along
    the wall and never reaches this probe (nothing pushes into the wall); the
    hop is what a lean PAST the angle does. hop.test.ts drives `hopIntoWall`
    alone and keeps measuring the hop itself; wallcorner.test.ts runs the two
    in the pipeline's order (a world 10-degree lean runs straight, 45 hops).
- **Collision probes** (`stepMovement`): per axis, the forward CENTRE probe
  applies the full rule (`makeBlocked`); the two LATERAL corner probes
  (±`PLAYER_RADIUS*0.75`) apply `makeSideBlocked` (solids only) and are STRICT
  — the "escape-permissive" variant (compare probe cells current-vs-target)
  was REJECTED: for normal steps both land in the same cell, which disabled
  lateral prop collision and let bodies drift into footprints. Integration is
  SUBSTEPPED (~4wu chunks): probes refuse an axis whose leading edge at the
  step's END is blocked; one 100ms run input (`MAX_INPUT_DT`) reaches ~30wu
  and pre-substep froze the body far from the wall. Test: "big-dt input
  advances to contact instead of freezing a step early". **A SLIDE IS THE
  THUMB'S SCREEN SPEED AT THE WORLD COSINE** (`slideShare`, maintainer
  2026-09-13, the cliffs at 229.9,304.4 and 256.3,273.4): the axis the wall
  leaves (or a footprint's tangent) is the DIRECTION; the LENGTH on screen
  is the free step's screen length times the cosine, in WORLD, between the
  step and that direction. The free run's screen speed is uniform (a
  screen-up step is 3.7 world units, a screen-right step 1.6), so one angle
  is one share: every screen-cardinal key meets a terrain wall at 45 degrees
  in the world and slides at 71% of its own run, whichever wall and
  whichever key; 65 degrees in slides at 42%; square on stands. Two laws
  before it failed on the same cliff. The raw world component along the
  free axis shows on the iso screen as anything from half to
  one-and-a-quarter of the run — up slid at 100% (capped) and right at 55%
  ("running straight up against the wall the player slides very very fast
  to the left ... straight right ... very very slow"). The SCREEN projection
  that replaced it slid up at 40% and right at 92% ("now super slow ... the
  other way around this time. Running up must be faster, but maybe not as
  fast as before") and stood a body on the spawn house's door post for the
  length of the hold: the leaned heading's x axis had drifted it under the
  post, the y move was refused, and the only remainder was 99 screen degrees
  off the thumb — a zero share on a step the straight key would have taken.
  The world cosine is zero only when the remainder is (a per-axis remainder
  or a tangent glide always has a positive world cosine to its step), so a
  slide can never stand where a step would pass. It implies the old "never
  faster than the run" cap (cos <= 1); a share above the per-axis remainder
  is re-probed at its farther end. FOR THE THUMB'S WINDOWS ONLY
  (`MoveOpts.screenSlide`, sent per input as `InputMessage.route` inverted,
  so a replayed window keeps its law): a planned route — tap-to-move, the
  walk's escape — keeps the world-axis slide under the old cap
  (`slideCap`). The share is a rule for a thumb; the route's follower has
  none, was tuned on the world-axis slide, and at a 40% slide turned a few
  frames early at a cliff and oscillated between two flanking headings
  until it gave up (`navigation.sim.test.ts`, the mountain, seed 5). Gate:
  the full-circle sweep in `collision.test.ts`, the shares in
  `wallcorner.test.ts` and `sceneryslide.test.ts`. **THE GLIDE TRIES
  THE TANGENT AS ONE MOVE FIRST** (maintainer 2026-09-13, the spawn house's
  table "more sticky ... can't slide alongside it as I can with a wall ...
  does it have to do with the table's rotation?" — it did): a rect footprint
  facing south has its sides on the SCREEN axes, the map's diagonals, and
  each axis probe reaches (12 + 9) x 0.71 = 15 wu toward such a side, past
  the 12 the body keeps — the tangent's half toward the side was refused and
  the half away taken, a zig-zag OFF the table at 0.64 of the run, while the
  cupboard (facing south-west, sides on the world axes) slid at 1.0. Now when
  an axis is refused and a footprint opposes the step, the step projected on
  the shape's tangent is tried as ONE move (leading edge along it, corners
  across it, capped to the free step's screen length) and taken when it
  passes and carries more of the intent than the axes did; the per-axis retry
  stays as the fallback, terrain has no contact normal and is untouched.
  Measured: along a diagonal side 1.0 of the run, world 45 degrees into it
  (24 on screen) 0.92 of the run's screen speed, on the side the whole way;
  square on it stands. Gate: `server/test/sceneryslide.test.ts`. Bodies inside a
  solid's margin (fall landings, spawns, history) are freed by
  **`unstickFromSolids`** (shared): smooth, speed-limited push along the
  away-gradient, run by the SERVER before each input integration and mirrored
  by client prediction (`stepLocal`). **Never weaken the probes to fix a
  wedge** — unstick is the escape hatch. Tests in collision.test.ts.
  **AND IT KEEPS `WALL_STANDOFF` (= PLAYER_RADIUS) OFF ANY FACE THE BODY
  CANNOT WALK UP** (`cellWallFrom`, elevation-relative; a DECK cell is a wall
  only when neither its slab nor the ground under it is reachable): the
  lateral probes read solids only, so a body carries any lateral offset it
  likes along a wall, and walking down the free column beside a wall that
  starts further on left it 5.2wu off the face where a head-on run rests at
  12.3-14.0 (maintainer 2026-09-15: "walking around a corner I sometimes can
  get much closer to the wall than if I run straight into a wall ... the
  players TORCH doesn't even light it up"). A refused MOVE there would wedge
  every corner — the state is corrected, never the probe tightened. A DESCENT
  is untouched (the rim overhang is the feature), a 1-level step is a walk not
  a wall, a one-cell door still passes from every offset across it and a
  one-cell corridor centres the body instead of railing it along one side; the
  push is speed-limited (80 wu/s), so rounding a corner at a run the body is
  inside the standoff for ~130 ms and no longer. Gate:
  `server/test/wallclear.test.ts` (the bisect arm drops the elevation from the
  rescue call and asserts the body hugs the face again).
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
- **A SLIDE IS THE THUMB'S SCREEN SPEED AT THE WORLD COSINE** (`slideShare`
  in `stepMovement`; the rule and its receipt are in the Collision probes
  bullet above). It replaced the 2026-09-12 "never faster than the run" cap,
  which it implies — the axes resolve separately and a refused axis left the
  other's WORLD component intact, which projects anything from half to
  one-and-a-quarter of the run on the iso screen (the caves, 2026-09-12:
  "when I run into a wall at a certain angle the player is moving much
  faster"; the cliff, 2026-09-13: "very very fast to the left ... very very
  slow" to the right) — and the screen projection of 2026-09-13 that
  reversed the asymmetry ("now super slow ... the other way around") and
  stood a body on a door post. Gate: the full-circle sweep in
  `server/test/collision.test.ts`.
- **Controls are screen-relative**: `stepMovement(..., screenInput)` rotates
  input by the projection ratio (`ISO_DX`/`ISO_DY` in `shared/`; the client's
  `MAP_GEOMETRY` imports them so they can't drift) — Up walks straight up on
  screen; facing uses the raw screen vector, quantised on the eight run
  headings (`vectorToDirection`). **Grid-axis lock**: an EXACT
  diagonal press (|ix| == |iy|) snaps the world move to the nearest tile axis
  (`screenToWorldVector`) so corridors/bridges track true; single keys stay
  screen-cardinal; a leaned stick heading is never a diagonal press (it ran
  N as NE/NW when it was).
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

**THE GROUND UNDER A POINT IS ITS NEAREST CORNER'S, NOT ITS CELL'S**
(`shared/src/index.ts` `typeIndexAtWorld`, behind `surfaceAtWorld` and
`surfaceAtWorldElev` — the server's swim flag, speed, the client's footsteps,
`canEnter`, the side probes and the fall test all read it). The renderer
composes a cell's tile from the grounds at its FOUR CORNERS (tiles3
`boundaryAt`), so inside a shore tile the water/sand line runs near the
quadrant lines and the quarter nearest the (x+1, y) corner is drawn in that
neighbour's ground. Reading the cell's own type for the whole cell put him
standing on drawn water and swimming on drawn sand (2026-09-09, both
photographed: "the transition tile is not 100% water or 100% beach ... The
player must use this boundary to know where it has to swim and where it can
stand"). The lookup rounds to the nearest grid point with the renderer's own
limits — a corner more than one storey off this cell's level folds back to
the cell (`BOUNDARY_STEP`), A LIQUID CORNER VOTES ONLY AT THE CELL'S OWN
LEVEL, and an exact cell centre stays the cell (strict `>`), so every
`(c + 0.5) * CELL_WU` per-cell query is unchanged. A pure cell is unchanged
byte for byte; level and deck stay per cell. Full server suite: the same 24
pre-existing fixture failures before and after, nothing added.

WATER LIES FLAT, AND THIS IS THE BODY'S HALF OF IT (2026-09-12). A sea one
storey below lay inside the fold, so the quadrant of a shore STEP nearest the
water read as water and the body swam a level above the sea — "Why do I swim
one stair up?" (maintainer 2026-09-11 at 277.6, 269.5: dark_mud at level 1,
the sea at 0; 9 quadrants over 8 cells of the_game, every one land at level 1
beside water at 0, and light_beach along the south shore is seven of them).
tiles3 `boundaryAt` folds the same corner away the same day, so that tile draws
no water at all: this clause is what keeps the picture and the body telling one
story, which is the whole reason the lookup reads the corner. A LAND corner
keeps the one-storey vote — the beach quadrant of a water cell is still
standable and that shore tile is still drawn (1,518 quadrants of the_game still
swim at the water's own level). Gate: `server/test/swimlevel.test.ts`.

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
  scuff (`fs-dot` `#141418`); only near-black `black_rock` overrides to
  lighter stone dust (≈ `#9a9aa0`); sand/snow/ice get darker/cool presses.
  Marks draw below the night overlay (contrast holds at night); foot-width
  ~7px; depth `y-0.5`; pooled + capped 240; peak alpha ~2s then quadratic
  ease-out. Probes: `__ml.footprints()`, `__ml.footprintsList()`,
  `__ml.myScreen()`.

- **THE BODY-DODGE IS A MANOEUVRE, NOT A PER-FRAME OPINION** (`monsterDodge`;
  NPCs and monsters have faked client-side collision — the INPUT slips around
  their personal space). The laws, from the back-and-forth-panic reports:
  - Engage and release on DIFFERENT thresholds: engage at `dot ≥ 0.35` inside
    the personal corridor (`dodgePersonal` = `r + (selfR + MONSTER_DODGE_MARGIN)
    · MONSTER_DODGE_TIGHTEN`); HOLD the committed blocker until `dot < 0.0`
    inside `dodgeHold` — the UNTIGHTENED radii sum, 1.35×. Widening only the
    HOLD makes it hysteresis, not a bigger trigger, and the two are separate
    functions for exactly that reason: **`MONSTER_DODGE_TIGHTEN` must never
    reach the hold.** It shrinks how EARLY you are turned — 0.425, the ring
    at r + 6.4 (maintainer 2026-09-05, with the overlay on: the outer ring
    "a bit too big", wanted between the body ring and where it sat — 0.85
    shipped, r + 12.75; and 2026-09-13, the same words on the spawn house's
    rabbits: "I feel the player starts to dodge the monster at the outer
    circle. I feel that is too far away from the monster. Can you place the
    outer radius between the current radius and the inner radius?" — halfway
    again) — and tightening the hold with it made the walker let go the
    moment it had stepped aside — the 2026-08-08 weave, caught by the dodge
    gate rather than by reasoning. The lookahead scales with it
    (`max(MONSTER_DODGE_LOOKAHEAD, personal + 20)`: 35.4 wu for a 9-wu body,
    41.75 before), so the turn also STARTS later, which is what he sees.
    `bodyStandoff` reads `dodgePersonal` too: the autopilot steers at a
    waypoint the dodge refuses to enter, and if the two disagree the walker
    orbits forever. The collision overlay draws `dodgePersonal` ITSELF, never
    a re-derivation. THE FIXTURES FOLLOW THE CONSTANT: the halving stopped 9
    dodge/pass fixtures from arising at all ("the fixture no longer blocks",
    "the pass never engaged") — bodies parked 40 wu ahead sat outside the
    new lookahead, and a 12-wu body no longer sealed a 1-cell doorway (the
    walker brushes through a soft body whose ring does not reach past the
    door's half-width). They are placed off `dodgePersonal` and the lookahead
    now (`AHEAD`, `INSIDE_PERSONAL` in wallhug/dodgepass), and the doorway
    blocker is an 18-wu body, the smallest that seals it at 0.425 (12, 14,
    16 let the walker through). Bodies are SOFT collision: brushing one is
    free, so the ring now turns you only when your line would cut into the
    body itself (its 6.4 is inside your own 9).
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
  - **THE VISIBLE READING CARRIES A HANDICAP** (`drawnBias`, `navbias.ts`,
    2026-09-10). candidates[0] is the surface actually DRAWN at the pixel; a
    hidden candidate must be `navUphill()` times SHORTER to displace it. The
    unweighted rule sent the maintainer round the back of an 8-level hill when
    the stairs were in front of him: "it was kinda obvious I wanted to run up
    the stairs right in front of me ... even if the path is shorter to the
    location behind the hill we might still navigate up the hill, that is more
    likely what the player wanted". The area behind a tall hill is large, so
    the shorter walk is usually the one he did not mean. Only the
    arrived-vs-arrived comparison is weighted: arriving still beats giving up
    short, and between two failing routes "how close did it get" is not a
    preference about which spot he meant. 1 = off. THE NUMBER IS HIS — a
    Settings slider, and **2.7 is his verdict** off it ("a good value for
    Uphill bias (tap) default is 2.7x", 2026-09-10); do not "restore" the 2
    it shipped with while he was still trying it.
  - **AND THE DEEPER BEHIND THE HILL, THE STRONGER** (`drawnExpo`, a second
    slider "Uphill bias expo (depth)", 2026-09-10). The handicap is
    `navUphill() * depth^(navExpo() - 1)`, where `depth` is how many cells
    UP-SCREEN of the drawn reading the hidden one sits — both are the same
    pixel, so that separation IS the hill between them (× the 0.9375 iso
    ratio). Taken from the candidate POSITIONS, never `goalLevel`, which is
    optional. It is `navUphill()` exactly at expo 1 whatever the depth, and
    exactly `navUphill()` at the hill's root whatever the expo (depth 1, and 1
    to any power is 1) — so tapping the root of an 8-level hill behaves as it
    always did while tapping its face is weighted hard. His words: "makes this
    effect more extreme if you try to navigate to a tile that is precisely
    covered by an 8 story tall hill VS ... the root of an 8 story tall hill".
    The slider stops at **1.0** on purpose ("this expo will be 1.0 or more so
    don't make it possible to have an expo less than 1.0"); MAX 4, and **1.1 is
    his verdict** ("the uphill bias expo should be 1.1 as default",
    2026-09-11) — a gentle lean, 12^0.1 = 1.28x twelve cells behind a hill and
    exactly the flat bias at its root. Gate:
    `server/test/beacon.test.ts`, a flat synthetic plane where the two lengths
    are the whole story.
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
- `centerOn` moves scrollX/Y at once, but `cam.worldView` only follows in the
  camera's preRender (render step). Screen-space work done in update() from
  `worldView` is one frame behind — use `renderedWorldView` (Night lighting).
- **`__ml.teleport(col, row)`** — drop the player at the exact coordinates
  shown under the avatar's name (`fx/CELL_WU, fy/CELL_WU`). Server-
  authoritative ("teleport" message clamps, sets `elev`, clears queued
  movement/jump); camera snaps. Lands where asked even off standable ground.
  Debug only.

- **THE DEEP-SEA CURRENT DRAGS YOU TO THE NEAREST MAIN LAND, NOT THE MAP
  CENTRE** (maintainer 2026-09-07). The centre was the first cut and it is
  wrong the moment the coast is not a circle: swum out from a western bay you
  were carried east along the shore instead of back onto the beach behind you.
  Direction now comes from a EUCLIDEAN feature transform (8SSEDT, two raster
  sweeps carrying the offset to the nearest source) over the STANDABLE cells of
  every land mass of at least `MAIN_LAND_MIN_CELLS` (64). Three traps paid for
  here: a 4-neighbour BFS answers in MANHATTAN distance and picks visibly the
  wrong coast (measured at cell 182,23 — its nearest was straight south while
  the closest land lay south-east); the offset is FROM the cell TO its source,
  so borrowing a neighbour's answer SHIFTS it by that neighbour's own offset
  and the obvious sign is backwards (the sea at 0,0 dragged away from land);
  and the shallows are sources of the DEPTH field — which is a distance-to-
  shore, and the STRENGTH ramp is tuned on it — but are not a place to be
  carried TO, so the direction field uses land only. the_game has a 55,651-cell
  mainland, five islands of 184-304 and one 18-cell rock: 64 keeps the islands
  and rules out the rock. Both fields are built by `warmDeepCurrent` at world
  load on BOTH sides — the first call costs ~65 ms on a dev host, and lazily
  that lands on the first player to swim out, in play.

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
    (jumps are cardinal). Gate: the bridge-climb trip in
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
