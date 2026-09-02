// Monsters — single source of truth shared by BOTH the server (authoritative
// spawning/roaming) and the client (rendering). Framework-free pure TS: no
// Colyseus, no Phaser.
//
// SPAWN ZONES ARE MAP DATA (maintainer 2026-07-29): the maps2 agent owns them.
// Every world ships a `spawns.json` beside its world.json — `pixel-maps2/
// spawns@1` under maps2/worlds, `pixel-maps3/spawns@1` under maps2/worlds3
// (spec: maps2/spec/SPAWNS.md) — polygon zones {id, monster, area, elev, num}.
// This module holds the PURE geometry/parsing half (schema types, even-odd
// point-in-polygon, polygon→cells); the terrain-aware half (which cells are
// actually standable at the zone's elevation band) is `buildZoneRuntimes` in
// ./index (it needs the grid helpers, which live there). The old hardcoded
// rectangles clustered near the player spawn ("fake debug areas") are GONE —
// this file replaced them when spawns@1 landed.
//
// Source CELL_WU from the dependency-free leaf, NOT the ./index barrel: index.ts
// re-exports THIS module, so importing ./index here would be a cycle.
import { CELL_WU } from "./units";

// One spawn zone from spawns@1. `area` is a SIMPLE polygon in TILE-CORNER
// coordinates (cell (x,y) spans corners (x,y)..(x+1,y+1)), implicitly closed;
// concave is fine, self-intersections are generator-asserted away. `elev` is
// the INTENDED walk surface band [min,max] in world LEVELS — a monster may
// stand at a cell on whichever surface (base OR deck) has its level in range.
// `num` is the zone's population (the game treats it as the concurrent cap).
export interface SpawnZone {
  id: string;
  monster: string;
  area: Array<[number, number]>;
  elev: [number, number];
  num: number;
}

// The spawn schemas this parser reads. maps3 worlds carry the SAME zone
// document under a maps3 name — verified field by field against the two live
// files: identical top-level keys, identical zone keys in identical order
// (id, monster, area, elev, num), identical value types, and the_game's 70
// ported zones are the_island2's translated by (+240,+244) with monster/elev/
// num untouched. The version rides with the WORLD schema, not the zone shape,
// so one shape is read under both names. (An unlisted schema is still [] —
// the guard is what stops a world.json or a places.json being read as zones.)
const SPAWN_SCHEMAS = new Set(["pixel-maps2/spawns@1", "pixel-maps3/spawns@1"]);

/** Parse a spawns.json payload. Returns [] for anything that isn't a
 * well-formed spawns@1 document (see SPAWN_SCHEMAS); malformed zones are
 * skipped individually so one bad entry can't drop a whole world's monsters. */
export function parseSpawns(json: unknown): SpawnZone[] {
  const doc = json as { schema?: string; zones?: unknown[] } | null;
  if (!doc || !SPAWN_SCHEMAS.has(doc.schema as string) || !Array.isArray(doc.zones)) return [];
  const out: SpawnZone[] = [];
  for (const z of doc.zones as Array<Record<string, unknown>>) {
    if (!z || typeof z.id !== "string" || typeof z.monster !== "string") continue;
    const area = z.area as Array<[number, number]>;
    const elev = z.elev as [number, number];
    if (!Array.isArray(area) || area.length < 3) continue;
    if (!Array.isArray(elev) || elev.length !== 2) continue;
    const num = typeof z.num === "number" && z.num > 0 ? Math.floor(z.num) : 1;
    out.push({ id: z.id, monster: z.monster, area, elev: [elev[0], elev[1]], num });
  }
  return out;
}

/** Even-odd point-in-polygon (the spec's membership rule) against a zone's
 * tile-corner polygon. `px/py` are in the same corner-coordinate space —
 * pass cell centres (c+0.5, r+0.5) to test cell membership. */
