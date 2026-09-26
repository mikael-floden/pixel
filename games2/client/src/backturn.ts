// BACK TURNS THE WORLD (maintainer 2026-09-26: "Can you catch the browser
// 'back'? So a back will rotate instead?" … "Can you see the difference between
// swiping from left inwards or from right inwards? So we can rotate both
// directions?" … "Try to implement it instead! And we will see if it works").
//
// HOW: while the world is up, ONE history entry is held above the game. A back
// (Android's button, or the edge swipe) pops it; this turns the view a quarter
// and holds a fresh entry again on the player's next tap.
//  - WHICH WAY. The back event carries no position, so the only clue is the
//    touch the swipe started with: a touch-down within EDGE_PX of an edge and
//    EDGE_MS before the back. From the LEFT edge (the finger travels right) is
//    the right arrow; from the RIGHT edge the left arrow. When the page never
//    saw that touch — Android's gesture navigation can take an edge swipe
//    before the page gets it — back turns the DEFAULT way. The note below says
//    which happened, because that is the thing we are finding out on his phone.
//  - THE TURN IS THE ARROW BUTTON'S CLICK (spinbar.ts): the one path the cube
//    and the world (WorldScene's listener) both already take.
//  - A TAP BEFORE EACH ENTRY. Chrome skips history entries added without a user
//    activation, so the entry is (re)pushed on a pointerdown, never from the
//    popstate itself — a player taps constantly, and until the first tap back
//    still leaves the page, which is the honest fallback.
//  - THE WIKI DRAWER WINS: it pushes its own entry above this one
//    (wikipanel.ts), so a back while it is open closes the drawer and lands ON
//    this entry — recognised by its state and left alone.
//  - ONLY IN THE WORLD (`ml-ingame`): on the select screen back leaves as ever.
//  - THE GAME HOLDS STILL THROUGH THE SWIPE (maintainer 2026-09-26: "The screen
//    jumps a lot, laggy and rerendering… As if something tries to calculate a
//    new resolution"). Android's back preview shrinks the window while the
//    finger moves and springs it back after; every resize re-ran the HUD
//    layout and reallocated the canvas twice per back. From an edge touch-down
//    until SETTLE_MS after the back (or the finger lifting, or HOLD_MAX_MS),
//    window/visualViewport resize events are stopped at the target (a capture
//    listener runs before every bubble listener there) and the page and
//    #game are pinned at their px size, so nothing lays out or re-renders; one
//    resize is replayed at the end only if the size really changed. The OS's
//    own animation (the card shrink, the white status bar) is drawn outside
//    the page and cannot be stopped from here.

const EDGE_PX = 48;
const EDGE_MS = 1500;
const NOTE_MS = 6000;
/** Hold after the back fires: Android's preview springs back to full size. */
const SETTLE_MS = 600;
/** A gesture Android took and then abandoned never tells the page: give up. */
const HOLD_MAX_MS = 2500;
/** Which arrow a back with no visible edge presses. */
const DEFAULT_DIR: "left" | "right" = "right";

let mounted = false;

