// "Read next" is a promise: every link under it must lead to something the
// reader can actually read. This walks EVERY page that offers Read next,
// follows EVERY link it offers, and asserts prose at the other end.
//
//   node wiki/tools/check-deadend.mjs
//
// Needs the games2 server running (it serves /assets and /api). Point it
// elsewhere with WIKI_URL. Set WIKI_ADMIN_PASSWORD to also check that the
// hidden refs are still visible to the Game Master, flagged — without it that
// half is skipped (the password is NOT in this repo; the repo is public).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
// playwright-core lives in games2/node_modules and ESM resolves bare specifiers
// against the IMPORTING file, not the cwd — so ask for it from there by hand
// rather than adding a node_modules tree to a domain that has no build step.
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");

const ORIGIN = process.env.WIKI_URL ?? "http://127.0.0.1:8902";
const W = `${ORIGIN}/assets/wiki/site/index.html`;
const DATA = new URL("../site/data.json", import.meta.url);
const PASSWORD = process.env.WIKI_ADMIN_PASSWORD ?? "";
const EXE = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const b = await chromium.launch({ executablePath: EXE });
const p = await (await b.newContext({ viewport: { width: 426, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };

// Which pages CAN offer Read next: any entity the lore agent gave refs to.
const d = JSON.parse(readFileSync(DATA, "utf8"));
const pages = [];
for (const dom of ["monsters", "characters", "objects", "items"])
  for (const x of d.domains[dom] ?? []) if ((x.loreRelated ?? []).length) pages.push(`#/${dom}/${x.id}`);
for (const e of d.domains.lore ?? []) if ((e.related ?? []).length) pages.push(`#/lore/${e.id}`);
console.log(`pages offering "Read next": ${pages.length}`);

// 1. collect every link a PLAYER is offered
const offered = new Map();                        // href -> pages that offer it
let rows = 0;
for (const page of pages) {
  await p.goto(W + page, { waitUntil: "load" });
  await p.waitForTimeout(220);
  const hrefs = await p.evaluate(() =>
    [...document.querySelectorAll(".see-also .drop-row")].map((r) => r.getAttribute("href")));
  if (!hrefs.every((x) => x)) ok(false, `${page}: a Read-next row is not a link`);
  rows += hrefs.length;
  for (const hr of hrefs) offered.set(hr, [...(offered.get(hr) ?? []), page]);
}
const targets = [...offered.keys()];
console.log(`links offered: ${rows} → ${targets.length} distinct destinations`);
ok(rows > 0, "the pages still offer somewhere to go");

// 2. every destination has prose. A story card with zero paragraphs counts as
//    a dead end — a card that renders but says nothing is the same betrayal.
let bad = 0;
for (const t of targets) {
  await p.goto(W + t, { waitUntil: "load" });
  await p.waitForTimeout(220);
  const readable = await p.evaluate(() => {
    const card = document.querySelector(".story-card");
    if (card) return { kind: "story", paras: card.querySelectorAll(".story-body p").length };
    const body = document.querySelector(".chapter-body");
    if (body) return { kind: "chapter", paras: body.querySelectorAll("p").length };
    return { kind: "none", paras: 0 };
  });
  if (readable.kind === "none" || readable.paras === 0) {
    bad++;
    console.log(`  DEAD END ${t} (${readable.kind}) ← ${offered.get(t).join(", ")}`);
  }
}
ok(bad === 0, `no Read-next link lands on a page with nothing to read (${targets.length} destinations)`);

// 3. what players don't see, the Game Master does — flagged, so the person who
//    can commission the missing story knows it is missing.
// A page whose lore names something story-less — found in the data, so this
// keeps testing the real case as the lore agent fills the gaps in.
const storyless = (r) => {
  if (r.domain === "lore") return !(d.domains.lore ?? []).find((e) => e.id === r.id)?.body?.length;
  const dom = d.domains[r.domain];
  return !Array.isArray(dom) || !dom.find((x) => x.id === r.id)?.loreStory?.length;
};
const probe = ["monsters", "characters", "objects", "items"].flatMap((dom) =>
  (d.domains[dom] ?? []).filter((x) => (x.loreRelated ?? []).some(storyless)).map((x) => `#/${dom}/${x.id}`))[0];

if (!PASSWORD) console.log("(WIKI_ADMIN_PASSWORD unset — skipping the admin half)");
else if (!probe) console.log("(no entity references a story-less page — nothing for the admin half to check)");
else {
  console.log(`admin probe: ${probe}`);
  await p.goto(W + probe, { waitUntil: "load" });
  await p.waitForTimeout(220);
  const asPlayer = await p.evaluate(() => document.querySelectorAll(".see-also .drop-row").length);
  await p.evaluate(async (pw) => {
    const r = await fetch("/api/wiki/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: pw }) });
    localStorage.setItem("wiki-admin-token", (await r.json()).token);
  }, PASSWORD);
  await p.reload({ waitUntil: "load" });
  await p.waitForTimeout(2000);                   // the token is validated async
  ok(await p.evaluate(() => [...document.querySelectorAll("#drawer a, nav a")].some((a) => /Parameters/.test(a.textContent))),
    "the check really is in admin mode");
  const asAdmin = await p.evaluate(() => [...document.querySelectorAll(".see-also .drop-row")].map((r) => ({
    text: r.textContent.trim(), link: r.tagName === "A", warn: !!r.querySelector(".pill.warn") })));
  console.log("admin sees:", JSON.stringify(asAdmin.map((x) => `${x.text}${x.link ? " [link]" : " [flagged]"}`)));
  const flagged = asAdmin.filter((x) => x.warn);
  ok(asAdmin.length > asPlayer, `the admin sees more rows than the player (${asAdmin.length} vs ${asPlayer})`);
  ok(flagged.length > 0 && flagged.every((x) => !x.link), "the hidden ones are flagged, and not clickable");
  ok(flagged.every((x) => /no story yet/.test(x.text)), "the flag says why");
}

// ONE COUNT PER SECTION. The nav and the start-page tile must agree: World
// counted its 8 terrain TYPES in the sidebar while its card counted all 4,372
// tiles, so the same section reported two different sizes depending on where
// you looked (maintainer 2026-08-06). A `navCount` override existed for
// exactly that one section; it is gone, and this keeps it gone.
await p.goto(`${W}#/`, { waitUntil: "load" });
await p.waitForTimeout(1600);
const counts = await p.evaluate(() => {
  const nav = {};
  for (const a of document.querySelectorAll("#nav a")) {
    const c = a.querySelector(".count");
    if (!c || !c.textContent.trim()) continue;
    nav[a.textContent.replace(c.textContent, "").trim()] = c.textContent.trim();
  }
  const start = {};
  for (const a of document.querySelectorAll("#content a")) {
    const m = a.textContent.replace(/\s+/g, " ").trim().match(/^(.+?)(\d[\d,]*) \w+$/);
    if (m) start[m[1].trim()] = m[2];
  }
  return { nav, start };
});
const mismatch = Object.keys(counts.start).filter((k) => counts.nav[k] !== undefined && counts.nav[k] !== counts.start[k]);
console.log("counts:", JSON.stringify(counts.nav));
ok(Object.keys(counts.start).length > 4, `the start page tiles carry counts (${Object.keys(counts.start).length})`);
ok(mismatch.length === 0,
  `every section reports the SAME number in the menu and on its card${mismatch.length ? ` — ${mismatch.map((k) => `${k}: nav ${counts.nav[k]} vs card ${counts.start[k]}`).join("; ")}` : ""}`);

console.log("page errors:", errs.length ? errs : "none");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL DEAD-END CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
