# thunder/ — distant sheet lightning

EPISODE feature (director-scheduled). While active, every 7–26 s the whole
view washes with 2–3 quick blue-white pulses (additive full-view rectangle,
~140 ms exponential decay each) — a storm beyond the horizon. Flashes are
halved in daylight (they read against darkness).

- **Likeliness** (director weight), per the maintainer's spec: base 0.35 ×
  (1 + rain + night) → raining alone = ×2 base, night + raining = ×3.
- No rain weather exists yet (Clear / Cloudy / Mist as of 2026-07-17):
  until the games agent ships one, cloud (×0.4) and mist (×0.3) stand in
  as weak storm proxies. `runtime/env.ts isRainy()` matches by weather
  NAME, so a future "Rain"/"Storm" activates the full multiplier with no
  edit here.
- Sound: visual-only today; when the sounds domain ships a rumble this is
  the hook point (cross-domain ask parked on the board).

Gameplay impact: none.
