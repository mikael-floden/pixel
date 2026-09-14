// CHIMNEY SMOKE — the plume's arithmetic, and the SEAM it hangs on.
//
// What a screenshot cannot see and would be wrong forever: a plume that leans
// the same amount at the roofline and thirty pixels up (which reads as a post),
// a puff that shrinks as it climbs (smoke leaving a hole only expands), a
// chimney whose stoke is re-rolled on every scenery rebuild, a mark whose two
// tones are not actually two, and — the one that matters most — a vent point
// read off the wrong STATE, the wrong FACING or the wrong side of a flip, which
// puts the smoke in the brickwork beside the hole the scenery domain spent four
// rounds of the maintainer's corrections measuring.
//
// THE PARSE HALF READS THE REAL SHIPPED MANIFESTS, which is possible because
// scenery3.ts is pure (no Phaser, no DOM). It skips when the sibling domain is
// absent — the deploy's sparse checkout has no `scenery/` (docs/testing.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CURL_PX,
  GAP_MS,
  CORE_FRAC,
  PER_VENT,
  PUFF_LIFE,
  PUFF_R,
  RIM_MIX,
  RISE0,
  SPREAD_PX,
  STOKE_MS,
  WIND_X,
  blobPixels,
  driftX,
  driftY,
  flueTint,
  hash01,
  nextGap,
  puffAlpha,
  puffSize,
  riseY,
  smokes,
  stoke,
  stokePeriod,
  stokePhase,
  vents,
  weight,
} from "../../ambient/chimney/flue.js";
import {
  parsePiece,
  ventFor,
  ventPoint,
  facedDir,
  facedSprite,
  fitSprite,
  frameRect,
  stateFor,
  buildPlacements,
  firePlaces,
  fireUnder,
  HEARTH_CELLS,
  type SceneryPiece,
} from "../../client/src/scenery3.js";
import { isoFrame } from "../../client/src/tiles3.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const CHIMNEYS = join(REPO, "scenery", "chimneys");
const WORLD = join(REPO, "maps2", "worlds3", "the_game", "world.json");
const skip = !existsSync(CHIMNEYS);
const skipWorld = skip || !existsSync(WORLD);

/* -- the plume ------------------------------------------------------------- */

test("a vent is used only where the domain says it MEASURED a hole", () => {
  assert.equal(vents("opening"), true, "a real dark hole");
  assert.equal(vents("flue_top"), true, "the mouth of a pot drawn light, not dark");
  // the domain's own admission that it found neither and fell back to the
  // outline: a plume there comes out of the brickwork
  assert.equal(vents("silhouette"), false);
  assert.equal(vents(""), false);
  assert.equal(vents(null), false);
  assert.equal(vents(undefined), false);
});

test("the plume BENDS OVER as it climbs — the lean is not constant", () => {
  const life = 4000;
  // no curl, no spread: the wind alone, so the ramp is what is being measured
  const at = (t: number) => driftX(t * life, life, 0, 0, 0, 0);
  const early = at(0.2);
  const late = at(0.9);
  // px per second of age, early vs late: the later share must be bigger, or
  // the column is a leaning post rather than a plume
  const rEarly = early / (0.2 * life / 1000);
  const rLate = late / (0.9 * life / 1000);
  assert.ok(rLate > rEarly * 1.4, `the lean opens with height (${rEarly.toFixed(1)} -> ${rLate.toFixed(1)} px/s)`);
  assert.ok(rLate <= WIND_X, "...and never overtakes the wind it rides");
  assert.ok(driftY(life, life) > 0 && driftY(life, life) < 15, "a tilt, not a fall");
  assert.equal(driftX(-10, life, 3, 0, 0.3, 4), driftX(0, life, 3, 0, 0.3, 4), "clamped before birth");
});

