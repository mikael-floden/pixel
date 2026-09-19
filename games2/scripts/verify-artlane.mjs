#!/usr/bin/env node
// THE ART LANE, END TO END, against a real server process: curate, diff,
// publish, serve, grant, refuse, fall back. verify-fastlane proves the CHANNEL
// cannot lie about a bundle; this proves it cannot lie about ART — which is the
// harder claim, because art names are mutable by construction and art is what
// the one-year cache grant is attached to.
//
//   A  no generation           the image's art serves; ?v grants NOTHING (the
//                              structural fix that makes this lane possible)
//                              and ?h still grants a year
//   B  a published overlay     the NEW bytes serve, with the new hash as ETag
//   C  the grant               ?h=<new> immutable; ?h=<old> no-cache; ?v no-cache
//   D  the index               /asset-index.json names the overlay's hash for
//                              what it published and the image's for the rest
//   E  the conditional         a request carrying the overlay's ETag 304s, and
//                              the 304 carries the same Cache-Control
//   F  untouched art           falls through to the image, byte-identical
//   G  a dist-root catalog     the generation's copy serves, not the image's
//   H  an unpinned dist file   refused — neither published nor pinned
//   I  art outside the mounts  refused
//   J  a path that escapes     refused
//   K  a lying art hash        refused, and the image keeps serving
//   L  the byte cap            refused; the container lane carries that push
//   M  an ART-LESS generation  overlays nothing — the server is generation-exact
//   R  A CLIENT-LANE PUBLISH    CARRIES the live overlay forward, so a
//                               browser-code push cannot empty it (a repaint
//                               reverting and an ADDED file 404ing was real)
//   N  the lane off            byte-identical to today, ?v grant included
//   O  A ROLLBACK ONTO EVICTED ART  re-materialises it, and NEVER serves that
//                              generation's client against the image's art
//   P  the prune               the store keeps the window and nothing else
//   Q  the deploy's own filter still refuses art, so the container keeps
//                              building on an art push (which bounds all of it)
//
// Needs no cloud: the store is a local directory and the "image" is a small art
// root handed to the server through ASSETS_ROOT.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishBundle, localStore, revertBundle } from "./publish-bundle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const h16 = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const SHA = "artlane0000000000000000000000000000000001";
const IMAGE_TS = 1_700_000_000;
const GEN_TS = IMAGE_TS + 100;

let bad = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) bad++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ the fake image
// A small curated art root, in real mounted domains, with the index the image
// would have built over it.
const artRoot = mkdtempSync(join(tmpdir(), "artlane-assets-"));
const store = mkdtempSync(join(tmpdir(), "artlane-store-"));
const scratch = mkdtempSync(join(tmpdir(), "artlane-out-"));
const newArt = mkdtempSync(join(tmpdir(), "artlane-new-"));

const IMAGE_ART = {
  "tiles/plates/grass.webp": Buffer.from("IMAGE grass plate bytes"),
  "tiles/plates/stone.webp": Buffer.from("IMAGE stone plate bytes"),
  "scenery/oak/south.webp": Buffer.from("IMAGE oak bytes"),
  "sounds/foley/step.ogg": Buffer.from("IMAGE step bytes"),
};
for (const [rel, bytes] of Object.entries(IMAGE_ART)) {
  mkdirSync(dirname(join(artRoot, rel)), { recursive: true });
  writeFileSync(join(artRoot, rel), bytes);
}
writeFileSync(
  join(artRoot, "asset-index.json"),
  JSON.stringify({
    schema: "nangijala-asset-index@1",
    algo: "sha256-16",
    files: Object.fromEntries(Object.entries(IMAGE_ART).map(([rel, b]) => [rel, h16(b)])),
  }),
);

