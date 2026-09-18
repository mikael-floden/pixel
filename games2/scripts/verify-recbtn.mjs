// QA: the RECORD BUTTON (client/src/recbtn.ts) — his own two-state PixelLab
// button under the HP/EP card (maintainer 2026-09-18: "I want this button under
// the HP/EP card. Also right aligned with the same distance/linespace to the
// screen and top (the HP card). If you press the button it should change state
// to red/recording").
//
// THE PLACEMENT IS ASSERTED AGAINST THE CARD ITSELF, never against literals:
// the ask is "right aligned" and "the same distance", so the gate compares the
// button's right edge to the card's right edge and the gap under the card to
// the gap the card keeps above itself. A hardcoded 10 would pass just as well
// on a build where BOTH had drifted.
//
// AND THE STATE IS ASSERTED IN PIXELS. A class flip and an aria attribute
// prove the code ran; they do not prove the lamp lit. The lit face carries
// several times the warm ink of the idle one, so the gate crops the button out
// of a real screenshot before and after the press and counts red pixels — the
// same reason /ui2 icons are gated on the DECODED bitmap (UI_AGENT.md): a
// missing or unswapped face looks like a design choice in a screenshot.
//
// THE CROP IS THE PART OF THE PLATE THAT IS OPAQUE IN BOTH FACES, not the
// whole button: his art has transparent corners, the WORLD shows through them,
// and the world's own warmth moves (a torch, the sun). Measured through the
// full button this read 64 idle, 352 recording and then 538 back at idle —
// the third number is a warmer scene, not a lit lamp. LAMP_BOX is the largest
// box opaque in both 48x48 faces (one stray transparent pixel inside it, in
// his export, left exactly as he drew it), so what it counts is his ink.
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const OUT = process.env.OUT || "/tmp";
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
await page.waitForFunction(() => document.querySelector(".ml-rec") && document.querySelector(".ml-bars-l"), null, { timeout: 30000 });

// ── 0. ADMIN ONLY (maintainer 2026-09-18: "I want only the logged in admin to
//       see this button"). This session holds no token, so the REAL server has
//       answered no — the button is mounted but never shown. Then the admin
//       answer is faked and it appears: both directions, because a gate that
//       only proved the second one would pass on a build that showed it to
//       everybody. ──
{
  await page.waitForTimeout(400); // let the boot-time ask settle
  const hidden = await page.evaluate(() => {
    const w = document.querySelector(".ml-recwrap");
    const b = document.querySelector(".ml-rec");
    return { present: !!w, hiddenAttr: w?.hidden, display: w ? getComputedStyle(w).display : null, painted: !!b?.offsetParent, shown: window.__mlRecord?.shown() };
  });
  hidden.present && hidden.hiddenAttr === true && hidden.display === "none" && !hidden.painted && hidden.shown === false
    ? ok("a player never sees it: mounted, hidden, not painted (the real server said not-admin)")
    : fail(`visible to a non-admin: ${JSON.stringify(hidden)}`);
  await page.route("**/api/wiki/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ admin: true }) }),
  );
  await page.evaluate(() => localStorage.setItem("wiki-admin-token", "gate"));
  const shown = await page.evaluate(() => window.__mlRecord.refresh(true));
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => ({ hiddenAttr: document.querySelector(".ml-recwrap")?.hidden, painted: !!document.querySelector(".ml-rec")?.offsetParent }));
  shown === true && after.hiddenAttr === false && after.painted
    ? ok("…and the admin does: the server's yes reveals it")
    : fail(`admin case: refresh returned ${shown}, ${JSON.stringify(after)}`);
}

const geom = () =>
  page.evaluate(() => {
    const r = (s) => {
      const e = document.querySelector(s);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
    };
    const btn = document.querySelector(".ml-rec");
    const cs = getComputedStyle(document.documentElement);
    return {
      card: r(".ml-bars-l"),
      btn: r(".ml-rec"),
      wrap: r(".ml-recwrap"),
      wrapPE: getComputedStyle(document.querySelector(".ml-recwrap")).pointerEvents,
      safeTop: parseFloat(cs.getPropertyValue("--ml-safe-top")) || 0,
      gvLeft: parseFloat(cs.getPropertyValue("--gv-left")) || 0,
      pressed: btn?.getAttribute("aria-pressed"),
      onClass: btn?.classList.contains("on"),
      faces: [...btn.querySelectorAll("img")].map((i) => ({
        cls: i.className,
        w: i.naturalWidth,
        h: i.naturalHeight,
        css: Math.round(i.getBoundingClientRect().width),
        vis: getComputedStyle(i).visibility,
      })),
      state: window.__mlRecord?.on(),
    };
  });

// ── 1. WHERE IT SITS: under the card, right edges flush, and the gap under the
//       card equal to the gap the card keeps above itself ──
{
  const g = await geom();
  if (!g.card || !g.btn) fail(`not mounted: card ${JSON.stringify(g.card)} btn ${JSON.stringify(g.btn)}`);
  else {
    Math.abs(g.btn.r - g.card.r) <= 1
      ? ok(`right-aligned with the HP/EP card (button right ${g.btn.r.toFixed(0)}, card right ${g.card.r.toFixed(0)})`)
      : fail(`button right ${g.btn.r.toFixed(1)} vs card right ${g.card.r.toFixed(1)} — not right-aligned`);
    const gap = g.btn.t - g.card.b;
    const above = g.card.t - g.safeTop;
    Math.abs(gap - above) <= 1
      ? ok(`the gap under the card is the card's own gap to the top (${gap.toFixed(0)}px each)`)
      : fail(`gap under the card ${gap.toFixed(1)}px, card-to-top ${above.toFixed(1)}px — he asked for the same distance`);
    Math.abs(g.card.l - (g.gvLeft + 10)) <= 1 && g.btn.t > g.card.b
      ? ok(`it is UNDER the card, which keeps the shared 10px margin (card left ${g.card.l.toFixed(0)})`)
      : fail(`card left ${g.card.l.toFixed(1)} (gv-left ${g.gvLeft}), button top ${g.btn.t.toFixed(1)} vs card bottom ${g.card.b.toFixed(1)}`);
    g.wrapPE === "none"
      ? ok("the placement row itself eats no taps (only the button does)")
      : fail(`the wrapper takes pointer events (${g.wrapPE}) — it would swallow taps over the world`);
  }
}

