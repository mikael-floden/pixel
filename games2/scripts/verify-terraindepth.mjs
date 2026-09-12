// THE SHADER'S RESOLVE AGREES WITH THE PAINTER — the ground truth under the
// render retake (docs/depth-sort.md, 2026-09-12).
//
// A depth-tested sprite pipeline hides a body pixel where the terrain drawn
// at that pixel belongs to a NEARER column. "Which column is drawn here" is
// what the night shader's terrainResolve() answers per pixel from the height
// map; the old renderer answers the same question with painter order over
// its occluder images. This asks both at a grid of screen pixels around the
// body at a set of spots and reports how often they agree, and how the
// disagreements fall: a NEIGHBOUR cell (an art edge that overhangs its
// diamond — the small pixel diffs the maintainer allowed), a farther cell (a
// real resolve error), no image where the shader resolves (nothing drawn over
// the ground there: harmless — a body is always in front of its own ground),
// and an image where the shader resolves nothing.
//
// Needs the dev stack. SPOTS= "c,r;c,r" overrides the list. Calibration 7 of
// the night pass paints floor(cell) as bytes; __ml.occTopAt is the painter.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = process.env.PORT || "5173";
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const SPOTS = process.env.SPOTS
  ? process.env.SPOTS.split(";").map((s) => s.split(",").map(Number))
  : [[250.3, 308.4], [276.6, 178.9], [244.6, 198.4], [221.9, 288.1], [243.5, 292.5], [456, 361.8], [275, 224.5]];
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 720, height: 480 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message.slice(0, 200)));
await page.addInitScript(() => { localStorage.setItem("ml-monsters", "0"); });
await page.goto(`http://localhost:${PORT}/#the_game`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 120000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 120000 });
await page.evaluate(() => {
  window.__ml.noAggro?.(true); window.__ml.timeSpeed(0); window.__mlAmbient?.demo?.("none");
  window.__ml.timeOfDay("Day", true); window.__ml.aurora(false, true); window.__ml.weather(0, true);
});
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 60000 });
const canvas = await page.evaluate(() => { const c = document.querySelector("canvas"); return { w: c.width, h: c.height }; });
let total = { n: 0, agree: 0, neighbour: 0, far: 0, noImage: 0, shaderNone: 0 };
for (const [c, r] of SPOTS) {
  await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [c, r]);
  await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 120000 });
  await page.waitForTimeout(3000);
  await page.evaluate(([c, r]) => { window.__ml.lookAt(c, r); window.__ml.freeze(true); }, [c, r]);
  await page.waitForTimeout(1500);
  const geo = await page.evaluate(() => window.__ml.nightHash("night"));
  const w = geo.w, h = geo.h;
  // Orientation: calibration 1 paints the world-y gradient (dark at the
  // view's top). Buffer row 0 is the framebuffer's bottom.
  await page.evaluate(() => window.__ml.nightCal(0, 1, 1));
  await page.waitForTimeout(250);
  const [[lo], [hi]] = await page.evaluate(([w, h]) => window.__ml.nightSample([[w / 2, h * 0.1], [w / 2, h * 0.9]]), [w, h]);
  const flip = lo > hi; // buffer row 0 = world bottom (bright) => flipped
  await page.evaluate(() => window.__ml.nightCal(0, 1, 7));
  await page.waitForTimeout(250);
  const pts = [];
  for (let py = 3; py < h - 3; py += 3) for (let px = 3; px < w - 3; px += 3) pts.push([px, py]);
  const rgba = await page.evaluate((pts) => window.__ml.nightSample(pts), pts);
  await page.evaluate(() => window.__ml.nightCal(0, 1, 0));
  const screen = pts.map(([px, py]) => [((px + 0.5) / w) * canvas.w, (flip ? 1 - (py + 0.5) / h : (py + 0.5) / h) * canvas.h]);
  const truth = await page.evaluate((screen) => screen.map(([x, y]) => window.__ml.occTopAt(x, y)), screen);
  const cnt = { n: 0, agree: 0, neighbour: 0, far: 0, noImage: 0, shaderNone: 0 };
  const farEx = [];
  for (let i = 0; i < pts.length; i++) {
    const [R, G, B, A] = rgba[i];
    const found = A > 0;
    const col = R + (B >> 4) * 256, row = G + (B & 15) * 256;
    const t = truth[i];
    cnt.n++;
    if (!found && !t) { cnt.agree++; continue; }
    if (found && !t) { cnt.noImage++; continue; }
    if (!found && t) { cnt.shaderNone++; continue; }
    const d = Math.max(Math.abs(col - t.col), Math.abs(row - t.row));
    if (d === 0) cnt.agree++;
    else if (d <= 1) cnt.neighbour++;
    else { cnt.far++; if (farEx.length < 4) farEx.push(`px ${pts[i]} shader ${col},${row} painter ${t.col},${t.row} (${t.key.slice(0, 28)})`); }
  }
  for (const k of Object.keys(total)) total[k] += cnt[k];
  const pc = (v) => ((100 * v) / Math.max(1, cnt.n)).toFixed(1) + "%";
  console.log(`spot ${c},${r} (pass ${w}x${h}, flip ${flip}): n=${cnt.n} agree ${pc(cnt.agree)} neighbour ${pc(cnt.neighbour)} far ${pc(cnt.far)} noImage ${pc(cnt.noImage)} shaderNone ${pc(cnt.shaderNone)}`);
  for (const e of farEx) console.log("    far: " + e);
  await page.evaluate(() => window.__ml.freeze(false));
}
const pc = (v) => ((100 * v) / Math.max(1, total.n)).toFixed(1) + "%";
console.log(`ALL: n=${total.n} agree ${pc(total.agree)} neighbour ${pc(total.neighbour)} far ${pc(total.far)} noImage ${pc(total.noImage)} shaderNone ${pc(total.shaderNone)}`);
if (errs.length) fail("page errors: " + errs.slice(0, 3).join(" | "));
if (total.far / Math.max(1, total.n) > 0.02) fail(`${pc(total.far)} of pixels resolve to a column two or more cells from the painter's`);
await browser.close();
