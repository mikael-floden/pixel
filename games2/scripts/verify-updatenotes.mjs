// QA: the update popup's RELEASE NOTES (client/src/updatenote.ts) — what
// changed between the build you are running and the one being served
// (maintainer 2026-09-18: "I want it to list everything that has changed from
// the version I'm currently at to the version I'm about to get").
//
// Driven with a ROUTED wiki document, not a real deploy: the range, the
// grouping and the collapse are pure functions of that file, and the only way
// to see two builds on one harness is to hand the client the file a second
// deploy would have published. The fixture is the wiki's own shape
// (pixel-wiki-releases@1) so a schema change here fails loudly instead of
// quietly rendering nothing.
//
// The four things that would be WRONG AND INVISIBLE, and are therefore what
// this asserts: a row from BEFORE your build leaking into the list (the range
// is the whole feature), the notes failing to load taking the reload button
// with them (the update must always be one tap away), the dialog opening UNDER
// the toast that opened it (z 110 vs 100 — a stacking slip shows as a dead
// dialog), and it working on ONE of the two screens (maintainer 2026-09-18:
// "make it work both in the game and in the character select menu! Same code!
// Same dialog!"). ONE implementation, so the proof is the same dialog opened
// over each: the whole run below happens with the SELECT SCREEN up, and
// section 7 repeats the essentials with the world running.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const OUT = process.env.OUT || "/tmp";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);

// Local noon on a given day → the browser parses it back to local noon, so the
// fixture always spans exactly two calendar days whatever time the gate runs.
const noon = (daysAgo, h = 12, m = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
};
const MY_SHA = "eeeeeee55";
const NEW_SHA = "aaaaaaaa1";
const DOC = {
  format: "pixel-wiki-releases@1",
  generated_at: noon(0, 13),
  head: NEW_SHA,
  repo: "https://github.com/mikael-floden/pixel",
  commits: [
    { sha: NEW_SHA, at: noon(0, 12, 30), author: "Claude", subject: "games-ui: the thumb row balances on its inner gaps", agent: "games-ui", dirs: ["games2"], files: 3 },
    { sha: "bbbbbbbb2", at: noon(0, 12, 10), author: "Mikael Flodén", subject: "live: admin update — feedback/objects.json", agent: null, dirs: ["live"], files: 1 },
    { sha: "ccccccc33", at: noon(0, 12, 5), author: "Mikael Flodén", subject: "live: admin update — feedback/objects.json", agent: null, dirs: ["live"], files: 1 },
    { sha: "ddddddd44", at: noon(1, 12), author: "Claude", subject: "maps2: a span's new lane must land where the span lands", agent: "maps2", dirs: ["maps2"], files: 9 },
    { sha: "ggggggg77", at: noon(1, 11, 30), author: "Claude", subject: "scenery-github-agent: a PR body names its own diff", agent: "scenery-github-agent", dirs: ["scenery"], files: 2 },
    // …everything from here down is what THIS build already has
    { sha: MY_SHA, at: noon(1, 11), author: "Claude", subject: "games: the build I am running", agent: "games", dirs: ["games2"], files: 2 },
    { sha: "fffffff66", at: noon(1, 10), author: "Claude", subject: "ambient: older still", agent: "ambient", dirs: ["games2"], files: 1 },
  ],
};

const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
let serveNotes = true;
await page.route("**/release_notes.json*", async (route) => {
  if (!serveNotes) return route.fulfill({ status: 404, body: "" });
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DOC) });
});
// GITHUB'S COMPARE, FOR A LANE PUBLISH (section 9): the fixture answer is
// oldest-first exactly as the API sends it; the dialog must reverse it. `ghMode`
// flips it to a failure; `ghCalls` proves a served sha INSIDE the file never
// asks GitHub at all.
const LANE_SHA = "fb1eb5fbc";
const GH = {
  status: "ahead",
  total_commits: 3,
  commits: [
    { sha: "1111111aa", commit: { message: "Fix typo in README\n\nlonger body", author: { name: "Mikael Flodén", date: noon(0, 12, 40) } } },
    { sha: "2222222bb", commit: { message: "board: games-perf claims the effects' frame cost", author: { name: "games-perf agent", date: noon(0, 12, 45) } } },
    { sha: "3333333cc", commit: { message: "monsters: sand_scorpling die north-east re-rolled on his redo", author: { name: "claude[bot]", date: noon(0, 12, 50) } } },
  ],
};
let ghMode = "ok";
let ghCalls = 0;
const ghUrls = [];
await page.route("**/api.github.com/repos/**", async (route) => {
  ghCalls++;
  ghUrls.push(route.request().url());
  if (ghMode !== "ok") return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(GH) });
});
await page.goto(`${BASE}/`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlUpdateNotes, null, { timeout: 25000 });
// …with the CHARACTER SELECT up: the dialog lives on document.body, above
// every screen, so this is the same code the in-game case runs (section 7).
await page.waitForFunction(() => window.__mlSelect && document.querySelector(".ml-overlay"), null, { timeout: 25000 });

