// ============================================================================
// A ROOM SOMEONE CAN SEE INTO, OR IS ABOUT TO, RUNS AT THE FULL RATE
// ============================================================================
//
// An empty room sims inside the idle gate (IDLE_DIVISOR: ~5 Hz), and that was
// the SOURCE rate of every ghost across a line — a monster next door moved in
// 200 ms steps while the same monster in your own zone moved at 20 Hz
// (maintainer 2026-09-24: "the game feels the same regardless if another player
// is in that other zone or not ... speed up the zones around me a bit before a
// player can see into it"). A room with a client names, on its edge snapshot,
// every neighbour one of its players stands within WAKE_WU of (the ghost band
// plus a second of running), and a named room leaves the idle gate.
//
// Measured here with `perfStats().simHz`: a neighbour nobody is near idles at
// ~5 Hz; the one a player is about to see into runs at ~20 Hz while the player
// is still OUTSIDE its ghost band; at a corner all three neighbours wake; and
// WAKE_HOLD_MS after the player walks away they idle again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, CELL_WU, zoneGrid, zoneRect } from "@nangijala/shared";
import { WorldRoom, perfStats, resetWorldClocks } from "../src/rooms/WorldRoom.js";
import { FakeBus, useBus } from "../src/bus.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HAVE_WORLD = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"));
const CFG = { cols: 2, rows: 2 };
const GRID = zoneGrid(CFG, 394, 394, CELL_WU);
const R0 = zoneRect(GRID, 0);
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeout = 5000, what = "condition"): Promise<void> {
  const start = Date.now();
  const ready = () => { try { return cond(); } catch { return false; } };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("a neighbour a player is about to see into runs at 20 Hz; one nobody is near idles at 5", async (t) => {
  if (!HAVE_WORLD) return t.skip("maps2/worlds3/the_game missing");
  useBus(new FakeBus());
  resetWorldClocks();
  const port = 3043; // unique across test files — ports.test.ts gates it
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, monsterSeed: 3, interestRadius: 0 };
  try {
    // Zones 1 (east), 2 (south) and 3 (the diagonal) exist, warm and empty.
    const rooms = new Map<number, string>();
    for (const z of [1, 2, 3]) rooms.set(z, (await matchMaker.createRoom(ROOM_NAME, { ...base, zone: z })).roomId);
    const hz = async (): Promise<Record<number, number>> => {
      perfStats(); // reset the window
      await settle(1500);
      const s = perfStats().rooms;
      const out: Record<number, number> = {};
      for (const [z, id] of rooms) out[z] = s.find((r) => r.id === id)!.simHz;
      return out;
    };
    const idle = (v: number) => v >= 3.5 && v <= 7;
    const awake = (v: number) => v >= 16;

    const c = new Client(`ws://localhost:${port}`);
    const r: any = await c.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Ivo", character: "default_boy" });
    await waitFor(() => r.state.players.size === 1, 8000, "joined zone 0");
    const pid = r.sessionId;
    const park = async (x: number, y: number) => {
      r.send("teleport", { x, y });
      await waitFor(() => Math.abs(r.state.players.get(pid).x - x) < 1 && Math.abs(r.state.players.get(pid).y - y) < 1, 5000, `parked at ${x},${y}`);
    };
    // 1. Deep inside zone 0: every neighbour idles.
    await park(R0.x0 + 60 * CELL_WU, R0.y0 + 60 * CELL_WU);
    await settle(1500); // > WAKE_HOLD_MS, so a wake from the login's spawn spot has lapsed
    let v = await hz();
    console.log(`    far from every line: zone 1 ${v[1]} Hz, zone 2 ${v[2]} Hz, zone 3 ${v[3]} Hz`);
    for (const z of [1, 2, 3]) assert.ok(idle(v[z]), `zone ${z} idles with nobody near it (${v[z]} Hz)`);

    // 2. 40 cells from the east line: OUTSIDE zone 1's ghost band (36 cells),
    //    inside its wake band — the player cannot see in yet, and zone 1 is
    //    already at the full rate.
    await park(R0.x1 - 40 * CELL_WU, R0.y0 + 60 * CELL_WU);
    await settle(300);
    v = await hz();
    console.log(`    40 cells from the east line: zone 1 ${v[1]} Hz, zone 2 ${v[2]} Hz, zone 3 ${v[3]} Hz`);
    assert.ok(awake(v[1]), `zone 1 is awake before the player can see into it (${v[1]} Hz)`);
    assert.ok(idle(v[2]) && idle(v[3]), `zones 2 and 3 still idle (${v[2]}, ${v[3]} Hz)`);

    // 3. At the corner: all three wake, the diagonal too.
    await park(R0.x1 - 20 * CELL_WU, R0.y1 - 20 * CELL_WU);
    await settle(300);
    v = await hz();
    console.log(`    at the corner: zone 1 ${v[1]} Hz, zone 2 ${v[2]} Hz, zone 3 ${v[3]} Hz`);
    for (const z of [1, 2, 3]) assert.ok(awake(v[z]), `zone ${z} is awake at the corner (${v[z]} Hz)`);

    // 4. Walk away: WAKE_HOLD_MS later they idle again.
    await park(R0.x0 + 60 * CELL_WU, R0.y0 + 60 * CELL_WU);
    await settle(1500);
    v = await hz();
    console.log(`    away again: zone 1 ${v[1]} Hz, zone 2 ${v[2]} Hz, zone 3 ${v[3]} Hz`);
    for (const z of [1, 2, 3]) assert.ok(idle(v[z]), `zone ${z} idles again once nobody is near (${v[z]} Hz)`);
    r.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});
