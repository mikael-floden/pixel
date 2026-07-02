// Emit a character manifest the web client loads. The game lives at
// pixel/games/nangijala; character art is a sibling domain at <repo>/characters/.
// Frame URLs are served under /assets/... (see client/vite.config.ts + server).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

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

/**
 * Minimal PNG decode (8-bit RGBA/RGB, non-interlaced — what PixelLab emits)
 * returning an alpha-test function. No image library so this also runs inside
 * the production Docker build.
 */
function pngAlpha(p) {
  const b = readFileSync(p);
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  const bitDepth = b[24];
  const colorType = b[25];
  const interlace = b[28];
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) return null;
  const channels = colorType === 6 ? 4 : 3;
  // Concatenate IDAT chunks, inflate, unfilter.
  let off = 8;
  const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(b.subarray(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const img = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = img.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? img.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0; // left
      const bb = prev ? prev[i] : 0; // up
      const c = prev && i >= channels ? prev[i - channels] : 0; // up-left
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += bb;
      else if (filter === 3) v += (a + bb) >> 1;
      else if (filter === 4) {
        const pth = a + bb - c;
        const pa = Math.abs(pth - a);
        const pb = Math.abs(pth - bb);
        const pc = Math.abs(pth - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? bb : c;
      }
      out[i] = v & 0xff;
    }
  }
  const opaque = (x, y) => (colorType === 2 ? true : img[y * stride + x * channels + 3] > 64);
  return { w, h, opaque };
}

/**
 * Measure the FOOT ANCHOR of a frame: the centre pixel between the two feet at
 * sole level — the point where the character contacts the ground. This is what
 * the game pins to the collision position, so drawn feet meet edges/walls
 * exactly. Measured over the bottom 4 opaque rows (the soles).
 */
function footAnchor(framePath) {
  const png = pngAlpha(framePath);
  if (!png) return null;
  const { w, h, opaque } = png;
  let bottom = -1;
  for (let y = h - 1; y >= 0 && bottom < 0; y--) {
    for (let x = 0; x < w; x++) {
      if (opaque(x, y)) {
        bottom = y;
        break;
      }
    }
  }
  if (bottom < 0) return null;
  let sum = 0;
  let n = 0;
  for (let y = Math.max(0, bottom - 3); y <= bottom; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < w; x++) {
      if (opaque(x, y)) {
        if (lo < 0) lo = x;
        hi = x;
      }
    }
    if (lo >= 0) {
      sum += (lo + hi) / 2;
      n++;
    }
  }
  if (!n) return null;
  // Fractions of the frame so the client can use them as sprite origin.
  return { x: +(sum / n / w).toFixed(4), y: +((bottom + 1) / h).toFixed(4) };
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
      // Foot anchors per direction (from idle frame 0) — where the sole line
      // sits inside the frame, as origin fractions for the client.
      const anchors = {};
      for (const d of Object.keys(animations.idle ?? {})) {
        const a = footAnchor(join(animsDir, "idle", d, "00.png"));
        if (a) anchors[d] = a;
      }
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
        anchors,
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
