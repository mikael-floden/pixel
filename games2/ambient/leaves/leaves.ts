import Phaser from "phaser";
import { AmbientCtx, AmbientFeature, PHASE_EVENING, WEATHER_CLEAR } from "../runtime/types";

// Falling autumn leaves — an EPISODE. Each leaf FALLS in the game-world
// coordinate system (maintainer 2026-07-18): it has a fixed ground-contact
// point (gx, gy — a world position) and a HEIGHT h above it. Gravity pulls
// h → 0 while the leaf sways and tumbles; when h hits 0 the leaf LANDS on
// that ground point, RESTS there a few seconds, then FADES away and a new
// leaf falls. It is drawn in a foreground band (above the world art, under
// the night overlay so it dims at night) so it's visible falling PAST
// terrain — not occluded by cliffs, and not stuck sliding along the ground.
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
const TINTS = [0xd9772e, 0xc0491f, 0xe0a52a, 0xb8702f, 0xcf5a25]; // warm autumn
const DEPTH = 895_000; // foreground: over world art, UNDER the 900_000 night overlay
const BASE_WEIGHT = 0.5;
const AREA_PER_LEAF = 42000; // sparse — leaves drift, they don't blizzard
const MIN_LEAVES = 5;
const MAX_LEAVES = 26;
const REST_MS: [number, number] = [4000, 9000]; // lie on the ground this long
const FADE_MS = 1800;
// The cloud layer's wind heading — leaves drift the same way clouds do.
const WL = Math.hypot(42, 23);
const WX = 42 / WL;
const WY = 23 / WL;

const FALLING = 0;
const RESTING = 1;
const FADING = 2;

interface Leaf {
  sprite: Phaser.GameObjects.Image;
  gx: number; // ground-contact world x (drifts with wind while falling)
  gy: number; // ground-contact world y (the leaf lands HERE)
  h: number; // height above the ground contact (px, screen-up); 0 = landed
  fall: number; // fall speed px/s
  drift: number; // wind drift speed px/s while airborne
  swayF: number; // pendulum freq
  sway0: number; // pendulum phase
  swayA: number; // pendulum amplitude px
  spin: number; // accumulated roll
  spinV: number; // roll speed
  flutF: number; // edge-on flutter freq
  t: number;
  scale: number;
  state: number;
  restT: number; // ms remaining resting
  alpha: number; // per-leaf alpha (drops during FADING)
  landX: number; // frozen draw-x once landed
}

export function leavesFeature(): AmbientFeature {
  const leaves: Leaf[] = [];
  let active = false;
  let gain = 0; // eased episode gain (fades the whole fall in/out)
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

  // Start a leaf FALLING toward a fresh ground point in view. `anywhere`
  // (initial fill) starts it at a random height so the first leaves aren't
  // all queued at the top; otherwise it enters from above the view top.
  const spawn = (lf: Leaf, view: Phaser.Geom.Rectangle, anywhere: boolean) => {
    lf.gx = view.x + rnd() * view.width;
    lf.gy = view.y + view.height * (0.15 + rnd() * 0.8); // land somewhere on-screen
    const topGap = lf.gy - view.y + 30 + rnd() * 120; // full drop from above the view
    lf.h = anywhere ? rnd() * topGap : topGap;
    lf.fall = 34 + rnd() * 34;
    lf.drift = 10 + rnd() * 16;
    lf.swayF = 0.7 + rnd() * 1.3;
    lf.sway0 = rnd() * Math.PI * 2;
    lf.swayA = 7 + rnd() * 14;
    lf.spin = rnd() * Math.PI * 2;
    lf.spinV = (rnd() - 0.5) * 2.4;
    lf.flutF = 1.5 + rnd() * 2.5;
    lf.t = rnd() * 10;
    lf.scale = 1 + rnd() * 0.9; // small — a leaf, not a dinner plate
    lf.state = FALLING;
    lf.restT = REST_MS[0] + rnd() * (REST_MS[1] - REST_MS[0]);
    lf.alpha = 1;
    lf.landX = 0;
    lf.sprite.setTint(TINTS[Math.floor(rnd() * TINTS.length) % TINTS.length]);
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
        const sprite = ctx.scene.add.image(0, 0, FRAMES[0]).setDepth(DEPTH);
        const lf: Leaf = {
          sprite, gx: 0, gy: 0, h: 0, fall: 0, drift: 0, swayF: 0, sway0: 0, swayA: 0,
          spin: 0, spinV: 0, flutF: 0, t: 0, scale: 1, state: FALLING, restT: 0, alpha: 1, landX: 0,
        };
        spawn(lf, view, true);
        leaves.push(lf);
      }
      while (leaves.length > want) leaves.pop()!.sprite.destroy();
      if (!visible) return;

      for (const lf of leaves) {
        lf.t += dts;
        let drawX: number;
        if (lf.state === FALLING) {
          lf.h -= lf.fall * dts; // gravity: height shrinks toward the ground
          // Drift the landing point on the wind while airborne.
          lf.gx += WX * lf.drift * dts;
          lf.gy += WY * lf.drift * dts * 0.5;
          lf.spin += lf.spinV * dts;
          const sway = Math.cos(lf.t * lf.swayF + lf.sway0) * lf.swayA;
          drawX = lf.gx + sway;
          if (lf.h <= 0) {
            // LANDED: freeze on the ground, settle the roll, start the rest.
            lf.h = 0;
            lf.state = RESTING;
            lf.landX = drawX;
            lf.spinV *= 0.15;
          }
        } else {
          drawX = lf.landX; // resting/fading: still on the ground
          lf.spin += lf.spinV * dts; // tiny residual settle, already damped
          if (lf.state === RESTING) {
            lf.restT -= dt;
            if (lf.restT <= 0) lf.state = FADING;
          } else {
            lf.alpha -= dt / FADE_MS;
            if (lf.alpha <= 0) {
              spawn(lf, view, false); // done — a new leaf falls from the top
              continue;
            }
          }
        }
        // A leaf that drifted off the sides/bottom while airborne recycles.
        if (lf.state === FALLING && (lf.gx > view.right + 20 || lf.gy > view.bottom + 20)) {
          spawn(lf, view, false);
          continue;
        }
        // Flutter: the leaf turns edge-on (narrows) then fills — fakes a
        // tumbling 3D leaf; landed leaves flutter far less.
        const flut = lf.state === FALLING ? 0.35 + 0.65 * Math.abs(Math.cos(lf.t * lf.flutF)) : 0.9;
        lf.sprite
          .setPosition(drawX, lf.gy - lf.h) // drawn lifted by the height; lands at gy
          .setRotation(lf.spin)
          .setScale(lf.scale * flut, lf.scale)
          .setAlpha(gain * 0.95 * lf.alpha);
      }
    },
    debug() {
      let falling = 0, resting = 0, fading = 0;
      for (const lf of leaves) {
        if (lf.state === FALLING) falling++;
        else if (lf.state === RESTING) resting++;
        else fading++;
      }
      return {
        active,
        gain,
        count: leaves.length,
        falling,
        resting,
        fading,
        sample: leaves[0]
          ? { x: Math.round(leaves[0].sprite.x), y: Math.round(leaves[0].sprite.y), h: Math.round(leaves[0].h), state: leaves[0].state }
          : null,
      };
    },
    dispose() {
      for (const lf of leaves) lf.sprite.destroy();
      leaves.length = 0;
    },
  };
}
