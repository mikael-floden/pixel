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
import { mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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
      writeFileSync(full, bytes);
    },
  };
}

export async function publishBundle({ store, outDir, gitSha = "dev", dryRun = false }) {
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
  for (const n of readdirSync(join(outDir, "assets"))) {
    const full = join(outDir, "assets", n);
    if (statSync(full).isFile()) add(`assets/${n}`, full);
  }

  const id = createHash("sha256")
    .update(Object.keys(files).sort().map((n) => `${n}\0${files[n]}`).join("\n"))
    .digest("hex")
    .slice(0, 16);

  const prevRaw = await store.get("pointer.json");
  let prev = null;
  try {
    prev = prevRaw ? JSON.parse(prevRaw.toString("utf8")) : null;
  } catch {
    prev = null; // an unreadable pointer is replaced, not trusted
  }
  if (prev?.current === id) {
    console.log(`[publish] generation ${id} is already current — nothing to publish (${built.ms} ms build)`);
    return { id, published: false, ms: Math.round(performance.now() - t0), seq: prev.seq };
  }

  const retained = [prev?.current, ...(prev?.retained ?? [])].filter(Boolean).slice(0, RETAIN);
  const pointer = {
    seq: (prev?.seq ?? 0) + 1,
    current: id,
    retained,
    updated_at: new Date().toISOString(),
    git_sha: gitSha,
  };

  if (dryRun) {
    console.log(`[publish] DRY RUN — would publish ${id} (${Object.keys(files).length} files), seq ${pointer.seq}`);
    return { id, published: false, ms: Math.round(performance.now() - t0), seq: pointer.seq, pointer };
  }

  // 1) every byte, under its hash — and only the ones not already there
  let sent = 0;
  let skipped = 0;
  for (const [name, bytes] of Object.entries(bytesOf)) {
    const h = files[name];
    if (await store.get(`blob/${h}`)) { skipped++; continue; }
    await store.put(`blob/${h}`, bytes);
    sent += bytes.length;
  }
  // 2) the manifest, which is what makes the generation readable at all
  await store.put(`gen/${id}/manifest.json`, Buffer.from(JSON.stringify({ files }, null, 1)));
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
    console.error("usage: publish-bundle.mjs --store <dir|gs://bucket[/prefix]> [--sha <sha>] [--dry-run]");
    process.exit(2);
  }
  if (target.startsWith("gs://")) {
    console.error("publish-bundle: the gs:// uploader is the CI step's job (it holds the credentials); pass a directory here");
    process.exit(2);
  }
  const r = await publishBundle({
    store: localStore(target),
    outDir: arg("out", join(ROOT, "client", "dist")),
    gitSha: arg("sha", process.env.GIT_SHA || "dev"),
    dryRun: process.argv.includes("--dry-run"),
  });
  process.exit(r.published || r.id ? 0 : 1);
}

export { localStore };
