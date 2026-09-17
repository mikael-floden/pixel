// BACKPACK DRAG-TO-SWAP (maintainer 2026-09-17): "drag an item to a different
// item's slot so they change place. When I drag around the item I should see
// that item moving to the item I drag's location so I understand what will
// happen if I drop the item here … if I continue to drag to a different slot
// instead, the item at that spot will animate towards the item I'm dragging's
// location (and the old item that was animated to this slot will animate back)."
//
// Proven on the real client at his phone geometry, with a faked three-item bag
// (__ml.invFake — the server never hands out a bag on demand; the SERVER's own
// swap is gated in server/test/invorder.test.ts):
//   1. hovering slot 2 while lifting slot 0 puts slot 2's ART on slot 0's cell;
//   2. moving on to slot 1 sends slot 2's art home and brings slot 1's over;
//   3. releasing on slot 1 swaps the grid at once AND sends invmove {0,1,item};
//   4. releasing on an EMPTY cell swaps nothing, sends nothing, leaves no
//      transform behind;
//   5. the release over the game view still opens the drop dialog (dropqty's
//      contract, re-pinned here because the release path now has three exits).
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const TOL = 4; // px — a translated centre must land on the cell's centre

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);

const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const BAG = [
  { item: "smooth_river_stone", n: 1 },
  { item: "green_slime_glob", n: 3 },
  { item: "smooth_river_stone", n: 2 },
];

/** Centre of the grid cell at index i, and of the ART inside it (img rect). */
const cells = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".ml-slots .ml-slot")].map((c) => {
      const r = c.getBoundingClientRect();
      const img = c.querySelector("img");
      const ir = img ? img.getBoundingClientRect() : null;
      return {
        filled: c.classList.contains("filled"),
        displaced: c.classList.contains("displaced"),
        sel: c.classList.contains("sel"),
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        ax: ir ? ir.left + ir.width / 2 : null,
        ay: ir ? ir.top + ir.height / 2 : null,
        transform: img ? img.style.transform : "",
      };
    }),
  );
const near = (a, b) => Math.abs(a - b) <= TOL;
const settle = () => page.waitForTimeout(320); // > the 180ms transition

