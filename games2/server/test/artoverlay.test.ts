// THE ART OVERLAY — the half of the art lane that decides what the server will
// and will not serve. cachepolicy.test.ts owns the one-year grant;
// verify-artlane.mjs proves the whole channel against a real process; this owns
// the ADMISSION, in seconds, because every case below is a generation that must
// be refused and a refusal is not something to discover in production.
//
// The shape it all rests on: `files` is content-hashed, so LAW 1 can make a
// name mean one thing forever. The OVERLAY is not — `scenery/oak/south.webp` IS
// the name the game asks for, and republishing it with new pixels is the entire
// point — so it resolves against the CURRENT generation only and must never
// reach the append-only `names` map.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BundleStore,
  localBackend,
  hashBytes,
  safeOverlayPath,
  PUBLISHABLE_ROOT,
  ART_LANE_DOMAINS,
} from "../src/bundlestore";

const DOMAINS = ART_LANE_DOMAINS;
const blob = (root: string, body: string) => {
  const hash = hashBytes(Buffer.from(body));
  mkdirSync(join(root, "blob"), { recursive: true });
  writeFileSync(join(root, "blob", hash), body);
  return hash;
};
/** A generation written the way publish-bundle.mjs writes one. */
function writeGen(
  root: string,
  id: string,
  opts: {
    files?: Record<string, string>;
    art?: Record<string, string>;
    root?: Record<string, string>;
    fallthrough?: Record<string, string>;
    rawArt?: Record<string, string>; // name -> hash, for a manifest that LIES
  },
) {
  const man: Record<string, unknown> = { git_sha: "a".repeat(40), commit_ts: 0 };
  const map = (o?: Record<string, string>) =>
    o ? Object.fromEntries(Object.entries(o).map(([n, body]) => [n, blob(root, body)])) : undefined;
  man.files = map(opts.files ?? { "index.html": `<html>${id}</html>` });
  if (opts.art) man.art = map(opts.art);
  if (opts.rawArt) man.art = opts.rawArt;
  if (opts.root) man.root = map(opts.root);
  if (opts.fallthrough) man.fallthrough = opts.fallthrough;
  mkdirSync(join(root, "gen", id), { recursive: true });
  writeFileSync(join(root, "gen", id, "manifest.json"), JSON.stringify(man));
  return man;
}
const point = (root: string, p: object) => writeFileSync(join(root, "pointer.json"), JSON.stringify(p));
const fresh = () => mkdtempSync(join(tmpdir(), "artov-"));
const store = (root: string, verify?: (ft: Record<string, string>, pub: ReadonlySet<string>) => string[]) =>
  new BundleStore(localBackend(root), verify, DOMAINS);

test("an art overlay is adopted, served by its ASSETS_ROOT-relative name, and typed by that name", async () => {
  const root = fresh();
  writeGen(root, "g1", { art: { "scenery/oak/south.webp": "NEW OAK", "sounds/foley/step.ogg": "NEW STEP" } });
  point(root, { seq: 1, current: "g1", retained: [] });
  const s = store(root);
  await s.refresh();
  assert.equal(s.current?.id, "g1");
  assert.equal(s.artFor("scenery/oak/south.webp")?.bytes.toString(), "NEW OAK");
  // The CONTENT-TYPE COMES FROM THE NAME, not from the blob: two files with
  // identical bytes share one blob, so a type cached on the blob would be
  // whichever name loaded first — a 28-byte fully transparent .webp (a valid
  // file, normal at the end of a fade) and an empty .json trading types.
  assert.equal(s.artFor("scenery/oak/south.webp")?.type, "image/webp");
  assert.equal(s.artFor("sounds/foley/step.ogg")?.type, "audio/ogg");
  assert.equal(s.artFor("scenery/oak/never.webp"), null, "a miss means the image's file is the right answer");
  assert.deepEqual([...s.artHashes().keys()].sort(), ["scenery/oak/south.webp", "sounds/foley/step.ogg"]);
  rmSync(root, { recursive: true, force: true });
});

