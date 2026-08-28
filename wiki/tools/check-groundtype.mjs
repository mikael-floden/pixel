// THE GROUND TYPE IS A PAGE: base tiles, base colour, palette, transitions.
//
// Maintainer 2026-08-21: "World has Ground types. A Ground type has: Base
// tiles (can be 1, several or a single color), On top of, Transitions ... I
// should be able to promote a tile to be the base tile and also revoke that
// title. The page should show the ground types base color (often the bg on
// the base tile or alone if no base tile exist). The page should also show
// the ground tiles color palette."
//
// The contract:
//   1. EVERYTHING SHOWN IS READ, NOT INVENTED — the identity card mirrors the
//      tiles agent's palette.json (colour + surface taxonomy), the palette is
//      MEASURED off the type's own tiles, transitions mirror tiles/transitions
//      on disk. This gate re-derives each from the same sources.
//   2. PROMOTE/REVOKE round-trips through tuning/base_tiles keyed by the
//      manifest's own tile key, and the page's base colour follows the
//      promoted tile's measured top.
//   3. A PLAYER gets the beauty (colours, palette, transitions) and none of
//      the machinery.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const ROOT = new URL("../../", import.meta.url).pathname;
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const META = D.worldMeta ?? {};
const PAL = JSON.parse(readFileSync(join(ROOT, "tiles/config/palette.json"), "utf8"));

// ---- 1a. the identity data mirrors the tiles agent's own files -------------
const gt = META.groundTypes ?? [];
ok(gt.length > 10, `worldMeta carries the ground types (${gt.length})`);
const misTop = gt.filter((t) => PAL.types?.[t.id]?.top && t.top !== PAL.types[t.id].top);
ok(misTop.length === 0, `every type's base colour is palette.json's own (${misTop.map((t) => t.id).join(", ") || "all match"})`);
const misSurf = gt.filter((t) => PAL.types?.[t.id]?.transition_surface && t.surface !== PAL.types[t.id].transition_surface);
ok(misSurf.length === 0, "and the surface taxonomy is theirs too — own / base / flat");
// The measured palette: for every type with an own-wall set, non-empty and
// DOMINATED by the type's own colour — the postprocess snaps the top to it,
// so the two agreeing is the measurement confirming the config.
const own = (id) => (D.domains.world ?? []).find((c) => c.top === id && c.side === id);
const withOwn = gt.filter((t) => own(t.id));
ok(withOwn.every((t) => (t.palette ?? []).length >= 3),
  `every type with own-wall tiles has a measured palette (${withOwn.filter((t) => !(t.palette ?? []).length).map((t) => t.id).join(", ") || "all"})`);
const disagree = withOwn.filter((t) => t.top && t.palette?.[0] && t.palette[0].c.toLowerCase() !== t.top.toLowerCase());
ok(disagree.length <= 2,
  `and the DOMINANT measured colour is the declared base colour (${disagree.length ? "off: " + disagree.map((t) => `${t.id} ${t.palette[0].c}≠${t.top}`).join(", ") : "all agree"})`);

// ---- 1b. transitions mirror the disk ---------------------------------------
const tDir = join(ROOT, "tiles/transitions");
const diskPairs = existsSync(tDir) ? readdirSync(tDir).filter((d) => d.includes("__to__")) : [];
ok((META.transitions ?? []).length === diskPairs.length,
  `every transition pair on disk is published (${META.transitions?.length} of ${diskPairs.length})`);
ok((META.transitions ?? []).every((t) => Array.isArray(t.sets) && t.sets.length > 0
  && t.sets.every((x) => x.id && typeof x.n === "number" && typeof x.post === "boolean")),
  "each with its full set list — id, tile count, and whether the postprocess is published");
// The paths are DERIVED, so one derived path per pair must really exist.
const p0 = META.transitions[0];
ok(existsSync(join(ROOT, `tiles/transitions/${p0.a}__to__${p0.b}/${p0.sets[0].id}/tile_00.webp`)),
  "and the derived tile paths resolve on disk");

// ---- the page ---------------------------------------------------------------
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const saves = [];
/* THE STUB PERSISTS, because the real server does. A save posts a per-entry
 * delta and the server merges it into the live document, so a reload after a
 * commit shows the committed state — a stub that forgets makes the page look
 * like it lost his work when it did not, and makes any assertion after a
 * reload test the stub instead of the wiki. */
const liveState = { tuning: {}, feedback: {} };
const applySave = (body) => {
  const [kind, name] = String(body?.file ?? "").split("/");
  const bag = kind === "feedback" ? liveState.feedback : liveState.tuning;
  const bucket = body.file === "tuning/base_tile_sets" ? "grounds"
    : body.file === "tuning/monsters" ? "monsters"
    : kind === "feedback" ? "entries" : "overrides";
  const doc = (bag[name] ??= { [bucket]: {} });
  doc[bucket] ??= {};
  for (const [id, v] of Object.entries(body.set ?? {})) { if (v === null) delete doc[bucket][id]; else doc[bucket][id] = v; }
};
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.route("**/api/wiki/save", (r) => {
  const body = r.request().postDataJSON();
  saves.push(body); applySave(body);
  return r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});
await p.route("**/api/live/state", (r) => r.fulfill({ status: 200, contentType: "application/json",
  body: JSON.stringify({ fetched_at: 0, tuning: liveState.tuning, feedback: liveState.feedback }) }));
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
  localStorage.setItem("wiki-world-stars", "all");
});
const GRASS = gt.find((t) => t.id === "grass");
await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
await p.waitForTimeout(2800);
const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
const readTabs = () => p.evaluate(() => [...document.querySelectorAll(".groundtab")].map((x) => ({
  t: x.textContent.trim(), sel: x.classList.contains("sel"), disabled: x.disabled })));
const page = await p.evaluate(() => ({
  pills: [...document.querySelectorAll(".ground-idcard .pill")].map((x) => x.textContent.trim()),
  palette: [...document.querySelectorAll(".ground-palette .ground-swatch")].map((x) => getComputedStyle(x).backgroundColor),
  onTop: document.querySelectorAll("a.card").length,
}));
ok(page.pills.some((t) => t === `base ${GRASS.top}`), `the base colour pill shows the game's own colour (${page.pills.join(" | ")})`);
ok(page.pills.includes("always its own texture") && page.pills.includes("solid"),
  "with the surface taxonomy and category in words");
/* THE CLEAN COLOUR IS NOT MEASURED FROM THE ART, and the page says so where it
 * matters (maintainer 2026-08-27: "Isn't this a median of the top textures? (I
 * thought it was)"). It is palette.json types[g].top; grass's textured tops
 * average 17 RGB units away from it, and darker, which is why a clean tile in
 * a set reads as a patch. Shown only when the gap is visible — parquet is 1
 * unit off and says nothing, which is the check that stops this becoming
 * noise on every page. */
{
  /* THE PILL IS SHOWN IFF THE GAP IS VISIBLE — and the gap is the tiles
   * agent's to close, which they since have: grass was 17 RGB units off and
   * is now 1, so the honest assertion is the RULE, not that grass still
   * differs. Naming grass specifically would fail the day they fixed it,
   * which is the day it should stay quiet. */
  const avgPill = page.pills.find((x) => /texture averages/.test(x));
  const gm = (META.groundTypes ?? []).find((x) => x.id === "grass");
  const px = (h2) => [1, 3, 5].map((i) => parseInt(h2.slice(i, i + 2), 16));
  const gap = gm?.topAvg && gm?.top
    ? Math.round(Math.hypot(...px(gm.top).map((v, i) => v - px(gm.topAvg)[i]))) : 0;
  ok(gap >= 8 ? (!!avgPill && avgPill.includes(gm.topAvg)) : !avgPill,
    `grass's clean colour and its texture are ${gap} RGB apart, so the pill is ${gap >= 8 ? `shown (${avgPill})` : "correctly silent"}`);
  await p.goto(`${W}#/world/parquet_floor`, { waitUntil: "load" });
  await p.waitForTimeout(1600);
  const quiet = await p.evaluate(() => [...document.querySelectorAll(".ground-idcard .pill")].map((x) => x.textContent.trim()));
  ok(!quiet.some((x) => /texture averages/.test(x)),
    `and a ground whose colours already agree stays quiet (parquet, ${quiet.join(" | ")})`);
  await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
  await p.waitForTimeout(1800);
}
ok(page.palette.length === GRASS.palette.length && page.palette[0] === rgb(GRASS.palette[0].c),
  `the measured palette is drawn, largest share first (${page.palette.length} swatches, first ${page.palette[0]})`);

/* ---- 2a. TABS: BASE IS NEVER EMPTY FOR THE ADMIN (maintainer 2026-08-25) ---
 * His older rule — "if we have none this tab is disabled and a user ends up on
 * the second tab instead" — was written when a ground could have no base tiles
 * at all. Under base tile sets every ground has Clean #0, which is the set the
 * admin manages the others from, so for HIM the tab always has something. For a
 * player a ground whose only set is the flat colour still has nothing to look
 * at, and the old rule still holds there — asserted in the player pass below. */
const tabs0 = await readTabs();
ok(tabs0[0]?.t.startsWith("Base") && !tabs0[0].disabled,
  `the admin's Base tab is always open — Clean #0 is always there (${JSON.stringify(tabs0.map((x) => x.t))})`);
const landed = tabs0.find((x) => x.sel);
ok(/^Base/.test(landed?.t ?? ""), `…and that is where he lands, to manage the sets (${landed?.t})`);
const setState = await p.evaluate(() => ({
  panels: [...document.querySelectorAll(".base-set .panel-title")].map((x) => x.textContent.replace(/\s+/g, " ").trim()),
  chips: [...document.querySelectorAll('[data-bar="wiki-world-view"] button, [data-bar="wiki-world-view"] a')].map((x) => x.textContent.trim()),
  fields: document.querySelectorAll(".base-set canvas").length,
  addBtn: !!document.querySelector(".new-set"),
}));
ok(setState.panels.length === 1 && /^Clean #0/.test(setState.panels[0]),
  `with Clean #0 present and nothing else until he makes one (${setState.panels.join(" | ")})`);
/* NO SWITCH ON THE EDITOR (maintainer 2026-08-27: "When I click on the Base
 * tab - it makes no sense to be able to change the Tile art ... looking at
 * Set #2 as if it was Set #1 makes no sense"). The panels each draw their own
 * set; the switch lives on the review tabs. */
ok(setState.chips.length === 0, `the Base tab carries NO pass switch — the panels are the sets (${setState.chips.length} chips)`);
// HIS EXACT WORDS FOR THE EMPTY CASE, on a tab that reviews: "And if no set
// has been created yet at least draw: 'Clean #0'/'Raw'".
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /On top of/.test(x.textContent))?.click());
await p.waitForTimeout(900);
const chips0 = await p.evaluate(() => [...document.querySelectorAll('.ground-pass [data-bar="wiki-world-view"] button')].map((x) => x.textContent.trim()));
ok(chips0.length === 2 && chips0[0] === "Clean #0" && chips0[1] === "Raw",
  `and the review tabs' switch reads exactly Clean #0 / Raw (${chips0.join(" / ")})`);
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /^Base/.test(x.textContent.trim()))?.click());
await p.waitForTimeout(900);
ok(setState.fields >= 1 && setState.addBtn, "the set draws a field of itself, and a new set can be started");
// Then over to the grid, which is where the rest of this gate works.
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /On top of/.test(x.textContent))?.click());
await p.waitForTimeout(1200);
const onTopN = await p.evaluate(() => document.querySelectorAll("a.card").length);
ok(onTopN === (D.domains.world ?? []).filter((c) => c.top === "grass").length,
  `where the whole x-over-y grid still lives (${onTopN} cards)`);

// ---- 2b. PROMOTION IS A MODAL: the tile centred in every group -------------
await p.evaluate(() => [...document.querySelectorAll("a.card")].find((c) => /over grass/.test(c.textContent))?.click());
await p.waitForTimeout(1800);
await p.evaluate(() => { const b2 = [...document.querySelectorAll(".base-btn")].find((x) => /add to a base tile set|another set/.test(x.textContent)); b2.scrollIntoView({ block: "center" }); b2.click(); });
await p.waitForTimeout(900);
const modal1 = await p.evaluate(() => ({
  open: !!document.querySelector(".promote-modal[open]"),
  blocks: [...document.querySelectorAll(".promote-group .panel-title")].map((x) => x.textContent.trim()),
  canvases: document.querySelectorAll(".promote-modal canvas").length,
}));
ok(modal1.open && modal1.blocks.length === 1 && /first set/.test(modal1.blocks[0]),
  `the promote modal opens, offering to start the first set (${modal1.blocks.join(" | ")})`);
ok(modal1.canvases >= 1, "with the candidate composed in a field, not just named");
await p.evaluate(() => [...document.querySelectorAll(".promote-into")].at(-1)?.click());
await p.waitForTimeout(600);
// a second tile: the modal must now show BOTH the existing group (centred
// preview) and the start-a-new-group option.
await p.evaluate(() => { const b2 = [...document.querySelectorAll(".base-btn")].find((x) => /add to a base tile set|another set/.test(x.textContent)); b2.scrollIntoView({ block: "center" }); b2.click(); });
await p.waitForTimeout(900);
const modal2 = await p.evaluate(() => ({
  blocks: [...document.querySelectorAll(".promote-group .panel-title")].map((x) => x.textContent.trim()),
  canvases: document.querySelectorAll(".promote-modal canvas").length,
}));
ok(modal2.blocks.length === 2 && /In Set #1/.test(modal2.blocks[0]) && /new set/.test(modal2.blocks[1]),
  `with a set existing, the modal shows the tile IN it and the new-set option (${modal2.blocks.join(" | ")})`);
ok(modal2.canvases >= 2, "each with its own composed preview");
await p.evaluate(() => [...document.querySelectorAll(".promote-into")][0]?.click());
await p.waitForTimeout(600);
const savedGrass = await p.evaluate(() => JSON.parse(JSON.stringify(window.__wiki.state.tuning.base_tile_sets.grounds.grass ?? null)));
const setIds = (savedGrass?.sets ?? []).map((s) => s.id);
// The second promotion went INTO Set #1 (the modal's first offer), which is
// the point of showing the tile centred in each existing set — so two sets
// total, not three. A tile may sit in several sets; the modal offers them all.
ok(setIds.includes(0) && setIds.includes(1) && setIds.length === 2,
  `the promotions land in Set #1 beside the reserved Clean #0 (ids ${setIds.join(",")})`);
const s1 = (savedGrass?.sets ?? []).find((s) => s.id === 1);
ok((s1?.members ?? []).filter((m) => m.kind === "tile").length >= 1,
  `Set #1 holds what he added (${JSON.stringify((s1?.members ?? []).map((m) => m.kind))})`);
ok((savedGrass?.sets ?? []).every((s) => s.members.some((m) => m.kind === "clean")),
  "and every set carries a clean member, so 0% is expressible on all of them");

/* ---- 2c. THE BASE TAB IS THE SET EDITOR ----------------------------------
 * "The wiki will be responsible to both rework the wiki itself so I can see and
 * manage all base tile sets for every tile type" (maintainer 2026-08-25).
 * Checked as the job it is: make a set, fill it, weight it, see the percentages
 * and the field, and have the switch grow a chip for it. */
// Commit first: the promotions live in the client until saved, and the reload
// below deliberately goes back through the server.
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(900);
/* A FULL RELOAD, not a hash change. Navigating from #/world/grass/light_soil to
 * #/world/grass is a same-document navigation: the SPA routes but every module
 * Map survives, including the one remembering which tab was last opened — so
 * the page under test was the one this gate had already put on "On top of". */
