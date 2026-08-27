// TWO TILE SYSTEMS, SIDE BY SIDE — "Tiles OLD" and "World".
//
// Maintainer, 2026-08-16: "The tiles agent is working in what we call Tiles
// 3.0. This is placed in the new /tiles folder. When the new tile system is
// complete the old /tiles2 will be removed. This however is a big task and we
// will need the wiki in order to know if /tiles (3.0) works. Can you in the
// wiki have two tiles systems/pages? Tiles OLD and World? World is the new
// Tiles 3.0 system (/tiles). I will have to review the new system to make it
// good."
//
// So the NEW system takes the good name, and the review surface is built
// around the question the tiles agent's own manifest asks: for each "A over B"
// pair it offers two or three candidates ranked by a measured wall score, and
// asks which one to keep. `tiles/review/manifest.json` says what a verdict
// means — "`tile_id` is the PixelLab generation a rejection should delete … A
// DELETED cell is tombstoned and never regenerated, unlike a rejected one" —
// so verdicts ride that manifest's OWN keys, in the `tiles` feedback file the
// agent already reads.
//
// The two audiences are NOT the same here, and that is deliberate: a player
// sees one ground section, still called World, holding the tiles the game
// actually renders. "Tiles OLD" is a migration word that means nothing to a
// reader, and an unfinished ground system in the encyclopedia is a promise the
// game cannot keep.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const DATA = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const CELLS = DATA.domains.world ?? [];
const MAN = JSON.parse(readFileSync(new URL("../../tiles/review/manifest.json", import.meta.url), "utf8"));
console.log(`manifest: ${Object.keys(MAN.cells ?? {}).length} cells | data.json: ${CELLS.length} | candidates: ${DATA.counts.world_candidates}`);

// THE BUILD IS THE AGENT'S DATA, NOT THE WIKI'S OPINION. Every number the page
// shows has to come back to the manifest, or his verdict would be about a
// ranking nobody else can reproduce.
ok(CELLS.length > 0, `the build reads the tiles agent's review manifest (${CELLS.length} pairs)`);
ok(CELLS.length === Object.keys(MAN.cells).length, "every cell in the manifest becomes a pair in the wiki");
const flat = CELLS.flatMap((c) => c.candidates);
// COMPARED AGAINST THE MANIFEST, not against a guess at its shape: this used
// to test the key with a regex ending in `\d+`, and went red the day the
// agent switched candidate ids from indices to hex hashes — a gate failing on
// the AGENT's freedom to name its own things, which is exactly what "keeps the
// manifest's own key" is supposed to protect.
const manKeys = new Set(Object.values(MAN.cells).flatMap((c) => (c.candidates ?? []).map((x) => x.key)));
const strayKeys = flat.filter((c) => !manKeys.has(c.key));
ok(strayKeys.length === 0,
  `every candidate keeps the MANIFEST's own key, so a verdict names what the agent named (${strayKeys.length ? strayKeys[0].key : flat[0]?.key})`);
ok(flat.every((c) => c.art?.startsWith("tiles/review/")), "and points at the art the agent published");
ok(flat.every((c) => typeof c.wallScore === "number"), "carrying the agent's measured wall score");
// BEST FIRST — and it is the WIKI that guarantees it now. The manifest arrived
// ranked once and stopped (2026-08-20), while the set page still numbers its
// tiles "#1, #2, …" under a "ranked by wall score" pill, so build.mjs and the
// live refresh both sort. This asserts the promise the PAGE makes.
ok(CELLS.every((c) => c.candidates.every((x, i, a) => i === 0 || a[i - 1].wallScore >= x.wallScore)),
  "and the wiki ranks them best first, whatever order the manifest arrives in");
ok(!!DATA.worldMeta?.accept?.min_wall_score, `and the acceptance bar it ranks against (${DATA.worldMeta?.accept?.min_wall_score})`);
// The score on the page must be the score in the manifest, to the decimal —
// matched BY KEY, because the wiki reorders (best first) and an index-wise
// comparison would only be testing that nobody sorts anything.
const one = CELLS[0], manOne = MAN.cells[one.id];
const manScore = new Map((manOne.candidates ?? []).map((c) => [c.key, c.wall_score]));
const offScore = one.candidates.filter((c) => c.wallScore !== manScore.get(c.key));
ok(offScore.length === 0,
  `scores match the manifest exactly, per key (${one.id}: ${one.candidates.length} tiles${offScore.length ? `, first off: ${offScore[0].key}` : ""})`);

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const posted = [];
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.route("**/api/wiki/save", async (r) => {
  posted.push(JSON.parse(r.request().postData() || "{}"));
  await r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
});
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
  localStorage.removeItem("wiki-world-filter");
});

const nav = () => p.evaluate(() => [...document.querySelectorAll("#nav a")].map((a) => a.textContent.replace(/\d+$/, "").trim()));

