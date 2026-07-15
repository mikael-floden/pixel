import { applyUiZoom } from "./uiscale";

/**
 * Bottom HUD dock — the reserved bottom 20% of the page (index.html keeps
 * #game to the top 80%, so the Phaser viewport never draws under it). Future
 * home of the backpack/inventory; today it holds action BUTTONS, because
 * mobile players have no keyboard for the debug/feature toggles.
 *
 * Geometry note: the dock itself is NOT uiZoom'd — its 20dvh height must
 * match the untouched #game 80dvh split, and CSS zoom would rescale viewport
 * units. Only the inner content row (px-sized) gets the compensating zoom.
 */
export class HudBar {
  private row: HTMLDivElement;

  constructor() {
    injectStyles();
    document.querySelector(".ml-hud")?.remove(); // idempotent across re-joins
    const bar = document.createElement("div");
    bar.className = "ml-hud";
    this.row = document.createElement("div");
    this.row.className = "ml-hudrow";
    bar.appendChild(this.row);
    document.body.appendChild(bar);
    applyUiZoom(this.row); // "Desktop site" must not shrink the buttons
  }

  /** Add an action button; returns it so callers can update the label. */
  button(label: string, onPress: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "ml-hudbtn";
    b.textContent = label;
    b.addEventListener("click", onPress);
    this.row.appendChild(b);
    return b;
  }
}

let injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
  const css = `
  .ml-hud{position:fixed;left:0;right:0;bottom:0;height:20vh;height:20dvh;z-index:4;
    background:#000;border-top:1px solid #1e1e22}
  /* px (not vw) sizes below this line: the row carries a compensating CSS
     zoom (uiscale.ts) and viewport units would double-count under it. */
  .ml-hudrow{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;align-items:flex-start;
    padding:12px 12px 0;font-family:system-ui,sans-serif}
  .ml-hudbtn{padding:10px 16px;border:1px solid #2c2c31;border-radius:10px;cursor:pointer;
    background:#151517;color:#c9c9cf;font-size:14px}
  .ml-hudbtn:hover{background:#1b1b1e}
  .ml-hudbtn:active{background:#211c12;border-color:#ffd678;color:#ffd678}`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}
