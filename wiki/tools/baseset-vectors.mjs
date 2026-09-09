/* Regenerates the TEST_VECTORS table in wiki/lib/basesets.mjs and verifies the
 * one in the file matches. A port of the pick rule is proven against that table
 * rather than against the source, so the table has to be measured, never typed. */
import { fnv1a, pickWeighted, TEST_VECTORS } from "../lib/basesets.mjs";

const HASH_IN = ["", "a", "grass", "bts1|set|grass|r0", "bts1|tile|1|0|0"];
const PICK_IN = [
  [[1, 1], 0.0], [[1, 1], 0.4999], [[1, 1], 0.5], [[0, 5], 0.0], [[0, 5], 0.999],
  [[3, 1], 0.74], [[3, 1], 0.76], [[0, 0], 0.5], [[], 0.5],
];

const measured = {
  fnv1a: HASH_IN.map((s) => [s, fnv1a(s)]),
  pickWeighted: PICK_IN.map(([w, u]) => [w, u, pickWeighted(w, u)]),
};

if (process.argv.includes("--print")) {
  console.log(JSON.stringify(measured, null, 2));
} else {
  const a = JSON.stringify(measured), b = JSON.stringify(TEST_VECTORS);
  if (a !== b) {
    console.error("TEST VECTORS DO NOT MATCH THE IMPLEMENTATION.\nmeasured: " + a + "\nin file:  " + b);
    process.exit(1);
  }
  console.log(`vectors ok (${measured.fnv1a.length} hashes, ${measured.pickWeighted.length} picks)`);
}
