import Phaser from "phaser";
import { AmbientCtx, AmbientEnv, AmbientFeature } from "../runtime/types";
import { landableAt, paintPixels } from "../runtime/ground";

/* BEACH CRABS — the sideways scuttle at the water's edge.
 *
 * A crab is not a bug that wanders. It sits still, then RUNS SIDEWAYS in a
 * short hard burst along the water line, then sits still again — and when
 * something big comes near, the whole beach moves at once. Three things make
 * it read as a crab at four pixels: the burst, the stillness between bursts,
 * and the fact that the runs all share ONE AXIS.
 *
 * THE AXIS IS THE SHORELINE, and it is derived, not guessed: when a colony is
 * placed, the search that found the beach also found which way the WATER lies,
 * and the run axis is the perpendicular of that. So crabs run ALONG the water
 * rather than at it, on any coast, at any angle, with no per-map data.
 *
 * COST — the maintainer asked for this one explicitly ("make sure the game FPS
 * is not slowed down by this effect"):
 *   - Finding a beach is the only expensive thing here (it probes land AND
 *     water at several offsets), so it happens ONLY when a colony needs a home
 *     and is rate-limited by PLACE_MS on top of that. A map with no beach in
 *     view costs one bounded search a second, not one a frame.
 *   - A crab probes the ground ONCE PER DASH, when it picks where to run —
 *     never per frame.
 *   - Everything else is arithmetic on at most MAX_CRABS pooled sprites.
 *   - A frame with the gain at zero returns before all of it.
 * `__mlAmbient.cost()` reports the per-frame cost and `debug().probes` the
 * probe rate; the gate pins both.
 */

const KEY = "amb-crab";
const KEY_BIG = "amb-crab-big";
const DEPTH_BASE = 900_000.05; // just over the darkness overlay, like the other crawlers
const DEPTH_BIAS = 1e-6;
const GAIN_TAU = 1500;

const MAX_CRABS = 18;
const N_CRABS: [number, number] = [4, 18];

/* Finding the beach. A candidate is dry ground with WATER within reach; the
 * offsets are deliberately few — this is the feature's only costly call. */
const PLACE_MS = 1500; // no more than one bounded search per this, ever
const TRIES = 6; // candidate points per search
const WATER_LOOK = 3; // steps outward
const WATER_STEP = 16; // px per step (about half a cell on screen)
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7],
];

/* THE COLONY FOLLOWS THE SHORELINE, and that is why it is a POLYLINE rather
 * than an axis. A fixed span put every crab on one tile (maintainer 2026-09-07:
 * "they usually use up the entire beach"), and the obvious fix — measure along
 * a straight shore axis — barely helped, for a reason worth writing down: the
 * water direction was snapped to one of eight sample offsets, so its
 * perpendicular could be 22 degrees off the real coast, and a straight walk
 * left the sand after two steps. Measured on the_game: 78 px of "beach", about
 * one tile, which is exactly the complaint.
 *
 * So the beach is WALKED: step along the current tangent, re-estimate the water
 * direction AT EACH NEW POINT, and turn to follow it. A curving bay comes out
 * as a curve. Bounded by SHORE_STEPS each way and paid once per colony, on
 * success only — a failed hunt never reaches it. */
const SHORE_STEP = 24; // px per step of the walk
const SHORE_STEPS = 10; // each way, so up to ~480px of shoreline
const SPAN_MIN = 52; // a cove still gets a colony
const RING = 12; // directions sampled to estimate which way the water lies
const RING_R = 22; // px out

/* CRABS KEEP A MEASURED CLEARANCE FROM THE WATER.
 *
 * Every water probe in this game answers PER CELL, and a transition tile is one
 * cell whose ART is part sand and part water. So `landableAtScreen` says "you
 * may stand here" for a point the player sees as sea, and a crab standing there
 * is standing in the water (maintainer 2026-09-07: "we have a transition tile
 * and part of it is water and part of it is sand. Would be nice if they avoid
 * the water on tiles like this"). No probe can see that boundary — it is in the
 * artwork, not in the grid.
 *
 * What CAN be measured is where the water CELLS start, and a tile's wet part is
 * bounded by the tile: a diamond is 64 px across, so half of one is ~22 px along
 * any direction. Standing that far back from the first water cell clears the wet
 * half of the last dry tile whatever the transition art does. Each point of the
 * shoreline measures its own edge, so this tracks a ragged coast instead of
 * assuming a straight one — and it also makes the colony HUG the waterline at a
 * constant distance, which is where crabs actually are. */
