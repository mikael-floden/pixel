/* LENS 3 harness: render3 interleaved order vs the game's cells-then-boundaries,
 * measured on the maintainer's real patch. Deleted when done. */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { Tiles3, viewFromDoc, hexRGB, TILE, PLATE_H, TOP_Y, DX, DY, WALL, columnX, columnY } from "./client/src/tiles3";
import {
  patternSheets, patternSheetPaths, composeBoundary, conformPlate, topFaceOnly,
  cellOps, boundaryOp, plateKey, boundaryKeyFor, artKey, liquidDiamond, liquidKey,
  type Pixels, type PatternSheets,
} from "./client/src/tiles3draw";
// @ts-expect-error
import { imgRGBA } from "./scripts/imagelib.mjs";

const REPO = "/home/user/pixel";
const rel = (p: string) => join(REPO, p);
const load = (p: string): any => JSON.parse(readFileSync(rel(p), "utf8"));
const px = (path: string): Pixels => {
  const i = imgRGBA(rel(path)) as { width: number; height: number; data: Uint8Array };
  return { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) };
};
const PAT = load("tiles/patterns/index.json");
const sp = patternSheetPaths(PAT);
const SHEETS: PatternSheets = patternSheets(PAT, px(sp.silhouette), px(sp.masks), px(sp.border));
const GT = load("tiles/ground_types.json").grounds;
const wallRGB = (g: string): [number, number, number] => hexRGB(GT[g].palette.wall);

console.log(`geometry: TILE=${TILE} PLATE_H=${PLATE_H} TOP_Y=${TOP_Y} DX=${DX} DY=${DY} WALL=${WALL} fw=${SHEETS.fw} fh=${SHEETS.fh}`);
// extents of libTop / libWall
let topMinY = 1e9, topMaxY = -1, wallMinY = 1e9, wallMaxY = -1, nTop = 0, nWall = 0;
for (let y = 0; y < SHEETS.fh; y++) for (let x = 0; x < SHEETS.fw; x++) {
  const i = y * SHEETS.fw + x;
  if (SHEETS.libTop[i]) { nTop++; topMinY = Math.min(topMinY, y); topMaxY = Math.max(topMaxY, y); }
  if (SHEETS.libWall[i]) { nWall++; wallMinY = Math.min(wallMinY, y); wallMaxY = Math.max(wallMaxY, y); }
}
console.log(`libTop  ${nTop} px, rows ${topMinY}..${topMaxY}`);
console.log(`libWall ${nWall} px, rows ${wallMinY}..${wallMaxY}`);

const t = new Tiles3({
  baseTileSets: load("live/tuning/base_tile_sets.json"),
  memberResolve: load("tiles/resolve.json"),
  groundTypes: GT,
  patterns: PAT,
  review: load("tiles/review/manifest.json"),
  feedback: load("live/feedback/tiles.json").entries,
  wallOverrides: load("live/tuning/tile_walls.json").overrides,
  basePromotions: load("live/tuning/base_tiles.json").overrides,
  fades: load("tiles/fades/index.json"),
  slopes: load("tiles/slopes/index.json"),
  topWallOverrides: load("live/tuning/top_walls.json").overrides,
  topOverrides: load("live/tuning/tile_tops.json").overrides,
  storeyPitch: 15,
  warn: () => {},
} as any);
const doc = load("maps2/worlds3/the_game/world.json");
// the maintainer's patch
const X0 = 444, Y0 = 362, X1 = 477, Y1 = 395;
const win = t.resolveWindow(viewFromDoc(doc, { x0: X0, y0: Y0, x1: X1, y1: Y1 }));
console.log(`window ${X0}..${X1} x ${Y0}..${Y1}: ${win.cells.length} cells, ${win.boundaries.length} boundaries, ${win.decks.length} decks`);

