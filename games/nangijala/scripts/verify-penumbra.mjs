// Numeric check of the wall-base penumbra: with pattern 5 the RAW light
// field is composited opaque. The target class — a GATED-DARK face above
// LIT ground — must change GRADUALLY across the boundary (~16 screen px at
// zoom 2), never as a 1-2px knife. Cast-shadow edges and stacked-face depth
// steps are physical and out of scope. Uses the __ml.probeLight debug hook
// (walking is dt-clamped to a crawl on slow headless clients).
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const W = 64, TOP = 8, MID = 21, BOT = 34, LH = 19;
const aLip = (x) => BOT - (Math.abs(x + 0.5 - W / 2) / (W / 2)) * (BOT - MID);

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 2400, height: 1300 } });
await page.goto(process.env.PROBE_URL || "http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "penumbraprobe");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1200);

const scan = () =>
  page.evaluate(() => {
    const me = window.__ml.me();
    const col0 = Math.floor(me.x / 32), row0 = Math.floor(me.y / 32);
    const out = [];
    for (let row = row0 - 22; row < row0 + 22; row++)
      for (let col = col0 - 20; col < col0 + 20; col++) {
        const c = window.__ml.cellScreen(col, row);
        const fr = window.__ml.cellScreen(col + 1, row);
        const fd = window.__ml.cellScreen(col, row + 1);
        if (!c || !fr || !fd) continue;
        if (fr.level >= c.level && fd.level >= c.level) continue;
        if (c.x < 40 || c.x > 2260 || c.y < 100 || c.y > 1140) continue;
        out.push({ ...c, col, row, frLower: fr.level < c.level });
      }
    return out;
  });

let cand = await scan();
for (let tries = 0; !cand.length && tries < 6; tries++) {
  await page.waitForTimeout(1200); // camera/ground still settling
  cand = await scan();
}
if (!cand.length) throw new Error("no ledges on screen");

const setLight = (col, row, radius) =>
  page.evaluate(
    ({ col, row, radius }) => {
      const z = window.__ml.levelAt(col * 32, row * 32) + 0.55;
      return window.__ml.probeLight(col, row, z, radius);
    },
    { col, row, radius },
  );

async function measure() {
  await page.evaluate(() => window.__ml.nightCal(0, 1, 5)); // raw light field
  await page.waitForTimeout(400);
  const shot = PNG.sync.read(await page.screenshot());
  const dpr = shot.width / 2400;
  const lum = (px, py) => {
    const i = (Math.round(py) * shot.width + Math.round(px)) * 4;
    return 0.299 * shot.data[i] + 0.587 * shot.data[i + 1] + 0.114 * shot.data[i + 2];
  };
  const results = [];
  for (const c of cand) {
    for (const x of [12, 16, 24, 40, 48, 52]) {
      const sx = (c.x + (x + 0.5) * c.zoom) * dpr;
      const yB = (c.y + (aLip(x) + LH) * c.zoom) * dpr; // analytic face bottom
      // The player's lit body renders ABOVE the field at screen centre.
      if (Math.abs(sx / dpr - 1200) < 90 && yB / dpr > 520 && yB / dpr < 780) continue;
      const span = Math.round(12 * c.zoom * dpr);
      const prof = [];
      for (let dy = -span; dy <= span; dy++) prof.push(lum(sx, yB + dy));
      const total = Math.abs(prof[prof.length - 1] - prof[0]);
      if (total < 12) continue;
      let maxStep = 0;
      for (let k = 1; k < prof.length; k++) maxStep = Math.max(maxStep, Math.abs(prof[k] - prof[k - 1]));
      results.push({
        cell: `${c.col},${c.row}`, t: c.t, x,
        total: +total.toFixed(1), maxStep: +maxStep.toFixed(1), ratio: +(maxStep / total).toFixed(2),
        prof: prof.map((v) => Math.round(v)),
      });
    }
  }
  return results;
}

// Light placements: in FRONT of a ledge (lights base ground; face often lit
// too) and far LATERAL along the wall run (small frontal + large lateral
// offset -> the Lambert gate goes ~0, face dark, base ground still lit —
// the exact class the penumbra must soften).
// Prefer the ledge line the playtester reported (cols 250-253 near spawn).
const L = cand.find((c) => c.col >= 250 && c.col <= 253 && c.row >= 228 && c.row <= 235) ?? cand[0];
console.log(`chosen ledge (${L.col},${L.row}) ${L.t} l${L.level} frLower=${L.frLower}`);
const placements = L.frLower
  ? [
      { col: L.col + 2.0, row: L.row + 2.0, radius: 8, name: "front" },
      { col: L.col + 1.5, row: L.row - 4.0, radius: 10, name: "lateral" },
      { col: L.col + 1.5, row: L.row + 5.0, radius: 10, name: "lateral2" },
    ]
  : [
      { col: L.col + 2.0, row: L.row + 2.0, radius: 8, name: "front" },
      { col: L.col - 4.0, row: L.row + 1.5, radius: 10, name: "lateral" },
      { col: L.col + 5.0, row: L.row + 1.5, radius: 10, name: "lateral2" },
    ];

let targets = [], sharp = [];
for (const p of placements) {
  await setLight(p.col, p.row, p.radius);
  const res = await measure();
  // Target class: dark-face -> brighter-ground boundaries ON the chosen
  // ledge's line (the user-reported topology, gate-shadow class). Far-away
  // hits are usually cast-shadow terminators — physical edges that stay
  // crisp by design; they are reported but not asserted on.
  const t = res.filter(
    (r) =>
      r.prof[0] < 110 &&
      r.prof[r.prof.length - 1] > r.prof[0] + 18 &&
      Math.abs(+r.cell.split(",")[0] - L.col) <= 3,
  );
  console.log(`placement ${p.name} @(${p.col},${p.row}): ${res.length} edges, ${t.length} dark-face->lit-ground`);
  for (const r of t.slice(0, 4))
    console.log(
      `  ${r.cell} ${r.t} x=${r.x}: total ${r.total}, maxStep ${r.maxStep} (ratio ${r.ratio})\n    profile: ${r.prof.join(",")}`,
    );
  targets.push(...t);
  sharp.push(...t.filter((r) => r.ratio > 0.35));
  if (targets.length >= 3) break;
}
console.log(`target boundaries: ${targets.length}, knife-sharp: ${sharp.length}`);
await browser.close();
process.exit(targets.length > 0 && sharp.length === 0 ? 0 : 1);
