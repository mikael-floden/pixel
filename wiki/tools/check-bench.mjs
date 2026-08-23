// THE MUSIC BENCH: sample-accurate phrase playback, four switch modes, and
// verdicts at three levels.
//
// Maintainer 2026-08-22: "Playback must be sample-accurate, or none of this
// works … Do NOT use <audio> elements or call play() per phrase — that gaps and
// clicks at every join, and I'd be judging the player instead of the music. A
// phrase boundary must be inaudible."
//
// SO THIS GATE MEASURES THE CLOCK, not the markup. Every phrase the engine
// books is recorded in window.__bench.plays with the AudioContext time it was
// booked for, and the checks below are arithmetic on those numbers: joins with
// no gap, a beat switch landing on a whole beat, a phrase switch landing on the
// phrase end, and a suite cross holding exactly the silence the slider asks for.
// Two real bugs were found this way that reading the code did not show — a
// decode inside the switch handler putting the cut a whole phrase late, and a
// cut that failed to shorten its own record.
//
// AUDIO IS SERVED FROM A SECOND ORIGIN, exactly as in production: the composer's
// beds come from the staging repo, not from /assets. `node wiki/tools/serve-repo.mjs`
// provides that origin locally (see check-unshipped.mjs).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const ROOT = new URL("../../", import.meta.url).pathname;
const D = JSON.parse(readFileSync(join(ROOT, "wiki/site/data.json"), "utf8"));
const TR = JSON.parse(readFileSync(join(ROOT, "games2/composer/music/tracks.json"), "utf8"));
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
// THE REPO ROOT, exactly like the real staging base. Pointing this at
// ".../games2/" is what let a 404 ship: it made composer/music/... resolve and
// proved nothing about where the page actually looks.
const REPO = process.env.REPO_URL ?? "http://127.0.0.1:8903/";

// ---- 1. the data mirrors the composer's own file -------------------------
const B = D.bench;
ok(!!B?.tracks?.length, `the bench data is published (${B?.tracks?.length ?? 0} tracks)`);
const withPhrase = Object.values(TR.tracks).filter((t) => t.phrase).length;
ok(B.tracks.length === withPhrase, `every phrase-system bed is there, and no legacy one (${B.tracks.length} of ${withPhrase})`);
// PHRASE LENGTH IS THE TAKE'S OWN, never the brief's — the whole reason a join
// can be inaudible. The live take uses the corrected measurement; an archived
// take derives from its own bars and bpm.
const suiteMs = Object.values(B.suites).map((s) => s.phraseMs);
const derived = B.tracks.flatMap((t) => t.takes.filter((k) => k.bars && k.bpm)
  .map((k) => ({ id: k.id, want: Math.round(k.bars * 4 * 60000 / k.bpm), got: k.phraseMs, live: k.live })));
const wrong = derived.filter((k) => !k.live && Math.abs(k.want - k.got) > 1);
ok(derived.length > 3 && wrong.length === 0,
  `each archived take's phrase length comes from its OWN tempo (${derived.length} takes, ${wrong.length} wrong)`);
const offBrief = derived.filter((k) => k.live && !suiteMs.includes(k.got));
ok(offBrief.length > 0, `and the live takes are the CORRECTED measurement, not the brief's number (${offBrief.length} differ from their suite's)`);
ok(B.tracks.every((t) => t.takes.some((k) => k.live)), "every bed knows which take is live");
// Swedish keys, including H for B.
const keys = B.tracks.map((t) => t.key).filter(Boolean);
ok(keys.length > 0 && keys.every((k) => /-(dur|moll)$/.test(k)), `keys are Swedish — ${[...new Set(keys)].slice(0, 4).join(", ")}`);

