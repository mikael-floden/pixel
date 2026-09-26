// QA: THE VIEW TURN ON THE SPIN BAR (docs/view-rotation.md), on real taps at his
// geometry (393x851 @2.75, touch):
//   1. two quick right taps are ONE journey of two quarters, with a turn overlay
//      (live or held) over the game on EVERY frame between them — a chain neither
//      stops nor flashes — and the game's camera is never off without one;
//   2. the cube stands where the WORLD is (ml-view-angle) throughout;
//   3. a right tap and then a left one mid-quarter REVERSE the quarter and end
//      where it began (his orb's rule: "change direction immediately and go back").
// Slow on a software GL: a quarter is ~20-60 s here. BASE defaults to the dev
// client; the server must be running too (npm run dev).
import { chromium } from "playwright-core";
const EXE = process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const COL = +(process.env.COL || 305), ROW = +(process.env.ROW || 239);
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let bad = false;
const ok = (m) => console.log("ok:", m);
const fail = (m) => { console.log("FAIL:", m); bad = true; };
try {
  const p = await (await browser.newContext({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true })).newPage();
  p.on("pageerror", (e) => fail(`page error: ${e.message}`));
  await p.goto(`${BASE}/#the_game`, { waitUntil: "load" });
  const poll = async (fn, ms, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await p.evaluate(fn, arg)) return true; } catch {} await p.waitForTimeout(300); } return false; };
  if (!await poll(() => !!window.__mlSelect, 180000)) throw new Error("no character select");
  await p.evaluate(() => window.__mlSelect.commit());
  if (!await poll(() => window.__ml && window.__ml.players() >= 1, 180000)) throw new Error("never joined");
  await p.evaluate(() => { window.__ml.noAggro?.(true); window.__ml.timeSpeed(0); window.__ml.weather(0, true); window.__mlAmbient?.auto(false); });
  await p.evaluate(([c, r]) => window.__ml.teleport(c + 0.5, r + 0.5), [COL, ROW]);
  await poll(() => { const e = document.getElementById("ml-loading"); return !e || !e.isConnected || getComputedStyle(e).display === "none" || Number(getComputedStyle(e).opacity) === 0; }, 120000);
  let held = 0; const ts = Date.now();
  while (Date.now() - ts < 200000) { let st = false; try { st = await p.evaluate(() => !!(window.__ml && window.__ml.turnInfo().settled)); } catch {} held = st ? held + 1 : 0; if (held >= 6) break; await p.waitForTimeout(500); }
  await p.evaluate(() => window.addEventListener("ml-view-angle", (e) => (window.__gateAngle = e.detail)));
  const btn = (side) => p.evaluate((sd) => { const r = document.querySelector(`.ml-spinbtn.${sd}`).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, side);
  const R = await btn("right"), L = await btn("left");
  const scene = "window.__mlGame.scene.scenes.find((s) => s.monsters instanceof Map)";
  const trace = () => p.evaluate((sc) => {
    const s = eval(sc);
    window.__gateTr = [];
    const f = () => {
      const on = (fx) => !!fx && fx.canvas.isConnected && fx.canvas.style.opacity !== "0";
      const cube = window.__mlSpin(), w = window.__gateAngle;
      window.__gateTr.push({ live: on(s.rotFx), hold: on(s.rotFxHold), turning: s.turning, vr: s.viewRot, at: s.spinAt, goal: s.spinGoal, cam: s.cameras.main.visible,
        cube: cube.targetQ - cube.curQ, world: w ? w.goal - w.q : null });
      if (window.__gateTr.length < 4000) window.__gateRaf = requestAnimationFrame(f);
    };
    f();
  }, scene);
  const stop = () => p.evaluate(() => { cancelAnimationFrame(window.__gateRaf); return window.__gateTr; });
  const idle = () => poll((sc) => { const s = eval(sc), c = window.__mlSpin(); return !s.turning && !s.spinBusy && s.spinGoal === s.spinAt && !c.spinning && !s.rotFxHold; }, 900000, scene);

  // ── 1 + 2. A CHAIN: two quick rights ─────────────────────────────────────
  const start = await p.evaluate((sc) => { const s = eval(sc); return { vr: s.viewRot, at: s.spinAt }; }, scene);
  await trace();
  await p.touchscreen.tap(R.x, R.y); await p.waitForTimeout(150); await p.touchscreen.tap(R.x, R.y);
  if (!await idle()) throw new Error("the chain never came to rest");
  let tr = await stop();
  const end = tr[tr.length - 1];
  const i0 = tr.findIndex((r) => r.live || r.hold), i1 = tr.length - 1 - [...tr].reverse().findIndex((r) => r.live || r.hold);
  const gaps = i0 < 0 ? tr.length : tr.slice(i0, i1 + 1).filter((r) => !r.live && !r.hold).length;
  end.at === start.at + 2 && end.goal === start.at + 2 && end.vr === ((start.vr - 2) % 4 + 4) % 4
    ? ok(`two quick rights turn two quarters, the near side right each time (viewRot ${start.vr} -> ${end.vr})`)
    : fail(`two rights ended at viewRot ${end.vr}, at ${end.at}, goal ${end.goal} (from ${start.vr}/${start.at})`);
  gaps === 0 && tr.some((r) => r.hold)
    ? ok(`one journey: an overlay covers every frame between the quarters (a held one at the junction)`)
    : fail(`${gaps} uncovered frame(s) inside the chain, holds seen: ${tr.filter((r) => r.hold).length}`);
  tr.every((r) => r.cam || r.live || r.hold)
    ? ok(`the game's camera is never off without an overlay over it`)
    : fail(`a frame had the camera off and nothing covering it`);
  // the cube is drawn on every world update: the same remaining turn, give or
  // take a frame of this starved harness
  const fol = tr.filter((r) => r.world !== null && r.turning);
  const worst = fol.reduce((m, r) => Math.max(m, Math.abs(r.cube - r.world)), 0);
  fol.length > 0 && worst < 0.05
    ? ok(`the cube stands where the world is (${fol.length} frames, worst ${worst.toFixed(3)} quarter)`)
    : fail(`the cube and the world parted by ${worst.toFixed(3)} quarter over ${fol.length} frames`);

  // ── 3. A REVERSAL: right, then left mid-quarter ──────────────────────────
  const before = await p.evaluate((sc) => { const s = eval(sc); return { vr: s.viewRot, at: s.spinAt }; }, scene);
  await trace();
  await p.touchscreen.tap(R.x, R.y);
  await poll((sc) => { const s = eval(sc); return s.turning && s.rotFx && s.viewRot !== s.turnLog.from; }, 300000, scene);
  await p.touchscreen.tap(L.x, L.y);
  if (!await idle()) throw new Error("the reversal never came to rest");
  tr = await stop();
  const after = await p.evaluate((sc) => { const s = eval(sc); return { vr: s.viewRot, at: s.spinAt, goal: s.spinGoal, reversed: s.turnLog.reversed }; }, scene);
  tr.some((r) => r.vr !== before.vr)
    ? ok(`the renderer had swapped when the tap back came (a real reversal)`)
    : fail(`the renderer never swapped — the tap back came too early to test a reversal`);
  after.vr === before.vr && after.at === before.at && after.goal === before.at && after.reversed === 1
    ? ok(`a tap back mid-quarter reverses it and ends where it began (viewRot ${after.vr})`)
    : fail(`after the tap back: viewRot ${after.vr} (from ${before.vr}), at ${after.at}, goal ${after.goal}, reversed ${after.reversed}`);
} finally {
  await browser.close();
}
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
