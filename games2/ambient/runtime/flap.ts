import { ISO_DX, ISO_DY, vectorToDirection } from "@nangijala/shared";

// The PHASER-FREE core of the sprite-art flocks: sheet geometry, the 8-facing
// direction model, and the flap/facing state machine. Split out of critters.ts
// so it can be unit-tested — critters.ts imports Phaser, which needs a DOM, and
// the one thing here that MUST NOT regress (never drawing a culled frame) is
// pure arithmetic. critters.ts re-exports all of it, so no call site changed.
//
// The creatures are PixelLab "low top-down" 8-direction objects packed into two
// spritesheets per type:
//   • fly   — FLY_FRAMES columns (the flap cycle) x 8 rows (one per facing).
//             frame index = dir*FLY_FRAMES + f  (see flyFrame()).
//   • still — 8 columns (a still base, one per facing). frame index = dir.
// The 8 rows are in PixelLab's rotation order (below) — which is the MIRROR of
// shared/DIRECTIONS — so a facing is resolved by NAME, never by array index.
export const FRAME_W = 34;
export const FRAME_H = 34;
export const FLY_FRAMES = 16;

// PixelLab row order (index 0..7). Do NOT reuse shared/DIRECTIONS.indexOf here —
// that array rotates the other way (S,SW,W,…) and would swap east/west.
const DIR_INDEX: Record<string, number> = {
  south: 0,
  "south-east": 1,
  east: 2,
  "north-east": 3,
  north: 4,
  "north-west": 5,
  west: 6,
  "south-west": 7,
};

/** Row-major frame index into a fly spritesheet (16 cols × 8 rows). */
export const flyFrame = (dir: number, frame = 0): number => dir * FLY_FRAMES + frame;

/** A flock creature's velocity → PixelLab facing index 0..7, or null when there
 * is no meaningful heading (near-zero speed → keep the last facing). The flock
 * gx/gy/vx/vy already live in the DRAWN (iso-projected) space — the same screen
 * vector the player's own facing uses — so the velocity goes straight into the
 * game's shared vectorToDirection (screen +y is down). */
export function dirFromVel(vx: number, vy: number): number | null {
  if (Math.abs(vx) < 0.01 && Math.abs(vy) < 0.01) return null;
  const name = vectorToDirection(vx, vy);
  return name ? DIR_INDEX[name] ?? null : null;
}

// The 8 canonical FACING screen directions (unit vectors) the flock art depicts.
// Cardinals are the screen axes; the DIAGONALS are the shallow ISO tile axes
// (±ISO_DX, ±ISO_DY) — NOT screen-45° — because this is an iso world: a bird's
// "north-east" sprite shows it flying along the tile axis, exactly like the
// player's grid-axis-locked diagonal walk, so the 8 directions are UNEVENLY
// spaced on screen. A velocity landing on any of these classifies (via
// vectorToDirection) to a distinct one of the 8 facings, so steering toward the
// nearest makes a creature fly the way its sprite faces.
const _DIAG = Math.hypot(ISO_DX, ISO_DY);
const FACING_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], // east
  [ISO_DX / _DIAG, -ISO_DY / _DIAG], // up-right (shallow iso)
  [0, -1], // north
  [-ISO_DX / _DIAG, -ISO_DY / _DIAG], // up-left
  [-1, 0], // west
  [-ISO_DX / _DIAG, ISO_DY / _DIAG], // down-left
  [0, 1], // south
  [ISO_DX / _DIAG, ISO_DY / _DIAG], // down-right
];

/** The nearest canonical FACING direction (a unit vector) to a velocity, by max
 * dot product. Steer a flyer's velocity toward this so it moves the way its
 * 8-direction sprite faces. Zero velocity → east (arbitrary; callers are moving). */
export function nearestFacingDir(vx: number, vy: number): readonly [number, number] {
  const sp = Math.hypot(vx, vy) || 1;
  const ux = vx / sp;
  const uy = vy / sp;
  let best = FACING_DIRS[0];
  let bestDot = -Infinity;
  for (const d of FACING_DIRS) {
    const dot = ux * d[0] + uy * d[1];
    if (dot > bestDot) {
      bestDot = dot;
      best = d;
    }
  }
  return best;
}

/** Shortest step count between two 8-way facings (0..4) — a 1-step change is an
 * adjacent-sector flip (hysteresis territory), ≥2 is a real turn. */
function dirGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 8;
  return Math.min(d, 8 - d);
}

/** The per-agent draw state both flocks share (a Bird/Bat is a structural
 * superset). Advanced together each frame by stepFlapDir. */
