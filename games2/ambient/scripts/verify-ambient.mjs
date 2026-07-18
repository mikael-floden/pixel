// Ambient-life QA: against a running dev stack (npm run dev), force
// time-of-day/weather through the game's __ml probes and assert each
// ambient feature's gain, population, motion and director weights through
// __mlAmbient. Randomness is pinned via reroll(r) — assertions are on the
// deterministic weight table, never on lottery luck.
import { chromium } from "playwright-core";

const EXE = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let failed = 0;
const fail = (m) => {
  console.error(`AMBIENT FAIL: ${m}`);
  failed++;
  process.exitCode = 1;
};
const ok = (m) => console.log(`  ok: ${m}`);

try {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 30000 });
  await page.waitForFunction(() => window.__mlAmbient, null, { timeout: 10000 });

  const dbg = (name) => page.evaluate((n) => window.__mlAmbient.debug(n), name);

  // ---- registry ----
  const list = await page.evaluate(() => window.__mlAmbient.list());
  for (const want of ["fireflies", "pollen", "bats", "thunder", "sandstorm", "leaves"])
    if (!list.includes(want)) fail(`feature ${want} not mounted (got ${list})`);
  if (list.includes("heathaze") || list.includes("rainbow") || list.includes("tumbleweed"))
    fail(`heathaze/rainbow/tumbleweed were removed but still mounted (${list})`);
  ok(`mounted: ${list.join(", ")}`);

  // ---- night: fireflies up, pollen down ----
  await page.evaluate(() => {
    window.__ml.timeOfDay("night", true);
    window.__ml.weather(0, true);
  });
  await page.waitForTimeout(4000); // gain eases on a ~1.5s tau
  const ffNight = await dbg("fireflies");
  const poNight = await dbg("pollen");
  if (ffNight.gain < 0.6) fail(`fireflies must glow at night (gain ${ffNight.gain.toFixed(2)})`);
  if (ffNight.lit < 3) fail(`fireflies must be lit at night (${ffNight.lit}/${ffNight.count})`);
  if (poNight.gain > 0.15) fail(`pollen must fade at night (gain ${poNight.gain.toFixed(2)})`);
  ok(`night: fireflies gain ${ffNight.gain.toFixed(2)} (${ffNight.lit} lit), pollen gain ${poNight.gain.toFixed(2)}`);

  // fireflies actually wander
  const p1 = ffNight.sample;
  await page.waitForTimeout(800);
  const p2 = (await dbg("fireflies")).sample;
  if (p1 && p2 && Math.hypot(p1.x - p2.x, p1.y - p2.y) < 0.5)
    fail(`fireflies must wander (moved ${Math.hypot(p1.x - p2.x, p1.y - p2.y).toFixed(2)}px in 800ms)`);
  else ok("fireflies wander");

  // ---- day: pollen up, fireflies out ----
  await page.evaluate(() => window.__ml.timeOfDay("day", true));
  await page.waitForTimeout(4500);
  const ffDay = await dbg("fireflies");
  const poDay = await dbg("pollen");
  if (ffDay.gain > 0.15) fail(`fireflies must melt away by day (gain ${ffDay.gain.toFixed(2)})`);
  if (poDay.gain < 0.5) fail(`pollen must drift in daylight (gain ${poDay.gain.toFixed(2)})`);
  if (poDay.lit < 3) fail(`pollen must be visible by day (${poDay.lit}/${poDay.count})`);
  ok(`day: pollen gain ${poDay.gain.toFixed(2)} (${poDay.lit} lit), fireflies gain ${ffDay.gain.toFixed(2)}`);

  // cloudy kills the sunbeams
  await page.evaluate(() => window.__ml.weather(1, true));
  await page.waitForTimeout(4500);
  const poCloud = await dbg("pollen");
  if (poCloud.gain > poDay.gain - 0.2)
    fail(`cloud cover must thin pollen (clear ${poDay.gain.toFixed(2)} -> cloudy ${poCloud.gain.toFixed(2)})`);
  else ok(`cloudy thins pollen (${poDay.gain.toFixed(2)} -> ${poCloud.gain.toFixed(2)})`);
  await page.evaluate(() => window.__ml.weather(0, true));

  // ---- director weights (deterministic — no lottery luck) ----
  const w = await page.evaluate(() => ({
    day: window.__mlAmbient.weights({ night: 0, sun: 1, cloud: 0, mist: 0, weatherName: "Clear sky" }),
    night: window.__mlAmbient.weights({ night: 1, sun: 0, cloud: 0, mist: 0, weatherName: "Clear sky" }),
    rainDay: window.__mlAmbient.weights({ night: 0, sun: 1, cloud: 1, mist: 0, weatherName: "Rain" }),
    rainNight: window.__mlAmbient.weights({ night: 1, sun: 0, cloud: 1, mist: 0, weatherName: "Rain" }),
  }));
  const ratio = w.day.bats / w.night.bats;
  if (Math.abs(ratio - 0.01) > 0.005)
    fail(`bats by day must be ~1% of night (got ${(ratio * 100).toFixed(2)}%)`);
  else ok(`bats day/night likeliness ${(ratio * 100).toFixed(1)}%`);
  const rd = w.rainDay.thunder / w.day.thunder;
  const rn = w.rainNight.thunder / w.day.thunder;
  if (Math.abs(rd - 2) > 0.05) fail(`thunder raining must be x2 base (got x${rd.toFixed(2)})`);
  if (Math.abs(rn - 3) > 0.05) fail(`thunder night+raining must be x3 base (got x${rn.toFixed(2)})`);
  if (!(rd < rn)) fail("thunder: night+rain must beat rain alone");
  ok(`thunder likeliness rain x${rd.toFixed(2)}, night+rain x${rn.toFixed(2)}`);
  // Sandstorm is TERRAIN-gated: no sand underfoot, no storm — ever.
  const ss = await page.evaluate(() => ({
    onSand: window.__mlAmbient.weights({ sand: 1, mist: 0, weatherName: "Clear sky" }).sandstorm,
    offSand: window.__mlAmbient.weights({ sand: 0, mist: 0, weatherName: "Clear sky" }).sandstorm,
    sandRain: window.__mlAmbient.weights({ sand: 1, mist: 0, weatherName: "Rain" }).sandstorm,
  }));
  if (!(ss.onSand > 0.3)) fail(`sandstorm must be likely on sand (${ss.onSand})`);
  if (ss.offSand > 0.001) fail(`sandstorm must NEVER roll off sand (${ss.offSand})`);
  if (ss.sandRain > 0.001) fail(`rain must kill the sandstorm (${ss.sandRain})`);
  ok(`sandstorm likeliness: terrain-gated (sand ${ss.onSand.toFixed(2)}, grass ${ss.offSand}, rain ${ss.sandRain})`);
  // ---- director rolls + episode life cycle ----
  await page.evaluate(() => window.__ml.timeOfDay("night", true));
  await page.waitForTimeout(300);
  // Pin the roll low → lands on the first non-zero-weight episode (bats at night).
  const rolled = await page.evaluate(() => window.__mlAmbient.reroll(0.01));
  if (rolled.active !== "bats") fail(`pinned night roll should pick bats (got ${rolled.active})`);
  const bats1 = await dbg("bats");
  if (!bats1.active) fail("bats must be active after winning the roll");
  // First flock launches within ~6s of activation.
  await page.waitForTimeout(7000);
  const bats2 = await dbg("bats");
  if (bats2.flocks < 1) fail(`an active bats episode must launch a flock (${bats2.flocks})`);
  else ok(`bats episode launched ${bats2.flocks} flock(s), ${bats2.inFlight} in flight`);
  // Pin the roll high → the quiet slot; bats deactivate gracefully.
  const quiet = await page.evaluate(() => window.__mlAmbient.reroll(0.999999));
  if (quiet.active !== null) fail(`high pinned roll should land on quiet (got ${quiet.active})`);
  if ((await dbg("bats")).active) fail("bats must deactivate when the quiet slot wins");
  else ok("quiet slot wins → bats stand down");

  // ---- demo button (maintainer 2026-07-18): selects the effect ONLY, never
  // changes time-of-day/weather; has AUTO (shows the live effect) + NONE ----
  await page.evaluate(() => window.__mlAmbient.demo("auto"));
  const btn = await page.evaluate(() => document.querySelector(".ml-ambient-btn")?.textContent ?? null);
  if (!btn || !btn.startsWith("ambient: auto")) fail(`settings must carry the ambient button (got ${JSON.stringify(btn)})`);
  else ok(`settings button injected (${btn})`);

  // The button must NOT touch time-of-day: record it, demo an effect, assert
  // the phase is unchanged (the whole point of this change).
  await page.evaluate(() => window.__ml.timeOfDay("day", true));
  const todBefore = await page.evaluate(() => window.__ml.timeOfDay().name);
  await page.evaluate(() => window.__mlAmbient.demo("thunder"));
  await page.waitForTimeout(600);
  const todAfter = await page.evaluate(() => window.__ml.timeOfDay().name);
  if (todAfter !== todBefore) fail(`demo must NOT change time-of-day (${todBefore} -> ${todAfter})`);
  else ok(`demo leaves time-of-day alone (stayed ${todAfter})`);

  // Demo thunder: episode pinned on, fields suppressed (solo).
  const dirDemo = await page.evaluate(() => window.__mlAmbient.director());
  if (dirDemo.pinned !== "thunder" || dirDemo.active !== "thunder")
    fail(`demo(thunder) must pin thunder (got ${JSON.stringify(dirDemo)})`);
  await page.waitForTimeout(3500);
  const ffSolo = await dbg("fireflies");
  if (!ffSolo.suppressed || ffSolo.gain > 0.15)
    fail(`demoing thunder must suppress fireflies (suppressed=${ffSolo.suppressed}, gain ${ffSolo.gain.toFixed(2)})`);
  else ok("solo: fireflies suppressed while thunder is selected");

  // Demo a FIELD (fireflies): FORCED on at full regardless of the daytime
  // env gate, episodes quiet — "select fireflies" actually shows fireflies.
  await page.evaluate(() => window.__mlAmbient.demo("fireflies"));
  await page.waitForTimeout(4000);
  const dirField = await page.evaluate(() => window.__mlAmbient.director());
  const ffOn = await dbg("fireflies");
  if (dirField.active !== null) fail(`selecting a field must quiet episodes (got ${JSON.stringify(dirField)})`);
  if (!ffOn.forced || ffOn.gain < 0.6)
    fail(`selected fireflies must force ON by day (forced=${ffOn.forced}, gain ${ffOn.gain?.toFixed?.(2)})`);
  else ok(`select(fireflies): forced on by day (gain ${ffOn.gain.toFixed(2)}), episodes quiet`);

  // NONE: everything off.
  await page.evaluate(() => window.__mlAmbient.demo("none"));
  await page.waitForTimeout(4000);
  const ffNone = await dbg("fireflies");
  const poNone = await dbg("pollen");
  const dirNone = await page.evaluate(() => window.__mlAmbient.director());
  if (ffNone.gain > 0.15 || poNone.gain > 0.15 || dirNone.active !== null)
    fail(`NONE must silence everything (ff ${ffNone.gain?.toFixed?.(2)}, po ${poNone.gain?.toFixed?.(2)}, ep ${dirNone.active})`);
  else ok("none: every ambient effect off");

  // Episodes still show FULL regardless of time (sandstorm dust floor).
  await page.evaluate(() => window.__mlAmbient.demo("sandstorm"));
  await page.waitForTimeout(6000);
  const ssd = await dbg("sandstorm");
  if (!ssd.active || ssd.streaks < 30) fail(`demoed sandstorm must run (active ${ssd.active}, ${ssd.streaks} streaks)`);
  else ok(`demo(sandstorm): running (gain ${ssd.gain.toFixed(2)}, ${ssd.streaks} streaks)`);

  // Clicking the real button advances the ring (sandstorm → leaves) and prints state.
  const label = await page.evaluate(() => {
    document.querySelector(".ml-ambient-btn").click();
    return document.querySelector(".ml-ambient-btn").textContent;
  });
  if (label !== "ambient: leaves") fail(`button click must advance sandstorm -> leaves (got ${JSON.stringify(label)})`);
  else ok("button click advances the ring (sandstorm -> leaves)");

  // Leaves must FALL in world-height, LAND, and REST on the ground (not slide
  // down-screen forever). Give them time for the low ones to touch down.
  await page.waitForTimeout(9000);
  const lvd = await dbg("leaves");
  if (lvd.count < 3) fail(`leaves must be falling (${lvd.count})`);
  if ((lvd.resting ?? 0) < 1) fail(`some leaves must LAND and rest on the ground (resting ${lvd.resting} of ${lvd.count})`);
  else ok(`leaves fall + land: ${lvd.falling} falling, ${lvd.resting} resting, ${lvd.fading} fading`);

  // AUTO shows the LIVE active effect: at night with nothing pinned,
  // fireflies self-gate on and the label reports "auto (fireflies)".
  await page.evaluate(() => { window.__ml.timeOfDay("night", true); window.__mlAmbient.demo("auto"); });
  await page.waitForTimeout(4000);
  const autoLabel = await page.evaluate(() => document.querySelector(".ml-ambient-btn")?.textContent);
  const dirAuto = await page.evaluate(() => window.__mlAmbient.director());
  if (dirAuto.pinned !== null) fail(`auto must release the pin (got ${JSON.stringify(dirAuto)})`);
  if (!/^ambient: auto \(.+\)$/.test(autoLabel)) fail(`AUTO must show the active effect (got ${JSON.stringify(autoLabel)})`);
  else ok(`auto reports the live effect (${autoLabel})`);

  if (!failed) console.log("AMBIENT OK");
} finally {
  await browser.close();
}
