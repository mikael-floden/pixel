// Forensics twin of verify-longwalk: same seeded trips, but the moment a trip
// stalls (no movement for 3 ticks while active) it dumps the autopilot
// decision trace, the 5x5 grid around the player, and the remaining path —
// then keeps going so one run photographs every distinct stall.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SEED = Number(process.env.SEED || 5);
let rng = SEED;
const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  const ctx = await browser.newContext({ viewport: { width: Number(process.env.VW || 480), height: Number(process.env.VH || 320) } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  const WORLD = process.env.WORLD || "prop";
  const url = WORLD === "emission" ? "http://localhost:5173/#emission" : "http://localhost:5173/";
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  if (WORLD !== "emission") {
    const idx = await page.evaluate(
      (re) => window.__mlSelect.worlds().findIndex((w) => new RegExp(re, "i").test(w)),
      WORLD,
    );
    if (idx >= 0) await page.evaluate((i) => window.__mlSelect.pickWorld(i), idx);
  }
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.bringToFront();

  const pos = () => page.evaluate(() => { const m = window.__ml.me(); return { x: m.x, y: m.y }; });
  const trips = 8;
  for (let trip = 0; trip < trips; trip++) {
    const p0 = await pos();
    let t = null;
    for (let tries = 0; tries < 30 && !t; tries++) {
      const ang = rand() * Math.PI * 2;
      const d = (15 + rand() * 20) * 32;
      const x = p0.x + Math.cos(ang) * d;
      const y = p0.y + Math.sin(ang) * d;
      t = await page.evaluate(({ x, y, run }) => {
        if (window.__ml.blockedAt(x, y)) return null;
        const s = window.__ml.surfaceAt(x, y);
        if (!s || (!s.standable && !s.swimmable)) return null;
        window.__ml.tapTo(x, y, run);
        const tgt = window.__ml.target();
        return tgt ? { x: tgt.x, y: tgt.y, run, wp: window.__ml.path().length } : null;
      }, { x, y, run: rand() > 0.5 });
    }
    if (!t) { console.log(`trip ${trip}: no target found, skip`); continue; }
    let lastPos = await pos();
    let still = 0;
    let dumped = false;
    let ended = false;
    const trace = [];
    for (let i = 0; i < 300; i++) {
      await page.waitForTimeout(200);
      const cur = await pos();
      trace.push(cur);
      const active = await page.evaluate(() => !!window.__ml.target());
      if (!active) { ended = true; break; }
      still = Math.hypot(cur.x - lastPos.x, cur.y - lastPos.y) < 1.5 ? still + 1 : 0;
      lastPos = cur;
      // Net-progress watchdog: a loop moves constantly but goes nowhere much.
      // 15s of walking covers ~1000wu; under 150wu net = circling/bouncing.
      const back = trace[trace.length - 75];
      const looping = back && Math.hypot(cur.x - back.x, cur.y - back.y) < 150;
      if ((still >= 3 || looping) && !dumped) {
        dumped = true;
        console.log(`\n--- movement trace (last 40 x 200ms) ---`);
        for (const p of trace.slice(-40)) console.log(`   (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
        const dump = await page.evaluate(() => ({
          me: (() => { const m = window.__ml.me(); return { x: m.x, y: m.y }; })(),
          grid: window.__ml.gridAround(window.__ml.me().x, window.__ml.me().y, 3),
          nav: window.__ml.navLog(40),
          path: window.__ml.path().slice(0, 8),
          target: window.__ml.target(),
          fall: window.__ml.fall ? window.__ml.fall() : null,
        }));
        console.log(`\n=== trip ${trip} ${still >= 3 ? "STALL" : "LOOP"} (run=${t.run}) at (${dump.me.x.toFixed(1)}, ${dump.me.y.toFixed(1)}) cell (${(dump.me.x / 32).toFixed(2)}, ${(dump.me.y / 32).toFixed(2)}) fall=${JSON.stringify(dump.fall)} ===`);
        console.log(`target (${dump.target?.x.toFixed(0)}, ${dump.target?.y.toFixed(0)})  path next: ${dump.path.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(" ")}`);
        console.log("grid (rows=y, cols=x; # = solid, number = level):");
        for (const r of dump.grid.rows) console.log("   " + r);
        console.log("navLog tail:");
        for (const n of dump.nav) {
          console.log(
            `   t=${n.t.toFixed(0)} pos=(${n.x},${n.y}) wp=(${n.wp.x},${n.wp.y}) left=${n.left} dist=${n.dist} ax=${n.ax},${n.ay} rawDot=${n.rawDot} openDot=${n.openDot} usedOpen=${n.usedOpen}`,
          );
        }
      }
    }
    const p1 = await pos();
    const dEnd = Math.hypot(t.x - p1.x, t.y - p1.y);
    console.log(`trip ${trip}: ${ended ? "ended" : "TIMEOUT"} dist-to-target=${dEnd.toFixed(0)}wu run=${t.run} ${dEnd < 40 ? "OK" : "FAIL"}`);
    if (ended && dEnd >= 40) {
      // The autopilot terminated the trip far from the goal — the navLog tail
      // shows the final decisions (stall→replan→give-up, or a rim arrival).
      const dump = await page.evaluate(() => ({
        grid: window.__ml.gridAround(window.__ml.me().x, window.__ml.me().y, 3),
        nav: window.__ml.navLog(40),
      }));
      console.log(`--- gave up at (${p1.x.toFixed(1)}, ${p1.y.toFixed(1)}); target was (${t.x.toFixed(0)}, ${t.y.toFixed(0)}) ---`);
      console.log("grid:");
      for (const r of dump.grid.rows) console.log("   " + r);
      console.log("navLog tail:");
      for (const n of dump.nav) {
        console.log(
          `   t=${n.t.toFixed(0)} pos=(${n.x},${n.y}) wp=(${n.wp.x},${n.wp.y}) left=${n.left} dist=${n.dist} ax=${n.ax},${n.ay} rawDot=${n.rawDot} openDot=${n.openDot} usedOpen=${n.usedOpen}`,
        );
      }
    }
  }
} finally { await browser.close(); }
