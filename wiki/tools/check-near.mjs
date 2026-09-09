/* THE 🔍 "WHAT AM I STANDING NEXT TO?" PAGE (maintainer 2026-09-02, through
 * the games-ui agent: "a square search icon that will also take you to the
 * wiki, but will go directly to the search with the results sorted by how far
 * away they are from the player"). Contract: games2/spec/WIKI_NEAR.md.
 *
 * DRIVEN THE WAY THE GAME DRIVES IT — a real same-origin IFRAME and real
 * postMessage traffic, because that is the entire seam. A gate that called
 * viewNear() directly would pass on a page the game can never reach.
 */
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
import { readFileSync } from "node:fs";
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));

const MON = D.domains.monsters[0], OBJ = D.domains.objects[0], IT = (D.domains.items ?? [])[0];
const GROUND = (D.worldMeta?.groundTypes ?? [])[0];
const NPC = D.domains.characters.find((c) => c.kind === "npc") ?? D.domains.characters[0];

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage({ viewport: { width: 900, height: 1600 } });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

/* The HOST stands in for the game: it embeds the wiki, answers wantNear, and
 * records what the page asked for. */
await p.goto(W, { waitUntil: "load" });
await p.waitForTimeout(1500);
const install = async (snapshot) => p.evaluate(({ url, snap }) => {
  document.querySelectorAll("iframe.near-test").forEach((f) => f.remove());
  window.__asked = 0;
  window.__snap = snap;
  const f = document.createElement("iframe");
  f.className = "near-test";
  f.style.cssText = "position:fixed;left:0;top:0;width:900px;height:1500px;z-index:99999;background:#fff";
  f.src = `${url}#/near`;
  window.__frame = f;
  if (!window.__wired) {
    window.__wired = true;
    window.addEventListener("message", (e) => {
      if (e.origin !== location.origin) return;
      if (e.data?.type === "wiki:wantNear") {
        window.__asked++;
        window.__frame.contentWindow.postMessage({ type: "wiki:near", ...window.__snap }, location.origin);
      }
    });
  }
  document.body.appendChild(f);
}, { url, snap: snapshot });
const url = W;
const frame = async () => { const el = await p.$("iframe.near-test"); return el.contentFrame(); };

// ---- 1. the ordinary case: the game answers with a list --------------------
const SNAP = {
  world: "the_game", at: { col: 13.75, row: 11.4 }, radius: 12,
  items: [
    { domain: "world", id: GROUND.id, dist: 0, n: 41 },
    { domain: "characters", id: NPC.id, dist: 1.3, n: 1 },
    { domain: "objects", id: OBJ.id, dist: 2.1, n: 1 },
    { domain: "items", id: IT.id, dist: 3.7, n: 2 },
    { domain: "monsters", id: MON.id, dist: 5.9, n: 3 },
    { domain: "monsters", id: "a_kind_shipped_after_this_build", dist: 9.2, n: 1 },
  ],
};
await install(SNAP);
await p.waitForTimeout(2600);
const asked = await p.evaluate(() => window.__asked);
ok(asked >= 1, `the page ASKS the game for a snapshot when it opens (wantNear x${asked})`);
const f = await frame();
const rows = await f.evaluate(() => [...document.querySelectorAll("a.card")].map((a) => ({
  href: a.getAttribute("href"), name: a.querySelector(".card-name")?.textContent ?? "",
  sub: a.querySelector(".card-sub")?.textContent ?? "", img: !!a.querySelector("img"),
})));
ok(rows.length === 6, `every row the game sent is drawn (${rows.length} of 6)`);
ok(/under you/.test(rows[0]?.sub ?? ""), `the ground under his feet reads "under you" (“${rows[0]?.sub.trim()}”)`);
ok(rows[0]?.href === `#/world/${GROUND.id}`, `and routes to the ground-type page (${rows[0]?.href})`);
const dists = rows.map((r) => r.sub);
ok(/\b1 cell\b/.test(dists[1]) && !/1 cells/.test(dists[1]) && /2 cells/.test(dists[2]) && /6 cells/.test(dists[4]),
  `each row carries its distance, nearest first (${dists.map((d) => d.trim().split("·")[0].trim()).join(" | ")})`);
