/* THE RECONNECT HANG (maintainer 2026-09-04, third report: "I'm also stuck in
 * 'Reconnecting...' when I tabbed back in again").
 *
 * joinOrCreate reserves a seat over HTTP then opens a WebSocket; if either
 * stalls the promise NEVER SETTLES, and a promise that never settles cannot be
 * caught — so WorldScene.handleDrop's catch, its backoff, its six retries and
 * the reload under them were all unreachable. A backgrounded phone leaving a
 * half-open socket is the ordinary way to get there. */
import test from "node:test";
import assert from "node:assert/strict";
import { withJoinTimeout } from "../../client/src/jointimeout";

test("a stalled join rejects instead of hanging forever", async () => {
  const never = new Promise<string>(() => {});
  await assert.rejects(() => withJoinTimeout(never, 20, () => {}), /timed out/);
});

test("a HEALTHY join is never left — the flag belongs to the timeout, not to success", async () => {
  /* The first cut set the flag after the race resolved, a full microtask too
   * late: `pending` settling queues BOTH the race's handler and the late-
   * arrival handler, and the latter could run first, so every good join was
   * immediately left. This is that regression, and it fails without the fix. */
  let left = 0;
  const ok = Promise.resolve("room");
  assert.equal(await withJoinTimeout(ok, 1000, () => left++), "room");
  await new Promise((r) => setTimeout(r, 5)); // let any stray handler run
  assert.equal(left, 0, "a successful join was disconnected by its own timeout guard");
});

test("a join that lands AFTER the deadline is left, never orphaned", async () => {
  let left: string | null = null;
  const slow = new Promise<string>((res) => setTimeout(() => res("late-room"), 40));
  await assert.rejects(() => withJoinTimeout(slow, 10, (v) => (left = v)), /timed out/);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(left, "late-room", "the abandoned connection was never closed");
});

test("timeoutMs 0 opts out entirely", async () => {
  assert.equal(await withJoinTimeout(Promise.resolve("x"), 0, () => {}), "x");
});
