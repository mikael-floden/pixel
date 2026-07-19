// Emit a character manifest the web client loads. The game lives at
// pixel/games2; character art is the sibling characters2/ domain.
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

// Hand-specified swim waterlines (maintainer, per character/direction). These
// OVERRIDE the auto-detected shoulder line where present — a finger-drawn line
// is truer than the silhouette heuristic. See data/waterlines.json.
const WATERLINES = (() => {
  const p = join(GAME_ROOT, "data", "waterlines.json");
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  } catch {
    return {};
  }
})();

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
 * SHOULDER LINE (swimming waterline): the two shoulder points, so the swim
 * renderer can float the character with head+shoulders above the water and
 * clip everything below the line between them (maintainer: "a line between the
 * shoulders... everything below is under the water"). The two points may sit
 * at different heights (side/diagonal views), so the line can tilt.
 *
 * Method: take the figure's silhouette extent per row. Below the head there's
 * a NECK (narrowest row in the upper head zone); the shoulders flare out just
 * under it. In the band right below the neck, the LEFT shoulder is the
 * leftmost-reaching opaque pixel (with its own y) and the RIGHT shoulder the
 * rightmost-reaching one — so a side view whose front shoulder is drawn lower
 * yields a tilted line. Returned normalized (0..1) in frame space.
 */
function shoulderLine(png) {
  const { w, h, opaque } = png;
  let top = -1;
  let bottom = -1;
  const ext = []; // per row: {y, mn, mx} silhouette left/right edge
  for (let y = 0; y < h; y++) {
    let mn = -1;
    let mx = -1;
    for (let x = 0; x < w; x++)
      if (opaque(x, y)) {
        if (mn < 0) mn = x;
        mx = x;
      }
    if (mn >= 0) {
      if (top < 0) top = y;
      bottom = y;
    }
    ext.push({ y, mn, mx });
  }
  if (top < 0) return null;
  const figH = bottom - top;
  const wid = (y) => (ext[y].mn < 0 ? 0 : ext[y].mx - ext[y].mn);
  // Neck = the pinch just below the head: narrowest row in the UPPER third
  // only (searching lower catches the waist when the arms flare the torso).
  let neck = top + Math.round(0.22 * figH);
  let neckW = Infinity;
  for (let y = top + Math.round(0.12 * figH); y <= top + Math.round(0.34 * figH); y++) {
    const wv = wid(y);
    if (wv > 0 && wv <= neckW) {
      neckW = wv;
      neck = y;
    }
  }
  // Shoulders sit a fixed bit BELOW the neck pinch (the head is often as wide
  // as the shoulders, so a width-flare test lands on the jaw — offset instead).
  const shoulderRow = Math.min(bottom, neck + Math.round(0.11 * figH));
  // Left/right shoulder = outermost edges in a tight band at the shoulder tops,
  // each with its OWN y so the line tilts as much as the two sides differ.
  const b1 = Math.min(bottom, shoulderRow + Math.max(2, Math.round(0.05 * figH)));
  let ls = null;
  let rs = null;
  for (let y = shoulderRow; y <= b1; y++) {
    const e = ext[y];
    if (e.mn < 0) continue;
    if (!ls || e.mn < ls.x) ls = { x: e.mn, y };
    if (!rs || e.mx > rs.x) rs = { x: e.mx, y };
  }
  if (!ls || !rs) return null;
  return {
    lx: +(ls.x / w).toFixed(4),
    ly: +(ls.y / h).toFixed(4),
    rx: +(rs.x / w).toFixed(4),
    ry: +(rs.y / h).toFixed(4),
  };
}

/** Lowest row of the figure with real mass (>=3 opaque px) — the ground line.
 * NOT the single lowest pixel: a 1-2px toe tip / anti-alias speck dragged the
 * old anchor below the soles, so characters read as hovering. */
function soleOf(png) {
  const { w, h, opaque } = png;
  for (let y = h - 1; y >= 0; y--) {
    let n = 0;
    for (let x = 0; x < w && n < 3; x++) if (opaque(x, y)) n++;
    if (n >= 3) return y;
  }
  return -1;
}

/** 8-connected blobs of opaque pixels in the bottom `band` rows above `sole`
 * — the feet (plus whatever legs/hem dip into the band). Returns
 * {minX, maxX, maxY, size} per blob. */
function bandBlobs(png, sole, band) {
  const { w, opaque } = png;
  const y0 = Math.max(0, sole - band + 1);
  const bandH = sole - y0 + 1;
  const label = new Int32Array(w * bandH).fill(-1);
  const blobs = [];
  for (let by = 0; by < bandH; by++)
    for (let x = 0; x < w; x++) {
      if (label[by * w + x] >= 0 || !opaque(x, y0 + by)) continue;
      const id = blobs.length;
      const blob = { minX: x, maxX: x, maxY: y0 + by, size: 0 };
      const stack = [[x, by]];
      label[by * w + x] = id;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        blob.size++;
        if (cx < blob.minX) blob.minX = cx;
        if (cx > blob.maxX) blob.maxX = cx;
        if (y0 + cy > blob.maxY) blob.maxY = y0 + cy;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= bandH) continue;
            if (label[ny * w + nx] >= 0 || !opaque(nx, y0 + ny)) continue;
            label[ny * w + nx] = id;
            stack.push([nx, ny]);
          }
      }
      blobs.push(blob);
    }
  return blobs;
}

