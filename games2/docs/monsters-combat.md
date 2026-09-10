# Monsters, combat, items, NPCs, death

The shared body pipeline, spawn zones, shadows, gait, the monster brain, escape math, loot, the backpack, levelling, death and NPC decor. Moved verbatim out of `games2/CLAUDE.md` (2026-09-09), which keeps the law and points here; the measurements, traps and rejected approaches live in this file. Rewrite in place under the root doc law.

- **THE GRAVE CROSS LOADS AT BOOT** (`GRAVE_CROSS_KEY`, queued in `preload()`
  beside the campfire). It used to fetch on the FIRST kill, so the first cross
  of every session waited on a round trip — and the dropped item's own texture
  queued BEHIND it on the same loader, which is how a slow cross becomes being
  ninjalooted (maintainer, 2026-09-07: "this being loaded and fast has with
  gameplay to do"). 16 frames of 34 px. `spawnGraveCross` keeps its lazy path
  as the fallback for a failed preload. Measured: the texture exists at join,
  before any kill.

## Monsters (client rendering = the SHARED body pipeline)

- **Spawn placement is MAPS2 DATA**: every world ships
  `maps2/worlds3/<name>/spawns.json` (`pixel-maps3/spawns@1`, spec
  `maps2/spec/SPAWNS.md`) — polygon zones `{id, monster, area, elev, num}`.
  The game's old hardcoded rectangles are DELETED. `shared/monsters.ts` does
  the pure geometry (`parseSpawns`/`pointInZone` even-odd/`zonePolygonCells` —
  a SCANLINE, byte-identical to testing every cell with `pointInZone`: the
  per-cell loop cost 3.1 s of server CPU on EVERY room creation for the_game
  and the_island2, stalling the sim for everyone already in the world; ~70 ms
  now; gate `server/test/zonefill.test.ts`);
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
- **Art-measured shadows + anchors, PER DIRECTION** (`measureWalkArt` decodes
  every WALK strip): the manifest emits per (state, direction) a `ground`
  contract `{f, cx, contact, sink}` plus per-frame `shift[]`/`air[]`. Five
  maintainer rounds of derivation — contact centroid, tail/tendril drops,
  mass-centre blend, body-class factors — are commented at their code in
  `scripts/build-monsters-manifest.mjs`; read them there, never re-derive.
  The laws that bind callers: NEVER one pooled anchor (strips differ per
  direction by up to 9px, hop gaits float, off-centre bodies leave the shadow
  beside the feet); `f`/`cx` are the CONTACT CENTROID, not the lowest opaque
  row (far feet stand up to ~16px higher than the near toe; `sink` = px the
  front toes plant below the anchor); the art is NEVER touched ("movement
  should be handled in the game and not in the animation") — `shift[]` cancels
  baked translation, `air[]` shrinks+fades the shadow on hops; the ellipse is
  ONE CONSTANT SIZE per monster (below), so no per-direction `ground[dir].w/h`
  fields exist to read; a paused monster parks on `contact` (frame-0 parking
  left frogs levitating).
  **Verify with the contact sheets before shipping any shadow change**: `node
  scripts/monster-contact-sheets.mjs [ids] [outDir]` renders every (monster,
  direction, frame) with the exact client shadow maths + a red anchor
  crosshair — offline, exhaustive, the maintainer's-eye view.
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
- Shadow size FALLBACK (nothing tuned): derived from the contact-run extent
  into `shadowW`/`shadowH`, NEVER frameW-scaled; collision `radius = min(60,
  0.45·shadowW)` — the FALLBACK only, a tuned shadow replaces it (above).
  `stripDims` (true per-strip size from IHDR) slices every sheet —
  monster.json `size` goes stale on in-place repairs and frames bleed.
  `hoverPx` marks INTENTIONAL winged flyers (butterfly_dragon 12): sprite
  lifts, shadow stays grounded and shrinks; everyone else is pinned. Probe:
  `__ml.monsterInfo()`.
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
- **THE GROUND PLANE — `projectCellCorner` IS THE ONE PROJECTION** for anything
  that describes the WORLD: cell diamonds, footprint ellipses, body circles,
  zone outlines. `projectFlat` answers a different question — where a BODY's
  feet are DRAWN, i.e. the diamond's centre plus the character ground anchor
  (+tile/2, +dy) — and feeding it ground coordinates has put an overlay off its
  own world TWICE: the spawn zones half a cell down (2026-07-30) and the
  collision overlay by a constant vertical term (2026-09-02 — the maintainer
  annotated a screenshot with the collision centre and the tile-top centre, the
  maps agent read the mechanism off it, and the two planes measure exactly
  **DY − TOP_Y = 4 px** at 1× on a maps3 world, 0 px horizontally, the same at
  four cells across the map). The ground plane is whichever renderer drew it: a
  maps3 world's tiles3 FRAME by construction (the same `anchorX`/`anchorY`
  every plate, boundary, deck and scenery sprite is placed through), a maps2
  world's lattice plus `TILE_DIAMOND_TOP`. The LEVEL is the caller's, because
  the overlays differ on purpose — the collision floor plan flattens every mark
  to the player's plane (a wall's marker must not fly up to the roof), a spawn
  zone traces the rim it sits on. **The 4 px left between the ground plane and
  `projectFlat` is the BODY-SEAT convention** (a character is drawn standing in
  the cell, not on its centre line): deliberate, and never to be "fixed" by
  moving the ground under every body. Probe: `__ml.planes(col,row)`; gate:
  `scripts/verify-collisionplane.mjs` (pins cornerVsArt == 0 AND that
  projectFlat still differs vertically-only by a constant, so neither half can
  drift back).
