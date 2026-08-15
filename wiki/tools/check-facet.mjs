// FEEDBACK ON THE ONE THING YOU ARE LOOKING AT.
//
// Maintainer, 2026-08-14: "When I give feedback to an agent I can't do it on
// individual animations or individual states (in case of scenery). I would
// like the Scenery preview card and the animation card to have an
// accept/reject/rate/comment on individual animations/states. This has to be
// placed in the same card but UNDER the preview (since the entire entity is
// rated OVER the card)."
//
// Maintainer, same day again, on placement: "it's still under scenery preview.
// I said OVER the preview … I want it in the same card but OVER the preview",
// and "same in both Scenery and the Monsters/players. You placed it at the
// bottom of the card. I want it at the TOP of the card." So the order inside
// the card is: heading, judging block, state row, direction row, art.
//
// Maintainer, same day, sharpening it: "what I'm actually asking for is a
// feedback system on direction + state/animation. Not state/animation alone.
// This is because you can regenerate an animation for a direction. You don't
// regenerate for all directions … maybe the SE direction on the state
// LIGHTS_ON is bad."
//
// So the judged unit is ONE generated file: state × direction. The key is
// `<path>#<state>#<direction>`, and the row re-aims itself when either the
// state row or the direction pad is clicked.
//
// This gate NEVER presses Commit: it captures the save payload at the network
// boundary instead, so the maintainer's own review data is never written.
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

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
  // An admin reads the REPO, not the image (wiki.js useStagingRoot, 2026-08-14).
  // The sandbox blocks browser egress, so point the staging base at this same
  // server's /assets — the identical code path, resolvable offline.
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});

const facet = () => p.evaluate(() => {
  const f = document.querySelector(".facet-head");
  if (!f) return { present: false };
  const stage = document.querySelector(".player-stage")?.getBoundingClientRect();
  const head = document.querySelector(".detail-head .fb-row")?.getBoundingClientRect();
  const fr = f.getBoundingClientRect();
  return {
    present: true,
    // "Judging <state · direction>" moved above the selectors on 2026-08-14
    // ("can you put the Judging over the state/animation selection instead?"),
    // while the controls that act on it stayed under the preview.
    label: document.querySelector(".facet-head .facet-label")?.textContent ?? null,
    pill: document.querySelector(".facet-head .pill")?.textContent ?? null,
    headAboveStates: (() => {
      const head = document.querySelector(".facet-head")?.getBoundingClientRect();
      const seg = document.querySelector(".seg-states")?.getBoundingClientRect();
      return !!(head && seg && head.bottom <= seg.top + 2);
    })(),
    stageOffset: (() => {
      const st = document.querySelector(".player-stage");
      const pan = [...document.querySelectorAll(".panel")].find((x) => x.querySelector(".player-stage"));
      return st && pan ? Math.round(st.getBoundingClientRect().top - pan.getBoundingClientRect().top) : -1;
    })(),
    starBox: (() => { const b = document.querySelector(".stars button")?.getBoundingClientRect();
      return b ? { w: Math.round(b.width), h: Math.round(b.height) } : null; })(),
    stars: f.querySelectorAll(".stars button").length,
    approve: [...f.querySelectorAll("button")].some((x) => /approve/i.test(x.textContent)),
    reject: [...f.querySelectorAll("button")].find((x) => /✕/.test(x.textContent))?.textContent ?? null,
    comment: !!f.querySelector("textarea"),
    // The placement rule: the judging block is the FIRST thing under the
    // card's heading, above every control and above the art.
    overPreview: !!stage && fr.bottom <= stage.top,
    underTitle: (() => { const t = document.querySelector(".panel-title")?.getBoundingClientRect();
      return !!(t && fr.top >= t.bottom - 2); })(),
    // The old slot: anything still rendering there means it moved only halfway.
    nothingBelowStage: !document.querySelector(".facet-fb"),
    entityAbove: !!head && !!stage && head.bottom <= stage.top,
    sameCard: f.closest(".panel") === document.querySelector(".player-stage")?.closest(".panel"),
    verdictClasses: [...f.querySelectorAll("button")].map((x) => x.className).join("|"),
    facetName: document.querySelector(".seg-states button.on")?.textContent ?? null,
    dirOn: document.querySelector(".dirpad button.on")?.textContent ?? null,
  };
});

