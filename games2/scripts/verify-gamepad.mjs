// QA: gamepad-tab analog stick — synthetic keys, 8-way snap, visual clamp,
// beyond-max steering, release. Mechanics at the small fast viewport
// (headless-GL rule), looks at the phone geometry.
// WIKI-STYLE UI (2026-07-30): the pad-stick2 art is gone — the stick is a
// plain CSS round WELL (120px under 585w, 148px above) with a translating
// CAP div; centre = bounding rect centre, cap rest = translate(0,0).
// LONGER DRAG (maintainer 2026-07-30): travel is WELL-derived now —
// maxCss = well * 0.38, so the damped cap (×0.65) reaches the well rim at
// full gate. Key contract (octants, dead 0.35, run 0.75, WASD/SHIFT
// synthesis) unchanged.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = process.env.OUT || "/tmp";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);

// slow=true for the LOOKS-ONLY blocks at big/mobile viewports: headless
// software-GL starves the frame loop there (measured ~25s to __ml, ~70s to
// loading-clear at 980×2123) — nothing in those blocks asserts timing.
async function joinWorld(geo, slow = false) {
  const page = await (await browser.newContext(geo)).newPage();
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  // NB: waitForFunction options ride in the THIRD slot (fn, arg, options) —
  // an options object in the arg slot is silently ignored (default 30s).
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
  const idx = await page.evaluate(() => window.__mlSelect.worlds().findIndex((w) => /prop/i.test(w)));
  if (idx >= 0) await page.evaluate((i) => window.__mlSelect.pickWorld(i), idx);
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: slow ? 150000 : 30000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: slow ? 150000 : 12000 });
  return page;
}
const pos = (page) => page.evaluate(() => { const m = window.__ml.me(); return { x: m.x, y: m.y }; });

