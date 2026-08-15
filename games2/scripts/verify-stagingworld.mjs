// verify-stagingworld — join a world that DOES NOT EXIST ON DISK, streamed
// end to end through the staging path (maintainer 2026-08-15: dev maps leave
// the image and cost production nothing; an admin still plays them).
//
// THE FIXTURE IS THE WORLD'S ONLY SOURCE. A copy of house_demo is served as
// "staging_probe" from a second local origin (:5199) that the repo's working
// tree does not contain — so if EITHER half of the staging path is broken,
// the join visibly fails:
//   • SERVER half: WorldRoom finds no maps2/worlds/staging_probe on disk and
//     must fetch world.json + spawns.json from STAGING_WORLD_BASE. Proof:
//     monsters exist (they only spawn from a fetched spawns.json) and the
//     player lands on the fixture world's spawn cell.
//   • CLIENT half: every art/data URL must resolve against the staging base
//     (ml-staging-base override — same injection point the real CDN uses).
//     Proof: world.json/tiles arrive from :5199 and NOTHING asks :5173 for
//     /assets/maps2/worlds/staging_probe.
//
// Local origins instead of GitHub/jsDelivr for the same reason as
// verify-staging: this sandbox gives the headless browser no external egress,
// and a gate that tested the CDN's uptime would not be testing our code.
//
// REQUIRES the dev stack started with STAGING_WORLD_BASE=http://localhost:5199
// (the server reads it at module load). The gate detects the missing env and
// says so rather than failing cryptically.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, stat, cp, mkdir, rm } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIX = "/tmp/staging-world-fixture";
const PORT = 5199;
// Unique per run: Colyseus keeps a room alive per world name, so a reused
// name would rejoin an earlier run's room (with its earlier, possibly broken,
// staging fetches) instead of exercising a fresh server-side load.
const WORLD = `staging_probe_${Date.now().toString(36)}`;
const fail = (m) => {
  console.error(`verify-stagingworld: FAIL — ${m}`);
  process.exit(1);
};

// The staging world: house_demo under a name that exists NOWHERE on disk.
await rm(FIX, { recursive: true, force: true });
await mkdir(join(FIX, "maps2", "worlds"), { recursive: true });
// monster_demo, not house_demo: the gate proves the server fetched the staged
// spawns.json by counting monsters, and house_demo ships ZERO spawn zones — a
// fixture with nothing to spawn can only ever fail (it did, and the code was
// fine: terrain=true, zones=0 was house_demo telling the truth).
await cp(join(REPO_ROOT, "maps2", "worlds", "monster_demo"), join(FIX, "maps2", "worlds", WORLD), { recursive: true });
const worldDoc = JSON.parse(await readFile(join(FIX, "maps2", "worlds", WORLD, "world.json"), "utf8"));
const SPAWN = worldDoc.spawn; // fixture truth the join must land on
// How many tiles this world actually uses — the bar for "art routed through
// staging" must come from the fixture, not a guessed constant (monster_demo
// uses 7; a hardcoded >20 failed a working path).
const TILE_COUNT = new Set((worldDoc.paths ?? []).filter((p) => typeof p === "string")).size;