// ------------------------------------------------------------------ scenery
await p.goto(`${W}#/objects/window_058`, { waitUntil: "load" });
await p.waitForTimeout(1800);
const s1 = await facet();
const headBefore = await p.evaluate(() => [...document.querySelectorAll(".detail-head .fb-row button")].map((x) => x.className).join("|"));
console.log("scenery, Lights Off:", JSON.stringify(s1), "| piece verdict before:", JSON.stringify(headBefore));
ok(s1.present, "the scenery preview card carries a per-state feedback row");
ok(s1.sameCard, "in the SAME card as the art, not a panel of its own");
ok(s1.overPreview, "OVER the preview, not under it");
ok(s1.underTitle && s1.headAboveStates, "at the very top of the card — under the heading, above the state and direction rows");
ok(s1.nothingBelowStage, "and nothing of it is left below the art");
ok(s1.entityAbove, "while the whole-piece verdict stays above it, in the header");
ok(s1.stars === 5 && s1.approve && s1.comment, `with rate, accept and comment (${s1.stars} stars, approve=${s1.approve}, comment=${s1.comment})`);
ok(/redo/.test(s1.reject ?? ""), `and a reject that says what it means for ONE state (“${s1.reject}”)`);
ok(/Judging/.test(s1.label ?? ""), `labelled for what it judges (“${s1.label}”)`);
ok(s1.headAboveStates, "the label sits above the state/direction selectors");
// STARS BIG ENOUGH FOR A THUMB (maintainer 2026-08-14: "I also want all stars
// in the entire application to be a bit bigger, hard to click").
console.log("star hit box:", JSON.stringify(s1.starBox));
ok(s1.starBox && s1.starBox.w >= 28 && s1.starBox.h >= 32,
  `each star is a real tap target (${s1.starBox?.w}x${s1.starBox?.h}px)`);
// The chip is a variant number and a lamp now, not prose (2026-08-14): a
// window's unlit state reads "#1", its lit one "💡#1".
ok(s1.pill === "#1 · S", `and NAMES the one file it judges — state and direction (“${s1.pill}”)`);

// A VERDICT FOLLOWS THE STATE. Approving Lights Off must not colour Lights On.
await p.evaluate(() => [...document.querySelectorAll(".facet-head .fb-row button")].find((x) => /approve/.test(x.textContent)).click());
await p.waitForTimeout(250);
const afterApprove = await facet();
ok(/approved/.test(afterApprove.verdictClasses), "approving marks THIS state");
await p.evaluate(() => [...document.querySelectorAll(".seg-states button")].find((x) => /lights on/i.test(x.title)).click());
await p.waitForTimeout(500);
const s2 = await facet();
console.log("scenery, Lights On :", JSON.stringify({ facetName: s2.facetName, verdictClasses: s2.verdictClasses }));
ok(s2.facetName === "💡#1", `switching state switches what the row judges (${s2.facetName})`);
ok(!/approved/.test(s2.verdictClasses), "and the other state arrives unjudged — verdicts are per state, not per piece");
// THE DIRECTION IS HALF THE UNIT. Approving S must leave SE unjudged.
await p.evaluate(() => [...document.querySelectorAll(".seg-states button")].find((x) => /lights off/i.test(x.title)).click());
await p.waitForTimeout(400);
await p.evaluate(() => [...document.querySelectorAll(".dirpad button")].find((x) => x.textContent === "SE").click());
await p.waitForTimeout(400);
const sSE = await facet();
console.log("scenery, Lights Off · SE:", JSON.stringify({ pill: sSE.pill, dirOn: sSE.dirOn, verdictClasses: sSE.verdictClasses }));
ok(sSE.pill === "#1 · SE", `pressing a direction re-aims the row (“${sSE.pill}”)`);
ok(!/approved/.test(sSE.verdictClasses), "and SE is unjudged though S of the same state was approved");
await p.evaluate(() => [...document.querySelectorAll(".facet-head .fb-row button")].find((x) => /✕/.test(x.textContent)).click());
await p.waitForTimeout(250);
await p.evaluate(() => [...document.querySelectorAll(".dirpad button")].find((x) => x.textContent === "S").click());
await p.waitForTimeout(400);
const backS = await facet();
ok(/approved/.test(backS.verdictClasses), "coming back to S shows its own approval, not SE's rejection");
await p.evaluate(() => [...document.querySelectorAll(".seg-states button")].find((x) => /lights on/i.test(x.title)).click());
await p.waitForTimeout(400);
await p.evaluate(() => [...document.querySelectorAll(".facet-head .fb-row button")].find((x) => /✕/.test(x.textContent)).click());
await p.waitForTimeout(250);
const head = await p.evaluate(() => [...document.querySelectorAll(".detail-head .fb-row button")].map((x) => x.className).join("|"));
// UNCHANGED, not empty: the maintainer reviews these pieces for real, so this
// one may well carry his own approval and rating already. What must hold is
// that judging a facet moved none of it.
ok(head === headBefore, `and the PIECE's own verdict is untouched by either (“${headBefore}” → “${head}”)`);

