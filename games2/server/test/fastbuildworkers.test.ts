// THE FAST LANE'S WORKERS (scripts/fastbuild.mjs). esbuild does not bundle the vite idiom
// `new Worker(new URL("./w.ts", import.meta.url))`, so the lane finds every worker in the
// client's source, bundles it under its content hash and rewrites the specifier. A worker the
// lane cannot see is a silent 404 in production: the recorder's CPU benchmark read 0 in every
// window of his 2026-09-25 15:51 run because the lane kept a hand-written list of three.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs build script, no declaration (as the imagelib tests import theirs)
import { findWorkers, rewriteWorkerSpecifiers } from "../../scripts/fastbuild.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("every worker the client starts is one the fast lane finds — none started any other way", () => {
  const found: string[] = findWorkers();
  for (const w of ["artworker", "composeworker", "tiles3worker", "perfpost"]) assert.ok(found.includes(w), `the lane does not see ${w}`);
  // Every `new Worker(` in the client must be the idiom: a worker built from a variable URL, a
  // blob or a string the scan cannot read would ship as a 404 on the fast lane.
  let starts = 0;
  let idioms = 0;
  for (const f of sources(SRC)) {
    const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    starts += (text.match(/new Worker\(/g) ?? []).length;
    idioms += (text.match(/new Worker\(\s*new URL\(\s*["'](?:\.\.?\/)+[\w-]+\.ts["']\s*,\s*import\.meta\.url/g) ?? []).length;
  }
  assert.equal(idioms, starts, `${starts - idioms} worker(s) started some other way — fastbuild cannot bundle them`);
});

test("a worker's specifier is rewritten at any depth to its emitted name beside the bundle", () => {
  const names = { perfpost: "perfpost-0123456789.js", artworker: "artworker-abcdef0123.js" };
  const src = [
    'new Worker(new URL("../perfpost.ts", import.meta.url), { type: "module" })',
    'new Worker(new URL("./artworker.ts", import.meta.url))',
    'new Worker(new URL("../../perfpost.ts", import.meta.url))',
    'import { x } from "./perfpostal"; const y = "notperfpost.ts"; const z = "a/perfpost.tsx";',
  ].join("\n");
  const out = rewriteWorkerSpecifiers(src, names);
  assert.equal(
    out,
    [
      'new Worker(new URL("./perfpost-0123456789.js", import.meta.url), { type: "module" })',
      'new Worker(new URL("./artworker-abcdef0123.js", import.meta.url))',
      'new Worker(new URL("./perfpost-0123456789.js", import.meta.url))',
      'import { x } from "./perfpostal"; const y = "notperfpost.ts"; const z = "a/perfpost.tsx";',
    ].join("\n"),
  );
});
