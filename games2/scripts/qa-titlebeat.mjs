// QA: title screen → select transition (games agent's veil + my auto-advance
// + logo balanced→select translate). Phone geometry.
import { chromium } from "playwright-core";

const OUT = process.env.OUT || "/tmp/qa";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

const geo = { viewport: { width: 980, height: 2123 }, screen: { width: 393, height: 851 },
  isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const logoState = (page) => page.evaluate(() => {
  const l = document.querySelector(".ml-logo");
  const v = document.querySelector(".ml-title-veil");
  const r = l.getBoundingClientRect();
  return {
    logoCenter: Math.round(r.top + r.height / 2),
    transform: getComputedStyle(l).transform,
    opacity: Number(getComputedStyle(l).opacity).toFixed(2),
    veilOpacity: v ? Number(getComputedStyle(v).opacity).toFixed(2) : "gone",
  };
});

// ── FRESH LAUNCH (title beat + auto-advance + translate) ──
{
  const page = await (await browser.newContext(geo)).newPage();
  await page.goto("http://localhost:5173/");
  await page.waitForSelector(".ml-logo", { timeout: 60_000 });
  const timeline = [];
  for (const t of [300, 800, 1200, 1600, 2000, 2800]) {
    await page.waitForTimeout(t - (timeline.at(-1)?.t ?? 0));
    await page.screenshot({ path: `${OUT}/title-${String(t).padStart(4, "0")}.png` });
    timeline.push({ t, ...(await logoState(page)) });
  }
  console.log("FRESH timeline:");
  for (const s of timeline) console.log(" ", JSON.stringify(s));
  await page.context().close();
}

// ── FROM GAME (flag set → no title beat, logo already home, fade in) ──
{
  const page = await (await browser.newContext(geo)).newPage();
  await page.addInitScript(() => { try { sessionStorage.setItem("ml-from-game", "1"); } catch {} });
  await page.goto("http://localhost:5173/");
  await page.waitForSelector(".ml-logo", { timeout: 60_000 });
  await page.waitForTimeout(120);
  console.log("FROMGAME early:", JSON.stringify(await logoState(page)));
  await page.waitForTimeout(1500);
  console.log("FROMGAME settled:", JSON.stringify(await logoState(page)));
  await page.screenshot({ path: `${OUT}/fromgame-settled.png` });
  await page.context().close();
}

await browser.close();
