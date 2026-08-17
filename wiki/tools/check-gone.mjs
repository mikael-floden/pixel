// A PIECE THE AGENT ALREADY DELETED MUST READ AS "REMOVED", NOT AS A BROKEN IMAGE.
//
// Maintainer, 2026-08-15, looking at the Scenery overview with the REJECTED
// filter on: "Why doesn't the rejected Scenery render?" — three cards, three
// broken <img>s with their alt text sprawling across the card.
//
// It was not a rendering bug. The wiki was built at 79c1ae3e5 (16:59); at
// 17:33 the scenery agent committed "remove 3 rejected piece(s) (wiki
// verdicts)" and deleted exactly those three. An ADMIN reads art from HEAD of
// main (stagingSha — reviewing art that is not in the game yet is the whole
// point) while the piece list is the DEPLOYED build, so the manifest lists a
// piece whose file is gone. Verified against GitHub at the time: the sprite
// was 200 at the deployed sha and 404 on main.
//
// The REJECTED filter is where this happens every single time, because a
// rejection IS the instruction to delete the piece. So a 404 there is the
// contract WORKING.
//
// ROUND 2 (maintainer 2026-08-16, three "removed" cards sitting in his
// partly-reviewed filter): "Why is the object not removed then removed? Why do
// I still see it but as removed?" He is right — a card he cannot open, judge
// or look at is not information, it is an obstacle between him and the pieces
// he CAN review. A 404'd piece now LEAVES the wiki: dropped from the loaded
// manifest, so counts, chips, filters and the ‹ › pager all agree. The
// tombstone survives only for the other case — art that failed to load without
// a 404 — where the piece is not known to be gone at all.
//
// The gate reproduces it the only honest way — by making the art 404 at the
// network boundary, exactly as a deleted file does.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const DATA = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const objs = DATA.domains.objects.filter((o) => o.preview);
const GONE = objs[0], BROKE = objs[1];   // one "deleted", one that simply fails
console.log(`deleted piece: ${GONE.id} (${GONE.preview})`);
console.log(`failing piece: ${BROKE.id} (${BROKE.preview})`);

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
// The deleted one 404s like a file that is not there; the other one fails the
// way a flaky CDN does. The wiki must tell these two apart — see below.
await p.route(`**/${GONE.preview}`, (r) => r.fulfill({ status: 404, body: "" }));
await p.route(`**/${BROKE.preview}`, (r) => r.abort("connectionfailed"));

const cards = () => p.evaluate(([gone, broke]) => {
  const of = (id) => {
    const a = document.querySelector(`a.card[href="#/objects/${id}"]`);
    if (!a) return null;
    const t = a.querySelector(".thumb");
    const note = t?.querySelector(".art-note");
    return {
      present: true,
      imgs: t ? t.querySelectorAll("img").length : -1,
      // A broken <img> is exactly what the maintainer photographed: the alt
      // text rendered as page copy, at whatever width the card allows.
      altText: [...(t?.querySelectorAll("img") ?? [])].map((i) => i.alt).join("|"),
      gone: !!t?.classList.contains("art-gone"),
      failed: !!t?.classList.contains("art-failed"),
      note: note?.textContent ?? null,
      noteColor: note ? getComputedStyle(note).color : null,
      thumbH: t ? Math.round(t.getBoundingClientRect().height) : -1,
      name: a.querySelector(".card-name")?.textContent ?? null,
      linkWorks: !!a.getAttribute("href"),
    };
  };
  const chipNum = (re) => {
    const b = [...document.querySelectorAll("button")].find((x) => re.test(x.textContent.trim()));
    return b ? Number(/(\d+)\s*$/.exec(b.textContent.trim())?.[1] ?? NaN) : null;
  };
  return {
    gone: of(gone), broke: of(broke),
    pageBg: getComputedStyle(document.body).backgroundColor,
    // What the page CLAIMS versus what it draws: a piece dropped from the
    // manifest but still counted would read as "19 of 828" over 17 cards.
    counts: { shown: document.querySelectorAll("a.card").length, claimed: chipNum(/^all \d+$/) },
    chip: chipNum(/^all \d+$/),
  };
}, [GONE.id, BROKE.id]);

