import Phaser from "phaser";
import { AmbientCtx, AmbientFeature, PHASE_NIGHT, WEATHER_CLEAR } from "../runtime/types";

// Bats — an EPISODE feature: while the director has us active, a small
// flock crosses the sky every so often. Nocturnal by design: likeliness is
// ~1% of base during the day (maintainer's example, verbatim). The bats are
// hand-pixelled 2-frame silhouettes flying in the sky band (above the world
// and the darkness overlay, below shooting stars), with per-bat flap rates,
// bobbing, and stagger so a flock reads as animals, not a formation.
const DEPTH = 1_499_800;
const FRAMES = ["amb-bat0", "amb-bat1"];
// 9×5 / 9×4 one-px silhouettes; drawn per-pixel, scaled ~2× nearest at run.
const PIX0 = [
  "X.......X",
  "XX.....XX",
  ".XXX.XXX.",
  "...XXX...",
  "....X....",
];
const PIX1 = [
  ".........",
  "...XX.XX.",
  "XXXXXXXXX",
  ".X..X..X.",
];
const BASE_WEIGHT = 1.0;
const DAY_MULT = 0.01; // "1% times the base-likeliness during the day"
const FLOCK_EVERY_MS: [number, number] = [14_000, 40_000];
const TINT = 0x141020; // near-black violet — reads on night ground AND sky

interface Bat {
  sprite: Phaser.GameObjects.Image;
  x: number;
  y: number;
  vx: number;
  vy: number;
  flapMs: number; // per-bat flap period
  flapT: number;
  frame: number;
  bobF: number;
  bobA: number;
  t: number;
}

export function batsFeature(): AmbientFeature {
  const bats: Bat[] = [];
  let active = false;
  let nextFlockIn = 3000; // first flock shortly after activation
  let flocks = 0;
  let seed = 13;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

  const ensureTextures = (scene: Phaser.Scene) => {
    if (scene.textures.exists(FRAMES[0])) return;
    for (const [key, pix] of [
      [FRAMES[0], PIX0],
      [FRAMES[1], PIX1],
    ] as const) {
      const g = scene.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(0xffffff, 1);
      pix.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) if (row[x] === "X") g.fillRect(x, y, 1, 1);
      });
      g.generateTexture(key, PIX0[0].length, pix.length);
      g.destroy();
    }
  };

  const launchFlock = (ctx: AmbientCtx) => {
    flocks++;
    const view = ctx.view;
    const n = 3 + Math.floor(rnd() * 5);
    const ltr = rnd() < 0.5;
    const speed = 90 + rnd() * 50;
    const baseY = view.y + view.height * (0.1 + rnd() * 0.4); // upper sky band
    for (let i = 0; i < n; i++) {
      const sprite = ctx.scene.add
        .image(0, 0, FRAMES[0])
        .setDepth(DEPTH + i * 0.001)
        .setTint(TINT)
        .setAlpha(0.85)
        .setScale(2) // 2× nearest — pixel-art rule, integer scale
        .setFlipX(!ltr);
      bats.push({
        sprite,
        x: (ltr ? view.x - 30 : view.right + 30) - (ltr ? 1 : -1) * rnd() * 90, // stagger behind the edge
        y: baseY + (rnd() - 0.5) * 46,
        vx: (ltr ? 1 : -1) * speed * (0.9 + rnd() * 0.2),
        vy: (rnd() - 0.5) * 8,
        flapMs: 70 + rnd() * 60,
        flapT: rnd() * 100,
        frame: 0,
        bobF: 3 + rnd() * 4,
        bobA: 2 + rnd() * 4,
        t: rnd() * 5,
      });
    }
  };

  return {
    name: "bats",
    preferred: { time: PHASE_NIGHT, weather: WEATHER_CLEAR },
    weight(env) {
      // Smooth between the maintainer's two anchors: night ×1, day ×0.01.
      return BASE_WEIGHT * (DAY_MULT + (1 - DAY_MULT) * env.night);
    },
    setActive(on) {
      active = on;
      if (on) nextFlockIn = 2000 + Math.random() * 4000;
      // off: no new flocks; in-flight bats finish their crossing (graceful).
    },
    init(ctx) {
      ensureTextures(ctx.scene);
    },
    update(ctx, dt) {
      const dts = Math.min(dt, 100) / 1000;
      if (active) {
        nextFlockIn -= dt;
        if (nextFlockIn <= 0) {
          launchFlock(ctx);
          nextFlockIn = FLOCK_EVERY_MS[0] + rnd() * (FLOCK_EVERY_MS[1] - FLOCK_EVERY_MS[0]);
        }
      }
      if (!bats.length) return;
      const view = ctx.view;
      for (let i = bats.length - 1; i >= 0; i--) {
        const b = bats[i];
        b.t += dts;
        b.x += b.vx * dts;
        b.y += b.vy * dts;
        b.flapT += dt;
        if (b.flapT >= b.flapMs) {
          b.flapT -= b.flapMs;
          b.frame = 1 - b.frame;
          b.sprite.setTexture(FRAMES[b.frame]);
        }
        b.sprite.setPosition(b.x, b.y + Math.sin(b.t * b.bobF) * b.bobA);
        // Crossed out of the view (plus slack)? The bat is done.
        if ((b.vx > 0 && b.x > view.right + 60) || (b.vx < 0 && b.x < view.x - 60)) {
          b.sprite.destroy();
          bats.splice(i, 1);
        }
      }
    },
    debug() {
      return { active, inFlight: bats.length, flocks, nextFlockIn: active ? Math.round(nextFlockIn) : null };
    },
    dispose() {
      for (const b of bats) b.sprite.destroy();
      bats.length = 0;
    },
  };
}
