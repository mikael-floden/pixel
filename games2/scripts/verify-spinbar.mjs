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

// ── 5. THE ROTATION: a press is a quarter, and it lands on the boundary ────
{
  const frames = await page.evaluate(() => window.__mlSpin().frames);
  frames > 0 && frames % 4 === 0
    ? ok(`the strip is ${frames} frames — a whole number of them per full turn`)
    : fail(`the strip is ${frames} frames; a quarter-turn strip must divide a full turn evenly`);

  const press = async (sel) => {
    // spin() takes its lock synchronously inside the handler, so this reads
    // the lock rather than racing the starved compositor for a frame.
    const during = await page.evaluate((s) => {
      const before = window.__mlSpin().quarter;
      document.querySelector(s).click();
      return { before, ...window.__mlSpin() };
    }, sel);
    await page.waitForFunction(() => !window.__mlSpin().spinning, null, { timeout: 10000 });
    return { during, after: await page.evaluate(() => window.__mlSpin()) };
  };

  const right = await press(".ml-spinbtn.right");
  right.during.spinning && right.during.quarter === right.during.before
    ? ok(`a press starts the animation and holds the quarter until it lands`)
    : fail(`after the click spinning=${right.during.spinning}, quarter ${right.during.before}->${right.during.quarter} — the quarter must only turn over at the end`);
  right.after.quarter === 1 && right.after.frame === 0
    ? ok(`right turns one quarter and ends on frame 0 — "a perfect 90° rotation"`)
    : fail(`right left it at quarter ${right.after.quarter}, frame ${right.after.frame} (wanted quarter 1, frame 0)`);

  const left = await press(".ml-spinbtn.left");
  left.after.quarter === 0 && left.after.frame === 0
    ? ok(`left plays it backwards and returns it (quarter 0, frame 0)`)
    : fail(`left left it at quarter ${left.after.quarter}, frame ${left.after.frame} (wanted quarter 0, frame 0)`);

  for (let i = 0; i < 4; i++) await press(".ml-spinbtn.right");
  const round = await page.evaluate(() => window.__mlSpin());
  round.quarter === 0 && round.frame === 0
    ? ok(`and four of them come back round to where it started`)
    : fail(`four right presses ended at quarter ${round.quarter}, frame ${round.frame}`);
}

// ── 6. LANDSCAPE: the card moves, both edges follow ────────────────────────
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
