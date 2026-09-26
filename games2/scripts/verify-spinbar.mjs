// QA: the SPIN BAR (client/src/spinbar.ts) — his rotating orb between two
// arrow buttons, on the line directly under the HP/EP card (maintainer
// 2026-09-26: "I want the animation to be in center and a arrow left button on
// the left side and arrow right button on the right side… The left button
// should align with the card left. The right button should align with the card
// right. The animation in the middle").
//
// THE STYLE ARM IS A COMPARISON, NOT A LIST OF NUMBERS — the same rule
// verify-recbtn is built on. "Look like the wiki search button in size" is only
// true relative to that button, so every shared property is read off the LIVE
// .ml-wikinear and required to match: restyle the search square and this fails
// until the arrows follow. Literals here would pass on the day they drifted.
//
// WHAT ELSE IT HOLDS, each of them a thing his brief says in so many words:
// both of the bar's edges against the card's, the orb centred between them,
// the orb NOT a button ("the gif should be in the middle (not a button)"), ONE
// bake mirrored rather than two files, the /ui2 natural/2 scale, and the
// rotation arithmetic — a press lands on frame 0 (the quarter boundary), right
// then left returns to where it started, and four rights come back round.
//
// IT DOES NOT SAMPLE A FRAME MID-FLIGHT. The headless compositor here is
// starved to ~1 s frames, so one rAF can carry the whole 360 ms animation and
// any "is it on frame 4 yet" arm would be a coin toss. What IS deterministic is
// that spin() takes its lock synchronously inside the click handler, so the
// gate asserts the lock, then the landing.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);

const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(`${BASE}/`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 90000 });
await page.waitForFunction(() => document.querySelector(".ml-spinbar") && document.querySelector(".ml-bars-l"), null, { timeout: 30000 });
// the strip's frame count is read from the decoded art, so wait for it
await page.waitForFunction(() => window.__mlSpin && window.__mlSpin().frames > 0, null, { timeout: 30000 })
  .catch(() => fail("the strip never decoded — __mlSpin().frames stayed 0"));

// ── 1. HIS TWO EDGES, AND THE ORB BETWEEN THEM ─────────────────────────────
{
  const g = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null;
      const b = e.getBoundingClientRect();
      return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
    return { card: r(".ml-bars-l"), bar: r(".ml-spinbar"), L: r(".ml-spinbtn.left"), R: r(".ml-spinbtn.right"), orb: r(".ml-spinorb") };
  });
  if (!g.bar || !g.L || !g.R || !g.orb) fail("the bar did not mount all three of its parts");
  else {
    Math.abs(g.L.l - g.card.l) <= 1
      ? ok(`the left button is on the card's left edge (${g.L.l} vs ${g.card.l})`)
      : fail(`left button at x=${g.L.l}, the card at x=${g.card.l} — "the left button should align with the card left"`);
    Math.abs(g.R.r - g.card.r) <= 1
      ? ok(`the right button is on the card's right edge (${g.R.r} vs ${g.card.r})`)
      : fail(`right button ends at x=${g.R.r}, the card at x=${g.card.r} — "the right button should align with the card right"`);
    const orbMid = (g.orb.l + g.orb.r) / 2, cardMid = (g.card.l + g.card.r) / 2;
    Math.abs(orbMid - cardMid) <= 1
      ? ok(`and the animation is in the middle (orb centre ${orbMid}, card centre ${cardMid})`)
      : fail(`orb centre ${orbMid}, card centre ${cardMid} — "the animation in the middle"`);
    // it must clear its neighbours rather than merely be centred between them
    g.orb.l >= g.L.r && g.orb.r <= g.R.l
      ? ok(`the three do not overlap (${g.L.l}-${g.L.r} | ${g.orb.l}-${g.orb.r} | ${g.R.l}-${g.R.r})`)
      : fail(`the orb (${g.orb.l}-${g.orb.r}) overlaps a button (${g.L.l}-${g.L.r}, ${g.R.l}-${g.R.r})`);
    g.bar.t - g.card.b === 10
      ? ok(`it hangs the project's one 10px margin under the card`)
      : fail(`the bar sits ${g.bar.t - g.card.b}px under the card — the project has one 10px margin`);
  }
}

