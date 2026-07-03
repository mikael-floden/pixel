/**
 * Shared constants + pure helpers used by BOTH the authoritative server and the
 * browser client, so movement/direction logic can never drift between them.
 */

// --- World -------------------------------------------------------------------
// World units: 32 per map cell, sized to the current bigworld grid (512×448).
// If the maps agent changes the world dimensions, update these to w*32 / h*32.
export const CELL_WU = 32;
export const WORLD_WIDTH = 512 * CELL_WU;
export const WORLD_HEIGHT = 448 * CELL_WU;

// Movement speeds in world units per second.
// Retuned for CELL_WU=32 (screen px/wu grew ~13% vs the old 44×44 world).
export const WALK_SPEED = 70;
export const RUN_SPEED = 175;

// Authoritative simulation tick (updates per second).
export const TICK_RATE = 20;

// Keep players this far from the world edge.
export const SPAWN_MARGIN = 40;

// --- Directions --------------------------------------------------------------
// The 8 rotation directions the pixel art ships, in a stable order.
export const DIRECTIONS = [
  "south",
  "south-west",
  "west",
  "north-west",
  "north",
  "north-east",
  "east",
  "south-east",
] as const;

export type Direction = (typeof DIRECTIONS)[number];
export const DEFAULT_DIRECTION: Direction = "south";

/** Map a movement vector (screen space, +y down) to one of 8 directions. */
export function vectorToDirection(dx: number, dy: number): Direction | null {
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return null;
  // Flip y so "up" is +90deg; atan2 gives degrees CCW from east.
  const angle = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
  const sectors: [number, Direction][] = [
    [0, "east"],
    [45, "north-east"],
    [90, "north"],
    [135, "north-west"],
    [180, "west"],
    [225, "south-west"],
    [270, "south"],
    [315, "south-east"],
  ];
  let best = sectors[0];
  let bestDelta = 360;
  for (const s of sectors) {
    const d = Math.min(Math.abs(angle - s[0]), 360 - Math.abs(angle - s[0]));
    if (d < bestDelta) {
      bestDelta = d;
      best = s;
    }
  }
  return best[1];
}

// --- Networking --------------------------------------------------------------
export const ROOM_NAME = "world";

/** Client → server: the player's desired movement for this frame. */
export interface InputMessage {
  ax: number; // -1..1 horizontal
  ay: number; // -1..1 vertical
  running: boolean;
  jump?: boolean; // edge-triggered: request a jump this input
  seq?: number; // client input sequence, for prediction/reconciliation
  // Duration this input was held (seconds). The server integrates EXACTLY
  // these durations (bounded by a real-time budget), so server and client run
  // identical math and stay in perfect agreement — no reconciliation jitter.
  dt?: number;
}

// Anti-cheat bounds for input-stream integration: a single input may not claim
// more than MAX_INPUT_DT, and a client can never accumulate more integration
// time than real time elapsed (+ a small burst allowance, INPUT_TIME_SLACK).
export const MAX_INPUT_DT = 0.1; // seconds
export const INPUT_TIME_SLACK = 0.25; // seconds of burst credit

export interface MoveResult {
  x: number;
  y: number;
  dir: Direction | null;
  moving: boolean;
}

// --- Screen-relative input on the isometric world ----------------------------
// The iso projection maps world (x,y) to screen ((x−y)·ISO_DX, (x+y)·ISO_DY),
// so a raw world-axis input renders as a diagonal slide. Controls should be
// SCREEN-relative: pressing Up moves the character straight up on screen.
// These constants are the projection ratio (client MAP_GEOMETRY uses the same).
export const ISO_DX = 32;
export const ISO_DY = 13;

// Screen-speed calibration: the returned world vector is scaled so the
// PROJECTED on-screen speed is identical in every direction (the projection
// compresses vertical by ISO_DY/ISO_DX ≈ 2.5×, so equal world speeds would
// look much faster horizontally). REF picks the overall feel: at REF = ISO_DX
// a walk covers ~ISO_DX·WALK_SPEED/…px/s in ANY screen direction — between the
// old horizontal (faster) and old vertical (slower) speeds.
const SCREEN_SPEED_REF = ISO_DX;

