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
 */

let overlay: HTMLElement | null = null;
let bar: HTMLElement | null = null;
let label: HTMLElement | null = null;
let failsafe: ReturnType<typeof setTimeout> | null = null;

// The LOADING banner's interior within logo-load.png (percent of image box).
const FILL_RECT = { left: 33.82, top: 87.26, width: 28.87, height: 3.62 };

export function showLoading(text = "Entering Nangijala…") {
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
      <div class="ml-load-label" id="ml-load-label"></div>
      <div class="ml-load-tip">Tip: tap the ground to walk there · double-tap to run</div>
    </div>`;
  document.body.appendChild(overlay);
  bar = overlay.querySelector("#ml-load-bar");
  label = overlay.querySelector("#ml-load-label");
  setLoadingProgress(0.03, text); // a visible sliver right away — it's alive
  // Failsafe: never trap the player behind the overlay (slow nets still get
  // the world once it arrives; the overlay is cosmetic).
  failsafe = setTimeout(hideLoading, 60_000);
}

export function setLoadingProgress(frac: number, text?: string) {
  if (bar) bar.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
  if (text && label) label.textContent = text;
}

export function hideLoading() {
  if (failsafe) clearTimeout(failsafe);
  failsafe = null;
  overlay?.remove();
  overlay = null;
  bar = null;
  label = null;
}

export function loadingVisible(): boolean {
  return !!overlay;
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
  #ml-loading{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(circle at 50% 30%, #1c2540, #0c0c16);font-family:system-ui,sans-serif;color:#e8e8f0}
  .ml-load-box{display:flex;flex-direction:column;align-items:center;gap:14px;padding:24px;text-align:center}
  .ml-load-logoWrap{position:relative;width:min(400px,84vw)}
  .ml-load-logo{position:relative;display:block;width:100%;z-index:1;user-select:none;-webkit-user-drag:none}
  /* The progress fill sits BEHIND the logo and shows through the punched-out
     banner interior; the gradient echoes the NANGIJALA lettering (icy cyan →
     blue → purple), with a soft shimmer while it fills. */
  .ml-load-track{position:absolute;z-index:0;overflow:hidden;
    left:${FILL_RECT.left}%;top:${FILL_RECT.top}%;width:${FILL_RECT.width}%;height:${FILL_RECT.height}%}
  .ml-load-bar{width:0%;height:100%;transition:width .25s ease;
    background:
      repeating-linear-gradient(90deg, rgba(255,255,255,.10) 0 2px, transparent 2px 6px),
      linear-gradient(180deg, #d8f2ff 0%, #8fd0f8 25%, #5a7bd6 50%, #9a63e0 75%, #6a3fae 100%);
    animation:mlglow 1.6s ease-in-out infinite}
  .ml-load-label{font-size:13px;color:#9aa0bf;min-height:1.2em}
  .ml-load-tip{font-size:12px;color:#666d92;margin-top:6px}
  @keyframes mlglow{0%,100%{filter:brightness(1)}50%{filter:brightness(1.35)}}`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}