await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
await p.reload({ waitUntil: "load" });
await p.waitForTimeout(2400);
const tabs1 = await readTabs();
ok(tabs1[0]?.sel && !tabs1[0].disabled, `with sets to manage, Base is the default tab (${tabs1.map((x) => x.t + (x.sel ? "*" : "")).join(" ")})`);
const ed = await p.evaluate(() => ({
  panels: [...document.querySelectorAll(".base-set .panel-title")].map((x) => x.textContent.replace(/\s+/g, " ").trim()),
  fields: [...document.querySelectorAll(".base-set .group-stage canvas")].map((c) => ({ w: c.width, h: c.height })),
  rows: [...([...document.querySelectorAll(".base-set")][1]?.querySelectorAll(".set-row") ?? [])].map((r) => r.textContent.replace(/\s+/g, " ").trim()),
  weights: [...document.querySelectorAll(".weight-input")].length,
  names: [...document.querySelectorAll(".set-name")].length,
  addTiles: [...document.querySelectorAll(".add-tiles")].length,
  randomize: !!Array.from(document.querySelectorAll(".base-set button")).find((x) => /Another patch/.test(x.textContent)),
  // THE PAGE'S OWN SWITCH. A promote dialog carries one with the same data-bar,
  // and reading both concatenated them into a six-chip list that matched
  // nothing — a gate failing for a reason that was not the page's fault.
  chips: [...document.querySelectorAll('.ground-pass [data-bar="wiki-world-view"] button, .ground-pass [data-bar="wiki-world-view"] a')].map((x) => x.textContent.trim()),
}));
ok(ed.panels.length === 2 && /^Clean #0/.test(ed.panels[0]),
  `every set is a panel, Clean #0 first and always (${ed.panels.join(" | ")})`);
// HIS UNITS. "how likley (the weight/chance) tile_1 is to be used VS tile_2" —
// he set the model in percentages, so a percentage is beside every row.
ok(ed.panels.every((x) => /\d+% of areas|never used/.test(x)),
  "each saying how often an area of this ground picks it, as a percentage");
/* 7x7 NOW, WITH A RING OF THE GROUND'S OWN CLEAN TILE (maintainer 2026-08-27,
 * on a Set #1 whose front edge showed lava walls: "the base should be all
 * about the TOP ... make this 5x5 preview 7x7 instead so you can surround it
 * with a 100% clean single color top from x over x"). A member's art carries
 * its SOURCE CELL's wall, and in the iso stack only the front row's walls
 * show — so one clean ring hides every foreign wall and the only wall left on
 * screen is the ground's own. Asserted three ways: the field says it is 7x7
 * with a full 24-cell clean ring, the stage is clipped-and-centred rather
 * than scrollable, and — on the pixels — a field whose members were generated
 * over LAVA shows zero lava-coloured pixels. */
ok(ed.fields.length >= 2 && ed.fields.every((f) => f.w > 400),
  `each drawing a 7x7 field of itself (${ed.fields.map((f) => f.w + "x" + f.h).join(" ")})`);
{
  const ring = await p.evaluate(() => {
    const stage = [...document.querySelectorAll(".base-set")][1]?.querySelector(".group-stage");
    const meta = JSON.parse(stage?.dataset.field ?? "{}");
    const cs = stage ? getComputedStyle(stage) : null;
    const cv = stage?.querySelector("canvas");
    const cvr = cv?.getBoundingClientRect(), str = stage?.getBoundingClientRect();
    return {
      n: meta.n, ringClean: meta.ringClean,
      overflow: cs?.overflowX,
      centred: cvr && str ? Math.abs((cvr.left + cvr.right) / 2 - (str.left + str.right) / 2) < 3 : null,
    };
  });
  ok(ring.n === 7 && ring.ringClean === 24,
    `the set field is 7x7 and its whole outer ring is the clean x-over-x tile (${ring.ringClean} of 24 ring cells)`);
  ok(ring.overflow === "hidden" && ring.centred === true,
    `clipped and centred, never scrolled (overflow ${ring.overflow})`);
}
ok(ed.randomize, "with a way to see another patch of the world");
ok(ed.rows.length >= 2 && /Clean colour/.test(ed.rows[0]),
  `and a row per member, the clean colour among them (${ed.rows.join(" | ")})`);
ok(ed.rows.every((r) => /\d+%/.test(r)), "every row carrying its share as a percentage");
// Clean #0 has no name box and no weight box of its own for the clean member —
// it "can only contain 100% the clean/plain base color", so there is nothing to
// set. Two named sets => two name boxes.
ok(ed.names === 1, `Clean #0 cannot be renamed, Set #1 can (${ed.names} name box)`);
ok(ed.addTiles === 1, `and Clean #0 cannot take tiles, Set #1 can (${ed.addTiles} add button)`);

/* THE SWITCH IS THE SETS (maintainer: "the After/Texture/Raw instead will be
 * Set #1/Set #2/Set #3/Raw ... Clean #0/Set #1/Set #2/Set #3/Raw"). */
ok(ed.chips.length === 0, "and still no switch above the editor once sets exist");
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /On top of/.test(x.textContent))?.click());
await p.waitForTimeout(900);
const chips1 = await p.evaluate(() => [...document.querySelectorAll('.ground-pass [data-bar="wiki-world-view"] button')].map((x) => x.textContent.trim()));
ok(chips1[0] === "Clean #0" && chips1.at(-1) === "Raw" && chips1.length === 3,
  `the review tabs' switch reads Clean #0 / the sets / Raw (${chips1.join(" / ")})`);
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /^Base/.test(x.textContent.trim()))?.click());
await p.waitForTimeout(900);
ok(!ed.chips.includes("After") && !ed.chips.includes("Textured"),
  "and After and Textured are gone — a set member IS the texture, so the synthesis has nothing left to do");

/* THE POOL PICKER IS AN AUDITION (maintainer 2026-08-27: "scroll over lots of
 * different tops and preview them in a 7x7 tile preview, where the tile I may
 * add is the center 3x3 surrounded by a 2 border base tile set — according to
 * how the base tile set should be drawn (its weights)"). Still sourced from
 * the textured ballot, never the flat-topped x-over-y tiles. */
await p.evaluate(() => document.querySelector(".add-tiles")?.click());
await p.waitForTimeout(1600);
const pool = await p.evaluate(() => {
  const cv = document.querySelector(".pool-stage canvas");
  return {
    open: !!document.querySelector(".pool-modal[open]"),
    cells: document.querySelectorAll(".pool-cell").length,
    srcs: window.__basesets.basePool("grass").slice(0, 40).map((c) => c.art),
    built: document.querySelectorAll(".pool-cell[data-built='1']").length,
    field: cv ? { w: cv.width, h: cv.height } : null,
    randomize: [...document.querySelectorAll(".pool-modal button")].some((x) => /Randomize/.test(x.textContent)),
  };
});
ok(pool.open && pool.cells > 100, `the pool picker offers this ground's whole ballot (${pool.cells} candidates)`);
/* THE AUDITION FIELD IS 9x9 (maintainer 2026-08-27: "you need todo that
 * preview 9x9 in order to fit the x over x with clean wall around the current
 * 7x7"). The judgment picture is UNCHANGED — centre 3x3 candidate, 2-thick
 * ring of the set — and the added outermost ring is the ground's clean
 * x-over-x tile, standing in front of the set's walls. Clipped and centred,
 * never scrolled. */
{
  const f9 = await p.evaluate(() => {
    const stage = document.querySelector(".pool-stage");
    const meta = JSON.parse(stage?.dataset.field ?? "{}");
    const cv = stage?.querySelector("canvas");
    const cvr = cv?.getBoundingClientRect(), str = stage?.getBoundingClientRect();
    return { ...meta, overflow: stage ? getComputedStyle(stage).overflowX : null,
      centred: cvr && str ? Math.abs((cvr.left + cvr.right) / 2 - (str.left + str.right) / 2) < 3 : null };
  });
  ok(f9.n === 9 && f9.ringClean === 32 && f9.centre === 9,
    `the audition field is 9x9 — candidate 3x3, set ring 2 thick, clean ring outside (${f9.ringClean}/32 clean, ${f9.centre}/9 centre)`);
  ok(f9.overflow === "hidden" && f9.centred === true,
    `and it too is clipped and centred, never scrolled (overflow ${f9.overflow})`);
}
/* SOURCED FROM TEXTURED ART, whatever directory it lives in. The pool was the
 * ballot alone until 2026-08-27, which exists for five grounds — the other ten
 * had a disabled "+ Add tiles…" that did nothing when pressed. It is the
 * plates roster now (plates/index.json's own pool.rule) plus the ballot, minus
 * every tile whose top is >=90% one tone. That filter is the point: measured,
 * grass plates are 100% flat and paving plates only 10%, so a filter by ground
 * or by directory would be wrong in both directions. A flat tile offered as a
 * base tile IS the clean colour, which every set already carries. */
/* THE AUDITION SHOWS THE TEXTURED PASS (tiles agent, 2026-08-27, relaying the
 * maintainer mid-audition: "the Add-to-Set audition still renders entry.after,
 * so every clean-top ground auditions as flat colour and he cannot judge set
 * membership at all"). `after` is the pass whose top the postprocess flattens
 * and a base tile is judged ENTIRELY on its top — measured on black_rock,
 * after is 100% flat tops against textured's 30%. Plates carry the same flat
 * top because they were conformed from after, so the preference has to reach
 * the plate pool and not only review art. */
/* Only the REVIEW candidates have a textured pass — a ballot entry
 * (<pair>__<variant>.webp from tiles/base_candidates) is its own art, the pure
 * corner of a generated transition, and never had a flattened top to fix. */