const blobCenter = (b) => (b.minX + b.maxX + 1) / 2; // pixel x spans [x, x+1)

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
  let top = -1;
  for (let y = 0; y < h && top < 0; y++) {
    for (let x = 0; x < w; x++) {
      if (opaque(x, y)) {
        top = y;
        break;
      }
    }
  }
  const sole = soleOf(png);
  if (sole < 0) return null;
  // The anchor is the point BETWEEN the feet, per the maintainer's spec: each
  // foot counts as its geometric CENTER — the midpoint of its toe-to-heel
  // span, NOT the toes, NOT the heels, NOT a mass centroid (mass skews toward
  // the chunkier foot) — and the anchor is midway between the two feet.
  //
  // Feet are found as 2D connected blobs in the bottom band (~10px — tall
  // enough that a 3/4-view back foot drawn a few px higher by perspective is
  // still seen; column runs alone would merge staggered feet). A blob only
  // counts as a PLANTED foot if it reaches within 6px of the sole line —
  // side-view back legs whose foot hides behind the front foot are ignored.
  const band = Math.max(8, Math.round(h * 0.09)); // ≈10px at 112
  const planted = bandBlobs(png, sole, band)
    .filter((b) => b.size >= 4 && b.maxY >= sole - 6)
    .sort((a, b) => a.minX + a.maxX - (b.minX + b.maxX));
  if (!planted.length) return null;
  // Two (or more) planted blobs = the feet: outermost two centres (a middle
  // blob — a hem, a tail — never moves the anchor). One blob = feet touching
  // or overlapping; its own centre is already between them.
  const first = planted[0];
  const last = planted[planted.length - 1];
  const ax = (blobCenter(first) + blobCenter(last)) / 2;
  // Depth: each foot's own ground line (bottom edge), averaged — for a
  // staggered 3/4 stance the anchor sits between the front and back foot —
  // then lifted ~2.5px from the toe line to mid-foot (centre of the foot,
  // not the toes; the playtester's green dot).
  const ay = (first.maxY + last.maxY + 2) / 2 - h * 0.022;
  return {
    x: +(ax / w).toFixed(4),
    y: +(ay / h).toFixed(4),
    top: +(Math.max(0, top) / h).toFixed(4),
  };
}