test("AN ART NAME NEVER ENTERS THE APPEND-ONLY MAP — or the second art publish would refuse itself forever", async () => {
  const root = fresh();
  writeGen(root, "g1", { art: { "tiles/plates/grass.webp": "GRASS v1" } });
  point(root, { seq: 1, current: "g1", retained: [] });
  const s = store(root);
  await s.refresh();
  assert.equal(s.fileFor("tiles/plates/grass.webp"), null, "an art name is not resolvable by name (it is not content-hashed)");
  // THE WHOLE POINT OF THE LANE: the same name, different bytes, accepted.
  writeGen(root, "g2", { art: { "tiles/plates/grass.webp": "GRASS v2 — repainted" } });
  point(root, { seq: 2, current: "g2", retained: ["g1"] });
  await s.refresh();
  assert.equal(s.current?.id, "g2", "a generation that REDEFINES an art name is adopted, not refused");
  assert.equal(s.artFor("tiles/plates/grass.webp")?.bytes.toString(), "GRASS v2 — repainted");
  rmSync(root, { recursive: true, force: true });
});

test("A ROOT NAME MAY BE REDEFINED TOO — shipset.json's timestamp changes on EVERY run", async () => {
  // `shipset.json` carries `generatedAt: new Date().toISOString()`, so its
  // bytes differ unconditionally between two art generations. If `root` shared
  // the `files` machinery and landed in the append-only `names` map, the FIRST
  // art push would set names["shipset.json"]=hA and the SECOND would be refused
  // at the redefinition check — permanently, while CI reported success and the
  // maintainer saw green pokes and no art change.
  const root = fresh();
  writeGen(root, "g1", { root: { "shipset.json": '{"generatedAt":"1"}' } });
  point(root, { seq: 1, current: "g1", retained: [] });
  const s = store(root);
  await s.refresh();
  assert.equal(s.rootFor("shipset.json")?.bytes.toString(), '{"generatedAt":"1"}');
  writeGen(root, "g2", { root: { "shipset.json": '{"generatedAt":"2"}' } });
  point(root, { seq: 2, current: "g2", retained: ["g1"] });
  await s.refresh();
  assert.equal(s.current?.id, "g2", "a generation that redefines a root name is adopted, not refused");
  assert.equal(s.rootFor("shipset.json")?.bytes.toString(), '{"generatedAt":"2"}');
  assert.equal(s.fileFor("shipset.json"), null, "and it never became a resolvable content-hashed name");
  rmSync(root, { recursive: true, force: true });
});

test("a generation whose OVERLAY bytes were evicted is RE-MATERIALISED, never half-served", async () => {
  // What a ROLLBACK does. `gens` records the names; overlay BYTES are kept for
  // the current generation only, so pointing back at a generation still in the
  // window means pointing at one whose art is gone. A bare `gens.has(id)` check
  // skipped the load, flipped, and then resolved that generation's art to
  // hashes nobody held — its client against the IMAGE's art, with an index
  // naming bytes that are not there.
  const root = fresh();
  writeGen(root, "A", { art: { "tiles/a.webp": "A's own pixels" } });
  point(root, { seq: 1, current: "A", retained: [] });
  const s = store(root);
  await s.refresh();
  assert.equal(s.artFor("tiles/a.webp")?.bytes.toString(), "A's own pixels");
  writeGen(root, "B", {}); // no art: A's overlay bytes are evicted
  point(root, { seq: 2, current: "B", retained: ["A"] });
  await s.refresh();
  assert.equal(s.overlay.art, 0, "A's art bytes are gone while B serves");
  // The rollback.
  point(root, { seq: 3, current: "A", retained: [] });
  await s.refresh();
  assert.equal(s.current?.id, "A");
  assert.equal(s.artFor("tiles/a.webp")?.bytes.toString(), "A's own pixels", "re-materialised, not half-served");
  rmSync(root, { recursive: true, force: true });
});