const dlg = () =>
  page.evaluate(() => {
    const back = document.querySelector(".ml-upd-back");
    if (!back) return null;
    const card = back.querySelector(".ml-upd");
    return {
      backZ: getComputedStyle(back).zIndex,
      sub: back.querySelector(".ml-upd-sub")?.textContent?.trim() ?? "",
      shaChip: back.querySelector(".ml-upd-sha")?.textContent?.trim() ?? "",
      areas: [...back.querySelectorAll(".ml-upd-areas span")].map((e) => e.textContent.trim()),
      days: [...back.querySelectorAll(".ml-upd-day")].map((e) => e.textContent.trim()),
      // DIRECT children of the list only: the "you are running" block holds a
      // row too, and it is deliberately not one of the changes — every count,
      // colour and range check below is about the changes.
      rows: [...back.querySelectorAll(".ml-upd-list > .ml-upd-row")].map((e) => ({
        area: e.querySelector(".ml-upd-chip").textContent.trim(),
        subj: e.querySelector(".ml-upd-subj").textContent.trim(),
        meta: e.querySelector(".ml-upd-meta").textContent.trim(),
      })),
      note: back.querySelector(".ml-upd-note")?.textContent?.trim() ?? "",
      buttons: [...back.querySelectorAll(".ml-upd-btn")].map((b) => b.textContent.trim()),
      text: back.textContent,
      // …and the same for the text sweep that proves nothing older leaked in
      listText: [...back.querySelectorAll(".ml-upd-list > .ml-upd-row, .ml-upd-list > .ml-upd-day")].map((e) => e.textContent).join(" "),
      cardH: Math.round(card.getBoundingClientRect().height),
      // the four 2026-09-19 fixes
      loading: !!back.querySelector(".ml-upd-load"),
      mine: (() => {
        const m = back.querySelector(".ml-upd-mine");
        if (!m) return null;
        const list = back.querySelector(".ml-upd-list");
        const label = m.querySelector(".ml-upd-youre");
        const row = m.querySelector(".ml-upd-row");
        const cs = getComputedStyle(row);
        return {
          label: label?.textContent.trim() ?? "",
          text: m.textContent.trim(),
          last: list.lastElementChild === m,
          bg: cs.backgroundColor, bd: cs.borderTopColor,
          sha: m.querySelector(".ml-upd-meta")?.textContent.trim() ?? "",
        };
      })(),
      dayBand: (() => {
        const h = back.querySelector(".ml-upd-day");
        if (!h) return null;
        const list = back.querySelector(".ml-upd-list");
        const cs = getComputedStyle(h), ls = getComputedStyle(list);
        const hb = h.getBoundingClientRect(), lb = list.getBoundingClientRect();
        return {
          position: cs.position, z: cs.zIndex, bg: cs.backgroundColor,
          // full bleed: the band must reach the list's own edges, not stop at
          // its padding, or a row shows through the gutters as it scrolls past
          left: Math.round(hb.left - lb.left), right: Math.round(lb.right - hb.right),
          momentum: ls.webkitOverflowScrolling || "(unset)",
          listBg: ls.backgroundColor,
        };
      })(),
      vh: window.innerHeight,
    };
  });
const openIt = async (mine = MY_SHA) => {
  await page.evaluate(([n, m]) => window.__mlUpdateNotes.open(n, m), [NEW_SHA, mine]);
  await page.waitForFunction(() => {
    const s = document.querySelector(".ml-upd-sub")?.textContent ?? "";
    return s && !s.includes("Loading");
  }, null, { timeout: 10000 }).catch(() => {});
  return dlg();
};

