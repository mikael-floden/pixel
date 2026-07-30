// QA: HUD Map tab — the world's ISOMETRIC minimap (maps2 render_overview) with a
// live red "you are here" dot placed by the iso projection. ring_test: the image
// loads, the dot sits at the iso-projected player cell, and it tracks a teleport.
// The dot % is recomputed here from the same transform and compared to the DOM.
// A forced 404 shows the graceful fallback. Device-width mobile geometry.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);
const near = (a, b, eps = 0.5) => Math.abs(a - b) <= eps;
const pct = (s) => parseFloat(s);

// mirror of hud.ts minimapDotPct / maps2 render2.py render_overview
const MM = { DX: 32, DY: 15, LP: 16, MG: 12 };
function dotPct(m) {
  const ox = (m.h - 1) * MM.DX + MM.MG, oy = m.maxL * MM.LP + 40 + MM.MG;
  const fW = (m.w + m.h) * MM.DX + MM.MG * 2, fH = (m.w + m.h) * MM.DY + 64 + m.maxL * MM.LP + 80;
  const x = ox + (m.col - m.row) * MM.DX + MM.DX, y = oy + (m.col + m.row) * MM.DY - m.level * MM.LP + MM.DY;
  const cl = (v) => Math.max(0, Math.min(1, v));
  return [cl(x / fW) * 100, cl(y / fH) * 100];
}

async function enter(page, world) {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate((w) => {
    const i = window.__mlSelect.worlds().indexOf(w);
    if (i >= 0) window.__mlSelect.pickWorld(i);
  }, world);
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForSelector(".ml-tabrow .ml-tab", { timeout: 30000 });
  // the __ml debug object appears once the local player has joined
  await page.waitForFunction(() => window.__ml && typeof window.__ml.minimap === "function", { timeout: 30000 });
  // The full-screen #ml-loading cinema fade covers the HUD until the world has
  // real frames on screen — its teardown counts rAF frames, so under headless
  // software-GL it lingers well past the join. Real taps can't reach the tabs
  // through it; wait it out instead of clicking blind (same as verify-chatpage).
  await page.waitForSelector("#ml-loading", { state: "detached", timeout: 120000 });
  await page.click('.ml-tab[data-tab="map"]', { timeout: 60000 });
  await page.waitForTimeout(1000);
}
const readDot = (page) => page.evaluate(() => {
  const img = document.querySelector(".ml-map-img");
  const frame = document.querySelector(".ml-map-frame");
  const empty = document.querySelector(".ml-map-empty");
  const dot = document.querySelector(".ml-map-dot");
  return {
    mm: window.__ml.minimap(), src: img?.getAttribute("src"),
    nat: img ? [img.naturalWidth, img.naturalHeight] : null,
    frameHidden: !!frame?.hidden, emptyHidden: !!empty?.hidden,
    dot: { l: dot?.style.left, t: dot?.style.top },
  };
});

try {
  const ctx = await browser.newContext({
    // DEVICE-WIDTH mobile geometry (393×851) — the wiki-style remake's QA
    // standard: the new UI is plain responsive CSS with no zoom compensation,
    // so the layout viewport IS the device width. (The old 980×2123 scaled-
    // layout viewport predates the remake, and its huge software-GL canvas
    // starved rAF so badly tab clicks hung on the scroll/stability checks.)
    viewport: { width: 393, height: 851 }, screen: { width: 393, height: 851 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  // ── ring_test: iso minimap + a dot at the iso-projected player cell ──
  await enter(page, "ring_test");
  const s = await readDot(page);
  s.mm && s.mm.world === "ring_test" && s.mm.w === 160 && s.mm.h === 160 && typeof s.mm.maxL === "number" && typeof s.mm.level === "number"
    ? ok(`feed ${JSON.stringify(s.mm)}`) : fail(`feed ${JSON.stringify(s.mm)}`);
  s.src === "/assets/maps2/worlds/ring_test/minimap.png" ? ok("img src = ring_test minimap") : fail(`img src ${s.src}`);
  s.nat && s.nat[0] > 100 && s.nat[1] > 100 ? ok(`minimap image loaded (${s.nat})`) : fail(`image not loaded ${JSON.stringify(s.nat)}`);
  !s.frameHidden && s.emptyHidden ? ok("minimap shown, fallback hidden") : fail(`frameHidden=${s.frameHidden} emptyHidden=${s.emptyHidden}`);
  {
    const [el, et] = dotPct(s.mm);
    near(pct(s.dot.l), el) && near(pct(s.dot.t), et)
      ? ok(`dot at iso-projected cell (${s.dot.l}, ${s.dot.t})`) : fail(`dot ${JSON.stringify(s.dot)} vs iso [${el.toFixed(3)}, ${et.toFixed(3)}]`);
  }

  // teleport → the dot tracks the player (retry: teleport is a flaky round-trip)
  let moved = false;
  for (let i = 0; i < 4 && !moved; i++) {
    await page.evaluate(() => window.__ml.teleport(40, 120));
    moved = await page.waitForFunction(() => { const m = window.__ml.minimap(); return Math.abs(m.col - 40) < 1 && Math.abs(m.row - 120) < 1; }, { timeout: 3000 }).then(() => true).catch(() => false);
  }
  await page.waitForTimeout(200);
  const t = await readDot(page);
  near(t.mm.col, 40) && near(t.mm.row, 120, 1) ? ok(`teleport moved player to ${t.mm.col.toFixed(1)},${t.mm.row.toFixed(1)}`) : fail(`teleport feed ${JSON.stringify(t.mm)}`);
  {
    const [el, et] = dotPct(t.mm);
    near(pct(t.dot.l), el) && near(pct(t.dot.t), et)
      ? ok(`dot tracked teleport to iso cell (${t.dot.l}, ${t.dot.t})`) : fail(`dot ${JSON.stringify(t.dot)} vs iso [${el.toFixed(3)}, ${et.toFixed(3)}]`);
  }

  // ── the_island2 (the default world, a DIFFERENT builder-made minimap): the
  //    same iso transform must still place the dot on the map, not letterbox ──
  await enter(page, "the_island2");
  const is2 = await readDot(page);
  is2.mm.world === "the_island2" && is2.nat && is2.nat[0] > 100 && !is2.frameHidden ? ok(`the_island2 minimap loaded (${is2.nat})`) : fail(`the_island2 ${JSON.stringify(is2)}`);
  {
    const [el, et] = dotPct(is2.mm);
    near(pct(is2.dot.l), el) && near(pct(is2.dot.t), et) ? ok(`the_island2 dot at iso cell (${is2.dot.l}, ${is2.dot.t})`) : fail(`the_island2 dot ${JSON.stringify(is2.dot)} vs [${el.toFixed(3)}, ${et.toFixed(3)}]`);
  }

  // ── fallback wiring: a failed minimap image shows the placeholder (in prod a
  //    missing minimap.png 404s -> error; here we fire it directly, dev-server-
  //    independent — Vite SPA-200s a missing asset) ──
  await page.evaluate(() => document.querySelector(".ml-map-img").dispatchEvent(new Event("error")));
  await page.waitForTimeout(250);
  const f = await page.evaluate(() => {
    const frame = document.querySelector(".ml-map-frame"); const empty = document.querySelector(".ml-map-empty");
    return { frameHidden: !!frame?.hidden, emptyHidden: !!empty?.hidden, emptyText: empty?.textContent };
  });
  f.frameHidden && !f.emptyHidden ? ok(`failed minimap falls back ("${f.emptyText}")`) : fail(`fallback state ${JSON.stringify(f)}`);
} finally { await browser.close(); }
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
