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
const page = await browser.newPage({ viewport: { width: 500, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror", e.message));
let captured = null;
await page.route("**/api/perf", async (route) => { captured = route.request().postDataJSON(); await route.fulfill({ status: 200, body: "{}" }); });
await page.goto(`http://localhost:${PORT}/?perf=1#the_game`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 120000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 120000 });
await page.evaluate(() => window.__ml.noAggro?.(true));
// The beacon posts a window only after the body has MOVED (>= 2 cells): walk it.
for (let i = 0; i < 8 && !captured; i++) { await page.evaluate((i) => window.__ml.teleport(261.8 - i * 2, 219.3), i); await page.waitForTimeout(6000); }
await page.waitForTimeout(3000);
await browser.close();
if (!captured) { fail("no POST to /api/perf was captured in 50 s"); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), "beacon-"));
const bodyPath = join(dir, "body.json");
writeFileSync(bodyPath, JSON.stringify(captured));
// The allowlist is TypeScript: run it under tsx from the server package.
const out = execFileSync("npx", ["tsx", "-e", `import { perfReport } from './src/perfreport.ts'; import fs from 'node:fs'; process.stdout.write(JSON.stringify(perfReport(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')), new Date().toISOString())));`, bodyPath], { cwd: join(here, "..", "server"), encoding: "utf8" });
const rep = JSON.parse(out);

// Every block the client sends, with the keys that must come through.
const MUST = {
  frames: ["n", "p50", "p90", "p99", "max", "le17", "gt100", "mean", "rafHz"],
  sections: ["render"],
  counts: ["occluders", "occMean", "dlMean", "litOccMean", "monActMean", "flushMean", "sceneryImgsMean", "glTexNew", "capSwitch", "longN"],
  run: ["runId", "winIdx", "sinceLoadS", "visible", "zone", "hops", "moveFrac", "travelCells", "ua", "occ"],
  rtt: ["n", "p50", "p90", "max", "patches", "patchHz", "reconnects"],
  cpu: ["bench", "scoreMs"],
  gpu: ["avail", "reason", "n", "p50"],
  texFam: [], texUp: ["n", "installed"], net: [], worker: ["state"], heap: ["meanMb", "grewMbPerSec", "drops"],
  lights: ["n", "gpu", "torch"], groundDrew: ["cells", "blits"], longBy: [], longWhere: [],
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
const w0 = (rep.worst ?? [])[0];
if (!w0) fail("no worst frame reached the file — the hitch recorder rides with the beacon");
else {
  let parsed = null;
  try { parsed = JSON.parse(w0); } catch { fail(`the first worst record is truncated JSON (${w0.length} chars) — raise the cap`); }
  if (parsed) for (const k of ["total", "sec", "mode", "at", "z", "t", "dl", "occ"]) if (parsed[k] === undefined) fail(`worst[0].${k} did not reach the file`);
}
console.log(`beacon: ${ok}/${Object.keys(MUST).length} blocks survive the allowlist; frames n=${rep.frames?.n}, rtt n=${rep.rtt?.n}, gpu ${rep.gpu?.avail ? `p50 ${rep.gpu.p50} ms` : rep.gpu?.reason}, cpu ${rep.cpu?.scoreMs} ms, worst ${(rep.worst ?? []).length} frames, longWhere ${Object.keys(rep.longWhere ?? {}).length} blocks, why ${rep.run?.why}`);
if (process.exitCode) console.error("the eaten-field trap: add the field on BOTH sides in the same commit (docs/perf.md)");
