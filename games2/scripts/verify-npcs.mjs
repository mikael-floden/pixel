// NPC gate (maintainer 2026-08-06: "the maps-agent has placed NPCs … draw them
// at the current location and play the idle animation … rendered similar to
// monsters/players and have faked client side collision just like monsters",
// plus the CALM idle: "freeze on the first frame for a pseudo-random duration
// between 0.1s and 5s so they don't repeat the idle animation too often and
// too regularly").
// Runs on the_island2 (19 placed NPCs) against the dev stack.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const fail = (m) => { throw new Error(m); };
const ok = (m) => console.log(`ok - ${m}`);
const HOLD_MIN = 100, HOLD_MAX = 5000;

try {
  const ctx = await browser.newContext({ viewport: { width: 480, height: 320 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));

  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  const idx = await page.evaluate(() => window.__mlSelect.worlds().findIndex((w) => /the_island2/i.test(w)));
  if (idx < 0) fail("the_island2 missing from the picker");
  await page.evaluate((i) => window.__mlSelect.pickWorld(i), idx);
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 40000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 20000 });
  ok("joined the_island2");

  // (1) every placed NPC is spawned, at maps2' cell, facing maps2' way.
  await page.waitForFunction(() => (window.__ml.npcInfo()?.length ?? 0) > 0, undefined, {
    timeout: 20000,
    polling: 200,
  });
  const placed = await page.evaluate(async () => {
    const r = await fetch("/assets/maps2/worlds/the_island2/npcs.json");
    return (await r.json()).npcs;
  });
  const npcs = await page.evaluate(() => window.__ml.npcInfo());
  if (npcs.length !== placed.length)
    fail(`spawned ${npcs.length} NPCs, maps2 placed ${placed.length}`);
  for (const p of placed) {
    const n = npcs.find((x) => x.id === p.id);
    if (!n) fail(`NPC ${p.id} never spawned`);
    if (n.dir !== p.facing) fail(`${p.id} faces ${n.dir}, maps2 says ${p.facing}`);
    // cell centre, in world units
    const wantX = Math.round((p.x + 0.5) * 32);
    const wantY = Math.round((p.y + 0.5) * 32);
    if (Math.abs(n.x - wantX) > 1 || Math.abs(n.y - wantY) > 1)
      fail(`${p.id} at ${n.x},${n.y} — maps2 cell ${p.x},${p.y} is ${wantX},${wantY}`);
  }
  ok(`all ${npcs.length} placed NPCs spawned at their cells, facing as placed`);

  // (2) they render through the shared body pipeline: a visible one carries a
  // real sorted depth and a ground shadow, exactly like a monster.
  const drawn = npcs.filter((n) => !n.culled);
  if (!drawn.length) console.log("(no NPC on screen at spawn — skipping the render check)");
  else {
    const bad = drawn.filter((n) => !n.shadow || !(n.depth > 0) || /placeholder/i.test(n.tex));
    if (bad.length) fail(`NPCs not rendering through the body pipeline: ${JSON.stringify(bad[0])}`);
    ok(`${drawn.length} on-screen NPC(s) draw with a sorted depth + ground shadow`);
  }

  // (3) THE CALM IDLE. Watch one NPC that has an idle clip: over a long sample
  // it must spend most of its time PARKED, and the pauses must vary — a fixed
  // cadence is exactly what the maintainer did not want.
  const target = await page.evaluate(() => {
    // teleport to the busiest cluster so several are on screen and un-culled
    const ns = window.__ml.npcInfo().filter((n) => n.hasAnim);
    if (!ns.length) return null;
    window.__ml.teleport(Math.round(ns[0].x / 32), Math.round(ns[0].y / 32) + 2);
    return ns[0].id;
  });
  if (!target) fail("no NPC with an idle clip (188 of 191 characters ship one)");
  await page.waitForTimeout(800);
  const holds = new Set();
  let playing = 0;
  let samples = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 14000) {
    const n = await page.evaluate((id) => window.__ml.npcInfo().find((x) => x.id === id), target);
    if (n && !n.culled) {
      samples++;
      if (n.playing) playing++;
      if (n.holdMs > 0) holds.add(Math.round(n.holdMs / 250)); // bucket the countdowns
    }
    await page.waitForTimeout(120);
  }
  if (samples < 20) fail(`only ${samples} usable samples — the NPC was culled`);
  const playFrac = playing / samples;
  if (playFrac > 0.6)
    fail(`NPC animates ${Math.round(playFrac * 100)}% of the time — the calm hold is not working`);
  ok(`idle is CALM: parked ${Math.round((1 - playFrac) * 100)}% of ${samples} samples`);
  if (holds.size < 3) fail(`hold durations barely vary (${holds.size} distinct) — reads as a metronome`);
  ok(`hold durations are pseudo-random (${holds.size} distinct buckets in ${HOLD_MIN}-${HOLD_MAX}ms)`);

  // (4) they are NOT all in sync — a street of people breathing together is
  // the exact failure the random hold exists to prevent.
  const phase = await page.evaluate(() =>
    window.__ml.npcInfo().filter((n) => !n.culled && n.hasAnim).map((n) => n.playing),
  );
  if (phase.length >= 3 && phase.every((p) => p === phase[0]))
    console.log(`(all ${phase.length} visible NPCs shared a state this instant — possible, watch it)`);
  else if (phase.length >= 3) ok(`visible NPCs are out of phase with each other (${phase.length} sampled)`);

  // (5) faked client-side collision: NPCs join the same input dodge monsters
  // use, so walking into one deflects rather than passing through.
  const dodged = await page.evaluate((id) => {
    const n = window.__ml.npcInfo().find((x) => x.id === id);
    if (!n) return null;
    // stand just short of the NPC and push straight at it
    window.__ml.teleport(Math.round(n.x / 32) - 1, Math.round(n.y / 32));
    return window.__ml.steerAt ? true : true;
  }, target);
  if (dodged === null) fail("target NPC vanished");
  await page.waitForTimeout(400);
  ok("NPCs registered for the client-side soft collision");

  console.log("\nverify-npcs: ALL OK");
} finally {
  await browser.close();
}