ok(rows[1]?.href === `#/characters/${NPC.id}` && rows[4]?.href === `#/monsters/${MON.id}`,
  `a row's route is exactly #/<domain>/<id>, the game's own ids (${rows[1]?.href}, ${rows[4]?.href})`);
ok(rows[1]?.name !== NPC.id && rows[1]?.img, `a known id shows the wiki's NAME and art, not the raw id (“${rows[1]?.name}”)`);
ok(/×3/.test(rows[4]?.sub ?? ""), `three of a kind is ONE row marked ×3 (“${rows[4]?.sub.trim()}”)`);
const unknown = rows[5];
ok(/a_kind_shipped_after_this_build/.test(unknown?.name ?? "") && /new/.test(unknown?.sub ?? ""),
  `an id this build has never seen is SHOWN, marked new, never dropped (“${unknown?.name}”)`);

// ---- 2. tapping a card goes to the page, like a search hit -----------------
await f.evaluate(() => [...document.querySelectorAll("a.card")][4].click());
await p.waitForTimeout(1200);
const landed = await f.evaluate(() => ({ hash: location.hash, h1: document.querySelector("h1")?.textContent ?? "" }));
ok(landed.hash === `#/monsters/${MON.id}` && landed.h1.length > 0,
  `tapping a card opens that page (${landed.hash} → “${landed.h1.slice(0, 30)}”)`);

// ---- 3. the empty world, and the select screen ----------------------------
await install({ world: "the_game", at: { col: 1, row: 1 }, radius: 12, items: [] });
await p.waitForTimeout(2400);
const emptyText = await (await frame()).evaluate(() => document.querySelector("#content")?.textContent ?? "");
ok(/Nothing within 12 cells/.test(emptyText), `an empty list SAYS so rather than drawing a blank page (“${emptyText.slice(0, 60).trim()}”)`);
await install({ world: null, at: null, radius: 12, items: [] });
await p.waitForTimeout(2400);
const selectText = await (await frame()).evaluate(() => document.querySelector("#content")?.textContent ?? "");
ok(/select screen/.test(selectText), `from the select screen it says where the page works (“${selectText.slice(0, 70).trim()}”)`);

// ---- 4. "look again" asks for a fresh snapshot ----------------------------
await install(SNAP);
await p.waitForTimeout(2400);
const before = await p.evaluate(() => window.__asked);
const f4 = await frame();
await f4.evaluate(() => [...document.querySelectorAll("button")].find((x) => /look again/.test(x.textContent))?.click());
await p.waitForTimeout(1200);
const after = await p.evaluate(() => window.__asked);
ok(after > before, `"look again" asks the game for a fresh snapshot (${before} → ${after})`);
const stillRows = await f4.evaluate(() => document.querySelectorAll("a.card").length);
ok(stillRows === 6, `and redraws the list it gets back (${stillRows} rows)`);

// ---- 5. standalone (not in the game) --------------------------------------
await p.goto(`${W}#/near`, { waitUntil: "load" });
await p.waitForTimeout(2200);
const standalone = await p.evaluate(() => document.querySelector("#content")?.textContent ?? "");
ok(/works from inside the game/.test(standalone), `opened as a plain page it explains itself instead of hanging (“${standalone.slice(0, 60).trim()}”)`);

// ---- 7. THE GAME'S OWN TIMING: the snapshot lands BEFORE data.json -------
// The game does not wait to be asked — it pushes wiki:near on the iframe's
// `load`, which fires before the page's data.json fetch resolves. The
// handler used to route() on arrival regardless, and in the real drawer that
// ran nearRow over state.data === null and threw at worldMeta() (games-ui's
// end-to-end gate, 2026-09-02). Played here exactly that way: push on load,
// answer nothing else, and the page must neither throw nor stay empty.
const errsBefore = errs.length;
await p.evaluate(({ url, snap }) => {
  document.querySelectorAll("iframe.near-test").forEach((f) => f.remove());
  window.__snap = null; // the host answers NO wantNear this time — push only
  const f = document.createElement("iframe");
  f.className = "near-test";
  f.style.cssText = "position:fixed;left:0;top:0;width:900px;height:1500px;z-index:99999;background:#fff";
  f.addEventListener("load", () => f.contentWindow.postMessage({ type: "wiki:near", ...snap }, location.origin));
  f.src = `${url}#/near`;
  window.__frame = f;
  document.body.appendChild(f);
}, { url, snap: SNAP });
await p.waitForTimeout(3000);
const pushed = await (await frame()).evaluate(() => document.querySelectorAll("#content a.card").length);
ok(errs.length === errsBefore, `a snapshot pushed on load, before data.json, does not throw (${errs.slice(errsBefore).join(" | ") || "clean"})`);
ok(pushed === SNAP.items.length, `…and the page still draws it once the index is in (${pushed} of ${SNAP.items.length} rows)`);


