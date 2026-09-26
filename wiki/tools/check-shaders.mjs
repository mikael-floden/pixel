// The Shaders section under Items (maintainer 2026-09-26: "We need a new wiki
// page under Items called Shaders that will allow me to review the work from
// the new effect/shader-agent ... it's important that you render the effects
// the same way they would render in the game!" — then, with the shader agent's
// own page in hand: "I kinda like the timeline ... improve the Shader page ...
// align with the shader agent's work").
//
// The page embeds the shader agent's stage (shaders/docs/wiki.md) and draws
// every control around it itself. What must hold, derived from the catalog the
// page reads rather than typed here:
//   - admin: Items | Shaders tabs, one card per catalog effect, family chips;
//   - player: no Shaders tab at all (nothing is bound to a skill yet);
//   - the effect page boots the viewer from /assets/shaders/viewer/ in embed
//     mode, shows the STAGE ONLY (the viewer's own controls are not rendered,
//     the iframe is the stage's height), and the EFFECT DRAWS — measured in
//     composited screenshots of its canvas, since a WebGL canvas reads back
//     blank between frames;
//   - the wiki's timeline is built from the stage's own shaders:timeline: a
//     mark per moment, a slot per sound with the game's event name, the
//     caster's clip frames with ONE key frame, the channel bed, a moving head;
//   - the wiki's controls drive the stage (shaders:set) and the stage's echo
//     is what they show; a re-render's reload comes back as he left it;
//   - a tunable moved on the WIKI's slider reaches the stage and the save bar,
//     committed in the contract's shape; Reset sends the deletion;
//   - a verdict is stamped with the catalog version, and a verdict on an older
//     version reads as "judge again";
//   - a sound queued for a slot shows on it and PLAYS when the moment fires;
//   - the serving half: "shaders" is in both ASSET_DOMAINS lists.
// Run: node wiki/tools/serve-assets.mjs 8902 & node wiki/tools/check-shaders.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const ROOT = new URL("../../", import.meta.url).pathname;
const CAT = JSON.parse(readFileSync(join(ROOT, "shaders/shaders.json"), "utf8"));
const DATA = JSON.parse(readFileSync(join(ROOT, "wiki/site/data.json"), "utf8"));
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll a page-side probe until it is truthy (or time runs out); returns its last value. */
async function until(p, fn, arg, ms = 8000, step = 150) {
  const t0 = Date.now(); let v = null;
  while (Date.now() - t0 < ms) { v = await p.evaluate(fn, arg).catch(() => null); if (v) return v; await sleep(step); }
  return v;
}
const frameOf = (p) => p.frames().find((f) => /\/assets\/shaders\/viewer\/index\.html/.test(f.url()));
/** The stage frame once it has booted (its window.__nfx exists). */
async function stageFrame(p, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const fr = frameOf(p);
    if (fr && await fr.evaluate(() => !!window.__nfx).catch(() => false)) return fr;
    await sleep(200);
  }
  return null;
}

// ---- the serving half (games2 files the shader agent asked wiki for)
{
  const srv = readFileSync(join(ROOT, "games2/server/src/index.ts"), "utf8");
  const vite = readFileSync(join(ROOT, "games2/client/vite.config.ts"), "utf8");
  const inList = (src, re) => { const m = re.exec(src); return !!m && /"shaders"/.test(m[1]); };
  ok(inList(srv, /const ASSET_DOMAINS = \[([\s\S]*?)\]/) && inList(vite, /const ASSET_DOMAINS = new Set\(\[([\s\S]*?)\]\)/),
    "the game serves /assets/shaders — \"shaders\" is in ASSET_DOMAINS in the server and the dev server");
}

