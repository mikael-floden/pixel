// Deck DAY-LIGHTING gate: a player standing on a deck (roof/bridge) must be lit
// by the daytime sun like any other high ground — NOT shaded as if it were down
// on the base terrain UNDER the deck. The bug: the avatar's lit-copy sampled the
// sun at the BASE terrain level (the floor beneath the roof), so the roof/walls
// occluded the sun and the character rendered dark in full daylight until it
// stepped onto a wall (base genuinely at deck level). The fix samples the sun at
// the avatar's OWN rendered elevation (a.elev → levels), so a deck top is lit.
//
// This asserts the shader/world invariant the fix rides on, DERIVED FROM WORLD
// DATA (like verify-deckwalk) so a maps re-height doesn't break it:
//   (1) deck-top LIT   — sunAt(interior cell, DECK level) is ~full sun,
//   (2) the GAP exists  — sunAt(interior cell, BASE level) is meaningfully
//       darker, i.e. the level you sample REALLY matters (else the fix is moot).
// Static probes on the real occlusion_test world at Day — no avatar navigation
// (deterministic, starvation-immune), same family as verify-sunshadow.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const world = JSON.parse(readFileSync(join(here, "..", "..", "maps2", "worlds", "occlusion_test", "world.json"), "utf8"));
const X = (c) => c.col ?? c.x, Y = (c) => c.row ?? c.y;
const baseLevelAt = (c, r) => world.level?.[r]?.[c] ?? 0;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// Interior cells per deck: footprint cells whose BASE sits below the deck level
// (the raised span you walk on OVER a floor/water gap). Cap the sample per deck.
const decks = (world.decks ?? []).map((d) => ({
  kind: d.kind ?? "deck",
  level: d.level,
  interior: d.cells.map((c) => ({ c: X(c), r: Y(c) })).filter(({ c, r }) => baseLevelAt(c, r) < d.level - 0.5).slice(0, 16),
}));
if (!decks.length) { console.log("verify-decklight: no decks in occlusion_test?!"); process.exit(1); }

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
await page.addInitScript(() => { localStorage.setItem("ml-last-choice", JSON.stringify({ world: "occlusion_test", characterUid: "default_boy", name: "dl" })); sessionStorage.setItem("ml-rejoin", "1"); });
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__ml && window.__ml.players?.() >= 1, null, { timeout: 30000 });
await page.evaluate(() => window.__ml.timeOfDay("Day"));
await page.waitForTimeout(400);

let fails = 0;
for (const d of decks) {
  const top = [], base = [];
  for (const { c, r } of d.interior) {
    top.push(await page.evaluate(([c, r, z]) => window.__ml.sunAt(c, r, z), [c, r, d.level]));
    base.push(await page.evaluate(([c, r, z]) => window.__ml.sunAt(c, r, z), [c, r, 0]));
  }
  const mTop = median(top), mBase = median(base);
  const lit = mTop > 0.9;               // deck top gets ~full sun
  const gap = mTop - mBase > 0.15;      // sampling the base instead would shade you
  console.log(`${d.kind}: level ${d.level}, ${d.interior.length} interior cells — deck-top sun ${mTop.toFixed(3)} (lit ${lit}), base sun ${mBase.toFixed(3)}, gap ${(mTop - mBase).toFixed(3)} (${gap})`);
  if (!lit) { console.log(`  FAIL ${d.kind}: deck top is not lit at Day (median ${mTop.toFixed(3)} ≤ 0.9)`); fails++; }
  if (!gap) { console.log(`  FAIL ${d.kind}: no base/deck lighting gap — the sampled level wouldn't matter`); fails++; }
}
await browser.close();

if (fails) { console.log(`verify-decklight: ${fails} FAILURE(S)`); process.exit(1); }
console.log(`verify-decklight: OK — ${decks.length} deck(s) lit on top at Day; base-under-deck is shaded (avatar must sample at its own elevation).`);
