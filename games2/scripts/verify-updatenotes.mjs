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
      rows: [...back.querySelectorAll(".ml-upd-row")].map((e) => ({
        area: e.querySelector(".ml-upd-chip").textContent.trim(),
        subj: e.querySelector(".ml-upd-subj").textContent.trim(),
        meta: e.querySelector(".ml-upd-meta").textContent.trim(),
      })),
      note: back.querySelector(".ml-upd-note")?.textContent?.trim() ?? "",
      buttons: [...back.querySelectorAll(".ml-upd-btn")].map((b) => b.textContent.trim()),
      text: back.textContent,
      cardH: Math.round(card.getBoundingClientRect().height),
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
    !/the build I am running|older still|fffffff66/.test(d.text)
      ? ok("nothing from before this build leaked into the list")
      : fail("a commit at or older than the running build is listed");
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
    const chips = [...document.querySelectorAll(".ml-upd-chip, .ml-upd-areas span")].map((e) => {
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

// ── 8. "Update now" RELOADS. Proven by a marker that cannot survive one. ──
{
  await openIt();
  await page.evaluate(() => { window.__stillHere = true; });
  await page.evaluate(() => [...document.querySelectorAll(".ml-upd-btn")].find((b) => b.textContent.trim() === "Update now").click());
  const reloaded = await page
    .waitForFunction(() => window.__mlUpdateNotes && !window.__stillHere, null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  reloaded ? ok("Update now reloads the page") : fail("Update now did not reload");
}

await browser.close();
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