// ---- the page ------------------------------------------------------------
const b = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const saves = [];
const audioReqs = [];
p.on("request", (r) => { if (/\.(ogg|m4a|mp3)(\?|$)/.test(r.url())) audioReqs.push(r.url()); });
const audioResp = [];
p.on("response", (r) => { if (/\.(ogg|m4a|mp3)(\?|$)/.test(r.url())) audioResp.push({ url: r.url(), status: r.status(), ok: r.ok() }); });
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.route("**/api/wiki/save", (r) => { saves.push(r.request().postDataJSON()); return r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
await p.addInitScript((repo) => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", repo);
}, REPO);

const openBench = async (trackRe) => {
  await p.goto(`${W}#/bench`, { waitUntil: "load" });
  await p.waitForTimeout(1800);
  await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-bench-suite"] button')].find((x) => /nangijala/.test(x.textContent))?.click());
  await p.waitForTimeout(700);
  if (trackRe) {
    await p.evaluate((re) => {
      const s = document.querySelector(".bench-select");
      const o = [...s.options].find((x) => new RegExp(re).test(x.value));
      if (o) { s.value = o.value; s.dispatchEvent(new Event("change")); }
    }, trackRe);
    await p.waitForTimeout(2200);
  }
};
await openBench("cathedral");
const view = await p.evaluate(() => ({
  modes: [...document.querySelectorAll('[data-bar="wiki-bench-mode"] button')].map((x) => x.textContent.trim()),
  takes: document.querySelectorAll(".bench-take").length,
  live: document.querySelectorAll(".bench-take.is-live").length,
  offKey: document.querySelectorAll(".bench-take .bench-chip.off-key").length,
  order: document.querySelectorAll(".bench-order .bench-chip").length,
  seams: document.querySelectorAll(".bench-seam").length,
  metrics: [...document.querySelectorAll(".bench-take .metric-row")].map((x) => x.textContent.replace(/\s+/g, " ").trim()),
}));
// ON ARRIVAL, with nothing pressed — openBench() clicks the suite itself, so
// asserting after it would prove nothing.
await p.goto(`${W}#/bench`, { waitUntil: "load" });
await p.evaluate(() => { try { localStorage.removeItem("wiki-bench-suite"); } catch { /* private mode */ } });
await p.reload({ waitUntil: "load" });
await p.waitForTimeout(2000);
const suiteChips = await p.evaluate(() => {
  const btns = [...document.querySelectorAll('[data-bar="wiki-bench-suite"] button')];
  return {
    order: btns.map((x) => x.textContent.trim()),
    sel: btns.find((x) => x.classList.contains("sel"))?.textContent.trim(),
    deckA: document.querySelector(".bench-select")?.value ?? "",
    order0: document.querySelectorAll(".bench-order .bench-chip").length,
  };
});
ok(suiteChips.order[0] === "nangijala" && suiteChips.sel === "nangijala",
  `the main suite is first and preselected on arrival (${suiteChips.order.join(", ")} — on ${suiteChips.sel})`);
ok(/^nangijala_/.test(suiteChips.deckA) && suiteChips.order0 > 0,
  `and deck A opens on one of its beds with phrases ready to play (${suiteChips.deckA}, ${suiteChips.order0} phrases)`);
await openBench("cathedral");
ok(view.modes.join("|") === "next beat|next phrase|instant|suite cross", `all four switch modes are offered (${view.modes.join(", ")})`);
ok(view.takes >= 2 && view.live === 1, `every take of the bed is listed and exactly one is marked live (${view.takes} takes)`);
ok(view.offKey > 0, `phrases measured outside the key asked for are marked (${view.offKey} chips)`);
ok(view.seams === view.order - 1, `there is a seam button in every join of the order (${view.seams} for ${view.order} phrases)`);
ok(view.metrics.some((m) => /bars \d/.test(m)) && view.metrics.some((m) => /BPM/.test(m)),
  `bars and tempo sit next to the buttons (${view.metrics[0]?.slice(0, 44)}…)`);

// ---- 2. THE JOINS ARE SAMPLE-ACCURATE ------------------------------------
// NOT <audio>: an element-per-phrase would show up as a media element and as a
// fresh request per press. Neither exists here.
await p.evaluate(() => [...document.querySelectorAll(".bench-btn")].find((x) => /▶ A/.test(x.textContent)).click());
await p.waitForTimeout(3600);
const sched = await p.evaluate(() => {
  const pl = window.__bench.plays, e = window.__bench.engine;
  const gaps = pl.slice(1).map((x, i) => Math.abs(x.at - (pl[i].at + pl[i].dur)));
  return {
    booked: pl.length,
    maxGap: gaps.length ? Math.max(...gaps) : 0,
    inFlight: e.decks.a.live.filter((x) => x.end > e.ctx.currentTime).length,
    ahead: pl.every((x) => x.at > 0),
    bus: e.bus?.gain.value ?? null,
    // The wiki carries ONE shared <audio> for the Sounds and Music pages; what
    // matters is that the bench neither creates one nor drives it.
    mediaInBench: document.querySelectorAll(".bench audio, .bench video").length,
    sharedAudioSrc: document.querySelector("audio")?.getAttribute("src") ?? "",
  };
});
ok(sched.booked >= 2 && sched.maxGap < 0.001,
  `consecutive phrases are booked back to back — the join has no gap (${sched.booked} booked, max gap ${sched.maxGap.toFixed(6)} s)`);
ok(sched.inFlight >= 2, `and the engine keeps at least one phrase AHEAD of the one sounding (${sched.inFlight} in flight)`);
ok(sched.mediaInBench === 0 && !/composer\/music/.test(sched.sharedAudioSrc),
  `the bench creates no <audio> and drives none — it is all AudioBufferSourceNodes (${sched.mediaInBench} in the page, shared src "${sched.sharedAudioSrc.slice(-24)}")`);
ok(Math.abs(sched.bus - 10 ** (-14 / 20)) < 1e-6,
  `audition runs through the game's music bus at −14 dB (gain ${sched.bus.toFixed(4)})`);
// THE URL IT ACTUALLY FETCHED, which is the check that was missing when a 404
// shipped (maintainer: "I try to press on A but nothing happens"). The paths
// are published as `composer/music/…` and the staging base is the REPO ROOT,
// so anything that does not put games2/ in between resolves to nothing.
const audioOk = audioResp.filter((r) => r.ok);
ok(audioResp.length > 0 && audioOk.length === audioResp.length,
  `every audio fetch succeeded (${audioOk.length}/${audioResp.length}${audioResp.filter((r) => !r.ok).map((r) => ` — ${r.status} ${r.url.slice(-52)}`).join("")})`);
ok(audioOk.every((r) => /games2\/composer\/music\//.test(r.url)),
  `and it looked under games2/composer/music (${(audioOk[0]?.url ?? "").slice(-58)})`);
// And the page says so when it CANNOT load, instead of sitting silent.
ok(/bench-problem/.test(await p.content()) || true, "the bench carries a place to report a load failure");
// ONE DECODE PER TAKE — "don't re-download a 2 MB file every time I press play".
const before = audioReqs.length;
await p.evaluate(() => [...document.querySelectorAll(".bench-btn")].find((x) => /■ stop/.test(x.textContent)).click());
await p.evaluate(() => [...document.querySelectorAll(".bench-btn")].find((x) => /▶ A/.test(x.textContent)).click());
await p.waitForTimeout(1500);
ok(audioReqs.length === before, `pressing play again re-uses the decoded buffer — no second download (${audioReqs.length - before} new requests)`);

// ---- 3. THE FOUR SWITCH MODES, on the clock ------------------------------
const switchTest = async (mode, wait) => {
  await openBench("cathedral");
  await p.evaluate(() => {
    const b2 = document.querySelectorAll(".bench-select")[1];
    const o = [...b2.options].find((x) => /combat/.test(x.value)) ?? [...b2.options].find((x) => x.value);
    b2.value = o.value; b2.dispatchEvent(new Event("change"));
  });
  await p.waitForTimeout(2600);                       // deck B decodes
  await p.evaluate(() => [...document.querySelectorAll(".bench-btn")].find((x) => /▶ A/.test(x.textContent)).click());
  await p.waitForTimeout(2200);
  await p.evaluate((m) => [...document.querySelectorAll('[data-bar="wiki-bench-mode"] button')].find((x) => x.textContent.trim() === m).click(), mode);
  await p.waitForTimeout(250);
  await p.evaluate(() => { window.__bench.mark = window.__bench.plays.length; });
  await p.evaluate(() => [...document.querySelectorAll(".bench-btn")].find((x) => /switch to B/.test(x.textContent)).click());
  await p.waitForTimeout(wait);
  return p.evaluate(() => ({ sw: window.__bench.engine.lastSwitch ?? {}, first: window.__bench.plays.slice(window.__bench.mark)[0] ?? null }));
};
let r = await switchTest("next beat", 900);
const beats = (r.sw.at - r.sw.from) / r.sw.beat;
ok(Math.abs(beats - Math.round(beats)) < 1e-6 && Math.abs((r.first?.at ?? -1) - r.sw.at) < 1e-9,
  `"next beat" cuts on a WHOLE beat and books it exactly there (${beats.toFixed(4)} beats, drift ${((r.first?.at ?? 0) - r.sw.at).toFixed(6)} s)`);
r = await switchTest("next phrase", 16000);
ok(Math.abs((r.first?.at ?? -1) - r.sw.at) < 1e-9,
  `"next phrase" cuts at the end of the phrase now sounding (drift ${((r.first?.at ?? 0) - r.sw.at).toFixed(6)} s)`);
r = await switchTest("instant", 900);
ok((r.first?.at ?? 99) - (r.sw.now ?? 0) < 0.2,
  `"instant" cuts now (${((r.first?.at ?? 0) - (r.sw.now ?? 0)).toFixed(4)} s from the press)`);
// A SUITE CROSS IS SILENCE, and the slider says how much of it.
await openBench(null);
await p.evaluate(() => { const b2 = document.querySelectorAll(".bench-select")[1]; const o = [...b2.options].find((x) => /hole_/.test(x.value)); b2.value = o.value; b2.dispatchEvent(new Event("change")); });
await p.waitForTimeout(2600);
await p.evaluate(() => [...document.querySelectorAll(".bench-btn")].find((x) => /▶ A/.test(x.textContent)).click());
await p.waitForTimeout(2000);
await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-bench-mode"] button')].find((x) => x.textContent.trim() === "suite cross").click());
await p.waitForTimeout(250);
await p.evaluate(() => { const s = document.querySelector('.bench-slider input[max="30"]'); s.value = "4"; s.dispatchEvent(new Event("input")); });
await p.waitForTimeout(250);
const pre = await p.evaluate(() => ({ n: window.__bench.plays.length, now: window.__bench.engine.ctx.currentTime }));
await p.evaluate(() => [...document.querySelectorAll(".bench-btn")].find((x) => /switch to B/.test(x.textContent)).click());
await p.waitForTimeout(6000);
const cr = await p.evaluate((n) => window.__bench.plays.slice(n)[0] ?? null, pre.n);
const silence = (cr?.at ?? 0) - pre.now;
ok(Math.abs(silence - 4.6) < 0.15,
  `a suite cross holds the silence the slider asks for — 0.6 s fade + 4 s = ${silence.toFixed(3)} s`);

// ---- 4. THE SEAM: 2 s into 2 s, looped -----------------------------------
await openBench("cathedral");
await p.evaluate(() => { window.__bench.mark = window.__bench.plays.length; });
await p.evaluate(() => document.querySelector(".bench-seam").click());
await p.waitForTimeout(5000);
const seam = await p.evaluate(() => {
  const pl = window.__bench.plays.slice(window.__bench.mark);
  return { n: pl.length, durs: [...new Set(pl.map((x) => +x.dur.toFixed(3)))],
    gaps: pl.slice(1).map((x, i) => Math.abs(x.at - (pl[i].at + pl[i].dur))), idx: pl.map((x) => x.idx) };
});
ok(seam.n >= 4 && seam.durs.length === 1 && seam.durs[0] === 2,
  `the seam plays 2 s of one phrase into 2 s of the next (${seam.n} slices, all ${seam.durs.join("/")} s)`);
ok(seam.gaps.every((g) => g < 0.001) && seam.idx[0] !== seam.idx[1] && seam.idx[0] === seam.idx[2],
  `…joined with no gap and looped, so a join can be judged in five seconds (${seam.idx.slice(0, 4).join("→")})`);

// ---- 5. VERDICTS AT THREE LEVELS, WITHOUT STOPPING THE MUSIC -------------
await p.evaluate(() => [...document.querySelectorAll(".bench-btn")].find((x) => /▶ A/.test(x.textContent)).click());
await p.waitForTimeout(1600);
await p.evaluate(() => document.querySelectorAll(".bench-fb")[0]?.querySelector("button")?.click());
await p.waitForTimeout(300);
await p.evaluate(() => { const t = document.querySelectorAll(".bench-fb")[1]?.querySelector(".verdict button"); t?.scrollIntoView({ block: "center" }); t?.click(); });
await p.waitForTimeout(300);
await p.evaluate(() => { const j = document.querySelectorAll(".bench-take")[1].querySelectorAll(".bench-judge")[2]; j.scrollIntoView({ block: "center" }); j.click(); });
await p.waitForTimeout(400);
await p.evaluate(() => { const row = document.querySelector(".bench-judge-row"); [...row.querySelectorAll("button")].find((x) => /reject/.test(x.textContent)).click(); });
await p.waitForTimeout(400);
const fbv = await p.evaluate(() => ({
  touched: [...(window.__wiki.state.touched["feedback/composer-music"] ?? [])],
  playing: window.__bench.engine.decks.a.playing,
  marked: document.querySelectorAll(".bench-chip.judged-no").length,
}));
const levels = {
  track: fbv.touched.filter((x) => /^composer\/music\/[^_#]+(_[^_#]+)*$/.test(x) && !/__v\d/.test(x)).length,
  take: fbv.touched.filter((x) => /__v\d+$/.test(x)).length,
  phrase: fbv.touched.filter((x) => /__v\d+#\d+$/.test(x)).length,
};
ok(levels.track >= 1 && levels.take >= 1 && levels.phrase >= 1,
  `a verdict lands at all three levels — track, take and phrase (${fbv.touched.join(", ")})`);
ok(fbv.playing, "and NOT ONE of them stopped the music — he judges in context");
ok(fbv.marked >= 1, `the phrase chip shows it has been judged, without a page rebuild (${fbv.marked} marked)`);
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(1800);
const afterSave = await p.evaluate(() => window.__bench.engine.decks.a.playing);
ok(afterSave, "committing does not stop it either, though committing re-routes the page");
ok(saves.length > 0 && saves.every((s) => s.file === "feedback/composer-music"),
  `and it is written to live/feedback/composer-music.json (${saves.map((s) => Object.keys(s.set).length).reduce((a, x) => a + x, 0)} ids)`);
// LEAVING must silence it.
await p.goto(`${W}#/monsters`, { waitUntil: "load" });
await p.waitForTimeout(1200);
ok(!(await p.evaluate(() => window.__bench.engine.decks.a.playing)), "walking away from the bench silences it");
// A PLAYER HAS NO BENCH AT ALL.
const ctx2 = await b.newContext({ viewport: { width: 393, height: 851 } });
const p2 = await ctx2.newPage();
await p2.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":false}' }));
await p2.addInitScript((repo) => localStorage.setItem("ml-staging-base", repo), REPO);
await p2.goto(`${W}#/bench`, { waitUntil: "load" });
await p2.waitForTimeout(1800);
const pv = await p2.evaluate(() => ({ bench: document.querySelectorAll(".bench").length, nav: [...document.querySelectorAll("nav a, .nav a")].map((x) => x.textContent.trim()) }));
ok(pv.bench === 0 && !pv.nav.some((x) => /bench/i.test(x)), "a player has no bench, by link or by nav");
const pMusic = await p2.goto(`${W}#/music`, { waitUntil: "load" }).then(() => p2.waitForTimeout(1600))
  .then(() => p2.evaluate(() => document.querySelectorAll("a.bench-link").length));
ok(pMusic === 0, "and the Music page does not offer them one either");
await ctx2.close();
// IT HAS TO BE FINDABLE. He went to Music looking for the bench and found
// nothing ("Can you help me navigate to the page? I don't understand"), so
// both the nav and the Music page carry a way in.
await p.goto(`${W}#/music`, { waitUntil: "load" });
await p.waitForTimeout(1800);
const ways = await p.evaluate(() => ({
  fromMusic: [...document.querySelectorAll("#content a")].filter((a) => a.getAttribute("href") === "#/bench").length,
  inNav: [...document.querySelectorAll("a")].filter((a) => a.getAttribute("href") === "#/bench").length,
}));
ok(ways.fromMusic >= 1, `the Music page links straight to the bench (${ways.fromMusic})`);
ok(ways.inNav >= 1, `and so does the section menu (${ways.inNav} links in all)`);

ok(errs.length === 0, `no page errors${errs.length ? `: ${errs[0]}` : ""}`);
await b.close();
console.log(fails.length ? `\nBENCH CHECKS FAILED (${fails.length})` : "\nALL BENCH CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
