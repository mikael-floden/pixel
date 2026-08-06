/** NPC catalog produced by scripts/build-npcs-manifest.mjs from
 * `characters2/npcs/`. WHO stands WHERE is maps2' business — each world ships
 * its own `npcs.json` (pixel-maps2/npcs@1) that the scene fetches separately;
 * this file only answers "what does character <id> look like".
 *
 * COVERAGE: the generated idle currently exists for SOUTH ONLY, and a handful
 * of characters ship none at all — so `idle` is keyed per DIRECTION and may be
 * empty, and every facing always has a static `base` rotation to fall back to.
 * When characters2 generates the other seven rotations they appear here with
 * no client change. */
export interface NpcDef {
  id: string;
  name: string;
  role: string | null;
  frameW: number;
  frameH: number;
  base: Record<string, string>; // dir -> served url (all 8)
  idleAnim: string | null; // the idle folder name, if any
  idle: Record<string, number>; // dir -> frame count (south only today)
}

export interface NpcManifest {
  directions: string[];
  npcs: NpcDef[];
}

export async function loadNpcManifest(): Promise<NpcManifest> {
  const res = await fetch("/npcs.json");
  if (!res.ok) throw new Error(`npcs.json ${res.status}`);
  return (await res.json()) as NpcManifest;
}

/** One placed NPC from a world's maps2 `npcs.json` (pixel-maps2/npcs@1). */
export interface NpcPlacement {
  id: string;
  character: string; // folder id under characters2/npcs — the reference
  name: string;
  type: string; // AMBIENT | MERCHANT
  x: number; // TILE cell
  y: number;
  elev: number;
  facing: string;
  wares?: string[];
}

/** A world's NPC placement, or [] when it ships none (most demo worlds). */
export async function loadNpcPlacement(world: string): Promise<NpcPlacement[]> {
  try {
    const res = await fetch(`/assets/maps2/worlds/${world}/npcs.json`);
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j?.npcs) ? (j.npcs as NpcPlacement[]) : [];
  } catch {
    return [];
  }
}