test("the column is a ribbon at the mouth and a fan at the top", () => {
  const life = 4000;
  const spreadOnly = (t: number) => driftX(t * life, life, 0, 0, 0, SPREAD_PX) - driftX(t * life, life, 0, 0, 0, 0);
  assert.ok(spreadOnly(0.1) < SPREAD_PX * 0.05, `tight out of the hole (${spreadOnly(0.1).toFixed(2)}px)`);
  assert.ok(spreadOnly(1) > SPREAD_PX * 0.95, "and open at the end");
  let prev = -1;
  for (let t = 0; t <= 1; t += 0.02) {
    const s = spreadOnly(t);
    assert.ok(s >= prev - 1e-9, "never narrows");
    prev = s;
  }
  // the curl opens on the same ramp — a wisp at the mouth does not wander
  const curlAt = (t: number) => Math.abs(driftX(t * life, life, CURL_PX[1], Math.PI / 2, 0, 0) - driftX(t * life, life, 0, Math.PI / 2, 0, 0));
  assert.ok(curlAt(0.05) < curlAt(0.95), "the wander widens with height");
});

test("a puff is sized against the HOLE it comes out of", () => {
  // Measured on the shipped art at the published vent point: the flue mouth
  // runs 10-12 px across on the narrow stacks (chimney_002 10 px on a 28 px
  // stack, chimney_007 12 on 35), and scenery draws one art pixel to one
  // player pixel. The first cut topped out at a FOUR pixel mark — about a
  // third of the mouth — and the maintainer saw it straight away
  // (2026-09-14: "a bit small right now compared to the chimney hole").
  const widest = PUFF_R[PUFF_R.length - 1] * 2 + 1;
  const narrowest = PUFF_R[0] * 2 + 1;
  // "As wide as the hole" is the FLOOR, not the target — that reading is what
  // made the first correction miss. Smoke leaves at the mouth's width and then
  // billows into the air, so the top end is a multiple of the mouth.
  assert.ok(narrowest >= 8, `${narrowest}px at the flue is under the 10-12px mouth it leaves`);
  assert.ok(narrowest <= 13, `${narrowest}px at the flue is already wider than the stack's hole`);
  assert.ok(widest >= narrowest * 2.5, `it billows: ${narrowest}px at the mouth to ${widest}px at the top`);
  assert.ok(widest <= 33, `${widest}px is a cloud bank, not a plume`);
  let prev = 0;
  for (const r of PUFF_R) {
    assert.ok(r > prev, "the radii climb");
    prev = r;
  }
  // and the blob is ROUND: smoke is in the air, not lying on the ground, so it
  // takes none of the projection's squash
  for (const r of PUFF_R) {
    const { core, rim } = blobPixels(r);
    const all = [...core, ...rim];
    const xs = all.map(([x]) => x);
    const ys = all.map(([, y]) => y);
    assert.equal(Math.max(...xs), -Math.min(...xs), `r=${r} is symmetric across x`);
    assert.equal(Math.max(...ys), -Math.min(...ys), `r=${r} is symmetric across y`);
    assert.equal(Math.max(...xs), Math.max(...ys), `r=${r} is ROUND, not squashed — a puff is in the air`);
    assert.ok(all.length > 3 * r, `r=${r} drew ${all.length}px`);
    for (const [x, y] of all) assert.ok(Math.sqrt(x * x + y * y) <= r + 0.36, `r=${r}: (${x},${y}) is outside the disc`);
    // the two tones: a pale core inside a darker rim, both present at every size
    assert.ok(core.length > 0, `r=${r} has a core`);
    assert.ok(rim.length > 0, `r=${r} has a rim`);
    for (const [x, y] of core) assert.ok(Math.sqrt(x * x + y * y) <= r * CORE_FRAC, `r=${r}: core pixel (${x},${y}) is out in the rim`);
    assert.ok(rim.length >= core.length * 0.5, `r=${r}: the rim is not a hairline (${rim.length} vs ${core.length})`);
  }
  // a column of these overlaps into one plume, so it holds FEWER of them
  assert.ok(PER_VENT >= 5 && PER_VENT <= 12, `${PER_VENT} marks a column — fewer, bigger, softer`);
  // AND THE COLUMN HAS TO BE TALL ENOUGH TO HOLD THEM. At the top size a plume
  // must be several marks tall or it is a lump sitting on the chimney: this is
  // the check that would have caught the size change undoing itself.
  const climb = riseY(PUFF_LIFE[0], PUFF_LIFE[0], RISE0[0]);
  assert.ok(climb > widest * 2.5, `the shortest plume climbs ${climb.toFixed(0)}px for a ${widest}px mark — under ${(widest * 2.5).toFixed(0)} it is a blob, not a column`);
});