/** Convert a screen-space input vector (arrows as the player sees them) into a
 * world-space velocity direction, scaled for uniform on-screen speed. The
 * result's magnitude is the speed multiplier (not normalized to 1). */
export function screenToWorldVector(ix: number, iy: number): { x: number; y: number } {
  const wx = ix / ISO_DX + iy / ISO_DY;
  const wy = iy / ISO_DY - ix / ISO_DX;
  const len = Math.hypot(wx, wy);
  if (len < 1e-9) return { x: 0, y: 0 };
  const ux = wx / len;
  const uy = wy / len;
  // Projected screen-speed factor of this unit world vector.
  const screenLen = Math.hypot((ux - uy) * ISO_DX, (ux + uy) * ISO_DY);
  const k = SCREEN_SPEED_REF / screenLen;
  return { x: ux * k, y: uy * k };
}

/** Blocked test for a *move*: is entering (toX,toY) from (fromX,fromY) disallowed?
 * It takes the source too because traversal depends on the elevation step, not
 * just the destination cell. */
export type BlockedFn = (toX: number, toY: number, fromX: number, fromY: number) => boolean;

/** Drop test: is moving from (fromX,fromY) onto (toX,toY) a FALL (a downward
 * step too big to walk smoothly)? Used to commit the fall the moment the feet
 * touch a ledge edge, so sprites never rest overhanging the rim. */
export type DropFn = (toX: number, toY: number, fromX: number, fromY: number) => boolean;

/** Integrate one movement step. The SAME function runs on the server (each tick)
 * and on the client (prediction), so they stay in lockstep. `blocked` rejects a
 * move (resolved axis-separated so players slide along walls); `speedScale`
 * applies the current surface's walk-speed multiplier. With `screenInput` the
 * (ax,ay) vector is SCREEN-relative (what the player sees): facing comes from
 * the raw vector, physics from the iso-rotated world vector — pressing Up walks
 * straight up on screen. */
export function stepMovement(
  x: number,
  y: number,
  ax: number,
  ay: number,
  running: boolean,
  dt: number,
  blocked?: BlockedFn,
  speedScale = 1,
  screenInput = false,
  drops?: DropFn,
): MoveResult {
  const len = Math.hypot(ax, ay);
  if (len < 1e-6) return { x, y, dir: null, moving: false };
  const dir = vectorToDirection(ax / len, ay / len); // facing = what the player sees
  let nx: number;
  let ny: number;
  if (screenInput) {
    const w = screenToWorldVector(ax, ay);
    nx = w.x;
    ny = w.y;
  } else {
    nx = ax / len;
    ny = ay / len;
  }
  const speed = (running ? RUN_SPEED : WALK_SPEED) * speedScale;
  const tx = clamp(x + nx * speed * dt, SPAWN_MARGIN, WORLD_WIDTH - SPAWN_MARGIN);
  const ty = clamp(y + ny * speed * dt, SPAWN_MARGIN, WORLD_HEIGHT - SPAWN_MARGIN);
  let rx = x;
  let ry = y;
  // Resolve each axis independently: keep the X move if its destination is
  // enterable, then the Y move from the (possibly advanced) X — wall-sliding.
  // Collision probes the LEADING EDGE of the feet (PLAYER_RADIUS ahead), not
  // the centre point, so sprites stop before visually entering a tile block.
  // Symmetrically, when the leading edge reaches a DROP the fall is committed
  // (the anchor snaps past the rim) so feet never rest overhanging a ledge.
  const px = tx + Math.sign(tx - x) * PLAYER_RADIUS;
  if (!blocked || !blocked(px, y, x, y)) {
    rx = tx;
    if (drops && drops(px, y, tx, y)) {
      // Feet touched a drop edge → step off, landing a full foot-radius clear
      // of the cliff base so the sprite doesn't stand "in" the slope face.
      const fx = px + Math.sign(tx - x) * PLAYER_RADIUS;
      rx = !blocked || !blocked(fx, y, x, y) ? fx : px;
    }
  }
  const py = ty + Math.sign(ty - y) * PLAYER_RADIUS;
  if (!blocked || !blocked(rx, py, rx, y)) {
    ry = ty;
    if (drops && drops(rx, py, rx, ty)) {
      const fy = py + Math.sign(ty - y) * PLAYER_RADIUS;
      ry = !blocked || !blocked(rx, fy, rx, ty) ? fy : py;
    }
  }
  return { x: rx, y: ry, dir, moving: true };
}

