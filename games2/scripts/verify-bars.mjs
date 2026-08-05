// QA: HP/Energy/XP bars + Gold + LEVEL — wiki-style chips (UI remake
// 2026-07-30): the UI-kit 9-slice bar art (bar-frame/bar-fill imgs, clipPath
// fills) is GONE. Two translucent .ml-bars chips 10px from the top corners:
// LEFT = HP + Energy, RIGHT = XP row + gold row. A gauge is a 10px rounded
// track (.ml-bar-gauge) holding a DIV .ml-bar-fill whose style.width "NN%" is
// the fill amount, colour tagged via data-color red|yellow|blue. STATIC
// placeholder values kept (HP 10/10 full, Energy 0/0 empty, XP 0/10 empty,
// Gold 0, Level 1), no animation (maintainer 2026-07-23/24/25). Runs at the
// maintainer's phone geometry. Gold: icon + amount RIGHT-aligned to the XP
// bar's edge. LEVEL: "LEVEL n" LEFT-aligned on the XP number line, opposite
// the right-aligned XP count.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);
try {
  const ctx = await browser.newContext({
    viewport: { width: 980, height: 2123 }, screen: { width: 393, height: 851 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  // interval polling, NOT the default rAF polling: the starved headless GL at
  // this big phone viewport (plus gate neighbours on the same box) can stall
  // rAF for 30s+ while the DOM is long since ready (known harness trait).
  await page.waitForFunction(() => window.__mlSelect, undefined, { timeout: 60000, polling: 250 });
  await page.evaluate(() => window.__mlSelect.commit());
  // The geometry assertions below check real bounding boxes anyway — a
  // zero-size/hidden chip still fails the corner checks.
  // The bars mount with the HUD, BEFORE the first server patch lands — wait
  // for the real level-1 stats to replace the mount defaults, or every number
  // below races the join.
  await page.waitForFunction(
    () => (document.querySelectorAll(".ml-bar-num")[0]?.textContent || "").includes("40"),
    undefined,
    { timeout: 30000, polling: 200 },
  );
  await page.waitForFunction(() => document.querySelectorAll(".ml-bars").length === 2,
    undefined, { timeout: 90000, polling: 250 });

  // structure: three rows; each gauge holds a plain DIV fill (fill amount =
  // style.width %), fill colour tagged via data-color, NO <img> art anywhere
  // in the gauge, plus numbers
  const s = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".ml-bar-row")];
    return rows.map((r) => {
      const fill = r.querySelector(".ml-bar-fill");
      return {
        color: fill?.dataset.color || "",
        tag: fill?.tagName || "",
        width: fill?.style.width || "",
        imgs: r.querySelectorAll(".ml-bar-gauge img").length,
        inGauge: !!fill && !!fill.parentElement?.classList.contains("ml-bar-gauge"),
        num: r.querySelector(".ml-bar-num")?.textContent || "",
      };
    });
  });
  const goodRow = (r) => r.tag === "DIV" && r.imgs === 0 && r.inGauge && /^\d+(\.\d+)?%$/.test(r.width);
  if (s.length !== 3) fail(`want 3 bar rows (HP, EP, XP), got ${s.length}`);
  else {
    s[0].color === "red" && goodRow(s[0]) ? ok("health = red DIV fill (width %) in the track, no imgs") : fail(`hp row ${JSON.stringify(s[0])}`);
    s[1].color === "yellow" && goodRow(s[1]) ? ok("energy = yellow DIV fill (width %) in the track, no imgs") : fail(`ep row ${JSON.stringify(s[1])}`);
    s[2].color === "blue" && goodRow(s[2]) ? ok("experience = blue DIV fill (width %) in the track, no imgs") : fail(`xp row ${JSON.stringify(s[2])}`);
    s[0].num === "40 / 40 HP" ? ok(`hp number "${s[0].num}"`) : fail(`hp number "${s[0].num}" (want "40 / 40 HP" — level-1 server stats)`);
    s[1].num === "20 / 20 EP" ? ok(`ep number "${s[1].num}"`) : fail(`ep number "${s[1].num}" (want "20 / 20 EP")`);
    s[2].num === "0 / 50 XP" ? ok(`xp number "${s[2].num}"`) : fail(`xp number "${s[2].num}" (want "0 / 50 XP" — xpToNext(1))`);
  }

  // the two chips hang 10px off the top corners (left: HP+EP, right: XP+gold)
  const chips = await page.evaluate(() => {
    const box = (e) => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top) }; };
    const groups = [...document.querySelectorAll(".ml-bars")];
    const right = groups.find((gr) => gr.querySelector(".ml-gold-row"));
    const left = groups.find((gr) => !gr.querySelector(".ml-gold-row"));
    return { n: groups.length, left: left ? box(left) : null, right: right ? box(right) : null, vw: innerWidth };
  });
  chips.n === 2 ? ok("two bar chips (left HP+EP, right XP+gold)") : fail(`want 2 .ml-bars chips, got ${chips.n}`);
  chips.left && Math.abs(chips.left.l - 10) <= 2 && Math.abs(chips.left.t - 10) <= 2
    ? ok(`left chip at the top-left corner (l=${chips.left.l}, t=${chips.left.t})`)
    : fail(`left chip off-corner: ${JSON.stringify(chips.left)}`);
  chips.right && Math.abs(chips.vw - 10 - chips.right.r) <= 2 && Math.abs(chips.right.t - 10) <= 2
    ? ok(`right chip at the top-right corner (r=${chips.right.r} vs ${chips.vw - 10}, t=${chips.right.t})`)
    : fail(`right chip off-corner: ${JSON.stringify(chips.right)} vw=${chips.vw}`);

  // STATIC fills: HP full, Energy + XP empty; the width must NOT change over
  // time (the demo animation was removed). fill% = parsed style.width.
  const readFills = () => page.evaluate(() =>
    [...document.querySelectorAll(".ml-bar-fill")].map((f) => f.style.width));
  const pctOf = (w) => (/^([\d.]+)%$/.exec(w || "") ? +/^([\d.]+)%$/.exec(w)[1] : NaN);
  const a = await readFills();
  await page.waitForTimeout(1200);
  const b = await readFills();
  a.every((c, i) => c === b[i]) ? ok("fills are static (no animation)") : fail(`fill still animating: ${a} -> ${b}`);
  const pa = a.map(pctOf);
  Math.abs(pa[0] - 100) < 1 ? ok(`hp full (${pa[0]}%)`) : fail(`hp fill ${pa[0]}% (want 100)`);
  Math.abs(pa[1] - 100) < 1 ? ok(`energy full (${pa[1]}%)`) : fail(`ep fill ${pa[1]}% (want 100 — pools start full)`);
  Math.abs(pa[2] - 0) < 1 ? ok(`experience empty (${pa[2]}%)`) : fail(`xp fill ${pa[2]}% (want 0)`);

  // ── LEVEL label on the XP row (maintainer 2026-07-25): "LEVEL n" LEFT-aligned
  //    on the XP number line, opposite the right-aligned XP count. ──
  const lv = await page.evaluate(() => {
    const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top) }; };
    const level = document.querySelector(".ml-bar-level");
    const numRow = document.querySelector(".ml-bar-numrow");
    const xpNum = numRow?.querySelector(".ml-bar-num");
    const gauge = document.querySelector('.ml-bar-fill[data-color="blue"]')?.closest(".ml-bar-gauge");
    return { text: level?.textContent ?? null, level: box(level), num: box(xpNum), gauge: box(gauge) };
  });
  lv.text === "LEVEL 1" ? ok(`level label reads "LEVEL 1"`) : fail(`level label "${lv.text}" (want "LEVEL 1")`);
  lv.level && lv.gauge && Math.abs(lv.level.l - lv.gauge.l) <= 2
    ? ok(`LEVEL left-aligned to the XP bar's left edge (${lv.level.l} ≈ ${lv.gauge.l})`)
    : fail(`LEVEL left ${lv.level?.l} vs XP bar left ${lv.gauge?.l}`);
  lv.level && lv.num && lv.level.r < lv.num.l && Math.abs(lv.level.t - lv.num.t) <= 3
    ? ok(`LEVEL sits opposite the XP count on one line (level ends ${lv.level.r}, count starts ${lv.num.l})`)
    : fail(`LEVEL/XP count not opposed on one line: ${JSON.stringify({ level: lv.level, num: lv.num })}`);

  // ── Gold counter under the XP bar (maintainer 2026-07-24) ──
  // NOTE: the kit-era vertical tuning ("dropped toward the Energy number
  // line, a hair above it") has no equivalent in the chip layout — gold is
  // simply the right chip's second line, stacked under the XP row; assert
  // exactly that instead.
  const g = await page.evaluate(() => {
    const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; };
    const groups = [...document.querySelectorAll(".ml-bars")];
    const rightGroup = groups.find((gr) => gr.querySelector(".ml-gold-row"));
    const goldRow = rightGroup?.querySelector(".ml-gold-row");
    const num = goldRow?.querySelector(".ml-gold-num");
    const icon = goldRow?.querySelector(".ml-gold-icon");
    const xpRow = rightGroup?.querySelector(".ml-bar-row"); // XP is the only bar in the right group
    return {
      exists: !!goldRow, numText: num?.textContent ?? null,
      iconSrc: icon?.getAttribute("src") || "", iconLoaded: icon ? icon.naturalWidth > 0 : false,
      goldRow: box(goldRow), num: box(num), icon: box(icon), xpRow: box(xpRow),
      chip: box(rightGroup),
    };
  });
  g.exists ? ok("gold row present under the right group") : fail("no gold row");
  if (g.exists) {
    g.numText === "0" ? ok(`gold amount defaults to "0"`) : fail(`gold amount "${g.numText}" (want "0")`);
    // WebP since 2026-07-31 (lossless — same pixels, ~40% of the bytes).
    /gold-icon\.webp/.test(g.iconSrc) && g.iconLoaded ? ok(`gold icon loaded (${g.iconSrc})`) : fail(`gold icon missing/broken (src="${g.iconSrc}" loaded=${g.iconLoaded})`);
    // right edge lines up with the XP bar (both right-aligned to the same edge)
    Math.abs(g.goldRow.r - g.xpRow.r) <= 2 ? ok(`gold row right-aligned to XP (${g.goldRow.r} ≈ ${g.xpRow.r})`) : fail(`gold row right edge ${g.goldRow.r} vs XP ${g.xpRow.r}`);
    // icon at the far right, amount just to its left (both flush right)
    g.icon.r >= g.goldRow.r - 2 && g.num.r <= g.icon.l + 1 ? ok(`amount left of the right-aligned icon (num.r=${g.num.r} icon.l=${g.icon.l} icon.r=${g.icon.r})`) : fail(`gold layout wrong: num=${JSON.stringify(g.num)} icon=${JSON.stringify(g.icon)}`);
    // stacked UNDER the XP row, inside the right chip
    g.goldRow.t >= g.xpRow.b - 2 ? ok(`gold row stacked under the XP row (${g.goldRow.t} >= ${g.xpRow.b})`) : fail(`gold row not under the XP row: top ${g.goldRow.t} vs XP bottom ${g.xpRow.b}`);
    g.chip && g.goldRow.b <= g.chip.b + 2 ? ok(`gold row inside the right chip (${g.goldRow.b} <= ${g.chip.b})`) : fail(`gold row overflows the chip: ${g.goldRow.b} vs chip bottom ${g.chip?.b}`);
  }

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
} finally { await browser.close(); }
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