// ---- build every texture the ops name -------------------------------------
const tex = new Map<string, Pixels>();
function plateFor(art: any, ground: string): Pixels {
  const k = plateKey(art, ground);
  if (tex.has(k)) return tex.get(k)!;
  let p: Pixels;
  if (art.kind === "liquid") p = liquidDiamond(art.topRGB, SHEETS);
  else {
    p = px(art.path);
    if (art.kind === "conform") p = conformPlate(SHEETS, p, wallRGB(ground));
    if (art.topOnly) p = topFaceOnly(SHEETS, p);
  }
  tex.set(k, p);
  return p;
}
for (const c of win.cells as any[]) {
  if (c.kind === "field" && c.art) {
    if (c.art.kind === "liquid") { const k = liquidKey(c.art.topRGB); if (!tex.has(k)) tex.set(k, liquidDiamond(c.art.topRGB, SHEETS)); }
    else plateFor(c.art, c.ground);
  }
  if (c.wall) for (const s of c.wall.stack) if (s.tile.path) { const k = artKey(s.tile.path); if (!tex.has(k)) tex.set(k, px(s.tile.path)); }
}
for (const d of win.decks as any[]) for (const s of d.stack) if (s.tile.path) { const k = artKey(s.tile.path); if (!tex.has(k)) tex.set(k, px(s.tile.path)); }

// boundary compositions, RAW and TOP-ONLY
const bRaw = new Map<string, Pixels>();
const bTop = new Map<string, Pixels>();
for (const b of win.boundaries as any[]) {
  const k = boundaryKeyFor(b);
  if (!k || bRaw.has(k)) continue;
  const pa0 = px(b.plateA.path), pb0 = px(b.plateB.path);
  const pa = b.plateA.kind === "conform" ? conformPlate(SHEETS, pa0, wallRGB(b.a)) : pa0;
  const pbb = b.plateB.kind === "conform" ? conformPlate(SHEETS, pb0, wallRGB(b.b)) : pb0;
  const raw = composeBoundary(SHEETS, b.maskFrame, pa, pbb, { seam: true });
  bRaw.set(k, raw);
  bTop.set(k, topFaceOnly(SHEETS, raw, { margin: false }));
}
console.log(`textures: ${tex.size} plates, ${bRaw.size} distinct boundary compositions`);

// ---- canvas ---------------------------------------------------------------
type Canvas = { w: number; h: number; d: Uint8ClampedArray };
let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
for (const c of win.cells as any[]) for (const o of cellOps(c)) boxes.push(o);
for (const b of win.boundaries as any[]) { const o = boundaryOp(b); if (o) boxes.push(o); }
for (const bx of boxes) { minX = Math.min(minX, bx.x); minY = Math.min(minY, bx.y); maxX = Math.max(maxX, bx.x + bx.sw); maxY = Math.max(maxY, bx.y + bx.sh); }
const CW = maxX - minX, CH = maxY - minY;
const newC = (): Canvas => ({ w: CW, h: CH, d: new Uint8ClampedArray(CW * CH * 4) });
console.log(`canvas ${CW}x${CH}`);

function blit(cv: Canvas, src: Pixels, dx: number, dy: number) {
  const ox = dx - minX, oy = dy - minY;
  for (let y = 0; y < src.h; y++) {
    const cy = oy + y; if (cy < 0 || cy >= cv.h) continue;
    for (let x = 0; x < src.w; x++) {
      const cx = ox + x; if (cx < 0 || cx >= cv.w) continue;
      const si = (y * src.w + x) * 4, a = src.data[si + 3];
      if (a === 0) continue;
      const di = (cy * cv.w + cx) * 4;
      if (a === 255) { cv.d[di] = src.data[si]; cv.d[di+1] = src.data[si+1]; cv.d[di+2] = src.data[si+2]; cv.d[di+3] = 255; }
      else { const al = a / 255, ia = 1 - al;
        cv.d[di] = Math.round(src.data[si]*al + cv.d[di]*ia);
        cv.d[di+1] = Math.round(src.data[si+1]*al + cv.d[di+1]*ia);
        cv.d[di+2] = Math.round(src.data[si+2]*al + cv.d[di+2]*ia);
        cv.d[di+3] = Math.round(a + cv.d[di+3]*ia); }
    }
  }
}
const getTex = (k: string): Pixels | undefined => tex.get(k) ?? bRaw.get(k);

