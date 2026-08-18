// THE CREATURES OVERVIEW IS A SHOWCASE, NOT A CONTACT SHEET.
//
// Maintainer, 2026-08-18: "I feel the Creatures overview page needs to showcase
// the art a bit better. It feels as if some big monsters are displayed with 0.5x
// zoom and some smaller monsters are displayed with 1x zoom. It's also hard to
// use that page to show to a friend how many cool monsters we have by scrolling
// in the long list — because the monsters are so small it's hard to even see
// them … I feel it's more impactful to just scroll in the overview."
//
// Both halves were one bug: the card drew the sprite inside a 110px box with
// object-fit: contain, so a big frame was SHRUNK to fit while a small one was
// left at 1x — and a frame is mostly transparent padding, so the creature
// inside came out smaller still. The card now crops to the measured creature
// (clip.bb, the same measurement the animation viewer uses) and picks the
// largest WHOLE-NUMBER zoom that fills its box.
//
// This gate measures the RENDERED page against data.json's own numbers, and it
// is written so the old design fails it: the size band is asserted, and the old
// frame-fitted sizes are computed alongside to keep that non-vacuous.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const DATA = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const MON = DATA.domains.monsters ?? [];
const BOX = 150;                                  // must match SHOWCASE_BOX
const zoomFor = (w, h) => Math.max(1, Math.min(6, Math.floor(BOX / Math.max(w, h)) || 1));
const measured = new Map();
for (const m of MON) {
  const c = m.animations?.idle?.dirs?.south;
  if (!c?.bb) continue;
  const [x0, y0, x1, y1] = c.bb;
  measured.set(m.id, { w: x1 - x0, h: y1 - y0, frames: c.frames ?? 1, fw: c.fw ?? m.frameW, fh: c.fh ?? m.frameH });
}
ok(measured.size > 40, `the build measures the creature inside the frame for the roster (${measured.size}/${MON.length} idle/south clips)`);

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
await p.goto(`${W}#/monsters`, { waitUntil: "load" });
await p.waitForTimeout(2600);

// Scroll the whole list once, the way he would when showing it to somebody, so
// every card has been on screen and has drawn.
await p.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 700) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 60));
  }
  window.scrollTo(0, 0);
});
await p.waitForTimeout(1200);

const cards = await p.evaluate(() => [...document.querySelectorAll(".showcase-card")].map((c) => {
  const art = c.querySelector(".showcase-art");
  const r = art?.getBoundingClientRect();
  return {
    href: c.getAttribute("href"),
    name: c.querySelector(".card-name")?.textContent ?? "",
    art: art?.dataset.art ?? null,
    zoom: art ? Number(art.dataset.zoom) : null,
    w: r ? Math.round(r.width) : 0,
    h: r ? Math.round(r.height) : 0,
    loaded: !!art?.style.backgroundImage,
    level: !!c.querySelector(".showcase-level"),
    stage: Math.round(c.querySelector(".showcase")?.getBoundingClientRect().height ?? 0),
  };
}));
console.log(`cards: ${cards.length} | first: ${JSON.stringify(cards[0])}`);
ok(cards.length === MON.length, `every creature has a card (${cards.length}/${MON.length})`);
ok(cards.every((c) => c.level), "each carrying its level, on the art rather than on a row of its own");

// 1. THE CROP AND THE ZOOM ARE THE BUILD'S NUMBERS, not something the page felt
//    like. Checked per card against data.json.
const wrong = cards.filter((c) => {
  const id = (c.href ?? "").split("/").pop();
  const m = measured.get(id);
  if (!m) return false;                        // unmeasured falls back to the plain sprite
  const z = zoomFor(m.w, m.h);
  return c.zoom !== z || c.w !== m.w * z || c.h !== m.h * z;
});
ok(wrong.length === 0, `every card is the measured creature at its own whole-number zoom (${cards.length - wrong.length}/${cards.length}${wrong.length ? `, first bad ${JSON.stringify(wrong[0])}` : ""})`);
ok(cards.every((c) => c.zoom === null || Number.isInteger(c.zoom)), "and the zoom is a WHOLE number — pixel art is never scaled by a fraction");

