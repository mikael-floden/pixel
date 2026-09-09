# gnats — the column that hangs over one spot at dusk

A FIELD. Over one patch of ground, a couple of dozen specks fly hard inside a
narrow vertical volume that itself barely moves. Walk into it and it breaks up
around you; walk away and it gathers again.

## The column is the effect

A midge swarm is not insects going somewhere — it is a COLUMN that stands
still. That is the whole thing, and it is the one property the gate really
guards: measured, the anchor moves **0 px** inside a placement and the swarm's
centre stays within **8.6 px** of its own axis. A drifting version of this reads
as dust, and this repo already has dust (`pollen/`).

**IT IS A COLUMN OF AIR, NOT A DOT ON A TILE.** The first cut was 10-22 px
across and 26-52 tall — a third of a tile — and read as specks pressed onto one
square (maintainer 2026-09-07: "they was pressed togather on a single tile and
I'm trying to make the game feel less tiles"). The size is arithmetic, not
taste: a person here stands `CHARACTER_BODY_PX` = 88 px, so a real midge column
of about a metre across and two tall is ~50 px wide and ~100 tall, which is
where `COL_RX` 14-30 and `COL_H` 58-112 come from. More air in view earns more
columns, held `COL_APART`, so dusk reads as a few swarms in a landscape.

### A cloud, not a column

Sized three times, and the last round is the one that matters — the first two
are kept only because they were each wrong in an instructive way.

The maintainer drew it beside the drawn swarm: *"I feel they should be spread
out more horizontally ... You only draw them on top of one tile. I want it to be
more like a cloud."* Calibrated against the character he was standing next to
(`CHARACTER_BODY_PX` = 88 px), his circle scales to roughly **130 wu across and
118 tall** — a body of air about as wide as it is tall, spanning two tiles,
where the drawn swarm was ~50 wu: one tile, and half the height.

**A distribution's tail is not its silhouette.** The round before this read
"denser in the middle" as a tight core plus a few far wanderers, and it made the
swarm NARROWER while the measurements said it had got wider: the widest gnat
reached 42 px, but that was one rare individual at its extreme, and the bulk —
which is what the eye reads as the swarm's size — sat at 6 px. The gate now
asserts the NINETIETH PERCENTILE clears a tile, not the maximum.

So: one smooth curve, mildly stacked toward the middle (`AMP_POW` 1.2 puts the
median gnat at 0.44 of the cloud and the p90 at 0.89 — denser in the middle,
where a uniformly filled disc would sit at 0.71, while still being a body rather
than a line). `WIDE_FADE` keeps the part he liked: the further out a gnat
ranges, the fainter it is, so the cloud thins AND pales at its edges instead of
ending at a rim.

Measured: median reach 17 px, bulk spanning 100 px, widest 88 px, mean
tall-to-wide 1.11, outer third at 0.71 the opacity of the inner.

**`0.65 + 0.35·sin`, not `0.4 + 0.6·sin`.** The radius breathes, and the width
of that swing quietly decides whether a gnat is ever SEEN out wide: it only
appears at full reach when the breathing and the orbit angle peak together, so
with the wide swing, raising the cloud radius from 40 to 70 moved the widest
gnat actually observed from 36 px to 41. Measured. A narrow swing puts it where
it belongs.

The volume is an ellipsoid: `COL_H` tall, `COL_RX` wide in the GROUND plane, so its horizontal part is squashed by `SQUASH` (0.55) on screen the way
the moths' orbit is — a circle drawn round on screen is not round in the world.
Each gnat rides three oscillators (a slow turn around the axis, a rise and fall
along it, a fast `FLICK`) with its own phases, which is what makes a two dozen
specks read as a swarm rather than a pattern. The column itself only breathes
sideways, `SWAY_PX` 3.5.

There is no one-terrace rule here, unlike the ants: a column is one anchor
point, not a line laid across the terrain, so it has no cliff to walk down.

## When

Dusk — the EVENING phase, with a thinner dawn column in the morning. **Phase,
not sun**: the sunset RAMP is a few seconds of a two-minute cycle, so gating on
it would make this something nobody ever sees. Rain, storm, snow and wind take
it away outright; a real swarm is gone the moment the air moves.

Measured under AUTO: 25 gnats at Evening, **0 by day, 0 at night**.

## Walking through it

`SCATTER_R` 62 px from the axis and the column comes apart: it widens
(`SCATTER_SPREAD`), thins (`SCATTER_DIM`) and rises. It breaks fast
(`SCATTER_TAU` 220 ms) and gathers slowly (`REFORM_TAU` 1.4 s), which is the
asymmetry the real thing has. It never dies — measured half-width 4.0 → 14.8 px
with mean alpha 0.477 → 0.229 while stood in, and back to 8.9 px after leaving.

## Cost

0.034 ms/frame at dusk, 0.011 by day (the not-dusk path returns before it
searches, steps or draws anything). Per frame this is trig on pooled sprites:
no probe except one player read, no allocation. The pool is FIXED AND SLOTTED —
gnat *i* belongs to column *i % MAX_COLS* at slot *i / MAX_COLS*, and a column
draws its first `n`. The first cut rolled the population every frame, which is
a random number per frame deciding how many sprites exist.

## Gate

`node ../scripts/verify-gnats.mjs`. Three traps it was written into, all worth
keeping:

- **Enabling an effect in Settings FORCES it** (`Toggles.apply` →
  `setForced(true)`), so the dusk gate can only be measured under AUTO. Soloing
  gnats and asserting they are absent by day measures a forced effect and
  reports gain 1 at every hour of the clock.
- **A column legitimately expires and re-places** (16-44 s), and this harness
  renders far slower than real time, so a "3 second" window of frames is more
  like fifteen. Drift is judged WITHIN one placement, segmented on the `places`
  counter; the first cut read a legitimate move as an 88 px wander.
- **The centroid is not the column.** Two dozen oscillators in a 40 px volume
  give a standard error of ~2.4 px, so the centroid's range over a long window
  is a dozen px of pure sampling noise. The ANCHOR is the position; the swarm is
  bounded in a box around it — and that box SCALES WITH THE COLUMN (`OFF_AXIS`),
  because a fixed pixel allowance silently tightens every time the column grows,
  which it did the moment the maintainer asked for one bigger than a tile. The
  gate also fails a column narrower than 26 px: fitting on one tile is the
  complaint itself.
- `__ml.pickAt` answers in WORLD UNITS and `__ml.teleport` takes CELLS. Passing
  one to the other walks off the end of the map, and the swarm you meant to
  disturb is then nowhere near you.
