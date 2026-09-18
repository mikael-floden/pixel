// QA: the FREEZE FRAME behind the record button (client/src/freezeframe.ts) —
// maintainer 2026-09-18: "printscreen the entire page/game and freeze the game
// / only show the printscreen as a 'freezed frame' when you press the red
// button? … Not jpeg encoded. I want the freezed image lossless."
//
// THE THREE CLAIMS, each asserted as the thing itself rather than as a proxy:
//
//  1. LOSSLESS. Not "we passed image/png" — the bytes. The data URL must
//     declare PNG and start with the PNG signature, and a JPEG anywhere in it
//     fails. This is the one requirement he stated twice.
//  2. IT IS THE WORLD, NOT A BLANK. A WebGL canvas without
//     preserveDrawingBuffer reads back EMPTY if the capture happens after the
//     compositor took the buffer — the failure mode is a perfectly transparent
//     image of the right size, which every structural check would pass. So the
//     picture is decoded and its pixels compared against the canvas it claims
//     to be: same size, and not blank.
//  3. THE WORLD REALLY STOPPED. Phaser's own frame counter must not advance
//     while the picture is up, and must advance again once it is down.
//
// …and that a press that CANNOT capture does not leave the button lit over a
// world that never stopped.
import { chromium } from "playwright-core";
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
// the button is admin-only, and this gate is about what it DOES
await page.route("**/api/wiki/me", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ admin: true }) }),
);
await page.addInitScript(() => localStorage.setItem("wiki-admin-token", "gate"));
await page.goto(`${BASE}/`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 90000 });
await page.waitForFunction(() => window.__mlFreezeFrame && window.__mlRecord && window.__mlGame?.loop, null, { timeout: 30000 });
await page.waitForTimeout(1200); // let a few frames of world go by

const press = async () => {
  await page.evaluate(() => document.querySelector(".ml-rec").click());
  // the capture takes a frame, then a png decode
  await page.waitForFunction(() => window.__mlFreezeFrame.shown() || window.__mlRecord.on() === false, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(250);
};

// ── 1. THE PRESS FREEZES, AND THE PICTURE IS A LOSSLESS PNG OF THE WORLD ──
{
  const before = await page.evaluate(() => window.__mlGame.loop.frame);
  await press();
  const s = await page.evaluate(() => ({
    shown: window.__mlFreezeFrame.shown(),
    src: (window.__mlFreezeFrame.src() || "").slice(0, 40),
    len: (window.__mlFreezeFrame.src() || "").length,
    size: window.__mlFreezeFrame.size(),
    rec: window.__mlRecord.on(),
    frozen: window.__mlFreeze?.frozen?.() ?? null,
  }));
  s.shown && s.rec ? ok("the red button puts a frozen picture up") : fail(`after the press: ${JSON.stringify(s)}`);
  // (1) LOSSLESS — the declared type AND the magic bytes
  const png = await page.evaluate(() => {
    const src = window.__mlFreezeFrame.src() || "";
    const b64 = src.split(",")[1] || "";
    const head = atob(b64.slice(0, 16));
    return { declared: src.slice(0, 22), sig: [...head.slice(0, 8)].map((c) => c.charCodeAt(0)) };
  });
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10].join();
  png.declared.startsWith("data:image/png") && png.sig.join() === PNG_SIG
    ? ok(`the picture is a real PNG — lossless, no jpeg (${png.declared}…, signature matches)`)
    : fail(`not a PNG: declared "${png.declared}", signature ${png.sig}`);
  !/jpeg|jpg/i.test(await page.evaluate(() => (window.__mlFreezeFrame.src() || "").slice(0, 64)))
    ? ok("nothing in the picture's own header says jpeg")
    : fail("the freeze frame is jpeg-encoded — he asked for lossless");
  // (2) IT IS THE WORLD: the drawing buffer's size, and not a blank read
  const cmp = await page.evaluate(async () => {
    const cv = window.__mlGame.canvas;
    const img = new Image();
    img.src = window.__mlFreezeFrame.src();
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) {
      if (d[i + 3] > 8 && d[i] + d[i + 1] + d[i + 2] > 24) lit++;
      seen.add((d[i] >> 4) * 256 + (d[i + 1] >> 4) * 16 + (d[i + 2] >> 4));
    }
    return { img: [img.naturalWidth, img.naturalHeight], buf: [cv.width, cv.height], lit, samples: Math.ceil(d.length / (4 * 97)), colours: seen.size };
  });
  cmp.img[0] === cmp.buf[0] && cmp.img[1] === cmp.buf[1]
    ? ok(`it is the whole drawing buffer (${cmp.img.join("x")})`)
    : fail(`picture ${cmp.img.join("x")} vs canvas ${cmp.buf.join("x")}`);
  cmp.lit > cmp.samples * 0.5 && cmp.colours > 40
    ? ok(`and it has the world in it, not a blank read (${cmp.lit}/${cmp.samples} lit, ${cmp.colours} colours)`)
    : fail(`the capture looks blank — preserveDrawingBuffer/order bug: ${JSON.stringify(cmp)}`);
  // (3) THE WORLD STOPPED
  const f1 = await page.evaluate(() => window.__mlGame.loop.frame);
  await page.waitForTimeout(700);
  const f2 = await page.evaluate(() => window.__mlGame.loop.frame);
  f2 === f1 && f1 > before
    ? ok(`the loop is asleep behind it (frame ${f1} unchanged over 700ms)`)
    : fail(`the world kept running: frame ${before} -> ${f1} -> ${f2}`);
  await page.screenshot({ path: `${OUT}/freezeframe.png` });
}

