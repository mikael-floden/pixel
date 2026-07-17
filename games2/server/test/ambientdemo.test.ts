// The {v} extension of the "timeofday"/"weather" world-state messages
// (games-ambient's demo button jumps the shared world to an effect's
// preferred conditions). Contract: a VALID integer v SETS the value for
// every client; anything else keeps the legacy cycle semantics.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, DEFAULT_TIME_IDX, TIME_PHASE_COUNT, WEATHER_COUNT } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks } from "../src/rooms/WorldRoom.js";

beforeEach(() => resetWorldClocks());

async function waitFor(cond: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("timeofday/weather {v} jump the shared world state directly", async () => {
  const port = 2983; // unique per test file — 2984+ are taken (aurora..sync)
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

    // Jump straight to Night (0) — both clients see it, mid-phase look.
    r1.send("timeofday", { v: 0 });
    await waitFor(() => r1.state.timeIdx === 0 && r2.state.timeIdx === 0);
    assert.equal(r1.state.phaseT, 0.5);

    // Jump to a cloudy sky (1) — a direct set, not a cycle.
    r1.send("weather", { v: 1 });
    await waitFor(() => r1.state.weather === 1 && r2.state.weather === 1);
    // Setting the SAME value again is a no-op, not a cycle.
    r1.send("weather", { v: 1 });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(r2.state.weather, 1);

    // Out-of-range / non-integer v falls back to the legacy cycle.
    r1.send("weather", { v: 99 });
    await waitFor(() => r2.state.weather === 2 % WEATHER_COUNT);
    r1.send("timeofday", { v: 1.5 });
    await waitFor(() => r2.state.timeIdx === 1); // Night -> cycle +1
    assert.notEqual(DEFAULT_TIME_IDX, 0); // guard: the jump above was a real move
    assert.ok(TIME_PHASE_COUNT > 1);

    await r1.leave();
    await r2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
