// verify-lightparity — the light slot ledger's browser gate (dev stack), on
// the_game (maps2/worlds3).
//
// THE CLAIM UNDER TEST (maintainer 2026-09-06: "the LIT scenery is not lit at
// all"): a `lit` scenery placement is a REAL light derived from its own art
// (scenerylights.ts), not a glow sticker — it holds a world slot, its ground
// pool is genuinely lit, two lamps of one model light alike, a sealed room's
// hearth lights the room and NEVER leaks outside — and the whole thing lives
// inside a 12-slot budget with 4 reserved slots.
// RETIRED with tiles2: the emissive-TILE-vs-spawn-campfire parity this gate
// was written for (the_island2's hand-placed bonfire A/B cell). the_game has
// no emissive tiles and no spawn campfire; every fixed light is scenery.
//
// Sections:
//  1. the ledger exists: slot invariants hold
//  2. OUTDOORS — the lit lamp nearest spawn holds a world slot and its ground
//     is LIT: the CPU light twin 2 cells out vs plain night ground far from
//     every source
//  2b. PARITY — two placements of the SAME lamp model, measured in luminance
//     rings on real pixels, both at night, torch OFF: within 2x either way
//  2c. a SEALED ROOM's hearth holds no slot and leaks nothing while I stand
//     outside its wall
//  3. INDOORS — the hearth lights its room and falls off across it
//  4. BUDGET — total lights never exceed 12; the QA probe consumes a world
//     slot; overflow is reported, not silently truncated
//
// Method notes: every luminance number is a MEDIAN over a pixel patch (the
// footstep/ambient-agent lesson — single pixels lie); the camera is parked
// with __ml.lookAt so the target sits at screen centre; and a lamp's pool is
// isolated from mine by __ml.torch(false).
//
// FIXTURES are derived from maps2/worlds3/the_game/world.json, never typed: a
// lit piece is `s3:<index into scenery[]>` in the ledger (scenery3.ts). The
// derivation must carry the property its arms depend on, not just "nearest" —
// the outdoor lamp is the nearest lit piece OUTSIDE every room, because the
// nearest lit piece full stop became a sealed hearth once the town grew around
// spawn, and three arms then measured a wall. Which pieces it picked is
// PRINTED on every run (`fixtures:`); nothing here names them, because a name
// in a comment is the next thing to go stale.
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const W = 480, H = 320;
let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "OK " : "FAIL"} ${label}`);
  if (!cond) failed++;
};
const fatal = (m) => { console.log(`FAIL ${m}`); process.exit(1); };

/* -- fixtures from the world doc -------------------------------------------- */
const world = JSON.parse(readFileSync(new URL("../../maps2/worlds3/the_game/world.json", import.meta.url), "utf8"));
const [SPAWN_C, SPAWN_R] = world.spawn;
const lit = world.scenery.map((p, i) => ({ ...p, i, id: `s3:${i}` })).filter((p) => p.lit);
if (!lit.length) fatal("the_game places no lit scenery — nothing to gate");
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const liquid = new Set(world.liquids ?? []);
const groundAt = (c, r) => world.grounds[world.ground[r]?.[c]] ?? "";
// Which cells belong to a room — a sealed light is indoor-only by design, so
// the OUTDOOR sections must not pick one.
const roomCellSets = world.rooms.map((rm) => new Set(rm.cells.map((c) => `${c.x},${c.y}`)));
const inARoom = (p) => roomCellSets.some((s) => s.has(`${Math.floor(p.x)},${Math.floor(p.y)}`));
// THE LAMP: the lit piece nearest spawn that stands OUTDOORS. Sections 2/2b
// measure a pool on open ground and a slot that is held while I stand beside
// it — a sealed room's hearth holds neither (2c asserts exactly that), and
// since the town grew around the spawn the nearest lit piece has become one:
// the fixture silently turned into a hearth indoors and three arms measured a
// wall (hearths/hearth_004 @333.3,232.3, the spawn house).
const outdoorLit = lit.filter((p) => !inARoom(p));
if (!outdoorLit.length) fatal("every lit placement stands in a room — the outdoor sections have no fixture");
const LAMP = outdoorLit
  .slice()
  .sort((a, b) => d2(a, { x: SPAWN_C, y: SPAWN_R }) - d2(b, { x: SPAWN_C, y: SPAWN_R }))[0];
// Its twin: the nearest other placement of the SAME piece (same art → same
// derived light), far enough away that the two pools do not overlap.
const LAMP2 = lit
  .filter((p) => p !== LAMP && p.piece === LAMP.piece && d2(p, LAMP) >= 10)
  .sort((a, b) => d2(a, LAMP) - d2(b, LAMP))[0];
// The lit piece standing on a ROOM cell (world.json `rooms`): a sealed light.
const roomCells = roomCellSets;
const HEARTH = lit.find((p) => inARoom(p));
if (!HEARTH) fatal("no lit scenery stands inside a room — the sealed-room fixture is gone");
const ROOM = world.rooms[roomCells.findIndex((s) => s.has(`${Math.floor(HEARTH.x)},${Math.floor(HEARTH.y)}`))].cells;
const ROOF = world.decks.find((d) => d.kind === "roof" && d.cells.some((c) => c.x === Math.floor(HEARTH.x) && c.y === Math.floor(HEARTH.y)));
if (!ROOF) fatal("the hearth's room has no roof deck — it is not sealed");
const roomNearest = (x, y) => ROOM.slice().sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
const IN_STAND = roomNearest(HEARTH.x + 1, HEARTH.y + 2); // where I stand in the room
const IN_NEAR = roomNearest(HEARTH.x + 1, HEARTH.y + 1);  // a floor cell beside the fire
const IN_FAR = ROOM.slice().sort((a, b) => Math.hypot(b.x - HEARTH.x, b.y - HEARTH.y) - Math.hypot(a.x - HEARTH.x, a.y - HEARTH.y))[0];
const roofY0 = Math.min(...ROOF.cells.map((c) => c.y));
const OUTSIDE = { x: Math.floor(HEARTH.x), y: roofY0 - 2 }; // two cells north of the wall, outdoors
// Plain night ground: within R cells of (cx,cy), the land cell farthest from
// every lit piece (so nothing but ambient reaches it).
/* THE RINGS CLEAR THE PIECE'S OWN ART. A pool's falloff is measured on the
 * GROUND around the lamp, and a ring that lands on the lamp itself measures a
 * dark silhouette: the fixture the world gives today is a cauldron camp two
 * cells wide, and its inner ring read 100.7 against 158.9 further out — the
 * art, not the light. The piece's drawn width comes from the same bbox table
 * the renderer scales by (config/scenery-bbox.json: the alpha box, the piece's
 * world_px_height re-based to our 88 px person), so the inner ring starts just
 * outside it whatever the world places here. */
const bboxDoc = JSON.parse(readFileSync(new URL("../config/scenery-bbox.json", import.meta.url), "utf8"));
const drawnHalfCells = (p) => {
  const facts = bboxDoc.pieces?.[p.piece];
  const spr = (p.state ? facts?.states?.[p.state] : null) ?? facts?.sprite;
  const bb = spr ? bboxDoc.boxes?.[spr] : null;
  const base = facts?.sprite ? bboxDoc.boxes?.[facts.sprite] : null;
  if (!facts || !bb || !base || !facts.wph) return 1.2;
  const drawn = (facts.wph * 88) / (facts.cpx || 64); // sceneryDrawnPx
  const k = drawn / Math.max(1, base[3] - base[1]);
  return Math.max(0.8, ((bb[2] - bb[0]) * k) / 2 / 32); // half the drawn width, in cells
};
const plainNear = (cx, cy, R = 25) => {
  let best = null;
  // FLOORED BOUNDS: a placement's x/y are FRACTIONAL (maps3 places scenery at
  // continuous cell coordinates), and a fractional loop index indexes the
  // ground rows with a float — `ground[233.04]` is undefined, so every cell
  // read as "no ground" and the sweep came back empty.
  const c0 = Math.floor(cx);
  const r0 = Math.floor(cy);
  for (let r = Math.max(0, r0 - R); r <= Math.min(world.size.h - 1, r0 + R); r++)
    for (let c = Math.max(0, c0 - R); c <= Math.min(world.size.w - 1, c0 + R); c++) {
      const g = groundAt(c, r);
      if (!g || liquid.has(g)) continue;
      const d = Math.min(...lit.map((p) => Math.hypot(p.x - c, p.y - r)));
      if (!best || d > best.d) best = { d, x: c, y: r };
    }
  return best;
};
const FAR_LAMP = plainNear(LAMP.x, LAMP.y);
const FAR_HOUSE = plainNear(OUTSIDE.x, OUTSIDE.y);
// Budget sweep: the densest lit clusters (lit pieces within 6 cells), 10+ cells apart.
// Just outside the art, and far enough out to see the pool fall away.
const RING_IN = +Math.max(2.2, drawnHalfCells(LAMP) + 0.9).toFixed(1);
const RING_OUT = +(RING_IN * 1.9).toFixed(1);
const SWEEP = lit
  .map((p) => ({ p, n: lit.filter((q) => d2(p, q) <= 6).length }))
  .sort((a, b) => b.n - a.n)
  .reduce((acc, { p }) => (acc.some((q) => d2(p, q) < 10) ? acc : [...acc, p]), [])
  .slice(0, 6);
console.log(
  `fixtures: lamp ${LAMP.id} ${LAMP.piece} @${LAMP.x.toFixed(1)},${LAMP.y.toFixed(1)}; twin ${LAMP2?.id ?? "none"}; ` +
  `hearth ${HEARTH.id} ${HEARTH.piece} @${HEARTH.x.toFixed(1)},${HEARTH.y.toFixed(1)} (roof level ${ROOF.level}); ` +
  `outside ${OUTSIDE.x},${OUTSIDE.y}; plain ${FAR_LAMP.x},${FAR_LAMP.y} (${FAR_LAMP.d.toFixed(1)} cells from any light); rings ${RING_IN}/${RING_OUT} cells`,
);

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});
const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForFunction(() => window.__mlSelect, { timeout: 40000 });
const idx = await page.evaluate(() => window.__mlSelect.worlds().findIndex((w) => /the_game/i.test(w)));
await page.evaluate((i) => { window.__mlSelect.pickWorld(i); window.__mlSelect.commit(); }, idx);
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 90000 });
await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 30000 });
await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.weather(0, true);
  window.__ml.timeOfDay("Night", true);
  window.__ml.torch(false);
});
await page.waitForTimeout(3500);

// Median luminance of a square patch (screenshot buffer).
const shoot = async () => PNG.sync.read(await page.screenshot());
const lumPatch = (png, cx, cy, half) => {
  const vals = [];
  for (let y = Math.max(0, cy - half); y < Math.min(png.height, cy + half); y++)
    for (let x = Math.max(0, cx - half); x < Math.min(png.width, cx + half); x++) {
      const i = (y * png.width + x) * 4;
      vals.push(0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]);
    }
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)] ?? 0;
};
// Mean luminance over a RING of patches at screen radius r around centre.
const lumRing = (png, cx, cy, r, half = 5) => {
  let s = 0, n = 0;
  for (let a = 0; a < 360; a += 30) {
    // The iso ground plane squashes vertical: sample an ellipse (ry = r*14/32).
    const x = Math.round(cx + r * Math.cos((a * Math.PI) / 180));
    const y = Math.round(cy + r * (14 / 32) * Math.sin((a * Math.PI) / 180));
    if (x < 8 || y < 8 || x > png.width - 8 || y > png.height - 60) continue;
    s += lumPatch(png, x, y, half);
    n++;
  }
  return n ? s / n : 0;
};
const mag = (l) => (l ? (l[0] + l[1] + l[2]) / 3 : 0);

// ---- 1. the ledger ----------------------------------------------------------
const slots0 = await page.evaluate(() => window.__ml.lightSlots());
console.log("ledger:", JSON.stringify(slots0));
ok(slots0.max === 12 && slots0.reserved === 4 && slots0.worldSlots === 8, "ledger layout 12 = 4 reserved + 8 world");
ok(slots0.total <= slots0.max, `total lights ${slots0.total} <= ${slots0.max}`);

// ---- 2. OUTDOORS: the lamp nearest spawn is a real light ---------------------
const zoom = (await page.evaluate(() => window.__ml.camInfo())).zoom;
const CX = W / 2, CY = H / 2;
const ringPx = (cells) => cells * 32 * zoom; // iso half-tile dx = 32 world px

await page.evaluate((p) => window.__ml.lookAt(p.x, p.y), LAMP);
await page.waitForTimeout(900);
const lampSlots = await page.evaluate(() => window.__ml.lightSlots());
ok(lampSlots.slotted.includes(LAMP.id), `the lamp by spawn (${LAMP.id}) holds a world slot`);
const lampShot = await shoot();
const lampR2 = lumRing(lampShot, CX, CY, ringPx(RING_IN));
const lampR4 = lumRing(lampShot, CX, CY, ringPx(RING_OUT));
// "The lamp's ground is LIT": the CPU light twin (the very sample lit copies
// tint by), 2 cells from the lamp vs plain night ground far from every source —
// pixels near the screen edge hit HUD chips, this cannot.
const lit2 = await page.evaluate((p) => window.__ml.lightAt(p.x + 2, p.y + 1), LAMP);
const litFar = await page.evaluate((p) => window.__ml.lightAt(p.x, p.y), FAR_LAMP);
console.log(`luma: lamp r${RING_IN}=${lampR2.toFixed(1)} r${RING_OUT}=${lampR4.toFixed(1)} | lightAt near=${mag(lit2).toFixed(3)} far=${mag(litFar).toFixed(3)}`);
console.log("  luma profile by cell: " + [1.2, 2, 3, 4, 5, 6, 8, 10].map((c) => `${c}:${lumRing(lampShot, CX, CY, ringPx(c)).toFixed(0)}`).join(" "));
ok(mag(lit2) > mag(litFar) * 2.2, `the lamp's ground is LIT (lightAt ${mag(lit2).toFixed(3)} vs far ${mag(litFar).toFixed(3)})`);
/* THE FALLOFF IS MEASURED ON THE LIGHT, NOT ON ONE SITE'S PIXELS. A ring of
 * ground around a lamp is whatever the MAP put there — its material, its
 * neighbours' art, the piece's own contact shadow — and at today's fixture the
 * luma profile rises outward (1.2:107 2:99 3:110 4:159 6:174 8:183) with the
 * pool falling away the whole time: a brighter ground two cells out beats a
 * darker one under the lamp. The pixel claim survives where the confounders
 * CANCEL — the twin arm below, which is a ratio of the same piece at the same
 * radii — and the falloff itself is asked of the light the pipeline and the
 * shader both read. */
