// THE SCENERY REVIEW QUEUE: sort by newest, filter by verdict, and the choice
// HOLDS when you walk into a piece.
//
// Maintainer, 2026-08-13: "As an admin I should be able to sort the Scenery on
// the latest generated content first or/and with a approved/unapproved filter.
// This is to make it easier to review. If I put a filter at the overview that
// filter should hold when clicking on a Scenery and press next next next. It
// must also be visible that the filter is active while inside the scenery
// entity page (so I understand why not all scenery is available when pressing
// next)."
//
// The verdicts are INJECTED here rather than clicked: the live store is the
// maintainer's own review data, a gate must never write to it, and at the time
// this was written every piece was unreviewed anyway (the scenery agent had
// just culled and regenerated the domain, so the standing verdicts pointed at
// paths that no longer existed). Injecting is also the only way to prove the
// filters NARROW rather than merely render.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

// THE PIECES THAT ACTUALLY EXIST, which is not the same set the build listed.
// The scenery agent deletes what he rejects, and the manifest is only as fresh
// as the last build — so the wiki drops a piece the moment its art 404s
// (maintainer 2026-08-16: "why is the object not removed then removed?").
// Measured while writing this: 828 listed, 19 already deleted from disk. A
// gate that models the manifest instead of the disk is asserting a page that
// cannot exist.
const REPO = new URL("../../", import.meta.url);
const onDisk = (o) => !o.preview || existsSync(new URL(o.preview, REPO));
const listed = D.domains.objects ?? [];
const objs = listed.filter(onDisk);
if (listed.length !== objs.length) console.log(`(${listed.length - objs.length} of ${listed.length} listed pieces are deleted on disk — excluded, exactly as the page excludes them)`);
// Newest first, by the build's own `added` — the order the page must produce.
const byNew = [...objs].sort((a, b) => String(b.added ?? "").localeCompare(String(a.added ?? "")));
ok(objs.every((o) => o.added), `every piece carries an added date (${objs.filter((o) => !o.added).length} without)`);
ok(new Set(objs.map((o) => o.added)).size > 5,
  `and the dates actually differ, or "newest first" is meaningless (${new Set(objs.map((o) => o.added)).size} distinct)`);

// Three approved, four rejected, the rest unreviewed — chosen from across the
// newest order so the filters cannot pass by accident of position.
const APPROVED = [byNew[1], byNew[5], byNew[40]].map((o) => o.path);
const REJECTED = [byNew[0], byNew[6], byNew[41], byNew[80]].map((o) => o.path);
// Each verdict is dated AFTER the art it judges — a verdict older than its
// piece now means "about the art that used to be here", which is a different
// case entirely and is exercised on its own below.
const entries = {};
const after = (path) => new Date(Date.parse(objs.find((o) => o.path === path).added) + 3600e3).toISOString();
for (const p of APPROVED) entries[p] = { status: "approved", updated_at: after(p) };
for (const p of REJECTED) entries[p] = { status: "rejected", updated_at: after(p) };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await (await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
let injected = 0;
await p.route("**/api/live/state", async (route) => {
  const j = JSON.parse(await (await route.fetch()).text());
  const f = j.feedback ?? (j.feedback = {});
  f.objects = { format: "pixel-wiki-feedback@1", domain: "objects", updated_at: "", entries };
  injected++;
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
});
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  // An admin reads the REPO, not the image (wiki.js useStagingRoot, 2026-08-14).
  // The sandbox blocks browser egress, so point the staging base at this same
  // server's /assets — the identical code path, resolvable offline.
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});

