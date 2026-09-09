/**
 * Consume the maps2 agent's isometric world (maps2/worlds3/<name>/world.json,
 * pixel-maps3: a ground NAME per cell; tiles3 resolves the art at draw time).
 * Mirrors the geometry the maps pipeline documents (maps2/pipeline/render3.py):
 *
 *   screen_x = origin_x + (col - row) * grid_dx
 *   screen_y = origin_y + (col + row) * grid_dy   - level * level_height
 *
 * Draw back-to-front by (col+row, row); within a raised cell stack from level 0
 * up so the side faces build a solid block and the top shows its diamond.
 */

export type Cell = WorldCell;

export interface World {
  width: number;
  height: number;
  rows: Cell[][];
  pois: { x: number; y: number; label: string; tile?: string }[];
  /** maps2: player spawn cell (col,row). */
  spawn?: [number, number];
  /** Grid-aligned solids (fixtures only; no shipped world places any). */
  props?: WorldProp[];
  /** Elevated walkable slabs (roofs, bridge decks). */
  decks?: Deck[];
  /** maps3: the published rooms — one floor each (WORLD3.md). */
  rooms?: { ground: string; cells: { col: number; row: number }[] }[];
  /** maps3: the world's own projection (see geometryFor). Absent on v1/v2. */
  iso?: IsoGeometry;
  /** maps3: the grounds the world declares liquid. */
  liquids?: string[];
  /** maps3: per-cell wall-BODY override, keyed row*width+col. */
  wallSides?: Record<number, string>;
  /** maps3: off-grid set dressing (scenery3 draws it). */
  scenery?: { piece: string; x: number; y: number; hflip?: boolean; lit?: boolean }[];
}

import { ISO_DX, ISO_DY, LEVEL_PX, isoOf, WorldCell, WorldProp, Deck, parseWorld } from "@nangijala/shared";
import type { IsoGeometry } from "@nangijala/shared";
import { gameUrl, resolveStagingBase, fetchSoon } from "./staging";
import { isoFrame, columnX, columnY, DX as R3_DX, DY as R3_DY } from "./tiles3";

export type { WorldProp, Deck };

/** True when this world is a `pixel-maps3/world@1` world: cells name a ground
 * TYPE and no art, and the art is resolved at draw time (tiles3). The `iso`
 * field is the marker because parseWorld3 is the only producer of it. */
export function isMaps3World(world: World): boolean {
  return !!world.iso;
}

// The default geometry (grid steps dx=32/dy=15, one elevation level = 16px,
// LEVEL_PX) — what a world without its own `iso` draws at. dx/dy live in
// shared/ (ISO_DX/ISO_DY) because screen-relative input math on the server
// must use the same ratio.
export const MAP_GEOMETRY = { tile: 64, dx: ISO_DX, dy: ISO_DY, lh: LEVEL_PX, margin: 8 };

/** THE GEOMETRY A WORLD DRAWS AT. `MAP_GEOMETRY` is the DEFAULT (32/15/16);
 * a maps3 world publishes its own `iso` (32/14/15) through `parseWorld3`, and
 * every projection in the client reads THIS rather than the module constant. A
 * world without `iso` (a hand-built `rows` literal) gets exactly the object
 * above. */
export type MapGeometry = typeof MAP_GEOMETRY;
export function geometryFor(world?: { iso?: IsoGeometry } | null): MapGeometry {
  const g = isoOf(world);
  if (g.dx === MAP_GEOMETRY.dx && g.dy === MAP_GEOMETRY.dy && g.lh === MAP_GEOMETRY.lh) return MAP_GEOMETRY;
  return { ...MAP_GEOMETRY, dx: g.dx, dy: g.dy, lh: g.lh };
}

// The default world when the player hasn't picked one — the_game, THE game
// (maintainer 2026-09-09: the only world). It's the preselected pick on a
// fresh join (no stored choice) AND the top row of the picker (see
// orderWorlds). The maps agent adds worlds under maps2/worlds3/<name>/; a world
// becomes playable + selectable once it has a world.json (see worlds.json,
// built by scripts/build-worlds.mjs).
export const DEFAULT_WORLD = "the_game";

