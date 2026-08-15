// EDIT THE NADIR SHADOW — the Game Master shows the games agent where it belonged.
//
// Maintainer, 2026-08-15: "It has been really hard to get the nadir shadow
// correct in the game. I know we show the nadir on monsters in the wiki as
// well. Can you create an 'Edit nadir shadow' button, when pressed makes it
// easy to drag and resize the nadir shadow on a monster direction/animation,
// and after doing a lot of them committing them all the same way an
// approve/reject commit works. To be clear, this is just data that the game
// agent can pick up to understand where I think the shadow should have been …
// So it's not a 'fix this shadow only' feature. It's a way to learn how the
// shadows should be placed. But all you need to do is make it editable and a
// way to commit it the same way approve/reject reviews are committed."
//
// Three things follow from that, and they are what this gate holds:
//   1. It is EDITABLE — a drag on the canvas moves the ellipse, a drag on a
//      handle resizes it, and the picture actually changes.
//   2. It is PER DIRECTION AND ANIMATION — the unit that gets regenerated, the
//      same unit the facet verdicts already use.
//   3. It COMMITS LIKE A VERDICT — the save bar counts it and Commit posts it
//      to the live channel as one entry per facet, carrying the correction AND
//      what it corrects (that second half is what makes it training data
//      rather than an override).
//
// This gate NEVER presses anything that reaches the real server: /api/wiki/me
// is faked to admin and /api/wiki/save is captured at the network boundary, so
// the maintainer's own review data is never written.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const posted = [];
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.route("**/api/wiki/save", async (r) => {
  posted.push(JSON.parse(r.request().postData() || "{}"));
  await r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
});
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});

const DATA = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const MON = DATA.domains.monsters.find((m) => m.shadow?.w > 0 && Object.keys(m.animations ?? {}).length > 1);
if (!MON) { console.log("no monster ships a shadow — nothing to gate"); process.exit(1); }

