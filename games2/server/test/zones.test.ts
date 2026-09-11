import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client, Room } from "colyseus.js";
import { matchMaker } from "@colyseus/core";
import { ROOM_NAME, CELL_WU, INTEREST_LEAVE_WU, MAX_CHASE_WU, zoneGrid, zoneAt, zoneRect, nearEdge, distToRect, zoneNeighbours, WHOLE_WORLD } from "@nangijala/shared";
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

    // A HIT BEFORE THE HOP, through the real path (dbgkill = hurtPlayer for
    // full hp, then the press-to-continue revive), so the counters the hop
    // must carry are non-zero. The revive stands the body at the world spawn;
    // park it back by the border.
    rA.send("dbgkill");
    await waitFor(() => rA.state.players.get(pidA)?.dead === true, 5000, "dbgkill killed Left");
    for (let i = 0; i < 60 && rA.state.players.get(pidA)?.dead !== false; i++) { rA.send("respawn"); await settle(150); }
    assert.equal(rA.state.players.get(pidA)?.dead, false, "Left revived");
    rA.send("teleport", { x: BORDER_X - 3 * CELL_WU, y });
    await waitFor(() => Math.abs(rA.state.players.get(pidA).x - (BORDER_X - 3 * CELL_WU)) < 1, 5000, "parked again");
    // THE HAND-OFF: Left crosses into zone 1. The old room sends zone:go; the
    // client joins the new room with the pid + key.
    const go = new Promise<{ zone: number; pid: string; key: string }>((res) => rA.onMessage("zone:go", res));
    rA.send("teleport", { x: BORDER_X + 2 * CELL_WU, y });
    const msg = await go;
    assert.equal(msg.zone, 1);
    assert.equal(msg.pid, pidA);
    assert.match(msg.key, /^[0-9a-f]{32}$/);
    const hpBefore = rA.state.players.get(pidA).hp;
    const hitSeqBefore = rA.state.players.get(pidA).hitSeq;
    const actionSeqBefore = rA.state.players.get(pidA).actionSeq;
    assert.ok(hitSeqBefore > 0, "the body crosses with a hit on its counter (the test below is about that)");
    const cA2 = new Client(`ws://localhost:${port}`);
    const rA2: any = await cA2.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Left", character: "default_boy", pid: msg.pid, handoff: msg.key });
    await waitFor(() => rA2.state.players.get(pidA)?.sid === rA2.sessionId, 5000, "the body is in zone 1 under the SAME id, bound to the new session");
    const me2 = rA2.state.players.get(pidA);
    assert.equal(me2.name, "Left");
    assert.equal(me2.hp, hpBefore);
    // THE COMBAT COUNTERS CROSS WITH THE BODY: the client plays the flinch on
    // a CHANGE of hitSeq, so a body rebuilt from zero replayed its last hit
    // at every border (the fall from the other zone, 15 s later).
    assert.equal(me2.hitSeq, hitSeqBefore, "hitSeq carried over");
    assert.equal(me2.actionSeq, actionSeqBefore, "actionSeq carried over");
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

test("one room per zone: a duplicate is locked and hands its arrivals to the owner", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2969;
  useBus(new FakeBus());
  resetWorldClocks();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, monsterCount: 0, interestRadius: 0 };
  try {
    const owner = await matchMaker.createRoom(ROOM_NAME, { ...base, zone: 1 });
    const dup = await matchMaker.createRoom(ROOM_NAME, { ...base, zone: 1 });
    const rooms = await matchMaker.query({ name: ROOM_NAME });
    const dupCache = rooms.find((r) => r.roomId === dup.roomId);
    assert.ok(dupCache?.locked, "the second room of the zone is locked");
    assert.ok(!rooms.find((r) => r.roomId === owner.roomId)?.locked, "the owner is open");
    // A joinOrCreate lands in the owner, never the duplicate.
    const cA = new Client(`ws://localhost:${port}`);
    const rA: any = await cA.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "A", character: "default_boy" });
    assert.equal(rA.roomId, owner.roomId);
    // (A creator's own reservation is honoured before the lock lands, so that
    // one body reaches onJoin and is handed to the owner by adoptPlayer; a
    // later joinById is refused outright — "room is locked" — which is also
    // right. The race itself has no deterministic harness.)
    rA.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});

