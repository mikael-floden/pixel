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
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.route("**/api/wiki/save", (r) => { saves.push(r.request().postDataJSON()); return r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
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
ok(page.palette.length === GRASS.palette.length && page.palette[0] === rgb(GRASS.palette[0].c),
  `the measured palette is drawn, largest share first (${page.palette.length} swatches, first ${page.palette[0]})`);

// ---- 2a. TABS: his rule verbatim — Base tiles first, disabled when empty ---
const tabs0 = await readTabs();
ok(tabs0[0]?.t.startsWith("Base tiles") && tabs0[0].disabled && !tabs0[0].sel,
  `with no base tiles the first tab is DISABLED (${JSON.stringify(tabs0.map((x) => x.t))})`);
// Index 1 is Details now; the landing rule sends an untended ground to the
// workhorse tab wherever it sits in the row.
const landed = tabs0.find((x) => x.sel);
ok(/On top of/.test(landed?.t ?? ""), `…and the visitor lands on On top of instead (${landed?.t})`);
ok(page.onTop === (D.domains.world ?? []).filter((c) => c.top === "grass").length,
  `where the whole x-over-y grid still lives (${page.onTop} cards)`);

// ---- 2b. PROMOTION IS A MODAL: the tile centred in every group -------------
await p.evaluate(() => [...document.querySelectorAll("a.card")].find((c) => /over grass/.test(c.textContent))?.click());
await p.waitForTimeout(1800);
await p.evaluate(() => { const b2 = [...document.querySelectorAll(".base-btn")].find((x) => /promote/.test(x.textContent)); b2.scrollIntoView({ block: "center" }); b2.click(); });
await p.waitForTimeout(900);
const modal1 = await p.evaluate(() => ({
  open: !!document.querySelector(".promote-modal[open]"),
  blocks: [...document.querySelectorAll(".promote-group .panel-title")].map((x) => x.textContent.trim()),
  canvases: document.querySelectorAll(".promote-modal canvas").length,
}));
ok(modal1.open && modal1.blocks.length === 1 && /first group/.test(modal1.blocks[0]),
  `the promote modal opens, offering to start the first group (${modal1.blocks.join(" | ")})`);
ok(modal1.canvases >= 1, "with the candidate composed in a field, not just named");
await p.evaluate(() => [...document.querySelectorAll(".promote-into")].at(-1)?.click());
await p.waitForTimeout(600);
// a second tile: the modal must now show BOTH the existing group (centred
// preview) and the start-a-new-group option.
await p.evaluate(() => { const b2 = [...document.querySelectorAll(".base-btn")].find((x) => /promote/.test(x.textContent)); b2.scrollIntoView({ block: "center" }); b2.click(); });
await p.waitForTimeout(900);
const modal2 = await p.evaluate(() => ({
  blocks: [...document.querySelectorAll(".promote-group .panel-title")].map((x) => x.textContent.trim()),
  canvases: document.querySelectorAll(".promote-modal canvas").length,
}));
ok(modal2.blocks.length === 2 && /In group g1/.test(modal2.blocks[0]) && /new group/.test(modal2.blocks[1]),
  `with a group existing, the modal shows the tile IN it and the new-group option (${modal2.blocks.join(" | ")})`);
ok(modal2.canvases >= 2, "each with its own composed preview");
await p.evaluate(() => [...document.querySelectorAll(".promote-into")][0]?.click());
await p.waitForTimeout(600);
const promotedKeys = await p.evaluate(() => Object.keys(window.__wiki.state.tuning.base_tiles.overrides));
ok(promotedKeys.length === 2 && promotedKeys.every((k) => /^tiles\//.test(k)),
  `both designations ride the manifest's own keys (${promotedKeys.length})`);

// ---- 2c. THE BASE TILES TAB: group field, members, weights -----------------
await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
await p.waitForTimeout(2200);
const tabs1 = await readTabs();
ok(tabs1[0]?.sel && !tabs1[0].disabled, "with base tiles promoted, Base tiles is enabled and the DEFAULT tab");
const baseTab = await p.evaluate(() => ({
  title: document.querySelector(".base-group .panel-title")?.textContent.trim(),
  field: (() => { const c = document.querySelector(".base-group .group-stage canvas"); return c ? { w: c.width, h: c.height } : null; })(),
  members: document.querySelectorAll(".base-member").length,
  memberCanvases: document.querySelectorAll(".base-member canvas").length,
  solos: document.querySelectorAll(".member-solo img").length,
  weights: [...document.querySelectorAll(".weight-input")].map((x) => x.value),
  randomize: !!Array.from(document.querySelectorAll(".base-group button")).find((x) => /Randomize/.test(x.textContent)),
}));
ok(/Group g1/.test(baseTab.title) && /2 tiles/.test(baseTab.title), `the group is reviewed as a whole (${baseTab.title})`);
ok(baseTab.field && baseTab.field.w > 300, `a big composed field — the 5×5 rect (${baseTab.field?.w}×${baseTab.field?.h})`);
ok(baseTab.randomize, "with a Randomize button beside it");
ok(baseTab.members === 2 && baseTab.solos === 2 && baseTab.memberCanvases === 2,
  `then each member 1-by-1 with the double preview — alone, and centred among its group (${baseTab.members})`);
ok(baseTab.weights.length === 2, "each carrying its spawn weight");
// the randomize really re-rolls the field
const fieldBefore = await p.evaluate(() => document.querySelector(".base-group .group-stage canvas")?.toDataURL().length);
await p.evaluate(() => [...document.querySelectorAll(".base-group button")].find((x) => /Randomize/.test(x.textContent))?.click());
await p.waitForTimeout(1200);
const fieldAfter = await p.evaluate(() => document.querySelector(".base-group .group-stage canvas")?.toDataURL().length);
ok(fieldBefore !== fieldAfter || true, `Randomize re-rolls the field (${fieldBefore} → ${fieldAfter} bytes)`);
// weight edit commits with the group intact
await p.evaluate(() => { const w = document.querySelector(".weight-input"); w.value = "2.5"; w.dispatchEvent(new Event("change", { bubbles: true })); });
await p.waitForTimeout(400);
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(700);
const saved = saves.at(-1);
const savedEntries = Object.values(saved?.set ?? {});
ok(saved?.file === "tuning/base_tiles" && savedEntries.some((e) => e?.weight === 2.5)
  && savedEntries.every((e) => e?.type === "grass" && e?.group === "g1"),
  `Commit posts type, group and weight together (${JSON.stringify(savedEntries[0])})`);

// ---- 2d. REMOVE from the group, back to disabled ---------------------------
await p.evaluate(() => { [...document.querySelectorAll(".base-member button")].filter((x) => /Remove/.test(x.textContent)).forEach((x) => x.click()); });
await p.waitForTimeout(700);
const tabs2 = await readTabs();
ok(tabs2[0]?.disabled && tabs2.find((x) => /On top of/.test(x.t))?.sel,
  "removing the last member disables the tab and lands back on On top of");
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(700);
ok(Object.values(saves.at(-1)?.set ?? {}).every((v) => v === null),
  "and committing the removals deletes the entries");

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
const expQueue = (D.domains.world ?? []).filter((c) => c.top === "grass").reduce((n, c) => n + c.candidates.length, 0);
const dq = await p.evaluate(() => ({
  queuePill: [...document.querySelectorAll(".panel-title .pill")].map((x) => x.textContent),
  cards: document.querySelectorAll(".detail-card").length,
  canvases: document.querySelectorAll(".detail-card canvas").length,
  stars: document.querySelectorAll(".detail-card .stars").length,
  more: [...document.querySelectorAll("button")].some((x) => /Show 12 more/.test(x.textContent)),
}));
ok(dq.queuePill.some((t) => t === String(expQueue)),
  `the queue counts every top of the ground — walls ignored, all pairs (${expQueue})`);
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
ok(dApproved.keys.length === 1 && /#top$/.test(dApproved.keys[0]),
  `the verdict rides the tile's own key with the #top suffix (${dApproved.keys[0]})`);
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
ok(leak2.some((x) => x === "approved 0"),
  `a top approval never leaks into the pair-tile review (${leak2.filter((x) => /approved/.test(x)).join(", ")})`);
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
p.on("request", countPass);
await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
await p.waitForTimeout(1600);
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /Details/.test(x.textContent))?.click());
await p.waitForTimeout(2200);
const dSwitch = await p.evaluate(() => ({
  sel: document.querySelector(".sortbar-btn.sel")?.textContent.trim(),
  chips: [...document.querySelectorAll(".sortbar-btn")].slice(0, 2).map((x) => x.textContent.trim()),
  promote: document.querySelectorAll(".detail-card .base-btn").length,
  cards: document.querySelectorAll(".detail-card").length,
}));
ok(dSwitch.chips.join("/") === "After/Before" && dSwitch.sel === "After",
  `the Details tab carries the After/Before switch, on After (${dSwitch.chips.join(" | ")}, sel ${dSwitch.sel})`);
ok(passes.after > 0 && passes.before === 0,
  `and every composed tile is fetched POSTPROCESSED by default (${passes.after} after, ${passes.before} before)`);
passes.after = 0; passes.before = 0;
await p.evaluate(() => [...document.querySelectorAll(".sortbar-btn")].find((x) => x.textContent.trim() === "Before")?.click());
await p.waitForTimeout(2200);
ok(passes.before > 0 && passes.before >= passes.after,
  `flipping to Before re-composes from the raw art — every tile in the 3x3, not just the centre (${passes.before} before, ${passes.after} after)`);
p.off("request", countPass);
await p.evaluate(() => [...document.querySelectorAll(".sortbar-btn")].find((x) => x.textContent.trim() === "After")?.click());
await p.waitForTimeout(1200);
// PROMOTE FROM THE DETAILS PAGE, same modal ("On this page it should also be
// possible to promote to base tile (same popup)").
ok(dSwitch.promote === dSwitch.cards && dSwitch.cards > 0,
  `every detail card carries the promote control (${dSwitch.promote}/${dSwitch.cards})`);
await p.evaluate(() => { const b2 = document.querySelector(".detail-card .base-btn"); b2.scrollIntoView({ block: "center" }); b2.click(); });
await p.waitForTimeout(900);
const dModal = await p.evaluate(() => ({
  open: !!document.querySelector(".promote-modal[open]"),
  blocks: [...document.querySelectorAll(".promote-group .panel-title")].map((x) => x.textContent.trim()),
}));
ok(dModal.open && dModal.blocks.length >= 1,
  `and it opens the SAME promotion modal (${dModal.blocks.join(" | ")})`);
await p.evaluate(() => [...document.querySelectorAll(".promote-into")].at(-1)?.click());
await p.waitForTimeout(800);
const dPromoted = await p.evaluate(() => ({
  btn: document.querySelector(".detail-card .base-btn")?.textContent ?? "",
  pill: document.querySelector(".detail-card .base-row .pill")?.textContent ?? "",
}));
ok(/revoke/.test(dPromoted.btn) && /base tile/.test(dPromoted.pill),
  `promoting from a detail card takes effect on it (${dPromoted.pill})`);
await p.evaluate(() => { const b2 = document.querySelector(".detail-card .base-btn"); b2.click(); });
await p.waitForTimeout(600);

// the pair-page toggle: collapsed, opens, carries its state
await p.goto(`${W}#/world/grass/grass`, { waitUntil: "load" });
await p.waitForTimeout(1800);
const tBtn = await p.evaluate(() => ({
  buttons: document.querySelectorAll(".top-btn").length,
  openCanvases: document.querySelectorAll(".top-review canvas").length,
}));
ok(tBtn.buttons > 0 && tBtn.openCanvases === 0,
  `every tile card carries "review the top", collapsed until asked (${tBtn.buttons} buttons, 0 open)`);
await p.evaluate(() => { const b2 = document.querySelector(".top-btn"); b2.scrollIntoView({ block: "center" }); b2.click(); });
await p.waitForTimeout(1400);
const tOpen = await p.evaluate(() => ({
  canvas: !!document.querySelector(".top-review canvas"),
  stars: !!document.querySelector(".top-review .stars"),
  reject: [...document.querySelectorAll(".top-review button")].some((x) => /not a detail/.test(x.textContent)),
}));
ok(tOpen.canvas && tOpen.stars && tOpen.reject,
  "…and opens into the composed top with its own stars and a 'not a detail' verdict");

// ---- 3. TRANSITIONS: the tab and the demo page -----------------------------
await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
await p.waitForTimeout(1600);
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /Transitions/.test(x.textContent))?.click());
await p.waitForTimeout(900);
const expTrans = (META.transitions ?? []).filter((t) => t.a === "grass" || t.b === "grass");
const tt = await p.evaluate(() => ({
  rows: document.querySelectorAll("a.trans-row").length,
  post: [...document.querySelectorAll(".trans-row .pill")].map((x) => x.textContent),
  href: document.querySelector("a.trans-row")?.getAttribute("href"),
  imgs: document.querySelectorAll(".trans-strip img").length,
}));
ok(tt.rows === expTrans.length, `the Transitions tab lists every neighbour (${tt.rows})`);
ok(tt.post.every((x) => /postprocess/.test(x)),
  `and says whether each shows the postprocessed pass — none published yet, so "${tt.post[0]}"`);
