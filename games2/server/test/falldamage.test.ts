// FALL DAMAGE + the no-fall navigation law (maintainer 2026-08-12): "the nav
// system should at any cost avoid fall damage — this is probably not what the
// player wanted. A house is 10% health. Top of the mountain at The Island 2 is
// 95%. Higher than that means you die even with full health."
//
// Three layers, each pinned here:
//  1. the CURVE (pure): house roof 10%, the calibration summit 95%, past it death.
//  2. the ROUTE (findPath on the REAL the_game): a tap past the sheerest rim
//     the world ships — the maintainer's "jumps down the entire mountain"
//     repro — must never route through a damaging drop. Every consecutive
//     waypoint pair stays under the line.
//  3. the LANDING (live room on the REAL the_game): walking off a ledge costs
//     exactly round(frac*hpMax); diving into WATER off a cliff costs nothing.
// Every cell is DERIVED from the world doc (the sheerest standable edge, a
// ledge with a mid-curve drop, a ledge over water), so the maps agent can
// reshape the mountain without editing this gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import {
  ROOM_NAME,
  CELL_WU,
  parseWorld,
  buildTerrainGrid,
  findPath,
  fallDamageFrac,
  surfaceFor,
  screenToWorldVector,
  FALL_DMG_MIN_LEVELS,
  FALL_DMG_MAX_LEVELS,
} from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";

const here = dirname(fileURLToPath(import.meta.url));
const worldPath = join(here, "..", "..", "..", "maps2", "worlds3", "the_game", "world.json");
// The deploy's test job checks out no world tree: the world tests skip (never
// throw) without it, and the live one skips BEFORE its server opens.
const world = existsSync(worldPath) ? parseWorld(JSON.parse(readFileSync(worldPath, "utf8"))) : null;
const SKIP = "maps2/worlds3/the_game missing";
const g = world ? buildTerrainGrid(world.width, world.height, world.rows, world.props ?? [], world.decks ?? []) : null!;
const W = g?.width ?? 0;
const H = g?.height ?? 0;
const idx = (c: number, r: number) => r * W + c;
const lvlAt = (c: number, r: number) => g.level[idx(c, r)];
const standable = (c: number, r: number) => g.deck[idx(c, r)] < 0 && surfaceFor(g.type[idx(c, r)]).standable;
const scenery = world?.scenery ?? [];
/** No scenery within `d` cells: the live room stamps footprints into the
 *  collision grid, and a ledge with a bush on it is a collision test, not a
 *  fall test. */
const clear = (c: number, r: number, d: number) =>
  !scenery.some((p) => Math.abs(p.x - (c + 0.5)) <= d && Math.abs(p.y - (r + 0.5)) <= d);

test("the fall damage curve matches the maintainer's calibration", () => {
  assert.equal(fallDamageFrac(0), 0);
  assert.equal(fallDamageFrac(FALL_DMG_MIN_LEVELS - 1), 0, "just under a house roof is free");
  assert.equal(fallDamageFrac(FALL_DMG_MIN_LEVELS), 0.1, "the house roof is 10%");
  assert.equal(fallDamageFrac(FALL_DMG_MAX_LEVELS), 0.95, "the calibration summit is 95%");
  assert.ok(fallDamageFrac(FALL_DMG_MAX_LEVELS + 2) > 1, "higher than the summit kills from full health");
  // Monotone: a higher fall never hurts less.
  for (let d = 1; d < 40; d++) assert.ok(fallDamageFrac(d + 1) >= fallDamageFrac(d));
});

/** The sheerest edge the world ships: the biggest level drop between two
 *  4-adjacent STANDABLE cells with no deck over either. */
function sheerestEdge(): { c: number; r: number; dc: number; dr: number; drop: number } {
  let best = { c: 0, r: 0, dc: 1, dr: 0, drop: -1 };
  for (let r = 2; r < H - 2; r++)
    for (let c = 2; c < W - 2; c++) {
      if (!standable(c, r)) continue;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (!standable(c + dc, r + dr)) continue;
        const drop = lvlAt(c, r) - lvlAt(c + dc, r + dr);
        if (drop > best.drop) best = { c, r, dc, dr, drop };
      }
    }
  return best;
}

