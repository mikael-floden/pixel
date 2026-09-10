import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { findLake, lakeAt } from "../runtime/water";
import {
  BACK_MS,
  RING_LIFE,
  RING_RMAX,
  SPLASH_N,
  backAlpha,
  ellipsePixels,
  flickAlpha,
  ringAlpha,
  ringBirths,
  ringR,
  riseLife,
  splashAt,
} from "./rings";

/* FISH RISES — a fish comes up under a fly and the lake keeps the record.
 *
 * The whole effect is the RING. A fish at this scale is four pixels and gone
 * in a fifth of a second; what the eye actually reads, and what makes a lake
 * feel inhabited rather than painted, is the ring that spreads afterwards and
 * outlives it. So the rise is staged: a dorsal fin breaks the surface, a tail
 * flicks a beat later, and two or three rings leave the spot and widen until
 * they fade. Every so often the fish takes it hard enough to throw a few
 * specks of water.
 *
 * ELLIPSES, NOT CIRCLES — the projection squashes y by 14/32 and a circle
 * would stand up out of the lake like a hoop (rings.ts, where the geometry and
 * the timeline live so the unit test can pin them).
 *
 * LAKES AND SHALLOWS ONLY, the same split `water/` keeps: the open sea is
 * `deepwater/`'s, and a trout rising in the middle of the ocean is a different
 * animal. `runtime/water.ts` holds that test now.
 *
 * ABOVE THE DARKNESS OVERLAY, with the other water marks and under the lit
 * avatar copies, so a swimmer still reads in front of the ring. Unlike `foam/`
 * this is not animating a line the ground already paints — it is a new bright
 * mark on open water, exactly what a wavelet is, so it lives where the
 * wavelets live and grades itself by the time of day.
 *
 * DUSK AND DAWN ARE WHEN FISH RISE. The gate is a bump on the sun rather than
 * a phase name, so it peaks through both crossings and never switches on at a
 * line; heavy rain breaks up the surface and hides the rings.
 */

const NAME = "fish";
/** Just above the lake chop's wavelets (900_000.4) and under its glints. */
const DEPTH_RING = 900_000.41;
const DEPTH_FISH = 900_000.43;
const DEPTH_SPLASH = 900_000.44;
const GAIN_TAU = 1200;
const SAMPLE_MS = 300; // how often the view is re-scanned for lake
const GRID = 5; // GRID x GRID probe samples across the view
const MAX_RISES = 4;
/** Clearance a rise needs, so its widest ring never crosses onto the sand.
 *  Along x that is the ring's own reach; down the screen it is the squash of
 *  it, plus a pixel for the fin. */
const CLEAR_X = RING_RMAX + 2;
const CLEAR_Y = Math.round(RING_RMAX * (14 / 32)) + 3;
const MIN_DIST = 46; // two rises never share a patch of water
const PLACE_TRIES = 8;
/** A rise every this many ms at full likeliness, before the lake area and the
 *  time of day stretch it. */
const GAP: [number, number] = [500, 1100];
const SPLASHY = 0.3;

const RING_KEYS: string[] = [];
const RING_KEY = (r: number) => `amb-fishring${r}`;
const BACK_KEY = "amb-fishback";
const FLICK_KEY = "amb-fishflick";
const SPECK_KEY = "amb-fishspeck";
/** The ring's own colour: the pale cyan-white the lake chop's crests use, so
 *  a ring and a wavelet are visibly the same water. */
const RING_TINT = 0xcdeef2;
/** A fish seen from above is a dark shape, never pale — the ants' rule. */
const FISH_DARK = 0x27383f;

interface Rise {
  x: number;
  y: number;
  age: number;
  life: number;
  splashy: boolean;
  births: readonly number[];
  rings: (Phaser.GameObjects.Image | null)[];
  back: Phaser.GameObjects.Image | null;
  flick: Phaser.GameObjects.Image | null;
  specks: (Phaser.GameObjects.Image | null)[];
  /** Peak drawn alpha this frame — the indoor gate reads it. */
  a: number;
}

