# crabs — the sideways scuttle at the water's edge

A FIELD. A handful of four-pixel crabs on the sand beside water. They sit
still, then RUN SIDEWAYS in a short hard burst, then sit still again — and when
you come near, the whole beach moves at once.

## What makes it read as a crab

Three things, at four pixels:

1. **The burst.** Short dashes (`DASH_MS` 170-420 ms) with long stillness
   between them (`REST_MS` up to 2.6 s). A crab that walks continuously is an
   ant.
2. **The stillness.** Most of the colony is doing nothing at any moment — which
   is what makes the running read.
3. **One shared axis.** Every run is along the same line. Measured: 255 of 255
   runs on the shore axis.

## Red, and bigger than a spider

Both were wrong on the first cut and both read instantly to a person while a
test that only checks positions sees nothing (maintainer 2026-09-07: "you know
crabs are red and bigger than spiders right?" — it was a 4x2 burnt orange thing
beside a 3x3 spider). Orange is fine too, his call; what is not fine is a crab
that does not out-measure a spider HORIZONTALLY.

The scale is arithmetic, not taste: a person in this game stands
`CHARACTER_BODY_PX` = 88 px, so a hand-sized crab is about 88/15 — which is
where 5 and 6 px wide come from, against the spider's 3 at 1/29. The shape is a
wide shell with legs out BOTH sides, because the width is the crab; a tall one
reads as a beetle.

The gate compares the two features' published art sizes rather than hardcoding
a number that rots the moment either changes, and checks the drawn tint is
red-dominant (which the whole red-orange family satisfies).

## They use the whole beach, because the beach is WALKED

"I have seen lots of crabs on a beach before, but not on a spot that small!
They usually use up the entire beach" (maintainer 2026-09-07). Two versions of
this before it was right, and the middle one is the lesson:

1. A fixed span put the whole colony on one tile.
2. Measuring along a straight shore AXIS barely helped — **78 px, about one
   tile** — because the water direction was snapped to one of eight sample
   offsets, so its perpendicular could be 22° off the real coast and a straight
   walk left the sand after two steps.
3. So the shore is **walked**: step along the current tangent, re-estimate the
   water direction AT THE NEW POINT, turn to follow it. The colony is the
   resulting POLYLINE, and a crab's position is a distance along it. A curving
   bay comes out as a curve.

Measured after: **480 px of shoreline, 14 crabs ranging over 458 px** of a
576 px beach — and 10 of 10 sampled segments run square to the water when the
gate re-measures them with its own probes.

The water direction is a GRADIENT, not a snapped offset: sample a ring of
directions and average the ones that hit water, weighted toward the near ones.
That is what makes the perpendicular a real tangent.

`sandy` on the colony records whether the ground is really the sand material
(two extra probes, asked ONCE per accepted colony, never in the search loop).
A shore that isn't sand still gets crabs; the flag is there so QA can say which.

## Fleeing is LOCAL — a wave of panic that travels with you

One distance test for the whole colony was right when a colony was one tile and
wrong the moment it became a 480 px shoreline: standing anywhere near the beach
set every crab on it running for as long as you were there. Now each crab asks
its own distance, so the ones at your feet bolt and the ones down the strand
carry on — truer, and better looking.

Measured standing on the beach: **86% of the crabs at your feet are running,
against 18% of the ones down the strand.**

## It must not cost a frame

The maintainer asked for this one by name ("make sure the game FPS is not
slowed down by this effect"), so:

- **Finding a beach is the only expensive call** — it probes land and water at
  several offsets — so it happens only when a colony needs a home, and is
  rate-limited by `PLACE_MS` (1.5 s) on top of that. THE WORST CASE IS INLAND,
  where the search can never succeed: measured 0.64 searches/s and 0.013
  ms/frame standing somewhere with no water in view.
- **A crab probes the ground ONCE PER DASH**, when it picks where to run —
  never per frame. That one probe is what keeps them out of the sea.
- Everything else is arithmetic on at most `MAX_CRABS` (9) pooled sprites.
- Measured on the beach: **0.032 ms/frame, 9.7 probes/s**.

## Gate

`node ../scripts/verify-crabs.mjs`. It asserts the effect **through the real
Settings UI** — finds the row in the DOM by the label a player reads, clicks it
like a player clicks it, and requires the effect to start and stop drawing.
Asserting the API underneath would not catch a missing row, and a missing row is
what the maintainer would see.

Then: every crab on walkable ground and none on water, water genuinely beside
the colony (asked of the game independently of the feature's own search), every
run on the shore axis, the colony running when stood on, and all three FPS
numbers above — cost, probe rate, and the inland search rate.
