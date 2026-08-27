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
const PIECE = PIECES[0];

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
ok(chips.length === 4 && /^all \d+/.test(chips[0]) && /no hitbox yet/.test(chips[1])
  && /hitbox set/.test(chips[2]) && /needs none/.test(chips[3]),
  `the Scenery page filters on hitbox state, with counts (${chips.join(" | ")})`);
const total = +(chips[0].match(/\d+/) ?? [0])[0];
ok(total === PIECES.length, `over the whole domain (${total} of ${PIECES.length})`);

// ---- 2. the editor opens on a piece ---------------------------------------
await p.goto(`${W}#/objects/${PIECE.id}`, { waitUntil: "load" });
await p.waitForTimeout(2600);
ok(await p.evaluate(() => !!document.querySelector(".hit-bar.hidden")), "the editor is closed until asked for");
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
ok(open.probe?.state === "todo" && /not set/.test(open.read),
  "an untouched piece reads as NOT SET — merely opening it must not count as done");
/* THE FIRST ELLIPSE COMES FROM THE ART, not from the middle of the frame: the
 * piece's own measured content box, sitting at its foot. */
const bb = Object.values(PIECE.animations)[0]?.dirs?.south?.bb;
const box0 = open.probe.boxes[0];
ok(bb && Math.abs(box0.rx * 2 - (bb[2] - bb[0])) < 2,
  `its first ellipse starts as wide as the art's own content box (${(box0.rx * 2).toFixed(1)} vs ${bb ? bb[2] - bb[0] : "?"} px)`);
ok(box0.ry < box0.rx, `and squashed by the ground's own foreshortening, not a circle (${box0.rx.toFixed(1)} x ${box0.ry.toFixed(1)})`);

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
await p.evaluate(() => { const r = [...document.querySelectorAll(".hit-bar .shadow-slider")][2]; r.value = "35"; r.dispatchEvent(new Event("input", { bubbles: true })); });
await p.waitForTimeout(500);
const rot = await p.evaluate(() => window.__wikiHitbox);
ok(rot.boxes[1].rot === 35 && rot.boxes[0].rot === 0,
  `the rotation applies to the selected ellipse alone (${rot.boxes.map((x) => x.rot).join(", ")})`);

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
ok(s?.file === "tuning/scenery_hitbox" && Object.keys(s.set ?? {})[0] === PIECE.path,
  `Commit posts one delta per PIECE, keyed by its path (${Object.keys(s?.set ?? {})[0]})`);
ok(Array.isArray(Object.values(s.set)[0]?.boxes), "carrying the box list, empty or otherwise");
ok(errs.length === 0, `no page errors (${errs[0] ?? "none"})`);

await b.close();
console.log(fails.length ? `\nHITBOX CHECKS FAILED (${fails.length})` : "\nALL HITBOX CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
