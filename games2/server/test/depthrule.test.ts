// THE CAVE THAT PUT THE PLAYER BEHIND THE RIBCAGE — reported three times
// (maintainer, 2026-09-06, 2026-09-07 twice: "I sometimes still render behind
// the Scenery object behind me. It depends a bit on where I stand").
//
// EVERY RECORD BELOW WAS READ OUT OF THE RUNNING GAME at his spot, and so was
// the projection — an earlier fixture reconstructed the screen x with half the
// real step, so the art box never reached the occluder that causes the bug and
// the test passed against broken code. Do not hand-edit these numbers; re-dump
// them (scratch probe fx/cave3.mjs) if the world moves.
//
// The mechanism: the ribcage is a point piece anchored at 10189.79 that DRAWS
// at 10245.70 (it is lifted over the ground tiles in front of it). A body
// standing in front of it lifts over it too and lands at 10245.85. But a
// one-level rock stub that merely OVERLAPS THE BODY'S ART BOX pulls the body
// down to that stub's own depth − 0.15, and the two nearest stubs sit at 10232
// and 10246 — so whether the body ends up in front of the ribcage or behind it
// is decided by which stubs the 41 px box happens to touch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDepthRule, LIFT_MAX_PX, type OccluderMeta, type DepthCtx } from "../../client/src/depthrule.js";

// Measured: the body at 363.3,317.2 rendered at lx 17867.2 / lyFlat 10239, and
// at 363.6,317.0 at lx 17883.2 / lyFlat 10240.4.
const OX = 16392, OY = 712, DX = 32, DY = 14, LH = 15;
// His opaque art box, measured off the sprite: 41 x 98 px around the anchor.
const BOX = { dx0: -20.5, dx1: 20.5, dy0: -91.53, dy1: 6.47 };

// drawDepth is what the piece's OWN resolve produces: it lifted 55.9px (four
// cells) before the cap, and 35 + 0.6 after it.
const RIBCAGE_UNCAPPED = 10245.7;
const RIBCAGE: OccluderMeta = { col: 362, row: 316, top: 7, solid: true, point: true, depth: 10189.79, drawDepth: 10189.79 + LIFT_MAX_PX + 0.6, x0: 17814.99, x1: 17911.91, y0: 10104, y1: 10214.3 };
// The cave's rock stubs, cut to one level indoors so you can see in, standable
// at the deck's 24 while the floor he stands on is level 0.
const STUBS: OccluderMeta[] = [
  { col: 359, row: 312, top: 8, stand: -1, depth: 10106, x0: 17864, x1: 17928, y0: 9972, y1: 10156, solid: false, point: false },
  { col: 360, row: 312, top: 8, stand: -1, depth: 10120, x0: 17896, x1: 17960, y0: 9986, y1: 10170, solid: false, point: false },
  { col: 364, row: 316, top: 1, stand: 24, depth: 10232, x0: 17896, x1: 17960, y0: 10203, y1: 10282, solid: false, point: false },
  { col: 363, row: 318, top: 1, stand: 24, depth: 10246, x0: 17800, x1: 17864, y0: 10217, y1: 10296, solid: false, point: false },
  { col: 364, row: 317, top: 1, stand: 24, depth: 10246, x0: 17864, x1: 17928, y0: 10217, y1: 10296, solid: false, point: false },
  { col: 364, row: 318, top: 1, stand: 24, depth: 10260, x0: 17832, x1: 17896, y0: 10231, y1: 10310, solid: false, point: false },
  { col: 365, row: 317, top: 1, stand: 24, depth: 10260, x0: 17896, x1: 17960, y0: 10231, y1: 10310, solid: false, point: false },
  { col: 364, row: 319, top: 1, stand: 24, depth: 10274, x0: 17800, x1: 17864, y0: 10245, y1: 10324, solid: false, point: false },
  { col: 365, row: 318, top: 1, stand: 24, depth: 10274, x0: 17864, x1: 17928, y0: 10245, y1: 10324, solid: false, point: false },
  { col: 365, row: 319, top: 2, stand: 24, depth: 10288, x0: 17832, x1: 17896, y0: 10244, y1: 10338, solid: false, point: false },
  { col: 366, row: 318, top: 3, stand: 24, depth: 10288, x0: 17896, x1: 17960, y0: 10229, y1: 10338, solid: false, point: false },
  { col: 365, row: 320, top: 3, stand: -1, depth: 10302, x0: 17800, x1: 17864, y0: 10243, y1: 10352, solid: false, point: false },
  { col: 366, row: 319, top: 3, stand: 24, depth: 10302, x0: 17864, x1: 17928, y0: 10243, y1: 10352, solid: false, point: false },
  { col: 366, row: 320, top: 4, stand: -1, depth: 10316, x0: 17832, x1: 17896, y0: 10242, y1: 10366, solid: false, point: false },
  { col: 367, row: 319, top: 5, stand: 24, depth: 10316, x0: 17896, x1: 17960, y0: 10227, y1: 10366, solid: false, point: false },
  { col: 367, row: 320, top: 5, stand: -1, depth: 10330, x0: 17864, x1: 17928, y0: 10241, y1: 10380, solid: false, point: false },
  { col: 368, row: 320, top: 7, stand: -1, depth: 10344, x0: 17896, x1: 17960, y0: 10225, y1: 10394, solid: false, point: false },
];
const CAVE: OccluderMeta[] = [RIBCAGE, ...STUBS];

