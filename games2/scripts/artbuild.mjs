#!/usr/bin/env node
// THE ART BUILD — reproduce, on a runner, the art root the IMAGE serves, so an
// art push can be published to the running server instead of waiting for a
// container (docs/fast-lane.md, "the art lane").
//
// It is the Dockerfile's curation, in the Dockerfile's order, and that order is
// the whole point: run it any other way and you get a root that LOOKS right and
// is not.
//
//   1. shipset.mjs --emit <root> --write   ASSETS_ROOT = THE FULL TREE
//        the publication closure: 43,117 of 88,000 files, 246 MB of 496 MB.
//        Hardlinks, so it is I/O-free — measured 2.6 s. `--write` also emits
//        client/public/shipset.json, which the image copies in.
//   2. manifest.mjs                        ASSETS_ROOT = THE CURATED ROOT
//        the four catalogs. THIS IS THE STEP WITH THE TRAP: run it against a
//        plain checkout and monsters.json/npcs.json differ from what the image
//        serves, because the image builds them from the CURATED root — which is
//        exactly the mismatch that made the client lane refuse every generation
//        for a day. Measured against the curated root it reproduces
//        production's characters.json, monsters.json, npcs.json and worlds.json
//        BYTE FOR BYTE (npcs.json 8fc7205ae6daf870, against a COMMITTED
//        npcs.json of 62fde8b7e644b032 — the committed copy is not what ships).
//   3. ship-tiles3.ts --root <tree> --out <root>
//        the tiles3 closure the resolver proves it needs: 1,930 art files + the
//        live-tuning pools. A pure copyFileSync, no transform. Measured 5.0 s.
//   4. hash every file of the finished root
//        50,121 files, 272 MB. Measured 1.2 s single-threaded on a warm page
//        cache and 23.4 s cold — the difference is I/O latency, not sha256, so
//        it is hashed on a small pool of worker threads.
//
// WHAT IS NOT REPRODUCIBLE, and how it is handled: shipset.json carries a
// `generatedAt` timestamp, so its bytes differ on every run. The art lane
// therefore PUBLISHES that file rather than pinning it — a file whose bytes
// cannot be predicted must never be something a generation's admission depends
// on.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const GAMES2 = join(dirname(fileURLToPath(import.meta.url)), "..");
const hashOf = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

// THE WORKER HALF. Same file, so there is one thing to read and nothing to keep
// in step; `isMainThread` is false only inside a Worker this module started.
if (!isMainThread && workerData?.artbuildHash) {
  const { paths, root } = workerData;
  const out = {};
  for (const p of paths) {
    try {
      out[relative(root, p).split(sep).join("/")] = hashOf(readFileSync(p));
    } catch {
      /* a file that vanished mid-walk is reported as absent, not as a crash */
    }
  }
  parentPort.postMessage(out);
}

function run(label, cmd, args, env) {
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { cwd: GAMES2, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  const ms = Math.round(performance.now() - t0);
  if (r.status !== 0) {
    throw new Error(
      `artbuild: ${label} failed (${r.status})\n${(r.stdout ?? "").toString().slice(-1500)}\n${(r.stderr ?? "").toString().slice(-1500)}`,
    );
  }
  console.log(`[artbuild] ${label} ${ms} ms`);
  return ms;
}

/** THE PATHS THE IMAGE'S BUILD CONTEXT NEVER SEES.
 *
 *  `.dockerignore` decides what reaches the DEPLOYED GAME (root CLAUDE.md), and
 *  it filters the DOCKER BUILD CONTEXT — not a git checkout. So shipset on a
 *  runner resolves a closure that is a strict SUPERSET of the image's: measured
 *  11.73 MB in two files, `maps2/worlds3/the_game/overview_full.webp` (10.95 MB,
 *  excluded by `.dockerignore`, included by the ship-set) and
 *  `live/telemetry/perf.json` (0.78 MB, and already outside the lane's
 *  domains). Published, those are 11 MB of the 64 MB cap on EVERY art push
 *  forever — they never appear in the image's base, so they are always "new" —
 *  and they would make a file the image is deliberately built WITHOUT fetchable
 *  from the running game.
 *
 *  So the lane reads `.dockerignore` rather than keeping a second list, because
 *  a second list is a thing that drifts. Docker's own semantics: `*` does not
 *  cross `/`, `**` does, a directory prefix excludes its whole subtree, and a
 *  `!` line re-includes. The bare `*` that opens the file is the "exclude
 *  everything, then re-include the domains" idiom and says nothing about what
 *  is dropped from INSIDE a re-included domain, so it is skipped here. */
export function dockerExcluded(dockerignore) {
  // DOCKER'S OWN SEMANTICS, and the important one is that THE LAST MATCHING
  // RULE WINS. That is what makes the file's own idiom work — `*` excludes
  // everything, `!tiles` brings a domain back, `music/**/*.wav` drops something
  // from inside it — and a matcher that instead asked "does any exclude match
  // and no re-include" gets every one of those wrong. `*` does not cross `/`;
  // `**` does; a pattern also matches everything under it.
  const rules = [];
  for (const raw of dockerignore.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const neg = line.startsWith("!");
    const p = neg ? line.slice(1) : line;
    let out = "";
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === "*") {
        if (p[i + 1] === "*") {
          i++;
          if (p[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
        } else out += "[^/]*";
      } else if ("\\^$.|?+()[]{}".includes(c)) out += "\\" + c;
      else out += c;
    }
    rules.push({ re: new RegExp(`^${out}(?:/.*)?$`), neg });
  }
  return (rel) => {
    let excluded = false;
    for (const r of rules) if (r.re.test(rel)) excluded = !r.neg;
    return excluded;
  };
}

function walk(root) {
  const out = [];
  const rec = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue; // build-asset-index skips these too
      const p = join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) out.push(p);
    }
  };
  rec(root);
  return out;
}

