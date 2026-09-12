// ============================================================================
// BASE-SET MEMBERS AND HIS VERDICTS — which rejection drops a member
// ============================================================================
//
// A base-tile-set member leaves the pool on HIS VERDICT ON THE TILE ITSELF: the
// review member's pair key, or the raw tile string. The `#top` facet is his
// DETAIL review — "is this top a once-in-a-while detail" — and by the live
// channel's contract a `rejected` there "does not reject the tile"
// (live/README.md, 2026-08-21; maintainer 2026-09-12: "not a detail" and "in my
// set" are independent judgements). Until 2026-09-12 the pool probed the facet,
// and his detail pass that morning silently emptied 33 of his sets — 219 of 340
// members dropped, none by a verdict on the tile — so 29% of the_game's land and
// 11 of its 16 roofs and bridges drew the clean plate (the flat grey grid he
// photographed on the spawn house). This is the gate on that rule.
//
// The first two tests are data-free and run in the deploy gate's sparse
// checkout; the last reads the real sets and verdicts and skips without them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tiles3, regionAt, type BaseMember } from "../../client/src/tiles3";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const rel = (p: string) => join(REPO, p);

const G = "grass";
const A = "tiles/grass__over__grass/aaaaaaaa"; // a review member
const B = "tiles/grass__over__grass/bbbbbbbb"; // a review member
const T = "tiles/tops/grass/sheet_00_subtle_00000/post/tile_03.0123abcd.webp"; // a tops member
const T_KEY = "tiles/tops/grass/sheet_00_subtle_00000/tile_03.webp"; // its identity: the RAW path

function resolver(feedback: Record<string, { status?: string }>, members: BaseMember[]): Tiles3 {
  // The doc's RAW form of the members, as live/tuning/base_tile_sets.json holds them.
  const raw = members.map((m) => (m.kind === "tile" ? { kind: "tile", tile: m.tile, weight: m.weight } : { kind: "clean", weight: m.weight }));
  return new Tiles3({
    baseTileSets: { grounds: { [G]: { sets: [{ id: 0, name: "Clean", weight: 0, members: [{ kind: "clean", weight: 1 }] }, { id: 1, name: "Set", weight: 1, members: raw }] } } },
    memberResolve: {
      members: {
        [A]: { kind: "conform", art: "tiles/review/grass__over__grass/0_textured.aaaaaaaa.webp" },
        [B]: { kind: "conform", art: "tiles/review/grass__over__grass/1_textured.bbbbbbbb.webp" },
        [T]: { kind: "conform", art: T },
      },
    } as any,
    groundTypes: {} as any,
    patterns: {} as any,
    storeyPitch: 15,
    feedback,
    warn: () => {},
  });
}

/** Every member the pool draws over a block of cells, by tile string. */
function drawn(t: Tiles3): Set<string | null> {
  const out = new Set<string | null>();
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 24; x++) {
      const p = t.plateAt(G, regionAt(G, x, y), x, y);
      const m = p.memberIndex >= 0 ? p.set.members[p.memberIndex] : null;
      out.add(m && m.kind === "tile" ? m.tile : null);
      if (m && m.kind === "tile") assert.notEqual(p.art.kind, "clean", `${m.tile} resolved to the clean plate`);
    }
  return out;
}

