// Deck-walk gate (runs inside `npm test`): world@2 "decks" (bridges, roofs) are a
// SECOND walkable surface floating above unchanged base terrain. The movement
// rule (shared canEnterElev/resolveElevAt) must keep a player who is ON a deck up
// at deck level as they cross it — NOT drop them onto the base (water/chasm/floor)
// underneath — while a player UNDER the deck stays on the base. This regression
// guard drives the real occlusion_test world through the exact server code path
// (parseWorld → buildTerrainGrid → canEnterElev/resolveElevAt), no browser.
//
// occlusion_test: a stone BRIDGE (level 4) spans a clear_water channel between two
// level-4 grass plateaus, and a house ROOF (level 4) caps a level-0 interior.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseWorld, buildTerrainGrid, canEnterElev, resolveElevAt, findPath, CELL_WU } from "../shared/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const worldPath = join(here, "..", "..", "maps2", "worlds", "occlusion_test", "world.json");
const w = parseWorld(JSON.parse(readFileSync(worldPath, "utf8")));
if (!w) throw new Error("parseWorld returned null for occlusion_test");
const grid = buildTerrainGrid(w.width, w.height, w.rows, w.props, w.decks);

const ctx = { maxClimb: 0.5, canSwim: true }; // WALK_CLIMB; the server passes canSwim:true
const wc = (col, row) => [(col + 0.5) * CELL_WU, (row + 0.5) * CELL_WU];
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.log(`FAIL  ${msg}`); fails++; } };

// Walk a straight run of cells at a fixed row starting from a known elevation,
// stepping one cell at a time exactly like stepMovement's leading-edge probe.
function walk(startElev, row, cols) {
  let elev = startElev;
  const trace = [];
  let allEnter = true, minElev = startElev, maxElev = startElev;
  for (let k = 1; k < cols.length; k++) {
    const [fx, fy] = wc(cols[k - 1], row);
    const [tx, ty] = wc(cols[k], row);
    const r = canEnterElev(grid, elev, fx, fy, tx, ty, ctx);
    if (!r.ok) { allEnter = false; trace.push(`c${cols[k]}:BLK`); continue; }
    elev = resolveElevAt(grid, r.elev, tx, ty, ctx);
    trace.push(`c${cols[k]}:${elev}`);
    minElev = Math.min(minElev, elev); maxElev = Math.max(maxElev, elev);
  }
  return { elev, trace, allEnter, minElev, maxElev };
}

const deckCells = grid.deck.filter((d) => d >= 0).length;
ok(deckCells > 0, `terrain grid has deck cells (got ${deckCells})`);

// (1) BRIDGE — ON it: from the left plateau (col39,L4) east across the deck to the
// right plateau (col47,L4). Must stay at elev 4 the whole way (no fall into water).
{
  const r = walk(4, 110, [39, 40, 41, 42, 43, 44, 45, 46, 47]);
  ok(r.allEnter, `bridge deck fully walkable while on it (${r.trace.join(" ")})`);
  ok(r.minElev === 4 && r.maxElev === 4, `bridge crossing never leaves elev 4 (min=${r.minElev} max=${r.maxElev})`);
}

// (2) BRIDGE — UNDER it: on the grass strip (col45,L0) the deck above must not yank
// you up; you stay at elev 0.
{
  const r = walk(0, 110, [45, 44, 43]);
  ok(r.allEnter && r.maxElev === 0, `walking under the bridge stays at elev 0 (${r.trace.join(" ")})`);
}

// (3) ROOF — ON it: from the east wall (col63,L4) west across the L0 interior. Must
// stay at elev 4 (standing on the roof, not falling inside the house).
{
  const r = walk(4, 107, [63, 62, 61, 60, 59, 58, 57, 56, 55]);
  ok(r.allEnter, `roof deck fully walkable while on it (${r.trace.join(" ")})`);
  ok(r.minElev === 4 && r.maxElev === 4, `roof crossing never leaves elev 4 (min=${r.minElev} max=${r.maxElev})`);
}

// (4) ROOF — UNDER it: inside the house (col58,L0) you stay at elev 0.
{
  const r = walk(0, 107, [58, 59, 60]);
  ok(r.allEnter && r.maxElev === 0, `inside the house (under the roof) stays at elev 0 (${r.trace.join(" ")})`);
}

// (5) TAP-TO-MOVE (layered findPath): tapping the bridge DECK from the south
// plain must route OVER the top (up a plateau) — not swim under it. Regression
// guard for "I fall down when I click the bridge".
{
  const [sx, sy] = wc(37, 122); // south plain below the left ramp, level 0
  const [gx, gy] = wc(42, 110); // mid-bridge deck cell, level 4
  const path = findPath(grid, sx, sy, gx, gy, { fromElev: 0, goalLevel: 4, canSwim: true });
  ok(Array.isArray(path) && path.length > 0, "findPath to the bridge deck returns a route");
  if (Array.isArray(path) && path.length) {
    const cells = path.map((wp) => ({ c: Math.floor(wp.x / CELL_WU), r: Math.floor(wp.y / CELL_WU) }));
    const overPlateau = cells.some(({ c, r }) => grid.level[r * grid.width + c] === 4 && grid.deck[r * grid.width + c] < 0);
    ok(overPlateau, "bridge-tap route climbs over a level-4 plateau (goes OVER, not under)");
    const last = cells[cells.length - 1];
    ok(Math.abs(last.c - 42) <= 1 && Math.abs(last.r - 110) <= 1, `bridge-tap route ends at the deck cell (got ${last.c},${last.r})`);
  }
}

// (6) A tap on the FLAT south plain still routes normally at ground level
// (no deck involvement) — sanity that the layered search didn't distort flats.
{
  const [sx, sy] = wc(64, 124);
  const [gx, gy] = wc(70, 124);
  const path = findPath(grid, sx, sy, gx, gy, { canSwim: true });
  ok(Array.isArray(path) && path.length > 0, "flat-ground tap still routes normally");
}

if (fails) { console.log(`check-deckwalk: ${fails} FAILURE(S)`); process.exit(1); }
console.log(`check-deckwalk: OK — bridge + roof keep on-deck players up and under-deck players down (${deckCells} deck cells).`);