// ALWAYS reload. A hash-only goto does not re-navigate, so the live state —
// including the verdicts injected above — is never refetched, and assertions
// about them pass while describing a page that never saw them.
// EVERY CARD'S ART MUST BE REQUESTED BEFORE THE GRID CAN BE JUDGED. The wiki
// drops a piece the moment its own sprite 404s, and a LAZY image that was
// never scrolled into view cannot 404 — so a page sampled straight after load
// still shows deleted pieces, and the count settles later, as the reviewer
// scrolls. Flipping the whole grid to eager reaches that end state in one
// step; each drop re-renders, so it is re-applied until the count stops
// moving.
const settleGrid = async () => {
  let last = -1;
  for (let i = 0; i < 12; i++) {
    await p.evaluate(() => document.querySelectorAll('img[loading="lazy"]').forEach((im) => { im.loading = "eager"; }));
    await p.waitForTimeout(600);
    const n = await p.evaluate(() => document.querySelectorAll("a.card").length);
    if (n === last) return;
    last = n;
  }
};
const go = async (hash) => {
  await p.goto(`${W}${hash}`, { waitUntil: "load" });
  await p.reload({ waitUntil: "load" });
  await p.waitForTimeout(1700);
  await settleGrid();
};
// Chip ids repeat across the three bars ("all" is a type AND a review status),
// so every pick names its bar by storage key.
const pick = async (v, bar = "wiki-obj-filter") => {
  await p.evaluate(([s, b]) => document.querySelector(`[data-bar="${b}"] [data-sort="${s}"]`)?.click(), [v, bar]);
  await p.waitForTimeout(800);
  await settleGrid();   // a filter switch renders a fresh grid of lazy images
};
const overview = () => p.evaluate(() => ({
  bars: [...document.querySelectorAll(".sortbar")].map((r) => [...r.querySelectorAll("button")].map((x) => (x.classList.contains("sel") ? "*" : "") + x.textContent).join(" ")),
  heads: document.querySelectorAll("h2").length,
  names: [...document.querySelectorAll(".card-name")].map((x) => x.textContent),
  note: [...document.querySelectorAll("p.muted")].map((x) => x.textContent).find((t) => /of \d+ pieces/.test(t)) ?? "",
}));

await go("#/objects");
ok(injected > 0, `the injected verdicts really were served (${injected}x)`);
const base = await overview();
// Three rows since 2026-08-14: what KIND of thing (everyone), how it is
// ordered, and where it stands in review (admin).
ok(base.bars.length === 3, `admin gets the type, sort and review rows (${base.bars.join(" | ")})`);
ok(base.heads > 3, `the default is still the grouped view (${base.heads} group headings)`);
ok(base.names.length === objs.length, `showing everything by default (${base.names.length}/${objs.length})`);

// --- newest first
await pick("newest", "wiki-obj-sort");
const nw = await overview();
console.log("newest:", JSON.stringify({ heads: nw.heads, first: nw.names.slice(0, 3) }));
ok(nw.heads === 0, "newest-first drops the group headings — the order cuts across groups");
ok(JSON.stringify(nw.names) === JSON.stringify(byNew.map((o) => o.name)),
  `and the grid is in exact added-date order (first: ${nw.names[0]})`);

// --- each verdict filter narrows to exactly its set
for (const [f, want] of [["approved", APPROVED], ["rejected", REJECTED]]) {
  await pick(f);
  const v = await overview();
  const wantNames = byNew.filter((o) => want.includes(o.path)).map((o) => o.name);
  ok(JSON.stringify(v.names) === JSON.stringify(wantNames),
    `"${f}" shows exactly those ${want.length} (${v.names.length} shown)`);
  ok(/of \d+ pieces/.test(v.note), `and says how many of the domain that is — "${v.note.slice(0, 46)}…"`);
}
await pick("unreviewed");
const un = await overview();
ok(un.names.length === objs.length - APPROVED.length - REJECTED.length,
  `"unreviewed" is everything not yet judged (${un.names.length} = ${objs.length} − ${APPROVED.length + REJECTED.length})`);

