// Regressions from the pre-deploy adversarial review (2026-08-05): the chase
// leash give-up (was unreachable dead code — kited monsters wedged at the rim
// in "chase" forever), world-agnostic progression (was forked per world), and
// the one-live-session-per-ACCOUNT rule (double login duped/ate items).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOM_NAME, CELL_WU, parseWorld, buildTerrainGrid, surfaceFor } from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";
import { accountStore, hashSecret, mintId, newAccount } from "../src/account/store.js";

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


// RUNNING AWAY, on a world 394 cells (12,608wu) a side: a point 1,200wu from the
// monster — three ESCAPE_RADIUS_WU (390) — clamped inside the world, pushed
// toward whichever edge is farther so the clamp can never bring it back in.
const WORLD_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json");
// The deploy's test job checks out no world tree: every test here SKIPS before
// it opens a server when the_game is absent (a server left listening on a
// throw keeps node --test alive until CI's 20-minute cancel).
const HAVE_WORLD = existsSync(WORLD_PATH);
const SKIP = "maps2/worlds3/the_game missing";
const WORLD_DOC = (HAVE_WORLD ? JSON.parse(readFileSync(WORLD_PATH, "utf8")) : { size: { w: 0, h: 0 } }) as { size: { w: number; h: number } };
const WORLD = HAVE_WORLD ? parseWorld(WORLD_DOC)! : null!;
const GRID = HAVE_WORLD ? buildTerrainGrid(WORLD.width, WORLD.height, WORLD.rows, WORLD.props, WORLD.decks) : null!;

/** A spot ~2 cells from the monster it can WALK to: same level, standable, no
 *  deck, no scenery within 3 cells (the room stamps footprints; a hedgehog
 *  lives in a forest, and a blind offset lands behind a tree). */
function besideSpot(m: { x: number; y: number }): { x: number; y: number } {
  const mc = Math.floor(m.x / CELL_WU);
  const mr = Math.floor(m.y / CELL_WU);
  const W = GRID.width;
  const ok = (c: number, r: number) => {
    const i = r * W + c;
    return c > 0 && r > 0 && c < W - 1 && r < GRID.height - 1 && GRID.deck[i] < 0 &&
      GRID.level[i] === GRID.level[mr * W + mc] && surfaceFor(GRID.type[i]).standable &&
      !(WORLD.scenery ?? []).some((p) => Math.abs(p.x - (c + 0.5)) <= 3 && Math.abs(p.y - (r + 0.5)) <= 3);
  };
  for (const [dc, dr] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2]])
    if (ok(mc + dc, mr + dr) && ok(mc + Math.sign(dc), mr + Math.sign(dr)))
      return { x: (mc + dc + 0.5) * CELL_WU, y: (mr + dr + 0.5) * CELL_WU };
  return { x: m.x + 64, y: m.y }; // nothing clear — the fixture will say so by timing out
}
function farFrom(m: { x: number; y: number }): { x: number; y: number } {
  const away = (v: number, cells: number) => {
    const span = cells * CELL_WU;
    return Math.max(64, Math.min(span - 64, v + (v < span / 2 ? 1200 : -1200)));
  };
  return { x: away(m.x, WORLD_DOC.size.w), y: away(m.y, WORLD_DOC.size.h) };
}

function monsterByKind(room: any, kind: string): { id: string; m: any } | null {
  let out: { id: string; m: any } | null = null;
  room.state.monsters.forEach((m: any, id: string) => {
    if (!out && m.kind === kind) out = { id, m };
  });
  return out;
}

