// verify-tiles3 — maps2/worlds3/the_game LOADS, DRAWS and IS WALKABLE.
//
// This is the gate for the second art source. A `pixel-maps3/world@1` cell
// names a GROUND and no art at all: the plate, the fade, the composed boundary
// and the wall stack are resolved at draw time (tiles3.ts / tiles3runtime.ts /
// tiles3draw.ts) and the scenery is placed off the grid (scenery3.ts). Those
// four modules are proven cell-for-cell against maps2/pipeline/render3.py by
// server/test/tiles3*.test.ts. What NO unit test can say is whether the wiring
// puts any of it on a screen a player is standing in — so everything below is
// asserted on the live dev stack, on real canvas pixels and on the
// authoritative server position.
//
// THE FAILURE MODE THIS EXISTS TO END is silent: an unparsed world falls back
// to the empty 160x160 plain and the game still boots, still joins, still
// renders green. Section 1 therefore asserts the GRID SIZE (512x512) before
// anything else, and every later section is pinned to cells that only exist in
// the_game.
//
// TWO INSTRUMENTS, and both are needed:
//   • `__ml.t3at(col,row)` — the resolver's verdict for ONE cell plus the blits
//     the texture factory can actually hand the RenderTexture right now. A
//     screenshot cannot tell "the fade tile drew" from "the plate under it
//     drew" (same ground, nearly the same colour), and it cannot tell a cell
//     that resolved to nothing from a window that is empty.
//   • real pixels. The counters cannot tell a composed texture that landed on
//     screen from one that was built and never blitted.
// An assertion that can be satisfied by one alone is made with one alone.
//
// EVERY COORDINATE BELOW IS DERIVED FROM maps2/worlds3/the_game/world.json and
// the reason is stated at the constant. Re-derive them with the same rules if
// the maps2 agent re-authors that corner of the island; do NOT relax a
// threshold to make a moved cell pass.
//
// Needs the dev stack (npm run dev: vite :5173 + colyseus :2567).
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const WORLD = "the_game"; // maps2/worlds3 — pixel-maps3/world@1
const ISLAND = "the_island2"; // maps2/worlds — world@2, what players are on today

/* -- the world's own numbers ------------------------------------------------ */

// the_game's grid. The whole point of section 1: the silent fallback is a
// 160x160 plain, so a wrong size is the one symptom that says "the maps3 parse
// did not happen" while everything else still looks alive.
const W3 = 512;
// tiles3's projection (shared ISO_GEOMETRY_MAPS3). tiles2 is 32/15/16; a v3
// world draws on 32/14/**15** — the storey pitch measured off the wall art.
const GEOM3 = { dx: 32, dy: 14, lh: 15 };

// Art-box geometry, from tiles3.ts. A cell's 64-wide art box has its top
// diamond apex TOP_Y rows down and the diamond is 2*DY tall, so the diamond
// CENTRE is (TILE/2, TOP_Y + DY) inside the box — and `__ml.cellScreen` returns
// the box's top-left in CSS px.
const TILE = 64;
const TOP_Y = 10;
const DY = 14;
const LH = 15; // one storey of a wall stack, on screen

// The camera background. With a world loaded WorldScene paints #181c28 behind
// everything; the empty-plain fallback paints #1b3327. A sample that matches
// either is a hole in the map.
const VOID_WORLD = [0x18, 0x1c, 0x28];
const VOID_PLAIN = [0x1b, 0x33, 0x27];

/* THE COAST FRAME — one camera position that carries four of the six things
 * this gate has to see. Around (413,211) the island's east shore runs as a
 * clean diagonal: grass to col 411, a ONE-CELL light_beach strip, then water,
 * every cell at level 0 (world.json `level`), no scenery within ±3 and no deck.
 * That gives, in a SINGLE screenshot, three grounds whose art has nothing in
 * common, plus the fade band and the composed boundary between two of them. */
const COAST = { at: [413, 211] };
// Clean field cells — the 3x3 around each is one ground at one level, so no
// boundary quad touches their own diamond and nothing taller stands in front.
const COAST_GRASS = [409, 209];
const COAST_WATER = [416, 208];
// The beach STRIP itself is one cell wide, so it can never be "clean" — it is
// sampled as the third colour only, never as a plain plate.
const COAST_BEACH = [413, 211];
/* FADE — and it is NOT on the coast. The band is a probabilistic CHEBYSHEV scan
 * from RING 1, and the pool is APPROVED ONLY: he has approved 480 of the 3,575
 * fade tiles, and grass<->light_beach is one of the pairs with NOTHING approved,
 * so no cell of this coastline can ever fade. Over the whole world 249 cells
 * do, on 8 pairs. (293,331) is snow on the level-32 snow line with black_rock at
 * RING 1 — the ring the old axis-from-2 scan skipped, which is exactly the
 * behaviour this pins. Its 7x7 is flat, deckless and free of scenery, so the
 * pixel under it is the fade tile and nothing else. */
