#!/usr/bin/env node
/* A NEW MONSTER IS JUDGED ON ITS 8 DIRECTIONS BEFORE IT EARNS ANIMATIONS
 * (maintainer 2026-09-09: "the first step before generating a monster is
 * generating a character in 8 directions. If you are happy with this
 * character you can go on and generate all animations needed. So we need a
 * way for me to see and review monsters in this early 8 dir only state.")
 *
 * Drives the two pages on a 393px phone against the local harness:
 *   node wiki/tools/serve-assets.mjs 8902   (+ serve-repo.mjs 8903 for admin)
 *   node wiki/tools/check-candidates.mjs
 * Asserts: the Creatures page carries the door with the unjudged count; the
 * list shows every candidate under "all" and only the unjudged under the
 * default chip; a candidate page shows all 8 facings as loaded images, two
 * per row; approve writes a verdict stamped with the candidate's version and
 * moves it out of "to judge"; redo and remove are on the row; a verdict
 * stamped with an OLDER version reads as "judge again". */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
const SANDBOX = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const EXE = process.env.CHROMIUM_PATH || (existsSync(SANDBOX) ? SANDBOX : "");
const URL_ = process.env.WIKI_URL ?? "http://127.0.0.1:8902";
const W = `${URL_}/assets/wiki/site/index.html`;
const DATA = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const CANDS = DATA.domains?.monsterCandidates ?? [];
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? "ok" : "FAIL"}: ${msg}`); if (!c) fails++; };
if (!CANDS.length) { console.log("no candidates in the registry — nothing to drive"); process.exit(0); }

const b = await chromium.launch(EXE ? { executablePath: EXE } : {});
const ctx = await b.newContext({ viewport: { width: 393, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
  localStorage.removeItem("wiki-cand-filter");
});
const shot = process.env.SHOT_DIR;

// CREATURES AND CANDIDATES ARE TWO TABS OF ONE SECTION, and nothing on screen
// moves between them (maintainer 2026-09-10: "the Creatures/Candidates should
// be a tab and not a warning div. Also when clicking on Candidates now the
// breadcrumb 'jumps' compared to the Creatures page").
const headOf = () => p.evaluate(() => {
  const h1 = document.querySelector("h1"), crumb = document.querySelector(".crumb"), bar = document.querySelector('[data-bar="wiki-creature-tab"]');
  return { title: h1?.textContent, h1y: Math.round(h1?.getBoundingClientRect().top ?? -1), crumbY: Math.round(crumb?.getBoundingClientRect().top ?? -1),
    tabsY: bar ? Math.round(bar.getBoundingClientRect().top) : -1,
    tabs: [...(bar?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim() + (b.classList.contains("sel") ? "*" : "")) };
});
await p.goto(`${W}#/monsters`, { waitUntil: "load" });
await p.waitForTimeout(2500);
const headA = await headOf();
console.log("creatures head:", JSON.stringify(headA));
ok(headA.tabs.length === 2 && /^Creatures \d+\*$/.test(headA.tabs[0]) && /^Candidates \d+$/.test(headA.tabs[1]),
  `the Creatures page opens on a two-tab row (${headA.tabs.join(" | ")})`);

await p.evaluate(() => document.querySelector('[data-bar="wiki-creature-tab"] button:nth-child(2)')?.click());
await p.waitForTimeout(1400);
const headB = await headOf();
console.log("candidates head:", JSON.stringify(headB));
ok(headB.title === "Candidates" && headB.tabs[1].endsWith("*"), `the second tab opens Candidates (${headB.tabs.join(" | ")})`);
ok(headA.crumbY === headB.crumbY && headA.h1y === headB.h1y && headA.tabsY === headB.tabsY,
  `and the crumb, the title and the tabs do not move between the two (${headA.crumbY}/${headA.h1y}/${headA.tabsY} → ${headB.crumbY}/${headB.h1y}/${headB.tabsY})`);
