#!/usr/bin/env node
// PUBLISH THE CLIENT BUNDLE to the store the running server reads
// (server/src/bundlestore.ts), so shipping client code needs no container build
// and no Cloud Run rollout.
//
// ORDER IS THE WHOLE SAFETY ARGUMENT, and it is the same order as the cache law
// in the root CLAUDE.md: every byte lands under a content-addressed name FIRST,
// the pointer flips LAST. Until the flip nothing serves the new generation; after
// it, every name it mentions is already readable. A publish interrupted at any
// point leaves production exactly as it was.
//
//   blob/<hash>               the bytes, addressed by content ONLY
//   gen/<id>/manifest.json    name -> hash, written AFTER every blob it names
//   pointer.json              { seq, current, retained[] }, written LAST
//
// BLOBS, NOT PER-GENERATION COPIES, for two reasons. A name must never be
// forgotten (bundlestore.ts law 4): a page from a generation the pointer has
// moved past still resolves its chunk, because the chunk is addressed by its
// hash and not by which generation happened to introduce it. And a file that
// did not change is stored ONCE, ever — so republishing a bundle whose workers
// and images are untouched uploads only what actually differs, which on this
// client is the entry chunk and index.html.
//
// THE GENERATION ID IS THE CONTENT, nothing else: no sha, no timestamp. Two
// builds of identical sources are the same generation, so a rebuild that
// changed nothing publishes nothing and cannot disturb an open page. This is
// also why the served document must carry no per-instance stamp — see LAW 1 in
// bundlestore.ts for the cache bug that pairing those two things creates.
//
// THE SEQ IS MONOTONIC and is what protects against a stale pointer read
// walking production backward (LAW 2). It is read from the current pointer and
// incremented, so it survives a publisher that does not keep state.
//
// RETENTION IS CURRENT + THE PREVIOUS TWO. A hashed name is content-addressed,
// so keeping it can only ever serve identical bytes, while dropping one 404s
// every page already open — measured once as holes through a live audition.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fastBuild } from "./fastbuild.mjs";
import { artBuild } from "./artbuild.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RETAIN = 2; // previous generations kept beside the current one
/** THE SAME CAPS THE SERVER ENFORCES (bundlestore.ts), checked here so a push
 *  too big for the lane fails at the runner instead of being published and then
 *  refused. Going over is not an error condition: it means the container lane
 *  carries that push, which it was doing anyway. */
const ART_FILES_MAX = Number(process.env.ART_FILES_MAX || 6000);
const ART_BYTES_MAX = Number(process.env.ART_BYTES_MAX || 64_000_000);
/** THE ONLY DIST-ROOT FILES THE LANE MAY PUBLISH, and the server's
 *  PUBLISHABLE_ROOT is the same list for the same reason: every OTHER
 *  dist-root file earns a one-year `immutable` from `?v=<GIT_SHA>` (measured
 *  live: /ui2/icon-map.webp?v=<sha>, /logo.webp?v=<sha>, /sw.js?v=<sha> all
 *  answer it, and the client stamps those URLs through withV), so publishing
 *  one would change bytes under a URL a browser has already frozen. These five
 *  are the art pipeline's output, fetched unstamped, and never frozen. */
const PUBLISHABLE_ROOT = new Set(["characters.json", "worlds.json", "monsters.json", "npcs.json", "shipset.json"]);
/** THE ART DOMAINS THE LANE MAY PUBLISH — `ART_LANE_DOMAINS` in
 *  server/src/bundlestore.ts states why wiki/ and live/ are not among them
 *  (release_notes.json is built from git history inside the image; live/** has
 *  its own no-redeploy channel; live/telemetry is .dockerignore-excluded). A
 *  path outside these is SKIPPED, not refused: wiki/release_notes.json differs
 *  on every single run, so refusing would kill the lane permanently, while
 *  skipping falls it through to the image — which is the right answer. */
const ART_LANE_DOMAINS = new Set(["characters2", "tiles", "maps2", "scenery", "sounds", "music", "monsters", "items", "lore"]);
const hashBytes = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

/** Local-directory store: the in-process backend, for tests and for a machine
 *  with no cloud credentials. A gs:// target is uploaded by the CI step. */
