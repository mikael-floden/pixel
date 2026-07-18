import Phaser from "phaser";
import { AmbientCtx, AmbientFeature, PHASE_DAY, WEATHER_CLEAR } from "../runtime/types";

// Birds — an EPISODE feature and the DAYTIME counterpart to bats (maintainer
// 2026-07-18: "an effect similar to the bats, but birds!"). While the director
// has us active, a loose skein of birds crosses the sky in a rough V, wings
// flapping. Diurnal by design: the likeliness is the mirror of the bats' —
// full through the sunlit hours, ~5% of that at night (the odd owl).
//
// The birds are hand-pixelled 2-frame silhouettes: a shallow "V" on the
// up-stroke and an inverted "V" on the down-stroke — the universal distant-bird
// mark. Two-tone but the INVERSE of the bats: a PALE gull-grey body with darker
// wingtips. This game is isometric ground — there is no bright sky band, so a
// dark bird would vanish against the terrain exactly the way the early all-dark
// bats did ("looked like fireflies"). A light body reads over dark ground and
// water; the dark tips read over bright sand — the shape survives everywhere,
// and pale birds distinguish cleanly from the dark bats.
//
// THEY FLY HIGH IN Z, NOT HIGH IN SCREEN SPACE (maintainer 2026-07-18). Each
// bird is anchored to a GROUND position in the world (gx, gy — world px in the
// game's iso-projected space) and lifted by an ALTITUDE in px: the sprite draws
// at (gx, gy − alt). Elevation subtracts from the projected y exactly the way a
// raised tile does (y = … − level·levelHeight), so the flock genuinely soars
// above the terrain it crosses and scrolls/parallaxes with the world as the
// camera moves — instead of being pinned to a strip at the top of the screen.
// Per-bird flap rates, bobbing and a jittered V so the flock reads as animals
// migrating, not a rigid formation. Drawn in the sky band (above the world +
// darkness overlay, below shooting stars).
const DEPTH = 1_499_805;
const FRAMES = ["amb-bird0", "amb-bird1"];
// 7×3 two-colour pixel maps: P = dark wingtip accent, D = pale body.
// Up-stroke — wings raised (a shallow "V", tips high):
const PIX0 = [
  "P.....P",
  ".D...D.",
  "..DDD..",
];
// Down-stroke — wings lowered (inverted "V", tips low):
const PIX1 = [
  "..DDD..",
  ".D...D.",
  "P.....P",
];
const TIP = 0x4a4854; // dark wingtip accent (reads over bright sand)
const BODY = 0xbfc2cd; // pale gull-grey body (reads over dark ground/water)
const BASE_WEIGHT = 1.0;
const NIGHT_MULT = 0.05; // ~5% as likely at night (the mirror of the bats' day cut)
// Dense enough that an active episode never shows a long empty sky.
const FLOCK_EVERY_MS: [number, number] = [10_000, 26_000];

interface Bird {
  sprite: Phaser.GameObjects.Image;
  gx: number; // GROUND anchor x in world px (the point on the map it flies over)
  gy: number; // GROUND anchor y in world px
  alt: number; // altitude in px lifted above the ground anchor (high in Z)
  vx: number;
  vy: number;
  flapMs: number; // per-bird flap period
  flapT: number;
  frame: number;
  bobF: number;
  bobA: number;
  t: number;
}

