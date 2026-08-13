// TAGLINE verification (maintainer 2026-08-06). The logo's tagline used to be
// BAKED into logo.webp — "A THOUSAND PATHS. ONE LIFE." — and the art is
// generated, so every regeneration costs quality and the words could never be
// changed. The letters were painted out of the artwork and are drawn over the
// empty banner instead, from a pool the maintainer chose, one per load.
//
// Four things have to hold, and each of them has been wrong at least once:
//
//   1. THE ART IS ACTUALLY CLEAN. Checked against the LOADED IMAGE, not the
//      file on disk and not the DOM overlay: the logo is drawn into a canvas
//      and the banner interior read back. A leftover baked letter would show
//      as bright ink there with the overlay hidden.
//   2. THE ORNAMENTS SURVIVED. The first erase reached past the text and
//      smeared the left flourish's gold arm into a brown blur. The plate's
//      end zones must still carry their bright gold.
//   3. EVERY LINE FITS. The pool is edited by hand; a long line would run
//      under the flourishes. Measured in font cells, not guessed.
//   4. IT ROTATES. A fresh line per title-screen load, never the same one
//      twice running.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => {
  console.log("FAIL:", m);
  bad = true;
};
const ok = (m) => console.log("ok:", m);

// The banner, in the logo art's own pixels (the file is 1091x634). armL/armR
// are what actually bound the words: the flourishes reach IN over the cap
// rows, well inside the gold rule, and measuring against the rule instead
// passed a line whose S and full stop sat on top of the gold arms.
const PLATE = {
  capTop: 556, capBot: 572, textL: 386, textR: 664,
  ruleL: 349, ruleR: 700, armL: 379, armR: 671,
};

const ctx = await browser.newContext({
  viewport: { width: 393, height: 851 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2.75,
});

const open = async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
  await page.waitForFunction(
    () => {
      const i = document.querySelector(".ml-logo");
      return i && i.complete && i.naturalWidth > 0;
    },
    null,
    { timeout: 25000 },
  );
};

try {
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);

  // ── 1 + 2. the ARTWORK itself, read back from the decoded image ────────
  const art = await page.evaluate((P) => {
    const img = document.querySelector(".ml-logo");
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const g = cv.getContext("2d");
    g.drawImage(img, 0, 0);
    const read = (x0, y0, x1, y1) => {
      const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let max = 0;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
        if (d[i + 3] > 200) {
          max = Math.max(max, l);
          if (l > 110) lit++;
        }
      }
      return { max, lit };
    };
    return {
      size: [img.naturalWidth, img.naturalHeight],
      band: read(P.textL, P.capTop, P.textR, P.capBot), // where the words were
      leftOrn: read(P.ruleL + 8, P.capTop, P.textL - 1, P.capBot), // flourish arm
      rightOrn: read(P.textR + 4, P.capTop, P.ruleR, P.capBot),
    };
  }, PLATE);
  art.band.lit === 0
    ? ok(`the baked tagline is gone from the art (brightest pixel left on the plate: ${Math.round(art.band.max)}/255)`)
    : fail(`${art.band.lit} bright px still baked into the banner (max ${Math.round(art.band.max)}) — the art was not erased`);
  art.leftOrn.max > 150 && art.rightOrn.max > 150
    ? ok(`both flourishes survived the erase (gold ${Math.round(art.leftOrn.max)} / ${Math.round(art.rightOrn.max)})`)
    : fail(`an ornament was erased with the text (left ${Math.round(art.leftOrn.max)}, right ${Math.round(art.rightOrn.max)}) — the erase box reached too far`);

  // ── 3. every line in the pool fits the plate ───────────────────────────
  const info = await page.evaluate(() => window.__mlSelect.tagline());
  const over = info.pool.filter((p) => p.cells > info.max);
  over.length === 0
    ? ok(`all ${info.pool.length} lines fit (widest ${Math.max(...info.pool.map((p) => p.cells))} of ${info.max} cells)`)
    : fail(`too wide for the plate: ${over.map((p) => `"${p.text}" (${p.cells})`).join(", ")}`);

  // ── 4. it is drawn, on the plate, at the size the art used ─────────────
  const geo = await page.evaluate(() => {
    const wrap = document.querySelector(".ml-logowrap").getBoundingClientRect();
    const cv = document.querySelector(".ml-tagline");
    const r = cv.getBoundingClientRect();
    const g = cv.getContext("2d");
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128 && d[i] > 150) lit++;
    return {
      lit,
      back: [cv.width, cv.height],
      // where the canvas sits inside the logo box, in ART pixels
      x: ((r.left - wrap.left) / wrap.width) * 1091,
      y: ((r.top - wrap.top) / wrap.height) * 634,
      w: (r.width / wrap.width) * 1091,
      h: (r.height / wrap.height) * 634,
    };
  });
  geo.lit > 200 ? ok(`the line is painted (${geo.lit} lit px on a ${geo.back[0]}x${geo.back[1]} canvas)`) : fail(`the tagline canvas is blank (${geo.lit} lit px)`);
  const cx = geo.x + geo.w / 2;
  Math.abs(cx - (PLATE.ruleL + PLATE.ruleR) / 2) < 2
    ? ok(`centred on the banner, not the image (x ${cx.toFixed(1)} vs rule centre ${(PLATE.ruleL + PLATE.ruleR) / 2})`)
    : fail(`off centre: text centre ${cx.toFixed(1)}, banner centre ${(PLATE.ruleL + PLATE.ruleR) / 2}`);
  geo.x >= PLATE.armL && geo.x + geo.w <= PLATE.armR
    ? ok(`clear of both flourish arms (${(geo.x - PLATE.armL).toFixed(0)}px left, ${(PLATE.armR - geo.x - geo.w).toFixed(0)}px right of the ${PLATE.armR - PLATE.armL}px gap)`)
    : fail(`the line runs under a flourish (x ${geo.x.toFixed(0)}..${(geo.x + geo.w).toFixed(0)}, arms at ${PLATE.armL}..${PLATE.armR})`);
  Math.abs(geo.y + geo.h / 2 - (PLATE.capTop + PLATE.capBot) / 2) < 2
    ? ok(`on the cap rows the baked letters used (centre y ${(geo.y + geo.h / 2).toFixed(1)})`)
    : fail(`wrong height on the plate: centre y ${(geo.y + geo.h / 2).toFixed(1)}, want ${(PLATE.capTop + PLATE.capBot) / 2}`);

  // ── 5. a fresh line per load, never an immediate repeat ────────────────
  const seen = [];
  for (let i = 0; i < 8; i++) {
    await open(page);
    seen.push(await page.evaluate(() => localStorage.getItem("ml-tagline")));
  }
  const repeats = seen.filter((t, i) => i > 0 && t === seen[i - 1]);
  const distinct = new Set(seen).size;
  repeats.length === 0
    ? ok(`rotates on every load, never twice running (${distinct} distinct over 8 loads)`)
    : fail(`the same line came up twice in a row: ${repeats.join(", ")}`);
  distinct >= 3 ? ok(`the pool is really being drawn from (${distinct} different lines)`) : fail(`only ${distinct} distinct line(s) over 8 loads`);

  errors.length === 0 ? ok("no page errors") : fail(`page errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
}

console.log(bad ? "\nTAGLINE: FAIL" : "\nTAGLINE: PASS");
process.exit(bad ? 1 : 0);
