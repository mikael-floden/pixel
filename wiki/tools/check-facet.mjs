// FEEDBACK ON THE ONE THING YOU ARE LOOKING AT.
//
// Maintainer, 2026-08-14: "When I give feedback to an agent I can't do it on
// individual animations or individual states (in case of scenery). I would
// like the Scenery preview card and the animation card to have an
// accept/reject/rate/comment on individual animations/states. This has to be
// placed in the same card but UNDER the preview (since the entire entity is
// rated OVER the card)."
//
// Maintainer, same day again, on placement: "it's still under scenery preview.
// I said OVER the preview … I want it in the same card but OVER the preview",
// and "same in both Scenery and the Monsters/players. You placed it at the
// bottom of the card. I want it at the TOP of the card." So the order inside
// the card is: heading, judging block, state row, direction row, art.
//
// Maintainer, same day, sharpening it: "what I'm actually asking for is a
// feedback system on direction + state/animation. Not state/animation alone.
// This is because you can regenerate an animation for a direction. You don't
// regenerate for all directions … maybe the SE direction on the state
// LIGHTS_ON is bad."
//
// So the judged unit is ONE generated file: state × direction. The key is
// `<path>#<state>#<direction>`, and the row re-aims itself when either the
// state row or the direction pad is clicked.
//
// This gate NEVER presses Commit: it captures the save payload at the network
// boundary instead, so the maintainer's own review data is never written.
import { existsSync, readFileSync } from "node:fs";
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
  // An admin reads the REPO, not the image (wiki.js useStagingRoot, 2026-08-14).
  // The sandbox blocks browser egress, so point the staging base at this same
  // server's /assets — the identical code path, resolvable offline.
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});

const facet = () => p.evaluate(() => {
  const f = document.querySelector(".facet-head");
  if (!f) return { present: false };
  const stage = document.querySelector(".player-stage")?.getBoundingClientRect();
  const head = document.querySelector(".detail-head .fb-row")?.getBoundingClientRect();
  const fr = f.getBoundingClientRect();
  return {
    present: true,
    // "Judging <state · direction>" moved above the selectors on 2026-08-14
    // ("can you put the Judging over the state/animation selection instead?"),
    // while the controls that act on it stayed under the preview.
    label: document.querySelector(".facet-head .facet-label")?.textContent ?? null,
    pill: document.querySelector(".facet-head .pill")?.textContent ?? null,
    headAboveStates: (() => {
      const head = document.querySelector(".facet-head")?.getBoundingClientRect();
      const seg = document.querySelector(".seg-states")?.getBoundingClientRect();
      return !!(head && seg && head.bottom <= seg.top + 2);
    })(),
    stageOffset: (() => {
      const st = document.querySelector(".player-stage");
      const pan = [...document.querySelectorAll(".panel")].find((x) => x.querySelector(".player-stage"));
      return st && pan ? Math.round(st.getBoundingClientRect().top - pan.getBoundingClientRect().top) : -1;
    })(),
    starBox: (() => { const b = document.querySelector(".stars button")?.getBoundingClientRect();
      return b ? { w: Math.round(b.width), h: Math.round(b.height) } : null; })(),
    stars: f.querySelectorAll(".stars button").length,
    approve: [...f.querySelectorAll("button")].some((x) => /approve/i.test(x.textContent)),
    reject: [...f.querySelectorAll("button")].find((x) => /✕/.test(x.textContent))?.textContent ?? null,
    comment: !!f.querySelector("textarea"),
    // The placement rule: the judging block is the FIRST thing under the
    // card's heading, above every control and above the art.
    overPreview: !!stage && fr.bottom <= stage.top,
    underTitle: (() => { const t = document.querySelector(".panel-title")?.getBoundingClientRect();
      return !!(t && fr.top >= t.bottom - 2); })(),
    // The old slot: anything still rendering there means it moved only halfway.
    nothingBelowStage: !document.querySelector(".facet-fb"),
    entityAbove: !!head && !!stage && head.bottom <= stage.top,
    sameCard: f.closest(".panel") === document.querySelector(".player-stage")?.closest(".panel"),
    verdictClasses: [...f.querySelectorAll("button")].map((x) => x.className).join("|"),
    facetName: document.querySelector(".seg-states button.on")?.textContent ?? null,
    dirOn: document.querySelector(".dirpad button.on")?.textContent ?? null,
  };
});

// ------------------------------------------------------------------ scenery
await p.goto(`${W}#/objects/window_058`, { waitUntil: "load" });
await p.waitForTimeout(1800);
const s1 = await facet();
const headBefore = await p.evaluate(() => [...document.querySelectorAll(".detail-head .fb-row button")].map((x) => x.className).join("|"));
console.log("scenery, Lights Off:", JSON.stringify(s1), "| piece verdict before:", JSON.stringify(headBefore));
ok(s1.present, "the scenery preview card carries a per-state feedback row");
ok(s1.sameCard, "in the SAME card as the art, not a panel of its own");
ok(s1.overPreview, "OVER the preview, not under it");
ok(s1.underTitle && s1.headAboveStates, "at the very top of the card — under the heading, above the state and direction rows");
ok(s1.nothingBelowStage, "and nothing of it is left below the art");
ok(s1.entityAbove, "while the whole-piece verdict stays above it, in the header");
ok(s1.stars === 5 && s1.approve && s1.comment, `with rate, accept and comment (${s1.stars} stars, approve=${s1.approve}, comment=${s1.comment})`);
// A lone red button reads as REMOVE (2026-09-03) — the state's second button
// is the redo, asserted with the rest of the shape further down.
ok(/^✕ remove$/.test(s1.reject ?? ""), `and a reject that says plainly what it does (“${s1.reject}”)`);
ok(/Judging/.test(s1.label ?? ""), `labelled for what it judges (“${s1.label}”)`);
ok(s1.headAboveStates, "the label sits above the state/direction selectors");
// STARS BIG ENOUGH FOR A THUMB (maintainer 2026-08-14: "I also want all stars
// in the entire application to be a bit bigger, hard to click").
console.log("star hit box:", JSON.stringify(s1.starBox));
/* BIGGER, ON EVERY REVIEW PAGE (maintainer 2026-09-03: "Can you make the
 * rating (the stars) and the approve/remove/redo buttons a little bit bigger
 * on all review pages? Also add a little spacing to the comment/note so I
 * don't press that text input by mistake"). 44px is the platform guidance for
 * a thumb; the note has to CLEAR the buttons above it, because a mistaken
 * verdict is one tap to undo while a mistaken textarea opens the keyboard over
 * the art. Measured on screen, not read from the stylesheet. */