test("a `#top` detail rejection never drops a set member; a verdict on the tile itself does", () => {
  const members: BaseMember[] = [
    { kind: "clean", weight: 0 },
    { kind: "tile", id: null, tile: A, weight: 1 },
    { kind: "tile", id: null, tile: B, weight: 1 },
    { kind: "tile", id: null, tile: T, weight: 1 },
  ];
  // His detail pass rejected every top: the set still draws all three.
  const detailPass = resolver({ [`${A}#top`]: { status: "rejected" }, [`${B}#top`]: { status: "rejected" }, [`${T_KEY}#top`]: { status: "rejected" } }, members);
  for (const m of members) if (m.kind === "tile") assert.equal(detailPass.memberRejected(m), false, `${m.tile} dropped by its detail verdict`);
  assert.deepEqual([...drawn(detailPass)].sort(), [A, B, T].sort());

  // A verdict on the TILE (the pair key, or the raw tile string) drops it — and only it.
  const tileVerdict = resolver({ [B]: { status: "rejected" }, [T]: { status: "rejected" }, [`${A}#top`]: { status: "rejected" } }, members);
  assert.equal(tileVerdict.memberRejected(members[1]), false);
  assert.equal(tileVerdict.memberRejected(members[2]), true);
  assert.equal(tileVerdict.memberRejected(members[3]), true);
  assert.deepEqual([...drawn(tileVerdict)], [A]);

  // `approved` on the facet is not a drop either, and a member with no entry at all draws.
  const untouched = resolver({ [`${A}#top`]: { status: "approved" } }, members);
  assert.deepEqual([...drawn(untouched)].sort(), [A, B, T].sort());
});

test("a set whose only member he rejected as a detail still draws that member, never clean", () => {
  const members: BaseMember[] = [{ kind: "clean", weight: 0 }, { kind: "tile", id: null, tile: T, weight: 1 }];
  const t = resolver({ [`${T_KEY}#top`]: { status: "rejected" } }, members);
  assert.deepEqual([...drawn(t)], [T]);
  // ...while the same member rejected AS A TILE leaves the set nothing to draw but clean (-1 is the pool's sentinel).
  const gone = resolver({ [T]: { status: "rejected" } }, members);
  const p = gone.plateAt(G, regionAt(G, 3, 3), 3, 3);
  assert.equal(p.memberIndex, -1);
  assert.equal(p.art.kind, "clean");
});

const NEEDS = ["live/tuning/base_tile_sets.json", "live/feedback/tiles.json"];
const MISSING = NEEDS.filter((p) => !existsSync(rel(p)));
test("on the real sets, only a verdict on the tile itself empties a pool", { skip: !!MISSING.length }, () => {
  const load = (p: string): any => JSON.parse(readFileSync(rel(p), "utf8"));
  const sets = load("live/tuning/base_tile_sets.json");
  const feedback = load("live/feedback/tiles.json").entries as Record<string, { status?: string }>;
  const t = new Tiles3({ baseTileSets: sets, memberResolve: { members: {} } as any, groundTypes: {} as any, patterns: {} as any, storeyPitch: 15, feedback, warn: () => {} });
  const strip = (k: string) => k.replace(/^\/+/, "").replace(/\/+$/, "");
  let members = 0;
  let facetRejected = 0;
  let dropped = 0;
  const emptied: string[] = [];
  for (const g of Object.keys(sets.grounds ?? {}))
    for (const s of t.setsFor(g)) {
      if (s.id === 0) continue;
      let alive = 0;
      for (const m of s.members) {
        if (m.kind !== "tile") continue;
        members++;
        const own = [m.tile, m.tile.replace(/\/post\/(tile_\d+)\.[0-9a-f]{8}\.webp$/, "/$1.webp")].some((k) => feedback[strip(k)]?.status === "rejected");
        const facet = !own && feedback[`${strip(m.tile.replace(/\/post\/(tile_\d+)\.[0-9a-f]{8}\.webp$/, "/$1.webp"))}#top`]?.status === "rejected";
        if (facet) facetRejected++;
        assert.equal(t.memberRejected(m), own, `${g} ${m.tile}: dropped=${t.memberRejected(m)} while its own verdict says rejected=${own}`);
        if (t.memberRejected(m)) dropped++;
        else if (m.weight > 0) alive++;
      }
      if (!alive) emptied.push(`${g}#${s.id}`);
    }
  console.log(`    base-set members ${members}: ${facetRejected} rejected only as a detail (kept), ${dropped} dropped by a verdict on the tile, sets left with nothing to draw: ${emptied.length ? emptied.join(", ") : "none"}`);
});
