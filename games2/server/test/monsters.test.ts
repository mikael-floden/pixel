import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import {
  ROOM_NAME,
  SPAWN_AREAS,
  MONSTER_KINDS,
  areaContains,
} from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";

async function waitFor(cond: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout)
      throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Snapshot the synced monster map of a room as a plain object keyed by id.
function snapshot(room: {
  state: { monsters: { forEach: (cb: (m: any, id: string) => void) => void } };
}): Map<string, { kind: string; x: number; y: number; dir: string; moving: boolean }> {
  const out = new Map<string, { kind: string; x: number; y: number; dir: string; moving: boolean }>();
  room.state.monsters.forEach((m: any, id: string) => {
    out.set(id, { kind: m.kind, x: m.x, y: m.y, dir: m.dir, moving: m.moving });
  });
  return out;
}

test("6 server-authoritative roaming monsters: shared, capped, area-confined, moving", async () => {
  const port = 2997; // unique per test file
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: createServer() }),
  });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);

  // Deterministic spawns/roam; 3 monsters per area (the SPAWN_AREAS default cap).
  const COUNT = 3;
  const opts = {
    world: "ring_test", // the prod DEFAULT world the SPAWN_AREAS are placed on
    monsterSeed: 12345,
    monsterCount: COUNT,
  };
  const expectedTotal = SPAWN_AREAS.length * COUNT; // 6 areas × 3

  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const c2 = new Client(`ws://localhost:${port}`);
    // Both joinOrCreate the SAME ring_test room; the first creates it with the
    // monster options, the second joins the already-created shared world.
    const r1 = await c1.joinOrCreate(ROOM_NAME, { name: "A", character: "char_a", ...opts });
    const r2 = await c2.joinOrCreate(ROOM_NAME, { name: "B", character: "char_b", ...opts });

    await waitFor(() => r1.state.players.size === 2 && r2.state.players.size === 2);
    // Both clients receive the full monster set.
    await waitFor(
      () => r1.state.monsters.size === expectedTotal && r2.state.monsters.size === expectedTotal,
    );

    const areaById = new Map(SPAWN_AREAS.map((a) => [a.id, a]));

    // (b) Count matches SPAWN_AREAS caps (COUNT per area).
    assert.equal(r1.state.monsters.size, expectedTotal, "monster count == 6 areas × cap");

    // (a) Both clients see the SAME set of monsters (ids + kinds).
    const s1 = snapshot(r1);
    const s2 = snapshot(r2);
    assert.deepEqual(
      [...s1.keys()].sort(),
      [...s2.keys()].sort(),
      "both clients see identical monster ids",
    );
    for (const [id, m1] of s1) {
      const m2 = s2.get(id)!;
      assert.equal(m1.kind, m2.kind, `kind agrees across clients for ${id}`);
    }

    // Each monster's kind matches its area, and every kind + area is represented.
    const seenKinds = new Set<string>();
    for (const [id, m] of s1) {
      const areaId = id.split("#")[0];
      const area = areaById.get(areaId)!;
      assert.ok(area, `monster ${id} belongs to a known area`);
      assert.equal(m.kind, area.kind, `${id} kind matches its area kind`);
      seenKinds.add(m.kind);
    }
    for (const k of MONSTER_KINDS) {
      assert.ok(seenKinds.has(k), `kind ${k} is spawned`);
    }

    // Record start positions to prove movement later.
    const startPos = new Map([...s1].map(([id, m]) => [id, { x: m.x, y: m.y }]));

    // (c) Over ~2.5s of ticks, EVERY monster stays inside its area's AABB.
    // Poll repeatedly so a mid-trip excursion would be caught.
    const deadline = Date.now() + 2500;
    let samples = 0;
    while (Date.now() < deadline) {
      r1.state.monsters.forEach((m: any, id: string) => {
        const area = areaById.get(id.split("#")[0])!;
        assert.ok(
          areaContains(area, m.x, m.y),
          `monster ${id} stayed inside its area AABB (at ${m.x.toFixed(1)},${m.y.toFixed(1)})`,
        );
      });
      samples++;
      await new Promise((res) => setTimeout(res, 60));
    }
    assert.ok(samples > 10, "polled area-confinement many times");

    // (d) At least some monsters MOVED (x or y changed) over the window.
    const end1 = snapshot(r1);
    let movedCount = 0;
    for (const [id, m] of end1) {
      const s = startPos.get(id)!;
      if (Math.hypot(m.x - s.x, m.y - s.y) > 1) movedCount++;
    }
    assert.ok(
      movedCount > 0,
      `at least one monster roamed (moved: ${movedCount}/${expectedTotal})`,
    );

    // (e) Both clients' monster positions match (single authoritative sim).
    // Sample both at one instant; patch timing allows at most a small lag, far
    // below an area's ~192wu span — independent sims would diverge by hundreds.
    const a1 = snapshot(r1);
    const a2 = snapshot(r2);
    for (const [id, m1] of a1) {
      const m2 = a2.get(id)!;
      const d = Math.hypot(m1.x - m2.x, m1.y - m2.y);
      assert.ok(
        d < 32,
        `client positions agree for ${id} (Δ=${d.toFixed(2)}wu)`,
      );
    }

    await r1.leave();
    await r2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
