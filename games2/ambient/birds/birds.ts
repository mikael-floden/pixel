import Phaser from "phaser";
import { AmbientCtx, AmbientFeature, PHASE_DAY, WEATHER_CLEAR } from "../runtime/types";
import { FLY_FRAMES, SheetSpec, applyFog, applyShadow, dirFromVel, flyFrame, gradeCritter, nearestFacingDir, queueSheets, sheetsReady, stepFlapDir } from "../runtime/critters";
import { birdDensity } from "../runtime/density";
// 8 hand-made PixelLab bird TYPES, each an 8-direction object with a flapping
// fly animation and a still base (for perching). Packed one folder per type.
import bird1Fly from "./art/bird1/fly.png";
import bird1Still from "./art/bird1/still.png";
import bird2Fly from "./art/bird2/fly.png";
import bird2Still from "./art/bird2/still.png";
import bird3Fly from "./art/bird3/fly.png";
import bird3Still from "./art/bird3/still.png";
import bird4Fly from "./art/bird4/fly.png";
import bird4Still from "./art/bird4/still.png";
import bird5Fly from "./art/bird5/fly.png";
import bird5Still from "./art/bird5/still.png";
import bird6Fly from "./art/bird6/fly.png";
import bird6Still from "./art/bird6/still.png";
import bird7Fly from "./art/bird7/fly.png";
import bird7Still from "./art/bird7/still.png";
import bird8Fly from "./art/bird8/fly.png";
import bird8Still from "./art/bird8/still.png";

// Birds — an EPISODE feature and the DAYTIME counterpart to bats. This is a
// TOP-DOWN world (maintainer 2026-07-18: "stop thinking as if this is a
// platformer"), so a flock is a little living SIMULATION over the ground, not a
// sprite crossing the screen:
//   • BOIDS flocking — cohesion, alignment, separation + a wander drift, so the
//     birds move together in any direction over the terrain and the shape of
//     the flock keeps changing. A flock is a small MIX of 1-3 bird TYPES and
//     each kind PREFERS ITS OWN (same-type cohesion/alignment dominate).
//   • They LAND OFTEN. A wandering flock soon settles onto the ground (never
//     onto water — checked through the surface probe), pecks around FACING ANY
//     DIRECTION for a while, then lifts off. A landed bird shows its STILL base
//     sprite; an airborne one flaps.
//   • They FLEE THE PLAYER — but only when LOW. Walk close to a landed/low flock
//     and it FLUSHES: takes off and scatters away (the "spook the pigeons"
//     beat). A HIGH cruising flock isn't scared — it drifts, and sometimes flies,
//     right over the player.
// Altitude is real (high in Z): each bird has a ground position (gx, gy — world
// px in the iso-projected space) and an altitude lifted above it; it draws at
// (gx, gy − alt). The art is the maintainer's hand-made PixelLab set — 8 bird
// TYPES, each with 8 rotations + a flap clip — rendered as a real directional
// sprite (facing derived from the boid's velocity). Drawn in the sky band,
// above the world + darkness overlay.
const DEPTH = 1_499_805;
const TYPES = 8;
const flyKey = (t: number) => `amb-bird${t}-fly`;
const stillKey = (t: number) => `amb-bird${t}-still`;
const FLY_URLS = [bird1Fly, bird2Fly, bird3Fly, bird4Fly, bird5Fly, bird6Fly, bird7Fly, bird8Fly];
const STILL_URLS = [bird1Still, bird2Still, bird3Still, bird4Still, bird5Still, bird6Still, bird7Still, bird8Still];
const SHEETS: SheetSpec[] = FLY_URLS.flatMap((url, t) => [
  { key: flyKey(t), url },
  { key: stillKey(t), url: STILL_URLS[t] },
]);
const BIRD_SCALE = 0.6; // 34px art → a small-but-readable bird in the flock
const BIRD_ALPHA = 0.95;
const DIR_STICK = 110; // ms an adjacent-sector heading flip must hold before the sprite turns

const BASE_WEIGHT = 1.0;
const NIGHT_MULT = 0.05; // ~5% as likely at night (the mirror of the bats' day cut)
const FLOCK_EVERY_MS: [number, number] = [10_000, 26_000]; // gap between flocks

// Flock simulation tuning (world px, px/s).
const FLOCK_N: [number, number] = [5, 9];
const CRUISE_ALT: [number, number] = [70, 120]; // flying altitude band
const SPD_MIN = 42;
const SPD_CRUISE = 92;
const SPD_MAX = 155;
const NEIGHBOR_R = 74; // boids neighbourhood
const SEP_R = 24; // personal space
// Two tiers of player wariness, both ALTITUDE-GATED (maintainer: birds high in
// the sky aren't scared — they fly right over you): a GENTLE avoidance keeps a
// loose distance while low, and a close approach PANICS the whole flock into a
// scatter — but only birds BELOW FEAR_ALT (landing/perched/just-off) react. A
// high cruising flock ignores the player and passes over.
const AVOID_R = 190; // gentle steer-away radius
const FLEE_R = 92; // this close → panic flush (a LOW bird only)
const FEAR_ALT = 40; // px — below this a bird is "low" and wary; above it, fearless
const W_SEP = 1.7;
const W_ALI = 0.65;
const W_COH = 0.6;
const W_WANDER = 0.35; // gentler now the facing pull adds structure (was 0.5)
const W_BOUND = 0.5; // soft pull back toward the visible area
const W_AVOID = 0.9; // gentle keep-your-distance steer (scaled down with altitude)
// Pull toward the nearest of the 8 iso FACING directions the birds have art for,
// so a cruising bird flies the way its sprite faces (maintainer 2026-07-25: "try
// their best to fly in the direction they're facing"). Strong enough to hold a
// facing heading most of the time, but wander + boids still turn them between
// directions (smooth turns, "not an absolute must").
const W_FACING = 2.0;
// Type affinity: same-type birds pull together, different types only loosely —
// a mixed flock still flocks, but each kind clusters with its own (maintainer).
const DIFF_TYPE_W = 0.3; // a different-type neighbour's weight in cohesion/alignment
const FLOCK_TYPES: [number, number] = [1, 3]; // distinct bird types per flock (kept low)
// SETTLED CALM (maintainer 2026-07-25: "birds sit for longer once they have
// landed ... in peace with their current location"): a landed flock now rests
// for a long stretch before it lifts off on its own (still flushes instantly if
// the player gets close — see the FLUSH block). They may still occasionally
// leave of their own accord ("not a hard rule"), so this is a long window, not
// forever. The loved LANDED walk/hop-around behaviour is untouched.
const LAND_REST: [number, number] = [22_000, 55_000]; // perched time before a self-initiated lift-off (was 4.5-10s)
const SETTLE_AFTER: [number, number] = [3_000, 7_000]; // wandering time before trying to land (land often)
const TAKEOFF_MS = 1400; // flush / lift-off climb duration
const FLUSH_COOLDOWN = 6000; // after a scatter, stay calm this long (no re-panic)
const FLOCK_LIFE: [number, number] = [70_000, 130_000]; // a flock LINGERS so the long calm rest plays out before it departs
const LAND_CLEAR = FLEE_R * 1.9; // only settle when the flock is this far from the player
const LAND_SCATTER = 70; // ± spread of each bird's personal perch spot around the flock centre

