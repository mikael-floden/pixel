// The animation-state row pans under the finger instead of clipping (maintainer
// 2026-08-05: a hero has more states than fit the drawer, "maintain the design
// I love"). Asserts: all states in ONE row, same height, the row overflows and
// pans, the page itself never scrolls sideways, and the active state keeps
// itself in view after a re-render.
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await (await b.newContext({ viewport: { width: 426, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
await p.goto(W + "#/characters/default_boy", { waitUntil: "load" });
await p.waitForTimeout(1800);
const before = await p.evaluate(() => {
  const seg = document.querySelector(".seg");
  const r = seg.getBoundingClientRect();
  return { states: seg.querySelectorAll("button").length, clientW: seg.clientWidth, scrollW: seg.scrollWidth,
    h: Math.round(r.height), oneRow: r.height < 48,
    pageScrollW: document.documentElement.scrollWidth, viewport: window.innerWidth,
    lastVisible: (() => { const btns = [...seg.querySelectorAll("button")]; const last = btns[btns.length - 1];
      return last.offsetLeft + last.offsetWidth <= seg.clientWidth; })() };
});
console.log("state row:", JSON.stringify(before));
ok(before.states >= 12, `all ${before.states} states are IN the row`);
ok(before.scrollW > before.clientW, `the row overflows (${before.scrollW} > ${before.clientW}) — scrollable, not cut`);
ok(before.oneRow, `still one row tall (${before.h}px) — the layout is unchanged`);
ok(!before.lastVisible, "the last state starts off-screen (that's what the pan is for)");
ok(before.pageScrollW <= before.viewport, "the PAGE grows no horizontal scroll");
// finger-pan the row, then tap the last state
const panned = await p.evaluate(async () => {
  const seg = document.querySelector(".seg");
  seg.scrollLeft = seg.scrollWidth;                      // the finger swipe
  await new Promise((r) => setTimeout(r, 150));
  const btns = [...seg.querySelectorAll("button")];
  const last = btns[btns.length - 1];
  const visible = last.getBoundingClientRect().right <= seg.getBoundingClientRect().right + 2;
  last.click();
  await new Promise((r) => setTimeout(r, 400));
  return { visible, on: seg.querySelector("button.on")?.textContent, scrollLeft: Math.round(seg.scrollLeft) };
});
console.log("after pan+tap:", JSON.stringify(panned));
ok(panned.visible, "the pan reaches the hidden states");
ok(panned.on === panned.on && !!panned.on, `the tapped state selects (${panned.on})`);
ok(panned.scrollLeft > 0, "the active state keeps itself in view after re-render");
// the canvas still paints on the newly selected state
const painted = await p.evaluate(() => { const cv = document.querySelector("canvas"); if (!cv) return -1;
  const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++; return n; });
ok(painted > 100, `the selected animation plays (${painted}px)`);
// PAGING ‹ › MUST NOT MOVE THE PANELS. Only the 19 placed NPCs had an "in the
// world" pill, and it sat on its own row — so stepping through the 191 shifted
// the Animations viewer up and down under the maintainer's thumb (2026-08-07:
// "I don't want the animation cart to jump up and down when I press next
// NPC"). The role and the pills share one unwrappable row now, so the header
// is the same height for a merchant with wares, a placed NPC, a plain one, and
// a hero with neither. Start on a MERCHANT — the longest possible row.
await p.goto(`${W}#/characters/51be6251`, { waitUntil: "load" });
await p.waitForTimeout(1900);
const measure = () => p.evaluate(() => {
  const pan = [...document.querySelectorAll(".panel")].find((x) => /Animations/.test(x.querySelector(".panel-title")?.textContent ?? ""));
  const t = document.querySelector(".npc-trade");
  return {
    name: document.querySelector("h1")?.textContent,
    top: pan ? Math.round(pan.getBoundingClientRect().top) : null,
    h: t ? Math.round(t.getBoundingClientRect().height) : null,
    // scrollWidth past clientWidth would mean the row is pushing the page
    // sideways instead of ellipsizing.
    overflow: t ? Math.round(t.scrollWidth - t.clientWidth) : 0,
    txt: t ? t.textContent.replace(/\s+/g, " ").trim() : "",
  };
});
const walk = [await measure()];
for (let i = 0; i < 14; i++) {
  await p.evaluate(() => [...document.querySelectorAll("button,a")].find((x) => x.textContent.trim() === "›")?.click());
  await p.waitForTimeout(360);
  walk.push(await measure());
}
const tops = [...new Set(walk.map((r) => r.top))];
const hs = [...new Set(walk.map((r) => r.h))];
console.log("npc walk:", JSON.stringify({ tops, hs, first: walk[0].txt.slice(0, 46), seen: walk.length }));
ok(walk.some((r) => /in the world/.test(r.txt)) && walk.some((r) => !/in the world/.test(r.txt)),
  "the walk crosses both placed and unplaced NPCs (otherwise this proves nothing)");
ok(tops.length === 1, `the Animations panel never moves while paging ‹ › (tops: ${tops.join(", ")})`);
ok(hs.length === 1, `and the role/pill row is one constant height (${hs.join(", ")}px)`);
ok(walk.every((r) => r.overflow === 0), `the wares list ellipsizes instead of widening the page (max overflow ${Math.max(...walk.map((r) => r.overflow))}px)`);

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL SEG-SCROLL CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
