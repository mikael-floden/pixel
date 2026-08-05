// Deck-walk gate (runs inside `npm test`): world@2 "decks" (bridges, roofs) are a
// SECOND walkable surface floating above unchanged base terrain. The movement rule
// (shared canEnterElev/resolveElevAt) must keep a player who is ON a deck up at the
// deck's level as they cross it — NOT drop them onto the base (water/chasm/floor)
// underneath — while a player UNDER the deck stays on the base; and tap-to-move
// (layered findPath) must route ONTO a deck over the top, not under it.
//
// Everything here is DERIVED FROM THE WORLD DATA — the deck's level, its entry
// cells (footprint cells whose base already equals the deck level: walls/plateau
// edges) and its raised interior cells (base below the deck) are all read from the
// parsed world. So the maps agent can freely re-shape or re-height a deck (e.g.
// raise the house/bridge 4→7 for headroom) without touching this gate: it asserts
// the ENGINE INVARIANT, not any specific geometry. Drives the real occlusion_test
// world through the exact server code path (parseWorld → buildTerrainGrid →
// canEnterElev/resolveElevAt/findPath), no browser.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseWorld, buildTerrainGrid, canEnterElev, resolveElevAt, findPath, CELL_WU, WALK_CLIMB } from "../shared/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const worldPath = join(here, "..", "..", "maps2", "worlds", "occlusion_test", "world.json");
const w = parseWorld(JSON.parse(readFileSync(worldPath, "utf8")));
if (!w) throw new Error("parseWorld returned null for occlusion_test");
const grid = buildTerrainGrid(w.width, w.height, w.rows, w.props, w.decks);
const W = grid.width;

const ctx = { maxClimb: WALK_CLIMB, canSwim: true }; // the server passes canSwim:true
const wc = (col, row) => [(col + 0.5) * CELL_WU, (row + 0.5) * CELL_WU];
const idx = (c, r) => r * W + c;
const baseLvl = (c, r) => grid.level[idx(c, r)];
const deckLvl = (c, r) => grid.deck[idx(c, r)];
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.log(`FAIL  ${msg}`); fails++; } };

const decks = w.decks ?? [];
ok(decks.length > 0, "world declares at least one deck");
const totalDeckCells = grid.deck.filter((d) => d >= 0).length;
ok(totalDeckCells > 0, `terrain grid has raised deck cells (got ${totalDeckCells})`);

