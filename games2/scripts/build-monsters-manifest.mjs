// Emit a MONSTER manifest the web client loads (parallel to build-manifest.mjs
// for characters). Monster art lives in the sibling `monsters/` domain at the
// repo root: monsters/<id>/monster.json + horizontal animation STRIPS
// (monsters/<id>/animations/<anim>__<dir>.png, width = frames*48, height = 48).
// Strips are served under /assets/monsters/... (see client/vite.config.ts +
// server/index.ts allowlists). One entry per monster in roster order.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SCRIPT_DIR, ".."); // pixel/games2
// Art domains live at the repo root by default; ASSETS_ROOT overrides it (Docker).
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(SCRIPT_DIR, "..", "..");
const MONSTERS = join(ASSETS_ROOT, "monsters");
const ROSTER = join(MONSTERS, "config", "roster.json");

// Client-canonical direction order (matches shared DIRECTIONS + characters.json).
// monster.json keys animation directions by NAME (its own `directions` array is
// alphabetical/un-normalized), so we key by name and emit in THIS order.
const DIRECTIONS = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"];

// Legacy poring-family emit order kept for a stable manifest diff; ids not in
// this list (the 2026-07-29 24-monster roster) follow in roster order — the
// runtime keys monsters by id, so array order is presentation-only.
const KIND_ORDER = ["poring", "forest_poring", "ice_poring", "lava_poring", "sand_poring", "water_poring"];

// The monsters agent's stable GAME-STATE -> animation mapping (same contract
// as characters2/animation_map.json): states + per-monster overrides. The walk
// resolution MUST go through this — the old hardcoded {walk:"jump"} predates
// the 24-monster roster, whose art ships walk/idle/angry/attack/die folders
// (no "jump"), so every new monster resolved to a missing anim and rendered
// as a placeholder square.
const ANIM_MAP = (() => {
  try {
    const j = JSON.parse(readFileSync(join(MONSTERS, "animation_map.json"), "utf8"));
    if (j && j.states) return j;
  } catch {}
  return null;
})();

