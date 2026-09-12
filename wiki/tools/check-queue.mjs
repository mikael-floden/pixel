#!/usr/bin/env node
/* HIS THUMB DOES NOT MOVE (maintainer 2026-09-12, on a ground's detail queue:
 * "if I press approve the already reviewed element is moved down instead of the
 * next item to review moving up. This means I have to scroll before I can press
 * approve again. This takes time. I want to be able to not move my thumb and
 * press approve/not a detail on the exact same place over and over again until
 * everything is reviewed.")
 *
 * A verdict used to re-render the page: the judged top joined the collection
 * ABOVE, which is a card taller, so the queue and every button in it slid down
 * a card. Now the judged card is removed where it stands and the next one rises
 * into its place — so the button he just tapped is still under his thumb.
 *
 *   node wiki/tools/serve-assets.mjs 8902
 *   node wiki/tools/check-queue.mjs
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
const SANDBOX = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const EXE = process.env.CHROMIUM_PATH || (existsSync(SANDBOX) ? SANDBOX : "");
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const DATA = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? "ok" : "FAIL"}: ${msg}`); if (!c) fails++; };

const b = await chromium.launch(EXE ? { executablePath: EXE } : {});
const ctx = await b.newContext({ viewport: { width: 393, height: 850 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});

// A ground with something left to judge — the queue is his, so the gate has to
// find one rather than assume the first ground has any.
const tops = [...new Set((DATA.domains?.world ?? []).map((c) => c.top))];
let ground = null;
for (const top of tops) {
  await p.goto(`${W}#/world/${top}`, { waitUntil: "load" });
  await p.waitForTimeout(2400);
  await p.evaluate(() => [...document.querySelectorAll("button, .sortbar-btn")].find((x) => /^Details/.test(x.textContent.trim()))?.click());
  await p.waitForTimeout(1600);
  if (await p.evaluate(() => document.querySelectorAll(".detail-queue .detail-card").length) >= 4) { ground = top; break; }
}
if (!ground) { console.log("no ground has an unjudged queue right now — nothing to drive"); await b.close(); process.exit(0); }
console.log(`driving ${ground}`);

/** The first queue card's verdict button, put at a fixed place on screen. */
const aim = async () => {
  await p.evaluate(() => document.querySelector(".detail-queue .detail-card")?.scrollIntoView({ block: "center" }));
  await p.waitForTimeout(250);
  return p.evaluate(() => {
    const btn = document.querySelector(".detail-queue .detail-card .verdict button");
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      count: document.querySelector(".detail-queue-count")?.textContent,
      cards: document.querySelectorAll(".detail-queue .detail-card").length,
      which: document.querySelector(".detail-queue .detail-card .card-sub")?.textContent?.trim() };
  });
};
const first = await aim();
console.log("aimed at:", JSON.stringify(first));

// THE BUTTONS SIT ON THE RIGHT, where a hand holding a phone already is
// (maintainer 2026-09-12: "Can you right align the approve/not a detail button
// and rename 'not a detail' to just 'remove'?"). The stars keep the left.
const row = await p.evaluate(() => {
  const card = document.querySelector(".detail-queue .detail-card");
  const v = card.querySelector(".judge-right .verdict");
  const cr = card.getBoundingClientRect(), vr = v.getBoundingClientRect();
  const stars = card.querySelector(".judge-right .fb-row > *").getBoundingClientRect();
  return { labels: [...v.querySelectorAll("button")].map((x) => x.textContent.trim()),
    gapRight: Math.round(cr.right - vr.right), gapLeft: Math.round(vr.left - cr.left),
    starsFromLeft: Math.round(stars.left - cr.left) };
});
console.log("row:", JSON.stringify(row));
ok(row.labels.join(" ") === "✓ approve ✕ remove", `the verdict reads approve and remove (${row.labels.join(" | ")})`);
ok(row.gapRight < row.gapLeft, `and sits against the card's right edge (${row.gapRight}px from it, ${row.gapLeft}px from the left)`);
ok(row.starsFromLeft < row.gapLeft, `while the stars keep the left (${row.starsFromLeft}px in)`);
const seen = [first];
for (let i = 0; i < 3; i++) {
  // TAP THE SAME SPOT — not the same element. That is the whole point.
  await p.mouse.click(first.x, first.y);
  await p.waitForTimeout(600);
  seen.push(await p.evaluate(() => {
    const btn = document.querySelector(".detail-queue .detail-card .verdict button");
    const r = btn?.getBoundingClientRect();
    return { x: r ? Math.round(r.left + r.width / 2) : null, y: r ? Math.round(r.top + r.height / 2) : null,
      count: document.querySelector(".detail-queue-count")?.textContent,
      cards: document.querySelectorAll(".detail-queue .detail-card").length,
      which: document.querySelector(".detail-queue .detail-card .card-sub")?.textContent?.trim() };
  }));
}
console.log("after each tap:", JSON.stringify(seen.slice(1)));
ok(seen.every((s) => s.x === first.x && s.y === first.y),
  `the next card's button lands on the same pixel every time (${seen.map((s) => `${s.x},${s.y}`).join(" → ")})`);
