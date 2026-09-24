// ============================================================================
// THE HAND-OFF SURVIVES A ROLLOUT — THE BODY TRAVELS THROUGH THE CLIENT, SIGNED
// ============================================================================
//
// A hop's join is a NEW connection. During a rollout it lands on the new Cloud
// Run instance while the old one, still draining the player's socket, holds
// the hand-off document in its in-process bus; the receiving room found no
// document and the join fell to an ordinary one, which restores the account's
// last SAVE — 20-70 s old, up the mountain (maintainer 2026-09-23, twice, each
// within a minute of a revision going live). So `zone:go` also carries the hot
// state signed with a server-wide secret, and a receiving room whose bus has
// nothing adopts from that copy: same body, same seq. A forged copy, or one
// presented under another account, is an ordinary join, as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, CELL_WU, zoneGrid, zoneRect } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks } from "../src/rooms/WorldRoom.js";
import { FakeBus, useBus, bus } from "../src/bus.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HAVE_WORLD = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"));
const SKIP = "maps2/worlds3/the_game is absent (the deploy's sparse checkout has no world tree)";
const CFG = { cols: 2, rows: 2 };
const GRID = zoneGrid(CFG, 394, 394, CELL_WU);
const BORDER_X = zoneRect(GRID, 0).x1;
const BUS_MS = 8000;

async function waitFor(cond: () => boolean, timeout = 5000, what = "condition"): Promise<void> {
  const start = Date.now();
  const ready = () => { try { return cond(); } catch { return false; } };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a hop whose document is not on this bus adopts the client's signed copy; a forged copy, or one under another account, is an ordinary join", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 3041;
  useBus(new FakeBus());
  resetWorldClocks();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, monsterCount: 0, interestRadius: 0 };
  try {
    const cA = new Client(`ws://localhost:${port}`);
    const rA: any = await cA.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Runner", character: "default_boy" });
    // The account this client IS: minted on this first join, pulled the way
    // the real client pulls it (net.ts: register, then ask).
    const pair = await new Promise<{ id: string; secret: string }>((res) => {
      rA.onMessage("account", res);
      rA.send("account:want");
    });
    assert.ok(pair.id && pair.secret, "a fresh join mints an account");
    await waitFor(() => rA.state.players.size === 1, BUS_MS, "Runner joined zone 0");
    const pidA = rA.sessionId;
    const y = 100 * CELL_WU;
    rA.send("teleport", { x: BORDER_X - 3 * CELL_WU, y });
    await waitFor(() => Math.abs(rA.state.players.get(pidA).x - (BORDER_X - 3 * CELL_WU)) < 1, BUS_MS, "parked by the border");
    const hpBefore = rA.state.players.get(pidA).hp;

    // THE CROSSING: zone:go now carries the signed copy.
    const go = new Promise<{ zone: number; pid: string; key: string; seq: number; hot?: string; sig?: string }>((res) => rA.onMessage("zone:go", res));
    rA.send("teleport", { x: BORDER_X + 2 * CELL_WU, y });
    const msg = await go;
    // zone:go is sent from the tick that noticed the teleport, BEFORE that
    // tick's patch reaches this client: read the position after the patch
    // (measured: without the wait `atGo` is the parking spot, 160 wu off).
    await new Promise((r) => setTimeout(r, 60));
    const atGo = { x: rA.state.players.get(pidA).x, y: rA.state.players.get(pidA).y };
    assert.equal(msg.zone, 1);
    assert.equal(msg.pid, pidA);
    assert.equal(typeof msg.hot, "string", "zone:go carries the hot state");
    assert.match(msg.sig ?? "", /^[0-9a-f]{64}$/, "...signed");
    const copy = JSON.parse(msg.hot!);
    assert.equal(copy.pid, pidA);
    assert.equal(copy.key, msg.key);
    assert.equal(copy.rec, undefined, "the account record does not ride through the client");
    assert.equal(copy.mintedSecret, undefined, "nor the minted pair");
    assert.equal(typeof copy.at, "number", "the copy is dated");

    // ANOTHER PROCESS: the receiving room's bus has no document. Deleting it
    // is not enough — the sending room REWRITES it every tick while the hop
    // is in flight — so the reads are blinded to hand-off keys instead, which
    // is exactly what a room on the other instance sees.
    const b = bus() as unknown as { get(key: string): Promise<string | null> };
    const realGet = b.get.bind(b);
    b.get = async (key: string) => (key.startsWith("handoff:") ? null : realGet(key));
    t.after(() => { b.get = realGet; });

    // 1. A FORGED SIGNATURE is an ordinary join under the session id (and a
    //    fresh account: no claim), never the handed body.
    const forged = msg.sig!.slice(0, -1) + (msg.sig!.endsWith("0") ? "1" : "0");
    const cX = new Client(`ws://localhost:${port}`);
    const rX: any = await cX.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Forger", character: "default_boy", pid: msg.pid, handoff: msg.key, handoffHot: msg.hot, handoffSig: forged });
    await waitFor(() => rX.state.players.has(rX.sessionId), BUS_MS, "the forger joined as himself");
    assert.ok(!rX.state.players.has(pidA), "a forged copy adopts nothing");
    assert.equal(rX.state.players.get(rX.sessionId).name, "Forger");

    // 2. A VALID COPY UNDER ANOTHER ACCOUNT (no claim = a fresh account) is an
    //    ordinary join too: the copy is bound to the account it names.
    const cY = new Client(`ws://localhost:${port}`);
    const rY: any = await cY.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Stranger", character: "default_boy", pid: msg.pid, handoff: msg.key, handoffHot: msg.hot, handoffSig: msg.sig });
    await waitFor(() => rY.state.players.has(rY.sessionId), BUS_MS, "the stranger joined as himself");
    assert.ok(!rY.state.players.has(pidA), "a copy under another account adopts nothing");

    // 3. THE REAL CLIENT: the same account, the same copy — adopted under the
    //    SAME id, where the body stood at zone:go, at zone:go's seq, with its hp.
    const cA2 = new Client(`ws://localhost:${port}`);
    const rA2: any = await cA2.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Runner", character: "default_boy", account: pair, pid: msg.pid, handoff: msg.key, handoffHot: msg.hot, handoffSig: msg.sig, t0: Date.now() });
    await waitFor(() => rA2.state.players.get(pidA)?.sid === rA2.sessionId, BUS_MS, "the body is in zone 1 under the SAME id, bound to the new session");
    const me2 = rA2.state.players.get(pidA);
    assert.equal(me2.name, "Runner");
    assert.equal(me2.hp, hpBefore, "hp carried");
    assert.ok(Math.hypot(me2.x - atGo.x, me2.y - atGo.y) < CELL_WU, `adopted where the body stood at zone:go (${Math.hypot(me2.x - atGo.x, me2.y - atGo.y).toFixed(0)} wu off)`);
    assert.equal(me2.seq, msg.seq, "at the seq zone:go named — what the client replays from");
    // The old room is told, as for any adoption, and lets the body go.
    await waitFor(() => !rA.state.players.has(pidA), BUS_MS, "zone 0 dropped the handed-over body");
    rA.leave(); rA2.leave(); rX.leave(); rY.leave();
    await settle(100);
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});
