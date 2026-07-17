# bats/ — flocks crossing the night sky

EPISODE feature (director-scheduled). While active, every 14–40 s a flock
of 3–7 bats crosses the view in the sky band (depth 1_499_800 — above the
world and the darkness overlay, below shooting stars).

- **Likeliness** (the director's lottery weight): base 1.0, smoothly scaled
  between the maintainer's anchors — night ×1, day ×0.01 ("1% times the
  base-likeliness during the day").
- Sprites are hand-pixelled 9×5 / 9×4 two-frame, TWO-TONE silhouettes at
  integer 2× nearest scale: a pale moonlit rim on the wing tops over a
  dark violet body, baked into the texture per-pixel. (Round 1 shipped a
  flat near-black tint — invisible over dark night ground; maintainer:
  "the bats look like fireflies", because only the fireflies read. The rim
  is what makes a bat read as a bat on dark AND bright ground.)
  Per-bat flap period, bob, speed and stagger keep a flock looking like
  animals rather than a formation. Flocks launch every 9–24 s while the
  episode is active (first within ~1–3 s) — never a long empty sky.
- Deactivation is graceful: no new flocks launch, in-flight bats finish
  their crossing.

Gameplay impact: none.
