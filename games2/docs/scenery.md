# Scenery

Off-grid set dressing: sizing, hitboxes, animation, windows on walls, indoor furniture, flat pieces, fog silhouettes. Moved verbatim out of `games2/CLAUDE.md` (2026-09-09), which keeps the law and points here; the measurements, traps and rejected approaches live in this file. Rewrite in place under the root doc law.

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
  **AND THE CACHED COPY OF THOSE NUMBERS IS GATED, because it silently rotted
  for weeks.** `config/scenery-bbox.json` is built by hand
  (`build-scenery-bbox.py`) and NOTHING ran it — not the Dockerfile, not a
  workflow, not a package script — so it drifted from the art domain: measured
  2026-09-05 it carried bed_001 at wph 47 / cpx 64 while
  `scenery/beds/bed_001/scenery.json` said 107 / 87. The RENDERER reads the
  manifest and drew the bed 108 px tall; `stampSceneryCollision` reads the
  cached doc and sized its footprint for 65 — **0.60x, with the anchor offset
  scaled by the same wrong k, so every box was mis-placed as well as too
  small.** Library-wide: 325 pieces had grown and 385 had shrunk, 0.33x to
  6.03x, and every piece's cpx was 64 against a real 87. It was costing a real
  gate (`findSpawn never returns a cell scenery has blocked` passes again on the
  refreshed doc) and it is what made the beds' hitboxes look tiny and off-centre
  next to the wiki's. Found by the maps2 agent. `scripts/check-scenery-bbox.mjs`
  runs in `npm test` and fails on any disagreement (1,411 on the stale doc, 0
  now). IT IS A NODE SCRIPT ON PURPOSE: the generator's own `--check` re-measures
  every alpha box and needs Pillow, and CI installs no Python — wiring that in
  would trade a silent bug for a red pipeline. The half that drifts is plain
  JSON copied out of `scenery.json` (wph, cpx, sprite, states, flat) and that is
  what the gate compares; the alpha boxes move only when the ART moves (they
  were current) and stay the generator's job. A missing `scenery/` tree skips,
  not fails — the deploy's test job sparse-checks-out a subset. Gate:
  `server/test/characterscale.test.ts` (the constant is re-measured off the
  heroes' art within ±3 px; the stamp scales by exactly 88/64; every piece in
  the bbox doc carries `cpx`). Synthetic collision fixtures declare
  `cpx: CHARACTER_BODY_PX` — a piece sized against our own person, identity
  scale — never omit it or they silently grow 1.375×.
