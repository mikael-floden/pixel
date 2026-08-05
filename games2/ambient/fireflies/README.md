# fireflies/ — warm wandering lanterns for the night

Night is Nangijala's longest phase (as long as the three sunlit phases
combined), so it deserves its signature life. Fireflies are ~6–28 tiny
additive glow sprites (procedural texture, star-spark idiom) that:

- **wander** on per-fly Lissajous orbits around slowly drifting anchors —
  organic, never straight lines;
- **pulse with dark rests** — real fireflies blink off; a plain sinusoid
  reads as a beacon, so below the pulse threshold the lantern truly rests
  at 6% glow;
- **fade with the sun** (`env.night = 1 - uSun.w`): the swarm melts away
  through sunrise and rekindles at dusk on a 1.5 s eased gain, thinned up
  to 40% under full cloud;
- **idle for free by day** — when the gain is ~0 every sprite is hidden
  and per-fly math is skipped entirely.

Depth 900_000.6 (just above the darkness overlay, under the lit avatar
copies): a light source can't be dimmed by the night it decorates.
Population scales with the camera's world-view area; flies leaving the
view + 48 px margin re-anchor inside it, so the swarm follows the player
without ever tracking them conspicuously.

Gameplay impact: none — display objects only, no physics, no input.
