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
import { ROOM_NAME, DEFAULT_TIME_IDX, TIME_PHASE_COUNT } from "@nangijala/shared";
import { isCompatibleSet, unpackAmbient } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks } from "../src/rooms/WorldRoom.js";

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

// Since 2026-09-18 weather is the room's ACTIVE AMBIENT SET (state.ambient),
// not an index — the "ambient" message with a {set} is the direct jump.
test("timeofday {v} and ambient {set} jump the shared world state directly", async () => {
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

    // The world clock RUNS at x1 by default (2026-07-31), so phaseT sweeps
    // every tick. This test asserts the exact mid-phase look a {v} jump lands
    // on, which only holds while the clock is still — freeze it first.
    r1.send("timespeed", { v: 0 });
    await waitFor(() => r1.state.frozen === true);

    // Jump straight to Night (0) — both clients see it, mid-phase look.
    r1.send("timeofday", { v: 0 });
    await waitFor(() => r1.state.timeIdx === 0 && r2.state.timeIdx === 0);
    assert.equal(r1.state.phaseT, 0.5);

    // Jump to a cloudy sky — a direct set, both clients see it.
    r1.send("ambient", { set: ["cloudy"] });
    await waitFor(() => r1.state.ambient === "cloudy" && r2.state.ambient === "cloudy");
    // Setting the SAME set again is a no-op, not a re-roll.
    r1.send("ambient", { set: ["cloudy"] });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(r2.state.ambient, "cloudy");

    // No set at all = a re-roll: shared by both, and always a set the
    // compatibility matrix allows.
    r1.send("ambient", {});
    await waitFor(() => r1.state.ambient === r2.state.ambient && isCompatibleSet(unpackAmbient(r2.state.ambient)));
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
