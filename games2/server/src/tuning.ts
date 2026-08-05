// Monster combat stats, resolved from the LIVE tuning channel (the wiki
// agent's request, board 2026-07-30: "wiki/tuning/monsters.json now holds
// per-monster stats ... for you to adopt when the monster brain lands. Please
// adopt these in the monster brain"). The document lives at
// live/tuning/monsters.json (format pixel-wiki-tuning-monsters@1), is loaded
// by live.ts from GitHub main with the baked copy as boot fallback, and
// push-refreshes — so a wiki admin edit re-tunes running rooms without a
// deploy. This resolver is the ONLY reader; keep the merge rules here.
import { liveTuning } from "./live";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export interface MonsterStats {
  level: number;
  max_hp: number;
  damage: number;
  speed_wu: number;
  aggro_radius_wu: number; // 0 = passive (retaliates only) — the default
  attack_cooldown_ms: number;
  xp: number;
  scale: number;
  loot: Array<{ item: string; chance: number }>;
}

// Hard fallback if the tuning document is missing/malformed entirely — a
// playable poring, not a crash. Mirrors the document's `defaults` block.
const BUILTIN: MonsterStats = {
  level: 1,
  max_hp: 20,
  damage: 3,
  speed_wu: 35,
  aggro_radius_wu: 0,
  attack_cooldown_ms: 1200,
  xp: 5,
  scale: 1,
  loot: [],
};

const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);

// The BAKED tuning document, read straight from disk. Three-layer fallback:
// live channel (GitHub main, push-refreshed) <- this baked copy <- BUILTIN.
// The baked layer is what makes the resolver correct in tests and in rooms
// created before initLive's first fetch resolves — without it every monster
// silently fought as a default poring until the network won a race.
const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(HERE, "..", "..", "..");
let bakedCache: unknown | null | undefined;
function bakedDoc(): unknown | null {
  if (bakedCache !== undefined) return bakedCache;
  const p = join(ASSETS_ROOT, "live", "tuning", "monsters.json");
  try {
    bakedCache = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  } catch {
    bakedCache = null;
  }
  return bakedCache;
}

/** defaults <- per-monster override, every field individually validated. */
export function monsterStatsFor(kind: string): MonsterStats {
  type Doc = { defaults?: Record<string, unknown>; monsters?: Record<string, Record<string, unknown>> };
  const live = liveTuning().monsters as Doc | undefined;
  // live.ts serves an EMPTY placeholder doc (defaults:{}, monsters:{}) until
  // initLive's first fetch lands — truthiness is not enough, check for CONTENT.
  const liveHasContent =
    !!live && (Object.keys(live.monsters ?? {}).length > 0 || Object.keys(live.defaults ?? {}).length > 0);
  const doc: Doc | undefined = liveHasContent ? live : ((bakedDoc() as Doc | null) ?? undefined);
  const d = doc?.defaults ?? {};
  const o = doc?.monsters?.[kind] ?? {};
  const pick = (key: keyof MonsterStats & string) => num(o[key] ?? d[key], BUILTIN[key] as number);
  const lootRaw = (Array.isArray(o.loot) ? o.loot : Array.isArray(d.loot) ? d.loot : []) as Array<{
    item?: unknown;
    chance?: unknown;
  }>;
  return {
    level: pick("level"),
    max_hp: Math.max(1, pick("max_hp")),
    damage: Math.max(0, pick("damage")),
    speed_wu: pick("speed_wu"),
    aggro_radius_wu: Math.max(0, pick("aggro_radius_wu")),
    attack_cooldown_ms: Math.max(300, pick("attack_cooldown_ms")),
    xp: Math.max(0, pick("xp")),
    scale: pick("scale"),
    loot: lootRaw
      .filter((l) => typeof l?.item === "string" && typeof l?.chance === "number")
      .map((l) => ({ item: l.item as string, chance: Math.min(1, Math.max(0, l.chance as number)) })),
  };
}
