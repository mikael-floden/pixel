/* THE WORLD BATCHES SIXTEEN TEXTURES A DRAW ON A PHONE TOO (games-perf 2026-09-25).
 *
 * Phaser 3.90 gives every Game Object on a device it does not call a desktop —
 * `Device.os.desktop` is false for his Android UA — the MobilePipeline
 * (`autoMobilePipeline`, on unless the game config says otherwise). That is
 * Single.frag with `forceZero`, under which `pushBatch` opens a new batch, i.e.
 * a new drawArrays, on EVERY texture change. The world is thousands of distinct
 * tile textures drawn in painter order, so his phone issues a draw call per
 * texture switch — 384 to 1,754 a frame (window means) through his
 * c0efbebe66 run — where a desktop issues ~100 for the same picture. His late
 * frames climb with those draws: 523 of that run's 532 followed a frame of
 * more than 500, late 1.5% of the time at <=500 against 36.8% past 2,000. A
 * headless run never saw any of it: a desktop UA gets the MultiPipeline.
 *
 * The MultiPipeline — which the ground RT has drawn with on his phone since its
 * A/B — keeps up to `maxTextures` (16 on his Mali) textures bound per batch.
 * Same vertex shader (plus the unit index), same UVs, same fragment math
 * (Multi.frag samples the quad's own unit, then applies the tint Single.frag
 * applies), so every pixel is the same; the render A/B harness holds it. What
 * it costs is on the GPU: the fragment shader walks a chain of up to 15
 * compares to its unit — which no headless run can price.
 *
 * OPT-IN until a run of his with it on shows the frame better (the terrain
 * bake's law, docs/perf.md): `?multipipe=1` / localStorage `ml-multi-pipe`
 * "1" / Settings→Dev "draw: multi-texture batches". Read once, at boot — the
 * game config is the only place Phaser takes it (PipelineManager.boot picks
 * the default pipeline once), so a press applies from the next load. */

type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void };

/** Reached through `globalThis`: the server's tsconfig (its tests import this)
 *  has no DOM. */
const env = (): { location?: { search: string }; localStorage?: Storage } =>
  globalThis as { location?: { search: string }; localStorage?: Storage };

const KEY = "ml-multi-pipe";

/** The choice the NEXT boot takes (a `?multipipe=0|1` is stored first). A page
 *  without storage reads as off — Phaser's own default. */
export function multiPipeOn(): boolean {
  const g = env();
  try {
    const q = new URLSearchParams(g.location?.search ?? "").get("multipipe");
    if (q === "0" || q === "1") g.localStorage?.setItem(KEY, q);
    return g.localStorage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** The stored choice alone — what a Settings→Dev press flips (the query is
 *  consumed at boot; reading it again would undo every press). */
export function multiPipeStored(): boolean {
  try {
    return env().localStorage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Store the choice for the next load (the Settings→Dev press). */
export function setMultiPipe(on: boolean): void {
  try {
    env().localStorage?.setItem(KEY, on ? "1" : "0");
  } catch {
    /* no storage: the press cannot outlive the page, and says so by not changing state */
  }
}

/** Textures one batch of the default pipeline can hold — 1 under `forceZero`
 *  (the MobilePipeline), the renderer's units otherwise; 0 when there is no
 *  WebGL pipeline. The beacon's `counts.mainUnits`: which arm a window ran. */
export function mainBatchUnits(renderer: unknown): number {
  const r = renderer as { maxTextures?: number; pipelines?: { default?: { forceZero?: boolean } | null } } | null;
  const def = r?.pipelines?.default;
  if (!def) return 0;
  return def.forceZero ? 1 : Math.max(1, r?.maxTextures ?? 1);
}

/** The Settings→Dev state: the arm this page RUNS, and what a reload brings
 *  when the stored choice differs. `running` is `mainBatchUnits(...) > 1`;
 *  `mobile` is Phaser's `!Device.os.desktop` — a desktop gets the
 *  MultiPipeline whatever is stored, so there the switch changes nothing. */
export function multiPipeState(running: boolean, mobile: boolean): string {
  if (!mobile) return running ? "on (desktop: always)" : "off";
  const next = multiPipeStored();
  const now = running ? "on" : "off";
  return next === running ? now : `${now}, ${next ? "on" : "off"} after reload`;
}
