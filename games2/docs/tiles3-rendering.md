# Tiles 3.0 rendering

How a maps3 cell becomes pixels: the resolver, plates, transitions, fades, decks, wall feet, and the parity contract with render3. Moved verbatim out of `games2/CLAUDE.md` (2026-09-09), which keeps the law and points here; the measurements, traps and rejected approaches live in this file. Rewrite in place under the root doc law.

ops + the composed-texture factory), `tiles3runtime.ts` (the same resolution ONE
CELL AT A TIME, plus the streaming loader), `scenery3.ts` (off-grid set
dressing). `this.maps3` gates every terrain branch (false only for a hand-built
`rows` literal, which draws a plain ground).

- **THE PROJECTION IS PER WORLD.** The default (`MAP_GEOMETRY`) is dx 32 / dy
  15 / storey 16; tiles3 is 32 / 14 / **15**, the last MEASURED off the x-over-x wall art
  (`measureStoreyPitch` — the doc says 17, render3 falls back to 16, and a
  pitch one row too large exposes a bright stripe of each lower floor at every
  storey). `parseWorld3` publishes it as `ParsedWorld.iso`; `maps.ts
  geometryFor` turns it into the scene's `this.geom` and returns the
  `MAP_GEOMETRY` object ITSELF when it matches. `nightlight.ts` reads the same
  geometry. **INPUT ROTATION
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
- **A REGION IS A 24-CELL CHUNK, NOT A COMPONENT** — `regionAt` is
  `<ground>@<floor(x/24)>,<floor(y/24)>` (`REGION_CHUNK`), pure coordinate
  arithmetic with no scan at all. The id must not depend on the CAMERA (a
  window-local answer changes as you walk and the ground visibly reshuffles),
  but it never depended on the whole world either.
  THIS ENTRY USED TO SAY "REGIONS ARE WHOLE-WORLD, computed once … a region id
  is `<ground>@<lexicographic minimum cell>`", describing a 4-connected flood
  fill that the resolver had already stopped using. The stale text cost real
  work twice in one day: it is why an offline-precompute audit concluded that
  editing one cell could re-key half the map's grass, and why the game agent
  told the maintainer that baking the ground would need whole-world
  invalidation. Neither is true — **a cell edit is bounded by its own 24-cell
  chunk, plus the 5x5 neighbourhood the boundary and fade rules read**, which is
  what makes runtime world editing affordable at all. `computeRegions` still
  exists and still produces the component list, but ONLY `server/test/` reads
  it, so it is lazy (`Tiles3World.regions`) rather than a 23-46 ms whole-world
  scan on every world load. (A stale doc is worse than no doc — this file says
  so three entries down, about the painter-order note that cost a day.)
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

  A full plate's 17-row wall band gives 32 rows of overlap (the retired tiles2
  renderer's 64-px tiles gave 49, which is why its worlds never showed a seam —
  tolerant by construction, not more correct). A top-face-only
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
  **A maps3 world streams plates per file** (the retired atlas worlds booted
  with every tile resident, which is why they never showed this). Any seam
  report from the phone should be reproduced against COLD art, not a warm
  local cache.

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
  the whole reason the sea zigzagged where the old map never did** (maintainer
  2026-09-03, the_island2 beside the_game: "0 zigzag. it just works"). The
  retired tiles2 renderer drew a 64-px-tall tile per cell on a dy=15 lattice, so
  neighbours overlapped by FORTY-NINE rows and there was no seam to get wrong; a
  full tiles3 plate is 46 rows at dy=14 and overlaps by SEVENTEEN. A top-face-only
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
- **THE FADE HAS THREE DIALS AND A SWITCH, AND HE TUNES THEM** (`client/src/
  fadetune.ts` owns the values; Settings sliders "Fade reach" / "Fade amount"
  / "Fade falloff" in hud.ts, the button "fade on transition" in the scene's
  list; `Tiles3Data.fadeTune` carries them into the resolver, and
  "ml-fade-tune" re-resolves and repaints the world 400 ms after the thumb
  rests). Maintainer 2026-09-09, on the beach: the fades "look like random
  dots and don't read 'a transition' at all ... I kinda feel I need 3 sliders
  in order to nail this." REACH is the Chebyshev band in cells (0-8). AMOUNT
  multiplies the placement probability linearly (0-4x; "twice the value means
  twice as much grass fade") — up to the ceiling of the lonely rule, which
  still forbids two fades edge-on; density is linear in distance. FALLOFF is
  the COVERAGE curve (0.1-32, log dial): the pool's densest tile (most of the
  other ground on it)
  is the target at the nearest ring and its sparsest at the far end, target =
  pctMin + span·pos^falloff, so >1 keeps the dense tiles to the transition
  (maintainer 2026-09-09: "fade tiles that has very much light_soil on top of
  grass should be used at the tile that does the actual transition ... very
  little ... further away"). The pool keeps every approved tile from 1% up —
  the grass/light_soil pair tops out at 16%, and the old 8% floor threw away
  its far-band tiles. ON TRANSITION lets `wangSurface` give a composed
  boundary cell a fade too ("a transition tile that is 50% sand and 50% grass
  can end up 75% grass") — drawn over the boundary by `overlayOps`, since the
  ground pass draws the boundary INSTEAD of the cell's own ops. THE DEFAULTS
  ARE HIS: reach 4, amount 0.46x, falloff exp 4 (2026-09-09, "This is good
  fade defaults" — found with reach and falloff pinned at the old top of
  their tracks, hence the wider dials: "you limited the sliders enormously").
  The resolver's own constants (FADE_BAND 2, 1x, exp 1) are what the render3
  parity fixtures pin; only the game's dial defaults moved.
  How much of the other ground a fade tile actually paints is `pct` on every
  pool tile (from tiles/fades/index.json); exposing that per placement is
  not built.
- **A NATURE WALL'S FOOT IS A TRANSITION TILE, AND A DECK SLAB COMPOSES
  TRANSITIONS TOO** (`Tiles3Data.footBoundary` / `deckBoundary`; ONE Settings
  switch "cliff-foot & lid transitions", `client/src/transitions.ts`, on by
  default; off is the resolver's parity picture and the render3 fixtures
  hold). Maintainer 2026-09-09: "When a nature wall (not a house, etc)
  intersect the ground we should make the ground a transition/boundary tile
  to make the connection look better", and on the cave lid "the ground up
  here also look very sharp and has no transition/boundary tiles". FOOT:
  `boundaryAt` resolves each lattice CORNER through `footSide` — a higher
  wall among the four cells around it whose face ends on this plane (its
  lowest front is this cell's level, `wallFoot`'s rule) lends its SIDE
  material to the corner, so the foot cell composes ground<->face with the
  same masks, seam and three-ground fold as any two grounds, and two cells
  sharing a corner always agree (a lattice, not a per-cell band). NOT A
  HOUSE: a side that is an indoor floor, or a wall cell carrying a roof or
  bridge deck (the_game's wall rings ARE deck cells), keeps the hard edge; a
  cave lid's rock is nature. DECK: `deckCell` reads a lattice of the slab's
  OWN level (another deck at that level votes its ground, base ground within
  a storey its own, the rest the slab's), its own half is the slab's ONE
  anchored member so the transition matches the roof around it, and the tile
  goes top-face-only over the surface through `opsForDeck` — so the ground
  pass and the occluder's `capDecks` both wear it; `deckArtPaths` names its
  plates for the loader and the ship closure; a budget-deferred one is owed
  in `t3deckOwed` and repaired by `t3retryBoundaries` on the cells' rule.
  AND THE BASE SIDE OF THE SEAM: a base cell's quad corner standing on a
  cell that carries a deck within a storey of the base cell's plane votes
  the DECK's ground, not the base under it — the rock beside the cave lid
  read the cave floor sixteen levels down, folded it away and kept a hard
  edge on its half while the lid composed its own (maintainer 2026-09-09,
  270,180: "the ground transition at the mountain top over the cave still
  looks broken"). Measured there: column 270 now composes black_rock|
  grey_stone along the whole lid edge.
  Measured on the_game: 8,688 -> 11,862 cell boundaries (3,706 at wall
  feet), 179 slab transitions on 1,414 deck cells; at 238,221 the dark_mud
  face composes into the grass along the whole foot. KNOWN: movement's
  nearest-corner ground (`typeIndexAtWorld`) does not read the foot corner —
  the side is never liquid, so only speed and footstep sound could differ.
  Gates: the two transition tests in `server/test/tiles3runtime.test.ts`.
- **SCENERY ANIMATES ONCE, THEN SLEEPS** (`registerSceneryAnim` /
  `stepSceneryAnims`; `client/src/sceneryanim.ts` owns the ranges; Settings
  range sliders "<class> sleep"). A placed piece plays its state's clip when
  the scenery agent judged it ANIMATION_PROBABLY_GOOD or the maintainer filed
  ANIMATION_APPROVED (live/tuning/scenery_animation.json, `<piece>#<state>`,
  carried in the `live:update` payload; REDO plays nothing there), plays it
  ONCE at 8 fps, then sleeps a random time from its CLASS's min-max range
  (foliage / fire / water / rigid — the review's own taxonomy; [0,0] is back
  to back). Maintainer 2026-09-09: repeat "might look good for something like
  a fire, but it will definitely not look good for a tree". THE DEFAULTS ARE
  HIS (same day, from the sliders: "This is better default animation
  sleeps"): foliage 1-8 s, fire 0-1 s, water 1-4 s, rigid 10-30 s
  (`SCENERY_ANIM_DEFAULT`). The schedule lives per placement index and
  survives the scroll rebuilds; the base image, its lit copy and its fog
  silhouette swap frames together under the still's own crop (frames are the
  still's canvas), and the lit copy keeps the still's shape map. Strip-only
  clips do not play. Probe: `__ml.sceneryAnims()`.
  A LIT CLIP MOVES ITS LIGHT (`applySceneryLightFrame`; scenery
  `light_frames`, one `{intensity, dx, dy}` per frame; dials in
  `client/src/lightanim.ts`, Settings "Light intensity swing" / "Light centre
  swing", log dials 0.05-20x, 1x = the data as published). While the clip
  plays the placement's light source — the object the ledger reads every
  frame — takes 1 + (intensity − 1) x the intensity dial as a multiplier on
  the block's colour, and the frame's emissive centre minus the STILL's
  (canvas px, from the same emissive test the block's colour comes from)
  through the drawn scale and the hitbox convention onto the ground plane,
  times the position dial; the clip's end restores the rest values and a
  rebuild mid-play is re-applied every step. Maintainer 2026-09-09: "the
  spotlight differs a bit with the animation and the game will feel more
  alive ... 0.5 means half the effect and 2.0 means twice the effect ...
  This is for me to test what looks best. Will give you the defaults once I
  found it" — and he did: 0.12x on both ("This is good defaults", same day),
  an eighth of the published swing. Measured on the cauldron
  camp at 349.8,248.8: 1x swings 0.70-1.40 of strength and up to 0.07 cells,
  4x 0.05-2.61 and 0.29 cells, rest exactly the block. Probe:
  `__ml.sceneryAnims().lit`.
- **SCENERY ON A WALL — WINDOWS AND HANGINGS** (maps2 `z`, WORLD3.md
  "windows and hangings"; `scenery3.ts` `SceneryPlacement.z/wall`,
  `WorldScene.registerSceneryWall` / `stepSceneryWalls` / `windowGlow`;
  probes `__ml.sceneryWalls()`, `__ml.windowGlowDebug(place)`). A placement
  carrying `z` stands `z` STOREYS up the wall behind its anchor cell
  (`ay = anchorY(level + z)`; render3's column_y) and names the wall cell it
  hangs on — a south face (`dir` south-west) is the cell up-screen in y, an
  east face (south-east) up-screen in x, otherwise the higher of the two.
  THE FIELD MUST BE NAMED IN `parseWorld3`: the copy is field by field, and
  the first 61 windows drew with their sills on the ground until it was. Such
  a piece TAKES NO GROUND (`stampSceneryCollision` skips it — the wall
  blocks), registers no occluder record, skips the shared depth resolve, and
  draws WITH the wall: at the wall column's own occluder depth one sequence
  epsilon above its faces, its lit copy at that depth in the lit band with
  no cover line. IT FADES WITH ITS WALL (maintainer 2026-09-09: "the wall
  the window was placed on will not be visible so the window has to fade
  in/out together with the wall"): every frame the base image, the copy and
  its fog take `cutFade` of the wall column at the piece's CENTRE — the cut
  truncates a wall to one storey and a window's sill can sit exactly on that
  line (the hearth house: feet 2.94, cut 3) with the whole pane above it, so
  the feet test left it floating; measured entering the row-237 house the
  windows go 1 -> 0.86 -> 0.73 -> ... -> 0 with the debris and back up
  leaving. Back walls are not truncated, so a hanging on one stays. WINDOWS
  GLOW BY THE ROOM BEHIND THEM ("fade between them based on how LIT it is
  inside the house at that location"): the LIGHTS_ON still in the same
  facing is fitted like the base and drawn as its own image ABOVE the
  darkness overlay (a lit window is self-lit), created AFTER the copy and
  NEVER POOLED — a recycled image keeps its old display-list slot and drew
  under the copy, only the sill's hole letting the panes through (the yellow
  specks, 2026-09-09). Its alpha = glow x the wall's fade x the
  outside-my-room factor. The glow is the room's OWN lit placements read off
  the WORLD DOCUMENT (`roomLit`, by `world.rooms`), never the drawn light
  set — a hearth under a roof is not drawn from the street, and the street
  is where a window is looked at; each counts strength x the campfire's peak
  over a squared falloff to its published radius, squashed between
  WINDOW_GLOW_LO/HI and scaled by `curTorchF` (0 at full day). Measured: the
  hearth house's four windows glow 1.0 at night, the unlit house's 0. Gates:
  the `z` test in `server/test/scenery3.test.ts`, the no-footprint test in
  `footprint.test.ts`.
- **A RAISED CAP'S SPRITE WEARS EVERYTHING THE GROUND PASS PAINTED ON IT —
  the set SURFACE, transition, fade AND foot band** (`tiles3Occluders`, via
  `dressKey` and `overlayOps`). The occluder pass re-issues every raised
  cell's cap as a sprite ABOVE the ground texture so bodies can interleave,
  and whatever the sprite omits is covered one frame after the texture drew
  it. The boundary learned this first ("the transition only works on level
  0"); the fade had the identical defect until 2026-09-09 ("the fade tiles
  only work on level 0", two photographs): measured at his plateau (257,236,
  level 4), 11 fades resolved and emitted in a 99-cell window, 0 fade sprites
  among the occluders before, 12 after. THE SURFACE ITSELF was the last one
  (same day, the grey-stone plateau at 227,221: "Why are they all the solid
  color top?"): a wall's cap course is a `_after` review tile whose top face
  is ONE colour, the resolver dresses it with the set's textured tile
  (`own_top` is set on one tile in the library), the ground pass paints that
  over the course — and the sprite re-issued the course alone, so every rim
  cell wore the flat colour while the cell one step in wore the set. The
  course stays (it is the top storey's face — 908751d2e1); the surface is a
  SECOND image over it, at `pasteY`. Level 0 emits no occluder, which is why
  level 0 is where every such bug hides. RULE: anything `cellOps` draws after
  the wall stack must also be re-issued here, at its own paste point, after
  the cap course, in the same order, only on a column drawn at full height
  (and `cellBlits` draws a full-height column WHOLE under the indoor cut, so
  the two passes agree there too). Probe: `__ml.occDump().occluders` keys —
  `t3f:` a set surface, `t3d:` fades, `t3fb:` foot bands.
  THE GROUND PASS HAS THE SAME DUTY ON A TRANSITION TILE: the boundary blit
  REPLACES the cell's own ops, so the fade and the foot band are drawn from
  `overlayOps` in the boundary branch itself — until 2026-09-09 that draw sat
  in the other branch behind a test it could never pass, so no transition
  tile on the ground wore either (maintainer: the wall foot "can't be seen
  when water is part of a transition tile").
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
  `tiles/pipeline/transition_patterns.py plate()` carries the same rule
  (nearest painted row of the column, tie to the row above), so render3 and
  the client agree texel for texel; `tiles3draw-parity.json` holds the 42
  conform cases equal (it used to repair only the EMPTY-column case and
  claim "every silhouette pixel has a real colour" on the strength of it).
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
  stops them. Every coordinate is derived from the world doc and carries its
  derivation; every threshold was falsified against a deliberately wrong cell.
  KNOWN STALE (2026-09-09): its fixture cells predate the 394x394 canvas
  (maps2 b062b85874) and several lie off-grid — the gate now fails loudly
  with a re-derive instruction instead of passing on holes.
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
- **THE RESOLVER AND render3 HOLD ONE RULE SET, AND THE GAME'S VERDICTS ARE
  THE RULES** (2026-09-09; `maps2/pipeline/render3.py` was brought to the
  game, not the game to it, because every rule below is a maintainer verdict
  taken in the game). What is held equal, and where each lives in `tiles3.ts`:
  a region is the 24-cell chunk (`regionAt`); a fade pool keeps every approved
  tile from 1% up (`fadePool`; the old 8% floor threw away the far-band tiles);
  the fade band is the nearest differing solid ground within reach at distance
  max(ring, |level diff|), only grounds with a pool, the lonely rule (no fade
  where a fade already draws on an edge neighbour), the target-coverage pick
  `(1+1.6·rating)·max(0, 1−|pct−target|/(span/2))` with target = pctMin +
  span·pos^falloff — at the resolver's own constants FADE_BAND 2 / amount 1 /
  falloff 1 (the fixtures pin those; the game's dials are the maintainer's and
  differ); a detail rolls wherever no fade landed, never on parquet_floor;
  MADE_GROUND = brown_paving_stone, grey_paving_stone, parquet_floor; a
  boundary corner within `BOUNDARY_STEP` votes and a farther one folds to its
  own ground, liquid pairs compose and the liquid cell draws top-face-only
  with no wall; a room anchors its member ONLY for the room's own floor ground
  (`roomFloorAt`; a foreign ground inside a room keeps its cell); a deck's
  `side`, cap tile, doorway/behind crop (the deck bullet under Decks); scenery
  takes an explicit `state` over `lit`, its `dir` rotation, drawn-px scale
  over the BASE sprite's bbox height, `z` storeys, and NO lift — its feet sit
  on the tile-top centre, which is the bare projection (measured live: paste
  row, anchor and sprite bottom coincide; render3's old TOP_Y lift drew every
  ground piece 10 px high).
  THE PROOF is `scripts/tiles3-fixture.py` → `server/test/fixtures/
  tiles3-parity.json` and `scripts/tiles3draw-fixture.py` →
  `tiles3draw-parity.json`: the generator imports render3, TRACES its `render()`
  (region_at, the frame, the composite and crop calls), predicts the draw
  stream from the rules above and refuses to write a fixture whose prediction
  differs from render3's own stream — a divergence names its cells. Three
  windows on the 394x394 canvas (maps2 b062b85874), each derived by a
  resolver scan and recorded with its derivation in the script: the_bay
  284,192–340,248 (10 grounds, 7-storey cliffs, a 258-cell roof and a bridge,
  the parquet/paving house), his_beach 268,224–316,272 (all 14 lattice
  indices, 120 fades), diag_corner 270,136–286,152 (a level-40 index-6 run, a
  39-storey wall, 229 faceless raised cells); 5,696 cells, 43 scenery
  placements, 42 conform + 30 boundary draw cases. A RESOLUTION change lands
  in tiles3.ts AND render3.py, then regenerates both fixtures (python3 from
  the repo root; render3 needs Pillow and the tiles tree).

- KNOWN GAPS, stated: no FADE GUARD in the game (it is a pixel test over art the
  pool has not fetched yet — measured, 2 of 10 pools keep a tile render3 drops,
  which is a wrong tile inside a 1-cell band, never a hole;
  `Tiles3.stats.unguardedFadePools` counts it); `scripts/verify-tiles3.mjs`'s
  fixture cells are off the 394 canvas (its own bullet). Every RESOLUTION rule
  is held equal with render3 by the parity fixtures (THE RESOLVER AND render3
  HOLD ONE RULE SET, above).

- **Anti-tiling: NONE, on purpose.** Varying tiles is the maps agent's job —
  this repo never swaps a cell's art. REJECTED and fully rolled back: a shader
  seam-smear AND a brightness "ground wash" (maintainer wants the fresh,
  effect-free ground). Do not reintroduce any ground repetition effect.

- **A FIELD CELL ABOVE THE CUT DRAWS NOTHING** (`cellBlits`, 2026-09-09). A
  plateau interior is a field (no exposed face) at level 28, and the arm that
  said "a field is level 0, a cut cannot shorten it" drew its cap 28 storeys
  up-screen — onto the cave floor behind it, as a plain white band under the
  maintainer's feet at 267.9,157.8. Underlay skipped with it; the occluder's
  stump cap for a field keeps the plate anchor. Rule + reason: `INDOOR.md`.
- **A BOUNDARY IS SKIPPED INDOORS ONLY WHERE ITS OWN COLUMN IS TRUNCATED,
  AND A CUT-SUPPRESSED CELL IS NEVER OWED** (`cutSuppressed`, 2026-09-05).
  The transition raster replaces the cell's plate at its own uncut level; if
  the cut-away draws that column SHORTER (`cell.level > cut`) the raster would
  float over the stump, and that — only that — is skipped. It used to skip
  wherever ANY cell of the quad was constrained, so a level-0 DOOR cell whose
  quad meets the level-6 wall lost its parquet<->stone transition indoors
  (plain parquet ran out of the door) and got it back one step outside — the
  maintainer's two frames half a second apart, and his repro: "stand still
  just inside the door ... one more step outside and the floor changes
  radically at the transition". Worse, every such cell was OWED, and
  `t3retryBoundaries` found its composition ready, repainted it, watched the
  pass suppress it again and owed it again: up to T3_BOUNDARY_RETRY cell
  repaints EVERY FRAME for as long as you stood indoors — measured at his
  door, the ground RT's hash changed on 8 of 8 consecutive frames standing
  still, 3-4.5 cell repaints per frame — the cave floor "simmering like
  crazy". The occluder pass's twin (`topL === cell.level`) already meant
  "not truncated", so its quad clause is gone and the two passes agree.
  Legacy kill switch (cuts null) still suppresses every boundary.

- **A SLAB WEARS ONE SURFACE, AND IT IS DRAWN** (and, since 2026-09-09, its
  transitions over it — see the nature-wall-foot bullet). A roof, a bridge and a cave
  lid take ONE set and ONE member for the whole deck, anchored at the deck's own
  first cell (min by `x + y`, tie on `x` — render3.py:1387 and its `danch`), and
  `opsForDeck` pastes that plate TOP FACE ONLY over the cap at `surfaceY` —
  render3's `top_face_only(plate_img(..., anchor=danch))` at `col_y(x, y, dl)`,
  to the row. TWO DEFECTS SAT ON TOP OF EACH OTHER HERE (2026-09-05): `deckCell`
  resolved the surface PER CELL (22 of the_game's 28 decks patchwork, the
  180-cell inn across 8 arts), and NOTHING DREW IT AT ALL — `Tiles3DeckCell
  .surface` was resolved, carried and parity-gated against render3, and no
  consumer turned it into a blit, so every roof wore its CAP TILE per cell:
  `overTile` on the ring, `flatTile` inside. That is the lighter ring around
  every roof and the line along every inner wall — the floor plan drawn on the
  roof (maintainer: "the top of the outer and inner walls is not part of the
  same roof, but from a player's perspective it's all the same rooftop ... not
  be able to see what room a house has until you walk inside"). Fixing the
  anchor alone changed no pixel, which is how the second defect was found.
  `deckArtPaths` names the surface file too, or the loader never fetches it and
  `ship-tiles3` never bakes it (`scripts/tiles3closure.ts` uses the same
  function) — `opsForDeck` would then drop the op as "still streaming" forever.
  A slab whose surface did not resolve draws its courses alone, never a hole.
  The wall ring IS deck cells (every level-6 wall of the house is in deck 4), so
  the surface covers wall caps and inner walls alike; decks draw LAST, as in
  render3, so no down-screen cap can paint over it. NOTE: the room map never
  reached the_game's roofs — they are `brown_paving_stone`, not the room floor;
  the visible seams were the cap tiles and the per-cell member. Gates: `a deck
  is ONE set and ONE member, eave to eave` (control resolves each cell as a
  synthetic ONE-CELL deck, which reproduces the per-cell answer exactly, and
  must keep finding >=10 patchwork slabs) and the deck arm of `every op the
  factory hands back is drawable` (the surface op exists, is `t3f:`-keyed, sits
  at `surfaceY` with role `deck`; an unloaded surface emits nothing).
  **AND THE OCCLUDER COPY MUST END WITH IT TOO** (`capDecks`, same day, from
  his outline of the rooms on a photo of the fixed roof). The occluder pass
  duplicates every column's top as a sprite OVER the ground texture so bodies
  interleave; for a deck it skipped any slab at or below the column's own level
  ("the terrain occluder already covers it") and the terrain block then pushed
  the WALL'S CAP TILE. A house's wall ring is level-6 terrain under a level-6
  roof, so every wall top wore its plain cap in the sprite layer while every
  room cell (deck floating over a level-0 floor) wore the roof surface — the
  plan drawn on the roof a second time, in a layer the RT parity probes cannot
  see. An equal-level deck is now collected per column and its ops pushed AFTER
  the cap and the raised-boundary re-issue (creation order is draw order in
  this band), exactly as the ground pass draws decks after every cell; a deck
  below the column's top stays skipped. Probe: `__ml.occDump()` — the LAST
  image on every wall-top column must be the `t3f:` roof key, and the same key
  as the interior's.
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
  **AND A DECK'S `side` IS ITS BODY** (`Deck.side` in shared, copied by
  `world3.ts`; WORLD3.md "a deck may carry a side"): the courses below the
  slab draw `side`, else grey_stone under a cave whose top is not rock, else
  the top itself; the top course is `over_tile(top, body)` when body differs
  from top or the front is open, else the flat tile — which is what makes a
  roof THIN (brown_paving_stone over parquet_floor on the_game's 11 roof
  decks; same-over-same is the thick slab). A DOORWAY cell (front open, no
  `wall_over`, base level below the deck) and a BEHIND cell (an open-front,
  wall-less deck neighbour down-screen whose base is lower) crop that course
  to `DECK_CAP_CROP` = TOP_Y + DY + 8 = 32 rows, so the skin ends at the
  lintel instead of hanging into the opening (131 doorway and 1,105 behind
  cells on the_game). `Tiles3DeckCell` carries `side`/`doorway`/`behind`/
  `capH`, the stack's top step carries `h` for the cropped course and
  `tileBlit` honours it. render3's deck block is the same rule, held by the
  parity fixture.

- **A WALL'S FOOT CONTINUES INTO THE GROUND IT STANDS ON** (`Tiles3Cell.foot`,
  resolver `wallFoot`; `footBand` + the `foot` op role in tiles3draw). The
  overhang eases a cliff's TOP into its face; the foot had nothing, and the
  shader's seam AO (0.75 over ~5 px) is a lighting cue, not a material one, so
  face-meets-water was a hard staircase (maintainer 2026-09-08, photographed:
  "when a wall intersects the ground I often feel the line/edge is kinda
  instant"). Every lower cell whose up-left, up-right or straight-up
  neighbour is a higher wall WHOSE LOWEST FRONT IS THIS CELL'S LEVEL wears one
  band op, drawn last in its slot (on a composed-boundary cell too, via
  `overlayOps`), clipped to the cell's diamond. ON LAND: the face's own
  palette-wall colour (x0.82) continues solid for 6 texels, then fades in 6
  flat steps. IN WATER: a WATERLINE first — one crest texel lifted halfway to
  white from the liquid's top colour, one lifted a quarter — then the wall
  seen through the water, its colour pulled 35% toward the water's and fading
  over 10 texels of depth (maintainer: "I want the edge to be more water so
  you clearly see this is the line where the wall starts to go down under the
  water"). WHERE THE FACE ENDS is the load-bearing number: the occluder pass
  draws the lowest exposed course one storey up (`stackFrom`: frontLow + 1)
  at `geom.lh` px per storey as 64x64 review art whose band hangs WALL (17)
  rows under its diamond, so the face's last row is about `WALL - pitch` rows
  below the shared edge. The band starts FOOT_UNDER (2) rows ABOVE that and
  the face sprite covers the overlap — his zoom found a 1 px line of water
  between face and band (the face ends a row earlier than the arithmetic says
  on his device), and an overlap under a sprite is free while a gap is what
  he sees. Everything above the face's end is invisible: the first version
  painted there and showed nothing (it also used the review tile's TOP_Y in a
  PLATE frame, which has none). One texture per (walls, side material, own
  ground), keyed by name because `cellOps` is pure and has no palette. He
  ASKED for a transition tile at the foot (a boundary tile, not a new
  mechanism); this is the games-side stand-in and the look he approved off
  the test images ("it kinda looks like the wall is extended down into the
  water ... please continue"). A liquid never casts a foot; a wall whose other
  front is lower ends its face down there and casts none here.

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
