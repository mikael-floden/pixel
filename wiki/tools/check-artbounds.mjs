// EVERY creature the wiki lists must have measured art bounds, and the shared
// stage must be big enough for all of them.
//
// Maintainer, 2026-08-13: "Diretusk and Rimeshard are also big monsters, but
// they fit inside the animation viewer, while the new big monsters doesn't fit
// in it (see a scrollar). Is this a task for you or the monster-agent?" — mine.
// The monster agent shipped 33 monsters and rebuilt data.json; the measurement
// then lived in a separate Python pass reading that data.json, so it still
// described the 24 monsters that existed in July. An unmeasured clip falls
// back to `[0,0,fw,fh]` in the player — the whole padded FRAME — so Cragback
// asked for a 472x472 canvas to draw a 402x350 creature and the stage grew a
// scrollbar. The two he named were measured, so they cropped correctly and
// fit. Since then build.mjs measures the art ITSELF (webp-pixels.mjs), inside
// every deploy's image build, with art_bounds.json as a content-hash cache —
// so what this file now guards is that the measurement really covers every
// clip, that the cache really is only a cache (delete an entry, the build
// restores the identical numbers), and that the numbers still hold on screen.
//
// Data checks run always; the browser pass runs when a wiki server answers.
// The cache-delta section runs two real builds, which refresh data.json's
// timestamp — that is what the build does, not damage.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const B = JSON.parse(readFileSync(new URL("../art_bounds.json", import.meta.url), "utf8"));
const fails = [];
const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };

const STAGE_KIND = { monsters: "monsters", characters: "characters", objects: "objects" };
const scale = D.artScale || 2;

// 1. COVERAGE — the failure that produced the scrollbar. An entity with
//    animations but no measured clip draws at padding size.
const unmeasured = [], partial = [];
for (const [dom, kind] of Object.entries(STAGE_KIND)) {
  for (const e of D.domains[dom] ?? []) {
    let seen = 0, total = 0;
    for (const [sn, st] of Object.entries(e.animations ?? {}))
      for (const dn of Object.keys(st.dirs ?? {})) {
        total++;
        if (st.dirs[dn].bb) seen++; else partial.push(`${dom}/${e.id}|${sn}|${dn}`);
      }
    if (total && !seen) unmeasured.push(`${dom}/${e.id}`);
  }
  void kind;
}
ok(unmeasured.length === 0,
  `every listed entity has measured bounds${unmeasured.length ? ` — ${unmeasured.length} do not: ${unmeasured.slice(0, 6).join(", ")}` : ` (${D.counts.monsters} monsters, ${D.domains.characters.length} characters)`}`);
ok(partial.length === 0,
  `and every single CLIP is measured, not just the entity${partial.length ? ` — ${partial.length} missing, e.g. ${partial.slice(0, 3).join(", ")}` : ""}`);

// 1b. THE CACHE IS ONLY A CACHE. Remove a measured entry and its hash, run
//     the real build, and the identical numbers must come back — this is the
//     "art measures itself on deploy" property, exercised end to end. Then a
//     second build must measure nothing (idempotence).
{
  const boundsPath = new URL("../art_bounds.json", import.meta.url);
  const doc = JSON.parse(readFileSync(boundsPath, "utf8"));
  const key = Object.keys(doc.clips).find((k) => k.startsWith("monsters/"));
  const wantBB = doc.clips[key].join(",");
  delete doc.clips[key]; delete doc.hashes[key];
  writeFileSync(boundsPath, JSON.stringify(doc));
  const ROOT = new URL("../..", import.meta.url).pathname;
  const out1 = execSync("node wiki/build.mjs --games2 games2", { cwd: ROOT, encoding: "utf8" });
  const m1 = out1.match(/art: \d+ clips — measured (\d+) now/);
  const after = JSON.parse(readFileSync(boundsPath, "utf8"));
  ok(m1 && Number(m1[1]) === 1, `a clip dropped from the cache is re-measured by the next build (measured ${m1?.[1]})`);
  ok((after.clips[key] ?? []).join(",") === wantBB, `and comes back with the identical numbers (${key} → ${after.clips[key]})`);
  const out2 = execSync("node wiki/build.mjs --games2 games2", { cwd: ROOT, encoding: "utf8" });
  const m2 = out2.match(/art: \d+ clips — measured (\d+) now/);
  ok(m2 && Number(m2[1]) === 0, `and the build after that measures nothing (${m2?.[1]})`);
}