// ── 2. THE SEARCH SQUARE'S CLOTHES, read off the live one ──────────────────
{
  const s = await page.evaluate(() => {
    const pick = (e) => { const c = getComputedStyle(e); return {
      width: c.width, height: c.height, boxSizing: c.boxSizing, padding: c.padding,
      borderTopWidth: c.borderTopWidth, borderTopColor: c.borderTopColor, borderTopLeftRadius: c.borderTopLeftRadius,
      boxShadow: c.boxShadow, backgroundColor: c.backgroundColor, backdropFilter: c.backdropFilter, color: c.color }; };
    const near = document.querySelector(".ml-wikinear");
    return near ? { near: pick(near), L: pick(document.querySelector(".ml-spinbtn.left")), R: pick(document.querySelector(".ml-spinbtn.right")) } : null;
  });
  if (!s) fail("the 🔍 button is not mounted — nothing to compare the arrows against");
  else {
    for (const [which, got] of [["left", s.L], ["right", s.R]]) {
      const off = Object.keys(s.near).filter((k) => s.near[k] !== got[k]);
      off.length === 0
        ? ok(`the ${which} arrow wears the 🔍 square exactly (${Object.keys(s.near).length} properties, all equal)`)
        : fail(`the ${which} arrow differs from .ml-wikinear on ${off.map((k) => `${k}: ${got[k]} vs ${s.near[k]}`).join(", ")}`);
    }
  }
}

// ── 3. ONE BAKE, MIRRORED — and the /ui2 natural/2 scale ───────────────────
{
  const i = await page.evaluate(() => {
    const g = (s) => { const e = document.querySelector(s); const c = getComputedStyle(e);
      return { src: e.getAttribute("src"), t: c.transform, w: Math.round(e.getBoundingClientRect().width),
               nat: e.naturalWidth, natH: e.naturalHeight }; };
    return { L: g(".ml-spinbtn.left .ml-spinbtn-icon"), R: g(".ml-spinbtn.right .ml-spinbtn-icon") };
  });
  i.L.src === i.R.src
    ? ok(`one bake serves both buttons (${i.L.src})`)
    : fail(`two different files: ${i.L.src} and ${i.R.src} — his art should be baked once and mirrored`);
  i.L.t === "matrix(-1, 0, 0, 1, 0, 0)" && i.R.t === "none"
    ? ok(`the left one is mirrored and the right one is not ("one has to be flipped")`)
    : fail(`left transform ${i.L.t}, right ${i.R.t} — exactly one of them must be flipped`);
  i.R.nat > 0 && i.R.w === i.R.nat / 2
    ? ok(`and it renders at its authored grid: ${i.R.nat}px bake shown at ${i.R.w}px`)
    : fail(`the arrow is ${i.R.nat}px baked and shown at ${i.R.w}px — /ui2 art renders at naturalWidth/2`);
}

// ── 4. NOT A BUTTON ────────────────────────────────────────────────────────
{
  const o = await page.evaluate(() => {
    const e = document.querySelector(".ml-spinorb"); const c = getComputedStyle(e);
    return { tag: e.tagName, role: e.getAttribute("role"), tab: e.getAttribute("tabindex"),
             pe: c.pointerEvents, bg: c.backgroundImage, size: c.backgroundSize };
  });
  o.tag === "DIV" && !o.role && o.tab === null && o.pe === "none"
    ? ok(`the orb takes no press: a plain <div>, pointer-events none, no role, not focusable`)
    : fail(`the orb reads as interactive (<${o.tag}> role=${o.role} tabindex=${o.tab} pointer-events=${o.pe}) — "not a button"`);
  /spin-orb\.webp/.test(o.bg)
    ? ok(`and it wears the strip (${o.size})`)
    : fail(`the orb's background is ${o.bg} — it should be the baked strip`);
}

