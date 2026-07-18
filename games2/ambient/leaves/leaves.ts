import Phaser from "phaser";
import { AmbientCtx, AmbientFeature, PHASE_EVENING, WEATHER_CLEAR } from "../runtime/types";

// Falling autumn leaves — an EPISODE: dry leaves spiral down through the
// world on the wind, swaying like pendulums and tumbling edge-on. Warm
// golden-hour mood, so it prefers Evening.
//
// IN THE WORLD, NOT ON THE HUD (the tumbleweed lesson, applied from the
// start): each leaf lives in the game's world space and DEPTH-SORTS by its
// world-y, so it drifts BEHIND higher terrain and IN FRONT of nearer
// ground, dimmed by night like any physical thing — never a flat sprite
// over everything.
const FRAMES = ["amb-leaf"];
// 7×8 leaf: L body, V midrib/stem (darker so it survives the tint).
const PIX = [
  "...L...",
  "..LVL..",
  ".LLVLL.",
  "LLLVLLL",
  ".LLVLL.",
  "..LVL..",
  "...V...",
  "...V...",
];
const BODY = 0xffffff; // tinted per-leaf
const RIB = 0xaaaaaa; // darker → reads as a vein after tint
// Warm autumn tints (multiply the white body).
const TINTS = [0xd9772e, 0xc0491f, 0xe0a52a, 0xb8702f, 0xcf5a25];
const BASE_WEIGHT = 0.5;
const AREA_PER_LEAF = 42000; // sparse — leaves drift, they don't blizzard
const MIN_LEAVES = 5;
const MAX_LEAVES = 26;
// The cloud layer's wind heading — leaves drift the same way clouds do.
const WL = Math.hypot(42, 23);
const WX = 42 / WL;
const WY = 23 / WL;

interface Leaf {
  sprite: Phaser.GameObjects.Image;
  x: number; // world px
  y: number;
  fall: number; // downward speed px/s
  swayF: number; // pendulum freq
  sway0: number; // pendulum phase
  swayA: number; // pendulum amplitude px
  spin: number; // accumulated roll
  spinV: number; // roll speed
  flutF: number; // edge-on flutter freq
  t: number;
  scale: number;
}

export function leavesFeature(): AmbientFeature {
  const leaves: Leaf[] = [];
  let active = false;
  let gain = 0; // eased population multiplier (leaves thin in, not pop)
  let seed = 97;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

  const ensureTexture = (scene: Phaser.Scene) => {
    if (scene.textures.exists(FRAMES[0])) return;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    PIX.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === ".") continue;
        g.fillStyle(row[x] === "V" ? RIB : BODY, 1);
        g.fillRect(x, y, 1, 1);
      }
    });
    g.generateTexture(FRAMES[0], 7, 8);
    g.destroy();
  };

  const spawn = (lf: Leaf, view: Phaser.Geom.Rectangle, anywhere: boolean) => {
    lf.x = view.x + rnd() * view.width;
    // Steady state: enter from the TOP (they fall in); initial fill: anywhere.
    lf.y = anywhere ? view.y + rnd() * view.height : view.y - 12 - rnd() * 40;
    lf.fall = 24 + rnd() * 38;
    lf.swayF = 0.7 + rnd() * 1.3;
    lf.sway0 = rnd() * Math.PI * 2;
    lf.swayA = 8 + rnd() * 16;
    lf.spin = rnd() * Math.PI * 2;
    lf.spinV = (rnd() - 0.5) * 2.4;
    lf.flutF = 1.5 + rnd() * 2.5;
    lf.t = rnd() * 10;
    lf.scale = 1 + rnd() * 0.9; // small — a leaf, not a dinner plate (maintainer)
    lf.sprite.setTint(TINTS[(Math.floor(rnd() * 1000) % TINTS.length + TINTS.length) % TINTS.length]);
  };

  const targetCount = (view: Phaser.Geom.Rectangle) =>
    Math.max(MIN_LEAVES, Math.min(MAX_LEAVES, Math.round((view.width * view.height) / AREA_PER_LEAF)));

  return {
    name: "leaves",
    preferred: { time: PHASE_EVENING, weather: WEATHER_CLEAR },
    weight(env) {
      // A touch more likely on a breezy (cloudy) day — wind shakes leaves down.
      return BASE_WEIGHT * (0.6 + 0.4 * env.cloud);
    },
    setActive(on) {
      active = on; // gain eases both ways — the fall thins in and out
    },
    init(ctx) {
      ensureTexture(ctx.scene);
    },
    update(ctx, dt) {
      const view = ctx.view;
      const dts = Math.min(dt, 100) / 1000;
      gain += ((active ? 1 : 0) - gain) * Math.min(1, (dt / 1600) * 3);
      const visible = gain > 0.02;

      const want = visible ? targetCount(view) : 0;
      while (leaves.length < want) {
        const sprite = ctx.scene.add.image(0, 0, FRAMES[0]);
        const lf: Leaf = {
          sprite, x: 0, y: 0, fall: 0, swayF: 0, sway0: 0, swayA: 0,
          spin: 0, spinV: 0, flutF: 0, t: 0, scale: 2,
        };
        spawn(lf, view, true);
        leaves.push(lf);
      }
      while (leaves.length > want) leaves.pop()!.sprite.destroy();
      if (!visible) return;

      for (const lf of leaves) {
        lf.t += dts;
        // Fall + wind drift in WORLD space; sway is a horizontal pendulum.
        lf.y += (lf.fall + WY * 18) * dts;
        lf.x += (WX * 22) * dts + Math.cos(lf.t * lf.swayF + lf.sway0) * lf.swayA * dts;
        lf.spin += lf.spinV * dts;
        // Flutter: the leaf turns edge-on, narrowing then filling — fakes a
        // tumbling 3D leaf from a flat sprite.
        const edge = 0.35 + 0.65 * Math.abs(Math.cos(lf.t * lf.flutF));
        if (lf.y > view.bottom + 16 || lf.x > view.right + 16) spawn(lf, view, false);
        lf.sprite
          .setPosition(lf.x, lf.y)
          .setDepth(lf.y) // sort into the world by ground-y, like a character
          .setRotation(lf.spin)
          .setScale(lf.scale * edge, lf.scale)
          .setAlpha(gain * 0.95);
      }
    },
    debug() {
      return {
        active,
        gain,
        count: leaves.length,
        sample: leaves[0] ? { x: Math.round(leaves[0].sprite.x), y: Math.round(leaves[0].sprite.y), d: Math.round(leaves[0].sprite.depth) } : null,
      };
    },
    dispose() {
      for (const lf of leaves) lf.sprite.destroy();
      leaves.length = 0;
    },
  };
}
