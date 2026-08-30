/* THE SCENERY HITBOX EDITOR (maintainer 2026-08-27: "We need the same for
 * Scenery ... When I look at an image I immediately see where is the hitbox").
 *
 * The monster shadow editor's UX, with the four things scenery has that a
 * monster does not — several ellipses, a rotation on each, "needs none" as a
 * real answer, and no facings — plus the filter he asked for.
 *
 * DRIVEN AS HE DRIVES IT: the pad is dragged with real pointer events through
 * its own gain curve, because the pad IS the feature. A gate that set the
 * numbers directly would pass on an editor whose pad did nothing — which is
 * exactly what my first probe of this file reported, wrongly, because it
 * pressed a pad that was below the fold.
 */
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
import { readFileSync } from "node:fs";
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const PIECES = D.domains.objects ?? [];
const DATAOBJ = D.domains.objects ?? [];
/* A FIXTURE THE MAINTAINER'S OWN WORK CANNOT BREAK. check-shadow.mjs is red
 * today for exactly this: it pins monster[0] and asserts the record is
 * untouched, so the first monster he tuned turned his work into a failing
 * gate. This gate resets its piece to undecided before it starts, and picks
 * one with a measured content box so the default-derivation assertions have
 * something real to check. */
const LIVE = JSON.parse(readFileSync(new URL("../../live/tuning/scenery_hitbox.json", import.meta.url), "utf8"));

/* THE DEFAULT PASS (maintainer 2026-08-28: "place the hitbox as good as you
 * can on all Scenery objects ... I will only have to edit the hitboxes where
 * you are off/wrong"). Every non-wall piece carries a stored footprint,
 * auto-placed from its own alpha with his split-rock as the reference; these
 * checks keep the mass data structurally sound without pinning taste. */
{
  const wallsOv = JSON.parse(readFileSync(new URL("../../live/tuning/scenery_walls.json", import.meta.url), "utf8")).overrides ?? {};
  const isWall = (o) => typeof wallsOv[o.path]?.wall === "boolean" ? wallsOv[o.path].wall : ["MOUNTAIN_WALL", "WINDOW"].includes(o.type);
  const eligible = PIECES.filter((o) => !isWall(o));
  /* EVERY VARIATION, not every piece (2026-08-29): they can differ in size,
   * so each carries its own record — or inherits the piece-level one he set
   * himself. */
  const varsOf = (o) => Object.keys(o.animations ?? {});
  /* A COLLISIONLESS PIECE NEEDS NO FOOTPRINT (2026-08-29): the scenery domain
   * tags carpets with collision:false and the wiki drops their proposals, so
   * requiring a record for every variation of one would demand data that
   * would be wrong to keep. */
  const flatTagged = new Set((DATAOBJ ?? []).filter((o) => o.noCollision).map((o) => o.path));
  const missing = eligible.filter((o) => !flatTagged.has(o.path)).flatMap((o) => varsOf(o)
    .filter((st) => !LIVE.overrides?.[`${o.path}#${st}`] && !LIVE.overrides?.[o.path])
    .map((st) => `${o.path}#${st}`));
  const nVars = eligible.reduce((n2, o) => n2 + varsOf(o).length, 0);
  ok(missing.length === 0, `every VARIATION of every non-wall piece has a stored hitbox (${missing.length ? "first missing: " + missing[0] : nVars + " variations"})`);
  const badBox = [];
  for (const o of eligible) for (const st of [...varsOf(o), null]) {
    const rec = LIVE.overrides?.[st ? `${o.path}#${st}` : o.path]; if (!rec) continue;
    const dd = (st ? o.animations[st] : Object.values(o.animations ?? {})[0])?.dirs?.south ?? {};
    const fw = dd.fw ?? o.size ?? 96, fh = dd.fh ?? o.size ?? 96;
    for (const b of rec.boxes ?? []) {
      const fin = ["ax", "ay", "rx", "ry"].every((k) => isFinite(b[k])) && b.rx > 0 && b.ry > 0;
      const inX = Math.abs(b.ax) + b.rx <= fw / 2 + 2;
      const inY = b.ay + b.ry <= fh / 2 + 2 && b.ay - b.ry >= -fh / 2 - 2;
      if (!(fin && inX && inY)) badBox.push(`${o.path}${st ? "#" + st : ""} ${JSON.stringify(b)} in ${fw}x${fh}`);
    }
    if ((rec.boxes ?? []).length > 1 && ((dd.bb ? dd.bb[2] - dd.bb[0] : fw) < 80)) {
      badBox.push(`${o.path}: ${rec.boxes.length} ellipses on a piece too narrow to be an entrance`);
    }
  }
  ok(badBox.length === 0, badBox.length ? `bad stored box: ${badBox[0]} (${badBox.length})` : `every stored box is finite, inside its frame, and entrances are wide (${eligible.length} pieces)`);
  /* PROPOSALS ARE MARKED (maintainer 2026-08-28: "Your default hitbox does
   * not count as 'hitbox set'"): the alpha pass carries auto:true; only
   * accepted or hand-edited records lack it. */
  const nAuto = Object.values(LIVE.overrides ?? {}).filter((r) => r.auto === true).length;
  const nSet = Object.values(LIVE.overrides ?? {}).filter((r) => !r.auto).length;
  ok(nAuto >= 400 && nSet >= 1,
    `the alpha-placed records are flagged as proposals, his own are not (${nAuto} auto, ${nSet} maintainer-set)`);
}
const bbOf = (o) => Object.values(o.animations ?? {})[0]?.dirs?.south?.bb;
/* NON-WALL, always: since the 2026-08-28 default pass every non-wall piece
 * HAS a stored record, so "no entry" would select a wall piece — which has no
 * editor at all. The in-page reset below already makes any piece undecided. */