// How far ahead of the feet the collision probe reaches (world units; a map
// cell is ~36). Bigger = stop further from walls; too big blocks 1-cell gaps.
export const PLAYER_RADIUS = 12;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// --- Terrain: surfaces + elevation -------------------------------------------
// Walkability is governed by ELEVATION (how big a step you can take), not tile
// category. A tile's category is a separate axis: its SURFACE controls walk
// speed, footstep sound, and whether it's solid ground or swimmable water.

export interface Surface {
  standable: boolean; // solid ground you can walk/stand on
  swimmable: boolean; // water you can swim across (costs stamina — see stepStamina)
  speed: number; // walk-speed multiplier on this surface
  sound: string; // footstep sound id (for the future audio system, #9)
  stairs?: boolean; // transition tile: crossing it lets you walk a full 1-level step
}

const ground = (speed: number, sound: string): Surface => ({
  standable: true,
  swimmable: false,
  speed,
  sound,
});
const solid: Surface = { standable: false, swimmable: false, speed: 1, sound: "" }; // structures

/** Per-category surface properties. Unknown categories fall back to DEFAULT
 * (plain walkable ground) so new tiles the maps/tiles agents add never wall
 * players in or crash — they just walk normally until tuned here.
 * Road categories are matched by prefix (road_*) — see surfaceFor. */
export const SURFACES: Record<string, Surface> = {
  // liquids / hazards
  water: { standable: false, swimmable: true, speed: 0.55, sound: "water" },
  lava: solid, // deadly later; impassable for now
  // ground by feel
  grass: ground(1.0, "grass"),
  meadow: ground(1.0, "grass"),
  flowers: ground(0.95, "grass"),
  forest: ground(0.8, "grass"),
  jungle: ground(0.75, "grass"),
  mushroom_grove: ground(0.9, "grass"),
  savanna: ground(0.95, "grass"),
  wheat_field: ground(0.85, "grass"),
  farm: ground(0.95, "dirt"),
  vineyard: ground(0.9, "dirt"),
  dirt: ground(0.95, "dirt"),
  clay: ground(0.9, "dirt"),
  gravel: ground(0.95, "stone"),
  stone: ground(1.0, "stone"),
  mosaic_floor: ground(1.1, "stone"),
  sand: ground(0.8, "sand"),
  sand_bank: ground(0.8, "sand"),
  coral_sand: ground(0.8, "sand"),
  desert: ground(0.75, "sand"),
  snow: ground(0.7, "snow"),
  cliff_snow: ground(0.7, "snow"),
  tundra: ground(0.8, "snow"),
  permafrost: ground(0.9, "snow"),
  ice: ground(1.15, "ice"),
  crystal_ground: ground(1.0, "stone"),
  bog: ground(0.55, "swamp"),
  swamp: ground(0.5, "swamp"),
  // transitions
  stairs: { ...ground(0.9, "stone"), stairs: true },
  // solid structures (trees, monuments, towers) — you walk around them
  pine_tree: solid,
  pine_tree_v2: solid,
  oak_tree: solid,
  oak_tree_v2: solid,
  autumn_forest: ground(0.8, "grass"),
  big_boulder: solid,
  crystal_spire: solid,
  obelisk: solid,
  obelisk_v2: solid,
  watchtower: solid,
  cactus: solid,
};
export const DEFAULT_SURFACE: Surface = ground(1.0, "grass");
const ROAD_SURFACE: Surface = ground(1.2, "stone");
const VOID_SURFACE: Surface = { standable: false, swimmable: false, speed: 1.0, sound: "" };

export function surfaceFor(t: string): Surface {
  const s = SURFACES[t];
  if (s) return s;
  if (t.startsWith("road_")) return ROAD_SURFACE; // road_snow_turns, road_sand_… etc.
  return DEFAULT_SURFACE;
}

