// COMBAT, live-room: engage -> swings -> death -> loot -> pickup -> drop ->
// persistence, against the REAL the_game world and the REAL tuning data.
// Movement mechanics (chase speed vs slow) are covered numerically by
// combat.unit.test.ts; this file proves the ROOM wiring end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOM_NAME, SLOW_FACTOR, PICKUP_RADIUS_WU, PLAYER_RESPAWN_MS, CELL_WU } from "@nangijala/shared";
import { WorldRoom } from "../src/rooms/WorldRoom.js";

// The deploy's test job checks out no world tree: skip BEFORE the server
// opens when the_game is absent (a server left listening keeps node --test
// alive until CI's 20-minute cancel).
const HAVE_WORLD = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "maps2", "worlds3", "the_game", "world.json"));
const SKIP = "maps2/worlds3/the_game missing";

async function waitFor(cond: () => boolean, timeout = 8000, label = "condition"): Promise<void> {
  const start = Date.now();
  const ready = () => {
    try {
      return cond();
    } catch {
      return false; // state/patches not landed yet — see monsters.test.ts note
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

test("combat end to end: engage, kill, loot, pickup, drop, slow, persistence", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2995;
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  // Identity is SERVER-MINTED now: this client carries its pair across the
  // relog exactly as a browser's localStorage does.
  let account: { id?: string; secret?: string } = {};
  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const opts = { world: "the_game", monsterSeed: 4242, monsterCount: 1, lootChance: 1 };
    const r1: any = await c1.joinOrCreate(ROOM_NAME, { interestRadius: 0, /* the whole roster: these tests pick monsters by kind across the map */ name: "Duelist", character: "default_boy", account, ...opts });
    r1.onMessage("account", (a: any) => { account = a; });
    r1.send("account:want");
    const invs: any[] = [];
    r1.onMessage("inv", (msg: any) => invs.push(msg));
    r1.onMessage("chat", () => {});
    r1.onMessage("levelup", () => {});
    r1.onMessage("star", () => {});
    r1.onMessage("live:update", () => {});

    await waitFor(() => r1.state.players.size === 1 && r1.state.monsters.size > 0, 8000, "join");
    const me = () => r1.state.players.get(r1.sessionId);

    // Fresh character: server-owned RO-style stats.
    assert.equal(me().level, 1);
    assert.equal(me().hpMax, 40);
    assert.equal(me().hp, 40);
    assert.equal(me().epMax, 20);
    assert.equal(me().dead, false);
    assert.equal(invs.length >= 1, true, "inventory sent on join");
    assert.deepEqual(invs[0].items, [], "fresh backpack is empty");

    // PASSIVE BY DEFAULT: idle at spawn (inside the frog zone; the nearest
    // predator zone, the saber-tooth's, starts 21 cells out) and nobody
    // attacks — the old tuning default (aggro 96 on everything) would have
    // mobbed the spawn.
    await new Promise((r) => setTimeout(r, 1200));
    let anyHunting = false;
    r1.state.monsters.forEach((m: any) => {
      if (m.mstate === "chase" || m.mstate === "combat") anyHunting = true;
    });
    assert.equal(anyHunting, false, "passive monsters never aggro an idle player");
    assert.equal(me().hp, 40, "untouched at spawn");

    // ENGAGE a mystical_frog (L1: 25hp, 4dmg): teleport into reach, tracking
    // its roaming until the first swing lands (server drives the loop).
    const frog = monsterByKind(r1, "mystical_frog");
    assert.ok(frog, "the_game spawns a mystical_frog");
    const frogId = frog!.id;
    const hp0 = frog!.m.hp;
    assert.ok(hp0 > 0 && frog!.m.hpMax === hp0, "frog spawns at tuning max_hp");
    const chase = setInterval(() => {
      const f = r1.state.monsters.get(frogId);
      if (f) {
        r1.send("teleport", { x: f.x + 24, y: f.y });
        r1.send("engage", { id: frogId });
      }
    }, 200);
    try {
      await waitFor(() => r1.state.monsters.get(frogId)?.hp < hp0, 12000, "first swing lands");
      // The swing signalling every client renders from:
      assert.equal(me().action, "attack");
      assert.ok(me().actionSeq >= 1, "actionSeq bumps per swing");
      // Keep swinging to the kill; frog dies -> die state -> removal.
      await waitFor(() => {
        const f = r1.state.monsters.get(frogId);
        return !!f && f.mstate === "die";
      }, 15000, "frog dies");
    } finally {
      clearInterval(chase);
    }
    // While fighting the frog hit back at least once -> slow window + hurt seq.
    const gotHit = me().hitSeq >= 1;
    if (gotHit) assert.ok(me().hp < 40, "damage landed");

    // XP awarded on the kill (frog xp=8 from tuning; no level at 50-to-next).
    await waitFor(() => me().xp >= 8, 3000, "xp awarded");
    assert.equal(me().level, 1);

    // Corpse sweeps after MONSTER_DIE_MS; lootChance 1 => ALL 3 frog loot
    // entries drop (lichen_green_soulstone, green_slime_glob, smooth_river_stone).
    await waitFor(() => !r1.state.monsters.get(frogId), 4000, "corpse removed");
    await waitFor(() => r1.state.drops.size >= 3, 2000, "loot on the ground");
    const dropIds: string[] = [];
    const dropItems: string[] = [];
    r1.state.drops.forEach((g: any, id: string) => {
      dropIds.push(id);
      dropItems.push(g.item);
    });
    assert.ok(dropItems.includes("green_slime_glob"), "tuning loot table drove the drop");

    // PICKUP: walk (teleport) to a drop and grab it; range is enforced.
    const pid = dropIds[0];
    const pdrop = r1.state.drops.get(pid);
    r1.send("teleport", { x: pdrop.x + PICKUP_RADIUS_WU / 2, y: pdrop.y });
    await new Promise((r) => setTimeout(r, 150));
    const invCountBefore = invs.length;
    r1.send("pickup", { id: pid });
    await waitFor(() => !r1.state.drops.get(pid), 3000, "drop consumed");
    await waitFor(() => invs.length > invCountBefore, 2000, "inv update sent");
    const inv = invs[invs.length - 1].items;
    assert.equal(inv.length, 1);
    assert.equal(inv[0].n, 1);
    assert.equal(me().action, "pickup", "pickup clip signalled");

    // DROP it back out (the backpack drag-out path): appears near the player,
    // clamped + snapped to standable ground. Sit out the 150ms pickup/drop
    // cadence cap first — a human gesture can't beat it, a test can.
    await new Promise((r) => setTimeout(r, 200));
    const before = r1.state.drops.size;
    r1.send("drop", { slot: 0, wx: me().x + 40, wy: me().y });
    await waitFor(() => r1.state.drops.size === before + 1, 3000, "ground item spawned");
    await waitFor(() => invs[invs.length - 1].items.length === 0, 2000, "slot emptied");
    let farthest = 0;
    r1.state.drops.forEach((g: any) => {
      farthest = Math.max(farthest, Math.hypot(g.x - me().x, g.y - me().y));
    });
    assert.ok(farthest < 200, "drops land near the player, never flung");

    // PERSISTENCE: leave with xp+empty-ish inv, rejoin as the SAME ACCOUNT.
    assert.match(String(account.id ?? ""), /^[0-9a-f]{32}$/, "the server minted and handed over an account");
    const xpAtLeave = me().xp;
    await r1.leave();
    const c2 = new Client(`ws://localhost:${port}`);
    const r2: any = await c2.joinOrCreate(ROOM_NAME, { interestRadius: 0, /* the whole roster: these tests pick monsters by kind across the map */ name: "Duelist", character: "default_boy", account, ...opts });
    r2.onMessage("inv", () => {});
    r2.onMessage("chat", () => {});
    r2.onMessage("star", () => {});
    r2.onMessage("live:update", () => {});
    await waitFor(() => r2.state.players.size === 1, 8000, "rejoin");
    const me2 = r2.state.players.get(r2.sessionId);
    assert.equal(me2.xp, xpAtLeave, "xp survives the relog");
    assert.equal(me2.level, 1);
    await r2.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

test("a monster kills a careless player; the player respawns", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2998; // 2994 belongs to timeofday.test.ts — ports are per FILE, not per test
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  try {
    const c1 = new Client(`ws://localhost:${port}`);
    const r1: any = await c1.joinOrCreate(ROOM_NAME, { interestRadius: 0, /* the whole roster: these tests pick monsters by kind across the map */
      name: "Reckless",
      character: "default_girl",
      world: "the_game",
      monsterSeed: 777,
      monsterCount: 1,
    });
    r1.onMessage("inv", () => {});
    r1.onMessage("chat", () => {});
    r1.onMessage("star", () => {});
    r1.onMessage("live:update", () => {});
    await waitFor(() => r1.state.players.size === 1 && r1.state.monsters.size > 0, 8000, "join");
    const me = () => r1.state.players.get(r1.sessionId);
    const spawnX = me().x;
    const spawnY = me().y;

    // Poke the mammoth (L20: 215hp, 34dmg — two hits kill a fresh spawn) and
    // stand there. Retaliation must chase + slow + kill us.
    const mam = monsterByKind(r1, "mammoth");
    assert.ok(mam, "the_game spawns a mammoth");
    const mamId = mam!.id;
    const keep = setInterval(() => {
      const m = r1.state.monsters.get(mamId);
      if (m && !me().dead) {
        r1.send("teleport", { x: m.x + 40, y: m.y });
        r1.send("engage", { id: mamId });
      }
    }, 200);
    try {
      // First hit taken: the synced slow factor drops to SLOW_FACTOR.
      await waitFor(() => me().hitSeq >= 1, 15000, "mammoth lands a hit");
      // slow is written at the NEXT tick top (the hit lands mid-tick), so the
      // patch carrying hitSeq can precede the one carrying slow — poll briefly.
      await waitFor(() => Math.abs(me().slow - SLOW_FACTOR) < 1e-6, 1500, "hit applies the slow");
      const m = r1.state.monsters.get(mamId);
      assert.ok(m.mstate === "combat" || m.mstate === "chase", "mammoth is fighting back");
      await waitFor(() => me().dead === true, 15000, "player dies");
    } finally {
      clearInterval(keep);
    }
    assert.equal(me().action, "die", "die clip signalled");
    assert.equal(me().hp, 0);
    // NOBODY RESPAWNS ON A TIMER ANY MORE. The client runs the death sequence
    // (fade, drain, slow push onto the body) and ends it with a prompt; the
    // press is what asks. So the corpse must still be a corpse after the old
    // 2.6s deadline has passed...
    await new Promise((r) => setTimeout(r, PLAYER_RESPAWN_MS + 900));
    assert.equal(me().dead, true, "a dead player waits for the press, not a timer");
    // ...and come back when it does.
    r1.send("respawn", {});
    await waitFor(() => me().dead === false, 6000, "respawn on the press");
    assert.equal(me().hp, me().hpMax);
    assert.ok(Math.hypot(me().x - spawnX, me().y - spawnY) < 12 * 32, "respawned near the world spawn");
    await r1.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});

/* "DISABLE AGGRO" MEANS IT (maintainer 2026-09-10: "monsters still attack me
 * sometimes with disable aggro enabled").
 *
 * THE INVARIANT, once the switch is on: THE ONLY MONSTER THAT MAY BE HUNTING
 * YOU IS ONE YOU ARE MARKING RIGHT NOW. The mark is the switch's one bypass —
 * raising your sword IS the provocation — and the mark was the leak: nothing
 * ever cleared it. Both places that break off a fight (a ground tap, a nudge
 * of the analog stick) cleared the client's `engagedId` and told the SERVER
 * nothing, despite the comment beside them claiming they disengaged
 * explicitly. So one tap — and the tap box is 26x48 px, so often an accident —
 * left that monster hunting through the switch for the rest of the session,
 * and the body auto-swung at it again whenever it came to rest in range.
 * Measured before the fix on the_game's cave: the aggro scan logged the
 * bypass every 450 ms, indefinitely, with the switch on. */
test("disable aggro: only a monster you are marking may hunt you", async (t) => {
  if (!HAVE_WORLD) return t.skip(SKIP);
  const port = 2998; // ports are per FILE — this one is combat.test.ts's
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom);
  await gameServer.listen(port);
  try {
    const c = new Client(`ws://localhost:${port}`);
    const r: any = await c.joinOrCreate(ROOM_NAME, {
      interestRadius: 0, name: "Pacifist", character: "default_boy",
      world: "the_game", monsterSeed: 4242, monsterCount: 1,
    });
    for (const m of ["chat", "levelup", "star", "live:update", "inv", "account"]) r.onMessage(m, () => {});
    await waitFor(() => r.state.players.size === 1 && r.state.monsters.size > 0, 8000, "join");

    const cands: { id: string; m: any }[] = [];
    r.state.monsters.forEach((mm: any, mid: string) => {
      if (mm.aggro > 0 && mm.mstate !== "die") cands.push({ id: mid, m: mm });
    });
    assert.ok(cands.length > 0, "a monster with an aggro radius to test against");
    const { id, m } = cands[0];
    const hunting = () => m.tsid === r.sessionId;
    const me = () => r.state.players.get(r.sessionId);

    r.send("noaggro", { on: true });
    // Pinned, so an aggro it should never take cannot become a kill either.
    r.send("dbgmonster", { id, pin: true });
    await new Promise((res) => setTimeout(res, 300));
    // Well inside its radius (aggro is in world units; a cell is CELL_WU).
    r.send("teleport", { x: m.x + CELL_WU, y: m.y });
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(hunting(), false, "unmarked, the switch keeps it off me");

    // The one bypass: marking it is the provocation.
    r.send("engage", { id });
    await waitFor(hunting, 5000, "a marked monster hunts me even with the switch on");

    // Re-arming the switch drops my mark and calls the hunt off.
    r.send("noaggro", { on: true });
    await waitFor(() => !hunting(), 5000, "re-arming the switch ends the hunt");

    // ...and so does dropping the mark, which is what a ground tap and a
    // nudge of the stick send. THIS is the one that was never sent.
    r.send("engage", { id });
    await waitFor(hunting, 5000, "marked again");
    r.send("engage", { id: null });
    await waitFor(() => !hunting(), 5000, "dropping the mark ends the hunt");

    // With the switch OFF a provoked hunt is nobody's business but the
    // monster's: dropping the mark must NOT call it off.
    r.send("noaggro", { on: false });
    r.send("engage", { id });
    await waitFor(hunting, 5000, "hunting with the switch off");
    r.send("engage", { id: null });
    // Short on purpose: a release is synchronous on the message, while the
    // monster's OWN give-up (it is pinned, so it never closes) would end the
    // hunt a few seconds later and read as a pass.
    await new Promise((res) => setTimeout(res, 600));
    assert.equal(hunting(), true, "switch off: the fight I started is still mine");

    assert.equal(me().dead, false, "a pinned monster never reached me");
    await r.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
  }
});
