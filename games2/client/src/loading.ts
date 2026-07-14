/**
 * Full-screen loading overlay shown between "Enter world" and the first frame
 * of the world. On phones the world JSON + character strips take several
 * seconds; without this the select screen just vanishes into a black page.
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
      <div class="ml-load-spinner"></div>
      <h1 class="ml-load-title">Nangijala</h1>
      <div class="ml-load-barwrap"><div class="ml-load-bar" id="ml-load-bar"></div></div>
      <div class="ml-load-label" id="ml-load-label"></div>
      <div class="ml-load-tip">Tip: tap the ground to walk there · double-tap to run</div>
    </div>`;
  document.body.appendChild(overlay);
  bar = overlay.querySelector("#ml-load-bar");
  label = overlay.querySelector("#ml-load-label");
  setLoadingProgress(0, text);
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
  .ml-load-title{margin:0;font-size:36px;letter-spacing:2px;color:#cfe0ff}
  .ml-load-spinner{width:42px;height:42px;border-radius:50%;border:4px solid #2a2a44;border-top-color:#ffd678;
    animation:mlspin 0.9s linear infinite}
  .ml-load-barwrap{width:min(320px,70vw);height:8px;border-radius:4px;background:#1e1e30;overflow:hidden}
  .ml-load-bar{width:0%;height:100%;border-radius:4px;background:#5a7bd6;transition:width .25s ease}
  .ml-load-label{font-size:13px;color:#9aa0bf;min-height:1.2em}
  .ml-load-tip{font-size:12px;color:#666d92;margin-top:10px}
  @keyframes mlspin{to{transform:rotate(360deg)}}`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}
