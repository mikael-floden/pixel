// THE VP8L DECODER IS PROVEN AGAINST PILLOW, PIXEL FOR PIXEL.
//
// wiki/tools/webp-pixels.mjs is what lets build.mjs measure art inside the
// deploy's image build (maintainer 2026-08-13: "It should just work when
// someone pushes") — node:22-slim has no Python, so the decoder is hand-written
// JS, and hand-written decoders earn trust by comparison, not by review. This
// gate decodes art with BOTH implementations and compares the md5 of the full
// RGBA buffer — total equality, not just the bounding boxes the build happens
// to use today. The 2026-08-13 bring-up run covered all 24,103 files in the
// three viewer domains: byte-identical. (That run also caught a real bug — the
// sign of the 2D distance offsets — which corrupted exactly 5 of the first 23
// sample files. This is why the comparison exists.)
//
// Default: every monster strip + every scenery sprite/strip + 800 random
// character frames (seeded, so reruns compare the same files). --all: the
// whole corpus (~25s). Needs python3 + Pillow; without them it reports SKIP
// and exits 0, because Docker has neither — the decoder's numbers there are
// backed by this gate having passed where Python exists.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { decodeWebP } from "./webp-pixels.mjs";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const ALL = process.argv.includes("--all");

// python3 + PIL, or a polite skip.
const probe = spawnSync("python3", ["-c", "import PIL"], { encoding: "utf8" });
if (probe.status !== 0) {
  console.log("SKIP: python3 with Pillow is not available here — the decoder was proven where it is.");
  process.exit(0);
}

const walk = (dir, out = []) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith(".webp")) out.push(p);
  }
  return out;
};
const monsters = walk(join(ROOT, "monsters"));
const scenery = walk(join(ROOT, "scenery"));
const chars = walk(join(ROOT, "characters2"));
// Seeded shuffle so every run of the sample checks the same files.
let seed = 0x77c1;
const rand = () => (seed = (seed * 48271) % 0x7fffffff) / 0x7fffffff;
const sample = ALL ? chars : [...chars].sort(() => rand() - 0.5).slice(0, 800);
const files = [...monsters, ...scenery, ...sample];
console.log(`comparing ${files.length} files (${monsters.length} monster, ${scenery.length} scenery, ${sample.length} character${ALL ? ", --all" : ""})`);

// One python process for the whole list.
const py = execFileSync("python3", ["-c", `
import sys, hashlib
from PIL import Image
for line in sys.stdin:
    p = line.strip()
    if not p: continue
    try:
        im = Image.open(p).convert("RGBA")
        print(hashlib.md5(im.tobytes()).hexdigest(), p)
    except Exception as e:
        print("ERR", p)
`], { input: files.join("\n"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const want = new Map(py.trim().split("\n").map((l) => { const i = l.indexOf(" "); return [l.slice(i + 1), l.slice(0, i)]; }));

let okN = 0; const bad = [];
for (const p of files) {
  let got;
  try {
    const { w, h, pix } = decodeWebP(readFileSync(p));
    const rgba = Buffer.allocUnsafe(w * h * 4);
    for (let i = 0; i < pix.length; i++) {
      const v = pix[i];
      rgba[i * 4] = (v >>> 16) & 0xff; rgba[i * 4 + 1] = (v >>> 8) & 0xff;
      rgba[i * 4 + 2] = v & 0xff; rgba[i * 4 + 3] = v >>> 24;
    }
    got = createHash("md5").update(rgba).digest("hex");
  } catch (e) { got = `ERR ${e.message}`; }
  if (got === want.get(p)) okN++;
  else bad.push(`${p}: js ${got} vs pillow ${want.get(p)}`);
}
for (const b of bad.slice(0, 8)) console.log("  MISMATCH:", b);
console.log(`${okN}/${files.length} byte-identical to Pillow`);
console.log(bad.length ? `\n${bad.length} FAILURES` : "\nALL PIXEL CHECKS PASSED");
process.exit(bad.length ? 1 : 0);
