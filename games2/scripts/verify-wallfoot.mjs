// THE FLOOR BESIDE A WALL IS LIT LIKE THE FLOOR ONE CELL OUT — the torch pool
// must run along a wall's foot, read off the raw light field.
//
// The maintainer, at night with the torch beside a tall wall (2026-09-13,
// 285.4,115.8), drew the pool ending in a hard edge along the wall's foot:
// "standing near a wall effects how the torch light up the ground"; at
// 286.4,125.3 the ground cell in front of each face of a pillar was a flat
// dark diamond he read as the wall's bottom course. Measured: those cells sat
// at the march's 0.22 bounce floor while the cell one column out was lit.
// The LOS march reads the height map bilinear (cast shadows get a penumbra),
// and that filter smears a wall's height half a cell into the floor in front
// of it; a light that also stands beside the wall sends its ray along that
// skirt band the whole way, so every sample past the near fields read the
// wall's phantom height and the wall shadowed the floor in front of itself.
// The law now: a skirt sample counts only beside a HARD hit (a sample whose
// own cell stands above the ray); a ray that enters no taller cell is not
// shadowed at all.
//
// HOW: the same long straight wall run verify-wallwash finds on the_game,
// the probe light 0.4 cells in front of the plane at the start of the run,
// pattern 5 (the field composited opaque) sampled at the CENTRE of the ground
// cells of the front row (row r+1, the cells that touch the wall) and of the
// row one further out (r+2), along the run:
//   * FOOT  — per cell, front / out. The front cell is the CLOSER of the two
//             to the light, so the pool's own attenuation puts it at or above
//             the out cell; a skirt-shadowed front row read ~0.3 of it.
//   * REACH — where along the front row the light falls to half its range,
//             in cells, against where the pool halves on flat ground by its
//             own attenuation (0.29 r): the foot keeps at least 3/4 of it.
//   * SHADOW — a control, when the world offers one near the run: a
//             free-standing column with open floor on both sides of it. A
//             light on one side, the floor three cells beyond the column on
//             the other side must read well under the floor three cells out
//             on the light's own side: the march still casts shadows.
// GEOMETRY IS SELF-CHECKED with pattern 4 (faces RED): the wall's foot line
// is read off the classification, not derived, and the ground points are
// laid out from it (the front cell's centre is 7 world px below the middle
// of the foot edge, one row out is 32 px left and 14 down per row).
//
// Needs the dev stack (npm run dev). PORT overrides vite's port. SHOT=<dir>
// keeps the pattern screenshots.
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = process.env.PORT || "5173";
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const VW = 1600, VH = 1000;
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errs.push(`${m.type()}: ${m.text().slice(0, 400)}`); });
process.on("exit", () => { if (errs.length) console.error("--- page console ---\n" + errs.slice(0, 25).join("\n")); });
await page.goto(`http://localhost:${PORT}/#the_game`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, { timeout: 40000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 40000 });
await page.waitForTimeout(2500);
await page.evaluate(() => window.__ml.noAggro?.(true));
await page.evaluate(() => window.__ml.timeOfDay("night", true));
await page.evaluate(() => window.__ml.depthFog?.(0)); // the fog bands the field (see verify-wallwash)
await page.evaluate(() => window.__ml.torch?.(false)); // the probe is the only light

// The wall run: verify-wallwash's own finder, plus a THIRD flat row in front
// (the out row is sampled, so it needs to be floor too, with floor beyond it).
const RUN = 5;
const wall = await page.evaluate((RUN) => {
  const lv = (c, r) => window.__ml.levelAt(c * 32 + 16, r * 32 + 16);
  const near = [[250, 308], [200, 300], [300, 200], [150, 150]];
  for (const [nc, nr] of near)
    for (let r = nr - 25; r < nr + 25; r++)
      for (let c = nc - 25; c < nc + 25 - RUN; c++) {
        const top = lv(c, r);
        const g = lv(c, r + 1);
        if (!(top - g >= 3 && top - g <= 8)) continue;
        let ok = true;
        for (let k = 0; k < RUN && ok; k++) {
          if (lv(c + k, r) !== top) ok = false;
          if (lv(c + k, r + 1) !== g || lv(c + k, r + 2) !== g || lv(c + k, r + 3) !== g) ok = false;
        }
        if (ok) return { c, r, top, g };
      }
  return null;
}, RUN);
if (!wall) {
  fail("no straight wall run with three flat rows in front found near the maintainer's spots");
  await browser.close();
  process.exit(1);
}
const H = wall.top - wall.g;
console.log(`wall: cells ${wall.c}..${wall.c + RUN - 1}, row ${wall.r}, ${H} storeys over level ${wall.g}`);