// ---- Anti-moonwalk gait rates -----------------------------------------------
// Movement speed in wu/s equals SCREEN px/s at zoom 1 in every direction
// (shared screenToWorldVector calibrates uniform projected speed with
// REF = ISO_DX = CELL_WU). Keep in sync with shared/src WALK_SPEED/RUN_SPEED.
const GAIT_SPEED = { walk: 70, run: 175 };
// Horizontal share of the screen travel vector per animation view. Diagonal
// key travel is grid-axis locked; its screen vector is (±ISO_DX, ±ISO_DY)
// normalized → |ux| = 32/√(32²+15²). North/south travel is vertical — those
// views can't encode a horizontal stride and simply inherit the gait's rate.
const GAIT_VIEW_UX = {
  east: 1,
  west: 1,
  "north-east": 0.9055,
  "north-west": 0.9055,
  "south-east": 0.9055,
  "south-west": 0.9055,
};
// A runner covers ground while AIRBORNE too; static frames only encode the
// stance sweep (foot spread). Real running spends ~55% of each step's
// distance grounded — divide to get the true stride. Walking has no flight.
const RUN_STANCE_FRACTION = 0.55;

/**
 * Derive the playback fps at which each gait's feet TRACK THE GROUND at the
 * gait's base speed ("anti-moonwalk"): fps = speed·frames / stride, where the
 * stride (ground covered per animation cycle) is measured from the art. The
 * step length is the MAX horizontal spread between the two foot blobs across
 * a cycle (full extension); stride = 2 steps. One rate per GAIT — legs keep
 * one cadence in every direction (per-direction rates made the legs pop when
 * turning, and the spread across views is measurement noise, ±5%).
 *
 * The previous attempt (measure-stride.py, SAD strip-matching) underestimated
 * strides so badly the formula demanded 16-30fps — the playtester's
 * "animation is playing way too fast". Runtime speed changes (water, easing)
 * are handled by anims.timeScale ∝ actual screen speed in WorldScene.
 */
function gaitFpsOf(animsDir, animations, animSrc) {
  const out = {};
  for (const gait of ["walk", "run"]) {
    const src = animSrc[gait];
    const perDir = animations[gait];
    if (!src || !perDir) continue;
    const fpsVotes = [];
    for (const [d, ux] of Object.entries(GAIT_VIEW_UX)) {
      const n = perDir[d];
      if (!n) continue;
      let spread = 0; // max foot-blob separation across the cycle = step px
      for (let i = 0; i < n; i++) {
        const png = pngAlpha(join(animsDir, src, d, `${i}.png`));
        if (!png) continue;
        const sole = soleOf(png);
        if (sole < 0) continue;
        const blobs = bandBlobs(png, sole, 12).filter((b) => b.size >= 6);
        for (let a = 0; a < blobs.length; a++)
          for (let b = a + 1; b < blobs.length; b++)
            spread = Math.max(spread, Math.abs(blobCenter(blobs[a]) - blobCenter(blobs[b])));
      }
      if (spread < 8) continue; // no usable stride in this view
      const stride = gait === "run" ? (2 * spread) / RUN_STANCE_FRACTION : 2 * spread;
      fpsVotes.push((GAIT_SPEED[gait] * ux * n) / stride);
    }
    if (!fpsVotes.length) continue;
    fpsVotes.sort((a, b) => a - b);
    out[gait] = +fpsVotes[fpsVotes.length >> 1].toFixed(1);
  }
  return out;
}

/**
 * FOOT-PLANT extraction (footstep marks): find the frames where a foot
 * TOUCHES DOWN and the exact pixel it lands on, per (gait, direction).
 *
 * A foot blob is GROUNDED when its lowest row reaches the frame's sole line
 * (within 2px). A PLANT event at frame i is a grounded blob with NO grounded
 * blob near the same x (±6px) in the PREVIOUS frame (cyclic) — i.e. this
 * foot just arrived on the ground. In-place gait art keeps the stance foot
 * still, so each foot yields exactly one plant per cycle (walk: 2 plants).
 * Position = the blob's centre x + its own ground row, in FRAME pixels —
 * the runtime converts through the sprite's origin/scale, so the mark lands
 * on the exact drawn spot (maintainer: "the exact spot the foot was down").
 */
