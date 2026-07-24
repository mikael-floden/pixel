import Phaser from "phaser";
import { AmbientCtx, AmbientFeature, PHASE_DAY, WEATHER_CLEAR } from "../runtime/types";
import { FLY_FRAMES, SheetSpec, dirFromVel, dirGap, queueSheets, sheetsReady } from "../runtime/critters";
// 8 hand-made PixelLab bird TYPES, each an 8-direction object with a flapping
// fly animation and a still base (for perching). Packed one folder per type.
import bird1Fly from "./art/bird1/fly.png";
import bird1Still from "./art/bird1/still.png";
import bird2Fly from "./art/bird2/fly.png";
import bird2Still from "./art/bird2/still.png";
import bird3Fly from "./art/bird3/fly.png";
import bird3Still from "./art/bird3/still.png";
import bird4Fly from "./art/bird4/fly.png";
import bird4Still from "./art/bird4/still.png";
import bird5Fly from "./art/bird5/fly.png";
import bird5Still from "./art/bird5/still.png";
import bird6Fly from "./art/bird6/fly.png";
import bird6Still from "./art/bird6/still.png";
import bird7Fly from "./art/bird7/fly.png";
import bird7Still from "./art/bird7/still.png";
import bird8Fly from "./art/bird8/fly.png";
import bird8Still from "./art/bird8/still.png";

// Birds — an EPISODE feature and the DAYTIME counterpart to bats. This is a
// TOP-DOWN world (maintainer 2026-07-18: "stop thinking as if this is a
// platformer"), so a flock is a little living SIMULATION over the ground, not a
// sprite crossing the screen:
//   • BOIDS flocking — cohesion, alignment, separation + a wander drift, so the
//     birds move together in any direction over the terrain and the shape of
//     the flock keeps changing.
//   • They LAND. A wandering flock every so often settles onto the ground
//     (never onto water — checked through the surface probe), pecks around for a
//     while, then lifts off again. A landed bird shows its STILL base sprite;
//     an airborne one flaps.
//   • They FLEE THE PLAYER. Walk close to the flock — in the air or on the
//     ground — and the whole flock FLUSHES: it takes off and scatters away from
//     you (the classic "spook the pigeons" beat).
// Altitude is real (high in Z): each bird has a ground position (gx, gy — world
// px in the iso-projected space) and an altitude lifted above it; it draws at
// (gx, gy − alt). The art is the maintainer's hand-made PixelLab set — 8 bird
// TYPES, each with 8 rotations + a flap clip — rendered as a real directional
// sprite (facing derived from the boid's velocity). Drawn in the sky band,
// above the world + darkness overlay.
const DEPTH = 1_499_805;
const TYPES = 8;
const flyKey = (t: number) => `amb-bird${t}-fly`;
const stillKey = (t: number) => `amb-bird${t}-still`;
const FLY_URLS = [bird1Fly, bird2Fly, bird3Fly, bird4Fly, bird5Fly, bird6Fly, bird7Fly, bird8Fly];
const STILL_URLS = [bird1Still, bird2Still, bird3Still, bird4Still, bird5Still, bird6Still, bird7Still, bird8Still];
const SHEETS: SheetSpec[] = FLY_URLS.flatMap((url, t) => [
  { key: flyKey(t), url },
  { key: stillKey(t), url: STILL_URLS[t] },
]);
const BIRD_SCALE = 0.6; // 34px art → a small-but-readable bird in the flock
const BIRD_ALPHA = 0.95;
const DIR_STICK = 110; // ms an adjacent-sector heading flip must hold before the sprite turns

const BASE_WEIGHT = 1.0;
const NIGHT_MULT = 0.05; // ~5% as likely at night (the mirror of the bats' day cut)
const FLOCK_EVERY_MS: [number, number] = [10_000, 26_000]; // gap between flocks