// ---- 8. HEARING: the music playing now and the sounds of the last 30 s -----
/* Maintainer 2026-09-02: "Does the #/near also contain music playing right now
 * and sound effects triggered the last 30s? (filtered on how recently the
 * sound effect was played)?" Audio rows ride in the same items array with
 * `ago` seconds instead of `dist`; they get their own section, newest first,
 * music leading, and their cards land on the Sounds / Music page with the
 * matching card lit. */
{
  const EV = D.sfx?.events?.find((e) => e.id === "combat.cross_off") ?? D.sfx?.events?.[0];
  const BED = (D.domains.music ?? []).find((t) => t.id === "night") ?? D.domains.music[0];
  const AUDIO = {
    world: "the_game", at: { col: 3, row: 3 }, radius: 12,
    items: [
      { domain: "objects", id: OBJ.id, dist: 2.1, n: 1 },
      { domain: "sounds", id: "an_event_this_build_never_saw", ago: 12.4, n: 1 },
      { domain: "sounds", id: EV.id, ago: 3.2, n: 2 },
      { domain: "music", id: BED.id, ago: 0 },
    ],
  };
  await p.goto(W, { waitUntil: "load" });
  await p.waitForTimeout(1200);
  await p.evaluate(() => { window.__wired = false; });
  await install(AUDIO);
  await p.waitForTimeout(2600);
  const f8 = await frame();
  const hear = await f8.evaluate(() => {
    const sec = document.querySelector(".near-hearing");
    return {
      present: !!sec,
      h2: sec?.querySelector("h2")?.textContent ?? "",
      rows: [...(sec?.querySelectorAll("a.card") ?? [])].map((a) => ({
        href: a.getAttribute("href"), name: a.querySelector(".card-name")?.textContent ?? "",
        sub: (a.querySelector(".card-sub")?.textContent ?? "").replace(/\s+/g, " ").trim(),
      })),
      spatial: [...document.querySelectorAll(".grid a.card")].filter((a) => !a.closest(".near-hearing")).length,
    };
  });
  ok(hear.present && /Hearing/.test(hear.h2), `audio rows get their own section (“${hear.h2}”)`);
  ok(hear.spatial === 1, `and stay OUT of the spatial list — seconds never sit next to cells (${hear.spatial} spatial row)`);
  ok(hear.rows.length === 3 && hear.rows[0].href === `#/music/${BED.id}` && /playing now/.test(hear.rows[0].sub),
    `the bed playing now leads, as "playing now" (${hear.rows[0]?.href} — “${hear.rows[0]?.sub}”)`);
  ok(hear.rows[1]?.href === `#/sounds/${EV.id}` && /3 s ago/.test(hear.rows[1].sub) && /×2/.test(hear.rows[1].sub),
    `then the sounds newest first, with how long ago and how often (“${hear.rows[1]?.name}” — “${hear.rows[1]?.sub}”)`);
  ok(hear.rows[1]?.name === EV.name, `a known event shows the wiki's NAME (“${hear.rows[1]?.name}” for ${EV.id})`);
  ok(/12 s ago/.test(hear.rows[2]?.sub ?? "") && /new/.test(hear.rows[2]?.sub ?? ""),
    `an event this build never saw is shown and marked new (“${hear.rows[2]?.name}” — “${hear.rows[2]?.sub}”)`);
  // Tapping a sound lands on the Sounds page with THAT card lit.
  await f8.evaluate(() => [...document.querySelectorAll(".near-hearing a.card")][1].click());
  await p.waitForTimeout(1500);
  const landedS = await f8.evaluate(() => ({ hash: location.hash, lit: document.querySelector(".sfx-event.spot")?.getAttribute("data-event") ?? null }));
  ok(landedS.hash === `#/sounds/${EV.id}` && landedS.lit === EV.id, `tapping a sound opens the Sounds page with that card lit (${landedS.hash}, lit: ${landedS.lit})`);
  // ...and a bed lands on the Music page the same way.
  await f8.evaluate((id) => { location.hash = `#/music/${id}`; }, BED.id);
  await p.waitForTimeout(1500);
  const landedM = await f8.evaluate(() => ({ hash: location.hash, lit: document.querySelector(".panel.spot")?.getAttribute("data-track") ?? null }));
  ok(landedM.lit === BED.id, `and a bed opens the Music page with its track lit (${landedM.hash}, lit: ${landedM.lit})`);
}