// ------------------------------------------------------------- 1. two systems
await p.goto(`${W}#/`, { waitUntil: "load" });
await p.waitForTimeout(2200);
const adminNav = await nav();
console.log("admin nav:", JSON.stringify(adminNav));
ok(adminNav.includes("World") && adminNav.includes("Tiles OLD"),
  "the Game Master gets BOTH ground sections — World and Tiles OLD");
ok(adminNav.indexOf("World") < adminNav.indexOf("Tiles OLD"),
  "with the new system first — the one being replaced is not the one you reach first");

// --------------------------------------------------- 2. three levels of ground
// Maintainer 2026-08-17: "The top level tiles are still grass, ice, snow, etc.
// When clicking on a tile type, lets say grass you will get to a page with all
// different grass pairs/sets … Clicking on grass over snow will make it
// possible to review every tile that is part of that set."
const TOPS = [...new Set(CELLS.map((c) => c.top))];
const TOP = TOPS[0], SIDES = CELLS.filter((c) => c.top === TOP);
await p.goto(`${W}#/world`, { waitUntil: "load" });
await p.waitForTimeout(2400);
const lvl1 = await p.evaluate(() => ({
  h1: document.querySelector("h1")?.textContent,
  cards: document.querySelectorAll("a.card").length,
  names: [...document.querySelectorAll("a.card .card-name")].map((x) => x.textContent),
  hrefs: [...document.querySelectorAll("a.card")].map((a) => a.getAttribute("href")),
}));
console.log("level 1 (types):", JSON.stringify(lvl1));
ok(lvl1.cards === TOPS.length, `the top level is GROUND TYPES, not pairs (${lvl1.cards} for ${TOPS.length} types)`);
ok(lvl1.names.every((n) => !/ over /.test(n)), `each named as a ground (${lvl1.names.join(", ")})`);
ok(lvl1.hrefs.every((x) => /^#\/world\/[a-z0-9_]+$/.test(x)), "opening one ground type, not one pair");
// THE FACE IS THE SELF PAIR (maintainer 2026-08-17: "you should always take
// the grass over grass, ice over ice"). A card that big shows the WALL as much
// as the top, so a best-of-all-pairs face had "Grass" advertising light soil.
const faces = await p.evaluate(() => [...document.querySelectorAll("a.card")].map((a) => ({
  type: a.getAttribute("href").split("/").pop(),
  // Under Clean the card is a COMPOSED canvas (the tile's own art + the clean
  // plate) and the imgs beneath it are hidden — the identity being asserted
  // lives in the base layer's src, which is the art the composite was built
  // from, visible or not.
  src: a.querySelector("img.art-after")?.getAttribute("src") ?? "",
})));
console.log("type faces:", JSON.stringify(faces));
for (const f of faces) {
  const self = CELLS.find((c) => c.top === f.type && c.side === f.type);
  if (!self) { console.log(`  (${f.type} has no self pair yet — falls back)`); continue; }
  ok(f.src.includes(`${f.type}__over__${f.type}/`),
    `${f.type} is represented by ${f.type} over ${f.type} (…${f.src.slice(-46)})`);
}

await p.goto(`${W}#/world/${TOP}`, { waitUntil: "load" });
await p.waitForTimeout(2200);
/* THE GROUND PAGE OPENS ON BASE since 2026-08-25 — Clean #0 always exists, so
 * the admin's set editor is what he lands on. The pairs live one tab over. */
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /On top of/.test(x.textContent))?.click());
await p.waitForTimeout(1400);
const lvl2 = await p.evaluate(() => ({
  h1: document.querySelector("h1")?.textContent,
  cards: document.querySelectorAll("a.card").length,
  names: [...document.querySelectorAll("a.card .card-name")].map((x) => x.textContent).slice(0, 3),
  hrefs: [...document.querySelectorAll("a.card")].map((a) => a.getAttribute("href")).slice(0, 3),
}));
console.log("level 2 (pairs):", JSON.stringify(lvl2));
ok(lvl2.cards === SIDES.length, `the type page lists every pair that walks on it (${lvl2.cards}/${SIDES.length})`);
ok(lvl2.names.every((n) => /^over /.test(n)), `named by the WALL, since the ground is the page you are on (${lvl2.names.join(", ")})`);
ok(lvl2.hrefs.every((x) => x.startsWith(`#/world/${TOP}/`)), "each opening its own pair");

// The type page is where the pairs live now, and every one must draw.
await p.goto(`${W}#/world/${TOP}`, { waitUntil: "load" });
await p.waitForTimeout(2200);
// Cards below the fold keep their art lazy, so "does every pair draw?" has to
// ask for the whole grid first — otherwise it measures the viewport.
await p.evaluate(() => document.querySelectorAll('img[loading="lazy"]').forEach((im) => { im.loading = "eager"; }));
await p.waitForTimeout(1200);
const list = await p.evaluate(() => ({
  cards: document.querySelectorAll("a.card").length,
  art: [...document.querySelectorAll("a.card")].filter((c) => [...c.querySelectorAll("img")].some((i) => i.complete && i.naturalWidth > 0)).length,
  filters: [...document.querySelectorAll(".sortbar button")].map((x) => x.textContent.trim()),
}));
console.log("pairs of one type:", JSON.stringify(list));
ok(list.art === list.cards && list.cards > 0, `every pair draws its tile (${list.art}/${list.cards})`);
// ONE filter bar, and it is the one that cascades (2026-08-20): the pair-level
// "not reviewed / partly / picked / redo" strip was removed after he filtered
// on it, opened a set and found an unfiltered page with a pager that ignored
// his choice. Its vocabulary lives on in the tile filter, which carries the
// navigation with it.
ok(list.filters.some((f) => /undecided/.test(f)) && list.filters.some((f) => /no stars/.test(f)),
  `with the tile filter to find the work (${list.filters.join(" | ")})`);