/** True when the category has an explicit SURFACES entry (or is a road_*).
 * Unknown categories silently default to plain walkable ground — which also
 * makes the night shader treat them as TERRAIN (walls, face shadows) instead
 * of a solid OBJECT (art + soft cast shadow only). New tree/boulder-like
 * categories from the tiles agent MUST be added to SURFACES or their block
 * shadow will stick out past their art again. */
export function isKnownSurface(t: string): boolean {
  return t in SURFACES || t.startsWith("road_");
}

// Elevation traversal (design "Option 2B"): you can walk between cells within
// WALK_CLIMB of each other; crossing a full 1-level ledge needs a timed JUMP.
export const WALK_CLIMB = 0.5; // step you can walk up/down passively
export const JUMP_CLIMB = 1; // step you can cross while jumping
export const JUMP_MS = 500; // active jump window (climb allowance + hop visual)
export const JUMP_COOLDOWN_MS = 180; // after landing, before you can jump again
export const JUMP_SPEED_FACTOR = 0.6; // slower ground travel while airborne (taller, not farther)

// Swimming: entering water starts a stamina drain; at zero you drown.
export const MAX_STAMINA = 100;
export const SWIM_DRAIN = 20; // stamina per second while swimming
export const STAMINA_REGEN = 30; // stamina per second recovered on land

/** One map cell as the game consumes it (t = tile category, v = variant,
 * l = elevation level, r = region/climate tag). */
export interface WorldCell {
  t: string;
  v: number;
  l: number;
  r?: string;
}

export interface ParsedWorld {
  width: number;
  height: number;
  rows: WorldCell[][];
  pois: { x: number; y: number; label: string; tile?: string }[];
}

/**
 * Parse the maps agent's world.json into rows of cells. Supports both schemas:
 * - legacy: { width, height, rows: [[{t,v,l,r}, …], …] }
 * - pixel-maps/bigworld@1: { w, h, categories[], climates[], terr/variant/
 *   level/climate as h×w index arrays, pois[] }
 * Returns null for anything unrecognisable.
 */
export function parseWorld(json: any): ParsedWorld | null {
  if (!json) return null;
  if (Array.isArray(json.rows) && typeof json.width === "number") {
    cleanupRoads(json.width, json.height, json.rows);
    return { width: json.width, height: json.height, rows: json.rows, pois: json.pois ?? [] };
  }
  if (typeof json.w === "number" && Array.isArray(json.terr) && Array.isArray(json.categories)) {
    const cats: string[] = json.categories;
    const climates: string[] = json.climates ?? [];
    const rows: WorldCell[][] = [];
    for (let r = 0; r < json.h; r++) {
      const tr = json.terr[r];
      const vr = json.variant?.[r];
      const lr = json.level?.[r];
      const cr = json.climate?.[r];
      const row: WorldCell[] = [];
      for (let c = 0; c < json.w; c++) {
        row.push({
          t: cats[tr[c]] ?? "",
          v: vr?.[c] ?? 0,
          l: lr?.[c] ?? 0,
          r: climates[cr?.[c]] ?? undefined,
        });
      }
      rows.push(row);
    }
    cleanupRoads(json.w, json.h, rows);
    return { width: json.w, height: json.h, rows, pois: json.pois ?? [] };
  }
  return null;
}

/**
 * Cosmetic repair for the generator's road defects (also reported upstream to
 * the maps agent — this pass becomes a no-op once they ship clean roads):
 * 1. Orphan stubs (road components of ≤ STUB_MAX cells) are replaced with
 *    neighbouring ground so the map isn't littered with disconnected bits.
 * 2. Each road component is restyled to its MAJORITY style (e.g. all
 *    road_dirt_grass), so a single road doesn't flip styles back and forth.
 *    Restyles only use (category, variant) pairs that exist elsewhere in the
 *    map, so every referenced tile file is guaranteed to exist.
 * Runs inside parseWorld → server terrain and client render stay identical.
 */
const ROAD_STUB_MAX = 4;
// Ground categories whose tile art has path-like edging: scattered as 1-3
// cell noise specks by the generator they read as broken road fragments.
// Tiny isolated patches dissolve into surrounding ground; large regions stay.
const PATH_LOOK = new Set(["gravel", "clay", "dirt"]);
const PATCH_MAX = 3;

