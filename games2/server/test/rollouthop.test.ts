// ============================================================================
// A HOP THAT LANDS ON A NEW REVISION RESTORES AT THE CUT, WITHOUT A STAR
// ============================================================================
//
// The bus is in-process in production, so the hand-off document lives in the
// instance that wrote it. A crossing whose join lands on the NEW revision of a
// rollout finds no hot state and the receiving room logs the player in the
// ordinary way, from the account's last write — which used to be wherever they
// last left, died or flushed: the maintainer's "BANG I was teleported back to
// the spawn area" (2026-09-23; 5 of ~291 hops, each 5-12 min after a deploy).
//
// The fix is one save at the START of the hand-off, so the last write is the
// cut, and a fallback login that carries a hand-off pid/key is not an arrival:
// no shooting star. This test drives a crossing, checks the store holds the
// cut spot the moment `zone:go` is out, then joins the other zone with a
// hand-off the receiving room cannot honour (a key it has never seen — the
// same `takeHandoff -> null` branch a rollout takes) and checks where the body
// comes back and that nobody saw a star.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, CELL_WU, zoneGrid, zoneRect } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks } from "../src/rooms/WorldRoom.js";
import { MemoryAccountStore, setAccountStore } from "../src/account/store.js";
import { FakeBus, useBus } from "../src/bus.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HAVE_WORLD = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"));
const CFG = { cols: 2, rows: 2 };
const GRID = zoneGrid(CFG, 394, 394, CELL_WU);
const BORDER_X = zoneRect(GRID, 0).x1;

async function waitFor(cond: () => boolean, timeout = 5000, what = "condition"): Promise<void> {
  const start = Date.now();
  const ready = () => { try { return cond(); } catch { return false; } };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the cut spot is saved when the hand-off starts, and a hop with no hot state restores there without a star", async (t) => {
  if (!HAVE_WORLD) return t.skip("maps2/worlds3/the_game missing");
  const store = new MemoryAccountStore();
  setAccountStore(store);
  useBus(new FakeBus());
  resetWorldClocks();
  const port = 3042; // unique across test files — ports.test.ts gates it
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, monsterCount: 0, interestRadius: 0 };
  try {
    const cA = new Client(`ws://localhost:${port}`);
    const rA: any = await cA.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Ivo", character: "default_boy" });
    const account = await new Promise<{ id: string; secret: string }>((res) => {
      rA.onMessage("account", (m: any) => res(m));
      rA.send("account:want");
    });
    await waitFor(() => rA.state.players.size === 1, 8000, "joined zone 0");
    const pid = rA.sessionId;
    const y = 100 * CELL_WU;
    rA.send("teleport", { x: BORDER_X - 3 * CELL_WU, y });
    await waitFor(() => Math.abs(rA.state.players.get(pid).x - (BORDER_X - 3 * CELL_WU)) < 1, 5000, "parked at the border");
    // (The login itself started a hand-off — the spawn lies in zone 3 of this
    // 2x2 grid — so a spawn-side save may already exist; the teleport to the
    // border cancelled that hop. Only the zone:go INTO ZONE 1 is the crossing.)
    // THE CROSSING: one step over the line, and the old room sends zone:go.
    const go = new Promise<{ zone: number; pid: string; key: string; seq: number }>((res) => rA.onMessage("zone:go", (m: any) => { if (m?.zone === 1) res(m); }));
    rA.send("teleport", { x: BORDER_X + 2 * CELL_WU, y });
    const msg = await go;
    assert.equal(msg.pid, pid);
    // THE CLAIM, PART 1: the store already holds the cut spot — written by
    // startHandoff, before any client could join anywhere.
    const saved = (await store.load(account.id))?.pos?.the_game;
    assert.ok(saved, "the hand-off's start wrote the position");
    assert.ok(Math.hypot(saved!.x - (BORDER_X + 2 * CELL_WU), saved!.y - y) < 1, `saved at the cut (${saved!.x.toFixed(0)},${saved!.y.toFixed(0)})`);

    // THE ROLLOUT: the join lands on a room that cannot honour the hand-off
    // (a key it has never seen is the same `takeHandoff -> null` branch as a
    // missing document). It must come back through the ordinary login, at
    // the saved spot, with no shooting star for anyone.
    let stars = 0;
    rA.onMessage("star", () => stars++);
    const cA2 = new Client(`ws://localhost:${port}`);
    const rA2: any = await cA2.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Ivo", character: "default_boy", account, pid, handoff: "0".repeat(32) });
    rA2.onMessage("star", () => stars++);
    let me2: any;
    await waitFor(() => { rA2.state.players.forEach((p: any) => { if (p.sid === rA2.sessionId) me2 = p; }); return !!me2; }, 5000, "a body in zone 1 for this client");
    // Wire positions are relative to the ROOM's origin, so read the body off
    // the server room, in world units.
    const { matchMaker } = await import("@colyseus/core");
    const room1: any = matchMaker.getLocalRoomById(rA2.roomId);
    let body: any;
    room1.state.players.forEach((p: any) => { if (p.sid === rA2.sessionId) body = p; });
    assert.ok(body, "the server room holds the body");
    const off = Math.hypot(body.x - saved!.x, body.y - saved!.y);
    assert.ok(off < 1, `restored at the cut, not at the spawn (${off.toFixed(1)} wu off)`);
    assert.equal(body.seq, 0, "an ordinary login: seq restarts (the client replays from zone:go's seq)");
    await settle(300);
    assert.equal(stars, 0, "a crossing that lost its hand-off is not an arrival: no star");
    console.log(`    fallback hop: saved at (${saved!.x.toFixed(0)},${saved!.y.toFixed(0)}), restored ${off.toFixed(1)} wu from it, ${stars} star(s)`);
    rA.leave(); rA2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});
