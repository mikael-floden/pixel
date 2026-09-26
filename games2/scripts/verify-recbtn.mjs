// QA: the REPORT BUTTON (client/src/recbtn.ts) — his bug icon and the word
// "Report" in the Wiki button's clothes, under the HP/EP card (maintainer
// 2026-09-19: "I want that button to look more like the wiki button. This
// means it needs a 24x24 icon and text instead… the text should be 'Report'
// and the size and style and margin should be like the wiki button").
//
// THE CENTRAL ASSERTION IS A COMPARISON, NOT A LIST OF NUMBERS. "Like the wiki
// button" is only true relative to the Wiki button, so every shared property is
// read off the LIVE .ml-wikibtn and required to match: restyle that one and
// this gate fails until this one follows. A gate full of literals would have
// passed the day the pill changed and left the two drifting.
//
// What it also holds: the admin gate in BOTH directions (a gate that only
// proved the reveal would pass on a build that showed it to everybody), that
// the icon really DECODED at its authored 24px grid, that the label fits its
// box, that the pressed state is the theme's own accent rather than a literal
// red, and that the ml-record seam still fires — freezeframe.ts listens to it
// and knows nothing about this file.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const OUT = process.env.OUT || "/tmp";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);

const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(`${BASE}/`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 90000 });
await page.waitForFunction(() => document.querySelector(".ml-rec") && document.querySelector(".ml-bars-l") && document.querySelector(".ml-wikibtn"), null, { timeout: 30000 });

// ── 0. ADMIN ONLY, both directions ─────────────────────────────────────────
{
  await page.waitForTimeout(400); // let the boot-time ask settle
  const hidden = await page.evaluate(() => {
    const b = document.querySelector(".ml-rec");
    // NB offsetParent is null for every position:fixed element, so it can
    // never stand in for "painted" here — the box itself is the test.
    const seen = (e) => !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
    return { present: !!b, hiddenAttr: b?.hidden, display: b ? getComputedStyle(b).display : null, painted: seen(b), shown: window.__mlRecord?.shown() };
  });
  hidden.present && hidden.hiddenAttr === true && hidden.display === "none" && !hidden.painted && hidden.shown === false
    ? ok("a player never sees it: mounted, hidden, not painted (the real server said not-admin)")
    : fail(`visible to a non-admin: ${JSON.stringify(hidden)}`);
  await page.route("**/api/wiki/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ admin: true }) }),
  );
  await page.evaluate(() => localStorage.setItem("wiki-admin-token", "gate"));
  const shown = await page.evaluate(() => window.__mlRecord.refresh(true));
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => {
    const b = document.querySelector(".ml-rec");
    return { hiddenAttr: b?.hidden, painted: !!b && getComputedStyle(b).display !== "none" && b.getBoundingClientRect().width > 0 };
  });
  shown === true && after.hiddenAttr === false && after.painted
    ? ok("…and the admin does: the server's yes reveals it")
    : fail(`admin case: refresh returned ${shown}, ${JSON.stringify(after)}`);
}

