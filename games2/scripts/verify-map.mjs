// QA: HUD Map tab — the world's top-down minimap with a live red "you are here"
// dot. ring_test (the world that ships a real top-down minimap.png): the image
// loads, the dot sits at the player's cell, and it tracks a teleport. A world
// with NO minimap.png (the default the_island2) shows the graceful fallback.
// Runs at the maintainer's phone geometry.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);
const near = (a, b, eps = 0.7) => Math.abs(a - b) <= eps;
const pct = (s) => parseFloat(s);

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
  await page.click('.ml-tab[data-tab="map"]');
  await page.waitForTimeout(1000);
}

try {
  const ctx = await browser.newContext({
    viewport: { width: 980, height: 2123 }, screen: { width: 393, height: 851 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  // ── ring_test: real top-down minimap + a dot at the player's cell ──
  await enter(page, "ring_test");
  const s = await page.evaluate(() => {
    const img = document.querySelector(".ml-map-img");
    const frame = document.querySelector(".ml-map-frame");
    const empty = document.querySelector(".ml-map-empty");
    const dot = document.querySelector(".ml-map-dot");
    return {
      mm: window.__ml.minimap(),
      src: img?.getAttribute("src"),
      nat: img ? [img.naturalWidth, img.naturalHeight] : null,
      frameHidden: !!frame?.hidden, emptyHidden: !!empty?.hidden,
      dot: { l: dot?.style.left, t: dot?.style.top },
    };
  });
  s.mm && s.mm.world === "ring_test" && s.mm.w === 160 && s.mm.h === 160
    ? ok(`feed ${JSON.stringify(s.mm)}`) : fail(`feed ${JSON.stringify(s.mm)}`);
  s.src === "/assets/maps2/worlds/ring_test/minimap.png"
    ? ok("img src = ring_test minimap") : fail(`img src ${s.src}`);
  s.nat && s.nat[0] === 640 && s.nat[1] === 640
    ? ok("minimap image loaded (640x640)") : fail(`image not loaded ${JSON.stringify(s.nat)}`);
  !s.frameHidden && s.emptyHidden
    ? ok("minimap shown, fallback hidden") : fail(`visibility frameHidden=${s.frameHidden} emptyHidden=${s.emptyHidden}`);
  near(pct(s.dot.l), (s.mm.col / s.mm.w) * 100) && near(pct(s.dot.t), (s.mm.row / s.mm.h) * 100)
    ? ok(`dot at player cell (${s.dot.l}, ${s.dot.t})`)
    : fail(`dot ${JSON.stringify(s.dot)} vs col/row ${s.mm.col},${s.mm.row}`);

  // teleport → the dot tracks the player. teleport is a server round-trip that
  // can be flaky right after join, so retry until the feed reflects it.
  let moved = false;
  for (let i = 0; i < 4 && !moved; i++) {
    await page.evaluate(() => window.__ml.teleport(40, 120));
    moved = await page
      .waitForFunction(() => { const m = window.__ml.minimap(); return Math.abs(m.col - 40) < 1 && Math.abs(m.row - 120) < 1; }, { timeout: 3000 })
      .then(() => true).catch(() => false);
  }
  await page.waitForTimeout(200);
  const t = await page.evaluate(() => {
    const dot = document.querySelector(".ml-map-dot");
    return { mm: window.__ml.minimap(), dot: { l: dot.style.left, t: dot.style.top } };
  });
  near(t.mm.col, 40) && near(t.mm.row, 120)
    ? ok(`teleport moved player to ${t.mm.col.toFixed(1)},${t.mm.row.toFixed(1)}`) : fail(`teleport feed ${JSON.stringify(t.mm)}`);
  near(pct(t.dot.l), 25, 1) && near(pct(t.dot.t), 75, 1)
    ? ok(`dot tracked teleport (${t.dot.l}, ${t.dot.t})`) : fail(`dot after teleport ${JSON.stringify(t.dot)}`);

  // ── a world with NO minimap.png: graceful fallback, no broken image ──
  await enter(page, "the_island2");
  const f = await page.evaluate(() => {
    const frame = document.querySelector(".ml-map-frame");
    const empty = document.querySelector(".ml-map-empty");
    return {
      world: window.__ml.minimap().world,
      frameHidden: !!frame?.hidden, emptyHidden: !!empty?.hidden, emptyText: empty?.textContent,
    };
  });
  f.world === "the_island2" && f.frameHidden && !f.emptyHidden
    ? ok(`no-minimap world falls back ("${f.emptyText}")`) : fail(`fallback state ${JSON.stringify(f)}`);
} finally { await browser.close(); }
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