const list = await p.evaluate(() => ({
  chips: [...document.querySelectorAll('[data-bar="wiki-cand-filter"] .sortbar-btn')].map((x) => x.textContent.trim()),
  sel: document.querySelector('[data-bar="wiki-cand-filter"] .sortbar-btn.sel')?.dataset.sort,
  cards: document.querySelectorAll(".cand-card").length,
}));
console.log("list:", JSON.stringify(list));
ok(list.chips.length === 5 && list.sel === "pending", `five filter chips, "to judge" selected by default (${list.chips.join(" | ")})`);
if (shot) await p.screenshot({ path: `${shot}/cand-list.png` });
await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-cand-filter"] .sortbar-btn')].find((x) => x.dataset.sort === "all")?.click());
await p.waitForTimeout(600);
const nAll = await p.evaluate(() => document.querySelectorAll(".cand-card").length);
ok(nAll === CANDS.length, `"all" shows every candidate (${nAll} of ${CANDS.length})`);

// TRUE SCALE IS THE POINT OF THIS GRID (maintainer 2026-09-10: "It's important
// when I scroll the candidates overview I can see the monster in the correct
// scale ... In the monster overview we get bigger cards for bigger monsters").
// One zoom for every card, so the ratio between two cards IS the ratio between
// the two designs — and the big ones claim more cells.
const grid = await p.evaluate(() => {
  const g = document.querySelector(".showcase-grid");
  const arts = [...document.querySelectorAll(".cand-card .showcase-art")];
  const size = (a, k) => (a.dataset[k] ?? "0x0").split("x").map(Number);
  const rows = arts.map((a) => ({ raw: size(a, "raw"), drawn: size(a, "drawn"), zoom: a.dataset.zoom }));
  const spans = {};
  for (const c of document.querySelectorAll(".cand-card")) spans[c.dataset.span] = (spans[c.dataset.span] ?? 0) + 1;
  rows.sort((x, y) => x.raw[1] - y.raw[1]);
  return { zoom: g?.dataset.zoom, zooms: [...new Set(rows.map((r) => r.zoom))], spans, n: rows.length,
    small: rows[0], big: rows[rows.length - 1],
    wide: document.documentElement.scrollWidth > document.documentElement.clientWidth };
});
console.log("grid:", JSON.stringify(grid));
ok(grid.zooms.length === 1 && Number(grid.zoom) > 0 && Number(grid.zoom) <= 2,
  `every card on the grid is drawn at ONE zoom, never above the game's 2× (${grid.zoom}×)`);
const ratio = (a) => a.drawn[1] / a.raw[1];
ok(Math.abs(ratio(grid.small) - ratio(grid.big)) < 0.001 && grid.big.drawn[1] > grid.small.drawn[1] * 2,
  `so the biggest design really draws bigger than the smallest (${grid.small.raw.join("×")}→${grid.small.drawn.join("×")} vs ${grid.big.raw.join("×")}→${grid.big.drawn.join("×")})`);
ok((grid.spans["1x1"] ?? 0) > 0 && Object.keys(grid.spans).some((k) => k !== "1x1"),
  `and a bigger design claims more cells (${JSON.stringify(grid.spans)})`);
ok(!grid.wide, "the overview never scrolls sideways on a 393px phone");