function localStore(root) {
  return {
    label: `local:${root}`,
    async get(p) {
      try {
        return readFileSync(join(root, p));
      } catch {
        return null;
      }
    },
    async put(p, bytes) {
      const full = join(root, p);
      mkdirSync(dirname(full), { recursive: true });
      // TEMP + RENAME, so a killed publish cannot leave a TRUNCATED object
      // under a content-addressed name. rename(2) is atomic within a
      // filesystem: the name either does not exist or holds all the bytes.
      const tmp = `${full}.tmp.${process.pid}`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, full);
    },
    async list(prefix) {
      try {
        return readdirSync(join(root, prefix));
      } catch {
        return [];
      }
    },
    async del(p) {
      try {
        rmSync(join(root, p), { recursive: true, force: true });
      } catch {
        /* a blob already gone is the state we wanted */
      }
    },
  };
}

/** PRUNE THE STORE TO THE WINDOW — and this is not housekeeping, it is what
 *  keeps the lane faster than the container it replaces.
 *
 *  Nothing ever deleted a blob. `git add` carries every blob ever published in
 *  the branch's HEAD TREE, and `git fetch --depth=1` materialises that whole
 *  tree on EVERY publish (depth bounds history, not the tree). Measured over 14
 *  days of `main`, the distinct art blobs the lane would have written come to
 *  86,952 objects and 1.50 GB — so within about a week the fetch alone costs
 *  more than the five minutes this lane exists to skip, and then the repository
 *  crosses GitHub's size limit.
 *
 *  WHAT IT KEEPS is exactly the documented guarantee and not a byte less: the
 *  window (current + `retained`, i.e. current + 2). A page loaded from a
 *  generation inside it keeps resolving every name it holds; beyond it a name
 *  answers a `no-store` 404, which is a coherent miss that reloads. It is also
 *  what a ROLLBACK needs — `retained[0]` is inside the window by construction,
 *  so its bytes are always still here.
 *
 *  AFTER the pointer write, never before: the new window is what decides, and a
 *  reader that still holds the old pointer either has its bytes already or
 *  reads incompletely and keeps serving what it has. */
