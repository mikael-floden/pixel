// DAWN MIST IN THE HOLLOWS — where it belongs, how thick, and when it burns off.
//
// What a screenshot cannot see and would be wrong forever: fog on a hilltop,
// fog over the whole map, a bank that pops into existence, a "mist" effect that
// gets THICKER as the sky clouds over (which is backwards — radiation fog needs
// a clear sky), and a dither that is really a solid blob.
//
// The last test reads the SHIPPED WORLD and pins the RARITY against it: the
// model has to find the hollows in the_game and refuse its ridges and its
// plain. It skips first when the world tree is absent — the deploy's sparse
// checkout has none (docs/testing.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BREATHE,
  MAX_PATCHES,
  MIN_DAMP,
  MIST,
  PATCH_LIFE,
  PATCH_RX,
  PER_SPOT,
  WATER_BONUS,
  basin,
  breathe,
  countFor,
  damp,
  ditherPixels,
  driftX,
  driftY,
  hash01,
  nextGap,
  patchAlpha,
  sizeFor,
  weight,
} from "../../ambient/dawnmist/hollow.js";
import { RING_RY } from "../../ambient/runtime/ellipse.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORLD = join(HERE, "..", "..", "..", "maps2", "worlds3", "the_game", "world.json");
const skip = !existsSync(WORLD);

test("a ridge never fogs, and a pit always does", () => {
  // the ring is all BELOW: a hilltop
  assert.equal(basin(9, [8, 7, 6, 8, 7, 6]), 0);
  assert.equal(basin(4, [4, 4, 4, 4, 4, 4]), 0, "flat ground is not a hollow either");
  // the ring is all ABOVE by two or more: a pit
  assert.equal(basin(0, [2, 3, 4, 2, 5, 2]), 1);
  // one level of rise already counts for half — a level is most of a person
  assert.equal(basin(0, [1, 1, 1, 1, 1, 1]), 0.5);
  // THE FOOT OF A CLIFF is the case that matters and it is a partial one: half
  // the ring stands in the air and half against the wall.
  const foot = basin(0, [0, 0, 0, 6, 6, 6]);
  assert.ok(foot > 0.4 && foot < 0.6, `a cliff foot is half enclosed (${foot})`);
  assert.equal(basin(0, []), 0, "no samples, no verdict");
  // monotone: the higher the walls, the deeper the hollow
  let prev = -1;
  for (let h = 0; h <= 6; h++) {
    const b = basin(0, [h, h, h, h, h, h]);
    assert.ok(b >= prev, "deeper walls never read as shallower");
    prev = b;
  }
});

test("water makes a flat bank damp, but a dry plain stays dry", () => {
  assert.equal(damp(0, false), 0, "a dry plain does not fog");
  assert.ok(damp(0, false) < MIN_DAMP);
  assert.equal(damp(0, true), WATER_BONUS, "a flat bank beside water is a wisp");
  assert.ok(damp(0, true) >= MIN_DAMP, "...and that wisp is allowed to draw");
  assert.ok(damp(0.5, true) > damp(0.5, false), "water on top of a hollow is thicker still");
  assert.equal(damp(1, true), 1, "clamped");
  assert.equal(damp(-3, false), 0, "clamped the other way");
});

test("the sun burns it off, and a CLOUDY sky thins it — not the other way round", () => {
  assert.equal(weight(0, "Morning", 0, 0), 1, "first light on a clear morning is the whole point");
  assert.ok(weight(0.2, "Morning", 0, 0) > 0.95, "still full as the sun clears the horizon");
  // ...and gone by mid-morning. Not `equal(…, 0)`: the ramp ends on a float
  // division and lands on 1.1e-16 at its own edge, which is zero for every
  // purpose this feature has (the park threshold is 0.02) and is not worth
  // bending the model to fake. It IS exactly zero once the clamp saturates.
  assert.ok(weight(0.6, "Morning", 0, 0) < 1e-6, "and gone by mid-morning");
  assert.equal(weight(0.7, "Morning", 0, 0), 0, "...flatly zero past the ramp");
  assert.equal(weight(1, "Day", 0, 0), 0, "nothing at noon");
  assert.ok(weight(0, "Night", 0, 0) > 0.5, "fog forms in the small hours — it is there before dawn");
  assert.ok(weight(0, "Morning", 0, 0) > weight(0, "Evening", 0, 0), "he asked for DAWN, not dusk");
  assert.ok(weight(0, "Evening", 0, 0) > 0, "...but dusk is the same phenomenon and gets a hint of it");
  // THE COUNTER-INTUITIVE ONE, asserted so nobody 'fixes' it: radiation fog
  // needs a clear sky, because cloud is a blanket that stops the ground
  // radiating its heat away. More cloud = LESS ground fog.
  assert.ok(weight(0, "Morning", 1, 0) < weight(0, "Morning", 0, 0), "cloud THINS ground fog");
  assert.ok(weight(0, "Morning", 1, 0) > 0, "...thins, not kills");
  assert.equal(weight(0, "Morning", 0, 1), 0, "rain beats it down");
  for (const [s, p, c, r] of [[-1, "Morning", -1, -1], [5, "Day", 5, 5], [0.5, "", 0.5, 0.5]] as const) {
    const w = weight(s, p as string, c, r);
    assert.ok(w >= 0 && w <= 1, `weight(${s},${p},${c},${r}) = ${w} out of range`);
  }
});

