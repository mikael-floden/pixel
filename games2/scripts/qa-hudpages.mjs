// QA: backpack vs settings page geometry in the maintainer's phone view —
// the settings buttons must respect the same window distances/spacing as
// the backpack slot grid.
import { chromium } from "playwright-core";

const OUT = process.env.OUT || "/tmp/qa";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({
  viewport: { width: 980, height: 2123 },
  screen: { width: 393, height: 851 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto("http://localhost:5173/");
await page.waitForSelector(".ml-ddhead", { timeout: 60_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForSelector(".ml-slot", { timeout: 60_000 });
await page.waitForTimeout(2500); // frame compose + plates settle

const shoot = async (tab, name) => {
  await page.click(`.ml-tab[data-tab="${tab}"]`);
  await page.waitForTimeout(600);
  const hud = await page.locator(".ml-pages").boundingBox();
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: hud });
};
await shoot("backpack", "page-backpack");
await shoot("settings", "page-settings");
await shoot("chat", "page-chat");
await page.click('.ml-tab[data-tab="settings"]');
await page.waitForTimeout(400);

// numeric check: first/last column edges + gaps, slots vs buttons
const geo = await page.evaluate(() => {
  const r = (el) => el.getBoundingClientRect();
  const page_ = r(document.querySelector(".ml-page.show"));
  const btns = [...document.querySelectorAll(".ml-btnrow .ml-plate-btn")].map(r);
  document.querySelector('.ml-tab[data-tab="backpack"]').click();
  const slots = [...document.querySelectorAll(".ml-slot")].map(r);
  return {
    slotLeft: slots[0].left, slotRight: slots[4].right, slotTop: slots[0].top,
    slotGap: slots[1].left - slots[0].right,
    btnLeft: btns[0].left, btnRight: btns[2].right, btnTop: btns[0].top,
    btnGap: btns[1].left - btns[0].right,
    pageLeft: page_.left, pageRight: page_.right,
  };
});
console.log(JSON.stringify(geo, null, 1));
await browser.close();