// ── 2. BOTH FACES REALLY DECODED, at the authored grid (naturalWidth/2). A
//       missing /ui2 file is an empty box, not an error (UI_AGENT.md). ──
{
  const g = await geom();
  const bad2 = g.faces.filter((f) => !f.w || f.w !== 96 || f.css !== 48);
  bad2.length === 0 && g.faces.length === 2
    ? ok(`both faces decoded 96x96 and render at 48px (${g.faces.map((f) => f.cls).join(", ")})`)
    : fail(`faces: ${JSON.stringify(g.faces)} — want two, each naturalWidth 96 rendered at 48`);
}

// ── 3. THE PRESS TURNS IT RED. Class + aria + the probe, and then the PIXELS.
{
  // in the art's own 48px coordinates, which is also css px (rendered 1:1)
  const LAMP_BOX = { dx: 6, dy: 2, w: 20, h: 31 };
  const shot = async (name) => {
    const g = await geom();
    const clip = {
      x: Math.floor(g.btn.l) + LAMP_BOX.dx,
      y: Math.floor(g.btn.t) + LAMP_BOX.dy,
      width: LAMP_BOX.w,
      height: LAMP_BOX.h,
    };
    const buf = await page.screenshot({ clip, path: `${OUT}/recbtn-${name}.png` });
    const png = PNG.sync.read(buf);
    let warm = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      const [r, gg, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      if (r - (gg + b) / 2 > 40) warm++;
    }
    return warm;
  };
  const before = await geom();
  before.state === false && before.onClass === false && before.pressed === "false"
    ? ok("it starts idle (not recording)")
    : fail(`initial state: ${JSON.stringify({ state: before.state, on: before.onClass, pressed: before.pressed })}`);
  const warmIdle = await shot("idle");
  await page.evaluate(() => document.querySelector(".ml-rec").click());
  await page.waitForTimeout(150);
  const after = await geom();
  after.state === true && after.onClass === true && after.pressed === "true"
    ? ok("a press puts it in the recording state")
    : fail(`after the press: ${JSON.stringify({ state: after.state, on: after.onClass, pressed: after.pressed })}`);
  const warmRec = await shot("recording");
  warmRec > warmIdle * 2
    ? ok(`and it LOOKS it: warm pixels ${warmIdle} -> ${warmRec} in the button's own crop`)
    : fail(`the lamp did not light: warm pixels ${warmIdle} -> ${warmRec}`);
  const vis = after.faces.map((f) => `${f.cls}:${f.vis}`).join(" ");
  /-on:visible/.test(vis) && /-off:hidden/.test(vis)
    ? ok(`the lit face is the visible one (${vis})`)
    : fail(`face visibility ${vis}`);
  // …and it goes back
  await page.evaluate(() => document.querySelector(".ml-rec").click());
  await page.waitForTimeout(150);
  const back = await geom();
  const warmBack = await shot("idle2");
  back.state === false && warmBack < warmRec / 2
    ? ok(`a second press returns it to idle (warm ${warmRec} -> ${warmBack})`)
    : fail(`second press: state ${back.state}, warm ${warmBack} — not back under half of the lit ${warmRec}`);
  // the seam whatever is bound to it later will listen on
  const evt = await page.evaluate(async () => {
    const seen = [];
    const h = (e) => seen.push(e.detail?.on);
    window.addEventListener("ml-record", h);
    window.__mlRecord.set(true);
    window.__mlRecord.set(false);
    window.removeEventListener("ml-record", h);
    return seen;
  });
  JSON.stringify(evt) === "[true,false]"
    ? ok('it fires "ml-record" with its state, for the functionality to be bound later')
    : fail(`ml-record events: ${JSON.stringify(evt)}`);
}

// ── 4. IT STAYS ON THE CARD THROUGH A ROTATION. The chips move with the gv
//       insets and the flip does not resize them, so a placement that only
//       listened to a ResizeObserver would be left behind. ──
{
  await page.setViewportSize({ width: 851, height: 393 });
  await page.waitForTimeout(900);
  const g = await geom();
  // the chips TRANSITION their left over .3s — the wait above outlasts it, and
  // the button rides the same var so it arrives with the card, not after it
  Math.abs(g.btn.r - g.card.r) <= 1 && Math.abs(g.btn.t - g.card.b - 10) <= 1
    ? ok(`still under the card after the landscape flip (right ${g.btn.r.toFixed(0)} = card ${g.card.r.toFixed(0)})`)
    : fail(`after rotating: button ${JSON.stringify(g.btn)} card ${JSON.stringify(g.card)}`);
  await page.setViewportSize({ width: 393, height: 851 });
  await page.waitForTimeout(900);
  const p = await geom();
  Math.abs(p.btn.r - p.card.r) <= 1
    ? ok("and back in portrait")
    : fail(`back in portrait: button right ${p.btn.r.toFixed(1)} vs card right ${p.card.r.toFixed(1)}`);
  await page.screenshot({ path: `${OUT}/recbtn-hud.png` });
}

await browser.close();
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
