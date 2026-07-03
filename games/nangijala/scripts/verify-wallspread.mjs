// Light-spread parity: a light CLOSE to a wall must light the wall about as
// far along the run as it lights the ground (pattern 5 = raw field). Places
// a probe light 0.8 cells in front of a wall run, then compares normalized
// falloff along the WALL FACE vs along the GROUND at the same lateral cell
// offsets. The old angular gate crushed the wall to ~1 cell.
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const W = 64, MID = 21, BOT = 34;
const aLip = (x) => BOT - (Math.abs(x + 0.5 - W / 2) / (W / 2)) * (BOT - MID);

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 2400, height: 1300 } });
await page.goto(process.env.PROBE_URL || "http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "spreadprobe");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1500);

// Find a WALL RUN: >=5 consecutive cells along a row, same level, all with a
// lower +row (south/down-screen) neighbour, fully on screen.
const run = await page.evaluate(() => {
  const me = window.__ml.me();
  const col0 = Math.floor(me.x / 32), row0 = Math.floor(me.y / 32);
  // Horizontal runs (drop to +row/south) and vertical runs (drop to +col/east).
  for (const dir of ["row", "col"]) {
    for (let row = row0 - 20; row < row0 + 20; row++) {
      for (let col = col0 - 18; col < col0 + 18; col++) {
        const cells = [];
        for (let k = 0; k < 5; k++) {
          const cc = dir === "row" ? col + k : col;
          const rr = dir === "row" ? row : row + k;
          const c = window.__ml.cellScreen(cc, rr);
          const f = dir === "row" ? window.__ml.cellScreen(cc, rr + 1) : window.__ml.cellScreen(cc + 1, rr);
          if (!c || !f || f.level >= c.level) { cells.length = 0; break; }
          if (c.x < 150 || c.x > 2100 || c.y < 150 || c.y > 1000) { cells.length = 0; break; }
          cells.push({ ...c, col: cc, row: rr, dir });
        }
        if (cells.length === 5) return cells;
      }
    }
  }
  return null;
});
if (!run) throw new Error("no 5-cell wall run on screen");
const C = run[2]; // centre cell of the run
console.log(`wall run (${run[0].col},${run[0].row})..(${run[4].col},${run[4].row}) dir=${C.dir}, ${C.t} l${C.level}`);

// Torch-like light 0.8 cells in FRONT of the centre face, at ground level.
await page.evaluate(({ col, row, dir }) => {
  const fx = dir === "row" ? col + 0.5 : col + 1.8;
  const fy = dir === "row" ? row + 1.8 : row + 0.5;
  const z = window.__ml.levelAt(fx * 32, fy * 32) + 0.55;
  window.__ml.probeLight(fx, fy, z, 6);
}, { col: C.col, row: C.row, dir: C.dir });
await page.evaluate(() => window.__ml.nightCal(0, 1, 5));
await page.waitForTimeout(400);
const shot = PNG.sync.read(await page.screenshot());
const dpr = shot.width / 2400;
const lum = (px, py) => {
  const i = (Math.round(py) * shot.width + Math.round(px)) * 4;
  return 0.299 * shot.data[i] + 0.587 * shot.data[i + 1] + 0.114 * shot.data[i + 2];
};

// WALL samples: mid-face (art row aLip+10) at the centre column of each run
// cell. GROUND samples: 1.2 cells in front of the wall line, same lateral
// offsets (art row: one cell down-screen from the face base).
const AMB = 23;
// Face sample column: south faces live on the left half near the front
// corner, east faces on the right half.
const faceX = C.dir === "row" ? 20 : 44;
const wall = [], ground = [];
for (let k = 0; k < 5; k++) {
  const c = run[k];
  const wx = (c.x + (faceX + 0.5) * c.zoom) * dpr;
  const wy = (c.y + (aLip(faceX) + 10) * c.zoom) * dpr;
  wall.push(lum(wx, wy));
  const g = await page.evaluate(({ col, row, dir }) =>
    window.__ml.cellScreen(dir === "row" ? col : col + 1, dir === "row" ? row + 1 : row),
  { col: c.col, row: c.row, dir: C.dir });
  const gx = (g.x + 32.5 * g.zoom) * dpr;
  const gy = (g.y + 28 * g.zoom) * dpr; // mid top-diamond of the fronting ground cell
  ground.push(lum(gx, gy));
}
console.log(`wall   lum by lateral offset [-2..2]: ${wall.map((v) => v.toFixed(0)).join(", ")}`);
console.log(`ground lum by lateral offset [-2..2]: ${ground.map((v) => v.toFixed(0)).join(", ")}`);

// Normalized falloff vs the centre (above ambient); compare at offsets +-2.
const norm = (arr) => {
  const c0 = Math.max(arr[2] - AMB, 1);
  return arr.map((v) => Math.max(v - AMB, 0) / c0);
};
const wn = norm(wall), gn = norm(ground);
const results = [0, 4].map((k) => ({ off: k - 2, wall: +wn[k].toFixed(2), ground: +gn[k].toFixed(2), ratio: +(wn[k] / Math.max(gn[k], 0.01)).toFixed(2) }));
for (const r of results) console.log(`  offset ${r.off}: wall ${r.wall} vs ground ${r.ground} (parity ${r.ratio})`);
// Parity: at 2 cells lateral, the wall must retain at least half of the
// ground's normalized falloff (the old gate measured ~0.1-0.3 here).
const ok = results.every((r) => r.ratio >= 0.5) && wall[2] > AMB + 25;
console.log(ok ? "OK: wall spread matches ground within 2x" : "FAIL: wall light still dies early");
await browser.close();
process.exit(ok ? 0 : 1);