// ── 1. THE RANGE: everything after my build, and nothing at or before it ──
{
  const d = await openIt();
  if (!d) fail("the dialog did not open");
  else {
    d.shaChip === NEW_SHA ? ok(`the served build is named in the header (${d.shaChip})`) : fail(`sha chip "${d.shaChip}"`);
    /5 changes since your build eeeeeee55/.test(d.sub)
      ? ok(`the count is the range, not the file (${d.sub})`)
      : fail(`subtitle "${d.sub}" — want "5 changes since your build eeeeeee55"`);
    // the two commits this build already has must not appear, by any part of them
    !/the build I am running|older still|fffffff66/.test(d.listText)
      ? ok("nothing from before this build leaked into the CHANGES")
      : fail("a commit at or older than the running build is listed as a change");
    // …and the newer ones all did
    const subjects = d.rows.map((r) => r.subj);
    subjects.some((s) => /thumb row balances/.test(s)) && subjects.some((s) => /span's new lane/.test(s))
      ? ok(`every newer commit is listed (${d.rows.length} rows from 5 commits)`)
      : fail(`rows: ${JSON.stringify(subjects)}`);
    d.note === "" ? ok("no truncation note when the build is inside the window") : fail(`unexpected note "${d.note}"`);
  }
}

// ── 2. READABILITY: day groups, area chips, the chip's token stripped off the
//       front of the subject, and a repeated subject collapsed to a count ──
{
  const d = await dlg();
  d.days.join("|") === "Today|Yesterday"
    ? ok(`grouped by day, newest first (${d.days.join(" / ")})`)
    : fail(`day headers ${JSON.stringify(d.days)} — want Today then Yesterday`);
  const first = d.rows[0];
  // HIS NAME FOR THE BOARD, not its filename (maintainer 2026-09-19).
  first.area === "UI" && first.subj === "the thumb row balances on its inner gaps"
    ? ok(`the chip carries HIS name for the agent, and the subject drops the token it repeats ("${first.area}" / "${first.subj}")`)
    : fail(`first row ${JSON.stringify(first)} — want the area "UI"`);
  const gh = d.rows.find((r) => /GitHub/.test(r.area));
  gh && gh.area === "Scenery GitHub"
    ? ok(`a <domain>-github-agent board reads as "${gh.area}" — the suffix is DERIVED, so the next one needs no entry`)
    : fail(`the github agent's chip: ${JSON.stringify(gh)} — want "Scenery GitHub"`);
  d.rows.some((r) => r.area === "Map") ? ok('maps2 reads as "Map"') : fail(`no "Map" chip in ${JSON.stringify(d.rows.map((r) => r.area))}`);
  const live = d.rows.find((r) => r.area === "Live");
  live && /×2$/.test(live.subj) && /admin update/.test(live.subj)
    ? ok(`a repeated subject collapses to a count ("${live.subj}")`)
    : fail(`the two identical live commits did not collapse: ${JSON.stringify(d.rows)}`);
  d.rows.length === 4
    ? ok("5 commits render as 4 rows")
    : fail(`${d.rows.length} rows from 5 commits with one duplicate pair`);
  /^\d{1,2}[:.]\d{2}.*aaaaaaaa1$/.test(first.meta.replace(/\s/g, " ").trim())
    ? ok(`each row carries its time and sha (${first.meta})`)
    : fail(`row meta "${first.meta}" — want "HH:MM · <sha>"`);
  const summary = d.areas.join(" ");
  /Live 2/.test(summary) && /UI 1/.test(summary) && /Map 1/.test(summary)
    ? ok(`the header summarises the areas by his names, most first (${summary})`)
    : fail(`area summary ${JSON.stringify(d.areas)}`);
  // THE CHIPS FOLLOW THE CSS (maintainer 2026-09-19: "I don't like the pill
  // colors (doesn't follow the CSS)"). Asserted against the THEME's own
  // computed tokens, never literals: every chip — rows and summary — is
  // --surface-2 on --border with --muted ink, the sha chip's own recipe. A
  // re-introduced per-area palette fails here.
  const paint = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const probe = (v) => {
      const d = document.createElement("div");
      d.style.color = cs.getPropertyValue(v).trim();
      document.body.appendChild(d);
      const c = getComputedStyle(d).color;
      d.remove();
      return c;
    };
    const want = { bg: probe("--surface-2"), fg: probe("--muted"), bd: probe("--border") };
    // the "you are running" block wears the accent ON PURPOSE — it is the one
    // thing in here that is not a change, so it is not held to the chip recipe
    const chips = [...document.querySelectorAll(".ml-upd-list > .ml-upd-row .ml-upd-chip, .ml-upd-areas span")].map((e) => {
      const g = getComputedStyle(e);
      return { text: e.textContent, bg: g.backgroundColor, fg: g.color, bd: g.borderTopColor };
    });
    const sg = getComputedStyle(document.querySelector(".ml-upd-sha"));
    return { want, chips, sha: { bg: sg.backgroundColor, fg: sg.color } };
  });
  const offPalette = paint.chips.filter((c) => c.bg !== paint.want.bg || c.fg !== paint.want.fg || c.bd !== paint.want.bd);
  offPalette.length === 0 && paint.chips.length >= 6
    ? ok(`all ${paint.chips.length} chips wear the theme's own tokens (${paint.want.bg} on ${paint.want.bd}, ${paint.want.fg} ink)`)
    : fail(`${offPalette.length} chip(s) do not follow the CSS: ${JSON.stringify(offPalette.slice(0, 3))} — want ${JSON.stringify(paint.want)}`);
  paint.sha.bg === paint.want.bg
    ? ok("…the same recipe as the sha chip beside the title")
    : fail(`the sha chip is ${paint.sha.bg}, the area chips ${paint.want.bg}`);
  d.cardH <= d.vh - 32
    ? ok(`the card fits the phone with the list scrolling inside it (${d.cardH} of ${d.vh})`)
    : fail(`card ${d.cardH}px on a ${d.vh}px viewport`);

  // ── THE CARD OPENS AT ITS FINAL SIZE, AND THE SIZE FITS THE LIST ──────
  // Maintainer 2026-09-19, on a dialog that opened full-height and empty:
  // "We need to know the best dialog size when we open/before we open the
  // dialog… some versions with only a small number of changes can use a
  // smaller dialog and some with lots of changes uses a taller dialog with
  // scroll. The key here is we have the data already when we create the
  // dialog." So two claims: it NEVER resizes after opening (measured across a
  // second), and a SHORT list gets a SHORT card — the fixed height that
  // preceded this satisfied the first and failed the second, which is how it
  // reached his phone.
  {
    await page.evaluate(() => window.__mlUpdateNotes.close());
    await page.evaluate(() => window.__mlUpdateNotes.prefetch());
    await page.waitForTimeout(400); // the notes land before the dialog is asked for
    const big = await page.evaluate(async ([n, m]) => {
      window.__mlUpdateNotes.open(n, m);
      const card = document.querySelector(".ml-upd");
      const at0 = Math.round(card.getBoundingClientRect().height);
      await new Promise((r) => setTimeout(r, 900));
      return { at0, at1: Math.round(card.getBoundingClientRect().height), loader: !!document.querySelector(".ml-upd-load"), rows: document.querySelectorAll(".ml-upd-list > .ml-upd-row").length };
    }, [NEW_SHA, MY_SHA]);
    big.at0 === big.at1 && !big.loader
      ? ok(`the card opens at its final size — ${big.at0}px with ${big.rows} rows, unchanged a second later, and no loading state at all`)
      : fail(`the card moved ${big.at0} -> ${big.at1}px or showed a loader (${JSON.stringify(big)})`);
    // …and a list of ONE is not given the height of a list of fifty
    await page.evaluate(() => window.__mlUpdateNotes.close());
    const small = await page.evaluate(async ([n, m]) => {
      window.__mlUpdateNotes.open(n, m);
      const card = document.querySelector(".ml-upd");
      const at0 = Math.round(card.getBoundingClientRect().height);
      await new Promise((r) => setTimeout(r, 600));
      return { at0, at1: Math.round(card.getBoundingClientRect().height), rows: document.querySelectorAll(".ml-upd-list > .ml-upd-row").length };
    }, [NEW_SHA, "bbbbbbbb2"]); // my build = the 2nd newest, so ONE change
    small.at0 === small.at1
      ? ok(`a one-change list opens at its own size too (${small.at0}px, ${small.rows} row), and does not move`)
      : fail(`the small card moved ${small.at0} -> ${small.at1}px`);
    small.at0 < big.at0
      ? ok(`…and it is SHORTER than the fifty-row card (${small.at0} < ${big.at0}px) — the size fits the list`)
      : fail(`a ${small.rows}-row card is ${small.at0}px and a ${big.rows}-row card ${big.at0}px — the dialog is not sizing to its content`);
    await page.evaluate(() => window.__mlUpdateNotes.close());
    await page.evaluate(([n, m]) => window.__mlUpdateNotes.open(n, m), [NEW_SHA, MY_SHA]);
    await page.waitForTimeout(300);
  }
  {
    const d2 = await dlg();
    // (2) THE DAY BAND IS OPAQUE AND FULL-BLEED, and the scroller carries no
    //     -webkit-overflow-scrolling, which is what painted rows over it.
    const b = d2.dayBand;
    if (!b) fail("no day heading to test");
    else {
      b.position === "sticky" && Number(b.z) >= 2
        ? ok(`the day band is sticky above the rows (z ${b.z})`)
        : fail(`day band position ${b.position}, z ${b.z}`);
      b.left <= 0 && b.right <= 0
        ? ok(`…and full-bleed, so nothing shows through the gutters (${b.left}/${b.right}px past the list's edges)`)
        : fail(`the band stops ${b.left}px/${b.right}px inside the list — a row scrolling past shows in that gap`);
      /rgba\(0, 0, 0, 0\)|transparent/.test(b.bg)
        ? fail(`the day band is transparent (${b.bg}) — rows will read through it`)
        : ok(`…and opaque (${b.bg})`);
      b.momentum === "(unset)" || b.momentum === "auto"
        ? ok("the list carries no -webkit-overflow-scrolling: that layer is what left pixels over the band")
        : fail(`-webkit-overflow-scrolling is "${b.momentum}" — it composites the scroller and strands the sticky band`);
    }
    // (3) YOUR OWN BUILD IS THE LAST THING, AND MARKED.
    const m = d2.mine;
    if (!m) fail("no 'you are running' block for the build we are on");
    else {
      m.last ? ok("your own build is the LAST thing in the list") : fail("the 'you are running' block is not last");
      /you are running/i.test(m.label)
        ? ok(`…under its own label ("${m.label}"), so it cannot read as one of the new commits`)
        : fail(`the block's label is "${m.label}"`);
      m.sha.includes(MY_SHA.slice(0, 9))
        ? ok(`…and it is MY build's own commit (${m.sha})`)
        : fail(`the block names ${m.sha}, not my build ${MY_SHA}`);
      const rowBg = await page.evaluate(() => getComputedStyle(document.querySelector(".ml-upd-list .ml-upd-row")).backgroundColor);
      m.bg !== rowBg
        ? ok(`…and it is painted differently from every other row (${m.bg} vs ${rowBg})`)
        : fail(`the 'you are running' row looks like an ordinary row (${m.bg})`);
    }
  }
  await page.screenshot({ path: `${OUT}/updatenotes.png` });
}

