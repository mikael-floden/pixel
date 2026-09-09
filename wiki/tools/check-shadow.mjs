// ONE SHADOW PER MONSTER — its centre is the position, its size the hit box.
//
// Maintainer, 2026-08-20, replacing the per-facet shadow notes: "Lets say you
// have something long and thin. I can create this shadow in S, N, E and W. But
// not the other monster directions. So what I want is just a single shadow
// size for the entire monster … if I change the size in S animation it will
// change for all directions in all animations. The trick is to rotate the
// shadow around the center using the current monster direction. The goal is to
// get the game to use this shadow and the center of the shadow will be the
// monsters position. The size will be the monsters hit box. This also means
// that in the wiki when I move the shadow what really should happen is the
// monster should move the opposite direction … where the shadow is placed
// vertically has to be the same for the entire monster in all directions and
// animations. We don't want the shadow center to jump around."
//
// Every sentence of that is a check below:
//   1. ONE RECORD — an edit made on idle/south is what walk/east shows.
//   2. THE ANCHOR IS PINNED — the ellipse centre sits at the same canvas point
//      for every direction and every animation; edits move the MONSTER.
//   3. IT ROTATES — by the facing's GROUND angle, and the wiki's JS, this
//      gate's own math and the GAME's shared TS function all agree on the
//      numbers (three implementations, one table).
//   4. IT COMMITS INTO tuning/monsters — the entry the game reads its stats
//      from — and never into the frozen shadow_notes doc.
//   5. Reset drops the record; the readout says tuned/untuned honestly.
//
// Network boundary is faked: /api/wiki/me answers admin, /api/wiki/save is
// captured — nothing here reaches the real live store.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const ROOT = new URL("../../", import.meta.url).pathname;
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const MON = D.domains.monsters.find((m) =>
  m.animations?.idle?.dirs?.south && m.animations?.walk?.dirs?.east
  && Object.keys(m.animations.idle.dirs).length === 8);
console.log(`monster: ${MON.id} (frame ${MON.frameW}x${MON.frameH}, measured shadow ${MON.shadow?.w}x${MON.shadow?.h})`);

// ---- 0. THREE IMPLEMENTATIONS, ONE TABLE -----------------------------------
// The gate's own math, written independently of the page's:
const shared = readFileSync(`${ROOT}games2/shared/src/index.ts`, "utf8");
const ISO_DX = +shared.match(/export const ISO_DX = (\d+)/)[1];
const ISO_DY = +shared.match(/export const ISO_DY = (\d+)/)[1];
ok(D.iso?.dx === ISO_DX && D.iso?.dy === ISO_DY,
  `data.iso carries the game's own projection (${D.iso?.dx}/${D.iso?.dy} vs shared ${ISO_DX}/${ISO_DY})`);
const K = ISO_DY / ISO_DX;
const VEC = { south: [0, 1], "south-west": [-1, 1], west: [-1, 0], "north-west": [-1, -1], north: [0, -1], "north-east": [1, -1], east: [1, 0], "south-east": [1, 1] };
function myEllipse(rx, ry, dir) {
  const [vx, vy] = VEC[dir];
  const a = Math.atan2(vx, vy / K), ryg = ry / K;
  const m00 = Math.cos(a) * rx, m01 = Math.sin(a) * ryg, m10 = -K * Math.sin(a) * rx, m11 = K * Math.cos(a) * ryg;
  const E = (m00 + m11) / 2, F = (m00 - m11) / 2, G = (m10 + m01) / 2, H = (m10 - m01) / 2;
  const Q = Math.hypot(E, H), R = Math.hypot(F, G);
  return { p: Q + R, q: Math.abs(Q - R), theta: (Math.atan2(G, F) + Math.atan2(H, E)) / 2 };
}
// The game's shared TS function, through the game's own toolchain:
const game = JSON.parse(execSync("npx tsx ../wiki/tools/shadow-mirror.mts", { cwd: `${ROOT}games2`, encoding: "utf8" }).trim());
ok(game.iso.dx === ISO_DX && game.iso.dy === ISO_DY, "the mirror ran against the same constants");
let worst = 0;
for (const [rx, ry] of [[25.5, 10], [10, 30], [40, 40], [8, 5]]) {
  for (const dir of Object.keys(VEC)) {
    const a = myEllipse(rx, ry, dir), b = game[`${rx}x${ry}:${dir}`];
    worst = Math.max(worst, Math.abs(a.p - b.p), Math.abs(a.q - b.q), Math.abs(a.theta - b.theta));
  }
}
ok(worst < 0.001, `the GAME's decomposition equals this gate's own math over 32 cases (worst delta ${worst.toFixed(5)})`);
// The one case his request was made of: long and thin, facing a diagonal.
const thin = myEllipse(10, 30, "south-east");
ok(Math.abs(thin.theta) > 0.5 && thin.p > 30,
  `a long-thin monster's SE shadow is genuinely diagonal and longer than its S one (tilt ${(thin.theta * 180 / Math.PI).toFixed(1)}°, ${thin.p.toFixed(1)} vs 30)`);
