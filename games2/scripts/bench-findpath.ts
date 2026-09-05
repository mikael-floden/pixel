// Micro-benchmark: real findPath cost on shipped worlds (drives the client's
// hold-to-move adaptive repath budget). Run:
//   TSX_TSCONFIG_PATH=./server/tsconfig.json npx tsx scripts/bench-findpath.ts
//
// THE WORLD PEOPLE ACTUALLY PLAY IS IN THE LIST, and for a long time it was not.
// This benchmark is what calibrated the client's repath budget, and it measured
// ring_test / glow_test / prop_demo — 6,308 to 25,600 cells — while the shipped
// default map, `the_game`, is 512x512 = 262,144 cells and lives in the OTHER
// world tree (`maps2/worlds3`). A* is bounded by `maxNodes` (4,000), so cost
// does not scale with the map until the search EXHAUSTS that budget, and only a
// map big enough to have unreachable-looking targets ever does. Measured on
// the_game: from ordinary standing positions a hold-drag replan is p90 0.23-1.09
// ms, but from the SPAWN it is p99 55.19 ms with 38 of 400 samples over 5 ms,
// and a target the search cannot reach costs 42-66 ms here — roughly 160-280 ms
// on the maintainer's phone, on the input path, with the backoff then pinned at
// its 400 ms cap so it repeats at a fixed duty cycle while the finger is down.
// A benchmark that cannot see that cannot calibrate against it.
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { buildTerrainGrid, findPath, CELL_WU, findSpawn, parseWorld } from "@nangijala/shared";

// the_game FIRST: it is the map this budget exists for, and the tiles2 worlds
// under it are on a countdown (maintainer 2026-09-05 — see games2/CLAUDE.md).
// They stay measured only so a regression in the branch that still serves them
// is visible; they must never be what a constant is tuned against.
const WORLDS: [string, string][] = [
  ["the_game", "worlds3"], // the shipped default map — the one that matters
  ["ring_test", "worlds"],
  ["glow_test", "worlds"],
  ["prop_demo", "worlds"],
];

for (const [name, tree] of WORLDS) {
  const url = new URL(`../../maps2/${tree}/${name}/world.json`, import.meta.url);
  if (!existsSync(url)) {
    // A sparse checkout may hold only one tree; that is not a failure.
    console.log(`${name}: not in this checkout (${tree})`);
    continue;
  }
  const raw = JSON.parse(readFileSync(url, "utf8"));
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
