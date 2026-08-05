// COMBAT — single source of truth shared by the server (authoritative sim) and
// the client (prediction + display). Framework-free pure TS: no Colyseus, no
// Phaser. Design reference is Ragnarok Online (maintainer 2026-07-31: "Think
// Ragnarok Online mechanics when unsure"): tap a monster to engage, melee
// swings on a cooldown, aggressive monsters chase, hits stagger the victim,
// monsters drop loot on the ground where they die, xp per kill on a steepening
// curve.
//
// Everything the server and client must AGREE on lives here — most critically
// the slow debuff (it scales stepMovement's speedScale on BOTH sides; a
// mismatch rubber-bands every hit) and the kick/punch pick (display-only, but
// every client must choose the same clip for the same swing).
import { CELL_WU } from "./units";

// --- progression ------------------------------------------------------------

export const LEVEL_CAP = 99;

/** XP required to go from `level` to `level+1`. RO-flavored power curve —
 * early levels are minutes, later ones are an evening. Monster xp values come
 * from wiki/tuning (single kills are ~4-40xp early). */
export function xpToNext(level: number): number {
  return Math.round(50 * Math.pow(Math.max(1, level), 1.5));
}

/** Max HP at a level. Level 1 = 40, +12 per level (level 99 ≈ 1216). */
export function hpMaxFor(level: number): number {
  return 40 + 12 * (Math.max(1, level) - 1);
}

/** Max EP at a level. Unused by any skill yet (maintainer: "even if it's not
 * used yet") — the pool exists so the UI and persistence are already right
 * when skills arrive. */
export function epMaxFor(level: number): number {
  return 20 + 5 * (Math.max(1, level) - 1);
}

/** The player's melee attack power at a level (no weapons yet — bare hands). */
export function playerAtk(level: number): number {
  return 6 + 2 * Math.max(1, level);
}

// --- deterministic per-swing randomness ------------------------------------

/** Small integer hash (splitmix-ish). Deterministic across JS engines. */
export function mix32(a: number, b: number): number {
  let h = (a | 0) ^ ((b | 0) + 0x9e3779b9 + ((a | 0) << 6) + ((a | 0) >> 2));
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^= h >>> 16) >>> 0;
}

/** Damage for one swing: atk ± 15%, deterministic from the seed pair so tests
 * can assert exact numbers. Always at least 1. */
export function damageRoll(atk: number, seedA: number, seedB: number): number {
  const r = mix32(seedA, seedB) / 0xffffffff; // 0..1
  return Math.max(1, Math.round(atk * (0.85 + 0.3 * r)));
}

/** Which unarmed clip a given swing plays: pseudo-random kick/punch
 * (maintainer: "alter between kick and punch (make it pseudo-random)").
 * Deterministic from the synced swing counter + a per-player salt so every
 * client shows the same move without an extra synced field. */
export function unarmedClip(actionSeq: number, salt: number): "kick" | "punch" {
  return mix32(actionSeq, salt) & 1 ? "kick" : "punch";
}

