// THE SETTINGS SUB-TABS (maintainer 2026-09-19: "a subsection in settings … the
// subsection appears by sliding up the menu over it so the menu content area
// is just as big as the menu inner area we have today … in landscape ONLY use
// the icons and show the tabs at the top … at most 4 … the last option should
// always be dev if the admin is logged in").
// What this pins (hud.ts SUBTABS / syncSubrow / applyLayout):
//  - PORTRAIT: opening Settings unfolds a strip under the tab row and the rail
//    grows by EXACTLY the strip's height (--sub-h): the page keeps the top edge
//    and the height it had on the backpack, the tab row rises by the strip,
//    the canvas keeps its three-row split (never resized), and everything
//    anchored above the rail reads the new --hud-h. Leaving Settings undoes
//    all of it and the rail is the three-row law again.
//  - THE SLIDE IS LOCK-STEP by declaration: the rail's top and the strip's
//    fold share one duration and one easing (the harness's compositor cannot
//    film 250ms — measured 300ms per frame with GL dropped — so the contract
//    is asserted on the computed transitions and on the collapse having
//    content to fold: the leaving page's chip row stays shown).
//  - THE FOUR PAGES: General (Theme choice, the adopted Resolution dial, Log
//    out), Sound (two volume dials on the composer's per-bus level), Controls
//    (the Hand choice, left on the left, and the stick's two fine-tune dials),
//    Dev (the whole old page: the switch grid with its .ml-hudbtn hook, the
//    dials, the ambient checklist) — Dev hidden until the server says admin,
//    and a remembered Dev the server denies falls back.
//  - Every control is LIVE: Theme flips data-theme, Hand flips __ml.hand and
//    the root's ml-lh, a volume dial sets the composer's level, a stick dial
//    moves the floating stick in the view.
//  - LANDSCAPE: the strip sits at the top of the page column, inside it,
//    icons only (labels display:none), --hud-h and --sub-h stay 0 and the
//    column's width is untouched.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";

let bad = false;
const ok = (m) => console.log("ok:", m);
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const near = (a, b, tol = 1) => a != null && b != null && Math.abs(a - b) <= tol;

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });

async function join(ctx, { admin = false } = {}) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  if (admin) await grantAdmin(page);
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 90000 });
  await page.waitForTimeout(500);
  return page;
}
/** The admin, the way verify-recbtn grants it: the server's answer is what
 *  admin.ts believes, so the route IS the login. */
async function grantAdmin(page) {
  await page.route("**/api/wiki/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ admin: true }) }),
  );
  // for the next navigation, AND for the page that is already open (an init
  // script runs only on navigation — a mid-session grant needs the write now)
  await page.addInitScript(() => localStorage.setItem("wiki-admin-token", "gate"));
  await page.evaluate(() => localStorage.setItem("wiki-admin-token", "gate")).catch(() => {});
}

const geom = (page) => page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const px = (v) => parseFloat(v) || 0;
  const r = (s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { t: Math.round(b.top * 10) / 10, b: Math.round(b.bottom * 10) / 10, l: Math.round(b.left * 10) / 10, r: Math.round(b.right * 10) / 10, h: Math.round(b.height * 10) / 10, w: Math.round(b.width * 10) / 10 };
  };
  // the three-row law, computed the way verify-chat / verify-landscape do
  const threeRows = (() => {
    const tab = document.querySelector(".ml-tabrow"), pg = document.querySelector('.ml-page[data-page="backpack"]'), grid = pg && pg.querySelector(".ml-slots");
    if (!tab || !grid) return null;
    const pcs = getComputedStyle(pg), gcs = getComputedStyle(grid);
    const inner = Math.min(innerWidth - px(pcs.paddingLeft) - px(pcs.paddingRight), px(gcs.maxWidth) || Infinity);
    const cols = (gcs.gridTemplateColumns.match(/\d+(?=\s*,)/) || [5])[0] * 1;
    const slot = (inner - (cols - 1) * px(gcs.columnGap)) / cols;
    const rows = Math.round(1 + tab.getBoundingClientRect().height + 2 * px(pcs.paddingTop) + 3 * slot + 2 * px(gcs.rowGap) + px(cs.getPropertyValue("--ml-safe-bottom")));
    return Math.min(rows, Math.round(innerHeight * 0.382));
  })();
  const bar = document.querySelector(".ml-subrow.open .ml-subtabs.show .ml-subbar");
  const chips = bar ? [...bar.querySelectorAll(".ml-subtab")].filter((b) => !b.hidden).map((b) => {
    const lab = b.querySelector(".ml-subtab-label");
    const lcs = lab && getComputedStyle(lab);
    return { id: b.dataset.sub, w: b.getBoundingClientRect().width, sel: b.classList.contains("sel"),
      label: lcs ? lcs.display : null, clipped: lab ? lab.scrollWidth > lab.clientWidth + 1 : null };
  }) : [];
  return {
    hudH: px(cs.getPropertyValue("--hud-h")), hudInv: px(cs.getPropertyValue("--hud-h-inv")), subH: px(cs.getPropertyValue("--sub-h")),
    menuW: px(cs.getPropertyValue("--menu-w")), threeRows,
    open: !!document.querySelector(".ml-subrow.open"), rowShown: !!document.querySelector(".ml-subtabs.show"),
    hud: r(".ml-hud"), tabrow: r(".ml-tabrow"), strip: r(".ml-subrow"), row: r(".ml-subtabs.show"), bar: r(".ml-subtabs.show .ml-subbar"),
    body: r(".ml-body"), pages: r(".ml-pages"), game: r("#game"), canvas: r("canvas"),
    chips, n: bar ? bar.dataset.n : null,
    sub: window.__mlHud ? window.__mlHud.sub("settings") : null, subs: window.__mlHud ? window.__mlHud.subs("settings") : null,
    anim: document.documentElement.classList.contains("ml-subanim"),
  };
});
/** The rail's top transitions and the compositor is starved — poll until two
 *  reads agree and the slide's class is gone. */
