// INDOOR SCENERY — the furniture of a house is drawn when you are inside it,
// and never when you are not.
//
//   node scripts/verify-indoorscenery.mjs [--world=the_game]
//
// WHY IT EXISTS: every piece under a roof or cave deck was dropped from the
// scenery index at load (render3's overview rule, which a cut-away must not
// share), so on the_game 136 placements — every bed, cupboard, hearth, table,
// chair, brazier and rug — were invisible in the game while the server still
// stamped their footprints into the collision grid (maintainer: "it feels like
// something is invisible inside this house"). The index now keeps them flagged
// and the scene draws one only while its roof is cut away.
//
// The house is DERIVED from the world doc, never hardcoded: the roof deck with
// the most furniture, a free floor cell inside it to stand on, and the spawn to
// step back out to.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }),
);
const WORLD = String(args.world ?? "the_game");
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`); if (!ok) fails.push(msg); };
const die = (m) => { console.error(`verify-indoorscenery: CANNOT MEASURE — ${m}`); process.exit(2); };

// --- the house, from the world doc itself
const wj = join(REPO, "maps2", "worlds3", WORLD, "world.json");
if (!existsSync(wj)) die(`${wj} is missing (a maps3 world is required)`);
const doc = JSON.parse(readFileSync(wj, "utf8"));
const trunc = (v) => Math.trunc(v);
let house = null;
for (const d of doc.decks ?? []) {
  if (d.kind !== "roof" && d.kind !== "cave") continue;
  const cells = new Set((d.cells ?? []).map((c) => `${c.x ?? c.col},${c.y ?? c.row}`));
  const furniture = (doc.scenery ?? []).filter((p) => cells.has(`${trunc(p.x)},${trunc(p.y)}`));
  if (!house || furniture.length > house.furniture.length) house = { d, cells, furniture };
}
if (!house || house.furniture.length < 3) die("no roofed deck on this world holds furniture — nothing to verify");
const occupied = new Set(house.furniture.map((p) => `${trunc(p.x)},${trunc(p.y)}`));
const inside = [...house.cells]
  .map((k) => k.split(",").map(Number))
  .filter(([x, y]) => !occupied.has(`${x},${y}`) && doc.level?.[y]?.[x] === 0)
  .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
if (!inside.length) die("the furnished room has no free floor cell to stand on");
const stand = inside[Math.floor(inside.length / 2)];
const spawn0 = doc.spawn ?? [Math.round(doc.size.w / 2), Math.round(doc.size.h / 2)];
console.log(`[indoorscenery] ${WORLD}: room of ${house.cells.size} cells with ${house.furniture.length} pieces; standing at ${stand}, outside at ${spawn0}`);

// --- a prod server on the working tree
const port = 2600 + Math.floor(Math.random() * 300);
const origin = `http://127.0.0.1:${port}`;
const tsx = join(ROOT, "node_modules", ".bin", "tsx");
if (!existsSync(join(ROOT, "client", "dist", "index.html"))) die("client/dist is missing — run npm run build:client first");
const child = spawn(tsx, ["src/index.ts"], {
  cwd: join(ROOT, "server"), detached: true,
  env: { ...process.env, PORT: String(port), SERVE_CLIENT: "1", NODE_ENV: "production" },
  stdio: ["ignore", "ignore", "ignore"],
});
const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
process.on("exit", stop);
for (let t0 = Date.now(); ; ) {
  try { if ((await fetch(origin + "/health")).ok) break; } catch {}
  if (Date.now() - t0 > 90_000) die("the server never became healthy");
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 480, height: 320 }, serviceWorkers: "block" });
const page = await ctx.newPage();
await page.addInitScript(({ world }) => {
  localStorage.setItem("ml-last-choice", JSON.stringify({ world, characterUid: "default_boy", name: "Indoors" }));
  sessionStorage.setItem("ml-rejoin", "1");
}, { world: WORLD });
await page.goto(origin + "/", { waitUntil: "commit" });
await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 150_000, polling: 100 });
await page.waitForFunction(() => { try { return window.__ml.tiles3().drew.blits > 0; } catch { return false; } }, null, { timeout: 120_000, polling: 250 }).catch(() => {});

