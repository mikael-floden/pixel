// ============================================================================
// WORLD3 — reading `pixel-maps3/world@1` (maps2/worlds3/<name>/world.json)
// ============================================================================
//
// A v2 world BAKES 4,693 tile paths; a v3 world stores only SEMANTICS — a
// ground TYPE per cell, an elevation per cell, decks, wall-body overrides and
// scenery — and the art is resolved at draw time from the tile system's own
// rules. That is what lets a maintainer verdict in the wiki (promote a base
// tile, approve a `#top`) repaint the map with no rebuild.
//
// This module does ONE job: turn that document into the SAME `ParsedWorld` the
// engine already consumes, so collision, findPath, the autopilot, the night
// shader's heightmap and the spawn zones keep working unchanged. It resolves
// no art and loads no tiles — a later milestone wires the renderer.
//
// THE SPEC IS `maps2/pipeline/render3.py`, not a doc: where the two disagree,
// the renderer is what actually draws the map, so it wins here too. Every rule
// below that came from reading it says so.

import { ISO_GEOMETRY_MAPS3 } from "./index";
import type { Deck, ParsedWorld, WorldCell, WorldScenery } from "./index";

/**
 * Parse a `pixel-maps3/world@1` document. Returns null for anything else, so
 * the caller can fall through to the v1/v2 parsers.
 *
 * GRIDS ARE ROW-MAJOR — `ground[y][x]` and `level[y][x]`, y first. This is the
 * highest-risk line in the file: a transposed island is plausible-looking
 * terrain that never crashes, so it is measured rather than assumed. Only the
 * cells that carry EXPLICIT x/y (walls, decks, scenery) can settle it, because
 * the two grids transpose together and agree with each other either way.
 * Measured on the_game's 3,546 distinct wall cells — cells that by definition
 * sit under a cliff or house face, i.e. never at the sea-level floor:
 * `level[y][x]` puts 0 of them at level 0, `level[x][y]` puts 854 there.
 * (server/test/world3.test.ts re-runs that check on every test run.)
 */
