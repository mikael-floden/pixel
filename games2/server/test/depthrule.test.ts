// THE CAVE THAT PUT THE PLAYER BEHIND THE RIBCAGE (maintainer, 2026-09-06 and
// again 2026-09-07: "I sometimes still render behind the Scenery object behind
// me. It depends a bit on where I stand").
//
// Every occluder below is a REAL record read out of the running game at his
// spot, and the projection constants are that session's own. The bug: a
// one-level rock stub at cell (364,316) — the same screen DIAGONAL as the cell
// the player stands in, i.e. BESIDE him, not in front — claimed the front
// through the ledge rule's old +1.2 slack the moment his 41px art box reached
// its column, clamping him to 10231.85 while the ribcage draws at 10245.70. A
// step of a third of a cell decided it, which is why it looked intermittent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDepthRule, type OccluderMeta, type DepthCtx } from "../../client/src/depthrule.js";

// Tiles 3.0 geometry, and this session's projection origin (measured: the body
// at 363.3,317.2 rendered at lx 17867.2, lyFlat 10239).
const LH = 15, DY = 14, HALF_DX = 16, OX = 17129.6, OY = 712;
// The player's opaque art box, measured off his sprite (41 x 98 px).
const BOX = { dx0: -20.5, dx1: 20.5, dy0: -91.53, dy1: 6.47 };

const RIBCAGE: OccluderMeta = { col: 362, row: 316, top: 7, solid: true, point: true, depth: 10189.79, drawDepth: 10245.7, x0: 17814.99, x1: 17911.91, y0: 10104, y1: 10214.3 };
// The cave's one-level rock stubs (cut down indoors so you can see in), each
// standable at the deck's level 24 while the floor he stands on is level 0.
const stub = (col: number, row: number, depth: number, x0: number, y0: number, stand = 24): OccluderMeta =>
  ({ col, row, top: 1, stand, depth, x0, x1: x0 + 64, y0, y1: y0 + 79, solid: false, point: false });
const CAVE: OccluderMeta[] = [
  RIBCAGE,
  stub(364, 316, 10232, 17896, 10203), // BESIDE him — same diagonal as his own cell
  stub(363, 318, 10246, 17800, 10217), // genuinely in front
  stub(364, 317, 10246, 17864, 10217), // genuinely in front
  stub(365, 316, 10246, 17928, 10217),
  stub(362, 319, 10246, 17736, 10217),
  stub(361, 319, 10232, 17704, 10203),
  stub(360, 319, 10218, 17672, 10189),
];

function bodyAt(colf: number, rowf: number): DepthCtx {
  const lx = OX + (colf - rowf) * HALF_DX;
  const lyFlat = OY + (colf + rowf) * DY;
  return { colf, rowf, lvl: 0, lx, ly: lyFlat, lyFlat, sx0: lx + BOX.dx0, sx1: lx + BOX.dx1, sy0: lyFlat + BOX.dy0, sy1: lyFlat + BOX.dy1, lh: LH, dy: DY };
}

test("the spot that worked keeps working: the body draws in front of the ribcage it stands in front of", () => {
  const r = resolveDepthRule(bodyAt(363.3, 317.2), CAVE);
  assert.ok(r.depth > RIBCAGE.drawDepth!, `body ${r.depth} must beat the ribcage's ${RIBCAGE.drawDepth}`);
});

test("A STUB BESIDE HIM NEVER COVERS HIM — the step that used to flip it (363.6-363.9, 317.0)", () => {
  for (const colf of [363.6, 363.7, 363.8, 363.9]) {
    const ctx = bodyAt(colf, 317.0);
    const r = resolveDepthRule(ctx, CAVE);
    // The art box really does reach the beside-stub's column at these offsets —
    // that overlap is the trigger, so the case is only meaningful if it holds.
    if (colf >= 363.7) assert.ok(ctx.sx1 >= 17896, `at ${colf} the box must reach the stub's column`);
    assert.ok(r.depth > RIBCAGE.drawDepth!, `at ${colf},317.0 the body sank to ${r.depth}, behind the ribcage at ${RIBCAGE.drawDepth} (the reported bug)`);
    assert.notEqual(r.depth, 10231.85, "10231.85 is the exact wrong value the old +1.2 slack produced");
  }
});

test("the ledge rule still works: a stub on the NEXT diagonal covers and reports its cover line", () => {
  const ledge = stub(363, 318, 10246, 17800, 10217);
  const r = resolveDepthRule(bodyAt(363.3, 317.2), [ledge]);
  assert.equal(r.coverY, 10217, "a ledge in front must still report its cover line");
  assert.ok(r.depth <= ledge.depth - 0.15, "and the body must never draw over the ledge covering it");
});

test("the clamp binds where it matters: a lift over the ribcage still lands under the ledge in front", () => {
  // Both at once — the ribcage lifts the body to 10246.30, the ledge in front
  // caps it at 10246 - 0.15. That 0.15 is the whole margin the body wins by,
  // and it is what puts it above the ribcage's 10245.70 rather than under it.
  const r = resolveDepthRule(bodyAt(363.3, 317.2), [RIBCAGE, stub(363, 318, 10246, 17800, 10217)]);
  assert.equal(r.depth, 10245.85);
  assert.ok(r.depth > RIBCAGE.drawDepth!, "a body in front of a piece lands above it — by 0.15");
});

test("a stub on the body's OWN diagonal never covers, anywhere across the cell", () => {
  for (let colf = 363.0; colf < 364; colf += 0.1) {
    for (let rowf = 316.6; rowf < 317.9; rowf += 0.1) {
      const ctx = bodyAt(+colf.toFixed(2), +rowf.toFixed(2));
      const ownDiag = Math.floor(ctx.colf) + Math.floor(ctx.rowf);
      for (const o of CAVE) {
        if (o.point || o.col + o.row !== ownDiag) continue;
        const r = resolveDepthRule(ctx, [o]);
        assert.equal(r.coverY, undefined, `stub (${o.col},${o.row}) covered a body at ${ctx.colf},${ctx.rowf} on its own diagonal`);
      }
    }
  }
});

test("a piece the body is genuinely BEHIND still draws over it", () => {
  // North of the ribcage's anchor line: point pieces answer on their own depth.
  const r = resolveDepthRule(bodyAt(361.0, 314.0), [RIBCAGE]);
  assert.ok(r.depth < RIBCAGE.drawDepth!, "standing behind the ribcage must stay behind it");
});
