/** THE ONE DEPTH-AND-COVER RULE, as a pure function.
 *
 *  WorldScene.resolveDrawDepth is its only caller and owns the inputs (the art
 *  box, the occluder list, the geometry); this file owns the RULES, so they can
 *  be tested against real measured occluders instead of a live browser. The
 *  cave bug that forced the split recurred three times: a rock stub BESIDE the
 *  player claimed to be in front of him and clamped him behind the scenery he
 *  was standing in front of (maintainer, 2026-09-06 and 2026-09-07), and each
 *  round the only check available was a probe that needed the world to finish
 *  loading. Now it is a test.
 */
export interface OccluderMeta {
  col: number;
  row: number;
  top: number;
  depth: number;
  drawDepth?: number;
  solid?: boolean;
  point?: boolean;
  /** The level this column can be STOOD on; undefined for maps2 metas. */
  stand?: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Everything the rule needs about the caller: where it stands, the screen box
 *  of its art, and the geometry constants. `self` is its own occluder record
 *  (scenery is in the list; bodies are not) — never occludes itself. */
export interface DepthCtx {
  colf: number;
  rowf: number;
  lvl: number;
  lx: number;
  ly: number;
  lyFlat: number;
  sx0: number;
  sx1: number;
  sy0: number;
  sy1: number;
  lh: number;
  dy: number;
  self?: unknown;
}

export function resolveDepthRule(ctx: DepthCtx, metas: Iterable<OccluderMeta>): { depth: number; coverY: number | undefined } {
  let depth = ctx.lyFlat + 0.5; // painter y at the flat (unlifted) ground
  let above = -Infinity;
  let below = Infinity;
  let coverY = Infinity;
  const feetY = ctx.ly;
  for (const o of metas) {
    if (o === ctx.self) continue; // never occlude yourself — see the note above
    if (o.x1 < ctx.sx0 || o.x0 > ctx.sx1 || o.y1 < ctx.sy0 || o.y0 > ctx.sy1) continue;
    const od = o.drawDepth ?? o.depth; // what it DRAWS at — see drawDepth
    const higher = o.top > ctx.lvl;
    // (a) Wall genuinely between the camera and the feet point.
    const t0 = Math.max(o.col - ctx.colf, o.row - ctx.rowf);
    const t1 = Math.min(o.col + 1 - ctx.colf, o.row + 1 - ctx.rowf);
    /* TERRAIN ONLY. This is a CELL test — does the ray from the camera to
     * the feet cross this column — and it is right for a wall, whose art
     * fills its cell and which you can never stand inside. A SOLID
     * billboard is point-anchored and walkable-through: scenery sitting in
     * the very cell the player stands in made the ray "blocked" and clamped
     * him BEHIND it, so an anvil 0.4 cells behind him drew over him and he
     * wore the hidden-behind-terrain outline in open ground. A billboard's
     * question is the DIAGONAL one, which is what solidArtOver below asks. */
    const rayBlocked = higher && !o.solid && t1 > Math.max(t0, 0);
    // (b) A higher column whose LIFTED TOP FACE overlaps the feet band
    // (the sprite is a billboard — raised corners of side/front
    // neighbours pass in front of its lower pixels even when the feet
    // point itself is visible) and whose face is camera-closer.
    // The upper reach must clear a DIAGONALLY adjacent ledge: a step to
    // the E/S (same-row/col neighbour) sits one grid diagonal AND one
    // level up, so its top lands ~lh+dy above the feet — a tighter band
    // (the old −26) let that ledge's corner poke between the legs with
    // the foot drawn over it (playtester, standing at a step edge).
    /* IS THIS PIECE IN FRONT OF ME? A grid occluder answers on CELL
     * DIAGONALS — strictly nearer than the caller's OWN cell — because a
     * cell is a whole diagonal wide and only the next diagonal can be in
     * front of anything standing in this one. BESIDE IS NOT IN FRONT: the
     * old +1.2 slack on the fractional position made a stub on the SAME
     * diagonal (one east AND one north) claim the front as soon as the
     * body's art box reached its screen column, clamping the body 14 px
     * under its own anchor and dropping it behind the scenery it stood in
     * front of — a cave's rock stub at (364,316) put the maintainer behind
     * a dragon ribcage at 363.6,317.0 while 363.3,317.2 was correct, the
     * same step measured twice (2026-09-07). A POINT-anchored piece has a
     * real published centre, so it answers exactly — the maintainer's own
     * rule: "a player above an ellipse's centre is drawn behind that part
     * of the piece, below it in front." */
    const fwd = o.point ? o.depth > ctx.lyFlat : o.col + o.row > Math.floor(ctx.colf) + Math.floor(ctx.rowf);
    const faceOverFeet =
      higher &&
      /* TERRAIN ONLY, like the ray test: this is the LEDGE rule (a raised
       * cell's lifted top face in the feet band). A solid billboard is
       * point-anchored and answers through solidArtOver, which checks the
       * feet's x against the piece — without this gate a short crystal
       * 10px in front and 11px to the side cropped a player's whole lit
       * copy below its top line (cave, maintainer 2026-09-06). */
      !o.solid &&
      o.y0 <= feetY + 6 &&
      o.y0 >= feetY - (ctx.lh + ctx.dy + 9) &&
      fwd;
    // (c) A camera-closer SOLID structure whose (tall, bottom-anchored)
    // art overlaps the sprite: billboard art covers anything behind
    // its diagonal regardless of how far its top rises above the feet
    // — the faceOverFeet band was tuned for 1-level ledges and never
    // fired for a 100px pillar, so the LIT COPY floated over it.
    // BEHIND also requires the feet anchor inside the art's x-span:
    // standing BESIDE the pillar at a smaller diagonal is not behind
    // it, and forcing the base below the pillar dragged it below the
    // equal-depth grass tiles too (clipped legs, playtester report).
    const solidArtOver =
      higher &&
      o.solid &&
      fwd &&
      ctx.lx >= o.x0 - 6 &&
      ctx.lx <= o.x1 + 6;
    /* A TALL WALL THE CALLER STANDS BEHIND, OFF ITS DIAGONAL — the column
     * the stand rule below refuses to lift over. Refusing the lift kept
     * the base sprite under the wall but never CUT THE LIT COPY, which is
     * drawn in the lit band above every occluder and cropped only by a
     * cover line: a tree behind a house kept its trunk over the house's
     * left wall through its copy (copy cover 10872 from the front wall's
     * ray test, the left wall's top at 10786 never registered; maintainer
     * 2026-09-06). It covers exactly as the ray test does. */
    const wallBehind =
      !o.solid &&
      o.stand !== undefined &&
      o.top > ctx.lvl + 1 &&
      o.stand !== ctx.lvl &&
      !(ctx.colf + ctx.rowf > o.col + o.row + 1);
    if (rayBlocked || faceOverFeet || solidArtOver || wallBehind) {
      below = Math.min(below, od);
      coverY = Math.min(coverY, o.y0);
    } else if (
      /* A NON-SOLID COLUMN LIFTS THE CALLER — unless it is HIGHER, NOT
       * STANDABLE AT THE CALLER'S LEVEL, and the caller is not camera-
       * forward of it. A room's floor and a terrace's plates are standable
       * at the caller's level: the lift is unconditional there (the flat
       * tile in front of the feet). A wall the caller stands behind, off
       * its diagonal where the ray test cannot see it, is not: the blanket
       * lift drew a tree standing BEHIND a house over the house's front
       * wall (tree lifted from its 10861.8 anchor line to 10918.6, a wall
       * cell's front edge four cells in front). Keyed on `top` alone the
       * gate hid a room's furniture under its own floor (a capped cell's
       * top is the ROOF): 4 of 10 pieces, measured — hence `stand`. And a
       * ONE-LEVEL column keeps the lift regardless: a room's interior
       * walls are cut to height 1 indoors (law), and a bed against one
       * drew over its stub in the approved look — a stub one row in
       * front covered the bed's bottom 15px under the plain rule. One-
       * level ledges have their own cover rules (faceOverFeet); the gate
       * is for columns TWO or more levels above the caller.
       * maps2 metas carry no `stand` and keep the old unconditional lift. */
      (!o.solid && (o.stand === undefined || o.top <= ctx.lvl + 1 || o.stand === ctx.lvl || ctx.colf + ctx.rowf > o.col + o.row + 1)) ||
      // POINT-ANCHORED (scenery): its own anchor line is the exact
      // comparison — the cell+1 rule is a whole cell of slack, and a body
      // standing under a tree's canopy but in front of its trunk sits
      // inside that slack, so it never lifted and the (lifted) tree drew
      // over its head. Grid-anchored terrain keeps the cell rule.
      (o.point ? ctx.lyFlat > o.depth : ctx.colf + ctx.rowf > o.col + o.row + 1)
    ) {
      // Overlapping, not covering → lift the sprite above it. For
      // STANDABLE terrain this must stay unconditional: the flat tile
      // in FRONT of the feet has a higher painter depth and would
      // otherwise draw over the drop shadow/feet (playtester report).
      // SOLID structures are gated on the feet being camera-forward
      // of their front corner — their bottom-anchored tall art
      // (128px spires) overlaps characters standing well BEHIND
      // them, and the blanket lift drew those on top of the pillar.
      above = Math.max(above, od);
    }
  }
  if (above > -Infinity) depth = Math.max(depth, above + 0.6);
  /* WALLS WIN CONFLICTS — and among the things one wall clamps, a BODY sits
   * a hair above a PIECE. A cave's one-level rock stub in front of both a
   * player and the pod behind him clamped both to the same value, and the
   * tie went to creation order: the pod drew over the player it stood
   * behind (maintainer, 2026-09-06). A body clamps at −0.15, a piece at
   * −0.3: a body in front of a piece lands above it; a body BEHIND a piece
   * is clamped under that piece's own draw depth through solidArtOver. */
  if (below < Infinity) depth = Math.min(depth, below - (ctx.self ? 0.3 : 0.15));
  return { depth, coverY: below < Infinity ? coverY : undefined };
}
