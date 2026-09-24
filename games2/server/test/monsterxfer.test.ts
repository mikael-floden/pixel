// ============================================================================
// A MONSTER CROSSES A LINE WITH ITS WALK AND ITS FIGHT
// ============================================================================
//
// `monster:xfer` used to rebuild the monster with no trip and `nextMoveAt =
// now + 200` (a stand-still at every line, then a new random heading), keep
// the hunt only when the victim was a PLAYER of the new room (a ghost victim —
// the monster crossing AWAY from its prey — dropped the hunt into a roam
// outside its polygon, and the safety net snapped it home 181-398 wu), and
// zero `nextAttackAt` (a fight that crossed bit twice 6 ms apart).
//
// Two crossings, driven from the server side so the geometry is exact:
//  1. A monster WALKING HOME across the line (a trip in flight, `returning`)
//     arrives with the same goal and is moving within 150 ms — the old code
//     stood 200 ms and re-rolled.
//  2. A monster HUNTING a player who stays behind is pushed over the line:
//     the new room holds the victim only as a ghost. The hunt survives, the
//     bite cooldown survives, and the monster walks back toward its prey with
//     no jump — the old code snapped it home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "http";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { ROOM_NAME, CELL_WU, zoneGrid, zoneRect, startTrip } from "@nangijala/shared";
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
/** Sample a monster's position across both rooms every 10 ms: the largest
 *  step between samples (a snap is hundreds of wu), and who owns it. */
async function track(S0: any, S1: any, id: string, ms: number) {
  const out = { maxStep: 0, owners: new Set<number>(), last: null as { x: number; y: number } | null, samples: 0 };
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m1 = S1.state.monsters.get(id), m0 = S0.state.monsters.get(id);
    const m = m1 ?? m0;
    if (m) {
      out.owners.add(m1 ? 1 : 0);
      if (out.last) out.maxStep = Math.max(out.maxStep, Math.hypot(m.x - out.last.x, m.y - out.last.y));
      out.last = { x: m.x, y: m.y };
      out.samples++;
    }
    await settle(10);
  }
  return out;
}