// ── 3. IT IS ABOVE EVERYTHING THAT CAN BE ON SCREEN. The toast that opens it
//       is z 100 (main.ts) and the select overlay is z 10 with its own
//       stacking context (its title veil is z 100 INSIDE that, and the cutout
//       band z 150 inside it) — a dialog under any of them is a dialog you
//       cannot use. Asserted by HIT TEST, not by reading the numbers, with a
//       stand-in toast at the real z. ──
{
  const overSelect = await page.evaluate(() => {
    const ov = document.querySelector(".ml-overlay");
    const card = document.querySelector(".ml-upd").getBoundingClientRect();
    const e = document.elementFromPoint(card.left + card.width / 2, card.top + 10);
    return { overlayUp: !!ov && getComputedStyle(ov).display !== "none", hit: e && e.closest(".ml-upd") ? "dialog" : e?.className || "none" };
  });
  overSelect.overlayUp && overSelect.hit === "dialog"
    ? ok("on the CHARACTER SELECT screen the dialog takes the tap (over the overlay, its veil and the cutout band)")
    : fail(`select screen: ${JSON.stringify(overSelect)}`);
  await page.evaluate(() => {
    const t = document.createElement("div");
    t.id = "ml-fake-toast";
    t.style.cssText = "position:fixed;inset:0;z-index:100;background:red";
    document.body.appendChild(t);
  });
  const hit = await page.evaluate(() => {
    const card = document.querySelector(".ml-upd").getBoundingClientRect();
    const e = document.elementFromPoint(card.left + card.width / 2, card.top + 10);
    return e ? (e.closest(".ml-upd") ? "dialog" : e.id || e.className) : "none";
  });
  await page.evaluate(() => document.getElementById("ml-fake-toast")?.remove());
  hit === "dialog" ? ok("the dialog takes the tap over a z-100 toast") : fail(`a z-100 layer covers the dialog (hit ${hit})`);
}

