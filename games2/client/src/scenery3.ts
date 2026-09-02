/* SCENERY 3.0 — "where does this piece stand, and what does it draw", as a pure
 * function.
 *
 * A `pixel-maps3/world@1` document carries a `scenery[]` of {piece, x, y,
 * hflip, lit} at CONTINUOUS cell coordinates (the_game: 1,388 placements, 205
 * distinct pieces). This module is everything between that list and a sprite a
 * scene can blit: the anchor projection, the crop/scale/flip/paste fit, the
 * per-piece manifest normalisation, and the spatial index that answers "what is
 * in this camera window" without ever building 1,388 sprites.
 *
 * THE SPEC IS `maps2/pipeline/render3.py` (its scenery pass, `render()` step 3)
 * plus `scenery/README.md`. Where the two disagree render3 wins and the
 * disagreement is named at the line it affects. Proven against render3's own
 * paste positions in server/test/fixtures/tiles3-parity.json (24 placements) by
 * server/test/scenery3.test.ts.
 *
 * PURE, SYNCHRONOUS, HOST-FREE, like tiles3.ts: no Phaser, no DOM, no fs. The
 * two things that need a host are declared structurally — decoded pixels for
 * `alphaBBox`, and a `fetchJson` for `SceneryPieces`. Geometry, the iso frame
 * and `rint` are IMPORTED from tiles3/tiles3draw rather than restated: scenery
 * and terrain must land in one coordinate system or the whole world shears.
 *
 * WHAT STAYS OUTSIDE: nothing here creates a sprite, owns a texture, or decides
 * depth beyond publishing render3's own painter key. A caller turns a
 * `SceneryFit` into whatever its renderer speaks.
 */

import { DX, DY, columnX, columnY, type Bounds, type Frame } from "./tiles3";
import { assetPath, rint, type Pixels, type UrlRoute } from "./tiles3draw";

/* -- the world's half ------------------------------------------------------- */

/** One placement as `parseWorld3` publishes it (shared/src/index.ts
 *  `WorldScenery`), structurally so a raw doc's array satisfies it too. */
export interface ScenerySpec {
  piece: string;
  /** CONTINUOUS cell coordinates. Integers are NOT cell centres — see
   *  `anchorX`/`anchorY`. */
  x: number;
  y: number;
  hflip?: boolean;
  lit?: boolean;
  /** "south" | "south-east" | "south-west" — see facedSprite. */
  dir?: string;
}

/** A deck as either producer spells its cells: the raw v3 doc uses `x`/`y`,
 *  `ParsedWorld` uses `col`/`row`. One reader, both shapes — a scene holding a
 *  ParsedWorld must not have to re-key 979 cells to ask this question. */
export interface SceneryDeckLike {
  kind?: string;
  cells: readonly ({ x?: number; y?: number; col?: number; row?: number })[];
}

/* -- geometry: THE ANCHOR --------------------------------------------------- */

/* An integer (x, y) projects to the cell diamond's NORTH (top) vertex, NOT its
 * centre — derived from render3, which pastes a piece at
 *
 *     sx = ox + (x - x0 - (y - y0)) * DX
 *     sy = oy + (x - x0 + (y - y0)) * DY - z * pitch
 *
 * while it pastes a TILE's 64-box at `(columnX, columnY - TOP_Y)`, i.e. with
 * the box row TOP_Y (the diamond's apex row) landing exactly on `columnY`.
 * `columnX + DX` is that box's horizontal centre. So the scenery anchor IS
 * (columnX + DX, columnY): the apex. `(x+0.5, y+0.5)` therefore lands on the
 * diamond CENTRE, and maps2 places most pieces on `.5` coordinates for exactly
 * that reason (203 of the_game's 1,388 sit on an exact .5; the rest are
 * scattered off it and are equally continuous).
 *
 * GET THIS WRONG AND NOTHING LOOKS BROKEN: dropping the +0.5 convention, or
 * reading the doc's "front vertex" wording (render3's own docstring says front;
 * its code says apex — the CODE is the spec) puts all 1,388 pieces half a tile
 * out, consistently, and a half-tile-uphill forest is a picture you have to
 * measure to disbelieve.
 *
 * The elevation term is the MEASURED storey pitch (`Frame.pitch`, 15 on
 * the_game), never WALL (17) — the same pitch the terrain columns stack at, so
 * a tree on a terrace stands on the terrace and not in it. */

/** Screen x of a placement's feet. */
export function anchorX(f: Frame, x: number, y: number): number {
  return columnX(f, x, y) + DX;
}

/** Screen y of a placement's feet, at the cell's level. */
export function anchorY(f: Frame, x: number, y: number, level: number): number {
  return columnY(f, x, y, level);
}

/** The cell a continuous placement reads its LEVEL and its roof from. render3
 *  uses Python `int()`, which truncates toward zero; every world coordinate is
 *  positive so this equals a floor, and `Math.trunc` keeps the two identical if
 *  a negative ever appears. */
export function anchorCell(p: ScenerySpec): [number, number] {
  return [Math.trunc(p.x), Math.trunc(p.y)];
}

