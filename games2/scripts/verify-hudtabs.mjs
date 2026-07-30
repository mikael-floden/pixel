// QA: the HUD tab row + backpack slots in the wiki-theme remake, at EVERY
// viewport — desktop-site AND narrow mobile (the original 2026-07-25 report:
// on disabling "force desktop view" the menu buttons stopped matching the
// look and the icons read "too small and wrong"). The pixel-kit plates are
// GONE (plate.ts / --ml-kitpx / --ml-fs are never written any more), so the
// kit-era assertions (plate==slot size, kit grain tracking the frame scale,
// grain==bars) have NO equivalent and were deleted. The wiki-theme contract
// asserted instead:
//  - six equal-width .ml-tab buttons FILL the .ml-tabrow content box
//    (flex:1 + 6px gap), none overflowing the row;
//  - tab height follows the breakpoints (56px; 48 at ≤640h — the 2026-07-30
//    "menu buttons too small" round removed the ≤480w tier);
//  - the .ml-tab-icon renders at its AUTHORED 1x GRID: exactly
//    naturalWidth/2 × naturalHeight/2 per image (the bakes are exact 2x of
//    the hand-drawn art on non-square canvases; the old fixed 32/24 square
//    both distorted the aspect and hit a fractional 48→32 scale) — and fits
//    in its tab;
//  - the backpack is a 5-column grid of 15 SQUARE .ml-slot cells sized by
//    the grid tracks (no per-slot art);
//  - the clicked tab carries .sel with the accent-soft background (computed
//    backgroundColor differs from an unselected tab's) + accent border.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);

