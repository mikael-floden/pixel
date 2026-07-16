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

// The clock must share the HUD frame's pixel GRAIN (maintainer: "same per
// pixel size resolution as the frame/border/buttons — zoom in A LOT"). The
// frame's art pixels render at ~4 CSS px, so the dial is reduced all the
// way to a coarse art grid (box-downscale — no grid guessing, the mocks
// have no clean pixel grid — with the alpha edge hard-thresholded into
// pixel stairs) and the client blows each asset px up to 4 CSS px
// (pixelated, integer scale). Same on-screen size as before, 4x chunkier
// pixels; fine detail (ticks, numerals) deliberately melts away.
const DIAL_DIV = 16; // dial mock px per art px (display: x4 CSS px)
const FINE_DIV = 8; // the fine hand (only shown while sweeping) keeps 2x detail

// A hand ROTATED at runtime can't stay on the chunky grid (it dissolves
// into a dotted line of diamonds), so the resting hand is baked per phase:
// rotate the FULL-RES art to the phase angle first, then reduce onto the
// dial's own 16px grid — a dial-aligned overlay sprite. The fine hand only
// shows during the 2.5s sweep, where motion masks its finer grain.
// KEEP IN SYNC with HAND_DEG in client/src/clock.ts (degrees from straight
// down, positive = screen-left; the on-screen shadow directions).
const HAND_DEG = { night: 90, morning: -90, day: 50.7, evening: 90 };
const HAND_PAD = 16; // one art row of headroom above the dial's flat top

function boxDown(img, f, thresh = 128) {
  const w = Math.floor(img.width / f), h = Math.floor(img.height / f);
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < f; dy++)
        for (let dx = 0; dx < f; dx++) {
          const i = ((y * f + dy) * img.width + x * f + dx) * 4;
          const al = img.data[i + 3];
          r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al;
          a += al;
        }
      const o = (y * w + x) * 4;
      out.data[o] = a ? Math.round(r / a) : 0;
      out.data[o + 1] = a ? Math.round(g / a) : 0;
      out.data[o + 2] = a ? Math.round(b / a) : 0;
      // Hard pixel edge: a cell is either art or empty, no feather.
      out.data[o + 3] = a / (f * f) >= thresh ? 255 : 0;
    }
  return out;
}

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
  const full = new PNG({ width: cw, height: ch });
  PNG.bitblt(img, full, minX, minY, cw, ch, 0, 0);
  if (phase === "hand") {
    // Flip vertically, pixel-exact (no resampling).
    for (let y = 0; y < ch >> 1; y++)
      for (let x = 0; x < cw * 4; x++) {
        const a = y * cw * 4 + x, b = (ch - 1 - y) * cw * 4 + x;
        const t = full.data[a];
        full.data[a] = full.data[b];
        full.data[b] = t;
      }
  }
  if (phase !== "hand") {
    const out = boxDown(full, DIAL_DIV);
    fs.writeFileSync(path.join(OUT, `clock_${phase}.png`), PNG.sync.write(out));
    console.log(`clock_${phase}.png  ${out.width}x${out.height}  (crop ${minX},${minY} of ${cw}x${ch})`);
    continue;
  }

  // ---- hand ----
  // The mock hand is gold like the dial rims — invisible on top of them.
  // Darken it to a deep brown (maintainer: "dark brown or black so we all
  // see it easily"); scaling RGB keeps the metallic shading, and gold
  // scaled down IS dark brown.
  for (let p = 0; p < cw * ch; p++) {
    if (!full.data[p * 4 + 3]) continue;
    for (let c = 0; c < 3; c++) full.data[p * 4 + c] = Math.round(full.data[p * 4 + c] * 0.24);
  }
  // Hub/tip geometry (hub centre = centroid of the wide rows — the hub
  // circle is far wider than the shaft; tip = pixel farthest from it).
  const measure = (im) => {
    const runs = [];
    for (let y = 0; y < im.height; y++) {
      let lo = -1, hi = -1;
      for (let x = 0; x < im.width; x++)
        if (im.data[(y * im.width + x) * 4 + 3] > 128) {
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
    const deg = (Math.atan2(tip.x - hub.x, tip.y - hub.y) * -180) / Math.PI;
    return { hub, tip, deg };
  };

  // Fine hand for the sweep animation.
  const fine = boxDown(full, FINE_DIV);
  const gf = measure(fine);
  fs.writeFileSync(path.join(OUT, "clock_hand.png"), PNG.sync.write(fine));
  console.log(
    `clock_hand.png  ${fine.width}x${fine.height}  hub (${gf.hub.x.toFixed(1)}, ${gf.hub.y.toFixed(1)})` +
      `  angle-from-down ${gf.deg.toFixed(1)}deg  len ${Math.sqrt(gf.tip.d).toFixed(0)}px`
  );

  // Resting sprites: rotate full-res around the hub onto a dial-mock-scale
  // canvas (hand mock is 2x the dial mock's scale), then reduce onto the
  // SAME 16px grid as the dial — a perfectly grid-aligned overlay.
  const gF = measure(full);
  for (const [ph, A] of Object.entries(HAND_DEG)) {
    const R = ((A - gF.deg) * Math.PI) / 180;
    const cos = Math.cos(-R), sin = Math.sin(-R);
    const canvas = new PNG({ width: 716, height: 419 + HAND_PAD });
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++) {
        const vx = x - 358, vy = y - (22 + HAND_PAD);
        const sx = gF.hub.x + (vx * cos - vy * sin) * 2;
        const sy = gF.hub.y + (vx * sin + vy * cos) * 2;
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        if (x0 < 0 || y0 < 0 || x0 >= cw - 1 || y0 >= ch - 1) continue;
        const fx = sx - x0, fy = sy - y0;
        let r = 0, g = 0, b = 0, a = 0;
        for (const [ox, oy, wgt] of [
          [0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)],
          [0, 1, (1 - fx) * fy], [1, 1, fx * fy],
        ]) {
          const i = ((y0 + oy) * cw + x0 + ox) * 4;
          const al = full.data[i + 3] * wgt;
          r += full.data[i] * al; g += full.data[i + 1] * al; b += full.data[i + 2] * al;
          a += al;
        }
        const o = (y * canvas.width + x) * 4;
        canvas.data[o] = a ? Math.round(r / a) : 0;
        canvas.data[o + 1] = a ? Math.round(g / a) : 0;
        canvas.data[o + 2] = a ? Math.round(b / a) : 0;
        canvas.data[o + 3] = Math.round(a);
      }
    // The shaft is ~0.4 art px thick — a 50% coverage cut erases it, so
    // rest sprites keep any cell the hand meaningfully touches (~15%).
    const spr = boxDown(canvas, DIAL_DIV, 28);
    fs.writeFileSync(path.join(OUT, `clock_hand_${ph}.png`), PNG.sync.write(spr));
    console.log(`clock_hand_${ph}.png  ${spr.width}x${spr.height}  (A ${A}deg)`);
  }
}
