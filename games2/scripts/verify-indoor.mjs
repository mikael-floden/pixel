// INDOOR MODE gate (maintainer 2026-08-06, verbatim):
//
//   "we should automatically detect when a player walks into a house/cave etc...
//    The game does this by removing the roof and everything over the roof. The
//    game also renders everything outside the house (not under the roof) black,
//    but we have to still be able to show the walls facing the inside of the
//    house/cave, but only the part that faces the inside. Not the entire tile."
//   "The lighting indoors (inside any building/cave) is always dark as during
//    the night, but with a less 'blue moonlight ambient' tone. It's up to each
//    individual room to place lights."
//   "It's also important to re-enable the players torch even if it's day/sun
//    outside (the torch is disabled during daytime I think)."
//
// Everything below is asserted on REAL PIXELS and REAL probe state, never on
// the renderer's own arithmetic: the same camera frames the_island2's house
// from outside and from within, and the two screenshots are compared at points
// derived from maps2' world.json (deck footprint + terrain levels) — so a
// re-authored house moves the samples with it instead of silently passing.
//
// THE HOUSE (maps2/worlds/the_island2, deck kind "roof", level 6, thickness 0):
// a 6x5 footprint of level-6 stone walls around a 4x3 level-0 floor with one
// doorway at (201,117). 13 cells under the roof, 14 fringe, 1 entrance,
// wallRatio 0.9286 — the smallest true interior any shipped world has, and the
// one the maintainer actually stood in.
//
// WHY SOME ASSERTIONS ARE PER-POINT AND SOME ARE AGGREGATE: the far walls are
// 6 levels = 96px tall and are drawn hanging DOWN from the ceiling plane, which
// is exactly the screen band the roof slab occupied. So most ceiling points sit
// behind a (legitimately drawn) wall face and cannot be "pure black" — the roof
// test is therefore "every sampled roof cell got much darker AND a large share
// of those pixels are pure void", which is what "the roof is removed" actually
// looks like on screen. The 32px wall cut has the same problem in x: wall cells
// are one iso step (32px, 15px) apart, so a mid-run cell's OUTWARD half is its
// neighbour's own INWARD half. It is answered with two counter-samples per
// wall — one on the tile TOP's row (free above the next cell's stack) and one
// deep in the face stack (free only at a run's END) — each skipped when another
// wall's drawn rectangle provably covers it. That skip is COMPUTED from the
// cells' own screen boxes, never hand-listed.
//
// AND WHY "IS IT BLACK?" IS ALWAYS A MEDIAN: a few decor layers still paint
// over the void — the ambient agent's fireflies/birds/bats (games2/ambient/,
// another agent's files), footstep marks, grave crosses, weather particles.
// They are scattered single pixels; a terrain tile that escaped the cull is a
// solid diamond filling the patch. A median separates the two; a peak does not.
//
// Needs the dev stack (vite :5173 + colyseus :2567).
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const here = dirname(fileURLToPath(import.meta.url));
const world = JSON.parse(
  readFileSync(join(here, "..", "..", "maps2", "worlds", "the_island2", "world.json"), "utf8"),
);
const fail = (m) => { throw new Error(m); };
// The dial's own maximum (indoorcut.ts INDOOR_CUT_MAX). The house ceiling is 6,
// so roof-5 leaves exactly ONE level of wall — the shallowest parapet the game
// can be asked for, and the far end of the sweep in 2e.
const INDOOR_CUT_MAX = 5;
const ok = (m) => console.log(`ok - ${m}`);
const X = (c) => c.col ?? c.x;
const Y = (c) => c.row ?? c.y;
const lvl = (c, r) => world.level?.[r]?.[c] ?? 0;

// ---------------------------------------------------------------------------
// GEOMETRY, derived from the world file exactly as shared/src/indoor.ts does
// ---------------------------------------------------------------------------
const roofDeck = (world.decks ?? []).find((d) => d.kind === "roof");
if (!roofDeck) fail("the_island2 ships no deck of kind 'roof' — the house is gone?");
const bridgeDeck = (world.decks ?? [])
  .filter((d) => d.kind === "bridge")
  .sort((a, b) => a.level - b.level || b.cells.length - a.cells.length)[0];
if (!bridgeDeck) fail("the_island2 ships no bridge deck");

const deckCells = roofDeck.cells.map((c) => [X(c), Y(c)]);
const key = (c, r) => `${c},${r}`;
// Under the roof = a deck cell whose own terrain sits below the slab: the floor
// you can stand on. The rest of the footprint is the wall ring.
const interior = deckCells.filter(([c, r]) => lvl(c, r) < roofDeck.level - 0.5);
const inSet = new Set(interior.map(([c, r]) => key(c, r)));
if (interior.length < 8) fail(`only ${interior.length} cells under the house roof — below MIN_ROOM_CELLS`);
// Fringe / entrances / the two FAR wall sets — indoor.ts's own rules, on an
// elev of 0 (the floor) with the module's ENTRANCE_CLIMB of 2.
const fringe = new Set();
for (const [c, r] of interior)
  for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
    if (!inSet.has(key(c + dc, r + dr))) fringe.add(key(c + dc, r + dr));
const isEntrance = (c, r) => Math.abs(lvl(c, r) - 0) <= 2;
const wallRight = []; // its (col+1,row) neighbour is interior -> RIGHT face looks in
const wallLeft = []; //  its (col,row+1) neighbour is interior -> LEFT  face looks in
for (const k of fringe) {
  const [c, r] = k.split(",").map(Number);
  if (isEntrance(c, r)) continue;
  if (inSet.has(key(c + 1, r))) wallRight.push([c, r]);
  if (inSet.has(key(c, r + 1))) wallLeft.push([c, r]);
}
if (!wallRight.length || !wallLeft.length) fail("no far walls derived from the house footprint");
// THE BUILDING — every solid cell of the enclosure, 8-connected, openings out.
// This is what the cut-away DRAWS (shared/src/indoor.ts `shell`), and deriving
// it here rather than trusting the client is the whole point of the gate: the
// two far-wall sets above cannot contain a corner or a T-junction, which is
// exactly the class of cell the old cull design left as a hole.
const building = [];
{
  const seen = new Set();
  for (const [c, r] of interior)
    for (let dc = -1; dc <= 1; dc++)
      for (let dr = -1; dr <= 1; dr++) {
        if (!dc && !dr) continue;
        const nc = c + dc;
        const nr = r + dr;
        const k = key(nc, nr);
        if (seen.has(k) || inSet.has(k) || isEntrance(nc, nr)) continue;
        seen.add(k);
        building.push([nc, nr]);
      }
}
if (building.length <= wallRight.length + wallLeft.length)
  fail(`the derived building (${building.length}) has no corners beyond the far walls — the derivation is wrong`);