ok(!list.filters.some((f) => /not reviewed|partly/.test(f)),
  "and no second lookalike bar that filters without navigating");

// ------------------------------------------------------------- 3. the review
const cell = CELLS.find((c) => c.candidates.length > 1) ?? CELLS[0];
await p.goto(`${W}#/world/${cell.top}/${cell.side}`, { waitUntil: "load" });
await p.waitForTimeout(1800);
const page = await p.evaluate(() => ({
  h1: document.querySelector("h1")?.textContent,
  cands: document.querySelectorAll(".world-cand").length,
  art: [...document.querySelectorAll(".world-cand")].filter((c) => [...c.querySelectorAll("canvas")].some((cv) => cv.width > 1)).length,
  scores: [...document.querySelectorAll(".world-cand .card-name")].map((x) => x.textContent.trim()),
  metrics: document.querySelector(".world-cand .metric-row")?.textContent ?? "",
  verdicts: document.querySelectorAll(".world-cand .verdict").length,
  pairVerdict: [...document.querySelectorAll(".detail-head button")].map((x) => x.textContent).join("|"),
  prompt: !!document.querySelector(".world-prompt"),
  pager: document.querySelector(".detail-count")?.textContent ?? null,
}));
console.log("cell page:", JSON.stringify(page));
ok(page.cands === cell.candidates.length, `every generation of the pair is shown (${page.cands})`);
ok(page.art === page.cands, `each drawing its own preview (${page.art}/${page.cands})`);
ok(page.verdicts === page.cands, "each with its OWN verdict — the candidate is the review unit");
ok(/tiling/.test(page.metrics) && /discretion/.test(page.metrics) && /structure/.test(page.metrics),
  `and the measurements behind its rank, named (“${page.metrics.trim()}”)`);
ok(/wall \d/.test(page.scores[0] ?? ""), `with the score itself on the card (“${page.scores[0]}”)`);
// No verdict on the pair any more (maintainer 2026-08-17: "the review will
// only ever happen on the individual tiles themselves") — one place to cast a
// verdict instead of two that could disagree.
ok(!/approve|✕/.test(page.pairVerdict), `and the PAIR itself carries none (“${page.pairVerdict}”)`);
ok(page.prompt, "and the prompt that produced it is there to read");
ok(/\d+ \/ \d+/.test(page.pager ?? ""), `‹ › walks the pairs (${page.pager})`);

// A verdict must land on the manifest's key, in the file the agent reads.
await p.evaluate(() => document.querySelector(".world-cand .verdict button")?.click());
await p.waitForTimeout(300);
await p.evaluate(() => [...document.querySelectorAll("#savebar button")].find((x) => /Commit/.test(x.textContent))?.click());
await p.waitForTimeout(1200);
console.log("posted:", JSON.stringify(posted[0] ?? null).slice(0, 240));
ok(posted[0]?.file === "feedback/tiles",
  `the verdict goes to the feedback file the tiles agent reads (${posted[0]?.file})`);
const keys = Object.keys(posted[0]?.set ?? {});
ok(keys.length === 1 && keys[0] === cell.candidates[0].key,
  `keyed exactly as the manifest keyed it (${keys[0]})`);
ok(!keys.some((k) => k.startsWith("tiles2/")), "and cannot collide with Tiles OLD, whose ids all start tiles2/");