for (const d of decks) {
  const L = d.level; // the deck's walkable level — whatever the maps agent chose
  const kind = d.kind ?? "deck";
  // Interior = footprint cells lifted above their base (buildTerrainGrid gave them
  // a deck[] entry). Entry = footprint cells whose base already reaches L (the
  // walls / plateau edges you step onto the deck from).
  const interior = d.cells.filter((c) => deckLvl(c.col ?? c.x, c.row ?? c.y) >= 0)
    .map((c) => ({ c: c.col ?? c.x, r: c.row ?? c.y }));
  const foot = new Set(d.cells.map((c) => idx(c.col ?? c.x, c.row ?? c.y)));
  const entries = d.cells.map((c) => ({ c: c.col ?? c.x, r: c.row ?? c.y }))
    .filter(({ c, r }) => deckLvl(c, r) < 0 && Math.abs(baseLvl(c, r) - L) < 0.5);
  ok(interior.length > 0, `${kind}: has raised interior deck cells (base < level ${L})`);
  ok(entries.length > 0, `${kind}: has an entry cell (base == level ${L}) to step on from`);

  // (a) ON the deck: standing on ANY interior cell at the deck level stays at the
  // deck level (never drops to the base — the "you fall through the bridge" bug).
  let onOk = true, onBad = null;
  for (const { c, r } of interior) {
    const [x, y] = wc(c, r);
    const e = resolveElevAt(grid, L, x, y, ctx);
    if (e !== L) { onOk = false; onBad ??= `(${c},${r})->${e}`; }
  }
  ok(onOk, `${kind}: standing on the deck stays at level ${L} ${onBad ?? ""}`);

  // (b) UNDER the deck: standing on the base of an interior cell stays at the base
  // level — the deck overhead must not yank an under-walker up.
  let underOk = true, underBad = null;
  for (const { c, r } of interior) {
    const b = baseLvl(c, r);
    const [x, y] = wc(c, r);
    const e = resolveElevAt(grid, b, x, y, ctx);
    if (e !== b) { underOk = false; underBad ??= `(${c},${r}) base ${b}->${e}`; }
  }
  ok(underOk, `${kind}: standing under the deck stays at the base level ${underBad ?? ""}`);

  // (c) CROSSING: every step BETWEEN adjacent footprint cells, taken at the deck
  // level, stays at the deck level and is enterable — so you can walk the whole
  // span (and step on from an entry cell) without ever dropping.
  let crossOk = true, crossBad = null;
  const step = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const { c, r } of interior) {
    for (const [dc, dr] of step) {
      const nc = c + dc, nr = r + dr;
      if (!foot.has(idx(nc, nr))) continue; // only steps within the deck footprint
      const [fx, fy] = wc(c, r);
      const [tx, ty] = wc(nc, nr);
      const res = canEnterElev(grid, L, fx, fy, tx, ty, ctx);
      if (!res.ok || resolveElevAt(grid, res.elev, tx, ty, ctx) !== L) {
        crossOk = false; crossBad ??= `(${c},${r})->(${nc},${nr})`;
      }
    }
  }
  ok(crossOk, `${kind}: every step across the deck stays at level ${L} ${crossBad ?? ""}`);

  // (d) TAP-TO-MOVE: from an interior cell's BASE (as if you tapped its deck top
  // while standing under/near it), findPath with the deck goalLevel must route
  // UP-AND-OVER — a real multi-step route that climbs a ramp to deck height and
  // steps onto it — not a same-cell no-op that leaves you under it. You step onto
  // the deck from ground within WALK_CLIMB of the deck level, so "climbed" = the
  // route reaches base ≥ L − WALK_CLIMB (an entry ledge, or one step below it).
  {
    const mid = interior[Math.floor(interior.length / 2)];
    const [mx, my] = wc(mid.c, mid.r);
    const path = findPath(grid, mx, my, mx, my, { fromElev: baseLvl(mid.c, mid.r), goalLevel: L, canSwim: true });
    ok(Array.isArray(path) && path.length > 1, `${kind}: tap-onto-deck reroute is a real over-route (len ${path?.length})`);
    if (Array.isArray(path)) {
      const climbs = path.some((wp) => baseLvl(Math.floor(wp.x / CELL_WU), Math.floor(wp.y / CELL_WU)) >= L - WALK_CLIMB - 1e-9);
      ok(climbs, `${kind}: tap-onto-deck route climbs to the deck level (goes OVER, not under)`);
    }
  }
}

// FLAT sanity: a tap on open ground still routes normally (layered search must not
// distort non-deck worlds). Find any two nearby non-deck, unblocked ground cells.
{
  let a = null, b = null;
  // Stay well inside the border band (findPath refuses border cells) — scan the
  // interior for two nearby flat, unblocked, non-deck level-0 ground cells.
  for (let r = 12; r < grid.height - 12 && !b; r++)
    for (let c = 12; c + 4 < W - 12; c++) {
      const flat = (cc) => grid.deck[idx(cc, r)] < 0 && !grid.blocked[idx(cc, r)] && grid.level[idx(cc, r)] === 0;
      if (flat(c) && flat(c + 4)) { a = [c, r]; b = [c + 4, r]; break; }
    }
  if (a && b) {
    const [sx, sy] = wc(a[0], a[1]);
    const [gx, gy] = wc(b[0], b[1]);
    const path = findPath(grid, sx, sy, gx, gy, { canSwim: true });
    ok(Array.isArray(path) && path.length > 0, "flat-ground tap still routes normally");
  }
}

if (fails) { console.log(`check-deckwalk: ${fails} FAILURE(S)`); process.exit(1); }
console.log(`check-deckwalk: OK — ${decks.length} deck(s) keep on-deck players up and under-deck players down, tap routes over (${totalDeckCells} deck cells).`);