/** render3's own window test, on the CONTINUOUS coordinates — a piece whose
 *  anchor cell is inside the window but whose x is not (x = 435.6 against
 *  x1 = 436) is dropped by render3 and must be dropped here. */
export function inBounds(p: ScenerySpec, b: Bounds): boolean {
  return p.x >= b.x0 && p.x < b.x1 && p.y >= b.y0 && p.y < b.y1;
}

/** The cells a ROOF or CAVE deck covers, as `y * width + x` keys. A piece under
 *  one is INDOORS and render3 skips it: drawing it put a bush on the meadow
 *  house's roof. A BRIDGE deck does not hide anything — you walk under a bridge
 *  and the scenery below is meant to be seen. (the_game: 979 roofed cells hide
 *  124 of 1,388 placements.) */
export function roofedCells(
  decks: readonly SceneryDeckLike[] | undefined,
  width: number,
): Set<number> {
  const out = new Set<number>();
  for (const d of decks ?? []) {
    if (d.kind !== "roof" && d.kind !== "cave") continue;
    for (const c of d.cells) {
      const x = c.x ?? c.col;
      const y = c.y ?? c.row;
      if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
      out.add((y as number) * width + (x as number));
    }
  }
  return out;
}

/* -- the manifest ----------------------------------------------------------- */

/* A piece id is a DIRECTORY: "bushes/bush_001" -> scenery/bushes/bush_001/
 * scenery.json. The manifest's `sprite` is DOMAIN-relative ("bushes/bush_001/
 * sprite.webp"), served at /assets/scenery/<sprite>.
 *
 * THE SHAPE IS MOVING under us (the scenery agent is adding SE/SW facings and
 * has just moved animations from the piece down onto the states), so every read
 * here is defensive and every shape below was counted on disk 2026-08-29 over
 * all 712 published pieces:
 *
 *   - `animations` at the PIECE (the old placement): 712 of 712 now carry it as
 *     an empty object. Read anyway — a piece that still has one is normalised
 *     onto its base state, which is where the new shape puts it.
 *   - `animations` under a STATE (the new placement): 1,368 animations across
 *     177 pieces, always {wind|flame: {frame_paths[], strip, frame_count,
 *     keep_first_frame, directions}}. `frame_paths` is always a list.
 *   - `states`: 710 of 712 pieces. Families LIT_* + NOT_LIT_* (472), NOT_LIT_*
 *     only (148), LIGHTS_ON/LIGHTS_OFF (57), LIT_* only (33), none (2).
 *   - FACINGS: `rotations` on the piece (90) and on a state (116), keyed
 *     "south"/"south-east"/"south-west". 14 states publish rotations with NO
 *     south key at all (windows mid-generation) — their own `sprite` IS the
 *     south still, so `southSprite` falls back to it and never returns a
 *     south-east file for a south draw.
 *
 * Anything else is ignored, once, through `warn`. This module never throws on a
 * manifest. */

/** One idle clip attached to a state. `frames` (the per-frame files) is the
 *  canonical form: it is always the state still's own canvas, which is what
 *  `frameRect` registers against. `strip` is an optional horizontal sheet —
 *  usable, but its frame size must be read off the sheet, never assumed: 42 of
 *  1,368 strips are NOT `frame_count * still_w` wide (crystal_trees ships a
 *  340x68 strip for a 64x64 still). */
export interface SceneryAnim {
  name: string;
  frames: string[];
  strip: string | null;
  frameCount: number;
  /** Frame 0 IS the state's still (`keep_first_frame`), so a clip that starts
   *  on frame 0 starts from the pose the static draw already shows. */
  keepFirstFrame: boolean;
}

export interface SceneryState {
  key: string;
  /** Domain-relative SOUTH still for this state. */
  sprite: string;
  rotations: Record<string, string>;
  anims: Record<string, SceneryAnim>;
}

export interface SceneryPiece {
  /** "group/id", the directory. */
  id: string;
  /** The piece's own SOUTH still — what an unlit placement draws. */
  sprite: string;
  /** `placement.world_px_height`: the height the art is SCALED TO in the world,
   *  independent of its art resolution. null when the manifest omits it, and
   *  the caller then falls back to the source canvas height (render3's `or
   *  sp.height`). Read from the PIECE even when a lit STATE is drawn — a lit
   *  variant is the same object, at the same size. */
  worldPxHeight: number | null;
  /** `must_be_imbplemented_with_random_hflip` (sic — the shipped key name).
   *  FALSE where left and right already mean something: every `windows` piece
   *  and the three legacy 8-direction pieces. The world's own `hflip` is still
   *  honoured when set — this flag is advice to whoever PLACES, and maps2 has
   *  already placed. */
  hflipOk: boolean;
  states: Record<string, SceneryState>;
  /** The state whose sprite IS `sprite` — where the base still's animation now
   *  lives after the move under states. 124 of 712 pieces have a base-level
   *  `animations/` directory on disk and all 124 resolve through here. Always a
   *  key of `states`: a piece publishing no matching state gets a synthesised
   *  "" entry, so every draw path goes through one shape. */
  baseState: string;
  /** The LIGHTS_ON state, if the piece ships one. NOT what render3 selects for
   *  a `lit` placement (see `litState`) — it is what the night pass will
   *  crossfade a window to. */
  lightsOn: string | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function parseAnims(raw: unknown, where: string, warn: (m: string) => void): Record<string, SceneryAnim> {
  const out: Record<string, SceneryAnim> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, a] of Object.entries(raw as Record<string, any>)) {
    if (name === "__proto__") continue; // see parsePiece
    if (!a || typeof a !== "object") {
      warn(`scenery3: ${where}.animations.${name} is not an object — ignored`);
      continue;
    }
    const frames = Array.isArray(a.frame_paths) ? a.frame_paths.filter((p: unknown) => !!str(p)) : [];
    const strip = str(a.strip) || null;
    if (!frames.length && !strip) {
      warn(`scenery3: ${where}.animations.${name} names no frames — ignored`);
      continue;
    }
    out[name] = {
      name,
      frames,
      strip,
      frameCount: Number.isFinite(a.frame_count) ? a.frame_count : frames.length,
      keepFirstFrame: a.keep_first_frame !== false,
    };
  }
  return out;
}

