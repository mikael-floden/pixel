// Emit a character manifest the web client loads. The game lives at
// pixel/games2; character art is the sibling characters2/ domain.
// Frame URLs are served under /assets/... (see client/vite.config.ts + server).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
// PNG *and* lossless WebP — the art domains are migrating and this builder was
// the blocker (it hand-parsed the IHDR). The PNG paths inside imagelib are the
// originals moved verbatim, so a PNG repo still produces the identical
// manifest; see scripts/imagelib.mjs and server/test/imagelib.test.ts.
import { footAnchor, soleOf, bandBlobs, blobCenter } from "./anchorlib.mjs";
import { imgAlpha, imgDims, findImg, countFrames, IMG_EXTS } from "./imagelib.mjs";

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
// keeps using idle/walk/run/jump… as state names; animSrc (below) tells it the
// folder to build frame URLs from.
//
// PixelLab renames animation folders (e.g. "high-kick" -> "custom-high-kick"),
// and the two heroes can differ (boy "walking-6-frames" vs girl "walking"), so
// this mapping is OWNED BY THE ART DOMAIN in characters2/animation_map.json and
// loaded here. When a folder is renamed, only that file changes — no game edit.
// The built-in below is a fallback that matches the file's current contents so a
// missing/broken file never fully breaks the build.
const ANIM_MAP_FALLBACK = {
  states: {
    idle: "custom-calm-idle",
    walk: "custom-walking-full-cycle-until-the",
    run: "custom-running-full-cycle-until-the",
    jump: "custom-running-steeplechase-jump-knees-high-and-close-to",
    kick: "custom-high-kick",
    punch: "custom-punch",
    sword: "custom-swing-a-sword",
    bow: "custom-shot-arrow-with-bow",
    spell_wand: "custom-spell-attack-with-magic-wand",
    spell_channel: "custom-channeled-spell-between-hands-with-both-hands",
    hurt: "custom-got-punched-in-stomach-takes",
    pickup: "custom-pick-up-item-from-ground",
    die: "custom-fall-dead-to-the-floor",
  },
  overrides: {
    default_boy: {
      walk: "custom-full-walk-cycle-walking-until",
      run: "custom-full-run-cycle-running-until",
      jump: "custom-fast-running-steeplechase-jump",
      spell_wand: "custom-spell-with-magic-wand",
    },
  },
};
const ANIM_MAP_DATA = (() => {
  const p = join(HUMANS, "..", "animation_map.json");
  try {
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j && j.states) return { states: j.states, overrides: j.overrides || {} };
    }
  } catch (e) {
    console.warn(`[manifest] could not read animation_map.json (${e.message}); using built-in fallback`);
  }
  return ANIM_MAP_FALLBACK;
})();
// The resolved game-state -> folder map FOR ONE hero (per-hero override wins).
function animMapFor(id) {
  return { ...ANIM_MAP_DATA.states, ...(ANIM_MAP_DATA.overrides[id] || {}) };
}
// Friendly display name per character id (character.json names are prompt junk).
const DISPLAY = { default_boy: "Man", default_girl: "Woman" };
const DIRECTIONS = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"];

function dirsIn(p) {
  if (!existsSync(p)) return [];
  return readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory());
}

// pngDims / pngAlpha used to live here. They moved VERBATIM into
// scripts/imagelib.mjs (as imgDims / imgAlpha) when the art domains started
// migrating to lossless WebP, so both formats resolve through one dispatch and
// the PNG behaviour — including the `> 64` alpha threshold — is unchanged.

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

// soleOf/bandBlobs/blobCenter/footAnchor now live in anchorlib.mjs (shared
// with build-npcs-manifest.mjs) — moved verbatim, same measurements.

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
        const fp = findImg(join(animsDir, src, d), String(i));
        const png = fp && imgAlpha(fp);
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
/** THE GRAB (maintainer 2026-08-06: "the player should walk to the location
 * where the hand in the pick up animation is … looking like it actually picks
 * up that exact item", and the item must vanish "the exact frame the hand is
 * closest to the ground").
 *
 * The pickup art ANSWERS BOTH QUESTIONS ITSELF: it draws a little item lying
 * on the ground in front of the character, the hand comes down, and the item
 * DISAPPEARS from the ground on the frame it is grabbed (it re-appears in the
 * hands a frame or two later). So per direction we measure:
 *  - `off` {x,y}: where that drawn item sits RELATIVE TO THE FOOT ANCHOR, in
 *    frame px — the exact spot a real ground item must occupy for the gesture
 *    to land on it;
 *  - `f`: the frame it vanishes = the grab.
 * The item is found as a DETACHED silhouette component (not touching the body)
 * sitting low in the frame — verified against the art for every direction that
 * draws one. SOUTH and NORTH draw it merged into the body silhouette (the
 * character is face-on/back-on, so it overlaps the feet), so those two are
 * interpolated from their neighbours rather than invented: x mirrors to 0 and
 * y takes the mean of the two adjacent diagonals. */
