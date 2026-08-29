// THE SHIP SET — every asset path the DEPLOYED game can actually reach.
//
// WHY THIS EXISTS (maintainer 2026-08-14): "Some content is in the game and
// some content is not. The content that is not in the game doesn't have to be
// part of the built container and/or loaded in the game." The art domains are
// autonomous factories that generate far more than the game uses — scenery
// alone ships 2,644 files of which the game reads THREE — so the image, the
// client's asset lists and the wiki's public registry should all be driven by
// what is genuinely reachable rather than by what happens to exist on disk.
//
// THE MODEL: publication is a ROOT SET, reachability is a CLOSURE. The roots
// are declared by hand in config/publish.json (a product decision — only the
// maintainer knows which worlds are "the real game"); everything else is
// DERIVED, so adding an NPC to a shipped world automatically ships that NPC's
// character art and nobody has to remember to update a list.
//
//   published worlds ─┬─ world.json paths[]      → tiles2/**   (the tile art)
//                     ├─ npcs.json  .character   → characters2/npcs/<uid>/**
//                     ├─ spawns.json .monster    → monsters/<id>/**
//                     └─ the world's own files   → maps2/worlds/<w>/**
//   playable characters                          → characters2/humans/<uid>/**
//   config scenery (the 3 game-referenced pieces)→ scenery/<name>/**
//   always-ship domains (small, wholly in-game)  → items/ lore/ live/ …
//
// ANYTHING NOT IN THE CLOSURE IS "STAGING": it stays in git, stays visible to
// a signed-in admin in the wiki, and does NOT enter the image.
//
// FAIL-SAFE DIRECTION, deliberately: when this script cannot resolve something
// it INCLUDES it and warns. Shipping a spare file wastes bytes; dropping a
// reachable one 404s in production. The tests assert the closure's *shape*,
// not its exact size, so the art loops can keep generating without breaking CI.
//
// Usage:
//   node scripts/shipset.mjs              # write shipset.json
//   node scripts/shipset.mjs --report     # human-readable savings table
//   node scripts/shipset.mjs --check      # exit 1 if a shipped ref is missing
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SCRIPT_DIR, "..");
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(GAME_ROOT, "..");
const POLICY = join(GAME_ROOT, "config", "publish.json");
const OUT = join(GAME_ROOT, "client", "public", "shipset.json");

// POLICY-ONLY mode: validating the policy against a sparse checkout, where
// most of the art is legitimately absent. The closure still runs (it is how we
// learn what the policy names), but its "missing X" warnings are EXPECTED
// there and would bury the real output in ~50 lines of noise on every CI run,
// so they are collected and not printed. Nor is shipset.json written: a digest
// computed from a partial tree is wrong, and publishing it would invite
// someone to trust it.
const argv = process.argv;
const policyOnly =
  argv.includes("--check-policy") && !argv.includes("--check") && !argv.includes("--report") && !argv.includes("--emit");

const warnings = [];
const warn = (m) => {
  warnings.push(m);
  if (!policyOnly) console.warn(`[shipset] WARN ${m}`);
};

/** Repo-relative, forward-slashed — the form every manifest and URL uses. */
const rel = (abs) => relative(ASSETS_ROOT, abs).split(sep).join("/");

function readJson(p, what) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    warn(`could not read ${what} (${rel(p)}): ${e.message}`);
    return null;
  }
}

/** Every file under a directory, repo-relative. Missing dir → [] + a warning. */
function walk(absDir, { quiet = false } = {}) {
  if (!existsSync(absDir)) {
    if (!quiet) warn(`missing directory ${rel(absDir)}`);
    return [];
  }
  const out = [];
  const rec = (p) => {
    for (const n of readdirSync(p)) {
      if (n === "node_modules" || n.startsWith(".")) continue;
      const f = join(p, n);
      if (statSync(f).isDirectory()) rec(f);
      else out.push(rel(f));
    }
  };
  rec(absDir);
  return out;
}

const policy = readJson(POLICY, "publish policy");
if (!policy) {
  console.error("[shipset] no publish policy — refusing to guess what ships");
  process.exit(1);
}

const ship = new Set();
const add = (p) => p && ship.add(p);
const addAll = (ps) => ps.forEach(add);