// ── 4. DISMISSAL: Later, the backdrop and Escape all close it ──
{
  const gone = async (how) => (await page.evaluate(() => !document.querySelector(".ml-upd-back"))) || fail(`${how} did not close the dialog`);
  await page.evaluate(() => [...document.querySelectorAll(".ml-upd-btn")].find((b) => b.textContent.trim() === "Later").click());
  await page.waitForTimeout(80);
  (await gone("Later")) === true && ok("Later closes it");
  await openIt();
  await page.evaluate(() => {
    const b = document.querySelector(".ml-upd-back").getBoundingClientRect();
    document.querySelector(".ml-upd-back").dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: b.left + 4, clientY: b.top + 4 }));
  });
  await page.waitForTimeout(80);
  (await gone("the backdrop")) === true && ok("a tap outside the card closes it");
  await openIt();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
  (await gone("Escape")) === true && ok("Escape closes it");
}

// ── 5. A BUILD OLDER THAN THE 50-COMMIT WINDOW says so instead of pretending
//       the list is the whole range ──
{
  const d = await openIt("0000000ff");
  d.rows.length === 6 && /the most recent ones/.test(d.sub) && /earlier changes/.test(d.note)
    ? ok(`a build outside the window shows what is known and says so (${d.rows.length} rows)`)
    : fail(`outside-window case: sub "${d.sub}", note "${d.note}", ${d.rows.length} rows`);
  await page.evaluate(() => window.__mlUpdateNotes.close());
}