// --------------------------------------------- 4. the list is LIVE, not baked
// Tiles 3.0 is a factory running right now, so a list baked into the last
// build is stale by the time he opens it — he would be reviewing yesterday's
// generations while the agent waits on today's. The section refetches the
// agent's own manifest. Proven the only way that means anything: serve a
// manifest carrying a pair the build has never heard of.
const FRESH = "sand__over__moonstone";
ok(!CELLS.some((c) => c.id === FRESH), `the build does not know “${FRESH}” — that is the point`);
const live = await ctx.newPage();
const liveErrs = []; live.on("pageerror", (e) => liveErrs.push(String(e)));
await live.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await live.route("**/tiles/review/manifest.json", (r) => r.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({
    schema: "tiles3/review@1",
    cells: {
      ...MAN.cells,
      [FRESH]: {
        top: "sand", side: "moonstone",
        // Art the repo really has, so the card draws — what is being tested is
        // whether the LIST comes from the manifest, not the image loader.
        candidates: [{ ...MAN.cells[Object.keys(MAN.cells)[0]].candidates[0], key: `tiles/${FRESH}/0`, wall_score: 9.9 }],
      },
    },
  }),
}));
await live.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
  localStorage.removeItem("wiki-world-filter");
});
// It is a new GROUND TYPE as well as a new pair, so it has to reshape both
// levels — the type list and that type's pairs.
await live.goto(`${W}#/world`, { waitUntil: "load" });
await live.waitForTimeout(3000);
const freshTop = await live.evaluate(() => ({
  types: [...document.querySelectorAll("a.card")].map((a) => a.getAttribute("href")),
}));
await live.goto(`${W}#/world/sand`, { waitUntil: "load" });
await live.waitForTimeout(2200);
// Same as above: the ground page opens on its set editor, and the pairs a live
// manifest refresh has to reshape are one tab over.
await live.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /On top of/.test(x.textContent))?.click());
await live.waitForTimeout(1200);
const fresh = await live.evaluate(() => ({
  h1: document.querySelector("h1")?.textContent,
  has: !!document.querySelector('a.card[href="#/world/sand/moonstone"]'),
  name: document.querySelector('a.card[href="#/world/sand/moonstone"] .card-name')?.textContent ?? null,
}));
console.log("live manifest:", JSON.stringify({ ...fresh, types: freshTop.types.length }));
ok(freshTop.types.includes("#/world/sand"), "a ground type the agent generated after the last build appears at the top level");
ok(fresh.has, `and its pair under it (“${fresh.name}”)`);
ok(liveErrs.length === 0, `no page errors on the live path (${liveErrs.slice(0, 1).join("") || "none"})`);

// ---------------------------------- 4b. every tile shows how IT tiles
// Maintainer 2026-08-17: "The individual tile preview under Tiles in this set
// should inside the same preview have the 3x3 on the left side and the V stack
// on the right side … we can remove the old Laid out as ground card", and on
// why they share one box: "just to save space on the page."
const many = CELLS.find((c) => c.candidates.length > 2 && c.id !== cell.id && c.top !== c.side && CELLS.some((x) => x.top === c.side && x.side === c.side))
  ?? CELLS.find((c) => c.candidates.length > 2 && c.id !== cell.id) ?? cell;
await p.goto(`${W}#/world/${many.top}/${many.side}`, { waitUntil: "load" });
await p.waitForTimeout(2800);
const perTile = () => p.evaluate(() => ({
  cards: document.querySelectorAll(".world-cand").length,
  stages: document.querySelectorAll(".world-cand .tile-preview").length,
  boxes: document.querySelectorAll(".world-cand .tile-preview .tile-stage").length,
  // TWO ROWS in ONE box: the tile magnified (2x, 4x) over what it builds
  // (the flat patch and the V).
  shapes: [...document.querySelectorAll(".world-cand .tile-row.scenes")].map((row) => [...row.querySelectorAll("canvas")].map((cv) => {
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    let opaque = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
    return { w: cv.width, h: cv.height, opaque, x: Math.round(cv.getBoundingClientRect().x) };
  })),
  // The two previews must be SEPARATE boxes with real space between them, not
  // two halves of one chessboard.
  split: [...document.querySelectorAll(".world-cand .tile-preview")].map((pv) => {
    const [a, b] = [...pv.querySelectorAll(".tile-stage")];
    if (!a || !b) return null;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return { gap: Math.round(rb.top - ra.bottom), zoomFirst: a.classList.contains("zoom-box") && b.classList.contains("scene-box") };
  }),
  zooms: [...document.querySelectorAll(".world-cand .tile-row.zooms")].map((row) => [...row.querySelectorAll("canvas")].map((cv) => {
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    let opaque = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
    return { z: cv.dataset.zoom, w: cv.width, opaque, x: Math.round(cv.getBoundingClientRect().x) };
  })),
  // CENTRED, not packed against one edge: the leftover has to be split, or a
  // tile sits flush left with a hand's width of chessboard on the right.
  slack: [...document.querySelectorAll(".world-cand .tile-row")].map((row) => {
    const cvs = [...row.querySelectorAll("canvas")];
    if (!cvs.length) return null;
    const box = row.getBoundingClientRect();
    const first = cvs[0].getBoundingClientRect(), last = cvs[cvs.length - 1].getBoundingClientRect();
    return { left: Math.round(first.x - box.x), right: Math.round(box.right - last.right) };
  }),
  courses: [...document.querySelectorAll(".world-cand .tile-preview")].map((st) => st.dataset.course),
  // BOTH AT ONCE OR IT SAVED NOTHING — a stage wider than its box hides the
  // cliff behind a sideways scroll, which is the second look the one box was
  // meant to remove. Measured on his phone's width.
  fits: [...document.querySelectorAll(".world-cand .tile-row")].map((row) => row.scrollWidth - row.clientWidth),
  oldCard: [...document.querySelectorAll(".panel-title")].some((t) => /laid out as ground/i.test(t.textContent)),
  randomize: [...document.querySelectorAll("button")].some((b) => /Randomize/.test(b.textContent)),
  modes: [...document.querySelectorAll(".wall-mode")].map((m) => m.querySelector(".sortbar-btn.sel")?.textContent.trim()),
}));
const own = await perTile();
console.log("per tile:", JSON.stringify({ cards: own.cards, stages: own.stages, first: own.shapes[0], courses: own.courses.slice(0, 1), oldCard: own.oldCard, randomize: own.randomize }));
ok(own.stages === own.cards && own.cards > 1, `every tile carries its own preview (${own.stages}/${own.cards})`);
ok(own.shapes.every((sh) => sh.length === 2), "holding BOTH shapes, in one box");
ok(own.shapes.every((sh) => sh[0].x < sh[1].x), "the 3×3 on the left, the cliff on the right");
const iso = DATA.iso ?? { dx: 32, tilePx: 64 };
ok(own.shapes.every((sh) => Math.abs(sh[0].w - (iso.dx * 4 + iso.tilePx)) <= 12), "the flat one a real 3×3 patch");
ok(own.shapes.every((sh) => sh.every((c) => c.opaque > 1500)), "and both actually composed");
// THE TILE ITSELF, MAGNIFIED, ON TOP (maintainer 2026-08-17: "another preview
// where you show a single 2x zoomed tile (to the left) and another 4x zoomed
// tile (to the right) … This preview should be just on top of the preview we
// have now"). Integer scales, nearest neighbour — the only kind of zoom pixel
// art survives.
console.log("zooms:", JSON.stringify(own.zooms[0]), "| slack:", JSON.stringify(own.slack.slice(0, 2)));
ok(own.zooms.length === own.cards && own.zooms.every((z) => z.length === 1), `every tile is magnified too — ONE tile (${own.zooms.length} rows)`);
ok(own.zooms.every((z) => z[0].z === "2" && z[0].w === iso.tilePx * 2),
  `at 2×, and only 2× (${own.zooms[0]?.[0]?.w}px from a ${iso.tilePx}px tile)`);