// ── 1. IT IS THE WIKI PILL — measured against the Wiki pill ────────────────
{
  const same = await page.evaluate(() => {
    const pick = (el) => {
      const s = getComputedStyle(el);
      return {
        height: s.height, boxSizing: s.boxSizing, padding: s.padding,
        borderWidth: s.borderTopWidth, borderStyle: s.borderTopStyle, borderColor: s.borderTopColor,
        radius: s.borderTopLeftRadius, shadow: s.boxShadow, background: s.backgroundColor,
        blur: s.backdropFilter || s.webkitBackdropFilter,
        font: s.font, tracking: s.letterSpacing, color: s.color,
        display: s.display, align: s.alignItems, justify: s.justifyContent, gap: s.columnGap,
        z: s.zIndex,
      };
    };
    const r = document.querySelector(".ml-rec"), w = document.querySelector(".ml-wikibtn");
    const rb = r.getBoundingClientRect(), wb = w.getBoundingClientRect();
    return { rec: pick(r), wiki: pick(w), recBox: [Math.round(rb.width), Math.round(rb.height)], wikiBox: [Math.round(wb.width), Math.round(wb.height)] };
  });
  const diff = Object.keys(same.wiki).filter((k) => same.rec[k] !== same.wiki[k]);
  diff.length === 0
    ? ok(`every shared property matches the live Wiki button (${Object.keys(same.wiki).length} checked: ${same.wiki.height} tall, ${same.wiki.radius} radius, ${same.wiki.font})`)
    : fail(`it does not look like the Wiki button — ${diff.map((k) => `${k}: ${same.rec[k]} vs ${same.wiki[k]}`).join("; ")}`);
  same.recBox[1] === same.wikiBox[1]
    ? ok(`…and the same height (${same.recBox[1]}px)`)
    : fail(`height ${same.recBox[1]} vs the Wiki button's ${same.wikiBox[1]}`);
  // THE WIDTH IS THE CARD'S, NOT THE WIKI PILL'S (maintainer 2026-09-19: "The
  // Report button should have the same size as the card over it so it
  // aligns!"). Asserted against the card itself, in both orientations below,
  // so whatever width bars.ts lands on this follows or fails.
  const card = await page.evaluate(() => {
    const r = document.querySelector(".ml-rec").getBoundingClientRect();
    const c = document.querySelector(".ml-bars-l").getBoundingClientRect();
    return { left: Math.round(r.left - c.left), right: Math.round(c.right - r.right), rw: Math.round(r.width), cw: Math.round(c.width) };
  });
  card.left === 0 && card.right === 0
    ? ok(`it is exactly as wide as the HP/EP card above it, both edges flush (${card.rw}px)`)
    : fail(`Report ${card.rw}px vs the card's ${card.cw}px — off by ${card.left}px left, ${card.right}px right`);
  // THE TWO CARDS ARE THE SAME HEIGHT, or everything anchored under them is
  // off by the difference (maintainer 2026-09-19: "the gold however is not as
  // tall as EP so the two cards have different size. This makes all UI
  // elements under the card un-aligned"). The gold row carries a min-height to
  // make it so; this is what holds that number to a real bar row rather than
  // letting it drift.
  const cards = await page.evaluate(() => {
    const l = document.querySelector(".ml-bars-l").getBoundingClientRect();
    const r = document.querySelector(".ml-bars-r").getBoundingClientRect();
    const cs = getComputedStyle(document.documentElement);
    return {
      lh: Math.round(l.height), rh: Math.round(r.height),
      lt: Math.round(l.top), rt: Math.round(r.top),
      varL: cs.getPropertyValue("--bars-l-h").trim(), varR: cs.getPropertyValue("--bars-r-h").trim(),
    };
  });
  cards.lh === cards.rh && cards.lt === cards.rt
    ? ok(`both stat cards are the same height and sit on the same line (${cards.lh}px at y=${cards.lt}), so what hangs under them lines up`)
    : fail(`the cards differ: HP/EP ${cards.lh}px at ${cards.lt}, XP ${cards.rh}px at ${cards.rt} — everything anchored below inherits the gap`);
  cards.varL === cards.varR
    ? ok(`…and they publish one height (${cards.varL})`)
    : fail(`--bars-l-h ${cards.varL} vs --bars-r-h ${cards.varR}`);
}

// ── 2. THE SAME MARGIN, MIRRORED, AND THE CARD'S OWN EDGE ─────────────────
{
  const m = await page.evaluate(() => {
    const r = document.querySelector(".ml-rec").getBoundingClientRect();
    const w = document.querySelector(".ml-wikibtn").getBoundingClientRect();
    const card = document.querySelector(".ml-bars-l").getBoundingClientRect();
    const barEl = document.querySelector(".ml-spinbar");
    const bar = barEl ? barEl.getBoundingClientRect() : null;
    const cs = getComputedStyle(document.documentElement);
    const px = (v) => parseFloat(cs.getPropertyValue(v)) || 0;
    return {
      left: Math.round(r.left - px("--gv-left")),
      wikiRight: Math.round(innerWidth - px("--gv-right") - w.right),
      cardLeft: Math.round(card.left), recLeft: Math.round(r.left),
      belowCard: Math.round(r.top - card.bottom),
      // SINCE 2026-09-26 the spin bar holds the line directly under the card
      // (spinbar.ts) and this button hangs under IT. The law is unchanged —
      // one margin, everywhere — so it is measured against whatever is
      // actually above: the bar when it is mounted, the card when it is not.
      barTop: bar ? Math.round(bar.top) : null,
      barBottom: bar ? Math.round(bar.bottom) : null,
      barLeft: bar ? Math.round(bar.left) : null,
      barRight: bar ? Math.round(bar.right) : null,
      cardRight: Math.round(card.right),
      belowBar: bar ? Math.round(r.top - bar.bottom) : null,
      barBelowCard: bar ? Math.round(bar.top - card.bottom) : null,
    };
  });
  m.left === m.wikiRight
    ? ok(`the same margin, mirrored: ${m.left}px inside the game view's left edge, the Wiki pill ${m.wikiRight}px inside its right`)
    : fail(`margins differ: Report ${m.left}px from the left, Wiki ${m.wikiRight}px from the right`);
  Math.abs(m.recLeft - m.cardLeft) <= 1
    ? ok(`its left edge lines up with the HP/EP card's (${m.recLeft} vs ${m.cardLeft})`)
    : fail(`Report at x=${m.recLeft}, the card at x=${m.cardLeft} — they must share an edge`);
  // ONE MARGIN, EVERYWHERE — now across a two-row stack. The spin bar hangs
  // its margin under the card and this button hangs its margin under the bar;
  // with no bar mounted the old single gap is the same assertion.
  const above = m.barBottom === null ? "the card" : "the spin bar";
  const gap = m.barBottom === null ? m.belowCard : m.belowBar;
  gap === m.left
    ? ok(`and it hangs the same ${gap}px under ${above} as it keeps to the edge`)
    : fail(`gap under ${above} ${gap}px, edge margin ${m.left}px — one margin, everywhere`);
  if (m.barBottom !== null) {
    m.barBelowCard === m.left
      ? ok(`the spin bar keeps that one margin too: ${m.barBelowCard}px under the card`)
      : fail(`the spin bar sits ${m.barBelowCard}px under the card, edge margin ${m.left}px`);
    // HIS TWO EDGES (2026-09-26: "The left button should align with the card
    // left. The right button should align with the card right.")
    Math.abs(m.barLeft - m.cardLeft) <= 1 && Math.abs(m.barRight - m.cardRight) <= 1
      ? ok(`and it spans the card exactly: ${m.barLeft}-${m.barRight} against the card's ${m.cardLeft}-${m.cardRight}`)
      : fail(`spin bar ${m.barLeft}-${m.barRight}, card ${m.cardLeft}-${m.cardRight} — both edges must match`);
  }
}

