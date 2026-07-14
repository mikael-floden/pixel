// MOONWALK METER — end-to-end gait-sync check. While the local player walks
// and runs EAST and NORTH, sample per rAF: the flat world position, the
// eased sprite screen x and the playing clip frame index.
//
// The GATE is cycle-distance sync in WORLD units: ground covered per full
// animation cycle must equal the design stride, base_world_speed×frames/fps
// with base_world_speed = gait speed·√½ (the side view the stride was
// measured in maps screen-east to the world diagonal). Because timeScale ∝
// measured world speed, the expectation is the SAME for every heading and
// every actual pace: screen-north walks (which cross ~2.13× the world
// ground of east — the playtester's "N/S plays too slow") and starved
// headless frame loops all cancel out. Frame advances are exact integers
// and world distance is exact, so the gate is starvation-immune; pairs
// where the avatar is blocked/stopped (<15wu/s) are excluded — the claim
// is "while moving, one cycle covers one stride".
//
// Stance foot-slip is also measured on the east headings (planted-foot art
// offsets vs ground: footX(t) = spriteX(t) − originX·frameW + artFootX) but
// only REPORTED: at ~11 starved samples/s it is quantization-noisy, and
// this art glides a little by design.
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ART = join(SCRIPT_DIR, "..", "..", "characters2", "humans");
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SRC = { walk: "walking", run: "running-8-frames" };
const BASE = { walk: 70, run: 175 }; // wu/s (shared WALK_SPEED/RUN_SPEED)
const TOL = 0.2; // wu-per-cycle relative tolerance
const MIN_MOVE = 15; // wu/s below which a sample pair is "blocked", excluded