// --- A VERDICT BELONGS TO THE ART IT WAS GIVEN ON.
// The scenery agent deletes rejected pieces and regenerates them AT THE SAME
// PATH, and the feedback store is keyed by path — so new art inherited the old
// piece's judgement and vanished from the review queue. The maintainer caught
// it as "How can only 3 scenery items be unreviewed when the scenery-agent
// have been working for hours on new content?" — 20 of the 237 were carrying
// his verdict on art he had never seen.
{
  const victim = byNew.find((o) => !APPROVED.includes(o.path) && !REJECTED.includes(o.path) && o.added);
  const before = new Date(Date.parse(victim.added) - 3600e3).toISOString();  // judged an HOUR before this art arrived
  entries[victim.path] = { status: "rejected", updated_at: before };
  await go("#/objects");
  await pick("all");
  const seen = await p.evaluate((id) => {
    const card = [...document.querySelectorAll(".card")].find((c) => c.getAttribute("href") === `#/objects/${id}`);
    return { badges: [...card.querySelectorAll(".card-badges .pill")].map((x) => x.textContent) };
  }, victim.id);
  ok(seen.badges.includes("re-review") && !seen.badges.includes("remove"),
    `a verdict older than the art reads "re-review", never as a live decision (${seen.badges.join(", ") || "none"})`);
  await pick("rejected");
  const rej = await overview();
  ok(!rej.names.includes(victim.name),
    `and it is NOT counted as rejected — that call was about a piece that no longer exists (${rej.names.length} shown)`);
  await pick("unreviewed");
  const un2 = await overview();
  ok(un2.names.includes(victim.name), "it is back in the review queue, which is the whole point");
  ok(un2.names.length === objs.length - APPROVED.length - REJECTED.length,
    `the queue counts it exactly once (${un2.names.length})`);
  await go(`#/objects/${victim.id}`);
  // The notice rides in the header's FIXED-HEIGHT pill row, not on a line of
  // its own: as its own line it grew the header only for stale pieces, so
  // paging ‹ › moved the animation viewer 22px whenever one went by. The
  // sentence is the pill's tooltip.
  const badge = await p.evaluate(() => {
    const pill = [...document.querySelectorAll(".obj-sub .pill")].find((x) => x.textContent === "re-review");
    return pill ? { text: pill.textContent, title: pill.getAttribute("title") } : null;
  });
  console.log("stale badge:", JSON.stringify(badge));
  ok(!!badge && /regenerated since/.test(badge.title ?? ""),
    "and its own page flags it beside the title, explaining itself on hover");
  delete entries[victim.path];

  // A VERDICT IS ABOUT BYTES, NOT ABOUT A DATE (maintainer 2026-08-14: "Why
  // do I have to see and review items I have already reviewed?" — 129 pieces
  // re-queued because each deploy INVENTED dates for pieces its committed
  // cache had not met, post-dating them past his fresh verdicts). New
  // verdicts record the sprite hash they judged; the hash outranks any date,
  // and a guessed date is never allowed to call a legacy verdict stale.
  const v2 = byNew.find((o) => !APPROVED.includes(o.path) && !REJECTED.includes(o.path) && o.artHash);
  const v3 = byNew.find((o) => o !== v2 && !APPROVED.includes(o.path) && !REJECTED.includes(o.path) && o.artHash);
  const hourBefore = (o) => new Date(Date.parse(o.added) - 3600e3).toISOString();
  entries[v2.path] = { status: "approved", updated_at: hourBefore(v2), art: v2.artHash };   // "older" date, SAME bytes
  entries[v3.path] = { status: "approved", updated_at: after(v3.path), art: "0000deadbeef0000" }; // newer date, DIFFERENT bytes
  await go("#/objects");
  await pick("all");
  const hashSeen = await p.evaluate(([a, b]) => {
    const badge = (id) => [...(document.querySelector(`[href="#/objects/${id}"]`)?.querySelectorAll(".card-badges .pill") ?? [])].map((x) => x.textContent);
    return { same: badge(a), changed: badge(b) };
  }, [v2.id, v3.id]);
  console.log("hash rule:", JSON.stringify(hashSeen));
  ok(hashSeen.same.includes("approved") && !hashSeen.same.includes("re-review"),
    "a verdict whose recorded hash still matches is NEVER re-review, whatever the dates say");
  ok(hashSeen.changed.includes("re-review") && !hashSeen.changed.includes("approved"),
    "and one whose recorded hash differs IS re-review, even with a newer date");
  delete entries[v2.path]; delete entries[v3.path];

  // An INVENTED date (addedGuess — the deploy image has no git) proves
  // nothing: a legacy hashless verdict older than it must not re-queue.
  const v4 = byNew.find((o) => !APPROVED.includes(o.path) && !REJECTED.includes(o.path));
  entries[v4.path] = { status: "approved", updated_at: "2026-08-01T00:00:00Z" };  // far before any date
  await p.route("**/wiki/site/data.json", async (route) => {
    const j = JSON.parse(await (await route.fetch()).text());
    const t = j.domains.objects.find((x) => x.id === v4.id);
    t.addedGuess = true; delete t.artHash;                       // exactly what a deploy-stamped piece looks like
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
  });
  await go("#/objects");
  const g = await p.evaluate((id) =>
    [...(document.querySelector(`[href="#/objects/${id}"]`)?.querySelectorAll(".card-badges .pill") ?? [])].map((x) => x.textContent), v4.id);
  console.log("guessed date:", JSON.stringify(g));
  ok(g.includes("approved") && !g.includes("re-review"),
    "a guessed date never overrules a verdict — the deploy-restamp bug stays dead");
  await p.unroute("**/wiki/site/data.json");
  delete entries[v4.path];
  await go("#/objects");                   // back to a page that HAS the sort bar
}