/* ---- ORDER A: game BEFORE (cells, then boundaries RAW) ------------------- */
function renderGame(useTopOnly: boolean): Canvas {
  const cv = newC();
  for (const c of win.cells as any[]) for (const o of cellOps(c)) { const s = getTex(o.key); if (s) blit(cv, s, o.x, o.y); }
  for (const b of win.boundaries as any[]) {
    const o = boundaryOp(b); if (!o) continue;
    const s = (useTopOnly ? bTop : bRaw).get(o.key); if (s) blit(cv, s, o.x, o.y);
  }
  for (const d of win.decks as any[]) for (const s0 of d.stack) { const s = tex.get(artKey(s0.tile.path)); if (s) blit(cv, s, d.sx, s0.y); }
  return cv;
}
/* ---- ORDER C: render3 interleaved — the boundary IS the cell -------------- */
function renderRender3(): Canvas {
  const cv = newC();
  const byCell = new Map<string, any>();
  for (const b of win.boundaries as any[]) byCell.set(`${b.x},${b.y}`, b);
  let replaced = 0;
  for (const c of win.cells as any[]) {
    const b = byCell.get(`${c.x},${c.y}`);
    if (b && c.kind === "field") {
      const o = boundaryOp(b);
      if (o) { const s = bRaw.get(o.key); if (s) { blit(cv, s, o.x, o.y); replaced++; continue; } }
    }
    for (const o of cellOps(c)) { const s = getTex(o.key); if (s) blit(cv, s, o.x, o.y); }
  }
  for (const d of win.decks as any[]) for (const s0 of d.stack) { const s = tex.get(artKey(s0.tile.path)); if (s) blit(cv, s, d.sx, s0.y); }
  console.log(`render3 order: ${replaced} cells drew the boundary INSTEAD of the plate (of ${win.boundaries.length} boundaries)`);
  return cv;
}

// sanity: do boundary op position and its cell's plate position coincide?
{
  const byCell = new Map<string, any>();
  for (const c of win.cells as any[]) byCell.set(`${c.x},${c.y}`, c);
  let same = 0, diff = 0;
  for (const b of win.boundaries as any[]) {
    const c = byCell.get(`${b.x},${b.y}`); if (!c) continue;
    const cy = c.pasteY ?? c.sy;
    if (c.sx === b.sx && cy === b.sy) same++; else { diff++; if (diff < 4) console.log(`  POS DIFF cell(${b.x},${b.y}) cell=${c.sx},${cy} bnd=${b.sx},${b.sy}`); }
  }
  console.log(`boundary vs its cell paste position: ${same} identical, ${diff} different`);
}

const A = renderGame(false);   // before
const B = renderGame(true);    // after
const C = renderRender3();     // render3 reference order

function diff(p: Canvas, q: Canvas, label: string) {
  let n = 0; const rows = new Map<number, number>();
  for (let i = 0; i < p.w * p.h; i++) {
    let d = false;
    for (let ch = 0; ch < 4; ch++) if (p.d[i*4+ch] !== q.d[i*4+ch]) { d = true; break; }
    if (d) { n++; const y = Math.floor(i / p.w); rows.set(y, (rows.get(y) ?? 0) + 1); }
  }
  console.log(`${label}: ${n} differing texels of ${p.w*p.h} (${(100*n/(p.w*p.h)).toFixed(3)}%), ${rows.size} rows touched`);
  return n;
}
console.log("");
console.log("=== FINAL-IMAGE DIFFS (the only thing the maintainer sees) ===");
diff(A, C, "game BEFORE the fix   vs render3 order");
diff(B, C, "game AFTER  the fix   vs render3 order");
diff(A, B, "game BEFORE vs AFTER  (the fix's own footprint)");

// count the palette-wall texels visible in each
function countRGB(cv: Canvas, r: number, g: number, b: number): number {
  let n = 0;
  for (let i = 0; i < cv.w * cv.h; i++)
    if (cv.d[i*4] === r && cv.d[i*4+1] === g && cv.d[i*4+2] === b && cv.d[i*4+3] === 255) n++;
  return n;
}
const LB = wallRGB("light_beach");
console.log("");
console.log(`light_beach palette wall = (${LB.join(",")})`);
console.log(`visible (${LB.join(",")}) texels: BEFORE=${countRGB(A,...LB as [number,number,number])} AFTER=${countRGB(B,...LB as [number,number,number])} RENDER3=${countRGB(C,...LB as [number,number,number])}`);
