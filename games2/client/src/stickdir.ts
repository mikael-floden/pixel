// ============================================================================
// ALMOST EIGHT DIRECTIONS — the stick's dial, and the raw angle it leans toward
// ============================================================================
//
// Maintainer 2026-09-11: "I know we snap the players movement into 8 directions.
// I still like that because we only have animations in 8 directions and you will
// only be able to run in 8 directions on a keyboard. But this makes it hard to
// see if you are close to 'snap' to a new direction or not. So I would like to
// change this so we almost run in 8 directions."
//
// TWO HALVES, both in here because neither is any use alone:
//
//  1. THE DIAL (0..1, default 0 = today to the pixel), a Settings slider like
//     the nav and speed dials, injected from outside because games-ui owns
//     hud.ts. The lean itself is `leanHeading` in shared/, so the server
//     integrates the identical vector the client predicts.
//
//  2. THE RAW ANGLE, which the game does not otherwise have. The on-screen
//     stick lives in games-ui's `gamepad.ts` and deliberately SYNTHESIZES
//     KEYBOARD EVENTS — "it simulates the keyboard (WASD), nothing else ... no
//     games-agent file is touched" — so by the time an input reaches this
//     agent's code it is already one of nine grid vectors and the finger's
//     actual bearing is gone.
//
//     So this reads the bearing itself, ADDITIVELY: its own pointer listeners
//     on their `.ml-pad-stick` element, computing `atan2(dy, dx)` from the same
//     element rect their `apply()` does. Nothing of theirs is edited, their
//     contract is untouched, and — the part that matters — EVERY THRESHOLD
//     STAYS THEIRS. The dead zone, the walk/run amplitude and which octant won
//     all still come from the keys they synthesize; this contributes an angle
//     and nothing else. No finger down, no angle, no lean: a keyboard player is
//     bit-for-bit unaffected, which is what he asked for.
//
//     (Offered to games-ui on the board: if they would rather publish the
//     bearing from `gamepad.ts` themselves, this half deletes cleanly.)

import { STICK_LEAN_MIN, STICK_LEAN_MAX, STICK_LEAN_DEFAULT } from "@nangijala/shared";

const KEY = "ml-stick-lean";
export const STICK_LEAN_EVENT = "ml-stick-lean";

const clampLean = (v: number) => Math.max(STICK_LEAN_MIN, Math.min(STICK_LEAN_MAX, v));

function read(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return STICK_LEAN_DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) ? clampLean(v) : STICK_LEAN_DEFAULT;
  } catch {
    return STICK_LEAN_DEFAULT; // private mode / storage disabled
  }
}

let value = read();

/** How far the heading may lean off its octant, 0..1. */
export function stickLean(): number {
  return value;
}

export function setStickLean(v: number): void {
  const next = clampLean(Number.isFinite(v) ? v : STICK_LEAN_DEFAULT);
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {}
  window.dispatchEvent(new Event(STICK_LEAN_EVENT));
  paint();
}

/* -- half 2: the finger's bearing ------------------------------------------- */

let heading: number | null = null;
let bound: HTMLElement | null = null;

/** The finger's bearing on the stick in DEGREES, screen frame (+x right, +y
 *  down — the same frame `ax/ay` and their own `atan2(dy, dx)` use), or null
 *  when no finger is on the stick. */
export function stickHeading(): number | null {
  return heading;
}

/** Idempotent: keep listeners on the live stick element. The HUD rebuilds
 *  itself on a rejoin and the landscape layout re-parents the stick, so the
 *  element this was bound to can be replaced — `isConnected` catches that and
 *  re-binds, exactly as the injected dials re-add themselves. */
export function ensureStickAngle(): void {
  const pad = document.querySelector<HTMLElement>(".ml-pad-stick");
  if (!pad || pad === bound) {
    if (bound && !bound.isConnected) {
      bound = null;
      heading = null;
    }
    return;
  }
  bound = pad;
  heading = null;
  const at = (ev: PointerEvent) => {
    const r = pad.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dx = ev.clientX - (r.left + r.width / 2);
    const dy = ev.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < 1) return; // dead centre has no bearing
    heading = (Math.atan2(dy, dx) * 180) / Math.PI;
  };
  const clear = () => {
    heading = null;
  };
  // PASSIVE, and never preventDefault: their handlers must behave exactly as
  // they did before anything here existed.
  pad.addEventListener("pointerdown", at, { passive: true });
  pad.addEventListener("pointermove", at, { passive: true });
  pad.addEventListener("pointerup", clear, { passive: true });
  pad.addEventListener("pointercancel", clear, { passive: true });
  pad.addEventListener("lostpointercapture", clear, { passive: true });
}

