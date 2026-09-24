// ============================================================================
// TWO CELLS OF SLACK AT THE LINE
// ============================================================================
//
// Ownership used to flip the instant a body crossed, so running or fighting
// along a line chained hops (25-35% of the maintainer's hops within 3 s of the
// previous one, up to 7 in 30 s). A player is handed over once it stands
// HANDOFF_HYST_WU (2 cells) outside its room's rectangle, a monster once
// MONSTER_HYST_WU (1 cell) outside, and the owning room keeps a body that
// lingers in the band — so a bounce needs the band twice over.
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

test("a player hops two cells past the line and comes back only two cells past it again; a monster at one", async (t) => {
  if (!HAVE_WORLD) return t.skip("maps2/worlds3/the_game missing");
  useBus(new FakeBus());
  resetWorldClocks();
  const port = 3049; // unique across test files — ports.test.ts gates it
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, interestRadius: 0, monsterSeed: 5 };
  const y = 100 * CELL_WU;
  try {
    const c = new Client(`ws://localhost:${port}`);
    const r: any = await c.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Edge", character: "default_boy" });
    const pid = r.sessionId;
    const S0: any = matchMaker.getLocalRoomById(r.roomId);
    const S1: any = matchMaker.getLocalRoomById((await matchMaker.createRoom(ROOM_NAME, { ...base, zone: 1 })).roomId);
    await waitFor(() => S0.state.players.has(pid), 8000, "joined zone 0");
    const goes: any[] = [];
    r.onMessage("zone:go", (m: any) => { if (m?.zone === 1) goes.push(m); }); // the login's own spawn hop (zone 3) is not this test
    const park = async (x: number) => {
      r.send("teleport", { x, y });
      await waitFor(() => Math.abs(S0.state.players.get(pid).x - x) < 1, 5000, `parked at ${((x - BX) / CELL_WU).toFixed(1)} cells`);
    };
    // Inside zone 0 first, then forget the login's own spawn hop (the spawn
    // lies in zone 3, and a tick may have started it before the park landed).
    await park(BX - 3 * CELL_WU);
    S0.state.players.get(pid).handoff = null;
    await settle(100);
    // 1. ONE CELL OVER: still zone 0's. No hand-off starts.
    await park(BX + 1 * CELL_WU);
    await settle(400);
    assert.equal(goes.length, 0, "one cell past the line is not a crossing");
    assert.ok(S0.state.players.has(pid) && !S0.state.players.get(pid).handoff, "zone 0 still owns the body, no hop in flight");
    // 2. TWO CELLS OVER: the hand-off starts.
    await park(BX + 2 * CELL_WU);
    await waitFor(() => goes.length === 1, 2000, "zone:go at two cells");
    assert.equal(goes[0].zone, 1);
    console.log(`    player: no hop at 1 cell over, zone:go at 2 cells over`);
    // Bind zone 1, as the client does.
    const c2 = new Client(`ws://localhost:${port}`);
    const r2: any = await c2.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Edge", character: "default_boy", pid, handoff: goes[0].key });
    await waitFor(() => r2.state.players.get(pid)?.sid === r2.sessionId, 5000, "adopted in zone 1");
    await waitFor(() => !S0.state.players.has(pid), 5000, "zone 0 let go");
    r.leave();
    const goes2: any[] = [];
    r2.onMessage("zone:go", (m: any) => { if (m?.zone === 0) goes2.push(m); });
    // 3. BACK ONE CELL INTO ZONE 0: still zone 1's — no bounce.
    r2.send("teleport", { x: BX - 1 * CELL_WU, y });
    await waitFor(() => Math.abs(S1.state.players.get(pid).x - (BX - 1 * CELL_WU)) < 1, 5000, "back one cell");
    await settle(400);
    assert.equal(goes2.length, 0, "one cell back over the line is not a crossing either (the old code bounced here)");
    // 4. TWO CELLS BACK: handed back.
    r2.send("teleport", { x: BX - 2 * CELL_WU, y });
    await waitFor(() => goes2.length === 1, 2000, "zone:go back at two cells");
    assert.equal(goes2[0].zone, 0);
    console.log(`    player: no bounce at 1 cell back, hands back at 2 cells back`);
    r2.leave();

    // 5. A MONSTER: half a cell over stays; a cell and a bit over transfers.
    let mid = "";
    S0.state.monsters.forEach((m: any, k: string) => { if (!mid && m.mstate === "roam") mid = k; });
    assert.ok(mid, "a monster to push");
    const m = S0.state.monsters.get(mid);
    Object.assign(m, { x: BX + 0.5 * CELL_WU, y, pinned: true, trip: null, tripActive: false, targetSid: "" });
    await settle(400);
    assert.ok(S0.state.monsters.has(mid) && !S1.state.monsters.has(mid), "half a cell over: still zone 0's monster");
    m.x = BX + 1 * CELL_WU + 2;
    await waitFor(() => S1.state.monsters.has(mid), 3000, "a cell over: zone 1 took it");
    console.log(`    monster: stays at 0.5 cells over, transfers at 1 cell over`);
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});
