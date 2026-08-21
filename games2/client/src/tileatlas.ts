/**
 * TILE ATLAS LOADER — boot a maps2 world from 1-2 packed sheets instead of
 * hundreds of individual tile requests (the_island2: 571 → 2; maintainer
 * 2026-08-14, the "repack the tiles" half of the container-split ask).
 *
 * THE SHAPE OF THE TRICK: nothing downstream changes. Every draw site keys
 * textures by `pathTileKey(path)` (`t2:<path>`) — redrawGround's batchDraw,
 * the occluder pass, the debris builder, flippedKey. So the atlas is purely a
 * LOADING strategy: fetch the world's committed sheet(s), then SLICE each
 * frame into its own small canvas texture registered under the exact key the
 * per-file load would have produced. The renderer cannot tell the difference —
 * same keys, same standalone textures, same GPU footprint as before.
 *
 * FALLBACK IS THE INVARIANT: any failure — no committed atlas, a pruned stale
 * one (check-atlas.mjs deletes atlases whose digest no longer matches the
 * tiles, so a stale atlas 404s rather than showing OLD ART), a sheet that
 * fails to decode, a frame missing from the index — degrades to loading that
 * tile individually, exactly as before atlases existed. Slower, never wrong.
 *
 * Sheets are lossless WebP (repo law: lossless=True + exact=True in the
 * packer, self-verified byte-for-byte against every source tile), so a sliced
 * frame is pixel-identical to the file it replaces.
 */
import type Phaser from "phaser";
import { World, distinctTilePaths, distinctPropPaths, pathTileKey, assetUrl } from "./maps";
import { withV } from "./assetver";
import { gameUrl } from "./staging";

interface AtlasIndex {
  schema: string;
  world: string;
  tilesetDigest: string;
  sheets: string[];
  frames: Record<string, [number, number, number, number, number]>; // [sheet, x, y, w, h]
}

export interface TileAtlasLoad {
  /** Register per-path textures from the loaded sheets. Call FIRST thing in
   * create(): the ground RT and occluder passes resolve keys via
   * textures.exists and silently skip missing ones. */
  finalize(scene: Phaser.Scene): void;
  /** QA (__ml.atlasInfo): how this world's tiles actually arrived. */
  stats(): { world: string; index: boolean; sheets: number; sliced: number; individual: number };
}

/**
 * Queue this world's tile art in preload(). Tries the committed atlas first;
 * queues individual tiles only for what the atlas cannot provide. Everything
 * is decided inside the load phase via Phaser's dynamic file injection —
 * files added from a loader callback join the same load barrier, so create()
 * still starts with every texture source present.
 */
/** Fetch a world's atlas index at BOOT (main.ts), crash-proof: any failure is
 * null, and null means per-file tiles. Never let a loader parse this. */
export async function fetchAtlasIndex(worldName: string): Promise<AtlasIndex | null> {
  try {
    const r = await fetch(withV(gameUrl(`/atlases/${worldName}.json`)));
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return null; // the SPA fallback is text/html
    return (await r.json()) as AtlasIndex;
  } catch {
    return null;
  }
}

export function queueTileLoads(scene: Phaser.Scene, world: World, worldName: string, prefetched: AtlasIndex | null): TileAtlasLoad {
  const needed = [...new Set([...distinctTilePaths(world), ...distinctPropPaths(world)])];
  const idxKey = `atlas:${worldName}`;
  const sheetKey = (i: number) => `atlas:${worldName}:${i}`;
  let index: AtlasIndex | null = null;
  let sheetsQueued = 0;
  let individual = 0;
  let sliced = 0;
  const queuedIndividually = new Set<string>();

  const loadIndividually = (paths: string[]) => {
    for (const p of paths) {
      if (queuedIndividually.has(p) || scene.textures.exists(pathTileKey(p))) continue;
      queuedIndividually.add(p);
      individual++;
      scene.load.image(pathTileKey(p), withV(gameUrl(assetUrl(p))));
    }
  };

  // THE INDEX ARRIVES FROM BOOT, ALREADY FETCHED — learned in production
  // 2026-08-22, with the whole world black. A PRUNED atlas (maps2 regenerated
  // the world; the deploy correctly dropped the stale index) does not 404:
  // the SPA fallback answers 200 WITH index.html, Phaser's JSON loader threw
  // on "<!doctype" inside onProcess, and NEITHER filecomplete nor loaderror
  // fired — so the documented per-file fallback never ran and ZERO tiles
  // loaded. The index is now fetched with fetch()+try/catch at boot
  // (fetchAtlasIndex, awaited in main.ts beside world.json) and handed in
  // here synchronously: every possible failure — missing file, HTML
  // masquerading as JSON, network error, wrong schema — is the same answer,
  // load the tiles individually, decided before the loader ever runs.
  if (!prefetched || prefetched.schema !== "nangijala/tile-atlas@1" || prefetched.world !== worldName || !prefetched.frames) {
    loadIndividually(needed);
  } else {
    index = prefetched;
    for (let i = 0; i < (index.sheets?.length ?? 0); i++) {
      sheetsQueued++;
      scene.load.image(sheetKey(i), withV(gameUrl(`/atlases/${index.sheets[i]}`)));
    }
    // Tiles the atlas does not carry (should be none — the packer uses the
    // same paths[] the world does — but a partial index must not 404 art).
    loadIndividually(needed.filter((p) => !index!.frames[p]));
  }
  scene.load.on("loaderror", (file: Phaser.Loader.File) => {
    if (file.key.startsWith(`atlas:${worldName}:`)) {
      // A sheet died mid-download: every tile it carried loads individually.
      const i = Number(file.key.slice(`atlas:${worldName}:`.length));
      if (index) loadIndividually(needed.filter((p) => index!.frames[p]?.[0] === i));
    }
  });

  return {
    finalize(s: Phaser.Scene) {
      if (!index) return;
      for (const p of needed) {
        const f = index.frames[p];
        if (!f) continue;
        const key = pathTileKey(p);
        if (s.textures.exists(key)) continue;
        const [si, x, y, w, h] = f;
        const sheet = s.textures.exists(sheetKey(si)) ? s.textures.get(sheetKey(si)) : null;
        const src = sheet?.getSourceImage() as CanvasImageSource | null;
        if (!src) continue; // sheet failed → its tiles were queued individually
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        cv.getContext("2d")!.drawImage(src, x, y, w, h, 0, 0, w, h);
        s.textures.addCanvas(key, cv);
        sliced++;
      }
      // The sheets exist only to be sliced — drop them so the GPU never holds
      // a 2048² texture the renderer will not draw from.
      for (let i = 0; i < sheetsQueued; i++) if (s.textures.exists(sheetKey(i))) s.textures.remove(sheetKey(i));
      if (s.cache.json.exists(idxKey)) s.cache.json.remove(idxKey);
    },
    stats: () => ({ world: worldName, index: !!index, sheets: sheetsQueued, sliced, individual }),
  };
}
