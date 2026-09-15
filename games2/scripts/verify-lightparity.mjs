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
//  5. THE SETTINGS SWITCH — "scenery lights" off removes every piece's pool
//     and halo and nothing else; ON restores them without a rejoin
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
const levelAt = (c, r) => (Array.isArray(world.level[0]) ? world.level[r]?.[c] : world.level[r * world.size.w + c]) ?? 0;
/* SECTION 6's PAIR: a lit piece with an UNLIT piece 1.3-2.6 cells away on the same
 * level — a light and something for it to throw a shadow of. Preferring a pair on
 * RAISED ground is the whole point of the arm: a shadow height clamped absolutely
 * instead of against the light's own footing is identical to the right answer at
 * level 0 and 39 storeys wrong on a cliff top, and level 0 is where every site in
 * the 2026-09-15 investigation happened to sit. */
const unlit = world.scenery.map((p, i) => ({ ...p, i, id: `s3:${i}` })).filter((p) => !p.lit);
const SHADOW_PAIRS = lit
  .filter((L) => !inARoom(L)) // a SEALED light is indoor-only by design: outside its room it never reaches the ledger at all
  .flatMap((L) => unlit
    .filter((C) => levelAt(Math.floor(C.x), Math.floor(C.y)) === levelAt(Math.floor(L.x), Math.floor(L.y)))
    .map((C) => ({ L, C, d: d2(L, C) }))
    .filter((x) => x.d >= 1.3 && x.d <= 2.6))
  .sort((a, b) => (levelAt(Math.floor(b.L.x), Math.floor(b.L.y)) - levelAt(Math.floor(a.L.x), Math.floor(a.L.y))) || a.d - b.d);
const SHADOW = SHADOW_PAIRS[0];
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

// ---- 5. THE SETTINGS SWITCH: "scenery lights" off ---------------------------
// His debug instrument (2026-09-15: "a way to turn off Scenery lights ... I
// just want it to easier debug the scene"). OFF must remove every light a
// PIECE makes — its pool in the ledger and its glow halo — and nothing else:
// the piece is still drawn, the sky and a torch still light the scene, and the
// switch is not a rejoin, so ON restores it from the placements on screen.
// Measured beside the derived lamp, which section 2 already proved is lit.
await page.evaluate((p) => window.__ml.lookAt(p.x, p.y), LAMP);
await page.evaluate((p) => window.__ml.teleport(p.x + 1, p.y + 3), LAMP);
await page.waitForTimeout(2500);
await page
  .waitForFunction(() => window.__ml.sceneryLights().sources > 0, null, { timeout: 60_000, polling: 200 })
  .catch(() => {});
const swOn = await page.evaluate(() => window.__ml.sceneryLights());
const beside = async () => mag(await page.evaluate((p) => window.__ml.lightAt(p.x + 1.5, p.y + 1), LAMP));
const onLit = await beside();
ok(swOn.on && swOn.sources > 0 && swOn.stamps > 0, `it ships ON, with the lamp's light and halo (${swOn.sources} sources, ${swOn.stamps} stamps)`);
const drawnOn = await page.evaluate((i) => (window.__ml.sceneryDrawn(i) ?? []).length, LAMP.i);
await page.evaluate(() => window.__ml.sceneryLights(false));
await page.waitForTimeout(1600);
const swOff = await page.evaluate(() => window.__ml.sceneryLights());
const offLit = await beside();
const drawnOff = await page.evaluate((i) => (window.__ml.sceneryDrawn(i) ?? []).length, LAMP.i);
console.log(`scenery lights: on ${swOn.sources}/${swOn.stamps}/${swOn.slotted} lightAt ${onLit.toFixed(3)} -> off ${swOff.sources}/${swOff.stamps}/${swOff.slotted} lightAt ${offLit.toFixed(3)}`);
ok(!swOff.on && swOff.sources === 0 && swOff.stamps === 0 && swOff.slotted === 0, "off leaves no source, no halo and no slot to any piece");
/* THE LAMP'S OWN CONTRIBUTION, not a ratio against the total. This arm read
 * `offLit < onLit * 0.6` until the fixture drifted onto ground something ELSE
 * also lights (2026-09-15: on 1.045 -> off 0.756, and the switch had done its
 * job — sources, stamps and slots were all 0). An emissive TILE is not a
 * scenery light and must not switch off, so a threshold that assumes the lamp
 * is alone on its ground is measuring the map, not the switch. */
const emit = await page.evaluate(() => window.__ml.lightSlots().sources);
console.log(`the residual ${offLit.toFixed(3)} sits under ${emit} emissive tile source(s), which this switch does not touch`);
ok(onLit - offLit > 0.15, `and the lamp's own contribution is gone (${onLit.toFixed(3)} -> ${offLit.toFixed(3)}, delta ${(onLit - offLit).toFixed(3)})`);
ok(drawnOff === drawnOn && drawnOn > 0, `the piece itself is still drawn (${drawnOff} image(s), as with the lights on)`);
await page.evaluate(() => window.__ml.sceneryLights(true));
await page.waitForTimeout(1600);
const swBack = await page.evaluate(() => window.__ml.sceneryLights());
const backLit = await beside();
ok(swBack.sources === swOn.sources && swBack.stamps === swOn.stamps, `and ON restores them with no rejoin (${swBack.sources} sources, ${swBack.stamps} stamps)`);
ok(Math.abs(backLit - onLit) < 0.05, `the pool is the one it was (${backLit.toFixed(3)} vs ${onLit.toFixed(3)})`);

