// ============================================================================
// A PLAYER WHO CROSSES A LINE NEVER LEAVES A WATCHER'S SCREEN
// ============================================================================
//
// Monsters got this first (zonehole.test.ts): the room that hands one over
// keeps an overlap ghost, and the receiving room's interest pass runs on the
// tick that adopts. A crossing PLAYER had neither — `handoff:done` deleted the
// body with no ghost behind it (the watcher in the old room lost the sprite for
// 100-250 ms and got a re-created one back), and in the new room the adopted
// body waited for the next scheduled interest pass (0-200 ms) before any
// watcher's view held it. Measured with the sampler below.
//
// Now the body becomes its own ghost in the patch that deletes it, and every
// watcher of the new room takes the body in the patch that drops its ghost.
// The sampler decodes each watcher's state on every turn of the event loop and
// counts the time neither the player nor its ghost is there: zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server } from "@colyseus/core";
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
async function waitFor(cond: () => boolean, timeout = 8000, what = "condition"): Promise<void> {
  const start = Date.now();
  const ready = () => { try { return cond(); } catch { return false; } };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("watchers on both sides hold the crosser, as player or ghost, through every patch of the hop", async (t) => {
  if (!HAVE_WORLD) return t.skip("maps2/worlds3/the_game missing");
  useBus(new FakeBus());
  resetWorldClocks();
  const port = 3044; // unique across test files — ports.test.ts gates it
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, monsterCount: 0 };
  const y = 100 * CELL_WU;
  try {
    const W0: any = await new Client(`ws://localhost:${port}`).joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "W0", character: "default_boy" });
    const W1: any = await new Client(`ws://localhost:${port}`).joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "W1", character: "default_boy" });
    W0.send("teleport", { x: BX - 4 * CELL_WU, y: y + 2 * CELL_WU });
    W1.send("teleport", { x: BX + 4 * CELL_WU, y: y + 2 * CELL_WU });
    for (let trial = 0; trial < 3; trial++) {
      const R: any = await new Client(`ws://localhost:${port}`).joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "R", character: "default_boy" });
      const pid = R.sessionId;
      R.send("teleport", { x: BX - 2 * CELL_WU, y });
      await waitFor(() => W0.state.players.has(pid) && W1.state.ghosts.has(pid), 8000, "the crosser is seen by both watchers");
      await settle(300 + trial * 17); // vary the tick phase
      const holes = { W0: { total: 0, longest: 0, cur: 0 }, W1: { total: 0, longest: 0, cur: 0 } };
      let last = performance.now();
      let running = true;
      const sampler = (async () => {
        while (running) {
          const now = performance.now();
          for (const [name, st] of [["W0", W0.state], ["W1", W1.state]] as const) {
            const h = holes[name];
            const has = st.players.has(pid) || st.ghosts.has(pid);
            if (!has) { h.cur += now - last; h.total += now - last; h.longest = Math.max(h.longest, h.cur); } else h.cur = 0;
          }
          last = now;
          await new Promise((r) => setImmediate(r));
        }
      })();
      const go = new Promise<{ pid: string; key: string }>((res) => R.onMessage("zone:go", (m: any) => { if (m?.zone === 1) res(m); }));
      R.send("teleport", { x: BX + 1 * CELL_WU, y });
      const msg = await go;
      const R2: any = await new Client(`ws://localhost:${port}`).joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "R", character: "default_boy", pid: msg.pid, handoff: msg.key });
      await waitFor(() => R2.state.players.get(pid)?.sid === R2.sessionId, 8000, "adopted in zone 1");
      R.leave();
      await settle(700);
      running = false;
      await sampler;
      console.log(`    trial ${trial}: old-room watcher without the crosser ${holes.W0.total.toFixed(1)} ms, new-room watcher ${holes.W1.total.toFixed(1)} ms`);
      assert.ok(holes.W0.total < 2, `the old room's watcher never lost the crosser (${holes.W0.total.toFixed(1)} ms without it; 100-250 before the overlap ghost)`);
      assert.ok(holes.W1.total < 2, `the new room's watcher never lost the crosser (${holes.W1.total.toFixed(1)} ms without it; 0-200 before the adopt-tick pass)`);
      // And the ghost the old room kept is the crosser as it stands NOW, fed
      // by the new owner: still there after the grace, no stale copy.
      assert.ok(W0.state.ghosts.has(pid), "the old room's overlap ghost is being refreshed by the new owner");
      R2.leave();
      await settle(1500);
    }
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});