// …AND TILTED THE RIGHT WAY. This is the check the first ship lacked: all
// three implementations inherited ONE derivation, so they agreed with each
// other while every diagonal shadow lay PERPENDICULAR to the body (maintainer
// 2026-08-20, from his phone: "The shadow is rotating wrong … but correct
// S, E, N, W" — the cardinals tilt 0° or 90° either way and cannot show a
// mirrored sign). So anchor the SIGN to the screen, not to any formula: a
// monster walking south-east moves down-RIGHT, and its long axis must point
// down-right too — major-axis direction (cosθ, sinθ) with both components the
// same sign. North-east must mirror it.
const axDir = (e) => Math.cos(e.theta) * Math.sin(e.theta);
ok(axDir(thin) > 0.01, `the SE long axis points down-right, along the body (θ ${(thin.theta * 180 / Math.PI).toFixed(1)}°)`);
ok(axDir(myEllipse(10, 30, "north-east")) < -0.01, "and the NE long axis mirrors it, down-left/up-right");
ok(axDir(myEllipse(10, 30, "south-west")) < -0.01, "SW mirrors SE");
ok(axDir(myEllipse(10, 30, "north-west")) > 0.01, "and NW mirrors NE");

// ---- the page --------------------------------------------------------------
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const saves = [];
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.route("**/api/wiki/save", (r) => { saves.push(r.request().postDataJSON()); return r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
// Pin the admin's staging root to THIS origin: the upgrade otherwise races off
// to GitHub mid-test and its re-route rebuilds the page under the editor.
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});
await p.goto(`${W}#/monsters/${MON.id}`, { waitUntil: "load" });
await p.waitForTimeout(2400);
await p.evaluate(() => [...document.querySelectorAll(".player-controls button")].find((x) => x.textContent === "⏸")?.click());

const probe = () => p.evaluate(() => window.__wikiShadow ?? null);
const clickDir = (label) => p.evaluate((d) => [...document.querySelectorAll(".dirpad button")].find((x) => x.textContent === d)?.click(), label);
const clickState = (name) => p.evaluate((n) => [...document.querySelectorAll(".player-controls .seg-states button, .seg-states button")].find((x) => x.textContent.toLowerCase().includes(n))?.click(), name);

// ---- 1+2. the editor: one record, pinned anchor, monster moves opposite ----
// Where the anchor lands IN THE VIEWPORT vs the stage's visible centre — the
// number his eye judges. The first cut asserted "anchor at canvas centre",
// which stayed true while an 83px overflow shoved that centre 41px out of
// view (maintainer 2026-08-20: "the shadow doesn't feel centered at all
// horizontally" + a scrollbar in the preview).
const viewState = () => p.evaluate(() => {
  const st = document.querySelector(".player-stage"), cv = st.querySelector("canvas");
  const sr = st.getBoundingClientRect(), cr = cv.getBoundingClientRect();
  const sh = window.__wikiShadow;
  return { anchorViewX: sh ? cr.x + sh.ex : null, stageCenterX: sr.x + sr.width / 2,
    overflowX: st.scrollWidth - st.clientWidth, scrollLeft: st.scrollLeft };
});
const first = await probe();
const v0 = await viewState();
ok(!!first && first.ex === first.W / 2, `the shadow centre sits at the canvas's horizontal centre (${first?.ex} of ${first?.W})`);
ok(v0.overflowX <= 6, `viewing: no real scrollbar (${v0.overflowX}px over — the stage's own padding at most)`);
ok(Math.abs(v0.anchorViewX - v0.stageCenterX) <= 3,
  `and the shadow sits at the VISIBLE centre (${Math.round(v0.anchorViewX)} vs ${Math.round(v0.stageCenterX)})`);