- **Zone DEBUG overlay** — Settings "spawn areas", OFF by default (maintainer)
  in `ml-spawn-areas`. Draws each zone's REAL polygon, lazy-fetched from
  spawns.json on first switch-on — NOT the synced bbox (zones are concave).
  Corners go through `projectZoneCorner` (which delegates to
  `projectCellCorner`), NOT `project()`/`projectFlat()` — see THE GROUND PLANE
  below. Probe: `__ml.spawnOverlay(on?)`.
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
- **"DISABLE AGGRO"** (Settings, first button, off by default, `ml-no-aggro`)
  — a testing switch so a cave can be walked and looked at. Enforced on the
  SERVER (the proximity scan runs there); the client re-sends it on every
  join. Deliberately NOT a schema field (a synced field per player for a debug
  flag); it is a `Set<pid>` on the room, carried in the hand-off's hot state
  and in the edge snapshot (`ghostNoAggro`), cleared in `onLeave`.
  **THE INVARIANT, once it is on: the only monster that may be hunting you is
  one you are MARKING RIGHT NOW.** The mark (`player.target`, a tap) is the
  one bypass — raising your sword IS the provocation — so everything that
  drops a mark also calls the hunt off (`clearMark` + `releaseHunts`, and
  `releaseHuntsNextDoor` for the neighbour rooms that hunt your ghost).
  Flipping it ON drops your own mark and releases EVERY hunt on you, provoked
  ones included; with the switch OFF a provoked hunt is the monster's own
  business and dropping the mark does not end it.
  - **THE MARK WAS THE LEAK** (2026-09-10). Both places that break off a fight
    — a ground tap and a nudge of the analog stick — cleared the client's
    `engagedId` and told the server NOTHING, though the comment beside each
    claimed they disengaged explicitly; the server keeps a mark across
    movement on purpose (the attack icon hangs over the target, approach-aggro
    reads it). So one tap, and the tap box is 26x48 px so often an accident,
    left that monster hunting through the switch for the rest of the session
    and the body auto-swung at it again whenever it came to rest in range.
    Measured on the_game's cave: the scan logged the bypass every 450 ms,
    indefinitely. Both callers go through `dropEngage()` now.
  Gates: `server/test/noaggro.test.ts` (an untouched predator, and a running
  hunt released) — each step on a FRESH predator, since a monster whose hunt
  just ended is `returning` and its scan is suppressed by design; and
  `server/test/combat.test.ts` "only a monster you are marking may hunt you"
  (the mark, the drop, the re-arm, and the switch-off case) on a `dbgmonster`
  PINNED predator, which is what lets one monster be re-marked repeatedly.

