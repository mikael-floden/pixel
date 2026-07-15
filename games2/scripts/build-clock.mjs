// One-shot: cut the four time-of-day celestial-clock dials out of the
// maintainer's mock screenshots (black backdrop) into transparent PNGs the
// HUD can overlay at the top of the game view.
//
// Sources live OUTSIDE the repo (same policy as the HUD frame mocks):
//   $CLOCK_SRC_DIR/clock-{night,morning,day,evening}.png
// Output: client/public/ui/clock_<phase>.png
//
// Keying floods ONLY from the image border (near-black → transparent), so the
// dial's own dark pixels — night-sky navy, black outlines — stay opaque. The
// art itself is kept as ORIGINAL pixels (see games2/CLAUDE.md: do not
// re-synthesize / grid-snap art).
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const SRC =
  process.env.CLOCK_SRC_DIR ||
  "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
const OUT = path.resolve("client/public/ui");
const PHASES = ["night", "morning", "day", "evening"];
const T = 30; // background = max(r,g,b) <= T, reachable from the border

// The pointer hand mock (clock-hand.png) points UP-left with the pivot hub
// bottom-right; the dial hangs DOWN, so the hand is flipped vertically
// (pixel-exact) before cropping. The printed hub-centre / tip coords feed
// the mount constants in client/src/clock.ts.
for (const phase of [...PHASES, "hand"]) {
  const img = PNG.sync.read(fs.readFileSync(path.join(SRC, `clock-${phase}.png`)));
  const { width: w, height: h, data } = img;
  const dark = (i) => Math.max(data[i], data[i + 1], data[i + 2]) <= T;

  // Flood the outside backdrop from every border pixel.
  const bg = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, x + (h - 1) * w);
  for (let y = 0; y < h; y++) stack.push(y * w, w - 1 + y * w);
  while (stack.length) {
    const p = stack.pop();
    if (bg[p] || !dark(p * 4)) continue;
    bg[p] = 1;
    const x = p % w;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (p >= w) stack.push(p - w);
    if (p < w * (h - 1)) stack.push(p + w);
  }

  // Keep only the largest connected art blob — the mocks carry a small
  // sparkle watermark off in the corner that isn't pure black.
  const blob = new Int32Array(w * h).fill(-1);
  const sizes = [];
  for (let s = 0; s < w * h; s++) {
    if (bg[s] || blob[s] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    const st = [s];
    while (st.length) {
      const p = st.pop();
      if (p < 0 || p >= w * h || bg[p] || blob[p] >= 0) continue;
      blob[p] = id;
      size++;
      const x = p % w;
      if (x > 0) st.push(p - 1);
      if (x < w - 1) st.push(p + 1);
      st.push(p - w, p + w);
    }
    sizes.push(size);
  }
  const keep = sizes.indexOf(Math.max(...sizes));

  // Zero backdrop alpha + soften the 1px seam where art met black (the mocks
  // have slightly soft edges): art pixels touching backdrop get alpha from
  // their own brightness so the rim doesn't ring.
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let p = 0; p < w * h; p++) {
    if (bg[p] || blob[p] !== keep) {
      data[p * 4 + 3] = 0;
      continue;
    }
    const x = p % w, y = (p / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const nearBg =
      (x > 0 && bg[p - 1]) || (x < w - 1 && bg[p + 1]) || (p >= w && bg[p - w]) || (p < w * (h - 1) && bg[p + w]);
    if (nearBg) {
      const m = Math.max(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
      data[p * 4 + 3] = Math.min(255, Math.round((m / 160) * 255));
    }
  }
  if (maxX < 0) throw new Error(`${phase}: nothing survived keying`);

  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = new PNG({ width: cw, height: ch });
  PNG.bitblt(img, out, minX, minY, cw, ch, 0, 0);
  if (phase === "hand") {
    // Flip vertically, pixel-exact (no resampling).
    for (let y = 0; y < ch >> 1; y++)
      for (let x = 0; x < cw * 4; x++) {
        const a = y * cw * 4 + x, b = (ch - 1 - y) * cw * 4 + x;
        const t = out.data[a];
        out.data[a] = out.data[b];
        out.data[b] = t;
      }
    // Geometry for clock.ts: hub centre = centroid of the wide rows (the
    // hub circle is far wider than the shaft), tip = pixel farthest from it.
    const runs = [];
    for (let y = 0; y < ch; y++) {
      let lo = -1, hi = -1;
      for (let x = 0; x < cw; x++)
        if (out.data[(y * cw + x) * 4 + 3] > 128) {
          if (lo < 0) lo = x;
          hi = x;
        }
      if (lo >= 0) runs.push({ y, lo, hi, wdt: hi - lo + 1 });
    }
    const wide = runs.filter((r) => r.wdt > Math.max(...runs.map((q) => q.wdt)) * 0.6);
    const hub = {
      x: wide.reduce((s, r) => s + (r.lo + r.hi) / 2, 0) / wide.length,
      y: wide.reduce((s, r) => s + r.y, 0) / wide.length,
    };
    let tip = { x: 0, y: 0, d: -1 };
    for (const r of runs)
      for (const x of [r.lo, r.hi]) {
        const d = (x - hub.x) ** 2 + (r.y - hub.y) ** 2;
        if (d > tip.d) tip = { x, y: r.y, d };
      }
    const ang = (Math.atan2(tip.x - hub.x, tip.y - hub.y) * -180) / Math.PI;
    console.log(
      `  hand hub (${hub.x.toFixed(1)}, ${hub.y.toFixed(1)})  tip (${tip.x}, ${tip.y})  ` +
        `angle-from-straight-down ${ang.toFixed(1)}deg  len ${Math.sqrt(tip.d).toFixed(0)}px`
    );
  }
  fs.writeFileSync(path.join(OUT, `clock_${phase}.png`), PNG.sync.write(out));
  console.log(`clock_${phase}.png  ${cw}x${ch}  (crop ${minX},${minY})`);
}
