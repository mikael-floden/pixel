// WHAT THE PERF RECORDER COSTS THE GAME'S THREAD, AND WHERE, headless (maintainer 2026-09-25: "I
// can't have a lag that is due to the perf run itself when I try to evaluate the performance").
//
// Arms the beacon (?perf=1) in fresh pages, walks (a window posts only after the body moved),
// answers every POST itself (nothing reaches the server or GitHub), and after each window reads
// `__ml.beaconCost()`. The report is built in an idle period after the frame that finds a window
// due (`total`: the snapshot, the body, the worst frames taken; the ground census only on the
// final flush) and posted in another (`post`: on this thread only the hand-over to the report's
// worker, three JSON strings and the packed timelines — the worst frames shaped, the wire JSON and
// the fetch run THERE, `worker` ms). `?perfworker=0` is the round-1 way, everything on this thread. `overMs` is how far any of it ran past its idle
// period — what could still have delayed a frame. On a saturated phone there IS no idle period
// (his 15:51 run: 58-95 ms, all of it over), so the number that matters is what stays on this
// thread: `total + post`.
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

for (const [label, wk] of [["the post on this thread (round 1)", "0"], ["the post on its worker (round 2)", "1"]]) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 732 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  let posts = 0;
  const bodies = [];
  await page.route("**/api/perf", async (route) => { posts++; bodies.push(route.request().postData() ?? ""); await route.fulfill({ status: 200, body: "{}" }); });
  await page.route("**/api/perf/fail", (route) => route.fulfill({ status: 202, body: "{}" }));
  await page.addInitScript(() => {
    localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "B" }));
    sessionStorage.setItem("ml-rejoin", "1");
  });
  await page.goto(`${origin}/?perf=1&perfworker=${wk}`, { waitUntil: "commit" });
  await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 180000, polling: 100 });
  console.log(`=== ${label}`);
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
      console.log(`  window ${rows.length}: report ${c.total} ms (snapshot ${c.snap}, worst frames taken ${c.worst}, the body ${c.build}) | post ${d.idle} ms on this thread (JSON ${d.wire})${wk === "0" ? "" : ` + ${d.workerMs} ms on the worker (state ${d.worker})`}, ${(d.bytes / 1024).toFixed(0)} KB | THIS THREAD ${(c.total + d.idle).toFixed(1)} ms | cpu score ${d.cpuScore} | past an idle period: ${d.overMs} ms`);
    }
  }
  // Every body that arrived must parse and carry its worst frames shaped (tl compacted, no _t0/_tl).
  let bad = 0;
  for (const b of bodies) {
    try {
      const j = JSON.parse(b);
      if (Array.isArray(j.worst) && j.worst.some((r) => "_t0" in r || "_tl" in r)) bad++;
    } catch { bad++; }
  }
  console.log(`  posts answered: ${posts}, malformed: ${bad}`);
  await ctx.close();
}
await browser.close();
stop();