// ── 6. NO NOTES, STILL AN UPDATE. The file is a nice-to-have; the reload is
//       the point, and a deploy whose context had no git publishes no list. ──
{
  // the fetch is memoised for the page's life (one fetch per deploy), so a
  // gate that wants the FIRST fetch to fail has to drop it first
  await page.evaluate(() => window.__mlUpdateNotes.forget());
  serveNotes = false;
  const d = await openIt();
  d && d.buttons.includes("Update now") && d.buttons.includes("Later") && /not published/.test(d.sub)
    ? ok(`no list published: the dialog still opens with both buttons (${d.sub})`)
    : fail(`404 case: ${JSON.stringify(d && { sub: d.sub, buttons: d.buttons })}`);
}

// ── 7. THE SAME DIALOG IN THE GAME (maintainer 2026-09-18: "same code! same
//       dialog!"). Enter the world and open the identical module over the
//       running scene: it must draw over the canvas and the HUD, list the same
//       range, and close without touching the game under it. ──
{
  serveNotes = true;
  // …and drop the 404 answer with it, or every open below reuses it
  await page.evaluate(() => window.__mlUpdateNotes.forget());
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 90000 });
  const before = await page.evaluate(() => ({ me: !!window.__ml.me(), hud: !!document.querySelector(".ml-hud") }));
  const d = await openIt();
  if (!d) fail("the dialog did not open in the game");
  else {
    /5 changes since your build/.test(d.sub) && d.rows.length === 4
      ? ok(`in the GAME the same dialog lists the same range (${d.rows.length} rows, "${d.sub}")`)
      : fail(`in-game contents differ from the select screen: sub "${d.sub}", ${d.rows.length} rows`);
    const hit = await page.evaluate(() => {
      const card = document.querySelector(".ml-upd").getBoundingClientRect();
      const mid = document.elementFromPoint(card.left + card.width / 2, card.top + card.height / 2);
      const out = document.elementFromPoint(4, Math.round(window.innerHeight / 2));
      return { mid: mid && mid.closest(".ml-upd") ? "dialog" : mid?.tagName || "none", outside: out?.tagName || "none" };
    });
    hit.mid === "dialog" && hit.outside !== "CANVAS"
      ? ok(`it draws over the canvas and the HUD, and the backdrop swallows taps meant for the world (outside hits ${hit.outside})`)
      : fail(`in-game stacking: ${JSON.stringify(hit)}`);
    await page.screenshot({ path: `${OUT}/updatenotes-ingame.png` }); // WITH it open — the artifact has to show what it is named for
    await page.evaluate(() => window.__mlUpdateNotes.close());
    const after = await page.evaluate(() => ({ me: !!window.__ml.me(), hud: !!document.querySelector(".ml-hud"), dlg: !!document.querySelector(".ml-upd-back") }));
    before.me && after.me && after.hud && !after.dlg
      ? ok("closing it leaves the game exactly as it was")
      : fail(`after closing in-game: ${JSON.stringify({ before, after })}`);
  }
}

