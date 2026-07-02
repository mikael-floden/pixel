/** Character catalog produced by scripts/build-manifest.mjs from the pixel repo. */
export interface CharacterDef {
  uid: string;
  skeleton: string;
  id: string;
  name: string;
  root: string; // web path, e.g. /assets/characters/.../char_00
  portrait: string;
  frameW: number;
  frameH: number;
  animations: Record<string, Record<string, number>>; // anim -> dir -> frameCount
  // Foot anchor per direction: where the sole line (centre point between the
  // feet) sits inside the frame, as origin fractions. Pinning the sprite there
  // makes the drawn feet meet the collision position exactly.
  anchors?: Record<string, { x: number; y: number }>;
}

export interface Manifest {
  directions: string[];
  characters: CharacterDef[];
}

let cache: Manifest | null = null;

export async function loadManifest(): Promise<Manifest> {
  if (cache) return cache;
  const res = await fetch("/characters.json");
  if (!res.ok) throw new Error(`failed to load character manifest: ${res.status}`);
  cache = (await res.json()) as Manifest;
  return cache;
}

/** URL of the horizontal strip for one animation/direction. */
export function stripUrl(def: CharacterDef, anim: string, dir: string): string {
  return `${def.root}/animations/${anim}__${dir}.png`;
}
