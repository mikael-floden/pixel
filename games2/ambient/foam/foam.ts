import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import {
  Bake,
  Bits,
  D_MAX,
  DX,
  DY,
  Edge,
  FRAME_MS,
  FRAMES,
  PLATE_H,
  TILE,
  TOP_ROWS,
  bakeCell,
  coastPixels,
  crestPixels,
  diamondTop,
  topFaceOf,
  waterBits,
} from "./raster";

/* SEA FOAM — the white line that lives where moving water meets land.
 *
 * "Every game is judged by its water" (maintainer 2026-09-09), and the most
 * looked-at pixel of any water is the one where it touches something. The game
 * already draws that pixel twice: the composed boundary tile's seam along a
 * beach, and the two lifted crest rows where a wall goes down into the sea.
 * Both are still pictures. This feature puts the wave into them: a crest comes
 * in from a few pixels out, piles onto the edge, and dissolves back — over a
 * beach the foam runs one pixel up the sand; against a wall it thickens and
 * throws spray — in a slow sweep along the coast so a bay never surges all at
 * once, and never in step with the next bay.
 *
 * WHERE THE LINE IS comes from the game's own resolver, never from the
 * screen: `__ml.t3at` names the boundary tile's Wang index and mask frame and
 * the mask sheet the tiles domain publishes says which pixels are water; the
 * wall foot is the games agent's `footBand` rule replicated (raster.ts). The
 * seam is in the artwork, not on the grid, and this is the first feature that
 * reads it — crabs and the water marks keep a measured DISTANCE from the
 * water cells precisely because they could not.
 *
 * HOW IT DRAWS. One sprite per cell within reach of an edge, holding a sheet
 * of FRAMES pre-baked frames of that cell's foam (raster.ts bakes them from
 * the pixel's WORLD position, so two cells agree along their shared edge and
 * a bay's phase sweep is continuous). Every sprite steps the same frame on one
 * clock. So a frame costs one setFrame per sprite and nothing else; the
 * expensive work — resolving cells, reading the picker, baking — happens
 * once per cell when it comes into reach, one cell a frame, and is cached.
 *
 * DEPTH: JUST ABOVE THE GROUND TEXTURE, under everything else. This is the
 * one ambient effect that is part of the ground: it must go under a wall's
 * face, under a pier, under a swimmer, and it must take the NIGHT and the
 * cliff's cast shadow exactly as the crest it animates does — the crest is
 * painted in the ground texture, and a foam that stayed bright at midnight
 * over a crest that went dark would look glued on. So it draws under the
 * darkness overlay and lets the game light it. Everything else this agent
 * draws sits above the overlay and grades itself; this must not.
 *
 * WHAT COVERS A WATER CELL is asked of the game's picker (`__ml.pickAt`): a
 * plateau drawn in front of a water cell hides it in the ground texture, and
 * a sprite above that texture would paint foam on the plateau. Every foam
 * pixel is checked at bake time. THE PICKER'S LATTICE SITS 4 PX BELOW THE
 * DRAWN PLATE (its diamond starts at iso.oy + dy, the plate at iso.oy + 10 —
 * measured on the quay at 280,235: the crest rows 7-8 pick as "face", row 9
 * as the cell), so the query is shifted down by PICK_DY. */