function parseRotations(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (str(v)) out[k] = str(v);
  return out;
}

/** Normalise one `scenery.json`. Returns null only when the doc names no sprite
 *  at all — every other surprise degrades to the plain sprite and warns once. */
export function parsePiece(
  id: string,
  json: any,
  warn: (m: string) => void = () => {},
): SceneryPiece | null {
  if (!json || typeof json !== "object") {
    warn(`scenery3: ${id} manifest is not an object`);
    return null;
  }
  const sprite = str(json.sprite);
  if (!sprite) {
    warn(`scenery3: ${id} manifest names no sprite`);
    return null;
  }
  const pieceRot = parseRotations(json.rotations);
  // THE OLD PLACEMENT, kept alive on purpose: animations that still sit on the
  // piece belong to the piece's own still, which is the base state's still.
  const legacy = parseAnims(json.animations, id, warn);

  const states: Record<string, SceneryState> = {};
  const rawStates = json.states && typeof json.states === "object" && !Array.isArray(json.states)
    ? (json.states as Record<string, any>)
    : {};
  for (const [key, s] of Object.entries(rawStates)) {
    // `__proto__` as an own property of a JSON object is real, and assigning it
    // on an object literal sets the PROTOTYPE instead of a state.
    if (key === "__proto__") continue;
    if (!s || typeof s !== "object") {
      warn(`scenery3: ${id} state ${key} is not an object — ignored`);
      continue;
    }
    const ss = str(s.sprite);
    if (!ss) {
      warn(`scenery3: ${id} state ${key} names no sprite — ignored`);
      continue;
    }
    states[key] = {
      key,
      sprite: ss,
      rotations: parseRotations(s.rotations),
      anims: parseAnims(s.animations, `${id}#${key}`, warn),
    };
  }

  const baseState = Object.keys(states).find((k) => states[k].sprite === sprite) ?? null;
  if (baseState && Object.keys(legacy).length && !Object.keys(states[baseState].anims).length)
    states[baseState] = { ...states[baseState], anims: legacy };

  // The piece's still is always addressable as a state, even when the manifest
  // publishes none (2 of 712) — so every draw path goes through one shape.
  const base = baseState ?? "";
  if (!baseState)
    states[base] = { key: base, sprite, rotations: pieceRot, anims: legacy };
  else if (!Object.keys(states[baseState].rotations).length && Object.keys(pieceRot).length)
    states[baseState] = { ...states[baseState], rotations: pieceRot };

  const ph = json.placement && typeof json.placement === "object" ? json.placement.world_px_height : null;
  return {
    id,
    sprite,
    // `or sp.height` in render3: 0 falls back too, and so does a non-number.
    worldPxHeight: typeof ph === "number" && ph > 0 ? ph : null,
    hflipOk: json.must_be_imbplemented_with_random_hflip !== false,
    states,
    baseState: base,
    lightsOn: states.LIGHTS_ON ? "LIGHTS_ON" : null,
  };
}

/* -- which state, which facing ---------------------------------------------- */

/** render3's `lit` selection, to the character: the alphabetically FIRST state
 *  key starting with "LIT". Note what that does NOT match — "NOT_LIT_1" and
 *  "LIGHTS_ON" both fail `startsWith("LIT")`, so a window is never selected by
 *  a `lit` placement and a NOT_LIT variant is never mistaken for a lit one. All
 *  8 of the_game's lit placements land on a real LIT_* state. A night pass that
 *  wants windows lit reads `piece.lightsOn`, which is a different question. */
export function litState(piece: SceneryPiece): string | null {
  const keys = Object.keys(piece.states).filter((k) => k.startsWith("LIT")).sort();
  return keys.length ? keys[0] : null;
}

/** The state a placement draws. Falls through to the base still whenever the
 *  requested state does not exist — a `lit` placement of a piece with no LIT_*
 *  state draws unlit rather than nothing. */
export function stateFor(piece: SceneryPiece, lit?: boolean, override?: string | null): SceneryState {
  const key = (override && piece.states[override] ? override : null)
    ?? (lit ? litState(piece) : null)
    ?? piece.baseState;
  return piece.states[key] ?? { key: "", sprite: piece.sprite, rotations: {}, anims: {} };
}

