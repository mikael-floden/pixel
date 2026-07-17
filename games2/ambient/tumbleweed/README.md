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
- **In the world, not on the HUD** (maintainer): the weed lives in the
  game's isometric world space and DEPTH-SORTS by its ground contact's
  world-y — exactly like a character. So it rolls THROUGH the scene,
  passing behind higher terrain and in front of nearer ground, dimmed by
  night like any physical thing; the hop lifts the sprite up-screen but
  sorting stays on the ground contact (a jump never pops it in front of
  what it's behind). Never a flat sprite painted over everything.
- Deactivation is graceful: rolling weeds finish their crossing.

Demo preferred: Day + Clear. Gameplay impact: none.
