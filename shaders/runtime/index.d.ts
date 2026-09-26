// Types for the effects runtime (shaders/docs/integration.md is the contract).

/** A point in the GAME'S WORLD SPACE: x, y in world units on the ground (the
 *  server's body coordinates), z = height in world px above the ground there,
 *  sx = a SCREEN-x shift in px (a cast clip's wand tip: see castFrom). */
export interface FxPoint { x: number; y: number; z?: number; sx?: number }
/** A point, or a function read every frame (a body that moves). */
export type FxPos = FxPoint | (() => FxPoint | null | undefined);

export type FxKind = "burst" | "projectile" | "beam" | "chain" | "aura" | "zone" | "melee" | "screen";
export type FxPlane = "ground" | "body" | "air" | "screen";
/** In firing order: cast (play()), release (it leaves the caster), then the
 *  kind's own (impact / hit / peak / hop / start), stop (a sustained effect's
 *  outro begins), end. */
export type FxEvent = "cast" | "release" | "impact" | "peak" | "hit" | "hop" | "start" | "stop" | "end" | "*";
/** A volley's formation (volley.js): the skill picks how many, the effect owns how they fly. */
export type FxFormation = "fan" | "barrage" | "spread" | "rain" | "ring" | "line";

export interface FxHost {
  /** World units -> the Phaser world px of that GROUND point (terrain lift and view rotation included). */
  project(x: number, y: number): { x: number; y: number };
  /** World units per cell (default 32). */
  cellWu?: number;
  /** Optional: px per cell of world +x and +y at a point, [e1x, e1y, e2x, e2y] (screen, y down). */
  basis?(x: number, y: number): [number, number, number, number];
  /** The camera's world rect (screen-plane layers). */
  view?(): { x: number; y: number; w: number; h: number };
}

export interface FxPlay {
  /** 1..10: the skill's level. The effect owns what each level looks like. */
  level?: number;
  /** projectile / beam / chain / blink: where it starts (default z: 0.55 x height, the hand). */
  from?: FxPos;
  /** projectile / beam / melee: what it goes to (default z: 0.5 x targetHeight, the chest). */
  to?: FxPos;
  /** burst / aura / zone / melee: where it happens (the ground point of a body or spot; z 0). */
  at?: FxPos;
  /** chain: the victims in hop order. */
  targets?: FxPos[];
  /** A facing on the ground (world units), when there is no `to`. */
  dir?: { x: number; y: number } | (() => { x: number; y: number });
  /** zone / nova radius in CELLS: the gameplay radius (defaults to the effect's own by level). */
  radius?: number;
  /** Sustained kinds: seconds until the outro starts (else runs until stop()). */
  duration?: number;
  /** projectile: cells/second override, or an exact flight time in seconds (e.g. the server's). */
  speed?: number;
  flightTime?: number;
  /** Drawn height (px) of the body at `at`/`from`, and of the target. Default 88 (the person). */
  height?: number;
  targetHeight?: number;
  /** Who cast it — the game's own tag, handed back on lights() and draw items ("self", "monster", ...). */
  owner?: string;
  /** Deterministic variation (0..1). Default random. */
  seed?: number;
  /** Per-cast tunable overrides (the wiki's sliders use this; the game normally does not). */
  tune?: Record<string, number | string | boolean>;
  /** Seconds from play() to the moment the spell leaves the caster: the cast
   *  clip's key frame (castRelease). A projectile's gather fills it; every other
   *  kind waits unseen and starts on it. Default: the effect's own windup / 0. */
  release?: number;
  /** A VOLLEY: this many copies (2..12) in `formation` — one handle, every
   *  copy's release / impact / peak fired with its index. */
  count?: number;
  formation?: FxFormation;
}

/** One scheduled event, seconds from play(). */
export interface FxTimelineEvent { event: Exclude<FxEvent, "*">; index: number; t: number }

