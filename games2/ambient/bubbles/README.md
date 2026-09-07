# bubbles — a string of them rising out of the deep, bursting at the top

A FIELD, on the open sea only. A vent opens somewhere out in the deep water,
breathes a string of bubbles, closes, and another opens elsewhere.

## Seen from above — which is the whole design problem

We look down on the sea at a shallow angle, so a bubble's rise is barely any
travel. What actually reads is that it **grows**, **sharpens** and finally
**bursts**. So a bubble here starts as one faint pixel deep down, swells to a
four-pixel hollow ring near the surface, and pops into an expanding ring that
fades to nothing.

**The pop is what sells it.** A dot that merely fades is a dead pixel; a dot
that bursts is a bubble. Measured: 136 of 139 tracked bubbles ended in a burst.

The ring is HOLLOW from three pixels up. The hole is what stops four pixels
reading as a speck — a solid blob at this size is a crumb, not a bubble.

## They come in strings, from a vent

Random dots scattered over the sea read as noise; three or four bubbles
climbing out of ONE spot read as something down there. A vent has a life, emits
a string, rests, emits again, and eventually closes.

**Closing is not killing.** A closed vent stops EMITTING; every bubble already
climbing finishes its climb and its burst. Nothing is ever cut off mid-rise.

## They drift on the real current

A vent samples `deepCurrentAtScreen` — the same function the server integrates
and the swimmer is pushed by — so a bubble string leans downstream exactly as
the water is moving. Same seam the seaward-current feature reads, same idea:
draw the real force, not a decoration of one. The current is re-read on a slow
clock (`CURRENT_MS`), never per bubble and never per frame; if the sea has
stopped being sea under a vent, it closes.

## Nothing appears or vanishes at full opacity

The standing rule, and the maintainer asked for it again on this one. A bubble
fades UP out of the dark over the first third of its climb (`FADE_IN`) — which
is also physically what happens, a deep bubble being faint — and leaves only
through the burst, which expands as it fades.

The gate measures this PER BUBBLE, tracked by id across frames, because a
snapshot cannot tell an arriving bubble from a leaving one. Measured: 135 of
139 arrived faint and 136 of 139 left faint (the handful are bubbles whose
first or last sample landed mid-ramp on a slow harness frame).

## Contrast is measured, not assumed

The day sea draws LIGHT on screen — `#cbd8d8`, measured for the deep-water
crests, far lighter than the material colour suggests — so a white bubble on it
is invisible. The ring is a **dark teal by day** and turns **pale after dark**,
when the sea is the dark thing. A highlight pixel rides the two biggest stages
only, where there is room for one.

## It must not cost a frame

- Hunting for a vent site is the only costly call, so it is rate-limited by
  `PLACE_MS` whether or not it succeeds. THE WORST CASE IS INLAND, where it can
  never succeed: measured **0.83 hunts/s, 0.006 ms/frame, zero vents**.
- At sea, drawing: **0.043 ms/frame, 3 probes/s.**
- Per frame this is arithmetic on at most `MAX_BUBBLES` (16) pooled rings.

## Gate

`node ../scripts/verify-bubbles.mjs` — the Settings row and its switch, deep
water only (no bubble over walkable ground), rise, growth, burst, the fade at
BOTH ends per bubble, and all three FPS numbers.
