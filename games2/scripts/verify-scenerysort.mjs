// SCENERY vs THE BODY, AT HIS OWN SPOTS (docs/depth-sort.md). A piece sorts on
// its FOOTPRINT CENTRE ("a player above the centre is drawn behind that part of
// the piece, below it in front" — his rule), and it is then lifted so the floor
// in front of it cannot paint over it. The bug this gate exists for: the lift
// carried a bed all the way to its feet line while a body BESIDE its footprint
// never entered the depth rule at all, so the bed drew over a player standing
// in front of it (maintainer 2026-09-14, four spots around beds/bed_001 at
// 301.33,234.63 — "I'm still being rendered behind the bed at this spot").
//
// It stands at each of those four spots and compares the body's resolved depth
// with the drawn depth of the bed whose ART overlaps it. The verdicts are HIS,
// read off his screenshots: in front of the bed's footprint centre the body
// wins; behind it the bed wins (and there the outline is right to appear).
// Needs a built client. Exit 1 on any spot that sorts the wrong way.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 3300 + Math.floor(Math.random() * 40);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], { cwd: join(ROOT, "server"), detached: true, env: { ...process.env, PORT: String(port), SERVE_CLIENT: "1", NODE_ENV: "production" }, stdio: ["ignore", "ignore", "ignore"] });
const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
process.on("exit", stop);
for (let t0 = Date.now(); ; ) { try { if ((await fetch(origin + "/health")).ok) break; } catch {} if (Date.now() - t0 > 90000) throw new Error("unhealthy"); await new Promise((r) => setTimeout(r, 250)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const bad = (m) => { failed = true; console.log("  FAIL " + m); };

/* col, row, the PIECE he reported, and which way that pair must sort. "over" =
 * his feet are in front of that piece's footprint centre, so the body wins.
 * The piece is NAMED because several are drawn over one spot — a tall chimney
 * five cells away legitimately covers him, and inferring "the piece over the
 * body" picked that instead of the bed he was complaining about. */
const SPOTS = [
  [301.7, 233.4, "beds/bed_001", "over", "beside the bed's head, in front of its centre"],
  [300.2, 235.2, "beds/bed_001", "over", "in front of the bed's foot end"],
  [300.4, 232.4, "beds/bed_001", "under", "behind the bed's centre — the bed is in front"],
  [299.9, 232.5, "beds/bed_001", "under", "behind the bed's centre, inside its footprint column"],
  // His fifth report (2026-09-14): "the player feet centre is at a lower
  // screen-y than the bed's hitbox centre and still we draw the player behind
  // the bed". He stands 1.3 cells in front of bed_005's footprint centre.
  [301.7, 228.7, "beds/bed_005", "over", "in front of bed_005's centre, beside its foot end"],
];

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 1, serviceWorkers: "block" });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.addInitScript(() => {
  localStorage.setItem("ml-last-choice", JSON.stringify({ world: "the_game", characterUid: "default_boy", name: "W" }));
  sessionStorage.setItem("ml-rejoin", "1");
});
await page.goto(origin + "/", { waitUntil: "commit" });
await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 180000, polling: 100 });
await page.evaluate(() => { try { window.__ml.noAggro(true); } catch {} });

for (const [c, r, piece, want, what] of SPOTS) {
  await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [c, r]);
  await sleep(6000);
  const d = await page.evaluate(() => {
    const cov = window.__ml.myCover();
    const av = window.__ml.depthProbe();
    const drawn = window.__ml.sceneryDrawn();
    const dump = window.__ml.occDump();
    // Every drawn piece with its depth off the display list.
    const rows = [];
    for (const x of drawn) {
      const row = dump.scenery.find((s) => Math.abs(s[1] - x.box[0]) < 1 && Math.abs(s[2] - x.box[1]) < 1);
      if (row) rows.push({ piece: x.piece, box: x.box, depth: row[3] });
    }
    return { cov, me: av?.me ?? null, rows };

  });
  /* THE PIECE HE IS STANDING AT: the one whose DRAWN ART box holds his body,
   * joined in scene coordinates (`depthProbe().me.lx/ly` and every
   * `sceneryDrawn` box are the same space). Picking "the nearest by depth"
   * read the wrong bed of the three in this room. */
  const me = d.me;
  const hits = d.rows.filter((row) => {
    const [x, y, w, h] = row.box;
    return row.piece === piece && me && x - 20 <= me.lx && x + w + 20 >= me.lx && y <= me.ly + 10 && y + h >= me.ly - 90;
  });
  // Several placements of one piece can be drawn over him: take the nearest.
  const pick = hits.length
    ? hits.reduce((a, b) => (Math.abs(b.box[1] + b.box[3] / 2 - me.ly) < Math.abs(a.box[1] + a.box[3] / 2 - me.ly) ? b : a))
    : null;
  const body = d.cov?.depth ?? NaN;
  if (!pick) { bad(`${c},${r}: ${piece} is not drawn over the body here (me ${JSON.stringify(me)})`); continue; }
  const verdict = body > pick.depth ? "over" : "under";
  console.log(`${c},${r} (${what}): body ${body} vs ${pick.piece} ${pick.depth} -> body draws ${verdict}, want ${verdict === want ? "same" : want.toUpperCase()}${d.cov?.hidden ? ` | outline ${Math.round((d.cov.hiddenFrac ?? 0) * 100)}%` : ""}`);
  if (verdict !== want) bad(`${c},${r}: the body draws ${verdict} ${piece} (${body} vs ${pick.depth}) — want ${want}`);
}
await ctx.close();
await browser.close();
stop();
if (errs.length) console.log("page errors:", JSON.stringify(errs.slice(0, 3)));
console.log(failed ? "verify-scenerysort: FAILED" : "verify-scenerysort: OK — every spot sorts the way his footprint rule says");
process.exit(failed ? 1 : 0);
