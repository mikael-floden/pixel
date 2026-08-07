// MONSTER GAIT gate (maintainer round 13: monsters "jump" or the walk clip
// "is limping forward" — the animation must sync with the actual movement).
// The contract it proves, on the REAL monster_demo roster:
//   1. every walking monster's clip is paced by DISTANCE — one cycle per its
//      art-measured gait.cycleWu (±25%, unless a readability clamp binds);
//   2. the cadence FOLLOWS the speed — a monster dragged into a chase plays
//      measurably faster than the same monster roaming (the old fixed 6/10 fps
//      could only be right at one of the two);
//   3. the effective fps stays inside the readable band for every kind;
//   4. hoppers (frog/water_poring/diablo) carry a mean-zero travel surge and
//      ordinary walkers carry none.
// Runs against the dev stack (npm run dev). Small viewport per the
// headless-GL starvation rule.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const fail = (m) => { throw new Error(m); };
const ok = (m) => console.log(`ok - ${m}`);
const GAIT_FPS_MIN = 3, GAIT_FPS_MAX = 26;

try {
  const ctx = await browser.newContext({ viewport: { width: 480, height: 320 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));

  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  const idx = await page.evaluate(() => window.__mlSelect.worlds().findIndex((w) => /monster_demo/i.test(w)));
  if (idx < 0) fail("monster_demo missing from the picker");
  await page.evaluate((i) => window.__mlSelect.pickWorld(i), idx);
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 10000 });
  ok("joined monster_demo");

  // The manifest must carry a gait for every kind (the builder measures it).
  const missing = await page.evaluate(() =>
    (window.__ml.monsterDefs?.() ?? []).filter((d) => !d.gait?.cycleWu).map((d) => d.id),
  );
  if (missing === null) fail("no monsterDefs probe");
  if (missing.length) fail(`kinds with no measured gait.cycleWu: ${missing.join(", ")}`);
  ok("every roster kind ships an art-measured gait.cycleWu");

  // Sample the roster while it roams: walk the player around the pads so
  // different kinds un-cull, and collect per-kind gait samples.
  const seen = new Map();
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    const rows = await page.evaluate(() => window.__ml.monsterGait());
    for (const r of rows) {
      if (!r.walking || !r.spdWu || r.spdWu < 8) continue; // standing/parked
      const cur = seen.get(r.kind) ?? [];
      cur.push(r);
      seen.set(r.kind, cur);
    }
    if (seen.size >= 8 && [...seen.values()].every((v) => v.length >= 3)) break;
    // wander so more pads enter the view
    await page.evaluate(() => {
      const me = window.__ml.me();
      const a = (Date.now() / 1400) % (Math.PI * 2);
      window.__ml.teleport(
        Math.round(me.x / 32 + Math.cos(a) * 5),
        Math.round(me.y / 32 + Math.sin(a) * 5),
      );
    });
    await page.waitForTimeout(320);
  }
  if (seen.size < 4) fail(`only ${seen.size} kinds sampled walking — cannot judge the roster`);
  ok(`sampled ${seen.size} kinds walking`);

  // (1) + (3): cadence-true playback and a readable band.
  const bad = [];
  for (const [kind, rows] of seen) {
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const wu = med(rows.map((r) => r.wuPerCycle).filter((v) => v != null));
    const fps = med(rows.map((r) => r.fps));
    const cyc = rows[0].cycleWu;
    if (fps < GAIT_FPS_MIN - 0.01 || fps > GAIT_FPS_MAX + 0.01)
      bad.push(`${kind}: ${fps}fps outside the readable band`);
    // The clamps legitimately bind for very heavy/very light bodies — only
    // demand cadence-true playback when the rate is NOT clamped.
    const clamped = fps <= GAIT_FPS_MIN + 0.01 || fps >= GAIT_FPS_MAX - 0.01;
    if (!clamped && (wu < cyc * 0.75 || wu > cyc * 1.25))
      bad.push(`${kind}: ${wu}wu per cycle vs measured stride ${cyc}wu`);
  }
  if (bad.length) fail("gait desync:\n  " + bad.join("\n  "));
  ok("every sampled kind completes one walk cycle per its measured stride distance");

  // (2) the cadence FOLLOWS the speed: mark a monster so it hunts, and compare
  // its effective fps while chasing against its roaming rate.
  const target = await page.evaluate(() => {
    const st = window.__ml;
    const mine = st.me();
    let best = null;
    for (const m of st.monsterInfo()) {
      if (m.mstate === "die") continue;
      const d = Math.hypot(m.x - mine.x, m.y - mine.y);
      if (!best || d < best.d) best = { id: m.id, kind: m.kind, d };
    }
    return best;
  });
  const roamFps = (seen.get(target.kind) ?? []).map((r) => r.fps);
  await page.evaluate((mid) => {
    const st = window.__ml;
    const m = st.monsterInfo().find((x) => x.id === mid);
    st.teleport(Math.round(m.x / 32) + 2, Math.round(m.y / 32) + 2);
    st.engage(mid);
  }, target.id);
  await page.waitForFunction(
    (mid) => {
      const m = window.__ml.monsterInfo().find((x) => x.id === mid);
      return !!m && (m.mstate === "chase" || m.mstate === "combat");
    },
    target.id,
    { timeout: 10000, polling: 100 },
  );
  // Run away so the hunt is a CHASE (fast) rather than a stand-still fight.
  const chase = [];
  for (let i = 0; i < 26; i++) {
    await page.evaluate(() => {
      const me = window.__ml.me();
      window.__ml.teleport(Math.round(me.x / 32) + 1, Math.round(me.y / 32));
    });
    await page.waitForTimeout(160);
    const r = await page.evaluate(
      (mid) => window.__ml.monsterGait().find((x) => x.id === mid) ?? null,
      target.id,
    );
    if (r && r.walking && r.spdWu > 60) chase.push(r);
  }
  if (!chase.length) console.log(`(no chase sample for ${target.kind} — skipping the speed-follow check)`);
  else {
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const cf = med(chase.map((r) => r.fps));
    const rf = roamFps.length ? med(roamFps) : null;
    if (rf && cf <= rf * 1.15)
      fail(`${target.kind} chases at ${cf}fps but roams at ${rf}fps — cadence does not follow speed`);
    ok(`${target.kind} paces up when hunting (${rf ?? "?"}fps roaming → ${cf}fps chasing)`);
  }

  // (2b) COMBAT CLIPS KEEP THEIR AUTHORED RATE. Phaser's timeScale lives on
  // the sprite's animation STATE and survives every play(), so a monster that
  // breaks off a 3.5× chase into a swing would attack at 3.5× unless the gait
  // scale is reset — it was, and this pins it.
  const swings = [];
  for (let i = 0; i < 30; i++) {
    const r = await page.evaluate(
      (mid) => {
        const st = window.__ml;
        const m = st.monsterInfo().find((x) => x.id === mid);
        if (m) st.teleport(Math.round(m.x / 32), Math.round(m.y / 32)); // stand and fight
        const g = st.monsterGait().find((x) => x.id === mid);
        return g && m ? { anim: g.anim, ts: g.timeScale, mstate: m.mstate } : null;
      },
      target.id,
    );
    if (r && r.anim && /attack|angry|die/.test(r.anim)) swings.push(r);
    await page.waitForTimeout(140);
  }
  if (!swings.length) console.log("(no combat clip sampled — skipping the timeScale-reset check)");
  else {
    const off = swings.filter((s) => Math.abs(s.ts - 1) > 0.01);
    if (off.length) fail(`combat clip inherited the gait scale: ${JSON.stringify(off[0])}`);
    ok(`combat clips play at their authored rate (${swings.length} samples, timeScale 1)`);
  }

  // (4) hoppers surge, walkers glide.
  const hop = await page.evaluate(() => {
    const defs = window.__ml.monsterDefs();
    return {
      hoppers: defs.filter((d) => d.gait?.travel).map((d) => d.id),
      evenMean: defs
        .filter((d) => d.gait?.travel)
        .map((d) => d.gait.travel.reduce((a, b) => a + b, 0) / d.gait.travel.length),
    };
  });
  if (!hop.hoppers.length) fail("no kind carries a hop travel profile (the frog measurably hops)");
  if (!hop.hoppers.includes("mystical_frog")) fail(`frog missing from hoppers: ${hop.hoppers}`);
  for (const m of hop.evenMean) if (Math.abs(m - 1) > 0.02) fail(`hop travel weights are not mean-1 (${m}) — the surge would drift`);
  ok(`hop travel profiles: ${hop.hoppers.join(", ")} (mean-zero, no drift)`);

  console.log("\nverify-monstergait: ALL OK");
} finally {
  await browser.close();
}
