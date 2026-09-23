// READ A PERF RUN: node scripts/perf-read.mjs [--last N] [--run <runId>] [--build <sha>] [--diff <shaA> <shaB>]
//
// live/telemetry/perf.json holds the last 40 windows the beacon posted from
// his phone. This prints them as a story instead of a JSON dump: one line per
// window (when, build, where, what he was doing, the frame percentiles and
// histogram, the three dearest sections, the input round trip, the CPU
// benchmark, the GPU frame time when the browser lent its timer, heap growth,
// textures added, long tasks, zone hops), then the union of the long-frame
// census. `--diff A B` sets two builds' window medians side by side, which is
// the question every optimisation task starts with. `sim` is the Settings
// "burst test" switch (WorldScene.burstTest: the CPU bursts skipped, the
// frame rate the game would have once they are gone). `res` is the resolver's
// own ms on the frame thread this window and its µs per cell (2026-09-19; the
// worker has been off in every run), `inp` the input delay p90 / the slowest
// tap-to-paint (Event Timing; "n/a" where the browser has no such entries),
// and the ambient line is the effects' mean ms a frame from their own meter.
// Fields older windows do not carry print as "-": a "-" is "not measured",
// never 0.
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
const diff = opt("--diff", 2);

const f = (v, d = 1) => (typeof v === "number" ? v.toFixed(d) : "-");
const short = (s) => (s ? String(s).slice(0, 8) : "-");
const top = (sec, n = 3) => Object.entries(sec ?? {}).filter(([k]) => k !== "gapIdle" && k !== "gapBusy").sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${f(v, 1)}`).join(", ");
const median = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

let rows = all;
if (runId) rows = rows.filter((r) => r.run?.runId === runId);
if (build) rows = rows.filter((r) => (r.build ?? "").startsWith(build));
rows = rows.slice(-last);

if (diff) {
  const [a, b] = diff;
  const pick = (sha) => all.filter((r) => (r.build ?? "").startsWith(sha));
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
    // 2026-09-19: the resolver's own line, the fade's draw-side bill, the scene's listeners, the felt lag.
    ["resolve ms", (r) => r.resolve?.ms], ["us/cell", (r) => r.resolve?.usPerCell], ["fadeVisits", (r) => r.resolve?.fadeVisits], ["fades placed", (r) => r.resolve?.fades],
    ["fades drawn", (r) => r.groundDrew?.fades], ["fadeTex built", (r) => r.groundDrew?.fadeTex],
    ["preUpdate ms", (r) => r.sections?.preUpdate], ["hooks ms", (r) => r.sections?.hooks],
    ["input p90 ms", (r) => (r.input?.avail ? r.input.delayP90 : null)], ["input slow", (r) => (r.input?.avail ? r.input.slow : null)],
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
console.log(["when", "build", "sim", "run/win", "where", "s", "do", "p50", "p90", "p99", "max", ">50", "Hz", "top sections (ms/frame)", "res ms/us", "inp90/max", "rtt50/90", "pHz", "cpu", "gpu50", "heap/s", "tex", "long", "hops", "posts", "lag", "loaf n:pre/raf/dom", "draws/fill/fb"].join(" | "));
for (const r of rows) {
  const fr = r.frames ?? {};
  const over50 = fr.le100 !== undefined ? fr.le100 + fr.gt100 : "-";
  const doing = r.run ? `${Math.round((r.run.moveFrac ?? 0) * 100)}%mv ${f(r.run.travelCells, 0)}c` : "-";
  console.log([
    (r.at ?? "").slice(5, 16), short(r.build), r.run?.sim || "-", r.run ? `${r.run.runId}/${r.run.winIdx}${r.run.why ? ":" + r.run.why : ""}` : "-", r.where ?? "-", f(r.secs, 0), doing,
    f(fr.p50), f(fr.p90), f(fr.p99), f(fr.max, 0), over50, fr.rafHz ?? "-", top(r.sections),
    r.resolve ? `${f(r.resolve.ms, 0)}/${f(r.resolve.usPerCell, 0)}` : "-",
    r.input ? (r.input.avail ? `${f(r.input.delayP90, 0)}/${f(r.input.durMax, 0)}` : "n/a") : "-",
    r.rtt ? `${f(r.rtt.p50, 0)}/${f(r.rtt.p90, 0)}` : "-", r.rtt ? f(r.rtt.patchHz, 0) : "-", r.cpu ? f(r.cpu.scoreMs) : "-",
    r.gpu ? (r.gpu.avail ? f(r.gpu.p50) : "n/a") : "-", r.heap ? f(r.heap.grewMbPerSec, 0) : "-", r.counts?.texturesAdded ?? "-", r.counts?.longN ?? "-", r.run ? r.run.hops : "-",
    // the delivery ledger (2026-09-19): posts that got through / posts made before this window, and the last failure
    r.beacon ? `${r.beacon.ok}/${r.beacon.sent}${r.beacon.failed ? ` FAIL ${r.beacon.failed} (${r.beacon.lastStatus} ${r.beacon.lastError || ""})` : ""}` : "-",
    // The rAF lag (how late updates start, mean ms), the browser's split of the
    // long frames (perfloaf.ts) and the GPU's bill per frame (glframe.ts).
    r.counts?.rafLagMean !== undefined ? f(r.counts.rafLagMean) : "-",
    r.loaf ? (r.loaf.state === "on" ? `${r.loaf.n}:${f(r.loaf.pre, 0)}/${f(r.loaf.raf, 0)}/${f(r.loaf.dom, 0)}` : r.loaf.state) : "-",
    r.counts?.glDraws !== undefined ? `${f(r.counts.glDraws, 0)}/${f(r.counts.glFillMpx)}/${f(r.counts.glFbSw, 0)}` : "-",
  ].join(" | "));
}
// The census by GROUP (idle and busy in the argmax), summed over the printed windows.
const groups = {};
for (const r of rows) for (const [k, v] of Object.entries(r.longGroup ?? {})) { const c = (groups[k] ??= { n: 0, ms: 0, top: 0 }); c.n += v.n ?? 0; c.ms += v.ms ?? 0; c.top += (v.top ?? 0) * (v.n ?? 0); }
const ge = Object.entries(groups).sort((a, b) => b[1].ms - a[1].ms).slice(0, 10);
if (ge.length) console.log("\nlong frames by ground mode : dominant GROUP  —  " + ge.map(([k, v]) => `${k} ${v.n}x/${v.ms.toFixed(0)}ms (top ${(v.top / Math.max(1, v.n)).toFixed(1)})`).join("; "));
// WHO held the thread in the long frames, by the browser's account, summed.
const inv = {};
for (const r of rows) for (const [k, v] of Object.entries(r.loafBy ?? {})) { const c = (inv[k] ??= { n: 0, ms: 0 }); c.n += v.n ?? 0; c.ms += v.ms ?? 0; }
const ie = Object.entries(inv).sort((a, b) => b[1].ms - a[1].ms).slice(0, 8);
if (ie.length) console.log("long-frame scripts by invoker (LoAF)  —  " + ie.map(([k, v]) => `${k} ${v.n}x/${v.ms.toFixed(0)}ms`).join("; "));
// Our share of the busy gap, summed: the socket and the workers' landings.
const gaps = {};
for (const r of rows) for (const [k, v] of Object.entries(r.counts ?? {})) if (k.startsWith("gap") && k.endsWith("Ms")) gaps[k] = (gaps[k] ?? 0) + v;
if (Object.keys(gaps).length) console.log("gap ledger (ms over the printed windows)  —  " + Object.entries(gaps).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.slice(3, -2)} ${v.toFixed(0)}`).join("; "));
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
  console.log("\nworst frames: ms | at | zoom | t(s into window) | sections | mode | tex | dl/occ | lag | gap | gl draws/fill (prev) | loaf pre/raf/dom: by");
  for (const w of worst) {
    const gl = w.gl ? `${w.gl.dc ?? "-"}/${w.gl.fill ?? "-"}${w.glPrev ? ` (${w.glPrev.dc ?? "-"}/${w.glPrev.fill ?? "-"})` : ""}` : "-";
    const gap = w.gap ? Object.entries(w.gap).map(([k, v]) => `${k} ${v}`).join(" ") : "-";
    const loaf = w.loaf ? `${w.loaf.pre}/${w.loaf.raf}/${w.loaf.dom}: ${(w.loaf.by ?? []).map(([k, v]) => `${k} ${v}`).join(", ")}` : "-";
    console.log(`  ${f(w.total, 0).padStart(5)} | ${String(w.at ?? "-").padStart(13)} | ${w.z ?? "-"} | ${w.t !== undefined ? (w.t / 1000).toFixed(1) : "-"} | ${Object.entries(w.sec ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(", ")} | ${w.mode ?? "-"} | ${w.tex ?? "-"} | ${w.dl ?? "-"}/${w.occ ?? "-"} | ${w.lag ?? "-"} | ${gap} | ${gl} | ${loaf}`);
  }
}
// THE AMBIENT EFFECTS' OWN METER, averaged over the printed windows that carry
// it: mean ms a frame per effect (their `hooks` section is the sum), the peak
// frame, and the mode the HUD had. An effect that is on and not here cost
// nothing measurable.
const amb = {};
let ambMode = new Set();
for (const r of rows) for (const [k, v] of Object.entries(r.ambient ?? {})) {
  if (k === "_") { if (v.mode) ambMode.add(`${v.mode}${v.active ? "/" + v.active : ""}`); continue; }
  const c = (amb[k] ??= { ms: 0, n: 0, peak: 0 }); c.ms += v.ms ?? 0; c.n++; c.peak = Math.max(c.peak, v.peak ?? 0);
}
const ae = Object.entries(amb).sort((a, b) => b[1].ms / b[1].n - a[1].ms / a[1].n).slice(0, 8);
if (ae.length) console.log(`\nambient (ms/frame per effect, peak; a `_` row is the mount's own part, per tick for _env/_gloom/_director): ${ae.map(([k, v]) => `${k} ${(v.ms / v.n).toFixed(2)} (${v.peak.toFixed(1)})`).join("; ")}${ambMode.size ? `  — mode ${[...ambMode].join(", ")}` : ""}`);
const gpuRe = rows.map((r) => r.gpu?.reason).filter(Boolean);
if (gpuRe.length) console.log("gpu timer: " + [...new Set(gpuRe)].join(", "));