ok(own.zooms.every((z) => z[0].opaque > 1000), "and actually drawn");
// A SEAM BETWEEN THE ROWS, because they are not at the same scale.
console.log("split:", JSON.stringify(own.split[0]));
ok(own.boxes === own.cards * 2, `the two previews are two BOXES, not one (${own.boxes} for ${own.cards} tiles)`);
ok(own.split.filter(Boolean).every((s) => s.gap >= 6),
  `with the card's own surface between them (${own.split.filter(Boolean).map((s) => s.gap + "px").join(", ")})`);
ok(own.split.filter(Boolean).every((s) => s.zoomFirst), "the magnified tile above, the scenes below");
// The slack is SPLIT, never piled on one side. 6px of tolerance: two fixed
// canvas widths in a fluid box rarely divide evenly.
ok(own.slack.filter(Boolean).every((s) => Math.abs(s.left - s.right) <= 6),
  `each row centred, the leftover split (${own.slack.filter(Boolean).map((s) => `${s.left}/${s.right}`).join(", ")})`);

// AT 3.0'S OWN PITCH, NOT THE GAME'S (maintainer 2026-08-17: "The new tiles are
// meant to be drawn with DY=14 and not DY=15 as we used in the old tile
// system"). A 3.0 tile's top diamond is 64x28, so 14 is the largest step where
// each tile's wall is covered by the tile in front; the tiles agent measured
// 960px of leaked wall at 15 (tiles/docs/GEOMETRY.md). Measured off the canvas
// rather than trusted from the attribute: the height IS the arithmetic.
const PITCH = 14, PAD = 2, TILE = DATA.iso?.tilePx ?? 64;
const geo = await p.evaluate(() => {
  const st = document.querySelector(".world-cand .tile-preview");
  // The SCENES row — the zoom row above it is drawn at whole multiples of the
  // tile and says nothing about the projection.
  const cv = st.querySelectorAll(".tile-row.scenes canvas");
  return { dy: st.dataset.dy, flatH: cv[0]?.height, veeH: cv[1]?.height };
});
console.log("pitch:", JSON.stringify({ ...geo, at14: 4 * PITCH + TILE + 2 * PAD, at15: 4 * 15 + TILE + 2 * PAD }));
ok(geo.dy === String(PITCH), `the World previews declare 3.0's pitch (dy ${geo.dy})`);
ok(geo.flatH === 4 * PITCH + TILE + 2 * PAD,
  `and the 3×3 is COMPOSED at it — ${geo.flatH}px = 4×${PITCH} + ${TILE} + 2×${PAD}, where the game's 15 would give ${4 * 15 + TILE + 2 * PAD}`);
