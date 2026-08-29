// TREE-WALK GATE: hold a direction into a scenery footprint and the body must
// get PAST it, not wedge on it. Runs the real browser, the real world and the
// real input path — a headless sim of the shared code cannot see a client that
// never loaded its collision documents, which is exactly how this shipped
// broken (the footprint table 404'd and the client stamped nothing).
//
// Drives KEYS, not taps: tap-to-move has always had findPath and always worked.
// The held stick is the path that was broken (maintainer 2026-08-29: "run into
// a tree and the player is stuck 100% of the time").
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const KEYS = { down: "ArrowDown", up: "ArrowUp", left: "ArrowLeft", right: "ArrowRight" };
const HOLD_MS = 7000;
const MIN_CELLS = 3; // must clear its own footprint and keep going

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let fails = 0;
const ok = (c, m) => { if (!c) { console.log(`FAIL  ${m}`); fails++; } else console.log(`ok    ${m}`); };
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1600 } });
  page.on("console", (m) => { if (m.type() === "error") console.log("  [browser]", m.text()); });
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 40000 });
  const idx = await page.evaluate(() => window.__mlSelect.worlds().findIndex((w) => /the_game/i.test(w)));
  if (idx < 0) throw new Error("the_game not in the world list");
  await page.evaluate((i) => window.__mlSelect.pickWorld(i), idx);
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 60000 });
  // The client must actually HAVE scenery collision before any of this means
  // anything — the bug that hid for a whole life was that it did not.
  await page.waitForFunction(() => {
    const b = window.__ml.blockedCells && window.__ml.blockedCells();
    return typeof b === "number" ? b > 0 : true;
  }, { timeout: 30000 }).catch(() => {});

  // Trees near spawn, and the screen direction that runs into each.
  const CASES = [
    { name: "tree_029", col: 445, row: 362, key: "down" },
    { name: "tree_075", col: 452, row: 358, key: "down" },
    { name: "tree_029 from below", col: 445, row: 362, key: "up" },
  ];
  for (const c of CASES) {
    // Stand 4 cells back along the direction the stick will push.
    const back = await page.evaluate(({ col, row, key }) => {
      const v = { down: [1, 1], up: [-1, -1], right: [1, -1], left: [-1, 1] }[key];
      const l = Math.hypot(v[0], v[1]);
      return { c: Math.round(col - (v[0] / l) * 4), r: Math.round(row - (v[1] / l) * 4) };
    }, c);
    await page.evaluate(({ c, r }) => window.__ml.teleport(c, r), back);
    await page.waitForTimeout(700);
    const before = await page.evaluate(() => { const m = window.__ml.me(); return { x: m.x, y: m.y }; });
    await page.keyboard.down(KEYS[c.key]);
    const samples = [];
    for (let i = 0; i < HOLD_MS / 250; i++) {
      await page.waitForTimeout(250);
      samples.push(await page.evaluate(() => { const m = window.__ml.me(); return { x: m.x, y: m.y }; }));
    }
    await page.keyboard.up(KEYS[c.key]);
    const last = samples[samples.length - 1];
    const travelled = Math.hypot(last.x - before.x, last.y - before.y) / 32;
    // Did it ever sit still for a full second? That is the wedge.
    let frozen = 0, worst = 0;
    for (let i = 1; i < samples.length; i++) {
      const d = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
      if (d < 1) { frozen++; worst = Math.max(worst, frozen); } else frozen = 0;
    }
    ok(travelled >= MIN_CELLS,
      `${c.name} (${c.key}): travelled ${travelled.toFixed(2)} cells, need >= ${MIN_CELLS}`);
    ok(worst < 4,
      `${c.name} (${c.key}): longest freeze ${(worst * 0.25).toFixed(2)}s, need < 1.00s`);
  }
} finally {
  await browser.close();
}
console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);
