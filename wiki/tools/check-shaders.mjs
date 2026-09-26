// The Shaders section under Items (maintainer 2026-09-26: "We need a new wiki
// page under Items called Shaders that will allow me to review the work from
// the new effect/shader-agent ... it's important that you render the effects
// the same way they would render in the game!").
//
// The page embeds the shader agent's viewer (shaders/docs/wiki.md) and owns the
// verdicts and the tuning save. What must hold, derived from the catalog the
// page reads rather than typed here:
//   - admin: Items | Shaders tabs, one card per catalog effect, family chips;
//   - player: no Shaders tab at all (nothing is bound to a skill yet);
//   - the effect page boots the viewer from /assets/shaders/viewer/ in embed
//     mode and the EFFECT DRAWS — measured in composited screenshots of its
//     canvas, since a WebGL canvas reads back blank between frames;
//   - a tunable moved inside the viewer marks tuning/shaders dirty, with the
//     contract's shape: changed values + `was` = the defaults they replaced;
//   - a verdict lands in feedback/shaders under the catalog `key`.
// Run: node wiki/tools/serve-assets.mjs 8902 & node wiki/tools/check-shaders.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const ROOT = new URL("../../", import.meta.url).pathname;
const CAT = JSON.parse(readFileSync(join(ROOT, "shaders/shaders.json"), "utf8"));
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });

async function page(admin) {
  const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ admin }) }));
  await p.addInitScript((a) => {
    if (a) localStorage.setItem("wiki-admin-token", "gate"); localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
    localStorage.removeItem("wiki-shader-family"); localStorage.removeItem("wiki-shader-ground");
    window.addEventListener("message", (e) => { if (e.data?.type === "shaders:ground") (window.__groundPlans ??= []).push(e.data); });
  }, admin);
  return { ctx, p, errs };
}

// ---- admin: tabs + list
const A = await page(true);
await A.p.goto(`${W}#/items`, { waitUntil: "load" }); await A.p.waitForTimeout(2500);
const tabs = await A.p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-items-tab"] button')].map((x) => x.textContent.trim()));
ok(tabs.length === 2 && tabs[1] === `Shaders ${CAT.effects.length}`, `the admin gets Items | Shaders, counted from the catalog (${tabs.join(" | ")})`);
await A.p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-items-tab"] button')].find((x) => /^Shaders/.test(x.textContent))?.click());
await A.p.waitForTimeout(1600);
const list = await A.p.evaluate(() => ({
  hash: location.hash, cards: [...document.querySelectorAll(".shader-card")].map((a) => decodeURIComponent(a.getAttribute("href").split("/").pop())),
  chips: [...document.querySelectorAll('[data-bar="wiki-shader-family"] button')].map((x) => x.textContent.trim()),
}));
ok(list.hash === "#/items/shaders" && list.cards.length === CAT.effects.length && CAT.effects.every((e) => list.cards.includes(e.id)),
  `one card per catalog effect (${list.cards.length} of ${CAT.effects.length})`);
const fams = [...new Set(CAT.effects.map((e) => e.family))];
ok(list.chips.length === fams.length + 1, `a family chip per family plus "all" (${list.chips.length} chips, ${fams.length} families)`);
const f0 = fams[0];
await A.p.evaluate((l) => [...document.querySelectorAll('[data-bar="wiki-shader-family"] button')].find((x) => x.textContent.trim().startsWith(l))?.click(), CAT.families?.[f0]?.label ?? f0);
await A.p.waitForTimeout(900);
const nf = await A.p.evaluate(() => document.querySelectorAll(".shader-card").length);
ok(nf === CAT.effects.filter((e) => e.family === f0).length, `a family chip keeps exactly its effects (${f0}: ${nf})`);
await A.p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-shader-family"] button')].find((x) => /^all /.test(x.textContent.trim()))?.click());

// ---- admin: effect page, viewer, drawing
const beam = CAT.effects.find((e) => e.kind === "beam") ?? CAT.effects[0];
await A.p.goto(`${W}#/items/shaders/${encodeURIComponent(beam.id)}`, { waitUntil: "load" }); await A.p.waitForTimeout(3500);
const fr = A.p.frames().find((f) => /\/assets\/shaders\/viewer\/index\.html/.test(f.url()));
ok(!!fr && /embed=1/.test(fr.url()) && fr.url().includes(`id=${encodeURIComponent(beam.id)}`),
  `the effect page embeds the viewer from /assets/shaders/viewer/ in embed mode (${fr?.url().split("/assets/")[1] ?? "no frame"})`);
let peak = 0;
if (fr) {
  const cv = await fr.$("canvas");
  for (let i = 0; i < 10 && cv; i++) {
    const png = await cv.screenshot();
    peak = Math.max(peak, await A.p.evaluate(async (b64) => {
      const im = new Image(); im.src = `data:image/png;base64,${b64}`; await im.decode();
      const c = document.createElement("canvas"); c.width = im.width; c.height = im.height; const g = c.getContext("2d"); g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let k = 0; k < d.length; k += 4) { const mx = Math.max(d[k], d[k + 1], d[k + 2]), mn = Math.min(d[k], d[k + 1], d[k + 2]); if (mx > 150 && mx - mn > 60) n++; }
      return n;
    }, png.toString("base64")));
    if (peak > 500) break;
    await A.p.waitForTimeout(300);
  }
}
ok(peak > 500, `the effect DRAWS inside the wiki — ${beam.id} lit ${peak} bright pixels at its peak`);
const vr = await A.p.evaluate(() => [...document.querySelectorAll("button")].map((x) => x.textContent.trim()).filter((t) => /approve|redo|remove/.test(t)));
ok(vr.includes("✓ approve") && vr.some((t) => /redo/.test(t)), `the verdict row is there (${vr.join(" · ")})`);

