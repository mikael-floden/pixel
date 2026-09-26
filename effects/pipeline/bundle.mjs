#!/usr/bin/env node
// One self-contained HTML file of the viewer: runtime + library + page +
// the stage's bodies inlined (data: URIs). It is what gets published as a
// review link the maintainer opens on his phone before the wiki section
// exists — never committed (it would be a regenerable copy of the domain).
//
//   node effects/pipeline/bundle.mjs [--out <file.html>]      (default $TMPDIR/effects-review.html)
//
// Needs esbuild (vite's dependency: games2/node_modules), or NODE_PATH to one.

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const args = process.argv.slice(2);
const out = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : join(tmpdir(), "effects-review.html");

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

const BODIES = [
  "characters2/humans/default_boy/base/east.webp",
  "monsters/werewolf/rotations/west.webp",
  "characters2/humans/default_girl/base/south-west.webp",
  "characters2/humans/default_girl/base/west.webp",
  "monsters/crag_troll/rotations/west.webp",
];

const js = (await esbuild.build({
  entryPoints: [join(ROOT, "effects/viewer/viewer.js")],
  bundle: true,
  format: "esm",
  write: false,
  minify: true,
  legalComments: "none",
  target: "es2020",
})).outputFiles[0].text;
const css = await readFile(join(ROOT, "effects/viewer/viewer.css"), "utf8");
const html = await readFile(join(ROOT, "effects/viewer/index.html"), "utf8");
const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script")).trim();
const assets = {};
for (const rel of BODIES) assets[rel] = `data:image/webp;base64,${(await readFile(join(ROOT, rel))).toString("base64")}`;
const page = `<title>Nangijala Effects</title>
<meta name="description" content="The effects library: every spell, attack and monster effect, with its level 1-10 and its tunables.">
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
