// QA: backpack vs settings page geometry (+ page screenshots) in the
// wiki-theme HUD remake. The settings button grid and the backpack slot grid
// must share the SAME centred content column: .ml-set and .ml-slots are both
// width:100% / max-width:560px inside the .ml-page content box, so their
// left/right edges coincide and the column is centred (and capped at 560px on
// wide viewports). The old pixel-kit "same window distances/spacing" equality
// is RELAXED to that layout: gaps are per-breakpoint CSS now (slots 10px /
// btnrow 8px; btnrow 6px at <=480w, slots 8px at <=640h) instead of one shared
// plate metric, so each grid is checked against its own breakpoint value.
// Screenshots run at the maintainer's DEVICE-WIDTH phone view (393x851 — the
// wiki-theme QA geometry; no desktop-site zoom compensation exists any more);
// the wide 980 view is kept as a geometry-only pass where the 560 cap engages.
import { chromium } from "playwright-core";

const OUT = process.env.OUT || "/tmp/qa";
const BASE = process.env.BASE || "http://localhost:5173";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);

async function openHud(ctxOpts) {
  const page = await (await browser.newContext(ctxOpts)).newPage();
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForSelector(".ml-ddhead", { timeout: 60_000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForSelector(".ml-slot", { timeout: 60_000 });
  // let the loading overlay finish its fade + remove() so real clicks land
  // (no frame compose / plate settle any more — those layers are gone).
  // 90s: the wide viewport starves headless GL and the overlay can ride its
  // 60s failsafe before hideLoading fires.
  await page.waitForSelector("#ml-loading", { state: "detached", timeout: 90_000 });
  await page.waitForTimeout(400);
  return page;
}

/** Open Settings, measure its button grid, switch to Backpack, measure the
 * slot grid — both against the shown page's content box. Tab switches go
 * through DOM .click() (the verify-hudtabs pattern): Playwright's
 * "stable"-element wait starves out at the big wide viewport (headless GL
 * runs rAF at seconds per frame there). Real pointer clicks on the tabs are
 * still exercised by the primary mobile pass (shoot()). */
async function measure(page) {
  await page.evaluate(() => document.querySelector('.ml-tab[data-tab="settings"]').click());
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const page_ = document.querySelector(".ml-page.show");
    const cs = getComputedStyle(page_);
    const pr = r(page_);
    const btns = [...document.querySelectorAll(".ml-btnrow .ml-plate-btn")].map(r);
    document.querySelector('.ml-tab[data-tab="backpack"]').click();
    const slots = [...document.querySelectorAll(".ml-slot")].map(r);
    return {
      slotCount: slots.length,
      slotLeft: slots[0].left, slotRight: slots[4].right, slotTop: slots[0].top,
      slotGap: slots[1].left - slots[0].right,
      btnLeft: btns[0].left, btnRight: btns[2].right, btnTop: btns[0].top,
      btnGap: btns[1].left - btns[0].right,
      pageLeft: pr.left, pageRight: pr.right,
      contentLeft: pr.left + parseFloat(cs.paddingLeft),
      contentRight: pr.right - parseFloat(cs.paddingRight),
      // per-breakpoint CSS gaps (hud.ts injectStyles compact fits)
      wantSlotGap: matchMedia("(max-height:640px)").matches ? 8 : 10,
      wantBtnGap: matchMedia("(max-width:480px)").matches ? 6 : 8,
    };
  });
}

function checkGeo(label, g) {
  console.log(label, JSON.stringify(g, null, 1));
  const colW = g.slotRight - g.slotLeft;
  const btnW = g.btnRight - g.btnLeft;
  const contentW = g.contentRight - g.contentLeft;
  const want = Math.min(560, contentW); // the shared max-width:560px column

  g.slotCount === 15
    ? ok(`${label}: 15 slots`)
    : fail(`${label}: ${g.slotCount} slots (want 15)`);
  Math.abs(g.slotLeft - g.btnLeft) <= 2 && Math.abs(g.slotRight - g.btnRight) <= 2
    ? ok(`${label}: settings buttons share the slot column (Δleft ${(g.slotLeft - g.btnLeft).toFixed(1)}px, Δright ${(g.slotRight - g.btnRight).toFixed(1)}px)`)
    : fail(`${label}: button column [${g.btnLeft.toFixed(1)}..${g.btnRight.toFixed(1)}] != slot column [${g.slotLeft.toFixed(1)}..${g.slotRight.toFixed(1)}]`);
  Math.abs(colW - want) <= 2
    ? ok(`${label}: slot column ${colW.toFixed(1)}px = min(560, content ${contentW.toFixed(1)})`)
    : fail(`${label}: slot column ${colW.toFixed(1)}px (want ${want.toFixed(1)} = min(560, content))`);
  Math.abs(btnW - want) <= 2
    ? ok(`${label}: button column ${btnW.toFixed(1)}px = min(560, content ${contentW.toFixed(1)})`)
    : fail(`${label}: button column ${btnW.toFixed(1)}px (want ${want.toFixed(1)} = min(560, content))`);
  const skew = (g.slotLeft - g.contentLeft) - (g.contentRight - g.slotRight);
  Math.abs(skew) <= 2
    ? ok(`${label}: column centred in the page content box (skew ${skew.toFixed(1)}px)`)
    : fail(`${label}: column off-centre by ${skew.toFixed(1)}px`);
  Math.abs(g.slotGap - g.wantSlotGap) <= 1
    ? ok(`${label}: slot gap ${g.slotGap.toFixed(1)}px matches breakpoint (want ${g.wantSlotGap})`)
    : fail(`${label}: slot gap ${g.slotGap.toFixed(1)}px (want ${g.wantSlotGap})`);
  Math.abs(g.btnGap - g.wantBtnGap) <= 1
    ? ok(`${label}: button gap ${g.btnGap.toFixed(1)}px matches breakpoint (want ${g.wantBtnGap})`)
    : fail(`${label}: button gap ${g.btnGap.toFixed(1)}px (want ${g.wantBtnGap})`);
}

try {
  // ── primary: device-width phone view — screenshots + geometry ──
  const page = await openHud({
    viewport: { width: 393, height: 851 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const shoot = async (tab, name) => {
    await page.click(`.ml-tab[data-tab="${tab}"]`);
    await page.waitForTimeout(600);
    const hud = await page.locator(".ml-pages").boundingBox();
    await page.screenshot({ path: `${OUT}/${name}.png`, clip: hud });
    console.log(`shot ${OUT}/${name}.png`);
  };
  await shoot("backpack", "page-backpack");
  await shoot("settings", "page-settings");
  await shoot("chat", "page-chat");
  checkGeo("mobile-393", await measure(page));
  await page.context().close();

  // ── wide view: geometry only — the 560px max-width cap engages here ──
  const wide = await openHud({
    viewport: { width: 980, height: 2123 }, screen: { width: 393, height: 851 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  checkGeo("desktop-site-980", await measure(wide));
  await wide.context().close();
} finally {
  await browser.close();
}
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
