/**
 * BODY ATLAS LOADER — boot the characters and monsters from packed sheets
 * instead of ~3,400 individual sprite requests (measured 2026-08-15: two
 * playable characters alone are 1,201 frame files, and the boot spends 4.6 s
 * on per-file loads even against a zero-latency server).
 *
 * Same trick as tileatlas.ts, and deliberately the same shape: this is purely
 * a LOADING strategy. Every sheet is sliced into textures registered under the
 * EXACT keys the per-file loads produced — `f:<uid>:<state>:<dir>:<n>` for
 * character frames (manifest.frameKey) and `msheet:<id>:<anim>:<dir>` for
 * monster strips — so buildAnimations, the anchors/plants/waterline machinery
 * and every draw site are untouched and cannot tell which path ran.
 *
 * A MONSTER STRIP IS A SPRITESHEET, NOT A FRAME. Slicing it out of the sheet
 * gives one image containing N frames, so the numbered frames are re-added by
 * hand (`tex.add(i, 0, i*fw, 0, fw, fh)`) exactly as Phaser's SpriteSheet
 * parser would — with the strip's OWN measured frame size, carried in the
 * index, because a monster-level size goes stale on in-place art repairs and
 * the frames then bleed.
 *
 * FALLBACK IS THE INVARIANT: no committed index, a pruned stale one, a sheet
 * that fails to download or decode, a unit missing from the index — every one
 * of them degrades to loading that unit's files individually, exactly as
 * before atlases existed. Slower, never wrong pixels, never a boot that dies.
 *
 * WHY THE UNIT IS (BODY, STATE) and not (BODY): the client's load ORDER is
 * tuned to the state — boot takes BOOT_ANIM_STATES only, the deferred batch
 * leads with PLAYER_URGENT_STATES, and each state's clips register the moment
 * that state's own art lands. One sheet per character would drag die/kick/
 * spell art into the boot batch and undo all of it. Per (body, state) each
 * state is still exactly one awaitable file.
 *
 * NOT WIRED INTO WorldScene YET, AND THE REASON IS A MEASUREMENT. The version
 * below is correct — A/B'd on the dev stack it sliced all 3,425 items,
 * registered 104/104 clips, drew every monster and failed nothing — but it is
 * SLOWER than the per-file loads it replaces: 11.0 s vs 5.0 s to a playable
 * world, because `finalizeUnit` spends 2,688 ms of SYNCHRONOUS time at boot
 * copying 1,577 frames (createElement + drawImage + addCanvas ≈ 1.7 ms each,
 * and every copy is its own GPU upload). Removing ~700 HTTP requests does not
 * pay for that: the boot was already measured as CPU-bound, not
 * bandwidth-bound (10.4 s localhost vs 16.8 s on slow 4G — bandwidth is only
 * about a third of it).
 *
 * THE FIX IS ZERO-COPY, and it is what an atlas is supposed to do: register
 * ONE texture per sheet and add named frames INTO it
 * (`texture.add(name, 0, x, y, w, h)`), so nothing is copied and each sheet
 * uploads once. `buildAnimations` then emits `{key: sheetKey, frame: frameKey}`
 * instead of a bare texture key, and the few direct draw sites (the idle
 * portrait) pass texture+frame. That trades this module's "every draw site is
 * untouched" property for the performance the feature exists to deliver —
 * worth it, but it touches the anchors/plants/waterline path, so it wants its
 * own round with the same A/B rerun before it goes live.
 *
 * THE INDEX IS FETCHED ONCE, AT BOOT. That is what lets the DEFERRED batch
 * decide synchronously (index already parsed) and so keep its per-state
 * registration bookkeeping. At boot the decision necessarily happens inside
 * the index's own load callback — files added from a loader callback join the
 * same barrier, so create() still starts with every texture present.
 */
import type Phaser from "phaser";
import { withV } from "./assetver";
import { gameUrl } from "./staging";

const SCHEMA = "nangijala/body-atlas@1";
const IDX_KEY = "bodyatlas:index";

type FrameRect = [number, number, number, number];
type StripRect = [number, number, number, number, number, number]; // + frame w/h

interface UnitEntry {
  digest: string;
  sheet: string;
  kind: "frames" | "strips";
  items: Record<string, FrameRect | StripRect>;
}
interface BodyIndex {
  schema: string;
  packer: number;
  units: Record<string, UnitEntry>;
}

export const charUnit = (uid: string, state: string) => `c:${uid}:${state}`;
export const monsterUnit = (id: string, anim: string) => `m:${id}:${anim}`;

const sheetKeyFor = (unit: string) => `batlas:${unit}`;

