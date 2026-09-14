// THE WALL-ASSIST ANGLE (maintainer 2026-09-13: "In the case just a little bit
// is into the wall we can help the player to run straight alongside the wall
// (to not lose friction and looking dumb to not walk/run straight), but again
// if we tilt too much into the wall we will not help the player making the
// velocity straight with the wall and instead start to slide against the wall
// ... What the angle threshold is when helping the player run alongside the
// wall should be configurable in settings with a slider").
//
// The thumb's angle to a terrain wall, in SCREEN degrees, up to which a run
// leaned into the wall is straightened to run exactly along it at full speed
// (shared `walkHeading`, its terrain branch; the measure is `wallAngleDeg`).
// Past it the body keeps its heading and slides at the wall's own rate, and
// hops the wall when a jump would clear it. 0 turns the help off.
//
// A CLIENT SETTING, unlike the speed dial: the straightened vector is a
// deflection like steer assist's, predicted and sent as ordinary input, so the
// server never needs the number.
//
// THE DIAL IS INJECTED FROM OUTSIDE, because games-ui owns hud.ts (UI_AGENT.md)
// and this is the games agent's setting — the pattern of the nav, speed and
// stick dials (navbias.ts, playerspeed.ts, stickdir.ts): find the settings page,
// add to it, re-add when the HudBar has thrown everything away on a rejoin, and
// wear the HUD's OWN slider classes so it is the same widget to look at, with
// the "default" button he asked every slider to have.

import { WALL_ASSIST_DEG_MIN, WALL_ASSIST_DEG_MAX, WALL_ASSIST_DEG_DEFAULT } from "@nangijala/shared";

const KEY = "ml-wall-assist";
export const WALL_ASSIST_EVENT = "ml-wall-assist";

const clampDeg = (v: number) => Math.max(WALL_ASSIST_DEG_MIN, Math.min(WALL_ASSIST_DEG_MAX, Math.round(v)));

function read(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return WALL_ASSIST_DEG_DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) ? clampDeg(v) : WALL_ASSIST_DEG_DEFAULT;
  } catch {
    return WALL_ASSIST_DEG_DEFAULT; // private mode / storage disabled
  }
}

let value = read();

/** The angle, in screen degrees, `walkHeading` straightens a run within. */
export function wallAssistDeg(): number {
  return value;
}

export function setWallAssistDeg(v: number): void {
  const next = clampDeg(Number.isFinite(v) ? v : WALL_ASSIST_DEG_DEFAULT);
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {}
  window.dispatchEvent(new Event(WALL_ASSIST_EVENT));
  paint();
}

/** Slider percent (0..1) <-> whole degrees over the range. */
export const degFromSlider = (p: number) =>
  clampDeg(WALL_ASSIST_DEG_MIN + p * (WALL_ASSIST_DEG_MAX - WALL_ASSIST_DEG_MIN));
export const sliderFromDeg = (v: number) =>
  (clampDeg(v) - WALL_ASSIST_DEG_MIN) / (WALL_ASSIST_DEG_MAX - WALL_ASSIST_DEG_MIN);
export const degLabel = (v: number) =>
  v <= 0 ? "off" : `${v}°${v === WALL_ASSIST_DEG_DEFAULT ? " (default)" : ""}`;

/* -- the injected dial ------------------------------------------------------ */

const CLS = "ml-walldial";

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
  const p = sliderFromDeg(value);
  dial.fill.style.width = `${(p * 100).toFixed(2)}%`;
  const tw = dial.track.clientWidth;
  const kw = dial.knob.offsetWidth || 22;
  dial.knob.style.left = `${Math.round(Math.max(0, Math.min(tw - kw, p * tw - kw / 2)))}px`;
  dial.valEl.textContent = degLabel(value);
  dial.reset.disabled = value === WALL_ASSIST_DEG_DEFAULT;
}

function build(host: HTMLElement): Dial {
  const mk = (tag: string, cls: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e as HTMLElement;
  };
  const wrap = mk("div", `ml-amb-slider ${CLS}`);
  const head = mk("div", "ml-amb-slider-head");
  const label = mk("span", "ml-amb-slider-label");
  label.textContent = "Wall assist angle";
  label.title = "How far off a wall the stick may point and still run straight along it; past it the body slides against the wall";
  const valEl = mk("span", "ml-amb-slider-val");
  head.append(label, valEl);
  // THE HUD'S OWN ROW, BY CLASS: .ml-slider-row puts the "default" button in
  // the gutter to the RIGHT of the track. No private copy of that CSS — hud.ts
  // owns the recipe and dresses adopted dials anyway (navbias.ts paid for this
  // once).
  const row = mk("div", "ml-slider-row");
  const reset = mk("button", "ml-slider-def") as HTMLButtonElement;
  reset.type = "button";
  reset.textContent = "default";
  reset.title = "back to the default angle";
  reset.addEventListener("click", () => setWallAssistDeg(WALL_ASSIST_DEG_DEFAULT));
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
    return r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : sliderFromDeg(value);
  };
  let dragging = false;
  const down = (e: PointerEvent) => {
    dragging = true;
    track.setPointerCapture(e.pointerId);
    setWallAssistDeg(degFromSlider(pAt(e.clientX)));
    e.preventDefault();
  };
  const move = (e: PointerEvent) => {
    if (dragging) setWallAssistDeg(degFromSlider(pAt(e.clientX)));
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

/** Idempotent: keep one live copy of the dial on the Settings page. Cheap
 *  enough to poll (a querySelector and an early return once it is there). */
export function ensureWallAssistDial() {
  if (dial?.wrap.isConnected) return;
  const host = document.querySelector<HTMLElement>('.ml-page[data-page="settings"] .ml-set');
  if (!host) return; // HUD not built yet — try again next poll
  dial?.wrap.remove();
  dial = build(host);
  paint();
}