export function cleanupRoads(width: number, height: number, rows: WorldCell[][]): void {
  const isRoad = (t: string) => t.startsWith("road_");
  const styleOf = (t: string) => t.replace(/_(straight|turns|junctions)$/, "");
  const suffixOf = (t: string) => t.match(/_(straight|turns|junctions)$/)?.[1] ?? "straight";

  // Variants actually used per category anywhere in the map (=> files exist).
  const usedVariants = new Map<string, Set<number>>();
  for (const row of rows) {
    for (const cell of row) {
      let set = usedVariants.get(cell.t);
      if (!set) usedVariants.set(cell.t, (set = new Set()));
      set.add(cell.v);
    }
  }

  const seen = new Set<number>();
  const idx = (c: number, r: number) => r * width + c;
  for (let r0 = 0; r0 < height; r0++) {
    for (let c0 = 0; c0 < width; c0++) {
      if (!isRoad(rows[r0][c0].t) || seen.has(idx(c0, r0))) continue;
      // Flood-fill this road component (8-connected).
      const comp: [number, number][] = [];
      const stack: [number, number][] = [[c0, r0]];
      seen.add(idx(c0, r0));
      while (stack.length) {
        const [c, r] = stack.pop()!;
        comp.push([c, r]);
        for (let dc = -1; dc <= 1; dc++) {
          for (let dr = -1; dr <= 1; dr++) {
            const nc = c + dc;
            const nr = r + dr;
            if (nc < 0 || nr < 0 || nc >= width || nr >= height) continue;
            if (seen.has(idx(nc, nr)) || !isRoad(rows[nr][nc].t)) continue;
            seen.add(idx(nc, nr));
            stack.push([nc, nr]);
          }
        }
      }
      if (comp.length <= ROAD_STUB_MAX) {
        // Orphan stub: dissolve into the surrounding ground.
        for (const [c, r] of comp) {
          let filler: WorldCell | null = null;
          for (const [dc, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
            const nb = rows[r + dr]?.[c + dc];
            if (nb && !isRoad(nb.t) && surfaceFor(nb.t).standable) {
              filler = nb;
              break;
            }
          }
          const cell = rows[r][c];
          cell.t = filler?.t ?? "grass";
          cell.v = filler?.v ?? 0;
        }
        continue;
      }
      // Majority style for the component; restyle minority cells where the
      // target (category, variant) demonstrably exists in the map.
      const tally = new Map<string, number>();
      for (const [c, r] of comp) {
        const s = styleOf(rows[r][c].t);
        tally.set(s, (tally.get(s) ?? 0) + 1);
      }
      const major = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
      for (const [c, r] of comp) {
        const cell = rows[r][c];
        if (styleOf(cell.t) === major) continue;
        const target = `${major}_${suffixOf(cell.t)}`;
        const variants = usedVariants.get(target) ?? usedVariants.get(`${major}_straight`);
        const targetCat = usedVariants.has(target) ? target : `${major}_straight`;
        if (!variants || variants.size === 0) continue; // style lacks tiles: keep as-is
        cell.t = targetCat;
        if (!variants.has(cell.v)) cell.v = variants.values().next().value!;
      }
    }
  }

  // Second pass: dissolve tiny isolated PATH_LOOK specks (gravel/clay/dirt
  // noise the generator scatters) into the surrounding ground — they read as
  // broken road fragments. Large regions (fields, shores) are kept.
  const pseen = new Set<number>();
  for (let r0 = 0; r0 < height; r0++) {
    for (let c0 = 0; c0 < width; c0++) {
      if (!PATH_LOOK.has(rows[r0][c0].t) || pseen.has(idx(c0, r0))) continue;
      const comp: [number, number][] = [];
      const stack: [number, number][] = [[c0, r0]];
      pseen.add(idx(c0, r0));
      while (stack.length) {
        const [c, r] = stack.pop()!;
        comp.push([c, r]);
        for (let dc = -1; dc <= 1; dc++) {
          for (let dr = -1; dr <= 1; dr++) {
            const nc = c + dc;
            const nr = r + dr;
            if (nc < 0 || nr < 0 || nc >= width || nr >= height) continue;
            if (pseen.has(idx(nc, nr)) || !PATH_LOOK.has(rows[nr][nc].t)) continue;
            pseen.add(idx(nc, nr));
            stack.push([nc, nr]);
          }
        }
      }
      if (comp.length > PATCH_MAX) continue;
      for (const [c, r] of comp) {
        let filler: WorldCell | null = null;
        for (const [dc, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1]] as const) {
          const nb = rows[r + dr]?.[c + dc];
          if (nb && !PATH_LOOK.has(nb.t) && !nb.t.startsWith("road_") && surfaceFor(nb.t).standable) {
            filler = nb;
            break;
          }
        }
        if (filler) {
          rows[r][c].t = filler.t;
          rows[r][c].v = filler.v;
        }
      }
    }
  }
}

