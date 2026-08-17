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
ok(flat.every((c) => /^tiles\/[a-z0-9_]+__over__[a-z0-9_]+\/\d+$/.test(c.key)),
  `every candidate keeps the MANIFEST's own key, so a verdict names what the agent named (${flat[0]?.key})`);
ok(flat.every((c) => c.art?.startsWith("tiles/review/")), "and points at the art the agent published");
ok(flat.every((c) => typeof c.wallScore === "number"), "carrying the agent's measured wall score");
ok(CELLS.every((c) => c.candidates.every((x, i, a) => i === 0 || a[i - 1].wallScore >= x.wallScore)),
  "in the agent's own ranked order — best first");
ok(!!DATA.worldMeta?.accept?.min_wall_score, `and the acceptance bar it ranks against (${DATA.worldMeta?.accept?.min_wall_score})`);
// The score on the page must be the score in the manifest, to the decimal.
const one = CELLS[0], manOne = MAN.cells[one.id];
ok(one.candidates.every((c, i) => c.wallScore === manOne.candidates[i].wall_score),
  `scores match the manifest exactly (${one.id}: ${one.candidates.map((c) => c.wallScore).join(", ")})`);

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
  // The visible one, since the before/after switch keeps both in the DOM.
  src: [...a.querySelectorAll("img")].find((i) => getComputedStyle(i).display !== "none")?.getAttribute("src") ?? "",
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
ok(list.filters.some((f) => /not reviewed/.test(f)), `with a review filter to find the work (${list.filters.join(" | ")})`);

// ------------------------------------------------------------- 3. the review
const cell = CELLS.find((c) => c.candidates.length > 1) ?? CELLS[0];
await p.goto(`${W}#/world/${cell.top}/${cell.side}`, { waitUntil: "load" });
await p.waitForTimeout(1800);
const page = await p.evaluate(() => ({
  h1: document.querySelector("h1")?.textContent,
  cands: document.querySelectorAll(".world-cand").length,
  art: [...document.querySelectorAll(".world-cand")].filter((c) => [...c.querySelectorAll("img")].some((i) => i.complete && i.naturalWidth > 0)).length,
  scores: [...document.querySelectorAll(".world-cand .card-name")].map((x) => x.textContent.trim()),
  metrics: document.querySelector(".world-cand .metric-row")?.textContent ?? "",
  verdicts: document.querySelectorAll(".world-cand .verdict").length,
  pairVerdict: [...document.querySelectorAll(".detail-head button")].map((x) => x.textContent).join("|"),
  prompt: !!document.querySelector(".world-prompt"),
  pager: document.querySelector(".detail-count")?.textContent ?? null,
}));
console.log("cell page:", JSON.stringify(page));
ok(page.cands === cell.candidates.length, `every generation of the pair is shown (${page.cands})`);
ok(page.art === page.cands, `each drawing its own tile (${page.art}/${page.cands})`);
ok(page.verdicts === page.cands, "each with its OWN verdict — the candidate is the review unit");
ok(/tiling/.test(page.metrics) && /discretion/.test(page.metrics) && /structure/.test(page.metrics),
  `and the measurements behind its rank, named (“${page.metrics.trim()}”)`);
ok(/wall \d/.test(page.scores[0] ?? ""), `with the score itself on the card (“${page.scores[0]}”)`);
ok(/drop this pair/.test(page.pairVerdict), "the PAIR has its own verdict too — tombstone it, never regenerate");
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
const fresh = await live.evaluate(() => ({
  h1: document.querySelector("h1")?.textContent,
  has: !!document.querySelector('a.card[href="#/world/sand/moonstone"]'),
  name: document.querySelector('a.card[href="#/world/sand/moonstone"] .card-name')?.textContent ?? null,
}));
console.log("live manifest:", JSON.stringify({ ...fresh, types: freshTop.types.length }));
ok(freshTop.types.includes("#/world/sand"), "a ground type the agent generated after the last build appears at the top level");
ok(fresh.has, `and its pair under it (“${fresh.name}”)`);
ok(liveErrs.length === 0, `no page errors on the live path (${liveErrs.slice(0, 1).join("") || "none"})`);

// ------------------------------------------ 4b. the set, laid out as ground
// Maintainer 2026-08-17: "help me understand how the tileset looks like when
// tiled together. I need both a 3x3 flat ground and the V shape from tiles 2.0
// had … use random tiles from the tileset … a Randomize button … a toggle for
// if we should only have approved tiles or include unreviewed tiles."
// The fixture must be a pair whose WALL material HAS a self pair, or the
// buried-course rule below is never exercised — it falls through to its
// fallback and the check quietly proves nothing.
const hasSelf = (side) => CELLS.some((x) => x.top === side && x.side === side);
// It must also be a pair of two DIFFERENT materials: on a self pair the crown
// and the courses are the same tile by definition, and the rule is satisfied
// without being tested.
const many = CELLS.find((c) => c.candidates.length > 2 && c.id !== cell.id && c.top !== c.side && hasSelf(c.side))
  ?? CELLS.find((c) => c.candidates.length > 2 && c.id !== cell.id) ?? cell;
