// WHAT THE PERF RECORDER COSTS, AND WHERE, headless (maintainer 2026-09-25: "I can't have a lag
// that is due to the perf run itself when I try to evaluate the performance").
//
// Arms the beacon (?perf=1) in fresh pages, walks (a window posts only after the body moved),
// answers every POST itself (nothing reaches the server or GitHub), and after each window reads
// `__ml.beaconCost()`. The report is built in an idle period after the frame that finds a window
// due (`total`: the snapshot, the body, the worst frames taken, the ground census), posted in
// another (`idle`: the worst frames shaped, the JSON, the send), and the CPU benchmark runs in a
// third; `overMs` is how far any of them ran past its idle period — what could still have delayed
// a frame. Run with the ground census every window (`?beaconquiet=0`, the old way) and on the
// final flush only (the default). SwiftShader's GPU is the CPU, so the census's GPU sync is dear
// here too; on his Mali it was the bulk of `beaconSelfMs` 34-65 ms.
// Needs a built client. Prints per window; exit 0.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 3300 + Math.floor(Math.random() * 40);
const origin = `http://127.0.0.1:${port}`;
// LIVE_GH_API points nowhere: a report that did reach the server could never be committed.
const child = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], { cwd: join(ROOT, "server"), detached: true, env: { ...process.env, PORT: String(port), SERVE_CLIENT: "1", NODE_ENV: "production", WIKI_GITHUB_TOKEN: "", LIVE_GH_API: "http://127.0.0.1:9" }, stdio: "ignore" });
const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
process.on("exit", stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let t0 = Date.now(); ; ) { try { if ((await fetch(origin + "/health")).ok) break; } catch { /* not up */ } if (Date.now() - t0 > 90000) throw new Error("unhealthy"); await sleep(500); }
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-webgl", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader"] });
const WINDOWS = Number(process.argv[process.argv.indexOf("--windows") + 1]) || 3;

for (const [label, quiet] of [["census every window (old)", "0"], ["census on the final flush (new)", "1"]]) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 732 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  let posts = 0;
  await page.route("**/api/perf", async (route) => { posts++; await route.fulfill({ status: 200, body: "{}" }); });
  await page.route("**/api/perf/fail", (route) => route.fulfill({ status: 202, body: "{}" }));
  await page.addInitScript(() => {
    localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "B" }));
    sessionStorage.setItem("ml-rejoin", "1");
  });
  await page.goto(`${origin}/?perf=1&beaconquiet=${quiet}`, { waitUntil: "commit" });
  await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 180000, polling: 100 });
  console.log(`=== ${label} (switch reads quiet=${(await page.evaluate(() => window.__ml.beaconCost())).quiet})`);
  let last = -1;
  const rows = [];
  for (let i = 0; rows.length < WINDOWS && i < 80; i++) {
    await page.evaluate((k) => window.__ml.teleport(261.8 - (k % 12) * 2, 219.3 + Math.floor(k / 12)), i);
    await sleep(3000);
    const c = await page.evaluate(() => window.__ml.beaconCost());
    if (c.total && c.total !== last) {
      last = c.total;
      rows.push(c);
      await sleep(3500); // the post runs in a later idle period (3 s timeout)
      const d = await page.evaluate(() => window.__ml.beaconCost());
      console.log(`  window ${rows.length}: report ${c.total} ms in idle = snapshot ${c.snap} + ground census ${c.ground} + worst frames taken ${c.worst} + the body ${c.build} | post ${d.idle} ms in idle (JSON ${d.wire}, ${(d.bytes / 1024).toFixed(0)} KB, the send) | cpu score ${d.cpuScore} | past an idle period: ${d.overMs} ms`);
    }
  }
  console.log(`  posts answered: ${posts}`);
  await ctx.close();
}
await browser.close();
stop();
