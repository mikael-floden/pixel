import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client, Room } from "colyseus.js";
import { ROOM_NAME, CELL_WU, INTEREST_LEAVE_WU, zoneGrid, zoneAt, zoneRect, nearEdge, distToRect, zoneNeighbours, WHOLE_WORLD } from "@nangijala/shared";
import { WorldRoom, resetWorldClocks } from "../src/rooms/WorldRoom.js";
import { FakeBus, useBus } from "../src/bus.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HAVE_WORLD = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"));
const SKIP = "maps2/worlds3/the_game missing";

async function waitFor(cond: () => boolean, timeout = 5000, what = "condition"): Promise<void> {
  const start = Date.now();
  const ready = () => { try { return cond(); } catch { return false; } };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** the_game is 394 cells; a 2 x 2 grid puts the border at cell 197 = 6304 wu. */
const CFG = { cols: 2, rows: 2 };
const GRID = zoneGrid(CFG, 394, 394, CELL_WU);
const BORDER_X = zoneRect(GRID, 0).x1; // between zones 0 and 1

test("zone geometry: grid, membership, neighbours, the border band", () => {
  assert.equal(GRID.zw, 197 * CELL_WU);
  assert.equal(zoneAt(GRID, 0, 0), 0);
  assert.equal(zoneAt(GRID, BORDER_X - 1, 0), 0);
  assert.equal(zoneAt(GRID, BORDER_X, 0), 1);
  assert.equal(zoneAt(GRID, 0, GRID.zh), 2);
  assert.equal(zoneAt(GRID, 1e9, 1e9), 3, "clamped onto the map");
  assert.deepEqual(zoneNeighbours(GRID, 0).sort(), [1, 2, 3]);
  const r0 = zoneRect(GRID, 0);
  assert.equal(distToRect(r0, 10, 10), 0);
  assert.equal(distToRect(r0, BORDER_X + 31, 10), 32);
  assert.ok(nearEdge(r0, GRID, BORDER_X - 10, 100, 64), "inside, near the shared edge");
  assert.ok(!nearEdge(r0, GRID, 5, 5, 64), "the map's own boundary is not an edge");
  assert.ok(!nearEdge(r0, GRID, BORDER_X + 5, 100, 64), "outside is not inside");
  assert.equal(WHOLE_WORLD, -1);
});

/** Two zone rooms in ONE process over the fake bus: a player near the border
 *  is a ghost in the neighbour; walking across hands the body over with its
 *  hit points and backpack intact and the same stable id; the old room lets
 *  go; a monster pushed over the line is transferred with its brain. */
test("ghosts across the border, then a hand-off that keeps the body", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2974;
  useBus(new FakeBus());
  resetWorldClocks();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, monsterCount: 0, interestRadius: 0 };
  try {
    const cA = new Client(`ws://localhost:${port}`);
    const cB = new Client(`ws://localhost:${port}`);
    const rA: any = await cA.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Left", character: "default_boy" });
    const rB: any = await cB.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Right", character: "default_girl" });
    await waitFor(() => rA.state.players.size === 1 && rB.state.players.size === 1, 8000, "both joined their zones");
    const pidA = rA.sessionId;
    const pidB = rB.sessionId;
    // Both are placed at the world spawn, which lies in ONE of the zones: the
    // other room hands its joiner over at once. Park them explicitly instead.
    const y = 100 * CELL_WU;
    rA.send("teleport", { x: BORDER_X - 3 * CELL_WU, y });
    rB.send("teleport", { x: BORDER_X + 3 * CELL_WU, y });
    // Each is a ghost in the other's room, under its stable id, with its name.
    await waitFor(() => rA.state.ghosts?.get(pidB)?.name === "Right", 5000, "Right ghosts into zone 0");
    await waitFor(() => rB.state.ghosts?.get(pidA)?.name === "Left", 5000, "Left ghosts into zone 1");
    assert.ok(!rA.state.players.has(pidB), "a ghost is not a player of this room");
    const gB = rA.state.ghosts.get(pidB);
    assert.ok(Math.abs(gB.x - (BORDER_X + 3 * CELL_WU)) < 1, "the ghost stands where the body stands");
    // Far from the border the ghost is dropped.
    rB.send("teleport", { x: BORDER_X + 3 * INTEREST_LEAVE_WU, y });
    await waitFor(() => !rA.state.ghosts.has(pidB), 5000, "a body away from the border is no ghost");
    rB.send("teleport", { x: BORDER_X + 3 * CELL_WU, y });
    await waitFor(() => rA.state.ghosts.has(pidB), 5000, "and comes back");

    // THE HAND-OFF: Left crosses into zone 1. The old room sends zone:go; the
    // client joins the new room with the pid + key.
    const go = new Promise<{ zone: number; pid: string; key: string }>((res) => rA.onMessage("zone:go", res));
    rA.send("teleport", { x: BORDER_X + 2 * CELL_WU, y });
    const msg = await go;
    assert.equal(msg.zone, 1);
    assert.equal(msg.pid, pidA);
    assert.match(msg.key, /^[0-9a-f]{32}$/);
    const hpBefore = rA.state.players.get(pidA).hp;
    const cA2 = new Client(`ws://localhost:${port}`);
    const rA2: any = await cA2.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Left", character: "default_boy", pid: msg.pid, handoff: msg.key });
    await waitFor(() => rA2.state.players.get(pidA)?.sid === rA2.sessionId, 5000, "the body is in zone 1 under the SAME id, bound to the new session");
    const me2 = rA2.state.players.get(pidA);
    assert.equal(me2.name, "Left");
    assert.equal(me2.hp, hpBefore);
    assert.ok(Math.abs(me2.x - (BORDER_X + 2 * CELL_WU)) < 1, "position carried over");
    // The old room let go of the body (handoff:done over the bus).
    await waitFor(() => !rA.state.players.has(pidA), 5000, "zone 0 dropped the handed-over body");
    // Right, in zone 1, now sees Left as a REAL player, not a ghost.
    await waitFor(() => rB.state.players.has(pidA) && !rB.state.ghosts.has(pidA), 5000, "the neighbour sees a player where the ghost was");
    // A stale key is refused: the same pair joins as a fresh body.
    const cX = new Client(`ws://localhost:${port}`);
    const rX: any = await cX.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Imp", character: "default_boy", pid: msg.pid, handoff: msg.key });
    await waitFor(() => rX.state.players.size >= 1, 5000, "impostor joined");
    await settle(300);
    assert.ok(rX.state.players.get(rX.sessionId), "a consumed key yields an ordinary join under the session id");
    assert.equal(rX.state.players.get(pidA)?.name, "Left", "and never touches the handed body");
    rA.leave(); rA2.leave(); rB.leave(); rX.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});

