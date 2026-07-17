// Build the character-select RING frame from an independent COPY of the
// in-game frame art (maintainer 2026-07-17: the select screen gets the same
// in-game border — but ONLY the border, corners + connecting frame; and a
// COPY, not a reference, so pixel edits to one never change the other).
//
// Sources (committed, in-repo):  client/public/ui2/frame.png (768×1376)
//                                client/public/ui2/frame-top-runefree.png
// Outputs (committed):           client/public/ui2/select-frame.png
//                                client/public/ui2/select-frame-top.png
//
// Surgery (all coordinates measured off frame.png's alpha):
//  - DISC ERASE: the baked zodiac clock disc + its rim vines + the clock
//    strap stub hang under the top beam at x[205,565) from y=62 down —
//    everything there goes (the select ring has no clock). The beam's solid
//    band ends at y≈63, so the cut edge hugs it.
//  - INTERIOR ERASE: x[48,720) y[300,1308) — rails A/B, the tab/page
//    windows' art, junction crystals' inward tips, bottom-fringe tendrils
//    (they'd smear into horizontal streaks through the width-stretch fills).
//  - JUNCTION REPLACE: the divider T-junctions decorate the side rails
//    (knots + crystal clusters) at y[550,930). Both side bands x[0,48) /
//    [720,768) are re-tiled there with the clean winding-bark unit rows
//    [992,1078) (the same unit the height stretch extrudes), so the rails
//    read as continuous plain bark between the corners.
//  - SOFT EDGES: every fresh cut boundary gets a 2px alpha feather (the
//    golden rule: never a hard 100%→0% step on a cut edge).
//
// The aux (rune-free top band) is copied verbatim: the width-stretch cut
// columns (x=196 and the kinked ≥576 right cut) both live outside the disc
// span, so it needs no surgery — it exists as a copy purely for independence.
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const UI2 = path.join(ROOT, "client", "public", "ui2");

const DISC = { x0: 205, x1: 565, y0: 62 }; // disc/strap region under the beam
const INT = { x0: 48, x1: 720, y0: 300, y1: 1308 }; // main interior
// Junction span starts at 505: the left vine-knot and the right crystal
// cluster (divider-junction dressing) begin there, just under the rails'
// rune glyphs — the first cut at 550 left their upper halves dangling.
const JUNC = { y0: 505, y1: 930 }; // divider junction span on the side rails
const BARK = { y0: 992, p: 86, phase: 1035 }; // clean side-rail tiling unit
const SIDE_W = 48; // side band width (rails end at x≈43/726)

const src = PNG.sync.read(fs.readFileSync(path.join(UI2, "frame.png")));
const { width: W, height: H, data: D } = src;
const idx = (x, y) => (y * W + x) * 4;

// --- 1. junction replace (before erases, so bark rows are pristine) ---
for (let y = JUNC.y0; y < JUNC.y1; y++) {
  const sy = BARK.y0 + ((((y - BARK.phase) % BARK.p) + BARK.p) % BARK.p);
  for (const [x0, x1] of [[0, SIDE_W], [W - SIDE_W, W]]) {
    for (let x = x0; x < x1; x++) {
      const s = idx(x, sy), d = idx(x, y);
      D[d] = D[s]; D[d + 1] = D[s + 1]; D[d + 2] = D[s + 2]; D[d + 3] = D[s + 3];
    }
  }
}

// --- 2. erases ---
const erased = new Uint8Array(W * H); // remember for the feather pass
const erase = (x, y) => {
  const d = idx(x, y);
  if (D[d + 3] !== 0) erased[y * W + x] = 1;
  D[d] = D[d + 1] = D[d + 2] = D[d + 3] = 0;
};
for (let y = DISC.y0; y < INT.y0; y++)
  for (let x = DISC.x0; x < DISC.x1; x++) erase(x, y);
for (let y = INT.y0; y < INT.y1; y++)
  for (let x = INT.x0; x < INT.x1; x++) erase(x, y);

// --- 2b. flood-erase the baked OUTSIDE backdrop from the image edges ---
// The extraction kept an opaque dark-teal mock backdrop outside parts of
// the border silhouette (and the bark tiling unit has none), so the ring's
// outside was inconsistent. The backdrop is uniformly dark teal (sampled:
// g >= r+8, all channels < 80); flood 4-connected from every edge pixel so
// only backdrop CONNECTED to the outside goes — dark art pixels inland are
// unreachable and vine/bark colours fail the condition.
{
  const isBackdrop = (x, y) => {
    const d = idx(x, y);
    if (D[d + 3] === 0) return false;
    const r = D[d], g = D[d + 1], b = D[d + 2];
    return g >= r + 8 && r < 80 && g < 80 && b < 80;
  };
  const stack = [];
  for (let x = 0; x < W; x++) { stack.push([x, 0], [x, H - 1]); }
  for (let y = 0; y < H; y++) { stack.push([0, y], [W - 1, y]); }
  const seen = new Uint8Array(W * H);
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= W || y < 0 || y >= H || seen[y * W + x]) continue;
    seen[y * W + x] = 1;
    if (!isBackdrop(x, y)) continue;
    erase(x, y);
    stack.push([x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]);
  }
}

// --- 3. soft feather: surviving pixels bordering an erased one fade ---
const near = (x, y, r) => {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < W && ny >= 0 && ny < H && erased[ny * W + nx]) return true;
  }
  return false;
};
const fade = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const d = idx(x, y);
  if (D[d + 3] === 0) continue;
  if (near(x, y, 1)) fade.push([d, 0.45]);
  else if (near(x, y, 2)) fade.push([d, 0.78]);
}
for (const [d, f] of fade) D[d + 3] = Math.round(D[d + 3] * f);

fs.writeFileSync(path.join(UI2, "select-frame.png"), PNG.sync.write(src));
fs.copyFileSync(
  path.join(UI2, "frame-top-runefree.png"),
  path.join(UI2, "select-frame-top.png"),
);
console.log("select-frame.png + select-frame-top.png written");
