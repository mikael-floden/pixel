// Regression harness for analyze-emission.mjs — expectations distilled from
// two rounds of human/agent overlay review (2026-07). Each line is a REAL
// finding: FP = this variant must have NO sources (plain dirt/wood/moss/rock
// specka once got fake lights), REQ = this variant must keep a source with
// this dir (emitters that once went dead). Re-run after changing the
// analyzer; if tile ART legitimately changes, re-review before updating.
const em = (await import("/home/user/pixel/tiles/emission.json", { with: { type: "json" } })).default.categories;
const src = (c, v) => em[c]?.sources?.[String(v)] ?? [];
const dirs = (c, v) => src(c, v).map((s) => s.dir);
let fail = 0;
const empty = [
  ["lava", [0,1,2,3,4,5,6,7,15]],
  ["lava_ledge", [0,1,3,4,7,8,10,12,13,15]],
  ["lava_ledge_v2", [12,13]],
  ["cliff_gold", [9]],
  ["cliff_gold_v2", [8]],
  ["mushroom_grove", [2,8,14]],
  ["ice_spire", [1,5]],
  ["ice_spire_v2", [7]],
];
for (const [cat, vars] of empty)
  for (const v of vars) {
    const s = src(cat, v);
    if (s.length) { console.log(`FP  ${cat} ${v}: ${JSON.stringify(s.map((q)=>[q.dir,q.x,q.y]))}`); fail++; }
  }
{
  // the hanging lantern: 1-2 sources (its glass panes), nothing else
  const l9 = src("cliff_gold_v2", 9);
  const onLantern = l9.every((s) => Math.hypot(s.x - 55, s.y - 53) < 8);
  if (l9.length < 1 || l9.length > 2 || !onLantern) {
    console.log(`cliff_gold_v2 9: want 1-2 lantern sources at ~(55,53), have ${JSON.stringify(l9.map((s)=>[s.x,s.y]))}`);
    fail++;
  }
}
const req = [
  ["lava", 10, ["sw","se"]], ["lava", 12, ["sw"]],
  ["lava_ledge", 14, ["sw"]],
  ["lava_ledge_v2", 8, ["up","se"]], ["lava_ledge_v2", 9, ["up"]],
  ["cliff_lava", 6, ["up"]],
  ["crystal_ground", 6, ["sw","se"]], ["crystal_ground", 7, ["up"]],
  ["mushroom_grove", 15, ["sw","se"]], ["mushroom_grove", 0, ["up"]],
  ["ice_spire", 0, ["up"]],
  ["cliff_crystal", 7, ["sw"]],
  ["cliff_crystal_v2", 1, ["sw"]],
  ["crystal_spire", 2, ["up"]], ["crystal_spire", 8, ["up"]],
  ["cliff_gold", 8, ["up"]],
  // demo-sweep round: emitters that later threshold rounds silently killed
  ["cliff_crystal", 5, ["se"]],  // pale ice-crystal bloom field (blooms sit on the right face)
];
for (const [cat, v, need] of req)
  for (const d of need)
    if (!dirs(cat, v).includes(d)) { console.log(`MISS ${cat} ${v}: no "${d}" (have ${JSON.stringify(dirs(cat,v))})`); fail++; }
console.log(fail === 0 ? "emission extraction expectations: ALL PASS" : `emission extraction: ${fail} FAILING`);
process.exit(fail ? 1 : 0);
