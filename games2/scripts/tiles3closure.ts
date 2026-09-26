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
import { Tiles3, isRampSet } from "../client/src/tiles3";
import { rampMaskRaw, slopeRunShares } from "../client/src/rampfield";
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
  /** Cells with NO ground — a void the resolver answers null for. They draw
   *  nothing and name no art, so they are neither resolved cells nor failures;
   *  the gate counts them so `cells + void` is the whole grid. */
  void: number;
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
  /* THE GAME'S OWN RULES, as WorldScene sets them on its resolver (the foot,
   * the deck lid, and with the foot the slope on both sides of a rise and the
   * unjudged-ground fallback). Without them this enumerated the parity path's
   * picks: measured on production 2026-09-24, every slope file the game's
   * rule asked for that the parity rule had not (a cut's flat tile, a
   * light_soil set) answered 404, the cap op was dropped, and the wall's own
   * flat top showed — "not a single slope" on a terrace the resolver dressed. */
  data.footBoundary = true;
  data.deckBoundary = true;
  const tiles = new Tiles3(data);
  /* EVERY COMPLETE SLOPE SET OF EVERY GROUND THE WORLD USES SHIPS, not only
   * the tiles today's verdicts pick: his verdicts are the LIVE channel, read
   * without a redeploy, and a set he approves at 19:00 must not 404 until the
   * next container. 15 seeds x 16 tiles per ground, ~2.6 MB for the_game. */
  const groundsSeen = new Set<string>();
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
    const w: Tiles3ClosureWorld = { name, width: world.width, height: world.height, cells: 0, void: 0, boundaries: 0, decks: 0, failures: 0 };
    for (let r = 0; r <= world.height; r++) {
      for (let c = 0; c <= world.width; c++) {
        if (c < world.width && r < world.height) {
          try {
            const cell = t3.cell(c, r);
            if (cell) {
              groundsSeen.add(cell.ground);
              cellArtPaths(cell, out);
              // The mid storey a cut-away draws in place of the stack tile
              // (cellBlits): named here too, so a cut never finds a hole.
              if (cell.kind !== "field" && cell.wall) out(cell.wall.mid?.path);
              w.cells++;
            } else w.void++;
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
    /* AND THE SLOPES THE GAME DRAWS (slopeheight.ts, auto by default): a ramp
     * on a ground change lifts its composed transition, whose two plates the
     * rule above — no ramps — may never ask for at that cell. Only the ramp
     * candidates are resolved again (rampfield `rampMaskRaw`, ~2k cells), under
     * every share at once (`fixed` 100: the plates do not depend on the height). */
    const mask = rampMaskRaw(world as never);
    const tr = new Tiles3({ ...data, slopeHeight: 1, slopeShares: slopeRunShares(world as never, 100), slopeSharesW: world.width });
    const tw = new Tiles3World({ view, tiles: tr, frame, patterns: data.patterns });
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      try {
        const cell = tw.cell(i % world.width, Math.floor(i / world.width));
        if (cell) cellArtPaths(cell, out);
      } catch {
        w.failures++;
      }
    }
    worlds.push(w);
  }
  for (const st of data.slopes?.sets ?? []) {
    if (!groundsSeen.has(st.ground) || !st.complete || (st.post_files?.length ?? 0) !== 16 || isRampSet(st)) continue;
    for (const f of st.post_files as string[]) out(`${st.dir}/post/${f}`);
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
