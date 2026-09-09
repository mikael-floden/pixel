#!/usr/bin/env node
// THE LOAD BOT (spec/ZONES.md phase 4): N fake clients on the real world,
// walking, crossing zone borders and picking fights, against a running
// server — the players-per-room-per-CPU number this whole plan hangs on.
//
//   node scripts/loadbot.mjs --n 200 --seconds 60 [--url ws://127.0.0.1:2567]
//                            [--world the_game] [--border 99] [--fight]
//
// Each bot joins like the game does (the zone owning the world's spawn),
// teleports to a random spot within a few cells of `--border` (an x border
// of the zone grid, so crossings happen), then streams inputs at 20 Hz on a
// random-walk heading and follows every zone:go exactly as the client does.
// Every second the server's /api/stats (tick p50/p95/max per room, CPU of
// one core, event-loop lag) is sampled; the bots measure their own ACK
// LATENCY (input seq sent → seen acked in state) and hand-off count. The
// summary at the end is the measurement; paste it into docs/backend.md.
import { Client } from "colyseus.js";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const N = Number(arg("n", 50));
const SECONDS = Number(arg("seconds", 60));
const URL = arg("url", "ws://127.0.0.1:2567");
const HTTP = URL.replace(/^ws/, "http");
const WORLD = arg("world", "the_game");
const BORDER = Number(arg("border", 99)); // cell x of the border to straddle
const FIGHT = process.argv.includes("--fight");
// --pack cx,cy: everyone within a few cells of ONE spot inside one zone (the
// crowded-room ceiling); without it the fleet straddles --border (crossings).
const NOINTEREST = process.argv.includes("--nointerest"); // rooms created with interestRadius 0 (bisect)
const PACK = arg("pack", "") ? arg("pack", "").split(",").map(Number) : null;
const RAMP_MS = Number(arg("ramp", 4000)); // join the fleet over this long (not all at once)
const CELL = 32;

const worldDoc = await (await fetch(`${HTTP}/assets/maps2/worlds3/${WORLD}/world.json`)).json().catch(() => null);
const zonesCfg = await (await fetch(`${HTTP}/api/zones/${WORLD}`)).json().catch(() => null);
const W = worldDoc?.size?.w ?? 394, H = worldDoc?.size?.h ?? 394;
const spawn = Array.isArray(worldDoc?.spawn) ? worldDoc.spawn : [W / 2, H / 2];
const grid = zonesCfg ? { cols: zonesCfg.cols, rows: zonesCfg.rows, zw: Math.ceil(W / zonesCfg.cols) * CELL, zh: Math.ceil(H / zonesCfg.rows) * CELL } : null;
const zoneAt = (x, y) => grid ? Math.min(grid.rows - 1, Math.max(0, Math.floor(y / grid.zh))) * grid.cols + Math.min(grid.cols - 1, Math.max(0, Math.floor(x / grid.zw))) : -1;
const spawnZone = zoneAt((spawn[0] + 0.5) * CELL, (spawn[1] + 0.5) * CELL);
console.log(`world ${WORLD} ${W}x${H}, grid ${grid ? grid.cols + "x" + grid.rows : "none"}, spawn zone ${spawnZone}, ${N} bots for ${SECONDS}s at ${URL}${FIGHT ? " (fighting)" : ""}${PACK ? ` packed at ${PACK}` : ` straddling x=${BORDER}`}`);

const ackLat = []; // ms
// THIS process's own event-loop lag: if the bots starve, their ack numbers
// measure the harness, not the server.
let botLagMax = 0;
{ let exp = Date.now() + 100; setInterval(() => { botLagMax = Math.max(botLagMax, Date.now() - exp); exp = Date.now() + 100; }, 100).unref(); }
let handoffs = 0, joinFails = 0, kicks = 0, teleports = 0, decodeErrs = 0;
const origWarn = console.warn; console.warn = (...a) => { if (String(a[0]).includes("refId")) { decodeErrs++; return; } origWarn(...a); };
const origErr = console.error; console.error = (...a) => { if (String(a[0]).includes("refId")) { decodeErrs++; return; } origErr(...a); };
const lastAckAt = new Map(); // bot i → when its ack last advanced
const bots = [];