// He judges from the queue, so the gate does: the first card still to judge.
await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-cand-filter"] .sortbar-btn')].find((x) => x.dataset.sort === "pending")?.click());
await p.waitForTimeout(600);
const firstId = await p.evaluate(() => document.querySelector(".cand-card")?.getAttribute("href")?.split("/").pop());
const cand = CANDS.find((c) => c.id === firstId);
ok(!!cand, `the first card opens a candidate the registry knows (${firstId})`);
await p.evaluate((id) => { location.hash = `#/monsters/candidates/${id}`; }, firstId);
await p.waitForTimeout(2500);
const det = await p.evaluate(() => {
  const imgs = [...document.querySelectorAll(".cand-dir img")];
  const rows = new Set(imgs.map((i) => Math.round(i.getBoundingClientRect().top)));
  return {
    n: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    dirs: [...document.querySelectorAll(".cand-dir")].map((f) => f.dataset.dir),
    rows: rows.size, w: imgs[0]?.getBoundingClientRect().width,
    wide: document.documentElement.scrollWidth > document.documentElement.clientWidth
      || (() => { const g = document.querySelector(".cand-dirs"); return g.scrollWidth > g.clientWidth; })(),
    cols: getComputedStyle(document.querySelector(".cand-dirs")).getPropertyValue("--cand-cols").trim(),
    // THE PICTURE IS NEVER SMALL AND THE LABEL IS NEVER ON IT (maintainer
    // 2026-09-10: "when I click on a monster the preview is so small the text
    // is covering the monster" — a 32px design was a 64px stamp under its own
    // caption).
    shot: (() => {
      const f = document.querySelector(".cand-dir"), img = f?.querySelector("img"), cap = f?.querySelector("figcaption");
      const ir = img?.getBoundingClientRect(), cr = cap?.getBoundingClientRect();
      const shot = f?.querySelector(".cand-shot"), col = document.querySelector("#content"), ccs = col && getComputedStyle(col);
      return { w: Math.round(ir?.width ?? 0), over: !!(ir && cr) && !(cr.top >= ir.bottom - 0.5 || cr.bottom <= ir.top + 0.5), capH: Math.round(cr?.height ?? 0),
        box: Math.round(shot?.getBoundingClientRect().width ?? 0),
        room: col ? Math.round(col.clientWidth - parseFloat(ccs.paddingLeft) - parseFloat(ccs.paddingRight)) : 0,
        z: Number(document.querySelector(".cand-zoom button.on")?.title.match(/at ([\d.]+)×/)?.[1] ?? 0) };
    })(),
    zooms: [...document.querySelectorAll(".cand-zoom button")].map((b) => b.textContent.trim() + (b.classList.contains("on") ? "*" : "")),
    size: (() => { const t = document.querySelector("p.muted")?.textContent.match(/(\d+)px/); return t ? Number(t[1]) : 0; })(),
    buttons: [...document.querySelectorAll(".cand-judge .verdict button")].map((x) => x.textContent.trim()),
    stars: document.querySelectorAll(".cand-judge .stars button, .cand-judge .star").length,
  };
});
console.log("detail:", JSON.stringify(det));
ok(det.n === 8 && det.loaded === 8, `all 8 facings are on the page and loaded (${det.loaded}/${det.n})`);
ok(det.cols === "2" ? det.rows === 4 : det.rows === 8, `mirror pairs side by side when two fit, stacked when they don't (${det.cols} column(s), ${det.rows} rows, ${det.w}px each)`);
ok(det.dirs.join(",") === "south,north,east,west,south-east,south-west,north-east,north-west", `in mirror-pair order (${det.dirs.join(" ")})`);
ok(!det.wide, "the facings never poke past a 393px phone");
ok(det.zooms.map((x) => x.replace("*", "")).join(" ") === "same 1× 2× 4×",
  `the zoom chips are the creature page's own — same 1× 2× 4×, "same" selected (${det.zooms.join(" ")})`);
ok(det.shot.box >= 200 && det.shot.box <= det.shot.room + 1,
  `the facing box is big and never wider than the column (${det.shot.box}px in ${det.shot.room}px, zooms ${det.zooms.join(" ")})`);
ok(Math.abs(det.shot.w / det.size - det.shot.z) < 0.001,
  `and the creature is drawn at the page's ONE true zoom, never fitted to its box (${det.size}px canvas → ${det.shot.w}px at ${det.shot.z}×)`);
ok(!det.shot.over && det.shot.capH > 0 && det.shot.capH < 30, `and its label sits UNDER the art, one line, never over it (${det.shot.capH}px)`);
ok(det.buttons.length === 3 && /approve/.test(det.buttons[0]) && /remove/.test(det.buttons[1]) && /redo/.test(det.buttons[2]), `approve / remove / redo on the row (${det.buttons.join(" | ")})`);
if (shot) await p.screenshot({ path: `${shot}/cand-detail.png` });

