// ONE INJECTED SETTINGS DIAL, the fourth time this shape was needed in a day —
// navbias.ts, playerspeed.ts and stickdir.ts each carry their own copy of this
// widget, and a fourth copy is where a fix stops reaching all of them. New
// dials use this; the three older ones can move over when they are next
// touched (one writer per file, and none of them is broken).
//
// The pattern itself is the maintainer's (2026-09-10, on every slider since):
// find the Settings page, add to it, re-add when the HudBar has thrown
// everything away on a rejoin, wear the HUD's OWN slider classes so it is the
// same widget to look at, and carry the "default" button. games-ui owns
// hud.ts; this touches nothing of theirs.

export interface DialSpec {
  /** localStorage key. */
  key: string;
  min: number;
  max: number;
  def: number;
  /** Decimals the slider quantises to. */
  decimals: number;
  label: string;
  /** Readout for a value. */
  text: (v: number) => string;
  /** Tooltip of the "default" button. */
  resetTitle?: string;
}

export interface DialHandle {
  get(): number;
  set(v: number): void;
  /** Idempotent: keep one live copy on the Settings page (poll it). */
  ensure(): void;
}

export function makeDial(sp: DialSpec, onChange?: (v: number) => void): DialHandle {
  const clamp = (v: number) => Math.max(sp.min, Math.min(sp.max, v));
  const read = (): number => {
    try {
      const raw = localStorage.getItem(sp.key);
      if (raw === null) return sp.def;
      const v = Number(raw);
      return Number.isFinite(v) ? clamp(v) : sp.def;
    } catch {
      return sp.def; // private mode / storage disabled
    }
  };
  let value = read();
  const m = Math.pow(10, sp.decimals);
  const fromSlider = (p: number) => Math.round((sp.min + p * (sp.max - sp.min)) * m) / m;
  const toSlider = (v: number) => (clamp(v) - sp.min) / (sp.max - sp.min);

  let ui: { wrap: HTMLElement; fill: HTMLElement; knob: HTMLElement; valEl: HTMLElement; track: HTMLElement; reset: HTMLButtonElement } | null = null;

  const paint = () => {
    if (!ui) return;
    const p = toSlider(value);
    ui.fill.style.width = `${(p * 100).toFixed(2)}%`;
    const tw = ui.track.clientWidth;
    const kw = ui.knob.offsetWidth || 22;
    ui.knob.style.left = `${Math.round(Math.max(0, Math.min(tw - kw, p * tw - kw / 2)))}px`;
    ui.valEl.textContent = sp.text(value);
    ui.reset.disabled = Math.abs(value - sp.def) < 1e-9;
  };

  const set = (v: number) => {
    const next = clamp(Number.isFinite(v) ? v : sp.def);
    if (next === value) return;
    value = next;
    try {
      localStorage.setItem(sp.key, String(next));
    } catch {}
    window.dispatchEvent(new Event(sp.key));
    onChange?.(next);
    paint();
  };

  const build = (host: HTMLElement) => {
    const mk = (tag: string, cls: string) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      return e as HTMLElement;
    };
    const wrap = mk("div", "ml-amb-slider ml-dial");
    const head = mk("div", "ml-amb-slider-head");
    const label = mk("span", "ml-amb-slider-label");
    label.textContent = sp.label;
    const valEl = mk("span", "ml-amb-slider-val");
    head.append(label, valEl);
    // The HUD's OWN row, by class: .ml-slider-row puts the "default" button in
    // the gutter to the RIGHT of the track. No private copy of that CSS —
    // hud.ts owns the recipe (navbias.ts paid for a private copy once).
    const row = mk("div", "ml-slider-row");
    const reset = mk("button", "ml-slider-def") as HTMLButtonElement;
    reset.type = "button";
    reset.textContent = "default";
    reset.title = sp.resetTitle ?? "back to the default";
    reset.addEventListener("click", () => set(sp.def));
    const track = mk("div", "ml-slider");
    const fill = mk("div", "ml-slider-fill");
    const knob = mk("div", "ml-slider-knob");
    track.append(fill, knob);
    row.append(track, reset);
    wrap.append(head, row);
    host.appendChild(wrap);
    ui = { wrap, fill, knob, valEl, track, reset };
    const pAt = (clientX: number) => {
      const r = track.getBoundingClientRect();
      return r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : toSlider(value);
    };
    let dragging = false;
    track.addEventListener("pointerdown", (e) => {
      dragging = true;
      track.setPointerCapture(e.pointerId);
      set(fromSlider(pAt(e.clientX)));
      e.preventDefault();
    });
    track.addEventListener("pointermove", (e) => {
      if (dragging) set(fromSlider(pAt(e.clientX)));
    });
    const up = (e: PointerEvent) => {
      dragging = false;
      try {
        track.releasePointerCapture(e.pointerId);
      } catch {}
    };
    track.addEventListener("pointerup", up);
    track.addEventListener("pointercancel", up);
    new ResizeObserver(() => paint()).observe(track);
    paint();
  };

  return {
    get: () => value,
    set,
    ensure: () => {
      if (ui?.wrap.isConnected) return;
      const host = document.querySelector<HTMLElement>('.ml-page[data-page="settings"] .ml-set');
      if (!host) return; // HUD not built yet — try again next poll
      ui?.wrap.remove();
      build(host);
    },
  };
}
