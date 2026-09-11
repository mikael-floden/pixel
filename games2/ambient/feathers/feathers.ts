import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { FlushEvent, hasFlushSource, onFlush } from "../runtime/flush";
import { findGround, landableAt } from "../runtime/ground";
import {
  FADE_MS,
  LIFT_PX,
  MAX_ALT,
  REST_MS,
  SWING_AMP,
  SWING_MS,
  Tilt,
  featherAlpha,
  featherAt,
  featherLife,
} from "./fall";

/* FEATHERS AFTER A FLUSH — the evidence a flock leaves behind.
 *
 * Walk up on a landed flock and it panics off the ground (`birds/`, the
 * flush). This is what it drops: a feather or two turning over in the air
 * where each bird was standing, sinking slowly, swinging side to side, and
 * then lying on the ground for a few seconds before it goes.
 *
 * THE SIGNAL COMES THROUGH `runtime/flush.ts`, not through an import: the
 * flock is the only thing that knows it panicked, features may not import
 * each other, and the flock must run identically whether or not this feature
 * is in the registry. `birds/` emits one event per bird that actually left
 * the ground and neither end knows the other exists.
 *
 * WHY IT READS AS A FEATHER at four pixels is the swing, not the shape. It
 * does not drop, it slides left and right as it sinks, and it LEANS into each
 * slide and flips at the turn. Both come from one sine in fall.ts — the tilt
 * is the swing's derivative — so the lean and the motion can never disagree.
 * Three drawn tilt frames, never a rotation: a rotated 4-px sprite resamples
 * into mush.
 *
 * DEPTH: the crawlers' band just above the darkness overlay, for the whole
 * fall and the rest. A feather is two pale pixels and the ants learned what
 * happens to those under the overlay at night (measured at ONE luma of
 * contrast against the ground). It grades itself by the sun instead. The cost
 * is that a feather falling past a tree is drawn over it, which is the same
 * trade every crawler here makes and is invisible at this size.
 *
 * NOTHING SHEDS WITHOUT A FLUSH, which makes this the one feature that shows
 * nothing when it is selected ALONE in Settings — no birds, no panic. So when
 * it is FORCED and no flush has come for a while it sheds a demo feather over
 * dry ground nearby, and only then.
 */

const NAME = "feathers";
/** Just over the darkness overlay, with the other small pale marks; a hair
 *  above the ants so a feather lies on top of a trail rather than under it. */
const DEPTH = 900_000.07;
const DEPTH_BIAS = 1e-6;
const GAIN_TAU = 700;
const MAX_FEATHERS = 16;
/** Per bird that flushes: always one, sometimes a second. */
const SECOND_FEATHER = 0.35;
/** How far from the bird's own spot a feather starts, px. */
const SPREAD = 3;
/** Demo-only (see the header): a shed every this often while FORCED and
 *  nothing has flushed. */
const DEMO_GAP = 1600;
const DEMO_QUIET = 2500;

const KEY_TILT = ["amb-feather-l", "amb-feather-f", "amb-feather-r"];
const KEY_DOWN = "amb-feather-d";
/** THREE PLUMAGES, one per bird design group. Pale, because a feather on the
 *  ground is the pale thing in the picture — but never white: white is the
 *  specular the water glints own. */
const VANE = [0xe9e3d3, 0xdfe3e8, 0xdac7a4];

interface Feather {
  sprite: Phaser.GameObjects.Image;
  /** Where it was shed, world px. */
  x: number;
  y: number;
  alt: number;
  kick: number;
  amp: number;
  period: number;
  phase: number;
  rest: number;
  age: number;
  life: number;
  hue: number;
  a: number;
  /** Stable across frames so a gate can track ONE feather's fall. */
  id: number;
}