/** The still for a state, in the facing the PLACEMENT asked for.
 *
 *  This used to be `southSprite`, on the stated premise that "world placements
 *  name none" — which the data has since falsified: 70 of the_game's 1,421
 *  placements carry `dir`, 42 south-west and 28 south-east, and every one of
 *  them was being drawn facing south (maintainer 2026-08-30: "This is wrong! I
 *  don't want it like that!"). A `windows` piece hung on a south-east wall is
 *  exactly what those facings exist for.
 *
 *  Falls back the way it always did: the asked-for rotation, else south, else
 *  the state's own sprite — which is what the 14 mid-generation states with a
 *  south-less `rotations` map need. So a placement naming a facing the piece
 *  does not publish still draws, rather than resolving to a missing file. */
export function facedSprite(state: SceneryState, dir?: string): string {
  return (dir ? state.rotations[dir] : "") || state.rotations.south || state.sprite;
}

/** The south still. Kept for callers that mean SOUTH specifically. */
export function southSprite(state: SceneryState): string {
  return facedSprite(state);
}

/* -- the fit: crop -> scale -> flip -> paste --------------------------------- */

export type BBox = [number, number, number, number];

/** PIL `Image.getbbox()` on the ALPHA channel — right half-open, so
 *  `[l, t, r, b]` with width `r - l`. null for a fully transparent image.
 *
 *  PIL's own getbbox is the bbox of pixels that are non-zero in ANY channel,
 *  and our WebP is written with `exact=True` (CLAUDE.md), which PRESERVES the
 *  RGB under fully transparent pixels — so the two definitions can legitimately
 *  differ, and a browser cannot even see the difference (canvas storage is
 *  premultiplied; a read-back transparent pixel is 0,0,0,0). MEASURED over all
 *  712 published sprites: 0 disagree. Alpha-only is therefore a lawful port,
 *  and this comment is why it is allowed to stay one.
 *
 *  It is a full scan of the source, so measure ONCE PER DISTINCT PIECE and keep
 *  the result beside the texture — never per placement (the_game would pay for
 *  1,388 scans instead of 205) and never per frame. */
export function alphaBBox(px: Pixels): BBox | null {
  let l = px.w, t = px.h, r = -1, b = -1;
  for (let y = 0; y < px.h; y++) {
    const row = y * px.w;
    for (let x = 0; x < px.w; x++) {
      if (px.data[(row + x) * 4 + 3] === 0) continue;
      if (x < l) l = x;
      if (x > r) r = x;
      if (y < t) t = y;
      if (y > b) b = y;
    }
  }
  return r < 0 ? null : [l, t, r + 1, b + 1];
}

/** Everything a renderer needs to draw one placement's still, in the frame's
 *  own pixel space (`Frame.canvas`) — a streaming renderer offsets by its own
 *  window origin, exactly as `Tiles3Blit` does. */
export interface SceneryFit {
  /** SOURCE crop: the still's own alpha bbox, in source pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination of that crop. Integers, and `Math.trunc` not `Math.floor` —
   *  render3 pastes at Python `int()`. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Mirror about the CROP's centre — never the source canvas centre. render3
   *  flips the CROPPED, SCALED art, so an asymmetric bbox moves the piece if the
   *  flip is taken about the canvas instead — MEASURED on the_game: 245 of its
   *  599 flipped placements shift a pixel or more that way, tree_021 by 16. */
  flipX: boolean;
  /** The scale actually applied, per axis: `w / sw` and `h / sh`. Not the ideal
   *  `wantH / sh` — the integer rounding below is what the still is drawn at,
   *  and an animation frame must use the SAME numbers or it swims against its
   *  own still by up to a pixel. */
  kx: number;
  ky: number;
  /** The feet point this was placed on, unrounded — for depth, sound, lights. */
  ax: number;
  ay: number;
}

/** render3's scenery transform, in its order: crop to the opaque bbox, scale so
 *  the CROPPED HEIGHT equals `wantH`, flip AFTER scaling, composite
 *  bottom-centre at the anchor.
 *
 *  The rounding is Python's `round()` — HALF TO EVEN. `rint` (tiles3draw) is
 *  that rule; a port that rounds half-up is a pixel wider on 6 of the_game's
 *  1,388 placements (measured). The fixture's 24 do NOT contain one — the
 *  half-to-even cases in scenery3.test.ts are what actually guard it. */
