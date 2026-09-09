# embers — what comes off a fire and goes UP

A FIELD. Sparks leave a burning thing, rise on its heat, cool, and wink out.

## The two conditions, both answered by data

The maintainer set them: *"Ember sparks need to both know if this is a fire AND
where the fire/light source is."*

**WHERE** is the same seam the moths use: `__ml.lightsInView` publishes the
DRAWN position of a source's glowing pixels, so a spark leaves the flame rather
than the object's foot.

**WHETHER IT BURNS** is published, and this effect was parked until it was. The
scenery domain classified all 500 lit pieces by eye off the lit art
(2026-09-08), because nothing derivable works: `brazier_001` is a bowl of teal
crystals, `lantern_post_017` is an open flame on a post, `torch_post_004` burns
blue, 13 trees have a lantern hung in them, and **99 of 500 pieces override
their own group** — so a name test is wrong about one time in five. The game's
own `flicker` is no better: it is a brightness decision that calls a street lamp
a flame.

**EMBERS IS NOT FLAME**, which this file would have got wrong on its own: a
lantern IS a real fire (`fire/enclosed`) and throws nothing, because the glass
is between it and the world. 142 pieces are fire; **82 throw embers**. So the
filter is `light.embers` — the published boolean — and nothing else. No path
parsing, no allowlist, no group names.

## The look

- **It goes up.** Fast at the flame, slowing as it climbs (it is riding heat,
  not thrown). Measured: 942 rises against 8 falls.
- **It cools rather than switching off.** The tint runs from the fire's OWN
  colour toward a deep red as the alpha falls, which is what an ember does and
  what stops it reading as a fading dot.
- **The spark takes the fire's colour**, so `torch_post_004`'s blue resin flame
  throws blue sparks. Read, never assumed — and the scenery domain fixed the
  piece-level `color` in the same change so it is the piece's own first LIT
  state rather than a group default.
- **Bursts, not a stream**, because a fire pops.
- Nothing appears or vanishes: it brightens out of the flame over its first
  breath (`IN_MS`) and dies by cooling. Measured mean alpha 0.478 at birth,
  0.662 mid-life, 0.002 at the end.

## It follows the fire, not the roof

Every other ambient effect is outdoor by charter and multiplies by
`ctx.outdoor`, because rain, pollen and birds fall through a roof the game has
just cut away. **A spark does not.** It belongs to a fire you can SEE, and the
most atmospheric fire in this world is a brazier in a cave — so this effect
inherited that rule and was silently dead beside one. The maintainer stood next
to a cave brazier with the switch on and got nothing (2026-09-08; measured at
his spot, 256,167: outdoor gain 0, so the whole feature returned before it read
anything). Most ember placements on the_game are indoors, so that was the common
case, not an edge one.

The rule that replaces it, and why it is not simply "always":

- an **unsealed** source sparks wherever you are — it is out in the world;
- a **sealed** one (inside a room) sparks only while you are **indoors**, when
  the roof over it is cut away and you can see it.

Without the second half, sparks from a fire behind a wall would draw over the
roof that hides it — these marks sit above the darkness overlay — which is the
wall-hack the cut-away exists to prevent. The player's roof state is read on the
same throttle as the light list, never per frame.

Gated: the run stands in a cave with a hearth and requires sparks (measured 10).

## Cost

0.007 ms/frame with a fire in view; the light list is read on a throttle
(`LIGHT_MS`), 1.62 times a second, never per frame and never per spark. At most
`MAX_SPARKS` pooled 1px marks, drawn additive.

## Two bugs that every counter said were not there

Both were "the effect is invisible", both shipped, and the maintainer reported
them three times between them.

**One: the origin.** The sprites were `setOrigin(0.5, 0.5)` on a 1x1 texture — a
one-pixel quad centred on an integer position straddles the boundary between two
pixels, so the renderer has nothing whole to hit and all but drops it. Measured:
a spark on screen at alpha 0.81 moved the pixel under it by **0.1 luma**. Every
other pixel mark in this folder uses `setOrigin(0, 0)`; that is not tidiness, it
is the reason they can be seen.

