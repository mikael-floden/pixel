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

ok(errs.length === 0, `no page errors (${errs[0] ?? "none"})`);
await b.close();
console.log(fails.length ? `\nNEAR CHECKS FAILED (${fails.length})` : "\nALL NEAR CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
