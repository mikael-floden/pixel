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

/** Integrate one movement step. The SAME function runs on the server (each tick)
 * and on the client (prediction), so they stay in lockstep. */
export function stepMovement(
  x: number,
  y: number,
  ax: number,
  ay: number,
  running: boolean,
  dt: number,
): MoveResult {
  const len = Math.hypot(ax, ay);
  if (len < 1e-6) return { x, y, dir: null, moving: false };
  const nx = ax / len;
  const ny = ay / len;
  const speed = running ? RUN_SPEED : WALK_SPEED;
  const cx = clamp(x + nx * speed * dt, SPAWN_MARGIN, WORLD_WIDTH - SPAWN_MARGIN);
  const cy = clamp(y + ny * speed * dt, SPAWN_MARGIN, WORLD_HEIGHT - SPAWN_MARGIN);
  return { x: cx, y: cy, dir: vectorToDirection(nx, ny), moving: true };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