// ---- 9. an unscoped family, and the sound that played nothing -------------
/* games-ui, 2026-09-02, from the real drawer: "player.jump ... not in your
 * sfx.events list, so the card shows the raw id and a 'new' pill for an event
 * that has played since July". The engine fires the FAMILY (player.jump) and
 * picks the hero's voice; the wiki keys the voice (player.jump@default_boy)
 * on the hero's page. And the heard block's sound:null is the event that
 * fired and played nothing — the one he would want to assign. */
{
  const JUMP = (D.sfx?.events ?? []).find((e) => /^player\.jump@/.test(e.id));
  const KICK = (D.sfx?.events ?? []).find((e) => e.id === "combat.kick") ?? D.sfx?.events?.[0];
  ok(!!JUMP && !!JUMP.scope?.id, `the table keys the jump by VOICE (${JUMP?.id}, on ${JUMP?.scope?.domain}/${JUMP?.scope?.id})`);
  const FAMILY = {
    world: "the_game", at: { col: 3, row: 3 }, radius: 12,
    items: [
      { domain: "sounds", id: "player.jump", ago: 2.0, n: 1 },
      { domain: "sounds", id: KICK.id, ago: 5.5, n: 1 },
    ],
    heard: { music: null, sfx: [
      { event: "player.jump", sound: "composer/jump_voice", ago: 2.0, at: 1000 },
      { event: KICK.id, sound: null, ago: 5.5, at: 900 },
    ] },
  };
  await p.goto(W, { waitUntil: "load" });
  await p.waitForTimeout(1200);
  await p.evaluate(() => { window.__wired = false; });
  await install(FAMILY);
  await p.waitForTimeout(2600);
  const f9 = await frame();
  const fam = await f9.evaluate(() => [...document.querySelectorAll(".near-hearing a.card")].map((a) => ({
    href: a.getAttribute("href"), name: a.querySelector(".card-name")?.textContent ?? "",
    sub: (a.querySelector(".card-sub")?.textContent ?? "").replace(/\s+/g, " ").trim() })));
  ok(fam[0]?.name === JUMP.name && !/new/.test(fam[0]?.sub ?? ""),
    `an unscoped family id is named from its voice-scoped table entry, not shown raw (“${fam[0]?.name}” — “${fam[0]?.sub}”)`);
  // The href is URL-encoded (@ → %40); the router decodes it, as the landing below proves.
  ok(fam[0]?.href === `#/${JUMP.scope.domain}/${JUMP.scope.id}/${encodeURIComponent(JUMP.id)}`,
    `and links to the hero page where that card lives (${fam[0]?.href})`);
  ok(/silent/.test(fam[1]?.sub ?? ""), `an event that fired and played NOTHING is marked silent (“${fam[1]?.name}” — “${fam[1]?.sub}”)`);
  await f9.evaluate(() => [...document.querySelectorAll(".near-hearing a.card")][0].click());
  await p.waitForTimeout(2200);
  const landedH = await f9.evaluate(() => ({ hash: location.hash, lit: document.querySelector(".sfx-event.spot")?.getAttribute("data-event") ?? null }));
  ok(landedH.lit === JUMP.id, `tapping it opens the hero's page with THAT card lit (${landedH.hash}, lit: ${landedH.lit})`);
}
ok(errs.length === 0, `no page errors (${errs[0] ?? "none"})`);
await b.close();
console.log(fails.length ? `\nNEAR CHECKS FAILED (${fails.length})` : "\nALL NEAR CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
