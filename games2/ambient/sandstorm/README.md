# sandstorm/ — dust on the wind, but only where there is sand

EPISODE feature and the first TERRAIN-AWARE one (maintainer: "unusual
effect... need the player to be at sand"). The runtime samples the ground
around the player through the game's `surfaceAt` probe (its `sound`
footstep id — sandy categories answer `"sand"`) into `env.sand`, and:

- **The director can only roll a sandstorm while the player stands in
  sandy ground** (`weight = 0.6 × sand × dryness`; a future rain weather
  zeroes it, mist dampens it).
- **The storm keeps following the terrain**: its strength eases toward
  the local sand fraction — wander off the beach and it thins to drifting
  dust, wander back and it whips up again. A demoed storm off-sand shows
  a light dust wind (0.35 floor) so the settings button always shows
  something.

Visuals, both layers ABOVE the lit avatar copies and the mist pass
(a storm swallows whoever stands in it, same philosophy as the fog):

- a warm dust **haze veil** (alpha ≤ ~0.34) breathing with the gusts;
- ~64 wind-driven sand **streaks** on the cloud layer's wind heading,
  much faster, with slow gust surges (the whole storm breathes on a
  ~11 s cycle plus flutter), per-grain jitter and speed-stretched
  sprites for cheap motion blur.

Demo preferred: Day + Clear (the veil reads best in daylight; the demo
button cannot teleport the player to a beach, hence the dust floor).
Gameplay impact: none — no movement, camera or input coupling.
