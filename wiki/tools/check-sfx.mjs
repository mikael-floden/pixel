// The Sound Effects page: event-centric, admin-gated, and the mirrored engine
// must compute EXACTLY what the game's one-shot player computes.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const D = JSON.parse(readFileSync("/home/user/pixel/wiki/site/data.json", "utf8"));
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
const p = await (await b.newContext({ viewport: { width: 426, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };

// ---------- data sanity
const sfx = D.sfx;
// Floor, not a target: the composer deleted 22 bindings.json rows for events
// the game never fires (2026-08-06), so the honest table is much smaller than
// it was. What matters is that it is populated, not that it is long.
ok(sfx.events.length >= 25, `event table built (${sfx.events.length} events)`);
const grass = sfx.events.find((e) => e.id === "footsteps.grass");
ok(grass.sounds.length === 2, "grass footstep = grass set + dirt layered under");
const jumpBoy = sfx.events.find((e) => e.id === "player.jump@default_boy");
ok(jumpBoy?.scope?.id === "default_boy" && jumpBoy.sounds.length === 1 && jumpBoy.sounds[0].voiceRate === 2,
  "jump is PER CHARACTER — the boy's event carries only his voice at ×2");
// Jump + Fall + Die per hero. Die joined them 2026-08-06 (games-audio's ask,
// quoting the maintainer: "Can't assign a separate voice to the male (you need
// to fix that)") — there was ONE shared Die card, so the boy could not be
// given his own death cry.
// Count the HEROES' six explicitly. The total is not a fixed number any more:
// per-monster events are scoped too, and the Game Master mints those himself.
const heroScoped = sfx.events.filter((e) => e.scope?.domain === "characters");
ok(heroScoped.length === 6, `six scoped hero events: jump+fall+die per hero (${heroScoped.length})`);
// A PER-ENTITY event must be scoped, or it lands on the generic Sound Effects
// page filed under "World" and the Game Master can never find what he bound
// to a creature (maintainer 2026-08-06: "I have bound sound to Sprigling,
// can't unbind in the UI" — monsters.forest_poring_2.walk was exactly there).
const stray = sfx.events.filter((e) => /^(monsters|objects|items|characters)\.[^.]+\..+/.test(e.id) && !e.scope);
ok(stray.length === 0, `every per-entity event is scoped to its entity${stray.length ? ` — STRAY: ${stray.map((e) => e.id).join(", ")}` : ""}`);
const die = sfx.events.filter((e) => e.id.startsWith("player.die@"));
ok(die.length === 2 && die.every((e) => e.scope?.id), `Die is per hero (${die.map((e) => e.id).join(", ")})`);
ok(!sfx.events.some((e) => e.id === "player.die" && !e.scope),
  "and the old shared Die card is gone — the per-hero rows are the whole truth");
ok(!sfx.events.some((e) => !e.scope && /^player\.(jump|fall)$/.test(e.id)), "no generic jump/fall left");

// ---------- player view
await p.goto(W + "#/sounds", { waitUntil: "load" });
await p.waitForTimeout(1800);
const player = await p.evaluate(() => ({
  cards: document.querySelectorAll(".sfx-event").length,
  silent: [...document.querySelectorAll(".sfx-event .pill.warn")].filter((x) => /no sound yet/.test(x.textContent)).length,
  lib: !!document.querySelector(".sfx-lib"),
  stars: document.querySelectorAll(".sfx-event .stars").length,
  addForms: document.querySelectorAll(".sfx-add").length,
  inGame: [...document.querySelectorAll(".sfx-event .pill.ok")].filter((x) => x.textContent === "in game").length,
  notFired: [...document.querySelectorAll(".pill")].filter((x) => /not fired/.test(x.textContent)).length,
  groups: [...document.querySelectorAll("h2")].map((x) => x.textContent.replace(/\d+$/, "").trim()),
  aGrass: [...document.querySelectorAll(".sfx-event .panel-title")].some((x) => /Footsteps · Grass/.test(x.textContent)),
}));
console.log("player:", JSON.stringify(player));
ok(player.cards > 0 && player.aGrass, `players see the events (${player.cards})`);
const pTitles = await p.evaluate(() => [...document.querySelectorAll(".sfx-event .panel-title")].map((x) => x.textContent));
ok(!pTitles.some((t) => /Jump|Fall/.test(t)), "jump/fall live on the hero pages, not here");
ok(!pTitles.some((t) => /Chest|Potion|Confirm|Cancel/.test(t)), "players see nothing the game does not fire");
ok(player.silent === 0 && !player.lib && player.stars === 0 && player.addForms === 0 && player.notFired === 0 && player.inGame === 0,
  "players see NO silent events, no library, no stars, no add forms, no pipeline pills");
ok(player.groups.includes("Movement") && player.groups.includes("Interface"), "grouped by kind of moment");

// ONE PLAY BUTTON PER SEPARATELY-AUDIBLE THING (maintainer 2026-08-06: "why is
// the group in a group? Why 3 play buttons and not 2? A non admin will
// probably not even understand why we have 2 and not 1"). A single-sound,
// single-take event rendered THREE ▶ — event, layer, take — all playing the
// identical file. The rule, checked against the DATA's own shape rather than
// against the DOM's opinion of itself:
//     buttons = 1 (the event)
//             + layers, only when there is more than one
//             + takes of any layer that holds more than one
const btns = await p.evaluate(() => [...document.querySelectorAll(".sfx-event")].map((c) => ({
  id: c.dataset.event, buttons: c.querySelectorAll(".play-btn").length })));
ok(btns.length > 0 && btns.every((c) => c.id), `every card is identifiable (${btns.length})`);
const wrong = [], unmatched = [];
for (const card of btns) {
  const e = sfx.events.find((x) => x.id === card.id);
  if (!e) { unmatched.push(card.id); continue; }
  const layers = e.sounds.length;
  const want = (layers ? 1 : 0) + (layers > 1 ? layers : 0)
    + e.sounds.reduce((n, l) => n + (l.takes.length > 1 ? l.takes.length : 0), 0);
  if (card.buttons !== want) wrong.push(`${card.id}: ${card.buttons} buttons, expected ${want} (${layers} layer(s), takes ${e.sounds.map((l) => l.takes.length).join("/")})`);
}
ok(unmatched.length === 0, `every card resolves to a real event${unmatched.length ? ` — ${unmatched.join(", ")}` : ""}`);
ok(wrong.length === 0, `every ▶ plays something no other ▶ on its card does${wrong.length ? ` — ${wrong.slice(0, 4).join("; ")}` : ` (${btns.length} cards)`}`);
// The case that started this: ONE layer holding ONE recording. Not merely one
// layer — a single layer can still hold four takes, and those rows each earn
// a button of their own.
const single = btns.filter((c) => {
  const s = sfx.events.find((x) => x.id === c.id)?.sounds ?? [];
  return s.length === 1 && s[0].takes.length === 1;
});
ok(single.length > 0 && single.every((c) => c.buttons === 1),
  `a single-recording event has exactly ONE button (${single.length} such cards${single.filter((c) => c.buttons !== 1).length ? `, ${single.filter((c) => c.buttons !== 1).map((c) => `${c.id}=${c.buttons}`).join(", ")}` : ""})`);
// The pipeline line is the Game Master's, not a player's.
ok(!(await p.evaluate(() => [...document.querySelectorAll(".sfx-event p.muted")].some((x) => /Game Master/.test(x.textContent)))),
  "players are not told which sounds the Game Master assigned");

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

// the hero's OWN page carries the jump/fall cards, one voice, same engine
await p.goto(W + "#/characters/default_boy", { waitUntil: "load" });
await p.waitForTimeout(1800);
const heroCards = await p.evaluate(() => [...document.querySelectorAll(".sfx-event .panel-title")].map((x) => x.textContent.replace(/▶?\s*/, "").trim()));
ok(heroCards.some((t) => /^Jump/.test(t)) && heroCards.some((t) => /^Fall/.test(t)), `the hero page carries Jump and Fall (${heroCards.join(", ")})`);
const jumpPlay = await p.evaluate(async () => {
  window.__sfxPlays.length = 0;
  [...document.querySelectorAll(".sfx-event")].find((c) => /Jump/.test(c.querySelector(".panel-title").textContent)).querySelector(".play-event").click();
  await new Promise((r) => setTimeout(r, 800));
  return window.__sfxPlays.slice();
});
ok(jumpPlay.length === 1 && /jump_voice_boy/.test(jumpPlay[0].file), `HIS voice alone plays (${jumpPlay.map((x) => x.file.split("/").pop())})`);
ok(jumpPlay[0].rate === 2 && jumpPlay[0].db === +(eng.voiceGainDb + eng.busDb.sfx).toFixed(2), `at ×2, ${eng.voiceGainDb} + sfx bus dB (${jumpPlay[0].rate}, ${jumpPlay[0].db})`);
await p.goto(W + "#/sounds", { waitUntil: "load" });
await p.waitForTimeout(1500);

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

// ---------- the status chips a Game Master steers by (maintainer 2026-08-06)
const chips = await p.evaluate(() => {
  const pills = (c) => [...c.querySelectorAll(".pill")].map((x) => x.textContent);
  const notFired = [...document.querySelectorAll(".sfx-event .pill")].filter((x) => x.textContent === "not fired yet");
  return {
    inGame: [...document.querySelectorAll(".sfx-event .pill.ok")].filter((x) => x.textContent === "in game").length,
    notFired: notFired.length, notFiredRed: notFired.filter((x) => x.classList.contains("err")).length,
    contradictions: [...document.querySelectorAll(".sfx-event")].filter((c) => {
      const t = pills(c);
      return t.includes("in game") && (t.includes("not fired yet") || t.includes("no sound yet"));
    }).length,
    bus: /\bbus\b/i.test(document.querySelector("#content").innerText),
    takes: document.querySelectorAll(".sfx-take").length,
    durs: [...document.querySelectorAll(".sfx-take .pill")].filter((x) => /^[\d.]+s$|^\d+:\d\d$/.test(x.textContent)).length,
  };
});
console.log("chips:", JSON.stringify(chips));
ok(chips.inGame > 0, `assigned AND fired events carry the green "in game" chip (${chips.inGame})`);
ok(chips.notFired > 0 && chips.notFiredRed === chips.notFired, `"not fired yet" is RED on all ${chips.notFired}`);
ok(chips.contradictions === 0, "no event claims to be in game and broken at once");
ok(!chips.bus, "no engine 'bus' jargon anywhere on the page");
ok(chips.takes > 0 && chips.durs === chips.takes, `every take shows its length (${chips.durs}/${chips.takes})`);

// ---------- the picker dialog: search, listen, step, assign
const picker = await p.evaluate(async () => {
  document.querySelector(".sfx-event .sfx-add-open").click();
  await new Promise((r) => setTimeout(r, 300));
  const d = document.querySelector("dialog.sfx-picker");
  if (!d?.open) return { open: false };
  const rows = d.querySelectorAll(".picker-row").length;
  const ctl = [...d.querySelectorAll(".picker-ctl")].map((c) => `${c.querySelector("span").textContent}=${c.querySelector("code").textContent}`);
  // step down the list: each step must PLAY, and only one may be sounding
  window.__sfxPlays.length = 0;
  const next = [...d.querySelectorAll(".picker-bar .ghost-btn")].find((x) => /Next/.test(x.textContent));
  const names = [];
  for (let i = 0; i < 3; i++) {
    next.click();
    await new Promise((r) => setTimeout(r, 260));
    names.push(d.querySelector(".picker-row.sel .take-name").textContent);
  }
  return { open: true, rows, ctl, names, plays: window.__sfxPlays.length, live: sfxEngine.live.size,
    durs: [...d.querySelectorAll(".picker-row")].filter((r) => [...r.querySelectorAll(".pill")].some((x) => /^[\d.]+s$|^\d+:\d\d$/.test(x.textContent))).length,
    searchMargin: getComputedStyle(d.querySelector("input[type=search]")).marginTop,
    fits: d.getBoundingClientRect().width <= window.innerWidth };
});
console.log("picker:", JSON.stringify(picker));
ok(picker.open && picker.rows > 40, `the picker is a dialog listing the library (${picker.rows} sounds)`);
ok(picker.durs === picker.rows, `every row shows its length (${picker.durs}/${picker.rows})`);
ok(picker.ctl?.join(",") === "pitch=1×,volume=0 dB,random pitch=0 st", `audition controls start at normal values (${picker.ctl?.join(", ")})`);
ok(picker.searchMargin === "0px" && picker.fits, "the dialog's own input CSS (not the sign-in dialog's) and it fits a phone");
ok(picker.plays === 3 && new Set(picker.names).size === 3, `Next steps AND plays (${picker.plays} plays: ${picker.names?.join(" → ")})`);
ok(picker.live <= 1, `only one sound is ever sounding — the previous stops dead (${picker.live})`);

// request flow: assign from the dialog → pending row → savebar → withdraw.
// SCOPED to the card this check opened: the Game Master's own queued requests
// live on this page too, and a gate must never withdraw one of those.
const req = await p.evaluate(async () => {
  const d = document.querySelector("dialog.sfx-picker");
  const card = document.querySelector(".sfx-event:has(.sfx-add-open)");
  const before = card.querySelectorAll(".sfx-req").length;
  const set = (label, v) => {
    const c = [...d.querySelectorAll(".picker-ctl")].find((x) => x.textContent.startsWith(label));
    c.querySelector("input").value = String(v);
    c.querySelector("input").dispatchEvent(new Event("input"));
  };
  set("pitch", 1.2); set("random pitch", 0.5);
  d.querySelector(".dialog-row .primary-btn").click();
  await new Promise((r) => setTimeout(r, 400));
  // the card is re-rendered by route(); find it again and take OUR row (the last)
  const again = document.querySelector(".sfx-event:has(.sfx-add-open)");
  const rows = [...again.querySelectorAll(".sfx-req")];
  return {
    before, now: rows.length,
    pending: rows.at(-1)?.textContent ?? null,
    closed: !document.querySelector("dialog.sfx-picker"),
    savebar: !document.querySelector("#savebar").classList.contains("hidden"),
  };
});
console.log("request:", JSON.stringify(req).slice(0, 300));
ok(req.now === req.before + 1, `the request is queued on that event (${req.before} → ${req.now})`);
ok(!!req.pending && /pitch ×1\.2/.test(req.pending) && /±0\.5 st/.test(req.pending), "and renders with its pitch/vol/random-pitch");
ok(req.closed, "assigning closes the picker");
ok(req.savebar, "the savebar offers to send it (same save path as all live edits)");
const withdrew = await p.evaluate(async (before) => {
  const card = document.querySelector(".sfx-event:has(.sfx-add-open)");
  [...card.querySelectorAll(".sfx-req")].at(-1).querySelector(".x-btn").click();
  await new Promise((r) => setTimeout(r, 300));
  return document.querySelector(".sfx-event:has(.sfx-add-open)").querySelectorAll(".sfx-req").length === before;
}, req.before);
ok(withdrew, "a queued request can be withdrawn — and only the one we queued");

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL SFX CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
