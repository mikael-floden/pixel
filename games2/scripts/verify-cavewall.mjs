// A CAVE WALL IS LIT AS HIGH AS IT IS DRAWN, FROM EVERY FLOOR (INDOOR.md,
// docs/lighting.md). The room test has a height — a sample at or above the
// deck over its OWN column is outdoors, which is what keeps a chimney on the
// roof sky-lit — and that line used to be the room's underside under MY feet.
// A cave wall carries no deck, so the scalar lit the_game's 24-storey ice wall
// at 203,232 only up to the lid I stood under: 5 storeys from the floor
// (underside 9), 8 from the landing three steps up (underside 12), black above
// — the wall grew and shrank with every step (maintainer 2026-09-17: "the wall
// height should not move when I walk around in a cave"). This stands on the
// floor and on the landing and reads the CPU twin (`lightAtCell`, the exact
// twin of the fragment's roomAt) up the wall column: the lit height must be
// the same from both, and reach the column's cut. And the roof rule it must
// not break: a floor cell under the lid goes dark at its own deck's underside.
// Needs the dev stack (npm run dev). PORT overrides vite's port.
import { chromium } from "playwright-core";
const PORT = process.env.PORT || "5173";
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await (await browser.newContext({ viewport: { width: 700, height: 1200 }, serviceWorkers: "block" })).newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.goto(`http://localhost:${PORT}/#the_game`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 60000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 90000 });
await page.waitForTimeout(2500);
await page.evaluate(() => { try { window.__ml.noAggro?.(true); window.__ml.timeOfDay("day", true); } catch {} });
// The ice wall's column beside the west strip (a shell cell, cut to the lid level 24),
// a floor cell of the chamber under the lid (underside 9), and the two floors.
const WALL = [198, 231];
const FLOOR_CELL = [203, 228];
const SPOTS = [[203.7, 232.8, "the floor (level 4)"], [204.0, 235.4, "the landing (level 7)"]];
const litHeight = (zs) => { let top = -1; zs.forEach((l, i) => { if (l > 0) top = i; }); return top; };
const results = [];
for (const [c, r, what] of SPOTS) {
  await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [c, r]);
  // The cut-away's crossfade must have landed: the twin is gated on the ease.
  let ok = false;
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(500); const s = await page.evaluate(() => window.__ml.indoor()); if (s.indoor && s.mix >= 0.999 && !s.pending === false) { ok = true; break; } }
  const d = await page.evaluate(([wc, wr, fc, fr]) => {
    const lum = (v) => (Array.isArray(v) ? 0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2] : Number(v) || 0);
    const col = (cc, rr) => Array.from({ length: 30 }, (_, z) => +lum(window.__ml.lightAtCell(cc, rr, z)).toFixed(3));
    const raise = window.__ml.indoorRaise();
    return { ind: window.__ml.indoor(), wall: col(wc, wr), floor: col(fc, fr), wallCut: raise.cuts[`${wc},${wr}`] ?? null };
  }, [...WALL, ...FLOOR_CELL]);
  const wallTop = litHeight(d.wall);
  const floorTop = litHeight(d.floor);
  console.log(`${what} at ${d.ind.cell.join(",")}: indoor ${d.ind.indoor} mix ${d.ind.mix} ceiling under me ${d.ind.ceiling} | wall (${WALL}) cut ${d.wallCut}, lit through z=${wallTop} | floor cell (${FLOOR_CELL}) lit through z=${floorTop}`);
  console.log(`   wall light per z: ${d.wall.slice(0, 26).join(" ")}`);
  if (!d.ind.indoor || !ok) fail(`${what}: not indoors with the fade landed (${JSON.stringify(d.ind)})`);
  results.push({ what, wallTop, floorTop, wallCut: d.wallCut, ceil: d.ind.ceiling });
}
const [a, b] = results;
if (a.wallTop !== b.wallTop) fail(`the wall's lit height follows the feet: through z=${a.wallTop} from ${a.what}, z=${b.wallTop} from ${b.what}`);
for (const x of results) {
  if (x.wallCut !== null && x.wallTop < x.wallCut - 1) fail(`${x.what}: the wall is drawn to ${x.wallCut} but lit only through z=${x.wallTop}`);
  // The roof rule: a floor cell of the room goes dark at ITS deck's underside
  // (9 here), whatever the ceiling under my own feet reads.
  if (x.floorTop !== 8) fail(`${x.what}: the floor cell under the lid is lit through z=${x.floorTop}, want 8 (its own deck's underside is 9)`);
}
await browser.close();
if (errs.length) console.error("page errors:", errs.slice(0, 3));
console.log(process.exitCode ? "verify-cavewall: FAILED" : "verify-cavewall: OK — the wall is lit to its cut from every floor, the roof rule holds");
