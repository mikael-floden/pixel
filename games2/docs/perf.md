# Performance: ground streaming, repaints, the beacon

The ground render texture (scroll, slices, cell repaints, prefetch, compose budget), the pooled occluders, the capture pool, and how the perf beacon is read. Moved verbatim out of `games2/CLAUDE.md` (2026-09-09), which keeps the law and points here; the measurements, traps and rejected approaches live in this file. Rewrite in place under the root doc law.

- **REJECTED 2026-09-12: replacing the occluder sprites with a per-pixel
  depth test** (the render retake, `docs/depth-sort.md`) — GPU-bound on his
  phone, 4.5x the lag frames. The CPU bursts the beacon's worst frames name
  on the sprite path are the targets instead, proved by a Settings switch
  that skipped them all (38/51 → 3/2 frames over 50 ms per window, p90 19 ms;
  removed once the bursts were fixed one by one): the full-paint-per-drain
  loop (done: THE DROP DRAIN REPAINTS CELLS below; cliffs 38 → 11, cave 51 →
  17), `rebuildOccluders` 50-133 ms every 96 px (done: THE WALK IS
  INCREMENTAL below; 7/7), then the ground compose (next). After burst 2 no
  single burst is left; a slow frame is the ground texture work (slice 15-38
  ms, cell repaints 10-54 ms, prefetch 10-20 ms — ~600 ms of the 48 slowest
  frames) plus GPU waits (~580 ms) that track the composed-texture churn
  (window 1: 669 GL textures created, 165 MB uploaded, 8,800-10,600 textures
  live). THERE IS NO TRANSITION SHADER IN THE GAME: every boundary, fade and
  capped plate is composed on the CPU per (pattern, groundA, groundB) and
  uploaded as its own texture (the shader with a parity test was the render
  retake's terrain DEPTH shader, rolled back).
- **THE STEADY FRAME IS THE LAG, NOT THE BURSTS** (measured 2026-09-12 on
  the overworld run that "felt laggy": 14.6-21.8 ms of CPU per frame on a
  cool phone, 37% of frames under 17 ms; the same route on a throttled phone
  26-33 ms). It scales with the occluder count (3.5-8.8k sprites in the
  display list): `render` 2.8-7.6, `occCull` 0.9-2.2, `depthSort` 0.85-2.1 —
  answered by the proximity cull and the insertion sort (`docs/depth-sort.md`).
  What is left after them, per frame: the ground streaming (`prefetch` +
  `repaintCells` + `groundSlice` 2.4-5.5 ms), `gapBusy` 1.8-4 (unattributed),
  `monsterLoop` 0.5-2.4 (20-40 monsters, ~70 µs each), `lighting` ~1, the
  lit copies ~1, and 100-240 MB of texture uploads per 30 s window (every
  composed boundary is its own texture). RUNS ARE ONLY COMPARABLE ON A COOL
  PHONE: `cpu.scoreMs` (the beacon's 400k-iteration loop) reads 2.6-4.3 ms
  cool and 7.2-7.8 after five back-to-back runs, with the display dropping
  to 41 Hz — a run whose score is over ~5 measures the throttling, not the
  build.
- **REJECTED 2026-09-12: A GPU TRANSITION COMPOSITOR** (a SinglePipeline
  subclass doing the composer's three reads per boundary quad, 0.83% of
  texels off the CPU composer; removed with its Settings switch). Three runs
  with it on were worse — 44/51 and 102/117 lag frames a window against 7/7
  and 15/15 with it off — and none was a clean measurement: every slow frame
  in every run carried a monster-strip upload, and the sim's one draw with
  per-draw uniforms per boundary is the shape a Mali dislikes. Its whole
  upside is ~1-2 ms of CPU and ~8 MB of uploads a window (the composed
  `t3x:` textures, 600-1,200 a window at 12 KB), while the runs were
  dominated by hundreds of MB of monster art (next bullet). Not worth a
  fourth run.
- **THE ART QUEUE** (`client/src/artqueue.ts`, 2026-09-12): every texture
  streamed behind the live world — monster strips, characters' deferred
  states, NPC idles, scenery animation frames — is fetched and decoded off
  the main thread, then turned into a GPU texture under a BYTE BUDGET PER
  FRAME in the maintainer's priority order (`ART_PRIO`: my urgent clips; the
  attack and die strips of a kind whose monster chases or fights, then its
  angry; a kind's walk when the first monster of it exists, idle behind it —
  walk stands in for idle until then; NPC idles and the blood; my weapon and
  spell states; the other characters' states; then, when nothing above is
  waiting, the fight art of every kind that exists, so a fight that starts
  later finds it resident — a fight only RAISES those requests; scenery
  animations behind that; angry dead last). One file bigger than the budget
  goes in one piece and its overshoot is charged to the frames after it, so
  the average holds whatever the file sizes; decoded pixels waiting are
  capped at 48 MB. MEASURED, four runs on his phone: every slow frame (24 of
  24, 15 of 15, 45 of 48) carried a texture upload and the uploads were
  monster strips — the game queued the combat strips of all 57 kinds at
  launch (1,312 files, 416 MB of textures; walk+idle of all kinds another
  912 files, 284 MB; a 256-px kind is 40 MB) and the loader's "two in
  flight" bounded the count per frame, never the bytes: 564 MB in one 30 s
  window, 12 MB in one frame. With monsters MOCKED (Settings "monsters":
  mock — nothing loaded) the same stretches ran 2 and 9 lag frames a window,
  the burst-test ceiling; that is what this reaches for. No kind's strips
  are asked for before a monster of it exists near me. THE BUDGET IS PINNED AT 128 KB
  A FRAME — his phone found it, and the dial went with the other three
  shipped-optimisation switches on 2026-09-13 ("no toggles for what is
  decided"; the row's own comment had promised exactly this). `ml-upload-kb`
  still holds it and `?uploadkb=<n>` still sets it (0 = unbounded) for a
  harness; beacon `run.sim` = `up128`,
  `counts.artQueued/artReady/artLanded/artKbMax`, probe `__ml.art()`. The boot batch (behind
  the loading bar) and the ground art (its own loader, its own compose
  budget) stay outside it. Mock-mode caveat for future runs: "scenery: mock"
  and the old shader test both provoked `litShapeJobs` bursts of 50-400 ms
  (shape maps rebuilt for the substituted textures), so a scenery-mock run
  is not a clean ceiling.
- **THE ART QUEUE DECODES ON A WORKER AND UPLOADS IN BANDS**
  (`client/src/artworker.ts`, `artqueue.ts`, 2026-09-12, games-perf). The
  queue's `texImage2D` of an `<img>` it had already `decode()`d cost 5.8-9.2
  ms of main thread per monster strip headless and 4.5-8.9 ms on his phone
  (`texUp.p90/max`, 22-60 uploads over 4 ms a window; a 1-1.6 MB strip rode
  in many of his worst frames) — Chrome decodes the WebP AGAIN inside every
  such call, the same whether the upload follows `decode()` at once or
  seconds later (both measured), so the byte budget bounded the bytes and
  never the atom. Decoded on the worker into an ImageBitmap (premultiplied
  there, under the browser-default colour rule), a strip reaches the GPU as
  row BANDS of one frame's budget through `texSubImage2D`: 0.0-0.2 ms per
  128 KB band (p50 0.09), so a frame's upload is bounded by the dial
  exactly — `frameKbMax` 98-125 KB against 128, debt 0. The worker also
  measures every frame's opaque box and hands it over before the bitmap is
  closed (`artBounds` used to draw the source into a canvas on first use:
  a second decode of every body's strip on the main thread, 188 ms of a 60 s
  harness profile). A banded texture holds no source pixels, so a context
  restore refills it through the queue (`onContextRestored`, unbudgeted —
  the art is already off the screen) after Phaser re-creates the wrapper
  blank. A banded texture holds no element for the CPU readers of a body's
  frame either, and A GL READBACK IS NEVER INSIDE THE FRAME FOR ONE (Smooth
  5, 2026-09-12: his 19:44 run of Smooth 3 had the outline's first sight of
  a banded frame as a 63 and a 32 ms readback): `artBounds` has the worker's
  boxes, and the outline (`ringTextureFor`) and the foam clamp (`alphaMap`)
  ask the worker for the frame's alpha (`ArtQueue.frameAlpha` — one request
  per rectangle, the file's bytes from the HTTP cache, the last four decoded
  files kept on the worker so a body's frames cost one decode per file) and
  show nothing until it answers a few frames later; the map is not cached
  while it is pending. `framepixels.ts` keeps the two synchronous paths
  (an element drawn as before; a bare GL texture read back through a
  temporary framebuffer, alpha exact, premultiplied colour) for a texture
  the worker cannot serve and for the parity probes. Gates:
  `__ml.artAlpha(key, frame)` is the readback against the `<img>` path's
  alpha, `__ml.artAlphaWorker(key, frame)` the worker's answer against the
  readback. Pixel parity: `__ml.artParity()` reads the banded texture and an
  `<img>` upload of the same file back from the same context — byte-identical
  on 6 of 6 strips, and again after a forced context loss
  (`scripts/verify-artworker.mjs`). A browser without workers, ImageBitmaps
  or OffscreenCanvas, or a worker that dies, falls back per job to the
  `<img>` path. Beacon: `counts.artBands`, `counts.artBandMaxMs`,
  `counts.artWorker` (1 on, 2 fell back); `texUp` should lose the strips.
  THE BISECT is `?artworker=0|1`, or a harness writing `ml-art-worker`: off
  sends every job the `<img>` way from the next file on. It was a Settings row
  while the worker was under measurement and he had it removed on 2026-09-13,
  the worker being decided — a bisect an agent runs, not a setting he reads.
  Not measured here: the GPU side of an upload on a Mali — his next run's
  `texUp.slow` and the worst frames' `upKb` say.
- **SCENERY STILLS RIDE THE ART QUEUE, AND THEIR FIT COMES WITH THE BANDS**
  (`flushScenery`, `onBounds`, 2026-09-12, games-perf). His 20:51 run (build
  4736387f1, strips already banded) still had 18 and 12 frames over 50 ms a
  window, and 10 of the first window's 13 were `rebuildScenery` at 33-66 ms
  per 96 px occluder step into a fresh forest; the scoped profile said the
  loop itself is ~1 ms a step and the rest is FIRST-SIGHT PIXEL WORK per new
  still: the stills rode the terrain loader's Phaser queue (a `texImage2D` of
  an `<img>` — decode one), then `sceneryArtFit` drew the source into a
  canvas for `alphaBBox` (decode two) and `resolveDrawDepth → artBounds` drew
  it again for the opaque box (decode three), 4.5-8.9 ms each on his phone.
  Now `flushScenery` requests every still from the queue (`ART_PRIO.
  sceneryStill` 1.75: behind my clips and a fight's strips, ahead of a
  newcomer's walk; behind the loading screen `sceneryBoot` -1, first of
  all — the hold waits for the stills and for nothing else in this queue,
  and behind my own clips none of 43 had landed 5 s after they were asked
  for, headless); the worker decodes it once and hands over both
  boxes with the bands — `bounds` (artBounds' rule, alpha > 16) and `bbox0`
  (alphaBBox's rule, alpha > 0, all -1 when empty) — and `onBounds` seeds
  `artBoundsCache` and `sceneryFit` before the first rebuild sees the
  texture, so a step into a new forest measures nothing on the frame
  thread. Landings count on the loading bar as before
  (`sceneryArt.done`, one per `onLanded`, at once for a key the queue
  already holds) and mark the occluder repaint after a
  `SCENERY_MANIFEST_SETTLE_MS` settle (one repaint per burst, as the
  loader's batch `complete` was). THE BOOT HOLD waits for them by that
  tally (`sceneryArt.done >= requested` in its `scenery` condition — the
  stills left the terrain loader, whose `isLoading` was what held it), and
  the queue ticks UNBOUNDED while the loading screen is up
  (`tick(!worldUp)`, as the compose budget already is): there is no frame
  to protect behind it and the byte budget would only make the bar slower;
  the frame stats (`frames`, `frameKbMax`) count budgeted frames only.
  `texPixels` reads a banded texture back through `readTexturePixels`
  (un-premultiplied within rounding — the scenery light block's colour
  average and the shape maps can bear that) for the readers that still want
  the whole still (`sceneryFit.clear()` on the scenery switch, the shape
  maps) — and THE READBACK IS NEVER INSIDE THE FRAME (Smooth 6, 2026-09-12:
  his 21:57 run on Smooth 4 had `rebuildScenery` at 62-92 ms a long frame,
  25 in one window, WORSE than the 33-66 before, and the headless profile
  said why — `readPixels` was 59% of the rebuild's time: a scenery still is
  drawn through a CUT frame (`addSceneryCut`), so `artBounds` missed the
  seeded `__BASE` box and read the texture back, and the light derivation
  and the shape jobs read the whole still back for its pixels; on a Mali a
  readback drains the pipeline, worse than the decode it replaced). Now a
  cut frame's box is the seeded whole-image box clipped into the cut — exact
  when the cut holds every opaque texel (a still's cut is its own alpha box,
  a clip frame's crop its state's box), a superset otherwise, refined from
  the worker's alpha when it answers (`artBoundsRefine`) — and `texPixels`
  on a banded texture hands over the worker's pixels on demand
  (`ArtQueue.pixels`, one request per key, the answer taken once): the
  light waits a rebuild for them (and for its unlit sibling's, so the
  derivation never runs without the sibling and caches that), a shape job
  waits a frame without blocking the jobs behind it. `texPixels(key, true)`
  is the probes' synchronous readback. Gates: `__ml.artPixelsWorker(key)`
  (alpha exact, colour within the un-premultiply's rounding),
  `__ml.artBoundsParity(n)` (every derived cut-frame box against a fresh
  measure). `__ml.sceneryFitParity(n)` compares
  every seeded fit against a fresh `alphaBBox` of the readback, in
  `scripts/verify-artworker.mjs` (checked > 0, mismatched 0). The art-worker
  Settings row bisects this too: off sends the stills the `<img>` way.
- **MEASURED 2026-09-12, NOT THE LAG** (headless traces of the overworld run,
  games-perf; each was a suspect for the unattributed `gapBusy`): the
  Colyseus patch decode is 1.1 ms per SECOND (21 messages/s, 92 KB);
  no style or layout work runs per frame (the HUD's DOM is quiet;
  `PrePaint` 0.13 ms/frame); the JS heap's 25-53 MB/s of growth is
  short-lived garbage — GC is 0.4% of CPU (scavenges; the beacon's `drops`
  are those), so cutting allocations is not a frame-time lever here.
- **THE COVER ATLASES ARE ONE BRACKET EACH, ON THE ROWS IN USE** (`coverRaster`,
  2026-09-13). A flush ran 7 brackets and 3 whole-atlas clears, and every
  bracket clears the capture target and blits it whole into the 1024x512 atlas
  — ~7 Mpx of fill a flush, ~23 flushes/s, ~2x the visible screen's fill, for
  typically ONE 40x96 body (his 22:53 run: `coverSlots` 1, `coverQuads` 24).
  Now an erase is the object's own ERASE blend inside the pass (Phaser 3.90
  `batchGameObject` applies `gameObject.blendMode`; dst * (1 - a) is the erase
  blit's own maths), so E, C and O are three brackets; and slots pack bottom-up
  so the capture is bound at the rows the flush's slots occupy (`coverRows`,
  128-512 in steps of 128 — at most four pooled capture sizes, `capSizes` 3 ->
  up to 6) and the atlas is cleared over those rows only: a one-body flush
  fills ~0.8 Mpx. Texels identical by construction (Porter-Duff `over` is
  associative, the erase maths unchanged) — gate: `__ml.coverParity` in
  `scripts/verify-cover.mjs`, the three atlases raw byte-equal against the
  seven-bracket path, driving the switch live both ways. `?coverpasses=7`, or
  a harness writing `ml-cover-passes`, restores the old path (its Settings row
  went on 2026-09-13 with the other decided switches); the beacon carries
  `coverBr` and `coverRows`. MEASURED ON HIS
  PHONE (02:02 run 2026-09-13 on 472f8f72a, moving, cool, same route as the
  22:53 baseline on de89282af): frames over 50 ms a window 14/20 -> 5/7, p99
  52 -> 42/40 ms, p90 34 -> 33/26, long-frame ms 700 -> 167/537,
  `cells:unattributed` 20 -> 9/5 long frames, 43 -> 50-53 fps mean. What the
  run then showed inside the flush: four long frames (48/29/14 ms, one more in
  window 2) each with `fbNew 1, capSw 1` — the FIRST use of a new pooled
  capture height paid the GPU allocation in the frame — so `initCoverSurfaces`
  binds and unbinds all four heights behind the loading screen; and
  `coverRows` read 384 with one body covered, because a freed slot was popped
  by recency and a body could land three shelves up while the floor shelf
  stood empty — `coverTakeLowestFree` hands out the free slot nearest the
  floor. His 02:25 run on a1856b4ae (7/4 frames over 50 ms, p99 39.6/37.2,
  `glFbNew` 0 both windows — the warm-up held) still read `coverRows` 512 with
  one body: a NEW slot was always cut on the topmost shelf. The packer now
  places it on the lowest shelf with the width and the height (only the top
  shelf grows), and the beacon's `coverRowsMean` averages the bound rows over
  a window's flushes. His 02:40 run on 7cd328939 read it at 197/303 with
  about one body a flush: a 160 px monster class placed on the FLOOR shelf
  had grown it past a step, and every flush after that bound 256+ rows. The
  floor shelf is now opened at exactly one step and takes only slots that fit
  it (characters and 53 of 57 monster classes); taller slots go up. The
  beacon's `coverSlotsMean` says how many bodies a flush carried, which is
  what `coverRowsMean` is to be read against — the next run should show it
  near 128 whenever the mean bodies are ~1. Traps:
  the blit copies with the renderer's CURRENT blend func (NORMAL
  goes back before `endDraw` or the blit erases); a shorter capture lands in
  the target's LAST rows (`blitFrame` viewports at `target.h - source.h`,
  flipped) — hence the packer grows upward from the atlas floor.
- **THE INDOOR FLIP IS INCREMENTAL** (`repaintIndoorFlip`, `debrisPool`,
  `occWinCuts`, 2026-09-12). Crossing a cave or house threshold used to be
  a full ground paint, a full occluder walk, the destruction of the whole
  old set (the 120-160 ms cleanup frame after) and a crossfade layer of
  every removed sprite built in one frame — his mountain window carried four
  crossings at 150-490 ms a frame, 350 ms of it the 2,647-sprite debris
  build. Now: (1) the ground repaints only the cells IN a cut, old or new,
  through the clipped cell path under the NEW indoor state — the anchor's
  mask and top are moved first, because `repaintTiles3Cells` paints under
  the anchor's — pixel-identical to a full paint after every crossing
  (`scripts/verify-cave.mjs`; the legacy scalar cut still paints in full);
  (2) the occluder rebuild finds the cut change itself (`occWinCuts`) and
  re-walks those cells plus their west and north neighbours (the
  exposed-face rule reads the east and south neighbour's cut), the pool
  giving back every unchanged image; (3) the crossfade's sprites come from
  a POOL warmed 16 a frame once the world is up (4,000; taken with one
  display-list add, returned in one batch filter) and are culled to the
  camera plus 96 px instead of the occluders' 360 — a cave exit at the old
  pad built 7,035 of them, now a third. A storey drawn with the mid tile
  while its own tile streams (`faceKeyAt`'s substitute), and a cut wall's
  cap course drawn with the cap tile while the mid streams, mark their cell
  incomplete (`faceOwnKey`), so a landing walks it again — a full walk used
  to find 13-54 such faces the incremental set lacked. Gate:
  `scripts/verify-cave.mjs` (four crossings: 0 sprites missing, 0 extra in
  view, the ground hash equal to a full paint after each; `INC=0` is the
  full-paint control). The only difference left is the per-diagonal depth
  slot, which is walk order and never orders two overlapping images.
- **THE RESOLUTION DIAL** (`client/src/resolution.ts`, the slider in
  `resdial.ts` just above the HUD's "Light resolution", 2026-09-12): the
  canvas backing is `devicePixelRatio` (capped at 4) × the dial — 1, 2/3,
  1/2, 1/3, 1/4, 1/8 — and the camera zoom is derived at full resolution and
  scaled by the dial, so the SAME world fills the screen with the square of
  the fraction in fragments (`zoomFor`; a step whose zoom is not whole — 2/3
  and 1/3 always, 1/4 and below on his phone — resamples the art and
  camzoom.ts's seam can show; the thirds are his ask for more options, not a
  look). Measured (frames over 50 ms per window): 1/1 7 and 21, 1/2 4 and
  2, 1/4 12 and 23 — below 1/2 nothing more comes back, so past that point
  the frame is the CPU bursts, not the fill; his verdict is that 1/1 "looks
  best by far" and is the target. `renderScale`
  in the registry is the EFFECTIVE backing per CSS px, which is what the
  ground texture's world size and the pointer mapping want; "ml-render-res"
  refits the canvas live and the scene's resize handler re-zooms and re-makes
  the ground texture. The light dial is a fraction of the canvas, so its
  ceiling follows this one by construction, and both readouts name the same
  units: `1/2 540×702`, a fraction of the FULL backing and the pixels it
  means (`resFractionLabel`). Beacon: `run.sim` carries `/r1.5`, `/r2`,
  `/r3`, `/r4`, `/r8`;
  `view` and `lights.backing` show the size. Measured on his phone before it
  existed (the light dial alone): 100% → 50% light resolution moved fps 43 →
  49 with CPU work flat — the frame is fragment-bound, and this dial asks
  how much of it is everything else.
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
  check — same images, same meta — except kept cells' images the cull box
  would now refuse, which stay (harmless: a few extra sprites, none in view,
  never a missing one), and the per-diagonal depth slot after a cut change
  (walk order; a diagonal's cells sit side by side, so it never orders two
  overlapping images). `scripts/verify-occinc.mjs` is that check (`__ml.occInc()`
  counters and A/B — `occInc(false)` walks the window every step;
  `__ml.occIncCheck()` steps to the exact camera, then compares against a
  full walk). NOT time-slicing the full walk across frames (stash of
  2026-09-12: a generator with a staged swap — the set is stale for the
  frames it takes, lit copies were lost at one spot, and it still does all
  the work). The scenery rebuild (`rebuildScenery`) and the cover index
  still run in full every step; the rebuild's loop is ~1 ms a step headless
  and its 33-66 ms steps on his phone were first-sight pixel work per new
  still, now measured on the worker (SCENERY STILLS RIDE THE ART QUEUE) —
  the cover index is next if his run still names it.
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
  full capture-target clear (`DynamicTexture.beginDraw` → `RenderTarget.bind`;
  it cannot be bounded — `adjustViewport` disables the scissor test right
  before it — and a tiler's transaction elimination makes the repeat nearly
  free) and a blit (`endDraw` → `blitFrame`). THE BLIT IS THE PAINTED RECT'S
  SINCE 2026-09-13 (`groundEndDraw`): the drain's slices, the flush's union,
  the cell repaint's clip on the scratch and its copy-back frame on the RT are
  scissored; the full paint and the scroll stay whole. Before that it was a
  full-texture blit whatever the bracket drew — 2.5 Mpx of fragments per
  bracket, six brackets in one cell-repaint frame on his phone (~30 Mpx,
  twenty screens), and his 03:53 run's `longWhy` put 66 of 69 long frames in
  `wait`, the compositor waiting on that fill. Inside the rect the texels are
  identical; outside it the scissor DROPS THE SPILL, and the spill was wrong:
  a band pass draws an op crossing the band edge whole (the clip decides
  whether, never what — the zigzag fix), and the whole blit then laid those
  earlier cells' pixels over later cells' in a 13-45 px strip past every band
  edge — measured 3.5-7.7k texels per latch that had been exact (the kept
  picture equals a full paint texel for texel; the spilled strip did not).
  The band's own difference from a full paint (2.6-10k texels inside it) is
  the compositions it still owed (15-734 `boundary` owed at the moment of
  judgement), which the landing repaint settles, and is the same either way.
  `__ml.groundBracketParity(sx, sy)` scrolls the ground itself by a latch step
  and compares all of it; gated by `scripts/verify-groundbracket.mjs`.
  `groundDrew.blitMpx` counts the blitted texels a window (headless, a 288 px
  latch: 0.43 Mpx against 2.12; nine cells: 0.47 against 4.24), `scissor`
  says which way ran; `?groundscissor=0` restores the whole blit (its Settings
  row went on 2026-09-13 with the other decided switches). A drain that pays both bands of a diagonal latch in one frame unions
  to most of the texture — the phone pays ~one slice a frame, so its blits
  are one slice each. The stamp that opened its own whole-target bracket per
  cell repaint batches into the scratch's bracket (`skipBatch`). 384 px still
  gives 4-8 slices.
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
- **THE GROUND AHEAD IS COMPOSED OFF THE FRAME THREAD** (`composeworker.ts`,
  `composeclient.ts`, `Tiles3Textures.landRemote`, 2026-09-12; maintainer:
  "a background thread that prepares the world you are next to enter …
  You must not do everything on the main thread!"). Every boundary
  transition and fade overlay is a job the factory posts to a worker the
  first time it is asked for: the worker fetches the plates itself (a cache
  hit — the ground loader asked for the same files), decodes them with
  `createImageBitmap`, reads them through an OffscreenCanvas, composes with
  the SAME functions the factory uses (`buildPlatePixels`,
  `buildBoundaryPixels`, `fadeOverlay` — one code path, so the rasters are
  byte-identical: unit test in tiles3draw.test.ts, live audit
  `__ml.composeWorker({audit:true})`, gate `scripts/verify-compose.mjs`)
  and posts the raster back with its buffer transferred; the frame thread's
  whole cost is one `texImage2D` of 11,776 bytes (`counts.composeApplyMs`).
  Until a raster lands the cell draws its plain plate and sits in the owed
  set, exactly as a budget-refused composition did, and the directional ring
  asks AHEAD of the camera, so on a walk the raster is there before the cell
  is. Jobs batch into one message a frame; a raster from a rebuilt factory's
  generation is dropped; a worker that fails to boot, dies, or is switched
  off (`ml-compose-worker`, `__ml.composeWorker(false)`) leaves the factory
  composing here as before, and a key the worker cannot fetch is composed
  here too. NOT build-time packaging (maintainer: the pairs × patterns × set
  members "will grow insane") — the compositions stay per-cell at runtime,
  they just happen on another core, ahead. What still builds on the frame
  thread: conformed plates and foot bands (5-9 a window, cached for the
  session) and the resolution of the ring's cells (the resolver worker,
  `ml-resolve-worker`, is off by default). Beacon: `run.sim` carries `/cw`
  while the worker is ready; `counts.composeQueued/Landed/Missed/WorkerMs`.
  `T3_BOUNDARY_LAND` = 12 caps how many landed cells one frame repaints.
- **COMPOSING ON THE FRAME THREAD IS BUDGETED, AND A CELL WITHOUT ITS
  TRANSITION YET DRAWS THE PLAIN PLATE** (`Tiles3Textures.armCompose`,
  `GROUND_COMPOSE_MS` = 2; the path the worker's fallback takes). One
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
- **`longWhy` SAYS WHY A LONG FRAME WAS LONG** (2026-09-13). Every frame over
  HITCH_LONG_MS is classified at report time: `task` — a browser `longtask`
  overlapped the interval the beacon counted as idle (GC's idle-time tasks, a
  touch handler, a patch we do not time); `gc` — the JS heap dropped >= 16 MB
  across the frame (a collection ran in it, our own JS included); `wait` —
  neither: the thread was free and the next frame did not come, which is the
  compositor waiting on the GPU. `{n, wait, task, gc, taskMs, waitIdleMs,
  gcMb}`; each `worst` record carries `dh` (heap MB across the frame), `w`
  and `lt` (overlapping task ms) EARLY in the record, where the 1200-char cap
  cannot reach them. Read `cells:unattributed` against it: `wait` is the
  ground path's GPU fill (its whole-target clear + blit per bracket, the
  cover atlases' old tax), `task`/`gc` is the main thread. His 03:13 run on
  95af8a01c had 42 of 55 long frames in one window as idle gaps of 35-120 ms
  with nothing of ours in the frame; the window's 2 long tasks (217 ms) match
  its two CPU-heavy frames, which already argues `wait` — this settles it per
  frame.
- **THE BEACON DELIVERS EVERY WINDOW, AND THE RUN SAYS WHY WHEN ONE IS LOST**
  (2026-09-19). His 20:52 run posted windows 1 and 2 and nothing after, and
  no page load on record had ever delivered a third (14 loads, 26 reports:
  never more than two posts each) — and nothing on either side could say
  whether the posts were made, refused or lost in the commit, because the
  post was one keepalive fetch, fire and forget, its response never read,
  its failure swallowed. The rule now: a window goes into an OUTBOX
  (`perfPost`/`perfPump`) and is posted from there one at a time, 6 s after
  a success, 15 s after a failure, retried `PERF_POST_TRIES` (3) times and
  kept AHEAD of newer windows (`PERF_OUTBOX_MAX` 6, the oldest dropped and
  reported past that); a live page posts WITHOUT keepalive and READS the
  response (keepalive is for a page that is going away, and a keepalive body
  counts against the browser's 64 KiB in-flight budget until its response is
  consumed); only the final flush of a HIDDEN page goes at once with
  keepalive, because the pump's timer does not run in a frozen page. Every
  outcome lands in the client's ledger, which every window carries as
  `beacon` — `sent/ok/failed/retried/lastStatus/lastError/lastOkWin/queued`
  and `attempt`, stamped at POST time (a retried window carries the refusal
  that preceded it) — and a failure is also told to the server on a second,
  tiny channel (`navigator.sendBeacon` to `/api/perf/fail`, text/plain: the
  one type it may carry without a preflight). THE SERVER KEEPS THE LEDGER:
  every `/api/perf` outcome (status, ms, bytes, run, window, the GitHub
  error) and every fail note land in a ring served at `GET /api/perf/log`
  (memory; `since` says when the container started) — `curl
  https://nangijala.online/api/perf/log` after a run answers "did the posts
  arrive, and what happened to each" without a phone console. The flat
  `PERF_MIN_GAP_MS` is a TOKEN BUCKET (`PERF_BURST` 3, one back every 5 s):
  the flat gap (20 s, then 5 s) ate the flush that followed a window, and
  a retry now legitimately follows the next window within seconds. Two more
  losses this run found: (1) THE FILE RESET AT 1 MB — the contents API
  answers a file over 1 MB with `content: ""`, the handler parsed that as an
  empty history and REWROTE the file with the one report in hand (2026-09-13,
  at 1,078,993 bytes: every report before 02:02 gone in one commit);
  `perfDocMerge` (pure, `perfdoc.test.ts`) now caps the file by BYTES
  (`PERF_KEEP_BYTES` 800 KB, the oldest dropped first, the new report always
  kept), writes one report per line without indentation (~30% smaller than
  the indented form), and the read goes through `ghGetContents`, which
  falls through to the blob API past 1 MB and THROWS on an unreadable base
  rather than start from nothing. (2) THE REMEMBERED SWITCH — his first run
  today: the beacon had been ON since the 09-13 runs (nothing turned it
  off), so the tap he made to START recording turned it OFF at 47 s and the
  whole map ran unrecorded (one 8.4 s flush, `winIdx` 1). A remembered
  switch now expires after `PERF_REMEMBER_MS` (3 h) with no window posted
  (`ml-perf-beacon-at`, refreshed by every post that gets through). And the
  FIRST WINDOW STARTS AT ARMING: `perfArmBaselines` resets the round trips,
  the patch count, the input entries, the long tasks and the effects' meter
  (his 20:20 window read rtt p90 531 ms and 76 patches/s over 8 s of play
  because 38 s of boot were in them). `perf-read.mjs` prints a `posts`
  column (`ok/sent`, and the last failure). GATE: `verify-beacon.mjs`
  refuses the first post with a 502 and requires the SAME window posted
  again with `attempt` 2, a ledger saying `failed` 1 / `lastStatus` 502,
  and a fail note — the old client posted window 2 next and never window 1.
  A STATIONARY WINDOW POSTS AGAIN — the first `PERF_STILL_MAX` (6) after
  the last move (`run.why` = `still`), so a standing A/B of the Settings
  switches lands; past six the beacon waits for movement or a bad window,
  so a beacon left on over an idle hour does not evict the runs before it.
- **THE LAG WHILE RUNNING IS THE GPU, NOT THE FRAME'S JAVASCRIPT** (his
  22:29 run on bc32342724, 507 cells, every window delivered): 36-45% of
  frames miss the 60 Hz deadline by a little (17-34 ms; mean 17.7-19.2 ms,
  p90 20-34) while running AND standing in the town, with only 10 frames
  over 50 ms in 98 s — the felt lag is the uneven cadence, not the
  hitches. Of the 96 slow frames recorded, 67 were the thread IDLE for
  24-40 ms after 3-8 ms of our JavaScript, with no long task and no GC:
  the compositor waiting for a frame the GPU had not finished; 26 were
  the fresh-terrain CPU stack (one 102 ms ground slice, repaintCells 24,
  rebuildOccluders 15, occWalkInc 10, render 16 in one frame); one a 149 MB
  major GC (101 ms). The GPU waits cluster in the town and its approach
  (39 of 67; all 24 recorded frames of the standing window at zoom 2 in the
  evening) but the over-budget share is the same at the spawn by day with
  no covered body (38%, the 20:20 window) — a cost that does not scale with
  the sprite count. The candidates it must be split between, by the
  counters: the lighting pass (3-5 shadow-marching lights at all times of
  day — the torch is on by day too — three 544x734 fields a frame plus
  the composite and 20-46 lit copies), the cover atlases (5-6 flushes a
  frame while standing among the town's bodies, three brackets each — a
  render-target switch is the dear thing on a tiled GPU), the ground
  texture's blit and the sprites' overdraw (5-10 stacked a cell). The
  software renderer cannot proxy a Mali (skipping the whole night pass
  moved its frame 0%), so the split is measured ON THE PHONE: the finish
  clock above, standing at one spot for 30 s per Settings switch —
  baseline, `lighting pass` off, `shadows` off, `scenery lights` off, the
  torch off, the resolution dial at 2/3 — each window naming its arm
  (`lights.pass`, `lights.sceneryShadows`, `lights.torch`, `run.sim`'s
  `/rN`). What that run names is what gets optimised; nothing before it.
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
  throttling, not the game); `gpu` (frame time p50/p90/p99 from
  `EXT_disjoint_timer_query` where the browser lends it — Phaser 3 is WebGL1;
  the `_webgl2` form is tried first — and otherwise from THE FINISH CLOCK
  (2026-09-19, `gputimer.ts`): his phone's Chrome lends no query to WebGL1,
  so every run before carried `avail: false`; now one frame in three ends
  with `gl.finish()` while the beacon is armed, and the wall time it blocks
  is the GPU work still outstanding at that frame's end — near zero when
  the GPU keeps up, the GPU's own frame time when it does not. `method`
  says `query` or `finish`, `every` the sampling stride; the sampled frames
  read longer in the histogram by what they waited, which is the price of
  a number where there was none. `avail`+`reason` first: "no numbers" is
  never 0 ms); `frames` now
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
- **THE RESOLVER, THE SCENE'S LISTENERS, THE TAP AND THE RUN'S SETTINGS ARE
  IN THE REPORT** (2026-09-19, before his optimisation run on the six days
  of new code since the last one — "make sure all data you need is being
  captured"). What the 09-13 runs could not say, and now can: `resolve` —
  the ground resolver has run ON THE FRAME THREAD in every run he has sent
  (`worker.state` off in all 23 windows) inside groundSlice/prefetch/
  repaintCells with no line of its own; now cells, boundaries and decks
  resolved this window with their summed ms and µs per cell (tiles3runtime
  `bill`; Chrome coarsens `performance.now()` to 100 µs, so one call is
  noise and the SUM over a window's thousands is the number, unbiased), the
  fade scan's cells, neighbour visits and placements (tiles3 `stats` —
  (2·reach+1)²−1 = 80 visits a cell at his reach 4 against 24 at render3's
  2, plus a road's alt scan; the fade rule is the newest code in the
  resolver) and the worker's state so 0 ms cannot mean "somewhere else";
  `groundDrew.fades` (cells drawn wearing a fade) and `groundDrew.fadeTex`
  (fade scatter textures built this window — a pick that welcomes the whole
  pool at the edge wears more distinct files, each one compose and one
  upload). Two sections that were `other` in every run: `preUpdate` (Phaser's
  own systems on the scene's PRE_UPDATE — the update list stepping every
  animated sprite, tweens, timers) and `hooks` (every listener on its UPDATE
  event — the ambient effects mount there from outside,
  `ambient/runtime/mount.ts`), timed by wrapping the scene's own emitter so
  the listener order does not matter; and `ambient`, the effects' own meter
  (`__mlAmbient.cost(true)`, the probe their QA reads): mean ms a frame and
  the peak per effect, with a `_` row for the HUD's mode (zone/forced:N/
  none) and the director's episode. `input` — THE FELT LAG (Event Timing
  API, `inputSummary` in perfextra.ts): input delay (hardware timestamp to
  first handler — how long the thread was busy when he tapped) and
  tap-to-paint duration, p50/p90/max, events over 100 ms, the worst named;
  entries under 16 ms never arrive, so `n` counts noticeable taps; `avail`
  first, Safari has none. And `run.fade` (reach/amount/falloff — what the
  scan costs), `run.ambient` and `run.lane` (fast lane or container: the
  bundle differs while the image sha line reads the same), so two windows
  are known to be comparable before their numbers are. `perf-read.mjs`
  prints `res ms/us` and `inp90/max` per window, an ambient line, and
  `--diff` carries all of them. Sections cap raised 40 → 64 (36 arrive).
  Gates: `perfreport.test.ts` (each block survives, the cap keeps the last
  section), `perfextra.test.ts` (the input summary as arithmetic).
- **A LONG FRAME NOW SAYS WHERE ITS TIME WENT** (2026-09-23, before his next
  run: 20 of the 22 long frames in the 22:53 window were `cells:unattributed`
  — no section owned a quarter of them — and the beacon could not say whether
  the thread had WORKED, WAITED or been HELD). Four instruments, all armed
  with the beacon and off otherwise:
  `loaf`/`loafBy` (`client/src/perfloaf.ts`): Chrome's long-animation-frame
  entries, the browser's own ledger of every frame over 50 ms — `pre` ms of
  tasks that ran BEFORE the rendering update (a socket patch, a worker
  landing, a timer, an input handler), `raf` inside the rAF callbacks (our
  frame), `dom` in style/layout/paint (the HUD's bill), and the invokers over
  5 ms by name ("WebSocket.onmessage", "Worker.onmessage",
  "TimerHandler:setTimeout", "FrameRequestCallback"); `state` first, because
  "unsupported" must never read as "no long frames". Each worst-frame record
  carries its own entry as `loaf`, matched by time when the report is built
  (the browser reports a frame after it closed).
  `gl.dc/vt/fill/fillX/fb/cl/clMpx/rd` (`client/src/glframe.ts`) and their
  window means (`counts.glDraws`, `glFillMpx`, `glFbSw`, `glClears`,
  `glReads`): the GPU's bill counted at the API — draw calls, vertices, the
  MEGAPIXELS the pipelines' triangles cover (read off the vertex buffer at
  BEFORE_FLUSH, `perfextra.ts triFillPx`; the unit a tiler pays in),
  framebuffer switches (a tile flush each on a Mali), clears with their area,
  and sync points (readPixels/getError/finish — the finish clock's own
  gl.finish counts, one in `gpu.every` frames). `glPrev` carries the frame
  before, because that is what the GPU is paying for: a long frame with a
  short `render`, a big `gapIdle` and a big `glPrev.fill` is GPU-bound.
  `gap` on the record and `counts.gapNetMs/gapComposeMs/gapResolveMs/gapArtMs`
  (`client/src/gapledger.ts`): OUR share of the busy gap — the socket's
  message handler and the three workers' landings bill themselves. Busy gap
  minus the ledger is a foreign task, and `loaf.by` names it.
  `lag` on the record and `counts.rafLagMean/rafLagMax`: how late Phaser's
  STEP began after its rAF timestamp — what ran ahead of the frame — for
  EVERY frame, where the LoAF split covers only the long ones. THE GAP ENDS
  WHERE THE STEP BEGINS: `preUpdate` and `hooks` run between the gap probe's
  message and `update()`, and the first Beacon 2 run counted them twice —
  as their sections and again inside `gapIdle` (hooks 831.9 inside gapIdle
  833.7 on one frame; every "idle" census was the ambient mount). Fixed
  2026-09-23; a run before that date reads `gapIdle` as `hooks + idle`.
  `longGroup` is the census read by GROUP (`sectionGroup`: ground, occ,
  light, sim, render, gl, engine, hooks, busy, idle, other) with idle and
  busy IN the argmax — beside `longWhy` (wait | task | gc, 2026-09-13), which
  says the population and this says WHICH work owned it:
  "cells:unattributed" in `longBy` is "cells:occ" (the occluder rebuild ran in
  a slice frame — a scheduling fix) or "cells:idle" (waiting on the compositor
  — a GPU fix) here. WHAT HIS FIRST RUN ON IT SAID (2026-09-23, 17:34-17:39,
  build dcead651f, ten windows): p50 30 ms and 120-206 frames over 50 ms a
  window against p50 17 and 1-19 on 09-19 — and the difference was `hooks`,
  the scene's UPDATE listeners (the ambient mount): 8.5-17.9 ms a frame
  MEAN, the dominant section of 1,705 of ~1,900 long frames, all of it
  inside the rAF callback by the browser's split (`loaf.raf` 3.9-13.1 s a
  window against `pre` 0.3-1.5 s), the GPU idle (the finish clock p50 0.0).
  The mount's own meter held ~5.5 ms of it (foam 2.4); the rest was its
  10 Hz env tick — the mist raster and the coverage grids, where every memo
  miss resolved a cell against all ~96 zone polygons twice and the picker
  memo was dropped whole at its cap (`ambient/README.md`, the field's rules
  since). The `ambient` block now carries the tick's parts (`_env`,
  `_gloom`, `_director`, `_frame`) and the field's counters (`_zone`), so
  the next run says what a tick costs. Measured offline on the_game's 96
  zones (desktop; his phone is 3-5x slower): a walking tick 18.4 -> 2.5
  ms, a standing one 5.3 -> 0.09 ms, a cold cell 173 -> 34 µs. Rejected: `performance.memory` per frame as a GC signal
  (bucketised and refreshed every 20 minutes without a flag); the WebGL1
  timer query (his driver withholds it — `gpu.reason`). GATE:
  `verify-beacon.mjs` opens its page with service workers BLOCKED — the
  installed app's `sw.js` answers fetches itself and a page route never
  sees a request the worker handled (the POST reached the dev server, 503,
  while the gate said "no POST"; chromium-1194, 2026-09-23).
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
