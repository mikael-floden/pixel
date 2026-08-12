// FALL DAMAGE + the no-fall navigation law (maintainer 2026-08-12): "the nav
// system should at any cost avoid fall damage — this is probably not what the
// player wanted. A house is 10% health. Top of the mountain at The Island 2 is
// 95%. Higher than that means you die even with full health."
//
// Three layers, each pinned here:
//  1. the CURVE (pure): house roof 10%, island summit 95%, past it death.
//  2. the ROUTE (findPath on the REAL the_island2): a tap past the summit rim
//     — the maintainer's "jumps down the entire mountain" repro at the
//     (165,45)->166+ 30-level sheer edge — must never route through a
//     damaging drop. Every consecutive waypoint pair stays under the line.
//  3. the LANDING (live room on the REAL occlusion_test): walking off a
//     14-level cliff costs exactly round(frac*hpMax); diving into WATER off a
//     9-level cliff costs nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  FALL_DMG_MIN_LEVELS,
  FALL_DMG_MAX_LEVELS,
} from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";

const here = dirname(fileURLToPath(import.meta.url));
const worldPath = (n: string) => join(here, "..", "..", "..", "maps2", "worlds", n, "world.json");

test("the fall damage curve matches the maintainer's calibration", () => {
  assert.equal(fallDamageFrac(0), 0);
  assert.equal(fallDamageFrac(FALL_DMG_MIN_LEVELS - 1), 0, "just under a house roof is free");
  assert.equal(fallDamageFrac(FALL_DMG_MIN_LEVELS), 0.1, "the house roof is 10%");
  assert.equal(fallDamageFrac(FALL_DMG_MAX_LEVELS), 0.95, "the_island2's summit is 95%");
  assert.ok(fallDamageFrac(FALL_DMG_MAX_LEVELS + 2) > 1, "higher than the summit kills from full health");
  // Monotone: a higher fall never hurts less.
  for (let d = 1; d < 40; d++) assert.ok(fallDamageFrac(d + 1) >= fallDamageFrac(d));
});

test("a route NEVER takes a damaging fall — the mountain-top hurl", () => {
  const w = parseWorld(JSON.parse(readFileSync(worldPath("the_island2"), "utf8")))!;
  const g = buildTerrainGrid(w.width, w.height, w.rows, w.props ?? [], w.decks ?? []);
  // The summit plateau rim: (165,45) is level 32, (166,45) is level 2 — a
  // 30-level sheer drop (95% of max HP). The maintainer's report: standing on
  // top, tapping past the rim, "the pathfinder thinks maybe the user wants to
  // navigate behind the mountain and jumps down".
  const from = { x: 165.5 * CELL_WU, y: 45.5 * CELL_WU };
  const lvlAt = (c: number, r: number) => g.level[r * w.width + c];
  assert.ok(lvlAt(165, 45) >= 30, "the start really is the summit plateau");
  assert.ok(lvlAt(165, 45) - lvlAt(166, 45) >= FALL_DMG_MIN_LEVELS, "the rim really is a damaging drop");
  for (const goal of [
    { x: 166.5 * CELL_WU, y: 45.5 * CELL_WU }, // the adjacent low ground right past the rim
    { x: 180.5 * CELL_WU, y: 45.5 * CELL_WU }, // far "behind the mountain"
    { x: 172.5 * CELL_WU, y: 60.5 * CELL_WU }, // diagonal, off the far corner
  ]) {
    const route = findPath(g, from.x, from.y, goal.x, goal.y, { fromElev: lvlAt(165, 45) });
    if (!route) continue; // refusing outright also honours the law
    let prev = lvlAt(165, 45);
    for (const wpt of route) {
      const lvl = wpt.lvl ?? lvlAt(Math.floor(wpt.x / CELL_WU), Math.floor(wpt.y / CELL_WU));
      assert.ok(
        prev - lvl < FALL_DMG_MIN_LEVELS,
        `route to ${goal.x / CELL_WU},${goal.y / CELL_WU} drops ${prev - lvl} levels in one step — a damaging fall`,
      );
      prev = lvl;
    }
  }
});

test("landing costs the curve's price, and water is a dive", async () => {
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
      world: "occlusion_test",
      monsterCount: 0,
    });
    r1.onMessage("chat", () => {});
    r1.onMessage("inv", () => {});
    r1.onMessage("star", () => {});
    r1.onMessage("live:update", () => {});
    await waitFor(() => r1.state.players.size === 1, 8000, "join");
    const me = () => r1.state.players.get(r1.sessionId);
    const hpMax = me().hpMax;

    // (56,15) is a level-14 ledge whose north neighbour (56,14) is level 0 —
    // a 14-level drop = round((0.10 + 8/26*0.85) * hpMax). Walk off it.
    r1.send("teleport", { x: 56.5 * CELL_WU, y: 15.5 * CELL_WU });
    await waitFor(() => me().elev >= 13, 4000, "teleport onto the ledge");
    const expect14 = Math.round(fallDamageFrac(14) * hpMax);
    for (let i = 0; i < 30 && me().hp === hpMax; i++) {
      r1.send("input", { ax: 0, ay: -1, running: false, dt: 0.05, seq: i + 1 });
      await new Promise((r) => setTimeout(r, 40));
    }
    await waitFor(() => me().hp < hpMax, 4000, "the landing to hurt");
    assert.equal(me().hp, hpMax - expect14, `a 14-level fall costs exactly ${expect14}`);
    assert.ok(!me().dead, "a 14-level fall stings, it does not kill");

    // (39,109) is a level-9 ledge over WATER at (40,109): a dive, no damage.
    const hpBefore = me().hp;
    r1.send("teleport", { x: 39.5 * CELL_WU, y: 109.5 * CELL_WU });
    await waitFor(() => me().elev >= 8, 4000, "teleport onto the water ledge");
    for (let i = 0; i < 30 && !me().swimming; i++) {
      r1.send("input", { ax: 1, ay: 1, running: false, dt: 0.05, seq: 100 + i });
      await new Promise((r) => setTimeout(r, 40));
    }
    await waitFor(() => me().swimming, 4000, "the dive to land in water");
    assert.equal(me().hp, hpBefore, "a dive into water costs nothing");

    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