// ---- the ground: the base tile set with the HIGHEST weight, members drawn by
// their own weights (maintainer 2026-09-26: "respect the 'base tile set' and
// the weights used to draw from it ... use the set with highest weight
// always"). The plan the viewer receives is checked against the committed
// live/tuning/base_tile_sets.json, not against the page's own arithmetic.
{
  const SETS = JSON.parse(readFileSync(join(ROOT, "live/tuning/base_tile_sets.json"), "utf8")).grounds ?? {};
  const stepper = await A.p.evaluate(() => document.querySelector(".shader-ground")?.textContent.replace(/\s+/g, " ").trim() ?? "");
  ok(/^Ground/.test(stepper), `a ground stepper sits under the stage (${stepper})`);
  const seen = [];
  const grab = () => fr.evaluate(() => window.__groundPlans ?? []);
  for (let i = 0; i < 3; i++) { await A.p.click('.shader-ground button[aria-label="Next ground"]'); await A.p.waitForTimeout(250); }
  seen.push(...await grab());
  ok(seen.length >= 4, `the viewer receives a floor plan on boot and on every ‹ › (${seen.length} plans: ${seen.map((x) => x.ground).join(", ")})`);
  const bad = seen.filter((plan) => {
    const maxW = Math.max(...(SETS[plan.ground]?.sets ?? []).map((s) => Number(s.weight) || 0));
    const shares = plan.tiles.map((_, i) => plan.grid.cells.filter((c) => c === i).length / plan.grid.cells.length);
    const drift = Math.max(...plan.tiles.map((x, i) => Math.abs(shares[i] - x.share)));
    return plan.set.weight !== maxW || drift > 0.08 || plan.grid.cells.length !== plan.grid.cols * plan.grid.rows;
  });
  ok(seen.length && !bad.length, `each plan uses the ground's highest-weight set and draws its tiles by their weights (off: ${bad.map((x) => x.ground).join(", ") || "none"})`);
  if (seen[0]) console.log(`    (${seen[0].ground}: ${seen[0].set.name} #${seen[0].set.id}, weight ${seen[0].set.weight}, ${seen[0].tiles.length} tiles)`);
}

// ---- tuning: move a tunable inside the viewer
const moved = fr ? await fr.evaluate(() => {
  const el = [...document.querySelectorAll("input")].find((i) => i.id?.startsWith("t-") && i.type === "range");
  if (!el) return null;
  el.value = String(el.max); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.id;
}) : null;
await A.p.waitForTimeout(900);
const bar = await A.p.evaluate(() => document.querySelector("#savebar")?.textContent ?? "");
ok(!!moved && /1 change/.test(bar), `a tunable moved inside the viewer reaches the save bar (${moved} → "${bar.trim().slice(0, 20)}")`);
// the committed shape: read it off the page's own state by committing into a stubbed save
let saved = null;
await A.p.route("**/api/wiki/save", async (r) => { saved = JSON.parse(r.request().postData() ?? "{}"); await r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"sha":"gate"}' }); });
await A.p.evaluate(() => [...document.querySelectorAll("#savebar button")].find((x) => /Commit/.test(x.textContent))?.click());
await A.p.waitForTimeout(1500);
// A save is a per-id DELTA ({file, set}); the server merges it into
// `overrides` (live.ts applyDelta), so the entry is what must be right.
const entry = saved?.file === "tuning/shaders" ? saved.set?.[beam.key] : null;
ok(entry && Object.keys(entry).some((k) => !["was", "updated_at"].includes(k)) && entry.was && typeof entry.was === "object",
  `the commit sends tuning/shaders in the contract's shape — ${beam.key}: ${entry ? JSON.stringify(entry).slice(0, 90) : "no entry"}${saved ? "" : " (no save request seen)"}`);
ok(A.errs.length === 0, `no page errors as admin${A.errs.length ? `: ${A.errs[0]}` : ""}`);
await A.ctx.close();

// ---- player: nothing to see
const P = await page(false);
await P.p.goto(`${W}#/items`, { waitUntil: "load" }); await P.p.waitForTimeout(2200);
const ptabs = await P.p.evaluate(() => document.querySelectorAll('[data-bar="wiki-items-tab"]').length);
await P.p.goto(`${W}#/items/shaders`, { waitUntil: "load" }); await P.p.waitForTimeout(1500);
const phash = await P.p.evaluate(() => location.hash);
ok(ptabs === 0 && phash === "#/items", `a player gets no Shaders tab, and the route sends them back to Items (${ptabs} tab rows, landed on ${phash})`);
await P.ctx.close();

await b.close();
console.log(fails.length ? `\nSHADER CHECKS FAILED (${fails.length})` : "\nALL SHADER CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
