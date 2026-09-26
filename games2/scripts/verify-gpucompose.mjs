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
  await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 600000, polling: 250 });
  await page.evaluate(() => { try { window.__ml.noAggro(true); } catch {} });
  // AND WHERE THE SLOPES ARE: every cell of the world whose transition wears a
  // slope (Tiles3Boundary.slope), clustered, a few clusters visited — the
  // slope boundaries shift a side and leave holes, the GPU's hardest case.
  if (process.env.SLOPESPOTS) await page.evaluate((n) => { window.__gateSlopeSpots = n; }, +process.env.SLOPESPOTS);
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
  for (const [c, r] of process.env.TILES === "0" ? [] : walked) {
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
  const cpuHash = process.env.TILES === "0" ? null : await hashAt(page);
  // TILES=0 skips the per-tile half (the ground half below is the direct draw's test)
  const rep = process.env.TILES === "0" ? null : await page.evaluate(() => window.__ml.gpuParity());
  if (rep) console.log(JSON.stringify(rep, null, 1));
  if (!rep) console.log("per-tile parity skipped (TILES=0)");
  else if (!rep.compared || !rep.opaque || !rep.inked) { console.log(`FAIL: vacuous (${rep.compared} tiles, ${rep.opaque} opaque texels, ${rep.inked} inked)`); bad = true; }
  else if (!rep.ramps || !rep.rampsLined || !rep.linedPlates) { console.log(`FAIL: no ramp compared (${rep.ramps} ramps, ${rep.rampsLined} lined)`); bad = true; }
  else if (rep.tilesDiffering) { console.log(`FAIL: ${rep.tilesDiffering} of ${rep.compared} tiles differ (${rep.texelsDiffering} texels, max ${rep.maxDiff})`); bad = true; }
  else console.log(`ok: ${rep.compared} boundaries and ${rep.ramps} ramps (${rep.rampsLined} lined, ${rep.rampsOnTransition} lifting a transition; ${rep.linedPlates} of them flat tops with their outline) identical byte for byte (${rep.slopes} on slopes; ${rep.opaque} opaque texels, ${rep.inked} of them outline ink; ${rep.unsupported} slope jobs left to the CPU), GPU ${rep.gpuMs} ms`);
  // ── THE GAME WITH THE SWITCH ON: every transition on the ground composed by
  // the GPU compositor (tiles3gpu GpuComposer) and landed the worker's way —
  // the painted ground must hash the same as the worker's.
  if (process.env.INTEGRATED !== "0") {
    const OUT = process.env.OUT || "/tmp";
    const { writeFileSync } = await import("node:fs");
    const { PNG } = await import("pngjs");
    const snap = async (pg) => { await settle(pg); const h = await pg.evaluate(() => window.__ml.groundHash()); const s = await pg.evaluate(() => window.__ml.groundSnapshot()); return { h, png: PNG.sync.read(Buffer.from(s.url.split(",")[1], "base64")) }; };
    const walkPage = async (gpu, name) => {
      const pg = await (await browser.newContext({ viewport: { width: 393, height: 851 }, serviceWorkers: "block" })).newPage();
      pg.on("pageerror", (e) => { console.log(`PAGEERROR (${name})`, e.message); bad = true; });
      // A NAME OF ITS OWN: one name is one live session (the server's law), and
      // the control page still holds its seat while this one joins.
      await pg.addInitScript(([sl, g, nm]) => { localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: nm })); sessionStorage.setItem("ml-rejoin", "1"); localStorage.setItem("ml-turn-warm", "0"); localStorage.setItem("ml-gpu-compose", g ? "1" : "0"); if (sl) localStorage.setItem("ml-slope-height3", sl); }, [SLOPE, gpu, name === "gpu" ? "Gpu" : "Ctl"]);
      await pg.goto(origin + "/", { waitUntil: "commit" });
      await pg.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 600000, polling: 250 });
      await pg.evaluate(() => { try { window.__ml.noAggro(true); } catch {} });
      for (const [c, r] of walked) { await pg.evaluate(([c, r]) => window.__ml.teleport(c + 0.5, r + 0.5), [c, r]); await settle(pg); }
      return pg;
    };
    const diff = (A, B, name) => {
      if (A.width !== B.width || A.height !== B.height) return { n: -1 };
      const D = new PNG({ width: A.width, height: A.height });
      let n = 0, box = [1e9, 1e9, -1, -1];
      for (let i = 0; i < A.data.length; i += 4) {
        const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]), Math.abs(A.data[i + 3] - B.data[i + 3]));
        const k = i / 4, x = k % A.width, y = Math.floor(k / A.width);
        if (d) { n++; D.data[i] = 255; D.data[i + 3] = 255; box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)]; }
        else { D.data[i] = D.data[i + 1] = D.data[i + 2] = A.data[i] >> 2; D.data[i + 3] = 255; }
      }
      writeFileSync(`${OUT}/ground_${name}_diff.png`, PNG.sync.write(D));
      return { n, box };
    };
    // ONE PAGE AT A TIME, each closed before the next joins (three open pages on
    // one machine timed the last one out): a fresh page with the switch OFF and
    // a fresh page with it ON walk the same spots; the grounds are compared over
    // the WORLD REGION both textures cover (each anchors where its camera is).
    await page.close();
    const run = async (gpu, name) => {
      const pg = await walkPage(gpu, name);
      const sn = await snap(pg);
      const st = gpu ? await pg.evaluate(() => window.__ml.gpuCompose()) : null;
      const why = await pg.evaluate(() => { const g = window.__ml.groundScroll(); let cw = null; try { cw = window.__ml.composeWorker(); } catch (e) { cw = String(e); } return { drain: g.drain, ring: g.ring, cw }; });
      console.log(`[${name}] state at the snapshot:`, JSON.stringify(why));
      await pg.close();
      return { ...sn, st };
    };
    const off = await run(false, "control");
    const on = await run(true, "gpu");
    console.log("gpu compositor on the game page:", JSON.stringify(on.st));
    // THE DIRECT DRAW: the ground painted transitions, ramps and lined tops as
    // quads of its own batch — none of them may have been a composed texture
    const dd = on.st?.direct;
    if (!dd || !dd.boundaries || !dd.ramps || !dd.quads) { console.log(`FAIL: the direct draw painted nothing (${JSON.stringify(dd)})`); bad = true; }
    const A = off.png, B = on.png, aa = off.h.anchor, ba = on.h.anchor;
    const x0 = Math.max(aa.x, ba.x), y0 = Math.max(aa.y, ba.y), x1 = Math.min(aa.x + A.width, ba.x + B.width), y1 = Math.min(aa.y + A.height, ba.y + B.height);
    if (x1 - x0 < 256 || y1 - y0 < 256) { console.log(`INCONCLUSIVE: the two grounds share only ${x1 - x0}x${y1 - y0} px`); bad = true; }
    else {
      const D = new PNG({ width: x1 - x0, height: y1 - y0 });
      let n = 0, box = [1e9, 1e9, -1, -1];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const o = ((y - aa.y) * A.width + x - aa.x) * 4, q = ((y - ba.y) * B.width + x - ba.x) * 4, w = ((y - y0) * D.width + x - x0) * 4;
        const d = Math.max(Math.abs(A.data[o] - B.data[q]), Math.abs(A.data[o + 1] - B.data[q + 1]), Math.abs(A.data[o + 2] - B.data[q + 2]), Math.abs(A.data[o + 3] - B.data[q + 3]));
        if (d) { n++; D.data[w] = 255; D.data[w + 3] = 255; box = [Math.min(box[0], x - x0), Math.min(box[1], y - y0), Math.max(box[2], x - x0), Math.max(box[3], y - y0)]; }
        else { D.data[w] = D.data[w + 1] = D.data[w + 2] = A.data[o] >> 2; D.data[w + 3] = 255; }
      }
      writeFileSync(`${OUT}/ground_gpu_diff.png`, PNG.sync.write(D));
      writeFileSync(`${OUT}/ground_cpu.png`, PNG.sync.write(A));
      writeFileSync(`${OUT}/ground_gpu.png`, PNG.sync.write(B));
      if (n) { console.log(`FAIL: the painted ground differs with GPU transitions on: ${n} of ${(x1 - x0) * (y1 - y0)} texels ${JSON.stringify(box)}; ${OUT}/ground_gpu_diff.png`); bad = true; }
      else console.log(`ok: the painted ground is identical with GPU transitions on (${x1 - x0}x${y1 - y0} px compared)`);
    }
  }
} finally {
  await browser.close();
  stop();
}
process.exit(bad ? 1 : 0);