test("a bank thickens and thins — it never pops", () => {
  const life = PATCH_LIFE[0];
  assert.ok(life >= 8000, "fog does not flicker; a patch is in the air for seconds");
  assert.equal(patchAlpha(-1, life), 0);
  assert.equal(patchAlpha(0, life), 0, "not there before it is there");
  assert.equal(patchAlpha(life, life), 0, "gone at the end, not cut");
  assert.equal(patchAlpha(life * 0.2, life), 1, "a fifth of its life fading in");
  assert.equal(patchAlpha(life * 0.5, life), 1);
  assert.ok(patchAlpha(life * 0.9, life) < 0.6, "and a fifth fading out");
  // ...and it breathes while it holds, without ever blinking out
  let lo = Infinity;
  let hi = -Infinity;
  for (let t = 0; t <= 12000; t += 50) {
    const b = breathe(t, 6000, 0.7);
    lo = Math.min(lo, b);
    hi = Math.max(hi, b);
  }
  assert.ok(lo > 1 - BREATHE - 1e-9 && lo < 1, `breathes down to ${lo.toFixed(3)}, never out`);
  assert.ok(hi <= 1 + 1e-9 && hi > 0.99, `and back up to ${hi.toFixed(3)}`);
});

test("it lies still — a bank that visibly slides is steam", () => {
  const life = PATCH_LIFE[1];
  const dx = driftX(life);
  const dy = driftY(life);
  assert.ok(dx > 8, `it does move (${dx.toFixed(1)}px over a whole life)`);
  assert.ok(dx < 64, `...but about a cell, not across the screen (${dx.toFixed(1)}px)`);
  assert.ok(dy > 0 && dy < dx, "and the down-screen share is the smaller one");
  assert.equal(driftX(-50), 0, "clamped before birth");
});

test("the patch is DITHERED: inside the ellipse, dense in the middle, never solid", () => {
  for (const rx of PATCH_RX) {
    const ry = Math.max(1, Math.round(rx * RING_RY));
    const px = ditherPixels(rx, ry, 11);
    assert.ok(px.length > 20, `${rx}: something was drawn (${px.length}px)`);
    let core = 0;
    let rim = 0;
    let coreSlots = 0;
    let rimSlots = 0;
    for (const [x, y] of px) {
      const t = Math.sqrt((x / rx) ** 2 + (y / ry) ** 2);
      assert.ok(t <= 1 + 1e-9, `${rx}: (${x},${y}) is outside the ellipse`);
      if (t < 0.4) core++;
      else if (t > 0.8) rim++;
    }
    for (let y = -ry; y <= ry; y++)
      for (let x = -rx; x <= rx; x++) {
        const t = Math.sqrt((x / rx) ** 2 + (y / ry) ** 2);
        if (t > 1) continue;
        if (t < 0.4) coreSlots++;
        else if (t > 0.8) rimSlots++;
      }
    const coreFill = core / coreSlots;
    const rimFill = rim / rimSlots;
    assert.ok(coreFill > rimFill * 1.5, `${rx}: denser in the middle (${coreFill.toFixed(2)} vs ${rimFill.toFixed(2)})`);
    assert.ok(coreFill < 0.97, `${rx}: never a solid core (${coreFill.toFixed(2)}) — that is a puddle, not fog`);
    assert.ok(rimFill < 0.35, `${rx}: the rim is mostly gaps (${rimFill.toFixed(2)})`);
    // the squash is the PROJECTION's: a round patch would stand up out of the ground
    assert.ok(Math.abs(ry / rx - RING_RY) < 0.06, `${rx}: iso-squashed (${(ry / rx).toFixed(3)} vs ${RING_RY.toFixed(3)})`);
  }
  // deterministic per seed, and different seeds are different patterns
  const a = ditherPixels(26, 11, 11);
  const b = ditherPixels(26, 11, 11);
  const c = ditherPixels(26, 11, 23);
  assert.deepEqual(a, b, "the same seed builds the same texture every time");
  assert.notDeepEqual(a, c, "a different seed is a different pattern");
  for (let i = 0; i < 200; i++) {
    const h = hash01(i % 17, (i * 7) % 13, 37);
    assert.ok(h >= 0 && h < 1, `hash01 out of range: ${h}`);
  }
});

