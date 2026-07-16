import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks } from "../src/rooms/WorldRoom.js";

// The per-world clock registry outlives rooms BY DESIGN; tests in one file
// share a process, so start each from the frozen default.
beforeEach(() => resetWorldClocks());

async function waitFor(cond: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("every arrival is announced by a shooting star broadcast", async () => {
  const port = 2985;
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: createServer() }),
  });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);

  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const r1 = await c1.joinOrCreate(ROOM_NAME, { name: "A", character: "char_a" });
    const stars: { name?: string }[] = [];
    r1.onMessage("star", (msg: { name?: string }) => stars.push(msg));
    await waitFor(() => r1.state.players?.size === 1);

    // A second player arrives: the player already in the world sees the star.
    const c2 = new Client(`ws://localhost:${port}`);
    const r2 = await c2.joinOrCreate(ROOM_NAME, { name: "B", character: "char_b" });
    const stars2: { name?: string }[] = [];
    r2.onMessage("star", (msg: { name?: string }) => stars2.push(msg));
    await waitFor(() => stars.some((s) => s.name === "B"));

    // ...and the newcomer sees their own arrival star too.
    const c3 = new Client(`ws://localhost:${port}`);
    const r3 = await c3.joinOrCreate(ROOM_NAME, { name: "C", character: "char_c" });
    await waitFor(() => stars2.some((s) => s.name === "C") && stars.some((s) => s.name === "C"));

    await r1.leave();
    await r2.leave();
    await r3.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
