// Elevated-pool swim FLOAT gate (dev-stack browser): water can sit at ANY
// elevation (the_island2's plateau lagoons are level-4 clear_water), and the
// swim float must settle relative to the POOL'S OWN surface — feet `swimDrop`
// px under `surfLevel·lh` — not at the absolute `-swimDrop` below world level
// 0 (the original bug: walking into a level-4 lagoon sank the character the
// whole 4 levels + swimDrop, into the cliff; maintainer: "lowered too low when
// walking into the water"). Drives the real client: teleports to the lagoon
// rim, walks in, waits for buoyancy settle, asserts the render lift via
// __ml.swimDebug().elev; then repeats in the level-0 sea to pin the historical
// behaviour (identical there by construction).
import { chromium } from "playwright-core";
import { readFileSync } from "fs";

const WORLD = "the_island2";
const w = JSON.parse(readFileSync(new URL(`../../maps2/worlds/${WORLD}/world.json`, import.meta.url)));
const LH = w.geometry?.level_px ?? 16; // px per elevation level (client MAP_GEOMETRY.lh)
const W = w.size.w, H = w.size.h;
const mat = (c, r) => { const m = w.mat[r]?.[c]; return (w.materials && w.materials[m]) || m; };
const lvl = (c, r) => w.level[r]?.[c];
const isWater = (c, r) => /water/.test(mat(c, r) ?? "");

// Find a walk-in entry (land cell whose S neighbour is water at the SAME level)
// for (a) the highest-elevation pool and (b) the level-0 sea — both derived
// from world.json so the maps agent reshaping the island keeps this gate alive.
function findEntry(wantLevel) {
  let best = null;
  for (let r = 20; r < H - 20; r++)
    for (let c = 20; c < W - 20; c++) {
      const L = lvl(c, r);
      if (!isWater(c, r) || isWater(c, r - 1) || lvl(c, r - 1) !== L) continue;
      if (wantLevel === "max" ? (best === null || L > best.L) : L === wantLevel) {
        best = { L, land: [c, r - 1], water: [c, r] };
        if (wantLevel !== "max") return best;
      }
    }
  return best;
}
const pool = findEntry("max");
const sea = findEntry(0);
if (!pool || pool.L < 1) {
  console.log(`verify-swimfloat: SKIP — ${WORLD} has no elevated pool with a same-level walk-in entry (highest=${pool?.L ?? "none"}).`);
  process.exit(0);
}
console.log(`${WORLD}: pool entry land(${pool.land}) -> water(${pool.water}) level=${pool.L}; sea entry land(${sea.land}) -> water(${sea.water})`);

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
await page.addInitScript((world) => {
  localStorage.setItem("ml-last-choice", JSON.stringify({ world, characterUid: "default_boy", name: "sf" }));
  sessionStorage.setItem("ml-rejoin", "1");
}, WORLD);
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__ml && window.__ml.players?.() >= 1, null, { timeout: 30000 });
await page.waitForTimeout(6000);

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.log(`FAIL  ${msg}`); fails++; } else console.log(`ok    ${msg}`); };

/** Teleport beside the water, walk one cell in, wait for the buoyancy settle,
 *  return the avatar's render state. */
async function walkIn(entry) {
  const [lc, lr] = entry.land;
  const [wc, wr] = entry.water;
  await page.evaluate(([c, r]) => window.__ml.teleport(c + 0.5, r + 0.5), [lc, lr]);
  await page.waitForTimeout(1200);
  await page.evaluate(([x, y]) => window.__ml.tapTo(x, y, false), [(wc + 0.5) * 32, (wr + 0.6) * 32]);
  // Wait until swimming + the fall/buoyancy has settled (elev stable).
  await page.waitForFunction(() => window.__ml.swimming?.() === true, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3500);
  return page.evaluate(() => ({
    swimming: window.__ml.swimming?.(),
    swimT: window.__ml.swimT(),
    elev: window.__ml.swimDebug()?.elev,
    me: { elev: window.__ml.me()?.elev },
  }));
}

// (a) Elevated lagoon: settle elev must be the POOL surface minus swimDrop —
// i.e. STRICTLY above the ground floor below and within a body of the surface
// (swimDrop is character/dir-dependent, ~15..60px), never near -swimDrop.
{
  const s = await walkIn(pool);
  const surface = pool.L * LH;
  console.log(`lagoon: ${JSON.stringify(s)} (pool surface = ${surface}px)`);
  ok(s.swimming === true, `lagoon: swimming (got ${s.swimming})`);
  ok(s.swimT > 0.95, `lagoon: fully afloat, swimT ~1 (got ${s.swimT?.toFixed(3)})`);
  ok(
    typeof s.elev === "number" && s.elev > surface - 70 && s.elev < surface - 4,
    `lagoon: render lift settles just under the POOL surface (elev=${s.elev?.toFixed(1)}, want ${surface}-70..${surface}-4) — the absolute-` +
      `-swimDrop bug would read ~-15..-60`,
  );
  await page.screenshot({ path: "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad/swimfloat-lagoon.png" });
}

// (b) Level-0 sea: byte-identical to the historical float (surface = 0).
{
  const s = await walkIn(sea);
  console.log(`sea: ${JSON.stringify(s)}`);
  ok(s.swimming === true, `sea: swimming (got ${s.swimming})`);
  ok(s.swimT > 0.95, `sea: fully afloat, swimT ~1 (got ${s.swimT?.toFixed(3)})`);
  ok(
    typeof s.elev === "number" && s.elev > -70 && s.elev < -4,
    `sea: render lift unchanged at level 0 (elev=${s.elev?.toFixed(1)}, want -70..-4)`,
  );
  await page.screenshot({ path: "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad/swimfloat-sea.png" });
}

await browser.close();
if (fails) { console.log(`verify-swimfloat: ${fails} FAILURE(S)`); process.exit(1); }
console.log("verify-swimfloat: OK — elevated lagoon floats at its own surface; level-0 sea unchanged.");