ok(DATA.iso?.dy === 15, `while the build still carries the game's own 15, which is what Tiles OLD is drawn with (${DATA.iso?.dy})`);
ok(own.fits.every((over) => over <= 1), `both fitting a 393px phone at once, no sideways scroll (worst ${Math.max(...own.fits)}px over)`);
// AND ON A WIDE SCREEN, where the danger is the opposite one: an auto-fill
// grid happily hands a tile a 232px column and clips the cliff in it.
await p.setViewportSize({ width: 1280, height: 900 });
await p.waitForTimeout(400);
const wide = await p.evaluate(() => [...document.querySelectorAll(".world-cand .tile-stage")].map((st) => st.scrollWidth - st.clientWidth));
await p.setViewportSize({ width: 393, height: 851 });
await p.waitForTimeout(400);
ok(wide.every((over) => over <= 1), `and on a 1280px desktop, where the grid must widen its column instead of clipping (worst ${Math.max(...wide)}px over)`);
ok(!own.oldCard && !own.randomize, "the shared “Laid out as ground” card and its Randomize are gone");

// THE CLIFF FOLLOWS THIS TILE'S OWN WALL MODE — the reason the preview lives
// on the card that carries the switch.
ok(own.courses.every((c) => c?.includes(`${many.top}__over__${many.side}/`)),
  `by default a tile stacks itself (${own.courses[0]?.split("/").slice(-2).join("/")})`);
await p.evaluate(() => document.querySelector('.wall-mode [data-sort="top"]')?.click());
await p.waitForTimeout(900);
const flipped = await perTile();
console.log("first tile top-only:", JSON.stringify({ courses: flipped.courses, modes: flipped.modes }));
ok(flipped.modes[0] === "top only", "marking one tile top-only takes");
ok(flipped.courses[0]?.includes(`${many.side}__over__${many.side}/`),
  `and ITS cliff switches to the pure ${many.side} tile (${flipped.courses[0]?.split("/").slice(-2).join("/")})`);
ok(flipped.courses.slice(1).every((c) => c?.includes(`${many.top}__over__${many.side}/`)),
  "while its neighbours, untouched, still stack themselves — the setting is per tile");

// ------------------------------------- 5. before / after the postprocess
// Maintainer 2026-08-17: "a button/switch to view a tile before it was post
// processed. I think the tiles-agent has prepared for this feature." They had:
// tiles3/review@2 gives every candidate a `before` beside its `after`.
ok(flat.every((c) => c.art?.endsWith("_after.webp") || !/_before/.test(c.art ?? "")),
  "the build takes the manifest's AFTER as the tile that ships");
const withRaw = flat.filter((c) => c.raw).length;
ok(withRaw > 0, `and carries the BEFORE beside it (${withRaw}/${flat.length} candidates)`);
ok(flat.filter((c) => c.raw).every((c) => c.raw !== c.art), "which is a different file — a comparison of one image is not one");

await p.goto(`${W}#/world/${cell.top}/${cell.side}`, { waitUntil: "load" });
await p.waitForTimeout(1800);
// The tile cards are composed CANVASES now, so what the switch produced is
// read from the paths they were built from rather than from an <img> src.
const shot = () => p.evaluate(() => ({
  mode: [...document.querySelectorAll('[data-bar="wiki-world-view"] button')].map((b) => (b.classList.contains("sel") ? "*" : "") + b.textContent.trim()),
  faces: [...document.querySelectorAll(".world-cand .tile-preview")].map((st) => st.dataset.face),
  portrait: (() => {
    const a = document.querySelector(".detail-head .world-art");
    if (!a) return null;
    const vis = (i) => i && getComputedStyle(i).display !== "none";
    return vis(a.querySelector(".art-before")) ? "before" : "after";
  })(),
}));
const asShipped = await shot();
console.log("after :", JSON.stringify(asShipped));
ok(asShipped.mode[0] === "*Clean #0", `it opens on what the game gets — the clean colour (${asShipped.mode.join(" ")})`);
// Under Clean every preview is a COMPOSITE of the postprocessed art and the
// ground's clean plate — sub:<after>::<clean> — since 2026-08-27 ("if I press
// Clean #0 the tiles doesn't become clean"). Either form carries the claim:
// the source is the after art, never the raw.
ok(asShipped.faces.every((f) => /_after\.webp$/.test(f ?? "") || /^sub:.*_after\.webp::.*clean\.webp$/.test(f ?? "")),
  "and every tile preview is composed from the postprocessed art (+ the clean plate)");

await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-world-view"] button')].find((b) => /Raw/.test(b.textContent)).click());
await p.waitForTimeout(1000);
const asRaw = await shot();
console.log("before:", JSON.stringify(asRaw));
const selOf = (m) => m.find((x) => x.startsWith("*")) ?? "";
/* THE SWITCH CARRIES THE GROUND'S OWN PASSES since 2026-08-25 — Clean #0, then
 * every set he has built, then Raw — so its LENGTH is his to decide and only
 * the ends are fixed. */
ok(selOf(asRaw.mode) === "*Raw" && asRaw.mode.length >= 2 && /Clean #0/.test(asRaw.mode[0]),
  `the switch flips the whole set, Clean #0 first and Raw last (${asRaw.mode.join(" ")})`);