export function pointInZone(zone: SpawnZone, px: number, py: number): boolean {
  const poly = zone.area;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** All grid cells whose CENTRE lies inside the zone polygon (clipped to the
 * world), row-major. Pure geometry — elevation/standability filtering happens
 * against the terrain grid in buildZoneRuntimes.
 *
 * SCANLINE, and byte-identical to testing every cell with `pointInZone`: each
 * row's edge crossings are computed ONCE with the exact expression and
 * half-open rule pointInZone uses, then a cell is inside when an odd number of
 * crossings lie strictly right of its centre — the same parity the per-cell
 * toggle loop arrives at, without re-walking every edge per cell. (Per-cell
 * over the bbox cost 3.1 s of server CPU per room creation on the_game AND
 * the_island2 — 82 zones × bbox × edges, blocking the sim for everyone
 * already in the world; 8 ms now. Pinned by server/test/zonefill.test.ts.) */
export function zonePolygonCells(
  zone: SpawnZone,
  wCells: number,
  hCells: number,
): Array<{ c: number; r: number }> {
  const poly = zone.area;
  let minC = Infinity;
  let minR = Infinity;
  let maxC = -Infinity;
  let maxR = -Infinity;
  for (const [x, y] of poly) {
    minC = Math.min(minC, x);
    maxC = Math.max(maxC, x);
    minR = Math.min(minR, y);
    maxR = Math.max(maxR, y);
  }
  const out: Array<{ c: number; r: number }> = [];
  const c0 = Math.max(0, Math.floor(minC));
  const c1 = Math.min(wCells - 1, Math.ceil(maxC) - 1);
  const r0 = Math.max(0, Math.floor(minR));
  const r1 = Math.min(hCells - 1, Math.ceil(maxR) - 1);
  const xs: number[] = [];
  for (let r = r0; r <= r1; r++) {
    const py = r + 0.5;
    xs.length = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > py !== yj > py) xs.push(((xj - xi) * (py - yi)) / (yj - yi) + xi);
    }
    if (!xs.length) continue;
    xs.sort((a, b) => a - b);
    // Centres sweep left to right; k = crossings NOT strictly right of px, so
    // xs.length - k is exactly the count pointInZone's toggle loop would make.
    let k = 0;
    for (let c = c0; c <= c1; c++) {
      const px = c + 0.5;
      while (k < xs.length && !(px < xs[k])) k++;
      if ((xs.length - k) & 1) out.push({ c, r });
    }
  }
  return out;
}

/** Chebyshev distance, in CELLS, from a cell to a zone polygon's bounding box
 * — 0 when the cell is inside the box. The box, not the polygon: this ranks
 * zones by how soon a walker could meet them, and a box is never smaller than
 * its polygon, so it can only err toward "near". */
export function zoneDistanceCells(zone: SpawnZone, col: number, row: number): number {
  let minC = Infinity;
  let minR = Infinity;
  let maxC = -Infinity;
  let maxR = -Infinity;
  for (const [x, y] of zone.area) {
    minC = Math.min(minC, x);
    maxC = Math.max(maxC, x);
    minR = Math.min(minR, y);
    maxR = Math.max(maxR, y);
  }
  const dc = Math.max(minC - col, 0, col - maxC);
  const dr = Math.max(minR - row, 0, row - maxR);
  return Math.max(dc, dr);
}

/** How far, in cells, a spawn zone may be from where the player will stand
 * for its monsters' walk/idle art to ride the BOOT batch. Beyond it the art
 * rides the deferred batch and the monster stays culled until it lands.
 * (32 = several phone screens: a monster roams only inside its own zone and
 * chases at most ESCAPE_RADIUS_WU ≈ 12 cells past it, and the deferred batch
 * lands within seconds of the join. Measured on the_game and the_island2:
 * 20 of 57 kinds within 32 cells of the spawn — 592 strips / 3.4 MB off a
 * 1,884-request boot.) */
export const MONSTER_BOOT_RADIUS_CELLS = 32;

/** The monster kinds whose art the boot batch carries: every kind with a zone
 * within `radiusCells` of ANY centre — the world's declared spawn and the
 * player's last known spot in this world (a returning player lands on their
 * saved spot, not the spawn). No centres → every kind, the pre-split
 * behaviour: when in doubt, include. */