await p.goto(`${W}#/objects`, { waitUntil: "load" });
await p.waitForTimeout(3200);
const c = await cards();
console.log("deleted card:", JSON.stringify(c.gone));
console.log("failing card:", JSON.stringify(c.broke));

ok(c.gone === null, "a piece whose art 404s is GONE from the list, not left as a tombstone");
ok(c.counts && c.counts.shown === c.counts.claimed,
  `and the count follows it out — the page says ${c.counts?.claimed} and shows ${c.counts?.shown}`);
ok(c.chip !== null && c.chip < DATA.domains.objects.length,
  `and the chip counts what is really there, below the build's own total (${c.chip} of ${DATA.domains.objects.length} listed)`);

// IT STAYS GONE. A re-render, a page turn or a Back must not resurrect it —
// the session remembers, so he never meets the same dead card twice.
await p.goto(`${W}#/monsters`, { waitUntil: "load" });
await p.waitForTimeout(1200);
await p.goto(`${W}#/objects`, { waitUntil: "load" });
await p.waitForTimeout(2000);
const again = await cards();
console.log("after navigating away and back:", JSON.stringify({ gone: again.gone, counts: again.counts }));
ok(again.gone === null, "navigating away and back does not bring it back");
ok(again.counts.shown === again.counts.claimed, `and the count is still honest (${again.counts.claimed})`);

// TELLING THE TWO APART IS THE POINT. "Gone" removes a piece from his review
// queue; saying it because a CDN blinked would silently hide real work. Judged
// here, once the drops have settled — the first drop re-renders the list,
// which re-requests this card's image.
console.log("failing card:", JSON.stringify(again.broke));
ok(!!again.broke?.present, "a load that fails WITHOUT a 404 keeps its card — the piece is not known to be gone");
ok(again.broke?.failed === true && again.broke?.gone === false, `and is not called removed (failed=${again.broke?.failed}, gone=${again.broke?.gone})`);
ok(/not loading/.test(again.broke?.note ?? ""), `it says the art did not load (“${again.broke?.note}”)`);
ok(again.broke?.imgs === 0, "with no broken image left in the frame");
ok(again.broke?.thumbH >= 90, `keeping the art's height, so the grid does not reflow (${again.broke?.thumbH}px)`);

// THE WHOLE REASON HE FOUND THIS: the rejected filter is where deleted pieces
// live, and it is admin-only. So this half signs in — faked at the network
// boundary, never touching the real session — and lands on the exact view in
// his screenshot.
const p2 = await ctx.newPage();
const errs2 = []; p2.on("pageerror", (e) => errs2.push(String(e)));
await p2.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p2.route(`**/${GONE.preview}`, (r) => r.fulfill({ status: 404, body: "" }));
await p2.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});
await p2.goto(`${W}#/objects`, { waitUntil: "load" });
await p2.waitForTimeout(2600);
const chip = await p2.evaluate(() => {
  const c = [...document.querySelectorAll("button")].find((x) => /^rejected \d+$/i.test(x.textContent.trim()));
  c?.click();
  return c?.textContent?.trim() ?? null;
});
await p2.waitForTimeout(3000);
const onRejected = await p2.evaluate(() => ({
  cards: document.querySelectorAll("a.card").length,
  // A broken <img> is one that finished loading with no pixels — precisely
  // what his screenshot showed, and what must never survive.
  broken: [...document.querySelectorAll("a.card .thumb img")].filter((i) => i.complete && i.naturalWidth === 0).length,
  marked: document.querySelectorAll("a.card .thumb.art-gone, a.card .thumb.art-failed").length,
  claimed: Number(/(\d+)\s*$/.exec([...document.querySelectorAll("button")].find((x) => /^rejected \d+$/i.test(x.textContent.trim()))?.textContent.trim() ?? "")?.[1] ?? NaN),
}));
console.log("rejected chip:", JSON.stringify(chip), "->", JSON.stringify(onRejected));
ok(!!chip, `the rejected filter is reachable as admin (\u201c${chip}\u201d)`);
ok(onRejected.cards > 0, `and it lists his rejected pieces (${onRejected.cards})`);
ok(onRejected.broken === 0, `with NO broken image left on it (${onRejected.broken})`);
ok(onRejected.cards === onRejected.claimed,
  `and the chip agrees with the grid once the deleted ones have dropped out (${onRejected.claimed} claimed, ${onRejected.cards} shown)`);
