// THE TUNED-SHADOW CONTRACT, SIM SIDE — the gate games2 did not have.
// The wiki's shadow editor writes ONE shadow per monster into the monster's
// own entry in live/tuning/monsters.json; its CENTRE is the monster's position
// and its SIZE is the hit box. Until this file the whole contract was pinned
// only by wiki/tools/check-shadow.mjs — another agent's domain, needs a
// browser, and never runs in `npm test` — so a refactor of shared/src/index.ts
// could keep every other test green while silently unanchoring, resizing or
// NaN-ing every tuned monster. These are pure/unit: no browser, no room.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readMonsterShadow,
  shadowAnchorOf,
  shadowScreenEllipse,
  shadowBodyRadius,
  SHADOW_BODY_R_MIN,
  SHADOW_BODY_R_MAX,
  DIRECTIONS,
  ISO_DX,
  ISO_DY,
} from "@nangijala/shared";

// The shadow functions are pinned to the pitch the hit boxes were TUNED at, so the
// test must reason in that frame too - using the live pitch here is what made this
// file demand new numbers when ISO_DY moved.
const K = 15 / 32;

// --- readMonsterShadow: junk in, null out (never a crash, never a NaN) ------

test("readMonsterShadow accepts a v1 record (base ax/ay) and a v2 record (offsets)", () => {
  const v1 = readMonsterShadow({ shadow: { rx: 20, ry: 9, ax: -2, ay: 11 } });
  assert.deepEqual(v1, { rx: 20, ry: 9, ax: -2, ay: 11 });
  const v2 = readMonsterShadow({
    shadow: { rx: 25.5, ry: 14.5, offsets: { "idle#south": { ax: 1.5, ay: -3.25 } } },
  });
  assert.deepEqual(v2, { rx: 25.5, ry: 14.5, offsets: { "idle#south": { ax: 1.5, ay: -3.25 } } });
});

test("readMonsterShadow rejects junk: every malformed record resolves to null", () => {
  const junk: Array<[string, unknown]> = [
    ["no entry", undefined],
    ["null entry", null],
    ["entry is a string", "shadow"],
    ["entry is a number", 7],
    ["no shadow field", { max_hp: 20 }],
    ["shadow null", { shadow: null }],
    ["shadow is a string", { shadow: "20x9" }],
    ["shadow is a bool", { shadow: true }],
    ["shadow is an array", { shadow: [20, 9] }],
    ["rx missing", { shadow: { ry: 9 } }],
    ["ry missing", { shadow: { rx: 20 } }],
    ["rx is a numeric string", { shadow: { rx: "20", ry: 9 } }],
    ["rx null", { shadow: { rx: null, ry: 9 } }],
    ["rx NaN", { shadow: { rx: NaN, ry: 9 } }],
    ["ry Infinity", { shadow: { rx: 20, ry: Infinity } }],
    ["rx zero", { shadow: { rx: 0, ry: 9 } }],
    ["ry negative", { shadow: { rx: 20, ry: -9 } }],
  ];
  for (const [why, doc] of junk) assert.equal(readMonsterShadow(doc), null, why);
});

test("readMonsterShadow drops half-written offsets but keeps the record", () => {
  // The editor writes ax and ay together; a truncated commit must not put an
  // undefined into the origin maths — the facet falls back down the chain.
  const rec = readMonsterShadow({
    shadow: {
      rx: 16,
      ry: 8,
      offsets: {
        "idle#south": { ax: 1, ay: 2 },
        "walk#south": { ax: 3 }, // no ay
        "walk#north": { ay: 4 }, // no ax
        "attack#east": { ax: "3", ay: 4 }, // stringly typed
        "die#west": { ax: NaN, ay: 0 },
        "angry#north": null,
      },
    },
  });
  assert.deepEqual(rec, { rx: 16, ry: 8, offsets: { "idle#south": { ax: 1, ay: 2 } } });
  // ... and an offsets block with nothing salvageable leaves no key at all.
  const bare = readMonsterShadow({ shadow: { rx: 16, ry: 8, offsets: { "walk#south": { ax: 3 } } } });
  assert.deepEqual(bare, { rx: 16, ry: 8 });
  assert.equal(readMonsterShadow({ shadow: { rx: 16, ry: 8, offsets: "nope" } })!.offsets, undefined);
  // A half-written BASE offset is dropped the same way (v1 needs both).
  assert.deepEqual(readMonsterShadow({ shadow: { rx: 16, ry: 8, ax: 3 } }), { rx: 16, ry: 8 });
});

// --- shadowAnchorOf: the inheritance chain --------------------------------

