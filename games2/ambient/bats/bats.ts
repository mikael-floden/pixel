import Phaser from "phaser";
import { AmbientCtx, AmbientFeature, PHASE_NIGHT, WEATHER_CLEAR } from "../runtime/types";

// Bats — an EPISODE feature and the night counterpart to the birds. Like the
// birds this is a TOP-DOWN flock (maintainer 2026-07-18: bats can fly in any
// direction), but bats never LAND — they wheel and swoop through the night air:
//   • BOIDS flocking — cohesion, alignment, separation + an ERRATIC wander, so
//     the colony jinks around together in any direction over the world.
//   • They FLEE THE PLAYER — a gentle keep-your-distance while calm, and a real
//     panic SCATTER (burst away, with a cooldown) when you get close.
// Nocturnal by design: likeliness is ~1% of base during the day (maintainer's
// example, verbatim). Each bat has a ground position (gx, gy — world px in the
// iso-projected space) and a flight altitude; it draws at (gx, gy − alt).
//
// TWO-TONE, not a flat dark tint (maintainer round 1: "the bats look like
// fireflies" — a near-black bat over near-black night ground was invisible, so
// only the firefly dots read): a muted moonlit rim on the wing tops over a dark
// violet body, so the shape contrasts against dark ground. Dimmed + a bit
// smaller since (maintainer: "not as bright", "a bit smaller").
const DEPTH = 1_499_800;
const FRAMES = ["amb-bat0", "amb-bat1"];
// 9×5 / 9×4 two-colour pixel maps: P = pale moonlit rim, D = dark body.
const PIX0 = ["P.......P", "PP.....PP", ".PDD.DDP.", "...DDD...", "....D...."];
const PIX1 = [".........", "...PP.PP.", "PDDDDDDDP", ".D..D..D."];
const RIM = 0x676c81; // muted moonlight on the wing edge (dim)
const BODY = 0x161326; // dark violet body

const BASE_WEIGHT = 1.0;
const DAY_MULT = 0.01; // "1% times the base-likeliness during the day"
const FLOCK_EVERY_MS: [number, number] = [9_000, 24_000]; // gap between flocks

// Flock simulation tuning (world px, px/s) — faster and jinkier than the birds.
const FLOCK_N: [number, number] = [4, 8];
const CRUISE_ALT: [number, number] = [55, 115];
const SPD_MIN = 55;
const SPD_CRUISE = 108;
const SPD_MAX = 190;
const NEIGHBOR_R = 66;
const SEP_R = 22;
const AVOID_R = 150; // gentle keep-your-distance radius
const FLEE_R = 85; // this close → panic scatter
const W_SEP = 1.6;
const W_ALI = 0.6;
const W_COH = 0.55;
const W_WANDER = 1.0; // erratic — bats jink
const W_BOUND = 0.5;
const W_AVOID = 0.85;
const TAKEOFF_MS = 1100;
const FLUSH_COOLDOWN = 5000;
const FLOCK_LIFE: [number, number] = [20_000, 38_000]; // then the colony leaves the view

interface Bat {
  sprite: Phaser.GameObjects.Image;
  gx: number; // GROUND position in world px (the point it flies over)
  gy: number;
  alt: number; // flight altitude px above the ground
  vx: number; // ground-plane velocity (any direction)
  vy: number;
  wander: number; // wander heading (rad), random-walks
  flapMs: number;
  flapT: number;
  frame: number;
  bobPhase: number;
  t: number;
}

