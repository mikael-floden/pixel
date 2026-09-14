// HOW FAST THE NAV HELPS (maintainer 2026-09-13: "how fast the player has to
// run into something before the nav system helps. That should be extremely
// fast. Can you put it on a slider? I think 0.1s is a good default, but let the
// slider go all the way up to 2s").
//
// The window, in seconds, a held direction may go without progress along it
// before `walkHeading` plans a committed escape route (its rule 0; progress is
// a RATE, so a slide round a scenery piece that keeps moving is left alone —
// "the slide around a scenery object should be preferred if the sliding is
// doing progress"). Shared constants NAV_HELP_MS_*; the walk takes it per call
// as `stuckMs`, so the dial changes nothing the server integrates. The floor
// is one frame (0.03 s), below his 0.1 s default — he tunes it downward too
// ("you made the default and min the same value to make it impossible to
// tweak?"); the steps are hundredths so the low end has room.
//
// THE DIAL IS INJECTED FROM OUTSIDE, because games-ui owns hud.ts (UI_AGENT.md)
// and this is the games agent's setting — the pattern of the nav, speed, stick
// and wall-assist dials: find the settings page, add to it, re-add when the
// HudBar has thrown everything away on a rejoin, and wear the HUD's OWN slider
// classes so it is the same widget to look at, with the "default" button he
// asked every slider to have.

import { NAV_HELP_MS_MIN, NAV_HELP_MS_MAX, NAV_HELP_MS_DEFAULT } from "@nangijala/shared";

const KEY = "ml-nav-help";
export const NAV_HELP_EVENT = "ml-nav-help";

/** Whole hundredths of a second, clamped to the range. */
const clampMs = (v: number) => Math.max(NAV_HELP_MS_MIN, Math.min(NAV_HELP_MS_MAX, Math.round(v / 10) * 10));

function read(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return NAV_HELP_MS_DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) ? clampMs(v) : NAV_HELP_MS_DEFAULT;
  } catch {
    return NAV_HELP_MS_DEFAULT; // private mode / storage disabled
  }
}

let value = read();

/** The window, in ms, `walkHeading` waits without progress before it plans. */
export function navHelpMs(): number {
  return value;
}

export function setNavHelpMs(v: number): void {
  const next = clampMs(Number.isFinite(v) ? v : NAV_HELP_MS_DEFAULT);
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {}
  window.dispatchEvent(new Event(NAV_HELP_EVENT));
  paint();
}

/** Slider percent (0..1) <-> the value, linear over the range in hundredths. */
export const msFromSlider = (p: number) => clampMs(NAV_HELP_MS_MIN + p * (NAV_HELP_MS_MAX - NAV_HELP_MS_MIN));
export const sliderFromMs = (v: number) => (clampMs(v) - NAV_HELP_MS_MIN) / (NAV_HELP_MS_MAX - NAV_HELP_MS_MIN);
export const msLabel = (v: number) => `${(v / 1000).toFixed(2)} s${v === NAV_HELP_MS_DEFAULT ? " (default)" : ""}`;

/* -- the injected dial ------------------------------------------------------ */

const CLS = "ml-navhelpdial";

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
  const p = sliderFromMs(value);
  dial.fill.style.width = `${(p * 100).toFixed(2)}%`;
  const tw = dial.track.clientWidth;
  const kw = dial.knob.offsetWidth || 22;
  dial.knob.style.left = `${Math.round(Math.max(0, Math.min(tw - kw, p * tw - kw / 2)))}px`;
  dial.valEl.textContent = msLabel(value);
  dial.reset.disabled = value === NAV_HELP_MS_DEFAULT;
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
  label.textContent = "Nav help after (stuck)";
  label.title = "How long the body may make no headway before the nav plans a way round; a slide that keeps moving is left alone";
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
  reset.title = "back to the default wait";
  reset.addEventListener("click", () => setNavHelpMs(NAV_HELP_MS_DEFAULT));
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
    return r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : sliderFromMs(value);
  };
  let dragging = false;
  const down = (e: PointerEvent) => {
    dragging = true;
    track.setPointerCapture(e.pointerId);
    setNavHelpMs(msFromSlider(pAt(e.clientX)));
    e.preventDefault();
  };
  const move = (e: PointerEvent) => {
    if (dragging) setNavHelpMs(msFromSlider(pAt(e.clientX)));
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
export function ensureNavHelpDial() {
  if (dial?.wrap.isConnected) return;
  const host = document.querySelector<HTMLElement>('.ml-page[data-page="settings"] .ml-set');
  if (!host) return; // HUD not built yet — try again next poll
  dial?.wrap.remove();
  dial = build(host);
  paint();
}
