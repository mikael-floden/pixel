# Performance: ground streaming, repaints, the beacon

The ground render texture (scroll, slices, cell repaints, prefetch, compose budget), the pooled occluders, the capture pool, and how the perf beacon is read. Moved verbatim out of `games2/CLAUDE.md` (2026-09-09), which keeps the law and points here; the measurements, traps and rejected approaches live in this file. Rewrite in place under the root doc law.

- **REJECTED 2026-09-12: replacing the occluder sprites with a per-pixel
  depth test** (the render retake, `docs/depth-sort.md`) — GPU-bound on his
  phone, 4.5x the lag frames. The CPU bursts the beacon's worst frames name
  on the sprite path are the targets instead, proved by the Settings "burst
  test" switch (skips them all: 38/51 → 3/2 frames over 50 ms per window,
  p90 19 ms): the full-paint-per-drain loop (done: THE DROP DRAIN REPAINTS
  CELLS below; cliffs 38 → 11, cave 51 → 17), `rebuildOccluders` 50-133 ms
  every 96 px (done: THE WALK IS INCREMENTAL below), `repaintCells` 112 ms
  and transition composing 105 ms in one frame (the 2 ms budget bypassed —
  next), an `avatarLoop` spike of 159 ms.
- **THE OCCLUDER SET IS POOLED, NOT REBUILT** (`occImage`, `destroyBatch`,
  2026-09-02). A rebuild used to destroy every image and create every image,
  and 90-95% of what it created was bit-identical to what it had just
  destroyed (measured: 1,489 of 1,649 after a 99 px step at the forest).
  Two costs, both now gone: Phaser's `destroy()` takes an object off the
  display list by SCANNING it (`exists()` = indexOf, then `remove()` =
  indexOf + splice; 3.90 GameObject.removeFromDisplayList), so destroying
  ~5,400 occluders in a ~5,900-object list was QUADRATIC — 39 ms of pure JS;
  creating them again was 43 ms. `destroyBatch` filters the display list ONCE
  against a Set and only then destroys (each object finds itself absent and
  skips the scan); `occImage` keys an image on everything that makes it what
  it is — `col,row,tex,x,y,depth` (col/row included: two cells at different
  levels CAN share a screen point) — takes it back out of the pool untouched,
  and the rebuild destroys only what left the window. Measured per rebuild,
  legacy → pooled: snow cliffs 88 → 19 ms (×4.6), snow shore 87 → 21 ms,
  autumn wood 28 → 12 ms, forest 24 → 15 ms — with the pooled set and its
  painter order IDENTICAL to the legacy set at all four (`__ml.occDump()`
  lists every occluder in (depth, list position) order; the A/B is
  `__ml.occRebuild("legacy"|"bulk"|"pool")`, one build, same camera).
  THE LAW THAT MAKES REUSE SAFE: Phaser's depth sort is STABLE, and a
  column's faces and cap share one depth (`oDepth = by + dy`) and stack only
  because they were inserted bottom-up, cap last — so once images outlive a
  rebuild, insertion order is gone and EVERY image a rebuild places gets
  depth = base + slot × `OCC_DEPTH_EPS` (1e-6), where the slot is STATED, not
  counted: a terrain image's slot is its cell's place on its diagonal
  (`u mod 128` × 40 + the cell's own creation order; a 24-storey column is
  ~30 images, and two cells 128 diagonals apart never overlap) and scenery
  starts past every terrain slot (`OCC_SEQ_SCENERY`) so a piece on a wall
  top still draws over the wall — the incremental walk creates cells in any
  order, so a running count would have put a newly entered cell over an
  older neighbour on the same diagonal. Tops out at ~0.006 — far inside the
  ≥0.3 every body and light keeps from a column (`resolveBodyDepth` +0.5 /
  above+0.6 / below−0.3; lights +0.1). `emissiveLights` and the cover index
  are still rebuilt in full every time: data, and the cover index's
  staleness contract is unchanged. **The epsilon is a BASE-band quantity: nothing that
  goes through `litDepth` (×1e-5) takes it** — lit copies are never pooled
  and keep their creation order, and 1e-6 in the lit band is 0.1 world px
  per index (review caught scenery lit copies 165-540 px in front of the
  bodies before them). A pooled image the scene has destroyed
  (`scene` gone) is dropped, never reused; anything a throw strands in the
  pool is drained at the next rebuild. The pool holds TEXTURE OBJECTS across
  rebuilds, so tiles3's `limit: 0` cache must stay unbounded, or an eviction
  must clear the pool too.
