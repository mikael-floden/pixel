// THE MAP TAB — the image it loads, and whether the dot lands on the player.
//
// THE RENDER IS CROPPED TO THE ISLAND (maps2 d8a399b1a6): deep water is drawn
// as nothing and the transparent border cut away, so a fraction of the full
// iso canvas — which is how the client placed the dot for a year — is wrong by
// construction. maps2 publishes the arithmetic beside the image as
// `minimap.json` (pixel-maps3/minimap@1), and the client uses it verbatim.
//
// GROUND TRUTH HERE IS THAT DOC'S OWN WORKED SAMPLES, not a second evaluation
// of its formula: maps2 lists real land cells with the pixel each one lands
// on, asserted at build time against the alpha of the file itself. Teleport to
// each, and the dot must be there. A gate that re-ran the formula would agree
// with the client about a shared misreading of it — including the one thing
// worth being suspicious of, whether `col` means the same thing on both sides.
//
// Also pinned: the file NAME (overview.webp is deleted — asking for it only
// 404s), a ceiling on its size (it was once the 16300x7576 / 15 MB review
// render, fetched on a phone into a ~360px frame), and that the doc is not
// STALE — its `world` must be the grid the game actually loaded, or every
// sample below is describing a different island.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const MAX_MAP_W = 2400;
const TOL = 0.015; // 1.5% of the frame

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

  const feed = await page.evaluate(() => window.__ml.minimap());
  const img = await page.evaluate(() => {
    const i = document.querySelector(".ml-map-frame img");
    return { src: i.getAttribute("src"), nat: [i.naturalWidth, i.naturalHeight] };
  });
  // The doc, fetched the same way the client does.
  const meta = await page.evaluate(async (src) => {
    const res = await fetch(src.replace(/minimap\.(webp|png)$/, "minimap.json"));
    return res.ok ? res.json() : null;
  }, img.src);

  // ── 1. the file ────────────────────────────────────────────────────────
  /minimap\.(webp|png)(\?|$)/.test(img.src)
    ? ok(`the Map tab asks for the only name there is (${img.src})`)
    : fail(`Map tab loaded "${img.src}" — overview.webp is deleted; minimap is the name`);
  img.nat[0] <= MAX_MAP_W
    ? ok(`…and it is the map render, not the review render (${img.nat.join("x")})`)
    : fail(`the map image is ${img.nat.join("x")} — over ${MAX_MAP_W}px wide is a QA render being scaled into a ~360px frame on a phone`);

  if (!meta) {
    fail("no minimap.json beside the image — a CROPPED render cannot be placed on without it");
  } else {
    // ── 2. the doc describes THIS world and THIS image ───────────────────
    meta.schema === "pixel-maps3/minimap@1"
      ? ok(`minimap.json is ${meta.schema}`)
      : fail(`minimap.json schema is "${meta.schema}"`);
    meta.size?.w === img.nat[0] && meta.size?.h === img.nat[1]
      ? ok(`…and its size is the image's own (${meta.size.w}x${meta.size.h})`)
      : fail(`doc says ${meta.size?.w}x${meta.size?.h}, image is ${img.nat.join("x")} — the two were not generated together`);
    !meta.world || (meta.world.w === feed.w && meta.world.h === feed.h)
      ? ok(`…for the grid the game loaded (${feed.w}x${feed.h})`)
      : fail(`doc is for a ${meta.world.w}x${meta.world.h} world, the game loaded ${feed.w}x${feed.h} — STALE, every sample describes a different island`);

    // ── 3. the dot, against maps2's own worked samples ───────────────────
    const dotAt = async (col, row) => {
      await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [col, row]);
      // Settle on the DOT: the map loop paints it from the avatar's render
      // position, which trails the teleport by frames — a fixed wait reads
      // the PREVIOUS sample on this harness.
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
        const me = window.__ml.me();
        return { fx: (r.left + r.width / 2 - f.left) / f.width, fy: (r.top + r.height / 2 - f.top) / f.height,
                 col: +(me.x / 32).toFixed(1), row: +(me.y / 32).toFixed(1) };
      });
    };
    const samples = Array.isArray(meta.samples) ? meta.samples : [];
    samples.length >= 3 ? ok(`${samples.length} worked samples to check against`) : fail(`minimap.json ships ${samples.length} samples`);
    for (const s of samples) {
      const [cx, cy] = s.cell;
      const want = [s.px[0] / meta.size.w, s.px[1] / meta.size.h];
      const got = await dotAt(cx, cy);
      // The teleport has to have LANDED, or the dot is honestly reporting a
      // place the player is not (deep water is clamped to the world rim).
      if (Math.abs(got.col - cx) > 1.5 || Math.abs(got.row - cy) > 1.5) {
        fail(`"${s.what}": asked for cell (${cx},${cy}), the player is at (${got.col},${got.row}) — cannot judge the dot`);
        continue;
      }
      const dx = Math.abs(got.fx - want[0]), dy = Math.abs(got.fy - want[1]);
      dx <= TOL && dy <= TOL
        ? ok(`"${s.what}" (${cx},${cy}) → dot at ${got.fx.toFixed(3)},${got.fy.toFixed(3)} vs published ${want[0].toFixed(3)},${want[1].toFixed(3)}`)
        : fail(`"${s.what}" (${cx},${cy}): dot at ${got.fx.toFixed(3)},${got.fy.toFixed(3)}, maps2 says ${want[0].toFixed(3)},${want[1].toFixed(3)} — off by ${(dx * 100).toFixed(1)}%/${(dy * 100).toFixed(1)}% of the frame`);
    }
  }

  errors.length === 0 ? ok("no page errors") : fail(`page errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
}
console.log(bad ? "\nMAP: FAIL" : "\nMAP: PASS");
process.exit(bad ? 1 : 0);
