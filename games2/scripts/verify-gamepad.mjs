// QA: gamepad-tab analog stick — synthetic keys, 8-way snap, visual clamp,
// beyond-max steering, release. Mechanics at the small fast viewport
// (headless-GL rule), looks at the phone geometry.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = process.env.OUT || "/tmp";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);

async function joinWorld(geo) {
  const page = await (await browser.newContext(geo)).newPage();
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  const idx = await page.evaluate(() => window.__mlSelect.worlds().findIndex((w) => /prop/i.test(w)));
  if (idx >= 0) await page.evaluate((i) => window.__mlSelect.pickWorld(i), idx);
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 12000 });
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
    const k = Math.round(r.width / 96);
    return { cx: r.left + 46.5 * k, cy: r.top + 60.5 * k, k, w: r.width };
  });
  if (!geom) { fail("stick not mounted"); }
  else {
    ok(`stick mounted k=${geom.k} well=(${geom.cx.toFixed(0)},${geom.cy.toFixed(0)})`);
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
    // sits SNAPPED at full deflection (+ the rest baseline on y)
    await page.mouse.move(geom.cx + 300, geom.cy, { steps: 3 });
    await page.waitForTimeout(250);
    const tf = await topTf();
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(tf);
    if (!m) fail(`no snap transform (${tf})`);
    else {
      const [dx, dy] = [+m[1], +m[2]];
      const wantX = 14 * geom.k, wantY = 10 * geom.k; // MAX_ART east + REST_ART
      Math.abs(dx - wantX) < 1 && Math.abs(dy - wantY) < 1
        ? ok(`cap snapped at full E deflection (${dx},${dy}) = (MAX,REST)·k`)
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
      return (await page.evaluate(() => [...window.__qaKeys].sort())).join("");
    };
    const cases = [[100, "s"], [90, "s"], [50, "ds"], [10, "d"], [170, "a"], [-100, "w"], [-50, "dw"], [-140, "aw"]];
    for (const [deg, want] of cases) {
      const got = await heldAt(deg);
      got === want ? ok(`snap ${deg}° -> [${got}]`) : fail(`snap ${deg}°: held [${got}] want [${want}]`);
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
    const mr = /translate\(0px, ([-\d.]+)px\)/.exec(tfAfter);
    mr && Math.abs(+mr[1] - 10 * geom.k) < 1
      ? ok(`cap re-seated on the socket (rest ${mr[1]}px)`)
      : fail(`cap not re-seated (${tfAfter})`);
  }
  await page.context().close();
}

// ── looks at the phone geometry ──
{
  const page = await joinWorld({ viewport: { width: 980, height: 2123 }, screen: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.evaluate(() => document.querySelector('[data-tab="gamepad"]').click());
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/stick-idle.png` });
  const g = await page.evaluate(() => {
    const r = document.querySelector(".ml-pad-stick").getBoundingClientRect();
    const k = Math.round(r.width / 96);
    return { cx: r.left + 46.5 * k, cy: r.top + 60.5 * k, k };
  });
  console.log("phone stick:", JSON.stringify(g));
  await page.mouse.move(g.cx, g.cy);
  await page.mouse.down();
  await page.mouse.move(g.cx + 200, g.cy + 140, { steps: 4 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/stick-dragged.png` });
  await page.mouse.up();
  await page.context().close();
}
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
await browser.close();
process.exit(bad ? 1 : 0);
