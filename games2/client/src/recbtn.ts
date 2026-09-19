// THE REPORT BUTTON — his own bug icon and the word "Report", in the Wiki
// button's clothes, parked under the HP/EP card (maintainer 2026-09-19: "I
// want that button to look more like the wiki button. This means it needs a
// 24x24 icon and text instead… the text should be 'Report' and the size and
// style and margin should be like the wiki button"). Press it and the world
// freezes on a lossless frame of itself (freezeframe.ts) — that behaviour is
// untouched by the restyle, because the two were never coupled.
//
// IT IS THE WIKI PILL, DELIBERATELY: 80x32 content box, 1px --border-strong,
// radius 7, --shadow, the same 76%-of-bg translucency over a 5px blur, the
// same 600 12px/.03em label and the same 24px icon at the /ui2 rule
// (naturalWidth/2). Those declarations are WRITTEN OUT here rather than shared
// with wikibtn.ts — the two modules are about different things and a shared
// pill class would couple them — so `verify-recbtn` compares this button's
// COMPUTED style against the live .ml-wikibtn instead: restyle the Wiki button
// and this fails until it follows. That check is the thing keeping the promise,
// not this comment.
//
// THE MARGIN IS THE SAME 10px, mirrored: the Wiki pill is 10px from the game
// view's right edge, this one 10px from its left, both off the --gv-* vars, so
// the pair sit at equal insets on their own sides.
//
// RETIRED with the restyle: his 48x48 two-face plate (icon-record /
// icon-record-on), the lamp that lit when recording, the 5-slice widening, and
// the ResizeObserver that copied the HP/EP card's width — a fixed-width pill
// needs none of it. The bakes stay on disk because they are his art and
// bake-corner-icons.py proves every entry it lists; nothing references them.
//
// THE RECORDING STATE IS THE HOUSE "ON" TREATMENT — --accent-soft on --accent
// with --accent-ink — because that is what every other button here does when
// it is active, and the accent IS the red he asked for ("if you press the
// button it should change state to red/recording", 2026-09-18). A second face
// of art would have been a second thing to keep in sync for no more meaning.
//
// ANCHORED IN CSS OFF THE CARD'S OWN VARS, never its measured rect: .ml-bars
// transitions `left` over .3s, so a placement sampled during the landscape flip
// takes the card's new width with its old left — measured at 851x393, the
// button sat at 10 with the card already heading for 335.
//
// ADMIN ONLY (maintainer 2026-09-18: "I want only the logged in admin to see
// this button"). It mounts HIDDEN and is revealed only once the SERVER has
// answered (admin.ts -> /api/wiki/me), so it can never flash for a player on a
// slow reply.
import { withV } from "./assetver";
import { forgetAdmin, isAdmin } from "./admin";

const BTN = "ml-rec";
const CSS_ID = "ml-recbtn-css";
/** The project's one edge margin — and the card's own distance to the top. */
const GAP = 10;
/** The Wiki pill's box (wikibtn.ts PILL_W/PILL_H), which this one wears. */
const PILL_W = 80;
const PILL_H = 32;

let btn: HTMLButtonElement | null = null;
let recording = false;

function styleOnce() {
  if (document.getElementById(CSS_ID)) return;
  const st = document.createElement("style");
  st.id = CSS_ID;
  // z 8 is the Wiki row's own layer — this button belongs to that group.
  st.textContent = `
  .${BTN}{position:fixed;left:calc(var(--gv-left,0px) + ${GAP}px);
    top:calc(${GAP}px + var(--ml-safe-top, 0px) + var(--bars-l-h, 78px) + ${GAP}px);
    z-index:8;width:${PILL_W}px;height:${PILL_H}px;box-sizing:content-box;padding:0;
    border:1px solid var(--border-strong);border-radius:7px;
    box-shadow:var(--shadow);cursor:pointer;
    display:flex;align-items:center;justify-content:center;gap:5px;
    background:color-mix(in srgb, var(--bg) 76%, transparent);
    backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);
    font:600 12px var(--sans);letter-spacing:.03em;color:var(--ink);
    transition:left .3s ease,top .3s ease;
    -webkit-tap-highlight-color:transparent;user-select:none}
  /* hidden until the server says admin — never the other way round */
  .${BTN}[hidden]{display:none}
  .${BTN}-icon{image-rendering:pixelated;pointer-events:none;-webkit-user-drag:none}
  /* recording: the house ON treatment, which is the accent — his red */
  .${BTN}.on{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-ink)}
  .${BTN}.press,.${BTN}:active{transform:scale(.96)}`;
  document.head.appendChild(st);
}

/** Whether the button is in its recording state. */
export const isRecording = (): boolean => recording;

/** Set the state and paint it. Fires "ml-record" (detail: {on}) so whatever is
 *  bound to this button listens instead of reaching in here. */
export function setRecording(on: boolean): void {
  recording = on;
  btn?.classList.toggle("on", on);
  btn?.setAttribute("aria-pressed", String(on));
  btn?.setAttribute("title", on ? "Frozen — tap to let the world run" : "Report a bug: freeze the world on this frame");
  window.dispatchEvent(new CustomEvent("ml-record", { detail: { on } }));
}

/** Ask the server again whether this session is the admin, and show or hide
 *  the button on the answer. The mounted element stays in the DOM either way
 *  (hidden, so a player never sees it); `force` drops the cached answer. */
export async function applyAdmin(force = false): Promise<boolean> {
  if (force) forgetAdmin();
  const mine = btn;
  const yes = await isAdmin();
  if (mine !== btn || !btn) return yes; // a HUD rebuild replaced it while we asked
  btn.hidden = !yes;
  return yes;
}

/** Mount the button under the HP/EP card. Idempotent: a HUD rebuild (rejoin)
 *  throws its own chrome away and mounts again, so strays are cleared first. */
export function mountRecordButton(): void {
  document.querySelectorAll(`.${BTN}`).forEach((e) => e.remove());
  styleOnce();
  btn = document.createElement("button");
  btn.className = BTN;
  btn.type = "button";
  btn.hidden = true;
  // HIS OWN ART at its authored 24px grid by the shared /ui2 rule — the bake
  // is an exact 2x and the runtime halves it (hud.ts, wikibtn.ts).
  const icon = document.createElement("img");
  icon.className = `${BTN}-icon`;
  icon.src = withV("/ui2/icon-report.webp");
  icon.alt = "";
  icon.draggable = false;
  const fit = () => {
    if (!icon.naturalWidth) return;
    icon.style.width = `${icon.naturalWidth / 2}px`;
    icon.style.height = `${icon.naturalHeight / 2}px`;
  };
  icon.addEventListener("load", fit);
  fit();
  btn.append(icon, document.createTextNode("Report"));
  // CSS :active is hover-only on mobile — the corner buttons' own press look.
  btn.addEventListener("pointerdown", () => btn?.classList.add("press"));
  for (const ev of ["pointerup", "pointercancel", "pointerleave"])
    btn.addEventListener(ev, () => btn?.classList.remove("press"));
  btn.addEventListener("click", () => setRecording(!recording));
  document.body.appendChild(btn);
  setRecording(recording); // carry the state across a HUD rebuild
  void applyAdmin(); // …and reveal it only for the admin
}

// The probe surface this module owns (the __mlAmbient / __mlMapLayers pattern).
(window as unknown as { __mlRecord?: unknown }).__mlRecord = {
  on: isRecording,
  set: setRecording,
  el: () => btn,
  /** Re-ask the server whether this session is the admin (see applyAdmin). */
  refresh: (force = true) => applyAdmin(force),
  shown: () => !!btn && !btn.hidden,
};