// Only REVIEW candidates have a textured pass: a ballot tile is its own art,
// and a top-only tile never had a wall or a flattened top to fix.
const reviewSrcs = pool.srcs.filter((s) => !/base_candidates|tiles\/tops\//.test(s));
ok(reviewSrcs.every((s) => /_textured\.webp$/.test(s)),
  `every review candidate is auditioned as its TEXTURED pass, never the flattened one (${reviewSrcs[0]?.split("/").pop() ?? "none in view"})`);
/* ...AND ON A GROUND WITH NO BALLOT AT ALL, which is where it actually broke.
 * Grass's pool opens with ballot tiles, so the check above can pass over three
 * rows that never had a textured pass to prefer — vacuously. black_rock
 * appears in ZERO transition pairs, so every row is a review candidate, and it
 * is the ground he was auditioning when he found every candidate flat. */
{
  const p2 = await ctx.newPage();
  await p2.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
  await p2.route("**/api/wiki/save", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await p2.addInitScript(() => {
    localStorage.setItem("wiki-admin-token", "gate");
    localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
  });
  await p2.goto(`${W}#/world/black_rock`, { waitUntil: "load" });
  await p2.waitForTimeout(2400);
  await p2.evaluate(() => document.querySelector(".new-set")?.click());
  await p2.waitForTimeout(600);
  await p2.evaluate(() => document.querySelector(".add-tiles")?.click());
  await p2.waitForTimeout(2200);
  const br = await p2.evaluate(() => ({
    n: document.querySelectorAll(".pool-cell").length,
    srcs: window.__basesets.basePool("black_rock").slice(0, 8).map((c) => c.art),
    labels: [...document.querySelectorAll(".pool-name")].slice(0, 8).map((i) => i.textContent),
  }));
  /* THE TOP-ONLY POOL LEADS THE AUDITION (maintainer 2026-08-27: "you should
   * include this new set when I scroll over details tiles or base set tiles
   * that has not been rejected"). Generated with the wall meaningless, so they
   * are ground surface and nothing else — and SUBTLE first, because those are
   * the sheets meant to survive repetition, which is what a set does. */
  ok(br.srcs.slice(0, 3).every((s) => /tiles\/tops\//.test(s)),
    `the top-only pool leads the audition (${br.srcs[0]?.split("/").slice(-2).join("/")})`);
  /* AND IT DRAWS THE PUBLISHED POST PASS, NEVER THE RAW SHEET (tiles agent,
   * blocking, 2026-08-27: "the tops AUDITION is rendering the RAW pass, not
   * post/ ... please land this before anything else").
   *
   * A top-only sheet ships in the generator's colour; the post pass moves the
   * whole tile so its background lands on the ground's clean colour, keeping
   * each detail's own colour instead of dragging it to the anchor. Measured on
   * the tile he was auditioning — black_rock sheet_00_subtle tile_11 — the raw
   * top face is 41 RGB off that colour and the post file is 0. Asserted on the
   * PATH each row asks for, which cannot disagree with what is on screen. */
  const topsSrcs = br.srcs.filter((s) => /tiles\/tops\//.test(s));
  ok(topsSrcs.length > 0 && topsSrcs.every((s) => /\/post\//.test(s)),
    `and every one of them from its post/ pass, none raw (${topsSrcs.length} tops rows, ${topsSrcs.filter((s) => !/\/post\//.test(s)).length} raw)`);
  /* AND IT IS POSTPROCESSED, NOT RAW (maintainer 2026-08-27: "Ofc I don't
   * want to see the tile as raw here. I want to see the top as textured, but
   * postprocessed"). The sheets are raw generator COLOUR — grass measures 84
   * RGB units off the palette — so the audition corrects hue and saturation to
   * the palette with the pipeline's own substitute() rule. Asserted on the
   * PIXELS of the corrected thumb: the mean must land on the palette colour,
   * which raw art misses by an unmissable margin. */
  {
    const p3 = await ctx.newPage();
    await p3.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
    await p3.route("**/api/wiki/save", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await p3.addInitScript(() => {
      localStorage.setItem("wiki-admin-token", "gate");
      localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
    });
    await p3.goto(`${W}#/world/grass`, { waitUntil: "load" });
    await p3.waitForTimeout(2200);
    await p3.evaluate(() => (document.querySelector(".add-tiles") ?? document.querySelector(".new-set"))?.click());
    await p3.waitForTimeout(700);
    await p3.evaluate(() => { if (!document.querySelector(".pool-modal[open]")) document.querySelector(".add-tiles")?.click(); });
    await p3.waitForTimeout(2200);
    /* MEASURED ON WHATEVER THE ROW RENDERS, and on the TOP FACE alone.
     * Two corrections, both paid for: the audition used to draw an
     * in-browser-corrected CANVAS and now draws the tiles agent's published
     * post/ file as an <img>, so a canvas-only probe read null and scored 999
     * against a page that was in fact correct. And a top-only tile's wall is
     * meaningless by its own index, so averaging the whole tile is the wrong
     * region — measuring it that way is what made me nearly tell the tiles
     * agent their pass was worse than the raw art. */
    const pp = await p3.evaluate(async () => {
      const node = document.querySelector(".pool-cell canvas.pool-tile, .pool-cell img.pool-tile");
      if (!node) return null;
      try {
        const w = node.naturalWidth || node.width, h2 = node.naturalHeight || node.height;
        if (!w || !h2) return null;
        if (node.tagName === "IMG" && !node.complete) await node.decode();
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h2;
        const cx = cv.getContext("2d", { willReadFrequently: true });
        cx.imageSmoothingEnabled = false;
        cx.drawImage(node, 0, 0, w, h2);
        const d = cx.getImageData(0, 0, w, h2).data;
        const WALL = 17;
        let r = 0, g2 = 0, b2 = 0, n = 0;
        for (let x = 0; x < w; x++) {
          let top = -1, bot = -1;
          for (let y = 0; y < h2; y++) if (d[(y * w + x) * 4 + 3] > 200) { if (top < 0) top = y; bot = y; }
          if (top < 0) continue;
          for (let y = top; y <= bot - WALL; y++) {
            const i = (y * w + x) * 4;
            if (d[i + 3] <= 200) continue;
            r += d[i]; g2 += d[i + 1]; b2 += d[i + 2]; n++;
          }
        }
        return n ? [r / n, g2 / n, b2 / n] : null;
      } catch { return "tainted"; }
    });
    const tgt = [0x14, 0x52, 0x3b];
    const dist = Array.isArray(pp) ? Math.round(Math.hypot(...pp.map((v, i) => v - tgt[i]))) : 999;
    ok(Array.isArray(pp) && dist <= 12,
      `a grass top auditions in the game's own palette — corrected mean ${Array.isArray(pp) ? "#" + pp.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : pp} is ${dist} from #14523b on the TOP FACE (raw art misses by 84)`);
    await p3.close();
  }
  ok(br.srcs.slice(0, 3).every((s) => /_subtle_/.test(s)),
    "and its SUBTLE sheets come first — the ones that survive being repeated across a field");
  ok(br.labels.slice(0, 3).every((l) => /subtle top/.test(l)),
    `each naming its flavour, since there is no wall to name it by (${br.labels[0]})`);
  // The review candidates are still there, behind them, still textured.
  ok(br.srcs.some((s) => /_textured\.webp$/.test(s)) || br.n > 300,
    `with the review candidates behind them (${br.n} rows in all)`);
  await p2.close();
}
ok(pool.srcs.every((s) => /base_candidates|\/plates\/|tiles\/tops\/|_textured\.webp$/.test(s)),
  `sourced from published tile art (${pool.srcs.map((s) => s.split("/").slice(-2, -1)[0]).join(", ")})`);
/* EVERYTHING APPROVED IS OFFERED — the full plates roster plus the ballot,
 * nothing filtered (maintainer 2026-08-27: "all accepted tiles for brown
 * paving stone over x should be a candidate here. So why do you try to make
 * the button disabled in the first place?"). A build briefly dropped tops
 * >=90% one tone from the pool; that was a taste call made in a script, and
 * this assertion exists so it cannot come back: the offered count must equal
 * roster + ballot exactly. Flatness is a SORT and a PILL, never a gate. */
{
  const expect = (META.patternLib?.plates?.grass?.pool.length ?? 0)
    + (META.basePools?.grass?.length ?? 0)
    + (META.tops?.grass?.length ?? 0);
  // Minus what this run already added to the set — a member is rightly not
  // offered twice, and that is the only legitimate subtraction.
  const inSet = await p.evaluate(() =>
    (window.__wiki.state.tuning.base_tile_sets.grounds.grass?.sets.find((x) => x.id === 1)?.members ?? []).filter((m) => m.kind === "tile").length);
  const rejHere = await p.evaluate(() =>
    (window.__wiki.state.tuning.base_tile_sets.grounds.grass?.sets.find((x) => x.id === 1)?.rejected ?? []).length);
  ok(pool.cells === expect - inSet - rejHere,
    `every approved top is offered, none filtered (${pool.cells} = plates ${META.patternLib?.plates?.grass?.pool.length} + ballot ${META.basePools?.grass?.length} + top-only ${META.tops?.grass?.length} − ${inSet} in the set − ${rejHere} rejected for it)`);
  /* THE OFFERED ORDER, read by what each pill SAYS rather than by whether a
   * row has one. It counted any pill as "flat", which the new off-colour badge
   * also is — a probe that broke the moment a second badge existed.
   *
   * Two claims, both his: the top-only pool leads (it is the pool generated
   * FOR this decision), and within what follows the flat tops come last —
   * sorted, never dropped, since "all accepted tiles ... should be a
   * candidate here". */
  const order = await p.evaluate(() => [...document.querySelectorAll(".pool-cell")].map((r) => ({
    tops: /tiles\/tops\//.test(r.querySelector(".pool-tile")?.getAttribute("src") ?? r.dataset.cand ?? ""),
    flat: [...r.querySelectorAll(".pool-head .pill")].some((x) => /flat top/.test(x.textContent)),
  })));
  const lastTop = order.map((x) => x.tops).lastIndexOf(true);
  const firstOther = order.findIndex((x) => !x.tops);
  ok(lastTop === -1 || firstOther === -1 || lastTop < firstOther,
    `the top-only pool leads — the tiles generated for this decision come first (${order.filter((x) => x.tops).length} of ${order.length})`);
  const rest = order.filter((x) => !x.tops);
  const firstFlat = rest.findIndex((x) => x.flat), lastTextured = rest.map((x) => x.flat).lastIndexOf(false);
  ok(firstFlat === -1 || lastTextured < firstFlat,
    `and among the rest the flat tops come last — sorted, not dropped (${rest.filter((x) => !x.flat).length} textured, ${rest.filter((x) => x.flat).length} flat)`);
}
// A 7x7 at 1:1 is 13 lattice steps + a tile wide = 448px + padding. Anything
// materially narrower is not the field he specified.
ok(pool.field && pool.field.w > 440 && pool.built >= 1 && pool.built < pool.cells,
  `each candidate auditions in a 7×7 field of the set, built lazily (${pool.built} built of ${pool.cells}, ${pool.field?.w}×${pool.field?.h})`);
ok(pool.randomize, "with a Randomize that re-rolls the surrounding set");
/* REJECT IS PER SET (maintainer 2026-08-27: "I need a reject button here to
 * not have to review the same tiles over and over again! But rejecting the
 * tile in the Base Tile #1 add dialog doesn't reject that same top/tile in
 * the Base Tile #2 add dialog."). Proven across two sets on the same top. */
const rejCand = await p.evaluate(() => document.querySelector(".pool-cell")?.dataset.cand);
await p.evaluate(() => document.querySelector(".pool-reject")?.click());
await p.waitForTimeout(500);
const rejState = await p.evaluate(() => ({
  dimmed: document.querySelectorAll(".pool-cell.set-rejected").length,
  undo: /undo/.test(document.querySelector(".pool-reject")?.textContent ?? ""),
}));
ok(rejState.dimmed === 1 && rejState.undo, "rejecting dims the row in place and offers an undo where the thumb just was");
/* THE WAY OUT IS BOTTOM-RIGHT AND ALWAYS REACHABLE (maintainer 2026-08-27:
 * "where should I click for Ok/Close ... You added the Close button at the top
 * of the dialog and not the bottom right. I have naver seen that UX before").
 * Asserted with the list scrolled to its END, which is the state that made the
 * header unreachable in the first place. */
await p.evaluate(() => { const l = document.querySelector(".pool-list"); l.scrollTop = l.scrollHeight; });
await p.waitForTimeout(400);
const foot = await p.evaluate(() => {
  const dlg = document.querySelector(".pool-modal"), f = document.querySelector(".pool-foot"), d2 = document.querySelector(".pool-done");
  if (!dlg || !f || !d2) return null;
  const dr = dlg.getBoundingClientRect(), fr = f.getBoundingClientRect(), br = d2.getBoundingClientRect();
  return {
    onScreen: br.top >= 0 && br.bottom <= window.innerHeight + 1,
    right: Math.abs(br.right - (fr.right - 14)) < 8,
    bottom: Math.abs(fr.bottom - dr.bottom) < 3,
    tall: Math.round(br.height),
    tally: document.querySelector(".pool-tally")?.textContent ?? "",
  };
});
ok(foot && foot.onScreen && foot.right && foot.bottom,
  `Done sits at the dialog's bottom-right and stays there with the list scrolled to the end (${JSON.stringify(foot && { onScreen: foot.onScreen, right: foot.right, bottom: foot.bottom })})`);
ok(foot.tall >= 44, `at the 44px tap target this site holds everywhere else (${foot.tall}px)`);
/* EXACTLY ONE WAY OUT (maintainer 2026-08-27: "you added a Done button, but
 * didn't remove the X Close button at the top. So now we have both"). They did
 * the identical thing — picks are staged as they are made and neither discards
 * anything — so the dialog carried two buttons for one action. Counted, not
 * eyeballed, because a second exit is exactly the sort of thing that gets
 * added back by someone being helpful. */
const exits = await p.evaluate(() =>
  [...document.querySelectorAll(".pool-modal button")].filter((x) => /close|done|cancel/i.test(x.textContent)).map((x) => x.textContent.trim()));
ok(exits.length === 1 && exits[0] === "Done", `and it is the ONLY way out of the dialog (${exits.join(", ") || "none"})`);
ok(/Commit to save/.test(foot.tally), `and it says what happened and what is still owed (${foot.tally})`);
await p.evaluate(() => [...document.querySelectorAll(".pool-modal button")].find((x) => /Close/.test(x.textContent))?.click());
await p.waitForTimeout(700);
await p.evaluate(() => document.querySelector(".add-tiles")?.click());
await p.waitForTimeout(1200);
const gone = await p.evaluate((f) => ({
  offersIt: !!document.querySelector(`.pool-cell[data-cand="${f}"]`),
  pill: [...document.querySelectorAll(".promote-head .pill")].some((x) => /rejected here/.test(x.textContent)),
}), rejCand);
ok(!gone.offersIt && gone.pill, `reopening the same set no longer offers it, and says so (${rejCand})`);
await p.evaluate(() => [...document.querySelectorAll(".pool-modal button")].find((x) => /Close/.test(x.textContent))?.click());
await p.waitForTimeout(700);
// A SECOND set still offers the same top — the verdict did not leak.
await p.evaluate(() => document.querySelector(".new-set")?.click());
await p.waitForTimeout(600);
await p.evaluate(() => [...document.querySelectorAll(".add-tiles")].at(-1)?.click());
await p.waitForTimeout(1200);
ok(await p.evaluate((f) => !!document.querySelector(`.pool-cell[data-cand="${f}"]`), rejCand),
  "while a different set still offers the same top — the rejection is the set's, not the tile's");
await p.evaluate(() => [...document.querySelectorAll(".pool-modal button")].find((x) => /Close/.test(x.textContent))?.click());
await p.waitForTimeout(700);
await p.evaluate(() => document.querySelector(".add-tiles")?.click());
await p.waitForTimeout(900);

/* A MISCLICK IS RECOVERABLE (maintainer 2026-08-27: "I missclicked and
 * clicked + Add to Set #1. Now I'm unable to click - Remove from Set #1. All
 * I can do is cancel everything and start all over"). The add button used to
 * disable itself on the way in, so one wrong tap could only be undone by
 * discarding every other decision in the sitting — the reject button had been
 * given an undo for exactly this reason and this one had not. Nothing here is
 * saved until Commit, so every verdict in the dialog must be reversible in
 * place. */
{
  const cell = async () => p.evaluate(() => {
    const c = document.querySelector(".pool-cell");
    const a = c.querySelector(".pool-add");
    return { label: a.textContent.trim(), disabled: a.disabled, inSet: c.classList.contains("in-set") };
  });
  const members = async () => p.evaluate(() =>
    (window.__wiki.state.tuning.base_tile_sets.grounds.grass?.sets.find((s) => s.id === 1)?.members ?? [])
      .filter((m) => m.kind === "tile").length);
  const m0 = await members();
  await p.evaluate(() => document.querySelector(".pool-cell .pool-add").click());
  await p.waitForTimeout(500);
  const inS = await cell();
  ok(inS.inSet && !inS.disabled && /tap to remove/.test(inS.label),
    `after adding, the button stays live and says how to undo (${inS.label})`);
  ok((await members()) === m0 + 1, "and the member really went in");
  await p.evaluate(() => document.querySelector(".pool-cell .pool-add").click());
  await p.waitForTimeout(500);
  const back = await cell();
  ok(!back.inSet && /^\+ Add/.test(back.label) && (await members()) === m0,
    `tapping it again takes the member back out (${back.label}, ${await members()} members)`);
}

// Adding keeps the audition open — he adds several in one sitting.
await p.evaluate(() => document.querySelector(".pool-add")?.click());
await p.waitForTimeout(700);
const afterAdd = await p.evaluate(() => ({
  open: !!document.querySelector(".pool-modal[open]"),
  marked: document.querySelectorAll(".pool-cell.in-set").length,
}));
ok(afterAdd.open && afterAdd.marked === 1, `adding marks the row and keeps the audition open (${afterAdd.marked} marked)`);
await p.evaluate(() => [...document.querySelectorAll(".pool-modal button")].find((x) => /Close/.test(x.textContent))?.click());
await p.waitForTimeout(900);

/* A TILE IN A SET CAN BE LOOKED AT CLOSE UP (maintainer 2026-08-27: "a way to
 * look at a specific tile in a base tile set in 2x by clicking on it ... can
 * be hard when not able to look at a given tile zoomed in"). The dialog opens
 * at the 2x he asked for AND shows a field of that tile alone, because what he
 * is hunting is the member causing a visible repeat, and a mark only reads as
 * a pattern once it sits next to itself. */
await p.evaluate(() => document.querySelector(".set-row-zoom")?.click());
await p.waitForTimeout(1600);
const tz = await p.evaluate(() => {
  const tile = document.querySelector(".tilezoom-tile");
  return {
    open: !!document.querySelector(".tilezoom-modal[open]"),
    zoomSel: document.querySelector('[data-bar="tilezoom"] .sel')?.textContent.trim(),
    tileW: tile ? Math.round(tile.getBoundingClientRect().width) : 0,
    fieldTiles: !!document.querySelector(".tilezoom-modal .group-stage canvas"),
    done: !!document.querySelector(".tilezoom-modal .pool-done"),
  };
});
ok(tz.open && tz.zoomSel === "2×" && tz.tileW === 128,
  `tapping a set row's tile opens it at 2x — 128 screen px of a 64px tile (${tz.tileW}px, sel ${tz.zoomSel})`);
ok(tz.fieldTiles, "beside a field of that tile ALONE, where a repeat becomes visible");
ok(tz.done, "with the way out at the bottom right, where an OK button lives");
await p.evaluate(() => document.querySelector(".tilezoom-modal .pool-done")?.click());
await p.waitForTimeout(600);
ok(await p.evaluate(() => !document.querySelector(".tilezoom-modal[open]")), "and Done closes it");

// WEIGHT 0 MUST MEAN NEVER — the old base-tile weight clamped to a 0.1 floor,
// which made "never" impossible to say. It is how he switches a set off.
await p.evaluate(() => { const w = [...document.querySelectorAll(".base-set")][1].querySelector(".weight-input"); w.value = "0"; w.dispatchEvent(new Event("change", { bubbles: true })); });
await p.waitForTimeout(700);
const zeroed = await p.evaluate(() => {
  const s = window.__wiki.state.tuning.base_tile_sets.grounds.grass.sets.find((x) => x.id === 1);
  return { w: s?.weight, title: [...document.querySelectorAll(".base-set .panel-title")].map((x) => x.textContent.replace(/\s+/g, " ").trim()) };
});
ok(zeroed.w === 0, `a weight of 0 is stored as 0, not floored (${zeroed.w})`);
ok(zeroed.title.some((x) => /never used/.test(x)), `and the panel says so in words (${zeroed.title.join(" | ")})`);

// THE SAVE IS A PER-GROUND DELTA on the new file.
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(900);
const saved = saves.at(-1);
ok(saved?.file === "tuning/base_tile_sets" && Object.keys(saved.set ?? {})[0] === "grass",
  `Commit posts one delta per GROUND to the new file (${saved?.file}, keys ${Object.keys(saved?.set ?? {}).join(",")})`);
ok(Array.isArray(Object.values(saved?.set ?? {})[0]?.sets),
  "carrying the whole set list for that ground");

// ---- 2e. GROUND DETAILS: the fourth tab, the second review axis ------------
// (maintainer 2026-08-21: "There are a LOT of tiles that look AMAZING if you
// not show them to often! ... the WALL is irrelevant ... you must be able to
// see how the tile looks like without the clean-single-color-top
// postprocessing ... give it a top star and approval ... we could here list
// tiles not yet reviewed. Then I will have something TODO when I get bored")
await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
await p.waitForTimeout(2200);
const tabsD = await readTabs();
ok(tabsD.length === 4 && /Details/.test(tabsD[1].t) && !tabsD[1].disabled,
  `four tabs, Details second — enabled for the admin even when empty, the queue is his TODO (${tabsD.map((x) => x.t).join(" | ")})`);
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /Details/.test(x.textContent))?.click());
await p.waitForTimeout(1800);
// THE QUEUE IS WHAT IS LEFT, not the whole ground. This counted every grass
// candidate, which was the same number only while he had judged no tops at
// all; he has since judged 66, and a gate that reddens because the maintainer
// worked is a broken gate. Derived from the live doc, like the counts on the
// page itself.
const topJudged = await p.evaluate(() => {
  const e = window.__wiki.state.feedback.tiles?.entries ?? {};
  return Object.keys(e).filter((k) => k.endsWith("#top") && (e[k].status || e[k].rating)).length;
});
const expQueue = (D.domains.world ?? []).filter((c) => c.top === "grass")
  .reduce((n, c) => n + c.candidates.length, 0);         // the whole ground, for the message
const dq = await p.evaluate(() => ({
  queuePill: [...document.querySelectorAll(".panel-title .pill")].map((x) => x.textContent),
  cards: document.querySelectorAll(".detail-card").length,
  canvases: document.querySelectorAll(".detail-card canvas").length,
  stars: document.querySelectorAll(".detail-card .stars").length,
  more: [...document.querySelectorAll("button")].some((x) => /Show 12 more/.test(x.textContent)),
}));
// What the page should say: every top of this ground that nobody has judged.
/* BOTH POOLS. Since 2026-08-27 the queue is the x-over-y candidates AND the
 * top-only tiles, which is what he asked for — so the expectation counts both,
 * each unjudged on its own #top key. */
const expLeft = await p.evaluate(() => {
  const w = window.__wiki;
  const e = w.state.feedback.tiles?.entries ?? {};
  return (w.state.data.domains.world ?? []).filter((c) => c.top === "grass")
    .flatMap((c) => c.candidates).map((x) => x.key)
    .concat((w.state.data.worldMeta.tops?.grass ?? []).map((x) => x.id))
    .filter((k) => { const v = e[`${k}#top`]; return !v || (!v.status && !v.rating); }).length;
});
ok(dq.queuePill.some((x) => x === String(expLeft)),
  `the queue counts the tops nobody has judged — ${expLeft} left of ${expQueue}, with ${topJudged} already done`);
/* THE TOP-ONLY TILES ARE IN THE DETAILS QUEUE TOO, and lead it (maintainer
 * 2026-08-27: "you should include this new set when I scroll over details
 * tiles or base set tiles"). They are purpose-built for this decision, where
 * an x-over-y candidate's top is a by-product of a tile generated to show a
 * wall — and DETAIL sheets first among them, the mirror of subtle-first in the
 * base-tile pool, because a detail is by construction the once-in-a-while
 * showpiece this tab collects.
 *
 * They have no cell, so the card must not offer the dead "from <cell>" link
 * that #/world/<ground>/null would have been. */
{
  // the LABEL row, not the whole card — the wall stepper's text sits above it
  const lead = await p.evaluate(() => [...document.querySelectorAll(".detail-card")].slice(0, 3).map((c) => ({
    text: (c.querySelector(".card-sub .muted[title]")?.textContent ?? c.textContent).replace(/\s+/g, " ").trim().slice(0, 40),
    deadLink: [...c.querySelectorAll("a")].some((a) => /\/null$/.test(a.getAttribute("href") ?? "")),
  })));
  ok(lead.every((x) => /top · sheet/.test(x.text)),
    `the top-only tiles lead the details queue (${lead[0]?.text.slice(0, 26)})`);
  ok(lead.every((x) => /detail top/.test(x.text)),
    "detail sheets first among them — the once-in-a-while showpieces this tab is for");
  ok(lead.every((x) => !x.deadLink), "and none offers a link to a cell it does not have");
}
ok(dq.cards === 12 && dq.canvases === 12 && dq.stars === 12 && dq.more,
  `twelve at a time, each COMPOSED in the ground with its own stars, and more on demand (${dq.cards})`);
// approve one from the queue → the collection, the tab count, the #top save
await p.evaluate(() => { const b2 = [...document.querySelectorAll(".detail-card button")].find((x) => /approve/.test(x.textContent)); b2.scrollIntoView({ block: "center" }); b2.click(); });
await p.waitForTimeout(900);
const dApproved = await p.evaluate(() => ({
  tab: [...document.querySelectorAll(".groundtab")].find((x) => /Details/.test(x.textContent))?.textContent.trim(),
  keys: Object.keys(window.__wiki.state.feedback.tiles.entries ?? {}).filter((k) => k.endsWith("#top")),
}));
ok(/Details1/.test(dApproved.tab.replace(/\s+/g, "")), `approving a top moves it into the collection and the tab count (${dApproved.tab})`);
// One MORE #top key than before the click, and it is the tile's own key with
// the suffix — asserted as a delta, since the doc already carries his.
ok(dApproved.keys.length === topJudged + 1 && dApproved.keys.every((k) => /#top$/.test(k)),
  `the verdict rides the tile's own key with the #top suffix (${dApproved.keys.length} keys, was ${topJudged})`);
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(700);
const topSave = saves.at(-1);
ok(topSave?.file === "feedback/tiles" && Object.keys(topSave.set).every((k) => k.endsWith("#top")),
  "Commit posts it into the tiles feedback doc — the same channel, a second axis");
// INDEPENDENCE: the top approval must not leak into the pair-tile filters.
const leak = await p.evaluate(() => {
  const bar = [...document.querySelectorAll(".sortbar")].find((b2) =>
    [...b2.querySelectorAll(".sortbar-btn")].some((x) => /^no stars /.test(x.textContent)));
  return [...(bar?.querySelectorAll(".sortbar-btn") ?? [])].map((x) => x.textContent.trim());
});
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /On top of/.test(x.textContent))?.click());
await p.waitForTimeout(700);
const leak2 = await p.evaluate(() => {
  const bar = [...document.querySelectorAll(".sortbar")].find((b2) =>
    [...b2.querySelectorAll(".sortbar-btn")].some((x) => /^no stars /.test(x.textContent)));
  return [...(bar?.querySelectorAll(".sortbar-btn") ?? [])].map((x) => x.textContent.trim());
});
void leak;
// TEST THE LEAK ITSELF, not a number. This asserted "approved 0" — true only
// while he had approved no tile of this ground; he has since approved plenty,
// and a gate that reddens because the maintainer did his job is a broken gate.
// The claim is narrow: a `#top` verdict must never be counted as a verdict on
// the TILE. So take the count, add a #top approval, and it must not move.
const beforeLeak = leak2.find((x) => /^approved /.test(x)) ?? "";
const afterLeak = await p.evaluate(async () => {
  const w = window.__wiki;
  const cand = (w.state.data.domains.world ?? []).find((c) => c.top === "grass")?.candidates?.[0];
  if (!cand) return null;
  w.setFb("tiles", `${cand.key}#top`, { status: "approved" });
  w.route();
  await new Promise((r) => setTimeout(r, 900));
  const bar = [...document.querySelectorAll(".sortbar")].find((b2) =>
    [...b2.querySelectorAll(".sortbar-btn")].some((x) => /^no stars /.test(x.textContent)));
  const got = [...(bar?.querySelectorAll(".sortbar-btn") ?? [])].map((x) => x.textContent.trim()).find((x) => /^approved /.test(x));
  // PUT IT BACK COMPLETELY. Restoring the value is not enough: setFb also
  // marks the id touched, and the leftover made a later check see two pending
  // ids where it expected one.
  w.setFb("tiles", `${cand.key}#top`, { status: null });
  delete (w.state.feedback.tiles.entries ?? {})[`${cand.key}#top`];
  w.state.touched["feedback/tiles"]?.delete(`${cand.key}#top`);
  if (!w.state.touched["feedback/tiles"]?.size) { delete w.state.touched["feedback/tiles"]; w.state.dirty.delete("feedback/tiles"); }
  return got ?? "";
});
ok(!!beforeLeak && afterLeak === beforeLeak,
  `a #top approval never leaks into the pair-tile review ("${beforeLeak}" before, "${afterLeak}" after adding one)`);
// AFTER IS THE DEFAULT, AND THE SWITCH FLIPS EVERY TILE IN EVERY 3x3
// (maintainer 2026-08-21: "the tile is rendered in the middle, but is
// displayed before postprocessing always. AFTER postprocessing should be
// default and the switch can take you to BEFORE. That switch will then change
// on all 3x3 tiles"). Asserted on the WIRE — which pass the page actually
// fetches — because a composition is a canvas and its pixels cannot be read
// back cross-origin.
const passes = { after: 0, before: 0 };
const countPass = (r) => {
  const u = r.url();
  if (/_after\.webp$/.test(u)) passes.after++;
  else if (/_before\.webp$/.test(u)) passes.before++;
};
// The default is a claim about a FRESH reader, so start from no stored
// preference — earlier sections in this gate deliberately leave one behind.
await p.evaluate(() => localStorage.removeItem("wiki-world-view"));
await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
await p.waitForTimeout(1600);
// COUNT ONLY THE COMPOSITION. The pair CARDS deliberately carry both images
// at once — CSS decides which is visible, so the A/B flip cannot blink — so a
// page load legitimately fetches 30 _before files in After mode. Counting from
// here scopes the claim to the tiles the Details tab composes.
p.on("request", countPass);
passes.after = 0; passes.before = 0;
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /Details/.test(x.textContent))?.click());
await p.waitForTimeout(2200);
const dSwitch = await p.evaluate(() => ({
  sel: document.querySelector(".sortbar-btn.sel")?.textContent.trim(),
  chips: [...document.querySelectorAll(".sortbar-btn")].slice(0, 3).map((x) => x.textContent.trim()),
  promote: document.querySelectorAll(".detail-card .base-btn").length,
  cards: document.querySelectorAll(".detail-card").length,
}));
ok(dSwitch.chips[0] === "Clean #0" && dSwitch.chips.at(-1) === "Raw" && dSwitch.sel === "Clean #0",
  `the Details tab carries the set switch, on Clean #0 (${dSwitch.chips.join(" | ")}, sel ${dSwitch.sel})`);
/* HIS 2026-08-28 SPEC, all three parts ("A detail is supposed to only be
 * displayed once and not tiled ... the base tile set selected on all tiles
 * except the center ... we need help from the x over x in order to draw the
 * outer cell border so we get a nice looking wall"):
 * once — the probe's centre is a single face, not a 3x3;
 * the switch is LIVE — Clean and Set ring on different art, and the pixels
 * under the same window actually change (the bug reported was a placebo
 * switch: "doesn't matter what Tile art option I click on");
 * walls — every cell is tex2-dressed in the ground's x-over-x wall. */
const dProbe = () => p.evaluate(() => ({ ...(window.__wikiDetail ?? {}) }));
const dPix = () => p.evaluate(() => {
  const cv = document.querySelector(".detail-card canvas");
  if (!cv || !cv.width) return null;
  const d2 = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
  let h2 = 0;
  for (let i = 0; i < d2.length; i += 7) h2 = (h2 * 31 + d2[i]) >>> 0;
  return h2;
});
const dClean = await dProbe();
ok(dClean.view === "clean" && dClean.dressed && dClean.ringDistinct === 1,
  `under Clean the ring is the clean plate, walls from x-over-x (${dClean.ringDistinct} ring face, dressed ${dClean.dressed})`);
const pixClean = await dPix();
await p.evaluate(() => [...document.querySelectorAll('.ground-pass [data-bar="wiki-world-view"] button')].find((x) => /^Set #/.test(x.textContent.trim()))?.click());
await p.waitForTimeout(2000);
const dSet = await dProbe();
const pixSet = await dPix();
ok(/^set:/.test(dSet.view) && dSet.ringDistinct >= 1 && dSet.ringSample !== dClean.ringSample,
  `flipping to a set changes the RING's source art (${dSet.ringSample?.split("/").slice(-1)[0]})`);
ok(pixClean !== null && pixSet !== null && pixClean !== pixSet,
  "and the pixels on screen actually change — the switch is not a placebo");
/* THE CENTRE IS THE POST PASS (maintainer 2026-08-28: "Ofc I want to see the
 * center tile with a postprocessed top"). A top-only tile's queue candidate
 * used to wrap the RAW sheet in the in-browser palette guess (ppPath) — hue
 * corrected, raw relief — while the audition and set members already drew the
 * tiles agent's published post file. One tile, two renderings. The candidate
 * carries `post` as art now; Raw is the one view that means the raw sheet. */
ok(typeof dSet.centre === "string" && /\/post\//.test(dSet.centre) && !dSet.centre.startsWith("pp:"),
  `a top-only detail's centre face IS the published post file (${dSet.centre?.split("/").slice(-2).join("/")})`);
await p.evaluate(() => [...document.querySelectorAll('.ground-pass [data-bar="wiki-world-view"] button')].find((x) => x.textContent.trim() === "Raw")?.click());
await p.waitForTimeout(1600);
const dRaw = await dProbe();
ok(dRaw.view === "before" && typeof dRaw.centre === "string" && !/\/post\//.test(dRaw.centre) && !dRaw.centre.startsWith("pp:"),
  `and Raw shows the generator's own sheet, unsubstituted (${dRaw.centre?.split("/").slice(-2).join("/")})`);
/* ---- THE BEST WALL, NOT THE FIRST (maintainer 2026-08-28: "you should not
 * just pick 'the first' x over x - you should pick the BEST ... closest in
 * color/tune and structure") -------------------------------------------- */
{
  const wp = META.wallPools ?? {};
  ok(Object.keys(wp).length >= 10 && Object.values(wp).every((pool) => pool.every((c) =>
    c.key && c.art && (!c.m || (c.m.length === 3 && c.m.every((v) => v >= 0 && v <= 255))))),
    `every ground publishes its measured x-over-x wall pool (${Object.keys(wp).length} grounds)`);
  // the same argmin the page computes, recomputed HERE from the raw data
  const argmin = (pool, fst) => {
    let bi = 0, bd = Infinity;
    pool.forEach((c, i) => {
      if (!c.m || !fst?.m) return;
      const d = Math.hypot(c.m[0] - fst.m[0], c.m[1] - fst.m[1], c.m[2] - fst.m[2]) / 441
        + 0.35 * Math.abs((c.flat ?? 0.5) - (fst.tflat ?? fst.flat ?? 0.5))
        + 0.25 * Math.abs((c.k ?? 6) - (fst.tk ?? 6)) / 24;
      if (d < bd) { bd = d; bi = i; }
    });
    return bi;
  };
  /* a fixture where best ≠ first, or the assertion cannot tell best-pick
   * from first-pick: search the DATA for one */
  let fix = null;
  for (const [g, pool] of Object.entries(wp)) {
    if (pool.length < 2) continue;
    for (const t of META.tops?.[g] ?? []) {
      if (t.m && argmin(pool, t) !== 0) { fix = { g, t, want: argmin(pool, t) }; break; }
    }
    if (fix) break;
  }
  ok(!!fix, `the data holds a top whose measured best wall is NOT the pool's first (${fix ? `${fix.g} → #${fix.want + 1}` : "none — the assertion below cannot discriminate"})`);
  if (fix) {
    await p.goto(`${W}#/world/${fix.g}`, { waitUntil: "load" });
    await p.waitForTimeout(2200);
    await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /Details/.test(x.textContent))?.click());
    await p.waitForTimeout(2200);
    const walls = await p.evaluate(() => ({ ...(window.__wikiDetail ?? {}) }));
    ok(typeof walls.wallIdx === "number" && walls.wallN >= 2 && walls.wallAuto === true,
      `a detail card publishes its chosen wall (#${walls.wallIdx + 1} of ${walls.wallN}, auto ${walls.wallAuto})`);
    // the stepper: next stores HIS choice, stepping back onto auto deletes it
    const step = await p.evaluate(() => {
      const row = [...document.querySelectorAll(".wall-step")].at(-1);
      return { rows: document.querySelectorAll(".wall-step").length, label: row?.textContent.replace(/\s+/g, " ").trim() ?? "" };
    });
    ok(step.rows >= 1 && /auto · best match|your pick/.test(step.label),
      `every detail card carries the wall stepper (${step.rows} rows, "${step.label.slice(0, 40)}")`);
    const w0 = await p.evaluate(() => window.__wikiDetail.wall);
    await p.evaluate(() => { const row = [...document.querySelectorAll(".wall-step")].at(-1); [...row.querySelectorAll("button")].find((b2) => b2.textContent === "›")?.click(); });
    await p.waitForTimeout(1600);
    const w1 = await p.evaluate(() => ({ wall: window.__wikiDetail.wall, auto: window.__wikiDetail.wallAuto,
      pending: Object.values(window.__wiki.state.touched).reduce((n2, s3) => n2 + s3.size, 0) }));
    ok(w1.wall !== w0 && w1.auto === false && w1.pending >= 1,
      `stepping › composes the NEXT wall and stores the choice (${String(w1.wall).split("/").pop()})`);
    await p.evaluate(() => { const row = [...document.querySelectorAll(".wall-step")].at(-1); [...row.querySelectorAll("button")].find((b2) => b2.textContent === "‹")?.click(); });
    await p.waitForTimeout(1600);
    const w2 = await p.evaluate(() => ({ wall: window.__wikiDetail.wall, auto: window.__wikiDetail.wallAuto,
      ov: Object.keys(window.__wiki.state.tuning.top_walls?.overrides ?? {}).length }));
    ok(w2.wall === w0 && w2.auto === true && w2.ov === 0,
      "stepping back onto the measured best CLEARS the override — absent means auto");
    await p.evaluate(() => document.querySelector("#save-btn")?.click());
    await p.waitForTimeout(700);
    // back where the rest of the gate expects to be
    await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
    await p.waitForTimeout(2000);
    await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /Details/.test(x.textContent))?.click());
    await p.waitForTimeout(1600);
    await p.evaluate(() => [...document.querySelectorAll('.ground-pass [data-bar="wiki-world-view"] button')].find((x) => x.textContent.trim() === "Clean #0")?.click());
    await p.waitForTimeout(1200);
  }
}
await p.evaluate(() => [...document.querySelectorAll('.ground-pass [data-bar="wiki-world-view"] button')].find((x) => x.textContent.trim() === "Clean #0")?.click());
await p.waitForTimeout(1200);
// THE DETAILS TAB DELIBERATELY IGNORES "After" NOW (2026-08-22): a
// clean-colour top is nothing to judge, so its compositions ask for texture —
// which fetches the raw pass too, by design. The default-is-After claim
// belongs on a tab that still honours the stored pass.
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /^Base/.test(x.textContent.trim()))?.click());
await p.waitForTimeout(1400);
passes.after = 0; passes.before = 0;
// "Another patch" recomposes the field from a different origin.
await p.evaluate(() => [...document.querySelectorAll(".base-set button")].find((x) => /Another patch/.test(x.textContent))?.click());
await p.waitForTimeout(1800);
ok(passes.before === 0,
  `and a tile composed on a tab that honours the switch is fetched POSTPROCESSED by default (${passes.after} after, ${passes.before} before)`);
