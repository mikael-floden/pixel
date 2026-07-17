# rainbow/ — a giant shader bow you only ever see parts of

EPISODE feature, rendered by a fragment shader (`Phaser.Display.BaseShader`
quad over the camera view, WebGL only — canvas renderers get nothing,
gracefully). Shaped by the maintainer's concept art (2026-07-17): ONE HUGE
bow of which only PARTS are visible, in distinct colour stripes.

- **Giant circle**: radius ≈ 1.15× the view diagonal, centre far
  off-screen — the view only ever holds arc SEGMENTS, never the whole
  arch, and the gentle curvature reads as something enormous and distant.
- **Patchy visibility**: slow-drifting noise lobes along the arc fade the
  bow in and out per-segment — you see a piece rising here, another
  crossing a corner there, the middle swallowed by the sky. Which parts
  show migrates slowly; each showing rolls a fresh layout (uSeed). Lobe
  wavelength is smaller than the visible arc window, so some segment is
  always in frame.
- **Six stripes, not a gradient** (the concept's exact pens): red
  outermost, then yellow, green, blue, magenta, and a WHITE glow band on
  the inner edge — hard-ish posterized bands with short soft edges (the
  house keying rule; same stylized-layers philosophy as the mist shader).
- **Anti-solar physics**: the centre leans down-screen toward where
  shadows point — the crown crosses the top at noon, and mornings/
  evenings lean it into steep rising corner segments.
- **You can never arrive**: camera-relative anchoring at optical infinity
  with a ~0.5 s easing lag — chase it and it slips ahead; stop and it
  settles.
- **Sun-shower drizzle**: ~36 thin falling streaks accompany the bow.
- **Likeliness**: base 0.5 × sun × moisture (a name-matched rain weather
  counts 1.0 when one ships; until then 0.55·cloud + 0.4·mist). Demo
  preferred: Day + Cloudy.

Hard-won shader facts (do not relearn):
- Phaser's `fragCoord` is **BOTTOM-UP** (Shadertoy convention) — verified
  with a gradient probe. Screen-space math must flip the centre's y into
  frag space and treat +y as up.
- Ease gains on **wall-clock** (`scene.time.now` deltas), not frame dt:
  Phaser's smoothed delta under-reports long frames (software-GL QA
  harnesses, laggy phones) and a per-frame-eased bow never condenses there.
- The dev server keeps world state across verify runs — a `{v}` world-state
  set that matches the current value produces NO patch, so verify aligns
  local probe overrides with the server before demoing (see
  verify-ambient.mjs).

Gameplay impact: none.
