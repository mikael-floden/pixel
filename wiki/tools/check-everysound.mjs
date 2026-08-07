// COMPLETENESS: every generated sound on disk must be reachable in the wiki.
//
// Maintainer 2026-08-06: "Are you sure the sound dialog selector really can
// browse all sound effect? Every single generated sound? Or something else
// missing to make me see all sound effects?" — and the answer was no. The
// composer generates a POOL per brief, scores it, and copies only the winners
// out as takes; 91 generated recordings sat on disk that no page could reach,
// because the builder read `takes` and nothing else. The same class of gap had
// just been found in music (five generated tracks, unlisted).
//
// So this gate does not check a number someone typed. It WALKS THE DISK, hashes
// every audio file, and asserts each one is either listed in data.json or is
// byte-identical to a file that is (a take is a copy of its winning candidate —
// same bytes, different path). Anything else is a sound the Game Master cannot
// hear, and that is a build failure.
//
// Node-only and fast: no browser, no server. check-takes.mjs already proves the
// picker RENDERS one row per listed recording; this proves the LIST is complete.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const D = JSON.parse(readFileSync(join(ROOT, "wiki/site/data.json"), "utf8"));
const fails = [];
const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };

const AUDIO = /\.(wav|ogg|m4a|mp3)$/i;
function walk(dir, out = []) {
  let ents; try { ents = readdirSync(dir); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (AUDIO.test(e)) out.push(p);
  }
  return out;
}
const hash = (p) => createHash("md5").update(readFileSync(p)).digest("hex");

// ---- what the wiki lists -------------------------------------------------
// Composer paths are `composer/foley/<set>/<file>`; catalog takes carry a
// per-format file map. Both resolve to a real path under the repo root.
const listed = new Set();
for (const cs of Object.values(D.sfx.composerSets)) {
  for (const t of [...cs.takes, ...(cs.alts ?? [])]) listed.add(join(ROOT, "games2", t.file));
}
for (const s of D.domains.sounds) {
  for (const t of s.takes) for (const f of Object.values(t.files ?? {})) listed.add(join(ROOT, f.replace(/^\/?assets\//, "")));
}
const listedHashes = new Set();
for (const p of listed) { try { listedHashes.add(hash(p)); } catch { /* reported below */ } }

// ---- what is on disk -----------------------------------------------------
const SOURCES = [
  ["composer foley", join(ROOT, "games2/composer/foley")],
  ["sound catalog", join(ROOT, "sounds")],
];
let total = 0;
for (const [name, dir] of SOURCES) {
  const files = walk(dir);
  total += files.length;
  const unreachable = [];
  let dupes = 0;
  for (const f of files) {
    if (listed.has(f)) continue;
    if (listedHashes.has(hash(f))) { dupes++; continue; } // a promoted candidate
    unreachable.push(f.slice(ROOT.length));
  }
  console.log(`${name}: ${files.length} audio files on disk, ${dupes} byte-identical to a listed one`);
  ok(unreachable.length === 0,
    `${name}: every generated sound is reachable in the wiki` +
    (unreachable.length ? ` — ${unreachable.length} ARE NOT:\n      ${unreachable.slice(0, 12).join("\n      ")}` : ""));
}

// A listed file that is not on disk is the mirror failure: a row that 404s.
const ghosts = [...listed].filter((p) => { try { statSync(p); return false; } catch { return true; } });
ok(ghosts.length === 0, `every listed recording exists on disk${ghosts.length ? ` — ${ghosts.length} missing: ${ghosts.slice(0, 4).map((g) => g.slice(ROOT.length)).join(", ")}` : ""}`);

// The pool is the whole point of this gate — if it ever stops being listed,
// fail loudly rather than quietly shrinking the picker back to 190 rows.
const alts = Object.values(D.sfx.composerSets).reduce((n, c) => n + (c.alts?.length ?? 0), 0);
ok(alts > 0, `the composer's generation pool is listed (${alts} alternatives)`);

const rows = Object.values(D.sfx.composerSets).reduce((n, c) => n + c.takes.length + (c.alts?.length ?? 0), 0)
  + D.domains.sounds.reduce((n, s) => n + s.takes.length, 0);
console.log(`\n${rows} distinct recordings listed, from ${total} audio files on disk`);
console.log(fails.length ? `\nEVERY-SOUND CHECKS FAILED (${fails.length})` : "\nALL EVERY-SOUND CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
