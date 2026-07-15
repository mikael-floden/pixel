// Micro-benchmark: real findPath cost on shipped worlds (drives the client's
// hold-to-move adaptive repath budget). Run:
//   TSX_TSCONFIG_PATH=./server/tsconfig.json npx tsx scripts/bench-findpath.ts
import { readFileSync } from "node:fs";
import { buildTerrainGrid, findPath, CELL_WU, findSpawn, parseWorld } from "@nangijala/shared";

for (const name of ["ring_test", "glow_test", "prop_demo"]) {
  const raw = JSON.parse(readFileSync(new URL(`../../maps2/worlds/${name}/world.json`, import.meta.url), "utf8"));
  const world = parseWorld(raw);
  if (!world) throw new Error(`unparseable world ${name}`);
  const grid = buildTerrainGrid(world.width, world.height, world.rows, world.props);
  const W = world.width * CELL_WU;
  const H = world.height * CELL_WU;
  const spawn = findSpawn(grid);
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const times: number[] = [];
  let nulls = 0;
  for (let i = 0; i < 300; i++) {
    const tx = rnd() * W;
    const ty = rnd() * H;
    const t0 = performance.now();
    const p = findPath(grid, spawn.x, spawn.y, tx, ty);
    times.push(performance.now() - t0);
    if (!p) nulls++;
  }
  times.sort((a, b) => a - b);
  const q = (f: number) => times[Math.floor(f * (times.length - 1))].toFixed(2);
  console.log(`${name} (${world.width}x${world.height}): p50=${q(0.5)}ms p95=${q(0.95)}ms max=${q(1)}ms nulls=${nulls}`);
}