const PIECE = PIECES.find((o) => bbOf(o) && !["MOUNTAIN_WALL", "WINDOW"].includes(o.type) && !LIVE.overrides?.[o.path])
  ?? PIECES.find((o) => bbOf(o) && !["MOUNTAIN_WALL", "WINDOW"].includes(o.type))
  ?? PIECES[0];

const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = []; const saves = [];
p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.route("**/api/wiki/save", (r) => { saves.push(r.request().postDataJSON()); r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
await p.addInitScript(() => { localStorage.setItem("wiki-admin-token", "gate"); });

// ---- 1. the filter: three states, not two ---------------------------------
await p.goto(`${W}#/objects`, { waitUntil: "load" });
await p.waitForTimeout(2600);
const chips = await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-object-hitbox"] button')].map((x) => x.textContent.trim()));
/* HE NAMED TWO STATES, THE QUEUE NEEDS THREE. "Not having a hitbox" is two
 * different facts — nobody has looked, versus decided-needs-none — and 134 of
 * the 739 pieces are MOUNTAIN_WALL or WINDOW, so the second group is large and
 * permanent. Folding them together would make the to-do count never reach 0. */
/* FIVE CHIPS. Wall scenery got its own (maintainer 2026-08-28: "Windows is
 * placed on walls ... should not be part of 'no hitbox yet' ... also not part
 * of 'hitbox set'. You can create a new filter ... called 'wall scenery'").
 * Decided by TYPE, so the to-do queue holds only pieces a hitbox could ever
 * apply to — with windows in it, its count could never reach zero. */
/* SIX SINCE 2026-08-29: "no collision" joined them, because a carpet is a
 * different answer from a wall piece and he needs to find the mis-tagged
 * ones. Asserted by NAME, not by index, so the next answer he needs does not
 * redden this. */
ok(/^all \d+/.test(chips[0])
  && ["no hitbox yet", "hitbox set", "needs none", "no collision", "wall scenery"]
    .every((n2) => chips.some((c) => c.startsWith(n2))),
  `the Scenery page filters on hitbox state, with counts (${chips.join(" | ")})`);
const total = +(chips[0].match(/\d+/) ?? [0])[0];
ok(total === PIECES.length, `over the whole domain (${total} of ${PIECES.length})`);
{
  /* OVERRIDE-AWARE, like the predicate itself: his scenery_walls corrections
   * move pieces in and out of the wall class, and a count pinned to the raw
   * tag reddens every time he corrects one — a gate failing because the
   * maintainer worked is a broken gate. */
  const wallsOv2 = JSON.parse(readFileSync(new URL("../../live/tuning/scenery_walls.json", import.meta.url), "utf8")).overrides ?? {};
  const wallN = PIECES.filter((o) => typeof wallsOv2[o.path]?.wall === "boolean"
    ? wallsOv2[o.path].wall : (o.type === "WINDOW" || o.type === "MOUNTAIN_WALL")).length;
  const chipN = (name) => +((chips.find((c) => c.startsWith(name)) ?? "").match(/\d+$/) ?? [NaN])[0];
  ok(chipN("wall scenery") === wallN,
    `wall scenery counts the pieces the override-aware predicate calls walls (${chipN("wall scenery")} of ${wallN})`);
  ok(chipN("no hitbox yet") + chipN("hitbox set") + chipN("needs none") + chipN("no collision") + chipN("wall scenery") === total,
    "and the FIVE states partition the domain — no piece in two queues, none in zero");
  // A window must NOT appear under "no hitbox yet".
  await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-object-hitbox"] button')].find((x) => /no hitbox yet/.test(x.textContent))?.click());
  await p.waitForTimeout(1400);
  const todoTypes = await p.evaluate(() => [...document.querySelectorAll("a.card")].slice(0, 60).map((a) => a.getAttribute("href")));
  const winIds = new Set(PIECES.filter((o) => o.type === "WINDOW" || o.type === "MOUNTAIN_WALL").map((o) => `#/objects/${o.id}`));
  ok(!todoTypes.some((h2) => winIds.has(h2)), "and the to-do queue contains no wall piece");
  await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-object-hitbox"] button')].find((x) => /^all/.test(x.textContent))?.click());
  await p.waitForTimeout(900);
}
// A wall piece offers NO editor at all — absent, not disabled.
{
  const wallPiece = PIECES.find((o) => o.type === "WINDOW");
  await p.goto(`${W}#/objects/${wallPiece.id}`, { waitUntil: "load" });
  await p.waitForTimeout(2200);
  ok(await p.evaluate(() => ![...document.querySelectorAll("button")].some((x) => /Edit hitbox/.test(x.textContent))),
    `a window offers no Edit hitbox button — a control that can never apply is absent, not disabled (${wallPiece.id})`);
}

// ---- 2. the editor opens on a piece ---------------------------------------
await p.goto(`${W}#/objects/${PIECE.id}`, { waitUntil: "load" });
await p.waitForTimeout(2600);
ok(await p.evaluate(() => !!document.querySelector(".hit-bar.hidden")), "the editor is closed until asked for");
// Start from undecided whatever the live file says — his real verdicts must
// never be what this gate is measuring.
await p.evaluate((k) => {
  const d = window.__wiki?.state?.tuning?.scenery_hitbox;
  // per-VARIATION keys now (2026-08-29): clear the piece-level record and
  // every "<path>#<state>" under it, or the editor inherits one of them
  if (d?.overrides) for (const key of Object.keys(d.overrides)) {
    if (key === k || key.startsWith(`${k}#`)) delete d.overrides[key];
  }
}, PIECE.path);
await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Edit hitbox/.test(x.textContent))?.click());
await p.waitForTimeout(1200);
const open = await p.evaluate(() => ({
  bar: !!document.querySelector(".hit-bar:not(.hidden)"),
  rails: document.querySelectorAll(".hit-bar .shadow-slider").length,
  pad: !!document.querySelector(".hit-bar .shadow-pad"),
  probe: window.__wikiHitbox,
  read: document.querySelector(".hit-bar .shadow-read")?.textContent ?? "",
}));
ok(open.bar && open.pad, "and opens with the same proxy pad the monster shadow uses — his thumb never on the art");
/* THREE RAILS: the two a monster has, plus the one scenery needs. "A scenery
 * that need a hitbox is always facing south. But the ellips might still need a
 * rotation to fit the object." */
