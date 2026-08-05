// The Sound Effects page: event-centric, admin-gated, and the mirrored engine
// must compute EXACTLY what the game's one-shot player computes.
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
import { readFileSync } from "node:fs";
const D = JSON.parse(readFileSync("/home/user/pixel/wiki/site/data.json", "utf8"));
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
const p = await (await b.newContext({ viewport: { width: 426, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };

// ---------- data sanity
const sfx = D.sfx;
ok(sfx.events.length >= 40, `event table built (${sfx.events.length} events)`);
const grass = sfx.events.find((e) => e.id === "footsteps.grass");
ok(grass.sounds.length === 2, "grass footstep = grass set + dirt layered under");
const jump = sfx.events.find((e) => e.id === "player.jump");
ok(jump.sounds.length === 2 && jump.sounds.every((l) => l.voiceRate === 2), "jump = both characters' voices at ×2");

// ---------- player view
await p.goto(W + "#/sounds", { waitUntil: "load" });
await p.waitForTimeout(1800);
const player = await p.evaluate(() => ({
  cards: document.querySelectorAll(".sfx-event").length,
  silent: [...document.querySelectorAll(".sfx-event .pill.warn")].filter((x) => /no sound yet/.test(x.textContent)).length,
  lib: !!document.querySelector(".sfx-lib"),
  stars: document.querySelectorAll(".sfx-event .stars").length,
  addForms: document.querySelectorAll(".sfx-add").length,
  notFired: [...document.querySelectorAll(".pill")].filter((x) => /not fired/.test(x.textContent)).length,
  groups: [...document.querySelectorAll("h2")].map((x) => x.textContent.replace(/\d+$/, "").trim()),
  aGrass: [...document.querySelectorAll(".sfx-event .panel-title")].some((x) => /Footsteps · Grass/.test(x.textContent)),
}));
console.log("player:", JSON.stringify(player));
ok(player.cards > 0 && player.aGrass, `players see the events (${player.cards})`);
ok(player.silent === 0 && !player.lib && player.stars === 0 && player.addForms === 0 && player.notFired === 0,
  "players see NO silent events, no library, no stars, no add forms, no pipeline pills");
ok(player.groups.includes("Movement") && player.groups.includes("Interface"), "grouped by kind of moment");

// ---------- the engine mirror computes the game's numbers
const grassPlay = await p.evaluate(async () => {
  window.__sfxPlays.length = 0;
  const card = [...document.querySelectorAll(".sfx-event")].find((c) => /Footsteps · Grass/.test(c.querySelector(".panel-title").textContent));
  card.querySelector(".play-event").click();
  await new Promise((r) => setTimeout(r, 900));
  return window.__sfxPlays.slice();
});
console.log("grass event played:", JSON.stringify(grassPlay));
const eng = sfx.engine;
const gLayer = grass.sounds[0], dLayer = grass.sounds[1];
const expG = +(gLayer.mixGainDb + gLayer.trimDb + eng.busDb[gLayer.bus]).toFixed(2);
const expD = +(dLayer.mixGainDb + dLayer.trimDb + eng.busDb[dLayer.bus]).toFixed(2);
ok(grassPlay.length === 2, `the event plays BOTH layers at once (${grassPlay.length})`);
const gp = grassPlay.find((x) => /composer\/foley\/grass/.test(x.file));
const dp = grassPlay.find((x) => !/composer\/foley\/grass/.test(x.file));
ok(gp && gp.rate === 0.95 && gp.lowpassHz === 3600 && gp.db === expG,
  `grass layer: rate 0.95, lowpass 3600, ${expG} dB (got ${gp && `${gp.rate}/${gp.lowpassHz}/${gp.db}`})`);
ok(dp && Math.abs(dp.db - expD) <= Math.abs(dLayer.gainJitterDb?.[1] ?? 0) + 0.01,
  `dirt-under layer lands at ${expD} dB ± gentled jitter (got ${dp?.db})`);

const jumpPlay = await p.evaluate(async () => {
  window.__sfxPlays.length = 0;
  const card = [...document.querySelectorAll(".sfx-event")].find((c) => /^Jump/.test(c.querySelector(".panel-title").textContent.replace(/^▶?\s*/, "")));
  card.querySelector(".play-event").click();
  await new Promise((r) => setTimeout(r, 900));
  return window.__sfxPlays.slice();
});
ok(jumpPlay.length === 2 && jumpPlay.every((x) => x.rate === 2), `jump voices play at exactly ×2 (${jumpPlay.map((x) => x.rate)})`);
ok(jumpPlay.every((x) => x.db === +(eng.voiceGainDb + eng.busDb.sfx).toFixed(2)), `voice level = ${eng.voiceGainDb} + sfx bus (${jumpPlay.map((x) => x.db)})`);

// ---------- admin: silent events, library, sliders, requests
if (!process.env.WIKI_ADMIN_PASSWORD) { console.log("(WIKI_ADMIN_PASSWORD unset — admin half skipped)"); await b.close(); console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL SFX CHECKS PASSED (player half)"); process.exit(fails.length ? 1 : 0); }
await p.evaluate(async (pw) => {
  const r = await fetch("/api/wiki/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: pw }) });
  localStorage.setItem("wiki-admin-token", (await r.json()).token);
}, process.env.WIKI_ADMIN_PASSWORD);
await p.reload({ waitUntil: "load" });
await p.waitForTimeout(2200);
const admin = await p.evaluate(() => ({
  lib: !!document.querySelector(".sfx-lib"),
  libRows: document.querySelectorAll(".sfx-lib-row").length,
  unused: [...document.querySelectorAll(".sfx-lib-head .pill.warn")].filter((x) => /unused/.test(x.textContent)).length,
  voiceRows: [...document.querySelectorAll(".sfx-lib-head")].filter((x) => /voice · raw ×2/.test(x.textContent)).length,
  addForms: document.querySelectorAll(".sfx-add").length,
  notFired: [...document.querySelectorAll(".pill")].filter((x) => /not fired/.test(x.textContent)).length,
  stars: document.querySelectorAll(".sfx-take .stars").length > 0,
}));
console.log("admin:", JSON.stringify(admin));
ok(admin.lib && admin.libRows >= 55, `the raw library lists everything (${admin.libRows} rows)`);
ok(admin.unused > 0, `unused takes are called out (${admin.unused})`);
ok(admin.voiceRows >= 2, `voice sets marked, raw at ×2 (${admin.voiceRows})`);
ok(admin.addForms > 0 && admin.stars, "add-a-sound forms and per-take stars for the Game Master");
ok(admin.notFired > 0, `wired-but-never-fired events are flagged (${admin.notFired})`);

// voice slider defaults to 2× and the audition uses the sliders
const audition = await p.evaluate(async () => {
  window.__sfxPlays.length = 0;
  const row = [...document.querySelectorAll(".sfx-lib-row")].find((x) => /voice · raw ×2/.test(x.textContent));
  const pitch = row.querySelector('input[title="pitch"]');
  const v0 = pitch.value;
  row.querySelector(".sfx-take .play-btn").click();
  await new Promise((r) => setTimeout(r, 700));
  const raw = window.__sfxPlays.slice();
  window.__sfxPlays.length = 0;
  pitch.value = "1.5"; pitch.dispatchEvent(new Event("input"));
  const label = row.querySelector(".sfx-val").textContent;
  row.querySelector(".sfx-take .play-btn").click();
  await new Promise((r) => setTimeout(r, 700));
  return { v0, raw, label, slid: window.__sfxPlays.slice() };
});
ok(audition.v0 === "2" && audition.raw[0]?.rate === 2, `a voice's raw play is ×2 by default (slider ${audition.v0}, played ${audition.raw[0]?.rate})`);
ok(audition.slid[0]?.rate === 1.5 && /1\.5/.test(audition.label), `the pitch slider drives the audition and shows its value (${audition.slid[0]?.rate}, "${audition.label}")`);

// request flow: queue → pending row → savebar → withdraw
const req = await p.evaluate(async () => {
  const card = [...document.querySelectorAll(".sfx-event")].find((c) => /no sound yet|not fired/.test(c.textContent)) ?? document.querySelector(".sfx-event");
  const form = card.querySelector(".sfx-add");
  form.querySelector(".sfx-pick").value = form.querySelector(".sfx-pick option").value;
  form.querySelector('input[title="pitch (playbackRate)"]').value = "1.2";
  form.querySelector('input[title="max random pitch, semitones"]').value = "0.5";
  [...form.querySelectorAll("button")].find((x) => /Request/.test(x.textContent)).click();
  await new Promise((r) => setTimeout(r, 400));
  const after = document.querySelector(".sfx-req");
  return {
    pending: after?.textContent ?? null,
    savebar: !document.querySelector("#savebar").classList.contains("hidden"),
    stored: Object.values(JSON.parse(JSON.stringify((window.state ?? {}).tuning?.sfx_requests?.requests ?? {}))),
  };
});
console.log("request:", JSON.stringify(req).slice(0, 300));
ok(!!req.pending && /pitch ×1\.2/.test(req.pending) && /±0\.5 st/.test(req.pending), "the request renders with its pitch/vol/random-pitch");
ok(req.savebar, "the savebar offers to send it (same save path as all live edits)");
const withdrew = await p.evaluate(async () => {
  document.querySelector(".sfx-req .x-btn").click();
  await new Promise((r) => setTimeout(r, 300));
  return !document.querySelector(".sfx-req");
});
ok(withdrew, "a queued request can be withdrawn");

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL SFX CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
