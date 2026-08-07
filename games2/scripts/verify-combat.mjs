// COMBAT browser gate — the glue only (the combat LOGIC is proven headlessly
// in server/test/combat.test.ts at real speed; this proves the rendering):
// engage -> kick/punch clips alternate -> the monster's attack/angry clips play
// -> hp bar appears -> die clip -> corpse gone -> loot on the ground -> pickup
// via the probe -> the backpack DOM shows the item. Runs on monster_demo
// (one pad per kind next to spawn) against the dev stack (npm run dev).
// Small viewport per the headless-GL starvation rule.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const fail = (m) => {
  throw new Error(m);
};
const ok = (m) => console.log(`ok - ${m}`);

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

  // HUD bars carry the SERVER stats (placeholder era over).
  await page.waitForFunction(
    () => {
      const c = window.__ml.combat();
      return c.hp === 40 && c.hpMax === 40 && c.level === 1;
    },
    { timeout: 8000 },
  );
  const hpText = await page.evaluate(() => document.querySelectorAll(".ml-bar-num")[0]?.textContent);
  if (!/40\s*\/\s*40/.test(hpText || "")) fail(`hp bar shows "${hpText}" (want 40 / 40)`);
  ok("hp bar wired to server state");

  // Deferred combat strips: wait for a monster attack anim to be REGISTERED
  // (background batch + the buildMonsterAnimations re-run).
  await page.waitForFunction(() => window.__ml.monsterAnimReady?.("mystical_frog"), { timeout: 45000 });
  ok("deferred attack/angry/die clips registered");

  // Fight a frog: teleport into reach and engage through the probe (the same
  // path a tap takes). Track it until the first swing lands.
  const frog = await page.evaluate(() => {
    const me = window.__ml.me();
    return window.__ml.monsterAt(me.x, me.y); // nearest — pads ring the spawn
  });
  const frogPick = await page.evaluate(() => {
    // find the frog specifically: its pad is one of the nearest
    const st = window.__ml;
    const mine = st.me();
    let best = null;
    for (const m of st.monsterInfo()) {
      if (m.kind !== "mystical_frog") continue;
      const d = Math.hypot(m.x - mine.x, m.y - mine.y);
      if (!best || d < best.d) best = { id: m.id, d };
    }
    return best;
  });
  if (!frogPick) fail("no mystical_frog in monster_demo");

  // ROUND 2 overlays: park at a FIXED offset from the frog — on-screen (the
  // icon and bar hide for culled monsters) but outside battle range (the
  // icon hides once the fight begins). Engaging from wherever the frog
  // happened to roam flaked both ways. The sword marker must hang over the
  // walk-to target; the slim bar shows "Lv N" + "hp/max" for the engaged
  // target.
  // Park OUTSIDE the provoke radius (128wu): a marked frog inside it charges
  // and the walk-to window can close between polls.
  await page.evaluate((fid) => {
    const st = window.__ml;
    const f = st.monsterInfo().find((m) => m.id === fid);
    st.teleport(Math.round((f.x + 200) / 32), Math.round((f.y + 90) / 32));
  }, frogPick.id);
  await page.waitForTimeout(250);
  await page.evaluate((fid) => window.__ml.engage(fid), frogPick.id);
  await page.waitForFunction(
    () => {
      const t = window.__ml.targetOverlay();
      return t.icon === true && t.beacon === false;
    },
    undefined,
    { timeout: 8000, polling: 150 },
  );
  const ringTint = await page.evaluate(() => window.__ml.targetOverlay().ringTint);
  if (ringTint !== 0x8e2222) fail(`target border tint is ${ringTint?.toString(16)} (want 8e2222)`);
  ok("dark-red target border on the marked monster, no walk-to beacon");
  await page.waitForFunction(
    (fid) => {
      const f = window.__ml.monsterInfo().find((m) => m.id === fid);
      return !!f && typeof f.hpBarText === "string" && /^Lv \d+\|\d+\/\d+$/.test(f.hpBarText);
    },
    frogPick.id,
    { timeout: 10000, polling: 150 },
  );
  const barText = await page.evaluate(
    (fid) => window.__ml.monsterInfo().find((m) => m.id === fid)?.hpBarText,
    frogPick.id,
  );
  ok(`monster fight bar reads "${barText}" (level + X/X)`);
  // THREE LINES (maintainer 2026-08-05): the NAME left-aligned OVER the bar,
  // then the bar, then "Lv N" left-aligned and "hp/max" right-aligned UNDER
  // it. All three hang off the bar's own edges.
  const ro = await page.evaluate(
    (fid) => window.__ml.monsterInfo().find((m) => m.id === fid)?.readout,
    frogPick.id,
  );
  if (!ro) fail("no three-line readout on the engaged monster");
  else {
    const [barX, barY, barW] = ro.bar;
    const left = barX - barW / 2;
    const right = barX + barW / 2;
    ro.name[0] && ro.name[0] !== "mystical_frog" && Math.abs(ro.name[1] - left) <= 1 && ro.name[2] < barY
      ? ok(`monster NAME "${ro.name[0]}" left-aligned over the bar (the roster's display name, not the id)`)
      : fail(`name line wrong: ${JSON.stringify(ro.name)} vs bar ${JSON.stringify(ro.bar)}`);
    /^Lv \d+$/.test(ro.lv[0]) && Math.abs(ro.lv[1] - left) <= 1 && ro.lv[2] > barY
      ? ok(`"${ro.lv[0]}" left-aligned UNDER the bar`)
      : fail(`level line wrong: ${JSON.stringify(ro.lv)} vs bar ${JSON.stringify(ro.bar)}`);
    /^\d+\/\d+$/.test(ro.hp[0]) && Math.abs(ro.hp[1] - right) <= 1 && ro.hp[2] > barY
      ? ok(`"${ro.hp[0]}" right-aligned UNDER the bar, on the level's line`)
      : fail(`hp line wrong: ${JSON.stringify(ro.hp)} vs bar ${JSON.stringify(ro.bar)}`);
    ro.lv[2] === ro.hp[2]
      ? ok("…level and hp share one line")
      : fail(`level y ${ro.lv[2]} != hp y ${ro.hp[2]}`);
  }
  // The aggro-radius debug toggle flips through the settings probe.
  const rings = await page.evaluate(() => {
    const on = window.__ml.toggleAggroRadius(true);
    const shown = window.__ml.targetOverlay().aggroRings;
    window.__ml.toggleAggroRadius(false);
    return { on, shown, off: window.__ml.targetOverlay().aggroRings };
  });
  if (!(rings.on && rings.shown && !rings.off)) fail(`aggro ring toggle broken: ${JSON.stringify(rings)}`);
  ok("aggro-radius debug toggle flips");

  const clips = new Set();
  let monsterCombatClipSeen = false;
  let hpBarSeen = false;
  let borderInCombatSeen = false;
  let borderLostInCombat = false;
  const t0 = Date.now();
  let killed = false;
  while (Date.now() - t0 < 40000) {
    const s = await page.evaluate((fid) => {
      const st = window.__ml;
      const mons = st.monsterInfo();
      const f = mons.find((m) => m.id === fid);
      if (f) {
        st.teleport(Math.round(f.x / 32), Math.round(f.y / 32));
        st.engage(fid);
      }
      return {
        frog: f ? { hp: f.hp, mstate: f.mstate, anim: f.anim, hpBar: f.hpBar, culled: f.culled } : null,
        myAnim: st.myAnim ? st.myAnim() : "",
        overlayIcon: st.targetOverlay().icon,
      };
    }, frogPick.id);
    if (!s.frog) {
      killed = true;
      break;
    }
    if (/kick|punch/.test(s.myAnim)) clips.add(/kick/.test(s.myAnim) ? "kick" : "punch");
    if (s.frog.anim && /attack|angry/.test(s.frog.anim)) monsterCombatClipSeen = true;
    if (s.frog.hpBar) hpBarSeen = true;
    // Round 11: the red border stays up for the ENTIRE fight.
    if (s.frog.mstate === "combat" && !s.frog.culled) {
      if (s.overlayIcon) borderInCombatSeen = true;
      else borderLostInCombat = true;
    }
    await page.waitForTimeout(180);
  }
  if (!killed) fail("frog never died (40s)");
  ok("engaged and killed a frog");
  if (!borderInCombatSeen) fail("red border never seen during combat");
  if (borderLostInCombat) fail("red border dropped out mid-combat (must persist the whole fight)");
  ok("red border persisted through the whole fight");
  const blood = await page.evaluate(() => window.__ml.bloodFx());
  if (!(blood >= 1)) fail(`no blood spatter played during the fight (count ${blood})`);
  ok(`blood spatters played (${blood})`);
  const afterKill = await page.evaluate(() => window.__ml.targetOverlay());
  if (afterKill.icon) fail(`target border must clear after the kill: ${JSON.stringify(afterKill)}`);
  ok("target border clears when the fight ends");

  // The grave cross rises where it fell: appears after the corpse fade, plays
  // the 16-frame SOUTH clip once and HOLDS on the last frame.
  await page.waitForFunction(() => window.__ml.graveCrosses().length >= 1, undefined, { timeout: 8000, polling: 200 });
  await page.waitForFunction(
    () => window.__ml.graveCrosses().some((g) => String(g.frame) === "15" && !g.playing && !g.reversing),
    undefined,
    { timeout: 6000, polling: 200 },
  );
  ok("grave cross rose from the ground and holds its last frame");
  if (clips.size === 0) fail("no kick/punch clip ever played on the player");
  ok(`unarmed clips played: ${[...clips].join("+")}`);
  if (!monsterCombatClipSeen) fail("monster attack/angry clip never played");
  ok("monster combat clips played");
  if (!hpBarSeen) fail("monster hp bar never appeared");
  ok("monster hp bar shown while wounded");

  // XP flowed.
  const c1 = await page.evaluate(() => window.__ml.combat());
  if (!(c1.xp > 0 || c1.level > 1)) fail(`no xp after the kill (${JSON.stringify(c1)})`);
  ok(`xp awarded (xp=${c1.xp}, level=${c1.level})`);

  // Loot: monster_demo uses live tuning chances — drops are probabilistic per
  // kill, so grind frogs (they respawn) until one drops or we hit the cap.
  let dropId = null;
  for (let round = 0; round < 10 && !dropId; round++) {
    const drops = await page.evaluate(() => window.__ml.dropsList());
    if (drops.length) {
      dropId = drops[0].id;
      break;
    }
    // kill the (respawned) nearest frog again
    const next = await page.evaluate(() => {
      const st = window.__ml;
      const mine = st.me();
      let best = null;
      for (const m of st.monsterInfo()) {
        if (m.kind === "mystical_frog" && m.mstate !== "die") {
          const d = Math.hypot(m.x - mine.x, m.y - mine.y);
          if (!best || d < best.d) best = { id: m.id, d };
        }
      }
      return best;
    });
    if (!next) {
      await page.waitForTimeout(3000);
      continue;
    }
    const k0 = Date.now();
    while (Date.now() - k0 < 30000) {
      const gone = await page.evaluate((fid) => {
        const st = window.__ml;
        const f = st.monsterInfo().find((m) => m.id === fid);
        if (f) {
          st.teleport(Math.round(f.x / 32), Math.round(f.y / 32));
          st.engage(fid);
        }
        return !f;
      }, next.id);
      if (gone) break;
      await page.waitForTimeout(250);
    }
  }
  if (!dropId) fail("no loot dropped over 10 frog kills (frog tables are 25%+ x2 — astronomically unlucky or broken)");
  ok("loot dropped on the ground");

  // The ITEM BORDER (round 11, replacing the round-8 hand): walking to a
  // targeted item shows the light-light-blue outline on it and NO walk-to
  // beacon. Stand off far enough that the walk-to window stays open, but
  // INSIDE pickupNearest's 5-cell (160wu) "don't sprint across the map for
  // a mis-tap" cap.
  await page.evaluate(() => {
    const st = window.__ml;
    const d = st.dropsList()[0];
    st.teleport(Math.round((d.x + 96) / 32), Math.round((d.y + 32) / 32));
  });
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__ml.pickupNearest());
  await page.waitForFunction(
    () => {
      const t = window.__ml.targetOverlay();
      return t.itemRing === true && t.beacon === false && t.itemRingTint === 0x9adcf0;
    },
    undefined,
    { timeout: 8000, polling: 120 },
  );
  ok("light-blue item border on the fetched item, no walk-to beacon");

  // Pickup: probe = the button path (walk-to + grab). Backpack DOM follows.
  await page.evaluate(() => {
    const st = window.__ml;
    const d = st.dropsList()[0];
    st.teleport(Math.round(d.x / 32), Math.round(d.y / 32));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__ml.pickupNearest());
  await page.waitForFunction(() => window.__ml.inv().length > 0, { timeout: 8000 });
  const inv = await page.evaluate(() => window.__ml.inv());
  ok(`picked up: ${inv[0].item} x${inv[0].n}`);
  const slotInfo = await page.evaluate(() => {
    const cell = document.querySelector(".ml-slot.filled img");
    return cell ? cell.getAttribute("src") : null;
  });
  if (!slotInfo || !slotInfo.includes(inv[0].item)) fail(`backpack DOM shows "${slotInfo}"`);
  ok("backpack DOM renders the item sprite");

  // Drop it back out through the server path; the ground item reappears.
  // Compare IDS, not the count: a drop being picked up now lingers a few
  // hundred ms for its grab frame (round 15), so it can retire in the same
  // window the new one spawns and leave the total unchanged.
  const before = await page.evaluate(() => window.__ml.dropsList().map((d) => d.id));
  await page.evaluate(() => window.__ml.roomSend?.("drop", { slot: 0 }));
  await page.waitForFunction(
    (ids) => window.__ml.dropsList().some((d) => !ids.includes(d.id)),
    before,
    { timeout: 6000 },
  );
  ok("backpack drop-out spawns a ground item");

  console.log("\nverify-combat: ALL OK");
} finally {
  await browser.close();
}
