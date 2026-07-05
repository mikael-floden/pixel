// Verify the character-select join screen: pick a specific character + name,
// enter the world, and confirm that choice reached the shared world.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = process.env.OUT || "/tmp";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto("http://localhost:5173/", { waitUntil: "load" });

  // Select screen appears with all characters.
  await page.waitForFunction(() => window.__mlSelect && window.__mlSelect.count() >= 1, { timeout: 20000 });
  const count = await page.evaluate(() => window.__mlSelect.count());
  await page.screenshot({ path: `${OUT}/select_screen.png` });

  // Pick character index 2 and a specific name, then enter.
  const targetUid = await page.evaluate(() => {
    window.__mlSelect.pick(2);
    return null;
  });
  await page.fill("#ml-name", "Verifier");
  const chosenUid = await page.evaluate(async () => {
    const idx = window.__mlSelect.selected();
    const m = await (await fetch("/characters.json")).json();
    return m.characters[idx].uid;
  });
  await page.click("#ml-enter");

  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 20000 });
  await page.waitForTimeout(1500);
  const myChar = await page.evaluate(() => window.__ml.myCharacter());
  await page.screenshot({ path: `${OUT}/select_world.png` });

  console.log("RESULT " + JSON.stringify({ count, chosenUid, myChar }));
  if (myChar !== chosenUid) throw new Error(`chosen ${chosenUid} but joined as ${myChar}`);
  console.log("SELECT OK");
} finally {
  await browser.close();
}
