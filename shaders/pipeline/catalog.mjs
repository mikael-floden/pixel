#!/usr/bin/env node
// Builds the two generated files of the domain FROM THE LIBRARY ON DISK:
//
//   shaders/library/index.js   one import per effect file (what the viewer and
//                               the game import)
//   shaders/shaders.json        the catalog: every effect's metadata, no code
//                               (what the wiki lists and a tooltip reads)
//
//   node shaders/pipeline/catalog.mjs           write both
//   node shaders/pipeline/catalog.mjs --check   exit 1 if either is stale
//
// Every definition is imported and validated (defineEffect throws on a
// malformed one), and every id must equal its file path: fire/fireball lives
// in library/fire/fireball.js, so a feedback key is always a real file.
//
// Each effect's `version` hashes what draws it (its file, the library files
// it imports, the GLSL prelude): the wiki stamps a verdict with it, so a
// changed effect asks to be judged again. The gate also re-hashes the hero
// frames library/cast_points.js was measured on: a regenerated hero fails it
// (python3 shaders/pipeline/castpoints.py) instead of casting from where the
// old wand was.

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOMAIN = resolve(HERE, "..");
const REPO = resolve(DOMAIN, "..");
const LIB = join(DOMAIN, "library");
const CHECK = process.argv.includes("--check");

/** sha256 of the effect file + every library file it imports (transitively)
 *  + the prelude every shader is compiled with. 16 hex. */
async function versionOf(file, prelude) {
  const h = createHash("sha256");
  const seen = new Set();
  const add = async (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = await readFile(f, "utf8");
    h.update(relative(REPO, f) + "\n" + src);
    for (const m of src.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
      const dep = resolve(dirname(f), m[1]);
      if (dep.startsWith(LIB)) await add(dep);
    }
  };
  await add(file);
  h.update(prelude);
  return h.digest("hex").slice(0, 16);
}

/** The digest castpoints.py writes: every frame it read, in its order. */
async function castSource() {
  const map = JSON.parse(await readFile(join(REPO, "characters2", "animation_map.json"), "utf8"));
  const DIRS = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"];
  const h = createHash("sha256");
  const feed = async (p) => h.update(Buffer.concat([Buffer.from(relative(REPO, p)), await readFile(p)]));
  for (const hero of ["default_boy", "default_girl"]) {
    const fm = { ...map.states, ...(map.overrides?.[hero] || {}) };
    const base = join(REPO, "characters2", "humans", hero, "animations");
    for (const d of DIRS) {
      const dir = join(base, fm.idle, d);
      for (const f of (await readdir(dir)).filter((f) => f.endsWith(".webp")).sort()) await feed(join(dir, f));
    }
    for (const state of ["spell_wand", "spell_channel", "bow"])
      for (const d of DIRS) for (const f of ["0.webp", "2.webp"]) await feed(join(base, fm[state], d, f));
    for (const state of ["idle", "spell_wand", "spell_channel", "bow", "sword", "punch", "kick"]) {
      let n = Infinity;
      for (const d of DIRS) n = Math.min(n, (await readdir(join(base, fm[state], d))).filter((f) => f.endsWith(".webp")).length);
      h.update(`${hero}|${state}|${fm[state]}|${n}`);
    }
  }
  return h.digest("hex").slice(0, 16);
}

