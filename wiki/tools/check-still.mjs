// A STATIC SCENERY PIECE STILL GETS THE ANIMATION VIEWER.
//
// Maintainer, 2026-08-13: "The scenery says 'No animations' on all new
// objects. That is correct, but a lot of scenery will not have any animation —
// or you can think of the image itself as a 'still' animation with only 1
// frame. Why do I want still to be seen as an animation? Because the animation
// viewer shows the object in its true scale and is a good tool for me to look
// at the object. We only need this if no real animation exist."
//
// 368 of the 371 pieces are static, so the viewer — the only place the wiki
// draws scenery cropped free of padding at a known scale, with a zoom control —
// was reachable on three of them. The builder now gives a static piece a
// one-frame `still` clip. What this file guards is the "only if no real
// animation exists" half, and that a still does not quietly become an
// animation everywhere else in the UI.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const objs = D.domains.objects ?? [];

// ---------------------------------------------------------------- the data
const still = objs.filter((o) => o.stillOnly);
const real = objs.filter((o) => !o.stillOnly);
console.log(`data: ${objs.length} scenery — ${still.length} still, ${real.length} animated`);
ok(objs.every((o) => Object.keys(o.animations ?? {}).length > 0),
  `every piece now has something to show (${objs.filter((o) => !Object.keys(o.animations ?? {}).length).length} with nothing)`);
// The "only if no real animation exists" rule, in both directions.
ok(still.every((o) => Object.keys(o.animations).length === 1 && o.animations.still),
  "a still piece has exactly one clip, and it is the still");
ok(real.every((o) => !o.animations.still),
  `a piece with real animation is untouched (${real.map((o) => `${o.id}: ${Object.keys(o.animations).join("+")}`).join(", ")})`);
ok(real.length === 3, `the three generated pieces are still the only animated ones (${real.length})`);
// The still must BE the sprite, one frame, one direction — not a guess.
const bad = still.filter((o) => {
  const d = o.animations.still.dirs;
  const s = d.south;
  return Object.keys(d).length !== 1 || !s || s.frames !== 1 || s.strip !== o.preview;
});
ok(bad.length === 0, `each still is 1 frame, south, and is the sprite itself${bad.length ? ` — ${bad.slice(0, 3).map((o) => o.id).join(", ")}` : ""}`);
ok(still.every((o) => o.animations.still.dirs.south.bb),
  "and it is measured, so it draws cropped at true scale rather than padded");
// Whole-frame vs measured: the padding really is being cropped, or the viewer
// is no better than the thumbnail it was added to improve on.
const cropped = still.filter((o) => { const s = o.animations.still.dirs.south;
  return s.bb[2] - s.bb[0] < s.fw || s.bb[3] - s.bb[1] < s.fh; });
ok(cropped.length > still.length / 2, `most stills genuinely crop padding away (${cropped.length}/${still.length})`);

