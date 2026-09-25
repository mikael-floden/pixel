/** THE PERF REPORT'S POST, ON A WORKER (2026-09-25). Maintainer: "I can't
 *  have a lag that is due to the perf run itself when I try to evaluate the
 *  performance." His 15:51 run on a hot phone: the report built between frames
 *  cost 58-95 ms and its post 10-23 ms — a saturated phone has no idle period,
 *  so work moved out of the frame still stalled the next one. What the post
 *  does is all here now: the worst frames shaped for the wire (their timelines
 *  compacted, each matched to the browser's long-frame entry: `shapeWorst`),
 *  the JSON, the fetch and reading its answer. The game's thread hands over
 *  three JSON strings and the packed timelines (`tlPack`) — the cheapest form
 *  measured: a structured clone of the same objects was 5x the JSON — and
 *  keeps the outbox, the retries and the ledger (WorldScene `perfPump`).
 *
 *  THE CPU BENCHMARK rides the same worker: the throttling proxy (`cpu.scoreMs`,
 *  400k xorshift steps) on this thread, never the game's.
 *
 *  Messages in: `{ kind: "post", id, url, body, worst, ring, tl }` (body,
 *  worst, ring: JSON) and `{ kind: "bench" }`. Out: `{ kind: "post", id, ok,
 *  status, err, bytes, ms }` and `{ kind: "bench", ms }`. */
import { cpuScoreMs } from "./perfextra";
import { shapeWorst } from "./perfshape";
import type { TlPacked } from "./perftimeline";

interface PostIn {
  kind: "post";
  id: number;
  url: string;
  body: string;
  worst: string | null;
  ring: string;
  tl: TlPacked | null;
}
interface BenchIn {
  kind: "bench";
}

const reply = (m: unknown): void => (self as unknown as { postMessage(m: unknown): void }).postMessage(m);

self.onmessage = (e: MessageEvent<PostIn | BenchIn>) => {
  const m = e.data;
  if (m.kind === "bench") {
    reply({ kind: "bench", ms: cpuScoreMs() });
    return;
  }
  const t0 = performance.now();
  let text = "";
  try {
    const body = JSON.parse(m.body) as Record<string, unknown>;
    try {
      body.worst = shapeWorst(m.worst ? JSON.parse(m.worst) : null, JSON.parse(m.ring), m.tl);
    } catch {
      body.worst = null; // a record that cannot be shaped costs the worst frames, never the window
    }
    text = JSON.stringify(body);
  } catch (err) {
    reply({ kind: "post", id: m.id, ok: false, status: -2, err: `shape/json: ${String(err).slice(0, 100)}`, bytes: 0, ms: performance.now() - t0 });
    return;
  }
  const ms = performance.now() - t0;
  fetch(m.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: text }).then(
    async (r) => {
      const t = await r.text().catch(() => "");
      reply({ kind: "post", id: m.id, ok: r.ok, status: r.status, err: r.ok ? "" : `HTTP ${r.status} ${t.slice(0, 80)}`, bytes: text.length, ms });
    },
    (err) => reply({ kind: "post", id: m.id, ok: false, status: 0, err: String(err).slice(0, 120), bytes: text.length, ms }),
  );
};
