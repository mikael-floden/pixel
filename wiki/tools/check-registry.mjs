// WHICH REGISTRY THE PAGE READS — the deployed one or the repo's, whichever is
// NEWER.
//
// The wiki paints from the image's own data.json and then, for the Game Master,
// swaps in the copy COMMITTED in the repo so unreleased art is current. That
// copy is only as fresh as the last time the wiki agent ran build.mjs and
// pushed; the image rebuilds its own from the tree at deploy time. So when
// another domain changes something and deploys first, the swap was adopting the
// OLDER of the two and walking the page back in time.
//
// Measured 2026-09-05: he re-filed 24 cliff pieces out of MOUNTAIN_WALL, the
// scenery agent applied every one, the deployed registry said NATURE — and the
// page still listed them under Mountain wall, because the committed copy was
// from the night before. "Is this your bug or a scenery bug?" Mine.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const REPO = process.env.WIKI_REPO ?? "http://127.0.0.1:8903/";
const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
/** Load the page with the repo copy doctored to `when`, and report what it read. */
const run = async (when, mark) => {
  const ctx = await b.newContext({ viewport: { width: 412, height: 900 } });
  const p = await ctx.newPage();
  await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
  // The REPO copy — the one the swap fetches — with its own timestamp and a
  // marker only it carries, so the assertion cannot mistake one for the other.
  await p.route(/\/wiki\/site\/data\.json(\?|$)/, async (r) => {
    // The REPO copy only: the deployed one is served from /assets/.
    if (/\/assets\//.test(r.request().url())) { await r.continue(); return; }
    const doc = JSON.parse(JSON.stringify(D));
    doc.generated_at = when;
    doc.git_sha = "repocopy1";
    (doc.domains.objects ?? []).forEach((o) => { if (o.id) o.name = `${mark} ${o.name}`; });
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(doc) });
  });
  await p.addInitScript((repo) => {
    localStorage.setItem("wiki-admin-token", "gate");
    localStorage.setItem("ml-staging-base", repo);
  }, REPO);
  await p.goto(`${W}#/objects`, { waitUntil: "load" });
  await p.waitForTimeout(4000);
  const seen = await p.evaluate(() => ({
    generated: window.__wiki?.state?.data?.generated_at ?? null,
    sha: window.__wiki?.state?.data?.git_sha ?? null,
    stampDate: document.querySelector(".stamp-date")?.textContent ?? null,
    firstName: (window.__wiki?.state?.data?.domains?.objects ?? [])[0]?.name ?? null,
  }));
  await ctx.close();
  return seen;
};

const deployed = D.generated_at;
const older = new Date(Date.parse(deployed) - 36e5 * 12).toISOString();
const newer = new Date(Date.parse(deployed) + 36e5).toISOString();

const a = await run(older, "STALE");
console.log("repo copy 12h older:", JSON.stringify(a));
ok(a.generated === deployed && !/^STALE/.test(a.firstName ?? ""),
  `an older repo copy is NOT adopted — the page keeps the deployed registry (${a.generated})`);
ok(a.stampDate && !/^STALE/.test(a.firstName ?? ""), `and the stamp names what it is actually reading (${a.stampDate})`);

const c = await run(newer, "FRESH");
console.log("repo copy 1h newer:", JSON.stringify(c));
ok(c.generated === newer && /^FRESH/.test(c.firstName ?? ""),
  `a newer repo copy IS adopted — unreleased art still reaches him (${c.generated})`);
ok(c.sha === "repocopy1" || (c.sha ?? "").length >= 7, `and it is stamped as the registry it read (${c.sha})`);

await b.close();
console.log(fails.length ? `\nREGISTRY CHECKS FAILED (${fails.length})` : "\nALL REGISTRY CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