// APPROVE stamps the version and leaves the queue.
await p.evaluate(() => [...document.querySelectorAll(".cand-judge .verdict button")].find((x) => /approve/.test(x.textContent))?.click());
await p.waitForTimeout(400);
const entry = await p.evaluate((path) => JSON.parse(JSON.stringify(window.__wiki?.state?.feedback?.monsters?.entries?.[path] ?? null)), cand.path);
console.log("entry:", JSON.stringify(entry));
ok(entry && entry.status === "approved" && entry.version === cand.version && entry.rating === 1,
  `approve writes {status: approved, version: ${cand.version}, rating: 1} under ${cand.path}`);
await p.evaluate(() => { location.hash = "#/monsters/candidates"; });
await p.waitForTimeout(800);
await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-cand-filter"] .sortbar-btn')].find((x) => x.dataset.sort === "pending")?.click());
await p.waitForTimeout(600);
const stillPending = await p.evaluate((id) => !![...document.querySelectorAll(".cand-card")].find((a) => a.getAttribute("href").endsWith(`/${id}`)), firstId);
ok(!stillPending, "and the approved one has left \"to judge\"");

// A verdict on an OLDER version is a verdict on art that no longer exists.
await p.evaluate((path) => { const e = window.__wiki.state.feedback.monsters.entries[path]; e.version = (e.version ?? 1) - 1; }, cand.path);
await p.evaluate((id) => { location.hash = `#/monsters/candidates/${id}`; }, firstId);
await p.waitForTimeout(1200);
const stale = await p.evaluate(() => ({
  pill: [...document.querySelectorAll(".pill")].some((x) => /judge again/.test(x.textContent)),
  approved: !!document.querySelector(".cand-judge .verdict button.approved"),
}));
ok(stale.pill && !stale.approved, `an older-version verdict reads as "judge again" and the approve button is not lit (${JSON.stringify(stale)})`);

// THE SMALLEST DESIGN IS THE CASE HE HIT: at true size it must stay small, in
// the same box a big one fills (maintainer 2026-09-10: "11x zoom? WTF. I want
// to see it in the true size always!").
const small = [...CANDS].sort((a, b) => (a.size?.[0] ?? 0) - (b.size?.[0] ?? 0))[0];
const big = [...CANDS].sort((a, b) => (b.size?.[0] ?? 0) - (a.size?.[0] ?? 0))[0];
const seen = {};
for (const c of [small, big]) {
  await p.evaluate((id) => { localStorage.setItem("wiki-cand-zoom", "same"); location.hash = `#/monsters/candidates/${id}`; }, c.id);
  await p.waitForTimeout(1600);
  seen[c.id] = await p.evaluate(() => {
    const f = document.querySelector(".cand-dir"), img = f.querySelector("img"), shot = f.querySelector(".cand-shot");
    return { art: Math.round(img.getBoundingClientRect().width), box: Math.round(shot.getBoundingClientRect().width) };
  });
}
console.log("true size:", JSON.stringify(seen));
ok(seen[small.id].box === seen[big.id].box,
  `the box is the SAME on the smallest and the biggest design (${seen[small.id].box}px both)`);
ok(Math.abs(seen[small.id].art / small.size[0] - seen[big.id].art / big.size[0]) < 0.001 && seen[small.id].art < seen[big.id].art / 2,
  `and inside it a ${small.size[0]}px design draws ${seen[small.id].art}px against a ${big.size[0]}px design's ${seen[big.id].art}px — one scale, no fitting`);

