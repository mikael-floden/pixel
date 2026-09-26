#!/usr/bin/env node
// One self-contained HTML file of the viewer: runtime + library + page +
// the stage's bodies inlined (data: URIs). It is what gets published as a
// review link the maintainer opens on his phone before the wiki section
// exists — never committed (it would be a regenerable copy of the domain).
//
//   node shaders/pipeline/bundle.mjs [--out <file.html>]      (default $TMPDIR/shaders-review.html)
//
// Needs esbuild (vite's dependency: games2/node_modules), or NODE_PATH to one.

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const args = process.argv.slice(2);
const out = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : join(tmpdir(), "shaders-review.html");

let esbuild;
const tries = ["esbuild", join(ROOT, "games2/node_modules/esbuild/lib/main.js")];
for (const dir of (process.env.NODE_PATH || "").split(":").filter(Boolean)) tries.push(join(dir, "esbuild/lib/main.js"));
for (const t of tries) {
  try {
    const m = await import(t.startsWith("/") ? pathToFileURL(t).href : t);
    esbuild = m.default || m;
    break;
  } catch {}
}
if (!esbuild) {
  console.error("bundle: esbuild not found (npm ci in games2, or NODE_PATH=<dir holding it>)");
  process.exit(2);
}

// What the stage loads: every hero clip and each monster's idle + attack in
// the facings a default stage uses (a tapped target at another angle keeps
// the body's last frame — the bundle is a preview, the repo is the stage),
// the monster manifests, and the catalog (version stamps).
const { CAST_POINTS } = await import(pathToFileURL(join(ROOT, "shaders/library/cast_points.js")).href);
const { MONSTERS, EXTRA_MONSTER } = await import(pathToFileURL(join(ROOT, "shaders/viewer/bodies.js")).href);
const HERO_FACINGS = ["east", "west", "south-east", "south-west"];
const MONSTER_FACINGS = ["east", "west", "south-west"];
const BODIES = ["shaders/shaders.json"];
for (const [hero, H] of Object.entries(CAST_POINTS.heroes))
  for (const a of Object.values(H.anims))
    for (const f of HERO_FACINGS) for (let i = 0; i < a.frames; i++) BODIES.push(`characters2/humans/${hero}/animations/${a.folder}/${f}/${i}.webp`);
for (const id of new Set([...Object.keys(MONSTERS), EXTRA_MONSTER])) {
  const man = JSON.parse(await readFile(join(ROOT, "monsters", id, "monster.json"), "utf8"));
  BODIES.push(`monsters/${id}/monster.json`);
  for (const state of ["idle", "attack"]) {
    const dirs = man.animations?.[man.states?.[state] ?? state]?.directions || {};
    for (const f of MONSTER_FACINGS) for (const p of dirs[f]?.frame_paths || []) BODIES.push(`monsters/${p}`);
  }
}
const MIME = { webp: "image/webp", json: "application/json" };

const js = (await esbuild.build({
  entryPoints: [join(ROOT, "shaders/viewer/viewer.js")],
  bundle: true,
  format: "esm",
  write: false,
  minify: true,
  legalComments: "none",
  target: "es2020",
})).outputFiles[0].text;
const css = await readFile(join(ROOT, "shaders/viewer/viewer.css"), "utf8");
const html = await readFile(join(ROOT, "shaders/viewer/index.html"), "utf8");
const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script")).trim();
const assets = {};
for (const rel of BODIES) assets[rel] = `data:${MIME[rel.split(".").pop()]};base64,${(await readFile(join(ROOT, rel))).toString("base64")}`;
const page = `<title>Nangijala Shaders</title>
<meta name="description" content="The shaders library on a game-accurate stage: the hero casts with its real clip, the game's light by time of day, volleys, and when every sound can play.">
<style>
${css}
</style>
${body}
<script>window.__NFX_ASSETS = ${JSON.stringify(assets)};</script>
<script type="module">
${js.replace(/<\/script/gi, "<\\/script")}
</script>
`;
await writeFile(out, page);
console.log(`${out} (${(page.length / 1024).toFixed(0)} KB)`);
