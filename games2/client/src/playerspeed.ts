// THE PLAYER-SPEED DIAL (maintainer 2026-09-11: "add a slider in settings so I
// can control/tweak the players speed ... will be good for me in order to find
// the perfect default and a way for me to travel the map faster").
//
// A multiplier on the walk/run speed, 0.5x to 4x, default 1x — today's walk, so
// the dial ships as an instrument and changes nothing until he moves it.
//
// IT IS NOT A CLIENT SETTING. Movement is server-authoritative and the client
// predicts it, so a knob only one side knew about would rubber-band on every
// step. The value rides WITH each input message (`InputMessage.sm`) and both
// sides integrate that window under that number — the same rule `running` and
// the hit-slow factor already follow, and the reason is the same: the client
// replays an RTT-deep buffer of pending inputs, and a factor that changed
// mid-flight would rewrite the history of every input still in it.
//
// THE DIAL IS INJECTED FROM OUTSIDE, because games-ui owns hud.ts (UI_AGENT.md)
// and this is the games agent's setting — same pattern as the nav dials
// (navbias.ts): find the settings page, add to it, re-add when the HudBar has
// thrown everything away on a rejoin, and wear the HUD's OWN slider classes so
// it is the same widget to look at, with the "default" button he asked every
// slider to have.

import { PLAYER_SPEED_MIN, PLAYER_SPEED_MAX, PLAYER_SPEED_DEFAULT } from "@nangijala/shared";

const KEY = "ml-player-speed";
export const SPEED_EVENT = "ml-player-speed";

const clampSpeed = (v: number) => Math.max(PLAYER_SPEED_MIN, Math.min(PLAYER_SPEED_MAX, v));

function read(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return PLAYER_SPEED_DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) ? clampSpeed(v) : PLAYER_SPEED_DEFAULT;
  } catch {
    return PLAYER_SPEED_DEFAULT; // private mode / storage disabled
  }
}

let value = read();

/** The multiplier every input is stamped with. */
export function playerSpeed(): number {
  return value;
}

export function setPlayerSpeed(v: number): void {
  const next = clampSpeed(Number.isFinite(v) ? v : PLAYER_SPEED_DEFAULT);
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {}
  window.dispatchEvent(new Event(SPEED_EVENT));
  paint();
}

/** Slider percent (0..1) <-> the value, linear over the range, quantised to
 *  tenths so the readout and the stored number are the same thing. */
export const speedFromSlider = (p: number) =>
  Math.round((PLAYER_SPEED_MIN + p * (PLAYER_SPEED_MAX - PLAYER_SPEED_MIN)) * 10) / 10;
export const sliderFromSpeed = (v: number) =>
  (clampSpeed(v) - PLAYER_SPEED_MIN) / (PLAYER_SPEED_MAX - PLAYER_SPEED_MIN);
export const speedLabel = (v: number) =>
  `${v.toFixed(1)}x${Math.abs(v - PLAYER_SPEED_DEFAULT) < 1e-6 ? " (normal)" : ""}`;

/* -- the injected dial ------------------------------------------------------ */

const CLS = "ml-speeddial";

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
  const p = sliderFromSpeed(value);
  dial.fill.style.width = `${(p * 100).toFixed(2)}%`;
  const tw = dial.track.clientWidth;
  const kw = dial.knob.offsetWidth || 22;
  dial.knob.style.left = `${Math.round(Math.max(0, Math.min(tw - kw, p * tw - kw / 2)))}px`;
  dial.valEl.textContent = speedLabel(value);
  dial.reset.disabled = Math.abs(value - PLAYER_SPEED_DEFAULT) < 1e-6;
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
  label.textContent = "Player speed";
  const valEl = mk("span", "ml-amb-slider-val");
  head.append(label, valEl);
  // THE HUD'S OWN ROW, BY CLASS: .ml-slider-row puts the "default" button in
  // the gutter to the RIGHT of the track. No private copy of that CSS — hud.ts
  // owns the recipe and dresses adopted dials anyway (navbias.ts paid for this
  // once: a rewrite kept a private copy and dropped the call that injected it,
  // and both dials shipped with the button on its own line).
  const row = mk("div", "ml-slider-row");
  const reset = mk("button", "ml-slider-def") as HTMLButtonElement;
  reset.type = "button";
  reset.textContent = "default";
  reset.title = "back to the normal walk";
  reset.addEventListener("click", () => setPlayerSpeed(PLAYER_SPEED_DEFAULT));
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
    return r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : sliderFromSpeed(value);
  };
  let dragging = false;
  const down = (e: PointerEvent) => {
    dragging = true;
    track.setPointerCapture(e.pointerId);
    setPlayerSpeed(speedFromSlider(pAt(e.clientX)));
    e.preventDefault();
  };
  const move = (e: PointerEvent) => {
    if (dragging) setPlayerSpeed(speedFromSlider(pAt(e.clientX)));
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
export function ensureSpeedDial() {
  if (dial?.wrap.isConnected) return;
  const host = document.querySelector<HTMLElement>('.ml-page[data-page="settings"] .ml-set');
  if (!host) return; // HUD not built yet — try again next poll
  dial?.wrap.remove();
  dial = build(host);
  paint();
}
