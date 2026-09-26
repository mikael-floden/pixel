/** THE COMPOSED RAMPS' CORNER MASKS, one byte per cell, for the light.
 *
 *  The lighting pass finds the surface under every screen pixel by walking a
 *  per-cell height map of WHOLE levels, so without this it lit each composed
 *  ramp as a flat top plus a wall face — a step painted over every slope the
 *  ground texture draws (maintainer 2026-09-25: "Something is rendering over
 *  it I think!"). nightlight.ts packs these masks into its surface map and
 *  the walk hits the incline instead.
 *
 *  THE RESOLVER'S OWN RULE, restated here because the light is built from the
 *  world grid, not from resolved cells (resolving all 155k cells of the_game
 *  costs seconds): `Tiles3.slopeIndexAt(…, exactOne)` — a corner is raised by
 *  a touching cell of the SAME ground exactly one level up — and
 *  `rampIndexFor` — never a full plateau top (15), never a liquid (every dry
 *  ground has a composed set while the switch is above 0%). Pinned against
 *  the resolver on every cell of the_game (server/test/rampfield.test.ts):
 *  a rule that changes there changes here. Corner bits NW 8, NE 4, SW 2,
 *  SE 1 (tiles3 `rampHeight`).
 *
 *  A cell under a deck is 0: the slab is the surface there, not the ramp. */

export interface RampFieldWorld {
  width: number;
  height: number;
  rows: ({ t?: string | null; l?: number } | null | undefined)[][];
  liquids?: string[];
  decks?: { level: number; cells: { col: number; row: number }[] }[];
}

/** The corner masks BEFORE the deck rule: every cell a composed ramp would
 *  sit on (the run field below needs the ramps under a slab to stay joined). */
export function rampMaskRaw(w: RampFieldWorld): Uint8Array {
  const W = w.width;
  const H = w.height;
  const out = new Uint8Array(W * H);
  const liquid = new Set(w.liquids ?? []);
  const g = (x: number, y: number): string | null => (x < 0 || y < 0 || x >= W || y >= H ? null : (w.rows[y]?.[x]?.t ?? null));
  const L = (x: number, y: number): number => (x < 0 || y < 0 || x >= W || y >= H ? -99 : (w.rows[y]?.[x]?.l ?? 0));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gr = g(x, y);
      if (!gr || liquid.has(gr)) continue;
      const zl = L(x, y);
      let idx = 0;
      for (let i = 0; i < 4; i++) {
        const cx = x + (i & 1);
        const cy = y + (i >> 1);
        for (let k = 0; k < 4; k++) {
          const ax = cx - 1 + (k & 1);
          const ay = cy - 1 + (k >> 1);
          if (L(ax, ay) - zl === 1 && g(ax, ay) === gr) {
            idx |= 8 >> i;
            break;
          }
        }
      }
      if (idx && idx !== 15) out[y * W + x] = idx;
    }
  }
  return out;
}

export function rampMaskField(w: RampFieldWorld, shares?: Uint8Array | null): Uint8Array {
  const W = w.width;
  const H = w.height;
  const out = rampMaskRaw(w);
  // A run the mix left a stair (share 0) wears no ramp: the light keeps its step.
  if (shares) for (let i = 0; i < out.length; i++) if (!shares[i]) out[i] = 0;
  const L = (x: number, y: number): number => (x < 0 || y < 0 || x >= W || y >= H ? -99 : (w.rows[y]?.[x]?.l ?? 0));
  for (const d of w.decks ?? [])
    for (const c of d.cells)
      if (c.col >= 0 && c.row >= 0 && c.col < W && c.row < H && d.level > L(c.col, c.row)) out[c.row * W + c.col] = 0;
  return out;
}

/** THE SLOPE MIX (maintainer 2026-09-26: "always have it on and use the
 *  following weights: off 2, 25% 1, 75% 3, 100% 2" — his third stop is the
 *  switch's 50%, the 75% one having been dropped at his word the day before).
 *  [share in % (0 = the plain stair), weight]. */
export const SLOPE_MIX: readonly (readonly [number, number])[] = [
  [0, 2],
  [25, 1],
  [50, 3],
  [100, 2],
];

/** THE SHARE OF EVERY RAMP CELL, in % (0 = no ramp, or a run the mix left a
 *  stair). A RUN — the ramp cells joined through any of their 8 neighbours —
 *  takes ONE pick, so a terrace edge, its corners and chamfers climb one
 *  height from end to end (a per-cell pick put a wall step between two ramps
 *  of one edge, and the chamfer rule reads its neighbours' masks as its own
 *  height). The pick hashes what the run IS — its size, its levels, its
 *  grounds — never where it lies, so it is the same on every thread, every
 *  load and every VIEW ROTATION (viewrot.ts resolves a turned copy of the
 *  world, where a cell's index is another cell's). Two runs alike in all
 *  three share a pick. `fixed` > 0 gives every run that share instead (his
 *  switch's fixed stops). */
export function slopeRunShares(w: RampFieldWorld, fixed = 0, mix: readonly (readonly [number, number])[] = SLOPE_MIX): Uint8Array {
  const W = w.width;
  const H = w.height;
  const m = rampMaskRaw(w);
  const out = new Uint8Array(W * H);
  let total = 0;
  for (const [, wt] of mix) total += wt;
  const stack: number[] = [];
  const run: number[] = [];
  const seen = new Uint8Array(W * H);
  const gh = new Map<string, number>();
  for (let i0 = 0; i0 < W * H; i0++) {
    if (!m[i0] || seen[i0]) continue;
    seen[i0] = 1;
    stack.push(i0);
    run.length = 0;
    let lv = 0;
    let gs = 0;
    while (stack.length) {
      const i = stack.pop() as number;
      run.push(i);
      const x = i % W;
      const y = (i - x) / W;
      const c = w.rows[y]?.[x];
      lv = (lv + (c?.l ?? 0)) | 0;
      const t = c?.t ?? "";
      let h = gh.get(t);
      if (h === undefined) gh.set(t, (h = strHash(t)));
      gs = (gs + h) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (m[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
    let share = fixed;
    if (!(fixed > 0)) {
      let r = hash32(hash32(run.length) ^ hash32(lv + 0x51ed27) ^ gs) % Math.max(1, total);
      share = 0;
      for (const [s, wt] of mix) {
        if (r < wt) {
          share = s;
          break;
        }
        r -= wt;
      }
    }
    for (const i of run) out[i] = share;
  }
  return out;
}

function strHash(t: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** A 32-bit integer mix (lowbias32): the run's pick, stable and well spread. */
function hash32(n: number): number {
  let x = (n + 0x9e3779b9) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}