/** Read a PNG's [width, height] from its IHDR header (no image library). */
function pngDims(p) {
  const b = readFileSync(p);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

// Winged/floating monsters that are MEANT to hover (maintainer 2026-07-30:
// "no monster is flying unless they have wings and the flying animation is
// intentional"). The client lifts the sprite by hoverPx above the ground
// anchor and keeps the nadir shadow ON the ground (the bird pattern).
const HOVER_PX = { butterfly_dragon: 12 };

/** Measure a monster's WALK art (full pixel decode of every direction strip):
 * - artBottom: the FEET line as a fraction of the TRUE frame height — the p90
 *   of per-frame opaque bottoms (robust to a stray pixel, keeps the ground
 *   contact of a gait whose body bobs);
 * - footW: ground-contact footprint — median opaque row width over the bottom
 *   ~14% of each frame's body;
 * - bodyW: median full opaque width (the mass the shadow should suggest for
 *   creatures that taper to a wisp at the ground).
 * Rows need >= 2 opaque px (alpha > 16) to count, killing lone noise pixels. */
function measureWalkArt(stripAbsPaths, framesByDir) {
  const bots = [];
  const foots = [];
  const bodies = [];
  let frameH = 0;
  let frameW = 0;
  for (const [dir, abs] of Object.entries(stripAbsPaths)) {
    let png;
    try {
      png = PNG.sync.read(readFileSync(abs));
    } catch {
      continue;
    }
    const { width: W, height: H, data } = png;
    const n = framesByDir[dir] || 1;
    const fw = Math.round(W / n);
    frameH = Math.max(frameH, H);
    frameW = Math.max(frameW, fw);
    for (let f = 0; f < n; f++) {
      const xBase = f * fw;
      let top = -1;
      let bot = -1;
      const rowW = new Map();
      for (let y = 0; y < H; y++) {
        let cnt = 0;
        let x0 = -1;
        let x1 = -1;
        for (let x = 0; x < fw; x++) {
          if (data[(y * W + xBase + x) * 4 + 3] > 16) {
            cnt++;
            if (x0 < 0) x0 = x;
            x1 = x;
          }
        }
        if (cnt >= 2) {
          if (top < 0) top = y;
          bot = y;
          rowW.set(y, x1 - x0 + 1);
        }
      }
      if (bot < 0) continue;
      bots.push(bot);
      bodies.push(Math.max(...rowW.values()));
      const band = Math.max(4, Math.round((bot - top) * 0.14));
      const ws = [];
      for (let y = Math.max(top, bot - band); y <= bot; y++) if (rowW.has(y)) ws.push(rowW.get(y));
      ws.sort((a, b) => a - b);
      if (ws.length) foots.push(ws[Math.floor(ws.length / 2)]);
    }
  }
  if (!bots.length) return null;
  bots.sort((a, b) => a - b);
  foots.sort((a, b) => a - b);
  bodies.sort((a, b) => a - b);
  const p90bot = bots[Math.min(bots.length - 1, Math.floor(bots.length * 0.9))];
  return {
    frameW,
    frameH,
    artBottom: +(Math.min(1, (p90bot + 1) / frameH)).toFixed(4),
    footW: foots[Math.floor(foots.length / 2)] ?? 0,
    bodyW: bodies[Math.floor(bodies.length / 2)] ?? 0,
  };
}

function scan() {
  const monsters = [];
  if (!existsSync(ROSTER)) {
    console.warn(`[monsters] no roster at ${ROSTER} — emitting empty manifest`);
    return monsters;
  }
  const roster = JSON.parse(readFileSync(ROSTER, "utf8"));
  const entries = [...(roster.monsters || [])].sort((a, b) => {
    const ia = KIND_ORDER.indexOf(a.id);
    const ib = KIND_ORDER.indexOf(b.id);
    return (ia < 0 ? KIND_ORDER.length : ia) - (ib < 0 ? KIND_ORDER.length : ib);
  });
  for (const entry of entries) {
    const id = entry.id;
    const monDir = join(MONSTERS, id);
    const monJson = join(monDir, "monster.json");
    if (!existsSync(monJson)) {
      console.warn(`[monsters] ${id}: no monster.json — skipping`);
      continue;
    }
    const m = JSON.parse(readFileSync(monJson, "utf8"));
    const frameW = m.size?.width ?? 48;
    const frameH = m.size?.height ?? 48;
    // Game-state -> anim mapping for THIS monster: animation_map.json states
    // with the per-monster override on top; per-file aliases win if present.
    const mapped = ANIM_MAP ? { ...ANIM_MAP.states, ...(ANIM_MAP.overrides?.[id] || {}) } : null;
    const aliases = m.animation_aliases || entry.aliases || (mapped ? { walk: mapped.walk } : { walk: "jump" });
    // Resolve the game-facing "walk" state to a real anim key (validated
    // against the scanned animations below — falls back to the first real
    // anim so a mapping gap can never emit an unrenderable monster).
    let walkAnim = aliases.walk || mapped?.walk || "jump";

    const animations = {}; // <animKey>: { <dir>: frameCount }
    const strips = {}; // <animKey>: { <dir>: served URL }
    const stripDims = {}; // <animKey>: { <dir>: {w, h} } — TRUE per-strip frame size
    const stripAbs = {}; // <animKey>: { <dir>: absolute path } (for measurement)
    for (const [animKey, anim] of Object.entries(m.animations || {})) {
      const perDirFrames = {};
      const perDirStrip = {};
      const perDirDims = {};
      const perDirAbs = {};
      const dirs = anim.directions || {};
      for (const d of DIRECTIONS) {
        const dd = dirs[d];
        if (!dd || !dd.strip) continue;
        const rel = dd.strip.split("\\").join("/");
        const abs = join(MONSTERS, rel);
        if (!existsSync(abs)) continue;
        perDirFrames[d] = dd.frames;
        // strip is repo-relative (e.g. "poring/animations/jump__south.png").
        perDirStrip[d] = "/assets/monsters/" + rel;
        perDirAbs[d] = abs;
        // MEASURED frame size per strip (IHDR only — cheap). The monster.json
        // `size` field goes stale when art is repaired/resized in place; the
        // client MUST slice each spritesheet with the strip's real dims or
        // frames bleed into each other (found 2026-07-30: 8+ monsters stale).
        const [sw, sh] = pngDims(abs);
        perDirDims[d] = { w: Math.round(sw / (dd.frames || 1)), h: sh };
      }
      if (Object.keys(perDirFrames).length) {
        animations[animKey] = perDirFrames;
        strips[animKey] = perDirStrip;
        stripDims[animKey] = perDirDims;
        stripAbs[animKey] = perDirAbs;
      }
    }

    // Validate the resolved walk against what actually shipped: a monster with
    // no anim at the mapped key falls back to its first real anim (and warns —
    // that's animation_map/roster data disagreeing with the art).
    if (!animations[walkAnim]) {
      const first = Object.keys(animations)[0];
      if (first) {
        console.warn(`[monsters] ${id}: walk anim "${walkAnim}" not in art — using "${first}"`);
        walkAnim = first;
      }
    }

    // Ground-truth the display metrics from the WALK art itself (full pixel
    // decode): feet line, footprint + body widths — the nadir shadow is
    // derived from these, not from the frame size (maintainer 2026-07-30:
    // frame-scaled shadows ran too big on padded frames, too small on tapered
    // bodies, and one fixed feet-origin left tall-margined art "flying").
    const walkArt = animations[walkAnim]
      ? measureWalkArt(stripAbs[walkAnim] ?? {}, animations[walkAnim])
      : null;

    monsters.push({
      id,
      name: m.name || entry.name || id,
      // Display reference = the MEASURED walk frame (monster.json size is the
      // stale fallback only). Per-strip dims ship in stripDims for slicing.
      frameW: walkArt?.frameW ?? frameW,
      frameH: walkArt?.frameH ?? frameH,
      root: id, // repo-relative dir under monsters/
      walkAnim,
      animations,
      strips,
      stripDims,
      aliases,
      // Art-measured shadow/anchor data (see measureWalkArt).
      artBottom: walkArt?.artBottom,
      footW: walkArt?.footW,
      bodyW: walkArt?.bodyW,
      hoverPx: HOVER_PX[id] ?? 0,
    });
  }
  return monsters;
}

const publicDir = join(GAME_ROOT, "client", "public");
mkdirSync(publicDir, { recursive: true });

const monsters = scan();
const out = {
  generatedFrom: "monsters/config/roster.json",
  directions: DIRECTIONS,
  monsters,
};
writeFileSync(join(publicDir, "monsters.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`[monsters] ${monsters.length} monsters -> client/public/monsters.json:`, monsters.map((x) => x.id).join(", ") || "(none)");
