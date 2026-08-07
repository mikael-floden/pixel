// Browser gate: ambient effects STOP when the player is indoors.
//
// Everything this agent draws is outdoor weather/wildlife. The game now cuts the
// roof off a house and lets you walk in, so without this the flock keeps
// wheeling through the ceiling and the leaves fall past the furniture. The stop
// is a hard 1 -> 0 today, written as a gain so the planned indoor cross-fade is
// one constant (ambient/runtime/outdoor.ts).
//
// Unit tests (server/test/outdoor.test.ts) pin the controller's arithmetic and
// its fade path. What they CANNOT see is whether the gain is actually wired to
// what gets drawn — a feature that forgot to multiply still typechecks and still
// passes every unit test. So this drives the real game into a real house and
// asserts the DRAWN alpha, not the intent.
//
//   node scripts/verify-indoor-ambient.mjs      (needs the dev stack on :5173)
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function chromePath() {
  const root = "/opt/pw-browsers";
  const cands = existsSync(root)
    ? readdirSync(root)
        .filter((d) => /^chromium(-\d+)?$/.test(d))
        .map((d) => join(root, d, "chrome-linux", "chrome"))
    : [];
  return [...cands, join(root, "chromium")].find((p) => existsSync(p));
}

const URL = process.env.GAME_URL || "http://localhost:5173/";
const WORLD = process.env.WORLD || "house_demo";
let failed = false;
const fail = (m) => {
  console.error("FAIL:", m);
  failed = true;
};

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));

await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25_000 });
await page.evaluate((w) => {
  const i = window.__mlSelect.worlds().findIndex((n) => n === w);
  if (i >= 0) window.__mlSelect.pickWorld(i);
  window.__mlSelect.commit();
}, WORLD);
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 40_000 });
await page.waitForFunction(() => window.__mlAmbient?.outdoor, null, { timeout: 30_000 });

// Run the birds — the busiest effect, and the one with the most draw paths
// (ground flock, migratory groups, fog wash, ground shadow).
await page.evaluate(() => {
  window.__mlAmbient.auto(false);
  window.__mlAmbient.setEnabled("bats", false);
  window.__mlAmbient.setEnabled("birds", true);
  window.__mlAmbient.birdDensity(8);
});
const got = await page
  .waitForFunction(() => (window.__mlAmbient.debug("birds")?.all?.length ?? 0) > 2, null, { timeout: 40_000 })
  .then(() => true)
  .catch(() => false);
if (!got) fail("no birds appeared — cannot judge whether they stop indoors");

// ---- OUTDOORS: the baseline. Effects must be drawing. ----
const outside = await page.evaluate(() => {
  const o = window.__mlAmbient.outdoor();
  const b = window.__mlAmbient.debug("birds");
  return { o, n: b.all.length, maxA: Math.max(0, ...b.all.map((x) => x.a ?? 0)) };
});
console.log(`outdoors: indoor=${outside.o.indoor} gain=${outside.o.gain} birds=${outside.n} maxAlpha=${outside.maxA}`);
if (outside.o.indoor) fail("expected to start OUTDOORS");
if (outside.o.gain !== 1) fail(`outdoor gain should be 1, got ${outside.o.gain}`);
if (!(outside.maxA > 0)) fail("birds are outdoors but drawing at alpha 0 — the gain is inverted or stuck");

// Remember where we stood outside, so the walk back out is a real return.
const home = await page.evaluate(() => {
  // me() reports world units as x/y (NOT fx/fy — that is the avatar-render
  // field). 32 wu per cell; teleport takes cells. Getting this wrong yields
  // NaN and teleport silently no-ops, which reads as "the stop never reverses".
  const me = window.__ml.me();
  return { col: Math.round(me.x / 32), row: Math.round(me.y / 32) };
});
if (!Number.isFinite(home.col) || !Number.isFinite(home.row)) fail(`bad outdoor home cell: ${JSON.stringify(home)}`);

