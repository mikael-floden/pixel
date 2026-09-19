// The IN-GAME WIKI BUTTON (maintainer 2026-08-13): "the wiki button should be
// the same size as the time-of-day pill and be rendered over/under it and
// move if it moves … the player comes back to where in the wiki the player
// was when the player closes the wiki and opens it again."
//
// What this pins, and why each check is shaped the way it is:
//   1. THE ROW SPANS THE XP CARD it hangs under, and is pill-high — measured
//      against the REAL card and the REAL pill, never against the button's
//      own constants, which would let them drift apart the day either moves.
//   2. THE TIME-OF-DAY PILL, which since 2026-09-19 is NOT in this stack:
//      half the card's extra width, centred in the game view, same top
//      margin (assertPill). It was the row's twin for six weeks — same box,
//      same right edge, one --ml-stack-step apart, in an order that flipped
//      with the anchor — and that is why this gate owns it: what used to be
//      an invariant BETWEEN them is now two separate readings, and splitting
//      them is the whole point of the change.
//   3. The KEYBOARD RIDE: hud.ts lifts the chat over the phone keyboard via
//      :root.ml-kb-up — the top-anchored row and pill must not move at all.
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
      // the pill's art scale: its canvas's backing store against its box
      const cv = document.querySelector(".ml-clock canvas");
      const cb = cv && cv.getBoundingClientRect();
      const art = cv
        ? { cw: cv.width, ch: cv.height, bw: Math.round(cb.width), bh: Math.round(cb.height),
            sx: +(cb.width / cv.width).toFixed(3), sy: +(cb.height / cv.height).toFixed(3) }
        : null;
      const near_ = r(".ml-wikinear"), btn_ = r(".ml-wikibtn");
      const row = near_ && btn_ ? Math.round(btn_.r - near_.l) : null;
      const cs = getComputedStyle(document.documentElement);
      const v = (n) => parseFloat(cs.getPropertyValue(n)) || 0;
      return JSON.stringify({ pill: r(".ml-clock"), btn: btn_, near: near_, art, row,
        // what the pill is sized and centred against
        xp: r(".ml-bars-r"), card: Math.round(v("--bars-r-w")), cardL: Math.round(v("--bars-l-w")),
        step: v("--ml-stack-step"), onTop: document.querySelector(".ml-clock")?.classList.contains("on-top") ?? null,
        gl: v("--gv-left"), gr: v("--gv-right"), vw: window.innerWidth,
        // everything a centred box has to clear
        others: { "the HP/EP card": r(".ml-bars-l"), "the XP card": r(".ml-bars-r"),
          "the Wiki button": btn_, "the search button": near_, "the Report button": r(".ml-recbtn") } });
    });
    if (now === prev) return JSON.parse(now);
    prev = now;
    await page.waitForTimeout(120);
  }
  return JSON.parse(prev);
};

const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

/** THE WIKI ROW: pill-high, and the 🔍 square one gap to its left, in every
 *  placement. It used to assert a STACK — the row and the time-of-day pill
 *  one --ml-stack-step apart, same box, same right edge, in an order that
 *  flipped with the anchor. That ended on 2026-09-19: the pill stopped being
 *  the card's width and moved to the view's centre (assertPill below), so the
 *  two no longer touch and there is no order left to parameterise. */
const assertStack = (g, label) => {
  if (!g.pill || !g.btn) return fail(`${label}: missing ${!g.pill ? "pill" : "button"}`);
  // SINCE 2026-09-19 THE ROW IS THE XP CARD'S WIDTH and the Wiki button takes
  // what the 🔍 and the gap leave of it. Both it and the pill are still PILL_H
  // tall — one shared height across the chrome — and that is what is asserted.
  near(g.btn.h, g.pill.h)
    ? ok(`${label}: button is pill-high (${g.btn.h}px)`)
    : fail(`${label}: height mismatch — button ${g.btn.h}, pill ${g.pill.h}`);
  near(g.row, g.card, 2)
    ? ok(`${label}: the row spans the XP card exactly (${g.row} vs ${g.card})`)
    : fail(`${label}: the row is ${g.row} against a ${g.card}px card`);

  // The 🔍: a square the pill's height, on the Wiki button's own line, one
  // 10px gap to its LEFT — so the two read as one row in every placement.
  if (!g.near) return fail(`${label}: the 🔍 button is missing`);
  near(g.near.w, g.near.h) && near(g.near.h, g.btn.h)
    ? ok(`${label}: 🔍 is a pill-high square (${g.near.w}x${g.near.h})`)
    : fail(`${label}: 🔍 is ${g.near.w}x${g.near.h}, wanted a ${g.btn.h}px square`);
  near(g.near.t, g.btn.t) && near(g.btn.l - g.near.r, 10, 2)
    ? ok(`${label}: 🔍 sits left of Wiki with the 10px gap (${(g.btn.l - g.near.r).toFixed(1)})`)
    : fail(`${label}: 🔍 off the Wiki line — top ${g.near.t.toFixed(0)} vs ${g.btn.t.toFixed(0)}, gap ${(g.btn.l - g.near.r).toFixed(1)}`);
};