// 2. THE SIZE BAND. This is the complaint, in numbers: with the frame fitted to
//    a 110px box the drawn creature ranged 27..110px; cropped and zoomed it
//    lands in a tight band, and nothing is tiny.
const drawn = cards.filter((c) => c.h).map((c) => Math.max(c.w, c.h));
const lo = Math.min(...drawn), hi = Math.max(...drawn);
// What the OLD design would have drawn: the frame scaled to fit 110px, the
// creature being whatever fraction of that frame it occupies.
const before = [...measured.entries()].map(([, m]) => {
  const fit = Math.min(1, 110 / Math.max(m.fw, m.fh));
  return Math.max(m.w, m.h) * fit;
});
const bLo = Math.min(...before), bHi = Math.max(...before);
console.log(`size band: now ${lo}..${hi} (×${(hi / lo).toFixed(2)}) | before ${bLo.toFixed(0)}..${bHi.toFixed(0)} (×${(bHi / bLo).toFixed(2)})`);
ok(hi / lo <= 2, `every creature lands in one size band (${lo}..${hi}px, ×${(hi / lo).toFixed(2)})`);
ok(bHi / bLo > hi / lo, `which the frame-fitted design did NOT (${bLo.toFixed(0)}..${bHi.toFixed(0)}px, ×${(bHi / bLo).toFixed(2)}) — the check is not vacuous`);
ok(lo >= 80, `and the smallest creature is big enough to see from across a room (${lo}px against ${bLo.toFixed(0)}px before)`);

// 3. IT MOVES. One strip per card, swept by CSS steps — so a scroll down the
//    list is the showcase.
const moving = await p.evaluate(async () => {
  const art = document.querySelector(".showcase-art.play");
  if (!art) return { played: false };
  const at = () => getComputedStyle(art).backgroundPositionX;
  const seen = new Set();
  for (let i = 0; i < 14; i++) { seen.add(at()); await new Promise((r) => setTimeout(r, 90)); }
  return { played: true, positions: seen.size, frames: art.style.getPropertyValue("--frames"), dur: art.style.getPropertyValue("--dur") };
});
console.log("animation:", JSON.stringify(moving));
ok(moving.played, "the card on screen is animating its idle");
ok((moving.positions ?? 0) > 1, `and the frame really advances (${moving.positions} distinct positions sampled)`);

// 4. AN OFF-SCREEN CARD COSTS NOTHING: no image, no animation.
const far = await p.evaluate(() => {
  const arts = [...document.querySelectorAll(".showcase-art")];
  const last = arts[arts.length - 1];
  return { total: arts.length, loaded: arts.filter((a) => a.style.backgroundImage).length, playing: arts.filter((a) => a.classList.contains("play")).length, lastPlaying: last.classList.contains("play") };
});
console.log("at the top of the list:", JSON.stringify(far));
ok(far.playing < far.total, `only what is on screen animates (${far.playing} of ${far.total})`);
ok(!far.lastPlaying, "the far end of the list is not animating while you are at the top");

// 5. THE CARD IS STILL A LINK to the creature it shows.
const href = cards[0].href;
await p.evaluate(() => document.querySelector(".showcase-card").click());
await p.waitForTimeout(1200);
const landed = await p.evaluate(() => ({ hash: location.hash, h1: document.querySelector("h1")?.textContent ?? "" }));
ok(landed.hash === href, `and it still opens the creature it shows (${landed.hash} — ${landed.h1})`);

// 6. REDUCED MOTION IS HONOURED — the same picture, standing still.
const calm = await ctx.newPage();
await calm.emulateMedia({ reducedMotion: "reduce" });
calm.on("pageerror", (e) => errs.push(String(e)));
await calm.goto(`${W}#/monsters`, { waitUntil: "load" });
await calm.waitForTimeout(2600);
const still = await calm.evaluate(async () => {
  const art = document.querySelector(".showcase-art.play");
  if (!art) return { found: false };
  const a = getComputedStyle(art).backgroundPositionX;
  await new Promise((r) => setTimeout(r, 700));
  return { found: true, same: a === getComputedStyle(art).backgroundPositionX, anim: getComputedStyle(art).animationName };
});
console.log("reduced motion:", JSON.stringify(still));
ok(still.found && still.same && still.anim === "none",
  `asked for less motion, the creatures hold still and are still drawn (${JSON.stringify(still)})`);

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nFAILED ${fails.length}` : "\nAll good.");
process.exit(fails.length ? 1 : 0);
