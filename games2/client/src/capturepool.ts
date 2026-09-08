/** ONE CAPTURE TARGET PER SIZE, instead of Phaser's one-for-all that is torn
 *  down and re-allocated on every size change.
 *
 *  THE MECHANISM (Phaser 3.90, read in node_modules). Every DynamicTexture
 *  draw bracket goes `beginDraw -> renderer.beginCapture(w, h) ->
 *  renderer.renderTarget.bind(true, w, h)`, and that ONE shared RenderTarget
 *  was built with autoResize = true, so `bind` calls `resize`, and `resize`
 *  does `deleteFramebuffer + deleteTexture + createTextureFromSource(null, w,
 *  h) + createFramebuffer` whenever the size differs from the LAST bracket's.
 *  The ground RT is 1510x1656 (10 MB of RGBA); the cover atlases are 1024x512
 *  and the light fields 544x708. So a frame that paints a ground slice AND
 *  flushes a cover surface (every slice frame once scenery is on: ~50 cover
 *  flushes a second against ~16 with it off) frees and re-allocates ~12 MB of
 *  GPU memory, twice, on the frame thread. `createTextureFromSource(null, ...)`
 *  returns in ~0.1 ms because the driver only QUEUES the allocation — the
 *  texture-upload probe saw 1,389 of them in one window at 150 ms total — and
 *  the cost lands later, when the GPU process actually allocates, clears and
 *  frees, and when a delete has to wait for the in-flight pass that still
 *  reads the old texture. That is the shape the maintainer described: work
 *  that is only queued where it is measured and paid where it is not.
 *
 *  It fits every observation that killed the other theories: it needs the
 *  ground to paint (travel — circling paints nothing), it needs a second,
 *  differently sized DynamicTexture drawing in the same frames (scenery cover
 *  surfaces; monsters bring their own), and it survives the pink mock, the
 *  flat tint and shadows off, because none of those change the SIZES drawn.
 *
 *  THE FIX: a pool keyed by `${w}x${h}`, each entry a RenderTarget with
 *  autoResize = false, so a bracket only ever binds a texture that already
 *  exists. Steady-state VRAM is the sum of the distinct sizes (~14 MB here)
 *  instead of one texture that thrashes between them. `renderer.renderTarget`
 *  is swapped to the chosen entry before `bind`, because `endCapture` reads and
 *  returns that field — nothing else in Phaser reads it (grepped).
 *
 *  Context loss needs nothing: Phaser's texture and framebuffer WRAPPERS
 *  recreate their GL resources on restore, pooled entries included. */
import Phaser from "phaser";

interface Stats {
  brackets: number; // beginCapture calls
  switches: number; // size differed from the previous bracket = a stock-Phaser realloc
  sizes: number; // distinct sizes seen (= pool entries when installed)
}

type Renderer = Phaser.Renderer.WebGL.WebGLRenderer & {
  beginCapture(width?: number, height?: number): void;
  renderTarget: Phaser.Renderer.WebGL.RenderTarget;
  setProjectionMatrix(width: number, height: number): void;
};

const stats: Stats = { brackets: 0, switches: 0, sizes: 0 };
let prevKey = "";
let installed: { renderer: Renderer; orig: Renderer["beginCapture"]; base: Phaser.Renderer.WebGL.RenderTarget } | null = null;
const pool = new Map<string, Phaser.Renderer.WebGL.RenderTarget>();
const seen = new Set<string>();

function note(w: number, h: number): string {
  const key = `${w}x${h}`;
  stats.brackets++;
  if (key !== prevKey) {
    if (prevKey) stats.switches++;
    prevKey = key;
  }
  if (!seen.has(key)) {
    seen.add(key);
    stats.sizes = seen.size;
  }
  return key;
}

/** Count what stock Phaser does, without changing it. Safe to call twice. */
type AnyRenderer = Phaser.Renderer.WebGL.WebGLRenderer | Phaser.Renderer.Canvas.CanvasRenderer;
const webgl = (r: AnyRenderer): Renderer | null => (r.type === Phaser.WEBGL ? (r as Renderer) : null);

export function installCaptureProbe(r: AnyRenderer): void {
  const renderer = webgl(r);
  if (!renderer) return;
  const tagged = renderer as Renderer & { __mlCaptureProbe?: boolean };
  if (tagged.__mlCaptureProbe) return;
  tagged.__mlCaptureProbe = true;
  const orig = renderer.beginCapture;
  renderer.beginCapture = function (this: Renderer, width?: number, height?: number) {
    note(width ?? this.width, height ?? this.height);
    return orig.call(this, width, height);
  };
}

/** Replace the shared, auto-resizing capture target with the pool. */
export function installCapturePool(r: AnyRenderer): void {
  const renderer = webgl(r);
  if (!renderer || installed) return;
  const RenderTarget = Phaser.Renderer.WebGL.RenderTarget;
  const orig = renderer.beginCapture;
  installed = { renderer, orig, base: renderer.renderTarget };
  renderer.beginCapture = function (this: Renderer, width?: number, height?: number) {
    const w = width ?? this.width;
    const h = height ?? this.height;
    const key = note(w, h);
    let rt = pool.get(key);
    if (!rt) {
      // Same arguments as Phaser's own (scale 1, minFilter 0, autoClear), autoResize OFF.
      rt = new RenderTarget(this, w, h, 1, 0, true, false);
      pool.set(key, rt);
    }
    this.renderTarget = rt;
    rt.bind(true, w, h); // resize() is a no-op on a non-autoResize target
    this.setProjectionMatrix(w, h);
  };
}

export function uninstallCapturePool(): void {
  if (!installed) return;
  const { renderer, orig, base } = installed;
  renderer.beginCapture = orig;
  renderer.renderTarget = base;
  installed = null;
  // Pooled targets are left for the GC; their GL resources go with the wrappers.
  pool.clear();
}

export const capturePoolInstalled = (): boolean => installed !== null;

/** Window snapshot for the beacon; `switches` resets so it is per window. */
export function captureTake(): Stats {
  const out = { ...stats };
  stats.brackets = 0;
  stats.switches = 0;
  return out;
}
