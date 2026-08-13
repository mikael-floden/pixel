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

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL STILL CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
