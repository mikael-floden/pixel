/**
 * Celestial clock — the 360° zodiac WHEEL plus the animated hand, both hung
 * on the frame's strap stub and both drawn BEHIND the frame (maintainer
 * 2026-07-22: "Both the clock and the arrow/time handle should be drawn
 * behind the frame").
 *
 * The wheel (/ui2/clock360.png, baked by scripts/bake-clock360.py on a
 * canvas symmetric about the wheel centre) hangs with its centre pinned to
 * the hand pivot, then the whole assembly is raised LIFT art-px and CLIPPED
 * at that centre so ONLY the active hanging half shows below the beam. At
 * rest the DAY face fills that half; the divide and the inactive upstairs
 * half sit behind the beam — no rim of the other face ever peeks (maintainer
 * 2026-07-23: "no part of the night clock during the day and vice-versa").
 *
 * THE HAND-OFF (the reason this layer exists): WorldScene's hand angle
 * always sweeps -90°..+90° — a right-to-left pass for the day
 * (morning+day+evening) and another for the night — so at each boundary the
 * raw angle jumps BACK by 180° (the old dial teleported the hand to the
 * right rail). Now the jump is absorbed by rotating the WHOLE ASSEMBLY
 * +180° instead: wheel and hand turn together (same duration, same easing —
 * a rigid body) with the hand passing up over the top where the beam and
 * the layer clip hide it — "you can't see the arrow for a while". After the
 * flip the hand is at the right rail again and the OTHER face hangs below
 * the beam: night always shows the night clock, morning/day/evening the
 * day clock. Visual angle = raw + flips*360 (the raw jump is -180, so each
 * flip nets +180); wheel angle = flips*180; flips is odd exactly during
 * night (TIME_PHASES[0]). The SERVER holds the world clock at the phase
 * start for the same wall seconds on natural night/morning entries
 * (WorldRoom handoffHoldMs — not scaled by the time-speed multiplier), so
 * when the glide lands the raw angle is still -90 and the hand starts at
 * the rail at ANY speed.
 *
 * Angle convention (careful — this shipped wrong once): CSS rotate() is
 * clockwise on screen, so rotating a DOWN-pointing hand by a POSITIVE angle
 * sweeps its tip toward screen-LEFT. All angles are "degrees from straight
 * down, positive = left".
 */

// The maintainer's v2 handle (/ui2/clock-hand.png): vine-wrapped blade WITH
// its own ring, authored pointing DOWN (so baseDeg = 0), at FRAME-art scale
// (45x163 native). Pivot = the ring hole (the maintainer's blue dot); it
// mounts on the frame's strap stub (FrameLayout.clockAnchor), so it is NOT
// uiZoom'd — it lives in the frame's own px space and is sized by the frame
// scale.
const HAND = { w: 45, h: 163, hubX: 23, hubY: 18, baseDeg: 0 };
// The wheel asset: centre EXACTLY at the canvas middle (bake-clock360.py),
// art px — multiplied by the frame scale at mount time.
const WHEEL = { w: 365, h: 353, cx: 182.5, cy: 176.5 };
// shrink the whole clock (wheel AND hand) about the shared pivot so it gets
// left/right breathing room from the frame's top-rail rune tablets
// (maintainer 2026-07-23: "not enough left/right margin between frame and
// clock"). Scaling about the pivot keeps the wheel-centre = hand-ring = flip
// origin identity, so alignment and the 180° hand-off are unchanged.
const CLOCK_SCALE = 0.83;
// Lift the whole assembly UP by this many frame-art px so the wheel's
// day/night DIVIDE (its centre) tucks just behind the beam's wood edge —
// then only the active hanging half is ever visible below the beam: no
// night-face rim during the day, no day-face rim at night (maintainer
// 2026-07-23). The clip is pinned to the (lifted) divide as a hard backstop
// so nothing above it can leak through the beam's vine gaps either. In
// UNSHRUNK px: the divide sits at the pivot, so CLOCK_SCALE doesn't move it.
const LIFT = 27;
const FADE_S = 1.25; // day<->night wheel spin; MUST equal WorldRoom.handoffHoldMs
// and stay in step with WorldScene's TIME_TRANSITION_S (halved 2.5->1.25s:
// the hand-off rotation + its server time-freeze now run twice as fast).
const NIGHT_IDX = 0; // TIME_PHASES[0] = Night (odd flips = night face down)