test("a puff only ever gets BIGGER — smoke out of a hole expands", () => {
  const life = PUFF_LIFE[1];
  let prev: number = puffSize(0, life);
  assert.equal(prev, 1, "one pixel at the mouth");
  for (let t = 0; t <= life; t += 20) {
    const n = puffSize(t, life);
    assert.ok(n >= prev, `never shrinks (${prev} -> ${n} at ${t}ms)`);
    prev = n;
  }
  assert.equal(puffSize(life, life), 4, "and it is a body of smoke by the end");
});

test("a puff is dense out of the flue, HOLDS, then thins to nothing", () => {
  const life = 4000;
  assert.equal(puffAlpha(-1, life), 0, "not there before it is there");
  assert.equal(puffAlpha(life, life), 0, "gone at the end, not cut");
  assert.ok(puffAlpha(life * 0.02, life) < 0.5, "it does still thicken — nothing switches on");
  assert.ok(puffAlpha(life * 0.1, life) > 0.99, "...but fast: this came out of a pipe, not off a flame");
  assert.ok(puffAlpha(life * 0.29, life) > 0.99, "and holds for the first third");
  let prev = 1;
  for (let t = life * 0.3; t < life; t += 20) {
    const a = puffAlpha(t, life);
    assert.ok(a <= prev + 1e-9, "then only thins");
    prev = a;
  }
  assert.ok(puffAlpha(life * 0.8, life) < 0.4, "well gone by the top of its life");
});

test("it rises, slowing, and clears a roof", () => {
  const life = PUFF_LIFE[0];
  const up = RISE0[0];
  assert.equal(riseY(0, life, up), 0);
  let prev = 0;
  for (let t = 20; t <= life; t += 20) {
    const y = riseY(t, life, up);
    assert.ok(y >= prev, "never sinks");
    prev = y;
  }
  // the slowest puff still climbs clear of a 72px stack's own height
  assert.ok(prev > 30, `the shortest plume still climbs ${prev.toFixed(0)}px`);
  const first = riseY(life * 0.1, life, up) / (life * 0.1);
  const last = (riseY(life, life, up) - riseY(life * 0.9, life, up)) / (life * 0.1);
  assert.ok(last < first, "and it slows as it cools");
});

test("each stack breathes on its OWN cycle, and the same one every time", () => {
  // deterministic: a scenery rebuild (every 96px of camera) must not re-roll it
  assert.equal(stokePhase(41), stokePhase(41));
  assert.notEqual(stokePhase(41), stokePhase(42));
  for (const place of [0, 1, 7, 41, 3000]) {
    const p = stokePeriod(place);
    assert.ok(p >= STOKE_MS[0] && p <= STOKE_MS[1], `period ${p} outside its band`);
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < p * 2; t += 100) {
      const s = stoke(t, place);
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
    assert.ok(lo > 0.4, `a hearth keeps embers (low ${lo.toFixed(2)}) — it never goes out`);
    assert.ok(hi > 0.95 && hi <= 1.0001, `and is stoked right up (high ${hi.toFixed(2)})`);
  }
  // two stacks in a village are never in step
  const a: number[] = [];
  const b: number[] = [];
  for (let t = 0; t < 30_000; t += 500) {
    a.push(stoke(t, 11));
    b.push(stoke(t, 12));
  }
  assert.ok(a.some((v, i) => Math.abs(v - b[i]) > 0.2), "two flues do not pulse together");
  // ...and hash01 is a hash, not a ramp
  const seen = new Set(Array.from({ length: 400 }, (_, i) => Math.floor(hash01(i) * 20)));
  assert.ok(seen.size >= 18, `spread over its range (${seen.size}/20 buckets)`);
  for (let i = 0; i < 500; i++) {
    const v = hash01(i);
    assert.ok(v >= 0 && v < 1, `hash01(${i}) = ${v} out of range`);
  }
});

