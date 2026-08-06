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
  // state -> frame file EXTENSION when it is not "png" (the art domains are
  // migrating to lossless WebP: ~3x smaller, pixel-identical). Absent means png,
  // so an all-PNG manifest is unchanged. Per STATE, not per character, because
  // conversion happens one animation folder at a time — a half-converted
  // character still resolves every URL correctly.
  animExt?: Record<string, string>;
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
  /** THE GRAB, per direction (build-manifest grabOf): `x`/`y` = where the
   * pickup gesture's hand meets the ground RELATIVE TO THE FOOT ANCHOR, in
   * frame fractions — measured from the item the art itself draws lying on
   * the ground — and `f` = the frame that item vanishes, i.e. the hand
   * closing on it. `approx` marks the two axis views (south/north) the art
   * draws merged into the body, interpolated from their neighbours. */
  grab?: Record<string, { f: number; x: number; y: number; approx?: boolean }>;
}

export interface Manifest {
  directions: string[];
  characters: CharacterDef[];
}

/** States needed BEFORE the world shows: the movement set the game actually
 * plays (idle/walk/run + the hop). Everything else in the manifest (kick,
 * punch, sword, bow, spells, hurt, pickup, die — ~2/3 of all frames) is
 * DEFERRED: WorldScene background-loads it after the player's avatar is in,
 * so joining doesn't wait on ~800 PNGs nothing triggers yet. */
export const BOOT_ANIM_STATES = ["idle", "walk", "run", "jump"];

let cache: Manifest | null = null;

export async function loadManifest(): Promise<Manifest> {
  if (cache) return cache;
  const res = await fetch("/characters.json");
  if (!res.ok) throw new Error(`failed to load character manifest: ${res.status}`);
  cache = (await res.json()) as Manifest;
  return cache;
}

/** characters2 stores animations as frame FOLDERS (not strips): one image per
 * frame at <root>/animations/<srcAnim>/<dir>/<n>.<ext> (unpadded n). The
 * extension comes from the MANIFEST (animExt), never guessed here — the builder
 * reads what is actually on disk, so a PNG->WebP conversion needs no game edit. */
export function frameUrl(def: CharacterDef, state: string, dir: string, n: number): string {
  const src = def.animSrc?.[state] ?? state;
  const ext = def.animExt?.[state] ?? "png";
  return `${def.root}/animations/${src}/${dir}/${n}.${ext}`;
}

/** Phaser texture key for one character frame. */
export function frameKey(uid: string, state: string, dir: string, n: number): string {
  return `f:${uid}:${state}:${dir}:${n}`;
}
