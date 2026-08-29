// ============================================================================
// INDOORS — "is there a tile over my head, and is that a ROOM or just a bridge?"
// ============================================================================
//
// world@2 decks (see TerrainGrid in index.ts) are the ONE thing that can put
// geometry above the player: house roofs, bridge spans and the cave ceilings
// the_island2 carves out of its east mountain are all the same primitive — a
// solid slab occupying [deckBot, deck] over unchanged base terrain. Walking
// UNDER one is what "indoors" means here; there is no separate interior scene,
// no portal, no house entity. The renderer asks this module two questions when
// the player crosses a slab edge:
//
//   1. what is over my head, and which tiles share that roof (so they can be
//      culled and the interior revealed), and
//   2. is this actually an enclosed space, or did I just walk under a bridge?
//
// Question 2 is the whole reason the module is not a two-liner. Hiding the roof
// the moment anything is overhead makes every bridge and every overhang blink
// the world away, so the space has to prove it is a room first: it must be big
// enough (MIN_ROOM_CELLS) and then EITHER walled in (INDOOR_WALL_RATIO) OR
// something you are deep inside (INDOOR_DEPTH) — the second is what tells a
// widening bridge from the water cave it eventually becomes.
//
// ===========================================================================
// PRECONDITION: `elev` MUST BE A RESOLVED SURFACE LEVEL
// ===========================================================================
// Every function here takes the player's elevation, and that elevation has to
// be a surface the player is actually STANDING ON at that cell — exactly what
// `resolveElevAt` (index.ts) returns, i.e. the cell's base terrain level or its
// deck level. It is NOT a free 3D height, and the answers are meaningless in
// between: an elevation strictly above the base and strictly below the slab
// underside describes a player hovering inside open air, and every fringe cell
// then sits a cliff-sized step away, so the wall rule reads a bridge as a
// sealed room. MEASURED on the_island2's 9 bridges, with the check below
// REMOVED: sweeping every roofed (cell, elev) pair gives 1348 of them, of which
// 1051 read INDOOR under the module's original constants (a 0.5 bar and no size
// floor) and 847 under today's — the tuning barely dents this, the precondition
// is what closes it. E.g. under the level-36 span at (100,44), any elev from 3
// to 33 puts the level-0 water more than ENTRANCE_CLIMB below the player, so all
// 18 fringe cells are "walls", wallRatio is 1.0, and a bridge over open sea
// reports a sealed room. (At 34-35 the level-36 banks come back within
// ENTRANCE_CLIMB and it reads 6 entrances / 0.6667 — wrong, just not maximally.)
// `findIndoorSpace` therefore CHECKS this and returns null instead of a
// confident wrong answer — see its own doc comment.
//
// PURE: no Phaser, no DOM, no I/O, no world loading. Only the grid goes in.

import type { TerrainGrid } from "./index";
import { surfaceFor, VOID_SURFACE } from "./surfaces";

/** Hard cap on cells visited by the roof flood fill. A pathological map (a
 * world-sized cave deck, or a bug that decks every cell) must never be able to
 * hang the client on the frame the player steps under a slab: the fill stops
 * dead at this many cells and reports `capped`. Size it against the CONNECTED
 * space, never against one deck: the fill MERGES adjacent slabs, and
 * the_island2's east-mountain cave is 12 decks that touch — 472 cells of one
 * continuous ceiling, where the biggest single deck in the file is only 71. So
 * 8192 is ~17× the biggest interior the game actually ships, and is still a
 * sub-millisecond fill. Override per call with `maxCells` if a world ever needs
 * a bigger interior — the cap exists to be finite, not to be tight. */
export const MAX_ROOF_CELLS = 8192;

/** The wall-dominance bar: a space is indoors only when MORE than this fraction
 * of its fringe is wall rather than opening. The comparison is STRICT (`>`) so
 * a perfectly balanced fringe never counts as a room.
 *
 * 0.7 IS THE MIDDLE OF A MEASURED GAP, not a taste call. Sweeping all 10
 * shipped worlds — a player standing on the terrain under every deck cell —
 * gives these wallRatio distributions:
 *
 *     BRIDGES (must be OUTDOORS)          ROOMS (must be INDOORS)
 *     occlusion_test  0.4545 (x30)        occlusion_test roof  0.9643 (x49)
 *     the_island      0.1667 (x14)        the_island2  house   0.9286 (x13)
 *                     0.2857 (x10)        the_island2  cave    0.9850 (x472)
 *                     0.3125 (x12)
 *     the_island2     0.2778 (x14)
 *                     0.3000 (x21)
 *                     0.3333 (x28)
 *                     0.4000 (x24)
 *                     0.5000  (x9)
 *
 * Bridges top out at EXACTLY 0.50 (the_island2's 3x3 piers: a 12-cell fringe of
 * 6 grass banks 4 levels up and 6 open water cells). Rooms start at 0.9286.
 * That is a 0.43-wide empty gap, and the bar used to sit at 0.50 — pinned to
 * the worst point in it, passing by ONE fringe cell, which is why the strict
 * comparison was load-bearing (`>=` blinked the world away under every pier).
 * 0.7 sits mid-gap instead: 0.20 clear of the highest bridge and 0.23 below the
 * lowest room, so a single re-authored fringe cell on either side of the gap
 * can no longer flip a verdict.
 *
 * RE-TUNING: re-run the sweep (the "every world that ships decks" test in
 * indoor.test.ts prints nothing but asserts exactly this partition) and put the
 * bar back in the middle of whatever gap the shipped worlds then show. The
 * failure that matters is the false POSITIVE — a bar too LOW hides the map
 * under a bridge; a bar too high merely leaves a room's roof drawn.
 *
 * A ratio alone cannot do the whole job: it is scale-free, so a 2-cell arch
 * over a 2-cell gully scores 1.00. See MIN_ROOM_CELLS. */