// ---- Walk inside. Go straight to a house instead of sweeping the map: the
// world data says where the roofs are (world@2 decks, kind "roof"), so a few
// candidates under one beat thousands of teleports — a per-cell sweep here
// timed out entirely under headless GL. The GAME still decides indoor/out;
// the deck data only picks where to stand.
const spot = await page.evaluate(async (world) => {
  const res = await fetch(`/assets/maps2/worlds/${world}/world.json`);
  if (!res.ok) return { error: `world.json ${res.status}` };
  const w = await res.json();
  const roofs = (w.decks ?? []).filter((d) => d.kind === "roof" && d.cells?.length);
  if (!roofs.length) return { error: "world ships no roof decks" };

  // Candidates: each roof's centroid first (deepest inside), then a handful of
  // its own cells as a fallback for L-shaped plans whose centroid is a wall.
  const cands = [];
  for (const d of roofs) {
    const cx = Math.round(d.cells.reduce((s, c) => s + c.x, 0) / d.cells.length);
    const cy = Math.round(d.cells.reduce((s, c) => s + c.y, 0) / d.cells.length);
    cands.push([cx, cy]);
    for (let i = 0; i < d.cells.length; i += Math.ceil(d.cells.length / 6))
      cands.push([d.cells[i].x, d.cells[i].y]);
  }
  for (const [col, row] of cands) {
    window.__ml.teleport(col, row);
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
    const info = window.__ml.indoor();
    if (info?.indoor) return { col, row, info };
  }
  return { error: `tried ${cands.length} spots under ${roofs.length} roof(s); none read indoors` };
}, WORLD);
if (spot?.error) fail(spot.error);
if (!spot || spot.error) {
  fail(`could not find an indoor cell in ${WORLD} — the game reported no indoor space anywhere nearby`);
} else {
  console.log(`indoors at (${spot.col}, ${spot.row}) roofLevel=${spot.info.roofLevel} depth=${spot.info.depth}`);
  // Let a few frames run so every feature has ticked at the new verdict.
  const inside = await page.evaluate(async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => requestAnimationFrame(r));
    const o = window.__mlAmbient.outdoor();
    const names = window.__mlAmbient.list();
    const alphas = {};
    for (const n of names) {
      const d = window.__mlAmbient.debug(n);
      const all = d?.all;
      if (Array.isArray(all) && all.length) alphas[n] = Math.max(0, ...all.map((x) => x.a ?? 0));
    }
    return { o, alphas };
  });
  console.log(`indoors: indoor=${inside.o.indoor} gain=${inside.o.gain} fadeMs=${inside.o.fadeMs}`);
  if (!inside.o.indoor) fail("the game says outdoors at a cell it just called indoors");
  if (inside.o.gain !== 0) fail(`outdoor gain should SNAP to 0 indoors, got ${inside.o.gain}`);
  for (const [n, a] of Object.entries(inside.alphas)) {
    console.log(`  ${n}: maxAlpha ${a}`);
    if (a > 0) fail(`${n} is still drawing indoors (alpha ${a})`);
  }

  // ---- Step back out. The ambience must RETURN, not stay parked: a stop that
  // never reverses would leave the world permanently dead after one doorway.
  const back = await page.evaluate(async (h) => {
    window.__ml.teleport(h.col, h.row);
    for (let i = 0; i < 120; i++) await new Promise((r) => requestAnimationFrame(r));
    const o = window.__mlAmbient.outdoor();
    const b = window.__mlAmbient.debug("birds");
    return { o, n: b.all.length, maxA: Math.max(0, ...b.all.map((x) => x.a ?? 0)) };
  }, home);
  console.log(`back outside: indoor=${back.o.indoor} gain=${back.o.gain} birds=${back.n} maxAlpha=${back.maxA}`);
  if (back.o.indoor) fail("teleport back outside did not clear the indoor verdict");
  if (back.o.gain !== 1) fail(`outdoor gain should return to 1, got ${back.o.gain}`);
  if (!(back.maxA > 0)) fail("birds stayed parked after stepping back outside — the stop does not reverse");
}

await browser.close();
console.log(failed ? "verify-indoor-ambient: FAILED" : "verify-indoor-ambient: OK");
if (failed) process.exitCode = 1;
