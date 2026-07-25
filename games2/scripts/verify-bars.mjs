// QA: HP/Energy/XP bars + Gold + LEVEL — HP+Energy top-left, XP top-right, Gold
// under XP; STATIC placeholder values (HP 10/10 full, Energy 0/0 empty, XP 0/10
// empty, Gold 0, Level 1), no animation (maintainer 2026-07-23/24/25). Runs at
// the maintainer's phone geometry. Gold: icon + amount RIGHT-aligned to the XP
// bar's edge, opposite the Energy bar. LEVEL: "LEVEL n" LEFT-aligned on the XP
// number line, opposite the right-aligned XP count.
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
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForSelector(".ml-bars", { timeout: 30000 });

  // structure: two rows; frame + fill are 9-sliced into the box (data-URL srcs,
  // like the kit buttons), fill colour tagged via data-color, plus numbers
  const s = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".ml-bar-row")];
    return rows.map((r) => ({
      color: r.querySelector(".ml-bar-fill")?.dataset.color || "",
      imgs: r.querySelectorAll(".ml-bar-gauge img").length,
      fillData: (r.querySelector(".ml-bar-fill")?.getAttribute("src") || "").startsWith("data:"),
      num: r.querySelector(".ml-bar-num")?.textContent || "",
    }));
  });
  if (s.length !== 3) fail(`want 3 bar rows (HP, EP, XP), got ${s.length}`);
  else {
    s[0].color === "red" && s[0].imgs === 2 && s[0].fillData ? ok("health = red 9-sliced fill over the track") : fail(`hp row ${JSON.stringify(s[0])}`);
    s[1].color === "yellow" && s[1].imgs === 2 && s[1].fillData ? ok("energy = yellow 9-sliced fill over the track") : fail(`ep row ${JSON.stringify(s[1])}`);
    s[2].color === "blue" && s[2].imgs === 2 && s[2].fillData ? ok("experience = blue 9-sliced fill over the track") : fail(`xp row ${JSON.stringify(s[2])}`);
    s[0].num === "10 / 10 HP" ? ok(`hp number "${s[0].num}"`) : fail(`hp number "${s[0].num}" (want "10 / 10 HP")`);
    s[1].num === "0 / 0 EP" ? ok(`ep number "${s[1].num}"`) : fail(`ep number "${s[1].num}" (want "0 / 0 EP")`);
    s[2].num === "0 / 10 XP" ? ok(`xp number "${s[2].num}"`) : fail(`xp number "${s[2].num}" (want "0 / 10 XP")`);
  }

  // STATIC fills: HP full, Energy + XP empty; the clip must NOT change over time
  // (the demo animation was removed). fill% = 100 - inset-right%.
  const readClip = () => page.evaluate(() =>
    [...document.querySelectorAll(".ml-bar-fill")].map((f) => f.style.clipPath));
  const pctOf = (c) => {
    const m = /inset\(0(?:px)? ([\d.]+)% 0(?:px)? 0(?:px)?\)/.exec(c || "");
    return m ? 100 - +m[1] : NaN;
  };
  const a = await readClip();
  await page.waitForTimeout(1200);
  const b = await readClip();
  a.every((c, i) => c === b[i]) ? ok("fills are static (no animation)") : fail(`fill still animating: ${a} -> ${b}`);
  const pa = a.map(pctOf);
  Math.abs(pa[0] - 100) < 1 ? ok(`hp full (${pa[0]}%)`) : fail(`hp fill ${pa[0]}% (want 100)`);
  Math.abs(pa[1] - 0) < 1 ? ok(`energy empty (${pa[1]}%)`) : fail(`ep fill ${pa[1]}% (want 0)`);
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
  const g = await page.evaluate(() => {
    const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; };
    const groups = [...document.querySelectorAll(".ml-bars")];
    const rightGroup = groups.find((gr) => gr.querySelector(".ml-gold-row"));
    const leftGroup = groups.find((gr) => !gr.querySelector(".ml-gold-row"));
    const goldRow = rightGroup?.querySelector(".ml-gold-row");
    const num = goldRow?.querySelector(".ml-gold-num");
    const icon = goldRow?.querySelector(".ml-gold-icon");
    const xpRow = rightGroup?.querySelector(".ml-bar-row"); // XP is the only bar in the right group
    const epRow = leftGroup ? leftGroup.querySelectorAll(".ml-bar-row")[1] : null; // Energy = 2nd left row
    const epNum = epRow?.querySelector(".ml-bar-num"); // the "0 / 0 EP" text under the gauge
    const mid = (b) => (b ? Math.round((b.t + b.b) / 2) : null);
    return {
      exists: !!goldRow, numText: num?.textContent ?? null,
      iconSrc: icon?.getAttribute("src") || "", iconLoaded: icon ? icon.naturalWidth > 0 : false,
      goldRow: box(goldRow), num: box(num), icon: box(icon), xpRow: box(xpRow), epRow: box(epRow),
      goldMid: mid(box(goldRow)), epNumMid: mid(box(epNum)),
    };
  });
  g.exists ? ok("gold row present under the right group") : fail("no gold row");
  if (g.exists) {
    g.numText === "0" ? ok(`gold amount defaults to "0"`) : fail(`gold amount "${g.numText}" (want "0")`);
    /gold-icon\.png/.test(g.iconSrc) && g.iconLoaded ? ok(`gold icon loaded (${g.iconSrc})`) : fail(`gold icon missing/broken (src="${g.iconSrc}" loaded=${g.iconLoaded})`);
    // right edge lines up with the XP bar (both right-aligned to the same edge)
    Math.abs(g.goldRow.r - g.xpRow.r) <= 2 ? ok(`gold row right-aligned to XP (${g.goldRow.r} ≈ ${g.xpRow.r})`) : fail(`gold row right edge ${g.goldRow.r} vs XP ${g.xpRow.r}`);
    // icon at the far right, amount just to its left (both flush right)
    g.icon.r >= g.goldRow.r - 2 && g.num.r <= g.icon.l + 1 ? ok(`amount left of the right-aligned icon (num.r=${g.num.r} icon.l=${g.icon.l} icon.r=${g.icon.r})`) : fail(`gold layout wrong: num=${JSON.stringify(g.num)} icon=${JSON.stringify(g.icon)}`);
    // sits opposite the Energy bar, DROPPED toward its number line: the Energy
    // value is under the gauge, so the gold's single line sinks to read as "on
    // the same line" as that text — landing a HAIR ABOVE the number line
    // (maintainer 2026-07-24: exactly on it read a touch too low). So the gold is
    // well below the EP gauge top, and its centre is just above / at the EP number.
    const epRowMid = Math.round((g.epRow.t + g.epRow.b) / 2);
    g.goldRow.t > g.epRow.t + 4 ? ok(`gold row dropped below the Energy gauge top (${g.goldRow.t} > ${g.epRow.t})`) : fail(`gold row not dropped: top ${g.goldRow.t} vs Energy gauge top ${g.epRow.t}`);
    (g.goldMid <= g.epNumMid + 4 && g.goldMid >= epRowMid - 8)
      ? ok(`gold sits between the Energy row centre and its number line (${g.goldMid}; row mid ${epRowMid}, num ${g.epNumMid})`)
      : fail(`gold centre ${g.goldMid} outside [${epRowMid - 8}, ${g.epNumMid + 4}]`);
  }

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
} finally { await browser.close(); }
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
