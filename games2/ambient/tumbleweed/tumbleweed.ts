import Phaser from "phaser";
import { AmbientCtx, AmbientFeature, PHASE_DAY, WEATHER_CLEAR } from "../runtime/types";
import { isRainy } from "../runtime/env";

// Tumbleweed — a dry twig-ball that BOUNCES across the WORLD on the wind,
// spinning as it rolls, hopping on its ground line and losing a little
// bounce each landing like the real thing. Terrain-flavoured like its
// sibling sandstorm: most likely rolling over sandy ground, rare on plains,
// never in the rain.
//
// IN THE WORLD, NOT ON THE HUD (maintainer): the weed lives in the game's
// isometric world space (cam.worldView coords) and DEPTH-SORTS by its ground
// contact's world-y — exactly like a character (WorldScene sorts avatars by
// their flat painter-y, a screen-y scalar < ~20k, under the 900_000 darkness
// overlay). So it rolls THROUGH the scene: passing BEHIND higher terrain and
// IN FRONT of nearer ground, dimmed by night like any physical thing —
// never a flat sprite painted over everything.
const FRAMES = ["amb-weed0", "amb-weed1"];
// 11×11 two-tone twig-ball, D dark / L light; frame 1 is a quarter-turn
// re-scribble so the roll reads even at low speed.
const PIX0 = [
  "...DLLD....",
  ".DL....LD..",
  ".L..D.L..D.",
  "D..L...D..L",
  "L.D..L..L.D",
  "D...D.D...L",
  "L.L..L...D.",
  "D..D...L..L",
  ".L...D...D.",
  "..DL....LD.",
  "....DLLD...",
];
const PIX1 = [
  "....DLLD...",
  "..DL....LD.",
  ".D..L.D..L.",
  "L..D...L..D",
  "D.L..D..D.L",
  "L...L.L...D",
  "D.D..D...L.",
  "L..L...D..D",
  ".D...L...L.",
  ".DL....DL..",
  "...DLLD....",
];
const DARK = 0x5e4526;
const LIGHT = 0x9a7a4a;
const BASE_WEIGHT = 0.45;
const WEED_EVERY_MS: [number, number] = [8_000, 26_000];
// The cloud layer's wind heading; a weed rolls with it.
const WL = Math.hypot(42, 23);
const WX = 42 / WL;
const WY = 23 / WL;

interface Weed {
  sprite: Phaser.GameObjects.Image;
  x: number;
  y: number; // ground line the weed bounces on (world px)
  h: number; // height above the ground line (>= 0)
  vh: number; // vertical velocity (px/s, positive = up)
  v: number; // ground speed px/s
  spin: number; // radians of roll accumulated
  bounce: number; // energy kept per landing (0..1)
  flapT: number;
  frame: number;
}

