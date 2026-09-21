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

/** ...BUT A ROOM SOMEBODY IS WATCHING FROM THE OTHER SIDE OF A BORDER IS NOT
 *  IDLE (maintainer 2026-09-21, seven screenshots at the four-zone cross
 *  297.2,96.4: "the monsters lag a lot when they walk ... they disappear and
 *  appear back and forth"). The edge snapshot is published from inside the sim
 *  step, so the divisor divided it too: an unwatched neighbour published its
 *  band at 2.5 Hz and its monsters moved in one 200 ms leap per publish, while
 *  a player standing at the border — not a client of that room — could not
 *  wake it. MEASURED at his corner before the fix: his own zone's monsters
 *  updated every 51 ms, the neighbours' every 416 ms; with a client parked in
 *  each neighbour, 102 ms. A GHOST PLAYER is the watcher's signature and costs
 *  no message: it exists only because a neighbour with a client published its
 *  band, which is what lies within GHOST_BAND_WU of the shared edge. */
test("a room a neighbour's player is watching runs at the full rate; it idles again when he leaves", async (t) => {
  if (!HAVE_WORLD) return t.skip("maps2/worlds3/the_game missing");
  const port = 2966;
  useBus(new FakeBus());
  resetWorldClocks();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const CFG = { cols: 2, rows: 2 };
  const GRID = zoneGrid(CFG, 394, 394, CELL_WU);
  const BORDER_X = zoneRect(GRID, 0).x1; // zones 0 | 1
  const base = { world: "the_game", zonesCfg: CFG, monsterSeed: 3 };
  try {
    // Zone 1 is the WATCHED room: nobody ever joins it. The player stands in
    // zone 0, three cells from their shared edge — inside the ghost band.
    const watched = await matchMaker.createRoom(ROOM_NAME, { ...base, zone: 1 });
    const home = await matchMaker.createRoom(ROOM_NAME, { ...base, zone: 0 });
    perfStats();
    await settle(2000);
    const before = perfStats().rooms.find((r) => r.id === watched.roomId)!;
    assert.ok(before.simHz >= 3.5 && before.simHz <= 7, `with nobody near it the room idles (${before.simHz} Hz)`);

    const c = new Client(`ws://localhost:${port}`);
    const r: any = await c.joinById(home.roomId, { name: "Watcher", character: "default_boy" });
    r.onMessage("zone:go", () => {}); // never follow a hop in this test
    await settle(300);
    r.send("teleport", { x: BORDER_X - 3 * CELL_WU, y: 100 * CELL_WU });
    // The wake is the ghost: wait for zone 1 to hold him before measuring.
    const seen = async () => {
      for (let i = 0; i < 100; i++) {
        if (perfStats().rooms.find((x) => x.id === watched.roomId)?.ghosts ?? 0) return true;
        await settle(100);
      }
      return false;
    };
    assert.ok(await seen(), "the watched room mirrors the player as a ghost");
    perfStats();
    await settle(2000);
    const busy = perfStats().rooms.find((x) => x.id === watched.roomId)!;
    assert.ok(
      busy.simHz >= 16,
      `a room whose band holds a real player runs at the tick rate (${busy.simHz} Hz; it ran at a quarter of it, so his ghosts moved at 2.5 Hz)`,
    );

    // ...and it goes back to sleep once he walks out of the band.
    r.send("teleport", { x: 20 * CELL_WU, y: 100 * CELL_WU });
    for (let i = 0; i < 100; i++) {
      if (!(perfStats().rooms.find((x) => x.id === watched.roomId)?.ghosts ?? 0)) break;
      await settle(100);
    }
    perfStats();
    await settle(2000);
    const again = perfStats().rooms.find((x) => x.id === watched.roomId)!;
    assert.ok(again.simHz <= 8, `nobody watching, so it idles again (${again.simHz} Hz)`);
    r.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});
