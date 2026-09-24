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
const modeDefer = process.argv.includes("--defer");
const modeLazy = process.argv.includes("--lazy");
if (process.argv.includes("--boundary")) {
  // THE BOUNDARY'S SECOND RESOLVE: at his places, slopes off and on, every nearby cell's boundary
  // resolved the old way and with the cached cell passed in — equal, and timed.
  let differ = 0;
  for (const slope of ["0", "100"]) {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 732 }, serviceWorkers: "block" });
    const page = await ctx.newPage();
    await page.addInitScript((sl) => { localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "B" })); sessionStorage.setItem("ml-rejoin", "1"); localStorage.setItem("ml-slope-height", sl); }, slope);
    await page.goto(origin + "/", { waitUntil: "commit" });
    await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 180000, polling: 100 });
    for (const [x, y] of [[297, 252], [96, 244], [168, 120], [258, 217], [441, 364]]) {
      await page.evaluate(([a, b]) => window.__ml.teleport(a, b), [x, y]);
      await sleep(5000);
      const r = await page.evaluate(() => window.__ml.boundaryParity(2500));
      console.log(`slope ${slope}% ${x},${y}: ${JSON.stringify(r)}`);
      differ += r.differ ?? 1;
    }
    await ctx.close();
  }
  console.log(differ ? `BOUNDARY: ${differ} cells differ` : "BOUNDARY OK — identical everywhere");
  await browser.close();
  stop();
  process.exit(differ ? 1 : 0);
}
if (process.argv.includes("--foam")) {
  // THE SWIM FOAM BAKE: cross his loop's stream (151-179, 126.6) with the canvas path and the byte path,
  // in fresh pages; then bake the same foam both ways and compare the GPU texels.
  for (const [label, v] of [["foam canvas", "0"], ["foam bytes", "1"]]) {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 732 }, serviceWorkers: "block" });
    const page = await ctx.newPage();
    await page.addInitScript((x) => { localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "B" })); sessionStorage.setItem("ml-rejoin", "1"); localStorage.setItem("ml-foambytes", x); }, v);
    await page.goto(origin + "/", { waitUntil: "commit" });
    await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 180000, polling: 100 });
    await page.evaluate(() => window.__ml.teleport(150, 126.6));
    await sleep(6000);
    await page.evaluate(() => window.__ml.foamBytes());
    for (let x = 151; x <= 179; x += 0.5) {
      await page.evaluate((xx) => window.__ml.teleport(xx, 126.6), x);
      await sleep(250);
    }
    const st = await page.evaluate(() => window.__ml.foamBytes());
    console.log(`${label}: ${st.bakes} foam bakes, ${st.ms.toFixed(1)} ms total, mean ${(st.ms / Math.max(1, st.bakes)).toFixed(2)} ms, worst ${st.maxMs.toFixed(2)} ms (switch ${st.on})`);
    if (v === "1") {
      const par = await page.evaluate(() => window.__ml.foamParity());
      console.log(`  parity: ${JSON.stringify(par).slice(0, 500)}`);
    }
    await ctx.close();
  }
  await browser.close();
  stop();
  process.exit(0);
}
if (process.argv.includes("--extent")) {
  // THE WIDE EXTENT CHECK: many places (towns with roofs, bridges, cliffs, stairs, caves), slopes off and on.
  const places = [[441, 364], [447, 371], [297, 252], [262, 66], [277, 269], [258, 217], [230, 230], [176, 288], [96, 244], [335, 238]];
  let bad = 0, total = 0, decks = 0, ramps = 0, maxLv = 0;
  for (const slope of ["0", "100"]) {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 732 }, serviceWorkers: "block" });
    const page = await ctx.newPage();
    await page.addInitScript((sl) => { localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "B" })); sessionStorage.setItem("ml-rejoin", "1"); localStorage.setItem("ml-slope-height", sl); }, slope);
    await page.goto(origin + "/", { waitUntil: "commit" });
    await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 180000, polling: 100 });
    for (const [x, y] of places) {
      await page.evaluate(([a, b]) => window.__ml.teleport(a, b), [x, y]);
      await sleep(7000);
      await page.evaluate(([a, b]) => window.__ml.teleport(a, b), [x + 1, y]); // one step: a scroll gives the scratch
      await sleep(2500);
      const ex = await page.evaluate(() => window.__ml.groundExtentCheck(400));
      console.log(`slope ${slope}% ${x},${y}: ${JSON.stringify(ex).slice(0, 260)}`);
      if (ex.error) { bad++; continue; }
      total += ex.checked; decks += ex.withDecks; ramps += ex.ramps; maxLv = Math.max(maxLv, ex.maxLv);
      if (ex.outside > 0) bad++;
    }
    await ctx.close();
  }
  console.log(`WIDE EXTENT: ${total} cells checked (${decks} with decks, ${ramps} slopes/ramps, top level ${maxLv}); ${bad ? bad + " place(s) FAILED or errored" : "none painted above its sized rect"}`);
  await browser.close();
  stop();
  process.exit(bad ? 1 : 0);
}
const cases = modeLazy ? [["repaint only near OFF", { l: "0" }], ["repaint only near ON", { l: "1" }]] : modeDefer ? [["plates off-thread OFF", { d: "0" }], ["plates off-thread ON", { d: "1" }]] : (process.argv.includes("--on-only") ? [["sized repaint ON", { r: "1" }]] : [["sized repaint OFF", { r: "0" }], ["sized repaint ON", { r: "1" }]]);
for (const [label, set] of cases) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 732 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.addInitScript((v) => { localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "B" })); sessionStorage.setItem("ml-rejoin", "1"); if (v.r) localStorage.setItem("ml-groundrect", v.r); if (v.d) localStorage.setItem("ml-grounddefer", v.d); if (v.l) localStorage.setItem("ml-groundlazy", v.l); }, set);
  await page.goto(origin + "/", { waitUntil: "commit" });
  await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 180000, polling: 100 });
  console.log(`=== ${label} (rect ${await page.evaluate(() => window.__ml.groundRect())}, defer ${await page.evaluate(() => window.__ml.groundDefer())}, lazy ${await page.evaluate(() => window.__ml.groundLazy())})`);
  const all = [];
  let staleVisibleMax = 0, staleSamples = 0, staleVisibleSamples = 0;
  for (const [sx, sy] of spots) {
    await page.evaluate(() => window.__ml.groundRepaintLog());
    await page.evaluate(([x, y]) => window.__ml.teleport(x, y), [sx, sy]);
    const rows = [];
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      if (i >= 8 && i < 20) await page.evaluate(([x, y]) => window.__ml.teleport(x, y), [sx + (i - 7) * 1.0, sy + (i - 7) * 0.5]);
      for (const r of await page.evaluate(() => window.__ml.groundRepaintLog())) rows.push(r);
      const st = await page.evaluate(() => window.__ml.groundStale());
      staleSamples++;
      if (st.visible > 0) staleVisibleSamples++;
      if (st.visible > staleVisibleMax) staleVisibleMax = st.visible;
    }
    const by = {};
    for (const r of rows) { const b = (by[r.why] ??= { n: 0, ms: 0, cells: 0, inView: 0 }); b.n++; b.ms += r.ms; b.cells += r.cells; b.inView += r.inView; }
    const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
    console.log(`spot ${sx},${sy}: ${rows.length} repaints ${sum("ms").toFixed(0)} ms, ${sum("cells")} cells of which on screen ${sum("inView")} | ${Object.entries(by).map(([k, b]) => `${k} ${b.n}x/${b.ms.toFixed(0)}ms/${b.cells}c(${b.inView} seen)`).join(", ")}`);
    all.push(...rows);
    if (set.r === "1" && !modeDefer && !modeLazy) {
      const ex = await page.evaluate(() => window.__ml.groundExtentCheck(250));
      console.log(`  extent: ${JSON.stringify(ex).slice(0, 300)}`);
      if (ex.error || ex.outside > 0) extentBad++;
    }
  }
  const tot = (k) => all.reduce((n, r) => n + r[k], 0);
  const st = await page.evaluate(() => window.__ml.groundStale());
  console.log(`TOTAL ${label}: ${all.length} repaints, ${tot("ms").toFixed(0)} ms, ${tot("cells")} cells, on screen ${tot("inView")} (${(100 * tot("inView") / Math.max(1, tot("cells"))).toFixed(0)}%) | parked ${st.parked} promoted ${st.promoted} forgotten ${st.dropped} still parked ${st.stale} | stale cells on screen: max ${staleVisibleMax}, in ${staleVisibleSamples} of ${staleSamples} samples`);
  await ctx.close();
}
if (!modeDefer && !modeLazy) console.log(extentBad ? `EXTENT: ${extentBad} spot(s) painted above the sized rect` : "EXTENT OK");
await browser.close();
stop();
