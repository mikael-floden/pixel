// The IN-GAME WIKI BUTTON (maintainer 2026-08-13): "the wiki button should be
// the same size as the time-of-day pill and be rendered over/under it and
// move if it moves … the player comes back to where in the wiki the player
// was when the player closes the wiki and opens it again."
//
// What this pins, and why each check is shaped the way it is:
//   1. SIZE AND STACK against the REAL pill's rect — never against the
//      button's own constants, which would let the two drift apart the day
//      the pill is resized.
//   2. THE ROW SITS BELOW THE PILL, in every placement (maintainer
//      2026-09-03: "the wiki+search is under the time-of-day pill — they
//      should swap y position"). At rest the row takes the corner and the
//      pill steps up over it; in right-handed landscape the pill is
//      top-anchored under the XP chip (its corner belongs to the thumb
//      stick) and the row hangs under it. Same over the keyboard — the
//      stack must not reorder when the keys come up.
//   3. The KEYBOARD RIDE: hud.ts lifts the pill over the phone keyboard via
//      :root.ml-kb-up — the button must hold its 10px gap through the lift.
//      The class+var are set directly (the real focus→lift path is
//      verify-chatpage's subject); what this asserts is the CSS chain.
//   4. THE FREEZE (maintainer 2026-08-13: "the wiki lags a bit when opened on
//      top of the game — can you freeze or pause the game rendering when the
//      wiki is open?"). Asserted on Phaser's OWN step counter, which is the
//      one number that cannot claim a loop stopped when it didn't — plus the
//      outcome it exists for, the frames the wiki's document actually gets.
//   5. THE SPOT: open the wiki, navigate + scroll, close, reopen — same
//      page, same scroll. Read through the iframe (same origin).
//   6. THE 🔍 BUTTON (maintainer 2026-09-02: "a square search icon to the
//      left of the Wiki button … directly to the search with the results
//      sorted by how far away they are from the player"): a pill-high SQUARE
//      one gap left of the Wiki button in every placement, and the contract
//      of spec/WIKI_NEAR.md — the drawer opens on #/near and the iframe is
//      handed a nearest-first list keyed by the wiki's own ids.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";

// Autoplay unlocked so the composer's AudioContext can run headlessly — the
// `heard` block only records what the engine was READY to play.
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
let bad = false;
const fail = (m) => {
  console.log("FAIL:", m);
  bad = true;
};
const ok = (m) => console.log("ok:", m);