const doorway = [...fringe].map((k) => k.split(",").map(Number)).filter(([c, r]) => isEntrance(c, r));
const roomC = Math.round(interior.reduce((a, [c]) => a + c, 0) / interior.length);
const roomR = Math.round(interior.reduce((a, [, r]) => a + r, 0) / interior.length);
// Somewhere outdoors, well clear of the house, with the house still in frame.
const OUTSIDE_SPOT = [roomC + 0.5, Math.max(...deckCells.map(([, r]) => r)) + 6.5];
// A cell far from every light source: the ambient probe reads the light field
// there, so it must be nothing but ambient.
const FAR_CELL = [160, 200];

console.log(
  `house: ${deckCells.length} deck cells, ${interior.length} under the roof, ` +
  `${fringe.size} fringe, ${doorway.length} entrance(s), ` +
  `${wallLeft.length} wallLeft + ${wallRight.length} wallRight; room centre ${roomC},${roomR}`,
);

// ---------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  // 520 css px wide keeps WorldScene.zoomFor() on zoom 1, which fits the whole
  // house (352x230 world px) in one frame; 800 tall gives the 61.8% game view
  // enough height for the roof plane 96px above the floor.
  const ctx = await browser.newContext({ viewport: { width: 520, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 160)));

  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  const idx = await page.evaluate(() => window.__mlSelect.worlds().findIndex((w) => /the_island2/i.test(w)));
  if (idx < 0) fail("the_island2 missing from the picker");
  await page.evaluate((i) => { window.__mlSelect.pickWorld(i); window.__mlSelect.commit(); }, idx);
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 40000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 25000 });
  await page.bringToFront();
  if (!(await page.evaluate(() => typeof window.__ml.indoor === "function")))
    fail("no __ml.indoor() probe — the indoor renderer is not in this build");
  // Full daylight, no sky effects: every assertion below is about DAY.
  // Freeze the SHARED world clock first: with it running the server's phaseT
  // patches overwrite the pinned Day keyframe within a frame or two.
  await page.evaluate(() => window.__ml.timeSpeed(0));
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.__ml.timeOfDay("Day", true); window.__ml.aurora(false, true); window.__ml.weather(0, true); });
  await page.waitForTimeout(600);
  ok("joined the_island2 at Day, clear sky, world clock frozen");

  // ---- helpers ------------------------------------------------------------
  // SHOT_DIR=<dir> keeps every frame this gate judges, which is the fastest way
  // to see WHY a pixel assertion moved.
  const shoot = async (name) => {
    const buf = await page.screenshot();
    if (process.env.SHOT_DIR) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(process.env.SHOT_DIR, `indoor-${name}.png`), buf);
    }
    return PNG.sync.read(buf);
  };
  // Mean / peak / pure-void fraction of a square of real pixels. "Pure void" is
  // luminance < 1: the ground RT fills black and the light overlay MULTIPLIES,
  // so anything the renderer skipped stays exactly 0 whatever the hour.
  // The MEDIAN is the load-bearing statistic for "is this pixel void?": a few
  // stray bright pixels drift across the black — the ambient agent's birds /
  // bats / fireflies (games2/ambient/, another agent's directory), footstep
  // marks, grave crosses and weather particles all still draw over it, and
  // none of them is this feature's to gate. They are scattered SINGLE pixels;
  // a terrain tile that escaped the cull is a solid diamond that fills the
  // whole patch, which is exactly what a median catches and a peak does not.
  const patch = (img, x, y, r) => {
    let max = -1, sum = 0, n = 0, black = 0;
    const all = [];
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const px = Math.round(x + dx), py = Math.round(y + dy);
        if (px < 0 || py < 0 || px >= img.width || py >= img.height) return null;
        const i = (py * img.width + px) * 4;
        const l = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
        max = Math.max(max, l); sum += l; n++; all.push(l); if (l < 1) black++;
      }
    all.sort((a, b) => a - b);
    return { max, mean: sum / n, black: black / n, med: all[all.length >> 1] };
  };
  const cellScreen = async (c, r) => {
    const s = await page.evaluate(([c, r]) => window.__ml.cellScreen(c, r), [c, r]);
    if (!s) fail(`cellScreen(${c},${r}) returned null — off the map?`);
    return s;
  };
  // Wait for the renderer to actually be in the state we asked for. `mix` is the
  // eased LIGHT blend (geometry snaps); only the lighting assertions need it
  // settled, and headless GL starves the frame loop badly enough that the 0.35s
  // roll takes ~10s of wall clock.
  const settle = async (want, needMix, timeout = 60000) => {
    return page.waitForFunction(
      ([w, m]) => {
        if (typeof window.__ml?.indoor !== "function") return false;
        const d = window.__ml.indoor();
        return d.indoor === w && (!m || (w ? d.mix > 0.99 : d.mix < 0.01));
      },
      [want, !!needMix],
      { timeout, polling: 200 },
    ).then(() => true).catch(() => false);
  };
  // The teleport is server-authoritative and the room is SHARED with whatever
  // else is on the dev stack, so a single send can be swallowed (the server
  // ignores it outright while the player is dead — a monster near spawn is
  // enough). Re-send until the position lands.
  const goTo = async (col, row) => {
    for (let n = 0; n < 6; n++) {
      await page.evaluate(([c, r]) => { const m = window.__ml.me(); if (m?.dead) window.__ml.roomSend("respawn", {}); window.__ml.teleport(c, r); }, [col, row]);
      const there = await page.waitForFunction(
        ([c, r]) => { const m = window.__ml?.me?.(); return !!m && Math.abs(m.x / 32 - c) < 0.6 && Math.abs(m.y / 32 - r) < 0.6; },
        [col, row], { timeout: 6000, polling: 100 },
      ).then(() => true).catch(() => false);
      if (there) return;
    }
    fail(`teleport to ${col},${row} never took: ${JSON.stringify(await page.evaluate(() => window.__ml.me()))}`);
  };
  const stand = async (col, row, want, needMix) => {
    // Re-teleport if the verdict stalls: a fresh teleport calls the renderer's
    // own indoorSnap(), which forces the next verdict and re-bases the light
    // blend — the one lever a probe has when a shared, live room leaves the
    // local body out of step.
    for (let n = 0; ; n++) {
      await goTo(col, row);
      if (await settle(want, needMix, 25000)) break;
      if (n >= 2)
        fail(`never settled to indoor=${want}${needMix ? " (mix)" : ""}: ${JSON.stringify(await page.evaluate(() => window.__ml.indoor()))}`);
    }
    // One fixed camera for every screenshot, so the two pictures are comparable
    // pixel for pixel. lookAt detaches the chase cam; teleport re-attaches it,
    // so this has to come after the move.
    await page.evaluate(([c, r]) => window.__ml.lookAt(c, r), [roomC, roomR]);
    await page.waitForTimeout(700);
  };
  const lightAt = async (c, r, z = 0) => page.evaluate(([c, r, z]) => window.__ml.lightAtCell(c, r, z), [c, r, z]);
  const luma = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  const fx = (v) => v.map((n) => +n.toFixed(4)).join(", ");

  // Sample points, in the tile art's own frame (a 64x64 box whose top diamond
  // has its apex at y=8 and its W/E corners at y=23; the 16px skirt runs to
  // y=54; x<32 is the LEFT drawn face, x>=32 the RIGHT one).
  //   ROOF  — the deck's top diamond. Cells whose own terrain is at roof level
  //           (the wall ring) already have cellScreen at that plane; a level-0
  //           floor cell's slab is 6 levels = 96px above it. x+38 rather than
  //           the diamond centre keeps the sample off the 32px boundary between
  //           two drawn wall halves.
  //
  // The LOCAL player is never hidden indoors (they are the one standing in the
  // room), so their body, name label and debug coordinate lines cover part of
  // both the floor and the ceiling plane. Every sample set drops the points
  // inside that art box — measured against Phaser's own screen anchor for the
  // avatar, not guessed from cells.
  // The drawable rectangle: the game view is the top 61.8% of the page, and the
  // DOM HUD below it is bright cream — a sample that slid off the canvas would
  // read "not black" for reasons that have nothing to do with indoor mode.
  const gv = await page.evaluate(() => {
    const e = document.getElementById("game") || document.querySelector("canvas");
    const b = e.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  const inView = (p) => {
    const r = (p.rad ?? 3) + 1;
    return p.x - r >= gv.x && p.x + r <= gv.x + gv.w && p.y - r >= gv.y && p.y + r <= gv.y + gv.h;
  };
  const avatarBox = async () => page.evaluate(() => window.__ml.myScreen());
  const covered = (me, x, y) => !!me && Math.abs(x - me.sx) < 60 && y - me.sy < 70 && me.sy - y < 110;
  const roofPoints = async (me, min = deckCells.length / 2) => {
    const out = [];
    for (const [c, r] of deckCells) {
      const s = await cellScreen(c, r);
      const x = s.x + 38, y = s.y + 23 - (roofDeck.level - s.level) * 16;
      if (covered(me, x, y)) continue;
      const pt = { c, r, x, y };
      if (inView(pt)) out.push(pt);
    }
    // Standing ON the slab the avatar's feet are IN the ceiling plane, so its
    // art box eats a bigger share of it — hence the caller-supplied minimum.
    if (out.length < min) fail(`only ${out.length} of ${deckCells.length} ceiling cells are sampleable (needed ${min}) — check the camera/zoom`);
    return out;
  };
  //   FLOOR — the interior ground, minus the cells the avatar's own body covers.
  const floorPoints = async (me) => {
    const out = [];
    for (const [c, r] of interior) {
      const s = await cellScreen(c, r);
      const x = s.x + 32, y = s.y + 23;
      if (covered(me, x, y)) continue;
      const pt = { c, r, x, y };
      if (inView(pt)) out.push(pt);
    }
    if (out.length < 4) fail("the avatar covers almost the whole floor — nothing left to sample");
    return out;
  };
  //   OUTSIDE — ground well clear of the house on all four screen sides.
  //
  // "Clear of the house" is COMPUTED, not assumed by a fixed offset. A house
  // cell is a COLUMN: its art runs from `roofDeck.level` levels up (16px each)
  // down to its own base plus a 64px tile, so it paints far UP-SCREEN of the
  // cell it belongs to. A fixed -2/+3 offset put one probe squarely behind the
  // west corner's 6-level wall, and once `shell` started drawing that corner
  // (it is the building, and leaving it out is the hole this gate exists
  // beside) the probe read the WALL and called it undead outside ground.
  //
  // Screen algebra, from MAP_GEOMETRY: a cell's art spans x [(c-r)*32, +64] and
  // y [(c+r)*15 - lvl*16, +64]; the 17x17 patch spans x [(c-r)*32+24, +16] and
  // y [(c+r)*15+15, +16]. They overlap iff the two cells are within 1 of each
  // other in (c-r) AND the house cell's (c+r) is between 3 below and
  // (31 + cut*16)/15 above the probe's. So step the probe outward along its own
  // direction until nothing in the house can reach it.
  const cut = roofDeck.level;
  const behindHouse = (c, r) =>
    deckCells.some(([hc, hr]) =>
      Math.abs(hc - hr - (c - r)) <= 1 &&
      hc + hr - (c + r) <= (31 + cut * 16) / 15 &&
      c + r - (hc + hr) <= 49 / 15);
  const outsidePoints = async () => {
    const minC = Math.min(...deckCells.map(([c]) => c));
    const maxC = Math.max(...deckCells.map(([c]) => c));
    const minR = Math.min(...deckCells.map(([, r]) => r));
    const maxR = Math.max(...deckCells.map(([, r]) => r));
    // [start cell, step] — the step walks the probe further from the house.
    const cs = [
      [[minC - 2, roomR], [-1, 0]],
      [[maxC + 2, roomR], [1, 0]],
      [[roomC, minR - 3], [0, -1]],
      [[roomC, maxR + 3], [0, 1]],
      [[maxC + 2, roomR + 3], [1, 0]],
    ];
    const out = [];
    // A WIDE patch (17x17) on purpose: the ambient layer's fireflies are ~5x5
    // glowing sprites and a small window lets one of them swing the median.
    for (const [[c0, r0], [dc, dr]] of cs) {
      let c = c0;
      let r = r0;
      // 12 steps is far more than any wall can reach (8 in (c+r), 1 in (c-r));
      // running out means the house is not where deckCells says it is.
      let n = 0;
      while (behindHouse(c, r) && n++ < 12) { c += dc; r += dr; }
      if (behindHouse(c, r)) fail(`no outdoor sample clear of the house from ${c0},${r0}`);
      const s = await cellScreen(c, r);
      const pt = { c, r, rad: 8, x: s.x + 32, y: s.y + 23 };
      if (inView(pt)) out.push(pt);
    }
    if (out.length < 4) fail(`only ${out.length} outdoor sample cells are on screen — the house no longer fits the frame`);
    return out;
  };
  //   WALL faces, one level down the face stack (y+39). These are an OUTDOOR
  //   control only: they prove the reference picture really shows a solid house
  //   before anything is compared against it. What the indoor frame must show
  //   is asserted in 2c, over the whole building rather than these two sets —
  //   wallLeft/wallRight cannot contain a corner, and corners were the bug.
  const wallFacePoints = async () => {
    const out = [];
    for (const [c, r] of wallRight) { const s = await cellScreen(c, r); out.push({ c, r, side: "R", x: s.x + 48, y: s.y + 39 }); }
    for (const [c, r] of wallLeft) { const s = await cellScreen(c, r); out.push({ c, r, side: "L", x: s.x + 16, y: s.y + 39 }); }
    const off = out.filter((p) => !inView(p));
    if (off.length) fail(`wall samples off screen at ${off.map((p) => `${p.c},${p.r}`).join(" ")} — the house no longer fits the frame`);
    return out;
  };

  // =========================================================================
  // 1. OUTDOORS — the reference picture: the house is a solid closed box.
  // =========================================================================
  // The camera is pinned to the room for BOTH pictures, so one set of sample
  // points reads them both; they are picked in section 2, where the avatar is
  // standing where it will be in the indoor shot.
  await stand(OUTSIDE_SPOT[0], OUTSIDE_SPOT[1], false, true);
  const outShot = await shoot("outside");
  // Read the outline's state while we are out here in the open — it is the
  // control 2e needs and this is the only moment the gate stands clear of
  // everything (see the zero assertion there).
  const outsideCover = await page.evaluate(() => window.__ml.myCover());
  ok(`outdoors reference frame captured from ${OUTSIDE_SPOT[0]},${OUTSIDE_SPOT[1]} (camera pinned on ${roomC},${roomR})`);

  // =========================================================================
  // 2. INDOORS — stand under the roof.
  // =========================================================================
  await stand(roomC + 0.5, roomR + 0.5, true, true);
  const inn = await page.evaluate(() => window.__ml.indoor());
  if (!inn.indoor) fail(`standing at ${roomC},${roomR} is not indoors: ${JSON.stringify(inn)}`);
  if (inn.roofLevel !== roofDeck.level) fail(`roofLevel ${inn.roofLevel} != the deck's ${roofDeck.level}`);
  if (inn.roof !== interior.length) fail(`${inn.roof} cells under the roof, world.json says ${interior.length}`);
  // The two far-wall sets are DETECTOR output that the renderer no longer reads
  // (the cut-away draws the whole enclosure); still checked, because they are
  // the one part of the module whose screen-space mapping is easy to invert.
  if (inn.wallLeft !== wallLeft.length || inn.wallRight !== wallRight.length)
    fail(`wall sets ${inn.wallLeft}/${inn.wallRight} != the world's ${wallLeft.length}/${wallRight.length}`);
  if (inn.capped) fail("the roof fill was capped — indoor must fail OUTDOORS in that case");
  // THE MASK IS THE BUILDING: floor + enclosure, exactly, with nothing left out.
  // A cell missing here is a cell the renderer draws NOTHING for — a black
  // wedge through a solid house, which is what the cull design shipped.
  if (inn.shell !== building.length)
    fail(`the client's shell is ${inn.shell} cells, the world's building is ${building.length}`);
  if (inn.mask !== interior.length + building.length)
    fail(`the mask is ${inn.mask}, should be floor ${interior.length} + building ${building.length}`);
  ok(`indoors: roof ${inn.roof} cells at level ${inn.roofLevel}, wallRatio ${inn.wallRatio}, depth ${inn.depth}, ` +
    `ceiling ${inn.ceiling}, cut to level ${inn.top}; the mask is exactly floor ${interior.length} + building ${building.length}`);

  // Sample points are picked HERE, with the avatar standing where it will be in
  // the indoor screenshot; the camera has not moved, so they read both frames.
  const me = await avatarBox();
  const roofP = await roofPoints(me);
  const floorP = await floorPoints(me);
  const outsideP = await outsidePoints();
  const wallP = await wallFacePoints();
  const measure = (img, pts) => pts.map((p) => {
    const s = patch(img, p.x, p.y, p.rad ?? 3);
    if (!s) fail(`sample for ${p.c},${p.r} fell off the ${img.width}x${img.height} screen — camera/zoom changed?`);
    return { ...p, ...s };
  });
  const roofOut = measure(outShot, roofP);
  const outsideOut = measure(outShot, outsideP);
  const wallOut = measure(outShot, wallP);
  // Medians again, and for a second reason: the world is SHARED and alive —
  // an NPC, a monster or a bird can stand in front of the house while the
  // reference frame is taken. A body covering part of a patch cannot drag a
  // median to zero; only a missing slab can.
  const dark = roofOut.filter((s) => s.med < 25);
  if (dark.length)
    fail(`the roof slab does not read as solid art from outside at ${dark.map((d) => `${d.c},${d.r}`).join(" ")} — the reference picture is wrong`);
  const roofOutMean = roofOut.reduce((a, s) => a + s.med, 0) / roofOut.length;
  if (outsideOut.some((s) => s.black > 0.02)) fail("outdoor ground already reads black in the reference shot");
  if (wallOut.some((s) => s.mean < 30)) fail("wall faces are not drawn in the reference shot");
  ok(`outdoors the house is a solid closed box: ${roofOut.length} roof samples at median luminance ${roofOutMean.toFixed(1)}, ` +
    `none of them void`);
  const inShot = await shoot("inside");

  // -- 2a. THE ROOF IS GONE -------------------------------------------------
  // GEOMETRY, NOT BRIGHTNESS. This used to be a luminance-DROP ratio ("every
  // ceiling-plane sample lost >40%"), which worked only while the interior was
  // nearly black: the samples sit at the ceiling PLANE, and once the walls are
  // cut short some of those screen points land on a legitimately drawn wall
  // top instead of on void. At the tuned-dark grade that wall read ~3 and the
  // ratio passed by accident; at the maintainer's 40% it reads ~44 and the
  // same picture "failed". A test that flips when someone moves a brightness
  // slider is not testing the roof.
  //
  // So: a ceiling-plane sample must be PURE VOID unless some drawn column can
  // actually reach it. What a column reaches is computable — every cell of the
  // building draws up to min(level, top) and its art is 64px tall — so the
  // exceptions are DERIVED here, exactly as the outside probes derive their
  // clearance, and never hand-listed.
  const roofIn = measure(inShot, roofP);
  const drawnBoxes = [];
  for (const [c, r] of [...interior, ...building]) {
    const sc = await cellScreen(c, r);
    const t = Math.min(sc.level, inn.top);
    drawnBoxes.push({ x0: sc.x, x1: sc.x + 64, y0: sc.y + (sc.level - t) * 16, y1: sc.y + sc.level * 16 + 64 });
  }
  const reached = (p) => drawnBoxes.some((b) => p.x >= b.x0 - 3 && p.x <= b.x1 + 3 && p.y >= b.y0 - 3 && p.y <= b.y1 + 3);
  const answerable = roofIn.filter((p) => !reached(p));
  const kept = answerable.filter((s) => s.med >= 1);
  if (kept.length)
    fail(`roof art survived at ${kept.map((s) => `${s.c},${s.r} (median ${s.med.toFixed(0)}, ${(s.black * 100).toFixed(0)}% void)`).join("; ")} — ` +
      `nothing the building draws can reach that point, so the slab is still being painted`);
  if (answerable.length < roofIn.length / 3)
    fail(`the roof test went vacuous: only ${answerable.length} of ${roofIn.length} ceiling-plane samples are clear of the cut-away's own art`);
  const voidFrac = answerable.reduce((a, s) => a + s.black, 0) / answerable.length;
  if (voidFrac < 0.9)
    fail(`only ${(voidFrac * 100).toFixed(0)}% of the answerable ceiling-plane pixels are pure void — the slab is still there`);
  ok(`the roof is REMOVED: ${answerable.length} of ${roofIn.length} ceiling-plane samples are clear of everything the ` +
    `cut-away still draws, and every one of them is pure void (${(voidFrac * 100).toFixed(0)}% of their pixels; ` +
    `they read a median ${roofOutMean.toFixed(1)} from outside)`);

  // -- 2b. OUTSIDE IS BLACK, INSIDE IS NOT ----------------------------------
  // A GROUND TILE that escaped the cull fills its whole patch (0% void, mean
  // 5-10 at the indoor ambient), so the bar is per-patch coverage, not a peak.
  // It is 0.9 rather than 1.0 because a handful of decor layers still paint
  // over the void — the ambient agent's birds/bats/fireflies (games2/ambient/,
  // not this agent's to gate), footstep marks, grave crosses and weather
  // particles. Those are single scattered pixels; terrain is a solid diamond.
  const outsideIn = measure(inShot, outsideP);
  // MEDIAN only. A ground tile fills the whole 17x17 window (it reads 6-9 like
  // the interior floor does), so its median cannot be 0; a firefly, a bird or a
  // footstep mark covers a minority of it however bright it is.
  const lit = outsideIn.filter((s) => s.med >= 1);
  if (lit.length)
    fail(`ground outside the room is still drawn at ${lit.map((s) => `${s.c},${s.r} (median ${s.med.toFixed(1)}, mean ${s.mean.toFixed(1)}, ${(s.black * 100).toFixed(0)}% void)`).join("; ")}`);
  const outVoid = outsideIn.reduce((a, s) => a + s.black, 0) / outsideIn.length;
  ok(`everything outside the room is BLACK: ${outsideIn.length} sample patches, median luminance 0, ` +
    `${(outVoid * 100).toFixed(0)}% of their pixels pure void ` +
    `(they read ${outsideOut.map((s) => s.mean.toFixed(0)).join("/")} from outdoors)`);
  // The interior is judged on BRIGHTNESS, not on the void fraction: at an
  // ambient of ~0.09 the darkest pixels of the grass art quantize to 0, so a
  // real, drawn floor legitimately contains a few pure-black pixels. What it
  // cannot do is average zero — the void outside does exactly that.
  const floorIn = measure(inShot, floorP);
  const voidFloor = floorIn.filter((s) => s.mean < 2 || s.max < 5 || s.med < 1);
  if (voidFloor.length)
    fail(`the interior FLOOR reads black at ${voidFloor.map((s) => `${s.c},${s.r} (mean ${s.mean.toFixed(1)}, peak ${s.max.toFixed(1)})`).join("; ")} — the room was blacked out with the outside`);
  ok(`the interior is NOT black: all ${floorIn.length} floor cells clear of the avatar ` +
    `(${floorIn.map((s) => `${s.c},${s.r}`).join(" ")}) still carry ground art ` +
    `(mean ${Math.min(...floorIn.map((s) => s.mean)).toFixed(1)}-${Math.max(...floorIn.map((s) => s.mean)).toFixed(1)}, ` +
    `peak ${Math.max(...floorIn.map((s) => s.max)).toFixed(1)}, against 0.00 outside; the room is lit only by the torch, by design)`);

  // -- 2c. NO HOLES — every cell of the building draws something -----------
  // THE ASSERTION THE ORIGINAL BUG WAS THE ABSENCE OF. The cull design could
  // only draw cells with a camera-facing inward face, so a room's own corner
  // and every partition T-junction were drawn by nothing at all and read as
  // black wedges through a solid house (maintainer 2026-08-07: "floating
  // disconnected wall slabs"). The cut-away draws the whole enclosure, so
  // every one of these cells must carry art at its own drawn top.
  //
  // Sampled at the tile's diamond CENTRE (+32,+23) on the level the column was
  // truncated to, which is where that cell's cap tile is painted.
  const bldP = [];
  for (const [c, r] of building) {
    const sc = await cellScreen(c, r);
    const drawn = Math.min(sc.level, inn.top); // the cap band
    const pt = { c, r, x: sc.x + 32, y: sc.y + 23 + (sc.level - drawn) * 16 };
    if (inView(pt)) bldP.push(pt);
  }
  if (bldP.length < building.length - 2)
    fail(`only ${bldP.length} of ${building.length} building cells are on screen — the house no longer fits the frame`);
  const bldIn = measure(inShot, bldP);
  const holes = bldIn.filter((s) => s.med < 4);
  if (holes.length)
    fail(`HOLES in the building at ${holes.map((s) => `${s.c},${s.r} (median ${s.med.toFixed(1)}, ${(s.black * 100).toFixed(0)}% void)`).join("; ")} — ` +
      `a cell of the enclosure that nobody draws is a black wedge through the house`);
  ok(`the building is SOLID: all ${bldIn.length} enclosure cells — corners and T-junctions included — ` +
    `carry art at their cut top (median luminance ${Math.min(...bldIn.map((s) => s.med)).toFixed(1)}-${Math.max(...bldIn.map((s) => s.med)).toFixed(1)})`);

  // -- 2d. THE DIAL IS THE CUT ---------------------------------------------
  // The maintainer's actual requirement: "cut all walls at 'roof - 1',
  // 'roof - 2', etc. Even making this configurable in settings so I can test
  // what looks best." So the picture must MOVE, by exactly one level per step.
  //
  // Measured on a fixed screen column through a far-wall run: the topmost
  // non-void row there is the wall's crown, and one more level of cut lowers it
  // by exactly LEVEL_PX (16). Tolerance ±3 for the art's own diagonal top edge
  // landing on a different row of the same tile.
  const dialCol = await (async () => {
    const [c, r] = wallLeft[Math.floor(wallLeft.length / 2)];
    const sc = await cellScreen(c, r);
    return Math.round(sc.x + 32);
  })();
  const crownAt = (shot, x) => {
    for (let y = gv.y; y < gv.y + gv.h; y++) {
      const p = patch(shot, x, y, 1);
      if (p && p.med >= 4) return y;
    }
    return NaN;
  };
  const before = await page.evaluate(() => window.__ml.indoorCut());
  const crowns = [];
  for (const n of [1, 2, 3, 4]) {
    await page.evaluate((v) => window.__ml.indoorCut(v), n);
    await page.waitForTimeout(900);
    const shot = await shoot(`cut-${n}`);
    crowns.push({ n, y: crownAt(shot, dialCol), top: (await page.evaluate(() => window.__ml.indoorCut())).top });
  }
  await page.evaluate((v) => window.__ml.indoorCut(v), before.cut);
  await page.waitForTimeout(900);
  const bad = [];
  for (let i = 1; i < crowns.length; i++) {
    const d = crowns[i].y - crowns[i - 1].y;
    if (!Number.isFinite(d) || Math.abs(d - 16) > 3)
      bad.push(`roof-${crowns[i - 1].n} -> roof-${crowns[i].n}: crown moved ${Number.isFinite(d) ? d : "nothing"}px, want 16`);
    if (crowns[i].top !== crowns[i - 1].top - 1)
      bad.push(`roof-${crowns[i].n} resolved to top ${crowns[i].top}, one less than roof-${crowns[i - 1].n}'s ${crowns[i - 1].top} expected`);
  }
  if (bad.length) fail(`the Indoor wall cut dial does not move the picture: ${bad.join("; ")}`);
  ok(`the dial IS the cut: roof-1..4 lower the wall crown by exactly one level each ` +
    `(screen y ${crowns.map((c) => c.y).join(" -> ")}, resolved top ${crowns.map((c) => c.top).join(" -> ")}), restored to roof-${before.cut}`);

  // -- 2e. THE WHITE OUTLINE ON WHAT IS STILL HIDDEN -----------------------
  // The other half of the maintainer's design: "a white pixel outline on parts
  // being behind something". A cut-away without it just loses the body's legs
  // behind the parapet — so the outline must appear exactly when, and to the
  // extent that, a wall really covers them.
  //
  // Asserted as a MONOTONE RESPONSE to the dial rather than one magic number:
  // a taller parapet must hide MORE of the figure, and a cut that removes the
  // walls entirely must hide NONE. Nothing stuck on, stuck off, or keyed to
  // anything but real geometry can satisfy both ends.
  const hid = [];
  for (const n of [1, 3, INDOOR_CUT_MAX]) {
    await page.evaluate((v) => window.__ml.indoorCut(v), n);
    await page.waitForTimeout(900);
    const c = await page.evaluate(() => window.__ml.myCover());
    const got = await page.evaluate(() => window.__ml.indoorCut().cut);
    if (got !== n) fail(`the dial refused roof-${n} (clamped to roof-${got}) — INDOOR_CUT_MAX and this gate disagree`);
    hid.push({ n, ...c });
  }
  await page.evaluate((v) => window.__ml.indoorCut(v), before.cut);
  await page.waitForTimeout(900);
  const [tall, mid, low] = hid;
  const chain = hid.map((h) => h.hiddenFrac);
  if (!(chain[0] > chain[1] && chain[1] > chain[2]))
    fail(`the outline does not follow the cut: roof-1/3/${INDOOR_CUT_MAX} hide ${chain.join(" / ")} of the body — a taller parapet must hide strictly more`);
  if (!(low.hiddenFrac < 0.4 * tall.hiddenFrac))
    fail(`the shallowest parapet (roof-${INDOOR_CUT_MAX}, one level of wall) still hides ${low.hiddenFrac} against roof-1's ${tall.hiddenFrac} — the outline is not tracking real cover`);
  if (!tall.hiddenCropped)
    fail("the outline is drawn UNCROPPED over a partly-visible body — it must trace only the hidden part");
  // …and the ZERO, which is what proves the outline is not simply always on.
  // It comes from OUTDOORS in the open rather than from a deep cut: with the
  // dial capped at INDOOR_CUT_MAX every room keeps a wall, by design.
  if (outsideCover.hiddenFrac !== 0 || outsideCover.hidden)
    fail(`standing in the open outdoors the body still reads ${outsideCover.hiddenFrac} hidden — the outline is not keyed to real cover`);
  ok(`the white outline follows the cut: roof-1 hides ${(tall.hiddenFrac * 100).toFixed(0)}% of the figure, ` +
    `roof-3 ${(mid.hiddenFrac * 100).toFixed(0)}%, roof-${INDOOR_CUT_MAX} ${(low.hiddenFrac * 100).toFixed(0)}%, ` +
    `and outdoors in the open none at all (the ring is cropped to the hidden part, never the whole body)`);

  // =========================================================================
  // 3. THE INDOOR AMBIENT — dark as night, but less blue. Channel ratios,
  //    measured at a cell far from every light (so the field IS the ambient).
  // =========================================================================
  // NEVER read this off a fixed sleep. Three separate 2.5s-ish eases feed it —
  // the time-of-day grade, the indoor blend, and the weather roll — and the
  // headless frame loop runs several times slower than wall clock, so a probe
  // that just waits lands mid-fade and reports a grade that is neither. Poll
  // until two consecutive reads agree AND the state that produced them is the
  // one asked for.
  const ambient = async (phase, wantIndoor) => {
    let prev = null;
    for (let i = 0; i < 80; i++) {
      // RE-PIN THE PHASE EVERY POLL. timeOfDay() parks phaseT at 0.5 (the
      // phase's own anchor) but the WORLD CLOCK KEEPS RUNNING underneath —
      // blendPhases lerps continuously between mid-phase anchors, so by the
      // time a slow headless run settles, "Day" has drifted toward Evening and
      // the cell reads a blend of the two. Measured drift on one run:
      // [0.892, 0.813, 0.738] — ratios 1 : 0.911 : 0.827, exactly between
      // Day [1,1,1] and Evening [0.74, 0.55, 0.37] — which reads as "the probe
      // cell is not light-free" when nothing is lighting it at all.
      await page.evaluate((ph) => window.__ml.timeOfDay(ph, true, 0.5), phase);
      const v = await page.evaluate(([c, r]) => ({
        l: window.__ml.lightAtCell(c, r),
        mix: window.__ml.indoor().mix,
        phase: window.__ml.timeOfDay().name,
      }), FAR_CELL);
      const stateOk = v.phase.toLowerCase() === phase.toLowerCase() && (wantIndoor ? v.mix > 0.995 : v.mix < 0.005);
      if (stateOk && prev && prev.every((p, k) => Math.abs(p - v.l[k]) < 1e-4)) return v.l;
      prev = v.l;
      await page.waitForTimeout(400);
    }
    fail(`the ${phase} ambient never settled ${wantIndoor ? "indoors" : "outdoors"} (last ${fx(prev)})`);
  };
  const ambIn = await ambient("Day", true);
  await stand(OUTSIDE_SPOT[0], OUTSIDE_SPOT[1], false, true);
  const ambDay = await ambient("Day", false);
  await page.evaluate(() => window.__ml.timeOfDay("Night", true));
  const ambNight = await ambient("Night", false);
  await page.evaluate(() => window.__ml.timeOfDay("Day", true));
  await ambient("Day", false);
  if (Math.abs(luma(ambDay) - 1) > 0.05)
    fail(`the ambient probe cell ${FAR_CELL} is not light-free (Day reads ${fx(ambDay)}, expected ~1,1,1) — pick another`);
  const lIn = luma(ambIn), lNight = luma(ambNight);
  const blueIn = ambIn[2] / ambIn[0], blueNight = ambNight[2] / ambNight[0];
  const chroma = (v) => (Math.max(...v) - Math.min(...v)) / Math.max(...v);
  console.log(
    `   ambient: indoor@Day [${fx(ambIn)}]  night@outdoors [${fx(ambNight)}]  day@outdoors [${fx(ambDay)}]`,
  );
  // Indoors must be UNMISTAKABLY darker than standing in the sun. WHAT THIS IS
  // FOR: catching indoor mode not applying at all, which reads as daylight's
  // own 1.0. It is NOT a ceiling on the maintainer's brightness dial — that bar
  // has been walked down twice already (0.15 when the grade was pinned to
  // night's luma, then 0.3) and each time it was my taste standing in for his,
  // which is the wrong thing for a gate to hold. He set the default to 40% by
  // eye (luma 0.355 = 35% of daylight); the slider legitimately goes to 100%,
  // where the room IS the source art by his own spec, so the only defensible
  // bar is one the DEFAULT must clear with room to spare.
  if (lIn > 0.5 * luma(ambDay))
    fail(`indoors at Day is not dark: luma ${lIn.toFixed(4)} vs ${luma(ambDay).toFixed(4)} outside — ` +
      `indoor mode is not applying its own grade`);
  // THE DEFAULT IS THE MAINTAINER'S CHOICE, NOT A DERIVATION. It was 0.104 —
  // the dial value that reproduces the pre-slider grade's luma exactly — and
  // pinning "the untouched slider lands on night's luma" was right while that
  // held. He has since picked 40% by eye on his own device (2026-08-07), so
  // asserting the old identity would now be asserting a number nobody wants.
  //
  // What is still worth pinning is the DERIVATION, one notch down from where
  // anyone plays: at the dial's original 0.104 the grade must STILL land on
  // night's luma, because that is what makes the hue line in indoorlight.ts a
  // measured relationship rather than three numbers someone liked. The default
  // only has to stay in the room — brighter than black, well under daylight,
  // which the bar above and the tint checks below cover.
  const k = lIn / lNight;
  const kDerived = await page.evaluate(async () => {
    const before = window.__ml.indoorLight().dial;
    const a = window.__ml.indoorLight(0.104).ambient;
    window.__ml.indoorLight(before);
    return a;
  }).then((a) => luma(a) / lNight);
  if (Math.abs(kDerived - 1) > 0.05)
    fail(`the indoor hue line has drifted off night's luma: at the derived dial 0.104 the grade ` +
      `is ${kDerived.toFixed(3)}x night, not 1.00 — indoorlight.ts's HUE no longer matches its own derivation`);
  if (!(lIn > 2 * lNight))
    fail(`the DEFAULT indoor grade (${k.toFixed(2)}x night) is at the tuned-dark end — the maintainer set it to 40%`);
  // THE SLIDER'S TWO ENDS, which are the maintainer's literal spec
  // (2026-08-06): "0% = BLACK, 100% = THE TILE WILL LOOK JUST LIKE THE PNG
  // (WEBP)". Both are exact by construction, so assert them exactly rather
  // than within a band — a tinted 100% would render every tile faintly blue
  // and would NOT be the source art.
  const ends = await page.evaluate(() => {
    const before = window.__ml.indoorLight().dial;
    const zero = window.__ml.indoorLight(0).ambient;
    const full = window.__ml.indoorLight(1).ambient;
    window.__ml.indoorLight(before); // leave the dial as we found it
    return { zero, full, restored: window.__ml.indoorLight().dial, before };
  });
  if (ends.zero.some((v) => v !== 0))
    fail(`0% is not black: ambient [${ends.zero.join(", ")}]`);
  if (ends.full.some((v) => Math.abs(v - 1) > 1e-6))
    fail(`100% is not the source art: ambient [${ends.full.join(", ")}] (must be exactly 1,1,1)`);
  if (Math.abs(ends.restored - ends.before) > 1e-9) fail("the probe did not restore the dial");
  ok(`the Indoor light slider spans BLACK -> source art: 0% [${ends.zero.join(", ")}], 100% [${ends.full.join(", ")}]`);

  if (!(blueIn < blueNight * 0.8))
    fail(`the indoor ambient is as blue as the night one: B/R ${blueIn.toFixed(3)} vs ${blueNight.toFixed(3)} — the "less blue moonlight tone" is missing`);
  if (!(blueIn >= 1))
    fail(`the indoor ambient is WARM (B/R ${blueIn.toFixed(3)} < 1) — unlit stone should stay cool, and warm reads as a fire already lit`);
  if (!(chroma(ambIn) < 0.6 * chroma(ambNight)))
    fail(`the indoor ambient is not desaturated vs night (chroma ${chroma(ambIn).toFixed(3)} vs ${chroma(ambNight).toFixed(3)})`);
  ok(`indoor ambient sits on night's hue line and is less blue: the DEFAULT reads ${k.toFixed(2)}x night's luma ` +
    `(the maintainer's 40%), the DERIVED dial 0.104 still reads ${kDerived.toFixed(3)}x it; ` +
    `B/R ${blueIn.toFixed(3)} vs ${blueNight.toFixed(3)} ` +
    `(${((1 - blueIn / blueNight) * 100).toFixed(0)}% of the blue tilt gone), chroma ${chroma(ambIn).toFixed(3)} vs ${chroma(ambNight).toFixed(3)}`);

  // =========================================================================
  // 4. THE TORCH BURNS AT NOON — indoors, with the day gate fully closed.
  // =========================================================================
  await stand(roomC + 0.5, roomR + 0.5, true, true);
  if (!(await page.evaluate(() => window.__ml.me().torch)))
    await page.keyboard.press("5"); // [5] toggles the local hand torch
  await page.waitForFunction(() => window.__ml.me().torch === true, undefined, { timeout: 10000, polling: 100 })
    .catch(() => fail("could not switch the local torch on"));
  await page.waitForTimeout(800);
  const st = await page.evaluate(() => window.__ml.indoor());
  if (st.torchF > 0.02)
    fail(`the global day torch fade is ${st.torchF} — not full Day, so this proves nothing about re-enabling the torch`);
  const feetOn = await page.evaluate(() => { const m = window.__ml.me(); return window.__ml.lightAtCell(m.x / 32, m.y / 32, 0); });
  const shotOn = await shoot("torch-on");
  await page.keyboard.press("5");
  await page.waitForFunction(() => window.__ml.me().torch === false, undefined, { timeout: 10000, polling: 100 })
    .catch(() => fail("could not switch the local torch off"));
  await page.waitForTimeout(1200);
  const feetOff = await page.evaluate(() => { const m = window.__ml.me(); return window.__ml.lightAtCell(m.x / 32, m.y / 32, 0); });
  const shotOff = await shoot("torch-off");
  await page.keyboard.press("5");
  await page.waitForFunction(() => window.__ml.me().torch === true, undefined, { timeout: 10000, polling: 100 }).catch(() => {});
  const d = feetOn.map((v, i) => v - feetOff[i]);
  if (!(d[0] > 0.3)) fail(`the torch adds nothing at Day indoors: light at my feet ${fx(feetOff)} -> ${fx(feetOn)}`);
  if (!(d[0] > d[1] && d[1] > d[2]))
    fail(`what the torch adds is not firelight (delta ${fx(d)} — R>G>B expected)`);
  // ...and it reaches the picture, not just the CPU twin.
  let brighter = 0, peak = 0;
  for (let y = 60; y < 440; y++)
    for (let x = 40; x < 480; x++) {
      const i = (y * shotOn.width + x) * 4;
      const a = 0.299 * shotOn.data[i] + 0.587 * shotOn.data[i + 1] + 0.114 * shotOn.data[i + 2];
      const b = 0.299 * shotOff.data[i] + 0.587 * shotOff.data[i + 1] + 0.114 * shotOff.data[i + 2];
      if (a - b > 6) brighter++;
      peak = Math.max(peak, a - b);
    }
  if (brighter < 500)
    fail(`switching the torch changed only ${brighter} pixels indoors at Day — it is being drawn but not lighting anything`);
  ok(`the player's torch is LIT at full Day indoors (global torch fade ${st.torchF}): ` +
    `light at my feet ${fx(feetOff)} -> ${fx(feetOn)} (+${fx(d)}, firelight), ` +
    `${brighter} screen pixels brighter by >6 (peak +${peak.toFixed(0)})`);

  // =========================================================================
  // 5. ON THE ROOF — outdoors, world normal. The only way onto the slab is to
  //    walk: teleport lands on the BASE surface, so start on the wall top (same
  //    plane, no deck of its own) and step across onto the deck.
  // =========================================================================
  // A wall TOP is the same plane as the roof slab and carries no deck of its
  // own (buildTerrainGrid drops a deck whose level does not clear the terrain),
  // so it is reachable by teleport — and one step off it is the deck.
  const wallTop = [...wallRight].sort(
    (a, b) => Math.abs(a[0] - roomC) + Math.abs(a[1] - roomR) - Math.abs(b[0] - roomC) - Math.abs(b[1] - roomR),
  )[0];
  await goTo(wallTop[0] + 0.5, wallTop[1] + 0.5);
  await page.waitForFunction(
    (l) => window.__ml?.me?.()?.elev === l,
    roofDeck.level, { timeout: 15000, polling: 100 },
  ).catch(() => fail(`could not stand on the wall top at ${wallTop} (elev ${roofDeck.level})`));
  await page.evaluate(([c, r]) => window.__ml.tapTo((c + 0.5) * 32, (r + 0.5) * 32, false), [roomC, roomR]);
  await page.waitForFunction(
    ([cells, level]) => {
      const m = window.__ml?.me?.();
      if (!m) return false;
      const c = Math.floor(m.x / 32), r = Math.floor(m.y / 32);
      return m.elev === level && cells.some(([cc, rr]) => cc === c && rr === r);
    },
    [interior, roofDeck.level], { timeout: 45000, polling: 200 },
  ).catch(async () =>
    fail(`walked off the wall but never onto the roof deck: ${JSON.stringify(await page.evaluate(() => window.__ml.me()))}`));
  if (!(await settle(false, true, 45000)))
    fail(`standing on the roof never settled outdoors: ${JSON.stringify(await page.evaluate(() => window.__ml.indoor()))}`);
  await page.evaluate(([c, r]) => window.__ml.lookAt(c, r), [roomC - 1, roomR - 1]);
  await page.waitForTimeout(700);
  const roofState = await page.evaluate(() => ({ i: window.__ml.indoor(), m: window.__ml.me() }));
  if (roofState.i.indoor) fail(`standing ON the roof reads INDOORS: ${JSON.stringify(roofState.i)}`);
  const roofShot = await shoot("on-roof");
  // Re-pick the ceiling samples: the avatar is now standing ON the slab, so it
  // covers a different part of it than it did from inside.
  const roofP2 = await roofPoints(await avatarBox(), 8);
  const roofOnRoof = measure(roofShot, roofP2);
  const missing = roofOnRoof.filter((s) => s.med < 1);
  if (missing.length) fail(`standing on the roof, the slab is missing at ${missing.map((s) => `${s.c},${s.r}`).join(" ")}`);
  const outsideOnRoof = measure(roofShot, outsideP);
  if (outsideOnRoof.some((s) => s.med < 1)) fail("standing on the roof, the world outside is blacked out");
  ok(`standing ON the roof (cell ${Math.floor(roofState.m.x / 32)},${Math.floor(roofState.m.y / 32)} at elev ${roofState.m.elev}) is OUTDOORS: ` +
    `the slab is drawn again on all ${roofOnRoof.length} cells and nothing is blacked out`);

  // =========================================================================
  // 6. UNDER A BRIDGE — a slab overhead, but not a room. Nothing blacked out.
  // =========================================================================
  const bc = bridgeDeck.cells.map((c) => [X(c), Y(c)]);
  const bCol = Math.round(bc.reduce((a, [c]) => a + c, 0) / bc.length);
  const bRow = Math.round(bc.reduce((a, [, r]) => a + r, 0) / bc.length);
  await goTo(bCol + 0.5, bRow + 0.5);
  if (!(await settle(false, true, 45000)))
    fail(`under the bridge never settled outdoors: ${JSON.stringify(await page.evaluate(() => window.__ml.indoor()))}`);
  await page.evaluate(([c, r]) => window.__ml.lookAt(c, r), [bCol, bRow]);
  await page.waitForTimeout(700);
  const br = await page.evaluate(() => window.__ml.indoor());
  if (br.indoor) fail(`under a bridge reads INDOORS — every span would blink the world away: ${JSON.stringify(br)}`);
  if (!(br.roof > 0)) fail(`no slab overhead under the bridge (roof ${br.roof}) — this proves nothing`);
  if (!(br.wallRatio <= 0.7)) fail(`the bridge's wallRatio is ${br.wallRatio} — above the room bar, it only stayed out by luck`);
  const brShot = await shoot("under-bridge");
  const around = [];
  for (const [dc, dr] of [[-6, 0], [6, 0], [0, -4], [0, 4]]) {
    const s = await cellScreen(bCol + dc, bRow + dr);
    around.push({ c: bCol + dc, r: bRow + dr, ...patch(brShot, s.x + 32, s.y + 23, 3) });
  }
  const blacked = around.filter((s) => s.med < 1);
  if (blacked.length)
    fail(`under the bridge the world is blacked out at ${blacked.map((s) => `${s.c},${s.r}`).join(" ")} — indoor mode fired on a span`);
  ok(`under the bridge at ${bCol},${bRow} (roof ${br.roof} cells at level ${br.roofLevel}, wallRatio ${br.wallRatio}, ` +
    `depth ${br.depth}${br.swimming ? ", swimming" : ""}): OUTDOORS, and the surrounding world is untouched ` +
    `(luminance ${around.map((s) => s.mean.toFixed(0)).join("/")})`);

  if (errs.length) fail(`page errors: ${errs.slice(0, 3).join(" | ")}`);
  console.log("\nverify-indoor: ALL OK");
} finally {
  await browser.close();
}
