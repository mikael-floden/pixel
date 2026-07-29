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

/** Measure a monster's WALK art with a FULL pixel decode of every direction
 * strip. v2 — PER-DIRECTION ground data (maintainer 2026-07-30, round 2: the
 * pooled-p90 single anchor floated whole directions — strips differ in height
 * and margin after in-place art repairs, per-direction feet lines differ by up
 * to 9px, and ~90% of frames sit above a p90 line by construction; hop gaits
 * like the frog floated most of the cycle and PARKED on an airborne frame 0
 * when pausing — "flying monsters ... a constant theme").
 *
 * Per frame: opaque bbox (alpha > 16, rows >= 2px) + `contactW` = the widest
 * opaque run of the bottom 3 rows. A frame is a GROUND frame when contactW >=
 * max(4, 0.5 × the direction's widest contact) — planted legs are wide, tail
 * tips and toe push-offs are slivers and never define the ground.
 * Per direction:
 * - anchor = p65 of ground-frame bottoms — the common pose sits flush and a
 *   landing-squash frame briefly dips INTO the ground (invisible) instead of
 *   the whole gait floating above the shadow (very visible);
 * - f = (anchor+1)/stripH  → the client's origin-Y for THIS direction;
 * - cx = foot-centre X (median over ground frames near the anchor) / frameW →
 *   origin-X, so feet + shadow stay centred under bodies drawn off-centre in
 *   the frame (turtle east: 6px off; saber diagonals: 22px off);
 * - contact = the ground frame nearest the anchor (widest contact on ties) —
 *   the frame a PAUSED monster parks on (a frog sits; it never levitates).
 * Monster-level footW/bodyW come from CONTACT frames only (mid-air tucked
 * feet no longer deflate the shadow width). */
