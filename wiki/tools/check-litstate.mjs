// A LIT STATE THAT CAME OUT DARK IS NOT BAD ART — IT IS MIS-FILED ART.
//
// Maintainer, 2026-08-17: "Scenery uses pixelart to generate art and some
// scenery is supposed to be 'lit up' (like a lamp, campfire, glowing rune,
// etc). However! The AI that generates the image might fail to produce the
// light, but the scenery overall looks great. So I want a way to change the
// state from 'lit' to 'unlit' when doing the review. So we don't have to throw
// away the art just because it's lit state is wrong."
//
// So the Scenery review carries a per-STATE light switch that writes a
// CORRECTION, never a verdict: live/tuning/scenery_lights.json, keyed
// <piece path>#<state>, consumed by the scenery agent. This gate drives the
// real page and asserts the whole path — the control follows the state, the
// save lands in the right file with the right key, agreeing with the state's
// own name DELETES the entry, and the correction survives leaving the page.
//
//   node wiki/tools/check-litstate.mjs      (needs a wiki server on 8902)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const DATA = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const OBJ = DATA.domains.objects ?? [];
// A piece carrying BOTH kinds is the one worth driving: the correction only
// means something where the generator made a claim about light.
const VARIANT = /^(not[_-]?lit|lit|lights[_-]?off|lights[_-]?on)(?:[_-]?(\d+))?$/i;
const litName = (st) => { const m = VARIANT.exec(st); return m ? (/^lit/i.test(m[1]) || /on$/i.test(m[1])) : null; };
const piece = OBJ.find((o) => {
  const st = Object.keys(o.animations ?? {});
  return st.some((s) => litName(s) === true) && st.some((s) => litName(s) === false);
});
ok(!!piece, `the build offers a piece with both lit and unlit states (${piece?.id ?? "none"})`);
if (!piece) process.exit(1);
const LIT = Object.keys(piece.animations).find((s) => litName(s) === true);
const UNLIT = Object.keys(piece.animations).find((s) => litName(s) === false);
console.log(`piece: ${piece.id} | lit state: ${LIT} | unlit state: ${UNLIT}`);

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
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});

const read = () => p.evaluate(() => {
  const row = document.querySelector(".lit-mode");
  // EVERY TEXT NODE THE ROW OWNS, not just the ones I meant to put there.
  // `replaceChildren(a, b, null)` STRINGIFIES the null into a text node, and
  // the row shipped reading "Light unlit 💡lit null" for a whole evening
  // because this gate only ever looked at the elements it expected
  // (maintainer 2026-08-18: "why did you write null").
  const strays = [...(row?.childNodes ?? [])]
    .filter((n) => n.nodeType === 3 && n.textContent.trim())
    .map((n) => n.textContent.trim());
  const btn = row?.querySelector(".sortbar-btn");
  // The page's OTHER pick-one controls, to compare the tap target against.
  const others = [...document.querySelectorAll(".seg button")].map((b) => Math.round(b.getBoundingClientRect().height));
  return {
    present: !!row,
    sel: row?.querySelector(".sortbar-btn.sel")?.textContent.trim() ?? null,
    was: [...(row?.querySelectorAll(".pill") ?? [])].map((x) => x.textContent.trim()),
    state: document.querySelector(".facet-head .pill")?.getAttribute("title") ?? "",
    strays,
    btnH: btn ? Math.round(btn.getBoundingClientRect().height) : 0,
    btnW: btn ? Math.round(btn.getBoundingClientRect().width) : 0,
    otherH: others.length ? Math.min(...others) : 0,
  };
});
const press = (which) => p.evaluate((w) => {
  const row = document.querySelector(".lit-mode");
  [...row.querySelectorAll(".sortbar-btn")].find((b) => b.dataset.sort === w).click();
}, which);
// The state chips are the player's own seg row, labelled the way the maintainer
// asked for them — "1 2 3 💡1 💡2" — so the gate picks the LIT one by its lamp.
const pickLitChip = () => p.evaluate(() => {
  const seg = [...document.querySelectorAll(".seg")].find((s) => [...s.querySelectorAll("button")].some((b) => /💡/.test(b.textContent)));
  const btn = [...(seg?.querySelectorAll("button") ?? [])].find((b) => /💡/.test(b.textContent));
  if (!btn) return null;
  btn.click();
  return btn.textContent.trim();
});

await p.goto(`${W}#/objects/${piece.id}`, { waitUntil: "load" });
await p.waitForTimeout(2600);
const first = await read();
console.log("on open:", JSON.stringify(first));
ok(first.present, "the Scenery review carries a light switch, on the state you are looking at");
ok(first.sel === "unlit" || first.sel === "💡 lit", `showing what the art is now (${first.sel})`);
// 1. IT READS THE STATE'S NAME. The page opens on the base state, which is the
//    piece's own sprite — unlit in practice.
const openState = (first.state.split("·")[0] || "").trim();
ok(first.sel === (litName(openState) ? "💡 lit" : "unlit"),
  `and it reads the STATE's name, not the piece's (${openState || "base"} → ${first.sel})`);
