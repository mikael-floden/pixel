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
  const ground = {}; // dir -> {f, cx, contact, sink, shift[], air[]}
  const foots = [];
  const bodies = [];
  const figHs = []; // figure heights — tall lean-ers get a tighter shadow
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
      const colMass = new Array(fw).fill(0); // opaque px per column (drift tracking)
      for (let y = 0; y < H; y++) {
        let cnt = 0;
        let x0 = -1;
        let x1 = -1;
        for (let x = 0; x < fw; x++) {
          if (data[(y * W + xBase + x) * 4 + 3] > 16) {
            cnt++;
            colMass[x]++;
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
      // Bottom-edge profile of THIS frame (per column, its lowest opaque
      // row) — per-frame contact anchoring reads it.
      const bottoms = new Array(fw).fill(-1);
      for (let x = 0; x < fw; x++) {
        for (let y = H - 1; y >= 0; y--) {
          if (data[(y * W + xBase + x) * 4 + 3] > 16) {
            bottoms[x] = y;
            break;
          }
        }
      }
      frames.push({
        f,
        bot,
        top,
        contactW,
        footCx: (fx0 + fx1 + 1) / 2,
        footW: ws[Math.floor(ws.length / 2)] ?? 0,
        bodyW,
        colMass,
        bottoms,
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
    // Contact tolerance: the feet of a quadruped form a PARALLELOGRAM on the
    // ground plane — the far corner projects up to ~16px above the near toe
    // on a mammoth. That projected footprint depth scales with the BODY'S
    // GIRTH (bodyW), not the frame: 11% of the direction's body width keeps
    // every foot pair across the roster (mammoth sw rear-right at depth
    // 14-16 IN, its trunk tip at 20 OUT; donkey/saber ~6-7; turtle rim 0-7)
    // while bellies (depth 20-30) always stay excluded.
    const dirBodyW = Math.max(...frames.map((s) => s.bodyW));
    const T = Math.min(17, Math.max(6, Math.round(dirBodyW * 0.11)));
    /** Contact analysis of ONE frame's bottom profile: kept contact runs
     * (width >= 3, within 0.4·fw of the frame's silhouette mass-centre —
     * detached flame tendrils dropped), anchor x = extent midpoint blended
     * 50% toward the mass centre (capped 12% fw), y = mean bottom row of
     * contact columns; plus the band's top row and extent for the ellipse. */
    const analyze = (fr) => {
      const bottoms = fr.bottoms;
      let mBot = -1;
      for (let x = 0; x < fw; x++) if (bottoms[x] > mBot) mBot = bottoms[x];
      let mSum = 0;
      let mTot = 0;
      for (let x = 0; x < fw; x++) {
        mSum += x * fr.colMass[x];
        mTot += fr.colMass[x];
      }
      const mCx = mTot ? mSum / mTot : fw / 2;
      const runs = [];
      let rs = -1;
      for (let x = 0; x <= fw; x++) {
        const isC = x < fw && bottoms[x] >= 0 && mBot - bottoms[x] <= T;
        if (isC && rs < 0) rs = x;
        else if (!isC && rs >= 0) {
          runs.push([rs, x - 1]);
          rs = -1;
        }
      }
      const kept = runs.filter(
        ([a, b]) => b - a + 1 >= 3 && Math.abs((a + b) / 2 - mCx) <= fw * 0.4,
      );
      // No ground contact (airborne frame): the mass centre is still valid
      // and is what compact-base per-frame tracking needs.
      if (!kept.length) return { noContact: true, massCx: mCx };
      const minX = kept[0][0];
      const maxX = kept[kept.length - 1][1];
      let rowSum = 0;
      let cnt = 0;
      let topRow = Infinity;
      for (const [a, b] of kept)
        for (let x = a; x <= b; x++) {
          rowSum += bottoms[x];
          topRow = Math.min(topRow, bottoms[x]);
          cnt++;
        }
      let cx = (minX + maxX + 1) / 2;
      cx += Math.max(-fw * 0.12, Math.min(fw * 0.12, 0.5 * (mCx - cx)));
      return {
        cx,
        cyRow: rowSum / cnt,
        topRow,
        extent: maxX - minX + 1,
        maxBot: mBot,
        massCx: mCx,
      };
    };

    if (!contact) continue; // no grounded frame in this strip (wispy art)
    const A = analyze(contact);
    if (!A || A.noContact) continue; // no measurable contact at all — skip this dir
    // COMPACT-BASE override (maintainer round 6, via the wiki: the leaning
    // demon stone's ground contact is its bottom TIP, right of its mass — a
    // nadir shadow is the projection of the OVERHANGING BODY, not the touch
    // point, and the wiki's frame-centred X nailed it because PixelLab art
    // keeps the subject's mass frame-centred). When the contact extent is
    // small relative to the body (< half its width), anchor X = the
    // silhouette mass centre outright; wide stances (golems) and leg spans
    // (donkeys, quadrupeds) keep the contact-based blend that beats the
    // wiki on off-centre-drawn bodies.
    const compactBase = A.extent < 0.5 * dirBodyW;
    if (compactBase) A.cx = A.massCx;
    // PER-FRAME drift compensation, FEET-BASED (maintainer round 5: mass
    // tracking chased a stretching cat's head — the planted FEET are what
    // must pin; "movement should be handled in the game and not in the
    // animation" and a strip-rewrite "can easily destroy the animation", so
    // the art is never touched). Per frame: its own contact anchor vs the
    // planted frame's, 3px gait dead-band (in-place cycles get NO
    // compensation), clamp ±12% fw; airborne frames (no contact runs) fall
    // back to the silhouette mass delta. `air` = px the frame's deepest
    // point rose vs the planted frame (2px deadband, cap 24) → the shared
    // hop shadow-shrink: the demon stone's levitation phase and the frog's
    // leap read as intentionally airborne.
    const shift = [];
    const air = [];
    for (let f = 0; f < n; f++) {
      const fr = frames.find((s) => s.f === f);
      if (!fr) {
        shift.push(+(A.cx / fw).toFixed(4));
        air.push(0);
        continue;
      }
      const a = analyze(fr);
      // Compact-base bodies track their MASS per frame (the stomping tip's
      // contact clusters jump around); everyone else tracks their feet.
      let dx = compactBase
        ? (a?.massCx ?? A.massCx) - A.massCx
        : a && !a.noContact
          ? a.cx - A.cx
          : fr.footCx - contact.footCx;
      if (Math.abs(dx) <= 3) dx = 0; // gait wiggle — leave the animation alone
      dx = Math.max(-fw * 0.12, Math.min(fw * 0.12, dx));
      shift.push(+((A.cx + dx) / fw).toFixed(4));
      air.push(Math.min(24, Math.max(0, contact.bot - fr.bot - 2)));
    }
    const figH = Math.max(...frames.map((s) => s.bot - s.top + 1));
    ground[dir] = {
      f: +Math.min(1, (A.cyRow + 1) / H).toFixed(4),
      cx: +(A.cx / fw).toFixed(4),
      contact: contact.f,
      // Front-toe distance below the anchor (px): the shadow ellipse lifts
      // so its south rim kisses the toe line — but never above the contact
      // band (`up` px): a monolith's compact base keeps its ellipse CENTRED
      // on the base instead of floating half-a-height above it (round 5:
      // "the big demon stone is flying ... return underneath the monster").
      sink: Math.max(0, Math.round(A.maxBot - A.cyRow)),
      up: Math.max(0, Math.round(A.cyRow - A.topRow)),
      // filled by the class pass below (per-dir ellipse size needs the
      // MONSTER-level body class — the widest facing — first)
      w: 0,
      h: 0,
      _extent: A.extent,
      _bodyW: dirBodyW,
      shift,
      air,
    };
    anchors.push((A.cyRow + 1) / H);
    foots.push(A.extent);
    bodies.push(dirBodyW);
    figHs.push(figH);
  }
  // Per-DIRECTION shadow ellipse size (maintainer round 5: an east mammoth's
  // footprint spans ~140px, its south-facing one ~90 — one size can't fit
  // both, and the long low bodies kept getting green "enlarge" circles).
  // The body CLASS is a property of the MONSTER (its widest facing shows the
  // true length), NOT of the camera angle — classifying per view made a
  // south-facing mammoth "tall" and shrank its shadow to 54px:
  // - LONG (max body width >= 1.1 × median figure height — cats, turtles,
  //   salamanders, mammoths): side views cast ~80% of their LENGTH, narrow
  //   front/back views ~90% of their GIRTH (the whole visible width is
  //   footprint there);
  // - TALL (median figure height > max body width — monoliths, upright
  //   golems, donkeys): compact base, 40% + the measured contact extent;
  // - else 55% (porings, frogs, small critters).
  {
    const figMedian = figHs.length ? [...figHs].sort((a, b) => a - b)[Math.floor(figHs.length / 2)] : 0;
    const maxBodyW = bodies.length ? Math.max(...bodies) : 0;
    const cls = maxBodyW >= 1.1 * figMedian ? "long" : figMedian > maxBodyW ? "tall" : "normal";
    for (const g of Object.values(ground)) {
      const factor =
        cls === "long" ? (g._bodyW >= 0.75 * maxBodyW ? 0.8 : 0.9) : cls === "tall" ? 0.45 : 0.55;
      g.w = Math.round(Math.min(150, Math.max(12, Math.max(g._extent, g._bodyW * factor) * 1.05)));
      g.h = Math.max(6, Math.round(g.w * 0.385));
      delete g._extent;
      delete g._bodyW;
    }
  }
  if (!anchors.length) return null;
  anchors.sort((a, b) => a - b);
  foots.sort((a, b) => a - b);
  bodies.sort((a, b) => a - b);
  figHs.sort((a, b) => a - b);
  return {
    frameW,
    frameH,
    ground,
    // Pooled fallback (median of per-dir anchors) for defensive client code.
    artBottom: +anchors[Math.floor(anchors.length / 2)].toFixed(4),
    footW: foots[Math.floor(foots.length / 2)] ?? 0,
    bodyW: bodies[Math.floor(bodies.length / 2)] ?? 0,
    figH: figHs[Math.floor(figHs.length / 2)] ?? 0,
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
    // IDLE state (maintainer 2026-07-30: "the idle animation doesn't play
    // when stopped"): resolve through the same animation_map contract and
    // measure ITS ground the same way — idle strips are framed/sized
    // independently of walk (stripDims differ), so a stopped monster needs
    // idle's own per-dir anchors/shadow, not walk's. Monsters whose art has
    // no idle (the legacy poring family) emit null and keep parking on the
    // walk contact frame.
    let idleAnim = mapped?.idle ?? "idle";
    if (!animations[idleAnim]) idleAnim = null;
    const idleArt =
      idleAnim && idleAnim !== walkAnim
        ? measureWalkArt(stripAbs[idleAnim] ?? {}, animations[idleAnim])
        : null;
    // The monster's PHYSICAL footprint, one formula for everything that needs
    // a size: nadir shadow (client), body radius for soft collision (server
    // separation/roam spacing + both dodges). Horizontal iso screen px ≈ 1wu
    // (screen_x = x - y), so art pixels ARE world units here.
    // TALL lean-ers (figure taller than wide: monoliths, upright golems)
    // ground through a compact base, not their silhouette — a mass-scaled
    // shadow read oversized and "flying" on the leaning demon stone.
    const bodyFactor = walkArt && walkArt.figH > walkArt.bodyW ? 0.4 : 0.55;
    const artW = walkArt ? Math.max(walkArt.footW, walkArt.bodyW * bodyFactor) * 1.05 : 0;
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
      idleAnim,
      animations,
      strips,
      stripDims,
      aliases,
      // Art-measured shadow/anchor data (see measureWalkArt). `ground` is the
      // per-direction contract: {f: originY, cx: originX, contact: pause frame}.
      ground: walkArt?.ground,
      // The IDLE state's own per-direction ground contract (its strips are
      // framed independently of walk). null → no idle art; the client parks
      // on the walk contact frame instead.
      groundIdle: idleArt?.ground ?? null,
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
