/** THE GAP'S OWN LEDGER — what OUR handlers cost between frames.
 *
 *  `gapBusy` (the MessageChannel probe in WorldScene) says the main thread
 *  was held between POST_RENDER and the next update by something that is not
 *  our frame, and never by WHAT. Most of what runs there is ours anyway: the
 *  compose and resolve workers' landings, the art worker's bands, the
 *  Colyseus socket's state patches. Each bills its handler time here; the
 *  beacon reads the frame's ledger into the worst-frame record (`gap`) and the
 *  window's into `counts` (`gapNetMs`, `gapComposeMs`, ...). A busy gap with
 *  an empty ledger is a foreign task — the LoAF split names it (perfloaf.ts).
 *
 *  Armed with the beacon: an unarmed session pays one boolean per message. */

let armed: () => boolean = () => false;
const frame: Record<string, number> = {};
const win: Record<string, number> = {};

export function gapArm(fn: () => boolean): void {
  armed = fn;
}

/** Whether to take timestamps at all. */
export const gapOn = (): boolean => armed();

/** Bill `ms` of a between-frames handler to `name`. */
export function gapBill(name: string, ms: number): void {
  if (!(ms > 0)) return;
  frame[name] = (frame[name] ?? 0) + ms;
  win[name] = (win[name] ?? 0) + ms;
}

/** The frame's ledger, rounded, or undefined when nothing was billed; resets. */
export function gapFrameTake(): Record<string, number> | undefined {
  let out: Record<string, number> | undefined;
  for (const k in frame) {
    const v = frame[k];
    delete frame[k];
    if (v >= 0.05) (out ??= {})[k] = +v.toFixed(1);
  }
  return out;
}

/** The window's ledger as `gap<Name>Ms` counts; resets. */
export function gapWindowTake(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k in win) {
    out[`gap${k.charAt(0).toUpperCase()}${k.slice(1)}Ms`] = +win[k].toFixed(1);
    delete win[k];
  }
  return out;
}