// ── 4b. HIS CUBE AT TRUE PIXEL SIZE ───────────────────────────────────────
// (maintainer 2026-09-26: "I did the new cube bigger because the old cube
// wasn't big enough" — he chose one art pixel per point over the orb's slot.)
// Read against the DECODED strip, not a literal: the box must be natural/2 of
// the bake on both axes, and the row must hold it without the arrows moving off
// its centre line.
{
  const c = await page.evaluate(async () => {
    const e = document.querySelector(".ml-spinorb");
    const url = getComputedStyle(e).backgroundImage.replace(/^url\(["']?/, "").replace(/["']?\)$/, "");
    const im = new Image(); im.src = url; await im.decode();
    const b = e.getBoundingClientRect(), bar = document.querySelector(".ml-spinbar").getBoundingClientRect();
    const L = document.querySelector(".ml-spinbtn.left").getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), natH: im.naturalHeight, size: getComputedStyle(e).backgroundSize,
             barH: Math.round(bar.height), orbMidY: b.top + b.height / 2, btnMidY: L.top + L.height / 2 };
  });
  c.natH > 0 && c.h === c.natH / 2 && c.w === c.natH / 2
    ? ok(`his art at its own grid: an ${c.natH}px bake shown at ${c.w}x${c.h} (${c.size})`)
    : fail(`the middle art is ${c.w}x${c.h} for an ${c.natH}px bake — /ui2 art renders at natural/2`);
  c.barH >= c.h && Math.abs(c.orbMidY - c.btnMidY) <= 0.5
    ? ok(`the row holds it (${c.barH}px) and the arrows sit on its centre line`)
    : fail(`row ${c.barH}px for a ${c.h}px cube, centres ${c.orbMidY} vs ${c.btnMidY}`);
}

// ── 5. THE ROTATION: a press is a quarter, and it lands on the boundary ────
{
  const frames = await page.evaluate(() => window.__mlSpin().frames);
  // NOTHING WAS DROPPED, read against his own export. A GIF's frames are its
  // Graphic Control Extension blocks (21 F9 04), which is countable without a
  // decoder — and counting them is the whole assertion: his source is a CLOSED
  // loop, so N frames are N authored transitions and a trim replaces two of
  // them with a join covering twice the rotation. That shipped once, at 8 of 9,
  // and he saw the seam the same day ("the rotation animation snaps at the last
  // frame"). A gate on "divides evenly" would have passed it.
  const gif = readFileSync(new URL("../client/ui-src/spin-orb-src.gif", import.meta.url));
  let authored = 0;
  for (let i = 0; i + 2 < gif.length; i++)
    if (gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 0x04) authored++;
  frames === authored && authored > 0
    ? ok(`the strip carries every frame of his export (${frames} of ${authored}) — a closed loop keeps all of them`)
    : fail(`the strip has ${frames} frames of his ${authored}: trimming a closed loop puts a double-step at the cut`);

  // A TAP MOVES THE TARGET, it does not queue an animation — everything below
  // is that one fact. The target arithmetic is synchronous inside the click
  // handler, so these arms read it directly instead of racing the compositor.
  const tap = (sel, n = 1) => page.evaluate(([s, n]) => {
    const before = window.__mlSpin();
    for (let i = 0; i < n; i++) document.querySelector(s).click();
    return { before, after: window.__mlSpin() };
  }, [sel, n]);
  // 60s, and it is not slack: the loop clamps dt to 200 ms so a backgrounded
  // tab cannot teleport the orb, and this harness's frames are ~1 s apart, so
  // every real second of travel costs about five here. A 360° journey is 1.6 s
  // on a phone and ~8 s in this browser. Do not tighten it back to a number
  // that looks like the animation's own duration.
  const settle = async () => {
    await page.waitForFunction(() => !window.__mlSpin().spinning, null, { timeout: 60000 });
    return page.evaluate(() => window.__mlSpin());
  };

  {
    const t = await tap(".ml-spinbtn.right");
    t.after.targetQ - t.before.targetQ === 1 && t.after.spinning
      ? ok(`one tap puts the target a quarter ahead at once and starts the travel`)
      : fail(`one tap moved the target ${t.after.targetQ - t.before.targetQ} quarters, spinning=${t.after.spinning}`);
    const r = await settle();
    r.quarter === 1 && r.frame === 0 && r.curQ === r.targetQ
      ? ok(`right lands a quarter on, on frame 0 — "a perfect 90° rotation"`)
      : fail(`right settled at quarter ${r.quarter}, frame ${r.frame}, curQ ${r.curQ} vs targetQ ${r.targetQ}`);
    const l = await tap(".ml-spinbtn.left"); void l;
    const back = await settle();
    back.quarter === 0 && back.frame === 0
      ? ok(`left plays it backwards and returns it (quarter 0, frame 0)`)
      : fail(`left settled at quarter ${back.quarter}, frame ${back.frame}`);
  }

  // ── TAPS ACCUMULATE: "twice… 180°. 3 taps = 270°. 4 taps = 360°" ─────────
  for (const [n, deg] of [[2, 180], [3, 270], [4, 360]]) {
    const t = await tap(".ml-spinbtn.right", n);
    const moved = t.after.targetQ - t.before.targetQ;
    moved === n
      ? ok(`${n} quick taps ask for ${deg}° of travel (target moved ${moved} quarters, not normalised to ${deg % 360}°)`)
      : fail(`${n} taps moved the target ${moved} quarters — they must accumulate to ${deg}°`);
    const r = await settle();
    r.curQ === r.targetQ && r.frame === 0 && r.quarter === ((n % 4) + 4) % 4
      ? ok(`…and it travels all of it, landing on frame 0 at quarter ${r.quarter}`)
      : fail(`after ${n} taps it settled at curQ ${r.curQ} (target ${r.targetQ}), frame ${r.frame}, quarter ${r.quarter}`);
    // put it back for the next round, in one journey
    await tap(".ml-spinbtn.left", n);
    await settle();
  }

  // A settled position is reduced by a whole turn (spinbar.ts), so -1 quarter
  // reads back as 3. Mid-flight values are unwrapped; settled ones are not.
  const wrapQ = (q) => ((q % 4) + 4) % 4;

  // ── REVERSING MID-FLIGHT ─────────────────────────────────────────────────
  // "if the player presses the left arrow and then the right arrow during the
  // animation the animation should change animation direction immidiatly and
  // go back to the original position."
  // Driven as a FOUR-quarter journey, not one: a single quarter is ~2 frames
  // on this starved harness and the interrupt can fall between polls. Four is
  // the same code path with room to actually catch it in flight.
  {
    const home = (await page.evaluate(() => window.__mlSpin())).targetQ;
    await tap(".ml-spinbtn.left", 4);
    await page.waitForFunction(
      (h) => { const s = window.__mlSpin(); return s.spinning && s.curQ < h - 0.2; },
      home, { timeout: 30000, polling: 50 },
    ).catch(() => fail("the orb never showed up mid-flight — nothing to interrupt"));
    const mid = await tap(".ml-spinbtn.right", 4);
    mid.after.targetQ === home
      ? ok(`tapping the other way mid-flight puts the target straight back (${mid.before.targetQ} -> ${mid.after.targetQ})`)
      : fail(`the reverse taps left the target at ${mid.after.targetQ}, not the original ${home}`);
    mid.after.curQ < home && mid.after.curQ > home - 4
      ? ok(`…while the orb is still part-way round (curQ ${mid.after.curQ.toFixed(2)}), so it has a short way home`)
      : fail(`at the reverse tap the orb was at curQ ${mid.after.curQ} — expected between ${home - 4} and ${home}`);
    const r = await settle();
    r.curQ === wrapQ(home) && r.frame === 0
      ? ok(`and it turns round on the spot rather than finishing the lap: back at curQ ${r.curQ}, frame 0`)
      : fail(`after the reversal it settled at curQ ${r.curQ}, frame ${r.frame} — wanted ${wrapQ(home)} and frame 0`);
  }

  // ── NEVER THE LONG WAY ROUND ─────────────────────────────────────────────
  // "the rotation should always [take] the shortest rotation towards the goal
  // and not spin around if going backwards is a shorter rotational distance."
  // With an UNWRAPPED target the long way is not expressible, so the arm is
  // that the travel equals the target's own distance — never that plus a turn.
  {
    const a = await page.evaluate(() => window.__mlSpin());
    await tap(".ml-spinbtn.left", 3);
    await tap(".ml-spinbtn.right", 2); // net one quarter left, asked in two bursts
    const t = await page.evaluate(() => window.__mlSpin());
    t.targetQ === a.targetQ - 1
      ? ok(`bursts net out on the target (3 left + 2 right = one quarter left)`)
      : fail(`3 left + 2 right left the target at ${t.targetQ}, not ${a.targetQ - 1}`);
    const r = await settle();
    r.curQ === wrapQ(a.targetQ - 1) && r.frame === 0
      ? ok(`…and the orb travels exactly that, never a turn more (curQ ${r.curQ})`)
      : fail(`it settled at curQ ${r.curQ}, wanted ${wrapQ(a.targetQ - 1)}`);
    await tap(".ml-spinbtn.right");
    await settle();
  }
}

// ── 6. THE TARGET IS BIGGER THAN THE BUTTON ────────────────────────────────
// Measured by HITTING it, not by reading the CSS back: elementFromPoint is what
// the finger does (maintainer 2026-09-26: "I dont want the player to missclick
// here so you need to make the button hitbox 25% bigger in width and height").
{
  const h = await page.evaluate(() => {
    const L = document.querySelector(".ml-spinbtn.left");
    const b = L.getBoundingClientRect();
    const midY = b.top + b.height / 2, midX = b.left + b.width / 2;
    const owns = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && (e === L || L.contains(e)); };
    // 34 -> 42.5 means 4.25px of reach on each side: 3px out must hit, 6px must not
    return { painted: { w: Math.round(b.width), h: Math.round(b.height) },
             inLeft: owns(b.left - 3, midY), outLeft: owns(b.left - 6, midY),
             inTop: owns(midX, b.top - 3), outTop: owns(midX, b.bottom + 6),
             inBottom: owns(midX, b.bottom + 3),
             rec: (() => { const r = document.querySelector(".ml-rec"); if (!r) return null;
               const rb = r.getBoundingClientRect();
               return owns(rb.left + 4, rb.top + 4); })() };
  });
  h.painted.w === 34 && h.painted.h === 34
    ? ok(`the painted box is still the 🔍 square's 34x34 — the growth is invisible`)
    : fail(`the painted box is ${h.painted.w}x${h.painted.h}; it must stay the search square's 34x34`);
  h.inLeft && h.inTop && h.inBottom
    ? ok(`the target reaches 3px past the paint on every side — a press there lands`)
    : fail(`3px outside the paint missed: left=${h.inLeft} top=${h.inTop} bottom=${h.inBottom}`);
  !h.outLeft && !h.outTop
    ? ok(`…and stops before 6px, so it is the asked-for 25% and not a free-for-all`)
    : fail(`the target still answers 6px out (left=${h.outLeft} below=${h.outTop}) — that is more than 25%`);
  h.rec === false || h.rec === null
    ? ok(`and it does not reach into the Report button under it`)
    : fail(`the grown target steals the Report button's own corner`);
}

// ── 7. LANDSCAPE: the card moves, both edges follow ────────────────────────
{
  await page.setViewportSize({ width: 851, height: 393 });
  await page.waitForTimeout(1200); // the rotation snaps under a veil (hud.ts)
  const g = await page.evaluate(() => {
    const r = (s) => { const b = document.querySelector(s).getBoundingClientRect();
      return { l: Math.round(b.left), r: Math.round(b.right) }; };
    return { card: r(".ml-bars-l"), L: r(".ml-spinbtn.left"), R: r(".ml-spinbtn.right") };
  });
  Math.abs(g.L.l - g.card.l) <= 1 && Math.abs(g.R.r - g.card.r) <= 1
    ? ok(`in landscape it still spans the card exactly (${g.L.l}-${g.R.r} against ${g.card.l}-${g.card.r})`)
    : fail(`landscape: bar ${g.L.l}-${g.R.r}, card ${g.card.l}-${g.card.r} — both edges must follow`);
}

await browser.close();
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
