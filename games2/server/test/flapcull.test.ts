// The maintainer's flap-frame CULL (art-original/cull.json, applied by
// scripts/cull_frames.py) drops the frames where a bird's wings look wrong.
//
// The cull packs each facing's kept frames to the LEFT of a still-16-wide sheet
// row and leaves the tail TRANSPARENT. That makes one failure mode possible
// that could not exist before: draw a frame index past the facing's kept count
// and the creature vanishes for that tick. It would show up in game as birds
// flickering — easy to misread as a lighting or depth bug, and invisible to a
// typecheck — so both halves of the contract are pinned here:
//
//   1. the STATE MACHINE never produces an out-of-range frame, through turns
//      between facings with different counts (the risky case: a bird flying
//      west has 16 frames, north-west 11 — a turn must re-seat the cycle);
//   2. the SHIPPED ART actually matches the counts the runtime is trusting —
//      art in every kept slot, nothing in the padding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FLY_FRAMES, FlapState, stepFlapDir } from "../../ambient/runtime/flap.js";
// @ts-expect-error — plain .mjs helper shared with the build scripts
import { imgRGBA } from "../../scripts/imagelib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AMBIENT = join(HERE, "..", "..", "ambient");
const FRAME = 34;

const flap = JSON.parse(readFileSync(join(AMBIENT, "runtime", "flapframes.json"), "utf8"));
const cull = JSON.parse(readFileSync(join(AMBIENT, "art-original", "cull.json"), "utf8"));

const sheetOf = (critter: string) =>
  critter === "bat"
    ? join(AMBIENT, "bats", "art", "fly.webp")
    : join(AMBIENT, "birds", "art", critter, "fly.webp");

function mk(frames: readonly number[], dir = 0): FlapState {
  return { dir, dirHoldT: 0, vx: 1, vy: 0, frame: 0, flapMs: 10, flapT: 0, frames };
}

// Velocity that resolves to each PixelLab facing index. Facing is derived from
// VELOCITY inside stepFlapDir, so a test that just assigns b.dir has it silently
// overwritten on the same call and can never fail — steer, don't poke.
// (Diagonals are the shallow ISO tile axes, not screen-45°.)
const VEL: ReadonlyArray<readonly [number, number]> = [
  [0, 1], // 0 south
  [32, 15], // 1 south-east
  [1, 0], // 2 east
  [32, -15], // 3 north-east
  [0, -1], // 4 north
  [-32, -15], // 5 north-west
  [-1, 0], // 6 west
  [-32, 15], // 7 south-west
];

/** Point a creature at `dir` and let the real code commit the facing. */
function face(b: FlapState, dir: number): void {
  [b.vx, b.vy] = VEL[dir];
  for (let i = 0; i < 40; i++) stepFlapDir(b, 20, 110); // outlast DIR_STICK
}

test("the VEL fixtures really do resolve to the facings they claim", () => {
  // Guards the two tests below: if this drifts, they stop testing turns at all.
  for (let d = 0; d < 8; d++) {
    const b = mk([], (d + 4) % 8);
    face(b, d);
    assert.equal(b.dir, d, `velocity ${VEL[d]} should face ${d}, got ${b.dir}`);
  }
});

test("the cull table covers every critter the art ships, with sane counts", () => {
  const names = Object.keys(cull.drop);
  assert.deepEqual(Object.keys(flap.critters).sort(), names.sort());
  for (const n of names) {
    const c = flap.critters[n];
    assert.equal(c.count.length, 8, `${n}: expected 8 facings`);
    for (let d = 0; d < 8; d++) {
      assert.ok(c.count[d] >= 1, `${n} dir ${d}: a flyer needs at least one frame`);
      assert.ok(c.count[d] <= FLY_FRAMES, `${n} dir ${d}: more frames than the sheet holds`);
      // count must be exactly 16 minus what the maintainer asked to drop.
      const dropped = cull.drop[n][cull.dirs[d]].length;
      assert.equal(c.count[d], FLY_FRAMES - dropped, `${n} ${cull.dirs[d]}: count vs cull list`);
      assert.equal(c.keep[d].length, c.count[d]);
    }
  }
});

