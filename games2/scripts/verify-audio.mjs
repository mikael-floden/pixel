// Composer audio verification: the audio contracts are served, the engine
// boots inside the real client, the catalog loads, one-shots actually play,
// footsteps fire while walking, and the musical clock is sane. Drives the
// REAL client headlessly against a dev stack (npm run dev), with autoplay
// unlocked so the AudioContext can run without a human gesture.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";

const fail = (m) => {
  throw new Error(m);
};

// ---- 1. Contracts + assets are served ----
const sounds = await (await fetch(`${BASE}/assets/sounds/viewer_data.json`)).json();
if (!sounds.sounds?.length) fail("sounds/viewer_data.json empty or unserved");
const bindings = await (await fetch(`${BASE}/assets/sounds/bindings.json`)).json();
if (!bindings.events?.length) fail("sounds/bindings.json empty or unserved");
const music = await (await fetch(`${BASE}/assets/music/viewer_data.json`)).json();
if (!music.tracks?.length) fail("music/viewer_data.json empty or unserved");
const wav = await fetch(`${BASE}/assets/sounds/${sounds.sounds[0].file}`);
if (!wav.ok || !(wav.headers.get("content-type") || "").includes("audio"))
  fail(`sound wav → ${wav.status} ${wav.headers.get("content-type")}`);
console.log(
  `Contracts OK (${sounds.sounds.length} sounds, ${bindings.events.length} bindings, ${music.tracks.length} tracks)`,
);

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 480, height: 320 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|404/.test(m.text())) errors.push(m.text());
  });

  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  // A real gesture so the composer's unlock listener resumes the context.
  await page.mouse.click(240, 160);
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });

  // ---- 2. Engine booted: context running, catalog indexed ----
  await page.waitForFunction(() => {
    const a = window.__ml.audio?.();
    return a && a.context === "running" && a.catalog > 0;
  }, { timeout: 15000 });
  let a = await page.evaluate(() => window.__ml.audio());
  if (a.catalog < 30) fail(`catalog only ${a.catalog} sounds`);
  console.log(`Engine OK (context=${a.context}, catalog=${a.catalog}, buffers warming=${a.buffers})`);

  // ---- 3. One-shots: a semantic event increments the played counter ----
  await page.evaluate(() => window.__ml.audioEvent("ui.confirm"));
  await page.waitForFunction(() => window.__ml.audio().played >= 1, { timeout: 8000 });
  console.log("One-shot OK (ui.confirm played)");

  // ---- 3b. ENFORCE UNMODIFIED AUDIO: engages, still plays, disengages ----
  if (!(await page.evaluate(() => window.__ml.audioPure()))) fail("pure toggle didn't engage");
  const pureBefore = await page.evaluate(() => window.__ml.audio().played);
  await page.evaluate(() => window.__ml.audioEvent("ui.confirm"));
  await page.waitForFunction((n) => window.__ml.audio().played > n, pureBefore, { timeout: 8000 });
  if (await page.evaluate(() => window.__ml.audioPure())) fail("pure toggle didn't disengage");
  console.log("Pure-audio toggle OK (raw playback path works, switch round-trips)");

  // ---- 4. Footsteps: run somewhere, the gait tracker must emit steps ----
  const before = await page.evaluate(() => window.__ml.audio().played);
  await page.evaluate(() => {
    const m = window.__ml.me();
    window.__ml.tapTo(m.x + 220, m.y + 40, true); // run — fastest footfalls
  });
  await page.waitForFunction(
    (n) => window.__ml.audio().played > n + 1,
    before,
    { timeout: 12000 },
  );
  console.log("Footsteps OK (played while moving)");

  // ---- 5. Musical clock: shape is sane; report whether the score is up ----
  const clock = await page.evaluate(() => window.__ml.audioClock());
  if (typeof clock.bpm !== "number" || typeof clock.beatPhase !== "number")
    fail("audioClock() malformed");
  console.log(
    clock.playing
      ? `Music clock OK (bpm=${clock.bpm}, section=${clock.section}, beatPhase=${clock.beatPhase.toFixed(2)})`
      : "Music clock idle (score still streaming — OK for CI)",
  );

  // ---- 6. Ambience: beds have targets after the mood ticks ----
  await page.waitForTimeout(1200);
  a = await page.evaluate(() => window.__ml.audio());
  if (!a.ambience || Object.keys(a.ambience).length === 0)
    fail("no ambience beds targeted after mood tick");
  console.log(`Ambience OK (${Object.keys(a.ambience).join(", ")})`);

  if (errors.length) fail(`console errors:\n${errors.join("\n")}`);
  console.log("verify-audio: ALL OK");
} finally {
  await browser.close();
}