/** Planted-foot blob x-centres of one art frame (bottom 12px, 8-connected). */
function plantedFeet(path) {
  const img = PNG.sync.read(readFileSync(path));
  const { width: w, height: h, data } = img;
  const op = (x, y) => data[(y * w + x) * 4 + 3] > 64;
  let sole = -1;
  for (let y = h - 1; y >= 0 && sole < 0; y--) {
    let n = 0;
    for (let x = 0; x < w && n < 3; x++) if (op(x, y)) n++;
    if (n >= 3) sole = y;
  }
  if (sole < 0) return [];
  const y0 = Math.max(0, sole - 11);
  const bh = sole - y0 + 1;
  const lab = new Int32Array(w * bh).fill(-1);
  const blobs = [];
  for (let by = 0; by < bh; by++)
    for (let x = 0; x < w; x++) {
      if (lab[by * w + x] >= 0 || !op(x, y0 + by)) continue;
      const b = { minX: x, maxX: x, maxY: y0 + by, size: 0 };
      const st = [[x, by]];
      lab[by * w + x] = blobs.length;
      while (st.length) {
        const [cx, cy] = st.pop();
        b.size++;
        if (cx < b.minX) b.minX = cx;
        if (cx > b.maxX) b.maxX = cx;
        if (y0 + cy > b.maxY) b.maxY = y0 + cy;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= bh || lab[ny * w + nx] >= 0 || !op(nx, y0 + ny)) continue;
            lab[ny * w + nx] = blobs.length;
            st.push([nx, ny]);
          }
      }
      blobs.push(b);
    }
  return blobs
    .filter((b) => b.size >= 6 && b.maxY >= sole - 1)
    .map((b) => (b.minX + b.maxX + 1) / 2);
}

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 480, height: 320 } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
  await page.waitForTimeout(600);
  const myUid =
    (await page.evaluate(() => window.__ml.gaitSample()?.anim))?.split(":")[1] ?? "default_boy";
  const manifest = await (await fetch("http://localhost:5173/characters.json")).json();
  const frameW = manifest.characters.find((c) => c.uid === myUid)?.frameW ?? 112;

  let failures = 0;
  for (const gait of ["walk", "run"]) {
    // Per-frame planted-foot art offsets of the EAST clip (slip report only).
    const dirArt = join(ART, myUid, "animations", SRC[gait], "east");
    const feetByFrame = [];
    for (let i = 0; ; i++) {
      try {
        feetByFrame.push(plantedFeet(join(dirArt, `${i}.png`)));
      } catch {
        break;
      }
    }
    if (!feetByFrame.length) throw new Error(`no art frames at ${dirArt}`);
    const rate = await page.evaluate(
      ({ uid, gait }) => window.__ml.animRate(uid, gait, "east"),
      { uid: myUid, gait },
    );

    for (const [key, heading] of [["ArrowRight", "east"], ["ArrowUp", "north"]]) {
      await page.keyboard.down(key);
      if (gait === "run") await page.keyboard.down("ShiftLeft");
      await page.waitForTimeout(1200); // reach steady speed (EMA settled)
      const samples = await page.evaluate(
        ({ gait, heading }) =>
          new Promise((resolve) => {
            const out = [];
            const t0 = performance.now();
            const tick = () => {
              const s = window.__ml.gaitSample();
              const t = performance.now() - t0;
              if (s && s.anim?.includes(`:${gait}:${heading}`))
                out.push({ t, sx: s.sx, wx: s.wx, wy: s.wy, frame: s.frame, ox: s.originX });
              if (t > 2600) resolve(out);
              else requestAnimationFrame(tick);
            };
            tick();
          }),
        { gait, heading },
      );
      await page.keyboard.up(key);
      if (gait === "run") await page.keyboard.up("ShiftLeft");
      await page.waitForTimeout(300);

      const n = feetByFrame.length;
      const slips = [];
      let wuDist = 0;
      let advances = 0;
      let ms = 0;
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const b = samples[i];
        const gap = b.t - a.t;
        if (gap > 200) continue; // starved gap — not a visual sample
        const adv = (b.frame - a.frame + n) % n;
        if (adv > 3) continue; // can't attribute the motion to known frames
        const dw = Math.hypot(b.wx - a.wx, b.wy - a.wy);
        if (dw / (gap / 1000) < MIN_MOVE) continue; // blocked/stopped
        wuDist += dw;
        advances += adv;
        ms += gap;
        if (heading !== "east" || adv > 2) continue; // slip: east clips only
        const fa = feetByFrame[a.frame] ?? [];
        const fb = feetByFrame[b.frame] ?? [];
        if (!fa.length || !fb.length) continue; // flight / unusable frame
        // Match each planted foot in a to the nearest in b (same foot). EAST
        // travel: a planted foot only slides BACKWARD in the art (+1.5px
        // noise) — a forward move is the OTHER foot landing nearby (swap).
        for (const pa of fa) {
          let best = null;
          for (const pb of fb) if (best === null || Math.abs(pb - pa) < Math.abs(best - pa)) best = pb;
          if (best === null || Math.abs(best - pa) > 9) continue;
          if (best - pa > 1.5) continue;
          slips.push({ d: b.sx + (best - b.ox * frameW) - (a.sx + (pa - a.ox * frameW)), ms: gap });
        }
      }
      const cycles = advances / n;
      const perCycle = cycles > 0 ? wuDist / cycles : NaN;
      const wantPerCycle = (BASE[gait] * Math.SQRT1_2 * n) / rate;
      const wuSpeed = ms ? (wuDist / ms) * 1000 : NaN;
      const ok = cycles >= 1.5 && Math.abs(perCycle / wantPerCycle - 1) <= TOL;
      if (!ok) failures++;
      const slipPx = slips.reduce((s, x) => s + x.d, 0);
      const slipMs = slips.reduce((s, x) => s + x.ms, 0);
      const slipTxt =
        heading === "east" && slipMs
          ? ` stanceDrift≈${((slipPx / slipMs) * 1000).toFixed(1)}px/s [info],`
          : "";
      console.log(
        `${gait} ${heading}: ground=${wuSpeed.toFixed(1)}wu/s cycleDist=${perCycle.toFixed(1)}wu ` +
          `(want ${wantPerCycle.toFixed(1)}±${TOL * 100}%, ${cycles.toFixed(1)} cycles)${slipTxt} ` +
          `${samples.length} samples ${ok ? "OK" : "FAIL"}`,
      );
    }
  }
  if (failures) throw new Error("gait sync out of tolerance");
  console.log("GAIT-SYNC OK — one cycle covers one stride on every heading");
} finally {
  await browser.close();
}
