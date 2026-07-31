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
      phaseSeconds: [0.05, 0.05, 0.05, 0.05],
    });
    await waitFor(() => r1.state.players?.size === 1);
    // NB: no assertion on the STARTING phase here — this room's phases are
    // 0.05s and the clock runs by default, so it may legitimately have moved
    // on already. `heldAt` below reads whatever phase we actually froze at.

    // Time RUNS BY DEFAULT at x1 (maintainer 2026-07-31). Freezing must still
    // hold the clock still — that is the half of the contract a default flip
    // could silently break.
    assert.equal(!!r1.state.frozen, false);
    assert.equal(r1.state.timeSpeed, 1);
    r1.send("timespeed", { v: 0 });
    await waitFor(() => r1.state.frozen === true);
    const heldAt = r1.state.timeIdx;
    await new Promise((r) => setTimeout(r, 150)); // 3 phases at 0.05s each
    assert.equal(r1.state.timeIdx, heldAt, "a frozen clock must not advance");

    // Let it run again: NOBODY sends "timeofday" — the server's own clock
    // moves the world through the phase ring, the same for every player.
    r1.send("timespeed", { v: 1 });
    const next = (heldAt + 1) % TIME_PHASE_COUNT;
    await waitFor(() => r1.state.timeIdx === next);
    const after = (heldAt + 2) % TIME_PHASE_COUNT;
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
    assert.equal(r1.state.frozen, false); // fresh process: x1 is the default
    r1.send("timeofday");
    const next = (DEFAULT_TIME_IDX + 1) % TIME_PHASE_COUNT;
    await waitFor(() => r1.state.timeIdx === next);
    const firstRoomId = r1.roomId;
    await r1.leave();
    await new Promise((r) => setTimeout(r, 250)); // let the empty room dispose

    // The next join gets a FRESH room — which must RESUME the world's clock
    // (phase and speed) rather than re-applying the boot default.
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

test("time is continuous: phaseT sweeps while unfrozen, skips land mid-phase", async () => {
  const port = 2992;
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: createServer() }),
  });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);

  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const r1 = await c1.joinOrCreate(ROOM_NAME, { name: "A", character: "c", phaseSeconds: [1, 1, 1, 1] });
    await waitFor(() => r1.state.players?.size === 1);
    // The clock runs at x1 by default now, so the "a skip lands mid-phase"
    // half of this test needs it held still; the sweep half unfreezes below.
    r1.send("timespeed", { v: 0 });
    await waitFor(() => r1.state.frozen === true);
    assert.equal(r1.state.phaseT, 0.5); // boots on the phase's characteristic look
    r1.send("timeofday"); // manual skip while frozen
    const next = (DEFAULT_TIME_IDX + 1) % TIME_PHASE_COUNT;
    await waitFor(() => r1.state.timeIdx === next);
    assert.equal(r1.state.phaseT, 0.5); // skips land MID-phase, the approved look
    r1.send("timespeed", { v: 1 }); // let time flow
    await waitFor(() => r1.state.frozen === false);
    // POLL for the sweep instead of sleeping a fixed 600ms — same assertion,
    // but it returns as soon as phaseT has actually moved (1s phases put it
    // past 0.6 in ~100ms) and still fails if the clock never sweeps.
    await waitFor(() => r1.state.phaseT > 0.6);
    const t1 = r1.state.phaseT;
    assert.ok(t1 > 0.6, `phaseT must sweep continuously while unfrozen (got ${t1})`);
    r1.send("timespeed", { v: 0 }); // freeze mid-sweep: progress must hold
    await waitFor(() => r1.state.frozen === true);
    const held = r1.state.phaseT;
    // A NEGATIVE assertion ("it did not move") genuinely needs elapsed time —
    // but only enough to cover several sim ticks (50ms each) and a chunk of a
    // phase. 150ms is 3 ticks and 15% of a phase here.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(r1.state.phaseT, held);
    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

test("time speed: the switch cycles x0->x0.5->x1->x2->x5->x10 and scales the clock", async () => {
  const port = 2993;
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: createServer() }),
  });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);

  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const r1 = await c1.joinOrCreate(ROOM_NAME, { name: "A", character: "c", phaseSeconds: [1, 1, 1, 1] });
    await waitFor(() => r1.state.players?.size === 1);
    assert.equal(r1.state.timeSpeed, 1); // x1 is the boot default (2026-07-31)
    // Start the ring from x0 so the whole cycle is asserted in one known order.
    r1.send("timespeed", { v: 0 });
    await waitFor(() => r1.state.timeSpeed === 0);
    const seen: number[] = [];
    let prev = r1.state.timeSpeed;
    for (let i = 0; i < 6; i++) {
      r1.send("timespeed", {}); // no value = cycle
      await waitFor(() => r1.state.timeSpeed !== prev);
      prev = r1.state.timeSpeed;
      seen.push(prev);
    }
    assert.deepEqual(seen, [0.5, 1, 2, 5, 10, 0]);

    // x10 on 2s phases: a phase rolls over in ~200ms.
    r1.send("timespeed", { v: 10 });
    await waitFor(() => r1.state.timeSpeed === 10);
    const idx0 = r1.state.timeIdx;
    await waitFor(() => r1.state.timeIdx !== idx0, 1500);
    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

test("no hand-off hold: the clock flows straight through sunset and sunrise", async () => {
  const port = 2994;
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: createServer() }),
  });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);

  try {
    const c1 = new Client(`ws://localhost:${port}`);
    // Until 2026-07-31 a natural rollover into NIGHT or MORNING froze the
    // world clock (phaseT pinned at 0) for 1.25s of WALL time while every
    // client's half-dial spun its hand 180°. The clock pill runs the sun and
    // moon on a continuous belt now — an exit on the right IS an entry on the
    // left — so the sim never stops. Night/morning are sized so that under
    // the old hold phaseT would still read 0 when these waits time out.
    const r1 = await c1.joinOrCreate(ROOM_NAME, {
      name: "A",
      character: "c",
      phaseSeconds: [0.7, 0.55, 0.2, 0.2],
    });
    await waitFor(() => r1.state.players?.size === 1);
    r1.send("timespeed", { v: 1 });
    await waitFor(() => r1.state.timeSpeed === 1);

    // SUNSET: evening rolls naturally into night, and the clock keeps ticking.
    await waitFor(() => r1.state.timeIdx === 0, 3000);
    await waitFor(() => r1.state.timeIdx === 0 && r1.state.phaseT > 0.15, 1100);

    // SUNRISE: the other former hand-off, same story.
    await waitFor(() => r1.state.timeIdx === 1, 3000);
    await waitFor(() => r1.state.timeIdx === 1 && r1.state.phaseT > 0.15, 1100);
    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