export interface FxHandle {
  readonly id: string;
  readonly kind: FxKind | "none";
  readonly seq: number;
  readonly owner?: string;
  /** Seconds from play() to the (first) impact (projectile) or the hit (melee). Schedule damage on it. */
  readonly flightTime: number;
  readonly impactAt: number;
  /** Seconds from play() to the (first) release. */
  readonly releaseAt: number;
  /** Per copy of a volley (one entry for a single cast): release / impact times. */
  readonly releases: number[];
  readonly impacts: number[];
  /** 1 for a single cast; a volley's count and formation. */
  readonly count: number;
  readonly formation: FxFormation | null;
  /** Seconds until the effect ends (Infinity for a sustained effect not yet stopped). */
  readonly duration: number;
  readonly done: boolean;
  readonly time: number;
  /** i = which copy of a volley / which hop of a chain, else 0. */
  on(ev: FxEvent, fn: (i: number, h: FxHandle, ev: string) => void): FxHandle;
  /** Move / retarget / re-level a running effect. */
  set(p: Partial<Pick<FxPlay, "at" | "from" | "to" | "dir" | "targets" | "height" | "level" | "radius">>): FxHandle;
  /** Sustained kinds play their outro; one-shots are cut. */
  stop(): void;
  /** Gone this frame, no outro. */
  kill(): void;
  setTune(t: Record<string, number | string | boolean>): FxHandle;
  /** Every scheduled event, sorted (a sustained effect not yet stopped has no stop/end). */
  timeline(): FxTimelineEvent[];
}

/** One layer to draw this frame. Box in Phaser world px (top-left, y down). */
export interface LayerDraw {
  key: string; id: string; layer: string;
  plane: FxPlane;
  /** true: a light source, never dimmed by night. false: part of the world, darkened like it. */
  emissive: boolean;
  x: number; y: number; w: number; h: number;
  ax: number; ay: number;
  /** The ground point (world units) this layer sorts as if it stood on. */
  gx: number; gy: number; z: number;
  /** Screen y a body standing here would sort by (the default depth key). */
  sortY: number; groundY: number;
  order: number;
  owner?: string;
  handle: FxHandle;
}

/** One light this frame (strongest first in lights()). */
export interface FxLight {
  id: string; owner?: string; handle: FxHandle;
  /** World units + height px. */
  x: number; y: number; z: number;
  /** Cells. */
  radius: number;
  /** Intensity folded in; may exceed 1 (overbright widens the hot plateau). */
  color: [number, number, number];
  flicker: number;
  weight: number;
}

export interface FxStyle { pixel: boolean; bands: number; dither: boolean; stepFps: number; bright: number }

export type CastAnim = "spell_wand" | "spell_channel" | "bow" | "sword" | "punch" | "kick" | "attack";

/** Who is on stage and how the effect is played there (define.js stageOf). */
export interface FxStage {
  caster: "hero" | "monster" | null;
  target: "monster" | "hero" | null;
  extras: number;
  at: "caster" | "target" | "free" | null;
  reach: number | null;
  move: boolean;
  hold: number;
  anim: CastAnim | null;
  /** A shipped monster id that suits the effect (a caster that claws, spits, slams). */
  monster?: string;
}

/** A moment a sound can be bound to. */
export interface FxSoundSlot { slot: string; event: Exclude<FxEvent, "*">; label: string; each: boolean; loop?: true }

export interface EffectDef {
  id: string; name: string; kind: FxKind; family: string; category: string; tags: string[];
  thinking: string; levels: string;
  stage: FxStage;
  sounds: FxSoundSlot[];
  tune: Record<string, { type: "color" | "range" | "bool" | "select"; def: unknown; min?: number; max?: number; step?: number; label?: string; options?: string[] }>;
  layers: { id: string; plane: FxPlane; emissive: boolean }[];
  [k: string]: unknown;
}

