/** THE WALL BAND ON SCREEN CARRIES MORE THAN ONE TILE.
 *
 * THE BUG THIS EXISTS FOR (2026-09-08). The occluder pass duplicates a wall
 * column as SPRITES over the ground texture and stacked ONE key for the whole
 * band, so every mountain drew a single tile repeated its full height. The
 * resolver varied the tile per storey and the ground texture was painted
 * correctly from `wall.stack`, so every instrument we had — the resolver, cell
 * dumps, `groundHash` — reported variety while the screen showed a repeat.
 * Five rounds of tuning the RULE changed nothing the maintainer could see. The
 * missing instrument was one that reads what is drawn.
 *
 * IT READS `occDump`, NOT THE RESOLVER, on purpose: the sprites are the thing
 * in front of the player. And it excludes the CAP — the cap is a different
 * tile from the courses by construction, so counting it scores a column of one
 * repeated face as "two distinct tiles" and the check passes against the exact
 * bug it is for (measured: the old one-key band scored 2 on every column).
 *
 * Needs the dev stack (npm run dev). PORT overrides vite's port.
 *   node games2/scripts/verify-wallband.mjs
 */
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = process.env.PORT || "5173";
const WORLD = "the_game";
/* The maintainer's own spot, from the screenshot he reported it on: a 24-storey
 * grey_stone/black_rock face he is standing at the foot of. */
const AT = [285.8, 119.4];
const MIN_STOREYS = 8; // a band shorter than this cannot show a repeat

const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

const b = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
/* His device geometry: dpr 2.75 sets renderScale, the camera zoom and the texel
 * grid, and a wall artefact simply is not there to find at another one. */
const page = await b.newPage({
  viewport: { width: 393, height: 851 },
  deviceScaleFactor: 2.75,
  isMobile: true,
  hasTouch: true,
});
await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.evaluate(
  (w) => {
    localStorage.setItem(
      "ml-last-choice",
      JSON.stringify({ world: w, characterUid: "default_boy", name: "WallBand" + Math.floor(Math.random() * 1e5) }),
    );
    sessionStorage.setItem("ml-rejoin", "1");
  },
  WORLD,
);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
// The remembered choice preselects the world; click through rather than trust
// the rejoin flag, which does not always fire on a cold boot.
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((e) => /enter world/i.test(e.textContent || ""));
  b?.click();
});
await page
  .waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 120000 })
  .catch(() => fail(`never joined ${WORLD}`));
await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 60000 }).catch(() => {});
await page.evaluate((at) => window.__ml.teleport(at[0], at[1]), AT);
// The terrain streams per file; a band still loading falls back to the
// representative course and would read as a repeat that is not one.
await page.waitForTimeout(9000);

const r = await page.evaluate((minStoreys) => {
  // occDump rows are [key, x, y, depth, ocCol, ocRow].
  const rows = window.__ml.occDump().occluders || [];
  const byCol = new Map();
  for (const [key, , y, , col, row] of rows) {
    const k = `${col},${row}`;
    const e = byCol.get(k) || { imgs: [] };
    e.imgs.push({ key, y });
    byCol.set(k, e);
  }
  const cols = [...byCol.entries()]
    .map(([cell, v]) => {
      const band = [...v.imgs].sort((a, b) => a.y - b.y).slice(1); // drop the cap
      return { cell, storeys: band.length, distinct: new Set(band.map((i) => i.key)).size };
    })
    .filter((c) => c.storeys >= minStoreys)
    .sort((a, b) => b.storeys - a.storeys);
  return { occluders: rows.length, tall: cols.slice(0, 20) };
}, MIN_STOREYS);

console.log(`occluders in view: ${r.occluders}   tall wall columns: ${r.tall.length}`);
for (const c of r.tall.slice(0, 6))
  console.log(`  cell ${c.cell}: ${c.storeys} storeys, ${c.distinct} distinct tiles`);

if (!r.tall.length) fail(`no wall column of ${MIN_STOREYS}+ storeys in view at ${AT} — the check saw nothing, which is not a pass`);
else {
  const flat = r.tall.filter((c) => c.distinct === 1);
  if (flat.length) fail(`${flat.length} of ${r.tall.length} bands draw ONE tile top to bottom: ${flat.map((c) => c.cell).join(" ")}`);
  else console.log(`OK — all ${r.tall.length} tall bands carry more than one tile`);
}
await b.close();