/* -- WHICH TREE A WORLD LIVES IN ------------------------------------------- */
// `maps2/worlds3` holds pixel-maps3/world@1 (semantics only — tiles3 resolves
// its art at draw time); it is the only tree since tiles2 and the world@1/@2
// worlds were retired (2026-09-09). The name->tree map stays so every
// world-file URL in the client still comes from one place.
const WORLD_ROOT_DEFAULT = "maps2/worlds3";

// Name -> tree, learned from worlds.json / the staging policy at boot.
const worldRoots = new Map<string, string>();

/** Record a world's tree. Called by loadWorldsList/stagingWorlds as the picker
 *  learns them; harmless to call twice with the same value. */
export function setWorldRoot(name: string, root: string | null | undefined): void {
  if (root && /^maps2\/worlds3$/.test(root)) worldRoots.set(name, root);
}

export function worldRoot(name: string): string {
  return worldRoots.get(name) ?? WORLD_ROOT_DEFAULT;
}

/** Served URL for one file of one world. Goes through gameUrl at the call
 *  sites (this returns the IMAGE-relative form, which gameUrl maps to the CDN
 *  when a staging world is active). */
export function worldFileUrl(name: string, file: string): string {
  return `/assets/${worldRoot(name)}/${name.replace(/[^a-z0-9_-]/gi, "")}/${file}`;
}

export function worldUrl(name: string): string {
  return worldFileUrl(name, "world.json");
}

/* -- THE MAP TAB'S IMAGE, AND WHERE THE PLAYER IS ON IT --------------------- */
// A world's map image is a RENDER (maps2/pipeline/render3.py, minimap.webp),
// so the "you are here" dot must be placed by THAT renderer's projection —
// the render's own published arithmetic when it ships one (minimap.json),
// else the client's proven replica of render3's frame. Both live here because
// `worldFileUrl` is the one place a world-file URL is built and `geometryFor`
// the one place a world's projection is read.
//
// PERCENTAGES ARE SCALE-INVARIANT, which is why the renderer's output scaling
// (min(0.5, 16300/fw); WebP hard-limits a side to 16383px) never appears
// below: only the FULL canvas origin and size matter, and both are integers.

/** The live feed the Map tab reads from `window.__ml.minimap()` (WorldScene). */
export interface MinimapFeed {
  /** World id — resolved to a URL through `worldFileUrl`, never concatenated. */
  world: string;
  /** Grid width in cells. */
  w: number;
  /** Grid height in cells. */
  h: number;
  /** The world's tallest terrain level: BOTH renderers lift the canvas origin
   *  by it, so the dot is wrong everywhere without it. */
  maxL: number;
  /** Local player's fractional cell (fx / CELL_WU). */
  col: number;
  /** Local player's fractional cell (fy / CELL_WU). */
  row: number;
  /** Terrain level under the player — the iso dot lifts with the ground. */
  level: number;
  /** The world's own projection (`World.iso`, set by parseWorld3). */
  iso?: IsoGeometry;
}

/** Cell -> fraction of render3's overview canvas (maps3). */
function maps3DotFrac(m: MinimapFeed): [number, number] {
  // render3's origin, from the client's PROVEN replica of it rather than a
  // second copy of the constants: `isoFrame` is render3.render()'s ox/oy/canvas
  // for a window, and the map image is the window x0=y0=0, x1=w, y1=h. Note it
  // takes BOTH pitches — the origin's headroom is render3's literal WALL (17),
  // the per-level lift is the MEASURED storey pitch (`iso.lh`, 15).
  const f = isoFrame({ x0: 0, y0: 0, x1: m.w, y1: m.h }, m.maxL, geometryFor(m).lh);
  const [fullW, fullH] = f.canvas;
  // columnX is the cell's 64-box LEFT edge and columnY is its top diamond's
  // APEX row (a 64x46 plate's row 0 IS the apex — the same anchor scenery3
  // derives its placements from). The diamond is 64x28 on this lattice, so its
  // CENTRE is +DX across and +DY down.
  return [
    (columnX(f, m.col, m.row) + R3_DX) / fullW,
    (columnY(f, m.col, m.row, m.level) + R3_DY) / fullH,
  ];
}