// --- PARTLY REVIEWED: STARTED, NOT FINISHED.
//
// Maintainer 2026-08-15: "it's hard for me to find scenery objects that need
// partly reviewed items ... But here is an important detail. If I haven't
// started reviewing individual states that means I don't care and this object
// is not 'partly reviewed'. What is partly reviewed is an object I HAVE
// started to rate individual states/animations/directions but have not
// reviewed everyone yet."
//
// So the set is exactly {some facets judged} MINUS {all facets judged}, and an
// untouched piece — however many states it has — is never in it. That
// exclusion is the whole point: 673 of 760 pieces are untouched, and a filter
// that swept them in would be the unreviewed queue under a second name.
{
  const facets = (o) => Object.entries(o.animations ?? {})
    .flatMap(([st, a]) => Object.keys(a.dirs ?? {}).map((d) => `${o.path}#${st}#${d}`));
  const many = objs.filter((o) => facets(o).length >= 4);
  const [started, finished, untouched] = [many[0], many[1], many[2]];
  for (const f of facets(started).slice(0, 2)) entries[f] = { status: "approved", updated_at: "2026-08-15T00:00:00Z" };
  entries[facets(started)[2]] = { rating: 4, updated_at: "2026-08-15T00:00:00Z" };   // a rating counts as started
  for (const f of facets(finished)) entries[f] = { status: "approved", updated_at: "2026-08-15T00:00:00Z" };
  // `untouched` gets nothing at all — that is the case being asserted.
  await go("#/objects");
  await pick("all");
  const chips = await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-obj-filter"] button')].map((x) => x.textContent));
  console.log("filter chips:", JSON.stringify(chips));
  ok(chips.some((c) => /^partly reviewed \d+$/.test(c)), `there is a partly-reviewed chip, with its own count (${chips.find((c) => /partly/.test(c))})`);
  await pick("partial");
  const shown = await p.evaluate(() => ({
    ids: [...document.querySelectorAll(".card")].map((c) => c.getAttribute("href").split("/").pop()),
    badges: [...document.querySelectorAll(".card .card-badges")].map((x) => x.textContent),
  }));
  console.log("partly reviewed:", JSON.stringify(shown.ids.slice(0, 6)));
  ok(shown.ids.includes(started.id), `a piece with SOME of its states judged is listed (${started.id})`);
  ok(!shown.ids.includes(finished.id), `a piece with ALL of them judged is not (${finished.id})`);
  ok(!shown.ids.includes(untouched.id),
    `and an UNTOUCHED piece is not — "if I haven't started reviewing individual states that means I don't care" (${untouched.id})`);
  ok(shown.badges.some((b2) => new RegExp(`3/${facets(started).length}`).test(b2)),
    `the card says how far in you are (${shown.badges.find((b2) => /\d+\/\d+/.test(b2))})`);
  // A rating with no verdict is still "started" — he said rate.
  const ratingOnly = objs.find((o) => facets(o).length >= 4 && o !== started && o !== finished && o !== untouched);
  entries[facets(ratingOnly)[0]] = { rating: 5, updated_at: "2026-08-15T00:00:00Z" };
  await go("#/objects");
  await pick("partial");
  const withRating = await p.evaluate(() => [...document.querySelectorAll(".card")].map((c) => c.getAttribute("href").split("/").pop()));
  ok(withRating.includes(ratingOnly.id), `starring one state counts as starting on it (${ratingOnly.id})`);
  // Finishing the last facet drops the piece out of the set.
  for (const f of facets(started)) entries[f] = { status: "approved", updated_at: "2026-08-15T00:00:00Z" };
  await go("#/objects");
  await pick("partial");
  const after2 = await p.evaluate(() => [...document.querySelectorAll(".card")].map((c) => c.getAttribute("href").split("/").pop()));
  console.log("after finishing it:", JSON.stringify(after2.slice(0, 6)));
  ok(!after2.includes(started.id), "finishing the last state takes the piece out of the set");
  for (const o of [started, finished, untouched, ratingOnly]) for (const f of facets(o)) delete entries[f];

  // THE REVIEW LOOP, END TO END (maintainer 2026-08-15): "I reject one state
  // and the AI generates a new state. The new filter will now let me see the
  // tree that has a new state that still needs review."
  //
  // A finished piece: every state judged, every verdict stamped with THAT
  // state's own art hash. Then one state is regenerated — the file changes, so
  // the build publishes a different `h` for that clip — and the verdict about
  // the old picture must stop counting. The piece is partly reviewed again.
  {
    const target = many.find((o) => facets(o).length >= 4 && o !== started && o !== finished);
    const fl = facets(target);
    const clipH = (f) => { const [, st, dir] = f.split("#"); return target.animations[st].dirs[dir].h; };
    for (const f of fl) entries[f] = { status: "approved", art: clipH(f), updated_at: "2026-08-15T00:00:00Z" };
    await go("#/objects");
    await pick("partial");
    const before = await p.evaluate(() => [...document.querySelectorAll(".card")].map((c) => c.getAttribute("href").split("/").pop()));
    ok(!before.includes(target.id), `a piece judged state by state, with matching stamps, is finished (${target.id})`);
    // The scenery agent re-rolls ONE state: same path, new bytes, new hash.
    const [, rst, rdir] = fl[1].split("#");
    await p.route("**/wiki/site/data.json", async (route) => {
      const j = JSON.parse(await (await route.fetch()).text());
      const t = j.domains.objects.find((x) => x.id === target.id);
      t.animations[rst].dirs[rdir].h = "cafebabe12345678";      // regenerated art
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
    });
    await p.reload({ waitUntil: "load" });
    await p.waitForTimeout(1600);
    await pick("partial");
    const after3 = await p.evaluate(() => ({
      ids: [...document.querySelectorAll(".card")].map((c) => c.getAttribute("href").split("/").pop()),
      badge: [...document.querySelectorAll(".card")].map((c) => c.querySelector(".card-badges")?.textContent),
    }));
    console.log("after one state was regenerated:", JSON.stringify(after3.ids.slice(0, 4)), JSON.stringify(after3.badge.slice(0, 4)));
    ok(after3.ids.includes(target.id),
      `regenerating one state brings the piece back to partly reviewed (${target.id})`);
    ok(after3.badge.some((b2) => new RegExp(`${fl.length - 1}/${fl.length}`).test(b2 ?? "")),
      `and the card counts it as one short (${fl.length - 1}/${fl.length})`);
    // The chip on its page must not still read settled for that state.
    await go(`#/objects/${target.id}`);
    const chip = await p.evaluate((st) => {
      const b2 = [...document.querySelectorAll(".seg-states button")].find((x) => x.title.toLowerCase().startsWith(st.replace(/_/g, " ")));
      return b2 ? { cls: b2.className, title: b2.title } : null;
    }, rst);
    console.log("its chip:", JSON.stringify(chip));
    ok(chip && !/judged-ok|judged-no/.test(chip.cls),
      `the state's own chip drops its colour — it is unreviewed art again (${chip?.cls || "none"})`);
    ok(/regenerated/.test(chip?.title ?? ""), `and says why on hover ("${chip?.title}")`);
    await p.unroute("**/wiki/site/data.json");
    for (const f of fl) delete entries[f];
    await go("#/objects");
  }
  await pick("all");
}

