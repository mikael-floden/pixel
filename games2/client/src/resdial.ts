/** THE RESOLUTION SLIDER ON THE SETTINGS PAGE — injected from the game side
 *  the way navbias.ts injects its dials (the HUD's own slider classes, no
 *  private CSS), placed JUST ABOVE the HUD's "Light resolution" dial
 *  (maintainer 2026-09-12: "the new resolution slider should be placed just
 *  over the light resolution slider"). resolution.ts owns the value; this
 *  file owns the DOM. Re-injected whenever the HudBar has rebuilt itself —
 *  the scene asks every 250 ms, the same poll as the other injected dials. */
import { lightScaleLabel } from "./lightscale";
import { RENDER_RES_DEFAULT, renderRes, renderResFromSlider, renderResLabel, setRenderRes, sliderFromRenderRes } from "./resolution";

let dial: { wrap: HTMLElement; fill: HTMLElement; knob: HTMLElement; track: HTMLElement; valEl: HTMLElement; reset: HTMLButtonElement } | null = null;

const mk = (tag: string, cls: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

function paint(): void {
  if (!dial) return;
  const p = sliderFromRenderRes(renderRes());
  dial.fill.style.width = `${(p * 100).toFixed(2)}%`;
  const tw = dial.track.clientWidth;
  const kw = dial.knob.offsetWidth || 22;
  dial.knob.style.left = `${Math.round(Math.max(0, Math.min(tw - kw, p * tw - kw / 2)))}px`;
  dial.valEl.textContent = renderResLabel();
  dial.reset.disabled = renderRes() === RENDER_RES_DEFAULT;
  // The light dial's readout names the same units and depends on this value;
  // its own closure repaints only on a drag, so refresh its text here.
  const light = lightRow();
  const val = light?.querySelector<HTMLElement>(".ml-amb-slider-val");
  if (val) val.textContent = lightScaleLabel();
}

function lightRow(): HTMLElement | null {
  const dials = document.querySelector<HTMLElement>('.ml-page[data-page="settings"] .ml-dials');
  if (!dials) return null;
  for (const el of dials.querySelectorAll<HTMLElement>(".ml-amb-slider"))
    if (el.querySelector(".ml-amb-slider-label")?.textContent?.trim() === "Light resolution") return el;
  return null;
}

function apply(v: number): void {
  setRenderRes(v);
  paint();
}

function build(): NonNullable<typeof dial> {
  const wrap = mk("div", "ml-amb-slider ml-res-dial");
  const head = mk("div", "ml-amb-slider-head");
  const label = mk("span", "ml-amb-slider-label");
  label.textContent = "Resolution";
  const valEl = mk("span", "ml-amb-slider-val");
  head.append(label, valEl);
  const row = mk("div", "ml-slider-row");
  const reset = mk("button", "ml-slider-def") as HTMLButtonElement;
  reset.type = "button";
  reset.textContent = "default";
  reset.title = "back to full resolution";
  reset.addEventListener("click", () => apply(RENDER_RES_DEFAULT));
  const track = mk("div", "ml-slider");
  const fill = mk("div", "ml-slider-fill");
  const knob = mk("div", "ml-slider-knob");
  track.append(fill, knob);
  row.append(track, reset);
  wrap.append(head, row);
  const pAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : sliderFromRenderRes(renderRes());
  };
  let dragging = false;
  track.addEventListener("pointerdown", (e) => {
    dragging = true;
    knob.classList.add("grabbing");
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — moves still work via the track listener */
    }
    apply(renderResFromSlider(pAt(e.clientX)));
    e.preventDefault();
  });
  track.addEventListener("pointermove", (e) => {
    if (dragging) apply(renderResFromSlider(pAt(e.clientX)));
  });
  for (const ev of ["pointerup", "pointercancel"] as const)
    track.addEventListener(ev, (e) => {
      if (!dragging) return;
      dragging = false;
      knob.classList.remove("grabbing");
      try {
        track.releasePointerCapture(e.pointerId);
      } catch {
        /* nothing captured */
      }
    });
  new ResizeObserver(() => paint()).observe(track);
  return { wrap, fill, knob, track, valEl, reset };
}

/** Called by the scene's settings poll: a DOM lookup and an early return
 *  unless the HudBar rebuilt itself. */
export function ensureResDial(): void {
  if (dial && dial.wrap.isConnected) return;
  const dials = document.querySelector<HTMLElement>('.ml-page[data-page="settings"] .ml-dials');
  if (!dials) return; // HUD not built yet — next poll
  dial?.wrap.remove();
  dial = build();
  const light = lightRow();
  if (light) dials.insertBefore(dial.wrap, light);
  else dials.appendChild(dial.wrap);
  paint();
}