export const INDOOR_WALL_RATIO = 0.7;

/** The room-size floor: a space must have at least this many cells under its
 * roof before it can be indoors at all.
 *
 * The wall ratio is SCALE-FREE and therefore provably cannot separate a tiny
 * span from a tiny room — the smaller the space, the easier a high ratio is to
 * reach by accident. Measured counter-examples, all built from real geometry
 * and all reading indoor === true on ratio alone (they are in indoor.test.ts):
 *
 *     a 2-cell arch over a 2-cell gully                        ratio 1.0000
 *     a bridge over a dead-end inlet, shore on three sides      0.8750
 *     a 3-cell bridge over a narrow ravine                      0.7500
 *     the real the_island2 pier, one row longer                 0.5714
 *     that pier with the channel narrowed by one cell           0.6000
 *
 * The last two are handled by the 0.7 bar; the first three clear it and are
 * stopped here — every one of them is 3 cells or fewer of roof.
 *
 * 8 clears the largest counter-example PINNED HERE by 2× and leaves 5 cells of
 * headroom under the smallest true interior any shipped world has (the_island2's
 * house, 13 roof cells; occlusion_test's roof space is 49, its cave 472). Both
 * margins are real: shrink it toward 4 and a gate arch becomes a room, raise it
 * toward 13 and a small hut stops being one.
 *
 * WHAT THIS FLOOR DOES **NOT** DO — it is not a general defence against spans.
 * The counter-example family is length-parametrized, so growing a span walks it
 * straight through both gates; measured by sweeping each shape's length:
 *
 *     ravine bridge over a 1-wide chasm    4 cells 0.8000 out ... 8 cells 0.8889 IN
 *     bridge over a dead-end inlet         3 cells 0.8750 out ... 8 cells 0.9444 IN
 *     the real pier, narrowed AND +4 rows           14 cells 0.8333 IN
 *
 * That is a design boundary, not a bug: a long narrow span sunk in deep terrain
 * is geometrically indistinguishable from a corridor, and this module's own
 * sealed-tunnel test deliberately calls an 8-cell rock corridor a room. The two
 * rules reject SHORT spans and OPEN ones; a long span walled on both sides is
 * meant to read as indoors. If a real world ever authors one that should not,
 * the fix is a new signal (span aspect ratio, or the deck's own `kind`), not a
 * higher floor — 13 is the ceiling, and the house sits on it. */
export const MIN_ROOM_CELLS = 8;

/** THE SECOND WAY IN: how deep under the roof you must be — cells from the
 * nearest entrance, measured THROUGH the space — before it is indoors no matter
 * what its fringe looks like.
 *
 * The wall ratio asks a question about the whole SPACE; this asks one about
 * WHERE YOU ARE STANDING IN IT, and it is the rule that answers the maintainer's
 * case (2026-08-06): "if you continue to make the bridge wider at some point
 * it's not a bridge — it's a tunnel/water cave… it would be really cool to swim
 * into a water cave and the outside turns dark". A widening bridge and a water
 * cave have the SAME fringe geometry — banks on two sides, open water at both
 * ends — so no ratio bar can separate them; lowering the bar to 1/3 to catch the
 * cave takes occlusion_test's bridge (30 of 30 cells) and the_island2's pier
 * (9 of 9) with it. What actually differs is how far you can get from daylight:
 * under a bridge you are always a step from the open, and in a cave you are not.
 *
 * MEASURED — distance from the nearest entrance for every roofed cell in every
 * shipped world (BFS through the roof set, so a cell touching a doorway is 1):
 *
 *     BRIDGES (must stay OUTDOORS)          ROOMS/CAVES (deep interiors exist)
 *     the_island       max 2                the_island2 house   max  6
 *     the_island2      max 2                occlusion_test roof max 11
 *     occlusion_test   max 3                the_island2 cave    max 57
 *
 * Every bridge cell the game ships is at depth 1-3. 4 is the first value no
 * bridge reaches, and it is the honest reading of the maintainer's own rule:
 * a span you can get four cells into without seeing sky IS a tunnel.
 *
 * This is deliberately an OR with the wall rule, not a replacement. Depth alone
 * would call the house's own doorway cells outdoors (its shallow cells are at
 * depth 1-2) — the wall rule covers those; depth covers the wide-open-ended
 * spaces the wall rule cannot. The consequence is that `indoor` now varies
 * BETWEEN CELLS of one space, which is the point: swim into the cave mouth and
 * the world darkens around you a few cells in, rather than snapping the instant
 * the ceiling appears. The renderer must therefore hysteresis this transition —
 * see the note on `depth`. */