// --- THE FILTER HOLDS INSIDE A PIECE. This is the request's core: ‹ › must
//     walk the filtered set, in the filtered order, and say that it is.
await pick("approved");
await p.evaluate(() => document.querySelector(".card").click());
await p.waitForTimeout(1500);
const walk = [];
for (let i = 0; i < 4; i++) {                        // 4 steps over 3 pieces = wraps
  walk.push(await p.evaluate(() => ({
    name: document.querySelector(".obj-title")?.getAttribute("title"),
    count: document.querySelector(".detail-count")?.textContent?.trim(),
    note: document.querySelector(".queue-note")?.textContent ?? null,
    outside: !!document.querySelector(".queue-note .pill.err"),
  })));
  await p.evaluate(() => [...document.querySelectorAll("a,button")].find((x) => x.textContent.trim() === "›")?.click());
  await p.waitForTimeout(430);
}
console.log("walk:", JSON.stringify(walk.map((w) => `${w.count} ${w.name}`)));
const approvedNames = byNew.filter((o) => APPROVED.includes(o.path)).map((o) => o.name);
ok(walk.every((w) => w.count.endsWith(`/ ${APPROVED.length}`)),
  `the pager counts only the filtered set (${walk.map((w) => w.count).join(", ")})`);
ok(walk.slice(0, 3).every((w, i) => w.name === approvedNames[i]),
  "and steps through them in the filtered order");
