# The GPU compositor — transitions, ramps and lined tops on the GPU

Settings -> Dev "GPU transitions" (`localStorage ml-gpu-compose = "1"`), OFF by
default, remembered; the beacon's `sim` carries `/gpu` while it is on
(maintainer 2026-09-26: "try the GPU transition/boundary render shader again
... The boundary shader needs a test to make sure it produced the same tile we
get when the CPU produces it!").

## The direct draw (`client/src/tiles3gpu.ts` GpuDirect, `groundpipe.ts`)

No tile texture is made for the ground. The ground texture draws through the
ground pipeline (Phaser's Single pipeline plus four per-quad vectors): a
transition, a composed ramp or an outlined flat top is ONE QUAD of the ground's
own batch, in painter order, and its fragment shader computes each texel from
what stays resident on the GPU — the plates, the boundary shapes, the mask/seam
frames, the ramp maps and shade rows, the seam tone and each tile's colour sums.
Occluder copies are sprites and keep real textures (`wantTextures`).

Inputs are made on the compose worker (plates decoded and conformed, boundary
and ramp shapes: `GpuPrepReq`) and uploaded once. A tile whose inputs are not
there yet is owed, and is remembered (`GpuComposer.waiting`) so that it is made
the frame its inputs land.

A composed boundary (`buildBoundaryPixels` + `withEdge`) is split into:
- its SHAPE: per output texel, the source texel it copies, the final alpha,
  and the outline class (none / outer / inner / cut). Taken from the CPU code
  ITSELF (`shapeOf`): the real functions run over coordinate plates (each texel
  is its own x, y), and over a uniform grey the outline moves to two known
  values — so any change to the CPU's geometry is the GPU's too. A SLOPE
  boundary's shape also depends on the two plates' alpha (the shift, the
  holes) and is keyed by their identities, and records the side per texel;
- its COLOURS: the composite (mask select, the seam through a 256-entry table
  of the CPU's own `rint` — float32 falls on the wrong side of the .5 ties rint
  exists for); the sums of r, g, b and the opaque count per tile (the outline
  inks in the tile's MEAN colour), exact integers; the ink in exact integer
  arithmetic (`0.4 d + 0.21 S/n` outer, `0.55 d + 0.27 S/n` inner, split into
  quotients and remainders under 2^24; `inkConstantsHold` pins the constants).
WebGL1, no extensions, NEAREST at texel centres, RGBA8 everywhere.

## The outline colours (the sums): never inside a ground batch

A tile's sums are computed ONCE, on the GPU, into the resident sums texture,
and shared by CONTENT (two keys that paint the same tile share one slot).
THEY ARE NEVER COMPUTED INSIDE THE GROUND'S BATCH: a sums pass there takes the
GPU off the ground target and back in the middle of its paint (on a tiler, a
store and a reload of the whole target). They are computed in their own pass
(`GpuComposer.sumsNow`):
- at the frame's start (`frameStart`, the first line of the scene's update),
  after the waiting tiles whose inputs landed are made;
- before every ground bracket opens, after the scene's PRE-WALK (`gpuPrewalk`)
  has asked the factory for everything that paint will draw — the same cells,
  the same calls, under the same clip; it draws and owes nothing, and the paint
  finds every answer memoised. The drain pre-walks its slices before its
  bracket (the head always, the rest while `GPU_PREWALK_MS` lasts) and paints
  only pre-walked ones.
A sums pass inside a batch (`groundpipe.onBeforeFlush`) is the fallback only
and is counted: beacon `gpuCompose.direct.midBatch` (with `sumsOutPasses` for
the ones in their own pass); probe `__ml.gpuCompose()`.
(Measured headless, a boot, four runs and two view turns: 217 passes inside the
batch before (0.9 s, counted to the fourth run); 0 after, 328 passes of their
own for 6,321 tiles, 70 ms in all.)

## The world warm: the whole side resident, nearest first

With the switch on, every 24-cell region of the world on screen's side is
walked once through the direct draw's own hooks (`worldWarmStep`), nearest the
player first: its plates, shapes and ramp maps are asked of the worker and
uploaded the frame they land, its outline colours computed in the frame's own
pass — so a walk, and a turn back to that side, meet them resident. A 2 ms
slice of each frame that painted no ground, never while the worker holds more
than `GROUND_WARM_BACKLOG` jobs (the view's own come first); cells resolved
without the cell cache. Regions done are kept per side for the session; the
other sides' windows round the player are Fix 1's (`warmViewGround`).
(Measured, the_game, one side, whole world: 11k tiles, 463 plates, 448 shapes,
373 ramp maps, ~10k colour slots — under half of every atlas; 5.8 s of walking
headless. Not at load: the worker needs minutes for every shape.)
Probe `__ml.gpuCompose().worldWarm`; beacon `gpuCompose.direct.warmRegions`.

## The gate: `scripts/verify-gpucompose.mjs` (built client)

Walks the_game (five spots, plus up to 8 clusters of slope boundaries when
`SLOPE=25|50`), then every boundary job seen is composed by the CPU (the
worker's functions over the same decoded files) and by the GPU and compared
BYTE FOR BYTE, all four channels, every texel; a pass that compared no opaque
or no inked texel is a failure. Then a page with the switch off and a page with
it on walk the same spots and their painted grounds are compared over the world
region both textures cover. `TILES=0` skips the per-tile half; `SETTLE_MS`
bounds each settle (default 15 min).
Measured 2026-09-26: 2,510 of 2,510 boundaries identical (auto slopes).

## Next (games' list, 2026-09-26)

- Everything resident BEFORE play (the world warm takes minutes on the worker):
  the shapes and ramp maps made offline, or on more than one worker.
- The per-quad vectors packed smaller: every plain ground quad carries them as
  zeros (23 floats a vertex instead of 7).
- Outlined flat tops on a cheap path of their own (they take the slope path:
  4-5 texture reads a texel where ~2 do).
- Slopes from the lifted surface instead of CPU maps plus the shade table.