// The wheel's day face, relative to the clock anchor (the strap stub at
// frame art (385,88)): the face spans roughly art rows 100..290 centred on
// the strap's x — the star echo orbits inside it.
const DISC = { cx: 0, cy: 78, rMin: 42, rMax: 78 };

let root: HTMLDivElement | null = null; // clipped plane BEHIND the frame (z 5 vs 6)
let wheelImg: HTMLImageElement | null = null;
let hand: HTMLImageElement | null = null;
// Current CSS rotations. Continuous ticks snap; hand-offs glide both
// transforms together; large forward skips ride the transition.
let handDeg: number | null = null;
let flips = 0; // +1 per hand-off, never rewinds — the wheel keeps turning forward
let flipHoldUntil = 0; // while gliding, per-frame ticks are frozen out
// A LIVE phase change arms the flip here; the next angle tick consumes it,
// so wheel and hand retarget in the same call with the new phase's angle.
let pendingNight: boolean | null = null;
let lastPhaseNight = false;
// Frame mount for the layer (set by hud.ts after every frame compose):
// anchor in layout px + the frame's css-per-art-px scale.
let mountPt = { x: 0, y: 0, s: 1, has: false };

/** Hang the layer on the frame's strap stub (called on every frame
 * compose/resize — the anchor moves with the width insert and the scale). */
export function setClockMount(x: number, y: number, s: number) {
  mountPt = { x, y, s, has: true };
  applyMount();
}

function applyMount() {
  if (!root || !hand || !wheelImg || !mountPt.has) return;
  const { x, y } = mountPt;
  const s = mountPt.s * CLOCK_SCALE; // shrink wheel+hand about the pivot (x,y)
  // The day/night divide = the wheel centre, which sits at the pivot y and is
  // UNAFFECTED by CLOCK_SCALE (we scale about it). Raise it LIFT art-px (in
  // UNSHRUNK px) so it tucks behind the beam's wood edge, and pin the clip
  // there: only the active hanging half below cy ever renders — no inactive
  // rim leaks, and the hand's over-the-top flip stays hidden behind the beam.
  const cy = y - LIFT * mountPt.s;
  root.style.clipPath = `inset(${cy}px 0 0 0)`;
  wheelImg.style.width = `${WHEEL.w * s}px`;
  wheelImg.style.left = `${x - WHEEL.cx * s}px`;
  wheelImg.style.top = `${cy - WHEEL.cy * s}px`;
  wheelImg.style.transformOrigin = `${WHEEL.cx * s}px ${WHEEL.cy * s}px`;
  hand.style.width = `${HAND.w * s}px`;
  hand.style.left = `${x - HAND.hubX * s}px`;
  hand.style.top = `${cy - HAND.hubY * s}px`;
  hand.style.transformOrigin = `${HAND.hubX * s}px ${HAND.hubY * s}px`;
}

function mount() {
  if (root) return;
  const style = document.createElement("style");
  // The layer is a full-viewport plane in FRAME px space (no uiZoom, no
  // centring transform), BEHIND the frame canvas (z 5 vs the frame's 6) so
  // the beam, medallion and vines cover both wheel and hand — during a
  // hand-off flip the hand vanishes behind the rail on its way over the
  // top. clip-path keeps the sky above the beam clear of the wheel.
  style.textContent = `
  .ml-clock-hand{position:fixed;inset:0;z-index:5;pointer-events:none}
  .ml-clock-hand img{position:absolute;top:0;left:0;
    opacity:1;image-rendering:pixelated;transition:transform ${FADE_S}s ease}
  .ml-clock-hand img.snap{transition:none}`;
  document.head.appendChild(style);
  root = document.createElement("div");
  root.className = "ml-clock-hand";
  wheelImg = document.createElement("img");
  wheelImg.src = "/ui2/clock360.png";
  hand = document.createElement("img");
  hand.src = "/ui2/clock-hand.png";
  for (const im of [wheelImg, hand]) {
    im.alt = "";
    im.draggable = false;
  }
  root.append(wheelImg, hand); // hand above the wheel, both under the frame
  document.body.appendChild(root);
  applyWheel(true);
  applyMount(); // if the frame composed before the first clock call
}

function setTransform(el: HTMLImageElement, deg: number, snap: boolean) {
  if (snap) el.classList.add("snap");
  el.style.transform = `rotate(${deg}deg)`;
  if (snap) {
    el.offsetWidth; // commit without transition
    el.classList.remove("snap");
  }
}