test("a stoked fire puffs FASTER, and never faster than the gap band", () => {
  let seed = 5;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  let hot = 0;
  let cold = 0;
  for (let i = 0; i < 200; i++) hot += nextGap(rnd, 1);
  for (let i = 0; i < 200; i++) cold += nextGap(rnd, 0.45);
  assert.ok(cold > hot * 1.5, `a banked fire lets go less often (${(cold / 200).toFixed(0)} vs ${(hot / 200).toFixed(0)}ms)`);
  assert.ok(nextGap(() => 0, 1) >= GAP_MS[0], "never quicker than the band's floor");
  assert.ok(nextGap(() => 0.999, 0.3) <= (GAP_MS[1] / 0.3) + 1, "and the divide is clamped");
  // the ceiling holds a column, not a cloud
  assert.ok(PER_VENT >= 6 && PER_VENT <= 20, "enough marks to read as a line, few enough to be smoke");
});

test("the mark is TWO tones, and the pale one never reaches white at night", () => {
  const lum = (c: number) => 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
  const day = flueTint(1);
  const night = flueTint(0);
  assert.ok(lum(day) > lum(night), "paler by day");
  assert.ok(lum(night) <= 130, `not a white dot on night ground (${lum(night).toFixed(0)}) — the ants' verdict`);
  assert.ok(lum(day) <= 230, "and never white even at noon: this is smoke, not a light");
  // neutral: a warm tint reads as dust, a cool one as mist (the campfire's law)
  for (const c of [day, night]) {
    assert.equal((c >> 16) & 255, (c >> 8) & 255);
    assert.equal((c >> 8) & 255, c & 255);
  }
  // THE TWO TONES STRADDLE THE ROOFS THIS GAME ACTUALLY HAS. tiles3
  // ground_types: snow 241.5, grey_paving_stone 168, grey_stone 128.2,
  // parquet_floor 127.2, brown_paving_stone 115.8 — over grass at 60.8.
  const ALPHA = 0.58;
  const core = lum(day);
  const rim = core * RIM_MIX;
  for (const [name, bg] of [["snow", 241.5], ["grey_paving", 168], ["grey_stone", 128.2], ["brown_paving", 115.8], ["grass", 60.8]] as const) {
    const dCore = Math.abs(bg * (1 - ALPHA) + core * ALPHA - bg);
    const dRim = Math.abs(bg * (1 - ALPHA) + rim * ALPHA - bg);
    assert.ok(
      Math.max(dCore, dRim) > 25,
      `${name} (${bg}): one tone must depart from it — core ${dCore.toFixed(1)}, rim ${dRim.toFixed(1)} luma`,
    );
  }
  assert.ok(RIM_MIX > 0.2 && RIM_MIX < 0.7, "a rim, not a second colour and not the same one");
});

test("a hearth is banked at noon, roaring at night, and never out", () => {
  assert.ok(weight(1, 0) > 0.3, "there is always a fire in there");
  assert.ok(weight(0, 0) > weight(1, 0), "and more of one after dark");
  assert.ok(weight(1, 1) > weight(1, 0), "rain stokes it");
  for (const [s, r] of [[0, 0], [0.5, 0.5], [1, 1], [-1, 5], [2, -3]]) {
    const w = weight(s, r);
    assert.ok(w >= 0 && w <= 1, `weight(${s},${r}) = ${w} out of range`);
  }
});