ok(open.rails === 3, `with three rails — width, depth and the ROTATION a monster never needed (${open.rails})`);
/* THE RAILS SPAN THE ART (maintainer 2026-08-29: "very hard to use the
 * slider ... the max numbers so insanely big"). A quarter past the content
 * box, not twice the frame — and never shorter than the value they show. */
{
  const dd2 = Object.values(PIECE.animations)[0]?.dirs?.south ?? {};
  const bb2 = dd2.bb;
  const rails = await p.evaluate(() => [...document.querySelectorAll(".hit-bar .shadow-slider")].slice(0, 2)
    .map((x) => ({ max: +x.max, val: +x.value })));
  const art = bb2 ? Math.max(bb2[2] - bb2[0], bb2[3] - bb2[1]) : 0;
  const frame = Math.max(dd2.fw ?? 96, dd2.fh ?? 96);
  /* EACH RAIL ON ITS OWN SCALE (maintainer 2026-08-29: "the max value is so
   * huge and the root try to use the slider for is so small so the
   * resolution is very bad on trees"). Three times the value it sets, capped
   * by the art — so the DEPTH rail is no longer sized by the width. */
  ok(art > 0 && rails.every((r) => r.max <= Math.max(24, Math.round(art * 1.25), Math.ceil(r.val))),
    `no rail reaches past the art (${rails.map((r) => r.max).join("/")} for art ${art}, frame ${frame})`);
  ok(rails.every((r) => r.val <= 2 || r.max <= Math.max(24, Math.ceil(r.val * 3), Math.ceil(r.val))),
    `and each rail is scaled to ITS OWN value, not the other's (${rails.map((r) => `${r.val}→${r.max}`).join(", ")})`);
  ok(rails.every((r) => r.max >= r.val),
    `and never end below the value they are showing (${rails.map((r) => `${r.val}/${r.max}`).join(", ")})`);
}
ok(open.probe?.state === "todo" && /not set/.test(open.read),
  "an untouched piece reads as NOT SET — merely opening it must not count as done");
/* THE FIRST ELLIPSE COMES FROM THE ART, not from the middle of the frame: the
 * piece's own measured content box, sitting at its foot. */
const bb = Object.values(PIECE.animations)[0]?.dirs?.south?.bb;
const box0 = open.probe.boxes[0];
ok(bb && Math.abs(box0.rx * 2 - (bb[2] - bb[0])) < 2,
  `its first ellipse starts as wide as the art's own content box (${(box0.rx * 2).toFixed(1)} vs ${bb ? bb[2] - bb[0] : "?"} px)`);
/* SQUASHED BY THE GAME'S OWN LATTICE, not by a number restated here. The
 * first cut hard-coded 14/32 from the tiles 3.0 pitch while the game ships
 * dy=15 — every default would have been 7% too shallow and he would have
 * corrected the same error on all 739 pieces. Asserted against data.json's
 * own iso block, so the day ISO_DY becomes 14 this follows instead of
 * failing. */
const K = (D.iso?.dy ?? 15) / (D.iso?.dx ?? 32);
ok(Math.abs(box0.ry - box0.rx * K) < 0.6,
  `and squashed by the GAME's own foreshortening (${box0.rx.toFixed(1)} x ${box0.ry.toFixed(1)}, iso ${D.iso?.dx}/${D.iso?.dy} = ${K.toFixed(4)})`);
ok(box0.ry < box0.rx, "which is an ellipse on screen, never a circle");

