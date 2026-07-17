import { Demo } from "./demo";

// The "ambient" button on the HUD's Settings page. games-ui owns hud.ts, so
// this domain does NOT edit it — the button is injected into the settings
// row from outside, styled with the same .ml-plate-btn plate art and the
// same pressed-plate pointer feedback, and it prints its state like every
// settings button ("ambient: auto" / "ambient: fireflies"). The HudBar
// rebuilds itself on re-joins (it removes and recreates .ml-hud), so
// ensure() is polled from the ambient update loop and quietly re-injects
// whenever the button has been thrown away with the old HUD.
const CLS = "ml-ambient-btn";

export class DemoButton {
  private btn: HTMLButtonElement | null = null;

  constructor(private demo: Demo) {}

  /** Idempotent: keeps exactly one live button in the settings row. */
  ensure() {
    if (this.btn?.isConnected) {
      this.sync();
      return;
    }
    const row = document.querySelector<HTMLElement>('.ml-page[data-page="settings"] .ml-btnrow');
    if (!row) return; // HUD not built yet — try again next poll
    const b = document.createElement("button");
    b.className = `ml-plate-btn ${CLS}`;
    b.textContent = this.text();
    b.addEventListener("click", () => {
      this.demo.next();
      this.sync();
    });
    // Same momentary pressed-plate feedback as hud.ts' pressFx (CSS :active
    // is hover-only on mobile).
    b.addEventListener("pointerdown", () => b.classList.add("press"));
    for (const ev of ["pointerup", "pointercancel", "pointerleave"])
      b.addEventListener(ev, () => b.classList.remove("press"));
    row.appendChild(b);
    this.btn = b;
  }

  /** Keep the printed state fresh (the demo can also move via the QA probe). */
  sync() {
    const t = this.text();
    if (this.btn && this.btn.textContent !== t) this.btn.textContent = t;
  }

  private text() {
    return `ambient: ${this.demo.label()}`;
  }
}