// ── 8. "Update now" RELOADS — and FROM THE WORLD IT COMES BACK INTO THE
//       WORLD (maintainer 2026-09-19: "If I'm inside the game… press upgrade
//       [and] the game restarts and I'm back at the title-screen/character
//       select. It would be much smoother to first reload the game of course,
//       but then immediately get into loading the game"). Asserted end to end,
//       through a real reload, because the claim is about where you END UP —
//       a test of the flag alone would pass on a build that set it and then
//       ignored it. Section 7 left us in the world, which is the case. ──
{
  const inWorld = await page.evaluate(() => document.documentElement.classList.contains("ml-ingame"));
  inWorld ? ok("…and we are in the world for the update test") : fail("section 8 expects to be in the world");
  await openIt();
  await page.evaluate(() => { window.__stillHere = true; });
  await page.evaluate(() => [...document.querySelectorAll(".ml-upd-btn")].find((b) => b.textContent.trim() === "Update now").click());
  const reloaded = await page
    .waitForFunction(() => window.__mlUpdateNotes && !window.__stillHere, null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  reloaded ? ok("Update now reloads the page") : fail("Update now did not reload");
  // NOBODY COMMITS A CHARACTER HERE. If the world comes back, it came back on
  // its own — the select screen was skipped.
  const back = await page
    .waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 })
    .then(() => true)
    .catch(() => false);
  const state = await page.evaluate(() => ({
    ingame: document.documentElement.classList.contains("ml-ingame"),
    select: !!document.querySelector(".ml-overlay"),
    flag: sessionStorage.getItem("ml-rejoin"),
  }));
  back && state.ingame && !state.select
    ? ok("…and it lands back IN THE WORLD, not on the character select — nothing committed a character")
    : fail(`after the update reload: ${JSON.stringify({ back, ...state })}`);
  state.flag === null
    ? ok("…with the ml-rejoin flag consumed, so an ordinary later reload still shows the select screen")
    : fail(`ml-rejoin is still "${state.flag}" after the fast path ran — the next manual reload would skip the select screen too`);
}

// ── 9. …AND FROM THE SELECT SCREEN IT DOES NOT. The same dialog opens over
//       the character select; resuming there would skip the very screen he is
//       standing on. A fresh page puts us back on it. ──
{
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlUpdateNotes && window.__mlSelect, null, { timeout: 25000 });
  await page.waitForTimeout(400);
  await page.evaluate(([n, m]) => window.__mlUpdateNotes.open(n, m), [NEW_SHA, MY_SHA]);
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.__stillHere = true; });
  await page.evaluate(() => [...document.querySelectorAll(".ml-upd-btn")].find((b) => b.textContent.trim() === "Update now").click());
  await page.waitForFunction(() => window.__mlUpdateNotes && !window.__stillHere, null, { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({
    select: !!document.querySelector(".ml-overlay"),
    ingame: document.documentElement.classList.contains("ml-ingame"),
    flag: sessionStorage.getItem("ml-rejoin"),
  }));
  after.select && !after.ingame && after.flag === null
    ? ok("updating from the character select comes back to the character select — the flag is never set there")
    : fail(`after updating from the select screen: ${JSON.stringify(after)}`);
}

