import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, "..", "src");
const CLIENT_SRC = join(HERE, "..", "..", "client", "src");

/* THE CLIENT MAY ONLY ASK FOR URLS THE SERVER ANSWERS.
 * The scenery bbox table was fetched as `/assets/games2/config/...` for its
 * whole life and 404'd every time, because `games2` is not an ASSET_DOMAIN and
 * never was — so the client stamped no scenery collision at all while the
 * server stamped 3,233 cells, and a body walked into a tree the server held it
 * out of. Nothing failed loudly: the fetch was `.catch(() => {})` and the
 * stamp bailed on a null document, which is the correct SOFT failure for a
 * missing file and exactly why it hid for so long. This asserts the routing
 * fact rather than the symptom: every literal asset path the client fetches
 * names a domain the static mounts actually serve. */
test("every /assets path the client fetches names a served domain", () => {
  const index = readFileSync(join(SERVER_SRC, "index.ts"), "utf8");
  const domains = /const ASSET_DOMAINS = \[([\s\S]*?)\]/.exec(index);
  assert.ok(domains, "ASSET_DOMAINS not found — did the static mounts move?");
  const served = new Set(
    [...domains[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).concat("composer"),
  );

  const scene = readFileSync(join(CLIENT_SRC, "scenes", "WorldScene.ts"), "utf8");
  const bad: string[] = [];
  for (const m of scene.matchAll(/assetPath\(\s*"([^"]+)"/g)) {
    const domain = m[1].replace(/^\/+/, "").split("/")[0];
    if (!served.has(domain)) bad.push(m[1]);
  }
  assert.deepEqual(bad, [], `fetched from /assets/ but not served: ${bad.join(", ")}`);
});

/* The collision documents reach the client from the AUTHORITY, not from an
 * asset path: the bbox table is not published art, and the hitbox doc the
 * server stamps with is the LIVE copy off GitHub, which the image's baked
 * copy stops matching the moment a hitbox is tuned in the wiki. */
test("the collision endpoint answers with the server's own two documents", () => {
  const index = readFileSync(join(SERVER_SRC, "index.ts"), "utf8");
  assert.match(index, /app\.get\("\/api\/scenery-collision"/);
  assert.match(index, /bbox: sceneryBbox\(\)/);
  assert.match(index, /hitbox: sceneryHitboxOverrides\(\)/);
  // A cached copy must be revalidated: the live half changes without a deploy.
  assert.match(index, /"Cache-Control", "no-cache"[\s\S]{0,120}sceneryBbox/);

  const scene = readFileSync(join(CLIENT_SRC, "scenes", "WorldScene.ts"), "utf8");
  assert.match(scene, /fetch\("\/api\/scenery-collision"\)/);
  // and never through a staging CDN, which would pin trees per TAB.
  assert.doesNotMatch(scene, /docUrl\([^)]*scenery_hitbox/);
});
