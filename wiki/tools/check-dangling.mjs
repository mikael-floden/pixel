#!/usr/bin/env node
/* NO VERDICT MAY POINT AT ART THAT NO LONGER EXISTS (maintainer 2026-09-18:
 * "I have a dangling ghost state and they need to remove what I remove so it's
 * not stuck in the wiki. Also clean the state/comment/redo etc when they
 * replace with new art/work").
 *
 * A verdict is an entry in `live/feedback/<domain>.json` keyed on an asset —
 * `monsters/ashling`, `monsters/ashling#attack_v2#south`. When an agent acts on
 * it the entry must die with the art it judged (live/docs/review-contract.md).
 * When it does not, the wiki shows his old words over new art, or a removed
 * creature keeps a row that cannot be opened. This counts those.
 *
 *   node wiki/build.mjs && node wiki/tools/check-dangling.mjs [--strict]
 *
 * THE REGISTRY IS THE TRUTH, not the filesystem: `wiki/site/data.json` is built
 * from the whole tree (every domain's own index), so it knows what actually
 * exists under each domain's own naming rules — which no glob in here could
 * reproduce for eleven domains.
 *
 * REPORT-ONLY BY DEFAULT. It names the entries and the domain that owns each,
 * so an agent can clear its own; `--strict` exits 1 and is what a domain wires
 * into its own gate once its house is clean. */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const DATA = JSON.parse(readFileSync(join(ROOT, "wiki/site/data.json"), "utf8"));
const strict = process.argv.includes("--strict");

/** Every asset the registry knows, by repo path, with the states it carries. */
const known = new Map();
const add = (path, animations) => {
  if (!path) return;
  const states = new Set();
  for (const [st, clip] of Object.entries(animations ?? {})) {
    for (const d of Object.keys(clip?.dirs ?? {})) states.add(`${st}#${d}`);
    states.add(st);
  }
  known.set(path, states);
};
for (const m of DATA.domains?.monsters ?? []) add(m.path, m.animations);
for (const c of DATA.domains?.characters ?? []) add(c.path, c.animations);
for (const o of DATA.domains?.objects ?? []) add(o.path, o.animations ?? o.states);
for (const w of DATA.domains?.world ?? []) add(w.path, null);
for (const l of DATA.domains?.lore ?? []) add(l.path, null);
for (const c of DATA.domains?.monsterCandidates ?? []) add(c.path, null);
// Sounds, music and items are keyed by id rather than by a folder path in some
// of the feedback files; both spellings are accepted.
for (const s of DATA.domains?.sounds ?? []) { add(s.path ?? `sounds/${s.id}`, null); add(`sounds/${s.id}`, null); }
for (const t of DATA.domains?.music ?? []) { add(t.path ?? `music/${t.id}`, null); add(`music/${t.id}`, null); }
for (const i of DATA.domains?.items ?? []) { add(i.path ?? `items/${i.id}`, null); add(`items/${i.id}`, null); }

/** Is there anything on disk under this repo path? A file with any extension
 *  counts: a feedback id is the path WITHOUT one. */
function onDisk(path) {
  const abs = join(ROOT, path);
  if (existsSync(abs)) return true;
  const at = path.lastIndexOf("/");
  const dir = join(ROOT, path.slice(0, at)), base = path.slice(at + 1);
  try { return readdirSync(dir).some((f) => f === base || f.startsWith(`${base}.`)); }
  catch { return false; }
}
/** …and the same question for one state of one entity: a folder named for the
 *  state, or a file that names the state and the facing. */
function facetOnDisk(path, state, dir) {
  const abs = join(ROOT, path);
  if (existsSync(join(abs, state)) || existsSync(join(abs, "animations", state))) return true;
  try {
    return readdirSync(abs).some((f) => f.startsWith(`${state}__`) || f.startsWith(`${state}.`))
      || readdirSync(join(abs, "animations")).some((f) => f === state || f.startsWith(`${state}__`));
  } catch { return false; }
}

/* The domains whose feedback this can judge. A file whose ids are not asset
 * paths at all — bindings.json rates an <event>#<sound> PAIR — is skipped by
 * name rather than guessed at, and said so in the output. */
const NOT_ASSETS = new Set(["bindings"]);
/* Tiles are published by the tiles domain's own index, which this registry
 * carries as `world` cells with their own ids; a tiles verdict keyed on a
 * candidate id cannot be resolved here without re-implementing that index. */
const UNRESOLVED = new Set(["tiles", "composer", "composer-music"]);

let total = 0, dangling = 0;
const perDomain = [];
for (const file of readdirSync(join(ROOT, "live/feedback")).filter((f) => f.endsWith(".json"))) {
  const domain = file.replace(/\.json$/, "");
  const doc = JSON.parse(readFileSync(join(ROOT, "live/feedback", file), "utf8"));
  const entries = doc.entries ?? {};
  const keys = Object.keys(entries);
  total += keys.length;
  if (NOT_ASSETS.has(domain)) { perDomain.push(`  ${domain}: ${keys.length} entries — not asset ids, skipped`); continue; }
  if (UNRESOLVED.has(domain)) { perDomain.push(`  ${domain}: ${keys.length} entries — this registry cannot resolve them, skipped`); continue; }
  const bad = [];
  for (const key of keys) {
    const [path, state, dir] = key.split("#");
    const states = known.get(path);
    // THE FILESYSTEM IS THE SECOND OPINION, and it beats the registry every
    // time it disagrees. The registry lists what the WIKI shows — sound EVENTS,
    // not the takes under them; scenery states it synthesises. Judging only by
    // the registry called 79 sound takes and 98 scenery states "gone" when
    // every one of them is on disk. A verdict is dangling when NOTHING answers
    // to it, not when this one index does not.
    if (!states && !onDisk(path)) { bad.push([key, "the asset is gone"]); continue; }
    if (!state || !states) continue;
    if (states.size && !states.has(state) && !states.has(`${state}#${dir}`) && !facetOnDisk(path, state, dir)) {
      bad.push([key, dir ? `no ${state} facing ${dir}` : `no ${state}`]);
    }
  }
  dangling += bad.length;
  perDomain.push(`  ${domain}: ${keys.length} entries, ${bad.length} dangling`);
  for (const [key, why] of bad.slice(0, 12)) perDomain.push(`      ${key}  (${why})`);
  if (bad.length > 12) perDomain.push(`      …and ${bad.length - 12} more`);
}
console.log(`live/feedback: ${total} verdicts, ${dangling} pointing at art that no longer exists`);
for (const line of perDomain) console.log(line);
if (dangling) {
  console.log("\nEach one shows the Game Master a verdict on something he cannot open, or his old");
  console.log("words over new art. The owning agent clears them — live/docs/review-contract.md.");
}
if (strict && dangling) process.exit(1);
