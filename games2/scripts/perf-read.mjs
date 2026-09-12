// READ A PERF RUN: node scripts/perf-read.mjs [--last N] [--run <runId>] [--build <sha>] [--occ depth|sprites] [--diff <A> <B>]
//
// live/telemetry/perf.json holds the last 40 windows the beacon posted from
// his phone. This prints them as a story instead of a JSON dump: one line per
// window (when, build, where, what he was doing, the frame percentiles and
// histogram, the three dearest sections, the input round trip, the CPU
// benchmark, the GPU frame time when the browser lent its timer, heap growth,
// textures added, long tasks, zone hops), then the union of the long-frame
// census. `--diff A B` sets two builds' window medians side by side, which is
// the question every optimisation task starts with; A and B are build shas
// or the renderer names `depth` / `sprites` (the render retake's A/B — every
// window carries `run.occ`, the renderer it ran on). Fields older windows do
// not carry print as "-": a "-" is "not measured", never 0.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "..", "..", "live", "telemetry", "perf.json");
const doc = JSON.parse(readFileSync(file, "utf8"));
const all = doc.reports ?? [];
const args = process.argv.slice(2);
const opt = (k, n = 1) => { const i = args.indexOf(k); return i < 0 ? null : n === 1 ? args[i + 1] : args.slice(i + 1, i + 1 + n); };
const last = Number(opt("--last") ?? 40);
const runId = opt("--run");
const build = opt("--build");
const occ = opt("--occ");
const diff = opt("--diff", 2);

