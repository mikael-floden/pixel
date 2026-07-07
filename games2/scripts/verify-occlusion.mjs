// Visual check for the line-of-sight occlusion fade. Loads occlusion_test,
// focuses a low cell that has a tall wall directly IN FRONT of it, forces the
// fade pass, and screenshots ON vs OFF so the front geometry can be eyeballed.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUTDIR = process.env.OUTDIR || "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
const FCOL = Number(process.env.FCOL || 112);
const FROW = Number(process.env.FROW || 83);

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|404/.test(m.text())) errors.push(m.text());
  });
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  // The #hash does NOT select the world — pick it explicitly by index.
  const idx = await page.evaluate(() => window.__mlSelect.worlds().indexOf("occlusion_test"));
  if (idx < 0) throw new Error("occlusion_test world not offered in select");
  await page.evaluate((i) => window.__mlSelect.pickWorld(i), idx);
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 25000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__ml.timeOfDay("Day"));

  // Focus the test cell and nudge the camera onto it. The headless rAF loop is
  // throttled, so rebuildOccluders only runs when the camera actually moves —
  // wiggle lookAt until occluders exist.
  await page.evaluate(({ c, r }) => {
    window.__ml.occFocus(c, r);
    window.__ml.occFade(true);
  }, { c: FCOL, r: FROW });
  for (let i = 0; i < 40; i++) {
    await page.evaluate(({ c, r, i }) => window.__ml.lookAt(c + (i % 2), r), { c: FCOL, r: FROW, i });
    await page.waitForTimeout(80);
    const n = await page.evaluate(() => window.__ml.occCount().occluders);
    if (n > 0 && i > 4) break;
  }
  await page.evaluate(({ c, r }) => window.__ml.lookAt(c, r), { c: FCOL, r: FROW });
  await page.waitForTimeout(150);

  const on = await page.evaluate(() => window.__ml.occApply());
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${OUTDIR}/occ_on.png` });

  await page.evaluate(() => window.__ml.occFade(false));
  const off = await page.evaluate(() => window.__ml.occApply());
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${OUTDIR}/occ_off.png` });

  console.log("FOCUS", JSON.stringify({ FCOL, FROW }));
  console.log("ON ", JSON.stringify(on));
  console.log("OFF", JSON.stringify(off));
  console.log("worldInfo", JSON.stringify(await page.evaluate(() => window.__ml.worldInfo())));
  if (errors.length) throw new Error("page errors: " + errors.slice(0, 3).join(" | "));
  console.log("OCC-VERIFY OK");
} finally {
  await browser.close();
}
