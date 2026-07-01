// Emit a character manifest the web client loads. The game lives at
// pixel/games/nangijala; character art is a sibling domain at <repo>/characters/.
// Frame URLs are served under /assets/... (see client/vite.config.ts + server).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SCRIPT_DIR, ".."); // pixel/games/nangijala
// Art domains live at the repo root by default; ASSETS_ROOT overrides it (Docker).
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(SCRIPT_DIR, "..", "..", "..");
const SKELETONS = join(ASSETS_ROOT, "characters", "skeletons");

const MOVEMENT_ANIMS = ["idle", "walk", "run"];
const DIRECTIONS = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"];

function dirsIn(p) {
  if (!existsSync(p)) return [];
  return readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory());
}

/** Read a PNG's [width, height] from its IHDR header (no image library). */
function pngDims(p) {
  const b = readFileSync(p);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function displayName(look, fallback) {
  let s = (look || fallback || "").trim();
  for (const sep of [",", ";", " with ", " glowing", " wearing"]) {
    const i = s.indexOf(sep);
    if (i > 0) s = s.slice(0, i);
  }
  s = s.trim();
  return s ? s[0].toUpperCase() + s.slice(1) : fallback;
}

function scan() {
  const characters = [];
  if (!existsSync(SKELETONS)) return characters;
  for (const skel of dirsIn(SKELETONS)) {
    const charsRoot = join(SKELETONS, skel, "characters");
    for (const id of dirsIn(charsRoot)) {
      const charDir = join(charsRoot, id);
      const animsDir = join(charDir, "animations");
      const animations = {};
      let frameW = 0;
      let frameH = 0;
      for (const anim of MOVEMENT_ANIMS) {
        const perDir = {};
        for (const d of DIRECTIONS) {
          const frameDir = join(animsDir, anim, d);
          const strip = join(animsDir, `${anim}__${d}.png`);
          if (!existsSync(frameDir) || !existsSync(strip)) continue;
          const count = readdirSync(frameDir).filter((f) => f.endsWith(".png")).length;
          if (count > 0) {
            perDir[d] = count;
            if (!frameH) [frameW, frameH] = pngDims(join(frameDir, "00.png"));
          }
        }
        if (Object.keys(perDir).length) animations[anim] = perDir;
      }
      if (!Object.keys(animations).length) continue; // unplayable
      let look = "";
      const metaPath = join(charDir, "character.json");
      if (existsSync(metaPath)) {
        try {
          look = JSON.parse(readFileSync(metaPath, "utf8")).look || "";
        } catch {}
      }
      const webRoot = "/assets/" + relative(ASSETS_ROOT, charDir).split("\\").join("/");
      characters.push({
        uid: `${skel}/${id}`,
        skeleton: skel,
        id,
        name: displayName(look, id),
        root: webRoot,
        portrait: `${webRoot}/portrait.png`,
        frameW,
        frameH,
        animations,
      });
    }
  }
  return characters;
}

// /assets/* URLs are served by a Vite middleware in dev and by the Colyseus
// server in production (see client/vite.config.ts and server/index.ts).
const publicDir = join(GAME_ROOT, "client", "public");
mkdirSync(publicDir, { recursive: true });

const characters = scan();
const out = { generatedFrom: "pixel/characters", directions: DIRECTIONS, characters };
writeFileSync(join(publicDir, "characters.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`[manifest] ${characters.length} characters -> client/public/characters.json`);
