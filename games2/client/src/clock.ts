/**
 * Celestial clock — the time-of-day indicator hung top-centre of the game
 * view. Four pre-keyed dials (client/public/ui/clock_<phase>.png, built by
 * scripts/build-clock.mjs from the maintainer's mocks, pixel-aligned to each
 * other) are stacked and cross-faded on the same 2.5s clock as the ambient
 * grade. Order matches WorldScene's TIME_PHASES / shared timeIdx.
 *
 * First pass per the maintainer: full-size art, top centre — sizing and
 * fading polish come later, and the pointer hand will be drawn dynamically
 * in-game (the mocks ship without one).
 */
import { applyUiZoom } from "./uiscale";

const PHASE_FILES = ["night", "morning", "day", "evening"] as const;
const FADE_S = 2.5; // keep in step with WorldScene's TIME_TRANSITION_S

let root: HTMLDivElement | null = null;
let dials: HTMLImageElement[] = [];

function mount() {
  if (root) return;
  const style = document.createElement("style");
  style.textContent = `
  .ml-clock{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:5;
    width:300px;pointer-events:none}
  .ml-clock img{position:absolute;top:0;left:0;width:100%;opacity:0;
    transition:opacity ${FADE_S}s ease}
  .ml-clock img.on{opacity:1}
  .ml-clock.snap img{transition:none}`;
  document.head.appendChild(style);
  root = document.createElement("div");
  root.className = "ml-clock";
  dials = PHASE_FILES.map((p) => {
    const img = document.createElement("img");
    img.src = `/ui/clock_${p}.png`;
    img.alt = "";
    img.draggable = false;
    root!.appendChild(img);
    return img;
  });
  document.body.appendChild(root);
  applyUiZoom(root);
}

/** Show the dial for a TIME_PHASES index (0 Night, 1 Morning, 2 Day,
 * 3 Evening), cross-fading unless `instant` (join snaps straight in). */
export function setClockPhase(idx: number, instant = false) {
  mount();
  if (instant) {
    root!.classList.add("snap");
    root!.offsetWidth; // flush styles so the snap really skips the fade
  }
  dials.forEach((img, i) => img.classList.toggle("on", i === idx % dials.length));
  if (instant) {
    root!.offsetWidth;
    root!.classList.remove("snap");
  }
}
