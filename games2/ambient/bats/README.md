# bats/ — flocks crossing the night sky

EPISODE feature (director-scheduled). While active, every 14–40 s a flock
of 3–7 bats crosses the view in the sky band (depth 1_499_800 — above the
world and the darkness overlay, below shooting stars).

- **Likeliness** (the director's lottery weight): base 1.0, smoothly scaled
  between the maintainer's anchors — night ×1, day ×0.01 ("1% times the
  base-likeliness during the day").
- Sprites are hand-pixelled 9×5 / 9×4 two-frame silhouettes, integer 2×
  nearest scale, near-black violet tint so they read against night ground
  and sky alike. Per-bat flap period, bob, speed and stagger keep a flock
  looking like animals rather than a formation.
- Deactivation is graceful: no new flocks launch, in-flight bats finish
  their crossing.

Gameplay impact: none.
