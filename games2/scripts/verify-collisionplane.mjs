// THE OVERLAYS AND THE WORLD ARE ON ONE PLANE.
//
//   node scripts/verify-collisionplane.mjs [--world=the_game]
//
// A cell diamond, a footprint ellipse and a body circle all describe GROUND,
// and the ground is drawn by the tiles3 frame on a maps3 world. `projectFlat`
// answers a different question — where a BODY's feet are drawn, which is the
// diamond's centre plus the character ground anchor — and feeding it ground
// coordinates has now put an overlay off its own world TWICE: the spawn zones
// half a cell down (2026-07-30) and the collision overlay 4 px (2026-09-02,
// the maps agent's report off the maintainer's annotated screenshot; measured
// here as exactly DY - TOP_Y).
//
// So this gate pins the invariant numerically, where a pixel test is fragile:
// what `projectCellCorner` returns for a cell centre must equal the anchor the
// SCENERY ART is placed through for the same point, and must NOT equal
// projectFlat (which would mean the fix was reverted to the body plane).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));
const WORLD = String(args.world ?? "the_game");
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`); if (!ok) fails.push(msg); };
if (!existsSync(join(ROOT, "client", "dist", "index.html"))) { console.error("verify-collisionplane: CANNOT MEASURE — client/dist is missing (npm run build:client)"); process.exit(2); }

const port = 2600 + Math.floor(Math.random() * 300);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
  cwd: join(ROOT, "server"), detached: true,
  env: { ...process.env, PORT: String(port), SERVE_CLIENT: "1", NODE_ENV: "production" },
  stdio: ["ignore", "ignore", "ignore"],
});
const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
process.on("exit", stop);
for (let t0 = Date.now(); ; ) {
  try { if ((await fetch(origin + "/health")).ok) break; } catch {}
  if (Date.now() - t0 > 90_000) { console.error("verify-collisionplane: server never healthy"); process.exit(2); }
  await new Promise((r) => setTimeout(r, 250));
}
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 480, height: 320 }, serviceWorkers: "block" });
const page = await ctx.newPage();
await page.addInitScript(({ world }) => {
  localStorage.setItem("ml-last-choice", JSON.stringify({ world, characterUid: "default_boy", name: "Plane" }));
  sessionStorage.setItem("ml-rejoin", "1");
}, { world: WORLD });
await page.goto(origin + "/", { waitUntil: "commit" });
await page.waitForFunction(() => { try { return !!window.__ml && window.__ml.players() >= 1; } catch { return false; } }, null, { timeout: 150_000, polling: 100 });

// Several cells, including far from the origin: a projection error that is a
// per-cell TERM shows everywhere, one that is a slope shows only out here.
const cells = [[422, 340], [100, 100], [255, 255], [500, 20]];
const rows = await page.evaluate((cs) => cs.map(([c, r]) => [c, r, window.__ml.planes(c, r)]), cells);
for (const [c, r, p] of rows) {
  console.log(`  (${c},${r}) art=${p.art?.y} corner=${p.corner.y} flat=${p.flat.y}  cornerVsArt=${JSON.stringify(p.cornerVsArt)} flatVsArt=${JSON.stringify(p.delta)}`);
  check(!!p.art, `(${c},${r}) has a tiles3 frame to compare against`);
  if (!p.art) continue;
  check(Math.abs(p.cornerVsArt.x) < 1e-6 && Math.abs(p.cornerVsArt.y) < 1e-6, `(${c},${r}) the overlay's cell projection IS the art plane`);
  // Non-vacuous: the two planes really are different, so agreeing is a result.
  check(Math.abs(p.delta.y) > 0.5 && Math.abs(p.delta.x) < 1e-6, `(${c},${r}) projectFlat still differs, vertically only (${p.delta.y} px) — the body-seat convention`);
}
const first = rows[0][2];
const same = rows.every(([, , p]) => Math.abs(p.delta.y - first.delta.y) < 1e-6);
check(same, `the body-seat offset is a CONSTANT across the map (${first.delta.y} px), not a slope`);
await browser.close(); stop();
console.log(fails.length ? `\nverify-collisionplane: ${fails.length} FAILED` : "\nverify-collisionplane: OK");
process.exit(fails.length ? 1 : 0);