// ON EVERY TAB, NOT TWO OF FOUR (maintainer 2026-08-21: "I have browsed around
// on the entire wiki and can still not find a way to render tiles without the
// 'clean color top'. This makes it impossible to promote anything at all").
// The switch used to live on On top of and Details; Base tiles — where a group
// is judged — and the promote modal — where the promotion is decided — had
// none, and in After every field looks seamless because the postprocess
// flattens the top to one colour.
for (const tabName of ["Details", "On top of", "Transitions"]) {
  await p.evaluate((t2) => [...document.querySelectorAll(".groundtab")].find((x) => x.textContent.includes(t2))?.click(), tabName);
  await p.waitForTimeout(700);
  const hasPass = await p.evaluate(() => ({
    pass: !!document.querySelector(".ground-pass"),
    n: document.querySelectorAll(".ground-pass .sortbar-btn").length,
    sel: document.querySelector(".ground-pass .sortbar-btn.sel")?.textContent.trim(),
    labels: [...document.querySelectorAll(".ground-pass .sortbar-btn")].map((x) => x.textContent.trim()).join("/"),
  }));
  /* EVERY TAB, and the chips are now the ground's own sets (maintainer
   * 2026-08-25). His list: "Clean #0/Set #1/Set #2/Set #3/Raw". Clean first,
   * Raw last, his sets between — asserted by shape rather than by a fixed
   * count, because the count is whatever he has built. */
  ok(hasPass.pass && hasPass.n >= 2 && hasPass.sel === "Clean #0"
    && hasPass.labels.startsWith("Clean #0/") && hasPass.labels.endsWith("/Raw"),
    `the ground's sets are the passes on the ${tabName} tab (${hasPass.labels})`);
}
/* THE WHOLE TAB STRIP HAS TO FIT ON A PHONE (maintainer 2026-08-25: "Instead
 * of 'Base tiles' can you write just 'Base' so the entire radio button group /
 * tabs fit on the page (it's cut right now)").
 *
 * His rename recovered 40px and the strip was STILL 21px over at 412px — so
 * the rest came out of the tab padding and the count chip. Asserted at every
 * phone width rather than the one he happened to screenshot, because "fits"
 * was true at 430 and false at 393 the whole time.
 */