/* -- the injected dial ------------------------------------------------------ */

export const leanFromSlider = (p: number) =>
  Math.round((STICK_LEAN_MIN + p * (STICK_LEAN_MAX - STICK_LEAN_MIN)) * 100) / 100;
export const sliderFromLean = (v: number) =>
  (clampLean(v) - STICK_LEAN_MIN) / (STICK_LEAN_MAX - STICK_LEAN_MIN);
export const leanLabel = (v: number) =>
  v <= 0.0001 ? "0.00 (8-way snap)" : v >= 0.9999 ? "1.00 (free 360°)" : v.toFixed(2);

interface Dial {
  wrap: HTMLElement;
  fill: HTMLElement;
  knob: HTMLElement;
  valEl: HTMLElement;
  track: HTMLElement;
  reset: HTMLButtonElement;
}

let dial: Dial | null = null;

function paint() {
  if (!dial) return;
  const p = sliderFromLean(value);
  dial.fill.style.width = `${(p * 100).toFixed(2)}%`;
  const tw = dial.track.clientWidth;
  const kw = dial.knob.offsetWidth || 22;
  dial.knob.style.left = `${Math.round(Math.max(0, Math.min(tw - kw, p * tw - kw / 2)))}px`;
  dial.valEl.textContent = leanLabel(value);
  dial.reset.disabled = Math.abs(value - STICK_LEAN_DEFAULT) < 1e-6;
}

function build(host: HTMLElement): Dial {
  const mk = (tag: string, cls: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e as HTMLElement;
  };
  const wrap = mk("div", "ml-amb-slider ml-stickdial");
  const head = mk("div", "ml-amb-slider-head");
  const label = mk("span", "ml-amb-slider-label");
  label.textContent = "Direction freedom (stick)";
  const valEl = mk("span", "ml-amb-slider-val");
  head.append(label, valEl);
  // The HUD's OWN row, by class — the "default" button sits in the gutter to
  // the right of the track. No private copy of that CSS (navbias.ts paid for
  // that once).
  const row = mk("div", "ml-slider-row");
  const reset = mk("button", "ml-slider-def") as HTMLButtonElement;
  reset.type = "button";
  reset.textContent = "default";
  reset.title = "back to the exact 8-direction snap";
  reset.addEventListener("click", () => setStickLean(STICK_LEAN_DEFAULT));
  const track = mk("div", "ml-slider");
  const fill = mk("div", "ml-slider-fill");
  const knob = mk("div", "ml-slider-knob");
  track.append(fill, knob);
  row.append(track, reset);
  wrap.append(head, row);
  host.appendChild(wrap);

  const d: Dial = { wrap, fill, knob, valEl, track, reset };
  const pAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : sliderFromLean(value);
  };
  let dragging = false;
  const down = (e: PointerEvent) => {
    dragging = true;
    track.setPointerCapture(e.pointerId);
    setStickLean(leanFromSlider(pAt(e.clientX)));
    e.preventDefault();
  };
  const move = (e: PointerEvent) => {
    if (dragging) setStickLean(leanFromSlider(pAt(e.clientX)));
  };
  const up = (e: PointerEvent) => {
    dragging = false;
    try {
      track.releasePointerCapture(e.pointerId);
    } catch {}
  };
  track.addEventListener("pointerdown", down);
  track.addEventListener("pointermove", move);
  track.addEventListener("pointerup", up);
  track.addEventListener("pointercancel", up);
  new ResizeObserver(() => paint()).observe(track);
  return d;
}

/** Idempotent: keep one live copy of the dial on the Settings page. */
export function ensureStickDial(): void {
  if (dial?.wrap.isConnected) return;
  const host = document.querySelector<HTMLElement>('.ml-page[data-page="settings"] .ml-set');
  if (!host) return; // HUD not built yet — try again next poll
  dial?.wrap.remove();
  dial = build(host);
  paint();
}