export function mountBackTurn(): void {
  if (mounted) return;
  mounted = true; // the HUD rebuilds on a rejoin; these listeners are the page's
  let armed = false;
  let lastDown: { x: number; t: number } | null = null;
  const inWorld = () => document.documentElement.classList.contains("ml-ingame");
  // --- the size hold ---
  let held: { w: number; h: number; undo: Array<() => void> } | null = null;
  let holdTimer = 0;
  const pin = (el: HTMLElement | null, w: number, h: number, undo: Array<() => void>) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const was = [el.style.width, el.style.height];
    el.style.width = `${r.width || w}px`;
    el.style.height = `${r.height || h}px`;
    undo.push(() => { el.style.width = was[0]; el.style.height = was[1]; });
  };
  const hold = () => {
    clearTimeout(holdTimer);
    holdTimer = window.setTimeout(release, HOLD_MAX_MS);
    if (held) return;
    tape = [size()];
    tapeT0 = performance.now();
    tapeUntil = tapeT0 + 8000;
    noteBase = "";
    const w = window.innerWidth, h = window.innerHeight;
    const undo: Array<() => void> = [];
    pin(document.documentElement, w, h, undo);
    pin(document.body, w, h, undo);
    pin(document.getElementById("game"), w, h, undo);
    held = { w, h, undo };
  };
  function release() {
    clearTimeout(holdTimer);
    if (!held) return;
    const { w, h, undo } = held;
    held = null;
    for (const u of undo) u();
    if (window.innerWidth !== w || window.innerHeight !== h) window.dispatchEvent(new Event("resize"));
  }
  // SIZE TAPE (diagnostic, 2026-09-26: the layout still jumped on his phone
  // with the hold live): every window size seen from the edge touch-down to
  // TAPE_MS later, marked held (swallowed) or LIVE (reached the game), shown
  // under the note so his screenshot says what the window did.
  let tape: string[] = [];
  let tapeT0 = 0;
  let tapeUntil = 0;
  let noteBase = "";
  const size = () => `${window.innerWidth}×${window.innerHeight}`;
  const swallow = (e: Event) => {
    const now = performance.now();
    if (e.type === "resize" && e.currentTarget === window && now < tapeUntil) {
      const s = size();
      if (!tape[tape.length - 1]?.startsWith(s + " ") && tape[tape.length - 1] !== s) {
        tape.push(`${s} ${held ? "held" : "LIVE"} +${((now - tapeT0) / 1000).toFixed(1)}s`);
        if (noteBase) note(noteBase);
      }
    }
    if (held) e.stopImmediatePropagation();
  };
  window.addEventListener("resize", swallow, { capture: true });
  window.visualViewport?.addEventListener("resize", swallow, { capture: true });
  window.visualViewport?.addEventListener("scroll", swallow, { capture: true });
  const releaseSoon = () => { clearTimeout(holdTimer); holdTimer = window.setTimeout(release, SETTLE_MS); };
  document.addEventListener("pointerup", () => { if (held) releaseSoon(); }, { capture: true, passive: true });

  const arm = () => {
    if (armed || !inWorld() || document.querySelector(".ml-wikiroot")) return;
    armed = true;
    history.pushState({ mlTurn: true }, "");
  };
  document.addEventListener(
    "pointerdown",
    (e) => {
      lastDown = { x: e.clientX, t: e.timeStamp };
      if (inWorld() && (e.clientX <= EDGE_PX || window.innerWidth - e.clientX <= EDGE_PX)) hold();
      arm(); // a tap is the user activation Chrome requires
    },
    { capture: true, passive: true },
  );
  let noteTimer = 0;
  const note = (text: string) => {
    let el = document.getElementById("ml-backturn");
    if (!el) {
      el = document.createElement("div");
      el.id = "ml-backturn";
      el.style.cssText =
        "position:fixed;left:50%;transform:translateX(-50%);top:calc(var(--ml-safe-top,0px) + 10px);z-index:9999;" +
        "padding:6px 10px;border-radius:7px;border:1px solid var(--border-strong);" +
        "background:var(--surface);color:var(--ink);font:600 13px/1.3 system-ui,sans-serif;" +
        "box-shadow:var(--shadow);pointer-events:none;white-space:pre-line;text-align:center;transition:opacity .25s";
      document.body.appendChild(el);
    }
    el.textContent = tape.length ? `${text}\n${tape.join(" → ")}` : text;
    el.style.opacity = "1";
    clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => el && (el.style.opacity = "0"), NOTE_MS);
  };
  window.addEventListener("popstate", (e) => {
    if ((e.state as { mlTurn?: boolean } | null)?.mlTurn) return; // the wiki drawer closed onto us
    if (held) releaseSoon();
    if (!armed) return;
    armed = false;
    if (!inWorld()) return;
    const now = performance.now();
    const d = lastDown && now - lastDown.t <= EDGE_MS ? lastDown : null;
    const w = window.innerWidth;
    const edge = d ? (d.x <= EDGE_PX ? "left" : w - d.x <= EDGE_PX ? "right" : null) : null;
    const dir: "left" | "right" = edge === "left" ? "right" : edge === "right" ? "left" : DEFAULT_DIR;
    document.querySelector<HTMLElement>(`.ml-spinbtn.${dir}`)?.click();
    noteBase = edge ? `Back from the ${edge.toUpperCase()} edge → turned ${dir}` : `Back (edge not seen) → turned ${dir}`;
    note(noteBase);
  });
}
