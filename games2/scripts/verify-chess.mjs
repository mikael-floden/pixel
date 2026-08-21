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

  // Throw the dice through the real button.
  await page.click("#ml-die-throw");
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

  // One real move via the tap pipeline: e2->e4 as white, e7->e5 as black.
  const [from, to] = side === "w" ? [12, 28] : [52, 36];
  await page.evaluate((q) => window.__ml.chessTap(q), from);
  await page.evaluate((q) => window.__ml.chessTap(q), to);
  await page.waitForFunction((n) => window.__ml.chess().dialog?.moves >= n, side === "w" ? 1 : 2, { timeout: 8000 })
    .catch(() => fail("my move was not accepted"));
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
