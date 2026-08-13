// verify-indoorscope — the SCOPED indoor cut and the TRANSITION FADE
// (dev stack; maintainer 2026-08-13, the two "hard tasks").
//
// #2 — walking into house_a must not open house_b: only columns whose
//      full-height art could bury MY room's floor are truncated (the covering
//      cone); the neighbour's house draws whole — roof and all — and simply
//      goes black under the zero-ambient rule. Asserted three ways: the
//      constrained set carries NO house_b cell (data), the shader's room
//      texture publishes real "unconstrained" sentinels (texture), and a probe
//      light parked over house_b's roof lights actual roof pixels while the
//      same patch is black without it (pixels — the 2g instrument: at zero
//      ambient a drawn tile and a missing one are identical until a light
//      tells them apart).
// #1 — the roof must not pop on a single frame: the transition is a debris
//      crossfade riding indoorMix. Asserted at the mechanism (a genuine
//      intermediate debris/alpha sample exists on entry AND exit, and the
//      layer is gone once settled) and on pixels (a mid-fade shot's roof
//      patch sits strictly between the outdoor and settled values).
//
// FIXTURE: house_demo — six roofed houses; house_a is the north-west one,
// house_b its neighbour ~8 cells east. Both derived from world.json, so a
// re-authored map moves the assertions with it.
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const fail = (m) => { throw new Error(m); };
let passed = 0;
const ok = (m) => { passed++; console.log(`ok - ${m}`); };