const NAME = "foam";
/** Above the ground RT (-1_000_000), under the first painter-sorted body. */
const DEPTH = -999_999;
const PICK_DY = 4;
const GAIN_TAU = 900;
const SCAN_MS = 280; // how often the view is re-walked for cells
const PAD = 24; // px beyond the view a cell is still kept live
/* THE WORK IS BUDGETED IN TIME AND ORDERED BY DISTANCE, and both halves of
 * that are paid for (maintainer 2026-09-11, at 278,261: "why is the foam
 * effect only on the left side here?").
 *
 * It was neither. A COUNT budget of 10 resolves per 280 ms scan is 36 cells a
 * second however fast the device runs, and the lattice walk visits cells in
 * grid order, which is LEFT TO RIGHT on screen. Measured at his spot: the
 * near cliff's crest had 21 sprites by 33 s while the far bank had 3, and the
 * view did not finish filling until 64 s. He photographed the middle of that.
 *
 * So: one prioritised queue, nearest to the middle of the view first, walked
 * under a per-frame time budget that covers resolving AND baking. A fast
 * device finishes a view in a second; a slow one still fills from the centre
 * out, which is where he is looking. `t3at` is 13.5 us on a cell the game has
 * already resolved for its own window and about a millisecond on one it has
 * not, which is why the budget is TIME: a count cannot tell those apart. */
const RESOLVE_MS = 1.2; // per frame, inside rec() so one bake cannot overrun it
const WORK_MS = 2.2; // per frame, the whole resolve + bake pipeline
const LEVEL_SAMPLES = 6; // picker samples per axis to learn which storeys are in view
const CACHE_CELLS = 2400; // resolved cell records kept (a few screens' worth)
const SHEET_KEEP = 160; // baked sheets kept alive past the view

/** Foam is for WATER. Lava is a liquid to the game and gets the wall's crest
 *  too, but nothing white breaks on it. */
const FOAM_LIQUIDS = new Set(["water", "deep_water"]);
const MASKS_URL = "/assets/tiles/patterns/masks.webp";
const GROUNDS_URL = "/assets/tiles/ground_types.json";
const MASK_COLS = 16;
const FALLBACK_WATER: [number, number, number] = [74, 152, 161];

type ML = Record<string, (...a: never[]) => unknown>;
const ml = (): ML | undefined => (window as unknown as { __ml?: ML }).__ml;

interface T3At {
  cell: {
    ground: string;
    level: number;
    kind: "field" | "wall";
    sx: number;
    sy: number;
    wall: { frontLow: number } | null;
  } | null;
  boundary: { index: number; a: string; b: string; maskFrame: number | null; topOnly: boolean } | null;
}

interface CellRec {
  c: number;
  r: number;
  z: number;
  sx: number;
  sy: number;
  ground: string;
  /** Own ground is a liquid (any). */
  liquid: boolean;
  /** Own ground is a liquid FOAM breaks on. */
  water: boolean;
  wallFront: number | null;
  boundary: { index: number; a: string; b: string; maskFrame: number | null } | null;
  /** Lazily derived (needs neighbours): the cell's own edges in world px, and
   *  its top-face water bits. */
  edges?: Edge[];
  waterTop?: Bits | null;
  foot?: { ul?: boolean; ur?: boolean; uu?: boolean };
}

interface Live {
  rec: CellRec;
  bake: Bake | null;
  key: string | null;
  sprite: Phaser.GameObjects.Image | null;
  /** Out of view, sheet kept for the walk back. The DRAW LOOP MUST SKIP THESE:
   *  it sets every live sprite visible, so without the flag it undid the
   *  retire pass every frame and a warm sheet flickered back on. */
  warm: boolean;
}