// ── 3. HIS ICON, DECODED, AT ITS AUTHORED GRID; THE LABEL FITS ────────────
{
  const c = await page.evaluate(() => {
    const b = document.querySelector(".ml-rec");
    const img = b.querySelector("img");
    const wi = document.querySelector(".ml-wikibtn img");
    return {
      text: b.textContent.trim(),
      nat: [img.naturalWidth, img.naturalHeight],
      shown: [Math.round(img.getBoundingClientRect().width), Math.round(img.getBoundingClientRect().height)],
      wikiShown: Math.round(wi.getBoundingClientRect().width),
      src: img.getAttribute("src"),
      wikiSrc: wi.getAttribute("src"),
      overflow: Math.round(b.scrollWidth - b.clientWidth),
    };
  });
  c.text === "Report" ? ok('the label is "Report"') : fail(`label "${c.text}"`);
  // the bake is an exact 2x of his 24x24 export and the runtime halves it
  c.nat[0] === 48 && c.nat[1] === 48 && c.shown[0] === 24 && c.shown[1] === 24
    ? ok(`his 24x24 bug decoded and drawn at its authored grid (bake ${c.nat.join("x")} → ${c.shown.join("x")}px)`)
    : fail(`icon natural ${c.nat.join("x")}, drawn ${c.shown.join("x")} — want a 48x48 bake at 24px (a 0 means it never decoded)`);
  c.shown[0] === c.wikiShown
    ? ok(`…the same size the Wiki pill draws its own icon (${c.wikiShown}px)`)
    : fail(`icon ${c.shown[0]}px vs the Wiki button's ${c.wikiShown}px`);
  c.overflow <= 0 ? ok("the label and icon fit the pill without overflowing it") : fail(`the content overflows the pill by ${c.overflow}px`);
  // THE BUG SITS CENTRED IN ITS CANVAS, not low (maintainer 2026-09-19: "I feel
  // the Report bug should be lifted a couple of pixels to feel more vertically
  // centered"). The export's ink was 6px from the top and 3 from the bottom;
  // the bake's `centre` transform lifts it. Measured on the DECODED pixels, so
  // a re-export that lands low fails here rather than looking slightly wrong
  // forever — and an odd remainder is allowed to fall on the low side, which is
  // what optical centring wants.
  const ink = await page.evaluate(async () => {
    const img = document.querySelector(".ml-rec img");
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const g = cv.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let top = -1, bottom = -1;
    for (let y = 0; y < cv.height; y++)
      for (let x = 0; x < cv.width; x++)
        if (d[(y * cv.width + x) * 4 + 3] > 8) { if (top < 0) top = y; bottom = y; }
    return { top, above: top, below: cv.height - 1 - bottom, h: cv.height };
  });
  ink.top >= 0 && ink.above <= ink.below && ink.below - ink.above <= 4
    ? ok(`the bug is centred in its canvas, a hair high (${ink.above}px above, ${ink.below}px below, at the bake's 2x)`)
    : fail(`the bug sits ${ink.above}px from the top and ${ink.below}px from the bottom of its canvas — it must not read low`);
  // the stamp is whatever withV() is giving the OTHER /ui2 icons this build —
  // a dev build stamps nothing, and that is not a bug; being the odd one out is
  const stamp = (u) => (u.split("?")[1] || "");
  stamp(c.src) === stamp(c.wikiSrc)
    ? ok(`the icon is cache-stamped exactly like the Wiki button's ("${stamp(c.src) || "(unstamped, as this build stamps nothing)"}")`)
    : fail(`icon stamping differs from the Wiki button's: "${c.src}" vs "${c.wikiSrc}" — withV() missing?`);
}

