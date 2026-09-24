import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks, saveEveryPlayer } from "../src/rooms/WorldRoom.js";
import { MemoryAccountStore, setAccountStore } from "../src/account/store.js";
import { FakeBus, useBus } from "../src/bus.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HAVE_WORLD = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"));
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POSITIONS SURVIVE A ROLLOUT (docs/movement.md "Where you are is saved").
 *  A player who only walked was never written — position rode along with a
 *  leave, a death or a ding — so the instance a push replaced restored the
 *  account's last write: the spawn, forty cells back ("BANG I was teleported
 *  back to the spawn area", maintainer 2026-09-23). Two rules, both here:
 *  the shutdown hook writes EVERY player and awaits it before a client is
 *  cut; a walk of two cells marks the player dirty for the periodic flush. */
test("a walking player's position is written on graceful shutdown, and a walk marks them dirty", async (t) => {
  if (!HAVE_WORLD) return t.skip("maps2/worlds3/the_game missing");
  const port = 2967;
  const store = new MemoryAccountStore();
  setAccountStore(store);
  useBus(new FakeBus());
  resetWorldClocks();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  let room: any = null;
  try {
    room = await matchMaker.createRoom(ROOM_NAME, { world: "the_game", zonesCfg: { cols: 1, rows: 1 }, zone: 0, monsterSeed: 3 });
    const c = new Client(`ws://localhost:${port}`);
    const r: any = await c.joinById(room.roomId, { name: "Ivo", character: "default_boy" });
    const acc = await new Promise<{ id: string; secret: string }>((res) => {
      r.onMessage("account", (m: any) => res(m));
      r.send("account:want");
    });
    await settle(200);
    // The wire carries quarter units off the room origin; the store holds the
    // server's float body, so judge against that.
    const me = () => {
      let found: any = null;
      (matchMaker.getLocalRoomById(room.roomId) as any).state.players.forEach((p: any) => {
        if (p.accountId === acc.id) found = p;
      });
      assert.ok(found, "the body is in the room");
      return found;
    };
    const x0 = me().x;
    const y0 = me().y;
    assert.equal((await store.load(acc.id))!.pos?.the_game, undefined, "a fresh account has no position yet");
    // Hold the stick screen-left until two cells are covered (MOVE_SAVE_WU):
    // a walk, nothing earned. Measured, not timed — a fixed second fell short
    // under a loaded runner (the suite runs its files concurrently).
    const t0 = Date.now();
    let seq = 0;
    while (Date.now() - t0 < 8000 && Math.hypot(me().x - x0, me().y - y0) < 2 * 32 + 8) {
      r.send("input", { ax: -1, ay: 0, running: true, seq: ++seq, dt: 1 / 20 });
      await settle(50);
    }
    await settle(200);
    const moved = Math.hypot(me().x - x0, me().y - y0);
    assert.ok(moved > 30, `the body walked (${moved.toFixed(1)} wu)`);
    assert.equal(me().dirty, true, "a walk of two cells marks the player dirty for the periodic flush");
    // The shutdown hook: every player written and awaited, dirty or not.
    const n = await saveEveryPlayer();
    assert.equal(n, 1, "one player written");
    assert.equal(me().dirty, false, "written: clean again");
    const saved = (await store.load(acc.id))!.pos?.the_game;
    assert.ok(saved, "the position is in the store");
    assert.ok(Math.hypot(saved!.x - me().x, saved!.y - me().y) < 1, `the store holds where the body IS (${saved!.x.toFixed(1)},${saved!.y.toFixed(1)} vs ${me().x.toFixed(1)},${me().y.toFixed(1)})`);
    r.leave();
    await settle(300);
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
    setAccountStore(undefined);
  }
});
