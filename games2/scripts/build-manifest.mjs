// Emit a character manifest the web client loads. The game lives at
// pixel/games/nangijala; character art is a sibling domain at <repo>/characters/.
// Frame URLs are served under /assets/... (see client/vite.config.ts + server).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SCRIPT_DIR, ".."); // pixel/games2
// Art domains live at the repo root by default; ASSETS_ROOT overrides it (Docker).
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(SCRIPT_DIR, "..", "..");
// v2 characters: characters2/humans/<id>/{base,animations}. Two characters
// (default_boy = "Man", default_girl = "Woman"), 112x112 frames, animations as
// frame FOLDERS (animations/<srcAnim>/<dir>/N.png, unpadded N) — NOT strips.
const HUMANS = join(ASSETS_ROOT, "characters2", "humans");

// Game movement state -> characters2 source animation folder name. The client
// keeps using idle/walk/run/jump as state names; animSrc (below) tells it the
// folder to build frame URLs from.
const ANIM_MAP = {
  idle: "breathing-idle",
  walk: "walking",
  run: "running-8-frames",
  jump: "jumping-1",
  runjump: "running-jump",
  kick: "high-kick",
};
// Friendly display name per character id (character.json names are prompt junk).
const DISPLAY = { default_boy: "Man", default_girl: "Woman" };
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
 * Measure the FOOT ANCHOR of a frame: the point BETWEEN the two feet at sole
 * level — where the character contacts the ground. The game pins this to the
 * collision position, so the drop-shadow (which marks the true world position)
 * sits centred between the drawn feet, and the feet meet edges/walls exactly.
 *
 * We look at a SOLE BAND (the bottom ~9% of the frame — tall enough to catch
 * BOTH feet even when a 3/4-view pose sets one sole a few px higher than the
 * other), collapse it to a per-column "is there a sole pixel here" mask, split
 * that into contiguous runs = the feet, and take the MIDPOINT BETWEEN the outer
 * two feet's centres. This is robust to unequal foot size and to a centred
 * ponytail/dress hem (a middle run never moves the outermost centres). The old
 * method — bounding-box midpoint of only the bottom 4 rows — saw just the lower
 * foot in angled poses and skewed the anchor up to ±5px sideways per direction,
 * so the shadow drifted out from between the feet as the character turned.
 */
function footAnchor(framePath) {
  const png = pngAlpha(framePath);
  if (!png) return null;
  const { w, h, opaque } = png;
  let bottom = -1;
  let top = -1;
  for (let y = h - 1; y >= 0 && bottom < 0; y--) {
    for (let x = 0; x < w; x++) {
      if (opaque(x, y)) {
        bottom = y;
        break;
      }
    }
  }
  for (let y = 0; y < h && top < 0; y++) {
    for (let x = 0; x < w; x++) {
      if (opaque(x, y)) {
        top = y;
        break;
      }
    }
  }
  if (bottom < 0) return null;
  const band = Math.max(6, Math.round(h * 0.09)); // ≈10px at 112
  const y0 = Math.max(0, bottom - band + 1);
  const colHit = new Array(w).fill(false);
  for (let x = 0; x < w; x++) {
    for (let y = y0; y <= bottom; y++) {
      if (opaque(x, y)) {
        colHit[x] = true;
        break;
      }
    }
  }
  // Contiguous runs of sole columns → feet (drop 1px specks / stray pixels).
  const feet = [];
  let s = -1;
  for (let x = 0; x < w; x++) {
    if (colHit[x] && s < 0) s = x;
    else if (!colHit[x] && s >= 0) {
      if (x - 1 - s >= 1) feet.push((s + x - 1) / 2);
      s = -1;
    }
  }
  if (s >= 0 && w - 1 - s >= 1) feet.push((s + w - 1) / 2);
  if (!feet.length) return null;
  const ax = (Math.min(...feet) + Math.max(...feet)) / 2; // between the outer feet
  // Fractions of the frame: (x,y) = foot anchor for the sprite origin;
  // top = crown of the head, so labels can hug the character instead of
  // floating at the (mostly transparent) frame top.
  return {
    x: +(ax / w).toFixed(4),
    y: +((bottom + 1) / h).toFixed(4),
    top: +(Math.max(0, top) / h).toFixed(4),
  };
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
  if (!existsSync(HUMANS)) return characters;
  for (const id of dirsIn(HUMANS)) {
    if (id.startsWith("_")) continue; // _experiments etc.
    const charDir = join(HUMANS, id);
    const animsDir = join(charDir, "animations");
    if (!existsSync(animsDir)) continue;
    // Movement/action states -> per-direction frame counts, plus animSrc (the
    // source folder each state maps to) so the client can build frame URLs.
    const animations = {};
    const animSrc = {};
    let frameW = 0;
    let frameH = 0;
    for (const [state, src] of Object.entries(ANIM_MAP)) {
      const perDir = {};
      for (const d of DIRECTIONS) {
        const frameDir = join(animsDir, src, d);
        if (!existsSync(frameDir)) continue; // some anims (high-kick) lack NE/NW
        const count = readdirSync(frameDir).filter((f) => /^\d+\.png$/.test(f)).length;
        if (count > 0) {
          perDir[d] = count;
          if (!frameH) [frameW, frameH] = pngDims(join(frameDir, "0.png"));
        }
      }
      if (Object.keys(perDir).length) {
        animations[state] = perDir;
        animSrc[state] = src;
      }
    }
    if (!animations.idle) continue; // unplayable without an idle
    // Foot anchors per direction (from idle frame 0) — where the sole line
    // sits inside the frame, as origin fractions for the client.
    const anchors = {};
    for (const d of Object.keys(animations.idle)) {
      const a = footAnchor(join(animsDir, ANIM_MAP.idle, d, "0.png"));
      if (a) anchors[d] = a;
    }
    const webRoot = "/assets/" + relative(ASSETS_ROOT, charDir).split("\\").join("/");
    characters.push({
      uid: id,
      skeleton: "humans",
      id,
      name: DISPLAY[id] || id,
      root: webRoot,
      // No portrait.png in characters2 — use the south rotation as the face.
      portrait: `${webRoot}/base/south.png`,
      frameW,
      frameH,
      animations,
      animSrc,
      anchors,
    });
  }
  return characters;
}

// /assets/* URLs are served by a Vite middleware in dev and by the Colyseus
// server in production (see client/vite.config.ts and server/index.ts).
const publicDir = join(GAME_ROOT, "client", "public");
mkdirSync(publicDir, { recursive: true });

const characters = scan();
const out = { generatedFrom: "pixel/characters2", directions: DIRECTIONS, characters };
writeFileSync(join(publicDir, "characters.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`[manifest] ${characters.length} characters -> client/public/characters.json`);
