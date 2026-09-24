// THE TERRAIN BAKE DRAWS THE SAME TEXELS AS THE SPRITES IT REPLACES (terrainbake.ts), headless:
// at several of the maintainer's spots, once the chunks in view have baked, `__ml.bakeParity(true)`
// draws the baked chunks' ops DIRECTLY in the live path's order and their band images into two
// view-sized textures and compares them texel by texel — the two must be equal. The gate also
// takes the before/after screenshots (bake on, then off) the maintainer asked for (2026-09-24:
// "Test it with before and after images"), writes them and the parity images to --out, and
// requires the bake to have removed sprites (display list smaller with it on). Needs a built
// client (`npm run build -w client`). Exit 1 on any failure.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : join(ROOT, "..", ".bake-out");
mkdirSync(OUT, { recursive: true });
const port = 3300 + Math.floor(Math.random() * 40);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], { cwd: join(ROOT, "server"), detached: true, env: { ...process.env, PORT: String(port), SERVE_CLIENT: "1", NODE_ENV: "production" }, stdio: ["ignore", "ignore", "inherit"] });
const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
process.on("exit", stop);
for (let t0 = Date.now(); ; ) { try { if ((await fetch(origin + "/health")).ok) break; } catch { /* not up */ } if (Date.now() - t0 > 90000) throw new Error("unhealthy"); await new Promise((r) => setTimeout(r, 250)); }
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-webgl", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 412, height: 732 }, serviceWorkers: "block" });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
// A 404 on a resource is the harness's (a missing sound or icon), not the bake's — the other gates ignore it too.
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push("[console] " + m.text().slice(0, 200)); });
await page.addInitScript(() => { localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "B" })); sessionStorage.setItem("ml-rejoin", "1"); localStorage.setItem("ml-bake", "1"); localStorage.removeItem("ml-fps"); });
await page.goto(origin + "/", { waitUntil: "commit" });
await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 180000, polling: 100 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.evaluate(() => window.__ml.noAggro?.(true));
let failed = false;
const fail = (m) => { failed = true; console.log("FAIL: " + m); };
const savePng = (name, dataUrl) => { if (!dataUrl) return; writeFileSync(join(OUT, name), Buffer.from(dataUrl.split(",")[1], "base64")); };
/** Wait until no chunk in the bake is mid-flight (walking/drawing/pending) or the timeout. */
const settle = async (ms) => {
  const t0 = Date.now();
  for (;;) {
    const st = await page.evaluate(() => window.__ml.bakeStates());
    const busy = st.filter((c) => c.state === "walking" || c.state === "drawing" || c.state === "pending" || c.stale).length;
    if (!busy || Date.now() - t0 > ms) return st;
    await sleep(300);
  }
};
const SPOTS = [[230, 230], [258, 217], [277, 269], [304, 200], [176, 288]];
let parityOk = 0;
for (let i = 0; i < SPOTS.length; i++) {
  const [sx, sy] = SPOTS[i];
  await page.evaluate(([x, y]) => window.__ml.teleport(x, y), [sx, sy]);
  await sleep(6000); // the art lands
  const st = await settle(45000); // the harness streams slowly; the bake walks re-try every 1.5 s
  const baked = st.filter((c) => c.state === "baked");
  const notBaked = st.filter((c) => c.state !== "baked");
  const whyCounts = {};
  for (const c of notBaked) { const k = `${c.state}${c.why ? "(" + c.why + ")" : ""}`; whyCounts[k] = (whyCounts[k] ?? 0) + 1; }
  const why = Object.entries(whyCounts).map(([k, n]) => `${n}x ${k}`).join(", ");
  const liveCells = baked.reduce((n, c) => n + c.liveCells, 0);
  const r = await page.evaluate(() => window.__ml.bakeParity(true));
  const oc = await page.evaluate(() => window.__ml.bakeCount());
  console.log(`spot ${sx},${sy}: chunks ${st.length}, baked ${baked.length} (${baked.reduce((n, c) => n + c.images, 0)} images, ${liveCells} cells left live, ${baked.reduce((n, c) => n + c.bakeMs, 0).toFixed(0)} ms of bake)${why ? "; not baked: " + why : ""} | sprites ${oc.live} live + ${oc.bands} bands | parity: ${r.error ?? (r.ok ? "IDENTICAL" : `${r.diff} texels differ, max delta ${r.maxDelta}`)} over ${r.w}x${r.h} (${r.ops} ops, ${r.images} band images, ${r.chunks} chunks)`);
  savePng(`spot${i}-ops.png`, r.pngOps);
  savePng(`spot${i}-bands.png`, r.pngBands);
  savePng(`spot${i}-diff.png`, r.pngDiff);
  if (r.error) fail(`spot ${sx},${sy}: ${r.error}`);
  else if (!r.ok) fail(`spot ${sx},${sy}: ${r.diff} texels differ (max delta ${r.maxDelta}) — see ${OUT}/spot${i}-diff.png`);
  else if (r.chunks === 0) fail(`spot ${sx},${sy}: nothing baked in view (${why})`);
  else parityOk++;
  // The before/after pictures: the frame as it is with the bake, then with the sprites.
  if (i < 3) {
    const on = await page.evaluate(() => window.__ml.bakeCount());
    await page.screenshot({ path: join(OUT, `spot${i}-after-bake.png`) });
    await page.evaluate(() => window.__ml.bake(false));
    await sleep(3000); // the rebuild gives the cells their sprites back
    const off = await page.evaluate(() => window.__ml.bakeCount());
    await page.screenshot({ path: join(OUT, `spot${i}-before-sprites.png`) });
    console.log(`spot ${sx},${sy}: with the bake ${on.live} sprites + ${on.bands} bands (display list ${on.displayList}); with sprites ${off.live} sprites (display list ${off.displayList})`);
    if (r.chunks > 0 && !(on.live + on.bands < off.live)) fail(`spot ${sx},${sy}: the bake did not shrink the terrain's object count (${on.live}+${on.bands} vs ${off.live})`);
    await page.evaluate(() => window.__ml.bake(true));
    await sleep(1500);
  }
}
await browser.close();
stop();
if (errs.length) { console.log("page errors:"); for (const e of errs.slice(0, 8)) console.log("  " + e); fail(`${errs.length} page error(s)`); }
console.log(`verify-bake: ${failed ? "FAILED" : "OK"} — parity identical at ${parityOk}/${SPOTS.length} spots; images in ${OUT}`);
process.exit(failed ? 1 : 0);
