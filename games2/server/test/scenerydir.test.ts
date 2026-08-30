import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseWorld } from "@nangijala/shared";
import { facedSprite, southSprite } from "../../client/src/scenery3";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/* A PLACEMENT'S FACING SURVIVES THE PARSER. It used to be dropped on the stated
 * premise that "world placements name none", which the data falsified: 70 of
 * the_game's 1,421 placements carry `dir` (42 south-west, 28 south-east) and
 * every one drew facing south (maintainer 2026-08-30: "This is wrong! I don't
 * want it like that!"). */
test("the parser keeps the facing a placement asks for, and only a real one", () => {
  const flat = (v: number) => [[v, v, v, v], [v, v, v, v], [v, v, v, v], [v, v, v, v]];
  const w = parseWorld({
    schema: "pixel-maps3/world@1",
    size: [4, 4],
    grounds: ["grass"],
    ground: flat(0),
    level: flat(0),
    scenery: [
      { piece: "a/one", x: 1.5, y: 1.5, dir: "south-west" },
      { piece: "a/two", x: 2.5, y: 1.5, dir: "south-east" },
      { piece: "a/three", x: 1.5, y: 2.5, dir: "north" }, // not a published facing
      { piece: "a/four", x: 2.5, y: 2.5 },
    ],
  } as never);
  assert.ok(w, "world parsed");
  const by = Object.fromEntries((w!.scenery ?? []).map((s) => [s.piece, s.dir]));
  assert.equal(by["a/one"], "south-west");
  assert.equal(by["a/two"], "south-east");
  assert.equal(by["a/three"], undefined, "a facing the domain does not publish is not carried");
  assert.equal(by["a/four"], undefined);
});

/* The resolution order, including the two fallbacks that must not regress: a
 * piece that does not publish the asked-for rotation still DRAWS (south), and a
 * state with no `rotations` map at all uses its own sprite. */
test("facedSprite takes the asked-for rotation, then south, then the state's own still", () => {
  const full = {
    key: "NOT_LIT_1",
    sprite: "p/still.webp",
    rotations: { south: "p/s.webp", "south-east": "p/se.webp", "south-west": "p/sw.webp" },
    anims: {},
  } as never;
  assert.equal(facedSprite(full, "south-west"), "p/sw.webp");
  assert.equal(facedSprite(full, "south-east"), "p/se.webp");
  assert.equal(facedSprite(full, undefined), "p/s.webp");
  assert.equal(southSprite(full), "p/s.webp", "the south helper still means south");

  // publishes south only: a faced placement must still draw, not 404
  const southOnly = { key: "NOT_LIT_1", sprite: "p/still.webp", rotations: { south: "p/s.webp" }, anims: {} } as never;
  assert.equal(facedSprite(southOnly, "south-west"), "p/s.webp");

  // the 14 mid-generation states with no rotations at all
  const bare = { key: "NOT_LIT_1", sprite: "p/still.webp", rotations: {}, anims: {} } as never;
  assert.equal(facedSprite(bare, "south-east"), "p/still.webp");
});

/* And the art the map asks for actually exists — if scenery ever drops a
 * rotation a world names, this says so instead of silently drawing south. */
test("every facing the_game asks for is published by the piece it names", () => {
  /* THE ART DOMAINS ARE NOT ALWAYS CHECKED OUT. CI's deploy gate uses a sparse
   * checkout — "only what typecheck + npm test actually read" — so maps2/ and
   * scenery/ are absent there, and a test that reads them must SKIP rather than
   * fail, the way worldserve.test.ts does. Written without that guard, this
   * test went red on CI, and the deploy's "Wait for the test gate" step blocked
   * every agent's release for hours while it looked green on my machine. */
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(REPO, "maps2/worlds3/the_game/world.json"), "utf8"));
  } catch {
    return test.skip("maps2/worlds3 not checked out");
  }
  const w = parseWorld(doc as never);
  const faced = (w?.scenery ?? []).filter((s) => s.dir);
  if (!faced.length) return test.skip("no faced placements — world not checked out or none named");
  const want = new Map<string, string>();
  for (const s of faced) want.set(s.piece, s.dir!);
  const missing: string[] = [];
  for (const [piece, dir] of want) {
    let man: { rotations?: Record<string, string>; states?: Record<string, { rotations?: Record<string, string> }> };
    try {
      man = JSON.parse(readFileSync(join(REPO, "scenery", piece, "scenery.json"), "utf8"));
    } catch {
      // scenery/ absent (sparse checkout): nothing to check, not a failure.
      return test.skip("scenery/ not checked out");
    }
    const rots = new Set(Object.keys(man.rotations ?? {}));
    for (const st of Object.values(man.states ?? {})) for (const k of Object.keys(st?.rotations ?? {})) rots.add(k);
    if (!rots.has(dir)) missing.push(`${piece} wants ${dir}, publishes [${[...rots].join(", ") || "none"}]`);
  }
  assert.deepEqual(missing, [], "a world names a facing its piece does not publish");
});
