# ants/ — a foraging trail

An ant is ONE PIXEL, and that is the point (maintainer 2026-09-06: "they should
be so small using pixelart like we did for the birds make no sense"). The flocks
get 34px 8-direction PixelLab objects with flap cycles because a bird is big
enough on screen to read as a bird. An ant is not. At this size a sprite sheet
would be a lie — you cannot see a leg, and a 1px dot rendered from eight
directions is the same dot eight times.

So there is no art pipeline here. **Behaviour carries it, and for ants the
behaviour is the TRAIL.** A lone moving dot is a speck of dust; a dozen dots
nose-to-tail along one curved line, some going out and some coming back, is
unmistakably ants — the eye reads the column, not the animal.

- A trail runs between two spots of dry ground, bowed by a control point so it
  never reads as a drawn ruler, and flattened to a polyline the ants walk.
- Ants turn round at the ends: a nest and a food source, not a loop.
- Small lateral wobble — ants do not walk a ruled line.
- The whole trail re-lays after 26–55 s, when less than 30% of it is left in
  view, or when a spot check finds its ground is no longer walkable.
- **A COLONY LEAVES ONE ANT AT A TIME** (maintainer 2026-09-07: "I don't like
  the way you 'pop' the ants out of existence. Can you let the ant disappear one
  by one over time?"). Each ant keeps its own clock: when a trail's time is up
  it waits 0.4–7 s before it starts to go, then fades over 0.7 s, so the line
  thins out instead of blinking away, and the next colony arrives the same way.
  A trail the player has walked AWAY from is exempt and is replaced outright —
  nobody can watch that one leave, and waiting out the spread would mean
  arriving somewhere new and standing in an empty field for seconds.
- **AN ANT IS NEVER PALE.** The visibility fix once swung the tint toward a
  moonlit grey after dark and a colony of white dots is not a colony of ants
  ("I don't like the way you make the ants white"). What actually made them
  visible is drawing above the darkness overlay; the colour stays near-black
  brown at every hour, and by day that reads at 38–102 luma of contrast against
  the ground. Ants are diurnal, so the gate judges their contrast BY DAY — a
  spider, which is out when the ground is dark, keeps a mild lightening toward
  a dim grey.
- Diurnal foragers, thinned by cloud. Stops indoors like every effect here.

**The trail is validated over the BAND THE ANTS WALK** — every sample point and
both wobble extremes — before it is accepted, not every fourth centre point: the
gate caught an ant standing on water in a 24 px gap between checks. It runs once
per trail, so exhaustive costs nothing.

**A trail that cannot be laid at full length is laid SHORT** (`SPAN_FALLBACK`,
then several headings at each length). The full span is a long straight demand
on open ground: in a wood or a village the far end lands in a wall or the sea,
the lay fails, and the ants stay hidden — which is what "I see no spiders and
ants if I run away to a different location" looks like from inside this feature
(maintainer 2026-09-07). A short trail is a real trail; no trail is not.

**A trail out of frame is not a trail.** Two box tests failed here in turn — the
first asked only where ONE END was (measured ants at screen (-53, 238) while the
feature reported itself healthy), the second asked whether the whole extent had
left the view and still kept a trail with every ant outside the frame. The ants
are spread over the whole path, so the question has to be asked as a FRACTION of
the line in view; that is the only phrasing that guarantees some ANTS are.

Placement is `runtime/ground.ts`, which requires dry ground on all four sides:
the probe resolves the front-most drawn surface, so a point one pixel inside a
cliff edge answers "landable" while the pixels around it are a vertical face.

QA: `scripts/verify-crawlers.mjs` — asserts the ants form a COLUMN (spread along
the trail must dominate spread across it), that they advance along it, that
every one stands on walkable ground, and that some of them are ON SCREEN —
the one property that reads healthy on every other number while the maintainer
sees nothing at all — and that a colony arrives within four seconds of the
player reaching somewhere new (measured 200 ms).

**The gate DERIVES where to stand.** It used to teleport to cell 416,308, which
the maps agent later turned into open sea: `landableAtScreen` then answered
false at all 144 sampled points of the view, both features correctly drew
nothing, and the gate reported them broken. A crawler gate that names cells is
measuring last week's map, so it asks the world for standable ground instead.
(`__ml.surfaceAt` takes WORLD UNITS, not cells — passing cells samples the map's
corner, which is sea, and the scan reports "no land anywhere".)

**And it derives a CLIFF to stand near, and waits for a MANNED trail.** Two
ways this gate could pass or fail while measuring nothing, both found by
running it twice:

- The one-terrace rule below is vacuous where the whole view is one terrace —
  no cliff, nothing to walk down. Which spots the land scan lands on is the
  map's business, so the run now derives a cliff-side spot as well, by reading
  the terrain grid (`__ml.gridAround`, rows of 3-char fields) for a standable
  cell with a level step within a few cells, and it FAILS if the view it
  samples never steps.
- The colony arrives and leaves ONE ANT AT A TIME, so a single instant is not
  the population: a read taken the moment the run teleports caught a trail two
  ants deep and called a colony that peaked at 20 broken. Both samples of the
  walk-the-trail pair are taken from a window where the trail is manned — the
  pair is compared ant by ant, so both ends must be the same colony.
