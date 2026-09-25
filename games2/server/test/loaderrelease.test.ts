// A LOADED IMAGE LETS GO OF ITS LOADER (client/src/loaderrelease.ts): at the
// loader's file-complete event an image's onload/onerror are cleared — the
// closure that kept Phaser's File, its XMLHttpRequest and the response Blob
// alive for as long as the texture — and nothing else is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseLoadedImage, releaseImagesOnComplete } from "../../client/src/loaderrelease";

class FakeImage {
  onload: (() => void) | null = () => {};
  onerror: (() => void) | null = () => {};
  src = "blob:x";
}
(globalThis as unknown as { HTMLImageElement: unknown }).HTMLImageElement = FakeImage;

test("an image's handlers are cleared, and the image is otherwise as it was", () => {
  const img = new FakeImage();
  assert.equal(releaseLoadedImage(img), true);
  assert.equal(img.onload, null);
  assert.equal(img.onerror, null);
  assert.equal(img.src, "blob:x");
});

test("anything that is not an image (a JSON file's data, nothing) is left alone", () => {
  const json = { onload: 1, rows: [] };
  assert.equal(releaseLoadedImage(json), false);
  assert.equal(json.onload, 1);
  assert.equal(releaseLoadedImage(undefined), false);
  assert.equal(releaseLoadedImage(null), false);
});

test("the hook fires on the loader's own complete event with Phaser's (key, type, data)", () => {
  const handlers = new Map<string, (key: string, type: string, data: unknown) => void>();
  const loader = { on: (ev: string, fn: (key: string, type: string, data: unknown) => void) => handlers.set(ev, fn) };
  releaseImagesOnComplete(loader, "filecomplete");
  const img = new FakeImage();
  handlers.get("filecomplete")!("t2:grass", "image", img);
  assert.equal(img.onload, null);
  assert.deepEqual([...handlers.keys()], ["filecomplete"]);
});