- **THE WALK IS INCREMENTAL TOO** (`rebuildOccluders` full vs step,
  `tiles3Occluders(..., only)`, 2026-09-12). The pool kept the IMAGES; the
  walk that decided them still visited every cell of the window — ~2,700 on
  his phone — every 96 px, and it was the largest burst left after the drain
  (50-133 ms frames, `rebuildOccluders` 1.1-1.5 ms/frame mean while moving).
  A step now walks only the cells that ENTERED the window, the kept cells
  whose images the moving cull box refused last time (`partial`), and the
  kept cells the texture factory could not fully serve (`incomplete`: its
  own plate or course missing, or a boundary, fade, deck course or dress
  refused — every refusal moves one of `droppedOps`, `plateRawFallbacks`,
  `stats.missing`, `stats.deferred`, and the walk reads them before and
  after each cell). Cells that LEFT take their images and per-cell meta
  bucket (`occMetaByCell`) with them; nothing else is touched, and the flat
  `occluders`/`occluderMeta` views are rebuilt from the buckets after every
  step. A terrain landing and a raised boundary repair set `occRelanded`,
  which walks the incomplete cells alone from wherever the camera stands
  (both used to poison the latch: a FULL rebuild per batch, 200-300 batches a
  window while running, rate-limited to 400 ms for the repair). The full
  walk remains for the first set, a poisoned latch (teleport, manifest
  settle, `repaintWorld`) and any indoor change (the cut mask rewrites every
  column). Measured headless, spawn area, 10 run trips each: the walk 2.85 ms
  avg / 9.2 max per step → 0.26 avg / 3.8 max (~80-100 cells walked per step
  of ~1,900), and the incremental set IDENTICAL to a fresh full walk at every
  check — same images, same depths, same meta — except kept cells' images the
  cull box would now refuse, which stay (harmless: a few extra sprites, never
  a missing one). `scripts/verify-occinc.mjs` is that check (`__ml.occInc()`
  counters and A/B — `occInc(false)` walks the window every step;
  `__ml.occIncCheck()` steps to the exact camera, then compares against a
  full walk). NOT time-slicing the full walk across frames (stash of
  2026-09-12: a generator with a staged swap — the set is stale for the
  frames it takes, lit copies were lost at one spot, and it still does all
  the work). The scenery rebuild (`rebuildScenery`, ~1.6-1.9 ms avg, 64 ms
  max headless) and the cover index still run in full every step — next if
  his run still names them.
- **STREAMING REPAINTS ARE COALESCED** (`requestRepaint`, 2026-09-02). While
  a window's art streams in, three things used to run a FULL synchronous
  repaint — the terrain batch landing (`Tiles3Loader.onBatch`), the scenery
  batch landing (its own `once("complete")` on the SAME Phaser loader, so one
  batch fired both), and the scenery manifest settle — each redrawing the
  whole ground RT (41-52 ms) and every occluder. Measured over a 24 s walk
  with art landing: 8 of 11 occluder rebuilds and 8 of 8 ground redraws were
  that, not camera movement. Now a landing MARKS what it dirtied and
  `update()` poisons the matching latch at most once per frame: a terrain
  batch needs the ground and a re-walk of the occluder cells the last walk
  left INCOMPLETE (its plates were holes, its faces skipped — `occRelanded`,
  never the whole window); a scenery batch or manifest needs the occluder
  rebuild ONLY — scenery rides inside it; the terrain occluders come back out
  of the pool, while the scenery images and lit copies are rebuilt in full
  (not pooled). The
  explicit `repaintWorld()` callers (the indoor cut, landed hitbox docs) stay
  synchronous — state changes whose callers may read the result on the same
  frame — and clear the pending flags, so a landing beside a state change
  costs one pass, not two. The boot hold will not release with a repaint
  pending (`hold.repaintPending` in `__ml.tiles3()`). Measured: the pass
  lands in the SAME step the loader would have repainted in (Phaser emits
  COMPLETE from a browser task between steps; the flags drain at the top of
  update()), so the visible frame is identical to legacy — the deferral is
  zero frames. Probe: `__ml.repaints(coalesce?)` (landings by kind vs passes
  run; the switch reproduces legacy for an A/B).
- **THE GROUND PASS CULLS OFF-TEXTURE DRAWS** (`t3Blit`, 2026-09-02). The
  pass walks a window padded by a tile on each side and by the whole level
  range below, and issued every op of every cell whether or not its
  rectangle reached the render texture — 31-55% of a redraw's draws landed
  entirely outside it (forest 1,739 of 3,892; autumn wood 6,873 of 12,520;
  snow cliffs 3,915 of 12,542 — mostly the deck face stacks, which rise
  360-480 px above their cell). The RT clipped them to nothing at the cost
  of a batchDraw each. `t3Blit` now skips an op whose rectangle misses
  `[0,rt.width) × [0,rt.height)` before the texture lookup — pixel-identical
  by construction, and PROVEN on the pixels: `__ml.groundHash()` hashes the
  RT's readback and matched exactly between modes at all four spots. Measured
  per redraw, legacy → culled: autumn wood 48.7 → 40.1 ms, snow cliffs
  37.6 → 32.4, snow shore 38.3 → 31.4, forest ×1.17 — i.e. the draw calls
  were only ~20% of the pass's JS; the RESOLVER (what each cell draws:
  `cellBlits`/`opsFor*` through `t3Try`, boundary composition) is the rest.
  A/B: `__ml.groundRedraw(cull?)` (the pass's counters + whole-redraw wall
  clock; `culled` is counted beside `blits`, which counts attempts).
