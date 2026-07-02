import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME } from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";

async function waitFor(cond: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("two clients share one authoritative world and see each other move", async () => {
  const port = 2999;
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: createServer() }),
  });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);

  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const c2 = new Client(`ws://localhost:${port}`);
    const r1 = await c1.joinOrCreate(ROOM_NAME, { name: "A", character: "char_a" });
    const r2 = await c2.joinOrCreate(ROOM_NAME, { name: "B", character: "char_b" });

    // Both clients converge on the same world of 2 players.
    await waitFor(() => r1.state.players.size === 2 && r2.state.players.size === 2);

    const aId = r1.sessionId;
    // Client 2 can see client 1's identity in the shared state.
    assert.equal(r2.state.players.get(aId)!.name, "A");
    assert.equal(r2.state.players.get(aId)!.character, "char_a");

    const startX = r2.state.players.get(aId)!.x;

    // Client 1 walks east, streaming inputs with their durations like the
    // real client does (the server integrates each input's dt).
    const stream = setInterval(() => r1.send("input", { ax: 1, ay: 0, running: false, dt: 0.05 }), 40);
    try {
      await waitFor(() => r2.state.players.get(aId)!.x > startX + 5);
    } finally {
      clearInterval(stream);
    }

    const p = r2.state.players.get(aId)!;
    assert.ok(p.x > startX, "client 2 sees client 1 move east");
    assert.equal(p.dir, "east", "direction synced from authoritative server");
    assert.equal(p.moving, true);

    r1.send("input", { ax: 0, ay: 0, running: false, dt: 0.05 });
    await r1.leave();
    // Leaving removes the player from the shared world for everyone.
    await waitFor(() => r2.state.players.size === 1);

    await r2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
