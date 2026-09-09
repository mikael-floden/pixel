// verify-decks — screenshot the_game's first roof deck (the spawn house) and its
// first bridge deck from in FRONT (down-screen), so roof + walls + door and the
// bridge span are all in frame. Both spots are derived from world.json.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SP = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message.slice(0,160)));
await page.addInitScript(() => {
  localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "decktest" }));
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
// Deck footprints from the world doc; view each from in FRONT (down-screen).
const world = JSON.parse(readFileSync(new URL("../../maps2/worlds3/the_game/world.json", import.meta.url), "utf8"));
const centre = (d) => {
  const xs = d.cells.map((c) => c.x), ys = d.cells.map((c) => c.y);
  return { c: Math.round((Math.min(...xs) + Math.max(...xs)) / 2), r: Math.round((Math.min(...ys) + Math.max(...ys)) / 2), y1: Math.max(...ys) };
};
const house = centre(world.decks.find((d) => d.kind === "roof"));
const bridge = centre(world.decks.find((d) => d.kind === "bridge"));
await shoot(house.c, house.y1 + 8, "deck_house");
await shoot(house.c + 1, house.r, "deck_house_close");
await shoot(bridge.c, bridge.y1 + 5, "deck_bridge");
console.log("errs:", errs.slice(0,5).join(" | ") || "none");
await browser.close();
