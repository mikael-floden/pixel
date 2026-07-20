/**
 * Full-screen loading overlay shown between "Enter world" and the first frame
 * of the world. On phones the world JSON + character strips take several
 * seconds; without this the select screen just vanishes into a black page.
 *
 * The artwork (public/logo-load.png) is the maintainer's logo with a built-in
 * "LOADING" banner: the banner's navy interior is punched to transparency in
 * the PNG, and a gradient styled like the NANGIJALA lettering slides in
 * BEHIND it as the real progress bar (FILL_RECT below is the banner interior
 * measured as percentages of the image — re-measure if the logo art changes).
 *
 * Lifecycle: select.ts shows it when the player commits; WorldScene.preload
 * feeds asset progress into it; it's hidden when the player's own avatar
 * joins (addAvatar) or a connection error is shown. A hard timeout makes sure
 * a stuck load can never trap the player behind an opaque overlay.
 *
 * Hiding is a STAGED CINEMA FADE (maintainer: "this makes the game not load
 * like a website"): the logo fades away first so the screen is 100% black,
 * the world keeps rendering under the black DOM overlay until it has real
 * frames on screen, and only then does the black itself fade out. The
 * connection-error path uses hideLoading(true) — an error panel must never
 * wait behind a cinematic.
 */

import { applyUiZoom } from "./uiscale";

let overlay: HTMLElement | null = null;
let bar: HTMLElement | null = null;
let failsafe: ReturnType<typeof setTimeout> | null = null;
let hiding = false;

// First-render gates: the black fade-out additionally waits for these
// (the composed page frame, the kit plate art, …). On a FRESH DEPLOY those
// assets come over the network and used to lose the race against the
// frame counter — the black lifted onto a half-drawn border (maintainer:
// "feels buggy/laggy"). Capped in hideLoading so a stuck promise can
// never trap the player behind the black.
const holds: Promise<unknown>[] = [];
export function holdLoading(p: Promise<unknown>) {
  holds.push(p);
}

// The LOADING banner's interior within logo-load.png (percent of image box).
const FILL_RECT = { left: 33.82, top: 87.26, width: 28.87, height: 3.62 };

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Resolve once the logo bitmap is decoded and safe to paint (not merely
// "src assigned"). img.decode() is the reliable signal — it settles only when
// the image is ready to render; we fall back to load/error events (and treat
// a broken image as "ready" so the reveal never hangs on it).
function whenDecoded(img: HTMLImageElement | null): Promise<void> {
  if (!img) return Promise.resolve();
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  if (typeof img.decode === "function") return img.decode().catch(() => {});
  return new Promise((res) => {
    img.addEventListener("load", () => res(), { once: true });
    img.addEventListener("error", () => res(), { once: true });
  });
}

export function showLoading(text = "Entering Nangijala…") {
  if (overlay && hiding) teardown(); // mid-fade re-show (rejoin): start fresh
  if (overlay) {
    setLoadingProgress(0, text);
    return;
  }
  injectStyles();
  overlay = document.createElement("div");
  overlay.id = "ml-loading";
  overlay.innerHTML = `
    <div class="ml-load-box">
      <div class="ml-load-logoWrap">
        <div class="ml-load-track"><div class="ml-load-bar" id="ml-load-bar"></div></div>
        <img class="ml-load-logo" src="/logo-load.png" alt="Nangijala Online — loading" />
      </div>
    </div>`;
  document.body.appendChild(overlay);
  applyUiZoom(overlay); // "Desktop site" must not shrink the loading logo
  bar = overlay.querySelector("#ml-load-bar");
  // STAGED ENTRANCE (mirror of the staged exit): first the black overlay
  // fades in over whatever screen is up (the select screen "fades out to
  // 100% black"), then the logo emerges out of the black.
  const inBox = overlay.querySelector<HTMLElement>(".ml-load-box");
  const logoImg = overlay.querySelector<HTMLImageElement>(".ml-load-logo");
  overlay.style.opacity = "0";
  if (inBox) inBox.style.opacity = "0";
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!overlay) return;
      overlay.style.transition = "opacity .4s ease";
      overlay.style.opacity = "1";
    }),
  );
  // The logo only emerges once it's actually DECODED. On a FRESH DEPLOY the
  // logo PNG is re-fetched over the network, and the old fixed 430ms timer
  // fired the fade-in whether or not the bitmap had arrived — so the logo
  // painted IN during the fade, the exact "page is 50% loaded" flash the
  // black fade exists to hide (maintainer). Still gated behind the ~430ms
  // black-in so the staging order holds, and capped (4s) so a stuck/broken
  // image can never trap the reveal behind the black.
  Promise.all([delay(430), Promise.race([whenDecoded(logoImg), delay(4000)])]).then(() => {
    // hiding may already be underway on ultra-fast loads — never re-show
    if (!overlay || hiding || !inBox) return;
    inBox.style.transition = "opacity .45s ease";
    inBox.style.opacity = "1";
  });
  setLoadingProgress(0.03, text); // a visible sliver right away — it's alive
  // Failsafe: never trap the player behind the overlay (slow nets still get
  // the world once it arrives; the overlay is cosmetic).
  failsafe = setTimeout(hideLoading, 60_000);
}