// ------------------------------------------------------------------ the page
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await (await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const look = async (id) => {
  await p.goto(`${W}#/objects/${id}`, { waitUntil: "load" });
  await p.waitForTimeout(1700);
  return p.evaluate(() => {
    const st = document.querySelector(".player-stage"), cv = st?.querySelector("canvas");
    let painted = 0;
    if (cv) { const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) painted++; }
    const txt = document.body.textContent;
    return { title: [...document.querySelectorAll(".panel-title")].map((x) => x.textContent),
      hasStage: !!st, w: cv?.width ?? 0, h: cv?.height ?? 0, painted,
      stage: st && `${st.clientWidth}x${st.clientHeight}`,
      zoom: [...document.querySelectorAll(".player-controls button")].map((x) => x.textContent).filter((t) => /^(same|1×|2×|4×)$/.test(t)),
      transport: [...document.querySelectorAll(".player-controls button")].map((x) => x.textContent).filter((t) => ["⏸", "▶", "⏮", "⏭"].includes(t)),
      dirpad: document.querySelectorAll(".dirpad button").length,
      states: document.querySelectorAll(".seg-states button").length,
      noAnims: /No animations\./.test(txt), assign: /Assign a sound/.test(txt) };
  });
};
const tiny = await look("mushroom_005");
const big = await look("ancient_tree_002");
const anim = await look("campfire");
console.log("still (small):", JSON.stringify(tiny));
console.log("still (giant):", JSON.stringify(big));
console.log("animated:     ", JSON.stringify(anim));
ok(!tiny.noAnims && !big.noAnims, "the dead-end “No animations.” line is gone");
ok(tiny.title.includes("Still") && big.title.includes("Still"), "a static piece is headed Still, not Animations");
ok(anim.title.includes("Animations"), "a generated piece is still headed Animations");
ok(tiny.painted > 100 && big.painted > 5000, `both actually draw (${tiny.painted}px, ${big.painted}px)`);
// The controls a one-frame clip cannot use are not offered; the one it exists
// for is.
ok(tiny.transport.length === 0 && big.transport.length === 0, `no play/step buttons on a single frame (${tiny.transport.join("")})`);
ok(tiny.states === 0 && tiny.dirpad === 0, "no state row and no direction pad for a lone south still");
ok(tiny.zoom.length === 4 && big.zoom.length === 4, `zoom survives — it is the reason the viewer is here (${tiny.zoom.join(" ")})`);
ok(anim.transport.length >= 3 && anim.states >= 1 && anim.dirpad === 8,
  `the animated piece keeps everything (${anim.transport.length} transport, ${anim.states} states, ${anim.dirpad} dirs)`);
// A still is not an action: nothing fires objects.<id>.still, so it must not be
// offered as something to hang a sound on.
ok(!tiny.assign, "a still is never offered as a sound event to assign");
// The fixed stage: paging scenery must not move the layout.
ok(tiny.stage === big.stage && big.stage === anim.stage, `one stage for the whole domain (${tiny.stage})`);
// Zoom really re-scales — otherwise "true scale" is a claim, not a feature.
await p.goto(`${W}#/objects/mushroom_005`, { waitUntil: "load" });
await p.waitForTimeout(1500);
const zoomed = await p.evaluate(async () => {
  const cv = () => document.querySelector(".player-stage canvas");
  const before = cv().width;
  [...document.querySelectorAll(".player-controls button")].find((x) => x.textContent === "4×").click();
  await new Promise((r) => setTimeout(r, 400));
  const after = cv().width;
  const st = document.querySelector(".player-stage");
  return { before, after, stage: `${st.clientWidth}x${st.clientHeight}` };
});
console.log("zoom:", JSON.stringify(zoomed));
ok(zoomed.after === zoomed.before * 2, `4× doubles the 2× default (${zoomed.before} → ${zoomed.after})`);

// The list must keep calling these static — it is where you scan for movement.
await p.goto(`${W}#/objects`, { waitUntil: "load" });
await p.waitForTimeout(1800);
const list = await p.evaluate(() => {
  const subs = [...document.querySelectorAll(".card-sub")].map((x) => x.textContent);
  return { n: subs.length, static: subs.filter((s) => s === "static").length, still: subs.filter((s) => /still/i.test(s)).length,
    other: [...new Set(subs.filter((s) => s !== "static"))] };
});
console.log("list:", JSON.stringify(list));
ok(list.still === 0, "no card claims a “still” animation");
ok(list.static === still.length, `all ${still.length} static pieces still read “static” (${list.static})`);
ok(list.other.length > 0 && list.other.every((s) => !/still/i.test(s)), `and the animated ones name their real states (${list.other.join(", ")})`);

