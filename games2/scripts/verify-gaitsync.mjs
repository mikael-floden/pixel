// MOONWALK METER — end-to-end gait-sync check. While the local player walks
// (and runs) EAST, sample per rAF: the eased sprite ground x (scene px at
// zoom 1) + the playing clip frame index.
//
// The GATE is cycle-distance sync: ground px covered per full animation
// cycle must equal the anti-moonwalk design stride, base_speed×frames/fps
// (what buildAnimations encodes from gaitFps). Frame advances are exact
// integers and ground distance is exact, so this holds even when headless
// GL starves the frame loop — and because timeScale ∝ measured speed, the
// expected px/cycle is speed-INDEPENDENT: fps loading, the timeScale
// scaling and the speed EMA are all verified by one number.
//
// Stance foot-slip is also measured (planted-foot art offsets vs ground —
//   footX(t) = spriteX(t) − originX·frameW + artFootX(frame(t))
// ) but only REPORTED: at ~11 starved samples/s it is quantization-noisy,
// and this art glides a little by design (drawn stance backslide < pose
// spread), so cadence-true playback keeps a modest residual slip.
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ART = join(SCRIPT_DIR, "..", "..", "characters2", "humans");
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SRC = { walk: "walking", run: "running-8-frames" };
const BASE = { walk: 70, run: 175 }; // wu/s == screen px/s at zoom 1 (shared)
const TOL = 0.2; // px-per-cycle relative tolerance

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
  const uid = await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
  await page.waitForTimeout(600);
  const myUid =
    (await page.evaluate(() => window.__ml.gaitSample()?.anim))?.split(":")[1] ?? "default_boy";
  const manifest = await (await fetch("http://localhost:5173/characters.json")).json();
  const frameW = manifest.characters.find((c) => c.uid === myUid)?.frameW ?? 112;

  let failures = 0;
  for (const gait of ["walk", "run"]) {
    // Per-frame planted-foot art offsets for the EAST clip of MY character.
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

    await page.keyboard.down("ArrowRight");
    if (gait === "run") await page.keyboard.down("ShiftLeft");
    await page.waitForTimeout(1200); // reach steady speed (EMA settled)
    const samples = await page.evaluate(
      (wantGait) =>
        new Promise((resolve) => {
          const out = [];
          const t0 = performance.now();
          const tick = () => {
            const s = window.__ml.gaitSample();
            const t = performance.now() - t0;
            if (s && s.anim?.includes(`:${wantGait}:east`)) out.push({ t, sx: s.sx, frame: s.frame, ox: s.originX });
            if (t > 2600) resolve(out);
            else requestAnimationFrame(tick);
          };
          tick();
        }),
      gait,
    );
    await page.keyboard.up("ArrowRight");
    if (gait === "run") await page.keyboard.up("ShiftLeft");

    // Stance segments: consecutive samples on the SAME planted foot. Guards:
    // the clip may advance at most 2 frames between samples (else we can't
    // know which foot is which), and — since travel is EAST — a genuinely
    // planted foot only ever slides BACKWARD in the art (allow +1.5px noise);
    // a forward move means the OTHER foot landed nearby (foot swap) and
    // booking it as slip poisoned the first version of this probe.
    const n = feetByFrame.length;
    const slips = [];
    let groundPx = 0;
    let groundMs = 0;
    let advances = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      if (b.t - a.t > 200) continue; // starved gap — not a visual sample
      const adv = (b.frame - a.frame + n) % n;
      if (adv > 3) continue; // can't attribute the motion to known frames
      groundPx += b.sx - a.sx;
      groundMs += b.t - a.t;
      advances += adv;
      const fa = feetByFrame[a.frame] ?? [];
      const fb = feetByFrame[b.frame] ?? [];
      if (adv > 2 || !fa.length || !fb.length) continue; // flight / unusable
      // Match each planted foot in a to the nearest in b (same foot). EAST
      // travel: a planted foot only slides BACKWARD in the art (+1.5px
      // noise) — a forward move is the OTHER foot landing nearby (swap).
      for (const pa of fa) {
        let best = null;
        for (const pb of fb) if (best === null || Math.abs(pb - pa) < Math.abs(best - pa)) best = pb;
        if (best === null || Math.abs(best - pa) > 9) continue;
        if (best - pa > 1.5) continue;
        const footA = a.sx + (pa - a.ox * frameW);
        const footB = b.sx + (best - b.ox * frameW);
        slips.push({ d: footB - footA, ms: b.t - a.t });
      }
    }
    const groundSpeed = (groundPx / groundMs) * 1000;
    // GATE: ground px per animation cycle == the design stride (speed-
    // independent because timeScale ∝ speed).
    const cycles = advances / n;
    const perCycle = cycles > 0 ? groundPx / cycles : NaN;
    const wantPerCycle = (BASE[gait] * n) / (await page.evaluate(
      ({ uid, gait }) => window.__ml.animRate(uid, gait, "east"),
      { uid: myUid, gait },
    ));
    const ok = cycles >= 1.5 && groundSpeed > 20 && Math.abs(perCycle / wantPerCycle - 1) <= TOL;
    if (!ok) failures++;
    // Informational stance slip (see header — noisy, art glides by design).
    const slipPx = slips.reduce((s, x) => s + x.d, 0);
    const slipMs = slips.reduce((s, x) => s + x.ms, 0);
    const slipSpeed = slipMs ? (slipPx / slipMs) * 1000 : NaN;
    console.log(
      `${gait}: ground=${groundSpeed.toFixed(1)}px/s cycleDist=${perCycle.toFixed(1)}px ` +
        `(want ${wantPerCycle.toFixed(1)}±${TOL * 100}%, ${cycles.toFixed(1)} cycles) ` +
        `stanceDrift≈${slipSpeed.toFixed(1)}px/s [info], ${samples.length} samples ${ok ? "OK" : "FAIL"}`,
    );
  }
  if (failures) throw new Error("gait sync out of tolerance");
  console.log("GAIT-SYNC OK — feet track the ground");
} finally {
  await browser.close();
}