/* -- the seam: the published vent, on the art that is actually drawn -------- */

const pieces = () =>
  readdirSync(CHIMNEYS)
    .filter((d) => existsSync(join(CHIMNEYS, d, "scenery.json")))
    .map((d) => {
      const json = JSON.parse(readFileSync(join(CHIMNEYS, d, "scenery.json"), "utf8"));
      const p = parsePiece(`chimneys/${d}`, json);
      assert.ok(p, `chimneys/${d} parses`);
      return { d, json, piece: p! };
    });

test("every shipped chimney publishes a vent the game can read", { skip }, () => {
  const all = pieces();
  assert.ok(all.length >= 3, `the group ships pieces (${all.length})`);
  for (const { d, piece } of all) {
    assert.ok(piece.vent, `${d} publishes a vent at the piece root`);
    const states = Object.keys(piece.states);
    assert.ok(states.length > 0);
    for (const key of states) {
      const v = ventFor(piece, piece.states[key]);
      assert.ok(v, `${d}#${key} resolves a vent`);
      assert.ok(vents(v!.conf), `${d}#${key} conf ${v!.conf} is a measured hole`);
      // the mouth is ABOVE the canvas centre on every stack — a vent below it
      // is a measurement that found the base of the art
      assert.ok(v!.dy < 0, `${d}#${key} vents upward (dy ${v!.dy})`);
      assert.ok(Math.abs(v!.dx) < 48 && Math.abs(v!.dy) < 48, `${d}#${key} inside a 96px canvas`);
    }
  }
});

test("the vent is per STATE and per FACING — and the states really do differ", { skip }, () => {
  let moved = 0;
  for (const { piece } of pieces()) {
    const keys = Object.keys(piece.states);
    const pts = keys.map((k) => ventFor(piece, piece.states[k])!);
    if (pts.some((p) => Math.abs(p.dx - pts[0].dx) > 1 || Math.abs(p.dy - pts[0].dy) > 1)) moved++;
    // ...and a three-quarter view puts the hole somewhere else again
    for (const k of keys) {
      const st = piece.states[k];
      const s = ventFor(piece, st, "south")!;
      for (const dir of ["south-east", "south-west"]) {
        if (!st.rotations[dir]) continue;
        const r = ventFor(piece, st, dir)!;
        assert.ok(Number.isFinite(r.dx) && Number.isFinite(r.dy), `${piece.id}#${k} ${dir} resolves`);
        // it is allowed to coincide, but it must be READ from the facing's own
        // entry — proved by asking for a facing the piece does not have
        assert.deepEqual(ventFor(piece, st, "north"), s, "an absent facing falls back to south, like facedSprite");
      }
    }
  }
  assert.ok(moved >= 3, `a state's cap is its own on most pieces (${moved} of 8 move by more than a pixel)`);
});

test("the facing a vent is read under is the one facedSprite DREW", { skip }, () => {
  for (const { piece } of pieces()) {
    for (const key of Object.keys(piece.states)) {
      const st = piece.states[key];
      for (const dir of ["south", "south-east", "south-west", "north", "east", undefined]) {
        const drew = facedSprite(st, dir);
        const faced = facedDir(st, dir);
        // the sprite actually chosen and the facing the point is read under
        // have to be the same one, or the mark sits where the hole is on art
        // that is not on screen
        assert.equal(drew, st.rotations[faced] || st.rotations.south || st.sprite, `${piece.id}#${key} ${dir}`);
      }
    }
  }
});

