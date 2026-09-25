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

export function rampMaskField(w: RampFieldWorld): Uint8Array {
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
  for (const d of w.decks ?? [])
    for (const c of d.cells)
      if (c.col >= 0 && c.row >= 0 && c.col < W && c.row < H && d.level > L(c.col, c.row)) out[c.row * W + c.col] = 0;
  return out;
}