function grabOf(animsDir, src, perDir, anchors) {
  if (!src || !perDir) return null;
  const out = {};
  for (const [d, n] of Object.entries(perDir)) {
    const seen = []; // per frame: the detached ground blob, if any
    for (let i = 0; i < n; i++) {
      const p = findImg(join(animsDir, src, d), String(i));
      const png = p && imgAlpha(p);
      if (!png) { seen.push(null); continue; }
      seen.push(groundBlob(png));
    }
    const a = anchors[d];
    if (!a) continue;
    // VALIDATE each candidate before believing it. Not every detached blob is
    // the loot: a late frame can split off the hair, or the item already held
    // in the hands. A real ground item (a) lies ON the ground, at or below the
    // foot line, and (b) sits on the side the character is FACING — a blob
    // 24px out to the side of a back-facing sprite is not what it reaches for.
    const wantSign = /east/.test(d) ? 1 : /west/.test(d) ? -1 : 0;
    const plausible = (b) => {
      if (!b) return false;
      if (b.maxY < a.y * b.h - 6) return false; // floating above the feet
      const dx = b.cx / b.w - a.x;
      return wantSign === 0 ? Math.abs(dx) < 0.07 : Math.sign(dx) === wantSign;
    };
    // It must appear for a RUN of frames and then vanish — that vanish IS the
    // grab. (A blob present to the last frame was never picked up.)
    const first = seen.findIndex(plausible);
    if (first < 0) continue;
    let last = first;
    while (last + 1 < seen.length && plausible(seen[last + 1])) last++;
    if (last >= seen.length - 1) continue; // never picked up — not the item
    const blob = seen[last];
    const { w, h } = blob;
    out[d] = {
      f: last + 1, // the frame the item is GONE = the hand closed on it
      x: +(blob.cx / w - a.x).toFixed(4), // frame fractions, anchor-relative
      y: +(blob.cy / h - a.y).toFixed(4),
    };
  }
  // SOUTH / NORTH: interpolate from the measured neighbours (see above).
  const lerpAxis = (axis, l, r) => {
    if (out[axis] || !out[l] || !out[r]) return;
    out[axis] = {
      f: Math.round((out[l].f + out[r].f) / 2),
      x: 0, // dead ahead: the art mirrors, so the two diagonals cancel
      y: +((out[l].y + out[r].y) / 2).toFixed(4),
      approx: true,
    };
  };
  lerpAxis("south", "south-west", "south-east");
  lerpAxis("north", "north-west", "north-east");
  return Object.keys(out).length ? out : null;
}

/** The lowest DETACHED silhouette component of a frame — the item lying on the
 * ground beside the character. Returns null when everything is one blob (the
 * item is drawn touching the body, or there is no item). */
function groundBlob(png) {
  const { w, h, opaque } = png; // imgAlpha's contract: a predicate, not a buffer
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && opaque(x, y);
  const seen = new Uint8Array(w * h);
  const comps = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!on(x, y) || seen[i]) continue;
      const stack = [[x, y]];
      seen[i] = 1;
      const pts = [];
      while (stack.length) {
        const [cx, cy] = stack.pop();
        pts.push([cx, cy]);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            const ni = ny * w + nx;
            if (on(nx, ny) && !seen[ni]) { seen[ni] = 1; stack.push([nx, ny]); }
          }
      }
      comps.push(pts);
    }
  }
  if (comps.length < 2) return null;
  comps.sort((a, b) => b.length - a.length);
  // Every component but the body; take the one nearest the ground (max y).
  let best = null;
  for (const c of comps.slice(1)) {
    if (c.length < 3) continue;
    const maxY = Math.max(...c.map((p) => p[1]));
    if (!best || maxY > best.maxY) {
      const cx = c.reduce((s, p) => s + p[0], 0) / c.length;
      const cy = c.reduce((s, p) => s + p[1], 0) / c.length;
      best = { cx, cy, maxY, n: c.length, w, h };
    }
  }
  return best;
}