test("ventPoint puts the mouth where the still actually draws that pixel", { skip }, () => {
  const canvas = { w: 96, h: 96 };
  const bbox: [number, number, number, number] = [34, 17, 62, 76];
  for (const flipX of [false, true]) {
    const fit = fitSprite(bbox, canvas, 59, 400, 300, flipX);
    // frameRect maps a WHOLE canvas under the same transform, so it is the
    // independent witness: the canvas pixel the vent names must land on the
    // same screen pixel either way.
    const fr = frameRect(fit, canvas, canvas)!;
    for (const pt of [{ dx: 0, dy: -28 }, { dx: 9.5, dy: -28 }, { dx: -7.5, dy: -29 }]) {
      const got = ventPoint(pt, fit, canvas);
      const cx = canvas.w / 2 + pt.dx;
      const cy = canvas.h / 2 + pt.dy;
      const want = {
        x: flipX ? fr.x + fr.w - cx * fit.kx : fr.x + cx * fit.kx,
        y: fr.y + cy * fit.ky,
      };
      assert.ok(Math.abs(got.x - want.x) < 1e-6, `x ${got.x} vs ${want.x} (flip ${flipX})`);
      assert.ok(Math.abs(got.y - want.y) < 1e-6, `y ${got.y} vs ${want.y} (flip ${flipX})`);
    }
    // and the mouth is inside the drawn box, not out in the air beside it
    const inside = ventPoint({ dx: 0, dy: -28 }, fit, canvas);
    assert.ok(inside.x >= fit.x && inside.x <= fit.x + fit.w, `${inside.x} within [${fit.x}, ${fit.x + fit.w}]`);
    assert.ok(inside.y >= fit.y && inside.y <= fit.y + fit.h, `${inside.y} within [${fit.y}, ${fit.y + fit.h}]`);
    assert.ok(inside.y < fit.y + fit.h / 2, "in the top half of the stack");
  }
  // THE FLIP IS ABOUT THE CROP'S CENTRE, not the canvas centre — an
  // off-centre bbox is where those two part company, and a chimney's is
  // allowed to be off-centre.
  const off: [number, number, number, number] = [20, 17, 62, 76];
  const a = ventPoint({ dx: 4, dy: -20 }, fitSprite(off, canvas, 59, 400, 300, false), canvas);
  const b = ventPoint({ dx: 4, dy: -20 }, fitSprite(off, canvas, 59, 400, 300, true), canvas);
  const f = fitSprite(off, canvas, 59, 400, 300, true);
  assert.ok(Math.abs((a.x + b.x) / 2 - (f.x + f.w / 2)) < 1e-6, "the pair straddles the CROP's centre");
});

test("the drawn state of an unlit chimney resolves, and it is not a LIT one", { skip }, () => {
  for (const { piece } of pieces()) {
    const st = stateFor(piece, false, null);
    assert.ok(st, `${piece.id} resolves a base state`);
    assert.ok(!st.key.startsWith("LIT"), `${piece.id} is an unlit fixture (${st.key})`);
    assert.ok(ventFor(piece, st), `${piece.id} vents in the state it draws`);
  }
});

/* -- the seam: WHAT IS BURNING UNDER THE STACK ------------------------------ */
//
// The one his eye caught that no arithmetic could (2026-09-14, standing in a
// house with a cold hearth): "the fire in the house is not burning (not a LIT
// state) and you still show smoke when I walk out". A chimney is masonry — the
// plume is the FIRE's, and 6 of the_game's 8 stacks stand over a hearth that is
// out. The join cannot be made from the display list, because from the street
// the hearth is indoor furniture and is not drawn at all; it is made off the
// placement index, which holds every piece whatever is drawn.

test("a stack smokes only over a hole AND a fire", () => {
  assert.equal(smokes("opening", true), true, "a measured hole over a burning hearth");
  assert.equal(smokes("flue_top", true), true);
  assert.equal(smokes("opening", false), false, "the hearth is out — masonry, not a smoke machine");
  // no fire under it at all reads the same as a cold one: nothing is burning
  assert.equal(smokes("opening", undefined), false, "an older game build has no answer — stay quiet");
  assert.equal(smokes("silhouette", true), false, "a roaring fire cannot rescue a guessed hole");
  assert.equal(smokes(null, true), false);
  assert.equal(smokes("", false), false);
});

