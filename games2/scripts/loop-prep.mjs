// Deterministic prep for the Nangijala self-iterating loop (see loop/LOOP.md).
// Now that the game lives inside the pixel monorepo (pixel/games/nangijala),
// there's no submodule: the loop `git pull`s pixel main to get the latest art
// from the character/tile/map agents. This script regenerates the client
// manifest and reports what's new vs the last snapshot. Issue management is
// done by the agent, not here.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SCRIPT_DIR, ".."); // pixel/games/nangijala
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", ".."); // pixel repo root
const SNAPSHOT = join(GAME_ROOT, "loop", "graphics_manifest.json");
const MANIFEST = join(GAME_ROOT, "client", "public", "characters.json");
const args = new Set(process.argv.slice(2));

function git(...a) {
  try {
    return execFileSync("git", a, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  }
}

if (args.has("--pull")) {
  console.log(git("pull", "--ff-only", "origin", "main"));
}

// Regenerate the client character manifest from the sibling characters2/ domain.
execFileSync("node", [join(SCRIPT_DIR, "build-manifest.mjs")], { cwd: GAME_ROOT, stdio: "inherit" });

const headSha = git("rev-parse", "HEAD");
const current = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")).characters : [];
const snapshot = existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, "utf8")) : {};
const now = {};
for (const c of current) now[c.uid] = { name: c.name, animations: Object.keys(c.animations).sort() };

const newChars = [];
const newAnims = [];
for (const [uid, info] of Object.entries(now)) {
  if (!snapshot[uid]) newChars.push(uid);
  else for (const a of info.animations) if (!(snapshot[uid].animations || []).includes(a)) newAnims.push(`${uid}:${a}`);
}

console.log(`pixel @ ${headSha}`);
console.log(`characters: ${current.length}`);
if (newChars.length) console.log("new characters:", newChars.join(", "));
if (newAnims.length) console.log("new animations:", newAnims.join(", "));
if (!newChars.length && !newAnims.length) console.log("no new graphics since last snapshot");

if (args.has("--write-manifest")) {
  writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + "\n");
  console.log(`wrote snapshot → ${SNAPSHOT.replace(GAME_ROOT + "/", "")}`);
}
