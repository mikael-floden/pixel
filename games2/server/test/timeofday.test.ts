import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, DEFAULT_TIME_IDX, TIME_PHASE_COUNT } from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";

async function waitFor(cond: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("time-of-day is server-owned world state every client sees", async () => {
  const port = 2989;
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
    await waitFor(() => r1.state.players.size === 2 && r2.state.players.size === 2);

    // Everyone starts on the shared default phase.
    assert.equal(r1.state.timeIdx, DEFAULT_TIME_IDX);
    assert.equal(r2.state.timeIdx, DEFAULT_TIME_IDX);

    // One client cycles; BOTH clients see the world move to the next phase.
    r1.send("timeofday");
    const next = (DEFAULT_TIME_IDX + 1) % TIME_PHASE_COUNT;
    await waitFor(() => r1.state.timeIdx === next && r2.state.timeIdx === next);

    // Cycling wraps around the phase ring.
    for (let i = 0; i < TIME_PHASE_COUNT; i++) r2.send("timeofday");
    await waitFor(() => r1.state.timeIdx === next && r2.state.timeIdx === next, 4000);

    await r1.leave();
    await r2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
