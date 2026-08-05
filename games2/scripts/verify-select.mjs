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

  await page.fill("#ml-name", "Verifier");
  const chosenUid = await page.evaluate(async () => {
    const idx = window.__mlSelect.selected();
    const m = await (await fetch("/characters.json")).json();
    return m.characters[idx].uid;
  });
  await page.click("#ml-enter");

  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 20000 });
  await page.waitForTimeout(1500);
  const myChar = await page.evaluate(() => window.__ml.myCharacter());
  await page.screenshot({ path: `${OUT}/select_world.png` });

  console.log("RESULT " + JSON.stringify({ count, chosenUid, myChar }));
  if (myChar !== chosenUid) throw new Error(`chosen ${chosenUid} but joined as ${myChar}`);
  console.log("SELECT OK");
} finally {
  await browser.close();
}
