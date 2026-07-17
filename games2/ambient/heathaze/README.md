# heathaze/ — real heat shimmer, a camera post-process

EPISODE feature and the ambient layer's first camera POST-PROCESS. Hot air
over baked ground bends light, so this is a genuine **refraction**: a
`PostFXPipeline` re-samples the rendered frame (`uMainSampler`) with a
rising, wavering UV offset — it distorts the ACTUAL world + lighting, never
an overlay drawn on top.

- **Terrain-aware** like its sibling sandstorm: `weight = 0.5 × sun × sand
  × dryness` — the director only rolls it while the player stands on hot
  sand in strong sun, and the shimmer eases toward the local sand fraction
  (thins off the beach, whips up on it). Cloud, mist and rain all kill it.
- The ripple is strongest in the lower screen (the hot ground band) and
  fades by the upper third (the sky), rising and scrolling upward over
  time.
- Fades with the sun — no shimmer at night even if pinned by the demo.

**Safety — ambient must never break the game.** The pipeline is ATTACHED to
the main camera only while the shimmer is visible and REMOVED the instant it
fades, so when no heat haze plays the render path is byte-for-byte what it
was before this feature existed. WebGL only; any failure (canvas renderer,
pipeline error) latches a `broken` flag and the feature never touches the
camera again. `debug()` reports `{ attached, broken, gain, sand }`.

Hard-won facts:
- Phaser PostFX `outTexCoord.y` is BOTTOM-UP — the ground band is the LOWER
  screen (small uv.y). Verified with a row-diff probe.
- Demo preferred: Day + Clear (the demo can't teleport the player to sand,
  so it shows a 0.4 shimmer floor). Gameplay impact: none.
