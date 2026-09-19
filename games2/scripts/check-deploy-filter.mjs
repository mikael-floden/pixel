#!/usr/bin/env node
// THE CONTAINER MUST KEEP BUILDING ON AN ART PUSH, and this EXECUTES the filter
// that decides it instead of reading it.
//
// Why that distinction is the whole point. The art delta is measured against
// the IMAGE, so it grows for as long as the image stands still; the container
// refreshing every few minutes is what bounds the delta, bounds the server's
// memory, and lets law 6 undo a bad art generation automatically. All three
// depend on `nangijala-deploy.yml` NOT treating an art push as skippable — and
// that file keeps its own copy of a path filter, so one edit removes all three.
//
// My first version of this guard asserted `!filter.includes("characters2/")`.
// The canonical widening spells the set `^(characters2|tiles|…|lore)/`, which
// contains no `characters2/` substring at all, so the guard passed straight
// through the exact edit it existed to catch. A filter is a program; the only
// honest test is to RUN it.
//
//   node scripts/check-deploy-filter.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WF = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows");
let bad = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) bad++;
};

/** The `grep`-pipeline a workflow filters a changed-file list with.
 *  LINE SCANNING, NOT A REGEX: the obvious `\$\(echo …(\\?\n?[^\n]*)+?\|\| true\)`
 *  backtracks catastrophically on this file and simply hangs. */
function filterOf(file, marker) {
  const lines = readFileSync(join(WF, file), "utf8").split("\n");
  const start = lines.findIndex((l) => l.includes(`${marker}=$(echo `));
  if (start < 0) throw new Error(`check-deploy-filter: no \`${marker}=$(echo …)\` in ${file}`);
  const out = [];
  for (let i = start; i < lines.length && i < start + 20; i++) {
    out.push(lines[i]);
    if (lines[i].includes("|| true)")) {
      // Strip the assignment and the `echo "$VAR"` that feeds it: what is left
      // is the pipeline, which bash will read from stdin instead.
      const joined = out.join("\n").trim();
      const open = joined.indexOf('"');
      const close = joined.indexOf('"', open + 1);
      return joined.slice(close + 1).replace(/\|\|\s*true\)\s*$/, "").trim();
    }
  }
  throw new Error(`check-deploy-filter: ${marker}= in ${file} never closed with \`|| true)\``);
}

/** Does `filter` let `path` through — i.e. is it treated as carryable? */
function admits(filter, path) {
  // The path goes in on STDIN, so nothing in the pipeline can wait on a
  // terminal — and a 10 s ceiling, because a guard that hangs is a guard that
  // gets deleted.
  // NO `pipefail`, and a non-zero exit is not an error: `grep -v` exits 1 when
  // it filters EVERYTHING out, which is precisely the "admitted" answer.
  let out = "";
  try {
    out = execFileSync("bash", ["-c", `cat ${filter}`], { encoding: "utf8", input: `${path}\n`, timeout: 10_000 });
  } catch (e) {
    if (e.stdout == null) throw e; // a real failure to run bash at all
    out = String(e.stdout);
  }
  return out.trim() === ""; // nothing left over => the filter admits it
}

const ART = ["characters2", "tiles", "maps2", "scenery", "sounds", "music", "monsters", "items", "lore"];

// ------------------------------------------------- the DEPLOY's own filter
{
  const f = filterOf("nangijala-deploy.yml", "outside");
  console.log(`deploy filter: ${f.replace(/\s+/g, " ").slice(0, 110)}…`);
  for (const d of ART)
    check(!admits(f, `${d}/some/art.webp`), `the deploy does NOT admit ${d}/ — so an art push still builds an image`);
  check(admits(f, "games2/client/src/main.ts"), "it does still skip the image for browser code");
  check(admits(f, "games2/client/index.html"), "…and for the document");
  check(!admits(f, "games2/server/src/index.ts"), "and it deploys for server code");
  check(!admits(f, "games2/client/public/monsters.json"), "and for a generated catalog (art-derived)");
  check(!admits(f, "games2/Dockerfile"), "and for the image's own recipe");
}

// ------------------------------------------- the ART lane's own filter
{
  const f = filterOf("art-publish.yml", "OUTSIDE");
  console.log(`art-publish filter: ${f.replace(/\s+/g, " ").slice(0, 110)}…`);
  for (const d of ART) check(admits(f, `${d}/some/art.webp`), `the art lane admits ${d}/`);
  for (const p of ["games2/client/src/main.ts", "games2/client/index.html", "games2/client/public/monsters.json", "games2/client/public/npcs.json"])
    check(admits(f, p), `the art lane admits ${p}`);
  for (const p of [
    "games2/server/src/index.ts", "games2/shared/src/surfaces.ts", "games2/config/publish.json",
    "games2/scripts/shipset.mjs", "games2/Dockerfile", "wiki/site/data.json",
    "games2/client/public/ui2/icon-map.webp", "games2/client/public/logo.webp", "games2/client/public/sw.js",
    // The anchoring traps this repo has now paid for three times.
    "games2/client/index.htmlx", "games2/client/public/monsters.jsonx", "tiles2/old/x.webp", "mytiles/x.webp",
  ])
    check(!admits(f, p), `the art lane REFUSES ${p}`);
}

// -------------------------------- the CLIENT lane's own filter, unchanged
{
  const f = filterOf("fast-publish.yml", "OUTSIDE");
  for (const d of ART) check(!admits(f, `${d}/some/art.webp`), `the client lane stands down for ${d}/ (the art lane carries it)`);
  check(admits(f, "games2/client/src/main.ts"), "the client lane admits browser code");
}

console.log(bad ? `\ncheck-deploy-filter: ${bad} FAILURE(S)` : "\ncheck-deploy-filter: every filter behaves as the lanes require");
process.exit(bad ? 1 : 0);