// ---------------------------------------------------------------- worlds ----
// A published world drags in its own directory plus everything it references.
// NOTE the world's `paths[]` table is ALREADY exactly the set of tiles that
// world uses — measured across all 11 worlds, every entry is referenced by
// `top[]`, a prop or a deck cell. So the tile closure is a union of those
// tables and needs no per-cell scan.
// Since 2026-08-15 the ship set is `userWorlds` ONLY — dev maps are staging
// content streamed from the repo (client staging.ts / server WorldRoom
// fallback) and cost the image nothing. `worlds` accepted as a legacy alias.
const worldNames = policy.userWorlds ?? policy.worlds ?? [];
if (!worldNames.length) warn("policy publishes NO worlds — the image will have no map art");

const perWorld = {};
for (const name of worldNames) {
  const dir = join(ASSETS_ROOT, "maps2", "worlds", name);
  if (!existsSync(dir)) {
    warn(`published world "${name}" does not exist — skipping`);
    continue;
  }
  // The world's own files (world.json, npcs/spawns/places, minimap, map_base,
  // and any per-world sheets like prop_demo's props_*.webp).
  const own = walk(dir);
  addAll(own);

  const w = readJson(join(dir, "world.json"), `world ${name}`);
  const tiles = [];
  if (w) {
    for (const p of w.paths ?? []) {
      if (typeof p !== "string") continue;
      tiles.push(p);
      add(p);
    }
  }

  // NPCs → their character art.
  const chars = [];
  const npcs = readJson(join(dir, "npcs.json"), `npcs of ${name}`);
  for (const n of npcs?.npcs ?? []) {
    if (!n.character) continue;
    chars.push(n.character);
    const cdir = join(ASSETS_ROOT, "characters2", "npcs", n.character);
    if (existsSync(cdir)) addAll(walk(cdir));
    else warn(`world ${name}: npc "${n.id}" references character ${n.character}, which is missing`);
  }

  // Spawn zones → their monster art.
  const mons = [];
  const spawns = readJson(join(dir, "spawns.json"), `spawns of ${name}`);
  for (const z of spawns?.zones ?? []) {
    if (!z.monster) continue;
    mons.push(z.monster);
    const mdir = join(ASSETS_ROOT, "monsters", z.monster);
    if (existsSync(mdir)) addAll(walk(mdir));
    else warn(`world ${name}: zone "${z.id}" references monster ${z.monster}, which is missing`);
  }

  perWorld[name] = {
    files: own.length,
    tiles: new Set(tiles).size,
    characters: new Set(chars).size,
    monsters: new Set(mons).size,
  };
}

// --------------------------------------------------- playable characters ----
// The characters a PLAYER can be. Not derivable from the worlds — they are the
// player's own art — so the policy names their skeleton dirs.
for (const spec of policy.playableCharacters ?? []) {
  const dir = join(ASSETS_ROOT, "characters2", spec);
  if (existsSync(dir)) addAll(walk(dir));
  else warn(`playable character path "${spec}" does not exist`);
}

// ------------------------------------------------------------- monsters -----
// Monsters the ENGINE references directly regardless of spawn zones (the
// builtin fallback the tuning resolver falls back to, etc).
for (const id of policy.monsters ?? []) {
  const dir = join(ASSETS_ROOT, "monsters", id);
  if (existsSync(dir)) addAll(walk(dir));
  else warn(`policy monster "${id}" does not exist`);
}

// -------------------------------------------------------------- scenery -----
// The game reads exactly the pieces named here (campfire, grave_cross,
// blood_spatter — hardcoded in WorldScene). The v2 factory's ~2,640 other
// pieces are staging content: real, reviewable in the wiki, not in the image.
for (const name of policy.scenery ?? []) {
  const dir = join(ASSETS_ROOT, "scenery", name);
  if (existsSync(dir)) addAll(walk(dir));
  else warn(`policy scenery "${name}" does not exist`);
}