export interface FlapState {
  dir: number; // current facing (PixelLab index 0..7), hysteretic
  dirHoldT: number; // ms an adjacent new heading has persisted
  vx: number;
  vy: number;
  frame: number; // flap frame 0..flapCount-1 (NOT always FLY_FRAMES — see frames)
  flapMs: number; // ms per flap frame
  flapT: number;
  // How many flap frames each FACING actually has after the maintainer's cull
  // (runtime/flapframes.json, applied by scripts/cull_frames.py). Rows are still
  // FLY_FRAMES wide; the cull packs the kept frames to the LEFT and leaves the
  // tail transparent, so cycling past this count would draw empty cells and the
  // creature would blink out. Counts differ PER FACING — a bird may keep 16
  // frames flying west and 6 flying north-west.
  frames: readonly number[];
}

/** Flap frames available for a creature's CURRENT facing. Falls back to the full
 * row for art that was never culled (or a short/garbled table), so a missing
 * entry degrades to the old behaviour instead of freezing the wings. */
function flapCount(b: FlapState): number {
  const n = b.frames?.[b.dir];
  return n && n > 0 ? Math.min(n, FLY_FRAMES) : FLY_FRAMES;
}

/** The sheet cell to DRAW for a flapping creature, re-seating a stale frame
 * first. Defence in depth, deliberately: today every flying draw is already
 * preceded by stepFlapDir, which re-seats — so this cannot currently fire. It
 * exists because `dir` IS assigned directly in several places that bypass
 * stepFlapDir (a landed bird re-faces at random as it hops; a migratory group
 * snaps to its launch heading), and the cull made the consequence severe: the
 * pair (west, frame 11) is fine at 16 frames but indexes transparent padding
 * the instant the facing becomes one with 8, and the creature blinks out
 * mid-flight. Clamping at the single draw choke point means a future caller
 * that sets dir — or reorders a draw before its step — cannot reintroduce it.
 * NOTE for anyone testing: because this guarantees a valid cell, no end-to-end
 * probe can observe the failure. The arithmetic is gated by the unit test
 * (server/test/flapcull.test.ts), not by the browser script. */
export function flyCell(b: FlapState): number {
  const n = flapCount(b);
  if (b.frame >= n) b.frame %= n;
  return flyFrame(b.dir, b.frame);
}

/** Advance a creature's FACING and FLAP frame by dt ms. Facing snaps on a real
 * turn (≥2 sectors) but an adjacent-sector flip must persist `stick` ms first,
 * so a boid wobbling across an 8-way boundary doesn't jitter the sprite;
 * near-zero velocity keeps the last facing. Display-only — never touches the
 * boids force math. Mutates dir/dirHoldT/frame/flapT in place. */
export function stepFlapDir(b: FlapState, dt: number, stick: number): void {
  const cand = dirFromVel(b.vx, b.vy);
  if (cand !== null && cand !== b.dir) {
    if (dirGap(cand, b.dir) >= 2) {
      b.dir = cand; // a real turn — snap immediately
      b.dirHoldT = 0;
    } else {
      b.dirHoldT += dt; // an adjacent flip — only turn if it persists
      if (b.dirHoldT >= stick) {
        b.dir = cand;
        b.dirHoldT = 0;
      }
    }
  } else {
    b.dirHoldT = 0;
  }
  // A turn can land on a facing with FEWER kept frames than the one just left,
  // so re-seat the cycle before advancing — otherwise the first frame drawn
  // after the turn is transparent padding and the creature flickers. Modulo
  // (not 0) keeps the wingbeat's phase across the turn instead of resetting it.
  const n = flapCount(b);
  if (b.frame >= n) b.frame %= n;
  b.flapT += dt;
  if (b.flapT >= b.flapMs) {
    // Drain the WHOLE accumulator, not one frame per call. This used to subtract
    // a single flapMs however far behind it was, which silently CAPPED every
    // wingbeat at one frame per rendered tick — so any flapMs below the frame
    // time (~16.7ms at 60fps) drew at exactly the same speed as any other, and
    // the leftover debt grew forever. The bat sat at 8-12ms and was therefore
    // pinned to 60 frames/s no matter what the constant said; halving it would
    // have changed nothing on screen. Now flapMs means what it claims: ms per
    // frame. Callers clamp dt (~100ms), so `steps` stays small and the modulo
    // absorbs a long stall instead of spinning.
    const steps = Math.floor(b.flapT / b.flapMs);
    b.flapT -= steps * b.flapMs;
    b.frame = (b.frame + steps) % n;
  }
}
