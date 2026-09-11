// HOLD THE STICK AT A SPOT OF THE REAL WORLD, tick by tick, no browser:
//   cd games2/server && COL=276.6 ROW=178.9 AX=0 AY=1 npx tsx ../scripts/holdtrace.ts
// Prints the levels around the spot ('#' = nav-blocked, '@' = the spot) and
// then every change of walkHeading's answer — heading, live trip, hold — with
// the body's position, so a "runs back and forth" report can be read as the
// rule that produced each heading. The escalation (rule 0) shows as a trip
// appearing after STUCK_ESCALATE_MS with the hold cleared.
import { loadWorldGrid } from "../server/src/rooms/WorldRoom.js";
import {
  walkHeading, stepMovement, makeBlockedElev, makeSideBlocked, unstickFromSolids, levelAtWorld,
  CELL_WU, WALK_CLIMB, type SlideMemo, type AutopilotTrip,
} from "@nangijala/shared";
const col = Number(process.env.COL ?? 276.6), row = Number(process.env.ROW ?? 178.9);
const ax = Number(process.env.AX ?? 0), ay = Number(process.env.AY ?? 1);
const { terrain: g, worldW, worldH } = await loadWorldGrid("the_game");
if (!g) throw new Error("no terrain");
// map around the spot: level (hex) with '#' for blocked
const c0 = Math.floor(col), r0 = Math.floor(row);
for (let r = r0 - 8; r <= r0 + 10; r++) {
  let line = `${String(r).padStart(4)} `;
  for (let c = c0 - 12; c <= c0 + 12; c++) {
    const i = r * g.width + c;
    const me = c === c0 && r === r0;
    line += me ? "@" : g.blocked[i] ? "#" : g.level[i].toString(16);
  }
  console.log(line);
}
console.log("     " + Array.from({ length: 25 }, (_, k) => ((c0 - 12 + k) % 10).toString()).join(""));
let x = col * CELL_WU, y = row * CELL_WU;
let elev = levelAtWorld(g, x, y);
const walk = { maxClimb: WALK_CLIMB, canSwim: true };
const hold: SlideMemo = { ax: 0, ay: 0 };
let trip: AutopilotTrip | null = null;
let t = 0, last = "", frozen = 0;
const x0 = x, y0 = y;
for (let i = 0; i < 400; i++) {
  t += 33;
  const r = walkHeading(g, x, y, ax, ay, hold, { nowMs: t, trip, fromElev: elev, worldW, worldH });
  trip = r.trip;
  const u = unstickFromSolids(g, x, y, 80 * 0.033);
  x = u.x; y = u.y;
  const ge = () => elev;
  const m = stepMovement(x, y, r.ax, r.ay, false, 0.033, makeBlockedElev(g, walk, ge), 1, true, worldW, worldH, makeSideBlocked(g, walk, ge));
  const moved = Math.hypot(m.x - x, m.y - y);
  x = m.x; y = m.y;
  elev = levelAtWorld(g, x, y);
  frozen = moved < 0.05 ? frozen + 1 : 0;
  const sig = `${r.ax},${r.ay} trip=${trip ? trip.path.length : "-"} hold=${hold.ax},${hold.ay}`;
  if (sig !== last || i % 50 === 0) console.log(`t${i} (${(x / CELL_WU).toFixed(2)},${(y / CELL_WU).toFixed(2)}) L${elev} ${sig} moved=${moved.toFixed(2)} frozen=${frozen}`);
  last = sig;
}
console.log(`end (${(x / CELL_WU).toFixed(2)},${(y / CELL_WU).toFixed(2)}) net ${((x - x0) / CELL_WU).toFixed(2)},${((y - y0) / CELL_WU).toFixed(2)} cells`);
