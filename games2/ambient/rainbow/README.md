# rainbow/ — one leg of a real rainbow, in a shader

EPISODE feature, rendered by a fragment shader (`Phaser.Display.BaseShader`
quad over the camera view, WebGL only — canvas renderers get nothing,
gracefully). Shaped by the maintainer's annotated screenshots (2026-07-17,
rounds 1-4): we see exactly **one rainbow leg**, and it looks like a
**real rainbow**.

- **The stroke**: the leg enters at the lower-LEFT — its foot fading in
  from the ground haze — rises diagonally and EXITS the top-right corner,
  so the crown stays forever beyond the frame. The giant circle
  (radius ≥ 1.15× the view diagonal) is fitted every frame through two
  view-anchored points (foot ~6%,80%; exit ~96%,4%), so any viewport
  aspect draws the same stroke. The shadow lean (anti-solar) nudges the
  foot along the bottom, so the leg breathes with the day.
- **Real spectrum**: continuous, red on the OUTER edge through orange /
  yellow / green / blue to violet on the inner edge, slightly desaturated
  toward white (a rainbow is glare on rain, not neon). No posterized
  stripes, no white band — the maintainer's draft pens were placement
  art, not a colour spec (his words).
- **You can never arrive**: the anchor points are view-relative, eased
  with a ~0.5 s lag — chase the leg and it slips ahead; stop and it
  settles.
- **Sun-shower drizzle**: ~36 thin falling streaks accompany the bow.
- **Likeliness**: base 0.5 × sun × moisture (a name-matched rain weather
  counts 1.0 when one ships; until then 0.55·cloud + 0.4·mist). Demo
  preferred: Day + Cloudy.

Hard-won facts (do not relearn):
- Phaser's `fragCoord` is **BOTTOM-UP** (Shadertoy convention) — verified
  with a gradient probe. Screen-space math must flip y into frag space.
- The shader pipeline blends **(ONE, 1-SRC_ALPHA)** — output PREMULTIPLIED
  colour. Straight colour renders neon-opaque; premultiplied at a low
  master drowns the warm (red/orange) half of the spectrum into dark
  terrain — 0.7 master is the sweet spot (measured on screenshots, not
  eyeballed).
- Ease gains on **wall-clock** (`scene.time.now` deltas), not frame dt:
  Phaser's smoothed delta under-reports long frames (software-GL QA
  harnesses, laggy phones) and a per-frame-eased bow never condenses.
- **vite's watcher can go stale** after many dev-server restarts and
  silently serve an OLD module — QA screenshots then test dead code.
  When a change "does nothing", curl the `/@fs/...` URL and grep for a
  new symbol before debugging the code itself.
- The dev server keeps world state across verify runs — a `{v}`
  world-state set matching the current value produces NO patch, so verify
  aligns local probe overrides with the server before demoing.
- `debug().geo` exposes the live geometry (view/F/E/centre/a0/span/
  radius): check the stroke against maths, not eyeballs.

Gameplay impact: none.