const world = JSON.parse(
  readFileSync(new URL("../../maps2/worlds/house_demo/world.json", import.meta.url), "utf8"),
);
const lvl = (c, r) => {
  const row = world.level?.[r];
  return typeof row === "string" ? parseInt(row[c] ?? "0", 36) || 0 : Array.isArray(row) ? row[c] ?? 0 : 0;
};
const X = (c) => (Array.isArray(c) ? c[0] : c.x);
const Y = (c) => (Array.isArray(c) ? c[1] : c.y);
const roofs = (world.decks ?? []).filter((d) => d.kind === "roof");
if (roofs.length < 2) fail(`house_demo ships ${roofs.length} roof decks — the two-house fixture is gone`);
const houseOf = (d) => {
  const cells = d.cells.map((c) => [X(c), Y(c)]);
  const xs = cells.map(([c]) => c), ys = cells.map(([, r]) => r);
  const floor = cells.filter(([c, r]) => lvl(c, r) < d.level - (d.thickness ?? 0));
  return { d, cells, floor, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};
// house_a: the roof nearest the world's north-west; house_b: the nearest OTHER
// roof to its east — the "city neighbour" case.
const houses = roofs.map(houseOf).filter((h) => h.floor.length >= 8);
houses.sort((a, b) => a.x0 + a.y0 - (b.x0 + b.y0));
const A = houses[0];
const B = houses.find((h) => h !== A && Math.abs(h.y0 - A.y0) < 8) ?? houses[1];
const centre = (h) => {
  const cc = Math.round(h.floor.reduce((s, [c]) => s + c, 0) / h.floor.length);
  const cr = Math.round(h.floor.reduce((s, [, r]) => s + r, 0) / h.floor.length);
  return h.floor.slice().sort((p, q) => Math.hypot(p[0] - cc, p[1] - cr) - Math.hypot(q[0] - cc, q[1] - cr))[0];
};
const [aC, aR] = centre(A);
// house_b's sample cell: its westernmost roofed column, mid-height — the part
// of the neighbour nearest house_a, which is what a 640px frame can hold.
const bCol = A === B ? fail("house_a == house_b") : Math.min(...B.cells.map(([c]) => c)) + 1;
const bRows = B.cells.filter(([c]) => c === bCol).map(([, r]) => r).sort((a, b) => a - b);
const bRow = bRows[bRows.length >> 1];
// Outside spot: south of house_a, clear of every roof.
const OUT_SPOT = [aC + 0.5, A.y1 + 2.5];
console.log(
  `house_a roof (${A.x0},${A.y0})-(${A.x1},${A.y1}) interior ${A.floor.length}, centre ${aC},${aR}; ` +
  `house_b (${B.x0},${B.y0})-(${B.x1},${B.y1}), sample cell ${bCol},${bRow}; outside ${OUT_SPOT}`,
);

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  const page = await (await browser.newContext({ viewport: { width: 720, height: 480 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 160)));
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  const idx = await page.evaluate(() => window.__mlSelect.worlds().findIndex((w) => /house_demo/i.test(w)));
  if (idx < 0) fail("house_demo missing from the picker");
  await page.evaluate((i) => { window.__mlSelect.pickWorld(i); window.__mlSelect.commit(); }, idx);
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 40000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 25000 });
  await page.evaluate(() => window.__ml.timeSpeed(0));
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.__ml.timeOfDay("Day", true);
    window.__ml.aurora(false, true);
    window.__ml.weather(0, true);
    window.__ml.noAggro?.(true);
  });
  await page.waitForTimeout(600);

  const shoot = async (name) => {
    const buf = await page.screenshot();
    if (process.env.SHOT_DIR) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(process.env.SHOT_DIR, `scope-${name}.png`), buf);
    }
    return PNG.sync.read(buf);
  };
  const patch = (img, x, y, r) => {
    let sum = 0, n = 0;
    const all = [];
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const px = Math.round(x + dx), py = Math.round(y + dy);
        if (px < 0 || py < 0 || px >= img.width || py >= img.height) return null;
        const i = (py * img.width + px) * 4;
        const l = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
        sum += l; n++; all.push(l);
      }
    all.sort((a, b) => a - b);
    return { mean: sum / n, med: all[all.length >> 1] };
  };
  const cellScreen = async (c, r) => {
    const s = await page.evaluate(([cc, rr]) => window.__ml.cellScreen(cc, rr), [c, r]);
    if (!s) fail(`cellScreen(${c},${r}) returned null`);
    return s;
  };
  // Roof-plane point of a floor cell: the deck's top diamond centre. cellScreen
  // reports the cell's ground box at its own terrain level; the roof sits
  // deck.level levels higher, its diamond centre ~23px into the 64px box.
  const roofPoint = async (c, r, deckLevel) => {
    const s = await cellScreen(c, r);
    return { x: s.x + 32, y: s.y + (s.level - deckLevel) * 16 + 23 };
  };
  const settle = (want, timeout = 60000) =>
    page.waitForFunction(
      (w) => {
        const d = window.__ml?.indoor?.();
        return !!d && d.indoor === w && (w ? d.mix >= 1 : d.mix <= 0);
      },
      want,
      { timeout, polling: 150 },
    ).then(() => true).catch(() => false);
  const goTo = async (col, row) => {
    for (let n = 0; n < 6; n++) {
      await page.evaluate(([c, r]) => { const m = window.__ml.me(); if (m?.dead) window.__ml.roomSend("respawn", {}); window.__ml.teleport(c, r); }, [col, row]);
      const there = await page.waitForFunction(
        ([c, r]) => { const m = window.__ml?.me?.(); return !!m && Math.abs(m.x / 32 - c) < 0.6 && Math.abs(m.y / 32 - r) < 0.6; },
        [col, row], { timeout: 6000, polling: 100 },
      ).then(() => true).catch(() => false);
      if (there) return;
    }
    fail(`teleport to ${col},${row} never took`);
  };

  // Pin the camera between the houses and WAIT FOR IT TO ARRIVE — lookAt
  // glides, and a teleport re-attaches + snaps it to the player, so every
  // sample point must be projected against a camera that has stopped moving.
  const CAM = [aC + 7, aR];
  const camPin = async () => {
    await page.evaluate(([c, r]) => window.__ml.lookAt(c, r), CAM);
    // Settled = the projection of a fixed cell stops moving ACROSS SUSTAINED
    // polls (the chase-cam "trail" is distance to the PLAYER and never lands
    // while detached; a single stable pair can be two polls inside one
    // starved frame).
    let prev = null;
    let stable = 0;
    for (let n = 0; n < 100 && stable < 4; n++) {
      const s2 = await page.evaluate(([c, r]) => window.__ml.cellScreen(c, r), [aC, aR]);
      stable = prev && s2 && Math.abs(s2.x - prev.x) < 1 && Math.abs(s2.y - prev.y) < 1 ? stable + 1 : 0;
      prev = s2;
      await page.waitForTimeout(260);
    }
    if (stable < 4) fail("the pinned camera never stopped gliding");
    await page.waitForTimeout(250);
  };

  // ---- 1. ENTER house_a: the neighbour stays closed ------------------------
  await goTo(aC + 0.5, aR + 0.5);
  if (!(await settle(true, 45000))) fail(`never settled indoors in house_a: ${JSON.stringify(await page.evaluate(() => window.__ml.indoor()))}`);
  await camPin();
  const raise = await page.evaluate(() => window.__ml.indoorRaise());
  if (!raise.on || raise.constrained <= 0) fail(`no constrained set indoors (${JSON.stringify(raise).slice(0, 200)})`);
  const inB = Object.keys(raise.cuts)
    .map((k) => k.split(",").map(Number))
    .filter(([c, r]) => c >= B.x0 && c <= B.x1 && r >= B.y0 && r <= B.y1 && B.cells.some(([bc, br]) => bc === c && br === r));
  if (inB.length)
    fail(`house_b is CONSTRAINED at ${inB.slice(0, 8).map((p) => p.join(",")).join(" ")} — entering house_a still opens the neighbour`);
  const tex = await page.evaluate(() => window.__ml.roomTex());
  if (!(tex.uncut > 0)) fail(`the room texture carries no 'unconstrained' sentinel (uncut=${tex.uncut}) — the shader would truncate the whole world`);
  if (tex.raisedCells !== raise.raised) fail(`texture raised ${tex.raisedCells} != scene ${raise.raised}`);
  ok(`house_b stays closed: ${raise.constrained} constrained cells (walls ${raise.raised} raised, cone ${raise.cone}), ` +
    `none inside the neighbour; texture publishes ${tex.uncut} unconstrained sentinels`);

  // ---- 2. THE INSTRUMENT: house_b's roof is DRAWN, merely unlit ------------
  await page.evaluate(() => window.__ml.torch(false));
  await page.waitForTimeout(900);
  // Safe box: inside the game view, clear of the Wiki chip + clock pill that
  // hug the right edge from ~y200 down (DOM, composited into screenshots).
  const gvH = Math.round(480 * 0.618);
  const safe = (pt) =>
    pt.x > 40 && pt.x < 700 && pt.y > 40 && pt.y < gvH - 6 && !(pt.x > 625 && pt.y > 205);
  let bp = null, bCell = null;
  const candLog = [];
  for (const [bc, br] of B.cells.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1])) {
    const cand = await roofPoint(bc, br, B.d.level);
    if (candLog.length < 14) candLog.push(`${bc},${br}->${Math.round(cand.x)},${Math.round(cand.y)}`);
    if (safe(cand)) { bp = cand; bCell = [bc, br]; break; }
  }
  if (!bp) console.log("candidates:", candLog.join(" | "));
  if (!bp) fail("no house_b roof cell lands safely in frame — reframe the camera");
  console.log(`house_b sample ${bCell} at screen ${Math.round(bp.x)},${Math.round(bp.y)}`);
  const dark = patch(await shoot("b-roof-dark"), bp.x, bp.y, 4);
  await page.evaluate(([c, r, z]) => window.__ml.probeLight(c + 0.5, r + 0.5, z, 4.5), [bCell[0], bCell[1], B.d.level + 1.2]);
  await page.waitForTimeout(900);
  const lit = patch(await shoot("b-roof-lit"), bp.x, bp.y, 4);
  await page.evaluate(() => window.__ml.probeLight());
  await page.waitForTimeout(400);
  if (!dark || !lit) fail("house_b roof sample fell off screen — reframe the camera");
  if (!(dark.med < 6)) fail(`house_b's roof reads ${dark.med.toFixed(1)} unlit — the outside must be black at zero ambient`);
  if (!(lit.med > dark.med + 8))
    fail(`a probe light over house_b's roof does not reveal it (${dark.med.toFixed(1)} -> ${lit.med.toFixed(1)}) — ` +
      `the roof is not being DRAWN, it was culled like the old world-wide cut`);
  ok(`house_b's roof is drawn and dark, not gone: unlit ${dark.med.toFixed(1)}, probe-lit ${lit.med.toFixed(1)} ` +
    `(the zero-ambient rule — and the black-villager feature riding it — is untouched)`);

  // ---- 3. the legacy kill switch still covers the whole world --------------
  const legacy = await page.evaluate(() => { window.__ml.indoorRaise(false); return window.__ml.roomTex(); });
  if (legacy.uncut !== 0) fail(`kill switch left ${legacy.uncut} unconstrained cells — the flat QA world is gone`);
  await page.evaluate(() => window.__ml.indoorRaise(true));
  await page.waitForTimeout(500);
  ok("the kill switch still gives QA the flat world-wide cut (0 sentinels)");

  // ---- 4. THE FADE, entry: never a single-frame pop ------------------------
  // The roof patch of house_a must pass through a genuine intermediate frame.
  // PORTRAIT for these sections: the fade is sampled with the camera FOLLOWING
  // the player (a teleport snaps it), and a 6-level roof plane sits ~120px
  // up-screen of a body standing outside the door — only a tall game view
  // holds both. The resize rebuilds the renderer exactly like a rotation.
  await page.evaluate(() => window.__ml.lookAt());
  await page.setViewportSize({ width: 480, height: 800 });
  await page.waitForTimeout(1500);
  // The fade anchor: the roof plane over a SOUTH-EDGE interior cell. Over the
  // room's centre the RAISED far wall now fills that plane with fire-lit wall
  // art — the content flips completely while the luminance barely moves. Over
  // the south edge the near wall stays at the dial, so entry ends in true
  // void: bright roof art -> black, a span a median can measure.
  const fadeCell = [aC, A.y1 - 1];
  const roofMed = async (name) => {
    const p = await roofPoint(fadeCell[0], fadeCell[1], A.d.level);
    const v = patch(await shoot(name), p.x, p.y, 4);
    if (!v) fail(`house_a roof point off screen for ${name} (${Math.round(p.x)},${Math.round(p.y)})`);
    return v.med;
  };
  // THE PIN IS THE INSTRUMENT. At 3× the debris crosses its whole alpha range
  // inside one or two STARVED harness frames (a single ~180ms delta carries
  // the mix past ⅓ — measured; a real 60fps device renders ~8 blended
  // frames), so no wall-clock sampling can photograph the blend here. The
  // pin parks the mix mid-roll BEFORE the trigger lands, the shot is taken at
  // leisure on a stable frame, and the release lets the roll complete.
  const tryFade = async (label, goIn) => {
    await page.evaluate(() => window.__ml.lookAt());
    await goTo(...(goIn ? OUT_SPOT : [aC + 0.5, aR + 0.5]));
    if (!(await settle(!goIn, 45000))) return null;
    await page.waitForTimeout(300);
    const before = await roofMed(`${label}-before`);
    // Pin at a MID blend, then trigger in the same evaluate: entry alpha at
    // mix .15 = .55; exit alpha at mix .85 = .45 — both genuinely blended.
    await page.evaluate(([tc, tr, pin]) => {
      window.__ml.indoorMixPin(pin);
      const m = window.__ml.me();
      if (m?.dead) window.__ml.roomSend("respawn", {});
      window.__ml.teleport(tc, tr);
    }, [...(goIn ? [aC + 0.5, aR + 0.5] : OUT_SPOT), goIn ? 0.15 : 0.85]);
    const flipped = await page.waitForFunction(
      (w) => window.__ml.indoor().indoor === w && window.__ml.indoorFade().debris > 0,
      goIn,
      { timeout: 20000, polling: 100 },
    ).then(() => true).catch(() => false);
    if (!flipped) {
      await page.evaluate(() => window.__ml.indoorMixPin(null));
      return null;
    }
    await page.waitForTimeout(700); // a couple of stable pinned frames
    const mid = await page.evaluate(() => window.__ml.indoorFade());
    const midVal = await roofMed(`${label}-mid`);
    // Exit only: re-pin deep into the roll's tail — debris complete, light
    // ~settled — the frame the maintainer's colour snap lived on.
    let late = null;
    if (!goIn) {
      await page.evaluate(() => window.__ml.indoorMixPin(0.02));
      await page.waitForTimeout(700);
      late = await roofMed(`${label}-late`);
    }
    await page.evaluate(() => window.__ml.indoorMixPin(null));
    if (!(await settle(goIn, 45000))) return null;
    await page.waitForTimeout(400);
    const after = await roofMed(`${label}-after`);
    const fadeEnd = await page.evaluate(() => window.__ml.indoorFade());
    if (!(mid.debris > 0 && mid.alpha > 0.01 && mid.alpha < 0.99)) {
      console.log(`  [${label}] pinned frame not blended: ${JSON.stringify(mid)}`);
      return null;
    }
    return { before, midVal, late, after, mid, sawExiting: mid.exiting, fadeEnd };
  };
  // "Not a pop" = the transition really rendered a BLENDED state (the
  // recorder caught the debris at an intermediate alpha — at 3× on a starved
  // 3fps harness that is 2-3 frames, which is why the recorder lives in the
  // page) and the layer is gone at settle. Deliberately NOT a mid-shot pixel
  // corridor: at these frame rates no node-side screenshot can be timed into
  // the fast half of a 3× curve, and the debris composites over a background
  // whose own light is still easing, so the anchor is legitimately
  // non-monotone anyway.
  const judge = (t, label) => {
    if (!t) fail(`could not catch the ${label} fade in 3 attempts — is it running at all?`);
    if (t.fadeEnd.debris !== 0) fail(`${label} debris survived the settle (${t.fadeEnd.debris})`);
    const span = Math.abs(t.before - t.after);
    if (!(span > 20)) fail(`the roof patch barely changes across the ${label} (${t.before.toFixed(1)} -> ${t.after.toFixed(1)}) — sample is wrong`);
    // The pinned mid frame is a real rendered blend — it must look like
    // NEITHER endpoint at the anchor, which is the literal "not binary".
    if (!(Math.abs(t.midVal - t.before) > 8 && Math.abs(t.midVal - t.after) > 8))
      fail(`the pinned ${label} mid frame (${t.midVal.toFixed(1)}) is indistinguishable from an endpoint ` +
        `(${t.before.toFixed(1)} / ${t.after.toFixed(1)}) — the transition reads binary`);
    ok(`${label.toUpperCase()} blends: roof ${t.before.toFixed(1)} -> ${t.midVal.toFixed(1)} ` +
      `(debris ${t.mid.debris} @ alpha ${t.mid.alpha}, pinned) -> ${t.after.toFixed(1)}, gone at settle`);
  };
  let entry = null;
  for (let n = 0; n < 3 && !entry; n++) entry = await tryFade(`entry${n}`, true);
  judge(entry, "entry");

  // ---- 5. THE FADE, exit: back gradually, and NO COLOUR SNAP AT THE END ----
  let exit = null;
  for (let n = 0; n < 3 && !exit; n++) exit = await tryFade(`exit${n}`, false);
  judge(exit, "exit");
  if (exit && !exit.sawExiting)
    fail("the exit fade never reported exiting=true — the cut world is not being held through the roll");
  // THE MAINTAINER'S SNAP (2026-08-13: "the top of the roof completely
  // changes color" at the fade's end): the late-exit frame — debris complete,
  // mix deep in the roll's slow tail — must already match the settled outdoor
  // roof. Clamped-resolve lighting made this a full tint pop (the roof lit as
  // the shadowed interior behind it until the swap); the exit flip unclamps
  // the resolve now, so the only residual is the ambient's own last easing.
  {
    const drift = Math.abs(exit.late - exit.after);
    const span = Math.abs(exit.before - exit.after);
    if (!(drift <= Math.max(14, span * 0.35)))
      fail(`the roof still snaps at the exit's end: late-fade ${exit.late.toFixed(1)} vs settled ${exit.after.toFixed(1)} ` +
        `(drift ${drift.toFixed(1)} over a ${span.toFixed(1)} span) — the resolve is being clamped through the fade again`);
    ok(`no colour snap at the exit's end: late-fade roof ${exit.late.toFixed(1)} ≈ settled ${exit.after.toFixed(1)} ` +
      `(drift ${drift.toFixed(1)}, transition span ${span.toFixed(1)})`);
  }

  // ---- 6. the zero-ambient mechanism itself, one data pin ------------------
  await goTo(aC + 0.5, aR + 0.5);
  if (!(await settle(true, 45000))) fail("could not re-enter for the ambient pin");
  const farL = await page.evaluate(([c, r]) => window.__ml.lightAtCell(c, r, 0), [OUT_SPOT[0] + 4, OUT_SPOT[1] + 4]);
  if (Math.max(...farL) > 1e-6)
    fail(`the outdoor ambient is not zero while indoors (${farL.map((v) => v.toFixed(4)).join(",")}) — the black-NPC feature's mechanism moved`);
  ok("outdoor ambient is exactly zero while indoors — the darkened-NPC feature's mechanism is untouched");

  if (errs.length) fail(`page errors: ${errs.join(" | ")}`);
  console.log(`\nverify-indoorscope: ALL OK (${passed})`);
} finally {
  await browser.close();
}