// Flock simulation tuning (world px, px/s).
const FLOCK_N: [number, number] = [5, 9];
const CRUISE_ALT: [number, number] = [70, 120]; // flying altitude band
const SPD_MIN = 42;
const SPD_CRUISE = 92;
const SPD_MAX = 155;
const NEIGHBOR_R = 74; // boids neighbourhood
const SEP_R = 24; // personal space
// Two tiers of player wariness: a GENTLE avoidance keeps a loose distance
// while calm, and a close approach PANICS the whole flock into a scatter.
const AVOID_R = 190; // gentle steer-away radius
const FLEE_R = 92; // this close → panic flush
const W_SEP = 1.7;
const W_ALI = 0.65;
const W_COH = 0.6;
const W_WANDER = 0.5;
const W_BOUND = 0.5; // soft pull back toward the visible area
const W_AVOID = 0.9; // gentle keep-your-distance steer
const LAND_REST: [number, number] = [4500, 10_000]; // time perched before lift-off
const SETTLE_AFTER: [number, number] = [7_000, 15_000]; // wandering time before trying to land
const TAKEOFF_MS = 1400; // flush / lift-off climb duration
const FLUSH_COOLDOWN = 6000; // after a scatter, stay calm this long (no re-panic)
const FLOCK_LIFE: [number, number] = [34_000, 58_000]; // then the flock departs the view
const LAND_CLEAR = FLEE_R * 1.9; // only settle when the flock is this far from the player

const FLYING = 0;
const LANDING = 1;
const LANDED = 2;
const TAKEOFF = 3;

interface Bird {
  sprite: Phaser.GameObjects.Sprite;
  type: number; // which of the 8 bird designs
  gx: number; // GROUND position in world px (the point on the map it is over)
  gy: number;
  alt: number; // altitude px above the ground
  vx: number; // ground-plane velocity (any direction — top-down)
  vy: number;
  state: number;
  tx: number; // personal landing/target spot
  ty: number;
  cruise: number; // this bird's flying altitude
  wander: number; // wander heading (rad), random-walks
  dir: number; // current facing (PixelLab index 0..7), hysteretic
  dirHoldT: number; // ms an adjacent new heading has persisted
  flapMs: number; // ms per flap frame
  flapT: number;
  frame: number; // flap frame 0..FLY_FRAMES-1
  bobPhase: number;
  t: number;
}