export function birdsFeature(): AmbientFeature {
  const birds: Bird[] = [];
  let active = false;
  let nextFlockIn = 3000; // first flock shortly after activation
  let flocks = 0;
  let seed = 29;
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
          g.fillStyle(row[x] === "P" ? TIP : BODY, 1);
          g.fillRect(x, y, 1, 1);
        }
      });
      g.generateTexture(key, PIX0[0].length, pix.length);
      g.destroy();
    }
  };

  const launchFlock = (ctx: AmbientCtx) => {
    flocks++;
    const view = ctx.view;
    const n = 4 + Math.floor(rnd() * 6); // 4..9 — bigger, looser than a bat flock
    const ltr = rnd() < 0.5;
    const dir = ltr ? 1 : -1;
    const speed = 110 + rnd() * 60; // a touch faster than bats
    // High in Z: the flock rides a big ALTITUDE above a GROUND anchor. Choose a
    // visible upper-sky screen height first, then set the ground anchor that far
    // below it PLUS the altitude — so the birds are genuinely elevated over the
    // world (they parallax with it, like anything raised in Z) yet always framed
    // in the sky, whatever the zoom. Altitude scales with the view so the framing
    // holds on phone (zoom 1) and desktop (zoom 2) alike.
    const alt = view.height * (0.5 + rnd() * 0.3); // one altitude for the flock
    const renderY = view.y + view.height * (0.05 + rnd() * 0.18); // upper-sky band
    const baseGY = renderY + alt; // ground point the flock soars over (may sit below the view)
    const leadX = ltr ? view.x - 30 : view.right + 30;
    // Rough V/skein: rank 0 leads, the rest fan out behind on alternating
    // sides, each with a little jitter so the formation reads as live birds.
    const along = 20 + rnd() * 8; // spacing back along the travel axis
    const perp = 13 + rnd() * 6; // spread to the sides
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const rank = Math.ceil(i / 2);
      const jx = (rnd() - 0.5) * 10;
      const jy = (rnd() - 0.5) * 8;
      const sprite = ctx.scene.add
        .image(0, 0, FRAMES[0])
        .setDepth(DEPTH + i * 0.001)
        .setAlpha(0.85)
        .setScale(1.5) // small distant birds; nearest-filtered
        .setFlipX(!ltr);
      birds.push({
        sprite,
        gx: leadX - dir * rank * along + jx,
        gy: baseGY + side * rank * perp + jy,
        alt: alt + (rnd() - 0.5) * 14, // slight per-bird altitude jitter
        vx: dir * speed * (0.97 + rnd() * 0.06), // near-uniform so the V holds
        vy: (rnd() - 0.5) * 5,
        flapMs: 130 + rnd() * 120, // slower wingbeat than the bats
        flapT: rnd() * 200,
        frame: 0,
        bobF: 2 + rnd() * 3,
        bobA: 1.5 + rnd() * 3,
        t: rnd() * 5,
      });
    }
  };

  return {
    name: "birds",
    preferred: { time: PHASE_DAY, weather: WEATHER_CLEAR },
    weight(env) {
      // Mirror of the bats: full by day (sun ×1), ~5% at night.
      return BASE_WEIGHT * (NIGHT_MULT + (1 - NIGHT_MULT) * env.sun);
    },
    setActive(on) {
      active = on;
      if (on) nextFlockIn = 1200 + Math.random() * 2000; // first flock almost at once
      // off: no new flocks; in-flight birds finish their crossing (graceful).
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
      if (!birds.length) return;
      const view = ctx.view;
      for (let i = birds.length - 1; i >= 0; i--) {
        const b = birds[i];
        b.t += dts;
        b.gx += b.vx * dts;
        b.gy += b.vy * dts;
        b.flapT += dt;
        if (b.flapT >= b.flapMs) {
          b.flapT -= b.flapMs;
          b.frame = 1 - b.frame;
          b.sprite.setTexture(FRAMES[b.frame]);
        }
        // Draw the ground anchor lifted by its altitude (high in Z) + a bob.
        b.sprite.setPosition(b.gx, b.gy - b.alt + Math.sin(b.t * b.bobF) * b.bobA);
        // Crossed out of the view (plus slack)? The bird is done.
        if ((b.vx > 0 && b.gx > view.right + 60) || (b.vx < 0 && b.gx < view.x - 60)) {
          b.sprite.destroy();
          birds.splice(i, 1);
        }
      }
    },
    debug() {
      return { active, inFlight: birds.length, flocks, nextFlockIn: active ? Math.round(nextFlockIn) : null };
    },
    dispose() {
      for (const b of birds) b.sprite.destroy();
      birds.length = 0;
    },
  };
}