ok(walk[3].name === walk[0].name, "wrapping past the end returns to the first of the set, not the domain");
ok(walk.every((w) => w.note && /filtered/.test(w.note) && /approved only/.test(w.note)),
  `every page says WHY next is limited — "${walk[0].note}"`);
ok(walk.every((w) => !w.outside), "and none of them is flagged as outside the filter");

// A piece reached from outside the filter keeps a working pager and says so —
// otherwise Next silently vanishes on any link or search hit.
const stray = byNew.find((o) => REJECTED.includes(o.path));
await go(`#/objects/${stray.id}`);
const s = await p.evaluate(() => ({
  nav: !!document.querySelector(".detail-nav"),
  count: document.querySelector(".detail-count")?.textContent?.trim(),
  outside: !!document.querySelector(".queue-note .pill.err"),
  note: document.querySelector(".queue-note")?.textContent ?? null,
}));
console.log("stray:", JSON.stringify(s));
ok(s.nav && s.count === `1 / ${APPROVED.length + 1}`, `a piece outside the filter keeps its pager (${s.count})`);
ok(s.outside, "and is labelled as outside the current filter");

// --- AN EMPTY FILTER MUST NEVER READ AS MISSING ART.
// The filter is sticky, and it can legitimately empty the page: the maintainer
// judged the whole domain, the scenery agent deleted what he rejected, and
// "needs review" fell to 0 — so the Scenery page he returned to was blank and
// he reported "I can't see more scenery art" (2026-08-13). Every chip now
// carries its count, and an empty result explains itself and offers the way
// out. Simulated by approving EVERYTHING, which is the state he was in.
{
  const saved = { ...entries };
  for (const o of objs) entries[o.path] = { status: "approved", updated_at: after(o.path) };
  await go("#/objects");
  await pick("unreviewed");
  const e = await p.evaluate(() => ({
    cards: document.querySelectorAll(".card").length,
    msg: document.querySelector(".empty-queue p")?.textContent ?? null,
    btn: document.querySelector(".empty-queue button")?.textContent ?? null,
    // The REVIEW chips: last bar. A type bar was added above the sort bar on
    // 2026-08-14, so counting from the top would read the wrong row.
    chips: [...([...document.querySelectorAll(".sortbar")].pop()?.querySelectorAll("button") ?? [])].map((x) => x.textContent),
  }));
  console.log("empty queue:", JSON.stringify(e));
  ok(e.cards === 0 && !!e.msg, "an empty filter says WHY it is empty instead of showing a blank page");
  ok(/still here/.test(e.msg), `and says the art is not gone — "${e.msg?.slice(0, 60)}…"`);
  ok(e.chips.some((c) => c === `all ${objs.length}`) && e.chips.some((c) => c === "needs review 0"),
    `every chip carries its count, so the pieces are never unaccounted for (${e.chips.join(" | ")})`);
  ok(!!e.btn && new RegExp(`${objs.length}`).test(e.btn), `and one button restores the full domain ("${e.btn}")`);
  await p.evaluate(() => document.querySelector(".empty-queue button").click());
  await p.waitForTimeout(600);
  const back = await p.evaluate(() => ({ cards: document.querySelectorAll(".card").length, sel: [...document.querySelectorAll(".sortbar-btn.sel")].map((x) => x.textContent) }));
  ok(back.cards === objs.length && back.sel.some((s) => s.startsWith("all")),
    `pressing it really does bring everything back (${back.cards} pieces)`);
  // Put back exactly what the next section expects: the real verdicts, the
  // "approved" filter, and a piece page to reload.
  for (const k of Object.keys(entries)) delete entries[k];
  Object.assign(entries, saved);
  await p.evaluate(() => localStorage.setItem("wiki-obj-filter", "approved"));
  await go(`#/objects/${stray.id}`);
}

