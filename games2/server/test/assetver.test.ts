import { test } from "node:test";
import assert from "node:assert/strict";
import { assetHashFor, assetIndexInfo, loadAssetIndex, setAssetIndex, withV } from "../../client/src/assetver";

const H = "0123456789abcdef";

test("withV stamps ?h from the index for /assets URLs and falls back to the build sha otherwise", () => {
  setAssetIndex(null);
  const bare = withV("/assets/monsters/frog/walk.webp");
  assert.ok(!bare.includes("h="), "no index → no hash");
  setAssetIndex({ "monsters/frog/walk.webp": H, "tiles/plates/grass/0.webp": "fedcba9876543210" });
  assert.equal(withV("/assets/monsters/frog/walk.webp"), `/assets/monsters/frog/walk.webp?h=${H}`);
  assert.equal(withV("/assets/monsters/frog/walk.webp?x=1"), `/assets/monsters/frog/walk.webp?x=1&h=${H}`, "joins an existing query");
  assert.equal(assetHashFor("/assets/tiles/plates/grass/0.webp"), "fedcba9876543210");
  assert.equal(assetHashFor("/assets/monsters/frog/idle.webp"), null, "unknown path → no hash");
  assert.equal(assetHashFor("/ui2/icon.webp"), null, "client/public art is not under /assets");
  assert.equal(assetHashFor("https://cdn.jsdelivr.net/gh/x/y@sha/monsters/frog/walk.webp"), null, "a CDN URL is never hashed");
  assert.ok(!withV("/ui2/icon.webp").includes("h="), "unindexed URLs keep the sha fallback (or nothing on a dev build)");
  setAssetIndex({ "monsters/frog/walk.webp": "not-a-hash" });
  assert.equal(assetHashFor("/assets/monsters/frog/walk.webp"), null, "a malformed index value is ignored");
  setAssetIndex(null);
});

test("loadAssetIndex accepts only the schema it knows and never throws", async () => {
  const mk = (status: number, body: unknown) =>
    (async () => ({ ok: status === 200, json: async () => body })) as unknown as typeof fetch;
  setAssetIndex(null);
  assert.equal(await loadAssetIndex(mk(404, null)), false);
  assert.equal(assetIndexInfo().loaded, false);
  assert.equal(await loadAssetIndex(mk(200, { schema: "something-else@9", files: { a: H } })), false, "unknown schema is ignored");
  assert.equal(await loadAssetIndex(mk(200, { schema: "nangijala-asset-index@1", files: { "a.webp": H } })), true);
  assert.equal(assetIndexInfo().files, 1);
  assert.equal(await loadAssetIndex((async () => { throw new Error("offline"); }) as unknown as typeof fetch), false, "a network error leaves the previous state");
  assert.equal(assetIndexInfo().files, 1);
  setAssetIndex(null);
});
