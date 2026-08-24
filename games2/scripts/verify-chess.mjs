// verify-chess — walk to Wendell's board on the_island2, and the whole feature
// must happen: proximity seat -> dialog -> dice theater -> a real move -> the
// NPC answers -> resign -> verdict -> movement unlocked. Dev stack required.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const fail = (m) => { console.error(`verify-chess: FAIL — ${m}`); process.exit(1); };
const b = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  const page = await (await b.newContext({ viewport: { width: 393, height: 700 } })).newPage();
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.evaluate(() => {
    localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_island2", characterUid: "default_boy", name: "Kasparov" }));
    sessionStorage.setItem("ml-rejoin", "1");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 90000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 60000 }).catch(() => {});

  // Boards synced from config?
  await page.waitForFunction(() => window.__ml.chess?.().boards.length >= 2, { timeout: 15000 })
    .catch(() => fail("chess boards never synced (config/chess_boards.json)"));

  // FIRST: the waiting contract at the PvP board — stand at a free seat and
  // every client must see the challenge bubble; walk away and it clears.
  await page.evaluate(() => window.__ml.teleport(205, 120));
  // The jump button must OFFER the game first (prompt "start"), and pressing
  // SPACE — the exact key the button synthesizes — seats you.
  await page.waitForFunction(() => window.__ml.chess().prompt === "start", { timeout: 12000 })
    .catch(() => fail("jump button never offered START CHESS GAME at a free board"));
  await page.keyboard.press("Space");
  await page.waitForFunction(() => {
    const c = window.__ml.chess();
    return c.boards.some((b2) => b2.id === "fireside" && b2.waiting) && c.waitBubbles === 1;
  }, { timeout: 12000 }).catch(() => fail("waiting bubble never appeared after pressing the offer"));
  await page.evaluate(() => window.__ml.teleport(210, 113));
  await page.waitForFunction(() => {
    const c = window.__ml.chess();
    return c.boards.every((b2) => !b2.waiting) && c.waitBubbles === 0;
  }, { timeout: 12000 }).catch(() => fail("waiting bubble did not clear after walking away"));
  console.log("verify-chess: waiting bubble appears and clears");

  // Sit at Rannulf's player seat (198,120): prompt says JOIN (he waits), and
  // SPACE starts the game.
  await page.evaluate(() => window.__ml.teleport(198, 120));
  await page.waitForFunction(() => window.__ml.chess().prompt === "join", { timeout: 12000 })
    .catch(() => fail("jump button never offered JOIN CHESS GAME at Rannulf's board"));
  await page.keyboard.press("Space");
  await page.waitForFunction(() => window.__ml.chess().dialog?.open === true, { timeout: 12000 })
    .catch(() => fail("dialog never opened after joining Rannulf's board"));
  const d0 = await page.evaluate(() => window.__ml.chess().dialog);
  if (d0.phase !== "dice") fail(`expected dice phase, got ${d0.phase}`);

  // BOTH HANDS ARE PIXEL ART, AND BOTH SCALE WHOLE. The 97px frames had the
  // same bug as the pieces: 1:1 in CSS is 2.75x in device pixels on a real
  // phone. Checked at his geometry, then restored.
  await page.setViewportSize({ width: 393, height: 851 });
  const dice = await page.evaluate(() => {
    const mine = document.querySelector("#ml-die-hand");
    const opp = document.querySelector("#ml-die-opp");
    if (!mine || !opp) return null;
    const cs = getComputedStyle(opp);
    const r = mine.getBoundingClientRect(), ro = opp.getBoundingClientRect();
    return {
      w: r.width, ow: ro.width, dpr: window.devicePixelRatio || 1,
      strip: getComputedStyle(mine).backgroundSize,
      oppHand: opp.classList.contains("die-hand"),
      flip: cs.transform, // scaleY(-1) => matrix(1, 0, 0, -1, 0, 0)
    };
  });
  if (!dice) fail("the dice panel is missing a hand (mine or the opponent's)");
  if (!dice.oppHand) fail("the opponent has no die");
  // NOT mirrored: flipping it stood his die on its head, and the maintainer
  // took the whole re-played animation back — he gets the last frame, upright.
  if (/matrix\(1,\s*0,\s*0,\s*-1/.test(dice.flip))
    fail(`the opponent's die is flipped upside down: transform=${dice.flip}`);
  for (const [who, w] of [["mine", dice.w], ["opponent", dice.ow]]) {
    const k = (w * dice.dpr) / 97;
    if (Math.abs(k - Math.round(k)) > 0.01)
      fail(`${who} dice hand renders at ${k.toFixed(3)}x device pixels — not whole ` +
           `(css ${w.toFixed(2)}px, dpr ${dice.dpr})`);
  }
  // The strip must scale WITH the hand or the frames tear mid-throw.
  const wantStrip = (dice.w / 97) * 873;
  if (Math.abs(parseFloat(dice.strip) - wantStrip) > 0.5)
    fail(`strip ${dice.strip} does not match the hand size (want ${wantStrip.toFixed(2)}px)`);
  console.log(`verify-chess: both dice at ${Math.round((dice.w * dice.dpr) / 97)}x device pixels, ` +
              `opponent's upright`);
  await page.setViewportSize({ width: 480, height: 320 });

  // Throw the dice through the real button.
  await page.click("#ml-die-throw");
  // He does not re-play the throw — his die simply shows its landed face.
  const oppShown = await page.waitForFunction(() => {
    const o = document.querySelector("#ml-die-opp");
    return !!o && o.classList.contains("still") && !o.classList.contains("shaking");
  }, { timeout: 12000 }).then(() => true).catch(() => false);
  if (!oppShown) fail("the opponent's die never showed its face");
  await page.waitForFunction(() => window.__ml.chess().dialog?.phase === "play", { timeout: 12000 })
    .catch(() => fail("dice never resolved to play (NPC die missing?)"));
  const side = await page.evaluate(() => window.__ml.chess().dialog.mySide);
  if (side !== "w" && side !== "b") fail(`no side assigned (${side})`);

  // If black, the NPC (white) moves first.
  await page.waitForFunction((s) => {
    const dd = window.__ml.chess().dialog;
    return dd.turn === s || dd.result;
  }, side, { timeout: 15000 }).catch(() => fail("never became my turn"));

  // THE BOARD IS A REGULAR CHESSBOARD: all 64 squares identical, and they
  // stay identical after moves (shipped once with auto-sized rows — squares
  // grew around their pieces and the board resized on every move).
  const squareSpread = () => page.evaluate(() => {
    const r = [...document.querySelectorAll(".ml-chess-sq")].map((el) => el.getBoundingClientRect());
    const ws = r.map((b2) => b2.width), hs = r.map((b2) => b2.height);
    return { n: r.length, dw: Math.max(...ws) - Math.min(...ws), dh: Math.max(...hs) - Math.min(...hs) };
  });
  // The dice panel LINGERS ~3s past the schema's phase flip (the throw gets
  // its moment) — wait for the actual 64 cells, not the phase.
  await page.waitForFunction(() => document.querySelectorAll(".ml-chess-sq").length === 64, { timeout: 15000 })
    .catch(() => fail("the 8x8 board never built after the dice"));
  const sq0 = await squareSpread();
  if (sq0.dw > 1 || sq0.dh > 1)
    fail(`unequal squares before any move: ${JSON.stringify(sq0)}`);

  // PIXEL ART SCALES BY A WHOLE NUMBER (repo law: nearest-neighbour only). The
  // pieces are 32x32; at a fractional scale some source pixels get 2 screen px
  // and their neighbours 3, which is the "fractal" look the maintainer caught.
  // What must come out whole is the DEVICE scale (css x dpr / 32) — a whole CSS
  // size is not enough at dpr 2.75. Checked at the maintainer's own phone
  // geometry, since this gate's tiny starvation-proof viewport is below the
  // board size where any 1x fit exists.
  const realGeom = { width: 393, height: 851 };
  await page.setViewportSize(realGeom);
  await page.waitForFunction(() => {
    const el = document.querySelector(".ml-chess-sq img.pc-img");
    return !!el && el.getBoundingClientRect().width > 0;
  }, { timeout: 8000 }).catch(() => fail("board vanished after resizing to phone geometry"));
  const pcScale = await page.evaluate(() => {
    const img = document.querySelector(".ml-chess-sq img.pc-img");
    const sq = document.querySelector(".ml-chess-sq");
    if (!img || !sq) return null;
    const r = img.getBoundingClientRect(), s2 = sq.getBoundingClientRect();
    return { w: r.width, nat: img.naturalWidth, dpr: window.devicePixelRatio || 1, sq: s2.width };
  });
  if (!pcScale) fail("no piece image on the board");
  if (pcScale.nat !== 32) fail(`piece art is ${pcScale.nat}px, expected 32`);
  const devScale = (pcScale.w * pcScale.dpr) / pcScale.nat;
  if (Math.abs(devScale - Math.round(devScale)) > 0.01)
    fail(`piece renders at ${devScale.toFixed(3)}x device pixels — not a whole number ` +
         `(css ${pcScale.w.toFixed(2)}px, dpr ${pcScale.dpr}, square ${pcScale.sq.toFixed(2)}px)`);
  if (pcScale.w > pcScale.sq) fail(`piece (${pcScale.w}) overflows its square (${pcScale.sq})`);
  console.log(`verify-chess: pieces at exactly ${Math.round(devScale)}x device pixels ` +
              `(${pcScale.w.toFixed(2)}css @ dpr ${pcScale.dpr})`);
  await page.setViewportSize({ width: 480, height: 320 });

  // DRAG-AND-DROP. A real pointer gesture from one square to another must move
  // the piece — the maintainer asked for it after playing with tap-then-tap.
  const dragMove = async (fromSq, toSq) => {
    const box = (q) => page.evaluate((n) => {
      const el = document.querySelector(`.ml-chess-sq[data-sq="${n}"]`);
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, q);
    const a2 = await box(fromSq), b2 = await box(toSq);
    await page.mouse.move(a2.x, a2.y);
    await page.mouse.down();
    await page.mouse.move(a2.x + 14, a2.y + 14); // clear the 6px slop -> ghost
    const ghost = await page.evaluate(() => !!document.querySelector(".ml-chess-ghost"));
    await page.mouse.move(b2.x, b2.y, { steps: 6 });
    await page.mouse.up();
    return ghost;
  };

  // One real move via the tap pipeline: e2->e4 as white, e7->e5 as black.
  const [from, to] = side === "w" ? [12, 28] : [52, 36];
  const sawGhost = await dragMove(from, to);
  if (!sawGhost) fail("dragging a piece never produced a lifted ghost");
  await page.waitForFunction((n) => window.__ml.chess().dialog?.moves >= n, side === "w" ? 1 : 2, { timeout: 8000 })
    .catch(() => fail("the DRAGGED move was not accepted"));
  // The NPC must answer.
  const before = await page.evaluate(() => window.__ml.chess().dialog.moves);
  await page.waitForFunction((n) => window.__ml.chess().dialog?.moves > n, before, { timeout: 12000 })
    .catch(() => fail("the NPC never replied"));
  console.log("verify-chess: moves flowing —", await page.evaluate(() => window.__ml.chess().dialog.moves), "plies");
  const sq1 = await squareSpread();
  if (sq1.dw > 1 || sq1.dh > 1 || Math.abs(sq1.dw - sq0.dw) > 1)
    fail(`squares changed after moves: before ${JSON.stringify(sq0)} after ${JSON.stringify(sq1)}`);
  console.log("verify-chess: 64 equal squares, stable through moves");

  // Resign (two-step confirm), read the verdict, close.
  // DOM-dispatched, NOT page.click: the two-step confirm has a 5s window, and
  // on this starved software-GL harness a synthetic click's "stable across two
  // animation frames" actionability check alone takes ~4-5s at ~3fps (measured
  // with raw timestamps: the second click landed 4,990ms after the first).
  // Real thumbs at 60fps are inside the window trivially; the harness is not.
  const domClick = (sel) => page.$eval(sel, (el) => el.click());
  await domClick("#ml-chess-resign");
  await page.waitForTimeout(250);
  await domClick("#ml-chess-resign");
  await page.waitForFunction(() => window.__ml.chess().dialog?.phase === "over", { timeout: 8000 })
    .catch(async () => {
      const d = await page.evaluate(() => window.__ml.chess().dialog);
      fail(`resign did not end the game — dialog: ${JSON.stringify(d)}`);
    });
  const v = await page.evaluate(() => ({
    d: window.__ml.chess().dialog,
    text: document.querySelector(".ml-chess .verdict")?.textContent ?? "",
  }));
  if (!/You lost/.test(v.text)) fail(`verdict text wrong: "${v.text}"`);
  await page.click("#ml-chess-close");
  await page.waitForFunction(() => window.__ml.chess().dialog === null, { timeout: 5000 })
    .catch(() => fail("dialog did not close"));
  const walk = await page.evaluate(() => window.__ml.canWalk?.() ?? true);
  if (!walk) fail("movement still locked after closing");
  console.log(`verify-chess: OK — seated, diced (side=${side}), moved, NPC answered, resigned ("${v.text.trim().split("\n")[0]}"), unlocked`);
} finally { await b.close(); }
