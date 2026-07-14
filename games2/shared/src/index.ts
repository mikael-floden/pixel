/**
 * Shared constants + pure helpers used by BOTH the authoritative server and the
 * browser client, so movement/direction logic can never drift between them.
 */

// --- World -------------------------------------------------------------------
// World units: a FIXED 32 per map cell (CELL_WU). A world's extent is therefore
// grid×CELL_WU — derived per-world (worldWidthOf/worldHeightOf), NOT a global
// constant. Every grid↔world conversion (surfaceAtWorld, findSpawn, the client's
// project()) divides by CELL_WU, so worlds of any dimensions render + collide
// correctly and the server can host several differently-sized worlds at once.
// WORLD_WIDTH/HEIGHT survive only as the DEFAULT extent for the open-world
// fallback (no map loaded) and the movement tests — a nominal 160×160.
export const CELL_WU = 32;
export const WORLD_GRID = 160;
export const WORLD_WIDTH = WORLD_GRID * CELL_WU;
export const WORLD_HEIGHT = WORLD_GRID * CELL_WU;

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
// The EMISSION DEMO room: a real Colyseus room on a generated station world —
// the demo runs the full game (renderer, movement, night pipeline) so what
// the maintainer tests there IS what the game does.
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
// maps2/tiles2 geometry: top diamond 30px tall × 64px wide, grid steps DX=32,
// DY=15; one elevation level = 16px of vertical face (tiles2/docs/ELEVATION.md).
export const ISO_DX = 32;
export const ISO_DY = 15;
// Vertical face pixels per elevation level (maps2 LEVEL_PX).
export const LEVEL_PX = 16;
// Top-diamond height in px (apex→bottom); tiles2 top is 30px on a 64px tile.
export const DIAMOND_H = 30;

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
  let ux = wx / len;
  let uy = wy / len;
  // Grid-axis lock: a DIAGONAL press (both a horizontal AND a vertical key) is
  // meant to run straight ALONG a tile row/column — on the iso screen the two
  // grid axes ARE the diagonals (down-left/up-right = one axis, down-right/
  // up-left = the other). A raw screen-45° vector drifts a few degrees off that
  // line, so a bridge/corridor slowly slips sideways. Snap the world direction
  // to the nearest grid axis so those runs track true. Single-key presses are
  // untouched — they keep their screen-cardinal (up/down/left/right) move.
  if (ix !== 0 && iy !== 0) {
    if (Math.abs(ux) >= Math.abs(uy)) {
      ux = Math.sign(ux);
      uy = 0;
    } else {
      ux = 0;
      uy = Math.sign(uy);
    }
  }
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
  // The world's extent in world units (grid×CELL_WU). Defaults to the legacy
  // constant so tests + the open-world fallback keep working; the server and
  // client pass the LOADED world's size so any-sized worlds stay in bounds.
  worldW: number = WORLD_WIDTH,
  worldH: number = WORLD_HEIGHT,
  // Softer predicate for the LATERAL corner probes (see below). Defaults to
  // `blocked`; real callers pass makeSideBlocked so elevation walls beside
  // the path can't wedge a player who just descended a cliff.
  sideBlocked?: BlockedFn,
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
  const stepX = nx * speed * dt;
  const stepY = ny * speed * dt;
  let rx = x;
  let ry = y;
  // Resolve each axis independently: keep the X move if its destination is
  // enterable, then the Y move from the (possibly advanced) X — wall-sliding.
  // Collision probes the LEADING EDGE of the feet (PLAYER_RADIUS ahead), not
  // the centre point, so sprites stop before visually entering a tile block.
  // Each axis probes its leading edge at BOTH lateral corners: a single
  // centre probe let the mover slide ALONG a block's boundary and park with
  // its centre exactly on the edge — half the sprite visually inside the
  // block ("the bottom layer has no collision", playtester at a demo column).
  //
  // Dropping DOWN a ledge is intentionally NOT special-cased here: the mover
  // just walks onto the lower cell (canEnter always permits a descent). Feet
  // can therefore rest right at — or a hair past — the rim (the body billboard
  // overhangs the edge), and the visual FALL to the lower ground is animated
  // client-side (WorldScene) instead of teleporting the anchor past the rim.
  // Probe layout per axis: the forward CENTRE probe applies the FULL rule
  // (elevation climb + solids) — you can never walk head-on into a cliff
  // face or a prop. The LATERAL corner probes apply the softer `sideBlocked`
  // rule (real callers: solids only). An elevation wall BESIDE the path must
  // not veto a parallel or escaping move: a player who had just descended a
  // cliff stood within probe reach of BOTH faces of any inside corner, so
  // every axis was rejected and they were wedged in place — the "stuck after
  // walking downhill near a corner" bug. Solid props still block from every
  // side (no sideways clipping into trees/boulders).
  // (Bodies that somehow end up INSIDE a solid's margin are freed by
  // unstickFromSolids — applied by the server tick and client prediction
  // before each input integration — never by weakening these probes: an
  // earlier "escape-permissive" variant effectively disabled lateral prop
  // collision for normal-sized steps and let bodies drift into props.)
  const SIDE = PLAYER_RADIUS * 0.75;
  const sideB = sideBlocked ?? blocked;
  // Integrate in SUBSTEPS so one big-dt input (a laggy phone frame, a 100ms
  // server input) behaves exactly like several small ones. The probes refuse
  // an axis when its LEADING EDGE at the step's END is blocked — correct for
  // 60fps-sized steps, but a single 100ms RUN step reaches ~30wu ahead and
  // refused the WHOLE move, freezing the body far from the wall (where
  // short-step probes — the autopilot's openness checks, the next walk tick —
  // see nothing blocked at all: a deadlock of disagreeing probes). Substeps
  // advance to natural contact distance no matter the dt.
  const SUBSTEP = 4; // wu — finer than any real per-frame step
  const n = Math.max(
    1,
    Math.min(16, Math.ceil(Math.max(Math.abs(stepX), Math.abs(stepY)) / SUBSTEP)),
  );
  let freeX = true;
  let freeY = true;
  for (let i = 0; i < n; i++) {
    const fx = rx;
    const fy = ry;
    const tx = clamp(rx + stepX / n, SPAWN_MARGIN, worldW - SPAWN_MARGIN);
    const ty = clamp(ry + stepY / n, SPAWN_MARGIN, worldH - SPAWN_MARGIN);
    const px = tx + Math.sign(tx - rx) * PLAYER_RADIUS;
    const blockedX =
      blocked && (blocked(px, ry, rx, ry) || sideB!(px, ry - SIDE, rx, ry) || sideB!(px, ry + SIDE, rx, ry));
    if (!blockedX) rx = tx;
    else freeX = false;
    const py = ty + Math.sign(ty - ry) * PLAYER_RADIUS;
    const blockedY =
      blocked && (blocked(rx, py, rx, ry) || sideB!(rx - SIDE, py, rx, ry) || sideB!(rx + SIDE, py, rx, ry));
    if (!blockedY) ry = ty;
    else freeY = false;
    if (rx === fx && ry === fy) break; // both axes refused — no further substep differs
  }
  // Never-blocked axes land on the EXACT single-step endpoint (n accumulated
  // fractions drift a few ulps — callers assert exact distances).
  if (freeX) rx = clamp(x + stepX, SPAWN_MARGIN, worldW - SPAWN_MARGIN);
  if (freeY) ry = clamp(y + stepY, SPAWN_MARGIN, worldH - SPAWN_MARGIN);
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
  crystal_spire_v2: solid, // world-unused today; classified for night lighting
  ice_spire: solid,
  ice_spire_v2: solid,
  cliff_lava: solid, // freestanding maintainer test placement near spawn
  cliff_crystal_v2: solid, // dito — the "long" (base 120) tall profile
  cliff_gold: solid, // dito — emissive tall solid (glow-copy QA)
  // World-unused but EMISSIVE, so the demo world instantiates them (an
  // unclassified category defaults to walkable ground: no collision and the
  // player renders on top — demo stations 1-12/37-48). Same art profiles as
  // their classified siblings: tall pillars / one-level basalt-lava blocks.
  cliff_crystal: solid,
  cliff_gold_v2: solid,
  lava_ledge: solid,
  lava_ledge_v2: solid,
  obelisk: solid,
  obelisk_v2: solid,
  watchtower: solid,
  cactus: solid,
  // tiles2 materials (maps2 worlds) — terrain the player stands on (elevation
  // drives walls, not solidity); clear_water is swimmable like `water`.
  clear_water: { standable: false, swimmable: true, speed: 0.55, sound: "water" },
  saturated_grass: ground(1.0, "grass"),
  regular_snow: ground(0.7, "snow"),
  light_sand: ground(0.8, "sand"),
  lightdark_dirt: ground(0.95, "dirt"),
  stone_mountain: ground(1.0, "stone"),
  black_mountain: ground(1.0, "stone"),
  crystal_ice: ground(1.15, "ice"),
  wooden_balcony: ground(1.0, "wood"),
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

