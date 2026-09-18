// A DROPPED ITEM IS A BODY — it must sort exactly like one standing on the same
// ground. Headless, on the_game, with a REAL drop on REAL raised terrain.
//
// WHY IT EXISTS: addDrop hand-rolled its own depth off the LIFTED screen y its
// art is drawn at, while every other body sorts on the painter line of the FLAT
// ground and lets `resolveDepthRule` lift it from there. The two agree only at
// level 0 — which is exactly the line the maintainer drew (2026-09-14: "It works
// when I stand on level 0, but when I walk up elevation and drop I can't see the
// item"; earlier: "I can't see the item in the game world, but it is still
// removed from my Inventory … I can pick it up again if I manage to click on
// that invisible object"). Measured here at elev 4: the old rule put the drop
// 60.6 px behind the body standing beside it, the ground in front painted over
// it, and the sprite was there all along — which is why the tap still worked.
//
// The drop is placed with `__ml.dropFake`, not by farming loot: loot is a
// per-kill roll and the hills are not where the monsters are. It is the same
// `addDrop` the room state drives.
//
// THE CELLS ARE DERIVED from the world doc, never hardcoded: the nearest
// standable non-deck cell at level >= 2 whose two cells down-screen are lower
// (so there is a face in front of it to be hidden behind), and a flat control.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { ensureClientDist } from "./clientdist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..");
const WORLD = String(Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("="))).world ?? "the_game");
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`); if (!ok) fails.push(msg); };
const die = (m) => { console.error(`verify-dropdepth: CANNOT MEASURE — ${m}`); process.exit(2); };

// --- the two cells, from the world doc itself
const wj = join(REPO, "maps2", "worlds3", WORLD, "world.json");
if (!existsSync(wj)) die(`no world at ${wj}`);
const doc = JSON.parse(readFileSync(wj, "utf8"));
const lv = doc.level;
const W = doc.width ?? lv[0].length;
const H = doc.height ?? lv.length;
const spawnCell = doc.spawn ?? [Math.floor(W / 2), Math.floor(H / 2)];
const onDeck = new Set();
for (const d of doc.decks ?? []) for (const c of d.cells ?? []) onDeck.add(c[1] * W + c[0]);
let raised = null;
let flat = null;
for (let r = 2; r < H - 2; r++) {
  for (let c = 2; c < W - 2; c++) {
    const l = lv[r]?.[c];
    if (l === undefined || onDeck.has(r * W + c)) continue;
    const d = Math.hypot(c - spawnCell[0], r - spawnCell[1]);
    if (l >= 2 && l <= 10 && lv[r + 1][c] < l && lv[r + 2][c] < l && lv[r][c + 1] === l && lv[r][c - 1] === l && lv[r - 1][c] === l) {
      if (!raised || d < raised.d) raised = { c, r, l, d };
    }
    if (l === 0 && lv[r + 1]?.[c] === 0 && lv[r][c + 1] === 0 && lv[r - 1][c] === 0) {
      if (!flat || d < flat.d) flat = { c, r, l, d };
    }
  }
}
if (!raised) die("no standable raised cell with lower ground in front — nothing to measure");
if (!flat) die("no flat control cell");
console.log(`[dropdepth] raised ${raised.c},${raised.r} at level ${raised.l}; flat control ${flat.c},${flat.r}`);

// --- a prod server on the working tree
const port = 2900 + Math.floor(Math.random() * 300);
const origin = `http://127.0.0.1:${port}`;
console.log(`[dropdepth] client/dist: ${ensureClientDist(ROOT, die, { tag: "dropdepth" })}`);
const child = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
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
  localStorage.setItem("ml-last-choice", JSON.stringify({ world, characterUid: "default_boy", name: "Drops" }));
  sessionStorage.setItem("ml-rejoin", "1");
}, { world: WORLD });
await page.goto(origin + "/", { waitUntil: "commit" });
await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 150_000, polling: 100 });
await page.evaluate(() => window.__ml.noAggro?.(true));

// The item is whatever the drop path can load: any published item id works, the
// texture is fetched per kind on the first drop of it.
const ITEM = "amethyst_point";

const measure = async (cell, tag) => {
  // A dead probe cannot teleport, and a zone hand-off clears the client's
  // drops — so settle the CROSSING before placing anything.
  const dead = await page.evaluate(() => !!window.__ml.me()?.dead);
  if (dead) {
    await page.evaluate(() => window.__ml.roomSend?.("respawn", {}));
    await page.waitForFunction(() => !window.__ml.me()?.dead, null, { timeout: 30_000, polling: 250 }).catch(() => {});
  }
  await page.evaluate(([c, r]) => window.__ml.teleport(c + 0.5, r + 0.5), [cell.c, cell.r]);
  await page.waitForTimeout(7000);
  const made = await page.evaluate((it) => window.__ml.dropFake(it), ITEM);
  // The depth is resolved when the art lands (the rule measures the art box).
  await page.waitForFunction(
    (id) => window.__ml.dropsList().some((d) => d.id === id && d.shown),
    made.id,
    { timeout: 30_000, polling: 100 },
  ).catch(() => {});
  await page.waitForTimeout(600);
  const st = await page.evaluate((id) => {
    const d = window.__ml.dropsList().find((x) => x.id === id);
    const dp = window.__ml.depthProbe();
    return { drop: d ?? null, body: dp?.me?.depth ?? null, elev: window.__ml.me()?.elev ?? null };
  }, made.id);
  if (!st.drop) { check(false, `[${tag}] the drop survived the crossing and is in the world`); return null; }
  const delta = st.drop.depth - st.body;
  console.log(`[${tag}] cell ${cell.c},${cell.r} level ${made.elev}: drop depth ${st.drop.depth}, body ${st.body}, Δ ${delta.toFixed(1)} px (shown ${st.drop.shown})`);
  return { ...st, delta, made };
};

const f = await measure(flat, "flat");
if (f) {
  check(f.drop.shown, "the control drop's art landed and it is drawn");
  check(Math.abs(f.delta) <= 2, `on flat ground a drop sorts with a body on it (Δ ${f.delta.toFixed(1)} px)`);
}
const up = await measure(raised, "raised");
if (up) {
  check(up.made.elev >= 2, `the raised cell really is raised (level ${up.made.elev}) — the arm is meaningful`);
  check(up.drop.shown, "the raised drop's art landed and it is drawn");
  // THE BUG: the lifted-y depth is elev*lh px short of the body's, so terrain in
  // front paints over the item. Nothing else about the drop changes with height.
  check(
    Math.abs(up.delta) <= 2,
    `ON RAISED GROUND a drop sorts with a body standing on it (Δ ${up.delta.toFixed(1)} px; the hand-rolled lift put it a storey-height per level behind — −104.6 at this cell, measured on the old rule)`,
  );
  // ...and its shadow lies on the ground it landed on, not at its lifted feet.
  check(
    Math.abs(up.drop.shadowY - (up.drop.lyFlat - up.made.elev * 15.15)) <= 16,
    `its shadow lies on the ground it landed on (shadow y ${up.drop.shadowY}, flat line ${up.drop.lyFlat})`,
  );
}

await browser.close();
stop();
console.log(fails.length ? `\nverify-dropdepth: ${fails.length} FAILED` : "\nverify-dropdepth: OK");
process.exit(fails.length ? 1 : 0);