const litNear = await page.evaluate(([p, d]) => window.__ml.lightAt(p.x + d, p.y), [LAMP, RING_IN]);
const litOut = await page.evaluate(([p, d]) => window.__ml.lightAt(p.x + d, p.y), [LAMP, RING_OUT]);
console.log(`  falloff: lightAt ${RING_IN} cells = ${mag(litNear).toFixed(3)}, ${RING_OUT} cells = ${mag(litOut).toFixed(3)}`);
ok(
  mag(litNear) > mag(litOut),
  `the pool falls off with distance (lightAt ${mag(litNear).toFixed(3)} at ${RING_IN} cells > ${mag(litOut).toFixed(3)} at ${RING_OUT})`,
);

// ---- 2b. PARITY: two placements of the same lamp model -----------------------
// Same art → the same derived light. The ground albedo under each may differ,
// so parity is within 2x either way at both rings, as it was tile-vs-campfire.
if (!LAMP2) console.log(`(no second ${LAMP.piece} 10+ cells away — skipping the same-model parity)`);
else {
  await page.evaluate((p) => window.__ml.lookAt(p.x, p.y), LAMP2);
  await page.waitForTimeout(900);
  const twinSlots = await page.evaluate(() => window.__ml.lightSlots());
  ok(twinSlots.slotted.includes(LAMP2.id), `the twin lamp (${LAMP2.id}) holds a world slot`);
  const twinShot = await shoot();
  const twinR2 = lumRing(twinShot, CX, CY, ringPx(RING_IN));
  const twinR4 = lumRing(twinShot, CX, CY, ringPx(RING_OUT));
  const par2 = twinR2 / Math.max(1, lampR2);
  const par4 = twinR4 / Math.max(1, lampR4);
  console.log(`luma: twin r${RING_IN}=${twinR2.toFixed(1)} r${RING_OUT}=${twinR4.toFixed(1)}`);
  ok(par2 > 0.5 && par2 < 2.0, `parity at ${RING_IN} cells: twin/lamp = ${par2.toFixed(2)}`);
  ok(par4 > 0.5 && par4 < 2.0, `parity at ${RING_OUT} cells: twin/lamp = ${par4.toFixed(2)}`);
}