// ── 2. IT COVERS THE WORLD AND NOTHING ELSE. The picture must sit exactly over
//       the canvas, and it must NOT take the taps the HUD needs — the button
//       that ends the freeze is in that HUD. ──
{
  const g = await page.evaluate(() => {
    const f = document.querySelector(".ml-freezeframe");
    const cv = window.__mlGame.canvas;
    const a = f.getBoundingClientRect(), b = cv.getBoundingClientRect();
    const btn = document.querySelector(".ml-rec").getBoundingClientRect();
    const hit = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2);
    return {
      d: [Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height)],
      pe: getComputedStyle(f).pointerEvents,
      overButton: hit ? (hit.closest(".ml-rec") ? "button" : hit.className || hit.tagName) : "none",
    };
  });
  Math.max(...g.d) <= 1
    ? ok("the picture lies exactly over the game canvas")
    : fail(`picture offset from the canvas by ${JSON.stringify(g.d)}`);
  g.pe === "none" && g.overButton === "button"
    ? ok("it takes no taps, and the record button is still the thing under your finger")
    : fail(`pointer-events ${g.pe}, the button's own spot hits ${g.overButton}`);
}

// ── 3. PRESSING AGAIN GIVES THE WORLD BACK ──
{
  await page.evaluate(() => document.querySelector(".ml-rec").click());
  await page.waitForTimeout(400);
  const s = await page.evaluate(() => ({ shown: window.__mlFreezeFrame.shown(), rec: window.__mlRecord.on(), el: !!document.querySelector(".ml-freezeframe") }));
  const f1 = await page.evaluate(() => window.__mlGame.loop.frame);
  await page.waitForTimeout(700);
  const f2 = await page.evaluate(() => window.__mlGame.loop.frame);
  !s.shown && !s.rec && !s.el && f2 > f1
    ? ok(`a second press takes the picture down and the world runs again (frame ${f1} -> ${f2})`)
    : fail(`after the second press: ${JSON.stringify(s)}, frames ${f1} -> ${f2}`);
}

// ── 4. A CAPTURE THAT CANNOT HAPPEN MUST NOT LEAVE THE BUTTON LIT over a world
//       that never stopped — the one failure that would lie to him. ──
{
  await page.evaluate(() => {
    window.__snapWas = window.__mlGame.renderer.snapshot;
    window.__mlGame.renderer.snapshot = () => { throw new Error("gate: no snapshot"); };
  });
  await page.evaluate(() => document.querySelector(".ml-rec").click());
  await page.waitForTimeout(600);
  const s = await page.evaluate(() => ({ shown: window.__mlFreezeFrame.shown(), rec: window.__mlRecord.on(), frame: window.__mlGame.loop.frame }));
  await page.waitForTimeout(500);
  const f2 = await page.evaluate(() => window.__mlGame.loop.frame);
  !s.shown && s.rec === false && f2 > s.frame
    ? ok("a failed capture puts the button back and leaves the world running")
    : fail(`failed capture: ${JSON.stringify(s)}, frames ${s.frame} -> ${f2}`);
  await page.evaluate(() => { window.__mlGame.renderer.snapshot = window.__snapWas; });
}

await browser.close();
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