test("a STRUCTURAL refusal is remembered per pointer, so the belt does not re-download the delta every minute", async () => {
  // The refusals do not advance `this.ptr`, so the 60 s belt re-read the same
  // pointer, found the generation absent from `gens`, and re-fetched the WHOLE
  // art delta before refusing again for the identical reason — thousands of
  // requests a minute at the p99 delta. A refusal that cannot change until the
  // STORE does is remembered; an INCOMPLETE read is not, because a blob still
  // replicating is exactly what the belt exists to retry.
  const root = fresh();
  writeGen(root, "ok", {});
  point(root, { seq: 1, current: "ok", retained: [] });
  let reads = 0;
  const backend = localBackend(root);
  const counting = { ...backend, get: async (p: string) => { if (p.startsWith("blob/")) reads++; return backend.get(p); } };
  const s = new BundleStore(counting, undefined, DOMAINS);
  await s.refresh();
  writeGen(root, "bad", { rawArt: { "notadomain/x.webp": hashBytes(Buffer.from("x")) } });
  point(root, { seq: 2, current: "bad", retained: ["ok"] });
  await s.refresh();
  const after = reads;
  for (let i = 0; i < 5; i++) await s.refresh(); // five belt ticks
  assert.equal(reads, after, "not one extra blob read across five re-reads of a pointer already refused");
  assert.equal(s.current?.id, "ok");
  // A NEW pointer always gets a fresh hearing.
  writeGen(root, "good", { art: { "tiles/a.webp": "fine" } });
  point(root, { seq: 3, current: "good", retained: ["ok"] });
  await s.refresh();
  assert.equal(s.current?.id, "good", "a new pointer is never suppressed by an earlier refusal");
  rmSync(root, { recursive: true, force: true });
});

test("the overlay resolves against the CURRENT generation only, so a flip that drops art falls through to the image", async () => {
  const root = fresh();
  writeGen(root, "g1", { art: { "tiles/plates/grass.webp": "GRASS v1" } });
  point(root, { seq: 1, current: "g1", retained: [] });
  const s = store(root);
  await s.refresh();
  writeGen(root, "g2", {}); // no art at all
  point(root, { seq: 2, current: "g2", retained: ["g1"] });
  await s.refresh();
  assert.equal(s.current?.id, "g2");
  assert.equal(s.artFor("tiles/plates/grass.webp"), null, "no stale overlay survives the flip");
  assert.equal(s.overlay.art, 0);
  assert.equal(s.overlay.bytes, 0, "and its bytes are gone — the cost is tens of MB on a 1 GiB instance");
  rmSync(root, { recursive: true, force: true });
});

test("every unsafe overlay path is refused, and the generation before it keeps serving", async () => {
  const root = fresh();
  writeGen(root, "ok", { art: { "tiles/a.webp": "fine" } });
  point(root, { seq: 1, current: "ok", retained: [] });
  const s = store(root);
  await s.refresh();
  assert.equal(s.current?.id, "ok");

  const UNSAFE = [
    "tiles/../../etc/passwd", // escapes
    "/etc/passwd", // absolute
    "tiles//a.webp", // empty segment
    "./tiles/a.webp", // does not normalise to itself
    "tiles/a.webp/", // trailing slash
    "notadomain/a.webp", // outside the nine
    "wiki/site/data.json", // mounted, but not reproducible on a runner
    "live/tuning/scenery.json", // has its own no-redeploy channel
    "a".repeat(300), // absurd length
    "", // empty
  ];
  let seq = 1;
  for (const bad of UNSAFE) {
    const id = `bad${seq}`;
    writeGen(root, id, { rawArt: { [bad]: hashBytes(Buffer.from("x")) } });
    point(root, { seq: ++seq, current: id, retained: ["ok"] });
    await s.refresh();
    assert.equal(s.current?.id, "ok", `refused: ${JSON.stringify(bad)}`);
  }
  rmSync(root, { recursive: true, force: true });
});