function measureWalkArt(stripAbsPaths, framesByDir) {
  const ground = {}; // dir -> {f, cx, contact}
  const foots = [];
  const bodies = [];
  let frameH = 0;
  let frameW = 0;
  const anchors = []; // (anchor+1)/H per dir — pooled fallback artBottom
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
    const frames = [];
    for (let f = 0; f < n; f++) {
      const xBase = f * fw;
      let top = -1;
      let bot = -1;
      const rows = new Map(); // y -> [x0, x1]
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
          rows.set(y, [x0, x1]);
        }
      }
      if (bot < 0) continue;
      let contactW = 0;
      for (let y = bot - 2; y <= bot; y++) {
        const r = rows.get(y);
        if (r) contactW = Math.max(contactW, r[1] - r[0] + 1);
      }
      // Foot band = bottom ~14% of the body: horizontal extent + widths.
      const band = Math.max(4, Math.round((bot - top) * 0.14));
      let fx0 = Infinity;
      let fx1 = -Infinity;
      const ws = [];
      for (let y = Math.max(top, bot - band); y <= bot; y++) {
        const r = rows.get(y);
        if (!r) continue;
        ws.push(r[1] - r[0] + 1);
        fx0 = Math.min(fx0, r[0]);
        fx1 = Math.max(fx1, r[1]);
      }
      ws.sort((a, b) => a - b);
      let bodyW = 0;
      for (const [x0, x1] of rows.values()) bodyW = Math.max(bodyW, x1 - x0 + 1);
      frames.push({
        f,
        bot,
        contactW,
        footCx: (fx0 + fx1 + 1) / 2,
        footW: ws[Math.floor(ws.length / 2)] ?? 0,
        bodyW,
      });
    }
    if (!frames.length) continue;
    const widest = Math.max(...frames.map((s) => s.contactW));
    const grounded = frames.filter((s) => s.contactW >= Math.max(4, widest * 0.5));
    const gb = grounded.map((s) => s.bot).sort((a, b) => a - b);
    const anchorBot = gb[Math.round(0.65 * (gb.length - 1))];
    // Contact frame: nearest the ground line; widest planted contact on ties.
    const contact = [...grounded].sort(
      (a, b) =>
        Math.abs(a.bot - anchorBot) - Math.abs(b.bot - anchorBot) || b.contactW - a.contactW,
    )[0];
    // ---- CONTACT-CENTROID anchor (maintainer round 3: "the center
    // coordinate should be between the monsters feet (between the foot
    // underside). Some monsters have 2 feets, some have 4 and some have 0").
    // In this low-top-down art the FAR feet stand HIGHER in the frame than
    // the near feet, so the lowest opaque row is just the front toe — round
    // 2 anchored there and every quadruped's shadow hugged its front feet
    // while the body floated behind (red/green screenshots). Instead, on the
    // planted contact frame: bottom-edge profile per column, contact columns
    // are those within T = max(6, 8% of frame width) of the deepest row
    // (feet plateaus; the belly arcs 15-30px higher and stays excluded),
    // grouped into runs — runs narrower than 3px are tail tips/toe slivers,
    // runs whose centre sits farther than 0.4·fw from the silhouette's
    // mass-centre column are detached effects (diablo_2's flame tendril
    // touches the frame bottom a body-width away from the rock). The anchor
    // is the kept runs' centre: x = extent midpoint, y = mean bottom row —
    // the point BETWEEN the foot undersides. Front feet render a few px
    // below it (inside the shadow ellipse), far feet a few px above: the
    // same perspective a ground tile's diamond has.
    const cf = contact.f;
    const xBase = cf * fw;
    const bottom = new Array(fw).fill(-1);
    let massSum = 0;
    let massCols = 0;
    for (let x = 0; x < fw; x++) {
      let colMass = 0;
      for (let y = 0; y < H; y++) {
        if (data[(y * W + xBase + x) * 4 + 3] > 16) {
          bottom[x] = y;
          colMass++;
        }
      }
      if (colMass > 0) {
        massSum += x * colMass;
        massCols += colMass;
      }
    }
    const maxBot = Math.max(...bottom);
    const massCx = massCols ? massSum / massCols : fw / 2;
    // Contact tolerance: the feet of a quadruped form a PARALLELOGRAM on the
    // ground plane — the far corner projects up to ~16px above the near toe
    // on a mammoth. That projected footprint depth scales with the BODY'S
    // GIRTH (bodyW), not the frame: 11% of the direction's body width keeps
    // every foot pair across the roster (mammoth sw rear-right at depth
    // 14-16 IN, its trunk tip at 20 OUT; donkey/saber ~6-7; turtle rim 0-7)
    // while bellies (depth 20-30) always stay excluded.
    const dirBodyW = Math.max(...frames.map((s) => s.bodyW));
    const T = Math.min(17, Math.max(6, Math.round(dirBodyW * 0.11)));
    // Contact runs: consecutive columns within T of the deepest row.
    const runs = [];
    let runStart = -1;
    for (let x = 0; x <= fw; x++) {
      const isContact = x < fw && bottom[x] >= 0 && maxBot - bottom[x] <= T;
      if (isContact && runStart < 0) runStart = x;
      else if (!isContact && runStart >= 0) {
        runs.push([runStart, x - 1]);
        runStart = -1;
      }
    }
    const kept = runs.filter(
      ([a, b]) => b - a + 1 >= 3 && Math.abs((a + b) / 2 - massCx) <= fw * 0.4,
    );
    let cx = fw / 2;
    let cyRow = maxBot;
    let extentW = contact.footW;
    if (kept.length) {
      const minX = kept[0][0];
      const maxX = kept[kept.length - 1][1];
      cx = (minX + maxX + 1) / 2;
      let rowSum = 0;
      let cnt = 0;
      for (const [a, b] of kept)
        for (let x = a; x <= b; x++) {
          rowSum += bottom[x];
          cnt++;
        }
      cyRow = rowSum / cnt;
      extentW = maxX - minX + 1;
    }
    ground[dir] = {
      f: +Math.min(1, (cyRow + 1) / H).toFixed(4),
      cx: +(cx / fw).toFixed(4),
      contact: cf,
      // Front-toe distance below the anchor (px): the shadow ellipse is
      // LIFTED so its south rim kisses the toe line instead of poking a
      // half-ellipse past the toes (the residual "shadow too low" look).
      sink: Math.max(0, Math.round(maxBot - cyRow)),
    };
    anchors.push((cyRow + 1) / H);
    foots.push(extentW);
    bodies.push(Math.max(...frames.map((s) => s.bodyW)));
  }
  if (!anchors.length) return null;
  anchors.sort((a, b) => a - b);
  foots.sort((a, b) => a - b);
  bodies.sort((a, b) => a - b);
  return {
    frameW,
    frameH,
    ground,
    // Pooled fallback (median of per-dir anchors) for defensive client code.
    artBottom: +anchors[Math.floor(anchors.length / 2)].toFixed(4),
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
    // The monster's PHYSICAL footprint, one formula for everything that needs
    // a size: nadir shadow (client), body radius for soft collision (server
    // separation/roam spacing + both dodges). Horizontal iso screen px ≈ 1wu
    // (screen_x = x - y), so art pixels ARE world units here.
    const artW = walkArt ? Math.max(walkArt.footW, walkArt.bodyW * 0.55) * 1.05 : 0;
    const shadowW = Math.round(Math.min(150, Math.max(12, artW || frameW * 0.54)));
    const shadowH = Math.max(6, Math.round(shadowW * 0.385));
    // Collision radius stays gameplay-sane: the shadow may span a mammoth's
    // whole four-leg footprint (~150px) but bodies can pass a bit closer
    // than shadow edges suggest — cap so comfort targets fit the habitats.
    const radius = Math.min(60, Math.round(shadowW * 0.45));

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
      // Art-measured shadow/anchor data (see measureWalkArt). `ground` is the
      // per-direction contract: {f: originY, cx: originX, contact: pause frame}.
      ground: walkArt?.ground,
      artBottom: walkArt?.artBottom,
      footW: walkArt?.footW,
      bodyW: walkArt?.bodyW,
      shadowW,
      shadowH,
      radius, // physical body radius (wu) — soft collision + dodges
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
