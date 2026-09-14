// THE PACKED SCENERY LAYER'S GATE (docs/scenery.md): boot the same spot twice,
// once loading every scenery texture from its packed twin (`?scnpack=1`) and
// once from the raw files (`?scnpack=0`), and compare what the scene MEASURED
// and DREW: every still's placed box and flip, a hash of the texels its cut
// frame shows, every art file's alpha bbox and canvas, every emissive centre.
// Packing may change which texels exist, never one of those numbers. Needs a
// built client. Exit 1 on any difference, or on an ON run that packed nothing.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 3300 + Math.floor(Math.random() * 40);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], { cwd: join(ROOT, "server"), detached: true, env: { ...process.env, PORT: String(port), SERVE_CLIENT: "1", NODE_ENV: "production" }, stdio: ["ignore", "ignore", "ignore"] });
const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
process.on("exit", stop);
for (let t0 = Date.now(); ; ) { try { if ((await fetch(origin + "/health")).ok) break; } catch {} if (Date.now() - t0 > 90000) throw new Error("unhealthy"); await new Promise((r) => setTimeout(r, 250)); }
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The densest scenery windows of the_game (55-67 placements within a 30x22-cell
// view — measured over world.json's 1,387 placements); AT=c,r overrides.
const SPOTS = (process.env.AT ? [process.env.AT] : ["210,118", "162,174", "254,106"]).map((s) => s.split(",").map(Number));

const run = async (on) => {
  // A wide view, so a window holds dozens of stills (docs/testing.md warns
  // against starving a small viewport; this gate reads geometry, not timing).
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((on) => {
    localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "W" }));
    sessionStorage.setItem("ml-rejoin", "1");
    localStorage.setItem("ml-scenery-pack", on ? "1" : "0");
  }, on);
  await page.goto(origin + "/", { waitUntil: "commit" });
  await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 180000, polling: 100 });
  const dumps = [];
  for (const [c, r] of SPOTS) {
    await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [c, r]);
    // Settle: no manifest in flight, every still asked for has landed, and
    // that has held for three polls (the art queue and the loader both stream).
    let calm = 0;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const s = await page.evaluate(() => window.__ml.sceneryPack());
      calm = s.idle && s.asked > 0 && s.resident === s.asked ? calm + 1 : 0;
      if (calm >= 3 && i >= 8) break;
    }
    dumps.push(await page.evaluate(() => window.__ml.sceneryPack({ dump: true })));
  }
  await ctx.close();
  return { dumps, errs };
};

const ON = await run(true);
const OFF = await run(false);
await browser.close();
stop();

let failed = false;
const bad = (m) => { failed = true; console.log("  MISMATCH " + m); };
for (let i = 0; i < SPOTS.length; i++) {
  const a = ON.dumps[i], b = OFF.dumps[i];
  const imgKey = (im) => `${im.frame}|${im.x}|${im.y}|${im.flip}`;
  const offImgs = new Map(b.images.map((im) => [imgKey(im), im]));
  let matched = 0, missing = 0;
  for (const im of a.images) {
    const o = offImgs.get(imgKey(im));
    if (!o) { missing++; continue; }
    matched++;
    if (o.key !== im.key) bad(`${im.frame} @${im.x},${im.y}: texture ${im.key} vs ${o.key}`);
    if (o.w !== im.w || o.h !== im.h) bad(`${im.key} box ${im.w}x${im.h} vs ${o.w}x${o.h}`);
    if (o.hash !== im.hash) bad(`${im.key} ${im.frame}: cut texels differ (${im.hash} vs ${o.hash}; cuts ${JSON.stringify(im.cut)} vs ${JSON.stringify(o.cut)})`);
  }
  const offFits = new Map(b.fits.map((f) => [f.key, f]));
  let fits = 0;
  for (const f of a.fits) {
    const o = offFits.get(f.key);
    if (!o) continue;
    fits++;
    if (JSON.stringify(o.bbox) !== JSON.stringify(f.bbox) || JSON.stringify(o.canvas) !== JSON.stringify(f.canvas))
      bad(`${f.key} fit ${JSON.stringify(f.bbox)} ${JSON.stringify(f.canvas)} vs ${JSON.stringify(o.bbox)} ${JSON.stringify(o.canvas)}`);
  }
  const offLights = new Map(b.lights.map((l) => [l.key, l]));
  let lights = 0, lightsSkipped = 0;
  for (const l of a.lights) {
    const o = offLights.get(l.key);
    if (!o) continue;
    // The centroid is derived against the NOT_LIT sibling when it is resident
    // at the first measure and from the bright pixels alone when it is not
    // (pushSceneryLight caches the first); only the same derivation compares.
    if (o.unlit !== l.unlit) { lightsSkipped++; continue; }
    lights++;
    if (o.cx !== l.cx || o.cy !== l.cy) bad(`${l.key} emissive centre ${l.cx},${l.cy} vs ${o.cx},${o.cy}`);
  }
  console.log(`spot ${SPOTS[i].join(",")}: ON textures ${a.textures} packed ${a.packedTextures} (${a.indexes} indexes, ${a.files} files) ${a.rawMB} -> ${a.packedMB} MB decoded | OFF textures ${b.textures} | stills matched ${matched} missing ${missing} of ${a.images.length} | fits ${fits} lights ${lights} (${lightsSkipped} derived differently, skipped)`);
  if (!a.on || a.packedTextures === 0 || a.indexes === 0) bad("the ON run packed nothing");
  if (matched < Math.max(8, 0.8 * a.images.length)) bad(`too few stills matched (${matched} of ${a.images.length})`);
}
if (ON.errs.length || OFF.errs.length) console.log("page errors:", JSON.stringify([...ON.errs, ...OFF.errs].slice(0, 3)));
console.log(failed ? "verify-scenery-pack: FAILED" : "verify-scenery-pack: OK — packing changed no measurement, no box, no cut texel");
process.exit(failed ? 1 : 0);