/** Player cell (col,row) at terrain `level` -> [x%, y%] of the world's map
 *  image. `meta` is the render's OWN projection when maps2 published one
 *  (minimap.json) and outranks both replicas — it is the only thing that knows
 *  where a cropped render was cut. Clamped, because `fx/fy` can ease a hair
 *  past the rim. */
export function minimapDotPct(m: MinimapFeed, meta?: MinimapMeta | null): [number, number] {
  const [fx, fy] = meta ? metaDotFrac(m, meta) : maps3DotFrac(m);
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return [clamp(fx) * 100, clamp(fy) * 100];
}

/** The world's map-tab image, in the order to try it. `minimap` is the ONLY
 *  name (maps2 d8a399b1a6): render3 writes its map render as `minimap.webp`
 *  beside the world. `overview.webp` is DELETED —
 *  it was the 16300x7576 / 15 MB review render, and asking for it now would
 *  only 404 on the way to the fallback; the QA render lives behind `--full`
 *  and never ships. The `.png` entry is the format-agnostic probe the Map tab
 *  has always done, so no domain has to hand us a format.
 *
 *  DELIBERATELY UNVERSIONED (no `withV`): these names are STABLE and the art
 *  behind them is regenerable, so the URL must never carry a one-year
 *  `immutable` grant. Unstamped, the server answers `no-cache`
 *  (server/src/cachepolicy.ts) and a regenerated map is picked up on the next
 *  load; for a staging world `gameUrl` rewrites it to the sha-pinned CDN, where
 *  a cached copy can only ever be the whole of one commit. When maps2 moves
 *  these outputs to hashed names + an index, THIS is the function that reads
 *  the index — nothing else in the client names the file. */
export function mapImageUrls(w: { world: string; iso?: IsoGeometry }): string[] {
  return [".webp", ".png"].map((ext) => gameUrl(worldFileUrl(w.world, "minimap" + ext)));
}

/* -- THE RENDER'S OWN PROJECTION (pixel-maps3/minimap@1) -------------------- */
// maps2 d8a399b1a6: the map render draws deep water as NOTHING and crops the
// transparent border away, so the file is only the island — and a fraction of
// the full iso canvas is then wrong BY CONSTRUCTION. The crop is not something
// the client can re-derive (it depends on where the land happens to reach), so
// maps2 publishes the arithmetic beside the image and we use it verbatim:
//
//     px = kx*(x - y) + x0        py = ky*(x + y) - kz*level + y0
//
// giving the CENTRE of that cell's top face, which is where a body stands.
// Fractional cells are fine (the player stands between cells). Every world
// that ships this doc is placed by it; anything that does not falls back to
// the client's replica of the renderer's own frame, which is still right for
// an uncropped render.
export interface MinimapMeta {
  schema: string;
  image?: string;
  size: { w: number; h: number };
  world?: { w: number; h: number };
  dot: { kx: number; x0: number; ky: number; kz: number; y0: number };
}

const MINIMAP_SCHEMA = "pixel-maps3/minimap@1";
const minimapMeta = new Map<string, MinimapMeta | null>();

/** The doc for a world, fetched once. `null` means "asked, hasn't got one" —
 *  cached too, so a world without the sidecar costs exactly one 404. */
export async function loadMinimapMeta(world: string): Promise<MinimapMeta | null> {
  const seen = minimapMeta.get(world);
  if (seen !== undefined) return seen;
  let doc: MinimapMeta | null = null;
  try {
    const res = await fetch(gameUrl(worldFileUrl(world, "minimap.json")));
    if (res.ok) {
      const j = (await res.json()) as MinimapMeta;
      // Every field the formula needs, or it is not usable — a half-written
      // doc must fall back rather than put the dot at NaN%.
      const d = j?.dot;
      const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
      if (
        j?.schema === MINIMAP_SCHEMA && num(j?.size?.w) && num(j?.size?.h) &&
        d && num(d.kx) && num(d.x0) && num(d.ky) && num(d.kz) && num(d.y0)
      ) doc = j;
      else console.warn("[nangijala] minimap.json unusable for", world, j?.schema);
    }
  } catch {}
  minimapMeta.set(world, doc);
  return doc;
}

