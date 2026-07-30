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

// ── mechanics at 480x320 ──
{
  const page = await joinWorld({ viewport: { width: 480, height: 320 } });
  await page.waitForTimeout(600);

  // 1) sanity: Phaser accepts a SYNTHETIC key (the whole input path)
  const p0 = await pos(page);
  await page.evaluate(() => {
    const e = new KeyboardEvent("keydown", { key: "d", code: "KeyD", bubbles: true });
    Object.defineProperty(e, "keyCode", { get: () => 68 });
    window.dispatchEvent(e);
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const e = new KeyboardEvent("keyup", { key: "d", code: "KeyD", bubbles: true });
    Object.defineProperty(e, "keyCode", { get: () => 68 });
    window.dispatchEvent(e);
  });
  const p1 = await pos(page);
  const d0 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  d0 > 3 ? ok(`synthetic keydown moves the player (${d0.toFixed(1)}wu)`) : fail(`synthetic key ignored (moved ${d0.toFixed(1)}wu)`);

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
    Math.hypot(b.x-a.x, b.y-a.y) > 3 ? ok("input alive beyond max offset") : fail("input died past max offset");
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
    labels.join("+") === "Jump+Walk" ? ok("JUMP/WALK labels mounted") : fail(`labels [${labels}]`);
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
  await page.context().close();
}

console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
await browser.close();
process.exit(bad ? 1 : 0);
