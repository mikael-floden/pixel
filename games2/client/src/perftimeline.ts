/** THE FRAME'S TIMELINE — WHEN each timed region started and ended, not only
 *  how long it took (maintainer 2026-09-23: "add two datapoints at every
 *  metric: how long it took, and the real-time clock in ms when it started
 *  and completed — so we know how long we waited before this code started
 *  vs the old code ended").
 *
 *  Every timer in the client reports here as well as to its own accumulator:
 *  the scene's sections (WorldScene `pe`/`pAdd`), the ambient mount's feature
 *  updates and tick parts (`window.__mlPerfMark`, prefixed `amb:`), the gap
 *  ledger's between-frame handlers (`gap:net`, `gap:compose`, ...). A mark is
 *  [name, t0, t1] on performance.now(). The beacon takes the frame's marks
 *  when it closes the frame (`closeHitchFrame`) and the worst-24 records
 *  carry them as `tl`, relative to the record's own start (`pt0`, absolute)
 *  with `wall` the epoch ms of that start — so every region has a clock
 *  reading, and the gap between one region's end and the next one's start is
 *  the wait he asked about. `counts.clock0` (epoch minus performance.now())
 *  converts every window-level timestamp the same way.
 *
 *  Armed with the beacon: unarmed, a mark is one boolean. A frame is capped
 *  at 256 marks (a normal frame makes ~70); past it the count is kept and the
 *  marks are not. */

export type Mark = [string, number, number];

let armed: () => boolean = () => false;
let marks: Mark[] = [];
let dropped = 0;
export const TL_CAP = 256;

export function tlArm(fn: () => boolean): void {
  armed = fn;
}

/** Whether marks are being taken at all. */
export const tlOn = (): boolean => armed();

/** One region: `name` ran from `t0` to `t1` (performance.now() ms). */
export function tlMark(name: string, t0: number, t1: number): void {
  if (!armed()) return;
  if (marks.length < TL_CAP) marks.push([name, t0, t1]);
  else dropped++;
}

/** The frame's marks so far, in the order they ENDED; resets. `dropped` says
 *  how many the cap refused since the last take. */
export function tlTake(): { marks: Mark[]; dropped: number } {
  const out = { marks, dropped };
  marks = [];
  dropped = 0;
  return out;
}

/** A record keeps this many marks at most: the longest ones, after the
 *  marks under `TL_MIN_MS` are dropped — a frame makes ~70 and half are
 *  timers at their noise floor, while a headless frame with 256 marks made
 *  a 8.5 KB record and the allowlist's cap cut it (measured 2026-09-23). */
export const TL_KEEP = 80;
export const TL_MIN_MS = 0.05;
/** The frame's skeleton — kept whatever their length, because the waits
 *  BETWEEN them are the question: the step's two listener brackets, the
 *  render, the sort, and the two halves of the gap before the step. */
export const TL_ALWAYS: ReadonlySet<string> = new Set(["preUpdate", "hooks", "render", "depthSort", "gapBusy", "gapIdle"]);

/** Pure: a frame's marks as the record carries them — the skeleton marks
 *  (`TL_ALWAYS`) and, of the rest, those of `TL_MIN_MS` or more, the
 *  `TL_KEEP` longest in all; sorted by start, relative to `t0` (the frame's
 *  start), 0.1 ms, name cut at 24. A mark that began before the frame (a gap
 *  handler that ran ahead of it) is negative. */
export function tlCompact(marks: readonly Mark[], t0: number, keep = TL_KEEP): Mark[] {
  const always = marks.filter((m) => TL_ALWAYS.has(m[0]));
  let rest = marks.filter((m) => !TL_ALWAYS.has(m[0]) && m[2] - m[1] >= TL_MIN_MS);
  const room = Math.max(0, keep - always.length);
  if (rest.length > room) rest = [...rest].sort((a, b) => b[2] - b[1] - (a[2] - a[1])).slice(0, room);
  return [...always, ...rest]
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .map(([n, a, b]) => [n.length > 24 ? n.slice(0, 24) : n, +(a - t0).toFixed(1), +(b - t0).toFixed(1)]);
}

/** Pure: the waits a timeline holds — for each mark, the gap from the end of
 *  the latest-ending mark before it to its start (0 when they overlap or
 *  nest). The sum is the time nothing timed was running. */
export function tlWaits(tl: readonly Mark[]): number[] {
  let end = -Infinity;
  const out: number[] = [];
  for (const [, a, b] of tl) {
    out.push(end === -Infinity ? 0 : Math.max(0, +(a - end).toFixed(1)));
    if (b > end) end = b;
  }
  return out;
}

/** Epoch ms minus performance.now(): add it to any timestamp here for the
 *  real-time clock. Sampled when asked (the two clocks can drift by ms over
 *  hours, so a window carries its own). */
export const clock0 = (): number => Math.round(Date.now() - performance.now());
