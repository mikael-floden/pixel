// ============================================================================
// THE HAND-OFF CARRIES THE BODY AS IT IS AT THE CUT
// ============================================================================
//
// A crossing goes through the CLIENT: the old room writes the body to the bus,
// tells the client where to go, and the client opens a socket to the other room
// — hundreds of ms on a phone. The old room keeps simulating meanwhile, which is
// right, and the client keeps sending it inputs.
//
// The hot state used to be written ONCE, at `zone:go`, so every one of those
// ticks was thrown away: the receiving room adopted a body that old, and the
// client — whose pending-input buffer the OLD room had been acking all the
// while — reconciled onto it and snapped backwards by the distance covered
// during the join (maintainer 2026-09-13: "Why does the player lag and
// sometimes teleport backwards when running from one zone to another?"; and his
// own answer: "Why can't the old zone continue handling the player and hand it
// over with the most recent data when the transfer is ready?").
//
// It now does: the document is rewritten every tick under the same capability,
// so what the new room adopts is the body's live position, elevation and — the
// one that makes the client's reconciliation continuous — the `seq` the old
// room has actually acked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, CELL_WU, zoneGrid, zoneRect } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks } from "../src/rooms/WorldRoom.js";
import { FakeBus, useBus } from "../src/bus.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HAVE_WORLD = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"));
const CFG = { cols: 2, rows: 2 };
const GRID = zoneGrid(CFG, 394, 394, CELL_WU);
const BORDER_X = zoneRect(GRID, 0).x1;

async function waitFor(cond: () => boolean, timeout = 5000, what = "condition"): Promise<void> {
  const start = Date.now();
  const ready = () => { try { return cond(); } catch { return false; } };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the receiving room adopts the body the old room has NOW, at the seq it has acked", async (t) => {
  if (!HAVE_WORLD) return t.skip("maps2/worlds3/the_game missing");
  useBus(new FakeBus());
  resetWorldClocks();
  // UNIQUE ACROSS TEST FILES — node:test runs files concurrently, so a shared
  // literal races to bind and the loser waits forever. `ports.test.ts` gates it.
  const port = 2982;
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, monsterCount: 0, interestRadius: 0 };
  try {
    const cA = new Client(`ws://localhost:${port}`);
    const rA: any = await cA.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Runner", character: "default_boy" });
    await waitFor(() => rA.state.players.size === 1, 8000, "joined zone 0");
    const pid = rA.sessionId;
    const y = 100 * CELL_WU;
    rA.send("teleport", { x: BORDER_X - 3 * CELL_WU, y });
    await waitFor(() => Math.abs(rA.state.players.get(pid).x - (BORDER_X - 3 * CELL_WU)) < 1, 5000, "parked at the border");

    // THE CROSSING. One step over the line and the old room writes the hot
    // state and sends `zone:go` — this is the moment the old code froze.
    const go = new Promise<{ zone: number; pid: string; key: string; seq: number }>((res) => rA.onMessage("zone:go", res));
    rA.send("teleport", { x: BORDER_X + 2 * CELL_WU, y });
    const msg = await go;
    await settle(60); // let the teleport's own patch land before reading
    const atGo = { x: rA.state.players.get(pid).x, y: rA.state.players.get(pid).y, seq: rA.state.players.get(pid).seq };

    // THE JOIN TAKES TIME, and the body keeps running through it: the client
    // is still sending this room inputs (a phone's join is hundreds of ms).
    // Walk for ~600 ms of them, then stand still so the body has one settled
    // position to compare against.
    let seq = (atGo.seq ?? 0) + 1;
    for (let i = 0; i < 12; i++) {
      rA.send("input", { ax: 1, ay: 0, running: true, seq: seq++, dt: 1 / 20 });
      await settle(50);
    }
    rA.send("input", { ax: 0, ay: 0, running: false, seq: seq++, dt: 1 / 20 });
    await settle(250);
    const live = { x: rA.state.players.get(pid).x, y: rA.state.players.get(pid).y, seq: rA.state.players.get(pid).seq };
    const ran = Math.hypot(live.x - atGo.x, live.y - atGo.y);
    assert.ok(ran > CELL_WU, `the old room must keep simulating a body mid-hand-off (it moved ${ran.toFixed(0)} wu)`);
    assert.ok(live.seq > atGo.seq, `and keep acking its inputs (seq ${atGo.seq} -> ${live.seq})`);

    // NOW the client binds the other room, exactly as `zoneGo` does.
    const cA2 = new Client(`ws://localhost:${port}`);
    const rA2: any = await cA2.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Runner", character: "default_boy", pid: msg.pid, handoff: msg.key });
    await waitFor(() => rA2.state.players.get(pid)?.sid === rA2.sessionId, 5000, "the body is in zone 1 under the same id");
    const me2 = rA2.state.players.get(pid);

    // THE CLAIM: what it adopted is the body as of the cut, not as of zone:go.
    const off = Math.hypot(me2.x - live.x, me2.y - live.y);
    assert.ok(off < CELL_WU, `the adopted body is ${off.toFixed(0)} wu from where the old room had it (was ${ran.toFixed(0)} wu behind, at the zone:go snapshot)`);
    assert.equal(me2.seq, live.seq, "and it carries the seq the old room had acked — the client reconciles onto this");
    // ...which is exactly what the client replays from. `zone:go`'s own seq is
    // only where the crossing was NOTICED, and replaying from it here would
    // re-integrate everything the old room already did.
    assert.ok(me2.seq > msg.seq, `the adopted seq (${me2.seq}) is past the one zone:go named (${msg.seq})`);
    await waitFor(() => !rA.state.players.has(pid), 5000, "zone 0 let go");
    console.log(`    crossing: the body ran ${ran.toFixed(0)} wu during the join; adopted ${off.toFixed(1)} wu from its live spot, seq ${msg.seq} -> ${me2.seq}`);
    rA.leave(); rA2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});
