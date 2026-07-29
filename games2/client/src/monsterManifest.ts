/** Monster catalog produced by scripts/build-monsters-manifest.mjs from the
 * pixel `monsters/` domain. Mirrors the shared CONTRACT shape (see the Assets
 * track). WALK/ROAM only this round — attack/die strips are present but unused.
 *
 * Monster art is 8-direction HORIZONTAL strips whose frame size VARIES per
 * monster AND per strip (art repairs resize in place — always slice with
 * `stripDims`, never assume the monster.json size). `walk` resolves through
 * `walkAnim`/`aliases` to the real animation key. Frame counts vary per
 * (kind, direction) — read them from `animations`, never hardcode.
 * `artBottom`/`footW`/`bodyW` are MEASURED from the walk art (feet line +
 * footprint/body widths) — the nadir shadow and the feet origin derive from
 * these; `hoverPx` marks intentional flyers (winged) that levitate above the
 * ground anchor with the shadow staying on the ground. */
export interface MonsterDef {
  id: string; // folder id under monsters/ (also the `kind` on a synced Monster)
  name: string;
  frameW: number; // measured WALK frame width (display reference)
  frameH: number;
  root: string; // repo-relative dir under monsters/
  walkAnim: string; // resolved walk animation key
  animations: Record<string, Record<string, number>>; // animKey -> dir -> frameCount
  strips: Record<string, Record<string, string>>; // animKey -> dir -> served URL
  stripDims?: Record<string, Record<string, { w: number; h: number }>>; // TRUE per-strip frame size
  aliases: Record<string, string>; // game-facing synonyms, e.g. { walk: "jump" }
  artBottom?: number; // feet line as a fraction of frameH (sprite originY)
  footW?: number; // ground-contact footprint width (px)
  bodyW?: number; // median full body width (px)
  hoverPx?: number; // intentional levitation above the ground anchor
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
