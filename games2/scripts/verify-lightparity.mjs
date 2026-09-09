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
// lit piece is `s3:<index into scenery[]>` in the ledger (scenery3.ts). Today
// that resolves to streetlight_013 three cells west of the spawn house, its
// twin on the east road, and hearth_901 inside the town's first parquet room.
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
// The lit piece nearest spawn: the lamp a new player sees first.
const LAMP = lit.slice().sort((a, b) => d2(a, { x: SPAWN_C, y: SPAWN_R }) - d2(b, { x: SPAWN_C, y: SPAWN_R }))[0];
// Its twin: the nearest other placement of the SAME piece (same art → same
// derived light), far enough away that the two pools do not overlap.
const LAMP2 = lit
  .filter((p) => p !== LAMP && p.piece === LAMP.piece && d2(p, LAMP) >= 10)
  .sort((a, b) => d2(a, LAMP) - d2(b, LAMP))[0];
// The lit piece standing on a ROOM cell (world.json `rooms`): a sealed light.
const roomCells = world.rooms.map((rm) => new Set(rm.cells.map((c) => `${c.x},${c.y}`)));
const HEARTH = lit.find((p) => roomCells.some((s) => s.has(`${Math.floor(p.x)},${Math.floor(p.y)}`)));
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
const plainNear = (cx, cy, R = 25) => {
  let best = null;
  for (let r = Math.max(0, cy - R); r <= Math.min(world.size.h - 1, cy + R); r++)
    for (let c = Math.max(0, cx - R); c <= Math.min(world.size.w - 1, cx + R); c++) {
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
const SWEEP = lit
  .map((p) => ({ p, n: lit.filter((q) => d2(p, q) <= 6).length }))
  .sort((a, b) => b.n - a.n)
  .reduce((acc, { p }) => (acc.some((q) => d2(p, q) < 10) ? acc : [...acc, p]), [])
  .slice(0, 6);
console.log(
  `fixtures: lamp ${LAMP.id} ${LAMP.piece} @${LAMP.x.toFixed(1)},${LAMP.y.toFixed(1)}; twin ${LAMP2?.id ?? "none"}; ` +
  `hearth ${HEARTH.id} ${HEARTH.piece} @${HEARTH.x.toFixed(1)},${HEARTH.y.toFixed(1)} (roof level ${ROOF.level}); ` +
  `outside ${OUTSIDE.x},${OUTSIDE.y}; plain ${FAR_LAMP.x},${FAR_LAMP.y} (${FAR_LAMP.d.toFixed(1)} cells from any light)`,
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
const lampR2 = lumRing(lampShot, CX, CY, ringPx(2.2));
const lampR4 = lumRing(lampShot, CX, CY, ringPx(4));
// "The lamp's ground is LIT": the CPU light twin (the very sample lit copies
// tint by), 2 cells from the lamp vs plain night ground far from every source —
// pixels near the screen edge hit HUD chips, this cannot.
const lit2 = await page.evaluate((p) => window.__ml.lightAt(p.x + 2, p.y + 1), LAMP);
const litFar = await page.evaluate((p) => window.__ml.lightAt(p.x, p.y), FAR_LAMP);
console.log(`luma: lamp r2.2=${lampR2.toFixed(1)} r4=${lampR4.toFixed(1)} | lightAt near=${mag(lit2).toFixed(3)} far=${mag(litFar).toFixed(3)}`);
ok(mag(lit2) > mag(litFar) * 2.2, `the lamp's ground is LIT (lightAt ${mag(lit2).toFixed(3)} vs far ${mag(litFar).toFixed(3)})`);
ok(lampR2 > lampR4, `the pool falls off with distance on real pixels (r2.2 ${lampR2.toFixed(1)} > r4 ${lampR4.toFixed(1)})`);

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
  const twinR2 = lumRing(twinShot, CX, CY, ringPx(2.2));
  const twinR4 = lumRing(twinShot, CX, CY, ringPx(4));
  const par2 = twinR2 / Math.max(1, lampR2);
  const par4 = twinR4 / Math.max(1, lampR4);
  console.log(`luma: twin r2.2=${twinR2.toFixed(1)} r4=${twinR4.toFixed(1)}`);
  ok(par2 > 0.5 && par2 < 2.0, `parity at 2.2 cells: twin/lamp = ${par2.toFixed(2)}`);
  ok(par4 > 0.5 && par4 < 2.0, `parity at 4 cells: twin/lamp = ${par4.toFixed(2)}`);
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
