// QA: select-screen world dropdown (closed/open) + pressed-content dip,
// in the maintainer's real phone geometry (desktop-site layout on phone).
// Press checks HOLD and then slide OFF before releasing, so no button ever
// clicks (releasing on Enter would commit and tear the screen down).
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
await page.waitForTimeout(1200); // plates + bg settle

await page.screenshot({ path: `${OUT}/dd-closed.png` });

// open the dropdown
await page.click("#ml-dd-head");
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/dd-open.png` });

// pressed option row: hold, shoot, slide off, release (no click)
const row = page.locator(".ml-ddrow").first();
const box = await row.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/dd-row-press.png`, clip: box });
await page.mouse.move(box.x + box.width / 2, box.y - 40);
await page.mouse.up();
await page.waitForTimeout(200);

// round-trip: pick the 3rd row, list must fold, head label must update
await page.locator(".ml-ddrow").nth(2).click();
await page.waitForTimeout(300);
console.log("picked:", await page.evaluate(() => window.__mlSelect.selectedWorld()));
console.log("label:", await page.locator("#ml-dd-label").textContent());
console.log("list hidden:", await page.locator("#ml-dd-list").isHidden());
await page.screenshot({ path: `${OUT}/dd-picked.png` });

// pressed Enter: hold, shoot both states, slide off, release (no commit)
const enter = page.locator("#ml-enter");
const eb = await enter.boundingBox();
await page.screenshot({ path: `${OUT}/enter-up.png`, clip: eb });
await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2);
await page.mouse.down();
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/enter-down.png`, clip: eb });
await page.mouse.move(eb.x + eb.width / 2, eb.y - 40);
await page.mouse.up();
console.log("overlay alive:", await page.locator(".ml-panel").isVisible());
await browser.close();