for (const w of [360, 393, 412, 430]) {
  const ctxW = await b.newContext({ viewport: { width: w, height: 900 }, isMobile: true, hasTouch: true });
  const pw = await ctxW.newPage();
  await pw.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
  await pw.addInitScript(() => {
    localStorage.setItem("wiki-admin-token", "gate");
    localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
  });
  await pw.goto(`${W}#/world/grass`, { waitUntil: "load" });
  await pw.waitForTimeout(1800);
  const fit = await pw.evaluate(() => {
    const bar = document.querySelector(".groundtabs");
    const tabs = [...bar.querySelectorAll(".groundtab")];
    return {
      over: Math.round(bar.scrollWidth - bar.clientWidth),
      labels: tabs.map((x) => x.textContent.replace(/\s+/g, " ").trim()).join(" | "),
      tall: Math.round(tabs[0].getBoundingClientRect().height),
    };
  });
  ok(fit.over <= 0 && fit.tall >= 40,
    `every tab is on screen at ${w}px, and still a 44px target (${fit.over}px over, ${fit.tall}px tall — ${fit.labels})`);
  await ctxW.close();
}

/* THE SWITCH MUST NOT MOVE THE ART (maintainer 2026-08-25: "I don't like the
 * text to the right side of After/Textured/Raw … this makes the entire site
 * jump up and down when pressing the buttons. So it's hard to see how the
 * individual pixels changed due to the jump").
 *
 * The hints beside it were different lengths, so one wrapped to two lines and
 * another to one and the row changed height on every press — taking the tiles
 * below it with it. A control for comparing two pictures cannot move the
 * pictures. Measured, not eyeballed: the switch keeps its height and the first
 * tile under it keeps its position across all three passes. */
/* MEASURED ON A REVIEW TAB, with the labels that exist. This loop still asked
 * for "After"/"Textured" long after they became Clean #0 and the ground's
 * sets — `?.click()` swallowed both misses, so it compared one pass against
 * itself twice and proved nothing. Worse, its selector spanned EVERY
 * .ground-pass on the page: on Transitions that now includes the pair-level
 * Tile art row, so asking for "Raw" there switched the whole section to raw
 * art and leaked into the checks below it. Scoped to the ground's own switch,
 * on the tab that has one. */
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /On top of/.test(x.textContent))?.click());
await p.waitForTimeout(1000);
const passGeom = [];
const groundPasses = await p.evaluate(() => [...document.querySelectorAll('.ground-pass [data-bar="wiki-world-view"] button')].map((x) => x.textContent.trim()));
for (const want of groundPasses) {
  await p.evaluate((w) => [...document.querySelectorAll('.ground-pass [data-bar="wiki-world-view"] button')].find((x) => x.textContent.trim() === w)?.click(), want);
  await p.waitForTimeout(900);
  passGeom.push(await p.evaluate(() => {
    const bar = document.querySelector(".ground-pass").getBoundingClientRect();
    const first = document.querySelector(".trans-row, .detail-card, .world-cand, .base-group, .grid .card")?.getBoundingClientRect();
    return { h: Math.round(bar.height), art: first ? Math.round(first.top - bar.top) : null };
  }));
}
ok(groundPasses.length >= 2, `measured across every pass the ground offers (${groundPasses.join(", ")})`);
ok(new Set(passGeom.map((g2) => g2.h)).size === 1,
  `the switch is the same height on every pass, so nothing below it moves (${passGeom.map((g2) => g2.h).join(", ")}px)`);
ok(new Set(passGeom.map((g2) => g2.art)).size === 1,
  `and the art under it does not shift when he presses one (${passGeom.map((g2) => g2.art).join(", ")}px below the switch)`);
// AND THE GROUP UNDER IT KEEPS ITS DISTANCE — "when I press on Raw the radio
// button group has no line space until the next radio button group begins".
const gap = await p.evaluate(() => {
  const bar = document.querySelector(".ground-pass");
  const next = bar.nextElementSibling;
  return next ? Math.round(next.getBoundingClientRect().top - bar.getBoundingClientRect().bottom) : -1;
});
ok(gap >= 8, `with a real gap before whatever comes next (${gap}px)`);
// ---- THE TRANSITION STRIPS OBEY THE SWITCH TOO ---------------------------
// Maintainer 2026-08-24, after the tiles agent published the processed pass:
// "Its good that you fixed so the Transition page now renders After correctly.
// But now it looks like Before instead fails to render correctly."
//
// It did. wangScene had been taught to follow the switch and both plain STRIPS
// — the rows on this tab and the 16 corner tiles on the demo page — were still
// passing the set's `post` FLAG where the pass belongs, so they drew the
// processed tiles under every setting and Before looked identical to After.
// Asserted on the FILES FETCHED, which is the only thing that cannot lie.
const transFetch = [];
const plateFetch = [];
const countTrans = (r) => {
  if (/tiles\/transitions\//.test(r.url())) transFetch.push(r.url());
  if (/tiles\/(plates|patterns|base_candidates)\//.test(r.url())) plateFetch.push(r.url());
};
p.on("request", countTrans);
/* TWO ROWS TO DRIVE NOW: the ground's own side choice, and the pair-level
 * source (Composed/Raw). They are INDEPENDENT since 2026-08-27 — picking a set
 * no longer leaves raw, which is the whole point — so a check about composing
 * has to set the source itself instead of assuming a side click clears it. */
const passFetches = async (side, source = "Composed") => {
  await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
  await p.waitForTimeout(1600);
  await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /Transitions/.test(x.textContent))?.click());
  await p.waitForTimeout(1400);
  const clickIn = async (label, txt) => p.evaluate(([l, x2]) => {
    const row = [...document.querySelectorAll(".ground-pass")].find((r) => new RegExp(l).test(r.querySelector(".muted")?.textContent ?? ""));
    [...(row?.querySelectorAll("button") ?? [])].find((b2) => b2.textContent.trim() === x2)?.click();
  }, [label, txt]);
  // Count the ACTION's fetches, not the setup's: whichever row is not under
  // test is settled first, then the counters are cleared, then the one being
  // measured is pressed.
  if (side) {
    await clickIn("Tile art", source);
    await p.waitForTimeout(900);
    transFetch.length = 0; plateFetch.length = 0;
    await clickIn("Grass", side);
  } else {
    transFetch.length = 0; plateFetch.length = 0;
    await clickIn("Tile art", source);
  }
  await p.waitForTimeout(2200);
  return {
    post: transFetch.filter((u) => /\/post\//.test(u)).length,
    raw: transFetch.filter((u) => !/\/post\//.test(u)).length,
    // NOT the fetch count: plates and the mask sheet sit in the HTTP cache
    // after the first visit, so requests undercount on exactly the runs that
    // matter — the same warm-cache trap this file already documents for
    // Textured. The composer's own probe counts every composition.
    mixes: await p.evaluate(() => window.__wikiMix ?? 0),
    kids: await p.evaluate(() => {
      const s2 = document.querySelector(".trans-row .trans-strip");
      return s2 ? [...s2.children].map((c) => c.tagName.toLowerCase()).join(",") : "";
    }),
  };
};
/* THE MASKS LANDED (tiles agent, 2026-08-25: tiles/patterns/ + tiles/plates/),
 * so the switch composes now. Clean and Set passes fetch PLATES and the mask
 * sheet — never tiles/transitions/ art; Raw fetches exactly the pregenerated
 * raw pass, which is the only place it exists. The old assertion here — that a
 * set chip still draws the processed pair art — was written to fail on the day
 * the masks landed, and it did. */
const trClean = await passFetches("Clean #0");
ok(trClean.post === 0 && trClean.raw === 0 && trClean.mixes > 0,
  `on Transitions, Clean #0 composes from plates — no pregenerated art fetched (${trClean.mixes} composites, ${trClean.post} post, ${trClean.raw} raw)`);
ok(trClean.kids.includes("canvas") && !trClean.kids.includes("img"),
  `the strip is composed canvases, not files (${trClean.kids})`);
const trBefore = await passFetches(null, "Raw");
ok(trBefore.raw > 0 && trBefore.post === 0,
  `and Raw draws the generator's own pregenerated tiles (${trBefore.post} post, ${trBefore.raw} raw)`);
const trSet = await passFetches("Set #1");
ok(trSet.post === 0 && trSet.raw === 0,
  `a set chip composes too — zero pregenerated fetches (${trSet.post} post, ${trSet.raw} raw)`);
p.off("request", countTrans);
await p.evaluate(() => [...document.querySelectorAll(".ground-pass .sortbar-btn")].find((x) => x.textContent.trim() === "Clean #0")?.click());
await p.waitForTimeout(900);
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /Details/.test(x.textContent))?.click());
await p.waitForTimeout(700);
passes.after = 0; passes.before = 0;
/* ASSERTED ON THE RESOLVED PATH, NOT ON FETCHES. Counting requests measures
 * the HTTP cache the moment anything has already been viewed — a trap this
 * file already documents for Textured, and one the details queue walked into
 * the day top-only tiles joined it: those have exactly ONE pass, themselves,
 * so flipping to Raw on them correctly fetches nothing at all. What the claim
 * is really about is which pass a card resolves to. */
await p.evaluate(() => [...document.querySelectorAll(".sortbar-btn")].find((x) => x.textContent.trim() === "Raw")?.click());
await p.waitForTimeout(1200);
const rawRes = await p.evaluate(() => {
  const w2 = window.__wiki;
  const cands = (w2.state.data.domains.world ?? []).filter((c) => c.top === "grass")
    .flatMap((c) => c.candidates).filter((x) => x.raw).slice(0, 5);
  const tops = (w2.state.data.worldMeta.tops?.grass ?? []).slice(0, 3);
  return {
    review: cands.map((c) => w2.viewArtIn("before", c)),
    topOnly: tops.map((t) => w2.viewArtIn("before", { key: t.id, art: t.art, raw: null })),
  };
});
ok(rawRes.review.length > 0 && rawRes.review.every((s2) => /_before\.webp$/.test(s2 ?? "")),
  `under Raw an x-over-y candidate resolves to the generator's own art (${rawRes.review[0]?.split("/").pop()})`);