const beam = CAT.effects.find((e) => e.kind === "beam" && e.sounds.some((s) => s.loop)) ?? CAT.effects[0];
const bolt = CAT.effects.find((e) => e.volley && e.stage?.caster === "hero" && e.id !== beam.id) ?? beam;
const composerSet = Object.values(DATA.sfx?.composerSets ?? {}).find((cs) => cs.takes?.[0]?.file);
const boundTake = composerSet?.takes[0];
const boltRelease = bolt.sounds.find((s) => s.event === "release" && !s.loop) ?? bolt.sounds[0];
const STALE_FEEDBACK = { format: "pixel-wiki-feedback@1", domain: "shaders", updated_at: "2026-09-26T00:00:00Z",
  entries: { [beam.key]: { status: "approved", rating: 3, version: "0000000000000000", updated_at: "2026-09-26T00:00:00Z" } } };
const REQUESTS = { format: "pixel-wiki-sfx-requests@1", updated_at: "2026-09-26T00:00:00Z", requests: boundTake ? {
  [`${boltRelease.sound_event}/gate`]: { event: boltRelease.sound_event, scope: { domain: "shaders", id: bolt.id }, slot: boltRelease.slot, loop: false,
    sound: `composer/${boundTake.name.replace(/__take\d+\.\w+$/, "")}`, take: boundTake.file, pitch: 1, volume_db: 0, max_random_pitch_semis: 0, requested_at: "2026-09-26T00:00:00Z" } } : {} };

async function page(admin, { stubs = false } = {}) {
  const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ admin }) }));
  if (stubs) {
    // The wiki reads its live files from the game's /api/live/state (serve-assets
    // answers it from live/**): the stale verdict and the queued sound ride in there.
    await p.route("**/api/live/state", async (r) => {
      const res = await r.fetch(); const j = await res.json().catch(() => ({}));
      (j.feedback ??= {}).shaders = STALE_FEEDBACK; (j.tuning ??= {}).sfx_requests = REQUESTS;
      await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
    });
  }
  await p.addInitScript((a) => {
    if (a) localStorage.setItem("wiki-admin-token", "gate"); localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
    for (const k of ["wiki-shader-family", "wiki-shader-ground", "wiki-shader-stage", "wiki-shader-sfx", "nfx-viewer-v2"]) localStorage.removeItem(k);
    window.addEventListener("message", (e) => { if (e.data?.type === "shaders:ground") (window.__groundPlans ??= []).push(e.data); });
  }, admin);
  return { ctx, p, errs };
}