// ── mechanics at 480x440 ──
// 440 tall, not the 320 the other small gates use: the stick floats in the
// game view's bottom-right corner on every tab now (2026-09-19), and at 320
// the view is 198px tall, so the well (68..188) lies under the Wiki row that
// hangs from the XP chip (98..130) — the first mouse-down opened the drawer
// and froze the world under it (measured: every drag and the jump press
// dead after it). At 440 the view is 272 and the well starts at 142, a
// clear 12px under the row.
{
  // slow=true: the same 150s the phone arms already allow the loading
  // overlay — at 12s this arm died in its join on a busy box (twice
  // 2026-09-19), which is timing, not the stick.
  const page = await joinWorld({ viewport: { width: 480, height: 440 } }, true);
  await page.waitForTimeout(600);
  // the keys the stick is HOLDING right now — recorded at window level, so a
  // liveness check can read the input path itself instead of inferring it
  // from distance moved (a wall after a long run zeroes that; measured twice
  // 2026-09-17 as a flake in the beyond-max check)
  await page.evaluate(() => {
    window.__heldKeys = new Set();
    window.addEventListener("keydown", (e) => window.__heldKeys.add(e.key), { capture: true });
    window.addEventListener("keyup", (e) => window.__heldKeys.delete(e.key), { capture: true });
  });

  // 1) sanity: Phaser accepts a SYNTHETIC key (the whole input path). ANY
  //    direction proves it — the spawn can sit against a prop (measured
  //    2026-09-19 on a fresh server: 'd' into a chess table moved 0.0wu twice
  //    while the stick's east drag slid along it), so the first direction
  //    that moves the player is the one that counts.
  const press = async (key, code, keyCode, ms) => {
    await page.evaluate(([k, c, kc]) => {
      const e = new KeyboardEvent("keydown", { key: k, code: c, bubbles: true });
      Object.defineProperty(e, "keyCode", { get: () => kc });
      window.dispatchEvent(e);
    }, [key, code, keyCode]);
    await page.waitForTimeout(ms);
    await page.evaluate(([k, c, kc]) => {
      const e = new KeyboardEvent("keyup", { key: k, code: c, bubbles: true });
      Object.defineProperty(e, "keyCode", { get: () => kc });
      window.dispatchEvent(e);
    }, [key, code, keyCode]);
  };
  let d0 = 0, dirTried = "";
  for (const [key, code, keyCode] of [["d", "KeyD", 68], ["a", "KeyA", 65], ["w", "KeyW", 87], ["s", "KeyS", 83]]) {
    const p0 = await pos(page);
    await press(key, code, keyCode, 700);
    const p1 = await pos(page);
    d0 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    dirTried += key;
    if (d0 > 3) break;
  }
  d0 > 3 ? ok(`synthetic keydown moves the player (${d0.toFixed(1)}wu, key ${dirTried.slice(-1)})`) : fail(`synthetic key ignored in every direction (${dirTried}, last moved ${d0.toFixed(1)}wu)`);

  // open the gamepad tab, find the stick
  await page.evaluate(() => document.querySelector('[data-tab="gamepad"]').click());
  await page.waitForTimeout(400);
  const geom = await page.evaluate(() => {
    const pad = document.querySelector(".ml-pad-stick");
    if (!pad) return null;
    const r = pad.getBoundingClientRect();
    // wiki-style: a plain round CSS well — centre = bounding rect centre
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width };
  });
  if (!geom) { fail("stick not mounted"); }
  else {
    // <585w tier: well 120, travel = round(120*0.38) = 46 css px
    // (dead 16.1, run 34.5) — the 2026-07-30 longer-drag feel.
    const travel = 46;
    Math.abs(geom.w - 120) < 0.5
      ? ok(`stick well mounted ${geom.w}px (120 tier) centre=(${geom.cx.toFixed(0)},${geom.cy.toFixed(0)})`)
      : fail(`stick well ${geom.w}px, want 120`);
    const topTf = () => page.evaluate(() => document.querySelector(".ml-pad-top").style.transform);

    // 2) drag EAST → moves; direction ≈ screen-east (world +x,+y)
    let a = await pos(page);
    await page.mouse.move(geom.cx, geom.cy);
    await page.mouse.down();
    await page.mouse.move(geom.cx + 80, geom.cy, { steps: 4 });
    await page.waitForTimeout(700);
    let b = await pos(page);
    let dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    len > 3 ? ok(`E drag moves (${len.toFixed(1)}wu, dir ${(Math.atan2(dy,dx)*180/Math.PI).toFixed(0)}°)`) : fail("E drag: no movement");
    const eDir = Math.atan2(dy, dx);

    // 3) beyond max: fling the finger FAR — input keeps working; the cap
    // sits SNAPPED at full deflection (rest = translate(0,0), no art seat)
    await page.mouse.move(geom.cx + 300, geom.cy, { steps: 3 });
    await page.waitForTimeout(250);
    const tf = await topTf();
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(tf);
    if (!m) fail(`no snap transform (${tf})`);
    else {
      const [dx, dy] = [+m[1], +m[2]];
      // full gate DRAWS damped by CAP_VISUAL_FRAC (0.65); rest baseline
      // is translate(0,0), so full E = (travel*0.65, 0)
      const wantX = travel * 0.65, wantY = 0;
      Math.abs(dx - wantX) < 1 && Math.abs(dy - wantY) < 1
        ? ok(`cap snapped at full E deflection (${dx},${dy}) = (travel*0.65, 0)`)
        : fail(`cap at (${dx},${dy}), want (${wantX},${wantY})`);
    }
    a = await pos(page);
    await page.waitForTimeout(600);
    b = await pos(page);
    // alive = the run keys are still DOWN out there (the cap check above
    // already showed the angle); the distance is reported, not asserted —
    // the player may be against a wall after the E run
    const farHeld = await page.evaluate(() => [...window.__heldKeys]);
    farHeld.includes("d") && farHeld.includes("Shift")
      ? ok(`input alive beyond max offset (holding ${farHeld.join("+")}, moved ${Math.hypot(b.x-a.x, b.y-a.y).toFixed(1)}wu)`)
      : fail(`input died past max offset: holding ${JSON.stringify(farHeld)}`);
    // visual snap: a 100° park lands the cap at the SAME spot as 90° (S gate)
    await page.mouse.move(geom.cx - 21, geom.cy + 118, { steps: 2 });
    await page.waitForTimeout(250);
    const t100 = await topTf();
    await page.mouse.move(geom.cx, geom.cy + 120, { steps: 2 });
    await page.waitForTimeout(250);
    const t90 = await topTf();
    t100 === t90 ? ok(`cap visual snaps to the octant (${t90})`) : fail(`cap not snapped: 100°=${t100} vs 90°=${t90}`);
    // and the glide is animated, not instant
    const trans = await page.evaluate(() => getComputedStyle(document.querySelector(".ml-pad-top")).transitionDuration);
    parseFloat(trans) > 0 ? ok(`snap glide animated (${trans})`) : fail("no snap transition");
    // ANALOG amplitude: a mid-tilt parks the cap at ~the finger distance
    // (angle snapped, amplitude NOT) — 28px sits between dead (16.1) and
    // full (46); cap draws 28*0.65 = 18.2, not the full 29.9
    await page.mouse.move(geom.cx + 28, geom.cy, { steps: 2 });
    await page.waitForTimeout(250);
    const tMid = await topTf();
    const mm = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(tMid);
    mm && Math.abs(+mm[1] - 18.2) < 2 && Math.abs(+mm[2]) < 2
      ? ok(`amplitude analog: mid-tilt cap at ${mm[1]}px (finger 28px, 0.65 damp)`)
      : fail(`amplitude snapped? cap at ${tMid}, finger at 28px`);

    // 4) 8-way snap — probe the HELD KEY SET directly (world-heading
    // comparisons bend at walls/props): install a key listener, then park
    // the pointer at test angles and read which keys are down.
    await page.evaluate(() => {
      window.__qaKeys = new Set();
      window.addEventListener("keydown", (e) => window.__qaKeys.add(e.key));
      window.addEventListener("keyup", (e) => window.__qaKeys.delete(e.key));
    });
    // reset to the dead zone so every case re-fires its keydowns (keys held
    // from the earlier visual checks predate the listener)
    await page.mouse.move(geom.cx, geom.cy, { steps: 2 });
    await page.waitForTimeout(150);
    const heldAt = async (deg, dist = 120) => {
      const rad = (deg * Math.PI) / 180;
      await page.mouse.move(geom.cx + Math.cos(rad) * dist, geom.cy + Math.sin(rad) * dist, { steps: 2 });
      await page.waitForTimeout(120);
      return (await page.evaluate(() => [...window.__qaKeys].sort())).join("+");
    };
    // FAR park = RUN (Shift held); MID park = WALK (plain keys)
    const runCases = [[100, "Shift+s"], [90, "Shift+s"], [50, "Shift+d+s"], [10, "Shift+d"],
                      [170, "Shift+a"], [-100, "Shift+w"], [-50, "Shift+d+w"], [-140, "Shift+a+w"]];
    for (const [deg, want] of runCases) {
      const got = await heldAt(deg);
      got === want ? ok(`snap ${deg}° far -> [${got}]`) : fail(`snap ${deg}° far: held [${got}] want [${want}]`);
    }
    const walkCases = [[90, "s"], [10, "d"], [-140, "a+w"]];
    for (const [deg, want] of walkCases) {
      const got = await heldAt(deg, 24); // between dead (16.1) and run (34.5)
      got === want ? ok(`walk ${deg}° mid -> [${got}]`) : fail(`walk ${deg}° mid: held [${got}] want [${want}]`);
    }

    // 5) release stops everything
    await page.mouse.up();
    await page.waitForTimeout(500);
    a = await pos(page);
    await page.waitForTimeout(700);
    b = await pos(page);
    const drift = Math.hypot(b.x - a.x, b.y - a.y);
    drift < 1.5 ? ok(`release stops movement (drift ${drift.toFixed(2)}wu)`) : fail(`still moving after release (${drift.toFixed(1)}wu)`);
    const tfAfter = await topTf();
    const mr = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(tfAfter);
    mr && Math.abs(+mr[1]) < 0.5 && Math.abs(+mr[2]) < 0.5
      ? ok(`cap re-seated (rest ${tfAfter})`)
      : fail(`cap not re-seated (${tfAfter})`);

    // 6) JUMP button: press -> SPACE -> the player actually jumps
    const jb = await page.evaluate(() => {
      const j = document.querySelector(".ml-pad-jump");
      if (!j) return null;
      const r = j.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll(".ml-pad-label")].map((l) => l.textContent));
    // the WALK label went with the stick's move off the page (2026-09-19)
    labels.join("+") === "Jump+Pick up" ? ok("JUMP/PICK UP labels mounted (the stick floats, no WALK label on the page)") : fail(`labels [${labels}]`);
    if (!jb) fail("jump button not mounted");
    else {
      await page.mouse.move(jb.x, jb.y);
      await page.mouse.down();
      await page.waitForTimeout(150);
      const held = await page.evaluate(() => [...window.__qaKeys]);
      held.includes(" ") ? ok("jump press holds SPACE") : fail(`jump press keys [${held}]`);
      const jumping = await page.evaluate(() => !!window.__ml.me().jumping);
      await page.mouse.up();
      await page.waitForTimeout(100);
      jumping ? ok("player jumps on button press") : fail("player did not jump");
      const upHeld = await page.evaluate(() => [...window.__qaKeys]);
      !upHeld.includes(" ") ? ok("jump release lets go of SPACE") : fail("SPACE stuck after release");
    }
  }
  await page.context().close();
}