test("a monster crosses a line with its walk and its fight", async (t) => {
  if (!HAVE_WORLD) return t.skip("maps2/worlds3/the_game missing");
  useBus(new FakeBus());
  resetWorldClocks();
  const port = 3046; // unique across test files — ports.test.ts gates it
  const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
  gameServer.define(ROOM_NAME, WorldRoom).filterBy(["world", "zone"]);
  await gameServer.listen(port);
  const base = { world: "the_game", zonesCfg: CFG, interestRadius: 0, monsterSeed: 5 };
  try {
    // A watcher in zone 0 (so it sims at 20 Hz and mirrors its bodies east);
    // zone 1 wakes through the band. The player stands 2 cells west of the line.
    const c = new Client(`ws://localhost:${port}`);
    const r: any = await c.joinOrCreate(ROOM_NAME, { ...base, zone: 0, name: "Prey", character: "default_boy" });
    const pid = r.sessionId;
    const S0: any = matchMaker.getLocalRoomById(r.roomId);
    const r1 = await matchMaker.createRoom(ROOM_NAME, { ...base, zone: 1 });
    const S1: any = matchMaker.getLocalRoomById(r1.roomId);
    await waitFor(() => S0.state.players.has(pid) && S0.state.monsters.size > 0 && S1.state.monsters.size > 0, 8000, "joined zone 0 with monsters");
    S0.state.players.get(pid).handoff = null; // the login's own spawn hop (the spawn lies in zone 3) is not this test
    // THE HABITAT THAT STRADDLES THE LINE: grass-17 is seeded by zone 1 and
    // its polygon spans x = BX, so a body of it may stand and hunt on either
    // side within its own leash (any other habitat's rules would end the hunt
    // before the transfer, which is not what this test is about). Every room
    // holds the whole spawn-zone list, so a zone-0 monster can be given it.
    let gArea = "";
    S1.state.monsters.forEach((m: any, k: string) => { if (!gArea && k.startsWith("z1:grass-17#")) gArea = m.areaId; });
    assert.ok(gArea, "zone 1 seeds grass-17");
    const zg = S1.zones.find((q: any) => q.zone.id === gArea);
    const col = BX / CELL_WU;
    const rows = new Map<number, Set<number>>();
    for (const c of zg.cells) { if (!rows.has(c.r)) rows.set(c.r, new Set()); rows.get(c.r)!.add(c.c); }
    const spanning = [...rows.entries()].filter(([, cs]) => [-4, -3, -2, -1, 0, 1, 2, 3].every((d) => cs.has(col + d))).map(([rr]) => rr).sort((a, b) => a - b);
    assert.ok(spanning.length, "a grass-17 row spans the line");
    const y = (spanning[Math.floor(spanning.length / 2)] + 0.5) * CELL_WU;
    r.send("teleport", { x: BX - 2 * CELL_WU, y });
    await waitFor(() => Math.abs(S0.state.players.get(pid).x - (BX - 2 * CELL_WU)) < 1, 5000, "parked");
    await waitFor(() => S1.state.ghosts.has(pid), 5000, "zone 1 mirrors the player as a ghost");
    let id = "";
    S0.state.monsters.forEach((m: any, k: string) => { if (!id && m.mstate === "roam" && !m.pinned) id = k; });
    assert.ok(id, "a roaming monster to borrow");
    S0.state.monsters.get(id).areaId = gArea;
    const grid = S0.terrain;

    // 1. WALKING HOME ACROSS THE LINE. Put it 2 cells east of the line (zone
    //    1's ground) on a trip back to where it stood: zone 0 hands it over on
    //    its next tick, and zone 1 must carry the walk on.
    {
      const m = S0.state.monsters.get(id);
      const home = { x: (col - 4 + 0.5) * CELL_WU, y }; // a grass-17 cell 4 cells west of the line
      m.x = BX + 2 * CELL_WU; m.y = y;
      m.targetSid = ""; m.mstate = "roam"; m.provoked = false;
      m.targetX = home.x; m.targetY = home.y;
      m.trip = startTrip(grid, m.x, m.y, home.x, home.y, false, Date.now(), m.elev, undefined, 900, false);
      m.tripActive = !!m.trip;
      m.returning = true;
      assert.ok(m.tripActive, "a route home exists");
      await waitFor(() => S1.state.monsters.has(id), 3000, "zone 1 took the monster");
      const arrivedAt = Date.now();
      const m1 = S1.state.monsters.get(id);
      const at = { x: m1.x, y: m1.y };
      assert.ok(m1.tripActive && m1.returning, "the walk home is in flight on arrival, not a 200 ms pause");
      assert.ok(Math.hypot(m1.targetX - home.x, m1.targetY - home.y) < 1, "toward the same goal");
      await settle(150);
      const m1b = S1.state.monsters.get(id) ?? S0.state.monsters.get(id);
      const moved = Math.hypot(m1b.x - at.x, m1b.y - at.y);
      console.log(`    walking home: ${moved.toFixed(1)} wu covered in the 150 ms after arrival (0 on the old code: nextMoveAt = now + 200)`);
      assert.ok(moved > 3, `it kept walking (${moved.toFixed(1)} wu in 150 ms after ${Date.now() - arrivedAt} ms)`);
      // Let it get home and settle (it re-crosses into zone 0 on the way).
      await waitFor(() => S0.state.monsters.has(id), 8000, "back in zone 0");
      await settle(300);
    }

    // 2. HUNTING A PLAYER WHO STAYS BEHIND. The monster hunts the player,
    //    then is pushed 3 cells over the line (a knockback, the orbit, a
    //    shove). Zone 1 holds its prey only as a ghost.
    {
      const m = S0.state.monsters.get(id);
      // The prey does not die under the bites this arm takes to play out (with
      // the slack at the line the hunter fights from zone 1 for a while before
      // it is a cell back into zone 0): a dead victim ends any hunt, rightly.
      { const prey = S0.state.players.get(pid); prey.hp = prey.hpMax = 100000; }
      m.x = BX + 3 * CELL_WU; m.y = y;
      m.targetSid = pid; m.mstate = "chase"; m.provoked = true; m.tsid = pid;
      m.chaseOx = m.x; m.chaseOy = m.y;
      m.trip = null; m.tripActive = false; m.returning = false;
      m.nextAttackAt = Date.now() + 1500; // mid-cooldown
      const tracked = track(S0, S1, id, 900);
      await waitFor(() => S1.state.monsters.has(id), 3000, "zone 1 took the hunter");
      const m1 = S1.state.monsters.get(id);
      const cool = m1.nextAttackAt - Date.now();
      assert.equal(m1.targetSid, pid, "the hunt survives although the victim is only a ghost here");
      assert.ok(m1.mstate === "chase" || m1.mstate === "combat", `still hunting (${m1.mstate})`);
      assert.ok(cool > 1000 && cool <= 1500, `the bite cooldown crossed with it (${cool} ms left; 0 on the old code)`);
      const arrivedX = m1.x;
      const res = await tracked;
      console.log(`    hunting a ghost: owners seen ${[...res.owners].join(",")}, largest step between 10 ms samples ${res.maxStep.toFixed(1)} wu over ${res.samples} samples`);
      assert.ok(res.maxStep < 2 * CELL_WU, `no snap home (largest step ${res.maxStep.toFixed(0)} wu; the old code jumped 181-398)`);
      assert.ok(res.last && res.last.x < arrivedX - 3, `it walks toward its prey (x ${arrivedX.toFixed(0)} -> ${res.last?.x.toFixed(0)})`);
      // With the slack at the line (HANDOFF_HYST_WU) the hunter fights from
      // wherever it stands — a cell into zone 0 hands it back, in reach of its
      // prey from inside zone 1's band it stays zone 1's and bites across the
      // line as cross-border combat does. Either way the hunt holds and the
      // bites land.
      await waitFor(() => S0.state.players.get(pid).hp < 100000, 10000, "the hunter bites its prey from wherever it stands");
      const owner = S0.state.monsters.has(id) ? S0 : S1;
      assert.equal(owner.state.monsters.get(id).targetSid, pid, "with the hunt intact");
      console.log(`    the fight went on from zone ${owner === S0 ? 0 : 1}: prey hp ${S0.state.players.get(pid).hp} of 100000`);
    }
    r.leave();
  } finally {
    await gameServer.gracefullyShutdown(false);
    useBus(null);
  }
});
