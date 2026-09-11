# Lighting, time, weather

The night shader and its CPU twins, the light slot ledger, scenery lights and shadows, depth fog, sun, time-of-day, weather, indoor ambient. Moved verbatim out of `games2/CLAUDE.md` (2026-09-09), which keeps the law and points here; the measurements, traps and rejected approaches live in this file. Rewrite in place under the root doc law.

- **TWO INDOOR AMBIENT DIALS — DARK ROOM 40%, LIT ROOM 12%**
  (`indoorlight.ts`, both in Settings). A room with no light of its own needs
  40% to read as stone rather than void; a room that lights ITSELF gets its
  brightness from its own hearth, and the base ambient only has to keep the far
  corners off black (maintainer 2026-09-07, walking into a house with a lit
  fireplace: "the old indoor ambient light at 40% is too much if we have lights
  inside the house"). `roomHasLight()` picks the dial: any real light — a
  scenery light or an emissive tile — whose cell is inside MY room mask
  (`indoorOutside`) counts, re-tested at most every `ROOM_LIT_MS` 400 ms, and
  the switch between the two rides the indoor grade's own ease so it never
  pops. Measured: the fireplace house resolves to [0.0995, 0.1041, 0.12], an
  unlit room to [0.342, 0.355, 0.400]. Probe `__ml.indoorLight(v?, "dark"|"lit")`
  reports both dials, `roomHasLight` and every drawn light with the room
  test's verdict on it. `roomHasLight` reads the DRAWN light set, so it can
  differ by camera window, never by the room. THE PHONE'S OWN NUMBERS come
  from the Settings button "indoor report" (one chat line: verdict, grade,
  mix, cell, elev, room key and size, mask cells and whether the mask
  texture is bound, cave depth at my cell, which ambient dial, torch and its
  day fade, the CPU twin's light at my feet, the slotted world lights) — for
  an indoor look the harness does not reproduce (2026-09-09, the cave at
  255,188 "different lit up depending on where I stand": identical at his
  geometry headless, both spots key 58573 / 884 cells / dark-room dial).

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
  roll. Exact JS twin `mistAt()` — change together. **A SHADER PASS WITH
  `setRenderToTexture` IS NEVER SKIPPED BY `setVisible(false)`**:
  `Shader.willRender` returns true unconditionally in that case. A pass is
  STOPPED only by taking it off the display list (`setPassRunning`, which mist
  and fog go through), and made cheap WHILE ON only by a uniform guard on the
  FIRST line of its own `main` — which is where DEPTHFOG_FRAG's `uFog` test has
  always been and where MIST_FRAG's `uMist` test now is; before that it sat
  after the 128-iteration surface march, so clear weather paid for the
  expensive part of a pass that then returned nothing. Full rule under Night
  lighting: "A PASS THAT IS 'OFF' MUST LEAVE THE DISPLAY LIST".
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
- STALE GATES, known: verify-solidband (predates maps2 worlds, fails on
  baseline; verify-wallspread went the same way and was replaced by
  verify-wallwash, which finds its wall on the_game); verify-penumbra is PINNED TO NIGHT and finds
  pre-existing base defects at some ledges (fails identically on the pre-sun
  baseline — candidate-placement sensitivity, needs its own follow-up).
  verify-glow-seams went with its glow_test world (2026-09-09).

## Night lighting (client/src/nightlight.ts)

- Always-night per-pixel shader: MULTIPLY overlay; per-pixel surface resolve
  (cell + height) → point lights with attenuation, LOS cast shadows, Lambert
  face gating with penumbras at both ends of every wall band.
- **THE WALL WASH IS PER PIXEL, AND ITS WRAP IS HIS DIAL** (maintainer
  2026-09-11, a torch beside a house wall at night: "the light doesn't travel
  very long along the wall", a hard seam at every tile edge along the lit
  wall, and the bottom course darker than the rest). Three laws, each pinned
  by `scripts/verify-wallwash.mjs` (BEFORE → AFTER on the 3-storey terrace at
  243..247/291, probe light 0.4 cells out):
  - The face Lambert gate's lateral distance is the light to THIS PIXEL's
    point on the face plane (`pos`), never to the cell's face segment
    (`clamp(lp, baseF, baseF+1)`): the per-cell form gave a whole tile one
    gate value, so the wash stepped a tile's worth of falloff at every edge
    (worst neighbour step 26% of the run's range → 6%).
  - The gate's exponent is `uWallWrap = max(0.02, 1 − wrap)` from the
    Settings dial "Wall light wrap" (`client/src/wallwrap.ts`, default 0.7 —
    the old hard-coded 0.45 exponent was "a bit too extreme"; 0 = a plain
    cosine, 1 = the light hugs the wall as far as it reaches on the ground).
    `front` keeps its own `smoothstep(0, 0.25)`; a light behind the plane
    never lights the face at any wrap. THE FLAME HAS A SIZE: the cosine is
    measured from no closer than `FLAME_HALF_CELLS` (0.5) in front of the
    plane — with the lateral per pixel, a point light pressed against a wall
    lit only the pixels straight in front of it and the wall behind a body
    touching it went black at wrap 0 (his first night with the dial: "2
    tiles under the player is lit up. The surrounding is completely dark").
    The per-cell lateral had hidden that by accident (lateral 0 for the
    whole cell behind the light). `scripts/nightshot.mjs COL= ROW= [WRAP=]
    [FOG=] OUT=` shoots any spot at night with the torch for a look.
  - The LOS march never reads the wall's own column for a sample inside the
    wall's FRONT SKIRT: `heightAtSoft`/`groundAtSoft` are bilinear, so a
    sample within half a cell in front of the face plane blended the wall's
    own height in and shadowed the bottom course from its own wall (foot/mid
    luma 0.59 on the tiles beside the light → 1.00). For face pixels the
    sample point is pushed to the half-cell line in front of the plane before
    the height reads; ground pixels are untouched.
  - The harness reads pattern 5 (raw field, opaque) at face points found by
    pattern 4 (faces red) — the TALLEST red run under the cell anchor, since
    the terrace behind paints a sliver of its own face just above the lip;
    depth fog off (it bands the field); the run's corners are excluded from
    the seam metric (the corner blend brightens the last 1/8 cell). Pattern 6
    paints `fract(pos.x)`, `fract(z)`, `gateFade` per face pixel for
    diagnosing the resolve. Absolute luma drifts run to run (the night
    ramp); every assertion is within-run. Reach is judged against the pool's
    own half-distance on flat ground, 0.29 r (r/3 is unmeetable).
- **THE SURFACE MARCH SKIPS WHOLE BLOCKS** (`blockMaxAt`, `uHBlock`, 2026-09-02).
  Every pixel of the night, mist and depth-fog passes resolves the ground
  under it by walking a ray from the WORLD's max level down, one cell boundary
  per iteration, with one dependent `heightAt` fetch per cell until the first
  column whose top reaches the segment. Under a 40-level world that is ~44
  fetches per pixel per pass on level-0 ground and ~8 on level-32 snow —
  measured 176-188 dependent fetches per device pixel per frame at the forest
  spots against ~119 on the snow, which is 1.8-2.9× a mid-range phone's whole
  30 fps fragment budget and exactly why the forest lagged worst (maintainer
  2026-09-02, running from the spawn into the autumn wood). `buildHeightmap`
  now also builds `world-heightmap-blockmax` (one texel per 8×8 cells, the
  max of `uHeight`'s R byte, same packing, NEAREST); the march fetches it when
  the ray enters a new block and, while `v0 + blockMax·kk < vLo`, skips the
  cell's fetch — ONLY the fetch: vLo, vMid, cr and the hit test are untouched,
  so z, cell and everything downstream are bit-identical (a cell is hit iff
  `v0 + H·kk ≥ vLo` and every H in the block is ≤ its max; both sides decode
  with the same expression, so the bound holds in float too). PROVEN on real
  pixels: `__ml.nightParity("night"|"fog")` renders a pass with the skip off
  and on back to back in ONE turn (no frame between — `load()`+`flush()`, the
  renderer's own render-to-texture path — so uAnimTime, the eased ambient and
  every light are the same uniforms for both) and hashes each; identical at
  four spots × Day/Evening/Night, 12 of 12. (A frame-to-frame comparison
  CANNOT prove this: the eased uniforms never exactly converge, so no two
  frames of the same variant hash equal — the trap the first bench fell
  into.) Armed only with its texture bound (`uSkip`; an unbound sampler reads
  unit 0 = the full heightmap and would make one cell's height a "block max").
  Three more byte-identical cuts landed with it: the prop sun-shadow loop is
  gated on `uHasProps` — 1 for placed props OR scenery shares, so it RUNS on
  the_game since 2026-09-05 (scenery sun shadows) but SPARSELY: `uPropGate`
  keys it on the ground map's G flag, set within 4 cells of any share
  (`setSceneryOccluders`), so the 8 steps × 2 fetches run on ~2% of the map
  and one texel-centre fetch elsewhere (identity, proven per turn by
  `__ml.nightParity("night","gate")`); `emitAt` is fetched only
  under `uEmitN > 0.5`; the glow field is cleared only when it has or had
  stamps and `uGlowOn` is 1 only when it has them (a clear of an empty field
  is a whole extra render pass on a tiler). NOT taken, on purpose: half-res
  depth fog (moves the cel band by ~0.67 art px — an approved look) and the
  three jittered sun marches (locked: "the shadow on cliffs looks perfect").
  The GLSL twin `groundCellAt` (cave gate only, a different channel) keeps
  the full walk. Frame meter for the phone: `?fps=1` (`fpsbadge.ts`).
- **DEPTH-FOG — cel-shaded EDGE-HIGHLIGHT fog** (`DEPTHFOG_FRAG`; job: make
  cliff EDGES readable — maintainer: "see the exact edge where the cliff
  starts"). A third, always-on NORMAL-blend overlay: a smooth horizontal
  DISTANCE channel (drape-reconstructed, so flat ground reads as clean
  concentric bands) plus a hard ELEVATION-EDGE channel taken from the MARCH'S
  OWN resolved fractional level — NOT `heightAt` (z drops the instant a pixel
  passes the lip, so the boundary lands ON the drawn cliff-top edge) —
  summed, then POSTERIZED into cel bands. Every tunable is a named, commented
  GLSL const atop DEPTHFOG_FRAG: read the meanings there, not here.
  **ELEV_D0 = 7** is the elevation DEAD-ZONE — no edge fog until the surface
  is 7 LEVELS from the player, so a house/roof stays clear and only real
  mountains fog (a house roof at level 6 sits just inside it). REJECTED:
  elevation-banded v1; then a TRUE 3D-distance SPHERE, which killed the zigzag
  AND, fatally, the edge contrast (its bands floated across terrain, never
  landing on an edge — maintainer: "makes it even harder to see the real
  edge"). Composited at **900_000.2** —
  above the multiply overlay, below the tap marker (900_000.5) and lit copies
  (900_001): fogs the WORLD, never the characters. Master strength
  `nightlight.fogStrength` (0 = instant rollback). Probe:
  `__ml.depthFog(strength?, testZ?, testCol?, testRow?)` (plants a virtual
  player headlessly); regression scripts/verify-depthfog.mjs.
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
  + solid objects + scenery footprints and drives ONLY the LOS march. A cell's LEVEL packs into
  one 8-bit channel as `level*hScale`, decoded `*255/uHScale`; **`hScale` is
  chosen PER WORLD** in `buildHeightmap` (16 for worlds ≤15 levels —
  byte-identical to history — smaller when taller). The old fixed *16
  SATURATED at 15.9 levels: the_island2 (peak 32) clamped every high cell and
  the depth-fog painted a hard seam across the flat peak. Regression:
  scripts/verify-heightscale.mjs (teleports to the level-32 peak).
- **Solid objects are ART, not walls**: they block light and cast a soft
  shadow but must NEVER get a wall-face band — modelling them as blocks
  painted knife-edged phantom shadows outside the drawn art.
- **SCENERY OCCLUDES LIKE A PROP** (`NightLights.setSceneryOccluders`): a maps3
  piece's collision footprint (`grid.footprints`) enters the SAME channels a
  grid prop did — linear R + an EQUAL G share, ground R — so the torch's LOS
  march and the sun's prop patch shade it with no shader change and R−G stays
  byte-exact (cliffs and depth fog untouched: fog hash identical on/off).
  Trunk = the footprint's cells at round(art px / 88) levels, clamped 1..3 (a
  tree 2, a stone 1) — the compact soft pool props cast. NO CANOPY DISC
  (built, measured, removed): a block of crown cells drew a DIAMOND LATTICE
  under every tree by day — the patch then skipped a pixel's own cell, so each
  cell of a block shaded as its own saw-tooth. THE OWN CELL IS A CONTACT
  SHADOW PLUS A DIRECTIONAL CORE (shader + twin, sun patch and torch march
  alike; `SCN_CONTACT_R` 0.75 cells, `SCN_CONTACT_SUN` 0.7, `SCN_CONTACT_TORCH`
  0.5, `SCN_CORE` 0.45): the own-cell sample skips stay (they keep the bump's
  bilinear skirt off the lit side of a root), a soft blob under the trunk
  shades the cell in EVERY direction, and the core test deepens it to the cast
  shadow's depth where the ray to the light passes through the trunk. Paid
  for in three cuts (maintainer, 2026-09-06): a uniform own-cell darkening
  (never ran on his phone — the switch below); the directional strip alone,
  which left the cell beside and in front of a post as bright spots against
  the skirt-shaded ground around it ("darker in corners like this"); and this.
  Measured, signpost: Day own cell cast side 0.66 = the cast shadow, sunny side 0.78 (was 1.00), ground outside the cell 1.00; Night torch the Night reading caught the phase change mid-flight; the torch case is the barrel; house barrel own cell cast side 0.43 (cast shadow 0.41), near side 0.56 (was 0.73), outside 0.84.
  The twin takes the contact only for GROUND samples (`groundContact`, the
  `__ml.lightAt` probe): a body brushing past a post keeps its tint. A
  canopy disc would still lattice under the sample skip; unbuilt, the
  maintainer's call.
  THE SWITCHES ARE PUSHED ON THE SHADER BEING BUILT (`setScenerySwitches(s)`
  in buildShader): pushed through `this.shader` before that field is assigned
  they landed on nothing, and `uSceneryOn`/`uPropGate` sat at 0 in play from
  the lighting commit until 2026-09-06 — every shader-side scenery rule inert
  while the CPU twin, gated on `hasSceneryShares`, read as if they worked.
  Measured: 0 at join with 1,267 share cells stamped, 1 after one push. A
  probe that toggles `__ml.sceneryShadows` re-pushes them and hides this. UNDER A CAP
  (a room under its roof, a cave under its ceiling, ground under a span) only
  the GROUND map takes the share: the linear column IS the cap, so growing it
  would raise the roof, and linear G is the sun's channel, which must not
  shade indoors. The point-light march already reads the ground map for a
  light under a cap (`lp.z <= H → hg`, shader and CPU twin alike), so the
  ground byte alone gives the torch its indoor shadows. (Skipping capped cells
  outright was the first cut — measured as a barrel beside the player casting
  nothing, behind/beside 1.19; with the ground share 0.82 in the house and
  0.65 / 0.91 / 0.89 in the cave. Maintainer, 2026-09-06.) A piece's own shares are excluded from
  its own lit-copy tint (`sceneryExclR2`, else every tree stood in its own
  shadow). Footprints land AFTER the heightmap is built, so `restampScenery`
  re-applies (idempotent). Measured the_game: 649 footprints, 4-19 ms + two
  1 MB uploads; a flicker-free light 3.5 cells from a tree reads 0.13 behind
  it vs 0.32 beside (off: 0.32 both); the tree's own copy tint identical on/off;
  the fog pass on/off differs by 0 bytes and the night pass only inside a
  share's own pool (`__ml.nightSnap`/`nightDiff`; an elevated piece 26 cells
  away still projects into the view — screen for that before calling a spot
  "scenery-free"). A/B: `__ml.sceneryShadows(on, gate?)`. The GROUND MAP's
  two spare channels carry the scenery side: B = the cell's scenery share
  alone (levels, R's packing) and G = the sparse sun-patch flag. B is what
  `groundTerrAt` subtracts in the cave-mouth walk (a trunk on a cliff-top
  cell must not extend that column over the mouth) and what arms the
  OWN-CELL SKIRT SKIP: the bump's bilinear skirt reaches a cell out, so the
  tread under a 0.5-cell trunk darkened 21% on the torch side — a pixel whose
  cell carries a share now skips LOS samples within one cell of that cell's
  centre (`ownShare`, twin in `lightAt`). THE LIGHT'S OWN CELL IS SKIPPED
  THE SAME WAY (`lShare`,
  twin `lShare`): a fire IS its piece, and a share taller than the light
  (a lamp post's 2 levels vs a light at head height) would block its own
  pool from the samples that land in its cell. By construction — the cave
  braziers' fires sit above their 1-level share (own ring identical on/off);
  town emitters after: the one real town emitter, a bonfire at 443.5,364.5 with no share in its own cell, reads its pool 0.92x with shadows on - a uniform 8% from its OWN multi-cell footprint, outside the own-cell skip; a per-light exclusion radius needs a uniform slot (open). Trunk position is cell-quantised (one texel per cell): up
  to 0.5 cell from the drawn trunk, and the day pool keeps the patch's 0.35-
  cell tiers — both inherited from the approved prop look.
- **SCENERY IS LIT PER PIXEL** (`scenerylit.ts` pipeline + `scenerylight.ts`
  shape maps; maintainer 2026-09-05: walking around a tree with the torch must
  light different parts of it). The lit copy keeps the flat tint for the
  AMBIENT side (sun/sky/AO/glow — the twin's `LightParts.base`) and the
  pipeline adds the POINT LIGHTS per texel against a pseudo-volume: an
  ellipse hitbox = a surface of revolution whose radius is the alpha
  silhouette's per-row half-width, a rect = a box turned by the facing with a
  lid; encoded RGBA8 (R N.x, G N.z, B depth toward the viewer, A 255 — data
  never rides alpha, Phaser premultiplies) under a content key
  `s3n:<path>@v<n>:<hitbox,scale>`, never rewritten, built in ROW SLICES
  within a 3 ms frame budget (a 256² willow was an 18-26 ms hitch when built
  whole). hflip is the same map read mirrored (N.x negated), pinned by
  `server/test/scenerylight.test.ts`. SMOOTHNESS: the radius is triple-box
  smoothed over ±h/19 rows and differentiated over ±S rows, clamp-to-edge
  padded below the art (a short-window derivative striped every crown:
  adjacent-row Δnz 0.40-0.49 measured; now ≤0.03). LIGHT MODEL, measured on
  the real trees: attenuation per texel with height weighted `SHAPE_ZW_ATT`
  0.15 (the ground's 0.6 put crowns past the torch radius — whole trees at
  22% of the flat tint); the Lambert direction is the HORIZONTAL vector from
  the piece's AXIS to the light (per texel it degenerates with the torch
  under the crown, and any vertical weight puts a ground torch straight
  below the crown's front — a crown could never be lit); wrap 0.75, gain
  1.25 → side torch 0.75×, in front 1.25×, behind 0.4× the flat copy, the
  near third ≥2× the far third from every side. Sun: soft Lambert on the full
  normal against an elevated sun (sin 1.2·slope), never brighter than flat.
  All 12 ledger slots' LOS occlusions ride the vertex (7 attributes / 7
  varyings, no per-object uniforms — a uniform per sprite is a flush per
  sprite); the fog silhouettes take the same pipeline (tintEffect 1, exact)
  so the lit band never ping-pongs pipelines; flicker is folded into the
  light colour on the CPU once per light per frame from the SAME clock as
  `uAnimTime` (`lightAt` reads `scene.time.now` too now — it used to lag by
  the boot). While a map is pending the copy takes the ambient-only tint, so
  the landing ADDS light (the flat→shaded drop was −33..−53% in one frame).
  Knobs live: `__ml.sceneryLight(on, {shade, debug, wrap, sunLam, gain})`;
  gates `__ml.sceneryLightBox(needle)` (alpha-masked luma thirds/bands),
  `sceneryLightInfo()`, `sceneryLightShape(needle,x,y)`. Phone GPU cost of
  the per-texel copies and the sparse sun patch is UNMEASURED (SwiftShader
  is no proxy) — `?fps=1` at the town, Night and Day, is the owed number.
- **DON'T MARCH A SHADOW NOBODY CAN SEE** (`SHADOW_MARCH_MIN_LIGHT` 0.012,
  nightlight.ts, shader and CPU twin alike): a light skips its 12-sample
  shadow march where its OWN CONTRIBUTION (att × peak channel) falls below
  that. A march can remove at most 78% of a contribution (the 0.22 bounce
  floor), so the deepest shadow it can hide is 0.009 luma, under 3/255.
  Threshold on the CONTRIBUTION, not on att: a campfire at 1.9 and a lamp at
  0.5 reach it at different distances (att alone at 0.06 can hide 0.09 luma of
  a bright light — half the night's ambient). It earns its keep now that the
  manifest publishes radius-11 streetlights: such a pool is wider than the
  phone's viewport, so every fragment on screen would otherwise march every
  light in it; this drops the outer 8-12% of each radius, 15-21% of its area.
  Measured at that lamp (skip radius 9.87 cells): no step in the luma profile
  there — the largest step, 0.627, is a shadow edge at 3.0 cells.
- **SCENERY SHADOWS READ NOW — GEOMETRY, NOT DARKNESS, WAS THE PROBLEM.** A
  shadow lands at `d × h_blocker / (h_light − h_blocker)` beyond the blocker,
  so the spawn campfire (flame LOW, radius 7, pieces taller than it) throws
  long hard shadows across a bright pool, while a radius-4 lamp with its head
  at 1.5 levels threw its shadow into the pool's dim tail or past its edge —
  the maintainer saw "only the bonfire" doing it (2026-09-07). Measured at the
  town's radius-11 lamp with a piece 2.4 cells away: the ground behind it now
  sits at 0.46-0.60 of unshadowed across 2-4.8 cells. Bigger published radii
  are what put the shadow back inside the lit area, so a lamp's radius is a
  LOOK knob, not just a reach knob.

- **A PASS THAT IS "OFF" MUST LEAVE THE DISPLAY LIST** (`setPassRunning` in
  nightlight.ts). `setVisible(false)` does NOT stop a render-to-texture Shader:
  Phaser's `willRender` returns true for one unconditionally
  (`gameobjects/shader/Shader.js`), so an "off" pass still dispatches a
  full-canvas fragment program every frame, and each dispatch also breaks the
  batch — the renderer flushes and rebinds the pipeline around it, which the
  cheap-shader case pays for in full. Weather was Clear sky in all ten windows
  of both beacon runs, so the mist pass ran 9,534 times to write vec4(0).
  `removeFromDisplayList()` is the only thing that stops it; `addToDisplayList()`
  brings it back. Coming back on, the shader can sit AFTER the overlay in the
  list, so the overlay may sample one frame of stale field — mist and fog both
  ramp from zero over seconds, so that frame is zero either way.
- **AND WRITE ITS STRENGTH UNIFORM UNCONDITIONALLY** (`uMist`, `uFog`) — the
  belt to that braces, covering any frame a pass is on the list with a stale
  strength. Both used to be written ONLY inside their "is it on" branch, so once
  mist (or fog) had ever been on, the last value written stayed > 0.001 and was
  never written again: the full 128-iteration surface march ran over every one
  of his 1,514,916 fragments, every frame, forever, painting into a texture
  nobody composites. Entering a house during mist latches it, and so does the
  snap to 0. The picture is identical either way — the shader already returns
  vec4(0) for exactly those fragments — so this is free. Any future pass with an
  early-out uniform gets BOTH treatments: the guard is only as good as the last
  write, and the last write is only as good as not running at all.

- **THE LIGHT PASSES RENDER AT HALF RESOLUTION** (`LIGHT_SCALE_DEFAULT` 0.5,
  lightscale.ts), tuned by the "Light resolution" slider. It is the fraction of
  the canvas the three full-screen passes render at before a LINEAR upsample, so
  cost is its SQUARE — 50% is a quarter of the fragments, which is why the
  readout names the pixel count and not just the percent. THE PHONE IS
  FRAGMENT-BOUND, measured: two beacon runs on one build, cooled between, 100%
  vs 50% moved fps 43.4 -> 48.7 (+12%), frame p90 34.4 -> 28.0 ms and p99 73.8
  -> 47.6 ms, while CPU work per frame stayed flat (-3%) and idle per frame fell
  27%. Unchanged CPU + shorter frames + less idle is what GPU-limited looks
  like; it is the one lever that moved this device. The maintainer could not see
  50% at all and first saw 25%, so the default sits a full step above what he
  can detect. The travel is GEOMETRIC (40 steps of ~10% each, floor 2%) because
  the thing being hunted is a ratio and linear travel buries it in the bottom
  fifth of the track. `?light=` still sets it, but AN INSTALLED PWA HAS NO URL BAR, and
  the only person who tests this game plays from his Android home screen: a dev
  A/B that exists solely as a query parameter is unreachable, so every knob gets
  a slider. nightlight.ts rebuilds all three render targets on "ml-light-scale",
  the same path as a resize, so it takes effect without a reload.
- **AN OVERLAY'S RT-TO-CANVAS RATIO MUST SURVIVE update()** (`upX`/`upY`).
  buildShader sizes each overlay by `full / rt`, and update() then rewrites all
  three scales every frame for zoom and the field window — it used to write
  `invZoom * k` flat, dropping the ratio, so at any scale below 1 the field drew
  at 1:1 as a LIT RECTANGLE in the middle of an unshaded screen. `?light=` had
  been broken this way for its whole life and nobody saw it, because nobody
  could reach it. Any per-frame write to a property a build step also sets has
  to carry the build step's factor.
- **THE GLOW FIELD IS HALF-RESOLUTION** (`GLOW_FIELD_DIV` 2, nightlight.ts).
  The shader samples `uGlow` NORMALIZED over uCam's window and the stamps are
  placed by that same mapping (`gscale`, derived from `rt.width`), so the RT's
  size is free and only the stamps' own resolution follows — and they are soft
  radial blobs, the one thing half resolution costs nothing on. It is cleared
  and redrawn every frame the stamps move, and a draw bracket pays its area
  about three times (explicit clear, the capture target's auto-clear, the
  blit): 1.52 Mpix a bracket at his 1079x1404 field, a quarter of that now.
  Do not "restore" it to canvas size — the field is a blur, not art.

- **A CAVE MOUTH IS NOT A WALL FACE**: `Ha` is max(terrain, deck), so pixels
  under a roof slab classified as FACE and took face Lambert + face shadow —
  painting the open entrance like glass (maintainer: "some sort of mirror or
  force-field"). A face now also requires solid GROUND above the pixel
  (`groundAt(cell) − z > 0.05`); the uTest-4 calibration branch carries the
  same condition or the gates measure a rule that doesn't ship. Real walls
  untouched (their ground top IS their surface).

- **A `lit` SCENERY PLACEMENT IS A LIGHT — THE MANIFEST'S `light` BLOCK WINS,
  THE PIXELS ARE THE FALLBACK** (`client/src/scenery3.ts` `parseLight`/
  `lightBlockFor`, `client/src/scenerylights.ts`, `pushSceneryLight` in
  rebuildScenery). Scenery publishes `light: {strength, color, radius,
  states: {LIT_n: {...}}}` in every lit piece's `scenery.json` (500 of 706
  pieces; `lights` — plural — is the old LIGHTS_ON flag): strength 0..1
  relative to the spawn campfire (1.0, radius 7; 0 is no light), colour hex,
  radius in cells. The maintainer tunes that table from the wiki, so the game
  reads it as given: for a placement in state S, `states[S]` else the piece
  block; radius as given — **NO CAP** (maintainer 2026-09-07: the campfire's 7
  "is a normal light, not even near what will be the max in the game"; the
  scenery table decides, a big radius costs a world slot from further away,
  `spec/LIGHT_BUDGET.md`); colour as given; intensity = strength × the
  campfire's peak 1.9 (strength 1 IS a campfire, maps2/scenery contract
  2026-09-06 — a pixel-derived 4.5 cap made his "twice the radius" edits
  change nothing in-game). Steady, no
  flicker (deferred by the maintainer: a type will be published beside
  strength later — wire it then, don't invent one). Flame-like ids
  (light|lamp|lantern|torch|brazier|fire|candle|beacon|hearth|forge) flicker
  when they have no manifest block; EVERY scenery light CASTS SHADOWS
  (maintainer 2026-09-07: "I was expecting all spotlights to work this way …
  they should all be able to make other scenery cast shadows"). Shadow-free
  glow pools stay the tile-emission default, not a scenery one. The pixels still place the light: those
  that DIFFER between the LIT frame and its NOT_LIT sibling (same canvas —
  PixelLab relights the same object), or without a sibling the bright
  saturated ones, give the centroid = the lamp's HEAD (z 0.3..1.5 levels above
  the anchor — the pool attenuates on the 3D distance, and a head 4 levels up
  left the ground under a streetlight near the radius' edge, measured); a
  block with no bright pixels sits 1 level up. A piece WITHOUT a block keeps
  the full derivation (mean colour, radius 2 + √area/8 capped 4.5, flame
  flicker 0.5 / pulse 0.15) — the older, un-tuned pieces.
  Sources join the props' ledger under `s3:<place>` — the same 8 world slots,
  the same overflow (a ground-pool stamp under the same id, suppressed while
  slotted, `sceneryStamps`), the same `sealed` room test. Derived once per
  LIT texture (`sceneryLightCache`); a piece whose art has not landed lights
  on the next rebuild, with its sprite. Measured at the town's lamp row by
  Night, torch dark: 5 streetlights in view, all slotted, each at its
  manifest's radius (4, one 5) and colour (`#ffc47d` → 0.95/0.73/0.47);
  ground 1 cell from the nearest lamp 0.63 luma vs 0.30 at 4.5 cells — half
  the campfire, exactly the table's strength 0.5; brightness is now the
  maintainer's column, not ours.
- **EVERY WORLD LIGHT IS A REAL LIGHT — THE LIGHT SLOT LEDGER** (maintainer:
  "NO DIFFERENCE in how bright the bonfire is vs the campfire"; measured
  parity 0.95). The sources are the scenery lights (`sceneryLightSources`,
  above; the tiles2 emissive props and `buildEmissiveSources` were retired
  2026-09-09) and `pickWorldLights()` fills THE LEDGER: 12 slots = 1 my
  torch + 1 ambient agent + 2 future fx + **8 world**, reservations STRICT,
  never lent. Write-side APIs: `client/src/lightslots.ts`; the slot table,
  placement rule and derived-default formula are in
  `games2/spec/LIGHT_BUDGET.md` (whose `LIGHT_HYST_PX` hysteresis predates
  tenure — this file wins). A slotted source's ground-pool STAMP is suppressed while it
  holds the slot (both feed `lightAt` — keeping them double-brightens ground
  AND characters); losing the slot returns the pool = the OVERFLOW FALLBACK,
  so an over-budget spot degrades to "stamp-only while visible" — a look,
  never an event. The laws:
  - **Remote players' torches are NEVER lights** ("a player can only ever see
    its own torch") — 8 world slots would starve on a torch-bearing street.
    `torchLit(id)` is gone; only `this.torchOn` matters.
  - **Derived defaults are CAMPFIRE-ANCHORED, and RADIUS — not intensity — is
    the lever** (maintainer on glow_test: "IT'S FILLED WITH LIGHT SOURCES —
    HOW CAN THIS MAP STILL BE DARK?"; the autopsy: radius 3.5 was smaller than
    the inter-source spacing, and radius moves the field 21.5× alone vs
    intensity's 5.7×). REJECTED: full-campfire-for-everyone (99.1% of the
    screen over field 1.0 = wall-to-wall clamp plateau).
  - Derived defaults are **SHADOW-FREE GLOW POOLS (negative radius)**: a prop
    OCCLUDES ITS OWN CELL, so a shadowed light was eaten by its own prop
    before reaching the body beside it. A curated entry opting back into
    `shadows` must put its z ABOVE the prop's +1 occluder (bonfire z 1.1).
  - **Shadow-free pools are EXEMPT from the face Lambert gate** (`isFace &&
    uLightPos[i].w > 0.0`): a glowing CUBE's own pool sits inside its cell
    behind both face planes, so every glowing block's faces were pitch dark. A
    pool is ambience, not a lamp a face can turn away from. Positive-radius
    lights (torch, campfire, curated bonfire) keep the gate — the approved
    wall look.
  - **A SEALED-ROOM fire is INDOOR-ONLY** — lit to the degree I am in its room
    (`indoorMix`), never from outside: the LOS march's 0.22 bounce floor
    otherwise pours 22% through house walls at night and its halo stamped an
    orange blob on the roof. The same floor is ROOM-GATED from inside (× the
    shader's `inRoom`; CPU twin alike) — or the hearth lit the street and the
    neighbour's roof through the walls while you stood at it (INDOOR.md). `sealed` is probed per source at the 4-NEIGHBOURS
    via `roomVerdictAt` (the prop's own cell is blocked and never in the roof
    set); a fire under a BRIDGE stays unsealed; stamps take the same gate
    (`sealedEmissiveCells`). The indoor ROOM FILTER applies to emissive lights
    exactly as to the torch.
  - **Slots are held by TENURE, not re-ranked** (per-frame closest-first
    popped lights mid-screen) **and RETIRED under pressure, never held
    forever**: a holder keeps its slot until its pool stops touching the view
    (release needs `LIGHT_EXIT_PX` past the boundary, acquisition requires
    actually touching — entry strictly tighter, so a boundary hoverer can't
    flicker); newcomers take only FREE slots, nearest first, ramping in over
    `LIGHT_RAMP_MS` (450) while their pool stamp crossfades out; a candidate
    beating a fully-settled holder by `LIGHT_STEAL_MARGIN` (200px) dissolves
    the worst holder out, at most `LIGHT_RETIRE_MAX` (2) at once — all four
    defined with their reasoning in WorldScene.ts. (Gate
    `verify-lighttenure.mjs` and the `check-light-budget.mjs` ratchet went
    with their tiles2 worlds, 2026-09-09; a scenery-light budget gate over
    the_game is owed. TRAPS for whoever writes it: the first lookAt is a
    camera TELEPORT that legitimately dumps spawn-side holders — settle
    before the baseline — and fairness numbers are captured AFTER the frame's
    decisions.)
  - The QA `probeLight` consumes a WORLD slot while set — slot-counting gates
    must expect ≤7 world holders. Probes: `__ml.lightSlots()` (live ledger +
    overflow), `__ml.lightAt()` (CPU twin), `__ml.torch(on?)`. Gate:
    `scripts/verify-lightparity.mjs` (parity, indoor, budget invariants).
- **Tile self-emission is RETIRED** (2026-09-09, with `tiles2/emission.json`
  and its `rebuildProps` halos): `NightLights` still takes an `EmissionMap`
  and the scene passes an empty one; scenery lights carry every glow stamp
  (`sceneryStamps`). glow/night QA happens at the_game's town by Night.
- The light/mist/depth-fog overlay quads BLEED ~1% past every screen edge
  (spanScale = 1.02; overlays drawn at invZoom*k while uCam spans k× the
  view — the stretches cancel, world→screen mapping EXACT): without it,
  fractional zoom left the quad a sub-pixel short and high-DPR phones showed
  a 1px unshaded line at night. TEST PATTERNS (nightCal ≥3) render with k=1
  (raw-field readbacks treat canvas pixels as texels 1:1; the stretch
  resamples rows into phantom seams).
- **uCam IS THIS FRAME'S RECTANGLE, NEVER `cam.worldView`**
  (`renderedWorldView`, client/src/camview.ts). Phaser recomputes `worldView`
  only in the camera's own preRender, during render — after update(). Read in
  update() it is LAST frame's, and every night-pass pixel (torch pools, sun
  shadows, fog bands) then trails the sprites by one frame of camera motion
  (measured: a strip of lit ground between a running scenery block and its
  shadow, tight at rest — maintainer, 2026-09-06). The helper mirrors
  Camera.preRender from the live scroll (floor on roundPixels, bounds clamp,
  rounded view); the glow field and the mist/depth-fog shaders take the same
  camX/camY, so they stay aligned with it. Padded cull boxes may keep reading
  `worldView`; anything pixel-exact placed in update() may not.
- Debug: `__ml.nightCal(flip,span,test)` (field test patterns — headless
  only; the old [6]-[9] keys are retired); `__ml.probeLight(col,row,z,
  radius)`; `__ml.lookAt(col,row)`; `__ml.wallWrap(v?)`. Numeric probes:
  verify-wallwash, verify-solidband, verify-penumbra, verify-timecycle,
  verify-lit-order.
  Run them against a dev stack before touching the shader.

## Windows

- **A WINDOW GLOWS BY THE ROOM'S BRIGHTNESS, NEVER ON/OFF** (`windowGlow`,
  WorldScene). The LIGHTS_ON overlay's alpha is a floor plus a fade: the floor
  is the room's indoor ambient — the dark-room dial (40%) for a room with no
  light of its own, the lit-room dial (12%) for one that lights itself — and
  the room's lit scenery fades the rest of the way up (peak x squared falloff,
  summed at the cell inside the wall, squashed between `WINDOW_GLOW_LO` 0.1
  and `_HI` 0.7), all scaled by the night factor (0 by day). **Every body in
  the room is a torch** (`WINDOW_TORCH_R` 6 cells, peak 1, re-read every 150
  ms): a player walking up to a window from inside brightens it for whoever is
  outside. (Maintainer 2026-09-09: "The plan was not to go binary dark
  window/lit window ... fade between them based on the brightness inside ...
  houses without a light source [get] more ambient light ... I run up to a
  window with my TORCH. It would be so cool if a player outside can see that
  brightness being reflected in the window.") Remote torches own no light
  slot; the window is a sum, not the light field. Probe:
  `__ml.windowGlowDebug(place)` → floor, sources, bodies with distance, glow.