test("safeOverlayPath admits every shape the real art tree uses and nothing else", () => {
  // Measured across the whole curated root: all 50,121 paths match
  // ^[A-Za-z0-9][A-Za-z0-9._@/-]*$, none holds `..`, a backslash, a space or a
  // non-ASCII byte, and the deepest is 8 segments / 117 chars.
  for (const good of [
    "tiles/plates/grass/clean.webp",
    "characters2/humans/hero-01/walk_south_0.webp",
    "monsters/saber_toothed_tiger/attack/frame_10.webp",
    "lore/lore.json",
    "items/a@b/sprite.webp",
    "scenery/a.b.c/d-e_f/g.webp",
  ]) {
    assert.equal(safeOverlayPath(good), true, good);
  }
  for (const bad of [
    "../x",
    "a/../b",
    "/a",
    "a/",
    "//a",
    "a//b",
    "./a",
    "a\\b",
    "a b",
    "a\nb",
    "café/x.webp",
    "a%2fb",
    ".hidden/x",
    "",
    "a".repeat(257),
  ]) {
    assert.equal(safeOverlayPath(bad), false, JSON.stringify(bad));
  }
});

test("a blob that does not hash to the name it is filed under refuses the generation", async () => {
  const root = fresh();
  writeGen(root, "ok", { art: { "tiles/a.webp": "fine" } });
  point(root, { seq: 1, current: "ok", retained: [] });
  const s = store(root);
  await s.refresh();
  // A lying manifest: the hash of one thing, the bytes of another. An
  // interrupted put leaves exactly this, and blobs are SHARED — so the server
  // re-hashes on load or every generation naming it is refused forever while
  // the publisher keeps printing success.
  const lie = hashBytes(Buffer.from("what the manifest claims"));
  mkdirSync(join(root, "blob"), { recursive: true });
  writeFileSync(join(root, "blob", lie), "what the blob actually holds");
  writeGen(root, "liar", { rawArt: { "tiles/a.webp": lie } });
  point(root, { seq: 2, current: "liar", retained: ["ok"] });
  await s.refresh();
  assert.equal(s.current?.id, "ok");
  rmSync(root, { recursive: true, force: true });
});

test("THE DIST ROOT IS PARTITIONED: published or pinned, never neither and never both", async () => {
  const root = fresh();
  // The image holds two root files; the verify callback is the server's half.
  const image: Record<string, string> = { "monsters.json": hashBytes(Buffer.from("IMAGE monsters")), "sw.js": hashBytes(Buffer.from("IMAGE sw")) };
  const verify = (ft: Record<string, string>, pub: ReadonlySet<string>) => {
    const bad: string[] = [];
    for (const [rel, h] of Object.entries(ft)) if (image[rel] !== h) bad.push(rel);
    for (const rel of Object.keys(image)) if (!(rel in ft) && !pub.has(rel)) bad.push(`${rel} unpinned`);
    return bad;
  };
  const s = store(root, verify);

  // A good one: publishes monsters.json, pins sw.js.
  writeGen(root, "ok", { root: { "monsters.json": "NEW monsters" }, fallthrough: { "sw.js": image["sw.js"] } });
  point(root, { seq: 1, current: "ok", retained: [] });
  await s.refresh();
  assert.equal(s.current?.id, "ok");
  assert.equal(s.rootFor("monsters.json")?.bytes.toString(), "NEW monsters");
  assert.equal(s.rootFor("sw.js"), null, "what it pinned comes from the image");

  // Neither: sw.js named by no map at all — the unpinned hole.
  writeGen(root, "unpinned", { root: { "monsters.json": "NEW monsters" }, fallthrough: {} });
  point(root, { seq: 2, current: "unpinned", retained: ["ok"] });
  await s.refresh();
  assert.equal(s.current?.id, "ok", "a dist-root file named by neither map is refused");

  // Both: the two sides disagree about who owns the path.
  writeGen(root, "both", {
    root: { "monsters.json": "NEW monsters" },
    fallthrough: { "sw.js": image["sw.js"], "monsters.json": image["monsters.json"] },
  });
  point(root, { seq: 3, current: "both", retained: ["ok"] });
  await s.refresh();
  assert.equal(s.current?.id, "ok", "published AND pinned is refused");
  rmSync(root, { recursive: true, force: true });
});