test("shadowAnchorOf: facet → idle#<dir> → base ax/ay → null", () => {
  const rec = {
    rx: 20,
    ry: 9,
    ax: -1,
    ay: 5,
    offsets: { "walk#south": { ax: 2, ay: 3 }, "idle#south": { ax: 4, ay: 6 } },
  };
  assert.deepEqual(shadowAnchorOf(rec, "walk", "south"), { ax: 2, ay: 3 }, "its own facet wins");
  assert.deepEqual(shadowAnchorOf(rec, "attack", "south"), { ax: 4, ay: 6 }, "then the direction's idle");
  assert.deepEqual(shadowAnchorOf(rec, "walk", "east"), { ax: -1, ay: 5 }, "then the v1 base offset");
  const v2 = { rx: 20, ry: 9, offsets: { "idle#south": { ax: 4, ay: 6 } } };
  assert.equal(shadowAnchorOf(v2, "walk", "east"), null, "no base → null = 'use your art default'");
  assert.equal(shadowAnchorOf({ rx: 20, ry: 9 }, "idle", "south"), null, "size-only record anchors nothing");
});

// --- shadowScreenEllipse: the rotation ------------------------------------

test("shadowScreenEllipse: south/north are the untouched tuned ellipse", () => {
  for (const dir of ["south", "north"]) {
    const e = shadowScreenEllipse(25.5, 14.5, dir);
    assert.ok(Math.abs(e.p - 25.5) < 1e-9, `${dir} p`);
    assert.ok(Math.abs(e.q - 14.5) < 1e-9, `${dir} q`);
    assert.ok(Math.abs(e.theta) < 1e-9, `${dir} is not tilted`);
  }
});

test("shadowScreenEllipse: east/west swap the ground axes, still untilted", () => {
  // Facing east the tuned DEPTH becomes the across axis: rx stays a screen
  // width, ry/K unsquashed then re-squashed by K is ry.
  for (const dir of ["east", "west"]) {
    const e = shadowScreenEllipse(25.5, 14.5, dir);
    assert.ok(Math.abs(e.p - 14.5 / K) < 1e-9, `${dir} across = ry/K`);
    assert.ok(Math.abs(e.q - 25.5 * K) < 1e-9, `${dir} depth = rx·K`);
    assert.ok(Math.abs(e.theta) < 1e-9, `${dir} is not tilted`);
  }
});

test("shadowScreenEllipse: the diagonals MIRROR — the bug of 2026-08-20", () => {
  // "The shadow is rotating wrong so its perpendicular to the body, but
  // correct S, E, N, W" — only the diagonals can show the sign, so only a
  // sign-anchored assertion can catch it coming back. A south-east body's
  // long axis must point DOWN-RIGHT on a y-down screen: theta > 0.
  const se = shadowScreenEllipse(25.5, 14.5, "south-east");
  const nw = shadowScreenEllipse(25.5, 14.5, "north-west");
  const ne = shadowScreenEllipse(25.5, 14.5, "north-east");
  const sw = shadowScreenEllipse(25.5, 14.5, "south-west");
  assert.ok(se.theta > 1e-3, `south-east tilts down-right (got ${se.theta})`);
  assert.ok(ne.theta < -1e-3, `north-east tilts up-right (got ${ne.theta})`);
  assert.ok(Math.abs(se.theta - nw.theta) < 1e-9, "south-east and north-west are the same tilt");
  assert.ok(Math.abs(ne.theta - sw.theta) < 1e-9, "north-east and south-west are the same tilt");
  assert.ok(Math.abs(se.theta + ne.theta) < 1e-9, "the two diagonal pairs are exact mirrors");
});

test("shadowScreenEllipse: every direction keeps the ellipse's area and p ≥ q", () => {
  // The ground semi-axes are always {rx, ry/K}; only their screen orientation
  // turns. So the drawn area p·q must stay rx·ry in all 8 facings — the
  // cheapest whole-family check that a rewrite has not resized anything.
  for (const [rx, ry] of [
    [25.5, 14.5],
    [10, 30],
    [3, 3],
    [16.25, 7.75],
  ]) {
    for (const dir of DIRECTIONS) {
      const e = shadowScreenEllipse(rx, ry, dir);
      assert.ok(Math.abs(e.p * e.q - rx * ry) < 1e-6, `${rx}x${ry} ${dir} area`);
      assert.ok(e.p >= e.q - 1e-12, `${rx}x${ry} ${dir}: p is the MAJOR radius`);
      assert.ok(isFinite(e.theta), `${rx}x${ry} ${dir} theta is finite`);
    }
  }
  const unknown = shadowScreenEllipse(25.5, 14.5, "sideways");
  assert.deepEqual(unknown, shadowScreenEllipse(25.5, 14.5, "south"), "an unknown facing reads as south");
});

// --- shadowBodyRadius: the honest ellipse → circle reduction ---------------

