/** Character catalog produced by scripts/build-manifest.mjs from the pixel repo. */
export interface CharacterDef {
  uid: string;
  skeleton: string;
  id: string;
  name: string;
  root: string; // web path, e.g. /assets/characters2/humans/<id>
  portrait: string;
  frameW: number;
  frameH: number;
  animations: Record<string, Record<string, number>>; // state -> dir -> frameCount
  // state -> characters2 source animation FOLDER (idle -> breathing-idle,
  // walk -> walking, run -> running-8-frames, jump -> jumping-1, kick ->
  // high-kick). Frames: <root>/animations/<animSrc[state]>/<dir>/<n>.png.
  animSrc?: Record<string, string>;
  // Foot-plant events per gait/direction (footstep marks): the frame index
  // where a foot touches down + the landing pixel in FRAME coords (see
  // build-manifest.mjs plantsOf).
  plants?: Record<string, Record<string, { f: number; x: number; y: number }[]>>;
  // Foot anchor per direction: where the sole line (centre point between the
  // feet) sits inside the frame, as origin fractions. Pinning the sprite there
  // makes the drawn feet meet the collision position exactly. `top` is the
  // crown of the head — labels hug it instead of the transparent frame top.
  anchors?: Record<string, { x: number; y: number; top?: number }>;
  // Shoulder line per direction (swimming waterline): the left/right shoulder
  // points as frame fractions. When swimming the character floats with this
  // line at the water surface and everything below it is clipped (underwater);
  // the two points can differ in y so the line tilts (build-manifest shoulderLine).
  shoulders?: Record<string, { lx: number; ly: number; rx: number; ry: number }>;
  // Anti-moonwalk playback rates measured from the art (build-manifest):
  // the fps at which each gait's feet track the ground at the gait's BASE
  // speed (WALK_SPEED/RUN_SPEED). One rate per gait — every direction keeps
  // the same leg cadence. Runtime speed variation scales anims.timeScale.
  gaitFps?: Record<string, number>;
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

/** characters2 stores animations as frame FOLDERS (not strips): one PNG per
 * frame at <root>/animations/<srcAnim>/<dir>/<n>.png (unpadded n). */
export function frameUrl(def: CharacterDef, state: string, dir: string, n: number): string {
  const src = def.animSrc?.[state] ?? state;
  return `${def.root}/animations/${src}/${dir}/${n}.png`;
}

/** Phaser texture key for one character frame. */
export function frameKey(uid: string, state: string, dir: string, n: number): string {
  return `f:${uid}:${state}:${dir}:${n}`;
}
