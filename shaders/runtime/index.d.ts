// Types for the effects runtime (shaders/docs/integration.md is the contract).

/** A point in the GAME'S WORLD SPACE: x, y in world units on the ground (the
 *  server's body coordinates), z = height in world px above the ground there. */
export interface FxPoint { x: number; y: number; z?: number }
/** A point, or a function read every frame (a body that moves). */
export type FxPos = FxPoint | (() => FxPoint | null | undefined);

export type FxKind = "burst" | "projectile" | "beam" | "chain" | "aura" | "zone" | "melee" | "screen";
export type FxPlane = "ground" | "body" | "air" | "screen";
export type FxEvent = "release" | "impact" | "peak" | "hit" | "hop" | "start" | "end" | "*";

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
}

export interface FxHandle {
  readonly id: string;
  readonly kind: FxKind | "none";
  readonly seq: number;
  readonly owner?: string;
  /** Seconds from play() to the impact (projectile) or the hit (melee). Schedule damage on it. */
  readonly flightTime: number;
  readonly impactAt: number;
  /** Seconds until the effect ends (Infinity for a sustained effect not yet stopped). */
  readonly duration: number;
  readonly done: boolean;
  readonly time: number;
  /** "impact" | "hit" | "peak" | "hop" (arg = hop index) | "release" | "start" | "end" | "*". */
  on(ev: FxEvent, fn: (arg: number | undefined, h: FxHandle, ev: string) => void): FxHandle;
  /** Move / retarget / re-level a running effect. */
  set(p: Partial<Pick<FxPlay, "at" | "from" | "to" | "dir" | "targets" | "height" | "level" | "radius">>): FxHandle;
  /** Sustained kinds play their outro; one-shots are cut. */
  stop(): void;
  /** Gone this frame, no outro. */
  kill(): void;
  setTune(t: Record<string, number | string | boolean>): FxHandle;
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

export interface EffectDef {
  id: string; name: string; kind: FxKind; family: string; category: string; tags: string[];
  thinking: string; levels: string;
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
