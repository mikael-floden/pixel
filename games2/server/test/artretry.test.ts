// ============================================================================
// A FAILED ART LOAD IS RETRIED, NOT TOMBSTONED FOR THE LIFE OF THE PAGE
// ============================================================================
//
// 2026-09-21, the maintainer's evening: the hearth house drew as a flat brown
// slab while every rock, cart and blade of grass beside it was perfect; both
// hero portraits vanished from the character-select screen while the logo and
// the UI icons stayed; the world map would not open; then "Nangijala could not
// start". Every single report ended the same way — "I restarted the game and
// now it works again" — and the break came back on the next reconnect.
//
// None of it was damage. world.json and all fourteen art files the house is
// built from were md5-identical between the repo and production, both
// portraits served 200 and decoded, and both of his coordinates rendered
// correctly in the harness at his own device geometry on a production build.
//
// It was THIS: `Tiles3Loader.need()` puts a path in `asked` and never takes it
// out. Phaser reports a 404 and a dropped connection through the same
// FILE_LOAD_ERROR, the loader counts an errored file DONE (the loading bar must
// not stall on a 404), and the path stays in `asked` — so it is never asked for
// again until the page is reloaded. A reload clears `asked`, which is exactly
// and only why restarting fixed it.
//
// And requests really were being dropped: production measured 56-70% CPU with
// ZERO clients connected and event-loop stalls to 1.9 s against a 50 ms tick
// budget, and refused our own publish pipeline with HTTP 429.
//
// THE ARMS, each red on the old rule:
//   1. a failed path is re-requested after its backoff
//   2. ...and not before it (a busy server is not helped by a tight loop)
//   3. a path that keeps failing gives up, so a real 404 still tombstones
//   4. a path that succeeds on the retry is forgotten (no permanent bookkeeping)
//   5. a SUCCESSFUL load is never retried, and `ok` absent still means arrived
import { test } from "node:test";
import assert from "node:assert/strict";
import { Tiles3Loader, type LoaderLike } from "../../client/src/tiles3runtime.js";
import { artKey, type TextureManagerLike } from "../../client/src/tiles3draw.js";

/** A Phaser loader stand-in: records what was asked for and lets the test
 *  decide, per path, whether it lands or fails. */
function fakeLoader() {
  const asked: string[] = [];
  const clock = { t: 0 };
  const resident = new Set<string>();
  let onFile: ((key: string, ok?: boolean) => void) | null = null;
  let onComplete: (() => void) | null = null;
  let batch: string[] = [];

  const loader: LoaderLike = {
    image(key: string) {
      asked.push(key);
      batch.push(key);
      return null;
    },
    isLoading: () => false,
    start: () => {},
    once(event: string, cb: () => void) {
      if (event === "complete") onComplete = cb;
      return null;
    },
    onFile(cb: (key: string, ok?: boolean) => void) {
      onFile = cb;
      return null;
    },
  };

  return {
    loader,
    asked,
    clock,
    /* Only `exists` is ever reached from the loader; the rest satisfies the
     * interface and throws loudly if this test ever grows into them. */
    textures: {
      exists: (k: string) => resident.has(k),
      get: () => undefined,
      addCanvas: () => null,
      remove: () => {},
    } as unknown as TextureManagerLike,
    /** Finish the batch in flight: `fail` names the keys that error. */
    settle(fail: Set<string> = new Set()) {
      const done = batch;
      batch = [];
      for (const key of done) {
        if (fail.has(key)) onFile?.(key, false);
        else {
          resident.add(key);
          onFile?.(key, true);
        }
      }
      onComplete?.();
      onComplete = null;
    },
    /** Finish the batch the way a loader that reports no outcome would. */
    settleSilently() {
      const done = batch;
      batch = [];
      for (const key of done) {
        resident.add(key);
        onFile?.(key);
      }
      onComplete?.();
      onComplete = null;
    },
  };
}

