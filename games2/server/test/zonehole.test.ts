// ============================================================================
// A MONSTER CROSSING A ZONE BORDER IS NEVER INVISIBLE
// ============================================================================
//
// Maintainer, 2026-09-22, with two screenshots one frame apart — a monster
// circled beside the boundary line, then gone: "NO the invisible monster bug
// when crossing a boundary is not gone!"
//
// IT IS NOT A PERFORMANCE BUG, which is why the 2 vCPU / 2 GiB bump did
// nothing for it. Measured on production the same minute he asked: all 16
// rooms at simHz 4.9, worst room tick 9.21 ms against a 50 ms budget, the
// process at 28.6% of one core. The rooms are rate-limited by IDLE_DIVISOR, a
// CONSTANT — not starved. No amount of hardware raises 4.9 Hz.
//
// THE HOLE, from the code:
//   transferMonster publishes the monster to the destination and DELETES it
//   from state.monsters on the very next line. The watcher loses it that tick.
//   It comes back only as a GHOST, and only once the destination broadcasts
//   its border band — publishEdge, which sits INSIDE the idle gate:
//
//     IDLE_DIVISOR(4) x EDGE_TICKS(2) = 8 ticks = 400 ms
//     + INTEREST_TICKS(4)             = 4 ticks = 200 ms for view.add
//     -------------------------------------------------
//     ~600 ms existing nowhere the client can see
//
//   And 400 ms is his NORMAL case, not his worst: he is the only player, so
//   every destination room has clients.length === 0 and is always idle.
//
// WHY THE DESTINATION IS DELIBERATELY EMPTY HERE. A second client in zone 1
// would take that room out of the idle gate and shrink the hole to ~300 ms —
// still a bug, but not HIS bug. The room is warmed by a join and then emptied;
// WorldRoom sets autoDispose = false, so it survives and idles at 5 Hz exactly
// as the warm rooms do in production.
//
// WHAT IS ASSERTED is a continuity invariant, not a duration: sample the
// WATCHER'S OWN VIEW across the crossing and require that the monster is in
// `monsters` or `ghostMonsters` at every sample. A duration threshold would be
// a flake waiting to happen on a loaded runner; "never absent, bar one patch"
// is the property, and the patch allowance is what the measured gap has to
// beat by an order of magnitude.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, CELL_WU, zoneGrid, zoneAt, zoneRect } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks } from "../src/rooms/WorldRoom.js";
import { FakeBus, useBus } from "../src/bus.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HAVE_WORLD = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"));
const SKIP = "maps2/worlds3/the_game missing";
const CFG = { cols: 2, rows: 2 };
const GRID = zoneGrid(CFG, 394, 394, CELL_WU);
const BORDER_X = zoneRect(GRID, 0).x1;

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeout = 20_000, what = "condition") {
  const start = Date.now();
  const ready = () => { try { return cond(); } catch { return false; } };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The longest run of consecutive FALSE samples, in ms. */
function longestGap(samples: Array<{ t: number; ok: boolean }>): { ms: number; from: number } {
  let worst = 0, worstFrom = 0, runStart = -1;
  for (let i = 0; i < samples.length; i++) {
    if (!samples[i].ok) {
      if (runStart < 0) runStart = samples[i].t;
      const run = samples[i].t - runStart;
      if (run > worst) { worst = run; worstFrom = runStart; }
    } else runStart = -1;
  }
  return { ms: worst, from: worstFrom };
}

test("a monster handed to an IDLE neighbour never leaves the watcher's view", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2961; // unique per test file — see server/test/ports.test.ts
  useBus(new FakeBus());
  resetWorldClocks();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  // interestRadius 0 = unlimited, so DISTANCE can never be the reason a sample
  // is false. The only thing being measured is the hand-off.
  const base = { world: "the_game", zonesCfg: CFG, interestRadius: 0, monsterSeed: 11 };
  try {
    const cA = new Client(`ws://localhost:${port}`);
    const rA: any = await cA.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Watcher", character: "default_boy" });

    // Warm zone 1 and then LEAVE it: autoDispose = false keeps the room, and
    // with no client it drops into the idle gate — production's warm rooms.
    const cB = new Client(`ws://localhost:${port}`);
    const rB: any = await cB.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Warmer", character: "default_girl" });
    await waitFor(() => rB.state.players.size >= 1, 20_000, "zone 1 is warm");
    await rB.leave();
    await settle(400); // it is idling now

    await waitFor(() => rA.state.players.size === 1 && rA.state.monsters.size > 0, 20_000, "zone 0 seeded");

    // Stand the watcher ON the border so the crossing happens under its nose,
    // and take the first live monster zone 0 owns.
    const y = zoneRect(GRID, 0).y0 + 40 * CELL_WU;
    rA.send("teleport", { x: BORDER_X - 6 * CELL_WU, y });
    let mid = "";
    rA.state.monsters.forEach((m: any, id: string) => { if (!mid && m.mstate !== "die") mid = id; });
    assert.ok(mid, "zone 0 owns a monster");

    // Park it just INSIDE zone 0, pinned so nothing else moves it.
    rA.send("dbgmonster", { id: mid, x: BORDER_X - 2 * CELL_WU, y, pin: true });
    await waitFor(() => rA.state.monsters.has(mid), 20_000, "the monster is parked in view");
    await settle(600);
    assert.equal(zoneAt(GRID, BORDER_X - 2 * CELL_WU, y), 0, "parked inside zone 0");

    // Sample the WATCHER'S OWN VIEW from here on.
    const visible = () => rA.state.monsters.has(mid) || !!rA.state.ghostMonsters?.has(mid);
    const samples: Array<{ t: number; ok: boolean }> = [];
    let stop = false;
    const sampler = (async () => {
      while (!stop) { samples.push({ t: Date.now(), ok: visible() }); await settle(5); }
    })();

    await settle(200);
    assert.ok(samples.every((s) => s.ok), "visible before the crossing");

    // PUSH IT OVER THE LINE. Room 0's next stepZones sees it is no longer its
    // own and hands it to room 1 — which is idle.
    rA.send("dbgmonster", { id: mid, x: BORDER_X + 2 * CELL_WU, y, pin: true });
    await settle(3000); // far longer than any legitimate hand-off
    stop = true;
    await sampler;

    const gap = longestGap(samples);
    const after = samples.filter((s) => s.t > samples[0].t + 200);
    const ever = after.some((s) => s.ok);
    console.log(`[zonehole] samples=${samples.length} longest invisible gap=${gap.ms} ms; came back=${ever}`);
    assert.ok(ever, "the monster came back into view at all");
    // ONE PATCH of slack (the room patches at 20 Hz, so a sample can land
    // between the state change and its delivery). The measured bug is 400-600
    // ms — an order of magnitude clear of this, so the threshold separates
    // them without resting on runner speed.
    assert.ok(gap.ms <= 120, `the monster was invisible for ${gap.ms} ms while crossing into an idle zone`);
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

/** THE RETURN LEG, which is where an overlap could go wrong in the other
 *  direction: the sender now holds a ghost for a monster it handed away, so a
 *  monster that walks BACK must not arrive as a second copy of itself. The
 *  receiving branch of `monster:xfer` deletes the ghost before setting the
 *  real one, and this is what says so out loud — a duplicate is the failure
 *  mode an overlap invites, and it renders as two monsters standing in one
 *  place, one of which cannot be hit. */
test("a monster handed over and BACK is never invisible and never doubled", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2962;
  useBus(new FakeBus());
  resetWorldClocks();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, interestRadius: 0, monsterSeed: 11 };
  try {
    const cA = new Client(`ws://localhost:${port}`);
    const rA: any = await cA.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Watcher", character: "default_boy" });
    // This time zone 1 KEEPS a client, so it runs at the full 20 Hz. The hole
    // was smaller here (EDGE_TICKS alone, ~300 ms) but it was still a hole.
    const cB = new Client(`ws://localhost:${port}`);
    const rB: any = await cB.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Neighbour", character: "default_girl" });
    await waitFor(() => rA.state.players.size === 1 && rA.state.monsters.size > 0 && rB.state.players.size >= 1, 20_000, "both rooms up");

    const y = zoneRect(GRID, 0).y0 + 40 * CELL_WU;
    rA.send("teleport", { x: BORDER_X - 6 * CELL_WU, y });
    rB.send("teleport", { x: BORDER_X + 6 * CELL_WU, y });
    let mid = "";
    rA.state.monsters.forEach((m: any, id: string) => { if (!mid && m.mstate !== "die") mid = id; });
    assert.ok(mid, "zone 0 owns a monster");
    rA.send("dbgmonster", { id: mid, x: BORDER_X - 2 * CELL_WU, y, pin: true });
    await waitFor(() => rA.state.monsters.has(mid), 20_000, "parked in view");
    await settle(600);

    const samples: Array<{ t: number; ok: boolean }> = [];
    let doubled = 0;
    let stop = false;
    const sampler = (async () => {
      while (!stop) {
        const real = rA.state.monsters.has(mid);
        const ghost = !!rA.state.ghostMonsters?.has(mid);
        if (real && ghost) doubled++;
        samples.push({ t: Date.now(), ok: real || ghost });
        await settle(5);
      }
    })();

    await settle(200);
    rA.send("dbgmonster", { id: mid, x: BORDER_X + 2 * CELL_WU, y, pin: true }); // over
    await settle(1500);
    await waitFor(() => rB.state.monsters.has(mid), 20_000, "zone 1 owns it");
    rB.send("dbgmonster", { id: mid, x: BORDER_X - 2 * CELL_WU, y, pin: true }); // and back
    await settle(1500);
    stop = true;
    await sampler;

    const gap = longestGap(samples);
    console.log(`[zonehole] round trip: samples=${samples.length} longest gap=${gap.ms} ms doubled=${doubled}`);
    assert.ok(rA.state.monsters.has(mid), "zone 0 owns it again at the end");
    assert.equal(doubled, 0, `the monster was both real and a ghost in ${doubled} samples`);
    assert.ok(gap.ms <= 120, `invisible for ${gap.ms} ms over a round trip across the border`);
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