test("shadowBodyRadius is the mean of the GROUND semi-axes", () => {
  assert.ok(Math.abs(shadowBodyRadius(25.5, 14.5) - (25.5 + 14.5 / K) / 2) < 1e-9);
  // BACK TO THE TUNED VALUES. These moved to 16.982/27.911 when ISO_DY went 15 -> 14,
  // and updating them here was the wrong response: the test was reporting that a
  // camera change had rescaled 57 hand-tuned hitboxes. shadowBodyRadius now pins K to
  // the pitch they were tuned at, so these are his numbers again and stay his if the
  // projection moves.
  assert.ok(Math.abs(shadowBodyRadius(16.25, 7.75) - 16.392) < 0.001, "forest_poring ≈ its art radius 17");
  assert.ok(Math.abs(shadowBodyRadius(27.25, 12.5) - 26.958) < 0.001, "diablo_2 ≈ its art radius 27");
});

test("shadowBodyRadius cannot change when the monster turns", () => {
  // "The size will be the monsters hit box" — one size, all 8 facings. The
  // mean of the PRINCIPAL semi-axes is rotation-invariant; the screen radii
  // are not, so this is what stops a monster growing a hit box by facing east.
  const r = shadowBodyRadius(10, 30);
  for (const dir of DIRECTIONS) {
    const e = shadowScreenEllipse(10, 30, dir);
    // p,q re-expressed on the ground are always {rx, ry/K} in some order.
    const ground = [e.p, e.q / K].sort((a, b) => a - b);
    const want = [10, 30 / K].sort((a, b) => a - b);
    const mean = (ground[0] + ground[1]) / 2;
    assert.ok(Math.abs(mean - r) < 1e-6 || Math.abs((want[0] + want[1]) / 2 - r) < 1e-9, `${dir}`);
  }
});

test("shadowBodyRadius clamps, and junk collapses to the floor instead of NaN", () => {
  assert.equal(shadowBodyRadius(1000, 1000), SHADOW_BODY_R_MAX);
  assert.equal(shadowBodyRadius(0.1, 0.1), SHADOW_BODY_R_MIN);
  for (const [rx, ry] of [
    [NaN, 9],
    [20, NaN],
    [Infinity, 9],
    [20, -Infinity],
  ]) {
    const r = shadowBodyRadius(rx, ry);
    assert.ok(isFinite(r) && r > 0, `shadowBodyRadius(${rx}, ${ry}) = ${r} must never reach the sim`);
    assert.equal(r, SHADOW_BODY_R_MIN, "junk makes a monster SMALL, never map-sized");
  }
});

// --- the resolver the sim actually calls -----------------------------------

// monsterShadowFor/monsterRadiusFor read the live channel first and the
// image-baked live/tuning/monsters.json second. No live fetch runs in a test,
// so pointing ASSETS_ROOT at a fixture exercises the baked layer — the same
// code path a room created before initLive resolves takes in production.
const FIX = mkdtempSync(join(tmpdir(), "shadowtune-"));
mkdirSync(join(FIX, "live", "tuning"), { recursive: true });
writeFileSync(
  join(FIX, "live", "tuning", "monsters.json"),
  JSON.stringify({
    format: "pixel-wiki-tuning-monsters@1",
    updated_at: "2026-08-21T00:00:00Z",
    defaults: { max_hp: 20 },
    monsters: {
      tuned_v2: { max_hp: 30, shadow: { rx: 25.5, ry: 14.5, offsets: { "idle#south": { ax: 0, ay: 12 } } } },
      tuned_v1: { shadow: { rx: 13.75, ry: 6, ax: 0, ay: 20 } },
      untuned: { max_hp: 40 },
      junk_shadow: { max_hp: 40, shadow: { rx: "25", ry: null } },
      empty_shadow: { max_hp: 40, shadow: {} },
    },
  }),
);
process.env.ASSETS_ROOT = FIX;
let tuning: typeof import("../src/tuning.js");
before(async () => {
  tuning = await import("../src/tuning.js");
});

test("monsterRadiusFor: a kind WITH a tuned shadow fights at the shadow's size", () => {
  assert.equal(tuning.monsterRadiusFor("tuned_v2", 23, 13), shadowBodyRadius(25.5, 14.5));
  assert.equal(tuning.monsterRadiusFor("tuned_v1", 10, 13), shadowBodyRadius(13.75, 6));
  // The manifest radius is IGNORED when a record exists — that is the whole
  // point ("the size will be the monsters hit box"), and it is where the
  // measured melee-reach drift comes from: +10.9% for crystal_horn.
  assert.notEqual(tuning.monsterRadiusFor("tuned_v2", 23, 13), 23);
});

