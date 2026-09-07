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
const KEY_SMALL = "amb-crab-small";
const DEPTH_BASE = 900_000.05; // just over the darkness overlay, like the other crawlers
const DEPTH_BIAS = 1e-6;
const GAIN_TAU = 1500;

const MAX_CRABS = 9;
const N_CRABS: [number, number] = [4, 9];

/* Finding the beach. A candidate is dry ground with WATER within reach; the
 * offsets are deliberately few — this is the feature's only costly call. */
const PLACE_MS = 1500; // no more than one bounded search per this, ever
const TRIES = 6; // candidate points per search
const WATER_LOOK = 3; // steps outward
const WATER_STEP = 16; // px per step (about half a cell on screen)
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7],
];

const SPAN: [number, number] = [34, 78]; // how far along the shore a colony spreads
const BAND = 9; // and how far off the water line a crab strays

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

const CRAB_SHELL = 0xb4602f; // wet-sand orange; never paled (the ants' rule)
const CRAB_PALE = 0xd8b48a; // the odd ghost-pale one

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
  pale: boolean;
}

interface Colony {
  x: number;
  y: number; // home: a point of dry ground with water nearby
  rx: number; // the SHORE axis (unit, screen px) — runs are along this
  ry: number;
  wx: number; // and the direction the water lies in (unit)
  wy: number;
  span: number;
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
          const len = Math.hypot(dx, dy) || 1;
          const wx = dx / len;
          const wy = dy / len;
          return {
            x, y, wx, wy, rx: -wy, ry: wx,
            span: range(SPAN), life: range(LIFE), sandy: sandAt(x, y),
          };
        }
      }
    }
    return null;
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
    const ex = col.x + col.rx * (c.s + c.dir * 22) + col.wx * c.b;
    const ey = col.y + col.ry * (c.s + c.dir * 22) + col.wy * c.b;
    if (!landAt(ex, ey)) c.dir = -c.dir;
  };

  const seat = (c: Crab, col: Colony, instant: boolean) => {
    c.s = (rnd() - 0.5) * col.span;
    c.b = (rnd() - 0.5) * BAND;
    c.dir = rnd() < 0.5 ? 1 : -1;
    c.spd = range(DASH_SPEED);
    c.pale = rnd() < 0.22;
    c.base = 0.85 + rnd() * 0.15;
    c.wait = instant ? 0 : range(ARRIVE_SPREAD);
    c.a = instant ? 1 : 0;
    c.sprite.setTexture(c.pale ? KEY_SMALL : KEY);
    rest(c);
  };

  return {
    name: "crabs",
    init(ctx) {
      // Four pixels: a body and two claws out to the sides. Painted WHITE —
      // setTint MULTIPLIES, so the drawn colour is the per-frame tint.
      paintPixels(ctx.scene, KEY, 4, 2, 0xffffff, [[1, 0], [2, 0], [0, 1], [3, 1]]);
      paintPixels(ctx.scene, KEY_SMALL, 3, 2, 0xffffff, [[1, 0], [0, 1], [2, 1]]);
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
        const want = Math.round(range(N_CRABS));
        while (crabs.length < MAX_CRABS)
          crabs.push({
            sprite: ctx.scene.add.image(0, 0, KEY).setOrigin(0.5, 0.5).setScale(1).setVisible(false),
            s: 0, b: 0, dir: 1, dashing: false, timer: 0, spd: 30, wait: 0, a: 0, base: 1, pale: false,
          });
        for (let i = 0; i < crabs.length; i++) {
          seat(crabs[i], colony, false);
          if (i >= want) crabs[i].wait = Infinity; // this colony is smaller
        }
      }

      const col = colony;
      const player = playerAt(ctx);
      // THE WHOLE BEACH REACTS AT ONCE. One distance test for the colony, not
      // one per crab: what makes it read is that they all go together.
      let flee = 0;
      if (player) {
        const d = Math.hypot(player.x - col.x, player.y - col.y);
        if (d < FLEE_R + col.span * 0.5) {
          // Which way is away, along the shore axis?
          const along = (player.x - col.x) * col.rx + (player.y - col.y) * col.ry;
          flee = along > 0 ? -1 : 1;
        }
      }

      const secs = dt / 1000;
      const sun = Math.min(1, Math.max(0, ctx.env.sun));
      for (const c of crabs) {
        if (c.wait === Infinity) { c.sprite.setVisible(false); continue; }
        if (c.wait > 0) { c.wait -= dt; c.sprite.setVisible(false); continue; }
        c.a = Math.min(1, c.a + dt / FADE_MS);

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
          const half = col.span * 0.5;
          if (c.s > half) { c.s = half; c.dir = -1; }
          if (c.s < -half) { c.s = -half; c.dir = 1; }
        }

        const x = col.x + col.rx * c.s + col.wx * c.b;
        const y = col.y + col.ry * c.s + col.wy * c.b;
        const iy = Math.round(y);
        c.sprite
          .setPosition(Math.round(x), iy)
          .setDepth(DEPTH_BASE + iy * DEPTH_BIAS)
          .setTint(c.pale ? CRAB_PALE : CRAB_SHELL)
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
              span: Math.round(colony.span), sandy: colony.sandy, life: Math.round(colony.life),
            }
          : null,
        crabs: shown.length,
        dashing: shown.filter((c) => c.dashing).length,
        all: shown.map((c) => ({
          x: Math.round(c.sprite.x), y: Math.round(c.sprite.y),
          s: +c.s.toFixed(1), dir: c.dir, dashing: c.dashing, a: +c.sprite.alpha.toFixed(3),
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