test("a damper spot gets bigger patches and more of them", () => {
  let seed = 9;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const mean = (d: number) => {
    let s = 0;
    for (let i = 0; i < 400; i++) s += sizeFor(d, rnd);
    return s / 400;
  };
  const thin = mean(MIN_DAMP);
  const thick = mean(1);
  assert.ok(thick > thin, `a deep hollow draws bigger (${thick.toFixed(2)} vs ${thin.toFixed(2)})`);
  for (const d of [0, MIN_DAMP, 0.5, 1]) {
    const s = sizeFor(d, rnd);
    assert.ok(Number.isInteger(s) && s >= 0 && s < PATCH_RX.length, `sizeFor(${d}) = ${s} is not a size`);
  }
  assert.ok(countFor(1) > countFor(MIN_DAMP), "and more of them");
  assert.ok(countFor(0) >= 1, "a spot that got this far always puts something down");
  assert.ok(countFor(1) <= PER_SPOT + 1, "a cluster, not a wall");
  assert.ok(MAX_PATCHES >= countFor(1) * 4, "several banks fit in one view");
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 300; i++) {
    const g = nextGap(rnd);
    lo = Math.min(lo, g);
    hi = Math.max(hi, g);
  }
  assert.ok(lo >= 400 && hi <= 900, `the placement gap stays in its band (${lo}..${hi})`);
});

test("the colour is a pale, near-neutral grey — the background palette law", () => {
  const r = (MIST >> 16) & 255;
  const g = (MIST >> 8) & 255;
  const b = MIST & 255;
  const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b);
  assert.ok(sat < 0.45, `saturation ${sat.toFixed(3)} is under MAX_SAT — this is background`);
  assert.ok(sat < 0.1, `...and in fact near-neutral (${sat.toFixed(3)}): warm reads as dust, blue as magic`);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  assert.ok(lum > 180, `pale (${lum.toFixed(0)})`);
  assert.ok(lum < 245, "but not white: it is drawn UNDER the night overlay and graded with the ground");
});

test("on the SHIPPED WORLD it finds the hollows, refuses the ridges, and stays rare", { skip }, () => {
  const w = JSON.parse(readFileSync(WORLD, "utf8"));
  const W = w.size.w;
  const H = w.size.h;
  const lvl: number[][] = w.level;
  const gnd: number[][] = w.ground;
  const liquid = new Set<number>(
    (w.liquids as string[]).map((n) => (w.grounds as string[]).indexOf(n)).filter((i) => i >= 0),
  );
  const R = 3;
  const ringAt = (x: number, y: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const px = Math.round(x + Math.cos(a) * R);
      const py = Math.round(y + Math.sin(a) * R);
      if (px >= 0 && px < W && py >= 0 && py < H) out.push(lvl[py][px]);
    }
    return out;
  };
  const land = w.land;
  let hollows = 0;
  let cells = 0;
  let peak = { x: 0, y: 0, l: -1 };
  for (let y = land.y0; y < land.y1; y++)
    for (let x = land.x0; x < land.x1; x++) {
      if (liquid.has(gnd[y][x])) continue;
      cells++;
      if (lvl[y][x] > peak.l) peak = { x, y, l: lvl[y][x] };
      if (basin(lvl[y][x], ringAt(x, y)) >= 0.5) hollows++;
    }
  const share = hollows / cells;
  // THE RARITY IS THE POINT. Measured 2026-09-13 on the_game: ~3.5% of the
  // land. A change that fogs a quarter of the world, or none of it, is a
  // different effect and should not pass quietly.
  assert.ok(share > 0.005, `${(share * 100).toFixed(2)}% of the land fogs — the world has hollows and this found none`);
  assert.ok(share < 0.15, `${(share * 100).toFixed(2)}% of the land fogs — that is weather, not a hollow`);
  // the highest point in the world is not a hollow
  assert.equal(basin(peak.l, ringAt(peak.x, peak.y)), 0, `the summit at ${peak.x},${peak.y} (level ${peak.l}) fogs`);
});