async function check(label, ctxOpts) {
  const page = await (await browser.newContext(ctxOpts)).newPage();
  try {
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
    await page.evaluate(() => window.__mlSelect.commit());
    await page.waitForSelector(".ml-slots", { timeout: 30000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelector('[data-tab="backpack"]')?.click());
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const row = document.querySelector(".ml-tabrow");
      const rowRect = row.getBoundingClientRect();
      const rcs = getComputedStyle(row);
      const contentLeft = rowRect.left + parseFloat(rcs.paddingLeft);
      const contentRight = rowRect.right - parseFloat(rcs.paddingRight);
      const tabs = [...document.querySelectorAll(".ml-tab")];
      const rects = tabs.map((t) => t.getBoundingClientRect());
      const widths = rects.map((r) => r.width);
      const overflow = rects.some((r) => r.left < rowRect.left - 1 || r.right > rowRect.right + 1);
      // every icon must sit at its authored 1x grid: natural/2 (2x bakes)
      const icons = [...document.querySelectorAll(".ml-tab-icon")].map((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, nw: el.naturalWidth, nh: el.naturalHeight };
      });
      const icon = icons[0] ? { w: icons[0].w, h: icons[0].h } : { w: 0, h: 0 };
      const tab0 = rects[0];
      const iconOverflow = icons.some((i) => i.w > tab0.width + 1 || i.h > tab0.height + 1);
      const iconOffGrid = icons.filter((i) => i.nw > 0 &&
        (Math.abs(i.w - i.nw / 2) > 0.5 || Math.abs(i.h - i.nh / 2) > 0.5));
      // compact breakpoint (hud.ts): ≤640h → 48px tab; default 56
      const h640 = matchMedia("(max-height:640px)").matches;
      const wantTabH = h640 ? 48 : 56;
      // selection state: the clicked backpack tab vs any unselected sibling
      const sel = document.querySelector(".ml-tab.sel");
      const unsel = document.querySelector(".ml-tab:not(.sel)");
      const selCS = sel && getComputedStyle(sel);
      const unselCS = unsel && getComputedStyle(unsel);
      // backpack slots: 5-col grid of square cells
      const grid = document.querySelector(".ml-slots");
      const gcs = getComputedStyle(grid);
      const gridRect = grid.getBoundingClientRect();
      const cols = gcs.gridTemplateColumns.trim().split(/\s+/).length;
      const gap = parseFloat(gcs.columnGap) || 0;
      const slots = [...document.querySelectorAll(".ml-slot")].map((s) => s.getBoundingClientRect());
      const wantSlotW = (gridRect.width - gap * (cols - 1)) / cols;
      return {
        iw: innerWidth, ih: innerHeight,
        tabCount: tabs.length, widths, overflow, iconOverflow,
        tabH: tab0.height, wantTabH,
        icon, iconCount: icons.length, iconOffGrid,
        selTab: sel?.dataset.tab ?? null,
        selBg: selCS?.backgroundColor ?? null, unselBg: unselCS?.backgroundColor ?? null,
        selBorder: selCS?.borderTopColor ?? null, unselBorder: unselCS?.borderTopColor ?? null,
        rowSpan: { first: rects[0].left - contentLeft, last: contentRight - rects[rects.length - 1].right },
        slotCount: slots.length, cols, wantSlotW,
        slot0: { w: slots[0].width, h: slots[0].height },
        row2Below: slots.length > 5 ? slots[5].top >= slots[0].bottom - 1 : false,
        firstRowTopSpread: Math.max(...slots.slice(0, 5).map((r) => r.top)) - Math.min(...slots.slice(0, 5).map((r) => r.top)),
      };
    });
    const vp = `iw=${m.iw}`;

    // ── six equal-width tabs fill the row content box ──
    m.tabCount === 6
      ? ok(`${label} (${vp}): 6 tabs`)
      : fail(`${label}: ${m.tabCount} tabs (want 6)`);
    const wMin = Math.min(...m.widths), wMax = Math.max(...m.widths);
    wMax - wMin <= 1.5
      ? ok(`${label}: tabs equal width (${wMin.toFixed(1)}..${wMax.toFixed(1)}px)`)
      : fail(`${label}: tab widths spread ${wMin.toFixed(1)}..${wMax.toFixed(1)}px — flex:1 not equalizing`);
    Math.abs(m.rowSpan.first) <= 1 && Math.abs(m.rowSpan.last) <= 1
      ? ok(`${label}: tabs fill the row content box (edges ${m.rowSpan.first.toFixed(1)}/${m.rowSpan.last.toFixed(1)}px)`)
      : fail(`${label}: tabs don't fill the row (left gap ${m.rowSpan.first.toFixed(1)}px, right gap ${m.rowSpan.last.toFixed(1)}px)`);
    !m.overflow
      ? ok(`${label}: all tabs fit the tab-row window`)
      : fail(`${label}: a tab overflows the tab-row window`);
    Math.abs(m.tabH - m.wantTabH) <= 1
      ? ok(`${label}: tab height ${m.tabH}px matches breakpoint (want ${m.wantTabH})`)
      : fail(`${label}: tab height ${m.tabH}px (want ${m.wantTabH} for this viewport)`);

    // ── icons: every one at its authored 1x grid (natural/2), inside its tab ──
    m.iconCount === 6 && m.iconOffGrid.length === 0
      ? ok(`${label}: all 6 icons at the authored 1x grid (first ${m.icon.w}x${m.icon.h}px = natural/2)`)
      : fail(`${label}: icons off the 1x grid: ${JSON.stringify(m.iconOffGrid)} (count ${m.iconCount})`);
    !m.iconOverflow
      ? ok(`${label}: every icon fits inside its tab`)
      : fail(`${label}: an icon overflows its tab`);

    // ── selected tab carries the accent-soft state ──
    m.selTab === "backpack"
      ? ok(`${label}: clicked tab is .sel (backpack)`)
      : fail(`${label}: .sel tab is ${m.selTab} (want backpack after the click)`);
    m.selBg && m.unselBg && m.selBg !== m.unselBg
      ? ok(`${label}: .sel background differs from unselected (${m.selBg} vs ${m.unselBg})`)
      : fail(`${label}: .sel background ${m.selBg} == unselected ${m.unselBg} — accent-soft state missing`);
    m.selBorder && m.unselBorder && m.selBorder !== m.unselBorder
      ? ok(`${label}: .sel border carries the accent (${m.selBorder})`)
      : fail(`${label}: .sel border ${m.selBorder} == unselected ${m.unselBorder} — accent border missing`);

    // ── backpack slots: 5-col grid of 15 square track-sized cells ──
    m.slotCount === 15
      ? ok(`${label}: 15 slots`)
      : fail(`${label}: ${m.slotCount} slots (want 15)`);
    m.cols === 5
      ? ok(`${label}: slot grid has 5 columns`)
      : fail(`${label}: slot grid has ${m.cols} columns (want 5)`);
    Math.abs(m.slot0.w - m.slot0.h) <= 1
      ? ok(`${label}: slots are square (${m.slot0.w.toFixed(1)}x${m.slot0.h.toFixed(1)}px)`)
      : fail(`${label}: slot ${m.slot0.w.toFixed(1)}x${m.slot0.h.toFixed(1)}px not square (aspect-ratio 1 broken)`);
    Math.abs(m.slot0.w - m.wantSlotW) <= 1.5
      ? ok(`${label}: slot width tracks the grid (${m.slot0.w.toFixed(1)} ≈ ${m.wantSlotW.toFixed(1)}px)`)
      : fail(`${label}: slot width ${m.slot0.w.toFixed(1)}px vs grid track ${m.wantSlotW.toFixed(1)}px`);
    m.firstRowTopSpread <= 1 && m.row2Below
      ? ok(`${label}: 5 slots per row, second row below the first`)
      : fail(`${label}: slot rows misaligned (first-row top spread ${m.firstRowTopSpread.toFixed(1)}px, row2Below=${m.row2Below})`);
  } finally { await page.context().close(); }
}

try {
  // the maintainer's desktop-site phone view (design width — the approved look)
  await check("desktop-site", { viewport: { width: 980, height: 2123 }, screen: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  // narrow mobile (force-desktop OFF): where the plates/icons diverged
  await check("mobile-393", { viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.75 });
  // wide mobile (1080-px phone at dpr 1.5): the maintainer's screenshot geometry
  await check("mobile-720", { viewport: { width: 720, height: 1560 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1.5 });
} finally { await browser.close(); }
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
