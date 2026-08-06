// Opening the sound picker must SILENCE EVERYTHING, and give the game back
// when it closes (maintainer 2026-08-06: "should automatically stop the
// in-game sound when opened … the stop sound button is not always available
// from screens where the dialog can be opened").
//
// Three independent sources can be audible, and a modal <dialog> blocks the
// controls for all of them:
//   1. sfxEngine  — the WebAudio auditions
//   2. #shared-audio — the <audio> element carrying music beds + entity takes
//   3. THE GAME behind the drawer — whose "🔇 Mute the game" button exists
//      only on the Sound Effects and Music pages, so a picker opened from a
//      monster or character card had no way to reach it at all.
//
// The dangerous half is the RESTORE: we may only un-mute what we muted, and
// the mute button's label must never lie, or someone is left unable to get
// their game sound back.
//
// ADMIN IS FAKED at the network layer rather than by logging in. The picker is
// Game-Master-only, but everything under test here is pure client logic with
// no server dependency — a real login would add nothing and would make this
// gate skip in every environment without the password, which is exactly where
// a regression would slip through.
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
const p = await (await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
// Plant the token BEFORE any page script: boot() clears an unvalidated one,
// which races a post-load evaluate.
await p.addInitScript(() => localStorage.setItem("wiki-admin-token", `9999999999.${"a".repeat(64)}`));

const O = process.env.WIKI_URL ?? "http://127.0.0.1:8902";
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
// A host page that embeds the wiki and records the mute posts — the drawer's
// side of the contract (games2/client/src/wikipanel.ts).
await p.route(`${O}/host.html`, (r) => r.fulfill({ status: 200, contentType: "text/html",
  body: `<body style="margin:0"><iframe id=f src="${O}/assets/wiki/site/index.html" style="width:393px;height:851px;border:0"></iframe>
  <script>window.MUTES=[];addEventListener("message",e=>{if(e.data&&e.data.type==="wiki:muteGame")window.MUTES.push(e.data.on)})</script>` }));

const wiki = () => p.frames()[1];
const label = () => wiki().evaluate(() => document.querySelector(".mute-game")?.textContent ?? null);
const mutes = () => p.evaluate(() => window.MUTES);
const openPicker = () => wiki().evaluate(async () => { document.querySelector(".sfx-add-open").click(); await new Promise((r) => setTimeout(r, 500)); });
const closePicker = () => wiki().evaluate(async () => { document.querySelector("dialog.sfx-picker")?.close(); await new Promise((r) => setTimeout(r, 300)); });
async function go(hash) {
  await p.goto(`${O}/host.html`, { waitUntil: "load" });
  await p.waitForTimeout(1200);
  await wiki().evaluate((h) => { location.hash = h; }, hash);
  await p.waitForTimeout(2200);
}

// --- the page with NO mute button of its own: the case that had no way out --
const MONSTER = `#/monsters/${process.env.WIKI_MONSTER ?? "forest_poring"}`;
for (const [where, hash] of [["a monster page", MONSTER], ["the Sound Effects page", "#/sounds"]]) {
  await go(hash);
  console.log(`\n--- picker opened from ${where} ---`);
  const r = await wiki().evaluate(async () => {
    const a = document.querySelector("#shared-audio");
    if (!document.querySelector(".sfx-add-open")) return { noBtn: true };
    a.src = "/assets/composer/music/battle.ogg";
    await a.play().catch(() => {});
    return { playing: !a.paused, muteBtns: document.querySelectorAll(".mute-game").length };
  });
  if (r.noBtn) { ok(false, `${where}: no assign button`); continue; }
  ok(r.playing, "a track really was playing before the picker opened");
  await openPicker();
  const after = await wiki().evaluate(() => ({
    paused: document.querySelector("#shared-audio").paused,
    open: !!document.querySelector("dialog.sfx-picker"),
    bar: [...document.querySelectorAll(".picker-bar .ghost-btn")].map((x) => {
      const c = x.getBoundingClientRect();
      return { t: x.textContent, w: Math.round(c.width), h: Math.round(c.height), top: Math.round(c.top) };
    }),
  }));
  ok(after.open, "the picker opened");
  ok(after.paused, "…and it stopped the wiki's <audio> player");
  ok((await mutes()).at(-1) === true, `…and muted the game (${JSON.stringify(await mutes())})`);
  if (hash === MONSTER) ok(r.muteBtns === 0, "…from a page carrying no mute button at all — the unreachable case");

  // The transport buttons are the WORK of this dialog: thumb-sized, one row.
  console.log("  bar:", JSON.stringify(after.bar));
  ok(after.bar.length === 3, "Prev / Play / Next are all present");
  ok(after.bar.every((x) => x.h >= 44), `thumb-sized (heights ${after.bar.map((x) => x.h).join("/")})`);
  ok(after.bar.every((x) => x.w >= 95), `and wide (widths ${after.bar.map((x) => x.w).join("/")})`);
  ok(new Set(after.bar.map((x) => x.top)).size === 1, "on ONE row — the bar must never wrap");

  // The audition sliders, checked here because this is the gate that always
  // runs with the picker open (check-takes needs the admin password and skips
  // wherever it is absent — which is where a regression would hide).
  // "random pitch" is a RANGE either side of the pitch, so its readout must
  // say so: 6 st alone reads as "six semitones up" (maintainer 2026-08-06,
  // "it says 6st and not ± amount"). Zero stays plain — "±0" is nonsense.
  const ctls = await wiki().evaluate(async () => {
    const d = document.querySelector("dialog.sfx-picker");
    const row = [...d.querySelectorAll(".picker-ctl")].find((c) => /random/.test(c.textContent));
    const inp = row.querySelector("input"), out = row.querySelector(".sfx-val");
    const readouts = {};
    for (const v of ["0", "0.4", "6"]) { inp.value = v; inp.dispatchEvent(new Event("input")); readouts[v] = out.textContent; }
    // …and it must actually reach the audition: six presses, six pitches.
    inp.value = "6"; inp.dispatchEvent(new Event("input"));
    window.__sfxPlays.length = 0;
    for (let i = 0; i < 6; i++) { d.querySelector(".picker-play").click(); await new Promise((r) => setTimeout(r, 240)); }
    const absolute = {};
    for (const c of d.querySelectorAll(".picker-ctl")) {
      const l = c.querySelector("span").textContent;
      if (!/random/.test(l)) absolute[l] = c.querySelector(".sfx-val").textContent;
    }
    return { readouts, absolute, rates: window.__sfxPlays.map((x) => x.rate) };
  });
  console.log("  sliders:", JSON.stringify(ctls));
  ok(ctls.readouts["6"] === "±6 st" && ctls.readouts["0.4"] === "±0.4 st",
    `random pitch reads as a ± range (${ctls.readouts["6"]}, ${ctls.readouts["0.4"]})`);
  ok(ctls.readouts["0"] === "0 st", `and zero stays plain (${ctls.readouts["0"]})`);
  ok(Object.values(ctls.absolute).every((v) => !v.includes("±")),
    `while pitch and volume stay absolute (${Object.values(ctls.absolute).join(", ")})`);
  ok(new Set(ctls.rates).size === ctls.rates.length && ctls.rates.length === 6,
    `and Play honours it — ${new Set(ctls.rates).size}/${ctls.rates.length} distinct pitches`);

  await closePicker();
  ok((await mutes()).at(-1) === false, `closing gives the game back (${JSON.stringify(await mutes())})`);
}

// --- the label must never lie, and a deliberate mute must survive ----------
await go("#/sounds");
console.log("\n--- the Game Master had NOT muted ---");
ok(/Mute the game/.test(await label()), `starts "${await label()}"`);
await openPicker();
ok(/Unmute/.test(await label()), "the button behind the modal tracks the picker's mute");
await closePicker();
ok(/Mute the game/.test(await label()), `and returns to "${await label()}"`);
ok(JSON.stringify(await mutes()) === "[true,false]", "exactly one mute and one restore");

await go("#/sounds");
console.log("\n--- the Game Master pressed Mute first ---");
await wiki().evaluate(async () => { document.querySelector(".mute-game").click(); await new Promise((r) => setTimeout(r, 200)); });
await openPicker();
await closePicker();
ok(/Unmute/.test(await label()), `the game STAYS muted ("${await label()}") — only what we muted is restored`);
ok(JSON.stringify(await mutes()) === "[true]", `and no redundant posts (${JSON.stringify(await mutes())})`);

// Escape closes a modal without going through Cancel — same restore path.
await go("#/sounds");
console.log("\n--- Escape ---");
await openPicker();
await p.keyboard.press("Escape");
await p.waitForTimeout(400);
ok((await mutes()).at(-1) === false, `Escape restores the game too (${JSON.stringify(await mutes())})`);
ok(await wiki().evaluate(() => document.querySelectorAll("dialog.sfx-picker").length) === 0, "and leaves no dialog in the DOM");

ok(errs.length === 0, `no page errors${errs.length ? `: ${errs[0]}` : ""}`);
await b.close();
console.log(fails.length ? `\nAUDIO-STOP CHECKS FAILED (${fails.length})` : "\nALL AUDIO-STOP CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
