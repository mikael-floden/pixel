import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MONSTER_BOOT_RADIUS_CELLS,
  monsterBootKinds,
  parseSpawns,
  zoneDistanceCells,
  type SpawnZone,
} from "../../shared/src/monsters";

const zone = (id: string, monster: string, area: number[][]): SpawnZone =>
  ({ id, monster, area: area as [number, number][], elev: [0, 99], num: 1 }) as SpawnZone;
const box = (id: string, monster: string, c0: number, r0: number, c1: number, r1: number) =>
  zone(id, monster, [[c0, r0], [c1, r0], [c1, r1], [c0, r1]]);

test("zoneDistanceCells is Chebyshev to the bbox, 0 inside, and box-shaped for a concave polygon", () => {
  const z = box("a", "m", 10, 10, 20, 20);
  assert.equal(zoneDistanceCells(z, 15, 15), 0);
  assert.equal(zoneDistanceCells(z, 10, 20), 0, "on the edge counts as inside");
  assert.equal(zoneDistanceCells(z, 25, 15), 5);
  assert.equal(zoneDistanceCells(z, 15, 3), 7);
  assert.equal(zoneDistanceCells(z, 30, 0), 10, "max of the two axes, not their sum");
  // An L whose notch is empty: the notch is still distance 0 — the bbox rule
  // only ever errs toward NEAR, which is the safe direction for art.
  const l = zone("l", "m", [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]);
  assert.equal(zoneDistanceCells(l, 8, 8), 0);
});

test("monsterBootKinds: near kinds only, union over centres, everything when no centre is known", () => {
  const zones = [
    box("home", "frog", 0, 0, 4, 4),
    box("near", "cat", 30, 0, 40, 4), // 26 cells from (4,4)... measured from the box, 26 from col 4
    box("far", "bear", 100, 100, 110, 110),
    box("far2", "bear", 200, 200, 210, 210),
    box("byLast", "wolf", 150, 150, 152, 152),
  ];
  const spawn: [number, number] = [2, 2];
  assert.deepEqual([...monsterBootKinds(zones, [spawn], 32)].sort(), ["cat", "frog"]);
  assert.deepEqual([...monsterBootKinds(zones, [spawn], 27)].sort(), ["frog"], "cat's box starts 28 cells out");
  assert.deepEqual([...monsterBootKinds(zones, [spawn], 28)].sort(), ["cat", "frog"]);
  assert.deepEqual([...monsterBootKinds(zones, [spawn, [149, 149]], 32)].sort(), ["cat", "frog", "wolf"], "the last known spot adds its own neighbourhood");
  assert.deepEqual([...monsterBootKinds(zones, [], 32)].sort(), ["bear", "cat", "frog", "wolf"], "no centre known → every kind, the pre-split behaviour");
  assert.deepEqual([...monsterBootKinds(zones, [spawn], 0)], ["frog"], "radius 0 keeps only zones containing the centre");
  assert.equal(monsterBootKinds([], [spawn]).size, 0);
});

test("on every spawns.json on disk the split is a partition that the definition explains", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  let worlds = 0;
  for (const [tree, name] of [["worlds3", "the_game"], ["worlds", "the_island2"]] as const) {
    const dir = join(here, "..", "..", "..", "maps2", tree, name);
    if (!existsSync(join(dir, "spawns.json")) || !existsSync(join(dir, "world.json"))) continue;
    const zones = parseSpawns(JSON.parse(readFileSync(join(dir, "spawns.json"), "utf8")));
    const spawn = JSON.parse(readFileSync(join(dir, "world.json"), "utf8")).spawn as [number, number];
    const all = new Set(zones.map((z) => z.monster));
    const boot = monsterBootKinds(zones, [spawn]);
    for (const k of boot) assert.ok(all.has(k));
    for (const k of all) {
      const near = zones.some((z) => z.monster === k && zoneDistanceCells(z, spawn[0], spawn[1]) <= MONSTER_BOOT_RADIUS_CELLS);
      assert.equal(boot.has(k), near, `${name}: ${k}`);
    }
    // The split has to be worth having: strictly fewer than all, and the
    // spawn's own neighbourhood non-empty (a spawn with no monsters nearby
    // would be a maps2 regression worth a red test, not a silent pass).
    assert.ok(boot.size > 0 && boot.size < all.size, `${name}: boot ${boot.size} of ${all.size}`);
    console.log(`  monsterboot: ${name} boots ${boot.size} of ${all.size} kinds within ${MONSTER_BOOT_RADIUS_CELLS} cells of ${spawn}`);
    worlds++;
  }
  if (!worlds) console.log("  monsterboot: no world on disk (sparse checkout) — synthetic cases only");
});
