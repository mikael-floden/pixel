#!/usr/bin/env node
// wiki/build.mjs — the wiki deploy script.
//
// Walks the sibling art/audio domains and writes wiki/site/data.json: one
// registry of everything the game has (monsters, player characters, tiles,
// objects, sounds, music, items, tunable constants) with repo-relative asset
// paths. Zero dependencies (plain fs + a 24-byte PNG IHDR read) so it runs
// anywhere: locally by any agent, and inside games2/Dockerfile at image build
// time so every deploy ships a wiki that matches the baked art exactly.
//
//   node wiki/build.mjs [--root <repo-or-assets-root>] [--out <data.json>]
//
// Missing domains are skipped gracefully (future domains — e.g. items/ —
// appear automatically once their directory exists). Also seeds
// live/tuning/monsters.json with defaults for any monster new to the roster
// (existing edits are always preserved).

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { contentBounds } from "./tools/webp-pixels.mjs";

const WIKI_DIR = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function argOf(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
// ROOT = the directory that holds the domain dirs (repo root, or /assets in Docker).
const ROOT = resolve(argOf("--root", resolve(WIKI_DIR, "..")));
const OUT = resolve(argOf("--out", join(WIKI_DIR, "site", "data.json")));
// games2 lives next to the domains in the repo, but NOT under /assets in
// Docker (the game source is at /app) — its files are optional extras
// (monster metrics, constants), so accept an explicit --games2 path.
const GAMES2 = resolve(argOf("--games2", existsSync(join(ROOT, "games2")) ? join(ROOT, "games2") : resolve(WIKI_DIR, "..", "games2")));

// The maintainer's preferred compass order for direction pickers.
const DIRS = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"];

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const listDirs = (p) => { try { return readdirSync(p).filter((n) => !n.startsWith(".") && !n.startsWith("_") && isDir(join(p, n))).sort(); } catch { return []; } };
const listFiles = (p, re) => { try { return readdirSync(p).filter((n) => re.test(n)).sort(); } catch { return []; } };

/* --- image format: PNG or WebP, decided by what is ON DISK ------------------
   The art domains are converting to lossless WebP one at a time (~50% off the
   bytes; fleet decision 2026-07-31), so for a while the repo holds both. The
   wiki never guesses: the builder looks, and data.json carries the real path.
   That keeps the browser out of the guessing business entirely — no probing,
   no <picture> fallbacks, no 404s while a domain is halfway converted. */
const ART_EXTS = ["webp", "png"];                 // preference order
/** The rel path of an image given WITHOUT its extension, or null if neither
 *  exists. WebP wins when a domain has both, so a half-finished conversion
 *  shows the new file and never a stale twin. */
function art(relNoExt) {
  for (const ext of ART_EXTS) if (isFile(join(ROOT, `${relNoExt}.${ext}`))) return `${relNoExt}.${ext}`;
  return null;
}
/** Matches one image of a set: art_re("\\d+") → /^\d+\.(webp|png)$/ */
const artRe = (stem) => new RegExp(`^${stem}\\.(${ART_EXTS.join("|")})$`, "i");
/** How a directory of numbered frames names its files, so the viewer can build
 *  frame URLs without probing: the extension, and the zero-padding width.
 *  monsters ship "00.png", characters2 ship "0.png" — a viewer that assumes
 *  either one 404s on the other. Today only characters2 reaches this path (every
 *  monster clip has a strip), which is exactly why the mismatch has gone
 *  unnoticed; naming it here means a monster that loses its strip degrades to
 *  frames instead of to nothing. */
function frameNaming(absDir) {
  const first = listFiles(absDir, artRe("\\d+"))[0];
  if (!first) return { frameExt: "png", framePad: 1 };
  const [stem, ext] = [first.slice(0, first.lastIndexOf(".")), first.slice(first.lastIndexOf(".") + 1)];
  return { frameExt: ext.toLowerCase(), framePad: stem.length };
}

/* --- committed SIDECARS (wiki/clean_base.json, wiki/world_map.json) --------
   Both are snapshots this domain took of another domain's art, so both go
   stale the moment that domain renames anything — and both did, on the WebP
   flip: 226 clean-base paths and the minimap still said .png while the art had
   become .webp. Nothing looked broken for a day because the game server was
   quietly rescuing .png → .webp; the hour that middleware was deleted
   (af9153638) the rot became visible as a blank clean-base ring on every tile
   page and a missing clean-base pill.
   So every path out of a sidecar is re-resolved against the disk HERE — and
   the run says out loud how many needed it, because a silent rescue is exactly
   what let this rot unnoticed. Resolving keeps the pages working; the warning
   is what gets the sidecar regenerated at its source. */
const staleSidecar = [];
const reArt = (p) => {
  if (typeof p !== "string") return null;
  const fixed = art(p.replace(/\.(png|webp)$/i, ""));
  if (!fixed) staleSidecar.push(`${p} → GONE`);
  else if (fixed !== p) staleSidecar.push(`${p} → ${fixed}`);
  return fixed;
};
const reArtAll = (a) => (a ?? []).map(reArt).filter(Boolean);

/** Pixel dimensions of a PNG or a WebP, read from the header. Zero
 *  dependencies, and it must stay that way: this runs inside the Docker build.
 *  WebP has three shapes and the animation viewer's frame maths depends on
 *  getting the right one — a wrong width silently mis-slices every strip. */
function imageSize(path) {
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(32);
    const n = readSync(fd, buf, 0, 32, 0);
    closeSync(fd);
    if (n >= 24 && buf.readUInt32BE(12) === 0x49484452)       // PNG "IHDR"
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (n >= 16 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      // The length each variant needs differs, and the check must be PER
      // VARIANT: a fully transparent 48×48 frame is a 28-byte VP8L file, and a
      // blanket ">= 30" silently called it "not an image". Death and fade-out
      // animations end in exactly such frames.
      const fourcc = buf.toString("ascii", 12, 16);
      if (fourcc === "VP8X" && n >= 30)                        // extended: 24-bit, minus one
        return { w: (buf.readUIntLE(24, 3) & 0xffffff) + 1, h: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
      if (fourcc === "VP8L" && n >= 25) {                      // lossless: 14 bits each, packed
        const bits = buf.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (fourcc === "VP8 " && n >= 30)                        // lossy: 14 bits each, after the sync code
        return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    return null;
  } catch { return null; }
}

/** Seconds of a PCM .wav, read from its RIFF header — zero dependencies, same
 *  rule as imageSize (this runs inside the Docker build). EVERY take shows its
 *  length as a chip (maintainer 2026-08-06); the composer's foley.json ships
 *  `durations_s`, the sounds catalog ships none, so we read the header:
 *  data-chunk bytes ÷ byteRate is exact for PCM. A chunk walk, not a fixed
 *  offset — real files carry LIST/fact chunks before `data`. */
const wavDurCache = new Map();
function wavDuration(path) {
  if (wavDurCache.has(path)) return wavDurCache.get(path);
  let dur = null;
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    if (n >= 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
      let off = 12, byteRate = 0;
      while (off + 8 <= n) {
        const id = buf.toString("ascii", off, off + 4);
        const sz = buf.readUInt32LE(off + 4);
        if (id === "fmt " && off + 24 <= n) byteRate = buf.readUInt32LE(off + 16);
        if (id === "data") {
          // A streamed file can carry a 0/0xffffffff placeholder size; the real
          // length is then whatever follows the header on disk.
          const bytes = sz > 0 && sz < 0xffffffff ? sz : statSync(path).size - (off + 8);
          if (byteRate > 0 && bytes > 0) dur = +(bytes / byteRate).toFixed(2);
          break;
        }
        off += 8 + sz + (sz & 1);
      }
    }
  } catch { dur = null; }
  wavDurCache.set(path, dur);
  return dur;
}

const titleCase = (id) => id.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// The deployed commit, for the topbar stamp (shown under the build date, same
// 9-char short form as the game's version badge). Docker passes GIT_SHA (see
// games2/Dockerfile — the ARG is declared BEFORE this builder runs); local
// runs fall back to git; neither → null and the wiki just omits the line.
function gitSha() {
  const env = process.env.GIT_SHA || process.env.VITE_GIT_SHA;
  if (env && env !== "dev") return env.slice(0, 9);
  try {
    return execSync("git rev-parse --short=9 HEAD", { cwd: WIKI_DIR, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim() || null;
  } catch { return null; }
}

// WHEN A PIECE ARRIVED (maintainer 2026-08-13: "As an admin I should be able
// to sort the Scenery on the latest generated content first … to make it
// easier to review"). Nothing in scenery.json carries a date, so the date is
// the commit that ADDED the piece — read once for the whole domain, cached in
// wiki/first_seen.json, which is committed.
//
// Inside the deploy image there is no .git (the .dockerignore allowlist keeps
// it out), so `git log` yields nothing there and the cache carries the answer
// instead. A piece the cache does not know is one that landed after the cache
// was last committed — i.e. newer than everything in it — so it is stamped
// with the build's own time, which sorts it exactly where the maintainer
// wants it: first. That makes this self-seeding and correct in both places,
// with no cross-domain dependency. The long-term fix is the scenery agent
// stamping `generated_at` into its own manifest; a board request is out.
// It dates the CURRENT art, not the path's first appearance. The scenery agent
// deletes rejected pieces and regenerates them AT THE SAME PATH — 29 of them
// in one day — so "when was this path created" answers the wrong question
// twice over: brand-new art sorts as old, and (worse) the maintainer's verdict
// on the art that used to live there still counts as a review of art he has
// never seen. Both showed up the moment he sorted newest-first and found 3
// unreviewed pieces after hours of new content.
//
// So the key is the sprite's CONTENT HASH. Same bytes → keep the stored date.
// Different bytes → this is new art; date it from the commit that last touched
// the sprite, or from now when there is no git (the deploy image). The wiki
// then compares a verdict's timestamp against this date to tell a review of
// THIS art from a review of whatever stood here before.
let gitArtDates = null;
function artChangeDates() {
  if (gitArtDates) return gitArtDates;                 // lazy: a warm cache never shells out
  gitArtDates = new Map();
  try {
    const out = execSync("git log --format=C%cI --name-only -- scenery/",
      { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 128 * 1024 * 1024 }).toString();
    let when = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("C")) when = line.slice(1);
      else if (line.endsWith("/sprite.webp") && when) {
        const dir = line.slice(0, -"/sprite.webp".length);
        // git log walks newest-first, so the FIRST sighting of a path is the
        // most recent commit that touched its art. Keep that one.
        if (!gitArtDates.has(dir)) gitArtDates.set(dir, when);
      }
    }
  } catch { /* no git (deploy image) — the committed cache answers instead */ }
  return gitArtDates;
}
function loadFirstSeen() {
  const path = join(ROOT, "wiki", "first_seen.json");
  const doc = readJson(path) ?? {};
  return { path, seen: doc.entries ?? {} };
}

// ---------------------------------------------------------------- monsters
function buildMonsters() {
  // NO GIF PATHS. The viewer draws every animation onto a canvas from the
  // strips and frames; it has never loaded a .gif, and neither has the game.
  // Emitting the paths anyway cost 59 KB of the data.json every reader
  // downloads, for a field with no consumer (checked 2026-07-31).
  const base = join(ROOT, "monsters");
  if (!isDir(base)) return null;
  const roster = readJson(join(base, "config", "roster.json"))?.monsters ?? [];
  const rosterById = Object.fromEntries(roster.map((m) => [m.id, m]));
  const animMap = readJson(join(base, "animation_map.json")) ?? { states: {}, overrides: {}, missing: {} };
  const states = Object.keys(animMap.states ?? {});
  // Art-measured render metrics (artBottom/footW/bodyW/hoverPx) from the
  // game's committed manifest, when available.
  const gameManifest = readJson(join(GAMES2, "client", "public", "monsters.json"));
  const metricsById = Object.fromEntries((gameManifest?.monsters ?? []).map((m) => [m.id, m]));

  const monsters = [];
  for (const id of listDirs(base)) {
    if (["config", "pipeline", "spec", "docs"].includes(id)) continue;
    const mj = readJson(join(base, id, "monster.json"));
    if (!mj) continue;
    const frameW = mj.size?.width ?? null;
    const frameH = mj.size?.height ?? null;
    const met = metricsById[id] ?? {};
    // The game's exact nadir-shadow ellipse (WorldScene formula) so the wiki
    // previews what the game renders.
    let shadow = null;
    if (met.footW != null && met.bodyW != null) {
      const w = Math.min(150, Math.max(12, Math.max(met.footW, met.bodyW * 0.55) * 1.05));
      shadow = { w: Math.round(w), h: Math.max(6, Math.round(0.385 * w)) };
    }
    const overrides = animMap.overrides?.[id] ?? {};
    const anims = {};
    for (const state of states.length ? states : Object.keys(mj.animations ?? {})) {
      const folder = overrides[state] ?? animMap.states?.[state] ?? state;
      const dirs = {};
      for (const dir of DIRS) {
        const frameDir = join(base, id, "animations", folder, dir);
        const frames = listFiles(frameDir, artRe("\\d+")).length;
        if (!frames) continue;
        const strip = art(`monsters/${id}/animations/${folder}__${dir}`);
        const dims = strip ? imageSize(join(ROOT, strip)) : null;
        dirs[dir] = {
          frames,
          strip,
          fw: dims ? Math.round(dims.w / frames) : frameW,
          fh: dims ? dims.h : frameH,
          framesDir: `monsters/${id}/animations/${folder}/${dir}`,
          ...frameNaming(frameDir),
        };
      }
      if (Object.keys(dirs).length) anims[state] = { folder, fallback: overrides[state] && overrides[state] !== state ? overrides[state] : null, dirs };
    }
    monsters.push({
      id,
      name: rosterById[id]?.name ?? mj.name ?? titleCase(id),
      // Player-facing flavour text from the monsters domain (monster.json
      // `lore`, shipped 2026-07-30); the wiki falls back to its generic
      // placeholder for monsters that don't carry one yet.
      lore: mj.lore ?? null,
      kind: rosterById[id]?.kind ?? mj.source?.kind ?? "object",
      path: `monsters/${id}`,
      preview: art(`monsters/${id}/sprite`),
      frameW, frameH,
      nativeW: mj.native_size?.width ?? frameW,
      nativeH: mj.native_size?.height ?? frameH,
      pad: mj.pad ?? { x: 0, y: 0 },
      artBottom: met.artBottom ?? 0.85,
      footW: met.footW ?? null,
      bodyW: met.bodyW ?? null,
      hoverPx: met.hoverPx ?? 0,
      shadow,
      inGame: !!metricsById[id],
      pixellab: mj.source?.url ?? null,
      animations: anims,
    });
  }
  return monsters;
}

// -------------------------------------------------------------- characters
// What a PLAYER is told about a hero — display name, species, sex, lore.
// The characters agent AUTHORS these in characters2/metadata.json
// (`characters2-metadata@1`) and sync.py merges the record onto the
// generated humans/<id>/character.json, so either file answers; we prefer
// the authored one and fall back to the merged copy.
//
// NEVER take any of this from character.json's `prompt`: both heroes shipped
// the same copy-pasted prompt saying "female" for BOTH (reported to the
// characters agent 2026-07-30, wiki board). The folder ids ("default_boy")
// are pipeline names and must never reach the page at all — maintainer, same
// day: "I don't even know what a default_boy is". The last-resort table is
// only so a brand-new hero without a record still gets a sensible name; an
// unlisted hero gets NO species/sex line rather than a guessed one.
const HERO_NAMES = { default_boy: "Man", default_girl: "Woman" }; // mirrors games2/scripts/build-manifest.mjs
/** The GAME STATE an NPC's PixelLab folder is really showing.
 *
 *  The heroes get this for free: animation_map.json maps `idle` →
 *  `custom-calm-idle`, and the viewer prints the left-hand side. NPCs are not
 *  in that file, so without this the viewer would print the folder itself —
 *  "custom-calm-still-idle-breathing", and on 39 of them the upstream typo
 *  "custom-calm-stili-idle-breathing".
 *
 *  Matched on WORDS, not on the whole string, so a new animation slug lands on
 *  the right state without anyone editing a table, and a typo elsewhere in the
 *  slug cannot hide the keyword. Longest keyword first: "spell_channel" must
 *  win over "spell". Anything unrecognised is cleaned rather than passed
 *  through — the reader never meets a `custom-` prefix. */
const NPC_STATES = [
  ["spell_channel", ["channel", "channeled"]], ["spell_wand", ["wand"]],
  ["idle", ["idle", "breathing", "still", "calm"]], ["walk", ["walk", "walking"]],
  ["run", ["run", "running"]], ["jump", ["jump"]], ["attack", ["attack", "swing", "slash"]],
  ["sword", ["sword"]], ["bow", ["bow", "arrow"]], ["kick", ["kick"]], ["punch", ["punch"]],
  ["hurt", ["hurt", "hit", "damaged"]], ["die", ["die", "dead", "death"]],
  ["sit", ["sit", "sitting"]], ["talk", ["talk", "talking", "speak"]],
  ["wave", ["wave", "waving", "greet"]], ["work", ["work", "working", "hammer", "craft"]],
];
function npcState(folder) {
  const words = new Set(String(folder).toLowerCase().replace(/^custom[-_]/, "").split(/[-_\s]+/));
  for (const [state, keys] of NPC_STATES) if (keys.some((k) => words.has(k))) return state;
  return [...words].join("_") || "idle";
}
/** The 8 base rotations as a one-frame "standing" clip, for a character that
 *  has no animation art yet. Emits ONLY the directions whose file is actually
 *  on disk — a clip pointing at a missing rotation would trade an empty
 *  viewer for a broken image, which is worse. Returns {} when there is
 *  nothing at all, so the caller can still tell the difference. */
function baseRotationClip(baseDir) {
  const dirs = {};
  for (const d of DIRS) {
    const p = art(`${baseDir}/${d}`);
    if (p) dirs[d] = { frames: 1, strip: p };
  }
  return Object.keys(dirs).length ? { standing: { folder: "base", dirs } } : {};
}
function buildCharacters() {
  const base = join(ROOT, "characters2", "humans");
  if (!isDir(base)) return null;
  const animMap = readJson(join(ROOT, "characters2", "animation_map.json")) ?? { states: {}, overrides: {} };
  const authored = readJson(join(ROOT, "characters2", "metadata.json"))?.characters ?? {};
  const chars = [];
  for (const id of listDirs(base)) {
    const cj = readJson(join(base, id, "character.json"));
    const meta = { ...cj, ...authored[id] };   // authored record wins
    // size ships as [w, h] today; tolerate the {width, height} shape the
    // monsters domain uses so a format change can never break a deploy.
    const size = cj?.size;
    const frameW = Array.isArray(size) ? size[0] : size?.width ?? 112;
    const frameH = Array.isArray(size) ? size[1] : size?.height ?? 112;
    const overrides = animMap.overrides?.[id] ?? {};
    const anims = {};
    for (const [state, dfltFolder] of Object.entries(animMap.states ?? {})) {
      const folder = overrides[state] ?? dfltFolder;
      const dirs = {};
      for (const dir of DIRS) {
        const frameDir = join(base, id, "animations", folder, dir);
        const frames = listFiles(frameDir, artRe("\\d+")).length;
        if (frames) dirs[dir] = { frames, framesDir: `characters2/humans/${id}/animations/${folder}/${dir}`, ...frameNaming(frameDir) };
      }
      if (Object.keys(dirs).length) anims[state] = { folder, dirs };
    }
    chars.push({
      id,
      kind: "hero",
      name: meta.display_name ?? HERO_NAMES[id] ?? titleCase(id),
      species: meta.species ?? null,
      sex: meta.sex ?? null,
      lore: meta.lore ?? null,
      path: `characters2/humans/${id}`,
      preview: art(`characters2/humans/${id}/base/south`),
      baseStrip: art(`characters2/humans/${id}/base/preview`),
      frameW, frameH,
      animations: anims,
    });
  }
  // --- NPCs (characters2/npcs/, tag-driven mirror; landed 2026-08-01) -------
  // Same array, kind:"npc": the page splits on it, and everything shared —
  // routing, feedback, the animation player, lore joins — keeps working with
  // one code path.
  //
  // The id is the FOLDER KEY exactly as characters2 publishes it, with no
  // prefix of ours: the lore fold below matches loreEntities[dom][e.id], so a
  // prefix would quietly fail to join the day the lore agent writes an NPC up.
  //
  // Every NPC is authored (characters2 2026-08-01): display_name, species,
  // sex, role and lore ride on character.json, read from the ART rather than
  // from pixellab_prompt — which is the same copy-pasted "young female
  // adventurer" text on all 191 and says female for every one of them. That
  // prompt, and the duplicate PixelLab name it produced, stay admin-only.
  // States are discovered from the folders on disk: NPCs are not in
  // animation_map.json.
  const npcBase = join(ROOT, "characters2", "npcs");
  for (const key of listDirs(npcBase)) {
    const cj = readJson(join(npcBase, key, "character.json"));
    if (!cj) continue;
    const size = cj.size;
    const frameW = Array.isArray(size) ? size[0] : size?.width ?? 112;
    const frameH = Array.isArray(size) ? size[1] : size?.height ?? 112;
    const anims = {};
    for (const folder of listDirs(join(npcBase, key, "animations"))) {
      const dirs = {};
      for (const dir of DIRS) {
        const frameDir = join(npcBase, key, "animations", folder, dir);
        const frames = listFiles(frameDir, artRe("\\d+")).length;
        if (frames) dirs[dir] = { frames, framesDir: `characters2/npcs/${key}/animations/${folder}/${dir}`, ...frameNaming(frameDir) };
      }
      // KEYED BY GAME STATE, never by the PixelLab folder. The state name is
      // what the viewer prints on its buttons, and the folder is a prompt
      // slug — "custom-calm-still-idle-breathing", plus an upstream typo
      // variant "…stili…" on 39 of them (maintainer 2026-08-01: "no technical
      // names to the end user").
      if (Object.keys(dirs).length) {
        let state = npcState(folder);
        while (anims[state]) state = /_\d+$/.test(state) ? state.replace(/_(\d+)$/, (_, n) => `_${+n + 1}`) : `${state}_2`;
        anims[state] = { folder, dirs };
      }
    }
    chars.push({
      id: key,
      kind: "npc",
      // "Villager" only survives as the fallback for an NPC synced before the
      // agent has authored it — a nameless card, not a broken one.
      name: cj.display_name ?? "Villager",
      role: cj.role ? titleCase(cj.role) : null,   // "elder_scholar" → "Elder Scholar"
      pixellabName: cj.name ?? null,               // admin-only display
      species: cj.species ?? "Human",
      sex: cj.sex ?? null,
      lore: cj.lore ?? null,
      // characters2' `no_turn`: this NPC's ART only reads right from ONE
      // facing, so the game must never rotate them. Thorne is the first —
      // his armorer's breastplate stands on the ground beside him in south
      // and south-west and is absent in south-east, so a turn pops the prop
      // in and out. Absent means false (their README, 2026-08-07). A pipeline
      // constraint on the art, so the wiki shows it to the Game Master only.
      noTurn: cj.no_turn === true,
      path: `characters2/npcs/${key}`,
      preview: art(`characters2/npcs/${key}/base/south`),
      baseStrip: art(`characters2/npcs/${key}/base/preview`),
      frameW, frameH,
      // NO ANIMATION ART? Then the 8 STANDING ROTATIONS are the art, and they
      // become a one-frame "standing" clip so the viewer has something real to
      // show (maintainer 2026-08-07: "Why is Morwenna not visible in the
      // animation viewer?" — 3 of the 191 NPCs are synced with a base/ folder
      // and no animations/ folder at all, so the player drew an empty
      // chessboard with a "—" frame counter and no explanation).
      //
      // A synthesised clip, not a special case in the UI: the player, the
      // direction buttons and the state chip all work unchanged, and the
      // 8 rotations are genuinely worth flipping through. `standing` is the
      // state name, so the card says plainly what it is showing.
      animations: Object.keys(anims).length ? anims : baseRotationClip(`characters2/npcs/${key}/base`),
    });
  }
  return chars;
}

/* ------------------------------------------------------------------ WORLD
 * TILES 3.0 (`tiles/`) — the ground system being built to replace `tiles2/`.
 *
 * Maintainer 2026-08-16: "The tiles agent is working in what we call Tiles
 * 3.0 … When the new tile system is complete the old /tiles2 will be removed.
 * This however is a big task and we will need the wiki in order to know if
 * /tiles (3.0) works. Can you in the wiki have two tiles systems/pages? Tiles
 * OLD and World? … I will have to review the new system to make it good."
 *
 * So the NEW system takes the good name — the section is **World** — and the
 * outgoing one becomes **Tiles OLD**. Two live domains, side by side, for as
 * long as the migration takes.
 *
 * WHAT HE REVIEWS IS THE CANDIDATE, NOT THE TILE. `tiles/review/manifest.json`
 * (`tiles3/review@1`) is the tiles agent's own contract, written for exactly
 * this: per CELL (a "grass over black rock" pair) it offers 2-3 CANDIDATES
 * ranked by a measured wall score, and says what a verdict means — "`tile_id`
 * is the PixelLab generation a rejection should delete … A DELETED cell is
 * tombstoned and never regenerated, unlike a rejected one."
 *
 * Verdicts therefore ride the manifest's OWN keys (`tiles/<cell>/<n>`) in the
 * `tiles` feedback file, which is the domain the manifest names and the file
 * that agent already reads. Its ids are repo paths, so 3.0's `tiles/…` and
 * 2.0's `tiles2/…` cannot collide even though they share the file.
 */
function buildWorld() {
  const base = join(ROOT, "tiles");
  if (!isDir(base)) return null;
  const review = readJson(join(base, "review", "manifest.json"));
  const cfg = readJson(join(base, "config", "tiles.json")) ?? {};
  const tombs = readJson(join(base, "tombstones.json"));
  // The ground types are the vocabulary — the wiki renders THEIRS, never its
  // own, so a type added in config appears here with no wiki edit.
  const types = new Map((cfg.ground_types ?? []).map((g) => {
    const t = typeof g === "string" ? { id: g } : g;
    return [t.id, t];
  }));
  const label = (id) => types.get(id)?.name ?? titleCase(id);
  const dead = new Set(Array.isArray(tombs?.cells) ? tombs.cells
    : tombs && typeof tombs === "object" ? Object.keys(tombs.cells ?? tombs) : []);
  const cells = [];
  for (const [id, cell] of Object.entries(review?.cells ?? {})) {
    const cands = (cell.candidates ?? [])
      .map((c) => ({
        // The manifest's own key IS the feedback id — no id scheme of the
        // wiki's invention to keep in sync with the agent's.
        key: c.key ?? `tiles/${id}/${c.file?.split("/").pop()?.replace(/\.\w+$/, "")}`,
        art: c.file ? `tiles/${c.file}` : null,
        wallScore: c.wall_score ?? null,
        wall: c.wall ?? null,
        topShare: c.top_share ?? null,
        tileId: c.tile_id ?? null,
        style: c.style ?? null,
        prompt: c.prompt ?? null,
      }))
      .filter((c) => c.art && existsSync(join(ROOT, c.art)));
    if (!cands.length) continue;
    cells.push({
      id,
      // "Grass over Black rock" — the pair, in the order the agent names it:
      // the walkable TOP first, the sideways WALL second.
      name: `${label(cell.top ?? id.split("__over__")[0])} over ${label(cell.side ?? id.split("__over__")[1]).toLowerCase()}`,
      top: cell.top ?? null, side: cell.side ?? null,
      path: `tiles/${id}`,               // the CELL's own feedback id
      preview: cands[0].art,             // the agent's own top-ranked candidate
      candidates: cands,
      best: cands[0].wallScore ?? null,
      tombstoned: dead.has(id),
    });
  }
  cells.sort((a, b) => a.name.localeCompare(b.name));
  worldMeta = {
    // What the agent measures a candidate against, published so the page can
    // say WHY something ranks where it does instead of showing bare numbers.
    accept: cfg.accept ?? null,
    tile: cfg.tile ?? null,
    groundTypes: [...types.values()],
    tombstoned: [...dead],
    schema: review?.schema ?? null,
  };
  return cells;
}
let worldMeta = null;

// ------------------------------------------------------------------- tiles
function buildTiles() {
  const base = join(ROOT, "tiles2");
  if (!isDir(base)) return null;
  const configured = readJson(join(base, "config", "tiles2.json"))?.ground_types;
  const groundTypes = Array.isArray(configured)
    ? configured.map((g) => (typeof g === "string" ? { id: g } : g))
    : listDirs(base).filter((d) => !["config", "pipeline", "docs"].includes(d)).map((id) => ({ id }));
  const types = [];
  for (const { id: gid, name: cfgName, description: cfgDesc } of groundTypes) {
    if (!isDir(join(base, gid))) continue;
    const meta = readJson(join(base, gid, "metadata.json")) ?? {};
    const groups = [];
    const addSheets = (kind, relDir, label) => {
      for (const sheet of listDirs(join(ROOT, relDir))) {
        const tiles = listFiles(join(ROOT, relDir, sheet), artRe("tile_\\d+"));
        if (tiles.length) groups.push({ kind, label, sheet, dir: `${relDir}/${sheet}`, tiles });
      }
    };
    addSheets("base", `tiles2/${gid}/base`, "base");
    for (const sub of listDirs(join(base, gid)).filter((n) => /^base_x_\d+$/.test(n))) {
      addSheets("elevation", `tiles2/${gid}/${sub}`, sub.replace("base_", ""));
    }
    for (const other of listDirs(join(base, gid, "transitions"))) {
      addSheets("transition", `tiles2/${gid}/transitions/${other}`, `→ ${other}`);
    }
    types.push({
      id: gid,
      name: meta.name ?? cfgName ?? titleCase(gid),
      description: meta.description ?? cfgDesc ?? "",
      path: `tiles2/${gid}`,
      tilePx: meta.settings?.size ?? 64,
      groups,
      tileCount: groups.reduce((n, g) => n + g.tiles.length, 0),
    });
  }
  // The MAPS AGENT's own clean-base classification (wiki/clean_base.json,
  // exported from maps2/pipeline/tiles2lib.py by wiki/tools/clean-base.py):
  // `plain` = the one canonical flat tile, `solid` = the small palette it
  // paints regions + cliff walls with, `clean` = the wider clean pool. The
  // wiki badges these and composes tile-instance previews on `plain`.
  const cleanBase = readJson(join(ROOT, "wiki", "clean_base.json"))?.types ?? {};
  for (const t of types) {
    const cb = cleanBase[t.id];
    if (cb) t.cleanBase = { plain: reArt(cb.plain), solid: reArtAll(cb.solid), clean: reArtAll(cb.clean) };
  }
  // INCOMING transitions (maintainer 2026-07-30): a type's page must also list
  // the transitions OTHER types generated toward it, rendered exactly like its
  // own. The art stays owned by the source type (same dir, same feedback ids —
  // rating a tile on either page writes the same entry); `foreign: true` keeps
  // it out of tileCount/sheet counts so nothing is counted twice.
  const byId = Object.fromEntries(types.map((t) => [t.id, t]));
  for (const t of types) {
    for (const g of t.groups) {
      if (g.kind !== "transition" || g.foreign) continue;
      const parts = g.dir.split("/"); // tiles2/<src>/transitions/<target>/<sheet>
      const target = parts[2] === "transitions" ? byId[parts[3]] : null;
      if (target && target !== t) target.groups.push({ ...g, foreign: true, label: `${t.id} →` });
    }
  }
  return types;
}

// ----------------------------------------------------------------- objects
function buildObjects() {
  // The scenery domain (renamed from objects/ 2026-08-12 — scenery agent). The
  // wiki's INTERNAL domain key stays "objects" (route slugs are URLs and
  // feedback ids ride on them); only the disk paths moved.
  // v2 (2026-08-12): pieces live in ranked GROUPS — scenery/<group>/<id>/ —
  // with three legacy pieces still at the top level. A top-level dir carrying
  // scenery.json is a legacy piece; one whose children carry it is a group.
  const base = join(ROOT, "scenery");
  if (!isDir(base)) return null;
  const { path: seenPath, seen } = loadFirstSeen();
  const stamp = new Date().toISOString();
  let seenGrew = 0, artChanged = 0;
  // Returns { at, guess, hash }. `guess` is the load-bearing bit: inside the
  // deploy image there is no git, so a piece missing from the committed cache
  // gets `at` = THE BUILD'S OWN TIME — fine for newest-first sorting, but a
  // LIE as a fact. Round one fed that lie to the staleness rule and every
  // deploy post-dated the newly-landed pieces past the maintainer's fresh
  // verdicts, throwing already-reviewed art back into his queue ("Why do I
  // have to see and review items I have already reviewed?", 2026-08-14, 129
  // pieces deep). A guessed date must never call a verdict stale.
  const firstSeenOf = (rel, spritePath) => {
    let hash = null;
    try { hash = createHash("md5").update(readFileSync(join(ROOT, spritePath))).digest("hex").slice(0, 16); } catch { /* unreadable */ }
    const prev = seen[rel];
    if (prev && hash && prev.hash === hash) return { at: prev.at, guess: false, hash };  // unchanged art keeps its date
    const real = artChangeDates().get(rel);
    const at = real ?? stamp;
    if (prev && hash && prev.hash !== hash) artChanged++;
    seen[rel] = { at, hash };
    seenGrew++;
    return { at, guess: !real, hash };
  };
  const entries = [];
  for (const top of listDirs(base)) {
    if (["config", "pipeline", "spec"].includes(top)) continue;
    const legacy = readJson(join(base, top, "scenery.json"));
    if (legacy) { entries.push([top, null, legacy]); continue; }
    for (const child of listDirs(join(base, top))) {
      const m = readJson(join(base, top, child, "scenery.json"));
      if (m) entries.push([`${top}/${child}`, top, m]);
    }
  }
  // TYPE comes from the scenery domain's own catalog: every group in
  // scenery/config/factory.json carries a `type` (TREE / WINDOW /
  // MOUNTAIN_WALL / TOWN / INDOOR / NATURE / OTHER) so the wiki can offer a
  // type filter without inventing the taxonomy here. A piece may override its
  // group by putting its own `type` in scenery.json — the piece wins, the
  // group is the default, and anything unrecognised falls to OTHER rather
  // than vanishing from every filter.
  const TYPES = ["TREE", "WINDOW", "MOUNTAIN_WALL", "TOWN", "INDOOR", "NATURE", "OTHER"];
  const factory = readJson(join(base, "config", "factory.json")) ?? {};
  const groupType = new Map((factory.groups ?? []).map((g) => [g.id, g.type]));
  const typeOf = (oj, group) => {
    const t = String(oj.type ?? groupType.get(group ?? oj.group) ?? "OTHER").toUpperCase();
    return TYPES.includes(t) ? t : "OTHER";
  };
  const objects = [];
  for (const [rel, group, oj] of entries) {
    const id = rel.split("/").pop();
    const anims = {};
    for (const [key, a] of Object.entries(oj.animations ?? {})) {
      const dirs = {};
      for (const dir of DIRS) {
        const d = a.directions?.[dir];
        if (!d) continue;
        const stripRel = d.strip ?? `${rel}/animations/${key}__${dir}.png`;
        const declared = `scenery/${stripRel.startsWith(rel.split("/")[0] + "/") ? stripRel : `${rel}/animations/${key}__${dir}.png`}`;
        // scenery.json names the file, and it may still say ".png" for a while
        // after the scenery domain converts. Resolve against the DISK, so the
        // wiki doesn't go blank waiting for another agent's metadata edit.
        const strip = art(declared.replace(/\.(png|webp)$/i, ""));
        const frames = d.frames ?? a.frame_count ?? 0;
        if (!frames || !strip) continue;
        const dims = imageSize(join(ROOT, strip));
        dirs[dir] = { frames, strip, fw: dims ? Math.round(dims.w / frames) : oj.size, fh: dims ? dims.h : oj.size };
      }
      if (Object.keys(dirs).length) anims[key] = { description: a.description ?? "", dirs };
    }
    // A STILL IS A ONE-FRAME ANIMATION (maintainer 2026-08-13: "a lot of
    // scenery will not have any animation — or you can think of the image
    // itself as a 'still' animation with only 1 frame … the animation viewer
    // shows the object in its true scale and is a good tool for me to look at
    // the object. We only need this if no real animation exist"). 368 of the
    // 371 pieces are static, so without this the viewer — the one place the
    // wiki draws scenery at its measured size next to everything else — was
    // unreachable for all but three of them. Synthesised only when nothing
    // real exists, and never overwriting a generated animation.
    const preview = art(`scenery/${rel}/sprite`);
    const stillOnly = !Object.keys(anims).length && !!preview;
    if (stillOnly) {
      // A still can face more than one way. Since 2026-08-14 the scenery domain
      // ships a `rotations` map (south / south-east / south-west so far) beside
      // the sprite, and the maintainer reviews the DIRECTIONS a piece has, not
      // just its front: "the animation preview should make it possible to
      // review the directions the Scenery has". Each rotation becomes its own
      // one-frame clip, so the viewer's existing direction pad — which shows
      // exactly the directions that have a clip — does the rest untouched.
      // Paths in `rotations` are relative to scenery/ and the extension is
      // resolved against the disk, same as the animation strips above.
      const dirsFrom = (rotations, spriteRel) => {
        const pick = (p) => art(`scenery/${String(p).replace(/\.(png|webp)$/i, "")}`);
        const out = {};
        for (const dir of DIRS) {
          const strip = rotations?.[dir] != null ? pick(rotations[dir])
            : (dir === "south" && spriteRel ? pick(spriteRel) : null);
          if (!strip) continue;
          const dims = imageSize(join(ROOT, strip));
          if (dims) out[dir] = { frames: 1, strip, fw: dims.w, fh: dims.h };
        }
        return out;
      };
      // STATES (scenery domain, 2026-08-14): a piece can now exist in more than
      // one condition — LIGHTS_ON / LIGHTS_OFF today, each with its own sprite
      // and its own rotations. Each becomes a state in the viewer, exactly like
      // a monster's idle/walk/angry, so the maintainer switches between them
      // with the same control in the same place. The piece's own `lights` value
      // names the state the base sprite is in, and that one leads.
      // ORDER: the state that IS the piece's own sprite leads, because that is
      // the picture every card, thumbnail and review queue shows — opening the
      // viewer on a different one would mean judging a picture you did not
      // click. The scenery agent's naming is not fixed (LIGHTS_ON/LIGHTS_OFF
      // on windows, LIT_1..NOT_LIT_5 on trees since 2026-08-14), so this
      // matches on the FILE, falling back to the `lights` value and then to
      // whatever order the manifest lists.
      const states = Object.entries(oj.states ?? {}).filter(([, st]) => st && typeof st === "object");
      // THE BASE STATE IS THE ONE THE CARD SHOWS. Matched by CONTENT, not by
      // path: the scenery agent sometimes points a state at the piece's own
      // sprite.webp (tree_001) and sometimes writes an identical copy under
      // its own folder (most trees) — the same picture either way, and opening
      // the viewer on a different variant than the thumbnail you clicked means
      // judging art you did not choose.
      const fileHash = (rel) => {
        if (!rel) return null;
        try { return createHash("md5").update(readFileSync(join(ROOT, rel))).digest("hex"); } catch { return null; }
      };
      const previewHash = preview ? fileHash(preview) : null;
      const stateArt = ([, st]) => art(`scenery/${String(st.sprite ?? "").replace(/\.(png|webp)$/i, "")}`);
      const isBase = (e) => {
        const a = stateArt(e);
        return !!a && (a === preview || (!!previewHash && fileHash(a) === previewHash));
      };
      // AND IN A READABLE ORDER. The manifest lists them however they were
      // generated (NOT_LIT_1, LIT_1, LIT_2, NOT_LIT_2, NOT_LIT_3…), which the
      // wiki was rendering verbatim — a row that jumps between unlit and lit
      // and back. Unlit first, ascending, then lit, ascending, so the chips
      // read "#1 #2 #3 💡#1 💡#2". The base still leads: it is the picture
      // every card shows, and it is the unlit #1 in practice.
      const rank = ([n]) => {
        const m = /^(not[_-]?lit|lit|lights[_-]?off|lights[_-]?on)(?:[_-]?(\d+))?$/i.exec(n);
        if (!m) return [2, 0, n];
        const lit = /^lit/i.test(m[1]) || /on$/i.test(m[1]);
        return [lit ? 1 : 0, Number(m[2] ?? 1), n];
      };
      const byVariant = (a, b) => {
        const [al, an, ak] = rank(a), [bl, bn, bk] = rank(b);
        return al - bl || an - bn || ak.localeCompare(bk);
      };
      const rest = states.filter((e) => !isBase(e)).sort(byVariant);
      const base = states.filter(isBase);
      const ordered = [...base, ...rest];
      // A handful of pieces (4 of 110 on 2026-08-15) carry a sprite.webp that is
      // none of their states — the original render the variants were grown
      // from, and the one the GAME still places. It leads the row as "Base" so
      // the canonical art is reviewable at all; without it the viewer opened on
      // variant #1 while the card, the queue and the game showed something else.
      if (states.length && !base.length && preview) {
        const dirs = dirsFrom(oj.rotations, `${rel}/sprite`);
        if (Object.keys(dirs).length) anims.base = { description: "", dirs };
      }
      for (const [name, st] of ordered) {
        const dirs = dirsFrom(st.rotations, st.sprite);
        // The UI title-cases this; the CAPS key is the scenery domain's.
        if (Object.keys(dirs).length) anims[name.toLowerCase()] = { description: st.edit_description ?? "", dirs };
      }
      if (!Object.keys(anims).length) {
        const dirs = dirsFrom(oj.rotations, `${rel}/sprite`);
        if (Object.keys(dirs).length) {
          // Named "static" because the viewer ALWAYS shows a state row now —
          // one button reading "Static" for a piece with nothing else, so the
          // preview sits at the same height on every piece while paging
          // (maintainer 2026-08-14: "always render a state even if the state
          // only has Static … otherwise the preview will jump up and down when
          // I press next next next").
          anims.static = { description: "", dirs };
        }
      }
    }
    objects.push({
      id,
      name: oj.name ?? titleCase(id),
      category: group ?? oj.category ?? "misc",
      type: typeOf(oj, group),
      lights: oj.lights ?? null,
      description: oj.description ?? oj.prompt ?? "",
      path: `scenery/${rel}`,
      preview,
      // So the page can say "Still" rather than claim an animation, and the
      // list can keep calling these "static". A piece with LIGHTS_ON/LIGHTS_OFF
      // states is still static — its clips are synthesised sprites, not frames
      // — so this asks whether anything was SYNTHESISED, not for the `still`
      // key specifically.
      stillOnly: stillOnly && Object.keys(anims).length > 0,
      // When the art that is there NOW arrived, plus its content hash — the
      // hash is what a verdict is really ABOUT, and wiki.js stamps it into
      // every new verdict so staleness is byte-exact from here on. addedGuess
      // marks a date the deploy image had to invent (no git there); the
      // staleness rule must never trust one.
      ...(() => {
        if (!preview) return { added: null, addedGuess: false, artHash: null };
        const f = firstSeenOf(`scenery/${rel}`, preview);
        return { added: f.at, addedGuess: f.guess, artHash: f.hash };
      })(),
      size: oj.size ?? null,
      placement: oj.placement ?? null,
      animations: anims,
    });
  }
  if (seenGrew) {
    try {
      writeFileSync(seenPath, JSON.stringify({
        format: "pixel-wiki-first-seen@1",
        note: "when the art now at each path arrived, keyed by its sprite hash — a changed hash means new art, and any older verdict is about a piece that no longer exists",
        entries: Object.fromEntries(Object.entries(seen).sort(([a], [b]) => a.localeCompare(b))),
      }, null, 0) + "\n");
    } catch { /* read-only fs — data.json already carries the dates */ }
  }
  if (artChanged) console.log(`[wiki] scenery: ${artChanged} piece(s) have NEW art at an existing path — any earlier verdict on them is now flagged for re-review`);
  return objects;
}

// ------------------------------------------------------------------- audio
function audioSiblings(relWav) {
  // Every mastered take ships wav + ogg + m4a side by side; the wiki prefers
  // the small streaming formats.
  const out = { wav: relWav };
  for (const ext of ["ogg", "m4a"]) {
    const p = relWav.replace(/\.wav$/, `.${ext}`);
    if (isFile(join(ROOT, p))) out[ext] = p;
  }
  return out;
}

function buildSounds() {
  const base = join(ROOT, "sounds");
  if (!isDir(base)) return null;
  const sounds = [];
  for (const cat of listDirs(base)) {
    if (["config", "pipeline", "spec"].includes(cat)) continue;
    for (const id of listDirs(join(base, cat))) {
      const meta = readJson(join(base, cat, id, "metadata.json"));
      if (!meta) continue;
      const takes = (meta.takes ?? [meta.file]).filter(Boolean).map((rel) => {
        const relPath = `sounds/${rel}`;
        return {
          id: rel.replace(/^.*\//, "").replace(/\.wav$/, ""),
          chosen: rel === meta.file,
          dur: wavDuration(join(ROOT, relPath)),
          files: audioSiblings(relPath),
        };
      }).filter((t) => isFile(join(ROOT, t.files.wav)));
      sounds.push({
        id: meta.id ?? id,
        name: meta.name ?? titleCase(id),
        category: meta.category ?? cat,
        description: meta.description ?? "",
        usage: meta.usage ?? "",
        feel: meta.feel ?? "",
        loop: !!meta.loop,
        duration_s: meta.audio?.duration_seconds ?? null,
        path: `sounds/${cat}/${id}`,
        takes,
      });
    }
  }
  return sounds;
}

function buildMusic() {
  const base = join(ROOT, "music");
  if (!isDir(base)) return null;
  // Prefer the domain's own rollup (viewer_data.json — same source the game's
  // composer reads); fall back to the nested music.metadata/v1 fields.
  const rollup = Object.fromEntries(
    (readJson(join(base, "viewer_data.json"))?.tracks ?? []).map((t) => [t.id, t]));
  const tracks = [];
  for (const id of listDirs(base)) {
    if (["config", "pipeline"].includes(id)) continue;
    const meta = readJson(join(base, id, "metadata.json"));
    if (!meta) continue;
    const roll = rollup[meta.id ?? id] ?? {};
    const wav = `music/${roll.file ?? meta.audio?.file ?? `${id}/${id}.wav`}`;
    tracks.push({
      id: meta.id ?? id,
      name: roll.name ?? meta.name ?? titleCase(id),
      use: roll.use ?? meta.intent?.use ?? "",
      feeling: roll.feeling ?? meta.intent?.feeling ?? [],
      duration_s: roll.duration_s ?? meta.audio?.duration_s ?? null,
      bpm: roll.bpm ?? meta.musical?.tempo_bpm ?? null,
      key: roll.key ?? meta.musical?.key ?? null,
      loopable: !!(roll.loopable ?? meta.loop?.loopable),
      path: `music/${id}`,
      files: audioSiblings(wav),
    });
  }
  return [...tracks, ...buildComposerMusic()];
}

/* The COMPOSER's own score (games2/composer/music/tracks.json,
   `composer-music@1`). Two sources make the game's music and the page listed
   only one, so the five context beds the composer generated on 2026-08-05
   were invisible (maintainer 2026-08-06: "he did 5 new songs and you are
   listing nothing but the old 2"). These are not the music DOMAIN's tracks —
   different owner, different folder, different manifest — so they carry
   `source: "composer"` and their feedback goes to the composer.

   WHAT PLAYS TODAY is deliberately a separate axis from what EXISTS: the
   context score is generated but dormant (games2/CLAUDE.md — the maintainer
   picks what plays where before it is wired), so a bed's `routed` flag says
   plainly whether the game can currently reach it. */
const BED_ROLE = {
  title: { when: "The title and character-select screen", live: true },
  night: { when: "In the world, after dark — cross-faded by the sun", live: true },
  battle: { when: "A real fight: a monster actually chasing or fighting you", live: false },
  cave: { when: "Under a deck slab — inside the mountain", live: false },
  home: { when: "Near the spawn bonfire", live: false },
  town: { when: "Standing on roads and farm tiles", live: false },
  adventure: { when: "Everywhere else — the default bed", live: false },
};
function buildComposerMusic() {
  const dir = composerDir() ? join(composerDir(), "music") : null;
  const doc = dir ? readJson(join(dir, "tracks.json")) : null;
  if (!doc?.tracks) return [];
  // A bed the composer added that this build has no role text for is still
  // LISTED (never hidden), just without the routing line — and it warns, the
  // same contract as the sfx drift sentinel.
  for (const id of Object.keys(doc.tracks)) if (!BED_ROLE[id]) sfxDrift.push(`composer music "${id}" has no role in BED_ROLE`);
  return Object.entries(doc.tracks).map(([id, t]) => {
    const files = {};
    for (const f of t.files ?? []) {
      const ext = (f.file.split(".").pop() ?? "").toLowerCase();
      files[ext] = `composer/music/${f.file}`;
    }
    const role = BED_ROLE[id] ?? {};
    return {
      id, name: titleCase(id), source: "composer",
      use: role.when ?? "",
      routed: !!role.live,
      feeling: (t.sections ?? []).flatMap((s) => s.styles ?? []).slice(0, 6),
      sections: (t.sections ?? []).map((s) => s.name).filter(Boolean),
      duration_s: t.duration_s ?? null,
      bpm: t.bpm != null ? Math.round(t.bpm) : null,
      key: t.musical?.root ? { root: t.musical.root, mode: t.musical.mode } : null,
      loopable: !!t.loop,
      loopStart: t.loop?.loop_start_s ?? null,
      loopEnd: t.loop?.loop_end_s ?? null,
      lufs: t.measured?.lufs ?? null,
      path: `composer/music/${id}`,
      files,
    };
  });
}

// -------------------------------------------------------------------- items
let itemTypes = null, itemRarities = null;
function buildItems() {
  // The items agent's rolled-up registry is the catalog; a per-folder scan is
  // the fallback so a half-synced domain still shows something.
  const base = join(ROOT, "items");
  if (!isDir(base)) return [];
  const reg = readJson(join(base, "viewer_data.json"));
  if (reg?.items) {
    itemTypes = reg.types ?? null;
    itemRarities = reg.rarities ?? null;
    return reg.items;
  }
  const items = [];
  for (const id of listDirs(base)) {
    if (["config", "pipeline"].includes(id)) continue;
    const ij = readJson(join(base, id, "item.json"));
    if (ij) items.push({ id, name: ij.name ?? titleCase(id), description: ij.description ?? "", path: `items/${id}`, preview: art(`items/${id}/sprite`) });
  }
  return items;
}

// ------------------------------------------------- the DROP MAPPING (join)
// Which monster drops which item lives in live/tuning/monsters.json `loot[]`
// — the maintainer's live-tuning file, edited from the wiki's monster page,
// and the ONE source of truth (items/ deliberately keeps no copy; see
// items/README.md). Both directions of the join are precomputed here so no
// page has to scan 24 monsters × 105 items at render time:
//   item.droppedBy = [{ monster, name, chance }]  sorted best chance first
//   monster loot rows resolve to an item name/sprite/value on the page
// A SOULSTONE is a monster's card, bound 1-to-1 — every stone is literally
// named "Soulstone", so its bound creature is the only thing that tells two
// stones apart, and the wiki must always show it. `soulOf` records that
// binding, and the 1-to-1 rule is VERIFIED here rather than assumed: if the
// data ever breaks it, the page shows every source instead of silently
// picking one.
function joinDrops(items, tuning) {
  const byId = new Map((items ?? []).map((it) => [it.id, it]));
  const sources = new Map();   // item id -> [{ monster, chance }]
  const dangling = [];
  for (const [mid, stats] of Object.entries(tuning?.monsters ?? {})) {
    const seen = new Set();
    for (const row of stats?.loot ?? []) {
      const id = row?.item;
      if (!id || seen.has(id)) continue;            // a duplicate row is one drop
      seen.add(id);
      if (!byId.has(id)) { dangling.push(`${mid} → ${id}`); continue; }
      const chance = Number(row.chance);
      if (!Number.isFinite(chance) || chance <= 0) continue;
      if (!sources.has(id)) sources.set(id, []);
      sources.get(id).push({ monster: mid, chance: Math.min(1, chance) });
    }
  }
  let bound = 0, unbound = 0, multi = 0;
  for (const it of items ?? []) {
    const src = (sources.get(it.id) ?? []).sort((a, b) => b.chance - a.chance || a.monster.localeCompare(b.monster));
    it.droppedBy = src;
    if (it.type === "SOUL") {
      // 1-to-1 or UNBOUND — asserted, not trusted.
      it.soulOf = src.length === 1 ? src[0].monster : null;
      if (src.length === 1) bound++; else if (src.length === 0) unbound++; else multi++;
    }
  }
  return { dangling, bound, unbound, multi, dropped: sources.size };
}

// --------------------------------------------------------------------- lore
// The lore agent's rollup is one file, like items/viewer_data.json. `entities`
// is a LOOKUP TABLE, never a list to iterate: data.json is rebuilt from the
// live domains on every deploy while lore.json only changes when the lore
// agent next runs, so between a monster being deleted and that run lore.json
// still names an id we no longer have.
let loreEntities = {}, loreMeta = null;
function buildLore() {
  const doc = readJson(join(ROOT, "lore", "lore.json"));
  if (!doc) return null;
  loreEntities = doc.entities ?? {};
  const rl = join(ROOT, "lore", "RED_LINE.md");
  loreMeta = {
    generated_at: doc.generated_at ?? null,
    default_icon: doc.default_icon ?? null,
    layout_budget: doc.layout_budget ?? null,
    // A MARKER ONLY, never the contents: 26 KB of Game-Master markdown must not
    // ride in a file every player fetches on every load. The page fetches it.
    redLine: isFile(rl) ? { path: "lore/RED_LINE.md", bytes: statSync(rl).size } : null,
    // v2: how much of the backbone the published texts actually tell — counts
    // only ({revealed, hinted, hidden}); the beat-by-beat map stays in
    // lore/canon/revelations.json, which is the GM's file, not the player's.
    redLineProgress: doc.red_line_progress ?? null,
  };
  return (doc.entries ?? [])
    // Normalise ONCE so no view can reach an undefined chapter or an unnamed
    // icon. `chapter` is always an own property; null means "not a chapter".
    .map((e) => ({ ...e, chapter: Number.isInteger(e.chapter) ? e.chapter : null, icon: e.icon || doc.default_icon || null }))
    // The lore build's own key: non-chapters land after the numbered ones.
    // This is the ONE ordering authority — the site never re-sorts.
    .sort((a, b) => (a.chapter ?? 999) - (b.chapter ?? 999) || String(a.id).localeCompare(String(b.id)));
}

// --------------------------------------------------------------- constants
function buildConstants() {
  // Read-only discovery of `export const NAME = <number literal>` in
  // games2/shared — the catalog the wiki's tuning page lists. Overrides the
  // maintainer sets live in live/tuning/constants.json (advisory until the
  // games agent wires them in).
  const rels = ["src/index.ts", "src/surfaces.ts", "src/monsters.ts", "src/units.ts"];
  const consts = [];
  for (const rel of rels) {
    const file = join(GAMES2, "shared", rel);
    if (!isFile(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = line.match(/^export const ([A-Z][A-Z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*[;,]?\s*(?:\/\/\s*(.*))?$/);
      if (!m) return;
      let desc = m[3] ?? "";
      if (!desc) {
        const prev = lines[i - 1]?.trim() ?? "";
        if (prev.startsWith("//")) desc = prev.replace(/^\/\/\s*/, "");
      }
      consts.push({ name: m[1], value: Number(m[2]), source: `games2/shared/${rel}`, line: i + 1, description: desc });
    });
  }
  return consts;
}

// -------------------------------------------- usage in the DEFAULT world
// The world the game actually drops players into is the honest answer to
// "is this really in the game?" — so every usage stat below is measured on
// it (games2/client/src/maps.ts DEFAULT_WORLD, read so it can't drift).
function defaultWorldName() {
  const src = (() => { try { return readFileSync(join(GAMES2, "client", "src", "maps.ts"), "utf8"); } catch { return ""; } })();
  return /DEFAULT_WORLD\s*=\s*"([^"]+)"/.exec(src)?.[1] ?? "the_island2";
}
function buildWorldUsage() {
  const name = defaultWorldName();
  const dir = join(ROOT, "maps2", "worlds", name);
  const world = readJson(join(dir, "world.json"));
  if (!world) return null;
  const paths = world.paths ?? [];
  // PLACEMENTS per tile: cells whose surface tile is this one, plus props.
  // (A raised cell also stacks its tile for the cliff faces — that's the same
  // placement seen from the side, not a second use.)
  const counts = new Array(paths.length).fill(0);
  let cells = 0;
  for (const row of world.top ?? []) {
    for (const idx of row) if (idx >= 0 && idx < paths.length) { counts[idx]++; cells++; }
  }
  let props = 0;
  for (const p of world.props ?? []) {
    if (p?.tile >= 0 && p.tile < paths.length) { counts[p.tile]++; props++; }
  }
  const tiles = {};
  paths.forEach((p, i) => { if (counts[i]) tiles[p] = counts[i]; });

  // Monsters: spawns@1 zones carry a roster id + how many to seed.
  const monsters = {};
  for (const z of readJson(join(dir, "spawns.json"))?.zones ?? []) {
    if (!z?.monster) continue;
    const m = monsters[z.monster] ?? (monsters[z.monster] = { spawned: 0, zones: 0 });
    m.spawned += Number(z.num) || 0;
    m.zones += 1;
  }
  // NPCs: maps2 stands a cast in the world (npcs@1) and keys each one by the
  // characters2 FOLDER id, which is exactly this build's NPC id — so the join
  // needs no translation table.
  const npcs = {};
  for (const n of readJson(join(dir, "npcs.json"))?.npcs ?? []) {
    if (!n?.character) continue;
    (npcs[n.character] ??= []).push({ id: n.id ?? "", type: n.type ?? "", anchor: n.anchor ?? "", wares: n.wares ?? [] });
  }
  // Spawn zones and the NPC cast projected onto the world's minimap
  // (wiki/world_map.json, written by wiki/tools/world-map.py) — the monster
  // pages' "where it lives" map and the NPC pages' "where you'll find them".
  // Only used when it describes THIS world.
  const wm = readJson(join(ROOT, "wiki", "world_map.json"));
  const map = wm?.world === name
    ? { minimap: reArt(wm.minimap), mapW: wm.mapW, mapH: wm.mapH, proj: wm.proj,
        monsters: wm.monsters ?? {}, npcs: wm.npcs ?? {} }
    : null;

  return {
    name, w: world.size?.w ?? null, h: world.size?.h ?? null,
    cells, props, distinctTiles: Object.keys(tiles).length,
    tiles, monsters, npcs, map,
  };
}

/* ------------------------------------------------- sfx: the game's EVENTS
   The Sound Effects page is organized by IN-GAME EVENT (maintainer
   2026-08-05): what triggers a sound, which sounds play (layered, or
   alternating takes), and with exactly which processing. The authority is
   the COMPOSER's engine (games2/composer/engine/api.ts + oneshot.ts) — the
   sound domain's bindings.json is only its input — so this builder derives
   the table from the same sources the engine compiles from:

   - sounds/bindings.json events[]  (the catalog bindings)
   - gameAudio.event("...") call sites in the game client (what is EMITTED —
     an emitted event with no sound is a real, listable thing)
   - the composer's own takeover tables, parsed out of api.ts (EVENT_FOLEY,
     the JUMP_VOICE sets, the FOOTSTEP_* routing/trim/layer tables)

   The parse is a DRIFT SENTINEL like the sidecar one: the composer owns
   those constants and edits them freely, so every regex miss is collected
   and printed loudly rather than silently shipping a stale event table.
   (Board request filed for a published composer/events.json to replace the
   parsing; until then the wiki reads the truth out of the source.) */
const sfxDrift = [];
function tsScalar(src, name, dflt) {
  const m = src.match(new RegExp(`const ${name}(?:\\s*:[^=]+)?\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`));
  if (!m) { sfxDrift.push(`const ${name} not found`); return dflt; }
  return Number(m[1]);
}
function tsRecord(src, name) {
  const m = src.match(new RegExp(`const ${name}(?:\\s*:[^=]+)?\\s*=\\s*\\{([\\s\\S]*?)\\};`));
  if (!m) { sfxDrift.push(`const ${name} not found`); return null; }
  const body = m[1].replace(/\/\/[^\n]*/g, "");
  const out = {};
  const entry = /(?:"([^"]+)"|([$\w.]+))\s*:\s*(?:"([^"]+)"|(-?\d+(?:\.\d+)?)|(\{[^{}]*\}))/g;
  for (let e; (e = entry.exec(body)); ) {
    const key = e[1] ?? e[2];
    if (e[3] != null) out[key] = e[3];
    else if (e[4] != null) out[key] = Number(e[4]);
    else {
      const inner = {};
      const sub = /([$\w]+)\s*:\s*(?:"([^"]+)"|(-?\d+(?:\.\d+)?))/g;
      for (let s; (s = sub.exec(e[5])); ) inner[s[1]] = s[2] ?? Number(s[3]);
      out[key] = inner;
    }
  }
  if (!Object.keys(out).length) sfxDrift.push(`const ${name} parsed empty`);
  return out;
}
/** `new Set<string>([...])` in the engine source. */
function tsSet(src, name) {
  const m = src.match(new RegExp(`const ${name}(?:\\s*:[^=]+)?\\s*=\\s*new Set<[^>]*>\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) { sfxDrift.push(`const ${name} not found`); return new Set(); }
  return new Set([...m[1].replace(/\/\/[^\n]*/g, "").matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}
/** The engine's own splitComposerId: an assignment may name a set OR one
 *  recording inside it ("composer/punch", "composer/punch/punch__take02",
 *  "composer/punch#take02", or a separate `take`). */
function splitComposerId(id, take) {
  const body = id.slice("composer/".length);
  const cut = body.search(/[#/]/);
  return cut >= 0 ? { set: body.slice(0, cut), take: body.slice(cut + 1) } : { set: body, take };
}
/** Resolve `take` against a layer's recordings, matching the engine: a bare
 *  index is 1-based, a name matches with or without the `<set>__` prefix and
 *  extension. A take that is NOT there resolves to SILENCE — never to a
 *  neighbouring recording, or a deleted take would quietly become a different
 *  sound (api.ts says so explicitly, and the wiki must show the same). */
function pickTake(takes, take) {
  if (take == null || take === "") return takes;
  if (typeof take === "number") return takes[take - 1] ? [takes[take - 1]] : [];
  const want = String(take).replace(/\.\w+$/, "");
  if (/^\d+$/.test(want)) return takes[Number(want) - 1] ? [takes[Number(want) - 1]] : [];
  const hit = takes.find((t) => {
    const n = t.name.replace(/\.\w+$/, "");
    return n === want || n.endsWith(`__${want}`) || t.file.replace(/\.\w+$/, "").endsWith(want);
  });
  return hit ? [hit] : [];
}
/** The composer source, wherever this build runs: repo (games2/composer) or
 *  the Docker image (/assets/composer — Dockerfile copies foley/ there; the
 *  engine sources are only in the repo, so inside Docker the parse would come
 *  up empty. The committed data.json is built in-repo, and Docker's rebuild
 *  keeps the committed sfx block when the sources are absent — see below). */
function composerDir() {
  for (const p of [join(GAMES2, "composer"), join(ROOT, "composer")]) if (isDir(p)) return p;
  return null;
}
/** Content hash, memoised — the ONLY way to tell a pool candidate that was
 *  promoted to a take from one that was passed over: the promotion is a plain
 *  file copy under a new name, so the paths never match and the bytes always
 *  do. Reading the whole foley pool costs ~8 MB once per build, and only the
 *  in-repo build pays it (Docker keeps the committed sfx block). */
const hashCache = new Map();
function fileHash(p) {
  if (!hashCache.has(p)) {
    let v = null;
    try { v = createHash("md5").update(readFileSync(p)).digest("hex"); } catch { /* absent */ }
    hashCache.set(p, v);
  }
  return hashCache.get(p);
}
function buildSfx(soundEntries, entityIds = {}) {
  const cat = readJson(join(ROOT, "sounds", "viewer_data.json"))?.sounds ?? [];
  const catById = new Map(cat.map((s) => [s.id, s]));
  const bindings = readJson(join(ROOT, "sounds", "bindings.json")) ?? {};
  const comp = composerDir();
  const apiSrc = comp ? (() => { try { return readFileSync(join(comp, "engine", "api.ts"), "utf8"); } catch { return ""; } })() : "";
  const oneSrc = comp ? (() => { try { return readFileSync(join(comp, "engine", "oneshot.ts"), "utf8"); } catch { return ""; } })() : "";
  if (!apiSrc) {
    // No engine source to read (the Docker rebuild): keep the committed table.
    const prev = readJson(OUT)?.sfx ?? readJson(join(WIKI_DIR, "site", "data.json"))?.sfx;
    if (prev) return prev;
    sfxDrift.push("composer engine sources unavailable and no committed sfx to keep");
    return null;
  }

  // ---- engine constants the wiki's player mirrors (each pinned to source) --
  const gentleM = oneSrc.match(/const gentle = sound\.urls \? 1 : ([\d.]+)/);
  if (!gentleM) sfxDrift.push("gentle factor not found in oneshot.ts");
  if (!/gainDb: \(opts\.gainDb \?\? 0\) - 12,/.test(apiSrc)) sfxDrift.push("the −12 dB EVENT_FOLEY trim moved in api.ts");
  const engine = {
    gentle: gentleM ? Number(gentleM[1]) : 0.35,
    debounceMs: 30,
    busDb: { ui: -12, sfx: -14, music: -20, ambience: -24, ...(bindings.buses ?? {}) },
    uiTrimDb: -12,
    voiceGainDb: tsScalar(apiSrc, "JUMP_VOICE_GAIN_DB", -12),
    stepBaseDb: -8,
    walkPenaltyDb: tsScalar(apiSrc, "WALK_PENALTY_DEFAULT_DB", -3),
    runBonusDb: 0.8,
    wetStepRate: tsScalar(apiSrc, "WET_STEP_RATE", 1.15),
  };
  if (!/gainDb: -8 \+ \(FOOTSTEP_TRIM_DB/.test(apiSrc)) sfxDrift.push("the −8 dB step base moved in api.ts");

  // ---- composer takeover tables ----
  const EVENT_FOLEY = tsRecord(apiSrc, "GameAudio\\.EVENT_FOLEY|EVENT_FOLEY") ?? {};
  // The Game Master's own assignments — the engine's FIRST lookup, and the
  // one this build used to miss entirely (see resolveEvent below).
  //
  // READ THE COMPOSER'S PUBLISHED MANIFEST, not their source. games-audio ship
  // `composer/assignments.json` (pixel-composer-assignments@1) generated by
  // their own build-assignments.mjs, and their verify-quiet gate fails if it
  // drifts from the engine — so it "cannot go stale on you the way an api.ts
  // regex can" (their words, 2026-08-06). Proven the same day: a regex on
  // `const assigned = EVENT_ASSIGNMENTS[name]` broke the moment they added
  // per-character voices, which is a table this wiki was reading correctly.
  // The source parse stays as a fallback so an unbuilt manifest degrades to
  // stale-but-present rather than to a page claiming everything is silent.
  const assignDoc = comp ? readJson(join(comp, "assignments.json")) : null;
  const EVENT_ASSIGN = assignDoc?.events ?? tsRecord(apiSrc, "EVENT_ASSIGNMENTS") ?? {};
  if (!assignDoc?.events) sfxDrift.push("composer/assignments.json missing or malformed — fell back to parsing api.ts");
  const BIND_OK = tsSet(apiSrc, "BINDINGS_APPROVED");
  if (!/EVENT_ASSIGNMENTS\[/.test(apiSrc)) sfxDrift.push("EVENT_ASSIGNMENTS is no longer consulted by the engine");
  if (!/if \(!BINDINGS_APPROVED\.has\(name\)\) return;/.test(apiSrc)) sfxDrift.push("the BINDINGS_APPROVED gate moved in api.ts");
  const FOOT_SETS = tsRecord(apiSrc, "FOOTSTEP_SETS") ?? {};
  const FOOT_CAT = tsRecord(apiSrc, "FOOTSTEP_CATALOG") ?? {};
  const FOOT_TRIM = tsRecord(apiSrc, "FOOTSTEP_TRIM_DB") ?? {};
  const FOOT_LP = tsRecord(apiSrc, "FOOTSTEP_LOWPASS_HZ") ?? {};
  const FOOT_RATE = tsRecord(apiSrc, "FOOTSTEP_RATE") ?? {};
  const FOOT_LAYER = tsRecord(apiSrc, "FOOTSTEP_LAYER") ?? {};
  const JUMP_VOICE = tsRecord(apiSrc, "JUMP_VOICE") ?? {};
  const footDefault = apiSrc.match(/const FOOTSTEP_DEFAULT = "([^"]+)"/)?.[1] ?? (sfxDrift.push("FOOTSTEP_DEFAULT not found"), "stone");

  // ---- composer's own foley sets (takes on disk, served at /assets/composer) --
  const foleyDir = comp ? join(comp, "foley") : null;
  const foleyMeta = foleyDir ? readJson(join(foleyDir, "foley.json")) ?? {} : {};
  const composerSets = {};
  for (const [set, meta] of Object.entries(foleyMeta)) {
    if (!meta?.takes) continue;
    composerSets[set] = {
      takes: meta.takes.map((t, i) => ({
        name: t.split("/").pop(),
        file: `composer/foley/${t}`,
        dur: meta.durations_s?.[i] ?? null,
      })),
      // ---- THE GENERATION POOL — the takes' unpicked siblings ----------
      // The composer generates a POOL per brief, scores it and copies the
      // winner(s) out as takes; 23 of the 91 sets kept their pool on disk.
      // That is 130 more files nothing ever listed — and of those, 91 are
      // audio that existed NOWHERE in the wiki (the other 39 are byte
      // copies of the take that was chosen out of them, hence the hash
      // dedupe: same bytes at two paths must never become two rows).
      // They ship because the score answers "does this fit the brief it was
      // generated for", which is a DIFFERENT question from "is this the
      // sound I want for my event" — a candidate rejected as a grass
      // footstep is still a fine rustle for an item pickup, and only the
      // Game Master can say so (maintainer 2026-08-06: "Every single
      // generated sound?"). Best-scoring first; `rank` ascends.
      alts: (() => {
        const takeBytes = new Set(meta.takes.map((t) => fileHash(join(foleyDir, t))).filter(Boolean));
        return (meta.pool_candidates ?? [])
          .filter((c) => c?.file && !takeBytes.has(fileHash(join(foleyDir, c.file))))
          .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
          .map((c) => ({
            name: c.file.split("/").pop(),
            file: `composer/foley/${c.file}`,
            dur: c.features?.duration_s ?? null,
          }));
      })(),
      voice: set.startsWith("jump_voice"),
      // When the composer generated this set — the ONLY real "date added" in
      // the project, and it is per SET, so every take and candidate in the
      // folder shares it. The sound catalog carries no timestamp anywhere
      // (checked: neither viewer_data.json nor any metadata.json), so those
      // sort last rather than being given a made-up date. File mtimes are NOT
      // a substitute: a fresh clone and the Docker build stamp them all alike.
      added: meta.generated_at ?? null,
      usedBy: [],
    };
  }
  const useSet = (set, why) => { const s = composerSets[set]; if (s && !s.usedBy.includes(why)) s.usedBy.push(why); };

  // ---- what the game actually EMITS (an event nobody emits is "wired, not
  //      fired"; an emitted event with no sound is "silent") ----
  const emitted = new Set();
  // Static prefixes of DYNAMIC event names (see the template-literal scan
  // below): "monsters." means every `monsters.<kind>.<action>` is fired.
  const emittedPrefixes = new Set();
  for (const f of [...walkTs(join(GAMES2, "client", "src")), ...walkTs(join(comp ?? "", "engine"))]) {
    const src = (() => { try { return readFileSync(f, "utf8"); } catch { return ""; } })();
    // COMMENTS ARE NOT CALL SITES: api.ts's own doc header shows
    // `audio.event("ui.confirm")` as an example, which made a never-fired
    // event read as live to players (maintainer 2026-08-05). Filtered per
    // LINE — a whole-file comment strip is a trap, because one unmatched
    // /* inside a string or regex literal swallows real code after it.
    for (const line of src.split("\n")) {
      const t = line.trimStart();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      for (const m of line.matchAll(/(?:gameAudio|audio)\.event\(\s*["']([^"']+)["']/g)) {
        if (line.slice(0, m.index).includes("//")) continue;
        emitted.add(m[1]);
      }
      // DYNAMIC names. A PER-ENTITY event cannot be a literal — the game fires
      // `monsters.${mv.kind}.${action}` once per gait cycle, per swing, per
      // growl (WorldScene.monsterSfx). A literal-only scan called every one of
      // those "not fired yet", i.e. told the Game Master that the sound he had
      // just bound to Sprigling could never be heard, while the game played it
      // on every step. The static PREFIX before the first ${ is the family.
      for (const m of line.matchAll(/(?:gameAudio|audio)\.event\(\s*`([^`$]*)\$\{/g)) {
        if (line.slice(0, m.index).includes("//")) continue;
        if (m[1].includes(".")) emittedPrefixes.add(m[1]);
      }
    }
  }
  /** Does the game fire this event? A literal call site, or a dynamic one
   *  whose static prefix this id falls under. */
  const isEmitted = (id) => emitted.has(id) || [...emittedPrefixes].some((p) => id.startsWith(p));
  // Sounds the ENGINE drives without a semantic event() call — the ambience
  // beds (region changes via setEnv) and the water-entry splash (avatarFrame).
  // They play in the real game every session; hiding them from players as
  // "never fired" would be the opposite of the truth.
  // Fired by the engine through its OWN method, not a `gameAudio.event("…")`
  // call site the emitted-scan can see: thunder() on every lightning strike,
  // star() on every shooting star. They became assignable 2026-08-06, and
  // without this they land on the assignment path and read "not fired yet" —
  // claiming nobody can hear a sound the game plays on every storm.
  const ENGINE_DRIVEN = new Set(["player.water_enter", "weather.thunder", "progress.star"]);

  // ---- assemble the events ----
  const events = [];
  const GROUPS = { ui: "Interface", item: "Items", tool: "Tools", player: "Movement", footsteps: "Movement", combat: "Combat", progress: "Progress", consume: "World", container: "World", door: "World", region: "Ambience", ambience: "Ambience", weather: "Weather", system: "System" };
  const nice = (id) => titleCase(id.replace(/^[a-z]+\./, "").replace(/[._]/g, " "));
  // over.primary mirrors the engine's ONE-SOUND-IS-ONE-SOUND binding
  // (2026-08-05: catalogStepEntry / foleyEntry bind takes.slice(0, 1) — the
  // approved primary take IS the sound; the set's other recordings are not
  // part of the event and live only in the admin's All sounds library).
  const catLayer = (soundId, over = {}) => {
    const s = catById.get(soundId);
    if (!s) return null;
    const g = engine.gentle;
    const v = s.variation ?? {};
    const all = (s.takes?.length ? s.takes : [s.file]).map((t) =>
      ({ name: t.split("/").pop(), file: `sounds/${t}`, dur: wavDuration(join(ROOT, "sounds", t)) }));
    // An assignment may name ONE recording; then that is the whole layer.
    const chosen = over.take != null ? pickTake(all, over.take) : null;
    return {
      source: "catalog", soundId, label: s.name ?? soundId,
      takes: chosen ?? (over.primary ? all.slice(0, 1) : all),
      spareTakes: all.length - (chosen ?? (over.primary ? all.slice(0, 1) : all)).length,
      pick: chosen ? "the one chosen recording" : over.primary ? "the one bound take" : v.round_robin === false ? "primary take only" : "round-robin, never the same twice",
      rate: over.rate ?? 1,
      mixGainDb: s.mix_gain_db ?? 0,
      trimDb: over.trimDb ?? 0,
      bus: over.bus ?? "sfx",
      jitterSemis: v.pitch_jitter_semitones ? v.pitch_jitter_semitones.map((x) => +(x * g).toFixed(2)) : null,
      gainJitterDb: v.gain_jitter_db ? v.gain_jitter_db.map((x) => +(x * g).toFixed(2)) : null,
      lowpassHz: over.lowpassHz ?? null,
      layerNote: over.layerNote ?? null,
      voiceRate: null,
      loop: !!s.loop,
    };
  };
  const setLayer = (set, over = {}) => {
    const cs = composerSets[set];
    if (!cs) return null;
    useSet(set, over.usedBy ?? "event");
    // THE POOL IS A SOURCE OF RECORDINGS, not just the selected takes — the
    // engine's composerFoleyTake searches both, and the maintainer went
    // straight for them once the picker listed them (weather.thunder is four
    // pool candidates, cand07/08/09/17). Searching only `takes` resolved every
    // one of those to an empty layer: the card would claim a sound while
    // showing nothing under it.
    const pickable = [...cs.takes, ...cs.alts];
    const chosen = over.take != null ? pickTake(pickable, over.take) : null;
    const takes = chosen ?? (over.primary ? cs.takes.slice(0, 1) : cs.takes);
    return {
      source: "composer", set, label: `${set} (composer)`,
      takes,
      // Everything else in the folder the Game Master could swap in — the
      // set's other takes AND its unpicked generation candidates.
      spareTakes: pickable.length - takes.length,
      pick: chosen ? "the one chosen recording" : over.primary ? "the one bound take" : over.pick ?? "round-robin, never the same twice",
      rate: over.rate ?? 1,
      mixGainDb: 0, trimDb: over.trimDb ?? 0, bus: over.bus ?? "sfx",
      // Composer sets carry no catalog variation block: the engine's jitter
      // comes from the entry the composer builds (small, authored ranges).
      jitterSemis: over.jitterSemis ?? null,
      gainJitterDb: null,
      lowpassHz: over.lowpassHz ?? null,
      layerNote: over.layerNote ?? null,
      voiceRate: over.voiceRate ?? null,
      loop: false,
    };
  };

  // ---- THE ENGINE'S OWN RESOLUTION ORDER, mirrored exactly ---------------
  // api.ts is SILENT BY DEFAULT (2026-08-05) and resolves an emitted event as:
  //   1. EVENT_ASSIGNMENTS — what the Game Master assigned in the wiki
  //   2. the voice branch + EVENT_FOLEY — approved in their own rounds
  //   3. sounds/bindings.json — ONLY for the two BINDINGS_APPROVED events
  //   4. otherwise SILENCE.
  // This wiki read #2 and then fell through to bindings.json for EVERYTHING,
  // which is two lies at once (maintainer 2026-08-06: "the wiki is showing old
  // sound mappings not the one playing in the game"): every sound he had
  // assigned was invisible — ui.press showed the old `ui_tick` when the game
  // plays `ui_click_bead` — and dozens of unapproved library RECOMMENDATIONS
  // rendered as bound sounds that the engine never plays at all. bindings.json
  // is a suggestion; only these tables are the game.
  /** An event's assigned sounds. The manifest ships a LIST per event — several
   *  assigned sounds ROTATE round-robin on that event, each keeping its own
   *  pitch/volume/jitter — and it used to ship a single object, THROUGH THE
   *  SAME `@1` format string. So accept both shapes, and shout when it is
   *  neither: a shape this reader cannot parse must never quietly render as
   *  "no sound yet" (maintainer 2026-08-06 — "WTF! … Who is undoing all my
   *  work!" — an array-blind read wiped all 14 of his assignments off the page
   *  while the game went on playing every one of them). Silent degradation to
   *  "nothing is assigned" is the worst failure this page has. */
  const assignList = (id) => {
    const raw = EVENT_ASSIGN[id];
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : [raw];
    const good = arr.filter((a) => a && typeof a === "object" && typeof a.sound === "string");
    if (good.length !== arr.length) sfxDrift.push(`assignments.json: ${id} carries an entry shape this build cannot read`);
    return good;
  };
  const assignLayer = (a, id) => {
    if (!a?.sound) return null;
    const over = {
      trimDb: a.volume_db ?? 0,
      rate: a.pitch ?? 1,
      bus: a.bus ?? "sfx", usedBy: id, assigned: true,
    };
    if (String(a.sound).startsWith("composer/")) {
      const { set, take } = splitComposerId(a.sound, a.take);
      // NOT GENTLED. oneshot.ts:135 is `gentle = sound.urls ? 1 : 0.35`, and
      // the engine's assigned-composer branch builds its entry WITH `urls`,
      // so the full ±j is applied. Scaling by 0.35 here (as the catalog path
      // rightly does) made the card understate the Game Master's own setting
      // by 65% — item.drop read ±0.14 st while the game plays ±0.4.
      const j = Math.abs(a.max_random_pitch_semis ?? 0);
      return setLayer(set, { ...over, take: take ?? null, primary: take == null,
        jitterSemis: j ? [-j, j] : null });
    }
    // A CATALOG assignment carries no jitter of its own: the engine plays the
    // catalog entry as-is (`oneShots.play(snd, …)` with only rate/gainDb), so
    // `max_random_pitch_semis` is silently IGNORED for these and the sound's
    // own variation — gentled at 0.35, since a catalog entry has no `urls` —
    // is the truth. catLayer already computes exactly that. Reported to
    // games-audio 2026-08-06.
    return catLayer(a.sound, { ...over, take: a.take ?? null, primary: a.take == null });
  };
  /** What the game ACTUALLY plays for this event, and why. */
  const resolveEvent = (id, ev) => {
    const asg = assignList(id).map((a) => assignLayer(a, id)).filter(Boolean);
    if (asg.length) return { sounds: asg, bound: true, via: "assigned",
      // Several assigned sounds ROTATE — one per trigger, never all at once.
      // That is the opposite of a layered event (grass + dirt underneath play
      // together), so the flag has to travel with the card or ▶ would fire
      // four thunder cracks simultaneously.
      rotates: asg.length > 1,
      // adminNote, not note: "assigned by the Game Master in the wiki" is
      // pipeline shop talk. It was being shown to PLAYERS on every creature
      // page (maintainer 2026-08-06). The "N in rotation" chip already tells
      // everyone what they need about several sounds taking turns.
      adminNote: asg.length > 1
        ? `assigned by the Game Master in the wiki — these ${asg.length} take turns, one per trigger`
        : "assigned by the Game Master in the wiki" };
    if (EVENT_FOLEY[id]) {
      const l = setLayer(EVENT_FOLEY[id], { bus: "ui", trimDb: engine.uiTrimDb, primary: true, usedBy: id });
      return { sounds: l ? [l] : [], bound: !!l, via: "foley",
        note: "every UI event is bound to the approved click — one single sound" };
    }
    if (BIND_OK.has(id) && ev?.sound) {
      const l = catLayer(ev.sound, { bus: ev.bus ?? "sfx" });
      return { sounds: l ? [l] : [], bound: !!l, via: "bindings", note: null };
    }
    // A library suggestion the engine does NOT honour. Say so rather than
    // dropping it — it tells the Game Master what is on offer, and why the
    // event is still silent.
    return { sounds: [], bound: false, via: null,
      note: ev?.sound ? `the sound library suggests “${ev.sound}”, but nothing plays until you assign a sound here` : null };
  };

  const droppedDead = [];   // bindings.json rows no code fires — see below
  for (const ev of bindings.events ?? []) {
    const id = ev.event;
    if (id === "player.footstep") continue;           // replaced by the real per-surface routing below
    if (ev.ambience_by_region) {
      for (const [region, soundId] of Object.entries(ev.ambience_by_region)) {
        const l = catLayer(soundId, { bus: ev.bus ?? "ambience" });
        events.push({ id: `ambience.${region}`, group: "Ambience", name: `Ambience · ${titleCase(region)}`,
          bus: ev.bus ?? "ambience", duck: false, emitted: true, bound: true,   // engine-driven: plays whenever you are in the region
          note: "loops while you are in the region; night adds crickets, rain adds rain",
          sounds: l ? [l] : [] });
      }
      continue;
    }
    if (id === "player.jump") continue;              // per-character events, added below
    const r = resolveEvent(id, ev);
    // A NAME IN THE LIBRARY IS NOT A MOMENT IN THE GAME (maintainer
    // 2026-08-06, on combat.enemy_defeat: "Please remove … This is madness").
    // sounds/bindings.json carries rows the game never emits — older or
    // aspirational spellings like `combat.enemy_defeat` (the game fires
    // `combat.monster_die`), plus tools and containers no code has yet. They
    // rendered as ordinary empty cards, indistinguishable from a live event
    // waiting for a sound: 16 of the 23 assignable-looking cards were ones
    // where auditioning, picking and assigning buys you silence and no
    // explanation. If nothing fires it and nothing is bound to it, it is not
    // a card — it is a line in somebody else's file.
    //
    // ANYTHING BOUND STILL SHOWS, even when nothing fires it: that is the
    // red "not fired yet" case, and hiding it would strand a sound the Game
    // Master assigned with no way to see or unbind it.
    if (!r.bound && !isEmitted(id) && !ENGINE_DRIVEN.has(id)) { droppedDead.push(id); continue; }
    events.push({ id, group: GROUPS[id.split(".")[0]] ?? "World", name: nice(id),
      bus: r.sounds[0]?.bus ?? ev.bus ?? "sfx", duck: !!ev.duck,
      emitted: isEmitted(id) || ENGINE_DRIVEN.has(id),
      bound: r.bound, via: r.via, rotates: !!r.rotates, note: r.note ?? null, adminNote: r.adminNote ?? null, sounds: r.sounds });
  }
  // Everything else the engine knows about: events the game EMITS, and events
  // the Game Master has ASSIGNED (an assignment for an event no binding ever
  // mentioned would otherwise never appear on this page at all).
  for (const id of [...emitted, ...Object.keys(EVENT_ASSIGN)]) {
    if (events.some((e) => e.id === id)) continue;
    // Per-character events get their own scoped rows further down; listing
    // them here too would render `player.die@default_girl` twice, once
    // unscoped on the Sound Effects page and once on her own page.
    if (id === "player.fall" || id === "player.jump" || id === "player.die") continue;
    if (id.includes("@")) continue;
    const r = resolveEvent(id, null);
    events.push({ id, group: GROUPS[id.split(".")[0]] ?? "World", name: nice(id),
      bus: r.sounds[0]?.bus ?? "sfx", duck: false,
      emitted: isEmitted(id) || ENGINE_DRIVEN.has(id),
      bound: r.bound, via: r.via, rotates: !!r.rotates, note: r.note ?? null, adminNote: r.adminNote ?? null, sounds: r.sounds });
  }
  // Footsteps: the real per-surface routing (api.ts FOOTSTEP_*). Every dry
  // surface resolves to a composer set or a catalog sound, with per-surface
  // trim / lowpass / rate, and grass ALSO layers dirt underneath at −6 dB
  // relative to what dirt itself plays at.
  const surfaces = [...new Set(["grass", "dirt", "sand", "snow", "stone", "wood", "ice", "swamp", ...Object.keys(FOOT_SETS), ...Object.keys(FOOT_CAT)])].sort();
  for (const surf of surfaces) {
    const layers = [];
    const level = (s) => engine.stepBaseDb + (Number(FOOT_TRIM[s]) || 0);
    const one = (s, extraDb, layerNote) => {
      const catId = FOOT_CAT[s];
      // Steps bind their primary take too (foleyEntry/catalogStepEntry both
      // slice to one url — the approved take, every step, micro-jitter only).
      if (catId) return catLayer(catId, { trimDb: level(s) + extraDb, layerNote, primary: true, usedBy: `footsteps.${s}` });
      const set = FOOT_SETS[s] ?? footDefault;
      return setLayer(set, {
        trimDb: level(s) + extraDb,
        lowpassHz: FOOT_LP[s] != null ? Number(FOOT_LP[s]) : null,
        rate: FOOT_RATE[s] != null ? Number(FOOT_RATE[s]) : 1,
        layerNote, primary: true, usedBy: `footsteps.${s}`,
      });
    };
    const main = one(surf, 0, null);
    if (main) layers.push(main);
    const lay = FOOT_LAYER[surf];
    if (lay?.surface) {
      const under = one(lay.surface, Number(lay.relDb) || 0, `layered under, at ${lay.surface}'s own level ${lay.relDb} dB`);
      if (under) layers.push(under);
    }
    events.push({ id: `footsteps.${surf}`, group: "Movement", name: `Footsteps · ${titleCase(surf)}`,
      bus: "sfx", duck: false, emitted: true, bound: true,
      note: `walk ${engine.walkPenaltyDb} dB, run +${engine.runBonusDb} dB on the base; both feet alternate with the gait`,
      sounds: layers });
  }
  // The wet shoreline step and the composer's own flourishes.
  const wet = catLayer("splash", { rate: engine.wetStepRate, primary: true, layerNote: "the water-exit splash, pitched brighter" });
  if (wet) events.push({ id: "footsteps.wet", group: "Movement", name: "Footsteps · Wet shoreline", bus: "sfx", duck: false, emitted: true, bound: true, note: null, sounds: [wet] });
  // AN ASSIGNMENT OUTRANKS THESE HARDCODED ROUTES. Both thunder and the
  // shooting star were engine-only when they were written here; the composer
  // has since made them assignable, and the Game Master assigned thunder four
  // pool candidates. Pushing our own card anyway gave TWO `weather.thunder`
  // cards — his four candidates, and a stale one still claiming the six
  // shipped takes. Whatever he assigned is the truth; skip ours.
  const already = (id) => events.some((e) => e.id === id);
  const star = catLayer("gem_pickup", { trimDb: -10 });
  if (star && !already("progress.star")) events.push({ id: "progress.star", group: "Progress", name: "Star Earned", bus: "sfx", duck: false, emitted: true, bound: true,
    note: "played on the music's beat, in the track's key (scale-snapped)", sounds: [star] });
  // ROTATE, not primary: api.ts plays thunder through foleyEntry(…, "rotate"),
  // whose `many` branch binds EVERY url — the maintainer asked to hear thunder
  // as "a group with several sounds". The wiki said "1 take" while the game
  // rotated all six (found by check-mapping.mjs, 2026-08-06).
  const thunder = setLayer("thunder", { trimDb: 6, usedBy: "weather.thunder", pick: "round-robin, never the same twice" });
  if (thunder && !already("weather.thunder")) events.push({ id: "weather.thunder", group: "Weather", name: "Thunder", bus: "sfx", duck: false, emitted: true, bound: true,
    note: "in sync with the lightning flash; up to +6 dB with strike strength", sounds: [thunder] });

  // Jump and Fall are PER-CHARACTER (maintainer 2026-08-05): the game routes
  // the grunt by who you play — one voice each, never both at once. So they
  // are SCOPED events, one per hero, listed on that hero's page rather than
  // under Sound Effects. `scope` is the type the maintainer asked for: an
  // event either belongs to an entity or it is generic.
  for (const [uid, cfg] of Object.entries(JUMP_VOICE)) {
    if (!cfg?.set) continue;
    const voice = (extra) => {
      const l = setLayer(cfg.set, {
        rate: Number(cfg.rate) || 2, trimDb: engine.voiceGainDb,
        pick: "round-robin, never the same twice",
        voiceRate: Number(cfg.rate) || 2, usedBy: `player.jump@${uid}`, ...extra,
      });
      return l ? [l] : [];
    };
    events.push({ id: `player.jump@${uid}`, scope: { domain: "characters", id: uid }, group: "Movement", name: "Jump",
      bus: "sfx", duck: false, emitted: true, bound: true,
      note: "their own voice — the takes are authored at half speed, ×2 is the true pitch", sounds: voice({}) });
    events.push({ id: `player.fall@${uid}`, scope: { domain: "characters", id: uid }, group: "Movement", name: "Fall",
      bus: "sfx", duck: false, emitted: true, bound: true,
      note: "the same grunt when a fall starts (0.28 s of dedupe against the jump)", sounds: voice({}) });
  }
  // DIE IS PER-CHARACTER TOO (games-audio's ask, 2026-08-06, quoting the
  // maintainer on his die-voice request: "This is the female die sound
  // effect. Can't assign a separate voice to the male (you need to fix
  // that)"). Only Jump and Fall had per-hero rows, so there was ONE shared
  // Die card and no way to give the boy his own cry. The engine already
  // resolves `player.die@<uid>` ahead of the unscoped `player.die` — using
  // this wiki's own spelling — so a scoped request wires straight in.
  // Every hero gets a row whether or not a voice is assigned yet: an empty
  // one is exactly the card you assign from.
  // The heroes the engine knows a voice for, plus anyone already assigned a
  // death cry — so a hero can never be assigned one and then not be listed.
  const dieHeroes = [...new Set([
    ...Object.keys(JUMP_VOICE),
    ...Object.keys(EVENT_ASSIGN).filter((k) => k.startsWith("player.die@")).map((k) => k.slice("player.die@".length)),
  ])].sort();
  for (const uid of dieHeroes) {
    // The engine resolves `player.die@<uid>` and FALLS BACK to the unscoped
    // `player.die` ("this voice for everyone"), so the row has to show which
    // of the two this hero actually gets — a card reading "no sound yet"
    // while a shared cry plays would be the same class of lie as the old
    // mappings. The unscoped event is not listed separately; these rows are
    // the whole truth about who dies with which voice.
    const own = !!EVENT_ASSIGN[`player.die@${uid}`];
    const r = resolveEvent(own ? `player.die@${uid}` : "player.die", null);
    events.push({ id: `player.die@${uid}`, scope: { domain: "characters", id: uid }, group: "Movement", name: "Die",
      bus: "sfx", duck: false, emitted: isEmitted("player.die"), ...r,
      note: own ? "their own death cry"
        : r.bound ? "the shared death cry — assign one here to give this hero their own"
        : "no death cry yet; an unassigned voice stays silent rather than borrowing the other hero's" });
  }
  // AN ENTITY'S OWN EVENT BELONGS ON ITS OWN PAGE. The entity assign card
  // mints `<domain>.<entity id>.<action>` (wiki.js entityAddCard), and the
  // composer wires those verbatim — `monsters.forest_poring_2.walk` is
  // Sprigling's footstep. Without this they came back through the generic
  // path as unscoped cards filed under "World" on the Sound Effects page, so
  // the maintainer could bind a sound to a creature and then never find it
  // again: "I have bound sound to Sprigling, can't unbind in the UI".
  // Only a THREE-part id whose middle segment is a real entity of that domain
  // qualifies — `item.drop` and `combat.monster_die` are two parts and must
  // stay generic, and an id naming an entity that no longer exists stays
  // generic too rather than scoping itself onto a page that isn't there.
  for (const e of events) {
    if (e.scope) continue;
    const [dom, id, ...rest] = e.id.split(".");
    if (!rest.length || !entityIds[dom]?.has(id)) continue;
    const action = rest.join(".");
    e.scope = { domain: dom, id };
    e.name = titleCase(action.replace(/[._]/g, " "));
    e.group = GROUPS[dom] ?? "World";
  }
  for (const e of events) if (!("scope" in e)) e.scope = null;
  for (const e of events) if (!("rotates" in e)) e.rotates = false;
  // A creature's page should show what that creature SOUNDS LIKE. These
  // events are fired BY a monster but are not scoped to one — the engine has
  // no per-monster routing yet, the way heroes got `player.die@<uid>` — so
  // they are shared by every creature and the card has to say so, or
  // unbinding on a mammoth's page would silently change every monster in the
  // game (maintainer 2026-08-06: "I can't see already mapped sound effects on
  // monsters … How do I unbind individual sounds like I can do on the Player
  // page?"). Verified against the CALL SITES, not the names: monster_die and
  // both cross events fire off a monster's death (WorldScene 3188/3245/3294);
  // combat.hit_taken is the PLAYER being hurt (4329) and combat.kick/punch are
  // the player's own swings, so none of those three belong here.
  const SHARED_WITH = {
    "combat.monster_die": "monsters",
    "combat.cross_on": "monsters",
    "combat.cross_off": "monsters",
  };
  for (const e of events) e.sharedWith = e.scope ? null : SHARED_WITH[e.id] ?? null;
  // EVERY ASSIGNMENT MUST HAVE LANDED. This is the check that would have
  // caught the array change on the build that shipped it, instead of the
  // maintainer finding a page full of "no sound yet" over work he had done.
  // Cheap, total, and it does not care WHY an assignment failed to resolve.
  const landed = new Set(events.filter((e) => e.via === "assigned").map((e) => e.id));
  const lost = Object.keys(EVENT_ASSIGN).filter((id) => !landed.has(id));
  if (lost.length) sfxDrift.push(`${lost.length} of ${Object.keys(EVENT_ASSIGN).length} assignment(s) did not reach the page: ${lost.join(", ")}`);
  events.sort((a, b) => a.group.localeCompare(b.group) || a.id.localeCompare(b.id));

  // Which catalog sounds an event references — feeds the used/unused pill on
  // the admin's all-sounds list (markSoundUsage already covers bindings; this
  // adds the composer-side routes like sand→jump).
  if (soundEntries?.length) {
    const byId = new Map(soundEntries.map((s) => [s.id, s]));
    for (const e of events) for (const l of e.sounds) if (l.source === "catalog") {
      const s = byId.get(l.soundId);
      if (s && !(s.usedBy ?? (s.usedBy = [])).includes(e.id)) s.usedBy.push(e.id);
    }
  }
  // Not a warning — dropping these is correct. But say it out loud, because
  // the list IS the sounds agent's stale-binding report, and the day one of
  // them starts being emitted it should reappear on the page by itself.
  if (droppedDead.length) {
    console.log(`[wiki] ${droppedDead.length} bindings.json event(s) hidden — nothing in the game fires them: ${droppedDead.join(", ")}`);
  }
  return { engine, events, composerSets, hiddenDeadEvents: droppedDead };
}
/** The per-character jump/fall voice layers — both characters' sets, each at
 *  its authored rate (2.0: the takes are recorded at half speed; see the
 *  composer README's ⭐ lesson). */
function jumpVoiceLayers(JUMP_VOICE, setLayer, engine) {
  const out = [];
  for (const [uid, cfg] of Object.entries(JUMP_VOICE)) {
    if (!cfg?.set) continue;
    const l = setLayer(cfg.set, {
      rate: Number(cfg.rate) || 2,
      trimDb: engine.voiceGainDb,
      pick: "round-robin, never the same twice",
      voiceRate: Number(cfg.rate) || 2,
      layerNote: `${uid}'s voice — picked by character, not at random`,
      usedBy: "player.jump",
    });
    if (l) out.push(l);
  }
  return out;
}

// ------------------------------------------------ audio usage (in game?)
// A sound is IN THE GAME when something references it: a semantic event in
// sounds/bindings.json (including its per-surface / per-region / layer maps)
// or a direct catalog lookup in the composer (`sounds.get("id")`).
function walkTs(dir, out = []) {
  for (const n of (() => { try { return readdirSync(dir); } catch { return []; } })()) {
    const p = join(dir, n);
    if (isDir(p)) walkTs(p, out);
    else if (/\.ts$/.test(n)) out.push(p);
  }
  return out;
}
function markSoundUsage(sounds) {
  if (!sounds?.length) return;
  const byId = new Map(sounds.map((s) => [s.id, s]));
  const mark = (id, why) => {
    const s = byId.get(id);
    if (!s) return;
    (s.usedBy ?? (s.usedBy = [])).includes(why) || s.usedBy.push(why);
  };
  const SKIP = new Set(["event", "bus", "play", "note", "duck"]);
  for (const ev of readJson(join(ROOT, "sounds", "bindings.json"))?.events ?? []) {
    const why = ev.event ?? "event";
    const walk = (v) => {
      if (typeof v === "string") mark(v, why);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    for (const [k, v] of Object.entries(ev)) if (!SKIP.has(k)) walk(v);
  }
  for (const file of walkTs(join(GAMES2, "composer"))) {
    const src = (() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })();
    for (const m of src.matchAll(/sounds\.get\(\s*["']([^"']+)["']/g)) mark(m[1], "composer");
  }
  for (const s of sounds) s.usedBy = s.usedBy ?? [];
}
// Music: the composer's director plays exactly ONE catalog track as the
// background bed, chosen by this scoring (engine/music.ts start()) over
// music/viewer_data.json's order — mirrored here so the wiki reports the
// track the game REALLY plays. (The title/night beds are the composer's own
// mp3s, not music-domain tracks.)
function markMusicUsage(music) {
  if (!music?.length) return;
  const tracks = readJson(join(ROOT, "music", "viewer_data.json"))?.tracks ?? [];
  const score = (t) => {
    const use = (t.use ?? "").toLowerCase();
    let s = 0;
    if (/\b(main|default)\b/.test(use)) s += 4;
    if (use.includes("overworld") || use.includes("background bed")) s += 2;
    if (t.loopable) s += 1;
    return s;
  };
  const bed = [...tracks].sort((a, b) => score(b) - score(a))[0];
  // Catalog tracks only: a composer BED is not a candidate for this pick, and
  // says what it is for through its own `routed` flag.
  for (const t of music) {
    if (t.source === "composer") { t.usedBy = t.routed ? ["the game's own score"] : []; continue; }
    t.usedBy = bed && t.id === bed.id ? ["background bed"] : [];
  }
}

// ------------------------------------------------------------ monster LEVEL
// A monster's LEVEL is the wiki's one-glance answer to "how hard is this to
// fight?" (maintainer 2026-07-30). Nothing in the monsters domain carries a
// difficulty, so the first pass is DERIVED from the two things this repo can
// actually measure, and then tuned by hand in the admin Stats panel — the
// seed NEVER overwrites an entry that already has a level:
//   SIZE       the biggest the creature ever draws, over every state and
//              direction (art_bounds.json). Diretusk fills 176 art px of
//              diagonal, Mirewart 33.
//   REMOTENESS cells from the player's spawn (the bonfire) to the nearest
//              cell of its nearest habitat — the classic level gate: what
//              lives where you arrive is what a level-1 player meets first.
// Both are taken as RANK percentiles so one outlier can't squash the ladder,
// weighted 0.7/0.3 toward size, then spread BY RANK over 1..20 so the result
// reads as a ladder instead of clumping in the middle.
function seedMonsterLevels(monsters, world, artBounds) {
  const ids = (monsters ?? []).map((m) => m.id);
  if (!ids.length) return {};
  const area = {};
  for (const [key, bb] of Object.entries(artBounds?.clips ?? {})) {
    const path = key.split("|")[0];
    if (!path.startsWith("monsters/")) continue;
    const id = path.slice("monsters/".length);
    area[id] = Math.max(area[id] ?? 0, (bb[2] - bb[0]) * (bb[3] - bb[1]));
  }
  const spawn = readJson(join(ROOT, "maps2", "worlds", defaultWorldName(), "world.json"))?.spawn;
  const dist = {};
  if (Array.isArray(spawn) && world?.map?.monsters) {
    const [sc, sr] = spawn;
    for (const [id, zones] of Object.entries(world.map.monsters)) {
      let best = Infinity;
      for (const z of zones ?? [])
        for (const [row, , c0, c1] of z.spans ?? []) {
          const c = Math.min(Math.max(sc, c0), c1);   // nearest col in the run
          best = Math.min(best, Math.hypot(c - sc, row - sr));
        }
      if (Number.isFinite(best)) dist[id] = best;
    }
  }
  const pctOf = (vals) => {
    const sorted = [...vals].sort((a, b) => a - b);
    return (v) => (sorted.length < 2 ? 0 : sorted.filter((x) => x < v).length / (sorted.length - 1));
  };
  const pSize = pctOf(Object.values(area));
  const pDist = pctOf(Object.values(dist));
  const ranked = ids
    // An unspawned monster has no habitat to measure — score it mid-field
    // rather than pretending it lives on top of the bonfire. UNMEASURED art
    // gets the same treatment: `area[id] ?? 0` used to read "smallest creature
    // alive", so the 33 monsters imported while art_bounds.json was stale
    // (2026-08-13) seeded at the bottom of the ladder — Cragback, the second
    // largest creature in the game, came out level 4 while a rabbit was 5.
    // A missing measurement is not a measurement of zero.
    .map((id) => ({ id, score: 0.7 * (id in area ? pSize(area[id]) : 0.5) + 0.3 * (id in dist ? pDist(dist[id]) : 0.5) }))
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  const out = {};
  ranked.forEach((r, i) => { out[r.id] = Math.round(1 + (19 * i) / Math.max(1, ranked.length - 1)); });
  return out;
}

// ------------------------------------------------------- tuning seed/merge
function seedMonsterTuning(monsters, levels) {
  const path = join(ROOT, "live", "tuning", "monsters.json");
  const existing = readJson(path) ?? {};
  const defaults = { level: 1, ...(existing.defaults ?? {
    max_hp: 20, damage: 3, speed_wu: 35, aggro_radius_wu: 96,
    attack_cooldown_ms: 1200, xp: 5, scale: 1.0, loot: [],
  }) };
  const tuned = existing.monsters ?? {};
  let added = 0, levelled = 0;
  for (const m of monsters ?? []) {
    const lvl = levels?.[m.id] ?? defaults.level;
    if (!tuned[m.id]) { tuned[m.id] = { level: lvl, ...defaults, loot: [] }; tuned[m.id].level = lvl; added++; }
    // Backfill entries seeded before levels existed. An entry the maintainer
    // has already levelled keeps its number — this is a seed, not a rewrite.
    // `level` goes AFTER the spread: an entry carrying an explicit `level:
    // null` used to have that null win over the backfilled number, so the
    // only shape this branch could actually repair was a MISSING key.
    else if (tuned[m.id].level == null) { tuned[m.id] = { ...tuned[m.id], level: lvl }; levelled++; }
  }
  const out = {
    format: "pixel-wiki-tuning-monsters@1",
    updated_at: existing.updated_at ?? new Date().toISOString(),
    defaults,
    monsters: Object.fromEntries(Object.entries(tuned).sort(([a], [b]) => a.localeCompare(b))),
  };
  try { writeFileSync(path, JSON.stringify(out, null, 2) + "\n"); } catch { /* read-only fs (Docker) is fine */ }
  return { tuning: out, added, levelled };
}

// -------------------------------------------------------------------- main
const monsters = buildMonsters();
const characters = buildCharacters();
const tiles = buildTiles();
const worldCells = buildWorld();
const objects = buildObjects();
const sounds = buildSounds();
const music = buildMusic();
const items = buildItems();
const lore = buildLore();
const constants = buildConstants();
// Real creature bounds inside each frame: the viewer crops away transparent
// padding and draws everyone at ONE scale, so the same creature is always the
// same size on screen.
//
// THE BUILD MEASURES THE ART ITSELF (maintainer 2026-08-13: "It should just
// work when someone pushes"). This used to be a separate Python tool reading
// this build's own data.json — a circular two-pass dance, and art pushed
// between the passes shipped unmeasured: that is how 33 monsters overflowed
// the animation viewer while Diretusk, measured weeks earlier, sat inside it.
// Now every clip is measured right here (wiki/tools/webp-pixels.mjs, a VP8L
// decoder proven md5-identical to Pillow over all 24,103 art files), and
// because this build already runs inside every deploy's image build, art is
// measured in the same breath it ships. art_bounds.json is only a CACHE keyed
// by content hash — with it stale, missing, or deleted the build still
// produces identical numbers, just a few seconds slower.
const artBoundsPath = join(ROOT, "wiki", "art_bounds.json");
const artPrior = readJson(artBoundsPath);
const artClips = {}, artHashes = {};
const artFailed = [];
let artCachedN = 0, artMeasuredN = 0;
const artBoxes = {}, artOpens = [];
const bankers = (v) => { const f = Math.floor(v); const d = v - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 ? f + 1 : f; };
for (const [dom, list] of Object.entries({ monsters, characters, objects })) {
  for (const e of list ?? []) {
    const sh = e.shadow ?? {}, foot = e.artBottom ?? 1, hover = e.hoverPx ?? 0;
    for (const [sname, st] of Object.entries(e.animations ?? {})) {
      for (const [dname, clip] of Object.entries(st.dirs ?? {})) {
        const key = `${e.path}|${sname}|${dname}`;
        const cw = clip.fw ?? e.frameW, ch = clip.fh ?? e.frameH;
        if (!cw || !ch) continue;
        // Per-frame files (characters2) or one strip (everyone else). The
        // hash covers the bytes AND the slicing, so editing a declared frame
        // size without touching the file still re-measures.
        const files = clip.strip
          ? [join(ROOT, clip.strip)]
          : clip.framesDir
            ? Array.from({ length: clip.frames ?? 0 }, (_, i) =>
                join(ROOT, clip.framesDir, `${String(i).padStart(clip.framePad ?? 1, "0")}.${clip.frameExt ?? "png"}`))
            : [];
        if (!files.length) continue;
        const hasher = createHash("md5");
        let readable = 0;
        const bufs = [];
        for (const f of files) {
          try { const b = readFileSync(f); hasher.update(b); bufs.push(b); readable++; }
          catch { hasher.update("missing"); bufs.push(null); }
        }
        if (!readable) { artFailed.push(`${key}: no frames on disk`); continue; }
        // Two hashes from one read. `plain` is the ART ONLY — md5 of the
        // file's bytes (of all the frames' bytes, in order, for a frame
        // directory) — so any agent can reproduce it with `md5sum` and no
        // knowledge of this build. `digest` adds the declared slicing and is
        // the MEASUREMENT cache key, so changing a frame size re-measures even
        // when the pixels have not moved. They must not be confused: only the
        // first is published.
        const plain = hasher.copy().digest("hex").slice(0, 16);
        hasher.update(`|${cw}x${ch}x${clip.frames ?? 1}`);
        const digest = hasher.digest("hex");
        let bb;
        if (artPrior?.hashes?.[key] === digest) {
          bb = artPrior.clips?.[key] ?? null;            // null = measured, empty
          artCachedN++;
        } else {
          try {
            if (clip.strip) bb = contentBounds(bufs[0], cw, clip.frames ?? 1)?.bb ?? null;
            else {
              // Union of the frames; a frame whose height disagrees with the
              // first is skipped, exactly as the Python tool did.
              let firstH = null; bb = null;
              for (const b of bufs) {
                if (!b) continue;
                const r = contentBounds(b, cw, 1);
                if (!r) continue;
                if (firstH === null) firstH = r.h;
                else if (r.h !== firstH) continue;
                bb = bb ? [Math.min(bb[0], r.bb[0]), Math.min(bb[1], r.bb[1]), Math.max(bb[2], r.bb[2]), Math.max(bb[3], r.bb[3])] : r.bb;
              }
            }
            artMeasuredN++;
          } catch (err) {
            // NO hash recorded: the next build retries instead of trusting a
            // failure. The viewer self-measures these in the browser meanwhile.
            artFailed.push(`${key}: ${err.message}`);
            continue;
          }
        }
        artHashes[key] = digest;
        // THE CLIP'S OWN CONTENT HASH, published (scenery agent, 2026-08-15:
        // "the art_hash I published yesterday ... can only auto-consume
        // piece-level verdicts. For state verdicts to self-consume, the wiki
        // needs to record the state's own hash rather than the piece's"). It
        // is the digest this measurement already computes — the bytes of every
        // frame plus the declared slicing — so a state whose art is re-rolled
        // gets a new hash and the verdict against the old one is visibly about
        // something else. Short form: a verdict stamp, not a checksum.
        clip.h = plain;
        if (bb) {
          artClips[key] = bb;
          clip.bb = bb;
          // What this pose needs on stage — shadow and hover included — grows
          // the domain's shared box; the idle/south view every page opens on
          // decides the shared scale.
          const w = bb[2] - bb[0], h = bb[3] - bb[1];
          const box = artBoxes[dom] ?? (artBoxes[dom] = [0, 0]);
          box[0] = Math.max(box[0], bankers(Math.max(w, sh.w ?? 0)));
          box[1] = Math.max(box[1], bankers(Math.max(h, (foot * ch - bb[1]) + hover + (sh.h ?? 0) / 2 + 1)));
          if (sname === "idle" && dname === "south" && dom !== "objects") artOpens.push(Math.max(w, h));
        }
      }
    }
  }
}
const artOpenMax = Math.max(...artOpens, 64);
const artScale = Math.max(1, Math.min(6, Math.floor(300 / artOpenMax) || 1));
const artBox = Object.keys(artBoxes).length ? artBoxes : null;
// Rewrite the cache only when the measurements moved — a no-change build must
// not churn generated_at.
{
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const same = artPrior && JSON.stringify({ s: artPrior.scale, b: artPrior.boxes, c: artPrior.clips, h: artPrior.hashes })
    === JSON.stringify({ s: artScale, b: artBoxes, c: sorted(artClips), h: sorted(artHashes) });
  if (!same) {
    try {
      writeFileSync(artBoundsPath, JSON.stringify({
        format: "pixel-wiki-art-bounds@3",
        generated_at: new Date().toISOString(),
        note: "content-hash cache of build.mjs's own measurements — safe to delete, the build remeasures",
        scale: artScale, boxes: artBoxes, clips: sorted(artClips), hashes: sorted(artHashes),
      }) + "\n");
    } catch { /* read-only fs (Docker image build) is fine — the numbers are already in data.json */ }
  }
}
const world = buildWorldUsage();
markSoundUsage(sounds);
const sfx = buildSfx(sounds, {
  monsters: new Set(monsters.map((m) => m.id)),
  characters: new Set(characters.map((c) => c.id)),
  objects: new Set(objects.map((o) => o.id)),
});
markMusicUsage(music);
const { added, levelled, tuning } = seedMonsterTuning(monsters, seedMonsterLevels(monsters, world, { clips: artClips }));
// Both directions of "who drops what", precomputed from the SEEDED tuning so
// a monster added this run is already joined.
const drops = joinDrops(items, tuning);

// ONE AUTHOR, ONE TEXT: the lore agent's `description` REPLACES the owning
// domain's, per entity, keyed by that domain's folder id. Coverage is sparse
// by design (items 1 of 105; objects/tiles absent entirely), so every hop
// optional-chains and a miss is a no-op — substituting per DOMAIN instead of
// per ENTITY would flip 104 item pages to text that does not exist.
// NB the name collision: monsters and characters already ship their OWN
// `lore` blurb; `loreDesc` is the lore agent's replacement for it.
for (const [dom, list] of Object.entries({ monsters, characters, objects, items, tiles })) {
  for (const e of list ?? []) {
    const rec = loreEntities[dom]?.[e.id];
    if (!rec) continue;
    if (rec.description) e.loreDesc = rec.description;
    if (rec.lore?.length) e.loreStory = rec.lore;
    if (rec.related?.length) e.loreRelated = rec.related;
  }
}

const data = {
  format: "pixel-wiki-data@1",
  generated_at: new Date().toISOString(),
  git_sha: gitSha(),
  root_hint: "asset paths are relative to the directory that serves the domains (/assets in the game, the repo root locally)",
  // The in-game sound EVENTS (see buildSfx): what triggers a sound, what
  // plays, with which processing — derived from the composer's own engine.
  sfx,
  directions: DIRS,
  // The game's iso projection (maps2/spec/WORLD_FORMAT.md): tile-instance
  // previews must compose cells with the REAL geometry or the seams lie.
  iso: { tilePx: 64, dx: 32, dy: 15, levelPx: 16, diamondH: 30 },
  // One px-per-art-px for every creature in the animation viewer, and one
  // stage size per domain (the widest/tallest pose any of them needs) so
  // paging through monsters never moves the layout.
  artScale, artBox,
  // Usage measured on the game's DEFAULT world (see buildWorldUsage).
  world,
  // The items agent's own type table and rarity ladder (names, stack rules,
  // colours, sell bands) — the wiki renders THEIR vocabulary, never its own.
  itemTypes, itemRarities,
  // Health of the item↔monster join, for the admin view.
  drops,
  // The lore agent's own metadata. `redLine` is a MARKER — the document is
  // fetched by the page, never baked into a file every player loads.
  loreMeta,
  counts: {
    monsters: monsters?.length ?? 0,
    // Heroes and NPCs counted apart: the nav and start tile stay about the
    // PLAYABLE cast (maintainer 2026-08-01 — "player selectable Characters
    // foremost"); the NPC block carries its own count in its heading.
    characters: characters?.filter((c) => c.kind !== "npc").length ?? 0,
    npcs: characters?.filter((c) => c.kind === "npc").length ?? 0,
    tile_types: tiles?.length ?? 0,
    tiles: tiles?.reduce((n, t) => n + t.tileCount, 0) ?? 0,
    // Tiles 3.0 counts CELLS — one "grass over black rock" pair — because
    // that is the unit he reviews and the unit the agent regenerates.
    world: worldCells?.length ?? 0,
    world_candidates: worldCells?.reduce((n, c) => n + c.candidates.length, 0) ?? 0,
    objects: objects?.length ?? 0,
    sounds: sounds?.length ?? 0,
    music: music?.length ?? 0,
    items: items?.length ?? 0,
    lore: lore?.length ?? 0,
    // Chapters only — the admin surface; the start tile counts all tales.
    lore_chapters: lore?.filter((e) => Number.isInteger(e.chapter)).length ?? 0,
    constants: constants.length,
  },
  // Absent domains become empty lists — the site must render, not blank out,
  // when a domain directory is missing (README contract).
  domains: {
    monsters: monsters ?? [], characters: characters ?? [], tiles: tiles ?? [],
    objects: objects ?? [], sounds: sounds ?? [], music: music ?? [], items: items ?? [],
    lore: lore ?? [], world: worldCells ?? [],
  },
  // The tiles agent's own vocabulary and acceptance thresholds.
  worldMeta,
  constants,
};

writeFileSync(OUT, JSON.stringify(data));
console.log(`[wiki] wrote ${OUT}`);
console.log(`[wiki] ${JSON.stringify(data.counts)}${added ? ` — seeded ${added} new monster(s) into tuning/monsters.json` : ""}${levelled ? ` — backfilled ${levelled} monster level(s)` : ""}`);
console.log(`[wiki] art: ${Object.keys(artHashes).length} clips — measured ${artMeasuredN} now, ${artCachedN} from cache${artFailed.length ? `, ${artFailed.length} FAILED` : ""}; stage ${Object.entries(artBoxes).map(([d, b]) => `${d} ${b[0]}x${b[1]}`).join(", ")} at ${artScale}x`);
// The build carries on regardless — resolving keeps every page correct — but a
// stale sidecar is a real fault at its SOURCE, and silence is what let the last
// one rot for a day. Regenerate with wiki/tools/clean-base.py and world-map.py.
if (artFailed.length) {
  console.warn(`[wiki] WARNING: ${artFailed.length} clip(s) could not be measured — they will draw at whole-frame`);
  console.warn("       size until the viewer's in-browser self-measure kicks in:");
  for (const x of artFailed.slice(0, 8)) console.warn(`         ${x}`);
  if (artFailed.length > 8) console.warn(`         … and ${artFailed.length - 8} more`);
  console.warn("       A decode error here usually means art that is not lossless WebP —");
  console.warn("       convert it with games2/scripts/to-webp.py (repo policy, CLAUDE.md).");
}
if (sfxDrift.length) {
  console.warn(`[wiki] WARNING: ${sfxDrift.length} sfx-parse miss(es) — the composer's engine moved; the event table may be stale:`);
  for (const x of sfxDrift) console.warn(`         ${x}`);
  console.warn("       Update buildSfx() in wiki/build.mjs to match games2/composer/engine.");
}
if (staleSidecar.length) {
  const gone = staleSidecar.filter((x) => x.endsWith("GONE"));
  console.warn(`[wiki] WARNING: ${staleSidecar.length} stale path(s) in the committed sidecars, resolved on the fly:`);
  for (const x of staleSidecar.slice(0, 5)) console.warn(`         ${x}`);
  if (staleSidecar.length > 5) console.warn(`         … and ${staleSidecar.length - 5} more`);
  console.warn("       Re-run wiki/tools/clean-base.py and wiki/tools/world-map.py to refresh them.");
  if (gone.length) console.warn(`       ${gone.length} name art that no longer exists at all — those cannot be resolved.`);
}
