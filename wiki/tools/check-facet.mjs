// FEEDBACK ON THE ONE THING YOU ARE LOOKING AT.
//
// Maintainer, 2026-08-14: "When I give feedback to an agent I can't do it on
// individual animations or individual states (in case of scenery). I would
// like the Scenery preview card and the animation card to have an
// accept/reject/rate/comment on individual animations/states. This has to be
// placed in the same card but UNDER the preview (since the entire entity is
// rated OVER the card)."
//
// A verdict on a whole creature cannot say "the die animation is wrong, the
// rest is fine", and a verdict on a whole scenery piece cannot say "LIGHTS_ON
// came out wrong, keep the piece". The key convention is `<path>#<facet>` —
// the monster and character pages have used it since 2026-07-30; the scenery
// page gained it today, and all three now say in words what they judge.
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
await p.addInitScript(() => localStorage.setItem("wiki-admin-token", "gate"));

const facet = () => p.evaluate(() => {
  const f = document.querySelector(".facet-fb");
  if (!f) return { present: false };
  const stage = document.querySelector(".player-stage")?.getBoundingClientRect();
  const head = document.querySelector(".detail-head .fb-row")?.getBoundingClientRect();
  const fr = f.getBoundingClientRect();
  return {
    present: true,
    label: f.querySelector(".facet-label")?.textContent ?? null,
    stars: f.querySelectorAll(".stars button").length,
    approve: [...f.querySelectorAll("button")].some((x) => /approve/i.test(x.textContent)),
    reject: [...f.querySelectorAll("button")].find((x) => /✕/.test(x.textContent))?.textContent ?? null,
    comment: !!f.querySelector("textarea"),
    // The two halves of the maintainer's placement rule.
    underPreview: !!stage && fr.top >= stage.bottom - 1,
    entityAbove: !!head && !!stage && head.bottom <= stage.top,
    sameCard: f.closest(".panel") === document.querySelector(".player-stage")?.closest(".panel"),
    verdictClasses: [...f.querySelectorAll("button")].map((x) => x.className).join("|"),
    facetName: document.querySelector(".seg-states button.on")?.textContent ?? null,
  };
});

// ------------------------------------------------------------------ scenery
await p.goto(`${W}#/objects/window_058`, { waitUntil: "load" });
await p.waitForTimeout(1800);
const s1 = await facet();
console.log("scenery, Lights Off:", JSON.stringify(s1));
ok(s1.present, "the scenery preview card carries a per-state feedback row");
ok(s1.sameCard, "in the SAME card as the art, not a panel of its own");
ok(s1.underPreview, "under the preview");
ok(s1.entityAbove, "while the whole-piece verdict stays above it, in the header");
ok(s1.stars === 5 && s1.approve && s1.comment, `with rate, accept and comment (${s1.stars} stars, approve=${s1.approve}, comment=${s1.comment})`);
ok(/redo/.test(s1.reject ?? ""), `and a reject that says what it means for ONE state (“${s1.reject}”)`);
ok(/^This state:/.test(s1.label ?? ""), `labelled for what it judges (“${s1.label}”)`);

// A VERDICT FOLLOWS THE STATE. Approving Lights Off must not colour Lights On.
await p.evaluate(() => [...document.querySelectorAll(".facet-fb button")].find((x) => /approve/.test(x.textContent)).click());
await p.waitForTimeout(250);
const afterApprove = await facet();
ok(/approved/.test(afterApprove.verdictClasses), "approving marks THIS state");
await p.evaluate(() => [...document.querySelectorAll(".seg-states button")].find((x) => /On/.test(x.textContent)).click());
await p.waitForTimeout(500);
const s2 = await facet();
console.log("scenery, Lights On :", JSON.stringify({ facetName: s2.facetName, verdictClasses: s2.verdictClasses }));
ok(s2.facetName === "Lights On", `switching state switches what the row judges (${s2.facetName})`);
ok(!/approved/.test(s2.verdictClasses), "and the other state arrives unjudged — verdicts are per state, not per piece");
await p.evaluate(() => [...document.querySelectorAll(".facet-fb button")].find((x) => /✕/.test(x.textContent)).click());
await p.waitForTimeout(250);
const head = await p.evaluate(() => [...document.querySelectorAll(".detail-head .fb-row button")].map((x) => x.className).join("|"));
ok(!/approved|rejected/.test(head), `and the PIECE's own verdict is untouched by either (“${head}”)`);

// THE KEYS. What the agents read is `<path>#<facet>`, one entry per facet —
// the shape the monsters domain already understands.
await p.evaluate(() => [...document.querySelectorAll("#savebar button")].find((x) => /Commit/.test(x.textContent))?.click());
await p.waitForTimeout(1000);
const keys = Object.keys(posted[0]?.set ?? {});
console.log("saved keys:", JSON.stringify(posted[0] ?? null).slice(0, 300));
ok(posted.length === 1 && posted[0].file === "feedback/objects", `it saves into the domain's own feedback file (${posted[0]?.file})`);
ok(keys.length === 2, `two facets judged, two entries (${keys.length})`);
ok(keys.every((k) => /^scenery\/.+#(lights_on|lights_off)$/.test(k)), `each keyed <path>#<state> (${keys.join(", ")})`);
ok(new Set(keys.map((k) => k.split("#")[0])).size === 1, "both on the same piece, so the piece is not being rejected by proxy");
ok(!keys.includes("scenery/windows/window_058"), "and nothing was written against the piece itself");

// A LONE STATIC PIECE still gets the row — the states row always renders, so
// this must never become a page where the control disappears.
await p.goto(`${W}#/objects/mushroom_005`, { waitUntil: "load" });
await p.waitForTimeout(1600);
const lone = await facet();
console.log("lone static:", JSON.stringify({ label: lone.label, facetName: lone.facetName, underPreview: lone.underPreview }));
ok(lone.present && lone.underPreview, "a piece with only Static has it too");
ok(lone.facetName === "Static", `judging the state that is on screen (${lone.facetName})`);

// ----------------------------------------------------- monsters + characters
// Same feature, same place, same words — this is one wiki.
for (const [url, what, expectFacet] of [[`${W}#/monsters/mammoth`, "monster", "Idle"], [`${W}#/characters/default_boy`, "character", null]]) {
  await p.goto(url, { waitUntil: "load" });
  await p.waitForTimeout(1800);
  const f = await facet();
  console.log(`${what}:`, JSON.stringify({ label: f.label, under: f.underPreview, same: f.sameCard, stars: f.stars, comment: f.comment, facetName: f.facetName }));
  ok(f.present && f.sameCard && f.underPreview, `the ${what} animation card has the row under the preview too`);
  ok(/^This animation:/.test(f.label ?? ""), `and says so in words (“${f.label}”) — it read as a second whole-entity verdict before`);
  ok(f.stars === 5 && f.approve && f.comment, `rate, accept and comment on the ${what}'s animation as well`);
  if (expectFacet) ok(f.facetName === expectFacet, `pointed at the state on screen (${f.facetName})`);
}

// The public sees none of this — it is a Game Master's tool.
const pub = await ctx.browser().newContext({ viewport: { width: 393, height: 851 } });
const pp = await pub.newPage();
await pp.goto(`${W}#/objects/window_058`, { waitUntil: "load" });
await pp.waitForTimeout(1700);
ok(!(await pp.evaluate(() => !!document.querySelector(".facet-fb"))), "and a visitor never sees it");
await pub.close();

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL FACET-FEEDBACK CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
