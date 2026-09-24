// ============================================================================
// A HOP'S REPLAY CREDIT CAN BE SPENT
// ============================================================================
//
// On bind the client replays, in one burst, every input after the seq the new
// room adopted — the tail the old room never acked, a join's latency of
// running. The movement tick integrates a burst against `timeCredit`, which
// it clamps to INPUT_TIME_SLACK (0.25 s) before reading the first input, so
// the 2 s of credit joinHandedOff granted INTO timeCredit was cut to 0.25 s
// before it could be spent: every replayed input past the first 0.25 s was
// integrated at a fraction of its dt and acked anyway, the body fell short of
// the client's prediction by the rest of the join and reconciled backwards —
// the distance lost for good on a slow hop (0.3-1.9 cells measured).
//
// `hopCredit` is a second purse, sized to the hop's age at adoption plus half
// a second, spent before timeCredit, void 3 s later. Measured here against a
// PACED run over the same ground (real time accrues, nothing is throttled):
// a 0.6 s burst after a 300 ms hop lands whole; the same burst 3.5 s later
// gets the ordinary 0.25 s; a 2.5 s burst after a 3 s hop gets the 2 s cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, CELL_WU, zoneGrid, zoneRect } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks } from "../src/rooms/WorldRoom.js";
import { FakeBus, useBus } from "../src/bus.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HAVE_WORLD = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"));
const CFG = { cols: 2, rows: 2 };
const GRID = zoneGrid(CFG, 394, 394, CELL_WU);
const BORDER_X = zoneRect(GRID, 0).x1;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeout = 5000, what = "condition"): Promise<void> {
  const start = Date.now();
  const ready = () => { try { return cond(); } catch { return false; } };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("the replay burst after a hop is integrated whole; the purse expires; it is capped", async (t) => {
  if (!HAVE_WORLD) return t.skip("maps2/worlds3/the_game missing");
  useBus(new FakeBus());
  resetWorldClocks();
  const port = 3045; // unique across test files — ports.test.ts gates it
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, monsterCount: 0, interestRadius: 0 };
  const y = 100 * CELL_WU;
  const START = BORDER_X + 2 * CELL_WU;
  /** The server-side body (wire positions are room-relative): world units. */
  const bodyOf = (room: any, sid: string): any => {
    const r: any = matchMaker.getLocalRoomById(room.roomId);
    let b: any;
    r.state.players.forEach((p: any) => { if (p.sid === sid) b = p; });
    return b;
  };
  /** Cross from zone 0 into zone 1 and bind after `hopMs`, as a phone does. */
  const hop = async (name: string, hopMs: number) => {
    const c = new Client(`ws://localhost:${port}`);
    const r: any = await c.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name, character: "default_boy" });
    await waitFor(() => r.state.players.size >= 1 && r.state.players.has(r.sessionId), 8000, "joined zone 0");
    r.send("teleport", { x: BORDER_X - 3 * CELL_WU, y });
    await waitFor(() => Math.abs(r.state.players.get(r.sessionId).x - (BORDER_X - 3 * CELL_WU)) < 1, 5000, "parked");
    const go = new Promise<{ pid: string; key: string; seq: number }>((res) => r.onMessage("zone:go", (m: any) => { if (m?.zone === 1) res(m); }));
    r.send("teleport", { x: START, y });
    const msg = await go;
    await settle(hopMs);
    const c2 = new Client(`ws://localhost:${port}`);
    const r2: any = await c2.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name, character: "default_boy", pid: msg.pid, handoff: msg.key });
    await waitFor(() => r2.state.players.get(msg.pid)?.sid === r2.sessionId, 5000, "adopted in zone 1");
    r.leave();
    return { r2, seq: msg.seq + 1 };
  };
  const burst = async (r2: any, seq0: number, n: number) => {
    let seq = seq0;
    for (let i = 0; i < n; i++) r2.send("input", { ax: 1, ay: 0, running: true, seq: seq++, dt: 1 / 20 });
    r2.send("input", { ax: 0, ay: 0, running: false, seq: seq++, dt: 1 / 20 });
    await settle(400);
    return seq;
  };
  try {
    // THE RULER: the same 0.6 s of running, paced in real time — what the
    // body covers when nothing throttles it (the terrain east of START is
    // whatever it is; every arm below runs from the same spot).
    const ruler = await hop("Ruler", 50);
    const rb0 = bodyOf(ruler.r2, ruler.r2.sessionId);
    await settle(3500); // past the hop's purse: a plain body
    const rx0 = rb0.x;
    let seq = ruler.seq;
    for (let i = 0; i < 12; i++) { ruler.r2.send("input", { ax: 1, ay: 0, running: true, seq: seq++, dt: 1 / 20 }); await settle(50); }
    ruler.r2.send("input", { ax: 0, ay: 0, running: false, seq: seq++, dt: 1 / 20 });
    await settle(400);
    const paced = rb0.x - rx0;
    assert.ok(paced > 40, `the paced run moved (${paced.toFixed(0)} wu)`);
    ruler.r2.leave();

    // 1. A 0.6 s burst right after a 300 ms hop: the purse (0.3 + 0.5 s)
    //    covers it, so the body lands where the client predicted.
    const a = await hop("Runner", 300);
    const ab = bodyOf(a.r2, a.r2.sessionId);
    const ax0 = ab.x;
    let aseq = await burst(a.r2, a.seq, 12);
    const whole = ab.x - ax0;
    console.log(`    paced 0.6 s run ${paced.toFixed(0)} wu; the burst after a 300 ms hop ${whole.toFixed(0)} wu (0.25 s of it, ${(paced * 0.25 / 0.6).toFixed(0)} wu, before the purse)`);
    assert.ok(whole >= paced * 0.85, `the replay burst lands whole (${whole.toFixed(0)} of ${paced.toFixed(0)} wu)`);

    // 2. The same burst 3.5 s later: the purse is void, the ordinary 0.25 s
    //    budget applies — a hop is not a standing speed hack.
    await settle(3500);
    const ax1 = ab.x;
    aseq = await burst(a.r2, aseq, 12);
    const later = ab.x - ax1;
    console.log(`    the same burst 3.5 s after the hop ${later.toFixed(0)} wu`);
    assert.ok(later <= paced * 0.6, `the purse has expired (${later.toFixed(0)} of ${paced.toFixed(0)} wu)`);
    a.r2.leave();

    // 3. A 2.5 s burst after a 3 s hop (a phone on its tail): the purse is
    //    capped at 2 s, so 2 s of it lands, not 2.5 and not 0.25.
    const b = await hop("Tail", 3000);
    const bb = bodyOf(b.r2, b.r2.sessionId);
    const bx0 = bb.x;
    await burst(b.r2, b.seq, 50);
    const capped = bb.x - bx0;
    const perS = paced / 0.6;
    console.log(`    a 2.5 s burst after a 3 s hop ${capped.toFixed(0)} wu = ${(capped / perS).toFixed(2)} s of running (cap 2 s)`);
    assert.ok(capped >= perS * 1.7 && capped <= perS * 2.3, `capped at HANDOFF_INPUT_CREDIT_S (${(capped / perS).toFixed(2)} s of running)`);
    b.r2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});