// --- Cliff falls (client visual; elevation in px) -----------------------------
// Stepping DOWN a ledge is a gravity fall, not a teleport. The client renderer
// keeps an elevation lift (px) per avatar and integrates it toward the cell's
// level each frame; this pure step encodes the feel so it can be unit-tested.
export const FALL_GRAVITY = 1400; // px/s²: a 1-level (≈16px) drop lands in ~0.15s
export const FALL_TRIGGER_FRAC = 0.75; // down-steps beyond this × level height fall
export const STEP_EASE_RATE = 14; // gentle down-steps (stairs) ease at this rate

export interface FallState {
  elev: number; // current elevation lift in px
  fallV: number; // downward velocity (px/s), only while falling
  falling: boolean;
}

/**
 * Integrate an avatar's elevation lift one frame toward `target` (cell level ×
 * level-height px). Rules, matched to `makeDrops`:
 *  • stepping UP (or level) snaps — the jump hop already sells the up arc, and
 *    easing up would sink the sprite into the step;
 *  • a gentle down-step (≤ FALL_TRIGGER_FRAC of a level: stairs/ramps) eases
 *    smoothly;
 *  • a real CLIFF down-step falls under gravity until it reaches the ground.
 * Pure (no scene state) so the fall feel is deterministic + unit-tested.
 */
export function integrateFall(s: FallState, target: number, dt: number, lh: number): FallState {
  const trigger = lh * FALL_TRIGGER_FRAC;
  const diff = target - s.elev; // + up, − down
  if (diff >= -0.01) return { elev: target, fallV: 0, falling: false };
  if (-diff <= trigger && !s.falling) {
    let elev = s.elev + diff * Math.min(1, dt * STEP_EASE_RATE);
    if (elev - target < 0.5) elev = target;
    return { elev, fallV: 0, falling: false };
  }
  const fallV = s.fallV + FALL_GRAVITY * dt;
  const elev = s.elev - fallV * dt;
  if (elev <= target) return { elev: target, fallV: 0, falling: false };
  return { elev, fallV, falling: true };
}

// Swimming: entering water starts a stamina drain; at zero you drown.
export const MAX_STAMINA = 100;
export const SWIM_DRAIN = 20; // stamina per second while swimming
export const STAMINA_REGEN = 30; // stamina per second recovered on land

/** One map cell as the game consumes it (t = tile category/material,
 * v = variant, l = elevation level, r = region/climate tag).
 * `path` (maps2/ringworld@1) is the EXACT top-surface tile PNG for this cell
 * (repo-relative, e.g. "tiles2/saturated_grass/base/base_123/tile_04.png") —
 * the maps2 world bakes the chosen tile per cell instead of a category+variant
 * the game looks up. When present the renderer uses it directly. */
export interface WorldCell {
  t: string;
  v: number;
  l: number;
  r?: string;
  path?: string;
  // maps2 world@1: draw this cell's tile HORIZONTALLY FLIPPED. The auto-tiler
  // places some transition tiles as mirrors; without honouring it, those tiles
  // face the wrong way at material borders.
  flip?: boolean;
}

export interface ParsedWorld {
  width: number;
  height: number;
  rows: WorldCell[][];
  pois: { x: number; y: number; label: string; tile?: string }[];
  /** Player spawn cell (col,row), if the world specifies one (maps2). */
  spawn?: [number, number];
  /** maps2: per-material canonical PLAIN base tile PNG, used for cliff faces
   * (the stacked part below a cell's top surface) — matches maps2 render2.py
   * which draws faces with the material's plain tile so terraces read as one
   * wall, not a patchwork of the top's transition tiles. */
  faceTiles?: Record<string, string>;
  /** maps2 world@1: decorative objects placed on cells (grass tufts, rocks,
   * …). Each is a TALL 64×128 tile PNG standing on its cell's ground. */
  props?: WorldProp[];
}

