// THE RECORD BUTTON — his own PixelLab two-state button, parked under the
// HP/EP card (maintainer 2026-09-18: "I want this button under the HP/EP card.
// Also right aligned with the same distance/linespace to the screen and top
// (the HP card). If you press the button it should change state to
// red/recording. Once this button works I will tell you what functionality we
// will bind to this button").
//
// IT IS ANCHORED IN CSS OFF THE SAME VARS THE CARD USES, and only its WIDTH is
// measured. The house pattern (the update toast, the clock pill, the Wiki row
// all do this): left is the card's own `--gv-left + 10`, top is that plus the
// published `--bars-l-h` and the gap. Width is the one thing bars.ts publishes
// no var for, so a ResizeObserver on `.ml-bars-l` copies it — and since the row
// is a flex box ending at that width, the button is RIGHT-ALIGNED with the card
// whatever either of them is wide. GAP is the project's one 10px edge margin,
// the same distance the card itself keeps to the top, which is what he asked.
//
// READING THE CARD'S RECT FOR left/top WAS WRONG AND THE ROTATION PROVED IT:
// `.ml-bars` TRANSITIONS left over .3s, so a placement sampled on the flip took
// the card's new WIDTH and its old LEFT — measured at 851x393, the button sat
// at left 10 with the card already heading for 335. Off the same var it
// animates with the card instead of chasing it.
//
// TWO FACES, BOTH IN THE DOM. The pressed/recording face is a second <img>
// that is merely hidden, never a `src` swap: the first swap of an unloaded
// image is a blank frame, and this button's whole job is to show its state
// the instant it is pressed.
//
// ADMIN ONLY (maintainer 2026-09-18: "I want only the logged in admin to see
// this button"). It mounts HIDDEN and is revealed only once the SERVER has
// answered that this session is the admin (admin.ts -> /api/wiki/me) — hidden
// first, shown on the answer, so it can never flash for a player on a slow
// reply. The answer is cached for the page's lifetime like the dev-world
// picker's, so logging into the wiki in THIS tab shows the button on the next
// reload.
//
// bars.ts IS NOT TOUCHED. It publishes --bars-l-h (its height) but no width,
// and rather than add a publish to a file the ownership list does not name,
// this module measures the element it is anchored to. One observer more.
import { withV } from "./assetver";
import { forgetAdmin, isAdmin } from "./admin";

const WRAP = "ml-recwrap";
const BTN = "ml-rec";
const CSS_ID = "ml-recbtn-css";
/** The project's one edge margin — and the card's own distance to the top. */
const GAP = 10;

let wrap: HTMLElement | null = null;
let btn: HTMLButtonElement | null = null;
let recording = false;

const card = () => document.querySelector<HTMLElement>(".ml-bars-l");

function styleOnce() {
  if (document.getElementById(CSS_ID)) return;
  const st = document.createElement("style");
  st.id = CSS_ID;
  // z 8 is the chips' own layer — this button belongs to that group. The WRAP
  // takes no pointer events (it is a placement box spanning the card's width,
  // and a transparent strip that ate taps over the world would be a bug you
  // only find by trying to walk there); the button takes its own.
  st.textContent = `
  .${WRAP}{position:fixed;z-index:8;display:flex;justify-content:flex-end;
    pointer-events:none;
    /* the card's own anchor (bars.ts .ml-bars/.ml-bars-l) + its published
       height + the gap — and the SAME transition, so the two move together
       through the landscape flip instead of one chasing the other */
    left:calc(var(--gv-left,0px) + ${GAP}px);
    top:calc(${GAP}px + var(--ml-safe-top, 0px) + var(--bars-l-h, 78px) + ${GAP}px);
    transition:left .3s ease}
  /* hidden until the server says admin — never the other way round */
  .${WRAP}[hidden]{display:none}
  .${BTN}{pointer-events:auto;display:block;position:relative;padding:0;border:0;background:none;
    cursor:pointer;line-height:0;-webkit-tap-highlight-color:transparent;
    user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
  /* His art IS the button — a plate with screws and a lamp — so it wears no
     surface, border or shadow of ours; chrome around it would be a second
     button drawn behind his. */
  .${BTN} img{display:block;image-rendering:pixelated;-webkit-user-drag:none}
  .${BTN} .${BTN}-on{position:absolute;left:0;top:0}
  .${BTN}:not(.on) .${BTN}-on{visibility:hidden}
  .${BTN}.on .${BTN}-off{visibility:hidden}
  .${BTN}.press{transform:translateY(1px)}`;
  document.head.appendChild(st);
}

