// ============================================================================
// A ROOM PUBLISHES EVERY POSITION IT COMPUTES — none is thrown away
// ============================================================================
//
// Maintainer, 2026-09-22: "I still feel the monsters in my own zone to way way
// smoother vs monsters in a neighbouring zone. Do you know why?"
//
// He is measuring an 8.6x difference in how often a body's position is NEW.
// A monster of his own room arrives at the colyseus patch rate, 20 Hz. A
// monster of a NEIGHBOURING room arrives as a ghost on that room's edge
// snapshot — and a room with no client in it runs its sim inside the idle gate
// at IDLE_DIVISOR-rate, 4.9 Hz measured. With EDGE_TICKS at 2 it then
// published every OTHER step: 2.33 Hz, half of what it had already worked out.
//
// THE INVARIANT THIS GATES: an idle room's edge rate equals its SIM rate. Not
// a target frequency — a statement that the band carries every position the
// room computed, because dropping one is pure loss. It is the cheap half of
// the fix; the half that makes it look smooth is client-side
// (client/src/remoterate.ts, gated by server/test/remoterate.test.ts), because
// no affordable publish rate turns a 4.9 Hz source into a 20 Hz one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, CELL_WU, zoneGrid, zoneRect } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks } from "../src/rooms/WorldRoom.js";
import { FakeBus, useBus, bus } from "../src/bus.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HAVE_WORLD = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"));
const CFG = { cols: 2, rows: 2 };
const GRID = zoneGrid(CFG, 394, 394, CELL_WU);
const BORDER_X = zoneRect(GRID, 0).x1;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("an idle room publishes every position it computes, not every other one", async (t) => {
  if (!HAVE_WORLD) return t.skip("no world");
  const port = 2966;
  useBus(new FakeBus());
  resetWorldClocks();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, interestRadius: 0, monsterSeed: 11 };
  try {
    const cA = new Client(`ws://localhost:${port}`);
    const rA: any = await cA.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Watcher", character: "default_boy" });
    const cB = new Client(`ws://localhost:${port}`);
    const rB: any = await cB.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Warmer", character: "default_girl" });
    await settle(800);
    await rB.leave();                        // zone 1 is now warm + EMPTY = idle
    rA.send("teleport", { x: BORDER_X - 6 * CELL_WU, y: zoneRect(GRID, 0).y0 + 40 * CELL_WU });
    await settle(1200);

    let idleEdges = 0, busyEdges = 0;
    const u1 = bus().subscribe(`zone:the_game:1:edge`, () => { idleEdges++; });
    const u2 = bus().subscribe(`zone:the_game:0:edge`, () => { busyEdges++; });
    const WINDOW = 6000;
    const t0 = Date.now();
    await settle(WINDOW);
    const secs = (Date.now() - t0) / 1000;
    u1(); u2();

    console.log(`[ghostrate] zone 1 (IDLE, no client)  edge snapshots: ${idleEdges} in ${secs.toFixed(1)}s = ${(idleEdges / secs).toFixed(2)} Hz   <- his ghosts`);
    console.log(`[ghostrate] zone 0 (BUSY, he is in it) edge snapshots: ${busyEdges} in ${secs.toFixed(1)}s = ${(busyEdges / secs).toFixed(2)} Hz`);
    console.log(`[ghostrate] a LOCAL monster arrives at the colyseus patch rate = 20 Hz`);
    console.log(`[ghostrate] RATIO local:ghost = ${(20 / Math.max(0.01, idleEdges / secs)).toFixed(1)}x`);

    const idleHz = idleEdges / secs;
    const busyHz = busyEdges / secs;
    // An idle room sims at 20 Hz / IDLE_DIVISOR(4) = 5 Hz, so its edge rate IS
    // its sim rate. 4.0 is the floor with slack for a loaded runner; at
    // EDGE_TICKS = 2 this measured 2.33 and would fail outright.
    assert.ok(idleHz >= 4.0, `an idle room should publish at its ~5 Hz sim rate, measured ${idleHz.toFixed(2)} Hz`);
    assert.ok(idleHz <= 6.0, `...and cannot exceed it — ${idleHz.toFixed(2)} Hz means the idle gate is not holding`);
    // A room with a client in it sims at the full 20 Hz, so the same rule puts
    // its band out at 20 Hz.
    assert.ok(busyHz >= 16.0, `a busy room should publish at ~20 Hz, measured ${busyHz.toFixed(2)} Hz`);
    // The gap he can feel. It cannot reach 1 without un-idling the neighbour,
    // which costs real CPU; this records where it actually stands so a future
    // regression to 8.6x is visible rather than felt.
    assert.ok(20 / idleHz <= 5.0, `local:ghost ratio ${(20 / idleHz).toFixed(1)}x is worse than the 4.1x measured when this shipped`);
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