// The body stands six cells off the run (its lit sprite composites above
// the field and would read as light), and the CAMERA is parked on the third
// row out (__ml.lookAt): the HUD owns the bottom 38% of the canvas, and with
// the camera on the body the two out rows fell onto the settings panel and
// read 250 luma of cream UI (the first cut's "shadow"). The light stands at
// the start of the run, 0.4 cells in front of the plane y = r + 1.
const STAND = { col: wall.c - 6.0, row: wall.r + 2.5 };
await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [STAND.col, STAND.row]);
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 60000 });
await page.waitForTimeout(1500);
await page.evaluate(([c, r]) => window.__ml.lookAt(c, r), [wall.c + 2, wall.r + 3]);
let lastCs = null, cs0 = null, cs1 = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(500);
  cs0 = await page.evaluate(([c, r]) => window.__ml.cellScreen(c, r), [wall.c, wall.r]);
  cs1 = await page.evaluate(([c, r]) => window.__ml.cellScreen(c, r), [wall.c + RUN - 1, wall.r]);
  const settled = cs0 && lastCs && Math.abs(cs0.x - lastCs.x) < 1 && Math.abs(cs0.y - lastCs.y) < 1;
  if (settled && cs0.x > 60 && cs1 && cs1.x + 40 * cs1.zoom < VW - 60 && cs0.y > 40 && cs0.y < VH - 300) break;
  lastCs = cs0;
}
console.log(`run on screen: first cell ${JSON.stringify(cs0 && { x: Math.round(cs0.x), y: Math.round(cs0.y), zoom: cs0.zoom })}, last cell x ${cs1 && Math.round(cs1.x)}`);
if (cs0 && cs0.y + 60 * cs0.zoom > VH * 0.6) fail(`the run's foot (y ${Math.round(cs0.y + 42 * cs0.zoom)}) sits in the HUD band — the out rows would read the UI`);
const FRONT = Number(process.env.FRONT ?? 0.4);
const RADIUS = Number(process.env.RADIUS ?? 6);
const LIGHT = { col: wall.c + 0.5, row: wall.r + 1 + FRONT, radius: RADIUS };
await page.evaluate(({ col, row, radius, g }) => window.__ml.probeLight(col, row, g + 0.55, radius), { ...LIGHT, g: wall.g });
await page.waitForTimeout(600);

const shoot = async (pattern) => {
  await page.evaluate((t) => window.__ml.nightCal(0, 1, t), pattern);
  await page.waitForTimeout(500);
  const buf = await page.screenshot();
  if (process.env.SHOT) {
    const fs = await import("node:fs");
    fs.writeFileSync(`${process.env.SHOT}/wallfoot-pattern${pattern}.png`, buf);
  }
  const png = PNG.sync.read(buf);
  const dpr = png.width / VW;
  const at = (x, y) => {
    const X = Math.round(x * dpr), Y = Math.round(y * dpr);
    if (X < 0 || Y < 0 || X >= png.width || Y >= png.height) return null;
    const i = (Y * png.width + X) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  return { png, at };
};
const luma = (px) => (px ? 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2] : NaN);
/** Median luma of a 3x3 patch — single pixels lie (the footstep lesson). */
const patch = (shot, x, y) => {
  const v = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v.push(luma(shot.at(x + dx, y + dy)));
  return v.sort((a, b) => a - b)[4];
};

