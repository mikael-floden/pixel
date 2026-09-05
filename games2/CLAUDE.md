# CLAUDE.md — Nangijala working notes

## THE CONTENT SPLIT — what ships vs what is staging

The art domains generate far more than the game uses (scenery ships 2,644
files; the game reads THREE). The image contains only what the published
worlds can reach (maintainer: "the real game will only ever include what's
inside the actual real game").

- **`games2/config/publish.json`** — the ONLY hand-maintained part: published
  worlds, playable characters, the three game-referenced scenery pieces.
  Everything else is DERIVED. `userWorlds` = `the_game` + `the_island2`
  (maintainer 2026-09-02: the_game is the default map and, once he is happy
  with it, the only playable one; the_island2 stays until then). A name may
  live in EITHER world tree — resolved by probing `maps2/worlds` then
  `maps2/worlds3`, as the server and build-worlds do — so the policy names a
  world and nothing else.
  **THE ONLY MAP THAT MATTERS IS `the_game`, AND THE TILES 2.0 WORLDS ARE ON A
  COUNTDOWN** (maintainer 2026-09-05: "Only the_game is important, we will soon
  remove all other maps that uses the tiles2 system. I just want to still have
  it until the new map works."). They must keep WORKING — do not break the maps2
  branch, its atlas or its gates — but they are not what anything is FOR:
  measure, calibrate, profile and optimise against the_game, and never let a
  tiles2 world's numbers stand in for the shipped one. That distinction is not
  academic: `bench-findpath.ts` set the client's hold-to-move repath budget from
  ring_test / glow_test / prop_demo at 6k-25k cells, where a route costs
  0.46-10.54 ms p50, while the_game is 262,144 cells and costs 38.24 ms p50 and
  70.10 ms max — the budget was tuned against a map nobody plays. When a tiles2
  world and the_game disagree about a cost, the_game is the answer.
- **`games2/scripts/shipset.mjs`** closes over those roots: a published world
  drags in its `paths[]` tiles, its NPCs' character art, its spawn zones'
  monsters, and — a worlds3 world — its placed SCENERY pieces' whole
  directories (the manifest names sprite, rotations, variations and animations
  and the maps2 agent places a piece as a whole: the_game, 187 pieces / 23.7 MB
  for 1,263 placements). `--report` prints the savings table, `--check` fails
  on a reachable-but-missing file, `--emit <dir>` materialises the curated
  root. The Dockerfile's **`curate` stage** runs `--emit`; the final image
  copies from it, one layer per domain. Measured: 358 MB of art on disk →
  130.5 MB in the image (92.5 with the_island2 alone).
- **A worlds3 world's TERRAIN ART is the tiles3 resolver's exact closure**,
  not the `tiles/` domain: `scripts/ship-tiles3.ts` (Dockerfile BUILD stage,
  where TypeScript exists; the curate stage has none) runs the real resolver
  over every cell, corner and deck of each published worlds3 world through the
  same `cellArtPaths`/`boundaryArtPaths`/`deckArtPaths` the scene hands its
  loader, copies exactly those files plus the `TILES3_DOCS` index documents
  from `/full` into `/assets/tiles`, and `--check` fails the build on a
  named-but-missing file — shipset's rule, applied here. The runtime stage
  copies `/assets/tiles` from the build stage. Measured on the_game: 508 files
  / 0.35 MB of a 400 MB domain, resolved in ~1.5 s. (A JSON-level
  approximation would drift from the renderer; per-ground subtrees would ship
  ~90 MB.) Module `scripts/tiles3closure.ts`; gate
  `server/test/shiptiles3.test.ts` (complete, deterministic, and STILL a
  closure — it fails if the resolver ever names whole trees).
- Filtering the asset root filters everything downstream for free — the image
  rebuilds every manifest and the wiki registry from `ASSETS_ROOT`, so
  `worlds.json`/`monsters.json`/wiki `data.json` list only shipped content and
  a player is never TOLD staging exists. That is why it is a build stage, not
  a `.dockerignore` edit.
- **TRAP (found by simulating the curated root):** a domain is not just its
  entities — `monsters/config/roster.json` fell outside the closure and the
  first curated build emitted `[monsters] 0 monsters`, a game that built,
  deployed and looked fine. Hence `entityDomains`: every contributing domain
  ships its root-level files and its `config/` tree wholesale. A missing
  descriptor does not 404 a sprite — it **silently empties a manifest**. When
  in doubt the script INCLUDES and warns.
- Staging stays reachable for us, never players: **dev** (`npm run dev` reads
  the working tree — every world playable, every gate unaffected) and **admin
  in prod** via the public repo. Measured: `raw.githubusercontent.com` sends
  CORS `*` but only `max-age=300` EVEN commit-pinned (NOT immutable);
  `cdn.jsdelivr.net/gh/<owner>/<repo>@<sha>/<path>` is byte-identical with
  `max-age=31536000, immutable` + CORS. Sha-pinned jsDelivr first, raw as
  fallback for commits the CDN hasn't picked up.

**THE TILE ATLAS.** A maps2 world boots from 1-2 committed sheets instead of
one HTTP request per tile (571 for the_island2).

- `scripts/build-atlas.py` packs each world's `paths[]` into **lossless** WebP
  sheets under `client/public/atlases/` (lossless+exact per repo law — the
  maintainer reviewed a lossy q85-q95 ladder on real sheets and ruled: **stay
  lossless**), self-verified byte-for-byte per frame, two-band shelf pack
  (tiles are 64×64 / 64×128), deterministic. `npm run atlas`; `-f` forces.
- **The work is never repeated**: atlases are committed, content-addressed by
  a digest over the tile list AND every tile's bytes; the packer skips
  matching digests. Deploys only VERIFY (`scripts/check-atlas.mjs`, wired into
  `npm run manifest` and the Dockerfile). A STALE atlas is **pruned, not
  failed**: the client's index fetch 404s and it falls back to per-file tiles
  — slower, never wrong pixels, never a red pipeline.
- `client/src/tileatlas.ts` is a LOADING strategy only: sheets are sliced into
  per-path canvas textures under the exact `t2:<path>` keys per-file loads
  produced, so no draw site (ground RT, occluders, debris, flippedKey) can
  tell which path ran; any failure degrades to individual loads. Probe:
  `__ml.atlasInfo()`. Gates: `verify-atlas.mjs` (zero individual tile-art
  requests on boot, all sliced, world renders); verify-indoor doubles as the
  pixel canary against atlas-sliced textures.

**STAGING WORLDS.** The image ships `userWorlds` ONLY (either tree — see the
content split above); every `devWorlds`/`devWorlds3` map is streamed from the
repo when an admin joins — a dev map costs production ZERO bytes (the leak
this stops: 57 monsters in monster_demo dragged 16 MB of monster art in;
measured 89.5 → 105.4 MB).

- CLIENT: `client/src/staging.ts`, one chokepoint `gameUrl()` — identity
  function when inactive (a normal player's path is byte-identical). Activated
  (main.ts, chosen world not in the build) it rewrites `/assets/**`,
  `/atlases/**` and the manifests to the sha-pinned jsDelivr base;
  `mergeStagingEntries` folds the repo's full monster/NPC manifests over the
  image's, rewriting only ADDED entries' URLs.
- SERVER: `WorldRoom.readWorldDoc` — **disk first, always**; only a name the
  image lacks hits the network. Required: the server is authoritative
  (collision + spawn zones), so browser CORS alone can never make an unshipped
  map joinable.

**TWO WORLD TREES.** `maps2/worlds` holds world@1/world@2 (baked tile paths);
`maps2/worlds3` holds `pixel-maps3/world@1` (a ground NAME per cell, no art —
tiles3 resolves what draws at draw time). `parseWorld` dispatches on the doc's
own schema, so everything downstream of the read is identical; the ONLY
difference is which directory a name lives in, and exactly three places carry
it. **`maps2/worlds` is probed first everywhere**, which is what keeps every
existing world's disk reads and network requests unchanged.

- `scripts/build-worlds.mjs` scans both and records `root` on an entry — OMITTED
  for `maps2/worlds`, so those rows are byte-identical to before worlds3
  existed. In the image this runs against the CURATED root, so production's
  worlds.json still lists `userWorlds` only.
- `client/src/maps.ts` — `worldRoot`/`setWorldRoot`/`worldFileUrl` are the ONE
  place the client builds a world-file URL (world.json, spawns, npcs, places).
  A name nobody registered answers with `maps2/worlds`; only the two known
  trees can be registered (a root arrives over the network).
  `enterStaging(world, root)` takes it as a parameter rather than importing it
  — maps.ts already imports `gameUrl` from staging.ts.
- `WorldRoom.worldRootFor` resolves a name's tree ONCE per process: DISK across
  both trees before any network, so a shipped world still never touches GitHub;
  the staging fetch that resolves the root is the same one `stagingCache`
  serves to the read behind it, so a v3 world costs ONE extra 404 per process
  and a v2 world costs none. Every file of a world reads from ITS tree.
- `config/publish.json` `devWorlds3` names maps3 STAGING worlds (none today:
  `the_game` is published). A published worlds3 world ships its docs, NPC,
  monster and scenery closure through shipset and its terrain art through
  ship-tiles3 (content split above); `--check-policy` verifies a published
  name against whichever trees are checked out, and an absent tree is "not
  checked out", not a typo (the deploy's test job sparse-checks-out
  `/maps2/worlds/` alone).
- **The tiles3 ART needs no new plumbing**: the resolver names repo-relative
  files (`tiles/plates`, `tiles/patterns`, `tiles/tops`, `tiles/fades`,
  `tiles/base_candidates`, `tiles/review`, the index JSONs) served at
  `/assets/tiles/…`, which `gameUrl`'s existing `/assets/` rule maps onto the
  CDN for a STAGING world — as it does `/assets/live/tuning/base_tile_sets.json`.
  `tiles` is in both asset-domain lists: dev serves the working tree, prod
  serves the published worlds' closure baked by ship-tiles3 and 404s
  everything else — the 400 MB domain never enters the image.
- HOW TO PLAY IT: it is the DEFAULT map (`maps.ts DEFAULT_WORLD`, first in
  the picker, preselected) and a user world since 2026-09-02; the dev worlds
  stay admin-only (`npm run dev` shows them unconditionally). Gate:
  `server/test/worldserve.test.ts` — both trees, disk and network, the request
  log, `gameUrl`'s identity, and a real Colyseus join landing on the maps3
  spawn.
- KNOWN GAP, not this unit: `shared/parseSpawns` accepts
  `pixel-maps2/spawns@1` only, and the_game's spawns.json says
  `pixel-maps3/spawns@1` with a BYTE-IDENTICAL zone shape — so it joins with
  82 zones and zero monsters until that schema is accepted.

**RENDERING A MAPS3 WORLD.** `WorldScene` has a SECOND art source, not a second
renderer: the streaming RenderTexture, depth sort, occluders, painter order,
decks, indoor cut and the night shader are geometry and compositing and do not
care where the picture came from. Four modules, all pure and Phaser-free:
`client/src/tiles3.ts` (what draws on this cell), `tiles3draw.ts` (the two pixel
ops + the composed-texture factory), `tiles3runtime.ts` (the same resolution ONE
CELL AT A TIME, plus the streaming loader), `scenery3.ts` (off-grid set
dressing). `this.maps3` gates every branch; `this.maps2` is false on a v3 world
by construction, so no existing branch changed.

- **THE PROJECTION IS PER WORLD.** tiles2 is dx 32 / dy 15 / storey 16; tiles3
  is 32 / 14 / **15**, the last MEASURED off the x-over-x wall art
  (`measureStoreyPitch` — the doc says 17, render3 falls back to 16, and a
  pitch one row too large exposes a bright stripe of each lower floor at every
  storey). `parseWorld3` publishes it as `ParsedWorld.iso`; `maps.ts
  geometryFor` turns it into the scene's `this.geom` and returns the
  `MAP_GEOMETRY` object ITSELF when it matches, so a world@1/@2 world cannot
  move a pixel. `nightlight.ts` reads the same geometry. **INPUT ROTATION
  DELIBERATELY DOES NOT**: `screenToWorldVector` takes the geometry but every
  movement call keeps the default, because client prediction and the
  authoritative server integrate the same inputs and the server carries no
  per-world projection — a per-world rotation there is a desync, not a look.
- **THE COORDINATE BRIDGE** is two constants: tiles3's frame is this scene's
  projection with `ox = iso.ox + DX` and `oy = iso.oy + TOP_Y`. Get either
  wrong and nothing looks broken — the map simply shears a row per grid step.
- **PER CELL, NEVER THE SWEEP.** `Tiles3.resolveWindow` is ~420ms on the_game
  and allocates per cell. `Tiles3World` takes the same decisions one cell at a
  time out of the resolver's public primitives, and
  `server/test/tiles3runtime.test.ts` proves the two return deeply equal cells,
  boundaries and deck cells over the parity fixture's windows — that equality
  is the whole licence for the fast path. Measured: 38ms for the whole-world
  region flood fill once at load, 32ms per ground redraw (which runs on the RT's
  own latch, every GROUND_MARGIN/2 of camera drift, not per frame).
- **REGIONS ARE WHOLE-WORLD**, computed once. A region id is `<ground>@<lexicographic
  minimum cell>`, so a window-local component gets a different id, a different
  set and different art every time the camera moves — the ground would visibly
  reshuffle as you walk.
- **PAINTER ORDER: A CELL DRAWS ONCE, AND EVERYTHING THAT CELL WEARS DRAWS
  INSIDE THAT SLOT.** Cells in painter order (`col+row`, then `col`), each one's
  composed boundary WITH IT, then the deck slabs. **The boundary is NOT a second
  pass** — it was, and that was a bug: a transition belonging to a far cell
  painted on top of the nearer cliff faces in front of it and a cliff's column
  came out shuffled (maintainer 2026-08-29: "the draw order is fucked up",
  circling one cliff edge). render3 hit the identical bug and killed the same
  pass; its loop is still there, spelled `for s in []`, with the note "the
  boundary is drawn WITH the cell now" (render3.py:1190).
  **THIS NOTE USED TO SAY "THREE PASSES … INTERLEAVING IS WRONG", AND THAT COST
  A DAY**: reasoning from it produced a whole fix (mask the boundary to its top
  face, because "it paints last so its wall band lands on top") plus a composite
  measurement that reproduced the stale doc instead of the renderer and
  "proved" 18,321 artefact texels removed while the artefact survived on the
  maintainer's phone. A stale doc is worse than no doc.
- **SLACK, NOT EXACTNESS — the law this renderer's seam artefacts keep teaching**
  (maintainer 2026-09-03, after two days of them: "why don't you fix the code so
  it can't appear (make sure the tile in front covers it)? Why do you have to
  make it so exact?"). The ideal lattice is exact in every variant; OVERLAP is
  what differs, and overlap is what survives reality. Measured uncovered
  top-face texels on a 24x24 field:

      variant                exact   1-row slip   1 in 20 ops dropped
      FULL plate                 0            0                  1056
      top face, margin 0         0          864                  6960
      top face, margin 1         0            0                  6464
      top face, margin 2         0            0                  6000

  A full plate's 17-row wall band gives 32 rows of overlap; a tiles2 tile gives
  49, which is the whole reason no tiles2 world has ever shown a seam artefact —
  that renderer is TOLERANT BY CONSTRUCTION, not more correct. A top-face-only
  plate gives ONE, so it is the only thing here a single-row slip can mark, and
  it carries `TOP_FACE_MARGIN` (2) rows of its own SURFACE below the diamond —
  never the art's next row, which is the WALL BAND and put 76 wall texels per
  plate onto the sea when it was tried. Gate: `the geometry has slack: a one-row
  slip cannot open a hole` (with a control, and non-vacuous — zero margin must
  fail it). **A fix that makes the geometry more exact leaves the class alive;
  every one tried here did.**
  REJECTED, do not re-attempt by reasoning: masking a composed boundary to its
  top face (`Tiles3Boundary.topOnly` is deliberately UNREAD in `boundary()`) —
  the full plate is strictly more tolerant on both adversities above, and with
  zero margin the mask created the most fragile geometry in the renderer at
  exactly the `light_beach<->grass` cells the artefact is photographed on.
  Gate: `a composed boundary is the RAW composition — wall band included`.
- **THE ARTEFACT IS INTERMITTENT, AND THAT IS THE STREAMING, NOT THE GEOMETRY.**
  The maintainer can make it come and go by tabbing out and in, and it returns
  SMALLER as more art lands. `opsForCell` DROPS an op whose texture is not
  resident (deliberately — a fallback tile is a wrong picture nothing corrects),
  so a window painted while plates are in flight is missing art until a landing
  repaints those cells (`t3missing` -> `onTerrainBatch` -> `repaintTiles3Cells`).
  **the_island2 boots from ONE committed atlas sheet with every tile resident,
  while a maps3 world streams plates per file** — which is the real reason the
  old world never shows this and the new one does, and NOT dy=15 vs dy=14 or the
  tile overlap. Any seam report from the phone should be reproduced against COLD
  art, not a warm local cache.

- **TWO PHASER TRAPS, both silent, both paid for here.**
  `textures.get(key)` returns the built-in `__MISSING` 32x32 checker for an
  unknown key, NOT undefined — handed to the composer an unloaded 64x46 plate
  arrives as 32x32 and kills the frame, so the scene passes an adapter whose
  `get` answers through `exists`. And terrain gets its **own `LoaderPlugin`**:
  `this.load` is one FIFO queue and `loadDeferredAnims` pushes ~1,700 action
  frames onto it the moment the avatar is in — measured, 95 plate files sat at
  position 1,719 and the ground never filled in while every counter said it had
  been requested. The dedicated loader also carries `crossOrigin =
  "anonymous"`, which a staging join depends on: a composed boundary reads its
  plates back with `getImageData`, and a cross-origin image loaded without the
  attribute taints the canvas and makes every boundary in the world vanish.
- **A TOP-FACE-ONLY PLATE IS THE ONLY ZERO-SLACK SEAM IN THE GAME, and it is
  the whole reason the sea zigzags where no old map ever did** (maintainer
  2026-09-03, the_island2 beside the_game: "0 zigzag. it just works"). A tiles2
  world draws a 64-px-tall tile per cell on a dy=15 lattice, so neighbours
  overlap by FORTY-NINE rows and there is no seam to get wrong at all; a full
  tiles3 plate is 46 rows at dy=14 and overlaps by SEVENTEEN. A top-face-only
  plate is 29 rows overlapping by exactly ONE — and liquids are the only grounds
  still on that path, which is why sand stopped showing the artefact and water
  did not. The old renderer was TOLERANT BY CONSTRUCTION, not correct: every
  one-pixel error in the projection was always there and always hidden. So the
  cure is slack, not a hunt for a slip. THIS IS THE SEA'S DEFECT AND NOT THE
  BEACH'S: the beach was a composed boundary's wall band painted in the last
  pass (see A COMPOSED BOUNDARY IS TOP FACE ONLY above), which is why fixing
  the interlock could not touch it and why open water — which composes no
  boundary at all — was fixed by this and nothing else. (Measured and cleared
  on his device:
  `nonInt` 0, `anchorFrac` 0, `rtPosFrac` 0, `sy` stepping exactly +28 per
  diagonal cell, the RT hash-identical to a forced full paint). `topFaceOnly`
  therefore carries ONE EXTRA ROW per column, copied from THAT COLUMN'S OWN
  BOTTOM SURFACE PIXEL — covered by the tile in front where there is one, one
  pixel of deeper sea where there is not. **Never source that row from the art's
  next row**: that is the plate's WALL BAND, and it put 76 wall texels per plate
  (water `#4c8a98` = 76,138,152 against a 126,183,199 top face) along exactly
  the tile edges as the dark dotted line it was added to remove — his device
  measured 146 px of that colour there with ZERO background texels. The gate
  (`topFaceOnly drops the wall band and touches nothing else`) pins that no wall
  texel survives anywhere. A CONFORM is not a liquid: it repaints its own wall
  band and keeps it — only `LIQUID_TILE_GROUNDS` is forced onto this path.
- **A LIQUID'S DIAMOND WEARS `sheets.libTop`, NEVER A FORMULA** — and the sea
  is its ORDINARY path, not a fallback: `water` ships `base_tiles: []` and has
  no `tiles/base_candidates/water` set, so `surface()` resolves no plate and
  every water cell on the map paints `liquidDiamond`. The old hand-derived
  `trunc(DX * (1 - |y-DY| / DY))` shape does not TILE — half-widths stepping
  32,30,28,25,… and an empty first row leave 30 single-pixel holes per tile
  marching along every edge (252 px per 100x100 of sea, 2.5%, the dark page
  ground through each). That was the maintainer's "zigzag pattern at the tile
  edge on all water tiles" (2026-09-03) and, earlier, the "visible edges" on the
  sea. `libTop` is the same top-face mask every real plate wears — 29 rows that
  OVERLAP their neighbours by one, so it is gapless by construction (measured: 0
  holes) — and its widest row still lands on `TOP_Y + DY`, so no water moved.
  The general rule: a mask that has to interlock with the art's masks IS the
  art's mask; re-deriving the diamond is how the gaps get in.
- **A TRANSITION TILE COVERS WHAT THE PLATE IT REPLACES COVERED** (`tiles3draw`
  boundary). The ground loop takes ONE of the two, never both — `if (bop &&
  cell.kind === "field") <transition tile> else <plate>` — so a boundary's
  FOOTPRINT must equal the plate's or the difference is painted by nothing.
  render3 gets this right by construction: `composed_boundary` sets
  `out[..., 3] = _silhouette()`, the full 2012 texels. Masking the client's to
  its 924-texel top face (2026-09-03) fixed a real defect — the band then
  carried the palette WALL colour, 800 of 1088 on a light_beach<->grass
  composition, and boundaries were then a SEPARATE PASS drawn after every cell
  so nothing covered it — but it left **1088 texels painted by nothing**, and
  **that was the maintainer's remaining zigzag**. His own test proved it: the
  `clear: pink` switch fills the ground magenta, and his screenshot then
  carried 396 bare pixels in 76 chains, 195 runs of exactly 2 screen px — one
  texel at camera zoom 2 — on diamond-edge slopes. It was never a dark tile; it
  was bare ground. His words: "as if the transition tiles doesn't have a wall.
  Ofc they must have a wall." Boundaries are drawn WITH their cell now, in
  plate painter order, so the cells in front cover the band exactly as they
  cover a plate's; `capWallToSurface` then makes it free, repainting the band
  from each column's own bottom top-face texel so even a peeking texel is the
  surface's own colour. A RAISED boundary stays top-face-only (the cap's own
  x-over-y art is the wall) — a different picture, so `boundaryKey` carries
  `topOnly`; two rasters under one key is the cache failure this repo forbids.
  Gated by `server/test/tiles3draw.test.ts` #6b/#6c, which hold both halves at
  once: the band EXISTS (footprint parity, no hole) and carries NONE of either
  ground's palette wall colour (no dark course).
- **THE SEAM IS ON, AND IT IS WHAT MAKES A TRANSITION VISIBLE.** A composed
  transition is `out.rgb = mask ? plateB : plateA` — a HARD per-pixel select
  between two flat plates. The seam, which darkens the 1-texel border mask to
  `border.tone` (0.82) of what is already there, is the only thing that makes
  it read as a blend: "a transition without it is a 0-100 hard cut, which is
  not what the generator drew" (maintainer verdict,
  `tiles/patterns/index.json`, 2026-08-27), and the wiki preview draws it.
  IT WAS SWITCHED OFF ON 2026-09-04 CHASING THE ZIGZAG AND THAT WAS WRONG: the
  remaining dots did measure a flat 0.82 multiply, but 0.82 was the seam doing
  its job ON TOP OF the actual defect — a transition tile covering 924 texels
  where the plate it replaces covers 2012, leaving 1088 painted by nothing.
  Removing the seam removed the transition instead, and he reported it
  immediately: "I still see no transitions..." on a frame where 109 boundaries
  and 41 fades resolved. A settings switch (`seam`) flips it live, and
  `boundaryKey` carries `|noseam`, so seamed and unseamed are different
  pictures under different keys.
- **EVERY FIELD ART GOES THROUGH `plate()`, INCLUDING A PUBLISHED OR CLEAN
  ONE** (`tiles3draw` opsForCell). Its last branch drew `op.key` — the RAW FILE
  — for any field art that was not conform, not `topOnly` and not a liquid
  ground, which is exactly a LEVEL-0 published or clean plate. So
  `capWallToSurface`, whose entire purpose is to neutralise the wall band,
  never ran on the cells it was written for. **This was the land zigzag**, and
  it cost three days. Measured on `tiles/plates/light_beach/clean.webp`: the
  raw file carries 1088 texels of exactly (171,146,116) — light_beach's palette
  wall — and the capped raster carries 0. A level-0 cell has nothing below it,
  so its wall band is never legitimate art; it is only the ~25%-darker course
  that makes a one-texel coverage error visible. The cell in front covers
  almost all of it, so what shows is a short broken run along a diamond edge:
  measured off the maintainer's screenshot at 442.2/382.2, 633 texels of
  exactly (171,146,116) in 116 chevrons, each 2 screen px tall at camera zoom 2
  — one texel — on diamond-edge slopes repeating every 64 px, which is DX at
  that zoom. The BRANCH CONDITION IS HIS LOCALISATION, which is how it was
  found: he reported the artefact 100% absent on raised ground (`topOnly`) and
  100% absent on water (the liquid path), present only on level-0 land.
  Offline render of his window, real client code, same inset: 1781 -> 0, with
  the legitimate raised wall course untouched. Gated by
  `server/test/tiles3draw.test.ts` #6b, which asserts BOTH that the op points
  at the capped raster and that the raster carries none of the palette wall
  colour — either alone passes while the bug is live. A wall cell keeps the raw
  path (`art` is undefined there; a wall course must draw its own art).
- **A CONFORMED PLATE FILLS EVERY SILHOUETTE TEXEL, INCLUDING HOLES INSIDE A
  COLUMN** (`conformPlate`). Conforming assigns the library silhouette as the
  ALPHA CHANNEL — every silhouette texel comes out opaque — but it fills RGB
  per column by extending the art OUTWARD: above the top face, below the
  silhouette, and into the row the library's top face runs deeper than the
  source's. None of those reaches a texel that is transparent BETWEEN opaque
  ones, so it shipped the RGB the source stored under its own transparency
  (preserved byte-for-byte by the repo's `exact=True` WebP law) as a solid
  pixel of a colour nobody chose. **This was the land half of the zigzag**, and
  it is why the artefact tracked the fade band exactly: a base tile's columns
  are solid and never hit it, while a FADE tile is a scatter
  (patches/spots/piles/lumps) full of holes by construction. Measured in the
  maintainer's window (the_game 416.9/340.8): 18 of 66 fade arts, 153 texels,
  65 cells, every one on rows 1-15 — the diamond's upper ramp — and every one
  dark against its own ground: (84,57,33) on light_beach's (234,210,173) sand,
  (89,59,46) on grass, (78,101,70) on light_soil. His own three-way
  localisation is the same fact from outside: a fade is dressed ONLY at level 0
  on non-liquid ground (a raised cap and a liquid both take the `topOnly` path,
  which carries no fade, no slope, no boundary), and he reports the artefact
  100% absent on raised ground and 100% absent on water. Fill from the nearest
  painted row in the same column; the fix can only write a texel no rule wrote.
  The python reference has the SAME gap — `transition_patterns.plate()` repairs
  only the EMPTY-column case and claims "every silhouette pixel has a real
  colour" on the strength of it — so until the tiles agent lands the same rule,
  render3 and the client disagree on exactly these texels (raised on
  `coordination/tiles.json`).
- **A NOT-YET-LOADED PLATE IS NEVER CACHED AS NULL** (`tiles3draw` platePixels /
  sourcePixels). Null means "not resident yet"; caching it makes every plate
  that missed its first frame miss forever.
- Diagnostics: `window.__ml.tiles3()` reports what resolved, what drew, what is
  still loading and what composed, plus `hold` — the boot hold's raw inputs,
  the only way to tell why a loading screen ran to its deadline — a gate cannot tell a correct dark frame
  from a black one by pixels, so the counters are the instrument.
  `window.__ml.t3at(col,row)` is the same question for ONE cell: the resolver's
  verdict plus the blits the texture factory can hand the RT right now, so a
  cell that resolved but has no picture reads as zero blits rather than as a
  resolution failure. Pixels cannot separate "the fade drew" from "the plate
  under it drew"; the counters cannot separate "composed" from "on screen".
- **Gate: `scripts/verify-tiles3.mjs`** (needs the dev stack). the_game LOADS at
  512x512 — the size is asserted FIRST because the silent fallback is a green
  160x160 plain that still boots and still joins — then five grounds are sampled
  as real pixels (three of them in ONE screenshot, which is what a uniformly
  coloured frame cannot survive), a ring-2 fade cell and a composed boundary are
  resolved AND composed, a 7-storey capped cliff draws every storey, scenery
  reaches the window, the player walks on open grass and a level-6 escarpment
  stops them, and the_island2 is re-joined in the same run and still renders off
  its atlas. Every coordinate is derived from the world doc and carries its
  derivation; every threshold was falsified against a deliberately wrong cell.
  **COLOUR IS COMPARED UNLIT.** The night shader multiplies, and the light is
  PER CELL: measured at pinned Day on the_game it is 1.0 in the open and exactly
  0.55 on the east-coast cells standing in the level-6 cliff's own sun shadow.
  Comparing a ground lit at 1.0 with one lit at 0.55 as raw pixels compares
  nothing, so every sample is divided by `__ml.lightAtCell` first — measured, not
  asserted, because the gate is about terrain, not about lighting tuning.
  **A LANDED SCENERY MANIFEST SCHEDULES ITS OWN REBUILD** (`SceneryPieces`
  `onLanded` → `WorldScene.onSceneryManifest`, coalesced to one rebuild per
  `SCENERY_MANIFEST_SETTLE_MS` = 120 ms): the first rebuild over a fresh window
  can only request the piece manifests, and only a rebuild that SEES them
  queues their art. (Nothing but camera drift used to schedule that rebuild: a
  parked camera sat on a half-populated window — measured 1 sprite where a
  moving one reached 91 — and the boot hold's `scenery` condition came true
  with the art still unrequested, which is the pop-in the hold was built to
  stop. verify-tiles3 still walks to its scenery window instead of `lookAt`;
  that is belt and braces now, not a requirement.)
- **THE RESOLVER'S REGION RULE IS STALE AGAINST render3, and it is visible.**
  `tiles3.computeRegions` uses 4-connected COMPONENTS (proven against the parity
  fixture); render3 now keys a region on a 24-cell CHUNK, having found that
  components make a whole island one region. Measured on the_game: 332
  components against 851 chunks, and ONE component paints 54.6% of all grass and
  99.5% of all snow — so most of the map draws a single set per ground and the
  maintainer's other tuned sets never appear. Fixing it is a RESOLUTION change
  (tiles3.ts + its fixture), not a wiring one, which is why this run did not
  make it.
- **SCENERY IS SIZED AGAINST THE PERSON THIS GAME DRAWS, NOT THE ONE THE
  CONTRACT ASSUMES** (`shared/CHARACTER_BODY_PX` = 88, `sceneryDrawnPx`). A
  piece's `placement` gives its height in metres and a derived
  `world_px_height` with the note "a character is character_height_px tall" —
  and every one of the 707 published pieces says 64. The people here are
  112-px PixelLab frames whose bodies measure 90 (default_boy) and 86
  (default_girl) — mean 88 — and all 191 NPCs share the frame. Drawn at the raw
  `world_px_height`, a 1.29 m bed stood 49 px beside a 90 px man: 0.54 of him
  where its metres say 0.76 (maintainer 2026-09-02, wiki beside game:
  "someone is rendering in the wrong scale"). So the game keeps the metres and
  re-bases: drawn px = `world_px_height × 88 / character_height_px`, applied
  in ONE function to the draw (`rebuildScenery` → `fitSprite`) AND the
  collision stamp (`stampSceneryCollision` via the bbox doc's `cpx`, which
  `build-scenery-bbox.py` now emits per piece), so outline and art cannot
  drift apart. `parsePiece`/`fitSprite` themselves stay render3-identical
  (their parity fixtures hold); the re-basing is the scene's decision. Reading
  the contract's own character from the piece means that if the scenery domain
  publishes the true height at the source, this collapses to identity instead
  of doubling. NEITHER RENDERER WAS RIGHT: the wiki's size reference draws the
  piece at its NATIVE sprite pixels beside the man at his ("the comparison
  needs no math at all"), so a bed read as 1.14 of him — that is what made the
  beds look big there and small here. Gate:
  `server/test/characterscale.test.ts` (the constant is re-measured off the
  heroes' art within ±3 px; the stamp scales by exactly 88/64; every piece in
  the bbox doc carries `cpx`). Synthetic collision fixtures declare
  `cpx: CHARACTER_BODY_PX` — a piece sized against our own person, identity
  scale — never omit it or they silently grow 1.375×.
- **A SCENERY HITBOX IS AN ELLIPSE *OR* A RECTANGLE, and the shape is
  COLLISION, not decoration.** `live/tuning/scenery_hitbox.json` publishes
  `shape: "rect"` on 571 of its boxes — every bed, cupboard and shelf, 547 of
  them the wiki's own alpha-placed default — and the game read only ax/ay/rx/ry,
  so it collided all of them as the ellipse INSCRIBED in the published box and
  a body walked into all four corners of every one (maintainer 2026-09-05: "I
  know the bed and shelf is a rect hitbox and not an ellipse"). Both shapes now
  stamp, collide and DRAW as themselves. The maths is shared, not parallel:
  screen->world is a pure diagonal scale in the frame `SceneryFootprints.p/q`
  are measured in, so a screen-axis-aligned rect is axis-aligned there too —
  the same half-extents describe both and only the distance function differs
  (`footprintPenetration`, where the rect case is exact and cheaper than the
  ellipse's gauge gates). TWO THINGS A RECT NEEDS THAT THE ELLIPSE DID NOT: the
  BUCKET PAD, because a rect's world-axis support is `(p+q)/sqrt(2)` against
  the ellipse's `sqrt((p^2+q^2)/2)` — pad it as an ellipse and its corners sit
  in cells no query looks at, so the body walks through them with every
  containment test still passing; and the inside answer must be FLOORED above
  zero like the ellipse's own boolean gate, because `canEnterElev` queries with
  r = 0 and `footprintBlocks` tests `> 0`. `rot` is still ignored (12 boxes
  carry a non-zero one). USE THE WIKI'S DEFAULT: the stamp never filters `auto`
  — an override rewrites the same record without the flag, so a reviewed box
  wins by being the record. Gates: the rect block of
  `server/test/footprint.test.ts` (corners solid, the ellipse arm asserted so
  it cannot pass by blocking everything, and the bucket asserted from outside).
- **INDOOR SCENERY IS DRAWN WHILE ITS ROOF IS CUT AWAY** — the furniture of
  every house and cave. `buildPlacements` FLAGS a placement under a roof/cave
  deck (`SceneryPlacement.roofed`) instead of dropping it: render3 drops those
  from its OVERVIEW, which a cut-away must not copy. `rebuildScenery` then
  draws one only while `WorldScene.roofCutAwayAt(cx, cy, level)` is true —
  `indoorMask` up (the DRAWN cut state, so the exit fade keeps the furniture
  until the roof slab is back, exactly as `aboveCut` treats bodies) AND
  `cutAt` finite for that column (Infinity = drawn whole: the street, the
  neighbour's house, my own building before I step in) AND the piece at or
  below that cut. (136 of the_game's 1,263 placements — every bed, cupboard,
  hearth, table, chair, brazier and rug — were dropped at LOAD and could never
  be drawn, while the server stamped their footprints into the collision grid
  from `world.scenery` whole: maintainer, "it feels like something is
  invisible inside this house". Measured standing in the 180-cell inn: 17 of
  17 of its pieces drawn, and only 17 of the 136 released — every other roof
  on the map keeps its furniture hidden, which is the bush-on-the-roof rule
  the drop was protecting.) Probe: `__ml.sceneryIndoor()` (placements/roofed/
  cutAway/drawnRoofed/maskUp/grade). Gates: `scripts/verify-indoorscenery.mjs`
  (derives the most-furnished room from the world doc; a real join, inside and
  out) + the placement half of `server/test/scenery3.test.ts`.
- KNOWN GAPS, stated: no FADE GUARD in the game (it is a pixel test over art the
  pool has not fetched yet — measured, 2 of 10 pools keep a tile render3 drops,
  which is a wrong tile inside a 1-cell band, never a hole;
  `Tiles3.stats.unguardedFadePools` counts it); scenery draws STILLS only (no
  idle animation) and registers no occluderMeta, so a body sorts against a tree
  by painter depth alone; `buildIndoorDebris` is world@2-only, so a maps3 indoor
  transition is instant rather than eased; the resolver is proven against the
  parity fixture, and render3 has since grown slopes, set-dressed wall caps and
  a Chebyshev fade band, all of which are RESOLUTION decisions and belong in
  tiles3.ts and its fixture.
- Both bases are INJECTABLE (`ml-staging-base`, `STAGING_WORLD_BASE`) — the
  sandbox denies headless-browser egress, so the gate points at a local
  fixture origin.
- Gate: `verify-stagingworld.mjs` joins a world existing ONLY on the fixture,
  named `staging_probe_<t>` unique per run (Colyseus keeps a room per world
  name; a reused name rejoins the old room). Asserts the server half (fixture
  spawn cell + monsters) AND client half (all tiles from the fixture, ZERO
  requests for that world to the game origin). Fixture is monster_demo, NOT
  house_demo (house_demo ships zero spawn zones — it can only fail).
- `check-atlas.mjs --ship` drops non-published worlds' atlases from the image
  (18 MB → 1.7 MB).

**AR RETENTION**: `deploy/ar-cleanup.sh` — a server-side Artifact Registry
cleanup policy (keep newest 15 versions, delete >14 days), pasted once into
Cloud Shell from a phone. No CI job, no credentials, can't break on a red
pipeline.

## What this is

The Nangijala game client + server. Renders the sibling art domains
(`characters2/`, `tiles2/`, `maps2/`, `scenery/`) **read-only** — never edit
them (`coordination/PROTOCOL.md`). Boards: `coordination/games.json` (game
agent) + `coordination/games-ui.json` (games-ui agent; the per-file ownership
split is `UI_AGENT.md`). Self-iterating loop: `loop/LOOP.md`.

## Tech stack

- **TypeScript npm-workspaces**: `shared/`, `server/`, `client/`.
- **Server** (`server/`): Node + **Colyseus** authoritative `WorldRoom` with
  the single shared `WorldState` (map of `Player`s). Clients send `input`; the
  server integrates on a 20 Hz tick (`shared/stepMovement`) and syncs state.
  Persistence in `store.ts` (returning players keep their spot by token).
  Plain `tsx`; the schema is decorator-free (`defineTypes`, not `@type`) — no
  `experimentalDecorators`/Node-version fragility.
- **Client** (`client/`): **Phaser 3** + `colyseus.js` (Vite). Client-side
  prediction + reconciliation; chat + roster; renders the isometric world.

## Assets (served at /assets)

- Art is read from the repo-root sibling domains — NOT copied in. Dev (Vite
  middleware in `client/vite.config.ts`) and prod (`server/src/index.ts`) both
  serve `/assets/<domain>/…` from `characters2/ tiles2/ maps2/ scenery/`
  (`ASSETS_ROOT` overrides, e.g. in Docker).
- `scripts/build-manifest.mjs` scans `characters2/humans/` →
  `client/public/characters.json` (uid, name, frame size, per-anim/dir counts,
  urls); `build-worlds.mjs` discovers `maps2/worlds/*/world.json` →
  `client/public/worlds.json`. Regenerate after graphics change
  (`npm run manifest`).
- **LOSSLESS WEBP IS THE PRODUCTION IMAGE FORMAT** (repo law — see root
  CLAUDE.md). Migration COMPLETE 2026-07-31, verified by loading every world
  in a real built client: zero PNGs, zero fallbacks, zero 4xx across 15,856
  asset requests. Convert with `games2/scripts/to-webp.py` (lossless +
  `exact=True`, both mandatory). The FOUR deliberate PNG exceptions:
  1. `client/public/icons/*.png` — PWA icons (`manifest.webmanifest` declares
     `image/png`; iOS `apple-touch-icon` requires PNG).
  2. `client/ui-src/**`, `scripts/assets/**` — the maintainer's hand-drawn
     SOURCE art; build inputs, never served (baked output in `ui2/` is WebP).
  3. `server/test/fixtures/*.png` — the WebP gate's comparison pair.
  4. `tiles2/docs/`, `lore/icons/` — documentation art.
- **The transitional fallbacks are GONE — do not reintroduce them** (removed
  2026-07-31 once measured clean: the server's `.png`↔`.webp` sibling
  middleware, `WorldScene.loadImageEitherExt`/`onLoadMiss`, the campfire
  retry, `MapPreviewScene`'s minimap fallback). A server-side fallback MASKS a
  stale path — that is exactly how maps2's un-re-exported worlds went
  unnoticed for a day. A stale extension must 404 loudly; the fix belongs in
  the domain's exporter. (`imagelib.resolveImg` still follows a stale
  extension at BUILD time for manifest-driven domains — free, tested, stays.)
- All image reads in the builders go through **`scripts/imagelib.mjs`**
  (`imgDims`/`imgAlpha`/`imgRGBA`/`resolveImg`/`findImg`/`countFrames`).
  Rules that keep conversion safe:
  - **Lossless only.** A fully converted 11,152-file tree builds manifests
    IDENTICAL to the PNG build (both builders read only the alpha channel,
    which survives lossless exactly; RGB under transparent pixels may differ —
    invisible, never read).
  - **Extensions may be stale** — `resolveImg` follows `.png`↔`.webp`, so
    nothing has to land in order.
  - **The client never guesses**: `characters.json` carries `animExt` per
    state (absent = png) and the portrait's real extension; monster strips and
    world tile paths come from data.
  - Decoder is **`@cwasm/webp`** (120 KB, synchronous WASM) — NOT sharp
    (builders are sync; sharp is async-only). Also 4.7× faster than pngjs
    (384 strips: 1,494 → 319 ms).
  - **No conversion step in the Dockerfile** — it would re-run per deploy and
    bust the layer cache. Convert once at the source, commit the WebP.
  - Gate: `server/test/imagelib.test.ts` with committed PNG+WebP fixture
    pairs. TWO assets are named directly in game code and queue the png stem +
    re-queue `.webp` on 404: the campfire strip (scenery ships no manifest;
    `WorldScene`) and the world minimap (`MapPreviewScene`).
  - **Dev serving**: prod's `express.static` knows webp; the DEV middleware in
    `client/vite.config.ts` has a HAND-WRITTEN extension table — a format
    missing from it is served `application/octet-stream` and the browser
    refuses it. Add any future format there.
  - The world picker's thumbnail (`build-worlds.mjs`) probes `webp` before
    `png` per stem, so a mid-conversion world keeps its picture.

## Isometric world

- `shared/parseWorld` reads `maps2/worlds/<name>/world.json` — **world@1**
  (materials/paths/top/level/mat grids + props + spawn + size; legacy
  `rows`/bigworld@1 still parse). Geometry: `x=(col-row)*32`,
  `y=(col+row)*dy − level*lh`, painter order `(col+row,row)`. World units:
  **32 per cell** (`CELL_WU`); WORLD_WIDTH/HEIGHT are sized to the grid.
- The world is too large for one texture: `WorldScene` streams a
  world-anchored ground RenderTexture covering screen + `GROUND_MARGIN`,
  redrawn when the camera nears its edge. `MapPreviewScene` (`/#map`) shows a
  world's pre-rendered minimap when shipped.
- **Anti-tiling: NONE, on purpose.** Varying tiles is the maps agent's job —
  this repo never swaps a cell's art. REJECTED and fully rolled back: a shader
  seam-smear AND a brightness "ground wash" (maintainer wants the fresh,
  effect-free ground). Do not reintroduce any ground repetition effect.
- **world@2 decks** (elevated walkable slabs — roofs, bridge spans): strict
  superset of world@1 (`parseWorld` optional `decks`; `Deck`/`DeckCell`). A
  deck is a SECOND surface floating over unchanged base terrain (walk/swim
  UNDER it). `redrawGround` draws each deck cell right after its base cell:
  `thickness` face tiles then the `top` diamond at `level`. Spec:
  `maps2/spec/WORLD_FORMAT.md`; only `occlusion_test` ships decks.
  - **Current-layer movement**: each `Player` carries `elev` (surface LEVEL);
    `shared/canEnterElev`+`resolveElevAt` offer a deck cell TWO surfaces and
    keep you on whichever is reachable and closest to your current elev — you
    cross a bridge/roof instead of falling through; under-walkers stay on the
    base. Non-deck cells resolve exactly as `canEnter` (world@1 unaffected). A
    deck stays walkable over a blocked base.
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
  when the camera drifts `OCC_STEP` = 96px — pooled on maps3, see THE OCCLUDER
  SET IS POOLED below; the maps2 branch still destroys and recreates):
  - Deck cells get the exposed-face rule via `deckCoverFrom`, comparing BANDS
    (a slab covers `[level-thickness, level]`; only a CONTIGUOUS run reaching
    my own bottom hides my faces). Without it every face level of every deck
    cell drew — the_island2's 16-32-level cave decks were ~65% of the mountain
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
    0 (props excluded — they draw from `propImgs`, never culled). Measured:
    13,521 → 3,885 images at the mountain; `coverY` under every thick cave
    slab bit-identical to pre-cull. Gate: the occluder block of
    `verify-smoke.mjs` on `occlusion_test` (the only compact world with BOTH
    level-32 terrain and decks), standing and walking.
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
    depth = base + creationIndex × `OCC_DEPTH_EPS` (1e-6), scenery included,
    which reproduces "insertion order among equals" exactly and tops out at
    ~0.006 — far inside the ≥0.3 every body and light keeps from a column
    (`resolveBodyDepth` +0.5 / above+0.6 / below−0.3; lights +0.1). The
    metadata (`occluderMeta`, `emissiveLights`, the cover index) is still
    rebuilt in full every time: it is data, and the cover index's staleness
    contract is unchanged. **The epsilon is a BASE-band quantity: nothing that
    goes through `litDepth` (×1e-5) takes it** — lit copies are never pooled
    and keep their creation order, and 1e-6 in the lit band is 0.1 world px
    per index (review caught scenery lit copies 165-540 px in front of the
    bodies before them). The maps2 branch (the_island2) creates images the old
    way and never sees the pool. A pooled image the scene has destroyed
    (`scene` gone) is dropped, never reused; anything a throw strands in the
    pool is drained at the next rebuild. The pool holds TEXTURE OBJECTS across
    rebuilds, so tiles3's `limit: 0` cache must stay unbounded, or an eviction
    must clear the pool too.
  - **STREAMING REPAINTS ARE COALESCED** (`requestRepaint`, 2026-09-02). While
    a window's art streams in, three things used to run a FULL synchronous
    repaint — the terrain batch landing (`Tiles3Loader.onBatch`), the scenery
    batch landing (its own `once("complete")` on the SAME Phaser loader, so one
    batch fired both), and the scenery manifest settle — each redrawing the
    whole ground RT (41-52 ms) and every occluder. Measured over a 24 s walk
    with art landing: 8 of 11 occluder rebuilds and 8 of 8 ground redraws were
    that, not camera movement. Now a landing MARKS what it dirtied and
    `update()` poisons the matching latch at most once per frame: a terrain
    batch needs ground + occluders (its plates were holes, its faces skipped);
    a scenery batch or manifest needs the occluder rebuild ONLY — scenery rides
    inside it; the terrain occluders come back out of the pool, while the
    scenery images and lit copies are rebuilt in full (not pooled). The
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
    the occluder+scenery rebuild and the per-frame fog/lit-copy pass. Reducing
    that floor, not spreading it, is the open work.
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
  - **FLAT SCENERY DRAWS UNDER EVERYTHING** (`collision: false` — the six rugs
    and one clutter piece; maintainer 2026-09-03: "no collision means the object
    is flat on the ground … everything marked as no collision should always be
    drawn under the player/monsters/npcs/other scenery"). `parsePiece` publishes
    the manifest's own `collision` (absent = solid), and a flat piece: draws at
    `SCENERY_FLAT_DEPTH` (−500,000, plus its painter line ×1e-3 so two rugs
    still sort against each other) — under every body, piece and terrain
    occluder, above the ground texture at −1,000,000; gets NO LIT COPY (the copy
    exists to lift a standing object above the darkness overlay so it reads as
    its own silhouette; floor wants exactly the ground's light, which is what
    being under the overlay gives it — and no copy means no cover crop and no
    fog silhouette to keep in step); and registers NO occluderMeta. That last
    one was a live bug: `top` rounds `world_px_height` (39-56 px) over `lh` (15)
    to **3-4 LEVELS**, so a rug claimed to cover the player standing on it —
    the "wall hack border in open ground" this file already warns about, from
    the same maintainer report. (The note that "a rug rounds to 0 levels" was
    wrong: it never did.)
  - **SCENERY RESOLVES THROUGH THE BODY RULE — `resolveDrawDepth`, ONE
    implementation, four callers** (players, monsters, NPCs, scenery). This is
    the standing law of this file — *never hand-roll a second depth/shadow/
    lighting path for a new entity type* — and scenery broke it twice in one
    night before it was obeyed: a piece-only depth (no LIFT above the flat tile
    in front, so grass drew over a tree) and a piece-only cover test
    (`litCoverY`, deleted). Both are gone; the scan that answers "what painter
    depth, and where does terrain cover me" lives in `resolveDrawDepth` and
    `resolveBodyDepth` is now a thin wrapper over it (setDepth + the cover
    slot). Maintainer 2026-09-03, with the screenshot: "this is a classic
    'let's implement the player's renderer again' bug … in the end we will end
    up with the player's renderer, because that code is what is needed to not
    have any bugs."
    TWO THINGS SCENERY NEEDS THAT BODIES DO NOT. (1) It resolves in a SECOND
    PASS, after every piece has registered its occluder record, so a piece
    sorts against its neighbours and not just against terrain — a one-pass
    resolve only ever sees the pieces drawn before it. (2) Its OWN record is
    excluded (`self`): scenery is IN `occluderMeta` and bodies are not, so
    without it a tree reads itself as a solid covering itself and crops its own
    lit copy to nothing. The lit copy then takes `litDepth(resolved)` and the
    cover line the same call returned, so copy and base can never disagree.
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
  - **The deferred animation batch is PACED (#7).** `loadDeferredAnims` (every
    character's non-boot states, every NPC rotation/idle frame, 525 monster
    combat strips, ~1,000 files) streams behind the live world, and each landed
    file is a decode + GPU upload on the main thread the moment it arrives. At
    the loader's default parallelism (32; 6 on Android) a warm cache landed them
    in bursts: measured on the north run, 32-105 textures added per step for
    the whole run. The batch runs with `maxParallelDownloads = 2`
    (`DEFERRED_PARALLEL`; restored on COMPLETE), which bounds arrivals to ~2 per
    frame — measured 3-15 per step — at the price of the batch taking ~10-16 s
    on a phone instead of ~3 s; nothing in it is needed in the first seconds
    (my urgent clips are queued first and register per state as they land).
    Anything appended to the scene loader meanwhile (item icons, the grave
    cross, chess pieces) queues behind it, as before — FIFO — only later. Dev
    A/B: localStorage `ml-deferred-parallel` (0 = the loader's own);
    `__ml.perf()` reports texture adds by key family and the per-frame max.
- **A DECK'S `thickness` IS THE CONTRACT — never force a course.** `deckCell`
  draws the slab from `lo = dl - thickness` (or `dl` where `frontCovered`), and
  `thickness` means "EXTRA face tiles below the top; 0 = the top only"
  (`shared/src/index.ts`). It used to read `dl - Math.max(1, th)`, which
  overrode a declared 0 and hung ONE EXTRA STOREY under the deck's whole front
  row. Over a wall cell that course hides behind the wall and reads as the
  roof's fascia; over a DOORWAY there is no wall under it, so it hung into the
  opening and a 5-level door measured 4 — the player hit his forehead walking
  in (maps2 2026-09-03). Verified against the world: the smithy's roof is deck
  21, level 6, `thickness: 0`, `frontCovered` false at 430,372, so the old
  expression drew courses [5,6] where the data says [6]. render3.py fixed the
  same line on 2026-08-30. the_game ships 15 roof decks at thickness 0, so this
  was every doorway on the map.
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
  - Gates: `server/test/falldamage.test.ts` (curve pins; the_island2 route law
    verified failing on the pre-fix baseline; live-room cliff + dive).
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
  scuff (`fs-dot` `#141418`); only near-black `black_mountain` overrides to
  lighter stone dust (≈ `#9a9aa0`); sand/snow/ice get darker/cool presses.
  Marks draw below the night overlay (contrast holds at night); foot-width
  ~7px; depth `y-0.5`; pooled + capped 240; peak alpha ~2s then quadratic
  ease-out. Probes: `__ml.footprints()`, `__ml.footprintsList()`,
  `__ml.myScreen()`. QA on trans_demo's flat material bands.

## Monsters (client rendering = the SHARED body pipeline)

- **Spawn placement is MAPS2 DATA**: every world ships
  `maps2/worlds/<name>/spawns.json` (`pixel-maps2/spawns@1`, spec
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
- **"DISABLE AGGRO"** (Settings, off by default, `ml-no-aggro`) — a testing
  switch so a cave can be walked and looked at. Enforced on the SERVER per
  SESSION (the proximity scan runs there); the client re-sends it on every
  join. Deliberately NOT a schema field (a synced field per player for a
  debug flag); it is a `Set<sessionId>` on the room, cleared in `onLeave`.
  Suppresses UNPROVOKED aggro only — a sword-marked monster still comes, a
  hit one still fights. Flipping ON also RELEASES every unprovoked chase via
  `disengageMonster` (else you'd have to outrun what already noticed you).
  Gate: `server/test/noaggro.test.ts` — each step on a FRESH predator (a
  monster whose hunt just ended is `returning`, scan suppressed by design).
- **THE BODY-DODGE IS A MANOEUVRE, NOT A PER-FRAME OPINION** (`monsterDodge`;
  NPCs and monsters have faked client-side collision — the INPUT slips around
  their personal space). The laws, from the back-and-forth-panic reports:
  - Engage and release on DIFFERENT thresholds: engage at `dot ≥ 0.35` inside
    the personal corridor; HOLD the committed blocker until `dot < 0.0` with a
    1.35× wider corridor. Widening only the HOLD makes it hysteresis, not a
    bigger trigger.
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

## Chess at the board

A playable chess easter egg: stand at a free seat on a world board and the
JUMP BUTTON becomes START / JOIN CHESSGAME; both players get a DOM dialog.
One rules module for server, client and NPC — `shared/src/chess.ts`; room and
match logic `server/src/chess.ts`; dialog `client/src/chessui.ts`; gate
`scripts/verify-chess.mjs`. Boards are placed in
`games2/config/chess_boards.json`, overridable per world from
`live/tuning/chess.json`.

- **PIXEL ART SCALES BY A WHOLE DEVICE-PIXEL FACTOR, NOT A WHOLE CSS ONE**
  (maintainer: "fractal scaling"). `image-rendering:pixelated` resolves in
  DEVICE px, so what must come out whole is `css x dpr / art` — at his dpr 2.75
  a 1:1 CSS sprite is 2.75x and neighbouring source pixels get 3 and 2 device
  px. `chessPieceCss` / `pixelArtCss` (shared) pick the integer scale and work
  back to a possibly-fractional CSS size; the dice strip scales all three of
  hand, `background-size` and the keyframe's landing offset together or the
  frames tear. The dragged ghost is NOT scaled up for the same reason. The
  opponent does not re-play the throw and is never mirrored — flipping it stood
  his die on its head; he shows the strip's last frame, upright. Tested at real ratios in `server/test/chesssize.test.ts` (no
  headless run reproduces 2.75).
- **DRAG AND TAP ARE ONE GESTURE, AND A DROP IS A MOVE OR NOTHING.**
  pointerdown always selects (that IS the tap flow); a drag starts past a 6px
  slop radius and lifts a ghost onto `<body>` (the squares are overflow:hidden
  and would clip it). THE TARGET IS THE SQUARE UNDER THE FINGER — hit-testing
  at the lifted ghost aimed 30px, two thirds of a square, high and read as a
  broken hitbox. The landing square highlights live while dragging, and a drop
  with no legal move re-selects NOTHING (`dropSquare`, not `tapSquare`, whose
  select-fallback is right for a tap and wrong for a drag).
- **DIALOG STABILITY LAW** (drop-dialog family, paid for in a 6-round ghost
  hunt): the card skeleton is built ONCE and its controls NEVER move or get
  replaced — squares update in place. THE VERDICT OBEYS IT TOO: won/lost/draw
  is a SCRIM over the board (absolute, inside `#ml-chess-board`), never a row
  in the column — as a flow element it grew the card 372 -> 424 px and shoved
  the board up the instant the game ended. verify-chess measures card, board
  and footer across the resign and fails on >1px of movement. A full re-render used to shift the
  Resign button sideways under a tap aimed a beat earlier.
  `touch-action:manipulation` on the card; the backdrop preventDefaults ONLY
  its own events (hud.ts's drop-dialog law — a card-event preventDefault eats
  button clicks on touch).

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

maps2 places people (`maps2/worlds/<name>/npcs.json`, `pixel-maps2/npcs@1`,
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

## Depth-fog on BODIES (syncLitCopy)

Monsters and remote players are coloured by the elevation depth-fog like the
terrain they stand on. Mechanism: every body draws twice — the raw sprite
UNDER the fog overlay (fogged exactly like tiles) and the crisp lit copy
ABOVE it; the copy's alpha fades by `night.depthFogAt(col,row,lvl).a` at the
body's own surface level, cross-fading crisp→fogged. NOT transparency: at
heavy fog you see the fog-painted body. The local player is fog-0 by
definition. Probe: monsterInfo() lit.alpha (own level 1.0, teal band 0.735,
saturated summit 0.001 — matches the terrain wash).

## Depth-fog on SCENERY, PROPS and BODIES (the fog silhouette)

Every scenery piece, solid prop, monster, NPC and remote player is seen through
its LIT COPY at `litDepth`, ABOVE the fog overlay, whenever the night shader is
active (always under WebGL) — so the fog pass never reached it and a piece stood
crisp on fogged ground (maintainer 2026-09-03: skulls, spires, tree roots "pop
out"; "the same fog at the top as at the bottom"; "monsters and NPCs should have
the same effect"). Mechanism (`applyObjectLights` for pieces, `syncLitCopy` for
bodies): each lit copy gets a FOG SILHOUETTE — the same art, frame, crop, flip
and box, `setTintFill` in the fog's own colour, alpha = the fog amount, at the
copy's depth and made after it (equal depth, stable sort: drawn right over its
own copy). EXACT by construction: copy·(1−a) + fogcol·a is what the pass paints
on the ground under it. NOT a faded copy (the old bodies' cross-fade): the fog
under a faded copy is itself weighted by a, so a thing composited to a·a fog
against the ground's a — a root still near-black beside grey ground (measured on
the maintainer's phone at night). Fog 0 → no silhouette drawn.
WHERE THE FOG IS READ — `depthFogAtFoot(wx, wy, level)`, the JS twin of the
fragment, at the thing's FOOT POINT on screen (a piece's anchor, a prop's tread
centre, a body's feet) and the tread's integer level:
- The pass measures horizontal distance in a SMOOTH SCREEN-SPACE FIELD, not in
  cells: it seeds the surface at the player's level, drapes it three times
  through the blurred terrain (`drape`, the linear heightmap's R−G) and inverts
  the iso projection — a plateau 8 levels up drawn just below the player is
  NEAR ground to it. A twin using the true cell distance over-fogged such a tree
  by 10x (pass 0.04 vs 0.48). `screenFogDist` mirrors that field from the CPU
  height arrays (`hArr − pArr`, bilinear at texel centres, byte-rounded like the
  texture), so the twin lands where the pass does.
- The band is CENTRED between the tread's cel-snapped steps (distCont − ½,
  unsnapped): gradual with distance, never more than half a band from the
  ground under it (maintainer: "fade more gradually … but as close as possible
  to the fog on the ground the scenery is standing on"). `depthFogAt(col,row,
  z, snap)` — the cell-distance twin — remains for callers that own a cell.
- The foot point IS the anchor: a body's `sprite.y` (its origin is the measured
  foot line — the frame's bottom edge sits 17-19 px below it, ~0.7 band nearer
  in the field), a prop's diamond centre (`by + margin + dy − l·lh`), a piece's
  `p.ax/p.ay`. The twin carries the fragment's ROOM FADE (`a *= mix(1, inRoom,
  indoorMix)` on the thing's own cell): without it a body outside my room wore
  a pale fog figure over its zero-ambient black copy.
- LIFECYCLE: a silhouette is made RIGHT AFTER its copy (`makeFogSilhouette`;
  bodies at `b.lit` creation) so ties in the epsilon-free lit band keep
  litA, fogA, litB, fogB — a silhouette made later would draw over the NEXT
  copy. Every place that hides a lit copy without `syncLitCopy` (the monster
  and NPC culls, `aboveCut`) hides the silhouette too, and a swimmer's
  waterline mask is mirrored onto it (a distant swimmer wore fog legs over the
  water).
Probes: `__ml.fogProbe(col,row)` / `fogProbeAt(wx,wy)` read the pass's own pixel
beside both twins; `__ml.fogPieces(radius)` lists every lit piece with its
foot-point fog and the pass under it; `__ml.objectsIn(x0,y0,x1,y1)` dumps the
display list in a world rect. Switch: `__ml.sceneryFog(on)` (bodies too).
REJECTED (built, reviewed, removed the same night): a "scenery base field" —
stamping every scenery silhouette with its base cell into a texture the fog
shader samples so the under-image took the base cell's fog. Correct, but
invisible: the opaque lit copy covers the under-image. Cost: one extra Image or
Sprite per visible thing while its fog is non-zero, plus the twin's 15 bilinear
height reads per thing per frame.

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
- **`__ml.teleport(col, row)`** — drop the player at the exact coordinates
  shown under the avatar's name (`fx/CELL_WU, fy/CELL_WU`). Server-
  authoritative ("teleport" message clamps, sets `elev`, clears queued
  movement/jump); camera snaps. Lands where asked even off standable ground.
  Debug only.

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
  `Shader.willRender` returns true unconditionally in that case, so all three
  full-screen passes run EVERY frame whatever the visibility says — this note
  used to claim mist was "skipped while clear" and it never was. A pass is made
  cheap only by a uniform guard on the FIRST line of its own `main`, which is
  where DEPTHFOG_FRAG's `uFog` test has always been and where MIST_FRAG's
  `uMist` test now is; before that it sat after the 128-iteration surface
  march, so clear weather paid for the expensive part of a pass that then
  returned nothing.
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
- STALE GATES, known: verify-glow-seams (11 horizontal raw-field seams on
  glow_test, identical on the pre-light-ledger baseline — pre-existing);
  verify-solidband + verify-wallspread (predate maps2 worlds, fail on
  baseline); verify-penumbra is PINNED TO NIGHT and finds pre-existing base
  defects at some ledges (fails identically on the pre-sun baseline —
  candidate-placement sensitivity, needs its own follow-up).

## Night lighting (client/src/nightlight.ts)

- Always-night per-pixel shader: MULTIPLY overlay; per-pixel surface resolve
  (cell + height) → point lights with attenuation, LOS cast shadows, Lambert
  face gating with penumbras at both ends of every wall band.
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
  gated on `uHasProps` (the_game places no props, so its 7 iterations and two
  fetches per pixel per daytime frame were identity); `emitAt` is fetched only
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
  mountains fog (occlusion_test tops at exactly 7 = the boundary). REJECTED:
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
  + solid objects and drives ONLY the LOS march. A cell's LEVEL packs into
  one 8-bit channel as `level*hScale`, decoded `*255/uHScale`; **`hScale` is
  chosen PER WORLD** in `buildHeightmap` (16 for worlds ≤15 levels —
  byte-identical to history — smaller when taller). The old fixed *16
  SATURATED at 15.9 levels: the_island2 (peak 32) clamped every high cell and
  the depth-fog painted a hard seam across the flat peak. Regression:
  scripts/verify-heightscale.mjs (teleports to the level-32 peak).
- **Solid objects are ART, not walls**: they block light and cast a soft
  shadow but must NEVER get a wall-face band — modelling them as blocks
  painted knife-edged phantom shadows outside the drawn art.
- **A CAVE MOUTH IS NOT A WALL FACE**: `Ha` is max(terrain, deck), so pixels
  under a roof slab classified as FACE and took face Lambert + face shadow —
  painting the open entrance like glass (maintainer: "some sort of mirror or
  force-field"). A face now also requires solid GROUND above the pixel
  (`groundAt(cell) − z > 0.05`); the uTest-4 calibration branch carries the
  same condition or the gates measure a rule that doesn't ship. Real walls
  untouched (their ground top IS their surface).
- **Contract for new tile categories**: unknown categories default to plain
  walkable ground AND terrain lighting; every new solid/decor category needs
  a SURFACES entry or its block shadow returns. ENFORCED: `npm test` runs
  `scripts/check-surfaces.mjs`, which FAILS on an unclassified category
  (across ALL maps2 worlds) and prints a ready-to-paste proposal; WorldScene
  warns at boot. The table lives in its own file
  **`shared/src/surfaces.ts`** (small, conflict-light; `index.ts` re-exports)
  — the ONE games2 file the ART agents are authorised to edit, so their
  deploys never stall on the game agent. Runbook: **`games2/SURFACES.md`**.
  If a DIFFERENT gate fails on an art push, that's a real art bug, not a
  surfaces edit.
- **EMISSIVE TILES ARE REAL LIGHTS — THE LIGHT SLOT LEDGER** (maintainer: "NO
  DIFFERENCE in how bright the bonfire [tile] is vs the campfire [object]";
  measured parity 0.95). `buildEmissiveSources()` resolves every emissive prop
  once per world and `pickWorldLights()` fills THE LEDGER: 12 slots = 1 my
  torch + 1 ambient agent + 2 future fx + **8 world**, reservations STRICT,
  never lent. Write-side APIs: `client/src/lightslots.ts`; the slot table,
  placement rule, derived-default formula and `tiles2/emission.json` `lights`
  fields are in `games2/spec/LIGHT_BUDGET.md` (whose `LIGHT_HYST_PX`
  hysteresis predates tenure — this file wins). Curated params live in
  tiles2's `pipeline/emission.py` LIGHTS; a hand-edit of the json is lost on
  regeneration. A slotted source's ground-pool STAMP is suppressed while it
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
    orange blob on the roof. `sealed` is probed per source at the 4-NEIGHBOURS
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
    defined with their reasoning in WorldScene.ts. Gate:
    scripts/verify-lighttenure.mjs (pans glow_test, ~180 sources vs 8 slots).
    ITS TRAPS: the first lookAt is a camera TELEPORT that legitimately dumps
    spawn-side holders (settle before the baseline), and fairness numbers are
    captured AFTER the frame's decisions.
  - `check-light-budget.mjs` (in `npm test`): no camera window may be
    reachable by >8 world pools. RATCHET: pre-existing over-budget worlds are
    pinned in `spec/light-budget-baseline.json` at their measured worst and
    fail only when WORSE; it MIRRORS the client's radius derivation (drift
    audits a different set than the renderer lights). The LIVE the_island2 is
    **8/8, exactly at the line** (worst window at 114,54) — tell maps2 before
    adding ANY light source near it.
  - The QA `probeLight` consumes a WORLD slot while set — slot-counting gates
    must expect ≤7 world holders. Probes: `__ml.lightSlots()` (live ledger +
    overflow), `__ml.lightAt()` (CPU twin), `__ml.torch(on?)`. Gate:
    `scripts/verify-lightparity.mjs` (parity, indoor, budget invariants).
- **Self-emission** is data-driven from `tiles2/emission.json`
  (`tiles2-emission@1`, tiles2's): per-MATERIAL glow params + per-tile-path
  `sources`. In maps2 worlds every emissive tile is a PROP; `rebuildProps`
  stamps a tinted radial halo per visible source into the world-anchored
  additive glow RT the shader ADDS to the light field (a mushroom lights its
  patch, the forest stays dark). Showcase world: maps2's `glow_test` — where
  glow/night QA happens.
- The light/mist/depth-fog overlay quads BLEED ~1% past every screen edge
  (spanScale = 1.02; overlays drawn at invZoom*k while uCam spans k× the
  view — the stretches cancel, world→screen mapping EXACT): without it,
  fractional zoom left the quad a sub-pixel short and high-DPR phones showed
  a 1px unshaded line at night. TEST PATTERNS (nightCal ≥3) render with k=1
  (raw-field readbacks treat canvas pixels as texels 1:1; the stretch
  resamples rows into phantom seams).
- Debug: `__ml.nightCal(flip,span,test)` (field test patterns — headless
  only; the old [6]-[9] keys are retired); `__ml.probeLight(col,row,z,
  radius)`; `__ml.lookAt(col,row)`. Numeric probes: verify-solidband,
  verify-penumbra, verify-wallspread, verify-timecycle, verify-lit-order.
  Run them against a dev stack before touching the shader.

## Mobile / PWA (client)

- **WIKI-STYLE UI (the complete HUD remake, 2026-07-30)**: the pixel-art UI
  kit and vine/crystal frame are RETIRED (frame2.ts + plate.ts deleted;
  history in git). Every DOM surface is plain HTML/CSS on the SHARED WIKI
  THEME (`client/src/theme.ts` = wiki/site/wiki.css tokens: cream/dark
  palettes, serif headings, coral #d97757 accent, 1px var(--border), 8-14px
  radii). DARK MODE is one choice for wiki AND game:
  localStorage["wiki-theme"] → `<html data-theme>`; theme.ts follows the wiki
  drawer via `storage` events; wikipanel.ts mirrors game-side toggles onto
  the live iframe (`storage` doesn't fire in the writing document); Settings
  has a theme button. Pixel-art ICONS
  stay, pixelated, at their AUTHORED 1x GRID — hud.ts sizes each img to
  naturalWidth/2 (the /ui2 bakes are exact 2× of hand-drawn art on
  non-square canvases; a fixed square box distorts — maintainer: "not pixel
  perfect"). Tab row + pages share 16px side margins; tabs 56px (48 at
  ≤640h); 1px bottom rule. REJECTED (maintainer, do not re-propose): a
  screen-edge frame around the game view ("it looks bad" — full-bleed
  stands); an in-game bottom-right chip for the version badge (it keeps ONE
  quiet bottom-centre placement everywhere). NO zoom compensation in the new
  UI (uiscale.ts survives only for loading.ts + the reconnect toast). Gates:
  verify-bars/-hudtabs/-clockflip/-chatpage/-gamepad/-select.
- **THE WIKI DRAWER SLEEPS THE GAME LOOP** (`client/src/gamefreeze.ts`): the
  drawer hosts a second document on the SAME main thread, so `openWikiPanel`
  calls `freezeGame()` (TimeStep.sleep(), rAF cancelled) before the iframe
  exists; `closeWikiPanel` thaws. Measured: the wiki went 3.5fps/367ms
  stalls → 60fps/17ms worst. Nothing needed lives on that loop (Colyseus
  socket is event-driven — verified across a 30s freeze; WebAudio schedules
  itself; HUD is DOM). Input stops, which is correct (the server integrates
  only what it receives; a frozen client stands still; >2-cell movers snap on
  return under the teleport rule). **Waking is NOT `TimeStep.resume()`** —
  see UI_AGENT.md: it arms Phaser's 120-frame panic cooldown = visible slow
  motion. Gate: section 3 of verify-wikibtn.mjs; probe `__mlFreeze`.
- **`__ml.nearby()` — WHAT IS AROUND ME, BY WIKI ID** (games-ui's 🔍 button,
  `client/src/wikinear.ts`; contract `spec/WIKI_NEAR.md`; maintainer
  2026-09-02 "a way to fast find what you stand next to"). One row per
  (domain, id) at the NEAREST instance, `n` = how many within the radius,
  nearest first, capped 80: monsters by roster id, NPCs by characters2 key,
  drops by item id, scenery by BARE piece id, and the ground as
  `tiles/<material>` on a Tiles 2.0 world or `world/<type>` on a Tiles 3.0
  one (`this.t3` decides — the wiki has two ground domains; `#/world/<type>`
  is its ground-type page). Bodies within 12 cells, ground within 4, the cell
  under the feet is distance 0. Other players are not rows (no page). A probe
  like the rest of `__ml`, called once per drawer open — the scene owns the
  maps, so the enumeration lives here; wikinear.ts only relays it into the
  iframe as `wiki:near` — together with `heard`, the composer's ledger of the
  score now + the sound events of the last 30 s (`gameAudio.heard()`, also on
  `__ml.audio().heard`). Gate: section 6 of verify-wikibtn.mjs (every id
  checked against the wiki's shipped index; the ear asserted when the harness
  has a running AudioContext).
- **HUD (golden-ratio split)**: game viewport = TOP 61.8% (`#game`,
  `--hud-h-inv`); bottom 38.2% (`--hud-h`) is the DOM HUD
  (`client/src/hud.ts`): 6 wiki-style tabs over pages. applyLayout()
  publishes --hud-h/--hud-h-inv in REAL px (consumers parseFloat). Settings
  hosts the toggles + theme; the time-of-day button keeps the `.ml-hudbtn`
  hook (smoke). `.ml-plate-btn` survives as a plain-CSS class — the ambient
  agent's cycler expects it. Pointer events in the HUD never reach Phaser —
  e2e taps stay in the top 61.8% (canvas centre y = VH*0.309).
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
    (jumps are cardinal). Gate: the occlusion_test bridge-climb trip in
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

## Audio (games2/composer — the games-audio agent's module)

- A THIRD agent works `games2/`: **games-audio** (the composer;
  `sounds/spec/AUDIO_INTEGRATION.md`), sole owner of `games2/composer/` +
  `coordination/games-audio.json`. It binds `sounds/` + `music/` to the game:
  WebAudio buses, surface footsteps at gait cadence, thunder, ambience, the
  looping score with ducking/night dip, scale-snapped tonal SFX. See
  `composer/README.md`.
- Game code talks to it ONLY via the `gameAudio` singleton — the calls
  sprinkled in WorldScene/hud.ts/main.ts/ambient/thunder are the audio
  agent's wiring; **don't remove them**, and emit new semantic events
  (`gameAudio.event("item.get")`, names from `sounds/bindings.json`) when
  adding gameplay that should sound.
- **Music beds generated but NOT routed**: five tracks (battle/cave/home/
  town/adventure) audition at `/#score`; the in-world score is unchanged
  until the maintainer picks what plays where. Routing is dormant in
  `composer/engine/contextMusic.ts`; selection is pure and tested
  (`composer/engine/bedSelect.ts` + test): priority + Schmitt hysteresis,
  PLACE BEATS TIME, fallback chain to the catalog track (never silence).
  When wired: battle reads the monster brain's `mstate` (chase/combat — a
  roaming monster scores zero), cave reads deck slabs overhead, home the
  spawn bonfire, town road/farm tiles. Beds are −18 LUFS with measured loop
  points and resume where they left off. Probes: `__ml.audioBed("cave")` /
  `__ml.audioBed()` / `__ml.audioField()`. Gate: scripts/verify-beds.mjs.
- **A SOUND PLAYS ONLY WHEN ASKED FOR — the wiki is where it gets asked**
  (maintainer). The engine is silent-by-default: an event plays NOTHING
  unless (a) on the small approved list (jump/fall grunts, UI clicks, chat
  notify) or (b) assigned by the Game Master in the wiki (requests land in
  `live/tuning/sfx_requests.json`; the composer wires them into
  `EVENT_ASSIGNMENTS` in `composer/engine/api.ts` and deletes the acted-on
  entry IN THE SAME COMMIT — a request is a message, not a record). The
  record of what an assigned event plays is **`composer/assignments.json`**
  (`pixel-composer-assignments@1`, built by `scripts/build-assignments.mjs`,
  staleness-gated by verify-quiet) — read THAT, never fall back to
  `EVENT_FOLEY`/`bindings.json` to describe an assigned event (they are
  outranked; showing one looks like a revert). `bindings.json` resolves only
  for `BINDINGS_APPROVED` names. **Emit semantic events freely** with
  LITERAL names (the wiki scans call sites; a ternary hides the name) —
  silent events are exactly what the GM assigns sounds to. Already emitted:
  combat.kick/.punch/.hit_taken/.monster_die/.cross_on/.cross_off,
  player.die, item.pickup, item.drop. Gate: scripts/verify-quiet.mjs (the
  can-sound surface must not grow without approval; the assignable events
  must keep being emitted).
- **Background**: hidden page → master ducks to 50%, the score keeps looping
  (native-loop handoff in composer/engine/music.ts — background timer
  throttling killed the crossfade scheduler). Gate: verify-background.mjs.
- `gameAudio.clock()` / `__ml.audioClock()` publishes live beat/bar phase +
  section intensity (context beds carry measured key + tempo, so tonal-SFX
  scale-snap keeps working). QA: `__ml.audio()`; scripts/verify-audio.mjs
  (dev stack, end to end).

## Dev-test workflow (fast loop — keep it this way)

- **Navigation/movement logic → `server/test/navigation.sim.test.ts`**, NOT
  the browser: the real brain (stepAutopilot) against the real body (unstick
  + stepMovement + auto-jump) on REAL worlds at ~1000× real time — ~100
  seeded trips × three frame cadences (16/133/400ms; the laggy rows catch
  the big-dt freeze and orbit classes) in ~2s inside `npm test`. On failure,
  print stepAutopilot's debug fields — full forensics, no browser.
- **Browser = graphics + glue only, ONE session**: `scripts/verify-smoke.mjs`
  runs everything browser-bound in a single Chromium + world load (~30s):
  loading overlay, badge, tap run, hold steering, keyboard cancel, jump anim,
  anim rates, in-place reconnect (last — it swaps the session), then one
  reload for a glow_test join. Per-feature scripts remain for deep dives.
- **Headless-GL starvation preflight**: verify-smoke measures raw keyboard
  speed first and ABORTS ("HARNESS STARVED") if slow — software-GL at big
  viewports throttles the frame loop into slow motion that fakes "stuck
  player" bugs (cost an hour of ghost-chasing once). Keep e2e viewports
  small (480×320); `scripts/debug-speed.mjs` measures.
- **HUD / visual QA at DEVICE-WIDTH mobile geometry** (the maintainer plays
  normal mobile view): Playwright `{viewport:{width:393,height:851},
  isMobile:true, hasTouch:true}`; check light AND dark when touching themed
  surfaces. Movement-timing e2e stays on the small fast viewport — the
  starvation rule outranks realism.
- **A ONE-PIXEL BUG IS REPRODUCED ON HIS EXACT SCREEN, AND ON THE SCREEN**
  (maintainer law, 2026-09-03: "Please recreate my exact screen when testing
  off by 1 pixel bugs like this one"). Two halves, and both are load-bearing:
  - `{viewport:{width:393,height:851}, deviceScaleFactor:2.75, isMobile:true,
    hasTouch:true}` — 1080x2340 backing. **`deviceScaleFactor` is the half
    that decides the bug**: it sets `renderScale`, hence the camera zoom
    (`cameraZoom(1080, 2.75)` = 3 exactly at rest) and the ground texture's
    `ceil(1080/2.75)=393 (+2*512)` texels. Any other dpr changes the texel
    grid and the sub-pixel phase, so the artefact simply is not there to find
    — a default-dpr viewport at the same CSS size is a DIFFERENT screen.
  - Compare the SCREENSHOT, not the render texture. A ground-RT dump was
    clean through every scroll while the phone showed lines, because a
    sampling artefact lives in how the texture reaches the display, not in
    the texture. Dump the RT to localise a defect you have already seen on
    the screen; never to argue one away.
  - Shoot MOVING as well as at rest. At rest the zoom is the crisp integer;
    the speed zoom-out sheds up to `CAM_ZOOM_OUT` of it, so every frame he
    actually plays is at a fractional zoom where a NEAREST texel is 2 or 3
    device px. Any straight-edge artefact belongs to that state.
- Rule of thumb: no pixels/pointers/websockets/Phaser anims needed → it
  belongs in `server/test` (3s), not a browser (minutes).
- **Deploy** (push to main → live): the workflow runs `test` (typecheck +
  full suite) IN PARALLEL with the layer-cached image build; `deploy` needs
  both. Triggers on `games2/**` AND every domain the image bakes (art pushes
  deploy automatically — maintainer; the concurrency group collapses rapid
  pushes into the newest run). A maps2 push using an unclassified tile
  category fails check-surfaces and BLOCKS its own deploy (prod stays on the
  previous revision) until the SURFACES entry ships — watch for red runs.
  Dockerfile layers are ordered deps → art (per-domain) → game source LAST;
  BuildKit's GHA cache makes a code-only deploy upload only the small
  source/build layers. Don't reorder the COPYs without thinking about which
  layer changes per deploy.
- **Loading screen** (`loading.ts`): select.ts shows it on "Enter world";
  WorldScene.preload feeds real progress; hidden when the player's own
  avatar joins (60s failsafe).
- **THE LOCAL PLAYER'S OWN ART IS FIRST IN EVERY QUEUE, AND REGISTERS PER
  STATE** (maintainer: "the player is the most critical graphics"). Two
  independent causes, fixing either alone did nothing:
  - ORDER: both batches iterated file order; `charsMeFirst()` (stable sort)
    puts mine at the head of the boot batch and the deferred one — ahead of
    the NPC idles now (the calm idle's frame-0 hold covers a frozen
    villager; a player with no death animation is worse).
  - REGISTRATION: `buildAnimations()` ran only on the loader's COMPLETE, so
    every clip became playable at ONE moment after the whole batch. Each of
    my states now registers the instant its OWN frames land.
  - **Counting the keys makes the early run SAFE**: a clip builds from
    whatever frames EXIST and is never repaired (`anims.exists` skips it) —
    registering mid-load would freeze an 88-frame die clip at 2 frames.
    `buildAnimations(uid, state)` may only run once every key queued for
    that state fired FILE_COMPLETE (an ERRORED file never fires; the batch's
    COMPLETE drops the listener either way).
  - `PLAYER_URGENT_STATES` = hurt/die/kick/punch/pickup — what can trigger
    seconds after spawn. Weapon/spell states deliberately queue behind the
    NPCs (nothing can play them yet; 128 of my 408 deferred frames).
    Ordering only, never a filter.
  - Measured on a throttled 12 Mbps link: hurt 1.18s, die 2.99, kick 3.77,
    punch 4.30, pickup 5.32 (weapon/spell 10.5-11.5) vs everything-together
    at the end before. Probe: `__ml.animReady()` (`mine.left` stuck >0 with
    `at` null = the fast path did nothing).
- **Asset loading is SPLIT + deploy-pinned cached** (the 13-state overhaul
  ballooned boot to ~1200 frames):
  (1) preload fetches ONLY `BOOT_ANIM_STATES` (idle/walk/run/jump,
  manifest.ts); the 9 action states background-load via
  `loadDeferredAnims()` once the avatar joins.
  (2) **Every /assets URL is stamped with its CONTENT HASH** — `?h=<sha256-16>`
  from `/asset-index.json` (assetver.ts), ONE `no-cache` document naming the
  current hash of every file under ASSETS_ROOT (`scripts/build-asset-index.mjs`,
  run in the image build after the curated root is complete; express's ETag
  makes the per-boot revalidation a 304 until a deploy changes art). The
  server grants `immutable` 1y ONLY when the hash equals the hash of THE
  BYTES IT IS ABOUT TO SEND (`server/src/assethash.ts`, memoised per file;
  `cachepolicy.ts`) — it never trusts the index. So an unchanged file keeps
  its URL across deploys and the browser never asks for it again, while a
  stale index can only earn a revalidated response, never a frozen wrong
  file (maintainer 2026-09-02: one uncached list of hashes, fetch only what
  changed — and no cache bugs). `?v=<build sha>` (VITE_GIT_SHA) remains the
  FALLBACK for whatever the index does not name — client/public art (UI,
  atlases, icons), a staging world's CDN URLs, any boot where the index
  failed — with the old rule: `immutable` only when v matches the server's
  OWN GIT_SHA, else no-cache. sw.js caches nothing. The index is fetched
  first of all in main.ts and awaited with the four boot catalogs (which
  are fetched in parallel — four serial awaits cost a round trip each).
  Gates: `cachepolicy.test.ts` (the ?h grant is verified against served
  bytes; malformed, stale and mismatched hashes never freeze; hashing is
  lazy), `assethash.test.ts`, `assetver.test.ts`.
  **THE BUNDLE IS A SEPARATE GRANT**: everything rollup emits into
  `client/dist/assets` is content-hashed by the bundler, so those URLs are
  immutable by construction. The rule matched `js|css` only, leaving 532 of
  535 emitted files (503 .ogg, 13 .m4a, 2 .mp3, 5 .wav, 9 .webp) on
  no-cache — 532 revalidation round trips per repeat visit over ~11 MB of
  bundled audio. The grant is scoped **BY DIRECTORY**, not filename shape —
  the same server serves the `/assets/<domain>` ART mounts where agents
  repaint files IN PLACE, and a filename-shape rule would freeze a repainted
  tile for a year the first time an art file looked hashed. A file inside
  `client/dist/assets` is rollup output by construction; `client/public`
  has no `assets/` dir. Policy: `server/src/cachepolicy.ts` (a pure
  function, testable without a server); regressions:
  `server/test/cachepolicy.test.ts`.
  **A per-file hash is only ever granted after VERIFICATION against the
  served bytes** — an UNVERIFIED per-file hash was proposed and REJECTED
  once for the right reason (a server that trusts any `?h` converts the
  worst case into a 1-year cache entry no deploy can heal); hashing the
  file it serves is what removed that premise. The composer keeps its own
  `withAudioV` (`?v`), and client/public art stays on `?v` — both still
  verifiable, both unchanged.
  (2b) **Responses are COMPRESSED** (server/src/index.ts, brotli q4 /
  gzip 6, threshold 1 KB): ~2.5 MB off a cold load (bundle 1.97→0.50 MB,
  world.json 737→37 KB, monsters.json 383→21 KB). Images are NOT compressed
  (`compressible` = false for image/*). **The brotli quality pin is
  LOAD-BEARING — never raise it**: measured q4 51 ms, q5 81 ms, q11
  5,252 ms — five seconds per request on the one Cloud Run core.
  `compression` 1.8.1 defaults brotli to 4, but that is their default, not
  a promise — it is pinned at the call site; re-pin if the middleware is
  ever swapped. Safe for the 20 Hz sim: node's zlib STREAM api runs on the
  libuv threadpool (measured zero dropped ticks incl. ten simultaneous cold
  joins).
  (3) **UI art is lossless WebP and every piece `withV()`-stamped**
  (unstamped, each cost a blocking revalidation before the loading screen
  painted). `scripts/bake-tab-icons.py` emits WebP — convert at the SOURCE,
  never in the Dockerfile. Findings worth not re-deriving: PNG-8 palette is
  useless here (1 of 240 sampled sprites ≤256 colours); the logo LOOKS like
  6× pixel art but was upscaled SMOOTHLY (re-baking at 181×105 costs mean
  error 22/255 — it is a soft render). `public/icons/*.png` stay PNG (iOS
  ignores WebP apple-touch-icon).
- **PWA**: `manifest.webmanifest` (display fullscreen; orientation any —
  see below), `public/sw.js` (passthrough, caches NOTHING — this repo fought
  stale-deploy bugs; the server's Cache-Control is the policy), icons from
  scripts/build-pwa-icons.py (committed). main.ts stashes
  `beforeinstallprompt` → select.ts shows "Install as an app".
  verify-mobile.mjs covers it headlessly.
- **"Desktop site"**: the CANVAS is neutralized (dynamic integer zoom —
  WorldScene.zoomFor, probe `__ml.camZoom()`); the DOM UI is ordinary
  responsive CSS (no compensation).

## Indoor mode (the cut-away) → `games2/INDOOR.md`

**STOP: READ `games2/INDOOR.md` BEFORE YOU CHANGE ANYTHING THAT DRAWS,
LIGHTS, PICKS OR HIDES A CELL INDOORS.** It is the most bug-prone subsystem
in the game — floating wall slabs, black wedges, a black room on a real
phone while the headless harness looked fine, roofs popping mid-fade — and
every one of those shipped because indoor rendering was edited without
opening that file first. The whole spec is there; these four are law before
you even open it:

- **A CUT-AWAY, NOT AN X-RAY** (maintainer): the building is drawn WHOLE but
  TRUNCATED at `indoorTop`. Nothing hidden, nothing transparent.
- **DO NOT GO BACK TO CULLING** — it shipped holes; a room's own CORNER has
  no inward face that any wall set can hold.
- **The outside is DRAWN AT ZERO AMBIENT, never skipped**: the renderer
  draws every cell, the shader (`uRoom`/`roomAt()`) kills the light.
- **Both dials are the maintainer's own picks** — wall height **1**
  (`client/src/indoorwall.ts`), brightness **40%** (`indoorlight.ts`). Never
  "restore" either.

The rest of the surface: `shared/src/indoor.ts` (`shell`) and the indoor
halves of `client/src/scenes/WorldScene.ts` + `client/src/nightlight.ts`;
gates `scripts/verify-indoor.mjs` and `scripts/verify-indoorscope.mjs`.

## Landscape, handedness, rotation (in-game only)

- **The WORLD plays landscape; title/select/loading stay portrait-only.**
  In-game, on TOUCH, a landscape viewport turns the golden split on its
  side: the game view keeps 61.8% of the long axis at FULL height; the menu
  becomes a 38.2vw side column with a VERTICAL tab strip hugging the
  game-view edge. Which side is HANDEDNESS (`client/src/controls.ts`,
  localStorage `ml-hand`, DEFAULT RIGHT, Settings "controls", event
  "ml-hand", probe `__ml.hand(h?)`): the promise is the STICK's side —
  right-handed keeps the stick right in every orientation (the approved
  portrait layout is right-handed), so the landscape menu goes LEFT;
  left-handed mirrors. Mechanism: `hud.ts applyLayout()` classes the root
  (`ml-ingame`/`ml-land`/`ml-lh`) and publishes px vars — `--menu-w`,
  `--hud-h` (0 in landscape), `--gv-left`/`--gv-right`. #game, the chips,
  the chat overlay and the pill anchor off the gv vars and TRANSITION their
  anchor property (handedness swaps glide; display swaps snap).
- ONE exception to "corners stay corners": in RIGHT-handed landscape the
  clock pill leaves the bottom-right corner (the thumb stick's) and parks
  under the XP chip, right edges aligned, 10px below — reading
  `--bars-r-h`, the chip's MEASURED height (bars.ts publishes it from a
  ResizeObserver). Left-handed keeps the corner.
- ICONS ARE NOT ROTATED (the "icons rotate 90°" ask described the
  locked-page mental model; a sideways backpack is not a backpack) — the
  gate pins transform:none.
- GAMEPAD: in landscape the stick is REPARENTED TO `<body>` — usable on
  EVERY tab (a HUD rebuild clears strays) — floating in the game view's
  bottom corner on the thumb's side (gamepad.ts LAND_INSET 38px, the centre
  the maintainer marked on two device screenshots). **MEASURE A DEVICE
  SCREENSHOT'S SCALE, never assume the portrait DPR**: his phone is 393 css
  px portrait (dpr 2.75) but its LANDSCAPE viewport is ~988 css px = 2.28
  device px per css px — reading marks at 2.75 said "move 10px" when the
  answer was 28; fitting a circle to the stick's own 148px blur disc settled
  it. Anchor measurements to something whose CSS size you KNOW.
- THE GHOST IS TWO PAINTED PARTS, EACH WITH ITS OWN ALPHA: `.ml-pad-well`
  (basin) + `.ml-pad-top` (cap) inside a paint-nothing `.ml-pad-stick` — it
  HAS to be built that way: the cap must read STRONGER than the well, and a
  parent's group opacity can only make a child fainter. Rest alphas: LIGHT
  well .15 / cap .25; DARK well .4 / cap .5 (a faint grey ghost vanishes on
  dark terrain). Dark is the explicit data-theme AND the OS default, so
  every dark rule needs its prefers-color-scheme twin. WHILE HELD both go
  to 1 — the rule is written `:root.ml-land .ml-pad-stick.held …` ON
  PURPOSE (the dark rest rules carry an attribute selector; the shorter
  form lost the specificity race and the ghost stayed faint in dark).
  Backed by a blur disc as its OWN full-opacity element (`.ml-pad-blur`,
  z 3) pinned to the stick's rect — backdrop-filter ON the stick cannot
  work (its opaque background paints over its own blurred backdrop, and the
  ghost opacity dilutes the rest). Portrait hides the disc. PICK UP stacks
  above JUMP on the column's centre line; the vertical tab strip is
  centred.
- **Anything positioning against ml-land / the gv vars listens to
  "ml-layout", NEVER the raw resize**: applyLayout fires it last;
  gamepad.ts's own resize listener registers BEFORE hud's, so on rotation
  it read the PREVIOUS ml-land and left the floating stick parented to a
  display:none page at 0×0 — invisible, untappable, unhealed (a hidden page
  never resizes, so its ResizeObserver can't fire). Gate 4d rotates with
  the BACKPACK tab open, each hand, and asserts the stick is
  body-parented, hit-tested, and steers. Page-RELATIVE writes in layout()
  are skipped while the page is display:none (width reads 0 — buttons park
  at garbage and visibly correct on tab entry).
- The position glide is `.anim`-GATED and fires ONLY on a handedness change
  while the page is visible (a glide during rotation fights the canvas
  resize and the OS's own rotation animation).
- **ROTATION SNAPS UNDER A VEIL** (FIVE rounds — keep the arc):
  anchor-transition glides, an outright snap, and a flip pin-then-glide were
  ALL rejected; the closing insight: Chrome/the OS already animate the
  rotation, so ANY chrome animation on top reads as a broken double
  animation. On an orientation flip every anchor jumps straight to final
  (`:root.ml-noanim` pins transitions off); only the handedness glide
  remains. What `hud.ts beginFlip` owns is the HEAVY part: a real rotation
  restages the viewport several times, and a full scale.resize per stage
  (framebuffer realloc + whole-world redraw, traced ~2s PER resize) stalls
  the thread into stale letterboxed frames. main.ts fitCanvas holds fire
  while `:root.ml-flip` is up — AND whenever in-game + touch + viewport
  aspect disagrees with ml-land (the #game ResizeObserver delivers BEFORE
  the resize event that starts the flip, traced 3ms). A THEME-SURFACE VEIL
  (`.ml-flip-veil`, z 3 — over the canvas, under stick/HUD/chat/chips)
  hides the stale world; at quiet (~300ms without a resize) ONE
  "ml-flip-flush" re-fits the canvas in a single resize under the veil;
  after two calm frames (cap 2.5s) the veil fades. The in-game html/body
  wear the THEME background (index.html ships #000 for pre-game screens) so
  a mid-rotation flash reads as surface. Gate sections 4b + 4c
  (verify-landscape) watch a clean and a STAGED rotation frame-by-frame:
  zero transforms/glides on chrome, veil up during and gone after, ZERO
  canvas resizes before the flush, one re-fit after, pill on its true
  anchor. settle() treats a live veil as "not settled".
- **A tap must land where you tapped after a rotation**: Phaser's
  `displayScale` derives from `canvasBounds`, filled during ITS resize
  pass; fitCanvas sets the canvas CSS size AFTER that, so the cached bounds
  kept the pre-rotation size (measured: real canvas 526×393 vs bounds
  393×526 → every tap ~98wu off in landscape, ~134wu after rotating back;
  0.0 in all three states now). fitCanvas calls `updateBounds()` and
  recomputes displayScale with Phaser's own formula (ScaleManager
  `baseSize / canvasBounds`). **Do NOT "fix" with `scale.refresh()`**: in
  RESIZE mode it re-derives gameSize/baseSize/canvas.width from the PARENT,
  discarding the deliberate resolution scaling (a 393×526 box backed by
  786×1052). fitCanvas also runs on `ml-hand` — handedness MOVES the view
  without resizing it, so only the bounds POSITION goes stale. Gate: 4e
  (tap your own feet through portrait → landscape → portrait).
- Landscape column sizing: tabs keep 56px (the global ≤640px-HEIGHT shrink
  rule was written for short PORTRAIT phones and silently shrank every
  landscape strip; a ≤388px-height media keeps 48px for tiny screens);
  strip 84px wide; the backpack grid turns 3 wide × 5 tall
  (`:root.ml-land .ml-slots`, capped 320px; width cap HEIGHT-derived —
  `calc((100dvh − 72px)*0.6 + 20px)` — so all five rows fit without the
  1px scroll); the MAP sizes to the SHORT viewport side (same size portrait
  gives it), `.ml-map` overflow:hidden clips evenly so the you-are-here
  dot's percent offsets stay true; the keyboard-floated Chat input takes
  the gv insets (floats inside the game view). A ONE-TIME help chip on the
  gamepad page points at Settings → controls (× dismisses forever,
  `ml-hand-help`); absolute overlay, its BODY pointer-events:none (on a
  short viewport it can lie over the stick — caught by verify-gamepad).
  Desktop (no touch — `touchDevice()`, shared with the keyboard lift) keeps
  the portrait split at ANY aspect — which keeps every 480×320 e2e gate on
  the portrait coordinate model. Gate: `scripts/verify-landscape.mjs` (both
  hands, portrait return, floating-stick input, help persistence, desktop
  immunity; settle-polled — the starved compositor reports mid-flight
  values long after wall-clock).
- **Portrait-only OUTSIDE the world**: `#ml-rotate` (index.html media query
  — coarse pointer + landscape + max-height 520px) covers
  title/select/loading; `html.ml-ingame` (set by mountPageFrame) suppresses
  it in-world. The manifest is `orientation: any`; the REAL gate is
  main.ts's boot-time `screen.orientation.lock("portrait")` (covers the
  installed app's pre-game screens), RE-LOCKED to "any" by mountPageFrame
  when the world mounts (the boot lock silently kept the phone portrait
  in-game whatever the manifest said). Logout reloads, so the portrait lock
  returns. In a browser tab both lock() calls reject harmlessly. An
  installed WebAPK may need a reinstall to shed an OLD manifest's lock;
  Android auto-rotate must be on.
- **Dead-connection recovery**: backgrounding freezes JS; the server drops
  the client and the room turns ZOMBIE (no patches/acks — prediction
  replays an ever-growing unacked history; the old "teleport when jumping
  uphill after tabbing back"). `room.onLeave` (ignoring real unloads —
  pagehide fires first) triggers an IN-PLACE rejoin (`handleDrop`):
  "Reconnecting…" toast, joinWorld again (immediately when visible, else on
  visibilitychange), old avatars + prediction state dropped, `bindRoom`
  rewires — NO page reload (phones background constantly). Input sending is
  frozen while disconnected (flushInput guard). Retries back off; after 6
  failures a reload with `ml-rejoin` set (main.ts then skips the select
  screen via `ml-last-choice`). NOTE: `room.state.players` is undefined
  until the first patch. Probe: `__ml.dropConnection()`; regression:
  `scripts/verify-reconnect.mjs`.

## Conventions

- `npm run dev` runs server + client. `npm test` = headless suite (node +
  Colyseus, no browser). `npm run typecheck` per package. Work from
  `games2/`.
- **PIXEL ART SCALES NEAREST-NEIGHBOUR ONLY — everywhere, always**
  (maintainer, repeatedly): `image-rendering:pixelated` on every art
  img/canvas, Phaser nearest filtering, `imageSmoothingEnabled=false`,
  nearest in QA/preview zoom helpers. Offline pipelines may box-average
  ONLY when BAKING an asset down to its final display resolution; nothing
  upscales with smoothing. When KEYING/extracting art, finish every cut
  edge with SOFT ALPHA — outer silhouette AND interior holes — never a hard
  100%→0% step (the ornate clock hand's ring hole shipped opaque black
  once).
- Keep shared movement/direction math in `shared/` — never duplicate it.
- Server is authoritative; never trust client positions.
- Tests stay headless; browser checks go through `scripts/verify-*.mjs`
  (Playwright).

## The loop (loop/)

`loop/LOOP.md` is the runbook run on a schedule. Each iteration: `git pull`
(latest art) + regenerate the manifest, keep ≥15 open GitHub issues on
`mikael-floden/pixel` (label `game`), implement the best one, keep
`npm test` + typecheck green, commit + push to `main` (rebase on reject).

## Don't

- Don't touch the map/background/environment/tileset/world art (the maps and
  tiles agents' domains). You may improve the tile **renderer** (occlusion,
  collision, input feel — #28) but never redesign or hand-author world art.
- Don't edit anything outside `games2/` except your own
  `coordination/games.json`.
- Don't push red — `npm test` and `npm run typecheck` must pass first.
