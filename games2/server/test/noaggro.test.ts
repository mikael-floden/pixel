// DISABLE AGGRO, live-room (maintainer 2026-08-07: "I will use this feature to
// test walk around in the cave without dying").
//
// The switch is server-side and per SESSION, so the only honest test is a real
// room: stand a player inside a predator's aggro radius and watch whether the
// monster's hunt target (`tsid`) becomes them. Four steps, in this order for a
// reason — the first is also the BASELINE that these monsters can aggro at all,
// so none of the negative assertions can pass vacuously:
//   1. ON + sword raised — it still comes. The switch removes the ambush, not
//      the fight.
//   2. ON, untouched monster — it does not notice you.
//   3. OFF — the same one does. The switch is not one-way and does not leave
//      anything permanently pacified.
//   4. ON while it is hunting — the running chase is released.
// Each step uses a FRESH predator: a monster whose hunt just ended walks home,
// and `returning` suppresses its scan by design, so reusing one would time the
// next step out for a reason that has nothing to do with this switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, PLAYER_RESPAWN_MS } from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";

async function waitFor(cond: () => boolean, timeout = 8000, label = "condition"): Promise<void> {
  const start = Date.now();
  const ready = () => { try { return cond(); } catch { return false; } };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** Monsters that can aggro on their own (tuning aggro_radius_wu > 0). */
function predators(room: any): { id: string; m: any }[] {
  const out: { id: string; m: any }[] = [];
  room.state.monsters.forEach((m: any, id: string) => {
    if (m.aggro > 0 && m.mstate !== "die") out.push({ id, m });
  });
  return out;
}

/** Park the player on top of the monster and hold there — the proximity scan
 * runs ~2/s, and a monster that starts hunting also starts MOVING, so a single
 * teleport would drift out of range before the next scan. */
async function hover(room: any, m: any, ms: number, hunting: () => boolean): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Parking ON a predator gets you killed, and a dead player no longer comes
    // back on a timer — the press does (see the death sequence). So stand back
    // up and carry on: this test is about the aggro switch, not about dying.
    const me = room.state.players.get(room.sessionId);
    if (me?.dead) {
      await new Promise((r) => setTimeout(r, PLAYER_RESPAWN_MS + 200));
      room.send("respawn", {});
      await new Promise((r) => setTimeout(r, 300));
    }
    room.send("teleport", { x: m.x, y: m.y });
    await new Promise((r) => setTimeout(r, 120));
    if (hunting()) return true;
  }
  return false;
}

test("disable aggro: a predator stops noticing you, and lets go of a hunt already running", async () => {
  const port = 2990; // unique per test FILE — see test/ports.test.ts (2993 is timeofday's)
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const r1: any = await c1.joinOrCreate(ROOM_NAME, {
      name: "Walker", character: "default_boy", token: `noaggro-${Date.now()}`,
      world: "monster_demo", monsterSeed: 4242, monsterCount: 4,
    });
    for (const t of ["inv", "chat", "levelup", "star", "live:update"]) r1.onMessage(t, () => {});
    await waitFor(() => r1.state.players.size === 1 && r1.state.monsters.size > 0, 8000, "join");

    // TWO predators, and each step uses a FRESH one. A monster whose hunt has
    // just ended walks home, and `returning` suppresses its proximity scan by
    // design — reusing it would make the next step time out for a reason that
    // has nothing to do with this switch.
    const ps = predators(r1);
    // monster_demo's roster is tuning-driven; say so rather than pass silently.
    assert.ok(ps.length >= 2, `monster_demo gave ${ps.length} monsters with aggro_radius_wu > 0 — need 2`);
    const [a, b] = ps;
    const hunts = (id: string) => () => r1.state.monsters.get(id)?.tsid === r1.sessionId;

    // 1) PROVOCATION SURVIVES THE SWITCH — and doubles as the baseline that
    // these monsters CAN aggro at all, so nothing below passes vacuously.
    // Raising your sword is the player's own doing; the switch removes the
    // ambush, not the fight.
    r1.send("noaggro", { on: true });
    r1.send("engage", { id: a.id });
    assert.ok(await hover(r1, a.m, 8000, hunts(a.id)),
      "a sword-marked monster did not come — the switch is blocking provocation too");
    r1.send("engage", { id: null });

    // 2) ON: an untouched predator does not notice us at all.
    assert.equal(await hover(r1, b.m, 6000, hunts(b.id)), false, "it aggroed with the switch on");

    // 3) OFF: the same one notices us — the switch is not one-way, and it did
    // not leave the monster permanently pacified.
    r1.send("noaggro", { on: false });
    assert.ok(await hover(r1, b.m, 8000, hunts(b.id)),
      "a predator we are standing on top of never aggroed with the switch off");

    // 4) ON while it is hunting: the running chase is RELEASED. Without this
    // you would have to outrun whatever noticed you before the switch could
    // help, which is the whole situation it exists for.
    r1.send("noaggro", { on: true });
    await waitFor(() => !hunts(b.id)(), 5000, "the switch to release the hunt already running");

    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