// ---- 3. the pad moves it, through the real gain curve ---------------------
await p.evaluate(() => document.querySelector(".hit-bar .shadow-pad")?.scrollIntoView({ block: "center" }));
await p.waitForTimeout(400);
const padBox = await (await p.$(".hit-bar .shadow-pad")).boundingBox();
ok(padBox.y >= 0 && padBox.y + padBox.height <= 900, `the pad is reachable on a phone screen (y ${Math.round(padBox.y)})`);
const before = (await p.evaluate(() => window.__wikiHitbox)).boxes[0];
await p.mouse.move(padBox.x + padBox.width / 2, padBox.y + padBox.height / 2);
await p.mouse.down();
await p.mouse.move(padBox.x + padBox.width / 2 + 90, padBox.y + padBox.height / 2 + 40, { steps: 8 });
await p.mouse.up();
await p.waitForTimeout(700);
const moved = await p.evaluate(() => ({ probe: window.__wikiHitbox, read: document.querySelector(".hit-bar .shadow-read")?.textContent ?? "" }));
const after0 = moved.probe.boxes[0];
/* THE SAME GAIN AS THE MONSTER PAD, and the arithmetic is checkable: the first
 * PAD_FINE_ZONE (60) screen px are geared to PAD_FINE (0.3), the rest 1:1, and
 * the result is divided by the zoom to reach frame pixels. 90 px across at 2x
 * is (60*0.3 + 30) / 2 = 24 frame px. If this number drifts, the feel he tuned
 * on his own phone has drifted with it. */
ok(Math.abs((after0.ax - before.ax) - 24) < 0.6,
  `dragging the pad 90px moves it exactly 24 frame px — the monster pad's own gain curve (moved ${(after0.ax - before.ax).toFixed(1)})`);
ok(moved.probe.state === "has" && !/not set/.test(moved.read),
  "and the first movement adopts the record — the piece leaves the to-do queue");

/* ---- 3b. THE ELLIPSE IS NEVER CLIPPED BY THE ART (maintainer 2026-08-27: "I
 * feel the hitbox I draw is clipped and can only render inside the scenery
 * texture ... makes it hard to see the hitbox if it's not at the correct place
 * already"). The canvas used to crop to the art's own content box, so a
 * footprint wider than the piece — which it almost always is BEFORE he has
 * placed it — was drawn outside the canvas and vanished. Checked at the three
 * extremes that broke it: widened, turned, and dragged clear of the art. */