const FADE_CELL = [293, 331];
const FADE_OTHER = "black_rock";
const FADE_RING = 1;
// BOUNDARY. The lattice corner anchored at (411,208) spans (411,208) grass,
// (412,208) light_beach, (411,209) grass, (412,209) light_beach — exactly two
// grounds, all four at level 0, which is the whole condition for a composed
// transition. The Wang index is built as 8·a + 4·b + 2·c + 1·d over those four
// corners against whichever ground took the `b` side role, so this quad's two
// EAST corners share a side: index 5 when b is light_beach, 10 when b is grass.
const BOUNDARY_CELL = [411, 208];
const BOUNDARY_PAIR = ["grass", "light_beach"];
const BOUNDARY_INDEX = [5, 10];

/* TWO MORE GROUNDS, from the other side of the island, so five distinct plates
 * are proven and not just one coastline. Both are level-0 cells whose 3x3 is
 * one ground at one level, with no scenery within ±3 and no deck: a stone shelf
 * on the south cape, and open sea. A liquid is a ground with a base tile set
 * like any other now — the maintainer chose all 16 water members — and draws
 * its surface's TOP FACE, never a flat painted diamond and never a wall. */
const STONE_CELL = [445, 453];
const SEA_CELL = [455, 405];

/* THE CLIFF. (405,209) is grass at level 6; the two down-screen neighbours
 * (406,209) and (405,210) are both level 0, so the column is CAPPED and its
 * stack runs f = 0..6 — seven storeys. Centred on itself the cap's diamond sits
 * at the frame's middle and six of the seven storeys fall inside the canvas. */
const CLIFF = [405, 209];
const CLIFF_LEVEL = 6;
const CLIFF_STOREYS = 7; // level 6 down to frontLow 0, inclusive
const CLIFF_ON_CANVAS = 6; // the seventh lands below the 198px game view

/* SCENERY. the_game places 1,388 pieces; the densest camera window in the doc
 * is around (338,382) (22 anchors inside the view proper, more once the
 * renderer's 200px pad is counted). */
const SCENERY_AT = [338, 382];

/* WALKING. (411,221) is the middle of a radius-5 patch of dry level-0 grass —
 * nothing to bump into in any direction. */
const OPEN = [411, 221];

/* BLOCKED. (186,407) is a one-cell notch of level-0 grass cut into a level-6
 * escarpment: (185,407), (187,407) and (186,408) are all level 6, and only
 * (186,406) to the north is level 0. A 6-level step is far past JUMP_CLIMB (2),
 * so three of the four screen directions are a wall and the fourth is the
 * control that proves the input had force. */
const POCKET = [186.5, 407.5];
const POCKET_LEVEL = 0;

/* -- plumbing --------------------------------------------------------------- */

