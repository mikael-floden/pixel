import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chessPieceCss, pixelArtCss } from "@nangijala/shared";

const ART = 32;
const devScale = (sq: number, dpr: number) => (chessPieceCss(sq, dpr) * dpr) / ART;

test("the piece lands on a WHOLE device-pixel scale at every real dpr", () => {
  // 2.75 is the maintainer's own phone — the case that made him report
  // "fractal scaling"; 2.625 and 3.5 are other shipped Android ratios.
  for (const dpr of [1, 1.5, 2, 2.625, 2.75, 3, 3.5, 4]) {
    for (let sq = 32; sq <= 140; sq++) {
      const k = devScale(sq, dpr);
      assert.ok(Math.abs(k - Math.round(k)) < 1e-9,
        `dpr ${dpr}, square ${sq}px -> ${k}x device scale (must be whole)`);
      assert.ok(k >= 1, `dpr ${dpr}, square ${sq}px scaled below 1x`);
    }
  }
});

test("the piece never overflows its square, and grows with it", () => {
  for (const dpr of [1, 2, 2.75, 3]) {
    for (let sq = 24; sq <= 200; sq++) {
      const pc = chessPieceCss(sq, dpr);
      assert.ok(pc <= sq, `dpr ${dpr}: piece ${pc} overflows square ${sq}`);
      assert.ok(pc > 0);
    }
    // A big square must buy a bigger piece, not stay pinned at 1x.
    assert.ok(devScale(140, dpr) > devScale(40, dpr), `dpr ${dpr}: piece never grew`);
  }
});

test("a degenerate tiny board fills its square instead of clipping", () => {
  assert.equal(chessPieceCss(24, 1), 24); // 1x (32px) would not fit
});

test("the DICE hand (97px frames) also lands on a whole device scale", () => {
  // The gate can only see dpr 1; these are the ratios real phones ship.
  for (const dpr of [1, 1.5, 2, 2.625, 2.75, 3, 3.5, 4]) {
    for (let budget = 48; budget <= 120; budget++) {
      const w = pixelArtCss(budget, dpr, 97);
      const k = (w * dpr) / 97;
      assert.ok(w <= budget, `dpr ${dpr}, budget ${budget}: hand ${w} exceeds it`);
      // Below one whole frame it fills the budget rather than tearing.
      if (w < 97 / dpr) { assert.equal(w, budget); continue; }
      assert.ok(Math.abs(k - Math.round(k)) < 1e-9,
        `dpr ${dpr}, budget ${budget} -> ${k}x device scale (must be whole)`);
    }
  }
});

test("the maintainer's own phone gets a whole scale, not 2.75x", () => {
  const dpr = 2.75;
  const hand = pixelArtCss(120, dpr, 97);
  assert.equal((hand * dpr) / 97, 3);        // 3x, not 2.75x
  const piece = chessPieceCss(45, dpr);      // a ~45px square on a 393px screen
  assert.equal((piece * dpr) / 32, 3);       // 3x, not 2.75x
});
