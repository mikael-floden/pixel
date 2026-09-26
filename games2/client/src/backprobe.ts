// THE BACK-EDGE PROBE — a measurement, not a feature (maintainer 2026-09-26:
// "Can you see the difference between swiping from left inwards or from right
// inwards? So we can rotate both directions?"). The browser's back event
// carries no position, so the only possible answer is the TOUCH that preceded
// it — and whether a page ever sees that touch depends on the phone: Android's
// gesture navigation can take an edge swipe before the page gets it. So this
// asks HIS phone instead of guessing.
//
// ONLY WITH ?backprobe=1 in the URL. Without it nothing here runs, and back
// behaves exactly as before. With it: after the first tap (Chrome skips history
// entries added without one), one history entry is held; when back pops it, a
// note at the top of the screen says where the last touch STARTED (distance
// from the left and right edges), how long before the back it was, and whether
// the browser cancelled it — then the entry is re-armed on the next tap.
// Coexists with the Wiki drawer's own back entry (wikipanel.ts): a pop that
// lands ON this probe's entry is the drawer closing, and is left alone.

type Touch = { x: number; t: number; kind: string };

let mounted = false;

export function mountBackProbe(): void {
  if (mounted || !/[?&]backprobe=1\b/.test(location.search)) return;
  mounted = true; // the HUD rebuilds on a rejoin; the listeners are the page's
  const log: Touch[] = [];
  let armed = false;
  const note = (text: string) => {
    let el = document.getElementById("ml-backprobe");
    if (!el) {
      el = document.createElement("div");
      el.id = "ml-backprobe";
      el.style.cssText =
        "position:fixed;left:10px;right:10px;top:calc(var(--ml-safe-top,0px) + 10px);z-index:9999;" +
        "padding:10px 12px;border-radius:7px;border:1px solid var(--border-strong);" +
        "background:var(--surface);color:var(--ink);font:600 14px/1.35 system-ui,sans-serif;" +
        "box-shadow:var(--shadow);white-space:pre-line;pointer-events:none";
      document.body.appendChild(el);
    }
    el.textContent = text;
  };
  const arm = () => {
    if (armed) return;
    armed = true;
    history.pushState({ mlBackProbe: true }, "");
  };
  const rec = (kind: string) => (e: PointerEvent) => {
    log.push({ x: e.clientX, t: e.timeStamp, kind });
    if (log.length > 12) log.shift();
    if (kind === "down") arm(); // a tap is the user activation Chrome wants
  };
  document.addEventListener("pointerdown", rec("down"), { capture: true, passive: true });
  document.addEventListener("pointercancel", rec("cancel"), { capture: true, passive: true });
  window.addEventListener("popstate", (e) => {
    if ((e.state as { mlBackProbe?: boolean } | null)?.mlBackProbe) return; // the drawer closed onto us
    if (!armed) return;
    armed = false;
    const now = performance.now();
    const downs = log.filter((l) => l.kind === "down");
    const last = downs[downs.length - 1];
    const cancelled = log.some((l) => l.kind === "cancel" && last && l.t >= last.t);
    const w = window.innerWidth;
    if (!last || now - last.t > 10000) {
      note(`BACK caught — no touch seen in the 10 s before it.\nThe page cannot tell left from right on this phone.\n(tap anything to re-arm)`);
    } else {
      const fromL = Math.round(last.x);
      const fromR = Math.round(w - last.x);
      const side = fromL <= fromR ? `LEFT edge (${fromL}px in)` : `RIGHT edge (${fromR}px in)`;
      note(
        `BACK caught — last touch started at the ${side}\n` +
          `${Math.round(now - last.t)} ms before the back${cancelled ? ", then CANCELLED by the browser" : ""}.\n` +
          `(tap anything to re-arm)`,
      );
    }
  });
  note("BACK PROBE on — tap once, then swipe back from the LEFT edge, then from the RIGHT.");
}