function plantsOf(animsDir, src, dir, n) {
  const grounded = []; // per frame: [{x, y}]
  for (let i = 0; i < n; i++) {
    const png = pngAlpha(join(animsDir, src, dir, `${i}.png`));
    if (!png) return [];
    const sole = soleOf(png);
    if (sole < 0) return [];
    grounded.push(
      bandBlobs(png, sole, 12)
        .filter((b) => b.size >= 6 && b.maxY >= sole - 2)
        .map((b) => ({ x: +blobCenter(b).toFixed(1), y: b.maxY })),
    );
  }
  // A real touchdown STAYS planted: the foot must be absent at i-1 (it was
  // swinging) AND still grounded near the same spot at i+1 (stance persists).
  // Without the persistence check, side views over-detected 6-7 "plants" per
  // 8-frame cycle from blob jitter/splits — a cycle has exactly two.
  const near = (list, x, r) => list.some((q) => Math.abs(q.x - x) <= r);
  const plants = [];
  for (let i = 0; i < n; i++) {
    const prev = grounded[(i - 1 + n) % n];
    const next = grounded[(i + 1) % n];
    for (const g of grounded[i]) {
      if (!near(prev, g.x, 6) && near(next, g.x, 6)) {
        plants.push({ f: i, x: g.x, y: g.y });
      }
    }
  }
  return plants;
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
    // ONE foot anchor per DIRECTION, applied to every state — deliberately
    // NOT per-state/per-frame (per-state anchors snap the sprite sideways at
    // every idle→walk→run transition; maintainer prefers a stable pin). The
    // measurement is the per-direction MEDIAN across the idle frames using
    // the robust sole line + contact-band centroid (see footAnchor); `top`
    // (label height) comes from idle frame 0.
    const anchors = {};
    for (const [d, n] of Object.entries(animations.idle)) {
      const xs = [];
      const ys = [];
      let top;
      for (let i = 0; i < n; i++) {
        const a = footAnchor(join(animsDir, ANIM_MAP.idle, d, `${i}.png`));
        if (a) {
          xs.push(a.x);
          ys.push(a.y);
          if (i === 0) top = a.top;
        }
      }
      if (xs.length) {
        xs.sort((p, q) => p - q);
        ys.sort((p, q) => p - q);
        anchors[d] = { x: xs[xs.length >> 1], y: ys[ys.length >> 1], top };
      }
    }
    // Shoulder line per direction (swimming waterline). A hand-specified line
    // (data/waterlines.json) wins; otherwise auto-detect from the silhouette
    // (component-wise median across the idle frames, like the foot anchor).
    const shoulders = {};
    const override = WATERLINES[id] || {};
    for (const [d, n] of Object.entries(animations.idle)) {
      if (override[d]) {
        shoulders[d] = override[d];
        continue;
      }
      const keys = ["lx", "ly", "rx", "ry"];
      const acc = { lx: [], ly: [], rx: [], ry: [] };
      for (let i = 0; i < n; i++) {
        const png = pngAlpha(join(animsDir, ANIM_MAP.idle, d, `${i}.png`));
        const s = png && shoulderLine(png);
        if (s) for (const k of keys) acc[k].push(s[k]);
      }
      if (acc.lx.length) {
        const med = (a) => (a.sort((p, q) => p - q), a[a.length >> 1]);
        shoulders[d] = { lx: med(acc.lx), ly: med(acc.ly), rx: med(acc.rx), ry: med(acc.ry) };
      }
    }
    const gaitFps = gaitFpsOf(animsDir, animations, animSrc);
    // Footstep plants for the moving gaits (walk/run; jump lands too).
    const plants = {};
    for (const state of ["walk", "run"]) {
      const src = animSrc[state];
      const perDir = animations[state];
      if (!src || !perDir) continue;
      const byDir = {};
      for (const [d, n] of Object.entries(perDir)) {
        const ev = plantsOf(animsDir, src, d, n);
        if (ev.length) byDir[d] = ev;
      }
      if (Object.keys(byDir).length) plants[state] = byDir;
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
      shoulders,
      gaitFps,
      plants,
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
