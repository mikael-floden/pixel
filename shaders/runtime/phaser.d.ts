import type { FxHost, FxPlay, FxHandle, FxLight, FxStyle, LayerDraw, EffectDef, FxWorld } from "./index";

export interface PhaserFxOptions {
  /** World units -> Phaser world px of that ground point (WorldScene's project()). */
  project: FxHost["project"];
  cellWu?: number;
  basis?: FxHost["basis"];
  /** The game's depth rule for a layer (default nangijalaDepth). */
  depth?: (d: LayerDraw) => number;
  /** Register these definitions now. */
  library?: EffectDef[];
  style?: Partial<FxStyle>;
  /** false: call fx.tick(dt) yourself at the end of your update. Default: scene postupdate. */
  autoUpdate?: boolean;
  log?: (m: string) => void;
}

export declare class PhaserFx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(scene: any, opts: PhaserFxOptions);
  readonly world: FxWorld;
  readonly stats: { layers: number; texels: number; reallocs: number };
  play(id: string, p?: FxPlay): FxHandle;
  register(d: EffectDef): this;
  registerAll(ds: EffectDef[]): this;
  setTuning(t: Record<string, Record<string, unknown>>): this;
  setStyle(s: Partial<FxStyle>): this;
  lights(filter?: (l: FxLight) => boolean): FxLight[];
  /** Compile layers now (a warm-up before the first cast). */
  warm(ids?: string[]): void;
  tick(dtSeconds: number): void;
  clear(): void;
  destroy(): void;
  readonly count: number;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export declare function createPhaserFx(scene: any, opts: PhaserFxOptions): PhaserFx;
export declare function nangijalaDepth(d: LayerDraw): number;
export declare function simpleDepth(d: LayerDraw): number;
export declare function toShaderLight(
  l: FxLight,
  o?: { cellWu?: number; levelPx?: number; levelAt?: (x: number, y: number) => number },
): { col: number; row: number; z: number; radius: number; color: [number, number, number]; flicker: number };