export const INDOOR_DEPTH = 4;

/** How big a level step a fringe cell may sit at and still count as a way OUT.
 * Mirrors JUMP_CLIMB in index.ts (a 2-level ledge is crossable with a jump; 3+
 * is a cliff). Kept as a local constant so this module stays leaf-level and
 * import-cycle-free — if the climb rule ever changes, change it in both. */
export const ENTRANCE_CLIMB = 2;

/** Floating-point slack, same convention as baseUnderDeckOpen in index.ts:
 * elevations arrive as interpolated floats, so "strictly below the slab" needs
 * a hair of tolerance or standing exactly on a deck flickers indoors. */
const EPS = 1e-9;

/** Slack for "is this elevation one of the cell's resolved surfaces?" — looser
 * than EPS on purpose: that comparison is against a level the caller computed
 * (an ease, a lerp, a back-projection), not against a value this module
 * produced, so it has to survive a few float operations of drift. Still many
 * orders of magnitude below the smallest real level step (1). */
const SURFACE_EPS = 1e-6;

// 4-connected neighbours in GRID space. Allocated once at module scope: the
// fill runs per roof cell and must not allocate per step.
const DC = [1, -1, 0, 0];
const DR = [0, 0, 1, -1];

// 8-connected neighbours, for the SHELL pass only. The fill and the fringe stay
// strictly 4-connected (a diagonal is not a step you can take, and a cell that
// touches the room at one point is not part of its outline); the enclosure a
// camera SEES, however, is 8-connected — see `shell`.
const DC8 = [1, -1, 0, 0, 1, 1, -1, -1];
const DR8 = [0, 0, 1, -1, 1, -1, 1, -1];

/**
 * Could a mover standing at `elev` occupy the BASE surface of cell `i`?
 *
 * This is the index-space twin of the base-surface branch of `canEnterElev`
 * (index.ts) — the same three conditions, in the same order, including
 * `baseUnderDeckOpen`:
 *
 *   • no solid prop on the cell (`grid.blocked`),
 *   • the surface is ground you can stand on OR water you can swim in (an
 *     empty type is VOID, exactly as `surfaceAtWorld` treats it),
 *   • and any slab overhead is one you are already UNDER (`elev < deckBot`) —
 *     a slab whose underside reaches the floor is solid rock, and the movement
 *     code refuses to walk into it.
 *
 * The DECK candidate of `canEnterElev` is deliberately NOT considered: the deck
 * is the roof we are standing under, and a mover on top of it is outdoors by
 * definition (see roofAbove).
 *
 * Kept as a twin rather than a call so this module stays a leaf (index.ts
 * re-exports it, so importing values from index.ts would close a cycle) and so
 * the hot, hand-inlined `canEnterElev` stays untouched. `indoor.test.ts` pins
 * the two together: it cross-checks this predicate against the real
 * `canEnterElev` over every cell of a mixed fixture. If the movement rule
 * changes, that test fails here.
 */
function standingOpen(grid: TerrainGrid, i: number, elev: number): boolean {
  if (grid.blocked[i]) return false;
  const t = grid.type[i];
  const s = t ? surfaceFor(t) : VOID_SURFACE;
  if (!s.standable && !s.swimmable) return false;
  return grid.deck[i] < 0 || elev < grid.deckBot[i] - EPS;
}

/** Could the player under this roof actually BE on cell `i` — is it interior
 * FLOOR? Standing-open, and not a step UP bigger than `climb`: a cell whose own
 * terrain rises above the player's standing elevation is the room's WALL, even
 * when the roof deck also covers it. (Downward is free — gravity always is —
 * so a sunken floor is still floor.) */
