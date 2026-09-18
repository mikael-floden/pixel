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
// IT IS THE CARD'S FULL WIDTH, AND HIS 48x48 PLATE IS NOT SQUASHED TO GET
// THERE (maintainer 2026-09-18: "I meant also left aligned same as the card" —
// both edges flush, his choice when told a literal scale would distort it).
// The plate is 5-SLICED instead: the left cap with its screws, a plain column
// repeated, the centre with the lamp and the knob, the plain column again, the
// right cap. MEASURED, not eyeballed — column 10 equals column 11 and column
// 35 equals column 36 in BOTH faces, so those two columns are the only ones
// that may be repeated and the seams are exact. Every authored pixel stays at
// 1:1 and only blank plate is added, which is what a wide version of this
// button would look like if he had drawn one.
//
// Painted into a CANVAS rather than composed from background layers: the
// filler is ONE column, and a CSS background cannot repeat a sub-rect of an
// image without a second asset cut from his art. drawImage with
// imageSmoothingEnabled=false is the same nearest-neighbour rule the icons
// follow, and both faces are decoded up front so a press repaints in the same
// frame — no blank first frame from an unloaded image.
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
/** His canvas, and the height the button keeps however wide it gets. */
const ART = 48;
/** The 5 slices, in HIS 48px columns. capL | fill | centre | fill | capR —
 *  `fill` is the single column each side may repeat, which is only sound
 *  because col 10 == col 11 and col 35 == col 36 in BOTH faces (measured;
 *  verify-recbtn re-checks it against the shipped art). */
const SLICE = { capL: 11, fillL: 10, centre0: 11, centre1: 36, fillR: 36 };

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
    cursor:pointer;line-height:0;width:100%;-webkit-tap-highlight-color:transparent;
    user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
  /* His art IS the button — a plate with screws and a lamp — so it wears no
     surface, border or shadow of ours; chrome around it would be a second
     button drawn behind his. */
  .${BTN} canvas{display:block;width:100%;height:${ART}px;image-rendering:pixelated}
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
  paint();
}

/** The two faces. The bakes are an exact 2x of his 48x48 exports, so the
 *  canvas backs at 2x and shows at 48 css px — the one /ui2 rule (UI_AGENT.md).
 *  Both are decoded up front: a press must repaint in the same frame. */
function face(src: string): HTMLImageElement {
  const img = new Image();
  img.src = withV(src);
  img.addEventListener("load", paint);
  return img;
}
let faceOff: HTMLImageElement | null = null;
let faceOn: HTMLImageElement | null = null;
let cv: HTMLCanvasElement | null = null;

/** Draw the current face across the button's width: caps at 1:1, the two plain
 *  columns carrying the extra. Nearest-neighbour, like every other pixel
 *  surface here. A width under the art's own is simply the art. */
function paint() {
  const img = recording ? faceOn : faceOff;
  if (!cv || !img || !img.naturalWidth) return;
  const S = img.naturalWidth / ART; // the bake's scale (2)
  const wCss = Math.max(ART, Math.round(cv.getBoundingClientRect().width) || ART);
  const w = Math.round(wCss * S);
  if (cv.width !== w || cv.height !== ART * S) {
    cv.width = w;
    cv.height = ART * S;
  }
  const g = cv.getContext("2d");
  if (!g) return;
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, cv.width, cv.height);
  const capL = SLICE.capL * S;
  const mid = (SLICE.centre1 - SLICE.centre0) * S;
  const capR = (ART - SLICE.centre1) * S;
  const extra = Math.max(0, w - (capL + mid + capR));
  const left = Math.round(extra / 2);
  const right = extra - left;
  let x = 0;
  g.drawImage(img, 0, 0, capL, cv.height, x, 0, capL, cv.height);
  x += capL;
  if (left) g.drawImage(img, SLICE.fillL * S, 0, S, cv.height, x, 0, left, cv.height);
  x += left;
  g.drawImage(img, SLICE.centre0 * S, 0, mid, cv.height, x, 0, mid, cv.height);
  x += mid;
  if (right) g.drawImage(img, SLICE.fillR * S, 0, S, cv.height, x, 0, right, cv.height);
  x += right;
  g.drawImage(img, SLICE.centre1 * S, 0, capR, cv.height, x, 0, capR, cv.height);
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
  paint();
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
  cv = document.createElement("canvas");
  cv.width = ART * 2;
  cv.height = ART * 2;
  btn.appendChild(cv);
  faceOff = face("/ui2/icon-record.webp");
  faceOn = face("/ui2/icon-record-on.webp");
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
  /** QA: the slice plan, so the gate can re-check it against the shipped art. */
  slices: () => ({ ...SLICE, art: ART }),
  /** Re-ask the server whether this session is the admin (see applyAdmin). */
  refresh: (force = true) => applyAdmin(force),
  shown: () => !!wrap && !wrap.hidden,
};