ok(asRaw.faces.every((f) => /_before\.webp$/.test(f ?? "")), "and every preview is rebuilt from the generator's raw output");
ok(asRaw.portrait === "before", "the pair's own portrait follows — one truth per screen, never two");

// THE MODE IS A PREFERENCE. He pages ‹ › through the pairs judging one
// property; a mode that reset on every page turn would be re-pressed each time.
await p.goto(`${W}#/world/${SIDES[1].top}/${SIDES[1].side}`, { waitUntil: "load" });
await p.waitForTimeout(2000);
const nextPair = await shot();
console.log("next pair:", JSON.stringify({ mode: nextPair.mode }));
ok(selOf(nextPair.mode) === "*Raw", "paging to the next pair keeps the mode");
await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-world-view"] button')].find((b) => /Clean #0/.test(b.textContent)).click());
await p.waitForTimeout(500);

// -------------------------------- 5b. and the same switch ON EVERY TILE
// Maintainer 2026-08-17: "When looking at tiles in Tiles in this set I
// sometimes want to toggle between before and after, but that button might be
// higher up so I have to scroll. Can you place that button so I have access to
// it for each tile?" It OVERRIDES for that tile instead of flipping the set —
// otherwise the tiles beside it move too and the difference he sees could be
// either the postprocess or the page.
await p.goto(`${W}#/world/${many.top}/${many.side}`, { waitUntil: "load" });
await p.waitForTimeout(2600);
const chips = () => p.evaluate(() => [...document.querySelectorAll(".world-cand .tile-preview")].map((st) => ({
  label: st.querySelector(".stage-flip")?.textContent ?? null,
  view: st.dataset.view,
  face: st.dataset.face,
})));
const press = (i) => p.evaluate((n) => document.querySelectorAll(".world-cand .tile-preview")[n].querySelector(".stage-flip").click(), i);
const rest = await chips();
console.log("chips:", JSON.stringify(rest.map((c) => `${c.label}/${c.view}`)));
ok(rest.length > 1 && rest.every((c) => c.label), `every tile carries the switch on its own picture (${rest.length}/${rest.length})`);
ok(rest.every((c) => c.view === "clean"), "all of them starting on what the game gets");
/* THE CHIP WALKS THE GROUND'S OWN PASSES (2026-08-25) — Clean #0, then every
 * set, then Raw. This ground has no set built, so one press is Raw and the
 * whole cycle is two states. The claim being tested is unchanged and is the
 * one that matters: the tile under his thumb moves and the ones beside it do
 * not, which is what makes it a comparison rather than a reload. */
await press(1);
await p.waitForTimeout(1200);
const texPeek = await chips();
console.log("after pressing tile 2:", JSON.stringify(texPeek.map((c) => `${c.label}/${c.view}`)));
ok(texPeek[1].view !== "clean" && texPeek[1].face,
  `one press moves THAT tile off the clean colour (${String(texPeek[1].face).slice(0, 28)}…)`);
ok(texPeek.filter((_, i) => i !== 1).every((c) => c.view === "clean" && /_after\.webp/.test(c.face ?? "")),
  "while the tiles beside it hold still — the difference he sees is the pass, not the page");
ok(/⇄/.test(texPeek[1].label ?? ""), `and the chip says which pass he is looking at (“${texPeek[1].label}”)`);
const peek = texPeek;
ok(peek[1].view === "before" && /_before\.webp$/.test(peek[1].face ?? ""),
  `a second press reaches the generator's raw output (${peek[1].face?.split("/").pop()})`);
ok(/raw/.test(peek[1].label ?? ""), `and the chip follows it (“${peek[1].label}”)`);
await press(1);
await p.waitForTimeout(1000);
// The cycle is as long as the ground has passes, so "back to the start" is
// reached by pressing until it is, not by counting to three.
for (let i = 0; i < 8; i++) {
  if ((await chips())[1].view === "clean") break;
  await press(1); await p.waitForTimeout(700);
}
const backAgain = await chips();
ok(backAgain[1].view === "clean" && /_after\.webp/.test(backAgain[1].face ?? ""), "and cycling round puts that tile back");
// THE SET-WIDE SWITCH STILL RULES THE SET, and clears a peek: "Clean #0" for the
// set has to mean all of it, or a tile left on before would be read as one the
// postprocess did nothing to.
await press(0);
await p.waitForTimeout(900);
ok((await chips())[0].view !== "clean", "a peek can be left open on any tile");
await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-world-view"] button')].find((b) => /Clean #0/.test(b.textContent)).click());
await p.waitForTimeout(1400);
const cleared = await chips();
console.log("after the set-wide After:", JSON.stringify(cleared.map((c) => c.view)));
ok(cleared.every((c) => c.view === "clean"), "and the set-wide switch clears every peek — “Clean #0” for the set means all of it");