// ------------------------------------------------- domain support files -----
// A domain is not just its entities. Every contributing domain also carries
// small root-level descriptors the BUILDERS read — monsters/config/roster.json,
// characters2/animation_map.json, tiles2/emission.json — and missing one does
// not 404 a sprite, it silently empties a manifest.
//
// This was found the hard way: the first curated root produced
// "[monsters] 0 monsters -> monsters.json" because the closure walked
// monsters/<id>/ per spawned monster and never took monsters/config/. A game
// with no monsters would have built, deployed and looked fine until something
// tried to spawn.
//
// So: for every domain that contributes entities, ship its root-level FILES and
// its config/ tree wholesale. That is a few hundred KB and it is self-
// maintaining — a new descriptor ships without anyone editing the policy,
// which is the fail-safe direction this whole script is biased toward.
for (const d of policy.entityDomains ?? []) {
  const root = join(ASSETS_ROOT, d);
  if (!existsSync(root)) continue;
  for (const n of readdirSync(root)) {
    if (n.startsWith(".")) continue;
    const p = join(root, n);
    if (statSync(p).isDirectory()) {
      if (n === "config") addAll(walk(p)); // descriptors the builders read
    } else add(rel(p));
  }
}

// -------------------------------------------------- whole-domain includes ----
// Domains small enough (or wholly in-game enough) that per-entity closure buys
// nothing. Listed explicitly so adding a domain is a decision, not a default.
for (const spec of policy.alwaysShip ?? []) {
  const dir = join(ASSETS_ROOT, spec);
  if (existsSync(dir)) addAll(walk(dir));
  else warn(`alwaysShip path "${spec}" does not exist`);
}

// ------------------------------------------------------------- excludes -----
// Applied LAST so it can carve out subtrees an alwaysShip pulled in wholesale
// (e.g. music masters, the tiles2 generator's raw sheets).
const excludes = (policy.exclude ?? []).map((g) => new RegExp(g));
let excluded = 0;
for (const p of [...ship]) {
  if (excludes.some((re) => re.test(p))) {
    ship.delete(p);
    excluded++;
  }
}

// ------------------------------------------------------------- reporting ----
const DOMAINS = [
  "characters2", "tiles2", "maps2", "scenery", "monsters",
  "items", "sounds", "music", "lore", "wiki", "live",
];

function domainOf(p) {
  return p.split("/")[0];
}

function sizeOf(p) {
  try {
    return statSync(join(ASSETS_ROOT, p)).size;
  } catch {
    return 0;
  }
}

const stats = {};
for (const d of DOMAINS) {
  const all = walk(join(ASSETS_ROOT, d), { quiet: true });
  const kept = all.filter((p) => ship.has(p));
  const bytes = (ps) => ps.reduce((s, p) => s + sizeOf(p), 0);
  stats[d] = {
    totalFiles: all.length,
    shipFiles: kept.length,
    totalBytes: bytes(all),
    shipBytes: bytes(kept),
  };
}

// Anything reachable that lives OUTSIDE the known domains would silently not be
// reported — surface it rather than let the table quietly lie.
const stray = [...ship].filter((p) => !DOMAINS.includes(domainOf(p)));
if (stray.length) warn(`${stray.length} shipped paths outside known domains, e.g. ${stray.slice(0, 3).join(", ")}`);

const sorted = [...ship].sort();
const digest = createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);

const result = {
  schema: "nangijala/shipset@1",
  generatedAt: new Date().toISOString(),
  // Content hash of the ship set ITSELF. The packer and the image build key
  // their caches off this: same digest ⇒ the same art ships ⇒ nothing to redo.
  digest,
  policy: { worlds: worldNames, scenery: policy.scenery ?? [] },
  perWorld,
  stats,
  warnings,
  paths: sorted,
};