- **A SCENERY HITBOX IS AN ELLIPSE *OR* A GROUND RECTANGLE, and a rect is DRAWN
  IN PERSPECTIVE.** `live/tuning/scenery_hitbox.json` publishes `shape: "rect"`
  on 571 boxes — every bed, cupboard and shelf, 547 of them the wiki's own
  default — and the game read none of it, colliding all of them as the ellipse
  INSCRIBED in the box. A rect's edges follow the two GROUND axes, so a turned
  piece projects to a PARALLELOGRAM (maintainer 2026-09-03: "the 3D perspective
  requires the shape to be a bit different ... capture the furniture's
  contour"). **A SCREEN-ALIGNED BOX IS THE WRONG MODEL and was shipped once:**
  it is right only for an unturned south piece, and every turned bed got a box
  at the wrong angle, the wrong size and the wrong place — "you just drew a box
  at the bottom bed corner ... I can walk straight up on the bed" (2026-09-05).
  PORT THE WIKI, DO NOT RE-DERIVE IT: `wiki/site/wiki.js` `rectCorners` /
  `boxRot` / `boxPos` / `boxSize` are the authority, and `rectGroundRot` +
  the stamp mirror them. The three per-facing inputs are NOT optional — the
  art's anchor differs per facing, so PLACEMENT is per facing (`pos_by_dir`),
  SIZE is one decision with an opt-in exception (`size_by_dir`; 54 of 131 rect
  pieces have a south view that disagrees with their own turned views), and the
  facing adds a 45-degree GROUND step (`rot - DIR_GROUND_DEG[dir]`, with
  `rot_by_dir` as the per-facing correction). hflip negates the angle as it
  negates `ax`.
  THE GEOMETRY IS FREE, and that is why this is a small change: the wiki's
  ground frame IS the frame `p`/`q` already live in, under a UNIFORM scale
  (gx = rx maps to p = rx/(dx*SQRT2), gy = ry/k to q = ry/(dy*SQRT2) — both a
  factor 1/(dx*SQRT2)). A uniform scale preserves ANGLES, so p and q are
  unchanged and a ground turn is just a rotation of the (X, Y) box: the rect
  case of `footprintPenetration` is the standard box distance, exact and
  cheaper than the ellipse's gauge gates. Verified: the game's four corners
  equal `rectCorners` to 2.8e-14 frame px over 45 shape/angle pairs.
  TWO THINGS A RECT NEEDS THAT THE ELLIPSE DID NOT. The REJECT GATE and the
  BUCKET PAD must use the TURNED support (`supX`/`supY` = |p·cos|+|q·sin| and
  its partner), not p/q: once the box turns, |X| < p is neither necessary nor
  sufficient, and padding a rect like an ellipse leaves its corners in cells no
  query looks at — the body walks through them with every containment test
  still passing. And the inside answer must be FLOORED above zero like the
  ellipse's own boolean gate, because `canEnterElev` queries with r = 0 and
  `footprintBlocks` tests `> 0`. `rot` alone (no facing) is honoured; 12 boxes
  carry a non-zero one. USE THE WIKI'S DEFAULT: the stamp never filters `auto`
  — an override rewrites the same record without the flag, so a reviewed box
  wins by being the record. Gates: the rect block of
  `server/test/footprint.test.ts` (corners solid with the ellipse arm asserted
  so it cannot pass by blocking everything; the turn moves the shape; the
  per-facing overrides are read; the bucket asserted from outside).
- **A HITBOX RECORD IS LOOKED UP IN EXACTLY ONE PLACE — `sceneryHitboxRec`
  (shared) — AND THE STATE'S CASE IS THE TRAP.** A piece names its variations in
  UPPER_SNAKE and the placement copies it verbatim (`"state": "NOT_LIT_4"`);
  the wiki writes its key LOWER (`#not_lit_4`) — all 3,689 state-keyed records
  are lower, not one is upper. So an exact-case lookup matches NOTHING, and the
  stamp's last-resort scan ("any variation of this piece") then serves a box the
  maintainer drew for a DIFFERENT variation. Measured on the_game: of 486
  placements carrying a state, **0 reached their own record and 376 were served
  another variation's** — he tuned 994 of these by hand and essentially none of
  them reached the game. He caught it with the wiki open beside the game on
  driftwood_log_901 `NOT_LIT_4` ("It's not the same hitbox!"): own record a wide
  flat `rx 27 / ry 12.5`, served `#not_lit_1`'s `24 x 24` circle — the stamped
  footprint was 19.42 x 19.42 wu where the record says 2.16:1, now 21.85 x
  10.11. **It is ONE function because there were two**: `sceneryHitboxFor` (draw
  and overlay) had the case rule AND a comment explaining it, while
  `stampSceneryCollision` re-derived the lookup without it — so what the game
  COLLIDED with and what the wiki SHOWED came from different records, and the
  overlay drew the honest outline of the wrong box. The resolution order is the
  wiki's `hitboxRaw`: `#state`, then `#state` lowered, then the bare path. The
  scan stays as a documented LAST RESORT and must stay last (a piece with no
  footprint is worse than an approximate one — the waystone_009 report); after
  the fix it fires for the 178 the_game placements carrying no state at all and
  for none that has one. KNOWN, his to decide: 5 placements (bush_007/bush_008
  in `NOT_LIT_3`) are genuinely untuned and still take the last resort. Gate:
  `a variation's own hitbox wins over another variation's` — asserted as the
  ASPECT RATIO, so the frame-to-world scaling cannot mask it, with an arm
  pinning that the fixture's two variations really are different shapes (the bug
  looked exactly like both resolving to one record).
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
  **A HIDDEN PIECE'S ART IS STILL ASKED FOR.** `rebuildScenery` calls
  `needScenery` (which only QUEUES) before the roofed skip, so furniture under a
  roof streams in while you are outside; it used to be asked for after the
  skip, so the first entry after a boot drew the floor on the flip frame and
  every bed and hearth arrived a round trip later and popped (maintainer
  2026-09-05: "the game is not ready to display what's inside"). 136
  placements on the_game, all already in the ship closure.
  **THE ROOF CROSSFADES** (`buildIndoorDebris3`, the only debris builder since
  the world@2 one was retired): the roof used to leave and return on ONE frame
  on the_game while the light eased ("I felt we had a solution for this that
  looked ok" — he had, on the old world). The debris is built from tiles3 art
  — the storeys above the cut at `by - lvl*lh`, the real cap at `surfaceY`,
  every deck the constrained column hides (equal-level roofs over wall tops
  included) — at `oDepth + 0.01`, one step above the pooled occluders'
  epsilons and 0.49 under the bodies. `verify-indoorscope` runs on the_game.
  Probe: `__ml.indoorFade()` (debris count + alpha per frame).

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

- **SCENERY SORTS IN THE BODY'S PROJECTION** (`hbDepth` in rebuildScenery):
  the hitbox centre's flat painter line, taken from `projectFlat` — the same
  function a body's `lyFlat` comes from. `projectFlat` carries a `+dy` the
  bare `oy + (x + y) * dy` line does not (and scenery anchors sit 4 px above a
  body at equal coordinates), so a piece keyed on the bare line sorted one dy
  BEHIND its hitbox centre: a body 0.9 cells behind a signpost drew over it
  (body 11619.4 vs sign 11617.6). Measured after: behind the post the sign paints over the player (sign 11631.6 vs body 11619.9); in front of it the player paints over the sign (11647.9 vs 11631.6).

- **INDOOR FURNITURE CROSSES WITH ITS ROOF** (`roofedFade()` = 1 −
  `debrisAlpha()`, applied to the base sprite, its LIT COPY and its fog). A
  roofed piece is still DRAWN on the old binary gate (`roofCutAwayAt`, held to
  the end of the roll so the roof never returns over empty floor) — only its
  OPACITY is now shared with the cut-away crossfade, as the exact complement of
  the debris. Leaving, the roof fades in while the furniture fades out;
  entering, the furniture arrives as the roof dissolves. Before this a bed drew
  at full opacity ON TOP of the returning roof for the whole exit and then
  vanished in one frame (maintainer 2026-09-07: "they don't give a shit we are
  currently fading into outdoor… until the very last millisecond where they pop
  out of existence"). The LIT COPY needs it too — it draws above the darkness
  overlay, so a copy left at alpha 1 stays solid over a roof that has already
  come back. Measured entering: debris 0.48 → 0 while the furniture's measured
  sprite alpha rose 0.52 → 1, complement exact at every sample.
  Probe: `__ml.indoorFade()` reports `alpha`, `roofedAlpha` and the drawn mean.
- **A SCENERY SHARE BELONGS TO THE FLOOR ITS PIECE STANDS ON** — a pixel on a
  DECK above that floor does not read it (`z > groundTerrAt(cell) + 1` clears
  `ownShare`, shader and CPU twin alike). The share is a property of the CELL,
  so without this every object inside a house printed its own dark blob on the
  ROOF above it, and you could read a room's furniture layout off the roof
  without entering — a wall-hack, and the exact thing the cut-away was built to
  stop (maintainer 2026-09-07: "we just got rid of being able to see the rooms
  by looking at the roof and now you can see where scenery objects have been
  placed"). `groundTerrAt` is the column WITHOUT the share, i.e. the floor
  itself; one level of slack covers the soft sampling. Measured at his house:
  the furnished cells have their floor at 0 and their roof deck at 6, so a roof
  pixel is excluded and a floor pixel (z 0.02) is not — the contact shading
  under indoor furniture is untouched.

## The packed layer (`scenery/<piece>/packed/`, scenery/pipeline/pack.py)

Every scenery art file is LOADED as its packed twin — the raw canvas cut to
its state's box (still + rotations + every clip frame share one box, +1 px),
content-hashed beside the piece, named by `packed/index.json` — and MEASURED
on its source canvas, so nothing about a placement moves. (Measured on
the_game's 192 placed pieces, 2026-09-12: the art fills 27% of its canvases;
one box per state keeps 73% of the decoded bytes, 291 -> 211 MB, on a phone
that held 7-9k textures and paid for every transparent texel in decode,
upload and video memory.) The loader fetches the index beside each manifest
(`SceneryPieces`, one extra request per piece, a miss is silent = raw piece),
and the scene meets the layer at four seams and nowhere else:

- `sceneryUrl` — the packed URL when the index names one; the texture KEY
  stays the raw path's (the same art, cut).
- `sceneryCanvasPixels` — `unpackPixels` puts the packed bytes back on the
  canvas for every measurement: `alphaBBox` (the fit), the emissive centroid
  and the lit-against-unlit comparison (`pushSceneryLight`), which compares
  two STATES cut to different boxes and therefore needs the canvas.
- `addSceneryCut` — a canvas rectangle registered on a texture in its own
  texels (`packedCut`); the frame NAME stays the canvas rectangle's, so a
  frame swap finds the still's rectangle under one name on every texture of
  the state. The rectangle keeps its size (the image was sized from it).
- `attachSceneryShape` — the one reader that wants the texture's own texels
  (the map is sampled at the copy's UV), so its hitbox shifts by the cut.

Hitboxes, `light_frames`, the bbox doc and the collision stamp are in
source-canvas pixels and untouched. A file on a different canvas than its
still is not packed (pack.py leaves it raw; the swap draws it as before).
Gate: `scripts/verify-scenery-pack.mjs` — the same spots with `?scnpack=1`
and `?scnpack=0` (remembered in `ml-scenery-pack`; the bisect), every still's
box, flip and cut-texel hash, every fit and every emissive centre identical.
Probe: `__ml.sceneryPack()` (`{dump:true}` for the comparison). Rejected:
per-file boxes (72% vs 73%, and a frame swap needs the still's rectangle
inside every frame texture); Phaser frame trims (the whole-texture geometry
is never drawn — scenery always draws a sub-frame — so explicit offsets at
the seams are the smaller change).

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
