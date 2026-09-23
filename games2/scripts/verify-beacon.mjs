// THE BEACON'S POST SURVIVES THE ALLOWLIST — the eaten-field trap, made a gate.
//
// server/src/perfreport.ts rebuilds every report field by field, so a block the
// client starts sending is DROPPED SILENTLY until it is named there; that has
// eaten `lights`, `zoomMean`/`jumps`, `worst`, `groundDrew`, `texFam`, `heap`
// (docs/perf.md). This arms the beacon in a headless client against the dev
// stack, intercepts the real POST to /api/perf, runs it through perfReport and
// asserts every block the client emits reaches the file with its keys. Numbers
// here are the harness's (software GL, a few fps), never the game's.
//
// Needs the dev stack (npm run dev). PORT overrides vite's port.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = process.env.PORT || "5173";
const here = dirname(fileURLToPath(import.meta.url));
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--enable-webgl", "--ignore-gpu-blocklist"] });
/* NO SERVICE WORKER IN THE GATE. The installed app's worker answers fetches
 * itself, and a page route never sees a request the worker handled — the
 * beacon's POST reached the dev server (503, no token) while this gate
 * reported "no POST" (2026-09-23). Blocking workers in the context keeps
 * every request on the path the route intercepts. */
const page = await browser.newPage({ viewport: { width: 500, height: 900 }, serviceWorkers: "block" });
page.on("pageerror", (e) => console.log("pageerror", e.message));
/* THE POST IS CAUGHT INSIDE THE PAGE, NOT BY A ROUTE. The beacon sends with
 * `keepalive: true` (it must outlive a hidden page), and Chromium 141 hands a
 * keepalive fetch to the browser process where page.route never sees it — the
 * route version of this gate silently let the POST reach the dev server (503,
 * no token) and reported "no POST captured". Wrapping window.fetch before the
 * app boots sees every body regardless of how the browser dispatches it. */
let captured = null;
// THE DELIVERY ARM (2026-09-19): the FIRST post is refused with a 502 — the
// server's answer when the GitHub commit fails — and the client must post the
// SAME window again, say so in its ledger, and tell /api/perf/fail. The old
// post was fire-and-forget: refused once, the window was gone.
const posts = [];
const fails = [];
await page.route("**/api/perf", async (route) => {
  const body = route.request().postDataJSON();
  posts.push(body);
  console.log(`  post #${posts.length}: window ${body.run?.winIdx} (${body.run?.why}) attempt ${body.beacon?.attempt ?? "-"} at ${(performance.now() / 1000).toFixed(0)} s`);
  if (posts.length === 1) { await route.fulfill({ status: 502, contentType: "application/json", body: '{"error":"PUT perf.json: HTTP 409"}' }); return; }
  captured = body;
  await route.fulfill({ status: 200, body: "{}" });
});
await page.route("**/api/perf/fail", async (route) => { fails.push(route.request().postData()); await route.fulfill({ status: 202, body: "{}" }); });
await page.goto(`http://localhost:${PORT}/?perf=1#the_game`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 120000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 120000 });
await page.evaluate(() => window.__ml.noAggro?.(true));
// The beacon posts a window only after the body has MOVED (>= 2 cells): walk it.
for (let i = 0; i < 14 && !captured; i++) { await page.evaluate((i) => window.__ml.teleport(261.8 - i * 2, 219.3), i); await page.waitForTimeout(6000); }
await page.waitForTimeout(3000);
await browser.close();
if (!posts.length) { fail("no POST to /api/perf was made in 90 s"); process.exit(1); }
if (!captured) { fail(`the first window was refused (502) and never posted again in 90 s — the outbox retry is gone (${posts.length} post(s) seen)`); process.exit(1); }
if (captured.run?.winIdx !== posts[0].run?.winIdx) fail(`the retry carried window ${captured.run?.winIdx}, not the refused window ${posts[0].run?.winIdx}`);
if (!captured.beacon || captured.beacon.failed < 1 || captured.beacon.lastStatus !== 502 || captured.beacon.attempt !== 2) fail(`the ledger does not say the first post failed with 502: ${JSON.stringify(captured.beacon)}`);
if (!fails.length) fail("the refused post was not told to /api/perf/fail");
else { let note = null; try { note = JSON.parse(fails[0]); } catch { fail("the /api/perf/fail note is not JSON"); } if (note && (note.status !== 502 || note.runId !== posts[0].run?.runId)) fail(`the fail note carries ${fails[0].slice(0, 120)}`); }
console.log(`delivery: window ${posts[0].run?.winIdx} refused once, re-posted after ${posts.length - 1} attempt(s); ledger ${JSON.stringify(captured.beacon)}; fail notes ${fails.length}`);