test("a route NEVER takes a damaging fall — the mountain-top hurl", (t) => {
  if (!world) return t.skip(SKIP);
  const rim = sheerestEdge();
  // The maintainer's report: standing on top, tapping past the rim, "the
  // pathfinder thinks maybe the user wants to navigate behind the mountain
  // and jumps down".
  assert.ok(rim.drop >= FALL_DMG_MAX_LEVELS - 8,
    `the world's sheerest standable edge drops only ${rim.drop} levels — the mountain is gone`);
  assert.ok(rim.drop >= FALL_DMG_MIN_LEVELS, "the rim really is a damaging drop");
  const from = { x: (rim.c + 0.5) * CELL_WU, y: (rim.r + 0.5) * CELL_WU };
  const top = lvlAt(rim.c, rim.r);
  console.log(`falldamage: the sheerest rim is ${rim.c},${rim.r} (level ${top}) dropping ${rim.drop} onto ${rim.c + rim.dc},${rim.r + rim.dr}`);
  const clampC = (c: number) => Math.max(1, Math.min(W - 2, c));
  const clampR = (r: number) => Math.max(1, Math.min(H - 2, r));
  const goals = [
    [rim.c + rim.dc, rim.r + rim.dr], // the adjacent low ground right past the rim
    [rim.c + rim.dc * 15, rim.r + rim.dr * 15], // far "behind the mountain"
    [rim.c + rim.dc * 7 + rim.dr * 7, rim.r + rim.dr * 7 + rim.dc * 7], // diagonal, off the far corner
  ].map(([c, r]) => ({ x: (clampC(c) + 0.5) * CELL_WU, y: (clampR(r) + 0.5) * CELL_WU }));
  let routed = 0;
  for (const goal of goals) {
    const route = findPath(g, from.x, from.y, goal.x, goal.y, { fromElev: top });
    if (!route) continue; // refusing outright also honours the law
    routed++;
    let prev = top;
    for (const wpt of route) {
      const lvl = wpt.lvl ?? lvlAt(Math.floor(wpt.x / CELL_WU), Math.floor(wpt.y / CELL_WU));
      assert.ok(
        prev - lvl < FALL_DMG_MIN_LEVELS,
        `route to ${goal.x / CELL_WU},${goal.y / CELL_WU} drops ${prev - lvl} levels in one step — a damaging fall`,
      );
      prev = lvl;
    }
  }
  // Refusing every goal would honour the law too, but it would also make the
  // waypoint sweep above assert nothing — the far goals must route.
  assert.ok(routed >= 1, `findPath refused all ${goals.length} goals from the rim — nothing was checked`);
});

/** A DIAGONAL screen press is grid-axis-locked to ONE world axis, so the body
 *  leaves its cell through a side, never a corner, and the cell it drops into
 *  is unambiguous. Returns the four (input, world step) pairs. */
function cardinalInputs(): { ax: number; ay: number; dx: number; dy: number }[] {
  return ([[1, 1], [-1, -1], [1, -1], [-1, 1]] as const).map(([ax, ay]) => {
    const v = screenToWorldVector(ax, ay);
    return { ax, ay, dx: Math.abs(v.x) > 1e-9 ? Math.sign(v.x) : 0, dy: Math.abs(v.y) > 1e-9 ? Math.sign(v.y) : 0 };
  });
}

/** A mid-curve drop (past the house-roof minimum, well short of the kill), or
 *  a dive: a standable, deck-free, scenery-free ledge at level L whose next TWO cells
 *  along a cardinal step are `into` (standable ground or water) at one common
 *  level `drop` levels down — two cells so the walker lands and stays landed
 *  before the assertion reads it. */
function ledge(into: "ground" | "water", minDrop: number, maxDrop: number) {
  const isWater = (i: number) => g.type[i] === "water" || g.type[i] === "deep_water"; // never lava: it burns
  for (const inp of cardinalInputs()) {
    for (let r = 6; r < H - 6; r++)
      for (let c = 6; c < W - 6; c++) {
        if (!standable(c, r) || !clear(c, r, 5)) continue;
        const L = lvlAt(c, r);
        const j1 = idx(c + inp.dx, r + inp.dy);
        const j2 = idx(c + 2 * inp.dx, r + 2 * inp.dy);
        if (g.deck[j1] >= 0 || g.deck[j2] >= 0 || g.level[j1] !== g.level[j2]) continue;
        const drop = L - g.level[j1];
        if (drop < minDrop || drop > maxDrop) continue;
        const ok = into === "water"
          ? isWater(j1) && isWater(j2)
          : surfaceFor(g.type[j1]).standable && surfaceFor(g.type[j2]).standable;
        if (!ok || !clear(c + inp.dx, r + inp.dy, 5)) continue;
        return { c, r, L, drop, ...inp };
      }
  }
  return null;
}

