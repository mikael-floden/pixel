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
  for (const want of ["fireflies", "pollen", "bats", "thunder"])
    if (!list.includes(want)) fail(`feature ${want} not mounted (got ${list})`);
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

  // ---- demo button: injected into settings, cycles + jumps the world ----
  const btn = await page.evaluate(() => document.querySelector(".ml-ambient-btn")?.textContent ?? null);
  if (btn !== "ambient: auto") fail(`settings must carry the ambient button (got ${JSON.stringify(btn)})`);
  else ok("settings button injected (ambient: auto)");
  // Demo thunder: world jumps to its preferred Night + Cloudy, episode pinned on.
  await page.evaluate(() => window.__mlAmbient.demo("thunder"));
  await page.waitForFunction(
    () => window.__ml.timeOfDay().name === "Night" && window.__ml.weatherInfo().idx === 1,
    null,
    { timeout: 5000 },
  );
  const dirDemo = await page.evaluate(() => window.__mlAmbient.director());
  if (dirDemo.pinned !== "thunder" || dirDemo.active !== "thunder")
    fail(`demo(thunder) must pin thunder (got ${JSON.stringify(dirDemo)})`);
  if (!(await dbg("thunder")).active) fail("demoed thunder must be active");
  else ok("demo(thunder): world -> Night + Cloudy, episode pinned on");
  // Demo a FIELD (pollen): world jumps to Day + Clear, episodes go quiet.
  await page.evaluate(() => window.__mlAmbient.demo("pollen"));
  await page.waitForFunction(
    () => window.__ml.timeOfDay().name === "Day" && window.__ml.weatherInfo().idx === 0,
    null,
    { timeout: 5000 },
  );
  const dirField = await page.evaluate(() => window.__mlAmbient.director());
  if (dirField.pinned !== "quiet" || dirField.active !== null)
    fail(`demo(pollen) must quiet the episodes (got ${JSON.stringify(dirField)})`);
  if ((await dbg("thunder")).active) fail("thunder must stand down when a field is demoed");
  await page.waitForTimeout(4500);
  if ((await dbg("pollen")).gain < 0.5) fail("demoed pollen must reach daylight gain");
  else ok("demo(pollen): world -> Day + Clear, pollen up, episodes quiet");
  // Clicking the real button advances the ring and prints its state.
  const label = await page.evaluate(() => {
    document.querySelector(".ml-ambient-btn").click();
    return document.querySelector(".ml-ambient-btn").textContent;
  });
  if (label !== "ambient: bats") fail(`button click must advance pollen -> bats (got ${JSON.stringify(label)})`);
  else ok("button click advances the ring (pollen -> bats)");
  // Back to auto: pin released, director rolls for the current window.
  await page.evaluate(() => window.__mlAmbient.demo(null));
  const dirAuto = await page.evaluate(() => window.__mlAmbient.director());
  if (dirAuto.pinned !== null) fail(`demo(null) must release the pin (got ${JSON.stringify(dirAuto)})`);
  else ok("demo(null) returns to auto");

  if (!failed) console.log("AMBIENT OK");
} finally {
  await browser.close();
}
