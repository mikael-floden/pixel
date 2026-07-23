/** Monster catalog produced by scripts/build-monsters-manifest.mjs from the
 * pixel `monsters/` domain. Mirrors the shared CONTRACT shape (see the Assets
 * track). WALK/ROAM only this round — attack/die strips are present but unused.
 *
 * A monster's art is 48x48, 8-direction, drawn from HORIZONTAL strips
 * (width = frames*48, height = 48). `walk` resolves through `aliases` to the
 * real animation key (porings hop, so walk -> jump). Frame counts vary per
 * (kind, direction) — read them from `animations`, never hardcode. */
export interface MonsterDef {
  id: string; // folder id under monsters/ (also the `kind` on a synced Monster)
  name: string;
  frameW: number; // 48
  frameH: number; // 48
  root: string; // repo-relative dir under monsters/
  walkAnim: string; // resolved walk animation key ("jump")
  animations: Record<string, Record<string, number>>; // animKey -> dir -> frameCount
  strips: Record<string, Record<string, string>>; // animKey -> dir -> served URL
  aliases: Record<string, string>; // game-facing synonyms, e.g. { walk: "jump" }
}

export interface MonsterManifest {
  generatedFrom: string;
  directions: string[]; // normalized 8-direction order
  monsters: MonsterDef[];
}

let cache: MonsterManifest | null = null;

export async function loadMonsterManifest(): Promise<MonsterManifest> {
  if (cache) return cache;
  const res = await fetch("/monsters.json");
  if (!res.ok) throw new Error(`failed to load monster manifest: ${res.status}`);
  cache = (await res.json()) as MonsterManifest;
  return cache;
}

/** Resolve a monster's WALK animation key through its aliases (walk -> jump). */
export function monsterWalkKey(def: MonsterDef): string {
  return def.walkAnim || def.aliases?.walk || "jump";
}