- **THE TERRAIN RESOLUTION IS CACHED PER CELL** (`t3resolve`, 2026-09-02).
  `t3.cell` / `t3.boundary` / `t3.decks` are pure functions of static
  per-world data (view, frame, fills, deck map) — nothing in a session changes
  their answer — yet the ground pass AND the occluder pass each re-ran them for
  every cell of the window on every rebuild: ~4,267 cells per ground redraw,
  ~82% of them resolved by the redraw before (a 256 px step exposes ~18% of
  the texture), and the same cells again for the occluders every 96 px.
  Measured after the draw cull, the resolver was the larger share of the
  redraw. Both passes now read one Map keyed by cell index; the OPS built
  from a resolution (`cellBlits`, `opsFor*`) are NOT cached — they depend on
  which art is resident and on the indoor cut, and are cheap beside the
  resolve. Each member memoises LAZILY on its own (a void cell never pays for
  a boundary, a cut column never for decks — and with the cache off the calls
  are exactly the old ones, which keeps the A/B honest). Failures cache as
  the same null/[] `t3Try` answered (warned once). BOUNDED: pruned to the
  last ground window after every ground redraw (the occluder window lies
  inside it) — ~4,267 entries, a few MB, never the world (~576 B per entry
  measured; the whole map would be 75-145 MB on a phone); cleared when a
  new resolver is built.
  Measured per ground redraw with the cull on, cache off → on (medians,
  same camera; the off arm is exactly the old calls): forest 29.0 → 10.1 ms,
  autumn wood 44.1 → 14.9, snow cliffs 28.9 → 15.4, snow shore 32.8 → 13.3 —
  pixel-identical (`__ml.groundHash` parity) and the occluder SET identical
  (`__ml.occDump`, cache off vs on) at all four spots. The first redraw
  after a teleport still resolves every cell; the wins are the walking
  redraws, whose cells are ~82% already known. A/B: `__ml.groundRedraw(cull?, cache?)` (both switches restored
  after the forced redraw; `cached` = entries held).