// Open the editor and KEEP it open: the boot's staging upgrade re-routes the
// page once, and if that lands between the click and the read the bar is gone.
// Loop until the pad is really on screen.
async function openEditor() {
  for (let i = 0; i < 10; i++) {
    const padBox = await (await p.$(".shadow-pad"))?.boundingBox();
    if (padBox) return padBox;
    await p.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("Edit shadow"));
      if (btn && !btn.classList.contains("on")) btn.click();
      document.querySelector(".shadow-pad")?.scrollIntoView({ block: "center" });
    });
    await p.waitForTimeout(350);
  }
  throw new Error("the shadow editor never opened");
}
let pad = await openEditor();
const before = await probe();
const vE = await viewState();
// The editor adds EDIT_ROOM(12) of travel slack per side; anything past
// ~64px of overflow means the slack regressed toward the 83px scrollbar he
// photographed. Whatever the overflow, the scroll must auto-centre so the
// anchor stays under his eye.
ok(vE.overflowX <= 64 && Math.abs(vE.anchorViewX - vE.stageCenterX) <= 3,
  `…and still does with the editor open — slack bounded, overflow auto-centred (${vE.overflowX}px over, anchor off by ${Math.abs(Math.round(vE.anchorViewX - vE.stageCenterX))}px)`);
await p.evaluate(() => document.querySelector(".shadow-pad")?.scrollIntoView({ block: "center" }));
await p.waitForTimeout(200);
pad = await (await p.$(".shadow-pad")).boundingBox();
await p.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
await p.mouse.down();
for (let i = 1; i <= 6; i++) await p.mouse.move(pad.x + pad.width / 2 + (90 * i) / 6, pad.y + pad.height / 2 + (90 * i) / 6);
// SAMPLE MID-GESTURE, FINGER STILL DOWN: the pinned-ellipse / sliding-monster
// contract holds WHILE he drags (the box is frozen precisely then). The
// release that follows re-hugs the box — asserted separately below.
const after = await probe();
ok(after.rec.edited && after.anchor.ax > before.anchor.ax && after.anchor.ay > before.anchor.ay,
  `the pad writes THIS facet's offset (${before.anchor.ax},${before.anchor.ay} → ${after.anchor.ax},${after.anchor.ay})`);
ok(after.anchor.source === "facet" && after.state === "idle" && after.dir === "south",
  `and it is stored for the facet on screen (${after.state}#${after.dir}, source ${after.anchor.source})`);
ok(after.ex === before.ex && after.ey === before.ey && after.W === before.W && after.H === before.H,
  "mid-drag the ellipse itself does not move — the canvas anchor is pinned");
const dxMoved = before.dx - after.dx, dyMoved = before.dy - after.dy;
ok(Math.abs(dxMoved - (after.anchor.ax - before.anchor.ax) * after.s) <= 1 && dxMoved > 0,
  `dragging the shadow right moves the MONSTER left, exactly (frame slid ${dxMoved}px for ${after.anchor.ax - before.anchor.ax} frame px)`);
ok(Math.abs(dyMoved - (after.anchor.ay - before.anchor.ay) * after.s) <= 1 && dyMoved > 0,
  "…and dragging it down moves the monster up — he tunes the monster around its own position");
await p.mouse.up();
await p.waitForTimeout(400);
const vRel = await viewState();
ok(Math.abs(vRel.anchorViewX - vRel.stageCenterX) <= 3,
  `releasing re-hugs the box and the shadow is back at the visible centre (off by ${Math.abs(Math.round(vRel.anchorViewX - vRel.stageCenterX))}px)`);
// The post-release geometry is the baseline for the facet comparisons below —
// the release re-hugged the box, so mid-drag coordinates no longer apply.
const pS = await probe();

// ---- THE INHERITANCE CHAIN (maintainer 2026-08-20: "The shadow offset is
// per animation and direction"). Only idle#south has been tuned, so:
await clickState("walk");
await p.waitForTimeout(250);
const wS = await probe();
ok(wS.anchor.source === "idle" && Math.abs(wS.anchor.ax - after.anchor.ax) < 0.01,
  `walk·S INHERITS the same direction's idle offset (${wS.anchor.ax},${wS.anchor.ay} via ${wS.anchor.source})`);
await clickState("idle");
await clickDir("E");
await p.waitForTimeout(250);
const iE = await probe();
ok(iE.anchor.source === "default" && Math.abs(iE.anchor.ax - before.anchor.ax) < 0.01,
  `idle·E is untouched — still the measured default (${iE.anchor.source})`);
ok(iE.ex === pS.ex && iE.ey === pS.ey, "…and the canvas anchor STILL has not moved between facets");
// The FRAME is what carries the correction: S (offset) and E (default) draw
// the sprite at different canvas positions, art corrected over a pinned
// shadow — exactly what one shared offset could not do.
ok(Math.abs((pS.dx - iE.dx) + (pS.anchor.ax - iE.anchor.ax) * pS.s) <= 1 && pS.dx !== iE.dx,
  `the sprite shifts between facets by exactly the offset difference (${pS.dx} vs ${iE.dx})`);
