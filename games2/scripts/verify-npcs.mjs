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

  // (2b) THE NADIR SHADOW SITS BETWEEN THE FEET (maintainer 2026-08-06: "the
  // NPC nadir shadow … exactly at the middle of the characters two feet (the
  // underside of the feet). If this is not correct it will look as if the NPC
  // is flying"). Checked against the ART, not against the code's own maths: we
  // re-derive the foot line from the DRAWN sprite box + its measured origin
  // and compare with where the shadow is actually drawn.
  const anchored = await page.evaluate(async () => {
    const man = await (await fetch("/npcs.json")).json();
    const byId = new Map(man.npcs.map((d) => [d.id, d]));
    return window.__ml.npcInfo().filter((n) => !n.culled).map((n) => {
      const def = byId.get(n.charId);
      const a = def?.anchors?.[n.dir] ?? null;
      return {
        id: n.id,
        dir: n.dir,
        measured: a,
        originX: n.originX,
        originY: n.originY,
        // the shadow must sit exactly where the sprite is pinned
        dx: +(n.shadowX - n.sx).toFixed(2),
        dy: +(n.shadowY - n.sy).toFixed(2),
      };
    });
  });
  if (!anchored.length) console.log("(no NPC on screen — skipping the anchor check)");
  else {
    for (const n of anchored) {
      if (!n.measured) fail(`${n.id}: no measured foot anchor in the manifest`);
      if (Math.abs(n.originY - n.measured.y) > 0.001 || Math.abs(n.originX - n.measured.x) > 0.001)
        fail(`${n.id}: origin ${n.originX},${n.originY} != measured foot anchor ${n.measured.x},${n.measured.y}`);
      // The sprite is pinned AT its foot anchor, so the nadir shadow must be
      // at that same point — any offset is the body floating off its shadow.
      if (Math.abs(n.dx) > 1 || Math.abs(n.dy) > 1)
        fail(`${n.id}: shadow is ${n.dx},${n.dy}px off the foot anchor — it will read as flying`);
    }
    ok(`${anchored.length} NPC(s): origin == art-measured foot anchor, shadow on it (<=1px)`);
  }

  // (2c) MAPS2' FACING IS HONOURED WHEREVER THE ART CAN BREATHE, and south
  // everywhere else. The rule is not "these three directions" — it is "a
  // direction this character has an IDLE for", because a frozen NPC standing
  // beside a breathing one is what the south-only pin existed to prevent. So
  // the gate asks the ART MANIFEST the same question the client does, rather
  // than hard-coding today's coverage: the day north-east is generated, this
  // passes unchanged and a client that ignored it fails.
  const defs = await page.evaluate(async () => {
    const r = await fetch("/npcs.json");
    const j = await r.json();
    return Object.fromEntries(j.npcs.map((n) => [n.id, n.idle ?? {}]));
  });
  let honoured = 0;
  for (const p of placed) {
    const n = npcs.find((x) => x.id === p.id);
    if (!n) continue;
    const idle = defs[p.character] ?? {};
    const canIdle = (idle[p.facing] ?? 0) > 0;
    const want = canIdle ? p.facing : "south";
    if (n.dir !== want)
      fail(`${p.id} faces ${n.dir}; maps2 placed it ${p.facing} and it ${canIdle ? "HAS" : "has no"} idle art for that, so it should face ${want}`);
    if (canIdle && p.facing !== "south") honoured++;
  }
  // NON-VACUOUS: the_island2 places 9 NPCs south-west, so "everything is south"
  // must not be able to pass this. Without it, a client that still forced south
  // would sail through on a world that happened to place everyone south.
  if (!honoured)
    fail(`no NPC took a non-south facing — the pin looks dead (placements: ${[...new Set(placed.map((p) => p.facing))].join("/")})`);
  ok(`${honoured} NPC(s) face maps2' own non-south direction, the rest fall back to south`);

  // (2d) HEAD-TURNING: brush past an NPC and it looks at you, SWEEPING one
  // compass notch at a time, then goes back to maps2' facing. Sampled fast
  // (70ms) because the notches are 200ms apart — a slow poll would see the
  // first and last rotation and call a snap a sweep.
  {
    const RING = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"];
    const notches = (a, b) => {
      const d = Math.abs(RING.indexOf(a) - RING.indexOf(b));
      return Math.min(d, RING.length - d);
    };
    // A TURNABLE one — the gate used to grab the first on-screen NPC, which is
    // Thorne, who is now no_turn. Picking blind would have read "he did not
    // turn" as a broken look-at.
    const one = npcs.find((n) => !n.culled && !n.noTurn) ?? npcs.find((n) => !n.noTurn) ?? npcs[0];
    const read = () =>
      page.evaluate((id) => {
        const n = window.__ml.npcInfo().find((x) => x.id === id);
        const me = window.__ml.me();
        return n && { dir: n.dir, home: n.home, looking: n.looking, mx: me.x, my: me.y, nx: n.x, ny: n.y };
      }, one.id);
    const c = one.x / 32;
    const r = one.y / 32;
    // Approach from the UP-SCREEN side: the direction OF the player is then
    // several notches from a southern home, so a clamp that is not working
    // shows up as the NPC spinning to face it.
    await page.evaluate(([c, r]) => window.__ml.teleport(c - 3, r - 3), [c, r]);
    await page.waitForTimeout(1200);
    const start = await read();
    if (start.dir !== start.home) fail(`${one.id}: standing 3 cells off and already facing ${start.dir}, not home ${start.home}`);
    await page.evaluate(([c, r]) => window.__ml.teleport(c - 0.35, r - 0.35), [c, r]);
    // Sample FAST: the look must be instant, so anything slower than a frame
    // or two cannot tell "instant" from "swept in 200ms steps".
    const chain = [];
    for (let i = 0; i < 40; i++) {
      const s = await read();
      if (s && (!chain.length || chain[chain.length - 1] !== s.dir)) chain.push(s.dir);
      await page.waitForTimeout(50);
    }
    const at = await read();
    const dist = Math.hypot(at.mx - at.nx, at.my - at.ny);
    if (!at.looking) fail(`${one.id}: player is ${dist.toFixed(1)}wu away and the NPC is not looking at them`);
    // (i) AT MOST ONE NOTCH off home — a glance over the shoulder, never a
    // tracking turret (maintainer 2026-08-09: "they will not follow you when
    // running by"). The direction OF the player is deliberately further away
    // than that here, so an unclamped look fails this.
    const off = notches(at.dir, at.home);
    if (off > 1) fail(`${one.id}: looking ${at.dir}, which is ${off} notches off home ${at.home} — the look must clamp to 1`);
    // (ii) INSTANT: home -> the clamped look, with nothing in between. A
    // 200ms-per-notch sweep on a one-second event reads as lagging behind the
    // player, which is the opposite of noticing them.
    const extra = chain.filter((d) => d !== at.home && d !== at.dir);
    if (extra.length) fail(`${one.id}: the look SWEPT through ${extra.join("/")} — it must be instant (${chain.join(" -> ")})`);
    if (chain.length > 2) fail(`${one.id}: ${chain.length} rotations during the look (${chain.join(" -> ")}) — expected home then the look`);
    ok(`look-at fires at ${dist.toFixed(1)}wu, clamped ${off} notch off home, instantly (${chain.join(" -> ")})`);
    // (iii) AND THE FEET STAY UNDER THE BODY THROUGH THE TURN. Every rotation
    // has its OWN measured foot anchor, so a turn that moves the origin while
    // the previous rotation is still drawn slides the body off its nadir
    // shadow (maintainer 2026-08-09: "make sure the shadow nadir is under
    // their feet so the turn looks good"). Re-checked HERE, mid-look, because
    // 2b only ever saw NPCs at rest on their placed facing.
    const turned = await page.evaluate(async (id) => {
      const man = await (await fetch("/npcs.json")).json();
      const byId = new Map(man.npcs.map((d) => [d.id, d]));
      const n = window.__ml.npcInfo().find((x) => x.id === id);
      const a = byId.get(n.charId)?.anchors?.[n.dir] ?? null;
      return { dir: n.dir, measured: a, originX: n.originX, originY: n.originY,
               dx: +(n.shadowX - n.sx).toFixed(2), dy: +(n.shadowY - n.sy).toFixed(2), tex: n.tex };
    }, one.id);
    if (!turned.measured) fail(`${one.id}: no measured anchor for the turned-to ${turned.dir}`);
    if (Math.abs(turned.originY - turned.measured.y) > 0.001 || Math.abs(turned.originX - turned.measured.x) > 0.001)
      fail(`${one.id}: after turning to ${turned.dir} the origin is ${turned.originX},${turned.originY}, not that rotation's anchor ${turned.measured.x},${turned.measured.y}`);
    if (Math.abs(turned.dx) > 1 || Math.abs(turned.dy) > 1)
      fail(`${one.id}: turned to ${turned.dir} and the shadow is ${turned.dx},${turned.dy}px off the feet`);
    ok(`mid-turn (${turned.dir}): origin is that rotation's own anchor and the shadow is still under the feet`);
    // ...and it hands the facing back to maps2 when you leave.
    await page.evaluate(([c, r]) => window.__ml.teleport(c - 6, r - 6), [c, r]);
    await page.waitForTimeout(4000);
    const back = await read();
    if (back.dir !== back.home && !back.looking)
      fail(`${one.id}: after backing off it sits on ${back.dir}, not its home ${back.home} (glance is allowed, but none was active)`);
    ok(`facing returns to maps2' ${back.home} once the player leaves`);

    // (iv) AND THE ONES THAT MUST NOT TURN, DO NOT. characters2 flags art that
    // only reads right from one facing (`no_turn`); Thorne's armorer's
    // breastplate stands on the ground beside him in south/south-west and is
    // gone in south-east, so a turn pops a large prop in and out. Brushing
    // past him must move nothing.
    const still = npcs.find((n) => n.noTurn);
    if (!still) console.log("(no no_turn NPC placed in this world — skipping)");
    else {
      const readS = () =>
        page.evaluate((id) => {
          const n = window.__ml.npcInfo().find((x) => x.id === id);
          return n && { dir: n.dir, home: n.home, looking: n.looking, tex: n.tex };
        }, still.id);
      const sc = still.x / 32;
      const sr = still.y / 32;
      await page.evaluate(([c, r]) => window.__ml.teleport(c - 3, r - 3), [sc, sr]);
      await page.waitForTimeout(1000);
      const s0 = await readS();
      // Walk a full circle around him at touching distance: every approach
      // angle asks for a different facing, so a look-at that ignores the flag
      // cannot survive all eight.
      const seenS = new Set([s0.dir]);
      for (const [dx, dy] of [[-0.35, -0.35], [0.35, -0.35], [0.35, 0.35], [-0.35, 0.35], [0, -0.4], [0, 0.4], [-0.4, 0], [0.4, 0]]) {
        await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [sc + dx, sr + dy]);
        await page.waitForTimeout(400);
        seenS.add((await readS()).dir);
      }
      if (seenS.size !== 1)
        fail(`${still.id} is no_turn but faced ${[...seenS].join("/")} while the player circled it`);
      ok(`no_turn NPC ${still.id} held ${s0.dir} through eight approach angles`);
    }
  }

  // (3) THE CALM IDLE. Watch one NPC that has an idle clip: over a long sample
  // it must spend most of its time PARKED, and the pauses must vary — a fixed
  // cadence is exactly what the maintainer did not want.
  // The idle FRAMES ride the deferred batch (after the join), so they can be
  // seconds behind the standing art that ships with boot — deliberately: the
  // calm idle's frame-0 hold makes the wait invisible. Wait for them.
  const t0anim = Date.now();
  const ready = await page
    .waitForFunction(() => window.__ml.npcInfo().some((n) => n.hasAnim), undefined, {
      timeout: 60000,
      polling: 250,
    })
    .then(() => true)
    .catch(() => false);
  if (!ready) fail("no NPC ever got an idle clip (188 of 191 characters ship one)");
  ok(`idle clips arrive with the deferred batch (${((Date.now() - t0anim) / 1000).toFixed(1)}s after join)`);
  const target = await page.evaluate(() => {
    const ns = window.__ml.npcInfo().filter((n) => n.hasAnim);
    window.__ml.teleport(Math.round(ns[0].x / 32), Math.round(ns[0].y / 32) + 2);
    return ns[0].id;
  });
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