// 9) A LANE PUBLISH IS AHEAD OF THE NOTES FILE (maintainer 2026-09-23: "I still
//    get 'New version out' dialogs that are empty!"). His case exactly: the
//    client IS the file's head (built from the image), /version says a sha the
//    file has never heard of (a fast/art-lane generation on top of that image).
//    The slice after the head is empty by construction; the dialog asks the
//    repo's compare endpoint for mine...new and paints THAT.
{
  await page.waitForFunction(() => window.__mlUpdateNotes, null, { timeout: 25000 });
  ghCalls === 0
    ? ok("a served sha the file already lists never asks GitHub (0 calls through eight sections)")
    : fail(`GitHub was asked ${ghCalls} time(s) while the served sha was inside the file: ${ghUrls.join(" ")}`);
  await page.evaluate(() => window.__mlUpdateNotes.close());
  await page.evaluate(([n, m]) => window.__mlUpdateNotes.open(n, m), [LANE_SHA, NEW_SHA]);
  await page.waitForFunction(() => document.querySelectorAll(".ml-upd-list > .ml-upd-row").length >= 3, null, { timeout: 8000 }).catch(() => {});
  const lane = await page.evaluate(() => {
    const back = document.querySelector(".ml-upd-back");
    return {
      sub: back.querySelector(".ml-upd-sub").textContent,
      chip: back.querySelector(".ml-upd-sha").textContent,
      rows: [...back.querySelectorAll(".ml-upd-list > .ml-upd-row")].map((e) => ({
        area: e.querySelector(".ml-upd-chip").textContent,
        subj: e.querySelector(".ml-upd-subj").textContent,
        meta: e.querySelector(".ml-upd-meta").textContent,
      })),
      mine: !!back.querySelector(".ml-upd-mine"),
      summary: [...back.querySelectorAll(".ml-upd-areas span")].map((e) => e.textContent),
    };
  });
  ghCalls === 1 && /compare\/aaaaaaaa1\.\.\.fb1eb5fbc$/.test(ghUrls[0] ?? "")
    ? ok(`the dialog asked GitHub for exactly mine...new, once (${(ghUrls[0] ?? "").split("/repos/")[1]})`)
    : fail(`GitHub calls: ${ghCalls} ${ghUrls.join(" ")}`);
  lane.rows.length === 3 && /^3 changes since your build aaaaaaaa1/.test(lane.sub)
    ? ok(`the lane's three commits are listed and counted ("${lane.sub}")`)
    : fail(`lane rows ${lane.rows.length}, sub "${lane.sub}"`);
  lane.rows[0] && /3333333cc/.test(lane.rows[0].meta) && /1111111aa/.test(lane.rows[2]?.meta ?? "")
    ? ok("…newest first — GitHub's oldest-first order is reversed")
    : fail(`row order: ${lane.rows.map((r) => r.meta).join(" | ")}`);
  const areas = lane.rows.map((r) => r.area);
  areas[0] === "Monster" && areas[1] === "Optimization" && areas[2] === "Repo"
    ? ok(`the chips come from the subjects' own prefixes: ${areas.join(", ")} ("board: games-perf …" reads as the board it names; an unprefixed subject is Repo, not a guess)`)
    : fail(`chips ${JSON.stringify(areas)}, want Monster, Optimization, Repo`);
  lane.rows[0] && lane.rows[0].subj.startsWith("sand_scorpling")
    ? ok(`the prefix the chip already says is dropped from the subject ("${lane.rows[0].subj}")`)
    : fail(`subject "${lane.rows[0]?.subj}"`);
  lane.chip === LANE_SHA && lane.mine
    ? ok("the header names the served sha and the 'you are running' block still stands (my build is in the file)")
    : fail(`chip ${lane.chip}, mine-block ${lane.mine}`);
  // …and when GitHub does not answer, the sentence says so instead of "nothing"
  ghMode = "down";
  await page.evaluate(() => window.__mlUpdateNotes.close());
  await page.evaluate(([n, m]) => window.__mlUpdateNotes.open(n, m), [LANE_SHA, NEW_SHA]);
  await page.waitForFunction(() => /GitHub did not answer/.test(document.querySelector(".ml-upd-sub")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
  const down = await page.evaluate(() => ({
    sub: document.querySelector(".ml-upd-sub").textContent,
    rows: document.querySelectorAll(".ml-upd-list > .ml-upd-row").length,
    go: !!document.querySelector(".ml-upd-btn.go"),
  }));
  /live update on top of it; GitHub did not answer/.test(down.sub) && down.rows === 0 && down.go
    ? ok(`GitHub down: the dialog says why and the Update button is still there ("${down.sub}")`)
    : fail(`GitHub down: ${JSON.stringify(down)}`);
  ghMode = "ok";
  await page.evaluate(() => window.__mlUpdateNotes.close());
}

await browser.close();
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