/** A placed decoration: its cell (col,row) + tall (64×128) tile PNG path. */
export interface WorldProp {
  col: number;
  row: number;
  path: string;
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
  // maps2 / ringworld@1: 2D `top` (index into `paths`, -1 = void), `level`
  // and `mat` (index into `matids`) grids; the world bakes the exact top tile
  // per cell. Faces use the material's plain base tile (see faceTiles).
  if (typeof json.schema === "string" && json.schema.startsWith("pixel-maps2/") &&
      Array.isArray(json.top) && Array.isArray(json.paths)) {
    return parseRingworld(json);
  }
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

/** Parse a maps2 world (schema pixel-maps2/world@1, and the older ringworld@1)
 * into the shared ParsedWorld model. world@1 changed a few things: it carries a
 * `size` {w,h} so worlds can be NON-SQUARE, ships materials as an id→name ARRAY
 * (was a `matids` name→id map), and puts `spawn` at the top level (was
 * `meta.spawn`). Cells still bake explicit tile PNG paths in `top`.
 *
 * We read `mat`/`level`/`top`/`mirror`/`spawn`/`size`. We deliberately IGNORE
 * the world's `collision` field: walkability is the GAME ENGINE's job, derived
 * from elevation (level steps) + SURFACES (per-material standable/swimmable) —
 * see buildTerrainGrid/canEnter. The maps agent owns world DATA; the engine owns
 * what it MEANS for movement. `props`/`geometry`/`water` aren't consumed yet. */
function parseRingworld(json: any): ParsedWorld {
  const top: number[][] = json.top;
  const level: number[][] = json.level ?? [];
  const mat: number[][] = json.mat ?? [];
  const paths: string[] = json.paths ?? [];
  const mirror: number[][] = json.mirror ?? [];
  // Non-square worlds: prefer the explicit size; fall back to the grid shape.
  const height = json.size?.h ?? top.length;
  const width = json.size?.w ?? top[0]?.length ?? height;
  // Material id → name. world@1 = `materials` array (index is the id);
  // ringworld@1 = `matids` name→id map.
  let idToMat: string[] = [];
  if (Array.isArray(json.materials)) {
    idToMat = json.materials as string[];
  } else {
    for (const [name, id] of Object.entries(json.matids ?? {})) idToMat[id as number] = name;
  }
  const rows: WorldCell[][] = [];
  const faceTiles: Record<string, string> = {};
  for (let r = 0; r < height; r++) {
    const row: WorldCell[] = [];
    for (let c = 0; c < width; c++) {
      const m = idToMat[mat[r]?.[c] ?? 0] ?? "";
      const ti = top[r]?.[c] ?? -1;
      const path = ti >= 0 ? paths[ti] : undefined;
      row.push({ t: m, v: 0, l: level[r]?.[c] ?? 0, path, flip: !!mirror[r]?.[c] });
      // Canonical PLAIN base tile per material for cliff faces: a pure cell's
      // top tile lives under .../base/ (only borders use .../transitions/), so
      // the first base-folder tile we see for a material is a plain face tile.
      if (m && path && !faceTiles[m] && path.includes("/base/") && !path.includes("/transitions/")) {
        faceTiles[m] = path;
      }
    }
    rows.push(row);
  }
  const sp = json.spawn ?? json.meta?.spawn;
  const spawn = Array.isArray(sp) ? (sp as [number, number]) : undefined;
  // Props: {x,y,tile} → place the tall tile paths[tile] on cell (x,y).
  const props: WorldProp[] = Array.isArray(json.props)
    ? json.props
        .map((p: any) => ({ col: p.x, row: p.y, path: paths[p.tile] }))
        .filter((p: WorldProp) => !!p.path)
    : [];
  return { width, height, rows, pois: [], spawn, faceTiles, props };
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
  /** Cells made impassable by a solid object standing on them (a maps2 prop).
   * The terrain type stays whatever ground it is (so lighting/surfaces are
   * unaffected), but movement into the cell is refused — a prop is an obstacle
   * the player collides with, like a tree or boulder. */
  blocked: boolean[];
}

export function buildTerrainGrid(
  width: number,
  height: number,
  rows: { t: string; l?: number }[][],
  props: { col: number; row: number }[] = [],
): TerrainGrid {
  const level: number[] = new Array(width * height).fill(0);
  const type: string[] = new Array(width * height).fill("");
  const blocked: boolean[] = new Array(width * height).fill(false);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const cell = rows[r]?.[c];
      const i = r * width + c;
      level[i] = cell?.l ?? 0;
      type[i] = cell?.t ?? "";
    }
  }
  // A placed prop makes its cell solid: the game owns collision (derived from
  // terrain), and a prop is a solid object ON the terrain, so it blocks. maps2
  // marks every prop cell in its own `collision` grid too; we derive the same
  // from the prop placements rather than consuming that grid.
  for (const p of props) {
    if (p.col >= 0 && p.row >= 0 && p.col < width && p.row < height)
      blocked[p.row * width + p.col] = true;
  }
  return { width, height, level, type, blocked };
}

// World units per cell is a FIXED constant (CELL_WU), so a world's extent is
// simply grid×CELL_WU — no global WORLD_WIDTH needed. This keeps every grid↔
// world conversion size-agnostic, so worlds of ANY dimensions render + collide
// correctly (the server can host several differently-sized worlds at once).
export function worldWidthOf(grid: TerrainGrid): number {
  return grid.width * CELL_WU;
}
export function worldHeightOf(grid: TerrainGrid): number {
  return grid.height * CELL_WU;
}

function cellIndex(grid: TerrainGrid, x: number, y: number): number {
  const col = Math.floor(x / CELL_WU);
  const row = Math.floor(y / CELL_WU);
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
  const i = cellIndex(grid, x, y);
  if (i < 0) return false;
  if (grid.blocked[i]) return false; // a prop stands here — solid
  const t = grid.type[i];
  return t ? surfaceFor(t).standable : false;
}

