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
// Measured against the room's own integration of the SAME input stream, so the
// assertion is a ratio and not a pinned pixel count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import {
  ROOM_NAME,
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
    const me = () => r.state.players.get(r.sessionId);

    /** Walk at the given dial and return the ground covered. Alternating east
     *  and west so the run stays in one place; the open world has no terrain,
     *  so the only thing changing between runs is `sm`.
     *
     *  PACED WELL UNDER REAL TIME — 0.08 s of input every 140 ms. The server
     *  integrates a client's claimed dt against a real-time budget
     *  (INPUT_TIME_SLACK), so a stream paced 1:1 integrates only partially
     *  under suite load and the fastest run looks slow: measured 1.91x instead
     *  of 4x with the whole suite running. Sending half as fast as the clock
     *  leaves the budget in permanent surplus, which is what makes the ratio a
     *  measurement of the DIAL rather than of the runner's spare cycles. */
    let seq = 0;
    const runWith = async (sm: number | undefined, ax: number) => {
      const x0 = me().x;
      for (let i = 0; i < 12; i++) {
        const msg: Record<string, unknown> = { ax, ay: 0, running: false, dt: 0.08, seq: ++seq };
        if (sm !== undefined) msg.sm = sm;
        r.send("input", msg);
        await new Promise((t) => setTimeout(t, 140));
      }
      await new Promise((t) => setTimeout(t, 400)); // let the queue drain
      return Math.abs(me().x - x0);
    };

    const base = await runWith(PLAYER_SPEED_DEFAULT, 1);
    assert.ok(base > 5, `the baseline walk covered only ${base.toFixed(1)}wu — the stream never integrated`);
    const twice = await runWith(2, -1);
    const absent = await runWith(undefined, 1);
    const clamped = await runWith(99, -1);
    const slow = await runWith(PLAYER_SPEED_MIN, 1);

    // 2x COVERS TWICE THE GROUND. Loose (the stream is real-time paced, so the
    // integrated dt varies run to run) but far tighter than 1x vs 2x.
    assert.ok(
      twice / base > 1.6 && twice / base < 2.4,
      `2x covered ${(twice / base).toFixed(2)}x the baseline (${twice.toFixed(1)} vs ${base.toFixed(1)}wu)`,
    );
    // AN INPUT WITH NO DIAL IS THE NORMAL WALK — an older client, or a message
    // replayed from before the dial existed, must not change pace.
    assert.ok(
      Math.abs(absent / base - 1) < 0.25,
      `an input without \`sm\` walked at ${(absent / base).toFixed(2)}x the baseline`,
    );
    // THE CEILING IS THE SERVER'S. 99 is not 99x.
    assert.ok(
      clamped / base < PLAYER_SPEED_MAX * 1.2,
      `sm=99 covered ${(clamped / base).toFixed(2)}x the baseline — the clamp is not being applied`,
    );
    assert.ok(
      clamped / base > PLAYER_SPEED_MAX * 0.8,
      `sm=99 covered only ${(clamped / base).toFixed(2)}x — it should clamp UP TO ${PLAYER_SPEED_MAX}x`,
    );
    // …and the bottom of the range really is slower.
    assert.ok(
      slow / base < 0.75,
      `${PLAYER_SPEED_MIN}x covered ${(slow / base).toFixed(2)}x the baseline`,
    );
    console.log(
      `player speed: base ${base.toFixed(1)}wu; 2x ${(twice / base).toFixed(2)}x, ` +
        `no-dial ${(absent / base).toFixed(2)}x, sm=99 ${(clamped / base).toFixed(2)}x (cap ${PLAYER_SPEED_MAX}), ` +
        `${PLAYER_SPEED_MIN}x ${(slow / base).toFixed(2)}x`,
    );
    await r.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
