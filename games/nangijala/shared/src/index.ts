/**
 * Shared constants + pure helpers used by BOTH the authoritative server and the
 * browser client, so movement/direction logic can never drift between them.
 */

// --- World -------------------------------------------------------------------
export const WORLD_WIDTH = 1600;
export const WORLD_HEIGHT = 1600;

// Movement speeds in world units per second.
export const WALK_SPEED = 140;
export const RUN_SPEED = 250;

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
}

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

/** Convert a screen-space input vector (arrows as the player sees them) into
 * the world-space direction that produces that on-screen movement. */
export function screenToWorldVector(ix: number, iy: number): { x: number; y: number } {
  const wx = ix / ISO_DX + iy / ISO_DY;
  const wy = iy / ISO_DY - ix / ISO_DX;
  const len = Math.hypot(wx, wy);
  if (len < 1e-9) return { x: 0, y: 0 };
  return { x: wx / len, y: wy / len };
}

/** Blocked test for a *move*: is entering (toX,toY) from (fromX,fromY) disallowed?
 * It takes the source too because traversal depends on the elevation step, not
 * just the destination cell. */
export type BlockedFn = (toX: number, toY: number, fromX: number, fromY: number) => boolean;

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
  if (!blocked || !blocked(tx, y, x, y)) rx = tx;
  if (!blocked || !blocked(rx, ty, rx, y)) ry = ty;
  return { x: rx, y: ry, dir, moving: true };
}

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
}

/** Per-category surface properties. Unknown categories fall back to DEFAULT
 * (plain walkable ground) so new tiles the maps/tiles agents add never wall
 * players in or crash — they just walk normally until tuned here. */
export const SURFACES: Record<string, Surface> = {
  grass: { standable: true, swimmable: false, speed: 1.0, sound: "grass" },
  sand: { standable: true, swimmable: false, speed: 0.8, sound: "sand" },
  stone: { standable: true, swimmable: false, speed: 1.0, sound: "stone" },
  cobblestone: { standable: true, swimmable: false, speed: 1.05, sound: "stone" },
  brick_road: { standable: true, swimmable: false, speed: 1.2, sound: "stone" },
  castle: { standable: true, swimmable: false, speed: 1.0, sound: "stone" },
  snow: { standable: true, swimmable: false, speed: 0.65, sound: "snow" },
  water: { standable: false, swimmable: true, speed: 0.55, sound: "water" },
};
export const DEFAULT_SURFACE: Surface = { standable: true, swimmable: false, speed: 1.0, sound: "grass" };
const VOID_SURFACE: Surface = { standable: false, swimmable: false, speed: 1.0, sound: "" };

export function surfaceFor(t: string): Surface {
  return SURFACES[t] ?? DEFAULT_SURFACE;
}

// Elevation traversal (design "Option 2B"): you can walk between cells within
// WALK_CLIMB of each other; crossing a full 1-level ledge needs a timed JUMP.
export const WALK_CLIMB = 0.5; // step you can walk up/down passively
export const JUMP_CLIMB = 1; // step you can cross while jumping
export const JUMP_MS = 420; // active jump window (climb allowance + hop visual)
export const JUMP_COOLDOWN_MS = 180; // after landing, before you can jump again

// Swimming: entering water starts a stamina drain; at zero you drown.
export const MAX_STAMINA = 100;
export const SWIM_DRAIN = 20; // stamina per second while swimming
export const STAMINA_REGEN = 30; // stamina per second recovered on land

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
 * be enterable (solid ground, or water when swimming is allowed) and the
 * elevation step must be within `maxClimb`. */
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
  return Math.abs(dl) <= ctx.maxClimb + 1e-9;
}

/** Adapt canEnter into stepMovement's blocked() predicate for a given context. */
export function makeBlocked(grid: TerrainGrid, ctx: MoveContext): BlockedFn {
  return (toX, toY, fromX, fromY) => !canEnter(grid, fromX, fromY, toX, toY, ctx);
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
