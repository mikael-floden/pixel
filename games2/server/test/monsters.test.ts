import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import {
  ROOM_NAME,
  CELL_WU,
  parseWorld,
  buildTerrainGrid,
  parseSpawns,
  buildZoneRuntimes,
  type ZoneRuntime,
} from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";

async function waitFor(cond: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  // A predicate that THROWS means "not ready yet", not "fail": room.state and
  // its MapSchemas are undefined until the first patch lands (see games2
  // CLAUDE.md), so every `r.state.players.size` poll issued right after
  // joinOrCreate can raise a TypeError under CI load. Treating that as false
  // is what the caller means; it used to fail the run and block a deploy.
  const ready = () => {
    try {
      return cond();
    } catch {
      return false;
    }
  };
  while (!ready()) {
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

// The SAME zone resolution the server runs at room create, from the REAL
// shipped files — so the test knows exactly which zones ring_test carries.
function ringTestZones(): ZoneRuntime[] {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const REPO = join(HERE, "..", "..", "..");
  const world = parseWorld(
    JSON.parse(readFileSync(join(REPO, "maps2", "worlds", "ring_test", "world.json"), "utf8")),
  )!;
  const grid = buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks);
  const zones = parseSpawns(
    JSON.parse(readFileSync(join(REPO, "maps2", "worlds", "ring_test", "spawns.json"), "utf8")),
  );
  return buildZoneRuntimes(grid, zones);
}

test("maps2 spawn zones drive the room: shared, per-zone, zone-confined, moving", async () => {
  const port = 2997; // unique per test file
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: createServer() }),
  });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);

  const expected = ringTestZones();
  assert.ok(expected.length > 0, "ring_test ships spawn zones");
  // Deterministic spawns/roam; ONE monster per zone keeps the room light.
  const COUNT = 1;
  const opts = { world: "ring_test", monsterSeed: 12345, monsterCount: COUNT };
  const expectedTotal = expected.length * COUNT;
  const zoneById = new Map(expected.map((z) => [z.zone.id, z]));
  // Containment tolerance: the synced position can lag a snap by a patch, so
  // accept the zone's cells plus their 1-cell ring.
  const okCells = new Map<string, Set<number>>();
  const width = 999999; // key space; use a wide row stride to avoid collisions
  for (const z of expected) {
    const set = new Set<number>();
    for (const cell of z.cells)
      for (let dc = -1; dc <= 1; dc++)
        for (let dr = -1; dr <= 1; dr++) set.add(cell.c + dc + (cell.r + dr) * width);
    okCells.set(z.zone.id, set);
  }

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

    // The zones are published (bbox debug rects) — one per resolved zone.
    assert.equal(r1.state.spawnAreas.length, expected.length, "zones synced to client 1");
    assert.equal(r2.state.spawnAreas.length, expected.length, "zones synced to client 2");
    r1.state.spawnAreas.forEach((a: any) => {
      const z = zoneById.get(a.id);
      assert.ok(z, `synced area ${a.id} is a shipped zone`);
      assert.equal(a.kind, z!.zone.monster, `${a.id} carries the zone's monster id`);
    });

    // (a) Both clients see the SAME set of monsters (ids + kinds), and each
    // monster's kind matches its zone.
    const s1 = snapshot(r1);
    const s2 = snapshot(r2);
    assert.deepEqual([...s1.keys()].sort(), [...s2.keys()].sort(), "identical monster ids");
    for (const [id, m1] of s1) {
      assert.equal(m1.kind, s2.get(id)!.kind, `kind agrees across clients for ${id}`);
      const z = zoneById.get(id.split("#")[0]);
      assert.ok(z, `monster ${id} belongs to a shipped zone`);
      assert.equal(m1.kind, z!.zone.monster, `${id} kind matches its zone's monster`);
    }

    // Record start positions to prove movement later.
    const startPos = new Map([...s1].map(([id, m]) => [id, { x: m.x, y: m.y }]));

    // (b) Over ~2.5s of ticks, EVERY monster stays inside its zone polygon
    // (cells + a 1-cell patch-lag ring). Poll repeatedly so a mid-trip
    // excursion would be caught.
    const deadline = Date.now() + 2500;
    let samples = 0;
    while (Date.now() < deadline) {
      r1.state.monsters.forEach((m: any, id: string) => {
        const ok = okCells.get(id.split("#")[0])!;
        const c = Math.floor(m.x / CELL_WU);
        const r = Math.floor(m.y / CELL_WU);
        assert.ok(
          ok.has(c + r * width),
          `monster ${id} stayed inside its zone (at cell ${c},${r})`,
        );
      });
      samples++;
      await new Promise((res) => setTimeout(res, 60));
    }
    assert.ok(samples > 10, "polled zone-confinement many times");

    // (c) At least some monsters MOVED (x or y changed) over the window.
    const end1 = snapshot(r1);
    let movedCount = 0;
    for (const [id, m] of end1) {
      const s = startPos.get(id)!;
      if (Math.hypot(m.x - s.x, m.y - s.y) > 1) movedCount++;
    }
    assert.ok(movedCount > 0, `at least one monster roamed (moved: ${movedCount}/${expectedTotal})`);

    // (d) Both clients' monster positions match (single authoritative sim).
    // Sample both at one instant; patch timing allows at most a small lag —
    // independent sims would diverge by hundreds of units.
    const a1 = snapshot(r1);
    const a2 = snapshot(r2);
    for (const [id, m1] of a1) {
      const m2 = a2.get(id)!;
      const d = Math.hypot(m1.x - m2.x, m1.y - m2.y);
      assert.ok(d < 32, `client positions agree for ${id} (Δ=${d.toFixed(2)}wu)`);
    }

    await r1.leave();
    await r2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

test("soft separation: same-pad monsters relax to a comfortable distance", async () => {
  const port = 2996; // unique per test
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: createServer() }),
  });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  try {
    const c1 = new Client(`ws://localhost:${port}`);
    // monster_demo: one 5x5 pad per monster, TWO monsters per pad — the
    // worst-case cluster (both seeded on the same few cells). With the
    // separation nudge they must spread out instead of stacking.
    const r1 = await c1.joinOrCreate(ROOM_NAME, {
      name: "S",
      character: "char_s",
      world: "monster_demo",
      monsterSeed: 777,
      monsterCount: 2,
    });
    await waitFor(() => r1.state.players.size === 1 && r1.state.monsters.size > 0, 8000);
    // Let the sim run: seeded pairs start close (possibly overlapping).
    await new Promise((res) => setTimeout(res, 3500));
    // Min pairwise distance per pad (ids are "<zoneId>#n"; same prefix = same pad).
    const byZone = new Map<string, Array<{ x: number; y: number }>>();
    r1.state.monsters.forEach((m: any, id: string) => {
      const z = id.split("#")[0];
      if (!byZone.has(z)) byZone.set(z, []);
      byZone.get(z)!.push({ x: m.x, y: m.y });
    });
    let minD = Infinity;
    for (const list of byZone.values())
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++)
          minD = Math.min(minD, Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y));
    // Comfort target is 18wu; 8 is a generous floor for pairs mid-roam.
    assert.ok(minD >= 8, `same-pad monsters keep distance (min ${minD.toFixed(1)}wu)`);
    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