// 1) THE FOOT LINE, from pattern 4: per run cell, the bottom of the tallest
//    red run at the column through the middle of the foot edge.
const cal = await shoot(4);
const foot = [];
for (let k = 0; k < RUN; k++) {
  const cs = await page.evaluate(([c, r]) => window.__ml.cellScreen(c, r), [wall.c + k, wall.r]);
  if (!cs) { foot.push(null); continue; }
  const x = cs.x + 16 * cs.zoom;
  let top = null, bot = null, best = null;
  for (let y = cs.y - 8 * cs.zoom; y <= cs.y + 160 * cs.zoom; y += 1) {
    const px = cal.at(x, y);
    const red = px && px[0] > 150 && px[1] < 100;
    if (red && top === null) top = y;
    if (red) bot = y;
    else if (top !== null) {
      if (!best || bot - top > best.bot - best.top) best = { top, bot };
      top = bot = null;
    }
  }
  foot.push(best ? { x: cs.x, y: best.bot, zoom: cs.zoom, band: best.bot - best.top } : null);
}
// The foot line steps 14 world px down per cell along a +row face; a cell
// whose red run ends elsewhere read another face (the terrace behind, the
// HUD's edge) and is dropped rather than sampled.
for (let k = 0; k < RUN; k++) {
  const f = foot[k];
  if (!f) continue;
  const ref = foot.find((g, j) => g && j !== k);
  if (!ref) continue;
  const j = foot.indexOf(ref);
  if (Math.abs((f.y - ref.y) - (k - j) * 14 * f.zoom) > 4 * f.zoom) foot[k] = null;
}
const found = foot.filter(Boolean).length;
console.log(`geometry: ${found}/${RUN} run cells show a face band on the foot line (pattern 4); foot y ${foot.map((f) => (f ? Math.round(f.y) : "-")).join(" ")}`);
if (found < RUN) fail(`only ${found}/${RUN} run cells show a face — the wall is not where the scan thinks`);

// 2) THE FIELD, at the ground centres laid out from the foot line.
const fld = await shoot(5);
/** Screen point of ground (c+k+s, r+1+q): from the foot edge's middle. */
const groundPt = (k, s, q) => {
  const f = foot[k];
  if (!f) return null;
  const z = f.zoom;
  // (k+0.5, 1) is the edge's middle at (f.x + 16z, f.y); +col moves (+32z, +14z), +row (-32z, +14z).
  return { x: f.x + 16 * z + (s - 0.5) * 32 * z - (q - 1) * 32 * z, y: f.y + (s - 0.5) * 14 * z + (q - 1) * 14 * z };
};
const rows = { front: 1.5, out: 2.5, out2: 3.5 };
const read = (k, s, q) => { const p = groundPt(k, s, q); return p ? patch(fld, p.x, p.y) : NaN; };
const front = [], out = [], out2 = [];
for (let k = 0; k < RUN; k++) { front.push(read(k, 0.5, rows.front)); out.push(read(k, 0.5, rows.out)); out2.push(read(k, 0.5, rows.out2)); }
console.log("front row (r+1), luma per cell: " + front.map((v) => Math.round(v)).join(" "));
console.log("out row   (r+2), luma per cell: " + out.map((v) => Math.round(v)).join(" "));
console.log("out2 row  (r+3), luma per cell: " + out2.map((v) => Math.round(v)).join(" "));
// The dark floor: the out2 row's far end is as far from the light as anything
// sampled; anything within 8 luma of it is "unlit" and no ratio is taken.
const dark = Math.min(...out2, ...out, ...front);
// FOOT: per cell from the second on (the first holds the light itself).
const ratios = [];
for (let k = 1; k < RUN; k++) {
  if (!(out[k] > dark + 8)) continue;
  ratios.push({ k, ratio: +(front[k] / out[k]).toFixed(2) });
}
console.log("foot (front/out per cell): " + ratios.map((r) => `${wall.c + r.k}:${r.ratio}`).join(" "));
for (const r of ratios)
  if (r.ratio < 0.8) fail(`cell ${wall.c + r.k}: the floor beside the wall reads ${r.ratio} of the floor one cell out — the wall is shadowing the floor in front of it`);

