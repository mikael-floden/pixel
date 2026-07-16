import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, DEFAULT_TIME_IDX, TIME_PHASE_COUNT } from "@nangijala/shared";
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

test("the world clock advances time on its own", async () => {
  const port = 2986;
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: createServer() }),
  });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);

  try {
    const c1 = new Client(`ws://localhost:${port}`);
    // phaseSeconds is a test-only override of TIME_PHASE_SECONDS.
    const r1 = await c1.joinOrCreate(ROOM_NAME, {
      name: "A",
      character: "char_a",
      phaseSeconds: [0.15, 0.15, 0.15, 0.15],
    });
    await waitFor(() => r1.state.players?.size === 1);
    assert.equal(r1.state.timeIdx, DEFAULT_TIME_IDX);

    // Time starts FROZEN (maintainer: default ON for phase testing) — the
    // clock must NOT move until someone unfreezes it.
    assert.equal(!!r1.state.frozen, true);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(r1.state.timeIdx, DEFAULT_TIME_IDX);

    // Unfreeze: NOBODY sends "timeofday" — the server's own clock moves the
    // world through the phase ring, the same for every player.
    r1.send("freezetime");
    const next = (DEFAULT_TIME_IDX + 1) % TIME_PHASE_COUNT;
    await waitFor(() => r1.state.timeIdx === next);
    const after = (DEFAULT_TIME_IDX + 2) % TIME_PHASE_COUNT;
    await waitFor(() => r1.state.timeIdx === after);

    // A manual skip still works on top of the running clock.
    const skip = (after + 1) % TIME_PHASE_COUNT;
    r1.send("timeofday");
    await waitFor(() => r1.state.timeIdx === skip || r1.state.timeIdx === (skip + 1) % TIME_PHASE_COUNT);

    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

test("unfreezing sticks: the clock survives room recycling", async () => {
  const port = 2991;
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: createServer() }),
  });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);

  try {
    // Unfreeze and move the phase along, then leave — the empty room disposes,
    // exactly what happens around every real-world reconnect.
    const c1 = new Client(`ws://localhost:${port}`);
    const slow = { phaseSeconds: [600, 600, 600, 600] }; // no natural tick mid-test
    const r1 = await c1.joinOrCreate(ROOM_NAME, { name: "A", character: "c", ...slow });
    await waitFor(() => r1.state.players?.size === 1);
    assert.equal(r1.state.frozen, true); // fresh process: the default applies
    r1.send("freezetime");
    await waitFor(() => r1.state.frozen === false);
    r1.send("timeofday");
    const next = (DEFAULT_TIME_IDX + 1) % TIME_PHASE_COUNT;
    await waitFor(() => r1.state.timeIdx === next);
    const firstRoomId = r1.roomId;
    await r1.leave();
    await new Promise((r) => setTimeout(r, 400));

    // The next join gets a FRESH room — which must resume the world's clock,
    // not reset it to the frozen default.
    const r2 = await c1.joinOrCreate(ROOM_NAME, { name: "B", character: "c", ...slow });
    await waitFor(() => r2.state.players?.size === 1);
    assert.notEqual(r2.roomId, firstRoomId); // really a new room
    assert.equal(r2.state.frozen, false); // time kept flowing
    assert.equal(r2.state.timeIdx, next); // on the phase we left it
    await r2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
