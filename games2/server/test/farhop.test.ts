// ============================================================================
// A RESPAWN OR TELEPORT INTO ANOTHER ZONE IS A HOP, AND THE WIRE NEVER SHOWS
// THE CLAMP
// ============================================================================
//
// Wire positions are int16 quarter world units from the room's corner, so a
// room can express ±8191.75 wu around itself — plenty for every body it steps,
// and not for a body a handler PUTS far away. The spawn of the_game lies in the
// south-east; a revive there from a west-column zone, or a far debug teleport,
// wrote the target into the old room's body, and the clamp showed the client
// its own body 77.5 cells short of the truth until the hop landed on the next
// tick's notice, where the relocation veil marked its arrival on that snap.
//
// Now: the wire holds the last in-range position until the hop lands (a body
// never synced in range still clamps — nothing truer to hold), and the revive
// and teleport handlers start the hand-off themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, CELL_WU, zoneGrid, zoneRect, zoneAt } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks } from "../src/rooms/WorldRoom.js";
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
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("a far teleport and a respawn into another zone hop at once, and the wire holds the last true spot instead of the clamp", async (t) => {
  if (!HAVE_WORLD) return t.skip("maps2/worlds3/the_game missing");
  useBus(new FakeBus());
  resetWorldClocks();
  const port = 3048; // unique across test files — ports.test.ts gates it
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, monsterCount: 0, interestRadius: 0 };
  try {
    const c = new Client(`ws://localhost:${port}`);
    const r: any = await c.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Far", character: "default_boy" });
    const pid = r.sessionId;
    const S0: any = matchMaker.getLocalRoomById(r.roomId);
    await waitFor(() => S0.state.players.has(pid), 8000, "joined zone 0");
    S0.state.players.get(pid).handoff = null; // the login's own spawn hop is not this test
    // Deep inside zone 0, far from every line: the wire can express this.
    const park = { x: R0.x0 + 30 * CELL_WU, y: R0.y0 + 30 * CELL_WU };
    r.send("teleport", park);
    await waitFor(() => Math.abs(S0.state.players.get(pid).x - park.x) < 1 && Math.abs(r.state.players.get(pid).x - park.x) < 1, 10000, "parked, on the wire too");
    const goes: any[] = [];
    r.onMessage("zone:go", (m: any) => goes.push({ ...m, at: Date.now() }));

    // 1. A FAR TELEPORT: the south-east corner of the map, beyond what zone 0's
    //    wire can express (the truth is > 8191.75 wu from its corner).
    const far = { x: GRID.w - 20 * CELL_WU, y: GRID.h - 20 * CELL_WU }; // the grid is in wu
    assert.ok(far.x - R0.x0 > 8192 && far.y - R0.y0 > 8192, "the target is outside the int16 window");
    const farZone = zoneAt(GRID, far.x, far.y);
    assert.notEqual(farZone, 0);
    const t0 = Date.now();
    r.send("teleport", far);
    await waitFor(() => goes.length > 0, 8000, "zone:go");
    const goMs = goes[0].at - t0;
    assert.equal(goes[0].zone, farZone, "the hop goes where the body was put");
    await settle(120); // a couple of patches from the old room
    const wire = r.state.players.get(pid);
    const truth = S0.state.players.get(pid);
    const clamped = { x: R0.x0 + 32767 / 4, y: R0.y0 + 32767 / 4 };
    console.log(`    far teleport: zone:go ${goMs} ms after the request; truth (${truth.x.toFixed(0)},${truth.y.toFixed(0)}), wire shows (${wire.x.toFixed(0)},${wire.y.toFixed(0)}); the clamp would show (${clamped.x.toFixed(0)},${clamped.y.toFixed(0)})`);
    assert.ok(Math.hypot(truth.x - far.x, truth.y - far.y) < 1, "the server body is at the target");
    assert.ok(Math.hypot(wire.x - park.x, wire.y - park.y) < 1, `the wire holds the last true spot (it showed the clamp, ${(Math.hypot(clamped.x - far.x, clamped.y - far.y) / CELL_WU).toFixed(1)} cells short, on the old code)`);
    // ...and the hop lands where the body really is.
    const c2 = new Client(`ws://localhost:${port}`);
    const r2: any = await c2.joinOrCreate(ROOM_NAME, { ...base, zone: farZone, name: "Far", character: "default_boy", pid, handoff: goes[0].key });
    await waitFor(() => r2.state.players.get(pid)?.sid === r2.sessionId, 10000, "adopted where the body was put");
    await waitFor(() => Math.hypot(r2.state.players.get(pid).x - far.x, r2.state.players.get(pid).y - far.y) < 1, 8000, "the new room's wire shows the truth");
    await waitFor(() => !S0.state.players.has(pid), 5000, "zone 0 let go");
    r.leave();

    // 2. A RESPAWN into another zone (the spawn lies in the south-east: zone
    //    3 of this grid) from zone 0, west: the same hop, from the revive.
    const c3 = new Client(`ws://localhost:${port}`);
    const r3: any = await c3.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Dead", character: "default_boy" });
    const pid3 = r3.sessionId;
    await waitFor(() => S0.state.players.has(pid3), 8000, "a second login in zone 0");
    S0.state.players.get(pid3).handoff = null;
    r3.send("teleport", park);
    await waitFor(() => Math.abs(r3.state.players.get(pid3).x - park.x) < 1, 10000, "parked, on the wire");
    const goes3: any[] = [];
    r3.onMessage("zone:go", (m: any) => goes3.push({ ...m, at: Date.now() }));
    const b3 = S0.state.players.get(pid3);
    S0.hurtPlayer(b3, 9999, Date.now());
    assert.equal(b3.dead, true);
    b3.respawnAt = 0; // the die clip is done
    const t1 = Date.now();
    r3.send("respawn");
    await waitFor(() => goes3.length > 0, 8000, "zone:go from the revive");
    const spawnZone = zoneAt(GRID, S0.state.players.get(pid3).x, S0.state.players.get(pid3).y);
    console.log(`    respawn: revived into zone ${spawnZone}, zone:go ${goes3[0].at - t1} ms after the press`);
    assert.notEqual(spawnZone, 0, "the spawn lies in another zone of this grid");
    assert.equal(goes3[0].zone, spawnZone);
    await settle(120);
    const w3 = r3.state.players.get(pid3);
    assert.ok(Math.hypot(w3.x - park.x, w3.y - park.y) < 1, `the wire holds the death spot until the hop lands, not the clamp (shows ${w3.x.toFixed(0)},${w3.y.toFixed(0)})`);
    r3.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});
