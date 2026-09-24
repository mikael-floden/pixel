// ============================================================================
// THE WHOLE BODY CROSSES THE LINE
// ============================================================================
//
// The hot state carried position, hp and the backpack but not the jump window
// and its cooldown, the swing timer, the engaged monster, a death that landed
// while the client was joining (it came back at 1 hp, alive), or a fall still
// in the air. Every clock now travels as REMAINING ms and is re-based on the
// new room's clock at adoption; a death crosses as a death; a fall lands in
// the new room on time. And a seat whose reconnection grace runs out removes
// the body only if the pid is still that session's — a newer session of the
// same body, adopted by a hand-off while the old seat waited, keeps it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, CELL_WU, zoneGrid, zoneRect } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks } from "../src/rooms/WorldRoom.js";
import { FakeBus, useBus, bus } from "../src/bus.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HAVE_WORLD = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"));
const CFG = { cols: 2, rows: 2 };
const GRID = zoneGrid(CFG, 394, 394, CELL_WU);
const BX = zoneRect(GRID, 0).x1;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeout = 5000, what = "condition"): Promise<void> {
  const start = Date.now();
  const ready = () => { try { return cond(); } catch { return false; } };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("jump, swing timer, target, a pending fall and a death mid-join all cross with the body; a stale seat never deletes a newer session's body", async (t) => {
  if (!HAVE_WORLD) return t.skip("maps2/worlds3/the_game missing");
  useBus(new FakeBus());
  resetWorldClocks();
  const port = 3047; // unique across test files — ports.test.ts gates it
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, monsterSeed: 5, interestRadius: 0 };
  const y = 100 * CELL_WU;
  const bodyIn = (S: any, pid: string): any => S.state.players.get(pid);
  /** Join zone 0 and park 3 cells west of the line; returns the room, the
   *  server room and the pid. */
  const park = async (name: string) => {
    const c = new Client(`ws://localhost:${port}`);
    const r: any = await c.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name, character: "default_boy" });
    const pid = r.sessionId;
    const S0: any = matchMaker.getLocalRoomById(r.roomId);
    await waitFor(() => S0.state.players.has(pid), 8000, "joined zone 0");
    bodyIn(S0, pid).handoff = null; // the login's own spawn hop (the spawn lies in zone 3) is not this test
    r.send("teleport", { x: BX - 3 * CELL_WU, y });
    await waitFor(() => Math.abs(bodyIn(S0, pid).x - (BX - 3 * CELL_WU)) < 1, 5000, "parked");
    return { r, S0, pid };
  };
  const cross = (r: any) => {
    const go = new Promise<{ pid: string; key: string; seq: number }>((res) => r.onMessage("zone:go", (m: any) => { if (m?.zone === 1) res(m); }));
    r.send("teleport", { x: BX + 2 * CELL_WU, y });
    return go;
  };
  const bind = async (name: string, msg: { pid: string; key: string }) => {
    const c2 = new Client(`ws://localhost:${port}`);
    const r2: any = await c2.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name, character: "default_boy", pid: msg.pid, handoff: msg.key });
    await waitFor(() => r2.state.players.get(msg.pid)?.sid === r2.sessionId, 5000, "adopted in zone 1");
    return { r2, S1: matchMaker.getLocalRoomById(r2.roomId) as any };
  };
  try {
    // 1. THE CLOCKS AND THE FALL. Mid-jump, mid-cooldown, a monster engaged,
    //    a fall due in 700 ms — then the hop.
    {
      const { r, S0, pid } = await park("Climber");
      const b = bodyIn(S0, pid);
      // A monster of zone 0 pinned a cell west of the line: real here, a ghost
      // in zone 1 — the mark on it must hold on both sides.
      let mid = "";
      S0.state.monsters.forEach((m: any, k: string) => { if (!mid && m.mstate === "roam") mid = k; });
      assert.ok(mid, "a monster to mark");
      Object.assign(S0.state.monsters.get(mid), { x: BX - CELL_WU, y, pinned: true, trip: null, tripActive: false, targetSid: "" });
      // The crossing teleport ends a jump and a fall (an assigned position
      // does), so the body is set up AFTER the crossing is noticed: the old
      // room refreshes the hot state every tick until the join lands.
      const msg = await cross(r);
      const now = Date.now();
      b.jumpUntil = now + 400; b.jumpReadyAt = now + 1200; b.nextSwingAt = now + 800; b.target = mid;
      S0.fallPend.set(pid, { dmg: 7, at: now + 700 });
      const hp0 = b.hp;
      await settle(80); // a refresh or two
      const { r2, S1 } = await bind("Climber", msg);
      const a = bodyIn(S1, pid);
      const t = Date.now();
      const left = { jump: a.jumpUntil - t, jumpReady: a.jumpReadyAt - t, swing: a.nextSwingAt - t };
      console.log(`    on arrival: jump ${left.jump} ms left (of 400), jump cooldown ${left.jumpReady} (of 1200), swing ${left.swing} (of 800), target ${JSON.stringify(a.target)}`);
      assert.ok(left.jump > 0 && left.jump <= 400, `the jump window crossed (${left.jump} ms left; 0 on the old code)`);
      assert.ok(a.jumping, "...and the body is jumping");
      assert.ok(left.jumpReady > 600 && left.jumpReady <= 1200, `the jump cooldown crossed (${left.jumpReady} ms)`);
      assert.ok(left.swing > 300 && left.swing <= 800, `the swing timer crossed (${left.swing} ms)`);
      assert.equal(a.target, mid, "the engaged monster crossed (a ghost of this room)");
      assert.ok(S1.fallPend.has(pid), "the fall in the air crossed");
      await waitFor(() => bodyIn(S1, pid).hp === hp0 - 7, 3000, "the fall landed in the new room");
      console.log(`    the fall landed in zone 1: hp ${hp0} -> ${bodyIn(S1, pid).hp}`);
      r.leave(); r2.leave();
      await settle(200);
    }
    // 2. A DEATH MID-JOIN crosses as a death, not as a body at 1 hp.
    {
      const { r, S0, pid } = await park("Doomed");
      const msg = await cross(r);
      S0.hurtPlayer(bodyIn(S0, pid), 9999, Date.now());
      assert.equal(bodyIn(S0, pid).dead, true, "killed in the old room while the join is in flight");
      await settle(120); // the old room refreshes the hot state every tick
      const { r2, S1 } = await bind("Doomed", msg);
      const a = bodyIn(S1, pid);
      console.log(`    death mid-join: arrived dead=${a.dead} hp=${a.hp} respawn in ${a.respawnAt - Date.now()} ms`);
      assert.equal(a.dead, true, "dead on arrival (the old code revived it at 1 hp)");
      assert.equal(a.hp, 0);
      assert.ok(a.respawnAt > Date.now(), "with its respawn clock");
      r.leave(); r2.leave();
      await settle(200);
    }
    // 3. THE STALE SEAT. A link drops (the seat waits in the grace with the
    //    body in state); the same body comes back through a hand-off under a
    //    NEW session; then the old seat's grace is rejected. The body stays.
    {
      const { r, S0, pid } = await park("Dropper");
      const oldSid = r.sessionId;
      const b = bodyIn(S0, pid);
      const snap = { name: b.name, character: b.character, x: b.x, y: b.y, elev: b.elev, dir: b.dir, level: b.level, xp: b.xp, hp: b.hp, ep: b.ep, seq: b.seq };
      r.leave(false); // the socket closes without a LEAVE: not consented, the seat parks
      await waitFor(() => S0.reconnects.has(oldSid), 5000, "the seat is parked in the grace");
      // The same body, handed back into zone 0 by "zone 1": a hot document
      // under a key, then a join with pid + key, exactly as a hop does.
      const key = "ab".repeat(16);
      const hot = { key, pid, from: 1, at: Date.now(), ...snap, accountId: "", rec: null, inv: [], torch: false, noAggro: false, lastHitAt: -100000, lastCombatAt: -100000, dirty: false };
      await bus().set(`handoff:the_game:${pid}`, JSON.stringify(hot), 10);
      const c2 = new Client(`ws://localhost:${port}`);
      const r2: any = await c2.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Dropper", character: "default_boy", pid, handoff: key });
      await waitFor(() => bodyIn(S0, pid)?.sid === r2.sessionId, 5000, "the body is the new session's now");
      // The old seat's grace ends (a newcomer's kick, a timeout — same path).
      S0.reconnects.get(oldSid)?.reject(new Error("test: the grace ran out"));
      await settle(300);
      const still = bodyIn(S0, pid);
      console.log(`    stale seat expired: body ${still ? "kept, sid " + (still.sid === r2.sessionId ? "the new session's" : "??") : "DELETED"}`);
      assert.ok(still && still.sid === r2.sessionId, "the old seat's expiry did not delete the newer session's body (it did on the old code)");
      r2.leave();
    }
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});