async function settle(page) {
  let prev = "";
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(150);
    const now = await page.evaluate(() => {
      if (document.documentElement.classList.contains("ml-subanim")) return `anim-${Math.random()}`;
      const r = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top) : "-"; };
      return `${r(".ml-hud")}|${r(".ml-pages")}|${document.querySelector(".ml-subrow").getBoundingClientRect().height}`;
    });
    if (now === prev) return;
    prev = now;
  }
}
const click = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }, sel);

try {
  // ---- 1. PORTRAIT, a player ------------------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const page = await join(ctx);
    const base = await geom(page);
    !base.open && base.subH === 0 && base.hudH === base.threeRows
      ? ok(`backpack: no strip, --sub-h 0, --hud-h ${base.hudH} = the three-row law`)
      : fail(`backpack: open=${base.open} subH=${base.subH} hudH=${base.hudH} threeRows=${base.threeRows}`);

    await click(page, '.ml-tab[data-tab="settings"]');
    await settle(page);
    const s = await geom(page);
    s.open && s.subH > 30 && near(s.subH, s.row?.h)
      ? ok(`settings: the strip is open and --sub-h ${s.subH}px is its chip row's height`)
      : fail(`settings: open=${s.open} subH=${s.subH} row=${JSON.stringify(s.row)}`);
    near(s.hudH, base.threeRows + s.subH)
      ? ok(`the rail grew by exactly the strip: --hud-h ${base.hudH} -> ${s.hudH}`)
      : fail(`--hud-h ${s.hudH}, want three rows ${base.threeRows} + strip ${s.subH}`);
    near(s.pages.t, base.pages.t) && near(s.pages.h, base.pages.h)
      ? ok(`the page keeps its place and its height (top ${s.pages.t}, ${s.pages.h}px — the whole point)`)
      : fail(`pages moved: ${JSON.stringify(base.pages)} -> ${JSON.stringify(s.pages)}`);
    near(s.hud.t, base.hud.t - s.subH) && near(s.tabrow.t, base.tabrow.t - s.subH)
      ? ok(`the HUD and its tab row rose by the strip (${base.hud.t} -> ${s.hud.t})`)
      : fail(`hud top ${base.hud.t} -> ${s.hud.t}, tabrow ${base.tabrow.t} -> ${s.tabrow.t}, strip ${s.subH}`);
    near(s.game.h, base.game.h) && near(s.canvas.h, base.canvas.h) && near(s.game.b, s.hud.t + s.subH)
      ? ok(`the canvas was not resized (${s.canvas.h}px, its bottom under the strip)`)
      : fail(`game ${JSON.stringify(base.game)} -> ${JSON.stringify(s.game)}, canvas ${JSON.stringify(s.canvas)}`);
    near(s.strip.t, s.tabrow.b) && near(s.pages.t, s.strip.b)
      ? ok("the strip sits between the tab row and the pages")
      : fail(`strip ${JSON.stringify(s.strip)} tabrow ${JSON.stringify(s.tabrow)} pages ${JSON.stringify(s.pages)}`);
    near(s.bar.l, s.tabrow.l + 16, 1.5) && near(s.bar.r, s.tabrow.r - 16, 1.5)
      ? ok("the chip bar takes the tab row's 16px sides")
      : fail(`bar ${JSON.stringify(s.bar)} vs tabrow ${JSON.stringify(s.tabrow)}`);
    const ids = s.chips.map((c) => c.id).join(",");
    ids === "general,sound,controls" && (s.subs || []).join(",") === ids
      ? ok(`a player sees General, Sound, Controls — no Dev (${ids})`)
      : fail(`player chips: ${ids}; subs ${JSON.stringify(s.subs)}`);
    const ws = s.chips.map((c) => c.w);
    Math.max(...ws) - Math.min(...ws) <= 1.5 && near(ws.reduce((a, b) => a + b, 0), s.bar.w - 2, 2)
      ? ok(`chips equal width and fill the bar (${ws.map((w) => w.toFixed(1)).join("/")})`)
      : fail(`chip widths ${ws.join("/")} in a ${s.bar.w}px bar`);
    s.chips.every((c) => c.label !== "none" && !c.clipped)
      ? ok("portrait chips carry their labels, none clipped")
      : fail(`labels: ${JSON.stringify(s.chips)}`);
    s.sub === "general" && s.chips.find((c) => c.id === "general")?.sel
      ? ok("General opens first")
      : fail(`first sub-tab ${s.sub}, chips ${JSON.stringify(s.chips)}`);

    // -- the transition contract: one duration, one easing, both properties --
    const tr = await page.evaluate(() => {
      document.documentElement.classList.add("ml-subanim");
      const h = getComputedStyle(document.querySelector(".ml-hud")), st = getComputedStyle(document.querySelector(".ml-subrow"));
      const out = { hud: [h.transitionProperty, h.transitionDuration, h.transitionTimingFunction], strip: [st.transitionProperty, st.transitionDuration, st.transitionTimingFunction] };
      document.documentElement.classList.remove("ml-subanim");
      const off = getComputedStyle(document.querySelector(".ml-hud"));
      out.hudOff = [off.transitionProperty, off.transitionDuration];
      return out;
    });
    tr.hud[0] === "top" && tr.strip[0] === "grid-template-rows" && tr.hud[1] === tr.strip[1] && tr.hud[2] === tr.strip[2] && tr.hud[1] !== "0s"
      ? ok(`the slide is lock-step by declaration: top and grid-template-rows over ${tr.hud[1]} ${tr.hud[2]}`)
      : fail(`transitions: hud ${tr.hud.join(" ")} / strip ${tr.strip.join(" ")}`);
    tr.hudOff[0] !== "top" || tr.hudOff[1] === "0s"
      ? ok("…and the rail's top snaps again once the slide's class is gone (resizes and rotations stay snaps)")
      : fail(`the rail keeps a top transition without ml-subanim: ${tr.hudOff.join(" ")}`);

    // -- General: theme, the adopted Resolution dial, Log out --
    const gen = await page.evaluate(() => {
      const pane = document.querySelector('.ml-sub[data-sub="general"]');
      const shown = pane && getComputedStyle(pane).display !== "none";
      const theme = [...pane.querySelectorAll(".ml-themebtn .ml-plate-btn")].map((b) => ({ t: b.textContent.trim(), on: b.classList.contains("on") }));
      const logout = [...pane.querySelectorAll(":scope > .ml-plate-btn")].find((b) => /log out/i.test(b.textContent));
      const titles = [...pane.querySelectorAll(".ml-sec-title")].map((t) => t.textContent.trim());
      return { shown, theme, logout: !!logout, logoutW: logout ? logout.getBoundingClientRect().width : 0, paneW: pane.getBoundingClientRect().width, titles, dataTheme: document.documentElement.dataset.theme || "" };
    });
    gen.shown && gen.theme.length === 2 && gen.theme.filter((t) => t.on).length === 1 && gen.logout && near(gen.logoutW, gen.paneW)
      ? ok(`General: a Theme choice (${gen.theme.map((t) => `${t.t}${t.on ? "*" : ""}`).join("|")}), Log out full width, sections ${gen.titles.join("/")}`)
      : fail(`General: ${JSON.stringify(gen)}`);
    await page.evaluate(() => [...document.querySelectorAll('.ml-sub[data-sub="general"] .ml-themebtn .ml-plate-btn')].find((b) => b.textContent.trim() === "Dark").click());
    await page.waitForTimeout(150);
    const dark = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, on: [...document.querySelectorAll('.ml-themebtn .ml-plate-btn')].find((b) => b.classList.contains("on"))?.textContent.trim() }));
    dark.theme === "dark" && dark.on === "Dark" ? ok("Theme → Dark sets data-theme=dark and lights Dark") : fail(`after Dark: ${JSON.stringify(dark)}`);
    await page.evaluate(() => [...document.querySelectorAll('.ml-sub[data-sub="general"] .ml-themebtn .ml-plate-btn')].find((b) => b.textContent.trim() === "Light").click());
    await page.waitForTimeout(150);
    const light = await page.evaluate(() => document.documentElement.dataset.theme);
    light === "light" ? ok("…and Light sets it back") : fail(`after Light: ${light}`);
    // the games agent's Resolution dial is injected by the scene's 250ms poll
    // into the Dev dial group and ADOPTED into General (the receiving-side rule)
    const adopted = await page.waitForFunction(() => {
      const d = document.querySelector('.ml-sub[data-sub="general"] .ml-dials-display .ml-amb-slider');
      return d && d.querySelector(".ml-amb-slider-label")?.textContent.trim() === "Resolution" ? true : null;
    }, null, { timeout: 15000 }).then(() => true).catch(() => false);
    const devHasRes = await page.evaluate(() => [...document.querySelectorAll('.ml-sub[data-sub="dev"] .ml-dials .ml-amb-slider-label')].some((l) => l.textContent.trim() === "Resolution"));
    adopted && !devHasRes
      ? ok("the Resolution dial is adopted into General's Display section and is not in Dev")
      : fail(`Resolution dial: adopted=${adopted} stillInDev=${devHasRes}`);
    // the injectors' hooks are Dev's: the FIRST .ml-set and .ml-dials under the
    // page (what querySelector hands resdial, detaildial, navbias, the dial
    // module and the ambient cycler) sit inside the Dev pane, and every slider
    // on the page has a .ml-dials parent (the one-block law verify-smoke gates)
    const hooks = await page.evaluate(() => {
      const pg = document.querySelector('.ml-page[data-page="settings"]');
      const inDev = (el) => !!el && !!el.closest('.ml-sub[data-sub="dev"]');
      return { set: inDev(pg.querySelector(".ml-set")), dials: inDev(pg.querySelector(".ml-dials")),
        stray: [...pg.querySelectorAll(".ml-amb-slider")].filter((r) => !r.parentElement?.classList.contains("ml-dials")).map((r) => r.querySelector(".ml-amb-slider-label")?.textContent) };
    });
    hooks.set && hooks.dials && hooks.stray.length === 0
      ? ok("the first .ml-set and .ml-dials under the page are Dev's (the injectors' hooks), and every slider has a dial-group parent")
      : fail(`injector hooks: ${JSON.stringify(hooks)}`);
    const resDrawn = await page.evaluate(() => {
      const d = document.querySelector('.ml-sub[data-sub="general"] .ml-dials-display .ml-amb-slider');
      const tr = d.querySelector(".ml-slider").getBoundingClientRect(), row = d.getBoundingClientRect();
      return { trackW: tr.width, gutter: row.right - tr.right, def: !!d.querySelector(".ml-slider-def") };
    });
    resDrawn.trackW > 100 && resDrawn.gutter >= 90 && resDrawn.def
      ? ok(`…drawn with its track (${resDrawn.trackW.toFixed(0)}px), its scroll gutter and its default button`)
      : fail(`adopted dial: ${JSON.stringify(resDrawn)}`);
    // the dev grid is not on any player page
    const devHidden = await page.evaluate(() => { const b = document.querySelector(".ml-hudbtn"); return b ? b.getBoundingClientRect().width : -1; });
    devHidden === 0 ? ok("the dev grid (.ml-hudbtn) is not painted for a player") : fail(`.ml-hudbtn width ${devHidden} on a player's Settings`);

    // -- Sound: two volume dials, live on the composer --
    await page.evaluate(() => window.__mlHud.sub("settings", "sound"));
    await page.waitForTimeout(150);
    const snd = await page.evaluate(() => {
      const dials = [...document.querySelectorAll('.ml-sub[data-sub="sound"] .ml-dials .ml-amb-slider')].map((d) => ({
        label: d.querySelector(".ml-amb-slider-label")?.textContent.trim(), val: d.querySelector(".ml-amb-slider-val")?.textContent.trim(),
        def: !!d.querySelector(".ml-slider-def"), w: d.getBoundingClientRect().width }));
      const a = window.__ml.audio();
      return { dials, vol: a.vol, pages: document.querySelector(".ml-pages").getBoundingClientRect().top };
    });
    snd.dials.map((d) => d.label).join("|") === "Sound effects|Music" && snd.dials.every((d) => d.val === "100%" && d.def && d.w > 300) && snd.vol && snd.vol.sound === 1 && snd.vol.music === 1
      ? ok("Sound: Sound effects and Music as full-width volume dials at 100%, reading the composer")
      : fail(`Sound page: ${JSON.stringify(snd)}`);
    near(snd.pages, s.pages.t) ? ok("switching sub-tabs keeps the page where it is") : fail(`pages top ${s.pages.t} -> ${snd.pages} on a sub-tab switch`);
    const half = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.ml-sub[data-sub="sound"] .ml-amb-slider')].find((d) => d.querySelector(".ml-amb-slider-label")?.textContent.trim() === "Music");
      const track = row.querySelector(".ml-slider");
      const r = track.getBoundingClientRect();
      const at = (type, x) => track.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: r.top + r.height / 2 }));
      at("pointerdown", r.left + r.width / 2);
      at("pointerup", r.left + r.width / 2);
      return { val: row.querySelector(".ml-amb-slider-val")?.textContent.trim(), vol: window.__ml.audio().vol, stored: JSON.parse(localStorage.getItem("ml-audio") || "{}").vol };
    });
    half.val === "50%" && Math.abs(half.vol.music - 0.5) <= 0.01 && half.vol.sound === 1 && Math.abs((half.stored?.music ?? 0) - 0.5) <= 0.01
      ? ok(`a tap at the middle of Music sets the composer's music level to 0.5 and persists it (${JSON.stringify(half.stored)})`)
      : fail(`music dial: ${JSON.stringify(half)}`);
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.ml-sub[data-sub="sound"] .ml-amb-slider')].find((d) => d.querySelector(".ml-amb-slider-label")?.textContent.trim() === "Music");
      row.querySelector(".ml-slider-def").click();
    });
    await page.waitForTimeout(100);
    const restored = await page.evaluate(() => window.__ml.audio().vol.music);
    restored === 1 ? ok("…and its default button restores 100%") : fail(`after default: music ${restored}`);

    // -- Controls: the Hand choice, live --
    await page.evaluate(() => window.__mlHud.sub("settings", "controls"));
    await page.waitForTimeout(150);
    const hand0 = await page.evaluate(() => ({ hand: window.__ml.hand(), on: [...document.querySelectorAll(".ml-handbtn .ml-plate-btn")].find((b) => b.classList.contains("on"))?.textContent.trim(),
      order: [...document.querySelectorAll(".ml-handbtn .ml-plate-btn")].map((b) => b.textContent.trim()).join("|") }));
    hand0.hand === "right" && hand0.on === "Right-handed" ? ok("Controls: Right-handed lit for the default hand") : fail(`hand: ${JSON.stringify(hand0)}`);
    // LEFT ON THE LEFT, RIGHT ON THE RIGHT (maintainer 2026-09-19)
    hand0.order === "Left-handed|Right-handed" ? ok("Left-handed sits on the left, Right-handed on the right") : fail(`hand buttons in the order ${hand0.order}`);
    // THE FINE-TUNE: two dials in the pane's own dial group, the stick
    // following live in the view above (a ghost while Settings is open)
    const dials = await page.evaluate(() => [...document.querySelectorAll('.ml-sub[data-sub="controls"] .ml-dials .ml-amb-slider')].map((d) => ({
      label: d.querySelector(".ml-amb-slider-label")?.textContent.trim(), val: d.querySelector(".ml-amb-slider-val")?.textContent.trim(), def: !!d.querySelector(".ml-slider-def") })));
    dials.map((d) => d.label).join("|") === "Stick left / right|Stick up / down" && dials.every((d) => d.val === "0 px" && d.def)
      ? ok("Controls: the two stick dials, at 0 px, each with a default button")
      : fail(`stick dials: ${JSON.stringify(dials)}`);
    const stickRect = () => page.evaluate(() => { const r = document.querySelector(".ml-pad-stick").getBoundingClientRect(); return { r: r.right, b: r.bottom }; });
    const s0 = await stickRect();
    // a tap at the far right of the up/down track = +half radius = 30 px up
    const moved = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.ml-sub[data-sub="controls"] .ml-amb-slider')].find((d) => d.querySelector(".ml-amb-slider-label")?.textContent.trim() === "Stick up / down");
      const track = row.querySelector(".ml-slider");
      const r = track.getBoundingClientRect();
      const at = (type, x) => track.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: r.top + r.height / 2 }));
      at("pointerdown", r.right - 1);
      at("pointerup", r.right - 1);
      return { val: row.querySelector(".ml-amb-slider-val")?.textContent.trim(), stored: localStorage.getItem("ml-stick-nudge") };
    });
    await page.waitForTimeout(150);
    const s1 = await stickRect();
    moved.val === "30 px up" && near(s1.b, s0.b - 30) && near(s1.r, s0.r)
      ? ok(`dragging "Stick up / down" to its end lifts the stick 30 px in the view (${s0.b} -> ${s1.b}); stored ${moved.stored}`)
      : fail(`stick dial: ${JSON.stringify({ moved, s0, s1 })}`);
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.ml-sub[data-sub="controls"] .ml-amb-slider')].find((d) => d.querySelector(".ml-amb-slider-label")?.textContent.trim() === "Stick up / down");
      row.querySelector(".ml-slider-def").click();
    });
    await page.waitForTimeout(150);
    const s2 = await stickRect();
    near(s2.b, s0.b) ? ok("…and its default button puts the stick back") : fail(`after default: b ${s2.b} vs ${s0.b}`);
    // A DIAL'S RANGE IS THE EFFECTIVE RANGE (maintainer 2026-09-19, at "14 px
    // right" with nothing happening): right-handed in portrait the stick's
    // corner is on the right, so "Stick left / right" ends at 10 px right (the
    // inset, margin 0) and 30 px left (the half radius); "Stick up / down"
    // ends at 10 px down and 30 px up. Every end moves the stick.
    const endOf = (label, side) => page.evaluate(([l, sd]) => {
      const row = [...document.querySelectorAll('.ml-sub[data-sub="controls"] .ml-amb-slider')].find((d) => d.querySelector(".ml-amb-slider-label")?.textContent.trim() === l);
      const track = row.querySelector(".ml-slider");
      const r = track.getBoundingClientRect();
      const x = sd === "right" ? r.right - 1 : r.left + 1;
      const at = (type) => track.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: r.top + r.height / 2 }));
      at("pointerdown"); at("pointerup");
      return row.querySelector(".ml-amb-slider-val")?.textContent.trim();
    }, [label, side]);
    const xr = await endOf("Stick left / right", "right");
    await page.waitForTimeout(120);
    const sxr = await stickRect();
    xr === "10 px right" && near(sxr.r, 393)
      ? ok("the left/right dial ends at 10 px right — the inset — with the stick's margin at 0")
      : fail(`left/right far right: "${xr}", stick r=${sxr.r}`);
    const xl = await endOf("Stick left / right", "left");
    await page.waitForTimeout(120);
    const sxl = await stickRect();
    xl === "30 px left" && near(sxl.r, s0.r - 30)
      ? ok("…and at 30 px left — the half radius — with the stick 30 px in")
      : fail(`left/right far left: "${xl}", stick r=${sxl.r} (was ${s0.r})`);
    const yd = await endOf("Stick up / down", "left");
    await page.waitForTimeout(120);
    const syd = await stickRect();
    yd === "10 px down" && near(syd.b, s0.b + 10)
      ? ok("the up/down dial ends at 10 px down — the inset — with the stick on the rail")
      : fail(`up/down far left: "${yd}", stick b=${syd.b} (was ${s0.b})`);
    await page.evaluate(() => [...document.querySelectorAll('.ml-sub[data-sub="controls"] .ml-slider-def')].forEach((b) => b.click()));
    await page.waitForTimeout(150);
    const s3 = await stickRect();
    near(s3.r, s0.r) && near(s3.b, s0.b) ? ok("both default buttons put the stick back in its corner") : fail(`after defaults: ${JSON.stringify(s3)} vs ${JSON.stringify(s0)}`);
    await page.evaluate(() => [...document.querySelectorAll(".ml-handbtn .ml-plate-btn")].find((b) => b.textContent.trim() === "Left-handed").click());
    await page.waitForTimeout(400);
    const hand1 = await page.evaluate(() => ({ hand: window.__ml.hand(), lh: document.documentElement.classList.contains("ml-lh"), on: [...document.querySelectorAll(".ml-handbtn .ml-plate-btn")].find((b) => b.classList.contains("on"))?.textContent.trim() }));
    hand1.hand === "left" && hand1.lh && hand1.on === "Left-handed" ? ok("Left-handed flips the hand, the root class and the lit button") : fail(`after Left-handed: ${JSON.stringify(hand1)}`);
    // …and the left/right dial's range mirrors with the corner: its far right
    // is now the half radius (30 px right), its far left the inset (10 px left)
    const mirrored = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.ml-sub[data-sub="controls"] .ml-amb-slider')].find((d) => d.querySelector(".ml-amb-slider-label")?.textContent.trim() === "Stick left / right");
      const track = row.querySelector(".ml-slider"), r = track.getBoundingClientRect();
      const val = () => row.querySelector(".ml-amb-slider-val")?.textContent.trim();
      const at = (type, x) => track.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: r.top + r.height / 2 }));
      at("pointerdown", r.right - 1); at("pointerup", r.right - 1);
      const right = val();
      at("pointerdown", r.left + 1); at("pointerup", r.left + 1);
      const left = val();
      row.querySelector(".ml-slider-def").click();
      return { right, left, after: val() };
    });
    mirrored.right === "30 px right" && mirrored.left === "10 px left" && mirrored.after === "0 px"
      ? ok("left-handed, the left/right dial's range mirrors: 30 px right, 10 px left, default 0")
      : fail(`left-handed dial range: ${JSON.stringify(mirrored)}`);
    await page.evaluate(() => [...document.querySelectorAll(".ml-handbtn .ml-plate-btn")].find((b) => b.textContent.trim() === "Right-handed").click());
    await page.waitForTimeout(400);

    // -- leaving Settings: the strip folds with content, the rail returns --
    await click(page, '.ml-tab[data-tab="backpack"]');
    const mid = await page.evaluate(() => ({ rowShown: !!document.querySelector(".ml-subtabs.show"), open: !!document.querySelector(".ml-subrow.open") }));
    mid.rowShown && !mid.open ? ok("on close the leaving chip row stays shown, so the fold has content (no one-frame collapse)") : fail(`on close: ${JSON.stringify(mid)}`);
    await settle(page);
    const back = await geom(page);
    !back.open && back.subH === 0 && back.hudH === base.threeRows && near(back.hud.t, base.hud.t) && near(back.pages.t, base.pages.t) && near(back.pages.h, base.pages.h)
      ? ok(`back on the backpack the rail is the three-row law again (${back.hudH}px) and the page is where it was`)
      : fail(`after leaving: ${JSON.stringify({ open: back.open, subH: back.subH, hudH: back.hudH, hud: back.hud, pages: back.pages })}`);

    // ---- 2. THE ADMIN: Dev appears, last, and is the old page ----------
    await grantAdmin(page);
    const yes = await page.evaluate(() => window.__mlHud.admin(true));
    await page.waitForTimeout(200);
    await click(page, '.ml-tab[data-tab="settings"]');
    await settle(page);
    const a = await geom(page);
    yes === true && a.chips.map((c) => c.id).join(",") === "general,sound,controls,dev" && a.n === "4"
      ? ok("the server's yes reveals Dev, last of four, and the bar is stamped data-n=4")
      : fail(`admin: yes=${yes} chips=${JSON.stringify(a.chips)} n=${a.n}`);
    a.chips.every((c) => c.label !== "none" && !c.clipped)
      ? ok(`four chips still carry whole labels (${a.chips.map((c) => c.w.toFixed(0)).join("/")}px)`)
      : fail(`four-up labels: ${JSON.stringify(a.chips)}`);
    near(a.subH, s.subH) && near(a.pages.t, base.pages.t)
      ? ok("the four-up strip is the same height; the page stays put")
      : fail(`four-up strip ${a.subH} (was ${s.subH}), pages ${JSON.stringify(a.pages)}`);
    await page.evaluate(() => window.__mlHud.sub("settings", "dev"));
    await page.waitForTimeout(250);
    const dev = await page.evaluate(() => {
      const pane = document.querySelector('.ml-sub[data-sub="dev"]');
      const btns = [...pane.querySelectorAll(".ml-btnrow .ml-plate-btn")];
      const hook = pane.querySelector(".ml-hudbtn");
      const slots = document.querySelector('.ml-page[data-page="backpack"] .ml-slots');
      return { sub: window.__mlHud.sub("settings"), btns: btns.length, painted: btns.filter((b) => b.getBoundingClientRect().width > 0).length,
        hook: !!hook && hook.getBoundingClientRect().width > 0, dials: pane.querySelectorAll(".ml-dials .ml-amb-slider").length, amb: !!pane.querySelector(".ml-amb-title"),
        gridL: btns[0]?.getBoundingClientRect().left, gridR: btns[2]?.getBoundingClientRect().right, paneL: pane.getBoundingClientRect().left, paneR: pane.getBoundingClientRect().right,
        audioInDev: btns.some((b) => /^(sound|music)\b/.test(b.textContent.trim())) };
    });
    dev.sub === "dev" && dev.btns >= 10 && dev.painted === dev.btns && dev.hook && dev.dials >= 8 && dev.amb && dev.audioInDev
      ? ok(`Dev is the old page: ${dev.btns} switches (time-of-day hook painted, the composer's mute switches among them), ${dev.dials} dials, the ambient section`)
      : fail(`Dev: ${JSON.stringify(dev)}`);
    near(dev.gridL, dev.paneL, 1.5) && near(dev.gridR, dev.paneR, 1.5)
      ? ok("the dev grid spans its column edge to edge")
      : fail(`dev grid ${dev.gridL}..${dev.gridR} in a pane ${dev.paneL}..${dev.paneR}`);
    // the choice is remembered across a reload — and honoured only for the admin
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
    await page.evaluate(() => window.__mlSelect.commit());
    await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
    await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 90000 });
    await page.waitForTimeout(600);
    await click(page, '.ml-tab[data-tab="settings"]');
    await settle(page);
    const remembered = await page.evaluate(() => window.__mlHud.sub("settings"));
    remembered === "dev" ? ok("the admin's Dev survives a reload") : fail(`after reload the sub-tab is ${remembered}`);
    await ctx.close();
  }
  // a player whose browser remembers "dev" (a token that expired) lands on General
  {
    const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem("ml-subtab:settings", "dev"));
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
    await page.evaluate(() => window.__mlSelect.commit());
    await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
    await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 90000 });
    await page.waitForTimeout(600);
    await click(page, '.ml-tab[data-tab="settings"]');
    await settle(page);
    const g = await geom(page);
    g.sub === "general" && !g.chips.some((c) => c.id === "dev")
      ? ok("a remembered Dev the server denies falls back to General")
      : fail(`denied dev: sub=${g.sub} chips=${JSON.stringify(g.chips)}`);
    await ctx.close();
  }

  // ---- 3. LANDSCAPE: icons only, at the top of the column ---------------
  {
    const ctx = await browser.newContext({ viewport: { width: 851, height: 393 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const page = await join(ctx, { admin: true });
    await page.waitForTimeout(400);
    const before = await geom(page);
    await click(page, '.ml-tab[data-tab="settings"]');
    await settle(page);
    const l = await geom(page);
    l.open && l.hudH === 0 && l.subH === 0 && near(l.menuW, before.menuW) && near(l.hud.w, before.hud.w)
      ? ok(`landscape: the strip opens with --hud-h 0, --sub-h 0 and the column still ${l.menuW}px wide`)
      : fail(`landscape: open=${l.open} hudH=${l.hudH} subH=${l.subH} menuW ${before.menuW} -> ${l.menuW} hud.w ${before.hud.w} -> ${l.hud.w}`);
    near(l.strip.t, l.body.t) && near(l.pages.t, l.strip.b) && l.strip.r <= l.pages.r + 1 && l.strip.l >= l.body.l - 1
      ? ok("the strip sits at the top of the page column, inside it, and the page starts under it")
      : fail(`strip ${JSON.stringify(l.strip)} body ${JSON.stringify(l.body)} pages ${JSON.stringify(l.pages)}`);
    const tabStrip = l.tabrow;
    (l.strip.r <= tabStrip.l + 1 || l.strip.l >= tabStrip.r - 1)
      ? ok("…and never over the vertical tab strip")
      : fail(`strip ${JSON.stringify(l.strip)} overlaps the tab strip ${JSON.stringify(tabStrip)}`);
    l.chips.length === 4 && l.chips.every((c) => c.label === "none")
      ? ok("landscape chips are icons only (labels display:none)")
      : fail(`landscape chips: ${JSON.stringify(l.chips)}`);
    const lw = l.chips.map((c) => c.w);
    Math.max(...lw) - Math.min(...lw) <= 1.5 ? ok(`landscape chips equal width (${lw[0].toFixed(1)}px)`) : fail(`landscape chip widths ${lw.join("/")}`);
    near(l.game.w, before.game.w) && near(l.game.h, before.game.h)
      ? ok("the game view is untouched by the strip in landscape")
      : fail(`game ${JSON.stringify(before.game)} -> ${JSON.stringify(l.game)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
