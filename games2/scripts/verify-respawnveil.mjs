// THE RELOCATION VEIL — a respawn goes through the loading screen, not an
// instant snap (maintainer 2026-09-19: "When a player sees the inside tricks
// the engine uses the entire illusion disappears!").
//
// Against the dev stack (npm run dev; PORT overrides vite's port), headless:
//   1. a plain __ml.teleport raises NO veil (every gate teleports and
//      screenshots — a black overlay in those frames would be a false red);
//   2. __ml.respawn() — the dev button's path — raises the veil at once, the
//      body moves only once the black is up, the veil stays up while the
//      hold's inputs are false, and it comes down on "ready", never on a
//      deadline; the body ends somewhere else;
//   3. a REAL death far from the spawn (dbgkill runs hurtPlayer's kill branch)
//      and the "Press to continue..." tap: the same veil, the ask after the
//      black, the revive under it, the death nodes gone after;
//   4. a living respawn AT the spawn — the body does not move, so no snap can
//      come: the arrival is the grace, and the veil lifts on "ready" long
//      before the no-answer backstop.
// Numbers here are the harness's (software GL); the shape is the gate.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = process.env.PORT || "5173";
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const FAR = { col: 256, row: 288 }; // grass, 92 cells from the spawn (333,237): the new window has to stream

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 500, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror", e.message));
const warns = [];
page.on("console", (m) => { if (m.type() === "warning" && /relocation veil/.test(m.text())) warns.push(m.text()); });
await page.goto(`http://localhost:${PORT}/#the_game`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 120000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 120000 });
await page.evaluate(() => window.__ml.noAggro?.(true));

// 1. A plain teleport: no veil, ever.
const far = await page.evaluate((f) => window.__ml.teleport(f.col, f.row), FAR);
console.log("teleported to", far);
let veilSeen = false;
for (let i = 0; i < 80; i++) { // 8 s: the window streams in without a veil
  if (await page.evaluate(() => !!document.getElementById("ml-loading"))) veilSeen = true;
  await page.waitForTimeout(100);
}
if (veilSeen) fail("a plain __ml.teleport raised the veil — gates teleport and screenshot; the veil is opt-in there");
const before = await page.evaluate(() => { const m = window.__ml.me(); return m ? { x: m.x, y: m.y } : null; });
if (!before) fail("no player state for me");

const me = () => page.evaluate(() => { const m = window.__ml.me(); return m ? { x: m.x, y: m.y, dead: !!m.dead } : null; });
/** Sample the veil, my body and the relocation state until the last one lifts;
 *  then wait out the cinema. Returns what every phase asserts on. */
async function watch(label, t0) {
  const samples = [];
  let lifted = null;
  for (let i = 0; i < 700 && !lifted; i++) { // up to 35 s
    const s = await page.evaluate(() => {
      const m = window.__ml.me();
      const rel = window.__ml.relocate();
      return { t: performance.now(), veil: !!document.getElementById("ml-loading"), x: m?.x, y: m?.y, rel };
    });
    samples.push(s);
    if (s.rel.last && s.rel.last.askedAt >= t0 && !s.rel.active) lifted = s.rel.last;
    await page.waitForTimeout(50);
  }
  // THE CINEMA OUT: the logo fades, the black holds six REAL frames and 700
  // ms, then fades — six frames of software GL can be many seconds, so poll.
  let veilAfter = true;
  for (let i = 0; i < 300 && veilAfter; i++) {
    veilAfter = await page.evaluate(() => !!document.getElementById("ml-loading"));
    if (veilAfter) await page.waitForTimeout(100);
  }
  if (!lifted) { fail(`${label}: the veil never came down inside 35 s`); return null; }
  const firstVeil = samples.find((s) => s.veil);
  if (!firstVeil) fail(`${label}: the veil was never seen up`);
  if (lifted.why !== "ready") {
    const lastActive = [...samples].reverse().find((s) => s.rel.active)?.rel.active;
    fail(`${label}: the veil came down on "${lifted.why}", not on ready — the hold never settled (${warns.join(" | ")}); last inputs ${JSON.stringify(lastActive)}`);
  }
  // While the hold's inputs were false after the arrival, the veil was up — the whole point.
  const unready = samples.filter((s) => s.rel.active && s.rel.active.arrivedAt && !s.rel.active.ready);
  const unveiled = unready.filter((s) => !s.veil);
  if (unveiled.length) fail(`${label}: ${unveiled.length} sample(s) showed the world while the hold's inputs were false`);
  // The veil was continuous from the press to the lift.
  const gap = samples.find((s) => s.t >= (firstVeil?.t ?? 0) && s.t <= lifted.liftedAt && !s.veil);
  if (gap) fail(`${label}: the veil dropped mid-hold at +${Math.round(gap.t - t0)} ms`);
  if (veilAfter) fail(`${label}: the veil is still up 30 s after the lift — the cinema out did not run`);
  console.log(
    `${label}: up at the press (first seen ${Math.round((firstVeil?.t ?? 0) - t0)} ms after), the answer at +${Math.round(lifted.arrivedAt - lifted.askedAt)} ms` +
      ` (${lifted.snapped ? "a snap" : "no snap"}), ${unready.length} not-ready samples after it (all veiled), lifted on "${lifted.why}" after ${Math.round(lifted.liftedAt - lifted.askedAt)} ms, ${samples.length} samples`,
  );
  return { lifted, samples, unready };
}

