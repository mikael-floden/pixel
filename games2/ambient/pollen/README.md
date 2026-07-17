# pollen/ — sun motes drifting through forest air

The "dust in a sunbeam" feeling: ~10–42 faint warm specks that ride the
same wind direction as the weather layer's clouds (scaled to ~28% — pollen
lags the sky), flutter on per-mote sinusoids, settle slowly, and **glint** —
a sharpened slow sine keeps each mote a barely-there speck most of the
time, with occasional catches of light.

- Active in sunlit hours (`env.sun`, which already ramps at dawn/dusk) and
  killed up to 85% by cloud cover — overcast air has no sunbeams to hang in.
- Steady-state respawns enter from the upwind edge, so the field flows
  through the frame instead of popping in mid-air.
- Fully idle at night (hidden sprites, no math). Depth 900_000.4, additive,
  procedural 6×6 speck texture.

Gameplay impact: none — display objects only.
