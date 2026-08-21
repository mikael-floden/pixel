// GROOM THE TILES FEEDBACK — remove reviews whose tiles no longer exist.
//
// Maintainer 2026-08-21: "Why don't you maintain and remove old reviews I have
// already rejected?" He is right about the lifecycle: a rejection's whole job
// is to make the tiles agent delete the generation and grow a replacement.
// Once the tile is gone from the review manifest the entry has DONE its work —
// and every regeneration wave was leaving a layer of these behind (measured
// today: 2,392 dead entries under 4,049 live tiles — a third of the file was
// verdicts about art that no longer exists).
//
// THE ONE THING NEVER PRUNED: a `#top` entry with status "approved". That is
// the Game Master's pick for the ground-details pass, and the tiles agent is
// under instruction to keep that art even when the pair-tile is rejected — the
// designation must outlive the pair-tile's own manifest row.
//
// Run from the repo root. Dry by default; --write rewrites the live doc (then
// commit it — the push is what refreshes the game server's store).
//
//   node wiki/tools/prune-feedback.mjs [--write]
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url).pathname;
const FB = `${ROOT}live/feedback/tiles.json`;
const doc = JSON.parse(readFileSync(FB, "utf8"));
const man = JSON.parse(readFileSync(`${ROOT}tiles/review/manifest.json`, "utf8"));
const live = new Set(Object.values(man.cells ?? {}).flatMap((c) => (c.candidates ?? []).map((x) => x.key)));
const cells = new Set(Object.keys(man.cells ?? {}).map((id) => `tiles/${id}`));

const entries = doc.entries ?? {};
const drop = [];
for (const [key, e] of Object.entries(entries)) {
  const base = key.split("#")[0];
  if (live.has(base)) continue;                 // the tile is live — keep
  if (cells.has(base)) continue;                // a cell-level id — keep
  if (key.endsWith("#top") && e?.status === "approved") continue;  // his detail pick — sacred
  drop.push(key);
}
const kinds = { rejected: 0, approved: 0, "starred-only": 0, other: 0 };
for (const k of drop) {
  const e = entries[k];
  kinds[e?.status === "rejected" ? "rejected" : e?.status === "approved" ? "approved" : e?.rating ? "starred-only" : "other"]++;
}
console.log(`entries ${Object.keys(entries).length} | live tiles ${live.size} | dead entries to prune ${drop.length}`);
console.log(`  ${JSON.stringify(kinds)}`);
if (!process.argv.includes("--write")) {
  console.log("dry run — pass --write to prune");
  process.exit(0);
}
for (const k of drop) delete entries[k];
doc.updated_at = new Date().toISOString();
writeFileSync(FB, JSON.stringify(doc, null, 2) + "\n");
console.log(`pruned — ${Object.keys(entries).length} entries remain; commit live/feedback/tiles.json to publish`);
