// THE PLAYER-SPEED DIAL (maintainer 2026-09-11: "add a slider in settings so I
// can control/tweak the players speed ... to find the perfect default and a way
// for me to travel the map faster").
//
// The dial is AUTHORITATIVE and it rides PER INPUT. Those are the two things
// that can break, and neither is visible by playing:
//
//  1. if the server ignored `sm`, the client would predict a fast walk and get
//     dragged back on every patch — a rubber-band, not a slow walk;
//  2. if the server trusted `sm`, the dial would be a wire field with no
//     ceiling. It is clamped HERE, by the authority, to [MIN, MAX].
//
// THE TEST TURNS THE ROOM'S CLOCK ITSELF. The inputs ride the real wire (the
// clamp lives in the message handler, so that is the path under test), but the
// room's simulation interval is stopped once the runner has joined and every
// integration step is a direct `update(INPUT_TIME_SLACK)`: the budget's whole
// burst allowance, granted per step, so twelve 0.08 s inputs drain in four
// steps and no input is ever consumed with less credit than it claims. Paced
// on the wall clock this test was a coin flip in front of the deploy gate
// (2026-09-12: red in runs 3770, 3774, 3784 and 3786, four trees, green on
// every re-run). The server credits integration time from REAL tick spacing,
// capped at INPUT_TIME_SLACK, and an input consumed short of credit is CLIPPED,
// not deferred — one stall of a few hundred ms on a loaded runner queues a
// backlog, and every input behind it integrates ~one tick's worth (0.05 of
// 0.08 s: the 2x run measured 1.05x the default walk instead of 1.67x). No
// pacing under real time prevents a stall; a test of the DIAL must not be a
// measurement of the runner's spare cycles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import {
  ROOM_NAME,
  INPUT_TIME_SLACK,
  PLAYER_SPEED_MIN,
  PLAYER_SPEED_MAX,
  PLAYER_SPEED_DEFAULT,
} from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";

const waitFor = async (cond: () => boolean, timeout = 6000, what = "condition") => {
  const start = Date.now();
  const ready = () => {
    try {
      return cond();
    } catch {
      return false; // state/MapSchema is undefined until the first patch
    }
  };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("the player-speed dial is authoritative, clamped, and carried per input", async () => {
  const port = 2964;
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  try {
    const c = new Client(`ws://localhost:${port}`);
    const r: any = await c.joinOrCreate(ROOM_NAME, { name: "Runner", character: "default_boy", monsterCount: 0 });
    r.onMessage("chat", () => {});
    r.onMessage("inv", () => {});
    r.onMessage("star", () => {});
    r.onMessage("live:update", () => {});
    await waitFor(() => r.state.players.size === 1, 8000, "join");

    // The room lives in this process: stop its wall-clock tick and read the
    // authoritative float position straight off it (the wire carries int16
    // quarter units — shared/worldunits.ts — and this test is about the sim).
    const room: any = matchMaker.getLocalRoomById(r.roomId);
    assert.ok(room, "the room is local to this process");
    room.setSimulationInterval(undefined);
    const me = () => room.state.players.get(r.sessionId);
    assert.ok(me(), "the runner is in the room state");

    /** Send INPUTS inputs of INPUT_DT at the given dial over the wire, wait for
     *  every one to be queued, integrate them with the clock this test turns,
     *  and return the ground covered. Alternating east and west so the run
     *  stays in one place; the open world has no terrain, so the only thing
     *  changing between runs is `sm`. */
    const INPUTS = 12;
    const INPUT_DT = 0.08;
    let seq = 0;
    const runWith = async (sm: number | undefined, ax: number) => {
      const x0 = me().x;
      for (let i = 0; i < INPUTS; i++) {
        const msg: Record<string, unknown> = { ax, ay: 0, running: false, dt: INPUT_DT, seq: ++seq };
        if (sm !== undefined) msg.sm = sm;
        r.send("input", msg);
      }
      await waitFor(() => me().inputQueue.length === INPUTS, 6000, `${INPUTS} inputs queued`);
      // Each step grants the full burst allowance, which covers three inputs
      // (0.24 of 0.25 s): nothing is clipped, the distance is the dial's alone.
      let steps = 0;
      while (me().inputQueue.length) {
        room.update(INPUT_TIME_SLACK);
        assert.ok(++steps <= INPUTS, "the queue drains");
      }
      assert.equal(me().seq, seq, "every input was acked");
      return Math.abs(me().x - x0);
    };

    const base = await runWith(PLAYER_SPEED_DEFAULT, 1);
    assert.ok(base > 5, `the baseline walk covered only ${base.toFixed(1)}wu — the stream never integrated`);
    const twice = await runWith(2, -1);
    const absent = await runWith(undefined, 1);
    const clamped = await runWith(99, -1);
    const slow = await runWith(PLAYER_SPEED_MIN, 1);

    // EVERY RUN IS ASSERTED AS A RATIO AGAINST THE DEFAULT, never as a pinned
    // multiple of the baseline — the default is HIS dial to move (it went 1 ->
    // 1.2 the day the slider shipped) and a test that hardcoded "2x is twice
    // the baseline" would have gone red on his taste rather than on a bug.
    // 1% tolerance: the integration is deterministic, so anything wider would
    // only hide a dial that is partly applied.
    const ratio = (covered: number, sm: number) => {
      const want = Math.min(PLAYER_SPEED_MAX, Math.max(PLAYER_SPEED_MIN, sm)) / PLAYER_SPEED_DEFAULT;
      const got = covered / base;
      assert.ok(
        Math.abs(got / want - 1) < 0.01,
        `sm=${sm} covered ${got.toFixed(3)}x the default walk, expected ${want.toFixed(3)}x`,
      );
      return got;
    };
    const r2 = ratio(twice, 2);
    // AN INPUT WITH NO DIAL IS THE DEFAULT WALK — an older client, or a message
    // replayed from before the dial existed, must not change pace.
    const rAbsent = ratio(absent, PLAYER_SPEED_DEFAULT);
    // THE CEILING IS THE SERVER'S. 99 is not 99x — `ratio` clamps its own
    // expectation the same way the input handler does.
    const rCap = ratio(clamped, 99);
    const rSlow = ratio(slow, PLAYER_SPEED_MIN);
    assert.ok(rCap > r2, "the cap must still be faster than 2x");
    assert.ok(rSlow < rAbsent, "the floor must still be slower than the default");
    console.log(
      `player speed: default ${PLAYER_SPEED_DEFAULT}x = ${base.toFixed(1)}wu; ` +
        `2x ${r2.toFixed(3)}x, no-dial ${rAbsent.toFixed(3)}x, ` +
        `sm=99 ${rCap.toFixed(3)}x (cap ${PLAYER_SPEED_MAX}), ${PLAYER_SPEED_MIN}x ${rSlow.toFixed(3)}x`,
    );
    await r.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