// PAGING ‹ › MUST NOT MOVE THE VIEWER (maintainer 2026-08-13: "The scenery
// title and text is so big the animation viewer is pushed down differently
// when I press next next next"). The name's suffixes are pills, the title is
// a fixed two-line box, and the prompt hides behind "Read more…" — collapsed
// again on every page change, so expansion is always the reader's own act.
// The walk starts a few pieces before the campfire so it crosses stills AND
// an animated legacy piece, long names and short.
const objIds = D.domains.objects.map((o) => o.id);
const start = Math.max(0, objIds.indexOf("campfire") - 4);
await p.goto(`${W}#/objects/${objIds[start]}`, { waitUntil: "load" });
await p.waitForTimeout(1700);
const pmeasure = () => p.evaluate(() => {
  const pan = [...document.querySelectorAll(".panel")].find((x) => x.querySelector(".player-stage"));
  const t = document.querySelector(".obj-title"), s = document.querySelector(".obj-sub");
  return { top: pan ? Math.round(pan.getBoundingClientRect().top) : -1,
    titleH: Math.round(t?.getBoundingClientRect().height ?? -1),
    subH: Math.round(s?.getBoundingClientRect().height ?? -1),
    open: !!document.querySelector(".obj-desc.open"),
    title: t?.textContent ?? "", full: t?.getAttribute("title") ?? "" };
});
const pwalk = [await pmeasure()];
for (let i = 0; i < 11; i++) {
  await p.evaluate(() => [...document.querySelectorAll("button,a")].find((x) => x.textContent.trim() === "›")?.click());
  await p.waitForTimeout(380);
  pwalk.push(await pmeasure());
}
const ptops = [...new Set(pwalk.map((r) => r.top))];
console.log("paging:", JSON.stringify({ ptops, titleHs: [...new Set(pwalk.map((r) => r.titleH))], first: pwalk[0].title }));
ok(ptops.length === 1 && ptops[0] > 0, `the viewer panel never moves while paging ‹ › (tops: ${ptops.join(", ")})`);
ok(new Set(pwalk.map((r) => r.titleH)).size === 1, `the title box is one fixed height whatever the name (${pwalk[0].titleH}px)`);
ok(new Set(pwalk.map((r) => r.subH)).size === 1, `and so is the pill/Read-more row (${pwalk[0].subH}px)`);
ok(pwalk.every((r) => !r.open), "every page arrives with the description collapsed");
ok(pwalk.every((r) => !/ · /.test(r.title)), "no title still carries a “ · ” suffix — those are pills now");
ok(pwalk.some((r) => r.full.includes(" · ")), "and the full name survives in the title tooltip");
// Read more: expands below the row, relabels, pushes the viewer only while
// open — and the panel returns to its exact spot on collapse.
const toggled = await p.evaluate(async () => {
  const pan = () => [...document.querySelectorAll(".panel")].find((x) => x.querySelector(".player-stage"));
  const btn = document.querySelector(".obj-more");
  const before = Math.round(pan().getBoundingClientRect().top);
  btn.click(); await new Promise((r) => setTimeout(r, 150));
  const openTop = Math.round(pan().getBoundingClientRect().top);
  const openText = document.querySelector(".obj-desc.open")?.textContent?.length ?? 0;
  const label = btn.textContent;
  btn.click(); await new Promise((r) => setTimeout(r, 150));
  return { before, openTop, openText, label, after: Math.round(pan().getBoundingClientRect().top), closedLabel: btn.textContent };
});
console.log("readmore:", JSON.stringify(toggled));
ok(toggled.openText > 40, `Read more really shows the description (${toggled.openText} chars)`);
ok(toggled.openTop > toggled.before, "expanding pushes the viewer down — the reader asked for that");
ok(toggled.after === toggled.before, `collapsing puts it back to the pixel (${toggled.before} → ${toggled.after})`);
ok(toggled.label === "Read less" && toggled.closedLabel === "Read more…", "the button relabels both ways");

