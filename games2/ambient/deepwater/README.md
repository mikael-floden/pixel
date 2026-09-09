# deepwater/ — the seaward current

Deep water is the END OF THE WORLD. Swim out and a current carries you back —
`deepCurrentAt` (shared), integrated by the server and predicted by the client,
pointing at the nearest land you could actually stand on and strengthening the
further out you are. It bounds
the map without ever refusing a move, which is what makes it read as weather
rather than a wall. This feature is what that force LOOKS like.

Until this existed the ambient layer drew the same lake chop on a pond and on
the open sea, because it could not tell them apart: `water` and `deep_water`
carry identical `Surface` records (`swimmable`, speed 0.55, sound `water`), so
neither `waterAtScreen` nor `surfaceAt` sees a difference.

## What it draws

- **SWELLS** — single crest lines ACROSS the flow, in three lengths so ranks of
  them look like water rather than a drawn grid. These are the waves that carry
  you, and they are the primary read.
- **DRIFT** — single specks riding 1.35× the current, so they skate over the
  swells. Accent only. Never SLOWER than the current: drift the swimmer
  overtakes would read as being dragged *out*.
- **GLITTER — THE LAKE'S OWN GLINT, RIDING A WAVE.** The same art and the same
  sun/moon palette `ambient/water/` sparkles with (`runtime/glint.ts`, shared so
  the two cannot drift), twinkling in place through its three frames, but
  PARENTED TO A CREST: it picks a live swell and a point along that swell's own
  line and travels with it (maintainer 2026-09-07: "I want the same bright
  sparks as we have in regular water ... we can't put the other effect because
  it looks like static water and this one moves like waves ... if you do that
  effect has to move with the waves"). Near-white and DELIBERATELY brighter than
  the crest it rides — the wave is held close to the sea's colour, and a glint
  that inherited that restraint would not be a glint. Measured on the open sea:
  180 of 200 frames carry one, at most 5 at once, 11 px reach luma 245+
  (brightest 254) out of 10,248 marked pixels.

Both stay CLOSE to `deep_water`'s own `#3d7c8a` — additive, about +25 per
channel at full envelope, landing a crest near `#577f92`. The sea is meant to
move, not to sparkle (maintainer 2026-09-06: the waves "should pop less, should
be similar in color to the deep_water").

They stream along the real current's real DIRECTION. The RATE is a look, not
the tow — see the rule below.

## Rules

- **THE PICTURE'S RATE IS NOT THE TOW RATE.** Matching them was the first cut
  and the maintainer rejected it (2026-09-07): "It's like you try to make them
  the same speed the player get pushed back, but that feels too fast and at the
  start a bit too slow." Both halves are one fault — an unbounded range: the
  current is 0 in the free shallows and 120 wu/s out at sea, so the marks either
  froze or bolted. The rate is a NARROW BAND (`SHOW_MIN_WU`..`SHOW_MAX_WU`,
  17–41) that still RANKS with the current, multiplied by the projection scale
  so headings stay in step with the water. Measured: 34.8 px/s at the shoreline
  band against 44.4 out at sea, where the tow is ~120. The sea quickening as you
  swim out is the mechanic and is gated; running at the swimmer's own tow speed
  is not.
- **THE LAKE CHOP STOPS AT THE DEEP-WATER LINE.** `ambient/water/` is a POND
  look — diagonal wavelets and sun glints that do not move with the current —
  and drawn over the open sea it reads as two seas laid on top of each other
  ("the water effect we have on regular water can't be used on deep_water
  also"). It cannot tell the two apart by surface, so its `waterAt` now also
  asks the deep-current probe and refuses a non-null answer. The FREE SHALLOWS
  answer null, so the chop runs right up to where the drag starts and the two
  effects meet without overlapping. No probe (an older build) = no exclusion.

- **The current is FLAT, the picture is ISO.** `deepCurrentAt` answers in flat
  world space; everything drawn lives on the iso plane, where the same delta
  covers a different distance depending on heading (1.41× along one tile axis,
  0.62× along the other). `current.ts` projects. Skip that and the drift streams
  visibly askew from the drag — plausibly enough to ship.
- **NOTHING IS DRAWN ALONG THE FLOW.** A streak along the travel direction
  crosses every crest at right angles, and the two families read as a mesh
  rather than as water — the drift used to be an 11px streak and was cut to a
  speck for exactly that (maintainer 2026-09-06: the waves "should not have that
  line perpendicular to the wave direction"). A swell's second, dimmer
  "back-slope" line went the same way: these draw ADDITIVE, so it brightened the
  water instead of shading it and simply read as a doubled crest.
- **A crest lies across its travel IN THE WORLD.** The projection is not
  conformal, so that is ~47° on screen along the tile axes, not 90°. "Fixing" it
  to a right angle tilts every swell off the water plane.
- **A crest is drawn at ANY angle — rasterised there, never rotated**
  (maintainer 2026-09-07: "I like the lines to be drawn in any free rotation
  (always forming a wave that represent the current at that location)"). Eight
  directions drew a sea of eight tick-mark families; the current turns smoothly
  across the map and that IS the picture. Pixel art still may not be RESAMPLED —
  a rotated 1px line becomes a dotted grey smear — but Bresenham at an arbitrary
  angle is exact pixel art, the same staircase the terrain is drawn with. The
  ring is quantised to 64 steps (5.6°, 2.6 px at the end of the longest crest)
  only so the textures can be cached, and they are built ON DEMAND: a view uses
  a handful of angles, and generating all 192 up front stalls the join.
- **Spacing is held EVERY FRAME, not just at placement** (maintainer 2026-09-07:
  "the wave speed is so small at the intersection all lines group up at that
  location ... they need to be removed earlier so we kinda always have the same
  wave density"). The field CONVERGES — that is what a current running at land
  does — so it transports evenly-placed marks into a heap and parks them where
  it stalls. A crowded mark (or one whose local speed is under `STALL_PX_S`) has
  its LIFE cut to `CROWD_MS`, so it fades and is re-placed on empty sea: the
  count never changes, only where the marks are.
- **Strength fades the effect IN, it does not dim the sea.** Density already
  scales by strength; multiplying alpha by it as well double-dipped and left the
  open sea, where the current is most inescapable, at a fifth of the intended
  brightness. `byStrength` keeps the shoreline fade while the far sea reaches
  full.
- **The probe budget is round-robin and bounded in SPACE.** The probe runs the
  game's screen→ground resolve (47 levels deep on `the_game`) and its cost
  scales with the frame time — at a starved 5fps every mark came due every frame
  and cost +44 ms. A fixed per-frame budget flattens that, a rotating cursor
  keeps the drift from starving behind the swells, and `RECHECK_PX` forces a read
  when a mark has drifted far enough for the current to have genuinely changed.

## Seam

`__ml.deepCurrentAtScreen(wx, wy)` — screen coords in, like `waterAtScreen`;
out is the flat world vector plus wu/s, or null on land, on a lake and in the
free shallows. Added to `WorldScene` for this feature (games agent's file; see
`coordination/games-ambient.json`). Missing probe → the feature stays dark,
which is exactly the old behaviour.

## QA

- `server/test/deepcurrent.test.ts` — the projection, the anisotropy, the ramp,
  the crest turn, and whole-pixel rasterisation. Fails on an unprojected vector.
- `scripts/verify-deepwater.mjs` — drives the real game out to sea and checks
  every mark streams along the real current at the real speed, that the ramp
  weakens toward the shore (measured 120 → 76 → 55 → 11 → 0 walking in), and
  that nothing at all is drawn on a lake or inland.
