// Removing a sound from an EVENT unbinds it; removing a RECORDING is a
// different act, in a different place (maintainer 2026-08-06).
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await (await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
// Admin is FAKED at the network layer rather than by logging in: the unbind
// controls are Game-Master-only, but everything asserted here is client logic
// (which control renders where, and what payload it writes). A real login
// would only make this gate skip wherever the password is absent — which is
// exactly where a regression would slip through unseen.
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript(() => localStorage.setItem("wiki-admin-token", `9999999999.${"a".repeat(64)}`));
await p.goto(W + "#/sounds", { waitUntil: "load" });
await p.waitForTimeout(2400);

// ---------- an event card: the verdict is on the BINDING, not on the takes
const card = await p.evaluate(() => {
  // A card whose ONE layer plays several recordings — the multi-take binding.
  // (Not merely a card with 2+ take rows: two single-take LAYERS look the
  // same to that selector and are a different case entirely.)
  const c = [...document.querySelectorAll(".sfx-event")].find((x) =>
    [...x.querySelectorAll(".sfx-layer")].some((l) => l.querySelectorAll(".sfx-take").length >= 2));
  const bind = c.querySelector(".sfx-bind-verdict");
  return {
    event: [...c.querySelector(".panel-title").childNodes].find((n) => n.nodeType === 3 && n.textContent.trim())?.textContent.trim(),
    binds: c.querySelectorAll(".sfx-bind-verdict").length,
    layers: c.querySelectorAll(".sfx-layer").length,
    takes: c.querySelectorAll(".sfx-take").length,
    takeStars: c.querySelectorAll(".sfx-take .stars").length,
    takeUnbinds: c.querySelectorAll(".sfx-take .verdict").length,
    takeUnbindLabels: [...c.querySelectorAll(".sfx-take .verdict button")].map((x) => x.textContent),
    takeUnbindTitle: c.querySelector(".sfx-take .verdict button")?.title,
    label: bind?.textContent.replace(/\s+/g, " ").trim(),
    reject: [...bind.querySelectorAll(".verdict button")].map((x) => x.textContent),
    rejectTitle: bind.querySelectorAll(".verdict button")[1].title,
  };
});
console.log("event card:", JSON.stringify(card));
ok(card.binds === card.layers && card.binds > 0, `one verdict row per BOUND SOUND (${card.binds} for ${card.layers} layer(s), ${card.takes} takes)`);
ok(/these sounds, for this event/.test(card.label ?? ""), `the row says what it judges ("${card.label}")`);
ok(card.reject[1] === "✕ unbind all", `and on a multi-take binding it unbinds ALL (${card.reject.join(" ")})`);
ok(/stays in the library/.test(card.rejectTitle) || /they stay in the library/.test(card.rejectTitle),
  "its tooltip promises the recordings survive");
// THE PER-RECORDING UNBIND (maintainer 2026-08-06: "I wanted to unbind
// coin_pickup__take02.wav … but the unbind is not on the sound itself").
ok(card.takeUnbinds === card.takes, `every take carries its OWN ✕ unbind (${card.takeUnbinds}/${card.takes})`);
ok(card.takeUnbindLabels.every((x) => x === "✕ unbind"), `each reading "✕ unbind" (${[...new Set(card.takeUnbindLabels)].join(", ")})`);
ok(card.takeStars === 0, "and nothing else — the rating/approval of the binding stays one row up");
ok(/Remove ONLY /.test(card.takeUnbindTitle ?? "") && /stays in the library/.test(card.takeUnbindTitle ?? ""),
  `whose tooltip scopes it to the one recording ("${(card.takeUnbindTitle ?? "").slice(0, 60)}…")`);

// ---------- unbinding SAVES to feedback/bindings, keyed by event#sound, and
//            never touches the recording's own feedback file. Read off the
//            real save payload — the browser's own state is not exposed.
const posted = [];
await p.route("**/api/wiki/save", async (route) => {
  posted.push(JSON.parse(route.request().postData() ?? "{}"));
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
});
// Click the SECOND take's own ✕ — the exact gesture the maintainer wanted:
// drop take02, keep take01.
const clicked = await p.evaluate(async () => {
  const c = [...document.querySelectorAll(".sfx-event")].find((x) => x.querySelectorAll(".sfx-take .verdict").length >= 2);
  const rows = [...c.querySelectorAll(".sfx-take")];
  const name = rows[1].querySelector(".take-name").textContent;
  rows[1].querySelector(".verdict button").click();
  await new Promise((r) => setTimeout(r, 250));
  document.querySelector("#save-btn").click();
  await new Promise((r) => setTimeout(r, 900));
  return name;
});
console.log("saved:", JSON.stringify(posted));
ok(posted.length === 1, `one file saved (${posted.length})`);
ok(posted[0]?.file === "feedback/bindings", `and it is the BINDINGS channel (${posted[0]?.file})`);
const ids = Object.keys(posted[0]?.set ?? {});
ok(ids.length === 1 && /^[a-z0-9._@]+#\S+$/i.test(ids[0]), `keyed by an event#target pair (${ids[0]})`);
ok(ids[0]?.endsWith(clicked), `naming the RECORDING that was clicked, not its set (${clicked})`);
ok(posted[0].set[ids[0]]?.status === "rejected", "as a rejected BINDING");
ok(!posted.some((x) => /feedback\/(sounds|composer)/.test(x.file)),
  "nothing was written against the recording's own feedback — the file is untouched");
await p.unroute("**/api/wiki/save");
await p.reload({ waitUntil: "load" });                 // drop the local edit
await p.waitForTimeout(2000);

// ---------- the library still judges the RECORDING, and says so
const lib = await p.evaluate(() => {
  const row = document.querySelector(".sfx-lib-row .sfx-take");
  return {
    stars: !!row.querySelector(".stars"), verdict: !!row.querySelector(".verdict"),
    label: [...row.querySelectorAll(".verdict button")].map((x) => x.textContent),
    title: row.querySelectorAll(".verdict button")[1].title,
    intro: document.querySelector(".sfx-lib p.muted").textContent,
  };
});
console.log("library:", JSON.stringify(lib));
ok(lib.stars && lib.verdict && lib.label[1] === "✕ remove", `All sounds keeps the file's own verdict (${lib.label.join(" ")})`);
ok(/Retire this RECORDING/.test(lib.title), "whose tooltip is explicit that it deletes the file");
ok(/unbind it on that event's card/.test(lib.intro), "and the section explains where unbinding lives instead");

// ---------- an entity page's sound card follows the same rule
await p.goto(W + "#/characters/default_boy", { waitUntil: "load" });
await p.waitForTimeout(2200);
const ent = await p.evaluate(() => {
  const c = document.querySelector(".sfx-entity .sfx-event");
  return { binds: c.querySelectorAll(".sfx-bind-verdict").length,
    takes: c.querySelectorAll(".sfx-take").length,
    takeStars: c.querySelectorAll(".sfx-take .stars").length,
    takeUnbinds: c.querySelectorAll(".sfx-take .verdict").length };
});
console.log("entity card:", JSON.stringify(ent));
ok(ent.binds > 0 && ent.takeStars === 0, "a hero's own sound events judge the binding too");
// A hero's jump voice is a 3-4 take set, so the per-recording unbind has to
// reach here as well — that is where "drop just this grunt" belongs.
ok(ent.takes < 2 || ent.takeUnbinds === ent.takes,
  `and each of its ${ent.takes} recordings can be unbound on its own (${ent.takeUnbinds})`);

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL BINDING CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