// AN APPROVED DESIGN THAT HAS ANIMATIONS IS A NORMAL CREATURE (maintainer
// 2026-09-10: "Approved Candidates should become normal monsters ... so I can
// look at the animations done so far and review them like a normal monster").
const DATA_M = DATA.domains?.monsters ?? [];
const pend = DATA_M.filter((m) => m.pending);
ok(pend.length > 0, `the registry carries ${pend.length} approved design(s) still being animated, beside ${DATA_M.length - pend.length} shipped creature(s)`);
if (pend.length) {
  const one = pend[0];
  await p.evaluate((id) => { location.hash = `#/monsters/${id}`; }, one.id);
  await p.waitForTimeout(3000);
  const page = await p.evaluate(() => ({
    title: document.querySelector("h1")?.textContent,
    canvas: !!document.querySelector(".player-stage canvas"),
    states: [...document.querySelectorAll(".seg button")].map((b) => b.textContent.trim()),
    verdict: document.querySelectorAll(".fb-row .verdict button").length,
    note: [...document.querySelectorAll("p.muted")].some((x) => /still being animated/.test(x.textContent)),
  }));
  console.log("in the making:", JSON.stringify({ ...page, states: page.states.slice(0, 4) }));
  ok(page.title === one.name && page.canvas, `${one.name} opens as an ordinary creature page with the animation viewer`);
  // Parallel takes ride the version row, not the state row — they are the same
  // state, so only the base states are counted here.
  const oneStates = [...new Set(Object.entries(one.animations).map(([st, a]) => a.takeOf ?? st))];
  ok(oneStates.every((st) => page.states.some((b) => b.toLowerCase() === st.toLowerCase())),
    `every state it has so far is on the state row (${oneStates.join(", ")})`);
  // THE ROW IS IN THE DOMAIN'S ORDER, THE SAME ON EVERY CREATURE (maintainer
  // 2026-09-10: "Why do you sort 'attack, idle, walk' like this on Ashling and
  // differently on Amethyrn? I like the old monsters sort in the animation
  // buttons."). Alphabetical from the filesystem is the bug this catches.
  const shipped = DATA_M.find((m) => !m.pending && Object.keys(m.animations ?? {}).length > 1);
  const rank = [...new Set(Object.entries(shipped?.animations ?? {}).map(([st, a]) => a.takeOf ?? st))];
  const mine = oneStates.map((st) => rank.indexOf(st));
  ok(rank.length > 1 && mine.every((i) => i >= 0) && mine.every((v, i, a) => !i || a[i - 1] < v),
    `and in the same order a shipped creature uses (${oneStates.join(", ")} against ${rank.join(", ")})`);
  ok(page.verdict >= 2 && page.note, "it can be judged like any other creature, and says the rest of its animations are coming");

  // ONE ANIMATION IS REDONE, NEVER REMOVED (maintainer 2026-09-10: "The
  // individual animations should only have a REDO. Not a remove!"). Removal is
  // a verdict about the whole creature and stays on the row beside its name.
  const rows = await p.evaluate(() => [...document.querySelectorAll(".fb-row")].map((r) => ({
    facet: !!r.closest(".facet-head"),
    buttons: [...r.querySelectorAll(".verdict button")].map((b) => b.textContent.trim()),
  })));
  console.log("rows:", JSON.stringify(rows));
  const facetRow = rows.find((r) => r.facet), wholeRow = rows.find((r) => !r.facet);
  ok(facetRow && facetRow.buttons.some((b) => /redo/.test(b)) && !facetRow.buttons.some((b) => /remove/.test(b)),
    `the per-animation row is approve + redo, with no remove (${facetRow?.buttons.join(" | ")})`);
  ok(wholeRow && wholeRow.buttons.some((b) => /remove/.test(b)),
    `while the creature as a whole can still be removed (${wholeRow?.buttons.join(" | ")})`);

  // PARALLEL TAKES OF ONE STATE ARE ALL REVIEWABLE (maintainer 2026-09-11: "he
  // might try to create a different attack animation without deleting the old
  // version ... I can only see a single attack animation on the wiki so I can't
  // see his new attempts. So we need a way to ... see all different parallel
  // versions (and review/rate all parallel versions)").
  const withTakes = DATA_M.find((m) => Object.values(m.animations ?? {}).some((a) => a.takeOf));
  if (withTakes) {
    const slots = Object.entries(withTakes.animations).filter(([, a]) => a.takeOf);
    const base = slots[0][1].takeOf;
    // Page inside the in-the-making list: those are the creatures with takes,
    // and ‹ › walks the filter he is in.
    await p.evaluate(() => { location.hash = "#/monsters"; });
    await p.waitForTimeout(1600);
    await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-monster-shadow"] .sortbar-btn')].find((b) => /in the making/.test(b.textContent))?.click());
    await p.waitForTimeout(1000);
    await p.evaluate((id) => { location.hash = `#/monsters/${id}`; }, withTakes.id);
    await p.waitForTimeout(3000);
    await p.evaluate((b) => [...document.querySelectorAll(".seg-states button")].find((x) => x.textContent.trim().toLowerCase() === b).click(), base);
    await p.waitForTimeout(900);
    const row = await p.evaluate(() => ({
      states: [...document.querySelectorAll(".seg-states button")].map((b) => b.textContent.trim()),
      takes: [...document.querySelectorAll(".seg-takes button")].map((b) => b.textContent.trim()),
      hidden: document.querySelector(".take-row")?.hidden,
    }));
    console.log("takes:", JSON.stringify(row));
    const hasLive = !!withTakes.animations[base];
    ok(!row.hidden && row.takes.length === slots.length + (hasLive ? 1 : 0) && (!hasLive || row.takes[0] === "live"),
      `${withTakes.name}: ${base} shows every parallel take${hasLive ? ", live first" : " (no live take yet — versions only)"} (${row.takes.join(" | ")})`);
    ok(!row.states.some((t) => slots.some(([slot]) => t.toLowerCase() === slot.replace(/_/g, " "))),
      `and a take is NOT a second state chip (${row.states.join(" | ")})`);

    // A verdict on a take lands on THAT take, never on the live one.
    const other = row.takes[row.takes.length - 1];
    await p.evaluate((lbl) => [...document.querySelectorAll(".seg-takes button")].find((b) => b.textContent.trim() === lbl).click(), other);
    await p.waitForTimeout(900);
    const pill = await p.evaluate(() => document.querySelector(".facet-head .pill")?.textContent);
    await p.evaluate(() => [...document.querySelectorAll(".facet-head .verdict button")].find((b) => /approve/.test(b.textContent)).click());
    await p.waitForTimeout(500);
    const landed = await p.evaluate((id) => Object.keys(window.__wiki.state.feedback.monsters.entries).filter((k) => k.startsWith(`monsters/${id}#`)), withTakes.id);
    console.log("landed:", JSON.stringify({ pill, landed }));
    ok(landed.some((k) => k.includes(`#${slots[slots.length - 1][0]}#`)),
      `judging "${other}" writes a verdict against that take alone (${landed.join(", ")})`);
    ok(/\bv?\d|try/i.test(pill ?? "") && !/try\b.*try/i.test(pill ?? ""),
      `and the judging pill names the version in words, not the raw slot ("${pill}")`);

    // THE VERSION SURVIVES ‹ › (maintainer 2026-09-11: "When I stand on a
    // monster and review the attack animation version today named 'try' I want
    // to be able to click 'next next next' to see the next monsters attack
    // 'try' animation. I don't want the wiki to switch back to the 'live'
    // version.")
    const walkTakes = [];
    for (let i = 0; i < 2; i++) {
      await p.evaluate(() => document.querySelectorAll(".nav-btn")[1]?.click());
      await p.waitForTimeout(1900);
      walkTakes.push(await p.evaluate(() => ({
        name: document.querySelector("h1")?.textContent,
        state: [...document.querySelectorAll(".seg-states button.on")].map((b) => b.textContent.trim())[0],
        take: [...document.querySelectorAll(".seg-takes button.on")].map((b) => b.textContent.trim())[0],
        takes: [...document.querySelectorAll(".seg-takes button")].map((b) => b.textContent.trim()),
      })));
    }
    console.log("walk takes:", JSON.stringify(walkTakes));
    ok(walkTakes.every((w) => w.take === other), `‹ › stays on "${other}" instead of falling back to live (${walkTakes.map((w) => `${w.name}:${w.take}`).join(" → ")})`);
    // ...and the version row is sorted, live first (the agent is renaming them
    // v1, v2, v3 — v10 must follow v9, not v1).
    const order = walkTakes[0].takes;
    const rest = order[0] === "live" ? order.slice(1) : order;
    const sorted = [...rest].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    ok(rest.join() === sorted.join(), `and the versions are sorted${order[0] === "live" ? ", live first" : ""} (${order.join(" | ")})`);
  } else {
    console.log("  (no parallel takes in the registry right now — nothing to drive)");
  }

  // "IN THE MAKING" IS A FILTER, AND IT FOLLOWS HIM (maintainer 2026-09-10:
  // "If I press in the making you still say 'all 94'. With that filter it
  // can't be 94." / "after I click on a monster and click 'next next next' the
  // filter should be active and going to the next page should still show the
  // attack animation if I was on the attack animation").
  await p.evaluate(() => { localStorage.removeItem("wiki-viewer-state-monster"); location.hash = "#/monsters"; });
  await p.waitForTimeout(1800);
  await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-monster-shadow"] .sortbar-btn')].find((b) => /in the making/.test(b.textContent))?.click());
  await p.waitForTimeout(1200);
  const filt = await p.evaluate(() => ({
    sel: [...document.querySelectorAll('[data-bar="wiki-monster-shadow"] .sortbar-btn')].filter((b) => b.classList.contains("sel")).map((b) => b.textContent.trim()),
    cards: document.querySelectorAll(".showcase-card").length,
    sorts: [...document.querySelectorAll('[data-bar="wiki-monster-sort"] .sortbar-btn')].map((b) => b.textContent.trim()),
  }));
  console.log("filter:", JSON.stringify(filt));
  ok(filt.sel.length === 1 && /^in the making \d+$/.test(filt.sel[0]) && filt.cards === pend.length,
    `"in the making" is the only selected chip and shows exactly those ${filt.cards} (${filt.sel.join("|")})`);
  ok(!filt.sorts.some((t) => /making/.test(t)), `and it is not also a sort chip (${filt.sorts.join(" | ")})`);

  await p.evaluate(() => document.querySelector(".showcase-card").click());
  await p.waitForTimeout(2600);
  await p.evaluate(() => [...document.querySelectorAll(".seg button")].find((b) => /^attack$/i.test(b.textContent.trim()))?.click());
  await p.waitForTimeout(800);
  const walk = [];
  for (let i = 0; i < 3; i++) {
    await p.evaluate(() => document.querySelectorAll(".nav-btn")[1]?.click());
    await p.waitForTimeout(1700);
    walk.push(await p.evaluate(() => ({
      on: [...document.querySelectorAll(".seg button.on")].map((b) => b.textContent.trim())[0],
      count: document.querySelector(".detail-count")?.textContent.trim(),
      pending: [...document.querySelectorAll(".pill")].some((x) => /more coming/.test(x.textContent)),
    })));
  }
  console.log("walk:", JSON.stringify(walk));
  ok(walk.every((w) => /^Attack$/i.test(w.on ?? "")), `‹ › keeps the animation he is reviewing (${walk.map((w) => w.on).join(" → ")})`);
  ok(walk.every((w) => w.pending && w.count.endsWith(`/ ${pend.length}`)), `and walks only the filtered ones (${walk.map((w) => w.count).join(" → ")})`);
}

console.log(`page errors: ${errors.length ? errors.join(" | ").slice(0, 300) : "none"}`);
ok(!errors.length, "no page errors");
await b.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL CANDIDATE CHECKS PASSED");
process.exit(fails ? 1 : 0);
