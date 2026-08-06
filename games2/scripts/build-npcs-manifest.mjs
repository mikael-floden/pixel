// Emit the NPC ART manifest the client loads (parallel to build-manifest.mjs
// for player characters and build-monsters-manifest.mjs for monsters). NPC art
// lives in characters2/npcs/<id>/: `base/<dir>.webp` static rotations for all
// eight facings, plus (for most) an idle animation as one image PER FRAME under
// `animations/<anim>/<dir>/<n>.webp`.
//
// WHO stands WHERE is maps2' file (worlds/<name>/npcs.json, pixel-maps2/npcs@1)
// and the client fetches that per world — this manifest only answers "what does
// character <id> look like, and how many frames does its idle have".
//
// NOTE ON COVERAGE: the generated idle currently exists for SOUTH ONLY, and a
// few characters ship none at all. Both are normal here and the client degrades
// to the static rotation, which is why `idle` is per-DIRECTION and may be empty.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { imgDims, resolveImg } from "./imagelib.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SCRIPT_DIR, "..");
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(SCRIPT_DIR, "..", "..");
const NPCS = join(ASSETS_ROOT, "characters2", "npcs");
const DIRECTIONS = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"];

function scan() {
  const out = [];
  if (!existsSync(NPCS)) {
    console.warn(`[npcs] no ${NPCS} — emitting empty manifest`);
    return out;
  }
  const index = (() => {
    try {
      return JSON.parse(readFileSync(join(NPCS, "index.json"), "utf8"))?.npcs ?? {};
    } catch {
      return {};
    }
  })();
  for (const id of readdirSync(NPCS)) {
    const dir = join(NPCS, id);
    if (!existsSync(join(dir, "character.json"))) continue;
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(join(dir, "character.json"), "utf8"));
    } catch {}
    // Static rotations — the fallback every facing is guaranteed to have.
    const base = {};
    let frameW = 0;
    let frameH = 0;
    for (const d of DIRECTIONS) {
      const abs = resolveImg(join(dir, "base", `${d}.webp`));
      if (!abs) continue;
      base[d] = `/assets/characters2/npcs/${id}/base/${abs.split(/[\\/]/).pop()}`;
      if (!frameW) {
        const [w, h] = imgDims(abs);
        frameW = w;
        frameH = h;
      }
    }
    if (!Object.keys(base).length) continue; // unrenderable
    // The idle clip, per direction that actually ships frames.
    const animsDir = join(dir, "animations");
    const idle = {};
    let idleAnim = null;
    if (existsSync(animsDir)) {
      for (const anim of readdirSync(animsDir)) {
        const ad = join(animsDir, anim);
        let any = false;
        for (const d of DIRECTIONS) {
          const dd = join(ad, d);
          if (!existsSync(dd)) continue;
          let n = 0;
          while (resolveImg(join(dd, `${n}.webp`))) n++;
          if (n > 0) {
            idle[d] = n;
            any = true;
          }
        }
        if (any) {
          idleAnim = anim;
          break; // one idle per NPC (custom-calm-still-idle-breathing)
        }
      }
    }
    out.push({
      id,
      name: meta.display_name || index[id]?.display_name || id,
      role: meta.role || index[id]?.role || null,
      frameW,
      frameH,
      base,
      idleAnim,
      idle, // dir -> frame count (SOUTH only today; empty for a few)
    });
  }
  return out;
}

const publicDir = join(GAME_ROOT, "client", "public");
mkdirSync(publicDir, { recursive: true });
const npcs = scan();
writeFileSync(
  join(publicDir, "npcs.json"),
  JSON.stringify({ generatedFrom: "characters2/npcs", directions: DIRECTIONS, npcs }, null, 2) + "\n",
);
const withIdle = npcs.filter((n) => Object.keys(n.idle).length).length;
console.log(`[npcs] ${npcs.length} NPC characters -> client/public/npcs.json (${withIdle} with an idle clip)`);