test("landing costs the curve's price, and water is a dive", async (t) => {
  if (!world) return t.skip(SKIP);
  // Derived and asserted BEFORE the server opens: a throw past listen() would
  // leave it listening and hang the runner.
  const cliff = ledge("ground", FALL_DMG_MIN_LEVELS + 2, 20);
  const dive = ledge("water", FALL_DMG_MIN_LEVELS, 40);
  assert.ok(cliff, "the_game has no scenery-free ledge dropping 8-20 levels onto standable ground");
  assert.ok(dive, "the_game has no scenery-free ledge dropping 6+ levels into water");
  console.log(`falldamage: ledge ${cliff!.c},${cliff!.r} L${cliff!.L} drops ${cliff!.drop} on input (${cliff!.ax},${cliff!.ay}); ` +
    `dive ${dive!.c},${dive!.r} L${dive!.L} drops ${dive!.drop} into water on input (${dive!.ax},${dive!.ay})`);
  const port = 2971;
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  const waitFor = async (cond: () => boolean, timeout = 8000, label = "condition") => {
    const start = Date.now();
    const ready = () => {
      try {
        return cond();
      } catch {
        return false;
      }
    };
    while (!ready()) {
      if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const r1: any = await c1.joinOrCreate(ROOM_NAME, {
      name: "Faller",
      character: "default_boy",
      token: `fall-${Date.now()}`,
      world: "the_game",
      monsterCount: 0,
    });
    r1.onMessage("chat", () => {});
    r1.onMessage("inv", () => {});
    r1.onMessage("star", () => {});
    r1.onMessage("live:update", () => {});
    await waitFor(() => r1.state.players.size === 1, 8000, "join");
    const me = () => r1.state.players.get(r1.sessionId);
    const hpMax = me().hpMax;

    // Walk off the ledge: a `drop`-level fall = round(fallDamageFrac(drop) * hpMax).
    r1.send("teleport", { x: (cliff!.c + 0.5) * CELL_WU, y: (cliff!.r + 0.5) * CELL_WU });
    await waitFor(() => me().elev >= cliff!.L - 0.5, 4000, "teleport onto the ledge");
    const expect = Math.round(fallDamageFrac(cliff!.drop) * hpMax);
    assert.ok(expect > 0 && expect < hpMax, `a ${cliff!.drop}-level fall must sting, not kill (${expect} of ${hpMax})`);
    for (let i = 0; i < 30 && me().hp === hpMax; i++) {
      r1.send("input", { ax: cliff!.ax, ay: cliff!.ay, running: false, dt: 0.05, seq: i + 1 });
      await new Promise((r) => setTimeout(r, 40));
    }
    await waitFor(() => me().hp < hpMax, 4000, "the landing to hurt");
    assert.equal(me().hp, hpMax - expect,
      `a ${cliff!.drop}-level fall off ${cliff!.c},${cliff!.r} costs exactly ${expect}`);
    assert.ok(!me().dead, `a ${cliff!.drop}-level fall stings, it does not kill`);

    // A ledge over WATER: the same walk is a dive, no damage.
    const hpBefore = me().hp;
    r1.send("teleport", { x: (dive!.c + 0.5) * CELL_WU, y: (dive!.r + 0.5) * CELL_WU });
    await waitFor(() => me().elev >= dive!.L - 0.5, 4000, "teleport onto the water ledge");
    for (let i = 0; i < 30 && !me().swimming; i++) {
      r1.send("input", { ax: dive!.ax, ay: dive!.ay, running: false, dt: 0.05, seq: 100 + i });
      await new Promise((r) => setTimeout(r, 40));
    }
    await waitFor(() => me().swimming, 4000, "the dive to land in water");
    assert.equal(me().hp, hpBefore, `a ${dive!.drop}-level dive off ${dive!.c},${dive!.r} into water costs nothing`);

    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
