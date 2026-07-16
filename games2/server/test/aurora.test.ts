import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, DEFAULT_TIME_IDX } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks } from "../src/rooms/WorldRoom.js";

// The per-world clock registry outlives rooms BY DESIGN; tests in one file
// share a process, so start each from the frozen default.
beforeEach(() => resetWorldClocks());

async function waitFor(cond: () => boolean, timeout = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("aurora nights are rolled as night falls and end by morning", async () => {
  const port = 2984;
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: createServer() }),
  });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);

  try {
    const c1 = new Client(`ws://localhost:${port}`);
    // Fast clock + guaranteed aurora so the roll is deterministic.
    const r1 = await c1.joinOrCreate(ROOM_NAME, {
      name: "A",
      character: "char_a",
      phaseSeconds: [0.15, 0.15, 0.15, 0.15],
      auroraChance: 1,
    });
    await waitFor(() => r1.state.players?.size === 1);
    assert.equal(r1.state.timeIdx, DEFAULT_TIME_IDX);
    assert.equal(!!r1.state.aurora, false); // day: no aurora
    r1.send("timespeed", { v: 1 }); // time starts frozen by default — let it flow

    // Night falls -> the lights come out (chance forced to 1).
    await waitFor(() => r1.state.timeIdx === 0 && r1.state.aurora === true);
    // Morning -> gone.
    await waitFor(() => r1.state.timeIdx === 1 && r1.state.aurora === false);

    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