async function bot(i) {
  const name = `bot${i}`;
  let client = new Client(URL);
  let room, pid = "", myKey = "";
  const pending = new Map(); // seq → sent at
  let seq = 0;
  let heading = Math.random() * Math.PI * 2;
  let sender = null, acker = null, steerer = null, fighter = null;
  const dead = { v: false };
  const bind = (r, first) => {
    room = r;
    if (first) pid = r.sessionId;
    r.onMessage("zone:go", async (msg) => {
      if (typeof msg?.zone !== "number") return;
      try {
        const c2 = new Client(URL);
        const next = await c2.joinOrCreate("world", { name, character: "default_boy", world: WORLD, zone: msg.zone, pid: msg.pid, handoff: msg.key, ...(NOINTEREST ? { interestRadius: 0 } : {}) });
        const old = room;
        bind(next, false);
        handoffs++;
        old.leave(true);
      } catch (e) { joinFails++; }
    });
    r.onLeave((code) => { if (code === 4001) kicks++; if (room === r && !dead.v) { /* dropped: stop */ dead.v = true; } });
    r.onMessage("*", () => {});
  };
  try {
    room = await client.joinOrCreate("world", { name, character: "default_boy", world: WORLD, zone: spawnZone, ...(NOINTEREST ? { interestRadius: 0 } : {}) });
  } catch (e) { joinFails++; return; }
  bind(room, true);
  // Park near the border: x within ±6 cells, y random over the middle band.
  const x = PACK ? (PACK[0] + Math.random() * 6 - 3) * CELL : (BORDER + (Math.random() * 12 - 6)) * CELL;
  const y = PACK ? (PACK[1] + Math.random() * 6 - 3) * CELL : (H * 0.25 + Math.random() * H * 0.5) * CELL;
  await new Promise((r) => setTimeout(r, 300));
  room.send("teleport", { x, y }); teleports++;
  // 20 Hz inputs on a slowly wandering heading, biased to cross the border.
  sender = setInterval(() => {
    if (dead.v || !room) return;
    const s = ++seq;
    pending.set(s, Date.now());
    if (pending.size > 200) pending.delete(pending.keys().next().value);
    room.send("input", { ax: Math.cos(heading), ay: Math.sin(heading), running: true, seq: s, dt: 0.05 });
  }, 50);
  steerer = setInterval(() => {
    // Turn around when more than ~10 cells from the border, else wander.
    const me = room?.state?.players?.get(pid);
    if (PACK) {
      const dx = PACK[0] * CELL - (me?.x ?? 0), dy = PACK[1] * CELL - (me?.y ?? 0);
      if (me && Math.hypot(dx, dy) > 12 * CELL) heading = Math.atan2(dy, dx);
      else heading += (Math.random() - 0.5) * 1.2;
    } else if (me && Math.abs(me.x - BORDER * CELL) > 10 * CELL) heading = me.x > BORDER * CELL ? Math.PI : 0;
    else heading += (Math.random() - 0.5) * 1.2;
  }, 1500 + Math.random() * 1500);
  acker = setInterval(() => {
    const me = room?.state?.players?.get(pid);
    if (!me) return;
    const acked = me.seq;
    let advanced = false;
    for (const [s, t] of pending) if (s <= acked) { ackLat.push(Date.now() - t); pending.delete(s); advanced = true; }
    if (advanced || !lastAckAt.has(i)) lastAckAt.set(i, Date.now());
    if (ackLat.length > 20000) ackLat.splice(0, ackLat.length - 20000);
  }, 50);
  if (FIGHT) fighter = setInterval(() => {
    const me = room?.state?.players?.get(pid);
    if (!me || me.dead) return;
    let best = null, bd = 6 * CELL;
    room.state.monsters?.forEach((m, id) => { const d = Math.hypot(m.x - me.x, m.y - me.y); if (m.mstate !== "die" && d < bd) { bd = d; best = id; } });
    if (best) room.send("engage", { id: best });
  }, 2000);
  bots.push({ stop: () => { for (const t of [sender, acker, steerer, fighter]) if (t) clearInterval(t); dead.v = true; try { room?.leave(true); } catch {} } });
}