test("fireUnder takes the NEAREST fire, and only within reach", () => {
  const at = (x: number, y: number, lit: boolean, id = `p/${x}_${y}`) =>
    ({ p: { piece: id, x, y } as never, state: lit ? "LIT_1" : "NOT_LIT_1", lit });
  const fires = [at(10, 10, false), at(10.2, 10, true), at(11.4, 10, true)];
  assert.equal(fireUnder(fires, 10, 10)?.p.piece, "p/10_10", "the one it stands on");
  assert.equal(fireUnder(fires, 10.3, 10)?.p.piece, "p/10.2_10", "...and not the one a hair further");
  // the neighbour's hearth is 1.4 cells off — past the radius, so unseen
  assert.equal(fireUnder(fires, 11.4, 10)?.p.piece, "p/11.4_10");
  assert.equal(fireUnder(fires, 12.5, 10), null, "nothing within half a cell");
  assert.ok(HEARTH_CELLS > 0 && HEARTH_CELLS < 1.3, `the radius clears the nearest wrong answer (${HEARTH_CELLS})`);
});

test("a fire is judged by the ART IT DRAWS, not by the doc's lit flag", () => {
  // A piece with no LIT state: the flag says lit, stateFor falls back to unlit
  // art, and the hearth is COLD. Reading the flag would smoke over a fire that
  // is not drawn burning anywhere on screen.
  const cold = parsePiece("test/cold", {
    sprite: "a.webp",
    light: { strength: 1, color: "#fff", radius: 4, kind: "fire/open", flame: true },
    states: { NOT_LIT_1: { sprite: "a.webp" } },
  }) as SceneryPiece;
  const warm = parsePiece("test/warm", {
    sprite: "a.webp",
    light: { strength: 1, color: "#fff", radius: 4, kind: "fire/open", flame: true },
    states: { LIT_1: { sprite: "b.webp" }, NOT_LIT_1: { sprite: "a.webp" } },
  }) as SceneryPiece;
  const glow = parsePiece("test/glow", {
    sprite: "a.webp",
    light: { strength: 1, color: "#fff", radius: 4, kind: "glow/magic", flame: false },
    states: { LIT_1: { sprite: "b.webp" } },
  }) as SceneryPiece;
  const by: Record<string, SceneryPiece> = { "test/cold": cold, "test/warm": warm, "test/glow": glow };
  const places = [
    { piece: "test/cold", x: 1, y: 1, lit: true },
    { piece: "test/warm", x: 2, y: 2, lit: true },
    { piece: "test/warm", x: 3, y: 3, lit: false, state: "NOT_LIT_1" },
    { piece: "test/glow", x: 4, y: 4, lit: true },
    { piece: "test/gone", x: 5, y: 5, lit: true },
  ] as never[];
  const fires = firePlaces(places, (id) => by[id]);
  assert.deepEqual(
    fires.map((f) => `${f.p.piece}#${f.state}:${f.lit}`),
    ["test/cold#NOT_LIT_1:false", "test/warm#LIT_1:true", "test/warm#NOT_LIT_1:false"],
    "flame pieces only, each at the state it draws",
  );
  assert.equal(fireUnder(fires, 4, 4), null, "a magic glow is not a fire");
  assert.equal(fireUnder(fires, 5, 5), null, "a manifest that has not landed is simply not here yet");
});

