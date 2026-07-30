/**
 * Celestial clock — WIKI-STYLE (maintainer 2026-07-30: "the day/night clock —
 * make something with CSS that follows the new html style"). The zodiac wheel
 * PNG + ornate hand sprite are gone; the clock is now a small round CSS dial
 * fixed top-centre over the game view: a DAY face and a NIGHT face that
 * cross-fade, and a slim accent HAND rotating about the centre.
 *
 * THE HAND-OFF LOGIC IS UNCHANGED (it is the whole point of this file):
 * WorldScene's hand angle always sweeps -90°..+90° — a right-to-left pass for
 * the day (morning+day+evening) and another for the night — so at each
 * boundary the raw angle jumps BACK by 180°. The jump is absorbed by winding
 * the hand FORWARD (+360 per flip ⇒ net +180 on screen): it glides up over
 * the top to the other rail while the faces cross-fade, day↔night. `flips`
 * parity IS the face shown (odd = night); pendingNight arms a flip on a live
 * phase change so the wheel-turn and the hand retarget in one motion; the
 * SERVER holds the world clock at the phase start for FADE_S (WorldRoom
 * handoffHoldMs) so the glide lands with the hand at the rail at any speed.
 *
 * Angle convention (careful — this shipped wrong once): CSS rotate() is
 * clockwise on screen, so rotating a DOWN-pointing hand by a POSITIVE angle
 * sweeps its tip toward screen-LEFT. All angles are "degrees from straight
 * down, positive = left".
 */

const FADE_S = 1.25; // day<->night cross-fade + hand glide; MUST equal
// WorldRoom.handoffHoldMs and stay in step with WorldScene's TIME_TRANSITION_S.
const NIGHT_IDX = 0; // TIME_PHASES[0] = Night (odd flips = night face down)
const DIAL = 54; // dial diameter, css px

let root: HTMLDivElement | null = null;
let nightFace: HTMLDivElement | null = null;
let hand: HTMLDivElement | null = null;
// Current CSS rotation. Continuous ticks snap; hand-offs glide; large forward
// skips ride the transition.
let handDeg: number | null = null;
let flips = 0; // +1 per hand-off, never rewinds
let flipHoldUntil = 0; // while gliding, per-frame ticks are frozen out
// A LIVE phase change arms the flip here; the next angle tick consumes it,
// so face and hand retarget in the same call with the new phase's angle.
let pendingNight: boolean | null = null;
let lastPhaseNight = false;

function mount() {
  if (root) return;
  const style = document.createElement("style");
  style.textContent = `
  .ml-clock{position:fixed;top:8px;left:50%;transform:translateX(-50%);
    width:${DIAL}px;height:${DIAL}px;border-radius:50%;z-index:8;
    pointer-events:none;overflow:hidden;box-sizing:border-box;
    border:1px solid var(--border-strong);box-shadow:var(--shadow)}
  .ml-clock-face{position:absolute;inset:0;border-radius:50%}
  /* DAY: soft sky with a low sun */
  .ml-clock-face.day{background:
    radial-gradient(circle at 50% 74%, #f2c14e 0 5px, rgba(242,193,78,.4) 6px, transparent 8px),
    linear-gradient(#dfeefa 0%, #f6f0e0 100%)}
  /* NIGHT: deep sky with a crescent + stars */
  .ml-clock-face.night{opacity:0;transition:opacity ${FADE_S}s ease;background:
    radial-gradient(circle at 62% 70%, #ece8da 0 4.5px, transparent 5.5px),
    radial-gradient(circle at 57% 66%, #232433 0 4.5px, transparent 5.5px),
    radial-gradient(circle at 30% 38%, rgba(255,255,244,.95) 0 1px, transparent 2px),
    radial-gradient(circle at 72% 30%, rgba(255,255,244,.8) 0 1px, transparent 2px),
    radial-gradient(circle at 44% 22%, rgba(255,255,244,.7) 0 .8px, transparent 1.6px),
    linear-gradient(#20222f 0%, #2b2d3d 100%)}
  .ml-clock-face.night.snap{transition:none}
  /* the HAND: a slim accent rod from the hub, authored pointing DOWN */
  .ml-clock-hand{position:absolute;left:50%;top:50%;width:2px;height:${Math.round(DIAL * 0.42)}px;
    margin-left:-1px;border-radius:2px;background:var(--accent);
    transform-origin:50% 0;transition:transform ${FADE_S}s ease;
    box-shadow:0 0 0 .5px rgba(0,0,0,.15)}
  .ml-clock-hand.snap{transition:none}
  /* the hub dot over the hand root */
  .ml-clock-hub{position:absolute;left:50%;top:50%;width:6px;height:6px;
    margin:-3px 0 0 -3px;border-radius:50%;background:var(--accent);
    box-shadow:0 0 0 1px rgba(0,0,0,.12)}`;
  document.head.appendChild(style);
  root = document.createElement("div");
  root.className = "ml-clock";
  const day = document.createElement("div");
  day.className = "ml-clock-face day";
  nightFace = document.createElement("div");
  nightFace.className = "ml-clock-face night";
  hand = document.createElement("div");
  hand.className = "ml-clock-hand";
  const hub = document.createElement("div");
  hub.className = "ml-clock-hub";
  root.append(day, nightFace, hand, hub);
  document.body.appendChild(root);
  applyFace(true);
}