// --- survives a reload, and the public never sees any of it
await p.reload({ waitUntil: "load" });
await p.waitForTimeout(1500);
ok(!!(await p.evaluate(() => document.querySelector(".queue-note"))), "the filter survives a reload");
const pub = await (await b.newContext({ viewport: { width: 393, height: 851 } })).newPage();
await pub.goto(`${W}#/objects`, { waitUntil: "load" });
await pub.waitForTimeout(1700);
// The visitor's grid needs the same settling as the admin's — a deleted piece
// leaves their list too (a card with no picture is no use to anyone).
for (let i = 0, last = -1; i < 12; i++) {
  await pub.evaluate(() => document.querySelectorAll('img[loading="lazy"]').forEach((im) => { im.loading = "eager"; }));
  await pub.waitForTimeout(600);
  const n = await pub.evaluate(() => document.querySelectorAll("a.card").length);
  if (n === last) break;
  last = n;
}
const pv = await pub.evaluate(() => ({ bars: document.querySelectorAll(".sortbar").length, cards: document.querySelectorAll(".card").length, note: !!document.querySelector(".queue-note") }));
console.log("public:", JSON.stringify(pv));
// The public keeps the type bar — it is a way to find things, not a review
// tool — and gets neither the sort nor the review-status row.
ok(pv.bars === 1 && !pv.note, `the visitor gets the type bar only (${pv.bars} bars)`);
ok(await pub.evaluate(() => !!document.querySelector('[data-bar="wiki-obj-type"]')
  && !document.querySelector('[data-bar="wiki-obj-filter"]')), "and it is the type row, not a review row");
ok(pv.cards === objs.length, `and the public still sees the whole domain that still exists (${pv.cards}/${objs.length})`);

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL QUEUE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