export function fitSprite(
  bbox: BBox | null,
  canvas: { w: number; h: number },
  wantH: number | null,
  ax: number,
  ay: number,
  flipX = false,
  /* THE SCALE IS THE PIECE'S, NOT THE DRAWN SPRITE'S. `world_px_height` describes
   * the PIECE, so deriving k from whatever sprite happens to be drawn forces
   * every rotation and every state to exactly that height and throws away the
   * size difference between them. A rotation shows the top face and is
   * naturally taller, so squashing it draws it SMALLER — measured over
   * the_game's rotations: 20 of 29 piece+facing combinations more than 5% off,
   * 8 more than 15%, worst cupboard_008 south-west at +32%.
   *
   * It is also what pulls the HITBOX off its art, which is how it was noticed
   * (maintainer 2026-09-02: "the hitboxes doesn't align with the big hitbox
   * review I did in the wiki"): stampSceneryCollision scales the published
   * ellipse by the BASE sprite's bbox, so any placement drawn at a different
   * scale gets an outline that is the wrong size and in the wrong place. The
   * maps2 agent hit this first on their renderer and posted the warning — "the
   * same trap is waiting in games2' fitSprite, which also measures the sprite it
   * draws; it will bite the moment dir and state land there". It did.
   *
   * Pass the base sprite's bbox HEIGHT and the rotation keeps its own
   * proportions relative to the piece. Omitted, this is the old behaviour
   * exactly, which is what every base-sprite placement already wants. */
  scaleH?: number,
): SceneryFit {
  // A fully transparent sprite has no bbox; PIL's `crop(None)` copies the whole
  // image, so the whole canvas is the crop.
  const [l, t, r, b] = bbox ?? [0, 0, canvas.w, canvas.h];
  const sw = Math.max(1, r - l);
  const sh = Math.max(1, b - t);
  const want = wantH && wantH > 0 ? wantH : canvas.h;
  const k = want / (scaleH && scaleH > 0 ? scaleH : sh);
  const w = Math.max(1, rint(sw * k));
  const h = Math.max(1, rint(sh * k));
  return {
    sx: l,
    sy: t,
    sw,
    sh,
    x: Math.trunc(ax - w / 2),
    y: Math.trunc(ay - h),
    w,
    h,
    flipX,
    kx: w / sw,
    ky: h / sh,
    ax,
    ay,
  };
}

/** Where an ANIMATION frame's WHOLE canvas goes under the still's own
 *  transform, or null when the frame cannot be registered against the still.
 *
 *  WHY THE WHOLE CANVAS AND NOT THE FRAME'S OWN BBOX: a wind frame moves
 *  branches, so its bbox is not the still's — measured, 3,619 of 6,840 frames
 *  reach OUTSIDE the still's bbox, by up to 42px. Cropping each frame to its
 *  own bbox makes the tree jitter half a metre per frame; cropping every frame
 *  to the still's bbox clips the branches off. Drawing the full frame canvas
 *  through the still's own (kx, ky, origin) does neither: the pixel that was at
 *  the still's bbox corner stays there, and the overhang draws.
 *
 *  THE GUARD: 210 of 6,840 frames (2 pieces — crystal_trees/crystal_tree_002,
 *  which the_game places, and wisteria_snags/wisteria_snag_001) came back from
 *  PixelLab on a LARGER canvas than their still (68 vs 64, 170 vs 160) and are
 *  registered to nothing — neither a centre-crop nor a rescale reproduces the
 *  still. Those return null and the caller draws the static piece. */
export function frameRect(
  fit: SceneryFit,
  canvas: { w: number; h: number },
  frame: { w: number; h: number },
): { x: number; y: number; w: number; h: number; flipX: boolean } | null {
  if (frame.w !== canvas.w || frame.h !== canvas.h) return null;
  const w = frame.w * fit.kx;
  const h = frame.h * fit.ky;
  // The still's crop origin, in destination space, is (fit.x, fit.y) — so the
  // canvas origin sits kx*sx to its left and ky*sy above it. Under a flip the
  // whole canvas mirrors about the CROP's centre, the same axis the still uses.
  const left = fit.x - fit.sx * fit.kx;
  return {
    x: fit.flipX ? fit.x + fit.w - (w - fit.sx * fit.kx) : left,
    y: fit.y - fit.sy * fit.ky,
    w,
    h,
    flipX: fit.flipX,
  };
}

/* -- placements ------------------------------------------------------------- */

/** One resolved placement: everything that does NOT need the art. */
export interface SceneryPlacement {
  /** Index into the world's own `scenery[]` — the stable identity of a piece on
   *  the map, for lights, sound and the wiki. */
  i: number;
  piece: string;
  x: number;
  y: number;
  hflip: boolean;
  lit: boolean;
  /** The facing the map asked for — see facedSprite. Absent means south. */
  dir?: string;
  /** The anchor cell and its level. */
  cx: number;
  cy: number;
  level: number;
  /** Feet, in the frame's pixel space. */
  ax: number;
  ay: number;
  /** render3's painter key: `x + y`, sorted ascending, ties in document order
   *  (Python's sort is stable). A scene that depth-sorts scenery against bodies
   *  and terrain must use the SAME key or a tree swaps with the player. */
  sort: number;
  /** Position in the painter order — a monotone integer, so a query can restore
   *  the order with a numeric sort and never re-derive it. */
  order: number;
}

export interface PlacementOptions {
  frame: Frame;
  /** Level per cell — `World3View.levelAt`, which reads the WHOLE doc. */
  levelAt: (x: number, y: number) => number;
  /** `roofedCells(...)` keys, plus the world width they were keyed with. Omit
   *  to keep every piece (a world with no roof deck). */
  roofed?: Set<number>;
  width?: number;
  /** render3's window filter, on continuous coordinates. Defaults to the
   *  frame's own bounds, which is what render3 does. */
  bounds?: Bounds;
}

