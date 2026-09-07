import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { paintPixels } from "../runtime/ground";

/* MOTHS — the thing that circles a lamp after dark.
 *
 * The town at night is where the maintainer actually stands, and it already has
 * what this needs: every lit thing in the world is a record with a DRAWN anchor
 * (emissive tiles and scenery lamps alike), surfaced by `__ml.lightsInView`.
 * A moth is then two facts — a lamp, and an orbit around it.
 *
 * IT MUST NOT COST A FRAME. This effect is the first one written after a
 * performance ask ("make sure the game doesn't start to lag just because of
 * this feature"), so its budget is part of the design rather than something
 * measured afterwards:
 *   • The lamp list is read on a THROTTLE (LAMP_MS), never per frame and never
 *     per moth — the probe walks every source in the world, so calling it 60
 *     times a second would be the whole cost of the feature.
 *   • The per-frame work is trig on at most MAX_MOTHS marks: no probe, no
 *     allocation, no texture churn. Sprites are pooled for the life of the
 *     scene and only ever repositioned.
 *   • A DAY frame returns before any of it: the gain is 0, so the throttle
 *     never even fires. The effect costs nothing at all when it is not on.
 * `__mlAmbient.cost()` reports what this actually measures at, per frame.
 *
 * The look: a moth holds a wide, wobbling orbit and every so often DIVES at the
 * lamp — the bump against the glass is the whole reason the shape is legible at
 * two pixels. Cream-white shading toward the lamp's own colour, because a moth
 * at a lamp is lit by it.
 */

const KEY = "amb-moth";
const DEPTH_BASE = 900_000.06; // just over the darkness overlay, like the crawlers
const DEPTH_BIAS = 1e-6;
const GAIN_TAU = 1500;

const LAMP_MS = 520; // how often the lamp list is re-read (NOT per frame)
const MAX_MOTHS = 10; // hard ceiling on drawn marks
const PER_LAMP = 3; // and no more than this around any one lamp
const LAMP_MIN_R = 1.5; // cells: a candle draws nobody; a lamp does

const ORBIT_PX: [number, number] = [11, 27]; // horizontal radius of the circling
const ORBIT_SQUASH = 0.55; // the iso plane is shallow — an orbit is an ellipse
const SPIN: [number, number] = [0.7, 1.9]; // radians/s
const BOB_PX: [number, number] = [3, 9]; // how far above the lamp head it rides
const WOBBLE = 1.6; // px of flutter, so the circle is not a drawn ring

const DIVE_EVERY: [number, number] = [1400, 5200]; // ms between bumps at the lamp
const DIVE_MS = 420; // how long one bump takes
const DIVE_TO = 0.22; // fraction of the orbit it closes to

const LIFE: [number, number] = [9_000, 26_000];
const FADE_MS = 600; // moths arrive and leave on their own, never in a batch
const ALPHA: [number, number] = [0.5, 0.85];
const MOTH_CREAM = 0xf2e9d2;

interface Moth {
  sprite: Phaser.GameObjects.Image;
  lamp: number; // index into the throttled lamp list
  ang: number;
  spin: number;
  rx: number;
  bob: number;
  phase: number; // flutter
  dive: number; // ms until the next bump
  diving: number; // ms left of the current bump
  life: number;
  a: number; // own 0..1 opacity
  base: number; // its peak alpha
}

interface Lamp {
  id: string;
  x: number;
  y: number;
  r: number;
  color: [number, number, number];
  sealed: boolean;
}

