// THE ZONE CROSSING'S GATE (spec/ZONES.md, docs/backend.md): a headless player
// stands beside a zone border with monsters in view, crosses it (a hand-off:
// new room, new socket, the swap bind) and crosses back. Nothing drawn may
// flicker: THE FIRST SNAPSHOT OF THE NEW ROOM MUST ALREADY CARRY THE
// NEIGHBOURHOOD (`hop.snap`) — that is the fix and the thing to hold, because
// the client binds and reconciles against it — the reconcile must then remove
// no body that is ON SCREEN, and the drawn monster count must never fall to
// zero mid-hop. A me-only snapshot is only VISIBLE when it is bound within the
// server's 200 ms interest period, which localhost timing hides; `snap` is
// checked instead, and it is deterministic. Needs a built client. Bisect:
// INTEREST_FILL_AT_JOIN=0 on the server must fail this gate.
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

// A border with monsters beside it: the spawn area whose centre lies nearest
// an interior zone line, and the crossing point on that line at the area's
// height (or width). AT=c,r,dc,dr overrides (from cell, and the hop vector).
const zones = await (await fetch(origin + "/api/zones/the_game")).json();
const spawns = await (await fetch(origin + "/assets/maps2/worlds3/the_game/spawns.json")).json();
const size = (await (await fetch(origin + "/assets/maps2/worlds3/the_game/world.json")).json()).size;
let from, hopVec;
if (process.env.AT) {
  const [c, r, dc, dr] = process.env.AT.split(",").map(Number);
  from = [c, r]; hopVec = [dc, dr];
} else {
  // shared/zones.ts: cols x rows equal rectangles of whole cells, zw = ceil(w / cols).
  const cols = Math.max(1, Math.floor(zones?.cols ?? 1)), rows = Math.max(1, Math.floor(zones?.rows ?? 1));
  const zw = Math.ceil(size.w / cols), zh = Math.ceil(size.h / rows);
  const xs = new Set(), ys = new Set();
  for (let k = 1; k < cols; k++) xs.add(k * zw);
  for (let k = 1; k < rows; k++) ys.add(k * zh);
  let best = null;
  for (const z of spawns.zones ?? []) {
    const pts = z.area ?? [];
    if (!pts.length) continue;
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    for (const x of xs) { const d = Math.abs(cx - x); if (!best || d < best.d) best = { d, from: [x - 2.5, cy], vec: [5, 0] }; }
    for (const y of ys) { const d = Math.abs(cy - y); if (!best || d < best.d) best = { d, from: [cx, y - 2.5], vec: [0, 5] }; }
  }
  if (!best) throw new Error("no zone line near a spawn area");
  from = best.from; hopVec = best.vec;
}
console.log(`crossing at ${from.map((v) => v.toFixed(1)).join(",")} by ${hopVec.join(",")} (zone lines from /api/zones)`);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1, serviceWorkers: "block" });
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
const snap = () => page.evaluate(() => { const z = window.__ml.zone(); return { zone: z.zone, hops: z.hops, swapping: z.swapping, last: z.lastHop, n: window.__ml.monsterInfo().length, ids: window.__ml.monsterInfo().map((m) => m.id) }; });

const cross = async (label, at) => {
  await page.evaluate(([c, r]) => window.__ml.teleport(c, r), at);
  // Settle here first: the hop of the teleport itself (if any) done, monsters drawn.
  let s = null;
  for (let i = 0; i < 60; i++) { await sleep(250); s = await snap(); if (!s.swapping && s.n > 0 && i > 8) break; }
  return s;
};

// Stand on the near side, then hop over and back.
let before = await cross("park", from);
console.log(`parked: zone ${before.zone}, ${before.n} monsters drawn, hops so far ${before.hops}`);
if (before.n === 0) bad("no monsters drawn beside the border — pick another spot (AT=c,r,dc,dr)");
for (const [label, target] of [["over", [from[0] + hopVec[0], from[1] + hopVec[1]]], ["back", from]]) {
  const b = await snap();
  await page.evaluate(([c, r]) => window.__ml.teleport(c, r), target);
  const trace = [];
  let hopAt = -1;
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    const s = await snap();
    trace.push(s);
    if (hopAt < 0 && s.hops > b.hops) hopAt = i;
    if (hopAt >= 0 && i - hopAt > 30 && !s.swapping) break;
  }
  // THE PER-FRAME TRUTH (`__ml.zone().frames`, recorded inside the scene):
  // how many monsters a player could SEE on each frame of the crossing.
  const frames = await page.evaluate(() => window.__ml.zone().frames);
  const end = trace[trace.length - 1];
  const ns = trace.map((s) => s.n);
  const kept = b.ids.filter((id) => end.ids.includes(id)).length;
  console.log(`${label}: zone ${b.zone} -> ${end.zone}, hop ${hopAt >= 0 ? "at sample " + hopAt : "NONE"} (join ${end.last?.joinMs ?? "-"} ms, state ${end.last?.stateMs ?? "-"} ms, bound ${end.last?.boundMs ?? "-"} ms) | JOIN SNAPSHOT ${JSON.stringify(end.last?.snap ?? null)} | monsters drawn ${b.n} -> ${end.n}, min ${Math.min(...ns)} max ${Math.max(...ns)} over ${trace.length} samples, ${kept} of the ${b.ids.length} drawn before still drawn | reconcile removed ${JSON.stringify(end.last?.removed ?? null)}`);
  const vis = frames.map((f) => f.vis);
  const floor = vis.length ? Math.min(...vis) : -1;
  const median = vis.length ? [...vis].sort((a, b) => a - b)[Math.floor(vis.length / 2)] : -1;
  const dips = frames.filter((f) => f.vis < 0.5 * median);
  console.log(`${label}: frames recorded ${frames.length}, visible monsters median ${median} floor ${floor}${dips.length ? " DIPS " + JSON.stringify(dips.slice(0, 6)) : ""}`);
  if (hopAt < 0) bad(`${label}: no hand-off happened`);
  else {
    const snap = end.last?.snap;
    const r = end.last?.removed;
    // THE FIX ITSELF: the room I bound on already knew my neighbourhood.
    if (!snap || snap.players < 1) bad(`${label}: the join snapshot held no player, not even me ${JSON.stringify(snap)}`);
    else if (snap.monsters < Math.min(8, 0.5 * b.n)) bad(`${label}: the join snapshot held ${snap.monsters} monsters where ${b.n} were drawn — the client bound on a me-only view`);
    if (!r || r.inView !== 0) bad(`${label}: the swap's reconcile removed a body ON SCREEN ${JSON.stringify(r)}`);
    if (Math.min(...ns) === 0) bad(`${label}: a sampled frame drew no monsters`);
    // A frame is 16 ms: this is the reported bug, seen directly.
    // Headless renders this scene at 3-8 fps, so a 3 s watch holds ~10 frames.
    if (frames.length < 5) bad(`${label}: the crossing watch recorded ${frames.length} frames — it did not arm`);
    else if (floor < 0.5 * median) bad(`${label}: a FRAME showed ${floor} monsters where the crossing's median is ${median}`);
  }
}
await ctx.close();
await browser.close();
stop();
if (errs.length) console.log("page errors:", JSON.stringify(errs.slice(0, 3)));
console.log(failed ? "verify-zonehop: FAILED" : "verify-zonehop: OK — two crossings, nothing drawn was removed or lost");
process.exit(failed ? 1 : 0);