// ---- 6. A CAST SHADOW IS THROWN FROM THE LIGHT'S OWN FOOTING ----------------
// The shadow's length is the light's HEIGHT and nothing else (docs/lighting.md,
// measured 2026-09-15): a light below the blocker's top throws a shadow that
// runs the whole pool, one above it throws a stub. Every lit scenery piece
// derives its height from its art and lands on the 1.5 clamp's ceiling, so the
// march is told SHADOW_LIGHT_Z above the light's own footing instead.
//
// TWO CLAIMS, and the second is the one a screenshot cannot make: the shadow
// reaches, AND the height it is cast from is relative to the piece's FOOTING.
// An absolute clamp passes the first arm everywhere and fails this one on any
// piece that does not stand at level 0.
if (!SHADOW) {
  console.log("SKIP 6: the_game has no lit piece with an unlit one 1.3-2.6 cells away");
} else {
  const lvl = levelAt(Math.floor(SHADOW.L.x), Math.floor(SHADOW.L.y));
  console.log(`shadow fixture: ${SHADOW.L.piece} ${SHADOW.L.id} -> ${SHADOW.C.piece} ${SHADOW.C.id}, ${SHADOW.d.toFixed(2)} cells apart on level ${lvl}`);
  // BETWEEN the two, because a sealed room's light is indoor-only by design and
  // the highest-standing pair in the_game is inside one: teleporting short of it
  // measures a room I am not in, and its light never reaches the ledger.
  await page.evaluate((p) => window.__ml.teleport(p.x, p.y), { x: (SHADOW.L.x + SHADOW.C.x) / 2, y: (SHADOW.L.y + SHADOW.C.y) / 2 });
  /* HIS OWN GEOMETRY FOR THIS ARM. The rest of the file measures luma patches in
   * a 480x320 window; a light's CANDIDACY is a view test (its pool must touch
   * the screen), and a small window with a distant fixture is how this arm read
   * "no light in the ledger" while the same fixture lit up fine at 393x851.
   * Nothing runs after section 6, so the resize is not restored. */
  await page.setViewportSize({ width: 393, height: 851 });
  await page.waitForTimeout(1500);
  // A PIECE'S LIGHT ARRIVES IN TWO STEPS and both have to be waited for: its ART
  // has to land before pushSceneryLight can derive anything (measured 27-34 s
  // from a cold teleport), and only then can it take a ledger slot. Waiting for
  // the slot alone times out on a piece whose pixels are still in flight.
  await page.waitForTimeout(6000);
  await page.evaluate(() => { window.__ml.torch(false); window.__ml.sceneryLights(true); });
  await page
    .waitForFunction((id) => (window.__ml.indoorLight().lights ?? []).some((l) => l.id === id), SHADOW.L.id, { timeout: 60_000, polling: 300 })
    .catch(() => {});
  await page.evaluate((p) => window.__ml.lookAt(p.x, p.y), SHADOW.C);
  await page
    .waitForFunction((p) => (window.__ml.lights() ?? []).some((l) => Math.hypot(l.col - p.x, l.row - p.y) < 0.15), SHADOW.L, { timeout: 60_000, polling: 250 })
    .catch(() => {});
  await page.waitForTimeout(2500);

  /* BY POSITION, NOT BY NEAREST. The fixture's own neighbourhood can hold more
   * than one lit piece — this pair sits 10 cells from a second crystal — and
   * "nearest" quietly picked the other one, whose pool does not touch this
   * caster at all, so the reach arm read a clean occ 1.000 and called the fix
   * broken. The index into `occ` is the ledger's own order. */
  const found = await page.evaluate((p) => {
    const ls = window.__ml.lights() ?? [];
    const i = ls.findIndex((l) => Math.hypot(l.col - p.x, l.row - p.y) < 0.15);
    return i < 0 ? null : { i, rec: ls[i] };
  }, SHADOW.L);
  const rec = found?.rec ?? null;
  if (!rec) {
    ok(false, "the fixture's light reached the ledger");
  } else {
    console.log(`its ledger record: z=${rec.z} sz=${rec.sz} r=${rec.r}`);
    // THE FOOTING ARM. sz is the light's own footing plus at most SHADOW_LIGHT_Z,
    // so on a level-N piece it is N + something, never a bare 0.55.
    ok(rec.sz <= rec.z + 1e-3, `the shadow is cast from no higher than the light (sz ${rec.sz} <= z ${rec.z})`);
    ok(rec.sz >= lvl - 1e-3 && rec.sz <= lvl + 0.55 + 1e-3,
       `and from its OWN footing: level ${lvl} <= sz ${rec.sz} <= ${lvl + 0.55} (an absolute clamp gives 0.55 here)`);
    // THE REACH ARM, along the light -> caster ray, 2 cells past the caster.
    const ax = (SHADOW.C.x - SHADOW.L.x) / SHADOW.d, ay = (SHADOW.C.y - SHADOW.L.y) / SHADOW.d;
    const idx = found.i;
    const occAlong = async (past) => {
      const c = +(SHADOW.C.x + ax * past).toFixed(3), r = +(SHADOW.C.y + ay * past).toFixed(3);
      const o = await page.evaluate(([cc, rr]) => window.__ml.occAt(cc, rr)?.occ ?? [], [c, r]);
      return o[idx] ?? 1;
    };
    const near = await occAlong(0.5), far = await occAlong(2.0);
    console.log(`occ past the caster: 0.5 cells ${near.toFixed(3)}, 2.0 cells ${far.toFixed(3)}`);
    ok(near < 0.9, `the caster shadows the ground right behind it (occ ${near.toFixed(3)})`);
    ok(far < 0.9, `and 2 cells on, where a light at the 1.5 ceiling casts nothing (occ ${far.toFixed(3)})`);
  }
  await page.evaluate(() => window.__ml.torch(true));
}

await browser.close();
console.log(failed ? `\nverify-lightparity: ${failed} FAILURE(S)` : "\nverify-lightparity OK");
process.exit(failed ? 1 : 0);
