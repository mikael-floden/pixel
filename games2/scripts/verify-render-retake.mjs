// THE RENDER RETAKE'S PARITY GATE — the depth-tested sprite path against the
// occluder-sprite path, same session, same frozen frame, measured in pixels
// (docs/depth-sort.md, 2026-09-12).
//
// At each spot the world is frozen (anims paused, clock stopped, weather off,
// the night pass's animation clock pinned), the sprite path is screenshotted
// twice (the baseline: what the frozen frame itself still moves), then the
// path is flipped to `?occ=depth` live and screenshotted again. Reported per
// spot: how many pixels changed, HOW MUCH (mean and max absolute channel
// difference over the changed pixels — the maintainer's ask: "measure not
// only if the pixel changed, measure how much"), and the 24 px block that
// changed most, so a real regression is one glance at the saved images:
// <OUT>/rr-<c>,<r>-{sprites,depth,diff}.png.
//
// Needs the dev stack. SPOTS="c,r;c,r" overrides the list; OUT= the image
// directory (default: no images). Fails on a page error or when the changed
// share INSIDE the bodies' art boxes exceeds MAXPCT (default 3%) — terrain
// outside them differs by design (see docs/depth-sort.md).
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = process.env.PORT || "5173";
const OUT = process.env.OUT || "";
const MAXPCT = Number(process.env.MAXPCT || 3);
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const SPOTS = process.env.SPOTS
  ? process.env.SPOTS.split(";").map((s) => s.split(",").map(Number))
  : [[250.3, 308.4], [276.6, 178.9], [244.6, 198.4], [221.9, 288.1], [243.5, 292.5], [456, 361.8], [275, 224.5], [273, 185]];
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 720, height: 480 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message.slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error" || /terrain-depth|shader/i.test(m.text())) errs.push(m.text().slice(0, 300)); });
await page.addInitScript(() => { localStorage.setItem("ml-monsters", "0"); localStorage.setItem("ml-occ-path", "sprites"); });
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

// The game canvas alone (the DOM HUD below it is not under test).
const box = await page.evaluate(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
const shot = async () => PNG.sync.read(await page.screenshot({ type: "png", clip: box }));
/** Two shots of a frame that has stopped changing (toasts fade, the cut-away
 *  and light grade ease after a teleport): retried until the pair agrees. */
async function settled() {
  let a = await shot();
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(500);
    const b = await shot();
    const m = compare(a, b);
    if (m.pct < 0.05) return [a, b, m];
    a = b;
  }
  const b = await shot();
  return [a, b, compare(a, b)];
}
/** Pixel metrics between two same-size PNGs; `boxes` (screenshot px) split
 *  the count into ON A BODY (the retake's subject) and elsewhere (terrain). */
function compare(a, b, boxes = []) {
  const w = a.width, h = a.height;
  const B = 24, bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const blocks = new Float64Array(bw * bh);
  let changed = 0, sum = 0, max = 0, bodyN = 0, bodyChanged = 0, bodySum = 0, bodyMax = 0;
  const diff = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    diff.data[i] = d; diff.data[i + 1] = d; diff.data[i + 2] = d; diff.data[i + 3] = 255;
    let onBody = false;
    for (const bx of boxes) if (x >= bx.x0 && x < bx.x1 && y >= bx.y0 && y < bx.y1) { onBody = true; break; }
    if (onBody) bodyN++;
    if (d > 0) {
      changed++; sum += d; if (d > max) max = d;
      blocks[Math.floor(y / B) * bw + Math.floor(x / B)] += d;
      if (onBody) { bodyChanged++; bodySum += d; if (d > bodyMax) bodyMax = d; }
    }
  }
  let bi = 0;
  for (let i = 1; i < blocks.length; i++) if (blocks[i] > blocks[bi]) bi = i;
  const worst = { x: (bi % bw) * B, y: Math.floor(bi / bw) * B, sum: Math.round(blocks[bi]) };
  return {
    w, h, changed, pct: (100 * changed) / (w * h), mean: changed ? sum / changed : 0, max, worst, diff,
    body: { n: bodyN, changed: bodyChanged, pct: (100 * bodyChanged) / Math.max(1, bodyN), mean: bodyChanged ? bodySum / bodyChanged : 0, max: bodyMax },
  };
}
const fmt = (m) => `changed ${m.pct.toFixed(2)}% (${m.changed}px) mean ${m.mean.toFixed(1)} max ${m.max} worst@${m.worst.x},${m.worst.y}(${m.worst.sum})`;
const fmtBody = (m) => `bodies ${m.body.pct.toFixed(2)}% of ${m.body.n}px mean ${m.body.mean.toFixed(1)} max ${m.body.max}`;
if (OUT) fs.mkdirSync(OUT, { recursive: true });
for (const [c, r] of SPOTS) {
  await page.evaluate(() => window.__ml.occDepth(false));
  await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [c, r]);
  await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 120000 });
  await page.waitForTimeout(3000);
  await page.evaluate(([c, r]) => { window.__ml.lookAt(c, r); window.__ml.freeze(true); }, [c, r]);
  await page.waitForTimeout(1500);
  const [a1, , base] = await settled();
  await page.evaluate(() => window.__ml.occDepth(true));
  await page.waitForTimeout(1000);
  const [b] = await settled();
  const probe = await page.evaluate(() => window.__ml.occDepth());
  const bb = await page.evaluate(() => window.__ml.bodyBoxes());
  const k = box.width / bb.w; // game px → screenshot px
  const boxes = bb.boxes.map((q) => ({ x0: q.x0 * k, y0: q.y0 * k, x1: q.x1 * k, y1: q.y1 * k }));
  const m = compare(a1, b, boxes);
  const tag = `${c},${r}`;
  console.log(`spot ${tag}: sprites-vs-depth ${fmt(m)} | ${fmtBody(m)} | baseline ${fmt(base)} | pipe ${probe.pipe} quads ${probe.quads} tested ${probe.tested} occluders ${probe.occluders}`);
  if (OUT) {
    fs.writeFileSync(path.join(OUT, `rr-${tag}-sprites.png`), PNG.sync.write(a1));
    fs.writeFileSync(path.join(OUT, `rr-${tag}-depth.png`), PNG.sync.write(b));
    fs.writeFileSync(path.join(OUT, `rr-${tag}-diff.png`), PNG.sync.write(m.diff));
  }
  // The gate is the BODIES: terrain itself differs by design (the sprite copies
  // re-pasted raw art over the ground texture's composed faces).
  if (m.body.pct > MAXPCT) fail(`spot ${tag}: ${m.body.pct.toFixed(2)}% of body pixels differ between the paths`);
  await page.evaluate(() => { window.__ml.freeze(false); window.__ml.occDepth(false); });
}
if (errs.length) fail("page errors: " + errs.slice(0, 3).join(" | "));
await browser.close();
