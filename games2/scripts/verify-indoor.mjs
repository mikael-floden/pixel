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
  const outsidePoints = async () => {
    const cs = [
      [Math.min(...deckCells.map(([c]) => c)) - 2, roomR],
      [Math.max(...deckCells.map(([c]) => c)) + 2, roomR],
      [roomC, Math.min(...deckCells.map(([, r]) => r)) - 3],
      [roomC, Math.max(...deckCells.map(([, r]) => r)) + 3],
      [Math.max(...deckCells.map(([c]) => c)) + 2, roomR + 3],
    ];
    const out = [];
    // A WIDE patch (17x17) on purpose: the ambient layer's fireflies are ~5x5
    // glowing sprites and a small window lets one of them swing the median.
    for (const [c, r] of cs) {
      const s = await cellScreen(c, r);
      const pt = { c, r, rad: 8, x: s.x + 32, y: s.y + 23 };
      if (inView(pt)) out.push(pt);
    }
    if (out.length < 4) fail(`only ${out.length} outdoor sample cells are on screen — the house no longer fits the frame`);
    return out;
  };
  //   WALL inward faces — the 32px half the maintainer wants kept. Sampled one
  //   level down the face stack (y+39), on the half that looks into the room.
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
  ok(`outdoors reference frame captured from ${OUTSIDE_SPOT[0]},${OUTSIDE_SPOT[1]} (camera pinned on ${roomC},${roomR})`);

  // =========================================================================
  // 2. INDOORS — stand under the roof.
  // =========================================================================
  await stand(roomC + 0.5, roomR + 0.5, true, true);
  const inn = await page.evaluate(() => window.__ml.indoor());
  if (!inn.indoor) fail(`standing at ${roomC},${roomR} is not indoors: ${JSON.stringify(inn)}`);
  if (inn.roofLevel !== roofDeck.level) fail(`roofLevel ${inn.roofLevel} != the deck's ${roofDeck.level}`);
  if (inn.roof !== interior.length) fail(`${inn.roof} cells under the roof, world.json says ${interior.length}`);
  if (inn.wallLeft !== wallLeft.length || inn.wallRight !== wallRight.length)
    fail(`wall sets ${inn.wallLeft}/${inn.wallRight} != the world's ${wallLeft.length}/${wallRight.length}`);
  if (inn.capped) fail("the roof fill was capped — indoor must fail OUTDOORS in that case");
  if (!(inn.mask >= interior.length + wallLeft.length))
    fail(`the per-cell mask (${inn.mask}) is smaller than roof+walls — nothing would be drawn for some cells`);
  ok(`indoors: roof ${inn.roof} cells at level ${inn.roofLevel}, wallRatio ${inn.wallRatio}, depth ${inn.depth}, ceiling cut ${inn.ceiling}`);

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
  const roofIn = measure(inShot, roofP);
  const roofInMean = roofIn.reduce((a, s) => a + s.med, 0) / roofIn.length;
  const voidFrac = roofIn.reduce((a, s) => a + s.black, 0) / roofIn.length;
  const kept = roofIn
    .map((s, i) => ({ s, o: roofOut[i] }))
    .filter(({ s, o }) => s.med > o.med * 0.6);
  if (kept.length)
    fail(`roof art survived at ${kept.map(({ s, o }) => `${s.c},${s.r} (median ${s.med.toFixed(0)} of ${o.med.toFixed(0)})`).join("; ")}`);
  const drop = 1 - roofInMean / roofOutMean;
  if (drop < 0.7) fail(`the roof only got ${(drop * 100).toFixed(0)}% darker (${roofOutMean.toFixed(1)} -> ${roofInMean.toFixed(1)}) — it is still being drawn`);
  if (voidFrac < 0.2)
    fail(`only ${(voidFrac * 100).toFixed(0)}% of the roof's pixels are pure void — the slab is still there`);
  ok(`the roof is REMOVED: every one of ${roofIn.length} roof cells lost >40% of its median luminance, ` +
    `mean ${roofOutMean.toFixed(1)} -> ${roofInMean.toFixed(1)} (-${(drop * 100).toFixed(0)}%), ` +
    `${(voidFrac * 100).toFixed(0)}% of those pixels now pure void (0% outdoors)`);

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

  // -- 2c. THE INWARD WALL FACES ARE STILL DRAWN ----------------------------
  // The bar is "drawn", not "bright". It was 8 when the surface resolve still
  // reported the ROOF's height for every cell under it — which put the floor
  // and the wall tops at the SAME z, so the torch lit both equally and the
  // walls measured 12-16. With the resolve corrected (uIndoor, nightlight.ts)
  // a waist-height torch lights the FLOOR strongly and the upper wall weakly,
  // exactly as it should: the floor's screen luminance went up 8x while these
  // faces settled to 6-8. Dropping the bar to 4 keeps what this test is FOR —
  // the inward half must still be painted, and the outward half + tile top
  // must still be void, which the very next assertion checks against the same
  // frame. Anything actually culled reads 0 and still fails.
  const wallIn = measure(inShot, wallP);
  const gone = wallIn.filter((s) => s.black > 0.05 || s.med < 4);
  if (gone.length)
    fail(`inward wall faces are missing at ${gone.map((s) => `${s.c},${s.r}${s.side} (mean ${s.mean.toFixed(1)}, ${(s.black * 100).toFixed(0)}% void)`).join("; ")}`);
  ok(`all ${wallIn.length} FAR walls still show the face that looks into the room ` +
    `(median luminance ${Math.min(...wallIn.map((s) => s.med)).toFixed(1)}-${Math.max(...wallIn.map((s) => s.med)).toFixed(1)}, no void pixels)`);

  // -- 2d. ...AND ONLY THAT FACE — "not the entire tile" -------------------
  // The counter-sample sits on the OUTWARD half, on the tile TOP's own row
  // (y+23 = the diamond's W/E corners). Outdoors that pixel is solid roof/wall
  // art; indoors both the top diamond (it is at ceiling level) and the outward
  // face half must be gone, so it has to be pure void.
  //
  // EXCEPT where another wall's legitimately-drawn inward half lands on it:
  // wall cells one iso step apart share an x band (32px) and their 144px face
  // stacks overlap, so an inner-corner neighbour can occupy a cell's whole
  // outward half. That is not a defect, so it is EXCLUDED — and computed, not
  // hand-listed: every other wall's drawn rectangle is derived from its own
  // cellScreen + the ceiling cut and tested for containment.
  const wallBoxes = [];
  for (const [set, side] of [[wallRight, "R"], [wallLeft, "L"]])
    for (const [c, r] of set) {
      const s = await cellScreen(c, r);
      const hi = Math.min(s.level, inn.ceiling); // face levels drawn: 0 .. hi-1
      wallBoxes.push({
        c, r, side, s,
        // the drawn half: 32px wide, and the union of the stacked face tiles
        x0: s.x + (side === "R" ? 32 : 0), x1: s.x + (side === "R" ? 64 : 32),
        y0: s.y + (s.level - hi + 1) * 16, y1: s.y + s.level * 16 + 64,
      });
    }
  const hits = (b, x, y) => x >= b.x0 - 3 && x <= b.x1 + 3 && y >= b.y0 - 3 && y <= b.y1 + 3;
  // TWO counter-samples per wall, because the 15px iso stagger means no single
  // one can answer both halves of the claim:
  //   +23  the tile TOP's own row. Sitting above the next cell's stack, it is
  //        free on most walls, and it is where a re-drawn ceiling-level TOP
  //        would appear.
  //   +100 deep in the face stack, where a re-drawn OUTWARD FACE half would be
  //        solid. Free only at the END of a run — mid-run, the cell one iso
  //        step down-screen legitimately draws its own inward half right there.
  const probeWalls = (dy, label) => {
    let n = 0;
    const skipped = [];
    const whole = [];
    for (const b of wallBoxes) {
      const x = b.s.x + (b.side === "R" ? 10 : 54);
      const y = b.s.y + dy;
      if (wallBoxes.some((o) => o !== b && hits(o, x, y))) { skipped.push(`${b.c},${b.r}`); continue; }
      const p = patch(inShot, x, y, 6);
      if (!p) fail(`outward-half sample for ${b.c},${b.r} fell off screen`);
      if (p.med >= 1) whole.push(`${b.c},${b.r}${b.side} ${label} (median ${p.med.toFixed(1)}, ${(p.black * 100).toFixed(0)}% void)`);
      n++;
    }
    if (whole.length)
      fail(`wall tiles are drawn WHOLE at ${whole.join("; ")} — the maintainer asked for "only the part that faces the inside. Not the entire tile"`);
    return { n, skipped };
  };
  const topCut = probeWalls(23, "tile top");
  const faceCut = probeWalls(100, "outward face");
  if (topCut.n * 2 < wallBoxes.length || faceCut.n < 1)
    fail(`the 32px-cut test went vacuous: ${topCut.n}/${wallBoxes.length} tops and ${faceCut.n} outward faces were answerable`);
  ok(`and ONLY that face: the roof-level tile TOP is void on ${topCut.n} of ${wallBoxes.length} walls, and the OUTWARD ` +
    `face half is void on the ${faceCut.n} run-end wall(s) where it is answerable at all ` +
    `(skipped ${[...new Set([...topCut.skipped, ...faceCut.skipped])].join(" ")} — an inner-corner neighbour's own inward face covers them)`);

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
  // Indoors must still be UNMISTAKABLY darker than standing in the sun. The
  // bar was 0.15, written when the indoor grade was pinned to night's own
  // luma; the brightness experiment (INDOOR_BRIGHTNESS, WorldScene) lifts it,
  // so this is the ceiling on the experiment rather than a restatement of it —
  // a third of daylight is still "you walked indoors", and anything above that
  // is not a room any more.
  if (lIn > 0.3 * luma(ambDay))
    fail(`indoors at Day is not dark: luma ${lIn.toFixed(4)} vs ${luma(ambDay).toFixed(4)} outside`);
  // THE INTERIOR IS NOW A SETTINGS SLIDER (indoorlight.ts, maintainer
  // 2026-08-06: "0% = BLACK, 100% = THE TILE WILL LOOK JUST LIKE THE PNG"), so
  // this measures it AT ITS DEFAULT — which is chosen to reproduce the
  // night-matched grade exactly, and that is the property worth pinning: a
  // player who never touches the slider must get the tuned look. The slider's
  // own two ends are asserted separately below.
  const k = lIn / lNight;
  if (Math.abs(k - 1) > 0.25)
    fail(`the DEFAULT indoor grade is ${k.toFixed(2)}x night's luma — the untouched ` +
      `slider must land on the tuned "dark as during the night" grade`);
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
  ok(`indoor ambient sits on night's hue line and is less blue: luma ${lIn.toFixed(5)} = ${k.toFixed(2)}x night ${lNight.toFixed(5)} ` +
    `(${((lIn / lNight - 1) * 100).toFixed(1)}%), B/R ${blueIn.toFixed(3)} vs ${blueNight.toFixed(3)} ` +
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