export function batsFeature(): AmbientFeature {
  const bats: Bat[] = [];
  let active = false;
  let nextFlockIn = 3000;
  let flocks = 0;
  let flushUntil = 0;
  let flushCooldownUntil = 0;
  let leaveAt = 0;
  let leaving = false;
  let lastNow = 0;
  let seed = 13;
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
          g.fillStyle(row[x] === "P" ? RIM : BODY, 1);
          g.fillRect(x, y, 1, 1);
        }
      });
      g.generateTexture(key, PIX0[0].length, pix.length);
      g.destroy();
    }
  };

  // Player world position (iso-projected px) via the game's myScreen probe.
  const playerAt = (ctx: AmbientCtx): { x: number; y: number } | null => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const ms = ml?.myScreen?.() as { sx: number; sy: number; zoom: number } | null | undefined;
    if (!ms || !ms.zoom) return null;
    return { x: ctx.view.x + ms.sx / ms.zoom, y: ctx.view.y + ms.sy / ms.zoom };
  };

  const launchFlock = (ctx: AmbientCtx) => {
    flocks++;
    const view = ctx.view;
    const n = FLOCK_N[0] + Math.floor(rnd() * (FLOCK_N[1] - FLOCK_N[0] + 1));
    const edge = Math.floor(rnd() * 4);
    const ex = edge === 0 ? view.x - 40 : edge === 1 ? view.right + 40 : view.x + rnd() * view.width;
    const ey = edge === 2 ? view.y - 40 : edge === 3 ? view.bottom + 40 : view.y + rnd() * view.height;
    const inx = view.centerX - ex;
    const iny = view.centerY - ey;
    const inl = Math.hypot(inx, iny) || 1;
    for (let i = 0; i < n; i++) {
      const sprite = ctx.scene.add
        .image(0, 0, FRAMES[0])
        .setDepth(DEPTH + i * 0.001)
        .setAlpha(0.8) // dim / soft, not a bright cut-out
        .setScale(1.5) // a bit smaller (maintainer 2026-07-18)
        .setFlipX(inx < 0);
      bats.push({
        sprite,
        gx: ex + (rnd() - 0.5) * 44,
        gy: ey + (rnd() - 0.5) * 44,
        alt: CRUISE_ALT[0] + rnd() * (CRUISE_ALT[1] - CRUISE_ALT[0]),
        vx: (inx / inl) * SPD_CRUISE,
        vy: (iny / inl) * SPD_CRUISE,
        wander: rnd() * Math.PI * 2,
        flapMs: 60 + rnd() * 55, // fast wingbeat
        flapT: rnd() * 100,
        frame: 0,
        bobPhase: rnd() * Math.PI * 2,
        t: rnd() * 5,
      });
    }
    leaveAt = ctx.scene.time.now + FLOCK_LIFE[0] + rnd() * (FLOCK_LIFE[1] - FLOCK_LIFE[0]);
    leaving = false;
    flushUntil = 0;
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
      if (on) nextFlockIn = 1200 + Math.random() * 2000; // first flock almost at once
      // off: no new flocks; in-flight bats finish and leave (graceful).
    },
    init(ctx) {
      ensureTextures(ctx.scene);
    },
    update(ctx, dt) {
      const dts = Math.min(dt, 100) / 1000;
      const now = ctx.scene.time.now;
      lastNow = now;
      // One flock at a time: only count down to the next once the sky is clear.
      if (active && !bats.length) {
        nextFlockIn -= dt;
        if (nextFlockIn <= 0) {
          launchFlock(ctx);
          nextFlockIn = FLOCK_EVERY_MS[0] + rnd() * (FLOCK_EVERY_MS[1] - FLOCK_EVERY_MS[0]);
        }
      }
      if (!bats.length) return;

      // Time to move on: the colony heads off the nearest edge and disperses.
      if (!leaving && now >= leaveAt) leaving = true;

      const view = ctx.view;
      const player = playerAt(ctx);

      // FLUSH: player gets within FLEE_R → panic scatter away, with a cooldown
      // so it doesn't re-trigger every frame while you stand near.
      if (flushUntil <= now && now >= flushCooldownUntil && player) {
        let nearest = Infinity;
        for (const b of bats) nearest = Math.min(nearest, Math.hypot(player.x - b.gx, player.y - b.gy));
        if (nearest < FLEE_R) {
          flushUntil = now + TAKEOFF_MS;
          flushCooldownUntil = now + TAKEOFF_MS + FLUSH_COOLDOWN;
          for (const b of bats) {
            const dx = b.gx - player.x;
            const dy = b.gy - player.y;
            const d = Math.hypot(dx, dy) || 1;
            b.vx = (dx / d) * SPD_MAX;
            b.vy = (dy / d) * SPD_MAX;
          }
        }
      }
      const flushing = flushUntil > now;

      for (let i = bats.length - 1; i >= 0; i--) {
        const b = bats[i];
        b.t += dts;
        let ax = 0;
        let ay = 0;

        // Boids over near neighbours.
        let sepx = 0;
        let sepy = 0;
        let alix = 0;
        let aliy = 0;
        let cohx = 0;
        let cohy = 0;
        let nn = 0;
        for (const o of bats) {
          if (o === b) continue;
          const dx = o.gx - b.gx;
          const dy = o.gy - b.gy;
          const d = Math.hypot(dx, dy);
          if (d > NEIGHBOR_R) continue;
          nn++;
          alix += o.vx;
          aliy += o.vy;
          cohx += o.gx;
          cohy += o.gy;
          if (d < SEP_R && d > 0) {
            sepx -= dx / d;
            sepy -= dy / d;
          }
        }
        if (nn > 0) {
          ax += sepx * W_SEP * SPD_CRUISE;
          ay += sepy * W_SEP * SPD_CRUISE;
          ax += (alix / nn - b.vx) * W_ALI;
          ay += (aliy / nn - b.vy) * W_ALI;
          ax += (cohx / nn - b.gx) * W_COH;
          ay += (cohy / nn - b.gy) * W_COH;
        }
        // Erratic wander.
        b.wander += (rnd() - 0.5) * 3.2 * dts * 3;
        ax += Math.cos(b.wander) * W_WANDER * SPD_CRUISE;
        ay += Math.sin(b.wander) * W_WANDER * SPD_CRUISE;

        if (leaving) {
          // Disperse: steer OUT toward the nearest edge and go.
          const dl = b.gx - view.x;
          const dr = view.right - b.gx;
          const dtp = b.gy - view.y;
          const dbt = view.bottom - b.gy;
          const m = Math.min(dl, dr, dtp, dbt);
          if (m === dl) ax -= SPD_CRUISE;
          else if (m === dr) ax += SPD_CRUISE;
          else if (m === dtp) ay -= SPD_CRUISE;
          else ay += SPD_CRUISE;
        } else {
          // Soft containment.
          const mx = view.width * 0.12;
          const my = view.height * 0.12;
          if (b.gx < view.x + mx) ax += (view.x + mx - b.gx) * W_BOUND;
          else if (b.gx > view.right - mx) ax += (view.right - mx - b.gx) * W_BOUND;
          if (b.gy < view.y + my) ay += (view.y + my - b.gy) * W_BOUND;
          else if (b.gy > view.bottom - my) ay += (view.bottom - my - b.gy) * W_BOUND;
          // Gentle keep-your-distance from the player.
          if (player) {
            const dx = b.gx - player.x;
            const dy = b.gy - player.y;
            const d = Math.hypot(dx, dy);
            if (d < AVOID_R && d > 0) {
              const push = (1 - d / AVOID_R) * W_AVOID * SPD_CRUISE;
              ax += (dx / d) * push;
              ay += (dy / d) * push;
            }
          }
        }

        // Integrate + clamp speed (bats keep moving in the air).
        b.vx += ax * dts;
        b.vy += ay * dts;
        let sp = Math.hypot(b.vx, b.vy);
        if (sp > SPD_MAX) {
          b.vx = (b.vx / sp) * SPD_MAX;
          b.vy = (b.vy / sp) * SPD_MAX;
          sp = SPD_MAX;
        } else if (sp < SPD_MIN && sp > 0) {
          b.vx = (b.vx / sp) * SPD_MIN;
          b.vy = (b.vy / sp) * SPD_MIN;
        }
        b.gx += b.vx * dts;
        b.gy += b.vy * dts;

        // Flap + face + draw (a quick bob).
        b.flapT += dt;
        if (b.flapT >= b.flapMs) {
          b.flapT -= b.flapMs;
          b.frame = 1 - b.frame;
          b.sprite.setTexture(FRAMES[b.frame]);
        }
        if (Math.abs(b.vx) > 4) b.sprite.setFlipX(b.vx < 0);
        const bob = Math.sin(b.t * 7 + b.bobPhase) * 2.5;
        b.sprite.setPosition(b.gx, b.gy - b.alt + bob).setDepth(DEPTH + i * 0.001);

        // Off the view (plus slack)?
        const off =
          b.gx < view.x - 120 || b.gx > view.right + 120 || b.gy < view.y - 120 || b.gy > view.bottom + 120;
        if (off) {
          if (leaving) {
            b.sprite.destroy();
            bats.splice(i, 1);
            continue;
          }
          if (!flushing) {
            // Stray wanderer re-enters at an edge, heading inward.
            const edge = Math.floor(rnd() * 4);
            b.gx = edge === 0 ? view.x - 30 : edge === 1 ? view.right + 30 : view.x + rnd() * view.width;
            b.gy = edge === 2 ? view.y - 30 : edge === 3 ? view.bottom + 30 : view.y + rnd() * view.height;
            const inx = view.centerX - b.gx;
            const iny = view.centerY - b.gy;
            const l = Math.hypot(inx, iny) || 1;
            b.vx = (inx / l) * SPD_CRUISE;
            b.vy = (iny / l) * SPD_CRUISE;
          }
        }
      }
    },
    debug() {
      return { active, inFlight: bats.length, flocks, flushing: flushUntil > lastNow, leaving };
    },
    dispose() {
      for (const b of bats) b.sprite.destroy();
      bats.length = 0;
    },
  };
}