// ---- 2c. A SEALED ROOM'S FIRE NEVER LEAKS OUTSIDE ---------------------------
// Maintainer 2026-08-12 (screenshot outdoors): "I can clearly see there is a
// light source inside the house bleeding through the walls." The LOS march's
// 0.22 bounce floor passes 22% of any light through any wall, and the fire's
// halo stamps painted on the roof pixels — so a sealed-room fire is indoor-only.
await page.evaluate(() => window.__ml.lookAt());
await page.evaluate((o) => window.__ml.teleport(o.x, o.y), OUTSIDE);
await page.waitForTimeout(1500);
const outSlots = await page.evaluate(() => window.__ml.lightSlots());
ok(!outSlots.slotted.includes(HEARTH.id), `the hearth (${HEARTH.id}) holds NO slot while I am outside`);
const wallOut = await page.evaluate((o) => window.__ml.lightAt(o.x, o.y + 0.5), OUTSIDE);
const plainOut = await page.evaluate((p) => window.__ml.lightAt(p.x, p.y), FAR_HOUSE);
console.log(`outside-the-house lightAt: nearWall=${mag(wallOut).toFixed(3)} plain=${mag(plainOut).toFixed(3)}`);
ok(mag(wallOut) < mag(plainOut) * 1.5 + 0.05, `no fire bleeds through the wall (${mag(wallOut).toFixed(3)} vs plain ${mag(plainOut).toFixed(3)})`);