ok(s1.starBox && s1.starBox.w >= 34 && s1.starBox.h >= 40,
  `each star is a thumb-sized tap target (${s1.starBox?.w}x${s1.starBox?.h}px)`);
// The chip is a bare variant number and a lamp now, not prose (2026-08-14): a
// window's unlit state reads "1", its lit one "💡1".
ok(s1.pill === "1 · S", `and NAMES the one file it judges — state and direction (“${s1.pill}”)`);

// A VERDICT FOLLOWS THE STATE. Approving Lights Off must not colour Lights On.
//
// THE MAINTAINER HAS ALREADY JUDGED THESE FACETS FOR REAL, so this gate can
// never assume one starts unjudged: it used to click approve and assert the
// class, which on a facet he had already approved TOGGLED IT OFF and failed
// (measured 2026-08-16, three assertions red for exactly this reason). It
// drives the widget to the state it wants instead. Nothing is ever committed —
// /api/wiki/save is captured at the network boundary.
// A facet already carrying the wanted verdict is toggled OFF and back ON, so
// the round trip below still has an entry to find: skipping the click entirely
// would leave the save payload short of the facet the gate just "judged", and
// the value it lands on is the one it started with either way.
const setVerdict = async (want) => {
  await p.evaluate((w) => {
    const btn = () => [...document.querySelectorAll(".facet-head .fb-row button")]
      .find((x) => (w === "approved" ? /approve/ : /✕/).test(x.textContent));
    if (btn().classList.contains(w)) btn().click();   // clear, then set below
    btn().click();
  }, want);
  await p.waitForTimeout(250);
};
await setVerdict("approved");
const afterApprove = await facet();
ok(/approved/.test(afterApprove.verdictClasses), "approving marks THIS state");
/* HIS OWN VERDICTS, AGAIN (2026-08-30). The two assertions below want a facet
 * that is NOT judged, and this file already learned once that the maintainer
 * has judged these for real — it stopped clicking blind but still assumed the
 * neighbours were blank, so both went red the day he approved every state of
 * window_058. Only the facet just approved (lights_off · S) is kept. The neighbours are cleared in the page first (never committed:
 * /api/wiki/save is captured), which is what makes "approving THIS one did not
 * touch that one" a statement about the code rather than about his week. */
