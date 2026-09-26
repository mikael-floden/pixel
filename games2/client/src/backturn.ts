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

const EDGE_PX = 48;
const EDGE_MS = 1500;
const NOTE_MS = 1800;
/** Which arrow a back with no visible edge presses. */
const DEFAULT_DIR: "left" | "right" = "right";

let mounted = false;

export function mountBackTurn(): void {
  if (mounted) return;
  mounted = true; // the HUD rebuilds on a rejoin; these listeners are the page's
  let armed = false;
  let lastDown: { x: number; t: number } | null = null;
  const inWorld = () => document.documentElement.classList.contains("ml-ingame");
  const arm = () => {
    if (armed || !inWorld() || document.querySelector(".ml-wikiroot")) return;
    armed = true;
    history.pushState({ mlTurn: true }, "");
  };
  document.addEventListener(
    "pointerdown",
    (e) => {
      lastDown = { x: e.clientX, t: e.timeStamp };
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
        "box-shadow:var(--shadow);pointer-events:none;white-space:nowrap;transition:opacity .25s";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = "1";
    clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => el && (el.style.opacity = "0"), NOTE_MS);
  };
  window.addEventListener("popstate", (e) => {
    if ((e.state as { mlTurn?: boolean } | null)?.mlTurn) return; // the wiki drawer closed onto us
    if (!armed) return;
    armed = false;
    if (!inWorld()) return;
    const now = performance.now();
    const d = lastDown && now - lastDown.t <= EDGE_MS ? lastDown : null;
    const w = window.innerWidth;
    const edge = d ? (d.x <= EDGE_PX ? "left" : w - d.x <= EDGE_PX ? "right" : null) : null;
    const dir: "left" | "right" = edge === "left" ? "right" : edge === "right" ? "left" : DEFAULT_DIR;
    document.querySelector<HTMLElement>(`.ml-spinbtn.${dir}`)?.click();
    note(edge ? `Back from the ${edge.toUpperCase()} edge → turned ${dir}` : `Back (edge not seen) → turned ${dir}`);
  });
}
