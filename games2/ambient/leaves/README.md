# leaves/ — autumn leaves spiralling down on the wind

EPISODE feature. Dry leaves drift down through the world on the cloud
layer's wind heading, swaying like pendulums and tumbling edge-on. Warm
golden-hour mood — prefers **Evening**.

- **In the world, not on the HUD** (the tumbleweed lesson, applied from
  the start): each leaf lives in the game's world space and DEPTH-SORTS by
  its world-y, so it drifts behind higher terrain and in front of nearer
  ground, dimmed by night like any physical thing.
- Hand-pixelled 7×8 leaf (body + a darker midrib that survives the tint),
  one of five warm autumn tints, small (1–1.9× scale). A per-leaf **flutter**
  narrows the sprite edge-on and fills it again, faking a tumbling 3D leaf
  from a flat sprite; a slow roll spins it as it falls.
- Sparse by design (~5–26 by view area) — leaves drift, they don't
  blizzard. Population + alpha ease in/out so the fall thins in gently.
- A touch more likely on a breezy (cloudy) day: `weight = 0.5 × (0.6 +
  0.4·cloud)`.

Demo preferred: Evening + Clear. Gameplay impact: none.
