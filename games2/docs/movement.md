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
  the base level put a lid-walker back INSIDE the cave. KNOWN GAP: a piece
  placed ON a deck reads the base under it (none in the_game). Gate: the
  floor test in `server/test/footprint.test.ts`.
- **THE RESCUE NEVER CLIMBS** (`unstickFromSolids` with the body's elevation):
  a push that would step more than a walk can climb, or drop, onto a cell
  with no deck at the body's level is refused — a cupboard against a wall
  points its footprint's gradient into the wall, and the rescue followed it
  onto the level-6 wall ring where `resolveElevAt` stood the body on the
  wall top (the inn's corner cell 306,226, 2026-09-09; the indoor gate found
  itself outdoors on a rooftop). Callers without an elevation keep the old
  rescue. Gate: the climb test in `server/test/footprint.test.ts`; the
  indoor scenery gate stands on the room's FREEST cell for the same reason.
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
  - **AND THE FLINCH'S GOT-HIT FRAME LANDS WITH THE FEET** (`fallhurt.ts`).
    The hit is the server's and its patch arrives a round trip after impact,
    so a clip triggered by `hitSeq` starts on the ground and plays its wind-up
    there. The client runs the server's own rule (≥6 levels, a swimmable
    landing is a free dive) against its PREDICTED fall and starts the clip
    early by exactly the frames before the got-hit frame — **the 4th**, index
    3, the doubled-over pose with the impact mark (maintainer named it) — at
    `FALL_HURT_RATE` 1.5× the combat rate: a 125 ms lead over a 208 ms clip,
    three frames of bracing in the air and the fold on the ground. Combat's
    `ANIM_FPS.hurt` is untouched (round 7 is his). It is ONLY the clip: hp,
    blood and the damage float stay the server's word, so a missed prediction
    costs a flinch nobody was charged for and never a wrong number. The
    server's hit does not restart a running fall flinch — that hit IS its
    landing. The arm is cancelled by a fall that ends early or a teleport.
  - Gates: `server/test/falldamage.test.ts` (curve pins; the route law
    verified failing on the pre-fix baseline; live-room cliff + dive, and the
    cliff arm asserts hp is UNTOUCHED at the edge and billed 0.5–1× the fall
    clock later — measured 822 ms on an 8-level ledge against a 775 ms
    clock); `collision.test.ts` holds `fallDurationS` to within one frame of
    the drawn descent at six drop heights, and pins the flinch arithmetic —
    the 4th frame is the frame on screen at touchdown, the frame before it is
    still the wind-up, and the clip outlasts its own lead.
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
the cell (`BOUNDARY_STEP`), and an exact cell centre stays the cell (strict
`>`), so every `(c + 0.5) * CELL_WU` per-cell query is unchanged. A pure cell
is unchanged byte for byte; level and deck stay per cell. Full server suite:
the same 24 pre-existing fixture failures before and after, nothing added.

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
    reach the hold.** It shrinks how EARLY you are turned (0.85 — maintainer
    2026-09-05, with the overlay on: the outer ring "a bit too big", wanted
    between the body ring and where it sat), and tightening the hold with it
    made the walker let go the moment it had stepped aside — the 2026-08-08
    weave, caught by the dodge gate rather than by reasoning. `bodyStandoff`
    reads `dodgePersonal` too: the autopilot steers at a waypoint the dodge
    refuses to enter, and if the two disagree the walker orbits forever. The
    collision overlay draws `dodgePersonal` ITSELF, never a re-derivation.
    HALFWAY (0.5) IS STILL WANTED and is not shipped: it stops 9 dodge/pass
    fixtures from arising at all ("the fixture no longer blocks", "the pass
    never engaged"), so it needs those bodies re-placed against the new
    clearance first — not a constant change.
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