test("monsterRadiusFor: a kind WITHOUT one falls back to the art-measured radius", () => {
  assert.equal(tuning.monsterRadiusFor("untuned", 27, 13), 27, "the manifest radius");
  assert.equal(tuning.monsterRadiusFor("not_in_the_doc_at_all", 31, 13), 31, "an unlisted kind too");
  assert.equal(tuning.monsterRadiusFor("untuned", undefined, 13), 13, "no manifest entry → the default");
});

test("monsterRadiusFor: a malformed shadow cannot crash the sim or produce NaN", () => {
  for (const kind of ["junk_shadow", "empty_shadow"]) {
    assert.equal(tuning.monsterShadowFor(kind), null, `${kind} is rejected outright`);
    const r = tuning.monsterRadiusFor(kind, 27, 13);
    assert.equal(r, 27, `${kind} degrades to the art radius, silently and safely`);
    assert.ok(isFinite(r));
  }
  assert.equal(tuning.monsterRadiusFor("untuned", NaN, 13), 13, "a NaN manifest radius takes the default");
});

test("monsterShadowFor is memoised without going stale or mutating", () => {
  const a = tuning.monsterShadowFor("tuned_v2");
  const b = tuning.monsterShadowFor("tuned_v2");
  assert.deepEqual(a, b);
  assert.equal(tuning.monsterShadowFor("untuned"), null, "a null result is cached as null, not re-resolved");
  assert.equal(tuning.monsterRadiusFor("tuned_v2", 23, 13), shadowBodyRadius(25.5, 14.5), "stable across calls");
});

// --- the SHIPPED document: what the wiki has actually written ---------------

test("every shadow the Game Master has published is one the game will honour", () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const p = join(repo, "live", "tuning", "monsters.json");
  if (!existsSync(p)) return; // image build without the live dir → nothing to check
  const doc = JSON.parse(readFileSync(p, "utf8")) as { monsters?: Record<string, Record<string, unknown>> };
  const dirs = new Set<string>(DIRECTIONS as unknown as string[]);
  let tuned = 0;
  for (const [kind, entry] of Object.entries(doc.monsters ?? {})) {
    if (!("shadow" in entry)) continue;
    tuned++;
    const rec = readMonsterShadow(entry);
    // A record the editor wrote but readMonsterShadow rejects is invisible:
    // the monster silently stays on its legacy art anchors and the maintainer
    // sees his tuning do nothing. That must fail loudly, here.
    assert.ok(rec, `${kind}: published shadow is unreadable — the game would ignore it`);
    const r = shadowBodyRadius(rec.rx, rec.ry);
    assert.ok(isFinite(r) && r >= SHADOW_BODY_R_MIN && r <= SHADOW_BODY_R_MAX, `${kind}: body radius ${r}`);
    for (const key of Object.keys(rec.offsets ?? {})) {
      const [state, dir] = key.split("#");
      assert.ok(state && dirs.has(dir), `${kind}: offset "${key}" is keyed to no direction the game asks for`);
    }
  }
  // NOT an assert: the wiki's two-stage Reset DELETES a record, so a Game
  // Master clearing his tunings is a legitimate state that must not turn the
  // suite red. The contract this file pins is "a tuned shadow wins where one
  // exists", which the other cases cover without needing one to exist.
  if (!tuned) console.warn("[monstershadow] no kind carries a tuned shadow (4 as of 2026-08-21)");
});

// --- the seam is not bypassed ----------------------------------------------

test("every sim consumer resolves its monster radius through monsterRadiusFor", () => {
  // The art-measured manifest map is a FALLBACK ARGUMENT, never an answer. If
  // a future edit reads radii.get(kind) straight into a distance, that consumer
  // silently stops honouring the tuned shadow — and nothing else in the suite
  // would notice, because the art radius is a perfectly plausible number.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "rooms", "WorldRoom.ts"),
    "utf8",
  );
  const uses = src.split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => l.includes("radii.get("));
  assert.ok(uses.length >= 4, `expected the manifest map to feed several consumers, found ${uses.length}`);
  for (const [line, text] of uses)
    assert.ok(
      text.includes("monsterRadiusFor("),
      `WorldRoom.ts:${line} reads the art radius without the tuned-shadow seam: ${text.trim()}`,
    );
  // Four call sites carry five consumers: seeding, the per-tick body snapshot
  // (which feeds BOTH separationPush and monsterDodge), the player's swing
  // reach, and roam-destination spacing — the monster's own attack reach reads
  // the snapshot's r. Nothing may be added outside them.
  assert.ok(
    (src.match(/monsterRadiusFor\(/g) ?? []).length >= 4,
    "all the radius consumers still go through the seam",
  );
  for (const need of ["separationPush(bodies", "attackRange(rm,", "attackRange(PLAYER_BODY_RADIUS, rm)"])
    assert.ok(src.includes(need), `${need} — the tuned radius must still reach this consumer`);
});