export function monsterBootKinds(
  zones: SpawnZone[],
  centres: ReadonlyArray<readonly [number, number]>,
  radiusCells: number = MONSTER_BOOT_RADIUS_CELLS,
): Set<string> {
  const out = new Set<string>();
  for (const z of zones) {
    if (!centres.length || centres.some(([c, r]) => zoneDistanceCells(z, c, r) <= radiusCells)) out.add(z.monster);
  }
  return out;
}

/** The zone polygon's bounding box in WORLD UNITS (debug overlay publish). */
export function zoneBBox(zone: SpawnZone): { x0: number; y0: number; x1: number; y1: number } {
  let minC = Infinity;
  let minR = Infinity;
  let maxC = -Infinity;
  let maxR = -Infinity;
  for (const [x, y] of zone.area) {
    minC = Math.min(minC, x);
    maxC = Math.max(maxC, x);
    minR = Math.min(minR, y);
    maxR = Math.max(maxR, y);
  }
  return { x0: minC * CELL_WU, y0: minR * CELL_WU, x1: maxC * CELL_WU, y1: maxR * CELL_WU };
}

// Roam tuning ---------------------------------------------------------------

// Monsters walk slowly; scale player WALK_SPEED down for monster movement.
export const MONSTER_SPEED_SCALE = 0.6;

// Pause (ms) after arriving at a roam target before picking the next one. A
// random value in [MIN, MAX] gives natural, staggered idling.
export const MONSTER_ROAM_PAUSE_MS_MIN = 800;
export const MONSTER_ROAM_PAUSE_MS_MAX = 2600;

// Consider a roam target "reached" within this many world units (also used to
// avoid picking a next target that is trivially close to the current spot).
export const MONSTER_ARRIVE_RADIUS = CELL_WU * 0.5;

// A roam leg's reach: pick the next target within this many CELLS of the
// current spot so monsters mill about locally instead of beelining across a
// zone that can span half the map.
export const MONSTER_ROAM_RADIUS_CELLS = 6;

// A* budget for a ROAM leg (findPath `maxNodes`). Roam targets are arbitrary
// cells inside a zone — zones on the_island2 average 968 cells and reach 5679,
// so an unbudgeted search occasionally expanded thousands of nodes and blew
// through the 50ms tick (measured on the real grid: p99 21.8ms, max 28.9ms).
// findPath degrades GRACEFULLY: when the budget runs out it returns its
// best-effort route toward the goal (`closest`), never null, so a capped leg
// simply walks part of the way and the monster picks a fresh target after its
// normal pause — indistinguishable from ordinary wandering. Measured with this
// cap: p99 1.7ms, max 2.1ms, ZERO failed routes.
// NOT for player taps: tap-to-move relies on the full search to cross the map.
export const MONSTER_ROAM_MAX_NODES = 300;

// Soft collision (maintainer 2026-07-30): monsters are deliberately NOT in
// the collision grid — syncing real collision would tax the network and the
// pathfinder. Instead: the SERVER steers monsters to keep a comfortable
// distance from each other and from players (a local separation push — the
// positions already sync, so it costs nothing extra), and the CLIENT slips
// the player's INPUT around a monster's personal space exactly like steer
// assist slips around a prop corner (the deflected vector is what gets
// predicted AND sent, so server and prediction integrate the same move and
// nothing rubber-bands).
//
// v2 (maintainer 2026-07-30 screenshot: two mammoths perfectly stacked —
// "can't see monsters avoiding each other even the slightest"): distances are
// PER-BODY now, not one constant. Every monster carries an art-measured
// `radius` (half its footprint width; horizontal iso screen px ≈ 1wu, so art
// px are world units) in monsters.json; the comfort distance between two
// bodies is rA + rB + MONSTER_SEP_MARGIN. The old fixed 18wu threshold never
// even ACTIVATED before an 84wu-wide mammoth pair fully overlapped.
export const DEFAULT_MONSTER_RADIUS = 13; // wu — fallback when the manifest is absent
export const PLAYER_BODY_RADIUS = 9; // wu — the player's own footprint half-width
export const MONSTER_SEP_MARGIN = 4; // wu — breathing room beyond touching radii
export const MONSTER_SEP_RELAX_SPEED = 90; // wu/s — cap on the positional push (no teleporting)
export const MONSTER_DODGE_MARGIN = 6; // wu — dodge clearance beyond the radii sum
export const MONSTER_DODGE_LOOKAHEAD = 26; // wu — MINIMUM dodge lookahead (scales with radius)
// THE PASS — the player's "special move" past a body blocking the ONLY lane
// (maintainer 2026-08-13: "this should not result in the player switching
// direction back and forth in panic... run straight past the blocker", the
// basketball crossover). Bodies are input-deflection only, so passing through
// is physically free; these tune when the dodge gives up negotiating.
export const DODGE_PASS_STALL_MS = 450; // dodging this long without real progress → pass
export const DODGE_PASS_STALL_WU = 8; // "real progress" = moving this far resets the clock
export const DODGE_PASS_MAX_MS = 1600; // a pass that outlives this re-arms the normal dodge
export const DODGE_PASS_JINK_MS = 160; // the crossover feint: one quick diagonal step first

