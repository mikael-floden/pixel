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
// contract WORKING, and the card should say so.
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
  return { gone: of(gone), broke: of(broke), pageBg: getComputedStyle(document.body).backgroundColor };
}, [GONE.id, BROKE.id]);

await p.goto(`${W}#/objects`, { waitUntil: "load" });
await p.waitForTimeout(2600);
const c = await cards();
console.log("deleted card:", JSON.stringify(c.gone));
console.log("failing card:", JSON.stringify(c.broke));

ok(c.gone?.present, "the deleted piece is still listed — the manifest is what it is");
ok(c.gone?.imgs === 0, `and its broken image is GONE from the card (${c.gone?.imgs} img elements)`);
ok(!c.gone?.altText, `so no alt text sprawls across it (“${c.gone?.altText}”)`);
ok(c.gone?.gone === true, "the frame is marked as removed art");
ok(/removed/.test(c.gone?.note ?? ""), `with a note that says what happened (“${c.gone?.note}”)`);
ok(/acted on this/.test(c.gone?.note ?? ""), "and reads as the agent having done what he asked, not as an error");
ok(c.gone?.name === GONE.name, "the piece's name still reads normally, so the card is still a card");
ok(c.gone?.linkWorks, "and it still opens — the verdict and notes on it are not lost");
ok(c.gone?.thumbH >= 90, `the frame keeps the art's height, so the grid does not reflow (${c.gone?.thumbH}px)`);

// TELLING THE TWO APART IS THE POINT. "Removed" is a claim about the agent
// having acted; saying it because a CDN blinked would be a lie he acts on.
ok(c.broke?.failed === true && c.broke?.gone === false,
  `a load that fails WITHOUT a 404 is not called removed (failed=${c.broke?.failed}, gone=${c.broke?.gone})`);
ok(/not loading/.test(c.broke?.note ?? ""), `it says the art did not load (“${c.broke?.note}”)`);
ok(c.broke?.imgs === 0, "and it drops its broken image too");

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
await p2.waitForTimeout(1500);
const onRejected = await p2.evaluate(() => ({
  cards: document.querySelectorAll("a.card").length,
  // A broken <img> is one that finished loading with no pixels — precisely
  // what his screenshot showed, and what must never survive.
  broken: [...document.querySelectorAll("a.card .thumb img")].filter((i) => i.complete && i.naturalWidth === 0).length,
  marked: document.querySelectorAll("a.card .thumb.art-gone, a.card .thumb.art-failed").length,
}));
console.log("rejected chip:", JSON.stringify(chip), "->", JSON.stringify(onRejected));
ok(!!chip, `the rejected filter is reachable as admin (\u201c${chip}\u201d)`);
ok(onRejected.cards > 0, `and it lists his rejected pieces (${onRejected.cards})`);
ok(onRejected.broken === 0, `with NO broken image left on it (${onRejected.broken})`);
ok(errs2.length === 0, `no page errors as admin (${errs2.slice(0, 2).join(" | ") || "none"})`);

// DARK MODE — the note has to be legible on the theme he reviews in.
await p.evaluate(() => { localStorage.setItem("wiki-theme", "dark"); document.documentElement.setAttribute("data-theme", "dark"); });
await p.goto(`${W}#/objects`, { waitUntil: "load" });
await p.waitForTimeout(2400);
const dark = await cards();
const lum = (c) => { const [r, g, bl] = c.match(/\d+/g).map(Number).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
const contrast = (a, bg) => { const [l1, l2] = [lum(a), lum(bg)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
const ratio = dark.gone?.noteColor && dark.pageBg ? contrast(dark.gone.noteColor, dark.pageBg) : 0;
console.log("dark:", JSON.stringify({ note: dark.gone?.note, color: dark.gone?.noteColor, bg: dark.pageBg, ratio: +ratio.toFixed(1) }));
ok(dark.gone?.gone === true && /removed/.test(dark.gone?.note ?? ""), "the same note appears on the dark theme");
ok(ratio >= 3, `and it is legible there (${ratio.toFixed(1)}:1)`);

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nFAILED ${fails.length}` : "\nAll good.");
process.exit(fails.length ? 1 : 0);