/** Stable 32-bit salt from a session/entity id string. */
export function idSalt(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

// --- melee ------------------------------------------------------------------

/** Melee reach between two bodies is RADIUS-AWARE, exactly like separation:
 * a mammoth's face is ~2 cells from its centre, so a fixed range either lets
 * players hit it from another postcode or forces them inside its footprint. */
export const ATTACK_REACH_PAD_WU = 12;
export function attackRange(rA: number, rB: number): number {
  return rA + rB + ATTACK_REACH_PAD_WU;
}

export const PLAYER_ATTACK_MS = 900; // unarmed swing cadence (ASPD-ish)
export const MONSTER_ATTACK_MS = 1400; // default; per-monster override via tuning
export const PLAYER_BODY_R = 9; // mirror of PLAYER_BODY_RADIUS (avoid the ./monsters cycle)

// --- the hit stagger + the flee slow (the "hard to escape" half) ------------

// Each hit taken sets the victim's speed factor to SLOW_FACTOR for SLOW_MS
// (refreshed, not stacked). On top of it, a player being hunted by a monster
// THEY provoked carries the persistent FLEE_SLOW_FACTOR for the whole hunt
// (maintainer 2026-08-05: "The players movement speed should lowered until
// the player has successfully run away"). The two combine by min() — a hit
// mid-flight briefly deepens the slow, then the flee slow resumes.
export const SLOW_FACTOR = 0.55;
export const SLOW_MS = 1500;
export const FLEE_SLOW_FACTOR = 0.8;

/** The movement speed factor for a victim whose last hit landed at `hitAt`
 * (same clock as `now`). Used IDENTICALLY by the server integration and the
 * client prediction — both multiply stepMovement's speedScale by this. */
export function slowFactorAt(hitAt: number, now: number): number {
  return now - hitAt < SLOW_MS ? SLOW_FACTOR : 1;
}

// --- monster brain ----------------------------------------------------------

// A sword-MARKED monster (the player clicked attack on it) aggros the moment
// the player closes inside this radius — passive kinds included: raising your
// sword at something IS the provocation. Predators' own proximity radii come
// from tuning and stack via max().
export const PROVOKE_RADIUS_WU = 4 * CELL_WU;

// UNPROVOKED chases (a predator noticed you) run at this constant: below full
// run (175), so an innocent passer-by can always sprint clear.
export const CHASE_SPEED_WU = 105;

/** PROVOKED hunts (you started it) are personal: the monster moves always
 * SLIGHTLY FASTER than its victim currently can (maintainer: "a movement
 * speed always slightly greater than the player"), so running only delays
 * the next bite — escape comes from crossing the ESCAPE line, not from
 * outpacing. Floor so it closes on a standing victim, cap for sanity well
 * above any real player speed. */
export const CHASE_GAIN = 1.12;
export const CHASE_MIN_WU = 60;
export const CHASE_MAX_WU = 220;
export function provokedChaseSpeed(victimSpeedWu: number): number {
  return Math.min(CHASE_MAX_WU, Math.max(CHASE_MIN_WU, victimSpeedWu * CHASE_GAIN));
}

// The RUN-AWAY / ESCAPE RADIUS (maintainer: "~1½ screen in size"): the camera
// frames ~520 world-px of world regardless of viewport (WorldScene zoomFor),
// so 1.5 screens ≈ 780wu. A chase follows its victim this far beyond the home
// ZONE and no further — crossing the line IS the successful escape: the
// monster gives up, walks home, and the flee slow lifts.
export const ESCAPE_RADIUS_WU = 780;
export const MONSTER_RESPAWN_MS = 12_000;
export const MONSTER_DIE_MS = 1_100; // corpse lingers (die clip) before removal + drops

// The in-fight CIRCLING (maintainer: "the player and the monster will slowly
// circle each other in order to make the attack and angry-idle vary in
// direction"): while waiting on its swing cooldown in reach, the monster
// strafes tangentially around its target at ORBIT_SPEED. The direction it
// faces (and so the attack/angry strips shown) then sweeps naturally. The
// orbit handedness is per-monster (id hash) so a pack doesn't rotate in
// lockstep. The player's DISPLAYED facing tracks the engaged monster
// client-side, which completes the effect without touching real input.
export const ORBIT_SPEED_WU = 24;

// --- death / respawn / regen ------------------------------------------------

export const PLAYER_RESPAWN_MS = 2_600; // die clip plays, then snap to spawn
export const REGEN_DELAY_MS = 4_000; // out-of-combat delay before regen starts
export const HP_REGEN_FRAC_PER_S = 0.06; // of hpMax, per second, out of combat
export const EP_REGEN_FRAC_PER_S = 0.08;

// --- drops / pickup ---------------------------------------------------------

export const DROP_SCATTER_WU = 26; // items land scattered around the corpse/player
export const DROP_SPACING_WU = 24; // keep ground items at least this far apart (readability)
export const DROP_TTL_MS = 60_000; // ground items despawn after a minute (maintainer 2026-08-05)
export const DROP_FLASH_MS = 5_000; // final stretch: flash transparent, faster and faster
export const PICKUP_RADIUS_WU = 40; // how close the body must be to grab
export const INV_MAX_STACK = 99;
export const INV_MAX_SLOTS = 30;

/** Roll a monster's drops. `loot` is the tuning table entry: item ids with
 * drop chances (0..1). Deterministic from the seed pair. Every entry rolls
 * independently (RO-style — a lucky kill can drop everything). */
export function rollDrops(
  loot: Array<{ item: string; chance: number }> | undefined,
  seedA: number,
  seedB: number,
): string[] {
  if (!loot || !loot.length) return [];
  const out: string[] = [];
  for (let i = 0; i < loot.length; i++) {
    const r = mix32(seedA + i * 7919, seedB) / 0xffffffff;
    if (r < loot[i].chance) out.push(loot[i].item);
  }
  return out;
}