/** Per-cell elevation + tile category over the world grid (row-major). */
export interface TerrainGrid {
  width: number;
  height: number;
  level: number[];
  type: string[];
}

export function buildTerrainGrid(
  width: number,
  height: number,
  rows: { t: string; l?: number }[][],
): TerrainGrid {
  const level: number[] = new Array(width * height).fill(0);
  const type: string[] = new Array(width * height).fill("");
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const cell = rows[r]?.[c];
      const i = r * width + c;
      level[i] = cell?.l ?? 0;
      type[i] = cell?.t ?? "";
    }
  }
  return { width, height, level, type };
}

function cellIndex(grid: TerrainGrid, x: number, y: number): number {
  const col = Math.floor((x / WORLD_WIDTH) * grid.width);
  const row = Math.floor((y / WORLD_HEIGHT) * grid.height);
  if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) return -1;
  return row * grid.width + col;
}

export function surfaceAtWorld(grid: TerrainGrid, x: number, y: number): Surface {
  const i = cellIndex(grid, x, y);
  if (i < 0) return VOID_SURFACE;
  const t = grid.type[i];
  return t ? surfaceFor(t) : VOID_SURFACE;
}

export function levelAtWorld(grid: TerrainGrid, x: number, y: number): number {
  const i = cellIndex(grid, x, y);
  return i < 0 ? 0 : grid.level[i];
}

export function isStandableAtWorld(grid: TerrainGrid, x: number, y: number): boolean {
  return surfaceAtWorld(grid, x, y).standable;
}

/** State that gates a move: how high the player may step, and whether they may
 * enter water (i.e. start swimming). */
export interface MoveContext {
  maxClimb: number; // WALK_CLIMB normally, JUMP_CLIMB while jumping
  canSwim: boolean; // may enter swimmable water
}

/** Can the player move from (fromX,fromY) onto (toX,toY)? The destination must
 * be enterable (solid ground, or water when swimming is allowed) and an UPWARD
 * elevation step must be within `maxClimb`. Dropping down is always allowed —
 * gravity is free; only climbing needs a jump. */
export function canEnter(
  grid: TerrainGrid,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  ctx: MoveContext,
): boolean {
  const to = surfaceAtWorld(grid, toX, toY);
  const enterable = to.standable || (to.swimmable && ctx.canSwim);
  if (!enterable) return false;
  const dl = levelAtWorld(grid, toX, toY) - levelAtWorld(grid, fromX, fromY);
  // Stairs act as ramps: stepping onto or off a stairs tile allows a full
  // 1-level climb without jumping.
  const from = surfaceAtWorld(grid, fromX, fromY);
  const maxClimb = from.stairs || to.stairs ? Math.max(ctx.maxClimb, 1) : ctx.maxClimb;
  return dl <= maxClimb + 1e-9;
}

/** Adapt canEnter into stepMovement's blocked() predicate for a given context. */
export function makeBlocked(grid: TerrainGrid, ctx: MoveContext): BlockedFn {
  return (toX, toY, fromX, fromY) => !canEnter(grid, fromX, fromY, toX, toY, ctx);
}

/** Drop predicate for stepMovement: a downward step bigger than what walking
 * handles smoothly (stairs make a 1-level descent a normal walk, not a fall). */