try {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 90000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 60000 });
  await page.waitForTimeout(800);
  await page.click('.ml-tab[data-tab="backpack"]');
  await page.evaluate((bag) => window.__ml.invFake(bag), BAG);
  await page.waitForFunction(() => document.querySelectorAll(".ml-slot.filled").length === 3, null, { timeout: 5000 });

  // SELECT slot 0 (the 2026-09-14 rule: an unselected slot scrolls, only the
  // selected one lifts), then press and hold on it.
  let c = await cells();
  await page.mouse.click(c[0].cx, c[0].cy);
  await page.waitForFunction(() => document.querySelector(".ml-slot.filled")?.classList.contains("sel"), null, { timeout: 3000 });
  await page.mouse.move(c[0].cx, c[0].cy);
  await page.mouse.down();
  await page.mouse.move(c[0].cx + 12, c[0].cy + 12, { steps: 4 }); // lift: the ghost appears

  // 1. hover slot 2 → slot 2's art sits on slot 0's cell
  await page.mouse.move(c[2].cx, c[2].cy, { steps: 6 });
  await settle();
  c = await cells();
  c[2].displaced && near(c[2].ax, c[0].cx) && near(c[2].ay, c[0].cy)
    ? ok(`hovering slot 2 moves its art onto slot 0 (art at ${c[2].ax.toFixed(0)},${c[2].ay.toFixed(0)} vs cell 0 ${c[0].cx.toFixed(0)},${c[0].cy.toFixed(0)})`)
    : fail(`hovering slot 2 did not move its art onto slot 0 (displaced=${c[2].displaced}, art ${c[2].ax},${c[2].ay}, cell 0 ${c[0].cx},${c[0].cy}, transform "${c[2].transform}")`);

  // 2. move on to slot 1 → slot 2's art goes home, slot 1's comes over
  await page.mouse.move(c[1].cx, c[1].cy, { steps: 6 });
  await settle();
  c = await cells();
  !c[2].displaced && near(c[2].ax, c[2].cx) && near(c[2].ay, c[2].cy)
    ? ok("moving on sends slot 2's art back to its own cell")
    : fail(`slot 2's art did not go home (displaced=${c[2].displaced}, art ${c[2].ax},${c[2].ay}, cell ${c[2].cx},${c[2].cy})`);
  c[1].displaced && near(c[1].ax, c[0].cx) && near(c[1].ay, c[0].cy)
    ? ok("…and slot 1's art now sits on slot 0")
    : fail(`slot 1's art did not move onto slot 0 (displaced=${c[1].displaced}, art ${c[1].ax},${c[1].ay})`);
  const ghosts = await page.evaluate(() => document.querySelectorAll(".ml-slot-ghost").length);
  ghosts === 1 ? ok("one ghost under the finger throughout") : fail(`${ghosts} ghosts on screen mid-drag`);

  // 3. release on slot 1 → the grid swaps at once and the message names it
  await page.mouse.up();
  const after = await page.evaluate(() => ({
    inv: window.__ml.inv().map((s) => s.item + "×" + s.n),
    moves: window.__ml.invMoves(),
    sel: [...document.querySelectorAll(".ml-slot")].findIndex((x) => x.classList.contains("sel")),
    displaced: document.querySelectorAll(".ml-slot.displaced").length,
    ghosts: document.querySelectorAll(".ml-slot-ghost").length,
    transforms: [...document.querySelectorAll(".ml-slot img")].filter((i) => i.style.transform).length,
  }));
  const wantInv = [BAG[1], BAG[0], BAG[2]].map((s) => s.item + "×" + s.n);
  JSON.stringify(after.inv) === JSON.stringify(wantInv)
    ? ok(`release on slot 1 swapped the grid at once (${after.inv.join(", ")})`)
    : fail(`the grid after release is ${JSON.stringify(after.inv)}, wanted ${JSON.stringify(wantInv)} — the drop must do what the preview showed`);
  const last = after.moves[after.moves.length - 1];
  last && last.from === 0 && last.to === 1 && last.item === BAG[0].item
    ? ok(`…and the client asked the server for exactly that swap (invmove ${JSON.stringify(last)})`)
    : fail(`no matching invmove was sent (log ${JSON.stringify(after.moves)})`);
  after.sel === 1 ? ok("the selection followed the lifted item to slot 1") : fail(`selection is on slot ${after.sel}, not the lifted item's new slot 1`);
  after.displaced === 0 && after.ghosts === 0 && after.transforms === 0
    ? ok("nothing left behind: no ghost, no displaced cell, no stray transform")
    : fail(`left behind after release: ghosts=${after.ghosts} displaced=${after.displaced} transforms=${after.transforms}`);

  // 4. a release on an EMPTY cell is a cancel — nothing swaps, nothing is sent
  await page.evaluate((bag) => window.__ml.invFake(bag), BAG);
  await page.waitForTimeout(150);
  c = await cells();
  const empty = c.findIndex((x) => !x.filled);
  await page.mouse.click(c[0].cx, c[0].cy);
  await page.waitForFunction(() => document.querySelector(".ml-slot.filled")?.classList.contains("sel"), null, { timeout: 3000 });
  const movesBefore = (await page.evaluate(() => window.__ml.invMoves())).length;
  await page.mouse.move(c[0].cx, c[0].cy);
  await page.mouse.down();
  await page.mouse.move(c[2].cx, c[2].cy, { steps: 6 }); // displace slot 2 on the way
  await settle();
  await page.mouse.move(c[empty].cx, c[empty].cy, { steps: 6 });
  await settle();
  c = await cells();
  c[2].displaced || !near(c[2].ax, c[2].cx)
    ? fail("hovering an empty cell left slot 2's art displaced — an empty cell is not a target and should send it home")
    : ok("hovering an empty cell displaces nothing (slot 2's art went home)");
  await page.mouse.up();
  const cancel = await page.evaluate(() => ({
    inv: window.__ml.inv().map((s) => s.item + "×" + s.n),
    moves: window.__ml.invMoves().length,
    transforms: [...document.querySelectorAll(".ml-slot img")].filter((i) => i.style.transform).length,
  }));
  JSON.stringify(cancel.inv) === JSON.stringify(BAG.map((s) => s.item + "×" + s.n)) && cancel.moves === movesBefore && cancel.transforms === 0
    ? ok("a release on an empty cell swaps nothing and sends nothing")
    : fail(`release on an empty cell: inv=${JSON.stringify(cancel.inv)} moves ${movesBefore}→${cancel.moves} transforms=${cancel.transforms}`);

  // 5. the game view is still the drop exit. (A cancel KEEPS the selection —
  // an aborted drag must not cost the player their pick — so slot 0 may still
  // be selected here, and a click would toggle it off: select only if needed.)
  await page.evaluate((bag) => window.__ml.invFake(bag), BAG);
  await page.waitForTimeout(150);
  c = await cells();
  if (!c[0].sel) await page.mouse.click(c[0].cx, c[0].cy);
  await page.waitForFunction(() => document.querySelector(".ml-slot.filled")?.classList.contains("sel"), null, { timeout: 3000 });
  await page.mouse.move(c[0].cx, c[0].cy);
  await page.mouse.down();
  await page.mouse.move(200, 300, { steps: 8 });
  await page.mouse.up();
  const dlg = await page.waitForSelector(".ml-qty", { timeout: 3000 }).then(() => true).catch(() => false);
  dlg ? ok("a release over the game view still opens the drop dialog") : fail("the drop dialog did not open on a release over the game view");

  errors.length === 0 ? ok("no page errors") : fail(`page errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
}
console.log(bad ? "\nBAGSWAP: FAIL" : "\nBAGSWAP: PASS");
process.exit(bad ? 1 : 0);
