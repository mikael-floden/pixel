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

## The axis is the shoreline, and it is derived

The search that finds the beach also finds WHICH WAY THE WATER LIES: a
candidate is dry ground with water within a few steps, and the direction that
found the water is recorded. The run axis is its perpendicular. So crabs run
ALONG the water on any coast, at any angle, with no per-map data and nothing to
hand-place. Measured on the_game: a colony on real sand with the water 48 px
away and a shore axis of [-0.707, -0.707] — a diagonal beach, handled by
construction.

`sandy` on the colony records whether the ground is really the sand material
(two extra probes, asked ONCE per accepted colony, never in the search loop).
A shore that isn't sand still gets crabs; the flag is there so QA can say which.

## The whole beach moves at once

One distance test for the COLONY, not one per crab — what makes it read is that
they all go together. Inside `FLEE_R` nobody sits still, everybody runs the same
way (away, along the shore), and `FLEE_SPEED` faster. Measured: at most 4 of 7
running while left alone, 7 of 7 once stood on.

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