const PATH = "tiles/review/brown_paving_stone__over__light_beach/5_textured.1389c867.webp";

function loaderOn(f: ReturnType<typeof fakeLoader>) {
  return new Tiles3Loader({ loader: f.loader, textures: f.textures, onBatch: () => {}, now: () => f.clock.t });
}

test("a failed art load is asked for again once its backoff has elapsed", () => {
  const f = fakeLoader();
  const load = loaderOn(f);

  load.need(PATH);
  load.flush();
  assert.equal(f.asked.length, 1, "asked for once");
  f.settle(new Set([artKey(PATH)])); // the request is dropped

  // THE OLD RULE: the path sits in `asked` forever and this stays 1.
  load.need(PATH); // a later pass over the same cell must not be what saves it
  load.flush();
  assert.equal(f.asked.length, 1, "need() alone does not re-ask — the tombstone is still there");

  // RED ON THE OLD RULE, and it needs none of the new API to be: before this
  // change a failed path was indistinguishable from a resident one — inflight
  // cleared, queue empty — so the loader said the file was NOT coming, and
  // nothing ever asked again. It is owed a retry now, and it says so.
  assert.equal(load.wanted(PATH), true, "a failed file is still coming — a retry is owed");

  load.retryFailed(10_000); // well past the backoff
  load.flush();
  assert.equal(f.asked.length, 2, "the retry re-requests it");
  assert.equal(f.asked[1], artKey(PATH));
});

test("the retry waits out its backoff — a busy server is not helped by a tight loop", () => {
  const f = fakeLoader();
  const load = loaderOn(f);

  load.need(PATH);
  load.flush();
  f.settle(new Set([artKey(PATH)]));

  load.retryFailed(1); // ~immediately after the failure
  load.flush();
  assert.equal(f.asked.length, 1, "not re-asked inside the backoff");

  load.retryFailed(5_000);
  load.flush();
  assert.equal(f.asked.length, 2, "re-asked once the backoff has passed");
});

test("a path that keeps failing gives up, so a real 404 still tombstones", () => {
  const f = fakeLoader();
  const load = loaderOn(f);

  load.need(PATH);
  load.flush();
  f.settle(new Set([artKey(PATH)]));

  // Drive far past every backoff, failing every time.
  for (let i = 0; i < 12; i++) {
    f.clock.t += 60_000;
    load.retryFailed(f.clock.t);
    load.flush();
    f.settle(new Set([artKey(PATH)]));
  }

  const spent = f.asked.length;
  f.clock.t += 60_000;
  load.retryFailed(f.clock.t);
  load.flush();
  assert.equal(f.asked.length, spent, "it has given up");
  assert.ok(spent <= 6, `bounded: ${spent} requests in total, not an endless loop`);
  assert.equal(load.wanted(PATH), false, "and it no longer claims the file is coming");
});

test("a path that succeeds on the retry is forgotten", () => {
  const f = fakeLoader();
  const load = loaderOn(f);

  load.need(PATH);
  load.flush();
  f.settle(new Set([artKey(PATH)]));
  assert.equal(load.failedCount, 1);

  load.retryFailed(10_000);
  load.flush();
  f.settle(); // this time it lands

  assert.equal(load.failedCount, 0, "no permanent bookkeeping for a file that arrived");
  assert.equal(load.stats.recovered, 1, "and the recovery is counted");

  load.retryFailed(999_999);
  load.flush();
  assert.equal(f.asked.length, 2, "nothing is re-requested once it is resident");
});

test("a successful load is never retried, and a loader that reports no outcome still means arrived", () => {
  const f = fakeLoader();
  const load = loaderOn(f);

  load.need(PATH);
  load.flush();
  f.settleSilently(); // the pre-`ok` contract: one argument, always

  assert.equal(load.failedCount, 0, "silence is not failure");
  load.retryFailed(999_999);
  load.flush();
  assert.equal(f.asked.length, 1, "nothing to retry");
});