const TYPES = { ".json": "application/json", ".webp": "image/webp", ".png": "image/png" };
const fixture = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  // staging_probe resolves from the fixture; everything else (tiles2 art the
  // world references, committed manifests) from the repo working tree.
  const p = rel.startsWith(`/maps2/worlds/${WORLD}/`) ? join(FIX, rel) : join(REPO_ROOT, rel);
  res.setHeader("access-control-allow-origin", "*");
  try {
    if (!(await stat(p)).isFile()) throw 0;
    res.setHeader("content-type", TYPES[extname(p)] ?? "application/octet-stream");
    res.end(await readFile(p));
  } catch {
    res.statusCode = 404;
    res.end("nope");
  }
});
await new Promise((r) => fixture.listen(PORT, r));

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  const page = await (await browser.newContext({ viewport: { width: 720, height: 480 } })).newPage();
  const hits = { fixtureWorld: 0, fixtureTiles: 0, localStagingAsset: 0 };
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes(`:${PORT}/maps2/worlds/${WORLD}/`)) hits.fixtureWorld++;
    if (u.includes(`:${PORT}/tiles2/`)) hits.fixtureTiles++;
    if (u.includes(`:5173/assets/maps2/worlds/${WORLD}`)) hits.localStagingAsset++;
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));

  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.evaluate(
    ([world, port]) => {
      localStorage.setItem("ml-staging-base", `http://localhost:${port}/`);
      localStorage.setItem(
        "ml-last-choice",
        JSON.stringify({ world, characterUid: "default_boy", name: "Probe" }),
      );
      sessionStorage.setItem("ml-rejoin", "1"); // skip the picker, join directly
    },
    [WORLD, PORT],
  );
  await page.reload({ waitUntil: "domcontentloaded" });

  const joined = await page
    .waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 60000 })
    .then(() => true)
    .catch(() => false);
  if (!joined) fail("never joined the staging world — is the dev stack running?");
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 30000 }).catch(() => {});
  // Monsters render only after the server seeds zones AND the client's strip
  // art lands — poll rather than snapshot (the starved harness draws ~3fps).
  await page.waitForFunction(() => (window.__ml.monsters?.() ?? 0) > 0, { timeout: 30000, polling: 500 }).catch(() => {});
  await page.waitForTimeout(1000);

  const st = await page.evaluate(() => {
    const m = window.__ml.me();
    return {
      cell: m ? [Math.round(m.x / 32), Math.round(m.y / 32)] : null,
      monsters: window.__ml.monsters?.() ?? 0,
      atlas: window.__ml.atlasInfo?.() ?? null,
    };
  });

  // SERVER HALF. An open-world fallback (staging fetch broken) spawns at the
  // open-world centre, not the fixture's spawn — and spawns NO monsters,
  // because spawns.json is only reachable through the fetch.
  // ±8 cells: placeAtSpawn jitters ±120 wu (±3.75 cells) then walks to open
  // land. The failure mode this separates from is the OPEN-WORLD fallback,
  // which centres at (width/2, height/2) — 20+ cells away in house_demo.
  if (!st.cell || Math.abs(st.cell[0] - SPAWN[0]) > 8 || Math.abs(st.cell[1] - SPAWN[1]) > 8)
    fail(
      `player landed at ${st.cell} — fixture spawn is ${SPAWN}. The SERVER did not load the staging world ` +
        `(dev stack must run with STAGING_WORLD_BASE=http://localhost:${PORT})`,
    );
  if (!(st.monsters > 0))
    fail("no monsters — the server never fetched the staging spawns.json");

  // CLIENT HALF: the world's data and art came from the staging origin, and
  // NOTHING asked the game origin for the staging world.
  if (!(hits.fixtureWorld > 0)) fail("client never fetched the staging world.json from the fixture");
  // The staged world has no committed atlas (its name is unique per run), so
  // the atlas index 404s and every tile loads individually — exactly the
  // documented fallback, and it means all TILE_COUNT tiles must come from the
  // staging origin.
  if (hits.fixtureTiles < TILE_COUNT)
    fail(
      `client fetched ${hits.fixtureTiles}/${TILE_COUNT} tiles from the fixture — art is not routing through staging`,
    );
  if (hits.localStagingAsset > 0)
    fail(`${hits.localStagingAsset} request(s) for the staging world hit the game origin — the chokepoint leaks`);
  if (errs.length) fail(`page errors: ${errs.join(" | ")}`);

  console.log(
    `verify-stagingworld: OK — joined "${WORLD}" (exists ONLY on the fixture): spawn ${st.cell}, ` +
      `${st.monsters} monsters via server-side staging fetch, ${hits.fixtureWorld} world + ` +
      `${hits.fixtureTiles} tile requests via client staging, 0 leaks to the game origin`,
  );
} finally {
  await browser.close();
  fixture.close();
  await rm(FIX, { recursive: true, force: true });
}
