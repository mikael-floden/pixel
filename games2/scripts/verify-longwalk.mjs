// The honest navigation test: LONG walk/run trips across the dense prop
// world. A trip only PASSES if the player actually ARRIVES near the
// (clearance-adjusted) destination — "gave up mid-way" and "ground into an
// object" are failures. This is what playing feels like.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SEED = Number(process.env.SEED || 5);
// WORLD=emission runs the trips on the generated station (/#emission);
// anything else picks the first select-screen world matching it (default: props).
const WORLD = process.env.WORLD || "prop";
let rng = SEED;
const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  const ctx = await browser.newContext({ viewport: { width: Number(process.env.VW || 480), height: Number(process.env.VH || 320) } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
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
  let fails = 0;
  const trips = 8;
  for (let trip = 0; trip < trips; trip++) {
    const p0 = await pos();
    // LONG trips: 15-35 cells away, any angle, walk or run.
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
        return tgt ? { x: tgt.x, y: tgt.y, wp: window.__ml.path().length } : null;
      }, { x, y, run: rand() > 0.5 });
    }
    if (!t) { console.log(`trip ${trip}: no target found, skip`); continue; }
    // Follow until the trip ends (cap 60s — long trips at walk speed take a while).
    let ended = false;
    let lastPos = await pos();
    let stuckTicks = 0;
    for (let i = 0; i < 300; i++) {
      await page.waitForTimeout(200);
      const cur = await pos();
      const active = await page.evaluate(() => !!window.__ml.target());
      if (Math.hypot(cur.x - lastPos.x, cur.y - lastPos.y) < 1.5 && active) stuckTicks++;
      lastPos = cur;
      if (!active) { ended = true; break; }
    }
    const p1 = await pos();
    const dEnd = Math.hypot(t.x - p1.x, t.y - p1.y);
    const ok = ended && dEnd < 40;
    console.log(
      `trip ${trip}: ${ended ? "ended" : "TIMEOUT"} dist-to-target=${dEnd.toFixed(0)}wu wp=${t.wp} stuckTicks=${stuckTicks} → ${ok ? "OK" : "FAIL"}`,
    );
    if (!ok) fails++;
  }
  console.log(fails === 0 ? `LONGWALK OK — ${trips} trips arrived` : `LONGWALK FAILED — ${fails}/${trips} trips did not arrive`);
  if (fails > 0) process.exit(1);
} finally { await browser.close(); }
