// EVERY EFFECT THE GAME CAN SWITCH ON HAS A ZONE THAT CAN SWITCH IT ON.
//
// Since 45c12c2cb9 the server rolls only what a zone assigns, and an effect no
// zone names never comes on in play. That is a silent failure: the effect is
// registered, its Settings row is there, the code is intact, and it simply
// never happens. Measured 2026-09-19: `mist` and `cloudy` — the two gloom-only
// weather rows, which have no effect folder — had no share in any of 96 zones,
// because maps2's vocabulary read "ambient's feature folders plus the six
// weather rows" and weather is eight. The maintainer's favourite effect was
// unreachable for two days and nothing said so.
//
// THE VOCABULARY IS DERIVED, NOT LISTED: the feature folders on disk plus the
// weather rows shared/ambient.ts declares — the same two sources the registry
// (ambient/index.ts) and maps2's spec should read, so a new folder or a new
// weather row is covered the day it exists. Skips when the world doc is absent
// (the deploy's sparse checkout — docs/testing.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WEATHER_EFFECTS } from "@nangijala/shared";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AMBIENT = join(REPO, "games2", "ambient");
const REAL = join(REPO, "maps2", "worlds3", "the_game", "ambient.json");
const skip = !existsSync(REAL);

/** Folders under ambient/ that are not one effect each. `weather/` holds the
 *  eight rows WEATHER_EFFECTS names, so it is counted from there instead. */
const NOT_A_FEATURE = new Set(["runtime", "scripts", "art-original", "weather"]);

/** KNOWN ORPHANS — switchable, assigned by no zone — each with the request
 *  that will close it. An entry keeps the suite green while the owning agent
 *  works; the last test FAILS the day the zone lands, so an entry cannot
 *  outlive its fix and the list can only shrink. */
const ORPHANED: Record<string, string> = {
  mist: "2026-09-19 — asked of maps2 on games-ambient-assistant's board: no zone gives mist a share",
  cloudy: "2026-09-19 — the same request",
};

function switchable(): string[] {
  const folders = readdirSync(AMBIENT)
    .filter((d) => !NOT_A_FEATURE.has(d) && statSync(join(AMBIENT, d)).isDirectory())
    .filter((d) => existsSync(join(AMBIENT, d, `${d}.ts`)));
  return [...new Set([...folders, ...WEATHER_EFFECTS])].sort();
}

function assigned(): Map<string, number> {
  const doc = JSON.parse(readFileSync(REAL, "utf8")) as { zones: { effects: Record<string, number> }[] };
  const n = new Map<string, number>();
  for (const z of doc.zones) for (const e of Object.keys(z.effects)) n.set(e, (n.get(e) ?? 0) + 1);
  return n;
}

test("the switchable vocabulary is what the registry has: 26 folders plus the eight weather rows", () => {
  const v = switchable();
  assert.ok(v.length >= 30, `derived ${v.length} names`);
  for (const w of WEATHER_EFFECTS) assert.ok(v.includes(w), `${w} is switchable`);
  assert.ok(v.includes("thunder") && v.includes("chimney") && v.includes("mist"));
  // the registry names every folder once — a folder the registry dropped would
  // wrongly demand a zone here, and one it added without a folder would go unchecked
  const src = readFileSync(join(AMBIENT, "index.ts"), "utf8");
  for (const f of v) {
    if ((WEATHER_EFFECTS as readonly string[]).includes(f)) continue;
    const camel = f.replace(/water$/, "Water").replace(/^deepWater$/, "deepWater");
    assert.ok(new RegExp(`\\b(${f}|${camel})Feature\\(\\)`).test(src), `${f}/ is registered in ambient/index.ts`);
  }
});

test("every name a zone assigns is an effect the game can switch on (a typo never fires)", { skip }, () => {
  const v = new Set(switchable());
  for (const [name, zones] of assigned())
    assert.ok(v.has(name), `ambient.json assigns \`${name}\` in ${zones} zone(s) but nothing is registered under that name`);
});

test("every switchable effect has at least one zone that can switch it on", { skip }, () => {
  const have = assigned();
  const missing = switchable().filter((n) => !have.has(n) && !(n in ORPHANED));
  assert.deepEqual(
    missing,
    [],
    `switchable but assigned by NO zone — the server will never roll ${missing.join(", ")}; ` +
      `either give it a share in maps2's ambient.json or list it in ORPHANED with the request that will`,
  );
});

test("the known orphans are still orphans — an entry cannot outlive its fix", { skip }, () => {
  const have = assigned();
  for (const [name, why] of Object.entries(ORPHANED))
    assert.ok(!have.has(name), `\`${name}\` now has a zone (${have.get(name)}) — delete its ORPHANED entry (${why})`);
});
