# rainbow/ — a shader bow you can never reach

EPISODE feature, rendered by a real fragment shader (`Phaser.Display.
BaseShader` quad over the camera view, WebGL only — canvas renderers get
nothing, gracefully).

- **Anti-solar physics**: a rainbow stands exactly where shadows point.
  The bow's azimuth is projected from the game sun's cast direction, so
  it hangs screen-right in the morning, down-screen at noon, screen-left
  in the evening — sweeping with the world clock like the real thing.
- **You can never arrive** (maintainer): the arc is anchored relative to
  the CAMERA at a fixed distance — optical infinity — with a ~0.5 s
  easing lag, so chasing it visibly pushes it ahead of you and stopping
  lets it settle.
- **Double bow**: primary band red-outside → violet-inside; fainter 1.28×
  secondary with the colour order reversed (real double-rainbow optics);
  gentle time shimmer along the arc.
- **Sun-shower drizzle**: ~36 thin falling streaks accompany the bow so
  the scene reads as the light rain that makes a rainbow.
- **Likeliness**: base 0.5 × sun × moisture, where moisture = 1.0 when a
  rainy weather is active (name-matched — none exists yet) else
  0.55·cloud + 0.4·mist. Demo preferred: Day + Cloudy until rain ships.
- Fades on a slow ~2.2 s gain (a rainbow condenses and dissolves, never
  pops).

Gameplay impact: none.