test("ONLY THE FIVE GENERATED CATALOGS MAY BE PUBLISHED — everything else in the dist root is ?v=-frozen", async () => {
  // Measured live against image e697e384ec5811: /ui2/icon-map.webp?v=<sha>,
  // /logo.webp?v=<sha> and /sw.js?v=<sha> ALL answer
  // `public, max-age=31536000, immutable`, and hud.ts/select.ts genuinely build
  // those URLs through withV. Republishing one changes bytes under a URL a
  // browser already holds frozen.
  assert.deepEqual(
    [...PUBLISHABLE_ROOT].sort(),
    ["characters.json", "monsters.json", "npcs.json", "shipset.json", "worlds.json"],
  );
  const root = fresh();
  writeGen(root, "ok", {});
  point(root, { seq: 1, current: "ok", retained: [] });
  const s = store(root);
  await s.refresh();
  let seq = 1;
  for (const bad of ["ui2/icon-map.webp", "logo.webp", "sw.js", "icons/icon-192.png", "manifest.webmanifest", "assets/sneak.js", "index.html"]) {
    const id = `r${seq}`;
    const h = blob(root, `bytes for ${bad}`);
    mkdirSync(join(root, "gen", id), { recursive: true });
    writeFileSync(
      join(root, "gen", id, "manifest.json"),
      JSON.stringify({ files: { "index.html": blob(root, "<html>x</html>") }, root: { [bad]: h }, git_sha: "b".repeat(40), commit_ts: 0 }),
    );
    point(root, { seq: ++seq, current: id, retained: ["ok"] });
    await s.refresh();
    assert.equal(s.current?.id, "ok", `refused as a dist-root publish: ${bad}`);
  }
  rmSync(root, { recursive: true, force: true });
});

test("the overlay caps refuse rather than OOM, and hand back every byte they took", async () => {
  const root = fresh();
  writeGen(root, "ok", { art: { "tiles/a.webp": "fine" } });
  point(root, { seq: 1, current: "ok", retained: [] });
  process.env.ART_BYTES_MAX = "2000";
  process.env.ART_FILES_MAX = "3";
  // Re-imported so the module-level caps read the env just set. (The shipped
  // values are asserted by verify-artlane arm L against the source.)
  const mod = await import(`../src/bundlestore?caps=${Date.now()}`);
  const s = new mod.BundleStore(mod.localBackend(root), undefined, DOMAINS);
  await s.refresh();
  assert.equal(s.current?.id, "ok");

  const big = "x".repeat(5000);
  writeGen(root, "toobig", { art: { "tiles/big.webp": big } });
  point(root, { seq: 2, current: "toobig", retained: ["ok"] });
  await s.refresh();
  assert.equal(s.current?.id, "ok", "over the byte cap: refused, and the container lane carries that push");
  assert.ok(s.overlay.bytes <= 2000, `and its bytes were handed back (${s.overlay.bytes})`);

  writeGen(root, "toomany", {
    art: { "tiles/a.webp": "1", "tiles/b.webp": "2", "tiles/c.webp": "3", "tiles/d.webp": "4" },
  });
  point(root, { seq: 3, current: "toomany", retained: ["ok"] });
  await s.refresh();
  assert.equal(s.current?.id, "ok", "over the file cap: refused");
  delete process.env.ART_BYTES_MAX;
  delete process.env.ART_FILES_MAX;
  rmSync(root, { recursive: true, force: true });
});

test("ART_LANE_DOMAINS is the nine the game renders, and neither wiki nor live", () => {
  assert.deepEqual(
    [...ART_LANE_DOMAINS].sort(),
    ["characters2", "items", "lore", "maps2", "monsters", "music", "scenery", "sounds", "tiles"],
  );
  assert.ok(!ART_LANE_DOMAINS.includes("wiki"), "the image builds wiki/release_notes.json from git history");
  assert.ok(!ART_LANE_DOMAINS.includes("live"), "live/** has its own no-redeploy channel and live/telemetry is .dockerignore-excluded");
});
