// A COMPOSED RAMP MEETS ITS NEIGHBOURS WITHOUT A SEAM (client/src/tiles3draw.ts
// buildRampPixels; maintainer 2026-09-25: "I can see a 1 px edge becouse the
// slope should be 1px wider/taller"). A row of ramps is painted in the ground
// pass's order between the terrace above and the ground below, each of the four
// ways up; the terrace's wall is red and the ramps' own side faces blue, so a
// pixel of either showing between two ramps is a seam. Before the fix: 20 to
// 142 side-face pixels per row, and 22 of the wall at full height.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hexRGB } from "../../client/src/tiles3.js";
import { buildPlatePixels, buildRampPixels, patternSheetPaths, patternSheets, type Pixels } from "../../client/src/tiles3draw.js";
// @ts-expect-error plain mjs
import { imgRGBA } from "../../scripts/imagelib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const MEMBER = "tiles/base_candidates/grass/grass__to__grey_stone__a30_s1.webp";
const NEEDS = ["tiles/patterns/index.json", "tiles/ground_types.json", MEMBER];
const skip = NEEDS.some((p) => !existsSync(join(REPO, p))) ? "art not checked out" : false;

const px = (rel: string): Pixels => {
  const i = imgRGBA(join(REPO, rel)) as { width: number; height: number; data: ArrayLike<number> };
  return { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) };
};

test("a row of ramps between the terrace above and the ground below: no wall and no side face shows between two ramps, all four ways up, at every height", { skip }, () => {
  const PAT = JSON.parse(readFileSync(join(REPO, "tiles/patterns/index.json"), "utf8"));
  const p = patternSheetPaths(PAT);
  const S = patternSheets(PAT, px(p.silhouette), px(p.masks), px(p.border));
  const GT = JSON.parse(readFileSync(join(REPO, "tiles/ground_types.json"), "utf8")).grounds;
  const src = px(MEMBER);
  const plate = buildPlatePixels(S, { kind: "conform", path: MEMBER } as never, src, hexRGB(GT.grass.palette.wall));
  const { fw, libTop } = S;
  // The terrace's plate with its wall red; the ramps' side faces and band blue.
  const redWall: Pixels = { w: plate.w, h: plate.h, data: new Uint8ClampedArray(plate.data) };
  for (let i = 0; i < redWall.w * redWall.h; i++) {
    const y = Math.floor(i / redWall.w);
    if (redWall.data[i * 4 + 3] && !(y < 29 && libTop[i])) redWall.data.set([255, 0, 0, 255], i * 4);
  }
  const blue: Pixels = { w: src.w, h: src.h, data: new Uint8ClampedArray(src.data.length) };
  for (let i = 0; i < blue.w * blue.h; i++) if (src.data[i * 4 + 3]) blue.data.set([0, 0, 255, 255], i * 4);
  // mask -> where the terrace above lies: a strip of six ramps between it and the ground (k 0..5 along, j across).
  const WAYS: { mask: number; name: string; cell: (k: number, j: number) => [number, number]; upJ: number }[] = [
    { mask: 12, name: "north", cell: (k, j) => [k, j], upJ: 0 },
    { mask: 3, name: "south", cell: (k, j) => [k, j], upJ: 2 },
    { mask: 5, name: "east", cell: (k, j) => [j, k], upJ: 2 },
    { mask: 10, name: "west", cell: (k, j) => [j, k], upJ: 0 },
  ];
  const bad: string[] = [];
  for (const way of WAYS)
    for (const rise of [4, 8, 11, 15]) {
      const ramp = buildRampPixels(S, plate, way.mask, rise, blue, true);
      const W = 64 * 10, H = 360;
      const out = new Uint8ClampedArray(W * H * 4);
      const blit = (q: Pixels, X: number, Y: number) => {
        for (let y = 0; y < q.h; y++)
          for (let x = 0; x < q.w; x++) {
            const s = (y * q.w + x) * 4;
            if (!q.data[s + 3]) continue;
            const X2 = X + x, Y2 = Y + y;
            if (X2 < 0 || Y2 < 0 || X2 >= W || Y2 >= H) continue;
            out.set(q.data.subarray(s, s + 4), (Y2 * W + X2) * 4);
          }
      };
      // The ground pass's order: by c + r (cells of one depth never overlap). A cell (c, r) sits at
      // x = (c - r) * 32, y = (c + r) * 14 less its level's lift; a ramp's frame hangs `rise` rows up.
      const X0 = 300, Y0 = 60;
      const cells: { c: number; r: number; kind: "up" | "ramp" | "flat"; k: number }[] = [];
      for (let k = 0; k < 6; k++)
        for (let j = 0; j < 3; j++) {
          const [c, r] = way.cell(k, j);
          cells.push({ c, r, k, kind: j === 1 ? "ramp" : j === way.upJ ? "up" : "flat" });
        }
      cells.sort((a, b) => a.c + a.r - (b.c + b.r));
      for (const q of cells) {
        const X = X0 + (q.c - q.r) * 32, Y = Y0 + (q.c + q.r) * 14;
        if (q.kind === "up") blit(redWall, X, Y - rise);
        else if (q.kind === "ramp") blit(ramp, X, Y - rise);
        else blit(plate, X, Y);
      }
      // Inside the two middle ramps, column by column: from the lifted diamond's top to the flat diamond's bottom.
      let red = 0, blu = 0;
      for (const q of cells) {
        if (q.kind !== "ramp" || q.k < 2 || q.k > 3) continue;
        const X = X0 + (q.c - q.r) * 32, Y = Y0 + (q.c + q.r) * 14;
        for (let x = 0; x < fw; x++) {
          let t = -1, b = -1;
          for (let y = 0; y < 29; y++) if (libTop[y * fw + x]) { if (t < 0) t = y; b = y; }
          if (t < 0) continue;
          for (let y = t - rise; y <= b; y++) {
            const o = ((Y + y) * W + X + x) * 4;
            if (out[o] === 255 && out[o + 1] === 0 && out[o + 2] === 0) red++;
            if (out[o] === 0 && out[o + 1] === 0 && out[o + 2] === 255) blu++;
          }
        }
      }
      if (red || blu) bad.push(`${way.name} at rise ${rise}: ${red} wall and ${blu} side-face pixels`);
    }
  assert.deepEqual(bad, [], "a seam between two ramps");
});