if (process.argv.includes("--report")) {
  const MB = (b) => (b / 1048576).toFixed(1).padStart(7);
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0).padStart(3) : "  -");
  console.log(`\nSHIP SET — worlds: ${worldNames.join(", ") || "(none)"}\n`);
  console.log(`${"domain".padEnd(13)} ${"ships".padStart(7)} ${"total".padStart(7)}  ${"%".padStart(3)}   ${"files".padStart(6)}/${"total".padEnd(6)}`);
  console.log("-".repeat(60));
  let ts = 0, tt = 0;
  for (const d of DOMAINS) {
    const s = stats[d];
    if (!s.totalFiles) continue;
    ts += s.shipBytes; tt += s.totalBytes;
    console.log(
      `${d.padEnd(13)} ${MB(s.shipBytes)}M ${MB(s.totalBytes)}M  ${pct(s.shipBytes, s.totalBytes)}%  ${String(s.shipFiles).padStart(6)}/${String(s.totalFiles).padEnd(6)}`,
    );
  }
  console.log("-".repeat(60));
  console.log(`${"TOTAL".padEnd(13)} ${MB(ts)}M ${MB(tt)}M  ${pct(ts, tt)}%`);
  console.log(`\nsaved: ${((tt - ts) / 1048576).toFixed(1)} MB  (${excluded} paths dropped by exclude rules)`);
  console.log(`digest: ${digest}`);
  if (warnings.length) console.log(`\n${warnings.length} warning(s) above.`);
  console.log("\nper published world:");
  for (const [n, v] of Object.entries(perWorld))
    console.log(`  ${n.padEnd(18)} ${String(v.tiles).padStart(5)} tiles  ${String(v.characters).padStart(4)} npcs  ${String(v.monsters).padStart(3)} monsters`);
  console.log();
}

// ----------------------------------------------------------------- emit -----
// Materialise the ship set as a real directory tree — the image's /assets.
//
// THIS IS THE WHOLE CONTAINER SPLIT. Because the Dockerfile rebuilds every
// manifest INSIDE the image from ASSETS_ROOT (`npm run build:client` runs
// `npm run manifest`, and the wiki's build.mjs reads the same root), filtering
// the asset root filters everything downstream for free: worlds.json lists
// only published worlds, monsters.json only spawned monsters, and the wiki's
// public data.json only in-game entities. The client cannot reference staging
// content because it is never told the content exists.
//
// Files are HARD-LINKED where possible: the curate stage and the copy live on
// one filesystem, so 57 MB of art costs inodes rather than bytes and the whole
// emit runs in well under a second. Falls back to a real copy across devices.
const emitIdx = process.argv.indexOf("--emit");
if (emitIdx !== -1) {
  const dest = process.argv[emitIdx + 1];
  if (!dest) {
    console.error("[shipset] --emit needs a target directory");
    process.exit(1);
  }
  const { linkSync, copyFileSync } = await import("node:fs");
  let linked = 0, copied = 0, bytes = 0;
  for (const p of sorted) {
    const from = join(ASSETS_ROOT, p);
    const to = join(dest, p);
    mkdirSync(dirname(to), { recursive: true });
    try {
      linkSync(from, to);
      linked++;
    } catch {
      try {
        copyFileSync(from, to);
        copied++;
      } catch (e) {
        // A file in the closure that cannot be materialised is a guaranteed
        // 404 in production — never let the image build "succeed" past it.
        console.error(`[shipset] FATAL cannot emit ${p}: ${e.message}`);
        process.exit(1);
      }
    }
    bytes += sizeOf(p);
  }
  console.log(
    `[shipset] emitted ${sorted.length} files (${(bytes / 1048576).toFixed(1)} MB) to ${dest} — ${linked} linked, ${copied} copied`,
  );
}

