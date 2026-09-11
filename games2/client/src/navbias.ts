// THE UPHILL BIAS — how much the tap router prefers the spot you can SEE — and
// its EXPO, how much deeper behind the hill makes that preference stronger.
//
// One tap on a raised pixel has two meanings (docs/movement.md, "ONE TAP, TWO
// MEANINGS"): the surface drawn there, and the ground drawn at the same pixel
// from a cell 6.4 storeys up-screen — behind the hill. The router walked both
// and took the shorter walk, which sent the maintainer round the back of an
// 8-level hill when the stairs were in front of him (2026-09-10: "it was kinda
// obvious I wanted to run up the stairs right in front of me ... in situations
// like this I think the player almost always want to run up the stairs ... even
// if the path is shorter to the location behind the hill we might still navigate
// up the hill, that is more likely what the player wanted").
//
// So the visible reading carries a handicap: a hidden candidate must be this
// many times SHORTER to win. `startBestTrip` applies
//
//     bias = uphill * depth^(expo - 1)
//
// where `depth` is the storeys of hill between the two readings. The BIAS is
// how much the visible spot is preferred at all; the EXPO is how much that
// depends on how far behind the hill the hidden reading is (maintainer: "the
// closer further down a covered area your click suggest the more expo the
// Uphill bias has"). Both numbers are HIS — bias 2.7 is his verdict, expo
// starts at 1.0 (identical to the flat rule) for him to tune.
//
// THE DIALS ARE INJECTED FROM OUTSIDE, because games-ui owns hud.ts
// (UI_AGENT.md) and these are the games agent's settings. Same pattern as the
// ambient agent's settings button and the map layer row: find the page, add to
// it, and re-add when the HudBar has thrown everything away on a rejoin. They
// wear the HUD's OWN slider classes — .ml-amb-slider, .ml-slider-row and the
// .ml-slider-def button — so they are the same widget to look at, and each
// carries the "default" button he asked every slider to have. hud.ts then
// MOVES this wrap into its dial group so the dials all sit together; wrap
// .isConnected stays true through the move, so ensureNavDial still returns
// early and nothing re-injects.

export const NAV_UPHILL_MIN = 1;
export const NAV_UPHILL_MAX = 8;
/** HIS NUMBER, from the slider (maintainer 2026-09-10: "a good value for
 *  Uphill bias (tap) default is 2.7x"). A hidden reading has to be under
 *  0.37 of the visible one's walk to win, so the stairs in front of you take a
 *  tap unless going round the back really is far shorter. Not a placeholder —
 *  do not "restore" 2. */
export const NAV_UPHILL_DEFAULT = 2.7;

/** THE EXPO NEVER GOES BELOW 1: it may only make the visible spot harder to
 *  displace, never easier (maintainer: "this expo will be 1.0 or more so don't
 *  make it possible to have an expo less than 1.0"). 1.0 is the flat rule. */
export const NAV_EXPO_MIN = 1;
export const NAV_EXPO_MAX = 4;
/** 1.0 = exactly the flat bias, whatever the depth. Awaiting his verdict. */
export const NAV_EXPO_DEFAULT = 1;

/* -- the two values -------------------------------------------------------- */

interface Spec {
  key: string;
  min: number;
  max: number;
  def: number;
  /** Decimals the slider quantises to. */
  round: number;
  label: string;
  event: string;
  text: (v: number) => string;
}

const UPHILL: Spec = {
  key: "ml-nav-uphill",
  min: NAV_UPHILL_MIN,
  max: NAV_UPHILL_MAX,
  def: NAV_UPHILL_DEFAULT,
  round: 1,
  label: "Uphill bias (tap)",
  event: "ml-nav-uphill",
  text: (v) => (v <= 1.001 ? "off" : `${v.toFixed(1)}x`),
};

const EXPO: Spec = {
  key: "ml-nav-expo",
  min: NAV_EXPO_MIN,
  max: NAV_EXPO_MAX,
  def: NAV_EXPO_DEFAULT,
  round: 2,
  label: "Uphill bias expo (depth)",
  event: "ml-nav-expo",
  text: (v) => (v <= 1.0001 ? "1.00 (flat)" : v.toFixed(2)),
};

const clampTo = (sp: Spec, v: number) => Math.max(sp.min, Math.min(sp.max, v));

function read(sp: Spec): number {
  try {
    const raw = localStorage.getItem(sp.key);
    if (raw === null) return sp.def;
    const v = Number(raw);
    return Number.isFinite(v) ? clampTo(sp, v) : sp.def;
  } catch {
    return sp.def; // private mode / storage disabled
  }
}

const value = new Map<string, number>([
  [UPHILL.key, read(UPHILL)],
  [EXPO.key, read(EXPO)],
]);

function set(sp: Spec, v: number): void {
  const next = clampTo(sp, Number.isFinite(v) ? v : sp.def);
  if (next === value.get(sp.key)) return;
  value.set(sp.key, next);
  try {
    localStorage.setItem(sp.key, String(next));
  } catch {}
  window.dispatchEvent(new Event(sp.event));
  paintAll();
}

