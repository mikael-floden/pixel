// End-to-end MMO check: launch two browsers, confirm they share one world and
// see each other move, and screenshot both. Uses the pre-installed Chromium.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const URL = "http://localhost:5173/";
const OUT = process.env.OUT || "/tmp";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });

async function newClient(label) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[${label} console.error] ${m.text()}`);
  });
  page.on("pageerror", (e) => console.log(`[${label} pageerror] ${e.message}`));
  await page.goto(URL, { waitUntil: "load" });
  // Enter the world through the character-select screen.
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 25000 });
  return page;
}

try {
  const p1 = await newClient("P1");
  const p2 = await newClient("P2");

  // Both browsers must converge on 2 players in the shared world.
  await p1.waitForFunction(() => window.__ml.players() >= 2, { timeout: 25000 });
  await p2.waitForFunction(() => window.__ml.players() >= 2, { timeout: 25000 });

  // Give sprites a moment to load their textures/animations.
  await p1.waitForTimeout(1500);

  // Drive P1 to walk east and confirm P1 sees itself move.
  const x0 = await p1.evaluate(() => window.__ml.myX());
  await p1.bringToFront();
  await p1.click("canvas");
  await p1.keyboard.down("ArrowRight");
  await p1.waitForTimeout(1600);
  await p1.keyboard.up("ArrowRight");
  await p1.waitForTimeout(400);
  const x1 = await p1.evaluate(() => window.__ml.myX());

  await p1.screenshot({ path: `${OUT}/mmo_p1.png` });
  await p2.screenshot({ path: `${OUT}/mmo_p2.png` });

  const result = {
    p1Players: await p1.evaluate(() => window.__ml.players()),
    p2Players: await p2.evaluate(() => window.__ml.players()),
    x0,
    x1,
    movedEast: x1 - x0,
  };
  console.log("RESULT " + JSON.stringify(result));
  if (result.p1Players < 2 || result.p2Players < 2) throw new Error("players did not converge to 2");
  if (!(result.movedEast > 5)) throw new Error("player did not move east");
  console.log("E2E OK");
} finally {
  await browser.close();
}