export class BodyAtlas {
  private index: BodyIndex | null = null;
  private queued = new Set<string>(); // units whose sheet is queued
  private done = new Set<string>(); // units already sliced
  private failed = new Set<string>(); // units whose sheet died → per-file
  private slicedItems = 0;
  private sliceMs = 0; // QA: slicing is synchronous, so it must stay cheap

  /** Is the index in hand yet? Boot callers must not assume it is. */
  get ready(): boolean {
    return this.index !== null;
  }

  /**
   * Fetch the committed index. Call once, in the boot preload. Everything
   * else keys off whether this landed.
   */
  queueIndex(scene: Phaser.Scene, onReady?: () => void): void {
    if (this.index) {
      onReady?.();
      return;
    }
    scene.load.json(IDX_KEY, withV(gameUrl("/atlases/bodies.json")));
    scene.load.once(`filecomplete-json-${IDX_KEY}`, (_k: string, _t: string, data: BodyIndex) => {
      // A wrong or half-formed index means "no atlas", never a crash mid-boot.
      if (data && data.schema === SCHEMA && data.units) this.index = data;
      if (scene.cache.json.exists(IDX_KEY)) scene.cache.json.remove(IDX_KEY);
      onReady?.();
    });
    scene.load.once("loaderror", (file: Phaser.Loader.File) => {
      // No committed atlas (or pruned as stale) — the pre-atlas behaviour.
      if (file.key === IDX_KEY) onReady?.();
    });
  }

  /** Does the atlas carry this unit? False whenever the index is absent. */
  has(unit: string): boolean {
    return !!this.index?.units[unit] && !this.failed.has(unit);
  }

  /**
   * Queue this unit's sheet. Returns the loader key whose FILE_COMPLETE means
   * "this unit's art is in" — the caller awaits that instead of N frame keys,
   * which is what keeps the per-state registration working. Returns null when
   * the atlas cannot serve the unit, and the caller must load it per file.
   */
  queueUnit(scene: Phaser.Scene, unit: string): string | null {
    const e = this.index?.units[unit];
    if (!e || this.failed.has(unit)) return null;
    const key = sheetKeyFor(unit);
    if (this.done.has(unit) || this.queued.has(unit)) return key;
    this.queued.add(unit);
    scene.load.image(key, withV(gameUrl(`/atlases/${e.sheet}`)));
    return key;
  }

  /**
   * Slice a unit's sheet into its individual textures. Idempotent, and safe to
   * call when the sheet never arrived (the unit is simply marked failed, and
   * `has` then reports false so the caller can fall back).
   */
  finalizeUnit(scene: Phaser.Scene, unit: string): void {
    const e = this.index?.units[unit];
    if (!e || this.done.has(unit)) return;
    const key = sheetKeyFor(unit);
    const src = scene.textures.exists(key) ? (scene.textures.get(key).getSourceImage() as CanvasImageSource) : null;
    if (!src) {
      this.failed.add(unit); // sheet died → caller loads this unit per file
      return;
    }
    this.done.add(unit);
    const t0 = performance.now();
    for (const [itemKey, rect] of Object.entries(e.items)) {
      if (scene.textures.exists(itemKey)) continue;
      const [x, y, w, h] = rect;
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      cv.getContext("2d")!.drawImage(src, x, y, w, h, 0, 0, w, h);
      const tex = scene.textures.addCanvas(itemKey, cv);
      if (tex && e.kind === "strips") {
        // Re-add the numbered frames a spritesheet load would have produced.
        const fw = (rect as StripRect)[4] || w;
        const fh = (rect as StripRect)[5] || h;
        const cols = Math.max(1, Math.floor(w / fw));
        for (let i = 0; i < cols; i++) tex.add(i, 0, i * fw, 0, fw, fh);
      }
      this.slicedItems++;
    }
    this.sliceMs += performance.now() - t0;
    // The sheet exists only to be sliced — drop it so the GPU never holds a
    // texture the renderer will not draw from.
    if (scene.textures.exists(key)) scene.textures.remove(key);
  }

  /** Slice everything queued so far (batch COMPLETE handlers). */
  finalizeAll(scene: Phaser.Scene): void {
    for (const u of [...this.queued]) this.finalizeUnit(scene, u);
  }

  /** QA (__ml.bodyAtlasInfo). */
  stats() {
    return {
      index: !!this.index,
      units: this.index ? Object.keys(this.index.units).length : 0,
      queued: this.queued.size,
      sliced: this.done.size,
      items: this.slicedItems,
      sliceMs: Math.round(this.sliceMs),
      failed: [...this.failed],
    };
  }
}