export function makeDrops(grid: TerrainGrid): DropFn {
  return (toX, toY, fromX, fromY) => {
    const to = surfaceAtWorld(grid, toX, toY);
    if (!to.standable && !to.swimmable) return false; // solid: not a fall, a wall
    const from = surfaceAtWorld(grid, fromX, fromY);
    const smooth = from.stairs || to.stairs ? 1 : WALK_CLIMB;
    const dl = levelAtWorld(grid, toX, toY) - levelAtWorld(grid, fromX, fromY);
    return dl < -(smooth + 1e-9);
  };
}

/**
 * Advance a player's swim stamina one tick. Draining while swimming; recovering
 * on land. `drowned` is true the moment it hits zero in water.
 */
export function stepStamina(
  stamina: number,
  swimming: boolean,
  dt: number,
): { stamina: number; drowned: boolean } {
  if (swimming) {
    const s = stamina - SWIM_DRAIN * dt;
    if (s <= 0) return { stamina: 0, drowned: true };
    return { stamina: s, drowned: false };
  }
  return { stamina: Math.min(MAX_STAMINA, stamina + STAMINA_REGEN * dt), drowned: false };
}

/** World coordinates of a map cell's centre. */
export function cellCenterWorld(grid: TerrainGrid, col: number, row: number): { x: number; y: number } {
  return {
    x: ((col + 0.5) / grid.width) * WORLD_WIDTH,
    y: ((row + 0.5) / grid.height) * WORLD_HEIGHT,
  };
}

function cellStandable(grid: TerrainGrid, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) return false;
  const t = grid.type[row * grid.width + col];
  return t ? surfaceFor(t).standable : false;
}

/** A spawn cell is good if it and its whole 3×3 neighbourhood are standable and
 * walkably close in elevation (so a newcomer can actually move off it). */
function spawnCellOk(grid: TerrainGrid, col: number, row: number): boolean {
  if (!cellStandable(grid, col, row)) return false;
  const l0 = grid.level[row * grid.width + col];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const c = col + dc;
      const r = row + dr;
      if (!cellStandable(grid, c, r)) return false;
      if (Math.abs(grid.level[r * grid.width + c] - l0) > WALK_CLIMB) return false;
    }
  }
  return true;
}

/**
 * Pick a spawn point: the standable cell nearest a preferred spot (world centre
 * by default) with an open, walkable 3×3 around it. Falls back to any standable
 * cell, then the preferred point.
 */
export function findSpawn(
  grid: TerrainGrid,
  prefX: number = WORLD_WIDTH / 2,
  prefY: number = WORLD_HEIGHT / 2,
): { x: number; y: number } {
  const c0 = clamp(Math.floor((prefX / WORLD_WIDTH) * grid.width), 0, grid.width - 1);
  const r0 = clamp(Math.floor((prefY / WORLD_HEIGHT) * grid.height), 0, grid.height - 1);
  const maxRad = grid.width + grid.height;
  let firstStandable: { col: number; row: number } | null = null;
  for (let rad = 0; rad <= maxRad; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue; // ring only
        const c = c0 + dc;
        const r = r0 + dr;
        if (!cellStandable(grid, c, r)) continue;
        if (!firstStandable) firstStandable = { col: c, row: r };
        if (spawnCellOk(grid, c, r)) return cellCenterWorld(grid, c, r);
      }
    }
  }
  if (firstStandable) return cellCenterWorld(grid, firstStandable.col, firstStandable.row);
  return { x: prefX, y: prefY };
}

/** Options sent by the client when joining the world room. */
export interface JoinOptions {
  name?: string;
  character?: string; // character uid from the pixel catalog
  token?: string; // opaque per-player id for persistence (from localStorage)
}

// --- Chat --------------------------------------------------------------------
export const MAX_CHAT_LEN = 140;
export const CHAT_MIN_INTERVAL_MS = 500; // per-player rate limit

/** Client → server: a chat line. */
export interface ChatInput {
  text: string;
}

/** Server → clients: a broadcast chat line. */
export interface ChatBroadcast {
  id: string; // sender sessionId
  name: string;
  text: string;
}

/** Trim, collapse ASCII control chars to spaces, and clamp a chat message. */
export function sanitizeChat(text: unknown): string {
  if (typeof text !== "string") return "";
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.trim().slice(0, MAX_CHAT_LEN);
}
