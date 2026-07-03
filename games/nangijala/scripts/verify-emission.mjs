// Tile self-emission check (pattern 5 = raw light field, opaque):
//  1. at NIGHT, an emissive cell's field sits on its self-glow floor
//     (colour*self from tiles/emission.json) — far above the night ambient —
//     with the right colour dominance (lava red, crystal blue/violet);
//  2. a plain meadow far from all emissives stays at the night ambient
//     (emission must not leak into the rest of the scene);
//  3. animated entries (flicker/pulse) actually move between samples.
// Sites are far outside walking range on dt-clamped headless clients, so the
// probe drives the camera directly via __ml.lookAt(col,row).
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const NIGHT = [0.075, 0.09, 0.14];
// col,row → the dominant channel, its floor (colour*self*minAnim, minus
// slack for the multiply pipeline), and the channel it must dominate.
const SITES = [
  { name: "lava", col: 453, row: 386, ch: 0, floor: 0.4, weak: 2 },
  { name: "crystal_ground", col: 316, row: 106, ch: 2, floor: 0.3, weak: 0 },
  { name: "mushroom_grove", col: 330, row: 249, ch: 0, floor: 0.22, weak: 2 },
];
const CONTROL = { col: 150, row: 150 }; // meadow, ≥150 cells from any emissive

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 2400, height: 1300 } });
await page.goto(process.env.PROBE_URL || "http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "emitprobe");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  window.__ml.timeOfDay("Night");
  window.__ml.probeLight(); // no extra light
  window.__ml.nightCal(0, 1, 5); // raw field, opaque
});

// Field sample at the screen centre (lookAt centres the target cell there).
async function sampleCenter() {
  const shot = PNG.sync.read(await page.screenshot());
  const i = ((Math.floor(shot.height / 2) * shot.width) + Math.floor(shot.width / 2)) * 4;
  return [shot.data[i] / 255, shot.data[i + 1] / 255, shot.data[i + 2] / 255];
}

let fail = 0;
for (const s of SITES) {
  const at = await page.evaluate(({ col, row }) => window.__ml.lookAt(col, row), s);
  await page.waitForTimeout(700); // ground RT + occluders rebuild
  const rgb = await sampleCenter();
  const strong = rgb[s.ch];
  const ok = at && strong >= s.floor && strong > rgb[s.weak] + 0.08;
  console.log(
    `${s.name.padEnd(16)} (${s.col},${s.row}) t=${at?.t} field [${rgb.map((v) => v.toFixed(2)).join(",")}] ` +
      `ch${s.ch} ${strong.toFixed(2)} >= ${s.floor} and > ch${s.weak}+0.08: ${ok ? "OK" : "FAIL"}`,
  );
  if (!ok) fail++;
}

// Control: emission must not lift the night anywhere else.
await page.evaluate(({ col, row }) => window.__ml.lookAt(col, row), CONTROL);
await page.waitForTimeout(700);
const ctl = await sampleCenter();
const ctlErr = Math.max(...ctl.map((v, k) => Math.abs(v - NIGHT[k])));
console.log(
  `control meadow    (${CONTROL.col},${CONTROL.row}) field [${ctl.map((v) => v.toFixed(2)).join(",")}] vs night ambient err ${ctlErr.toFixed(3)} ${ctlErr <= 0.05 ? "OK" : "FAIL"}`,
);
if (ctlErr > 0.05) fail++;

// Animation: the lava floor flickers — consecutive samples must differ.
// Sample the GREEN channel: red saturates at 1.0 (floor + glow pool clamp),
// which would hide the swing entirely.
await page.evaluate(({ col, row }) => window.__ml.lookAt(col, row), SITES[0]);
await page.waitForTimeout(700);
const seq = [];
for (let k = 0; k < 6; k++) {
  seq.push((await sampleCenter())[1]);
  await page.waitForTimeout(700); // spread over ~2 flicker periods (freq 3.1)
}
const swing = Math.max(...seq) - Math.min(...seq);
console.log(
  `lava flicker samples [${seq.map((v) => v.toFixed(3)).join(", ")}] swing ${swing.toFixed(3)} ${swing > 0.005 ? "OK" : "FAIL"}`,
);
if (swing <= 0.005) fail++;

await browser.close();
process.exit(fail === 0 ? 0 : 1);