// POLICY CHECK — the part that is meaningful WITHOUT the art tree, and so the
// only part safe to run from `npm test`.
//
// The deploy's `test` job sparse-checks-out games2 + characters2 +
// maps2/worlds + live + tiles2/emission.json. Under that tree a full --check
// is meaningless: tiles2/ EXISTS (one file) but 571 tile paths are absent, so
// it cannot even be rescued by an "is the domain missing?" heuristic — which
// is exactly how the first attempt turned the pipeline red while the image
// itself built fine. Asset existence is verified where the whole tree really
// is: the Dockerfile's curate stage.
//
// What IS checkable here: the policy names things that exist. A typo'd world
// silently ships an empty game, and maps2/worlds is checked out, so this
// catches the failure that actually bites.
if (process.argv.includes("--check-policy")) {
  const problems = [];
  if (!worldNames.length) problems.push("policy publishes no worlds");
  // Dev worlds are not shipped, but a typo here silently empties the admin
  // picker's staging list — same class of failure, same check. `devWorlds3`
  // names the SECOND world tree (maps2/worlds3, pixel-maps3/world@1); it is
  // checked here and NOWHERE ELSE in this file — the ship-set closure above
  // walks `userWorlds` only, so neither a worlds3 world nor a byte of tiles/
  // enters the image.
  for (const [root, names] of [
    ["worlds", [...worldNames, ...(policy.devWorlds ?? [])]],
    ["worlds3", policy.devWorlds3 ?? []],
  ]) {
    // AN ABSENT TREE IS "NOT CHECKED OUT HERE", NOT A TYPO — the same rule
    // --check applies to a missing domain, for the same reason: the deploy's
    // test job sparse-checks-out `/maps2/worlds/` and nothing else, so failing
    // on an absent maps2/worlds3 would turn the pipeline red while the image
    // (which builds from the full context) is perfectly fine.
    if (!names.length) continue;
    if (!existsSync(join(ASSETS_ROOT, "maps2", root))) {
      console.log(`[shipset] maps2/${root} not checked out — ${names.length} name(s) unverified`);
      continue;
    }
    for (const n of names) {
      const wj = join(ASSETS_ROOT, "maps2", root, n, "world.json");
      if (!existsSync(wj)) problems.push(`world "${n}" has no maps2/${root}/${n}/world.json`);
      else if (!readJson(wj, `world ${n}`)) problems.push(`world "${n}" has unparseable world.json`);
    }
  }
  for (const key of ["playableCharacters", "scenery", "alwaysShip", "entityDomains"])
    if (policy[key] && !Array.isArray(policy[key])) problems.push(`policy.${key} must be an array`);
  for (const g of policy.exclude ?? []) {
    try {
      new RegExp(g);
    } catch {
      problems.push(`policy.exclude has an invalid regex: ${g}`);
    }
  }
  if (problems.length) {
    console.error("[shipset] policy problems:");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`[shipset] policy OK — worlds: ${worldNames.join(", ")}`);
}

if (process.argv.includes("--check")) {
  // A reachable-but-missing file is the one failure that MUST stop a deploy:
  // it is a guaranteed 404 in production.
  //
  // PARTIAL CHECKOUTS ARE NOT THAT FAILURE. The deploy's `test` job uses a
  // sparse checkout (games2 + characters2 + maps2/worlds + live + one tiles2
  // file) because materialising 200 MB of art to run unit tests is pure cost.
  // The first version of this check ignored that, saw every absent domain as
  // "missing", exited 1, and turned the whole pipeline red — the image built
  // fine, the gate did not. So: an ENTIRELY absent domain root means "not
  // checked out here" and is a warning; a domain that IS present but is
  // missing a file it should contain is a real, fatal error.
  //
  // The strict, whole-tree run happens in the Dockerfile's curate stage, where
  // the full build context exists and this cannot be fooled.
  const absentDomains = new Set(
    DOMAINS.filter((d) => !existsSync(join(ASSETS_ROOT, d))),
  );
  const missing = sorted.filter((p) => !existsSync(join(ASSETS_ROOT, p)));
  const fatal = missing.filter((p) => !absentDomains.has(domainOf(p)));
  const skipped = missing.length - fatal.length;
  if (fatal.length) {
    console.error(`[shipset] ${fatal.length} shipped path(s) do not exist:`);
    for (const m of fatal.slice(0, 20)) console.error(`  ${m}`);
    process.exit(1);
  }
  if (absentDomains.size) {
    console.log(
      `[shipset] partial tree — not checked out: ${[...absentDomains].join(", ")} (${skipped} paths unverified)`,
    );
  }
  console.log(
    `[shipset] OK — ${sorted.length - skipped}/${sorted.length} paths verified, digest ${digest}`,
  );
}

if (!policyOnly && (!process.argv.includes("--report") || process.argv.includes("--write"))) {
  // SERVED form is deliberately COMPACT — digest, policy and per-domain stats,
  // but NOT the 13k-entry path list (794 KB no browser has any use for). The
  // client never needs to ask "is this shipped?": the manifests it reads were
  // themselves built from the curated root, so staging content simply does not
  // appear. The wiki uses the digest + stats to show what the live image holds.
  const { paths, ...compact } = result;
  compact.pathCount = paths.length;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(compact, null, 2));
  console.log(`[shipset] wrote ${rel(OUT)} — ${paths.length} paths, digest ${digest}`);
}