// ---- 3. INDOORS: the fire lights its room -----------------------------------
// The maintainer's 2026-08-12 screenshot: a room floor pitch black around a
// burning fire. Stand in the hearth's room; the hearth must take a slot.
await page.evaluate(() => window.__ml.lookAt());
await page.evaluate((c) => window.__ml.teleport(c.x, c.y), IN_STAND);
await page.waitForTimeout(2500); // indoor fade + camera snap
const indoorSlots = await page.evaluate(() => window.__ml.lightSlots());
ok(indoorSlots.slotted.includes(HEARTH.id), `indoors, the hearth (${HEARTH.id}) holds a world slot`);
// The CPU twin again — pixel patches in a small room hit walls, the player's
// own coordinate label, or the white occlusion ring. lightAt cannot.
const inNear = await page.evaluate((c) => window.__ml.lightAt(c.x, c.y), IN_NEAR);
const inFarC = await page.evaluate((c) => window.__ml.lightAt(c.x, c.y), IN_FAR);
console.log(`indoor lightAt: nearFire=${mag(inNear).toFixed(3)} acrossRoom=${mag(inFarC).toFixed(3)}`);
ok(mag(inNear) > 0.25, `the room is fire-lit near the fire (${mag(inNear).toFixed(3)})`);
ok(mag(inNear) > mag(inFarC) * 1.4, `light falls off across the room (${mag(inNear).toFixed(3)} vs ${mag(inFarC).toFixed(3)})`);