function plantsOf(animsDir, src, dir, n) {
  const grounded = []; // per frame: [{x, y}]
  for (let i = 0; i < n; i++) {
    const fp = findImg(join(animsDir, src, dir), String(i));
    const png = fp && imgAlpha(fp);
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
    // state -> file extension when it is NOT png (WebP migration). Absent = png,
    // so a fully-PNG repo emits a byte-identical manifest.
    const animExt = {};
    let frameW = 0;
    let frameH = 0;
    const animMap = animMapFor(id);
    for (const [state, src] of Object.entries(animMap)) {
      const perDir = {};
      let stateExt = null;
      for (const d of DIRECTIONS) {
        const frameDir = join(animsDir, src, d);
        if (!existsSync(frameDir)) continue; // some anims (high-kick) lack NE/NW
        const count = countFrames(frameDir);
        if (count > 0) {
          perDir[d] = count;
          const f0 = findImg(frameDir, "0");
          if (!frameH) [frameW, frameH] = imgDims(f0);
          // Record the extension the art ACTUALLY ships so the client never has
          // to guess (it used to hardcode ".png" in frameUrl). Mixed extensions
          // inside one animation would be a half-finished conversion — warn
          // rather than silently emitting URLs that 404 for some directions.
          const ext = f0.slice(f0.lastIndexOf(".") + 1).toLowerCase();
          if (stateExt && stateExt !== ext)
            console.warn(`[manifest] ${id}: state "${state}" mixes .${stateExt} and .${ext} across directions — finish the conversion`);
          stateExt = stateExt || ext;
        }
      }
      if (Object.keys(perDir).length) {
        animations[state] = perDir;
        animSrc[state] = src;
        if (stateExt && stateExt !== "png") animExt[state] = stateExt;
      } else if (!existsSync(join(animsDir, src))) {
        // Loud, not silent: a mapped folder that doesn't exist means the art was
        // renamed on PixelLab and characters2/animation_map.json is stale.
        console.warn(`[manifest] ${id}: state "${state}" -> folder "${src}" is MISSING — update characters2/animation_map.json`);
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
        const ap = findImg(join(animsDir, animMap.idle, d), String(i));
        const a = ap && footAnchor(ap);
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
        const sp = findImg(join(animsDir, animMap.idle, d), String(i));
        const png = sp && imgAlpha(sp);
        const s = png && shoulderLine(png);
        if (s) for (const k of keys) acc[k].push(s[k]);
      }
      if (acc.lx.length) {
        const med = (a) => (a.sort((p, q) => p - q), a[a.length >> 1]);
        shoulders[d] = { lx: med(acc.lx), ly: med(acc.ly), rx: med(acc.rx), ry: med(acc.ry) };
      }
    }
    const grab = grabOf(animsDir, animSrc.pickup, animations.pickup, anchors);
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
    // The select screen pivots through base/<dir>.<ext>; resolve the extension
    // that is actually on disk rather than assuming png (WebP migration).
    const portraitPath = findImg(join(charDir, "base"), "south");
    const portraitExt = portraitPath
      ? portraitPath.slice(portraitPath.lastIndexOf(".") + 1).toLowerCase()
      : IMG_EXTS[0];
    characters.push({
      uid: id,
      skeleton: "humans",
      id,
      name: DISPLAY[id] || id,
      root: webRoot,
      // No portrait.png in characters2 — use the south rotation as the face.
      // Extension resolved from disk: base/ converts to WebP like everything else.
      portrait: `${webRoot}/base/south.${portraitExt}`,
      frameW,
      frameH,
      animations,
      animSrc,
      ...(Object.keys(animExt).length ? { animExt } : {}),
      anchors,
      shoulders,
      gaitFps,
      plants,
      // Where the pickup gesture's hand meets the ground, per direction, and
      // the frame it closes on the item (see grabOf).
      grab,
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