// Tune E its own offset via the pad, the other way.
await p.evaluate(() => document.querySelector(".shadow-pad")?.scrollIntoView({ block: "center" }));
await p.waitForTimeout(200);
pad = await (await p.$(".shadow-pad")).boundingBox();
await p.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
await p.mouse.down();
for (let i = 1; i <= 6; i++) await p.mouse.move(pad.x + pad.width / 2 - (60 * i) / 6, pad.y + pad.height / 2);
await p.mouse.up();
await p.waitForTimeout(300);
const iE2 = await probe();
ok(iE2.anchor.source === "facet" && iE2.anchor.ax < iE.anchor.ax,
  `idle·E takes its own offset without touching S (${iE2.anchor.ax})`);
await clickDir("S");
await p.waitForTimeout(200);
const sBack = await probe();
ok(Math.abs(sBack.anchor.ax - after.anchor.ax) < 0.01 && sBack.anchor.source === "facet",
  "…and S still wears exactly what he gave it");
await clickDir("E");
await p.waitForTimeout(200);

// the record follows across STATE and every DIRECTION, anchor never moving
const seen = [];
for (const st of ["idle", "walk"]) {
  await clickState(st);
  await p.waitForTimeout(250);
  for (const d of ["S", "SW", "W", "NW", "N", "NE", "E", "SE"]) {
    await clickDir(d);
    await p.waitForTimeout(120);
    seen.push(await probe());
  }
}
const recs = new Set(seen.map((x) => JSON.stringify(x.rec)));
const anchors = new Set(seen.map((x) => `${x.ex},${x.ey},${x.W},${x.H}`));
ok(recs.size === 1, `one record across 2 states × 8 directions (${recs.size} distinct)`);
ok(anchors.size === 1, `and one pinned anchor for all 16 views (${anchors.size} distinct) — the shadow never jumps`);

// THE FAST-CLICK STORM — his exact gesture ("let's now fast click between all
// directions and see how the monster now rotates around the new shadow
// center"). Three rounds through all 8 at ~45ms must leave the record, the
// canvas, the anchor and the view centring exactly where they were.
const preStorm = await probe();
for (let round = 0; round < 3; round++) {
  for (const d of ["S", "SE", "E", "NE", "N", "NW", "W", "SW"]) {
    await clickDir(d);
    await p.waitForTimeout(45);
  }
}
await clickDir("S");
await p.waitForTimeout(400);
const postStorm = await probe();
const vStorm = await viewState();
ok(JSON.stringify(postStorm.rec) === JSON.stringify(preStorm.rec),
  "24 fast direction clicks leave the record untouched");
ok(postStorm.ex === preStorm.ex && postStorm.ey === preStorm.ey && postStorm.W === preStorm.W && postStorm.H === preStorm.H,
  "…and the canvas and anchor exactly where they were");
ok(Math.abs(vStorm.anchorViewX - vStorm.stageCenterX) <= 3,
  `…still centred in view after the storm (off by ${Math.abs(Math.round(vStorm.anchorViewX - vStorm.stageCenterX))}px)`);
const east = seen.find((x) => x.dir === "east"), south = seen.find((x) => x.dir === "south");
const expE = myEllipse(after.rec.rx, after.rec.ry, "east"), expS = myEllipse(after.rec.rx, after.rec.ry, "south");
ok(Math.abs(east.p - expE.p * east.s) < 0.1 && Math.abs(east.q - expE.q * east.s) < 0.1,
  `the PAGE draws east with the same ground rotation the game will (${east.p}x${east.q} vs expected ${(expE.p * east.s).toFixed(1)}x${(expE.q * east.s).toFixed(1)})`);
ok(Math.abs(south.p - expS.p * south.s) < 0.1, "and south matches too");
const diag = seen.find((x) => x.dir === "south-east");
const expD = myEllipse(after.rec.rx, after.rec.ry, "south-east");
ok(Math.abs(diag.theta - expD.theta) < 0.01,
  `the diagonal facing is a genuinely rotated ellipse (θ ${diag.theta})`);
// The PAGE's sign too, not just its magnitude — a mirrored page would agree
// with a mirrored formula on everything but the picture.
ok(Math.sign(diag.theta) === Math.sign(expD.theta) || Math.abs(expD.theta) < 0.01,
  "and tilted to the same SIDE the game will draw");