function bodyAt(colf: number, rowf: number): DepthCtx {
  const lx = OX + (colf - rowf) * DX;
  const lyFlat = OY + (colf + rowf) * DY;
  return { colf, rowf, lvl: 0, lx, ly: lyFlat, lyFlat, sx0: lx + BOX.dx0, sx1: lx + BOX.dx1, sy0: lyFlat + BOX.dy0, sy1: lyFlat + BOX.dy1, lh: LH, dy: DY };
}

test("the fixture reproduces the real projection", () => {
  const a = bodyAt(363.3, 317.2), b = bodyAt(363.6, 317.0);
  assert.equal(+a.lx.toFixed(1), 17867.2);
  assert.equal(+a.lyFlat.toFixed(1), 10239);
  assert.equal(+b.lx.toFixed(1), 17883.2);
  assert.equal(+b.lyFlat.toFixed(1), 10240.4);
});

for (const [colf, rowf, label] of [[363.1, 316.1, "his fourth report, on the build that was meant to fix it"], [363.1, 316.5, "his third"], [363.6, 317.0, "his second"], [363.3, 317.2, "the one that looked right"]] as const) {
  test(`the body draws IN FRONT of the ribcage it stands in front of — ${colf},${rowf} (${label})`, () => {
    const r = resolveDepthRule(bodyAt(colf, rowf), CAVE);
    assert.ok(
      r.depth > RIBCAGE.drawDepth!,
      `body sank to ${r.depth}, behind the ribcage drawing at ${RIBCAGE.drawDepth}`,
    );
  });
}

test("the stub that causes it really does graze the art box — the case is only real while it does", () => {
  const stub = STUBS.find((o) => o.col === 364 && o.row === 316)!;
  for (const [colf, rowf] of [[363.1, 316.5], [363.6, 317.0]] as const) {
    const c = bodyAt(colf, rowf);
    assert.ok(c.sx1 >= stub.x0, `at ${colf},${rowf} the box must still reach that stub's column`);
    assert.ok(c.lx < stub.x0 - 6, "while his feet stay well clear of it");
  }
});

test("a ledge his feet are actually under still covers him, and still reports its cover line", () => {
  const east = STUBS.find((o) => o.col === 364 && o.row === 317)!;
  const c = bodyAt(363.3, 317.2);
  assert.ok(c.lx >= east.x0 && c.lx <= east.x1, "his feet are inside that ledge's column");
  const r = resolveDepthRule(c, [east]);
  assert.equal(r.coverY, east.y0);
});

test("a body genuinely behind the ribcage stays behind it", () => {
  const r = resolveDepthRule(bodyAt(361.0, 314.0), [RIBCAGE]);
  assert.ok(r.depth < RIBCAGE.drawDepth!, "standing behind the piece must stay behind it");
});

test("THE LIFT IS THE ROOT OF IT: a wide piece may not outrank the terrain standing in front of it", () => {
  // The ribcage anchors at 10189.79. Uncapped it drew at 10245.70 — past the
  // rock stubs at 10232 that stand a cell IN FRONT of it, so the cave's own
  // floor sorted behind it and any body clamped by those stubs went with it.
  const stubsInFront = STUBS.filter((o) => o.depth > RIBCAGE.depth && o.depth < RIBCAGE_UNCAPPED);
  assert.ok(stubsInFront.length > 0, "the fixture must contain terrain between the piece and its uncapped draw depth");
  assert.ok(RIBCAGE.drawDepth! < stubsInFront[0].depth, `the capped piece (${RIBCAGE.drawDepth}) must sort under the terrain in front of it (${stubsInFront[0].depth})`);
  assert.equal(+RIBCAGE.drawDepth!.toFixed(2), 10225.39);
});
