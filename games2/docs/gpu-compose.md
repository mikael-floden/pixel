# The GPU compositor — transition tiles on the GPU

Settings -> Dev "GPU transitions" (`localStorage ml-gpu-compose = "1"`), OFF by
default, remembered; the beacon's `sim` carries `/gpu` while it is on
(maintainer 2026-09-26: "try the GPU transition/boundary render shader again
... The boundary shader needs a test to make sure it produced the same tile we
get when the CPU produces it!").

## What it does (`client/src/tiles3gpu.ts`)

`GpuComposer` stands between the factory (`Tiles3Textures`, `remote`) and the
compose worker: every BOUNDARY job the factory would post is composed on the
GPU, one batch a frame (`GPU_BATCH` 128), and lands through the worker's own
callback (`landRemote`) — keys, owed-cell retry and the paint are untouched.
Plates, fades and anything else still go to the worker. A GL failure turns it
off for the session and hands its queue back to the worker.

A composed boundary (`buildBoundaryPixels` + `withEdge`) is split into:
- its SHAPE: per output texel, the source texel it copies, the final alpha,
  and the outline class (none / outer / inner / cut). Taken from the CPU code
  ITSELF (`shapeOf`): the real functions run over coordinate plates (each texel
  is its own x, y), and over a uniform grey the outline moves to two known
  values — so any change to the CPU's geometry is the GPU's too. A SLOPE
  boundary's shape also depends on the two plates' alpha (the shift, the
  holes) and is keyed by their identities, and records the side per texel;
- its COLOURS, three batched passes: A the composite (mask select, the seam
  through a 256-entry table of the CPU's own `rint` — float32 falls on the
  wrong side of the .5 ties rint exists for); B the sums of r, g, b and the
  opaque count per tile (the outline inks in the tile's MEAN colour), exact
  integers; C the ink in exact integer arithmetic (`0.4 d + 0.21 S/n` outer,
  `0.55 d + 0.27 S/n` inner, split into quotients and remainders under 2^24;
  `inkConstantsHold` pins the constants it assumes).
WebGL1, no extensions, NEAREST at texel centres, RGBA8 everywhere.

## The gate: `scripts/verify-gpucompose.mjs` (built client)

Walks the_game (five spots, plus up to 8 clusters of slope boundaries when
`SLOPE=25|50`), then every boundary job seen is composed by the CPU (the
worker's functions over the same decoded files) and by the GPU and compared
BYTE FOR BYTE, all four channels, every texel; a pass that compared no opaque
or no inked texel is a failure. Then a second page with the switch on walks
the same spots and its painted ground must hash the same.
Measured 2026-09-26: 2,510 of 2,510 boundaries identical (auto slopes).

## Not on the GPU yet

- COMPOSED RAMPS (every slope at the default "auto": 1,778 cells) are the
  cell's own surface, built on the frame thread (`rampRaster` ->
  `buildRampPixels`), not boundary jobs: next.
- The zero-copy form: this still reads the batch back and uploads each tile
  (the worker's landing path); drawn straight into GL textures, a fresh side
  would owe nothing.
