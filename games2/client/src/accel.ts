// THE ACCELERATION RAMP (maintainer 2026-09-13: "The player's acceleration from
// standing still to running fast is way way way too fast right now. It kinda
// feels like we go from 0% to 100% on a single frame. Create a slider for this
// and make the new default 5x as slow as today").
//
// The time, in seconds, a body takes from rest to its full speed: 0 is the
// instant law of before, the default five frames of 33 ms (ACCEL_S_DEFAULT),
// the top a full second. The ramp itself is the shared `accelStep`; its factor
// rides WITH each input (`InputMessage.ac`), so prediction, replay and the
// server integrate every window under the same number — the dial changes what
// the client stamps on its inputs, never room state (the speed dial's rule,
// playerspeed.ts, and its reason: a factor that changed mid-flight would
// rewrite the history of every input still in the pending buffer).
//
// THE DIAL IS INJECTED FROM OUTSIDE, because games-ui owns hud.ts (UI_AGENT.md)
// and this is the games agent's setting — the pattern of the nav, speed, stick,
// wall-assist and nav-help dials: find the settings page, add to it, re-add
// when the HudBar has thrown everything away on a rejoin, and wear the HUD's
// OWN slider classes so it is the same widget to look at, with the "default"
// button he asked every slider to have.

import { ACCEL_S_MIN, ACCEL_S_MAX, ACCEL_S_DEFAULT } from "@nangijala/shared";

const KEY = "ml-accel";
export const ACCEL_EVENT = "ml-accel";

/** Hundredths of a second, clamped to the range. */
const clampS = (v: number) => Math.max(ACCEL_S_MIN, Math.min(ACCEL_S_MAX, Math.round(v * 100) / 100));

function read(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return ACCEL_S_DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) ? clampS(v) : ACCEL_S_DEFAULT;
  } catch {
    return ACCEL_S_DEFAULT; // private mode / storage disabled
  }
}

let value = read();

/** The ramp, in seconds from rest to full speed, every input is stamped under. */
export function accelS(): number {
  return value;
}

export function setAccelS(v: number): void {
  const next = clampS(Number.isFinite(v) ? v : ACCEL_S_DEFAULT);
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {}
  window.dispatchEvent(new Event(ACCEL_EVENT));
  paint();
}

/** Slider percent (0..1) <-> the value, linear over the range in hundredths. */
export const sFromSlider = (p: number) => clampS(ACCEL_S_MIN + p * (ACCEL_S_MAX - ACCEL_S_MIN));
export const sliderFromS = (v: number) => (clampS(v) - ACCEL_S_MIN) / (ACCEL_S_MAX - ACCEL_S_MIN);
export const sLabel = (v: number) =>
  v === 0 ? "instant" : `${v.toFixed(2)} s${Math.abs(v - ACCEL_S_DEFAULT) < 1e-9 ? " (default)" : ""}`;

/* -- the injected dial ------------------------------------------------------ */

const CLS = "ml-acceldial";

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
  const p = sliderFromS(value);
  dial.fill.style.width = `${(p * 100).toFixed(2)}%`;
  const tw = dial.track.clientWidth;
  const kw = dial.knob.offsetWidth || 22;
  dial.knob.style.left = `${Math.round(Math.max(0, Math.min(tw - kw, p * tw - kw / 2)))}px`;
  dial.valEl.textContent = sLabel(value);
  dial.reset.disabled = Math.abs(value - ACCEL_S_DEFAULT) < 1e-9;
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
  label.textContent = "Acceleration (time to full speed)";
  label.title = "How long the body takes from standing still to its full speed; 0 is instant";
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
  reset.title = "back to the default ramp";
  reset.addEventListener("click", () => setAccelS(ACCEL_S_DEFAULT));
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
    return r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : sliderFromS(value);
  };
  let dragging = false;
  const down = (e: PointerEvent) => {
    dragging = true;
    track.setPointerCapture(e.pointerId);
    setAccelS(sFromSlider(pAt(e.clientX)));
    e.preventDefault();
  };
  const move = (e: PointerEvent) => {
    if (dragging) setAccelS(sFromSlider(pAt(e.clientX)));
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
export function ensureAccelDial() {
  if (dial?.wrap.isConnected) return;
  const host = document.querySelector<HTMLElement>('.ml-page[data-page="settings"] .ml-set');
  if (!host) return; // HUD not built yet — try again next poll
  dial?.wrap.remove();
  dial = build(host);
  paint();
}