/** True when a solid prop occupies this cell (movement in is refused). */
export function isBlockedAtWorld(grid: TerrainGrid, x: number, y: number): boolean {
  const i = cellIndex(grid, x, y);
  return i < 0 ? false : grid.blocked[i];
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
  if (isBlockedAtWorld(grid, toX, toY)) return false; // solid prop in the way
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

/**
 * Free a body that overlaps a SOLID cell's collision margin: push it along
 * the away-gradient, at most `maxPush` (smooth, speed-limited). The strict
 * probes can wedge a body that is ALREADY inside a margin (fall landings,
 * spawns, historical positions) because every axis reads blocked — instead
 * of weakening the probes, the server tick and the client prediction both
 * run this before integrating each input, so a wedged body drifts free in a
 * few ticks and normal movement takes over. Elevation walls are untouched
 * (the forgiving-edge overhang is a feature).
 */
export function unstickFromSolids(
  grid: TerrainGrid,
  x: number,
  y: number,
  maxPush: number,
  clearance: number = PLAYER_RADIUS * 0.75 + 0.5,
): { x: number; y: number } {
  let px = 0;
  let py = 0;
  let worst = clearance;
  const c0 = Math.floor(x / CELL_WU);
  const r0 = Math.floor(y / CELL_WU);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const c = c0 + dc;
      const r = r0 + dr;
      if (!cellSolid(grid, c, r)) continue;
      const x0 = c * CELL_WU;
      const y0 = r * CELL_WU;
      const nx = clamp(x, x0, x0 + CELL_WU);
      const ny = clamp(y, y0, y0 + CELL_WU);
      let dx = x - nx;
      let dy = y - ny;
      let d = Math.hypot(dx, dy);
      if (d >= clearance) continue;
      if (d < 1e-6) {
        // Centre inside the solid cell: exit toward the nearest face.
        const exits = [
          { d: x - x0, ux: -1, uy: 0 },
          { d: x0 + CELL_WU - x, ux: 1, uy: 0 },
          { d: y - y0, ux: 0, uy: -1 },
          { d: y0 + CELL_WU - y, ux: 0, uy: 1 },
        ].sort((a, b) => a.d - b.d)[0];
        dx = exits.ux;
        dy = exits.uy;
        d = 0;
      } else {
        dx /= d;
        dy /= d;
      }
      const need = clearance - d;
      px += dx * need;
      py += dy * need;
      worst = Math.min(worst, d);
    }
  }
  const pl = Math.hypot(px, py);
  if (pl < 1e-6) return { x, y };
  const step = Math.min(maxPush, pl);
  return { x: x + (px / pl) * step, y: y + (py / pl) * step };
}

/** stepMovement's LATERAL corner-probe predicate: only SOLIDS block sideways
 * (props, structures, non-enterable surfaces) — pure elevation steps don't.
 * The forward centre probe (full canEnter) still stops head-on wall walks;
 * this keeps a wall BESIDE the path from vetoing a parallel/escaping move,
 * which wedged players at inside corners right after a cliff descent. */
export function makeSideBlocked(grid: TerrainGrid, ctx: MoveContext): BlockedFn {
  return (toX, toY) => {
    if (isBlockedAtWorld(grid, toX, toY)) return true;
    const to = surfaceAtWorld(grid, toX, toY);
    return !(to.standable || (to.swimmable && ctx.canSwim));
  };
}

/** Canonical FALL predicate: is moving from `from` onto `to` a downward step
 * bigger than what walking handles smoothly (stairs make a 1-level descent a
 * normal walk, not a fall)? `stepMovement` no longer snaps on this — the client
 * renderer mirrors the same threshold to animate the drop as a gravity fall
 * (see WorldScene.stepElevation) rather than teleport the anchor past the rim. */
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
  return { x: (col + 0.5) * CELL_WU, y: (row + 0.5) * CELL_WU };
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
  prefX: number = (grid.width * CELL_WU) / 2,
  prefY: number = (grid.height * CELL_WU) / 2,
): { x: number; y: number } {
  const c0 = clamp(Math.floor(prefX / CELL_WU), 0, grid.width - 1);
  const r0 = clamp(Math.floor(prefY / CELL_WU), 0, grid.height - 1);
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

/**
 * Auto-jump predicate: standing at (x,y) and pushing in WORLD direction
 * (ux,uy), is the terrain just past the feet a wall a walk can't climb but a
 * jump would (exactly a 1-level ledge)? 2-level+ walls and solid props fail
 * the jump check too, so they never auto-hop.
 *
 * The probe reaches PLAYER_RADIUS+3 in the DOMINANT axis (not along the
 * vector): pressed diagonally into a concave corner ("upside-down V") the
 * feet rest PLAYER_RADIUS from BOTH wall lines, and a probe measured along
 * the diagonal only reaches ~0.7×(R+3) per axis — it landed on the player's
 * own cell and the jump never fired. Scaling by the dominant component makes
 * the probe cross the nearer wall line at any push angle.
 */
export function autoJumpWanted(
  grid: TerrainGrid,
  x: number,
  y: number,
  ux: number,
  uy: number,
): boolean {
  const len = Math.hypot(ux, uy);
  if (len < 1e-6) return false;
  ux /= len;
  uy /= len;
  const d = (PLAYER_RADIUS + 3) / Math.max(Math.abs(ux), Math.abs(uy));
  const tx = x + ux * d;
  const ty = y + uy * d;
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  const jump = { maxClimb: JUMP_CLIMB, canSwim: true };
  return !canEnter(grid, x, y, tx, ty, walk) && canEnter(grid, x, y, tx, ty, jump);
}

// --- Navigation: A* pathfinding over the terrain grid ------------------------
// Used by the client's tap-to-move autopilot so the character walks AROUND
// solid props and ALONG cliff walls to a clean jump approach, instead of
// beelining into obstacles. Kept in shared so it is unit-testable and can
// never drift from canEnter (the same rule the server enforces).

const JUMP_EDGE_COST = 3; // a 1-level climb costs ~3 walked cells — prefer short detours

/** Is this CELL a solid obstacle (prop / structure / non-enterable surface)? */
function cellSolid(grid: TerrainGrid, c: number, r: number): boolean {
  if (c < 0 || r < 0 || c >= grid.width || r >= grid.height) return false;
  if (grid.blocked[r * grid.width + c]) return true;
  const s = surfaceAtWorld(grid, (c + 0.5) * CELL_WU, (r + 0.5) * CELL_WU);
  return !s.standable && !s.swimmable;
}

/**
 * Push a world point out of the collision margin of nearby solid cells — the
 * closest spot the player's BODY can actually occupy. A tap 1-2wu from a
 * prop's face is a point the mover physically can't reach (collision stops
 * PLAYER_RADIUS out): aiming at it ground the player against the prop like a
 * fly at a window. Two passes handle corners (pushed off one face into
 * another's margin).
 */
export function clearanceAdjust(
  grid: TerrainGrid,
  x: number,
  y: number,
  margin: number = PLAYER_RADIUS + 2,
): { x: number; y: number } {
  for (let pass = 0; pass < 2; pass++) {
    const c0 = Math.floor(x / CELL_WU);
    const r0 = Math.floor(y / CELL_WU);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const c = c0 + dc;
        const r = r0 + dr;
        if (!cellSolid(grid, c, r)) continue;
        const x0 = c * CELL_WU;
        const y0 = r * CELL_WU;
        const nx = clamp(x, x0, x0 + CELL_WU);
        const ny = clamp(y, y0, y0 + CELL_WU);
        let dx = x - nx;
        let dy = y - ny;
        const d = Math.hypot(dx, dy);
        if (d >= margin) continue;
        if (d < 1e-6) {
          // Inside the solid cell (tap on its walkable-looking skirt): exit
          // through the nearest face.
          const exits = [
            { d: x - x0, x: x0 - margin, y },
            { d: x0 + CELL_WU - x, x: x0 + CELL_WU + margin, y },
            { d: y - y0, x, y: y0 - margin },
            { d: y0 + CELL_WU - y, x, y: y0 + CELL_WU + margin },
          ].sort((a, b) => a.d - b.d)[0];
          x = exits.x;
          y = exits.y;
        } else {
          x = nx + (dx / d) * margin;
          y = ny + (dy / d) * margin;
        }
      }
    }
  }
  return { x, y };
}