// ── 4. PRESSED IS THE THEME'S ACCENT, NOT A LITERAL RED, AND IT FIRES ─────
{
  const probe = await page.evaluate(() => {
    window.__gateRecEvents = [];
    window.addEventListener("ml-record", (e) => window.__gateRecEvents.push(!!e.detail?.on));
    const cs = getComputedStyle(document.documentElement);
    const asColor = (v) => { const d = document.createElement("div"); d.style.color = cs.getPropertyValue(v).trim(); document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    return { soft: asColor("--accent-soft"), accent: asColor("--accent"), ink: asColor("--accent-ink") };
  });
  const rest = await page.evaluate(() => { const s = getComputedStyle(document.querySelector(".ml-rec")); return { bg: s.backgroundColor, bd: s.borderTopColor, fg: s.color }; });
  await page.evaluate(() => document.querySelector(".ml-rec").click());
  await page.waitForTimeout(250);
  const on = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector(".ml-rec"));
    return { bg: s.backgroundColor, bd: s.borderTopColor, fg: s.color, state: window.__mlRecord.on(), pressed: document.querySelector(".ml-rec").getAttribute("aria-pressed"), events: window.__gateRecEvents };
  });
  on.state === true && on.pressed === "true"
    ? ok("a press puts it in the recording state")
    : fail(`after the press: ${JSON.stringify(on)}`);
  on.bg === probe.soft && on.bd === probe.accent && on.fg === probe.ink
    ? ok(`…wearing the theme's own accent (${probe.soft} on ${probe.accent}, ${probe.ink} ink) — his red, and it re-themes`)
    : fail(`the on state is not the accent recipe: ${JSON.stringify(on)} vs ${JSON.stringify(probe)}`);
  on.bg !== rest.bg && on.bd !== rest.bd
    ? ok("…and it is visibly different from rest")
    : fail(`rest ${JSON.stringify(rest)} and on ${JSON.stringify(on)} look the same`);
  on.events.length >= 1 && on.events[on.events.length - 1] === true
    ? ok("the ml-record seam fired (freezeframe.ts listens to this and nothing else)")
    : fail(`no ml-record event: ${JSON.stringify(on.events)}`);
  await page.evaluate(() => document.querySelector(".ml-rec").click());
  await page.waitForTimeout(250);
  const off = await page.evaluate(() => ({ state: window.__mlRecord.on(), bg: getComputedStyle(document.querySelector(".ml-rec")).backgroundColor, events: window.__gateRecEvents }));
  off.state === false && off.bg === rest.bg && off.events[off.events.length - 1] === false
    ? ok("a second press puts it back, and says so")
    : fail(`after the second press: ${JSON.stringify(off)}`);
}

// ── 5. IT RIDES THE GAME VIEW'S EDGE THROUGH THE LANDSCAPE FLIP ───────────
{
  await page.setViewportSize({ width: 851, height: 393 });
  await page.waitForTimeout(900); // the flip's veil + the anchors' .3s glide
  const land = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const px = (v) => parseFloat(cs.getPropertyValue(v)) || 0;
    const r = document.querySelector(".ml-rec").getBoundingClientRect();
    const card = document.querySelector(".ml-bars-l").getBoundingClientRect();
    return { gv: px("--gv-left"), left: Math.round(r.left), card: Math.round(card.left), wide: Math.round(r.width - card.width), land: document.documentElement.classList.contains("ml-land") };
  });
  land.land && Math.abs(land.left - land.gv - 10) <= 1 && Math.abs(land.left - land.card) <= 1 && land.wide === 0
    ? ok(`in landscape it is still 10px inside the game view (x=${land.left}, --gv-left ${land.gv}), on the card's edge, and still the card's width`)
    : fail(`landscape placement: ${JSON.stringify(land)} — it must ride --gv-left and the card's width, never a sampled rect`);
  await page.setViewportSize({ width: 393, height: 851 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/recbtn-hud.png` });
}

await browser.close();
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