/** Cell -> fraction of the PUBLISHED image, straight from the doc. */
function metaDotFrac(m: MinimapFeed, meta: MinimapMeta): [number, number] {
  const { kx, x0, ky, kz, y0 } = meta.dot;
  return [
    (kx * (m.col - m.row) + x0) / meta.size.w,
    (ky * (m.col + m.row) - kz * m.level + y0) / meta.size.h,
  ];
}

/** Learn every world's TREE from the built manifest, with none of the picker's
 *  admin/staging round trips — for callers that need only the URL mapping. */
export async function loadWorldRoots(): Promise<void> {
  try {
    const res = await fetchSoon("/worlds.json", 8000, { cache: "no-cache" });
    if (!res.ok) return;
    const list = (await res.json()) as WorldInfo[];
    if (Array.isArray(list)) for (const w of list) setWorldRoot(w.name, w.root);
  } catch {}
}

export async function loadWorld(name: string = DEFAULT_WORLD): Promise<World | null> {
  try {
    const res = await fetch(gameUrl(worldUrl(name)));
    if (!res.ok) return null;
    return parseWorld(await res.json());
  } catch {
    return null;
  }
}

/** NAMED INDOOR PLACES (maps2 `places.json`, schema pixel-maps2/places@1): the
 * maps agent labels the interiors — "the_cave", "meadow_house" — so the game
 * can react to WHERE the player is standing rather than re-deriving it from
 * geometry. The composer uses it to put a specific score inside a specific
 * room (maintainer 2026-08-08: cave4 inside the_cave, day or night).
 *
 * Returned as a cell lookup because that is the only question anyone asks of
 * it — "what am I standing in?" — and a 472-cell polygon test per frame would
 * be silly when a Map hit is O(1). Missing file is not an error: a world may
 * simply have no named places, and the game must not care. */
export type PlaceLookup = { at(cx: number, cy: number): string | null; ids: string[] };

export async function loadPlaces(name: string = DEFAULT_WORLD): Promise<PlaceLookup | null> {
  const url = gameUrl(worldFileUrl(name, "places.json"));
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const doc = (await res.json()) as { places?: { id?: string; cells?: [number, number][] }[] };
    const byCell = new Map<number, string>();
    const ids: string[] = [];
    for (const p of doc.places ?? []) {
      if (!p?.id || !Array.isArray(p.cells)) continue;
      ids.push(p.id);
      // One integer key per cell — cheaper than a string and collision-free for
      // any world under 65536 cells wide.
      for (const c of p.cells) if (Array.isArray(c)) byCell.set(((c[0] | 0) << 16) | (c[1] & 0xffff), p.id);
    }
    if (!byCell.size) return null;
    return { at: (cx, cy) => byCell.get(((cx | 0) << 16) | (cy & 0xffff)) ?? null, ids };
  } catch {
    return null;
  }
}

/** One selectable world (client/public/worlds.json, built by build-worlds.mjs). */
export interface WorldInfo {
  name: string;
  label: string;
  n?: number | null;
  schema?: string | null;
  spawn?: [number, number] | null;
  preview?: string | null;
  /** A DEV map: offered only to a signed-in admin (build-worlds marks
   * anything outside config/publish.json's userWorlds). */
  dev?: boolean;
  /** Not in this image at all — joined via the staging path (staging.ts
   * client-side, WorldRoom's GitHub fallback server-side). */
  staging?: boolean;
  /** The tree this world's files live in: "maps2/worlds3" (pixel-maps3, the
   * only tree since 2026-09-09; the default when omitted). */
  root?: string;
}

/** The list of playable worlds for the selector, DEFAULT_WORLD first. Falls back
 * to just the default when the manifest is missing (older build / maps agent
 * hasn't run yet). */