test("stepFlapDir never advances past a facing's kept frames", () => {
  // dt is deliberately SHORTER than flapMs for most ticks — that is the real
  // game (a ~16ms frame against a 15-21ms flap), and it is the case that bites:
  // if a turn only got re-seated by the advance itself, the frames in between
  // still point at padding. A fixed dt == flapMs hides the bug entirely.
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;

  for (const [name, c] of Object.entries<{ count: number[] }>(flap.critters)) {
    const b = mk(c.count);
    for (let i = 0; i < 4000; i++) {
      // Turn often, including hard swings onto much shorter facings.
      if (rnd() < 0.15) [b.vx, b.vy] = VEL[Math.floor(rnd() * 8)];
      stepFlapDir(b, 4 + rnd() * 14, 110);
      assert.ok(
        b.frame >= 0 && b.frame < c.count[b.dir],
        `${name}: frame ${b.frame} out of range for dir ${b.dir} (count ${c.count[b.dir]})`,
      );
    }
  }
});

test("a turn onto a SHORTER facing re-seats the cycle before it draws", () => {
  // bird4: west keeps 8 frames, north-west only 6 — the exact shape of the bug.
  const c: number[] = flap.critters.bird4.count;
  const long = c.indexOf(Math.max(...c));
  const short = c.indexOf(Math.min(...c));
  assert.ok(c[long] > c[short], "fixture needs facings with different counts");

  const b = mk(c);
  face(b, long);
  b.frame = c[long] - 1; // parked on a frame the SHORT facing does not have
  b.flapT = 0; // drain the accumulator, or the advance itself hides the re-seat
  [b.vx, b.vy] = VEL[short]; // steer at it; the real code commits the turn
  // dt 0: no flap advance, so this measures the RE-SEAT alone. Without it the
  // very next draw indexes transparent padding and the bird blinks out.
  stepFlapDir(b, 0, 110);
  assert.equal(b.dir, short, "the turn should have been committed");
  assert.ok(
    b.frame < c[short],
    `frame ${b.frame} still past the new facing's ${c[short]} frames`,
  );
});

test("flapMs is the real per-frame rate, not capped at one frame per tick", () => {
  // The bat's speed depends entirely on this. stepFlapDir used to subtract a
  // single flapMs per call, so every flapMs below the frame time drew at the
  // SAME rate (one frame per tick) and changing the constant did nothing.
  // Count advances over a simulated second of 60fps ticks.
  const advances = (flapMs: number) => {
    const b = mk([]);
    b.flapMs = flapMs;
    let n = 0;
    let prev = b.frame;
    for (let i = 0; i < 60; i++) {
      stepFlapDir(b, 1000 / 60, 110);
      n += (b.frame - prev + FLY_FRAMES) % FLY_FRAMES;
      prev = b.frame;
    }
    return n;
  };
  // ~1000/flapMs advances per second, well past the 60/s tick cap.
  assert.ok(advances(8) > 110, `8ms should give ~125 advances/s, got ${advances(8)}`);
  assert.ok(advances(4) > 220, `4ms should give ~250 advances/s, got ${advances(4)}`);
  // And a bat at ~8ms must be about twice a bird at ~17ms.
  const ratio = advances(8.5) / advances(17);
  assert.ok(ratio > 1.7 && ratio < 2.3, `bat:bird rate ratio should be ~2, got ${ratio.toFixed(2)}`);
});

test("art with no cull table falls back to the full row instead of freezing", () => {
  // frames: [] models un-culled art (or a garbled table). Must behave as before.
  const b = mk([]);
  const seen = new Set<number>();
  for (let i = 0; i < 400; i++) {
    stepFlapDir(b, 10, 110);
    seen.add(b.frame);
  }
  assert.equal(seen.size, FLY_FRAMES, "should cycle all 16 frames when uncounted");
});

test("the shipped sheets match the counts the runtime trusts", () => {
  for (const [name, c] of Object.entries<{ count: number[]; keep: number[][] }>(flap.critters)) {
    const img = imgRGBA(sheetOf(name));
    assert.equal(img.width, FRAME * FLY_FRAMES, `${name}: sheet width`);
    assert.equal(img.height, FRAME * 8, `${name}: sheet height`);

    const opaque = (col: number, row: number) => {
      for (let y = row * FRAME; y < (row + 1) * FRAME; y++) {
        for (let x = col * FRAME; x < (col + 1) * FRAME; x++) {
          if (img.data[(y * img.width + x) * 4 + 3] !== 0) return true;
        }
      }
      return false;
    };

    for (let d = 0; d < 8; d++) {
      for (let f = 0; f < c.count[d]; f++) {
        assert.ok(opaque(f, d), `${name} ${cull.dirs[d]} slot ${f}: kept frame is blank`);
      }
      for (let f = c.count[d]; f < FLY_FRAMES; f++) {
        assert.ok(!opaque(f, d), `${name} ${cull.dirs[d]} slot ${f}: padding has pixels`);
      }
    }
  }
});