ok(first.was.length === 0, `with nothing claiming a correction nobody made (${first.was.join(", ") || "no chips"})`);
// TWO THINGS THE FIRST CUT GOT WRONG, both visible in one screenshot of his.
ok(first.strays.length === 0, `and no stray text in the row — a null is not a label (${first.strays.join(" | ") || "none"})`);
ok(first.btnH >= first.otherH && first.btnH >= 36,
  `at the page's own control size, not smaller than everything around it (${first.btnH}px against the state chips' ${first.otherH}px)`);
ok(first.btnW >= 60, `and wide enough to hit with a thumb (${first.btnW}px)`);

// 2. CORRECTING IT SAVES, TO THE RIGHT FILE, UNDER THE STATE'S OWN KEY.
posted.length = 0;
await press(litName(openState) ? "unlit" : "lit");
await p.waitForTimeout(400);
const flipped = await read();
console.log("after flipping:", JSON.stringify(flipped));
ok(flipped.sel !== first.sel, `the switch takes (${first.sel} → ${flipped.sel})`);
ok(flipped.was.some((t) => /^generated as /.test(t)), `and says what it was generated as (${flipped.was.join(", ")})`);
ok(flipped.strays.length === 0, `still with no stray text (${flipped.strays.join(" | ") || "none"})`);
const commit = () => p.evaluate(() => [...document.querySelectorAll("#savebar button")].find((b) => /commit/i.test(b.textContent))?.click());
await commit();
await p.waitForTimeout(900);
const save = posted.find((x) => x.file === "tuning/scenery_lights");
console.log("posted:", JSON.stringify(save ?? posted[0] ?? null));
ok(!!save, `the correction goes to the live doc the scenery agent reads (${save?.file ?? "nothing posted"})`);
const key = Object.keys(save?.set ?? {})[0] ?? "";
ok(key.startsWith(`${piece.path}#`), `keyed <piece path>#<state>, the same unit the facet verdicts use (${key})`);
ok(typeof Object.values(save?.set ?? {})[0]?.lit === "boolean", "carrying the corrected value");
ok(!!save && Object.values(save.set)[0]?.was === key.split("#")[1],
  `and the state it was generated as, so a correction stays readable (${Object.values(save?.set ?? {})[0]?.was ?? "—"})`);

// 3. IT IS A PROPERTY, NOT A VERDICT: nothing lands in the feedback file.
ok(!posted.some((x) => x.file === "feedback/objects"), "and NOT in the feedback file — a mis-named state is not bad art");

// 4. AGREEING WITH THE NAME AGAIN DELETES THE ENTRY. A file of corrections that
//    correct nothing would grow to every state ever opened.
posted.length = 0;
await press(litName(openState) ? "lit" : "unlit");
await p.waitForTimeout(400);
const back = await read();
ok(back.sel === first.sel && back.was.length === 0 && back.strays.length === 0,
  "pressing back agrees with the art's own name again, and the chip goes with it");
await commit();
await p.waitForTimeout(900);
const undo = posted.find((x) => x.file === "tuning/scenery_lights");
const undoVal = Object.values(undo?.set ?? {})[0];
console.log("undo posted:", JSON.stringify(undo ?? null));
ok(!!undo && "set" in undo && Object.keys(undo.set).length === 1 && (undoVal === null || undoVal === undefined),
  `and the entry is DELETED rather than stored as a default (${JSON.stringify(undo?.set ?? null)})`);

// 5. THE SWITCH FOLLOWS THE STATE. Two states of one piece are two questions.
const other = await pickLitChip();
await p.waitForTimeout(600);
const second = await read();
console.log("other state:", JSON.stringify({ picked: other, ...second }));
ok(!!other, `the piece's own state row offers the lit variants (${other ?? "none found"})`);
const st2 = (second.state.split("·")[0] || "").trim();
ok(st2 !== openState, `switching state moves the question with it (${openState || "base"} → ${st2})`);
ok(litName(st2) === true, `and that state really is a LIT one (${st2})`);
ok(second.sel === "💡 lit", `so the switch reads THAT state's name, not the one before it (${second.sel})`);
ok(second.was.length === 0, "and carries no correction of its own — the two states are two questions");

// 6. A READER NEVER SEES IT. It is a review instrument.
const pub = await ctx.newPage();
await pub.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":false}' }));
await pub.addInitScript(() => localStorage.removeItem("wiki-admin-token"));
await pub.goto(`${W}#/objects/${piece.id}`, { waitUntil: "load" });
await pub.waitForTimeout(2200);
const pubRow = await pub.evaluate(() => document.querySelectorAll(".lit-mode").length);
ok(pubRow === 0, `a player is not shown the light switch (${pubRow} rows)`);

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nFAILED ${fails.length}` : "\nAll good.");
process.exit(fails.length ? 1 : 0);
