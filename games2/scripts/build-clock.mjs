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

// AAA pass (maintainer round 9): the coarse-grid experiment turned the
// dial into a mud blob — full detail wins. Assets bake at EXACTLY the
// display resolution (box-downscale, alpha hard-thresholded into pixel
// stairs; the mocks have no clean pixel grid — do not grid-guess) on the
// small approved footprint, rendered 1 asset px = 1 CSS px + pixelated so
// the browser never resamples. Every mock detail (moon, stars, rings,
// zodiac) survives at the small size.
const DIAL_DIV = 2; // dial mock px per displayed px (sheet-2 mocks are ~0.29x the old scale)
const FINE_DIV = 14; // hand sized to ~90% of the new (smaller) dial radius

// Border ring width in asset px: the maintainer-approved "1px border" was
// 1 art px at the old 4-CSS chunk — keep that same on-screen weight.
const RING = 4;

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
      // Hard pixel edge (a cell is either art or empty) — or, with
      // thresh 0, keep the averaged SOFT alpha: the hand rotates at
      // runtime and a thresholded ~1px shaft shreds into a ragged line,
      // while soft alpha anti-aliases cleanly through every angle.
      out.data[o + 3] = thresh === 0 ? Math.round(a / (f * f)) : a / (f * f) >= thresh ? 255 : 0;
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
    // Border ring, like every other HUD tile (the frame recipe — near-black
    // at 90% alpha painted on the empty px bordering the art — reduces to
    // black here because the keyed-out backdrop was black). RING px wide so
    // it keeps the frame's border weight at this finer resolution.
    const ow = out.width, oh = out.height;
    for (let pass = 0; pass < RING; pass++) {
      const grow = [];
      for (let y = 0; y < oh; y++)
        for (let x = 0; x < ow; x++) {
          const o = (y * ow + x) * 4;
          if (out.data[o + 3]) continue;
          let touches = false;
          for (let dy = -1; dy <= 1 && !touches; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= ow || ny >= oh) continue;
              if (out.data[(ny * ow + nx) * 4 + 3] > 0) {
                touches = true;
                break;
              }
            }
          if (touches) grow.push(o);
        }
      for (const o of grow) {
        out.data[o] = 8; out.data[o + 1] = 6; out.data[o + 2] = 5;
        out.data[o + 3] = 230;
      }
    }
    // The four sheet mocks crop to slightly different sizes — pad onto ONE
    // shared canvas (centred-x, top-aligned) so the stacked <img>s render
    // 1:1 with zero browser resampling during cross-fades.
    const CANW = 102, CANH = 66;
    const pad = new PNG({ width: CANW, height: CANH });
    // BOTTOM-aligned: the dial rims are consistent across the four mocks
    // while the gem stub above varies — bottom alignment keeps cross-fades
    // registered.
    PNG.bitblt(out, pad, 0, 0, Math.min(out.width, CANW), Math.min(out.height, CANH),
      Math.max(0, Math.round((CANW - out.width) / 2)), Math.max(0, CANH - out.height));
    fs.writeFileSync(path.join(OUT, `clock_${phase}.png`), PNG.sync.write(pad));
    console.log(`clock_${phase}.png  ${out.width}x${out.height} -> ${CANW}x${CANH}  (crop ${minX},${minY})`);
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
  const fine = boxDown(full, FINE_DIV, 0);
  const gf = measure(fine);
  fs.writeFileSync(path.join(OUT, "clock_hand.png"), PNG.sync.write(fine));
  console.log(
    `clock_hand.png  ${fine.width}x${fine.height}  hub (${gf.hub.x.toFixed(1)}, ${gf.hub.y.toFixed(1)})` +
      `  angle-from-down ${gf.deg.toFixed(1)}deg  len ${Math.sqrt(gf.tip.d).toFixed(0)}px`
  );

}
