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
ok((META.transitions ?? []).every((t) => t.sets > 0 && t.sample?.tiles?.length >= 8),
  "each with a set count and a representative sample set");

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
const page = await p.evaluate(() => ({
  pills: [...document.querySelectorAll(".ground-idcard .pill")].map((x) => x.textContent.trim()),
  palette: [...document.querySelectorAll(".ground-palette .ground-swatch")].map((x) => getComputedStyle(x).backgroundColor),
  basePanel: document.querySelector(".ground-bases")?.innerText ?? "",
  transTitle: document.querySelector(".ground-trans .panel-title")?.innerText ?? "",
  transRows: document.querySelectorAll(".trans-row").length,
  firstTransImg: (() => { const i = document.querySelector(".trans-strip img"); return i ? { loaded: i.complete && i.naturalWidth > 0, src: i.currentSrc } : null; })(),
  onTop: document.querySelectorAll("a.card").length,
}));
ok(page.pills.some((t) => t === `base ${GRASS.top}`), `the base colour pill shows the game's own colour (${page.pills.join(" | ")})`);
ok(page.pills.includes("always its own texture") && page.pills.includes("solid"),
  "with the surface taxonomy and category in words");
ok(page.palette.length === GRASS.palette.length && page.palette[0] === rgb(GRASS.palette[0].c),
  `the measured palette is drawn, largest share first (${page.palette.length} swatches, first ${page.palette[0]})`);
ok(/No base tile promoted yet/.test(page.basePanel) && page.basePanel.includes(GRASS.top),
  "with no base tile, the panel says the ground paints as its flat colour — and names it");
const expTrans = (META.transitions ?? []).filter((t) => t.a === "grass" || t.b === "grass");
ok(page.transRows === expTrans.length && new RegExp(`across ${expTrans.length} neighbour`).test(page.transTitle),
  `the Transitions panel lists every neighbour pair on disk (${page.transRows})`);
ok(page.firstTransImg?.loaded, "and the sample tiles actually draw");
ok(page.onTop === (D.domains.world ?? []).filter((c) => c.top === "grass").length,
  `the On top of grid still lists every wall (${page.onTop})`);

// ---- 2. promote → the title, the panel, the colour, the save ----------------
await p.evaluate(() => [...document.querySelectorAll("a.card")].find((c) => /over grass/.test(c.textContent))?.click());
await p.waitForTimeout(1800);
const before = await p.evaluate(() => document.querySelectorAll(".base-btn").length);
ok(before > 0, `every tile card carries the promote control (${before})`);
const promotedKey = await p.evaluate(() => {
  const btn = document.querySelector(".base-btn");
  btn.scrollIntoView({ block: "center" });
  btn.click();
  return window.__wiki.state.tuning.base_tiles && Object.keys(window.__wiki.state.tuning.base_tiles.overrides)[0];
});
await p.waitForTimeout(400);
const onCard = await p.evaluate(() => ({
  btn: document.querySelector(".base-btn")?.textContent,
  pill: [...document.querySelectorAll(".base-row .pill")].map((x) => x.textContent),
}));
ok(/revoke base title/.test(onCard.btn) && onCard.pill.includes("base tile"),
  `promoting flips the control and pins the title on the card (${onCard.btn})`);
ok(/^tiles\//.test(promotedKey ?? ""), `the designation rides the manifest's own tile key (${promotedKey})`);
await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
await p.waitForTimeout(1400);
const withBase = await p.evaluate(() => ({
  panel: document.querySelector(".ground-bases")?.innerText.replace(/\n+/g, " | "),
  pill: document.querySelector(".ground-bases .panel-title .pill")?.textContent,
}));
ok(/1 promoted/.test(withBase.pill) && /from grass over grass/.test(withBase.panel),
  `the Base tiles panel lists it, named by its set (${withBase.pill})`);
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(700);
ok(saves.length === 1 && saves[0].file === "tuning/base_tiles" && saves[0].set[promotedKey]?.type === "grass",
  `Commit posts tuning/base_tiles with the type it is the base OF (${JSON.stringify(saves[0]?.set?.[promotedKey])})`);

// ---- 3. revoke from the panel ----------------------------------------------
await p.evaluate(() => [...document.querySelectorAll(".ground-bases button")].find((x) => /Revoke/.test(x.textContent))?.click());
await p.waitForTimeout(500);
const revoked = await p.evaluate(() => document.querySelector(".ground-bases")?.innerText);
ok(/none yet|No base tile promoted yet/.test(revoked), "Revoke returns the ground to its flat colour on the spot");
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(700);
ok(saves.length === 2 && saves[1].set[promotedKey] === null,
  "and committing the revoke deletes the entry rather than storing a tombstone");

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
const seen = await pub.evaluate(() => ({
  palette: document.querySelectorAll(".ground-palette .ground-swatch").length,
  trans: document.querySelectorAll(".trans-row").length,
  promote: document.querySelectorAll(".base-btn").length,
  basePanel: document.querySelector(".ground-bases")?.innerText ?? "",
}));
ok(seen.palette > 0 && seen.trans > 0, `a player sees the palette and the transitions (${seen.palette} swatches, ${seen.trans} pairs)`);
ok(seen.promote === 0 && !/make base tile/.test(seen.basePanel),
  "and none of the promotion machinery");

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nGROUND-TYPE CHECKS FAILED (${fails.length})` : "\nALL GROUND-TYPE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
