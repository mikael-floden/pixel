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
  seq?: number; // client input sequence, for prediction/reconciliation
}

export interface MoveResult {
  x: number;
  y: number;
  dir: Direction | null;
  moving: boolean;
}

/** A test for whether a world position is impassable (e.g. water, a wall). */
export type BlockedFn = (x: number, y: number) => boolean;

/** Integrate one movement step. The SAME function runs on the server (each tick)
 * and on the client (prediction), so they stay in lockstep. When `blocked` is
 * given, movement is resolved axis-separated so players slide along walls
 * instead of sticking to them. */
export function stepMovement(
  x: number,
  y: number,
  ax: number,
  ay: number,
  running: boolean,
  dt: number,
  blocked?: BlockedFn,
): MoveResult {
  const len = Math.hypot(ax, ay);
  if (len < 1e-6) return { x, y, dir: null, moving: false };
  const nx = ax / len;
  const ny = ay / len;
  const speed = running ? RUN_SPEED : WALK_SPEED;
  const tx = clamp(x + nx * speed * dt, SPAWN_MARGIN, WORLD_WIDTH - SPAWN_MARGIN);
  const ty = clamp(y + ny * speed * dt, SPAWN_MARGIN, WORLD_HEIGHT - SPAWN_MARGIN);
  let rx = x;
  let ry = y;
  // Resolve each axis independently: keep the X move if its destination is free,
  // then the Y move from the (possibly advanced) X — this yields wall-sliding.
  if (!blocked || !blocked(tx, ry)) rx = tx;
  if (!blocked || !blocked(rx, ty)) ry = ty;
  return { x: rx, y: ry, dir: vectorToDirection(nx, ny), moving: true };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// --- Terrain / collision -----------------------------------------------------
// Walkability comes from the maps agent's world grid (maps/world/world.json).
// We block by tile CATEGORY, defaulting unknown categories to walkable so new
// ground tiles the maps/tiles agents add don't accidentally wall players in.
export const BLOCKED_TERRAIN: ReadonlySet<string> = new Set(["water", "castle"]);

export function isWalkableTerrain(t: string): boolean {
  return !BLOCKED_TERRAIN.has(t);
}

/** A row-major blocked/free grid over the world, one flag per map cell. */
export interface TerrainGrid {
  width: number;
  height: number;
  blocked: boolean[];
}

/** Build a collision grid from the maps agent's world rows (cells carry `t`). */
export function buildTerrainGrid(
  width: number,
  height: number,
  rows: { t: string }[][],
): TerrainGrid {
  const blocked: boolean[] = new Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const cell = rows[r]?.[c];
      blocked[r * width + c] = cell ? !isWalkableTerrain(cell.t) : true;
    }
  }
  return { width, height, blocked };
}

/** True if the world position falls on a blocked cell (or outside the map). */
export function isBlockedAtWorld(grid: TerrainGrid, x: number, y: number): boolean {
  const col = Math.floor((x / WORLD_WIDTH) * grid.width);
  const row = Math.floor((y / WORLD_HEIGHT) * grid.height);
  if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) return true;
  return grid.blocked[row * grid.width + col];
}

export function makeBlocked(grid: TerrainGrid): BlockedFn {
  return (x, y) => isBlockedAtWorld(grid, x, y);
}

/** World coordinates of a map cell's centre. */
export function cellCenterWorld(grid: TerrainGrid, col: number, row: number): { x: number; y: number } {
  return {
    x: ((col + 0.5) / grid.width) * WORLD_WIDTH,
    y: ((row + 0.5) / grid.height) * WORLD_HEIGHT,
  };
}

function neighborhoodOpen(grid: TerrainGrid, col: number, row: number): boolean {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= grid.width || r >= grid.height) return false;
      if (grid.blocked[r * grid.width + c]) return false;
    }
  }
  return true;
}

/**
 * Pick a spawn point: the walkable cell nearest a preferred spot (world centre
 * by default) whose 3×3 neighbourhood is also walkable, so newcomers have room
 * to move in any direction. Falls back to any walkable cell, then the pref.
 */
export function findSpawn(
  grid: TerrainGrid,
  prefX: number = WORLD_WIDTH / 2,
  prefY: number = WORLD_HEIGHT / 2,
): { x: number; y: number } {
  const c0 = clamp(Math.floor((prefX / WORLD_WIDTH) * grid.width), 0, grid.width - 1);
  const r0 = clamp(Math.floor((prefY / WORLD_HEIGHT) * grid.height), 0, grid.height - 1);
  const maxRad = grid.width + grid.height;
  let firstWalkable: { col: number; row: number } | null = null;
  for (let rad = 0; rad <= maxRad; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue; // ring only
        const c = c0 + dc;
        const r = r0 + dr;
        if (c < 0 || r < 0 || c >= grid.width || r >= grid.height) continue;
        if (grid.blocked[r * grid.width + c]) continue;
        if (!firstWalkable) firstWalkable = { col: c, row: r };
        if (neighborhoodOpen(grid, c, r)) return cellCenterWorld(grid, c, r);
      }
    }
  }
  if (firstWalkable) return cellCenterWorld(grid, firstWalkable.col, firstWalkable.row);
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
