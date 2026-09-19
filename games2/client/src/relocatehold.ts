/** THE RELOCATION VEIL'S HOLD — pure, so the verdict is testable without a
 *  scene (server/test/relocatehold.test.ts).
 *
 *  A respawn (the death "continue" press, the dev respawn button) used to snap
 *  the body to the spawn on the frame the server's patch landed, so the player
 *  watched the new ground stream in, the scenery pop into existence and the
 *  clips arrive one by one (maintainer 2026-09-19: "When a player sees the
 *  inside tricks the engine uses the entire illusion disappears! We can't let
 *  players respawning after dead to see this inner workings!"). Now the boot
 *  loading screen is reused — the same veil, the same staged cinema fade in
 *  and out, a bar that moves much faster — and WorldScene holds it until the
 *  boot hold's own predicate has held for a settle. This file is the verdict
 *  and its constants; the predicate's inputs are the scene's. */

/** The ask goes out only once the black is up: loading.ts fades the overlay in
 *  over 0.4 s, and a body that moves under a half-faded screen is the very
 *  snap the veil exists to hide. */
export const RELOCATE_VEIL_IN_MS = 450;
/** How long "ready" must hold before the screen lifts. The boot hold uses
 *  1,200 ms; a respawn's window is a fraction of a join and the whole point is
 *  a bar that moves fast — but the trap is the same: the terrain loader's
 *  need() only QUEUES and its queue turns pending at the END of a pass, so
 *  one sample can read idle with files still to come. 800 ms is several
 *  passes at any frame rate. */
export const RELOCATE_SETTLE_MS = 800;
/** Give up on the trimmings once the ground has painted since the jump. */
export const RELOCATE_SOFT_MS = 12000;
/** The true backstop: only this may lift with nothing painted. */
export const RELOCATE_HARD_MS = 30000;
/** No answer arrived — the server refused the ask (the die clip is still
 *  owed) or the socket died. The retry loop keeps asking; the veil steps
 *  aside. */
export const RELOCATE_JUMP_WAIT_MS = 8000;
/** A LIVING respawn or teleport that lands where the body already stands
 *  moves it under two cells, so no snap ever comes: after this grace the
 *  answer is taken as "already there" and the hold runs on the streaming
 *  predicate alone. Longer than the veil-in plus a slow round trip; a snap
 *  that still arrives later upgrades the arrival (the paint counters restart
 *  from it). The death press needs no grace: its answer is the revive. */
export const RELOCATE_ARRIVE_GRACE_MS = 1500;

export interface RelocateInputs {
  now: number;
  /** When the veil went up (the press). */
  askedAt: number;
  /** When the server's answer landed: my body's >2-cell snap, the revive
   *  (the death press), or the grace for a body that did not need to move;
   *  0 while waiting. */
  arrivedAt: number;
  /** The ground has painted since the arrival — or the body did not move and
   *  nothing needed painting. */
  painted: boolean;
  /** The streaming predicate this sample (the boot hold's own). */
  ready: boolean;
  /** When `painted && ready` last became true; 0 while it is not. */
  readySince: number;
  unloading?: boolean;
}

export type RelocateWhy = "ready" | "soft" | "hard" | "nojump" | "unloading" | "";

export function relocateVerdict(i: RelocateInputs): { done: boolean; why: RelocateWhy; readySince: number } {
  const readySince = i.painted && i.ready ? i.readySince || i.now : 0;
  if (i.unloading) return { done: true, why: "unloading", readySince };
  if (!i.arrivedAt) {
    const gaveUp = i.now - i.askedAt >= RELOCATE_JUMP_WAIT_MS;
    return { done: gaveUp, why: gaveUp ? "nojump" : "", readySince };
  }
  const waited = i.now - i.arrivedAt;
  if (readySince && i.now - readySince >= RELOCATE_SETTLE_MS) return { done: true, why: "ready", readySince };
  if (i.painted && waited >= RELOCATE_SOFT_MS) return { done: true, why: "soft", readySince };
  if (waited >= RELOCATE_HARD_MS) return { done: true, why: "hard", readySince };
  return { done: false, why: "", readySince };
}

/** THE BAR for one sample: a sliver while the ask is out, a third once the
 *  answer has landed, then the streaming stage's own fraction (terrain files +
 *  scenery manifests + scenery stills, asked vs landed — the boot bar's
 *  counts). The caller keeps it MONOTONIC: the denominator grows as the new
 *  window discovers art, and a bar that walks backwards reads as a fault. */
export function relocateProgress(i: { arrived: boolean; want: number; have: number }): number {
  if (!i.arrived) return 0.15;
  const f = i.want > 0 ? Math.min(1, Math.max(0, i.have / i.want)) : 1;
  return +(0.35 + 0.6 * f).toFixed(3);
}