// ---- 3. the sliders edit the ONE size --------------------------------------
await clickState("idle");
await clickDir("S");
await p.waitForTimeout(200);
await p.evaluate(() => {
  const s = document.querySelectorAll(".shadow-slider")[0];
  s.value = String(+s.value + 12);
  s.dispatchEvent(new Event("input", { bubbles: true }));
});
await p.waitForTimeout(200);
const grown = await probe();
ok(Math.abs(grown.rec.rx - (after.rec.rx + 6)) < 0.3, `the W rail resizes the record (rx ${after.rec.rx} → ${grown.rec.rx})`);
await clickDir("E");
await p.waitForTimeout(150);
const grownE = await probe();
ok(Math.abs(grownE.rec.rx - grown.rec.rx) < 0.01, "…and east wears the same new size");
await clickDir("S");

// ---- 4. it COMMITS into tuning/monsters, never shadow_notes ---------------
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(700);
ok(saves.length === 1 && saves[0].file === "tuning/monsters",
  `Commit posted the monsters TUNING doc (${saves.map((s) => s.file).join(", ") || "nothing"})`);
const entry = saves[0]?.set?.[MON.id];
ok(!!entry?.shadow && typeof entry.shadow.rx === "number" && typeof entry.shadow.ry === "number",
  `and the entry carries the one size (${JSON.stringify({ rx: entry?.shadow?.rx, ry: entry?.shadow?.ry })})`);
const offKeys = Object.keys(entry?.shadow?.offsets ?? {});
ok(offKeys.includes("idle#south") && offKeys.includes("idle#east"),
  `…and the per-facet offsets he placed (${offKeys.join(", ")})`);
ok(Math.abs(entry.shadow.rx - grown.rec.rx) < 0.01
  && Math.abs(entry.shadow.offsets["idle#south"].ax - sBack.anchor.ax) < 0.01,
  "with exactly the numbers on screen");
ok(!saves.some((s) => s.file === "tuning/shadow_notes"),
  "the frozen shadow_notes doc was not written — the old system stays historical");

// ---- 5. Reset is two-stage: this facet's offset first, the record second ----
// We are on idle·E, which carries its own offset.
await p.evaluate(() => [...document.querySelectorAll(".shadow-bar button")].find((x) => /Reset/.test(x.textContent))?.click());
await p.waitForTimeout(250);
const facetGone = await probe();
ok(facetGone.rec.edited && facetGone.anchor.source !== "facet",
  `first Reset drops only this facet's offset — the record survives (source now ${facetGone.anchor.source})`);
// Drop S's too, then the empty-handed press clears the whole record.
await clickDir("S");
await p.waitForTimeout(200);
await p.evaluate(() => [...document.querySelectorAll(".shadow-bar button")].find((x) => /Reset/.test(x.textContent))?.click());
await p.waitForTimeout(250);
await p.evaluate(() => [...document.querySelectorAll(".shadow-bar button")].find((x) => /Reset|Clear/.test(x.textContent))?.click());
await p.waitForTimeout(250);
const resetRec = await probe();
ok(!resetRec.rec.edited, "…and the empty-handed press clears the record — back to untuned");
// A re-route (the staging upgrade) may have rebuilt the page with the editor
// closed — the readout is only rendered while it is open, so re-open it.
await p.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("Edit shadow"));
  if (btn && !btn.classList.contains("on")) btn.click();
});
await p.waitForTimeout(250);
const read = await p.evaluate(() => document.querySelector(".shadow-read")?.textContent ?? "");
ok(/untuned/.test(read), `and the readout says so (${read.slice(0, 60)}…)`);
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(700);
const second = saves[saves.length - 1];
ok(saves.length === 2 && (second.set[MON.id] === null || !second.set[MON.id]?.shadow),
  "committing the reset removes the record rather than storing a fake confirmation");

// ---- 6. the public page has no editor ---------------------------------------
const pub = await ctx.newPage();
pub.on("pageerror", (e) => errs.push(String(e)));
await pub.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":false}' }));
await pub.addInitScript(() => localStorage.removeItem("wiki-admin-token"));
await pub.goto(`${W}#/monsters/${MON.id}`, { waitUntil: "load" });
await pub.waitForTimeout(1800);
ok(await pub.evaluate(() => ![...document.querySelectorAll("button")].some((x) => x.textContent.includes("Edit shadow"))),
  "a player sees the shadow but gets no editor");

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nSHADOW CHECKS FAILED (${fails.length})` : "\nALL SHADOW CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
