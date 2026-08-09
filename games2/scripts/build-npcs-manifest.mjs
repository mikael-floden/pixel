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
// NOTE ON COVERAGE: the idle ships for SOUTH, SOUTH-EAST and SOUTH-WEST (all
// 191, 2026-08-09) and for no other facing yet; a few characters ship none at
// all. Both are normal here and the client degrades to the static rotation,
// which is why `idle` is per-DIRECTION and may be empty. The client picks a
// facing it has an idle for — see WorldScene.addNpc.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { imgDims, resolveImg } from "./imagelib.mjs";
import { footAnchor, soleOf } from "./anchorlib.mjs";
import { imgAlpha } from "./imagelib.mjs";

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
    // FOOT ANCHOR per rotation, measured with the SAME code the player
    // characters use (anchorlib.footAnchor): the point BETWEEN the two feet,
    // at the underside. The client sets it as the sprite origin, so the drawn
    // soles land exactly on the ground point its nadir shadow is drawn at.
    // A guessed origin is precisely what made the monsters "fly" for three
    // rounds — never eyeball this number (maintainer 2026-08-06).
    const anchors = {};
    let frameW = 0;
    let frameH = 0;
    for (const d of DIRECTIONS) {
      const abs = resolveImg(join(dir, "base", `${d}.webp`));
      if (!abs) continue;
      base[d] = `/assets/characters2/npcs/${id}/base/${abs.split(/[\\/]/).pop()}`;
      const a = footAnchor(abs);
      // CLOAK GUARD (NPC-only — the player measurement is approved art and is
      // never touched here). A floor-length cloak/robe puts the frame's lowest
      // mass at the HEM, and the foot-blob pass then anchors on the boots
      // ABOVE it: measured 2 of 191 characters landing ~7px high, one of whom
      // (06e4eb08, "Aurelia") is placed in five worlds. A hem that reaches the
      // floor IS the ground contact, so when the anchor drifts far above the
      // drawn sole, take the sole line instead (with the same ~2px mid-foot
      // lift footAnchor applies). 189 of 191 are unaffected: they measure
      // 1.5px above their sole, exactly the designed offset.
      if (a) {
        const png = imgAlpha(abs);
        const sole = png ? soleOf(png) : -1;
        if (png && sole >= 0) {
          const anchorRow = a.y * png.h;
          if (sole - anchorRow > 4) a.y = +((sole - 1.5) / png.h).toFixed(4);
        }
        anchors[d] = a;
      }
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
    // ASK character.json WHICH FOLDER IS THE IDLE — never the folder name.
    // PixelLab animation names are GENERATION PROMPTS the maintainer rewords
    // freely, and they carry typos: 152 of these NPCs say "still" and 39 say
    // "stilI" with a capital i. characters2' sync.py resolves each game state
    // and PUBLISHES the answer as `states` on character.json (and in
    // npcs/index.json), precisely so no consumer has to match text. Scanning
    // for "the first folder with frames" happened to work only while every NPC
    // had exactly one animation; it silently picks a coin-toss the day a second
    // one lands.
    const named = meta.states?.idle ?? index[id]?.states?.idle ?? null;
    const candidates = named
      ? [named]
      : existsSync(animsDir)
        ? readdirSync(animsDir)
        : [];
    for (const anim of candidates) {
      const ad = join(animsDir, anim);
      if (!existsSync(ad)) continue;
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
        break;
      }
    }
    out.push({
      id,
      name: meta.display_name || index[id]?.display_name || id,
      role: meta.role || index[id]?.role || null,
      frameW,
      frameH,
      base,
      anchors, // dir -> {x, y, top} foot anchor (fractions of the frame)
      idleAnim,
      idle, // dir -> frame count (S/SE/SW today; empty for a few)
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