const EDGE_STEP = 6; // px per probe when looking for the first water cell
const EDGE_MAX = 54; // and how far to look
const WATER_CLEAR = 22; // stand this far back from it: half a tile diamond
const BAND = 12; // and how much further inland than that they scatter

/* And the population follows the beach: one crab per this many px of it, so a
 * long strand is busy and a cove is not. */
const PX_PER_CRAB = 34;

const DASH_MS: [number, number] = [170, 420];
const REST_MS: [number, number] = [500, 2600];
const DASH_SPEED: [number, number] = [26, 54]; // px/s
const FLEE_SPEED = 1.9; // times faster when something big is near
const FLEE_R = 74; // px — the whole colony reacts, which is what a beach does
const TURN_CHANCE = 0.35; // a resting crab may turn before its next run

const LIFE: [number, number] = [18_000, 50_000];
const FADE_MS = 550;
const ARRIVE_SPREAD: [number, number] = [0, 1800];
const OFF_VIEW = 48; // px past the edge before the colony moves to a new beach

/* A CRAB IS RED, AND IT IS BIGGER THAN A SPIDER (maintainer 2026-09-07, and he
 * was right on both: the first cut drew a 4x2 burnt orange thing beside a 3x3
 * spider). Two reds, never paled — the ants' rule. The scale is checkable
 * rather than a matter of taste: a person in this game stands
 * CHARACTER_BODY_PX = 88 px tall, so a hand-sized crab is 88/15 or so, which is
 * where the 5-6 px shells below come from. A 3 px spider is the same
 * arithmetic at 1/29. */
const CRAB_RED = 0xc2372a; // shell red
const CRAB_DEEP = 0x8f2318; // the older, darker one

interface Crab {
  sprite: Phaser.GameObjects.Image;
  s: number; // position ALONG the shore axis, px from the colony's home
  b: number; // and off it (the band)
  dir: number; // -1 | 1 along the axis
  dashing: boolean;
  timer: number;
  spd: number;
  wait: number;
  a: number;
  base: number;
  big: boolean;
}

interface Colony {
  x: number;
  y: number; // home: a point of dry ground with water nearby
  rx: number; // the shore TANGENT at home (unit) — the walk starts along this
  ry: number;
  wx: number; // and the direction the water lies in there (unit)
  wy: number;
  span: number; // length of the walked shoreline
  // the shoreline itself, each point carrying its own distance to the water
  pts: { x: number; y: number; wx: number; wy: number; edge: number }[];
  cum: number[]; // cumulative length at each point — a crab's coordinate
  life: number;
  sandy: boolean; // the ground really is sand, not just any shore
}

/** Crabs are out in daylight and still about at dusk; the beach is empty at
 * night. Never PALE after dark — that was the ants' complaint. */
function crabGain(env: AmbientEnv): number {
  return 0.3 + 0.7 * Math.min(1, Math.max(0, env.sun));
}