test("the_game: every stack is paired with a fire, and the pairing has room", { skip: skipWorld }, () => {
  const doc: any = JSON.parse(readFileSync(WORLD, "utf8"));
  // A FLAT FRAME OVER THE WHOLE WORLD. The join reads `x`, `y`, `piece`, `lit`
  // and `state` — the iso projection and the levels reach only `ax`/`ay`, which
  // nothing here touches — so the frame exists to let the REAL resolver run
  // rather than a hand-rolled projection that could drift from it.
  const frame = isoFrame({ x0: 0, y0: 0, x1: doc.size.w, y1: doc.size.h }, 0, 15);
  const places = buildPlacements(doc.scenery, { frame, levelAt: () => 0, width: doc.size.w });
  assert.equal(places.length, doc.scenery.length, "every placement resolves (nothing dropped by the flat frame)");

  const cache = new Map<string, SceneryPiece | null>();
  const pieceOf = (id: string) => {
    if (!cache.has(id)) {
      const f = join(REPO, "scenery", id, "scenery.json");
      cache.set(id, existsSync(f) ? parsePiece(id, JSON.parse(readFileSync(f, "utf8"))) : null);
    }
    return cache.get(id);
  };
  const fires = firePlaces(places, pieceOf);
  assert.ok(fires.length > 50, `the world is full of fires (${fires.length})`);

  const stacks = places.filter((p) => {
    const piece = pieceOf(p.piece);
    return !!piece && !!ventFor(piece, stateFor(piece, p.lit, p.state), p.dir);
  });
  assert.ok(stacks.length >= 4, `the world places vents (${stacks.length})`);
  const verdicts = stacks.map((p) => ({ p, f: fireUnder(fires, p.x, p.y) }));

  /* THE PAIRING IS THE INVARIANT. The dressing pass drops the fire and the
   * chimney over it at ONE point, and that is what the join relies on — so a
   * stack that lands with no fire under it is either a chimney placed on a cold
   * roof (which must never smoke and would look broken doing it) or a pairing
   * that has drifted past the radius. Either way it is worth a failure here
   * rather than a plume nobody can explain. */
  for (const { p, f } of verdicts)
    assert.ok(f, `the stack at ${p.x},${p.y} (${p.piece}) stands over a fire — the pair is placed at one point`);
  for (const { p, f } of verdicts) {
    const own = Math.hypot(f!.p.x - p.x, f!.p.y - p.y);
    assert.ok(own < 0.05, `${p.piece} sits on its fire (${own.toFixed(3)} cells)`);
    const next = fires
      .filter((g) => g !== f)
      .reduce((m, g) => Math.min(m, Math.hypot(g.p.x - p.x, g.p.y - p.y)), Infinity);
    assert.ok(next > HEARTH_CELLS * 2, `the next fire to ${p.piece} is ${next.toFixed(2)} cells off, clear of ${HEARTH_CELLS}`);
  }

  /* HOW MANY OF THEM BURN IS THE MAPS2 AGENT'S TO TUNE, and it moves under this
   * file: his report landed on a world where 2 of 8 hearths were lit, and the
   * maps2 agent lit 8 of 10 within the hour ("the fires take their slots from
   * the street lamps", d5b1905b0). So the tally is REPORTED and not asserted —
   * only that a burning one exists at all, without which every arm that proves
   * the plume draws is measuring an empty world. */
  const burning = verdicts.filter((v) => v.f!.lit);
  const report = verdicts
    .map((v) => `${Math.round(v.p.x)},${Math.round(v.p.y)}:${v.f!.lit ? "LIT" : "out"}`)
    .join(" ");
  assert.ok(burning.length > 0, `some stack has a fire burning under it — ${report}`);
  assert.ok(burning.length <= stacks.length, `${burning.length} of ${stacks.length} stacks burn — ${report}`);

  // HIS HOUSE. The chimney from the screenshot, named so that the pairing it
  // exposed keeps being checked at the exact spot he stood. Its hearth's STATE
  // is the maps2 agent's to set (it was NOT_LIT_2 when he reported it and is
  // lit today) — that it resolves to a hearth at all is this join's business.
  const his = verdicts.find((v) => Math.hypot(v.p.x - 333.3, v.p.y - 232.3) < 0.6);
  assert.ok(his, "the chimney at 333.3,232.3 is still placed");
  assert.ok(his!.f!.p.piece.startsWith("hearths/"), `a hearth stands under it (${his!.f!.p.piece}#${his!.f!.state})`);
  assert.equal(
    his!.f!.lit,
    his!.f!.state.startsWith("LIT"),
    "the verdict and the drawn state agree — the art is what decides",
  );
});
