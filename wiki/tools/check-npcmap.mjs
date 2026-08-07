// An NPC standing in the world gets a map of roughly where (maintainer
// 2026-08-06) — the creatures' habitat map, marked as a spot, not a pin.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const D = JSON.parse(readFileSync("/home/user/pixel/wiki/site/data.json", "utf8"));
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await (await b.newContext({ viewport: { width: 426, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };

// ---------- data: the join maps2 → characters2 must be exact
const placed = D.world?.map?.npcs ?? {};
const ids = Object.keys(placed);
const chars = new Map(D.domains.characters.map((c) => [c.id, c]));
ok(ids.length > 0, `maps2 places a cast in ${D.world?.name} (${ids.length} characters)`);
ok(ids.every((id) => chars.has(id)), "every placed id resolves to a character page");
ok(ids.every((id) => placed[id].every((s) => Number.isInteger(s.x) && Number.isInteger(s.y))),
  "every placement carries an exact cell");
const merch = ids.filter((id) => placed[id].some((s) => s.type === "MERCHANT"));
ok(merch.length > 0 && merch.every((id) => placed[id].some((s) => (s.wares ?? []).length)),
  `merchants carry their wares (${merch.length} merchants)`);
// the maps2 name must still equal characters2' — a rename must not rot silently
const drift = ids.filter((id) => placed[id].some((s) => s.name && s.name !== chars.get(id)?.name));
ok(drift.length === 0, `no name drift between maps2 and characters2 (${drift.join(",") || "none"})`);

// ---------- a placed MERCHANT's page
const mid = merch[0];
await p.goto(`${W}#/characters/${mid}`, { waitUntil: "load" });
await p.waitForTimeout(2200);
const page = await p.evaluate(() => {
  const panel = [...document.querySelectorAll(".panel")].find((x) => /Where you'll find them/.test(x.querySelector(".panel-title")?.textContent ?? ""));
  const img = panel?.querySelector("img.zone-map");
  const spot = panel?.querySelector(".npc-spot");
  const ir = img?.getBoundingClientRect(), sr = spot?.getBoundingClientRect();
  return {
    h1: document.querySelector("h1")?.textContent,
    has: !!panel, spots: panel?.querySelectorAll(".npc-spot").length ?? 0,
    where: panel?.querySelector(".pill")?.textContent,
    note: panel?.querySelector("p.muted")?.textContent ?? "",
    // The world pills moved ONTO the role line (.npc-trade) 2026-08-07 —
    // as their own .spawn-line row they only existed for the 19 placed NPCs,
    // so paging ‹ › shifted every panel below them.
    chips: [...document.querySelectorAll(".npc-trade .pill")].map((x) => x.textContent),
    loaded: !!img?.naturalWidth,
    // the marker's centre as a FRACTION of the displayed map — comparable to
    // the projection recomputed from the data, at any screen size
    frac: ir && sr ? [(sr.left + sr.width / 2 - ir.left) / ir.width, (sr.top + sr.height / 2 - ir.top) / ir.height] : null,
    // it must read at the size it is DISPLAYED, not just in the source image
    dotPx: sr ? Math.round(sr.width) : 0,
    haloPx: spot ? parseFloat(getComputedStyle(spot, "::before").width) : 0,
    inside: ir && sr ? sr.left >= ir.left && sr.right <= ir.right && sr.top >= ir.top && sr.bottom <= ir.bottom : null,
    fits: ir ? ir.width <= window.innerWidth + 1 : null,
  };
});
console.log("merchant page:", JSON.stringify(page));
ok(page.has, `${page.h1}'s page carries the map`);
ok(/market|bridge|road|cave|shore|arrival/.test(page.where ?? ""), `the pill says where in words (${page.where})`);
ok(/Roughly here/.test(page.note) && /not stand on one tile/.test(page.note), "and says plainly that it is approximate");
ok(page.chips.some((t) => /merchant in the world/.test(t)), `the head chips them as placed (${page.chips.join(" | ")})`);
ok(page.chips.some((t) => /^sells /.test(t)), "and says what they sell");
ok(page.loaded, "the world minimap loads");
ok(page.spots === placed[mid].length, `one mark per placement (${page.spots})`);
ok(page.inside, "the mark sits inside the map");
ok(page.dotPx >= 9 && page.haloPx >= 30, `it reads at phone size — ${page.dotPx}px dot, ${page.haloPx}px halo (a canvas-painted dot shrank to ~2px here)`);
ok(page.fits !== false, "the map fits the phone viewport");

// the projection itself: recompute the cell→pixel affine from the data and
// compare with where the marker actually landed
const P = D.world.map.proj, wmW = D.world.map.mapW, wmH = D.world.map.mapH;
const sp0 = placed[mid][0];
const expX = (P.s * (P.ox + (sp0.x - sp0.y) * P.dx + P.tile / 2) + P.offx) / wmW;
const expY = (P.s * (P.oy + (sp0.x + sp0.y) * P.dy - (sp0.elev ?? 0) * P.levelPx + P.dy) + P.offy) / wmH;
console.log(`projection: expected ${expX.toFixed(4)},${expY.toFixed(4)} · rendered ${page.frac?.map((v) => v.toFixed(4))}`);
ok(page.frac && Math.abs(page.frac[0] - expX) < 0.005 && Math.abs(page.frac[1] - expY) < 0.005,
  "the mark lands exactly where the world's own cell→pixel transform puts that cell");

// two NPCs standing in different PARTS of the world must mark different places
// (the market pair stand 2 cells apart, which is ~4 display px — correctly
// close, and no test of the projection at all: take the farthest one instead)
const far = (id) => Math.hypot(placed[id][0].x - sp0.x, placed[id][0].y - sp0.y);
const other = ids.filter((id) => id !== mid).sort((a, z) => far(z) - far(a))[0];
console.log(`farthest cast member: ${placed[other][0].name} at ${placed[other][0].x},${placed[other][0].y} (${Math.round(far(other))} cells away)`);
await p.goto(`${W}#/characters/${other}`, { waitUntil: "load" });
await p.waitForTimeout(2000);
const frac2 = await p.evaluate(() => {
  const img = document.querySelector(".npc-map-wrap img"), spot = document.querySelector(".npc-spot");
  const ir = img.getBoundingClientRect(), sr = spot.getBoundingClientRect();
  return [(sr.left + sr.width / 2 - ir.left) / ir.width, (sr.top + sr.height / 2 - ir.top) / ir.height];
});
ok(Math.hypot(frac2[0] - page.frac[0], frac2[1] - page.frac[1]) > 0.01,
  `a different NPC marks a different spot (${frac2.map((v) => v.toFixed(3))})`);

// ---------- an UNPLACED NPC has no map and no chip
const unplaced = D.domains.characters.find((c) => c.kind === "npc" && !placed[c.id]);
await p.goto(`${W}#/characters/${unplaced.id}`, { waitUntil: "load" });
await p.waitForTimeout(1800);
const un = await p.evaluate(() => ({
  has: [...document.querySelectorAll(".panel-title")].some((x) => /Where you'll find them/.test(x.textContent)),
  chips: document.querySelectorAll(".npc-trade .pill").length,
  h1: document.querySelector("h1")?.textContent,
}));
console.log("unplaced:", JSON.stringify(un));
ok(!un.has && un.chips === 0, `${un.h1} is not in the world, so no map and no chip`);
// …but the ROW that would have carried the chip is still there and still the
// same height, which is the whole point of moving them onto it.
const unRow = await p.evaluate(() => {
  const t = document.querySelector(".npc-trade");
  return t ? Math.round(t.getBoundingClientRect().height) : null;
});
ok(unRow !== null && unRow > 0, `and the role line is still there at its normal height (${unRow}px), so nothing below it moves`);

// ---------- the Races list marks the placed ones so they are findable
await p.goto(W + "#/characters", { waitUntil: "load" });
await p.waitForTimeout(2000);
const list = await p.evaluate(() => {
  const cards = [...document.querySelectorAll(".npc-grid .npc-card")];
  const dots = cards.filter((c) => c.querySelector(".npc-placed"));
  const nameH = (c) => c.querySelector(".npc-name").getBoundingClientRect().height;
  return { cards: cards.length, dots: dots.length,
    sameHeight: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().height))).size,
    nameLines: Math.round(nameH(cards[0]) / parseFloat(getComputedStyle(cards[0].querySelector(".npc-name")).lineHeight)),
    dotOnThumb: dots[0] ? (() => {
      const d = dots[0].querySelector(".npc-placed").getBoundingClientRect();
      const t = dots[0].querySelector(".thumb").getBoundingClientRect();
      return d.top >= t.top - 1 && d.bottom <= t.bottom + 1 && d.right <= t.right + 1;
    })() : null };
});
console.log("list:", JSON.stringify(list));
ok(list.dots > 0, `placed NPCs are dotted on the grid (${list.dots} on this page)`);
ok(list.sameHeight === 1, `the dot does not re-flow the grid — every tile the same height (${list.sameHeight} distinct)`);
ok(list.nameLines === 1, "the name is still one line");
ok(list.dotOnThumb, "the dot rides on the portrait");

// ---------- the creature map still works (shared component)
await p.goto(W + "#/monsters/tree_stump", { waitUntil: "load" });
await p.waitForTimeout(2200);
const mon = await p.evaluate(() => {
  const panel = [...document.querySelectorAll(".panel")].find((x) => /Where it lives/.test(x.querySelector(".panel-title")?.textContent ?? ""));
  const cv = panel?.querySelector("canvas.zone-map");
  if (!cv) return { has: false };
  const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
  let painted = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) painted++;
  return { has: true, painted };
});
console.log("monster map:", JSON.stringify(mon));
ok(mon.has && mon.painted > 10000, "the creature habitat map is untouched");

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL NPC-MAP CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
