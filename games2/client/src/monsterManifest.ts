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
  idleAnim?: string | null; // resolved idle key (null: art has no idle)
  animations: Record<string, Record<string, number>>; // animKey -> dir -> frameCount
  strips: Record<string, Record<string, string>>; // animKey -> dir -> served URL
  stripDims?: Record<string, Record<string, { w: number; h: number }>>; // TRUE per-strip frame size
  aliases: Record<string, string>; // game-facing synonyms, e.g. { walk: "jump" }
  /** PER-DIRECTION ground contract measured from the walk art: `f`/`cx` =
   * the CONTACT CENTROID (the point between the foot undersides — 2, 4 or 0
   * feet) as fractions of THAT strip's frame (sprite origin), `contact` = the
   * planted frame a PAUSED monster parks on (never an airborne hop frame),
   * `sink` = how far the front toes plant below the anchor (px) — the shadow
   * ellipse lifts so its south rim kisses the toe line. */
  ground?: Record<
    string,
    {
      f: number;
      cx: number;
      contact: number;
      sink?: number;
      up?: number;
      shift?: number[];
      air?: number[];
    }
  >;
  /** The idle state's own per-direction ground contract (independent
   * framing from walk); null when the art ships no idle animation. */
  groundIdle?: MonsterDef["ground"] | null;
  /** GAIT contract measured from the walk art (round 13). `cycleWu` = world
   * units one walk cycle should cover, so the clip is paced by DISTANCE
   * travelled and stays synced across roam/chase/hunt speeds. `travel` (real
   * HOPPERS only — body centroid rises >= 15% of figure height) = per-frame
   * ground-track weights, mean 1: a frog covers ground during its leap and
   * stands still while gathering, so an even glide fights its own art.
   * `hopFrac` is the measured rise that decided it. */
  gait?: {
    cycleWu: number;
    hopFrac?: number;
    travel?: number[];
  };
  artBottom?: number; // pooled fallback feet line (median of per-dir anchors)
  footW?: number; // ground-contact footprint width (px, contact frames)
  bodyW?: number; // widest body width (px)
  shadowW?: number; // nadir shadow ellipse size, derived from footW/bodyW
  shadowH?: number;
  radius?: number; // physical body radius (wu) — soft collision + dodges
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

/** Resolve a COMBAT state (attack/angry/die) to the anim key the strips ship
 * under, or undefined when the art has none (6 kinds have no angry — the
 * caller degrades to the parked walk frame between swings). */
export function resolveMonsterAnim(def: MonsterDef, state: string): string | undefined {
  if (def.animations?.[state]) return state;
  const alias = def.aliases?.[state];
  return alias && def.animations?.[alias] ? alias : undefined;
}
