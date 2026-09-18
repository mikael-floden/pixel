// THE TORCH ON A BRIDGE LIGHTS NEITHER THE WATER UNDER THE DECK NOR THE FAR SIDE
// (docs/lighting.md; maintainer 2026-09-18, 282.6,246.3 at Night). Walks onto
// the bridge at 279..285,244..246 (deck level 4) from the east bank with the
// torch on and reads the CPU twin: the water under the deck at the ambient,
// the deck top lit. Needs the dev stack (npm run dev). PORT overrides vite's port.
import { chromium } from "playwright-core";
const PORT = process.env.PORT || "5173";
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await (await browser.newContext({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, serviceWorkers: "block" })).newPage();
page.on("console", (m) => { if (/shader night unavailable/i.test(m.text())) console.log("console:", m.text().slice(0, 200)); });
await page.goto(`http://localhost:${PORT}/#the_game`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 120000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
await page.waitForTimeout(2500);
await page.evaluate(() => window.__ml.noAggro?.(true));
await page.evaluate(() => window.__ml.teleport(287.2, 245.5));
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 60000 });
await page.waitForTimeout(12000);
for (let a = 0; a < 6; a++) { await page.evaluate(() => window.__ml.timeSpeed(0)); await page.waitForTimeout(500); await page.evaluate(() => window.__ml.timeOfDay("Night", true)); await page.waitForTimeout(1200); const t = await page.evaluate(() => window.__ml.timeOfDay()); if (t?.name === "Night") break; }
await page.evaluate(() => window.__ml.torch?.(true));
await page.keyboard.down("w"); await page.keyboard.down("a");
for (let i = 0; i < 60; i++) { await page.waitForTimeout(250); const me = await page.evaluate(() => window.__ml.indoor().cell); if (me[0] <= 283) break; }
await page.keyboard.up("w"); await page.keyboard.up("a");
await page.waitForTimeout(3000);
// THE TORCH'S OWN SHARE: the same cells with the torch off first (the aurora
// and the bank's lamps reach the water on their own; only the torch's delta
// is the claim).
await page.evaluate(() => window.__ml.torch?.(false));
await page.waitForTimeout(2500);
const off = await page.evaluate(() => { const o = {}; for (const [c, r, z] of [[283, 245, 0], [283, 246, 0], [282, 245, 0], [284, 245, 0], [283, 245, 4]]) o[`${c},${r},${z}`] = window.__ml.lightAt(c + 0.5, r + 0.5, z); return o; });
await page.evaluate(() => window.__ml.torch?.(true));
await page.waitForTimeout(2500);
const d = await page.evaluate(() => { const o = {}; const me = window.__ml.indoor(); o.cell = me.cell; o.lvl = me.renderedLvl; o.torch = window.__ml.lights()[0];
  for (const [c, r, z] of [[283, 245, 0], [283, 246, 0], [282, 245, 0], [284, 245, 0], [283, 245, 4], [286, 246, 0]]) o[`${c},${r},${z}`] = { l: window.__ml.lightAt(c + 0.5, r + 0.5, z).map((v) => +v.toFixed(3)), occ: window.__ml.occAt(c + 0.5, r + 0.5, z).occ[0] };
  return o; });
const amb = await page.evaluate(() => window.__ml.timeOfDay().ambient);
const luma = (v) => 0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2];
console.log(`on the deck at ${d.cell} level ${d.lvl}, torch z ${d.torch?.z}; ambient luma ${luma(amb).toFixed(3)}`);
if (!(d.lvl >= 3.5 && d.torch && d.torch.z > 4)) fail(`the walk did not reach the deck (cell ${d.cell}, level ${d.lvl})`);
for (const k of ["283,245,0", "283,246,0", "282,245,0", "284,245,0"]) {
  const l = luma(d[k].l);
  const l0 = luma(off[k]);
  console.log(`water under the deck ${k}: luma torch off ${l0.toFixed(3)} / on ${l.toFixed(3)} (+${(l - l0).toFixed(3)})`);
  if (!(l - l0 <= 0.02)) fail(`the torch on the deck lights the water under it at ${k} (+${(l - l0).toFixed(3)} luma)`);
}
const top = luma(d["283,245,4"].l);
const top0 = luma(off["283,245,4"]);
console.log(`deck top 283,245: luma torch off ${top0.toFixed(3)} / on ${top.toFixed(3)}`);
if (!(top - top0 >= 0.15)) fail(`the deck top is not lit by the torch on it (+${(top - top0).toFixed(3)})`);
await browser.close();
console.log(process.exitCode ? "verify-bridgelight: FAIL" : "verify-bridgelight: ALL OK");