// 2. THE BOX FITS EVERYONE. This is the box's whole definition, so a failure
//    here means the measurement missed part of the roster.
const box = D.artBox ?? {};
for (const [dom, kind] of Object.entries(STAGE_KIND)) {
  const list = D.domains[dom] ?? [];
  if (!list.length) continue;
  const bx = box[kind];
  if (!bx) { ok(false, `${dom}: no stage box at all`); continue; }
  let worst = null;
  for (const e of list)
    for (const [sn, st] of Object.entries(e.animations ?? {}))
      for (const [dn, c] of Object.entries(st.dirs ?? {})) {
        if (!c.bb) continue;
        const w = c.bb[2] - c.bb[0], h = c.bb[3] - c.bb[1];
        const over = Math.max(w - bx[0], h - bx[1]);
        if (!worst || over > worst.over) worst = { over, id: e.id, clip: `${sn}|${dn}`, w, h };
      }
  ok(worst && worst.over <= 0,
    `${dom}: the ${bx[0]}x${bx[1]} stage holds every pose (worst: ${worst?.id} ${worst?.w}x${worst?.h}, ${worst?.over > 0 ? `${worst.over}px OVER` : `${-worst?.over}px spare`})`);
}

// 3. NO PAGE OPENS ON A SCROLLBAR. The build picks the shared scale so the
//    view every page opens on — idle facing south — fits. A wide side-on pose
//    of a giant may still scroll at 4x zoom; that is documented and fine.
for (const dom of ["monsters", "characters"]) {
  const bx = box[STAGE_KIND[dom]];
  if (!bx) continue;
  const bad = [];
  for (const e of D.domains[dom] ?? []) {
    const bb = e.animations?.idle?.dirs?.south?.bb;
    if (!bb) continue;
    const w = bb[2] - bb[0], h = bb[3] - bb[1];
    if (w > bx[0] || h > bx[1]) bad.push(`${e.id} ${w}x${h}`);
  }
  ok(bad.length === 0, `${dom}: no page OPENS needing a scroll${bad.length ? ` — ${bad.join(", ")}` : ` (all ${(D.domains[dom] ?? []).length} open inside ${bx[0] * scale}x${bx[1] * scale} css px)`}`);
}

// 4. LEVELS TRACK SIZE. The same stale file scored 33 monsters at area 0, i.e.
//    "smallest creature alive", so Cragback (2nd largest) seeded at level 4
//    while a rabbit sat at 5. Rank correlation is a blunt instrument on
//    purpose — the ladder also weighs remoteness, so it is checked for the
//    gross inversion only, not for an exact order.
const tuning = JSON.parse(readFileSync(new URL("../../live/tuning/monsters.json", import.meta.url), "utf8")).monsters ?? {};
const area = {};
for (const [k, v] of Object.entries(B.clips))
  if (k.startsWith("monsters/")) {
    const id = k.split("|")[0].slice("monsters/".length);
    area[id] = Math.max(area[id] ?? 0, (v[2] - v[0]) * (v[3] - v[1]));
  }
const pairs = Object.keys(area).filter((i) => tuning[i]?.level != null).map((i) => [area[i], tuning[i].level]);
const rank = (xs) => { const s = [...xs].sort((a, b) => a - b); return xs.map((x) => s.indexOf(x)); };
const ra = rank(pairs.map((p) => p[0])), rl = rank(pairs.map((p) => p[1]));
const n = pairs.length;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const ma = mean(ra), ml = mean(rl);
const rho = pairs.length < 3 ? 1
  : ra.reduce((s, _, i) => s + (ra[i] - ma) * (rl[i] - ml), 0)
    / Math.sqrt(ra.reduce((s, x) => s + (x - ma) ** 2, 0) * rl.reduce((s, x) => s + (x - ml) ** 2, 0));
ok(rho > 0.55, `monster level still tracks creature size across all ${n} (rank correlation ${rho.toFixed(2)}, needs > 0.55)`);
const biggest = Object.entries(area).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([i]) => i);
const smallest = Object.entries(area).sort((a, b) => a[1] - b[1]).slice(0, 5).map(([i]) => i);
const lo = Math.min(...biggest.map((i) => tuning[i]?.level ?? 99));
const hi = Math.max(...smallest.map((i) => tuning[i]?.level ?? 0));
ok(lo > hi, `and no top-5 giant is out-levelled by a bottom-5 critter (giants from ${lo}, critters to ${hi})`);

