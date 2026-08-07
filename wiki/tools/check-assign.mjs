// The assign-a-sound card and its button (maintainer 2026-08-06): no keyboard
// on open, a wiki-styled dropdown, copy that says what the card makes, and ONE
// button — a monochrome chain, never a colour emoji.
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const PW = process.env.WIKI_ADMIN_PASSWORD ?? "";
// The assign card is Game-Master-only: with no password every assertion below
// reads `undefined` off a card that was never rendered, which is a broken
// harness reporting a broken UI. Skip honestly instead.
if (!PW) { console.log("SKIPPED: WIKI_ADMIN_PASSWORD not set (the assign card is admin-only)"); await b.close(); process.exit(0); }
const errs = [];

async function open(touch) {
  const ctx = await b.newContext(touch
    ? { viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(W, { waitUntil: "load" });
  await p.evaluate(async (pw) => {
    const r = await fetch("/api/wiki/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: pw }) });
    localStorage.setItem("wiki-admin-token", (await r.json()).token);
  }, PW);
  return p;
}

// ---------- a phone: opening the picker must NOT put focus in the search box
const p = await open(true);
await p.goto(`${W}#/characters/51be6251`, { waitUntil: "load" });
await p.reload({ waitUntil: "load" });
await p.waitForTimeout(2400);
const card = await p.evaluate(() => {
  const c = document.querySelector(".sfx-entity-add");
  const sel = c?.querySelector("select.sfx-pick");
  const cs = sel ? getComputedStyle(sel) : null;
  const btn = c?.querySelector(".sfx-add-open");
  return {
    title: c?.querySelector(".panel-title")?.textContent.trim(),
    body: c?.querySelector("p.muted")?.textContent ?? "",
    btn: btn?.textContent.trim(),
    icon: !!btn?.querySelector(".ico-link svg"),
    // the chain must be drawn in the button's own ink, not a colour picture
    iconStroke: btn ? getComputedStyle(btn.querySelector(".ico-link svg path")).stroke : null,
    btnInk: btn ? getComputedStyle(btn).color : null,
    emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(btn?.textContent ?? ""),
    selCss: cs ? { radius: cs.borderTopLeftRadius, border: cs.borderTopWidth, bg: cs.backgroundColor, ink: cs.color, font: cs.fontFamily.split(",")[0] } : null,
    // the chosen action must FIT — a percentage max-width against a
    // shrink-to-fit parent collapsed this box and "Idle" read as "Idl"
    label: sel?.options[sel.selectedIndex]?.text,
    fits: (() => {
      if (!sel) return null;
      const probe = document.createElement("span");
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font}`;
      probe.textContent = sel.options[sel.selectedIndex].text;
      document.body.append(probe);
      const need = probe.getBoundingClientRect().width;
      probe.remove();
      return { need: Math.round(need), have: Math.round(sel.getBoundingClientRect().width) };
    })(),
    pageInk: getComputedStyle(document.body).color,
    pageBg: getComputedStyle(document.body).backgroundColor,
  };
});
console.log("card:", JSON.stringify(card));
ok(/^New sound effect event/.test(card.title ?? ""), `the card is titled for what it makes ("${card.title}")`);
ok(/Assign a sound effect to a new event/.test(card.body), `and says so in the text ("${card.body.slice(0, 60)}…")`);
ok(card.btn === "Assign a sound…", `the button reads "Assign a sound…" (got "${card.btn}")`);
ok(card.icon && !card.emoji, "the chain is a drawn glyph, not an emoji codepoint in the text");
ok(card.iconStroke === card.btnInk, `and it is stroked in the button's own ink (${card.iconStroke})`);
ok(card.selCss?.radius !== "0px" && card.selCss?.border !== "0px", `the dropdown is a wiki control (radius ${card.selCss?.radius}, border ${card.selCss?.border})`);
ok(card.selCss?.ink === card.pageInk, `it takes the theme's ink (${card.selCss?.ink} vs page ${card.pageInk})`);
ok(card.fits && card.fits.have >= card.fits.need + 18,
  `and the action name is not clipped — "${card.label}" needs ${card.fits?.need}px, the box is ${card.fits?.have}px`);

const focus = await p.evaluate(async () => {
  document.querySelector(".sfx-entity-add .sfx-add-open").click();
  await new Promise((r) => setTimeout(r, 350));
  const d = document.querySelector("dialog.sfx-picker");
  window.__dlgTitle = d.querySelector("h3")?.textContent ?? "";
  window.__dlgFits = d.getBoundingClientRect().height <= window.innerHeight;
  const search = d.querySelector("input[type=search]");
  const before = document.activeElement?.tagName + "." + (document.activeElement?.className || "");
  // tapping the search box IS how you ask for the keyboard
  search.focus();
  const after = document.activeElement === search;
  return { before, searchFocusedOnOpen: false, after, openedFocus: before };
});
console.log("focus:", JSON.stringify(focus));
ok(!/INPUT/.test(focus.before), `opening the picker leaves the keyboard alone (focus was ${focus.before})`);
ok(focus.after, "tapping the search box still focuses it — that is when the keyboard belongs");

// the dialog must keep reminding you WHAT you are listening for
const titled = await p.evaluate(() => ({ title: window.__dlgTitle, fits: window.__dlgFits,
  action: document.querySelector(".sfx-entity-add select")?.value,
  name: document.querySelector("h1")?.textContent }));
console.log("dialog title:", JSON.stringify(titled));
ok(/^Assign a sound to /.test(titled.title), `the title names the target ("${titled.title}")`);
ok(titled.title.includes(titled.name), "…including whose page you are on");
ok(titled.fits, "and the dialog still fits the phone screen");

// ---------- the transport must not move as you step (maintainer 2026-08-06)
const pinned = await p.evaluate(async () => {
  const d = document.querySelector("dialog.sfx-picker");
  const next = [...d.querySelectorAll(".picker-bar .ghost-btn")].find((x) => /Next/.test(x.textContent));
  const box = () => { const r = next.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; };
  const seen = [box()], names = [];
  for (let i = 0; i < 8; i++) {                       // long names, short names, group boundaries
    next.click();
    await new Promise((r) => setTimeout(r, 200));
    seen.push(box());
    names.push(d.querySelector(".picker-row.sel .take-name").textContent);
  }
  // and with a search that matches nothing, the list must hold its height
  const list = d.querySelector(".picker-list");
  const h0 = Math.round(list.getBoundingClientRect().height);
  const s = d.querySelector("input[type=search]");
  s.value = "zzzznothing"; s.dispatchEvent(new Event("input"));
  await new Promise((r) => setTimeout(r, 150));
  const empty = { h: Math.round(list.getBoundingClientRect().height), text: list.textContent.trim(), box: box() };
  s.value = ""; s.dispatchEvent(new Event("input"));
  return { seen, names, h0, empty, bars: d.querySelectorAll(".picker-bar").length,
    chosenText: /Selected:/.test(d.textContent) };
});
const moved = pinned.seen.filter(([x, y]) => x !== pinned.seen[0][0] || y !== pinned.seen[0][1]);
console.log("pinned:", JSON.stringify({ ...pinned, seen: pinned.seen.slice(0, 3) }));
ok(moved.length === 0, `Next stays put across 8 steps (${moved.length} moves; walked ${pinned.names.slice(0, 4).join(", ")}…)`);
ok(!pinned.chosenText, "the 'Selected: …' line is gone — the accent row already says which one");
ok(pinned.empty.h === pinned.h0 && /Nothing matches/.test(pinned.empty.text),
  `an empty search keeps the list's height (${pinned.empty.h} vs ${pinned.h0}) and says so inside it`);
ok(pinned.empty.box[1] === pinned.seen[0][1], "…so the buttons do not move for that either");

// the event-card button says "another" when the event already has a sound
await p.goto(`${W}#/sounds`, { waitUntil: "load" });
await p.waitForTimeout(2200);
const labels = await p.evaluate(() => {
  const withSound = [...document.querySelectorAll(".sfx-event")].find((c) => c.querySelector(".sfx-take"));
  const without = [...document.querySelectorAll(".sfx-event")].find((c) => !c.querySelector(".sfx-take"));
  const txt = (c) => c?.querySelector(".sfx-add-open")?.textContent.trim();
  return { withSound: txt(withSound), without: txt(without),
    icons: document.querySelectorAll(".sfx-add-open .ico-link svg").length,
    buttons: document.querySelectorAll(".sfx-add-open").length,
    anyPlus: [...document.querySelectorAll(".sfx-add-open")].some((x) => /^\+/.test(x.textContent.trim())) };
});
console.log("buttons:", JSON.stringify(labels));
// an EVENT card's dialog names the event, and says "another" when it has one
const evTitles = await p.evaluate(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector("dialog.sfx-picker")?.close();     // a modal left open eats the next click
  await wait(200);
  const out = [];
  for (const which of [true, false]) {
    const card = [...document.querySelectorAll(".sfx-event")].find((c) => !!c.querySelector(".sfx-take") === which);
    // the event's own name is the panel title's first TEXT node — the rest are pills
    const name = [...card.querySelector(".panel-title").childNodes]
      .find((n) => n.nodeType === 3 && n.textContent.trim())?.textContent.trim() ?? "";
    card.querySelector(".sfx-add-open").click();
    await wait(300);
    const d = document.querySelector("dialog.sfx-picker");
    out.push({ name, title: d.querySelector("h3").textContent, fits: d.getBoundingClientRect().height <= window.innerHeight });
    d.close();
    await wait(200);
  }
  return out;
});
console.log("event dialogs:", JSON.stringify(evTitles));
ok(evTitles[0].title === `Assign another sound to ${evTitles[0].name}`, `an event with a sound: "${evTitles[0].title}"`);
ok(evTitles[1].title === `Assign a sound to ${evTitles[1].name}`, `a silent event: "${evTitles[1].title}"`);
ok(evTitles.every((x) => x.fits), "both dialogs fit the phone screen");
ok(labels.withSound === "Assign another sound…", `an event that already sounds says "Assign another sound…" (got "${labels.withSound}")`);
ok(labels.without === "Assign a sound…", `a silent event says "Assign a sound…" (got "${labels.without}")`);
ok(labels.icons === labels.buttons && !labels.anyPlus, `every one of the ${labels.buttons} buttons carries the chain, none the old "+"`);

// ---------- a desktop still focuses the search: typing straight away is the point
const d = await open(false);
await d.goto(`${W}#/sounds`, { waitUntil: "load" });
await d.reload({ waitUntil: "load" });
await d.waitForTimeout(2200);
const deskFocus = await d.evaluate(async () => {
  document.querySelector(".sfx-event .sfx-add-open").click();
  await new Promise((r) => setTimeout(r, 350));
  return document.activeElement?.getAttribute("type") ?? document.activeElement?.tagName;
});
console.log("desktop focus:", deskFocus);
ok(deskFocus === "search", `a mouse+keyboard machine focuses the search box (${deskFocus})`);

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL ASSIGN-CARD CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