ok(rawRes.topOnly.every((s2) => /(^|\/)tiles\/tops\//.test(s2 ?? "")),
  `and a top-only tile resolves to itself — it has exactly one pass (${rawRes.topOnly[0]?.split("/").pop()})`);
p.off("request", countPass);
await p.evaluate(() => [...document.querySelectorAll(".sortbar-btn")].find((x) => x.textContent.trim() === "After")?.click());
await p.waitForTimeout(1200);
/* THE DETAIL CARD ASKS ONE QUESTION (maintainer 2026-08-28: "Remove the
 * 'add to a base tile set..' button and make the rating have normal stars" —
 * superseding 2026-08-21's promote-from-here). Promotion lives on the Base
 * tab's pool picker; the card carries plain, visible stars. */
ok(dSwitch.promote === 0 && dSwitch.cards > 0,
  `no promote control on a detail card — the card asks only "is this a detail" (${dSwitch.promote} on ${dSwitch.cards} cards)`);
const starRead = () => p.evaluate(() => {
  const c = [...document.querySelectorAll(".detail-card")].at(-1);   // a QUEUE card
  return {
    cards: document.querySelectorAll(".detail-card").length,
    label: c?.querySelector(".card-sub .muted, .card-sub a")?.textContent ?? "",
    roofs: document.querySelectorAll(".detail-card .stars.roofs").length,
    glyphs: [...(c?.querySelectorAll(".stars button") ?? [])].map((x) => x.textContent),
    lit: c?.querySelectorAll(".stars button.lit").length ?? -1,
    // The NUMBER the savebar renders, read at its source — the bar's text
    // repaint is async and a mid-flight read sees the pre-commit value.
    pending: Object.values(window.__wiki.state.touched).reduce((n2, s3) => n2 + s3.size, 0),
  };
});
// Flush whatever earlier steps left pending, so the tap's delta is its own —
// and WAIT for the bar to hide: the commit is async, and reading the bar
// mid-flight sees the pre-commit number.
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForFunction(() => document.querySelector("#savebar")?.classList.contains("hidden"), { timeout: 6000 }).catch(() => {});
const st0 = await starRead();
ok(st0.roofs === 0 && st0.glyphs.length === 5 && st0.glyphs.every((g2) => g2 === "\u2606"),
  `the rating is five NORMAL stars, empty before any tap (${st0.glyphs.join("")})`);
/* THE TAP MUST BE VISIBLE AND THE CARD MUST HOLD STILL (maintainer
 * 2026-08-28: "when clicking on the rating today I can't see it getting any
 * stars. So I click again and again and the 'x changes' just keep counting
 * up"): rating a tile removed it from the judged-by-nobody queue and the
 * re-route slid the next card under his thumb — every further tap starred a
 * DIFFERENT tile, one more pending change each. */
await p.evaluate(() => [...document.querySelectorAll(".detail-card")].at(-1)?.querySelectorAll(".stars button")[2]?.click());
await p.waitForTimeout(400);
const st1 = await starRead();
ok(st1.lit === 3 && st1.cards === st0.cards && st1.label === st0.label,
  `tapping the third star LIGHTS three stars on the SAME card — no vanish, no shuffle (${st1.lit} lit)`);
ok(st1.pending === st0.pending + 1, `one tap, one pending change (${st0.pending} → ${st1.pending})`);
await p.evaluate(() => [...document.querySelectorAll(".detail-card")].at(-1)?.querySelectorAll(".stars button")[2]?.click());
await p.waitForTimeout(400);
const st2 = await starRead();
ok(st2.lit === 0 && st2.cards === st1.cards && st2.label === st1.label && st2.pending === st1.pending,
  `a second tap on the same star clears it in place — the count does NOT keep counting up (still ${st2.pending})`);
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(700);

/* AN X-OVER-Y DETAIL SHOWS ITS TEXTURED TOP (maintainer 2026-08-28: "it
 * looks as if the top is just a plain/clean color... They need to show their
 * postprocessed top that is not clean/plain!"). A flat-top ground SHIPS the
 * clean colour on its After pass, so the card must draw `tex`. Mark every
 * grass top-only tile judged so the queue's head becomes x-over-y cards. */
{
  const fdoc = (liveState.feedback.tiles ??= { entries: {} });
  fdoc.entries ??= {};
  for (const t of (META.tops?.grass ?? [])) fdoc.entries[`${t.id}#top`] = { rating: 2, updated_at: "2026-08-28T00:00:00Z" };
  await p.reload({ waitUntil: "load" });
  await p.waitForTimeout(2600);
  await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /Details/.test(x.textContent))?.click());
  await p.waitForTimeout(1400);
  await p.evaluate(() => [...document.querySelectorAll('.ground-pass [data-bar="wiki-world-view"] button')].find((x) => x.textContent.trim() === "Clean #0")?.click());
  await p.waitForTimeout(2000);
  const dXY = await dProbe();
  ok(/_textured\./.test(dXY.centre ?? ""),
    `an x-over-y detail's centre is the TEXTURED pass — After ships the clean colour on flat-top grounds (${dXY.centre?.split("/").pop()})`);
  await p.evaluate(() => [...document.querySelectorAll('.ground-pass [data-bar="wiki-world-view"] button')].find((x) => x.textContent.trim() === "Raw")?.click());
  await p.waitForTimeout(1600);
  const dXYr = await dProbe();
  ok(/_before\.webp$/.test(dXYr.centre ?? ""),
    `and Raw still means the generator's own (${dXYr.centre?.split("/").pop()})`);
}

// THE PROMOTION MODAL, deep-tested where its button lives now: the x-over-y
// candidate card (the pool picker covers the Base tab).
const mCell = (D.domains.world ?? []).find((c2) => c2.top === "grass" && c2.side !== "grass");
await p.goto(`${W}#/world/grass/${mCell.side}`, { waitUntil: "load" });
await p.waitForTimeout(1900);
await p.evaluate(() => { const b2 = document.querySelector(".world-cand .base-btn"); b2.scrollIntoView({ block: "center" }); b2.click(); });
await p.waitForTimeout(900);
const dModal = await p.evaluate(() => ({
  open: !!document.querySelector(".promote-modal[open]"),
  blocks: [...document.querySelectorAll(".promote-group .panel-title")].map((x) => x.textContent.trim()),
}));
ok(dModal.open && dModal.blocks.length >= 1,
  `and it opens the SAME promotion modal (${dModal.blocks.join(" | ")})`);
const modalPass = await p.evaluate(() => ({
  pass: !!document.querySelector(".promote-pass"),
  sel: document.querySelector(".promote-pass .sortbar-btn.sel")?.textContent.trim(),
}));
ok(modalPass.pass && /^(Clean #0|Set #\d+|Raw)$/.test(modalPass.sel ?? ""),
  `the modal carries the pass switch — the promotion is decided in here (sel ${modalPass.sel})`);
let mAfter = 0, mBefore = 0;
const countM = (r) => { const u = r.url(); if (/_after\.webp$/.test(u)) mAfter++; else if (/_before\.webp$/.test(u)) mBefore++; };
p.on("request", countM);
await p.evaluate(() => [...document.querySelectorAll(".promote-pass .sortbar-btn")].find((x) => x.textContent.trim() === "Raw")?.click());
await p.waitForTimeout(1800);
p.off("request", countM);
const stillOpen = await p.evaluate(() => ({
  open: !!document.querySelector(".promote-modal[open]"),
  sel: document.querySelector(".promote-pass .sortbar-btn.sel")?.textContent.trim(),
}));
/* THE CLAIM IS "WITHOUT CLOSING IT", and that is what is asserted. The
 * fetch count was the evidence until the cache made it zero — by this point
 * the gate has already viewed these tiles under Raw twice — so the repaint is
 * proven by the previews still being there and the chip having moved, which
 * is the behaviour the maintainer asked for ("flipping here repaints the
 * previews in place and leaves the page set the same way"). */
const stillDrawn = await p.evaluate(() => document.querySelectorAll(".promote-modal canvas").length);
ok(stillOpen.open && stillOpen.sel === "Raw" && stillDrawn > 0,
  `flipping inside it repaints the previews without closing it (${stillDrawn} previews still drawn, ${mBefore} fetched)`);
// The pass the whole feature exists for, in the dialog where promotion is
// decided: the ground as one of HIS sets paints it.
await p.evaluate(() => [...document.querySelectorAll(".promote-pass .sortbar-btn")].find((x) => /^Set #/.test(x.textContent.trim()))?.click());
await p.waitForTimeout(1800);
// READ THE PICTURE, not the synthesis counter: the same tiles may already be
// in the cache from the Details tab, and a cache hit is a success, not a miss.
const mTex = await p.evaluate(() => {
  const cv = document.querySelector(".promote-modal canvas");
  let colours = -1;
  if (cv) {
    try {
      const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      const s2 = new Set();
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) s2.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      colours = s2.size;
    } catch { colours = "tainted"; }
  }
  return { open: !!document.querySelector(".promote-modal[open]"), sel: document.querySelector(".promote-pass .sortbar-btn.sel")?.textContent.trim(), colours };
});
/* READ THE PICTURE, not a counter. A field drawn from a set must carry real
 * surface — a clean-topped field measures a handful of colours, which is the
 * failure mode this number exists to catch. */
ok(mTex.open && /^Set #\d+$/.test(mTex.sel ?? "") && typeof mTex.colours === "number" && mTex.colours > 6,
  `and a set inside the dialog really draws a textured field, without closing it (${mTex.sel}, ${mTex.colours} colours)`);
// THE DIALOG MUST NOT JUMP EITHER — it carried the same per-pass text ("raw" /
// "textured, in palette" / "clean colour"), three different widths reflowing
// the header above the very previews the dialog exists to compare.
const modalGeom = [];
const mChips = await p.evaluate(() => [...document.querySelectorAll(".promote-pass .sortbar-btn")].map((x) => x.textContent.trim()));
for (const want of mChips) {
  await p.evaluate((w) => [...document.querySelectorAll(".promote-pass .sortbar-btn")].find((x) => x.textContent.trim() === w)?.click(), want);
  await p.waitForTimeout(900);
  modalGeom.push(await p.evaluate(() => {
    const bar = document.querySelector(".promote-pass")?.getBoundingClientRect();
    const first = document.querySelector(".promote-group")?.getBoundingClientRect();
    return bar && first ? { h: Math.round(bar.height), gap: Math.round(first.top - bar.top) } : null;
  }));
}
ok(modalGeom.every(Boolean) && new Set(modalGeom.map((x) => x.h)).size === 1 && new Set(modalGeom.map((x) => x.gap)).size === 1,
  `and the dialog holds still across passes too (${modalGeom.map((x) => `${x?.h}/${x?.gap}`).join(", ")})`);
// READ WHAT THE DIALOG WAS LEFT ON, do not assume it. This asserted "Textured"
// because that was the last pass an earlier version pressed; the geometry loop
// above now ends on Raw, and a constant here would go red for a change in the
// test rather than in the page.
const leftOn = await p.evaluate(() => document.querySelector(".promote-pass .sortbar-btn.sel")?.textContent.trim() ?? "");
await p.evaluate(() => [...document.querySelectorAll(".promote-modal button")].find((x) => /Close/.test(x.textContent))?.click());
await p.waitForTimeout(1000);
const synced = await p.evaluate(() => document.querySelector(".world-viewbar .sortbar-btn.sel")?.textContent.trim());
ok(!!leftOn && synced === leftOn, `and the page behind adopts the pass the modal was left on (${leftOn} → ${synced})`);
await p.evaluate(() => [...document.querySelectorAll(".world-viewbar .sortbar-btn")].find((x) => x.textContent.trim() === "Clean #0")?.click());
await p.waitForTimeout(900);

// THE VIEW IS THE REVIEW (maintainer 2026-08-21: "The current button and
// everything that expands when clicking on the 'review the top' should be
// removed (it's so confusing with two rating systems on the same card!) ... IF
// the top is viewed the current rating system ... should target the
// top/details instead ... instead of stars lets use something like a roof
// emoji ... it should be the center of 3x3 tiles (base tiles)").
await p.goto(`${W}#/world/grass/grass`, { waitUntil: "load" });
await p.waitForTimeout(1900);
const tGone = await p.evaluate(() => ({
  leftovers: document.querySelectorAll(".top-btn, .top-review").length,
  stars: !!document.querySelector(".world-cand .review-box .stars:not(.roofs)"),
  roofs: document.querySelectorAll(".world-cand .review-box .roofs").length,
  view: document.querySelector(".tile-preview")?.dataset.view,
  chips: document.querySelectorAll(".world-viewbar .sortbar-btn").length,
}));
/* Show now has as many states as he has sets, plus Clean #0 and Raw — his
 * list, "Clean #0/Set #1/Set #2/Set #3/Raw". Asserted by shape, not by a
 * count he controls. */
ok(tGone.leftovers === 0 && tGone.stars && tGone.roofs === 0 && tGone.view === "clean" && tGone.chips >= 2,
  `the "review the top" expander is GONE; on Clean #0 one row rates the TILE with stars, and Show carries every set (${tGone.chips})`);
/* ---- MARK TOP ONLY → THE BEST WALL, STEPPABLE AT THE MARK (maintainer
 * 2026-08-28: "I have now clicked on 'top only' on a lot of tiles and I
 * always get the same wall" — the cliff preview composed with the page-level
 * first pick; now it borrows the wall MEASURED closest to this tile, and the
 * ‹ › stepper sits in the Wall row itself). ---- */
{
  const card0 = () => p.evaluate(() => {
    const c2 = document.querySelector(".world-cand");
    return {
      wallpick: c2?.querySelector(".tile-preview")?.dataset.wallpick ?? "",
      course: c2?.querySelector(".tile-preview")?.dataset.course ?? "",
      face: c2?.querySelector(".tile-preview")?.dataset.face ?? "",
      stepper: !!c2?.querySelector(".wall-mode .wall-step"),
      label: c2?.querySelector(".wall-mode .wall-step")?.textContent.replace(/\s+/g, " ").trim() ?? "",
    };
  });
  const off = await card0();
  ok(!off.stepper && off.wallpick === "", "under own-wall the Wall row offers no stepper — there is nothing to choose");
  ok(await p.evaluate(() => ![...document.querySelectorAll(".wall-mode")].some((r) => /\bnull\b/.test(r.textContent))),
    'and no wall row ever prints a literal "null" — the replaceChildren trap');
  await p.evaluate(() => { const r = document.querySelector(".world-cand .wall-mode"); r.scrollIntoView({ block: "center" }); [...r.querySelectorAll("button")].find((b2) => b2.textContent.trim() === "top only")?.click(); });
  await p.waitForTimeout(1800);
  const on = await card0();
  ok(on.stepper && /auto · best match/.test(on.label) && on.wallpick !== "",
    `marking TOP ONLY grows the ‹ › stepper on auto, and the cliff borrows a measured wall (${on.wallpick.split("/").pop()})`);
  // the course is view-dependent (Clean shows the plate pass of the picked
  // wall), so the claim is the PICK itself: a real pool candidate, published
  ok(on.course !== "" && (D.domains.world ?? []).find((c2) => c2.top === "grass" && c2.side === "grass")
    ?.candidates.some((x) => x.key === on.wallpick),
    `the pick is a real candidate of the pool and the courses compose from it (${String(on.wallpick).split("/").pop()})`);
  await p.evaluate(() => { const r = document.querySelector(".world-cand .wall-step"); [...r.querySelectorAll("button")].find((b2) => b2.textContent === "›")?.click(); });
  await p.waitForTimeout(1800);
  const nxt = await card0();
  ok(nxt.wallpick !== on.wallpick && /your pick/.test(nxt.label),
    `stepping › swaps the borrowed wall and stores the choice (${nxt.wallpick.split("/").pop()})`);
  await p.evaluate(() => { const r = document.querySelector(".world-cand .wall-step"); [...r.querySelectorAll("button")].find((b2) => b2.textContent === "‹")?.click(); });
  await p.waitForTimeout(1800);
  const back = await card0();
  ok(back.wallpick === on.wallpick && /auto · best match/.test(back.label)
    && await p.evaluate(() => Object.keys(window.__wiki.state.tuning.top_walls?.overrides ?? {}).length === 0),
    "stepping back onto the best CLEARS the override");
  await p.evaluate(() => { const r = document.querySelector(".world-cand .wall-mode"); [...r.querySelectorAll("button")].find((b2) => b2.textContent.trim() === "own wall")?.click(); });
  await p.waitForTimeout(1400);
  await p.evaluate(() => document.querySelector("#save-btn")?.click());
  await p.waitForTimeout(700);
  /* THE CENTRE MUST NEVER BE A HOLE UNDER A SET VIEW (maintainer 2026-08-28,
   * Black Rock over black rock + Set #3: "the preview stops rendering the
   * tile in review in the center. Instead I see a hole"): the face is a
   * sub: composite there, and the tex2 dresser used to fail it wholesale. */
  await p.evaluate(() => { const c2 = document.querySelector(".stage-flip"); c2.scrollIntoView({ block: "center" }); c2.click(); });
  await p.waitForTimeout(2600);
  const setHole = await p.evaluate(() => {
    const st = document.querySelector(".world-cand .tile-preview");
    const cv = st?.querySelector(".scene-box canvas");
    let opaque = -1;
    if (cv && cv.width) {
      try {
        const d2 = cv.getContext("2d").getImageData(cv.width / 2 - 12, cv.height / 2 - 8, 24, 16).data;
        opaque = 0;
        for (let i = 3; i < d2.length; i += 4) if (d2[i] > 60) opaque++;
      } catch { opaque = -2; }
    }
    return { view: st?.dataset.view, face: (st?.dataset.face ?? "").slice(0, 4), opaque };
  });
  ok(/^set:/.test(setHole.view ?? "") && setHole.face === "sub:" && setHole.opaque > 200,
    `under a Set view the sub: composite centre RENDERS — no hole (${setHole.opaque} opaque px, view ${setHole.view})`);
  // the chip only advances — cycle the whole way home so later sections
  // start from Clean, the state they were written against
  for (let i2 = 0; i2 < 6; i2++) {
    const v2 = await p.evaluate(() => document.querySelector(".world-cand .tile-preview")?.dataset.view);
    if (v2 === "clean") break;
    await p.evaluate(() => document.querySelector(".stage-flip")?.click());
    await p.waitForTimeout(900);
  }
}
await p.evaluate(() => { const c2 = document.querySelector(".stage-flip"); c2.scrollIntoView({ block: "center" }); c2.click(); });
await p.waitForTimeout(2400);
const tTex = await p.evaluate(() => ({
  view: document.querySelector(".tile-preview")?.dataset.view,
  chip: document.querySelector(".stage-flip")?.textContent.trim(),
  roofs: document.querySelectorAll(".world-cand .review-box .roofs button").length,
  glyph: document.querySelector(".world-cand .review-box .roofs button")?.textContent,
  reject: [...document.querySelectorAll(".world-cand .review-box button")].some((x) => /not a detail/.test(x.textContent)),
  // SCOPED TO THE FLIPPED CARD. The chip is per tile, so the other 19 keep
  // their stars and their cliffs — that they do is the check, not a nuisance.
  starsHere: document.querySelector(".world-cand")?.querySelectorAll(".review-box .stars:not(.roofs)").length,
  scenesHere: document.querySelector(".world-cand")?.querySelectorAll(".scene-box canvas").length,
  neighbourStars: [...document.querySelectorAll(".world-cand")].slice(1).filter((c) => c.querySelector(".review-box .stars:not(.roofs)")).length,
  cards: document.querySelectorAll(".world-cand").length,
  subs: window.__wikiSub ?? 0,
}));
/* THE CHIP CYCLES THE GROUND'S OWN PASSES, one tile at a time — Clean #0, then
 * every set, then Raw. Pressing it once from Clean lands on the first set, and
 * the composite it needs (this wall wearing that set's top) is built in the
 * browser: __wikiSub counts those. */
ok(/^set:/.test(tTex.view ?? "") && /^⇄ .+ #\d+$/.test(tTex.chip ?? "") && tTex.subs > 0,
  `the per-tile chip cycles Clean #0 → the first set, composed in the browser (${tTex.chip}, view ${tTex.view}, ${tTex.subs} composites)`);
ok(tTex.roofs === 5 && tTex.glyph === "⌂" && tTex.reject && tTex.starsHere === 0,
  `and that card's ONE row now rates the TOP — five roofs, "not a detail", no stars left on it (${tTex.roofs} × ${tTex.glyph})`);
ok(tTex.scenesHere === 1,
  `its composition is the ONE 3x3 with the top centred in the base tiles — no cliff, the wall is irrelevant here (${tTex.scenesHere} scene)`);
ok(tTex.neighbourStars === tTex.cards - 1,
  `and the flip is PER TILE — the other ${tTex.cards - 1} cards still rate the tile with stars (${tTex.neighbourStars})`);
await p.evaluate(() => [...document.querySelectorAll(".world-cand .review-box .roofs button")][2].click());
await p.waitForTimeout(300);
const topTouch = await p.evaluate(() => [...(window.__wiki.state.touched["feedback/tiles"] ?? [])]);
ok(topTouch.length === 1 && topTouch[0].endsWith("#top"),
  `a roof press writes the #top entry, never the tile's own (${topTouch.join(", ") || "nothing"})`);
await p.evaluate(() => [...document.querySelectorAll(".world-cand .review-box .roofs button")][2].click());
/* KEEP PRESSING UNTIL RAW. The cycle is as long as he has sets — Clean #0,
 * every set, then Raw — so a fixed number of presses would assert on however
 * many sets this gate happened to build. Raw is where the stars come back,
 * because a raw generation is a tile again and not a ground. */
for (let i = 0; i < 8; i++) {
  const v = await p.evaluate(() => document.querySelector(".tile-preview")?.dataset.view);
  if (v === "before") break;
  await p.evaluate(() => document.querySelector(".stage-flip").click());
  await p.waitForTimeout(500);
}
const tBack = await p.evaluate(() => ({
  view: document.querySelector(".tile-preview")?.dataset.view,
  stars: !!document.querySelector(".world-cand .review-box .stars:not(.roofs)"),
  chip: document.querySelector(".stage-flip")?.textContent.trim(),
}));
ok(tBack.view === "before" && tBack.stars,
  `cycling round to Raw brings the stars back — a raw tile is a tile, not a ground (${tBack.view}, ${tBack.chip})`);

// ---- THE LEDGER: what is actually left, before any art --------------------
// Maintainer 2026-08-22: "The wiki is full with already reviewed stuff. I will
// not review until everything is up to date."
await p.goto(`${W}#/world`, { waitUntil: "load" });
await p.waitForTimeout(2600);
const L = await p.evaluate(() => ({
  present: !!document.querySelector(".ledger"),
  pill: document.querySelector(".ledger .panel-title .pill")?.textContent ?? "",
  lines: [...document.querySelectorAll(".ledger-line")].map((x) => x.textContent.replace(/\s+/g, " ").trim()),
  jumps: [...document.querySelectorAll(".ledger-jump button")].map((x) => x.textContent.trim()),
}));
ok(L.present && L.lines.length >= 3 && ["Tiles", "Your rejections", "Tops"].every((n2) => L.lines.some((x) => x.startsWith(n2))),
  `the World section opens with the ledger — tiles, rejections, tops (${L.lines.length} lines)`);
const tileLine = L.lines.find((x) => x.startsWith("Tiles")) ?? "";
const mNums = tileLine.match(/([\d,]+) of ([\d,]+) rated \((\d+)%\)/);
const num = (x) => Number(String(x).replace(/,/g, ""));
ok(!!mNums && num(mNums[1]) <= num(mNums[2]), `it counts rated against total off the LIVE manifest (${tileLine.slice(0, 46)}…)`);
// The floor, not the round: 3,983 of 3,990 must never print 100%.
ok(!!mNums && (num(mNums[1]) === num(mNums[2]) ? mNums[3] === "100" : Number(mNums[3]) < 100),
  `and the percentage is FLOORED, so an unfinished set never reads 100% (${mNums?.[3]}%)`);
const rejLine = L.lines.find((x) => x.startsWith("Your rejections")) ?? "";
ok(/carried out|none outstanding/.test(rejLine),
  `his rejections get a receipt — carried out vs still standing (${rejLine.slice(0, 54)}…)`);
ok(L.lines.some((x) => x.startsWith("Tops")), "and the top review is counted as its own axis");
ok(L.jumps.some((x) => /^Start on/.test(x)),
  `with a press that lands ON the work — the biggest queue, opened in Textured (${L.jumps.filter((x) => /^Start on/.test(x)).join(" | ").slice(0, 60)})`);

// ---- 3. TRANSITIONS: the tab and the demo page -----------------------------
await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
await p.waitForTimeout(1600);
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /Transitions/.test(x.textContent))?.click());
await p.waitForTimeout(900);
/* EVERY NEIGHBOUR now means every ground with plates, minus itself — the
 * generated pairs are a subset with extra art, not the roster. */