// THE PILL'S WIDTH RULE, RESTATED — not imported from clock.ts, because a
// gate that reads the constant it is checking asserts nothing. These three
// numbers ARE the record of what he approved; changing the pill's width
// without changing this line is exactly the change that must go red.
const AW = 40, SCALE = 2, EXT = 0.5;
const wantPillW = (cardBox) => (AW + Math.round(((cardBox - 2) / SCALE - AW) * EXT)) * SCALE + 2;

/** THE TIME-OF-DAY PILL, which is no longer part of the stack above.
 *  (maintainer 2026-09-19, on the full-width version shipped that morning: "I
 *  just feel the pill got a little bit to wide … just extend it 50% that
 *  additional width instead. This ofc means the pill will not align at the
 *  position it's currently at. So lets center the pill at the top instead
 *  (with same top margin).")
 *  Four readings, all RELATIONSHIPS: half the card's extra width, an exact 2x
 *  canvas, centred in the GAME VIEW, and the top margin it already had. */
const assertPill = (g, label) => {
  if (!g.pill || !g.xp) return fail(`${label}: missing ${!g.pill ? "the pill" : "the XP card"}`);
  const want = wantPillW(g.card);
  near(g.pill.w, want, 1)
    ? ok(`${label}: the pill takes half the card's extra width (${g.pill.w} against the card's ${g.card})`)
    : fail(`${label}: pill ${g.pill.w}, wanted ${want} — ${AW} art px plus ${EXT} of what the ${g.card}px card is wider`);
  // THE ONE THAT CANNOT BE FAKED BY A SCREENSHOT: the canvas's BACKING STORE
  // against its box. A pill widened by stretching fails this by construction.
  g.art && g.art.sx === 2 && g.art.sy === 2
    ? ok(`${label}: drawn 1 art px = 2 css px — more sky, not a stretch (${g.art.cw}x${g.art.ch} art in ${g.art.bw}x${g.art.bh})`)
    : fail(`${label}: the pill's canvas is stretched — ${JSON.stringify(g.art)} (want an exact 2x on both axes)`);
  // Centred in the GAME VIEW, not the window: in landscape the menu takes one
  // side, and centring on the window would slide the pill under its edge.
  // 1px of tolerance because an even box in an odd view lands on x.5 and the
  // left edge is rounded to a whole css px (clock.ts fitPill) on purpose.
  const mid = g.pill.l + g.pill.w / 2, want2 = (g.gl + g.vw - g.gr) / 2;
  near(mid, want2, 1)
    ? ok(`${label}: centred in the game view (${mid.toFixed(1)} against ${want2.toFixed(1)})`)
    : fail(`${label}: pill centre ${mid.toFixed(1)}, game view centre ${want2.toFixed(1)}`);
  // TWO ROWS, ONE MEASUREMENT (maintainer 2026-09-19, a red box drawn in the
  // gap between the two cards: "Ofc it should be placed here"). TOP CENTRE is
  // the cards' own line, and the pill takes it WHEN THE TWO CARDS LEAVE ROOM
  // — the pill plus the same 10px margin they keep. When they do not it drops
  // to the row under the Wiki row, which is free all the way across at every
  // width. The gate computes the SAME measurement the code does and asserts
  // the row that follows from it, so it pins the rule and not one screen's
  // answer to it: at 393px this reads the lower row, at his ~490px the upper.
  const free = g.vw - g.gr - 10 - g.card - (g.gl + 10 + g.cardL);
  const wantTop = free >= g.pill.w + 20;
  wantTop === g.onTop
    ? ok(`${label}: ${wantTop ? "the cards leave" : "the cards do not leave"} room (${free.toFixed(0)}px for a ${g.pill.w}px pill + 20), and the pill agrees`)
    : fail(`${label}: ${free.toFixed(0)}px between the cards for a ${g.pill.w}px pill + 20, but on-top is ${g.onTop}`);
  wantTop
    ? near(g.pill.t, g.xp.t, 2)
      ? ok(`${label}: TOP CENTRE — on the cards' own line (${g.pill.t.toFixed(0)} vs the card's ${g.xp.t.toFixed(0)})`)
      : fail(`${label}: the cards leave room but the pill is at ${g.pill.t.toFixed(0)}, not their line ${g.xp.t.toFixed(0)}`)
    : near(g.pill.t - g.xp.b, 10 + g.step, 2)
      ? ok(`${label}: no room on the cards' line, so the row under the Wiki row (XP bottom + 10 + the ${g.step}px step)`)
      : fail(`${label}: pill top ${g.pill.t.toFixed(0)} is ${(g.pill.t - g.xp.b).toFixed(0)}px under the XP card, wanted ${10 + g.step}`);
  // IT TOUCHES NOTHING. A centred box is only honest if it clears the chrome
  // on BOTH sides at every width: the cards' own 10px row looks like the
  // emptiest place for it, but at 393px two 148px cards leave 77px between
  // them and a 116px pill overlaps both. Measured, not reasoned about.
  const hits = Object.entries(g.others).filter(([, r]) =>
    r && g.pill.l < r.r && r.l < g.pill.r && g.pill.t < r.b && r.t < g.pill.b);
  hits.length === 0
    ? ok(`${label}: the pill clears every other piece of chrome`)
    : fail(`${label}: the pill overlaps ${hits.map(([w]) => w).join(", ")} — ${JSON.stringify(g.pill)}`);
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
  const g0 = await rects();
  assertStack(g0, "portrait");
  assertPill(g0, "portrait");

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

  // ── 2. the keyboard ride: IN PORTRAIT THIS STACK DOES NOT MOVE ─────────
  // This section used to require the stack to RISE with the keyboard, and it
  // has been failing on main since 2026-09-17, when the corner stack moved to
  // the TOP right: hud.ts's lift writes `bottom` on all three boxes, and a
  // `bottom` on a TOP-anchored fixed box that has a height is over-constrained
  // and ignored — so in portrait the lift moves the chat log and nothing else.
  // That is the LAW (UI_AGENT.md) and `verify-chatpage` already asserts it
  // from the other side; this gate was simply never updated with the anchor,
  // so two of my own gates contradicted each other and this one lost.
  // Asserted as the law now: the lift is applied, and the stack STAYS PUT,
  // keeps its order and keeps its gap — a stack that jumped over the keys
  // would be the regression, not one that sits still under the chip.
  const before = await rects();
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--ml-inputlift", "430px");
    document.documentElement.classList.add("ml-kb-up");
  });
  await page.waitForTimeout(400);
  const lifted = await rects();
  const pillMoved = Math.abs(before.pill.b - lifted.pill.b);
  const btnMoved = Math.abs(before.btn.b - lifted.btn.b);
  pillMoved <= 1 && btnMoved <= 1
    ? ok("keyboard lift: the top-anchored stack stays put (the lift moves the chat log, not the chip's corner)")
    : fail(`the keyboard lift moved the top-anchored stack (pill ${pillMoved.toFixed(0)}px, button ${btnMoved.toFixed(0)}px)`);
  assertPill(lifted, "keyboard lift"); // …and the pill is untouched by it
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
  const g7 = await rects();
  assertStack(g7, "right-handed landscape");
  assertPill(g7, "right-handed landscape");

  // ── 8. left-handed landscape: the pill keeps its corner, button ABOVE ──
  await page.evaluate(() => window.__ml.hand("left"));
  await page.waitForTimeout(800);
  const g8 = await rects();
  assertStack(g8, "left-handed landscape"); // the row keeps the bottom corner here
  assertPill(g8, "left-handed landscape"); // …the pill is top-centred in every placement
  await page.evaluate(() => window.__ml.hand("right"));

  // ── 8b. HIS OWN PHONE — 495x1111, MEASURED, NOT ASSUMED ──────────────
  // Every other reading in this gate is taken at 393x851. That is a real and
  // common CSS viewport (iPhone 14/15, Pixel) but it is NOT HIS, and taking
  // every reading there is what put the time-of-day pill in the middle of his
  // screen on 2026-09-19: the two cards fill the top row at 393 and the pill
  // drops below it, so the placement he asked for was never once executed.
  // 495x1111 is read off his own screenshot rather than guessed — the 116px
  // pill spans 253 device px in a 1080-wide frame, so dpr 2.18 and a 495px
  // layout viewport. Keep BOTH: 393 is where the fallback row is exercised,
  // his is where the rule he actually asked for is.
  await page.evaluate(() => window.__ml.hand("right"));
  await page.setViewportSize({ width: 495, height: 1111 });
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("ml-land") && !document.querySelector(".ml-flip-veil"),
    null,
    { timeout: 15000 },
  );
  const g8b = await rects();
  g8b.onTop === true
    ? ok("his geometry: the pill takes the cards' own line")
    : fail(`his geometry: the pill did NOT take the top row (${JSON.stringify(g8b.pill)}, ${g8b.card}px cards in a ${g8b.vw}px view)`);
  assertStack(g8b, "his geometry");
  assertPill(g8b, "his geometry");

  // ── 9. portrait return ─────────────────────────────────────────────────
  await page.setViewportSize({ width: 393, height: 851 });
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("ml-land") && !document.querySelector(".ml-flip-veil"),
    null,
    { timeout: 15000 },
  );
  const g9 = await rects();
  assertStack(g9, "portrait return");
  assertPill(g9, "portrait return");

  errors.length === 0 ? ok("no page errors") : fail(`page errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
}

console.log(bad ? "\nWIKIBTN: FAIL" : "\nWIKIBTN: PASS");
process.exit(bad ? 1 : 0);