test("a kited monster gives up at the leash and returns to roam", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2981; // unique per test file — see the grep-the-tests rule before picking one
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const r1: any = await c1.joinOrCreate(ROOM_NAME, {
      name: "Kiter",
      character: "default_boy",
      world: "the_game",
      monsterSeed: 4242,
      monsterCount: 1,
    });
    for (const t of ["inv", "chat", "star", "live:update", "levelup"]) r1.onMessage(t, () => {});
    await waitFor(() => r1.state.players.size === 1 && r1.state.monsters.size > 0, 8000, "join");
    const me = () => r1.state.players.get(r1.sessionId);

    // Provoke a passive frog (retaliation arms the chase) …
    const frog = monsterByKind(r1, "mystical_frog");
    assert.ok(frog, "the_game spawns a mystical_frog");
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
      // The hunt target is MIRRORED into the synced tsid (round 11: the
      // client draws the red aggro border on monsters whose tsid is mine).
      await waitFor(
        () => r1.state.monsters.get(frogId)?.tsid === r1.sessionId,
        3000,
        "synced tsid mirrors the hunt target",
      );
    } finally {
      clearInterval(poke);
    }

    // … then KITE: park three escape radii from the frog. Its home zone's
    // bbox is most of the shore, so the leash alone might not fire — the
    // monster-to-victim rule (ESCAPE_RADIUS_WU) ends the hunt regardless.
    r1.send("engage", { id: null });
    r1.send("teleport", farFrom(r1.state.monsters.get(frogId)));
    // The give-up: the monster advances to the leash rim, its next contained
    // step is rejected, and it disengages to roam/walk home. Before the fix
    // it pinned at the rim in "chase" forever (the review's live repro).
    await waitFor(() => r1.state.monsters.get(frogId)?.mstate === "roam", 15000, "give-up to roam");
    // tsid clears on the next stepMonsters tick after the disengage (the
    // mirror lives at the tick top, stepCombat's give-up happens after it).
    await waitFor(
      () => r1.state.monsters.get(frogId)?.tsid === "",
      2000,
      "tsid clears when the hunt ends",
    );
    // And it STAYS given up (no chase/disengage yo-yo while we sit far away).
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(r1.state.monsters.get(frogId)?.mstate, "roam", "no re-aggro from across the map");
    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

