// Pure combat math — the numbers both sides must agree on.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  xpToNext, hpMaxFor, epMaxFor, playerAtk, damageRoll, unarmedClip, idSalt,
  attackRange, slowFactorAt, rollDrops, SLOW_FACTOR, SLOW_MS, FLEE_SLOW_FACTOR,
  CHASE_SPEED_WU, RUN_SPEED, WALK_SPEED, mix32, provokedChaseSpeed,
  ESCAPE_RADIUS_WU, PROVOKE_RADIUS_WU, CELL_WU,
} from "@nangijala/shared";

test("progression curves are sane and monotonic", () => {
  assert.equal(hpMaxFor(1), 40);
  assert.equal(epMaxFor(1), 20);
  let prev = 0;
  for (let l = 1; l <= 99; l++) {
    const x = xpToNext(l);
    assert.ok(x > prev, `xpToNext grows at ${l}`);
    prev = x;
    assert.ok(hpMaxFor(l + 1) > hpMaxFor(l));
  }
  assert.equal(xpToNext(1), 50);
  assert.ok(playerAtk(10) > playerAtk(1));
});

test("damageRoll is deterministic, bounded, and never 0", () => {
  for (let i = 0; i < 500; i++) {
    const d = damageRoll(20, i, 42);
    assert.equal(d, damageRoll(20, i, 42), "same seeds, same roll");
    assert.ok(d >= 17 && d <= 23, `20 atk rolls 17..23, got ${d}`);
  }
  assert.equal(damageRoll(1, 3, 3) >= 1, true);
});

test("unarmedClip is deterministic and actually mixes kick and punch", () => {
  const salt = idSalt("player-abc");
  const seen = new Set<string>();
  for (let seq = 0; seq < 40; seq++) {
    const c = unarmedClip(seq, salt);
    assert.equal(c, unarmedClip(seq, salt));
    seen.add(c);
  }
  assert.deepEqual([...seen].sort(), ["kick", "punch"], "both moves appear over 40 swings");
});

test("the escape math holds for both chase kinds", () => {
  // UNPROVOKED (a predator noticed you): constant chase an innocent full run
  // always beats — but a hit-slowed runner does not.
  assert.ok(RUN_SPEED * SLOW_FACTOR < CHASE_SPEED_WU, "cannot outrun a predator while hit-slowed");
  assert.ok(CHASE_SPEED_WU < RUN_SPEED, "an innocent full run escapes a predator");
  // PROVOKED (you started it): the hunter paces its victim — ALWAYS slightly
  // faster at every reachable player speed, walking, fleeing or standing.
  for (let v = 0; v <= RUN_SPEED; v += 5) {
    assert.ok(provokedChaseSpeed(v) > v, `provoked hunter outpaces victim at ${v} wu/s`);
  }
  const fleeing = RUN_SPEED * FLEE_SLOW_FACTOR; // the fastest a hunted player can go
  assert.ok(provokedChaseSpeed(fleeing) > fleeing, "fleeing at full flee speed never opens the gap");
  assert.ok(provokedChaseSpeed(0) >= 55, "closes on a standing victim");
  // The escape line is the way out: ~0.75 of a screen (camera frames ~520wu),
  // halved from 1.5 screens because hunts ran too long (maintainer 2026-08-06).
  assert.ok(ESCAPE_RADIUS_WU > 300 && ESCAPE_RADIUS_WU < 470, "escape radius ≈ 0.75 × 520wu screen");
  // …but still comfortably beyond the provocation range, or a marked monster
  // would aggro and give up in the same breath instead of committing to a hunt.
  assert.ok(ESCAPE_RADIUS_WU > 2.5 * PROVOKE_RADIUS_WU, "escape line is well outside the provoke radius");
  assert.ok(PROVOKE_RADIUS_WU >= 3 * CELL_WU && PROVOKE_RADIUS_WU <= 6 * CELL_WU, "provoke radius is a few cells");
  assert.ok(FLEE_SLOW_FACTOR > SLOW_FACTOR && FLEE_SLOW_FACTOR < 1, "flee slow is milder than the hit stagger");
  assert.ok(WALK_SPEED * FLEE_SLOW_FACTOR > 0, "hunted walking still moves");
});

test("slowFactorAt applies inside the window and expires after", () => {
  assert.equal(slowFactorAt(1000, 1000 + SLOW_MS - 1), SLOW_FACTOR);
  assert.equal(slowFactorAt(1000, 1000 + SLOW_MS), 1);
});

test("attackRange is radius-aware", () => {
  assert.ok(attackRange(9, 57) > attackRange(9, 13), "a mammoth is hit from farther than a poring");
});

test("rollDrops: chance 1 always drops, chance 0 never, deterministic", () => {
  const loot = [{ item: "gold_coin", chance: 1 }, { item: "gem_ruby", chance: 0 }];
  for (let s = 0; s < 50; s++) {
    const d = rollDrops(loot, s, 7);
    assert.deepEqual(d, ["gold_coin"]);
  }
  assert.deepEqual(rollDrops(undefined, 1, 2), []);
  // ~30% chance lands in a plausible band over many rolls
  let n = 0;
  for (let s = 0; s < 2000; s++) n += rollDrops([{ item: "x", chance: 0.3 }], s, 99).length;
  assert.ok(n > 450 && n < 750, `30% of 2000 ≈ 600, got ${n}`);
});

test("mix32 spreads bits (no obvious parity bias)", () => {
  let ones = 0;
  for (let i = 0; i < 4000; i++) ones += mix32(i, 12345) & 1;
  assert.ok(ones > 1800 && ones < 2200, `parity ~50%, got ${ones}/4000`);
});