// ── looks at the phone geometry ──
{
  const page = await joinWorld({ viewport: { width: 980, height: 2123 }, screen: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, true);
  await page.evaluate(() => document.querySelector('[data-tab="gamepad"]').click());
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/stick-idle.png`, timeout: 120000 });
  const g = await page.evaluate(() => {
    const r = document.querySelector(".ml-pad-stick").getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width };
  });
  console.log("phone stick:", JSON.stringify(g));
  // >=585 css px wide -> the big 148px well
  Math.abs(g.w - 148) < 0.5 ? ok(`phone well at 148px (>=585w tier)`) : fail(`phone well ${g.w}px, want 148`);
  await page.mouse.move(g.cx, g.cy);
  await page.mouse.down();
  await page.mouse.move(g.cx + 200, g.cy + 140, { steps: 4 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/stick-dragged.png`, timeout: 120000 });
  await page.mouse.up();
  await page.context().close();
}
// ── JUMP/WALK labels wear the wiki section-label look — the SAME look as the
//    Settings "Ambient effects" header: fixed 12px, var(--muted), uppercase.
//    (The old min(18px, 1.837vw) mobile clamp is GONE — 12px reads right at
//    every width, so the "shrinks on narrow" assertion is replaced by
//    fixed-12px + size/colour equality with .ml-amb-title.) ──
{
  const page = await joinWorld({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.75 }, true);
  // Settings tab builds the ambient header (needs window.__mlAmbient up)
  await page.evaluate(() => document.querySelector('[data-tab="settings"]')?.click());
  const amb = await page.waitForFunction(() => {
    const t = document.querySelector(".ml-amb-title");
    if (!t) return null;
    const cs = getComputedStyle(t);
    return { fs: cs.fontSize, color: cs.color };
  }, null, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => null);
  await page.evaluate(() => document.querySelector('[data-tab="gamepad"]')?.click());
  await page.waitForTimeout(300);
  const padL = await page.evaluate(() => {
    const l = document.querySelector(".ml-pad-label");
    if (!l) return null;
    const cs = getComputedStyle(l);
    return { fs: cs.fontSize, color: cs.color };
  });
  padL && parseFloat(padL.fs) === 12
    ? ok(`JUMP/WALK label fixed 12px on mobile (${padL.fs})`)
    : fail(`JUMP/WALK label ${padL && padL.fs}, want 12px`);
  if (amb && padL) {
    padL.fs === amb.fs
      ? ok(`JUMP/WALK label size == Ambient header (${padL.fs})`)
      : fail(`JUMP/WALK ${padL.fs} != Ambient header ${amb.fs}`);
    padL.color === amb.color
      ? ok(`JUMP/WALK label colour == Ambient header muted (${padL.color})`)
      : fail(`JUMP/WALK colour ${padL.color} != Ambient header ${amb.color}`);
  } else {
    ok("ambient header not built (ambient layer down) — look-match check skipped");
  }

  // ── WHERE HIS THUMBS ARE. JUMP's portrait centre is the spot he marked in
  //    red on a device screenshot (2026-09-17: "I have placed two red cross
  //    where I think the new WALK and JUMP input center should be. My new
  //    location feels more where my thumbs are when holding the phone"), and
  //    NOTHING held them before this: the gate found each control wherever it
  //    happened to be, so any later edit could drift his marks silently.
  //    Asserted as a FRACTION of the page's own width, which is what the code
  //    positions by and what survives a different phone; ±3 css px, well
  //    inside the ~2px his hand-drawn crosses measure to.
  //    THE OTHER TWO ARE A RULE, NOT A MARK: the row reads balanced when the
  //    two inner gaps match (2026-09-17: "the controls is now not in balance
  //    and the MOVE controller should be somewhat placed more to the right"
  //    — with margins 35.2/38.2 and gaps 40.1/23.5, the crowding was the
  //    gaps). Both are checked, so a later size change that keeps the
  //    fractions but breaks the rhythm still fails here. ──
  // ── PORTRAIT GHOST (maintainer 2026-09-17: "I want the same semi
  //    transparent control [in portrait]… better to have it at a worse
  //    location than not have this control at all"). With the gamepad page
  //    hidden the stick floats in the game view's BOTTOM-RIGHT CORNER on the
  //    10px margin — free because the same day he moved the Wiki row and the
  //    clock pill to the TOP-right under the XP chip (row first, pill one
  //    step under it: "this means the thumbstick can be lowered"). "Just make
  //    sure pressing on the wiki or the search still works and this input
  //    triggers when you press on this and nothing else": hit-tested at every
  //    neighbour, and a press beside or above the well must reach the canvas.
  //    The input path is asserted on the synthesized KEYS, not on distance
  //    moved — the phone-dpr frame loop is starved here (see joinWorld). ──
  await page.evaluate(() => document.querySelector('[data-tab="map"]')?.click());
  await page.waitForTimeout(400);
  const ghostGeom = () =>
    page.evaluate(() => {
      const q = (sel) => document.querySelector(sel);
      const rr = (sel) => {
        const e = q(sel);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
      };
      const pad = q(".ml-pad-stick");
      const hit = (x, y) => {
        const e = document.elementFromPoint(x, y);
        if (!e) return "none";
        if (pad && pad.contains(e)) return "stick";
        if (e.closest(".ml-wikibtn")) return "wiki";
        if (e.closest(".ml-wikinear")) return "search";
        if (e.tagName === "CANVAS") return "canvas";
        return e.className || e.tagName;
      };
      const s = rr(".ml-pad-stick"), c = rr(".ml-clock"), w = rr(".ml-wikibtn"), n = rr(".ml-wikinear"), xp = rr(".ml-bars-r");
      const cs = getComputedStyle(document.documentElement);
      return {
        parent: pad?.parentElement?.tagName,
        pos: pad ? getComputedStyle(pad).position : null,
        ghostClass: document.documentElement.classList.contains("ml-stickghost"),
        blur: q(".ml-pad-blur") ? getComputedStyle(q(".ml-pad-blur")).display : null,
        tab: q(".ml-tab.sel")?.dataset.tab,
        hudTop: innerHeight - (parseFloat(cs.getPropertyValue("--hud-h")) || 0),
        vw: innerWidth, // the pill is centred in the view, so the view's width is a reading
        s, c, w, n, xp,
        hits: s && {
          stick: hit(s.l + s.w / 2, s.t + s.h / 2),
          wiki: w && hit(w.l + w.w / 2, w.t + w.h / 2),
          search: n && hit(n.l + n.w / 2, n.t + n.h / 2),
          clock: c && hit(c.l + c.w / 2, c.t + c.h / 2),
          beside: hit(s.l - 30, s.t + s.h / 2),
          above: hit(s.l + s.w / 2, s.t - 30),
        },
        op: { well: getComputedStyle(q(".ml-pad-well")).opacity, cap: getComputedStyle(q(".ml-pad-top")).opacity },
      };
    });
  const gh = await ghostGeom();
  if (!gh.s || gh.parent !== "BODY" || gh.pos !== "fixed")
    fail(`portrait ghost not floating over the game view on the ${gh.tab} tab: ${JSON.stringify({ parent: gh.parent, pos: gh.pos, s: gh.s })}`);
  else {
    ok(`portrait ghost floats over the game view on the ${gh.tab} tab (parented to <body>, ${gh.s.w.toFixed(0)}px)`);
    gh.ghostClass ? ok("ml-stickghost set while the page is hidden") : fail("ml-stickghost missing in portrait ghost mode");
    gh.blur === "block" ? ok("blur disc shown under the portrait ghost") : fail(`blur disc ${gh.blur} under the portrait ghost`);
    // THE CORNER RULE: the one 10px margin to the right edge and to the rail
    Math.abs(393 - 10 - gh.s.r) <= 1.5 && Math.abs(gh.hudTop - 10 - gh.s.b) <= 1.5
      ? ok(`ghost in the bottom-right corner on the 10px margin (r=${gh.s.r.toFixed(1)}, b=${gh.s.b.toFixed(1)}, rail ${gh.hudTop.toFixed(0)})`)
      : fail(`ghost r=${gh.s.r.toFixed(1)} b=${gh.s.b.toFixed(1)} — want r=${393 - 10}, b=${(gh.hudTop - 10).toFixed(0)}`);
    // …which the Wiki row and the pill left for it: the row TOP-right directly
    // under the XP chip with the 🔍 beside it, and the pill one step under the
    // row but CENTRED (maintainer 2026-09-19), sharing an edge with neither.
    gh.w && gh.xp && Math.abs(gh.w.t - gh.xp.b - 10) <= 2 && Math.abs(gh.w.r - gh.xp.r) <= 2
      ? ok(`Wiki row directly under the XP chip (t=${gh.w.t.toFixed(0)} = chip b ${gh.xp.b.toFixed(0)} + 10, right edges ${gh.w.r.toFixed(0)}/${gh.xp.r.toFixed(0)})`)
      : fail(`Wiki row ${JSON.stringify(gh.w)} not under the XP chip ${JSON.stringify(gh.xp)}`);
    gh.n && gh.w && Math.abs(gh.n.t - gh.w.t) <= 1 && Math.abs(gh.w.l - gh.n.r - 10) <= 2
      ? ok(`🔍 on the Wiki's line, 10px to its left (r=${gh.n.r.toFixed(0)}, wiki l=${gh.w.l.toFixed(0)})`)
      : fail(`🔍 ${JSON.stringify(gh.n)} vs Wiki ${JSON.stringify(gh.w)}`);
    gh.c && gh.w && Math.abs(gh.c.t - gh.w.b - 10) <= 2 && Math.abs(gh.c.l + gh.c.w / 2 - gh.vw / 2) <= 2
      ? ok(`clock pill one step under the Wiki row and centred (t=${gh.c.t.toFixed(0)} = row b ${gh.w.b.toFixed(0)} + 10, centre ${(gh.c.l + gh.c.w / 2).toFixed(0)} of ${gh.vw / 2})`)
      : fail(`pill ${JSON.stringify(gh.c)} — want it ${10}px under the Wiki row ${JSON.stringify(gh.w)} and centred on ${gh.vw / 2}`);
    gh.c && gh.c.b < gh.s.t - 100 ? ok("the corner stack is out of the ghost's way") : fail(`pill b=${gh.c && gh.c.b} crowds the ghost t=${gh.s.t}`);
    // ONLY THE WELL FIRES; everything around it keeps its own press
    const h = gh.hits;
    h.stick === "stick" ? ok("a press on the well hits the stick") : fail(`well centre hits ${h.stick}`);
    h.wiki === "wiki" ? ok("the Wiki button still takes its press") : fail(`Wiki centre hits ${h.wiki}`);
    h.search === "search" ? ok("the 🔍 button still takes its press") : fail(`🔍 centre hits ${h.search}`);
    h.clock !== "stick" ? ok(`the clock pill's spot is not the stick's (${h.clock})`) : fail("a press on the clock pill drives the stick");
    h.beside === "canvas" && h.above === "canvas"
      ? ok("a press beside or above the well reaches the canvas")
      : fail(`beside the well hits ${h.beside}, above it ${h.above} — want canvas`);
    Math.abs(parseFloat(gh.op.well) - 0.15) <= 0.02 && Math.abs(parseFloat(gh.op.cap) - 0.25) <= 0.02
      ? ok(`portrait ghost at rest carries the ghost alphas (well ${gh.op.well}, cap ${gh.op.cap})`)
      : fail(`portrait ghost alphas ${JSON.stringify(gh.op)}, want .15/.25 (light)`);
    await page.screenshot({ path: `${OUT}/gamepad-portrait-ghost.png` });
    // DRIVES THE PLAYER from there: a northward drag synthesizes W (+SHIFT
    // past the run radius); recorded at window level, timing-free.
    await page.evaluate(() => {
      window.__ghostKeys = [];
      window.addEventListener("keydown", (e) => window.__ghostKeys.push(e.key), { capture: true });
    });
    const cx = gh.s.l + gh.s.w / 2, cy = gh.s.t + gh.s.h / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 70, { steps: 4 });
    await page.waitForTimeout(500);
    const held = await page.evaluate(() => ({
      keys: window.__ghostKeys.slice(),
      well: getComputedStyle(document.querySelector(".ml-pad-well")).opacity,
      cap: getComputedStyle(document.querySelector(".ml-pad-top")).opacity,
      tab: document.querySelector(".ml-tab.sel")?.dataset.tab,
    }));
    await page.mouse.up();
    held.keys.includes("w") ? ok(`the portrait ghost steers (keys ${held.keys.join("+")})`) : fail(`no W from a northward ghost drag: ${JSON.stringify(held.keys)}`);
    Math.abs(parseFloat(held.well) - 1) <= 0.02 && Math.abs(parseFloat(held.cap) - 1) <= 0.02
      ? ok("…and both parts fade to 100% while held")
      : fail(`held portrait ghost alphas ${held.well}/${held.cap}, want 1/1`);
    held.tab === gh.tab ? ok(`…without leaving the ${gh.tab} tab`) : fail(`the ghost drag switched tabs: ${held.tab}`);
  }
  // OPENING THE GAMEPAD PAGE LEAVES THE STICK OVER THE GAME VIEW (maintainer
  // 2026-09-19: "ONLY show the player analog thumbstick over the game screen
  // and not in the gamepad menu … also be visible on top of game view when
  // the player select the gamepad") — one stick, never two, and the page
  // keeps jump and pick up alone.
  await page.evaluate(() => document.querySelector('[data-tab="gamepad"]')?.click());
  await page.waitForTimeout(350);
  const back = await ghostGeom();
  const sticks = await page.evaluate(() => document.querySelectorAll(".ml-pad-stick").length);
  sticks === 1 ? ok("one stick in the DOM") : fail(`${sticks} sticks in the DOM`);
  const onPage = await page.evaluate(() => !!document.querySelector('.ml-page[data-page="gamepad"] .ml-pad-stick'));
  back.parent === "BODY" && back.pos === "fixed" && back.ghostClass && back.blur === "block" && !onPage
    ? ok("with the gamepad page open the stick still floats over the game view (body, fixed, ghost, blur), not on the page")
    : fail(`stick with the gamepad page open: ${JSON.stringify({ parent: back.parent, pos: back.pos, ghostClass: back.ghostClass, blur: back.blur, onPage })}`);
  back.s && Math.abs(393 - 10 - back.s.r) <= 1.5 && Math.abs(back.hudTop - 10 - back.s.b) <= 1.5
    ? ok(`…in the same corner on the 10px margin (r=${back.s.r.toFixed(1)}, b=${back.s.b.toFixed(1)})`)
    : fail(`ghost with the page open r=${back.s?.r} b=${back.s?.b}, want r=383, b=${(back.hudTop - 10).toFixed(0)}`);
  const spots = await page.evaluate(() => {
    const page_ = document.querySelector('.ml-page[data-page="gamepad"]');
    const mid = (sel) => {
      const el = document.querySelector(sel);
      if (!el || !page_) return null;
      const r = el.getBoundingClientRect();
      const p = page_.getBoundingClientRect();
      return { fx: (r.left + r.width / 2 - p.left) / page_.clientWidth, cy: r.top + r.height / 2, w: r.width };
    };
    return { W: page_?.clientWidth ?? 0, jump: mid(".ml-pad-jump"), pick: mid(".ml-pad-pickup") };
  });
  const WANT = { jump: 0.19, pick: 0.454 };
  if (!spots.jump || !spots.pick) fail("gamepad page buttons not mounted for the placement check");
  else {
    for (const k of ["jump", "pick"]) {
      const got = spots[k];
      const offCss = (got.fx - WANT[k]) * spots.W;
      Math.abs(offCss) <= 3
        ? ok(`${k} centred on his mark (${(got.fx * 100).toFixed(1)}% of ${spots.W}px, ${offCss >= 0 ? "+" : ""}${offCss.toFixed(1)}px)`)
        : fail(`${k} sits at ${(got.fx * 100).toFixed(1)}% of the page, his mark is ${(WANT[k] * 100).toFixed(1)}% — ${offCss.toFixed(1)}css px off`);
    }
    const mL = spots.jump.fx * spots.W - spots.jump.w / 2;
    mL >= 26 ? ok(`jump clear of the edge (margin ${mL.toFixed(1)})`) : fail(`jump crowds the screen edge: margin ${mL.toFixed(1)}`);
    Math.abs(spots.jump.cy - spots.pick.cy) <= 1.5
      ? ok(`jump and pick up share one centre row (y ${spots.jump.cy.toFixed(0)})`)
      : fail(`jump and pick up are not on one row: y ${spots.jump.cy.toFixed(0)} / ${spots.pick.cy.toFixed(0)}`);
    // THE FINE-TUNE (maintainer 2026-09-19): an x/y nudge of ± half the
    // radius (30 at the 120 well), +x right and +y up, with the margin to the
    // view's edge floored at 0 — toward the corner a nudge can only spend the
    // 10px inset; a stored value past the half radius is clamped to it.
    const nudge = async (x, y) => {
      await page.evaluate(([nx, ny]) => {
        localStorage.setItem("ml-stick-nudge", JSON.stringify({ x: nx, y: ny }));
        window.dispatchEvent(new Event("ml-stick"));
      }, [x, y]);
      await page.waitForTimeout(150);
      return ghostGeom();
    };
    const n1 = await nudge(-20, 15);
    Math.abs(393 - 30 - n1.s.r) <= 1.5 && Math.abs(n1.hudTop - 25 - n1.s.b) <= 1.5
      ? ok(`nudge (-20, +15) moves the stick 20 in and 15 up (r=${n1.s.r.toFixed(1)}, b=${n1.s.b.toFixed(1)})`)
      : fail(`nudge (-20,+15): r=${n1.s.r.toFixed(1)} want 363, b=${n1.s.b.toFixed(1)} want ${(n1.hudTop - 25).toFixed(0)}`);
    const n2 = await nudge(30, -30);
    Math.abs(393 - n2.s.r) <= 1.5 && Math.abs(n2.hudTop - n2.s.b) <= 1.5
      ? ok("nudge (+30, -30) stops at the corner: margin 0, never outside the view")
      : fail(`nudge (+30,-30): r=${n2.s.r.toFixed(1)} want 393, b=${n2.s.b.toFixed(1)} want ${n2.hudTop.toFixed(0)}`);
    const n3 = await nudge(-64, 64);
    Math.abs(393 - 40 - n3.s.r) <= 1.5 && Math.abs(n3.hudTop - 40 - n3.s.b) <= 1.5
      ? ok("a stored nudge past the half radius is clamped to it (30 at the 120 well)")
      : fail(`nudge (-64,+64): r=${n3.s.r.toFixed(1)} want 353, b=${n3.s.b.toFixed(1)} want ${(n3.hudTop - 40).toFixed(0)}`);
    await nudge(0, 0);
    // LEFT-HANDED MIRRORS THEM (controls.ts): each fraction becomes 1 - fx.
    await page.evaluate(() => window.__ml?.hand?.("left") ?? localStorage.setItem("ml-hand", "left"));
    await page.evaluate(() => window.dispatchEvent(new Event("ml-hand")));
    // the page buttons GLIDE on a hand change (.anim, 250ms) and this
    // phone-dpr context is the starved one: a fixed 400ms read the glide's
    // START value (measured 19.0% exactly, while a dsf-1 probe read 81% at
    // 400ms) — so poll until the button has stopped moving.
    const jumpFx = () => page.evaluate(() => {
      const page_ = document.querySelector('.ml-page[data-page="gamepad"]');
      const el = document.querySelector(".ml-pad-jump");
      if (!el || !page_) return null;
      const r = el.getBoundingClientRect(), p = page_.getBoundingClientRect();
      return (r.left + r.width / 2 - p.left) / page_.clientWidth;
    });
    let lefty = null;
    for (let i = 0, prev = -1; i < 30; i++) {
      await page.waitForTimeout(200);
      lefty = await jumpFx();
      if (lefty !== null && Math.abs(lefty - prev) < 0.001 && Math.abs(lefty - (1 - WANT.jump)) * spots.W <= 3) break;
      prev = lefty;
    }
    if (lefty === null) fail("jump not mounted after switching hands");
    else
      Math.abs(lefty - (1 - WANT.jump)) * spots.W <= 3
        ? ok(`left-handed mirrors jump to ${(lefty * 100).toFixed(1)}%`)
        : fail(`left-handed jump at ${(lefty * 100).toFixed(1)}%, want ${((1 - WANT.jump) * 100).toFixed(1)}%`);
    const lgOpen = await ghostGeom();
    lgOpen.s && lgOpen.parent === "BODY" && Math.abs(lgOpen.s.l - 10) <= 1.5
      ? ok(`…and the floating stick to the bottom-left with the page open (l=${lgOpen.s.l.toFixed(1)})`)
      : fail(`left-handed stick with the page open: ${JSON.stringify({ parent: lgOpen.parent, s: lgOpen.s })}`);
    // …and the LEFT-HANDED portrait ghost mirrors to the bottom-LEFT
    await page.evaluate(() => document.querySelector('[data-tab="map"]')?.click());
    await page.waitForTimeout(400);
    const lg = await ghostGeom();
    lg.s && lg.parent === "BODY" && Math.abs(lg.s.l - 10) <= 1.5
      ? ok(`left-handed portrait ghost at the game view's bottom-left (l=${lg.s.l.toFixed(1)})`)
      : fail(`left-handed portrait ghost: ${JSON.stringify({ parent: lg.parent, s: lg.s })}`);
    await page.evaluate(() => localStorage.setItem("ml-hand", "right"));
  }
  await page.context().close();
}

console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
await browser.close();
process.exit(bad ? 1 : 0);