await p.goto(`${W}#/world/${many.top}/${many.side}`, { waitUntil: "load" });
await p.waitForTimeout(2600);
// A SCENE IS JUDGED BY ITS PIXELS. Both shapes are canvases composed at run
// time, so "did it draw" is a count of opaque pixels and "did it change" is a
// hash of them — an <img> that resolved proves nothing here.
const scenes = () => p.evaluate(() => [...document.querySelectorAll(".world-scene canvas")].map((cv) => {
  const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
  let opaque = 0, sig = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 8) opaque++;
    sig = (sig * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) >>> 0;
  }
  return { w: cv.width, h: cv.height, opaque, sig };
}));
const heads = await p.evaluate(() => [...document.querySelectorAll(".world-scene .panel-title")].map((x) => x.textContent.trim()));
const lay = await scenes();
console.log("layouts:", JSON.stringify({ heads, lay }));
ok(lay.length === 2, `the pair page lays the set out in TWO shapes (${lay.length})`);
ok(/3×3|3x3/i.test(heads[0] ?? ""), `a flat 3×3 patch (“${heads[0]}”)`);
ok(/cliff|stack/i.test(heads[1] ?? ""), `and the V from Tiles OLD — a cliff corner (“${heads[1]}”)`);
// ONLY THE CROWN IS THE PAIR (maintainer 2026-08-17: "The two bottom layers in
// a V shape should always take the tile from grass over grass, ice over ice …
// the type that always should be used in the game when a tile is not at the
// top"). A buried cell is all wall, so it is the WALL material over itself —
// the scene publishes what it actually drew below the crown.
const buried = await p.evaluate(() => (document.querySelectorAll(".world-scene")[1]?.dataset.tiles ?? "").split(" ").filter(Boolean));
const selfSide = CELLS.find((x) => x.top === many.side && x.side === many.side);
console.log("buried courses:", JSON.stringify({ side: many.side, hasSelfPair: !!selfSide, buried }));
if (selfSide) {
  ok(buried.length > 0 && buried.every((t) => t.includes(`${many.side}__over__${many.side}/`)),
    `everything under the crown is ${many.side} over ${many.side} — the tile the game stacks (${buried.length} course tiles)`);
  ok(!buried.some((t) => t.includes(`${many.top}__over__${many.side}/`)),
    "and never the pair itself, whose own top would show as a rim between courses");
} else {
  console.log(`  (${many.side} has no self pair yet — the scene falls back to the set)`);
}
ok(lay.every((s) => s.opaque > 2000), `both actually composed (${lay.map((s) => s.opaque).join(", ")} opaque px)`);
// A 3x3 iso patch spans (c−r) from −2..2, so its canvas is 4*dx + one tile
// wide. Measured against the geometry rather than asserted loosely: "did it
// lay down nine cells" is exactly what a broken layout gets wrong.
const iso = DATA.iso ?? { dx: 32, tilePx: 64, dy: 15 };
const want3 = iso.dx * 4 + iso.tilePx;
ok(Math.abs(lay[0].w - want3) <= 12, `the flat one really is a 3×3 patch (${lay[0].w}px against ${want3} for three cells each way)`);
ok(lay[0].h > iso.tilePx, `standing a diamond tall, not a single row (${lay[0].h}px)`);

// RANDOMIZE gives a different roll of the same set.
let changed = false;
for (let i = 0; i < 6 && !changed; i++) {
  await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Randomize/.test(b.textContent)).click());
  await p.waitForTimeout(700);
  const next = await scenes();
  changed = next.some((s, j) => s.sig !== lay[j].sig);
}
ok(changed, `Randomize rolls a different set of tiles into the layouts (${many.candidates.length} to choose from)`);

// THE POOL TOGGLE. With nothing approved, "approved only" has nothing to lay
// out and must SAY so rather than draw an empty box.
await p.evaluate(() => document.querySelector('[data-bar="wiki-world-pool"] [data-sort="approved"]')?.click());
await p.waitForTimeout(900);
const empty = await p.evaluate(() => ({
  canvases: document.querySelectorAll(".world-scene canvas").length,
  msg: document.querySelector(".world-scenes p")?.textContent ?? "",
  pill: [...document.querySelectorAll(".pill")].find((x) => /in the mix/.test(x.textContent))?.textContent ?? "",
}));
console.log("approved-only, none approved:", JSON.stringify(empty));
ok(empty.canvases === 0 && /no approved tiles/i.test(empty.msg),
  `"approved only" with nothing approved explains itself (“${empty.msg.slice(0, 60)}”)`);
ok(/0 of \d+/.test(empty.pill), `and the mix count says so too (“${empty.pill}”)`);

// Approve one tile and it becomes the whole mix.
await p.evaluate(() => document.querySelector(".world-cand .verdict button")?.click());
await p.waitForTimeout(900);
const oneApproved = await p.evaluate(() => ({
  canvases: document.querySelectorAll(".world-scene canvas").length,
  pill: [...document.querySelectorAll(".pill")].find((x) => /in the mix/.test(x.textContent))?.textContent ?? "",
}));
console.log("approved-only, one approved:", JSON.stringify(oneApproved));
ok(oneApproved.canvases === 2, "approving one tile gives the layouts something to draw");
ok(/^1 of /.test(oneApproved.pill), `and it is the only one in the mix (“${oneApproved.pill}”)`);

