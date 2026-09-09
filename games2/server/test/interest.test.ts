import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "fs";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, INTEREST_WU, INTEREST_LEAVE_WU, CELL_WU } from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HAVE_WORLD = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"));
const SKIP = "maps2/worlds3/the_game missing";

async function waitFor(cond: () => boolean, timeout = 4000, what = "condition"): Promise<void> {
  const start = Date.now();
  const ready = () => { try { return cond(); } catch { return false; } };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/** INTEREST MANAGEMENT (spec/ZONES.md): a client receives only what is within
 *  INTEREST_WU of its own player, keeps it to INTEREST_LEAVE_WU, and always
 *  has itself. Two clients on the_game's spawn see each other; one teleported
 *  past the rim leaves the other's state; back inside the radius it returns;
 *  a monster in the room is in exactly the views it is near. */
test("a client sees only the players within its interest radius, itself always", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2972;
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const c2 = new Client(`ws://localhost:${port}`);
    const r1: any = await c1.joinOrCreate(ROOM_NAME, { name: "Near", character: "default_boy", monsterCount: 0 });
    const r2: any = await c2.joinOrCreate(ROOM_NAME, { name: "Far", character: "default_girl" });
    await waitFor(() => r1.state.players.size === 2 && r2.state.players.size === 2, 6000, "both at the spawn");
    const me1 = r1.state.players.get(r1.sessionId);
    assert.ok(me1, "own player is in the first snapshot");
    const x0 = me1.x, y0 = me1.y;

    // Past the leave rim: gone from each other's state, still in their own.
    r2.send("teleport", { x: x0 + INTEREST_LEAVE_WU + 4 * CELL_WU, y: y0 });
    await waitFor(() => r1.state.players.size === 1 && r2.state.players.size === 1, 4000, "the far player leaves both views");
    assert.ok(r1.state.players.get(r1.sessionId), "Near still sees itself");
    assert.ok(r2.state.players.get(r2.sessionId), "Far still sees itself");

    // Inside the enter radius again: back in both.
    r2.send("teleport", { x: x0 + INTEREST_WU - 2 * CELL_WU, y: y0 });
    await waitFor(() => r1.state.players.size === 2 && r2.state.players.size === 2, 4000, "the player returns");
    assert.equal(r1.state.players.get(r2.sessionId)?.name, "Far");

    // HYSTERESIS: between enter and leave a body already seen is KEPT.
    r2.send("teleport", { x: x0 + INTEREST_WU + 2 * CELL_WU, y: y0 });
    await settle(600);
    assert.equal(r1.state.players.size, 2, "inside the rim a seen body stays");

    // Every field of a visible player syncs: a move by Far is seen by Near.
    const fx = r1.state.players.get(r2.sessionId).x;
    r2.send("teleport", { x: fx - CELL_WU, y: y0 });
    await waitFor(() => r1.state.players.get(r2.sessionId)?.x < fx, 4000, "a visible body's move syncs");
    r1.leave(); r2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

test("interestRadius 0 is the whole room, and monsters follow the same rule", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2973;
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["interestRadius"]);
  await gameServer.listen(port);
  try {
    const cAll = new Client(`ws://localhost:${port}`);
    const rAll: any = await cAll.joinOrCreate(ROOM_NAME, { name: "All", character: "default_boy", interestRadius: 0, monsterSeed: 7 });
    await waitFor(() => rAll.state.players.size === 1 && rAll.state.monsters.size > 0, 8000, "unlimited join");
    await settle(500);
    const total = rAll.state.monsters.size;
    assert.ok(total > 50, `an unlimited view holds the whole roster (${total})`);
    // The same world under the default radius, from the spawn: a strict subset.
    const cNear = new Client(`ws://localhost:${port}`);
    const rNear: any = await cNear.joinOrCreate(ROOM_NAME, { name: "Some", character: "default_boy", interestRadius: INTEREST_WU, monsterSeed: 7 });
    await waitFor(() => rNear.state.players.size === 1, 6000, "radius join");
    await settle(600);
    const near = rNear.state.monsters.size;
    assert.ok(near < total, `the radius view is a strict subset (${near} < ${total})`);
    const me = rNear.state.players.get(rNear.sessionId);
    rNear.state.monsters.forEach((m: any) => {
      const d = Math.max(Math.abs(m.x - me.x), Math.abs(m.y - me.y));
      assert.ok(d <= INTEREST_LEAVE_WU + 64, `a visible monster is within the rim (${d.toFixed(0)} wu)`);
    });
    rAll.leave(); rNear.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