export declare class FxWorld {
  constructor(host: FxHost, opts?: { style?: Partial<FxStyle>; log?: (m: string) => void });
  readonly defs: Map<string, EffectDef>;
  register(def: EffectDef): this;
  registerAll(defs: EffectDef[]): this;
  /** live/tuning/shaders.json `overrides` (keys "shaders/library/<id>" or "<id>"). */
  setTuning(table: Record<string, Record<string, unknown>>): this;
  setStyle(style: Partial<FxStyle>): this;
  play(id: string, p?: FxPlay): FxHandle;
  /** The schedule play() would run, without playing it. */
  timeline(id: string, p?: FxPlay): FxTimelineEvent[];
  update(dtSeconds: number): void;
  drawList(out?: LayerDraw[]): LayerDraw[];
  lights(filter?: (l: FxLight) => boolean): FxLight[];
  clear(): void;
  readonly count: number;
}
export declare function createFx(host: FxHost, opts?: { style?: Partial<FxStyle>; log?: (m: string) => void }): FxWorld;
export declare const DEFAULT_STYLE: FxStyle;
export declare const PLANE_ORDER: Record<FxPlane, number>;
export declare class FxGL {
  constructor(gl: WebGLRenderingContext | WebGL2RenderingContext, opts?: { log?: (m: string) => void });
  draw(d: LayerDraw, view: number[], pxSnap?: number): boolean;
  warm(def: EffectDef): boolean;
  restore(): void;
  readonly errors: Map<string, string>;
}
export declare function blendPremultiplied(gl: WebGLRenderingContext): void;
export declare function viewMatrix(vx: number, vy: number, scale: number, tw: number, th: number, flipY?: boolean): number[];
export declare function defineEffect(def: Record<string, unknown>): EffectDef;
/** The hero / monster clips effects are cast with: 4 frames at fps, key = the release frame. */
export declare const CAST_ANIMS: Record<CastAnim, { frames?: number; fps?: number; key?: number; seconds?: number; keyAt?: number; emit: "wand" | "hands" | "bow" | null }>;
/** Seconds from a clip's start to its key frame. */
export declare function keyTime(anim: CastAnim): number;
/** The play() `release` that meets the effect's cast clip at `level`. */
export declare function castRelease(def: EffectDef, level?: number, anim?: CastAnim | null): number;
export declare function stageOf(def: Record<string, unknown>): FxStage;
export declare function soundsOf(def: Record<string, unknown>): FxSoundSlot[];
/** The game's sound event of one slot: "shaders.<family>-<name>.<slot>". */
export declare function soundEvent(id: string, slot: string): string;
export declare const FORMATIONS: Record<FxFormation, { kinds: FxKind[]; label: string; about: string }>;
export declare function formationsOf(def: EffectDef): FxFormation[];
export declare const MAX_VOLLEY: number;
export type Facing = "south" | "south-east" | "east" | "north-east" | "north" | "north-west" | "west" | "south-west";
export declare const FACINGS: Facing[];
/** The art's facing for a SCREEN direction (x right, y down). */
export declare function facingOf(dx: number, dy: number): Facing;
/** A hero's cast point (wand tip / orb / arrow) as play()'s `from`. */
export declare function castFrom(body: FxPoint & { scale?: number }, hero: string, anim: CastAnim, facing: Facing): FxPoint;
export interface ShowcaseBody extends FxPoint { kind?: "hero" | "monster"; height?: number; hero?: string; facing?: Facing; scale?: number }
export interface ShowcaseBodies { caster: ShowcaseBody | null; target: ShowcaseBody | null; extras: ShowcaseBody[]; free: FxPoint }
/** Where the bodies stand for an effect (world units). */
export declare function layout(def: EffectDef, o: { origin: FxPoint; dir?: [number, number]; range?: number; cellWu?: number; pad?: number }): ShowcaseBodies;
/** Play an effect the way it is meant to be seen; start `cast` (the caster's clip) with it. */
export declare function showcase(fx: FxWorld, def: EffectDef, bodies: ShowcaseBodies, opts?: { level?: number; seed?: number; tune?: FxPlay["tune"]; count?: number; formation?: FxFormation; owner?: string }): {
  handle: FxHandle;
  cast: { anim: CastAnim; release: number; frames?: number; fps?: number; key?: number; seconds?: number; keyAt?: number; emit: string | null } | null;
  move: FxPoint | null;
};
export declare function tuneDefaults(def: EffectDef): Record<string, unknown>;
export declare const STANDARD_TUNE: EffectDef["tune"];
export declare const KINDS: FxKind[];
export declare const PLANES: FxPlane[];
export declare function lv(s: { lv: number }, a: number, b: number): number;
export declare function lvq(s: { lv: number }, a: number, b: number): number;
export declare function lvs(s: { lv: number }, a: number, b: number): number;
export declare function tier(s: { level: number }, n: number): 0 | 1;
export declare function rgb(c: string | number[]): [number, number, number];
export declare const box: Record<string, (...a: never[]) => { w: number; h: number; ox: number; oy: number }>;
export declare const glsl: (s: TemplateStringsArray, ...v: unknown[]) => string;
export declare const PRELUDE: string;
export declare const VERT: string;
