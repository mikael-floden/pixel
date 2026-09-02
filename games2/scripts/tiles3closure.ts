/** THE TILES3 ART CLOSURE of a published maps2/worlds3 world — every file the
 *  real resolver names for every cell, corner and deck of the world, and
 *  nothing else. The image ships this set (scripts/ship-tiles3.ts, run in the
 *  Dockerfile's build stage) instead of the tiles/ domain: measured on
 *  the_game, 508 files / 0.3 MB of a 400 MB domain, resolved in ~1 s.
 *
 *  It is the RENDERER's own enumeration — Tiles3World.cell/boundary/decks and
 *  the same cellArtPaths/boundaryArtPaths/deckArtPaths the scene hands to its
 *  loader — so it cannot drift from what the game will ask for; a JSON-level
 *  approximation could. Pixel offsets in the frame are irrelevant to WHICH
 *  files are named, so the frame here is zero-anchored. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseWorld, ISO_GEOMETRY_MAPS3 } from "../shared/src/index";
import { Tiles3 } from "../client/src/tiles3";
import type { Frame } from "../client/src/tiles3";
import {
  Tiles3World,
  TILES3_DOCS,
  tiles3DataFrom,
  sheetPaths,
  cellArtPaths,
  boundaryArtPaths,
  deckArtPaths,
  viewFromParsed,
} from "../client/src/tiles3runtime";

export interface Tiles3ClosureWorld {
  name: string;
  width: number;
  height: number;
  cells: number;
  boundaries: number;
  decks: number;
  /** Resolver throws, caught per cell exactly as the scene's t3Try does. */
  failures: number;
}

export interface Tiles3Closure {
  /** The index documents the resolver boots from (TILES3_DOCS), those present. */
  docs: string[];
  /** Repo-relative art files, sorted, unique. */
  art: string[];
  /** Named by the resolver but absent under `root` — a 404 in production. */
  missing: string[];
  bytes: number;
  worlds: Tiles3ClosureWorld[];
  warnings: string[];
}

/** `worldNames` are taken as maps2/worlds3 names; a name without a world.json
 *  there is skipped (a maps2/worlds world has no tiles3 closure). */
export function tiles3ArtClosure(root: string, worldNames: readonly string[]): Tiles3Closure {
  const warnings: string[] = [];
  const docs: Partial<Record<keyof typeof TILES3_DOCS, unknown>> = {};
  const docPaths: string[] = [];
  for (const [k, p] of Object.entries(TILES3_DOCS) as Array<[keyof typeof TILES3_DOCS, string]>) {
    const f = join(root, p);
    if (!existsSync(f)) continue;
    docs[k] = JSON.parse(readFileSync(f, "utf8"));
    docPaths.push(p);
  }
  const data = tiles3DataFrom(docs, ISO_GEOMETRY_MAPS3.lh, (m) => warnings.push(m));
  if (!data) throw new Error("tiles3: no ground_types/patterns under " + root);
  const tiles = new Tiles3(data);
  const paths = new Set<string>();
  const out = (p: string | undefined | null) => {
    if (p) paths.add(p);
  };
  for (const p of sheetPaths(data.patterns)) out(p);
  const worlds: Tiles3ClosureWorld[] = [];
  for (const name of worldNames) {
    const wj = join(root, "maps2", "worlds3", name, "world.json");
    if (!existsSync(wj)) continue;
    const world = parseWorld(JSON.parse(readFileSync(wj, "utf8")));
    if (!world) {
      warnings.push(`tiles3: ${name}/world.json did not parse`);
      continue;
    }
    const view = viewFromParsed(world as never);
    const frame = {
      x0: 0,
      y0: 0,
      x1: world.width,
      y1: world.height,
      ox: 0,
      oy: 0,
      pitch: ISO_GEOMETRY_MAPS3.lh,
      canvas: [1, 1],
    } as unknown as Frame;
    const t3 = new Tiles3World({ view, tiles, frame, patterns: data.patterns });
    const w: Tiles3ClosureWorld = { name, width: world.width, height: world.height, cells: 0, boundaries: 0, decks: 0, failures: 0 };
    for (let r = 0; r <= world.height; r++) {
      for (let c = 0; c <= world.width; c++) {
        if (c < world.width && r < world.height) {
          try {
            const cell = t3.cell(c, r);
            if (cell) {
              cellArtPaths(cell, out);
              // The mid storey a cut-away draws in place of the stack tile
              // (cellBlits): named here too, so a cut never finds a hole.
              if (cell.kind !== "field" && cell.wall) out(cell.wall.mid?.path);
              w.cells++;
            }
          } catch {
            w.failures++;
          }
          try {
            for (const d of t3.decks(c, r)) {
              deckArtPaths(d, out);
              w.decks++;
            }
          } catch {
            w.failures++;
          }
        }
        try {
          const b = t3.boundary(c, r);
          if (b) {
            boundaryArtPaths(b, out);
            w.boundaries++;
          }
        } catch {
          w.failures++;
        }
      }
    }
    worlds.push(w);
  }
  const art = [...paths].sort();
  const missing: string[] = [];
  let bytes = 0;
  for (const p of art) {
    const f = join(root, p);
    if (!existsSync(f)) missing.push(p);
    else bytes += statSync(f).size;
  }
  return { docs: docPaths.sort(), art, missing, bytes, worlds, warnings };
}