ok(new Set(seen.map((s) => s.which)).size === seen.length,
  `and each tap judges a DIFFERENT top (${seen.map((s) => s.which?.slice(-2)).join(" → ")})`);
ok(seen[seen.length - 1].cards === first.cards - 3, `three verdicts took three cards out of the queue (${first.cards} → ${seen[seen.length - 1].cards})`);
ok(Number(seen[seen.length - 1].count) === Number(first.count) - 3, `and the queue's count says so (${first.count} → ${seen[seen.length - 1].count})`);
const pend = await p.evaluate(() => Object.values(window.__wiki.state.touched).reduce((n, s) => n + s.size, 0));
ok(pend === 3, `three taps, three pending verdicts — no tap was swallowed or doubled (${pend})`);

// THE QUEUE GROWS AT THE BOTTOM BY ITSELF, and nothing above it moves
// (maintainer 2026-09-12: "Can you automatically expand and show more once I'm
// at the bottom ... It's also important that the approve/remove button stay on
// same place after automatic expand. The expand at the end is also a bit slow
// now since the page is very big and starts to lag.")
const nCards = () => p.evaluate(() => document.querySelectorAll(".detail-queue .detail-card").length);
const grew = [await nCards()];
for (let i = 0; i < 2; i++) {
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForTimeout(1200);
  grew.push(await nCards());
}
console.log("queue grew:", JSON.stringify(grew));
ok(grew[grew.length - 1] > grew[0], `scrolling to the bottom pulls the next cards in with no button pressed (${grew.join(" → ")})`);

await p.evaluate(() => document.querySelector(".detail-queue .detail-card")?.scrollIntoView({ block: "center" }));
await p.waitForTimeout(400);
const btnAt = () => p.evaluate(() => {
  const r = document.querySelector(".detail-queue .detail-card .verdict button").getBoundingClientRect();
  return `${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)}`;
});
const beforeExpand = await btnAt();
const nBefore = await nCards();
await p.evaluate(() => document.querySelector(".queue-more")?.click());
await p.waitForTimeout(900);
const afterExpand = await btnAt();
ok(beforeExpand === afterExpand && (await nCards()) > nBefore,
  `and an expand moves nothing already on screen (button at ${beforeExpand} → ${afterExpand}, ${nBefore} → ${await nCards()} cards)`);

// ...and the fields are drawn as they come near, not all at once: that is the
// lag he felt on a page hundreds of cards long.
const fields = await p.evaluate(() => ({
  total: document.querySelectorAll(".detail-card .iso-stage").length,
  drawn: [...document.querySelectorAll(".detail-card .iso-stage")].filter((s) => s.querySelector("canvas")).length,
}));
console.log("fields:", JSON.stringify(fields));
ok(fields.drawn < fields.total, `only the fields near the screen are drawn (${fields.drawn} of ${fields.total})`);

console.log(`page errors: ${errors.length ? errors.join(" | ").slice(0, 200) : "none"}`);
ok(!errors.length, "no page errors");
await b.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL QUEUE CHECKS PASSED");
process.exit(fails ? 1 : 0);