function interiorFloor(grid: TerrainGrid, i: number, elev: number, climb: number): boolean {
  /* A ROOM IS TERRAIN AND ROOF, NOT FURNITURE. `standingOpen` refuses a BLOCKED
   * cell, which is right for a doorway — you cannot leave through a boulder —
   * and wrong for the room's own extent: a bed and a hearth are things IN the
   * room, not holes in it. Scenery collision made that distinction load-bearing.
   * Measured on the_game's spawn house: 13 floor cells, 5 of them under
   * furniture, leaving 8 — exactly MIN_ROOM_CELLS, and fragmented, so the fill
   * reached fewer and the house stopped counting as indoors altogether
   * (maintainer 2026-08-29: "when I walk into a house we never enter indoor").
   * The room's WALLS are still terrain: the level test below is what rejects
   * them, and it is untouched. */
  const furnitureOnly = grid.sceneryBlocked?.[i] === true;
  if (grid.blocked[i] && !furnitureOnly) return false; // a PROP under a ceiling is that room's wall
  const t = grid.type[i];
  const s = t ? surfaceFor(t) : VOID_SURFACE;
  const onOwnFloor = grid.deck[i] < 0 || elev < grid.deckBot[i] - EPS;
  return (s.standable || s.swimmable) && onOwnFloor && grid.level[i] <= elev + climb + EPS;
}

/** Could the player LEAVE through fringe cell `j`? Standing-open (a solid slab
 * to the floor, a prop or a cliff face is no door) AND within `climb` levels
 * either way — a drop is survivable but a 6-level plunge is not a doorway, so
 * this one stays symmetric.
 *
 * SWIMMING IS ASSUMED. `standingOpen` accepts any swimmable surface with no
 * ability check, because this module takes no MoveContext — where the real
 * `canEnterElev` branches on `ctx.canSwim`, water here is ALWAYS a door. Every
 * shipped caller passes canSwim:true, and the assumption is load-bearing in the
 * right direction: the_island2's piers stay OUTDOORS precisely because their six
 * water fringe cells count as entrances. A non-swimming consumer would flip the
 * 3x3 pier to wallRatio 1.0 over a 9-cell roof — indoors, under a bridge. Give
 * this module the context before you give it such a caller. */
function wayOut(grid: TerrainGrid, j: number, elev: number, climb: number): boolean {
  return standingOpen(grid, j, elev) && Math.abs(grid.level[j] - elev) <= climb;
}