// Ramp the fleet in over RAMP_MS so the join burst is not the measurement.
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  void bot(i);
  await new Promise((r) => setTimeout(r, RAMP_MS / N));
}
console.log(`fleet joined in ${((Date.now() - t0) / 1000).toFixed(1)}s (${joinFails} join failures)`);

const samples = [];
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const tEnd = Date.now() + SECONDS * 1000;
while (Date.now() < tEnd) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const st = await (await fetch(`${HTTP}/api/stats`)).json();
    samples.push(st);
      const busiest = [...st.rooms].sort((a, b) => b.tickMs.p95 - a.tickMs.p95)[0];
    const lat = ackLat.slice(-2000);
    process.stdout.write(`\r${((tEnd - Date.now()) / 1000).toFixed(0).padStart(3)}s cpu ${String(st.cpuPct).padStart(5)}% lag ${String(st.loopLagMs.max).padStart(3)}ms rooms ${st.rooms.length} players ${st.totals.players} | busiest z${busiest?.zone} clients ${busiest?.clients} tick p50 ${busiest?.tickMs.p50} p95 ${busiest?.tickMs.p95} max ${busiest?.tickMs.max} | ack p50 ${pct(lat, 0.5)} p95 ${pct(lat, 0.95)} | hops ${handoffs} kicks ${kicks} fails ${joinFails} | botlag ${botLagMax}ms | stuck ${[...lastAckAt.values()].filter((t) => Date.now() - t > 5000).length} decodeErr ${decodeErrs}   `);
    botLagMax = 0;
  } catch (e) { process.stdout.write(`\rstats fetch failed: ${e.message}   `); }
}
console.log();
for (const b of bots) b.stop();
await new Promise((r) => setTimeout(r, 500));

// ---- the summary ----
const last = samples.slice(-Math.min(samples.length, Math.floor(SECONDS / 2))); // second half of the run
const cpu = last.map((s) => s.cpuPct);
const lag = last.map((s) => s.loopLagMs.max);
const perRoom = new Map();
for (const s of last) for (const r of s.rooms) {
  const k = `z${r.zone}/${r.id.slice(0, 4)}`;
  const e = perRoom.get(k) ?? { clients: [], p50: [], p95: [], max: [], monsters: [], ghosts: [] };
  e.clients.push(r.clients); e.p50.push(r.tickMs.p50); e.p95.push(r.tickMs.p95); e.max.push(r.tickMs.max); e.monsters.push(r.monsters); e.ghosts.push(r.ghosts);
  perRoom.set(k, e);
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
console.log(`\n== ${N} bots, ${SECONDS}s, second half ==`);
console.log(`process: cpu mean ${mean(cpu).toFixed(0)}% max ${Math.max(...cpu)}% of one core | loop lag max ${Math.max(...lag)} ms | rss ${samples.at(-1)?.rssMb} MB`);
console.log(`bot process: cpu ${(process.cpuUsage().user / 1000 / (SECONDS * 1000) * 100).toFixed(0)}% of one core over the run`);
console.log(`bots stuck (no ack for 5 s at the end): ${[...lastAckAt.values()].filter((t) => Date.now() - t > 5000).length} of ${lastAckAt.size} | client decode errors ("refId" not found): ${decodeErrs}`);
console.log(`bots: ack latency p50 ${pct(ackLat, 0.5)} p95 ${pct(ackLat, 0.95)} p99 ${pct(ackLat, 0.99)} ms (${ackLat.length} acks) | hand-offs ${handoffs} | kicks ${kicks} | join failures ${joinFails}`);
console.log("room     clients  monsters ghosts  tick p50  tick p95  tick max (ms, means over the window)");
for (const [k, e] of [...perRoom.entries()].sort((a, b) => mean(b[1].clients) - mean(a[1].clients)))
  console.log(`${k.padEnd(8)} ${mean(e.clients).toFixed(0).padStart(7)}  ${mean(e.monsters).toFixed(0).padStart(8)} ${mean(e.ghosts).toFixed(0).padStart(6)}  ${mean(e.p50).toFixed(2).padStart(8)}  ${mean(e.p95).toFixed(2).padStart(8)}  ${Math.max(...e.max).toFixed(1).padStart(8)}`);
process.exit(0);