// ADMIN SIZE REFERENCE (maintainer 2026-08-13: "render the human male side by
// side with the scenery so I see how big it is in comparison … If I toggle
// this mode on I like it to keep being on if I change to next scenery").
// The Man draws at the viewer's OWN shared scale — the whole point of the
// one-scale system is that this comparison needs no other math — feet on the
// piece's baseline, hugging the stage's left edge, scenery untouched.
ok(!(await p.evaluate(() => !!document.querySelector(".human-toggle"))), "the toggle is invisible to the public");
const boy = D.domains.characters.find((c) => c.id === "default_boy");
const boyBB = boy.animations.idle.dirs.south.bb;
const artScale = D.artScale || 2;
const boyW = (boyBB[2] - boyBB[0]) * artScale, boyH = (boyBB[3] - boyBB[1]) * artScale;
const actx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const pa = await actx.newPage();
const aerrs = []; pa.on("pageerror", (e) => aerrs.push(String(e)));
await pa.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await pa.addInitScript(() => localStorage.setItem("wiki-admin-token", "gate"));
const hinfo = () => pa.evaluate(() => {
  const st = document.querySelector(".player-stage"), cv = st?.querySelector("canvas"), hu = st?.querySelector(".human-ref");
  const r = (x) => { const q = x.getBoundingClientRect(); return { l: Math.round(q.left), b: Math.round(q.bottom), w: Math.round(q.width), h: Math.round(q.height) }; };
  return { on: !!document.querySelector(".human-toggle")?.classList.contains("on"),
    visible: !!hu && getComputedStyle(hu).display !== "none",
    canvas: cv ? r(cv) : null, human: hu && getComputedStyle(hu).display !== "none" ? r(hu) : null,
    stageL: Math.round(st.getBoundingClientRect().left) };
});
await pa.goto(`${W}#/objects/mushroom_005`, { waitUntil: "load" });
await pa.waitForTimeout(1700);
const h0 = await hinfo();
ok(!h0.on && !h0.visible, "admin sees the toggle off and no Man by default");
await pa.evaluate(() => document.querySelector(".human-toggle").click());
await pa.waitForTimeout(300);
const h1 = await hinfo();
console.log("human on:", JSON.stringify(h1), `expect ${boyW}x${boyH}`);
ok(h1.visible && h1.human.w === boyW && h1.human.h === boyH,
  `the Man draws at the shared scale, content-cropped (${h1.human?.w}x${h1.human?.h} = ${boyW}x${boyH})`);
ok(JSON.stringify(h0.canvas) === JSON.stringify(h1.canvas), "the scenery's own canvas is untouched by the toggle");
ok(Math.abs(h1.human.b - h1.canvas.b) <= 1, `their feet share the baseline (Man ${h1.human.b}, piece ${h1.canvas.b})`);
ok(h1.human.l - h1.stageL <= 3, `and he hugs the stage's left edge (${h1.human.l - h1.stageL}px in)`);
// Sticky across ‹ › — the request verbatim.
for (let i = 0; i < 2; i++) {
  await pa.evaluate(() => [...document.querySelectorAll("button,a")].find((x) => x.textContent.trim() === "›")?.click());
  await pa.waitForTimeout(450);
}
const h2 = await hinfo();
ok(h2.on && h2.visible && Math.abs(h2.human.b - h2.canvas.b) <= 1,
  `two pages later he is still there, still on the new piece's baseline (${h2.human?.b} vs ${h2.canvas?.b})`);
// Zoom must scale BOTH bodies — 2x of him beside 4x of a mushroom is a lie.
await pa.evaluate(() => [...document.querySelectorAll(".player-controls button")].find((x) => x.textContent === "4×")?.click());
await pa.waitForTimeout(350);
const h4 = await hinfo();
ok(h4.human.h === (boyBB[3] - boyBB[1]) * 4, `zoom scales the Man with the piece (4x → ${h4.human?.h}px)`);
// And a reload keeps the choice — localStorage, not component state.
await pa.reload({ waitUntil: "load" });
await pa.waitForTimeout(1700);
const hr = await hinfo();
ok(hr.on && hr.visible, "the choice survives a reload");
await pa.evaluate(() => document.querySelector(".human-toggle").click());
await pa.waitForTimeout(250);
ok(!(await hinfo()).visible, "toggling off hides him again");
ok(aerrs.length === 0, `no admin page errors${aerrs.length ? ` — ${aerrs[0]}` : ""}`);
await actx.close();

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL STILL CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