/** One enclosed (or not) space under a slab, in cell indices (i = row*width + col). */
export interface IndoorSpace {
  /** Cells under the same roof as the player, reachable by 4-connected fill. */
  roof: Set<number>;
  /** Cells NOT under the roof that touch it — the room's outline. Every cell in
   * `entrances`, `wallLeft` and `wallRight` comes from here. */
  fringe: Set<number>;
  /** The FAR (up-screen) walls only — the ones whose inward face the camera can
   * see, and therefore the only ones worth culling to reveal the interior.
   *
   * `wallLeft` holds fringe cells whose DOWN-LEFT neighbour (col, row+1) is
   * inside the room, i.e. the room lies down-left of them, i.e. they are the
   * room's up-RIGHT (north-east) side; `wallRight` holds those whose DOWN-RIGHT
   * neighbour (col+1, row) is inside, the room's up-LEFT (north-west) side. The
   * names describe WHICH DRAWN FACE of the cell looks into the room, not which
   * side of the room the cell is on — those read opposite, which is exactly the
   * confusion this paragraph exists to kill.
   *
   * What is NOT in either set: `entrances` (an opening has no wall face), and
   * every NEAR (down-screen) wall — its inward faces point away from the camera
   * and are never drawn, so nothing occludes the interior and nothing needs
   * culling. Near walls are still real walls for the enclosure rule below.
   *
   * A ROOM'S OWN CORNER IS IN NEITHER SET, and is not even in the fringe. The
   * fringe is 4-connected, so the cell diagonally off a room's corner touches it
   * only at a point and is never collected; and the only face of it the camera
   * could see is its TOP, which is at roof level and culled anyway. Verified on
   * a clean 5x5 room: all four corners report fringe=false, wallLeft=false,
   * wallRight=false.
   *
   * THE TWO SETS DO OVERLAP, BUT ONLY AT AN **INSIDE** CORNER — a nub of wall
   * poking INTO the space, where the room wraps around it on both lower sides:
   *
   *     . . #        `.` outside   `#` room   `X` the fringe cell
   *     . X #        its down-RIGHT neighbour is room  -> wallRight
   *     # # #        its down-LEFT  neighbour is room  -> wallLeft
   *
   * Both of THAT cell's drawn faces really do look into the room and both must
   * be culled, so step 2 puts it in both sets. Every one of the 7 overlaps in
   * the_island2's cave has exactly this shape (6 of them the diagram above, one
   * a 3-neighbour pillar tip) — they are rock nubs in a cave wall, not room
   * corners. Consequence for the caller: the near walls are
   *
   *     fringe − entrances − (wallLeft ∪ wallRight)
   *
   * and NOT `fringe − entrances − wallLeft − wallRight`, which double-counts
   * every inside corner. Measured on that cave: 267 fringe, 4 entrances,
   * |wallLeft| 80, |wallRight| 73, |wallLeft ∩ wallRight| 7 — the subtraction
   * says 110 near walls where the truth is 117. `entrances` IS disjoint from
   * both (an opening returns before either test). */
  wallLeft: Set<number>;
  /** The room's up-LEFT (north-west) far wall — see `wallLeft`. */
  wallRight: Set<number>;
  /** THE BUILDING ITSELF: every solid cell of this space's enclosure —
   * 8-connected to the roof set, not floor, not an opening. Near walls, far
   * walls, corners and T-junctions alike, with no distinction between them.
   *
   * THIS IS THE SET THE RENDERER DRAWS, and it is deliberately dumber than
   * `wallLeft`/`wallRight`. Those two answer "whose inward face is visible",
   * which is the question you ask when you intend to HIDE things: cull the near
   * walls, cull the roof, keep a sliver of the far ones. That was tried and
   * rejected (maintainer 2026-08-07: "You added a transparent wall feature
   * where my idea was to instead cut all walls at roof-1, roof-2, etc"), and
   * its failure mode is structural rather than a tuning miss — a set defined by
   * "has a visible inward face" cannot contain a room's own CORNER, because a
   * corner has no inward face at all. On screen the corner sits at the apex
   * BETWEEN the two far wall runs, so a cell nobody draws is a hole punched
   * through the house:
   *
   *     # L L L # #        `#` corner / junction: in NO wall set -> black wedge
   *     R o o o f B        `L`/`R` far wall (drawn), `f` near wall (culled)
   *     R o o o R o        `o` interior floor
   *
   * Every multi-room building has those junctions where a partition meets an
   * outer wall (the two `#` mid-run above), so this was not one map's odd
   * shape. The cut-away has no such gap by construction: it draws the whole
   * enclosure and simply TRUNCATES it, so "which cells?" collapses to "all of
   * them" and there is nothing left to classify wrongly.
   *
   * 8-connected here and NOWHERE else. The fill and the fringe stay
   * 4-connected on purpose — a diagonal is not a step you can take, and a cell
   * touching the room at one point is not part of its outline for the
   * enclosure/wallRatio arithmetic. But a point-touch IS a visible seam, and
   * closing seams is this set's whole job.
   *
   * Openings are excluded (`wayOut`): a doorway must keep reading as a way
   * through, and walling one up is exactly the hole-in-reverse.
   *
   * Renderer contract: draw each of these as an ORDINARY column truncated at
   * the cut level — same rule as an interior floor cell, no faces, no halves,
   * no special cases. */
  shell: Set<number>;
  /** Fringe cells the player could step/jump onto — the doors and windows. */
  entrances: Set<number>;
  /** Level of the slab over the player's own cell: tiles at/above this level in
   * the roof set are the ceiling and must not be drawn while inside. With
   * nested ceilings at different heights (the cave) this stays the player's
   * OWN ceiling — the one they are actually standing under. */
  roofLevel: number;
  /** Fraction of the fringe that is wall rather than opening (1 when the space
   * has no fringe at all, i.e. the roof runs off the map edge on all sides). */
  wallRatio: number;
  /** How far THE QUERIED CELL is from the nearest entrance, in cells, measured
   * by BFS through the roof set: 1 when it touches an opening, and
   * `Infinity` when the space is sealed (no entrances at all — then `wallRatio`
   * is 1 and the wall rule has already called it indoors).
   *
   * Unlike every other field here this one is about the PLAYER'S CELL, not the
   * space, so two cells of one cave answer differently — see INDOOR_DEPTH.
   *
   * RENDERER NOTE: because of that, `indoor` can flip while the player walks
   * INSIDE one space, and a player standing exactly on the boundary who steps
   * back and forth will flip it every step. Hysteresis belongs in the consumer
   * (enter at INDOOR_DEPTH, leave at INDOOR_DEPTH - 1, or time-based), not here
   * — this module is pure and stateless by design. */
  depth: number;
  /** The fill hit `maxCells` and the space is truncated — see MAX_ROOF_CELLS. */
  capped: boolean;
  /** The room rules passed: the space is big enough to be a room AND it is
   * either genuinely enclosed or you are deep enough inside it —
   * `!capped && roof.size >= MIN_ROOM_CELLS && (wallRatio > INDOOR_WALL_RATIO
   * || depth >= INDOOR_DEPTH)`. The size floor is an AND with both; the two
   * ways IN are an OR. See all three constants. */
  indoor: boolean;
}