// Everything the editor is: the button, the readout, and the ellipse the
// canvas actually paints. The ellipse is read from the PIXELS, not from the
// note — a note the drawing ignores is exactly the bug worth catching.
const look = () => p.evaluate(() => {
  const btn = [...document.querySelectorAll(".player-controls button")].find((x) => /Edit nadir shadow/i.test(x.textContent));
  const cv = document.querySelector(".player-stage canvas");
  const g = cv?.getContext("2d");
  let ell = null;
  if (g && cv.width && cv.height) {
    // The shadow is the only thing drawn BELOW the sprite's content box, and
    // it is the dark translucent fill — scan for its extent.
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, n = 0;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4;
      const a = d[i + 3];
      // rgba(20,16,8,0.38) over nothing = a dark, near-opaque-free pixel.
      if (a > 40 && a < 170 && d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) {
        n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (n > 20) ell = { x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, n };
  }
  const bar = document.querySelector(".shadow-bar");
  return {
    hasBtn: !!btn,
    btnOn: !!btn?.classList.contains("on"),
    barShown: !!bar && !bar.classList.contains("hidden"),
    read: document.querySelector(".shadow-read")?.textContent ?? null,
    resetDisabled: [...document.querySelectorAll(".shadow-bar button")].find((x) => /Reset/.test(x.textContent))?.disabled ?? null,
    editingClass: !!document.querySelector(".player-stage.editing-shadow"),
    canvas: cv ? { w: cv.width, h: cv.height, box: cv.getBoundingClientRect().toJSON() } : null,
    ell,
    state: document.querySelector(".seg-states button.on")?.title ?? null,
    dir: document.querySelector(".dirpad button.on")?.textContent ?? null,
    pending: document.querySelector("#savebar")?.classList.contains("hidden") ? 0 : Number(document.querySelector("#savebar b")?.textContent ?? 0),
  };
});
const press = () => p.evaluate(() => [...document.querySelectorAll(".player-controls button")].find((x) => /Edit nadir shadow/i.test(x.textContent)).click());
// The stage sits well below the fold on a phone — a pointer aimed at a
// coordinate outside the viewport is simply never delivered.
const showStage = async () => {
  await p.evaluate(() => document.querySelector(".player-stage")?.scrollIntoView({ block: "center" }));
  await p.waitForTimeout(200);
};
// A drag in CLIENT coordinates, exactly as a finger delivers it. The canvas
// grows as the ellipse does, so its rect is re-read for every gesture.
async function drag(canvasPt, dx, dy) {
  await showStage();
  const now = await look();
  const from = {
    x: now.canvas.box.x + (canvasPt.cx / now.canvas.w) * now.canvas.box.width,
    y: now.canvas.box.y + (canvasPt.cy / now.canvas.h) * now.canvas.box.height,
  };
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  for (let i = 1; i <= 6; i++) await p.mouse.move(from.x + (dx * i) / 6, from.y + (dy * i) / 6);
  await p.mouse.up();
  await p.waitForTimeout(200);
}

console.log(`monster: ${MON.id} (shadow ${MON.shadow.w}x${MON.shadow.h})`);
await p.goto(`${W}#/monsters/${MON.id}`, { waitUntil: "load" });
await p.waitForTimeout(2200);
// Freeze the clip: a playing animation repaints under the mouse and a moving
// sprite would make the pixel read of the ellipse a coin toss.
await p.evaluate(() => [...document.querySelectorAll(".player-controls button")].find((x) => x.textContent === "⏸")?.click());
await p.waitForTimeout(200);

// ---------------------------------------------------------------- 1. the button
const off = await look();
console.log("before:", JSON.stringify({ hasBtn: off.hasBtn, barShown: off.barShown, ell: off.ell && { w: off.ell.w, h: off.ell.h, cx: off.ell.cx, cy: off.ell.cy } }));
ok(off.hasBtn, "the monster page offers an “Edit nadir shadow” button to the admin");
ok(!off.barShown && !off.editingClass, "and it starts OFF — the page reads exactly as it did before");
ok(!!off.ell, "the game's own shadow ellipse is on the canvas to begin with");

await press();
await p.waitForTimeout(300);
const on = await look();
console.log("editing:", JSON.stringify({ btnOn: on.btnOn, barShown: on.barShown, read: on.read, resetDisabled: on.resetDisabled }));
ok(on.btnOn && on.editingClass, "pressing it latches the button and puts the stage in edit mode");
ok(on.barShown && /\d+\.\d × \d+\.\d px/.test(on.read ?? ""), `with the live numbers on screen (“${on.read}”)`);
ok(/measurement/.test(on.read ?? ""), "saying up front that nothing has been changed yet");
ok(on.resetDisabled === true, "and Reset disabled, because there is nothing to reset");
ok(on.pending === 0, "and NOTHING pending — opening the editor is not an edit");

// ---------------------------------------------------------------- 2. it drags
const base = on.ell;
await drag(base, 14, -9);
const moved = await look();
console.log("after move:", JSON.stringify({ read: moved.read, from: { cx: base.cx, cy: base.cy }, to: moved.ell && { cx: moved.ell.cx, cy: moved.ell.cy }, pending: moved.pending }));
ok(!!moved.ell && Math.abs(moved.ell.cx - base.cx) >= 8 && Math.abs(moved.ell.cy - base.cy) >= 5,
  `dragging the ellipse MOVES the drawn shadow (${base.cx},${base.cy} → ${moved.ell?.cx},${moved.ell?.cy})`);
ok(/moved [+−]/.test(moved.read ?? ""), `and the readout says how far, in frame pixels (“${moved.read}”)`);
ok(/was /.test(moved.read ?? ""), "next to what the game measured, so the correction is readable against it");
ok(moved.resetDisabled === false, "Reset becomes available");
ok(moved.pending === 1, `and it counts as ONE pending change, exactly like a verdict (${moved.pending})`);

// The width handle sits on the ellipse's right rim.
const rimBefore = await look();
const grip = { cx: rimBefore.ell.x1, cy: rimBefore.ell.cy };
await drag(grip, 16, 0);
const wider = await look();
console.log("after widen:", JSON.stringify({ read: wider.read, w: [rimBefore.ell.w, wider.ell?.w] }));
ok(!!wider.ell && wider.ell.w >= rimBefore.ell.w + 12, `dragging the side handle WIDENS it (${rimBefore.ell.w} → ${wider.ell?.w}px)`);
const hGrip = { cx: wider.ell.cx, cy: wider.ell.y1 };
await drag(hGrip, 0, 10);
const taller = await look();
console.log("after flatten:", JSON.stringify({ read: taller.read, h: [wider.ell.h, taller.ell?.h] }));
ok(!!taller.ell && taller.ell.h >= wider.ell.h + 8, `and the bottom handle changes its depth (${wider.ell.h} → ${taller.ell?.h}px)`);
// A widened ellipse must stay REACHABLE: clipped at the canvas rim, the handle
// it is grabbed by is gone and the edit cannot be undone by hand.
ok(taller.ell.x1 <= taller.canvas.w - 2 && taller.ell.x0 >= 1 && taller.ell.y1 <= taller.canvas.h - 2,
  `the enlarged ellipse still fits inside the canvas (x ${taller.ell.x0}-${taller.ell.x1} of ${taller.canvas.w}, bottom ${taller.ell.y1} of ${taller.canvas.h})`);
ok(taller.pending === 1, `and the whole session on one facet is still ONE entry (${taller.pending})`);

// ---------------------------------------------------------------- 3. per facet
const dirs = await p.evaluate(() => [...document.querySelectorAll(".dirpad button")].map((x) => x.textContent));
const other = dirs.find((d) => d !== taller.dir);
await p.evaluate((d) => [...document.querySelectorAll(".dirpad button")].find((x) => x.textContent === d).click(), other);
await p.waitForTimeout(500);
const otherDir = await look();
console.log(`other direction (${other}):`, JSON.stringify({ read: otherDir.read, btnOn: otherDir.btnOn, ell: otherDir.ell && { w: otherDir.ell.w, cx: otherDir.ell.cx } }));
ok(otherDir.btnOn && otherDir.barShown, "turning to another direction keeps the editor open");
ok(/measurement/.test(otherDir.read ?? ""), `but shows ITS own shadow, unedited (“${otherDir.read}”)`);
ok(otherDir.pending === 1, "and the note stayed on the direction it was made for");
await drag({ cx: otherDir.ell.cx, cy: otherDir.ell.cy }, -12, 0);
const two = await look();
ok(two.pending === 2, `editing a second direction adds a second entry (${two.pending})`);

const states = await p.evaluate(() => [...document.querySelectorAll(".seg-states button")].map((x) => x.title));
const otherState = states.find((s) => s !== two.state);
if (otherState) {
  await p.evaluate((t) => [...document.querySelectorAll(".seg-states button")].find((x) => x.title === t).click(), otherState);
  await p.waitForTimeout(500);
  const st2 = await look();
  console.log(`other animation (${otherState}):`, JSON.stringify({ read: st2.read, dir: st2.dir }));
  ok(/measurement/.test(st2.read ?? ""), "and another ANIMATION is unedited too — the unit is animation × direction");
}

// ---------------------------------------------------------------- 4. it commits
await p.evaluate(() => [...document.querySelectorAll("#savebar button")].find((x) => /Commit/.test(x.textContent))?.click());
await p.waitForTimeout(1200);
const shadowPosts = posted.filter((x) => x.file === "tuning/shadow_notes");
const set = shadowPosts[0]?.set ?? {};
const keys = Object.keys(set);
console.log("posted:", JSON.stringify(shadowPosts[0] ?? null).slice(0, 460));
ok(shadowPosts.length === 1, `Commit posts the notes, on the live channel every other review rides (${posted.map((x) => x.file).join(", ") || "nothing"})`);
ok(shadowPosts[0]?.file === "tuning/shadow_notes", "into its own document, so no verdict file is disturbed");
ok(keys.length === 2, `one entry per edited facet (${keys.length})`);
ok(keys.every((k) => new RegExp(`^${MON.path}#[a-z_0-9]+#[a-z-]+$`).test(k)),
  `each keyed <monster>#<animation>#<direction> — the same unit the verdicts use (${keys.join(", ")})`);
const e0 = set[keys[0]] ?? {};
ok(Number.isFinite(e0.dx) && Number.isFinite(e0.dy), `carrying the correction as a delta (dx ${e0.dx}, dy ${e0.dy})`);
ok(Number.isFinite(e0.w) && Number.isFinite(e0.h), `and the size he settled on (${e0.w} × ${e0.h})`);
ok(e0.was && Number.isFinite(e0.was.cx) && Number.isFinite(e0.was.w),
  `beside what the game drew before he touched it (was ${e0.was?.w} × ${e0.was?.h} at ${e0.was?.cx},${e0.was?.cy})`);
ok(e0.frame && e0.frame.w > 0 && e0.frame.h > 0, `and the frame those pixels are measured in (${e0.frame?.w}×${e0.frame?.h})`);
ok(typeof e0.updated_at === "string" && e0.updated_at.length > 10, "stamped with when it was made");
// TRAINING DATA, NOT AN OVERRIDE. A note that only said "put it here" would
// describe this one creature; the pair (was → now) is what generalises.
const movedFar = Math.hypot(e0.dx, e0.dy);
ok(movedFar > 0.5 || Math.abs(e0.w - e0.was.w) > 0.5 || Math.abs(e0.h - e0.was.h) > 0.5,
  `the entry actually differs from the measurement it corrects (moved ${movedFar.toFixed(1)}px)`);

// ---------------------------------------------------------------- 5. reset + off
// Committing re-renders the page, so nothing about the editor is assumed from
// here on — it is re-opened and re-aimed at the facet that carries the note.
console.log("after commit:", JSON.stringify(await look().then((x) => ({ btnOn: x.btnOn, pending: x.pending, state: x.state, dir: x.dir }))));
await p.evaluate((t) => [...document.querySelectorAll(".seg-states button")].find((x) => x.title === t)?.click(), on.state);
await p.waitForTimeout(400);
await p.evaluate((d) => [...document.querySelectorAll(".dirpad button")].find((x) => x.textContent === d)?.click(), on.dir);
await p.waitForTimeout(400);
if (!(await look()).btnOn) { await press(); await p.waitForTimeout(300); }
const kept = await look();
console.log("back on the edited facet:", JSON.stringify({ state: kept.state, dir: kept.dir, read: kept.read, pending: kept.pending }));
ok(/moved [+\u2212]/.test(kept.read ?? ""), `a committed note is still shown on its own facet (\u201c${kept.read}\u201d)`);
ok(kept.pending === 0, "and it is no longer pending — the commit took it");
await p.evaluate(() => [...document.querySelectorAll(".shadow-bar button")].find((x) => /Reset/.test(x.textContent))?.click());
await p.waitForTimeout(300);
const cleared = await look();
console.log("after Reset:", JSON.stringify({ read: cleared.read, pending: cleared.pending, resetDisabled: cleared.resetDisabled }));
ok(/measurement/.test(cleared.read ?? ""), "Reset puts that facet back on the game's own measurement");
ok(cleared.pending === 1, `and the removal is itself a change to commit, not a silent local undo (${cleared.pending})`);
await press();
await p.waitForTimeout(300);
const done = await look();
console.log("after switching off:", JSON.stringify({ btnOn: done.btnOn, barShown: done.barShown, editingClass: done.editingClass }));
ok(!done.btnOn && !done.barShown && !done.editingClass, "pressing the button again puts the page back to a plain preview");
ok(!!done.ell, "with the shadow still drawn \u2014 only the editing is gone");

// ---------------------------------------------------------------- 6. players only
await ctx.clearCookies();
const p2 = await ctx.newPage();
await p2.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":false}' }));
await p2.addInitScript(() => { localStorage.removeItem("wiki-admin-token"); });
await p2.goto(`${W}#/monsters/${MON.id}`, { waitUntil: "load" });
await p2.waitForTimeout(1800);
const pub = await p2.evaluate(() => ({
  btn: [...document.querySelectorAll("button")].some((x) => /Edit nadir shadow/i.test(x.textContent)),
  bar: !!document.querySelector(".shadow-bar:not(.hidden)"),
  shadowChk: [...document.querySelectorAll("label.chk")].some((x) => /Show shadow/.test(x.textContent)),
}));
console.log("as a player:", JSON.stringify(pub));
ok(!pub.btn && !pub.bar, "a signed-out visitor is offered none of it");
ok(pub.shadowChk, "while the ordinary “Show shadow” view stays exactly as it was");

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nFAILED ${fails.length}` : "\nAll good.");
process.exit(fails.length ? 1 : 0);