- **The ground SCROLLS (#6).** A camera-latched redraw no longer repaints the
  whole texture: the kept picture is copied into a second render texture
  shifted by the anchor delta (`drawFrame(key, "__BASE", -sx, -sy)`; the two
  swap roles) and only the newly exposed L-shaped band is painted, through
  the SAME painter pass clipped to the band (`groundClip`: an op crossing the
  band edge is cropped to an integer sub-rect at scale 1, so band pixels see
  exactly the full paint's sequence). Pixel-identical: `__ml.groundHash()` /
  `__ml.groundSnap()` after a scroll equal a forced full paint at the same
  anchor (8 of 8 moves at four spots, `scripts/_tmp-scrollab.mjs`). Measured
  on the_game: a 576 px step issues 2,876-3,966 blits instead of 5,949-8,843
  (the band window still resolves and culls, so JS cost falls ~40-60%, not
  ~80%). Only a camera latch scrolls — a poisoned latch (repaintWorld, a
  landed batch, a resize, the indoor mask/cut, the first `caveDepth`, a
  CONTEXT RESTORE OR TAB-IN) paints in full, so the kept picture and the band
  can never disagree on state.
  **A TAB-IN POISONS THE LATCH (`hookContextRestore`).** The ground RT is a
  framebuffer: its pixels exist only as previously-rendered output, so a GPU
  that reclaims them while the app is backgrounded hands back a blank texture
  while every ordinary sprite re-uploads and survives — scenery, monsters and
  the player over an empty world, photographed 2026-09-05. Nothing repaired
  it: `redrawGround` returns early until the camera strays GROUND_MARGIN/2,
  and a tab-in moves the camera not at all. The scroll made walking SPREAD the
  damage rather than heal it — the first latch crossing scrolls the empty
  picture forward and paints only the exposed slice, leaving a correct strip
  at the leading edge with the void dragged behind it (his second photograph);
  before the scroll every latch crossing was a full paint and it healed within
  256 px. Hooked on BOTH `visibilitychange`→visible and
  `Phaser.Renderer.Events.RESTORE_WEBGL` (the latter fires only when the
  browser reports a real loss, and mobile discards contents without one; a
  tab-in that also resizes was already covered by `makeGroundRT`). Never hook
  `webglcontextrestored` on the canvas — Phaser's own handler rebuilds the
  texture and framebuffer wrappers first and emits RESTORE_WEBGL after it.
  The cover atlases and the glow RT need no equivalent: both are redrawn every
  frame. Cost is one full paint per tab-in. The beacon reports `ctxRestores`
  per window — SwiftShader restores RT contents, so the harness cannot
  reproduce the loss and only his phone can confirm it fires.
  After a scroll `t3stats` counts the BANDS (cells/culled with the corner
  twice); the boot hold reads the sticky `groundPainted` instead of blits.
  Three Phaser 3.90 traps this paid for, each a wrong picture, none an error:
  - `DynamicTexture.fill(rgb, a, x, y, w, h)` with a rect is NOT texel-exact
    on a texture larger than the canvas — it keeps the renderer's projection,
    scales the rect by canvas/texture and floors it (3 px seam measured at
    412/1436). Only the whole-texture fill is exact: fill all, then copy.
  - `Texture.add()` makes the FIRST added frame the texture's default
    (`get(undefined)` answers `firstFrame` once `frameTotal > 1`), so a bare-key
    draw (`add.image(x, y, key)`, `batchDraw(key)`) shows that sub-rect. Every
    frame add here resets `firstFrame = "__BASE"` and the ground pass draws
    `"__BASE"` explicitly; `Texture.get(name)` of a MISSING name returns the
    base frame with a warning, never null — test with `has()` first.
  - A `saveTexture`d render texture outlives its game object (`destroy()`
    skips the texture): drop it through `textures.remove(key)` or every
    resize leaks two viewport-sized GL targets.
- **Landings repaint only their cells, and art is asked for AHEAD (#8).** The
  ground pass used to request a cell's art the moment the cell entered the
  texture window, and every landed batch poisoned the latch — running into
  fresh ground was request → land → FULL paint every ~256 px, whatever the
  scroll saved. Now: (1) the pass records which window cell wanted each
  missing file (`t3missing`; rebuilt by a full paint, extended by clipped
  ones); `Tiles3Loader.onBatch(paths)` names what landed; `onTerrainBatch`
  maps it to cells and `repaintTiles3Cells` repaints just their rectangle
  (each cell's 64-wide column from the world's top storey down past its base)
  through the SAME clipped pass the scroll's bands use, after resetting the
  rect with a 1x1 texture of the exact background colour stamped to size
  (NEAREST: every texel that colour; not `fill`, see the scroll's traps). A
  landing no window cell wanted paints nothing; a landing whose cells span
  more than half the texture paints in full. Pixel-identical: 12 of 12 cell
  repaints over a fresh full paint hash equal (`__ml.groundCellsRepaint`,
  `scripts/_tmp-cellsparity.mjs`). (2) THE PREFETCH RING: every ground
  redraw queues the cells of the window grown by `GROUND_RING` (512 px) on
  every side, minus the window's own; `t3prefetchStep` resolves
  `GROUND_RING_STEP` (150) of them per frame through the cached resolvers
  and asks the loader for their art — only once the loading hold released
  (`worldUp`; the hold counts terrain requests). Flushed PER SLICE and only
  while nothing is in flight: Phaser's loader merges files added mid-cycle
  into the running cycle and fires one complete for all, so a ring flush on
  top of a pass-owned batch would delay the landing the player is looking
  at; small ring batches one at a time bound the merge the other way. The
  resolution cache keeps the grown window. A pattern-sheet landing (the
  composer's own dependency, wanted by no cell) is always a full paint. A
  tombstoned (404) path is never recorded as missing (it never lands). Measured on the north run from
  spawn (30 cell steps): 17 landings → 1 ground paint (the join's) and 0
  cell repaints — every later landing arrived for cells still outside the
  texture — vs 9 landings → 8 full paints (18-78 ms each) before. A cell
  repaint, when one is needed, is 4-19 ms for 1-12 cells (the rect is a
  full-height column band). Dev A/B:
  `__ml.groundPartial(on)`, `__ml.groundPrefetch(on)`; `__ml.groundScroll()`
  reports the cell-repaint counters and the ring's queue.
- **THE GROUND BACKGROUND IS FILLED WITH A ONE-TEXEL OVERSCAN** (`fillGround`).
  `DynamicTexture.fill(rgb, a)` with no rect does NOT cover the texture's last
  row — it converts the rect into the renderer's projection and the round trip
  lands a hair short (measured at the maintainer's geometry: `fully
  TRANSPARENT rows: [H-1]`, `fully TRANSPARENT cols: []` — VERTICAL ONLY).
  That row was the "straight horizontal lines" (maintainer 2026-09-03). It is
  born 512 px below the view, but the SCROLL copies the kept picture up by the
  anchor delta, so it lands at H-1-sy — an interior row the exposed band
  (H-sy…H-1) never repaints — where the fill under it shows as a full-width
  0x181c28 line, carried forward opaque from then on. One per southward latch,
  two or three riding up a ~780 px view at a 256 px step, which is what he
  photographed. Fixed by filling `(-1, -1, W+2, H+2)`: over-covering a WHOLE-
  texture background fill is free (it can only paint background where
  background belongs, and the viewport clips the rest) — the exact opposite of
  a BAND fill, which must be texel-exact and for that reason does not exist.
- **THE BAND IS PAINTED IN SLICES, AND THE RING COMPOSES AHEAD (#9).** The
  scroll made the ground redraw cheaper but left it a SPIKE: measured with a
  per-frame hitch recorder on a held-key straight run into fresh terrain
  (`scripts/_tmp-hitchrun.mjs`, `__ml.hitch(true)` then `__ml.hitch()`), one
  frame in every ~1.5 s carried 60-98 ms of JS — the ~256 px latch at run
  speed (GROUND_MARGIN/2 over ~175 px per second) — of which 33-44 ms was
  COMPOSING 66-98 brand-new boundary/plate textures (a canvas blend plus a GPU
  upload each, ~0.45 ms here and 2-4 ms on a phone). That one frame IS the
  freeze the maintainer felt all day; every earlier win reduced average cost
  and left the spike standing.
  Two changes remove it: (1) the exposed band is QUEUED, not painted — the
  texture reaches GROUND_MARGIN (512 px) past the screen and a step exposes at
  most 256 px, so a fresh band is invisible for ~2.9 s at run speed; it is cut
  into `GROUND_SLICE_PX` (384 px) slices along its long axis and one is painted
  per frame (`t3paintSliceStep`). Identical pixels (the slices are disjoint
  rects through the same clipped pass the bands used). THE SLICE SIZE IS A
  GPU TRADE, not just a JS one: every `beginDraw`/`endDraw` bracket costs a
  full capture-target clear AND a full-texture blit whatever it draws
  (`DynamicTexture.beginDraw` → `RenderTarget.bind`, `endDraw` → `blitFrame`),
  so more slices spread the JS but multiply whole-texture GPU passes; 384 px
  gives 4-8 slices, which keeps the GPU within ~2x the unsliced scroll.
  A new scroll FLUSHES what is owed before copying the picture forward, a full
  paint drops it, and every probe that reads the texture back flushes first —
  so a slice can never paint into a swapped texture or a stale anchor.
  (2) `t3prefetchStep` now also COMPOSES the ring's cells, `GROUND_RING_COMPOSE`
  (3) per frame, so the band's compositions are cache hits by the time it is
  painted; the ring stands down entirely on any frame that scrolled or painted
  a slice, so its work never stacks onto a frame the player would feel.
  (3) THE RING'S OWN ALLOCATIONS: `t3armRing` used to materialise the grown
  window as ~11,000 `[col,row]` PAIRS on every latch just to filter them, and
  the prune rebuilt an 11,000-entry Set from them. It now walks the window
  ONCE, keeps a Set of cell INDICES (what the prune tests) and materialises
  only the cells outside the drawn window — ~11,000 fewer short-lived arrays
  per latch, which is GC pressure arriving on exactly the periodic frames.
  THE PREFETCH IS DIRECTIONAL, not a ring (2026-09-03). A ring around all four
  sides prefetched three sides nobody was walking towards: ~6,100 cells at 150
  a frame is ~41 frames, longer than the 1.46 s between latches, so it never
  stopped working and its per-frame cost was paid on EVERY frame of a run.
  `t3armRing` now queues the window as it will stand after ANOTHER step of the
  same anchor shift, minus what is drawn — exactly the strip the next band
  paints (direction unknown, i.e. the first paint after a join or teleport,
  falls back to the symmetric ring). Measured on the same bench: prefetch fell
  from 536-687 ms per run (3.5 ms/frame, max 25) to ~300 ms (1.7 ms/frame, max
  13-16). SLICING ONLY REDISTRIBUTES, and the numbers say so: the band totals
  249 ms unsliced against 287 ms sliced, with the worst frame moving 81 -> 33
  ms (maintainer 2026-09-03: "you replaced a 0.5s lag each 1.5s with a longer
  lag that spans a greater period … I cannot get a smooth FPS"). The sustained
  floor measured on this machine is 6.5-7.0 ms of JS per frame — x3-6 on a
  phone against a 16.7 ms budget — spread across the sliced band, the ring,
  the occluder+scenery rebuild and the per-frame fog/lit-copy pass. The lag
  he FELT was not this floor: it was the capture-target re-allocation (see
  "THE RUNNING-INTO-A-NEW-AREA LAG", below).
- **COMPOSING IS BUDGETED, AND A CELL WITHOUT ITS TRANSITION YET DRAWS THE
  PLAIN PLATE** (`Tiles3Textures.armCompose`, `GROUND_COMPOSE_MS` = 2). One
  composition costs **6.0-9.6 ms on his phone** (measured composeMs/composed
  over the worst frames of the 0a0d1e775 beacon — NOT the "2-4 ms" this file
  used to guess), and the pass composed every boundary a fresh window needed
  synchronously: his worst frames were redrawGround 1244 ms / 113
  compositions, groundSlice 770 / 87, with composeMs 76-95% of the frame. It
  is worst where he plays — over 100 real windows of the_game, a window needs
  15 distinct boundary compositions at the map's median but **128-287 around
  the spawn** (441,364), i.e. 1.1-2.3 s of composing to enter the town.
  The allowance is deliberately SMALLER than one composition, so spending it
  starts exactly one per frame on a phone and about a dozen on a desktop: the
  budget reads the device instead of encoding one. **Only boundaries are
  refused**, because only they have a correct fallback — the plain plate they
  would have replaced, two grounds meeting hard, which is the same answer
  `boundary()` has always given while a source plate streams. A refused PLATE
  would leave the cell with no art at all; plates are 5-9 per window and
  cached for the session, so they are never budgeted. A deferred cell lands in
  `t3boundaryOwed` and `t3retryBoundaries` composes it on a later frame's
  allowance and repaints only what it got — the readiness test is "can it be
  composed NOW", and `stats.deferred` is what separates "the budget refused"
  (stop, everything after is refused too) from "this one cell is not ready"
  (skip). A FORCED FULL PAINT IS UNBUDGETED (`withoutComposeBudget`): the
  `groundHash`/`groundFull` parity instruments compare a streamed picture
  against a forced one, so a budgeted reference would report a mismatch that
  is not a defect.
  **THE COST IS THE TEXTURE, NOT THE BLEND**: composeBoundary is 42 us and
  capWallToSurface 30 us against 6-9.6 ms, so 91-97% was the registration —
  a per-composition `<canvas>`, a 2D context, putImageData, and Phaser's
  `addCanvas` doing a full getImageData READBACK it retains forever
  (CanvasTexture.js:86,118). A composition now goes in as raw bytes
  (`TextureManager.addUint8Array`), one retained copy instead of three. Safe
  because every composed raster is BINARY-ALPHA (gated), so the shared
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL true` is the identity on every texel, and
  `createUint8ArrayTexture` hardcodes gl.NEAREST. A raw texture has no
  drawable source — `rawTexPixels` is what keeps `__ml.t3png` working.
  Bisects: `__ml.groundCompose(Infinity)` (pre-budget), `__ml.groundRaw(false)`
  (back to the canvas). Beacon: `bnd`, `defer`, `owed`.

- **A TOO-WIDE CELL REPAINT SPLITS; IT DOES NOT GIVE UP.** `repaintTiles3Cells`
  bailed to a full paint when its bounding rect passed half the texture, and
  the geometry made that the ORDINARY case: a cell's rect spans the world's
  whole column height, so at maxLevel 40 / pitch 15 ONE cell is 704 texels =
  42.5% of the 1,656-tall texture, leaving ~23 columns of width before the
  bail — and one landed plate file is wanted by cells all over the window
  (`t3missing` maps a shared file to every cell that asked). The landing
  repaint was manufacturing the full paints it exists to avoid. It halves the
  set on the longer axis, `T3_REPAINT_SPLITS` (2) deep, at most 4 rects. Sound
  because each rect repaints its WHOLE window, not just its listed cells, so
  a cell's spill into a neighbouring rect is redrawn there.
- **ONLY A RAISED REPAIR REBUILDS THE OCCLUDERS** (`T3_OCC_REPAIR_MS` 400). A
  raised cap wears its transition on the occluder re-issued over the ground,
  so a repaired one needs a rebuild; a level-0 field cell emits no occluder
  and no `occluderMeta` at all, so rebuilding for a flat repair returns a
  bit-identical set. Measured standing still, poisoning on every repair cost
  11-12 rebuilds and 101-309 ms of JS per 12 s to change nothing, because
  94-100% of repaired cells are flat.
- **A SECTION TIMER REPORTS SELF TIME.** `rebuildScenery` runs inside
  `rebuildOccluders`; an inclusive timer billed both and drove the beacon's
  `other` — the frame minus every section — to -84.9 ms. A span hands its
  duration up to its parent, which subtracts it.
  **`?ground=legacy` IS THE BISECT** (remembered in localStorage
  `ml-ground-path`; `?ground=fast` restores). It turns the whole 2026-09-02/03
  ground rework off in one page load — no scroll, no sliced band, no landing
  repaints, no prefetch, every latch a full paint — so an artefact reported
  from the phone can be attributed or cleared without a harness reproduction.
  Added while two artefacts (background-coloured vertical lines, then
  horizontal ones) were reported from the phone and had not yet reproduced
  here. BOTH ARE NOW FOUND AND FIXED, and the second was the texture's LAST
  ROW all along — the thing this note used to dismiss as "known and unrelated,
  512 px outside the view". It is 512 px outside the view only until the next
  SCROLL copies the kept picture past it; see `fillGround`. Two lessons worth
  more than the bug: an unpainted edge texel in a texture that SCROLLS is
  never off-screen, it is merely early; and reproduce a one-pixel report at
  the maintainer's EXACT device geometry (`deviceScaleFactor: 2.75` — it sets
  renderScale, the camera zoom and the texel grid) and judge it on the
  SCREENSHOT, never on a render-texture dump.
  Dev A/B: `__ml.groundSlices(on)` (off = the whole band in the scroll's own
  frame); `__ml.hitch()` returns the worst frames of a run with each one's
  profiled sections, its compositions, and `other` = frame total minus every
  section (render + GPU + unprofiled JS — the discriminator that told us the
  harness is 99% GPU-starved and the spike is ours).

- **The light fields have a resolution switch (dev A/B, phone-testable).**
  The three full-screen passes (light, mist, depth fog) render at the canvas
  size — device pixels at rs>1 (~1.8 M fragments each on a 891x2000 phone,
  the light one marching the heightmap) — and are the GPU's whole bill.
  `?light=0.5` builds them at half size (a quarter of the fragments) and
  upsamples the overlays LINEAR (`lightScale()` in nightlight.ts; remembered
  in localStorage `ml-light-scale`, `?light=1` restores). Phaser sets the
  shader's `resolution` to its own size and every pass samples normalised
  over uCam, so nothing else moves; shadow edges go ~2 px soft. The default
  stays 1 until the maintainer's `?fps=1` numbers say the GPU is the bill.

- **THE RUNNING-INTO-A-NEW-AREA LAG WAS PHASER'S SHARED CAPTURE TARGET
  RE-ALLOCATING** (`client/src/capturepool.ts`; maintainer 2026-09-08, on his
  phone, same route, one build: "I felt 0 lag when capture pool was on").
  Every `DynamicTexture.beginDraw` binds `renderer.renderTarget`, ONE
  autoResize RenderTarget, and `bind` -> `resize` deletes and re-creates its
  texture and framebuffer whenever the size differs from the previous bracket.
  The ground RT is 1510x1656, the cover atlases 1024x512, the light fields
  544x708 — so once scenery is on (cover flushes ~50/s against ~16 off), every
  frame that paints a ground slice frees and re-allocates ~12 MB of VRAM twice.
  Measured in his beacon, pool off vs on: 967 texture deletes + 967 framebuffer
  creates + 967 deletes in one 30 s window against 0; 430 MB of allocation
  bytes against 199; p90 31.4 -> 18.7 ms, p99 53.6 -> 28.0, long-frame ms
  938 -> 260, fps 48 -> 59. The pool keys one NON-resizing RenderTarget per
  WxH and swaps it into `renderer.renderTarget` before `bind` (`endCapture`
  reads that field; nothing else in Phaser 3.90 does). ALWAYS ON, no switch
  (maintainer 2026-09-09: "Why would I ever turn 'capture pool' off? That
  feels like the technical detail that will make the game lag");
  `uninstallCapturePool` stays for a harness. The beacon's `capSwitch` (size
  switches = what stock Phaser would re-allocate) and `capSizes` still report.
  RULE: no bracket may ever resize the capture target — a new DynamicTexture
  size costs one pooled texture, never a per-frame realloc.
  WHY EVERY EARLIER MEASUREMENT MISSED IT: `createTextureFromSource(null, w,
  h)` returns in ~0.1 ms because the driver only QUEUES the allocation (the
  upload probe saw 1,389 in one window at 150 ms total); the cost lands in the
  GPU process, in later frames, in nobody's section. The `scratchpad/fx/bench.mjs`
  bracket bench (0.015 ms per empty bracket) was true and irrelevant: it never
  interleaved two sizes. Rejected on the way, all A/B'd on his phone and felt
  identical: merging the band under one bracket (2x worse — the whole band's
  paint in one frame); the ground RT on MultiPipeline (draw calls 45x fewer,
  frame unchanged); the drop drain's full repaint off; light resolution 2% vs
  100%; scenery+monster art replaced by one pink texture (lag identical —
  image fetch, decode and upload were never it); scenery light flat and
  shadows off (laggiest run of all). What did hold through every arm: travel
  is necessary (circling paints no ground), scenery or monsters are necessary
  (a second target size in the same frame), the OFF run with 723 monster
  strips still loading in the background was "insanely smooth".
  `GROUND_BAND_MS` stays so the drain paints one rect per frame; the merge
  machinery survives only for its dev switch and its bracket-ownership guard.
- **DO NOT REMOVE THE DROP DRAIN'S REPAINT.** Turning it off removed all 32
  `full:redrawGround` frames per 90 s (1,914 ms) and cost more than that back:
  the repaint re-anchors the ground mid-latch and absorbs about half of each
  256 px latch step, so without it those latches return as SCROLLS.
  Measured across two census runs, `scroll:groundSlice` went 76 -> 175 frames
  and the ground's total went 62.9 -> 94.5 ms per second of wall clock. It is
  kept for what it does by accident, not for what it was written to do.
  `__ml.groundDrain(false)` turns it off for an A/B.

- **THE SLICE-SIZE RATCHET WAS DEAD CODE.** It grew `groundSlicePx` only when a
  slice cost under `GROUND_SLICE_MS`/2 = 1 ms, and a slice costs ~20 ms on his
  phone (the capture re-allocation above, since removed) — so the condition was
  unreachable and the size sat at its initial 384 px for the life of every
  session. It could only grow once it was already fast and it was never fast
  because it never grew. Removed. Any self-tuning ratchet whose growth test is
  stricter than its target has this bug.

- **THE DROP DRAIN REPAINTS CELLS, NEVER THE TEXTURE** (`t3drainDrops`,
  `t3dropOwed`, 2026-09-12). A ground op drops when its art is not resident
  or its composition is deferred; the landing path repairs the first
  (`t3missing` -> `repaintTiles3Cells`) and `t3retryBoundaries` the composed
  transitions, and the drain — one repaint per loader idle edge — catches
  what neither owns (fades, plates, decks). It used to poison the latch and
  paint the WHOLE ground: measured on his phone, one full paint per drain,
  14-19 per 30 s window with ZERO textures landing, 46-77 ms each — the
  largest share of his lag frames on the sprite path, and the "burst test"
  that skipped it with the other bursts ran 2-3 lag frames per window
  against 38-51. Now every pass records the cells whose ops dropped and the
  drain queues THOSE (x-sorted) and `t3drainTick` repaints one group of
  `T3_DRAIN_GROUP` (8, under the half-texture split) per frame through the
  clipped cell path until the queue drains — a fresh area streams in with
  hundreds of deferred fades, and repainting them all at the edge was the
  full paint's burst under another name (a 48-per-edge cap instead left 13%
  of the texture plain against a full paint). A still-dropping cell re-owes
  itself, so a permanently undrawable op costs one small rect per loader
  cycle. GROUND ONLY: the occluder set keeps its own latch. Gates: the
  streamed picture equals a forced full paint once the ring is drained
  (`groundSnapshot` overlap, 0.09% at 275,224 either way), and `fullPaints`
  per window ~0 while running with `drains` unchanged.

- **`lighting` IS THE NIGHT PASS UPDATE — SPLIT IT, DON'T GUESS IT.** The
  maintainer's 2026-09-07 beacon run made `lighting` the biggest CPU section
  and the least explained: 2.48 ms in one window and 17.13 in another on a
  Mali-G715. (NOT "it does not track the lit-occluder count" — that reading was
  WRONG and is the trap below: `sections` are window MEANS and `counts` are
  INSTANTANEOUS snapshots, so it compared a 30 s mean against one sample. The
  swing is still unattributed.) Measured headless with the section split:
  `night.update()`
  IS the section — 116 ms/frame of it against under 0.7 for `applyObjectLights`,
  the cover surfaces and the shape jobs combined. So the cover-surface theory
  (it scales with occluders, which the worst window had most of) was WRONG, and
  measuring it cost nothing while shipping a fix for it would have. The section
  now reports as `litPick` / `litWeather` / `litPass` / `litShapeJobs` /
  `litObjects` / `litCoverSurf` / `litAtmo`, self-timed so they nest, and the
  pass reports `updMs` + `glowMs` inside the light bill — the glow render
  texture is a mid-frame framebuffer bind, which a TILER pays for in a tile
  flush. The beacon also carries the cover atlas's own counters now
  (`coverFlush`/`coverSkip`/`coverQuads`/`coverCands`/`coverSlots`).
- **THE BEACON'S `sections` ARE WINDOW MEANS; ITS `counts` ARE INSTANTANEOUS
  SNAPSHOTS.** Never correlate one against the other — that is comparing a 30
  second average with a single frame, and it produced a confident wrong reading
  of the 2026-09-07 run ("`lighting` does not track the lit-occluder count").
  The run proves how unrepresentative a snapshot is: one window reported
  `occluders` 320 against `occMean` 5682, and `displayList` 1176 against
  `dlMean` 6439 — a 17x miss. Only `occMean`, `dlMean`, `zoomMean`, `longN`,
  `longMs`, `texturesAdded`, `fullPaints` and `drains` are window quantities;
  `litOccluders`, `sceneryImgs`, `scenerySources`, `monstersActive` and
  `flushes` are snapshots and want promoting to means (the `perfOccSum`/
  `perfCountN` pattern already exists). `zoomMean` and `jumps` were sent by the
  client and DROPPED by the allowlist for two whole runs — the same trap this
  file warns about one bullet down, walked into twice.
- **THE BEACON CARRIES THE WINDOW'S CONTEXT, THE ROUND TRIP, THE THROTTLING
  PROXY AND THE GPU'S CLOCK** (2026-09-11, prepared for the next optimisation
  task so a run answers on its own). Beside the sections and counts: `run`
  (`runId` per page load + `winIdx`, `sinceLoadS`, zone and hops with the
  last hop's join/state/bound ms, `moveFrac`/`runFrac`/`travelCells` —
  what he was DOING, `deviceMemoryGb`, the connection hint, the UA); `rtt`
  (input seq sent → the server's ack, p50/p90/p99/max — network plus the 20
  Hz tick, the one lag no CPU section can see — with `patches`/`patchHz`
  and `reconnects`); `cpu` (`xorshift400k` scoreMs: the same work every
  window, so a window where it rose while the sections did not is the phone
  throttling, not the game); `gpu` (`EXT_disjoint_timer_query` — Phaser 3 is
  WebGL1; the `_webgl2` form is tried first — frame time p50/p90/p99 when the
  browser lends it, `avail`+`reason` first: "no numbers" is never 0 ms, and
  headless Chromium withholds it); `frames` now
  carries the histogram (`le17/le34/le50/le100/gt100`, `mean`) and `rafHz`
  (the refresh read off the 15th-percentile interval — 60/90/120, or 30 when
  the browser throttled the tab); and the snapshot counts are promoted to
  means (`litOccMean`, `monActMean`, `flushMean`, `sceneryImgsMean`).
  Every WORST-FRAME record now also says WHERE it happened (`at`, the body's
  cell), at what `z`oom and `t` ms into the window — every report he sends is
  about a place ("if I stand here and run down...") — and `longWhere` is the
  long-frame census BY PLACE, in 8-cell blocks keyed by the block's corner so
  it reads back as a teleport target (`longBy` could only say what the bad
  frames were doing). A STATIONARY WINDOW IS NO LONGER DROPPED WHEN IT WAS
  BAD: the old gate was "have you moved 2 cells", which threw away exactly
  the report he keeps sending by hand — standing still while it stutters —
  so a window carrying a >100 ms frame, a browser long task or a p90 over 30
  ms now posts too, and `run.why` says which (`moved`/`bad`/`flush`).
  READ A RUN WITH `node scripts/perf-read.mjs [--last N] [--run id] [--build
  sha] [--diff shaA shaB]` — one line per window, both censuses, the worst
  frames with their place, and two builds' medians side by side; "-" is "not
  measured", never 0. GATE:
  `scripts/verify-beacon.mjs` captures the client's real POST headless and
  asserts every block survives `perfReport` — the eaten-field trap, made a
  test. Instruments: `client/src/gputimer.ts`, `client/src/perfextra.ts`
  (unit-tested in `server/test/perfextra.test.ts`).
- **THE PERF BEACON'S SERVER SIDE IS AN ALLOWLIST** (`server/src/perfreport.ts`,
  `perfReport`, tested in `server/test/perfreport.test.ts`): `/api/perf`
  rebuilds the report field by field, so a block the client starts sending is
  DROPPED SILENTLY until it is named there. A `lights` block written
  client-side on 2026-09-07 would have posted, returned 200, and arrived empty.
  Add the field on BOTH sides or not at all. What it carries now: the night
  pass's own bill — lights uploaded (mean + peak over the window), how many of
  them MARCH SHADOWS (the 12-sample loop, the real per-fragment cost), summed
  pool area in cells, ambient, the FIELD the shader runs at with its
  `?light=` scale and fragment count (resolution is the biggest GPU lever
  there is and was invisible), plus the GPU string, torch, weather and the
  scenery switches. Means over the window, not the last frame: he walks in and
  out of the town's pools while one window is timing.