- **WATER IS A PLAYER SANCTUARY** (maintainer: "no monster can enter/go on
  water … the player can always use the water to escape/hide"). Every layer:
  buildZoneRuntimes never returns swim cells (canSwim always false — a
  pure-water zone polygon adopts its SHORE ring); monster roam/chase/orbit/
  separation and both monster startTrip sites route with canSwim false; a
  SWIMMING victim instantly disengages its hunter; swimmers can neither swing
  nor provoke (no water-sniping — cuts both ways). Players keep canSwim true.
- **MONSTER ART IS NEAR-FIRST** (`client/src/monsterBoot.ts`, rule
  `shared/monsterBootKinds`): the boot batch carries the walk+idle strips of
  only the kinds with a spawn zone within `MONSTER_BOOT_RADIUS_CELLS` (32,
  Chebyshev to the zone bbox) of the world's spawn OR of the cell the player
  last stood on in this world (`ml-lastpos:<world>`, written every 3 s —
  a returning player lands on their saved spot). Every other kind's strips
  queue in the deferred batch behind my urgent clips and the NPC idles, and
  a body whose kind is still deferred starts PARKED — culled, never the
  placeholder wanderer — until ITS strips land (per-kind FILE_COMPLETE
  count → `onMonsterArtLanded` registers the clips and releases the bodies;
  an errored strip releases on the batch's COMPLETE and degrades to the
  placeholder as before). No spawns.json / no zones / any fetch error → every
  kind at boot, the pre-split behaviour. (the_game names all 57 kinds; 912
  strips / 5.3 MB were half of a cold boot's 1,884 requests, and 20 kinds
  live within 32 cells of the spawn: measured 320 strips before the avatar
  is in, 146 monsters with 92 parked, released one kind at a time, 57/57
  clips at the end, zero visible placeholders across 116 samples. A monster
  roams only inside its zone and chases ≤ ESCAPE_RADIUS past it, so a
  deferred kind cannot reach the player before the batch lands.) Probes:
  `__ml.monsterBoot()` (boot/deferred/pending/clipKinds), `monsterInfo().
  artPending/spriteVisible`, `monsterGate().parkedInView` (a parked body in
  view is counted apart, never as a wrong cull). Gate:
  `server/test/monsterboot.test.ts` (definition, union of centres, the real
  partition on every world on disk).
- **Monster combat clips**: attack/angry/die strips (~525 files, ~3.1MB)
  background-load in the SAME deferred batch as the player's action states
  (boot stays walk+idle of the NEAR kinds — above). The COMPLETE handler re-runs
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
- **NOTHING MAY BLOCK THE REVIVE PRESS, AND THE ASK IS RETRIED.** Being dead
  outranks every dialog, so the dead branch in `pointerdown` is checked BEFORE
  the `uiLocked` guard and the JUMP key asks too — behind the guard, ANY stale
  lock (a dialog torn down without its onClosed) left "Press to continue..."
  on screen eating every tap until the 3-minute backstop (maintainer: "pressed
  all over the place but nothing happened"). And the ask is a STATE, re-sent
  every `REVIVE_RETRY_MS` until `selfDead` clears, not one fire-and-forget
  packet: it survives a refusal, a dropped patch and a socket that died
  without firing room.onLeave (the rejoin rewires `this.room` and the next
  retry lands). After `REVIVE_QUIET_MS` unanswered the card says
  "Reconnecting…" — silence is what made it read as a dead button. Gate:
  `scripts/verify-death.mjs` (revives THROUGH a forced `__ml.uiLock(true)`;
  verified non-vacuous — the old guard order fails it).
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

maps2 places people (`maps2/worlds3/<name>/npcs.json`, `pixel-maps2/npcs@1`,
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
