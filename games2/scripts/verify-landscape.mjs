// LANDSCAPE + HANDEDNESS verification (maintainer 2026-08-05). In the world,
// on a TOUCH device, a landscape viewport turns the golden-ratio split on its
// side: the menu becomes a full-height 38.2vw SIDE COLUMN with a vertical tab
// strip hugging the game-view edge, and the game view runs edge to edge on
// the other side. Which side is HANDEDNESS (controls.ts, default right):
//   right-handed: menu LEFT,  stick floats over the game view on the RIGHT
//   left-handed:  menu RIGHT, stick floats over the game view on the LEFT
// The corner chrome re-anchors to the GAME VIEW's own corners (bars top,
// chat bottom-left, clock pill bottom-right) via the --gv-left/--gv-right
// insets. Portrait keeps today's layout byte-for-byte; desktop (no touch)
// never gets the landscape layout at any aspect. The one-time handedness
// help chip shows on the gamepad page until dismissed, and dismissal is
// forever (localStorage) — and it must never move the controls.
//
// Drives the REAL client against a dev stack.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const OUT = process.env.OUT || "/tmp";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => {
  console.log("FAIL:", m);
  bad = true;
};
const ok = (m) => console.log("ok:", m);

// One touch context, LANDSCAPE phone geometry (the maintainer's 851x393).
// dsf 1 — software-GL at dsf 2 starves the page (repo rule).
const ctx = await browser.newContext({
  viewport: { width: 851, height: 393 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });

  // ---- 0. OUTSIDE the world, landscape still shows the rotate prompt ----
  const pre = await page.evaluate(() => ({
    rotate: getComputedStyle(document.querySelector("#ml-rotate")).display,
    ingame: document.documentElement.classList.contains("ml-ingame"),
  }));
  pre.rotate !== "none" && !pre.ingame
    ? ok("select screen in landscape still shows the rotate prompt")
    : fail(`rotate prompt on select: display=${pre.rotate} ingame=${pre.ingame}`);

  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 30000 });
  await page.waitForTimeout(800);

  // The anchors TRANSITION (.25-.3s) and the starved headless compositor can
  // report mid-flight values long after wall-clock duration — never read on a
  // fixed delay; poll until two consecutive frames agree.
  const settle = async () => {
    let prev = "";
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(150);
      const now = await page.evaluate(() =>
        ["ml-bars-l", "ml-bars-r", "ml-clock", "ml-pad-stick"]
          .map((c) => {
            const e = document.querySelector("." + c);
            if (!e) return "-";
            const r = e.getBoundingClientRect();
            return `${Math.round(r.left)},${Math.round(r.top)}`;
          })
          .join("|"),
      );
      if (now === prev) return;
      prev = now;
    }
  };

  const geom = () =>
    page.evaluate(() => {
      const r = (s) => {
        const e = document.querySelector(s);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return {
          l: Math.round(b.left),
          r: Math.round(b.right),
          t: Math.round(b.top),
          b: Math.round(b.bottom),
          w: Math.round(b.width),
          h: Math.round(b.height),
          vis: b.width > 0 && getComputedStyle(e).display !== "none",
        };
      };
      const cs = getComputedStyle(document.documentElement);
      return {
        vw: innerWidth,
        vh: innerHeight,
        land: document.documentElement.classList.contains("ml-land"),
        lh: document.documentElement.classList.contains("ml-lh"),
        rotate: getComputedStyle(document.querySelector("#ml-rotate")).display,
        gvL: parseFloat(cs.getPropertyValue("--gv-left")) || 0,
        gvR: parseFloat(cs.getPropertyValue("--gv-right")) || 0,
        hudH: parseFloat(cs.getPropertyValue("--hud-h")) || 0,
        game: r("#game"),
        canvas: r("#game canvas"),
        hud: r(".ml-hud"),
        tabrow: r(".ml-tabrow"),
        tab0: r(".ml-tab"),
        tabFirst: r(".ml-tab:first-child"),
        tabLast: r(".ml-tab:last-child"),
        stickOp: (() => {
          const e = document.querySelector(".ml-pad-stick");
          return e ? getComputedStyle(e).opacity : null;
        })(),
        pages: r(".ml-pages"),
        barsL: r(".ml-bars-l"),
        barsR: r(".ml-bars-r"),
        clock: r(".ml-clock"),
        chatlog: r(".ml-chatlog"),
        stick: r(".ml-pad-stick"),
        jump: r(".ml-pad-jump"),
        pickup: r(".ml-pad-pickup"),
        padBlur: r(".ml-pad-blur"),
        padBlurCss: (() => {
          const e = document.querySelector(".ml-pad-blur");
          if (!e) return null;
          const c = getComputedStyle(e);
          return {
            display: c.display,
            z: c.zIndex,
            filter: c.backdropFilter || c.webkitBackdropFilter,
            bg: c.backgroundColor,
          };
        })(),
        help: r(".ml-pad-help"),
        stickZ: (() => {
          const e = document.querySelector(".ml-pad-stick");
          return e ? getComputedStyle(e).zIndex : null;
        })(),
        stickPos: (() => {
          const e = document.querySelector(".ml-pad-stick");
          return e ? getComputedStyle(e).position : null;
        })(),
      };
    });

  // ---- 1. RIGHT-HANDED (default) landscape: menu LEFT, game RIGHT ----
  let g = await geom();
  const menuW = Math.round(851 * 0.382);
  g.land && !g.lh ? ok("in-world landscape sets ml-land (right-handed default)") : fail(`classes: land=${g.land} lh=${g.lh}`);
  g.rotate === "none" ? ok("rotate prompt hidden in the world") : fail(`rotate prompt visible in-game (${g.rotate})`);
  Math.abs(g.hud.w - menuW) <= 2 && g.hud.l === 0 && g.hud.h >= 390
    ? ok(`menu is a full-height left column (${g.hud.w}px ≈ 38.2vw)`)
    : fail(`menu column ${JSON.stringify(g.hud)}, want left, w≈${menuW}, full height`);
  Math.abs(g.game.l - menuW) <= 2 && Math.abs(g.game.w - (851 - menuW)) <= 2
    ? ok(`game view fills the rest (${g.game.w}px from x=${g.game.l})`)
    : fail(`game view ${JSON.stringify(g.game)}`);
  g.canvas && Math.abs(g.canvas.w - g.game.w) <= 2 && Math.abs(g.canvas.h - g.game.h) <= 2
    ? ok(`canvas resized with the view (${g.canvas.w}x${g.canvas.h})`)
    : fail(`canvas ${JSON.stringify(g.canvas)} vs game ${JSON.stringify(g.game)}`);
  // tab strip: vertical, on the column's game-view (right) edge, icons upright
  g.tabrow.h > g.tabrow.w && Math.abs(g.tabrow.r - g.hud.r) <= 2 && g.tabrow.l > g.pages.l
    ? ok(`tab strip is vertical on the game-view edge (x ${g.tabrow.l}..${g.tabrow.r})`)
    : fail(`tabrow ${JSON.stringify(g.tabrow)} vs hud ${JSON.stringify(g.hud)} pages ${JSON.stringify(g.pages)}`);
  // …and the buttons are vertically CENTERED: same distance to the screen's
  // top and bottom edges (maintainer 2026-08-05).
  Math.abs(g.tabFirst.t - (g.vh - g.tabLast.b)) <= 3
    ? ok(`tab buttons vertically centered (top gap ${g.tabFirst.t}, bottom gap ${g.vh - g.tabLast.b})`)
    : fail(`tabs not centered: top gap ${g.tabFirst.t} vs bottom gap ${g.vh - g.tabLast.b}`);
  // FULL-SIZE buttons (maintainer: "menu buttons look smaller in landscape"
  // — the ≤640px-height portrait rule was shrinking every landscape phone).
  g.tab0.h === 56 && g.tab0.w >= 64
    ? ok(`tabs at full size (${g.tab0.w}x${g.tab0.h} — not the short-phone 48px tier)`)
    : fail(`tab ${JSON.stringify(g.tab0)}, want 56 tall / >=64 wide`);
  // BACKPACK grid turns with the layout: 3 wide x 5 tall in landscape.
  await page.evaluate(() => document.querySelector('[data-tab="backpack"]').click());
  await page.waitForTimeout(300);
  const slots = await page.evaluate(() => {
    const g2 = document.querySelector(".ml-slots");
    const cols = getComputedStyle(g2).gridTemplateColumns.split(" ").length;
    const first = g2.firstElementChild.getBoundingClientRect();
    return { cols, slotW: Math.round(first.width) };
  });
  slots.cols === 3 && slots.slotW >= 55
    ? ok(`backpack is 3 wide x 5 tall in landscape (slots ${slots.slotW}px)`)
    : fail(`backpack grid ${JSON.stringify(slots)}, want 3 columns of >=55px`);
  // CHAT float stays INSIDE the game view: focus the Chat page's input and
  // the keyboard-floated box must start at the game view's left edge, not 10.
  await page.evaluate(() => document.querySelector('[data-tab="chat"]').click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector(".ml-chat-input").focus());
  await page.waitForFunction(() => document.documentElement.classList.contains("ml-kb-up"), null, { timeout: 8000, polling: 100 }).catch(() => {});
  const float = await page.evaluate(() => {
    const r = document.querySelector(".ml-chat-input").getBoundingClientRect();
    return { l: Math.round(r.left), r: Math.round(innerWidth - r.right) };
  });
  Math.abs(float.l - (menuW + 10)) <= 2 && Math.abs(float.r - 10) <= 2
    ? ok(`floated chat box stays inside the game view (l=${float.l}, r-gap=${float.r})`)
    : fail(`floated box spans wrong: ${JSON.stringify(float)}, want l=${menuW + 10} r=10`);
  await page.evaluate(() => document.querySelector(".ml-chat-input").blur());
  await page.waitForTimeout(400);
  const icon = await page.evaluate(() => {
    const i = document.querySelector(".ml-tab-icon");
    const r = i.getBoundingClientRect();
    return { w: Math.round(r.width), natW: i.naturalWidth, transform: getComputedStyle(i).transform };
  });
  icon.transform === "none" && Math.abs(icon.w - icon.natW / 2) <= 1
    ? ok(`icons upright at their authored grid (${icon.w}px, no transform)`)
    : fail(`icon ${JSON.stringify(icon)} — icons must not be rotated or rescaled`);
  // corner chrome hugs the GAME VIEW
  Math.abs(g.barsL.l - (menuW + 10)) <= 2 && g.barsL.t === 10
    ? ok(`HP chip at the game view's top-left (${g.barsL.l},${g.barsL.t})`)
    : fail(`left chip ${JSON.stringify(g.barsL)} want l=${menuW + 10}`);
  Math.abs(851 - 10 - g.barsR.r) <= 2 ? ok("XP chip at the top-right") : fail(`right chip ${JSON.stringify(g.barsR)}`);
  // The pill leaves the thumb's corner in RIGHT-handed landscape and parks
  // under the XP chip (maintainer 2026-08-05): right edges aligned, 10px gap.
  Math.abs(g.clock.r - g.barsR.r) <= 2 && Math.abs(g.clock.t - g.barsR.b - 10) <= 2
    ? ok(`clock pill sits under the XP chip (top ${g.clock.t} = chip bottom ${g.barsR.b} + 10, right edges ${g.clock.r}/${g.barsR.r})`)
    : fail(`clock ${JSON.stringify(g.clock)} vs XP chip ${JSON.stringify(g.barsR)}`);
  g.clock.b < g.vh - 100
    ? ok("…and is clear of the stick's bottom corner")
    : fail(`clock still low (b=${g.clock.b} of ${g.vh})`);

  // ---- 2. gamepad tab: stick FLOATS over the game view right side, jump in
  //         the column, help chip present and not touching the controls ----
  await page.evaluate(() => document.querySelector('[data-tab="gamepad"]').click());
  await settle();
  g = await geom();
  g.stickPos === "fixed" && g.stickZ === "4"
    ? ok("stick floats (fixed, z 4 — under the chat overlay's z 5)")
    : fail(`stick pos=${g.stickPos} z=${g.stickZ}`);
  g.stick.l > g.game.l && Math.abs(851 - 10 - g.stick.r) <= 2 && Math.abs(g.vh - 10 - g.stick.b) <= 2
    ? ok(`stick in the game view's bottom-RIGHT corner (x ${g.stick.l}..${g.stick.r}, b ${g.stick.b})`)
    : fail(`stick ${JSON.stringify(g.stick)} want r=${851 - 10}, b=${g.vh - 10}`);
  Math.abs(parseFloat(g.stickOp) - 0.15) <= 0.01
    ? ok(`stick ghosted at 0.15 alpha — 85% transparent (${g.stickOp})`)
    : fail(`stick opacity ${g.stickOp}, want 0.15`);
  // ALWAYS ON SCREEN in landscape (maintainer 2026-08-05): the stick is
  // reparented to <body>, so another tab's page can't hide it.
  await page.evaluate(() => document.querySelector('[data-tab="backpack"]').click());
  await page.waitForTimeout(300);
  const onBackpack = await page.evaluate(() => {
    const e = document.querySelector(".ml-pad-stick");
    const r = e.getBoundingClientRect();
    return { parent: e.parentElement.tagName, w: Math.round(r.width), visible: r.width > 0 && e.offsetParent !== null };
  });
  onBackpack.parent === "BODY" && onBackpack.w > 100
    ? ok(`stick stays on screen on the backpack tab (parented to <body>, ${onBackpack.w}px)`)
    : fail(`stick gone on another tab: ${JSON.stringify(onBackpack)}`);
  await page.evaluate(() => document.querySelector('[data-tab="gamepad"]').click());
  await page.waitForTimeout(300);
  // BLUR DISC: its own element (the stick's opaque bg + 0.25 opacity would
  // hide/dilute a backdrop-filter on the stick itself), pinned to the same
  // rect, z 3 = under the stick, transparent so ONLY the blur reads.
  if (!g.padBlurCss || g.padBlurCss.display === "none") fail("no blur disc under the landscape stick");
  else {
    /blur\(/.test(g.padBlurCss.filter || "")
      ? ok(`stick backed by a blur disc (${g.padBlurCss.filter})`)
      : fail(`blur disc has no backdrop-filter (${JSON.stringify(g.padBlurCss)})`);
    +g.padBlurCss.z < +g.stickZ && /rgba\(0, 0, 0, 0\)|transparent/.test(g.padBlurCss.bg)
      ? ok(`blur disc under the stick (z ${g.padBlurCss.z} < ${g.stickZ}) and adds no tint`)
      : fail(`blur disc z/bg wrong: ${JSON.stringify(g.padBlurCss)} stick z ${g.stickZ}`);
    Math.abs(g.padBlur.l - g.stick.l) <= 1 && Math.abs(g.padBlur.t - g.stick.t) <= 1 &&
    Math.abs(g.padBlur.w - g.stick.w) <= 1
      ? ok("blur disc tracks the stick's rect exactly")
      : fail(`blur ${JSON.stringify(g.padBlur)} vs stick ${JSON.stringify(g.stick)}`);
  }
  // behind the corner chrome: chat text (5) and the pill (8) draw OVER the
  // ghost stick (4) — and both are pointer-events:none, so the thumb still
  // steers straight through them.
  const zOrder = await page.evaluate(() => ({
    pill: getComputedStyle(document.querySelector(".ml-clock")).zIndex,
    pillPe: getComputedStyle(document.querySelector(".ml-clock")).pointerEvents,
    chat: getComputedStyle(document.querySelector(".ml-chatlog")).zIndex,
    chatPe: getComputedStyle(document.querySelector(".ml-chatlog")).pointerEvents,
  }));
  +zOrder.pill > 4 && +zOrder.chat > 4 && zOrder.pillPe === "none" && zOrder.chatPe === "none"
    ? ok(`chat (z ${zOrder.chat}) and pill (z ${zOrder.pill}) draw over the stick, taps pass through`)
    : fail(`z/pe order wrong: ${JSON.stringify(zOrder)}`);
  g.jump.vis && g.jump.r < g.hud.r && g.jump.l > g.hud.l - 2
    ? ok(`jump stays in the menu column under the other thumb (x ${g.jump.l}..${g.jump.r})`)
    : fail(`jump ${JSON.stringify(g.jump)} vs hud ${JSON.stringify(g.hud)}`);
  // JUMP UNDER PICK UP (maintainer 2026-08-05): a centred vertical stack.
  g.pickup.vis && g.pickup.b <= g.jump.t
    ? ok(`jump sits UNDER pick up (pickup b=${g.pickup.b}, jump t=${g.jump.t})`)
    : fail(`stack order wrong: pickup ${JSON.stringify(g.pickup)} jump ${JSON.stringify(g.jump)}`);
  Math.abs((g.jump.l + g.jump.r) / 2 - (g.pickup.l + g.pickup.r) / 2) <= 2
    ? ok("jump and pick up share a centre line")
    : fail(`not centred: jump mid ${(g.jump.l + g.jump.r) / 2} vs pickup mid ${(g.pickup.l + g.pickup.r) / 2}`);
  // ANIMATION only on orientation/handedness changes: at rest the stick's
  // transition covers opacity (the grab fade) but NOT left/top — page entry
  // must reposition instantly (the .anim class is transient).
  const tp = await page.evaluate(() => getComputedStyle(document.querySelector(".ml-pad-stick")).transitionProperty);
  /opacity/.test(tp) && !/left|top|all/.test(tp)
    ? ok(`at rest only opacity transitions (${tp})`)
    : fail(`resting transition-property "${tp}" — left/top must be .anim-gated`);
  if (!g.help || !g.help.vis) fail("handedness help chip missing on first visit");
  else {
    const overlaps = (a, b) => a && b && a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
    !overlaps(g.help, g.jump) && !overlaps(g.help, g.stick)
      ? ok("help chip overlays without touching the controls")
      : fail(`help chip overlaps a control: help=${JSON.stringify(g.help)} jump=${JSON.stringify(g.jump)}`);
  }
  await page.screenshot({ path: `${OUT}/landscape-rh.png` });

  // the floating stick still drives the player (whole input path, landscape)
  const p0 = await page.evaluate(() => {
    const m = window.__ml.me();
    return { x: m.x, y: m.y };
  });
  const sc = { x: (g.stick.l + g.stick.r) / 2, y: (g.stick.t + g.stick.b) / 2 };
  await page.mouse.move(sc.x, sc.y);
  await page.mouse.down();
  await page.mouse.move(sc.x - 90, sc.y, { steps: 4 }); // leftward — the corner stick has no room to the right
  await page.waitForTimeout(700);
  // IN USE the ghost fades to fully visible (maintainer 2026-08-05)
  const opHeld = await page.evaluate(() => getComputedStyle(document.querySelector(".ml-pad-stick")).opacity);
  Math.abs(parseFloat(opHeld) - 1) <= 0.02
    ? ok(`stick fades to 100% while held (${opHeld})`)
    : fail(`stick opacity ${opHeld} while held, want 1`);
  await page.mouse.up();
  const faded = await page
    .waitForFunction(
      () => Math.abs(parseFloat(getComputedStyle(document.querySelector(".ml-pad-stick")).opacity) - 0.15) <= 0.02,
      null,
      { timeout: 8000, polling: 150 },
    )
    .then(() => true)
    .catch(() => false);
  faded
    ? ok("…and back to the 0.15 ghost on release")
    : fail(
        `stick stuck at opacity ${await page.evaluate(() => getComputedStyle(document.querySelector(".ml-pad-stick")).opacity)} after release`,
      );
  const p1 = await page.evaluate(() => {
    const m = window.__ml.me();
    return { x: m.x, y: m.y };
  });
  const moved = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  moved > 3 ? ok(`floating stick moves the player (${moved.toFixed(1)}wu)`) : fail(`stick drag moved ${moved.toFixed(1)}wu`);

  // ---- 2b. the maintainer's repro: backpack tab, ROTATE, then open the
  //          gamepad tab — the controls must not animate into place ----
  await page.evaluate(() => document.querySelector('[data-tab="backpack"]').click());
  await page.setViewportSize({ width: 393, height: 851 });
  await settle();
  await page.setViewportSize({ width: 851, height: 393 });
  await settle();
  await page.evaluate(() => document.querySelector('[data-tab="gamepad"]').click());
  const track = await page.evaluate(
    () =>
      new Promise((res) => {
        const el = document.querySelector(".ml-pad-jump");
        const seen = [];
        let n = 0;
        const tick = () => {
          const r = el.getBoundingClientRect();
          seen.push(`${Math.round(r.left)},${Math.round(r.top)}`);
          if (++n < 8) requestAnimationFrame(tick);
          else res(seen);
        };
        requestAnimationFrame(tick);
      }),
  );
  new Set(track).size === 1 && !track[0].startsWith("-")
    ? ok(`gamepad entry after rotation holds still (jump pinned at ${track[0]} over ${track.length} frames)`)
    : fail(`controls moved on tab entry after rotation: ${[...new Set(track)].join(" -> ")}`);

  // ---- 3. LEFT-HANDED: everything mirrors ----
  await page.evaluate(() => window.__ml.hand("left"));
  await settle();
  g = await geom();
  g.lh ? ok("ml-lh set") : fail("ml-lh missing after hand('left')");
  Math.abs(g.hud.l - (851 - menuW)) <= 2 ? ok(`menu column now on the RIGHT (x=${g.hud.l})`) : fail(`hud ${JSON.stringify(g.hud)}`);
  g.game.l <= 2 ? ok("game view now on the LEFT") : fail(`game ${JSON.stringify(g.game)}`);
  g.tabrow.h > g.tabrow.w && Math.abs(g.tabrow.l - g.hud.l) <= 2 && g.tabrow.r < g.pages.l + 2
    ? ok("tab strip flipped to the column's game-view (left) edge")
    : fail(`tabrow ${JSON.stringify(g.tabrow)} pages ${JSON.stringify(g.pages)}`);
  Math.abs(g.stick.l - 10) <= 2 && Math.abs(g.vh - 10 - g.stick.b) <= 2
    ? ok(`stick in the bottom-LEFT corner (x=${g.stick.l}, b=${g.stick.b})`)
    : fail(`stick ${JSON.stringify(g.stick)}`);
  Math.abs(g.barsL.l - 10) <= 2 ? ok("HP chip back at screen-left (game view's corner)") : fail(`left chip ${JSON.stringify(g.barsL)}`);
  Math.abs(851 - menuW - 10 - g.clock.r) <= 2 && Math.abs(g.vh - 10 - g.clock.b) <= 2
    ? ok(`left-handed: pill back in the game view's bottom-right corner (${g.clock.r},${g.clock.b})`)
    : fail(`clock ${JSON.stringify(g.clock)} want r=${851 - menuW - 10}, b=${g.vh - 10}`);
  Math.abs(g.chatlog.l - 10) <= 2 ? ok("chat log at the game view's bottom-left") : fail(`chatlog ${JSON.stringify(g.chatlog)}`);
  await page.screenshot({ path: `${OUT}/landscape-lh.png` });

  // ---- 4. PORTRAIT return: today's layout, with the LEFT-handed mirror on
  //         the gamepad page (stick left, jump right) ----
  await page.setViewportSize({ width: 393, height: 851 });
  await settle();
  g = await geom();
  !g.land ? ok("portrait drops ml-land") : fail("ml-land stuck in portrait");
  Math.abs(g.hudH - Math.round(851 * 0.382)) <= 1
    ? ok(`portrait split restored (--hud-h ${g.hudH}px)`)
    : fail(`--hud-h ${g.hudH}`);
  g.hud.t > 500 && g.hud.w >= 390 ? ok("menu back at the bottom") : fail(`hud ${JSON.stringify(g.hud)}`);
  g.tabrow.w > g.tabrow.h ? ok("tab row horizontal again") : fail(`tabrow ${JSON.stringify(g.tabrow)}`);
  g.padBlurCss && g.padBlurCss.display === "none"
    ? ok("blur disc hidden in portrait (the stick sits on the opaque HUD page)")
    : fail(`blur disc still shown in portrait: ${JSON.stringify(g.padBlurCss)}`);
  Math.abs(g.vh - g.hudH - 10 - g.clock.b) <= 2
    ? ok(`portrait pill back above the HUD rail (b=${g.clock.b})`)
    : fail(`portrait clock ${JSON.stringify(g.clock)}`);
  g = await geom();
  g.stickPos !== "fixed" && g.stick.l < 393 * 0.5
    ? ok(`left-handed portrait: stick on the page's LEFT (x ${g.stick.l}..${g.stick.r})`)
    : fail(`stick ${JSON.stringify(g.stick)} pos=${g.stickPos}`);
  g.jump.l > 393 * 0.5 ? ok("…and jump on the RIGHT") : fail(`jump ${JSON.stringify(g.jump)}`);
  await page.screenshot({ path: `${OUT}/portrait-lh.png` });

  // back to right-handed: the maintainer's exact portrait layout
  await page.evaluate(() => window.__ml.hand("right"));
  await settle();
  g = await geom();
  g.stick.l > 393 * 0.5 && g.jump.r < 393 * 0.5
    ? ok("right-handed portrait: stick right / jump left (the original spots)")
    : fail(`stick ${JSON.stringify(g.stick)} jump ${JSON.stringify(g.jump)}`);

  // ---- 5. help chip: dismiss is forever ----
  const before = await page.evaluate(() => {
    const s = document.querySelector(".ml-pad-stick").getBoundingClientRect();
    document.querySelector(".ml-pad-help-x").click();
    const after = document.querySelector(".ml-pad-stick").getBoundingClientRect();
    return {
      gone: !document.querySelector(".ml-pad-help"),
      stored: localStorage.getItem("ml-hand-help"),
      stickMoved: Math.abs(s.left - after.left) + Math.abs(s.top - after.top),
    };
  });
  before.gone && before.stored === "1" ? ok("help chip dismissed + persisted") : fail(`dismiss ${JSON.stringify(before)}`);
  before.stickMoved === 0 ? ok("dismissing the chip moves nothing") : fail(`stick moved ${before.stickMoved}px on dismiss`);
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 60000 });
  await page.evaluate(() => document.querySelector('[data-tab="gamepad"]').click());
  await page.waitForTimeout(500);
  const again = await page.evaluate(() => !!document.querySelector(".ml-pad-help"));
  !again ? ok("help chip never returns after dismissal") : fail("help chip came back after reload");

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
} finally {
  await ctx.close();
}

// ---- 6. DESKTOP (no touch) at a wide viewport keeps the portrait split ----
{
  const dctx = await browser.newContext({ viewport: { width: 900, height: 620 } });
  const dpage = await dctx.newPage();
  try {
    await dpage.goto(`${BASE}/`, { waitUntil: "load" });
    await dpage.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
    await dpage.evaluate(() => window.__mlSelect.commit());
    await dpage.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 60000 });
    await dpage.waitForTimeout(500);
    const d = await dpage.evaluate(() => ({
      land: document.documentElement.classList.contains("ml-land"),
      hudTop: Math.round(document.querySelector(".ml-hud").getBoundingClientRect().top),
    }));
    !d.land && d.hudTop > 300
      ? ok(`desktop wide viewport keeps the portrait split (hud top ${d.hudTop})`)
      : fail(`desktop got the landscape layout: ${JSON.stringify(d)}`);
  } finally {
    await dctx.close();
  }
}

await browser.close();
if (bad) {
  console.log("=== FAIL ===");
  process.exit(1);
}
console.log("LANDSCAPE OK — side column, floating stick, handedness, help chip");
console.log("PASS");