export function feathersFeature(): AmbientFeature {
  const feathers: Feather[] = [];
  const queued: FlushEvent[] = [];
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let scene: Phaser.Scene | null = null;
  let off: (() => void) | null = null;
  let lastFlushAt = -1e9;
  let demoIn = DEMO_GAP;
  let clock = 0;
  let seed = 20260911;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const stats = { flushes: 0, shed: 0, demo: 0, dropped: 0 };
  let nextId = 0;

  /* ---- art ---------------------------------------------------------------- */

  const paint = (
    s: Phaser.Scene,
    key: string,
    w: number,
    h: number,
    layers: { c: number; px: ReadonlyArray<readonly [number, number]> }[],
  ) => {
    if (s.textures.exists(key)) return;
    const g = s.make.graphics({ x: 0, y: 0 }, false);
    for (const { c, px } of layers) {
      g.fillStyle(c, 1);
      for (const [x, y] of px) g.fillRect(x, y, 1, 1);
    }
    g.generateTexture(key, w, h);
    g.destroy();
  };

  /** Painted WHITE and tinted per feather, so one set of art serves every
   *  plumage. 4x4: a vane of three pixels with a one-pixel shaft trailing it,
   *  leaning left, flat, and leaning right; plus the flatter shape it takes
   *  lying on the ground, seen from above. */
  const ensureTextures = (s: Phaser.Scene) => {
    if (s.textures.exists(KEY_DOWN)) return;
    const W = 0xffffff;
    /* THE SHAFT IS NEARLY BLACK, AND IT IS WHAT MAKES THE FEATHER VISIBLE.
     * The vane is pale by nature, and pale on pale sand is nothing: measured
     * on the beach, the drawn feather differed from the ground it lay on by
     * FIVE luma and the pixel gate read zero. Tint MULTIPLIES, so a dark art
     * pixel stays dark whatever plumage it is tinted to — one dark line under
     * the vane and the shape reads on sand, stone and grass alike. Contrast,
     * not colour: the ants' rule, and the same measurement behind it. */
    const S = 0x4a4a4a;
    paint(s, KEY_TILT[0], 4, 4, [
      { c: W, px: [[0, 0], [1, 0], [1, 1], [2, 1]] },
      { c: S, px: [[2, 2], [2, 3], [3, 3]] },
    ]);
    paint(s, KEY_TILT[1], 4, 4, [
      { c: W, px: [[1, 0], [2, 0], [1, 1], [2, 1]] },
      { c: S, px: [[2, 2], [2, 3], [1, 2]] },
    ]);
    paint(s, KEY_TILT[2], 4, 4, [
      { c: W, px: [[2, 0], [3, 0], [1, 1], [2, 1]] },
      { c: S, px: [[1, 2], [1, 3], [0, 3]] },
    ]);
    /* LYING DOWN IT IS WIDER AND HAS A VISIBLE SHAFT. The first cut was a
     * 4x2 blob and on pale sand it read as a dropped pixel — a feather on the
     * ground is seen flat, so it is longer than it is deep, and the darker
     * shaft along it is what names the shape. */
    paint(s, KEY_DOWN, 6, 3, [
      { c: W, px: [[1, 0], [2, 0], [3, 0], [1, 1], [2, 1], [3, 1], [4, 1]] },
      { c: S, px: [[0, 1], [2, 2], [3, 2], [4, 2], [5, 2]] },
    ]);
  };

  /* ---- shedding ------------------------------------------------------------ */

  const shed = (x: number, y: number, gy: number, type: number) => {
    if (feathers.length >= MAX_FEATHERS || !scene) {
      stats.dropped++;
      return;
    }
    const alt = Math.max(0, Math.min(MAX_ALT, gy - y));
    const kick = LIFT_PX[0] + rnd() * (LIFT_PX[1] - LIFT_PX[0]);
    const amp = SWING_AMP[0] + rnd() * (SWING_AMP[1] - SWING_AMP[0]);
    const period = SWING_MS[0] + rnd() * (SWING_MS[1] - SWING_MS[0]);
    const rest = REST_MS[0] + rnd() * (REST_MS[1] - REST_MS[0]);
    const hue = type % VANE.length;
    const sprite = scene.add
      .image(0, 0, KEY_TILT[1])
      .setDepth(DEPTH)
      .setScale(1)
      .setVisible(false);
    feathers.push({
      sprite,
      x: Math.round(x + (rnd() - 0.5) * 2 * SPREAD),
      y: Math.round(y),
      alt,
      kick,
      amp,
      period,
      phase: rnd() * Math.PI * 2,
      rest,
      age: 0,
      life: featherLife(alt, kick, rest),
      hue,
      a: 0,
      id: ++nextId,
    });
    stats.shed++;
  };

  /* ---- the feature --------------------------------------------------------- */

  return {
    name: NAME,
    init(ctx) {
      scene = ctx.scene;
      ensureTextures(ctx.scene);
      // The events arrive on the flock's own tick, which may be before or
      // after ours; queue them and shed on our next update so a feather is
      // never created from inside another feature's loop.
      off = onFlush((e) => {
        stats.flushes++;
        lastFlushAt = clock;
        queued.push(e);
      });
    },
    update(ctx, dt) {
      const dtc = Math.min(dt, 100);
      clock += dtc;
      const live = feathers.length > 0;
      const target = suppressed ? 0 : forced || live || queued.length ? 1 : 0;
      gain += (target - gain) * Math.min(1, (dtc / GAIN_TAU) * 3);
      const g = gain * ctx.outdoor;

      // take the flock's news, whether or not we are drawing (a suppressed
      // feature must not accumulate a backlog to dump when it switches on)
      const take = queued.splice(0, queued.length);
      if (!suppressed && ctx.outdoor > 0.01)
        for (const e of take) {
          shed(e.x, e.y, e.gy, e.type);
          if (rnd() < SECOND_FEATHER) shed(e.x, e.y, e.gy, e.type);
        }

      /* DEMO-ONLY: selected alone in Settings there are no birds and so no
       * flush, and the row would look broken. Only while FORCED, only when
       * NO FLOCK IS RUNNING (`hasFlushSource` — MANUAL mode forces every
       * enabled field, so `forced` alone cannot tell "soloed" from "enabled
       * beside birds", and the demo was firing over a live flock), and only
       * when nothing has flushed for a while. */
      if (forced && !suppressed && !hasFlushSource() && ctx.outdoor > 0.01 && clock - lastFlushAt > DEMO_QUIET) {
        demoIn -= dtc;
        if (demoIn <= 0) {
          demoIn = DEMO_GAP;
          const p = findGround(ctx.view, rnd, 10, 8);
          if (p) {
            stats.demo++;
            shed(p.x, p.y - (18 + rnd() * 20), p.y, (rnd() * 3) | 0);
          }
        }
      }

      const sunK = 0.45 + 0.55 * ctx.env.sun;
      for (let i = feathers.length - 1; i >= 0; i--) {
        const f = feathers[i];
        f.age += dtc;
        if (f.age >= f.life || g < 0.01) {
          f.sprite.destroy();
          feathers.splice(i, 1);
          continue;
        }
        const at = featherAt(f.age, f.alt, f.kick, f.amp, f.period, f.phase);
        const a = featherAlpha(f.age, f.alt, f.kick, f.rest) * g * sunK;
        f.a = a;
        const t: Tilt = at.tilt;
        f.sprite
          .setTexture(at.down ? KEY_DOWN : KEY_TILT[t])
          .setTint(VANE[f.hue]) // one plumage tint; the dark shaft is in the ART, not the tint
          .setPosition(f.x + at.dx, f.y + Math.round(at.dy))
          .setDepth(DEPTH + (f.y + at.dy) * DEPTH_BIAS)
          .setAlpha(a)
          .setVisible(a > 0.01);
      }
    },
    setSuppressed(on) {
      suppressed = on;
    },
    setForced(on) {
      forced = on;
      if (on) demoIn = 400;
    },
    debug() {
      return {
        gain,
        suppressed,
        forced,
        ...stats,
        queued: queued.length,
        source: hasFlushSource(),
        feathers: feathers.length,
        maxAlt: MAX_ALT,
        fadeMs: FADE_MS,
        all: feathers.map((f, i) => {
          const at = featherAt(f.age, f.alt, f.kick, f.amp, f.period, f.phase);
          return {
            id: f.id,
            i,
            x: f.x + at.dx,
            y: f.y + Math.round(at.dy),
            age: Math.round(f.age),
            alt: Math.round(f.alt),
            dy: Math.round(at.dy),
            tilt: at.tilt,
            down: at.down,
            a: +f.a.toFixed(3),
            onGround: at.down ? landableAt(f.x + at.dx, f.y + at.dy) : null,
          };
        }),
      };
    },
    dispose() {
      off?.();
      off = null;
      for (const f of feathers) f.sprite.destroy();
      feathers.length = 0;
      queued.length = 0;
      scene = null;
    },
  };
}
