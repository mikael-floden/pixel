import Phaser from "phaser";
import { vectorToDirection } from "@nangijala/shared";

// Shared helpers for the SPRITE-ART flocks (birds, bats). The creatures are
// PixelLab "low top-down" 8-direction objects packed into two spritesheets per
// type:
//   • fly.png   — FLY_FRAMES columns (the flap cycle) × 8 rows (one per facing).
//                 frame index = dir*FLY_FRAMES + f  (see flyFrame()).
//   • still.png — 8 columns (a still base, one per facing). frame index = dir.
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
  frame: number; // flap frame 0..FLY_FRAMES-1
  flapMs: number; // ms per flap frame
  flapT: number;
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
  b.flapT += dt;
  if (b.flapT >= b.flapMs) {
    b.flapT -= b.flapMs;
    b.frame = (b.frame + 1) % FLY_FRAMES;
  }
}

export interface SheetSpec {
  key: string;
  url: string;
}

const MAX_RELOAD = 3; // bounded self-heal retries per sheet key
const reloads = new Map<string, number>();

/** Queue any not-yet-loaded fly/still spritesheets and kick a runtime loader
 * pass. Ambient features init AFTER the scene's preload, so their PNG art must
 * load at runtime (scene.load + start); textures live on the global manager so
 * this is idempotent across re-inits/reconnects. Readiness is polled with
 * sheetsReady() rather than a COMPLETE callback, so it can't race a shared
 * loader batch when birds and bats both queue on the same first tick.
 *
 * A single flaky fetch must NOT silently kill the flock for the whole session
 * (sheetsReady would never go true), so an errored sheet is re-queued a few
 * times on a short backoff before giving up — degrading gracefully either way. */
export function queueSheets(scene: Phaser.Scene, specs: SheetSpec[]): void {
  const load = (s: SheetSpec) => scene.load.spritesheet(s.key, s.url, { frameWidth: FRAME_W, frameHeight: FRAME_H });
  let queued = false;
  for (const s of specs) {
    if (scene.textures.exists(s.key)) continue;
    load(s);
    queued = true;
  }
  if (!queued) return;
  scene.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
    const spec = specs.find((s) => s.key === file.key);
    if (!spec) return; // another feature's sheet
    const n = (reloads.get(spec.key) ?? 0) + 1;
    reloads.set(spec.key, n);
    if (n > MAX_RELOAD) return; // give up quietly — the effect just stays absent
    scene.time.delayedCall(500 * n, () => {
      if (!scene.textures.exists(spec.key)) {
        load(spec);
        scene.load.start();
      }
    });
  });
  scene.load.start();
}

/** Are every spec's textures present yet? (the runtime-load guard). */
export function sheetsReady(scene: Phaser.Scene, specs: SheetSpec[]): boolean {
  return specs.every((s) => scene.textures.exists(s.key));
}
