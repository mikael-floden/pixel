// THE SERVER MAY ONLY IMPORT WHAT THE IMAGE SHIPS.
//
// games2/Dockerfile's runtime stage copies shared/, server/, config/ and
// client/dist — nothing else. A relative import from server/src that
// reaches anywhere else (ambient/, client/src, scripts/, ...) passes tsc,
// passes every test on a full checkout, builds an image, and then kills
// the container on MODULE_NOT_FOUND before it listens on PORT — which
// Cloud Run reports only as "failed to start", after the deploy has
// already been cut. Deploy 4064 (2026-09-18) died exactly this way on
// `../../../ambient/runtime/matrix.js`. This makes it a red test instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const games2 = resolve(here, "..", "..");
const SRC = join(games2, "server", "src");
/** The subtrees the runtime image contains (games2/Dockerfile, runtime stage). */
const SHIPPED = ["server", "shared", "config"].map((d) => join(games2, d));

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.[cm]?ts$/.test(n) && !n.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

test("server/src never imports outside what the runtime image ships", () => {
  const files = walk(SRC);
  assert.ok(files.length >= 5, `found only ${files.length} server sources — is the walk right?`);
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec || !spec.startsWith(".")) continue; // packages resolve from node_modules, which the image installs
      const target = resolve(dirname(f), spec);
      if (!SHIPPED.some((root) => !relative(root, target).startsWith(".."))) {
        bad.push(`${relative(games2, f)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(bad, [], `these imports do not exist inside the deployed image:\n  ${bad.join("\n  ")}`);
});
