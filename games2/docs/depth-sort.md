# Depth sort and occluders

How bodies and pieces interleave with terrain columns: the occluder set, the pure depth rule and its cover lines — and the DEPTH PATH that replaces the occluder set with a per-pixel test. Moved verbatim out of `games2/CLAUDE.md` (2026-09-09), which keeps the law and points here; the measurements, traps and rejected approaches live in this file. Rewrite in place under the root doc law.

- **THE RENDER RETAKE — `?occ=depth` (remembered as `ml-occ-path`; flipped
  live by `__ml.occDepth(on)`; rollback point = branch `render-retake-start`
  at 7b73e316).** The maintainer's last beacon run put 95 of 140 long frames
  on `rebuildOccluders` (`tiles3Occluders` alone 80% of a 50-60 ms rebuild
  every 96 px), so instead of slicing that loop the occluder SPRITES are
  deleted: the ground texture already paints every column, and a body only
  has to not draw where a nearer column would have covered it.
  `client/src/terraindepth.ts` is a MultiPipeline whose fragment resolves the
  terrain surface under the pixel with the night shader's `terrainResolve`
  (cut out of nightlight.ts by `resolveGlslChunk()` between the
  `//@resolve` markers — ONE resolve, lighting and occlusion can never
  disagree) and discards the pixel when that surface is nearer. Every body
  layer (`resolveBodyDepth`, `syncLitCopy`, `placeBodyShadow`,
  `syncCoverOutline`) and every standing scenery piece (base image through
  the depth pipeline, lit copy + fog through the scenery-lit pipeline, which
  carries the same test on its eighth attribute) is armed with
  `pipelineData.td` = (flatY/lh, 1/lh, floor level, mode, own col+row).
  - The test is 3-D: the pixel at world y is `zPx = max((flatY − y)/lh,
    floor)` above the ground; the ray through it (v = v0 + z·kk) meets the
    resolved surface at height z; hidden when z > zPx (nearer). The FLOOR
    clamp keeps the 4 px body seat from being eaten by the body's own ground.
  - ONLY A NEARER DIAGONAL HIDES (col + row > the caller's own): a column
    beside the body is what the painter drew behind it (equal depth, body
    created later), and a body's feet do overlap the columns beside its cell.
  - A DECK TOP (H > base, roof/bridge/lid) hides a body standing BELOW it
    wherever the ray meets that top, whatever the pixel's height — the
    painter clamps such a body behind the slab; without this a head walking
    under the river bridge showed through the planks.
  - Mode 1 (draw the visible part) is armed only when the cover rule set
    `coverY` — the per-pixel walk costs on covered sprites alone; mode 2
    (draw the HIDDEN part) is the hidden-behind outline on the plain ring
    texture. `occluderMeta` is still built (it feeds `resolveDrawDepth`, the
    painter order among bodies/pieces/debris and the campfire crop); the
    cover atlases, cover index and `occImage` are skipped.
  - Textures on units 1-4 (scenery-lit: 2-5) via `addTextureToBatch`; scalar
    `uMainSampler` (Mobile-style boot); world coordinates PER VERTEX (camera
    matrix inverse), never gl_FragCoord.
  - MEASURED DIFFERENCES vs the sprite path (`scripts/verify-render-retake.mjs`,
    frozen frame, same session, % changed + mean/max + worst block + on-body
    split; images with OUT=): bodies behind the house wall, under the bridge,
    at the cave mouth and the forest: identical silhouettes (on-body means
    1-8 of 255, mostly the lit copy's tint rounding). Terrain itself differs
    by design — 12-28% of a frame at mean 15-25 — because the occluder copies
    re-pasted raw face/cap art over the ground texture's COMPOSED faces (the
    fades and foot bands the ground pass paints were covered on every raised
    column); the depth path shows the ground texture as composed.
    KNOWN LOSSES: the hidden outline behind SCENERY (a tree) is gone — the
    test knows terrain, not pieces; a body seen through the GAP under a
    floating bridge is hidden (the resolve treats a deck column as solid to
    the ground). Both are the maintainer's call before the sprite path goes.
  - Ground truth for the resolve itself: `scripts/verify-terraindepth.mjs`
    (calibration 7 paints floor(cell) as bytes; `__ml.occTopAt` is the
    painter): 77.5% exact, 7.1% neighbour cell (art overhang), 0.3% two or
    more cells off, 15% where the painter had no image (flat ground).

- **SEE-THROUGH WALLS IS DELETED — never reintroduce a per-frame occluder
  alpha sweep.** The prototype ([7] key, "see-through walls" switch,
  `occFade`/`occFocus`/`occApply` probes) swept the whole live occluder set
  per frame (getData + setDepth + setAlpha over 3.9k images; every setDepth
  re-queues Phaser's display-list sort) — **1.33 ms/frame while the feature
  was OFF**, and it never looked good. Replaced by INDOOR MODE (decides per
  CELL) + the WHITE OCCLUSION OUTLINE (one image per covered body). The
  `"ot"`/`"od"` occluder tags went with it; `tagOccluder` stamps the cell
  only. History in git.
- **Occluder view-cull + deck exposure** (`rebuildOccluders` rebuilds the set
  when the camera drifts `OCC_STEP` = 96px — pooled, see THE OCCLUDER SET IS
  POOLED below):
  - Deck cells get the exposed-face rule via `deckCoverFrom`, comparing BANDS
    (a slab covers `[level-thickness, level]`; only a CONTIGUOUS run reaching
    my own bottom hides my faces). Without it every face level of every deck
    cell drew — the old island's 16-32-level cave decks were ~65% of the mountain
    window's images.
  - Each face/top image is skipped unless it lands in the camera view grown by
    `OCC_CULL_PAD` (a rebuild step + a tile + the widest body art box).
  - **Do NOT make `stackFrom` deck-aware** — deck-blind ON PURPOSE. Deck cover
    is a band, not a prefix; a naive deck-aware variant cuts 4,748 terrain
    faces on the_island2 that nothing covers. Over-drawing under a deck is the
    safe direction and costs 0 faces on shipped worlds.
  - Why culling is safe: occluders never contribute terrain pixels (the ground
    RT at depth −1,000,000 paints all of it); they exist so bodies can
    interleave, so over-culling can only mis-sort, never leave a hole. The
    real invariant is `occluderMeta` (one record per CELL, never culled — what
    `resolveBodyDepth` reads for depth/`coverY`): **a meta record overlapping
    the view must still have drawn art behind it**. Hence the TOP image is
    kept whenever the whole COLUMN reaches the cull box (`columnShows`) —
    per-tile culling left 94 uncovered columns.
  - Probe `__ml.occAudit()` checks against Phaser's own `getBounds()` and the
    camera's `worldView` (never the cull arithmetic): `metaWithoutArt` must be
    0 (solid scenery meta excluded — it never has an occluder image).
    Measured: 13,521 → 3,885 images at the mountain; `coverY` under every
    thick cave slab bit-identical to pre-cull. Gate: the occluder block of
    `verify-smoke.mjs` at the_game's spawn, standing and walking.

- **A TALL WALL THE CALLER STANDS BEHIND COVERS IT — DEPTH AND COPY**
  (`wallBehind` in `resolveDrawDepth`): the column the stand rule refuses to
  lift over registers as a COVER exactly like the ray test (depth clamped
  below it, `coverY` at its top line). Refusing the lift alone kept the base
  sprite under the wall but never cut the LIT COPY, which draws in the lit
  band above every occluder and is cropped only by a cover line — a tree
  behind a house kept its trunk over the house's left wall through its copy
  (copy cover 10872 from the front wall's ray test; the left wall's top at
  10786 never registered; maintainer, 2026-09-06). Measured after: the copy's cover line moved from 10872 (the front wall) to 10786 (the left wall's top): the trunk is cut behind the left wall, the canopy above it stays; all five overlapping wall cells draw over the base sprite.
- **`faceOverFeet` IS A TERRAIN RULE** (`!o.solid`): the ledge rule (a raised
  cell's lifted top face in the feet band) fired for a solid point piece — a
  short crystal 10 px in front and 11 px to the side of a player cropped his
  whole lit copy below its top line, the hidden-behind outline over his body
  (cave, maintainer 2026-09-06). A billboard answers through `solidArtOver`,
  which checks the feet's x against the piece. Measured after: pod spot: body 10245.9 over the pod's 10245.7, feet still under the rock stub in front (cover 10217); crystal spot: the cover line comes from the rock stub (10343), no longer from the crystal (10325), body 10371.9 above both crystals.
- **ONLY WHAT STANDS OVER THE CALLER MAY CROP IT** (`DepthCtx.cx0/cx1`, the
  COVER COLUMN). A lit copy is cropped at ONE flat screen line, so the window
  that may set that line is the caller's own column, not its whole art box:
  scenery passes its FOOTPRINT span (a tree's canopy is ~170 px across while
  its trunk stands on one cell), bodies keep the art box. With the canopy as
  the window a cliff step two cells TO THE SIDE set the line, and a step run
  shares one `y0` (it is constant in col+row and level), so a whole stand of
  trees cropped on the SAME horizontal line — the sharp seams the maintainer
  saw across the back-of-the-mountain treeline, lit copy above, dark base
  sprite below, at Night AND Morning. The DEPTH decision still counts the whole
  art box: a piece in front must still push this one back.
  `wallBehind` additionally requires the wall to be camera-NEARER
  (`o.col + o.row >= colf + rowf`) — "behind" is the name of the rule, but the
  diagonal slack alone also accepted a wall LEVEL with or one diagonal BEHIND
  the caller, which handed it a crop line it does not stand behind at all.
  NOTE the return contract that changed with this: `coverY` and `below` no
  longer move together, so the result keys on `coverY` itself — returning the
  untouched Infinity would hand consumers an infinite crop line, which every
  `=== undefined` test reads as "covered".
  STILL OPEN: where a cover line is legitimate the seam remains, because the
  two sides are shaded by different pipelines (base = the night pass per screen
  pixel; copy = one `lightAt` sample + scenerylit's per-texel volume). BODIES
  already solved this with the pixel-exact cover surfaces (`registerCoverSlot`
  / `flushCoverSurfaces`, "it also kills the dark band the flat line left
  across visible legs"); scenery is still on the flat line and wants the same
  treatment.

- **THE HIDDEN-BEHIND OUTLINE HAS A STRENGTH DIAL** (`hiddenring.ts`, Settings
  "Hidden outline", default 60%). The line draws ABOVE the darkness overlay, so
  at full opacity a body behind a wall is the most legible thing on screen and
  being hidden reads as an ADVANTAGE (maintainer 2026-09-07: "see the objects
  behind the wall, not see them way better when behind the wall"). Separate
  knob from `RING_LIGHT_FLOOR`, which decides how far the ring tracks the light
  at the body's own spot: that one keeps the line from going black after
  sunset, this one decides how loud it is at all. THE 60% IS A FIRST DIM, NOT A
  VERDICT — he asked for the slider so he can pick the real default by eye.
  Probe `__ml.hiddenRing(v?)`.

- **A CALLER NEVER LIFTS MORE THAN 2.5 CELLS PAST ITS OWN ANCHOR**
  (`LIFT_MAX_PX` 35, `depthrule.ts`). The lift exists so the flat tile IN FRONT
  OF THE FEET — one diagonal, dy px — cannot draw over them; it is a one-cell
  job. But `above` takes the MAX over every occluder the ART BOX overlaps, and
  a WIDE piece overlaps ground tiles three and four diagonals forward.
  MEASURED on the_game: 54 treeline pieces lift a median 14.8 px (1.06 cells),
  at most 28.8; the cave's dragon ribcage, 97 px wide, lifts 55.9 px — FOUR
  cells. Lifted to 10245.70 it outranked not just the player but the rock stubs
  at 10232 that stand a cell IN FRONT of it, so the cave floor sorted behind it
  too and any body those stubs clamped went behind it with them. THIS is why
  the maintainer kept landing behind that ribcage from four different tiles
  while each cover-side fix only moved which tiles did it. 35 px clears every
  piece measured and cuts the outlier.
- **A LEDGE COVERS ONLY WHAT IT STANDS OVER — `feetInColumn` in
  `depthrule.ts`**: the ledge rule (`faceOverFeet`) additionally requires the
  caller's FEET X to lie in the occluder's screen column (±6), exactly as
  `solidArtOver` has always asked of a billboard. Without it a one-level rock
  stub whose 64 px column merely GRAZED the edge of the 41 px art box counted
  as covering: it clamped the body to its own depth − 0.15, and because the
  scenery beside it draws LIFTED (a dragon ribcage anchored at 10189.79 draws
  at 10245.70, over the ground tiles in front of it), the body landed at
  10231.85 — behind a piece it was standing in front of, wearing the
  hidden-behind outline. Reported three times from three positions in one cave
  room (maintainer, 2026-09-06 and twice 2026-09-07); the stub decides it from
  21 px away, which is why it read as "depends a bit on where I stand".
  MEASURED, all three positions, in `server/test/depthrule.test.ts` against
  occluder records dumped from the running game: 10245.85 (in front) with the
  rule, 10231.85 (behind) without it.
  (REJECTED on the way: quantising `fwd` to the caller's own cell diagonal so a
  stub BESIDE him cannot claim the front. It fixed one of the three positions,
  left the other two broken, and dropped covers everywhere else in the world
  for nothing. The lateral test is the whole fix; `fwd` keeps its +1.2 slack.)
- **THE DEPTH RULE IS A PURE FUNCTION — `client/src/depthrule.ts`**, and
  `WorldScene.resolveDrawDepth` only feeds it (art box, occluder list,
  geometry). The cave sort broke three times and each round the only check was
  a probe that needed the world to finish loading — flaky, and twice it
  measured an empty scene and said "fixed". `server/test/depthrule.test.ts`
  now replays REAL occluder records measured at the maintainer's spot, so the
  rule is testable without a browser. TWO traps this caught, both of which had
  already shipped: the old body clamp read a bare `self`, which in a browser is
  `window` — always truthy, so bodies had silently been clamping at a piece's
  −0.3; and a fixture that RECONSTRUCTS the projection instead of measuring it
  is worthless — the first one used half the real screen-x step, so the art box
  never reached the occluder that causes the bug and the test passed against
  known-broken code. Dump the records (scratch `fx/cave3.mjs`), never derive
  them, and prove a new fixture FAILS without the fix before trusting it.
- **AMONG WHAT ONE WALL CLAMPS, A BODY SITS A HAIR ABOVE A PIECE** (the
  `below` clamp: −0.15 for a body, −0.3 for a piece): a cave's one-level rock
  stub in front of both a player and the pod behind him clamped both to the
  same depth, and the tie went to creation order — the pod drew over the
  player it stood behind (maintainer, 2026-09-06). A body behind a piece is
  still clamped under that piece's own draw depth through `solidArtOver`.
- **A NON-SOLID COLUMN LIFTS THE CALLER UNLESS IT RISES TWO OR MORE LEVELS
  ABOVE THE CALLER, IS NOT STANDABLE AT THE CALLER'S LEVEL, AND THE CALLER IS
  NOT CAMERA-FORWARD OF IT** (`resolveDrawDepth`, `occluderMeta.stand`).
  tiles3 columns say what level they are standable at (a ground cell its
  level, a deck plate its level, a wall −1). A room's floor and a terrace's
  plates lift a piece standing on them unconditionally (the flat tile in
  front of the feet); a tall wall it stands behind — off its diagonal, where
  the ray test cannot see it — does not: the blanket lift drew a tree standing
  BEHIND a house over the house's front wall (lifted from its 10861.8 anchor
  line to 10918.6, a wall cell's front edge four cells in front). One-level
  columns always lift: a room's interior walls are cut to height 1 indoors,
  and one-level ledges have their own cover rules (`faceOverFeet`). A meta
  without `stand` keeps the unconditional lift. Measured after: house 10 roofed pieces drawn; the 4 beds whose bottom a one-level stub in front covers are the same pieces at the same depths with the rule stashed; cave 5 pieces under one-level stubs, identical pieces and depths with and without the rule; the tree stays at its own line (10875.8) under both overlapping wall cells (10946, 10960); the sign paints over the player behind it (11631.6 vs 11619.9) and under the player in front (11647.9).
  THE RECORD ON THE FIRST GATE (2026-09-06): keyed on `top` alone, it was
  blamed for a room's furniture vanishing and reverted within the hour. The
  empty house was maps2's cave-gate commit dropping the furniture from the
  world (restored in 8b1833249f); and the "4 of 10 pieces under the floor" it
  was then measured with are the SAME 4 with no gate at all — beds whose
  bottom 15 px a one-level wall stub one row in front covers through the
  `below` clamp (depth = stub − 0.3), pre-existing and physically right. The
  gate was innocent. Scenery's `lvl` is the placement's base level; no
  the_game piece stands on a deck above base, so a bridge piece is untested.