test("a monster pushed over the border is transferred with its brain; chat crosses zones", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2975;
  useBus(new FakeBus());
  resetWorldClocks();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, interestRadius: 0, monsterSeed: 11 };
  try {
    const cA = new Client(`ws://localhost:${port}`);
    const cB = new Client(`ws://localhost:${port}`);
    const rA: any = await cA.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Left", character: "default_boy" });
    const rB: any = await cB.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Right", character: "default_girl" });
    await waitFor(() => rA.state.monsters.size > 0 && rB.state.monsters.size > 0, 8000, "both zones seeded");
    await settle(300);
    // Every monster of a zone room stands inside its rectangle and carries its prefix.
    const r0 = zoneRect(GRID, 0);
    rA.state.monsters.forEach((m: any, id: string) => {
      assert.ok(id.startsWith("z0:"), `zone 0 ids carry the prefix (${id})`);
      assert.equal(distToRect(r0, m.x, m.y), 0, `${id} seeded inside zone 0`);
    });
    const y = 100 * CELL_WU;
    rA.send("teleport", { x: BORDER_X - 3 * CELL_WU, y });
    rB.send("teleport", { x: BORDER_X + 3 * CELL_WU, y });
    await settle(200);
    // Push one of zone 0's monsters just over the line.
    const [mid, m0] = [...rA.state.monsters.entries()][0] as [string, any];
    const kind = m0.kind;
    rA.send("dbgmonster", { id: mid, x: BORDER_X + CELL_WU, y });
    await waitFor(() => !rA.state.monsters.has(mid) && rB.state.monsters.get(mid)?.kind === kind, 5000, "the monster changed owner");
    assert.ok(!rB.state.ghostMonsters?.has(mid), "the new owner holds no ghost of it");
    // ...and it stands as a ghost in the room it left, since it is in the band.
    await waitFor(() => rA.state.ghostMonsters?.get(mid)?.kind === kind, 5000, "the old room sees it as a ghost");
    // Chat reaches both zones over the bus.
    const heard: string[] = [];
    rB.onMessage("chat", (c: any) => heard.push(c.text));
    rA.send("chat", { text: "hello over the line" });
    await waitFor(() => heard.includes("hello over the line"), 3000, "chat crossed the zones");
    rA.leave(); rB.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});

test("one live session per account, world-wide: a second tab in another zone kicks the first", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2976;
  useBus(new FakeBus());
  resetWorldClocks();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, monsterCount: 0, interestRadius: 0 };
  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const r1: any = await c1.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Tab1", character: "default_boy" });
    const pair = await new Promise<{ id: string; secret: string }>((res) => { r1.onMessage("account", res); r1.send("account:want"); });
    assert.ok(pair.id && pair.secret, "the first join minted an account");
    await waitFor(() => r1.state.players.size === 1, 5000, "tab 1 in zone 0");
    let left: number | null = null;
    r1.onLeave((code: number) => { left = code; });
    const c2 = new Client(`ws://localhost:${port}`);
    const r2: any = await c2.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Tab2", character: "default_boy", account: pair });
    await waitFor(() => r2.state.players.size === 1, 5000, "tab 2 in zone 1");
    await waitFor(() => left !== null, 5000, "tab 1 was kicked from zone 0 by a join in zone 1");
    assert.equal(left, 4001, "the kick code");
    r2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});
