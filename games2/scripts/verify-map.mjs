// THE MAP TAB — the image it loads, and whether the dot lands on the world.
//
// Two regressions this pins, both of which actually happened:
//
//   1. THE WRONG FILE. The tab asked an iso world for `overview.webp`, which
//      for the_game was render3's REVIEW render — 16300x7576, 15.2 MB —
//      fetched on a phone and scaled into a ~360px frame. maps2 publishes the
//      downscale as `minimap.webp` (the explicit name every tree now uses,
//      47e08659d1) and keeps the review render as overview_full.webp. So:
//      the name, and a hard ceiling on how big the thing we fetch may be.
//
//   2. THE DOT OFF THE PLAYER. Ground truth here is THE PICTURE, not a second
//      copy of the projection — a gate that re-derives isoFrame would agree
//      with the client about a shared mistake. The map is an iso render, so
//      the world's four corner cells are the four APEXES of the rendered
//      diamond, and those can be found in the bitmap by looking. Teleport to
//      each corner, and the dot must sit on the matching apex. That is also
//      the check that would catch maps2 CROPPING or re-centring the render
//      one day: the client places its dot as a fraction of the full iso
//      canvas, so a crop moves every dot and nothing else would notice.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const MAX_MAP_W = 2400; // a map-tab image wider than this is a QA render

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);

const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 90000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.click('.ml-tab[data-tab="map"]');
  await page.waitForFunction(() => {
    const i = document.querySelector(".ml-map-frame img");
    return i && i.naturalWidth > 0;
  }, null, { timeout: 20000 });

  // ── 1. the file ────────────────────────────────────────────────────────
  const img = await page.evaluate(() => {
    const i = document.querySelector(".ml-map-frame img");
    return { src: i.getAttribute("src"), nat: [i.naturalWidth, i.naturalHeight] };
  });
  const feed = await page.evaluate(() => window.__ml.minimap());
  /minimap\.(webp|png)(\?|$)/.test(img.src)
    ? ok(`the Map tab asks for the explicit name (${img.src})`)
    : fail(`Map tab loaded "${img.src}" — every tree publishes minimap.webp now`);
  img.nat[0] <= MAX_MAP_W
    ? ok(`…and it is the downscale, not the review render (${img.nat.join("x")})`)
    : fail(`the map image is ${img.nat.join("x")} — over ${MAX_MAP_W}px wide is a QA render being scaled into a ~360px frame on a phone`);

  // ── 2. the picture's own diamond ───────────────────────────────────────
  // Read the LOADED bitmap: whatever maps2 shipped is the truth here.
  const apex = await page.evaluate(() => {
    const i = document.querySelector(".ml-map-frame img");
    const c = document.createElement("canvas");
    c.width = i.naturalWidth; c.height = i.naturalHeight;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(i, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const bg = [d[0], d[1], d[2]];
    const inside = (x, y) => {
      const o = (y * c.width + x) * 4;
      if (d[o + 3] < 24) return false; // a transparent render's surround
      return Math.abs(d[o] - bg[0]) + Math.abs(d[o + 1] - bg[1]) + Math.abs(d[o + 2] - bg[2]) > 24;
    };
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    const rowsAt = new Map(), colsAt = new Map();
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (!inside(x, y)) continue;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (!rowsAt.has(y)) rowsAt.set(y, []); rowsAt.get(y).push(x);
      if (!colsAt.has(x)) colsAt.set(x, []); colsAt.get(x).push(y);
    }
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const f = (x, y) => [x / c.width, y / c.height];
    return {
      size: [c.width, c.height],
      top: f(mean(rowsAt.get(minY)), minY),
      bottom: f(mean(rowsAt.get(maxY)), maxY),
      left: f(minX, mean(colsAt.get(minX))),
      right: f(maxX, mean(colsAt.get(maxX))),
    };
  });
  console.log(`   the rendered diamond: top ${apex.top.map((v) => v.toFixed(3))}, right ${apex.right.map((v) => v.toFixed(3))}, bottom ${apex.bottom.map((v) => v.toFixed(3))}, left ${apex.left.map((v) => v.toFixed(3))}`);

  const dotAt = async (col, row) => {
    await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [col, row]);
    // Settle on the DOT: the map loop paints it from the avatar's render
    // position, which trails the teleport by frames, and on this harness the
    // frame loop is slow enough that a fixed wait reads the PREVIOUS corner.
    let prev = "", cur = "";
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(150);
      cur = await page.evaluate(() => {
        const d = document.querySelector(".ml-map-dot");
        return d ? `${d.style.left}|${d.style.top}` : "";
      });
      if (cur && cur === prev) break;
      prev = cur;
    }
    return page.evaluate(() => {
      const d = document.querySelector(".ml-map-dot");
      const f = document.querySelector(".ml-map-frame").getBoundingClientRect();
      const r = d.getBoundingClientRect();
      return [(r.left + r.width / 2 - f.left) / f.width, (r.top + r.height / 2 - f.top) / f.height];
    });
  };

  // In this project's iso, screen x = (col-row)*DX: so (0,0) is the TOP apex,
  // (w-1,0) the RIGHT, (w-1,h-1) the BOTTOM and (0,h-1) the LEFT.
  const W = feed.w - 1, H = feed.h - 1;
  const TOL = 0.02; // 2% of the frame — a real crop moves a dot far further
  for (const [name, col, row, want] of [
    ["top", 0, 0, apex.top],
    ["right", W, 0, apex.right],
    ["bottom", W, H, apex.bottom],
    ["left", 0, H, apex.left],
  ]) {
    const got = await dotAt(col, row);
    const dx = Math.abs(got[0] - want[0]), dy = Math.abs(got[1] - want[1]);
    dx <= TOL && dy <= TOL
      ? ok(`(${col},${row}) puts the dot on the ${name} apex (${got.map((v) => v.toFixed(3))} vs ${want.map((v) => v.toFixed(3))})`)
      : fail(`(${col},${row}) should be the ${name} apex ${want.map((v) => v.toFixed(3))}, dot is at ${got.map((v) => v.toFixed(3))} — off by ${(dx * 100).toFixed(1)}%/${(dy * 100).toFixed(1)}% of the frame. Did the render get cropped or re-centred?`);
  }

  errors.length === 0 ? ok("no page errors") : fail(`page errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
}
console.log(bad ? "\nMAP: FAIL" : "\nMAP: PASS");
process.exit(bad ? 1 : 0);
