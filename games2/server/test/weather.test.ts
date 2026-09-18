import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME } from "@nangijala/shared";
import { isCompatibleSet, unpackAmbient } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks } from "../src/rooms/WorldRoom.js";

// The per-world clock registry outlives rooms BY DESIGN; tests in one file
// share a process, so start each from the frozen default.
beforeEach(() => resetWorldClocks());

async function waitFor(cond: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  // A predicate that THROWS means "not ready yet", not "fail": room.state and
  // its MapSchemas are undefined until the first patch lands (see games2
  // CLAUDE.md), so every `r.state.players.size` poll issued right after
  // joinOrCreate can raise a TypeError under CI load. Treating that as false
  // is what the caller means; it used to fail the run and block a deploy.
  const ready = () => {
    try {
      return cond();
    } catch {
      return false;
    }
  };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// SINCE 2026-09-18 the field is `ambient` — the room's ACTIVE AMBIENT SET,
// weather included (weather is ordinary ambient effects now). The intent of
// this test is unchanged: server-owned, every client sees the same value, one
// client can change it and the other sees the change.
test("the ambient set is server-owned world state every client sees", async () => {
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

    // A fresh world ROLLS a set (not a blank sky); both clients hold the
    // same one, and whatever it is, it is a set the matrix allows.
    await waitFor(() => typeof r1.state.ambient === "string" && r1.state.ambient === r2.state.ambient);
    assert.ok(isCompatibleSet(unpackAmbient(r1.state.ambient)), `rolled ${r1.state.ambient}`);

    // One client forces a set; both see it.
    r1.send("ambient", { set: ["rain", "thunder"] });
    await waitFor(() => r1.state.ambient === "rain,thunder" && r2.state.ambient === "rain,thunder");

    // An incompatible ask is filtered through the matrix, never applied raw.
    r2.send("ambient", { set: ["snow", "rain", "mist"] });
    await waitFor(() => r1.state.ambient === "snow" && r2.state.ambient === "snow", 4000);

    // No set = re-roll: still shared, still compatible.
    r1.send("ambient", {});
    await waitFor(() => r1.state.ambient === r2.state.ambient && isCompatibleSet(unpackAmbient(r1.state.ambient)), 4000);

    await r1.leave();
    await r2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