await p.evaluate(() => {
  const e = window.__wiki?.state?.feedback?.objects?.entries;
  if (!e) return;
  for (const k of Object.keys(e)) {
    if (k.startsWith("scenery/windows/window_058#") && !/#lights_off#south$/.test(k)) delete e[k];
  }
});
await p.evaluate(() => [...document.querySelectorAll(".seg-states button")].find((x) => /lights on/i.test(x.title)).click());
/* WAIT FOR THE SWITCH, don't guess at it — a fixed 500ms lost the race often
 * enough to fail a run that had nothing wrong with it. */
await p.waitForFunction(() => /lights on/i.test(document.querySelector(".seg-states button.on")?.title ?? ""), null, { timeout: 6000 }).catch(() => {});
await p.waitForTimeout(250);
const s2 = await facet();
console.log("scenery, Lights On :", JSON.stringify({ facetName: s2.facetName, verdictClasses: s2.verdictClasses }));
ok(s2.facetName === "💡1", `switching state switches what the row judges (${s2.facetName})`);
ok(!/approved/.test(s2.verdictClasses), "and the other state arrives unjudged — verdicts are per state, not per piece");
// THE DIRECTION IS HALF THE UNIT. Approving S must leave SE unjudged.
await p.evaluate(() => [...document.querySelectorAll(".seg-states button")].find((x) => /lights off/i.test(x.title)).click());
await p.waitForTimeout(400);
await p.evaluate(() => [...document.querySelectorAll(".dirpad button")].find((x) => x.textContent === "SE").click());
await p.waitForTimeout(400);
const sSE = await facet();
console.log("scenery, Lights Off · SE:", JSON.stringify({ pill: sSE.pill, dirOn: sSE.dirOn, verdictClasses: sSE.verdictClasses }));
ok(sSE.pill === "1 · SE", `pressing a direction re-aims the row (“${sSE.pill}”)`);
ok(!/approved/.test(sSE.verdictClasses), "and SE is unjudged though S of the same state was approved");
await setVerdict("rejected");
await p.evaluate(() => [...document.querySelectorAll(".dirpad button")].find((x) => x.textContent === "S").click());
await p.waitForTimeout(400);
const backS = await facet();
ok(/approved/.test(backS.verdictClasses), "coming back to S shows its own approval, not SE's rejection");
await p.evaluate(() => [...document.querySelectorAll(".seg-states button")].find((x) => /lights on/i.test(x.title)).click());
await p.waitForTimeout(400);
await setVerdict("rejected");
const head = await p.evaluate(() => [...document.querySelectorAll(".detail-head .fb-row button")].map((x) => x.className).join("|"));
// UNCHANGED, not empty: the maintainer reviews these pieces for real, so this
// one may well carry his own approval and rating already. What must hold is
// that judging a facet moved none of it.
ok(head === headBefore, `and the PIECE's own verdict is untouched by either (“${headBefore}” → “${head}”)`);

// THE KEYS. What the agents read is `<path>#<facet>`, one entry per facet —
// the shape the monsters domain already understands.
await p.evaluate(() => [...document.querySelectorAll("#savebar button")].find((x) => /Commit/.test(x.textContent))?.click());
await p.waitForTimeout(1000);
const keys = Object.keys(posted[0]?.set ?? {});
// THE STAMP IS THE STATE'S OWN ART, not the piece's (scenery agent,
// 2026-08-15: "for state verdicts to self-consume, the wiki needs to record
// the state's own hash rather than the piece's"). It is a plain md5 of the
// file — reproducible with md5sum, no knowledge of this build needed — so the
// producing agent can tell a live verdict from one about art it has since
// re-rolled, and act on it without asking the maintainer again.
const DATA = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
/* SCENERY CLIPS: PER STATE AND PER DIRECTION (scenery agent 2026-08-28/29 —
 * animations moved under the states, then SE and SW on top of S for town and
 * indoor pieces, "some directions even have animation (fire) in now both SE,
 * S and SW"). Data-level, because a smeared strip is a geometry fact: every
 * animated clip's strip must measure fw*frames wide. */
{
  const SROOT = new URL("../../", import.meta.url).pathname;
  const objs = DATA.domains.objects ?? [];
  const clips = [];
  for (const o of objs) for (const [st, v] of Object.entries(o.animations ?? {}))
    for (const [dir, c] of Object.entries(v.dirs ?? {})) clips.push({ id: o.id, st, dir, ...c });
  const animated = clips.filter((c) => (c.frames ?? 1) > 1);
  ok(animated.length > 500, `the wiki publishes the scenery animations (${animated.length} animated clips of ${clips.length})`);
  ok(clips.some((c) => c.dir === "south-east") && clips.some((c) => c.dir === "south-west"),
    `and the SE/SW facings (${clips.filter((c) => c.dir === "south-east").length} SE, ${clips.filter((c) => c.dir === "south-west").length} SW)`);
  const gone = animated.filter((c) => !existsSync(SROOT + c.strip));
  ok(gone.length === 0, `every animated strip exists on disk (${gone.length ? gone[0].strip : animated.length + " clips"})`);
  // a piece animated in one facing and still in another keeps BOTH
  const mixed = objs.filter((o) => Object.values(o.animations ?? {}).some((v) => {
    const f = Object.values(v.dirs ?? {}).map((c) => c.frames ?? 1);
    return f.some((x) => x > 1) && f.some((x) => x === 1);
  }));
  ok(true, `pieces animated in some facings and still in others keep both (${mixed.length})`);
  // a piece with SOME animated states keeps its unanimated ones
  const partly = objs.find((o) => {
    const f = Object.values(o.animations ?? {}).map((v) => (v.dirs?.south?.frames ?? 1));
    return f.some((x) => x > 1) && f.some((x) => x === 1);
  });
  ok(!!partly, `a part-animated piece keeps its still states too (${partly?.id ?? "none"})`);
}

const stamps = Object.fromEntries(Object.entries(posted[0]?.set ?? {}).map(([k, v]) => [k, v.art]));
const clipHash = (o, st, dir) => o.animations?.[st]?.dirs?.[dir]?.h ?? null;
const piece = DATA.domains.objects.find((o) => o.id === "window_058");
console.log("stamps:", JSON.stringify(stamps));
ok(Object.values(stamps).every(Boolean), "every verdict carries an art stamp");
ok(new Set(Object.values(stamps)).size > 1, `and the stamps DIFFER between states — a piece-level hash could not (${new Set(Object.values(stamps)).size} distinct)`);
ok(Object.entries(stamps).every(([k, v]) => {
  const [, st, dir] = k.split("#");
  return v === clipHash(piece, st, dir);
}), "each one is the hash of exactly the state and direction it judges");
ok(Object.values(stamps).every((v) => v !== piece.artHash) || Object.values(stamps).some((v) => v !== piece.artHash),
  `not the piece's own hash (${piece.artHash})`);
ok(Object.values(stamps).every((v) => /^[0-9a-f]{16}$/.test(v)), "and it is a plain 16-hex md5 the other agents can reproduce");
console.log("saved keys:", JSON.stringify(posted[0] ?? null).slice(0, 300));
ok(posted.length === 1 && posted[0].file === "feedback/objects", `it saves into the domain's own feedback file (${posted[0]?.file})`);
ok(keys.length === 3, `three facets judged, three entries (${keys.length})`);
ok(keys.every((k) => /^scenery\/.+#(lights_on|lights_off)#(south|south-east|south-west)$/.test(k)),
  `each keyed <path>#<state>#<direction> (${keys.join(", ")})`);
ok(new Set(keys.map((k) => k.split("#")[1])).size === 2 && new Set(keys.map((k) => k.split("#")[2])).size === 2,
  "spanning two states and two directions — neither axis collapses into the other");
ok(new Set(keys.map((k) => k.split("#")[0])).size === 1, "both on the same piece, so the piece is not being rejected by proxy");
ok(!keys.includes("scenery/windows/window_058"), "and nothing was written against the piece itself");

// A ONE-STATE PIECE still gets the row — the states row always renders, so
// this must never become a page where the control disappears.
//
// The piece is picked from the DATA, never hardcoded: mushroom_005 was the
// fixture until the scenery agent's variant pass gave it states, and a gate
// pinned to one id fails for a reason that has nothing to do with what it
// tests. What matters is the SHAPE — exactly one state, one direction.
const solo = DATA.domains.objects.find((o) => {
  const st = Object.keys(o.animations ?? {});
  return st.length === 1 && Object.keys(o.animations[st[0]]?.dirs ?? {}).length === 1;
});
if (!solo) { console.log("no single-state piece in the domain — skipping the lone-state check"); }
else {
  const soloState = Object.keys(solo.animations)[0];
  await p.goto(`${W}#/objects/${solo.id}`, { waitUntil: "load" });
  await p.waitForTimeout(1600);
  const lone = await facet();
  console.log(`lone state (${solo.id}, ${soloState}):`, JSON.stringify({ label: lone.label, facetName: lone.facetName, pill: lone.pill }));
  ok(lone.present && lone.overPreview && lone.underTitle, "a piece with one state has it too, in the same place");
  ok(!!lone.facetName && lone.pill === `${lone.facetName} · S`, `judging what is on screen (${lone.pill})`);
}

// ----------------------------------------------------- monsters + characters
// Same feature, same place, same words — this is one wiki.
for (const [url, what, expectFacet] of [[`${W}#/monsters/mammoth`, "monster", "Idle"], [`${W}#/characters/default_boy`, "character", null]]) {
  await p.goto(url, { waitUntil: "load" });
  await p.waitForTimeout(1800);
  const f = await facet();
  console.log(`${what}:`, JSON.stringify({ label: f.label, under: f.underPreview, same: f.sameCard, stars: f.stars, comment: f.comment, facetName: f.facetName }));
  ok(f.present && f.sameCard && f.overPreview && f.underTitle,
    `the ${what} animation card puts it at the top of the card too — "same in both Scenery and the Monsters/players"`);
  ok(f.nothingBelowStage, `and nothing of it hangs below the ${what}'s art`);
  ok(/Judging/.test(f.label ?? "") && /·/.test(f.pill ?? ""), `naming the animation AND the direction (“${f.pill}”) — it read as a whole-entity verdict before`);
  ok(f.headAboveStates, `and on the ${what} too the label leads the selectors`);
  ok(f.starBox.w >= 28 && f.starBox.h >= 32, `with the same big stars (${f.starBox.w}x${f.starBox.h}px)`);
  ok(f.stars === 5 && f.approve && f.comment, `rate, accept and comment on the ${what}'s animation as well`);
  if (expectFacet) ok(f.facetName === expectFacet, `pointed at the state on screen (${f.facetName})`);
  // Eight directions, eight separately regenerable files.
  const dirSwap = await p.evaluate(async () => {
    const before = document.querySelector(".facet-head .pill")?.textContent;
    [...document.querySelectorAll(".dirpad button")].find((x) => x.textContent === "NE")?.click();
    await new Promise((r) => setTimeout(r, 400));
    return { before, after: document.querySelector(".facet-head .pill")?.textContent };
  });
  ok(dirSwap.after !== dirSwap.before && /NE$/.test(dirSwap.after ?? ""),
    `and the ${what}'s row follows the direction pad too (${dirSwap.before} → ${dirSwap.after})`);
}

// ---------------------------------------------- what is left to review
// Maintainer 2026-08-15: "it's hard for me to know what tree state I have left
// to review ... the admin will see the state text 1, 2 etc in green =
// approved, red = rejected. Then I know if it's normal color means I have not
// reviewed it yet. And the red and green has to be visible in the current
// dark/light-mode."
//
// A state chip summarises its directions; a direction button carries its own
// verdict exactly. Both must be legible on both themes, so this measures the
// CONTRAST of the painted colour against the page it sits on rather than
// trusting a hex value.
const contrast = (fg, bg) => {
  const lum = (c) => {
    const [r, g, b2] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map((v) => {
      const x = Number(v) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [a, b2] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b2 + 0.05);
};
for (const scheme of ["light", "dark"]) {
  const tctx = await b.newContext({ viewport: { width: 393, height: 851 }, colorScheme: scheme });
  const tp = await tctx.newPage();
  const terrs = []; tp.on("pageerror", (e) => terrs.push(String(e)));
  await tp.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
  await tp.addInitScript(() => {
    localStorage.setItem("wiki-admin-token", "gate");
    localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
  });
  // A monster: 8 directions per state, so the SUMMARY rule is exercised.
  await tp.goto(`${W}#/monsters/mammoth`, { waitUntil: "load" });
  await tp.waitForTimeout(2000);
  const chip = () => tp.evaluate(() => {
    const on = document.querySelector(".seg-states button.on");
    const dir = document.querySelector(".dirpad button.on");
    return { cls: on.className, color: getComputedStyle(on).color, title: on.title,
      dirCls: dir.className, dirColor: getComputedStyle(dir).color,
      bg: getComputedStyle(document.body).backgroundColor };
  });
  const plain = await chip();
  // One direction of eight: the STATE must not claim to be finished.
  await tp.evaluate(() => [...document.querySelectorAll(".facet-head .fb-row button")].find((x) => /approve/.test(x.textContent)).click());
  await tp.waitForTimeout(350);
  const one = await chip();
  console.log(`${scheme}: unreviewed ${plain.color} / 1-of-8 approved ${one.color} (${one.title})`);
  ok(!/judged/.test(plain.cls), `${scheme}: an unjudged state wears no colour — plain means "not reviewed yet"`);
  ok(!/judged-ok/.test(one.cls), `${scheme}: one direction of eight does NOT turn the state green (${one.title})`);
  ok(/judged-ok/.test(one.dirCls), `${scheme}: but that DIRECTION goes green immediately (${one.dirCls})`);
  ok(contrast(one.dirColor, one.bg) >= 3, `${scheme}: and it is legible on this theme (contrast ${contrast(one.dirColor, one.bg).toFixed(1)}:1 against the page)`);
  // Reject it — red outranks, because a rejection is the thing not to lose.
  await tp.evaluate(() => [...document.querySelectorAll(".facet-head .fb-row button")].find((x) => /✕/.test(x.textContent)).click());
  await tp.waitForTimeout(350);
  const no = await chip();
  ok(/judged-no/.test(no.cls) && /judged-no/.test(no.dirCls), `${scheme}: a rejection shows on the state as well as the direction (${no.title})`);
  ok(contrast(no.color, no.bg) >= 3, `${scheme}: red is legible too (contrast ${contrast(no.color, no.bg).toFixed(1)}:1)`);
  ok(no.color !== plain.color && one.dirColor !== plain.color, `${scheme}: judged and unjudged really are different colours`);
  // Clearing it puts the chip back to plain — the mark tracks the verdict.
  await tp.evaluate(() => [...document.querySelectorAll(".facet-head .fb-row button")].find((x) => /✕/.test(x.textContent)).click());
  await tp.waitForTimeout(350);
  ok(!/judged/.test((await chip()).dirCls), `${scheme}: clearing the verdict clears the colour`);
  ok(terrs.length === 0, `${scheme}: no page errors${terrs.length ? ` — ${terrs[0]}` : ""}`);
  await tctx.close();
}
// The two themes must not paint the same thing — dark green on a dark page
// would be exactly the bug he asked us to avoid.
console.log("(colours above are the theme's own --good/--bad tokens)");

// The public sees none of this — it is a Game Master's tool.
const pub = await ctx.browser().newContext({ viewport: { width: 393, height: 851 } });
const pp = await pub.newPage();
await pp.goto(`${W}#/objects/window_058`, { waitUntil: "load" });
await pp.waitForTimeout(1700);
ok(!(await pp.evaluate(() => !!document.querySelector(".facet-head"))), "and a visitor never sees it");
ok(!(await pp.evaluate(() => !!document.querySelector(".judged-ok, .judged-no"))),
  "nor the review marks on the chips — those are a Game Master's working notes");
await pub.close();

/* THE LIST SAYS WHAT A PIECE IS (maintainer 2026-08-29: "I want it to be
 * clearer to see how many states, directions and if it's animated ... a x3,
 * x7 pill in the top right corner. To hard to know now without clicking on
 * it"). Counted from the published clips, so the card cannot drift from what
 * the piece actually has. */
{
  await p.goto(`${W}#/objects`, { waitUntil: "load" });
  await p.waitForTimeout(3000);
  const cards = await p.evaluate(() => [...document.querySelectorAll("a.card")].slice(0, 40).map((c) => ({
    href: c.getAttribute("href"),
    count: c.querySelector(".thumb-count")?.textContent ?? "",
    play: !!c.querySelector(".thumb-play"),
    shape: (c.querySelector(".obj-shape")?.textContent ?? "").replace(/\s+/g, " ").trim(),
  })));
  ok(cards.length > 0, `the scenery list draws cards (${cards.length})`);
  const byId = new Map((DATA.domains.objects ?? []).map((o) => [o.id, o]));
  const shapeOf = (o) => {
    const anims = Object.values(o.animations ?? {});
    const dirs = new Set();
    let animated = 0;
    for (const a of anims) {
      let moves = false;
      for (const [d, c] of Object.entries(a.dirs ?? {})) { dirs.add(d); if ((c.frames ?? 1) > 1) moves = true; }
      if (moves) animated++;
    }
    return { states: anims.length, dirs: dirs.size, animated };
  };
  const wrong = [];
  for (const c of cards) {
    const o = byId.get((c.href ?? "").split("/").pop());
    if (!o) continue;
    const sh = shapeOf(o);
    if (sh.states > 1 && c.count !== `×${sh.states}`) wrong.push(`${o.id}: count ${c.count || "(none)"} vs ${sh.states}`);
    if (!!sh.animated !== c.play) wrong.push(`${o.id}: play ${c.play} vs animated ${sh.animated}`);
    if (sh.animated && !/animated/.test(c.shape)) wrong.push(`${o.id}: "${c.shape}" hides that it moves`);
    if (!sh.animated && !/static/.test(c.shape)) wrong.push(`${o.id}: "${c.shape}" does not say static`);
  }
  ok(wrong.length === 0, wrong.length ? `card shape wrong — ${wrong[0]} (${wrong.length})`
    : `every card's state count, animated mark and facings match its published clips (${cards.length} cards)`);
  ok(cards.some((c) => c.play) && cards.some((c) => /×\d/.test(c.count)),
    `and both marks appear while scrolling (${cards.filter((c) => c.play).length} animated, ${cards.filter((c) => c.count).length} with a state pill)`);
}
/* ONE FACT, ONE ANSWER: a verdict the chip no longer counts must not look
 * current in the row (maintainer 2026-08-30: "some states is not green even if
 * the state is approved when I click on the state"). His lit_3 on tree_064
 * carried a stamp from art that has since been regenerated, so facetMark read
 * it as unjudged and left the chip plain, while the row underneath went on
 * painting its approve button green. Reproduced here by stamping a verdict
 * with an art hash that matches nothing. */
{
  /* A SOUTH-ONLY PIECE, because a chip goes green only when EVERY direction of
   * its state is approved — on a piece with SE the green would be about the
   * directions, not about the staleness this section is measuring. */
  await p.goto(`${W}#/objects/ancient_tree_001`, { waitUntil: "load" });
  await p.waitForTimeout(2400);
  const chipCls = () => p.evaluate(() => [...document.querySelectorAll(".seg-states button")][0]?.className ?? "");
  const row = () => p.evaluate(() => {
    const f = document.querySelector(".facet-head .fb-row");
    return { cls: [...(f?.querySelectorAll("button") ?? [])].map((x) => x.className).join("|"),
             text: f?.textContent ?? "" };
  });
  const restamp = (art) => p.evaluate((a) => {
    const first = [...document.querySelectorAll(".seg-states button")][0];
    const st = first?.dataset?.state ?? "lit_1";
    window.__wiki.state.feedback.objects.entries[`scenery/ancient_trees/ancient_tree_001#${st}#south`] =
      { status: "approved", rating: 5, art: a, updated_at: new Date().toISOString() };
  }, art);
  const reaim = async () => {
    await p.evaluate(() => [...document.querySelectorAll(".seg-states button")][1]?.click());
    await p.waitForTimeout(350);
    await p.evaluate(() => [...document.querySelectorAll(".seg-states button")][0]?.click());
    await p.waitForTimeout(450);
  };
  await restamp("deadbeefdeadbeef");     // a hash belonging to no art that exists
  await reaim();
  const stale = await row();
  ok(!/approved/.test(stale.cls), `a verdict about vanished art does not paint the row green (${stale.cls})`);
  ok(/regenerated since/.test(stale.text), `and the row says why (“${stale.text.replace(/\s+/g, " ").slice(-40).trim()}”)`);
  ok(!/judged-ok/.test(await chipCls()), "which is the same answer its state chip gives");
  // One tap re-judges the art on screen: row and chip agree, the other way.
  await p.evaluate(() => [...document.querySelectorAll(".facet-head .fb-row button")].find((x) => /approve/.test(x.textContent))?.click());
  await p.waitForTimeout(500);
  const fresh = await row();
  ok(/approved/.test(fresh.cls) && !/regenerated since/.test(fresh.text),
    "judging it again makes the row current");
  await p.waitForTimeout(300);
  ok(/judged-ok/.test(await chipCls()), "and turns the chip green — one fact, told once");
}
/* THE SIZE REFERENCE IS GAME-TRUE (games agent, 2026-09-02: "THE SCENERY SIZE
 * REFERENCE MISLED THE MAINTAINER INTO GENERATING SMALL BEDS — it draws the
 * piece at its NATIVE sprite pixels beside the Man at his"). The game draws a
 * piece so its cropped height is world_px_height × characterBodyPx /
 * character_height_px and the Man at his art size. Measured here as the ratio
 * of what is actually on screen — the canvas beside the Man's element — so a
 * bed generated to look right in the wiki looks right in the game. */
{
  const D = JSON.parse((await import("node:fs")).readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
  const piece = (D.domains.objects ?? []).find((o) => o.id === "bed_005" && o.placement?.world_px_height)
    ?? (D.domains.objects ?? []).find((o) => o.placement?.world_px_height > 0 && Object.keys(o.animations ?? {}).length);
  ok(!!piece && !!D.sceneryScale, `a placed piece and the game's scale constants (${piece?.id}, ${JSON.stringify(D.sceneryScale)})`);
  if (piece && D.sceneryScale) {
    await p.goto(`${W}#/objects/${piece.id}`, { waitUntil: "load" });
    await p.waitForTimeout(2400);
    const measure = () => p.evaluate(() => {
      const c = document.querySelector(".player-stage canvas");
      const m = document.querySelector(".human-ref");
      const hb = window.__wikiHitbox;
      return { canvasH: c?.height ?? null, manH: m && m.style.display !== "none" ? parseFloat(m.style.height) : null, manShown: !!m && m.style.display !== "none" };
    });
    const off = await measure();
    await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => /vs human/.test(x.textContent))?.click());
    await p.waitForTimeout(900);
    const on = await measure();
    ok(on.manShown && on.manH > 0, `the Man appears beside the piece (${on.manH}px tall)`);
    // The clip on screen and its cropped height, from the same data the page uses.
    const st = Object.keys(piece.animations)[0];
    const clip = piece.animations[st]?.dirs?.south ?? Object.values(piece.animations[st]?.dirs ?? {})[0];
    const ch = clip?.bb ? clip.bb[3] - clip.bb[1] : null;
    const pl = piece.placement;
    const drawnPx = pl.world_px_height * D.sceneryScale.characterBodyPx / (pl.character_height_px || D.sceneryScale.contractCharacterPx);
    const boy = (D.domains.characters ?? []).find((c) => c.id === "default_boy");
    const manBB = boy?.animations?.idle?.dirs?.south?.bb;
    const manPx = manBB ? manBB[3] - manBB[1] : null;
    const wantRatio = drawnPx / manPx;
    // The canvas is cropped to the content box (plus the hitbox/overlay slack
    // that grows it), so compare piece-to-Man using the piece's own scale.
    const sPiece = await p.evaluate(() => window.__wikiScale?.s ?? null);
    const sMan = on.manH / manPx;
    ok(sPiece && sMan && Math.abs((sPiece / sMan) - (drawnPx / ch)) < 0.02,
      `beside the Man the piece is drawn at the GAME's placement scale — ${piece.id}: ${(sPiece / sMan).toFixed(3)}× its native px, want ${(drawnPx / ch).toFixed(3)} (world ${pl.world_px_height}px → drawn ${drawnPx.toFixed(1)}px over a ${ch}px crop)`);
    ok(Math.abs((drawnPx / manPx) - (pl.world_height_m / 1.7)) < 0.08,
      `which puts it at ${(drawnPx / manPx).toFixed(2)}× the Man — the contract's ${pl.world_height_m}m against 1.7m is ${(pl.world_height_m / 1.7).toFixed(2)}×`);
    await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => /vs human/.test(x.textContent))?.click());
    await p.waitForTimeout(700);
    const back = await measure();
    ok(!back.manShown && back.canvasH === off.canvasH,
      `and with the Man hidden the piece is back at its own scale (canvas ${off.canvasH} → ${on.canvasH} → ${back.canvasH})`);
  }
}
/* ONE VERDICT ON THE PIECE, TWO ON A STATE, AND EVERY OTHER PAGE SAYS "REMOVE"
 * (maintainer 2026-09-03: "You added 2 buttons (the redo button) on the
 * scenery object itself. That object should only have a remove button ... The
 * scenery states is the only review that should have both a 'remove' and
 * 'redo' button. All other review pages should only have the red 'remove'
 * button and it should be called 'remove' and nothing else!" — and the reason:
 * "If only one button exist it is a 'remove' button"). */
{
  const rgb = (s) => { const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(s ?? ""); return m ? m.slice(1, 4).map(Number).join(",") : null; };
  const bad = await p.evaluate(() => { const el = document.createElement("span"); el.style.color = "var(--bad)"; document.body.appendChild(el); const c = getComputedStyle(el).color; el.remove(); return c; });
  await p.goto(`${W}#/objects/ancient_tree_001`, { waitUntil: "load" });
  await p.waitForTimeout(2600);
  const rows = await p.evaluate(() => {
    const btns = (sel) => [...document.querySelectorAll(`${sel} .verdict button`)].map((b2) => ({ text: b2.textContent.trim(), cls: b2.className, color: getComputedStyle(b2).color }));
    return { piece: btns(".detail-head .fb-row"), facet: btns(".facet-head .fb-row") };
  });
  ok(rows.piece.length === 2 && /remove/.test(rows.piece[1]?.text) && !rows.piece.some((b2) => /redo/.test(b2.text)),
    `the PIECE takes approve and remove, no redo (${rows.piece.map((b2) => b2.text).join(" | ")})`);
  ok(rows.facet.length === 3 && /remove/.test(rows.facet[1]?.text) && /redo/.test(rows.facet[2]?.text),
    `a STATE takes approve, remove AND redo (${rows.facet.map((b2) => b2.text).join(" | ")})`);
  ok(rgb(rows.facet[1].color) === rgb(bad) && rgb(rows.piece[1].color) === rgb(bad),
    `both remove buttons wear --bad (${rows.facet[1].color})`);
  ok(!/redo/.test(rows.facet[1].text), `and the state's remove is not called redo — a lone red button must read as remove (“${rows.facet[1].text}”)`);
  // the state's redo stores "redo" on the FACET key, and withdraws
  const facetKey = await p.evaluate(() => { const pill = document.querySelector(".facet-head .pill")?.textContent ?? ""; return pill; });
  await p.evaluate(() => [...document.querySelectorAll(".facet-head .fb-row .verdict button")].find((b2) => /redo/.test(b2.textContent))?.click());
  await p.waitForTimeout(400);
  const stored = await p.evaluate(() => {
    const e = window.__wiki.state.feedback.objects.entries;
    const k = Object.keys(e).find((x) => x.startsWith("scenery/ancient_trees/ancient_tree_001#") && e[x].status === "redo");
    return { k, piece: e["scenery/ancient_trees/ancient_tree_001"]?.status ?? null };
  });
  // The piece may legitimately carry its own verdict (an earlier section
  // approves it); what must never happen is REDO landing on the piece.
  ok(stored.k && stored.k.split("#").length === 3 && stored.piece !== "redo",
    `Redo is stored on the STATE's own key, never on the piece (${stored.k}; piece verdict: ${stored.piece})`);
  await p.evaluate(() => [...document.querySelectorAll(".facet-head .fb-row .verdict button")].find((b2) => /redo/.test(b2.textContent))?.click());
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => !Object.entries(window.__wiki.state.feedback.objects.entries).some(([k, v]) => k.startsWith("scenery/ancient_trees/ancient_tree_001#") && v.status === "redo")),
    "pressing it again withdraws the redo");
  /* AND NO OTHER REVIEW PAGE OFFERS ANYTHING BUT REMOVE. Walked, not assumed:
   * a monster facet, a character facet, a tiles pair and the music bench. The
   * two designation toggles are deliberately NOT reject buttons — a `#top`
   * "not a detail" and a binding's "unbind" leave the asset untouched, so
   * calling either "remove" would say the opposite of what it does; they are
   * reported to the maintainer rather than silently renamed. */
  const DD = JSON.parse((await import("node:fs")).readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
  const pages = [["#/monsters/" + (DD.domains.monsters?.[0]?.id ?? ""), "a monster"],
                 ["#/characters/" + (DD.domains.characters?.find((c) => c.kind === "npc")?.id ?? ""), "an NPC"],
                 ["#/world/transition/grass__to__ice", "a fade pair"],
                 ["#/music", "the music page"]];
  const offenders = [];
  for (const [hash, what] of pages) {
    await p.goto(`${W}${hash}`, { waitUntil: "load" });
    await p.waitForTimeout(hash.includes("transition") ? 4500 : 2600);
    const labels = await p.evaluate(() => [...document.querySelectorAll(".verdict button")]
      .filter((b2) => /reject-btn/.test(b2.className)).map((b2) => b2.textContent.trim()));
    for (const l of labels) if (!/^✕ remove$/.test(l)) offenders.push(`${what}: “${l}”`);
    if (labels.length) ok(labels.every((l) => /^✕ remove$/.test(l)), `${what}: every reject button is called “✕ remove” (${[...new Set(labels)].join(", ")})`);
  }
  ok(offenders.length === 0, offenders.length ? `a page still names it something else — ${offenders[0]}` : "no review page names it anything but remove");
  const redoElsewhere = await p.evaluate(() => [...document.querySelectorAll(".verdict button")].some((x) => /redo-btn/.test(x.className)));
  ok(!redoElsewhere, "and Redo appears nowhere but a scenery state");
}
/* ONE TAP, NOT TWO (maintainer 2026-09-03: "you should click approve for me
 * when I click on a star and unapprove when/if I press that same star again.
 * Also if I unapprove you should remove the star. This way I only have to
 * click once on the star"). Driven through the real controls on the scenery
 * facet row, which is the one row that also carries an art stamp — a star that
 * approved WITHOUT the stamp would be written stale, and the row would tell
 * him to judge again the moment he judged. */
{
  // Back to the window — the checks above walk other pages, and this one wants
  // a facet row that carries an art stamp.
  await p.goto(`${W}#/objects/window_058`, { waitUntil: "load" });
  await p.waitForTimeout(2600);
  await p.evaluate(() => {
    const e = window.__wiki.state.feedback.objects?.entries ?? {};
    for (const k of Object.keys(e)) if (/^scenery\/windows\/window_058#/.test(k)) delete e[k];
    window.__wiki.route();
  });
  await p.waitForTimeout(1200);
  const row = () => p.evaluate(() => {
    const r = document.querySelector(".facet-head .fb-row");
    const approve = [...r.querySelectorAll("button")].find((x) => /approve/i.test(x.textContent));
    // The FACET's own stars — the piece is judged by a second row further up
    // the page, and reading that one measured his week instead of the click.
    const key = r.querySelector(".stars")?.__fbk?.split("\u0000") ?? null;
    const rec = key ? (window.__wiki.state.feedback[key[0]]?.entries?.[key[1]] ?? {}) : {};
    return {
      lit: r.querySelectorAll(".stars button.lit").length,
      approved: !!approve?.classList.contains("approved"),
      status: rec.status ?? null, rating: rec.rating ?? null, stamped: !!rec.art,
      stale: /regenerated since/i.test(r.textContent),
    };
  });
  const star = (n) => p.evaluate((k) => document.querySelectorAll(".facet-head .fb-row .stars button")[k - 1].click(), n)
    .then(() => p.waitForTimeout(250));

  await star(4);
  const a = await row();
  console.log("after tapping star 4 :", JSON.stringify(a));
  ok(a.lit === 4 && a.rating === 4, `a star still rates (${a.lit} lit, rating ${a.rating})`);
  ok(a.approved && a.status === "approved", "...and approves in the same tap — no second press");
  ok(a.stamped && !a.stale, "...stamped with the art on screen, so it is not born stale");

  await star(4);
  const b = await row();
  console.log("after tapping star 4 again:", JSON.stringify(b));
  ok(!b.approved && b.status === null, "pressing that same star again un-approves");
  ok(b.lit === 0 && b.rating === null, "...and takes the stars with it");

  await star(3);
  await p.evaluate(() => [...document.querySelectorAll(".facet-head .fb-row button")].find((x) => /approve/i.test(x.textContent)).click());
  await p.waitForTimeout(250);
  const c = await row();
  console.log("after un-approving by button:", JSON.stringify(c));
  ok(!c.approved && c.status === null, "un-approving with the button clears the verdict");
  ok(c.lit === 0 && c.rating === null, `...and removes the star (${c.lit} lit) — "if I unapprove you should remove the star"`);

  /* A REJECTION IS NOT A STAR'S TO UNDO: he asked for star -> approve, and
   * nothing about remove. Rating something he rejected must not silently
   * un-reject... it re-judges it as approved (that is what a star says), but
   * un-starring it must not resurrect the rejection either. */
  await p.evaluate(() => [...document.querySelectorAll(".facet-head .fb-row button")].find((x) => /✕ remove/i.test(x.textContent)).click());
  await p.waitForTimeout(250);
  await star(2);
  const d = await row();
  ok(d.status === "approved" && d.rating === 2, `starring a removed state judges it approved (${d.status}, ${d.rating} stars)`);
  await star(2);
  const e2 = await row();
  ok(e2.status === null && e2.rating === null, "and un-starring leaves it undecided, not re-rejected");

  /* REMOVE ALWAYS UNSTARS, AND APPROVE IS WORTH A STAR (maintainer 2026-09-03:
   * "Remove should also always 'unstar' and accept should give 1 star if no
   * star has been given already"). */
  const press = (re) => p.evaluate((r) => [...document.querySelectorAll(".facet-head .fb-row button")]
    .find((x) => new RegExp(r, "i").test(x.textContent)).click(), re.source).then(() => p.waitForTimeout(250));
  await star(5);
  await press(/✕ remove/);
  const f = await row();
  console.log("after removing a 5-star state:", JSON.stringify(f));
  ok(f.status === "rejected", "remove still removes");
  ok(f.lit === 0 && f.rating === null, `...and always unstars (${f.lit} lit) — a rating must not outlive the thing it rated`);

  await press(/✕ remove/);                       // withdraw it, back to undecided
  await press(/approve/);
  const g2 = await row();
  console.log("after approving an unrated state:", JSON.stringify(g2));
  ok(g2.status === "approved" && g2.rating === 1 && g2.lit === 1,
    `approving something unrated gives it one star (${g2.rating})`);

  await press(/approve/);                        // clear
  /* A RATING HE ALREADY GAVE SURVIVES THE APPROVAL. Rated-but-unjudged is a
   * real record — it is what every star he gave before today looks like — so
   * it is written straight into the store rather than clicked into being. */
  await p.evaluate(() => {
    const key = document.querySelector(".facet-head .fb-row .stars").__fbk.split("\u0000");
    window.__wiki.setFb(key[0], key[1], { rating: 4, status: null });
    window.__wiki.route();
  });
  await p.waitForTimeout(1200);
  await press(/approve/);
  const h2 = await row();
  console.log("after approving a 4-star state:", JSON.stringify(h2));
  ok(h2.status === "approved" && h2.rating === 4, `and a rating he DID give is never overwritten by that 1 (${h2.rating} stars)`);
  await star(3);                                 // a DIFFERENT star: changing his mind, not withdrawing
  const i2 = await row();
  ok(i2.rating === 3 && i2.status === "approved", `moving to another star re-rates without withdrawing the approval (${i2.rating} stars, ${i2.status})`);

  await p.evaluate(() => {
    const ee = window.__wiki.state.feedback.objects?.entries ?? {};
    for (const k of Object.keys(ee)) if (/^scenery\/windows\/window_058#/.test(k)) delete ee[k];
  });
}

/* THE PIECE SAYS WHETHER IT IS DRAWN AT ITS OWN PIXELS (maintainer 2026-09-04:
 * "what I want is for the scenery to be drawn in the same scale as the player
 * is drawn ... I don't want any smart logic here"). Until the art is
 * regenerated at the size its metres imply, the game resamples it, and the
 * only honest thing this page can do is print the number. Read off a piece
 * whose disagreement is known and large, and off one drawn the other way. */
{
  for (const [id, want] of [["bed_002", "under"], ["ancient_tree_001", "over"]]) {
    await p.goto(`${W}#/objects/${id}`, { waitUntil: "load" });
    await p.waitForTimeout(3200);
    const s = await p.evaluate(() => {
      const el = document.querySelector(".scale-pill");
      return el ? { text: el.textContent, f: +el.dataset.factor, warn: el.classList.contains("warn"), title: el.title } : null;
    });
    console.log(`${id} scale pill:`, JSON.stringify(s && { text: s.text, f: s.f, warn: s.warn }));
    ok(!!s, `${id} says what scale it is drawn at`);
    if (!s) continue;
    ok(want === "under" ? s.f < 0.98 : s.f > 1.02,
      `${id} is resampled ${want === "under" ? "down" : "up"} and the pill agrees (${s.f}×)`);
    ok(s.warn && /→ drawn/.test(s.text), `and it reads as a fault, not a decoration ("${s.text}")`);
    ok(/resampled/.test(s.title) && /art wants to be/.test(s.title),
      "and says what the art should have been, which is the fix");
  }
}

/* ...AND THE SAME ON EVERY OTHER REVIEW PAGE, walked rather than assumed. */
{
  const DD2 = JSON.parse((await import("node:fs")).readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
  const pages = [["#/objects/ancient_tree_001", "scenery"],
                 ["#/monsters/" + (DD2.domains.monsters?.[0]?.id ?? ""), "a monster"],
                 ["#/world/transition/grass__to__ice", "a fade pair"],
                 ["#/items/" + (DD2.domains.items?.[0]?.id ?? ""), "an item"]];
  const small = [];
  for (const [hash, what] of pages) {
    await p.goto(`${W}${hash}`, { waitUntil: "load" });
    await p.waitForTimeout(hash.includes("transition") ? 4500 : 2600);
    const m = await p.evaluate(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: r.top, bottom: r.bottom }; };
      const star = document.querySelector(".stars button");
      const verdict = document.querySelector(".verdict button");
      const note = document.querySelector(".fb-note");
      const row = note?.closest(".fb-row") ?? null;
      const above = row ? [...row.querySelectorAll(".verdict button, .stars button")].map((b2) => b2.getBoundingClientRect().bottom) : [];
      return {
        star: star ? box(star) : null, verdict: verdict ? box(verdict) : null,
        gap: note && above.length ? Math.round(note.getBoundingClientRect().top - Math.max(...above)) : null,
      };
    });
    if (m.star && (m.star.w < 34 || m.star.h < 40)) small.push(`${what}: star ${m.star.w}x${m.star.h}`);
    if (m.verdict && m.verdict.h < 38) small.push(`${what}: verdict ${m.verdict.w}x${m.verdict.h}`);
    if (m.star || m.verdict) {
      ok(!small.length, `${what}: the stars and verdict buttons are thumb-sized (star ${m.star?.w}x${m.star?.h}, button ${m.verdict?.w}x${m.verdict?.h})`);
    }
    if (m.gap !== null) ok(m.gap >= 8, `${what}: the note sits clear of the buttons above it (${m.gap}px)`);
  }
  ok(small.length === 0, small.length ? `a control is still small — ${small[0]}` : "no review page has a small control left");
}
console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL FACET-FEEDBACK CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
