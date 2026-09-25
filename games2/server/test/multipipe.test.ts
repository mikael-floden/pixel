// THE WORLD'S PIPELINE ON A PHONE (client/src/multipipe.ts): the opt-in that
// turns Phaser's `autoMobilePipeline` off (`?multipipe=1`, its stored choice,
// the Settings→Dev press — applied at the next boot), the beacon's reading of
// the arm a window ran (1 texture a batch under forceZero, the units
// otherwise) and the Dev state line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { multiPipeOn, multiPipeStored, setMultiPipe, mainBatchUnits, multiPipeState } from "../../client/src/multipipe";

const store = new Map<string, string>();
const fake = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
};
const g = globalThis as unknown as { location: { search: string }; localStorage: unknown };
g.localStorage = fake;
g.location = { search: "" };

test("off by default (Phaser's own mobile pipeline): nothing asked, nothing stored", () => {
  store.clear();
  g.location.search = "";
  assert.equal(multiPipeOn(), false);
  assert.equal(multiPipeStored(), false);
});

test("?multipipe=1 turns it on and is remembered; ?multipipe=0 turns it back off", () => {
  store.clear();
  g.location.search = "?multipipe=1";
  assert.equal(multiPipeOn(), true);
  g.location.search = "";
  assert.equal(multiPipeOn(), true, "the stored choice holds without the query");
  g.location.search = "?multipipe=0";
  assert.equal(multiPipeOn(), false);
  g.location.search = "";
  assert.equal(multiPipeOn(), false);
});

test("a query that is not 0 or 1 changes nothing", () => {
  store.clear();
  store.set("ml-multi-pipe", "1");
  g.location.search = "?multipipe=yes";
  assert.equal(multiPipeOn(), true);
});

test("the Dev press flips the STORED choice, whatever the page was loaded with", () => {
  store.clear();
  g.location.search = "?multipipe=1";
  assert.equal(multiPipeOn(), true); // the boot consumed the query
  setMultiPipe(!multiPipeStored());
  assert.equal(multiPipeStored(), false, "one press turns it off");
  setMultiPipe(!multiPipeStored());
  assert.equal(multiPipeStored(), true, "the next turns it on again — the query never re-applies");
  g.location.search = "";
});

test("storage that throws (a locked-down webview) reads as off and a press is a no-op", () => {
  g.localStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  g.location.search = "?multipipe=1";
  assert.equal(multiPipeOn(), false);
  assert.equal(multiPipeStored(), false);
  assert.doesNotThrow(() => setMultiPipe(true));
  g.localStorage = fake;
  g.location.search = "";
});

test("units a batch holds: 1 under forceZero, the renderer's units otherwise, 0 without a pipeline", () => {
  assert.equal(mainBatchUnits({ maxTextures: 16, pipelines: { default: { forceZero: true } } }), 1);
  assert.equal(mainBatchUnits({ maxTextures: 16, pipelines: { default: { forceZero: false } } }), 16);
  assert.equal(mainBatchUnits({ maxTextures: 8, pipelines: { default: {} } }), 8);
  assert.equal(mainBatchUnits({ pipelines: { default: null } }), 0);
  assert.equal(mainBatchUnits({}), 0); // a Canvas renderer has no pipelines
  assert.equal(mainBatchUnits(null), 0);
});

test("the Dev state: the running arm, what a reload brings, and a desktop that never changes", () => {
  store.clear();
  assert.equal(multiPipeState(false, true), "off");
  setMultiPipe(true);
  assert.equal(multiPipeState(false, true), "off, on after reload");
  assert.equal(multiPipeState(true, true), "on");
  setMultiPipe(false);
  assert.equal(multiPipeState(true, true), "on, off after reload");
  assert.equal(multiPipeState(true, false), "on (desktop: always)");
});