export function parseWorld3(json: any): ParsedWorld | null {
  if (!json || typeof json.schema !== "string" || !json.schema.startsWith("pixel-maps3/")) return null;
  const grounds: string[] = Array.isArray(json.grounds) ? json.grounds : [];
  const ground: number[][] = Array.isArray(json.ground) ? json.ground : [];
  const level: number[][] = Array.isArray(json.level) ? json.level : [];
  // Prefer the explicit size (worlds may be non-square); fall back to the grid.
  const height: number = json.size?.h ?? ground.length;
  const width: number = json.size?.w ?? ground[0]?.length ?? height;
  if (!(width > 0) || !(height > 0)) return null;

  // GROUND TYPE IS THE CELL'S `t`. `t` already means "tile category/material" —
  // the key SURFACES is indexed by — and a v3 ground name (grass, deep_water,
  // parquet_floor) is exactly that: what the cell IS, decoupled from what it
  // looks like. So the ground name goes in `t` and NOTHING goes in `path`: a v3
  // cell has no baked art, and inventing one would make client/src/maps.ts
  // think this world ships tiles it can preload. `v` (variant) is 0 — variation
  // is the tile system's own base-tile-set pick at draw time, not world data.
  const rows: WorldCell[][] = [];
  for (let r = 0; r < height; r++) {
    const gr = ground[r];
    const lr = level[r];
    const row: WorldCell[] = new Array(width);
    for (let c = 0; c < width; c++) {
      // ground index -1 = VOID: no ground at all, draw nothing. `t: ""` is how
      // the engine already spells that — surfaceAt/surfaceAtWorldElev return
      // VOID_SURFACE for an empty type (not standable, not swimmable), which is
      // precisely a hole. the_game has zero voids, so this path is unexercised
      // by data and comes from the format's own definition.
      const gi = gr?.[c] ?? -1;
      row[c] = { t: gi >= 0 ? grounds[gi] ?? "" : "", v: 0, l: lr?.[c] ?? 0 };
    }
    rows.push(row);
  }

  // DECKS kept the name and changed shape: `mat:int` became `ground:string`,
  // and cells lost `top`/`mirror` (there is no baked art to point at). They map
  // onto the world@2 `Deck` unchanged otherwise — level, thickness and cells
  // mean the same thing, and `mat` is the deck's MATERIAL name, which is what
  // buildTerrainGrid stores as deckType and reads speed/sound from.
  //
  // `kind` became LOAD-BEARING: roof and cave mean INDOORS (render3.py skips
  // scenery under either — a bush was being drawn on the meadow house's roof),
  // bridge does not. It is carried through verbatim. shared/src/indoor.ts still
  // derives indoor-ness geometrically from the slab, which is deliberate: that
  // test also has to hold for world@2 decks, whose `kind` is only a label.
  //
  // Every deck cell is kept. world@1 dropped cells whose `top` art was missing;
  // here there is no art to be missing, so dropping any cell would silently
  // delete walkable slab.
  const decks: Deck[] = (Array.isArray(json.decks) ? json.decks : []).map((d: any) => ({
    kind: String(d.kind ?? "deck"),
    mat: String(d.ground ?? ""),
    level: d.level ?? 0,
    // render3.py: `int(dk.get("thickness", 1))` — an absent thickness is 1.
    thickness: Math.max(0, d.thickness ?? 1),
    cells: (Array.isArray(d.cells) ? d.cells : []).map((c: any) => ({
      col: c.x,
      row: c.y,
      flip: false, // v3 stores no mirror flag; art (and its mirroring) is resolved at draw time
    })),
  }));

  // WALLS are undocumented in maps2/spec/WORLD3.md; the meaning below is read
  // off render3.py. `[{side, cells[]}]` is a per-cell override of the ground
  // that a cliff/house FACE is built from — the wall BODY, not the cell's top
  // surface. Default (no override) the body is the ground at the face's foot,
  // i.e. the down-screen lower neighbour; the override exists because a house
  // wall standing on parquet or on paving is still stone-and-plaster, and the
  // default would clad it in floor. It changes ART ONLY: the cell's own ground,
  // elevation, walkability and footstep sound are untouched.
  //
  // LATER WINS on a contested cell. render3.py builds `wall_over` as a dict in
  // array order, so the last group to claim a cell sets its material — and
  // the_game HAS such conflicts (145 cells claimed twice, 71 of them by groups
  // naming different materials). Assigning in the same order reproduces the
  // renderer exactly; anything else repaints 71 cells of the stone house.
  /* THE PUBLISHED ROOMS, carried verbatim. maps2 states where a room ENDS
   * rather than leaving it to be guessed — see WORLD3.md, which lists the three
   * ways guessing gets it wrong. Nothing here interprets them. */
  const rooms = (Array.isArray(json.rooms) ? json.rooms : []).map((r: any) => ({
    ground: String(r.ground ?? ""),
    cells: (Array.isArray(r.cells) ? r.cells : []).map((c: any) => ({ col: c.x | 0, row: c.y | 0 })),
  })).filter((r: { ground: string; cells: unknown[] }) => r.ground && r.cells.length);

  const wallSides: Record<number, string> = {};
  for (const grp of Array.isArray(json.walls) ? json.walls : []) {
    const side = String(grp?.side ?? "");
    for (const c of Array.isArray(grp?.cells) ? grp.cells : []) {
      const x = c?.x;
      const y = c?.y;
      // A cell with no coordinate is dropped, never folded onto (0,0): the
      // override table is looked up by index, so a defaulted key would repaint
      // the world's north-west corner.
      if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      wallSides[y * width + x] = side;
    }
  }

  // The facings the scenery manifests publish `rotations` for. A placement may
  // name one; everything else draws south.
  const SCENERY_FACINGS = new Set(["south", "south-east", "south-west"]);

  // SCENERY is off-grid and fractional (feet at a cell's front vertex, so the
  // coordinates land on .5), names a `scenery/<piece>` rather than a tile path,
  // and can be `lit` (selects the piece's LIT_* state after dark). None of that
  // fits `WorldProp`, which is a grid-aligned 64x128 tile PNG that BLOCKS its
  // cell — so it is carried as its own field and drives nothing yet. Collision
  // stays off until scenery publishes a hitbox: no canonical field ships today
  // (WORLD3.md flags it), and blocking a whole cell per piece would wall the
  // player out of 1,388 cells on the strength of a guess.
  const scenery: WorldScenery[] = (Array.isArray(json.scenery) ? json.scenery : [])
    .map((p: any) => ({
      piece: String(p?.piece ?? ""),
      x: Number(p?.x),
      y: Number(p?.y),
      hflip: !!p?.hflip,
      lit: !!p?.lit,
      /* THE FACING THE MAP ASKED FOR. Only the three the scenery domain
       * publishes rotations for; anything else is a typo and falls back to
       * south rather than resolving to a missing file. */
      ...(SCENERY_FACINGS.has(String(p?.dir)) ? { dir: String(p.dir) } : {}),
      // THE VARIATION, kept verbatim: the piece's own states map is the only
      // authority on which keys exist, and it is read at draw time — an unknown
      // key falls through to the base still rather than drawing nothing.
      ...(typeof p?.state === "string" && p.state ? { state: p.state } : {}),
    }))
    .filter((p: WorldScenery) => !!p.piece && Number.isFinite(p.x) && Number.isFinite(p.y));

  // LIQUIDS: the world DECLARES which of its grounds are liquid; SURFACES
  // DECIDES what that means for a player. The engine wins on gameplay — it owns
  // movement, and `check-surfaces` is the gate that keeps every ground
  // classified — so nothing here touches swimmability; a ground is swimmable
  // iff SURFACES says so. `liquids` is kept because the RENDERER needs the
  // world's own answer for things SURFACES has no opinion about: render3.py
  // uses it to draw liquids as flat colour with NO wall, and to refuse a liquid
  // as a wall body. The two must not disagree — a ground listed here that the
  // engine lets you walk on is a bug in one of them — and world3.test.ts
  // asserts they agree for every ground the_game uses.
  const liquids: string[] = (Array.isArray(json.liquids) ? json.liquids : []).map((s: any) => String(s));

  const sp = json.spawn;
  const spawn = Array.isArray(sp) && sp.length >= 2 ? ([sp[0], sp[1]] as [number, number]) : undefined;

  // `pois` is empty and `faceTiles`/`props` are absent by construction: v3
  // names no tile art at all, so there is nothing for the client to preload.
  return {
    width,
    height,
    rows,
    pois: [],
    spawn,
    decks: decks.length ? decks : undefined,
    rooms: rooms.length ? rooms : undefined,
    // THE PROJECTION TRAVELS WITH THE WORLD. tiles3 lays out on dy=14 with a
    // 15px storey; the engine's constants are tiles2's 15/16. A v3 world that
    // projects at 15 shears one row per grid step, so the geometry is published
    // here — the ONE place that knows the doc is a maps3 doc — and every
    // consumer reads it through `isoOf`. world@1/@2 never gets the field.
    iso: ISO_GEOMETRY_MAPS3,
    liquids: liquids.length ? liquids : undefined,
    wallSides: Object.keys(wallSides).length ? wallSides : undefined,
    scenery: scenery.length ? scenery : undefined,
  };
}

/** The wall-BODY ground for a cell, or "" when the world names no override
 * (then the renderer's default applies — the ground at the face's foot). */
export function wallSideAt(world: ParsedWorld, col: number, row: number): string {
  return world.wallSides?.[row * world.width + col] ?? "";
}