**Two: one world pixel is not a visible thing.** With the origin fixed the
sparks were genuinely drawn — and still could not be found on his phone, because
the camera sits at zoom 3 against a device ratio of 2.75, so ONE WORLD PIXEL IS
ABOUT ONE CSS PIXEL. An additive speck that size over a lit fireplace is
nothing. **Technically visible is not visible.** A spark is now 2x2 while it is
hot and shrinks to 1x1 as it dies, and it leaves the flame WHITE-HOT rather than
in the fire's colour — an ember's core is brighter than the flame it came from,
which is both true and what lets it stand out against one. Measured after: the
sparks brighten a pixel above the fire by **244 luma**.

What makes these worth writing down is how they hid: the effect's own numbers
were all correct and all irrelevant — visible true, right depth, right alpha,
right position, texture present, additive blend. **A counter cannot see the
screen.**

## The old note, kept for the fade

The first shipped version was invisible, and the maintainer said so twice. Its
sprites were `setOrigin(0.5, 0.5)` on a 1x1 texture — **a one-pixel quad centred
on an integer position straddles the boundary between two pixels**, so the
renderer has nothing whole to hit and all but drops it. Measured: a spark on
screen at alpha 0.81 moved the pixel under it by **0.1 luma**. Every other pixel
mark in this folder uses `setOrigin(0, 0)`; that is not tidiness, it is the
reason they can be seen.

What makes it worth writing down is how it hid: the effect's own numbers were
all correct and all irrelevant — visible true, right depth, right alpha, right
position, texture present, additive blend. **A counter cannot see the screen.**
After the fix the same spark moves its pixel by 54 luma, and the gate now has an
arm that judges pixels, which is the lasting part.

The same round caught a second one: `IN_MS` was 90 ms, under two frames on a
phone — a pop wearing a fade's clothes. At 190 ms the measured mean alpha at
birth is 0.28 against 0.65 mid-life, which is a fade.

## Gate

`node ../scripts/verify-embers.mjs`. Its targets are DERIVED from the game's own
data — it reads the world doc for the current world (through both world trees,
as the server does) and each lit piece's manifest, then teleports to a placement
that throws embers and to one that is a FIRE but must not. A spiral of teleports
was the first cut and it does not work: the nearest ember piece to the spawn is
53 cells out, the ring it sits on has 12 sample angles and a view is ~7 cells
wide, so the walk missed it and reported "no fire anywhere" — a statement about
the search, not the map.

It also judges the effect ON THE PIXELS, against an ENVELOPE: a hearth's art is ANIMATED and its light flickers, so one
"off" frame is one phase of a moving picture — comparing against it measured 195
luma of change with the effect switched OFF, which is the fire, not a spark. The
baseline is the PER-PIXEL MAXIMUM over eight off frames spanning the animation,
so a spark has to beat the fire at its brightest, at that pixel, in every phase.
Measured: **47.5 luma past the envelope, against 0.6 for a sparkless control
frame.**

Three earlier shapes of this arm all measured nothing, and each is a way to fool
yourself with pixels:

- **A point is a race.** Reading one spark's position and then screenshotting is
  two round trips; the spark has risen tens of pixels by the time the picture
  lands. That version passed or failed on luck — 54, then 30, then 5 luma on
  identical code.
- **A region without a control measures the fire.** 244 luma, all of it flame.
- **A collapsed box measures nothing.** `pickAt` on a point up in the air
  resolves to a different cell, so centring the camera on the FLAME put the fire
  45 px from the top and the air above it framed as 15 px tall. The camera is
  now driven a cell at a time until the fire is actually framed, and the arm
  FAILS if it is not — a check that cannot see its subject must say so.

It also pins the drawn SIZE (>= 2 world px, measured on the biggest live spark —
sampling whichever is first reports the dying 1x1 art and reads as the very bug
the field exists to catch).

Two traps it was written into, both of which made it lie once: the search for a
quiet fire runs before the measurement and LEAVES THE PLAYER THERE, so the burn
phase must teleport back or it measures a lantern; and the first six ember
placements are all indoors, so judging on the first candidate reports a working
effect as dead.
