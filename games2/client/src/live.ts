// live.ts — the client's copy of the game's LIVE tuning (live/tuning/* on
// GitHub main). The server pushes updates over the room WebSocket
// ("live:update", sent on join and on every change — see server/src/live.ts
// and live/README.md), so this needs no polling and is always current.
//
// Game code reads through the helpers below. The store only ships the data;
// ADOPTING a value (e.g. actually scaling monster damage) is each system's
// own call — everything must keep working with an empty store.

type MonsterStats = {
  max_hp?: number; damage?: number; speed_wu?: number; aggro_radius_wu?: number;
  attack_cooldown_ms?: number; xp?: number; scale?: number;
  loot?: { item: string; chance: number }[];
};
type LiveTuning = {
  monsters?: { defaults?: MonsterStats; monsters?: Record<string, MonsterStats> };
  constants?: { overrides?: Record<string, number> };
};

import { readMonsterShadow, MonsterShadow as MonsterShadowRec } from "@nangijala/shared";

let tuning: LiveTuning = {};
const listeners = new Set<(t: LiveTuning) => void>();

/** Wire the room: WorldScene calls this in bindRoom for every (re)joined room. */
export function bindLiveTuning(room: { onMessage(type: string, cb: (msg: LiveTuning) => void): void }): void {
  room.onMessage("live:update", (msg) => {
    tuning = msg ?? {};
    for (const cb of listeners) {
      try { cb(tuning); } catch (err) { console.error("[live] listener failed:", err); }
    }
  });
}

/** Subscribe to tuning pushes (fires on every server broadcast). */
export function onLiveTuning(cb: (t: LiveTuning) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Stats for one monster kind, admin overrides merged over the defaults. */
/** The monster's ONE tuned shadow (wiki shadow editor → per-monster `shadow`
 *  in tuning/monsters), or null = stay on the legacy measured anchors. */
export function monsterShadow(kind: string): MonsterShadowRec | null {
  return readMonsterShadow(tuning.monsters?.monsters?.[kind]);
}

export function monsterStats(kind: string): MonsterStats {
  const m = tuning.monsters ?? {};
  return { ...(m.defaults ?? {}), ...(m.monsters?.[kind] ?? {}) };
}

/** A gameplay constant override by exported name, or the fallback. */
export function liveConstant(name: string, fallback: number): number {
  const v = tuning.constants?.overrides?.[name];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Debug/QA snapshot (also exposed as __ml.liveTuning()). */
export function liveTuningSnapshot(): LiveTuning {
  return tuning;
}