// 5. BROWSER — the symptom itself. Numbers said "fits" once before while the
//    maintainer was looking at a scrollbar, so measure the real stage.
const URL_ = process.env.WIKI_URL ?? "http://127.0.0.1:8902";
let up = false;
try { up = (await fetch(`${URL_}/assets/wiki/site/data.json`, { method: "HEAD" })).ok; } catch { up = false; }
if (!up) {
  console.log(`  skip: no wiki server on ${URL_} — data checks only`);
} else {
  const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  // DESKTOP width on purpose. The stage is `max-width:100%`, so on a phone it
  // is capped by the viewport and a giant scrolls inside it by design — the
  // fixed stage only exists at its true size once the window is wider than it.
  // That is the view the maintainer was describing, and the only one where
  // "Diretusk fits, Cragback doesn't" is a statement about the BOX.
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const W = `${URL_}/assets/wiki/site/index.html`;
  // The five biggest, plus the two the maintainer said were FINE — if those
  // two ever start scrolling, the fix regressed the thing it was protecting.
  const probe = [...new Set([...biggest, "mammoth", "ice_crystal_golem"])];
  const seen = [];
  for (const id of probe) {
    await p.goto(`${W}#/monsters/${id}`, { waitUntil: "load" });
    await p.waitForTimeout(1500);
    seen.push({ id, ...await p.evaluate(() => {
      const st = document.querySelector(".player-stage");
      const cv = st?.querySelector("canvas");
      const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      let painted = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) painted++;
      return { name: document.querySelector("h1")?.textContent,
        ox: st.scrollWidth - st.clientWidth, oy: st.scrollHeight - st.clientHeight,
        stage: `${st.clientWidth}x${st.clientHeight}`, canvas: `${cv.width}x${cv.height}`, painted,
        page: document.documentElement.scrollWidth - window.innerWidth };
    }) });
  }
  for (const s of seen) console.log(`      ${s.name}: stage ${s.stage} canvas ${s.canvas} overflow ${s.ox}x${s.oy}`);
  ok(seen.every((s) => s.ox <= 0 && s.oy <= 0),
    `no giant overflows its stage at the default zoom (worst ${Math.max(...seen.map((s) => s.ox))}x${Math.max(...seen.map((s) => s.oy))})`);
  ok(seen.every((s) => s.painted > 500), `and every one of them actually draws (${seen.map((s) => s.painted).join(", ")})`);
  ok(seen.every((s) => s.page <= 0), "the PAGE never grows a horizontal scrollbar");

  // THE SELF-HEALING PATH, which is the only defence that does not depend on
  // whoever last ran the build — and it was another agent's rebuild that
  // stranded these 33. Serve a data.json with every `bb` stripped, i.e. exactly
  // what a fresh import looks like, and the player must measure the sprite
  // itself and land on the SAME numbers the Python did. Equal, not merely
  // "smaller than the frame": that also pins the alpha cut to the build's.
  // Re-serving with `response: r` would carry the original content-encoding
  // and content-length over a shorter body and the browser discards it, so the
  // response is rebuilt plainly. `hits` matters just as much: data.json is
  // fetched ONCE at boot and hash navigation never refetches it, so a route
  // registered now only bites after a reload — without one every "self
  // measured" number below would just be the ordinary bounds-file number, and
  // the check would pass by doing nothing.
  let hits = 0;
  await p.route("**/wiki/site/data.json", async (route) => {
    const j = JSON.parse(await (await route.fetch()).text());
    for (const dom of Object.values(j.domains))
      for (const e of Array.isArray(dom) ? dom : [])
        for (const st of Object.values(e.animations ?? {}))
          for (const c of Object.values(st.dirs ?? {})) delete c.bb;
    hits++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
  });
  const heal = [];
  for (const id of ["granite_bear", "storm_shellback", "mammoth"]) {
    await p.goto(`${W}#/monsters/${id}`, { waitUntil: "load" });
    await p.reload({ waitUntil: "load" });
    await p.waitForTimeout(2600);
    const got = await p.evaluate(() => {
      const st = document.querySelector(".player-stage"), cv = st.querySelector("canvas");
      return { w: cv.width, h: cv.height, ox: st.scrollWidth - st.clientWidth, oy: st.scrollHeight - st.clientHeight };
    });
    // Compared against the SAME page rendered with the bounds file, not against
    // a clip key guessed from here: the canvas is sized by max(content, shadow)
    // and for Diretusk the shadow is what wins, so "content x scale" is simply
    // not what the canvas should be.
    const ref = seen.find((s) => s.id === id);
    heal.push({ id, got, want: [ref.w ?? Number(ref.canvas.split("x")[0]), Number(ref.canvas.split("x")[1])], frame: D.domains.monsters.find((m) => m.id === id)?.frameW * scale });
  }
  for (const x of heal) console.log(`      ${x.id}: self-measured ${x.got.w}x${x.got.h}, with the bounds file ${x.want[0]}x${x.want[1]}, padded frame would be ${x.frame}`);
  ok(hits >= heal.length, `the stripped data.json really was served (${hits}x) — otherwise these are not self-measurements`);
  ok(heal.every((x) => Math.abs(x.got.w - x.want[0]) <= 2 && Math.abs(x.got.h - x.want[1]) <= 2),
    "an unmeasured clip measures itself to the same box the Python found");
  ok(heal.every((x) => x.got.w < x.frame), "so it never falls back to the padded frame again");
  ok(heal.every((x) => x.got.ox <= 0 && x.got.oy <= 0), "and a brand-new monster fits the stage with no bounds file at all");
  await b.close();
}

console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL ART-BOUNDS CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