const expTrans = Object.keys(META.patternLib?.plates ?? {}).filter((x) => x !== "grass");
const tt = await p.evaluate(() => ({
  rows: document.querySelectorAll("a.trans-row").length,
  post: [...document.querySelectorAll(".trans-row .pill")].map((x) => x.textContent),
  href: document.querySelector("a.trans-row")?.getAttribute("href"),
  imgs: document.querySelectorAll(".trans-strip img").length,
}));
ok(tt.rows === expTrans.length, `the Transitions tab lists every neighbour (${tt.rows})`);
ok(tt.post.some((x) => /composed/.test(x)),
  `and the pill names what is drawn — composed under Clean/Set (${tt.post.find((x) => /composed/.test(x))})`);
ok(/#\/world\/transition\//.test(tt.href ?? ""), "each row links to the transition's own page");
/* TOP-ONLY TILES ARE NEVER AN X-OVER-Y CANDIDATE — the tiles agent's own rule
 * ("never resolve one against tiles/review/manifest.json — nothing here is a
 * cell") and the maintainer's ("You should not include the new tiles in x over
 * x/y review. This is top only tiles"). They live in their own worldMeta field
 * for exactly this reason, but the pair page is where a wall verdict is given,
 * so it is where the claim is worth checking. */
{
  const pv = await ctx.newPage();
  await pv.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
  await pv.addInitScript(() => {
    localStorage.setItem("wiki-admin-token", "gate");
    localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
  });
  await pv.goto(`${W}#/world/grass/ice`, { waitUntil: "load" });
  await pv.waitForTimeout(2400);
  const leak = await pv.evaluate(() => [...document.querySelectorAll("img, canvas")]
    .map((n) => n.getAttribute("src") ?? "").filter((s) => /\/tiles\/tops\//.test(s)));
  ok(leak.length === 0, `no top-only tile appears in an x-over-y review (${leak.length} found)`);
  await pv.close();
}
await p.evaluate(() => document.querySelector("a.trans-row")?.click());
await p.waitForTimeout(2600);
const demo = await p.evaluate(() => ({
  h1: document.querySelector("h1")?.textContent ?? "",
  scenes: [...document.querySelectorAll(".trans-scene .panel-title")].map((x) => x.textContent.trim()),
  canvases: [...document.querySelectorAll(".trans-scene canvas")].map((c) => c.width),
  chips: document.querySelectorAll(".sortbar-btn").length,
  strip: document.querySelectorAll(".trans-all canvas, .trans-all img").length,
  stripLoaded: [...document.querySelectorAll(".trans-all canvas")].filter((c) => c.width > 0).length
    + [...document.querySelectorAll(".trans-all img")].filter((i) => i.complete && i.naturalWidth > 0).length,
}));
ok(/↔/.test(demo.h1), `the demo page names the pair (${demo.h1})`);
ok(demo.scenes.length === 5 && demo.canvases.length === 5 && demo.canvases.every((w2) => w2 > 300),
  `five direction scenes, each a real composed field (${demo.scenes.join("; ")})`);
const pairId = (await p.evaluate(() => location.hash)).split("/transition/")[1];
const pairMeta = (META.transitions ?? []).find((x) => `${x.a}__to__${x.b}` === pairId);
// The picker is the LIBRARY's 18 patterns on every pair — generated or not.
ok(demo.chips >= (META.patternLib?.patterns.length ?? 18),
  `all ${META.patternLib?.patterns.length} library patterns are pickable (${demo.chips} chips${pairMeta ? ", pair also has " + pairMeta.sets.length + " generated sets" : ", never generated"})`);
ok(demo.strip === 16 && demo.stripLoaded === demo.strip,
  `and the 16 corner tiles are shown and load (${demo.stripLoaded}/${demo.strip})`);
// randomize re-rolls the wandering edge
const wanderBefore = await p.evaluate(() => [...document.querySelectorAll(".trans-scene canvas")].at(-1)?.toDataURL().length);
await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Randomize/.test(x.textContent))?.click());
await p.waitForTimeout(1600);
const wanderAfter = await p.evaluate(() => [...document.querySelectorAll(".trans-scene canvas")].at(-1)?.toDataURL().length);
ok(wanderBefore !== wanderAfter, `Randomize re-draws the wandering edge (${wanderBefore} → ${wanderAfter} bytes)`);

// ---- 4. the taxonomy reads differently per type ----------------------------
await p.goto(`${W}#/world/parquet_floor`, { waitUntil: "load" });
await p.waitForTimeout(1200);
const parquet = await p.evaluate(() => [...document.querySelectorAll(".ground-idcard .pill")].map((x) => x.textContent.trim()));
ok(parquet.includes("repeats the base tile"),
  `parquet floor says its transitions mimic the base tile (${parquet.join(" | ")})`);
await p.goto(`${W}#/world/black_rock`, { waitUntil: "load" });
await p.waitForTimeout(1200);
const rock = await p.evaluate(() => [...document.querySelectorAll(".ground-idcard .pill")].map((x) => x.textContent.trim()));
ok(rock.includes("clean colour for now"), `black rock admits the flat colour is a stopgap (${rock.join(" | ")})`);

// ---- 5. the public page: beauty, no machinery ------------------------------
const pub = await ctx.newPage();
pub.on("pageerror", (e) => errs.push(String(e)));
await pub.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":false}' }));
await pub.addInitScript(() => localStorage.removeItem("wiki-admin-token"));
await pub.goto(`${W}#/world/grass`, { waitUntil: "load" });
await pub.waitForTimeout(1800);
const seen = await pub.evaluate(() => {
  [...document.querySelectorAll(".groundtab")].find((x) => /Transitions/.test(x.textContent))?.click();
  return null;
});
void seen;
await pub.waitForTimeout(700);
const pubView = await pub.evaluate(() => ({
  palette: document.querySelectorAll(".ground-palette .ground-swatch").length,
  tabs: [...document.querySelectorAll(".groundtab")].map((x) => x.textContent.trim()),
  trans: document.querySelectorAll("a.trans-row").length,
  promote: document.querySelectorAll(".base-btn").length,
  weights: document.querySelectorAll(".weight-input").length,
}));
ok(pubView.palette > 0 && pubView.tabs.length === 4 && pubView.trans > 0,
  `a player gets the palette, the tabs and the transitions (${pubView.trans} pairs)`);
ok(pubView.promote === 0 && pubView.weights === 0, "and none of the promotion or weight machinery");
const pubDetails = await pub.evaluate(() => {
  const t2 = [...document.querySelectorAll(".groundtab")].find((x) => /Details/.test(x.textContent));
  return { disabled: t2?.disabled ?? null, topBtns: document.querySelectorAll(".top-btn").length };
});
/* EXPECT WHAT THE DATA SAYS, not "empty": the tab is FOR players once he has
 * approved details, and this asserted disabled===true right up until the
 * morning he approved some — a gate that reddens because the maintainer
 * worked is a broken gate. */
const grassTopIds = new Set([
  ...(META.tops?.grass ?? []).map((t2) => t2.id),
  ...(D.domains.world ?? []).filter((c2) => c2.top === "grass").flatMap((c2) => c2.candidates.map((x) => x.key)),
]);
let hasDetails = false;
try {
  const fbDoc = JSON.parse(readFileSync(join(ROOT, "live/feedback/tiles.json"), "utf8"));
  hasDetails = Object.entries(fbDoc.entries ?? {}).some(([k, v]) =>
    k.endsWith("#top") && v?.status === "approved" && grassTopIds.has(k.slice(0, -4)));
} catch {}
ok(pubDetails.disabled === !hasDetails && pubDetails.topBtns === 0,
  `the Details tab follows his approvals for a player — ${hasDetails ? "approved details exist, so it opens" : "nothing approved, so it is disabled"} — and no review machinery leaks`);
await pub.goto(`${W}#/world/transition/dark_mud__to__grass`, { waitUntil: "load" });
await pub.waitForTimeout(2200);
const pubDemo = await pub.evaluate(() => document.querySelectorAll(".trans-scene canvas").length);
ok(pubDemo === 5, `the demo page is for everyone — all five scenes render for a player (${pubDemo})`);

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
// ---- THE DETAIL PICTURE IS 5x5, WITH NINE OF THE TILE IN THE MIDDLE -------
// Maintainer 2026-08-23: "On the details page I want to review the tile as 5x5
// with the tile I'm reviewing as the center 3x3 surrounded by the base tile …
// The idea with a base tile is a tile that looks better than a single color
// tile, so if no base tile exist that mean the base tile is used 100% as the
// base tile."
//
// One tile in a 3x3 showed how it MEETS the ground; nine of it shows what it
// does when several land near each other. The ring is the ground itself: the
// promoted base group, or — with nothing promoted — the CLEAN-COLOUR tile,
// because that is what the game paints today.
await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
await p.waitForTimeout(1800);
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /Details/.test(x.textContent))?.click());
await p.waitForTimeout(3600);
const five = await p.evaluate(() => {
  const iso = window.__wiki.state.data.iso ?? { tilePx: 64, dx: 32 };
  const cv = document.querySelectorAll(".detail-card canvas")[0];
  if (!cv) return { err: "no detail canvas" };
  let colours = -1;
  try {
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    const s2 = new Set();
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) s2.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    colours = s2.size;
  } catch { colours = "tainted"; }
  // an N x N iso field spans (2N-2)*dx + tilePx, plus 4px of pad either side
  const span = (n) => (2 * n - 2) * iso.dx + iso.tilePx + 8;
  return { w: cv.width, want5: span(5), want3: span(3), colours,
    promoted: Object.keys(window.__wiki.state.tuning.base_tiles?.overrides ?? {}).length,
    says: [...document.querySelectorAll("p.muted")].map((x) => x.textContent).find((x) => /ONCE in the centre/.test(x)) ?? "" };
});
ok(five.w === five.want5,
  `the detail picture is a 5x5 field, not a 3x3 (${five.w}px, 5x5 spans ${five.want5}, 3x3 would be ${five.want3})`);
