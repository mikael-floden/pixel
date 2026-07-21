import Phaser from "phaser";
import { AmbientCtx, AmbientFeature, PHASE_NIGHT, WEATHER_CLEAR } from "../runtime/types";

// Fireflies — tiny wandering lanterns that own the night. Each fly is an
// additive glow sprite tracing a slow Lissajous wander around a drifting
// anchor, pulsing on its own rhythm with soft "dark rests" (real fireflies
// blink OFF, they don't sinusoid). Everything fades with the sun: the whole
// swarm melts away through sunrise and rekindles at dusk, and heavy cloud
// thins it. Depth sits just above the darkness overlay (900_000) — a light
// source can't be dimmed by the night it lives in.
const TEX = "amb-firefly";
const DEPTH = 900_000.6;
const MARGIN = 48; // world px beyond the view before a fly re-anchors
const AREA_PER_FLY = 9000; // ~17 flies on a 480×320 phone view
const MIN_FLIES = 6;
const MAX_FLIES = 28;
const GAIN_TAU = 1500; // ms — swarm fade in/out
// Warm lantern hues — mostly green-gold, the odd amber one.
const TINTS = [0xb8ff78, 0xd4ff8a, 0xb8ff78, 0xffe08a];

interface Fly {
  sprite: Phaser.GameObjects.Image;
  ax: number; // anchor (world px) the wander orbits
  ay: number;
  vx: number; // slow anchor drift
  vy: number;
  rx: number; // wander radii
  ry: number;
  wf1: number; // wander freqs (rad/s)
  wf2: number;
  pf: number; // pulse freq (rad/s)
  p0: number; // pulse phase
  t: number; // own clock (s)
  bright: number; // per-fly max alpha
}

export function firefliesFeature(): AmbientFeature {
  const flies: Fly[] = [];
  let gain = 0; // eased swarm-wide alpha multiplier
  let suppressed = false; // demo solo mode: another effect owns the stage
  let forced = false; // demo: fireflies selected — show at full, any time
  let seed = 1;
  // Deterministic-enough local PRNG (repo convention: derived seeds, but
  // ambient wander has no replay contract — cheap LCG keeps it allocation-free).
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

  const ensureTexture = (scene: Phaser.Scene) => {
    if (scene.textures.exists(TEX)) return;
    // Same procedural-glow idiom as the game's star-spark: stacked faint
    // circles for the halo, a bright 1.5px core. Rendered once, nearest-scaled.
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    for (let i = 3; i >= 2; i--) g.fillStyle(0xffffff, 0.11).fillCircle(5, 5, 1.3 * i);
    g.fillStyle(0xffffff, 1).fillCircle(5, 5, 1.4);
    g.generateTexture(TEX, 10, 10);
    g.destroy();
  };

  const spawnInto = (fly: Fly, view: Phaser.Geom.Rectangle) => {
    fly.ax = view.x + rnd() * view.width;
    fly.ay = view.y + rnd() * view.height;
    const sp = 2.5 + rnd() * 5; // anchor drift, world px/s — a lazy meander
    const dir = rnd() * Math.PI * 2;
    fly.vx = Math.cos(dir) * sp;
    fly.vy = Math.sin(dir) * sp * 0.6; // iso world: flatten vertical travel
    fly.rx = 5 + rnd() * 9;
    fly.ry = 3 + rnd() * 6;
    fly.wf1 = 0.5 + rnd() * 0.9;
    fly.wf2 = 0.7 + rnd() * 1.1;
    fly.pf = 0.9 + rnd() * 1.4;
    fly.p0 = rnd() * Math.PI * 2;
    fly.t = rnd() * 10;
    fly.bright = 0.55 + rnd() * 0.45;
  };

  const targetCount = (view: Phaser.Geom.Rectangle) =>
    Math.max(MIN_FLIES, Math.min(MAX_FLIES, Math.round((view.width * view.height) / AREA_PER_FLY)));

  return {
    name: "fireflies",
    preferred: { time: PHASE_NIGHT, weather: WEATHER_CLEAR },
    conflicts: ["pollen"], // day/night floating-mote pair — one at a time
    init(ctx) {
      ensureTexture(ctx.scene);
    },
    update(ctx, dt) {
      const dts = Math.min(dt, 100) / 1000; // clamp laggy frames — ambient never lurches
      const view = ctx.view;
      // Night owns the swarm; heavy cloud thins it (a starless overcast night
      // still keeps a few — mystery beats realism).
      const target = forced ? 1 : suppressed ? 0 : ctx.env.night * (1 - 0.4 * ctx.env.cloud);
      gain += (target - gain) * Math.min(1, (dt / GAIN_TAU) * 3);
      const visible = gain > 0.02;

      // Population follows the view size (zoom/resize aware).
      const want = targetCount(view);
      while (flies.length < want) {
        const sprite = ctx.scene.add
          .image(0, 0, TEX)
          .setDepth(DEPTH)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setTint(TINTS[flies.length % TINTS.length])
          .setVisible(false);
        const fly: Fly = {
          sprite,
          ax: 0, ay: 0, vx: 0, vy: 0, rx: 0, ry: 0,
          wf1: 0, wf2: 0, pf: 0, p0: 0, t: 0, bright: 0,
        };
        spawnInto(fly, view);
        flies.push(fly);
      }
      while (flies.length > want) flies.pop()!.sprite.destroy();

      if (!visible) {
        // Full idle at daytime: hide once, skip all per-fly math.
        for (const f of flies) if (f.sprite.visible) f.sprite.setVisible(false);
        return;
      }
      for (const f of flies) {
        f.t += dts;
        f.ax += f.vx * dts;
        f.ay += f.vy * dts;
        // Camera moved on / fly meandered off: rejoin the view.
        if (
          f.ax < view.x - MARGIN || f.ax > view.right + MARGIN ||
          f.ay < view.y - MARGIN || f.ay > view.bottom + MARGIN
        ) {
          spawnInto(f, view);
        }
        const x = f.ax + Math.sin(f.t * f.wf1) * f.rx + Math.sin(f.t * f.wf2 * 1.7) * 2;
        const y = f.ay + Math.cos(f.t * f.wf2) * f.ry + Math.sin(f.t * f.wf1 * 2.3) * 1.5;
        // Pulse with dark rests: the lantern breathes bright, then truly rests.
        const s = Math.sin(f.t * f.pf + f.p0);
        const pulse = s > -0.35 ? 0.35 + 0.65 * ((s + 0.35) / 1.35) : 0.06;
        f.sprite.setPosition(x, y).setAlpha(gain * f.bright * pulse).setVisible(true);
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
        count: flies.length,
        lit: flies.filter((f) => f.sprite.visible && f.sprite.alpha > 0.05).length,
        sample: flies[0] ? { x: flies[0].sprite.x, y: flies[0].sprite.y, a: flies[0].sprite.alpha } : null,
      };
    },
    dispose() {
      for (const f of flies) f.sprite.destroy();
      flies.length = 0;
    },
  };
}
