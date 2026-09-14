// THE PACKED NPC LAYER'S GATE (docs/monsters-combat.md, NPCs): the manifest
// built from the packed frames must put every NPC's feet on the same pixel as
// the one built from the raw frames — the anchor is measured raw and converted
// into the packed box, so this checks the conversion, the box and every URL —
// then a headless boot of the_game draws every placed NPC from its packed
// texture (the sprite is the box's size, never the placeholder) with its feet
// on its shadow. Needs a built client. Exit 1 on any difference.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = process.env.ASSETS_ROOT || join(ROOT, "..");
let failed = false;
const bad = (m) => { failed = true; console.log("  MISMATCH " + m); };

// (1) raw manifest vs packed manifest, in source pixels.
const rawOut = join(ROOT, "client", "public", "npcs.raw-check.json");
execFileSync("node", [join(ROOT, "scripts", "build-npcs-manifest.mjs")], { env: { ...process.env, NPCS_PACK: "0", NPCS_MANIFEST_OUT: rawOut }, stdio: "ignore" });
const raw = JSON.parse(readFileSync(rawOut, "utf8")).npcs;
unlinkSync(rawOut);
const packed = JSON.parse(readFileSync(join(ROOT, "client", "public", "npcs.json"), "utf8")).npcs;
const rawById = new Map(raw.map((n) => [n.id, n]));
let npcs = 0, anchors = 0, urls = 0, unpacked = 0;
for (const n of packed) {
  const r = rawById.get(n.id);
  if (!r) { bad(`${n.id}: missing from the raw manifest`); continue; }
  if (!n.packed) { unpacked++; continue; }
  npcs++;
  const b = n.packed;
  if (n.frameW !== b.w || n.frameH !== b.h) bad(`${n.id}: frame ${n.frameW}x${n.frameH} is not the box ${b.w}x${b.h}`);
  for (const d of Object.keys(r.anchors)) {
    const a = r.anchors[d], p = n.anchors[d];
    if (!p) { bad(`${n.id} ${d}: anchor lost`); continue; }
    anchors++;
    for (const [k, span, off] of [["x", r.frameW, b.ox], ["y", r.frameH, b.oy], ["top", r.frameH, b.oy]]) {
      const rawPx = a[k] * span, packedPx = p[k] * (k === "x" ? b.w : b.h) + off;
      if (Math.abs(rawPx - packedPx) > 0.02) bad(`${n.id} ${d}.${k}: raw ${rawPx.toFixed(3)} px vs packed ${packedPx.toFixed(3)} px`);
    }
  }
  const check = (u) => { urls++; if (!u.includes("/packed/")) bad(`${n.id}: raw URL ${u}`); else if (!existsSync(join(ASSETS, u.replace(/^\/assets\//, "")))) bad(`${n.id}: ${u} is not on disk`); };
  for (const u of Object.values(n.base)) check(u);
  for (const d of Object.keys(n.idle)) {
    const list = n.idleUrls?.[d];
    if (!list || list.length !== n.idle[d]) bad(`${n.id} ${d}: ${n.idle[d]} idle frames, ${list?.length ?? 0} packed URLs`);
    for (const u of list ?? []) check(u);
  }
}
console.log(`manifest: ${npcs} packed NPCs (${unpacked} raw) | ${anchors} anchors within 0.02 px of the raw measure | ${urls} packed URLs on disk`);
if (!npcs) bad("no NPC is packed");

// (2) a headless boot: every placed NPC drawn from its packed texture, feet on its shadow.
const port = 3300 + Math.floor(Math.random() * 40);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], { cwd: join(ROOT, "server"), detached: true, env: { ...process.env, PORT: String(port), SERVE_CLIENT: "1", NODE_ENV: "production" }, stdio: ["ignore", "ignore", "ignore"] });
const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
process.on("exit", stop);
for (let t0 = Date.now(); ; ) { try { if ((await fetch(origin + "/health")).ok) break; } catch {} if (Date.now() - t0 > 90000) throw new Error("unhealthy"); await new Promise((r) => setTimeout(r, 250)); }
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const placed = (await (await fetch(origin + "/assets/maps2/worlds3/the_game/npcs.json")).json()).npcs;
const byId = new Map(packed.map((n) => [n.id, n]));
let drawn = 0, seen = new Set();
// Visit each placed NPC (teleport beside it) so its art is asked for and lands.
for (const p of placed) {
  if (seen.has(p.character)) continue;
  seen.add(p.character);
  await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [p.x + 1, p.y + 1]);
  let info = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    info = (await page.evaluate(() => window.__ml.npcInfo())).find((n) => n.id === p.id);
    const def = byId.get(p.character);
    if (info && def?.packed && info.dw === def.packed.w && info.dh === def.packed.h) break;
  }
  const def = byId.get(p.character);
  if (!info) { bad(`${p.id} (${p.character}): not spawned`); continue; }
  if (!def?.packed) continue;
  drawn++;
  if (info.dw !== def.packed.w || info.dh !== def.packed.h) bad(`${p.id} (${p.character}): drawn ${info.dw}x${info.dh}, packed box ${def.packed.w}x${def.packed.h}`);
  const a = def.anchors[info.dir];
  if (a && (Math.abs(info.originX - a.x) > 1e-4 || Math.abs(info.originY - a.y) > 1e-4)) bad(`${p.id}: origin ${info.originX},${info.originY} vs anchor ${a.x},${a.y}`);
  if (Math.abs(info.sy - info.shadowY) > 0.6 || Math.abs(info.sx - info.shadowX) > 0.6) bad(`${p.id}: feet ${info.sx},${info.sy} off the shadow ${info.shadowX},${info.shadowY}`);
}
await ctx.close();
await browser.close();
stop();
console.log(`boot: ${drawn} placed NPCs drawn from packed textures at the box's size, origin = anchor, feet on the shadow${errs.length ? " | page errors " + JSON.stringify(errs.slice(0, 2)) : ""}`);
console.log(failed ? "verify-npc-pack: FAILED" : "verify-npc-pack: OK — packed NPCs stand on the same pixel as the raw ones");
process.exit(failed ? 1 : 0);
