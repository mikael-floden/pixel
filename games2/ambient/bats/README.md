# bats/ — flocks crossing the night sky

EPISODE feature (director-scheduled). While active, every 14–40 s a flock
of 3–7 bats crosses the view in the sky band (depth 1_499_800 — above the
world and the darkness overlay, below shooting stars).

- **Likeliness** (the director's lottery weight): base 1.0, smoothly scaled
  between the maintainer's anchors — night ×1, day ×0.01 ("1% times the
  base-likeliness during the day").
- Sprites are PixelLab art on the SHARED flyer sheet the 8 birds use —
  `art/fly.webp`, 16 flap frames × 8 facings at 34px (544×272), rows in
  `runtime/critters.ts` DIR_INDEX order (S, SE, E, NE, N, NW, W, SW),
  loaded at runtime via `queueSheets`. Bats never perch, so only the flap
  sheet exists (no `still`). Lit per-bat through the same `gradeCritter`
  tint + fog path as the birds.
  (This SUPERSEDES the original hand-pixelled 9×5 two-frame violet
  silhouettes. The lesson from that round still stands and is why the art
  must keep a readable rim: round 1's flat near-black tint was invisible
  over dark night ground — maintainer: "the bats look like fireflies",
  because only the fireflies read.)
  Per-bat flap period, bob, speed and stagger keep a flock looking like
  animals rather than a formation. Flocks launch every 9–24 s while the
  episode is active (first within ~1–3 s) — never a long empty sky.
- Review the flap frames with
  `python games2/ambient/scripts/contact_sheet.py <outdir> --only bat` —
  the same labelled S..SW × F1..F16 grid used to cull bird frames.
- Deactivation is graceful: no new flocks launch, in-flight bats finish
  their crossing.

Gameplay impact: none.
