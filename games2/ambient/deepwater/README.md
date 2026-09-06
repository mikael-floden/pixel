# deepwater/ — the seaward current

Deep water is the END OF THE WORLD. Swim out and a current carries you back —
`deepCurrentAt` (shared), integrated by the server and predicted by the client,
pointing at the map centre and strengthening the further out you are. It bounds
the map without ever refusing a move, which is what makes it read as weather
rather than a wall. This feature is what that force LOOKS like.

Until this existed the ambient layer drew the same lake chop on a pond and on
the open sea, because it could not tell them apart: `water` and `deep_water`
carry identical `Surface` records (`swimmable`, speed 0.55, sound `water`), so
neither `waterAtScreen` nor `surfaceAt` sees a difference.

## What it draws

- **SWELLS** — crest lines ACROSS the flow, each with a dimmer line one pixel
  down-current: the wave's back slope. A bare line is a tick mark; the pair has
  a front and a back, and a rank of them reads as sea rolling in. Three lengths,
  so ranks look like water rather than a drawn grid. These are the waves that
  carry you, and they are the primary read.
- **FOAM** — short streaks ALONG the flow with a bright head, running 1.35× the
  current so they skate over the swells. Accent only. Never SLOWER than the
  current: foam the swimmer overtakes would read as being dragged *out*.

Both stream along the real vector at the real speed, so the sea visibly carries
you back at the rate it is actually carrying you.

## Rules

- **The current is FLAT, the picture is ISO.** `deepCurrentAt` answers in flat
  world space; everything drawn lives on the iso plane, where the same delta
  covers a different distance depending on heading (1.41× along one tile axis,
  0.62× along the other). `current.ts` projects. Skip that and the foam streams
  visibly askew from the drag — plausibly enough to ship.
- **A crest lies across its travel IN THE WORLD.** The projection is not
  conformal, so that is ~47° on screen along the tile axes, not 90°. "Fixing" it
  to a right angle tilts every swell off the water plane.
- **Art is quantised to the 8 drawn tile directions** and rasterised as whole
  pixels. Pixel art may not be rotated to arbitrary angles; a free-rotated 1px
  streak resamples into a dotted grey smear. Motion stays continuous — only
  which of the 8 sprites is drawn snaps.
- **Strength fades the effect IN, it does not dim the sea.** Density already
  scales by strength; multiplying alpha by it as well double-dipped and left the
  open sea, where the current is most inescapable, at a fifth of the intended
  brightness. `byStrength` keeps the shoreline fade while the far sea reaches
  full.
- **The probe budget is round-robin and bounded in SPACE.** The probe runs the
  game's screen→ground resolve (47 levels deep on `the_game`) and its cost
  scales with the frame time — at a starved 5fps every mark came due every frame
  and cost +44 ms. A fixed per-frame budget flattens that, a rotating cursor
  keeps the foam from starving behind the swells, and `RECHECK_PX` forces a read
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
