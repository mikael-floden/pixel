// THE PREBUILT BUNDLE A GATE SERVES MUST BE THIS TREE'S (docs/testing.md).
// A gate that runs a PROD server (`SERVE_CLIENT=1`) reads client/dist, not
// client/src, so a stale bundle makes it measure code from another day and
// report ok — the silent-stale class the Dockerfile's wiki-registry comment
// documents. Measured 2026-09-18: client/dist was four days old (built 09-14
// 20:02, 28 source files newer), so verify-indoorscenery read a
// sceneryLitCopy record from before the probe carried `tint` and `shape` and
// failed two arms on fields the running code does publish.
//
// Freshness is by MTIME against everything vite reads: client/src, shared/src
// (bundled in), client/public (copied verbatim) and client/index.html. Not a
// content hash — the build is the expensive half and an mtime comparison is
// what `npm run build:client` itself is idempotent against.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function newestMtime(dir, skip = /node_modules|\/dist(\/|$)/) {
  let newest = 0;
  const walk = (d) => {
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(d, e.name);
      if (skip.test(p)) continue;
      if (e.isDirectory()) walk(p);
      else {
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  walk(dir);
  return newest;
}

// Builds client/dist when it is missing or older than the sources, and returns
// what it did ("up to date" | "rebuilt" | "reused (--no-build)"). `die` is the
// caller's own exit path so each gate keeps its exit code and prefix; `noBuild`
// is for a caller measuring a bundle on purpose (verify-boottime's flag).
export function ensureClientDist(root, die, { noBuild = false, tag = "gate" } = {}) {
  const dist = join(root, "client", "dist", "index.html");
  if (noBuild) {
    if (!existsSync(dist)) die("--no-build but client/dist/index.html does not exist");
    return "reused (--no-build)";
  }
  const distAt = existsSync(dist) ? statSync(dist).mtimeMs : 0;
  const srcAt = Math.max(
    newestMtime(join(root, "client", "src")),
    newestMtime(join(root, "shared", "src")),
    newestMtime(join(root, "client", "public")),
    statSync(join(root, "client", "index.html")).mtimeMs,
  );
  if (distAt > srcAt) return "up to date";
  console.log(`[${tag}] client/dist is stale — building (npm run build:client)…`);
  try {
    execFileSync("npm", ["run", "build:client"], { cwd: root, stdio: "inherit" });
  } catch {
    die("npm run build:client failed");
  }
  return "rebuilt";
}