// 2. The living respawn, far from the spawn: the dev button's path.
let t0 = await page.evaluate(() => performance.now());
const r0 = await page.evaluate(() => window.__ml.respawn());
if (!r0.veil) fail(`__ml.respawn() did not raise the veil: ${JSON.stringify(r0)}`);
const w2 = await watch("living respawn", t0);
if (w2) {
  if (!w2.lifted.snapped) fail("the living respawn from the far spot was not marked by a snap");
  else if (w2.lifted.arrivedAt - w2.lifted.askedAt < 400) fail(`the body moved ${Math.round(w2.lifted.arrivedAt - w2.lifted.askedAt)} ms after the press — under a half-faded screen`);
  if (!w2.unready.length) console.log("note: no sample after the arrival read not-ready (the new window was already resident)");
  const after = await me();
  if (before && after && Math.hypot(after.x - before.x, after.y - before.y) < 1000) fail(`the body did not move from the far spot: ${JSON.stringify({ before, after })}`);
}

// 3. A REAL DEATH far from the spawn, and the "Press to continue..." tap.
await page.evaluate((f) => window.__ml.teleport(f.col, f.row), FAR);
await page.waitForTimeout(6000);
const deadAt = await me();
await page.evaluate(() => window.__ml.roomSend("dbgkill", {}));
await page.waitForFunction(() => window.__ml.deathInfo() !== null, null, { timeout: 15000 }).catch(() => fail("the death sequence never started"));
await page.waitForFunction(() => window.__ml.deathInfo()?.armed === true, null, { timeout: 40000 }).catch(() => fail("the prompt never armed"));
t0 = await page.evaluate(() => performance.now());
await page.mouse.click(250, 450); // the game view: the dead branch of pointerdown is the press
await page.waitForFunction(() => window.__ml.deathInfo()?.asked === true, null, { timeout: 4000 }).catch(() => fail("the press did not register as an ask"));
const upOnPress = await page.evaluate(() => !!document.getElementById("ml-loading") && window.__ml.relocate().active?.kind === "death");
if (!upOnPress) fail("the death press did not raise the veil");
const w3 = await watch("death press", t0);
if (w3) {
  if (w3.lifted.arrivedAt - w3.lifted.askedAt < 400) fail(`the revive landed ${Math.round(w3.lifted.arrivedAt - w3.lifted.askedAt)} ms after the press — under a half-faded screen`);
  const alive = await me();
  if (!alive || alive.dead) fail("still dead after the veil lifted");
  if (deadAt && alive && Math.hypot(alive.x - deadAt.x, alive.y - deadAt.y) < 1000) fail("the body did not come back to the spawn");
  const strays = await page.evaluate(() => document.querySelectorAll(".ml-death-card, .ml-death-veil").length + (window.__ml.deathInfo() ? 1 : 0));
  if (strays) fail(`${strays} death node(s)/state left after the revive`);
}

// 4. A living respawn AT the spawn: nothing to move, so the grace is the answer.
t0 = await page.evaluate(() => performance.now());
const r4 = await page.evaluate(() => window.__ml.respawn());
if (!r4.veil) fail(`the second __ml.respawn() did not raise the veil: ${JSON.stringify(r4)}`);
const w4 = await watch("respawn at the spawn", t0);
if (w4) {
  // placeAtSpawn may still pick a spawn cell a few cells off (a snap, a
  // SCROLLED ground rather than a full paint) or the very cell we stand on
  // (no snap: the grace answers). Both must lift on "ready" — `watch` asserts
  // that — and the answer must come inside the grace either way.
  if (w4.lifted.arrivedAt - w4.lifted.askedAt > 2500) fail(`the answer took ${Math.round(w4.lifted.arrivedAt - w4.lifted.askedAt)} ms — past the grace`);
  console.log(w4.lifted.snapped ? "note: the spawn placement snapped the body a few cells (a scrolled ground)" : "note: no snap — the grace answered");
}
await browser.close();
if (!process.exitCode) console.log("ALL OK");
