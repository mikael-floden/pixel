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
  answered by STOP REDOING WORK THAT DOESN'T CHANGE below and the fast sort
  (`docs/depth-sort.md`).
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
- **A LANDING COSTS A BOUNDED AMOUNT PER FRAME** (Task 1, games-perf on the
  maintainer's order, 2026-09-24: "still laggy ... not a smooth stable FPS").
  His 14:01 run: the long frames were the art-streaming frames — 516 on the
  occluder group (27 s of a 160 s run), 299 on the ground group; every
  terrain batch (13-42 a window) re-walked EVERY incomplete cell of the
  window, then rebuilt the scenery and the cover index in full
  (`rebuildOccluders` 10-47 ms, `rebuildScenery` 6-21, `coverIndex` 3-7),
  and repainted every landed cell in one pass (`repaintCells` 29-79 ms).
  Three bounds: (1) a landing walks THE INCOMPLETE CELLS read off a set the
  walk keeps (`occIncomplete`: a cell enters when its walk left it
  incomplete, leaves when a walk completes it or it leaves the window) and
  never scans the window for them — the same cells as before, wherever
  their file came from (a plate the ground pass never asked for, a
  neighbour's, a sheet), at the cost of those cells alone; a step or a cut
  walks the window as before. (Not the cells a landed FILE fed, from
  `t3missing`: the ground pass registers only the cells it paints, and the
  occluder window reaches `maxLevel*lh` below the ground texture — a tall
  column whose footprint is below the screen would have kept its missing
  top until the next 96 px step.) (2) A terrain landing leaves the scenery
  alone — placements, lit copies and lights depend on the camera and the
  scenery art, not on a plate that streamed in — so `rebuildScenery` and the
  destroy of the lit copies it recreates run on a step, a cut, a full walk
  or a scenery/manifest landing (`occSceneryDue`); with nothing created and
  nothing left over the occluder set is the set it was (the flat views, the
  near index and the cover index stand), and the cover index is rebuilt
  when either set changed. The scenery's own depth records RIDE ALONG in
  `occluderMeta` when the scenery is not rebuilt (`sceneryMeta`: the flat
  list is rebuilt from the cells' buckets and only rebuildScenery pushes
  them — the first terrain batch after a teleport dropped every bed a body
  sorts against, and the body drew under the one in front of it,
  verify-scenerysort's fifth spot), and a landing whose walk added or
  dropped records re-resolves the drawn pieces' depths alone
  (`resolveSceneryDepths`, section `sceneryDepth`, from the anchors — the
  pieces resolve against each other's DRAWN depth): the lift over the floor
  tile in front of a bed is read off the terrain records, and an incomplete
  cell has none until its art lands. (3) The landing repaint paints column-sorted
  chunks of `GROUND_REPAINT_CHUNK` cells (narrow bands: the rects stay
  small, the total area is the split pass's) until `GROUND_REPAINT_MS` (5)
  has gone and carries the rest (beacon counts `cellRuns`/`cellCarried` per
  window) — the same
  pixels a frame or two later; a chunk that poisons the latch ends the
  carry. Gates: verify-occinc (the incremental set equals a full rebuild),
  verify-scenerysort, verify-indoorscenery, verify-scenerycover,
  verify-lit-order, verify-beacon. (verify-zonehop's 5-frame floor is a
  headless box's speed, not the code: there the hop joins in 2.5-3.5 s and
  its 3 s watch records 2-4 frames on main with nothing changed, where his
  phone joins in 204-243 ms and records 68-121 — games' gate.)
- **THE AMBIENT TICK COSTS A BOUNDED AMOUNT** (Task 2 of his order,
  games-perf 2026-09-24). His 14:01 run, ~9 ticks a second: `_gloom` 2.8-4.2
  ms PER TICK (raster 2.2-3.3, field 0.5-0.7, mask 0.2) and `_director`
  0.9-1.7 (peak 104) — a 4-6 ms bump every fifth frame on top of `hooks`'
  3.5-7.4 ms/frame. The raster's memo hit still walked every lattice sample,
  allocated six arrays and ran four whole-grid fill passes; the director
  asked coverage per episode, each a pick and four blurs per sample. Now a
  standing camera's raster is a copy of the last filled answer, a moved
  window copies its overlap by rows and looks up its edge, the fill runs
  over the off-map samples alone, and coverage picks the view once per tick
  and reads 0 for an effect with no zone box in reach (`zonefield.ts`,
  law and numbers in `ambient/README.md`). Next in the ambient line: the
  per-effect scan peaks (foam 9-13 ms every 450 ms, windy 11.7, water 9.8,
  dragonflies 8.3) spread over frames.
- **NO FULL GROUND PAINT IN PLAY** (maintainer 2026-09-24, "fix ground repaint
  on zone hops"). His 14:01 run's `mode: full` frames were 45-226 ms, one or
  two a window — not the hops as such: the coalesced full repaint
  (`repaintGroundPending`) and the landing repaint's more-than-half-the-
  texture fallback, each poisoning the latch so the next latch painted the
  whole texture in one frame. Both now go through `queueFullGroundSlices`:
  with a latched picture whose cut is the drawn one, the whole texture is
  queued as bands into the scroll's slice queue (`GROUND_SLICE_MS` a frame,
  the same clipped pass, the same pixels; appended behind a scroll's bands,
  never flushed synchronously) and the picture stands until each band
  lands; the first paint, a poisoned latch, a changed cut (repaintWorld, the
  indoor flip) and the legacy modes paint in full as before. Beacon counts:
  `fullSliced` beside `fullPaints`; the mode census gains `sliced`.
  `__ml.groundHash` flushes pending slices first, so verify-cave's
  ground-equals-full-paint check still reads a settled picture.
- **A BAND PASS DOES ONLY THE BAND'S WORK** (2026-09-24; his 16:50 run:
  `groundSlice` 12-28 ms and `repaintCells` 17-65 ms PEAKS in every 30 s
  window — the worst frames, which are what he feels). A band pass (a scroll
  slice, a cell repaint, a drain group) walks only the cells whose column
  can reach its rect: the cell's level's top (`- T3_TOP_Y - lh`) to its base
  (`+ T3_TILE + lh`), the rect grown by a tile each way for the corner
  lattice's boundary — rejected BEFORE the resolve by the doc's level + 1,
  then by the resolved level; a deck by column, then at its own level
  (`reaches` in drawTiles3Ground; `?groundtight=0`, Settings→Dev "ground:
  tight band"). And it builds NO PLATE on the frame thread: an unbuilt plate
  is a `plate` job on the compose worker (tiles3draw `deferPlates`,
  `postPlate`; the worker's memoised side raster, copied), its op dropped
  and the cell owed, exactly as a boundary; the ring prefetch defers the
  same way; a full paint builds as before (`?grounddefer=0`, "ground: plates
  off-thread"). THE WORKER'S LANDING IS A LANDING: the drop drain fires on
  the loader's idle edge, which a worker raster never makes — in an area
  whose art has all loaded a deferred plate stood as a hole until something
  else loaded — so a landed plate or fade arms it (`t3remoteLanded`: drained
  once the worker is idle or every `T3_REMOTE_DRAIN_MS` 400 while busy), and
  a drop arms the drain while the worker holds a job. A LANDED PLATE IS A
  BUILT PLATE: it enters the factory's built-plate memo (`plates`), which is
  where `lid` finds a lowered wall's base — a raw-registered texture cannot be
  read back, so without it the lid fell back to the undarkened plate for the
  session. Built plates and decoded sources are TWO memos (`plates` by the key
  the raster is drawn under, `pix` by art key): a plain plate's plateKey IS
  its art key, and one map let whichever ran first win — the render A/B drew
  grass clean.webp's band in palette wall (20,100,78) on one load and top
  (20,82,59) on the next (tiles3draw.test.ts "never share a memo", "worker
  landed"). MEASURED headless at
  his worst spot 229,256 (`scripts/probe-groundslice.mjs`, a 1.5-cell walk):
  a 289x492 slice walked ~825 cells for ~135 inside its rect, made ~3,500
  ops of which ~1,700 the clip threw away, and built 5-23 ms of plates;
  with both cuts the worst slice 48 → 25 ms, all slices 154 → 80 ms (258,217:
  27 → 20, 116 → 64). WHAT IS LEFT is the first resolve of cells (16-20 ms
  in the worst slice): the resolve worker is off by his 09-08 verdict.
  Gates: verify-groundbracket.mjs `tightCmp`/`cellsTightCmp` (band and cells,
  tight off vs on over the poison, identical), verify-compose.mjs (every
  worker raster, plates included, audited byte for byte).
- **A CELL REPAINT IS THE CELL'S SIZE** (2026-09-24; his 21:13 run on
  310bbf0439: ground work dominated 1,367 of ~1,900 long frames, `repaintCells`
  6-14 ms a frame MEAN, 350-780 repaint runs a window at ~13 ms each, 278-3,637
  landed cells carried a window past the budget). A landed or owed cell's rect
  ran from the world's highest storey (`maxLevel` 40 x 15 px, ~700 px tall)
  down to its base whatever stood there, and a batch was 12 cells sorted by
  COLUMN — cells of one column lie on a screen diagonal, so a batch's rect
  could span the texture. Now (`groundRectOn`, `?groundrect=0`, Settings→Dev
  "ground: tight repaint") the rect runs from the cell's OWN top
  (`t3cellTopLevel`: the doc level, the resolved level, its decks, + 1 storey)
  less `T3_TOP_Y + lh + T3_TILE`, and a batch (the landing's chunks, the drain's
  groups) stays inside one 8x8-lattice screen block (`t3repaintBucket`).
  MEASURED headless (`scripts/probe-repaint.mjs`, his worst places 96,244 /
  104,240 / 168,120 / 328,232): mean rect 194x686 → 141x302, cells walked a
  repaint 675 → 338, draws 1,667 → 813; verify-groundbracket's 9-cell repaint
  copies 163-194 k texels against 302-476 k. SAFE BY MEASUREMENT: the extent
  check (`__ml.groundExtentCheck`) draws each of 250 cells alone into the
  cleared scratch at each place and requires no texel above its sized rect —
  1,000 of 1,000.
- **REPAINT ONLY WHAT CAN BE SEEN SOON** (2026-09-24, same run). Measured
  headless (`scripts/probe-repaint.mjs`, `why`/`inView` in
  `__ml.groundRepaintLog`): 92% of the cells a landing or a drain repainted
  lay outside the camera's view — the ground texture is ~14x the screen, and a
  landing repaints every cell that asked for the file wherever it lies. Now a
  landed, owed (drain) or flipped (indoor) cell is repainted only when its
  column is within `GROUND_NEAR_PX` 256 of the view (`t3keepNear`); a farther
  one is PARKED (`t3stale`) and brought back to the landing repaint when the
  camera comes that near (`t3promoteStale`, on 16 px of travel or every 15
  frames), forgotten when it leaves the texture (the band paints it fresh if it
  comes back), and cleared by any full paint. THE CONTRACT MOVES WITH IT: the
  texture equals a full paint once nothing is parked — `groundHash`,
  `groundSnapshot`, `groundSnap` repaint every parked cell first
  (`t3flushStale`), as they already flush owed slices. MEASURED headless on the
  same walks (his places 96,244 / 104,240 / 168,120 / 328,232), two A/Bs that
  disagree, so the honest number is the smaller: cells repainted 3,094 →
  2,539 (-18%; 1,121 of 2,459 parked cells left the texture unpainted), repaint
  runs about equal (promoted cells come back in smaller batches); the first
  A/B read 184 → 12 runs and did not reproduce. `__ml.groundStale().visible`
  (parked cells the camera sees) read 0 in 96 of 96 samples in both. `?groundlazy=0` / Settings→Dev
  "ground: repaint only near". ALSO MEASURED: plates on the worker (410d19f944)
  add ~30% repaint runs (the drain repaints the cells whose plate dropped);
  near-only makes most of those park.
- **THE SWIM FOAM BAKES INTO BYTES, NOT A CANVAS** (`foamTexture`,
  2026-09-24; found by the investigation's skeptic-verified candidate, 2 of 3).
  Every new foam key (frame x depth x tilt; a crossing of his loop's stepped
  stream at 151-179,126.6 misses about one a frame for 1.5 s) built a canvas
  with no `willReadFrequently`, a 2D context and a Phaser CanvasTexture, whose
  constructor reads the whole canvas back — a wait for everything the GPU has
  queued. His beacon matched foam bakes (`texFam` "f:") one to one with
  20-130 ms `avatarLoop` frames in every build that crossed water: 16 of the
  106 frames over 50 ms and 5 of the 9 over 100 ms in his best run. Now the
  crest's pixels are written into a byte buffer (3 px a column, each written
  once, alpha = the canvas's byte) and uploaded by `addUint8Array`, the
  terrain's own path. MEASURED headless (`probe-repaint.mjs --foam`, crossing
  that stream): canvas 11 bakes, mean 618 ms, worst 1,290 ms; bytes 25 bakes,
  mean 0.2 ms, worst 0.5 ms. `__ml.foamParity()`: 163 texels of a 112x112 bake
  differ by 1 (premultiply rounding of the translucent crest), the rest equal.
  `__ml.foamBytes()` reads the bakes' cost; `?foambytes=0` restores the
  canvas. Not converted: `ringTextureFor` already asks `willReadFrequently` (a
  CPU canvas, its read-back a memcpy); `bodyatlas` is not wired; `flippedKey`
  has no caller.
- **A BOUNDARY IS NOT A SECOND RESOLVE** (`Tiles3World.boundary(x, y, known?)`,
  2026-09-24). Since 24d722defc the boundary lookup resolved its cell again
  (a slope's boundary lives on the cell), uncached: 17-30 µs per boundary in
  his 21:13 run against 0.8-1.5 before. Callers that already hold the cell pass
  it — the scene's per-cell cache (`t3boundaryOf`), the resolve worker's own
  call just above; a null `known` re-resolves as before, so the error path is
  unchanged. MEASURED headless (`probe-repaint.mjs --boundary`,
  `__ml.boundaryParity`): 25,000 cells at five places, slopes 0% and 100%,
  identical both ways; 6-23 µs → 0.8-4 µs a boundary.
- **STOP REDOING WORK THAT DOESN'T CHANGE** (maintainer 2026-09-25, from the
  zero-hitches design; both on by default, Settings→Dev is the A/B).
  (1) THE DEPTH SORT re-places only what moved (`fastsort.ts`,
  `docs/depth-sort.md`; `?fastsort=0`, "sort: only what moved"): Phaser's
  comparator sort of the whole list every frame → one walk against the last
  order, then windows (a steady frame) or a merge (objects added or removed).
  Measured in node on Phaser-shaped objects: a steady frame 2.8-3.6x cheaper
  (4,277 objects, 19-150 moved: 83-326 µs against 238-987), a rebuild frame
  1.15-2x (600-2,000 removed and appended). Headless on his loop with ambient
  and monsters on: `depthSort` 1.13 → 0.74 ms/frame, and 1,220 of 1,220 sorts
  object-for-object Phaser's order (`verify-fastsort.mjs`). THE WALK IS THE
  FLOOR: it reads every `_depth` (megamorphic) — tracking depths through the
  setter instead would skip that, and was not taken: a depth written past the
  setter would then draw in the wrong order. Two first cuts were measured and
  dropped: merging into a buffer and copying the whole list back cost what the
  comparator did (0.29 against 0.25 ms), and a WeakSet for membership was half
  of a rebuild frame's sort (a number stamped on the object replaced it).
  (2) THE OCCLUDER BOXES are stored once (`occBoxes`, at creation in
  `occImage`; `?cullbox=0`, "cull: stored boxes"): the per-frame view cull and
  the cover index read four numbers instead of ~10 getters per occluder, the
  live rule's arithmetic operation for operation (an occluder's position,
  frame, origin and scale never change after creation), and a set change no
  longer builds the proximity cull's grid while that cull is off (read by
  nothing since 2026-09-12). Headless: `occCull` 0.98 → 0.53 ms/frame, 101,543
  occluder checks with every stored box and decision identical
  (`verify-cullbox.mjs`, `__ml.cullParity()`).
- **THE MAJOR COLLECTION: NO WEAKMAP OVER A CHURNING KEY SET, NO LOADER
  LEFTOVERS** (`genmemo.ts`, `loaderrelease.ts`, 2026-09-25, his "no
  recurring lag"; his cool run had a major GC about once a minute, 92-166 ms
  frames). The instrument is V8's own trace (`--js-flags=--trace-gc-nvp`,
  headless, a phone-sized 1 MB young generation, the same camera tour through
  new ground; forced full collections via `HeapProfiler.collectGarbage`).
  A major GC mostly FINISHES INCREMENTALLY and its pause is the marking left
  over. A WeakMap entry is an ephemeron (its value is marked only once its key
  is), and ephemerons whose values hold other tables' keys (a cell's ops name
  its art; the art keys the plate-key and top-only memos) are settled in that
  pause, round after round: with tiles3draw's four per-cell WeakMaps (19,925
  of the heap's ~20k ephemerons) the leftover was 26-62 ms a collection with
  V8's linear fallback firing (more than ten rounds), pauses 21-194 ms, 417 ms
  in all over 120 s; with bounded two-generation STRONG memos 0.7-9.3 ms,
  pauses 14-50 ms, 226 ms. The price is memory, and it shows in the other
  kind: an ATOMIC collection (`allocation failure` — the heap outran the
  marking; fired at 153 MB of objects under a 289 MB object limit but past
  the 213 MB GLOBAL one, which counts ArrayBuffers and Blink objects) marks
  the whole heap in the pause, 170-360 ms headless in every build; the memos
  keep evicted cells a generation longer (8.95 MB after the tour, live heap
  75 -> 83-86 MB), so that marking costs more. V8 bills an atomic marking loop
  to `mark.ephemeron.marking` whatever the ephemerons — read the linear
  fallback and the incremental leftover, not that line. Cap 24,000: the young
  generation holds the scene's ~4-6k-cell cache twice over, so a paint never
  re-promotes its whole window. THE LOADERS KEPT EVERY FILE: an image is its
  texture's source for the texture's life, its onload closure held Phaser's
  File, and `File.destroy` never drops the XMLHttpRequest or its response
  Blob — 1,524 requests, 4,571 handlers and 1,187 Files after a 90 s tour;
  cleared at FILE_COMPLETE on the terrain loader and the scene's, 11 / 16 / 5
  (the image untouched). Its tracing time did not move measurably; the memory
  it frees counts toward the global limit. `usedJSHeapSize` counts ArrayBuffers
  (a 100 MB buffer read +99.6 MB in Chrome 141), so the beacon's `heap` block is
  mostly texture pixels, not objects.
- **THE SPRITE BATCH BOXES NO NUMBERS AT ITS OWN CALL** (`batchpatch.ts`,
  2026-09-25). `render` was the largest allocation of every window of his cool
  run (105-285 KB a frame, ~40% of all; the young generation collected ~18
  times a second): Phaser's `MultiPipeline.batchSprite` hands twenty numbers
  to `batchQuad`, too big to inline, so every corner, UV and packed tint (a
  uint32 past the Smi range) became a HeapNumber at the call. The patch is
  the same function with `batchQuad`'s 42 stores and the tint packing written
  inline — the same values into the same vertex slots, so the render A/B
  harness (`--ls ml-batch-patch=0,1`, 1079x1416, day, swimming, indoor,
  night) reads 0 differing pixels. Headless, standing: `batchSprite`
  61.0 -> 21.5 KB a frame (the rest is its matrix calls, and the scenery-lit
  copies, which keep the original). Only a pipeline whose `batchQuad` is
  Phaser's own takes it (scenery-lit and PreFX override it; LightPipeline has
  its own `batchSprite`); it copies Phaser 3.90.0 and turns itself off on any
  other version, so an upgrade falls back to Phaser's code, never to a wrong
  one. `?batchpatch=0` / `ml-batch-patch` "0" is the A/B.
- **THE RECORDER NEVER STALLS THE GAME IT MEASURES** (maintainer 2026-09-25:
  "I can't have a lag that is due to the perf run itself when I try to
  evaluate the performance... This might result in me pushing you to fix the
  lag forever"). The frame only asks whether a window is due. The report is
  BUILT in the next idle period — the snapshot, the body, the worst frames
  taken and their timelines PACKED (`tlPack`: names as indices, times in a
  Float64Array) — and POSTED in another: this thread writes three JSON strings
  (the body, the worst records, the LoAF ring) and hands them with the pack to
  THE REPORT'S WORKER (`perfpost.ts`), which shapes the worst frames
  (`perfshape.ts` `shapeWorst`, the one function both paths run), writes the
  wire JSON and fetches; the outbox, the retries and the ledger stay here. The
  CPU benchmark runs on that worker; the renderer's name is asked behind the
  loading screen (`getParameter` is a GPU round trip: 620 ms headless in the
  first report); the ground texel census (a 256x192 `gl.readPixels`, a full
  GPU sync — 630-1,360 ms per window headless, the bulk of his 07:19 run's
  `beaconSelfMs` 34-65) runs on the FINAL flush only (`?beaconquiet=0` samples
  every window); the texture count is kept by the texture manager's events
  (`Object.keys` over ~10k textures was 3.9 ms a report); the long-task
  pairing is a sweep; every per-window percentile sorts NATIVELY
  (`sortedNums`: a Float64Array's numeric sort, the same values — a JS
  comparator over his windows' ~900 frame times and up to 3,000 load times per
  asset family was ~9 ms in node and the bulk of the report's 20-29 ms on his
  cool phone, 6f3f9f8a, where a headless window holds dozens). (IDLE TIME ALONE FAILED: his 15:51 run on a hot phone
  put the report at 58-95 ms between frames, all of it past any idle period —
  a saturated phone has none, so work moved out of the frame still stalls the
  next one; only work taken off the thread, or made small, helps. Not a
  structured clone of the objects: 5x the JSON of the same body, and a
  window's ~2,000-2,500 timeline marks were 1.4-3.0 ms of it.) Headless
  (`scripts/probe-beaconcost.mjs`; `?perfworker=0` posts on this thread, the
  bisect): the game's thread pays 3.4-6.7 ms a window (the report 2.2-3.5, the
  hand-over 1.0-3.2; 11 ms in the first, cold) against 7.2-26.6 ms with the
  post on this thread; the worker 4.7-10.7 ms. `counts`: `beaconSelfMs` the
  report (`beaconSnapMs`/`BodyMs`/`TakeMs` its parts), `beaconIdleMs` the hand-over, `beaconWorkerMs` the worker's share,
  `beaconOverMs` how far any of it ran past its idle period, `perfWorker` 0
  none / 1 made / 2 answered / 3 failed (a failed or 60 s silent worker is
  dropped and this thread posts). A hidden page's final flush builds and
  posts at once, here: no idle period is coming.
- **REJECTED 2026-09-24: "one ground job a frame"** (58da4b2202, reverted the
  same hour). It stood the band slice and the drain group down on a frame whose
  landing repaint had painted (his 21:13 run: 64 of 192 worst frames stacked a
  25 ms repaint and a 20 ms slice). Headless it took stacked frames 65% → 0%,
  but it removes no work: in a saturated run a landing paints almost every
  frame, so owed band slices pile up until the next scroll's unbudgeted
  `t3flushSlices` pays them in one lump — the redistribution he rejected on
  2026-09-03 ("SLICING ONLY REDISTRIBUTES", above), refuted 3/3 by the
  investigation's skeptics. Cut the WORK per second (the rect, the near-view
  rule), never move it.
- **THE FPS METER IS A DEV BUTTON** (maintainer 2026-09-24): Settings/dev
  "fps meter" mounts `fpsbadge.ts`'s corner readout (fps, worst frame,
  hitches over 5 s) and remembers per device (localStorage `ml-fps`, the
  same switch `?fps=1`/`?fps=0` sets); `unmountFpsBadge` takes it down. It
  counts the frames the game RENDERED (from the pacer) and tags "paced";
  a hitch is three vsyncs or more (over 45 ms — 50.0 is exactly three and
  straddled the old "over 50").
- **THE TERRAIN BAKE: RAISED TERRAIN IS DRAWN ONCE PER CHUNK, NOT ONCE PER
  SPRITE PER FRAME** (maintainer 2026-09-24: "I'm fully sold ... Let's do the
  entire work ... without changing the look and feel!"; `client/src/
  terrainbake.ts`, the pure parts in `terrainbakecore.ts` +
  `terrainbake.test.ts`, the gate `verify-bake.mjs`). His 16:50 run on
  0b274482: 2,200-5,600 occluder sprites in a 4,000-10,000-object display
  list, re-sorted (depthSort 2.0 ms), re-culled (occCull 1.0) and
  re-submitted (most of render 3.0) every frame, 18-27 Mpx of fill a frame
  (stacked courses overlap and a tiler pays for every quad), 16,433 live
  textures. The invariant that makes the bake exact: every occluder image on
  one diagonal row shares one base depth and the row's images are ordered
  inside an epsilon band no body enters, so a row's images composited once
  in that order and drawn as ONE quad at the row's depth sort, cover
  (coverDrawOccluders reads bounds, depth, texture) and light (the night
  shader resolves surfaces per pixel from world data) exactly as before;
  premultiplied "over" is associative. An 8x8-cell chunk (16 overflowed two
  1024^2 pages at the mountain: 31 segments, 448 ops) is walked with the
  live walk's own body (`bakeSink`: ops recorded at the floor of their
  position — the sprite's roundPixels floor — no images, no incremental
  state, no meta), its ops grouped into depth-row SEGMENTS (split at a gap,
  at the u%128 slot wrap, and at the atlas width), shelf-packed into the
  smallest atlas that takes them (256/512/1024^2, one capture-pool entry
  each; two 1024 pages at most), drawn in slices under `BAKE_MS` 2 with the
  ground's scissored end-draw, then one Image per segment stands and the
  cells' live images go (`bakeOnChunk`); the live walk emits no image for a
  cell a baked chunk owns (`emit` in tiles3Occluders) and still records its
  meta. OPT-IN (`ml-bake` "1", `?bake=1`, Settings→Dev "terrain bake"),
  AND THIS IS THE LAW THE BAKE PAID FOR: his 19:06 run on c2f857aad7, the
  bake on by default, read frame p50 34-63 ms against 17-23 the run
  before, `bakeStep` 7-10 ms a frame with 36-84 ms peaks, 170-390
  framebuffers a window ("it lagged even more"). The drawing got cheaper
  (draw calls 738-1,694 → 253-799 a frame, ~1-2 ms on a phone whose
  bottleneck is the main thread); the BAKING cost 7-10: the resolver
  composing for whole chunks the screen had not asked for, a texture and a
  framebuffer per bake (the capture pool's churn, back), a re-walk per
  landed transition. Nothing turns on by default on his phone before a run
  of his with it on shows the frame shorter; a headless gate proves texels,
  never milliseconds. The cost rules since: THE BAKE NEVER ASKS FOR ART —
  a cell is walked only when the live walk completed it (`walkable`:
  occCellState, incomplete false), the rest draw live inside the chunk;
  atlases come from A POOL PER SIZE (`bake:atlas:<size>:<n>`, frames
  `g<gen>s<i>`, the drawn rect cleared on reuse — an uncleared reuse showed
  the last occupant through a segment's transparency, 75,748 texels), kept
  over the indoor suspend and freed on the switch off; a landed transition marks a standing bake
  `stale` for ONE re-walk no sooner than `BAKE_REFRESH_MIN_MS` 5 s after
  its last (re-baked only if its ops' signature changed), live cells retry
  at 3 s doubling to 30; the budget is `BAKE_MS` 1 honoured per unit in
  five phases (walk, pack, prepare, draw, finish) each ending at the
  deadline — the pack between the last cell and the first slice was the
  untimed remainder that made 11 ms frames of 3 ms units; the atlas
  allocation inside it (a texture and a framebuffer, the one unit that
  cannot be sliced) made 17 ms frames where the pool was cold and 4 where
  it was warm, so `prepare` takes at most ONE new atlas a frame and idle
  frames warm the pool toward `BAKE_WARM` (2x1024, 4x512, 4x256, ~13 MB) —
  one bracket a frame, no slice on a frame that painted ground; the beacon's
  `peakSteady` is the worst frame that allocated nothing, and that is what
  the budget binds. LIVE, NOT BAKED: a sparse chunk (under 2 ops
  a segment: a village); the indoor cut-away (`suspend`: the mask rewrites
  columns per room); an edited cell (`dirty`: its chunk draws live from the
  next rebuild and re-bakes); an overflow. Resident atlases capped
  (`BAKE_MAX_ATLASES` 24) by last use; chunks bake nearest the window's
  centre first. MEASURED (headless, 412x732): the cliff top 258,217 draws
  2,451 sprites as 1,108 band images and none live; the mountain 277,269
  826 as 583; the object count is what falls, and it is worth 1-2 ms on
  his phone, so the bake is only worth having at a build cost under 1 ms a
  frame — his run decides. THE EDIT TOOL (Settings→Dev "edit tile" cycles
  the world's grounds; "place tile here", "dig here", "raise here" act on
  the player's cell; `worldEdit`): the doc's cell is mutated and everything
  derived follows the road a Settings dial takes — terrain grid, resolver
  (`initTiles3`: region fill, set picks, transitions), `repaintWorld`, the
  chunk dirtied, every standing bake refreshed. Client-side until the
  server learns edits (chunk 4): a dug cell walks by the server's level.
  Headless: grass/4 → water/3 → grass/4 at the cliff, parity identical at
  each step. The gate
  draws the baked chunks' ops DIRECTLY in the live order and their band
  images into two view-sized textures and compares texels (`__ml.
  bakeParity`); it also writes the before/after screenshots. Nothing is
  rebuilt at deploy: the bake runs on the phone from the world and art that
  ship today, and an edit is data. TRAP: the emit closure's own
  `occTint(occImage(...))` matches the regex that rewrote the eight emission
  sites — rewrite before inserting. Beacon row `bake` (chunks baked/live/
  waiting, images, atlases, ms, peak, bakes, evictions, dirtied, ops).
- **FRAME PACING: A STEADY 30 WHEN 60 CANNOT BE HELD** (maintainer
  2026-09-24, "The FPS is not stable! Think outside the box";
  `client/src/pacing.ts`, `pacing.test.ts`). His 16:50 run on 0b274482:
  frame p50 17.1-23.0 ms against a 16.7 ms vsync — the work sits ON the
  budget, so a third of the frames make their vsync and the rest slip to
  the next (17, 33, 17, 33) while Phaser's 10-tick smoothed delta (~25 ms)
  moves the world by an amount that agrees with neither: the alternation IS
  the instability. The pacer wraps the loop's callback (rAF still ticks
  every vsync; a skipped tick costs nothing): the step runs on the tick at
  or past `PACE_MS - vsync/2` — every 2nd at 60 Hz, 3rd at 90, 4th at 120,
  never an N/N+1 wobble on jitter — and after a long frame the next tick
  runs at once with no catch-up frame behind it (50 then 33, never 17).
  `auto` (default) locks when a quarter of a second's ticks arrive later
  than the 60 Hz frame plus half a vsync (a missed 60 Hz frame on any
  display: a 120 Hz phone holding a steady 60 on every 2nd vsync is never
  late), unlocks after 3 s of step work under 55% of the 60 Hz frame and
  never inside 15 s of the lock (a desktop holding 60 never locks, a phone
  at 15 ms of work never flaps); `30` always, `20` always at 20 (every 3rd
  vsync at 60 Hz — a CHOICE on his principle, 2026-09-25: "It's all about
  getting it consistent and predictable! ... we are better off running the
  entire game at 15 FPS" than with a dip that keeps coming back; his cool
  run's recurring dips were frames one refresh late at 30, 50 ms, exactly a
  20 fps frame), `60` never — Settings→Dev "frame pacing" cycles auto → 30 →
  20 → 60, `?pace=auto|30|20|60`, localStorage `ml-pace`. A frame is LATE
  past its own cadence plus 0.7 of a 60 Hz vsync (`paceLateMs`: 45 ms at 30
  or unpaced, ~62 at 20) — the FPS meter's hitch and the beacon's `late`
  both read it; the pace row's `hz` is the rate actually paced.
  The step's delta is the skipped ticks' smoothed deltas SUMMED and
  `game.loop.delta` is set to agree, so every ease, tween and animation
  keeps its time constant; the decision is on RAW wall clock (the smoothed
  value lags a hitch by ten ticks and would skip the tick after a slow
  frame). The vsync is each second's smallest tick gap (nothing arrives
  faster than the display); the skip threshold's period is NEVER RAISED — a
  second where every frame missed reads as a 30 Hz display, and a threshold
  built on 33 ms lets the next light frame through at 60 (an under-estimate
  is harmless: an LTPO panel dropping 120→60 still paces every 2nd).
  Rejected: Phaser's `fps.limit` — it sums the SMOOTHED delta against
  exactly 1000/limit, which two 60 Hz ticks reach only when neither jittered
  short (33/33/50), and it is bound at `start()`, not switchable. TRAP: the
  loop's callback is NOOP until `Game.start()` binds the step (after the
  default textures decode, later than `new Phaser.Game` returns), so the
  wrap is taken at the first PRE_STEP, never at construction (the probe saw
  zero steps; `paceInstall` test). The
  beacon's `pace` block (mode, paced share, `tickHz`, step work p50/p90/max)
  says why `frames.p50` reads 33; `perf-read.mjs` prints it as "pace". Half
  the steps a second is half the CPU a second: his window 4 ran the fixed
  benchmark at 21.4 ms — a throttled phone — and a paced game runs cooler.
- **AMBIENT SCANS AND BURSTS ARE BOUNDED PER FRAME** (Task 3 of his order,
  games-perf 2026-09-24). Inside his 14:01 run's worst frames the timelines
  marked `amb:foam` 6.7 ms mean / 11.1 max: foam's whole lattice walk in one
  frame, every 450 ms and per cell of travel; the per-effect peaks named
  water 9.8 (every wave and glint mark created in one frame) and fireflies
  10.1 (every fly spawned in one frame, five tries each). Foam's walk is a
  sweep (`scanBegin`/`scanStep` 1 ms a frame/`scanFinish`, the queue swapped
  when it lands); water and fireflies grow their pools a few a frame
  (`GROW_PER_FRAME`). Law in `ambient/README.md` (foam's scan paragraph,
  the pool rule). Dragonflies' scan-on-move (peak 8.3) is games-ambient's
  file in flight: posted to them, not edited.
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
  and `reconnects`); `cpu` (`xorshift400k-worker` scoreMs: the same work
  every window, on the report's worker since 2026-09-25 (`perfpost.ts`), so a
  window where it rose while the sections did not is the phone throttling,
  not the game — compare runs of the same `bench` only); `gpu` (frame time
  p50/p90/p99 from `EXT_disjoint_timer_query` where the browser lends it —
  Phaser 3 is WebGL1; the `_webgl2` form is tried first — otherwise
  `avail: false` with the reason. THE FINISH CLOCK (`gl.finish()` ending one
  frame in three) is OPT-IN, `?gpufinish=1`: on his phone it read 0.0-0.2 ms
  in every run — Chrome answers without waiting — so it measured nothing
  while forcing a flush into a third of the frames he recorded. "no
  numbers" is never 0 ms); `frames` now
  carries the histogram (`le17/le34/le50/le100/gt100`, `mean`) and `rafHz`
  (the refresh read off the 15th-percentile interval — 60/90/120, or 30 when
  the browser throttled the tab); and the snapshot counts are promoted to
  means (`litOccMean`, `monActMean`, `flushMean`, `sceneryImgsMean`). `heap`
  is THE WINDOW'S (`meanMb`, `maxMb`, `grewMb` summed rises, `grewMbPerSec`,
  `drops` = collections), reset with the window. `late` answers WHY A FRAME CAME ONE
  REFRESH LATE with nothing of ours running (glframe.ts): every frame's
  interval is filed under the PREVIOUS frame's draws (`dc_500` ... `dc_inf`),
  texture binds (`tb_`) and fill (`fill_`), as frames and `_late` frames (over
  45 ms, the FPS meter's hitch line). A late share that climbs with draws or
  binds is the GPU command stream (fewer, bigger batches — an atlas — cure
  it), with fill the pixels, flat on every axis neither; `perf-read` prints it.
  (His cool run 6f3f9f8a: ~156 of 168 worst frames were such idle waits at
  1,400-2,400 draws a frame; nothing on the page can time his GPU — no timer
  query, and the finish clock measured nothing.) `counts.glTexBinds` is the
  window's binds per frame. (Until 2026-09-25 its sums
  ran from arming: `grewMbPerSec` divided a running total by one window and
  read 24 -> 155 MB/s over his 15:51 run while the real rate held at 13-24.
  Earlier runs difference consecutive windows.)
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
  WHEN, NOT ONLY HOW LONG (Beacon 3, 2026-09-23, his ask: "add two
  datapoints at every metric: how long it took, and the real-time clock in
  ms when it started/completed — so we know how long we waited before this
  code started vs the old code ended"): every timed region reports its
  bounds to the frame's timeline (`client/src/perftimeline.ts`) — the
  sections (`pe`/`pAdd` pass inclusive bounds; self time still goes to the
  accumulator), the gap ledger's handlers (`gap:net`, `gap:compose`, ...),
  the ambient mount's bills (`amb:mist`, `amb:_env`, through
  `window.__mlPerfMark`), `gapBusy`/`gapIdle` themselves. A worst record
  carries it as `tl` = [name, start, end] relative to `pt0` (the frame's
  start on performance.now()), with `wall` = the frame's start in epoch ms;
  `perf-read.mjs` prints each timeline on the real-time clock with the WAIT
  from the latest end before a region to its start — the time nothing timed
  was running. Per window: `sectionsPeak` (each section's worst occurrence
  with its `t0`/`t1`), the ambient rows' `t0`/`t1` (their peak's bounds),
  `foam:parts` peaks with their starts, `counts.gap<Name>PeakMs/PeakT0`,
  `loaf.worstMs/worstT0`, the record's `loaf.t0/t1`; and the clocks:
  `counts.clock0` (epoch minus performance.now() — add it to any timestamp
  in the report for the real-time clock) and `counts.winT0/winT1`. Caps:
  worst record 8000 chars, counts 128 keys at 1e13, ambient rows 24
  fields, `sectionsPeak` 64x4. A mark is one boolean when the recorder is
  off; a frame makes ~70 and is capped at 256 (`tlDropped` counts the
  rest); a record keeps the frame's skeleton (`preUpdate`, `hooks`,
  `render`, `depthSort`, `gapBusy`, `gapIdle` — the waits between them are
  the question) and the longest of the rest over 0.05 ms, 80 in all (a
  headless frame's 256 marks made an 8.5 KB record and the cap cut it).
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
  ms, a standing one 5.3 -> 0.09 ms, a cold cell 173 -> 34 µs. THE EFFECTS
  THEMSELVES (the maintainer handed games-perf the slow effect the same
  evening, "it should still look nice"): foam, the costliest at 2.4 ms a
  frame along a shore, made a canvas texture per shore cell and a sprite
  per cell on its own texture; its sheets live in shared atlases now, one
  texSubImage2D per cell (`ambient/README.md`), and `ambient["foam:parts"]`
  carries its scans, bakes, installs and picks per window. HIS 19:53 RUN ON
  ALL OF THAT (6cfca955f, nine windows, 16 zone hops) was NOT better — p50
  34.5, 21-266 frames over 50 ms a window — and its own rows said why: the
  field's memos were unbounded (`_zone.blur` 113k -> 824k, heap max 408 ->
  900 MB, collections of 250-384 MB inside the tick = the 787/427 ms
  frames), the picker memo thrashed (`_zone.picks` 180k-470k a window),
  `_env` peaked at 481 ms pruning 800k entries, and every hop cleared the
  memos twice (the room's sky, then the table) and rebuilt the mask cold —
  the 150-650 ms `hooks` frames, and the backwards teleport he felt after
  each (the server keeps moving through a freeze; the reconcile pulls the
  body back). Fixed the same evening: bounded two-generation memos, a
  re-roll that stamps instead of scanning, the sky keeps the memos and the
  raster, a doc known by fingerprint (`ambient/README.md`); foam's view
  walk at 450 ms and one scratch row instead of an ImageData per install.
  Still open from that run, not games-perf's: `repath` 68 ms plus 76+69 ms
  in the touch handlers on a tap (the nav — games), `rtt` p50 130-200 ms
  with p99 400-600 (his connection), and the heap's other 700 MB (games).
  HIS 21:20 RUN ON THE FIX (115e15db85, nine windows, 18 hops, the whole
  map): `_env` peak 481 -> 11.7 ms, `_gloom` peak 628 -> 90, no hop
  freeze (join 154-331 ms, all network), heap max 900 -> 683 MB, hooks now
  FULLY metered (unmetered 0.2-0.4 ms/frame). p50 20-42 ms, 6-168 frames
  over 50 ms a window — the west and south-west (marsh, lake: storm, rain,
  foam, 3-6k occluders) are the slow windows. What is left, by owner:
  `_gloom` 3.5-9.7 ms A TICK, scaling with the frame time (3.5 at 43 fps,
  9.7 at 21) = up to 4.5 ms/frame. Billed in parts, his 21:43 run said
  RASTER (2.5-7.8 ms a tick; field 0.5, the mask upload 0.2), not a GPU
  sync: the camera zoom breathes with speed, the mask step was view/64, and
  the raster memo — keyed on the exact step — was never reused while
  running. The lattice is zoom-proof now (`ambient/README.md`). The three worst
  frames were COLLECTIONS: 725 ms (depthSort 566, dh -29 MB, w=gc), 569
  (render 385 with 14 compositions uploaded in the one frame), 478 (hooks
  462, dh -291 MB — a major collection inside storm's update); `allocBy`
  puts `render` at 100-400 KB a FRAME, `repaintCells` 56-140, `avatarLoop`
  30-100 (games). The backwards teleport: a 131-cell `jump` at t=135.9 s
  on a hop back INTO zone 2, to where he had left it 70 s earlier
  (196.2,99.6 — window 2's position), with rtt p99 2,341 ms in that
  window: the room he re-entered bound him on a stale position (the
  hand-off — games). The weather rows sum to 2.5-7 ms/frame (storm 0.73,
  foam 0.95, rain 0.38, birds 0.31, windy 0.30, heavyrain 0.28, snow 0.22,
  drizzle 0.21), and `_zone.picks` 100-180k a window are the drops' own
  per-particle reads (games-ambient). Rejected: `performance.memory` per frame as a GC signal
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
