import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SP = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message.slice(0,160)));
await page.addInitScript(() => {
  localStorage.setItem("ml-last-choice", JSON.stringify({ world: "occlusion_test", characterUid: "default_boy", name: "decktest" }));
  sessionStorage.setItem("ml-rejoin", "1"); // take the fast-path (skip select)
});
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 25000 });
await page.waitForTimeout(1500);
const info = await page.evaluate(() => ({ world: window.__ml.worldInfo(), decks: window.__ml.deckInfo() }));
console.log("world:", JSON.stringify(info));
await page.evaluate(() => window.__ml.timeOfDay("Day"));
const { writeFileSync } = await import("fs");
const shoot = async (col, row, name) => { await page.evaluate(([c,r]) => window.__ml.lookAt(c, r), [col, row]); await page.waitForTimeout(900); writeFileSync(`${SP}/${name}.png`, await page.screenshot()); };
// House roof cells x54-63,y104-111 — view from in FRONT (down-screen) so we see roof+walls+door
await shoot(58, 118, "deck_house");
await shoot(59, 108, "deck_house_close");
// Bridge x39-46,y108-112 — from in front
await shoot(42, 116, "deck_bridge");
console.log("errs:", errs.slice(0,5).join(" | ") || "none");
await browser.close();