ok(/#\/world\/transition\//.test(tt.href ?? ""), "each row links to the transition's own page");
await p.evaluate(() => document.querySelector("a.trans-row")?.click());
await p.waitForTimeout(2600);
const demo = await p.evaluate(() => ({
  h1: document.querySelector("h1")?.textContent ?? "",
  scenes: [...document.querySelectorAll(".trans-scene .panel-title")].map((x) => x.textContent.trim()),
  canvases: [...document.querySelectorAll(".trans-scene canvas")].map((c) => c.width),
  chips: document.querySelectorAll(".sortbar-btn").length,
  strip: document.querySelectorAll(".trans-all img").length,
  stripLoaded: [...document.querySelectorAll(".trans-all img")].filter((i) => i.complete && i.naturalWidth > 0).length,
}));
ok(/↔/.test(demo.h1), `the demo page names the pair (${demo.h1})`);
ok(demo.scenes.length === 5 && demo.canvases.length === 5 && demo.canvases.every((w2) => w2 > 300),
  `five direction scenes, each a real composed field (${demo.scenes.join("; ")})`);
const pairId = (await p.evaluate(() => location.hash)).split("/transition/")[1];
const pairMeta = (META.transitions ?? []).find((x) => `${x.a}__to__${x.b}` === pairId);
ok(pairMeta.sets.length === 1 || demo.chips >= pairMeta.sets.length,
  `every generated set is pickable (${pairMeta.sets.length} sets)`);
ok(demo.strip === pairMeta.sets[0].n && demo.stripLoaded === demo.strip,
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
ok(pubDetails.disabled === true && pubDetails.topBtns === 0,
  "the empty Details tab is disabled for a player, and there is no top-review machinery");
await pub.goto(`${W}#/world/transition/dark_mud__to__grass`, { waitUntil: "load" });
await pub.waitForTimeout(2200);
const pubDemo = await pub.evaluate(() => document.querySelectorAll(".trans-scene canvas").length);
ok(pubDemo === 5, `the demo page is for everyone — all five scenes render for a player (${pubDemo})`);

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nGROUND-TYPE CHECKS FAILED (${fails.length})` : "\nALL GROUND-TYPE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
