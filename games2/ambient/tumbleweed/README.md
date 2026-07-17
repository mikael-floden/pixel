# tumbleweed/ — a dry twig-ball bouncing through on the wind

EPISODE feature. While active, every 8–26 s a hand-pixelled 11×11
twig-ball (two-tone, 2× nearest scale, two re-scribbled frames so the
roll doesn't read as a spinning coin) enters from the upwind edge and
crosses the view on the cloud layer's wind heading:

- **Hop physics**: gravity onto an invisible ground line, each landing
  keeping ~55–75% of the energy plus a small fresh kick — it never quite
  settles, jittering along like the real thing; spin follows arc length
  over radius.
- **Terrain-flavoured** like its sibling sandstorm, but sand-BIASED, not
  sand-locked: `weight = 0.45 × (0.25 + 0.75·sand) × dryness` — most
  likely rolling over sandy ground, rare on plains, soaked to a stop by
  a rain weather.
- Lives at depth 850 000 — above every world sprite but UNDER the
  darkness overlay, so night grades it like any physical thing.
- Deactivation is graceful: rolling weeds finish their crossing.

Demo preferred: Day + Clear. Gameplay impact: none.