// SETTLE ON THE PICTURE, NEVER ON A FIXED WAIT — and never on "the loaders
// are quiet" alone. Teleporting lands in a neighbourhood whose scenery streams
// in two round trips (the piece manifest, then the art that manifest names),
// and BOTH loaders read quiet in the window between a manifest landing and the
// rebuild that queues its art. This harness renders on software GL at ~0.5 s a
// frame, so sampling in that window photographs an empty room and calls it a
// bug — it did, twice, while the fix under test was working. So: quiet AND the
// number of drawn sprites unchanged across three consecutive samples.
const settle = async () => {
  let last = -1;
  let same = 0;
  for (let i = 0; i < 120; i++) {
    const s = await page.evaluate(() => {
      try {
        const t = window.__ml.tiles3();
        const si = window.__ml.sceneryIndoor();
        return { h: t.hold, drawn: t.drew.scenery, blits: t.drew.blits, maskUp: si.maskUp, indoor: si.indoor };
      } catch {
        return null;
      }
    });
    if (s && s.blits > 0) {
      const quiet = s.h.piecesIdle && s.h.artIdle && s.h.queued === 0 && !s.h.loaderBusy && !s.h.manifestTimer;
      // AND the doorway transition has finished. The light grade outlives the
      // scenery by seconds here (a ~1.9 s exponential tail at ~0.5 s a frame),
      // and mid-fade the mask is still up while the verdict already says
      // outside — a legitimate crossfade state, not the settled one this gate
      // measures. Settled means the mask agrees with the verdict.
      const settledIndoor = s.maskUp === s.indoor;
      same = quiet && settledIndoor && s.drawn === last ? same + 1 : 0;
      last = s.drawn;
      if (same >= 3) return;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  console.log("  (the scene never settled — sampling anyway)");
};

const at = async (col, row, label) => {
  await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [col, row]);
  await settle();
  const s = await page.evaluate(() => ({ scenery: window.__ml.sceneryIndoor(), indoor: window.__ml.indoor(), t3: window.__ml.tiles3() }));
  console.log(
    `[${label}] indoor=${s.indoor?.indoor} roofed=${s.scenery.roofed} cutAway=${s.scenery.cutAway} drawnRoofed=${s.scenery.drawnRoofed} drawn=${s.scenery.drawn} pieces=${s.t3.pieces.loaded}/${s.t3.pieces.requested}`,
  );
  return s;
};

const home = await at(stand[0], stand[1], "inside the house");
check(home.indoor?.indoor === true, "standing in the room puts the renderer indoors");
check(home.scenery.roofed > 50, `the index KEEPS the roofed placements (${home.scenery.roofed}) instead of dropping them at load`);
check(home.scenery.cutAway > 0, `the cut lets the room's own pieces through (${home.scenery.cutAway})`);
check(home.scenery.drawnRoofed > 0, `indoor furniture is actually DRAWN (${home.scenery.drawnRoofed} pieces)`);
check(
  home.scenery.drawnRoofed <= home.scenery.cutAway,
  `nothing is drawn that the cut did not release (${home.scenery.drawnRoofed} <= ${home.scenery.cutAway})`,
);
// THE BUSH-ON-THE-ROOF GUARD, and the reason the pieces were dropped in the
// first place: standing in MY building must not open every other roof on the
// map. The cut is per column (`cutAt` answers Infinity for a column drawn
// whole), so only this room's pieces may pass — a small fraction of all of
// them, and the neighbour's house keeps its furniture hidden with its roof.
check(
  home.scenery.cutAway < home.scenery.roofed / 2,
  `only MY room's roof is cut — ${home.scenery.cutAway} of ${home.scenery.roofed} roofed pieces released`,
);
await page.screenshot({ path: join(ROOT, "scripts", "_tmp-indoor-inside.png") });

const out = await at(spawn0[0], spawn0[1], "outside at the spawn");
check(out.indoor?.indoor === false, "back outdoors");
check(out.scenery.maskUp === false, "the cut-away is fully rolled back (the exit fade landed)");
check(out.scenery.cutAway === 0, `with no cut drawn, NO roofed piece may pass (${out.scenery.cutAway})`);
check(out.scenery.drawnRoofed === 0, `no roofed piece is drawn outdoors — no furniture on a roof (${out.scenery.drawnRoofed})`);
check(out.scenery.drawn > 0, `outdoor scenery still draws (${out.scenery.drawn} sprites)`);
await page.screenshot({ path: join(ROOT, "scripts", "_tmp-indoor-outside.png") });

await browser.close(); stop();
console.log(fails.length ? `\nverify-indoorscenery: ${fails.length} FAILED` : "\nverify-indoorscenery: OK");
process.exit(fails.length ? 1 : 0);