async function files() {
  const out = [];
  for (const fam of (await readdir(LIB, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!fam.isDirectory() || fam.name.startsWith("_")) continue;
    for (const f of (await readdir(join(LIB, fam.name))).sort()) if (f.endsWith(".js")) out.push(`${fam.name}/${f}`);
  }
  return out;
}

const fnDesc = (v) => (typeof v === "function" ? "by level" : v);

const EVENTS = {
  projectile: ["cast", "release", "impact", "end"],
  melee: ["cast", "release", "hit", "end"],
  chain: ["cast", "release", "hop", "end"],
  burst: ["cast", "release", "peak", "end"],
};
const SUSTAINED_EVENTS = ["cast", "release", "start", "stop", "end"];

async function main() {
  const list = await files();
  const { FAMILIES, KIND_LABEL } = await import(pathToFileURL(join(LIB, "families.js")).href);
  const { CAST_ANIMS, castRelease, soundEvent } = await import(pathToFileURL(join(DOMAIN, "runtime", "define.js")).href);
  const { FORMATIONS, formationsOf, MAX_VOLLEY } = await import(pathToFileURL(join(DOMAIN, "runtime", "volley.js")).href);
  const { CAST_POINTS } = await import(pathToFileURL(join(LIB, "cast_points.js")).href);
  const { PRELUDE } = await import(pathToFileURL(join(DOMAIN, "runtime", "glsl.js")).href);
  const entries = [];
  const problems = [];
  const src = await castSource();
  if (src !== CAST_POINTS.source) problems.push(`library/cast_points.js was measured on other hero frames (${CAST_POINTS.source}, now ${src}): python3 shaders/pipeline/castpoints.py`);
  for (const rel of list) {
    const mod = await import(pathToFileURL(join(LIB, rel)).href);
    const d = mod.default;
    const want = rel.replace(/\.js$/, "");
    if (!d || d.id !== want) {
      problems.push(`${rel}: id "${d && d.id}" must be "${want}"`);
      continue;
    }
    if (!FAMILIES[d.family]) problems.push(`${rel}: family "${d.family}" is not in library/families.js`);
    if (!d.thinking || d.thinking.length < 120) problems.push(`${rel}: "thinking" must explain the design (>= 120 chars)`);
    if (!d.levels) problems.push(`${rel}: "levels" must say what changes from 1 to 10`);
    const s = { level: 5, lv: 4 / 9, tune: Object.fromEntries(Object.entries(d.tune).map(([k, v]) => [k, v.def])) };
    const byLevel = Array.from({ length: 10 }, (_, i) => +castRelease(d, i + 1).toFixed(3));
    const forms = formationsOf(d);
    entries.push({
      id: d.id,
      key: `shaders/library/${d.id}`,
      file: `shaders/library/${rel}`,
      version: await versionOf(join(LIB, rel), PRELUDE),
      name: d.name,
      kind: d.kind,
      kindLabel: KIND_LABEL[d.kind],
      family: d.family,
      category: d.category,
      tags: d.tags,
      thinking: d.thinking,
      levels: d.levels,
      speed: d.kind === "projectile" ? { cellsPerSecondAtLevel5: +(typeof d.speed === "function" ? d.speed(s) : d.speed ?? 10).toFixed(2) } : undefined,
      events: EVENTS[d.kind] || SUSTAINED_EVENTS,
      sustained: ["beam", "aura", "zone", "screen"].includes(d.kind),
      stage: {
        ...d.stage,
        // the play() release that meets the clip's key frame (runtime castRelease)
        release: d.stage.caster && d.stage.anim ? (byLevel.every((v) => v === byLevel[0]) ? byLevel[0] : byLevel) : 0,
      },
      sounds: d.sounds.map((x) => ({ ...x, sound_event: soundEvent(d.id, x.slot) })),
      volley: forms.length ? { formations: forms, max: MAX_VOLLEY } : null,
      radius: d.radius === undefined ? undefined : fnDesc(d.radius),
      planes: [...new Set(d.layers.map((L) => L.plane))],
      light: !!d.light,
      layers: d.layers.map((L) => ({ id: L.id, plane: L.plane, emissive: L.emissive !== false })),
      tune: d.tune,
    });
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  const index =
    "// GENERATED by shaders/pipeline/catalog.mjs — do not edit by hand.\n" +
    "// Every effect in the library, one import per file, in catalog order.\n" +
    list.map((rel, i) => `import e${i} from "./${rel}";`).join("\n") +
    `\n\nexport const LIBRARY = [${list.map((_, i) => `e${i}`).join(", ")}];\nexport default LIBRARY;\n`;
  const catalog =
    JSON.stringify(
      {
        format: "nangijala-shaders-catalog@1",
        runtime: "shaders/runtime/index.js",
        showcase: "shaders/runtime/showcase.js",
        viewer: "shaders/viewer/index.html",
        families: FAMILIES,
        cast_anims: CAST_ANIMS,
        formations: Object.fromEntries(Object.entries(FORMATIONS).map(([k, f]) => [k, { label: f.label, about: f.about, kinds: f.kinds }])),
        cast_points: CAST_POINTS,
        count: entries.length,
        effects: entries,
      },
      null,
      1,
    ) + "\n";
  const targets = [
    [join(LIB, "index.js"), index],
    [join(DOMAIN, "shaders.json"), catalog],
  ];
  let stale = 0;
  for (const [path, text] of targets) {
    let cur = null;
    try {
      cur = await readFile(path, "utf8");
    } catch {}
    if (cur === text) continue;
    stale++;
    if (CHECK) console.error(`stale: ${path} (run node shaders/pipeline/catalog.mjs)`);
    else await writeFile(path, text);
  }
  if (CHECK && stale) process.exit(1);
  console.log(`${entries.length} effects${CHECK ? " (catalog up to date)" : stale ? " (written)" : " (unchanged)"}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