/**
 * A* from (fromX,fromY) to (toX,toY), world units. Grid edges: 4-way walk
 * moves, diagonal walk moves (only when both flanking cardinals are walkable —
 * no corner cutting), and CARDINAL 1-level jump climbs (weighted, so paths
 * walk around when that's comparable). Returns waypoints (cell centres, the
 * final one replaced by the exact target), EXCLUDING the start; null when no
 * path exists within `maxNodes` expansions. Straight runs are merged.
 */
export function findPath(
  grid: TerrainGrid,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  opts?: { canSwim?: boolean; maxNodes?: number; swimBudget?: number },
): { x: number; y: number }[] | null {
  const W = grid.width;
  const H = grid.height;
  // The mover is CLAMPED to the SPAWN_MARGIN band at the world border
  // (stepMovement) — a route through border cells has waypoints the body can
  // physically never reach (it stalls ~24wu short and gives up). Clamp the
  // goal into the reachable band and refuse border cells as route nodes.
  const inBandX = (c: number) => (c + 0.5) * CELL_WU >= SPAWN_MARGIN && (c + 0.5) * CELL_WU <= W * CELL_WU - SPAWN_MARGIN;
  const inBandY = (r: number) => (r + 0.5) * CELL_WU >= SPAWN_MARGIN && (r + 0.5) * CELL_WU <= H * CELL_WU - SPAWN_MARGIN;
  toX = clamp(toX, SPAWN_MARGIN + 2, W * CELL_WU - SPAWN_MARGIN - 2);
  toY = clamp(toY, SPAWN_MARGIN + 2, H * CELL_WU - SPAWN_MARGIN - 2);
  const c0 = clamp(Math.floor(fromX / CELL_WU), 0, W - 1);
  const r0 = clamp(Math.floor(fromY / CELL_WU), 0, H - 1);
  let c1 = clamp(Math.floor(toX / CELL_WU), 0, W - 1);
  let r1 = clamp(Math.floor(toY / CELL_WU), 0, H - 1);
  if (c0 === c1 && r0 === r1) return [clearanceAdjust(grid, toX, toY)];
  const walk = { maxClimb: WALK_CLIMB, canSwim: opts?.canSwim ?? true };
  const jump = { maxClimb: JUMP_CLIMB, canSwim: opts?.canSwim ?? true };
  const maxNodes = opts?.maxNodes ?? 4000;
  const cx = (c: number) => (c + 0.5) * CELL_WU;
  const cy = (r: number) => (r + 0.5) * CELL_WU;
  const canWalk = (ac: number, ar: number, bc: number, br: number) =>
    bc >= 0 && br >= 0 && bc < W && br < H && inBandX(bc) && inBandY(br) &&
    canEnter(grid, cx(ac), cy(ar), cx(bc), cy(br), walk);
  const canJump = (ac: number, ar: number, bc: number, br: number) =>
    bc >= 0 && br >= 0 && bc < W && br < H && inBandX(bc) && inBandY(br) &&
    canEnter(grid, cx(ac), cy(ar), cx(bc), cy(br), jump);
  // SOLID cells (props / structures / non-enterable surfaces) need clearance:
  // the mover's collision reaches PLAYER_RADIUS ahead and 0.75R sideways, and
  // the path follower turns up to a waypoint-radius early — a route hugging a
  // prop cell clips its corner and grinds ("doesn't understand the hitbox").
  const solidCell = (c: number, r: number) => cellSolid(grid, c, r);
  const nearSolid = (c: number, r: number) => {
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++)
        if ((dc !== 0 || dr !== 0) && solidCell(c + dc, r + dr)) return true;
    return false;
  };
  const isSwim = (c: number, r: number) => {
    const s = surfaceAtWorld(grid, (c + 0.5) * CELL_WU, (r + 0.5) * CELL_WU);
    return !s.standable && s.swimmable;
  };
  // Nudge a waypoint away from adjacent solid cells (≤8wu, stays in-cell) so
  // the followed line keeps real clearance around prop corners.
  const nudged = (c: number, r: number) => {
    let px = 0;
    let py = 0;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++)
        if ((dc !== 0 || dr !== 0) && solidCell(c + dc, r + dr)) {
          const l = Math.hypot(dc, dr);
          px -= dc / l;
          py -= dr / l;
        }
    const pl = Math.hypot(px, py);
    if (pl < 1e-6) return { x: cx(c), y: cy(r) };
    return { x: cx(c) + (px / pl) * 8, y: cy(r) + (py / pl) * 8 };
  };

  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  // Node state = (cell, consecutive routed WATER cells). Swimming drains
  // stamina (~5s of continuous water = drown + respawn), so a route may only
  // ford up to SWIM_RUN_MAX cells of water in a row (~3s at swim speed) —
  // a soft cost can be beaten by geography (a long THIN lake is depth-legal
  // but lethal lengthwise); a run cap can't. START_WET marks "in water since
  // the start": a player already swimming may path to land at ANY distance
  // (they're already at risk; refusing them a route home would be worse).
  // The cap scales with the player's stamina at PLAN time (swimBudget,
  // default full): ~17 stamina per water cell, keep a ~30 safety floor. A
  // player who just swam re-plans with a smaller (possibly zero) water
  // allowance until they recover. Land cells decay the run by 1 instead of
  // resetting it, so chained fords with 1-cell breathers can't out-run the
  // real recovery rate.
  const SWIM_RUN_HARD = 3;
  const budget = opts?.swimBudget ?? MAX_STAMINA;
  const SWIM_RUN_MAX = Math.max(0, Math.min(SWIM_RUN_HARD, Math.floor((budget - 30) / 17)));
  const RUNS = SWIM_RUN_HARD + 2;
  const id = (c: number, r: number) => r * W + c;
  const sid = (c: number, r: number, run: number) => (r * W + c) * RUNS + run;
  const sidCell = (n: number) => Math.floor(n / RUNS);
  const hx = (c: number, r: number) => {
    const dc = Math.abs(c - c1);
    const dr = Math.abs(r - r1);
    return (Math.max(dc, dr) + 0.4142 * Math.min(dc, dr)) * 1.001; // octile
  };
  // Tiny binary heap of [f, id] — paths are short, this stays small.
  const heap: [number, number][] = [];
  const push = (f: number, n: number) => {
    heap.push([f, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heap[0][1];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  const start = id(c0, r0);
  // A tap on/into a solid area (or an enclosed pocket) has no reachable goal
  // cell: retarget to the nearest non-solid cell around it so the search has
  // something to aim at; the best-effort fallback below covers the rest.
  // Retarget goals the body cannot SAFELY occupy: solid cells (can't stand
  // in a prop) and WATER cells (standing in water drains stamina until you
  // drown — arrival must end on land). Route to the nearest standable cell
  // around the tap; a mid-lake tap with no shore within reach keeps the
  // original goal and best-efforts to the land rim below.
  if (cellSolid(grid, c1, r1) || isSwim(c1, r1)) {
    const mustEscapeSolid = cellSolid(grid, c1, r1);
    let bestCell: { c: number; r: number; d: number } | null = null;
    for (let rad = 1; rad <= 4 && !bestCell; rad++)
      for (let dr = -rad; dr <= rad; dr++)
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
          const c = c1 + dc;
          const r = r1 + dr;
          if (c < 0 || r < 0 || c >= W || r >= H || cellSolid(grid, c, r) || isSwim(c, r)) continue;
          const d = Math.hypot(c - c0, r - r0);
          if (!bestCell || d < bestCell.d) bestCell = { c, r, d };
        }
    if (bestCell) {
      c1 = bestCell.c;
      r1 = bestCell.r;
      toX = cx(c1);
      toY = cy(r1);
      if (c0 === c1 && r0 === r1) return [clearanceAdjust(grid, toX, toY)];
    } else if (mustEscapeSolid) {
      return null;
    }
  }
  const goalCell = id(c1, r1);
  const startSid = sid(c0, r0, isSwim(c0, r0) ? 1 : 0);
  gScore.set(startSid, 0);
  push(hx(c0, r0), startSid);
  let expanded = 0;
  let found = false;
  let foundSid = startSid;
  // Best-effort: remember the explored node CLOSEST to the goal — when the
  // goal can't be reached (walled off, budget exhausted), walking to that rim
  // and stopping cleanly beats beelining into the wall and grinding.
  let closest = startSid;
  let closestH = hx(c0, r0);
  while (heap.length) {
    const cur = pop();
    const curCell = sidCell(cur);
    const cc = curCell % W;
    const cr = (curCell - cc) / W;
    if (curCell === goalCell) {
      found = true;
      foundSid = cur;
      break;
    }
    if (!isSwim(cc, cr)) {
      const ch = hx(cc, cr);
      if (ch < closestH) {
        closestH = ch;
        closest = cur;
      }
    }
    if (++expanded > maxNodes) break;
    const run = cur - curCell * RUNS;
    const g0 = gScore.get(cur)!;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dc === 0 && dr === 0) continue;
        const nc = cc + dc;
        const nr = cr + dr;
        let cost: number;
        if (dc !== 0 && dr !== 0) {
          // Diagonal: walk only, and both flanking cardinals must be walkable
          // (the body is round — no squeezing through touching corners).
          if (!canWalk(cc, cr, nc, nr) || !canWalk(cc, cr, nc, cr) || !canWalk(cc, cr, cc, nr)) continue;
          cost = 1.4142;
        } else if (canWalk(cc, cr, nc, nr)) {
          cost = 1;
        } else if (canJump(cc, cr, nc, nr)) {
          cost = JUMP_EDGE_COST; // a 1-level auto-jump climb
        } else {
          continue;
        }
        // Prefer a 1-cell buffer around solids when one exists nearby.
        if (nearSolid(nc, nr)) cost += 0.6;
        // Water: extend the swim run (capped — see SWIM_RUN_MAX above) and
        // make even legal fords cost ~4 walked cells so land detours win.
        let nrun = Math.max(0, run - 1); // land: decay, not reset
        if (isSwim(nc, nr)) {
          nrun = run + 1;
          // A wet START may always step to run 2 (one more cell to escape by)
          // even on an empty budget — refusing a swimmer any route is worse.
          if (nrun > Math.max(SWIM_RUN_MAX, isSwim(c0, r0) ? 2 : 0)) continue;
          cost += 3;
        }
        const n = sid(nc, nr, nrun);
        const g = g0 + cost;
        if (g < (gScore.get(n) ?? Infinity)) {
          gScore.set(n, g);
          cameFrom.set(n, cur);
          push(g + hx(nc, nr), n);
        }
      }
    }
  }
  const dest = found ? foundSid : closest;
  if (dest === startSid) return null; // nowhere to go at all — ignore the tap
  // Reconstruct dest→start, then emit start→dest cell centres, merging
  // straight runs; the last waypoint becomes the exact tapped point (or the
  // best-effort rim cell when the goal was unreachable).
  const cells: number[] = [];
  for (let n: number | undefined = dest; n !== undefined && n !== startSid; n = cameFrom.get(n)) cells.push(sidCell(n));
  cells.reverse();
  // One waypoint PER CELL (no collinear merging): a merged long leg beside a
  // prop line has no interior nudged points, and the 8-way-quantized follower
  // drifted into the prop margin mid-leg. Per-cell waypoints keep the route
  // tracked tightly everywhere.
  const pts: { x: number; y: number }[] = [];
  for (const n of cells) {
    const c = n % W;
    const r = (n - c) / W;
    pts.push(nudged(c, r));
  }
  // The last waypoint is the exact tapped point pushed out of any solid's
  // collision margin — a spot the body can genuinely stand on. Best-effort
  // paths end at their rim cell's centre instead.
  if (found) pts[pts.length - 1] = clearanceAdjust(grid, toX, toY);
  return pts;
}

