#!/usr/bin/env node
// build.mjs reads image dimensions from the file header by hand — zero
// dependencies, because it runs inside the Docker build. That hand-rolled
// parser is the wiki's single point of silent failure: a wrong width
// mis-slices every animation strip, and a null reads as "no art here", which
// looks exactly like a missing file. Neither throws.
//
// So it gets checked against a real decoder, over real art:
//
//     node wiki/tools/check-imagesize.mjs [path...]     (default: every domain)
//
// Needs Pillow for the ground truth. Exits non-zero on any disagreement.
import { readdirSync, statSync, openSync, readSync, closeSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const ARGS = process.argv.slice(2);
const TARGETS = ARGS.length ? ARGS : ["monsters", "characters2", "scenery", "tiles2", "items", "wiki/site/icons"];

// THE FUNCTION UNDER TEST — keep byte-identical to build.mjs:imageSize().
function imageSize(path) {
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(32);
    const n = readSync(fd, buf, 0, 32, 0);
    closeSync(fd);
    if (n >= 24 && buf.readUInt32BE(12) === 0x49484452)
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (n >= 16 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const fourcc = buf.toString("ascii", 12, 16);
      if (fourcc === "VP8X" && n >= 30)
        return { w: (buf.readUIntLE(24, 3) & 0xffffff) + 1, h: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
      if (fourcc === "VP8L" && n >= 25) {
        const bits = buf.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (fourcc === "VP8 " && n >= 30)
        return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    return null;
  } catch { return null; }
}

const rows = [];
const walk = (d) => {
  let names = [];
  try { names = readdirSync(d); } catch { return; }
  for (const n of names) {
    const p = join(d, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p);
    else if (/\.(webp|png)$/i.test(n)) { const s = imageSize(p); rows.push([p, s?.w ?? -1, s?.h ?? -1]); }
  }
};
for (const t of TARGETS) walk(isAbsolute(t) ? t : join(ROOT, t));
if (!rows.length) { console.log("no images found — nothing to check"); process.exit(0); }

const tmp = join(mkdtempSync(join(tmpdir(), "imgsize-")), "rows.json");
writeFileSync(tmp, JSON.stringify(rows));
const py = `
import json, sys
from PIL import Image
rows = json.load(open(${JSON.stringify(tmp)}))
bad, fmts = [], {}
for p, w, h in rows:
    try:
        im = Image.open(p); tw, th = im.size; fmts[im.format] = fmts.get(im.format, 0) + 1
    except Exception as e:
        bad.append((p, f"{w}x{h}", f"unreadable: {e}")); continue
    if (tw, th) != (w, h):
        bad.append((p, f"{w}x{h}", f"{tw}x{th}"))
print(json.dumps({"n": len(rows), "bad": bad[:20], "nbad": len(bad), "fmts": fmts}))
`;
let out;
try {
  out = JSON.parse(execFileSync("python3", ["-c", py], { encoding: "utf8", maxBuffer: 64 << 20 }));
} catch (e) {
  console.error("could not run the reference decoder (needs python3 + Pillow):", e.message);
  process.exit(2);
}
const fmts = Object.entries(out.fmts).map(([k, v]) => `${v} ${k}`).join(", ");
console.log(`${out.n} images checked against Pillow (${fmts})`);
if (!out.nbad) { console.log("header reader agrees with the decoder on every file"); process.exit(0); }
console.error(`\n${out.nbad} DISAGREEMENTS (header reader → truth):`);
for (const [p, got, want] of out.bad) console.error(`  ${p.replace(ROOT + "/", "")}: ${got} → ${want}`);
process.exit(1);
