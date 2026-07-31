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
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

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

// ---------------------------------------------------------------- monsters
function buildMonsters() {
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
          gif: isFile(join(ROOT, `monsters/${id}/animations/${folder}__${dir}.gif`)) ? `monsters/${id}/animations/${folder}__${dir}.gif` : null,
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
      if (Object.keys(dirs).length) anims[state] = { folder, dirs, gif: isFile(join(base, id, "animations", folder, "preview.gif")) ? `characters2/humans/${id}/animations/${folder}/preview.gif` : null };
    }
    chars.push({
      id,
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
  return chars;
}

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
    if (cb) t.cleanBase = { plain: cb.plain, solid: cb.solid ?? [], clean: cb.clean ?? [] };
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
  const base = join(ROOT, "objects");
  if (!isDir(base)) return null;
  const objects = [];
  for (const id of listDirs(base)) {
    if (["config", "pipeline"].includes(id)) continue;
    const oj = readJson(join(base, id, "object.json"));
    if (!oj) continue;
    const anims = {};
    for (const [key, a] of Object.entries(oj.animations ?? {})) {
      const dirs = {};
      for (const dir of DIRS) {
        const d = a.directions?.[dir];
        if (!d) continue;
        const stripRel = d.strip ?? `${id}/animations/${key}__${dir}.png`;
        const declared = `objects/${stripRel.startsWith(id + "/") ? stripRel : `${id}/animations/${key}__${dir}.png`}`;
        // object.json names the file, and it may still say ".png" for a while
        // after the objects domain converts. Resolve against the DISK, so the
        // wiki doesn't go blank waiting for another agent's metadata edit.
        const strip = art(declared.replace(/\.(png|webp)$/i, ""));
        const frames = d.frames ?? a.frame_count ?? 0;
        if (!frames || !strip) continue;
        const dims = imageSize(join(ROOT, strip));
        dirs[dir] = { frames, strip, fw: dims ? Math.round(dims.w / frames) : oj.size, fh: dims ? dims.h : oj.size };
      }
      if (Object.keys(dirs).length) anims[key] = { description: a.description ?? "", dirs };
    }
    objects.push({
      id,
      name: oj.name ?? titleCase(id),
      category: oj.category ?? "misc",
      description: oj.description ?? "",
      path: `objects/${id}`,
      preview: art(`objects/${id}/sprite`),
      size: oj.size ?? null,
      placement: oj.placement ?? null,
      animations: anims,
    });
  }
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
  return tracks;
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
  // Spawn zones projected onto the world's minimap (wiki/world_map.json,
  // written by wiki/tools/world-map.py) — the monster pages' "where it
  // lives" map. Only used when it describes THIS world.
  const wm = readJson(join(ROOT, "wiki", "world_map.json"));
  const map = wm?.world === name
    ? { minimap: wm.minimap, mapW: wm.mapW, mapH: wm.mapH, proj: wm.proj, monsters: wm.monsters ?? {} }
    : null;

  return {
    name, w: world.size?.w ?? null, h: world.size?.h ?? null,
    cells, props, distinctTiles: Object.keys(tiles).length,
    tiles, monsters, map,
  };
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
  for (const t of music) t.usedBy = bed && t.id === bed.id ? ["background bed"] : [];
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
  const pSize = pctOf(ids.map((i) => area[i] ?? 0));
  const pDist = pctOf(Object.values(dist));
  const ranked = ids
    // An unspawned monster has no habitat to measure — score it mid-field
    // rather than pretending it lives on top of the bonfire.
    .map((id) => ({ id, score: 0.7 * pSize(area[id] ?? 0) + 0.3 * (id in dist ? pDist(dist[id]) : 0.5) }))
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
    else if (tuned[m.id].level == null) { tuned[m.id] = { level: lvl, ...tuned[m.id] }; levelled++; }
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
const objects = buildObjects();
const sounds = buildSounds();
const music = buildMusic();
const items = buildItems();
const lore = buildLore();
const constants = buildConstants();
// Real creature bounds inside each frame (wiki/tools/art-bounds.py): lets the
// viewer crop away transparent padding and draw everyone at ONE scale, so the
// same creature is always the same size on screen. Missing file → the viewer
// falls back to whole-frame scaling.
const artBounds = readJson(join(ROOT, "wiki", "art_bounds.json"));
const artScale = artBounds?.scale ?? 2;
const artBox = artBounds?.boxes ?? null;
for (const [dom, list] of Object.entries({ monsters, characters, objects })) {
  for (const e of list ?? []) {
    for (const [sname, st] of Object.entries(e.animations ?? {})) {
      for (const [dname, clip] of Object.entries(st.dirs ?? {})) {
        const bb = artBounds?.clips?.[`${e.path}|${sname}|${dname}`];
        if (bb) clip.bb = bb;
      }
    }
  }
  void dom;
}
const world = buildWorldUsage();
markSoundUsage(sounds);
markMusicUsage(music);
const { added, levelled, tuning } = seedMonsterTuning(monsters, seedMonsterLevels(monsters, world, artBounds));
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
    characters: characters?.length ?? 0,
    tile_types: tiles?.length ?? 0,
    tiles: tiles?.reduce((n, t) => n + t.tileCount, 0) ?? 0,
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
    lore: lore ?? [],
  },
  constants,
};

writeFileSync(OUT, JSON.stringify(data));
console.log(`[wiki] wrote ${OUT}`);
console.log(`[wiki] ${JSON.stringify(data.counts)}${added ? ` — seeded ${added} new monster(s) into tuning/monsters.json` : ""}${levelled ? ` — backfilled ${levelled} monster level(s)` : ""}`);