function applyWheel(snap: boolean) {
  if (wheelImg) setTransform(wheelImg, flips * 180, snap);
}

/** A tiny star twinkles across the wheel's face — the HUD echo of a
 * shooting star in the world (arrivals + wild night stars). Lives in the
 * clock's frame-px plane and orbits below the strap anchor. */
export function clockStar() {
  mount();
  if (!mountPt.has) return; // no frame yet — nothing to echo on
  const { x, y, s } = mountPt;
  const st = document.createElement("div");
  st.style.cssText =
    "position:absolute;width:2px;height:2px;background:#fff;" +
    "box-shadow:0 0 3px 1px rgba(255,255,240,.9);pointer-events:none";
  root!.appendChild(st);
  const dur = 900;
  const t0 = performance.now();
  const dir = Math.random() < 0.5 ? 1 : -1; // which horizon it falls toward
  const r = (DISC.rMin + Math.random() * (DISC.rMax - DISC.rMin)) * s;
  const cx = x + DISC.cx * s;
  const cy = y + DISC.cy * s;
  const step = (t: number) => {
    const k = (t - t0) / dur;
    if (k >= 1 || !root) {
      st.remove();
      return;
    }
    const a = Math.PI * (dir > 0 ? k : 1 - k); // 0..PI sweeps the semicircle
    st.style.left = `${cx - Math.cos(a) * r}px`;
    st.style.top = `${cy + Math.sin(a) * r * 0.5}px`;
    st.style.opacity = String(Math.sin(Math.PI * k));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Phase sync — the AUTHORITY on which face hangs down (parity of flips).
 * Instant / pre-hand states pin the parity with a snap (the hand's screen
 * angle is unchanged mod 360, the wheel jumps to the right face — joins and
 * probe resets don't animate). A LIVE phase change only ARMS the flip:
 * the next angle tick consumes it, so the wheel turns in the same call
 * that retargets the hand with the new phase's angle — one rigid motion. */
export function setClockPhase(idx: number, instant = false) {
  mount();
  const night = idx === NIGHT_IDX;
  lastPhaseNight = night;
  const want = night ? 1 : 0;
  if ((flips & 1) === want) {
    pendingNight = null;
    return;
  }
  if (instant || handDeg === null) {
    flips += 1;
    pendingNight = null;
    applyWheel(true);
    if (handDeg !== null && hand) {
      handDeg += 360; // same screen angle, new winding — keep them consistent
      setTransform(hand, handDeg, true);
    }
    return;
  }
  pendingNight = night;
}

/** Point the hand at the raw time angle (degrees from straight down,
 * positive = screen-left, always in -90..+90) — WorldScene computes it from
 * the duration-weighted sweeps and the SUN derives from the same angle, so
 * the arrow and the directional light can never disagree (maintainer). At a
 * day/night hand-off (armed by setClockPhase, or a raw -180° jump if the
 * phase event went missing) the wheel-and-hand assembly rotates FORWARD
 * together instead of teleporting — +180 on the natural cycle, further on
 * mid-phase skips, never backwards. Continuous ticks SNAP; forward skips
 * (freeze-mode phase testing) ride the CSS transition. */
export function setClockAngle(deg: number, instant = false) {
  mount();
  const now = performance.now();
  let target = deg - HAND.baseDeg + flips * 360;
  if (!instant && handDeg !== null) {
    const wantFlip =
      (pendingNight !== null && (flips & 1) !== (pendingNight ? 1 : 0)) ||
      // fallback: the raw hand-off jump, only when it lands the right face
      (target - handDeg <= -90 && ((flips + 1) & 1) === (lastPhaseNight ? 1 : 0));
    if (wantFlip) {
      flips += 1;
      pendingNight = null;
      target += 360; // natural hand-off: net +180, up over the top, behind the beam
      flipHoldUntil = now + FADE_S * 1000;
      handDeg = target;
      applyWheel(false);
      setTransform(hand!, target, false);
      return;
    }
    if (now < flipHoldUntil) return; // gliding: per-frame ticks wait their turn
  }
  pendingNight = null;
  if (handDeg !== null && Math.abs(target - handDeg) < 0.01) return;
  const delta = handDeg === null ? 0 : target - handDeg;
  const snap = instant || handDeg === null || delta < 3; // small/backward = tick
  handDeg = target;
  setTransform(hand!, target, snap);
}