/** Copy the card's WIDTH — the only part of the anchor that is not a var, and
 *  it is what makes the button's right edge the card's. left/top are CSS. */
function place() {
  const c = card();
  if (!wrap || !c) return;
  const w = c.getBoundingClientRect().width;
  if (!w) return; // not laid out yet — the observer calls back
  wrap.style.width = `${Math.round(w)}px`;
}

/** The two faces, at their authored grid: the bakes are an exact 2x of his
 *  48x48 exports, so naturalWidth/2 renders them at 48 css px — the one /ui2
 *  rule the tab and corner icons already follow (UI_AGENT.md). */
function face(cls: string, src: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = cls;
  img.src = withV(src);
  img.alt = "";
  img.draggable = false;
  const fit = () => {
    if (!img.naturalWidth) return;
    img.style.width = `${img.naturalWidth / 2}px`;
    img.style.height = `${img.naturalHeight / 2}px`;
  };
  img.addEventListener("load", fit);
  fit();
  return img;
}

/** Whether the button is in its recording state. */
export const isRecording = (): boolean => recording;

/** Set the state and paint it. Fires "ml-record" (detail: {on}) so whatever is
 *  bound to this button later listens instead of reaching in here. */
export function setRecording(on: boolean): void {
  recording = on;
  btn?.classList.toggle("on", on);
  btn?.setAttribute("aria-pressed", String(on));
  btn?.setAttribute("title", on ? "Recording — tap to stop" : "Record");
  window.dispatchEvent(new CustomEvent("ml-record", { detail: { on } }));
}

/** Ask the server again whether this session is the admin, and show or hide
 *  the button on the answer. The mounted element stays in the DOM either way
 *  (hidden, so a player never sees it); `force` drops the cached answer, which
 *  is what a fresh wiki login in this tab would want. */
export async function applyAdmin(force = false): Promise<boolean> {
  if (force) forgetAdmin();
  const mine = wrap;
  const yes = await isAdmin();
  if (mine !== wrap || !wrap) return yes; // a HUD rebuild replaced it while we asked
  wrap.hidden = !yes;
  if (yes) place();
  return yes;
}

/** Mount the button under the HP/EP card. Idempotent: a HUD rebuild (rejoin)
 *  throws its own chrome away and mounts again, so strays are cleared first —
 *  the pattern every injected surface here follows. */
export function mountRecordButton(): void {
  document.querySelectorAll(`.${WRAP}`).forEach((e) => e.remove());
  styleOnce();
  wrap = document.createElement("div");
  wrap.className = WRAP;
  wrap.hidden = true;
  btn = document.createElement("button");
  btn.className = BTN;
  btn.type = "button";
  btn.append(face(`${BTN}-off`, "/ui2/icon-record.webp"), face(`${BTN}-on`, "/ui2/icon-record-on.webp"));
  // CSS :active is hover-only on mobile — the corner buttons' own press look.
  btn.addEventListener("pointerdown", () => btn?.classList.add("press"));
  for (const ev of ["pointerup", "pointercancel", "pointerleave"])
    btn.addEventListener(ev, () => btn?.classList.remove("press"));
  btn.addEventListener("click", () => setRecording(!recording));
  wrap.appendChild(btn);
  document.body.appendChild(wrap);
  setRecording(recording); // carry the state across a HUD rebuild
  place();
  void applyAdmin(); // …and reveal it only for the admin
  const c = card();
  if (c && "ResizeObserver" in window) new ResizeObserver(place).observe(c);
  // the orientation/handedness flip moves the card without resizing it
  window.addEventListener("ml-layout", place);
  window.addEventListener("ml-hand", place);
  window.addEventListener("resize", place);
}

// The probe surface this module owns (the __mlAmbient / __mlMapLayers pattern).
(window as unknown as { __mlRecord?: unknown }).__mlRecord = {
  on: isRecording,
  set: setRecording,
  el: () => btn,
  /** Re-ask the server whether this session is the admin (see applyAdmin). */
  refresh: (force = true) => applyAdmin(force),
  shown: () => !!wrap && !wrap.hidden,
};