ok(typeof five.colours === "number" && five.colours > 8,
  `and it is readable and textured rather than a wall of one colour (${five.colours} colours)`);
ok(/Drawn (in Set #|on the clean colour|RAW)/.test(five.says),
  `the page says what the ring IS — the switch's own pick, in words ("${five.says.slice(-60)}")`);

// ---- IT HAS TO WORK ACROSS ORIGINS, WHICH IS THE ONLY WAY IT EVER RUNS -----
// Maintainer 2026-08-22: "Textured doesn't work and also displays the clean
// single color version right now."
//
// Tile review art is not in the deploy image (/assets/tiles/review/… is 404 in
// production), so it is fetched from the staging CDN — a DIFFERENT ORIGIN. An
// <img> loaded without crossOrigin taints the canvas, getImageData throws, and
// the synthesis silently falls back to the flattened tile.
//
// Every check above this line loads that art SAME-ORIGIN, because the local
// server roots /assets at the repo. So this one deliberately does what
// production does: fetch both passes from the second origin and read the
// pixels back. Without crossOrigin it throws SecurityError; with it, it counts.
const crossOrigin = await p.evaluate(async (base) => {
  const load = (src) => new Promise((res) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = im.onerror = () => res(im);
    im.src = src;
  });
  const a = await load(`${base}tiles/review/black_rock__over__black_rock/0_after.webp`);
  const r = await load(`${base}tiles/review/black_rock__over__black_rock/0_before.webp`);
  if (!a.naturalWidth || !r.naturalWidth) return { err: "images did not load cross-origin" };
  try {
    const c = window.__wiki.texSynth(a, r);
    if (!c) return { err: "texSynth returned null" };
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return { colours: set.size };
  } catch (e) { return { err: `${e.name}: ${String(e.message).slice(0, 60)}` }; }
}, process.env.REPO_URL ?? "http://127.0.0.1:8903/");
ok(!crossOrigin.err && crossOrigin.colours > 8,
  `the textured pass synthesizes from art on ANOTHER ORIGIN — the only way it runs in production (${crossOrigin.err ?? `${crossOrigin.colours} colours`})`);
// And the loader THE PAGE ITSELF uses must ask for CORS, or the check above is
// only true of the test.
const asksCors = await p.evaluate(() => new Promise((res) => {
  const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "crossOrigin");
  let asked = 0, made = 0;
  Object.defineProperty(HTMLImageElement.prototype, "crossOrigin", {
    configurable: true,
    get() { return d.get.call(this); },
    set(v) { made++; if (v === "anonymous") asked++; return d.set.call(this, v); },
  });
  const cands = (window.__wiki.state.data.domains.world ?? []).flatMap((c) => c.candidates).filter((c) => c.raw && c.art);
  const cand = cands[cands.length - 1];              // one the page has not drawn
  if (!cand) { res({ err: "no candidate with both passes" }); return; }
  window.__wiki.texFor(cand.art, cand.raw, () => res({ asked, made }));
  setTimeout(() => res({ asked, made, slow: true }), 8000);
}));
ok(asksCors.made > 0 && asksCors.asked === asksCors.made,
  `and the page's own image loader asks for CORS on every image it reads (${asksCors.asked}/${asksCors.made})`);

// ---- THE TEXTURE HAS TO SURVIVE, AND THAT IS A SPREAD, NOT A COLOUR COUNT --
// Maintainer 2026-08-22, looking at a top this gate had called textured: "How
// can you call this top 'textured'? Yes I can clearly see the original tile
// had a lot of texture, but if you remove it all it's not 'textured'."
//
// He was right and the metric was worthless: his tile scored 12 distinct
// colours BOTH before and after the fix. What had happened is that shifting a
// bright top onto a dark palette colour pushed 29% of its pixels through the
// 0 floor, and a clamped pixel is a flat pixel. So the check is now the
// STANDARD DEVIATION that survives, per channel, plus a hard zero on crushing.
const { decodeWebP } = await import("../lib/webp-pixels.mjs");
const withRaw = (D.domains.world ?? []).flatMap((c) => c.candidates ?? []).filter((c) => c.raw && c.art).slice(0, 6);
ok(withRaw.length >= 3, `there are tiles with both passes published to measure (${withRaw.length})`);
const sd = (v) => { const m = v.reduce((a, x) => a + x, 0) / v.length; return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length); };
let measured = 0, worstKeep = 1, crushed = 0, textured = 0, totalPx = 0;
for (const cand of withRaw) {
  const A = decodeWebP(readFileSync(join(ROOT, cand.art)));
  const R = decodeWebP(readFileSync(join(ROOT, cand.raw)));
  if (!A || !R || A.w !== R.w || A.h !== R.h) continue;
  const counts = new Map(); let opaque = 0;
  for (let i = 0; i < A.pix.length; i++) {
    if ((A.pix[i] >>> 24) < 200) continue; opaque++;
    const k = A.pix[i] & 0xffffff; counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const flat = [...counts.entries()].filter(([, n]) => n / opaque >= 0.15).sort((a, b) => b[1] - a[1])[0];
  if (!flat) continue;                       // never flattened (parquet, pavings)
  const [clean] = flat;
  const list = [];
  for (let i = 0; i < A.pix.length; i++) {
    if ((A.pix[i] >>> 24) < 200 || (A.pix[i] & 0xffffff) !== clean || (R.pix[i] >>> 24) < 200) continue;
    list.push(i);
  }
  if (list.length < 12) continue;
  measured++; totalPx += list.length * 3;
  let bestKeep = 0, bestOut = 0;
  for (let c = 0; c < 3; c++) {
    const sh = [16, 8, 0][c], tgt = (clean >> sh) & 255;
    const raw = list.map((i) => (R.pix[i] >> sh) & 255);
    const mean = raw.reduce((a, x) => a + x, 0) / raw.length;
    const devs = raw.map((x) => Math.abs(x - mean)).sort((a, b) => a - b);
    const p98 = devs[Math.min(devs.length - 1, Math.floor(devs.length * 0.98))] || 0;
    const head = Math.min(tgt, 255 - tgt);
    const k = (p98 > head && p98 > 0) ? head / p98 : 1;
    const out = raw.map((x) => tgt + (x - mean) * k);
    crushed += out.filter((v) => v < -0.5 || v > 255.5).length;
    const sIn = sd(raw), sOut = sd(out.map((v) => Math.max(0, Math.min(255, Math.round(v)))));
    if (sIn > 2 && sOut / sIn > bestKeep) bestKeep = sOut / sIn;
    if (sOut > bestOut) bestOut = sOut;
  }
  if (bestKeep) worstKeep = Math.min(worstKeep, bestKeep);
  if (bestOut >= 3) textured++;
}
ok(measured >= 3, `flattened tops to measure (${measured} tiles)`);
// The fit is to the 98th percentile of the swing, so the last 2% of outliers
// may still touch the ends — that is the point of fitting to p98 rather than
// to the single most extreme pixel, which one stray dot could flatten
// everything for. What must never come back is the 29% wipeout that made his
// tile flat.
const crushPct = totalPx ? (crushed / totalPx) * 100 : 0;
ok(crushPct <= 2, `almost nothing is crushed against black or white — the fit is to the palette colour's own headroom, not the clamp (${crushPct.toFixed(2)}% of channel samples, was 29% on his tile)`);
ok(worstKeep >= 0.9,
  `and the top's dominant swing survives the move onto the palette (worst tile keeps ${(worstKeep * 100).toFixed(0)}% of its spread)`);
// Not every top HAS relief to recover: a raw face the generator drew nearly
// uniform comes back nearly uniform, honestly. The claim is that the pass
// recovers relief where relief exists, not that it invents it.
ok(measured > 0 && textured / measured >= 0.8,
  `so a flattened top comes back with visible relief wherever the generator drew any (${textured}/${measured})`);

// ---- THE OVERHANG THAT SHIPPED IN THE WALL'S COLOUR ------------------------
// Maintainer 2026-08-22, painting on a screenshot: "I have painted RED on the
// overhang that should be deep_water, but currently is green/grass. I also
// marked in purple what should be grass so you don't take too much." Then,
// when the first measurement went out: "Same as before. red = SHOULD BE dark
// blue. purple = SHOULD BE green."
//
// The card had told him the opposite — "overhang 1.00" — because `overhang`
// counts how much SPILLED, and all of it did; it just ships in the wall's
// colour. And the first fix here measured the tile as a WHOLE, which averaged
// a healthy face with a destroyed one into a number that pointed nowhere.
const { measureOverhang } = await import("../lib/overhang.mjs");
const cellOf = (id) => (D.domains.world ?? []).find((c) => c.id === id);
const his = cellOf("deep_water__over__grass");
const healthy = cellOf("dark_mud__over__slime");
ok(!!his && !!healthy, "both the reported cell and the one already repaired are in the wiki");
const mHis = his && measureOverhang(ROOT, his.candidates[0].art, his.candidates[0].raw);
const mOk = healthy && measureOverhang(ROOT, healthy.candidates[0].art, healthy.candidates[0].raw);
// A REGRESSION GUARD NOW, NOT A COMPLAINT. He reported this cell on 2026-08-22
// measuring LEFT 100% drawn -> 11% kept; the tiles agent repaired it the same
// day ("deep water over grass keeps the droop on its shaded face", f36de4c4b)
// and it measures 100 -> 100. If it slips back, this goes red.
ok(mHis && mHis.left.drawn >= 0.95 && mHis.left.kept >= 0.9,
  `the cell he reported is REPAIRED and stays repaired — its left face keeps the droop (drawn ${(mHis.left.drawn * 100).toFixed(0)}%, kept ${(mHis.left.kept * 100).toFixed(0)}%, was 11%)`);
ok(mHis && mHis.right.kept >= 0.75,
  `and its right face, which was never broken, still is not (kept ${(mHis.right.kept * 100).toFixed(0)}%)`);
ok(mOk && mOk.left.kept >= mOk.left.drawn - 0.05 && mOk.right.kept >= mOk.right.drawn - 0.05,
  `dark mud over slime — repaired once already — keeps BOTH faces (left ${(mOk.left.kept * 100).toFixed(0)}%, right ${(mOk.right.kept * 100).toFixed(0)}%)`);
// ---- AND THE OPPOSITE BREAK: A WHOLE WALL FACE SWALLOWED -------------------
// Maintainer 2026-08-22, on deep water over slime: "RED = SHOULD BE SLIME.
// PURPLE = SHOULD BE DARK WATER." A thin brim of water over a body that should
// be slime — and the shipped tile paints the whole body water.
//
// The BRIM check calls those tiles perfect and is right to: the brim survived.
// A measurement that only looks at the brim reports green while the wall under
// it is gone, so this asks the other question.
const PALT = PAL.types ?? {};
const pHex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const pOf = (m) => [PALT[m]?.top, PALT[m]?.wall].filter(Boolean).map(pHex);
const slimeCell = cellOf("deep_water__over__slime");
ok(!!slimeCell, "the cell he marked is in the wiki");
const swMeasured = (slimeCell?.candidates ?? []).map((c) =>
  measureOverhang(ROOT, c.art, c.raw, { top: pOf("deep_water"), side: pOf("slime") })).filter(Boolean);
// A REGRESSION GUARD NOW. He reported this cell on 2026-08-22 with all five
// tiles shipping a LEFT wall of water over a wall the generator drew as slime
// (4→95, 0→95, 15→100, 5→99, 17→98). The tiles agent repaired it the same day
// — "deep water over slime gives the lower left wall back to slime",
// 4fb024a1a — and it now ships at 16-17%. If it slips back, this goes red.
ok(swMeasured.length >= 4 && swMeasured.every((m) => m.body && m.body.left.after <= 0.4),
  `the cell he marked is REPAIRED and stays repaired — its left wall is slime again (${swMeasured.map((m) => `${Math.round(m.body.left.raw * 100)}→${Math.round(m.body.left.after * 100)}`).join(", ")})`);
ok(swMeasured.every((m) => m.body.right.after <= 0.4),
  `and its right wall, which was never wrong, still is not (${swMeasured.map((m) => Math.round(m.body.right.after * 100)).join(", ")})`);
// AND THE CONTROL, which caught a bug in this very measurement. Judged by RGB
// distance, dark mud over slime read 97% mud on its left face and I reported it
// to the tiles agent as broken. It is not: that wall is green in both passes,
// by eye and by hue. A wall face is lit DARKER than the top, and in raw RGB a
// dark slime sits nearer dark mud than it does to slime's own bright green —
// the exact trap fix_left_wall.py's docstring describes. Hue does not have it.
const mud = cellOf("dark_mud__over__slime");
const mudM = mud && measureOverhang(ROOT, mud.candidates[0].art, mud.candidates[0].raw, { top: pOf("dark_mud"), side: pOf("slime") });
ok(mudM?.body && mudM.body.left.after <= 0.3,
  `dark mud over slime keeps its slime wall, and the measurement no longer says otherwise (${Math.round(mudM.body.left.after * 100)}%, was a false 97% under RGB distance)`);
const swallow = (D.worldMeta ?? {}).swallow ?? {};
const swBad = Object.values(swallow).filter(([raw, after]) => after >= 70 && after - raw >= 40);
ok(Object.keys(swallow).length > 500 && swBad.length > 0 && swBad.length < Object.keys(swallow).length * 0.1,
  `published per tile and rare enough to mean something — ${swBad.length} of ${Object.keys(swallow).length} faces swallowed (${(swBad.length / Object.keys(swallow).length * 100).toFixed(1)}%)`);

// Published for the browser, keyed by the agent's own tile key.
const fringe = (D.worldMeta ?? {}).fringe ?? {};
ok(Object.keys(fringe).length > 500, `the measurement is published per tile for the live refresh to merge (${Object.keys(fringe).length} tiles)`);
ok(Array.isArray(fringe[his.candidates[0].key]) && fringe[his.candidates[0].key].length === 3,
  `including his, as [drawn, kept, face] (${fringe[his.candidates[0].key]})`);
// SAME-OVER-SAME IS NEVER ASKED. Its top and wall are one material, so the brim
// differs only by lighting and the question means nothing — measuring it flagged
// grass over grass and ice over ice until the cell's materials settled it.
const key2cell = new Map();
for (const c of D.domains.world) for (const x of c.candidates) key2cell.set(x.key, c.id);
const sameFlagged = Object.keys(fringe).filter((k) => {
  const id = key2cell.get(k) ?? "";
  return id.split("__over__")[0] === id.split("__over__")[1];
});
ok(sameFlagged.length === 0, `and no same-over-same tile is measured at all (${sameFlagged.length})`);
// Only a real LOSS is flagged, and the left face dominating is the finding.
const bad = Object.values(fringe).filter(([dr, kp]) => dr >= 60 && dr - kp >= 25);
const left = bad.filter((v) => v[2] === "left").length;
ok(bad.length > 0 && bad.length < Object.keys(fringe).length * 0.12,
  `the warning is rare enough to mean something — ${bad.length} of ${Object.keys(fringe).length} tiles (${(bad.length / Object.keys(fringe).length * 100).toFixed(1)}%)`);
ok(left > bad.length / 2,
  `and the LEFT face is where it concentrates, which is the lead for the tiles agent (${left} left / ${bad.length - left} right)`);

await b.close();
console.log(fails.length ? `\nGROUND-TYPE CHECKS FAILED (${fails.length})` : "\nALL GROUND-TYPE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