/** Resolve a world's `scenery[]` into painter-ordered placements. Drops what
 *  render3 drops: outside the window, and under a roof/cave deck. */
export function buildPlacements(
  scenery: readonly ScenerySpec[] | undefined,
  o: PlacementOptions,
): SceneryPlacement[] {
  const b = o.bounds ?? o.frame;
  const width = o.width ?? 0;
  const kept: { p: ScenerySpec; i: number }[] = [];
  (scenery ?? []).forEach((p, i) => {
    if (!p || !p.piece || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (!inBounds(p, b)) return;
    const [cx, cy] = anchorCell(p);
    if (o.roofed && o.roofed.has(cy * width + cx)) return;
    kept.push({ p, i });
  });
  // Stable sort on x+y — Node's Array.sort is stable, matching Python's.
  kept.sort((a, c) => a.p.x + a.p.y - (c.p.x + c.p.y));
  return kept.map(({ p, i }, order) => {
    const [cx, cy] = anchorCell(p);
    const level = o.levelAt(cx, cy);
    return {
      i,
      piece: p.piece,
      x: p.x,
      y: p.y,
      hflip: !!p.hflip,
      lit: !!p.lit,
      ...(p.dir ? { dir: p.dir } : {}),
      cx,
      cy,
      level,
      ax: anchorX(o.frame, p.x, p.y),
      ay: anchorY(o.frame, p.x, p.y, level),
      sort: p.x + p.y,
      order,
    };
  });
}

/** The distinct pieces a placement list needs, in first-drawn order — the load
 *  list for the manifests. the_game: 205 for 1,388 placements, so a per-piece
 *  cache does 15% of a per-placement one's work and 100% of the drawing. */
export function distinctPieces(ps: readonly SceneryPlacement[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of ps)
    if (!seen.has(p.piece)) {
      seen.add(p.piece);
      out.push(p.piece);
    }
  return out;
}

/* -- the spatial index ------------------------------------------------------ */

/** A camera window in the frame's pixel space. */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The conservative art extent a query pads by, in frame pixels.
 *
 *  A sprite anchored at (ax, ay) occupies x in [ax - w/2, ax + w/2] and y in
 *  [ay - h, ay] — it NEVER reaches below its feet. So the anchor box that can
 *  possibly touch a rect is the rect grown by half the widest art on the left
 *  and right, by the tallest art at the BOTTOM (a tall tree whose feet are
 *  below the screen still reaches up into it), and by NOTHING at the top.
 *
 *  768 is the domain's own ceiling with headroom: the largest published
 *  `world_px_height` is 676 (the_game's own largest is 225). It is a query pad,
 *  not a promise — over-padding costs a few extra candidates that blit to
 *  nothing, under-padding pops a tree in at the screen edge. */
export const MAX_ART_PX = 768;

export interface IndexOptions {
  /** Screen px per bucket. 512 keeps the_game's whole 32,784 x 15,136 canvas at
   *  ~1,900 buckets while a 1080p camera window touches ~12 of them. */
  bucket?: number;
  /** Override `MAX_ART_PX` once the real heights are known — e.g. the maximum
   *  `worldPxHeight` over `distinctPieces()`, which for the_game is 225 and
   *  shrinks the padded query area by 3x. */
  maxArtPx?: number;
}

/** Placements bucketed by their ANCHOR in screen space, so a camera window is
 *  answered by a handful of bucket reads instead of a scan of 1,388.
 *
 *  Why screen space and not cell space: the query IS a camera rect, and the
 *  cell-space shape of a camera rect is a rotated, level-sheared diamond whose
 *  extent depends on the terrain under it. Bucketing what is asked for keeps
 *  the query exact and the index one array of arrays.
 *
 *  A placement lives in exactly ONE bucket (its anchor), so a query never needs
 *  to deduplicate — it only re-sorts the survivors into painter order. */
export class SceneryIndex {
  readonly placements: readonly SceneryPlacement[];
  readonly bucket: number;
  readonly pad: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly x0: number;
  private readonly y0: number;
  private readonly cells: number[][];

  constructor(placements: readonly SceneryPlacement[], o: IndexOptions = {}) {
    this.placements = placements;
    this.bucket = Math.max(1, Math.floor(o.bucket ?? 512));
    this.pad = o.maxArtPx ?? MAX_ART_PX;
    let minX = 0, minY = 0, maxX = 0, maxY = 0;
    if (placements.length) {
      minX = maxX = placements[0].ax;
      minY = maxY = placements[0].ay;
      for (const p of placements) {
        if (p.ax < minX) minX = p.ax;
        if (p.ax > maxX) maxX = p.ax;
        if (p.ay < minY) minY = p.ay;
        if (p.ay > maxY) maxY = p.ay;
      }
    }
    this.x0 = Math.floor(minX / this.bucket);
    this.y0 = Math.floor(minY / this.bucket);
    this.cols = Math.floor(maxX / this.bucket) - this.x0 + 1;
    this.rows = Math.floor(maxY / this.bucket) - this.y0 + 1;
    this.cells = Array.from({ length: this.cols * this.rows }, () => [] as number[]);
    for (const p of placements) {
      const bx = Math.floor(p.ax / this.bucket) - this.x0;
      const by = Math.floor(p.ay / this.bucket) - this.y0;
      this.cells[by * this.cols + bx].push(p.order);
    }
  }

  /** Every placement that can touch `view`, in painter order. `pad` overrides
   *  the index's own art ceiling for one query (a caller that knows the tallest
   *  RESIDENT piece can pass it). */
  query(view: ScreenRect, pad = this.pad): SceneryPlacement[] {
    // See MAX_ART_PX: the anchor box is asymmetric, and the top edge is exact.
    const ax0 = view.x - pad / 2;
    const ax1 = view.x + view.w + pad / 2;
    const ay0 = view.y;
    const ay1 = view.y + view.h + pad;
    const bx0 = Math.max(0, Math.floor(ax0 / this.bucket) - this.x0);
    const bx1 = Math.min(this.cols - 1, Math.floor(ax1 / this.bucket) - this.x0);
    const by0 = Math.max(0, Math.floor(ay0 / this.bucket) - this.y0);
    const by1 = Math.min(this.rows - 1, Math.floor(ay1 / this.bucket) - this.y0);
    const hits: number[] = [];
    for (let by = by0; by <= by1; by++)
      for (let bx = bx0; bx <= bx1; bx++)
        for (const o of this.cells[by * this.cols + bx]) {
          const p = this.placements[o];
          if (p.ax >= ax0 && p.ax <= ax1 && p.ay >= ay0 && p.ay <= ay1) hits.push(o);
        }
    hits.sort((a, b) => a - b);
    return hits.map((o) => this.placements[o] as SceneryPlacement);
  }

  /** Buckets that hold at least one placement — diagnostics for the gate. */
  get occupancy(): { buckets: number; used: number; max: number } {
    let used = 0, max = 0;
    for (const c of this.cells) {
      if (c.length) used++;
      if (c.length > max) max = c.length;
    }
    return { buckets: this.cells.length, used, max };
  }
}

/* -- urls and keys ---------------------------------------------------------- */

/** Repo-relative path of a piece's manifest. */
export function manifestPath(pieceId: string): string {
  return `scenery/${pieceId}/scenery.json`;
}

/** Repo-relative path of a DOMAIN-relative art path (a `sprite`, a
 *  `frame_paths` entry, a `strip`). */
export function artPath(spritePath: string): string {
  return `scenery/${spritePath.replace(/^\/+/, "")}`;
}

const routeUrl = (path: string, r?: UrlRoute): string => {
  const g = r?.gameUrl ?? ((u: string) => u);
  const v = r?.withV ?? ((u: string) => u);
  return v(g(assetPath(path)));
};

export function manifestUrl(pieceId: string, route?: UrlRoute): string {
  return routeUrl(manifestPath(pieceId), route);
}

export function artUrl(spritePath: string, route?: UrlRoute): string {
  return routeUrl(artPath(spritePath), route);
}

/** THE TEXTURE KEY, derived from the CONTENT and from nothing else — the same
 *  law tiles3draw's keys follow. A scenery art path names one immutable file in
 *  the deploy image, so the path IS the content identity; no cell coordinate,
 *  no placement index, no mutable name ever enters a key here. */
export function artKey(spritePath: string): string {
  return "s3:" + spritePath;
}

/** One art file to load and the key it lands under — same shape as
 *  `Tiles3Load`, so one loader serves both. */
export interface SceneryLoad {
  key: string;
  path: string;
  url: string;
}

/** Every art file a set of placements needs, deduplicated per DISTINCT piece.
 *  `pieces` is the resolved manifests the caller already holds; a placement
 *  whose manifest has not loaded yet contributes nothing and comes back on the
 *  next query. `anims` adds the idle frames — leave it off for a first paint
 *  and turn it on once the stills are resident. */
export function sceneryLoads(
  ps: readonly SceneryPlacement[],
  pieces: (id: string) => SceneryPiece | null | undefined,
  opts: { route?: UrlRoute; anims?: boolean } = {},
): SceneryLoad[] {
  const out = new Map<string, SceneryLoad>();
  const add = (p: string | null | undefined) => {
    if (!p || out.has(p)) return;
    out.set(p, { key: artKey(p), path: artPath(p), url: artUrl(p, opts.route) });
  };
  for (const pl of ps) {
    const piece = pieces(pl.piece);
    if (!piece) continue;
    const st = stateFor(piece, pl.lit);
    // Queue the art the placement will actually DRAW, not the south still: a
    // faced placement whose rotation was never queued pops in later, or never.
    add(facedSprite(st, pl.dir));
    if (opts.anims) for (const a of Object.values(st.anims)) for (const f of a.frames) add(f);
  }
  return [...out.values()];
}

/* -- lazy manifests --------------------------------------------------------- */

/** The per-DISTINCT-PIECE manifest cache: 205 fetches for the_game's 1,388
 *  placements, started only when a piece first enters a camera window.
 *
 *  A failed load is cached as a TOMBSTONE (null), not retried — a 404 on a
 *  deleted piece would otherwise re-fire every frame that piece is on screen.
 *  `get` is synchronous and returns undefined until the manifest lands, so a
 *  render pass never awaits: it draws what is resident and picks the rest up on
 *  a later frame. */
export class SceneryPieces {
  readonly stats = { requested: 0, loaded: 0, failed: 0 };
  private cache = new Map<string, SceneryPiece | null>();
  private inflight = new Map<string, Promise<void>>();
  private fetchJson: (url: string) => Promise<any>;
  private route?: UrlRoute;
  private warn: (m: string) => void;

  constructor(o: {
    fetchJson: (url: string) => Promise<any>;
    route?: UrlRoute;
    warn?: (m: string) => void;
  }) {
    this.fetchJson = o.fetchJson;
    this.route = o.route;
    // ONCE PER PIECE, not once per placement: a broken manifest on a piece
    // placed 26 times must not put 26 lines in the console every frame.
    const warned = new Set<string>();
    const w = o.warn ?? ((m: string) => console.warn(m));
    this.warn = (m) => {
      if (warned.has(m)) return;
      warned.add(m);
      w(m);
    };
  }

  /** Resolved manifest, `null` for a piece that failed, `undefined` while it is
   *  still loading or has never been asked for. */
  get(id: string): SceneryPiece | null | undefined {
    return this.cache.get(id);
  }

  /** Start a load if this piece has never been asked for. Safe to call every
   *  frame for every visible placement. */
  /** No manifest fetch outstanding. The loading screen waits on this so a
   *  market stall does not pop in after the player is already standing there. */
  get idle(): boolean {
    return this.inflight.size === 0;
  }

  request(id: string): Promise<void> {
    const done = this.inflight.get(id);
    if (done) return done;
    if (this.cache.has(id)) return Promise.resolve();
    this.stats.requested++;
    const p = this.fetchJson(manifestUrl(id, this.route))
      .then((json) => {
        const piece = parsePiece(id, json, this.warn);
        this.cache.set(id, piece);
        if (piece) this.stats.loaded++;
        else this.stats.failed++;
      })
      .catch((e) => {
        this.cache.set(id, null);
        this.stats.failed++;
        this.warn(`scenery3: ${id} manifest failed to load (${e})`);
      })
      .finally(() => {
        this.inflight.delete(id);
      });
    this.inflight.set(id, p);
    return p;
  }

  /** Request many and settle — the boot-time warm-up for a known window. */
  async ensure(ids: Iterable<string>): Promise<void> {
    await Promise.all([...ids].map((id) => this.request(id)));
  }
}

/* -- the published hitbox (live/tuning/scenery_hitbox.json) ------------------ */

/** ONE ELLIPSE OF GROUND a piece stands on — `pixel-wiki-scenery-hitbox@1`.
 *  Frame PIXELS, origin at the frame's CENTRE, the same units and quantity as a
 *  monster's nadir shadow, so a consumer that resolves those needs no new
 *  arithmetic. Never drawn: it is the footprint, and the doc states its purpose
 *  — "its centre line is what decides render order — a player above an
 *  ellipse's centre is drawn behind that part of the piece, below it in
 *  front." */
export type SceneryHitbox = { ax: number; ay: number; rx: number; ry: number; rot?: number };
export type SceneryHitboxRec = { boxes?: SceneryHitbox[]; auto?: boolean };

/** The record in force for one piece variation, or null when NOBODY HAS
 *  DECIDED. Null and `boxes: []` are different answers and a consumer must not
 *  conflate them: the empty list is a decision — this piece needs no footprint,
 *  which is right for anything hung on a wall — while null means fall back.
 *
 *  KEYED PER VARIATION ("<path>#<state>", since variations differ in size) with
 *  a piece-level record under the bare path as the fallback. CASE: a piece names
 *  its states in UPPER_SNAKE (`NOT_LIT_1`) and the wiki writes the key in lower
 *  (`#not_lit_1`), so the state is tried as given and then lowered — without
 *  that, a piece with only per-variation records resolves to nothing at all.
 *
 *  `auto` is the wiki's alpha-placed PROPOSAL, shown as the default until the
 *  maintainer accepts or edits it. Returned as-is: the game uses them as
 *  provisional footprints, which is what the doc invites, and a caller that
 *  wants only confirmed boxes filters on it. */
export function sceneryHitboxFor(
  doc: Record<string, SceneryHitboxRec> | null | undefined,
  path: string,
  state?: string,
): { boxes: SceneryHitbox[]; auto: boolean } | null {
  if (!doc) return null;
  const rec =
    (state ? doc[`scenery/${path}#${state}`] ?? doc[`scenery/${path}#${state.toLowerCase()}`] : undefined) ??
    doc[`scenery/${path}`];
  if (!rec) return null;
  const boxes = (Array.isArray(rec.boxes) ? rec.boxes : []).filter(
    (b): b is SceneryHitbox =>
      !!b && [b.ax, b.ay, b.rx, b.ry].every((n) => typeof n === "number" && isFinite(n)) && b.rx > 0 && b.ry > 0,
  );
  return { boxes, auto: !!rec.auto };
}
