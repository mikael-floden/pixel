/** THE WORST FRAMES AS THEY GO ON THE WIRE — one function for both posts: the
 *  report's worker (perfpost.ts) and this thread's fallback (no worker,
 *  `?perfworker=0`, a hidden page's last flush). Pure.
 *
 *  ALL OF THEM, NOT FIVE: the recorder keeps 24 worst frames and the report
 *  used to throw 19 away — proving the depthSort spikes were a mis-billed
 *  stall needed the frames AROUND them.
 *
 *  THE LOAF ENTRY FOR EACH RECORD, MATCHED BY TIME, in the ring taken with the
 *  window: the browser reports a long frame after it closed, so the record
 *  could not carry it when it was written. `_t0`/`_t1` are the record's
 *  performance.now() bounds and never leave the client.
 *
 *  THE TIMELINE, compacted: every region that ran in or ahead of the frame as
 *  [name, start, end] relative to `pt0`, sorted by start — the wait between
 *  one region's end and the next one's start is what he asked to see. From
 *  the pack (`tl`, record i) when the report packed them, else the record's
 *  own `_tl`. */
import { loafAtIn, type LoafSplit } from "./perfloaf";
import { tlCompact, tlUnpack, type Mark, type TlPacked } from "./perftimeline";

export function shapeWorst(
  w: readonly Record<string, unknown>[] | null,
  ring: readonly LoafSplit[],
  tl: TlPacked | null,
): Record<string, unknown>[] | null {
  if (!w) return null;
  return w.map((r, i) => {
    const o: Record<string, unknown> = { ...r };
    const t0 = o._t0 as number | undefined;
    const t1 = o._t1 as number | undefined;
    delete o._t0;
    delete o._t1;
    if (t0 !== undefined && t1 !== undefined) {
      const l = loafAtIn(ring, t0, t1);
      if (l) o.loaf = l;
    }
    const raw = tl ? tlUnpack(tl, i) : (o._tl as { marks: Mark[]; dropped: number } | undefined);
    delete o._tl;
    if (raw && t0 !== undefined) {
      o.tl = tlCompact(raw.marks, t0);
      if (raw.dropped) o.tlDropped = raw.dropped;
    }
    return o;
  });
}
