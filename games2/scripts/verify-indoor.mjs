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
// ...and (2026-08-07, after seeing the grass POP into existence one step out
// of the door):
//
//   "Why didn't we go with my original idea to set the ambient light to 0 for
//    everything outdoor (when you are in-door)? ... I was really hoping for
//    that transition where your TORCH can start to reveal the outdoor before
//    you're really outside... yes - point light from outside has to be turned
//    off."
//
// So the outside is DRAWN and unlit, not skipped. Three sections turn on that
// distinction and none of them can be satisfied by the old design: 2b's
// zero-ambient probe, 2g's doorway beam (with a light parked on cells that the
// old renderer would not have painted at all), and 7's cave, where drawing the
// outside untruncated buries the room under 595px of mountain.
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
// The dial's own maximum (indoorwall.ts INDOOR_WALL_MAX). The dial is a WALL
// HEIGHT in levels ABOVE THE ROOM'S OWN FLOOR — not a depth below its ceiling
// (maintainer 2026-08-07: a cave's ceiling is higher than a house's, so roof-N
// gave a different wall in each room). 6 is the tallest shipped room, so it is
// the point past which every room clamps — the far end of the sweep in 2e.
const INDOOR_WALL_MAX = 6;
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
  // Mean / peak / pure-black fraction of a square of real pixels. The bar is
  // luminance < 1: indoors the ground RT fills BLACK and the light overlay
  // MULTIPLIES, so any pixel whose light is zero composites to exactly 0
  // whatever the hour and whatever art is under it. (It used to mean "the
  // renderer skipped this"; since the outside is drawn at zero ambient it means
  // "nothing is lighting this" — the same pixels, and the stronger statement,
  // because it now also covers art that IS there.)
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
        // FULLY landed, not "close enough": the ease snaps to exactly 0/1 once
        // it is within 0.005, and 2b asserts the outside ambient is EXACTLY
        // zero. A residual mix of 0.995 leaves it at 0.0005 and the assertion
        // would be a coin flip on how starved the headless frame loop is.
        return d.indoor === w && (!m || (w ? d.mix >= 1 : d.mix <= 0));
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
  // TORCH OFF for the two darkness assertions below. It has to be, now that
  // the outside is DRAWN at zero ambient rather than skipped: a lit torch
  // reaches ~6 cells and lifts nearby outside ground to a real, intended
  // luminance, which would put 2b's per-patch bar and 2a's ceiling-plane
  // samples right on their own boundary for a reason that is the FEATURE
  // WORKING. What 2a/2b are about is "nothing is lighting the outside" —
  // so measure it with nothing lighting it. The beam gets its own section (2g).
  const setTorch = async (want) => {
    if ((await page.evaluate(() => window.__ml.me().torch)) !== want) await page.keyboard.press("5");
    await page.waitForFunction((w) => window.__ml.me().torch === w, want, { timeout: 10000, polling: 100 })
      .catch(() => fail(`could not switch the local torch ${want ? "on" : "off"}`));
    await page.waitForTimeout(1200);
  };
  await setTorch(false);
  // 2a/2b/2c run on the FLAT cut (per-wall raise OFF): they pin the scalar
  // contract — the roof slab is gone, the outside is unlit, every enclosure
  // cell draws at the dial — and 2a's void proof NEEDS points no drawn column
  // reaches, which a house raised to its ceiling no longer has. The raise
  // gets its own section (2c') against this same frame. The cuts are read
  // FIRST, while the raise is still on, for 2c' to assert with.
  const raise0 = await page.evaluate(() => window.__ml.indoorRaise());
  await page.evaluate(() => window.__ml.indoorRaise(false));
  await page.waitForTimeout(900);
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
  //
  // NOW THAT THE OUTSIDE IS DRAWN, this reads as "whatever is painted at the
  // ceiling plane is unlit", which still catches a returning roof: the slab is
  // a cell of MY building, so it is IN the room mask and would come back LIT,
  // at the interior ambient, not black. Only cells the mask excludes go dark,
  // and the roof is never one of them. The boxes below stay derived from the
  // BUILDING alone for a second reason: adding the outside would make almost
  // every sample "reachable" and the test vacuous.
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

  // -- 2b. OUTSIDE IS UNLIT, INSIDE IS NOT ----------------------------------
  // THE MECHANISM CHANGED HERE AND THE ASSERTION DID NOT. The outside used to
  // be black because the renderer SKIPPED it; it is black now because it is
  // DRAWN at zero ambient under a MULTIPLY overlay, which composites to the
  // same exact zero (maintainer 2026-08-07: "why didn't we go with my original
  // idea to set the ambient light to 0 for everything outdoor"). Same pixels,
  // different reason — so the numbers below hold, and 2g asserts the part only
  // the new mechanism can do.
  //
  // The bar is per-patch coverage, not a peak: a ground tile fills its whole
  // 17x17 window, so anything genuinely lit out there cannot have a median of
  // 0. It is 0.9 rather than 1.0 because a few decor layers still paint over
  // the black — the ambient agent's birds/bats/fireflies (games2/ambient/, not
  // this agent's to gate), footstep marks, grave crosses and weather particles.
  // Those are scattered single pixels; terrain is a solid diamond.
  const outsideIn = measure(inShot, outsideP);
  const lit = outsideIn.filter((s) => s.med >= 1);
  if (lit.length)
    fail(`ground outside the room is LIT at ${lit.map((s) => `${s.c},${s.r} (median ${s.med.toFixed(1)}, mean ${s.mean.toFixed(1)}, ${(s.black * 100).toFixed(0)}% void)`).join("; ")} — ` +
      `with the torch off nothing indoors may reach it`);
  const outVoid = outsideIn.reduce((a, s) => a + s.black, 0) / outsideIn.length;
  ok(`everything outside the room is UNLIT: ${outsideIn.length} sample patches, median luminance 0, ` +
    `${(outVoid * 100).toFixed(0)}% of their pixels pure black ` +
    `(they read ${outsideOut.map((s) => s.mean.toFixed(0)).join("/")} from outdoors)`);
  // ...and it is the LIGHT that is zero, not the geometry. This is the whole
  // difference between the two designs and the only place it can be seen
  // without a second light: the CPU field is the shader's exact twin, and it
  // says the ambient at a cell 40+ cells outside is identically zero.
  const farIn = await lightAt(FAR_CELL[0] + 0.5, FAR_CELL[1] + 0.5, 0);
  if (farIn.some((v) => v !== 0))
    fail(`the ambient outside my room is ${fx(farIn)}, not zero — the outside is dark for the wrong reason`);
  ok(`the outside is dark because its AMBIENT IS ZERO: lightAtCell(${FAR_CELL}) = ${fx(farIn)} while indoors`);

  // ...and nothing OUTSIDE is lighting the room either (maintainer 2026-08-07:
  // "yes — point light from outside has to be turned off"). the_island2's spawn
  // bonfire stands ~5 cells from the door with radius 7 and colour [1.9, .88,
  // .3], so an unfiltered one pours firelight through the wall onto the floor —
  // and it would be the LAST thing to notice, because a warm floor at night
  // looks intentional. The test is exact: with my own torch off, the light at
  // the room centre must be the indoor ambient dial and nothing else.
  {
    const dial = await page.evaluate(() => window.__ml.indoorLight().ambient);
    const here = await lightAt(roomC + 0.5, roomR + 0.5, 0);
    const off = here.map((v, i) => Math.abs(v - dial[i]));
    if (Math.max(...off) > 0.01)
      fail(`the room centre reads ${fx(here)} but the indoor dial is ${fx(dial)} — something outside is lighting my room ` +
        `(warm tilt ${(here[0] / Math.max(1e-6, here[2])).toFixed(2)} R/B vs the dial's ${(dial[0] / Math.max(1e-6, dial[2])).toFixed(2)})`);
    ok(`no light from outside reaches in: the room centre is exactly the indoor dial ${fx(dial)}, ` +
      `with the bonfire ~5 cells out the door and inside its own radius`);
  }
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
  // WHERE THE CAP'S INK ACTUALLY IS. A column that was TRUNCATED ends in a
  // FACE tile, not the baked top diamond (redrawGround picks `hi === cell.l ?
  // topKey : fk` deliberately — a grass/rock lid on a wall stump reads wrong).
  // A face tile's art is the 16px SKIRT at the BOTTOM of its 64px box, so the
  // sample belongs at +39/+46 from the cap tile's own top-left, never at the
  // diamond centre +23, which is transparent for that tile. Measured on the
  // shipped house at a 2-level wall: the diamond centre reads 0 on all eight far-wall
  // cells while the skirt band reads 26-44. A column NOT truncated (level <=
  // the cut) does end in its top diamond, so it keeps +23.
  //
  // This probe was wrong before and passed anyway, because the indoor ground
  // RT used to fill NAVY (0x181c28): the empty diamond centre showed the fill
  // at ~11 luminance, over the median-4 bar, and the test read "art" where
  // there was none. The fill is black now, so the mistake surfaced. Sampling
  // three x offsets across the skirt and keeping the best keeps it honest at
  // the doorway jambs, where the centre column of one cell is a real gap.
  // `cut` = which level this cell's cap sits at IN THE FRAME BEING MEASURED —
  // the scalar dial for the flat frame here; 2c' re-runs this same band on the
  // raised frame with each cell's own cut.
  const capBand = (sc, cut) => {
    const drawn = Math.min(sc.level, cut);
    const capTop = sc.y + (sc.level - drawn) * 16;
    return drawn < sc.level
      ? [39, 46].flatMap((dy) => [16, 32, 48].map((dx) => ({ x: sc.x + dx, y: capTop + dy })))
      : [{ x: sc.x + 32, y: capTop + 23 }];
  };
  const bldP = [];
  for (const [c, r] of building) {
    const sc = await cellScreen(c, r);
    const pts = capBand(sc, inn.top).filter((p) => inView(p));
    if (pts.length) bldP.push({ c, r, pts });
  }
  if (bldP.length < building.length - 2)
    fail(`only ${bldP.length} of ${building.length} building cells are on screen — the house no longer fits the frame`);
  const bldIn = bldP.map(({ c, r, pts }) => {
    const ss = pts.map((p) => patch(inShot, p.x, p.y, 2)).filter(Boolean);
    if (!ss.length) fail(`no on-screen sample for building cell ${c},${r}`);
    // BEST of the band: one gap in a jamb is not a hole in the building.
    return ss.reduce((a, s) => (s.med > a.med ? s : a), { ...ss[0], c, r });
  });
  const holes = bldIn.filter((s) => s.med < 4);
  if (holes.length)
    fail(`HOLES in the building at ${holes.map((s) => `${s.c},${s.r} (median ${s.med.toFixed(1)}, ${(s.black * 100).toFixed(0)}% void)`).join("; ")} — ` +
      `a cell of the enclosure that nobody draws is a black wedge through the house`);
  ok(`the building is SOLID: all ${bldIn.length} enclosure cells — corners and T-junctions included — ` +
    `carry art at their cut top (median luminance ${Math.min(...bldIn.map((s) => s.med)).toFixed(1)}-${Math.max(...bldIn.map((s) => s.med)).toFixed(1)})`);

  // -- 2c'. THE PER-WALL RAISE ---------------------------------------------
  // (maintainer 2026-08-13: "make the current wall height a MINIMUM setting...
  // draw the walls all the way to the roof on sides where it's possible...
  // just make them as tall as they can be before they intersect with another
  // floor.") Three claims, each measured its own way:
  //   • REACH — some wall of this house really rises to the CEILING (data),
  //     and the shader's copy of the cuts matches the scene's (texture).
  //   • INK — the raise is real paint: toggling it off changes a lot of the
  //     house picture (the 2c/2a samples above already pin WHERE the ink is).
  //   • PROTECTION — the floor I stand on is exactly as visible either way:
  //     the raise may never buy walls with floor pixels. Compared per floor
  //     patch as a median shift, not pixel equality — the avatar box is
  //     already excluded from floorP, but a stray decor layer is not.
  // (houseBox + diffPixels live here because this section and 2d both diff
  // whole frames over the house's own screen box.)
  const houseBox = await (async () => {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const [c, r] of [...interior, ...building]) {
      const sc = await cellScreen(c, r);
      x0 = Math.min(x0, sc.x); x1 = Math.max(x1, sc.x + 64);
      y0 = Math.min(y0, sc.y); y1 = Math.max(y1, sc.y + sc.level * 16 + 64);
    }
    return { x0: Math.max(gv.x, Math.round(x0)), x1: Math.min(gv.x + gv.w, Math.round(x1)),
             y0: Math.max(gv.y, Math.round(y0)), y1: Math.min(gv.y + gv.h, Math.round(y1)) };
  })();
  // Pixels that differ by more than the art's own dither. Restricted to a box
  // and to a bar of 8 so a firefly or a breathing NPC cannot pass for a dial.
  const diffPixels = (a, b, box) => {
    let n = 0;
    for (let y = box.y0; y <= box.y1; y++)
      for (let x = box.x0; x <= box.x1; x++) {
        const i = (y * a.width + x) * 4;
        if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) +
            Math.abs(a.data[i + 2] - b.data[i + 2]) > 8) n++;
      }
    return n;
  };
  if (!(raise0.on && raise0.raised > 0))
    fail(`the per-wall raise is not active in the house (on=${raise0.on}, raised=${raise0.raised})`);
  if (Math.max(...Object.values(raise0.cuts)) !== inn.ceiling)
    fail(`no wall reaches the roof: max cut ${Math.max(...Object.values(raise0.cuts))} vs ceiling ${inn.ceiling} — ` +
      `"all the way to the roof on sides where it's possible" is not happening`);
  // Back ON (2a-2c measured the flat frame) — and from here the gate runs in
  // the raise's design state.
  await page.evaluate(() => window.__ml.indoorRaise(true));
  await page.waitForTimeout(900);
  const texR = await page.evaluate(() => window.__ml.roomTex());
  if (texR.raisedCells !== raise0.raised || texR.maxCut !== Math.max(...Object.values(raise0.cuts)))
    fail(`the shader's room texture disagrees with the scene about the raise: texture ${texR.raisedCells} cells ` +
      `(max ${texR.maxCut}) vs scene ${raise0.raised} — the light would truncate columns the renderer draws`);
  const raisedShot = await shoot("raise-on");
  const raiseInk = diffPixels(raisedShot, inShot, houseBox);
  const floorRaised = measure(raisedShot, floorP);
  const floorMoved = floorIn
    .map((s, i) => {
      const b = floorRaised[i];
      return { c: s.c, r: s.r, d: Math.abs(s.med - b.med), flat: s.med, raised: b.med };
    })
    .filter((x) => x.d > 10);
  if (raiseInk < 1500)
    fail(`the raise only changes ${raiseInk} pixels of the house against the flat cut — walls are not visibly rising`);
  if (floorMoved.length)
    fail(`the raise changes the FLOOR at ${floorMoved.map((x) => `${x.c},${x.r} (median ${x.flat.toFixed(0)} -> ${x.raised.toFixed(0)})`).join("; ")} — ` +
      `a wall bought its height with protected floor pixels`);
  // ...and every enclosure cell still carries art AT ITS OWN CUT — the same
  // solidity band as 2c, sampled where the raised renderer claims each cap is.
  const cutOf = (c, r) => raise0.cuts[`${c},${r}`] ?? inn.top;
  const raisedHoles = [];
  for (const [c, r] of building) {
    const sc = await cellScreen(c, r);
    const pts = capBand(sc, cutOf(c, r)).filter((p) => inView(p));
    if (!pts.length) continue;
    const ss = pts.map((p) => patch(raisedShot, p.x, p.y, 2)).filter(Boolean);
    if (!ss.length) continue;
    const best = ss.reduce((a, s) => (s.med > a.med ? s : a), ss[0]);
    if (best.med < 4) raisedHoles.push(`${c},${r} (cut ${cutOf(c, r)}, median ${best.med.toFixed(1)})`);
  }
  if (raisedHoles.length)
    fail(`raised walls missing their claimed cap at ${raisedHoles.join("; ")} — the drawn column and the cut map disagree`);
  ok(`the per-wall raise: ${raise0.raised} of ${building.length} wall cells rise past the dial (max = the ` +
    `ceiling ${inn.ceiling}, texture in sync), repainting ${raiseInk}px of the house, every cap drawn at its ` +
    `own cut, and every floor patch untouched`);

  // -- 2d. THE DIAL IS THE CUT ---------------------------------------------
  // The maintainer's actual requirement: "cut all walls at 'roof - 1',
  // 'roof - 2', etc. Even making this configurable in settings so I can test
  // what looks best." So the picture must MOVE, by exactly one level per step.
  //
  // MEASURED AS A WHOLE-PICTURE DIFFERENCE, not as one crown row. The obvious
  // probe — "scan a screen column and find the topmost non-void row, it must
  // drop 16px per step" — is not sound once every column in the world is drawn:
  // the topmost lit pixel in any given column belongs to whatever cell the
  // painter last put there, which is frequently a NEIGHBOUR of the wall you
  // aimed at (its 64px art box overlaps, and a far wall is drawn before the
  // floor and near walls that cover it). Measured on the shipped house: eight
  // different far- and near-wall cells all report the SAME crown offset at
  // wall 1, wall 3 and wall 5, while the frames plainly differ. The probe was
  // wrong, not the renderer.
  //
  // What IS unambiguous is the frame itself. One step of the dial takes a
  // 16px band off every wall column at once, so it must (a) change the picture,
  // (b) change it inside the house and nowhere else, and (c) change it FURTHER
  // at every further step — measured against the shallowest cut, so the counts
  // are cumulative and a dial that saturated would show up as a flat run.
  const before = await page.evaluate(() => window.__ml.indoorWall());
  const cuts = [];
  for (const n of [1, 2, 3, 4]) {
    await page.evaluate((v) => window.__ml.indoorWall(v), n);
    await page.waitForTimeout(900);
    cuts.push({ n, shot: await shoot(`wall-${n}`), top: (await page.evaluate(() => window.__ml.indoorWall())).top });
  }
  await page.evaluate((v) => window.__ml.indoorWall(v), before.wall);
  await page.waitForTimeout(900);
  const bad = [];
  const moved = [0];
  for (let i = 1; i < cuts.length; i++) {
    // ONE LEVEL PER STEP, UPWARD. The dial is a height above the floor now, so
    // asking for one more level must raise the drawn top by exactly one.
    if (cuts[i].top !== cuts[i - 1].top + 1)
      bad.push(`wall ${cuts[i].n} resolved to top ${cuts[i].top}, one MORE than wall ${cuts[i - 1].n}'s ${cuts[i - 1].top} expected`);
    const d = diffPixels(cuts[0].shot, cuts[i].shot, houseBox);
    moved.push(d);
    if (d <= moved[i - 1])
      bad.push(`wall ${cuts[i].n} changed ${d} pixels vs wall 1, no more than wall ${cuts[i - 1].n}'s ${moved[i - 1]} — the dial stopped moving`);
  }
  if (moved[moved.length - 1] < 2000)
    bad.push(`wall 1 to wall 4 only moved ${moved[moved.length - 1]} pixels of the house — the dial barely does anything`);
  // ...and it does nothing OUTSIDE the house: the outside is black at every
  // setting, so a dial leaking into the world would show up as a difference
  // there. Sampled at the same outdoor probes 2b uses.
  for (const p of outsideP) {
    const a = patch(cuts[0].shot, p.x, p.y, p.rad ?? 3);
    const b = patch(cuts[cuts.length - 1].shot, p.x, p.y, p.rad ?? 3);
    if (a && b && (a.med >= 1 || b.med >= 1))
      bad.push(`the dial lit ground outside the room at ${p.c},${p.r} (wall 1 median ${a.med.toFixed(1)}, wall 4 ${b.med.toFixed(1)})`);
  }
  if (bad.length) fail(`the Indoor wall cut dial does not move the picture: ${bad.join("; ")}`);
  ok(`the dial IS the wall height: 1..4 levels resolve to top ${cuts.map((c) => c.top).join(" -> ")} ` +
    `(one level each, measured UP from the room's floor) and change ${moved.slice(1).join(" -> ")} pixels of ` +
    `the house against wall 1 — strictly more each step, and nothing outside it — restored to ${before.wall}`);

  // -- 2e. THE WHITE OUTLINE ON WHAT IS STILL HIDDEN -----------------------
  // The other half of the maintainer's design: "a white pixel outline on parts
  // being behind something". A cut-away without it just loses the body's legs
  // behind the parapet — so the outline must appear exactly when, and to the
  // extent that, a wall really covers them.
  //
  // Asserted as a MONOTONE RESPONSE to the dial rather than one magic number:
  // a taller wall must hide MORE of the figure, and the shortest one the dial
  // can ask for must hide far less. Nothing stuck on, stuck off, or keyed to
  // anything but real geometry can satisfy both ends. The chain runs the other
  // way round from the old roof-N dial, for the obvious reason: a BIGGER number
  // is now a TALLER wall.
  // The TALL end is one below the dial's max, not the max itself: at the full
  // 6 levels the house's own wall is its whole height and the body behind it is
  // hidden ENTIRELY, which would make `hiddenCropped` vacuous — the outline
  // would legitimately cover the whole figure and the crop assertion below
  // would be asserting nothing. 5 leaves a head showing. The max is exercised
  // separately, by the clamp check inside the loop.
  const hid = [];
  for (const n of [INDOOR_WALL_MAX - 1, 3, 1]) {
    await page.evaluate((v) => window.__ml.indoorWall(v), n);
    await page.waitForTimeout(900);
    const c = await page.evaluate(() => window.__ml.myCover());
    // The REAL covered fraction, in texels, off the cover surfaces themselves
    // (a GPU readback — dev only, never in the frame loop). On the pixel-exact
    // path this is what the outline actually traces; `hiddenFrac` is only the
    // band of the art box the flat cover LINE claims.
    const cover = await page.evaluate(() => window.__ml.coverStats());
    const got = await page.evaluate(() => window.__ml.indoorWall().wall);
    if (got !== n) fail(`the dial refused ${n} levels (clamped to ${got}) — INDOOR_WALL_MAX and this gate disagree`);
    hid.push({ n, ...c, cover });
  }
  await page.evaluate((v) => window.__ml.indoorWall(v), before.wall);
  await page.waitForTimeout(900);
  const [tall, mid, low] = hid;
  const chain = hid.map((h) => h.hiddenFrac);
  if (!(chain[0] > chain[1] && chain[1] > chain[2]))
    fail(`the outline does not follow the wall height: ${INDOOR_WALL_MAX - 1}/3/1 levels hide ${chain.join(" / ")} of the body — a taller wall must hide strictly more`);
  if (!(low.hiddenFrac < 0.4 * tall.hiddenFrac))
    fail(`a ONE-level wall still hides ${low.hiddenFrac} against a ${INDOOR_WALL_MAX - 1}-level wall's ${tall.hiddenFrac} — the outline is not tracking real cover`);
  // …AND THE OUTLINE TRACES ONLY THE HIDDEN PART. Which measurement proves
  // that depends on the representation the outline is ON. `hiddenCropped` was
  // literally `!!hidden.isCropped`, and the pixel-exact path has no crop to
  // report — the ring IS the covered sub-silhouette's border, so what has to
  // be true instead is that the covered set is a PROPER, non-empty subset of
  // the silhouette. That is the strictly stronger claim: a horizontal crop can
  // be "cropped" and still cover half the body that nothing is in front of.
  if (tall.hiddenMode === "surface") {
    const cs = tall.cover;
    if (!cs || !(cs.coveredFrac > 0 && cs.coveredFrac < 1))
      fail(`behind the tallest wall the outline traces ${cs ? `${cs.covered}/${cs.silhouette} = ${cs.coveredFrac}` : "an unreadable share"} ` +
        `of the silhouette — a partly-visible body must be partly outlined, never all or nothing`);
    const chainPx = hid.map((h) => (h.cover ? h.cover.coveredFrac : null));
    if (chainPx.every((v) => v !== null) && !(chainPx[0] > chainPx[1] && chainPx[1] > chainPx[2]))
      fail(`the COVERED TEXELS do not follow the wall height: ${INDOOR_WALL_MAX - 1}/3/1 levels cover ${chainPx.join(" / ")} ` +
        `of the silhouette — the per-pixel cover set must grow with the wall`);
    ok(`the outline is the covered sub-silhouette, per texel: ${INDOOR_WALL_MAX - 1}/3/1 levels cover ` +
      `${chainPx.map((v) => (v === null ? "?" : `${Math.round(v * 100)}%`)).join(" / ")} of the body's own pixels`);
  } else if (!tall.hiddenCropped)
    fail("the outline is drawn UNCROPPED over a partly-visible body — it must trace only the hidden part");
  // …and the ZERO, which is what proves the outline is not simply always on.
  // It comes from OUTDOORS in the open rather than from a short wall: the dial
  // floor is 1, so every room keeps a wall, by design.
  if (outsideCover.hiddenFrac !== 0 || outsideCover.hidden)
    fail(`standing in the open outdoors the body still reads ${outsideCover.hiddenFrac} hidden — the outline is not keyed to real cover`);
  // -- 2f. A TAP LANDS WHERE YOU TAPPED ------------------------------------
  // The cut-away changes what is ON SCREEN, so it changes what a tap means.
  // pickGround scans levels top-down, and the roof slab is still in the DATA
  // over every interior cell — so before this was fixed every indoor tap
  // matched the deck at level 6 and the walk target landed 6.40 cells (96px)
  // down-screen of the finger (maintainer 2026-08-07: "the player walks to a
  // spot about a full character in length under the spot I actually clicked
  // on. This makes it really hard to point and click navigate indoors").
  //
  // Asserted by ROUND TRIP on the room's own floor: project a known cell to
  // screen, feed that point to the REAL hit test, and require the cell back.
  {
    const bad = [];
    for (const [c, r] of interior) {
      const sc = await cellScreen(c, r);
      const got = await page.evaluate(
        ([x, y]) => {
          const g = window.__ml.pickAt(x, y);
          return g ? { c: g.x / 32, r: g.y / 32, lvl: g.lvl } : null;
        },
        // cellScreen is CANVAS px; pickGround works in WORLD px, and the tap
        // point is the tile's own centre (+32, +2*dy) as pointerdown computes.
        [sc.x / sc.zoom + sc.camX + 32, sc.y / sc.zoom + sc.camY + 30],
      );
      if (!got) { bad.push(`${c},${r} -> nothing`); continue; }
      const off = Math.abs(got.c - c - 0.5) + Math.abs(got.r - r - 0.5);
      if (off > 0.6 || got.lvl !== 0)
        bad.push(`${c},${r} -> ${got.c.toFixed(1)},${got.r.toFixed(1)} at level ${got.lvl} (${off.toFixed(2)} cells off)`);
    }
    if (bad.length)
      fail(`indoor taps do not land where you tap: ${bad.join("; ")} — the hit test is resolving against geometry the cut-away does not draw`);
    ok(`a tap lands where you tap: all ${interior.length} interior floor cells round-trip through the real hit test to themselves at level 0`);
  }

  ok(`the white outline follows the wall height: ${INDOOR_WALL_MAX - 1} levels hide ${(tall.hiddenFrac * 100).toFixed(0)}% of the figure, ` +
    `3 levels ${(mid.hiddenFrac * 100).toFixed(0)}%, 1 level ${(low.hiddenFrac * 100).toFixed(0)}%, ` +
    `and outdoors in the open none at all (the ring is cropped to the hidden part, never the whole body)`);

  // -- 2g. THE TORCH REACHES THROUGH THE DOORWAY ---------------------------
  // The thing the maintainer asked for and the reason the outside is DRAWN at
  // all (2026-08-07): "I was really hoping for that transition where your TORCH
  // can start to reveal the outdoor before you're really outside."
  //
  // Only the AMBIENT is zeroed out there, never the point lights, so the torch
  // in my hand spills through the opening and lifts the ground beyond it — with
  // the doorway's own shadow, because the wall still blocks the LOS march.
  // Three claims, in the order they can fail:
  //   (a) the beam exists — the cells straight out of the door light up;
  //   (b) it is a BEAM — the cells flanking them, behind the wall, are several
  //       times darker (a ratio, never "the flank is black": the shader's
  //       occ = max(occ, 0.22) bounce floor guarantees it never is);
  //   (c) those pixels are really DRAWN, not merely dark. At zero ambient a
  //       drawn tile and a missing one composite identically, so a LIGHT is the
  //       only instrument that separates them — which is exactly why this
  //       section, and not 2b, is where "the outside is drawn" is proved.
  {
    // The entrance cell (the one OUTSIDE the opening — the doorway itself is
    // interior) and the cell straight beyond it: the beam. Flanking the
    // entrance at the same row, so they share a screen band and the same art
    // run but sit behind solid wall: the shadow.
    if (!doorway.length) fail("no entrance derived from the house footprint");
    const [doorC, doorR] = doorway[0];
    const beam = [[doorC, doorR], [doorC, doorR + 1]];
    const flank = [[doorC - 1, doorR], [doorC + 1, doorR]];
    await setTorch(true);
    const beamL = [];
    for (const [c, r] of beam) beamL.push(luma(await lightAt(c + 0.5, r + 0.5, 0)));
    const flankL = [];
    for (const [c, r] of flank) flankL.push(luma(await lightAt(c + 0.5, r + 0.5, 0)));
    if (!(Math.min(...beamL) > 0.02))
      fail(`the torch does not reach through the doorway: ${beam.map((p, i) => `${p} -> ${beamL[i].toFixed(4)}`).join(", ")}`);
    // The RATIO is taken at the mouth, where the wedge is narrowest and the
    // wall's shadow hardest. Further out the beam spreads and the pool's own
    // 1/r falloff shrinks the contrast — asserting the deep cell would be
    // asserting the falloff, not the doorway.
    const ratio = beamL[0] / Math.max(...flankL);
    if (!(ratio >= 3))
      fail(`the doorway is not casting a beam — behind-the-wall flanks are only ${ratio.toFixed(2)}x darker ` +
        `(beam ${beamL.map((v) => v.toFixed(4)).join("/")}, flank ${flankL.map((v) => v.toFixed(4)).join("/")})`);
    // (c) DRAWN. The probe light is deliberately exempt from the room filter
    // (WorldScene) precisely so a gate can do this: park a bright, flicker-free
    // pool ON the doorway and require the beam cells to go from black pixels to
    // real ones. If the renderer had skipped them there would be nothing there
    // to light and the patches would stay at zero however bright the pool.
    const litShot = await (async () => {
      await page.evaluate(([c, r]) => window.__ml.probeLight(c + 0.5, r + 0.5, 0.55, 10), [doorC, doorR]);
      await page.waitForTimeout(900);
      return shoot("doorway-beam");
    })();
    const drawn = [];
    for (const [c, r] of beam) {
      const sc = await cellScreen(c, r);
      // Same anchor the outdoor probes use: the top diamond's centre.
      const s = patch(litShot, sc.x + 32, sc.y + 23, 5);
      if (!s) fail(`the beam sample for ${c},${r} fell off screen`);
      drawn.push({ c, r, ...s });
    }
    await page.evaluate(() => window.__ml.probeLight());
    const missing = drawn.filter((s) => s.med < 1);
    if (missing.length)
      fail(`the ground outside the doorway is NOT DRAWN at ${missing.map((s) => `${s.c},${s.r} (median ${s.med.toFixed(1)})`).join("; ")} — ` +
        `a light is standing on it and it stayed black, so the renderer is still skipping the outside`);
    await setTorch(false);
    ok(`the torch reveals the outside through the doorway: beam ${beamL.map((v) => v.toFixed(4)).join("/")} vs ` +
      `${flankL.map((v) => v.toFixed(4)).join("/")} behind the wall (${ratio.toFixed(1)}x), and a light parked on ` +
      `those cells paints real pixels (median ${drawn.map((s) => s.med.toFixed(0)).join("/")}) — they were DRAWN all along`);
  }

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
  //
  // WHERE it is measured now depends on which side of a wall you are on. The
  // probe cell used to be FAR_CELL for both readings, which was fine while the
  // outside merely went unrendered — the light field there still carried the
  // grade. It does not any more: FAR_CELL is 40 cells outside the room and its
  // ambient is now identically ZERO from indoors (that is 2b's assertion). So
  // the INDOOR reading moves to the room's own centre, and the two OUTDOOR
  // readings keep FAR_CELL. The +0.5 matters: an integer sample beside a wall
  // picks up the AO twin's 0.72 corner term and would silently under-read the
  // indoor grade; at the room centre both up-screen neighbours are floor.
  const ambient = async (phase, wantIndoor) => {
    const cell = wantIndoor ? [roomC + 0.5, roomR + 0.5] : FAR_CELL;
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
      }), cell);
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

  // =========================================================================
  // 7. IN A CAVE — the cut is WORLD-WIDE, or the mountain buries the room.
  // =========================================================================
  // The house proves almost nothing about this: within +-10 cells of it the
  // terrain is 633 cells at level 0 and 17 at level 6 (the house itself), so
  // whether the cut applies to the outside as well is invisible there. A cave
  // is the opposite. Painter order draws by (col+row) ASCENDING, so a column
  // DOWN-SCREEN of the room draws over it, and it buries an interior cell once
  // it is about 0.94*k levels taller at k steps. the_island2's caves are cut
  // into rock at levels 24-40 with the interior floor at 0 — measured, drawing
  // the outside untruncated hides 417 of 417 interior cells, worst case 595px
  // of solid mountain over the room you are standing in. Truncating EVERY
  // column at the cut (redrawGround) is what removes it, and this is the only
  // shipped geometry that can tell.
  // CANDIDATES, biggest chamber first, tried in order. Two reasons it is a
  // LIST and not one pick, both learned the hard way:
  //   • a cave cell can be geometrically interior and still UNREACHABLE — the
  //     teleport is server-authoritative and lands you on the base surface, so
  //     a sealed pocket high in the mountain bounces you back to spawn (the
  //     level-40 chambers at the top of the_island2 all do);
  //   • the room is the 4-connected space around the PLAYER, which for a big
  //     deck may be one chamber of several.
  // Biggest-first rather than tallest-rock-first for the same reason: the
  // deepest chamber is the one with a way in. Height still has to be PROVEN,
  // not assumed — the assertion below refuses to pass unless the rock beside
  // the room really is far above the cut.
  // DISABLE AGGRO for this section. the_island2's caves are populated with
  // level 24-36 monsters, and a gate that has to stand still in one taking
  // screenshots gets killed and respawned OUTDOORS mid-measurement — which
  // reads as a failure of whatever was being measured. This is the switch the
  // maintainer asked for on 2026-08-07 ("I will use this feature to test walk
  // around in the cave without dying") doing exactly its job.
  await page.evaluate(() => window.__ml.noAggro(true));
  await page.waitForTimeout(400);
  const rockBy = (floor) => Math.max(...floor.map(([c, r]) =>
    Math.max(lvl(c + 1, r + 1), lvl(c + 1, r), lvl(c, r + 1))));
  const caves = (world.decks ?? [])
    .filter((d) => d.kind === "cave")
    .map((d) => {
      const cells = d.cells.map((c) => [X(c), Y(c)]);
      const bot = d.level - (d.thickness ?? 0);
      return { d, bot, floor: cells.filter(([c, r]) => lvl(c, r) < bot) };
    })
    .filter((x) => x.floor.length >= 8)
    .sort((a, b) => b.floor.length - a.floor.length)
    .slice(0, 5); // a failed candidate costs ~40s of retries; five is plenty
  if (!caves.length) fail("the_island2 ships no cave with a floor — section 7 cannot run");
  {
    let caveDeck = null, sc0 = 0, sr0 = 0;
    const tried = [];
    for (const cand of caves) {
      const cc = Math.round(cand.floor.reduce((a, [c]) => a + c, 0) / cand.floor.length);
      const cr = Math.round(cand.floor.reduce((a, [, r]) => a + r, 0) / cand.floor.length);
      // Nearest REAL floor cell to the centroid — a cave is concave and its
      // centroid can land in the rock.
      const [c0, r0] = cand.floor
        .slice()
        .sort((a, b) => Math.hypot(a[0] - cc, a[1] - cr) - Math.hypot(b[0] - cc, b[1] - cr))[0];
      tried.push(`${c0},${r0}`);
      await goTo(c0 + 0.5, r0 + 0.5).catch(() => {});
      if (!(await settle(true, true, 25000))) continue;
      // "Settled indoors" is NOT enough to accept a candidate. The room is the
      // 4-connected space around the PLAYER, and a big cave deck can span
      // several chambers separated by rock — land in a small one and this
      // deck's floor is mostly outside my room, leaving nothing to judge.
      // Require the deck to actually contribute cells to the room I am in.
      const mine = [];
      for (const [c, r] of cand.floor) {
        if (luma(await lightAt(c + 0.5, r + 0.5, 0)) > 0) mine.push([c, r]);
        if (mine.length >= 6) break; // enough to know this chamber is the deck's
      }
      if (mine.length >= 6) { caveDeck = cand; sc0 = c0; sr0 = r0; break; }
      tried[tried.length - 1] += `(only ${mine.length} of its cells are in the room I landed in)`;
    }
    if (!caveDeck)
      fail(`no cave could be stood in — tried ${tried.join(" ")}: ${JSON.stringify(await page.evaluate(() => window.__ml.indoor()))}`);
    const cav = await page.evaluate(() => window.__ml.indoor());
    await page.evaluate(([c, r]) => window.__ml.lookAt(c, r), [sc0 + 0.5, sr0 + 0.5]);
    await page.waitForTimeout(900);
    const caveShot = await shoot("cave");
    // WHICH cells belong to MY room is asked of the LIGHT FIELD, not of the
    // deck. A cave deck's floor can span several separate chambers — the game's
    // room is the 4-connected space around the player — and a chamber on the
    // far side of a rock wall is outside my room and correctly BLACK. Since the
    // whole design is "in my room ⇒ indoor ambient, outside ⇒ exactly zero",
    // a non-zero light AT a cell IS the membership test, and it is the same
    // number the shader uses. So: every cell the light says is mine, and that
    // is on screen, must also be VISIBLE in the picture. A cell that is lit but
    // reads black is one the rock drew over — precisely this section's failure.
    // ONE round-trip for the whole membership query, not one per cell. A cave
    // deck has up to 472 floor cells, and 472 sequential page.evaluate calls
    // take long enough that the SHARED live room can move the player out of the
    // cave underneath the measurement — which is exactly how this section once
    // reported a false failure against a `top` that no longer applied.
    const mineCells = await page.evaluate((cells) => {
      const out = [];
      for (const [c, r] of cells) {
        const l = window.__ml.lightAtCell(c + 0.5, r + 0.5, 0);
        if (0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2] > 0) out.push([c, r]);
      }
      return out;
    }, caveDeck.floor);
    const seen = [];
    for (const [c, r] of mineCells) {
      const s = await cellScreen(c, r);
      const p = patch(caveShot, s.x + 32, s.y + 23, 4);
      if (!p) continue; // off screen
      seen.push({ c, r, ...p });
    }
    if (seen.length < 4)
      fail(`only ${seen.length} cells of this cave are both in my room and on screen — the camera does not frame it`);
    // A cell buried under outside rock reads PURE BLACK — the rock is outside
    // the room, so it is drawn at zero ambient. A cell that is visible reads
    // the cave's own indoor ambient on its floor art. Two bars, because a
    // single sample can sit under a body or a dark tile: nothing may be pure
    // black, and the clear majority must be plainly lit.
    const buried = seen.filter((s) => s.med < 1);
    const dim = seen.filter((s) => s.med < 8);
    if (buried.length || dim.length > seen.length / 4)
      fail(`the cave interior is BURIED at ${(buried.length ? buried : dim).map((s) => `${s.c},${s.r} (median ${s.med.toFixed(1)})`).join("; ")} — ` +
        `outside terrain up to level ${Math.max(...caveDeck.floor.map(([c, r]) => lvl(c + 1, r + 1)))} is drawing over the room, ` +
        `so the cut is not being applied to columns outside the enclosure`);
    // ...and the reason is the cut, not luck: the tallest rock next door really
    // is far above the level the room is cut to.
    const rock = Math.max(...caveDeck.floor.map(([c, r]) => Math.max(lvl(c + 1, r + 1), lvl(c + 1, r), lvl(c, r + 1))));
    if (!(rock > cav.top + 4))
      fail(`the rock beside this cave tops out at level ${rock}, only ${rock - cav.top} above the cut — this proves nothing`);

    // NOTHING STANDS ON GROUND THE CUT REMOVED (maintainer 2026-08-08:
    // "monsters on top of the mountain are drawn when you are inside the
    // cave"). The zero-ambient design draws the outside and lets the light
    // decide — right at MY level, where the ground under a body really is
    // painted. Above the cut nothing is painted at all, so a body up there
    // hangs in the void. A cave is the only shipped place with a populated
    // mountain overhead, which is why this lives here and not with the house.
    // The monster list and the CUT are read in the SAME evaluate, and the
    // indoor verdict with them: this is a shared live room, and a player who
    // died or wandered out between the two reads would be judged against a
    // `top` that no longer applies (measured — that is a false failure, not a
    // leak). If we are no longer inside, say so instead of asserting nonsense.
    const snap = await page.evaluate(() => ({
      st: window.__ml.indoor(),
      raise: window.__ml.indoorRaise(),
      mons: window.__ml.monsterInfo().map((m) => ({
        kind: m.kind, c: +(m.x / 32).toFixed(1), r: +(m.y / 32).toFixed(1),
        lvl: m.surfLevel, culled: !!m.culled,
      })),
    }));
    if (!snap.st.indoor)
      fail(`the player left the cave before the overhead-monster check (indoor=${snap.st.indoor}) — retry`);
    const mons = snap.mons;
    // "Above the cut" is per CELL since the per-wall raise: a body on a raised
    // sill the renderer draws whole (cut == its real level) stands on painted
    // ground and is legitimately visible; everything else compares against the
    // scalar exactly as before. Same rule as the client's aboveCut.
    const cutAtM = (m) => snap.raise.cuts[`${Math.floor(m.c)},${Math.floor(m.r)}`] ?? snap.st.top;
    const overhead = mons.filter((m) => m.lvl > cutAtM(m));
    if (overhead.length < 3)
      fail(`only ${overhead.length} monsters stand above the cut (level ${snap.st.top}) near this cave — the assertion would be vacuous`);
    const floating = overhead.filter((m) => !m.culled);
    if (floating.length)
      fail(`${floating.length} monsters are DRAWN above the cut while indoors: ` +
        `${floating.slice(0, 6).map((m) => `${m.kind}@${m.c},${m.r} level ${m.lvl}`).join("; ")} — ` +
        `the terrain they stand on is not drawn, so they hang in the void`);
    // ...and the rule is about HEIGHT, not about being outside the room: a body
    // at my own level must still be drawn, or this would just be the old
    // "hide everything outside" design coming back in through the side door.
    const atLevel = mons.filter((m) => m.lvl <= cutAtM(m) && !m.culled);
    ok(`nothing stands on ground the cut removed: all ${overhead.length} monsters above level ${snap.st.top} ` +
      `(up to ${Math.max(...overhead.map((m) => m.lvl))}) are not drawn, while ${atLevel.length} at or below it still are`);
    ok(`the cut is WORLD-WIDE: standing in a cave (ceiling ${cav.ceiling}, cut to level ${cav.top}, ${cav.roof} cells under it), ` +
      `all ${seen.length} on-screen floor cells are visible (median ${Math.min(...seen.map((s) => s.med)).toFixed(0)}-${Math.max(...seen.map((s) => s.med)).toFixed(0)}) ` +
      `with level-${rock} rock immediately down-screen`);
  }

  // 8. NO WALL-HACK INTO A ROOM YOU ARE NOT IN (maintainer 2026-08-08: "when
  //    standing next to the mountain wall with the cave inside it I can see the
  //    monsters white outline. They are indoors and I am outdoors, so this
  //    should not be possible... I'm only talking about the white 'wall-hack'
  //    feature now").
  //
  //    The occlusion outline draws at 900_001.43, ABOVE the darkness overlay,
  //    so zero ambient cannot hide it: the only thing that can is refusing to
  //    draw it. Section 7 proved the outline's real job (a body behind YOUR
  //    walls stays readable) — this proves its inverse, from outside.
  //
  //    Stand where the maintainer stood: OUT of the cave, right against the
  //    mountain, with the populated interior behind the rock.
  {
    const outside = await page.evaluate(() => {
      const m = window.__ml.me();
      return { c: m.x / 32, r: m.y / 32 };
    });
    // A PER-FRAME RECORDER, armed BEFORE we leave. The bug this catches lives
    // in the window between the roof coming back (the indoor VERDICT flipping)
    // and the ambient fade finishing ~1s later: read the fade mask instead of
    // the cut and every monster in the cave keeps its outline through solid
    // rock for that whole second (maintainer 2026-08-08: "there is a delay
    // until the white border is removed... we should have no delay here").
    // Sampling after `settle` would miss it entirely — settle WAITS for the
    // fade to end — so this latches the first frame that is already outdoors
    // while the fade is still running.
    await page.evaluate(() => {
      window.__leaveProbe = null;
      const tick = () => {
        const st = window.__ml.indoor();
        if (!window.__leaveProbe && !st.indoor && st.mix > 0)
          window.__leaveProbe = {
            mix: st.mix,
            mons: window.__ml.monsterInfo().map((m) => ({
              kind: m.kind, sealed: !!m.inHiddenRoom, cover: m.coverFrac, ring: m.hiddenFrac,
            })),
          };
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // Walk out of the cave down-screen until the verdict flips to outdoors.
    let stood = false;
    for (let step = 2; step <= 14 && !stood; step += 2) {
      await goTo(outside.c + step, outside.r + step).catch(() => {});
      stood = await settle(false, true, 20000);
    }
    if (!stood)
      fail(`could not get back OUTSIDE the cave for the wall-hack check: ${JSON.stringify(await page.evaluate(() => window.__ml.indoor()))}`);
    await page.waitForTimeout(700);

    const snap = await page.evaluate(() => ({
      st: window.__ml.indoor(),
      mons: window.__ml.monsterInfo().map((m) => ({
        kind: m.kind, c: +(m.x / 32).toFixed(1), r: +(m.y / 32).toFixed(1),
        sealed: !!m.inHiddenRoom, cover: m.coverFrac, ring: m.hiddenFrac, culled: !!m.culled,
      })),
    }));
    if (snap.st.indoor)
      fail("the player is still indoors — the wall-hack check needs to run from OUTSIDE");
    const sealed = snap.mons.filter((m) => m.sealed);
    // NON-VACUITY, and it is the whole point of coverFrac: a sealed body that
    // the rock does not actually cover would not have been outlined by the old
    // code either, so it proves nothing. Require bodies that really are buried.
    const buried = sealed.filter((m) => m.cover > 0.5);
    if (buried.length < 2)
      fail(`only ${buried.length} monsters are both sealed in a room and covered by rock from here ` +
        `(${sealed.length} sealed in total, ${snap.mons.length} nearby) — this assertion would be vacuous`);
    const leaking = buried.filter((m) => m.ring > 0);
    if (leaking.length)
      fail(`${leaking.length} monsters INSIDE a room show their occlusion outline from outside: ` +
        `${leaking.slice(0, 6).map((m) => `${m.kind}@${m.c},${m.r} (${Math.round(m.ring * 100)}% of the body outlined through the rock)`).join("; ")} — ` +
        `the outline draws above the darkness overlay, so this is a wall-hack`);
    // ...and the outline is not simply dead everywhere: bodies out here in the
    // open that a cliff or a tower covers must STILL be outlined, or this would
    // be "switch the feature off" wearing a disguise.
    const openAir = snap.mons.filter((m) => !m.sealed && !m.culled && m.cover > 0.5);
    const stillDrawn = openAir.filter((m) => m.ring > 0);
    if (openAir.length && !stillDrawn.length)
      fail(`${openAir.length} monsters out in the open are covered by terrain and NONE is outlined — ` +
        `the room gate is hiding outlines it should not (that is the feature switched off, not fixed)`);
    // THE SAME FRAME THE ROOF IS BACK. The recorder above latched the first
    // frame that was outdoors with the fade still mid-flight; nothing sealed in
    // the cave may be outlined even there.
    const mid = await page.evaluate(() => window.__leaveProbe);
    if (!mid)
      fail("never caught a frame that was outdoors with the ambient fade still running — the leave probe cannot judge the delay");
    const midSealed = mid.mons.filter((m) => m.sealed && m.cover > 0.5);
    // NON-VACUITY, and it bit: the first version of this check reported
    // "none of the 0 sealed monsters is outlined" and PASSED against code that
    // still had the delay. The cave's population wanders, so the latched frame
    // may simply contain nobody buried — that is a no-measurement, not a pass.
    if (!midSealed.length)
      fail(`the frame latched on leaving the cave (mix ${mid.mix.toFixed(3)}) held no sealed, buried monster ` +
        `out of ${mid.mons.length} nearby — nothing was measured, retry`);
    const midLeak = midSealed.filter((m) => m.ring > 0);
    if (midLeak.length)
      fail(`${midLeak.length} monsters keep their outline through the rock on the first frame after the roof came back ` +
        `(fade still at mix ${mid.mix.toFixed(3)}): ${midLeak.slice(0, 5).map((m) => `${m.kind} ${Math.round(m.ring * 100)}%`).join("; ")} — ` +
        `the gate is reading the FADE mask instead of the cut, so the border outlives the roof by a whole fade`);
    ok(`the border dies with the roof: on the first frame outdoors (fade still at mix ${mid.mix.toFixed(3)}) ` +
      `none of the ${midSealed.length} sealed monsters is outlined`);
    ok(`no wall-hack into the cave: all ${buried.length} monsters sealed under its roof (up to ` +
      `${Math.round(Math.max(...buried.map((m) => m.cover)) * 100)}% buried) draw NO outline from outside` +
      (stillDrawn.length ? `, while ${stillDrawn.length} covered by open-air terrain still do` : ""));
  }

  // 9. A TAP WALKS YOU AS CLOSE TO THE MARKER AS YOU CAN GET (maintainer
  //    2026-08-08: "the user always walks as close as he/she can get to the
  //    marker... the house I'm clicking on doesn't even have a valid route to
  //    get on top of it, so it must have meant the underside").
  //
  //    From OUTSIDE, the house's roof slab is drawn, so a tap on the house
  //    resolves to the roof — level 6. A level-6 cell's FLOOR draws 6*lh = 96px
  //    BELOW the finger, so targeting a roof with no ramp left the player a
  //    storey under the beacon. Both surfaces are now routed and the one that
  //    can actually be reached wins, beacon included.
  //
  //    THE METRIC IS SCREEN Y, NOT THE CELL. With the finger over a cell's own
  //    roof, the broken and the fixed walk end at the same (col+row) — the whole
  //    error is the LEVEL arrived on, so comparing cells passes either way.
  //    Measured: a first cut of this section did exactly that and reported
  //    "0.0 cells off the finger" against code that still had the bug.
  {
    const HALF_CELL_Y = 24; // px — the bar for "landed where you tapped"
    await stand(184.5, 122.5, false, true);
    await page.evaluate(() => window.__ml.lookAt(180, 118));
    await page.waitForTimeout(700);

    const probe = await page.evaluate(() => {
      const dy = 15, lh = 16; // ISO_DY / LEVEL_PX (shared)
      const s = window.__ml.cellScreen(179, 117);
      if (!s) return { err: "cellScreen null" };
      const cellWorldY = s.y / s.zoom + s.camY;        // that cell's drawn top
      const oy = cellWorldY - (179 + 117) * dy + s.level * lh;
      const wx = s.x / s.zoom + s.camX;
      const wyRoof = cellWorldY - (6 - s.level) * lh;  // a pixel of ROOF SLAB
      const r = window.__ml.tapPoint(wx, wyRoof);
      if (!r) return { err: "tapPoint returned null (void/solid)" };
      window.__tapScreen = { sx: s.x, sy: s.y - (6 - s.level) * lh * s.zoom };
      // TWO PROPERTIES, and the second is the one that keeps getting broken:
      //   (a) the walk ARRIVES on the surface it chose, and
      //   (b) THE BEACON STAYS ON THE PIXEL THAT WAS CLICKED.
      // The two readings of this click are the roof and the ground drawn at the
      // same pixel — a cell 6.4 up-screen — so resolving between them must not
      // shift the marker at all.
      const endY = oy + ((r.target.x + r.target.y) / 32) * dy - (r.goalLevel ?? 0) * lh;
      const m = window.__ml.marker();
      return { picked: r.picked, target: r.target, goalLevel: r.goalLevel, endLevel: r.endLevel,
               markerY: m ? m.y : null, markerOffFinger: m ? m.y - wyRoof : null,
               walkOffMarker: m ? endY - m.y : null, wouldBe: 6 * lh };
    });
    if (probe.err) fail(`section 9 could not tap the roof: ${probe.err}`);
    if (probe.picked.lvl !== 6)
      fail(`the tap on the house resolved to level ${probe.picked.lvl}, not the roof slab — ` +
        `section 9 is not exercising the ambiguous-cell path at all`);
    // AIMED AT 179,117 ON PURPOSE. The ground drawn at a roof pixel is the cell
    // 3.2 up-screen in BOTH axes, and for 178,117 that is 173,113 — a dividing
    // WALL (col 173, rows 111-113), which has no floor reading at all. 179,117
    // reads back to 175,113, real interior floor, so this fixture exercises the
    // case that matters instead of the one degenerate pixel.
    if (probe.markerY === null) fail("no destination beacon was placed by the tap");
    // (b) THE MARKER MUST NOT MOVE. Twice now the "fix" was to drop the beacon
    // onto whatever the walk could reach, which offsets the player's own input:
    // "now you move the marker to a spot I didn't click on".
    if (Math.abs(probe.markerOffFinger) > HALF_CELL_Y)
      fail(`the beacon moved ${probe.markerOffFinger.toFixed(0)}px from the pixel that was clicked — ` +
        `resolving the two readings must never shift the marker, they are the same pixel`);
    // (a) ...and the walk ends there too.
    // (a) THE WALK ENDS AT THE MARKER. Not under it: "you don't walk to the
    // marker — you walk the player under it" is the whole complaint, and under
    // is exactly 6*lh = 96px of screen y away.
    if (Math.abs(probe.walkOffMarker) > HALF_CELL_Y)
      fail(`the walk ends ${probe.walkOffMarker.toFixed(0)}px below the beacon (the roof-vs-floor ` +
        `projection is ${probe.wouldBe}px) — target ${(probe.target.x / 32).toFixed(1)},` +
        `${(probe.target.y / 32).toFixed(1)} at level ${probe.goalLevel}`);
    // AND NOW THE REAL GESTURE. Everything above went through `tapPoint`, which
    // calls setMoveTarget directly — but a real tap is pointerdown followed by
    // holdRepath re-planning 50ms later and again on release, and THAT path
    // dropped the pick point, so the two-reading resolution was computed once
    // and thrown away a frame later. The feature never ran on a real click and
    // no probe-driven gate could see it (maintainer 2026-08-08: "I click behind
    // the wall and the player runs inside the house").
    const tap = await page.evaluate(() => window.__tapScreen);
    await page.mouse.click(tap.sx, tap.sy);
    await page.waitForTimeout(900); // past the 50ms replan AND the release commit
    const real = await page.evaluate(() => {
      const t = window.__ml.target();
      const m = window.__ml.marker();
      return t && m ? { tx: t.x / 32, ty: t.y / 32, my: m.y } : null;
    });
    if (!real) fail("a real click started no trip at all");
    const drift = Math.hypot(real.tx - probe.target.x / 32, real.ty - probe.target.y / 32);
    if (drift > 1.5)
      fail(`a REAL click lands ${drift.toFixed(1)} cells from where the same tap resolves through the ` +
        `probe (${real.tx.toFixed(1)},${real.ty.toFixed(1)} vs ${(probe.target.x / 32).toFixed(1)},` +
        `${(probe.target.y / 32).toFixed(1)}) — the hold re-plan is dropping the pick point, so the ` +
        `two readings are never compared on a real tap`);
    ok(`a REAL click resolves the same as the probe (${real.tx.toFixed(1)},${real.ty.toFixed(1)}) — the ` +
      `pick point survives the hold re-plan and the release commit`);
    ok(`the walk ends AT the marker, and the marker never moved: the tap picked level ${probe.picked.lvl}, ` +
      `the routing chose the floor drawn at that same pixel (level ${probe.goalLevel}, cell ` +
      `${(probe.target.x / 32).toFixed(1)},${(probe.target.y / 32).toFixed(1)}), the beacon sits ` +
      `${Math.abs(probe.markerOffFinger).toFixed(0)}px from the clicked pixel and the walk ends ` +
      `${Math.abs(probe.walkOffMarker).toFixed(0)}px from it (it used to stop ${probe.wouldBe}px under)`);
  }

  if (errs.length) fail(`page errors: ${errs.slice(0, 3).join(" | ")}`);
  console.log("\nverify-indoor: ALL OK");
} finally {
  await browser.close();
}