export function mothsFeature(): AmbientFeature {
  const moths: Moth[] = [];
  let lamps: Lamp[] = [];
  let lampAge = 0;
  let probes = 0; // how often the lamp list was read (QA: this must stay small)
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let seed = 991;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const range = ([a, b]: [number, number]) => a + rnd() * (b - a);

  const readLamps = (): Lamp[] => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const f = ml?.lightsInView as undefined | ((pad?: number) => Lamp[]);
    if (!f) return [];
    probes++;
    try {
      // Outdoor effect: a lamp sealed inside a room is not ours (the room's own
      // light stays in the room, and so should whatever circles it).
      return (f(64) || []).filter((l) => !l.sealed && l.r >= LAMP_MIN_R);
    } catch {
      return [];
    }
  };

  const reset = (m: Moth, lamp: number) => {
    m.lamp = lamp;
    m.ang = rnd() * Math.PI * 2;
    m.spin = range(SPIN) * (rnd() < 0.5 ? 1 : -1);
    m.rx = range(ORBIT_PX);
    m.bob = range(BOB_PX);
    m.phase = rnd() * Math.PI * 2;
    m.dive = range(DIVE_EVERY);
    m.diving = 0;
    m.life = range(LIFE);
    m.base = range(ALPHA);
    m.a = 0;
  };

  return {
    name: "moths",
    init(ctx) {
      // Two pixels: a body and the blur of a wing. Painted WHITE — the drawn
      // colour is the per-frame tint, which leans toward the lamp it circles.
      paintPixels(ctx.scene, KEY, 2, 1, 0xffffff, [[0, 0], [1, 0]]);
    },
    update(ctx, dt) {
      // NIGHT ONLY, and cloud does not stop them: a moth flies whatever the sky
      // is doing, it just needs the lamp to be the brightest thing around.
      const target = forced ? 1 : suppressed ? 0 : ctx.env.night;
      gain += (target - gain) * Math.min(1, (dt / GAIN_TAU) * 3);
      const g = gain * ctx.outdoor;
      if (g <= 0.02) {
        // DAY: nothing is read, nothing is stepped, nothing is drawn.
        for (const m of moths) if (m.sprite.visible) m.sprite.setVisible(false);
        return;
      }

      lampAge += dt;
      if (lampAge >= LAMP_MS || !lamps.length) {
        lampAge = 0;
        lamps = readLamps();
      }
      if (!lamps.length) {
        for (const m of moths) if (m.sprite.visible) m.sprite.setVisible(false);
        return;
      }

      // How many marks the view earns: a couple per lamp, under the ceiling.
      const want = Math.min(MAX_MOTHS, lamps.length * PER_LAMP);
      while (moths.length < want) {
        const m: Moth = {
          sprite: ctx.scene.add.image(0, 0, KEY).setOrigin(0.5, 0.5).setScale(1).setVisible(false),
          lamp: 0, ang: 0, spin: 1, rx: 16, bob: 5, phase: 0, dive: 0, diving: 0, life: 0, a: 0, base: 1,
        };
        reset(m, (rnd() * lamps.length) | 0);
        moths.push(m);
      }

      const secs = dt / 1000;
      for (let i = 0; i < moths.length; i++) {
        const m = moths[i];
        if (i >= want) { m.sprite.setVisible(false); continue; }
        m.life -= dt;
        if (m.life <= 0 && m.a <= 0) reset(m, (rnd() * lamps.length) | 0);

        const lamp = lamps[Math.min(m.lamp, lamps.length - 1)];
        // Fade in on arrival, out at the end of its life — one moth at a time.
        const wantA = m.life > FADE_MS ? 1 : 0;
        m.a = wantA > m.a ? Math.min(1, m.a + dt / FADE_MS) : Math.max(0, m.a - dt / FADE_MS);

        // The BUMP: every so often it closes on the lamp and swings back out.
        m.dive -= dt;
        if (m.dive <= 0 && m.diving <= 0) { m.diving = DIVE_MS; m.dive = range(DIVE_EVERY); }
        if (m.diving > 0) m.diving = Math.max(0, m.diving - dt);
        const k = m.diving > 0 ? Math.sin((m.diving / DIVE_MS) * Math.PI) : 0; // 0 → 1 → 0
        const r = m.rx * (1 - (1 - DIVE_TO) * k);

        m.ang += m.spin * secs;
        m.phase += dt * 0.011;
        const x = lamp.x + Math.cos(m.ang) * r + Math.sin(m.phase) * WOBBLE;
        const y = lamp.y + Math.sin(m.ang) * r * ORBIT_SQUASH - m.bob + Math.cos(m.phase * 1.3) * WOBBLE * 0.6;

        // Lit BY the lamp: cream shaded toward that lamp's own colour.
        const lc = lamp.color;
        const mix = (c: number, l: number) => Math.round(c * (0.45 + 0.55 * Math.min(1, Math.max(0, l)))) & 255;
        const tint =
          (mix((MOTH_CREAM >> 16) & 255, lc[0]) << 16) |
          (mix((MOTH_CREAM >> 8) & 255, lc[1]) << 8) |
          mix(MOTH_CREAM & 255, lc[2]);

        const iy = Math.round(y);
        m.sprite
          .setPosition(Math.round(x), iy)
          .setDepth(DEPTH_BASE + iy * DEPTH_BIAS)
          .setTint(tint)
          .setAlpha(g * m.a * m.base)
          .setVisible(m.a > 0.01);
      }
    },
    setSuppressed(on) { suppressed = on; },
    setForced(on) { forced = on; },
    debug() {
      const live = moths.filter((m) => m.sprite.visible);
      return {
        gain: +gain.toFixed(3),
        lamps: lamps.length,
        probes, // QA: this must stay near 2/s, never per frame
        moths: live.length,
        all: live.map((m) => ({
          x: Math.round(m.sprite.x),
          y: Math.round(m.sprite.y),
          lamp: m.lamp,
          lampX: Math.round(lamps[Math.min(m.lamp, lamps.length - 1)]?.x ?? 0),
          lampY: Math.round(lamps[Math.min(m.lamp, lamps.length - 1)]?.y ?? 0),
          rx: +m.rx.toFixed(1),
          diving: m.diving > 0,
          a: +m.sprite.alpha.toFixed(3),
        })),
      };
    },
    dispose() {
      for (const m of moths) m.sprite.destroy();
      moths.length = 0;
      lamps = [];
    },
  };
}