export function fishFeature(): AmbientFeature {
  const rises: Rise[] = [];
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let sampleAge = SAMPLE_MS;
  let lakeFrac = 0;
  let nextIn = 400;
  let seed = 20260910;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  let scene: Phaser.Scene | null = null;
  const stats = { spawned: 0, rejected: 0 };

  /* ---- art ---------------------------------------------------------------- */

  const paint = (
    s: Phaser.Scene,
    key: string,
    w: number,
    h: number,
    colour: number,
    px: ReadonlyArray<readonly [number, number]>,
  ) => {
    if (s.textures.exists(key)) return;
    const g = s.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(colour, 1);
    for (const [x, y] of px) g.fillRect(x, y, 1, 1);
    g.generateTexture(key, w, h);
    g.destroy();
  };

  const ensureTextures = (s: Phaser.Scene) => {
    if (s.textures.exists(RING_KEY(RING_RMAX))) return;
    RING_KEYS.length = 0;
    for (let r = 2; r <= RING_RMAX; r++) {
      const { ry, px } = ellipsePixels(r);
      const key = RING_KEY(r);
      RING_KEYS.push(key);
      // painted WHITE and tinted at draw time, so one set of art serves any
      // water colour the palette ever moves to
      paint(s, key, 2 * r + 1, 2 * ry + 1, 0xffffff, px.map(([x, y]) => [x + r, y + ry] as const));
    }
    // the dorsal fin: a small triangle, the one fish shape that reads at 6 px
    paint(s, BACK_KEY, 6, 3, FISH_DARK, [[3, 0], [2, 1], [3, 1], [1, 2], [2, 2], [3, 2], [4, 2]]);
    // and the tail, a fork
    paint(s, FLICK_KEY, 3, 3, FISH_DARK, [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]]);
    paint(s, SPECK_KEY, 1, 1, 0xffffff, [[0, 0]]);
  };

  const img = (key: string, depth: number): Phaser.GameObjects.Image | null => {
    if (!scene) return null;
    return scene.add.image(0, 0, key).setDepth(depth).setScale(1).setVisible(false);
  };

  /* ---- placement ---------------------------------------------------------- */

  const tooClose = (x: number, y: number): boolean => {
    for (const o of rises) if (Math.abs(o.x - x) < MIN_DIST && Math.abs(o.y - y) * 2.3 < MIN_DIST) return true;
    return false;
  };

  const spawn = (view: Phaser.Geom.Rectangle) => {
    if (rises.length >= MAX_RISES) return;
    for (let t = 0; t < PLACE_TRIES; t++) {
      const p = findLake(view, rnd, CLEAR_X, 3, CLEAR_Y);
      if (!p) {
        stats.rejected++;
        return;
      }
      if (tooClose(p.x, p.y)) continue;
      const splashy = rnd() < SPLASHY;
      const births = ringBirths(splashy);
      rises.push({
        x: p.x,
        y: p.y,
        age: 0,
        life: riseLife(splashy),
        splashy,
        births,
        rings: births.map(() => null),
        back: null,
        flick: null,
        specks: splashy ? Array.from({ length: SPLASH_N }, () => null) : [],
        a: 0,
      });
      stats.spawned++;
      return;
    }
    stats.rejected++;
  };

  const retire = (r: Rise) => {
    for (const s of r.rings) s?.destroy();
    r.back?.destroy();
    r.flick?.destroy();
    for (const s of r.specks) s?.destroy();
  };

  /* ---- likeliness ---------------------------------------------------------- */

  /** Fish rise hardest at the two crossings. A bump on the sun rather than a
   *  phase name, so it peaks through dawn AND dusk and never steps at a line;
   *  never zero (a rise at noon is normal), and heavy rain hides the rings. */
  const weight = (env: { sun: number; rain: number }): number =>
    (0.35 + 0.2 * env.sun + 0.5 * Math.exp(-(((env.sun - 0.35) / 0.28) ** 2))) * (1 - 0.6 * Math.min(1, env.rain));

  return {
    name: NAME,
    init(ctx) {
      scene = ctx.scene;
      ensureTextures(ctx.scene);
    },
    update(ctx, dt) {
      const dtc = Math.min(dt, 100);
      const view = ctx.view;
      sampleAge += dt;
      if (sampleAge >= SAMPLE_MS) {
        sampleAge = 0;
        let n = 0;
        for (let i = 0; i < GRID; i++)
          for (let j = 0; j < GRID; j++)
            if (lakeAt(view.x + ((i + 0.5) / GRID) * view.width, view.y + ((j + 0.5) / GRID) * view.height)) n++;
        lakeFrac = n / (GRID * GRID);
      }

      const w = weight(ctx.env);
      const target = forced ? 1 : suppressed ? 0 : lakeFrac > 0 ? 1 : 0;
      gain += (target - gain) * Math.min(1, (dtc / GAIN_TAU) * 3);
      const g = gain * ctx.outdoor;
      if (g < 0.01 && !rises.length) return;

      // a new rise now and then, rarer on a small pond and off the peak hours
      if (g > 0.05 && lakeFrac > 0) {
        nextIn -= dtc * (forced ? 1 : w) * Math.max(0.15, Math.min(1, lakeFrac * 2));
        if (nextIn <= 0) {
          nextIn = GAP[0] + rnd() * (GAP[1] - GAP[0]);
          spawn(view);
        }
      }

      const sunK = 0.55 + 0.45 * ctx.env.sun; // a white ring at midnight is not white
      for (let i = rises.length - 1; i >= 0; i--) {
        const r = rises[i];
        r.age += dtc;
        r.a = 0;
        if (r.age >= r.life || g < 0.01) {
          retire(r);
          rises.splice(i, 1);
          continue;
        }
        // the rings
        for (let k = 0; k < r.births.length; k++) {
          const age = r.age - r.births[k];
          const a = ringAlpha(age, k) * g * sunK;
          let sp = r.rings[k];
          if (a <= 0.01) {
            sp?.setVisible(false);
            continue;
          }
          if (!sp) {
            sp = img(RING_KEY(ringR(age, k)), DEPTH_RING + k * 1e-6);
            if (!sp) continue;
            sp.setTint(RING_TINT);
            r.rings[k] = sp;
          }
          sp.setTexture(RING_KEY(ringR(age, k))).setPosition(r.x, r.y).setAlpha(a).setVisible(true);
          if (a > r.a) r.a = a;
        }
        // the fin, then the tail
        const ba = backAlpha(r.age) * g;
        if (ba > 0.01) {
          if (!r.back) r.back = img(BACK_KEY, DEPTH_FISH);
          r.back?.setPosition(r.x, r.y - 2).setAlpha(ba).setVisible(true);
          if (ba > r.a) r.a = ba;
        } else r.back?.setVisible(false);
        const fa = flickAlpha(r.age) * g;
        if (fa > 0.01) {
          if (!r.flick) r.flick = img(FLICK_KEY, DEPTH_FISH);
          r.flick?.setPosition(r.x - 5, r.y - 1).setAlpha(fa).setVisible(true);
          if (fa > r.a) r.a = fa;
        } else r.flick?.setVisible(false);
        // and the splash
        for (let k = 0; k < r.specks.length; k++) {
          const s = splashAt(k, r.age);
          const a = s.alive ? g * 0.9 : 0;
          if (a <= 0.01) {
            r.specks[k]?.setVisible(false);
            continue;
          }
          if (!r.specks[k]) r.specks[k] = img(SPECK_KEY, DEPTH_SPLASH);
          r.specks[k]?.setPosition(r.x + s.dx, r.y + s.dy).setAlpha(a).setVisible(true);
          if (a > r.a) r.a = a;
        }
      }
    },
    setSuppressed(on) {
      suppressed = on;
    },
    setForced(on) {
      forced = on;
    },
    debug() {
      return {
        gain,
        suppressed,
        forced,
        lakeFrac,
        weight: +weight({ sun: 1, rain: 0 }).toFixed(3),
        nextIn: Math.round(nextIn),
        rises: rises.length,
        ringLife: RING_LIFE,
        backMs: BACK_MS,
        ...stats,
        all: rises.map((r) => ({
          x: r.x,
          y: r.y,
          age: Math.round(r.age),
          splashy: r.splashy,
          a: +r.a.toFixed(3),
          rings: r.rings.map((sp, k) => ({
            r: ringR(r.age - r.births[k], k),
            a: +(sp && sp.visible ? sp.alpha : 0).toFixed(3),
          })),
        })),
      };
    },
    dispose() {
      for (const r of rises) retire(r);
      rises.length = 0;
      scene = null;
    },
  };
}
