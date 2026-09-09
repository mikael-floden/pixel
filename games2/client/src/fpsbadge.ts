/** AN ON-SCREEN FRAME METER for a phone with no devtools. The maintainer tests
 *  in production and can only say "it lags"; this says WHICH lag: a low steady
 *  frame rate (the GPU: the lighting passes) reads as a low fps with a small
 *  worst frame, while stalls (the JS rebuilds) read as a fine fps with a big
 *  worst frame and a hitch count. Off unless asked for — `?fps=1` on the URL
 *  turns it on and remembers (localStorage ml-fps), `?fps=0` turns it off. It
 *  measures the browser's own animation frames, independent of Phaser, so it
 *  reports what the eye sees — including a steady 60 while the wiki drawer has
 *  the game loop asleep, which is by design. The window is a TRUE ~5 s of
 *  wall clock (walked back over the gaps until 5,000 ms), not a frame count
 *  sized by the long-run rate — that version lagged the very drops it was for
 *  (review, 2026-09-02). Gaps over 2 s are a hidden tab, not a frame. */
export function mountFpsBadge(): void {
  const el = document.createElement("div");
  el.id = "ml-fps";
  el.style.cssText =
    // The game view's own corner, off the HUD, inside the edge-margin law:
    // hud.ts publishes --gv-left / --hud-h in real px.
    "position:fixed;left:calc(var(--gv-left, 0px) + 10px);bottom:calc(var(--hud-h, 0px) + 10px);" +
    "z-index:2147483000;pointer-events:none;" +
    "font:11px/1.3 ui-monospace,Menlo,monospace;color:#cfd3dc;background:rgba(0,0,0,.55);" +
    "padding:3px 6px;border-radius:6px;white-space:nowrap";
  document.body.append(el);
  let last = performance.now();
  const gaps: number[] = [];
  let shownAt = last;
  const tick = (now: number) => {
    const gap = now - last;
    last = now;
    if (gap < 2000) gaps.push(gap);
    if (now - shownAt >= 500) {
      // Walk back until ~5 s of wall clock is covered.
      let sum = 0;
      let i = gaps.length;
      while (i > 0 && sum < 5000) sum += gaps[--i];
      const recent = gaps.slice(i);
      const fps = sum > 0 ? Math.round((1000 * recent.length) / sum) : 0;
      const worst = recent.length ? Math.round(Math.max(...recent)) : 0;
      const hitches = recent.filter((g) => g > 50).length;
      el.textContent = `${fps} fps · worst ${worst} ms · ${hitches} hitch${hitches === 1 ? "" : "es"}/5s`;
      shownAt = now;
      if (gaps.length > 1200) gaps.splice(0, gaps.length - 600);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
