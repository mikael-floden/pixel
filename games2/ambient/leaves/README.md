# leaves/ — autumn leaves spiralling down on the wind

EPISODE feature. Dry leaves drift down through the world on the cloud
layer's wind heading, swaying like pendulums and tumbling edge-on. Warm
golden-hour mood — prefers **Evening**.

- **Falls in the game-world coordinate system, lands, rests, fades**
  (maintainer 2026-07-18): each leaf has a fixed ground-contact point
  (gx, gy — a world position) and a HEIGHT h above it. Gravity pulls h → 0
  while the leaf sways and tumbles; when h hits 0 it LANDS on that world
  point, RESTS there 4–9 s, then FADES over ~1.8 s and a fresh leaf falls.
  So leaves actually hit the ground and lie there a while — they no longer
  slide down-screen at ground level and never land.
- Drawn in a foreground band (depth 895 000: over the world art, UNDER the
  900 000 night overlay so it still dims at night) — so a falling leaf is
  visible dropping PAST cliffs and props, not occluded by them (the old
  world-y depth only let leaves show over flat ground/water).
- Hand-pixelled 7×8 leaf (body + a darker midrib), one of five warm autumn
  tints, small (1–1.9× scale). A per-leaf **flutter** narrows the sprite
  edge-on and fills it again while airborne (a tumbling 3D leaf from a flat
  sprite); the roll settles when it lands.
- Sparse (~5–26 by view area) — leaves drift, they don't blizzard.
  Episode gain eases the whole fall in/out. A touch more likely on a
  breezy (cloudy) day: `weight = 0.5 × (0.6 + 0.4·cloud)`.

Demo preferred: Evening + Clear. Gameplay impact: none.