export function foamFeature(): AmbientFeature {
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let clock = 0;
  let frame = -1;
  let scanAge = SCAN_MS;
  let lastViewX = NaN;
  let lastViewY = NaN;
  // the mask sheet: alpha bits of the whole sheet, and the top face cut from it
  let masks: { bits: Uint8Array; w: number; h: number } | null = null;
  let masksFailed = false;
  let top: Bits = diamondTop();
  let waterRGB = new Map<string, [number, number, number]>();
  let pitch = 15;
  let world: { w: number; h: number; maxL: number } | null = null;
  // the plate lattice, learned from the first resolved cell
  let ox = NaN;
  let oy = NaN;
  const cells = new Map<number, CellRec | null>();
  /** Every ground the game has called swimmable — lava included — so a
   *  water/lava seam is never mistaken for a coast. */
  const liquidNames = new Set<string>(["lava"]);
  const isLiquidName = (g: string) => FOAM_LIQUIDS.has(g) || liquidNames.has(g);
  const cellOrder: number[] = [];
  const liquidness = new Map<number, boolean>();
  const live = new Map<number, Live>();
  /** The prioritised work queue for the current view, nearest first. */
  let queue: { c: number; r: number; d2: number }[] = [];
  let queueAt = 0;
  let scene: Phaser.Scene | null = null;
  let sprites = 0; // live sprites, kept as a count so the frame never walks the map to ask
  let drawnG = -1;
  let drawnOn = false;
  const stats = { resolves: 0, bakes: 0, bakeMs: 0, texMs: 0, texPeak: 0, scanMs: 0, scanPeak: 0, picks: 0, coast: 0, crest: 0, dropped: 0 };
  const sheetLRU: string[] = [];

  const idx = (c: number, r: number) => (world ? r * world.w + c : r * 4096 + c);

  /* ---- documents --------------------------------------------------------- */

  const loadMasks = () => {
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement("canvas");
        cv.width = img.width;
        cv.height = img.height;
        const g = cv.getContext("2d");
        if (!g) throw new Error("no 2d context");
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, cv.width, cv.height).data;
        const bits = new Uint8Array(cv.width * cv.height);
        for (let i = 0; i < bits.length; i++) bits[i] = d[i * 4 + 3] > 127 ? 1 : 0;
        if (cv.width !== MASK_COLS * TILE) throw new Error(`mask sheet is ${cv.width} wide, expected ${MASK_COLS * TILE}`);
        masks = { bits, w: cv.width, h: cv.height };
        // frame 15 of row 0 is the full silhouette
        const sil = new Uint8Array(TILE * PLATE_H);
        for (let y = 0; y < PLATE_H; y++) for (let x = 0; x < TILE; x++) sil[y * TILE + x] = bits[y * cv.width + 15 * TILE + x];
        top = topFaceOf(sil);
        // every derived record is stale: it was cut with the plain diamond
        for (const rec of cells.values()) if (rec) { rec.edges = undefined; rec.waterTop = undefined; }
        for (const l of live.values()) dropLive(l);
        live.clear();
      } catch (e) {
        masksFailed = true;
        console.warn("[ambient/foam] mask sheet unusable — coasts stay still, walls still foam:", e);
      }
    };
    img.onerror = () => {
      masksFailed = true;
      console.warn("[ambient/foam] mask sheet failed to load — coasts stay still, walls still foam");
    };
    img.src = MASKS_URL;
  };

  const loadGrounds = () => {
    fetch(GROUNDS_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((doc: { grounds?: Record<string, unknown> } & Record<string, unknown>) => {
        const table = (doc.grounds ?? doc) as Record<string, { palette?: { top?: string }; base_color?: string }>;
        const next = new Map<string, [number, number, number]>();
        for (const name of FOAM_LIQUIDS) {
          const hex = table[name]?.palette?.top ?? table[name]?.base_color;
          if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) continue;
          next.set(name, [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
        }
        waterRGB = next;
      })
      .catch((e) => console.warn("[ambient/foam] ground palette unavailable, foam takes the default water tone:", e));
  };

  const maskBit = (frame: number, px: number, py: number): boolean => {
    if (!masks) return false;
    const r0 = Math.floor(frame / MASK_COLS) * PLATE_H;
    const c0 = (frame % MASK_COLS) * TILE;
    return masks.bits[(r0 + py) * masks.w + c0 + px] === 1;
  };

  /* ---- the game's view of a cell ---------------------------------------- */

  const isLiquidCell = (c: number, r: number): boolean => {
    if (!world || c < 0 || r < 0 || c >= world.w || r >= world.h) return false;
    const i = idx(c, r);
    const known = liquidness.get(i);
    if (known !== undefined) return known;
    const f = ml()?.surfaceAt as undefined | ((x: number, y: number) => { swimmable?: boolean } | null);
    let v = false;
    try {
      v = !!f?.((c + 0.5) * 32, (r + 0.5) * 32)?.swimmable;
    } catch {
      v = false;
    }
    liquidness.set(i, v);
    return v;
  };

  /** Resolve one cell through `t3at`, or return the cached record. `null`
   *  once resolved as nothing; `undefined` while unresolved (budget). */
  /** Time spent resolving THIS FRAME. The budget lives inside `rec` rather
   *  than around the caller because a single bake resolves its whole 3x3
   *  neighbourhood, and a caller-side check cannot stop that overrunning. */
  let resolveMs = 0;
  const rec = (c: number, r: number): CellRec | null | undefined => {
    if (!world || c < 0 || r < 0 || c >= world.w || r >= world.h) return null;
    const i = idx(c, r);
    if (cells.has(i)) return cells.get(i);
    if (resolveMs >= RESOLVE_MS) return undefined;
    const tR = performance.now();
    stats.resolves++;
    const f = ml()?.t3at as undefined | ((c: number, r: number) => T3At | null);
    let t: T3At | null = null;
    try {
      t = f ? f(c, r) : null;
    } catch {
      t = null;
    }
    let out: CellRec | null = null;
    if (t?.cell) {
      const cell = t.cell;
      out = {
        c,
        r,
        z: cell.level,
        sx: cell.sx,
        sy: cell.sy,
        ground: cell.ground,
        liquid: isLiquidCell(c, r),
        water: FOAM_LIQUIDS.has(cell.ground),
        wallFront: cell.kind === "wall" && cell.wall ? cell.wall.frontLow : null,
        boundary: t.boundary ? { index: t.boundary.index, a: t.boundary.a, b: t.boundary.b, maskFrame: t.boundary.maskFrame } : null,
      };
      if (Number.isNaN(ox)) {
        ox = cell.sx - (c - r) * DX;
        oy = cell.sy - (c + r) * DY + cell.level * pitch;
      }
      if (out.liquid) liquidNames.add(out.ground);
    }
    cells.set(i, out);
    resolveMs += performance.now() - tR;
    cellOrder.push(i);
    if (cellOrder.length > CACHE_CELLS) {
      const old = cellOrder.splice(0, cellOrder.length - CACHE_CELLS);
      for (const k of old) if (!live.has(k)) cells.delete(k);
    }
    return out;
  };

  const level = (c: number, r: number): number | undefined => {
    const x = rec(c, r);
    return x === undefined ? undefined : x ? x.z : -1;
  };

  /** The games agent's `wallFoot`, on the resolver's records: a higher,
   *  non-liquid up-neighbour whose LOWEST front is this cell's level. */
  const footOf = (x: CellRec): { ul?: boolean; ur?: boolean; uu?: boolean } | undefined => {
    if (x.foot) return x.foot;
    const out: { ul?: boolean; ur?: boolean; uu?: boolean } = {};
    for (const [dir, hx, hy] of [["ul", x.c - 1, x.r], ["ur", x.c, x.r - 1], ["uu", x.c - 1, x.r - 1]] as const) {
      const h = rec(hx, hy);
      if (h === undefined) return undefined;
      if (!h || h.liquid || h.z <= x.z) continue;
      const a = level(hx + 1, hy);
      const b = level(hx, hy + 1);
      if (a === undefined || b === undefined) return undefined;
      if (Math.min(a, b) !== x.z) continue;
      out[dir] = true;
    }
    x.foot = out;
    return out;
  };

  /** Top-face water bits and the cell's own edges, world px. */
  const derive = (x: CellRec): boolean => {
    if (x.edges) return true;
    let waterTop: Bits | null = null;
    const edges: Edge[] = [];
    const b = x.boundary;
    const coastal = !!b && masks && b.maskFrame !== null && (FOAM_LIQUIDS.has(b.a) !== FOAM_LIQUIDS.has(b.b)) && !(isLiquidName(b.a) && isLiquidName(b.b));
    if (coastal) {
      const frame = b!.maskFrame as number;
      const waterIsB = FOAM_LIQUIDS.has(b!.b);
      waterTop = waterBits(top, x.water, (px, py) => maskBit(frame, px, py), waterIsB);
      for (const i of coastPixels(waterTop, top)) edges.push({ x: x.sx + (i % TILE), y: x.sy + Math.floor(i / TILE), hard: 0 });
      stats.coast += edges.length;
    } else if (x.water) {
      waterTop = waterBits(top, true, null, false);
    }
    if (x.water) {
      const foot = footOf(x);
      if (foot === undefined) return false;
      if (foot.ul || foot.ur || foot.uu) {
        let n = 0;
        for (const i of crestPixels(foot, pitch)) {
          edges.push({ x: x.sx + (i % TILE), y: x.sy + Math.floor(i / TILE), hard: 1 });
          n++;
        }
        stats.crest += n;
      }
    }
    x.waterTop = waterTop;
    x.edges = edges;
    return true;
  };


  /* ---- baking ------------------------------------------------------------ */

  /** The picker answers per CELL, so asking it per 2x2 block loses nothing
   *  a plateau's diamond edge does not already blur, and costs a quarter. */
  const visibleAt = (x: CellRec) => {
    const f = ml()?.pickAt as undefined | ((wx: number, wy: number) => { x: number; y: number; lvl: number } | null);
    const seen = new Map<number, boolean>();
    return (X: number, Y: number): boolean => {
      if (!f) return true;
      const bx = X >> 1, by = Y >> 1;
      const key = bx * 65536 + by;
      const hit = seen.get(key);
      if (hit !== undefined) return hit;
      stats.picks++;
      let p: { x: number; y: number; lvl: number } | null = null;
      try {
        p = f(bx * 2 + 1, by * 2 + 1 + PICK_DY);
      } catch {
        seen.set(key, false);
        return false;
      }
      const ok = !!p && p.lvl === x.z && Math.abs(Math.floor(p.x / 32) - x.c) <= 1 && Math.abs(Math.floor(p.y / 32) - x.r) <= 1;
      seen.set(key, ok);
      return ok;
    };
  };

  /** Bake one cell: needs its 3x3 neighbourhood resolved and derived.
   *  `undefined` when a dependency is still unresolved — the caller retries
   *  next frame rather than recording a cell that never gets its sprite. */
  const bake = (x: CellRec): Bake | null | undefined => {
    const edges: Edge[] = [];
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const n = rec(x.c + dc, x.r + dr);
        if (n === undefined) return undefined;
        if (!n) continue;
        // a neighbour on another storey draws elsewhere: its edges are not on this plane
        if (n.z !== x.z) continue;
        if (!derive(n)) return undefined;
        for (const e of n.edges!) edges.push(e);
      }
    if (!derive(x)) return undefined;
    const t0 = performance.now();
    const water = x.waterTop;
    let out: Bake | null = null;
    if (water && edges.length) {
      const rgb = waterRGB.get(x.water ? x.ground : x.boundary && FOAM_LIQUIDS.has(x.boundary.a) ? x.boundary.a : x.boundary?.b ?? "water") ?? FALLBACK_WATER;
      out = bakeCell({ sx: x.sx, sy: x.sy, water, top, edges, visible: visibleAt(x), waterRGB: rgb });
    }
    stats.bakes++;
    stats.bakeMs += performance.now() - t0;
    return out;
  };

  /** Install a baked cell: its sheet, its sprite, its place in the LRU. */
  const install = (x: CellRec, out: Bake | null): void => {
    const l: Live = { rec: x, bake: out, key: null, sprite: null, warm: false };
    live.set(idx(x.c, x.r), l);
    if (out && scene) {
      const t1 = performance.now();
      const key = `amb-foam:${x.c},${x.r}`;
      const tex = scene.textures.createCanvas(key, out.w * out.frames, out.h);
      if (tex) {
        const ctx2 = tex.getContext();
        const id = ctx2.createImageData(out.w * out.frames, out.h);
        id.data.set(out.data);
        ctx2.putImageData(id, 0, 0);
        tex.setFilter(Phaser.Textures.FilterMode.NEAREST);
        for (let k = 0; k < out.frames; k++) tex.add(k, 0, k * out.w, 0, out.w, out.h);
        tex.refresh();
        l.key = key;
        l.sprite = scene.add
          .image(x.sx + out.bx, x.sy + out.by, key, 0)
          .setOrigin(0, 0)
          .setDepth(DEPTH)
          .setScale(1)
          .setAlpha(0)
          .setVisible(false);
        sheetLRU.push(key);
        sprites++;
      }
      const tm = performance.now() - t1;
      stats.texMs += tm;
      if (tm > stats.texPeak) stats.texPeak = tm;
    }
  };

  const dropLive = (l: Live) => {
    if (l.sprite) sprites--;
    l.sprite?.destroy();
    l.sprite = null;
    if (l.key && scene) {
      scene.textures.remove(l.key);
      const at = sheetLRU.indexOf(l.key);
      if (at >= 0) sheetLRU.splice(at, 1);
    }
    l.key = null;
    l.bake = null;
  };

  /* ---- the scan ---------------------------------------------------------- */

  const scan = (view: Phaser.Geom.Rectangle) => {
    if (!world) {
      const f = ml()?.worldInfo as undefined | (() => { w?: number; h?: number; maxL?: number } | null);
      let w: { w?: number; h?: number; maxL?: number } | null = null;
      try {
        w = f ? f() : null;
      } catch {
        w = null;
      }
      if (!w || !w.w || !w.h) return;
      world = { w: w.w, h: w.h, maxL: w.maxL ?? 0 };
      const t3 = ml()?.tiles3 as undefined | (() => { geom?: { lh?: number } } | null);
      try {
        pitch = t3?.()?.geom?.lh ?? pitch;
      } catch {
        /* keep the default */
      }
    }
    const t0 = performance.now();
    // Learn the lattice from any cell if we have none yet (a cheap first probe).
    if (Number.isNaN(ox)) {
      const f = ml()?.pickAt as undefined | ((wx: number, wy: number) => { x: number; y: number } | null);
      let p: { x: number; y: number } | null = null;
      try {
        p = f ? f(view.centerX, view.centerY) : null;
      } catch {
        p = null;
      }
      if (p) rec(Math.floor(p.x / 32), Math.floor(p.y / 32));
      if (Number.isNaN(ox)) return;
    }
    const x0 = view.x - PAD, x1 = view.right + PAD, y0 = view.y - PAD, y1 = view.bottom + PAD;
    // WHICH STOREYS ARE ON SCREEN: a lake on a plateau is drawn a storey's worth
    // of pixels higher, so its cells are further down the lattice than the view
    // suggests. The picker says what is drawn; each storey it reports gets its
    // own pass, and the world's whole height is never walked on speculation.
    const levels = new Set<number>([0]);
    {
      const f = ml()?.pickAt as undefined | ((wx: number, wy: number) => { lvl: number } | null);
      if (f)
        for (let i = 0; i < LEVEL_SAMPLES; i++)
          for (let j = 0; j < LEVEL_SAMPLES; j++) {
            try {
              const p = f(view.x + ((i + 0.5) / LEVEL_SAMPLES) * view.width, view.y + ((j + 0.5) / LEVEL_SAMPLES) * view.height);
              if (p) levels.add(p.lvl);
            } catch {
              /* a throwing picker reads as level 0 only */
            }
          }
    }
    const sMin = Math.floor((x0 - ox) / DX) - 1;
    const sMax = Math.ceil((x1 - ox) / DX) + 1;
    const wanted = new Set<number>();
    /* THE QUEUE, NEAREST TO THE MIDDLE OF THE VIEW FIRST. Nothing is resolved
     * here — a candidate's plate position follows from the lattice alone, so
     * the ordering costs no `t3at` at all, and the only per-cell work in the
     * walk is the cheap liquid-quad test (`surfaceAt`, 0.1 us measured). */
    const cx = view.x + view.width / 2;
    const cy = view.y + view.height / 2;
    const q: { c: number; r: number; d2: number }[] = [];
    for (const z of levels)
    for (let t = Math.floor((y0 - oy + z * pitch) / DY) - 3, tMax = Math.ceil((y1 - oy + z * pitch) / DY) + 1; t <= tMax; t++)
      for (let s = sMin; s <= sMax; s++) {
        if (((s + t) & 1) !== 0) continue;
        const c = (s + t) / 2;
        const r = (t - s) / 2;
        if (c < 0 || r < 0 || c >= world.w || r >= world.h) continue;
        // cheap: a cell matters only when it or a quad partner is liquid
        if (!(isLiquidCell(c, r) || isLiquidCell(c + 1, r) || isLiquidCell(c, r + 1) || isLiquidCell(c + 1, r + 1))) continue;
        // where this cell's plate lands, straight off the lattice
        const sx = ox + (c - r) * DX;
        const sy = oy + (c + r) * DY - z * pitch;
        if (sx + TILE < x0 || sx > x1 || sy + TOP_ROWS < y0 || sy > y1) continue;
        const i = idx(c, r);
        if (wanted.has(i)) continue; // another storey already claimed this cell
        wanted.add(i);
        const back = live.get(i);
        if (back) back.warm = false; // in view again
        const dx = sx + DX - cx;
        const dy = (sy + DY - cy) * (DX / DY); // screen distance, not lattice distance
        q.push({ c, r, d2: dx * dx + dy * dy });
      }
    q.sort((a, b) => a.d2 - b.d2);
    queue = q;
    queueAt = 0;
    // retire what left the view
    for (const [i, l] of live) {
      if (wanted.has(i)) continue;
      if (l.key && sheetLRU.length <= SHEET_KEEP) {
        l.warm = true;
        l.sprite?.setVisible(false);
        continue; // keep the sheet warm: it is likely to come back
      }
      dropLive(l);
      live.delete(i);
    }
    while (sheetLRU.length > SHEET_KEEP) {
      const key = sheetLRU[0];
      for (const [i, l] of live)
        if (l.key === key && !wanted.has(i)) {
          dropLive(l);
          live.delete(i);
          break;
        }
      if (sheetLRU[0] === key) sheetLRU.shift();
    }
    stats.scanMs = performance.now() - t0;
    if (stats.scanMs > stats.scanPeak) stats.scanPeak = stats.scanMs;
  };

  /** Walk the queue nearest-first under a time budget: resolve, decide, bake,
   *  install. At most ONE sheet upload a frame — an upload peaked at 9 ms on
   *  the software-GL harness before the bounding box was trimmed, and one a
   *  frame is the cap that kept it invisible. */
  const work = (): void => {
    const t0 = performance.now();
    let uploaded = false;
    while (queueAt < queue.length) {
      if (performance.now() - t0 > WORK_MS) break;
      const q = queue[queueAt];
      const i = idx(q.c, q.r);
      if (live.has(i)) {
        queueAt++;
        continue;
      }
      const x = rec(q.c, q.r);
      if (x === undefined) break; // out of resolve time; the same cell is first next frame
      queueAt++;
      if (!x) continue;
      // only a cell with water on its top face can carry foam
      if (!x.water && !(x.boundary && (FOAM_LIQUIDS.has(x.boundary.a) || FOAM_LIQUIDS.has(x.boundary.b)))) continue;
      const out = bake(x);
      if (out === undefined) {
        queueAt--; // a neighbour is still unresolved: retry this cell next frame
        break;
      }
      install(x, out);
      if (out) {
        if (uploaded) break;
        uploaded = true;
      }
    }
  };

  /* ---- the feature ------------------------------------------------------- */

  return {
    name: NAME,
    init(ctx) {
      scene = ctx.scene;
      loadMasks();
      loadGrounds();
    },
    update(ctx, dt) {
      const dtc = Math.min(dt, 100);
      resolveMs = 0; // the resolve budget is per FRAME
      clock += dtc;
      const k = Math.floor(clock / FRAME_MS) % FRAMES;
      const view = ctx.view;
      // scan on a throttle, or sooner when the camera has moved a cell
      scanAge += dt;
      const moved = Math.abs(view.x - lastViewX) > DX || Math.abs(view.y - lastViewY) > 2 * DY;
      const outdoorNow = ctx.outdoor > 0.01 || forced;
      if ((scanAge >= SCAN_MS || moved) && !suppressed && outdoorNow) {
        scanAge = 0;
        lastViewX = view.x;
        lastViewY = view.y;
        scan(view);
      }
      if (outdoorNow && !suppressed && !Number.isNaN(ox)) work();
      const target = forced ? 1 : suppressed ? 0 : sprites > 0 ? 1 : 0;
      gain += (target - gain) * Math.min(1, (dtc / GAIN_TAU) * 3);
      const g = gain * ctx.outdoor;
      const stepped = k !== frame;
      frame = k;
      // IDLE IS FREE: with nothing stepping and the gain settled, no sprite is touched.
      if (!stepped && Math.abs(g - drawnG) < 1e-3 && (g >= 0.01) === drawnOn) return;
      drawnG = g;
      drawnOn = g >= 0.01;
      for (const l of live.values()) {
        const s = l.sprite;
        if (!s) continue;
        if (l.warm) {
          if (s.visible) s.setVisible(false);
          continue;
        }
        if (!drawnOn) {
          if (s.visible) s.setVisible(false);
          continue;
        }
        if (stepped) s.setFrame(k);
        s.setAlpha(g).setVisible(true);
      }
    },
    setSuppressed(on) {
      suppressed = on;
    },
    setForced(on) {
      forced = on;
    },
    debug() {
      const all: { c: number; r: number; z: number; a: number; px: number; bx: number; by: number; w: number; h: number; x: number; y: number }[] = [];
      let visible = 0;
      for (const l of live.values()) {
        if (!l.sprite || !l.bake || l.warm) continue; // a warm sheet is out of view
        if (l.sprite.visible) visible++;
        all.push({ c: l.rec.c, r: l.rec.r, z: l.rec.z, a: l.sprite.visible ? l.sprite.alpha : 0, px: l.bake.count, bx: l.bake.bx, by: l.bake.by, w: l.bake.w, h: l.bake.h, x: l.rec.sx, y: l.rec.sy });
      }
      return {
        gain,
        suppressed,
        forced,
        frame,
        frames: FRAMES,
        frameMs: FRAME_MS,
        reach: D_MAX,
        masks: !!masks,
        masksFailed,
        palette: [...waterRGB.keys()],
        pitch,
        lattice: { ox, oy },
        cells: cells.size,
        live: live.size,
        queued: queue.length - queueAt,
        pending: queue.length - queueAt,
        sprites: all.length,
        visible,
        ...stats,
        all,
      };
    },
    dispose() {
      for (const l of live.values()) dropLive(l);
      live.clear();
      queue = [];
      queueAt = 0;
      cells.clear();
      cellOrder.length = 0;
      liquidness.clear();
      scene = null;
    },
  };
}