export function crabsFeature(): AmbientFeature {
  const crabs: Crab[] = [];
  let colony: Colony | null = null;
  let sinceTry = 0;
  let probes = 0;
  let searches = 0;
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let seed = 7717;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const range = ([a, b]: [number, number]) => a + rnd() * (b - a);

  const ml = () => (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;

  const waterAt = (x: number, y: number): boolean => {
    const f = ml()?.waterAtScreen as undefined | ((x: number, y: number) => boolean);
    if (!f) return false;
    probes++;
    try { return !!f(x, y); } catch { return false; }
  };
  const landAt = (x: number, y: number): boolean => { probes++; return landableAt(x, y); };

  /** Is this dry ground actually SAND? Two probes, so it is asked once per
   * accepted colony and never in the search loop: `pickAt` turns a screen point
   * into a flat ground point and `surfaceAt` reads the material there (it takes
   * WORLD UNITS — handing it screen px silently reads off-grid). */
  const sandAt = (x: number, y: number): boolean => {
    const m = ml();
    const pick = m?.pickAt as undefined | ((x: number, y: number) => { x: number; y: number } | null);
    const at = m?.surfaceAt as undefined | ((x: number, y: number) => { sound?: string } | null);
    if (!pick || !at) return false;
    probes += 2;
    try {
      const p = pick(x, y);
      return !!p && at(p.x, p.y)?.sound === "sand";
    } catch {
      return false;
    }
  };

  const playerAt = (ctx: AmbientCtx): { x: number; y: number } | null => {
    const ms = ml()?.myScreen?.() as { sx: number; sy: number; zoom: number } | null | undefined;
    if (!ms || !ms.zoom) return null;
    return { x: ctx.view.x + ms.sx / ms.zoom, y: ctx.view.y + ms.sy / ms.zoom };
  };

  /** WHICH WAY IS THE WATER, smoothly. Averaging the directions that actually
   * hit water gives a gradient, where taking the first hit of eight offsets
   * gives one of eight angles — and the perpendicular of a snapped angle is a
   * shore axis up to 22 degrees off the real coast. */
  const waterDir = (x: number, y: number): { wx: number; wy: number } | null => {
    let sx = 0;
    let sy = 0;
    let hits = 0;
    for (let i = 0; i < RING; i++) {
      const a = (i / RING) * Math.PI * 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      for (let k = 1; k <= WATER_LOOK; k++) {
        if (!waterAt(x + dx * RING_R * k, y + dy * RING_R * k)) continue;
        sx += dx / k; // nearer water weighs more
        sy += dy / k;
        hits++;
        break;
      }
    }
    if (!hits) return null;
    const len = Math.hypot(sx, sy);
    if (!(len > 1e-6)) return null;
    return { wx: sx / len, wy: sy / len };
  };

  /** How far along `w` the first WATER CELL is, from this point. */
  const waterEdge = (x: number, y: number, wx: number, wy: number): number => {
    for (let d = EDGE_STEP; d <= EDGE_MAX; d += EDGE_STEP)
      if (waterAt(x + wx * d, y + wy * d)) return d;
    return EDGE_MAX;
  };

  /** WALK THE SHORE from a point, turning to follow the water as it curves.
   * Returns the points in order, each with the local direction to the water. */
  const walkShore = (
    x0: number, y0: number, tx0: number, ty0: number,
  ): { x: number; y: number; wx: number; wy: number; edge: number }[] => {
    const out: { x: number; y: number; wx: number; wy: number; edge: number }[] = [];
    let x = x0;
    let y = y0;
    let tx = tx0;
    let ty = ty0;
    for (let k = 0; k < SHORE_STEPS; k++) {
      x += tx * SHORE_STEP;
      y += ty * SHORE_STEP;
      if (!landAt(x, y)) break;
      const w = waterDir(x, y);
      if (!w) break; // the sea has left us — this is no longer a beach
      out.push({ x, y, wx: w.wx, wy: w.wy, edge: waterEdge(x, y, w.wx, w.wy) });
      // Turn to the new coast, keeping the direction of travel.
      let nx = -w.wy;
      let ny = w.wx;
      if (nx * tx + ny * ty < 0) { nx = -nx; ny = -ny; }
      tx = nx;
      ty = ny;
    }
    return out;
  };

  /** A beach in view: dry ground with water within a few steps. Returns the
   * home point, the direction the water lies in, and the shore axis. */
  const findBeach = (ctx: AmbientCtx): Colony | null => {
    searches++;
    const v = ctx.view;
    for (let t = 0; t < TRIES; t++) {
      const x = Math.round(v.x + rnd() * v.width);
      const y = Math.round(v.y + rnd() * v.height);
      if (!landAt(x, y)) continue;
      for (const [dx, dy] of DIRS) {
        for (let k = 1; k <= WATER_LOOK; k++) {
          const px = x + dx * WATER_STEP * k;
          const py = y + dy * WATER_STEP * k;
          if (!waterAt(px, py)) continue;
          // THE SHORE AXIS IS THE PERPENDICULAR OF THE WAY THE WATER LIES, so
          // the runs follow the coast whatever angle it is drawn at.
          const w0 = waterDir(x, y) ?? { wx: dx / (Math.hypot(dx, dy) || 1), wy: dy / (Math.hypot(dx, dy) || 1) };
          const rx = -w0.wy;
          const ry = w0.wx;
          // WALK IT BOTH WAYS and stitch the halves into one shoreline.
          const fwd = walkShore(x, y, rx, ry);
          const back = walkShore(x, y, -rx, -ry);
          const pts = [
            ...back.slice().reverse(),
            { x, y, wx: w0.wx, wy: w0.wy, edge: waterEdge(x, y, w0.wx, w0.wy) },
            ...fwd,
          ];
          /* SMOOTH THE MEASURED EDGES. Each point measures its own distance to
           * the water in 6px steps, so neighbouring points can disagree by a
           * whole step for no reason a player would see — and since a crab
           * stands relative to that edge, an unsmoothed run makes it jink in
           * and out as it goes. A three-point average takes the quantisation
           * out and leaves the coast's real shape (measured: 53 of 562 runs
           * left the shore tangent before this, 9%, all of it at the steps). */
          for (let k = 0; k < 2; k++) {
            const prev = pts.map((q) => q.edge);
            for (let j = 0; j < pts.length; j++) {
              const a2 = prev[Math.max(0, j - 1)];
              const b2 = prev[j];
              const c3 = prev[Math.min(prev.length - 1, j + 1)];
              pts[j].edge = (a2 + b2 * 2 + c3) / 4;
            }
          }
          // Cumulative length along it — this is the coordinate a crab runs in.
          const cum = [0];
          for (let k = 1; k < pts.length; k++)
            cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
          const span = Math.max(SPAN_MIN, cum[cum.length - 1]);
          return {
            x, y, wx: w0.wx, wy: w0.wy, rx, ry, span, pts, cum,
            life: range(LIFE), sandy: sandAt(x, y),
          };
        }
      }
    }
    return null;
  };

  /** A point `s` px along the walked shoreline, standing `b` px further inland
   * than the water's own clearance line. The shoreline is a polyline, so this is
   * a segment lookup plus a lerp — the whole reason a curving bay works.
   *
   * THE OFFSET IS MEASURED FROM THE WATER, NOT FROM THE LINE: each point knows
   * how far its own first water cell is (`edge`), so a crab stands at
   * `edge - WATER_CLEAR - b` along that direction. Where the water is right
   * there, that is negative and pushes the crab inland; where it is further off,
   * the crab moves out to meet it. Either way the clearance is constant, which
   * is both what keeps them off the wet half of a transition tile and why a
   * colony hugs the waterline the way real ones do. */
  const onShore = (col: Colony, s: number, b: number): { x: number; y: number } => {
    const { pts, cum } = col;
    if (pts.length < 2) {
      const off = -WATER_CLEAR - b;
      return { x: col.x + col.rx * s + col.wx * off, y: col.y + col.ry * s + col.wy * off };
    }
    const t = Math.max(0, Math.min(cum[cum.length - 1], s));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < t) i++;
    const seg = Math.max(1e-6, cum[i] - cum[i - 1]);
    const k = (t - cum[i - 1]) / seg;
    const a = pts[i - 1];
    const c2 = pts[i];
    const wx = a.wx + (c2.wx - a.wx) * k;
    const wy = a.wy + (c2.wy - a.wy) * k;
    const off = a.edge + (c2.edge - a.edge) * k - WATER_CLEAR - b;
    return {
      x: a.x + (c2.x - a.x) * k + wx * off,
      y: a.y + (c2.y - a.y) * k + wy * off,
    };
  };

  const rest = (c: Crab) => { c.dashing = false; c.timer = range(REST_MS); };
  const dash = (c: Crab, col: Colony, away: number) => {
    c.dashing = true;
    c.timer = range(DASH_MS);
    c.spd = range(DASH_SPEED);
    if (away !== 0) c.dir = away;
    else if (rnd() < TURN_CHANCE) c.dir = -c.dir;
    // ONE GROUND PROBE PER DASH: where this run would end. Off the sand (into
    // the sea, off a ledge) and it goes the other way instead.
    const e = onShore(col, c.s + c.dir * 22, c.b);
    if (!landAt(e.x, e.y)) c.dir = -c.dir;
  };

  const seat = (c: Crab, col: Colony, instant: boolean) => {
    c.s = rnd() * col.span;
    c.b = rnd() * BAND;
    c.dir = rnd() < 0.5 ? 1 : -1;
    c.spd = range(DASH_SPEED);
    c.big = rnd() < 0.3;
    c.base = 0.85 + rnd() * 0.15;
    c.wait = instant ? 0 : range(ARRIVE_SPREAD);
    c.a = instant ? 1 : 0;
    c.sprite.setTexture(c.big ? KEY_BIG : KEY);
    rest(c);
  };

  return {
    name: "crabs",
    init(ctx) {
      /* A WIDE SHELL WITH LEGS OUT BOTH SIDES — top-down, which is how this
       * game sees the ground. The width is the crab: a tall shape reads as a
       * beetle, and a 3 px one reads as the spider two folders over. Painted
       * WHITE — setTint MULTIPLIES, so the drawn colour is the per-frame tint.
       *
       *   . X X X .        . X X X X .
       *   X X X X X        X X X X X X
       *   X . X . X        X . X X . X
       *                    X . . . . X
       */
      paintPixels(ctx.scene, KEY, 5, 3, 0xffffff, [
        [1, 0], [2, 0], [3, 0],
        [0, 1], [1, 1], [2, 1], [3, 1], [4, 1],
        [0, 2], [2, 2], [4, 2],
      ]);
      paintPixels(ctx.scene, KEY_BIG, 6, 4, 0xffffff, [
        [1, 0], [2, 0], [3, 0], [4, 0],
        [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1],
        [0, 2], [2, 2], [3, 2], [5, 2],
        [0, 3], [5, 3],
      ]);
    },
    update(ctx, dt) {
      const target = forced ? 1 : suppressed ? 0 : crabGain(ctx.env);
      gain += (target - gain) * Math.min(1, (dt / GAIN_TAU) * 3);
      const g = gain * ctx.outdoor;
      if (g <= 0.02) {
        for (const c of crabs) if (c.sprite.visible) c.sprite.setVisible(false);
        colony = null;
        return;
      }

      // ---- the colony: find a beach, and follow the player to a new one ----
      const v = ctx.view;
      if (colony) {
        colony.life -= dt;
        const off =
          colony.x < v.x - OFF_VIEW || colony.x > v.x + v.width + OFF_VIEW ||
          colony.y < v.y - OFF_VIEW || colony.y > v.y + v.height + OFF_VIEW;
        if (colony.life <= 0 || off) colony = null;
      }
      sinceTry += dt;
      if (!colony) {
        // RATE-LIMITED: a map with no beach in view costs one bounded search a
        // second and a half, not one a frame. This is the whole FPS story.
        if (sinceTry < PLACE_MS) {
          for (const c of crabs) if (c.sprite.visible) c.sprite.setVisible(false);
          return;
        }
        sinceTry = 0;
        colony = findBeach(ctx);
        if (!colony) {
          for (const c of crabs) if (c.sprite.visible) c.sprite.setVisible(false);
          return;
        }
        const want = Math.max(
          N_CRABS[0],
          Math.min(N_CRABS[1], Math.round(colony.span / PX_PER_CRAB)),
        );
        while (crabs.length < MAX_CRABS)
          crabs.push({
            sprite: ctx.scene.add.image(0, 0, KEY).setOrigin(0.5, 0.5).setScale(1).setVisible(false),
            s: 0, b: 0, dir: 1, dashing: false, timer: 0, spd: 30, wait: 0, a: 0, base: 1, big: false,
          });
        for (let i = 0; i < crabs.length; i++) {
          seat(crabs[i], colony, false);
          if (i >= want) crabs[i].wait = Infinity; // this colony is smaller
        }
      }

      const col = colony;
      const player = playerAt(ctx);

      const secs = dt / 1000;
      const sun = Math.min(1, Math.max(0, ctx.env.sun));
      for (const c of crabs) {
        if (c.wait === Infinity) { c.sprite.setVisible(false); continue; }
        if (c.wait > 0) { c.wait -= dt; c.sprite.setVisible(false); continue; }
        c.a = Math.min(1, c.a + dt / FADE_MS);

        /* FLEEING IS LOCAL, AND THAT IS THE POINT. It used to be one distance
         * test for the whole colony, which was fine when a colony was one tile
         * — and wrong the moment it became a 480px shoreline, because then
         * standing anywhere near the beach set every crab on it running, for as
         * long as you were there. A wave of panic that travels with you is both
         * truer and better looking: the crabs at your feet bolt, the ones down
         * the strand carry on. */
        const here = onShore(col, c.s, c.b);
        const flee = player && Math.hypot(player.x - here.x, player.y - here.y) < FLEE_R
          ? ((player.x - here.x) * col.rx + (player.y - here.y) * col.ry > 0 ? -1 : 1)
          : 0;

        c.timer -= dt;
        if (c.timer <= 0) {
          if (c.dashing) rest(c);
          else dash(c, col, flee);
        } else if (flee && !c.dashing) {
          // Something is coming — nobody sits still.
          dash(c, col, flee);
        }

        if (c.dashing) {
          c.s += c.dir * c.spd * (flee ? FLEE_SPEED : 1) * secs;
          if (c.s > col.span) { c.s = col.span; c.dir = -1; }
          if (c.s < 0) { c.s = 0; c.dir = 1; }
        }

        const at = onShore(col, c.s, c.b);
        const x = at.x;
        const y = at.y;
        const iy = Math.round(y);
        c.sprite
          .setPosition(Math.round(x), iy)
          .setDepth(DEPTH_BASE + iy * DEPTH_BIAS)
          .setTint(c.big ? CRAB_DEEP : CRAB_RED)
          .setAlpha(g * c.a * c.base * (0.55 + 0.45 * sun))
          .setVisible(c.a > 0.01);
      }
    },
    setSuppressed(on) { suppressed = on; },
    setForced(on) { forced = on; },
    debug() {
      const shown = crabs.filter((c) => c.sprite.visible);
      return {
        gain: +gain.toFixed(3),
        probes, // QA: this must stay small — the beach search is the costly call
        searches,
        colony: colony
          ? {
              x: Math.round(colony.x), y: Math.round(colony.y),
              shore: [+colony.rx.toFixed(3), +colony.ry.toFixed(3)],
              toWater: [+colony.wx.toFixed(3), +colony.wy.toFixed(3)],
              span: Math.round(colony.span),
              pts: colony.pts.map((q) => [Math.round(q.x), Math.round(q.y)]),
              edges: colony.pts.map((q) => q.edge),
              sandy: colony.sandy,
              life: Math.round(colony.life),
              want: crabs.filter((c) => c.wait !== Infinity).length,
            }
          : null,
        crabs: shown.length,
        art: { small: [5, 3], big: [6, 4] }, // QA: a crab must out-measure a spider
        tint: CRAB_RED,
        dashing: shown.filter((c) => c.dashing).length,
        all: shown.map((c) => ({
          x: Math.round(c.sprite.x), y: Math.round(c.sprite.y),
          s: +c.s.toFixed(1), dir: c.dir, dashing: c.dashing, big: c.big,
          tint: c.sprite.tintTopLeft, a: +c.sprite.alpha.toFixed(3),
        })),
      };
    },
    dispose() {
      for (const c of crabs) c.sprite.destroy();
      crabs.length = 0;
      colony = null;
    },
  };
}