export async function loadWorldsList(): Promise<WorldInfo[]> {
  try {
    const res = await fetchSoon("/worlds.json", 8000, { cache: "no-cache" });
    if (res.ok) {
      const list = (await res.json()) as WorldInfo[];
      if (Array.isArray(list) && list.length) {
        // Register every entry's tree BEFORE any filtering — worldUrl() and the
        // sidecar fetches read this map, and a world dropped from the offered
        // list can still be re-entered from `ml-last-choice`.
        for (const w of list) setWorldRoot(w.name, w.root);
        // DEV MAPS are shipped so they WORK (the server reads world.json off
        // disk — a map the image lacks cannot be joined at all) but they are
        // not the game. An end user is offered only `userWorlds`; a signed-in
        // admin gets everything, which is how the maintainer keeps testing
        // house_demo/glow_test on the live site with no laptop.
        //
        // Fail CLOSED: any error, no token, or a server that says no ⇒ the
        // player-facing list. The gate is a product boundary, not a security
        // one (the repo is public and the maps are readable on GitHub) — the
        // point is that the game never OFFERS them.
        //
        // DEV BUILDS ARE EXEMPT. `npm run dev` is the harness every verify gate
        // drives, and those gates call __mlSelect.pickWorld() to reach
        // house_demo / glow_test / monster_demo. Filtering there would not make
        // anything safer (it is localhost against the working tree) and would
        // silently break the whole gate suite.
        if (import.meta.env.DEV) return orderWorlds(list);
        if (!(await isAdmin())) return orderWorlds(list.filter((w) => !w.dev));
        // ADMIN: also offer the STAGING worlds — dev maps that are not in this
        // image at all (config/publish.json ships only userWorlds since
        // 2026-08-15). Their names come from the committed policy via the
        // staging CDN; joining one streams its data from the repo (staging.ts
        // client-side, WorldRoom's GitHub fallback server-side). Any failure
        // here just means the picker shows what the image has.
        return orderWorlds([...list, ...(await stagingWorlds(new Set(list.map((w) => w.name))))]);
      }
    }
  } catch {}
  return [{ name: DEFAULT_WORLD, label: "The Game" }];
}

/** Dev worlds the image does NOT carry, from the committed publish policy. */
async function stagingWorlds(have: Set<string>): Promise<WorldInfo[]> {
  try {
    const base = await resolveStagingBase();
    if (!base) return [];
    const res = await fetchSoon(`${base}games2/config/publish.json`, 2500);
    if (!res.ok) return [];
    // `devWorlds3` names maps2/worlds3 (pixel-maps3) staging worlds — the only
    // tree since 2026-09-09.
    const policy = (await res.json()) as { devWorlds3?: string[] };
    const from = (names: unknown, root: string): WorldInfo[] =>
      (Array.isArray(names) ? names : [])
        .filter((n): n is string => typeof n === "string" && /^[a-z0-9_-]+$/i.test(n) && !have.has(n))
        .map((n) => {
          setWorldRoot(n, root);
          return {
            name: n,
            label: n.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
            dev: true,
            staging: true,
            preview: null,
            root,
          };
        });
    return from(policy.devWorlds3, "maps2/worlds3");
  } catch {
    return [];
  }
}

/** Is this browser signed in as the game designer? Asks the SERVER — the token
 * in localStorage is only a claim, and the server is the thing that can check
 * the HMAC. Cached for the page's lifetime: the picker asks once at boot. */
let adminCache: Promise<boolean> | null = null;
function isAdmin(): Promise<boolean> {
  if (adminCache) return adminCache;
  adminCache = (async () => {
    try {
      const token = localStorage.getItem("wiki-admin-token");
      if (!token) return false;
      const res = await fetchSoon("/api/wiki/me", 3000, {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) return false;
      return !!(await res.json())?.admin;
    } catch {
      return false;
    }
  })();
  return adminCache;
}

/** Put DEFAULT_WORLD (the world closest to the real game) at the TOP of the
 * picker, keeping every other world in its manifest order. No-op if it's already
 * first or absent. */
function orderWorlds(list: WorldInfo[]): WorldInfo[] {
  const i = list.findIndex((w) => w.name === DEFAULT_WORLD);
  return i <= 0 ? list : [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
}

export function canvasSize(world: World): { w: number; h: number; ox: number; oy: number; maxLevel: number } {
  const { dx, dy, lh, margin, tile } = geometryFor(world);
  let maxLevel = 0;
  for (const row of world.rows) for (const c of row) if (c.l > maxLevel) maxLevel = c.l;
  return {
    w: (world.width + world.height) * dx + margin * 2,
    h: (world.width + world.height) * dy + tile + maxLevel * lh + margin * 2,
    ox: (world.height - 1) * dx + margin,
    oy: maxLevel * lh + margin,
    maxLevel,
  };
}
