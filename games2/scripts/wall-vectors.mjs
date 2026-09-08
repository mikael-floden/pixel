/** Regenerate WALL_TEST_VECTORS in client/src/wallregion.ts.
 *  Print, eyeball, paste. A port (render3.py, the wiki) that reproduces every
 *  line agrees with the game about which stone a cell wears. */
import { hash3, vnoise3, fbm3, wallField, wallPalette, pickWallIndex } from "../client/src/wallregion.ts";

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const keysOf = (n) => Array.from({ length: n }, (_, i) => `k${i}`);
const out = { hash3: [], vnoise3: [], fbm3: [], field: [], palette: [], pick: [] };
for (const [i, j, k, s] of [[0,0,0,1],[1,0,0,1],[0,1,0,1],[0,0,1,1],[-1,-1,-1,1],[123,456,7,0x5741_4c31],[4294967295,0,0,7]])
  out.hash3.push([i, j, k, s, hash3(i, j, k, s)]);
for (const [x, y, z, s] of [[0,0,0,1],[0.5,0.5,0.5,1],[1.25,-2.75,3.5,1],[10.1,20.2,30.3,0x5741_4c33]])
  out.vnoise3.push([x, y, z, s, r6(vnoise3(x, y, z, s))]);
for (const [x, y, z, s] of [[0,0,0,1],[0.5,0.5,0.5,1],[1.25,-2.75,3.5,0x5741_4c32]])
  out.fbm3.push([x, y, z, s, r6(fbm3(x, y, z, s))]);
for (const [x, y, z] of [[0,0,0],[1,0,0],[0,0,1],[37,214,5],[120,15,11],[393,393,40]])
  out.field.push([x, y, z, wallField(x, y, z).region]);
/* MUST MATCH the SETS fixture in server/test/wallregion.test.ts — the vectors
 * are generated here and checked there, so a fixture that drifts fails the
 * "TEST_VECTORS reproduce" test rather than passing quietly. Five members,
 * matching WALL_PALETTE_N. */
const SETS = [
  { cost: 0.9, tiles: ["k3", "k7", "k11", "k13", "k17"] },
  { cost: 1.8, tiles: ["k2", "k5", "k9", "k12", "k15"] },
  { cost: 9, tiles: ["k0", "k1", "k4", "k6", "k8"] },
];
for (const [pool, region, n] of [["grey_stone__over__grey_stone","0,0,0",74],["grey_stone__over__grey_stone","1,-2,0",74],["a__over__b","0,0,0",2],["a__over__b","0,0,0",1]])
  out.palette.push([pool, region, n, wallPalette(pool, region, keysOf(n), SETS)]);
for (const [pool, n, x, y, z] of [["grey_stone__over__grey_stone",74,0,0,0],["grey_stone__over__grey_stone",74,37,214,5],["grey_stone__over__grey_stone",74,38,214,5],["grey_stone__over__grey_stone",74,37,214,6],["one__over__one",1,5,5,5],["none__over__none",0,1,2,3]])
  out.pick.push([pool, n, x, y, z, pickWallIndex(pool, keysOf(n), x, y, z, undefined, SETS)]);
const j = (a) => "    " + JSON.stringify(a);
console.log("  hash3: [\n" + out.hash3.map(j).join(",\n") + ",\n  ],");
console.log("  vnoise3: [\n" + out.vnoise3.map(j).join(",\n") + ",\n  ],");
console.log("  fbm3: [\n" + out.fbm3.map(j).join(",\n") + ",\n  ],");
console.log("  field: [\n" + out.field.map(j).join(",\n") + ",\n  ],");
console.log("  palette: [\n" + out.palette.map(j).join(",\n") + ",\n  ],");
console.log("  pick: [\n" + out.pick.map(j).join(",\n") + ",\n  ],");
