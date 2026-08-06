// The picker must let you choose a RECORDING, not point at a folder
// (maintainer 2026-08-06: "you don't let me select the sound. You point to a
// group! We have way more sounds than this").
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
import { readFileSync } from "node:fs";
const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
const p = await (await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };

// what the repo actually holds — takes AND the generation pool they were
// picked from (see check-everysound.mjs: listing takes alone hid 91 sounds).
const compTakes = Object.values(D.sfx.composerSets).reduce((n, c) => n + c.takes.length + (c.alts?.length ?? 0), 0);
const catTakes = D.domains.sounds.reduce((n, s) => n + s.takes.length, 0);
const REAL = compTakes + catTakes;
const SETS = Object.keys(D.sfx.composerSets).length + D.domains.sounds.length;
console.log(`repo: ${REAL} recordings across ${SETS} sets/sounds`);
if (!process.env.WIKI_ADMIN_PASSWORD) {
  // The picker is Game-Master-only, so without the password there is nothing
  // to open. Skip rather than crash — check-everysound.mjs still proves the
  // LIST is complete without a browser or a login.
  console.log("\nSKIPPED: WIKI_ADMIN_PASSWORD not set (the picker is admin-only)");
  process.exit(0);
}

await p.goto(W, { waitUntil: "load" });
await p.evaluate(async (pw) => {
  const r = await fetch("/api/wiki/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: pw }) });
  localStorage.setItem("wiki-admin-token", (await r.json()).token);
}, process.env.WIKI_ADMIN_PASSWORD ?? "");
await p.goto(W + "#/sounds", { waitUntil: "load" });
await p.reload({ waitUntil: "load" });
await p.waitForTimeout(2400);

const open = await p.evaluate(async () => {
  document.querySelector(".sfx-event .sfx-add-open").click();
  await new Promise((r) => setTimeout(r, 400));
  const d = document.querySelector("dialog.sfx-picker");
  const rows = [...d.querySelectorAll(".picker-row")];
  return {
    count: rows.length,
    placeholder: d.querySelector("input[type=search]").placeholder,
    labels: rows.map((r) => r.querySelector(".take-name").textContent),
    titles: rows.map((r) => r.querySelector(".take-name").title),
    inGame: rows.filter((r) => [...r.querySelectorAll(".pill")].some((x) => x.textContent === "in game")).length,
    // no row may still advertise "N takes" — every row IS a take now
    setPills: rows.filter((r) => [...r.querySelectorAll(".pill")].some((x) => /\d+ takes/.test(x.textContent))).length,
  };
});
console.log("picker:", JSON.stringify({ ...open, labels: open.labels.slice(0, 6), titles: open.titles.slice(0, 3) }));
ok(open.count === REAL, `every recording is selectable (${open.count} rows vs ${REAL} on disk; it listed ${SETS} sets before)`);
ok(new RegExp(`Search ${REAL} sounds`).test(open.placeholder), `and it says so (“${open.placeholder}”)`);
ok(open.setPills === 0, "no row pretends to be a folder of takes any more");

// a multi-take set must expose EACH take, distinctly labelled and separately playable
const multi = Object.entries(D.sfx.composerSets).find(([, c]) => c.takes.length > 2);
const takes = await p.evaluate(async (set) => {
  const d = document.querySelector("dialog.sfx-picker");
  const s = d.querySelector("input[type=search]");
  s.value = set; s.dispatchEvent(new Event("input"));
  await new Promise((r) => setTimeout(r, 200));
  const rows = [...d.querySelectorAll(".picker-row")];
  window.__sfxPlays.length = 0;
  const played = [];
  for (let i = 0; i < Math.min(3, rows.length); i++) {
    rows[i].click();
    await new Promise((r) => setTimeout(r, 320));
    played.push(window.__sfxPlays.at(-1)?.file ?? null);
  }
  return { rows: rows.length, labels: rows.map((r) => r.querySelector(".take-name").textContent), played };
}, multi[0]);
const nAlts = multi[1].alts?.length ?? 0;
const nRows = multi[1].takes.length + nAlts;
console.log(`${multi[0]} (${multi[1].takes.length} takes + ${nAlts} alternatives):`, JSON.stringify(takes));
ok(takes.rows === nRows, `searching "${multi[0]}" lists its ${multi[1].takes.length} takes AND its ${nAlts} unpicked candidates (${takes.rows})`);
ok(takes.labels.every((l) => /take \d|alternative \d/.test(l)), `each labelled by recording (${takes.labels.slice(0, 4).join(", ")}…)`);
ok(nAlts > 0 && takes.labels.filter((l) => /alternative \d/.test(l)).length === nAlts,
  `the generation pool is reachable, not just the winners (${nAlts} alternatives listed)`);
ok(new Set(takes.played).size === takes.played.length && takes.played.every(Boolean),
  `and each row auditions its OWN file (${takes.played.map((f) => f?.split("/").pop()).join(", ")})`);

// assigning carries the exact take, not just the folder
const posted = [];
await p.route("**/api/wiki/save", async (route) => {
  posted.push(JSON.parse(route.request().postData() ?? "{}"));
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
});
const req = await p.evaluate(async () => {
  const d = document.querySelector("dialog.sfx-picker");
  const rows = [...d.querySelectorAll(".picker-row")];
  rows[rows.length - 1].click();                       // the LAST take, not the first
  await new Promise((r) => setTimeout(r, 250));
  const label = d.querySelector(".picker-row.sel .take-name").textContent;
  d.querySelector(".dialog-row .primary-btn").click();
  await new Promise((r) => setTimeout(r, 400));
  const row = document.querySelector(".sfx-req .take-name")?.textContent ?? "";
  document.querySelector("#save-btn").click();
  await new Promise((r) => setTimeout(r, 900));
  return { label, row };
});
const set = posted.find((x) => x.file === "tuning/sfx_requests");
const entry = Object.values(set?.set ?? {})[0];
console.log("request:", JSON.stringify({ ...req, entry }));
ok(!!entry?.take && /__(take|cand)\d+\.\w+$/.test(entry.take), `the request names the exact recording (take: ${entry?.take})`);
ok(entry.take.includes(multi[0]) && entry.sound === `composer/${multi[0]}`, "with its set alongside, for the composer's existing parser");
// The LAST row of a composer set is an unpicked candidate, so this doubles as
// the proof that a pool sound can be cast — the whole point of listing them.
ok(/\/pool\/.*__cand\d+\.\w+$/.test(entry.take), `and an unpicked candidate can be assigned, not only a winner (${entry.take.split("/").pop()})`);
ok(/take\d+/.test(req.row) || req.row.includes(entry.take.split("/").pop().replace(/\.\w+$/, "")),
  `and the queued row shows which take (“${req.row.slice(0, 60)}”)`);

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL TAKE-PICKER CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