const dir = mkdtempSync(join(tmpdir(), "beacon-"));
const bodyPath = join(dir, "body.json");
writeFileSync(bodyPath, JSON.stringify(captured));
// The allowlist is TypeScript: run it under tsx from the server package.
const out = execFileSync("npx", ["tsx", "-e", `import { perfReport } from './src/perfreport.ts'; import fs from 'node:fs'; process.stdout.write(JSON.stringify(perfReport(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')), new Date().toISOString())));`, bodyPath], { cwd: join(here, "..", "server"), encoding: "utf8" });
const rep = JSON.parse(out);

// Every block the client sends, with the keys that must come through.
const MUST = {
  frames: ["n", "p50", "p90", "p99", "max", "le17", "gt100", "mean", "rafHz"],
  // `preUpdate`/`hooks`: the scene's own event listeners (Phaser's systems, the ambient mount), 2026-09-19.
  sections: ["render", "preUpdate", "hooks"],
  counts: ["occluders", "occMean", "dlMean", "litOccMean", "monActMean", "flushMean", "sceneryImgsMean", "glTexNew", "capSwitch", "longN", "glDraws", "glFillMpx", "glFbSw", "glClears", "rafLagMean"],
  run: ["runId", "winIdx", "sinceLoadS", "visible", "zone", "hops", "moveFrac", "travelCells", "ua", "fade", "ambient", "lane"],
  rtt: ["n", "p50", "p90", "max", "patches", "patchHz", "reconnects"],
  cpu: ["bench", "scoreMs"],
  gpu: ["avail", "reason", "method", "every", "n", "p50"],
  texFam: [], texUp: ["n", "installed"], net: [], worker: ["state"], heap: ["meanMb", "grewMbPerSec", "drops"],
  lights: ["n", "gpu", "torch"], groundDrew: ["cells", "blits", "blitMpx", "scissor", "fades", "fadeTex"], longBy: [], longWhere: [],
  // 2026-09-19, for his run on the new code: the resolver's own bill, the felt lag, the ambient effects' meter.
  resolve: ["cells", "ms", "usPerCell", "boundaries", "fadeScans", "fadeVisits", "fades", "worker"],
  input: ["avail", "n", "slow", "delayP90", "durMax", "worst"],
  ambient: [],
  longWhy: ["n", "wait", "task", "gc", "taskMs", "waitIdleMs", "gcMb"],
  // 2026-09-19: the client's own delivery ledger — a lost window is never silent again.
  beacon: ["sent", "ok", "failed", "retried", "lastStatus", "lastError", "lastOkWin", "queued", "attempt"],
  // The browser's split of the long frames (perfloaf.ts): `state` first, and
  // headless Chromium has the entries, so `n` must be a number here too.
  loaf: ["state", "n", "pre", "raf", "dom"], loafBy: [], longGroup: [],
  // The ambient block (2026-09-23): the mode row, the mount's own parts and the
  // zone field's counters — 30 rows against a cap that used to be 24.
  ambient: ["_", "_env", "_gloom", "_director", "_frame", "_zone"],
};
let ok = 0;
for (const [block, keys] of Object.entries(MUST)) {
  const sent = captured[block];
  const kept = rep[block];
  if (sent === undefined || sent === null) { fail(`the client no longer sends \`${block}\``); continue; }
  if (kept === undefined || kept === null) { fail(`\`${block}\` was sent and the allowlist dropped it whole`); continue; }
  for (const k of keys) if (kept[k] === undefined || kept[k] === null) fail(`\`${block}.${k}\` was sent (${JSON.stringify(sent[k])}) and did not reach the file`);
  // A cap one short: every scalar key sent must arrive (mixed/flat keep the first N).
  const sentScalar = Object.entries(sent).filter(([, v]) => typeof v === "number" || typeof v === "boolean" || typeof v === "string").map(([k]) => k);
  const lost = sentScalar.filter((k) => kept[k] === undefined);
  if (lost.length) fail(`\`${block}\` lost ${lost.length} scalar key(s) to the allowlist cap: ${lost.join(", ")}`);
  ok++;
}
// A WORST-FRAME RECORD MUST ARRIVE WHOLE. It is JSON in a string with a
// length cap, and the cap has twice cut off the tail — which is where the
// evidence lives (`mode`, `ring`, `tex`, and now `at`/`z`/`t`).
// THE GPU CLOCK (2026-09-19): headless Chromium lends no timer query either,
// and until today that meant gpu.avail=false and no GPU number at all. The
// finish clock must stand in: avail, method "finish", and samples taken.
if (!rep.gpu?.avail || rep.gpu.method !== "finish") fail(`no GPU clock without a timer query: ${JSON.stringify(rep.gpu)}`);
else if (!(rep.gpu.n > 0)) fail(`the finish clock took no samples: ${JSON.stringify(rep.gpu)}`);
if (rep.lights && rep.lights.pass === undefined) fail("lights.pass (the lighting-pass switch) did not reach the file");
const w0 = (rep.worst ?? [])[0];
if (!w0) fail("no worst frame reached the file — the hitch recorder rides with the beacon");
else {
  let parsed = null;
  try { parsed = JSON.parse(w0); } catch { fail(`the first worst record is truncated JSON (${w0.length} chars) — raise the cap`); }
  if (parsed) for (const k of ["total", "sec", "mode", "at", "z", "t", "dl", "occ", "gl", "lag"]) if (parsed[k] === undefined) fail(`worst[0].${k} did not reach the file`);
  // The GPU counters ride inside `gl` (glframe.ts): draws and the fill estimate.
  if (parsed?.gl) for (const k of ["dc", "vt", "fill"]) if (parsed.gl[k] === undefined) fail(`worst[0].gl.${k} did not reach the file`);
  // The longest record must survive the cap whole, not only the first.
  for (const w of rep.worst ?? []) { try { JSON.parse(w); } catch { fail(`a worst record is truncated JSON (${w.length} chars) — raise the cap`); break; } }
}
// The LoAF observer must be ON in Chromium — "unsupported" here means the
// entry type name or the observe() call broke, not that the browser lacks it.
if (rep.loaf && rep.loaf.state !== "on") fail(`loaf.state is "${rep.loaf.state}" in Chromium — the observer did not arm`);
console.log(`beacon: ${ok}/${Object.keys(MUST).length} blocks survive the allowlist; frames n=${rep.frames?.n}, rtt n=${rep.rtt?.n}, gpu ${rep.gpu?.avail ? `p50 ${rep.gpu.p50} ms` : rep.gpu?.reason}, cpu ${rep.cpu?.scoreMs} ms, worst ${(rep.worst ?? []).length} frames, longWhere ${Object.keys(rep.longWhere ?? {}).length} blocks, why ${rep.run?.why}`);
console.log(`  loaf ${rep.loaf?.state} n=${rep.loaf?.n} pre/raf/dom ${rep.loaf?.pre}/${rep.loaf?.raf}/${rep.loaf?.dom} ms, by ${JSON.stringify(rep.loafBy)}; longGroup ${JSON.stringify(rep.longGroup)}; gl draws/frame ${rep.counts?.glDraws} fill ${rep.counts?.glFillMpx} Mpx fb ${rep.counts?.glFbSw} clears ${rep.counts?.glClears} reads ${rep.counts?.glReads}; gap ${Object.entries(rep.counts ?? {}).filter(([k]) => k.startsWith("gap")).map(([k, v]) => `${k}=${v}`).join(" ")}; rafLag ${rep.counts?.rafLagMean}/${rep.counts?.rafLagMax}`);
if (process.exitCode) console.error("the eaten-field trap: add the field on BOTH sides in the same commit (docs/perf.md)");
