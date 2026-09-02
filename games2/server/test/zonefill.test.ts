import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpawns, pointInZone, zonePolygonCells, type SpawnZone } from "../../shared/src/monsters";

/* THE REFERENCE is the rule the spec states and the code shipped with: every
 * cell centre in the bbox, tested one by one with the even-odd point test. The
 * scanline in zonePolygonCells exists only to be indistinguishable from this. */
function referenceCells(zone: SpawnZone, wCells: number, hCells: number) {
  let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
  for (const [x, y] of zone.area) {
    minC = Math.min(minC, x); maxC = Math.max(maxC, x);
    minR = Math.min(minR, y); maxR = Math.max(maxR, y);
  }
  const out: Array<{ c: number; r: number }> = [];
  const c0 = Math.max(0, Math.floor(minC)), c1 = Math.min(wCells - 1, Math.ceil(maxC) - 1);
  const r0 = Math.max(0, Math.floor(minR)), r1 = Math.min(hCells - 1, Math.ceil(maxR) - 1);
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) if (pointInZone(zone, c + 0.5, r + 0.5)) out.push({ c, r });
  return out;
}
const zone = (area: number[][], id = "z"): SpawnZone =>
  ({ id, monster: "m", area: area as [number, number][], elev: [0, 99], num: 1 }) as SpawnZone;

test("scanline zone fill is byte-identical to the per-cell even-odd rule (synthetic shapes)", () => {
  const shapes: number[][][] = [
    [[0, 0], [4, 0], [4, 4], [0, 4]], // square on tile corners
    [[0.5, 0.5], [3.5, 0.5], [3.5, 3.5], [0.5, 3.5]], // vertices ON cell centres — the half-open rule
    [[0, 0], [6, 0], [6, 6], [3, 6], [3, 3], [0, 3]], // L: concave
    [[0, 0], [8, 0], [8, 8], [0, 8], [0, 6], [6, 6], [6, 2], [0, 2]], // C: two spans per row
    [[2, 0], [4, 4], [0, 4]], // triangle: sloped edges, fractional crossings
    [[0, 0], [5, 5], [5, 0], [0, 5]], // bow-tie: self-intersecting, even-odd
    [[-3, -3], [20, -3], [20, 20], [-3, 20]], // larger than the world: clipped
    [[1, 1], [1, 1], [1, 1]], // degenerate, zero area
    [[0, 2], [10, 2], [10, 2.5], [0, 2.5]], // thin band ending exactly on a centre row
    [[0, 0], [3, 0], [3, 1], [1, 1], [1, 2], [3, 2], [3, 3], [0, 3]], // notch: an edge lying on y = r
    [[0.25, 0.25], [7.75, 0.25], [7.75, 7.75], [0.25, 7.75], [4, 4]], // spike back into the middle
  ];
  for (const s of shapes)
    for (const [w, h] of [[10, 10], [3, 3], [16, 7], [1, 1]])
      assert.deepEqual(zonePolygonCells(zone(s), w, h), referenceCells(zone(s), w, h), `${JSON.stringify(s)} in ${w}x${h}`);
});

test("300 seeded random polygons agree with the reference, cell for cell and in order", () => {
  let seed = 0x5eed; // deterministic: a failure here is a failure every run
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  let cells = 0;
  for (let n = 0; n < 300; n++) {
    const k = 3 + Math.floor(rnd() * 9);
    const area = Array.from({ length: k }, () => [Math.round(rnd() * 160) / 4 - 4, Math.round(rnd() * 160) / 4 - 4]);
    const z = zone(area);
    const got = zonePolygonCells(z, 32, 32);
    assert.deepEqual(got, referenceCells(z, 32, 32), JSON.stringify(area));
    cells += got.length;
  }
  assert.ok(cells > 1000, `the random set must exercise real interiors (got ${cells} cells)`);
});

test("every spawns.json on disk fills identically to the reference", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  let zones = 0, cells = 0;
  for (const root of ["worlds", "worlds3"].map((d) => join(here, "..", "..", "..", "maps2", d))) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      const p = join(root, d, "spawns.json");
      if (!existsSync(p)) continue;
      for (const z of parseSpawns(JSON.parse(readFileSync(p, "utf8")))) {
        const got = zonePolygonCells(z, 1024, 1024);
        assert.deepEqual(got, referenceCells(z, 1024, 1024), `${d}/${z.id}`);
        zones++; cells += got.length;
      }
    }
  }
  // The deploy's sparse checkout carries maps2/worlds only; the_game lives in
  // worlds3 — so this pins what is on disk and says so, never fails vacuously.
  console.log(`  zonefill: ${zones} real zones, ${cells} cells, identical`);
});