// A REJECTED TILE IS NEVER IN THE MIX, under either setting — he rejected it,
// and drawing it in the picture of the finished ground would be the wiki
// arguing with him.
await p.evaluate(() => document.querySelector('[data-bar="wiki-world-pool"] [data-sort="open"]')?.click());
await p.waitForTimeout(800);
const beforeReject = await p.evaluate(() => [...document.querySelectorAll(".pill")].find((x) => /in the mix/.test(x.textContent))?.textContent ?? "");
await p.evaluate(() => {
  const rows = [...document.querySelectorAll(".world-cand .verdict")];
  const last = rows[rows.length - 1];
  [...last.querySelectorAll("button")].find((b) => /✕/.test(b.textContent))?.click();
});
await p.waitForTimeout(900);
const afterReject = await p.evaluate(() => [...document.querySelectorAll(".pill")].find((x) => /in the mix/.test(x.textContent))?.textContent ?? "");
console.log("reject drops it from the mix:", JSON.stringify({ beforeReject, afterReject }));
const n = (t) => Number(/(\d+) of/.exec(t)?.[1] ?? NaN);
ok(n(afterReject) === n(beforeReject) - 1, `rejecting a tile takes it out of the mix (${beforeReject} → ${afterReject})`);

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
const shot = () => p.evaluate(() => ({
  mode: [...document.querySelectorAll('[data-bar="wiki-world-view"] button')].map((b) => (b.classList.contains("sel") ? "*" : "") + b.textContent.trim()),
  // What is actually PAINTED, not what the markup intends.
  shown: [...document.querySelectorAll(".world-cand .world-art")].map((a) => {
    const vis = (i) => i && getComputedStyle(i).display !== "none";
    return vis(a.querySelector(".art-before")) ? "before" : vis(a.querySelector(".art-after")) ? "after" : "none";
  }),
  // Both must be in the DOM: the flip has to be instant, and a src swap
  // re-decodes — the blink is exactly what a comparison must not have.
  loaded: [...document.querySelectorAll(".world-cand .world-art img")].filter((i) => i.complete && i.naturalWidth > 0).length,
  imgs: document.querySelectorAll(".world-cand .world-art img").length,
  tags: [...document.querySelectorAll(".world-cand .art-tag")].map((t) => t.textContent),
  portrait: (() => {
    const a = document.querySelector(".detail-head .world-art");
    if (!a) return null;
    const vis = (i) => i && getComputedStyle(i).display !== "none";
    return vis(a.querySelector(".art-before")) ? "before" : "after";
  })(),
}));
const asShipped = await shot();
console.log("after :", JSON.stringify(asShipped));
ok(asShipped.mode[0] === "*After", `it opens on what the game gets (${asShipped.mode.join(" ")})`);
ok(asShipped.shown.every((x) => x === "after"), "every candidate showing its postprocessed tile");
ok(asShipped.tags.length === 0, "with no badge — the shipped tile is the default, and a badge on it would be noise");
ok(asShipped.loaded === asShipped.imgs && asShipped.imgs === asShipped.shown.length * 2,
  `both images already decoded, so the flip cannot blink (${asShipped.loaded}/${asShipped.imgs})`);

await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-world-view"] button')].find((b) => /Before/.test(b.textContent)).click());
await p.waitForTimeout(900);
const asRaw = await shot();
console.log("before:", JSON.stringify(asRaw));
ok(asRaw.mode[1] === "*Before", "the switch flips the whole set");
ok(asRaw.shown.every((x) => x === "before"), "every candidate now showing the generator's raw output");
ok(asRaw.tags.every((t) => /before/.test(t)) && asRaw.tags.length === asRaw.shown.length,
  "each badged, so mid-comparison the screen always answers “which am I looking at”");
ok(asRaw.portrait === "before", "and the pair's own portrait follows — one truth per screen, never two");

// THE MODE IS A PREFERENCE. He pages ‹ › through 34 pairs judging one property;
// a mode that reset on every page turn would have to be re-pressed 34 times.
await p.evaluate(() => document.querySelector(".detail-nav a, .detail-nav button, .crumb-row a[href^='#/world/']")?.click());
await p.goto(`${W}#/world/${SIDES[1].top}/${SIDES[1].side}`, { waitUntil: "load" });
await p.waitForTimeout(1600);
const nextPair = await shot();
console.log("next pair:", JSON.stringify({ mode: nextPair.mode, shown: nextPair.shown }));
ok(nextPair.mode[1] === "*Before", "paging to the next pair keeps the mode");
ok(nextPair.shown.every((x) => x === "before"), "and lands showing the same side of the comparison");
await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-world-view"] button')].find((b) => /After/.test(b.textContent)).click());
await p.waitForTimeout(500);

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

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nFAILED ${fails.length}` : "\nAll good.");
process.exit(fails.length ? 1 : 0);
