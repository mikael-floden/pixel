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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fastBuild } from "./fastbuild.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RETAIN = 2; // previous generations kept beside the current one
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
  };
}

export async function publishBundle({ store, outDir, gitSha = "dev", commitTs = 0, dryRun = false }) {
  const t0 = performance.now();
  const built = await fastBuild({ outDir, gitSha });

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
  // exact bug this design exists to make impossible. So the publisher HASHES
  // every file it is not publishing and records it here, and the server
  // refuses any generation whose fall-through hashes disagree with the bytes
  // it would actually serve (bundlestore.ts, verifyFallthrough). The hole is
  // closed by arithmetic instead of by everyone remembering.
  const fallthrough = {};
  const walk = (dir, prefix) => {
    for (const n of readdirSync(dir)) {
      const full = join(dir, n);
      const rel = prefix ? `${prefix}/${n}` : n;
      if (statSync(full).isDirectory()) {
        if (rel !== "assets") walk(full, rel);
        continue;
      }
      if (rel === "index.html") continue;
      fallthrough[rel] = hashBytes(readFileSync(full));
    }
  };
  walk(outDir, "");

  const id = createHash("sha256")
    .update(Object.keys(files).sort().map((n) => `${n}\0${files[n]}`).join("\n"))
    .digest("hex")
    .slice(0, 16);

  const prevRaw = await store.get("pointer.json");
  let prev = null;
  if (prevRaw) {
    // A POINTER THAT EXISTS AND WILL NOT PARSE ABORTS THE PUBLISH. Treating it
    // as "no pointer" restarts seq at 1, and LAW 2 (monotonic) then makes every
    // running instance refuse every future publish until the seq climbs back
    // past where it was — the lane silently dead for as many publishes as it
    // takes. Refusing to publish is loud, recoverable, and leaves production
    // serving exactly what it serves now.
    try {
      prev = JSON.parse(prevRaw.toString("utf8"));
    } catch (e) {
      throw new Error(
        `publish: pointer.json exists but does not parse (${String(e).slice(0, 120)}). ` +
          `REFUSING to publish — writing a fresh pointer would reset seq to 1 and every running ` +
          `instance would then refuse this and every later generation. Repair or delete it first.`,
      );
    }
    if (typeof prev?.seq !== "number") {
      throw new Error(`publish: pointer.json carries no numeric seq (${JSON.stringify(prev).slice(0, 120)}) — REFUSING, same reason.`);
    }
  }
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
    console.log(`[publish] DRY RUN — would publish ${id} (${Object.keys(files).length} files), seq ${pointer.seq}`);
    return { id, published: false, dryRun: true, alreadyCurrent: true, ms: Math.round(performance.now() - t0), seq: pointer.seq, pointer };
  }

  // 1) every byte, under its hash — and only the ones not already there
  let sent = 0;
  let skipped = 0;
  for (const [name, bytes] of Object.entries(bytesOf)) {
    const h = files[name];
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
    await store.put(`blob/${h}`, bytes);
    sent += bytes.length;
  }
  // 2) the manifest, which is what makes the generation readable at all
  await store.put(`gen/${id}/manifest.json`, Buffer.from(JSON.stringify({ files, fallthrough }, null, 1)));
  // 3) and only now the pointer
  await store.put("pointer.json", Buffer.from(JSON.stringify(pointer, null, 1)));

  const ms = Math.round(performance.now() - t0);
  console.log(
    `[publish] ${id} seq ${pointer.seq}: ${Object.keys(files).length} files, ${(sent / 1e6).toFixed(2)} MB, ` +
      `built in ${built.ms} ms, published in ${ms} ms -> ${store.label}` +
      (skipped ? `; ${skipped} blob(s) already present, not re-uploaded` : ""),
  );
  if (retained.length) console.log(`[publish] retaining ${retained.join(", ")}`);
  return { id, published: true, ms, seq: pointer.seq, bytes: sent, files: Object.keys(files).length, pointer };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = arg("store", process.env.BUNDLE_STORE || "");
  if (!target) {
    console.error("usage: publish-bundle.mjs --store <dir|gs://bucket[/prefix]> [--sha <sha>] [--commit-ts <epoch>] [--dry-run]");
    process.exit(2);
  }
  if (target.startsWith("gs://")) {
    console.error("publish-bundle: the gs:// uploader is the CI step's job (it holds the credentials); pass a directory here");
    process.exit(2);
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
    dryRun: process.argv.includes("--dry-run"),
  });
  // An honest exit code: `r.id` is always truthy, so the old expression was a
  // constant 0 and CI could not tell a publish from a failure.
  process.exit(r.published || r.alreadyCurrent ? 0 : 1);
}

export { localStore };
