// QA: the HUD tab (menu button) plates must stay the SAME SIZE as the backpack
// slots, and their icons a consistent fraction of the plate, at EVERY viewport
// — desktop-site AND narrow mobile (maintainer 2026-07-25: on disabling "force
// desktop view" the menu buttons stopped matching the slots and the icons read
// "too small and wrong"). Both plate and icon now scale with --ml-fs (the frame
// scale), like the slot art, so the ratios hold at all widths.
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
      const tab = document.querySelector(".ml-tab").getBoundingClientRect();
      const icon = document.querySelector(".ml-tab-icon").getBoundingClientRect();
      const slot = document.querySelector(".ml-slot").getBoundingClientRect();
      const row = document.querySelector(".ml-tabrow").getBoundingClientRect();
      const overflow = [...document.querySelectorAll(".ml-tab")].some(
        (t) => { const r = t.getBoundingClientRect(); return r.left < row.left - 1 || r.right > row.right + 1; });
      const iconOverflow = icon.width > tab.width + 1 || icon.height > tab.height + 1;
      return { tab: Math.round(tab.width), icon: Math.round(icon.width), slot: Math.round(slot.width), overflow, iconOverflow };
    });
    const plateSlot = m.tab / m.slot, iconPlate = m.icon / m.tab;
    // plate == slot (within 10%: the tab-row and slot windows are the same width)
    plateSlot >= 0.9 && plateSlot <= 1.1
      ? ok(`${label} (iw=${ctxOpts.viewport.width}): plate == slot (${m.tab} vs ${m.slot}, ${(plateSlot*100).toFixed(0)}%)`)
      : fail(`${label}: plate ${m.tab} vs slot ${m.slot} (${(plateSlot*100).toFixed(0)}%) — menu buttons ≠ backpack slots`);
    // icon a consistent 65–90% of the plate (never overflowing, never a tiny dot)
    iconPlate >= 0.65 && iconPlate <= 0.9 && !m.iconOverflow
      ? ok(`${label}: icon ${(iconPlate*100).toFixed(0)}% of the plate (${m.icon}/${m.tab})`)
      : fail(`${label}: icon ${(iconPlate*100).toFixed(0)}% of plate (${m.icon}/${m.tab}) iconOverflow=${m.iconOverflow} — too small/big or overflowing`);
    // all six tabs fit the tab-row window
    !m.overflow ? ok(`${label}: all tabs fit the tab-row window`) : fail(`${label}: a tab overflows the tab-row window`);
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
