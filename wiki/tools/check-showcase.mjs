// THE CREATURES OVERVIEW IS A SHOWCASE: TRUE SCALE, AND THE CARD GROWS INSTEAD.
//
// Maintainer, round 1 (2026-08-18): "some big monsters are displayed with 0.5x
// zoom and some smaller monsters are displayed with 1x zoom … the monsters are
// so small it's hard to even see them … it's more impactful to just scroll in
// the overview." Round 2, on that fix: "the Dewling now looks very big compared
// to Diretusk. I think just showing the monsters in their TRUE SCALE (I think
// the game uses what we call 2x) and just make some cards take up more space
// instead … 1x1 (small), 2x1 (wide), 1x2 (tall) or 2x2 … On mobile two 1x1 can
// fit on one row."
//
// So the contract this gate holds the page to is:
//   1. EVERY creature is drawn at the game's own scale — no per-card zoom.
//   2. The CARD spans the cells its creature needs, measured, never clipped.
//   3. Two 1×1 cards share a row on the smallest phone.
//   4. It still moves, still lazily, and still opens the creature.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const DATA = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const MON = DATA.domains.monsters ?? [];
const SCALE = DATA.iso?.artScale ?? DATA.artScale ?? 2;
const art = new Map();
for (const m of MON) {
  const c = m.animations?.idle?.dirs?.south;
  if (!c?.bb) continue;
  const [x0, y0, x1, y1] = c.bb;
  art.set(m.id, { w: (x1 - x0) * SCALE, h: (y1 - y0) * SCALE });
}
console.log(`scale ${SCALE}× | measured ${art.size}/${MON.length} | drawn ${Math.min(...[...art.values()].map((a) => a.h))}..${Math.max(...[...art.values()].map((a) => a.h))}px tall`);
ok(SCALE === 2, `the roster is drawn at the game's own scale (${SCALE}×)`);
ok(art.size > 40, `and the build measured the creature inside the frame for it (${art.size} clips)`);

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const errs = [];
const open = async (width) => {
  const ctx = await b.newContext({ viewport: { width, height: 851 }, isMobile: width < 700, hasTouch: width < 700, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(`${W}#/monsters`, { waitUntil: "load" });
  await p.waitForTimeout(2600);
  return { ctx, p };
};
const survey = (p) => p.evaluate(() => {
  const grid = document.querySelector(".showcase-grid");
  const cards = [...grid.querySelectorAll(".showcase-card")];
  const rows = new Map();
  const out = cards.map((c) => {
    const el = c.querySelector(".showcase");
    const stage = el.getBoundingClientRect();
    // The box the art actually gets: the stage minus its own padding, read the
    // same way the page reads it.
    const cs = getComputedStyle(el);
    const innerW = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const innerH = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const a = c.querySelector(".showcase-art");
    const ar = a?.getBoundingClientRect();
    const top = Math.round(c.getBoundingClientRect().top);
    rows.set(top, (rows.get(top) ?? 0) + 1);
    return {
      id: (c.getAttribute("href") ?? "").split("/").pop(),
      span: c.dataset.span,
      drawn: a?.dataset.drawn ?? null,
      zoom: a ? Number(a.dataset.zoom) : null,
      overH: ar ? Math.round(ar.height - innerH) : 0,
      overW: ar ? Math.round(ar.width - innerW) : 0,
      stageH: Math.round(stage.height),
      stageW: Math.round(stage.width),
      innerW, innerH,
      // How far the art's own box sits off the middle of its stage, per axis.
      // "Centred" is a claim about the ART, not about the flex container that
      // happens to hold it.
      offY: ar ? Math.abs((ar.top + ar.bottom) / 2 - (stage.top + stage.bottom) / 2) : null,
      offX: ar ? Math.abs((ar.left + ar.right) / 2 - (stage.left + stage.right) / 2) : null,
      top,
    };
  });
  return {
    cols: Number(grid.dataset.cols), over: Number(grid.dataset.over), cards: out,
    sharedRows: [...rows.values()].filter((n) => n > 1).length,
    // Anything that appears on SOME cards only must ride the art, or it steals
    // height from the stage the spans were measured against.
    badgesInText: document.querySelectorAll(".showcase-text .card-badges").length,
    textLines: [...new Set(cards.map((c) => c.querySelector(".showcase-text")?.children.length ?? 0))],
  };
});

// ---------------------------------------------------------- 1. HIS PHONE
const { p } = await open(393);
const s393 = await survey(p);
const counts = s393.cards.reduce((a, c) => ((a[c.span] = (a[c.span] ?? 0) + 1), a), {});
console.log(`393px: ${s393.cols} columns | ${JSON.stringify(counts)}`);
ok(s393.cards.length === MON.length, `every creature has a card (${s393.cards.length}/${MON.length})`);

// TRUE SCALE, ALL OF THEM. This is the round-2 complaint, in one assertion.
const zoomWrong = s393.cards.filter((c) => c.zoom !== null && c.zoom !== SCALE);
const sizeWrong = s393.cards.filter((c) => {
  const a = art.get(c.id);
  return a && c.drawn !== `${a.w}x${a.h}`;
});
ok(zoomWrong.length === 0, `nothing has a zoom of its own — all ${SCALE}× (${zoomWrong.length} exceptions)`);
ok(sizeWrong.length === 0, `so a creature is drawn at its true size (${sizeWrong.length} exceptions${sizeWrong[0] ? `, e.g. ${sizeWrong[0].id} ${sizeWrong[0].drawn}` : ""})`);
// The relative sizes are the point: the mammoth really is bigger than the poring.
const mam = s393.cards.find((c) => c.id === "mammoth"), por = s393.cards.find((c) => /poring/.test(c.id ?? ""));
if (mam && por) {
  const mh = Number(mam.drawn.split("x")[1]), ph = Number(por.drawn.split("x")[1]);
  ok(mh > ph * 1.8, `and a mammoth towers over a poring instead of matching it (${mh}px vs ${ph}px)`);
}

// THE CARD IS WHAT GROWS. Spans follow the measured art, and nothing is clipped.
ok(s393.cards.every((c) => /^[12]x[12]$/.test(c.span ?? "")), "every card is 1×1, 2×1, 1×2 or 2×2");
ok(Object.keys(counts).length >= 3, `and the roster really uses the range (${JSON.stringify(counts)})`);
ok((counts["1x1"] ?? 0) >= 20, `with the small creatures packed dense (${counts["1x1"] ?? 0} single cells)`);
ok((counts["2x2"] ?? 0) >= 1, `and the giants taking a full 2×2 (${counts["2x2"] ?? 0})`);
const clipped = s393.cards.filter((c) => c.overH > 0.5 || c.overW > 0.5);
ok(clipped.length === 0, `no creature is cut off by its own card (${clipped.length}${clipped[0] ? `, e.g. ${clipped[0].id} over by ${clipped[0].overH}px` : ""})`);
ok(s393.over === 0, "and none is too big even for 2×2 — the tripwire for a future giant");
ok(s393.sharedRows > 0, `two cards share a row on his phone (${s393.sharedRows} shared rows)`);

// EVERY SINGLE CELL IS THE SAME BOX. The spans are decided by measuring ONE
// 1×1 card and applying its stage to all 57, so a card that is quietly shorter
// than the probe — a third line of text on the ones the Game Master has
// starred, say — would be handed a span that clips its art. Two heights here
// means that assumption has broken, whatever the clipping check says today.
const singles = new Set(s393.cards.filter((c) => c.span === "1x1").map((c) => c.stageH));
ok(singles.size === 1, `every single cell is the same box, so the measured span applies to all of them (${[...singles].join(", ")}px)`);
ok(s393.badgesInText === 0 && s393.textLines.length === 1 && s393.textLines[0] === 2,
  `and the text block is exactly two lines on every card (${s393.textLines.join("/")} children, ${s393.badgesInText} badge rows)`);

// A SECOND CELL IS EARNED, NEVER DECORATIVE. "Make some cards take up more
// space" only reads as size if the big card is big BECAUSE the creature is:
// every 2-row card must hold art that would not have fitted one row, and every
// 2-column card art too wide for one column.
const ones = s393.cards.filter((c) => c.span === "1x1");
const cell1 = { h: Math.min(...ones.map((c) => c.innerH)), w: Math.min(...ones.map((c) => c.innerW)) };
const unearnedR = s393.cards.filter((c) => c.span.endsWith("x2") && Number(c.drawn.split("x")[1]) <= cell1.h);
const unearnedC = s393.cards.filter((c) => c.span.startsWith("2x") && Number(c.drawn.split("x")[0]) <= cell1.w);
ok(unearnedR.length === 0 && unearnedC.length === 0,
  `and a bigger card is one the creature needs (${unearnedR.length + unearnedC.length} taking a cell they would have fitted without)`);

// CENTRED, ON EVERY SIZE OF CARD (maintainer 2026-08-18: "the monster is not
// centered on the 1x1 card … Centering looks best"). The first cut anchored the
// one-row cards to a shared floor and only the two-row ones centred, so this
// checks BOTH axes on every card — a rule that holds for three sizes out of
// four is exactly the bug he spotted.
const offc = s393.cards.filter((c) => c.offY == null || c.offY > 1.5 || c.offX > 1.5);
ok(offc.length === 0,
  `every creature is centred in its stage, whatever the card size (${offc.length} off-centre${offc[0] ? `, e.g. ${offc[0].id} by ${Math.round(offc[0].offY)}px` : ""})`);
const bySpan = [...new Set(s393.cards.map((c) => c.span))];
ok(bySpan.length > 1, `checked across ${bySpan.length} card sizes (${bySpan.join(", ")})`);

// ------------------------------------------- 2. THE SMALLEST PHONE, his rule
const { ctx: c360, p: p360 } = await open(360);
const s360 = await survey(p360);
console.log(`360px: ${s360.cols} columns | shared rows ${s360.sharedRows}`);
ok(s360.cols >= 2, `"on mobile two 1x1 can fit on one row" holds on a 360px phone too (${s360.cols} columns)`);
ok(s360.cards.every((c) => c.overH <= 0.5 && c.overW <= 0.5), "and nothing is clipped there either");
await c360.close();

// ------------------------------------------------------ 3. A WIDE SCREEN
const { ctx: cD, p: pD } = await open(1280);
const sD = await survey(pD);
console.log(`1280px: ${sD.cols} columns | ${JSON.stringify(sD.cards.reduce((a, c) => ((a[c.span] = (a[c.span] ?? 0) + 1), a), {}))}`);
ok(sD.cols >= 4, `a desktop lays out more of them at the same size, not bigger ones (${sD.cols} columns)`);
ok(sD.cards.every((c) => c.overH <= 0.5 && c.overW <= 0.5), "still nothing clipped");
const dMam = sD.cards.find((c) => c.id === "mammoth");
ok(dMam && dMam.drawn === s393.cards.find((c) => c.id === "mammoth")?.drawn,
  `and a creature is the same size on a phone and a desktop (${dMam?.drawn})`);
await cD.close();

// ------------------------------------------------------------ 4. IT MOVES
const moving = await p.evaluate(async () => {
  const a = document.querySelector(".showcase-art.play");
  if (!a) return { played: false };
  const at = () => getComputedStyle(a).backgroundPositionX;
  const seen = new Set();
  for (let i = 0; i < 14; i++) { seen.add(at()); await new Promise((r) => setTimeout(r, 90)); }
  return { played: true, positions: seen.size };
});
console.log("animation:", JSON.stringify(moving));
ok(moving.played && moving.positions > 1, `the cards on screen animate their idle (${moving.positions} distinct frames sampled)`);
const lazy = await p.evaluate(() => {
  const arts = [...document.querySelectorAll(".showcase-art")];
  return { total: arts.length, playing: arts.filter((a) => a.classList.contains("play")).length, lastLoaded: !!arts[arts.length - 1].style.backgroundImage };
});
console.log("lazy:", JSON.stringify(lazy));
ok(lazy.playing < lazy.total && !lazy.lastLoaded, `and the far end of the list holds no image and no animation (${lazy.playing} of ${lazy.total} playing)`);

// --------------------------------------------------- 5. IT IS STILL A LINK
const first = s393.cards[0];
await p.evaluate(() => document.querySelector(".showcase-card").click());
await p.waitForTimeout(1200);
const hash = await p.evaluate(() => location.hash);
ok(hash === `#/monsters/${first.id}`, `and a card still opens the creature it shows (${hash})`);

// ------------------------------------------------------ 6. REDUCED MOTION
const calm = await b.newContext({ viewport: { width: 393, height: 851 }, reducedMotion: "reduce" });
const pc = await calm.newPage();
pc.on("pageerror", (e) => errs.push(String(e)));
await pc.goto(`${W}#/monsters`, { waitUntil: "load" });
await pc.waitForTimeout(2600);
const still = await pc.evaluate(async () => {
  const a = document.querySelector(".showcase-art.play");
  if (!a) return { found: false };
  const x = getComputedStyle(a).backgroundPositionX;
  await new Promise((r) => setTimeout(r, 700));
  return { found: true, same: x === getComputedStyle(a).backgroundPositionX, anim: getComputedStyle(a).animationName, drawn: a.dataset.drawn };
});
console.log("reduced motion:", JSON.stringify(still));
ok(still.found && still.same && still.anim === "none", `asked for less motion, they hold still and are still drawn (${still.drawn})`);

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nFAILED ${fails.length}` : "\nAll good.");
process.exit(fails.length ? 1 : 0);
