// LAVA IS NOT WATER — a gate for the whole ambient domain, not one feature.
//
// `shared/src/surfaces.ts` gives lava `standable:false, swimmable:true` and
// `sound:"water"`. The game's own `isWaterAtScreen` answers
// `!standable && swimmable`, so EVERY field of lava reads as a lake except
// `harm`. Three features believed it (maintainer 2026-09-14, with the
// screenshot of crabs on a lava shore):
//
//   crabs/  walked a 480 px "shoreline" round the molten lake
//   fish/   reported lakeFrac 0.28 and spawned four rises
//   water/  painted three wavelets and a moon glint on molten rock
//
// This stands at the lava and asserts nothing water-shaped is drawn on it.
// It is deliberately a DOMAIN gate rather than an arm in three feature gates:
// the next effect that asks "is this water" inherits the same trap, and this
// is where it gets caught.
//
//   node scripts/verify-lava-is-not-water.mjs     (needs the dev stack on :5173)
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function chromePath() {
  const root = "/opt/pw-browsers";
  const c = existsSync(root)
    ? readdirSync(root).filter((d) => /^chromium(-\d+)?$/.test(d)).map((d) => join(root, d, "chrome-linux", "chrome"))
    : [];
  return [...c, join(root, "chromium")].find((p) => existsSync(p));
}

const GAME_URL = process.env.GAME_URL || "http://localhost:5173/";
let failed = false;
const fail = (m) => { console.error("FAIL:", m); failed = true; };

/** The lava lake the maintainer photographed. */
const LAVA = { c: 218, r: 209 };
/** Everything here asks the game "is this water" one way or another. */
const WATERY = ["crabs", "fish", "water", "deepwater", "bubbles", "foam"];

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(GAME_URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });
await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 60_000 });

await page.evaluate((on) => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__ml.weather(0, true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, on.includes(n));
}, WATERY);
await page.evaluate(({ c, r }) => window.__ml.teleport(c, r), LAVA);
await page.waitForTimeout(14_000);

/* ---- the trap is still there, and the probe still falls for it ------------ */
const probe = await page.evaluate(() => {
  const v = window.__ml.camView();
  let lava = 0;
  let saysWater = 0;
  for (let iy = 0; iy <= 12; iy++)
    for (let ix = 0; ix <= 16; ix++) {
      const x = v.x + (v.w * ix) / 16;
      const y = v.y + (v.h * iy) / 12;
      const p = window.__ml.pickAt(x, y);
      if (!p) continue;
      if ((window.__ml.surfaceAt(p.x, p.y)?.harm ?? 0) > 0) {
        lava++;
        if (window.__ml.waterAtScreen(x, y)) saysWater++;
      }
    }
  return { lava, saysWater };
});
console.log(`lava: ${probe.lava} molten points in view, ${probe.saysWater} of them answer waterAtScreen TRUE`);
if (!probe.lava) fail(`no lava at ${LAVA.c},${LAVA.r} — the gate is standing in the wrong place and proves nothing`);
// This is not a bug to fix, it is the CONDITION being guarded against. If the
// game ever stops calling lava water the guard is merely redundant, not wrong.
if (probe.lava && !probe.saysWater)
  console.log("note: the game no longer calls lava water — this gate is now belt-and-braces");

/* ---- nothing water-shaped may be drawn on it ------------------------------
 *
 * SAMPLED OVER A WINDOW, AND ACROSS A RE-ENTRY, because this failure is not
 * deterministic. A colony is chosen in ONE frame and then held for up to 50 s,
 * and the frames right after a TELEPORT are when the terrain probes are wrong
 * — so whether anything appears depends on which frame the search lands in.
 * Two runs of the single-sample version of this gate disagreed on identical
 * code. One reading at one instant is not evidence: take the WORST of many,
 * and arrive twice. */
const sample = async (label) => {
  const worst = new Map();
  for (let i = 0; i < 10; i++) {
    const snap = await page.evaluate((names) => {
      const out = {};
      for (const n of names) {
        const d = window.__mlAmbient.debug(n);
        if (!d) continue;
        out[n] = {
          drawn: Array.isArray(d.all) ? d.all.filter((x) => (x.a ?? 1) > 0.3).length : 0,
          colony: !!d.colony,
        };
        for (const k of ["lakeFrac", "waterFrac", "waves", "glints", "rises", "spawned"])
          if (typeof d[k] === "number") out[n][k] = d[k];
      }
      return out;
    }, WATERY);
    for (const [n, v] of Object.entries(snap)) {
      const w = worst.get(n) ?? {};
      for (const [k, x] of Object.entries(v))
        w[k] = typeof x === "boolean" ? (w[k] || x) : Math.max(w[k] ?? 0, x);
      worst.set(n, w);
    }
    await page.waitForTimeout(1000);
  }
  for (const [name, d] of worst) {
    const bits = Object.entries(d)
      .filter(([k]) => k !== "colony")
      .map(([k, v]) => `${k} ${v}`);
    console.log(`${label} ${name}: ${bits.join(", ")}${d.colony ? " A COLONY" : ""}`);
    if (d.drawn) fail(`${label} ${name} is drawing ${d.drawn} things at a lava lake`);
    if ((d.lakeFrac ?? 0) > 0.02) fail(`${label} ${name} thinks ${(d.lakeFrac * 100) | 0}% of a lava lake is a lake`);
    if ((d.waterFrac ?? 0) > 0.02) fail(`${label} ${name} thinks ${(d.waterFrac * 100) | 0}% of a lava lake is water`);
    if ((d.waves ?? 0) > 0) fail(`${label} ${name} is drawing ${d.waves} wavelets on molten rock`);
    if ((d.glints ?? 0) > 0) fail(`${label} ${name} is glinting the moon off molten rock`);
    if (d.colony) fail(`${label} crabs have a colony on a lava shore`);
  }
};

await sample("arrival:");

// LEAVE AND COME BACK. The transient is what produces the bad read, so the
// gate has to actually take the path that produces it, twice.
await page.evaluate(({ c, r }) => window.__ml.teleport(c + 40, r + 40), LAVA);
await page.waitForTimeout(6_000);
await page.evaluate(({ c, r }) => window.__ml.teleport(c, r), LAVA);
await page.waitForTimeout(14_000);
await sample("re-entry:");

await browser.close();
if (failed) { console.error("verify-lava-is-not-water: FAILED"); process.exit(1); }
console.log("verify-lava-is-not-water: OK");
