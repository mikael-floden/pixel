// Verify the character-select join screen: pick a specific character + name,
// enter the world, and confirm that choice reached the shared world.
// WIKI-STYLE UI (2026-07-30): the UI-kit plates are gone — the controls are
// clean wiki cards. This gate also asserts the new DOM: character cells are
// button.ml-cell (selected = .sel with the accent border + accent-soft ring),
// the world dropdown rows are button.ml-ddrow (+ .sel), and #ml-enter is the
// fixed accent primary button. __mlSelect behavior is unchanged.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = process.env.OUT || "/tmp";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto("http://localhost:5173/", { waitUntil: "load" });

  // Select screen appears with all characters.
  await page.waitForFunction(() => window.__mlSelect && window.__mlSelect.count() >= 1, { timeout: 20000 });
  const count = await page.evaluate(() => window.__mlSelect.count());
  await page.screenshot({ path: `${OUT}/select_screen.png` });

  // ── NEW-DOM: the world dropdown is a wiki dropdown (#ml-dd-head toggles
  // #ml-dd-list of button.ml-ddrow; the chosen world row carries .sel).
  // Guarded — demo mode (no worlds.json) renders no picker at all.
  const hasWorlds = await page.evaluate(() => !!document.querySelector("#ml-worlds"));
  if (hasWorlds) {
    await page.click("#ml-dd-head"); // waits out the title veil (pointer-events)
    const dd = await page.evaluate(() => {
      const list = document.querySelector("#ml-dd-list");
      const rows = [...list.querySelectorAll("button.ml-ddrow")];
      return {
        open: !list.hidden,
        rows: rows.length,
        selRows: rows.filter((r) => r.classList.contains("sel")).length,
        worlds: window.__mlSelect.worlds().length,
      };
    });
    console.log("DROPDOWN " + JSON.stringify(dd));
    if (!dd.open) throw new Error("dropdown did not open on #ml-dd-head click");
    if (dd.rows !== dd.worlds || dd.rows < 1)
      throw new Error(`dropdown rows ${dd.rows} != worlds ${dd.worlds}`);
    if (dd.selRows !== 1) throw new Error(`expected exactly 1 .sel world row, got ${dd.selRows}`);
    await page.click("#ml-dd-head"); // fold it back up before the grid pick
    const reclosed = await page.evaluate(() => document.querySelector("#ml-dd-list").hidden);
    if (!reclosed) throw new Error("dropdown did not close on second #ml-dd-head click");
  } else {
    console.log("DROPDOWN skipped (no worlds — demo mode)");
  }

  // Pick character index 2 and a specific name, then enter.
  const targetUid = await page.evaluate(() => {
    // Pick the last index up to 2 — the roster shrank to 2 characters once
    // and the hardcoded pick(2) crashed on a missing cell.
    window.__mlSelect.pick(Math.min(2, window.__mlSelect.count() - 1));
    return null;
  });

  // ── NEW-DOM: cells are button.ml-cell; exactly the picked one carries .sel,
  // styled as the accent border + the 2px accent-soft ring (box-shadow).
  const dom = await page.evaluate(() => {
    const cells = [...document.querySelectorAll("#ml-grid button.ml-cell")];
    const selIdx = cells.findIndex((c) => c.classList.contains("sel"));
    const cs = selIdx >= 0 ? getComputedStyle(cells[selIdx]) : null;
    // Resolve var(--accent) to the same rgb() serialization computed styles use.
    const probe = document.createElement("i");
    probe.style.color = "var(--accent)";
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const enter = document.querySelector("#ml-enter");
    const ecs = enter ? getComputedStyle(enter) : null;
    return {
      cellCount: cells.length,
      selIdx,
      selCount: cells.filter((c) => c.classList.contains("sel")).length,
      selected: window.__mlSelect.selected(),
      selBorder: cs ? cs.borderTopColor : "",
      selRing: cs ? cs.boxShadow : "",
      accent,
      enterPos: ecs ? ecs.position : "",
      enterVisible: !!enter && enter.getBoundingClientRect().height > 0,
    };
  });
  console.log("DOM " + JSON.stringify(dom));
  if (dom.cellCount !== count) throw new Error(`ml-cell count ${dom.cellCount} != roster ${count}`);
  if (dom.selCount !== 1) throw new Error(`expected exactly 1 .sel cell, got ${dom.selCount}`);
  if (dom.selIdx !== dom.selected)
    throw new Error(`.sel cell index ${dom.selIdx} != __mlSelect.selected() ${dom.selected}`);
  if (dom.selBorder !== dom.accent)
    throw new Error(`selected cell border ${dom.selBorder} != accent ${dom.accent}`);
  if (!dom.selRing || dom.selRing === "none")
    throw new Error("selected cell is missing the accent-soft box-shadow ring");
  if (dom.enterPos !== "fixed" || !dom.enterVisible)
    throw new Error(`#ml-enter must be a visible fixed button (pos=${dom.enterPos})`);

  // ── THE CORNER PAIR: Wiki + Theme, both the maintainer's own pixel art ──
  // (2026-09-03, replacing the 📖 and 🌗 emoji.) They share ONE fixed box so
  // they can never differ in size or baseline — his 2026-07-30 report — so
  // this asserts the PAIR, not two icons independently, and it asserts the
  // decoded bitmaps: a missing /ui2 file is an empty box, not an error.
  // DECODE FIRST, MEASURE SECOND. naturalWidth is 0 both for a 404 and for a
  // file that simply has not arrived yet, and on a cold dev server the corner
  // art lands ~300ms after #ml-wiki exists (the install chip's is later still
  // — a hidden image is fetched at a lower priority). Waiting keeps the gate's
  // teeth: a missing /ui2 file never decodes, so this times out and fails with
  // the same meaning, instead of the gate passing or failing on the harness's
  // luck.
  await page
    .waitForFunction(
      () => [...document.querySelectorAll(".ml-cicon-img")].every((i) => i.naturalWidth > 0),
      null,
      { timeout: 15000 },
    )
    .catch(() => {
      throw new Error("a corner icon never decoded — check /ui2 for a 404 (an empty box, not an error)");
    });

  const pair = await page.evaluate(() => {
    const one = (sel) => {
      const b = document.querySelector(sel);
      const i = b.querySelector(".ml-cicon-img");
      const br = b.getBoundingClientRect(), ir = i.getBoundingClientRect();
      return {
        src: i.getAttribute("src") ?? "", nat: [i.naturalWidth, i.naturalHeight],
        box: [Math.round(ir.width), Math.round(ir.height)],
        rendering: getComputedStyle(i).imageRendering,
        left: Math.round(ir.left), midOffset: +((ir.top + ir.bottom) / 2 - (br.top + br.bottom) / 2).toFixed(1),
        iconLeftPad: +(ir.left - br.left).toFixed(1),
        btn: [Math.round(br.width), Math.round(br.height)], top: Math.round(br.top), bottom: Math.round(br.bottom),
      };
    };
    return { wiki: one("#ml-wiki"), theme: one("#ml-theme-btn") };
  });
  for (const [name, g] of Object.entries(pair)) {
    if (g.nat[0] !== 48 || g.nat[1] !== 48)
      throw new Error(`${name} icon did not decode (${g.src}, natural ${g.nat.join("x")}) — a 404 in /ui2 renders as an empty box`);
    if (g.box[0] !== 24 || g.box[1] !== 24 || g.rendering !== "pixelated")
      throw new Error(`${name} icon is ${g.box.join("x")}/${g.rendering}, wanted its authored 24x24 pixelated`);
  }
  // ── THE INSTALL CHIP: his download arrow, and the THIRD member of the set ──
  // (2026-09-13, replacing the ⤓ text glyph; "The button should look similar
  // to Wiki and theme same size and margin".) It is HIDDEN until the browser
  // offers an install prompt, which headless Chromium never does — so flash it
  // visible to measure its resting geometry and restore, the same pure
  // measurement verify-chat makes on the chat input. Asserted AS A SET with
  // the pair, never independently: identical box, identical 12px margin from
  // its own edge, same top line as Wiki — sizing one of a matched set alone is
  // the bug the shared rule exists to prevent.
  const inst = await page.evaluate(() => {
    const b = document.querySelector("#ml-install");
    const wasHidden = b.hidden;
    b.hidden = false;
    const i = b.querySelector(".ml-cicon-img");
    const br = b.getBoundingClientRect(), ir = i.getBoundingClientRect();
    const g = {
      src: i.getAttribute("src") ?? "", nat: [i.naturalWidth, i.naturalHeight],
      box: [Math.round(ir.width), Math.round(ir.height)],
      rendering: getComputedStyle(i).imageRendering,
      midOffset: +((ir.top + ir.bottom) / 2 - (br.top + br.bottom) / 2).toFixed(1),
      iconLeftPad: +(ir.left - br.left).toFixed(1),
      btn: [Math.round(br.width), Math.round(br.height)],
      right: Math.round(window.innerWidth - br.right), top: Math.round(br.top),
      text: (b.textContent || "").trim(),
      glyph: /[\u2193\u21a7\u2913\u2b07\ufe0f]/.test(b.textContent || ""),
    };
    b.hidden = wasHidden;
    return g;
  });
  if (inst.nat[0] !== 48 || inst.nat[1] !== 48)
    throw new Error(`install icon did not decode (${inst.src}, natural ${inst.nat.join("x")}) — a 404 in /ui2 renders as an empty box`);
  if (inst.box[0] !== 24 || inst.box[1] !== 24 || inst.rendering !== "pixelated")
    throw new Error(`install icon is ${inst.box.join("x")}/${inst.rendering}, wanted its authored 24x24 pixelated`);
  if (inst.glyph) throw new Error(`the install chip still carries an arrow GLYPH (${inst.text}) — the face is his pixel art`);
  if (!/install/i.test(inst.text)) throw new Error(`the install chip lost its word: "${inst.text}"`);
  if (Math.abs(inst.midOffset) > 0.6)
    throw new Error(`install icon is off the chip's centre line by ${inst.midOffset}px`);
  if (String(inst.btn) !== String(pair.wiki.btn))
    throw new Error(`the install chip is ${inst.btn} while the pair is ${pair.wiki.btn} — the three are one set (his 2026-09-13 verdict)`);
  if (Math.abs(inst.right - 12) > 1 || Math.abs(inst.top - pair.wiki.top) > 1)
    throw new Error(`install chip at right ${inst.right}/top ${inst.top}, wanted the same 12px margin as Wiki's (left ${pair.wiki.left - 24}) on its line (${pair.wiki.top})`);
  if (Math.abs(inst.iconLeftPad - pair.wiki.iconLeftPad) > 0.6)
    throw new Error(`install icon sits ${inst.iconLeftPad}px inside its chip, Wiki's sits ${pair.wiki.iconLeftPad} — one internal layout`);
  console.log("INSTALL " + JSON.stringify(inst));

  const gap = pair.theme.top - pair.wiki.bottom;
  if (pair.wiki.left !== pair.theme.left || Math.abs(pair.wiki.midOffset - pair.theme.midOffset) > 0.6)
    throw new Error(`the corner pair is not aligned: left ${pair.wiki.left}/${pair.theme.left}, centre offset ${pair.wiki.midOffset}/${pair.theme.midOffset}`);
  if (String(pair.wiki.btn) !== String(pair.theme.btn))
    throw new Error(`the corner pair differs in size: ${pair.wiki.btn} vs ${pair.theme.btn}`);
  // The buttons grew with the 24px box; .ml-theme{top} is an ABSOLUTE offset
  // that does not follow, and silently closed this to 4px once already.
  if (Math.abs(gap - 9) > 1.5) throw new Error(`Wiki/Theme gap is ${gap}px, wanted the 9px the pair has always had`);
  console.log("CORNER " + JSON.stringify({ ...pair, gap }));

  await page.fill("#ml-name", "Verifier");
  const chosenUid = await page.evaluate(async () => {
    const idx = window.__mlSelect.selected();
    const m = await (await fetch("/characters.json")).json();
    return m.characters[idx].uid;
  });
  // FULLSCREEN IS FOR THE INSTALLED APP ONLY (maintainer 2026-09-18: "I of
  // course don't want fullscreen when the player uses the web browser"): a
  // browser tab's Enter World must not ask for it. Spied, not observed — a
  // headless tab would refuse anyway, which is not the same as not asking.
  await page.evaluate(() => {
    window.__fsCalls = [];
    Element.prototype.requestFullscreen = function (o) { window.__fsCalls.push(o ?? null); return Promise.resolve(); };
  });
  await page.click("#ml-enter");
  const tabCalls = await page.evaluate(() => window.__fsCalls.length);
  if (tabCalls !== 0) throw new Error(`a browser tab asked for fullscreen ${tabCalls}x on Enter World`);
  console.log("FULLSCREEN not requested in a browser tab");

  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 20000 });
  await page.waitForTimeout(1500);
  const myChar = await page.evaluate(() => window.__ml.myCharacter());
  await page.screenshot({ path: `${OUT}/select_world.png` });

  console.log("RESULT " + JSON.stringify({ count, chosenUid, myChar }));
  if (myChar !== chosenUid) throw new Error(`chosen ${chosenUid} but joined as ${myChar}`);
  console.log("SELECT OK");

  // …and the INSTALLED app asks for it on the same tap (select.ts
  // enterFullscreenIfInstalled): display-mode is emulated by patching
  // matchMedia before the page's scripts run, and the request is spied.
  {
    const ictx = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
    const ipage = await ictx.newPage();
    await ipage.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/display-mode:\s*(standalone|fullscreen)/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : real(q));
      window.__fsCalls = [];
      // the PROTOTYPE: at init-script time document.documentElement is still null
      Element.prototype.requestFullscreen = function (o) { window.__fsCalls.push(o ?? null); return Promise.resolve(); };
    });
    await ipage.goto("http://localhost:5173/", { waitUntil: "load" });
    await ipage.waitForFunction(() => window.__mlSelect && window.__mlSelect.count() >= 1, { timeout: 20000 });
    await ipage.click("#ml-enter");
    const calls = await ipage.evaluate(() => window.__fsCalls);
    if (calls.length !== 1 || calls[0]?.navigationUI !== "hide")
      throw new Error(`installed app: expected one requestFullscreen({navigationUI:"hide"}) on Enter World, got ${JSON.stringify(calls)}`);
    console.log("FULLSCREEN requested once by the installed app (navigationUI: hide)");
    await ictx.close();
  }
} finally {
  await browser.close();
}