/** The handicap `startBestTrip` applies to a hidden reading. */
export function navUphill(): number {
  return value.get(UPHILL.key)!;
}
export function setNavUphill(v: number): void {
  set(UPHILL, v);
}
/** The exponent it raises the hidden reading's DEPTH to (minus one). */
export function navExpo(): number {
  return value.get(EXPO.key)!;
}
export function setNavExpo(v: number): void {
  set(EXPO, v);
}

/** Slider percent (0..1) ↔ the value, linear over the range. */
const fromSlider = (sp: Spec, p: number) => {
  const m = Math.pow(10, sp.round);
  return Math.round((sp.min + p * (sp.max - sp.min)) * m) / m;
};
const toSlider = (sp: Spec, v: number) => (clampTo(sp, v) - sp.min) / (sp.max - sp.min);

export const uphillFromSlider = (p: number) => fromSlider(UPHILL, p);
export const sliderFromUphill = (v: number) => toSlider(UPHILL, v);
export const expoFromSlider = (p: number) => fromSlider(EXPO, p);
export const sliderFromExpo = (v: number) => toSlider(EXPO, v);
export const uphillLabel = (v: number) => UPHILL.text(v);
export const expoLabel = (v: number) => EXPO.text(v);

/* -- the injected dials ----------------------------------------------------- */

const CLS = "ml-navdial";

interface Dial {
  sp: Spec;
  wrap: HTMLElement;
  fill: HTMLElement;
  knob: HTMLElement;
  valEl: HTMLElement;
  track: HTMLElement;
  reset: HTMLButtonElement;
}

let dials: Dial[] = [];

function paint(d: Dial) {
  const v = value.get(d.sp.key)!;
  const p = toSlider(d.sp, v);
  d.fill.style.width = `${(p * 100).toFixed(2)}%`;
  const tw = d.track.clientWidth;
  const kw = d.knob.offsetWidth || 22;
  d.knob.style.left = `${Math.round(Math.max(0, Math.min(tw - kw, p * tw - kw / 2)))}px`;
  d.valEl.textContent = d.sp.text(v);
  d.reset.disabled = Math.abs(v - d.sp.def) < 1e-6;
}

function paintAll() {
  for (const d of dials) paint(d);
}

function build(host: HTMLElement, sp: Spec): Dial {
  const mk = (tag: string, cls: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e as HTMLElement;
  };
  const wrap = mk("div", `ml-amb-slider ${CLS}`);
  const head = mk("div", "ml-amb-slider-head");
  const label = mk("span", "ml-amb-slider-label");
  label.textContent = sp.label;
  const valEl = mk("span", "ml-amb-slider-val");
  head.append(label, valEl);
  // THE HUD'S OWN ROW, BY CLASS — .ml-slider-row puts the "default" button in
  // the scroll gutter to the RIGHT of the track, which is where he asked every
  // dial to carry it (2026-09-10). NO PRIVATE COPY OF THIS CSS: this file kept
  // one, a rewrite left the copy but dropped the call that injected it, and
  // both dials shipped with the button on its own line above the track. hud.ts
  // owns the recipe and dresses these dials on adoption anyway.
  const row = mk("div", "ml-slider-row");
  const reset = mk("button", "ml-slider-def") as HTMLButtonElement;
  reset.type = "button";
  reset.textContent = "default";
  reset.title = "back to the default";
  reset.addEventListener("click", () => set(sp, sp.def));
  const track = mk("div", "ml-slider");
  const fill = mk("div", "ml-slider-fill");
  const knob = mk("div", "ml-slider-knob");
  track.append(fill, knob);
  row.append(track, reset);
  wrap.append(head, row);
  host.appendChild(wrap);

  const d: Dial = { sp, wrap, fill, knob, valEl, track, reset };
  const pAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : toSlider(sp, value.get(sp.key)!);
  };
  let dragging = false;
  const down = (e: PointerEvent) => {
    dragging = true;
    track.setPointerCapture(e.pointerId);
    set(sp, fromSlider(sp, pAt(e.clientX)));
    e.preventDefault();
  };
  const move = (e: PointerEvent) => {
    if (dragging) set(sp, fromSlider(sp, pAt(e.clientX)));
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
  new ResizeObserver(() => paint(d)).observe(track);
  return d;
}

/** Idempotent: keep one live copy of each dial on the Settings page. Cheap
 *  enough to poll (a querySelector and an early return once they are there). */
export function ensureNavDial() {
  if (dials.length && dials.every((d) => d.wrap.isConnected)) return;
  // The dials live in the settings column, after the ambient checklist — the
  // same host the HUD appends its own sliders to.
  const host = document.querySelector<HTMLElement>('.ml-page[data-page="settings"] .ml-set');
  if (!host) return; // HUD not built yet — try again next poll
  for (const d of dials) d.wrap.remove();
  dials = [UPHILL, EXPO].map((sp) => build(host, sp));
  paintAll();
}
