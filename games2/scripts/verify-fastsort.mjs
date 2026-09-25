// THE FAST DEPTH SORT, headless (client/src/fastsort.ts; `?fastsort=0` is Phaser's own sort).
//
// ORDER PARITY, the proof: with ambient ON and monsters ON — every mover the harness freezes —
// walk his loop's spots with the keyboard (bodies turn, critters fly, a 96 px drift rebuilds the
// occluder set: hundreds of images removed and appended) with `__ml.sortParity(true)` armed: after
// EVERY fast sort the page sorts a copy of the list with Phaser's StableSort and compares object by
// object. Pass: 0 disagreeing sorts over at least 500 checked.
//
// COST: the same walk in fresh pages with the switch off and on and the gate disarmed (its check
// runs outside the timed span anyway), `depthSort` from the perf accumulators (per frame, worst).
// The frames DRAW NOTHING while walking (the render A/B harness's fast settle: renderer.render gets
// an empty list; the sort runs before it, over the whole list) — SwiftShader draws ~1-2 frames a
// second at this size, and the gate needs hundreds of sorts.
// Needs a built client (`npm run manifest && cd client && npx vite build`). Exit 1 on any mismatch.
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

// His loop (2026-09-25 07:19 run), the W6 hot spot, the cliff.
const SPOTS = [[297, 90], [182, 101], [111, 174], [100, 256], [198, 267], [320, 241], [326, 235], [224, 246], [258.5, 217.5]];
const spots = process.argv.includes("--spots") ? SPOTS.slice(0, Number(process.argv[process.argv.indexOf("--spots") + 1])) : SPOTS;
const WALK = [["d", 1400], ["s", 1400], ["a", 1400], ["w", 1400], ["d", 700], ["w", 700]];

async function open(fast) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 732 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((f) => {
    localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "B" }));
    sessionStorage.setItem("ml-rejoin", "1");
    localStorage.setItem("ml-fastsort", f);
  }, fast);
  await page.goto(origin + "/", { waitUntil: "commit" });
  await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 180000, polling: 100 });
  await page.evaluate(() => {
    const r = window.__mlGame.renderer;
    const orig = r.render;
    r.render = function (scene, children, camera) { return orig.call(this, scene, [], camera); };
  });
  return { ctx, page, errors };
}

async function walk(page) {
  for (const [key, ms] of WALK) {
    await page.keyboard.down(key);
    await sleep(ms);
    await page.keyboard.up(key);
  }
}

let bad = 0;
let checked = 0;
const cost = {};
for (const [fast, gate] of [["1", true], ["0", false], ["1", false]]) {
  const { ctx, page, errors } = await open(fast);
  const sw = await page.evaluate(() => window.__ml.fastSort());
  console.log(`=== fastsort ${fast === "1" ? "ON" : "OFF"}${gate ? " + PARITY GATE" : " (cost)"} (switch reads ${sw.on})`);
  if (gate) await page.evaluate(() => window.__ml.sortParity(true));
  let ms = 0, n = 0, max = 0;
  for (const [x, y] of spots) {
    await page.evaluate(([a, b]) => window.__ml.teleport(a, b), [x, y]);
    await sleep(6000); // land, stream, settle the first rebuild
    await page.evaluate(() => window.__ml.perf(true));
    await walk(page);
    const pf = await page.evaluate(() => window.__ml.perf());
    const ds = pf.sections.depthSort ?? { n: 0, totalMs: 0, maxMs: 0 };
    ms += ds.totalMs; n += pf.frames.n; max = Math.max(max, ds.maxMs);
    let line = `${x},${y}: ${pf.frames.n} frames, list ${pf.counts.displayList}, depthSort ${(ds.totalMs / Math.max(1, pf.frames.n)).toFixed(2)} ms/frame (worst ${ds.maxMs})`;
    if (gate) {
      const p = await page.evaluate(() => window.__ml.sortParity());
      const f = p.fast;
      line += ` | parity: ${p.checked} sorts checked, ${p.bad} disagree${p.sample ? " — " + p.sample : ""} | sorter: noop ${f.noop} window ${f.window} merge ${f.merge} native ${f.native}, dirty mean ${(f.dirty / Math.max(1, f.window + f.merge)).toFixed(1)} max ${f.maxDirty}, slots/window ${(f.windowSlots / Math.max(1, f.window)).toFixed(0)} | ms noop ${f.noopMs.toFixed(1)} window ${f.windowMs.toFixed(1)} merge ${f.mergeMs.toFixed(1)}`;
    }
    console.log("  " + line);
  }
  if (gate) {
    const p = await page.evaluate(() => window.__ml.sortParity());
    bad += p.bad;
    checked += p.checked;
  } else cost[fast] = { perFrame: ms / Math.max(1, n), worst: max };
  if (errors.length) { console.log(`  PAGE ERRORS: ${errors.slice(0, 3).join(" | ")}`); bad++; }
  await ctx.close();
}
console.log(`COST depthSort: off ${cost["0"].perFrame.toFixed(3)} ms/frame (worst ${cost["0"].worst}), on ${cost["1"].perFrame.toFixed(3)} ms/frame (worst ${cost["1"].worst})`);
const ok = !bad && checked >= 500;
console.log(ok ? `FASTSORT OK — ${checked} sorts, every one Phaser's order` : `FASTSORT FAILED — ${bad} disagreeing sort(s) or page errors over ${checked} checked (need >= 500)`);
await browser.close();
stop();
process.exit(ok ? 0 : 1);
