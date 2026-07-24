import Phaser from "phaser";
import { vectorToDirection } from "@nangijala/shared";

// Shared helpers for the SPRITE-ART flocks (birds, bats). The creatures are
// PixelLab "low top-down" 8-direction objects packed into two spritesheets per
// type:
//   • fly.png   — FLY_FRAMES columns (the flap cycle) × 8 rows (one per facing).
//                 frame index = dir*FLY_FRAMES + f.
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
export function dirGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 8;
  return Math.min(d, 8 - d);
}

export interface SheetSpec {
  key: string;
  url: string;
}

/** Queue any not-yet-loaded fly/still spritesheets and kick a runtime loader
 * pass. Ambient features init AFTER the scene's preload, so their PNG art must
 * load at runtime (scene.load + start); textures live on the global manager so
 * this is idempotent across re-inits/reconnects. Readiness is polled with
 * sheetsReady() rather than a COMPLETE callback, so it can't race a shared
 * loader batch when birds and bats both queue on the same first tick. */
export function queueSheets(scene: Phaser.Scene, specs: SheetSpec[]): void {
  let queued = false;
  for (const s of specs) {
    if (scene.textures.exists(s.key)) continue;
    scene.load.spritesheet(s.key, s.url, { frameWidth: FRAME_W, frameHeight: FRAME_H });
    queued = true;
  }
  if (queued) scene.load.start();
}

/** Are every spec's textures present yet? (the runtime-load guard). */
export function sheetsReady(scene: Phaser.Scene, specs: SheetSpec[]): boolean {
  return specs.every((s) => scene.textures.exists(s.key));
}
