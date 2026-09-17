// THE GRAB FRAME — when the loot leaves the ground.
//
// The maintainer's rule, twice: the item must vanish "the exact frame the hand
// is closest to the ground" (2026-08-06), and it did not — "the item is picked
// up the first 'pick up frame' and not the frame the players character actually
// touches the ground" (2026-09-17). The cause was not the runtime, which defers
// correctly, but the DATA: build-manifest measured the frame by watching the
// little item the art draws on the ground vanish, and the art draws a detached
// one on the north diagonals alone. Five facings had no frame at all and
// default_girl had none for any facing, so grabFrameFor returned null and
// removeDrop destroyed the sprite the moment the server validated the pickup —
// the snap he saw, every time he faced the camera.
//
// Two things are pinned here. That every facing HAS a frame (the fault itself,
// and this fails on the old rule: default_girl shipped an empty grab block).
// And that the crouch rule, which now supplies the other five, AGREES with the
// drawn item wherever the drawn item can be read — the only evidence that the
// substitute measures the same moment rather than a plausible-looking one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain ESM with no declaration, as characterscale.test.ts imports it
import { imgAlpha, findImg } from "../../scripts/imagelib.mjs";

const GAME_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(GAME_ROOT, "..");

type Grab = { f: number; x?: number; y?: number; approx?: boolean; from?: string };
type Char = {
  uid: string;
  root?: string;
  animSrc?: Record<string, string>;
  animations?: Record<string, Record<string, number>>;
  grab?: Record<string, Grab>;
};
const manifest = JSON.parse(
  readFileSync(join(GAME_ROOT, "client", "public", "characters.json"), "utf8"),
) as { directions: string[]; characters: Char[] };

test("every playable facing knows when the hand closes — the fault was the missing five", () => {
  assert.ok(manifest.characters.length > 0, "no characters in the manifest");
  for (const c of manifest.characters) {
    const frames = c.animations?.pickup;
    if (!frames) continue; // a character with no pickup clip has nothing to time
    assert.ok(c.grab, `${c.uid} ships no grab block at all — the runtime cannot defer for any facing`);
    for (const d of manifest.directions) {
      const g = c.grab![d];
      assert.ok(g, `${c.uid} ${d}: no grab frame, so removeDrop destroys the item on the spot`);
      assert.ok(Number.isInteger(g.f) && g.f > 0, `${c.uid} ${d}: f is ${g.f}`);
      assert.ok(
        g.f < (frames[d] ?? 0),
        `${c.uid} ${d}: f ${g.f} is not inside the ${frames[d]}-frame clip — the clip would end first`,
      );
      // WHEN and WHERE are different questions, and only the art answers WHERE.
      // A crouch-derived entry must carry no offset, or grabStandSpot would
      // steer the walk by a number nothing measured.
      const hasOffset = typeof g.x === "number" && typeof g.y === "number";
      if (g.from === "crouch") assert.ok(!hasOffset, `${c.uid} ${d}: a crouch frame must not carry an offset`);
      else assert.ok(hasOffset, `${c.uid} ${d}: neither a measured offset nor a crouch frame — where did f come from?`);
    }
  }
});

/** The topmost opaque row — the crown of the head. The twin of build-manifest's
 *  own `crownRow`; a copy on purpose, so the gate re-derives the answer instead
 *  of asking the thing it is checking. */
function crown(p: string): number {
  const a = imgAlpha(p) as { w: number; h: number; opaque: (x: number, y: number) => boolean } | null;
  if (!a) return -1;
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) if (a.opaque(x, y)) return y;
  return -1;
}

test("the crouch agrees with the drawn item on every facing the art can be read", () => {
  let checked = 0;
  for (const c of manifest.characters) {
    const src = c.animSrc?.pickup;
    const frames = c.animations?.pickup;
    const root = c.root?.replace(/^\/assets\//, "");
    if (!src || !frames || !root || !c.grab) continue;
    for (const [d, g] of Object.entries(c.grab)) {
      // Only the ART-measured entries: an interpolated axis view (approx) is an
      // average of its neighbours, not an independent reading, and a crouch
      // entry is the very thing under test.
      if (g.from === "crouch" || g.approx || typeof g.x !== "number") continue;
      const dir = join(REPO, root, "animations", src, d);
      if (!existsSync(dir)) continue; // art not checked out (the deploy's sparse tree)
      let deep = -1;
      let deepY = -1;
      for (let i = 0; i < (frames[d] ?? 0); i++) {
        const p = findImg(dir, String(i)) as string | null;
        if (!p) continue;
        const y = crown(p);
        // FIRST of a tie: the gesture holds its lowest pose across two frames
        // and the art vanishes the item on the SECOND, so the run's first frame
        // plus one is the answer — taking the last would be one frame late.
        if (y > deepY) {
          deepY = y;
          deep = i;
        }
      }
      if (deep < 0) continue;
      assert.equal(
        deep + 1,
        g.f,
        `${c.uid} ${d}: the crouch bottoms at frame ${deep} (so f ${deep + 1}) but the drawn item vanishes at ${g.f} — ` +
          `the two measurements have drifted apart, and the five facings that rely on the crouch alone are now guesses`,
      );
      checked++;
    }
  }
  if (!checked) return test.skip("no art-measured facing to cross-check (characters2 not checked out)");
  assert.ok(checked >= 2, `only ${checked} facing(s) cross-checked — the art used to offer two`);
});
