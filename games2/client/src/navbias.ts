// THE UPHILL BIAS — how much the tap router prefers the spot you can SEE.
//
// One tap on a raised pixel has two meanings (docs/movement.md, "ONE TAP, TWO
// MEANINGS"): the surface drawn there, and the ground drawn at the same pixel
// from a cell 6.4 storeys up-screen — behind the hill. The router walks both
// and took the shorter walk, which sent the maintainer round the back of an
// 8-level hill when the stairs were in front of him (2026-09-10: "it was kinda
// obvious I wanted to run up the stairs right in front of me ... in situations
// like this I think the player almost always want to run up the stairs ... even
// if the path is shorter to the location behind the hill we might still navigate
// up the hill, that is more likely what the player wanted").
//
// So the visible reading carries a handicap: a hidden candidate must be this
// many times SHORTER to win (1 = off, the old rule). `startBestTrip` applies
// it. The number is HIS to find — "how much more we weight this is something I
// must try" — so it is a slider, and the default below is a placeholder until
// he gives a verdict.
//
// THE DIAL IS INJECTED FROM OUTSIDE, because games-ui owns hud.ts (UI_AGENT.md)
// and this is the games agent's setting. Same pattern as the ambient agent's
// settings button and the map layer row: find the page, add to it, and re-add
// when the HudBar has thrown everything away on a rejoin. It wears the HUD's
// OWN slider classes — including .ml-slider-row and the .ml-slider-def button,
// which hud.ts now gives EVERY dial (maintainer 2026-09-10: the button belongs
// to the RIGHT of the track, in the scroll gutter) — so there is one recipe and
// this dial cannot drift away from the ones beside it. hud.ts also MOVES this
// wrap into its dial group after we append it; wrap.isConnected stays true
// through that, so ensureNavDial keeps returning early.
const KEY = "ml-nav-uphill";

export const NAV_UPHILL_MIN = 1;
export const NAV_UPHILL_MAX = 8;
/** PLACEHOLDER, not a verdict: the visible spot wins unless the hidden one is
 *  less than half the walk. Enough to feel the rule on the hill he reported;
 *  he replaces it once the slider has told him the right number. */
export const NAV_UPHILL_DEFAULT = 2;

const clamp = (v: number) => Math.max(NAV_UPHILL_MIN, Math.min(NAV_UPHILL_MAX, v));

let value = read();

function read(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return NAV_UPHILL_DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) ? clamp(v) : NAV_UPHILL_DEFAULT;
  } catch {
    return NAV_UPHILL_DEFAULT; // private mode / storage disabled
  }
}

/** The handicap `startBestTrip` applies to a hidden reading. */
export function navUphill(): number {
  return value;
}

export function setNavUphill(v: number): void {
  const next = clamp(Number.isFinite(v) ? v : NAV_UPHILL_DEFAULT);
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {}
  window.dispatchEvent(new Event("ml-nav-uphill"));
  paint();
}

/** Slider percent (0..1) ↔ the multiplier, linear over the range. */
export const uphillFromSlider = (p: number) =>
  Math.round((NAV_UPHILL_MIN + p * (NAV_UPHILL_MAX - NAV_UPHILL_MIN)) * 10) / 10;
export const sliderFromUphill = (v: number) =>
  (clamp(v) - NAV_UPHILL_MIN) / (NAV_UPHILL_MAX - NAV_UPHILL_MIN);

export const uphillLabel = (v: number) => (v <= 1.001 ? "off" : `${v.toFixed(1)}x`);

/* -- the injected dial ------------------------------------------------------ */

const CLS = "ml-navdial";
let wrap: HTMLElement | null = null;
let fill: HTMLElement | null = null;
let knob: HTMLElement | null = null;
let valEl: HTMLElement | null = null;
let track: HTMLElement | null = null;
let reset: HTMLButtonElement | null = null;

function paint() {
  if (!fill || !knob || !valEl || !track || !reset) return;
  const p = sliderFromUphill(value);
  fill.style.width = `${(p * 100).toFixed(2)}%`;
  const tw = track.clientWidth;
  const kw = knob.offsetWidth || 22;
  knob.style.left = `${Math.round(Math.max(0, Math.min(tw - kw, p * tw - kw / 2)))}px`;
  valEl.textContent = uphillLabel(value);
  reset.disabled = Math.abs(value - NAV_UPHILL_DEFAULT) < 1e-6;
}

function build(host: HTMLElement) {
  const mk = (tag: string, cls: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e as HTMLElement;
  };
  wrap = mk("div", `ml-amb-slider ${CLS}`);
  const head = mk("div", "ml-amb-slider-head");
  const label = mk("span", "ml-amb-slider-label");
  label.textContent = "Uphill bias (tap)";
  valEl = mk("span", "ml-amb-slider-val");
  head.append(label, valEl);
  const row = mk("div", "ml-slider-row");
  reset = mk("button", "ml-slider-def") as HTMLButtonElement;
  reset.type = "button";
  reset.textContent = "default";
  reset.title = "back to the default";
  reset.addEventListener("click", () => setNavUphill(NAV_UPHILL_DEFAULT));
  track = mk("div", "ml-slider");
  fill = mk("div", "ml-slider-fill");
  knob = mk("div", "ml-slider-knob");
  track.append(fill, knob);
  row.append(track, reset);
  wrap.append(head, row);
  host.appendChild(wrap);

  const pAt = (clientX: number) => {
    const r = track!.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : sliderFromUphill(value);
  };
  let dragging = false;
  const down = (e: PointerEvent) => {
    dragging = true;
    track!.setPointerCapture(e.pointerId);
    setNavUphill(uphillFromSlider(pAt(e.clientX)));
    e.preventDefault();
  };
  const move = (e: PointerEvent) => {
    if (dragging) setNavUphill(uphillFromSlider(pAt(e.clientX)));
  };
  const up = (e: PointerEvent) => {
    dragging = false;
    try {
      track!.releasePointerCapture(e.pointerId);
    } catch {}
  };
  track.addEventListener("pointerdown", down);
  track.addEventListener("pointermove", move);
  track.addEventListener("pointerup", up);
  track.addEventListener("pointercancel", up);
  new ResizeObserver(() => paint()).observe(track);
  paint();
}

/** Idempotent: keep one live dial on the Settings page. Cheap enough to poll
 *  (a querySelector and an early return once it is there). */
export function ensureNavDial() {
  if (wrap?.isConnected) return;
  // The dials live in the settings column, after the ambient checklist — the
  // same host the HUD appends its own sliders to.
  const host = document.querySelector<HTMLElement>('.ml-page[data-page="settings"] .ml-set');
  if (!host) return; // HUD not built yet — try again next poll
  wrap?.remove();
  build(host);
}
