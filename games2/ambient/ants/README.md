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
- Diurnal foragers, thinned by cloud. Stops indoors like every effect here.

**The trail is validated over the BAND THE ANTS WALK** — every sample point and
both wobble extremes — before it is accepted, not every fourth centre point: the
gate caught an ant standing on water in a 24 px gap between checks. It runs once
per trail, so exhaustive costs nothing.

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
sees nothing at all.