function setSnap(el: HTMLElement, apply: () => void, snap: boolean) {
  if (snap) el.classList.add("snap");
  apply();
  if (snap) {
    el.offsetWidth; // commit without transition
    el.classList.remove("snap");
  }
}

/** flips parity → which face shows (odd = night), cross-faded unless snapped. */
function applyFace(snap: boolean) {
  if (nightFace) setSnap(nightFace, () => (nightFace!.style.opacity = flips & 1 ? "1" : "0"), snap);
}

function setHand(deg: number, snap: boolean) {
  if (hand) setSnap(hand, () => (hand!.style.transform = `rotate(${deg}deg)`), snap);
}

/** A tiny star twinkles across the dial — the HUD echo of a shooting star in
 * the world (arrivals + wild night stars). */
export function clockStar() {
  mount();
  const st = document.createElement("div");
  st.style.cssText =
    "position:absolute;width:2px;height:2px;border-radius:50%;background:#fff;" +
    "box-shadow:0 0 3px 1px rgba(255,255,240,.9);pointer-events:none";
  root!.appendChild(st);
  const dur = 900;
  const t0 = performance.now();
  const dir = Math.random() < 0.5 ? 1 : -1; // which horizon it falls toward
  const r = DIAL * (0.28 + Math.random() * 0.16);
  const cx = DIAL / 2;
  const cy = DIAL * 0.42;
  const step = (t: number) => {
    const k = (t - t0) / dur;
    if (k >= 1 || !root) {
      st.remove();
      return;
    }
    const a = Math.PI * (dir > 0 ? k : 1 - k); // 0..PI sweeps the dial
    st.style.left = `${cx - Math.cos(a) * r}px`;
    st.style.top = `${cy - Math.sin(a) * r * 0.55}px`;
    st.style.opacity = String(Math.sin(Math.PI * k));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Phase sync — the AUTHORITY on which face shows (parity of flips).
 * Instant / pre-hand states pin the parity with a snap (joins and probe
 * resets don't animate). A LIVE phase change only ARMS the flip: the next
 * angle tick consumes it, so the face turns in the same call that retargets
 * the hand with the new phase's angle — one motion. */
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
    applyFace(true);
    if (handDeg !== null && hand) {
      handDeg += 360; // same screen angle, new winding — keep them consistent
      setHand(handDeg, true);
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
 * phase event went missing) the hand winds FORWARD over the top while the
 * faces cross-fade — +180 net on the natural cycle, never backwards.
 * Continuous ticks SNAP; forward skips (freeze-mode phase testing) ride the
 * CSS transition. */
export function setClockAngle(deg: number, instant = false) {
  mount();
  const now = performance.now();
  let target = deg + flips * 360;
  if (!instant && handDeg !== null) {
    const wantFlip =
      (pendingNight !== null && (flips & 1) !== (pendingNight ? 1 : 0)) ||
      // fallback: the raw hand-off jump, only when it lands the right face
      (target - handDeg <= -90 && ((flips + 1) & 1) === (lastPhaseNight ? 1 : 0));
    if (wantFlip) {
      flips += 1;
      pendingNight = null;
      target += 360; // natural hand-off: net +180, up over the top
      flipHoldUntil = now + FADE_S * 1000;
      handDeg = target;
      applyFace(false);
      setHand(target, false);
      return;
    }
    if (now < flipHoldUntil) return; // gliding: per-frame ticks wait their turn
  }
  pendingNight = null;
  if (handDeg !== null && Math.abs(target - handDeg) < 0.01) return;
  const delta = handDeg === null ? 0 : target - handDeg;
  const snap = instant || handDeg === null || delta < 3; // small/backward = tick
  handDeg = target;
  setHand(target, snap);
}
