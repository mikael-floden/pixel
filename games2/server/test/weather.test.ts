import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, WEATHER_COUNT } from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";

async function waitFor(cond: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("weather is server-owned world state every client sees", async () => {
  const port = 2987;
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

    // Default: clear sky for everyone.
    assert.equal(r1.state.weather, 0);
    assert.equal(r2.state.weather, 0);

    // One client changes the weather; both see it, and it wraps.
    r1.send("weather");
    await waitFor(() => r1.state.weather === 1 && r2.state.weather === 1);
    for (let i = 1; i < WEATHER_COUNT; i++) r2.send("weather");
    await waitFor(() => r1.state.weather === 0 && r2.state.weather === 0, 4000);

    await r1.leave();
    await r2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
