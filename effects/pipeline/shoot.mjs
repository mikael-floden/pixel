#!/usr/bin/env node
// Contact sheets of effects in a real (headless) browser — the agent's eyes
// and the library's gate. Serves the repo root, opens the viewer in sheet
// mode, waits for it, and writes one PNG per effect.
//
//   node effects/pipeline/shoot.mjs [--ids fire/fireball,frost/frost_nova | --all]
//        [--levels 1,5,10] [--frames 6] [--out <dir>] [--day] [--w 240 --h 150]
//
// Exit 1 when any shader fails to compile or an effect draws nothing at all.
// Needs playwright-core (a games2 devDependency) and a Chromium: set
// CHROMIUM=<path> or it looks in /opt/pw-browsers (the agent image).

import { createServer } from "node:http";
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const has = (k) => args.includes(`--${k}`);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".webp": "image/webp", ".png": "image/png" };

async function allIds() {
  const lib = join(ROOT, "effects/library");
  const out = [];
  for (const fam of await readdir(lib, { withFileTypes: true })) {
    if (!fam.isDirectory() || fam.name.startsWith("_")) continue;
    for (const f of await readdir(join(lib, fam.name))) if (f.endsWith(".js")) out.push(`${fam.name}/${f.replace(/\.js$/, "")}`);
  }
  return out.sort();
}

function serve() {
  return new Promise((res) => {
    const srv = createServer(async (req, rsp) => {
      try {
        const u = new URL(req.url, "http://x");
        const rel = normalize(decodeURIComponent(u.pathname)).replace(/^\/+/, "");
        if (rel.startsWith("..")) throw new Error("outside");
        const buf = await readFile(join(ROOT, rel));
        rsp.writeHead(200, { "content-type": TYPES[extname(rel)] || "application/octet-stream", "cache-control": "no-store" });
        rsp.end(buf);
      } catch {
        rsp.writeHead(404);
        rsp.end();
      }
    });
    srv.listen(0, "127.0.0.1", () => res(srv));
  });
}

function chromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  for (const p of ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]) if (existsSync(p)) return p;
  return undefined;
}

async function main() {
  let pw;
  const tries = ["playwright-core", join(ROOT, "games2/node_modules/playwright-core/index.mjs")];
  for (const dir of (process.env.NODE_PATH || "").split(":").filter(Boolean)) tries.push(join(dir, "playwright-core/index.mjs"));
  for (const t of tries) {
    try {
      pw = await import(t.startsWith("/") ? pathToFileURL(t).href : t);
      break;
    } catch {}
  }
  if (!pw) {
    console.error("shoot: playwright-core is not installed (npm ci in games2, or NODE_PATH=<dir holding it>)");
    process.exit(2);
  }
  const ids = has("all") ? await allIds() : (arg("ids", "") || "").split(",").filter(Boolean);
  if (!ids.length) {
    console.error("shoot: nothing to shoot (--ids a/b,c/d or --all)");
    process.exit(2);
  }
  const levels = arg("levels", "1,5,10");
  const frames = arg("frames", "6");
  const out = resolve(arg("out", join(tmpdir(), "effects-shots")));
  await mkdir(out, { recursive: true });
  const srv = await serve();
  const port = srv.address().port;
  const browser = await pw.chromium.launch({
    executablePath: chromium(),
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  const logs = [];
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  let failed = 0;
  for (const id of ids) {
    logs.length = 0;
    const q = new URLSearchParams({ sheet: id, levels, frames, w: arg("w", "240"), h: arg("h", "180"), night: has("day") ? "0" : "1" });
    for (const k of ["bands", "zoom", "stepFps", "dither"]) if (arg(k)) q.set(k, arg(k));
    await page.goto(`http://127.0.0.1:${port}/effects/viewer/index.html?${q}`);
    await page.waitForFunction(() => window.__sheet && window.__sheet.done, null, { timeout: 120000 });
    const res = await page.evaluate(() => window.__sheet);
    const bad = res.error || (res.errors && res.errors.length);
    const png = join(out, `${id.replace("/", "__")}.png`);
    const el = await page.$("#sheet");
    if (el) await writeFile(png, await el.screenshot());
    const status = bad ? "FAIL" : "ok";
    if (bad) failed++;
    console.log(`${status} ${id} -> ${png}${bad ? `\n  ${res.error || JSON.stringify(res.errors)}` : ""}`);
    for (const l of logs) if (/error|warn/i.test(l)) console.log(`  ${l}`);
  }
  await browser.close();
  srv.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