export interface IndoorOptions {
  /** Cell budget for the flood fill (default MAX_ROOF_CELLS). A value that is
   * not a finite number >= 1 falls back to the default — a NaN or 0 budget
   * would otherwise silently truncate every space to a single cell. */
  maxCells?: number;
  /** Level step a fringe cell may sit at and still be an exit (default 2). */
  climb?: number;
}

/**
 * The slab level over the head of someone standing in (col,row) at `elev`
 * levels, or null when the sky is up there.
 *
 * "Over their head" is deliberately about the slab's UNDERSIDE, not its top: a
 * deck cell offers TWO surfaces, and the player on the roof of a house is at
 * elev == deck, i.e. ON the slab, not under it. Only someone strictly below
 * deckBot is inside. `deck[i] < 0` is the no-deck sentinel (index.ts).
 *
 * Non-integer / non-finite coordinates are NOT a cell and return null. The
 * range check alone let a float col (1.6) or a NaN index straight through to
 * `grid.deck[i]`, which is `undefined` — so the function returned `undefined`
 * from a `number | null` signature, `if (roofLevel === null)` did not catch it,
 * and findIndoorSpace handed back a space with `roofLevel: undefined` and a
 * fractional index in its Set.
 */
export function roofAbove(grid: TerrainGrid, col: number, row: number, elev: number): number | null {
  if (!Number.isInteger(col) || !Number.isInteger(row) || !Number.isFinite(elev)) return null;
  if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) return null;
  return roofAboveIndex(grid, row * grid.width + col, elev);
}

function roofAboveIndex(grid: TerrainGrid, i: number, elev: number): number | null {
  const top = grid.deck[i];
  if (top < 0) return null; // no deck here — open sky
  if (elev >= grid.deckBot[i] - EPS) return null; // on top of / inside the slab
  return top;
}

/**
 * The space the player at (col,row,elev) is under, or null if nothing is over
 * their head (including when they are standing ON a deck — that is outdoors).
 *
 * PRECONDITION — `elev` MUST BE A RESOLVED SURFACE LEVEL, the value
 * `resolveElevAt` (index.ts) gives for this cell: its base terrain level, or
 * its deck level. Anything in between is a player hovering in open air and the
 * enclosure question has no meaning there (see the module header: 1051 of the
 * 1348 roofed (cell,elev) pairs on the_island2's bridges read INDOOR at such
 * elevations). This function ENFORCES the precondition rather than trusting it:
 * an elev that is not one of this cell's resolved surfaces returns **null**,
 * the same "nothing to report" answer as open sky, because a caller that has
 * lost track of the player's surface must not be handed a confident wrong room.
 *
 * Three steps, in the maintainer's design order:
 *
 * 1. ROOF SET — flood fill, 4-connected in GRID space, entering only cells that
 *    (a) also have a slab over the SAME player elevation and (b) the player
 *    could actually BE in under it (`interiorFloor` — the movement code's own
 *    reachability rule). Both halves are needed: a roof that sits ABOVE its
 *    walls decks the wall cells too, and without (b) the fill swallowed the
 *    whole ring of walls, walked out over the front step, and reported a house
 *    with 5 fringe cells and 5 entrances — wallRatio 0.00, indoor false. The
 *    only reason the shipped house survived that bug is that its roof happens
 *    to sit exactly AT wall level, where buildTerrainGrid's `d.level > level[i]`
 *    drops the deck on the wall cells for it.
 *    Grid-connected rather than screen-connected on purpose: a room is a
 *    rectangle of cells, and the screen diagonal would fill in a checkerboard.
 *
 * 2. FRINGE — the cells that touch the roof set but are not in it. Each one is
 *    classified twice over:
 *
 *      • as an ENTRANCE when the player could actually leave through it — a
 *        doorway, a missing wall, the open side of a carport. That is the
 *        movement rule (`wayOut`), not a level comparison: a 6-level wall block
 *        is not an exit, but neither is a cell whose own slab reaches the floor
 *        (solid rock — the tunnel end caps), nor one a prop stands on. Those
 *        are WALLS. Checking only the level, as this once did, made a 5-cell
 *        rock tunnel read wallRatio 0 (its two solid end caps counted as doors)
 *        and let a barrel dropped in a doorway keep counting as a door.
 *
 *      • as a WALL FACE, by which of its two camera-facing sides looks inward.
 *        The projection is x = (col - row) * 32, y = (col + row) * 15, so BOTH
 *        col+1 and row+1 move DOWN the screen: (col+1,row) is the neighbour
 *        down-RIGHT and (col,row+1) is the neighbour down-LEFT. A cell's two
 *        drawn faces are exactly those two sides, so a fringe cell shows the
 *        room an inward wall on its right face when (col+1,row) is inside, and
 *        on its left face when (col,row+1) is inside. An INSIDE corner — a nub
 *        of wall the room wraps around — gets both; a room's OWN corner gets
 *        neither, and never even reaches the fringe (see `wallLeft`).
 *        Fringe cells on the near (down-screen) side of the room get neither —
 *        their inward faces point away from the camera and are never drawn —
 *        yet they still count as walls for step 3, which is about enclosure,
 *        not about pixels.
 *
 * 3. THE ROOM RULES — a space must be big enough to be a room at all
 *    (`roof.size >= MIN_ROOM_CELLS`), and then there are TWO ways to be inside
 *    it, either of which is enough:
 *
 *      • ENCLOSURE — the fringe is wall-dominated (`wallRatio >
 *        INDOOR_WALL_RATIO`). Without this, "a tile is over my head" fires on
 *        every bridge span, cliff overhang and gate arch, and the client strobes
 *        the roof layer on and off as the player walks a road: a bridge is
 *        nearly all fringe-and-no-wall (you can step off either side anywhere
 *        along it), a house is one door in a ring of 6-level walls.
 *
 *      • DEPTH — the queried cell is `INDOOR_DEPTH` or more cells from the
 *        nearest entrance. Enclosure is a property of the SPACE and is blind to
 *        a covered water channel, whose two open ends keep the ratio low however
 *        long it runs; depth is a property of WHERE YOU STAND and separates the
 *        bridge you are stepping under from the cave you have swum into.
 *
 *    And the size floor is an AND with both, because the ratio is scale-free —
 *    a 2-cell arch over a 2-cell gully scores a perfect 1.00. See all three
 *    constants; each carries the measured numbers it was chosen from.
 */