// ── Migratory flock (maintainer 2026-07-25) ─────────────────────────────────
// A SECOND, independent bird population managed by this SAME feature. The
// ambient Director only ever runs ONE episode at a time, so a migratory flock
// can't be its own feature — it lives here and co-runs with the ground flock.
// These birds fly HIGH and cross the sky "with determination, like migratory
// birds": they NEVER land and NEVER fear the player. Solo or in groups of
// varying size and — most important — varied FORMATIONS (V / echelon / line /
// skein / cluster). They keep the sky alive now the ground flock settles longer,
// and BOTH flocks scale with the player's density slider (runtime/density.ts).
// Cruise altitude band (2026-07-25, raised): high in the sky, clearly above the
// wandering ground flock. 190-250px ≈ 12-15.6 levels — well PAST the depth-fog's
// ~7-level (ELEV_D0) dead-zone, so the RAW haze up here is heavy (~0.4-0.6). We
// deliberately DON'T cap the altitude to dodge that; instead a migratory-only fog
// rule (MIGR_FOG_K, in updateMigration) scales the depth-fog WASH down so a bird
// crossing right over the player stays a readable silhouette while still reading
// as "way up high". The TINT (day/night + cloud + cast-shadow) is untouched.
const MIGR_ALT: [number, number] = [190, 250];
// Migratory-only: multiply the depth-fog wash by this before applyFog so high
// cruisers don't haze into the sky over the player. ~0.5 raw × 0.35 ≈ 0.17 —
// back in the comfortable range of the old 120-170 band, keeping a hint of haze.
const MIGR_FOG_K = 0.35;
const MIGR_SPD: [number, number] = [60, 84]; // steady crossing speed, one value per group
const MIGR_EVERY_MS: [number, number] = [9_000, 22_000]; // gap between group launches (÷ density)
const MIGR_SPRING = 2.6; // 1/s pull of each bird toward its formation slot (loose → alive, not rigid)
const FORM_BACK = 26; // px between formation ranks, along the reverse-heading
const FORM_SIDE = 24; // px of lateral step per rank
const MIGR_WOBBLE = 3.2; // px lateral life-wobble around the slot (small, so the shape holds)
const MIGR_CAP_BASE = 12; // baseline max concurrent migratory birds (× density, clamped)
const MIGR_CAP_MIN = 2;
const MIGR_CAP_MAX = 64; // perf guard at 10× density
const SETTLE_MAX = 20; // hard cap on a ground flock's size (density scales up to this)

const FLYING = 0;
const LANDING = 1;
const LANDED = 2;
const TAKEOFF = 3;

interface Bird {
  sprite: Phaser.GameObjects.Sprite;
  fog?: Phaser.GameObjects.Sprite; // lazily-created depth-fog wash overlay (see applyFog)
  shadow?: Phaser.GameObjects.Image; // lazily-created ground drop-shadow (see applyShadow)
  // Eased lighting state (CritterGradeState) — smooths the cliff-foot terrain jump.
  gl?: [number, number, number];
  gfa?: number;
  gfc?: [number, number, number];
  type: number; // which of the 8 bird designs
  gx: number; // GROUND position in world px (the point on the map it is over)
  gy: number;
  alt: number; // altitude px above the ground
  vx: number; // ground-plane velocity (any direction — top-down)
  vy: number;
  state: number;
  tx: number; // personal landing/target spot
  ty: number;
  cruise: number; // this bird's flying altitude
  wander: number; // wander heading (rad), random-walks
  dir: number; // current facing (PixelLab index 0..7), hysteretic
  dirHoldT: number; // ms an adjacent new heading has persisted
  flapMs: number; // ms per flap frame
  flapT: number;
  frame: number; // flap frame 0..FLY_FRAMES-1
  bobPhase: number;
  t: number;
  // Migratory-only: this bird's fixed slot in its group's formation (px, in the
  // heading frame — back = behind the lead, side = lateral). Undefined for the
  // ground flock, which steers by boids, not a formation.
  slotBack?: number;
  slotSide?: number;
}

// A migratory group flies as a rigid-ish FORMATION around a moving lead anchor.
type Formation = "solo" | "vee" | "echelon" | "line" | "skein" | "cluster";
interface MigrGroup {
  members: Bird[];
  form: Formation;
  lx: number; // lead anchor (world px) — advances straight along the heading
  ly: number;
  fx: number; // heading unit vector (determined, constant for the group's life)
  fy: number;
  spd: number; // crossing speed (px/s)
}

