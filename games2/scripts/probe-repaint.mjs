// THE CELL REPAINT, headless (his 21:13 run: cell repaints 350-780 runs a 30 s window at ~13 ms
// each on his phone). At his worst places of that run, in fresh pages with the sized repaint off
// and on (`__ml.groundRect`), print every cell repaint the landings and the walk caused — ms,
// cells, rect, cells walked, blits (`__ml.groundRepaintLog()`) — then the extent check
// (`__ml.groundExtentCheck`): each cell drawn alone must paint nothing above its sized rect.
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
const spots = process.argv.includes("--spot") ? [process.argv[process.argv.indexOf("--spot") + 1].split(",").map(Number)] : [[96, 244], [104, 240], [168, 120], [328, 232]];
let extentBad = 0;
for (const [label, on] of (process.argv.includes("--on-only") ? [["sized repaint ON", true]] : [["sized repaint OFF", false], ["sized repaint ON", true]])) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 732 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.addInitScript((v) => { localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "B" })); sessionStorage.setItem("ml-rejoin", "1"); localStorage.setItem("ml-groundrect", v ? "1" : "0"); }, on);
  await page.goto(origin + "/", { waitUntil: "commit" });
  await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 180000, polling: 100 });
  console.log(`=== ${label} (switch reads ${await page.evaluate(() => window.__ml.groundRect())})`);
  for (const [sx, sy] of spots) {
    await page.evaluate(() => window.__ml.groundRepaintLog());
    await page.evaluate(([x, y]) => window.__ml.teleport(x, y), [sx, sy]);
    const rows = [];
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      if (i >= 8 && i < 20) await page.evaluate(([x, y, k]) => window.__ml.teleport(x, y), [sx + (i - 7) * 1.0, sy + (i - 7) * 0.5]);
      for (const r of await page.evaluate(() => window.__ml.groundRepaintLog())) rows.push(r);
    }
    rows.sort((a, b) => b.ms - a.ms);
    const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
    const mean = (k) => (rows.length ? (sum(k) / rows.length).toFixed(0) : "-");
    console.log(`spot ${sx},${sy}: ${rows.length} repaints, ${sum("ms").toFixed(0)} ms total, worst ${rows[0]?.ms ?? 0} ms | mean rect ${mean("w")}x${mean("h")}, cells ${mean("cells")}, walked ${mean("walked")}, blits ${mean("blits")}`);
    if (on) {
      const ex = await page.evaluate(() => window.__ml.groundExtentCheck(250));
      console.log(`  extent: ${JSON.stringify(ex).slice(0, 400)}`);
      if (ex.error || ex.outside > 0) extentBad++;
    }
  }
  await ctx.close();
}
console.log(extentBad ? `EXTENT: ${extentBad} spot(s) painted above the sized rect` : "EXTENT OK");
await browser.close();
stop();
