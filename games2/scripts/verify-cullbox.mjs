// THE STORED OCCLUDER BOXES, headless (WorldScene `occBoxes`; `?cullbox=0` reads the getters).
//
// PARITY, the proof: walk his loop's spots with the keyboard (every 96 px of drift rebuilds the
// occluder set — pooled images reused, the delta created) and after every walk leg ask
// `__ml.cullParity()`: every live occluder's eight stored numbers against the getters NOW, exactly,
// and the view cull's decision both ways against this frame's rect. Pass: boxDiffer 0,
// decisionDiffer 0, unboxed 0 over at least 20,000 occluder checks.
//
// COST: the same walk in fresh pages with the switch off and on — `occCull` (the per-frame view
// cull), `coverIndex` (per rebuild) and `rebuildOccluders` (which no longer builds the proximity
// cull's grid while that cull is off) from the perf accumulators. The frames draw nothing while
// walking (as in verify-fastsort.mjs), so the counts are frames of the update, not of SwiftShader.
// Needs a built client. Exit 1 on any mismatch.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 3300 + Math.floor(Math.random() * 40);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], { cwd: join(ROOT, "server"), detached: true, env: { ...process.env, PORT: String(port), SERVE_CLIENT: "1", NODE_ENV: "production" }, stdio: "ignore" });
const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
process.on("exit", stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let t0 = Date.now(); ; ) { try { if ((await fetch(origin + "/health")).ok) break; } catch { /* not up */ } if (Date.now() - t0 > 90000) throw new Error("unhealthy"); await sleep(500); }
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-webgl", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader"] });

const SPOTS = [[297, 90], [182, 101], [111, 174], [100, 256], [198, 267], [320, 241], [326, 235], [224, 246], [258.5, 217.5], [299.5, 194.5]];
const spots = process.argv.includes("--spots") ? SPOTS.slice(0, Number(process.argv[process.argv.indexOf("--spots") + 1])) : SPOTS;
const WALK = [["d", 1400], ["s", 1400], ["a", 1400], ["w", 1400], ["d", 700], ["w", 700]];

async function open(on) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 732 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((f) => {
    localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "B" }));
    sessionStorage.setItem("ml-rejoin", "1");
    localStorage.setItem("ml-cullbox", f);
  }, on);
  await page.goto(origin + "/", { waitUntil: "commit" });
  await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 180000, polling: 100 });
  await page.evaluate(() => {
    const r = window.__mlGame.renderer;
    const orig = r.render;
    r.render = function (scene, children, camera) { return orig.call(this, scene, [], camera); };
  });
  return { ctx, page, errors };
}

let checks = 0;
let bad = 0;
const cost = {};
for (const [on, gate] of [["1", true], ["0", false], ["1", false]]) {
  const { ctx, page, errors } = await open(on);
  const sw = await page.evaluate(() => window.__ml.cullBox());
  console.log(`=== cullbox ${on === "1" ? "ON" : "OFF"}${gate ? " + PARITY GATE" : " (cost)"} (switch reads ${sw.on})`);
  const acc = {};
  let frames = 0;
  for (const [x, y] of spots) {
    await page.evaluate(([a, b]) => window.__ml.teleport(a, b), [x, y]);
    await sleep(6000);
    await page.evaluate(() => window.__ml.perf(true));
    let line = `${x},${y}:`;
    for (const [key, ms] of WALK) {
      await page.keyboard.down(key);
      await sleep(ms);
      await page.keyboard.up(key);
      if (gate) {
        const p = await page.evaluate(() => window.__ml.cullParity());
        checks += p.checked;
        if (p.boxDiffer || p.decisionDiffer || p.unboxed) {
          bad++;
          line += ` [MISMATCH ${JSON.stringify(p).slice(0, 300)}]`;
        }
      }
    }
    const pf = await page.evaluate(() => window.__ml.perf());
    frames += pf.frames.n;
    const sec = (k) => pf.sections[k] ?? { totalMs: 0, maxMs: 0, n: 0 };
    for (const k of ["occCull", "coverIndex", "rebuildOccluders"]) {
      const a = (acc[k] ??= { ms: 0, max: 0 });
      a.ms += sec(k).totalMs;
      a.max = Math.max(a.max, sec(k).maxMs);
    }
    line += ` ${pf.frames.n} frames, occluders ${pf.counts.occluders}, occCull ${(sec("occCull").totalMs / Math.max(1, pf.frames.n)).toFixed(3)} ms/frame, coverIndex ${sec("coverIndex").totalMs.toFixed(1)} ms in ${sec("coverIndex").n}, rebuildOccluders ${sec("rebuildOccluders").totalMs.toFixed(1)} ms (worst ${sec("rebuildOccluders").maxMs})`;
    console.log("  " + line);
  }
  if (!gate) cost[on] = { frames, acc };
  if (errors.length) { console.log(`  PAGE ERRORS: ${errors.slice(0, 3).join(" | ")}`); bad++; }
  await ctx.close();
}
for (const k of ["occCull", "coverIndex", "rebuildOccluders"]) {
  const f = (on) => `${(cost[on].acc[k].ms / Math.max(1, cost[on].frames)).toFixed(3)} ms/frame (worst ${cost[on].acc[k].max})`;
  console.log(`COST ${k}: off ${f("0")}, on ${f("1")}`);
}
const ok = !bad && checks >= 20000;
console.log(ok ? `CULLBOX OK — ${checks} occluder checks, every stored box and decision identical` : `CULLBOX FAILED — ${bad} mismatch(es) or page errors over ${checks} checks (need >= 20,000)`);
await browser.close();
stop();
process.exit(ok ? 0 : 1);
