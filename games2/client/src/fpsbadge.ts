/** AN ON-SCREEN FRAME METER for a phone with no devtools. The maintainer tests
 *  in production and can only say "it lags"; this says WHICH lag: a low steady
 *  frame rate (the GPU: the lighting passes) reads as a low fps with a small
 *  worst frame, while stalls (the JS rebuilds) read as a fine fps with a big
 *  worst frame and a hitch count. Off unless asked for — `?fps=1` on the URL
 *  turns it on and remembers (localStorage ml-fps), `?fps=0` turns it off, and
 *  Settings→Dev "fps meter" is the same switch. It reports what the eye sees:
 *  the frames the game RENDERED (pacing.ts hands them over — under a paced
 *  30 the browser still ticks 60 times a second and a meter counting those
 *  would read 60 for a 30; the tag "paced" says the pacer is on), and while
 *  the game loop is asleep (the wiki drawer) the browser's own animation
 *  frames, a steady 60, which is by design. The window is a TRUE ~5 s of
 *  wall clock (walked back over the gaps until 5,000 ms), not a frame count
 *  sized by the long-run rate — that version lagged the very drops it was for
 *  (review, 2026-09-02). Gaps over 2 s are a hidden tab, not a frame. A hitch
 *  is a frame of three vsyncs or more (over 45 ms: 50.0 is exactly three and
 *  straddled the old "over 50", and under a paced 30 it is one missed slot). */
import { paceFrames, pacedNow } from "./pacing";

let live: { el: HTMLElement; stop: boolean } | null = null;

/** Is the meter on screen (the Settings/dev button reads this). */
export function fpsBadgeOn(): boolean {
  return live !== null;
}

/** Take the meter down (the Settings/dev button; `?fps=0` at boot does the
 *  same through localStorage). Idempotent. */
export function unmountFpsBadge(): void {
  if (!live) return;
  live.stop = true;
  live.el.remove();
  live = null;
}

export function mountFpsBadge(): void {
  if (live) return;
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
  const me = { el, stop: false };
  live = me;
  let last = performance.now();
  const gaps: number[] = [];
  let shownAt = last;
  const tick = (now: number) => {
    const gap = now - last;
    last = now;
    if (gap >= 0 && gap < 2000) gaps.push(gap); // the first frame's stamp can predate the mount: not a frame
    if (now - shownAt >= 500) {
      // The game's rendered frames while its loop ticks; the browser's own
      // when it is asleep (no tick for 2 s — the hidden-tab cutoff above; a
      // tighter 500 ms flickered the tag off on the gate harness's 2 fps).
      const pf = paceFrames();
      const src = now - pf.at < 2000 ? pf.gaps : gaps;
      // Walk back until ~5 s of wall clock is covered.
      let sum = 0;
      let i = src.length;
      while (i > 0 && sum < 5000) sum += src[--i];
      const recent = src.slice(i);
      const fps = sum > 0 ? Math.round((1000 * recent.length) / sum) : 0;
      const worst = recent.length ? Math.round(Math.max(...recent)) : 0;
      const hitches = recent.filter((g) => g > 45).length;
      const tag = src === pf.gaps && pacedNow() ? " paced" : "";
      el.textContent = `${fps} fps${tag} · worst ${worst} ms · ${hitches} hitch${hitches === 1 ? "" : "es"}/5s`;
      shownAt = now;
      if (gaps.length > 1200) gaps.splice(0, gaps.length - 600);
    }
    if (!me.stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