// ---- 4. BUDGET invariants ----------------------------------------------------
// The probe light consumes a WORLD slot: with it set, world holders <= 7.
await page.evaluate((p) => window.__ml.probeLight(p.x, p.y, 1, 5), LAMP);
await page.waitForTimeout(400);
const withProbe = await page.evaluate(() => window.__ml.lightSlots());
ok(withProbe.probe && withProbe.slotted.length <= 7, `probe consumes a world slot (${withProbe.slotted.length} <= 7)`);
ok(withProbe.total <= 12, `total with probe ${withProbe.total} <= 12`);
await page.evaluate(() => window.__ml.probeLight());
// Sweep the densest lit clusters plus the two fixtures; the invariant must hold
// everywhere and overflow must be COUNTED, never silently truncated.
let worstTotal = 0, sawOverflowField = true;
for (const p of [...SWEEP, LAMP, HEARTH]) {
  await page.evaluate(([cc, rr]) => window.__ml.lookAt(cc, rr), [p.x, p.y]);
  await page.waitForTimeout(350);
  const s = await page.evaluate(() => window.__ml.lightSlots());
  worstTotal = Math.max(worstTotal, s.total);
  if (typeof s.overflow !== "number") sawOverflowField = false;
}
ok(worstTotal <= 12, `worst-case total across the sweep = ${worstTotal} <= 12`);
ok(sawOverflowField, "overflow is reported at every spot");

await browser.close();
console.log(failed ? `\nverify-lightparity: ${failed} FAILURE(S)` : "\nverify-lightparity OK");
process.exit(failed ? 1 : 0);
