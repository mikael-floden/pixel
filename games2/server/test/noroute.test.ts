// ============================================================================
// A MONSTER THE MAP HAS BOXED IN GOES DORMANT — THE SERVER DOES NOT SUFFER
// ============================================================================
//
// Maintainer, 2026-09-22, on monsters stranded by bad spawn data: "why can't
// you detect this and place the monster in a 'forever idle' state? Yes this is
// a map-issue, but the server should not suffer if this ever happens."
//
// He is right, and it had already cost him. Monsters spawned onto unwalkable
// islands in the_game were the per-room tick spikes measured on production on
// 2026-09-21: 554 ms against a 50 ms budget, WITH NOBODY CONNECTED. maps2
// removed the islands in 7b11fa4b0a and the worst room tick fell to 21 ms —
// but that fixed the data, not the server. Spawn placement is authored, so it
// will be wrong again.
//
// WHY A FAILED PLAN IS THE EXPENSIVE ONE. A* answers "no route" only after it
// has expanded its ENTIRE budget — MONSTER_ROAM_MAX_NODES, 300 nodes. A plan
// that succeeds usually stops early. So the boxed-in monster does not do less
// work than a roaming one; it does the most work possible, and then throws it
// away. The old rule paused for one ordinary roam pause
// (MONSTER_ROAM_PAUSE_MS 800-2600) and asked again, for the life of the
// process, under a comment that called the case "rare".
//
// THE ARMS:
//   1. the first few failures still take an ordinary pause (one unlucky target
//      must not put a healthy monster to sleep)
//   2. a monster that keeps failing backs off to a minute and STAYS there
//   3. the rate collapses — this is the arm that is red on the old rule, and
//      it is stated as searches per minute, which is the thing that hurt him
//   4. it is never permanently asleep: it re-probes, so a map fix wakes it
//      with nobody doing anything
import { test } from "node:test";
import assert from "node:assert/strict";
import { noRouteRetryMs } from "../src/rooms/WorldRoom.js";
import { MONSTER_ROAM_PAUSE_MS_MIN, MONSTER_ROAM_PAUSE_MS_MAX } from "@nangijala/shared";

/** The old rule, kept here as the thing being beaten: one ordinary roam pause,
 *  forever, however many times it has failed. */
const OLD_RULE = (_streak: number, roamPauseMs: number) => Math.floor(roamPauseMs);

/** Failed searches in `ms` of being stuck, under a retry policy. Worst case:
 *  the shortest legal roam pause, which is what a busy RNG keeps handing out. */
function searchesIn(ms: number, policy: (streak: number, pause: number) => number): number {
  let t = 0;
  let streak = 0;
  while (t < ms) {
    streak++;
    t += policy(streak, MONSTER_ROAM_PAUSE_MS_MIN);
  }
  return streak;
}

test("one unlucky target does not put a healthy monster to sleep", () => {
  for (let streak = 1; streak <= 3; streak++) {
    const wait = noRouteRetryMs(streak, 1700);
    assert.equal(wait, 1700, `failure ${streak} still takes the ordinary roam pause`);
    assert.ok(
      wait <= MONSTER_ROAM_PAUSE_MS_MAX,
      "a monster that simply picked a boxed-in cell keeps roaming normally",
    );
  }
});

test("a monster that keeps failing backs off to a minute and stays there", () => {
  assert.equal(noRouteRetryMs(4, 1700), 5_000);
  assert.equal(noRouteRetryMs(5, 1700), 10_000);
  assert.equal(noRouteRetryMs(15, 1700), 60_000);
  // ...and it is a CEILING, not a ramp that runs away.
  assert.equal(noRouteRetryMs(1_000, 1700), 60_000);
  assert.equal(noRouteRetryMs(1_000_000, 1700), 60_000);
});

test("the cost of a boxed-in monster collapses — RED ON THE OLD RULE", () => {
  const MINUTE = 60_000;
  const oldOneMin = searchesIn(MINUTE, OLD_RULE);
  const newOneMin = searchesIn(MINUTE, noRouteRetryMs);
  assert.ok(oldOneMin >= 70, `the old rule burned ${oldOneMin} failed searches a minute`);
  assert.ok(newOneMin <= 10, `now ${newOneMin} a minute`);

  // An hour of being stuck, which is what "for the life of the process" means.
  const oldHour = searchesIn(60 * MINUTE, OLD_RULE);
  const newHour = searchesIn(60 * MINUTE, noRouteRetryMs);
  assert.ok(
    newHour * 40 < oldHour,
    `an hour stuck: ${oldHour} failed searches before, ${newHour} now — at least 40x cheaper`,
  );

  // And it must hold for a WORLD of stuck monsters, not one. 300 nodes is the
  // A* budget every one of these spends in full before failing.
  const STUCK = 30;
  const NODES = 300;
  const before = (oldHour * STUCK * NODES) / 3600;
  const after = (newHour * STUCK * NODES) / 3600;
  assert.ok(before > 1_000, `${Math.round(before)} wasted A* nodes per second across ${STUCK} monsters`);
  assert.ok(after < 200, `down to ${Math.round(after)} per second`);
});

test("dormant is not asleep — it re-probes, so a map fix wakes it by itself", () => {
  // The ceiling is what makes this true: however long it has been stuck, it
  // still asks again within a minute, so maps2 shipping a fix (or a door
  // opening) brings the monster back with nobody doing anything.
  for (const streak of [4, 10, 100, 10_000]) {
    assert.ok(
      noRouteRetryMs(streak, 1700) <= 60_000,
      `still probing at streak ${streak} — never a permanent sleep that would need a deploy to undo`,
    );
  }
  // A pause is always positive: a zero would be a tight loop, which is the
  // bug this exists to prevent, not a faster recovery.
  for (const streak of [1, 2, 3, 4, 5, 50]) {
    assert.ok(noRouteRetryMs(streak, MONSTER_ROAM_PAUSE_MS_MIN) > 0, `streak ${streak} waits`);
  }
});