// NO PLATFORM PRESS EFFECT ANYWHERE (maintainer 2026-08-17: "Why did you do the
// button down effect blue? Is that part of our CSS style guide? … Is it a
// default html effect leaking through?" — it was the WebKit/Blink tap
// highlight, blue on his device and nothing to do with a palette whose accent
// is terracotta). Asserted across every button on the page, not just the chip:
// the leak was never specific to it.
const pressFx = await p.evaluate(() => {
  const btns = [...document.querySelectorAll("button")];
  return {
    n: btns.length,
    tap: [...new Set(btns.map((x) => getComputedStyle(x).webkitTapHighlightColor))],
    touch: [...new Set(btns.map((x) => getComputedStyle(x).touchAction))],
  };
});
console.log("press:", JSON.stringify(pressFx));
ok(pressFx.n > 10 && pressFx.tap.every((v) => /rgba\(0, 0, 0, 0\)|transparent/.test(v)),
  `no platform tap highlight on any of the ${pressFx.n} buttons (${pressFx.tap.join(" ")})`);
ok(pressFx.touch.every((v) => v === "manipulation"), `and no double-tap-zoom wait on a press (${pressFx.touch.join(" ")})`);

// ------------------------------------------------------------- 6. the player
// He asked for a migration surface, not a change to the encyclopedia.
const pub = await ctx.newPage();
await pub.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":false}' }));
await pub.addInitScript(() => localStorage.removeItem("wiki-admin-token"));
await pub.goto(`${W}#/`, { waitUntil: "load" });
await pub.waitForTimeout(2000);
const pubNav = await pub.evaluate(() => [...document.querySelectorAll("#nav a")].map((a) => a.textContent.replace(/\d+$/, "").trim()));
console.log("player nav:", JSON.stringify(pubNav));
ok(!pubNav.includes("Tiles OLD"), "a player is never shown the migration word “Tiles OLD”");
ok(pubNav.includes("World"), "they still have a World section");
ok(pubNav.filter((n) => n === "World").length === 1, "exactly one ground section, not two half-built ones");
const pubTiles = await pub.evaluate(() => {
  const a = [...document.querySelectorAll("#nav a")].find((x) => /^World/.test(x.textContent));
  return a?.getAttribute("href");
});
ok(pubTiles === "#/tiles", `and it is the one the game actually renders (${pubTiles})`);

// ------------------------------------------- 7. and the World page in his voice
// Maintainer 2026-08-17, looking at the "What is new" panel: "I feel this is
// too technical for players that visits the World page. Normal players will
// just get confused." The section is admin-only in the nav, but a DIRECT LINK
// renders it for anyone, so the page itself has to know which audience it is
// talking to. Every word below is the factory describing its own process.
const JARGON = /\bcandidate|wall \d|wall score|discretion|structure \d|tiling \d|overhang|% flat|postprocess|manifest|Tiles 3\.0|Tiles OLD|outline mode|colour zones|map agent|tiles agent|tombstoned|baked outline|prompt\b/i;
const readable = async (hash) => {
  await pub.goto(`${W}${hash}`, { waitUntil: "load" });
  await pub.waitForTimeout(2200);
  return pub.evaluate(() => document.querySelector("#content")?.innerText ?? "");
};
const pubLevels = {
  types: await readable("#/world"),
  type: await readable(`#/world/${TOP}`),
  pair: await readable(`#/world/${many.top}/${many.side}`),
};
for (const [where, text] of Object.entries(pubLevels)) {
  const hit = text.match(JARGON);
  ok(!hit, `a reader on #/world${where === "types" ? "" : `/${where}`} is told about ground, not about the factory${hit ? ` — found “${hit[0]}” in ${JSON.stringify(text.slice(Math.max(0, hit.index - 30), hit.index + 40))}` : ""}`);
}
// NON-VACUOUS: the same three pages, read by the Game Master, are FULL of it —
// this is a split of audiences, not a deletion of his instruments.
const admLevels = {};
for (const [k, hash] of [["types", "#/world"], ["type", `#/world/${TOP}`], ["pair", `#/world/${many.top}/${many.side}`]]) {
  await p.goto(`${W}${hash}`, { waitUntil: "load" });
  await p.waitForTimeout(2000);
  admLevels[k] = await p.evaluate(() => document.querySelector("#content")?.innerText ?? "");
}
ok(Object.values(admLevels).every((t) => JARGON.test(t)),
  `while the Game Master still gets every measurement on all three levels (${Object.entries(admLevels).map(([k, t]) => `${k}:${(t.match(JARGON) ?? [""])[0]}`).join(", ")})`);
// One ground per pair for a reader: three tries at the same tile, unlabelled,
// is the same confusion in picture form.
const pubCards = await pub.evaluate(() => document.querySelectorAll(".world-cand").length);
const admCards = await p.evaluate(() => document.querySelectorAll(".world-cand").length);
console.log("cards:", JSON.stringify({ player: pubCards, gm: admCards }));
ok(pubCards === 1 && admCards > 1, `a reader sees ONE tile for the pair, the Game Master every generation (${pubCards} vs ${admCards})`);

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nFAILED ${fails.length}` : "\nAll good.");
process.exit(fails.length ? 1 : 0);
