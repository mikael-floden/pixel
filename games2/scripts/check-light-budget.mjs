// check-light-budget — no spot on any world may be reachable by more world
// LIGHT pools than the renderer has slots for (games2 light ledger,
// maintainer 2026-08-12: "no location on the map can ever include more
// emissions/light sources than we can draw in the player's viewport — a light
// will affect the scene before you can see the light source itself").
//
// THE BUDGET: 12 shader slots − 4 reserved (own torch / ambient agent / two
// future fx) = 8 for the world, and the campfire scenery at spawn is one of
// them wherever it stands. So the audit asks: is there any camera position
// where more than 8 world light pools can touch the screen at once?
//
// THE WINDOW: base view is 393×526 world px portrait / 611×393 landscape
// (measured 2026-08-12; base integer zoom is 1 on the reference device in both
// orientations, and the resolution multiplier cancels out of visible extents).
// The speed zoom-out is CAM_ZOOM_OUT = 0.32 — worst-case effective zoom 0.68×
// base, so the worst view is 899×578 landscape / 578×774 portrait; the audit
// takes the max per axis (899×774). Each light then grows the window by its
// own reach: a radius-R pool projects to a screen ellipse of half-extents
// R·√2·32 px horizontally and R·√2·15 px vertically, +64px level slack.
// Sources OPTED OUT of real lights (emission.json lights: null) cost stamps,
// not slots, and are not counted.
//
// Over-budget does NOT break rendering — losers keep their glow stamp (the
// old system is the overflow fallback) — but it means visibly weaker fires in
// exactly the crowded spots that were designed to impress, so it fails here
// where the map author sees it instead.
//
// RATCHET, not a purge: 6 worlds already exceeded the window the day the
// ledger shipped (all demos/showcases; the LIVE the_island2 measured 6/8).
// They keep working on the stamp fallback and are pinned in
// spec/light-budget-baseline.json at their measured worst — the gate fails a
// world only when it gets WORSE than its pin (or a fresh world exceeds 8).
// Burn the pins down when touching those worlds.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const WORLD_SLOTS = 8;
const VIEW_W = 899; // landscape 611 css / 0.68 worst-case zoom
const VIEW_H = 774; // portrait 526 css / 0.68 worst-case zoom
const REACH_X = Math.SQRT2 * 32; // px per radius cell, horizontal
const REACH_Y = Math.SQRT2 * 15; // px per radius cell, vertical
const BASELINE = JSON.parse(readFileSync(join(here, "..", "spec", "light-budget-baseline.json"), "utf8"));

// NEVER pass vacuously when the input is missing — but say WHY, because a raw
// ENOENT stack from a CI runner is a puzzle. The deploy workflow's test job
// takes a SPARSE checkout (games2/characters2/maps2 worlds/live), so this file
// has to be listed there explicitly; it was not, and the first deploy after the
// light ledger died here with a bare node trace (2026-08-12).
const emissionPath = join(root, "tiles2", "emission.json");
if (!existsSync(emissionPath)) {
  console.error(
    `check-light-budget: cannot read ${emissionPath}. If this is CI, the checkout is missing it — ` +
      "the deploy workflow takes a sparse checkout and must list /tiles2/emission.json.",
  );
  process.exit(1);
}
const emission = JSON.parse(readFileSync(emissionPath, "utf8"));
const lightsCfg = emission.lights ?? {};
const stem = (p) => p.replace(/\.(png|webp)$/, "");