async function pruneStore(store, pointer, imageOrigin) {
  if (!store.list || !store.del) return { blobs: 0, gens: 0, bytes: 0 };
  // THE POINTER'S WINDOW IS THE PUBLISHER'S LIST, AND IT IS NOT ENOUGH.
  // `retained` can name generations the running instance REFUSED — a corrupt
  // blob, a mixed fall-through, a cold start — so the generation it is ACTUALLY
  // SERVING can sit outside the window entirely. The server's own eviction
  // learned this the hard way and keeps the union of the window and what it
  // served; a prune that deleted on the window alone would take the bytes out
  // from under the live generation, and verify-fastlane arm M is the arm that
  // says so. So the server is ASKED.
  //
  // AND A FAILED READ PRUNES NOTHING — the same rule as the fall-through, for
  // the same reason: a delete decided from a guess is the one mistake here that
  // cannot be undone by the next publish. No origin (a test, a local run) means
  // no prune at all.
  const window = [pointer.current, ...(pointer.retained ?? [])].filter(Boolean);
  if (!imageOrigin) {
    console.log(`[prune] no image origin — pruning NOTHING (cannot ask what is being served)`);
    return { blobs: 0, gens: 0, bytes: 0, skipped: true };
  }
  try {
    const res = await fetch(`${imageOrigin.replace(/\/+$/, "")}/api/bundle`, { headers: { "cache-control": "no-store" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const live = await res.json();
    for (const id of [live.serving, ...(live.held ?? [])]) if (id && !window.includes(id)) window.push(id);
    console.log(`[prune] the server is serving ${live.serving || "the image"}; the keep set is ${window.length} generation(s)`);
  } catch (err) {
    console.log(`[prune] could not ask ${imageOrigin} what it is serving (${err.message}) — pruning NOTHING`);
    return { blobs: 0, gens: 0, bytes: 0, skipped: true };
  }
  const keepBlobs = new Set();
  for (const id of window) {
    const raw = await store.get(`gen/${id}/manifest.json`);
    if (!raw) {
      // A manifest inside the window that cannot be read means the keep set
      // would be WRONG, and a wrong keep set deletes bytes production needs.
      // Prune nothing rather than guess.
      console.log(`[prune] gen/${id}/manifest.json is unreadable — pruning NOTHING this run`);
      return { blobs: 0, gens: 0, bytes: 0, skipped: true };
    }
    const m = JSON.parse(raw.toString("utf8"));
    for (const map of [m.files, m.root, m.art]) for (const h of Object.values(map ?? {})) keepBlobs.add(h);
  }
  let blobs = 0;
  let bytes = 0;
  for (const name of await store.list("blob")) {
    if (keepBlobs.has(name)) continue;
    const had = await store.get(`blob/${name}`);
    bytes += had?.length ?? 0;
    await store.del(`blob/${name}`);
    blobs++;
  }
  let gens = 0;
  for (const id of await store.list("gen")) {
    if (window.includes(id)) continue;
    await store.del(`gen/${id}`);
    gens++;
  }
  console.log(
    `[prune] kept ${keepBlobs.size} blob(s) for ${window.length} generation(s) in the window; ` +
      `removed ${blobs} blob(s) (${(bytes / 1e6).toFixed(2)} MB) and ${gens} manifest(s)`,
  );
  return { blobs, gens, bytes };
}

/** READ THE POINTER, OR REFUSE. A pointer that exists and will not parse aborts
 *  whatever was about to happen. Treating it as "no pointer" restarts seq at 1,
 *  and LAW 2 (monotonic) then makes every running instance refuse every future
 *  publish until the seq climbs back past where it was — the lane silently dead
 *  for as many publishes as it takes. Refusing is loud, recoverable, and leaves
 *  production serving exactly what it serves now. Shared by the publish and the
 *  rollback so the law has one home. */
async function readPointer(store) {
  const raw = await store.get("pointer.json");
  if (!raw) return null;
  let prev;
  try {
    prev = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    throw new Error(
      `bundle store: pointer.json exists but does not parse (${String(e).slice(0, 120)}). ` +
        `REFUSING — writing a fresh pointer would reset seq to 1 and every running instance ` +
        `would then refuse this and every later generation. Repair or delete it first.`,
    );
  }
  if (typeof prev?.seq !== "number")
    throw new Error(`bundle store: pointer.json carries no numeric seq (${JSON.stringify(prev).slice(0, 120)}) — REFUSING, same reason.`);
  return prev;
}

/** ROLL BACK TO THE PREVIOUS GENERATION, or to the image when there is none.
 *
 *  What a red gate runs after the lane has already published. The window the
 *  publisher retains is exactly what makes this safe: `retained[0]` is the
 *  generation that was serving a moment ago, its blobs are still in the store
 *  (content-addressed names are never rewritten, root CLAUDE.md), and every
 *  page that has it cached keeps rendering.
 *
 *  It writes a pointer that is TRUE, never one that is convenient: the target's
 *  own git_sha and commit_ts come from its manifest. A generation published
 *  before manifests carried them cannot be rolled back to honestly, so this
 *  falls through to the image rather than inventing a stamp — LAW 6 orders the
 *  two lanes by exactly that field.
 *
 *  `current: ""` means SERVE THE IMAGE (bundlestore.ts). That is the floor, it
 *  is always safe, and it is what this does when there is no previous
 *  generation or no honest stamp for it.
 *
 *  The seq always advances, so a rollback is an ordinary forward step under
 *  LAW 2 and a later good publish simply supersedes it. */
export async function revertBundle({ store, dryRun = false }) {
  const prev = await readPointer(store);
  if (!prev) throw new Error("revert-bundle: there is no pointer to roll back from");

  const target = (prev.retained ?? [])[0] || "";
  let gitSha = "";
  let commitTs = 0;
  let why = "no previous generation is retained";

  if (target) {
    try {
      const raw = await store.get(`gen/${target}/manifest.json`);
      const man = JSON.parse(raw.toString());
      if (typeof man.git_sha === "string" && man.git_sha && typeof man.commit_ts === "number" && man.commit_ts > 0) {
        gitSha = man.git_sha;
        commitTs = man.commit_ts;
        why = "";
      } else {
        why = `${target} predates self-stamped manifests, so its commit time cannot be known`;
      }
    } catch (err) {
      why = `${target}'s manifest could not be read (${err.message})`;
    }
  }

  const toImage = !gitSha;
  const next = {
    seq: prev.seq + 1,
    current: toImage ? "" : target,
    retained: toImage ? [] : (prev.retained ?? []).slice(1),
    updated_at: new Date().toISOString(),
    git_sha: gitSha,
    commit_ts: commitTs,
  };
  const to = toImage ? `THE IMAGE (${why})` : `${target} (${gitSha.slice(0, 10)})`;
  console.log(`[revert] ${prev.current || "the image"} -> ${to}, seq ${prev.seq} -> ${next.seq}`);
  if (dryRun) return { ...next, rolledBackFrom: prev.current, dryRun: true };
  await store.put("pointer.json", Buffer.from(JSON.stringify(next, null, 1)));
  // NO PRUNE ON A ROLLBACK, deliberately. A rollback is the moment the window
  // matters most and the moment least is known about what a running instance
  // is mid-way through reading; the next ordinary publish prunes.
  return { ...next, rolledBackFrom: prev.current };
}

/** Read one JSON document from the running image, or FAIL THE PUBLISH.
 *
 *  Never a fallback to something computed locally. That was the first cut of
 *  the dist-root fall-through and it refused every generation for a day, because
 *  a runner cannot reproduce what the image serves by guessing — the image is
 *  the only authority on the image. A failed read here simply means this push
 *  goes by container, which is the lane it used to take anyway. */
async function askTheImage(imageOrigin, path, what) {
  const url = `${imageOrigin.replace(/\/+$/, "")}${path}`;
  try {
    const res = await fetch(url, { headers: { "cache-control": "no-store" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    if (!doc || typeof doc !== "object") throw new Error("not an object");
    return doc;
  } catch (err) {
    throw new Error(
      `publish-bundle: could not read what the image serves — ${what} (${url}: ${err.message}). ` +
        `Refusing to publish a generation whose fall-through set would be a guess.`,
    );
  }
}

export async function publishBundle({
  store,
  outDir,
  gitSha = "dev",
  commitTs = 0,
  dryRun = false,
  imageOrigin = "",
  artRoot = "",
  /** An ALREADY-CURATED art root ({root, files, count}), for a caller that has
   *  run artbuild itself — the gate uses it with a three-file tree so it can
   *  exercise the delta, the caps and the admission checks in a second instead
   *  of curating 272 MB. `artRoot` is the ordinary path: curate, then publish. */
  art: prebuilt = null,
}) {
  const t0 = performance.now();
  // THE ART LANE'S FIRST STEP, when there is one: reproduce the curated art
  // root the image serves, which is also what regenerates client/public's
  // catalogs — so fastBuild's public/ copy picks up the CURATED versions and
  // does not need to run manifest.mjs itself against the wrong root.
  const art = prebuilt || (artRoot ? await artBuild({ root: artRoot }) : null);
  const built = await fastBuild({ outDir, gitSha, manifest: !art });

  // Collect the files: index.html plus assets/. Names must be content-hashed
  // (fastbuild refuses otherwise) — index.html is the one mutable-by-nature
  // document, and it is addressed by the GENERATION, never by its own name.
  const files = {};
  const bytesOf = {};
  const add = (name, full) => {
    const b = readFileSync(full);
    bytesOf[name] = b;
    files[name] = hashBytes(b);
  };
  add("index.html", join(outDir, "index.html"));
  for (const n of readdirSync(join(outDir, "assets"), { recursive: true })) {
    const rel = String(n).split(sep).join("/");
    const full = join(outDir, "assets", rel);
    if (statSync(full).isFile()) add(`assets/${rel}`, full);
  }

  // THE FALL-THROUGH SET, AND WHY IT IS IN THE MANIFEST.
  //
  // A generation carries index.html + assets/ and NOTHING ELSE. The dist root
  // also holds what client/public contributes — measured 12 entries and 4.6 MB
  // on this client (monsters.json 885 KB, npcs.json 765 KB, ui2/, icons/,
  // sw.js, the webmanifest, several catalogs) — and those are answered by the
  // IMAGE. That is deliberate: they are art-derived and belong to the
  // container lane, which is the only lane allowed to change bytes that the
  // ?v=<GIT_SHA> grant freezes.
  //
  // But "the workflow's path filter keeps them in step" is a convention, and a
  // convention is not a guarantee: widen that filter one day and the lane
  // ships new code against the image's OLD catalogs — a mixed generation, the
  // exact bug this design exists to make impossible. So the generation records
  // the hashes of every file it is NOT publishing, and the server refuses any
  // generation whose fall-through hashes disagree with the bytes it would
  // actually serve (bundlestore.ts, verifyFallthrough).
  //
  // WHERE THOSE HASHES COME FROM, AND WHY NOT FROM THIS TREE. Hashing the
  // runner's own dist root was the first cut and it refused every generation
  // ever published, which is why the lane had never served one (measured
  // 2026-09-19 on generation 34cb856184e86f51: monsters.json differed from the
  // image's and shipset.json was absent altogether, 42 entries against 43).
  // The image's client/public is the OUTPUT of the art-curation pipeline —
  // the Dockerfile runs `shipset.mjs --write` against the full art tree and the
  // manifest step against that CURATED root — so a runner that only runs
  // manifest.mjs over a plain checkout cannot reproduce it, and should not try:
  // reproducing it IS the five minutes this lane exists to skip. The image is
  // the only authority on what the image serves, so ask it
  // (/api/bundle/fallthrough) and record THAT. The recorded set becomes true
  // instead of a guess taken from the wrong tree.
  //
  // The guarantee this keeps: a generation is served ONLY by an image whose
  // dist root is byte-identical to the one it was published against — change
  // any of those files and every generation pinned to the old bytes is refused,
  // which is the mixed-generation hole closed. What it does NOT claim: that the
  // bundle was BUILT against those catalogs. That needs the art pipeline, and
  // pretending otherwise would be the more dangerous lie.
  //
  // A FAILED READ IS A FAILED PUBLISH. Falling back to the local walk would
  // silently restore the bug that refused every generation for a day, so it
  // throws instead; the lane simply does not publish, and the container ships.
  // THE DIST ROOT IS PARTITIONED: `root` is what this generation PUBLISHES,
  // `fallthrough` is what it PINS to the image. Before the art lane the first
  // half was always empty — a generation carried index.html + assets/ and the
  // 43 `public/` files were the image's, full stop. The art lane changes that
  // for exactly the five GENERATED catalogs (characters.json, worlds.json,
  // monsters.json, npcs.json, shipset.json), because those are the art
  // pipeline's OUTPUT and must travel with the art that produced them: publish
  // new monster art without monsters.json and the monster is invisible; publish
  // the catalog without the art and it 404s.
  //
  // Everything else in the dist root stays pinned, and pinning is what makes
  // the mixed generation unrepresentable: the server refuses any generation
  // whose pinned hashes disagree with the bytes it would actually serve, and
  // (since the overlay exists) any generation that leaves a dist-root file
  // named by NEITHER map.
  //
  // WHERE THE HASHES COME FROM, AND WHY NOT FROM THIS TREE. Hashing the
  // runner's own dist root was the first cut and it refused every generation
  // ever published (measured 2026-09-19 on 34cb856184e86f51: monsters.json
  // differed and shipset.json was absent, 42 entries against 43). The image is
  // the only authority on what the image serves, so it is asked. What the ART
  // lane adds is that the runner can now legitimately REPRODUCE those catalogs
  // — artbuild.mjs runs the Dockerfile's curation in the Dockerfile's order and
  // reproduces production's four manifests byte for byte — so it publishes the
  // ones that differ instead of pinning a stale hash.
  let fallthrough = {};
  let root = {};
  let artFiles = {};
  let artBytes = 0;

  // The runner's own dist root, hashed: index.html and assets/ belong to the
  // generation, everything else is a candidate for `root`.
  const localRoot = {};
  {
    const walk = (dir, prefix) => {
      for (const n of readdirSync(dir)) {
        const full = join(dir, n);
        const rel = prefix ? `${prefix}/${n}` : n;
        if (statSync(full).isDirectory()) {
          if (rel !== "assets") walk(full, rel);
          continue;
        }
        if (rel === "index.html") continue;
        localRoot[rel] = hashBytes(readFileSync(full));
      }
    };
    walk(outDir, "");
  }

  if (imageOrigin) {
    const doc = await askTheImage(imageOrigin, "/api/bundle/fallthrough", "the dist root it serves");
    if (typeof doc.files !== "object" || !doc.files || !Object.keys(doc.files).length)
      throw new Error(`publish-bundle: ${imageOrigin} answered no fall-through files; refusing to publish.`);
    const imageRoot = doc.files;
    if (art) {
      // The art lane: publish what differs, pin the rest AT THE IMAGE'S HASH.
      const cannot = [];
      for (const [rel, h] of Object.entries(localRoot)) {
        if (imageRoot[rel] === h) continue;
        if (PUBLISHABLE_ROOT.has(rel)) root[rel] = h;
        else cannot.push(rel);
      }
      // A DIST-ROOT FILE THIS LANE CANNOT EXPRESS STOPS THE PUBLISH. Pinning
      // the image's hash instead would serve the OLD file beside the new
      // bundle — new code against an icon it may have renamed, which is the
      // mixed generation this whole mechanism exists to prevent. The container
      // lane is already building this push; it carries it.
      if (cannot.length)
        throw new Error(
          `publish-bundle: ${cannot.length} dist-root file(s) differ from the image and are not ones the lane may ` +
            `publish (${cannot.slice(0, 4).join(", ")}). Every dist-root file outside the generated catalogs earns a ` +
            `one-year grant from ?v=<GIT_SHA>, so changing its bytes on a running instance is unrecallable. ` +
            `The container lane carries this push.`,
        );
      for (const [rel, h] of Object.entries(imageRoot)) if (!(rel in root)) fallthrough[rel] = h;
    } else {
      // The client lane, unchanged: the generation publishes none of the dist
      // root and pins all of it.
      fallthrough = imageRoot;
    }
    console.log(
      `[publish] dist root: ${Object.keys(root).length} published, ${Object.keys(fallthrough).length} pinned to the image at ${imageOrigin}`,
    );
  } else {
    // No origin given (tests, a local dry run): pin this tree. Correct for a
    // fixture, and NEVER what production uses — see above.
    fallthrough = localRoot;
  }

  // THE ART DELTA — every curated file whose bytes differ from the ones the
  // image serves, plus every one the image does not have at all.
  //
  // Computed against /api/bundle/artbase, which is the IMAGE's own index, NOT
  // /asset-index.json — that document is the MERGED one and already carries a
  // live generation's overlay, so a delta taken from it would be a delta
  // against the overlay and this generation would silently drop every file the
  // previous one published. A generation is a COMPLETE description of what
  // sits on top of the image.
  //
  // There is no removal list, deliberately, and it is the same fail-safe
  // direction shipset.mjs states: shipping a spare file wastes bytes, dropping
  // a reachable one 404s in production. A file deleted from the tree keeps
  // being served from the image until the container lands minutes later, and
  // nothing asks for it — it left the catalogs and the index in the same
  // commit. A removal list computed wrong, by contrast, 404s live art.
  if (art) {
    if (!imageOrigin) throw new Error("publish-bundle: --art needs an image origin to compute the delta against");
    const base = await askTheImage(imageOrigin, "/api/bundle/artbase", "the art it serves");
    if (typeof base.files !== "object" || !base.files || !Object.keys(base.files).length)
      throw new Error(
        `publish-bundle: ${imageOrigin} named no art base. An image built before the art lane does not expose one — ` +
          `the container lane carries this push.`,
      );
    let skipped = 0;
    for (const [rel, h] of Object.entries(art.files)) {
      if (base.files[rel] === h) continue;
      if (!ART_LANE_DOMAINS.has(rel.slice(0, rel.indexOf("/")))) {
        skipped++;
        continue;
      }
      artFiles[rel] = h;
    }
    if (skipped) console.log(`[publish] ${skipped} changed path(s) outside the lane's domains fall through to the image`);
    // NEW PATHS SAID OUT LOUD. A path the image's base does not name is either
    // genuinely new art — the ordinary case — or a stowaway the image's build
    // context excludes and a runner's checkout does not (artbuild's
    // `.dockerignore` read exists for exactly that, and 11.73 MB of it was
    // real). Printing them is what makes a stowaway loud instead of a silent
    // 11 MB of every payload forever.
    const added = Object.keys(artFiles).filter((rel) => !(rel in base.files));
    if (added.length)
      console.log(
        `[publish] ${added.length} of them are NEW (absent from the image's base): ${added.slice(0, 6).join(", ")}` +
          (added.length > 6 ? ` … +${added.length - 6}` : ""),
      );
    for (const rel of Object.keys(artFiles)) artBytes += statSync(join(art.root, rel)).size;
    const n = Object.keys(artFiles).length;
    console.log(
      `[publish] art delta: ${n} of ${art.count} file(s), ${(artBytes / 1e6).toFixed(2)} MB, ` +
        `against the image's ${Object.keys(base.files).length}-file base`,
    );
    // THE CAPS, HERE RATHER THAN AFTER THE UPLOAD. Over either one the lane
    // stands down and the container carries that push — which it is already
    // building, so nothing is lost but the seconds.
    if (n + Object.keys(root).length > ART_FILES_MAX || artBytes > ART_BYTES_MAX) {
      throw new Error(
        `publish-bundle: this push overlays ${n + Object.keys(root).length} file(s) / ` +
          `${(artBytes / 1e6).toFixed(1)} MB, over the lane's cap (${ART_FILES_MAX} files / ` +
          `${(ART_BYTES_MAX / 1e6).toFixed(0)} MB). The container lane carries it.`,
      );
    }
    if (!n && !Object.keys(root).length)
      console.log(`[publish] the image already serves this art — the generation carries the bundle alone`);
  }

  // An invariant, not a hope: the image's map excludes assets/ and index.html
  // by construction, so a generation's own files can never appear in it. If one
  // ever does, the two sides disagree about who owns a path and the generation
  // must not be written.
  {
    const overlap = Object.keys(files).filter((n) => n in fallthrough || n in root);
    if (overlap.length)
      throw new Error(
        `publish-bundle: ${overlap.length} path(s) are claimed by BOTH the bundle and the dist root ` +
          `(${overlap.slice(0, 3).join(", ")}); refusing to publish.`,
      );
    const both = Object.keys(root).filter((n) => n in fallthrough);
    if (both.length)
      throw new Error(
        `publish-bundle: ${both.length} dist-root path(s) are both published and pinned (${both.slice(0, 3).join(", ")}); refusing.`,
      );
  }

  // THE GENERATION ID IS EVERYTHING IT SERVES. It used to be the bundle alone,
  // which was right while the bundle was all a generation carried — with an
  // overlay it would make two art publishes of one bundle the SAME id, so the
  // second would report "already current" and publish nothing while the art sat
  // on the runner. Art and dist root are folded in under their own headings so
  // a path can never be mistaken for a different one in another space.
  const idInput = [
    ...Object.keys(files).sort().map((n) => `f\0${n}\0${files[n]}`),
    ...Object.keys(root).sort().map((n) => `r\0${n}\0${root[n]}`),
    ...Object.keys(artFiles).sort().map((n) => `a\0${n}\0${artFiles[n]}`),
  ].join("\n");
  const id = createHash("sha256").update(idInput).digest("hex").slice(0, 16);

  const prev = await readPointer(store); // see readPointer: an unparseable pointer aborts
  if (prev?.current === id) {
    console.log(`[publish] generation ${id} is already current — nothing to publish (${built.ms} ms build)`);
    return { id, published: false, alreadyCurrent: true, ms: Math.round(performance.now() - t0), seq: prev.seq };
  }

  const retained = [prev?.current, ...(prev?.retained ?? [])].filter(Boolean).slice(0, RETAIN);
  const pointer = {
    seq: (prev?.seq ?? 0) + 1,
    current: id,
    retained,
    updated_at: new Date().toISOString(),
    git_sha: gitSha,
    // THE ORDER OF THE TWO LANES. The server refuses a generation published
    // from a commit at or before the image it would fall through to, so a
    // container rollout can never be overridden by an older client and a bad
    // publish is undone by the next deploy. 0 means "unknown", which the
    // server treats as unordered and adopts on seq alone (local runs, tests).
    commit_ts: Number(commitTs) || 0,
  };

  if (dryRun) {
    console.log(
      `[publish] DRY RUN — would publish ${id}: ${Object.keys(files).length} bundle file(s), ` +
        `${Object.keys(artFiles).length} art, ${Object.keys(root).length} dist-root, ${Object.keys(fallthrough).length} pinned, seq ${pointer.seq}`,
    );
    return { id, published: false, dryRun: true, alreadyCurrent: true, ms: Math.round(performance.now() - t0), seq: pointer.seq, pointer };
  }

  // 1) every byte, under its hash — and only the ones not already there.
  // READ LAZILY for the overlay: the bundle is 2.5 MB and is already in hand,
  // but an art delta can be tens of megabytes and there is no reason for the
  // publisher to hold it all at once when a blob that is already in the store
  // is never read at all.
  const uploads = [
    ...Object.entries(files).map(([name, h]) => [name, h, () => bytesOf[name]]),
    ...Object.entries(root).map(([name, h]) => [name, h, () => readFileSync(join(outDir, name))]),
    ...Object.entries(artFiles).map(([name, h]) => [name, h, () => readFileSync(join(art.root, name))]),
  ];
  let sent = 0;
  let skipped = 0;
  for (const [name, h, read] of uploads) {
    // A PRESENCE TEST IS NOT AN INTEGRITY TEST. `blob/<h>` existing does not
    // mean it holds the bytes that hash to h: an interrupted put leaves a
    // truncated object under a name no later publish would ever rewrite, and
    // the server re-hashes on load — so EVERY generation naming it is refused
    // forever while the publisher keeps printing success and exiting 0.
    // Measured: one 0-byte WORKER blob took the whole lane down, including
    // generations published before the truncation, because blobs are shared.
    const have = await store.get(`blob/${h}`);
    if (have && hashBytes(have) === h) { skipped++; continue; }
    if (have) console.log(`[publish] blob/${h} is ${have.length} B and does not hash to its name — re-uploading`);
    const bytes = read();
    // THE HASH IS RE-DERIVED FROM THE BYTES BEING SENT, never trusted from the
    // index that named them. artbuild hashed the curated root a few seconds
    // ago; if anything has touched a file since, the store would hold bytes
    // under a name they do not hash to and the server would refuse every
    // generation naming it, FOREVER, because blobs are shared. Measured once:
    // one 0-byte worker blob took the whole lane down.
    const real = hashBytes(bytes);
    if (real !== h)
      throw new Error(
        `publish-bundle: ${name} hashes ${real} but was recorded as ${h} — the tree changed under the publish; refusing.`,
      );
    await store.put(`blob/${h}`, bytes);
    sent += bytes.length;
  }
  // 2) the manifest, which is what makes the generation readable at all
  // THE GENERATION RECORDS ITS OWN IDENTITY. The pointer stamps only the
  // CURRENT generation, so stepping back off it used to lose the git_sha and
  // commit_ts the replacement pointer needs — a rollback could only guess, and
  // a guessed commit_ts is the one field LAW 6 orders the two lanes by. With
  // it here, `revertBundle` reads the target's own stamp and writes a pointer
  // that is true.
  const manifest = { files, git_sha: gitSha, commit_ts: commitTs, fallthrough };
  if (Object.keys(root).length) manifest.root = root;
  if (Object.keys(artFiles).length) manifest.art = artFiles;
  // THE OVERLAY'S WEIGHT, so the server can refuse an over-cap generation
  // BEFORE downloading 64 MB of it. Never the cap itself — the server's running
  // total during the fetch is, because a cap that trusts the payload it is
  // protecting against is not a cap.
  if (artBytes) manifest.art_bytes = artBytes;
  await store.put(`gen/${id}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 1)));
  // 3) and only now the pointer
  await store.put("pointer.json", Buffer.from(JSON.stringify(pointer, null, 1)));
  // 4) and only after THAT, drop what the new window does not name.
  await pruneStore(store, pointer, imageOrigin);

  const ms = Math.round(performance.now() - t0);
  const over = Object.keys(artFiles).length + Object.keys(root).length;
  console.log(
    `[publish] ${id} seq ${pointer.seq}: ${Object.keys(files).length} bundle file(s)` +
      (over ? ` + ${Object.keys(artFiles).length} art + ${Object.keys(root).length} dist-root` : "") +
      `, ${(sent / 1e6).toFixed(2)} MB, built in ${built.ms} ms` +
      (art?.ms ? ` (art curated in ${art.ms} ms)` : "") +
      `, published in ${ms} ms -> ${store.label}` +
      (skipped ? `; ${skipped} blob(s) already present, not re-uploaded` : ""),
  );
  if (retained.length) console.log(`[publish] retaining ${retained.join(", ")}`);
  return { id, published: true, ms, seq: pointer.seq, bytes: sent, files: Object.keys(files).length, pointer };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = arg("store", process.env.BUNDLE_STORE || "");
  if (!target) {
    console.error("usage: publish-bundle.mjs --store <dir> [--sha <sha>] [--commit-ts <epoch>] [--image-origin <url>] [--art <curated root>] [--dry-run]\n   or: publish-bundle.mjs --store <dir> --revert   (roll back to the previous generation, or to the image)");
    process.exit(2);
  }
  if (target.startsWith("gs://")) {
    console.error("publish-bundle: the gs:// uploader is the CI step's job (it holds the credentials); pass a directory here");
    process.exit(2);
  }
  // --revert: what a red gate runs after the lane has already published. It
  // builds nothing and needs no origin — it only rewrites the pointer.
  if (process.argv.includes("--revert")) {
    const back = await revertBundle({ store: localStore(target), dryRun: process.argv.includes("--dry-run") });
    console.log(`[revert] pointer now seq ${back.seq}, current ${back.current || "(the image)"}`);
    process.exit(0); // a top-level `if` block, not a function — there is nothing to return from
  }
  // NOT client/dist BY DEFAULT. Building into the image's own directory leaves
  // an esbuild bundle there that clientdist.mjs's freshness guard then declares
  // up to date, so every later gate silently grades the fast bundle instead of
  // the vite one it means to test. A publish is a store operation; it gets its
  // own scratch directory unless told otherwise.
  const r = await publishBundle({
    store: localStore(target),
    outDir: arg("out", mkdtempSync(join(tmpdir(), "publish-bundle-"))),
    gitSha: arg("sha", process.env.GIT_SHA || "dev"),
    commitTs: Number(arg("commit-ts", process.env.GIT_COMMIT_TS || 0)) || 0,
    // The running game is the authority on its own dist root. Overridable for a
    // staging origin; "" falls back to hashing this tree, which only a fixture wants.
    imageOrigin: arg("image-origin", process.env.IMAGE_ORIGIN || "https://nangijala.online"),
    // THE ART LANE. A directory to build the curated art root into; absent, the
    // publish carries the bundle alone exactly as it always has. It is a
    // scratch path and never a tree anyone keeps: artbuild hardlinks 43,117
    // files into it and ship-tiles3 copies 7,570 more.
    artRoot: arg("art", process.env.ART_ROOT || ""),
    dryRun: process.argv.includes("--dry-run"),
  });
  // An honest exit code: `r.id` is always truthy, so the old expression was a
  // constant 0 and CI could not tell a publish from a failure.
  process.exit(r.published || r.alreadyCurrent ? 0 : 1);
}

export { localStore };
