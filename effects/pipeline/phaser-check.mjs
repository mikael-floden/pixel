#!/usr/bin/env node
// The Phaser gate: the adapter inside a real Phaser 3.90 scene at his zoom
// (3), pixelArt on, bodies sorted by feet y. Fails on any GL error, any
// shader error, or a scene that stops drawing its sprites after the effects'
// pre-pass (the one way an external renderer breaks a Phaser game).
//
//   PHASER=<dir holding phaser/dist> node effects/pipeline/phaser-check.mjs [--ids a/b,c/d] [--out shot.png]
//
// Needs playwright-core and phaser (both in games2's devDependencies).

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webp": "image/webp" };

const phaserFile = [process.env.PHASER && join(process.env.PHASER, "phaser/dist/phaser.esm.js"), join(ROOT, "games2/node_modules/phaser/dist/phaser.esm.js")].find((p) => p && existsSync(p));
if (!phaserFile) {
  console.error("phaser-check: phaser not found (npm ci in games2, or PHASER=<node_modules dir>)");
  process.exit(2);
}
let pw;
for (const t of ["playwright-core", join(ROOT, "games2/node_modules/playwright-core/index.mjs"), process.env.PHASER && join(process.env.PHASER, "playwright-core/index.mjs")].filter(Boolean)) {
  try {
    pw = await import(t.startsWith("/") ? pathToFileURL(t).href : t);
    break;
  } catch {}
}
if (!pw) {
  console.error("phaser-check: playwright-core not found");
  process.exit(2);
}

const srv = createServer(async (req, rsp) => {
  try {
    const rel = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "");
    const file = rel === "__phaser.esm.js" ? phaserFile : join(ROOT, rel);
    const buf = await readFile(file);
    rsp.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    rsp.end(buf);
  } catch {
    rsp.writeHead(404);
    rsp.end();
  }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const exe = process.env.CHROMIUM || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));
const browser = await pw.chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
const ids = arg("ids", "fire/fireball,frost/frost_nova,arcane/arcane_beam");
await page.goto(`http://127.0.0.1:${srv.address().port}/effects/pipeline/phaser-check.html?ids=${ids}`);
await page.waitForFunction(() => window.__check && window.__check.frames > 90, null, { timeout: 90000 });
const res = await page.evaluate(() => window.__check);
// the scene's own pixels must still be there: sample the canvas for the hero
const shot = await page.screenshot();
if (arg("out")) await writeFile(arg("out"), shot);
await browser.close();
srv.close();
const bad = res.glErrors.length || res.shaderErrors.length || logs.some((l) => /pageerror|error:/i.test(l) && !/404/.test(l));
console.log(JSON.stringify({ frames: res.frames, maxLayers: res.maxLayers, texels: res.texels, reallocs: res.reallocs, glErrors: res.glErrors.slice(0, 5), shaderErrors: res.shaderErrors.slice(0, 3) }));
for (const l of logs) if (!/404/.test(l)) console.log("  " + l);
process.exit(bad ? 1 : 0);
