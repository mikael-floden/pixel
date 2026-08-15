// THE SAVE BAR SAYS WHAT IT DOES, AND HOW MUCH IS IN IT.
//
// Maintainer, 2026-08-14: "The cancel admin button when approving/rejecting
// changes is called 'Discard'. Discard for me sounds like 'discard all scenery
// objects', what this really is for the user is a Cancel. The 'Save' is also a
// 'Commit' and not a save. It would also be good to know how many objects are
// in the batch. Now it just says '1 file with unsaved changes', but what I
// want to know is how many things are affected in that '1 file'."
//
// The count is the substance of it: a review session puts every verdict into
// ONE feedback file, so the old label read identically after one approval and
// after ninety — it described the plumbing rather than the work.
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await (await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
// Admin, but NEVER saving: a gate must not write the maintainer's review data.
// Everything here stops short of pressing Commit.
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  // An admin reads the REPO, not the image (wiki.js useStagingRoot, 2026-08-14).
  // The sandbox blocks browser egress, so point the staging base at this same
  // server's /assets — the identical code path, resolvable offline.
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});

const bar = () => p.evaluate(() => ({
  hidden: document.querySelector("#savebar").classList.contains("hidden"),
  text: document.querySelector("#savebar-text").textContent,
  buttons: [...document.querySelectorAll("#savebar button")].map((x) => x.textContent),
  textLines: Math.round((document.querySelector("#savebar-text")?.getBoundingClientRect().height ?? 0) / 21),
  onScreen: document.querySelector("#savebar").getBoundingClientRect().width <= window.innerWidth,
  // Rows by VERTICAL CENTRE with a tolerance — a text node and a padded
  // button on the same visual row differ by a pixel or two at the top edge,
  // and counting raw tops reported three rows for one.
  rows: (() => {
    const mids = [...document.querySelector("#savebar").children]
      .map((c) => { const r = c.getBoundingClientRect(); return r.top + r.height / 2; })
      .sort((a, b) => a - b);
    return mids.reduce((n, m, i) => (i && m - mids[i - 1] < 12 ? n : n + 1), 0);
  })(),
  bold: document.querySelector("#savebar-text b")?.textContent ?? null,
}));

await p.goto(`${W}#/objects`, { waitUntil: "load" });
await p.waitForTimeout(1800);
await p.evaluate(() => document.querySelector(".card").click());
await p.waitForTimeout(1600);
const rest = await bar();
ok(rest.hidden, "the bar stays out of the way until something is actually changed");
ok(rest.buttons.includes("Commit"), `the primary action is Commit, not Save (${rest.buttons.join(", ")})`);
ok(rest.buttons.includes("Cancel"), "and the way out is Cancel, not Discard — it drops pending edits, not art");
ok(!rest.buttons.some((t) => /Save|Discard/.test(t)), "neither old label survives anywhere on the bar");
// Export downloaded the raw live/ json for hand-committing — a workflow the
// maintainer has never used and never will (2026-08-14), and its width was
// what pushed the bar onto a second row on a phone.
ok(!rest.buttons.some((t) => /Export/.test(t)), `Export is gone (${rest.buttons.join(", ")})`);
ok(rest.buttons.length === 2, `leaving exactly the two that matter (${rest.buttons.length})`);

// THE COUNT CLIMBS WITH THE WORK. Verdicts on separate pieces all land in the
// same file, which is exactly the case the old label could not describe.
const seen = [];
for (let i = 1; i <= 4; i++) {
  await p.evaluate(() => [...document.querySelectorAll(".verdict button")].find((x) => /approve/.test(x.textContent))?.click());
  await p.waitForTimeout(280);
  seen.push((await bar()).text);
  await p.evaluate(() => [...document.querySelectorAll("a,button")].find((x) => x.textContent.trim() === "›")?.click());
  await p.waitForTimeout(420);
}
console.log("as verdicts land:", JSON.stringify(seen));
ok(seen[0] === "1 change", `one verdict reads "1 change" — singular (${seen[0]})`);
ok(seen[3] === "4 changes", `and four verdicts read "4 changes", though they share ONE file (${seen[3]})`);
ok(new Set(seen).size === seen.length, "the number moves on every single change, never sticks");

// A rating is a change too — the count is about affected things, not verdicts.
await p.evaluate(() => document.querySelector(".stars button:nth-child(4)")?.click());
await p.waitForTimeout(300);
const withStar = await bar();
ok(withStar.text === "5 changes", `a rating counts as a change as well (${withStar.text})`);

// It has to be READABLE on a phone: three buttons plus the count broke into
// four one-word lines before this was pinned.
console.log("bar layout:", JSON.stringify(withStar));
ok(withStar.textLines === 1, `the count sits on one line (${withStar.textLines})`);
ok(withStar.onScreen, "and the bar never grows wider than the screen");
ok(withStar.rows === 1, `and the whole bar fits on ONE row now that Export is gone (${withStar.rows} rows)`);
ok(withStar.bold === "5", `the number itself is bold — it is what you are reading (${JSON.stringify(withStar.bold)})`);

// CANCEL PUTS EVERYTHING BACK — and says so in words that cannot be read as
// "the art is gone".
await p.evaluate(() => document.querySelector("#discard-btn").click());
await p.waitForTimeout(1600);
const after = await bar();
const toast = await p.evaluate(() => document.querySelector(".toast, #toast")?.textContent ?? "");
console.log("after Cancel:", JSON.stringify({ hidden: after.hidden, toast }));
ok(after.hidden, "Cancel clears the pending changes and the bar goes away");
ok(!/discard/i.test(toast), `and its message never says "discard" ("${toast}")`);
ok(await p.evaluate(() => document.querySelectorAll(".card, .obj-title, h1").length > 0),
  "with the page still full of art — Cancel touched none of it");

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL SAVEBAR CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