const ctx = await browser.newContext({
  viewport: { width: 393, height: 851 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

/** Rects of the pill + button, settle-polled (their anchors transition). */
const rects = async () => {
  let prev = "";
  for (let i = 0; i < 40; i++) {
    const now = await page.evaluate(() => {
      const r = (s) => {
        const e = document.querySelector(s);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
      };
      return JSON.stringify({ pill: r(".ml-clock"), btn: r(".ml-wikibtn"), near: r(".ml-wikinear") });
    });
    if (now === prev) return JSON.parse(now);
    prev = now;
    await page.waitForTimeout(120);
  }
  return JSON.parse(prev);
};

const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

/** The stack invariant: same box, same right edge, and the Wiki row one 10px
 *  gap BELOW the pill. One reading in EVERY placement since the swap
 *  (maintainer 2026-09-03: "the wiki+search is under the time-of-day pill —
 *  they should swap y position") — including over the keyboard, so nothing
 *  reorders on screen when the keys come up. There is no `side` any more:
 *  a parameter that only ever takes one value hides the invariant. */
const assertStack = (g, label) => {
  if (!g.pill || !g.btn) return fail(`${label}: missing ${!g.pill ? "pill" : "button"}`);
  near(g.btn.w, g.pill.w) && near(g.btn.h, g.pill.h)
    ? ok(`${label}: button is pill-sized (${g.btn.w}x${g.btn.h} vs ${g.pill.w}x${g.pill.h})`)
    : fail(`${label}: size mismatch — button ${g.btn.w}x${g.btn.h}, pill ${g.pill.w}x${g.pill.h}`);
  near(g.btn.r, g.pill.r)
    ? ok(`${label}: right edges aligned (${g.btn.r.toFixed(1)})`)
    : fail(`${label}: right edges differ (button ${g.btn.r}, pill ${g.pill.r})`);
  const gap = g.btn.t - g.pill.b;
  near(gap, 10, 2)
    ? ok(`${label}: below the pill with the 10px gap (${gap.toFixed(1)})`)
    : fail(`${label}: wanted the Wiki row 10px BELOW the pill, gap is ${gap.toFixed(1)} (btn ${g.btn.t.toFixed(0)}..${g.btn.b.toFixed(0)}, pill ${g.pill.t.toFixed(0)}..${g.pill.b.toFixed(0)})`);

  // The 🔍: a square the pill's height, on the Wiki button's own line, one
  // 10px gap to its LEFT — so the three read as one stack in every placement.
  if (!g.near) return fail(`${label}: the 🔍 button is missing`);
  near(g.near.w, g.near.h) && near(g.near.h, g.btn.h)
    ? ok(`${label}: 🔍 is a pill-high square (${g.near.w}x${g.near.h})`)
    : fail(`${label}: 🔍 is ${g.near.w}x${g.near.h}, wanted a ${g.btn.h}px square`);
  near(g.near.t, g.btn.t) && near(g.btn.l - g.near.r, 10, 2)
    ? ok(`${label}: 🔍 sits left of Wiki with the 10px gap (${(g.btn.l - g.near.r).toFixed(1)})`)
    : fail(`${label}: 🔍 off the Wiki line — top ${g.near.t.toFixed(0)} vs ${g.btn.t.toFixed(0)}, gap ${(g.btn.l - g.near.r).toFixed(1)}`);
};

const frameSel = ".ml-wikipanel iframe";
const wiki = () => page.frames().find((f) => f.url().includes("/assets/wiki/"));
/** `readyState complete` is NOT "the wiki is on screen": the app fetches
 * data.json and renders after the document loads. On a first, uncached open
 * the two are far enough apart to hide it; on a later one the document is
 * complete in a few ms and a query for the wiki's own markup finds an empty
 * shell. Anything reading the wiki's CONTENT must wait for the content. */
const frameReady = async (needNav = false) => {
  // A FRESH IFRAME IS `about:blank`, AND about:blank IS ALREADY "complete".
  // Waiting on readyState alone therefore returns before the wiki has even
  // begun to load — page.frames() then holds no wiki frame at all and the
  // next line throws (or, worse, a check runs against a blank document and
  // passes). Wait for the frame whose URL IS the wiki first; only then is
  // readyState a statement about the wiki.
  for (let i = 0; i < 200 && !wiki(); i++) await page.waitForTimeout(100);
  const f = wiki();
  if (!f) throw new Error("the wiki iframe never navigated off about:blank");
  await f.waitForFunction(() => document.readyState === "complete", null, { timeout: 20000 });
  if (!needNav) return;
  await f.waitForFunction(
    () => [...document.querySelectorAll('a[href^="#/"]')].some((a) => a.getAttribute("href").length > 3),
    null,
    { timeout: 20000 },
  );
};

try {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });

  // ── 0. the drawer opens with NO GAME BEHIND IT ─────────────────────────
  // The select screen has its own wiki button and no Phaser game at all, so
  // the freeze has nothing to freeze. It must no-op, not throw — the whole
  // pre-game half of the app runs through this path.
  await page.click("#ml-wiki");
  await page.waitForSelector(frameSel, { timeout: 10000 });
  await frameReady();
  // …and a wantNear from here gets the honest "no world" answer, not silence
  // (spec/WIKI_NEAR.md: the page must be able to say "works from inside the
  // game" rather than hang on a reply that never comes).
  const noWorld = await wiki().evaluate(
    () =>
      new Promise((res) => {
        const t = setTimeout(() => res(null), 4000);
        window.addEventListener("message", (e) => {
          if (e.data?.type === "wiki:near") { clearTimeout(t); res(e.data); }
        });
        window.parent.postMessage({ type: "wiki:wantNear" }, location.origin);
      }),
  );
  // No SPATIAL rows before the world exists — but the ear is honest even here:
  // the title theme plays and the tap that opened the drawer clicked.
  const isAudio = (it) => it.domain === "music" || it.domain === "sounds";
  noWorld && noWorld.world === null && Array.isArray(noWorld.items) && noWorld.items.every(isAudio)
    ? ok(`before the world exists, wantNear answers world:null with no spatial rows (${noWorld.items.length} audio row(s): ${noWorld.items.map((i) => i.id).join(", ")})`)
    : fail(`select-screen wantNear reply: ${JSON.stringify(noWorld)}`);
  await page.evaluate(() => document.querySelector(".ml-wikiback")?.click());
  await page.waitForFunction(() => !document.querySelector(".ml-wikiroot"), null, { timeout: 5000 });
  errors.length === 0
    ? ok("the wiki opens on the select screen, with no game to freeze")
    : fail(`opening the wiki before the game exists threw: ${errors.join(" | ")}`);

  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 40000 });
  await page.waitForFunction(() => !!document.querySelector(".ml-clock"), null, { timeout: 20000 });

  // ── 1. portrait: pill-sized, stacked ABOVE ─────────────────────────────
  assertStack(await rects(), "portrait");

  // ── 1b. BOTH BUTTONS WEAR HIS OWN ART, and it actually arrived ─────────
  // (maintainer 2026-09-03: the PixelLab magnifying glass, flipped, and the
  // open old book — replacing the 🔍 and 📖 emoji, which were whatever glyph
  // the phone's font vendor drew.) A missing /ui2 file renders as an EMPTY
  // BOX, not an error — the button keeps its shape and nothing throws — so
  // the only honest test is the decoded bitmap: naturalWidth is 0 for a 404
  // and 48 for the real bake.
  const readIcon = (sel) =>
    page.evaluate((s) => {
      const i = document.querySelector(s);
      if (!i) return null;
      const r = i.getBoundingClientRect();
      return {
        tag: i.tagName, src: i.getAttribute("src"),
        nat: [i.naturalWidth, i.naturalHeight], box: [Math.round(r.width), Math.round(r.height)],
        rendering: getComputedStyle(i).imageRendering,
      };
    }, sel);
  for (const [what, sel, file] of [
    ["🔍", ".ml-wikinear .ml-wikinear-icon", "icon-search"],
    ["Wiki", ".ml-wikibtn .ml-wikibtn-icon", "icon-wiki"],
  ]) {
    const ico = await readIcon(sel);
    if (!ico) { fail(`the ${what} button has no icon element`); continue; }
    ico.tag === "IMG" && ico.nat[0] === 48 && ico.nat[1] === 48 && ico.src.includes(file)
      ? ok(`the ${what} button wears the real bake (${ico.src.split("?")[0]}, decoded ${ico.nat.join("x")})`)
      : fail(`${what} icon missing or not decoded: ${JSON.stringify(ico)} — a 404 in /ui2 looks like an empty box, not an error`);
    // The /ui2 rule: an exact 2x bake drawn at its authored grid, nearest.
    ico.box[0] === 24 && ico.box[1] === 24 && ico.rendering === "pixelated"
      ? ok(`…${what} at its authored 24px grid, nearest-neighbour (${ico.box.join("x")}, ${ico.rendering})`)
      : fail(`${what} icon drawn at ${ico.box.join("x")} / ${ico.rendering}, wanted 24x24 pixelated`);
    // CACHE STAMPING, asserted RELATIVE to the tab icons. withV() is a
    // deliberate no-op in dev (no VITE_GIT_SHA), so "does it end in ?v=" is a
    // test of the environment, not of the code. What must hold everywhere is
    // that this icon is stamped exactly as every other /ui2 icon is — bare
    // here, ?v=<sha> or ?h=<hash> on a deploy. A forgotten withV() shows up
    // as a DIFFERENCE, in any environment.
    const stamp = (u) => (u.split("?")[1] ?? "").replace(/=.*/, "=") || "(bare)";
    const tabSrc = await page.evaluate(() => document.querySelector(".ml-tab-icon")?.getAttribute("src") ?? null);
    tabSrc && stamp(ico.src) === stamp(tabSrc)
      ? ok(`…${what} cache-stamped like every other /ui2 icon (${stamp(ico.src)})`)
      : fail(`${what} icon stamping differs from the tab icons: ${stamp(ico.src)} vs ${tabSrc ? stamp(tabSrc) : "no tab icon found"} — withV() missing?`);
  }

  // ── 2. the keyboard ride: both lift, the gap survives ──────────────────
  const before = await rects();
  // A TALL keyboard, so the movement is unambiguous. The rest anchor is
  // above the 325px HUD and the lift anchor is inputlift+56, so a small
  // inputlift moves the stack DOWN (120px read as "broke the stack" on the
  // first run, with the two moving together perfectly) and 320px rises only
  // 41px. What is under test is that they move AS ONE, whatever the size.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--ml-inputlift", "430px");
    document.documentElement.classList.add("ml-kb-up");
  });
  await page.waitForTimeout(400);
  const lifted = await rects();
  const pillRose = before.pill.b - lifted.pill.b;
  const btnRose = before.btn.b - lifted.btn.b;
  pillRose > 60 && near(btnRose, pillRose, 2)
    ? ok(`keyboard lift: the stack rides together (pill +${pillRose.toFixed(0)}px, button +${btnRose.toFixed(0)}px)`)
    : fail(`keyboard lift broke the stack (pill rose ${pillRose.toFixed(0)}, button ${btnRose.toFixed(0)})`);
  near(lifted.btn.t - lifted.pill.b, 10, 2)
    ? ok("keyboard lift: the 10px gap survives, in the same order")
    : fail(`gap while lifted: ${(lifted.btn.t - lifted.pill.b).toFixed(1)}px (the stack must not reorder over the keys)`);
  near(lifted.near.b, lifted.btn.b, 2)
    ? ok("keyboard lift: 🔍 rides on the Wiki button's line")
    : fail(`keyboard lift left 🔍 behind (🔍 bottom ${lifted.near.b.toFixed(0)}, Wiki ${lifted.btn.b.toFixed(0)})`);
  await page.evaluate(() => {
    document.documentElement.classList.remove("ml-kb-up");
    document.documentElement.style.removeProperty("--ml-inputlift");
  });

  // ── 3. THE FREEZE: the loop sleeps for as long as the drawer is up ─────
  await page.click(".ml-wikibtn");
  await page.waitForSelector(frameSel, { timeout: 10000 });
  await frameReady();
  const f0 = await page.evaluate(() => window.__mlFreeze.frame());
  await page.waitForTimeout(1500);
  const held = await page.evaluate(() => ({
    frozen: window.__mlFreeze.frozen(),
    running: window.__mlFreeze.running(),
    frame: window.__mlFreeze.frame(),
    players: window.__ml.players(),
  }));
  // Phaser's own step counter, not our flag: a loop that claims to be asleep
  // and still steps would pass a `frozen === true` check and fail this one.
  held.frozen && !held.running && held.frame === f0
    ? ok(`the game loop is asleep while the drawer is up (0 frames in 1.5s)`)
    : fail(`the loop kept running: frozen=${held.frozen} running=${held.running} frames=${held.frame - f0}`);
  // Freezing is not disconnecting. The socket is event-driven, so the room
  // must be exactly as alive as it was — a freeze that dropped the player
  // would be a far worse bug than the stutter it fixes.
  held.players >= 1
    ? ok(`the room is untouched by the freeze (${held.players} player(s))`)
    : fail(`the room dropped while frozen (players ${held.players})`);
  // …and the point of all of it: the wiki's own document gets the main
  // thread. With the loop asleep nothing competes, so this should sit near
  // vsync; the floor is low enough to survive a loaded box.
  const wikiFps = await wiki().evaluate(
    () =>
      new Promise((res) => {
        let n = 0;
        const t0 = performance.now();
        const tick = (t) => {
          n++;
          if (t - t0 < 1500) requestAnimationFrame(tick);
          else res((n / (t - t0)) * 1000);
        };
        requestAnimationFrame(tick);
      }),
  );
  wikiFps >= 25
    ? ok(`the wiki gets the thread back (${wikiFps.toFixed(0)} fps in its own document)`)
    : fail(`the wiki is still starved at ${wikiFps.toFixed(1)} fps — is the loop really asleep?`);
  await page.evaluate(() => document.querySelector(".ml-wikiback")?.click());
  await page.waitForFunction(() => !document.querySelector(".ml-wikiroot"), null, { timeout: 5000 });
  const woke = await page.evaluate(() => ({
    frozen: window.__mlFreeze.frozen(),
    running: window.__mlFreeze.running(),
    frame: window.__mlFreeze.frame(),
    cool: window.__mlGame.loop._coolDown,
  }));
  woke.running && !woke.frozen && woke.frame > held.frame
    ? ok(`closing wakes the loop (${woke.frame - held.frame} frames by the time the drawer is gone)`)
    : fail(`the loop did not wake: frozen=${woke.frozen} running=${woke.running} frames=${woke.frame - held.frame}`);
  // THE FIRST FRAME BACK MUST NOT BE BILLED FOR THE READ. `TimeStep.resume()`
  // is the obvious call here and it is the wrong one: it arms Phaser's
  // backgrounded-tab recovery, `_coolDown = panicMax`, which clamps every
  // delta to the 16.7ms target for the next 120 FRAMES — measured as 16.7ms
  // of game time per 167ms of real time, and a player who walked 20wu where
  // an unfrozen one walked 151. gamefreeze.ts moves `lastTime` instead.
  // (Phaser arms the same cooldown from its own window-FOCUS handler, so this
  // is asserted after a scripted close, which never leaves the parent window.)
  woke.cool <= 0
    ? ok("waking does not arm Phaser's panic cooldown (no slow motion on the way back)")
    : fail(`the thaw armed the panic cooldown (_coolDown ${woke.cool}) — the world will run slow for ${woke.cool} frames`);

  // ── 4. the SPOT: navigate, scroll, close, reopen ───────────────────────
  await page.click(".ml-wikibtn");
  await frameReady(true);
  // pick a real route off the wiki's own nav, then scroll partway down
  const target = await wiki().evaluate(() => {
    const a = [...document.querySelectorAll('a[href^="#/"]')].find((x) => x.getAttribute("href").length > 3);
    if (!a) return null;
    const href = a.getAttribute("href");
    location.hash = href;
    return href;
  });
  if (!target) fail("no #/ route found in the wiki to navigate to");
  // let the route render, then scroll to a spot that exists
  await page.waitForTimeout(1200);
  const scrolled = await wiki().evaluate(() => {
    const max = (document.scrollingElement?.scrollHeight ?? 0) - innerHeight;
    const want = Math.min(Math.max(0, max), 400);
    scrollTo(0, want);
    return want;
  });
  await page.waitForTimeout(300);
  // close by tapping the game strip (the back layer)
  await page.evaluate(() => document.querySelector(".ml-wikiback")?.click());
  await page.waitForFunction(() => !document.querySelector(".ml-wikiroot"), null, { timeout: 5000 });
  // The spot lives in a module variable for exactly the playing session
  // (maintainer 2026-08-14: a restart goes back to overview) — there is
  // nothing in storage to read, so the store is asserted through the only
  // door it has: the reopen below.

  // reopen: same page, same scroll
  await page.click(".ml-wikibtn");
  await frameReady();
  let back = null;
  for (let i = 0; i < 30; i++) {
    back = await wiki().evaluate(() => ({ hash: location.hash, scroll: Math.round(scrollY) }));
    if (back.hash === target && near(back.scroll, scrolled, 40)) break;
    await page.waitForTimeout(200);
  }
  back && back.hash === target
    ? ok(`reopening returns to the page (${back.hash})`)
    : fail(`reopened on ${back?.hash}, wanted ${target}`);
  back && (scrolled === 0 || near(back.scroll, scrolled, 40))
    ? ok(`…and to the reading position (${back.scroll}px of ${scrolled})`)
    : fail(`reopened at scroll ${back?.scroll}, wanted ~${scrolled}`);
  await page.evaluate(() => document.querySelector(".ml-wikiback")?.click());
  await page.waitForFunction(() => !document.querySelector(".ml-wikiroot"), null, { timeout: 5000 });

  // ── 6. THE 🔍 BUTTON: #/near and the nearest-first list ───────────────
  // Two sounds into the ledger first: a jump (a voice take — plays) and a
  // kick (assignable, unassigned in this build unless the Game Master did —
  // recorded either way). Order matters: kick LAST so it must come FIRST.
  const audioUp = await page.evaluate(() => { const a = window.__ml.audio(); return a.context === "running" && a.catalog > 0; });
  await page.evaluate(() => { window.__ml.audioEvent("player.jump"); });
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__ml.audioEvent("combat.kick"); });
  await page.waitForTimeout(150);
  await page.click(".ml-wikinear");
  await page.waitForSelector(frameSel, { timeout: 10000 });
  await frameReady();
  const nearHash = await wiki().evaluate(() => location.hash);
  nearHash === "#/near"
    ? ok("🔍 opens the drawer on #/near")
    : fail(`🔍 opened on "${nearHash}", wanted #/near`);
  // Ask exactly as the wiki page will (spec/WIKI_NEAR.md) and read the reply
  // from inside the iframe — the game must answer a wantNear while open.
  const snap = await wiki().evaluate(
    () =>
      new Promise((res) => {
        const t = setTimeout(() => res(null), 4000);
        window.addEventListener("message", (e) => {
          if (e.data?.type === "wiki:near") { clearTimeout(t); res(e.data); }
        });
        window.parent.postMessage({ type: "wiki:wantNear" }, location.origin);
      }),
  );
  if (!snap) fail("no wiki:near reply to wiki:wantNear");
  else {
    const items = snap.items ?? [];
    // Spatial rows sort by dist; the audio rows (ago, not dist) are appended
    // after them and the page sorts its own hearing section.
    const spatial = items.filter((it) => !isAudio(it));
    const sorted = spatial.every((it, i) => i === 0 || it.dist >= spatial[i - 1].dist)
      && items.findIndex(isAudio) === (items.some(isAudio) ? spatial.length : -1);
    snap.world && snap.at && items.length > 0 && sorted
      ? ok(`wiki:near — ${items.length} rows for ${snap.world} at (${snap.at.col},${snap.at.row}), nearest first`)
      : fail(`wiki:near malformed: world=${snap.world} at=${JSON.stringify(snap.at)} rows=${items.length} sorted=${sorted}`);
    const under = items.find((it) => (it.domain === "tiles" || it.domain === "world") && it.dist === 0);
    under ? ok(`the ground under the feet is row zero (${under.id}, x${under.n})`) : fail("no tiles row at dist 0 — what am I standing on?");
    // The ids are the wiki's own — check them against the wiki's shipped
    // index. A miss is a stale wiki BUILD, not a game bug, so the whole set
    // fails only if NOTHING resolves; strays are reported.
    const known = await page.evaluate(async () => {
      const d = await (await fetch("/assets/wiki/site/data.json", { cache: "no-store" })).json();
      const out = {};
      for (const k of Object.keys(d.domains)) out[k] = d.domains[k].map((e) => e.id);
      // #/world/<type> is the ground-TYPE page: a type exists when some pair has it on top.
      out.world = [...new Set(d.domains.world.map((w) => w.top))];
      // A `sounds` row is an EVENT (#/sounds/<event>), not a catalog sound.
      out.sounds = (d.sfx?.events ?? []).map((e) => e.id);
      return out;
    });
    // …plus the two AUDIO domains the wiki renders as its own section
    // (music: what plays now; sounds: the EVENTS of the last 30 s, by `ago`).
    const okDomains = ["monsters", "characters", "items", "objects", "tiles", "world", "music", "sounds"];
    const badDomain = items.filter((it) => !okDomains.includes(it.domain));
    badDomain.length === 0 ? ok("every row is one of the eight routable domains") : fail(`unroutable domains: ${badDomain.map((b) => b.domain).join(",")}`);
    const unknown = items.filter((it) => known[it.domain] && !known[it.domain].includes(it.id));
    unknown.length < items.length
      ? ok(`${items.length - unknown.length}/${items.length} ids resolve in the wiki index${unknown.length ? ` (stale build: ${unknown.map((u) => `${u.domain}/${u.id}`).slice(0, 4).join(", ")})` : ""}`)
      : fail(`none of the ${items.length} ids exist in the wiki index`);
    under && known[under.domain] && known[under.domain].includes(under.id)
      ? ok(`…and the ground under the feet routes (#/${under.domain}/${under.id})`)
      : fail(`the ground under the feet does not route: ${under ? `${under.domain}/${under.id}` : "none"}`);
    const dup = new Set(items.map((it) => `${it.domain}/${it.id}`)).size !== items.length;
    !dup ? ok("one row per (domain, id)") : fail("duplicate (domain, id) rows");
    // THE EAR (maintainer 2026-09-02: music now + sound effects of the last
    // 30 s, most recent first). Asserted only when the engine could hear at
    // all — a harness without a running AudioContext records nothing, by
    // contract — but the block itself must always be there.
    const heard = snap.heard;
    heard && Array.isArray(heard.sfx) && "music" in heard
      ? ok(`heard block present (music ${heard.music ? `${heard.music.kind}:${heard.music.id}` : "none"}, ${heard.sfx.length} sfx)`)
      : fail(`heard block missing or malformed: ${JSON.stringify(heard)}`);
    if (audioUp && heard) {
      // The composer's own sounds (a footstep, the button's click) may land
      // after the kick — what must hold is kick BEFORE jump in a newest-first
      // list, and both present.
      const ev = heard.sfx.map((x) => x.event);
      const iK = ev.indexOf("combat.kick"), iJ = ev.indexOf("player.jump");
      iK >= 0 && iJ >= 0 && iK < iJ
        ? ok(`sfx newest first — kick (fired last) listed before jump (${ev.map((e) => e ?? "·").slice(0, 5).join(" ‹ ")})`)
        : fail(`sfx order/content wrong: ${ev.join(",")}`);
      const sorted = heard.sfx.every((x, i) => i === 0 || x.at <= heard.sfx[i - 1].at);
      const fresh = heard.sfx.every((x) => x.ago >= 0 && x.ago <= 30);
      sorted && fresh ? ok("every sfx row is within 30 s and the list is sorted by recency") : fail(`sfx not sorted/fresh: ${JSON.stringify(heard.sfx.slice(0, 4))}`);
      const jump = heard.sfx.find((x) => x.event === "player.jump");
      jump && jump.sound ? ok(`a played event names its sound (${jump.sound})`) : fail(`player.jump row has no sound: ${JSON.stringify(jump)}`);
      heard.music ? ok(`music now: ${heard.music.kind} ${heard.music.id}${heard.music.section ? ` · ${heard.music.section}` : ""} @ ${heard.music.position}s`) : fail("music is on and playing in-world, but heard.music is null");
    } else ok(`(audio engine not running on this harness — ear content not asserted, context=${audioUp})`);
    // …and the WIKI'S HALF renders it: the drawer shows one card per row,
    // nearest first, the ground under the feet reading "under you". This is
    // the end-to-end the maintainer sees; the page's own behaviours are the
    // wiki's gate (wiki/tools/check-near.mjs).
    await wiki().waitForFunction((n) => document.querySelectorAll("#content a.card").length >= n, items.length, { timeout: 10000 }).catch(() => {});
    const cards = await wiki().evaluate(() => [...document.querySelectorAll("#content a.card")].map((a) => ({
      href: a.getAttribute("href"), sub: a.querySelector(".card-sub")?.textContent ?? "" })));
    cards.length === items.length
      ? ok(`the wiki renders the snapshot — ${cards.length} cards on #/near`)
      : fail(`#/near shows ${cards.length} cards for ${items.length} rows`);
    cards[0] && /under you/.test(cards[0].sub) && cards[0].href === `#/${items[0].domain}/${encodeURIComponent(items[0].id)}`
      ? ok(`the first card is the ground under the feet (${cards[0].href} — "${cards[0].sub}")`)
      : fail(`first card wrong: ${JSON.stringify(cards[0])} for ${items[0]?.domain}/${items[0]?.id}`);
    if (audioUp) {
      // COUNTED IN THE PAGE'S OWN HEARING SECTION, not by href prefix. Where a
      // row LINKS is the wiki's business and it changes: `player.jump` is
      // emitted unscoped but the wiki lists it per hero, so that card now
      // routes to #/characters/<hero>/player.jump@<hero> — a prefix test on
      // #/sounds/ called a working card a missing one.
      const audioRows = items.filter((it) => it.domain === "music" || it.domain === "sounds");
      const heardCards = await wiki().evaluate(() =>
        [...document.querySelectorAll(".near-hearing a.card")].map((a) => ({
          href: a.getAttribute("href"), name: a.querySelector(".card-name")?.textContent ?? "",
          sub: a.querySelector(".card-sub")?.textContent ?? "" })));
      audioRows.length >= 2 && heardCards.length === audioRows.length
        ? ok(`the wiki's hearing section renders every audio row (${heardCards.map((c) => c.name).join(", ")})`)
        : fail(`${audioRows.length} audio rows sent, ${heardCards.length} cards in .near-hearing: ${JSON.stringify(heardCards)}`);
      const kick = heardCards.find((c) => /kick/i.test(c.name) || (c.href ?? "").includes("combat.kick"));
      kick && /s ago|playing now/.test(kick.sub) ? ok(`the kick card says when (${kick.sub.trim()})`) : fail(`kick card: ${JSON.stringify(heardCards)}`);
      const music = heardCards.find((c) => /playing now/.test(c.sub));
      music ? ok(`…and the score leads it (${music.name})`) : fail(`no "playing now" row: ${JSON.stringify(heardCards)}`);
    }
  }
  await page.evaluate(() => document.querySelector(".ml-wikiback")?.click());
  await page.waitForFunction(() => !document.querySelector(".ml-wikiroot"), null, { timeout: 5000 });
  // The Wiki button still starts where the player LEFT the wiki — #/near is
  // a page like any other to the spot store.
  await page.click(".ml-wikibtn");
  await frameReady();
  const backTo = await wiki().evaluate(() => location.hash);
  backTo === "#/near" ? ok("the Wiki button remembers #/near like any page") : fail(`Wiki reopened on "${backTo}"`);
  await page.evaluate(() => document.querySelector(".ml-wikiback")?.click());
  await page.waitForFunction(() => !document.querySelector(".ml-wikiroot"), null, { timeout: 5000 });

  // ── 7. right-handed landscape: BELOW the pill under the XP chip ────────
  await page.setViewportSize({ width: 851, height: 393 });
  await page.waitForFunction(
    () => document.documentElement.classList.contains("ml-land") && !document.querySelector(".ml-flip-veil"),
    null,
    { timeout: 15000 },
  );
  assertStack(await rects(), "right-handed landscape");

  // ── 8. left-handed landscape: the pill keeps its corner, button ABOVE ──
  await page.evaluate(() => window.__ml.hand("left"));
  await page.waitForTimeout(800);
  assertStack(await rects(), "left-handed landscape");
  await page.evaluate(() => window.__ml.hand("right"));

  // ── 9. portrait return ─────────────────────────────────────────────────
  await page.setViewportSize({ width: 393, height: 851 });
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("ml-land") && !document.querySelector(".ml-flip-veil"),
    null,
    { timeout: 15000 },
  );
  assertStack(await rects(), "portrait return");

  errors.length === 0 ? ok("no page errors") : fail(`page errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
}

console.log(bad ? "\nWIKIBTN: FAIL" : "\nWIKIBTN: PASS");
process.exit(bad ? 1 : 0);