// `text` is accepted (callers describe their phase) but not shown — the
// screen is just the logo + banner fill for now; a status line / gameplay
// tips may return once the game is further along.
export function setLoadingProgress(frac: number, text?: string) {
  void text;
  if (bar) bar.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
}

export function hideLoading(instant = false) {
  if (failsafe) clearTimeout(failsafe);
  failsafe = null;
  if (!overlay) return;
  if (instant) {
    teardown();
    return;
  }
  if (hiding) return;
  hiding = true;
  // Stage 1: the logo fades away — the screen is 100% black while the world
  // (already running) keeps drawing beneath the DOM overlay.
  const box = overlay.querySelector<HTMLElement>(".ml-load-box");
  if (box) {
    box.style.transition = "opacity .45s ease";
    box.style.opacity = "0";
  }
  // Stage 2: hold the black until the page has really drawn — rAF ticks
  // align with browser paints (Phaser renders on the same loop), so count
  // REAL frames instead of guessing a delay; the time floor also lets the
  // logo fade finish before the black lifts.
  const start = performance.now();
  let frames = 0;
  const fadeOut = () => {
    if (!overlay) return;
    overlay.style.transition = "opacity .8s ease";
    overlay.style.opacity = "0";
    overlay.addEventListener("transitionend", teardown, { once: true });
    // transitions don't run in backgrounded tabs — never trap the player
    setTimeout(teardown, 1600);
  };
  const tick = () => {
    if (!overlay) return;
    frames++;
    if (frames >= 6 && performance.now() - start >= 700) fadeOut();
    else requestAnimationFrame(tick);
  };
  // start counting frames only once every registered first-render gate has
  // settled (5s cap — the black must never trap the player)
  Promise.race([Promise.allSettled(holds), new Promise((r) => setTimeout(r, 5000))]).then(() =>
    requestAnimationFrame(tick),
  );
}

function teardown() {
  overlay?.remove();
  overlay = null;
  bar = null;
  hiding = false;
}

export function loadingVisible(): boolean {
  return !!overlay;
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
  #ml-loading{position:fixed;inset:0;z-index:20;
    background:#000;font-family:system-ui,sans-serif;color:#e8e8f0}
  /* Centre the logo slightly above dead-centre (45% from the top) — full
     golden-ratio height (38.2%) read as too high on phones. */
  /* No vw/vh here: the overlay may carry a compensating CSS zoom (uiscale.ts)
     and viewport units would double-count under it. */
  .ml-load-box{position:absolute;left:50%;top:45%;transform:translate(-50%,-50%);
    display:flex;flex-direction:column;align-items:center;gap:14px;padding:24px;text-align:center;width:100%}
  /* 2x logo (maintainer 2026-07-18) — the % cap keeps it on-screen on
     narrow phones */
  .ml-load-logoWrap{position:relative;width:min(800px,96%)}
  .ml-load-logo{position:relative;display:block;width:100%;z-index:1;user-select:none;-webkit-user-drag:none}
  /* The progress fill sits BEHIND the logo and shows through the punched-out
     banner interior; the gradient echoes the NANGIJALA lettering (icy cyan →
     blue → purple), with a soft shimmer while it fills. */
  .ml-load-track{position:absolute;z-index:0;overflow:hidden;
    left:${FILL_RECT.left}%;top:${FILL_RECT.top}%;width:${FILL_RECT.width}%;height:${FILL_RECT.height}%}
  .ml-load-bar{width:0%;height:100%;transition:width .25s ease;
    background:
      repeating-linear-gradient(90deg, rgba(255,255,255,.08) 0 2px, transparent 2px 6px),
      linear-gradient(180deg, #a2b6bf 0%, #6b9cba 25%, #435ca0 50%, #734aa8 75%, #4f2f82 100%);
    animation:mlglow 1.6s ease-in-out infinite}
  @keyframes mlglow{0%,100%{filter:brightness(1)}50%{filter:brightness(1.18)}}`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}
