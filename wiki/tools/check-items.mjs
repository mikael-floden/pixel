// THE ITEMS PAGE IS AN INVENTORY, NOT A SHELF OF POSTERS.
//
// Maintainer 2026-08-24: "Items are so small and we have so many. So I feel the
// current page will make it take forever to scroll over the different items.
// Can you redesign the page so we can fit a lot more items on a single page?
// It's unreasonable the card is as big as a monster. It also gives a more WOW
// feeling scrolling over a lot of different graphics."
//
// Every item icon is authored 48x48 — measured on all 105 — and they were
// sitting in 110px thumbs inside two-column cards built for a creature that
// stands 150px. Measured on his phone viewport before the change: TWO items in
// view and 32,984px of scroll. After: 28 in view and 2,831px.
//
// So this gate holds the DENSITY, in the units that decide it: how many cells a
// phone screen shows, and how tall the page is. It also holds the two things
// density is allowed to cost nothing: the art stays at its native 48px (pixel
// art is never resampled here), and every cell stays distinguishable — 28 of
// these are soulstones whose `name` is "Soulstone", so the caption carries the
// creature instead.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const ROOT = new URL("../../", import.meta.url).pathname;
const D = JSON.parse(readFileSync(join(ROOT, "wiki/site/data.json"), "utf8"));
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const items = D.domains.items ?? [];
ok(items.length > 50, `there are enough items for density to matter (${items.length})`);

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});
await p.goto(`${W}#/items`, { waitUntil: "load" });
await p.waitForTimeout(2600);

const grid = await p.evaluate(() => {
  const cells = [...document.querySelectorAll(".item-cell")];
  const vh = window.innerHeight;
  const first = cells[0]?.getBoundingClientRect();
  const img = cells[0]?.querySelector("img");
  return {
    n: cells.length,
    inView: cells.filter((c) => { const r = c.getBoundingClientRect(); return r.top < vh && r.bottom > 0; }).length,
    cols: first ? cells.filter((c) => Math.abs(c.getBoundingClientRect().top - first.top) < 2).length : 0,
    cellW: first ? Math.round(first.width) : 0,
    cellH: first ? Math.round(first.height) : 0,
    pageHeight: Math.round(document.body.scrollHeight),
    iconNative: img ? [img.naturalWidth, img.naturalHeight] : null,
    iconDrawn: img ? [Math.round(img.getBoundingClientRect().width), Math.round(img.getBoundingClientRect().height)] : null,
    names: cells.slice(0, 24).map((c) => c.querySelector(".item-cell-name")?.textContent.trim() ?? ""),
    widest: Math.max(...cells.map((c) => Math.round(c.getBoundingClientRect().width))),
  };
});
ok(grid.n === items.length, `every item is on the page (${grid.n} of ${items.length})`);
ok(grid.inView >= 20,
  `a phone screen shows a wall of them — ${grid.inView} at once, where the creature-sized cards showed 2`);
ok(grid.cols >= 4, `at least four across a 393px phone (${grid.cols} columns, cell ${grid.cellW}x${grid.cellH})`);
ok(grid.pageHeight < 6000,
  `and the whole library is a short scroll rather than a marathon (${grid.pageHeight}px, was 32,984)`);
// A CELL IS NEVER TALLER THAN IT NEEDS TO BE. "It's unreasonable the card is as
// big as a monster" — the creature cards are ~250px; a cell must stay near its
// 48px icon.
ok(grid.cellH <= 110, `a cell is sized for its icon, not for a creature (${grid.cellH}px tall)`);
// PIXEL ART IS NEVER RESAMPLED: the icons are authored at 48 and drawn at 48.
ok(grid.iconNative?.[0] === 48 && grid.iconDrawn?.[0] === 48 && grid.iconDrawn?.[1] === 48,
  `the art is drawn at its authored size, not scaled (${grid.iconNative?.join("x")} drawn ${grid.iconDrawn?.join("x")})`);
// DENSITY MUST NOT COST IDENTITY. 28 items are soulstones all named
// "Soulstone"; the caption has to carry the creature or the grid is a wall of
// one word.
const dupes = grid.names.filter((x) => x === "Soulstone").length;
ok(dupes === 0 && new Set(grid.names).size >= grid.names.length - 2,
  `every cell says something different — the soul stones name their creature (${grid.names.slice(0, 4).join(", ")}…, ${dupes} bare "Soulstone")`);

// The tools above it still work, and filtering does not break the grid.
await p.evaluate(() => [...document.querySelectorAll(".item-tools .seg button")].find((x) => /Soul/i.test(x.textContent))?.click());
await p.waitForTimeout(1200);
const soulOnly = await p.evaluate(() => ({
  n: document.querySelectorAll(".item-cell").length,
  allSoul: [...document.querySelectorAll(".item-cell")].every((c) => c.querySelector(".item-cell-type")),
}));
const expSoul = items.filter((x) => x.type === "SOUL").length;
ok(soulOnly.n === expSoul, `the type filter still narrows the grid (${soulOnly.n} of ${items.length}, expected ${expSoul})`);

// A cell is a link to that item, and a tap target big enough to hit.
await p.evaluate(() => [...document.querySelectorAll(".item-tools .seg button")].find((x) => /^All$/i.test(x.textContent))?.click());
await p.waitForTimeout(1000);
const tap = await p.evaluate(() => {
  const c = document.querySelector(".item-cell");
  const r = c.getBoundingClientRect();
  return { href: c.getAttribute("href"), w: Math.round(r.width), h: Math.round(r.height), title: c.getAttribute("title") ?? "" };
});
ok(/^#\/items\//.test(tap.href) && tap.w >= 44 && tap.h >= 44,
  `each cell is a real tap target that opens its item (${tap.w}x${tap.h}, ${tap.href})`);
ok(tap.title.length > 8, `with the full name and worth on the tooltip, since the caption is clamped ("${tap.title.slice(0, 52)}…")`);

ok(errs.length === 0, `no page errors${errs.length ? `: ${errs[0]}` : ""}`);
await b.close();
console.log(fails.length ? `\nITEM CHECKS FAILED (${fails.length})` : "\nALL ITEM CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