test("sword-marking provokes on approach; escaping lifts the flee slow", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2979;
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const r1: any = await c1.joinOrCreate(ROOM_NAME, {
      name: "Marker",
      character: "default_boy",
      world: "the_game",
      monsterSeed: 4242,
      monsterCount: 1,
    });
    for (const t of ["inv", "chat", "star", "live:update", "levelup"]) r1.onMessage(t, () => {});
    await waitFor(() => r1.state.players.size === 1 && r1.state.monsters.size > 0, 8000, "join");
    const me = () => r1.state.players.get(r1.sessionId);

    const frog = monsterByKind(r1, "hedgehog");
    assert.ok(frog, "the_game spawns a hedgehog");
    const frogId = frog!.id;
    const f0 = r1.state.monsters.get(frogId);
    assert.equal(f0.aggro, 0, "hedgehogs are passive by tuning (synced for the debug rings)");
    assert.ok(f0.level >= 1, "level is synced for the target frame");

    // (The hedgehog, not the frog: 55hp survives our own server-driven swing
    // loop through the boxing phase — the 25hp frog died mid-test under load
    // and a dead monster never reads "roam".)
    // Mark it with the sword (engage) while standing INSIDE the provoke
    // radius (4 cells) but OUTSIDE swing reach (~40wu): the monster must come
    // to us — no hit was ever landed, the mark alone provokes. Two cells out
    // on ground it can walk (the forest is full of trees).
    r1.send("teleport", besideSpot(f0));
    await new Promise((r) => setTimeout(r, 150));
    r1.send("engage", { id: frogId });
    await waitFor(() => {
      const f = r1.state.monsters.get(frogId);
      return !!f && (f.mstate === "chase" || f.mstate === "combat");
    }, 4000, "marked hedgehog aggros on approach");
    // The hunt pins the flee slow on us (0.8, or 0.55 if a swing lands).
    await waitFor(() => me().slow < 1, 2000, "hunted player carries the flee slow");

    // THE BOXING SHUFFLE: once the frog closes to reach, the standing player
    // circles too — the server drifts an input-less engaged fighter around
    // its opponent (both bodies walk around each other, maintainer round 4).
    await waitFor(() => r1.state.monsters.get(frogId)?.mstate === "combat", 8000, "fight reaches melee");
    const bx0 = me().x;
    const by0 = me().y;
    await new Promise((r) => setTimeout(r, 2000)); // ~12wu of arc at the round-6 orbit speed
    if (!me().dead) {
      const moved = Math.hypot(me().x - bx0, me().y - by0);
      assert.ok(moved > 3, `standing fighter circles its opponent (moved ${moved.toFixed(1)}wu)`);
    }

    // ESCAPE: cross the run-away line — the frog gives up, the slow lifts.
    // Re-asserted every 300ms: under full-suite CPU contention a single
    // teleport can race a landing swing (or a death + dead-guard), and the
    // point here is the GIVE-UP, not one message's luck.
    const escape = farFrom(r1.state.monsters.get(frogId));
    const kite = setInterval(() => {
      if (!me().dead) {
        r1.send("engage", { id: null });
        r1.send("teleport", escape);
      }
    }, 300);
    try {
      // The hunt ENDS: give-up to roam — or, under extreme suite load, our
      // own swing loop finished it off first (the corpse sweeps away); both
      // end the hunt, and the slow-lift below is the design being proved.
      await waitFor(() => {
        const f = r1.state.monsters.get(frogId);
        return !f || f.mstate === "roam" || f.mstate === "die";
      }, 20000, "give-up at the escape line");
      await waitFor(() => me().slow === 1, 4000, "successful escape lifts the slow");
    } finally {
      clearInterval(kite);
    }
    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

test("dropping a stack drops exactly the asked-for count (clamped to what is held)", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2978; // unique per test file — see the grep-the-tests rule before picking one
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  const id = mintId();
  const secret = `qty-${Date.now()}`;
  try {
    // Seed a real STACK straight into the account document — the backpack is
    // private, so this is the only way in without farming 7 kills.
    const rec = newAccount(hashSecret(secret), "Hoarder", "default_girl");
    rec.hp = 40;
    rec.ep = 20;
    rec.inv = [{ item: "green_slime_glob", n: 7 }];
    await accountStore().save(id, rec);
    const c1 = new Client(`ws://localhost:${port}`);
    const invs: any[] = [];
    const r1: any = await c1.joinOrCreate(ROOM_NAME, {
      name: "Hoarder",
      character: "default_girl",
      world: "the_game",
      monsterCount: 0,
      account: { id, secret },
    });
    r1.onMessage("inv", (m: any) => invs.push(m));
    for (const t of ["chat", "star", "live:update", "levelup"]) r1.onMessage(t, () => {});
    await waitFor(() => r1.state.players.size >= 1 && !!r1.state.players.get(r1.sessionId), 8000, "join");
    const me = () => r1.state.players.get(r1.sessionId);
    await waitFor(() => invs.length >= 1, 3000, "inv on join");
    assert.deepEqual(invs[0].items, [{ item: "green_slime_glob", n: 7 }]);

    // THREE of the seven (the quantity dialog's answer).
    r1.send("drop", { slot: 0, item: "green_slime_glob", n: 3, wx: me().x + 40, wy: me().y });
    await waitFor(() => r1.state.drops.size === 3, 4000, "three ground items");
    await waitFor(() => invs[invs.length - 1].items[0]?.n === 4, 2000, "stack keeps the rest");

    // A count BIGGER than the stack is clamped to it, never invented — and
    // emptying the stack drops the slot. Sit out the per-item cadence charge
    // (150ms + 20ms per extra item) the mass drop above bought.
    await new Promise((r) => setTimeout(r, 400));
    r1.send("drop", { slot: 0, item: "green_slime_glob", n: 99, wx: me().x + 40, wy: me().y });
    await waitFor(() => r1.state.drops.size === 7, 4000, "the remaining four, and no more");
    await waitFor(() => invs[invs.length - 1].items.length === 0, 2000, "empty stack leaves the grid");
    let far = 0;
    r1.state.drops.forEach((g: any) => {
      far = Math.max(far, Math.hypot(g.x - me().x, g.y - me().y));
    });
    assert.ok(far < 200, "a mass drop still scatters around the player, never flung");
    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

test("a PREDATOR that aggros on proximity also gives up once you outrun it", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  // Round 9 (maintainer): "aggro monsters should ALSO stop chasing if the
  // player runs away too far". The zone-box leash could not promise that —
  // it is measured from the monster's HOME ZONE, and a big zone's bbox is
  // most of the map — so distance monster-to-victim is now its own give-up
  // rule. Here the hunt is UNPROVOKED (no hit is ever landed; the predator
  // notices us through its tuning aggro radius).
  const port = 2977; // 2978-2981 are taken inside this very file — grep before picking
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const r1: any = await c1.joinOrCreate(ROOM_NAME, {
      name: "Sprinter",
      character: "default_boy",
      world: "the_game",
      monsterSeed: 4242,
      monsterCount: 1,
    });
    for (const t of ["inv", "chat", "star", "live:update", "levelup"]) r1.onMessage(t, () => {});
    await waitFor(() => r1.state.players.size === 1 && r1.state.monsters.size > 0, 8000, "join");
    const me = () => r1.state.players.get(r1.sessionId);

    const cat = monsterByKind(r1, "saber_toothed_tiger");
    assert.ok(cat, "the_game spawns a saber_toothed_tiger");
    const tid = cat!.id;
    assert.ok(r1.state.monsters.get(tid).aggro > 0, "and it is a predator (tuning aggro radius)");

    // Walk into its aggro radius and let it notice us — no attack, no mark.
    const walkIn = setInterval(() => {
      const mm = r1.state.monsters.get(tid);
      if (mm && !me().dead) r1.send("teleport", { x: mm.x + 60, y: mm.y });
    }, 150);
    try {
      await waitFor(() => {
        const s = r1.state.monsters.get(tid)?.mstate;
        return s === "chase" || s === "combat";
      }, 8000, "the predator aggros on proximity");
    } finally {
      clearInterval(walkIn);
    }
    assert.equal(me().hitSeq, 0, "we never traded blows — this hunt is unprovoked");

    // Now outrun it: park well past ESCAPE_RADIUS_WU (390wu ≈ 0.75 screens).
    const far = farFrom(r1.state.monsters.get(tid));
    const flee = setInterval(() => {
      if (!me().dead) r1.send("teleport", far);
    }, 300);
    try {
      await waitFor(() => {
        const f = r1.state.monsters.get(tid);
        return !f || f.mstate === "roam" || f.mstate === "die";
      }, 20000, "the hunt ends at distance");
    } finally {
      clearInterval(flee);
    }
    // …and it stays given up while we are far away.
    await new Promise((r) => setTimeout(r, 1200));
    const end = r1.state.monsters.get(tid);
    assert.ok(!end || end.mstate === "roam" || end.mstate === "die", "no re-aggro from across the map");
    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

test("progression is world-agnostic and one account means one live session", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2980;
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  const id = mintId();
  const secret = `review-${Date.now()}`;
  try {
    // Seed the account (what a previous session in ANY world would have
    // written), then join a world this account has never visited. Position is
    // the only per-world field, so nothing here is world-scoped.
    const rec = newAccount(hashSecret(secret), "Nomad", "default_girl");
    rec.level = 3;
    rec.xp = 10;
    rec.hp = 50;
    rec.ep = 20;
    rec.inv = [{ item: "green_slime_glob", n: 2 }];
    await accountStore().save(id, rec);
    const c1 = new Client(`ws://localhost:${port}`);
    const invs1: any[] = [];
    const opts = { name: "Nomad", character: "default_girl", world: "the_game", monsterCount: 0, account: { id, secret } };
    const r1: any = await c1.joinOrCreate(ROOM_NAME, opts);
    r1.onMessage("inv", (m: any) => invs1.push(m));
    for (const t of ["chat", "star", "live:update", "levelup"]) r1.onMessage(t, () => {});
    await waitFor(() => r1.state.players.size >= 1 && !!r1.state.players.get(r1.sessionId), 8000, "join");
    const p1 = r1.state.players.get(r1.sessionId);
    assert.equal(p1.level, 3, "level follows the account across worlds");
    assert.equal(p1.xp, 10);
    assert.equal(p1.hp, 50);
    await waitFor(() => invs1.length >= 1, 3000, "inv on join");
    assert.deepEqual(invs1[0].items, [{ item: "green_slime_glob", n: 2 }], "backpack follows too");

    // Second login on the SAME account: the old session is kicked (RO-style)
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
