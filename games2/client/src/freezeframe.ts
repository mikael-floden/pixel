// THE FREEZE FRAME — press the record button and the world stops on the frame
// you were looking at (maintainer 2026-09-18: "is it possible to printscreen
// the entire page/game and freeze the game / only show the printscreen as a
// 'freezed frame' when you press the red button? … Not jpeg encoded. I want the
// freezed image lossless").
//
// LOSSLESS, AND THAT IS NOT A SETTING WE CHOSE LIGHTLY. Phaser's
// `renderer.snapshot(cb, type)` defaults to `image/png` — PNG is lossless, so
// the frame you keep is the frame that was on the glass, pixel for pixel. JPEG
// would be one argument away and is exactly what he ruled out; nothing here may
// ever pass a `type` or an encoder quality.
//
// THE ORDER IS LOAD-BEARING: capture, THEN freeze. A snapshot is scheduled for
// after the CURRENT frame renders (WebGLRenderer.snapshotArea), because
// `gl.readPixels` has to run before the compositor takes the drawing buffer —
// this canvas has no `preserveDrawingBuffer`, so a read after the fact comes
// back blank. Sleeping the loop first would mean no next frame, no readPixels
// and a callback that never fires. So: request → one frame renders → the image
// arrives → sleep. The game is live for that one frame, which is the frame
// being captured.
//
// WHAT IS FROZEN, AND WHAT IS NOT. The image covers the GAME CANVAS — the
// world, which is the part that moves. The HUD is plain DOM above it and stays
// live, which is not a compromise but a requirement: the button that un-freezes
// is in it. The freeze itself is `gamefreeze.ts`'s sleep (the wiki drawer's),
// so nothing is duplicated: no update, no render, no input sent, and the server
// integrates only the inputs it receives — a frozen client stands still rather
// than coasting.
//
// IT LISTENS, IT IS NOT CALLED. recbtn.ts fires "ml-record" with its state and
// knows nothing about this file; this file knows nothing about the button. That
// seam was built when the button shipped, and it is what lets the next thing
// bound to that button be bound without touching either.
import { freezeGame, gameFrozen, thawGame } from "./gamefreeze";

const CLS = "ml-freezeframe";
const CSS_ID = "ml-freezeframe-css";

type Renderer = { snapshot?: (cb: (img: unknown) => void, type?: string) => unknown };
type GameLike = { renderer?: Renderer; canvas?: HTMLCanvasElement };
const game = (): GameLike | undefined => (window as unknown as { __mlGame?: GameLike }).__mlGame;

let frame: HTMLImageElement | null = null;

function styleOnce() {
  if (document.getElementById(CSS_ID)) return;
  const st = document.createElement("style");
  st.id = CSS_ID;
  // z 3: over the world, under everything the player still uses — the chat log
  // (5), the pill and the Wiki row (8), the thumb stick (4) and the HUD itself.
  // A frozen world with a live stick over it is the honest picture; a frame
  // that covered the controls would also cover the way out of it.
  // pointer-events:none — a tap still reaches the canvas under it, so nothing
  // about walking or tapping changes while the picture is up.
  st.textContent = `
  .${CLS}{position:fixed;z-index:3;pointer-events:none;image-rendering:pixelated;
    -webkit-user-drag:none;user-select:none}`;
  document.head.appendChild(st);
}

/** Lay the picture exactly over the game canvas. */
function place() {
  const cv = game()?.canvas;
  if (!frame || !cv) return;
  const r = cv.getBoundingClientRect();
  frame.style.left = `${r.left}px`;
  frame.style.top = `${r.top}px`;
  frame.style.width = `${r.width}px`;
  frame.style.height = `${r.height}px`;
}

/** Take the picture down and let the world run again. Idempotent. */
export function thawFrame(): void {
  frame?.remove();
  frame = null;
  if (gameFrozen()) thawGame();
}

/**
 * Capture the world and stop it on that frame. Resolves false when there is
 * nothing to capture (no game yet, a renderer without `snapshot`, a snapshot
 * that came back empty) — the caller turns the button back off rather than
 * leaving it lit over a world that is still moving.
 */
export function freezeFrame(): Promise<boolean> {
  const g = game();
  const cv = g?.canvas;
  const snap = g?.renderer?.snapshot;
  if (!g || !cv || typeof snap !== "function") return Promise.resolve(false);
  styleOnce();
  return new Promise<boolean>((resolve) => {
    // a snapshot that never comes back must not leave the button lit for ever
    const timer = window.setTimeout(() => resolve(false), 8000);
    try {
      // NO `type` ARGUMENT: the default is image/png, and png is the lossless
      // one. Passing image/jpeg here is the bug this comment exists to prevent.
      snap.call(g.renderer, (img: unknown) => {
        window.clearTimeout(timer);
        const el = img as HTMLImageElement;
        if (!el || typeof el.src !== "string" || !el.src) return resolve(false);
        const show = () => {
          // the world may have been thawed while the png decoded
          frame?.remove();
          el.className = CLS;
          el.draggable = false;
          frame = el;
          document.body.appendChild(el);
          place();
          freezeGame();
          resolve(true);
        };
        // Phaser hands back an Image whose src is a data URL; it may still be
        // decoding, and appending it undecoded shows a gap where the world was.
        if (el.complete && el.naturalWidth) show();
        else el.addEventListener("load", show, { once: true });
        el.addEventListener("error", () => resolve(false), { once: true });
      });
    } catch {
      window.clearTimeout(timer);
      resolve(false);
    }
  });
}

/** Whether a frozen picture is up. */
export const frameShown = (): boolean => !!frame;

// ── the seam: the record button's state, nothing else ──────────────────────
window.addEventListener("ml-record", (e) => {
  const on = !!(e as CustomEvent<{ on?: boolean }>).detail?.on;
  if (!on) return thawFrame();
  void freezeFrame().then((okay) => {
    if (!okay) {
      // nothing captured — say so by putting the button back, rather than
      // leaving it red over a world that never stopped
      const rec = (window as unknown as { __mlRecord?: { set?: (v: boolean) => void } }).__mlRecord;
      rec?.set?.(false);
    }
  });
});

// A rotation re-lays the whole view, and a picture of the OLD shape stretched
// over the new one is a lie — let the world back rather than show it.
window.addEventListener("ml-layout", () => {
  if (!frame) return;
  const rec = (window as unknown as { __mlRecord?: { set?: (v: boolean) => void } }).__mlRecord;
  rec?.set?.(false); // fires ml-record -> thawFrame, and the button follows
});
window.addEventListener("resize", place);

(window as unknown as { __mlFreezeFrame?: unknown }).__mlFreezeFrame = {
  shown: frameShown,
  /** The picture's own data URL, so a gate can prove it is a PNG and that its
   *  pixels are the world's. */
  src: () => frame?.src ?? null,
  size: () => (frame ? { w: frame.naturalWidth, h: frame.naturalHeight } : null),
};
