import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME } from "@nangijala/shared";
import { WorldRoom, perfStats, resetWorldClocks } from "../src/rooms/WorldRoom.js";
import { FakeBus, useBus } from "../src/bus.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HAVE_WORLD = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"));
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** AN EMPTY ROOM TICKS ITS SIM SLOWER (docs/backend.md): with nobody
 *  connected the brains run at 20 / IDLE_DIVISOR Hz; a client brings the
 *  full rate back on its first tick. */
test("an empty room runs its sim at a quarter rate; a client restores it", async (t) => {
  if (!HAVE_WORLD) return t.skip("maps2/worlds3/the_game missing");
  const port = 2965;
  useBus(new FakeBus());
  resetWorldClocks();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  try {
    const room = await matchMaker.createRoom(ROOM_NAME, { world: "the_game", zonesCfg: { cols: 2, rows: 2 }, zone: 1, monsterSeed: 3 });
    perfStats(); // reset the window
    await settle(2000);
    const idle = perfStats().rooms.find((r) => r.id === room.roomId)!;
    assert.ok(idle, "the room reports");
    assert.ok(idle.simHz >= 3.5 && idle.simHz <= 7, `idle sim rate is ~5 Hz (${idle.simHz})`);
    const c = new Client(`ws://localhost:${port}`);
    const r: any = await c.joinById(room.roomId, { name: "A", character: "default_boy" });
    await settle(300);
    perfStats();
    await settle(2000);
    const busy = perfStats().rooms.find((x) => x.id === room.roomId)!;
    assert.ok(busy.simHz >= 16, `with a client the sim runs at the tick rate (${busy.simHz})`);
    r.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});
