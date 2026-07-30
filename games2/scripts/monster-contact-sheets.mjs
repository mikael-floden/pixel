// CONTACT SHEETS: for each monster, render EVERY (direction, frame) tile with
// the EXACT shadow the client would draw — per-dir ellipse (w/h), lift capped
// by the contact band, per-frame origin shift, per-frame air shrink — plus a
// red crosshair at the anchor. One PNG per monster: rows = directions,
// columns = frames. This is the maintainer's-eye view, offline, exhaustive.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const { PNG } = createRequire(import.meta.url)("pngjs");

const MON = new URL("../../monsters", import.meta.url).pathname;
const OUT = process.argv[3] || "/tmp";
const manifest = JSON.parse(
  readFileSync(new URL("../client/public/monsters.json", import.meta.url).pathname, "utf8"),
);
const DIRS = manifest.directions;
const IDS = process.argv[2] ? process.argv[2].split(",") : manifest.monsters.map((m) => m.id);

for (const id of IDS) {
  const d = manifest.monsters.find((m) => m.id === id);
  if (!d?.ground) continue;
  const anim = d.walkAnim;
  // Gather per-dir strips + dims.
  const dirs = DIRS.filter((k) => d.ground[k] && d.strips[anim]?.[k]);
  const maxFrames = Math.max(...dirs.map((k) => d.animations[anim][k]));
  const fws = {};
  const fhs = {};
  const pngs = {};
  for (const k of dirs) {
    const rel = d.strips[anim][k].replace("/assets/monsters/", "");
    pngs[k] = PNG.sync.read(readFileSync(join(MON, rel)));
    fws[k] = d.stripDims[anim][k].w;
    fhs[k] = d.stripDims[anim][k].h;
  }
  const tileW = Math.max(...dirs.map((k) => fws[k])) + 8;
  const tileH = Math.max(...dirs.map((k) => fhs[k])) + 12;
  const W = tileW * maxFrames;
  const H = tileH * dirs.length;
  const sheet = new PNG({ width: W, height: H });
  // bg light grey
  for (let i = 0; i < W * H; i++) {
    sheet.data[i * 4] = 168;
    sheet.data[i * 4 + 1] = 178;
    sheet.data[i * 4 + 2] = 168;
    sheet.data[i * 4 + 3] = 255;
  }
  const px = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    const na = a / 255;
    sheet.data[i] = Math.round(r * na + sheet.data[i] * (1 - na));
    sheet.data[i + 1] = Math.round(g * na + sheet.data[i + 1] * (1 - na));
    sheet.data[i + 2] = Math.round(b * na + sheet.data[i + 2] * (1 - na));
  };
  dirs.forEach((k, row) => {
    const g = d.ground[k];
    const fw = fws[k];
    const fh = fhs[k];
    const src = pngs[k];
    const n = d.animations[anim][k];
    const lift = Math.max(0, Math.min(g.h / 2 - (g.sink ?? 2) - 2, (g.up ?? 99) + 3));
    for (let f = 0; f < n; f++) {
      const ox = tileW * f + 4;
      const oy = tileH * row + 6;
      // Anchor point inside the tile: centre-x, and y so the tallest art fits.
      const ax = Math.round(ox + tileW / 2 - 4);
      const ay = Math.round(oy + fh * (g.f > 0.98 ? 0.98 : g.f));
      const shiftX = (g.shift?.[f] ?? g.cx) * fw;
      const shiftY = g.f * fh;
      const air = g.air?.[f] ?? 0;
      // 1) shadow ellipse UNDER the art (same shrink/alpha maths as the game)
      const airFrac = Math.min(1, air / 26);
      const ew = (g.w - airFrac * g.w * 0.26) / 2;
      const eh = (g.h - airFrac * g.h * 0.29) / 2;
      const alpha = Math.round(115 * (1 - airFrac * 0.35));
      const ecy = ay - lift;
      for (let y = Math.round(ecy - eh); y <= ecy + eh; y++)
        for (let x = Math.round(ax - ew); x <= ax + ew; x++) {
          const q = ((x - ax) / ew) ** 2 + ((y - ecy) / eh) ** 2;
          if (q <= 1) px(x, y, 20, 20, 30, alpha);
        }
      // 2) art frame, positioned so (shiftX, shiftY) lands on the anchor
      const dx0 = Math.round(ax - shiftX);
      const dy0 = Math.round(ay - shiftY);
      for (let y = 0; y < fh; y++)
        for (let x = 0; x < fw; x++) {
          const si = ((y * src.width) + f * fw + x) * 4;
          const a = src.data[si + 3];
          if (a > 8) px(dx0 + x, dy0 + y, src.data[si], src.data[si + 1], src.data[si + 2], a);
        }
      // 3) red crosshair at the anchor
      for (let t = -3; t <= 3; t++) {
        px(ax + t, ay, 255, 40, 40, 230);
        px(ax, ay + t, 255, 40, 40, 230);
      }
    }
  });
  writeFileSync(join(OUT, `sheet-${id}.png`), PNG.sync.write(sheet));
  console.log(`sheet-${id}.png (${W}x${H})`);
}