export function birdsFeature(): AmbientFeature {
  const birds: Bird[] = [];
  let active = false;
  let ready = false; // fly/still spritesheets loaded (runtime load, see init)
  let nextFlockIn = 3000;
  let flocks = 0;
  // Flock-level timers (ms clock in scene.time.now).
  let settleAt = 0; // when a wandering flock will try to land
  let groundUntil = 0; // when a landed flock lifts off
  let flushUntil = 0; // >now → the flock is fleeing the player
  let flushCooldownUntil = 0; // no fresh panic before this (avoids perpetual flushing)
  let leaveAt = 0; // when the current flock heads off the view for good
  let leaving = false; // flock is exiting — fly to the nearest edge and go
  let landCx = 0;
  let landCy = 0;
  let lastNow = 0; // last scene clock seen (for debug())
  let seed = 29;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

  // Player's world position (iso-projected px) via the game's myScreen probe.
  const playerAt = (ctx: AmbientCtx): { x: number; y: number } | null => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const ms = ml?.myScreen?.() as { sx: number; sy: number; zoom: number } | null | undefined;
    if (!ms || !ms.zoom) return null;
    return { x: ctx.view.x + ms.sx / ms.zoom, y: ctx.view.y + ms.sy / ms.zoom };
  };

  // Is this world point standable ground (not water)? Reuses the surface probe
  // the way env.ts samples sand — world → screen → pickAt (flat grid) → surfaceAt.
  const isGround = (ctx: AmbientCtx, wx: number, wy: number): boolean => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const pick = ml?.pickAt as undefined | ((x: number, y: number) => { x: number; y: number } | null);
    const at = ml?.surfaceAt as undefined | ((x: number, y: number) => { sound?: string } | null);
    if (!pick || !at) return true; // no probe → don't block landing
    const p = pick((wx - ctx.view.x) * ctx.zoom, (wy - ctx.view.y) * ctx.zoom);
    if (!p) return true;
    const s = at(p.x, p.y);
    return !s || s.sound !== "water";
  };

  // Show the right frame: the flap clip while airborne, the still base perched.
  const drawFrame = (b: Bird, perched: boolean) => {
    const key = perched ? stillKey(b.type) : flyKey(b.type);
    if (b.sprite.texture.key !== key) b.sprite.setTexture(key);
    b.sprite.setFrame(perched ? b.dir : b.dir * FLY_FRAMES + b.frame);
  };

  const launchFlock = (ctx: AmbientCtx) => {
    flocks++;
    const view = ctx.view;
    const n = FLOCK_N[0] + Math.floor(rnd() * (FLOCK_N[1] - FLOCK_N[0] + 1));
    // Enter clustered from a random edge, heading roughly into the view.
    const edge = Math.floor(rnd() * 4);
    const ex = edge === 0 ? view.x - 40 : edge === 1 ? view.right + 40 : view.x + rnd() * view.width;
    const ey = edge === 2 ? view.y - 40 : edge === 3 ? view.bottom + 40 : view.y + rnd() * view.height;
    const inx = view.centerX - ex;
    const iny = view.centerY - ey;
    const inl = Math.hypot(inx, iny) || 1;
    const dirx = inx / inl;
    const diry = iny / inl;
    const dir0 = dirFromVel(dirx, diry) ?? 0;
    for (let i = 0; i < n; i++) {
      const type = Math.floor(rnd() * TYPES);
      const sprite = ctx.scene.add
        .sprite(0, 0, flyKey(type), dir0 * FLY_FRAMES)
        .setDepth(DEPTH + i * 0.001)
        .setAlpha(BIRD_ALPHA)
        .setScale(BIRD_SCALE);
      birds.push({
        sprite,
        type,
        gx: ex + (rnd() - 0.5) * 40,
        gy: ey + (rnd() - 0.5) * 40,
        alt: CRUISE_ALT[0] + rnd() * (CRUISE_ALT[1] - CRUISE_ALT[0]),
        vx: dirx * SPD_CRUISE,
        vy: diry * SPD_CRUISE,
        state: FLYING,
        tx: 0,
        ty: 0,
        cruise: CRUISE_ALT[0] + rnd() * (CRUISE_ALT[1] - CRUISE_ALT[0]),
        wander: rnd() * Math.PI * 2,
        dir: dir0,
        dirHoldT: 0,
        flapMs: 30 + rnd() * 12, // per-frame; 16 frames ≈ 0.5-0.7s wingbeat
        flapT: rnd() * 200,
        frame: Math.floor(rnd() * FLY_FRAMES), // desync the flock's wingbeats
        bobPhase: rnd() * Math.PI * 2,
        t: rnd() * 5,
      });
    }
    settleAt = ctx.scene.time.now + SETTLE_AFTER[0] + rnd() * (SETTLE_AFTER[1] - SETTLE_AFTER[0]);
    groundUntil = 0;
    flushUntil = 0;
    leaveAt = ctx.scene.time.now + FLOCK_LIFE[0] + rnd() * (FLOCK_LIFE[1] - FLOCK_LIFE[0]);
    leaving = false;
  };

  const recycle = (ctx: AmbientCtx, b: Bird) => {
    // Strayed far outside the view: re-enter as a fresh wanderer at an edge.
    const view = ctx.view;
    const edge = Math.floor(rnd() * 4);
    b.gx = edge === 0 ? view.x - 30 : edge === 1 ? view.right + 30 : view.x + rnd() * view.width;
    b.gy = edge === 2 ? view.y - 30 : edge === 3 ? view.bottom + 30 : view.y + rnd() * view.height;
    const inx = view.centerX - b.gx;
    const iny = view.centerY - b.gy;
    const l = Math.hypot(inx, iny) || 1;
    b.vx = (inx / l) * SPD_CRUISE;
    b.vy = (iny / l) * SPD_CRUISE;
    b.alt = b.cruise;
    b.state = FLYING;
    b.dir = dirFromVel(b.vx, b.vy) ?? b.dir;
  };

  return {
    name: "birds",
    preferred: { time: PHASE_DAY, weather: WEATHER_CLEAR },
    conflicts: ["bats"], // day vs night sky creatures — never both
    weight(env) {
      return BASE_WEIGHT * (NIGHT_MULT + (1 - NIGHT_MULT) * env.sun);
    },
    setActive(on) {
      active = on;
      if (on) nextFlockIn = 1200 + Math.random() * 2000;
    },
    init(ctx) {
      queueSheets(ctx.scene, SHEETS); // runtime-load the PixelLab art (see critters.ts)
    },
    update(ctx, dt) {
      // The art loads asynchronously after the scene is live — idle until ready
      // (so a flock never launches without its sprites). Cheap existence poll.
      if (!ready) {
        ready = sheetsReady(ctx.scene, SHEETS);
        if (!ready) return;
      }
      const dts = Math.min(dt, 100) / 1000;
      const now = ctx.scene.time.now;
      lastNow = now;
      // One flock at a time: only count down to the next once the sky is clear
      // (a departed flock destroys its birds), so birds never pile up.
      if (active && !birds.length) {
        nextFlockIn -= dt;
        if (nextFlockIn <= 0) {
          launchFlock(ctx);
          nextFlockIn = FLOCK_EVERY_MS[0] + rnd() * (FLOCK_EVERY_MS[1] - FLOCK_EVERY_MS[0]);
        }
      }
      if (!birds.length) return;

      // Time to move on: the flock climbs and heads off the nearest edge.
      if (!leaving && now >= leaveAt) {
        leaving = true;
        groundUntil = 0;
        for (const b of birds) if (b.state !== FLYING) b.state = TAKEOFF;
      }

      const view = ctx.view;
      const player = playerAt(ctx);

      // ---- flock-level decisions ---------------------------------------
      // FLUSH: player gets CLOSE (within FLEE_R of any bird) → the whole flock
      // panics, takes off and scatters AWAY from you with a real outward impulse
      // (landed or flying, doesn't matter — you spooked them). A cooldown after
      // keeps them from re-panicking every frame while you stand near.
      if (flushUntil <= now && now >= flushCooldownUntil && player) {
        let nearest = Infinity;
        for (const b of birds) nearest = Math.min(nearest, Math.hypot(player.x - b.gx, player.y - b.gy));
        if (nearest < FLEE_R) {
          flushUntil = now + TAKEOFF_MS;
          flushCooldownUntil = now + TAKEOFF_MS + FLUSH_COOLDOWN;
          groundUntil = 0;
          settleAt = now + SETTLE_AFTER[0] + rnd() * (SETTLE_AFTER[1] - SETTLE_AFTER[0]);
          for (const b of birds) {
            const dx = b.gx - player.x;
            const dy = b.gy - player.y;
            const d = Math.hypot(dx, dy) || 1;
            b.vx = (dx / d) * SPD_MAX; // burst away from the player
            b.vy = (dy / d) * SPD_MAX;
            if (b.state !== FLYING) b.state = TAKEOFF;
          }
        }
      }
      const flushing = flushUntil > now;

      // SETTLE: a calm flock picks a dry clearing somewhere in view, well AWAY
      // from the player, and flies over to land there. Choosing the zone far
      // from you means the descent (which starts from the flock's loose ring
      // around you, already outside FLEE_R) heads outward — it doesn't try to
      // land in your lap and flush on the spot.
      const allFlying = birds.every((b) => b.state === FLYING);
      if (!flushing && !leaving && allFlying && now >= settleAt && groundUntil === 0) {
        const px = player ? player.x : view.centerX;
        const py = player ? player.y : view.centerY;
        let found = false;
        for (let tries = 0; tries < 14 && !found; tries++) {
          const lx = view.x + 40 + rnd() * (view.width - 80);
          const ly = view.y + 40 + rnd() * (view.height - 80);
          if (Math.hypot(lx - px, ly - py) < LAND_CLEAR) continue; // too close to the player
          if (isGround(ctx, lx, ly)) {
            landCx = lx;
            landCy = ly;
            found = true;
          }
        }
        if (found) {
          for (const b of birds) {
            b.state = LANDING;
            b.tx = landCx + (rnd() - 0.5) * 70; // personal spot around the centre
            b.ty = landCy + (rnd() - 0.5) * 70;
          }
        } else {
          settleAt = now + 3000; // no dry clearing right here — try again shortly
        }
      }

      // LIFT-OFF: perched flock's rest elapsed → everyone takes off.
      if (groundUntil > 0 && now >= groundUntil) {
        groundUntil = 0;
        settleAt = now + SETTLE_AFTER[0] + rnd() * (SETTLE_AFTER[1] - SETTLE_AFTER[0]);
        for (const b of birds) if (b.state === LANDED || b.state === LANDING) b.state = TAKEOFF;
      }

      // Once MOST of the flock is down, start the rest clock (a straggler or
      // two can still be gliding in — they touch down during the rest, and the
      // whole flock lifts off together when it ends).
      if (groundUntil === 0 && !flushing && !leaving && birds.length) {
        const down = birds.filter((b) => b.state === LANDED).length;
        const landingPhase = birds.every((b) => b.state === LANDED || b.state === LANDING);
        if (landingPhase && down >= Math.ceil(birds.length * 0.6)) {
          groundUntil = now + LAND_REST[0] + rnd() * (LAND_REST[1] - LAND_REST[0]);
        }
      }

      // ---- per-bird motion ---------------------------------------------
      for (let i = birds.length - 1; i >= 0; i--) {
        const b = birds[i];
        b.t += dts;

        if (b.state === LANDED && !flushing) {
          // Perched: sit still with the odd tiny hop; hold the still base sprite
          // (facing whichever way it landed — vx is ~0 now, so keep b.dir).
          b.vx *= 0.8;
          b.vy *= 0.8;
          b.gx += b.vx * dts;
          b.gy += b.vy * dts;
          if (rnd() < 0.01) {
            b.vx = (rnd() - 0.5) * 24;
            b.vy = (rnd() - 0.5) * 24;
          }
          b.alt += (0 - b.alt) * Math.min(1, dts * 8);
          drawFrame(b, true);
          b.sprite.setPosition(b.gx, b.gy - b.alt).setDepth(DEPTH + i * 0.001);
          continue;
        }

        // Steering accumulators.
        let ax = 0;
        let ay = 0;

        if (b.state === LANDING) {
          // Glide to the personal spot with ARRIVAL damping (steer toward a
          // desired velocity that shrinks to 0 at the spot) so the bird slows
          // and settles instead of orbiting; drop altitude as it closes in.
          const dx = b.tx - b.gx;
          const dy = b.ty - b.gy;
          const d = Math.hypot(dx, dy) || 0.001;
          const SLOW = 45; // start braking within this radius
          const desired = d > SLOW ? SPD_CRUISE : SPD_CRUISE * (d / SLOW);
          ax += ((dx / d) * desired - b.vx) * 4;
          ay += ((dy / d) * desired - b.vy) * 4;
          const targetAlt = Math.min(b.cruise, d * 0.35); // lower as we approach
          b.alt += (targetAlt - b.alt) * Math.min(1, dts * 4);
          if (d < 12 && b.alt < 8) {
            b.state = LANDED;
            b.alt = 0;
            b.vx *= 0.3;
            b.vy *= 0.3;
          }
        } else {
          // FLYING or TAKEOFF: boids + wander (+ flee, + climb on takeoff).
          let sepx = 0;
          let sepy = 0;
          let alix = 0;
          let aliy = 0;
          let cohx = 0;
          let cohy = 0;
          let nn = 0;
          for (const o of birds) {
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
          // Wander: a slowly turning heading nudges the flock's drift.
          b.wander += (rnd() - 0.5) * 2.2 * dts * 3;
          ax += Math.cos(b.wander) * W_WANDER * SPD_CRUISE;
          ay += Math.sin(b.wander) * W_WANDER * SPD_CRUISE;
          if (leaving) {
            // Departing: steer OUT toward the nearest edge and go.
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
            // Soft boundary: stay near the visible area.
            const mx = view.width * 0.12;
            const my = view.height * 0.12;
            if (b.gx < view.x + mx) ax += (view.x + mx - b.gx) * W_BOUND;
            else if (b.gx > view.right - mx) ax += (view.right - mx - b.gx) * W_BOUND;
            if (b.gy < view.y + my) ay += (view.y + my - b.gy) * W_BOUND;
            else if (b.gy > view.bottom - my) ay += (view.bottom - my - b.gy) * W_BOUND;
          }
          // Gentle avoidance: keep a loose distance from the player (the real
          // panic-scatter is the flock-level FLUSH above; this just stops them
          // drifting right onto you between flushes).
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
          // Airborne: ease toward this bird's cruise altitude — fast on a
          // takeoff/flush climb, gently while already cruising.
          b.alt += (b.cruise - b.alt) * Math.min(1, dts * (b.state === TAKEOFF ? 4 : 1.5));
          if (b.state === TAKEOFF && b.alt > b.cruise - 8) b.state = FLYING;
        }

        // Integrate velocity, clamp speed (birds always keep moving in air).
        b.vx += ax * dts;
        b.vy += ay * dts;
        let sp = Math.hypot(b.vx, b.vy);
        const minS = b.state === LANDING ? 0 : SPD_MIN;
        if (sp > SPD_MAX) {
          b.vx = (b.vx / sp) * SPD_MAX;
          b.vy = (b.vy / sp) * SPD_MAX;
          sp = SPD_MAX;
        } else if (sp < minS && sp > 0) {
          b.vx = (b.vx / sp) * minS;
          b.vy = (b.vy / sp) * minS;
        }
        b.gx += b.vx * dts;
        b.gy += b.vy * dts;

        // Face (hysteretic 8-way from the boid's velocity) + flap + draw
        // (a gentle bob only while airborne).
        const cand = dirFromVel(b.vx, b.vy);
        if (cand !== null && cand !== b.dir) {
          if (dirGap(cand, b.dir) >= 2) {
            b.dir = cand; // a real turn — snap immediately
            b.dirHoldT = 0;
          } else {
            b.dirHoldT += dt; // an adjacent flip — only turn if it persists
            if (b.dirHoldT >= DIR_STICK) {
              b.dir = cand;
              b.dirHoldT = 0;
            }
          }
        } else {
          b.dirHoldT = 0;
        }
        b.flapT += dt;
        if (b.flapT >= b.flapMs) {
          b.flapT -= b.flapMs;
          b.frame = (b.frame + 1) % FLY_FRAMES;
        }
        drawFrame(b, false);
        const bob = b.alt > 4 ? Math.sin(b.t * 5 + b.bobPhase) * 2 : 0;
        b.sprite.setPosition(b.gx, b.gy - b.alt + bob).setDepth(DEPTH + i * 0.001);

        // Off the view (plus slack)?
        const off =
          b.gx < view.x - 120 || b.gx > view.right + 120 || b.gy < view.y - 120 || b.gy > view.bottom + 120;
        if (off) {
          if (leaving) {
            // Departing flock: this bird is gone. Last one out clears the sky.
            b.sprite.destroy();
            birds.splice(i, 1);
            continue;
          }
          // Otherwise a stray wanderer re-enters (not while fleeing — let it clear).
          if (!flushing && b.state === FLYING) recycle(ctx, b);
        }
      }
    },
    debug() {
      const flying = birds.filter((b) => b.state === FLYING || b.state === TAKEOFF).length;
      const landed = birds.filter((b) => b.state === LANDED).length;
      const landing = birds.filter((b) => b.state === LANDING).length;
      const s = birds[0];
      return {
        active,
        ready,
        inFlight: birds.length,
        flying,
        landing,
        landed,
        flocks,
        flushing: flushUntil > lastNow,
        leaving,
        sample: s ? { type: s.type, dir: s.dir, frame: s.frame, key: s.sprite.texture.key, x: s.sprite.x, y: s.sprite.y } : null,
      };
    },
    dispose() {
      for (const b of birds) b.sprite.destroy();
      birds.length = 0;
    },
  };
}
