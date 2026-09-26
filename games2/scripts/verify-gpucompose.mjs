// THE GPU BOUNDARY AGAINST THE CPU COMPOSER (client/src/tiles3gpu.ts): the game
// is walked through a few spots so the compose worker is handed real boundary
// jobs, then every one of them is composed both ways — the CPU with the
// worker's own functions over the same decoded files, the GPU with the three
// passes — and compared BYTE FOR BYTE, all four channels, every texel. Any
// differing texel is a failure. Needs a built client (npm run build:client).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SPOTS = (process.env.SPOTS || "259,253;254,158;275,225;333,232;305,239").split(";").map((s) => s.split(",").map(Number));
const port = 3400 + Math.floor(Math.random() * 40), origin = `http://127.0.0.1:${port}`;
const child = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], { cwd: join(ROOT, "server"), detached: true, env: { ...process.env, PORT: String(port), SERVE_CLIENT: "1", NODE_ENV: "production" }, stdio: ["ignore", "ignore", "ignore"] });
const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
process.on("exit", stop);
for (let t0 = Date.now(); ; ) { try { if ((await fetch(origin + "/health")).ok) break; } catch {} if (Date.now() - t0 > 90000) throw new Error("server unhealthy"); await new Promise((r) => setTimeout(r, 250)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let bad = false;
try {
  const page = await (await browser.newContext({ viewport: { width: 393, height: 851 }, serviceWorkers: "block" })).newPage();
  page.on("pageerror", (e) => { console.log("PAGEERROR", e.message); bad = true; });
  await page.addInitScript(() => { localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "G" })); sessionStorage.setItem("ml-rejoin", "1"); localStorage.setItem("ml-turn-warm", "0"); });
  await page.goto(origin + "/", { waitUntil: "commit" });
  await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 240000, polling: 250 });
  await page.evaluate(() => { try { window.__ml.noAggro(true); } catch {} });
  for (const [c, r] of SPOTS) {
    await page.evaluate(([c, r]) => window.__ml.teleport(c + 0.5, r + 0.5), [c, r]);
    for (let t0 = Date.now(), calm = 0; Date.now() - t0 < 60000; ) {
      const o = await page.evaluate(() => { const g = window.__ml.groundScroll(); return g.drain.bOwed + g.drain.dOwed + g.ring.missing; });
      calm = o === 0 ? calm + 1 : 0;
      if (calm >= 3) break;
      await sleep(700);
    }
  }
  const rep = await page.evaluate(() => window.__ml.gpuParity());
  console.log(JSON.stringify(rep, null, 1));
  if (!rep.compared) { console.log("FAIL: nothing compared"); bad = true; }
  else if (rep.tilesDiffering) { console.log(`FAIL: ${rep.tilesDiffering} of ${rep.compared} tiles differ (${rep.texelsDiffering} texels, max ${rep.maxDiff})`); bad = true; }
  else console.log(`ok: ${rep.compared} boundaries identical byte for byte (${rep.unsupported} slope jobs left to the CPU), GPU ${rep.gpuMs} ms`);
} finally {
  await browser.close();
  stop();
}
process.exit(bad ? 1 : 0);
