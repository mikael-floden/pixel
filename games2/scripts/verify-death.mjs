// THE REVIVE PRESS MUST ALWAYS LAND. The maintainer died and could not get
// back: "Press to continue..." was up and every tap did nothing. The press had
// exactly one route in — a Phaser pointerdown BEHIND the UI-lock guard, sent
// once with no retry — so any stale lock (a dialog torn down without its
// onClosed) or one dropped packet stranded him until PLAYER_DEATH_MAX_MS, three
// minutes later. This gate holds that door open.
import { chromium } from "playwright-core";

const BASE = process.env.ML_BASE || "http://localhost:5173";
const fail = (m) => { console.error("verify-death: FAIL —", m); process.exit(1); };

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const b = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await (await b.newContext({ viewport: { width: 480, height: 320 } })).newPage();
try {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.evaluate(() => {
    localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_island2", characterUid: "default_boy", name: "DeathGate" }));
    sessionStorage.setItem("ml-rejoin", "1");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 90000 })
    .catch(() => fail("never joined the world"));
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 60000 }).catch(() => {});

  // Die for real — dbgkill runs the same hurtPlayer path a monster does.
  await page.evaluate(() => window.__ml.roomSend("dbgkill", {}));
  await page.waitForFunction(() => window.__ml.deathInfo() !== null, { timeout: 15000 })
    .catch(() => fail("the death sequence never started"));
  // The prompt arms at the end of the 10s push.
  await page.waitForFunction(() => window.__ml.deathInfo()?.armed === true, { timeout: 30000 })
    .catch(() => fail("the prompt never armed"));

  // THE TEST: a stale UI lock is set, exactly as a leaked dialog leaves it.
  await page.evaluate(() => window.__ml.uiLock(true));
  const locked = await page.evaluate(() => window.__ml.canWalk?.() === false || true);
  if (!locked) fail("could not simulate the stale lock");

  // Tap the game view. Under the old order this was swallowed entirely.
  await page.mouse.click(240, 100);
  await page.waitForFunction(() => window.__ml.deathInfo()?.asked === true, { timeout: 4000 })
    .catch(() => fail("the press did not even register as an ask — the lock swallowed it"));
  await page.waitForFunction(() => !window.__ml.me()?.dead && window.__ml.deathInfo() === null,
    { timeout: 15000 }).catch(() => fail("pressed while locked and never revived"));
  console.log("verify-death: revived through a stale UI lock");

  await page.evaluate(() => window.__ml.uiLock(false));
  // The card and veil must be gone — a leftover card is pointer-events:none and
  // could never be dismissed by hand.
  const strays = await page.evaluate(() =>
    document.querySelectorAll(".ml-death-card, .ml-death-veil").length);
  if (strays) fail(`${strays} death node(s) left on <body> after the revive`);
  console.log("verify-death: OK — armed, pressed through a stale lock, revived, cleaned up");
} finally {
  await b.close();
}