// ---- admin: tabs + list
const A = await page(true, { stubs: true });
const saves = [];
await A.p.route("**/api/wiki/save", async (r) => { saves.push(JSON.parse(r.request().postData() ?? "{}")); await r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"sha":"gate"}' }); });
await A.p.goto(`${W}#/items`, { waitUntil: "load" }); await A.p.waitForTimeout(2500);
const tabs = await A.p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-items-tab"] button')].map((x) => x.textContent.trim()));
ok(tabs.length === 2 && tabs[1] === `Shaders ${CAT.effects.length}`, `the admin gets Items | Shaders, counted from the catalog (${tabs.join(" | ")})`);
await A.p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-items-tab"] button')].find((x) => /^Shaders/.test(x.textContent))?.click());
await A.p.waitForTimeout(1600);
const list = await A.p.evaluate(() => ({
  hash: location.hash, cards: [...document.querySelectorAll(".shader-card")].map((a) => decodeURIComponent(a.getAttribute("href").split("/").pop())),
  chips: [...document.querySelectorAll('[data-bar="wiki-shader-family"] button')].map((x) => x.textContent.trim()),
  marks: [...document.querySelectorAll(".shader-card")].map((a) => [decodeURIComponent(a.getAttribute("href").split("/").pop()), a.querySelector(".pill")?.textContent.trim() ?? ""]),
}));
ok(list.hash === "#/items/shaders" && list.cards.length === CAT.effects.length && CAT.effects.every((e) => list.cards.includes(e.id)),
  `one card per catalog effect (${list.cards.length} of ${CAT.effects.length})`);
const fams = [...new Set(CAT.effects.map((e) => e.family))];
ok(list.chips.length === fams.length + 1, `a family chip per family plus "all" (${list.chips.length} chips, ${fams.length} families)`);
const staleMark = list.marks.find(([id]) => id === beam.id)?.[1] ?? "";
ok(/changed/.test(staleMark) && list.marks.filter(([, m]) => m).length === 1,
  `a verdict stamped with an older catalog version reads as "judge again" on its card, and nowhere else (${beam.id}: "${staleMark}")`);
const f0 = fams[0];
await A.p.evaluate((l) => [...document.querySelectorAll('[data-bar="wiki-shader-family"] button')].find((x) => x.textContent.trim().startsWith(l))?.click(), CAT.families?.[f0]?.label ?? f0);
await A.p.waitForTimeout(900);
const nf = await A.p.evaluate(() => document.querySelectorAll(".shader-card").length);
ok(nf === CAT.effects.filter((e) => e.family === f0).length, `a family chip keeps exactly its effects (${f0}: ${nf})`);
await A.p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-shader-family"] button')].find((x) => /^all /.test(x.textContent.trim()))?.click());

// ---- admin: the effect page — the stage only, drawing
await A.p.goto(`${W}#/items/shaders/${encodeURIComponent(beam.id)}`, { waitUntil: "load" });
let fr = await stageFrame(A.p);
ok(!!fr && /embed=1/.test(fr.url()) && fr.url().includes(`id=${encodeURIComponent(beam.id)}`),
  `the effect page embeds the viewer from /assets/shaders/viewer/ in embed mode (${fr?.url().split("/assets/")[1]?.slice(0, 70) ?? "no frame"})`);
let peak = 0;
if (fr) {
  await A.p.waitForTimeout(1500);
  const cv = await fr.$("canvas");
  for (let i = 0; i < 12 && cv; i++) {
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
// the embed is the stage only, and the iframe is the stage's height
{
  const inner = fr ? await fr.evaluate(() => {
    const shown = (sel) => [...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0).map((el) => el.className || el.id);
    return { chrome: shown(".bar, .timeline, .transport, .stagebar, .level, .notes, .side-col"), canvasH: document.getElementById("stage")?.getBoundingClientRect().height ?? 0,
      wrapH: document.getElementById("stage-wrap")?.getBoundingClientRect().height ?? 0, scrollH: document.documentElement.scrollHeight, innerH: window.innerHeight };
  }) : null;
  const outer = await A.p.evaluate(() => ({ frameH: document.querySelector(".shader-frame")?.getBoundingClientRect().height ?? 0,
    replay: document.querySelectorAll(".shader-replay").length, level: document.querySelectorAll("#shader-level").length, tod: document.querySelectorAll("#shader-tod").length }));
  ok(inner && inner.chrome.length === 0 && inner.canvasH > 100, `the embed shows the stage only — none of the viewer's own controls render inside the wiki (${inner ? `${inner.chrome.length} shown, canvas ${Math.round(inner.canvasH)}px` : "no frame"})`);
  ok(inner && Math.abs(outer.frameH - inner.wrapH) <= 4 && inner.scrollH <= inner.innerH + 2,
    `the iframe is the stage's height, so the page scrolls as one (frame ${Math.round(outer.frameH)}px, stage ${Math.round(inner?.wrapH ?? 0)}px, inner scroll ${inner?.scrollH}/${inner?.innerH})`);
  ok(outer.replay === 1 && outer.level === 1 && outer.tod === 1, `the wiki draws the transport, the level and the time of day once (${outer.replay}/${outer.level}/${outer.tod})`);
}
// the stale verdict on the page
{
  const head = await A.p.evaluate(() => ({ pill: document.querySelector(".shader-head .pill")?.textContent.trim() ?? "",
    approve: [...document.querySelectorAll(".verdict button")].map((x) => x.textContent.trim()).find((t) => /approve/.test(t)) ?? "" }));
  ok(/changed since/.test(head.pill) && head.approve === "✓ approve", `on the page, that older verdict is named and paints as undecided ("${head.pill}" · "${head.approve}")`);
}

// ---- the timeline, from the stage's own schedule
const tl = await until(A.p, () => (window.__nfxWiki?.tl()?.id ? window.__nfxWiki.tl() : null), null, 10000);
{
  const drawn = await A.p.evaluate(() => ({
    marks: document.querySelectorAll(".shader-timeline .tl-mark").length,
    slots: [...document.querySelectorAll(".shader-timeline .tl-slot code")].map((c) => c.textContent),
    frames: document.querySelectorAll(".shader-timeline .tl-frames .fr").length, keys: document.querySelectorAll(".shader-timeline .tl-frames .fr.key").length,
    bed: !!document.querySelector(".shader-timeline .tl-bed"), scale: document.querySelector(".shader-timeline .tl-scale")?.textContent ?? "",
  }));
  const moments = (tl?.events ?? []).filter((x) => x.event !== "end").length;
  ok(!!tl && tl.id === beam.id && drawn.marks === moments && moments > 0, `the timeline has a mark per moment of the stage's schedule (${drawn.marks} marks for ${moments} moments of ${tl?.id ?? "no schedule"})`);
  ok(JSON.stringify(drawn.slots) === JSON.stringify(beam.sounds.map((s) => s.sound_event)), `and a slot per sound, carrying the game's event name (${drawn.slots.join(", ")})`);
  const ca = CAT.cast_anims?.[beam.stage?.anim];
  ok(!!ca && drawn.frames === (ca.frames || 4) && drawn.keys === 1, `the caster's clip frames are drawn with ONE key frame lit (${drawn.frames} frames of ${beam.stage?.anim}, ${drawn.keys} key)`);
  ok(drawn.bed, `a sustained effect shows its channel bed from the release to the stop`);
  const heads = [];
  for (let i = 0; i < 6; i++) { heads.push(await A.p.evaluate(() => parseFloat(document.querySelector(".shader-timeline .tl-head")?.style.left ?? "0"))); await sleep(160); }
  ok(new Set(heads).size >= 3, `the playhead moves (${heads.map((x) => x.toFixed(1)).join(" → ")}%)`);
  const evs = await until(A.p, () => (window.__nfxWiki?.events.some((x) => x.event === "release") ? window.__nfxWiki.events.map((x) => x.event) : null), null, 8000);
  ok(Array.isArray(evs) && evs.includes("release"), `the stage's moments reach the page as they fire (${[...new Set(evs ?? [])].join(", ") || "none"})`);
}

// ---- the wiki's controls drive the stage, and the stage's echo is what they show
async function slide(p, sel, value) {
  await p.evaluate(([s, v]) => { const el = document.querySelector(s); el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }, [sel, value]);
}
await slide(A.p, "#shader-level", 8); await A.p.waitForTimeout(900);
{
  const st = await fr.evaluate(() => window.__nfx.state.level);
  const shown = await A.p.evaluate(() => ({ out: document.querySelector('output[for="shader-level"]')?.textContent, kept: window.__nfxWiki.stage().level }));
  ok(st === 8 && shown.out === "8" && shown.kept === 8, `the level slider drives the stage and the page keeps the echo (stage ${st}, shown ${shown.out}, kept ${shown.kept})`);
}
await slide(A.p, "#shader-tod", 2.5); await A.p.waitForTimeout(600);
await A.p.evaluate(() => { const t = [...document.querySelectorAll(".shader-time .shader-tog input")][0]; t.click(); });
await A.p.waitForTimeout(600);
{
  const st = await fr.evaluate(() => ({ tod: window.__nfx.state.tod, torch: window.__nfx.state.torch }));
  const out = await A.p.evaluate(() => document.querySelector('output[for="shader-tod"]')?.textContent);
  ok(st.tod === 2.5 && out === "Day" && st.torch === false, `time of day and the torch drive the stage — the game's clock, its phase named (tod ${st.tod} "${out}", torch ${st.torch})`);
}
await A.p.evaluate(() => document.querySelector('.shader-speed button[data-v="0.5"]')?.click()); await A.p.waitForTimeout(500);
{
  const st = await fr.evaluate(() => window.__nfx.state.speed);
  const on = await A.p.evaluate(() => document.querySelector(".shader-speed button.on")?.dataset.v);
  ok(st === 0.5 && on === "0.5", `the speed control drives the stage (stage ×${st}, chip ${on})`);
}
// Replay recasts: a new schedule arrives
{
  const before = tl ? await A.p.evaluate(() => window.__nfxWiki.tl()?.at ?? 0) : 0;
  await A.p.evaluate(() => document.querySelector(".shader-replay")?.click());
  const after = await until(A.p, (b0) => ((window.__nfxWiki.tl()?.at ?? 0) > b0 ? window.__nfxWiki.tl().at : null), before, 6000);
  ok(!!after, `Replay casts it again — a fresh schedule arrives (${after ? `${Math.round(after - before)} ms later` : "none"})`);
}

// ---- the ground: the base tile set with the HIGHEST weight, members drawn by
// their own weights (maintainer 2026-09-26). The plan the viewer receives is
// checked against the committed live/tuning/base_tile_sets.json.
{
  const SETS = JSON.parse(readFileSync(join(ROOT, "live/tuning/base_tile_sets.json"), "utf8")).grounds ?? {};
  const stepper = await A.p.evaluate(() => document.querySelector(".shader-ground")?.textContent.replace(/\s+/g, " ").trim() ?? "");
  ok(/^Ground/.test(stepper), `a ground stepper sits under the stage (${stepper})`);
  const seen = [];
  for (let i = 0; i < 3; i++) { await A.p.click('.shader-ground button[aria-label="Next ground"]'); await A.p.waitForTimeout(250); }
  seen.push(...await fr.evaluate(() => window.__groundPlans ?? []));
  ok(seen.length >= 4, `the viewer receives a floor plan on boot and on every ‹ › (${seen.length} plans: ${seen.map((x) => x.ground).join(", ")})`);
  const bad = seen.filter((plan) => {
    const maxW = Math.max(...(SETS[plan.ground]?.sets ?? []).map((s) => Number(s.weight) || 0));
    const shares = plan.tiles.map((_, i) => plan.grid.cells.filter((c) => c === i).length / plan.grid.cells.length);
    const drift = Math.max(...plan.tiles.map((x, i) => Math.abs(shares[i] - x.share)));
    return plan.set.weight !== maxW || drift > 0.08 || plan.grid.cells.length !== plan.grid.cols * plan.grid.rows;
  });
  ok(seen.length && !bad.length, `each plan uses the ground's highest-weight set and draws its tiles by their weights (off: ${bad.map((x) => x.ground).join(", ") || "none"})`);
}

// ---- tuning: the WIKI's slider, applied by the stage, saved in the contract's shape
const tuneKey = Object.keys(beam.tune ?? {}).find((k) => beam.tune[k].type === "range");
await slide(A.p, `.shader-tune .row[data-tune="${tuneKey}"] input`, beam.tune[tuneKey].max); await A.p.waitForTimeout(1200);
{
  const bar = await A.p.evaluate(() => document.querySelector("#savebar")?.textContent ?? "");
  const applied = await fr.evaluate((k) => window.__nfx.state.tune[k], beam.id);
  const changed = await A.p.evaluate((k) => !!document.querySelector(`.shader-tune .row[data-tune="${k}"].changed`), tuneKey);
  ok(/1 change/.test(bar) && applied?.[tuneKey] === beam.tune[tuneKey].max && changed,
    `a tunable moved on the wiki's slider reaches the stage and the save bar (${tuneKey}=${applied?.[tuneKey]} in the stage; "${bar.trim().slice(0, 20)}"; row marked)`);
}
// approve (re-stamps with this version), then commit both
const bootStamp = fr ? await fr.evaluate(() => (window.__gateBoot = Date.now())) : null;
await A.p.evaluate(() => [...document.querySelectorAll(".verdict button")].find((x) => /approve/.test(x.textContent))?.click());
await A.p.waitForTimeout(300);
await A.p.evaluate(() => [...document.querySelectorAll("#savebar button")].find((x) => /Commit/.test(x.textContent))?.click());
await A.p.waitForTimeout(1500);
{
  const tune = saves.find((s) => s.file === "tuning/shaders")?.set?.[beam.key];
  ok(tune && tune[tuneKey] === beam.tune[tuneKey].max && tune.was && tune.was[tuneKey] === beam.tune[tuneKey].def,
    `the commit sends tuning/shaders in the contract's shape — ${beam.key}: ${tune ? JSON.stringify(tune).slice(0, 90) : "no entry"}`);
  const fbk = saves.find((s) => s.file === "feedback/shaders")?.set?.[beam.key];
  ok(fbk && fbk.status === "approved" && fbk.version === beam.version, `the verdict is stamped with the catalog version (${fbk ? `${fbk.status}, v ${fbk.version}` : "no entry"} vs ${beam.version})`);
}
// the commit re-renders the page: the running stage is KEPT (moved, not re-inserted), as he left it
fr = await stageFrame(A.p);
{
  const boot = fr ? await fr.evaluate(() => window.__gateBoot ?? null) : null;
  const st = fr ? await until(fr, () => (window.__nfx?.state?.level === 8 ? window.__nfx.state : null), null, 6000) : null;
  ok(boot === bootStamp && st && st.tod === 2.5 && st.torch === false && st.speed === 0.5,
    `a re-render keeps the running stage — no reload, every setting as he left it (${boot === bootStamp ? "same boot" : `rebooted: ${boot} vs ${bootStamp}`}; level ${st?.level}, tod ${st?.tod}, torch ${st?.torch}, ×${st?.speed})`);
  const applied = fr ? await until(fr, (k) => (window.__nfx.state.tune[k] ? window.__nfx.state.tune[k] : null), beam.id, 5000) : null;
  ok(applied?.[tuneKey] === beam.tune[tuneKey].max, `and the committed tuning is what its sliders start from (${tuneKey}=${applied?.[tuneKey]})`);
}
// the fallback path: a stage that DOES reload (a browser without moveBefore, a refresh) comes back as he left it
if (fr) {
  const before = new URL(fr.url()).searchParams.get("level");
  await fr.evaluate(() => location.reload()).catch(() => {});
  await sleep(500);
  fr = await stageFrame(A.p);
  const st = fr ? await until(fr, () => (window.__nfx?.state?.level === 8 && window.__nfx.state.tod === 2.5 ? window.__nfx.state : null), null, 8000) : null;
  ok(st && st.torch === false && st.speed === 0.5 && st.id === beam.id,
    `a reload comes back as he left it — the src said level ${before}, shaders:ready re-asserted the kept state (level ${st?.level}, tod ${st?.tod}, torch ${st?.torch}, ×${st?.speed}, ${st?.id})`);
}
// Reset: back to the shader agent's defaults, sent as a deletion
await A.p.evaluate(() => document.querySelector(".shader-tune-reset")?.click()); await A.p.waitForTimeout(1000);
{
  const applied = fr ? await fr.evaluate((k) => window.__nfx.state.tune[k] ?? null, beam.id) : "?";
  const bar = await A.p.evaluate(() => document.querySelector("#savebar")?.textContent ?? "");
  const n0 = saves.length;
  await A.p.evaluate(() => [...document.querySelectorAll("#savebar button")].find((x) => /Commit/.test(x.textContent))?.click());
  await A.p.waitForTimeout(1200);
  const del = saves.slice(n0).find((s) => s.file === "tuning/shaders");
  ok(!applied && /1 change/.test(bar) && del && del.set && beam.key in del.set && del.set[beam.key] === null,
    `Reset clears the stage's tuning and the commit sends the entry's deletion (stage ${JSON.stringify(applied)}, sent ${del ? JSON.stringify(del.set) : "nothing"})`);
}

// ---- another effect via the page's own navigation: the frame is KEPT (no reload), the volley, the bodies, the sounds
fr = await stageFrame(A.p);
const navBoot = fr ? await fr.evaluate(() => (window.__gateBoot = Date.now())) : null;
await A.p.evaluate((href) => { location.hash = href; }, `#/items/shaders/${encodeURIComponent(bolt.id)}`);
await A.p.waitForTimeout(1200);
fr = await stageFrame(A.p);
{
  const st = fr ? await until(fr, (id) => (window.__nfx?.state?.id === id ? window.__nfx.state : null), bolt.id, 8000) : null;
  const boot = fr ? await fr.evaluate(() => window.__gateBoot ?? null) : null;
  ok(st && boot === navBoot, `‹ › opens the next effect INSIDE the running stage — no reload (${st ? st.id : "not shown"}, ${boot === navBoot ? "same boot" : "rebooted"})`);
  const rows = await A.p.evaluate(() => ({ volley: !!document.querySelector(".shader-volley"), hero: document.querySelectorAll(".shader-hero .seg button").length,
    monster: document.querySelectorAll(".shader-monster select option").length, formHidden: document.querySelector(".shader-formation")?.hidden }));
  ok(rows.volley && rows.formHidden === true, `a volley effect gets the count and formation controls, the formation hidden while the count is 1`);
  ok(rows.hero >= 2, `a hero-cast effect gets the hero choice (${rows.hero} heroes)`);
  ok(rows.monster >= 2, `and the monster choice from the viewer's own body list (${rows.monster} monsters)`);
  await A.p.evaluate(() => document.querySelector('.shader-count button[data-v="3"]')?.click());
  const tl3 = fr ? await until(A.p, (id) => { const t = window.__nfxWiki.tl(); return t && t.id === id && t.events.filter((x) => x.event === "release").length === 3 ? t : null; }, bolt.id, 8000) : null;
  const marks = await A.p.evaluate(() => ({ rel: document.querySelectorAll('.shader-timeline .tl-mark[data-event="release"]').length, formShown: document.querySelector(".shader-formation")?.hidden === false,
    about: document.querySelector(".shader-about")?.textContent.trim() ?? "" }));
  ok(!!tl3 && marks.rel === 3 && marks.formShown && marks.about.length > 10, `×3 casts a volley — three releases on the timeline, the formation and its meaning shown (${marks.rel} release marks; "${marks.about.slice(0, 40)}…")`);
  const otherHero = await A.p.evaluate(() => { const b = [...document.querySelectorAll(".shader-hero .seg button")].find((x) => !x.classList.contains("on")); b?.click(); return b?.dataset.v ?? null; });
  await A.p.waitForTimeout(900);
  const hero = fr ? await fr.evaluate(() => window.__nfx.state.hero) : null;
  ok(otherHero && hero === otherHero, `the hero choice drives the stage (${hero})`);
  const pick = await A.p.evaluate(() => { const s = document.querySelector(".shader-monster select"); const o = [...s.options].find((x) => x.value !== s.value); if (!o) return null; s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return o.value; });
  await A.p.waitForTimeout(900);
  const mon = fr ? await fr.evaluate(() => window.__nfx.state.monster) : null;
  ok(pick && mon === pick, `the monster choice drives the stage (${mon})`);
}
// the sound queued for a slot: shown on it, and PLAYED when the moment fires
{
  const slot = await A.p.evaluate((sl) => { const li = document.querySelector(`.shader-timeline .tl-slot[data-slot="${sl}"]`); return li ? { req: li.querySelector(".tl-bind .pill")?.textContent.trim() ?? "", take: li.querySelector(".tl-bind .take-name")?.textContent ?? "", assign: !!li.querySelector(".sfx-add-open") } : null; }, boltRelease.slot);
  ok(slot && slot.req === "requested" && slot.take.includes(boundTake?.name.replace(/\.\w+$/, "") ?? "?") && slot.assign,
    `a sound queued for a slot shows on it, with the picker to bind another (${slot ? `${slot.req} · ${slot.take}` : "no slot row"})`);
  await A.p.evaluate(() => document.querySelector(".shader-replay")?.click());
  const plays = await until(A.p, (file) => (sfxPlays.some((x) => x.file === file) ? sfxPlays.filter((x) => x.file === file).length : null), boundTake?.file ?? "-", 8000);
  ok(plays >= 1, `and it PLAYS when the stage fires that moment (${plays ?? 0} plays of ${boundTake?.name ?? "no take"})`);
  const assignAll = await A.p.evaluate(() => document.querySelectorAll(".shader-timeline .tl-slot .sfx-add-open").length);
  ok(assignAll === bolt.sounds.length, `every slot offers the picker (${assignAll} of ${bolt.sounds.length})`);
}
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