export function tumbleweedFeature(): AmbientFeature {
  const weeds: Weed[] = [];
  let active = false;
  let nextWeedIn = 0;
  let rolled = 0;
  let seed = 71;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

  const ensureTextures = (scene: Phaser.Scene) => {
    if (scene.textures.exists(FRAMES[0])) return;
    for (const [key, pix] of [
      [FRAMES[0], PIX0],
      [FRAMES[1], PIX1],
    ] as const) {
      const g = scene.make.graphics({ x: 0, y: 0 }, false);
      pix.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          if (row[x] === ".") continue;
          g.fillStyle(row[x] === "L" ? LIGHT : DARK, 1);
          g.fillRect(x, y, 1, 1);
        }
      });
      g.generateTexture(key, 11, 11);
      g.destroy();
    }
  };

  const launch = (ctx: AmbientCtx) => {
    rolled++;
    const view = ctx.view;
    const sprite = ctx.scene.add
      .image(0, 0, FRAMES[0])
      .setScale(3) // ~1 cell across at world scale (11px art → 33px)
      .setAlpha(0.95);
    // Enter from the UPWIND edge in WORLD coords (wind is down-right, so
    // left/top), anywhere along it — its ground-y sets its depth, so weeds
    // entering low roll in front, high roll behind.
    const fromLeft = rnd() < 0.62;
    weeds.push({
      sprite,
      x: fromLeft ? view.x - 24 : view.x + rnd() * view.width,
      y: fromLeft ? view.y + rnd() * view.height : view.y - 24,
      h: 14 + rnd() * 26, // enters mid-hop
      vh: 0,
      v: 95 + rnd() * 70,
      spin: 0,
      bounce: 0.55 + rnd() * 0.2,
      flapT: 0,
      frame: 0,
    });
  };

  return {
    name: "tumbleweed",
    preferred: { time: PHASE_DAY, weather: WEATHER_CLEAR },
    weight(env) {
      // Sand-biased but not sand-locked: a weed can cross a plain, a
      // sandstorm can't. Rain soaks it to a stop.
      const dry = isRainy(env) ? 0 : 1 - 0.4 * env.mist;
      return BASE_WEIGHT * (0.25 + 0.75 * env.sand) * dry;
    },
    setActive(on) {
      active = on;
      if (on) nextWeedIn = 1200 + Math.random() * 2500; // first weed almost at once
      // off: rolling weeds finish their crossing (graceful).
    },
    init(ctx) {
      ensureTextures(ctx.scene);
    },
    update(ctx, dt) {
      if (active) {
        nextWeedIn -= dt;
        if (nextWeedIn <= 0) {
          launch(ctx);
          nextWeedIn = WEED_EVERY_MS[0] + rnd() * (WEED_EVERY_MS[1] - WEED_EVERY_MS[0]);
        }
      }
      if (!weeds.length) return;
      const view = ctx.view;
      const dts = Math.min(dt, 100) / 1000;
      for (let i = weeds.length - 1; i >= 0; i--) {
        const w = weeds[i];
        // The ground CONTACT rolls through the world on the wind heading
        // (down-right); as its world-y grows it moves toward the camera and
        // sorts to the front — real ground motion, not a screen pan.
        w.x += WX * w.v * dts;
        w.y += WY * w.v * dts;
        // Hop physics: gravity pulls the ball onto its ground line; each
        // landing keeps `bounce` of the energy plus a small fresh kick, so
        // it never quite settles — tumbleweeds jitter along.
        w.vh -= 620 * dts;
        w.h += w.vh * dts;
        if (w.h <= 0) {
          w.h = 0;
          w.vh = Math.max(60, -w.vh * w.bounce + 40 + rnd() * 60);
        }
        w.spin += (w.v * dts) / 16; // roll: arc length over radius (3× sprite)
        w.flapT += dt;
        if (w.flapT > 160) {
          // Re-scribble mid-roll — a rigid rotating ball reads as a coin.
          w.flapT = 0;
          w.frame = 1 - w.frame;
          w.sprite.setTexture(FRAMES[w.frame]);
        }
        // Drawn lifted by the hop (up-screen = smaller world-y), but SORTED
        // by the ground contact's world-y — like a jumping character, so a
        // hop never pops it in front of things it's behind.
        w.sprite
          .setPosition(w.x, w.y - w.h)
          .setDepth(w.y + 0.5)
          .setRotation(w.spin);
        // Recycle once it has rolled off the world view (+ margin).
        const M = 40;
        if (
          w.x > view.right + M || w.y > view.bottom + M ||
          w.x < view.x - M * 3 || w.y < view.y - M * 3
        ) {
          w.sprite.destroy();
          weeds.splice(i, 1);
        }
      }
    },
    debug() {
      return { active, rolling: weeds.length, rolled, nextWeedIn: active ? Math.round(nextWeedIn) : null };
    },
    dispose() {
      for (const w of weeds) w.sprite.destroy();
      weeds.length = 0;
    },
  };
}
