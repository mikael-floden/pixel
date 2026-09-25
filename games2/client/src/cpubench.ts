/** THE CPU BENCHMARK, ON A WORKER (2026-09-25). The beacon's throttling proxy
 *  (`cpu.scoreMs`: perfextra's fixed 400k xorshift steps, 2.6-4.3 ms on his
 *  cool phone, 7.2-7.8 hot) ran on the main thread inside the frame that built
 *  each report — the recorder stalling the game it measures (maintainer: "I
 *  can't have a lag that is due to the perf run itself"). Here it runs on its
 *  own thread and answers with the time; the report carries the latest one
 *  (`bench: "xorshift400k-worker"` — a worker's core, compare runs of the same
 *  bench only). One message, one run. */
import { cpuScoreMs } from "./perfextra";

self.onmessage = () => {
  (self as unknown as { postMessage(v: number): void }).postMessage(cpuScoreMs());
};