export function birdsFeature(): AmbientFeature {
  const birds: Bird[] = [];
  let active = false;
  let ready = false; // fly/still spritesheets loaded (runtime load, see init)
  let nextFlockIn = 3000;
  let flocks = 0;
  // Flock-level timers (ms clock in scene.time.now).
  let settleAt = 0; // when a wandering flock will try to land
  let groundUntil = 0; // when a landed flock lifts off
  let flushUntil = 0; // >now → the flock is fleeing the player
  let flushCooldownUntil = 0; // no fresh panic before this (avoids perpetual flushing)
  let leaveAt = 0; // when the current flock heads off the view for good
  let leaving = false; // flock is exiting — fly to the nearest edge and go
  let landCx = 0;
  let landCy = 0;
  let lastNow = 0; // last scene clock seen (for debug())
  // Migratory flock: any number of groups co-exist (unlike the one-at-a-time
  // ground flock), each crossing the sky in its own formation.
  const migrGroups: MigrGroup[] = [];
  let nextMigrIn = 4000; // countdown to the next group launch (while active)
  let seed = 29;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

  // Player's world position (iso-projected px) via the game's myScreen probe.
  const playerAt = (ctx: AmbientCtx): { x: number; y: number } | null => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const ms = ml?.myScreen?.() as { sx: number; sy: number; zoom: number } | null | undefined;
    if (!ms || !ms.zoom) return null;
    return { x: ctx.view.x + ms.sx / ms.zoom, y: ctx.view.y + ms.sy / ms.zoom };
  };

  // Is world point (wx, wy) a walkable DRY TOP the flock can perch on? Uses the
  // game's FACE-AWARE landableAtScreen probe: the FRONT-MOST drawn surface must
  // be a standable, non-water TOP — never a cliff FACE (a bird would cling to
  // the vertical wall) or water. The flat plane the flock flies in can't tell a
  // wall/lake from ground on its own, so every perch spot is validated here.
  // Missing probe → don't block landing (degrade gracefully).
  const isGround = (wx: number, wy: number): boolean => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const at = ml?.landableAtScreen as undefined | ((x: number, y: number) => boolean);
    return at ? at(wx, wy) === true : true;
  };

  // Show the right frame: the flap clip while airborne, the still base perched.
  const drawFrame = (b: Bird, perched: boolean, tint: number) => {
    const key = perched ? stillKey(b.type) : flyKey(b.type);
    if (b.sprite.texture.key !== key) b.sprite.setTexture(key);
    b.sprite.setFrame(perched ? b.dir : flyFrame(b.dir, b.frame)).setTint(tint);
  };

  const launchFlock = (ctx: AmbientCtx) => {
    flocks++;
    const view = ctx.view;
    // Density slider scales the flock size (clamped): 0.1× → a tiny 2-bird group,
    // 10× → up to SETTLE_MAX. Read fresh so a slider change lands on the next flock.
    const base = FLOCK_N[0] + Math.floor(rnd() * (FLOCK_N[1] - FLOCK_N[0] + 1));
    const n = Math.max(2, Math.min(SETTLE_MAX, Math.round(base * birdDensity())));
    // Enter clustered from a random edge, heading roughly into the view.
    const edge = Math.floor(rnd() * 4);
    const ex = edge === 0 ? view.x - 40 : edge === 1 ? view.right + 40 : view.x + rnd() * view.width;
    const ey = edge === 2 ? view.y - 40 : edge === 3 ? view.bottom + 40 : view.y + rnd() * view.height;
    const inx = view.centerX - ex;
    const iny = view.centerY - ey;
    const inl = Math.hypot(inx, iny) || 1;
    const dirx = inx / inl;
    const diry = iny / inl;
    const dir0 = dirFromVel(dirx, diry) ?? 0;
    // This flock's palette: 1-3 distinct types, weighted LOW (mostly one or
    // two). Birds draw their type from it, so a flock is a small mix rather
    // than all 8 kinds at once — and same-type birds cluster (see the boids loop).
    const r = rnd();
    const nTypes = r < 0.4 ? FLOCK_TYPES[0] : r < 0.75 ? 2 : FLOCK_TYPES[1];
    const palette: number[] = [];
    while (palette.length < nTypes) {
      const t = Math.floor(rnd() * TYPES);
      if (!palette.includes(t)) palette.push(t);
    }
    for (let i = 0; i < n; i++) {
      const type = palette[Math.floor(rnd() * palette.length)];
      const sprite = ctx.scene.add
        .sprite(0, 0, flyKey(type), flyFrame(dir0))
        .setDepth(DEPTH + i * 0.001)
        .setAlpha(BIRD_ALPHA)
        .setScale(BIRD_SCALE);
      birds.push({
        sprite,
        type,
        gx: ex + (rnd() - 0.5) * 40,
        gy: ey + (rnd() - 0.5) * 40,
        alt: CRUISE_ALT[0] + rnd() * (CRUISE_ALT[1] - CRUISE_ALT[0]),
        vx: dirx * SPD_CRUISE,
        vy: diry * SPD_CRUISE,
        state: FLYING,
        tx: 0,
        ty: 0,
        cruise: CRUISE_ALT[0] + rnd() * (CRUISE_ALT[1] - CRUISE_ALT[0]),
        wander: rnd() * Math.PI * 2,
        dir: dir0,
        dirHoldT: 0,
        flapMs: 15 + rnd() * 6, // per-frame; 16 frames ≈ 0.25-0.35s wingbeat (2× the first cut)
        flapT: rnd() * 200,
        frame: Math.floor(rnd() * FLY_FRAMES), // desync the flock's wingbeats
        bobPhase: rnd() * Math.PI * 2,
        t: rnd() * 5,
      });
    }
    settleAt = ctx.scene.time.now + SETTLE_AFTER[0] + rnd() * (SETTLE_AFTER[1] - SETTLE_AFTER[0]);
    groundUntil = 0;
    flushUntil = 0;
    leaveAt = ctx.scene.time.now + FLOCK_LIFE[0] + rnd() * (FLOCK_LIFE[1] - FLOCK_LIFE[0]);
    leaving = false;
  };

  const recycle = (ctx: AmbientCtx, b: Bird) => {
    // Strayed far outside the view: re-enter as a fresh wanderer at an edge.
    const view = ctx.view;
    const edge = Math.floor(rnd() * 4);
    b.gx = edge === 0 ? view.x - 30 : edge === 1 ? view.right + 30 : view.x + rnd() * view.width;
    b.gy = edge === 2 ? view.y - 30 : edge === 3 ? view.bottom + 30 : view.y + rnd() * view.height;
    const inx = view.centerX - b.gx;
    const iny = view.centerY - b.gy;
    const l = Math.hypot(inx, iny) || 1;
    b.vx = (inx / l) * SPD_CRUISE;
    b.vy = (iny / l) * SPD_CRUISE;
    b.alt = b.cruise;
    b.state = FLYING;
    b.dir = dirFromVel(b.vx, b.vy) ?? b.dir;
    b.gl = undefined; // snap the eased grade to the new spot (don't ramp across the teleport)
  };

  // ---- migratory flock --------------------------------------------------
  const migrCount = () => migrGroups.reduce((s, g) => s + g.members.length, 0);

  // One bird's fixed slot in `form`, in the heading frame (back = behind the
  // lead, side = right of the heading). Rolled ONCE at spawn (cluster consumes
  // the rnd stream deterministically), then held for the group's life.
  const formSlot = (form: Formation, i: number, n: number): { back: number; side: number } => {
    switch (form) {
      case "vee": {
        // classic V: leader at the point, wings trailing symmetrically.
        if (i === 0) return { back: 0, side: 0 };
        const rank = Math.ceil(i / 2);
        const sign = i % 2 === 1 ? -1 : 1;
        return { back: rank * FORM_BACK, side: sign * rank * FORM_SIDE };
      }
      case "echelon": // a single diagonal line, all on one side
        return { back: i * FORM_BACK, side: i * FORM_SIDE };
      case "line": // abreast, perpendicular to the heading
        return { back: 0, side: (i - (n - 1) / 2) * FORM_SIDE };
      case "skein": // a wavy single-file string (geese "skein")
        return { back: i * FORM_BACK, side: (i % 2 === 0 ? 1 : -1) * FORM_SIDE * 0.3 };
      case "cluster": {
        // a loose blob — a casual small group, not a rigid shape
        const spread = FORM_SIDE * Math.sqrt(n);
        return { back: (rnd() - 0.5) * spread, side: (rnd() - 0.5) * spread };
      }
      default: // "solo"
        return { back: 0, side: 0 };
    }
  };

  const launchMigration = (ctx: AmbientCtx) => {
    const view = ctx.view;
    const cap = Math.max(MIGR_CAP_MIN, Math.min(MIGR_CAP_MAX, Math.round(MIGR_CAP_BASE * birdDensity())));
    const room = cap - migrCount();
    if (room <= 0) return; // sky is at capacity for the current density
    // Group SIZE: mostly solo/small, occasionally a big flock (clamped to room).
    const r = rnd();
    let n = r < 0.34 ? 1 : r < 0.62 ? 2 + Math.floor(rnd() * 3) : r < 0.86 ? 5 + Math.floor(rnd() * 4) : 9 + Math.floor(rnd() * 6);
    n = Math.max(1, Math.min(n, room));
    // FORMATION by size: solo alone, small groups loose, big flocks in a shape.
    const pick = (arr: Formation[]) => arr[Math.floor(rnd() * arr.length)];
    const form: Formation =
      n === 1 ? "solo" : n <= 4 ? pick(["echelon", "line", "skein", "cluster"]) : pick(["vee", "vee", "echelon", "skein", "line"]);
    // DETERMINED heading straight across the view; the group enters from the
    // up-heading side (offscreen) and exits the far side.
    const ang = rnd() * Math.PI * 2;
    // Fly along one of the 8 iso FACING directions so the whole formation moves
    // the way its sprites face (migratory birds hold a determined straight
    // heading — snapping it to a facing direction is exact, not just preferred).
    const [fx, fy] = nearestFacingDir(Math.cos(ang), Math.sin(ang));
    const rightX = -fy; // heading rotated +90° (screen y down)
    const rightY = fx;
    const halfDiag = Math.hypot(view.width, view.height) / 2;
    const startDist = halfDiag + 90;
    const lateral = (rnd() - 0.5) * halfDiag; // spread the entry across the cross-axis
    const lx = view.centerX - fx * startDist + rightX * lateral;
    const ly = view.centerY - fy * startDist + rightY * lateral;
    const spd = MIGR_SPD[0] + rnd() * (MIGR_SPD[1] - MIGR_SPD[0]);
    const type = Math.floor(rnd() * TYPES); // one species per migrating flock
    const alt0 = MIGR_ALT[0] + rnd() * (MIGR_ALT[1] - MIGR_ALT[0]);
    const dir0 = dirFromVel(fx, fy) ?? 0;
    const group: MigrGroup = { members: [], form, lx, ly, fx, fy, spd };
    for (let i = 0; i < n; i++) {
      const slot = formSlot(form, i, n);
      const alt = alt0 + (rnd() - 0.5) * 12; // co-altitude with a little spread
      // start each bird AT its slot around the lead so the shape reads at once
      const offX = -fx * slot.back + rightX * slot.side;
      const offY = -fy * slot.back + rightY * slot.side;
      const sprite = ctx.scene.add
        .sprite(0, 0, flyKey(type), flyFrame(dir0))
        .setAlpha(BIRD_ALPHA)
        .setScale(BIRD_SCALE);
      group.members.push({
        sprite,
        type,
        gx: lx + offX,
        gy: ly + offY,
        alt,
        vx: fx * spd,
        vy: fy * spd,
        state: FLYING,
        tx: 0,
        ty: 0,
        cruise: alt,
        wander: 0,
        dir: dir0,
        dirHoldT: 0,
        flapMs: 15 + rnd() * 6,
        flapT: rnd() * 200,
        frame: Math.floor(rnd() * FLY_FRAMES),
        bobPhase: rnd() * Math.PI * 2,
        t: rnd() * 5,
        slotBack: slot.back,
        slotSide: slot.side,
      });
    }
    migrGroups.push(group);
  };

  const updateMigration = (ctx: AmbientCtx, dts: number, dtMs: number) => {
    if (!migrGroups.length) return;
    const view = ctx.view;
    const cull = Math.hypot(view.width, view.height) / 2 + 150; // exit distance past centre
    let di = 0; // running index → unique per-bird sky depths (0.001 apart, like the ground flock)
    for (let gi = migrGroups.length - 1; gi >= 0; gi--) {
      const g = migrGroups[gi];
      const rightX = -g.fy;
      const rightY = g.fx;
      // advance the formation lead in a straight line (determined migration)
      g.lx += g.fx * g.spd * dts;
      g.ly += g.fy * g.spd * dts;
      for (let mi = g.members.length - 1; mi >= 0; mi--) {
        const b = g.members[mi];
        b.t += dts;
        // small life-wobble perpendicular to the heading — enough to breathe,
        // not enough to break the formation.
        const side = (b.slotSide ?? 0) + Math.sin(b.t * 1.6 + b.bobPhase) * MIGR_WOBBLE;
        const back = b.slotBack ?? 0;
        const desiredX = g.lx - g.fx * back + rightX * side;
        const desiredY = g.ly - g.fy * back + rightY * side;
        // spring toward the slot; the migration term dominates the velocity so
        // the FACING stays locked to the heading (determined, no wandering).
        b.vx = g.fx * g.spd + (desiredX - b.gx) * MIGR_SPRING;
        b.vy = g.fy * g.spd + (desiredY - b.gy) * MIGR_SPRING;
        b.gx += b.vx * dts;
        b.gy += b.vy * dts;
        b.alt = b.cruise + Math.sin(b.t * 1.1 + b.bobPhase) * 2.4; // gentle altitude bob
        // Grade + draw exactly like the ground flock (high/far → more haze, so
        // they read as distant), but never land and never fear the player.
        const grade = gradeCritter(b, b.gx, b.gy, b.alt, dtMs);
        stepFlapDir(b, dtMs, DIR_STICK);
        if (b.sprite.texture.key !== flyKey(b.type)) b.sprite.setTexture(flyKey(b.type));
        b.sprite.setFrame(flyFrame(b.dir, b.frame)).setTint(grade.tint);
        b.sprite.setPosition(b.gx, b.gy - b.alt).setDepth(DEPTH + 1 + di * 0.001);
        di++;
        // Migratory-only: scale the depth-fog WASH down (MIGR_FOG_K) so a high
        // cruiser stays visible OVER the player instead of hazing into the sky.
        // The base sprite's setTint(grade.tint) above is UNTOUCHED, so light/shadow
        // shading is identical — only the wash opacity drops. The settling flock
        // and bats keep full fog (their own calls).
        applyFog(ctx.scene, b, { ...grade, fog: grade.fog * MIGR_FOG_K }, BIRD_ALPHA);
        applyShadow(ctx.scene, b, b.gx, b.gy, b.alt, grade.groundL, grade.topL, grade.shadowDepth);
        // Cull once the bird has CROSSED and exited on the far side (its
        // projection on the heading passes the view). A bird still flying IN has
        // a negative projection, so this never deletes an entering bird.
        const proj = (b.gx - view.centerX) * g.fx + (b.gy - view.centerY) * g.fy;
        if (proj > cull) {
          b.sprite.destroy();
          b.fog?.destroy();
          b.shadow?.destroy();
          g.members.splice(mi, 1);
        }
      }
      if (!g.members.length) migrGroups.splice(gi, 1); // whole flock has crossed
    }
  };

  return {
    name: "birds",
    preferred: { time: PHASE_DAY, weather: WEATHER_CLEAR },
    conflicts: ["bats"], // day vs night sky creatures — never both
    weight(env) {
      return BASE_WEIGHT * (NIGHT_MULT + (1 - NIGHT_MULT) * env.sun);
    },
    setActive(on) {
      active = on;
      if (on) {
        nextFlockIn = 1200 + Math.random() * 2000;
        nextMigrIn = 800 + Math.random() * 1600; // a migrating flock appears soon after birds turn on
      }
    },
    init(ctx) {
      queueSheets(ctx.scene, SHEETS); // runtime-load the PixelLab art (see critters.ts)
    },
    update(ctx, dt) {
      // The art loads asynchronously after the scene is live — idle until ready
      // (so a flock never launches without its sprites). Cheap existence poll.
      if (!ready) {
        ready = sheetsReady(ctx.scene, SHEETS);
        if (!ready) return;
      }
      const dts = Math.min(dt, 100) / 1000;
      const dtMs = Math.min(dt, 100); // for the eased per-bird grade (see gradeCritter)
      const now = ctx.scene.time.now;
      lastNow = now;

      // ---- MIGRATORY flock (independent of the ground flock) ------------
      // Launch new crossing groups while active; always advance the ones aloft
      // (they finish their crossing even after the feature deactivates). Gap and
      // capacity both scale with the density slider.
      if (active) {
        nextMigrIn -= dt;
        if (nextMigrIn <= 0) {
          launchMigration(ctx);
          nextMigrIn = (MIGR_EVERY_MS[0] + rnd() * (MIGR_EVERY_MS[1] - MIGR_EVERY_MS[0])) / birdDensity();
        }
      }
      updateMigration(ctx, dts, dtMs);

      // One GROUND flock at a time: only count down to the next once the sky is
      // clear (a departed flock destroys its birds), so birds never pile up.
      if (active && !birds.length) {
        nextFlockIn -= dt;
        if (nextFlockIn <= 0) {
          launchFlock(ctx);
          // density scales the gap too: 0.1× → flocks 10× rarer, 10× → 10× sooner
          nextFlockIn = (FLOCK_EVERY_MS[0] + rnd() * (FLOCK_EVERY_MS[1] - FLOCK_EVERY_MS[0])) / birdDensity();
        }
      }
      if (!birds.length) return;

      // Time to move on: the flock climbs and heads off the nearest edge.
      if (!leaving && now >= leaveAt) {
        leaving = true;
        groundUntil = 0;
        for (const b of birds) if (b.state !== FLYING) b.state = TAKEOFF;
      }

      const view = ctx.view;
      const player = playerAt(ctx);
      // Lighting/fog is now graded PER BIRD (each bird's own position + altitude),
      // computed at the top of the per-bird loop — see gradeCritter below.

      // ---- flock-level decisions ---------------------------------------
      // FLUSH: the player gets CLOSE to a LOW bird → the whole flock panics,
      // takes off and scatters AWAY with a real outward impulse (you spooked
      // them). A cooldown keeps them from re-panicking every frame while you
      // stand near. A high cruising flock is fearless (see below).
      if (flushUntil <= now && now >= flushCooldownUntil && player) {
        // Only a LOW bird (landed / landing / just off the ground) is close
        // enough to the ground to be spooked; a high cruising flock passing
        // overhead ignores the player entirely and flies right over.
        let spooked = false;
        for (const b of birds)
          if (b.alt < FEAR_ALT && Math.hypot(player.x - b.gx, player.y - b.gy) < FLEE_R) {
            spooked = true;
            break;
          }
        if (spooked) {
          flushUntil = now + TAKEOFF_MS;
          flushCooldownUntil = now + TAKEOFF_MS + FLUSH_COOLDOWN;
          groundUntil = 0;
          settleAt = now + SETTLE_AFTER[0] + rnd() * (SETTLE_AFTER[1] - SETTLE_AFTER[0]);
          for (const b of birds) {
            const dx = b.gx - player.x;
            const dy = b.gy - player.y;
            const d = Math.hypot(dx, dy) || 1;
            b.vx = (dx / d) * SPD_MAX; // burst away from the player
            b.vy = (dy / d) * SPD_MAX;
            if (b.state !== FLYING) b.state = TAKEOFF;
          }
        }
      }
      const flushing = flushUntil > now;

      // SETTLE: a calm flock picks a dry clearing somewhere in view, well AWAY
      // from the player, and flies over to land there. Choosing the zone far
      // from you means the descent (which starts from the flock's loose ring
      // around you, already outside FLEE_R) heads outward — it doesn't try to
      // land in your lap and flush on the spot.
      const allFlying = birds.every((b) => b.state === FLYING);
      if (!flushing && !leaving && allFlying && now >= settleAt && groundUntil === 0) {
        const px = player ? player.x : view.centerX;
        const py = player ? player.y : view.centerY;
        let found = false;
        for (let tries = 0; tries < 14 && !found; tries++) {
          const lx = view.x + 40 + rnd() * (view.width - 80);
          const ly = view.y + 40 + rnd() * (view.height - 80);
          if (Math.hypot(lx - px, ly - py) < LAND_CLEAR) continue; // too close to the player
          if (isGround(lx, ly)) {
            landCx = lx;
            landCy = ly;
            found = true;
          }
        }
        if (found) {
          for (const b of birds) {
            b.state = LANDING;
            // Each bird gets its OWN validated landable spot near the centre. The
            // flat top can be a narrow strip by a cliff edge, so a raw ±35px
            // scatter would drop birds onto the wall FACE or into the water
            // (maintainer report). Re-roll until landable; else use the (landable)
            // centre with a tiny jitter so they don't all stack on one pixel.
            let sx = landCx;
            let sy = landCy;
            let spot = false;
            for (let t = 0; t < 8 && !spot; t++) {
              const cx = landCx + (rnd() - 0.5) * LAND_SCATTER;
              const cy = landCy + (rnd() - 0.5) * LAND_SCATTER;
              if (isGround(cx, cy)) {
                sx = cx;
                sy = cy;
                spot = true;
              }
            }
            if (!spot) {
              sx = landCx + (rnd() - 0.5) * 12;
              sy = landCy + (rnd() - 0.5) * 12;
            }
            b.tx = sx;
            b.ty = sy;
          }
        } else {
          settleAt = now + 3000; // no dry clearing right here — try again shortly
        }
      }

      // LIFT-OFF: perched flock's rest elapsed → everyone takes off.
      if (groundUntil > 0 && now >= groundUntil) {
        groundUntil = 0;
        settleAt = now + SETTLE_AFTER[0] + rnd() * (SETTLE_AFTER[1] - SETTLE_AFTER[0]);
        for (const b of birds) if (b.state === LANDED || b.state === LANDING) b.state = TAKEOFF;
      }

      // Once MOST of the flock is down, start the rest clock (a straggler or
      // two can still be gliding in — they touch down during the rest, and the
      // whole flock lifts off together when it ends).
      if (groundUntil === 0 && !flushing && !leaving && birds.length) {
        const down = birds.filter((b) => b.state === LANDED).length;
        const landingPhase = birds.every((b) => b.state === LANDED || b.state === LANDING);
        if (landingPhase && down >= Math.ceil(birds.length * 0.6)) {
          groundUntil = now + LAND_REST[0] + rnd() * (LAND_REST[1] - LAND_REST[0]);
        }
      }

      // ---- per-bird motion ---------------------------------------------
      for (let i = birds.length - 1; i >= 0; i--) {
        const b = birds[i];
        b.t += dts;
        // Grade THIS bird by the world light + depth-fog at its own ground point
        // and altitude: cast shadows darken a bird in a cliff's shade, fog hazes
        // a far/high one. EASED (except when perched) so the terrain-level jump at
        // a cliff foot doesn't snap the shadow/fog. (gx,gy pre-integration here is
        // <2px stale vs the draw — negligible against the CELL_WU=32px field scale.)
        const grade = gradeCritter(b, b.gx, b.gy, b.alt, dtMs);
        const tint = grade.tint;

        if (b.state === LANDED && !flushing) {
          // Perched: sit still with the odd tiny hop, facing a RANDOM direction
          // (rolled on landing, re-rolled on a hop) — perched birds don't all
          // face the camera. Holds the still base sprite.
          b.vx *= 0.8;
          b.vy *= 0.8;
          b.gx += b.vx * dts;
          b.gy += b.vy * dts;
          if (rnd() < 0.01) {
            b.vx = (rnd() - 0.5) * 24;
            b.vy = (rnd() - 0.5) * 24;
            b.dir = Math.floor(rnd() * 8); // a little hop/turn — re-face any direction
          }
          b.alt += (0 - b.alt) * Math.min(1, dts * 8);
          drawFrame(b, true, tint);
          b.sprite.setPosition(b.gx, b.gy - b.alt).setDepth(DEPTH + i * 0.001);
          applyFog(ctx.scene, b, grade, BIRD_ALPHA);
          applyShadow(ctx.scene, b, b.gx, b.gy, b.alt, grade.groundL, grade.topL, grade.shadowDepth);
          continue;
        }

        // Steering accumulators.
        let ax = 0;
        let ay = 0;

        if (b.state === LANDING) {
          // Glide to the personal spot with ARRIVAL damping (steer toward a
          // desired velocity that shrinks to 0 at the spot) so the bird slows
          // and settles instead of orbiting; drop altitude as it closes in.
          const dx = b.tx - b.gx;
          const dy = b.ty - b.gy;
          const d = Math.hypot(dx, dy) || 0.001;
          const SLOW = 45; // start braking within this radius
          const desired = d > SLOW ? SPD_CRUISE : SPD_CRUISE * (d / SLOW);
          ax += ((dx / d) * desired - b.vx) * 4;
          ay += ((dy / d) * desired - b.vy) * 4;
          const targetAlt = Math.min(b.cruise, d * 0.35); // lower as we approach
          b.alt += (targetAlt - b.alt) * Math.min(1, dts * 4);
          if (d < 12 && b.alt < 8) {
            // Touchdown: stop dead, commit a RANDOM facing, draw the still frame
            // and CONTINUE. The continue is load-bearing — falling through to the
            // airborne integrate/clamp would re-boost the damped glide velocity to
            // SPD_MIN and stepFlapDir would snap the facing back to the glide
            // heading, defeating "perch any way" (birds don't all face the camera).
            b.state = LANDED;
            b.gx = b.tx; // snap to the VALIDATED landable spot (drop the ≤12px glide slop)
            b.gy = b.ty;
            b.alt = 0;
            b.vx = 0;
            b.vy = 0;
            b.dir = Math.floor(rnd() * 8);
            drawFrame(b, true, tint);
            b.sprite.setPosition(b.gx, b.gy - b.alt).setDepth(DEPTH + i * 0.001);
            applyFog(ctx.scene, b, grade, BIRD_ALPHA);
            applyShadow(ctx.scene, b, b.gx, b.gy, b.alt, grade.groundL, grade.topL, grade.shadowDepth);
            continue;
          }
        } else {
          // FLYING or TAKEOFF: boids + wander (+ flee, + climb on takeoff).
          let sepx = 0;
          let sepy = 0;
          let alix = 0;
          let aliy = 0;
          let cohx = 0;
          let cohy = 0;
          let nn = 0;
          let wsum = 0; // affinity-weighted neighbour count (same-type 1, other DIFF_TYPE_W)
          for (const o of birds) {
            if (o === b) continue;
            const dx = o.gx - b.gx;
            const dy = o.gy - b.gy;
            const d = Math.hypot(dx, dy);
            if (d > NEIGHBOR_R) continue;
            nn++;
            // Prefer own kind: same-type neighbours dominate cohesion + alignment
            // (each type clusters within a mixed flock); separation stays
            // universal so nobody collides regardless of type.
            const w = o.type === b.type ? 1 : DIFF_TYPE_W;
            wsum += w;
            alix += o.vx * w;
            aliy += o.vy * w;
            cohx += o.gx * w;
            cohy += o.gy * w;
            if (d < SEP_R && d > 0) {
              sepx -= dx / d;
              sepy -= dy / d;
            }
          }
          if (nn > 0) {
            ax += sepx * W_SEP * SPD_CRUISE;
            ay += sepy * W_SEP * SPD_CRUISE;
            ax += (alix / wsum - b.vx) * W_ALI; // wsum > 0 whenever nn > 0
            ay += (aliy / wsum - b.vy) * W_ALI;
            ax += (cohx / wsum - b.gx) * W_COH;
            ay += (cohy / wsum - b.gy) * W_COH;
          }
          // Wander: a slowly turning heading nudges the flock's drift.
          b.wander += (rnd() - 0.5) * 2.2 * dts * 3;
          ax += Math.cos(b.wander) * W_WANDER * SPD_CRUISE;
          ay += Math.sin(b.wander) * W_WANDER * SPD_CRUISE;
          // Prefer flying along one of the 8 iso FACING directions the birds have
          // art for (soft — wander/boids still turn them), so a cruising bird
          // moves the way its sprite faces. Steers the HEADING toward the nearest
          // facing while preserving the bird's current speed; the diagonals are
          // the shallow iso tile axes, not screen-45° (see nearestFacingDir).
          const [fdx, fdy] = nearestFacingDir(b.vx, b.vy);
          const fsp = Math.hypot(b.vx, b.vy) || SPD_CRUISE;
          ax += (fdx * fsp - b.vx) * W_FACING;
          ay += (fdy * fsp - b.vy) * W_FACING;
          if (leaving) {
            // Departing: steer OUT toward the nearest edge and go.
            const dl = b.gx - view.x;
            const dr = view.right - b.gx;
            const dtp = b.gy - view.y;
            const dbt = view.bottom - b.gy;
            const m = Math.min(dl, dr, dtp, dbt);
            if (m === dl) ax -= SPD_CRUISE;
            else if (m === dr) ax += SPD_CRUISE;
            else if (m === dtp) ay -= SPD_CRUISE;
            else ay += SPD_CRUISE;
          } else {
            // Soft boundary: stay near the visible area.
            const mx = view.width * 0.12;
            const my = view.height * 0.12;
            if (b.gx < view.x + mx) ax += (view.x + mx - b.gx) * W_BOUND;
            else if (b.gx > view.right - mx) ax += (view.right - mx - b.gx) * W_BOUND;
            if (b.gy < view.y + my) ay += (view.y + my - b.gy) * W_BOUND;
            else if (b.gy > view.bottom - my) ay += (view.bottom - my - b.gy) * W_BOUND;
          }
          // Gentle avoidance — but ONLY while low: a bird near the ground keeps
          // its distance, a high cruiser fearlessly drifts (and sometimes flies)
          // straight over the player. Scales from full at the ground to nil at
          // FEAR_ALT. The real panic-scatter is the flock-level FLUSH above.
          if (player && b.alt < FEAR_ALT) {
            const dx = b.gx - player.x;
            const dy = b.gy - player.y;
            const d = Math.hypot(dx, dy);
            if (d < AVOID_R && d > 0) {
              const altScale = 1 - b.alt / FEAR_ALT; // 1 at ground → 0 at FEAR_ALT
              const push = (1 - d / AVOID_R) * W_AVOID * SPD_CRUISE * altScale;
              ax += (dx / d) * push;
              ay += (dy / d) * push;
            }
          }
          // Airborne: ease toward this bird's cruise altitude — fast on a
          // takeoff/flush climb, gently while already cruising.
          b.alt += (b.cruise - b.alt) * Math.min(1, dts * (b.state === TAKEOFF ? 4 : 1.5));
          if (b.state === TAKEOFF && b.alt > b.cruise - 8) b.state = FLYING;
        }

        // Integrate velocity, clamp speed (birds always keep moving in air).
        b.vx += ax * dts;
        b.vy += ay * dts;
        let sp = Math.hypot(b.vx, b.vy);
        const minS = b.state === LANDING ? 0 : SPD_MIN;
        if (sp > SPD_MAX) {
          b.vx = (b.vx / sp) * SPD_MAX;
          b.vy = (b.vy / sp) * SPD_MAX;
          sp = SPD_MAX;
        } else if (sp < minS && sp > 0) {
          b.vx = (b.vx / sp) * minS;
          b.vy = (b.vy / sp) * minS;
        }
        b.gx += b.vx * dts;
        b.gy += b.vy * dts;

        // Face (hysteretic 8-way from the boid's velocity) + flap + draw
        // (a gentle bob only while airborne).
        stepFlapDir(b, dt, DIR_STICK);
        drawFrame(b, false, tint);
        const bob = b.alt > 4 ? Math.sin(b.t * 5 + b.bobPhase) * 2 : 0;
        b.sprite.setPosition(b.gx, b.gy - b.alt + bob).setDepth(DEPTH + i * 0.001);
        applyFog(ctx.scene, b, grade, BIRD_ALPHA);
        applyShadow(ctx.scene, b, b.gx, b.gy, b.alt, grade.groundL, grade.topL, grade.shadowDepth); // ground drop-shadow (no bob → the gap reads as height)

        // Off the view (plus slack)?
        const off =
          b.gx < view.x - 120 || b.gx > view.right + 120 || b.gy < view.y - 120 || b.gy > view.bottom + 120;
        if (off) {
          if (leaving) {
            // Departing flock: this bird is gone. Last one out clears the sky.
            b.sprite.destroy();
            b.fog?.destroy();
            b.shadow?.destroy();
            birds.splice(i, 1);
            continue;
          }
          // Otherwise a stray wanderer re-enters (not while fleeing — let it clear).
          if (!flushing && b.state === FLYING) recycle(ctx, b);
        }
      }
    },
    debug() {
      const flying = birds.filter((b) => b.state === FLYING || b.state === TAKEOFF).length;
      const landed = birds.filter((b) => b.state === LANDED).length;
      const landing = birds.filter((b) => b.state === LANDING).length;
      const s = birds[0];
      const migrants = migrGroups.reduce((n, g) => n + g.members.length, 0);
      return {
        active,
        ready,
        density: birdDensity(),
        inFlight: birds.length,
        flying,
        landing,
        landed,
        flocks,
        flushing: flushUntil > lastNow,
        leaving,
        // migratory flock: total birds aloft + a per-group summary (formation,
        // size, altitude) so QA can confirm the shapes.
        migrants,
        migrFlocks: migrGroups.length,
        migrGroups: migrGroups.map((g) => ({
          form: g.form,
          n: g.members.length,
          alt: Math.round(g.members[0]?.alt ?? 0),
          dir: g.members[0]?.dir ?? 0,
          type: g.members[0]?.type ?? 0,
          hx: +g.fx.toFixed(3), // snapped heading unit (one of the 8 iso facing dirs)
          hy: +g.fy.toFixed(3),
        })),
        sample: s
          ? { type: s.type, dir: s.dir, frame: s.frame, key: s.sprite.texture.key, tint: s.sprite.tintTopLeft, x: s.sprite.x, y: s.sprite.y }
          : null,
        // Per-bird snapshot for flock QA (on-demand only, like footprintsList).
        // tint = the per-bird light multiplier (shadow variation), fog = the haze
        // overlay's live alpha (0 when none) — both drive the per-bird lighting QA.
        all: birds.map((b) => ({
          type: b.type,
          dir: b.dir,
          state: b.state,
          alt: Math.round(b.alt),
          gx: Math.round(b.gx),
          gy: Math.round(b.gy),
          vx: +b.vx.toFixed(1), // velocity (for facing-alignment QA)
          vy: +b.vy.toFixed(1),
          tint: b.sprite.tintTopLeft,
          fog: b.fog?.visible ? +b.fog.alpha.toFixed(2) : 0,
          fogTint: b.fog?.visible ? b.fog.tintTopLeft : 0,
          shadow: b.shadow ? +b.shadow.displayWidth.toFixed(1) : 0,
          shadowDepth: b.shadow ? Math.round(b.shadow.depth) : 0, // vs gy: elevation-raised over occluders
          sVis: b.shadow ? b.shadow.visible : false, // shadow currently drawn? (flicker QA)
          sy: b.shadow ? Math.round(b.shadow.y) : 0, // shadow screen-y (lift applied)
        })),
      };
    },
    dispose() {
      for (const b of birds) {
        b.sprite.destroy();
        b.fog?.destroy();
        b.shadow?.destroy();
      }
      birds.length = 0;
      for (const g of migrGroups)
        for (const b of g.members) {
          b.sprite.destroy();
          b.fog?.destroy();
          b.shadow?.destroy();
        }
      migrGroups.length = 0;
    },
  };
}