/** One tick of positional separation for `bodies[self]` against every other
 * body. Overlap = (rA + rB + MONSTER_SEP_MARGIN) - distance; each overlapping
 * pair contributes a push-out along the centre line, the summed push is
 * CLAMPED to MONSTER_SEP_RELAX_SPEED·dt (a firm shove that never teleports),
 * and an EXACTLY stacked pair (d≈0 — the maintainer's two-mammoths-one-spot
 * screenshot) splits along the caller-seeded `tieBreak` direction. Pure — the
 * caller validates the move against terrain/zone before applying it.
 *
 * HOT PATH (perf 2026-07-31): the server calls this once per monster per tick
 * against every body, so the_island2's 160 monsters run ~26k pair tests 20×a
 * second. It profiled at 12.9% of the server's busy CPU — the biggest
 * game-logic cost after the roam loop itself. The comparison is therefore done
 * on the SQUARED distance and the square root is taken ONLY for a pair that
 * actually overlaps (a handful per tick): `Math.hypot` is a variadic with
 * overflow/underflow guards and is far slower than a plain multiply-add, and
 * these coordinates are ordinary world units with no overflow risk. Exactly
 * the same decisions come out — `d >= target` ⟺ `d² >= target²` for
 * non-negative values — so behaviour is unchanged. */
export function separationPush(
  bodies: Array<{ x: number; y: number; r: number }>,
  self: number,
  dt: number,
  tieBreak = 0, // radians — direction to split an exactly stacked pair along
): { dx: number; dy: number } | null {
  const me = bodies[self];
  const mx = me.x;
  const my = me.y;
  const mr = me.r + MONSTER_SEP_MARGIN;
  let px = 0;
  let py = 0;
  for (let i = 0; i < bodies.length; i++) {
    if (i === self) continue;
    const b = bodies[i];
    const dx = mx - b.x;
    const dy = my - b.y;
    const target = mr + b.r;
    const d2 = dx * dx + dy * dy;
    if (d2 >= target * target) continue; // comfortable — no sqrt needed
    if (d2 < 1e-12) {
      // d < 1e-6, i.e. exactly stacked.
      px += Math.cos(tieBreak) * target;
      py += Math.sin(tieBreak) * target;
      continue;
    }
    const d = Math.sqrt(d2);
    const o = target - d; // penetration depth
    px += (dx / d) * o;
    py += (dy / d) * o;
  }
  if (px === 0 && py === 0) return null;
  const l = Math.sqrt(px * px + py * py);
  const step = Math.min(l, MONSTER_SEP_RELAX_SPEED * dt);
  return { dx: (px / l) * step, dy: (py / l) * step };
}

// Pick a random pause (ms) in the roam range using injected rng.
export function randomPauseMs(rng: () => number): number {
  return (
    MONSTER_ROAM_PAUSE_MS_MIN +
    rng() * (MONSTER_ROAM_PAUSE_MS_MAX - MONSTER_ROAM_PAUSE_MS_MIN)
  );
}