const fail = (m) => {
  throw new Error(m);
};
const ok = (m) => console.log(`ok - ${m}`);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let page;
try {
  // 480x320 — the small starvation-proof viewport every gate on this harness
  // uses. It puts WorldScene.zoomFor() on zoom 1 (checked below, because every
  // pixel offset here is multiplied by it) and keeps the ground redraw inside
  // the software-GL frame budget.
  const ctx = await browser.newContext({ viewport: { width: 480, height: 320 } });
  page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 180)));
  const bad = [];
  page.on("response", (r) => {
    if (r.status() >= 400) bad.push(`${r.status()} ${r.url().slice(-90)}`);
  });

  /** Boot straight into a world: the picker's own remembered choice plus the
   *  rejoin flag, then a reload — the same path a returning player takes, and
   *  the only one that reaches a world without driving the select screen. */
  const join = async (world) => {
    await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.evaluate((w) => {
      localStorage.setItem(
        "ml-last-choice",
        JSON.stringify({ world: w, characterUid: "default_boy", name: "Tiles3" }),
      );
      sessionStorage.setItem("ml-rejoin", "1");
    }, world);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 120000 })
      .catch(() => fail(`never joined ${world} — no player in the room after 120s`));
    await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 60000 }).catch(() => {});
    await page.bringToFront();
    // The DOM HUD is fixed-position chrome ON TOP of the canvas — bars, chat
    // log, clock, wiki button. Hiding it changes nothing Phaser draws (the
    // canvas lives in a static #game box of its own height, so nothing
    // reflows); it only stops cream-coloured panels from answering a pixel
    // question about the world. Injected as a stylesheet so the HUD's own
    // per-frame re-render cannot undo it.
    await page.addStyleTag({
      content: ".ml-bars,.ml-chatlog,.ml-clock,.ml-wikibtn,.ml-hud{visibility:hidden!important}",
    });
    // Pin the light: at Day the ambient is 1,1,1 and a sampled ground reads its
    // own art. The world clock has to be STOPPED first or the server's phaseT
    // patches overwrite the pinned keyframe within a frame or two.
    await page.evaluate(() => window.__ml.timeSpeed(0));
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      window.__ml.timeOfDay("Day", true);
      window.__ml.aurora(false, true);
      window.__ml.weather(0, true);
    });
    await page.waitForTimeout(600);
  };

  /** Wait for the streaming terrain to STOP moving: no art still in flight and
   *  THREE consecutive polls that drew exactly the same thing.
   *
   *  A fixed sleep is the wrong instrument — on this software-GL harness a
   *  ground redraw plus its plate batch takes seconds. Three polls, not two:
   *  the ground RT redraws on its own camera-drift latch, so one poll taken
   *  immediately after the camera moves can still be reading the PREVIOUS
   *  window's counters, and two equal reads of a stale number look exactly like
   *  a settled frame. */
  const settle = async (what, timeout = 60000) => {
    await page.evaluate(() => {
      window.__t3prev = null;
      window.__t3run = 0;
    });
    await page
      .waitForFunction(
        () => {
          const t = window.__ml?.tiles3?.();
          if (!t || !t.ready) return false;
          const key = `${t.drew.cells}|${t.drew.blits}|${t.drew.boundaries}|${t.drew.decks}|${t.drew.scenery}`;
          const still =
            (t.art?.pending ?? 0) === 0 &&
            (t.pieces ? t.pieces.requested === t.pieces.loaded + t.pieces.failed : true);
          window.__t3run = window.__t3prev === key && still ? window.__t3run + 1 : 0;
          window.__t3prev = key;
          return window.__t3run >= 3;
        },
        { timeout, polling: 500 },
      )
      .catch(async () => {
        const t = await page.evaluate(() => window.__ml.tiles3());
        fail(`${what}: the terrain never settled — ${JSON.stringify(t)}`);
      });
  };

  /** Move the camera off the avatar and onto a cell, then let it settle. */
  const look = async (col, row, what) => {
    await page.evaluate(([c, r]) => window.__ml.lookAt(c, r), [col, row]);
    await page.waitForTimeout(500); // the ground RT relatches on camera drift
    await settle(what);
  };

  const shoot = async (name) => {
    const buf = await page.screenshot();
    if (process.env.SHOT_DIR) {
      const { writeFileSync } = await import("node:fs");
      const { join: pjoin } = await import("node:path");
      writeFileSync(pjoin(process.env.SHOT_DIR, `tiles3-${name}.png`), buf);
    }
    return PNG.sync.read(buf);
  };

  /** The MEDIAN colour of a square of real pixels. A median, not a mean: the
   *  ambient agent's birds and the weather layer draw scattered single pixels
   *  over the ground, and a mean lets them drag a sample; a solid diamond of
   *  terrain fills the whole patch and survives either way. */
  const patch = (img, x, y, r = 3) => {
    const ch = [[], [], []];
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const px = Math.round(x + dx);
        const py = Math.round(y + dy);
        if (px < 0 || py < 0 || px >= img.width || py >= img.height) return null;
        const i = (py * img.width + px) * 4;
        ch[0].push(img.data[i]);
        ch[1].push(img.data[i + 1]);
        ch[2].push(img.data[i + 2]);
      }
    return ch.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
  };

  /** Where a cell's top-diamond centre is on screen, right now. */
  const cellCentre = async (col, row) => {
    const cs = await page.evaluate(([c, r]) => window.__ml.cellScreen(c, r), [col, row]);
    if (!cs) fail(`cellScreen(${col},${row}) is null — off the map, or no world loaded`);
    return { x: cs.x + (TILE / 2) * cs.zoom, y: cs.y + (TOP_Y + DY) * cs.zoom, zoom: cs.zoom, cs };
  };

  const t3at = async (col, row) => {
    const v = await page.evaluate(([c, r]) => window.__ml.t3at(c, r), [col, row]);
    if (!v) fail(`__ml.t3at(${col},${row}) is null — the tiles3 runtime is not built for this world`);
    return v;
  };

  /** THE LIGHT AT A CELL, and why every colour assertion below needs it.
   *
   *  The night shader is a MULTIPLY over the whole frame, so a sampled pixel is
   *  `art x light` — and the light is per cell, not per frame. Measured at
   *  pinned Day on the_game: 1.0 in the open, and exactly 0.55 on the cells
   *  under the east coast's level-6 cliff, which stand in the directional sun's
   *  own shadow. Comparing two grounds lit at 1.0 and 0.55 as raw pixels is
   *  comparing nothing, so every ground colour below is divided by this before
   *  it is compared with another. The value is MEASURED rather than asserted:
   *  the gate is about the terrain, not about the lighting agent's tuning. */
  const lightAt = async (col, row) => {
    const l = await page.evaluate(([c, r]) => window.__ml.lightAtCell(c, r, 0), [col, row]);
    if (!l) fail(`no CPU light at ${col},${row} — the night shader never built its height map`);
    const k = (l[0] + l[1] + l[2]) / 3;
    if (!(k > 0.15))
      fail(`the light at ${col},${row} is ${k.toFixed(3)} — too dark to judge a colour by; the Day pin did not take`);
    return k;
  };
  const unlit = (c, k) => c.map((v) => v / k);

  const notVoid = (name, c, k) => {
    // Against the void BOTH ways, because the multiply overlay covers the
    // camera background too: an undrawn cell reads either the raw background or
    // the background under this cell's own light, and neither may be a match.
    // The bar is 12. GRASS is the tightest case in the whole gate — measured
    // rgb(13,45,32) at light 0.55, which is 20.3 from #1b3327 x 0.55 — because
    // grass really is a dark green; every other ground here is 41 or more from
    // both voids. What proves the ground DREW is the spread between grounds
    // below; this check catches one cell going missing while its neighbours
    // still paint.
    for (const [why, v] of [
      ["the loaded-world void #181c28", VOID_WORLD],
      ["the empty-plain void #1b3327", VOID_PLAIN],
      ["the loaded-world void under this cell's own light", VOID_WORLD.map((x) => x * k)],
      ["the empty-plain void under this cell's own light", VOID_PLAIN.map((x) => x * k)],
    ]) {
      const d = dist(c, v);
      if (d < 12) fail(`${name} sampled ${rgb(c)} — only ${d.toFixed(1)} from ${why}: nothing drew on that cell`);
    }
  };

  /* ======================================================================== */
  /* 1. THE WORLD LOADS AS MAPS3                                              */
  /* ======================================================================== */
  await join(WORLD);

  const info = await page.evaluate(() => window.__ml.worldInfo());
  if (info.name !== WORLD) fail(`joined "${info.name}", not ${WORLD}`);
  if (info.w !== W3 || info.h !== W3)
    fail(
      `the parsed world is ${info.w}x${info.h}, not ${W3}x${W3} — this is the SILENT FALLBACK ` +
        `(world.json missing, unparsed, or not routed to maps2/worlds3): the game booted onto the empty plain`,
    );
  if (info.maps2 !== false) fail(`${WORLD} is being read as a maps2 world (maps2=${info.maps2})`);
  const mini = await page.evaluate(() => window.__ml.minimap());
  if (mini.world !== WORLD || !(mini.col >= 0 && mini.col < W3 && mini.row >= 0 && mini.row < W3))
    fail(`the player is not standing in ${WORLD}: ${JSON.stringify(mini)}`);

  const t3 = await page.evaluate(() => window.__ml.tiles3());
  if (!t3.on) fail("tiles3 is OFF — parseWorld3 did not publish `iso`, so nothing resolves art");
  for (const k of ["ready", "sheets", "textures"])
    if (!t3[k]) fail(`tiles3.${k} is false — the runtime never built (${JSON.stringify(t3)})`);
  for (const [k, v] of Object.entries(GEOM3))
    if (t3.geom[k] !== v)
      fail(`the scene draws ${WORLD} at ${k}=${t3.geom[k]}, not the maps3 ${k}=${v} — the projection is wrong`);
  if (t3.failures.length) fail(`the resolver reported failures: ${t3.failures.join(" | ")}`);
  ok(
    `${WORLD} loaded as maps3: ${info.w}x${info.h}, maxLevel ${info.maxL}, player at ` +
      `${mini.col.toFixed(1)},${mini.row.toFixed(1)}, projection ${t3.geom.dx}/${t3.geom.dy}/${t3.geom.lh}, ` +
      `regions in ${t3.regionMs}ms`,
  );

  // Park the body far from every sampled cell so its sprite, name label and
  // coordinate line cannot answer a pixel question. lookAt detaches the camera;
  // the avatar stays where it is put.
  const goTo = async (col, row) => {
    for (let n = 0; n < 6; n++) {
      await page.evaluate(([c, r]) => {
        const m = window.__ml.me();
        if (m?.dead) window.__ml.roomSend?.("respawn", {});
        window.__ml.teleport(c, r);
      }, [col, row]);
      const there = await page
        .waitForFunction(
          ([c, r]) => {
            const m = window.__ml?.me?.();
            return !!m && Math.abs(m.x / 32 - c) < 0.7 && Math.abs(m.y / 32 - r) < 0.7;
          },
          [col, row],
          { timeout: 6000, polling: 100 },
        )
        .then(() => true)
        .catch(() => false);
      if (there) return;
    }
    fail(`teleport to ${col},${row} never took: ${JSON.stringify(await page.evaluate(() => window.__ml.me()))}`);
  };
  await goTo(OPEN[0], OPEN[1]);

  /* ======================================================================== */
  /* 2. THE GROUND IS REALLY DRAWN                                            */
  /* ======================================================================== */
  await look(COAST.at[0], COAST.at[1], "the coast frame");
  const coastShot = await shoot("coast");
  const seen = {};
  const zoomCheck = await cellCentre(COAST_GRASS[0], COAST_GRASS[1]);
  if (zoomCheck.zoom !== Math.round(zoomCheck.zoom))
    fail(`camera zoom is ${zoomCheck.zoom} — every art-box offset in this gate assumes a whole zoom`);

  for (const [name, cell] of [
    ["grass", COAST_GRASS],
    ["light_beach", COAST_BEACH],
    ["water", COAST_WATER],
  ]) {
    const p = await cellCentre(cell[0], cell[1]);
    const c = patch(coastShot, p.x, p.y);
    if (!c) fail(`${name} at ${cell} projects to ${p.x.toFixed(0)},${p.y.toFixed(0)} — off the screenshot`);
    const k = await lightAt(cell[0], cell[1]);
    notVoid(`${name} at ${cell}`, c, k);
    const probe = await t3at(cell[0], cell[1]);
    if (probe.cell?.ground !== name)
      fail(`the resolver says ${cell} is "${probe.cell?.ground}", the world doc says ${name}`);
    if (!probe.blits.length) fail(`${name} at ${cell} resolved but produced NO blit — its art never became a texture`);
    seen[name] = { raw: c, art: unlit(c, k), k };
  }
  // ONE screenshot, three grounds, three unrelated colours. This is the check a
  // uniformly-coloured frame cannot survive: the three cells are lit within a
  // few thousandths of each other, so the raw pixels are directly comparable
  // and the art colours are too.
  const names = Object.keys(seen);
  let worst = Infinity;
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      const d = dist(seen[names[i]].art, seen[names[j]].art);
      worst = Math.min(worst, d);
      if (d < 60)
        fail(
          `${names[i]} ${rgb(seen[names[i]].raw)} and ${names[j]} ${rgb(seen[names[j]].raw)} are only ` +
            `${d.toFixed(1)} apart (unlit) in ONE frame — the ground is drawing as a single colour`,
        );
    }
  ok(
    `three grounds in one frame at light ${seen.grass.k.toFixed(2)}: grass ${rgb(seen.grass.raw)}, ` +
      `light_beach ${rgb(seen.light_beach.raw)}, water ${rgb(seen.water.raw)} (closest pair ${worst.toFixed(1)} unlit)`,
  );

  // Two more grounds from elsewhere on the map, so five distinct plates are
  // proven rather than the one coastline. These frames are lit at 1.0 while the
  // coast sits at 0.55, so the comparison is between UNLIT art colours only.
  for (const [name, cell] of [
    ["grey_stone", STONE_CELL],
    ["deep_water", SEA_CELL],
  ]) {
    await look(cell[0], cell[1], `the ${name} frame`);
    const img = await shoot(name);
    const p = await cellCentre(cell[0], cell[1]);
    const c = patch(img, p.x, p.y);
    if (!c) fail(`${name} at ${cell} is off the screenshot`);
    const k = await lightAt(cell[0], cell[1]);
    notVoid(`${name} at ${cell}`, c, k);
    const probe = await t3at(cell[0], cell[1]);
    if (probe.cell?.ground !== name)
      fail(`the resolver says ${cell} is "${probe.cell?.ground}", the world doc says ${name}`);
    if (!probe.blits.length) fail(`${name} at ${cell} resolved but produced NO blit — its art never became a texture`);
    const art = unlit(c, k);
    for (const [other, o] of Object.entries(seen)) {
      // The bar across frames is 25. The closest pair on this map is grass and
      // deep_water — measured 36 unlit — because they are the palette's darkest
      // green and its darkest blue; every other pair is 60 or more.
      const d = dist(art, o.art);
      if (d < 25)
        fail(`${name} ${rgb(art)} (unlit) is only ${d.toFixed(1)} from ${other} ${rgb(o.art)} — both cannot be right`);
    }
    seen[name] = { raw: c, art, k };
    ok(`${name} at ${cell} draws ${rgb(c)} at light ${k.toFixed(2)} (${probe.cell.art.kind}, ${probe.blits.length} blit)`);
  }

  /* ======================================================================== */
  /* 3. A COMPOSED BOUNDARY AND A FADE CELL                                   */
  /* ======================================================================== */
  await look(COAST.at[0], COAST.at[1], "the coast frame (transitions)");
  await shoot("transitions");

  const bnd = await t3at(BOUNDARY_CELL[0], BOUNDARY_CELL[1]);
  if (!bnd.boundary)
    fail(
      `no composed boundary at the lattice corner ${BOUNDARY_CELL} — its quad is two grounds ` +
        `(${BOUNDARY_PAIR.join("/")}) at one level, which is exactly the condition for one`,
    );
  const pair = [bnd.boundary.a, bnd.boundary.b].sort();
  if (pair[0] !== BOUNDARY_PAIR[0] || pair[1] !== BOUNDARY_PAIR[1])
    fail(`the boundary at ${BOUNDARY_CELL} blends ${pair.join("/")}, not ${BOUNDARY_PAIR.join("/")}`);
  if (!BOUNDARY_INDEX.includes(bnd.boundary.index))
    fail(
      `the boundary at ${BOUNDARY_CELL} has Wang index ${bnd.boundary.index}; the quad's two EAST corners share a ` +
        `side, which is index ${BOUNDARY_INDEX.join(" or ")}`,
    );
  if (!bnd.boundary.drawn)
    fail(
      `the boundary at ${BOUNDARY_CELL} resolved but did NOT compose — mask ${bnd.boundary.maskFrame} over ` +
        `${pair.join("/")} produced no texture (a plate not resident, or the pattern sheets never read back)`,
    );
  const boundariesDrew = (await page.evaluate(() => window.__ml.tiles3())).drew.boundaries;
  if (!(boundariesDrew > 0))
    fail(`the coast frame blitted ${boundariesDrew} boundaries — the composed-transition pass drew nothing`);
  ok(
    `composed boundary at ${BOUNDARY_CELL}: ${bnd.boundary.a}|${bnd.boundary.b} index ${bnd.boundary.index} ` +
      `mask ${bnd.boundary.maskFrame}, composed; ${boundariesDrew} boundaries in this frame`,
  );

  // THE FADE BAND, on its own frame: the only pairs with approved art are up on
  // the massif, so the coast frame cannot show one.
  await look(FADE_CELL[0], FADE_CELL[1], "the snow-line frame (fade band)");
  const fadeShot = await shoot("fade");
  const fade = await t3at(FADE_CELL[0], FADE_CELL[1]);
  if (!fade.cell?.fade)
    fail(
      `${FADE_CELL} resolved to "${fade.cell?.art?.kind}" art with no fade — the Chebyshev band scan is not ` +
        `running (its ring-${FADE_RING} neighbour is ${FADE_OTHER} at the same level)`,
    );
  if (fade.cell.fade.other !== FADE_OTHER || fade.cell.fade.dist !== FADE_RING)
    fail(
      `the fade at ${FADE_CELL} blends toward ${JSON.stringify(fade.cell.fade)} — expected ${FADE_OTHER} at ` +
        `ring ${FADE_RING}. Ring 1 is the one an axis-only scan from ring 2 could never see.`,
    );
  // A fade is CONFORMED into plate geometry, not cropped: its wall is
  // meaningless by the producer's own index, and hand-cropping it shipped a
  // 30-row surface the top-face mask could not index.
  if (fade.cell.art?.kind !== "conform")
    fail(`the fade at ${FADE_CELL} draws "${fade.cell.art?.kind}" art — a fade must be conformed`);
  if (!fade.blits.length) fail(`the fade tile at ${FADE_CELL} produced no blit — ${fade.cell.fade.file} never loaded`);
  {
    const p = await cellCentre(FADE_CELL[0], FADE_CELL[1]);
    const c = patch(fadeShot, p.x, p.y);
    if (!c) fail(`the fade cell ${FADE_CELL} is off the screenshot`);
    notVoid(`the fade cell ${FADE_CELL}`, c, await lightAt(FADE_CELL[0], FADE_CELL[1]));
    ok(
      `fade at ${FADE_CELL}: ${fade.cell.ground} -> ${FADE_OTHER} at ring ${FADE_RING}, ` +
        `${fade.cell.fade.file.split("/").pop()}, drew ${rgb(c)}`,
    );
  }


  /* ======================================================================== */
  /* 4. A CLIFF DRAWS ITS WHOLE STACK                                         */
  /* ======================================================================== */
  await look(CLIFF[0], CLIFF[1], "the cliff frame");
  const cliffShot = await shoot("cliff");
  const cliff = await t3at(CLIFF[0], CLIFF[1]);
  if (cliff.cell?.kind !== "wall")
    fail(`${CLIFF} is level ${cliff.cell?.level} and resolved as "${cliff.cell?.kind}" — it is a level-${CLIFF_LEVEL} cliff`);
  if (cliff.cell.level !== CLIFF_LEVEL) fail(`${CLIFF} is at level ${cliff.cell.level}, expected ${CLIFF_LEVEL}`);
  if (!cliff.cell.wall.capped) fail(`${CLIFF} is not capped — both down-screen neighbours are level 0, so its face IS exposed`);
  if (cliff.cell.wall.storeys !== CLIFF_STOREYS)
    fail(
      `the wall column at ${CLIFF} is ${cliff.cell.wall.storeys} storeys; level ${CLIFF_LEVEL} over frontLow ` +
        `${cliff.cell.wall.frontLow} is ${CLIFF_STOREYS}`,
    );
  if (cliff.blits.length !== CLIFF_STOREYS)
    fail(
      `only ${cliff.blits.length} of ${CLIFF_STOREYS} storeys have resident art — the stack draws with holes ` +
        `(${JSON.stringify(cliff.blits)})`,
    );
  if (cliff.blits.some((b) => b.role !== "wall")) fail(`a cliff storey blitted as ${cliff.blits.map((b) => b.role).join(",")}`);
  // Pixels: the column really occupies a tall run of the screen. Storey f sits
  // (level − f) × LH below the cap's own diamond centre.
  const capP = await cellCentre(CLIFF[0], CLIFF[1]);
  const cliffLight = await lightAt(CLIFF[0], CLIFF[1]);
  const stack = [];
  for (let k = 0; k < CLIFF_ON_CANVAS; k++) {
    const c = patch(cliffShot, capP.x, capP.y + k * LH * capP.zoom);
    if (!c) fail(`storey ${CLIFF_LEVEL - k} of the cliff projects off the screenshot`);
    notVoid(`storey ${CLIFF_LEVEL - k} of the cliff at ${CLIFF}`, c, cliffLight);
    stack.push(c);
  }
  const capToFoot = dist(stack[0], stack[stack.length - 1]);
  if (capToFoot < 20)
    fail(
      `the cliff's cap ${rgb(stack[0])} and its lowest drawn storey ${rgb(stack[stack.length - 1])} are ` +
        `${capToFoot.toFixed(1)} apart — the column is one repeated tile, not a capped stack`,
    );
  ok(
    `cliff at ${CLIFF}: ${cliff.cell.wall.storeys} storeys of ${cliff.cell.wall.side} over ` +
      `frontLow ${cliff.cell.wall.frontLow}, ${CLIFF_ON_CANVAS} of them on screen, cap ${rgb(stack[0])} -> ` +
      `foot ${rgb(stack[stack.length - 1])} (${capToFoot.toFixed(1)})`,
  );

  /* ======================================================================== */
  /* 5. SCENERY IS ON SCREEN                                                  */
  /* ======================================================================== */
  const hillsideScenery = (await page.evaluate(() => window.__ml.tiles3())).drew.scenery;
  // WALK there rather than fly the camera. Scenery converges over SEVERAL
  // rebuilds — the first pass over a fresh window can only ask for the piece
  // manifests it has never seen, the second can only ask for their art, and
  // nothing schedules a rebuild when a MANIFEST lands (only a texture batch
  // does). A player's camera is always drifting, which is what keeps that
  // pipeline turning; a parked one can sit on a half-populated window.
  await page.evaluate(() => window.__ml.lookAt()); // re-attach the chase camera
  await page.click("canvas"); // keyboard focus for this section and the next
  await goTo(SCENERY_AT[0], SCENERY_AT[1]); // ...and the teleport cancels that tap
  await page.keyboard.down("ArrowDown");
  await page.waitForTimeout(1200);
  await page.keyboard.up("ArrowDown");
  await settle("the scenery frame");
  await page
    .waitForFunction(() => window.__ml.tiles3().drew.scenery >= 10, { timeout: 30000 })
    .catch(async () => {
      const t = await page.evaluate(() => window.__ml.tiles3());
      fail(
        `only ${t.drew.scenery} scenery sprites ever reached the window around ${SCENERY_AT} — ` +
          `the densest camera window in the doc holds 22 anchors before the renderer's own 200px pad ` +
          `(${JSON.stringify(t.pieces)})`,
      );
    });
  const scen = await page.evaluate(() => window.__ml.tiles3());
  if (!(scen.placements > 1000))
    fail(`scenery3 resolved ${scen.placements} placements out of the doc's 1,388 — the placement pass is broken`);
  if (scen.pieces === null) fail("no scenery manifests were ever requested");
  if (scen.pieces.failed > 0) fail(`${scen.pieces.failed} scenery manifests failed to load (${JSON.stringify(scen.pieces)})`);
  // The counter has to TRACK the window, not be a constant: the frame it was
  // read at before the walk is a bare cliffside.
  if (!(scen.drew.scenery > hillsideScenery))
    fail(
      `the scenery count is ${scen.drew.scenery} here and ${hillsideScenery} on the bare cliffside — ` +
        `it is not view-dependent`,
    );
  await shoot("scenery");
  ok(
    `scenery: ${scen.placements} placements resolved, ${scen.pieces.loaded} piece manifests, ` +
      `${scen.drew.scenery} sprites in the window at ${SCENERY_AT} (${hillsideScenery} on the cliffside frame)`,
  );

  /* ======================================================================== */
  /* 6. THE PLAYER CAN WALK, AND THE CLIFF STOPS THEM                         */
  /* ======================================================================== */
  await goTo(OPEN[0], OPEN[1]);

  const pos = () => page.evaluate(() => { const m = window.__ml.me(); return m ? { x: m.x, y: m.y } : null; });
  const push = async (key, ms) => {
    await page.keyboard.down(key);
    const seenLevels = await page.evaluate(async (hold) => {
      let maxL = -1;
      const t0 = performance.now();
      while (performance.now() - t0 < hold) {
        const m = window.__ml.me();
        if (m) maxL = Math.max(maxL, window.__ml.levelAt(m.x, m.y));
        await new Promise((r) => setTimeout(r, 25));
      }
      return maxL;
    }, ms);
    await page.keyboard.up(key);
    await page.waitForTimeout(300);
    // Once more after the release: on this starved harness the in-page sampler
    // gets only a handful of ticks, and a climb that completes as the key comes
    // up would otherwise go unseen.
    const after = await page.evaluate(() => {
      const m = window.__ml.me();
      return m ? window.__ml.levelAt(m.x, m.y) : -1;
    });
    return Math.max(seenLevels, after);
  };

  const p0 = await pos();
  await push("ArrowDown", 2200);
  const p1 = await pos();
  const moved = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (!(moved > 32))
    fail(
      `holding ArrowDown for 2.2s on open grass at ${OPEN} moved the player ${moved.toFixed(1)} world units ` +
        `(${(moved / 32).toFixed(2)} cells) — ${WORLD} is not walkable`,
    );
  ok(`walked ${(moved / 32).toFixed(2)} cells across open grass at ${OPEN}`);

  const blocked = {};
  for (const key of ["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"]) {
    await goTo(POCKET[0], POCKET[1]);
    const before = await pos();
    const maxL = await push(key, 1600);
    const after = await pos();
    blocked[key] = {
      maxL,
      d: Math.hypot(after.x - before.x, after.y - before.y) / 32,
    };
    if (maxL > POCKET_LEVEL)
      fail(
        `pushing ${key} out of the level-0 notch at ${POCKET} put the player on level ${maxL} — the 6-level ` +
          `escarpment around it is not blocking (JUMP_CLIMB is 2)`,
      );
  }
  // The control: without it "did not move" proves nothing but a dead keyboard.
  // Only (186,406) to the north is open, and ArrowUp is the screen direction
  // that points at it (screen up = world −x,−y).
  //
  // THE 0.5-CELL BAR SITS BETWEEN TWO MEASUREMENTS, not beside one. The same
  // 1.6s push on OPEN grass moves 1.08 cells on the screen-horizontal keys and
  // 2.64 on the vertical ones (the iso speed compensation: a screen-vertical
  // step covers more world). In the notch the wall keys move 0.16 and the open
  // one 2.7 — so 0.5 is below every free push and well above every blocked one.
  const escape = blocked.ArrowUp.d;
  const intoWall = Math.max(blocked.ArrowLeft.d, blocked.ArrowDown.d);
  if (!(escape > 0.5))
    fail(
      `ArrowUp moved the player ${escape.toFixed(2)} cells out of the notch — the push had no force, so the ` +
        `other three directions prove nothing`,
    );
  if (!(intoWall < 0.5))
    fail(
      `pushing into the escarpment moved the player ${intoWall.toFixed(2)} cells (ArrowLeft ` +
        `${blocked.ArrowLeft.d.toFixed(2)}, ArrowDown ${blocked.ArrowDown.d.toFixed(2)}) — it should not budge`,
    );
  ok(
    `the level-6 escarpment at ${POCKET} blocks: into the wall ${intoWall.toFixed(2)} cells, out the open side ` +
      `${escape.toFixed(2)} cells, level never above ${POCKET_LEVEL}`,
  );

  if (errs.length) fail(`page errors on ${WORLD}: ${errs.join(" | ")}`);
  if (bad.length) fail(`${bad.length} failed requests on ${WORLD}: ${bad.slice(0, 5).join(" | ")}`);

  /* ======================================================================== */
  /* 7. THE LIVE WORLD STILL RENDERS                                          */
  /* ======================================================================== */
  errs.length = 0;
  bad.length = 0;
  await join(ISLAND);
  const i2 = await page.evaluate(() => window.__ml.worldInfo());
  if (i2.name !== ISLAND || i2.w !== 248 || i2.h !== 248)
    fail(`${ISLAND} came back as ${i2.name} ${i2.w}x${i2.h}, expected ${ISLAND} 248x248`);
  if (i2.maps2 !== true) fail(`${ISLAND} is no longer read as a maps2 world`);
  const i2t3 = await page.evaluate(() => window.__ml.tiles3());
  if (i2t3.on) fail(`${ISLAND} switched the maps3 art source ON — a world@2 world must never resolve tiles3 art`);
  const atlas = await page.evaluate(() => window.__ml.atlasInfo());
  if (!atlas || !atlas.index || atlas.individual !== 0)
    fail(`${ISLAND} no longer boots from its committed atlas: ${JSON.stringify(atlas)}`);
  await page.waitForTimeout(2500);
  const i2shot = await shoot("island2");
  // The same instrument verify-atlas uses: a centre patch of the frame has to
  // carry art rather than void.
  let sum = 0;
  let n = 0;
  for (let y = 40; y < 170; y += 2)
    for (let x = 140; x < 340; x += 2) {
      const i = (y * i2shot.width + x) * 4;
      sum += 0.299 * i2shot.data[i] + 0.587 * i2shot.data[i + 1] + 0.114 * i2shot.data[i + 2];
      n++;
    }
  const lum = sum / n;
  if (!(lum > 8)) fail(`${ISLAND} did not render (centre luminance ${lum.toFixed(1)})`);
  if (errs.length) fail(`page errors on ${ISLAND}: ${errs.join(" | ")}`);
  ok(
    `${ISLAND} still renders: ${i2.w}x${i2.h} world@2, tiles3 off, ${atlas.sliced} tiles sliced from the atlas ` +
      `with 0 individual requests, centre luminance ${lum.toFixed(1)}`,
  );

  console.log(`verify-tiles3: OK — ${WORLD} loads at ${W3}x${W3}, draws ground/fade/boundary/cliff/scenery, is walkable, and ${ISLAND} is untouched`);
} catch (e) {
  console.error(`verify-tiles3: FAIL — ${e.message}`);
  if (page) {
    try {
      await page.screenshot({ path: process.env.FAIL_SHOT || "/tmp/verify-tiles3-fail.png" });
      console.error(`verify-tiles3: frame at the failure -> ${process.env.FAIL_SHOT || "/tmp/verify-tiles3-fail.png"}`);
    } catch {}
  }
  await browser.close();
  process.exit(1);
} finally {
  await browser.close().catch(() => {});
}