test("cross-border combat: a player fights, is hit by, kills and loots a monster of the next zone", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2968;
  useBus(new FakeBus());
  resetWorldClocks();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, interestRadius: 0, monsterSeed: 5, lootChance: 1 };
  try {
    const cA = new Client(`ws://localhost:${port}`);
    const cB = new Client(`ws://localhost:${port}`);
    const rA: any = await cA.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Left", character: "default_boy" });
    const rB: any = await cB.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Far", character: "default_girl" });
    const inv: any[] = [];
    rA.onMessage("inv", (m: any) => inv.push(m.items));
    await waitFor(() => rA.state.players.size === 1 && rB.state.monsters.size > 0, 8000, "joined, zone 1 seeded");
    const pidA = rA.sessionId;
    rB.send("teleport", { x: BORDER_X + 60 * CELL_WU, y: 60 * CELL_WU }); // Far stays out of it
    // A zone-1 monster whose spawn area reaches the border, so the fight spot
    // is inside its leash (a monster hauled out of its leash gives up).
    // ...and the WEAKEST such monster, so a level-1 body survives the fight.
    let best: { id: string; y: number; d: number; mid: string; hp: number } | null = null;
    const r1 = zoneRect(GRID, 1);
    rB.state.spawnAreas.forEach((a: any) => {
      // The spot must lie in zone 1's rows, or the pinned monster and the
      // player both belong to the rooms below (which this test never opens).
      const cy = Math.min(r1.y1 - 2 * CELL_WU, Math.max(r1.y0 + 2 * CELL_WU, (a.y0 + a.y1) / 2));
      const px = BORDER_X + 12;
      const d = Math.hypot(px - Math.min(Math.max(px, a.x0), a.x1), cy - Math.min(Math.max(cy, a.y0), a.y1));
      if (d >= MAX_CHASE_WU / 2) return;
      rB.state.monsters.forEach((m: any, id: string) => {
        if (id.startsWith(`z1:${a.id}#`) && m.mstate !== "die" && (!best || m.hpMax < best.hp)) best = { id: a.id, y: cy, d, mid: id, hp: m.hpMax };
      });
    });
    const pick = best as { id: string; y: number; d: number; mid: string; hp: number } | null;
    assert.ok(pick, "a zone-1 area reaches the border");
    const y = pick!.y;
    const mid = pick!.mid, hp = pick!.hp;
    rA.send("teleport", { x: BORDER_X - 12, y });
    await settle(300);
    rB.send("dbgmonster", { id: mid, x: BORDER_X + 12, y, pin: true });
    await waitFor(() => rA.state.ghostMonsters?.has(mid), 5000, "the monster is a ghost in zone 0");
    const me = () => rA.state.players.get(pidA);
    const monster = () => rB.state.monsters.get(mid) ?? rA.state.monsters.get(mid);
    rA.send("engage", { id: mid });
    await waitFor(() => (monster()?.hp ?? hp) < hp, 8000, "the ghost monster loses hp");
    await waitFor(() => me().actionSeq >= 1, 4000, "the real body swings at home");
    await waitFor(() => me().hitSeq >= 1, 12000, "the monster hits back across the line");
    const xp0 = me().xp, lvl0 = me().level;
    await waitFor(() => !monster() || monster()?.mstate === "die", 40000, "the monster dies");
    await waitFor(() => me().xp > xp0 || me().level > lvl0, 5000, "xp reached home");
    assert.ok(!me().dead, "the body survived the fight (a dead ghost may not swing)");
    // Its loot lies where it died; pick it up from across the line.
    let did = "";
    await waitFor(() => {
      const st: any = rA.state;
      st.ghostDrops?.forEach((d: any, id: string) => { if (!did && Math.hypot(d.x - me().x, d.y - me().y) < 6 * CELL_WU) did = id; });
      st.drops?.forEach((d: any, id: string) => { if (!did && Math.hypot(d.x - me().x, d.y - me().y) < 6 * CELL_WU) did = id; });
      return !!did;
    }, 8000, "the loot is visible");
    const drop = rA.state.ghostDrops?.get(did) ?? rA.state.drops.get(did);
    rA.send("teleport", { x: drop.x - 8, y: drop.y });
    await settle(300);
    const nInv = inv.length;
    rA.send("pickup", { id: did });
    await waitFor(() => inv.length > nInv && inv[inv.length - 1].some((s: any) => s.item === drop.item), 6000, "the item is in the backpack");
    rA.leave(); rB.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});

/* A DROPPED LINK MUST NOT LEAVE A TWIN OF YOU STANDING IN THE WORLD
 * (maintainer 2026-09-10: "sometimes when I login I see another version of
 * myself at the exact same spot I was spawned at").
 *
 * A non-consented leave parks that session's onLeave inside
 * `allowReconnection` with the BODY STILL IN STATE — right for a reconnect.
 * The newcomer's kick then reached for `this.clients`, and ACROSS ROOMS that
 * find came up empty, so the `?.` swallowed the kick and the old body stood
 * there. Cross-room is the shipped path, not an edge case: a fresh login joins
 * the world's SPAWN zone and is handed off to wherever you saved, so the room
 * that kicks is almost never the room holding the body. Measured in the
 * browser before the fix: two bodies for ~10 s.
 *
 * The kick rejects the parked grace now, which runs the ONE removal path there
 * is (onLeave's own tail) rather than a second copy of it. */
test("a login in another zone evicts a body whose link merely dropped", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2963; // unique per test FILE — see test/ports.test.ts
  useBus(new FakeBus());
  resetWorldClocks();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, monsterCount: 0, interestRadius: 0 };
  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const r1: any = await c1.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Twin", character: "default_boy" });
    const pair = await new Promise<{ id: string; secret: string }>((res) => { r1.onMessage("account", res); r1.send("account:want"); });
    await waitFor(() => r1.state.players.size === 1, 5000, "the first session in zone 0");
    const zone0 = r1.roomId;
    const bodies = () => matchMaker.getLocalRoomById(zone0)?.state?.players?.size ?? -1;
    assert.equal(bodies(), 1, "zone 0 holds the body");

    // THE LINK DIES WITH NO LEAVE: the body stays, parked on a reconnect grace.
    await r1.leave(false);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(bodies(), 1, "a dropped link keeps the body — that is the reconnect grace, and it is correct");

    // ...and he logs in again, landing in ANOTHER zone (a fresh login joins the
    // spawn zone, not the one he saved in).
    const c2 = new Client(`ws://localhost:${port}`);
    const r2: any = await c2.joinOrCreate(ROOM_NAME, { ...base, zone: 1, name: "Twin", character: "default_boy", account: pair });
    await waitFor(() => r2.state.players.size === 1, 5000, "the second session in zone 1");

    // The body in zone 0 is gone — asserted from zone 0's own state, well
    // inside the 45 s grace so a pass cannot come from it expiring.
    const started = Date.now();
    await waitFor(() => bodies() === 0, 8000, "the dropped body is still standing in zone 0");
    assert.ok(Date.now() - started < 30_000, "the grace expired on its own — this proved nothing");
    r2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});