export function findIndoorSpace(
  grid: TerrainGrid,
  col: number,
  row: number,
  elev: number,
  opts: IndoorOptions = {},
): IndoorSpace | null {
  const roofLevel = roofAbove(grid, col, row, elev);
  if (roofLevel === null) return null;

  // The precondition, enforced. `roofAbove` has already established that the
  // player is strictly UNDER the slab, so the deck candidate of resolveElevAt
  // is ruled out (elev == deck implies elev >= deckBot) and the base terrain is
  // the only surface they can be standing on here. SURFACE_EPS is float slack,
  // not tolerance for a wrong level: surface levels are integers in every
  // shipped world and arrive through eased/interpolated arithmetic.
  if (Math.abs(grid.level[row * grid.width + col] - elev) > SURFACE_EPS) return null;

  const w = grid.width;
  const h = grid.height;
  const cells = w * h;
  // An unusable budget (NaN, 0, negative) means "no opinion" and falls back to
  // the default — clamping it to 1 instead would report a 1-cell space that is
  // neither capped-looking nor true.
  const want = opts.maxCells;
  const budget = typeof want === "number" && Number.isFinite(want) && want >= 1
    ? Math.floor(want)
    : MAX_ROOF_CELLS;
  const cap = Math.max(1, Math.min(budget, cells));
  const climb = opts.climb ?? ENTRANCE_CLIMB;

  // mark: 0 = untouched, 1 = roof set, 2 = fringe. One typed array per call
  // (the fill runs on a slab crossing, not per frame) and zero allocation in
  // the loops below; the queue can never outgrow the cell budget because every
  // push is preceded by a mark.
  const mark = new Uint8Array(cells);
  const queue = new Int32Array(cap);
  const roof = new Set<number>();

  // The player's OWN cell seeds the fill unconditionally: they are standing in
  // it, so it is floor by observation whatever the terrain says.
  const start = row * w + col;
  mark[start] = 1;
  roof.add(start);
  queue[0] = start;
  let head = 0;
  let tail = 1;
  let capped = false;

  while (head < tail && !capped) {
    const i = queue[head++];
    const c = i % w;
    const r = (i - c) / w;
    for (let k = 0; k < 4; k++) {
      const nc = c + DC[k];
      const nr = r + DR[k];
      if (nc < 0 || nr < 0 || nc >= w || nr >= h) continue;
      const j = nr * w + nc;
      if (mark[j] !== 0) continue;
      if (roofAboveIndex(grid, j, elev) === null) continue; // no slab over this head
      if (!interiorFloor(grid, j, elev, climb)) continue; // solid: wall, not floor
      if (tail >= cap) {
        capped = true; // budget spent — stop dead, report it, stay outdoors
        break;
      }
      mark[j] = 1;
      roof.add(j);
      queue[tail++] = j;
    }
  }

  // Fringe pass. Walking the roof set once and marking its untouched
  // neighbours is O(roof), and `mark` keeps it duplicate-free without a
  // membership Set lookup per probe.
  const fringe = new Set<number>();
  for (const i of roof) {
    const c = i % w;
    const r = (i - c) / w;
    for (let k = 0; k < 4; k++) {
      const nc = c + DC[k];
      const nr = r + DR[k];
      // Off the map is neither wall nor door: there is no cell to draw a face
      // for and nothing to walk out onto, so the map border simply ends the
      // outline. (A roof that runs off the edge is enclosed on that side.)
      if (nc < 0 || nr < 0 || nc >= w || nr >= h) continue;
      const j = nr * w + nc;
      if (mark[j] !== 0) continue;
      mark[j] = 2;
      fringe.add(j);
    }
  }

  const entrances = new Set<number>();
  const wallLeft = new Set<number>();
  const wallRight = new Set<number>();
  for (const j of fringe) {
    const c = j % w;
    const r = (j - c) / w;
    if (wayOut(grid, j, elev, climb)) {
      entrances.add(j); // you can step (or hop) through here
      continue; // an opening has no wall to draw, on either face
    }
    if (c + 1 < w && mark[(r * w) + c + 1] === 1) wallRight.add(j); // down-RIGHT neighbour inside
    if (r + 1 < h && mark[((r + 1) * w) + c] === 1) wallLeft.add(j); // down-LEFT neighbour inside
  }

  const wallRatio = fringe.size === 0 ? 1 : (fringe.size - entrances.size) / fringe.size;

  // SHELL pass — the whole enclosure, 8-connected. Runs BEFORE the depth BFS
  // below, which overwrites the roof marks with 3; `mark[j] === 1` is the roof
  // test and is only valid until then.
  //
  // There is no safety filter here and there must not be one. Under the old
  // cull design a wall got drawn at FULL height, so a near one would have stood
  // in front of the interior and had to be excluded by painter order. The
  // cut-away truncates every column instead, so a near wall is a low parapet
  // you look over — nothing it could hide is hidden by drawing it, and
  // "which cells belong to this building" is the only question left.
  const shell = new Set<number>();
  for (const i of roof) {
    const c = i % w;
    const r = (i - c) / w;
    for (let k = 0; k < 8; k++) {
      const jc = c + DC8[k];
      const jr = r + DR8[k];
      if (jc < 0 || jr < 0 || jc >= w || jr >= h) continue;
      const j = jr * w + jc;
      if (mark[j] === 1 || shell.has(j)) continue; // inside, or already settled
      if (entrances.has(j) || wayOut(grid, j, elev, climb)) continue; // a door stays a door
      shell.add(j);
    }
  }

  // DEPTH of the player's own cell: BFS inward from the entrance ring, through
  // the roof set only. Reuses `mark` (roof cells are 1, fringe 2) as the
  // visited flag by overwriting the roof marks with 3 — the fill and the fringe
  // pass are both finished, so nothing reads them again, and this stays
  // allocation-free apart from the distance array. O(roof), same order as the
  // fill itself, and it runs on a slab crossing rather than per frame.
  const dist = new Int32Array(cells); // 0 = unreached
  let dh = 0;
  let dt = 0;
  for (const e of entrances) {
    const c = e % w;
    const r = (e - c) / w;
    for (let k = 0; k < 4; k++) {
      const nc = c + DC[k];
      const nr = r + DR[k];
      if (nc < 0 || nr < 0 || nc >= w || nr >= h) continue;
      const j = nr * w + nc;
      if (mark[j] !== 1) continue; // only step INTO the roof set
      mark[j] = 3;
      dist[j] = 1;
      queue[dt++] = j;
    }
  }
  while (dh < dt) {
    const i = queue[dh++];
    const c = i % w;
    const r = (i - c) / w;
    for (let k = 0; k < 4; k++) {
      const nc = c + DC[k];
      const nr = r + DR[k];
      if (nc < 0 || nr < 0 || nc >= w || nr >= h) continue;
      const j = nr * w + nc;
      if (mark[j] !== 1) continue;
      mark[j] = 3;
      dist[j] = dist[i] + 1;
      queue[dt++] = j;
    }
  }
  // Unreached means the space has no entrances at all (sealed) — or, with a
  // capped fill, that the entrance ring never got built out this far. Either
  // way there is no path to daylight from here, so the honest answer is
  // "infinitely deep"; `capped` independently forces indoor false.
  const depth = dist[start] > 0 ? dist[start] : Number.POSITIVE_INFINITY;

  // A truncated fill can say nothing about enclosure — its outline is mostly
  // cells the fill never got to. Fail OUTDOORS: the world renders normally,
  // which is wrong-but-harmless, where a false indoors would hide the map.
  const indoor =
    !capped &&
    roof.size >= MIN_ROOM_CELLS &&
    (wallRatio > INDOOR_WALL_RATIO || depth >= INDOOR_DEPTH);

  return { roof, fringe, wallLeft, wallRight, shell, entrances, roofLevel, wallRatio, depth, capped, indoor };
}