// REACH: half-range distance along the front row at quarter cells.
const prof = [];
for (let k = 0; k < RUN; k++) for (const s of [0.125, 0.375, 0.625, 0.875]) prof.push({ x: wall.c + k + s, l: read(k, s, rows.front) });
const peak = Math.max(...prof.map((p) => p.l));
const floor = Math.min(...prof.map((p) => p.l));
const range = peak - floor;
const lit = prof.filter((p) => p.x >= LIGHT.col).sort((a, b) => a.x - b.x);
const half = lit.find((p) => p.l <= floor + range * 0.5);
const reach = half ? half.x - LIGHT.col : RUN;
const groundReach = LIGHT.radius * (1 - Math.sqrt(0.5));
console.log("front row profile (luma per 1/4 cell): " + prof.map((p) => Math.round(p.l)).join(" "));
console.log(`reach: the foot falls to half its range ${reach.toFixed(2)} cells along the wall; the pool halves on flat ground at ${groundReach.toFixed(2)} (ratio ${(reach / groundReach).toFixed(2)})`);
if (range > 20 && reach < groundReach * 0.75) fail(`the pool dies within ${reach.toFixed(2)} cells along the foot, under 3/4 of its own ${groundReach.toFixed(2)}`);

// 3) SHADOW CONTROL: a free-standing column with three cells of floor on
//    both sides along the col axis, within 40 cells of the run.
const pillar = await page.evaluate(({ c0, r0 }) => {
  const lv = (c, r) => window.__ml.levelAt(c * 32 + 16, r * 32 + 16);
  for (let r = r0 - 40; r <= r0 + 40; r++)
    for (let c = c0 - 40; c <= c0 + 40; c++) {
      const g = lv(c - 1, r);
      if (lv(c, r) - g < 3) continue;
      let ok = true;
      for (let d = 1; d <= 3 && ok; d++) if (lv(c - d, r) !== g || lv(c + d, r) !== g) ok = false;
      if (ok) return { c, r, g, top: lv(c, r) };
    }
  return null;
}, { c0: wall.c, r0: wall.r });
if (!pillar) console.log("shadow control: no free-standing column near the run — skipped");
else {
  await page.evaluate(() => window.__ml.nightCal(0, 1, 0));
  await page.evaluate(() => window.__ml.lookAt()); // back onto the body
  await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [pillar.c + 0.5, pillar.r + 2.5]);
  await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 60000 });
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const cs = await page.evaluate(([c, r]) => window.__ml.cellScreen(c, r), [pillar.c, pillar.r]);
    const settled = cs && lastCs && Math.abs(cs.x - lastCs.x) < 1 && Math.abs(cs.y - lastCs.y) < 1;
    lastCs = cs;
    if (settled) break;
  }
  await page.evaluate(({ c, r, g }) => window.__ml.probeLight(c - 1.5, r + 0.5, g + 0.55, 8), pillar);
  await page.waitForTimeout(600);
  // The two floor points three cells from the light: on its own side and
  // beyond the column. The CPU twin (the shader's exact twin) reads them
  // without a screen mapping; both are level-g floor at the same distance.
  const [near, beyond] = await page.evaluate(({ c, r, g }) => [
    window.__ml.lightAtCell(c - 4, r, g), window.__ml.lightAtCell(c + 1, r, g),
  ], pillar);
  const mag = (v) => (v ? Math.max(...v) : NaN);
  console.log(`shadow control at column (${pillar.c},${pillar.r}) ${pillar.top - pillar.g} storeys: light-side floor ${mag(near).toFixed(3)}, floor beyond the column ${mag(beyond).toFixed(3)} (ratio ${(mag(beyond) / mag(near)).toFixed(2)})`);
  if (!(mag(beyond) < mag(near) * 0.6)) fail(`the floor beyond a ${pillar.top - pillar.g}-storey column reads ${(mag(beyond) / mag(near)).toFixed(2)} of the floor on the light's side — the column casts no shadow`);
}

console.log(JSON.stringify({ wall: `${wall.c},${wall.r}`, storeys: H, foot: ratios.map((r) => r.ratio), reach: +reach.toFixed(2), reachRatio: +(reach / groundReach).toFixed(2) }));
await page.evaluate(() => window.__ml.nightCal(0, 1, 0));
await browser.close();
