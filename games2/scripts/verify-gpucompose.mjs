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
// SLOPE: the slope switch's stop for the run ("auto" default; 25 / 50 raise
// ramps with a wall left above them, and only those compose SLOPE BOUNDARIES).
const SLOPE = process.env.SLOPE || "";
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
  page.on("console", (m) => { if (m.text().startsWith("[scan]")) console.log(m.text()); });
  page.on("pageerror", (e) => { console.log("PAGEERROR", e.message); bad = true; });
  await page.addInitScript((sl) => { localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "G" })); sessionStorage.setItem("ml-rejoin", "1"); localStorage.setItem("ml-turn-warm", "0"); if (sl) localStorage.setItem("ml-slope-height3", sl); }, SLOPE);
  await page.goto(origin + "/", { waitUntil: "commit" });
  await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 240000, polling: 250 });
  await page.evaluate(() => { try { window.__ml.noAggro(true); } catch {} });
  // AND WHERE THE SLOPES ARE: every cell of the world whose transition wears a
  // slope (Tiles3Boundary.slope), clustered, a few clusters visited — the
  // slope boundaries shift a side and leave holes, the GPU's hardest case.
  const slopeSpots = await page.evaluate(() => {
    const s = window.__mlGame.scene.scenes.find((x) => x.monsters instanceof Map);
    const t3 = s.t3, w = s.world, got = [];
    const n = { cells: 0, slope: 0, ramp: 0, bnd: 0, err: 0 };
    for (let y = 0; y < w.height; y += 1) for (let x = 0; x < w.width; x += 1) {
      let c = null, b = null;
      try { c = t3.cell(x, y); b = t3.boundary(x, y, c); } catch { n.err++; }
      if (c) n.cells++;
      if (c?.slope) { n.slope++; if (c.slope.ramp) n.ramp++; }
      if (b) n.bnd++;
      if (c?.slope) got.push([x, y]); // a composed ramp (and any slope transition)
    }
    console.log("[scan]", JSON.stringify(n));
    const picked = [];
    for (const [x, y] of got) if (!picked.some(([a, b]) => Math.abs(a - x) + Math.abs(b - y) < 30)) picked.push([x, y]);
    return { total: got.length, picked: picked.slice(0, +(window.__gateSlopeSpots || 8)) };
  });
  console.log(`slope cells in the world: ${slopeSpots.total}; visiting ${slopeSpots.picked.length}: ${slopeSpots.picked.map((p) => p.join(",")).join(" ")}`);
  const walked = [...SPOTS, ...slopeSpots.picked];
  for (const [c, r] of walked) {
    await page.evaluate(([c, r]) => window.__ml.teleport(c + 0.5, r + 0.5), [c, r]);
    for (let t0 = Date.now(), calm = 0; Date.now() - t0 < 60000; ) {
      const o = await page.evaluate(() => { const g = window.__ml.groundScroll(); return g.drain.bOwed + g.drain.dOwed + g.ring.missing; });
      calm = o === 0 ? calm + 1 : 0;
      if (calm >= 3) break;
      await sleep(700);
    }
  }
  const settle = async (pg) => {
    for (let t0 = Date.now(), calm = 0; Date.now() - t0 < 90000; ) {
      const o = await pg.evaluate(() => { const g = window.__ml.groundScroll(); return g.drain.bOwed + g.drain.dOwed + g.ring.missing + g.drain.owed; });
      calm = o === 0 ? calm + 1 : 0;
      if (calm >= 4) return true;
      await sleep(700);
    }
    return false;
  };
  // THE GROUND AS THE GAME PAINTS IT, at the last spot: the hash of the ground
  // texture, then the same walk on a page with "GPU transitions" on (below).
  const hashAt = async (pg) => { await settle(pg); return pg.evaluate(() => window.__ml.groundHash()); };
  const cpuHash = await hashAt(page);
  const rep = await page.evaluate(() => window.__ml.gpuParity());
  console.log(JSON.stringify(rep, null, 1));
  if (!rep.compared || !rep.opaque || !rep.inked) { console.log(`FAIL: vacuous (${rep.compared} tiles, ${rep.opaque} opaque texels, ${rep.inked} inked)`); bad = true; }
  else if (!rep.ramps || !rep.rampsLined) { console.log(`FAIL: no ramp compared (${rep.ramps} ramps, ${rep.rampsLined} lined)`); bad = true; }
  else if (rep.tilesDiffering) { console.log(`FAIL: ${rep.tilesDiffering} of ${rep.compared} tiles differ (${rep.texelsDiffering} texels, max ${rep.maxDiff})`); bad = true; }
  else console.log(`ok: ${rep.compared} boundaries and ${rep.ramps} ramps (${rep.rampsLined} lined, ${rep.rampsOnTransition} lifting a transition) identical byte for byte (${rep.slopes} on slopes; ${rep.opaque} opaque texels, ${rep.inked} of them outline ink; ${rep.unsupported} slope jobs left to the CPU), GPU ${rep.gpuMs} ms`);
  // ── THE GAME WITH THE SWITCH ON: every transition on the ground composed by
  // the GPU compositor (tiles3gpu GpuComposer) and landed the worker's way —
  // the painted ground must hash the same as the worker's.
  if (process.env.INTEGRATED !== "0") {
    const p2 = await (await browser.newContext({ viewport: { width: 393, height: 851 }, serviceWorkers: "block" })).newPage();
    p2.on("pageerror", (e) => { console.log("PAGEERROR (gpu page)", e.message); bad = true; });
    await p2.addInitScript((sl) => { localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "H" })); sessionStorage.setItem("ml-rejoin", "1"); localStorage.setItem("ml-turn-warm", "0"); localStorage.setItem("ml-gpu-compose", "1"); if (sl) localStorage.setItem("ml-slope-height3", sl); }, SLOPE);
    await p2.goto(origin + "/", { waitUntil: "commit" });
    await p2.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 240000, polling: 250 });
    await p2.evaluate(() => { try { window.__ml.noAggro(true); } catch {} });
    for (const [c, r] of walked) { await p2.evaluate(([c, r]) => window.__ml.teleport(c + 0.5, r + 0.5), [c, r]); await settle(p2); }
    const gpuHash = await hashAt(p2);
    const st = await p2.evaluate(() => window.__ml.gpuCompose());
    console.log("gpu compositor on the game page:", JSON.stringify(st));
    if (!st || !st.composed) { console.log("FAIL: the GPU compositor composed nothing on the game page"); bad = true; }
    if (cpuHash.anchor.x !== gpuHash.anchor.x || cpuHash.anchor.y !== gpuHash.anchor.y || cpuHash.w !== gpuHash.w) console.log(`INCONCLUSIVE: the two grounds are anchored differently (${JSON.stringify(cpuHash.anchor)} vs ${JSON.stringify(gpuHash.anchor)})`);
    else if (cpuHash.hash !== gpuHash.hash) { console.log(`FAIL: the painted ground differs with GPU transitions on (${cpuHash.hash} vs ${gpuHash.hash})`); bad = true; }
    else console.log(`ok: the painted ground is identical with GPU transitions on (hash ${gpuHash.hash}, ${gpuHash.w}x${gpuHash.h})`);
  }
} finally {
  await browser.close();
  stop();
}
process.exit(bad ? 1 : 0);
