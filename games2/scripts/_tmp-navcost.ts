// TEMP measurement harness (navcost dimension). Not for commit.
import { readFileSync } from "node:fs";
import { buildTerrainGrid, findPath, CELL_WU, parseWorld, findSpawn } from "@nangijala/shared";

const raw = JSON.parse(readFileSync(new URL("../../maps2/worlds3/the_game/world.json", import.meta.url), "utf8"));
const world = parseWorld(raw)!;
const grid = buildTerrainGrid(world.width, world.height, world.rows, world.props);
const spawn = findSpawn(grid);
console.log(`the_game ${world.width}x${world.height} = ${world.width * world.height} cells; spawn cell ${(spawn.x / CELL_WU).toFixed(1)},${(spawn.y / CELL_WU).toFixed(1)}`);

const POS: [string, number, number][] = [
  ["526,334", 526, 334],
  ["510,309", 510, 309],
  ["589,332", 589, 332],
  ["565,365", 565, 365],
  ["SPAWN 441,364", 441, 364],
];
const LADDER = [50, 100, 200, 300, 500, 800, 1200, 2000, 4000];

function q(a: number[], f: number) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))]; }
const f2 = (n: number) => n.toFixed(2);

// ---- 1. cost + endpoint vs maxNodes, drag-shaped targets (2-10 cells) -------
console.log("\n== drag-shaped targets (2-10 cells out), 400 samples per position ==");
for (const [name, px, py] of POS) {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const fx = px * CELL_WU, fy = py * CELL_WU;
  const times: Record<number, number[]> = {};
  const drift: Record<number, number[]> = {};   // |endN - end4000| in cells
  const changed: Record<number, number> = {};
  const minSafe: number[] = [];
  let arrived4000 = 0;
  for (const n of LADDER) { times[n] = []; drift[n] = []; changed[n] = 0; }
  for (let i = 0; i < 400; i++) {
    const ang = rnd() * Math.PI * 2;
    const d = (2 + rnd() * 8) * CELL_WU;
    const tx = fx + Math.cos(ang) * d, ty = fy + Math.sin(ang) * d;
    const ends: Record<number, { x: number; y: number } | null> = {};
    for (const n of LADDER) {
      const t0 = performance.now();
      const p = findPath(grid, fx, fy, tx, ty, { maxNodes: n });
      times[n].push(performance.now() - t0);
      ends[n] = p && p.length ? p[p.length - 1] : null;
    }
    const ref = ends[4000];
    if (ref && Math.hypot(ref.x - tx, ref.y - ty) < CELL_WU * 0.5) arrived4000++;
    let safe = 4000;
    for (const n of LADDER) {
      const e = ends[n];
      const dd = !ref || !e ? (ref === e ? 0 : Infinity) : Math.hypot(e.x - ref.x, e.y - ref.y) / CELL_WU;
      drift[n].push(Number.isFinite(dd) ? dd : 999);
      if (dd > 0.5) changed[n]++;
    }
    for (const n of LADDER) {  // smallest budget that reproduces the 4000 endpoint
      const e = ends[n];
      const dd = !ref || !e ? (ref === e ? 0 : Infinity) : Math.hypot(e.x - ref.x, e.y - ref.y) / CELL_WU;
      if (dd <= 0.5) { safe = n; break; }
    }
    minSafe.push(safe);
  }
  console.log(`\n-- ${name}  (4000-node run reaches the exact target in ${arrived4000}/400)`);
  for (const n of LADDER) {
    console.log(
      `   maxNodes ${String(n).padStart(4)}  p50 ${f2(q(times[n], 0.5))}  p90 ${f2(q(times[n], 0.9))}  p99 ${f2(q(times[n], 0.99))}  max ${f2(q(times[n], 1))} ms` +
      `   endpoint differs from 4000: ${changed[n]}/400   drift p99 ${f2(q(drift[n], 0.99))} cells  max ${f2(q(drift[n], 1))}`,
    );
  }
  console.log(`   smallest budget reproducing the 4000 endpoint: p50 ${q(minSafe, 0.5)}  p90 ${q(minSafe, 0.9)}  p99 ${q(minSafe, 0.99)}  max ${q(minSafe, 1)}`);
}