// THE KEYS. What the agents read is `<path>#<facet>`, one entry per facet —
// the shape the monsters domain already understands.
await p.evaluate(() => [...document.querySelectorAll("#savebar button")].find((x) => /Commit/.test(x.textContent))?.click());
await p.waitForTimeout(1000);
const keys = Object.keys(posted[0]?.set ?? {});
console.log("saved keys:", JSON.stringify(posted[0] ?? null).slice(0, 300));
ok(posted.length === 1 && posted[0].file === "feedback/objects", `it saves into the domain's own feedback file (${posted[0]?.file})`);
ok(keys.length === 3, `three facets judged, three entries (${keys.length})`);
ok(keys.every((k) => /^scenery\/.+#(lights_on|lights_off)#(south|south-east|south-west)$/.test(k)),
  `each keyed <path>#<state>#<direction> (${keys.join(", ")})`);
ok(new Set(keys.map((k) => k.split("#")[1])).size === 2 && new Set(keys.map((k) => k.split("#")[2])).size === 2,
  "spanning two states and two directions — neither axis collapses into the other");
ok(new Set(keys.map((k) => k.split("#")[0])).size === 1, "both on the same piece, so the piece is not being rejected by proxy");
ok(!keys.includes("scenery/windows/window_058"), "and nothing was written against the piece itself");

// A LONE STATIC PIECE still gets the row — the states row always renders, so
// this must never become a page where the control disappears.
await p.goto(`${W}#/objects/mushroom_005`, { waitUntil: "load" });
await p.waitForTimeout(1600);
const lone = await facet();
console.log("lone static:", JSON.stringify({ label: lone.label, facetName: lone.facetName, underPreview: lone.underPreview }));
ok(lone.present && lone.overPreview && lone.underTitle, "a piece with only Static has it too, in the same place");
ok(lone.facetName === "Static" && lone.pill === "Static · S", `judging what is on screen (${lone.pill})`);

// ----------------------------------------------------- monsters + characters
// Same feature, same place, same words — this is one wiki.
for (const [url, what, expectFacet] of [[`${W}#/monsters/mammoth`, "monster", "Idle"], [`${W}#/characters/default_boy`, "character", null]]) {
  await p.goto(url, { waitUntil: "load" });
  await p.waitForTimeout(1800);
  const f = await facet();
  console.log(`${what}:`, JSON.stringify({ label: f.label, under: f.underPreview, same: f.sameCard, stars: f.stars, comment: f.comment, facetName: f.facetName }));
  ok(f.present && f.sameCard && f.overPreview && f.underTitle,
    `the ${what} animation card puts it at the top of the card too — "same in both Scenery and the Monsters/players"`);
  ok(f.nothingBelowStage, `and nothing of it hangs below the ${what}'s art`);
  ok(/Judging/.test(f.label ?? "") && /·/.test(f.pill ?? ""), `naming the animation AND the direction (“${f.pill}”) — it read as a whole-entity verdict before`);
  ok(f.headAboveStates, `and on the ${what} too the label leads the selectors`);
  ok(f.starBox.w >= 28 && f.starBox.h >= 32, `with the same big stars (${f.starBox.w}x${f.starBox.h}px)`);
  ok(f.stars === 5 && f.approve && f.comment, `rate, accept and comment on the ${what}'s animation as well`);
  if (expectFacet) ok(f.facetName === expectFacet, `pointed at the state on screen (${f.facetName})`);
  // Eight directions, eight separately regenerable files.
  const dirSwap = await p.evaluate(async () => {
    const before = document.querySelector(".facet-head .pill")?.textContent;
    [...document.querySelectorAll(".dirpad button")].find((x) => x.textContent === "NE")?.click();
    await new Promise((r) => setTimeout(r, 400));
    return { before, after: document.querySelector(".facet-head .pill")?.textContent };
  });
  ok(dirSwap.after !== dirSwap.before && /NE$/.test(dirSwap.after ?? ""),
    `and the ${what}'s row follows the direction pad too (${dirSwap.before} → ${dirSwap.after})`);
}

// The public sees none of this — it is a Game Master's tool.
const pub = await ctx.browser().newContext({ viewport: { width: 393, height: 851 } });
const pp = await pub.newPage();
await pp.goto(`${W}#/objects/window_058`, { waitUntil: "load" });
await pp.waitForTimeout(1700);
ok(!(await pp.evaluate(() => !!document.querySelector(".facet-head"))), "and a visitor never sees it");
await pub.close();

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL FACET-FEEDBACK CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