const servers = [];
function startServer(env) {
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
    cwd: join(ROOT, "server"),
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      SERVE_CLIENT: "1",
      NODE_ENV: "production",
      ASSETS_ROOT: artRoot,
      GIT_SHA: SHA,
      GIT_COMMIT_TS: String(IMAGE_TS),
      ...env,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  servers.push(child);
  return { child, origin: `http://127.0.0.1:${port}` };
}
process.on("exit", () => {
  for (const c of servers) {
    try { process.kill(-c.pid, "SIGKILL"); } catch {}
  }
  for (const d of [artRoot, store, scratch, newArt]) rmSync(d, { recursive: true, force: true });
});
async function healthy(origin, ms = 90_000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    try { if ((await fetch(origin + "/health")).ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}
const cc = async (origin, path) => {
  const r = await fetch(origin + path);
  return { status: r.status, cc: r.headers.get("cache-control"), etag: r.headers.get("etag"), body: await r.text(), type: r.headers.get("content-type") };
};
const poke = async (origin) => (await fetch(origin + "/api/bundle/refresh", { method: "POST" })).json();
const info = async (origin) => (await fetch(origin + "/api/bundle")).json();
/** THE STORE'S OWN REASON, printed on every disagreement. The fast lane lost a
 *  day to a refusal that sat in /api/bundle while CI printed a warning that
 *  read like replication lag, so this gate never reports a mismatch without the
 *  reason beside it. */
const why = async (origin) => (await info(origin)).recent?.slice(-3).join("\n       ") || "(nothing logged)";
const checkServing = async (origin, want, what) => {
  const now = await info(origin);
  const ok = now.serving === want;
  check(ok, what);
  if (!ok) console.log(`       serving ${now.serving}, want ${want}\n       ${await why(origin)}`);
  return now;
};

// The image's own client/dist is what a generation falls through to; build it
// if this tree has not.
if (!existsSync(join(ROOT, "client", "dist", "index.html"))) {
  const { fastBuild } = await import("./fastbuild.mjs");
  await fastBuild({ outDir: join(ROOT, "client", "dist"), gitSha: "artlane" });
}

const S = localStore(store);
// THE CAPS ARE LOWERED FOR THIS SERVER so arm L can exercise the mechanism
// without a 64 MB allocation. The PRODUCTION numbers are asserted separately
// below, against the constants themselves — a gate that only ever sees a test
// value proves the code and not the policy.
const { origin } = startServer({ BUNDLE_STORE: store, ART_BYTES_MAX: "150000", ART_FILES_MAX: "40" });
if (!(await healthy(origin))) { console.error("FAIL: the server never became healthy"); process.exit(1); }

// ------------------------------------------------- A: the image's art, and ?v
{
  const rel = "tiles/plates/grass.webp";
  const hash = h16(IMAGE_ART[rel]);
  const plain = await cc(origin, `/assets/${rel}`);
  check(plain.status === 200 && plain.body === IMAGE_ART[rel].toString(), "A — the image's art serves");
  check(plain.cc === "no-cache", "A — unstamped art revalidates");
  const withV = await cc(origin, `/assets/${rel}?v=${SHA}`);
  check(
    withV.cc === "no-cache",
    `A — ?v=<this instance's GIT_SHA> grants NOTHING for art (got ${withV.cc}) — the structural fix`,
  );
  const withH = await cc(origin, `/assets/${rel}?h=${hash}`);
  check(withH.cc === "public, max-age=31536000, immutable", "A — ?h verified against the bytes still grants a year");
  const wrongH = await cc(origin, `/assets/${rel}?h=${"0".repeat(16)}`);
  check(wrongH.cc === "no-cache", "A — a wrong ?h grants nothing");
  // And a non-art file keeps the ?v grant it always had.
  const pub = await cc(origin, `/logo.webp?v=${SHA}`);
  check(
    pub.status !== 200 || pub.cc === "public, max-age=31536000, immutable",
    "A — client/public keeps the ?v grant (the art lane never publishes it)",
  );
}

// -------------------------------------------- publish a generation WITH art
const NEW_GRASS = Buffer.from("REPAINTED grass plate bytes, new pixels");
const NEW_CATALOG = Buffer.from(JSON.stringify({ schema: "test", monsters: ["a", "b"] }));
for (const [rel, bytes] of Object.entries({ ...IMAGE_ART, "tiles/plates/grass.webp": NEW_GRASS })) {
  mkdirSync(dirname(join(newArt, rel)), { recursive: true });
  writeFileSync(join(newArt, rel), bytes);
}
const curated = {
  root: newArt,
  count: Object.keys(IMAGE_ART).length,
  files: Object.fromEntries(
    Object.keys(IMAGE_ART).map((rel) => [rel, h16(readFileSync(join(newArt, rel)))]),
  ),
};
// A published dist-root catalog: write it into the tree fastbuild copies from,
// then put it back — the same thing artbuild's manifest step does for real.
const pubDir = join(ROOT, "client", "public");
const catalogPath = join(pubDir, "monsters.json");
const catalogWas = existsSync(catalogPath) ? readFileSync(catalogPath) : null;
let gen1;
try {
  writeFileSync(catalogPath, NEW_CATALOG);
  gen1 = await publishBundle({
    store: S,
    outDir: scratch,
    gitSha: "a".repeat(40),
    commitTs: GEN_TS,
    imageOrigin: origin,
    art: curated,
  });
} finally {
  if (catalogWas) writeFileSync(catalogPath, catalogWas);
}
check(gen1.published === true, "publish — the generation was written");
await poke(origin);
const served = await checkServing(origin, gen1.id, "B — the generation is serving");
check(served.overlay?.art === 1, `B — one art file overlaid (${JSON.stringify(served.overlay)})`);
check(served.overlay?.root >= 1, "B — at least one dist-root file overlaid (monsters.json)");

// ------------------------------------------------- B/C: the overlay's bytes
{
  const rel = "tiles/plates/grass.webp";
  const newHash = h16(NEW_GRASS);
  const oldHash = h16(IMAGE_ART[rel]);
  const got = await cc(origin, `/assets/${rel}`);
  check(got.body === NEW_GRASS.toString(), "B — the REPAINTED bytes serve, not the image's");
  check(got.etag === `"${newHash}"`, `B — the ETag is the hash of those bytes (${got.etag})`);
  check(got.type === "image/webp", `B — the Content-Type comes from the name (${got.type})`);
  check((await cc(origin, `/assets/${rel}?h=${newHash}`)).cc === "public, max-age=31536000, immutable", "C — ?h=<new> grants a year");
  check((await cc(origin, `/assets/${rel}?h=${oldHash}`)).cc === "no-cache", "C — ?h=<the OLD hash> grants nothing");
  check((await cc(origin, `/assets/${rel}?v=${SHA}`)).cc === "no-cache", "C — ?v grants nothing on an overlaid file either");
  // E: the conditional request
  const r = await fetch(origin + `/assets/${rel}?h=${newHash}`, { headers: { "if-none-match": `"${newHash}"` } });
  check(r.status === 304, "E — a request carrying the overlay's ETag 304s");
  check(r.headers.get("cache-control") === "public, max-age=31536000, immutable", "E — and the 304 carries the same grant");
}

// ------------------------------------------------------------- D: the index
{
  const idx = await (await fetch(origin + "/asset-index.json")).json();
  check(idx.files["tiles/plates/grass.webp"] === h16(NEW_GRASS), "D — the index names the OVERLAY's hash for what it published");
  check(idx.files["tiles/plates/stone.webp"] === h16(IMAGE_ART["tiles/plates/stone.webp"]), "D — and the IMAGE's hash for what it did not");
  check(idx.schema === "nangijala-asset-index@1", "D — the merge keeps the schema");
  // F: untouched art is byte-identical to the image's
  const stone = await cc(origin, "/assets/tiles/plates/stone.webp");
  check(stone.body === IMAGE_ART["tiles/plates/stone.webp"].toString(), "F — untouched art falls through to the image");
}

// ------------------------------------------------------ G: the dist root
{
  const got = await cc(origin, "/monsters.json");
  check(got.body === NEW_CATALOG.toString(), "G — the generation's catalog serves, not the image's");
  const sw = await cc(origin, "/sw.js");
  check(sw.status === 200 && !sw.body.includes("REPAINTED"), "G — a dist-root file it did not publish still comes from the image");
}

// --------------------------------------------------- the adversarial arms
// Each hand-writes a generation the publisher would never produce, and each
// must be REFUSED with the previous one left serving.
const okId = gen1.id;
const baseManifest = JSON.parse((await S.get(`gen/${okId}/manifest.json`)).toString());
let seq = (await S.get("pointer.json")) ? JSON.parse((await S.get("pointer.json")).toString()).seq : 1;

async function tryGeneration(label, mutate, extraBlobs = {}) {
  const man = JSON.parse(JSON.stringify(baseManifest));
  mutate(man);
  const id = `bad${label.replace(/[^a-z0-9]/gi, "").slice(0, 10)}`;
  for (const [hash, bytes] of Object.entries(extraBlobs)) await S.put(`blob/${hash}`, bytes);
  await S.put(`gen/${id}/manifest.json`, Buffer.from(JSON.stringify(man)));
  await S.put(
    "pointer.json",
    Buffer.from(JSON.stringify({ seq: ++seq, current: id, retained: [okId], git_sha: "b".repeat(40), commit_ts: GEN_TS + seq })),
  );
  await poke(origin);
  return await checkServing(origin, okId, label);
}

const OUTSIDE = Buffer.from("bytes that must never be served");
await tryGeneration("I — art outside the mounted domains is refused", (m) => {
  m.art = { "notadomain/x.webp": h16(OUTSIDE) };
}, { [h16(OUTSIDE)]: OUTSIDE });
// wiki/ and live/ are MOUNTED and SERVED but must never be overlaid: the
// image builds wiki/release_notes.json from git history, live/** has its own
// no-redeploy channel, and live/telemetry is .dockerignore-excluded.
await tryGeneration("I — art in a mounted-but-not-publishable domain (wiki) is refused", (m) => {
  m.art = { "wiki/site/data.json": h16(OUTSIDE) };
}, { [h16(OUTSIDE)]: OUTSIDE });
await tryGeneration("I — and live/ is refused too", (m) => {
  m.art = { "live/tuning/scenery.json": h16(OUTSIDE) };
}, { [h16(OUTSIDE)]: OUTSIDE });
await tryGeneration("J — an art path that escapes the root is refused", (m) => {
  m.art = { "tiles/../../etc/passwd": h16(OUTSIDE) };
}, { [h16(OUTSIDE)]: OUTSIDE });
await tryGeneration("J — an absolute art path is refused", (m) => {
  m.art = { "/etc/passwd": h16(OUTSIDE) };
}, { [h16(OUTSIDE)]: OUTSIDE });
await tryGeneration("K — art whose blob does not hash to its name is refused", (m) => {
  m.art = { "tiles/plates/grass.webp": h16(Buffer.from("a hash that names other bytes")) };
}, { [h16(Buffer.from("a hash that names other bytes"))]: OUTSIDE });
await tryGeneration("H — a dist-root file named by neither map is refused", (m) => {
  delete m.fallthrough["sw.js"];
});
await tryGeneration("H — a dist-root file both published and pinned is refused", (m) => {
  m.root = { ...(m.root || {}), "sw.js": m.fallthrough["sw.js"] };
});
await tryGeneration("I — a generation publishing assets/ as a dist-root file is refused", (m) => {
  m.root = { ...(m.root || {}), "assets/sneak.js": h16(OUTSIDE) };
}, { [h16(OUTSIDE)]: OUTSIDE });
// THE ONE THE REVIEW PANEL FOUND. /ui2/icon-map.webp?v=<sha> answers immutable
// on the live server and the client stamps that URL, so a generation that
// republished it would change bytes under a frozen URL. Only the five
// generated catalogs may be published (PUBLISHABLE_ROOT).
await tryGeneration("I — a generation publishing a ?v-stamped dist-root file (ui2 icon) is refused", (m) => {
  m.root = { ...(m.root || {}), "ui2/icon-map.webp": h16(OUTSIDE) };
  delete m.fallthrough["ui2/icon-map.webp"];
}, { [h16(OUTSIDE)]: OUTSIDE });
await tryGeneration("I — and so is sw.js", (m) => {
  m.root = { ...(m.root || {}), "sw.js": h16(OUTSIDE) };
  delete m.fallthrough["sw.js"];
}, { [h16(OUTSIDE)]: OUTSIDE });

// ------------------------------------------------- L: the caps (this server's)
{
  const big = Buffer.alloc(200_000, 7); // over the 150 KB this server was started with
  await tryGeneration("L — an overlay over the BYTE cap is refused", (m) => {
    m.art = { "tiles/plates/big.webp": h16(big) };
  }, { [h16(big)]: big });
  const many = {};
  const blobs = {};
  for (let i = 0; i < 60; i++) {
    const b = Buffer.from(`tiny ${i}`);
    many[`tiles/plates/f${i}.webp`] = h16(b);
    blobs[h16(b)] = b;
  }
  await tryGeneration("L — an overlay over the FILE cap is refused", (m) => {
    m.art = many;
  }, blobs);
  // And the shipped defaults are what the docs and the publisher say, so the
  // arms above prove the mechanism and this proves the policy.
  const src = readFileSync(join(ROOT, "server", "src", "bundlestore.ts"), "utf8");
  check(/ART_FILES_MAX \|\| 6000/.test(src), "L — the shipped file cap is 6000");
  check(/ART_BYTES_MAX \|\| 64_000_000/.test(src), "L — the shipped byte cap is 64 MB");
  const pub = readFileSync(join(ROOT, "scripts", "publish-bundle.mjs"), "utf8");
  check(/ART_FILES_MAX \|\| 6000/.test(pub) && /ART_BYTES_MAX \|\| 64_000_000/.test(pub), "L — and the publisher refuses at the same two numbers");
}

// -------------------------------------------- M: a flip that drops the art
{
  // A generation with NO art at all, published honestly: the image's bytes must
  // come back, with no trace of the overlay.
  const man = JSON.parse(JSON.stringify(baseManifest));
  delete man.art;
  delete man.root;
  // everything the dropped `root` used to publish is now pinned at the IMAGE's
  // hash, which is what the image actually holds.
  const ft = await (await fetch(origin + "/api/bundle/fallthrough")).json();
  man.fallthrough = ft.files;
  const id = "noartgeneration";
  await S.put(`gen/${id}/manifest.json`, Buffer.from(JSON.stringify(man)));
  await S.put(
    "pointer.json",
    Buffer.from(JSON.stringify({ seq: ++seq, current: id, retained: [okId], git_sha: "c".repeat(40), commit_ts: GEN_TS + seq })),
  );
  await poke(origin);
  const now = await checkServing(origin, id, "M — a hand-written art-free generation is serving");
  const got = await cc(origin, "/assets/tiles/plates/grass.webp");
  check(got.body === IMAGE_ART["tiles/plates/grass.webp"].toString(), "M — and overlays nothing: the server is generation-EXACT (arm R is what stops a real publish doing this)");
  check(now.overlay?.art === 0 && now.overlay?.bytes === 0, `M — nothing is held (${JSON.stringify(now.overlay)})`);
  const idx = await (await fetch(origin + "/asset-index.json")).json();
  check(idx.files["tiles/plates/grass.webp"] === h16(IMAGE_ART["tiles/plates/grass.webp"]), "M — and the index is the image's again");
}

// ------------------------------ O: THE ROLLBACK, ONTO AN EVICTED OVERLAY
// THE SHARPEST FAILURE THIS LANE HAS. Overlay bytes are kept for the CURRENT
// generation only, so a generation still in the window has its NAMES and not
// its art — and a rollback points straight at one of those. A bare
// `gens.has(id)` check then skips the load, flips, and resolves that
// generation's art to hashes whose bytes are gone: its client served against
// the IMAGE's art and catalogs, with an asset index naming bytes nobody holds.
// That is the mixed generation the whole partition exists to make
// unrepresentable, so it gets its own arm.
{
  const s2 = localStore(store);
  const before = JSON.parse((await s2.get("pointer.json")).toString());
  // Publish a generation WITH art (A), then one WITHOUT it (B) so A's overlay
  // bytes are evicted, then roll back to A.
  const A_ART = Buffer.from("ROLLBACK TARGET grass — generation A's own pixels");
  for (const [rel, bytes] of Object.entries({ ...IMAGE_ART, "tiles/plates/grass.webp": A_ART })) {
    mkdirSync(dirname(join(newArt, rel)), { recursive: true });
    writeFileSync(join(newArt, rel), bytes);
  }
  const curatedA = {
    root: newArt,
    count: Object.keys(IMAGE_ART).length,
    files: Object.fromEntries(Object.keys(IMAGE_ART).map((rel) => [rel, h16(readFileSync(join(newArt, rel)))])),
  };
  const genA = await publishBundle({ store: s2, outDir: scratch, gitSha: "d".repeat(40), commitTs: GEN_TS + 500, imageOrigin: origin, art: curatedA });
  await poke(origin);
  await checkServing(origin, genA.id, "O — generation A (with art) is serving");
  check((await cc(origin, "/assets/tiles/plates/grass.webp")).body === A_ART.toString(), "O — A's art serves");

  // B: the image's own art, so A's overlay blobs fall out of the live set.
  for (const [rel, bytes] of Object.entries(IMAGE_ART)) writeFileSync(join(newArt, rel), bytes);
  const curatedB = {
    root: newArt,
    count: Object.keys(IMAGE_ART).length,
    files: Object.fromEntries(Object.keys(IMAGE_ART).map((rel) => [rel, h16(readFileSync(join(newArt, rel)))])),
  };
  const genB = await publishBundle({ store: s2, outDir: scratch, gitSha: "e".repeat(40), commitTs: GEN_TS + 600, imageOrigin: origin, art: curatedB });
  await poke(origin);
  await checkServing(origin, genB.id, "O — generation B is serving, so A's overlay bytes are evicted");
  check((await info(origin)).overlay?.art === 0, "O — and the server holds no art for B");

  // ...and now roll back, exactly as a red gate does.
  const back = await revertBundle({ store: s2 });
  check(back.current === genA.id, `O — the rollback targets A (${back.current})`);
  await poke(origin);
  await checkServing(origin, genA.id, "O — A is serving again after the rollback");
  const got = await cc(origin, "/assets/tiles/plates/grass.webp");
  check(got.body === A_ART.toString(), "O — AND A'S OWN ART SERVES: the overlay was re-materialised, not silently dropped");
  check((await info(origin)).overlay?.art === 1, "O — the server holds A's art again");
  const idx = await (await fetch(origin + "/asset-index.json")).json();
  check(idx.files["tiles/plates/grass.webp"] === h16(A_ART), "O — and the index names what is actually being served");
  void before;
}

// ----------- R: A CLIENT-LANE PUBLISH MUST NOT EMPTY THE ART OVERLAY
// THE DEFECT THIS ARM EXISTS FOR, reproduced against a real server before it
// was fixed: an art push serves a repaint and a newly ADDED file; the next
// BROWSER-CODE push carries no `art`, and because the server resolves the
// overlay against the current generation alone, the repaint reverted to the
// image's old pixels and the added file 404'd into a missing texture. games-ui
// pushes land all day between art pushes, so that window is the common case,
// not a corner. A generation now carries the COMPLETE overlay whichever lane
// writes it (publish-bundle.mjs, carryOverlay) — for free, because the blobs
// are content-addressed and already in the store.
{
  const s2 = localStore(store);
  const before = await info(origin);
  const art0 = before.overlay?.art ?? 0;
  check(art0 > 0, `R — an art generation is serving first (${art0} file(s) overlaid)`);
  const served = await cc(origin, "/assets/tiles/plates/grass.webp");
  // A CLIENT-LANE publish: no `art`, exactly as fast-publish.yml runs it.
  const client = await publishBundle({
    store: s2, outDir: scratch, gitSha: "f".repeat(40), commitTs: GEN_TS + 700, imageOrigin: origin,
  });
  await poke(origin);
  await checkServing(origin, client.id, "R — the browser-code generation is serving");
  const after = await cc(origin, "/assets/tiles/plates/grass.webp");
  check(after.body === served.body, "R — AND THE ART SURVIVED IT: the overlay was carried forward, not emptied");
  const now = await info(origin);
  check((now.overlay?.art ?? 0) === art0, `R — every overlaid file came with it (${now.overlay?.art} of ${art0})`);
  const idx = await (await fetch(origin + "/asset-index.json")).json();
  check(idx.files["tiles/plates/grass.webp"] === h16(Buffer.from(after.body)), "R — and the index still names what is served");
}

// ------------------------------------------------------------- P: the prune
{
  const s2 = localStore(store);
  const ptr = JSON.parse((await s2.get("pointer.json")).toString());
  const window = [ptr.current, ...(ptr.retained ?? [])].filter(Boolean);
  const keep = new Set();
  for (const id of window) {
    const raw = await s2.get(`gen/${id}/manifest.json`);
    if (!raw) continue;
    const m = JSON.parse(raw.toString());
    for (const map of [m.files, m.root, m.art]) for (const h of Object.values(map ?? {})) keep.add(h);
  }
  const onDisk = readdirSync(join(store, "blob"));
  const stray = onDisk.filter((b) => !keep.has(b));
  // The prune runs on a PUBLISH, and the last thing this gate did was a
  // rollback (which deliberately prunes nothing), so the window's own
  // generations are what must be intact — a blob the window NAMES may never be
  // missing, whatever else is lying around.
  const missing = [...keep].filter((h) => !onDisk.includes(h));
  check(missing.length === 0, `P — every blob the window names is present (${missing.length} missing)`);
  check(stray.length <= keep.size, `P — the store is bounded by the window (${onDisk.length} on disk, ${keep.size} named)`);
  const gens = readdirSync(join(store, "gen"));
  check(gens.length <= window.length + 1, `P — and old manifests are pruned (${gens.length} held, window ${window.length})`);

  // THE INVARIANT THE PRUNE EXISTS UNDER, stated directly, because the first
  // version of it broke exactly here. The pointer's `retained` is the
  // PUBLISHER's list and can name generations this instance REFUSED, so the
  // generation the server is ACTUALLY SERVING can sit outside the window — and
  // a prune that deleted on the window alone took the bytes out from under the
  // live generation. verify-fastlane arm M is what caught it; this says it in
  // the art lane's own terms.
  const live = await info(origin);
  if (live.serving) {
    const raw = await s2.get(`gen/${live.serving}/manifest.json`);
    check(!!raw, `P — the SERVING generation's manifest survived the prune (${live.serving})`);
    if (raw) {
      const m = JSON.parse(raw.toString());
      const need = [];
      for (const map of [m.files, m.root, m.art]) for (const h of Object.values(map ?? {})) need.push(h);
      const gone = need.filter((h) => !onDisk.includes(h));
      check(gone.length === 0, `P — and EVERY byte it names is still in the store (${gone.length} missing of ${need.length})`);
    }
  }
}

// ------------------- Q: the container must keep building on an art push
{
  // THE SAFETY NET THAT BOUNDS EVERYTHING ELSE — the art delta is measured
  // against the IMAGE, so the container refreshing every few minutes is what
  // bounds the delta, bounds the server's memory, and lets law 6 undo a bad art
  // generation automatically. All three die if `nangijala-deploy.yml` ever
  // treats an art push as skippable.
  //
  // THIS ARM USED TO READ THE FILTER AS A STRING and assert it did not contain
  // `"<domain>/"`. The canonical widening spells the set
  // `^(characters2|tiles|…|lore)/`, which contains no such substring, so the
  // arm passed straight through the exact edit it existed to catch. A filter is
  // a program: check-deploy-filter.mjs RUNS it, against one probe path per
  // domain, and is itself proven to go red on that widening.
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "check-deploy-filter.mjs")], { encoding: "utf8" });
  check(r.status === 0, "Q — every lane filter behaves as the lanes require (check-deploy-filter.mjs)");
  if (r.status !== 0) console.log((r.stdout || "").split("\n").filter((l) => l.includes("FAIL")).join("\n"));
}

// -------------------------------------------------------------- N: lane off
{
  const off = startServer({ BUNDLE_STORE: "" });
  if (!(await healthy(off.origin))) { console.error("FAIL: the lane-off server never became healthy"); process.exit(1); }
  const rel = "tiles/plates/grass.webp";
  const got = await cc(off.origin, `/assets/${rel}`);
  check(got.body === IMAGE_ART[rel].toString(), "N — with the lane OFF the image's art serves");
  check((await cc(off.origin, `/assets/${rel}?v=${SHA}`)).cc === "no-cache", "N — and ?v still grants nothing for art (the fix is in the policy, not the lane)");
  check((await cc(off.origin, `/assets/${rel}?h=${h16(IMAGE_ART[rel])}`)).cc === "public, max-age=31536000, immutable", "N — ?h still grants a year");
  check((await fetch(off.origin + "/api/bundle")).status === 404, "N — the lane's endpoints do not exist");
  const base = await fetch(off.origin + "/api/bundle/artbase");
  check(base.ok, "N — but the art base is still published, so a publisher can always compute a delta");
}

console.log(bad ? `\nverify-artlane: ${bad} FAILURE(S)` : "\nverify-artlane: all arms pass");
process.exit(bad ? 1 : 0);