const fits = async (what) => {
  const f = await p.evaluate(() => {
    const hb = window.__wikiHitbox; if (!hb) return null;
    const span = hb.boxes.map((bx, i) => {
      const th = (bx.rot || 0) * Math.PI / 180;
      const hx = Math.hypot(bx.rx * Math.cos(th), bx.ry * Math.sin(th)) * hb.s;
      const hy = Math.hypot(bx.rx * Math.sin(th), bx.ry * Math.cos(th)) * hb.s;
      const c = hb.screen[i];
      return [c.ex - hx, c.ex + hx, c.ey - hy, c.ey + hy];
    });
    return { W: hb.W, H: hb.H,
      l: Math.min(...span.map((x) => x[0])), r: Math.max(...span.map((x) => x[1])),
      t: Math.min(...span.map((x) => x[2])), b: Math.max(...span.map((x) => x[3])) };
  });
  ok(f && f.l >= -1 && f.r <= f.W + 1 && f.t >= -1 && f.b <= f.H + 1,
    `${what}: the whole ellipse is inside the canvas (x ${f?.l.toFixed(0)}..${f?.r.toFixed(0)} of ${f?.W}, y ${f?.t.toFixed(0)}..${f?.b.toFixed(0)} of ${f?.H})`);
};
await fits("at its default size");
await p.evaluate(() => { const w2 = [...document.querySelectorAll(".hit-bar .shadow-slider")][0]; w2.value = w2.max; w2.dispatchEvent(new Event("input", { bubbles: true })); w2.dispatchEvent(new Event("change", { bubbles: true })); });
await p.waitForTimeout(700);
await fits("widened past the art");
await p.evaluate(() => { const r = [...document.querySelectorAll(".hit-bar .shadow-slider")][2]; r.value = "60"; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); });
await p.waitForTimeout(700);
await fits("turned 60 degrees");
/* THE D RAIL GROWS UPWARD ONLY (maintainer 2026-08-28: "you are good at
 * finding the bottom, left and right - but you find it harder to know where
 * in y the hitbox ends ... the scaling center is the bottom of the elipse").
 * The bottom edge ay+ry must hold still while D changes. */
{
  // snapped ABSOLUTE values: a range input rounds to its step, so relative
  // nudges land half a step off and a strict equality misses by exactly that
  const b0 = await p.evaluate(() => {
    const d2 = [...document.querySelectorAll(".hit-bar .shadow-slider")][1];
    const base = Math.round(+d2.value * 2) / 2;
    d2.value = String(base); d2.dispatchEvent(new Event("input", { bubbles: true })); d2.dispatchEvent(new Event("change", { bubbles: true }));
    return { base, ...window.__wikiHitbox.boxes[window.__wikiHitbox.sel] };
  });
  await p.waitForTimeout(400);
  const drive = (v) => p.evaluate((v2) => { const d2 = [...document.querySelectorAll(".hit-bar .shadow-slider")][1]; d2.value = String(v2); d2.dispatchEvent(new Event("input", { bubbles: true })); d2.dispatchEvent(new Event("change", { bubbles: true })); }, v);
  await drive(b0.base + 14);
  await p.waitForTimeout(500);
  const b1 = await p.evaluate(() => ({ ...window.__wikiHitbox.boxes[window.__wikiHitbox.sel] }));
  ok(Math.abs(b1.ry - (b0.base + 14) / 2) < 0.03 && Math.abs((b1.ay + b1.ry) - (b0.ay + b0.ry)) < 0.05,
    `the D rail scales from the BOTTOM — deeper ellipse, same bottom edge (${(b0.ay + b0.ry).toFixed(1)} → ${(b1.ay + b1.ry).toFixed(1)})`);
  await drive(b0.base);
  await p.waitForTimeout(500);
  const b2 = await p.evaluate(() => ({ ...window.__wikiHitbox.boxes[window.__wikiHitbox.sel] }));
  ok(Math.abs(b2.ry - b0.base / 2) < 0.03 && Math.abs((b2.ay + b2.ry) - (b0.ay + b0.ry)) < 0.05,
    "and shrinking D comes back down onto the very same bottom");
}
{
  const pb2 = await (await p.$(".hit-bar .shadow-pad")).boundingBox();
  await p.mouse.move(pb2.x + pb2.width / 2, pb2.y + pb2.height / 2);
  await p.mouse.down();
  await p.mouse.move(pb2.x + pb2.width / 2 + 200, pb2.y + pb2.height / 2 - 140, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(900);
}
await fits("dragged clear of the art");

// ---- 4. several ellipses, and a rotation on each --------------------------
await p.evaluate(() => [...document.querySelectorAll(".hit-bar button")].find((x) => /\+ ellipse/.test(x.textContent))?.click());
await p.waitForTimeout(700);
const two = await p.evaluate(() => ({ probe: window.__wikiHitbox, chips: document.querySelectorAll(".hit-chips button").length }));
/* "The Scenery might have two collisions and not just one ... for example when
 * the scenery is an entrance with two pillars touching the ground." */
ok(two.probe.n === 2 && two.chips === 2 && two.probe.sel === 1,
  `a second ellipse can be added and is selected for editing (${two.probe.n} ellipses, ${two.chips} chips)`);
ok(two.probe.boxes[1].ax !== two.probe.boxes[0].ax,
  "offset from the one it was copied from, so it is not hiding exactly behind it");
// The OTHER ellipse must not move — compared against what it actually held a
// moment ago, not against a constant, since earlier steps here turn #1 too.
const rotBefore = (await p.evaluate(() => window.__wikiHitbox)).boxes.map((x) => x.rot);
await p.evaluate(() => { const r = [...document.querySelectorAll(".hit-bar .shadow-slider")][2]; r.value = "35"; r.dispatchEvent(new Event("input", { bubbles: true })); });
await p.waitForTimeout(500);
const rot = await p.evaluate(() => window.__wikiHitbox);
ok(rot.boxes[rot.sel].rot === 35 && rot.boxes.every((x, i) => i === rot.sel || x.rot === rotBefore[i]),
  `the rotation applies to the selected ellipse alone (${rotBefore.join(", ")} -> ${rot.boxes.map((x) => x.rot).join(", ")}, sel #${rot.sel + 1})`);

// ---- 5. "needs none" is a decision, and it is not the same as undecided ---
await p.evaluate(() => [...document.querySelectorAll(".hit-bar button")].find((x) => /needs none/.test(x.textContent))?.click());
await p.waitForTimeout(700);
const none = await p.evaluate(() => ({ probe: window.__wikiHitbox, read: document.querySelector(".hit-bar .shadow-read")?.textContent ?? "" }));
ok(none.probe.state === "none" && none.probe.n === 0 && /no hitbox/.test(none.read),
  `"needs none" stores an empty list and says so (${none.read.slice(0, 46)})`);
await p.evaluate(() => [...document.querySelectorAll(".hit-bar button")].find((x) => x.textContent.trim() === "Reset")?.click());
await p.waitForTimeout(700);
ok((await p.evaluate(() => window.__wikiHitbox)).state === "todo",
  "and Reset returns it to undecided — a different state, which is why the queue has three chips");

// ---- 6. it commits through the same save bar -----------------------------
await p.evaluate(() => [...document.querySelectorAll(".hit-bar button")].find((x) => /needs none/.test(x.textContent))?.click());
await p.waitForTimeout(500);
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(900);
const s = saves.at(-1);
/* KEYED PER VARIATION (maintainer 2026-08-29: "You don't store one hitbox
 * per variation ... it changes on ALL variations. Different variations can be
 * different size."): "<path>#<state>", the state being the one on screen. */
{
  const k0 = Object.keys(s?.set ?? {})[0] ?? "";
  const shown = await p.evaluate(() => window.__wikiHitbox?.variation ?? "");
  ok(s?.file === "tuning/scenery_hitbox" && k0 === `${PIECE.path}#${shown}`,
    `Commit posts one delta per VARIATION, keyed path#state (${k0})`);
}
ok(Array.isArray(Object.values(s.set)[0]?.boxes), "carrying the box list, empty or otherwise");
/* ---- 7. THE WALL TAG IS CORRECTABLE, both ways (maintainer 2026-08-28:
 * "you have tagged some scenery as wall scenery that is not wall scenery and
 * I can also find scenery that IS wall scenery, but you think it's not ...
 * so I can fix errors like this during the review"). The correction is not a
 * label: it moves the piece in and out of the hitbox queue and grants or
 * removes the editor itself. */
{
  const wallPiece = PIECES.find((o) => o.type === "WINDOW");
  await p.goto(`${W}#/objects/${wallPiece.id}`, { waitUntil: "load" });
  await p.waitForTimeout(2400);
  const readW = () => p.evaluate(() => ({
    placed: [...document.querySelectorAll(".lit-mode")].map((r) => r.textContent.replace(/\s+/g, " ").trim()).find((x) => x.startsWith("Placed")) ?? "",
    hitBtn: !![...document.querySelectorAll("button")].find((x) => /Edit hitbox/.test(x.textContent)),
  }));
  const w0 = await readW();
  ok(/Placed/.test(w0.placed) && !w0.hitBtn,
    `a tagged wall piece shows the Placed row and NO hitbox editor (${wallPiece.id})`);
  await p.evaluate(() => { const r = [...document.querySelectorAll(".lit-mode")].find((x) => x.textContent.startsWith("Placed")); [...r.querySelectorAll("button")].find((b2) => /on the ground/.test(b2.textContent))?.click(); });
  await p.waitForTimeout(1400);
  const w1 = await readW();
  ok(w1.hitBtn && /tagged wall/.test(w1.placed),
    "correcting it to ground GRANTS the editor and shows what the tag said — a correction is only readable against what it corrects");
  await p.evaluate(() => document.querySelector("#save-btn")?.click());
  await p.waitForTimeout(900);
  const sW = saves.at(-1);
  ok(sW?.file === "tuning/scenery_walls" && Object.values(sW.set ?? {})[0]?.wall === false
    && Object.values(sW.set ?? {})[0]?.was === "WINDOW",
    `Commit posts the correction with what it overrode (${JSON.stringify(Object.values(sW?.set ?? {})[0])})`);
  await p.evaluate(() => { const r = [...document.querySelectorAll(".lit-mode")].find((x) => x.textContent.startsWith("Placed")); [...r.querySelectorAll("button")].find((b2) => /wall scenery/.test(b2.textContent))?.click(); });
  await p.waitForTimeout(900);
  await p.evaluate(() => document.querySelector("#save-btn")?.click());
  await p.waitForTimeout(900);
  ok(Object.values(saves.at(-1)?.set ?? {})[0] === null,
    "agreeing with the tag again DELETES the correction — absent means the tag is right");
}
/* ---- ACCEPT + ALWAYS SHOW (maintainer 2026-08-28: "I should be able to
 * review the scenery with 'Always show hitbox' ... Next to button 'Edit
 * hitbox' should be a button called 'Accept default hitbox'. It's only if I
 * accept the default or edit it manually, the scenery object is marked as
 * 'hitbox set'.") ---- */
{
  // a piece the earlier flows have NOT touched — the fixture piece and every
  // path this run saved carry gate-made state, not the shipped proposal
  const gateTouched = new Set(saves.flatMap((s2) => Object.keys(s2.set ?? {})));
  // a proposal now lives under "<path>#<state>" (2026-08-29)
  const isAutoPiece = (o) => Object.keys(o.animations ?? {}).some((st) => LIVE.overrides?.[`${o.path}#${st}`]?.auto === true);
  const autoPiece = PIECES.find((o) => isAutoPiece(o)
    && !["MOUNTAIN_WALL", "WINDOW"].includes(o.type)
    && o !== PIECE && !gateTouched.has(o.path));
  await p.goto(`${W}#/objects/${autoPiece.id}`, { waitUntil: "load" });
  await p.waitForTimeout(2400);
  const btns = await p.evaluate(() => {
    const all = [...document.querySelectorAll("button")].map((x) => ({ t: x.textContent.trim(), hidden: x.classList.contains("hidden") }));
    return {
      edit: all.find((x) => /Edit hitbox/.test(x.t)),
      accept: all.find((x) => /Accept default hitbox/.test(x.t)),
      show: all.find((x) => /Always show hitbox/.test(x.t)),
    };
  });
  ok(!!btns.edit && !!btns.accept && !btns.accept.hidden && !!btns.show,
    `an auto-proposed piece offers Edit, ACCEPT and Always-show side by side (${autoPiece.id})`);
  // the proposal counts as NOT SET until he speaks
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Edit hitbox/.test(x.textContent))?.click());
  await p.waitForTimeout(1000);
  const before = await p.evaluate(() => ({ ...(window.__wikiHitbox ?? {}) }));
  const read0 = await p.evaluate(() => document.querySelector(".hit-bar .shadow-read")?.textContent ?? "");
  ok(before.state === "todo" && /proposed default/.test(read0) && /not set/.test(read0),
    `the proposal reads as a PROPOSAL, and the piece still counts as to-do ("${read0.slice(-60)}")`);
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Edit hitbox/.test(x.textContent))?.click());
  await p.waitForTimeout(600);
  // accept: same boxes, his record now — under THIS variation's key
  const autoKey = await p.evaluate((path) => `${path}#${window.__wikiHitbox?.variation ?? ""}`, autoPiece.path);
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Accept default hitbox/.test(x.textContent))?.click());
  await p.waitForTimeout(800);
  const after = await p.evaluate((k) => {
    const r = window.__wiki.state.tuning.scenery_hitbox.overrides?.[k];
    return { auto: r?.auto === true, n: r?.boxes?.length ?? 0, boxes: r?.boxes ?? [] };
  }, autoKey);
  ok(!after.auto && after.n === before.n
    && after.boxes.every((b2, i) => Math.abs(b2.ax - before.boxes[i].ax) < 0.01 && Math.abs(b2.rx - before.boxes[i].rx) < 0.01),
    `Accept stores the very boxes on screen, without the auto flag (${after.n} box)`);
  const st2 = await p.evaluate(() => {
    const acc = [...document.querySelectorAll("button")].find((x) => /Accept default hitbox/.test(x.textContent));
    return { accHidden: acc?.classList.contains("hidden") };
  });
  ok(st2.accHidden === true, "and the Accept button retires — the decision is made");
  await p.evaluate(() => document.querySelector("#save-btn")?.click());
  await p.waitForTimeout(800);
  const sA = saves.at(-1);
  ok(sA?.file === "tuning/scenery_hitbox" && sA.set?.[autoKey]?.auto === undefined && Array.isArray(sA.set?.[autoKey]?.boxes),
    `Commit posts the accepted record clean of the flag (${autoKey})`);

  // ALWAYS SHOW: overlay with the editor closed, persisting across the pager
  await p.evaluate(() => { delete window.__wikiHitbox; });
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Always show hitbox/.test(x.textContent))?.click());
  await p.waitForTimeout(900);
  const shown = await p.evaluate(() => ({ probe: !!window.__wikiHitbox, on: [...document.querySelectorAll("button")].find((x) => /Always show hitbox/.test(x.textContent))?.classList.contains("on") }));
  ok(shown.probe && shown.on, "Always show draws the hitbox with NO editor open");
  const nextPiece = PIECES.find((o) => o !== autoPiece && o !== PIECE && isAutoPiece(o)
    && !["MOUNTAIN_WALL", "WINDOW"].includes(o.type) && !gateTouched.has(o.path));
  await p.goto(`${W}#/objects/${nextPiece.id}`, { waitUntil: "load" });
  await p.waitForTimeout(2200);
  const still = await p.evaluate(() => ({ probe: !!window.__wikiHitbox, state: window.__wikiHitbox?.state }));
  ok(still.probe && still.state === "todo",
    `…and stays on while browsing to the next piece — the mode is the review (${nextPiece.id})`);
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Always show hitbox/.test(x.textContent))?.click());
  await p.waitForTimeout(500);
}
/* ---- ONE HITBOX PER VARIATION, ISOLATED (maintainer 2026-08-29: "when I
 * change the hitbox on a variation it changes on ALL variations/states.
 * This is bad because different variations can be different size."). ---- */
{
  // a piece THIS RUN has not touched: earlier sections leave their fixture on
  // "needs none", which has no box to widen
  const touched = new Set(saves.flatMap((s2) => Object.keys(s2.set ?? {}).map((k) => k.split("#")[0])));
  const multi = PIECES.find((o) => Object.keys(o.animations ?? {}).length >= 2
    && !["MOUNTAIN_WALL", "WINDOW"].includes(o.type)
    && o !== PIECE && !touched.has(o.path));
  await p.goto(`${W}#/objects/${multi.id}`, { waitUntil: "load" });
  await p.waitForTimeout(2400);
  const states = await p.evaluate(() => [...document.querySelectorAll(".state-seg button, .stateseg button, .seg button")].map((x) => x.textContent.trim()));
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Edit hitbox/.test(x.textContent))?.click());
  await p.waitForTimeout(1000);
  const read = () => p.evaluate(() => ({ v: window.__wikiHitbox?.variation, w: window.__wikiHitbox?.boxes?.[0]?.rx ?? null }));
  const a0 = await read();
  // widen THIS variation by driving its W rail to the max
  await p.evaluate(() => { const w2 = [...document.querySelectorAll(".hit-bar .shadow-slider")][0]; w2.value = w2.max; w2.dispatchEvent(new Event("input", { bubbles: true })); w2.dispatchEvent(new Event("change", { bubbles: true })); });
  await p.waitForTimeout(700);
  const a1 = await read();
  ok(a1.w > a0.w, `variation ${a1.v} takes a wider hitbox (${a0.w} → ${a1.w})`);
  // switch to the NEXT variation: it must be untouched
  const moved = await p.evaluate(() => {
    const segs = [...document.querySelectorAll("button")].filter((b2) => b2.closest(".state-seg, .stateseg, .seg"));
    const on = segs.findIndex((b2) => b2.classList.contains("on"));
    const next = segs[(on + 1) % segs.length];
    if (!next || segs.length < 2) return false;
    next.scrollIntoView({ block: "center" }); next.click(); return true;
  });
  await p.waitForTimeout(1400);
  const b0 = await read();
  ok(moved && b0.v && b0.v !== a1.v, `the card switches to another variation (${a1.v} → ${b0.v})`);
  ok(Math.abs(b0.w - a0.w) < 0.01 && b0.w !== a1.w,
    `and ITS hitbox is untouched by the edit next door (${b0.w} vs the widened ${a1.w})`);
  const keys = await p.evaluate(() => Object.keys(window.__wiki.state.tuning.scenery_hitbox?.overrides ?? {}).filter((k) => k.includes("#")));
  ok(keys.length >= 1 && keys.every((k) => /#/.test(k)),
    `the stored record names the variation (${keys[0]})`);
}
/* ---- NO COLLISION: A THIRD ANSWER, AND THEIRS TO STATE (maintainer
 * 2026-08-29: "mark an object as no collision/collision less — this can be a
 * carpet or something else flat on the floor", and the scenery domain is
 * writing the tag). A carpet and a window both hold no footprint; the player
 * walks OVER one and PAST the other, so the game must tell them apart. ---- */
{
  const touched2 = new Set(saves.flatMap((s2) => Object.keys(s2.set ?? {}).map((k) => k.split("#")[0])));
  const piece = PIECES.find((o) => !["MOUNTAIN_WALL", "WINDOW"].includes(o.type)
    && !touched2.has(o.path) && o !== PIECE);
  await p.goto(`${W}#/objects/${piece.id}`, { waitUntil: "load" });
  await p.waitForTimeout(2400);
  await p.evaluate(() => {
    // the button TOGGLES and cur.editHit survives navigation — open only if shut
    if (!document.querySelector(".hit-bar:not(.hidden)")) {
      [...document.querySelectorAll("button")].find((x) => /Edit hitbox/.test(x.textContent))?.click();
    }
  });
  await p.waitForTimeout(1000);
  await p.evaluate(() => { delete window.__wikiHitbox; });
  await p.evaluate(() => [...document.querySelectorAll(".hit-bar:not(.hidden) button")].find((x) => /no collision/.test(x.textContent))?.click());
  await p.waitForTimeout(1400);
  const flat = await p.evaluate((path) => ({
    rec: window.__wiki.state.tuning.scenery_hitbox.overrides?.[path] ?? null,
    st: window.__wikiHitbox?.state ?? null,
    read: document.querySelector(".hit-bar .shadow-read")?.textContent ?? "",
    railsOff: [...document.querySelectorAll(".hit-bar .shadow-slider")].every((x) => x.disabled),
  }), piece.path);
  ok(flat.rec?.no_collision === true && (flat.rec.boxes ?? []).length === 0,
    `${piece.id}: the correction is a PIECE-level { boxes: [], no_collision: true }`);
  ok(flat.st === "flat", `its review state is its own, not "none" (${flat.st})`);
  ok(/walks over/.test(flat.read) && flat.railsOff,
    `the bar says the player walks over it and stops offering rails (${flat.read.slice(0, 46)})`);
  await p.evaluate(() => document.querySelector("#save-btn")?.click());
  await p.waitForTimeout(800);
  ok(saves.at(-1)?.set?.[piece.path]?.no_collision === true,
    "Commit posts it under the piece's own path, so every variation inherits it");
  // agreeing with the scenery tag again must leave NO entry behind
  await p.evaluate(() => {
    if (!document.querySelector(".hit-bar:not(.hidden)")) {
      [...document.querySelectorAll("button")].find((x) => /Edit hitbox/.test(x.textContent))?.click();
    }
  });
  await p.waitForTimeout(900);
  await p.evaluate(() => [...document.querySelectorAll(".hit-bar:not(.hidden) button")].find((x) => /no collision/.test(x.textContent))?.click());
  await p.waitForTimeout(1000);
  await p.evaluate(() => document.querySelector("#save-btn")?.click());
  await p.waitForTimeout(900);
  const cleared = await p.evaluate((path) => ({
    rec: window.__wiki.state.tuning.scenery_hitbox.overrides?.[path] ?? null,
    st: window.__wikiHitbox?.state ?? null,
  }), piece.path);
  ok(cleared.rec === null && (saves.at(-1)?.set?.[piece.path] ?? null) === null,
    "and agreeing with the scenery domain's tag DELETES the correction — absent means their tag stands");
  const chips = await p.evaluate(async () => {
    location.hash = "#/objects";
    await new Promise((r) => setTimeout(r, 2200));
    return [...document.querySelectorAll('[data-bar="wiki-object-hitbox"] button')].map((x) => x.textContent.trim());
  });
  ok(chips.some((c) => /no collision/.test(c)), `the list offers a "no collision" filter (${chips.join(" | ").slice(0, 70)})`);
}
/* THE TREE DEFAULT IS THE TRUNK (maintainer 2026-08-29, after correcting 83
 * of them: "Trees often has root branches that stick out and the player can
 * kinda walk on them so I made it a little tighter. A rock on the other hand
 * often go straight up so here I try to surround the rock more precisely").
 * Data-level: a tree's proposal must be narrower than its art, and its own
 * corrections must not have been touched. */
{
  const objs = PIECES;
  const isTree = (o) => (o.type ?? "").toUpperCase() === "TREE" || /\/(trees|ancient_trees)\//.test(o.path);
  const bbOf2 = (o, st) => (st ? o.animations?.[st] : Object.values(o.animations ?? {})[0])?.dirs?.south?.bb;
  let wide = 0, checked = 0, hisTouched = 0;
  for (const [key, rec] of Object.entries(LIVE.overrides ?? {})) {
    const [path, st] = key.split("#");
    const o = objs.find((x) => x.path === path);
    if (!o || !isTree(o) || !(rec.boxes ?? []).length) continue;
    if (!rec.auto) { hisTouched++; continue; }
    const bb = bbOf2(o, st);
    if (!bb) continue;
    checked++;
    // the trunk band can never be wider than the art it was measured in
    if (rec.boxes[0].rx * 2 > (bb[2] - bb[0]) + 2) wide++;
  }
  ok(checked > 200 && wide === 0,
    `every tree proposal is a trunk, never wider than the art (${checked} checked, ${wide} too wide)`);
  ok(hisTouched > 0, `and his own tree corrections are still there, unflagged (${hisTouched})`);
}
ok(errs.length === 0, `no page errors (${errs[0] ?? "none"})`);

await b.close();
console.log(fails.length ? `\nHITBOX CHECKS FAILED (${fails.length})` : "\nALL HITBOX CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
