/**
 * Screen-to-screen fade transition (maintainer: "all screens should always
 * assume the prev screen faded to 100% black"). The page body is #000, so
 * screens fade in/out over true black; this helper covers the cases where
 * the current screen can't fade itself — e.g. logout, where the whole page
 * (game canvas + HUD) must go black before the reload.
 */
export function fadeToBlack(done: () => void, ms = 380) {
  const v = document.createElement("div");
  v.style.cssText =
    "position:fixed;inset:0;z-index:200;background:#000;opacity:0;" +
    `transition:opacity ${ms}ms ease`; // also swallows input while fading
  document.body.appendChild(v);
  let fired = false;
  const fin = () => {
    if (fired) return;
    fired = true;
    done();
  };
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      v.style.opacity = "1";
    }),
  );
  v.addEventListener("transitionend", fin, { once: true });
  setTimeout(fin, ms + 300); // backgrounded tabs: transitions may not run
}
