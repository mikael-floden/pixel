// THE ANATOMY OF A GROUND SLICE, headless: walk the maintainer's worst spot (his 16:50 run:
// 229,256, 12,140 objects on the list) in small steps so the ground scrolls, and print every
// slice the scroll painted — ms, rect, cells walked, blits, ops the clip culled, ops dropped
// for a deferred texture. Reads `__ml.groundSliceLog()`. Needs a built client.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 3300 + Math.floor(Math.random() * 40);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], { cwd: join(ROOT, "server"), detached: true, env: { ...process.env, PORT: String(port), SERVE_CLIENT: "1", NODE_ENV: "production" }, stdio: "ignore" });
const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
process.on("exit", stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let t0 = Date.now(); ; ) { try { if ((await fetch(origin + "/health")).ok) break; } catch { /* not up */ } if (Date.now() - t0 > 90000) throw new Error("unhealthy"); await sleep(500); }
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-webgl", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader"] });
const spots = process.argv.includes("--spot") ? [process.argv[process.argv.indexOf("--spot") + 1].split(",").map(Number)] : [[229, 256], [258, 217], [176, 288]];
// A/B IN TWO FRESH PAGES (a fresh page is a fresh texture cache, so the second run does not inherit the first's plates):
// the two cuts off (`?groundtight=0&grounddefer=0`, the shipped path before 2026-09-24), then on (the default).
for (const [label, on] of [["cuts OFF", false], ["cuts ON", true]]) {
  const params = "";
  const ctx = await browser.newContext({ viewport: { width: 412, height: 732 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.addInitScript(() => { localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "B" })); sessionStorage.setItem("ml-rejoin", "1"); });
  await page.goto(origin + "/" + params, { waitUntil: "commit" });
  await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 180000, polling: 100 });
  const flags = await page.evaluate((v) => ({ tight: window.__ml.groundTight(v), defer: window.__ml.groundDefer(v) }), on);
  console.log(`=== ${label} (tight ${flags.tight}, defer ${flags.defer})`);
  for (const [sx, sy] of spots) {
    await page.evaluate(([x, y]) => window.__ml.teleport(x, y), [sx, sy]);
    await sleep(9000); // the art lands and the first paint settles
    await page.evaluate(() => window.__ml.groundSliceLog());
    const rows = [];
    // Walk east in 1.5-cell steps: the camera scrolls, bands are exposed, slices paint.
    for (let i = 1; i <= 16; i++) {
      await page.evaluate(([x, y]) => window.__ml.teleport(x, y), [sx + i * 1.5, sy]);
      await sleep(350);
      const log = await page.evaluate(() => window.__ml.groundSliceLog());
      for (const r of log) rows.push(r);
    }
    rows.sort((a, b) => b.ms - a.ms);
    const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
    console.log(`spot ${sx},${sy}: ${rows.length} slices, ${sum("ms").toFixed(0)} ms total, worst ${rows[0]?.ms ?? 0} ms, cells ${sum("cells")}, blits ${sum("blits")}, culled ${sum("culled")}, dropped ${sum("dropped")}, compose ${sum("composeMs").toFixed(1)} ms, resolve ${sum("resolveMs").toFixed(1)} ms, ops ${sum("opsMs").toFixed(1)} ms`);
    for (const r of rows.slice(0, 4)) console.log(`  ${String(r.ms).padStart(6)} ms  ${r.w}x${r.h}  cells ${r.cells}  blits ${r.blits}  culled ${r.culled}  dropped ${r.dropped}  compose ${r.composeMs}  resolve ${r.resolveMs}  ops ${r.opsMs}  bnd ${r.boundaries} und ${r.underlays} fad ${r.fades}`);
  }
  await ctx.close();
}
await browser.close();
stop();
