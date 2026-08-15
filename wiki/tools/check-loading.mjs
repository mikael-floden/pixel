// THE WAIT LOOKS LIKE THE WIKI.
//
// Maintainer, 2026-08-15: "When opening the wiki it can take some time to load
// it sometimes. When this happens you have an ugly looking loading screen. It
// would be better if that loading screen is a centered and 45% from top
// centered loading bar that follows the UI/UX CSS design."
//
// The loading state is the FIRST thing anyone sees, and on a phone opening the
// drawer over a running game it can be the only thing for a second or two. It
// is markup in index.html rather than something wiki.js draws, so it paints
// before a single byte of data arrives — which is the whole point, and also
// why it needs its own gate: nothing else here would notice it breaking.
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });

for (const scheme of ["light", "dark"]) {
  const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: scheme });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  // Hold the data back, the way a slow phone link does, so the loading state
  // is observable at all.
  await p.route("**/wiki/site/data.json", async (r) => { await new Promise((res) => setTimeout(res, 2500)); await r.continue(); });
  await p.goto(W, { waitUntil: "commit" });
  await p.waitForTimeout(800);
  const look = await p.evaluate(() => {
    const el = document.querySelector(".loading");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const track = document.querySelector(".loading-bar");
    const fill = document.querySelector(".loading-bar span");
    const cs = getComputedStyle(fill);
    const root = getComputedStyle(document.documentElement);
    const px = (v) => Number(root.getPropertyValue(v).trim().replace("px", ""));
    return {
      pctFromTop: Math.round(((r.top + r.height / 2) / window.innerHeight) * 100),
      offCentre: Math.abs((r.left + r.width / 2) - window.innerWidth / 2),
      width: Math.round(r.width), vw: window.innerWidth,
      text: el.textContent.replace(/\s+/g, " ").trim(),
      brandFont: getComputedStyle(document.querySelector(".loading-brand")).fontFamily,
      fill: cs.backgroundColor, animation: cs.animationName,
      track: getComputedStyle(track).backgroundColor,
      accent: root.getPropertyValue("--accent").trim(),
      surface2: root.getPropertyValue("--surface-2").trim(),
      radius: getComputedStyle(track).borderRadius,
      left: Math.round(fill.getBoundingClientRect().left),
      // Nothing may scroll: a loading screen with a scrollbar is the "ugly"
      // he was describing.
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  console.log(`${scheme}:`, JSON.stringify(look));
  ok(!!look, `${scheme}: the loading state exists before the data does`);
  ok(look.pctFromTop === 45, `${scheme}: it sits 45% from the top (${look.pctFromTop}%)`);
  ok(look.offCentre <= 1, `${scheme}: horizontally centred (${look.offCentre}px off)`);
  ok(look.width <= look.vw * 0.8 && look.width > 100, `${scheme}: a bar, not a band across the screen (${look.width} of ${look.vw}px)`);
  ok(!look.overflow, `${scheme}: and nothing overflows the viewport`);
  // "follows the UI/UX CSS design" — the wiki's own tokens, not new colours.
  const rgb = (hex) => { const n = parseInt(hex.replace("#", ""), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; };
  ok(look.fill === rgb(look.accent), `${scheme}: the bar is the wiki's accent, not a new colour (${look.fill})`);
  ok(look.track === rgb(look.surface2), `${scheme}: on the wiki's own surface (${look.track})`);
  ok(/999|9999/.test(look.radius) || parseFloat(look.radius) >= 999, `${scheme}: with the pill radius the rest of the UI uses (${look.radius})`);
  ok(/serif/i.test(look.brandFont), `${scheme}: and the brand word in the display serif (${look.brandFont.split(",")[0]})`);
  // It must MOVE — a frozen bar reads as a hung page.
  await p.waitForTimeout(400);
  const moved = await p.evaluate(() => Math.round(document.querySelector(".loading-bar span").getBoundingClientRect().left));
  ok(look.animation === "loading-sweep", `${scheme}: the bar is animated (${look.animation})`);
  ok(moved !== look.left, `${scheme}: and really moves (${look.left} → ${moved})`);
  // And it must get out of the way the moment there is something to show.
  await p.waitForTimeout(2600);
  const gone = await p.evaluate(() => ({ loading: !!document.querySelector(".loading"), cards: document.querySelectorAll("#content a, #content .panel").length }));
  ok(!gone.loading && gone.cards > 0, `${scheme}: it disappears as soon as the wiki has something to show (${gone.cards} things rendered)`);
  ok(errs.length === 0, `${scheme}: no page errors${errs.length ? ` — ${errs[0]}` : ""}`);
  await ctx.close();
}

// A reader who asked for less motion gets NO motion — the stylesheet enforces
// that globally with `* { animation: none !important }`. The bar must then
// still read as "working": a frozen 40% sliver would look like a hung page, so
// it fills its track and dims instead.
const rctx = await b.newContext({ viewport: { width: 393, height: 851 }, reducedMotion: "reduce" });
const rp = await rctx.newPage();
await rp.route("**/wiki/site/data.json", async (r) => { await new Promise((res) => setTimeout(res, 2000)); await r.continue(); });
await rp.goto(W, { waitUntil: "commit" });
await rp.waitForTimeout(700);
const reduced = await rp.evaluate(() => {
  const fill = document.querySelector(".loading-bar span");
  const cs = getComputedStyle(fill);
  return { animation: cs.animationName, opacity: Number(cs.opacity),
    fills: fill.getBoundingClientRect().width / document.querySelector(".loading-bar").getBoundingClientRect().width };
});
console.log("reduced motion:", JSON.stringify(reduced));
ok(reduced.animation === "none", "a reduced-motion reader gets no animation at all — the global rule is honoured");
ok(reduced.fills > 0.9, `and the bar fills its track rather than sitting frozen part-way (${Math.round(reduced.fills * 100)}%)`);
ok(reduced.opacity < 0.8, `dimmed, so a full bar does not read as "finished" (opacity ${reduced.opacity})`);
await rctx.close();

await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL LOADING CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