ok(errs2.length === 0, `no page errors as admin (${errs2.slice(0, 2).join(" | ") || "none"})`);

// DARK MODE — the note has to be legible on the theme he reviews in.
await p.evaluate(() => { localStorage.setItem("wiki-theme", "dark"); document.documentElement.setAttribute("data-theme", "dark"); });
await p.goto(`${W}#/objects`, { waitUntil: "load" });
await p.waitForTimeout(3200);
const dark = await cards();
const lum = (c) => { const [r, g, bl] = c.match(/\d+/g).map(Number).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
const contrast = (a, bg) => { const [l1, l2] = [lum(a), lum(bg)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
const ratio = dark.broke?.noteColor && dark.pageBg ? contrast(dark.broke.noteColor, dark.pageBg) : 0;
console.log("dark:", JSON.stringify({ note: dark.broke?.note, color: dark.broke?.noteColor, bg: dark.pageBg, ratio: +ratio.toFixed(1) }));
ok(dark.gone === null, "the deleted piece is gone on the dark theme too");
ok(dark.broke?.failed === true && /not loading/.test(dark.broke?.note ?? ""), "and the not-loading note still appears there");
ok(ratio >= 3, `legible on the theme he reviews in (${ratio.toFixed(1)}:1)`);

// ------------------------------------------- A SECTION CANNOT DELETE ITSELF
// Measured 2026-08-17: the tiles agent moved a path in their manifest, the
// wiki's live World refresh double-prefixed it, and EVERY card 404'd. This
// function believed all of them and the section read "0 pairs" — reported as
// "can't see the tiles in the wiki". Losing a piece to a deletion is the
// feature; losing a section is always a bug, and the honest failure is the
// per-card "not loading" state, which says where to look.
const wipe = await ctx.newPage();
const wipeWarn = [];
wipe.on("console", (m) => { if (m.type() === "warning") wipeWarn.push(m.text()); });
await wipe.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":false}' }));
// Every piece of scenery art 404s at once — a broken path, not a purge.
await wipe.route("**/scenery/**", (r) => r.fulfill({ status: 404, body: "" }));
await wipe.addInitScript(() => { localStorage.removeItem("wiki-admin-token"); sessionStorage.clear(); });
await wipe.goto(`${W}#/objects`, { waitUntil: "load" });
await wipe.waitForTimeout(2000);
for (let i = 0, last = -1; i < 10; i++) {
  await wipe.evaluate(() => document.querySelectorAll('img[loading="lazy"]').forEach((im) => { im.loading = "eager"; }));
  await wipe.waitForTimeout(500);
  const n = await wipe.evaluate(() => document.querySelectorAll("a.card").length);
  if (n === last) break;
  last = n;
}
const after = await wipe.evaluate(() => ({
  cards: document.querySelectorAll("a.card").length,
  failed: document.querySelectorAll(".thumb.art-failed, .thumb.art-gone").length,
}));
const total = DATA.domains.objects.length;
console.log("whole-domain 404:", JSON.stringify({ ...after, listed: total, warned: wipeWarn.length }));
ok(after.cards > total * 0.5, `the section survives (${after.cards} of ${total} still listed, not 0)`);
ok(after.failed > 0, `and says so on the cards it cannot draw (${after.failed} marked)`);
ok(wipeWarn.some((w) => /not loading|404|paths/i.test(w)), `with a console warning naming the real cause (“${(wipeWarn[0] ?? "").slice(0, 90)}”)`);

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nFAILED ${fails.length}` : "\nAll good.");
process.exit(fails.length ? 1 : 0);