const f = (v, d = 1) => (typeof v === "number" ? v.toFixed(d) : "-");
const short = (s) => (s ? String(s).slice(0, 8) : "-");
const top = (sec, n = 3) => Object.entries(sec ?? {}).filter(([k]) => k !== "gapIdle" && k !== "gapBusy").sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${f(v, 1)}`).join(", ");
const median = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

let rows = all;
if (runId) rows = rows.filter((r) => r.run?.runId === runId);
if (build) rows = rows.filter((r) => (r.build ?? "").startsWith(build));
if (occ) rows = rows.filter((r) => r.run?.occ === occ);
rows = rows.slice(-last);

if (diff) {
  const [a, b] = diff;
  // A side is a build sha prefix, or a renderer name (run.occ).
  const pick = (k) => (k === "depth" || k === "sprites" ? all.filter((r) => r.run?.occ === k) : all.filter((r) => (r.build ?? "").startsWith(k)));
  const A = pick(a), B = pick(b);
  console.log(`build ${short(a)}: ${A.length} windows   build ${short(b)}: ${B.length} windows   (medians over windows)`);
  const metrics = [
    ["p50 ms", (r) => r.frames?.p50], ["p90 ms", (r) => r.frames?.p90], ["p99 ms", (r) => r.frames?.p99], ["max ms", (r) => r.frames?.max],
    ["frames >50 ms", (r) => (r.frames?.le100 ?? null) === null ? null : r.frames.le100 + r.frames.gt100],
    ["rafHz", (r) => r.frames?.rafHz], ["render ms", (r) => r.sections?.render], ["gapBusy ms", (r) => r.sections?.gapBusy],
    ["rebuildOccluders", (r) => r.sections?.rebuildOccluders], ["occCull", (r) => r.sections?.occCull], ["depthSort", (r) => r.sections?.depthSort],
    ["lighting", (r) => r.sections?.lighting], ["groundSlice", (r) => r.sections?.groundSlice], ["prefetch", (r) => r.sections?.prefetch],
    ["rtt p50", (r) => r.rtt?.p50], ["rtt p90", (r) => r.rtt?.p90], ["patchHz", (r) => r.rtt?.patchHz],
    ["cpu bench ms", (r) => r.cpu?.scoreMs], ["gpu p50", (r) => r.gpu?.avail ? r.gpu.p50 : null], ["gpu p90", (r) => r.gpu?.avail ? r.gpu.p90 : null],
    ["heap MB/s", (r) => r.heap?.grewMbPerSec], ["gc drops", (r) => r.heap?.drops], ["tex added", (r) => r.counts?.texturesAdded], ["glUpMb", (r) => r.counts?.glUpMb],
    ["longN", (r) => r.counts?.longN], ["occMean", (r) => r.counts?.occMean], ["dlMean", (r) => r.counts?.dlMean], ["zoomMean", (r) => r.zoomMean],
  ];
  console.log("metric".padEnd(18), short(a).padStart(10), short(b).padStart(10), "   delta");
  for (const [name, g] of metrics) {
    const ma = median(A.map(g)), mb = median(B.map(g));
    const d = ma !== null && mb !== null ? (mb - ma) : null;
    console.log(name.padEnd(18), f(ma).padStart(10), f(mb).padStart(10), d === null ? "" : `   ${d >= 0 ? "+" : ""}${f(d)}${ma ? ` (${((d / ma) * 100).toFixed(0)}%)` : ""}`);
  }
  process.exit(0);
}

console.log(`${rows.length} windows (file updated ${doc.updated_at})`);
console.log(["when", "build", "rend", "run/win", "where", "s", "do", "p50", "p90", "p99", "max", ">50", "Hz", "top sections (ms/frame)", "rtt50/90", "pHz", "cpu", "gpu50", "heap/s", "tex", "long", "hops"].join(" | "));
for (const r of rows) {
  const fr = r.frames ?? {};
  const over50 = fr.le100 !== undefined ? fr.le100 + fr.gt100 : "-";
  const doing = r.run ? `${Math.round((r.run.moveFrac ?? 0) * 100)}%mv ${f(r.run.travelCells, 0)}c` : "-";
  console.log([
    (r.at ?? "").slice(5, 16), short(r.build), r.run?.occ ?? "-", r.run ? `${r.run.runId}/${r.run.winIdx}${r.run.why ? ":" + r.run.why : ""}` : "-", r.where ?? "-", f(r.secs, 0), doing,
    f(fr.p50), f(fr.p90), f(fr.p99), f(fr.max, 0), over50, fr.rafHz ?? "-", top(r.sections),
    r.rtt ? `${f(r.rtt.p50, 0)}/${f(r.rtt.p90, 0)}` : "-", r.rtt ? f(r.rtt.patchHz, 0) : "-", r.cpu ? f(r.cpu.scoreMs) : "-",
    r.gpu ? (r.gpu.avail ? f(r.gpu.p50) : "n/a") : "-", r.heap ? f(r.heap.grewMbPerSec, 0) : "-", r.counts?.texturesAdded ?? "-", r.counts?.longN ?? "-", r.run ? r.run.hops : "-",
  ].join(" | "));
}
// The long-frame census, summed over the printed windows.
const census = {};
for (const r of rows) for (const [k, v] of Object.entries(r.longBy ?? {})) { const c = (census[k] ??= { n: 0, ms: 0 }); c.n += v.n ?? 0; c.ms += v.ms ?? 0; }
const ce = Object.entries(census).sort((a, b) => b[1].ms - a[1].ms).slice(0, 10);
if (ce.length) console.log("\nlong frames by ground mode : dominant section  —  " + ce.map(([k, v]) => `${k} ${v.n}x/${v.ms.toFixed(0)}ms`).join("; "));
// WHERE the bad frames were, summed over the printed windows — 8-cell blocks,
// keyed by the block's corner so it reads back as a teleport target.
const where = {};
for (const r of rows) for (const [k, v] of Object.entries(r.longWhere ?? {})) { const c = (where[k] ??= { n: 0, ms: 0, worst: 0 }); c.n += v.n ?? 0; c.ms += v.ms ?? 0; c.worst = Math.max(c.worst, v.worst ?? 0); }
const we = Object.entries(where).sort((a, b) => b[1].ms - a[1].ms).slice(0, 10);
if (we.length) console.log("\nlong frames by PLACE (8-cell blocks, teleport there)  —  " + we.map(([k, v]) => `${k} ${v.n}x/${v.ms.toFixed(0)}ms worst ${v.worst}`).join("; "));
// The worst single frames of the printed windows, with where and when.
const worst = rows.flatMap((r) => (r.worst ?? []).map((w) => { try { return JSON.parse(w); } catch { return null; } })).filter(Boolean).sort((a, b) => b.total - a.total).slice(0, 8);
if (worst.length) {
  console.log("\nworst frames: ms | at | zoom | t(s into window) | sections | mode | tex | dl/occ");
  for (const w of worst) console.log(`  ${f(w.total, 0).padStart(5)} | ${String(w.at ?? "-").padStart(13)} | ${w.z ?? "-"} | ${w.t !== undefined ? (w.t / 1000).toFixed(1) : "-"} | ${Object.entries(w.sec ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(", ")} | ${w.mode ?? "-"} | ${w.tex ?? "-"} | ${w.dl ?? "-"}/${w.occ ?? "-"}`);
}
const gpuRe = rows.map((r) => r.gpu?.reason).filter(Boolean);
if (gpuRe.length) console.log("gpu timer: " + [...new Set(gpuRe)].join(", "));