/** Hash every file under `root`, keyed exactly as /asset-index.json keys it.
 *  Falls back to this thread if a worker cannot start — a slower correct answer
 *  beats a fast absent one. */
async function hashTree(root, workers = 4) {
  const paths = walk(root).filter((p) => p !== join(root, "asset-index.json")); // never index the index
  if (workers <= 1 || paths.length < 2000) {
    const files = {};
    for (const p of paths) files[relative(root, p).split(sep).join("/")] = hashOf(readFileSync(p));
    return files;
  }
  const chunks = Array.from({ length: workers }, () => []);
  paths.forEach((p, i) => chunks[i % workers].push(p));
  try {
    const parts = await Promise.all(
      chunks.map(
        (paths2) =>
          new Promise((res, rej) => {
            const w = new Worker(new URL(import.meta.url), { workerData: { artbuildHash: true, paths: paths2, root } });
            w.on("message", (m) => { res(m); void w.terminate(); });
            w.on("error", rej);
          }),
      ),
    );
    return Object.assign({}, ...parts);
  } catch (e) {
    console.log(`[artbuild] worker hashing unavailable (${String(e).slice(0, 80)}) — hashing in this thread`);
    return hashTree(root, 1);
  }
}

/** Build the curated art root and hash it.
 *  @returns {{root:string, files:Record<string,string>, count:number, bytes:number, ms:number}} */
export async function artBuild({ root, tree = join(GAMES2, ".."), workers = 4 }) {
  if (!root) throw new Error("artbuild: --root <dir> is required (the curated root to build)");
  const t0 = performance.now();
  // 1. the publication closure, from the FULL tree. --check fails on a
  //    named-but-missing file, which is shipset's own rule and is what keeps a
  //    404 out of production.
  run("shipset", process.execPath, [join(GAMES2, "scripts", "shipset.mjs"), "--emit", root, "--check", "--report", "--write"], {
    ASSETS_ROOT: tree,
  });
  // 2. the catalogs, from the CURATED root. --force because the cache's
  //    fingerprint is of the FULL tree's inputs and would skip the rebuild the
  //    curated root needs.
  run("manifest", process.execPath, [join(GAMES2, "scripts", "manifest.mjs"), "--force"], { ASSETS_ROOT: root });
  // 3. the tiles3 closure. tsx, as the Dockerfile runs it.
  const tsx = join(GAMES2, "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) throw new Error(`artbuild: ${tsx} is missing — run npm ci first`);
  run("ship-tiles3", tsx, [join(GAMES2, "scripts", "ship-tiles3.ts"), "--root", tree, "--out", root, "--check"]);
  // 4. and hash what came out.
  const tHash = performance.now();
  const files = await hashTree(root, workers);
  let bytes = 0;
  for (const k of Object.keys(files)) {
    try {
      bytes += readFileSync(join(root, k)).length;
    } catch {
      /* counted for the log only */
    }
  }
  // AND DROP WHAT THE IMAGE'S BUILD CONTEXT NEVER SEES — see dockerExcluded.
  const di = join(tree, ".dockerignore");
  let dropped = 0;
  let droppedBytes = 0;
  if (existsSync(di)) {
    const excluded = dockerExcluded(readFileSync(di, "utf8"));
    for (const rel of Object.keys(files)) {
      if (!excluded(rel)) continue;
      dropped++;
      try {
        droppedBytes += readFileSync(join(root, rel)).length;
      } catch {
        /* the log only */
      }
      delete files[rel];
    }
    console.log(
      `[artbuild] .dockerignore excludes ${dropped} path(s) (${(droppedBytes / 1e6).toFixed(2)} MB) the image never sees — not publishable`,
    );
  } else {
    console.log(`[artbuild] WARNING: no .dockerignore at ${di}; cannot tell what the image's build context excludes`);
  }
  const count = Object.keys(files).length;
  console.log(`[artbuild] hashed ${count} files, ${(bytes / 1e6).toFixed(1)} MB in ${Math.round(performance.now() - tHash)} ms`);
  const ms = Math.round(performance.now() - t0);
  console.log(`[artbuild] curated root ready in ${ms} ms -> ${root}`);
  return { root, files, count, bytes, ms };
}

if (isMainThread && import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const r = await artBuild({ root: arg("root"), tree: arg("tree", join(GAMES2, "..")) });
  if (process.argv.includes("--print")) console.log(JSON.stringify({ count: r.count, bytes: r.bytes, ms: r.ms }));
}
