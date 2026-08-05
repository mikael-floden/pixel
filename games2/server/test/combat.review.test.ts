// Regressions from the pre-deploy adversarial review (2026-08-05): the chase
// leash give-up (was unreachable dead code — kited monsters wedged at the rim
// in "chase" forever), world-agnostic progression (was forked per world), and
// the one-live-session-per-token rule (double login duped/ate items).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME } from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";
import { progressStore } from "../src/store.js";

async function waitFor(cond: () => boolean, timeout = 8000, label = "condition"): Promise<void> {
  const start = Date.now();
  const ready = () => {
    try {
      return cond();
    } catch {
      return false;
    }
  };
  while (!ready()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

function monsterByKind(room: any, kind: string): { id: string; m: any } | null {
  let out: { id: string; m: any } | null = null;
  room.state.monsters.forEach((m: any, id: string) => {
    if (!out && m.kind === kind) out = { id, m };
  });
  return out;
}

test("a kited monster gives up at the leash and returns to roam", async () => {
  const port = 2981; // unique per test file — see the grep-the-tests rule before picking one
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const r1: any = await c1.joinOrCreate(ROOM_NAME, {
      name: "Kiter",
      character: "default_boy",
      world: "monster_demo",
      monsterSeed: 4242,
      monsterCount: 1,
    });
    for (const t of ["inv", "chat", "star", "live:update", "levelup"]) r1.onMessage(t, () => {});
    await waitFor(() => r1.state.players.size === 1 && r1.state.monsters.size > 0, 8000, "join");
    const me = () => r1.state.players.get(r1.sessionId);

    // Provoke a passive frog (retaliation arms the chase) …
    const frog = monsterByKind(r1, "mystical_frog");
    assert.ok(frog, "monster_demo spawns a mystical_frog");
    const frogId = frog!.id;
    const hp0 = frog!.m.hp;
    const poke = setInterval(() => {
      const f = r1.state.monsters.get(frogId);
      if (f && !me().dead) {
        r1.send("teleport", { x: f.x + 24, y: f.y });
        r1.send("engage", { id: frogId });
      }
    }, 200);
    try {
      await waitFor(() => r1.state.monsters.get(frogId)?.hp < hp0, 12000, "first swing lands");
      await waitFor(() => {
        const s = r1.state.monsters.get(frogId)?.mstate;
        return s === "chase" || s === "combat";
      }, 6000, "frog fights back");
    } finally {
      clearInterval(poke);
    }

    // … then KITE: park far beyond the leash (55x55 world; the pads ring the
    // spawn near the top-left, the far corner is >1000wu from any of them).
    r1.send("engage", { id: null });
    r1.send("teleport", { x: 1600, y: 1600 });
    // The give-up: the monster advances to the leash rim, its next contained
    // step is rejected, and it disengages to roam/walk home. Before the fix
    // it pinned at the rim in "chase" forever (the review's live repro).
    await waitFor(() => r1.state.monsters.get(frogId)?.mstate === "roam", 15000, "give-up to roam");
    // And it STAYS given up (no chase/disengage yo-yo while we sit far away).
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(r1.state.monsters.get(frogId)?.mstate, "roam", "no re-aggro from across the map");
    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

test("sword-marking provokes on approach; escaping lifts the flee slow", async () => {
  const port = 2979;
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const r1: any = await c1.joinOrCreate(ROOM_NAME, {
      name: "Marker",
      character: "default_boy",
      world: "monster_demo",
      monsterSeed: 4242,
      monsterCount: 1,
    });
    for (const t of ["inv", "chat", "star", "live:update", "levelup"]) r1.onMessage(t, () => {});
    await waitFor(() => r1.state.players.size === 1 && r1.state.monsters.size > 0, 8000, "join");
    const me = () => r1.state.players.get(r1.sessionId);

    const frog = monsterByKind(r1, "mystical_frog");
    assert.ok(frog, "monster_demo spawns a mystical_frog");
    const frogId = frog!.id;
    const f0 = r1.state.monsters.get(frogId);
    assert.equal(f0.aggro, 0, "frogs are passive by tuning (synced for the debug rings)");
    assert.ok(f0.level >= 1, "level is synced for the target frame");

    // Mark it with the sword (engage) while standing INSIDE the provoke
    // radius but OUTSIDE swing reach: the monster must come to us — no hit
    // was ever landed, the mark alone provokes.
    const fx = f0.x;
    const fy = f0.y;
    r1.send("teleport", { x: fx + 100, y: fy });
    await new Promise((r) => setTimeout(r, 150));
    r1.send("engage", { id: frogId });
    await waitFor(() => {
      const f = r1.state.monsters.get(frogId);
      return !!f && (f.mstate === "chase" || f.mstate === "combat");
    }, 4000, "marked frog aggros on approach");
    // The hunt pins the flee slow on us (0.8, or 0.55 if a swing lands).
    await waitFor(() => me().slow < 1, 2000, "hunted player carries the flee slow");

    // ESCAPE: cross the run-away line — the frog gives up, the slow lifts.
    r1.send("engage", { id: null });
    r1.send("teleport", { x: 1600, y: 1600 });
    await waitFor(() => r1.state.monsters.get(frogId)?.mstate === "roam", 15000, "give-up at the escape line");
    await waitFor(() => me().slow === 1, 4000, "successful escape lifts the slow");
    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

test("progression is world-agnostic and one token means one live session", async () => {
  const port = 2980;
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  const token = `review-${Date.now()}`;
  try {
    // Seed the SHARED progress store (what a previous session in any world
    // would have written), then join a world this token has never visited.
    progressStore().save(token, {
      level: 3,
      xp: 10,
      hp: 50,
      ep: 20,
      inv: [{ item: "green_slime_glob", n: 2 }],
    });
    const c1 = new Client(`ws://localhost:${port}`);
    const invs1: any[] = [];
    const opts = { name: "Nomad", character: "default_girl", world: "prop_demo", token };
    const r1: any = await c1.joinOrCreate(ROOM_NAME, opts);
    r1.onMessage("inv", (m: any) => invs1.push(m));
    for (const t of ["chat", "star", "live:update", "levelup"]) r1.onMessage(t, () => {});
    await waitFor(() => r1.state.players.size >= 1 && !!r1.state.players.get(r1.sessionId), 8000, "join");
    const p1 = r1.state.players.get(r1.sessionId);
    assert.equal(p1.level, 3, "level follows the token across worlds");
    assert.equal(p1.xp, 10);
    assert.equal(p1.hp, 50);
    await waitFor(() => invs1.length >= 1, 3000, "inv on join");
    assert.deepEqual(invs1[0].items, [{ item: "green_slime_glob", n: 2 }], "backpack follows too");

    // Second login on the SAME token: the old session is kicked (RO-style)
    // and the newcomer takes over the live progression — no dup, no
    // last-writer-wins eating items.
    let kicked = false;
    r1.onLeave(() => {
      kicked = true;
    });
    const c2 = new Client(`ws://localhost:${port}`);
    const r2: any = await c2.joinOrCreate(ROOM_NAME, opts);
    for (const t of ["inv", "chat", "star", "live:update", "levelup"]) r2.onMessage(t, () => {});
    await waitFor(() => kicked, 8000, "old session kicked");
    await waitFor(() => {
      const p2 = r2.state.players.get(r2.sessionId);
      return !!p2 && p2.level === 3 && r2.state.players.size === 1;
    }, 8000, "newcomer owns the character alone");
    await r2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