const worldsDir = join(root, "maps2", "worlds");
let failed = 0;
for (const name of readdirSync(worldsDir)) {
  const wp = join(worldsDir, name, "world.json");
  if (!existsSync(wp)) continue;
  const w = JSON.parse(readFileSync(wp, "utf8"));
  const paths = w.paths ?? [];
  const props = Array.isArray(w.props) ? w.props : [];
  // level grid for y projection
  const lvl = (c, r) => {
    const row = w.level?.[r];
    return typeof row === "string" ? parseInt(row[c] ?? "0", 36) || 0 : Array.isArray(row) ? row[c] ?? 0 : 0;
  };
  const sources = [];
  for (const p of props) {
    const path = paths[p.tile];
    if (!path || !emission.sources?.[path]) continue;
    const cfg = lightsCfg[stem(path)] !== undefined ? lightsCfg[stem(path)] : lightsCfg[path.split("/")[1]];
    if (cfg === null) continue; // stamp-only: costs no slot
    const mat = path.split("/")[1];
    // MIRROR of WorldScene.buildEmissiveSources' derived default (campfire-
    // anchored, 2026-08-13): radius grows with the art's own strength toward
    // the campfire's 7. Drifting from the client's formula makes the audit
    // count a different set of pools than the renderer lights.
    const srcs = emission.sources[path] ?? [];
    let sw = 0;
    for (const g of srcs) sw += g.s;
    const avgS = srcs.length ? sw / srcs.length : 0;
    const radius = Math.max(1, cfg?.radius ?? Math.min(7, 4 + avgS * 4));
    sources.push({
      x: (p.x - p.y) * 32,
      y: (p.x + p.y) * 15 - lvl(p.x, p.y) * 16,
      reach: radius * REACH_X + 64,
      reachY: radius * REACH_Y + 64,
      col: p.x,
      row: p.y,
    });
  }
  // The spawn campfire is a world light too, ~2.5 cells from spawn.
  if (Array.isArray(w.spawn)) {
    const [sc, sr] = w.spawn;
    sources.push({ x: (sc - sr) * 32, y: (sc + sr) * 15 - lvl(sc, sr) * 16, reach: 7 * REACH_X + 64, reachY: 7 * REACH_Y + 64, col: sc, row: sr, campfire: true });
  }
  if (!sources.length) {
    console.log(`check-light-budget: ${name} — no light sources`);
    continue;
  }
  // Scan candidate window centres on a 64px grid over the sources' bbox.
  const xs = sources.map((s) => s.x), ys = sources.map((s) => s.y);
  const x0 = Math.min(...xs) - VIEW_W, x1 = Math.max(...xs) + VIEW_W;
  const y0 = Math.min(...ys) - VIEW_H, y1 = Math.max(...ys) + VIEW_H;
  let worst = 0, at = null;
  for (let cy = y0; cy <= y1; cy += 64)
    for (let cx = x0; cx <= x1; cx += 64) {
      let n = 0;
      for (const s of sources) {
        if (
          s.x + s.reach >= cx - VIEW_W / 2 &&
          s.x - s.reach <= cx + VIEW_W / 2 &&
          s.y + s.reachY >= cy - VIEW_H / 2 &&
          s.y - s.reachY <= cy + VIEW_H / 2
        )
          n++;
      }
      if (n > worst) {
        worst = n;
        at = sources.find((s) => Math.abs(s.x - cx) < VIEW_W && Math.abs(s.y - cy) < VIEW_H);
      }
    }
  const where = at ? ` (worst near cell ${at.col},${at.row})` : "";
  const cap = Math.max(WORLD_SLOTS, typeof BASELINE[name] === "number" ? BASELINE[name] : 0);
  const over = worst > cap;
  const tag = over ? "OVER BUDGET" : worst > WORLD_SLOTS ? `pinned ${BASELINE[name]} (fallback look)` : "ok";
  console.log(`check-light-budget: ${name} — ${sources.length} sources, worst window ${worst}/${WORLD_SLOTS} ${tag}${where}`);
  if (over) failed++;
}
if (failed) {
  console.error(
    `check-light-budget: ${failed} world(s) exceed the ${WORLD_SLOTS}-light window. ` +
      "Spread the emissive props / scenery out, lower their radius in tiles2/emission.json `lights`, " +
      "or opt decorative ones out with null. Spec: games2/spec/LIGHT_BUDGET.md",
  );
  process.exit(1);
}
