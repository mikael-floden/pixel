# moths — the thing that circles a lamp after dark

A FIELD. Two or three cream specks hold a wide, wobbling orbit around a lit
lamp, and every so often one DIVES at it. Night only, outdoors, and only where
the game says there is a light.

## Why a lamp, and how it finds one

The town after dark is where the maintainer actually stands, and the game
already knows every lit thing in it: emissive tiles and scenery lamps are both
`EmissiveSource` records with a DRAWN anchor. `__ml.lightsInView(pad)` (added
for this, read-only, beside `lightSlots`) returns the ones the camera can see —
`{id, x, y, r, color, sealed}`. A moth is then two facts: a lamp, and an orbit
around it.

**THE LIGHT IS NOT AT THE POST'S FOOT, AND ITS *LIGHTING* HEIGHT IS NOT THE
DRAWN ONE EITHER.** This took two rounds and the second is the interesting one.

A light record's `sx/sy` is its ANCHOR — where the piece stands on the ground —
so a consumer reading it draws at the bottom of the post. That was round one
(maintainer 2026-09-07, with the head and the foot circled).

Round two: lifting by the record's `z` is *still* wrong, and looks almost
right, which is worse. The game derives a lit piece's glowing centroid from its
own pixels and then **clamps that height to 1.5 levels** for the light pool — a
head four levels up leaves the ground under a streetlight near the pool's edge
(measured, and correct for lighting). So every tall lamp reports its flame at
22.5 px, which is still down on the post. The maintainer photographed it twice.

The unclamped centroid was being computed and thrown away. It is now carried on
the record as `hx`/`hy` — where the glow is DRAWN — beside the clamped `z`,
because both are right for their own job. Measured on the town's street lamp:
the true lift is **61.6 px, 4.1 levels**, against the clamp's 22.5.

No new art data was needed: the game already measures the glowing pixels. The
gate fails if every lamp in view reports a lift of exactly 1.5 levels, which is
the signature of reading the clamp again.

Sealed lamps are skipped. A light inside a room stays in the room, and so
should whatever circles it — this is an outdoor effect.

`LAMP_MIN_R` (1.5 cells) is the difference between a candle and a lamp.
Nothing circles a candle.

## The look

- The orbit is an ELLIPSE (`ORBIT_SQUASH` 0.55), because the iso plane is
  shallow — a circle drawn round on screen is not a circle in the world.
- `WOBBLE` keeps it off a drawn ring: a perfect circle reads as a mechanism.
- THE DIVE is what makes two pixels read as an insect. Every
  `DIVE_EVERY` a moth closes to `DIVE_TO` of its orbit and swings back out on
  a sine, so the bump against the glass is a move rather than a jump.
- Cream (`MOTH_CREAM`) shaded toward the lamp's OWN colour: a moth at a lamp is
  lit by it. Art is painted WHITE — `setTint` multiplies, so the drawn colour
  is the tint (the crawlers' lesson).
- Depth `900_000.06` — just above the darkness overlay, like the crawlers. A
  2px mark under a multiply overlay is erased.
- They arrive and leave ONE AT A TIME (`LIFE` per moth, `FADE_MS` either end),
  never as a batch. The maintainer's rule from the ants: nothing pops out of
  existence.

## It must not cost a frame

"Make sure the game doesn't start to lag just because of this feature"
(maintainer 2026-09-07), so the budget is part of the design and not something
measured afterwards:

- The lamp list is read on a THROTTLE (`LAMP_MS` 520), never per frame and
  never per moth. `lightsInView` walks every source in the world; calling it 60
  times a second would BE the cost of the feature. `debug().probes` counts the
  reads so a gate can assert it.
- Per-frame work is trig on at most `MAX_MOTHS` (10) pooled sprites: no probe,
  no allocation, no texture churn.
- A DAY frame returns before any of it — the gain is 0, so the throttle never
  fires. The effect costs nothing at all when it is not on.

`__mlAmbient.cost(reset?)` reports every feature's own `update` in ms/frame
(mean, peak, frames) — the instrument for this question, because frame time in
a software-GL harness is far too noisy to see a 0.2 ms effect inside it.

## Gate

`node ../scripts/verify-moths.mjs` (needs the dev stack). It derives a lit
lamp by walking out from the spawn — never a named cell, which measures last
week's map — then asserts: moths exist at night, each stays within its own
lamp's orbit, the count holds under the ceiling, at least one dives, the
feature's own update stays under its ms/frame ceiling at night, costs ~nothing
by day, and the lamp list is read about twice a second rather than per frame.

It also asserts they circle the LIGHT and not the post — which containment
alone cannot catch, because the moths were perfectly contained around the wrong
point. That arm needs a lamp whose head actually lifts, and FAILS if it finds
none: with the old seam there was no head to tell from the foot at all.