/** Options sent by the client when joining the world room. */
export interface JoinOptions {
  name?: string;
  character?: string; // character uid from the pixel catalog
  token?: string; // opaque per-player id for persistence (from localStorage)
  world?: string; // maps2 world name to load/join (rooms are filtered by it)
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

// ---------------------------------------------------------------------------
// Tap-to-move autopilot — SHARED so headless tests drive the exact game logic.
// The client (WorldScene) owns only the Phaser glue (tap picking, the marker,
// keyboard-cancels); every navigation decision lives here, which is what lets
// server/test/navigation.sim.test.ts run hundreds of walk/run trips at ~1000x
// real time without a browser. If you change how the follower steers, the sim
// suite IS the regression gate; the browser smoke test only proves the glue.
// ---------------------------------------------------------------------------

/** Live state of one tap-to-move trip. Mutated in place by stepAutopilot. */
export interface AutopilotTrip {
  /** The route's END: the tapped point clearance-adjusted out of collision
   * margins (or the reachable rim for walled-off goals) — see findPath. */
  target: { x: number; y: number; run: boolean };
  path: { x: number; y: number }[];
  repathed: boolean; // one re-route per trip when progress stalls
  progress: { d: number; t: number }; // best waypoint distance so far + when
  lastPos: { x: number; y: number } | null; // last step's position (segment sweep)
  /** Committed detour heading while the direct heading is body-blocked.
   * Without this the two open headings FLANKING a blocked direction can have
   * near-equal dots whose order flips as the body crosses the waypoint's
   * axis — their lateral components cancel and the player vibrates in place
   * at a gap's mouth forever (found by the trip simulator, 60fps frames). */
  steer: { ax: number; ay: number } | null;
  /** Swim-stamina budget captured when the trip was planned — replans reuse
   * it so a drained player is not routed into water they cannot survive. */
  swimBudget: number;
  /** Sticky run→walk demotion: once one frame's displacement exceeds a CELL
   * the control rate can no longer steer a run (70wu per decision at 2.5fps
   * — two cells blind between choices). The rest of the trip walks; manual
   * keyboard running is unaffected. */
  slow: boolean;
}

/** Plan a trip from (fromX,fromY) to the tapped (toX,toY). Null → nowhere to
 * go (tap into a sealed area) — callers ignore the tap. Without a grid the
 * trip is a beeline (open worlds). */
export function startTrip(
  grid: TerrainGrid | null,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  run: boolean,
  nowMs: number,
  opts?: { swimBudget?: number },
): AutopilotTrip | null {
  const swimBudget = opts?.swimBudget ?? MAX_STAMINA;
  const path = grid ? (findPath(grid, fromX, fromY, toX, toY, { swimBudget }) ?? []) : [{ x: toX, y: toY }];
  if (path.length === 0) return null;
  const end = path[path.length - 1];
  return {
    target: { x: end.x, y: end.y, run },
    path,
    repathed: false,
    progress: { d: Infinity, t: nowMs },
    lastPos: null,
    steer: null,
    slow: false,
    swimBudget,
  };
}

export interface AutopilotDrive {
  ax: number; // 8-way SCREEN input, exactly what a keyboard would hold
  ay: number;
  running: boolean;
  done: boolean; // trip over (arrived, or gave up truly blocked) — caller clears
  // Decision trace for debugging (client mirrors this into __ml.navLog).
  wp: { x: number; y: number };
  dist: number;
  rawDot: number;
  openDot: number | null;
  usedOpen: boolean;
}

const AUTOPILOT_IDLE: AutopilotDrive = {
  ax: 0, ay: 0, running: false, done: true,
  wp: { x: 0, y: 0 }, dist: 0, rawDot: 0, openDot: null, usedOpen: false,
};

/**
 * One autopilot step: steer toward the next WAYPOINT of the planned route
 * with, out of the 8 inputs a keyboard could hold, the one whose WORLD
 * direction (via screenToWorldVector, grid-axis lock included) points most
 * toward it. Re-evaluated every predict tick. Arrival ends the trip; a 1.5s
 * per-waypoint stall re-plans once from the current spot, then gives up
 * (a stall within ~1 cell of the goal counts as arrival — a nudged target
 * still snug between props). Auto-jump handles 1-level ledges on the way
 * (the caller fires the actual jump; see autoJumpWanted).
 */
export function stepAutopilot(
  grid: TerrainGrid | null,
  trip: AutopilotTrip,
  x: number,
  y: number,
  nowMs: number,
  worldW: number = WORLD_WIDTH,
  worldH: number = WORLD_HEIGHT,
): AutopilotDrive {
  const t = trip.target;
  // A waypoint counts as reached when the position lands within the radius OR
  // the movement SEGMENT since last step passed within it. One frame of run
  // under a long dt (throttled tab, laggy phone) covers more than the whole
  // radius — endpoint sampling alone leapfrogs the waypoint every frame and
  // orbits it forever without ever "arriving".
  const prev = trip.lastPos ?? { x, y };
  const segLen = Math.hypot(x - prev.x, y - prev.y);
  const segNear = (wx: number, wy: number, r: number): boolean => {
    if (segLen > CELL_WU * 3) return false; // teleport/respawn, not a walk step
    const dx = x - prev.x;
    const dy = y - prev.y;
    const l2 = dx * dx + dy * dy;
    const u = l2 > 1e-9 ? Math.max(0, Math.min(1, ((wx - prev.x) * dx + (wy - prev.y) * dy) / l2)) : 0;
    return Math.hypot(wx - (prev.x + dx * u), wy - (prev.y + dy * u)) <= r;
  };
  trip.lastPos = { x, y };
  // Radii scale with the observed per-step distance (capped at one cell):
  // you cannot stop or clip a point finer than one movement step, and under
  // long frames (laggy phone, throttled tab) a run step is 30-70wu — fixed
  // radii either orbit forever or read as "never arrived".
  const stepR = Math.min(Math.max(segLen * 0.75, 0), CELL_WU);
  if (segLen > CELL_WU) trip.slow = true; // control rate can't steer a run

  const advanceR = Math.max(PLAYER_RADIUS, stepR);
  const arriveR = Math.max(PLAYER_RADIUS * 0.75, stepR);
  // Advance past reached waypoints (intermediate radius is loose — the 8-way
  // heading has up to ~22° of error, tight radii would make it orbit).
  while (trip.path.length > 1) {
    const w0 = trip.path[0];
    if (Math.hypot(w0.x - x, w0.y - y) > advanceR && !segNear(w0.x, w0.y, PLAYER_RADIUS)) break;
    trip.path.shift();
    trip.progress = { d: Infinity, t: nowMs };
    trip.steer = null; // new waypoint → re-pick the detour heading fresh
  }
  const wp = trip.path[0] ?? { x: t.x, y: t.y };
  const dxw = wp.x - x;
  const dyw = wp.y - y;
  const dist = Math.hypot(dxw, dyw);
  if (trip.path.length <= 1 && (dist < arriveR || segNear(wp.x, wp.y, PLAYER_RADIUS * 0.75))) {
    return AUTOPILOT_IDLE; // arrived at the final target
  }
  // Stall detection is per-WAYPOINT (euclid distance to the final target can
  // legitimately grow during a detour). One stall → re-plan from here (the
  // route may be stale); a second → give up.
  if (dist < trip.progress.d - 2) trip.progress = { d: dist, t: nowMs };
  else if (nowMs - trip.progress.t > 1500) {
    // Pinned but essentially there (collision holds us a body-width short,
    // e.g. a nudged target still snug between props): that's an arrival.
    if (Math.hypot(t.x - x, t.y - y) < CELL_WU * 1.25) return AUTOPILOT_IDLE;
    if (!trip.repathed && grid) {
      trip.repathed = true;
      trip.path = findPath(grid, x, y, t.x, t.y, { swimBudget: trip.swimBudget }) ?? [];
      trip.progress = { d: Infinity, t: nowMs };
      trip.steer = null;
      if (trip.path.length === 0) return AUTOPILOT_IDLE;
    } else {
      return AUTOPILOT_IDLE; // truly blocked (wall/prop/water edge)
    }
  }
  // Blocked-aware 8-way steering. "Open" is decided by simulating a REAL
  // movement tick (stepMovement, lateral corner probes included) — a
  // centre-point probe lies in exactly the case that matters: a 1-cell gap
  // between props admits the centre but not the body, so the direct heading
  // "looks open", never corrects sideways, and the player freezes at the
  // mouth of the gap (the fly at the window). A candidate is open when the
  // body actually DISPLACES (wall-slide counts — sliding along the gap's
  // face is what centres the body into it) or when it's a 1-level ledge the
  // auto-jump will take. If the raw best heading is open it stands; if not,
  // steer with the best open heading unless everything open points away
  // (then keep pushing: unstick or the stall-replan resolves it).
  const walkCtx = { maxClimb: WALK_CLIMB, canSwim: true };
  const probeBlocked = grid ? makeBlocked(grid, walkCtx) : undefined;
  const probeSide = grid ? makeSideBlocked(grid, walkCtx) : undefined;
  const PROBE_DT = 0.15; // one honest walk step (~10.5wu): reaches past the next cell edge
  const cand: { ax: number; ay: number; dot: number; open: boolean }[] = [];
  for (let iy = -1; iy <= 1; iy++) {
    for (let ix = -1; ix <= 1; ix++) {
      if (ix === 0 && iy === 0) continue;
      const w = screenToWorldVector(ix, iy);
      const wl = Math.hypot(w.x, w.y);
      if (wl < 1e-9) continue;
      const dot = (w.x * dxw + w.y * dyw) / (wl * Math.max(dist, 1e-6));
      let open = true;
      if (grid && probeBlocked) {
        const r = stepMovement(x, y, ix, iy, false, PROBE_DT, probeBlocked, 1, true, worldW, worldH, probeSide);
        // Progress relative to THIS input's intended displacement —
        // screenToWorldVector returns speed-scaled vectors (|w| ≈ 0.7 for
        // world diagonals, ≈ 0.93-1.74 elsewhere), so a fixed denominator
        // scored a diagonal's clean one-axis wall-slide at exactly 0.5 and
        // disqualified the best detours around props.
        const frac = Math.hypot(r.x - x, r.y - y) / (wl * WALK_SPEED * PROBE_DT);
        open = frac > 0.45 || autoJumpWanted(grid, x, y, w.x, w.y);
      }
      cand.push({ ax: ix, ay: iy, dot, open });
    }
  }
  let rawBest = cand[0];
  let bestOpen: (typeof cand)[0] | null = null;
  for (const c of cand) {
    if (c.dot > rawBest.dot) rawBest = c;
    if (c.open && (!bestOpen || c.dot > bestOpen.dot)) bestOpen = c;
  }
  let best = rawBest;
  if (rawBest.open || !grid) {
    trip.steer = null; // direct heading works — normal driving
  } else {
    // Direct heading is body-blocked: steer with an OPEN detour heading, and
    // COMMIT to it. The two open headings flanking a blocked direction have
    // near-equal dots whose order flips as the body crosses the waypoint's
    // axis — re-picking every step lets their lateral components cancel and
    // the player vibrates in place at a gap's mouth. The committed heading
    // holds while it stays open and roughly sane; a clearly better escape
    // (+0.35 dot) or an opened direct heading re-decides.
    const kept = trip.steer ? cand.find((c) => c.ax === trip.steer!.ax && c.ay === trip.steer!.ay) : undefined;
    if (kept && kept.open && kept.dot > -0.3 && (!bestOpen || kept.dot >= bestOpen.dot - 0.35)) {
      best = kept;
    } else if (bestOpen && bestOpen.dot > -0.3) {
      best = bestOpen;
      trip.steer = { ax: bestOpen.ax, ay: bestOpen.ay };
    } else {
      trip.steer = null; // nothing sane is open — push on; unstick/stall-replan resolves
    }
  }
  // Run trips drop to a walk for the last stretch so the 8-way quantized
  // heading can't orbit the target at run speed.
  const finalDist = Math.hypot(t.x - x, t.y - y);
  return {
    ax: best.ax,
    ay: best.ay,
    running: t.run && !trip.slow && finalDist > CELL_WU,
    done: false,
    wp: { x: wp.x, y: wp.y },
    dist,
    rawDot: rawBest.dot,
    openDot: bestOpen ? bestOpen.dot : null,
    usedOpen: best !== rawBest,
  };
}
