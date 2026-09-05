/* Nangijala game wiki — one page, two audiences.
   PLAYERS browse everything the art/audio agents produce (read-only).
   The ADMIN (game designer) additionally rates, approves/removes and tunes —
   after signing in. All admin writes go through the GAME SERVER's API
   (/api/wiki/*): the server checks the login, holds the GitHub token, commits
   to live/** on main and pushes the change to every connected game client
   over its WebSocket. No GitHub credentials ever live in a browser.
   Vanilla JS, no build step. Data comes from data.json (built by ../build.mjs);
   feedback/tuning come from GET /api/live/state (the server's always-fresh
   copy), with the static /assets/live files as offline fallback. */

"use strict";

// The directory that serves the art domains: /assets/ in the game (prod +
// vite dev), the repo root when served locally — always two levels up.
//
// MUTABLE, because a signed-in admin reads the WHOLE repo instead (see
// useStagingRoot). Since 2026-08-14 the deployed image contains only what the
// game can reach, so the art the wiki exists to REVIEW — the ~2,640 scenery
// pieces nothing places yet, the unspawned monsters — is not on this origin at
// all. An admin re-points ROOT at GitHub and gets everything.
let ROOT = new URL("../../", location.href);

/** COMPOSER AUDIO LIVES IN THE REPO, NOT THE IMAGE (2026-08-15). The foley
 *  takes and music beds are 94 MB that ONLY these wiki pages play — nothing in
 *  the game loads /assets/composer (the in-world score is bundled into the
 *  client JS). Shipping them meant every player's container carried 94 MB for
 *  a page only the Game Master opens, so the image drops them and the wiki
 *  streams them from the public repo instead.
 *
 *  Unlike the admin registry swap below this applies to EVERYONE, because the
 *  sound pages are not admin-only. Resolved lazily and cached: the base needs
 *  one GitHub API call, and a page that never plays a sound never makes it.
 *  Local checkouts (file://, dev server) keep serving them from disk — the
 *  override wins, and `composerBase` is only consulted when the local origin
 *  is the deployed game. */
let composerBase = null;
async function composerRoot() {
  if (composerBase) return composerBase;
  /* THE COMPOSER LIVES UNDER games2/, and this forgot to say so (maintainer
   * 2026-08-22, on the music bench: "I try to press on A but nothing happens").
   *
   * Paths published for the composer are `composer/music/…`, and the staging
   * base is the REPO ROOT — so every one of them resolved to
   * raw.githubusercontent/…/<sha>/composer/music/… and answered 404, where the
   * file is at …/<sha>/games2/composer/music/…. Verified against the CDN: the
   * first is 404, the second 200 with access-control-allow-origin: *.
   *
   * It is not only the bench: the composer's situation beds on the Music page
   * carry the same prefix and have never been playable in production either.
   *
   * MY GATE HID IT. The local override pointed at `…/8903/games2/`, which I
   * chose because it made the paths work — so the test proved the audio decodes
   * and proved nothing about where the page looks for it. The override is the
   * repo root now, exactly like the real base. */
  const base = (await stagingSha().then((sha) => stagingBase(sha))) ?? ROOT;
  composerBase = new URL("games2/", base);
  return composerBase;
}

/** Does the deployed image carry this domain at all?
 *
 *  THE ARRANGEMENT, in the maintainer's words (2026-08-17): "we use the repo
 *  for unreleased content to make the GCP bill less expensive. Once it's in the
 *  game it will be part of the game." So a domain the game does not render yet
 *  is absent from the image BY DESIGN, its every path 404s there, and that 404
 *  carries no information about whether the file exists.
 *
 *  Which domains those are is DATA, not a list to keep in step by hand: the
 *  curate stage publishes what it shipped in `/shipset.json`, so a domain
 *  missing from its `stats` is repo-only, and the day the game starts rendering
 *  it the same file starts saying so with no wiki change. `tiles` is seeded
 *  below as well, because it is repo-only TODAY and the shipset arrives a round
 *  trip after the first cards ask for art. Unknown (dev, an old image, a failed
 *  fetch) falls back to the lazy discovery it always had. */
const isUnshipped = (dom) => repoDomains.has(dom) || (shippedDomains ? !shippedDomains.has(dom) : false);
let shippedDomains = null;
async function loadShipset() {
  const d = await fetchJson(new URL("/shipset.json", location.href));
  if (d?.stats && typeof d.stats === "object") shippedDomains = new Set(Object.keys(d.stats));
  return shippedDomains;
}
const assetUrl = (rel) => {
  // A domain the image does not carry is fetched from the repo directly — not
  // 404ed once per card first.
  if (repoBase && typeof rel === "string" && isUnshipped(rel.split("/")[0])) return new URL(rel, repoBase).href;
  return new URL(rel, ROOT).href;
};

/** Same as assetUrl but for composer audio, which the deployed image lacks.
 *  Async because the base is resolved once on first use. */
async function composerUrl(rel) {
  return new URL(rel, await composerRoot()).href;
}

/** The repo, as a CDN base. jsDelivr rather than raw.githubusercontent because
 *  a sha-pinned jsDelivr URL answers `cache-control: max-age=31536000,
 *  immutable` (measured 2026-08-14) — the same contract the in-image `?v=<sha>`
 *  trick gives — while raw answers max-age=300 EVEN for a commit-pinned ref.
 *
 *  INJECTABLE on purpose: `ml-staging-base` in localStorage overrides it, which
 *  is how this path gets tested. The agent sandbox blocks browser egress to
 *  external origins, so gates point this at a second local server that sends
 *  `access-control-allow-origin: *` — a genuinely different origin, exercising
 *  the identical cross-origin + canvas-tainting path with no internet. */
const STAGING_REPO = "mikael-floden/pixel";
/* RAW, NOT jsDELIVR (measured 2026-08-17, from the maintainer's report that
 * neither the tiles nor the scenery would render — every card reading
 * "removed", and his question, "is it the CORS request that fails or what?").
 *
 * It was not CORS. Same repo, same minute, same file:
 *     raw.githubusercontent @sha   200 in  0.6 s
 *     cdn.jsdelivr @main           200 in 17.1 s
 *     cdn.jsdelivr @<fresh sha>    TIMEOUT at 25 s
 * This repo is large and pushed every few minutes, so a pinned sha is one the
 * CDN has essentially never cached, and a cold fetch of it is what every image
 * on the page was waiting on. jsDelivr was chosen for its immutable
 * `max-age=31536000` against raw's 300 — but a cache header is worth nothing
 * on a request that does not finish.
 */
function stagingBase(sha) {
  const override = (() => { try { return localStorage.getItem("ml-staging-base"); } catch { return null; } })();
  if (override) return new URL(override.endsWith("/") ? override : override + "/");
  return new URL(`https://raw.githubusercontent.com/${STAGING_REPO}/${sha}/`);
}

/** The commit to pin staging reads to. HEAD of main, not the deployed sha —
 *  reviewing content that is not in the game yet is the entire point, and the
 *  newest art is by definition newer than the image. Cached per tab. */
async function stagingSha(force = false) {
  /* THE PIN EXPIRES (cache-safety law, 2026-08-27; tiles' ask after the
   * audition holes). The sha used to live in sessionStorage unconditionally —
   * which SURVIVES RELOADS, so a phone tab kept for days re-pinned to the same
   * old commit on every reload and never saw new art, including right after he
   * tapped the new-build bar. Ten minutes: within one page's life the pin is
   * stable (a sha URL is immutable, so everything the page fetches is
   * self-consistent), and the next load pins fresh. The pin itself is the
   * cache-safe half — a page reading everything at ONE sha cannot see a rename
   * as a hole, because the old sha still serves the old names. */
  const TTL = 10 * 60 * 1000;
  try {
    const hit = JSON.parse(sessionStorage.getItem("ml-staging-sha2") ?? "null");
    if (!force && hit?.sha && Date.now() - (hit.at ?? 0) < TTL) return hit.sha;
  } catch {}
  try {
    const r = await fetch(`https://api.github.com/repos/${STAGING_REPO}/commits/main`);
    const sha = (await r.json())?.sha;
    if (sha) {
      try { sessionStorage.setItem("ml-staging-sha2", JSON.stringify({ sha, at: Date.now() })); } catch {}
      return sha;
    }
  } catch {}
  return "main"; // still correct, just not immutably cacheable
}
/* THE PIN MOVES FORWARD FOR A LIVE INDEX (maintainer 2026-08-28, on Light
 * Soil: "I can see no slope tiles at all" — 240 of them were on main and on
 * disk). A page pins ONE sha at boot so everything it reads is
 * self-consistent, which is right; but the slopes and fades indexes are read
 * LIVE precisely because the tiles agent publishes while he reviews, and a
 * phone tab open since before their push stayed pinned behind it for the
 * life of the page. So those refreshes re-resolve HEAD and, when it has
 * moved, move the WHOLE page's base to the new sha — one sha still, just a
 * newer one, which is exactly what a reload would have done. */
function useMainRef() {
  /* A LIVE INDEX AND ITS ART READ MAIN, not the boot pin. The pin exists so
   * one page reads one immutable sha; the slopes and fades indexes exist
   * because the tiles agent publishes WHILE he reviews, and those two rules
   * cannot both hold. Main wins for these: the files an index names are
   * content-hashed and immutable, so reading the newest index and the newest
   * art together is self-consistent — it is the pinned-but-stale pairing
   * that showed him "Slime shows nothing" with 236 tiles on main.
   *
   * NO api.github.com CALL. My first cut re-resolved HEAD through the API on
   * a timer, which is a rate limit (60/hour/IP, unauthenticated) sitting in
   * front of his review, and a 403 there degrades silently. "main" is a ref
   * raw.githubusercontent serves directly. */
  if (!repoBase || /127\.0\.0\.1|localhost/.test(repoBase.href)) return;
  const main = stagingBase("main");
  if (main.href !== repoBase.href) { repoBase = main; retryRepoMisses(); }
}
/** A feedback id is a repo path WITHOUT the extension, which is what lets the
 *  maintainer's verdicts survive the art changing format underneath them (the
 *  fleet's PNG → lossless WebP migration, 2026-07-31). Strip every image
 *  extension, not just .png: the day tiles2 converts, `.png`-only stripping
 *  would rename every id and orphan every star, note and rejection on file. */
const stripExt = (rel) => rel.replace(/\.(png|webp)$/i, "");
// The game server's API (same origin in prod and dev — vite proxies /api).
const API = (path) => new URL(path, location.origin).href;

/* ------------------------------------------------- art that has been DELETED
 * THE ADMIN READS ART FROM HEAD OF MAIN AND THE PIECE LIST FROM THE DEPLOYED
 * BUILD. That is deliberate (see stagingSha — reviewing art that is not in the
 * game yet is the entire point of reading the repo), and the consequence is
 * that `data.json` can list a piece whose file the producing agent has since
 * deleted. The REJECTED filter is exactly where that happens, every time,
 * because a rejection IS the instruction to delete the piece.
 *
 * Measured on the maintainer's own report (2026-08-15, "why doesn't the
 * rejected Scenery render?"): the wiki was built at 79c1ae3e5 (16:59), the
 * scenery agent committed "remove 3 rejected piece(s) (wiki verdicts)" at
 * 17:33, and all three cards under that filter were broken <img>s sprawling
 * their alt text across the card.
 *
 * A 404 here is NOT an error — it is the agent having done what he asked — so
 * the card says "removed" and reads as the completion signal it is. Anything
 * else is a real load failure and must say THAT instead: telling him a piece
 * was removed because a CDN blinked would be a lie he would act on.
 *
 * ONE capture-phase listener rather than 21 call sites: `error` does not
 * bubble, but it does capture, so this covers every image the app renders
 * today and every one added later. Detached `new Image()` prefetches dispatch
 * on themselves and never reach the document, so the warm pump is untouched.
 */
const artProbe = new Map();   // url -> Promise<"gone" | "failed">, one per url
function probeArt(url) {
  if (!artProbe.has(url)) {
    artProbe.set(url, (async () => {
      try {
        const r = await fetch(url, { method: "HEAD", cache: "no-store" });
        return r.status === 404 || r.status === 410 ? "gone" : "failed";
      } catch { return "failed"; }
    })());
  }
  return artProbe.get(url);
}
/** Paths already served by the repo, so the second card of a domain the image
 *  does not carry goes straight there instead of 404ing first.
 *
 *  SEEDED, NOT ONLY DISCOVERED (2026-08-17). Discovery costs one 404 per domain
 *  and, worse, the first cards of that domain race the discovery and fall into
 *  the "the agent removed this" path — which is exactly what a whole World page
 *  of "removed" cards was. `tiles` (3.0) is in the repo and NOT in the image:
 *  the curate stage ships the domains the GAME reads, and nothing renders 3.0
 *  yet, so /assets/tiles/** is a guaranteed 404 for every tile and for the
 *  review manifest. A domain that is known not to ship must never be ASKED of
 *  the image — the 404 is not information, it is the arrangement. */
const repoDomains = new Set(["tiles"]);
/** Art that 404d at the image BEFORE the repo base was known. Without this the
 *  first cards of an unshipped domain are stuck on "not loading" for the life
 *  of the page: repoTwin needs repoBase, and the miss is over by the time it
 *  arrives (2026-08-17 — the World section, every face blank). */
const repoMisses = new Set();
let repoBaseKnown = false;   // true once the base is up OR the upgrade gave up
function retryRepoMisses() {
  if (!repoBase) return;
  const first = !repoBaseKnown;
  repoBaseKnown = true;
  // The live indexes bail out until the base is up; once it is, a world page
  // has to ask again — otherwise the Slope/Fade tab waits for a navigation.
  if (first && /^#\/?world/.test(location.hash)) queueMicrotask(() => route());
  // ...AND EVERY IMAGE ALREADY ON THE PAGE pointing at the image's origin for a
  // domain the image does not carry. Those cannot merely be waiting: that URL
  // will 404 whenever it is finally requested. The hidden before/after twin is
  // the case that made this necessary — it is `loading="lazy"` and off screen,
  // so it never fetches, never errors, and would sit on a dead URL until the
  // moment he flips the switch and watches it blink.
  for (const img of document.images) {
    const src = img.getAttribute("src") ?? "";
    if (!src.startsWith(ROOT.href ?? String(ROOT))) continue;
    const dom = src.slice(String(ROOT).length).split("/")[0];
    if (!isUnshipped(dom)) continue;
    const twin = repoTwin(src);
    if (twin && twin !== src) img.src = twin;
  }
  // The showcase's cards, held for exactly the same reason as the images below.
  for (const el of [...showcaseMisses]) {
    showcaseMisses.delete(el);
    if (!el.isConnected) continue;
    const src = el.dataset.strip ?? "";
    const twin = repoTwin(src);
    if (!twin || twin === src) continue;
    // The domain comes from the url that MISSED, while it still points at the
    // image — reading it back off the repo twin would be reading a CDN path.
    if (src.startsWith(String(ROOT))) repoDomains.add(src.slice(String(ROOT).length).split("/")[0]);
    el.dataset.triedRepo = "1";
    el.dataset.strip = twin;
    if (el.dataset.preview) el.dataset.preview = repoTwin(el.dataset.preview) ?? el.dataset.preview;
    paintShowcase(el);
  }
  for (const img of repoMisses) {
    repoMisses.delete(img);
    if (!img.isConnected) continue;
    const twin = repoTwin(img.dataset.imageSrc || img.src);
    if (!twin) continue;
    img.dataset.triedRepo = "1";
    const box = img.closest(".thumb, .portrait");
    box?.classList.remove("art-failed", "art-gone");
    box?.querySelector(".art-note")?.remove();
    if (!img.isConnected && box) box.prepend(img);
    img.src = twin;
  }
}
async function onArtMissing(img) {
  const url = img.src;
  // The repo base is not up yet — hold this one rather than judging it. Only
  // while an upgrade is actually coming: a reader never gets a repo base, and
  // holding their missing art would replace an honest "not loading" with
  // nothing at all.
  if (!repoBaseKnown && state.admin && !img.dataset.triedRepo && !/\/icons\//.test(url) && img.isConnected) {
    img.dataset.imageSrc = url;
    repoMisses.add(img);
    return;
  }
  // ASK THE REPO BEFORE BELIEVING IT IS GONE. The image only holds what has
  // shipped, so a 404 here is the ordinary case for a domain still in
  // development — not evidence that anything was deleted.
  if (!/\/icons\//.test(url) && img.isConnected && !img.dataset.triedRepo) {
    const twin = repoTwin(url);
    if (twin && twin !== url) {
      img.dataset.triedRepo = "1";
      repoDomains.add(new URL(url, location.href).pathname.replace(/^.*\/assets\//, "").split("/")[0]);
      img.src = twin;
      return;
    }
  }
  // Local chrome (section icons, the gold coin) is baked into the page and
  // cannot be "removed by an agent" — a miss there is a plain load failure.
  //
  // NEITHER CAN A DOMAIN THE IMAGE NEVER CARRIED. If this url is still on the
  // image's origin for a repo-only domain, the 404 says the deploy does not
  // ship 3.0 — which is true, deliberate, and says NOTHING about whether the
  // agent still has the file. Believing it cost a whole World page of "removed"
  // cards while every one of those tiles sat in the repo (2026-08-17).
  const domain = new URL(url, location.href).pathname.replace(/^.*\/assets\//, "").split("/")[0];
  // ...and only while we are still asking the IMAGE for it: once a url has
  // been retried against the repo, a 404 THERE is real news.
  const fromRepo = !!repoBase && url.startsWith(String(repoBase));
  const unshipped = isUnshipped(domain) && !fromRepo;
  const verdict = (/\/icons\//.test(url) || unshipped) ? "failed" : await probeArt(url);
  // GONE MEANS GONE — the piece leaves the wiki, it does not become a
  // tombstone (maintainer 2026-08-16, on three "removed" cards sitting in his
  // partly-reviewed filter: "why is the object not removed then removed? Why
  // do I still see it but as removed?"). He is right: a card he cannot open,
  // judge or look at is not information, it is an obstacle between him and the
  // 17 pieces he CAN review. Dropping the entity from the loaded manifest
  // makes every count, filter, chip and ‹ › pager behave as though the build
  // had never listed it — which is the truth as of this second.
  if (verdict === "gone" && dropGoneEntity(url)) return;
  if (!img.isConnected) return;
  const box = img.closest(".thumb, .portrait");
  img.remove();
  if (!box) return;   // a small inline icon just goes quiet
  // ONE FRAME, ONE NOTE. A World card holds two images — the shipped tile and
  // its raw twin — so a missing piece fires this twice and stacked two
  // "removed" captions on top of each other (maintainer's screenshot).
  if (box.querySelector(".art-note")) return;
  // What is left here is the OTHER case: the art did not load, but nothing
  // says it is gone. That one must stay visible — a piece silently vanishing
  // because a CDN blinked is the failure this distinction exists to prevent.
  box.classList.add(verdict === "gone" ? "art-gone" : "art-failed");
  box.append(h("span", { class: "art-note" },
    verdict === "gone" ? "removed" : "not loading",
    verdict === "gone"
      ? h("small", {}, "the agent acted on this")
      : h("small", {}, "the art did not load")));
}
/** Paths whose art answered 404 this session — remembered so a re-render, a
 *  page turn or a Back cannot resurrect a piece that is not there. */
const goneArt = new Set(JSON.parse(sessionStorage.getItem("wiki-gone-art") || "[]"));
/** Drop the entity whose OWN sprite 404'd. Keyed on `preview` deliberately: a
 *  missing animation frame means one state is gone, not the piece, and that
 *  keeps its note in the viewer. Returns whether anything was dropped. */
function dropGoneEntity(url) {
  const path = new URL(url, location.href).pathname;
  let hit = null;
  for (const [domain, list] of Object.entries(state.data?.domains ?? {})) {
    if (!Array.isArray(list)) continue;
    const i = list.findIndex((e) => e?.preview && path.endsWith(e.preview));
    if (i >= 0) { hit = { domain, entity: list[i], i }; break; }
  }
  if (!hit) return false;
  // NOT WHILE THE REPO'S COPY IS STILL ON ITS WAY. Until the staging upgrade
  // lands, art resolves against the IMAGE, which by design does not carry the
  // domains that have not shipped — Tiles 3.0 today. Every one of those 404s,
  // and believing them would delete the section a second before the data that
  // makes it resolvable arrives.
  if (stagingPending) return false;
  // A WHOLE DOMAIN CANNOT HAVE BEEN DELETED — that is a broken path, and the
  // wiki must not present one as thirty-four deletions.
  //
  // Measured 2026-08-17: the tiles agent moved `file` in their review manifest
  // from domain-relative to repo-relative, the live World refresh kept adding
  // its own `tiles/` prefix, and every card requested `tiles/tiles/review/…`.
  // Every one 404'd, this function believed all of them, and the section read
  // "0 pairs" — the maintainer's report was "can't see the tiles in the wiki".
  // Losing a piece to a real deletion is the feature; losing a SECTION is
  // always a bug, and the honest failure is the per-card "not loading" state,
  // which says where to look.
  if (!prunableNow(hit.domain)) return false;
  forgetEntity(hit.domain, hit.i);
  goneArt.add(hit.entity.preview);
  try { sessionStorage.setItem("wiki-gone-art", JSON.stringify([...goneArt])); } catch { /* private mode */ }
  // Re-render so the counts, the chips and the pager agree with the grid — but
  // NEVER while he is on that piece's own page: re-routing there would replace
  // what he is reading with "unknown piece". The lists correct themselves the
  // moment he navigates.
  const [page, id] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (id && id === hit.entity.id) return true;
  if (page) scheduleGoneRerender();
  return true;
}
// ONE re-render for the whole batch. A stale build can be carrying a dozen
// deleted pieces at once (measured 14 in one filtered view), their images all
// 404 within a few hundred ms of each other, and re-routing per drop would
// rebuild 800 cards a dozen times over on his phone.
let goneTimer = null;
function scheduleGoneRerender() {
  if (goneTimer) return;
  if (keepScrollY == null) keepScrollY = window.scrollY;
  goneTimer = setTimeout(() => { goneTimer = null; route(); }, 200);
}
/** How much of one domain this session is willing to believe has been deleted.
 *  Deletions arrive a few at a time (he rejects a piece, the agent removes it);
 *  a quarter of a domain at once is a path bug, not a purge. The floor lets a
 *  tiny domain lose a piece or two without tripping. */
const PRUNE_SHARE = 0.25, PRUNE_FLOOR = 4;
const pruned = {};
function prunableNow(domain) {
  const live = state.data.domains[domain]?.length ?? 0;
  const n = (pruned[domain] ?? 0) + 1;
  const cap = Math.max(PRUNE_FLOOR, Math.round((live + (pruned[domain] ?? 0)) * PRUNE_SHARE));
  if (n > cap) {
    // Said once per domain, and loudly: this is the state where the page is
    // telling the truth about art it cannot fetch, and something upstream is
    // wrong with the paths.
    if (!pruned[`${domain}!warned`]) {
      pruned[`${domain}!warned`] = 1;
      console.warn(`[wiki] ${domain}: ${n} pieces 404'd — that is more than a domain loses to deletions. Treating the rest as "not loading" rather than deleting them; check the art paths in data.json.`);
    }
    return false;
  }
  pruned[domain] = n;
  return true;
}
function forgetEntity(domain, i) {
  state.data.domains[domain].splice(i, 1);
  syncCounts(domain);
}
/** Counts are DERIVED from the list, never decremented alongside it. The first
 *  cut decremented `counts[domain]` only, so a domain with a second count —
 *  World has one per candidate — could show "0 pairs · 93 candidates", two
 *  numbers from the same data disagreeing on screen (maintainer 2026-08-17). */
function syncCounts(domain) {
  const list = state.data.domains[domain] ?? [];
  if (!state.data.counts) return;
  if (domain in state.data.counts) state.data.counts[domain] = list.length;
  if (domain === "world") state.data.counts.world_candidates = list.reduce((n, c) => n + (c.candidates?.length ?? 0), 0);
  if (domain === "tiles") {
    state.data.counts.tile_types = list.length;
    state.data.counts.tiles = list.reduce((n, t) => n + (t.tileCount ?? 0), 0);
  }
  if (domain === "characters") {
    state.data.counts.characters = list.filter((c) => c.kind !== "npc").length;
    state.data.counts.npcs = list.filter((c) => c.kind === "npc").length;
  }
}
/** Applied once the manifest is loaded, so a piece already known to be gone
 *  never flashes into the grid a second time. */
function pruneKnownGone() {
  for (const [domain, list] of Object.entries(state.data?.domains ?? {})) {
    if (!Array.isArray(list)) continue;
    for (let i = list.length - 1; i >= 0; i--) if (list[i]?.preview && goneArt.has(list[i].preview)) forgetEntity(domain, i);
  }
}
document.addEventListener("error", (ev) => {
  if (ev.target instanceof HTMLImageElement && ev.target.src) onArtMissing(ev.target);
}, true);

// "bindings" is not an art domain: its ids are `<eventId>#<sound>` pairs and a
// rejected entry means UNBIND that sound from that event — the recording is
// untouched (maintainer 2026-08-06). See live/feedback/bindings.json.
const FEEDBACK_DOMAINS = ["monsters", "characters", "tiles", "objects", "sounds", "music", "items", "lore", "composer", "composer-music", "bindings"];
const state = {
  data: null,
  admin: false,          // signed in as the game designer? (server-verified)
  feedback: {},          // domain -> parsed pixel-wiki-feedback@1
  tuning: { monsters: null, constants: null, shadow_notes: null, tile_walls: null },
  dirty: new Set(),      // "feedback/monsters" | "tuning/monsters" | "tuning/constants"
  // Per file: WHICH ids this session actually edited. Saves send exactly
  // these ids as a delta — the server merges them into the current document,
  // so a stale page can never clobber entries committed earlier.
  touched: {},           // key -> Set(ids)
  query: "",
};
function touch(key, id) {
  (state.touched[key] ?? (state.touched[key] = new Set())).add(id);
  /* A DELETION IS SENT ONLY WHEN HE DELETED (2026-09-02, the day 6,890 tile
   * verdicts were erased server-side and this client turned out to be a
   * second way to lose them). A save sends `null` for a touched id whose
   * value is absent — which is right when he cleared it, and catastrophic
   * when the id is absent because the document under him was REPLACED (a
   * live refresh, a rollback, a stale copy): every id he had touched would go
   * out as a delete. So the moment of touching records whether the value was
   * absent THEN — the only time absence means "he removed it". */
  const cleared = state.cleared ?? (state.cleared = {});
  const set = cleared[key] ?? (cleared[key] = new Set());
  if (valueOf(key, id) === null) set.add(id); else set.delete(id);
}
const adminToken = () => localStorage.getItem("wiki-admin-token") ?? "";

/* ---------------------------------------------------------- tiny helpers */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);
const fmtDur = (s) => {
  if (s == null) return "";
  if (s < 60) return `${s.toFixed(2)}s`;
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const DIR_LABEL = { south: "S", "south-east": "SE", east: "E", "north-east": "NE", north: "N", "north-west": "NW", west: "W", "south-west": "SW" };
let toastTimer = null;
function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = h("div", { class: "toast" }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}

/* ------------------------------------------------------------- feedback */
function fb(domain, id) {
  return state.feedback[domain]?.entries?.[id] ?? {};
}
function setFb(domain, id, patch) {
  const f = state.feedback[domain] ?? (state.feedback[domain] = { format: "pixel-wiki-feedback@1", domain, updated_at: "", entries: {} });
  const entry = { ...(f.entries[id] ?? {}), ...patch, updated_at: new Date().toISOString() };
  // Drop cleared fields so "no rating" stays the true default.
  for (const k of ["rating", "status", "note"]) {
    if (entry[k] === null || entry[k] === undefined || entry[k] === "") delete entry[k];
  }
  if (Object.keys(entry).length <= 1) delete f.entries[id];
  else f.entries[id] = entry;
  f.updated_at = new Date().toISOString();
  touch(`feedback/${domain}`, id);
  markDirty(`feedback/${domain}`);
}
function markDirty(key) {
  state.dirty.add(key);
  updateSavebar();
}
// WHAT IS IN THE COMMIT, not how many files carry it (maintainer 2026-08-14:
// "Yes, its 1 file, but how much is in it..."). A review session puts every
// verdict into ONE feedback file, so the old "1 file with unsaved changes"
// read the same after one approval as after ninety — it described the
// plumbing, not the work. state.touched already holds the affected ids per
// file, so the honest number was one reduce away. The file count stays, in
// second place, for the sessions that really do span several.
function pendingCount() {
  return Object.values(state.touched).reduce((n, set) => n + set.size, 0);
}
function updateSavebar() {
  const bar = $("#savebar");
  if (!state.dirty.size) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  const n = pendingCount(), f = state.dirty.size;
  // Short on purpose: the button beside it already says Commit, and on a
  // phone every extra word costs a line. The NUMBER is what is being read —
  // it carries the weight, the noun is just its unit.
  $("#savebar-text").replaceChildren(
    h("b", {}, String(n)),
    ` change${n === 1 ? "" : "s"}${f > 1 ? ` · ${f} files` : ""}`,
  );
}

// Every feedback widget has two faces: interactive for the signed-in admin,
// a quiet read-only badge (or nothing) for players.
/* STAR = APPROVE (maintainer 2026-09-03: "you should click approve for me when
 * I click on a star and unapprove when/if I press that same star again. Also
 * if I unapprove you should remove the star. This way I only have to click
 * once on the star").
 *
 * The stars and the verdict judge the SAME id, so they are kept in step
 * through the DOM rather than through a shared closure — they are built by two
 * independent functions and every page arranges them differently. Each widget
 * tags its wrapper with the id it judges and parks its own render; a click on
 * one re-renders the other. The verdict widget also parks its `stamp`, its
 * `onchange` and whether it even HAS an approve button, so a star approves
 * exactly as the button beside it would: with the same art stamp (an unstamped
 * approval would read as "regenerated since" the instant it was written) and
 * the same page hooks. A verdict row with no approve button (a per-take
 * unbind) leaves the stars a plain rating. Detached widgets from a previous
 * render are not in the document, so they are never found — no registry to
 * clean up. */
const fbPeerKey = (domain, id) => `${domain}\u0000${id}`;
function fbTag(wrap, domain, id, kind, render) {
  wrap.dataset.fbk = kind;
  wrap.__fbk = fbPeerKey(domain, id);
  wrap.__render = render;
  return wrap;
}
function fbPeers(domain, id, kind) {
  const k = fbPeerKey(domain, id);
  return [...document.querySelectorAll(`[data-fbk="${kind}"]`)].filter((el) => el.__fbk === k);
}
/** `onStars` fires after a rating is written — the World's inbox filter needs
 *  it, because a tile that has just been starred must LEAVE the list it is
 *  standing in (and nothing else on the page can know that happened). Kept
 *  separate from the verdict's `onchange` so a star never triggers work on the
 *  pages that only care about approve/reject. */
function starsWidget(domain, id, onStars, glyph) {
  // `glyph` swaps the star pair for another mark — the TOP review rates with
  // roofs (⌂), so one glance says WHICH review this row is before any label is
  // read. ⌂ has no filled form, so lit-vs-dim is colour, not shape.
  const g = glyph ?? { lit: "★", dim: "☆", cls: "", name: "star" };
  if (!state.admin) {
    const val = fb(domain, id).rating ?? 0;
    return val ? h("span", { class: `stars ro${g.cls ? ` ${g.cls}` : ""}`, "aria-label": `${val} ${g.name}s` }, g.lit.repeat(val)) : h("span");
  }
  const wrap = h("span", { class: `stars${g.cls ? ` ${g.cls}` : ""}`, role: "radiogroup", "aria-label": "rating" });
  const render = () => {
    const val = fb(domain, id).rating ?? 0;
    wrap.replaceChildren(...[1, 2, 3, 4, 5].map((n) =>
      h("button", {
        class: n <= val ? "lit" : "", title: `${n} ${g.name}${n > 1 ? "s" : ""}`,
        onclick: (e) => {
          e.preventDefault(); e.stopPropagation();
          const cur = fb(domain, id);
          const off = cur.rating === n;        // pressing the star that is already lit
          const v = fbPeers(domain, id, "verdict")[0];
          const patch = { rating: off ? null : n };
          if (v?.__approves !== false) {
            // Un-starring un-approves, but only an approval — a rejection was
            // a separate decision and a star was never what made it.
            if (off) { if (cur.status === "approved") patch.status = null; }
            else { patch.status = "approved"; Object.assign(patch, v?.__stamp ?? {}); }
          }
          setFb(domain, id, patch);
          render();
          if ("status" in patch) { for (const el of fbPeers(domain, id, "verdict")) el.__render?.(); v?.__onstar?.(); }
          onStars?.();
        },
      }, n <= val ? g.lit : g.dim)));
  };
  render();
  return fbTag(wrap, domain, id, "stars", render);
}
// `stamp` rides into every verdict this widget writes — the scenery pages
// pass { art: <sprite hash> } so a verdict records the exact bytes it judged
// (objVerdict's staleness is then byte-exact, immune to invented dates).
/* A VERDICT THE REST OF THE UI NO LONGER COUNTS MUST NOT LOOK CURRENT
 * (maintainer 2026-08-30: "some states is not green even if the state is
 * approved when I click on the state"). The state chip already reads a verdict
 * stamped on art that has since been regenerated as unjudged — that is the
 * rule he asked for — but the row underneath went on drawing its approve
 * button green, so the same fact was told two ways on one screen. Now `stale`
 * rides in from the same facetStale() the chip uses: the buttons drop their
 * current-verdict paint and the row says why, so one tap re-judges the art
 * that is actually on screen and the chip goes green with it. */
/* REMOVE IS RED, EVERYWHERE (maintainer 2026-09-03: "The Remove/Reject button
 * should be made red on all review pages ... I mean the CSS we have closest to
 * red that still follow the CSS styling"). That is the theme's own --bad
 * token, the one the judged-no chips already wear — carried by the
 * `reject-btn` class on every reject button this widget draws.
 *
 * REDO, on the scenery review only for now (same day: "I will go over all
 * scenery and delete everything that is not good enough. But sometimes I
 * might think the object is so good we should try to generate another
 * variant/version"). A third verdict, status "redo": KEEP the piece and ask
 * the producing agent for another variant of it. Distinct from rejected
 * (= remove) and from the per-state "✕ redo", which regenerates ONE state. */
function verdictWidget(domain, id, { onchange, onStarChange = onchange, reject = "✕ remove", rejectTitle = "Reject = the producing agent removes/replaces this on its next run", rejectedLabel = "slated for removal", rejectOnly = false, stamp = null, stale = false, redo = null } = {}) {
  if (!state.admin) {
    const st = fb(domain, id).status;
    if (st === "approved") return h("span", { class: "pill ok" }, "approved");
    if (st === "rejected") return h("span", { class: "pill err" }, rejectedLabel);
    if (st === "redo") return h("span", { class: "pill warn" }, redo?.doneLabel ?? "another variant requested");
    return h("span");
  }
  const wrap = h("span", { class: "verdict" });
  const render = () => {
    // Re-read every render, never captured: judging again re-stamps the record
    // with the art on screen, and the row must stop calling it stale the
    // instant it stops being stale.
    const gone = typeof stale === "function" ? stale() : stale;
    // A stale verdict is shown as what it now IS — a decision about art that
    // is gone — so it paints as undecided until he judges again.
    const st = gone ? null : fb(domain, id).status;
    // NB: replaceChildren stringifies null into a literal "null" text node —
    // the same trap h() guards against. Filter, never pass a bare null.
    wrap.replaceChildren(...[
      // rejectOnly: a per-take unbind on an already-narrow row, where the
      // approval of the binding as a whole lives one row up.
      // Un-approving clears the rating with it (same request): the stars are
      // how the approval was given, so they cannot outlive it. The art stamp
      // rides only when a verdict is actually being SET — an un-approval is
      // not a judgement of any art.
      // APPROVING WITHOUT STARS IS WORTH ONE (maintainer 2026-09-03: "accept
      // should give 1 star if no star has been given already"). An approved
      // piece is never left unrated, so the star filters and the review queue
      // see it; a rating he already gave is never overwritten.
      rejectOnly ? null : h("button", { class: st === "approved" ? "approved" : "", onclick: (e) => {
        e.stopPropagation();
        const un = st === "approved";
        setFb(domain, id, un ? { status: null, rating: null }
          : { status: "approved", ...(fb(domain, id).rating ? {} : { rating: 1 }), ...(stamp ?? {}) });
        render();
        for (const el of fbPeers(domain, id, "stars")) el.__render?.();
        onchange?.();
      } }, "✓ approve"),
      // REMOVE ALWAYS UNSTARS (maintainer 2026-09-03: "Remove should also
      // always 'unstar'"). Removing it is the last thing he will say about it,
      // so a rating left behind would outlive the thing it rated — and on the
      // star filters it would keep reading as a piece he liked.
      h("button", { class: `reject-btn${st === "rejected" ? " rejected" : ""}`, title: rejectTitle, onclick: (e) => {
        e.stopPropagation();
        const on = st === "rejected";
        setFb(domain, id, on ? { status: null } : { status: "rejected", rating: null, ...(stamp ?? {}) });
        render();
        for (const el of fbPeers(domain, id, "stars")) el.__render?.();
        onchange?.();
      } }, reject),
      redo ? h("button", { class: `redo-btn${st === "redo" ? " redo" : ""}`, title: redo.title ?? "Keep this, and ask for another variant of it",
        onclick: (e) => { e.stopPropagation(); setFb(domain, id, { status: st === "redo" ? null : "redo", ...(stamp ?? {}) }); render(); onchange?.(); } }, redo.label ?? "↻ redo") : null,
      gone ? h("span", { class: "pill warn", title: "You judged this state before the art was regenerated, so the verdict is about a picture that no longer exists — judge the one on screen and it counts again." }, "regenerated since — judge again") : null,
    ].filter(Boolean));
  };
  render();
  fbTag(wrap, domain, id, "verdict", render);
  wrap.__approves = !rejectOnly;
  wrap.__stamp = stamp;
  wrap.__onchange = onchange;
  /* WHAT A STAR IS ALLOWED TO SET OFF. A star now writes the approval too, so
   * it reaches this row's onchange — and on the details tab that meant a
   * re-route, which is exactly the bug he reported on 2026-08-28 ("I can't see
   * it getting any stars ... the 'x changes' just keep counting up"): the
   * judged card left the queue and the next one slid under his thumb. An
   * explicit press on approve may still move the card (he asked for that too);
   * a star may not. Defaults to onchange, so a page that does something cheap
   * needs to say nothing. */
  wrap.__onstar = onStarChange;
  return wrap;
}
function noteWidget(domain, id) {
  if (!state.admin) return null;
  const ta = h("textarea", { class: "fb-note", placeholder: "Note for the producing agent (optional)…", rows: "1" });
  ta.value = fb(domain, id).note ?? "";
  ta.addEventListener("change", () => setFb(domain, id, { note: ta.value.trim() || null }));
  return ta;
}
// The per-facet feedback block: one row, under the preview, with a word for
// what it judges. The long caption ("Feedback on this animation (state)") was
// removed in July at the maintainer's request, and the row then read as a
// second whole-entity verdict — he reported on 2026-08-14 that he could not
// give feedback per animation at all, on a page that had carried it for six
// weeks. A two-word label is the middle ground.
/** Everything that judges the facet on screen, ABOVE the preview and above the
 *  selectors — "I want it in the same card but OVER the preview" (maintainer
 *  2026-08-14). The whole ENTITY is still judged further up, in the page
 *  header outside this card; this block judges only the one state+direction
 *  named in its pill. */
function facetHead(pillBox, box) {
  if (!state.admin) return null;
  return h("div", { class: "facet-head" },
    h("div", { class: "facet-head-line" }, h("span", { class: "muted facet-label" }, "Judging"), pillBox),
    box);
}
/** The pill that says exactly which generated file is being judged. */
const facetName = (st, dir) => h("span", { class: "pill", title: `${st} · ${dir}` },
  `${stateLabel(st)} · ${DIR_LABEL[dir] ?? dir}`);
function feedbackRow(domain, id, opts = {}) {
  return h("div", { class: "fb-row" },
    starsWidget(domain, id, opts.onStars, opts.glyph),
    verdictWidget(domain, id, opts),
    opts.note === false ? null : noteWidget(domain, id));
}

/* ---------------------------------------------- saving (game server API) */
// The browser never talks to GitHub. Saves POST a per-entry DELTA to the
// game server, which merges it into the current document, commits live/**
// to main with ITS OWN token, and pushes the change to every game client.
const FILE_FOR = (key) => key.startsWith("feedback/")
  ? { path: `live/${key}.json`, get: () => state.feedback[key.split("/")[1]] }
  : { path: `live/tuning/${key.split("/")[1]}.json`, get: () => state.tuning[key.split("/")[1]] };

// The current local value of one touched id inside a file (null = deleted).
function valueOf(key, id) {
  const doc = FILE_FOR(key).get() ?? {};
  const bucket = key.startsWith("feedback/") ? doc.entries
    : key === "tuning/monsters" ? doc.monsters
    : key === "tuning/sfx_requests" ? doc.requests
    // One entry per GROUND, not per tile — a set that holds no tiles (Clean #0)
    // has to be representable, and a tile-keyed bucket cannot hold one.
    : key === SETS_KEY ? doc.grounds
    : doc.overrides;
  const v = bucket?.[id];
  return v === undefined ? null : v;
}
async function apiSaveFile(key) {
  const snapshot = new Set(state.touched[key] ?? []);
  if (!snapshot.size) { state.dirty.delete(key); return; }
  // Absent-but-never-cleared ids are DROPPED from the save, not sent as
  // deletions — see touch(). They are also forgotten locally: there is nothing
  // of his to keep dirty for them.
  const explicitlyCleared = state.cleared?.[key] ?? new Set();
  const set = {};
  let skipped = 0;
  for (const id of snapshot) {
    const v = valueOf(key, id);
    if (v === null && !explicitlyCleared.has(id)) { skipped++; continue; }
    set[id] = v;
  }
  if (skipped) console.warn(`[wiki] ${key}: ${skipped} touched id(s) had no value and were never cleared by you — not sent as deletions`);
  if (!Object.keys(set).length) {
    const t0 = state.touched[key]; if (t0) { for (const id of snapshot) t0.delete(id); if (!t0.size) delete state.touched[key]; }
    if (!state.touched[key]) state.dirty.delete(key);
    return;
  }
  const res = await fetch(API("/api/wiki/save"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken()}` },
    body: JSON.stringify({ file: key, set }),
  });
  if (res.status === 401) {
    // The session is genuinely over — a week has passed, or the server's
    // secret was rotated. (It is no longer "the server restarted": sessions
    // are signed and survive deploys since 2026-08-06.) KEEP the unsaved
    // edits: drop only the dead token; re-login then re-saves them.
    localStorage.removeItem("wiki-admin-token");
    setAdmin(false, { keepEdits: true });
    throw new Error("session expired — sign in again, your edits are kept");
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  // Only forget ids saved in THIS pass so edits made mid-save stay dirty.
  const t = state.touched[key];
  if (t) { for (const id of snapshot) t.delete(id); if (!t.size) delete state.touched[key]; }
  const c = state.cleared?.[key]; if (c) for (const id of snapshot) c.delete(id);
  if (!state.touched[key]) state.dirty.delete(key);
}
async function saveAll() {
  if (!state.admin) { $("#login-dialog").showModal(); return; }
  const btn = $("#save-btn");
  const n = pendingCount();          // read BEFORE saving empties `touched`
  btn.disabled = true; btn.textContent = "Committing…";
  try {
    for (const key of [...state.dirty]) {
      await apiSaveFile(key);
      updateSavebar();
    }
    toast(`Committed ${n} change${n === 1 ? "" : "s"} — pushed to the repo and live to the game.`);
    route();
  } catch (err) {
    console.error(err);
    toast(`Commit failed: ${err.message}`);
    if (!state.admin) $("#login-dialog").showModal();
  } finally {
    btn.disabled = false; btn.textContent = "Commit";
  }
}
async function discardAll() {
  state.dirty.clear();
  state.touched = {};
  state.cleared = {};
  await loadLiveFiles();
  updateSavebar();
  route();
  // "Cancel", never "Discard" (maintainer 2026-08-14: "Discard for me sounds
  // like 'discard all scenery objects'"). It throws away the pending verdicts
  // and nothing else — worth saying, since the button sits next to a page
  // full of art.
  toast("Cancelled — your uncommitted changes are back to what the game has.");
}

/* ---------------------------------------------- the monster's ONE shadow (admin)
 * Maintainer 2026-08-20, replacing the per-facet shadow notes: "Lets say you
 * have something long and thin. I can create this shadow in S, N, E and W. But
 * not the other monster directions. So what I want is just a single shadow
 * size for the entire monster ... if I change the size in S animation it will
 * change for all directions in all animations. The trick is to rotate the
 * shadow around the center using the current monster direction. The goal is to
 * get the game to use this shadow and the center of the shadow will be the
 * monsters position. The size will be the monsters hit box."
 *
 * So the record is ONE ellipse per monster — not per state, not per direction
 * — and it lives INSIDE the monster's entry in live/tuning/monsters.json,
 * because it is game tuning exactly like max_hp: the game draws its shadow
 * from it, anchors the sprite on its centre, and derives the body radius from
 * its size. The old pixel-wiki-shadow-notes@1 doc is FROZEN as the training
 * data it always was; the wiki no longer writes it.
 *
 *   shadow: { rx, ry, ax, ay }     — frame px at scale 1 (art px ≈ wu)
 *
 *   rx, ry  semi-axes of the ellipse AS SEEN FACING SOUTH.
 *   ax, ay  the shadow centre — which IS the monster's world position —
 *           relative to the FRAME CENTRE, +x right, +y down. Centre-relative
 *           on purpose: it stays meaningful whatever padding the frame has,
 *           and it is the point the art rotates around when the facing turns.
 *
 * THE ROTATION IS ON THE GROUND, NOT ON THE SCREEN. The iso view squashes
 * ground-vertical by K = ISO_DY/ISO_DX (15/32 — data.iso, the game's own
 * projection). Rotating the drawn ellipse in screen space would put the squash
 * on the wrong axis the moment the monster turns: a long-thin body tuned at
 * S as (rx 10, ry 30) must show E as (ry/K, rx·K) ≈ (64, 4.7) — longer AND
 * flatter — not the naive quarter-turn (30, 10). So: unsquash the tuned depth,
 * rotate by the facing's GROUND angle, re-squash. The affine of a circle is an
 * ellipse again; the closed-form decomposition below turns it into radii + a
 * screen rotation that canvas and Phaser can both draw directly.
 * games2/shared/src/monsters.ts carries the same function for the game —
 * check-shadow.mjs holds the two implementations equal. */
const MTUNE_KEY = "tuning/monsters";
const isoK = () => (state.data.iso?.dy ?? 15) / (state.data.iso?.dx ?? 32);
const DIR_VEC = {
  south: [0, 1], "south-west": [-1, 1], west: [-1, 0], "north-west": [-1, -1],
  north: [0, -1], "north-east": [1, -1], east: [1, 0], "south-east": [1, 1],
};
/** The screen ellipse for a facing: radii p ≥ q and a rotation, from the
 *  south-tuned (rx, ry). Pure function of the record and the direction. */
function shadowEllipse(rx, ry, dir) {
  const K = isoK();
  const [vx, vy] = DIR_VEC[dir] ?? [0, 1];
  const a = Math.atan2(vx, vy / K);      // the facing's angle on the GROUND
  const ryg = ry / K;                    // the tuned depth, unsquashed
  // scale(1,K) · rot(a) · diag(rx, ry/K), applied to a unit circle:
  // SIGN MATTERS AND ONLY THE DIAGONALS SHOW IT (maintainer 2026-08-20, from
  // his phone mid-tuning: "The shadow is rotating wrong so its perpendicular
  // to the body, but correct S, E, N, W"). The rotation must carry the along
  // axis from screen-down TOWARD the facing vector: R·(0,1) = (sin a, cos a).
  // The textbook CCW matrix gives (−sin a, cos a) — correct in y-up maths,
  // mirrored on a y-down screen — and every cardinal hides it because its
  // tilt is 0° or 90° either way.
  const m00 = Math.cos(a) * rx, m01 = Math.sin(a) * ryg;
  const m10 = -K * Math.sin(a) * rx, m11 = K * Math.cos(a) * ryg;
  const E = (m00 + m11) / 2, F = (m00 - m11) / 2, G = (m10 + m01) / 2, H = (m10 - m01) / 2;
  const Q = Math.hypot(E, H), R = Math.hypot(F, G);
  return { p: Q + R, q: Math.abs(Q - R), theta: (Math.atan2(G, F) + Math.atan2(H, E)) / 2 };
}
/** The widest/deepest the ellipse gets over ALL facings — the canvas box uses
 *  these so turning the monster never resizes anything. */
const shadowExtents = (rx, ry) => {
  const K = isoK();
  return { x: Math.max(rx, ry / K), y: Math.max(ry, rx * K) };
};
/** Starting point for an untuned monster, from the measured art metrics — the
 *  same numbers the game's legacy shadow uses, mapped into the new record so
 *  his tuning starts from what he already sees in game. */
function shadowDefault(entity) {
  const fw = entity.frameW ?? 64, fh = entity.frameH ?? 64;
  const w = entity.shadow?.w ?? Math.round(fw * 0.54);
  const hh = entity.shadow?.h ?? Math.max(6, Math.round(w * 0.385));
  return {
    rx: +(w / 2).toFixed(2), ry: +(hh / 2).toFixed(2),
    ax: 0,
    ay: +(((entity.artBottom ?? 0.85) * fh + (entity.hoverPx ?? 0)) - fh / 2).toFixed(2),
  };
}
/* ---- THE SCENERY HITBOX (maintainer 2026-08-27) -------------------------
 * "The monsters today have good UX for me to set an explicit nadir shadow.
 * This shadow also works as a hitbox and tells the game when to render the
 * monster on top of VS under the player. We need the same for Scenery."
 *
 * FOUR THINGS MAKE IT NOT A MONSTER SHADOW, and each is in the model:
 *
 *  1. IT IS NOT A SHADOW and is never drawn. "This scenery nadir 'shadow' is
 *     also not a shadow. This is just a hitbox and a way for the game to
 *     change rendering order." So it is called a hitbox everywhere, and the
 *     editor draws it as an outline the game will not paint.
 *  2. THERE CAN BE SEVERAL. "The Scenery might have two collisions and not
 *     just one ... for example when the scenery is an entrance with two
 *     pillars touching the ground." A list, not a record.
 *  3. EACH ONE ROTATES. "A scenery that need a hitbox is always facing south.
 *     But the ellips might still need a rotation to fit the object." A monster
 *     shadow turns with the facing and never needed one; scenery does not turn
 *     and does.
 *  4. NONE IS A REAL ANSWER. "Some scenery is meant to be placed on a house/
 *     mountain/cave wall - they ofc need no hitbox." 134 of the 739 pieces are
 *     MOUNTAIN_WALL or WINDOW. So an EMPTY LIST is a decision, and the absence
 *     of a record is a different thing — not yet looked at. Collapsing those
 *     two would make the review filter unable to say what is left to do, which
 *     is the whole reason he asked for the filter.
 *
 * Units are FRAME PIXELS with the origin at the frame's CENTRE — the same
 * quantity a monster's nadir shadow speaks, so what he reads here and what the
 * game resolves are one number. Per PIECE, not per direction: 679 of 739 are
 * south-only and the footprint is the ground it stands on, which does not turn
 * with the art.
 *
 * STORED IN SCREEN SPACE, WHICH IS NOT WHERE A MONSTER'S IS. A monster's
 * rx/ry are ground-space, tuned facing south, and the game unsquashes,
 * rotates and re-squashes them per facing (shadowEllipse / shadowScreenEllipse
 * in games2/shared). Scenery never turns, so there is nothing to rotate
 * through — and he is fitting the ellipse to the art with his eye, so what he
 * draws must be what is stored. A consumer wanting the GROUND footprint
 * divides ry by isoK(); the default starts at a ground circle for that reason.
 * Written down because a space nobody names is the kind of thing two agents
 * each assume differently and neither finds out.
 */
/* IS THIS PIECE WALL SCENERY? The agent's tag, with his correction on top
 * (maintainer 2026-08-28: "you have tagged some scenery as wall scenery that
 * is not wall scenery and I can also find scenery that IS wall scenery, but
 * you think it's not ... It would be good if I can change an object from
 * being treated as wall scenery so I can fix errors like this during the
 * review"). Wall scenery hangs on a wall: no hitbox, never y-sorted against
 * the player. Absent means the tag is right — the file only ever names his
 * corrections, and the scenery agent re-files the piece and deletes the
 * entry, the same contract as scenery_lights. */
const SCWALL_KEY = "tuning/scenery_walls";
const sceneryWalls = () => state.tuning.scenery_walls
  ?? (state.tuning.scenery_walls = { format: "pixel-wiki-scenery-walls@1", updated_at: "", overrides: {} });
const WALL_TYPES = new Set(["MOUNTAIN_WALL", "WINDOW"]);
const taggedWall = (o) => WALL_TYPES.has(o?.type);
function isWallScenery(o) {
  const ov = sceneryWalls().overrides?.[o?.path];
  return typeof ov?.wall === "boolean" ? ov.wall : taggedWall(o);
}
function setWallScenery(o, wall) {
  const doc = sceneryWalls();
  doc.overrides ??= {};
  // Choosing what the tag already says DELETES the correction — absent means
  // the tag is right, so agreeing with it must not leave a phantom entry.
  if (wall === taggedWall(o)) delete doc.overrides[o.path];
  else doc.overrides[o.path] = { wall, was: o.type ?? null, updated_at: new Date().toISOString() };
  doc.updated_at = new Date().toISOString();
  touch(SCWALL_KEY, o.path);
  markDirty(SCWALL_KEY);
}
const HITBOX_KEY = "tuning/scenery_hitbox";
const HIT_ALWAYS_KEY = "wiki-hitbox-always";
const hitAlwaysShow = () => { try { return localStorage.getItem(HIT_ALWAYS_KEY) === "1"; } catch { return false; } };
const hitboxDoc = () => state.tuning.scenery_hitbox
  ?? (state.tuning.scenery_hitbox = { format: "pixel-wiki-scenery-hitbox@1", updated_at: "", overrides: {} });
/** The piece's key — its path, the same key scenery_lights uses. */
/* ONE HITBOX PER VARIATION (maintainer 2026-08-29: "You don't store one
 * hitbox per variation ... when I change the hitbox on a variation it changes
 * on ALL variations/states. This is bad because different variations can be
 * different size."). The key carries the state: "<path>#<state>". A record
 * under the BARE path is the piece-level default the first pass wrote; it
 * still answers for a variation with none of its own, so nothing already
 * decided is lost and no variation is suddenly blank. */
const hitboxKey = (entity, state) => {
  const p2 = entity?.path ?? entity?.id ?? null;
  if (!p2) return null;
  return state ? `${p2}#${state}` : p2;
};
/** Every variation of a piece, in the order its card shows them. */
const hitboxStates = (entity) => Object.keys(entity?.animations ?? {});
/** The stored record, or null when nobody has decided yet. */
function hitboxRaw(entity, state) {
  const ov = hitboxDoc().overrides ?? {};
  const own = state ? ov[hitboxKey(entity, state)] : null;
  const r = own ?? ov[hitboxKey(entity)];
  return r && Array.isArray(r.boxes) ? r : null;
}
/** Normalised boxes; [] means "decided: none". null means undecided. */
function hitboxes(entity, state) {
  const r = hitboxRaw(entity, state);
  if (!r) return null;
  return r.boxes
    .filter((b) => b && ["ax", "ay", "rx", "ry"].every((k) => isFinite(b[k])) && b.rx > 0 && b.ry > 0)
    /* SHAPE RIDES WITH THE BOX (maintainer 2026-08-30: "town and indoor often
     * have hitboxes that needs a rect and not an ellipse ... a table or
     * bookshelf ... the map-agent can then make use of the perfect hitbox to
     * place the furniture in a corner or against the wall"). Absent means
     * ellipse — every record written before today, and every round footprint
     * since, so nothing has to be migrated and no consumer has to guess. */
    .map((b) => ({ ax: +b.ax, ay: +b.ay, rx: +b.rx, ry: +b.ry, rot: isFinite(b.rot) ? +b.rot : 0,
      ...(b.shape === "rect" || b.shape === "ellipse" ? { shape: b.shape } : {}),
      ...(b.rot_by_dir && typeof b.rot_by_dir === "object" ? { rot_by_dir: { ...b.rot_by_dir } } : {}),
      ...(b.pos_by_dir && typeof b.pos_by_dir === "object" ? { pos_by_dir: { ...b.pos_by_dir } } : {}),
      ...(b.size_by_dir && typeof b.size_by_dir === "object" ? { size_by_dir: { ...b.size_by_dir } } : {}) }));
}
/* WHERE A FIRST ELLIPSE STARTS, from the art's own measured content box —
 * `bb` [x0,y0,x1,y1] in frame pixels, published per state+direction. A piece
 * stands on the bottom of its own silhouette, so the ellipse starts centred on
 * the box horizontally, sitting at its foot, as wide as the box and squashed
 * by the iso foreshortening the ground actually has. It is a starting point to
 * drag from, never a decision: nothing is stored until he touches it. */
/* A RECT PIECE'S DEFAULT IS FITTED TO ITS OWN FOOTPRINT (maintainer
 * 2026-09-03, after fitting a chest by hand: "In SE it's easy to find the
 * back-left (left), front-left (bottom) and front-right (right) corners. I
 * adjusted the hitbox to perfectly capture all corners … By using this
 * pattern, you should be able to place really really good default hitboxes
 * for rect objects").
 *
 * build.mjs measures those three corners off the silhouette and publishes them
 * per facing (`hitboxBase`). Here they become the box: the centre is the
 * midpoint of the left and right corners, and the two ground extents come from
 * solving the corner against the facing's own projection — one small 2×2, no
 * guessing. SIZE is taken from the turned facings, where the depth is actually
 * visible; SOUTH cannot show depth at all, so it inherits the size and only
 * its placement is measured (bottom edge on the lowest contact pixel).
 *
 * Checked against his own hand-made box on cupboard_010: fitted rx 40.8 / ry
 * 7.08 against his 41.25 / 7.75, centre within 0.2px on south-east. */
function fittedRectDefault(entity, state, W, H) {
  if (taggedShape(entity) !== "rect") return null;
  const dirs = entity?.animations?.[state]?.dirs ?? {};
  const k = ISO_K();
  const fitOne = (dname) => {
    const b = dirs[dname]?.base;
    if (!Array.isArray(b) || b.length !== 6) return null;
    const [Lx, Ly, Bx, By, Rx, Ry] = b;
    const th = -(DIR_GROUND_DEG[dname] ?? 0) * Math.PI / 180;
    const eu = [Math.cos(th), Math.sin(th) * k], ev = [-Math.sin(th), Math.cos(th) * k];
    const C = [(Lx + Rx) / 2, (Ly + Ry) / 2], d = [Rx - C[0], Ry - C[1]];
    const det = eu[0] * ev[1] - eu[1] * ev[0];
    if (!det) return null;
    const p = (d[0] * ev[1] - d[1] * ev[0]) / det, q = (eu[0] * d[1] - eu[1] * d[0]) / det;
    return { rx: Math.abs(p), ry: Math.abs(q) * k, cx: C[0], cy: C[1], by: By };
  };
  const turned = ["south-east", "south-west"].map(fitOne).filter((f) => f && f.rx > 3 && f.ry > 1);
  if (!turned.length) return null;
  const rx = turned.reduce((n, f) => n + f.rx, 0) / turned.length;
  const ry = turned.reduce((n, f) => n + f.ry, 0) / turned.length;
  const pos = {};
  for (const dname of ["south-east", "south-west"]) {
    const f = fitOne(dname);
    if (f) pos[dname] = { ax: +(f.cx - W / 2).toFixed(2), ay: +(f.cy - H / 2).toFixed(2) };
  }
  const south = fitOne("south");
  const sx = south ? south.cx : W / 2, sy = south ? south.by - ry : H * 0.75;
  return {
    ax: +(sx - W / 2).toFixed(2), ay: +(sy - H / 2).toFixed(2),
    rx: +rx.toFixed(2), ry: +Math.max(2, ry).toFixed(2), rot: 0, shape: "rect",
    ...(Object.keys(pos).length ? { pos_by_dir: pos } : {}),
  };
}
function hitboxDefault(entity, bb, fw, fh, state) {
  const W = fw ?? entity.size ?? 96, H = fh ?? entity.size ?? 96;
  // A rect piece is fitted to the footprint measured on THIS state's own art —
  // the states of one piece are often different variants.
  const fitted = fittedRectDefault(entity, state, W, H);
  if (fitted) return fitted;
  const box = Array.isArray(bb) && bb.length === 4 ? bb : [W * 0.2, H * 0.2, W * 0.8, H * 0.9];
  const cx = (box[0] + box[2]) / 2, foot = box[3];
  const w = Math.max(6, box[2] - box[0]);
  return {
    ax: +(cx - W / 2).toFixed(2),
    // Seated a little above the very bottom pixel: art usually has a row or
    // two of contact shadow or grass the piece is standing IN, not ON.
    ay: +(foot - H / 2 - Math.max(1, w * 0.06)).toFixed(2),
    rx: +(w / 2).toFixed(2),
    ry: +Math.max(3, (w / 2) * isoK()).toFixed(2),
    rot: 0,
  };
}
/* THE GROUND IS SEEN AT AN ANGLE, so a circle on it is an ellipse on screen —
 * and the squash comes from THE GAME'S OWN LATTICE, isoK(), the same function
 * the monster shadow uses. I first wrote 14/32 here from the tiles 3.0 pitch;
 * the game ships dy=15, so every default would have been 7% too shallow and he
 * would have corrected the same error on 739 pieces. Scenery is placed and
 * drawn by the GAME, so the game's number is the right one, and reading it
 * rather than restating it means the day ISO_DY becomes 14 this follows. */

/** Write one piece's boxes. [] is a real answer — "this needs none". */
function setHitboxes(entity, boxes, state) {
  const k = hitboxKey(entity, state);
  if (!k) return;
  const doc = hitboxDoc();
  (doc.overrides ??= {})[k] = {
    boxes: boxes.map((b) => ({
      ax: +(+b.ax).toFixed(2), ay: +(+b.ay).toFixed(2),
      rx: +(+b.rx).toFixed(2), ry: +(+b.ry).toFixed(2),
      rot: +(((+b.rot || 0) % 360 + 360) % 360).toFixed(1),
      // Written only where he DISAGREES with the domain's per-piece
      // hitbox_shape, so the file names exceptions and the 3,673 records
      // already on it stay byte-identical. Both spellings are meaningful:
      // "ellipse" on a rect-tagged bookshelf is a real correction.
      ...(b.shape === "rect" || b.shape === "ellipse" ? { shape: b.shape } : {}),
      // Only the facings he has aligned BY HAND; every other facing is the
      // derived tilt and stays out of the file.
      ...(b.rot_by_dir && Object.keys(b.rot_by_dir).length
        ? { rot_by_dir: Object.fromEntries(Object.entries(b.rot_by_dir)
            .filter(([, v]) => isFinite(v)).map(([d2, v]) => [d2, +(+v).toFixed(1)])) }
        : {}),
      // Only the facings he has actually MOVED; the rest inherit ax/ay.
      // Only the facings he has opted OUT of the shared size.
      ...(b.size_by_dir && Object.keys(b.size_by_dir).length
        ? { size_by_dir: Object.fromEntries(Object.entries(b.size_by_dir)
            .filter(([, v]) => v && isFinite(v.rx) && isFinite(v.ry))
            .map(([d2, v]) => [d2, { rx: +(+v.rx).toFixed(2), ry: +(+v.ry).toFixed(2) }])) }
        : {}),
      ...(b.pos_by_dir && Object.keys(b.pos_by_dir).length
        ? { pos_by_dir: Object.fromEntries(Object.entries(b.pos_by_dir)
            .filter(([, v]) => v && isFinite(v.ax) && isFinite(v.ay))
            .map(([d2, v]) => [d2, { ax: +(+v.ax).toFixed(2), ay: +(+v.ay).toFixed(2) }])) }
        : {}),
    })),
    updated_at: new Date().toISOString(),
  };
  doc.updated_at = new Date().toISOString();
  touch(HITBOX_KEY, k);
  markDirty(HITBOX_KEY);
}
/** Back to undecided — the record goes, not an empty list. */
function clearHitbox(entity, state) {
  const k = hitboxKey(entity, state);
  if (!k) return;
  delete hitboxDoc().overrides?.[k];
  hitboxDoc().updated_at = new Date().toISOString();
  touch(HITBOX_KEY, k);
  markDirty(HITBOX_KEY);
}
/* THE REVIEW STATE OF ONE PIECE, which is what the filter counts.
 * "Filter on Scenery objects not having a hitbox VS having a hitbox" — with
 * the third state he did not name but needs: the ones nobody has judged. */
/* WALL SCENERY CANNOT HAVE A HITBOX, BY TYPE (maintainer 2026-08-28: "Windows
 * is placed on walls. Everything that is placed on a wall doesn't have a
 * hitbox and should not be part of 'no hitbox yet'. It should also not be part
 * of 'hitbox set'."). The scenery agent already classifies every piece, so the
 * answer for these 134 is carried by the TYPE and needs no review — putting
 * them in the to-do queue was asking him to hand-mark, one by one, a fact the
 * data has known all along. Decided by type BEFORE any stored record, so a
 * stray record on a wall piece cannot pull it back into a queue. */
/* …AND THE TYPE IS SOMETIMES WRONG, both ways (maintainer 2026-08-28: "you
 * have tagged some scenery as wall scenery that is not wall scenery and I can
 * also find scenery that IS wall scenery, but you think it's not"). So the
 * predicate lives above, override-aware: his correction in scenery_walls
 * outranks the tag, and correcting a piece moves it in and out of the hitbox
 * queue and the editor with no further marking. */
/* AN AUTO-PLACED DEFAULT IS A PROPOSAL, NOT A VERDICT (maintainer
 * 2026-08-28: "It's only if I accept the default or edit it manually, the
 * scenery object is marked/tagged as 'hitbox set'. Your default hitbox does
 * not count"). The 2026-08-28 alpha pass wrote every undecided piece a
 * footprint with auto:true; accepting or editing rewrites the record without
 * the flag, which is what "set" means. */
const hitboxAuto = (entity, state) => hitboxRaw(entity, state)?.auto === true;
/* NO COLLISION — A CARPET (maintainer 2026-08-29: "It must also be able to
 * mark an object as no collision/collision less ... a carpet or something
 * else flat on the floor"). An empty hitbox already said "nothing to collide
 * with", but not WHY, and the two whys differ for the game: a WINDOW hangs on
 * a wall the player walks past, a carpet lies on the ground they walk ON.
 *
 * THE SCENERY DOMAIN OWNS THE FACT ("The scenery is adding this no collision
 * as metadata right now") — same arrangement as wall scenery, because it is
 * a property of the piece, not a review verdict. The wiki reads their tag and
 * lets him CORRECT it; agreeing with the tag deletes the correction, so the
 * file only ever names exceptions. Piece-level: a carpet is a carpet in every
 * state, and the per-variation resolver already falls back to the bare key. */
const taggedFlat = (o) => o?.noCollision === true;
/* THE SHAPE A PIECE'S FOOTPRINT DEFAULTS TO (scenery agent, 2026-09-02:
 * `hitbox_shape`, 131 rect / 576 ellipse). The domain states the fact — a
 * bookshelf is boxy whoever looks at it — and his per-BOX choice in the tuning
 * file outranks it, exactly as with the collision flag. Resolution, for every
 * consumer: box.shape ?? piece.hitbox_shape ?? "ellipse". */
const taggedShape = (o) => (o?.hitboxShape === "rect" ? "rect" : "ellipse");
/* A RECT TURNS WITH THE PIECE (maintainer 2026-09-02: "The default hitbox for
 * objects that is rect should rotate with SE, SW the same amount the object
 * rotates (same as we do for monsters) ... we only have one width and height.
 * The rotation should be pre-adjusted").
 *
 * The ground turn is 45° per step of the compass; on screen that is NOT 45°,
 * because the ground is squashed. A ground direction (cosθ, sinθ) lands at
 * (cosθ, k·sinθ) with k = dy/dx, so the screen angle is atan2(k·sinθ, cosθ) —
 * 25.1° for a south-east turn at today's 15/32, not 45°. The same arithmetic
 * the game already does for a monster's shadow, read from data.json's own iso
 * block so the day the projection changes this follows it.
 *
 * ELLIPSES ARE LEFT ALONE: a footprint with no corners reads the same turned,
 * and he asked for this about rects. */
const DIR_GROUND_DEG = {
  south: 0, "south-east": 45, east: 90, "north-east": 135,
  north: 180, "north-west": -135, west: -90, "south-west": -45,
};
function facingTilt(dir) {
  const th = DIR_GROUND_DEG[dir];
  if (!th) return 0;                       // south, or a facing we do not know
  const k = (state.data?.iso?.dy ?? 15) / (state.data?.iso?.dx ?? 32);
  const r = th * Math.PI / 180;
  /* THE SIGN IS NEGATIVE, and it cost a round trip to learn (maintainer
   * 2026-09-02: "The rotation you did for SE and SW is the wrong direction").
   * I picked it from a measurement of the silhouette's BOTTOM EDGE, which on a
   * turned box is the front face nearest the camera — roughly PERPENDICULAR to
   * the footprint's long axis, so it reported the mirror of the answer. A
   * south-east piece's footprint runs up to the right on screen. */
  return -Math.atan2(k * Math.sin(r), Math.cos(r)) * 180 / Math.PI;
}
/* THE ANGLE THIS BOX IS DRAWN AT, for one facing. `rot` is the SOUTH angle he
 * tuned; a rect adds the facing's tilt. `rot_by_dir` is his correction for one
 * facing — the art is not always turned the way the compass says (measured
 * 2026-09-02 across 14 rect pieces: most mirror cleanly, four are turned the
 * other way), so aligning one facing by hand must be storable without moving
 * the others. */
/* A RECT IS A GROUND RECTANGLE, DRAWN IN PERSPECTIVE (maintainer 2026-09-03,
 * with a drawing on "Map chest of wide flat drawers 010" facing SE: "The
 * hitbox you made by default was not rotated enough and the 3D perspective
 * requires the shape to be a bit different ... I want the hitbox to transform
 * into this perspective so it can capture the furniture's contour").
 *
 * What he drew is a PARALLELOGRAM, and that is what the geometry says: a box
 * standing on the ground, turned 45°, does not project to a rotated screen
 * rectangle under the iso squash — its edges follow the two ground axes, one
 * down-right at atan(dy/dx) = 25.1°, one up-right at the same. The old model
 * rotated a screen rectangle by that 25.1° and could never meet the drawer
 * front and the side at once.
 *
 * So for a rect, `rot` and `rot_by_dir` are GROUND degrees, the half-extents
 * are ground half-extents (rx as stored, ry/k), the corners are rotated on the
 * ground and projected by (x, k·y). South, unturned, projects to the screen
 * rectangle rx × ry that was always stored — every existing record means what
 * it meant. A facing adds its 45° step on the ground (south-east −45°, the
 * sign measured the same way the tilt's was). Ellipses are untouched. */
const ISO_K = () => (state.data?.iso?.dy ?? 15) / (state.data?.iso?.dx ?? 32);
function boxRot(o, b, dir) {
  const own = b?.rot_by_dir?.[dir];
  if (isFinite(own)) return +own;
  const base = isFinite(b?.rot) ? +b.rot : 0;
  return boxShape(o, b) === "rect" ? base - (DIR_GROUND_DEG[dir] ?? 0) : base;
}
/* WHERE THE BOX SITS IS PER FACING (maintainer 2026-09-03: "when I move the
 * hitbox on the S direction it also moves on SE and SW. It's only the W and D
 * that is identical for all directions, not the exact placement I do with
 * move. The move tool is per direction!"). The art's anchor is not the same
 * point on every facing — a chest drawn facing south-east stands a few pixels
 * off where its south frame puts it — so the SIZE is one decision for the
 * piece and the PLACEMENT is one per facing. `ax`/`ay` are the base (south);
 * `pos_by_dir[dir]` is his placement for that facing, written only where he
 * has moved it. Same arrangement as rot_by_dir. */
function boxPos(b, dir) {
  const own = b?.pos_by_dir?.[dir];
  if (own && isFinite(own.ax) && isFinite(own.ay)) return { ax: +own.ax, ay: +own.ay };
  return { ax: +(b?.ax ?? 0), ay: +(b?.ay ?? 0) };
}
/* SIZE IS SHARED UNTIL HE ASKS OTHERWISE (maintainer 2026-09-03, after his own
 * formula produced a box that was right on south-east and wrong on south:
 * "Some art just looks that way and we can't do anything about it. We need a
 * dedicated W and D for the S direction. But to make this good we should add
 * that as an opt-in ... 'request unique size' when standing on the S
 * direction. Or 'go back to shared size'").
 *
 * MEASURED, and it is the art: 54 of the 131 rect pieces have a south view
 * whose footprint disagrees with their own turned views — bed_002's turned
 * views imply a base 105 wide, its south shows 70 — so one rectangle cannot
 * satisfy every facing and no amount of fitting will make it. `size_by_dir`
 * carries the exception for a facing he has opted in, and nothing else
 * changes: absent means the shared rx/ry, which is still the rule for the
 * three quarters of the library whose art agrees with itself. */
/** "south-east" → "south-east", for a button's own words. */
const dirWordOf = (d) => String(d ?? "").replace(/-/g, " ");
function boxSize(b, dir) {
  const own = b?.size_by_dir?.[dir];
  if (own && isFinite(own.rx) && isFinite(own.ry)) return { rx: +own.rx, ry: +own.ry, unique: true };
  return { rx: +(b?.rx ?? 0), ry: +(b?.ry ?? 0), unique: false };
}
/** The four corners of a rect box on screen, in frame px from the box centre. */
function rectCorners(o, b, dir) {
  const k = ISO_K();
  const th = boxRot(o, b, dir) * Math.PI / 180;
  const c = Math.cos(th), sn = Math.sin(th);
  const sz = boxSize(b, dir);
  const gx = sz.rx, gy = sz.ry / k;                    // ground half-extents
  return [[-gx, -gy], [gx, -gy], [gx, gy], [-gx, gy]].map(([x, y]) => {
    const rx2 = x * c - y * sn, ry2 = x * sn + y * c;   // turned on the ground
    return [rx2, ry2 * k];                                // projected
  });
}
const boxShape = (o, b) => (b?.shape === "rect" || b?.shape === "ellipse" ? b.shape : taggedShape(o));
const hitboxFlat = (entity) => {
  const ov = hitboxDoc().overrides?.[hitboxKey(entity)]?.no_collision;
  return typeof ov === "boolean" ? ov : taggedFlat(entity);
};
function setHitboxFlat(entity, on) {
  const k = hitboxKey(entity);
  if (!k) return;
  const doc = hitboxDoc();
  doc.overrides ??= {};
  if (on === taggedFlat(entity)) delete doc.overrides[k];
  else doc.overrides[k] = { boxes: [], no_collision: on, updated_at: new Date().toISOString() };
  doc.updated_at = new Date().toISOString();
  touch(HITBOX_KEY, k);
  markDirty(HITBOX_KEY);
}
function hitboxState(entity, state) {
  if (isWallScenery(entity)) return "wall";
  if (hitboxFlat(entity)) return "flat";
  if (hitboxAuto(entity, state)) return "todo";
  const b = hitboxes(entity, state);
  if (b === null) return "todo";
  return b.length ? "has" : "none";
}
/* THE FILTER COUNTS THE PIECE, and a piece is done only when EVERY variation
 * is — they can differ in size, which is the whole reason they are keyed
 * apart. One undecided variation keeps the piece in the to-do queue. */
function hitboxPieceState(entity) {
  if (isWallScenery(entity)) return "wall";
  if (hitboxFlat(entity)) return "flat";
  const states = hitboxStates(entity);
  if (!states.length) return hitboxState(entity);
  const each = states.map((st2) => hitboxState(entity, st2));
  if (each.some((x) => x === "todo")) return "todo";
  return each.some((x) => x === "has") ? "has" : "none";
}

/** The raw tuned record ({rx, ry, ax?, ay?, offsets?}), or null. */
function shadowRaw(entity) {
  const t = state.tuning.monsters?.monsters?.[entity.id]?.shadow;
  return t && typeof t.rx === "number" && isFinite(t.rx) && t.rx > 0
    && typeof t.ry === "number" && isFinite(t.ry) && t.ry > 0 ? t : null;
}
/** One SIZE for the monster; `edited` = a record exists at all. */
function shadowRec(entity) {
  const t = shadowRaw(entity);
  if (t) return { rx: t.rx, ry: t.ry, edited: true };
  const d = shadowDefault(entity);
  return { rx: d.rx, ry: d.ry, edited: false };
}
/** The OFFSET in force for one facet — v2 (maintainer 2026-08-20, after
 *  tuning real monsters: "The shadow offset is per animation and direction").
 *  PixelLab frames every direction's strip independently, so the body drifts
 *  inside the frame per facet and ONE offset made him chase his tail — fixing
 *  E broke S, and the big compromise offsets it forced were also what blew
 *  the canvas into a scrollbar. Chain: the facet's own offset → the same
 *  direction's idle offset → a v1 record's base ax/ay → the art-derived
 *  default. Same chain as games2/shared shadowAnchorOf. */
function shadowAnchor(entity, st, dir) {
  const t = shadowRaw(entity);
  const own = t?.offsets?.[`${st}#${dir}`];
  if (own && isFinite(own.ax) && isFinite(own.ay)) return { ax: own.ax, ay: own.ay, source: "facet" };
  const idle = t?.offsets?.[`idle#${dir}`];
  if (idle && isFinite(idle.ax) && isFinite(idle.ay)) return { ax: idle.ax, ay: idle.ay, source: "idle" };
  if (t && typeof t.ax === "number" && isFinite(t.ax) && typeof t.ay === "number" && isFinite(t.ay)) {
    return { ax: t.ax, ay: t.ay, source: "base" };
  }
  const d = shadowDefault(entity);
  return { ax: d.ax, ay: d.ay, source: "default" };
}
/** Ensure the entry + shadow object exist and return the shadow object. */
function shadowEnsure(entity) {
  const doc = state.tuning.monsters;
  if (!doc) return null;
  const monsters = (doc.monsters ??= {});
  const e = (monsters[entity.id] ??= {});
  if (!e.shadow || typeof e.shadow.rx !== "number") {
    const d = shadowDefault(entity);
    e.shadow = { rx: d.rx, ry: d.ry };
  }
  return e.shadow;
}
function shadowTouched(entity) {
  const doc = state.tuning.monsters;
  if (!doc) return;
  doc.updated_at = new Date().toISOString();
  touch(MTUNE_KEY, entity.id);
  markDirty(MTUNE_KEY);
}
/** The single size. */
function setShadowSize(entity, rx, ry) {
  const sh = shadowEnsure(entity);
  if (!sh) return;
  sh.rx = Math.max(1, +(+rx).toFixed(2));
  sh.ry = Math.max(1, +(+ry).toFixed(2));
  shadowTouched(entity);
}
/** This facet's offset (null drops it, falling back down the chain). */
function setShadowOffset(entity, st, dir, off) {
  const sh = shadowEnsure(entity);
  if (!sh) return;
  const key = `${st}#${dir}`;
  if (!off) {
    if (sh.offsets) { delete sh.offsets[key]; if (!Object.keys(sh.offsets).length) delete sh.offsets; }
  } else {
    (sh.offsets ??= {})[key] = { ax: +(+off.ax).toFixed(2), ay: +(+off.ay).toFixed(2) };
  }
  shadowTouched(entity);
}
/** Drop the whole record — the game returns to its legacy measured anchors. */
function clearShadow(entity) {
  const doc = state.tuning.monsters;
  if (!doc) return;
  const monsters = (doc.monsters ??= {});
  const e = monsters[entity.id];
  if (e) {
    delete e.shadow;
    // An entry that held nothing else must not survive as {} — the stats
    // editor reads bare existence as "tuned".
    if (!Object.keys(e).length) delete monsters[entity.id];
  }
  shadowTouched(entity);
}

/* --------------------------------------------------------------- player */
// One animation player: strips (monsters/objects) or per-frame urls
// (characters). Nearest-neighbour scaling, play/pause, frame-step, speed,
// and the game's nadir shadow for monsters.
// WHAT IS LEFT TO REVIEW, VISIBLE ON THE CHIP ITSELF (maintainer 2026-08-15:
// "when logged in as admin it's hard for me to know what tree state I have
// left to review ... the admin will see the state text 1, 2 etc in green =
// approved, red = rejected. Then I know if it's normal color means I have not
// reviewed it yet"). Verdicts are per state × DIRECTION, so a state chip
// summarises its directions:
//   red   — at least one direction rejected (the call you must not lose sight of)
//   green — every direction judged, and all approved
//   plain — nothing judged yet, or only some of it: still work to do
// The colours are the theme's own --good/--bad, which are dark on the light
// theme and light on the dark one, exactly as he asked.
const FACET_DOMAIN = { monster: "monsters", character: "characters", object: "objects" };
function facetMark(domain, path, state, dirs, entity) {
  if (!domain || !path || !dirs.length) return { cls: "", title: null };
  let approved = 0, rejected = 0, stale = 0;
  for (const d of dirs) {
    const e = fb(domain, `${path}#${state}#${d}`);
    // Regenerated since it was judged: it reads as unjudged, because that is
    // what it is now — a colour saying "settled" about art he has never seen
    // is the same lie as a stale piece badge.
    if (entity && (e.status || e.rating) && facetStale(entity, state, d, e)) { stale++; continue; }
    if (e.status === "approved") approved++;
    else if (e.status === "rejected") rejected++;
  }
  const of = dirs.length === 1 ? "" : ` of ${dirs.length} directions`;
  const note = stale ? ` — ${stale} regenerated since, needs another look` : "";
  if (rejected) return { cls: "judged-no", title: `${rejected}${of} rejected${note}` };
  if (approved === dirs.length) return { cls: "judged-ok", title: `approved${of ? ` (all ${dirs.length} directions)` : ""}` };
  if (stale) return { cls: "", title: `judged before the art was regenerated${of} — needs another look` };
  if (approved) return { cls: "", title: `${approved}${of} approved — not finished` };
  return { cls: "", title: "not reviewed yet" };
}

function makePlayer(entity, kind, opts = {}) {
  const anims = entity.animations;
  const stateNames = Object.keys(anims);
  let cur = {
    state: stateNames.includes("idle") ? "idle" : stateNames[0],
    dir: "south", frame: 0, playing: true, speed: 1, zoom: 0 /* 0 = auto */,
    shadow: kind === "monster",
    editShadow: false,
    editHit: false,
  };
  let onShadowEdit = null;
  const baseFps = 8;
  const GRIP = 11;                       // finger-sized, in canvas px
  let shadowHit = null;                  // where the ellipse landed last draw
  let shadowDrag = null;                 // {mode, sx, sy, from}
  const canvas = h("canvas", { width: 64, height: 64 });
  const stage = h("div", { class: "player-stage checker" }, canvas);
  // DRAG THE SHADOW (admin, edit mode only). Pointer events on the canvas, in
  // canvas pixels, converted back to FRAME pixels before anything is stored —
  // the note has to mean the same thing at 1x, 2x and 4x.
  const toCanvas = (ev) => {
    const r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (canvas.width / r.width), y: (ev.clientY - r.top) * (canvas.height / r.height) };
  };
  canvas.addEventListener("pointerdown", (ev) => {
    if (!cur.editShadow || !shadowHit) return;
    const p2 = toCanvas(ev);
    // Inside-the-ellipse test, in the ellipse's own rotated frame — the shadow
    // turns with the facing now, so the hit region has to turn with it.
    const { ex, ey, p: sp, q: sq, theta } = shadowHit;
    const c = Math.cos(theta), si = Math.sin(theta);
    const lx = (p2.x - ex) * c + (p2.y - ey) * si;
    const ly = -(p2.x - ex) * si + (p2.y - ey) * c;
    if ((lx / Math.max(1, sp)) ** 2 + (ly / Math.max(1, sq)) ** 2 > 1.6) return;
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
    // MOVE only — resizing lives on the rails, where an absolute value can be
    // read; a resize grip on a rotated ellipse pulls in a direction that is
    // neither of the record's axes. The origin is kept in CLIENT coordinates
    // with the canvas→frame scale captured once (a drag measured in canvas
    // pixels would read any canvas resize as pointer movement and run away).
    const r = canvas.getBoundingClientRect();
    shadowDrag = { sx: ev.clientX, sy: ev.clientY, from: shadowAnchor(entity, cur.state, cur.dir), k: (canvas.width / (r.width || 1)) / (shadowHit.s || 1) };
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!shadowDrag) return;
    const dxF = (ev.clientX - shadowDrag.sx) * shadowDrag.k;   // frame px
    const dyF = (ev.clientY - shadowDrag.sy) * shadowDrag.k;
    const f = shadowDrag.from;
    // Dragging "the shadow" right stores ax+ FOR THIS ANIMATION AND DIRECTION
    // — and on screen the MONSTER slides left while the ellipse holds still,
    // because the ellipse centre is the monster's world position and the
    // sprite is what hangs off it.
    setShadowOffset(entity, cur.state, cur.dir, { ax: f.ax + dxF, ay: f.ay + dyF });
    onShadowEdit?.();
    refreshShadowBar();
    draw();
  });
  const endDrag = (ev) => {
    if (!shadowDrag) return;
    shadowDrag = null;
    try { canvas.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }
    editBox = null;   // gesture over — re-hug (see padEnd)
    draw();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  // ADMIN SIZE REFERENCE (maintainer 2026-08-13: "render the human male side
  // by side with the scenery so I see how big it is in comparison … as close
  // to the screen border/edge as possible … keep rendering the scenery itself
  // in the center"). The whole viewer draws every domain at ONE shared scale,
  // so the comparison needs no math at all: the Man's idle/south frame,
  // content-cropped by his measured bb like every other sprite, drawn at the
  // SAME `s` this page is using — zoom included, or 2x of him next to 4x of a
  // mushroom would be a lie. He hugs the stage's left edge and the entity's
  // own canvas is never touched.
  //
  // He is CENTRED vertically, exactly like the canvas beside him, and not
  // stood on the piece's baseline: the canvas is centred and cropped, so its
  // bottom edge sits at a different height for every piece, and pinning him
  // to it made him "jump a lot up and down when switching page" (maintainer,
  // same day). Centred, the stage is a fixed size per domain and his height
  // depends only on zoom — so his position is identical on all 391 pages.
  let human = null;
  if (opts.humanRef) {
    human = h("div", { class: "human-ref", title: "the Man, at this page's scale" });
    if (!opts.humanRef.on) human.style.display = "none";
    stage.append(human);
  }
  function placeHuman(s) {
    if (!human || human.style.display === "none") return;
    const { url, fw, fh, bb } = opts.humanRef;
    human.style.width = `${(bb[2] - bb[0]) * s}px`;
    human.style.height = `${(bb[3] - bb[1]) * s}px`;
    human.style.backgroundImage = `url("${url}")`;
    human.style.backgroundSize = `${fw * s}px ${fh * s}px`;
    human.style.backgroundPosition = `${-bb[0] * s}px ${-bb[1] * s}px`;
  }
  // FIXED STAGE (maintainer 2026-07-30): one chessboard size for the whole
  // domain — the widest and tallest pose any of its entities needs — with the
  // creature centred in it. Paging next/next/next then swaps the creature
  // without the layout moving. The CANVAS stays cropped to the sprite, so a
  // rare oversized pose can overflow into the stage's own scroll rather than
  // inflating every page. `max-width:100%` keeps it inside narrow screens.
  const stageKind = kind === "monster" ? "monsters" : kind === "character" ? "characters" : "objects";
  function sizeStage() {
    const box = state.data.artBox?.[stageKind];
    if (!box) return;
    // The stage keeps its DEFAULT size whatever zoom is picked, and only
    // grows when a zoomed sprite genuinely will not fit (maintainer
    // 2026-07-30) — so 1x/2x/4x change the creature, not the layout.
    const base = state.data.artScale || 2;
    const sw = Math.max(box[0] * base, canvas.width);
    const sh = Math.max(box[1] * base, canvas.height);
    stage.style.width = `${sw + 18}px`;   // +18 = padding + border (border-box)
    stage.style.height = `${sh + 18}px`;
  }
  const ctx = canvas.getContext("2d");
  const frameNo = h("span", { class: "frame-no" });
  let img = null, frameImgs = [], clip = null, rafTimer = null, acc = 0, lastT = 0;

  function clipFor() {
    const a = anims[cur.state];
    return a?.dirs?.[cur.dir] ?? null;
  }
  // SELF-HEALING CROP (maintainer 2026-08-13: "the new big monsters doesn't
  // fit in it (see a scrollar)"). art_bounds.json is measured FROM a data.json
  // snapshot, so any art that lands between those two runs reaches this player
  // with no `bb` — and the fallback below is the whole padded FRAME, which is
  // the very "scaling by transparent padding" the crop exists to kill. 33
  // monsters arrived that way and asked for a 472px canvas to draw a 402px
  // creature, on a 432px stage. The builder can only ever be as fresh as
  // whoever last ran it — and it was another agent's rebuild that stranded
  // these — so the same measurement is available here: union of every frame's
  // opaque pixels, frame-local, once per clip, cached on the clip. Art is
  // same-origin, so the read-back never taints; if it ever does, we keep the
  // old behaviour rather than blanking the viewer.
  function selfMeasure(target, images, fw, fh) {
    if (!target || target.bb) return;
    try {
      const c = document.createElement("canvas");
      c.width = fw; c.height = fh;
      const g = c.getContext("2d", { willReadFrequently: true });
      let x0 = fw, y0 = fh, x1 = -1, y1 = -1;
      for (const [im, sx] of images) {
        if (!im?.complete || !im.naturalWidth) continue;
        g.clearRect(0, 0, fw, fh);
        g.drawImage(im, sx, 0, fw, fh, 0, 0, fw, fh);
        const d = g.getImageData(0, 0, fw, fh).data;
        for (let y = 0; y < fh; y++)
          for (let x = 0; x < fw; x++)
            if (d[(y * fw + x) * 4 + 3] > 8) {          // same alpha cut as the build's
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
      }
      if (x1 >= x0 && y1 >= y0) target.bb = [x0, y0, x1 + 1, y1 + 1];
    } catch { /* tainted canvas — fall back to whole-frame, as before */ }
  }
  // THE ANCHOR LAYOUT NEEDS THE WHOLE UNION, so when this monster reaches the
  // page unmeasured, healing only the clip on screen is not enough: the other
  // animations would still count as padded frames. The look-ahead has already
  // warmed (decoded) this creature's every strip, so measure whichever of them
  // are ready — and try again shortly for the stragglers the warm pump is
  // still fetching. Runs only while something is actually unmeasured.
  let healTimer = null;
  function healSiblings() {
    if (kind !== "monster") return;
    let healed = 0, missing = 0;
    for (const a of Object.values(entity.animations ?? {})) {
      for (const c of Object.values(a.dirs ?? {})) {
        if (!c || c.bb || !c.strip) continue;
        const im = warmHit(assetUrl(c.strip));
        if (!im) { missing++; continue; }
        const cfw = c.fw ?? entity.frameW ?? 64, cfh = c.fh ?? entity.frameH ?? 64;
        const n = Math.max(1, Math.min(c.frames ?? 1, Math.floor(im.naturalWidth / cfw) || 1));
        selfMeasure(c, Array.from({ length: n }, (_, i) => [im, i * cfw]), cfw, cfh);
        if (c.bb) healed++; else missing++;
      }
    }
    if (healed) draw();
    if (missing && !healTimer) healTimer = setTimeout(() => { healTimer = null; healSiblings(); }, 700);
  }
  function loadClip() {
    clip = clipFor();
    img = null; frameImgs = [];
    cur.frame = 0;
    if (!clip) { draw(); return; }
    const target = clip;                    // the clip may change before onload
    const fw = target.fw ?? entity.frameW ?? 64, fh = target.fh ?? entity.frameH ?? 64;
    if (target.strip) {
      const url = assetUrl(target.strip);
      const ready = (im) => {
        const n = Math.max(1, Math.min(target.frames ?? 1, Math.floor(im.naturalWidth / fw) || 1));
        const had = !!target.bb;
        selfMeasure(target, Array.from({ length: n }, (_, i) => [im, i * fw]), fw, fh);
        // A heal on the visible clip means the whole entity is unmeasured —
        // pull the rest of its clips up to measured too (see healSiblings).
        if (!had && target.bb) healSiblings();
        draw();
      };
      const hit = warmHit(url);
      if (hit) { img = hit; ready(hit); }           // prefetched: no request, no decode
      else {
        img = new Image();
        img.onload = () => { rememberWarm(url, img); ready(img); };
        img.src = url;
      }
    } else if (clip.framesDir) {
      let loaded = 0;
      const total = clip.frames;
      // Measured on the LAST frame — the union needs them all, the same way
      // the Python unions a strip. The first frame still draws immediately, so
      // nothing waits on the tail of a long animation. A frame that 404s still
      // counts, or one gap stalls the union and the clip never measures.
      const settle = (i) => {
        if (++loaded >= total) { selfMeasure(target, frameImgs.map((x) => [x, 0]), fw, fh); draw(); }
        else if (i === 0) draw();
      };
      frameImgs = Array.from({ length: total }, (_, i) => {
        // The builder measured how this domain names its frames — "0.png" or
        // "00.webp". Never assume: the two domains differ.
        const url = assetUrl(`${clip.framesDir}/${String(i).padStart(clip.framePad ?? 1, "0")}.${clip.frameExt ?? "png"}`);
        const hit = warmHit(url);
        // A prefetched frame is already decoded; settle it in a microtask so
        // frameImgs is fully built before the union reads it.
        if (hit) { queueMicrotask(() => settle(i)); return hit; }
        const im = new Image();
        im.onload = () => { rememberWarm(url, im); settle(i); };
        im.onerror = () => settle(i);
        im.src = url;
        return im;
      });
    }
  }
  // ONE scale for every creature (maintainer 2026-07-30). Scaling by FRAME
  // size was really scaling by transparent PADDING: Lava Salamander and Lava
  // Salamander II are the same 30x35 creature but ship 78x48 and 48x48
  // frames, so they rendered 1.67x apart — and the 32x23 frog came out 2.5x
  // wider than the 77x121 mammoth. The padding is cropped away with each
  // clip's measured content box (build.mjs + wiki/lib/webp-pixels.mjs) and everyone
  // draws at data.artScale: same creature = same size, bigger creature =
  // bigger. The crop is PER CLIP, so it stays put while a clip plays and the
  // animation's motion still shows. Zoom buttons override the scale.
  // 2x IS THE GAME'S OWN SCALE, SO 2x IS THE DEFAULT — full stop (maintainer
  // 2026-08-14: "I want the default to review in x2 because that's what the
  // game uses"). An earlier cut of this fix stepped the default DOWN until a
  // piece fitted, which stopped the clipping but reviewed the art at a size
  // the game never draws it at. Wrong trade.
  //
  // A 246px piece at 2x is 492px and a phone gives ~331px, so it CANNOT fit —
  // the honest answer is to let it overflow and make that unmistakable. With
  // `justify-content: safe center` the overflow now runs to the RIGHT and is
  // fully scrollable (a centred overflowing flex child puts half its width in
  // negative scroll space, which no scrollbar can reach — that is what hid the
  // left edge and cost the maintainer a night of wrongly rejected scenery).
  // This caption then says so in words, because a silently scrollable box is
  // exactly what "the art is cut" looked like.
  const overflowNote = h("p", { class: "stage-wide muted hidden" });
  function updateOverflowNote() {
    const over = stage.scrollWidth - stage.clientWidth;
    const on = over > 2 && !cur.zoom;   // an explicit zoom choice is the reader's own
    overflowNote.classList.toggle("hidden", !on);
    if (on) overflowNote.textContent =
      `Wider than the screen at 2× — swipe the picture sideways to see it all, or tap 1× to fit ${Math.round(over)}px.`;
  }
  // The union of every clip's content box — ONE box for the whole monster, so
  // the anchor-true layout below cannot move between animations or directions.
  // (Per-clip bb varies with the pose; a canvas derived from it would make the
  // shadow line jump exactly the way he said it must not.)
  //
  // A FUNCTION, not a constant: art that landed after the last bounds build
  // reaches this player with no bb and SELF-MEASURES as its strips decode
  // (selfMeasure below, plus healSiblings for the rest of the entity), and the
  // union has to grow with those heals or an unmeasured monster would lay out
  // by its padded frame — the scrollbar bug this crop exists to kill.
  const unionBB = () => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    for (const a of Object.values(entity.animations ?? {})) {
      for (const c of Object.values(a.dirs ?? {})) {
        if (!c?.bb) continue;
        any = true;
        x0 = Math.min(x0, c.bb[0]); y0 = Math.min(y0, c.bb[1]);
        x1 = Math.max(x1, c.bb[2]); y1 = Math.max(y1, c.bb[3]);
      }
    }
    return any ? [x0, y0, x1, y1] : [0, 0, entity.frameW ?? 64, entity.frameH ?? 64];
  };
  // The box the editor froze — the canvas must not resize WHILE A GESTURE IS
  // IN FLIGHT (measured 2026-08-15: a resizing canvas slid the art under his
  // thumb and halved every correction). Frozen when the editor opens and
  // RE-DERIVED at the end of every gesture (pad release, slider release):
  // between gestures nothing is under the finger, and re-hugging is what stops
  // the slack from accumulating into a scrollbar.
  //
  // ROOM is deliberately small (maintainer 2026-08-20, from his phone: "I can
  // also see a scrollbar inside the preview and the shadow doesn't feel
  // centered at all horizontally"): the first cut reserved 30 frame px on
  // every side, which on a 331px stage pushed the canvas to 396 — an 83px
  // overflow whose scroll sat at the LEFT edge, so the pinned anchor rendered
  // 41px right of the visible centre and everything he had just tuned read as
  // misplaced. 12px covers a normal adjustment; a bigger drag clips at the rim
  // until the release re-hugs the box.
  let editBox = null;
  const EDIT_ROOM = 12;                              // frame px, every side
  function draw() {
    const fw = clip?.fw ?? entity.frameW ?? 64, fh = clip?.fh ?? entity.frameH ?? 64;
    const bb = clip?.bb ?? [0, 0, fw, fh];   // content box in frame px
    const s0 = cur.zoom || (state.data.artScale || 2);
    const cw = Math.max(1, bb[2] - bb[0]), ch = Math.max(1, bb[3] - bb[1]);
    /* GAME-TRUE SIZE BESIDE THE MAN (games agent, 2026-09-02: "THE SCENERY
     * SIZE REFERENCE MISLED THE MAINTAINER INTO GENERATING SMALL BEDS — it
     * draws the piece at its NATIVE sprite pixels beside the Man at his").
     * The game draws a piece scaled so its cropped height is world_px_height
     * × characterBodyPx / character_height_px, and the Man at his art size —
     * so bed_005 stood at 1.14× the Man here and 0.75× in the world, and he
     * generated to the wrong picture. While the Man is shown, the PIECE takes
     * the game's factor and the Man keeps his own scale (placeHuman gets s0),
     * so the two are in the game's ratio. With the Man hidden nothing changes:
     * the hitbox editor and every zoom keep the scale they had. */
    const placementFactor = () => {
      if (kind !== "object" || !human || human.style.display === "none") return 1;
      const pl = entity.placement, sc = state.data.sceneryScale;
      const wph = +pl?.world_px_height;
      if (!(wph > 0) || !sc) return 1;
      const cpx = +pl?.character_height_px > 0 ? +pl.character_height_px : sc.contractCharacterPx;
      /* AGAINST THE PIECE'S OWN BASE SPRITE, never this clip. The game fits
       * every state through the BASE sprite's bbox (WorldScene's `baseH`), so
       * one piece has one scale and a lit state cannot be drawn bigger than an
       * unlit one. Dividing by the clip in hand instead re-fitted each state to
       * the same height — a candle's flame state, taller in art, came out
       * SHRUNK against its own unlit twin, and neither matched the game. */
      const base = +pl?.content_px_height > 0 ? +pl.content_px_height : ch;
      return (wph * sc.characterBodyPx / cpx) / base;
    };
    const s = s0 * placementFactor();
    // QA probe: the scale the piece is drawn at, and why.
    if (kind === "object") window.__wikiScale = { s, s0, factor: +(s / s0).toFixed(4) };
    const showShadow = cur.shadow && kind === "monster";
    /* ---- THE ANCHOR-TRUE LAYOUT (shadow shown) --------------------------
     * Everything is placed at a fixed offset from the ANCHOR — the shadow's
     * centre, the point the game will stand this monster on. The box is
     * derived from the union content box and the ellipse's worst-case
     * extents over ALL facings, so:
     *   - turning the monster re-rotates the ellipse IN PLACE and the art
     *     appears to rotate around it, exactly as it will in game;
     *   - switching animations moves nothing;
     *   - horizontally the anchor sits at the canvas centre (his spec:
     *     "the shadow will pick the center"), so an ax drag slides the
     *     MONSTER the other way;
     *   - vertically the box hugs the monster (never "the monster rendered
     *     so far up"), and the shadow line lands wherever ay puts it — at
     *     the SAME canvas y for every clip.
     */
    let sh = null, el = null, anc = null, anchorX = 0, anchorY = 0, dx = 0, dy = 0;
    let wantW, wantH;
    if (showShadow) {
      const uBB = unionBB();
      sh = shadowRec(entity);
      el = shadowEllipse(sh.rx, sh.ry, cur.dir);
      anc = shadowAnchor(entity, cur.state, cur.dir);
      const A = { x: fw / 2 + anc.ax, y: fh / 2 + anc.ay };    // anchor, frame px
      // THE BOX COVERS EVERY FACET'S ANCHOR, not just this one's: offsets are
      // per animation × direction now, and the box must be the same
      // anchor-relative rectangle for all of them or the shadow's canvas point
      // would move when he switches facet — the one thing it must never do.
      // (The FRAME is what shifts per facet: the correction, made visible.)
      let axMin = anc.ax, axMax = anc.ax, ayMin = anc.ay, ayMax = anc.ay;
      for (const st2 of Object.keys(entity.animations ?? {})) {
        for (const d2 of Object.keys(entity.animations[st2]?.dirs ?? {})) {
          const a2 = shadowAnchor(entity, st2, d2);
          axMin = Math.min(axMin, a2.ax); axMax = Math.max(axMax, a2.ax);
          ayMin = Math.min(ayMin, a2.ay); ayMax = Math.max(ayMax, a2.ay);
        }
      }
      const ext = shadowExtents(sh.rx, sh.ry);
      const pad = 6;
      // SYMMETRIC AROUND THE ANCHOR horizontally — "Horizontally the shadow
      // will pick the center" is his spec, and symmetric is what makes it
      // unconditional: anchorX ≡ canvas centre, so CSS centring (canvas fits)
      // and the auto-centred scroll (canvas overflows, below) both put the
      // shadow at the visible centre — before a gesture, after its re-hug,
      // and through any storm of direction clicks. An asymmetric hug saved a
      // few pixels of width but parked the anchor off-centre by exactly ax·s
      // the moment a drag ended. Vertically the box hugs the monster instead
      // — the shadow must not pick THAT centre, or a tall monster rides high.
      const hug = () => {
        // Anchor-relative extents that hold for EVERY facet: the content's
        // reach from the anchor is largest for the extreme offsets.
        const AxHi = fw / 2 + axMax, AxLo = fw / 2 + axMin;
        const AyHi = fh / 2 + ayMax, AyLo = fh / 2 + ayMin;
        const halfW = Math.max(AxHi - uBB[0], uBB[2] - AxLo, ext.x) + pad;
        return {
          left: -halfW,
          right: halfW,
          top: Math.min(uBB[1] - AyHi, -ext.y) - pad,
          bot: Math.max(uBB[3] - AyLo, ext.y) + pad,
        };
      };
      let box;
      if (cur.editShadow) {
        if (!editBox) {
          const hb = hug();
          editBox = { left: hb.left - EDIT_ROOM, right: hb.right + EDIT_ROOM, top: hb.top - EDIT_ROOM, bot: hb.bot + EDIT_ROOM };
        }
        box = editBox;
      } else {
        box = hug();
      }
      wantW = Math.ceil((box.right - box.left) * s);
      wantH = Math.ceil((box.bot - box.top) * s);
      anchorX = -box.left * s;
      anchorY = -box.top * s;
      dx = Math.round(anchorX - A.x * s);
      dy = Math.round(anchorY - A.y * s);
    } else if ((cur.editHit || (hitBtn && hitAlwaysShow())) && kind === "object") {
      /* THE HITBOX MUST NOT BE CLIPPED BY THE ART (maintainer 2026-08-27: "I
       * feel the hitbox I draw is clipped and can only render inside the
       * scenery texture. This feels like a bug and makes it hard to see the
       * hitbox if it's not at the correct place already").
       *
       * It was: this branch crops the canvas to the art's own content box, so
       * an ellipse wider than the piece — which a footprint often is, and
       * ALWAYS is before he has placed it — was drawn outside the canvas and
       * simply vanished. He was being asked to aim something he could only
       * half see.
       *
       * So while the editor is open the box is the UNION of the art and every
       * ellipse, in frame pixels, plus room to drag into. The monster editor
       * solved the same problem with shadowExtents; this is that idea for a
       * shape that can sit anywhere and turn. */
      const R = 16;                              // frame px of drag room, every side
      let x0 = bb[0], y0 = bb[1], x1 = bb[2], y1 = bb[3];
      for (const b of hitList()) {
        // The half-extents of a rotated ellipse, exactly: the extreme of
        // rx·cos t·cos th − ry·sin t·sin th over t. Cheaper and tighter than
        // walking the outline, and it must be exact or the rim clips again at
        // some angles and not others, which reads as a flicker.
        const th = boxRot(entity, b, cur.dir) * Math.PI / 180;
        const szF = boxSize(b, cur.dir);
        let hx = Math.hypot(szF.rx * Math.cos(th), szF.ry * Math.sin(th));
        let hy = Math.hypot(szF.rx * Math.sin(th), szF.ry * Math.cos(th));
        if (boxShape(entity, b) === "rect") {
          const cs = rectCorners(entity, b, cur.dir);
          hx = Math.max(...cs.map(([x]) => Math.abs(x)));
          hy = Math.max(...cs.map(([, y]) => Math.abs(y)));
        }
        const bp0 = boxPos(b, cur.dir);
        const cx = fw / 2 + bp0.ax, cy = fh / 2 + bp0.ay;
        x0 = Math.min(x0, cx - hx); x1 = Math.max(x1, cx + hx);
        y0 = Math.min(y0, cy - hy); y1 = Math.max(y1, cy + hy);
      }
      // FROZEN FOR THE GESTURE, like the monster editor's box: a canvas that
      // resizes under the thumb slides the art and halves every correction.
      if (!editBox) editBox = { x0: x0 - R, y0: y0 - R, x1: x1 + R, y1: y1 + R };
      const bx = editBox;
      wantW = Math.ceil((bx.x1 - bx.x0) * s);
      wantH = Math.ceil((bx.y1 - bx.y0) * s);
      dx = Math.round(-bx.x0 * s);
      dy = Math.round(-bx.y0 * s);
    } else {
      // Legacy content-crop layout — the padding falls outside the canvas.
      wantW = Math.ceil(cw * s);
      wantH = Math.ceil(ch * s);
      dx = Math.round(wantW / 2 - ((bb[0] + bb[2]) / 2) * s);
      dy = Math.round(-bb[1] * s);
    }
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW; canvas.height = wantH;
      // A canvas that must overflow (a genuinely huge monster) starts its
      // scroll pinned LEFT, which hides the anchored half of the picture —
      // centre it instead. Only on a real resize, so his own swipes are
      // never fought.
      requestAnimationFrame(() => {
        if (stage.scrollWidth > stage.clientWidth) {
          stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
        }
      });
    }
    sizeStage();   // after the canvas is sized — the stage only grows for it
    placeHuman(s0); // the Man at HIS scale: the piece carries the placement factor
    updateOverflowNote();
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!clip) { frameNo.textContent = "—"; return; }
    if (showShadow) {
      ctx.fillStyle = "rgba(20,16,8,0.38)";
      ctx.beginPath();
      ctx.ellipse(anchorX, anchorY, el.p * s, el.q * s, el.theta, 0, Math.PI * 2);
      ctx.fill();
      shadowHit = { ex: anchorX, ey: anchorY, p: el.p * s, q: el.q * s, theta: el.theta, s };
      if (cur.editShadow) {
        // The untuned default stays visible as a dashed ghost, riding the
        // FRAME (it marks where the measurement put the anchor on the body) —
        // a correction is only readable against what it corrects.
        const d0 = shadowDefault(entity);
        const g = shadowEllipse(d0.rx, d0.ry, cur.dir);
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "rgba(217,119,87,0.75)"; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(dx + (fw / 2 + d0.ax) * s, dy + (fh / 2 + d0.ay) * s, g.p * s, g.q * s, g.theta, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(217,119,87,1)"; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(anchorX, anchorY, el.p * s, el.q * s, el.theta, 0, Math.PI * 2);
        ctx.stroke();
        // The anchor itself — the point the game will stand this monster on.
        ctx.fillStyle = "rgba(217,119,87,1)";
        ctx.fillRect(anchorX - 1.5, anchorY - 1.5, 3, 3);
        ctx.restore();
      }
      // QA probe: what the page believes about the shadow, for the gate.
      window.__wikiShadow = {
        ex: anchorX, ey: anchorY, p: +(el.p * s).toFixed(2), q: +(el.q * s).toFixed(2),
        theta: +el.theta.toFixed(4), s, dx, dy, W: canvas.width, H: canvas.height,
        rec: { rx: sh.rx, ry: sh.ry, edited: sh.edited },
        anchor: { ax: anc.ax, ay: anc.ay, source: anc.source },
        dir: cur.dir, state: cur.state,
      };
    } else shadowHit = null;
    const f = Math.min(cur.frame, clip.frames - 1);
    if (img?.complete && img.naturalWidth) {
      ctx.drawImage(img, f * (img.naturalWidth / clip.frames), 0, img.naturalWidth / clip.frames, img.naturalHeight, dx, dy, fw * s, fh * s);
    } else if (frameImgs[f]?.complete && frameImgs[f].naturalWidth) {
      ctx.drawImage(frameImgs[f], dx, dy, fw * s, fh * s);
    }
    /* ---- THE SCENERY HITBOX, DRAWN OVER THE ART -------------------------
     * A monster's shadow is painted UNDER its sprite because it is a shadow.
     * This is not one — "this scenery nadir 'shadow' is also not a shadow.
     * This is just a hitbox" — and a piece is often far taller than its
     * footprint, so an outline underneath would be hidden by the very art it
     * describes. It goes on top, as an outline the game never paints.
     *
     * THE CENTRE LINE IS THE POINT. "When the player is over the hitbox/
     * elliptic center the scenery is rendered on top of the player and when
     * the player is under the elliptic center the player is rendered on top."
     * That boundary is a horizontal line through the centre, so it is drawn
     * as one — the thing being decided, made visible. */
    if ((cur.editHit || (hitBtn && hitAlwaysShow())) && kind === "object") {
      const boxes = hitList();
      ctx.save();
      boxes.forEach((b, i) => {
        const on = i === hitSel;
        const bp = boxPos(b, cur.dir);
        const ex = dx + (fw / 2 + bp.ax) * s, ey = dy + (fh / 2 + bp.ay) * s;
        const th = boxRot(entity, b, cur.dir) * Math.PI / 180;
        // The unselected ones stay visible but quiet: with two pillars he must
        // see both to judge the pair, and know which one the rails drive.
        ctx.strokeStyle = on ? "rgba(217,119,87,1)" : "rgba(217,119,87,0.45)";
        ctx.lineWidth = on ? 1.5 : 1;
        const szD = boxSize(b, cur.dir);
        const px = Math.max(1, szD.rx * s), py = Math.max(1, szD.ry * s);
        ctx.beginPath();
        // Same centre, same half-axes, same rotation — only the outline
        // differs, so switching shape never moves the footprint he placed.
        if (boxShape(entity, b) === "rect") {
          const cs = rectCorners(entity, b, cur.dir);
          cs.forEach(([x, y], n) => (n ? ctx.lineTo(ex + x * s, ey + y * s) : ctx.moveTo(ex + x * s, ey + y * s)));
          ctx.closePath();
        } else {
          ctx.ellipse(ex, ey, px, py, th, 0, Math.PI * 2);
        }
        ctx.stroke();
        if (on) {
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = "rgba(217,119,87,0.6)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, ey); ctx.lineTo(canvas.width, ey);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "rgba(217,119,87,1)";
          ctx.fillRect(ex - 1.5, ey - 1.5, 3, 3);
        }
      });
      ctx.restore();
      // QA probe: what the page believes about the hitbox, for the gate.
      window.__wikiHitbox = {
        state: hitboxState(entity, cur.state), variation: cur.state, sel: hitSel, n: boxes.length, s, dx, dy,
        // The facing on screen and the angle each box is DRAWN at — a rect
        // adds this facing's tilt to the tuned angle, so the record alone does
        // not say what he is looking at.
        dir: cur.dir, tilt: +facingTilt(cur.dir).toFixed(2),
        drawn: boxes.map((b) => +boxRot(entity, b, cur.dir).toFixed(2)),
        /* The same four corners in FRAME px — canvas-independent. The canvas is
         * fitted to the box, so its origin moves when the box does and canvas
         * coordinates cannot be compared across an edit (measured 2026-09-03,
         * twice: a pinned edge read as "moved 58px" when nothing had moved). */
        cornersFrame: boxes.map((b) => boxShape(entity, b) === "rect"
          ? rectCorners(entity, b, cur.dir).map(([x, y]) => [+(fw / 2 + boxPos(b, cur.dir).ax + x).toFixed(3), +(fh / 2 + boxPos(b, cur.dir).ay + y).toFixed(3)])
          : null),
        // A rect's four corners on the canvas (px) — the perspective, measurable.
        corners: boxes.map((b) => boxShape(entity, b) === "rect"
          ? rectCorners(entity, b, cur.dir).map(([x, y]) => [+(dx + (fw / 2 + boxPos(b, cur.dir).ax) * s + x * s).toFixed(2), +(dy + (fh / 2 + boxPos(b, cur.dir).ay) * s + y * s).toFixed(2)])
          : null),
        shapes: boxes.map((b) => boxShape(entity, b)),
        W: canvas.width, H: canvas.height,
        boxes: boxes.map((b) => ({ ...b })),
        screen: boxes.map((b) => ({ ex: +(dx + (fw / 2 + boxPos(b, cur.dir).ax) * s).toFixed(2), ey: +(dy + (fh / 2 + boxPos(b, cur.dir).ay) * s).toFixed(2) })),
      };
    }
    frameNo.textContent = `${f + 1} / ${clip.frames}`;
  }
  function tick(t) {
    rafTimer = requestAnimationFrame(tick);
    if (!cur.playing || !clip) { lastT = t; return; }
    if (!lastT) lastT = t;
    acc += (t - lastT) * cur.speed; lastT = t;
    const ms = 1000 / baseFps;
    while (acc >= ms) { acc -= ms; cur.frame = (cur.frame + 1) % clip.frames; }
    draw();
  }
  rafTimer = requestAnimationFrame(tick);

  // `seg-states` only so this row can be told apart from the speed and zoom
  // rows, which carry the same class and sit in the same panel. Styling still
  // comes from `.seg`.
  const stateSeg = h("span", { class: "seg seg-states" });
  // Keep the ACTIVE state visible inside the pannable row — scrollLeft only,
  // never scrollIntoView: that can drag the whole page along with it.
  function revealActiveState() {
    const on = stateSeg.querySelector("button.on");
    if (!on) return;
    const pad = 14;
    if (on.offsetLeft < stateSeg.scrollLeft + pad) stateSeg.scrollLeft = Math.max(0, on.offsetLeft - pad);
    else if (on.offsetLeft + on.offsetWidth > stateSeg.scrollLeft + stateSeg.clientWidth - pad)
      stateSeg.scrollLeft = on.offsetLeft + on.offsetWidth - stateSeg.clientWidth + pad;
  }
  const fbDomain = state.admin ? FACET_DOMAIN[kind] : null;
  function renderStateSeg() {
    stateSeg.replaceChildren(...stateNames.map((s) => {
      const mark = fbDomain ? facetMark(fbDomain, entity.path, s, Object.keys(anims[s]?.dirs ?? {}), entity) : { cls: "", title: null };
      return h("button", {
        class: [s === cur.state ? "on" : "", mark.cls].filter(Boolean).join(" "),
        onclick: () => {
          cur.state = s;
          // Direction availability differs per state (e.g. stone_golem's
          // angry ships 5/8 dirs) — refresh the pad and hop to an available
          // direction if the current one has no clip in this state.
          if (!anims[s]?.dirs?.[cur.dir]) {
            cur.dir = state.data.directions.find((d) => anims[s]?.dirs?.[d]) ?? cur.dir;
          }
          // ...and the hitbox bar, which now shows THIS variation's own box
          // (2026-08-29): without this the rails kept driving the previous
          // variation's numbers while a different picture was on screen.
          loadClip(); renderStateSeg(); revealActiveState(); renderDirPad(); refreshShadowBar(); refreshHitBar(); onFacetChange?.();
        },
        title: mark.title ? `${stateWords(s)} — ${mark.title}` : stateWords(s),
      }, stateLabel(s) + (anims[s].fallback ? ` (→${stateLabel(anims[s].fallback)})` : ""));
    }));
  }

  const dirPad = h("span", { class: "dirpad" });
  function renderDirPad() {
    // ONLY the directions this state actually has (maintainer 2026-08-07:
    // "I think only directions that exist should be visible as buttons").
    // All eight used to render with the missing ones merely greyed out, so an
    // NPC whose idle is south-only showed eight buttons and you had to press
    // them to learn which way the art faces. Availability is PER STATE — a
    // monster's angry can ship 5 of 8 while its walk ships all — so this
    // re-runs on every state change, which it already did.
    dirPad.replaceChildren(...state.data.directions.filter(clipForDir).map((d) => {
      // The direction is where a verdict actually lives, so it is marked
      // exactly, not summarised: this one file is approved, rejected or not
      // looked at yet.
      const mark = fbDomain ? facetMark(fbDomain, entity.path, cur.state, [d], entity) : { cls: "", title: null };
      return h("button", {
        class: [d === cur.dir ? "on" : "", mark.cls].filter(Boolean).join(" "),
        title: mark.title ? `${d} — ${mark.title}` : d,
        // A DIRECTION IS A FACET TOO (maintainer 2026-08-14: "you can
        // regenerate an animation for a direction, you don't regenerate for
        // all directions … maybe the SE direction on the state LIGHTS_ON is
        // bad"), so the feedback row follows this click as well as the state.
        // ...and the HITBOX bar, because a rect's angle is per facing: without
        // this the ⟳ rail kept showing south's number while a turned box was
        // on screen (2026-09-02).
        onclick: () => { cur.dir = d; loadClip(); renderDirPad(); refreshShadowBar(); refreshHitBar(); onFacetChange?.(); },
      }, DIR_LABEL[d]);
    }));
  }
  const clipForDir = (d) => anims[cur.state]?.dirs?.[d];
  renderStateSeg();
  requestAnimationFrame(revealActiveState);
  renderDirPad();

  const playBtn = h("button", { class: "ghost-btn", onclick: () => { cur.playing = !cur.playing; playBtn.textContent = cur.playing ? "⏸" : "▶"; } }, "⏸");
  const step = (dn) => { cur.playing = false; playBtn.textContent = "▶"; cur.frame = ((cur.frame + dn) % (clip?.frames ?? 1) + (clip?.frames ?? 1)) % (clip?.frames ?? 1); draw(); };
  const speedSeg = h("span", { class: "seg" }, ...[0.25, 0.5, 1, 2].map((sp) =>
    h("button", { class: sp === 1 ? "on" : "", onclick: (e) => { cur.speed = sp; e.target.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.target)); } }, `${sp}×`)));
  const zoomSeg = h("span", { class: "seg", title: "“same” draws every creature at one scale, so sizes are comparable between pages" },
    ...[["same", 0], ["1×", 1], ["2×", 2], ["4×", 4]].map(([lbl, z], i) =>
    h("button", { class: i === 0 ? "on" : "", onclick: (e) => { cur.zoom = z; e.target.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.target)); draw(); } }, lbl)));

  // A STILL has nothing to transport. One state, one direction, one frame —
  // the shape a static scenery piece takes once the builder gives it a `still`
  // clip — so play/pause, frame-step, speed, the frame counter and a state row
  // holding a single button are all controls that cannot do anything. Zoom
  // stays, because looking at the piece at a known scale is the entire reason
  // the maintainer wanted the viewer here.
  //
  // The DIRECTION pad is judged separately. A still with south / south-east /
  // south-west has three things to look at (maintainer 2026-08-14: "the
  // scenery may now have a SE, S and SW direction — the animation preview
  // should make it possible to review the directions the Scenery has"), so
  // hiding the pad because nothing MOVES would hide two thirds of the art.
  const maxDirs = Math.max(0, ...stateNames.map((s) => Object.keys(anims[s]?.dirs ?? {}).length));
  const maxFrames = Math.max(0, ...stateNames.flatMap((s) => Object.values(anims[s]?.dirs ?? {}).map((d) => d?.frames ?? 1)));
  // Each control is judged by what it would DO here, one at a time:
  //   transport — nothing moves at one frame, whatever else the piece has;
  // The state row and the direction pad are ALWAYS drawn (they also name what
  // you are looking at), so the stage keeps one height across every piece.
  const noTransport = maxFrames <= 1;

  /* ---- edit the nadir shadow (admin; monsters are the only kind that has one)
   * "It has been really hard to get the nadir shadow correct in the game …
   * create an 'Edit nadir shadow' button that makes it easy to drag and resize
   * the nadir shadow on a monster direction/animation, and after doing a lot of
   * them commit them all the same way an approve/reject commit works"
   * (maintainer 2026-08-15). So this button does ONE thing — turn the preview
   * canvas into an editor. Everything downstream is the machinery the verdicts
   * already ride: each drag writes one entry, the save bar counts it, Commit
   * pushes the file. */
  const shadowChk = Object.assign(h("input", { type: "checkbox" }), {
    checked: cur.shadow,
    onchange: (e) => { cur.shadow = e.target.checked; if (!cur.shadow) setEditShadow(false); else draw(); },
  });
  const shadowRead = h("span", { class: "shadow-read" });
  // Reset is TWO-STAGE, matching the data: a facet that carries its own offset
  // drops just that (back down the inheritance chain); pressed with nothing
  // facet-local it clears the monster's whole record and the game returns to
  // its legacy measured anchors. The label says which one it will do.
  const shadowResetBtn = h("button", {
    class: "ghost-btn",
    onclick: () => {
      const t = shadowRaw(entity);
      if (t?.offsets?.[`${cur.state}#${cur.dir}`]) setShadowOffset(entity, cur.state, cur.dir, null);
      else clearShadow(entity);
      onShadowEdit?.(); refreshShadowBar(); draw();
    },
  }, "Reset");

  /* THE CONTROLS ARE A PROXY — NOTHING THAT EDITS THE SHADOW SITS ON IT.
   * Maintainer 2026-08-15, after placing 25 real notes from his phone: "I work
   * from the phone, so for me to drag or resize the shadow with the thumb I
   * can't see where I place the shadow or how big I resize it at the same
   * time. Is it possible to render the controller at the bottom right, but
   * when moving the controller the shadow under the monster will move / be
   * resized? Like a proxy, so I can see what I edit without my thumb being in
   * the way."
   *
   * The PAD is a trackpad, not a joystick: one finger-pixel moves the ellipse
   * one SCREEN pixel, so the shadow tracks the thumb exactly — and at the
   * default 2x zoom that is half a frame pixel, so ordinary thumb movement
   * lands sub-pixel corrections without a fine mode. It does NOT clamp the
   * shadow to the pad's own size; only the knob stops at the rim, so one long
   * drag can cross the whole frame.
   *
   * It sits UNDER the stage, right-aligned, rather than floating over the
   * stage's corner: the stage SCROLLS for oversized pieces (an absolutely
   * placed child would slide out of its corner with the art), and a control
   * over the art is one more thing hiding the art — which is the whole
   * complaint.
   */
  /* HOW FAR THE SHADOW MOVES PER MILLIMETRE OF THUMB (maintainer 2026-08-16:
   * "I just like it to be able to move the shadow slower. To make small
   * adjustments now it means moving my thumb a mm. Small movements should
   * change placement slower to make it easier to do small adjustments").
   *
   * He asked for SMALL movements specifically, so this is pointer acceleration
   * rather than a flat slowdown — a flat one would make a badly-placed shadow
   * take several drags to fix. Per axis: the first PAD_FINE_ZONE of thumb
   * travel is geared down to PAD_FINE, everything past it runs 1:1, so one
   * drag can still cross the frame.
   *
   * DISTANCE-based, never speed-based: the mapping is a pure function of how
   * far the finger is from where it went down, so returning to the start
   * returns the shadow to exactly where it was — a velocity curve drifts, and
   * on a phone the frame rate makes the velocity itself noisy.
   *
   * Measured on his phone (393 css px ≈ 70mm, so ~5.6px/mm) at the default 2x
   * zoom: 1mm of thumb was 2.8 frame px and is now 0.84 — a shadow that can be
   * nudged a pixel at a time, which is the size of the corrections he is
   * making (his first 25 notes moved it 0.2 to 12.5px).
   */
  const PAD_FINE_ZONE = 60, PAD_FINE = 0.3;
  const padGain = (d) => {
    const a = Math.abs(d);
    return Math.sign(d) * (Math.min(a, PAD_FINE_ZONE) * PAD_FINE + Math.max(0, a - PAD_FINE_ZONE));
  };
  const padKnob = h("span", { class: "pad-knob" });
  const padEl = h("div", {
    class: "shadow-pad", title: "Drag to move the shadow — your thumb stays off the art",
  }, h("span", { class: "pad-label" }, "move"), padKnob);
  let padDrag = null;
  padEl.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    padEl.setPointerCapture(ev.pointerId);
    padEl.classList.add("held");
    padDrag = {
      x: ev.clientX, y: ev.clientY,
      from: shadowAnchor(entity, cur.state, cur.dir),
      // Screen pixels -> frame pixels. The canvas draws at `s`, so dividing by
      // it is what makes the shadow move exactly as far as the thumb did.
      k: 1 / (cur.zoom || (state.data.artScale || 2)),
    };
  });
  padEl.addEventListener("pointermove", (ev) => {
    if (!padDrag) return;
    const dx = padGain(ev.clientX - padDrag.x), dy = padGain(ev.clientY - padDrag.y);
    const r = padEl.getBoundingClientRect();
    const lim = Math.max(8, Math.min(r.width, r.height) / 2 - 20);
    // The knob measures the FINE ZONE, not the raw finger: it reaches the rim
    // exactly where the gain turns coarse, so "knob pinned at the edge" is the
    // visible tell that you are now travelling rather than adjusting.
    const knob = (d) => Math.max(-lim, Math.min(lim, (d / PAD_FINE_ZONE) * lim));
    padKnob.style.transform = `translate(${knob(ev.clientX - padDrag.x)}px, ${knob(ev.clientY - padDrag.y)}px)`;
    const f = padDrag.from;
    // Pad right = shadow right relative to the MONSTER (ax+), FOR THE FACET ON
    // SCREEN; on screen the ellipse holds still and the monster slides left —
    // the anchor is the world position, and the sprite is what hangs off it.
    setShadowOffset(entity, cur.state, cur.dir, { ax: f.ax + dx * padDrag.k, ay: f.ay + dy * padDrag.k });
    onShadowEdit?.(); refreshShadowBar(); draw();
  });
  const padEnd = (ev) => {
    if (!padDrag) return;
    padDrag = null;
    padEl.classList.remove("held");
    padKnob.style.transform = "";
    try { padEl.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }
    // Gesture over, nothing under the finger: re-hug the frozen box so the
    // slack never accumulates into an overflow.
    editBox = null;
    draw();
  };
  padEl.addEventListener("pointerup", padEnd);
  padEl.addEventListener("pointercancel", padEnd);

  // Size is two sliders rather than two more pads: a slider is an ABSOLUTE
  // value, so the thumb can be anywhere along a rail he is not looking at
  // while his eye stays on the ellipse — and it shows how much range is left
  // in each direction, which a relative gesture cannot.
  // The rails read/write the SOUTH-facing width and depth as full diameters
  // (the numbers he sees in the readout); the record stores semi-axes.
  const mkSizer = (axis, label) => {
    const inp = h("input", { type: "range", class: "shadow-slider", min: "2", step: "0.5", "aria-label": label });
    const apply = () => {
      const sh = shadowRec(entity);
      const next = { rx: sh.rx, ry: sh.ry, [axis]: +inp.value / 2 };
      setShadowSize(entity, next.rx, next.ry);
      onShadowEdit?.(); refreshShadowBar(); draw();
    };
    inp.addEventListener("input", apply);
    // "change" fires when the finger leaves the rail — the gesture-end re-hug,
    // same as the pad's.
    inp.addEventListener("change", () => { editBox = null; draw(); });
    return inp;
  };
  const wSlider = mkSizer("rx", "shadow width"), hSlider = mkSizer("ry", "shadow depth");
  // The numbers lead, because they are what is being read; the instruction
  // trails, because it is only needed once.
  const shadowBar = h("div", { class: "shadow-bar hidden" },
    h("div", { class: "player-controls" }, shadowRead, shadowResetBtn),
    h("div", { class: "shadow-tools" },
      h("div", { class: "shadow-sliders" },
        h("label", {}, h("span", {}, "W"), wSlider),
        h("label", {}, h("span", {}, "H"), hSlider)),
      padEl),
    h("span", { class: "muted shadow-hint" }, "One SIZE for the whole monster; the pad places THIS animation + direction (others inherit from this direction's Idle). The rails resize; the monster slides opposite the pad."));
  /* ---- EDIT THE SCENERY HITBOX (admin; scenery only) --------------------
   * "We need the same for Scenery ... When I look at an image I immediately
   * see where is the hitbox." Same instrument as the monster shadow — the
   * proxy pad, so his thumb is never on the art — with the four differences
   * scenery has: several ellipses, a rotation on each, "needs none" as a real
   * answer, and no facings to inherit through.
   */
  let hitSel = 0;                       // which ellipse the controls drive
  const hitRead = h("span", { class: "shadow-read" });
  const hitChips = h("div", { class: "hit-chips" });
  /* ELLIPSE OR RECT, PER BOX (maintainer 2026-08-30: "town and indoor often
   * have hitboxes that needs a rect and not an ellipse. Take a table or
   * bookshelf ... will make it possible for me to do a perfect hitbox on a
   * bookshelf, bed, etc and the map-agent can then make use of the perfect
   * hitbox to be able to place the furniture in a corner or against the
   * wall"). Two options in a segment, the same idiom as Placed and Light, so
   * the shape in force is readable without pressing anything — and every other
   * control keeps working on it unchanged, rotation included. */
  const hitShape = h("div", { class: "seg hit-shape" });
  /* THE WORKING LIST. An untouched piece starts from the art's own content
   * box so there is something to drag, but NOTHING IS STORED until he moves
   * it — a piece that merely got looked at must still count as "to do". */
  // ALWAYS THIS VARIATION: its own record, else the piece-level default,
  // else a starting ellipse from THIS state's own measured content box.
  const hitList = () => hitboxes(entity, cur.state) ?? [hitboxDefault(entity, clip?.bb, clip?.fw ?? entity.frameW, clip?.fh ?? entity.frameH, cur.state)];
  const commitHit = (boxes) => { setHitboxes(entity, boxes, cur.state); onShadowEdit?.(); refreshHitBar(); draw(); };
  /** Write a size for the facing on screen: its own when it has opted out of
   *  the shared one, the shared one otherwise. */
  const editSize = (i, part) => {
    const b = hitList()[i];
    if (!b?.size_by_dir?.[cur.dir]) { editHit(i, part); return; }
    const own = { ...boxSize(b, cur.dir), ...part };
    editHit(i, { size_by_dir: { ...b.size_by_dir, [cur.dir]: { rx: own.rx, ry: own.ry } } });
  };
  /** Write a placement for the facing on screen — its own on a turned facing,
   *  the base one on south. Same rule the pad follows. */
  const editPos = (i, part) => {
    const b = hitList()[i];
    if (cur.dir === "south" || !DIR_GROUND_DEG[cur.dir]) { editHit(i, part); return; }
    const now = { ...boxPos(b, cur.dir), ...part };
    editHit(i, { pos_by_dir: { ...(b?.pos_by_dir ?? {}), [cur.dir]: { ax: now.ax, ay: now.ay } } });
  };
  const editHit = (i, patch) => {
    const boxes = hitList().map((b, n) => (n === i ? { ...b, ...patch } : b));
    commitHit(boxes);
  };

  const hitPadKnob = h("span", { class: "pad-knob" });
  const hitPad = h("div", {
    class: "shadow-pad", title: "Drag to move this box — your thumb stays off the art",
  }, h("span", { class: "pad-label" }, "move"), hitPadKnob);
  let hitDrag = null;
  hitPad.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    hitPad.setPointerCapture(ev.pointerId);
    hitPad.classList.add("held");
    const b = hitList()[hitSel];
    hitDrag = { x: ev.clientX, y: ev.clientY, from: boxPos(b, cur.dir), k: 1 / (cur.zoom || (state.data.artScale || 2)) };
  });
  hitPad.addEventListener("pointermove", (ev) => {
    if (!hitDrag) return;
    // The SAME gain curve as the monster pad — the first PAD_FINE_ZONE of
    // thumb travel geared to PAD_FINE, the rest 1:1 — because he tuned that
    // on his own phone and a second feel would be a second thing to learn.
    const dx = padGain(ev.clientX - hitDrag.x), dy = padGain(ev.clientY - hitDrag.y);
    const r = hitPad.getBoundingClientRect();
    const lim = Math.max(8, Math.min(r.width, r.height) / 2 - 20);
    const knob = (d) => Math.max(-lim, Math.min(lim, (d / PAD_FINE_ZONE) * lim));
    hitPadKnob.style.transform = `translate(${knob(ev.clientX - hitDrag.x)}px, ${knob(ev.clientY - hitDrag.y)}px)`;
    const nx = hitDrag.from.ax + dx * hitDrag.k, ny = hitDrag.from.ay + dy * hitDrag.k;
    /* MOVING TOUCHES ONLY THIS FACING. South is the base every other facing
     * falls back to; on any other facing the pad writes that facing's own
     * placement, so squaring a chest up on south-east leaves south and
     * south-west exactly where they were. */
    editPos(hitSel, { ax: nx, ay: ny });
  });
  const hitPadEnd = (ev) => {
    if (!hitDrag) return;
    hitDrag = null;
    hitPad.classList.remove("held");
    hitPadKnob.style.transform = "";
    try { hitPad.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }
    editBox = null; draw();
  };
  hitPad.addEventListener("pointerup", hitPadEnd);
  hitPad.addEventListener("pointercancel", hitPadEnd);

  /* Three rails, same reasoning as the monster's two: a slider is an ABSOLUTE
   * value, so his eye can stay on the ellipse while his thumb is anywhere on
   * a rail he is not looking at. The third is the one scenery needs and a
   * monster never did — "the ellips might still need a rotation to fit the
   * object", because scenery does not turn to face the camera. */
  /* The frozen rail scales, keyed piece#state|ellipse|rail. */
  const railMax = new Map();
  const mkHitRail = (key, label, cfg) => {
    const inp = h("input", { type: "range", class: "shadow-slider", "aria-label": label, ...cfg });
    inp.addEventListener("input", () => {
      const v = +inp.value;
      /* D GROWS UPWARD ONLY, ON AN ELLIPSE (maintainer 2026-08-28: "you are
       * good at finding the bottom, left and right - but you find it harder to
       * know where in y the hitbox ends ... the scaling center is the bottom
       * of the elipse"). The auto-placed bottom is the trustworthy edge there,
       * so the D rail keeps ay+ry fixed and moves only the top.
       *
       * A RECT PIVOTS ON ITS CENTRE, BOTH RAILS (maintainer 2026-09-03: "When
       * I change/draw the D slider on a rect hitbox - the hitbox should have
       * the pivot in the center (it should behave like when I draw the W
       * slider)"). A rect is a ground rectangle he places by its footprint,
       * not an ellipse hung off a contact point: growing it from one edge
       * slides the far edge off the furniture, and on a turned rect "the
       * bottom" is a corner rather than an edge at all. */
      if (key === "h") {
        const b = hitList()[hitSel];
        if (boxShape(entity, b) === "rect") { editSize(hitSel, { ry: v / 2 }); return; }
        const bottom = (boxPos(b, cur.dir).ay ?? 0) + boxSize(b, cur.dir).ry;
        editSize(hitSel, { ry: v / 2 });
        editPos(hitSel, { ay: +(bottom - v / 2).toFixed(2) });
        return;
      }
      /* W GROWS UPWARD FROM ITS LOWER EDGE, ON A RECT (maintainer 2026-09-03:
       * "The pivot when changing W should be at the center of the bottom-left
       * edge so that the width always extends upwards. This makes it easy for
       * me to place the hitbox correct at the bottom and drag the W slider
       * until it's correct at the top as well").
       *
       * W is the extent along the ground's x axis, so the two edges it moves
       * are the ones at ±rx. Which of them is LOWER on screen depends on the
       * facing — south-east puts the −x edge at the bottom left, south-west
       * puts the +x edge at the bottom right — so the pinned edge is chosen by
       * measuring, never by naming a corner: the sign of sin(angle) says which
       * edge the projection pushes down. On south the two edges are level and
       * the left one is pinned, which is the same gesture with nothing to
       * disambiguate.
       *
       * D still pivots on the centre (2026-09-03, earlier the same day) — he
       * asked for the two rails to behave differently and they do. */
      if (key === "w") {
        const b = hitList()[hitSel];
        if (boxShape(entity, b) === "rect") {
          const th = boxRot(entity, b, cur.dir) * Math.PI / 180, k = ISO_K();
          const sigma = Math.sin(th) > 1e-9 ? 1 : -1;          // +1 → the +x edge is the lower one
          const d = v / 2 - boxSize(b, cur.dir).rx;             // half-width delta
          const pos = boxPos(b, cur.dir);
          editSize(hitSel, { rx: v / 2 });
          editPos(hitSel, {
            ax: +(pos.ax - sigma * d * Math.cos(th)).toFixed(2),
            ay: +(pos.ay - sigma * d * Math.sin(th) * k).toFixed(2),
          });
          return;
        }
      }
      if (key === "r") {
        /* ALIGNING A FACING TOUCHES ONLY THAT FACING. South is the base angle
         * the others are derived from; on any other facing the rail stores
         * that facing's own angle, so a bookshelf he squares up on south-east
         * does not drag south and south-west out of true. */
        const b2 = hitList()[hitSel];
        if (cur.dir === "south" || !DIR_GROUND_DEG[cur.dir]) { editHit(hitSel, { rot: v }); return; }
        editHit(hitSel, { rot_by_dir: { ...(b2?.rot_by_dir ?? {}), [cur.dir]: v } });
        return;
      }
      editSize(hitSel, { rx: v / 2 });
    });
    /* A DRAG IS HELD, AND THE SCALE CANNOT MOVE UNDER IT. Tracked with pointer
     * events rather than focus, because a touch on a range input does not
     * reliably focus it — and the phone is the only device he reviews on. */
    inp.addEventListener("pointerdown", () => { inp.__drag = true; });
    const release = () => { inp.__drag = false; };
    inp.addEventListener("pointerup", release);
    inp.addEventListener("pointercancel", release);
    /* THE SCALE ONLY MOVES WHEN HE HAS RUN OUT OF RAIL (maintainer 2026-08-30:
     * "The hitbox slider is now completely useless! It's not linear. I change
     * it just a bit and the hitbox blows away."). Deriving the max from the
     * LIVE value on every render made the rail a FEEDBACK LOOP: a nudge right
     * grew the value, the bigger value grew the max, the thumb kept its pixel
     * position on the now-longer scale, and the next move read a bigger number
     * still — so one slow drag ran the ellipse away exponentially.
     *
     * The scale is cached per ellipse and frozen for the whole drag, which is
     * what makes the rail linear. It is re-derived on RELEASE, and only when
     * the value actually reached an end of the rail: over 90% (he needs more
     * room) or under 15% (he needs finer steps). Re-scaling on every release
     * would teleport the thumb to a third of the rail every time he let go. */
    inp.addEventListener("change", () => {
      const v = +inp.value, m = +inp.max;
      if (inp.__railKey && m > 0 && (v > m * 0.9 || v < m * 0.15)) {
        railMax.delete(inp.__railKey);
        refreshHitBar();
      }
      editBox = null;
      draw();
    });
    return inp;
  };
  const hitW = mkHitRail("w", "Width", { min: "2", step: "0.5" });
  const hitH = mkHitRail("h", "Depth", { min: "2", step: "0.5" });
  // 0-179, not 0-359: an ellipse is symmetric under a half turn, so the top
  // half of the circle is every distinct shape there is. Offering 360 would
  // give him two ways to say the same thing and a rail twice as coarse.
  const hitRot = mkHitRail("r", "Rotation", { min: "0", max: "179", step: "1" });

  const hitAddBtn = h("button", {
    class: "ghost-btn",
    title: "Add a second box — an entrance with two pillars touches the ground twice, an L-shaped counter is two rects",
    onclick: () => {
      const boxes = hitList();
      const b = boxes[hitSel] ?? hitboxDefault(entity, clip?.bb, clip?.fw, clip?.fh, cur.state);
      // Offset from the one it was copied from, so the new one is visible
      // instead of hiding exactly behind its parent.
      boxes.push({ ...b, ax: +(b.ax + b.rx * 1.2).toFixed(2) });
      hitSel = boxes.length - 1;
      commitHit(boxes);
    },
  }, "+ box");
  const hitDelBtn = h("button", {
    class: "ghost-btn",
    title: "Remove this box",
    onclick: () => {
      const boxes = hitList().filter((_, i) => i !== hitSel);
      hitSel = Math.max(0, hitSel - 1);
      commitHit(boxes);
    },
  }, "− box");
  /* "SOME SCENERY IS MEANT TO BE PLACED ON A HOUSE/MOUNTAIN/CAVE WALL - THEY
   * OFC NEED NO HITBOX." An empty list is a DECISION and is stored as one, so
   * the queue can tell it apart from a piece nobody has opened. */
  const hitNoneBtn = h("button", {
    class: "ghost-btn",
    title: "This piece needs no hitbox — the right answer for anything hung on a wall. It leaves the to-do queue.",
    onclick: () => { hitSel = 0; commitHit([]); },
  }, "⊘ needs none");
  const hitFlatBtn = h("button", {
    class: "ghost-btn",
    title: "Flat on the floor — a carpet, a rug, a puddle. The player WALKS OVER it: no collision, and it never comes between them and the camera. The scenery domain tags these; this corrects a wrong tag either way, for the whole piece.",
    onclick: () => { hitSel = 0; setHitboxFlat(entity, !hitboxFlat(entity)); onShadowEdit?.(); refreshHitBar(); draw(); },
  }, "⊘ no collision");
  /* OPT IN, PER FACING (maintainer 2026-09-03: "Some art just looks that way
   * and we can't do anything about it. We need a dedicated W and D for the S
   * direction. But to make this good we should add that as an opt-in ... You
   * can if you want 'request unique size' when standing on the S direction. Or
   * 'go back to shared size'"). One button that says which state it is in and
   * flips it, on the facing he is standing on. Opting in seeds the facing with
   * the size it already had, so the box does not jump the moment he asks. */
  const hitSizeBtn = h("button", {
    class: "ghost-btn",
    onclick: () => {
      const b = hitList()[hitSel];
      if (!b) return;
      const own = { ...(b.size_by_dir ?? {}) };
      if (own[cur.dir]) delete own[cur.dir];
      else own[cur.dir] = { rx: +b.rx, ry: +b.ry };
      editHit(hitSel, { size_by_dir: own });
    },
  });
  const hitResetBtn = h("button", {
    class: "ghost-btn",
    title: "Forget this piece's record entirely — it goes back to undecided and returns to the to-do queue",
    onclick: () => { hitSel = 0; clearHitbox(entity, cur.state); onShadowEdit?.(); refreshHitBar(); draw(); },
  }, "Reset");

  /* THE INSTRUMENT FIRST (maintainer 2026-09-02: "When editing hitboxes I want
   * the sliders and move tool to be the first thing after the preview", with
   * the read line and the piece-level buttons circled as what goes under
   * them). He drags the rails and the pad on every piece and presses those
   * buttons once or never, so the order matches the frequency — and the rails
   * sit directly under the art they change, where his thumb already is.
   *
   * NO HELP TEXT ("You can also remove the text 'The ground this piece stands
   * on…'. I don't need help text like that."). What it explained lives in
   * live/README.md, which is where the consuming agents read. */
  const hitBar = h("div", { class: "shadow-bar hit-bar hidden" },
    h("div", { class: "shadow-tools" },
      h("div", { class: "shadow-sliders" },
        h("label", {}, h("span", {}, "W"), hitW),
        h("label", {}, h("span", {}, "D"), hitH),
        h("label", {}, h("span", {}, "⟳"), hitRot)),
      hitPad),
    h("div", { class: "player-controls" }, hitRead),
    h("div", { class: "player-controls hit-shape-row" }, hitChips, hitShape),
    h("div", { class: "player-controls" }, hitAddBtn, hitDelBtn, hitSizeBtn, hitNoneBtn, hitFlatBtn, hitResetBtn));
  // Absent, not disabled: a control that can never do anything is a worse
  // answer than none (the Base-tab lesson). The card's type pill says why.
  const hitBtn = state.admin && kind === "object" && !isWallScenery(entity)
    ? h("button", {
      class: "ghost-btn shadow-btn",
      title: "Draw the ground this piece occupies — its hitbox, and the line that decides whether the player walks in front of it or behind. Committed with everything else.",
      onclick: () => setEditHit(!cur.editHit),
    }, "✎ Edit hitbox")
    : null;
  /* ONE TAP SAYS "THE DEFAULT IS RIGHT" (maintainer 2026-08-28: "Next to
   * button 'Edit hitbox' should be a button called 'Accept default hitbox'").
   * It stores the very boxes on screen, without the auto flag — the same
   * record a manual edit would write — so the piece becomes "hitbox set". */
  const hitAcceptBtn = hitBtn
    ? h("button", {
      class: `ghost-btn shadow-btn${hitboxState(entity, cur.state) !== "todo" ? " hidden" : ""}`,
      title: "The proposed hitbox is right as drawn — store it as YOUR decision. Only accepted or hand-edited hitboxes count as set.",
      onclick: () => { setHitboxes(entity, hitList(), cur.state); onShadowEdit?.(); refreshHitBar(); draw(); },
    }, "✓ Accept default hitbox")
    : null;
  /* BROWSE WITH THE HITBOX VISIBLE (maintainer 2026-08-28: "with this mode I
   * can browse around and always be able to see the hitbox"). Persisted, so
   * the ‹ › pager keeps it on from piece to piece. */
  const hitShowBtn = hitBtn
    ? h("button", {
      class: `ghost-btn shadow-btn${hitAlwaysShow() ? " on" : ""}`,
      title: "Draw the hitbox on every piece while you browse — no editor needed. Stays on until you turn it off.",
      onclick: () => {
        try { localStorage.setItem(HIT_ALWAYS_KEY, hitAlwaysShow() ? "0" : "1"); } catch {}
        hitShowBtn.classList.toggle("on", hitAlwaysShow());
        editBox = null;
        draw();
      },
    }, "👁 Always show hitbox")
    : null;
  function setEditHit(on) {
    cur.editHit = !!on && !!hitBtn;
    editBox = null;
    stage.classList.toggle("editing-shadow", cur.editHit);
    refreshHitBar();
    draw();
  }
  function refreshHitBar() {
    if (!hitBtn) return;
    // Accept exists exactly while the decision is still a proposal.
    if (hitAcceptBtn) hitAcceptBtn.classList.toggle("hidden", hitboxState(entity, cur.state) !== "todo");
    hitBar.classList.toggle("hidden", !cur.editHit);
    hitBtn.classList.toggle("on", cur.editHit);
    if (!cur.editHit) return;
    const st = hitboxState(entity, cur.state);
    const boxes = hitList();
    hitSel = Math.min(hitSel, Math.max(0, boxes.length - 1));
    const b = boxes[hitSel];
    // ONE CHIP PER ELLIPSE, because with two pillars he must be able to say
    // which one the rails are driving without hunting for it on the art.
    hitChips.replaceChildren(...boxes.map((_, i) => {
      const on = i === hitSel;
      return h("button", {
        class: `sortbar-btn${on ? " sel" : ""}`, type: "button",
        title: `Edit ellipse ${i + 1} of ${boxes.length}`,
        onclick: () => { hitSel = i; refreshHitBar(); draw(); },
      }, `${i + 1}`);
    }));
    hitChips.classList.toggle("hidden", boxes.length < 2);
    // The size button: what this facing is doing, and what pressing it does.
    {
      const own = !!b?.size_by_dir?.[cur.dir];
      const many = Object.keys(entity?.animations?.[cur.state]?.dirs ?? {}).length > 1;
      hitSizeBtn.classList.toggle("hidden", !many || !b);
      hitSizeBtn.classList.toggle("on", own);
      hitSizeBtn.textContent = own ? `↩ shared size` : `⤢ unique size`;
      hitSizeBtn.title = own
        ? `${dirWordOf(cur.dir)} has its own W and D. Press to go back to the size shared by every facing.`
        : `W and D are shared by every facing. Press to give ${dirWordOf(cur.dir)} its own — for art whose facings genuinely disagree.`;
    }
    const shapeNow = boxShape(entity, b);
    // Choosing the domain's own answer DELETES the correction — the tag stands
    // on its own, and the day scenery re-tags a piece the wiki follows.
    const shapeTag = taggedShape(entity);
    hitShape.replaceChildren(...[
      ["ellipse", "◯ ellipse", "A rounded footprint — trees, rocks, barrels: anything with no straight edge"],
      ["rect", "▭ rect", "Straight edges and square corners — a table, a bookshelf, a bed. This is what lets the map agent push a piece flush into a corner or against a wall."],
    ].map(([k, label, title]) => {
      // `disabled` is a PROPERTY here, never an h() attribute: an attribute
      // named disabled disables the button whatever its value, so passing
      // `false` through h() would grey out both shapes on every piece.
      const btn = h("button", {
        class: shapeNow === k ? "on" : "", type: "button", title,
        onclick: () => { if (shapeNow !== k) editHit(hitSel, { shape: k === shapeTag ? null : k }); },
      }, label);
      btn.disabled = st === "flat" || !b;
      return btn;
    }));
    hitDelBtn.disabled = boxes.length < 2;
    hitNoneBtn.disabled = st === "none" || st === "flat";
    hitFlatBtn.classList.toggle("on", st === "flat");
    hitAddBtn.disabled = st === "flat";
    hitW.disabled = hitH.disabled = hitRot.disabled = st === "flat";
    hitResetBtn.disabled = !hitboxRaw(entity, cur.state);
    /* BOTH RAILS REACH TWICE THE FRAME (maintainer 2026-08-27: "Why is this the
     * max D? Some scenery are really long/tall/wide... Make the max a little
     * bigger/longer").
     *
     * D was capped at 0.8 of the frame HEIGHT on the assumption that a ground
     * footprint is always foreshortened — which is wrong twice over: a long
     * piece laid across the ground (a fallen log, an aqueduct span) is genuinely
     * deep, and once an ellipse is TURNED the D rail is its long axis. The two
     * rails are the same quantity in different directions, so they get the same
     * reach. Range costs nothing here: the step stays 0.5px, so a bigger max is
     * more room, not less precision, and the canvas already grows to hold
     * whatever they produce. */
    const fw = clip?.fw ?? entity.frameW ?? 96, fh = clip?.fh ?? entity.frameH ?? 96;
    /* THE RAILS SPAN THE ART, NOT THE FRAME (maintainer 2026-08-29: "It's
     * very hard to use the slider to edit a hitbox because you have made the
     * max numbers so insanely big"). Twice the FRAME put a 96px piece on a
     * 192px rail and a 256px piece on a 512px one, so a thumb's width moved
     * the ellipse several pixels and the useful range — a footprint near the
     * art's own size — was a sliver in the middle.
     *
     * A quarter past the piece's own content box is the honest reach: it
     * covers any footprint that matches the art, with room to overshoot, and
     * every pixel of rail is somewhere he might land. His 2026-08-27 ask for
     * MORE range is kept where it was actually about long pieces — the box
     * is measured, so a fallen log's rail is as long as the log. A stored box
     * bigger than that (or a turned ellipse using D as its long axis) still
     * shows: the rail never ends below the value it is displaying. */
    /* THE RAIL FOLLOWS THE BOX, not just the art (maintainer 2026-08-29:
     * "It's very hard to set the hitbox on a tree using the slider. The max
     * value is so huge and the root try to use the slider for is so small so
     * the resolution is very bad on trees"). A tree's footprint is its TRUNK
     * — 40px inside a 245px canopy — so a rail scaled to the art spent 85% of
     * its travel on sizes no tree will ever have.
     *
     * Both rails share one scale, three times the ellipse's own longest axis,
     * capped by the art's reach and floored at 48. Three times leaves room to
     * grow in one drag; releasing re-scales, so growing again is always
     * possible and the range zooms with the work instead of against it. And
     * the rail never ends below the value it is showing, so an existing wide
     * box still displays and still drags. */
    const cw = clip?.bb ? clip.bb[2] - clip.bb[0] : fw;
    const ch = clip?.bb ? clip.bb[3] - clip.bb[1] : fh;
    const artReach = Math.max(48, Math.round(Math.max(cw, ch) * 1.25));
    /* EACH RAIL ON ITS OWN SCALE. Sharing one — keyed to the longest axis —
     * is what made DEPTH unusable: a ground footprint is about a third as
     * deep as it is wide, so the D rail spent two thirds of its travel on
     * depths no ellipse of that width will ever have. Measured on a tree
     * trunk 40 wide and 12 deep: D went from a 120px rail to a 36px one. */
    const reach = (cur2) => Math.max(24, Math.min(artReach, Math.round(cur2 * 3)), Math.ceil(cur2));
    /* ONE FROZEN SCALE PER ELLIPSE. The key is the piece, its state and which
     * ellipse, so stepping to another one measures afresh while this one holds
     * still. Outside a drag the scale is re-derived whenever the value sits at
     * either end of it — that is what re-fits the rail after Reset, after
     * Accept default, or when a proposal lands, without any of those buttons
     * having to know this cache exists. The floor keeps a stored box wider
     * than the cached scale visible and draggable. */
    const railFor = (rail, inp, cur2) => {
      const k = `${hitboxKey(entity, cur.state) ?? "?"}|${hitSel}|${rail}`;
      inp.__railKey = k;
      const held = inp.__drag === true || document.activeElement === inp;
      let m = railMax.get(k);
      if (m == null || (!held && (cur2 > m * 0.9 || cur2 < m * 0.15))) {
        m = reach(cur2);
        railMax.set(k, m);
      }
      return Math.max(m, Math.ceil(cur2));
    };
    hitW.max = String(railFor("w", hitW, b ? b.rx * 2 : 0));
    hitH.max = String(railFor("h", hitH, b ? b.ry * 2 : 0));
    if (b) {
      const szR = boxSize(b, cur.dir);
      if (document.activeElement !== hitW) hitW.value = String(szR.rx * 2);
      if (document.activeElement !== hitH) hitH.value = String(szR.ry * 2);
      // The rail shows the angle IN FORCE for the facing on screen, which on a
      // rect is the tuned angle plus that facing's tilt.
      if (document.activeElement !== hitRot) hitRot.value = String(((Math.round(boxRot(entity, b, cur.dir)) % 180) + 180) % 180);
    }
    const signed = (n) => `${n < 0 ? "−" : "+"}${Math.abs(n).toFixed(1)}`;
    hitRead.replaceChildren(
      st === "flat"
        ? h("b", {}, "no collision — flat on the floor, the player walks over it")
        : st === "none"
        ? h("b", {}, "no hitbox — this piece hangs on a wall")
        // "box", not "ellipse": with two shapes on offer the count can span
        // both, and the glyph says which one the rails are driving.
        : h("b", {}, `${boxes.length} box${boxes.length === 1 ? "" : "es"} · #${hitSel + 1} ${boxShape(entity, b) === "rect" ? "▭" : "◯"} ${(boxSize(b, cur.dir).rx * 2).toFixed(1)} × ${(boxSize(b, cur.dir).ry * 2).toFixed(1)} px${boxSize(b, cur.dir).unique ? " · own size" : ""}`),
      st === "none" || st === "flat" ? "" : ` · at ${signed(boxPos(b, cur.dir).ax)}, ${signed(boxPos(b, cur.dir).ay)}${Math.round(boxRot(entity, b, cur.dir)) ? ` · turned ${Math.round(boxRot(entity, b, cur.dir))}°` : ""}`,
      /* NO STATUS PROSE ON THIS LINE (maintainer 2026-08-29: "you draw this
       * text 'proposed default not set until you accept or adjust it' and
       * then I try to click on the Width slider and then you remove that text
       * and move all sliders up so I always select the slider under it
       * instead ... I don't need that stupid text").
       *
       * It wrapped to a second line, and adjusting anything turned the state
       * from proposed to set — so the line unwrapped, the bar lost a row, and
       * the rails jumped up under his thumb mid-tap. The Accept button
       * already says a proposal is a proposal, and it is beside the picture
       * rather than under his finger. */
      "",
    );
  }

  const shadowBtn = state.admin && kind === "monster"
    ? h("button", {
      class: "ghost-btn shadow-btn",
      title: "Tune this monster's ONE shadow — its centre is the monster's position in game, its size the hit box; it turns with the facing. Committed with everything else.",
      onclick: () => setEditShadow(!cur.editShadow),
    }, "✎ Edit shadow")
    : null;
  function setEditShadow(on) {
    cur.editShadow = !!on && !!shadowBtn;
    editBox = null;   // re-freeze the box from the CURRENT record on entry
    // You cannot place what you cannot see, so the editor brings the shadow
    // with it — and the checkbox follows, or it would be lying.
    if (cur.editShadow && !cur.shadow) { cur.shadow = true; shadowChk.checked = true; }
    stage.classList.toggle("editing-shadow", cur.editShadow);
    refreshShadowBar();
    draw();
  }
  /** The numbers, in FRAME pixels — the units monsters.json speaks, so what is
   *  read here and what lands in the note are the same quantity. */
  function refreshShadowBar() {
    if (!shadowBtn) return;
    shadowBar.classList.toggle("hidden", !cur.editShadow);
    shadowBtn.classList.toggle("on", cur.editShadow);
    if (!cur.editShadow) return;
    const sh = shadowRec(entity);
    const anc = shadowAnchor(entity, cur.state, cur.dir);
    const signed = (n) => `${n < 0 ? "\u2212" : "+"}${Math.abs(n).toFixed(1)}`;
    // Two-stage Reset, labelled for what it will actually do right now.
    const facetOwn = anc.source === "facet";
    shadowResetBtn.disabled = !sh.edited;
    shadowResetBtn.textContent = facetOwn ? "Reset offset" : "Clear shadow";
    shadowResetBtn.title = facetOwn
      ? `Drop the offset for ${stateLabel(cur.state)} \u00b7 ${DIR_LABEL[cur.dir] ?? cur.dir} \u2014 it falls back down the chain (idle of this direction, then the default)`
      : "No offset on this animation+direction \u2014 pressing clears the monster's whole shadow record and the game returns to its measured anchors";
    const fw = entity.frameW ?? 64, fh = entity.frameH ?? 64;
    wSlider.max = String(Math.max(32, Math.round(fw * 1.2)));
    hSlider.max = String(Math.max(16, Math.round(fh / 2)));
    if (document.activeElement !== wSlider) wSlider.value = String(sh.rx * 2);
    if (document.activeElement !== hSlider) hSlider.value = String(sh.ry * 2);
    // WHERE THIS OFFSET COMES FROM is the fact he tunes by (maintainer
    // 2026-08-20: "The shadow offset is per animation and direction"):
    const from = anc.source === "facet" ? `set for ${stateLabel(cur.state)} \u00b7 ${DIR_LABEL[cur.dir] ?? cur.dir}`
      : anc.source === "idle" ? `inherited from Idle \u00b7 ${DIR_LABEL[cur.dir] ?? cur.dir}`
      : anc.source === "base" ? "the monster-wide offset (v1)"
      : "the measured default";
    shadowRead.replaceChildren(
      h("b", {}, `${(sh.rx * 2).toFixed(1)} \u00d7 ${(sh.ry * 2).toFixed(1)} px`),
      ` \u00b7 offset ${signed(anc.ax)}, ${signed(anc.ay)} \u2014 ${from}`,
      sh.edited ? "" : " \u00b7 untuned \u2014 commit any change to adopt it",
    );
  }



  const controls2 = h("div", { class: "player-controls" },
    noTransport ? null : playBtn,
    noTransport ? null : h("button", { class: "ghost-btn", title: "Previous frame", onclick: () => step(-1) }, "⏮"),
    noTransport ? null : h("button", { class: "ghost-btn", title: "Next frame", onclick: () => step(1) }, "⏭"),
    noTransport ? null : frameNo,
    noTransport ? null : speedSeg,
    zoomSeg,
    kind === "monster" ? h("label", { class: "chk" }, shadowChk, "Show shadow") : null,
    shadowBtn,
    hitBtn,
    hitAcceptBtn,
    hitShowBtn,
  );

  let onFacetChange = null;
  if (!anims[cur.state]?.dirs?.[cur.dir]) {
    cur.dir = state.data.directions.find((d) => anims[cur.state]?.dirs?.[d]) ?? cur.dir;
    renderDirPad();
  }
  loadClip();
  const rootEl = h("div", { class: "player" },
    // "Judging <state · direction>" rides ABOVE the selectors it describes
    // (maintainer 2026-08-14: "can you put the Judging over the state/
    // animation selection instead?") — you read what is about to be judged,
    // then pick it. The controls that DO the judging stay under the preview,
    // where the whole-entity verdict is not.
    opts.headerEl ?? null,
    // BOTH ROWS, ALWAYS. A row that appears only on the pieces that have
    // something in it moves the preview up and down as you page ‹ › — the
    // maintainer reviews hundreds of pieces in a row and the art has to stay
    // put. A lone state reads "Static"; a lone direction shows just "S".
    h("div", { class: "player-controls" }, stateSeg),
    // ONE PLACE FOR THE DIRECTION PAD, whatever the entity (maintainer
    // 2026-08-14: "on monsters and players the direction is OVER the preview
    // — please make it similar looking"). A still's pad sat under the stage
    // for a while so a rotated piece wouldn't push the art down; he'd rather
    // have it look the same everywhere, so above the stage it is.
    h("div", { class: "player-controls" }, dirPad),
    // The shadow tools go DIRECTLY under the art, above the transport and zoom
    // rows: the pad and the ellipse have to be on screen together, and every
    // row between them is a row that can push one of the two off a phone.
    stage, overflowNote, shadowBar, hitBar, controls2);
  return {
    el: rootEl,
    destroy: () => cancelAnimationFrame(rafTimer),
    getState: () => cur.state,
    getDir: () => cur.dir,
    /** Repaint the approved/rejected marks — call after a verdict changes. */
    refreshMarks() { renderStateSeg(); revealActiveState(); renderDirPad(); },
    /** Shadow editing: one record per monster (see shadowRec). */
    editShadow(on) { setEditShadow(on); },
    isEditingShadow: () => cur.editShadow,
    set onShadowEdit(fn) { onShadowEdit = fn; },
    resetShadow() { clearShadow(entity); refreshShadowBar(); draw(); },
    shadowInfo: () => ({ st: cur.state, dir: cur.dir, rec: shadowRec(entity), anchor: shadowAnchor(entity, cur.state, cur.dir), default: shadowDefault(entity) }),
    /** Fires whenever the state OR the direction changes — i.e. whenever the
     *  thing on screen is a different piece of generated art. */
    set onFacetChange(fn) { onFacetChange = fn; },
    // Show/hide the admin size reference without rebuilding the page — the
    // toggle must not reset the clip, the zoom, or the scroll.
    humanToggle(on) {
      if (!human) return;
      human.style.display = on ? "" : "none";
      draw();
    },
  };
}
let activePlayers = [];
function destroyPlayers() { activePlayers.forEach((p) => p.destroy()); activePlayers = []; }

/* ---------------------------------------------------------------- audio */
const audioEl = () => $("#shared-audio");
let playingBtn = null;
async function playTake(files, btn) {
  const a = audioEl();
  // ogg first: Chrome and Firefox both decode it and it is the smaller file;
  // m4a is Safari's (no ogg); mp3/wav are the fallbacks. Same order as the
  // WebAudio auditions, so the page and the sound engine agree on formats.
  const src = files.ogg ?? files.m4a ?? files.mp3 ?? files.wav;
  if (playingBtn === btn && !a.paused) { a.pause(); return; }
  if (playingBtn) { playingBtn.classList.remove("playing"); playingBtn.textContent = "▶"; }
  // composer/** is not in the image (see composerRoot) — it streams from the repo.
  a.src = src.startsWith("composer/") ? await composerUrl(src) : assetUrl(src);
  a.play().catch((e) => toast(`Playback failed: ${e.message}`));
  playingBtn = btn;
  btn.classList.add("playing"); btn.textContent = "⏸";
  a.onpause = a.onended = () => { btn.classList.remove("playing"); btn.textContent = "▶"; if (playingBtn === btn) playingBtn = null; };
}
/** Silence everything the WIKI is playing. Two independent players live on
 *  this page and stopping one leaves the other sounding: the WebAudio
 *  auditions (sfxEngine) and this shared <audio> element, which carries music
 *  beds and entity takes. Anything that takes over the screen — the picker,
 *  a route change — has to cut both. */
/* ======================= THE MUSIC BENCH — the engine =====================
 * Maintainer 2026-08-22: "Playback must be sample-accurate, or none of this
 * works. Use Web Audio: decode each phrase to an AudioBuffer once, cache it,
 * and schedule with source.start(when) on the AudioContext clock, always at
 * least one phrase ahead. Do NOT use <audio> elements or call play() per
 * phrase — that gaps and clicks at every join, and I'd be judging the player
 * instead of the music. A phrase boundary must be inaudible."
 *
 * So there is ONE decode per take, cached, and every phrase is a SLICE of that
 * buffer — `src.start(when, offsetS, durS)` — handed to the hardware clock
 * ahead of time. Nothing is triggered by a timer at the moment it should
 * sound; the timer only ever schedules the future.
 *
 * PHRASE N OF A TAKE starts at anchorS + N × phraseMs/1000, with phraseMs from
 * that take's own measured tempo (see buildBench). The bench never uses the
 * brief's number.
 *
 * TWO DECKS, because two beds in one suite are meant to sit on top of each
 * other. Deck B runs through its own gain so it can be ducked under A.
 *
 * IT SURVIVES A RE-RENDER. Verdicts must not stop the music — "I need to judge
 * in context" — and committing calls route(), so the engine lives at module
 * scope with no DOM in it, and only a navigation AWAY from the bench stops it.
 */
const BENCH_BUS_DB = -14;                 // the game's music bus
const BENCH_LOOKAHEAD = 0.7;              // schedule this far ahead, in seconds
const BENCH_TICK_MS = 120;
const benchTakes = new Map();             // takeId -> take record, filled by the page
function benchTake(id) { return benchTakes.get(id) ?? null; }
/** One scheduled phrase, so a switch can cut sources that have not sounded. */
function benchDeck(name) {
  return { name, gain: null, order: [], cursor: 0, nextAt: 0, live: [], plan: null, playing: false };
}
const benchEngine = {
  ctx: null, bus: null, timer: null,
  buffers: new Map(),                     // takeId -> Promise<AudioBuffer|null>
  errors: new Map(),                      // takeId -> why it could not be loaded
  decks: { a: benchDeck("a"), b: benchDeck("b") },
  duck: 0.25,                             // deck B's gain (the −75% default)
  onChange: null,                         // the page repaints from engine state
  ac() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.bus = this.ctx.createGain();
      // AUDITION THROUGH THE GAME'S OWN MUSIC BUS (−14 dB), or music and sound
      // effects cannot be compared (maintainer 2026-08-22).
      this.bus.gain.value = 10 ** (BENCH_BUS_DB / 20);
      this.bus.connect(this.ctx.destination);
      for (const d of Object.values(this.decks)) {
        d.gain = this.ctx.createGain();
        d.gain.gain.value = d.name === "b" ? this.duck : 1;
        d.gain.connect(this.bus);
      }
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },
  /** ONE decode per take, cached forever — "don't re-download a 2 MB file every
   *  time I press play". Format order is ogg first, m4a second: Chromium ships
   *  no AAC decoder and Safari no Ogg, so trying both is what makes the bench
   *  work on his phone AND in the gate. */
  buffer(takeId) {
    if (this.buffers.has(takeId)) return this.buffers.get(takeId);
    const take = benchTake(takeId);
    const cands = take ? [take.files?.ogg, take.files?.m4a, take.files?.mp3].filter(Boolean) : [];
    const p = (async () => {
      const why = [];
      for (const rel of cands) {
        const url = rel.startsWith("composer/") ? await composerUrl(rel) : assetUrl(rel);
        try {
          const r = await fetch(url);
          if (!r.ok) { why.push(`${String(url).split("/").pop()} → HTTP ${r.status}`); continue; }
          const buf = await this.ac().decodeAudioData(await r.arrayBuffer());
          if (buf) return buf;
          why.push(`${String(url).split("/").pop()} → could not be decoded`);
        } catch (e) {
          why.push(`${String(url).split("/").pop()} → ${String(e.message ?? e).slice(0, 60)}`);
        }
      }
      // A SILENT FAILURE IS THE WORST OUTCOME: he pressed play and nothing
      // happened, with nothing on screen to say why. Keep the reason.
      this.errors.set(takeId, why.join("; ") || "no audio file published for this take");
      return null;
    })();
    this.buffers.set(takeId, p);
    return p;
  },
  /** Decode everything this order needs and put it in `ready`.
   *
   *  A SWITCH MUST NOT DECODE. Measured 2026-08-22: computing the beat
   *  boundary and THEN awaiting a 2 MB decode inside the same handler put the
   *  cut a whole phrase late — the scheduler kept booking the old order while
   *  the await sat there, and "next beat" landed 62.7 beats out instead of on
   *  the next one. So the audio is warm before the clock is ever read. */
  async warm(order) {
    this.ready ??= new Map();
    const ids = [...new Set(order.map((x) => x.takeId))];
    await Promise.all(ids.map(async (id) => {
      const b = await this.buffer(id);
      if (b) this.ready.set(id, b);
    }));
  },
  /** Is this order playable RIGHT NOW, with no decode in the way? */
  isWarm(order) {
    this.ready ??= new Map();
    return order.every((x) => this.ready.has(x.takeId));
  },
  slice(item) {
    const take = benchTake(item.takeId);
    if (!take || !take.phraseMs) return null;
    const dur = item.durS ?? take.phraseMs / 1000;
    const start = item.startS ?? (take.anchorS ?? 0) + item.idx * (take.phraseMs / 1000);
    return { takeId: item.takeId, start, dur };
  },
  /** Schedule everything that falls inside the look-ahead window. Called on a
   *  timer, but the timer never TRIGGERS audio — it only ever books it. */
  tick() {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const d of Object.values(this.decks)) {
      if (!d.playing || !d.order.length) continue;
      let guard = 0;
      // ALWAYS AT LEAST ONE PHRASE AHEAD, in his words — not merely "inside a
      // look-ahead window". A phrase here is 13-20 s, so a 0.7 s window would
      // book the next join with 0.7 s to spare and a cross-take order would be
      // racing a decode. Keeping TWO in flight (the one sounding and the next)
      // means the join is already on the hardware clock long before it sounds.
      const queued = () => d.live.filter((x) => x.end > ctx.currentTime).length;
      while ((queued() < 2 || d.nextAt < ctx.currentTime + BENCH_LOOKAHEAD) && guard++ < 16) {
        const item = d.order[d.cursor % d.order.length];
        const sl = this.slice(item);
        if (!sl) { d.cursor++; continue; }
        const buf = this.ready?.get(sl.takeId);
        if (!buf) { d.nextAt = ctx.currentTime + 0.05; break; }   // still decoding
        const at = Math.max(d.nextAt, ctx.currentTime + 0.01);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(d.gain);
        const off = Math.max(0, Math.min(sl.start, Math.max(0, buf.duration - 0.01)));
        const dur = Math.max(0.02, Math.min(sl.dur, buf.duration - off));
        src.start(at, off, dur);
        d.live.push({ src, at, end: at + dur, item });
        // FULL PRECISION, not a rounded copy: the gate asserts that a switch is
        // booked exactly where it was computed, and rounding the log to 0.1 ms
        // made it look like 5 µs of drift that the audio never had.
        benchPlays.push({ deck: d.name, take: sl.takeId, idx: item.idx, at, dur });
        d.nextAt = at + dur;
        d.cursor++;
      }
      d.live = d.live.filter((x) => x.end > ctx.currentTime - 1);
    }
    this.onChange?.();
  },
  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), BENCH_TICK_MS);
  },
  /** Start a deck on an order. `at` lets a switch land on a beat boundary. */
  async start(deckKey, order, at) {
    const d = this.decks[deckKey];
    const ctx = this.ac();
    // Only ever awaits on a COLD start (the first press). A switch pre-warms,
    // so this returns without yielding and `at` is met to the sample.
    if (!this.isWarm(order)) await this.warm(order);
    d.order = order.slice();
    d.cursor = 0;
    d.nextAt = Math.max(at ?? 0, ctx.currentTime + 0.05);
    d.playing = true;
    d.gain.gain.cancelScheduledValues(ctx.currentTime);
    d.gain.gain.setValueAtTime(deckKey === "b" ? this.duck : 1, ctx.currentTime);
    this.ensureTimer();
    this.tick();
  },
  /** Everything booked at or after `when` is cancelled, and a phrase spanning
   *  it is cut there. This is what makes "next beat" a cut and not an overlap. */
  cut(deckKey, when) {
    const d = this.decks[deckKey];
    for (const s of d.live) {
      try { if (s.at >= when || s.end > when) s.src.stop(when); } catch { /* already done */ }
    }
    // A CUT SHORTENS THE RECORD TOO. Leaving `end` at its original value left
    // the scheduler believing two phrases were still sounding, so it deferred
    // the replacement instead of booking it at the cut.
    d.live = d.live.filter((x) => x.at < when).map((x) => ({ ...x, end: Math.min(x.end, when) }));
  },
  stop(deckKey) {
    const d = this.decks[deckKey];
    d.playing = false;
    for (const s of d.live) { try { s.src.stop(); } catch { /* already done */ } }
    d.live = []; d.order = []; d.plan = null; d.cursor = 0; d.nextAt = 0;
    this.onChange?.();
  },
  stopAll() { for (const k of Object.keys(this.decks)) this.stop(k); },
  /** Where the next beat falls, on the deck's own clock. Everything in a suite
   *  shares a tempo, so a beat cut inside a suite is seamless by construction. */
  nextBeatAt(deckKey, bpm) {
    const ctx = this.ac();
    const d = this.decks[deckKey];
    const beat = 60 / (bpm || 120);
    const cur = d.live.find((x) => x.at <= ctx.currentTime && x.end > ctx.currentTime);
    const from = cur ? cur.at : ctx.currentTime;
    const n = Math.ceil((ctx.currentTime + 0.06 - from) / beat);
    const at = from + n * beat;
    this.lastSwitch = { mode: "beat", bpm, beat, from, now: ctx.currentTime, n, at };
    return at;
  },
  /** The end of the phrase now sounding — a calm transition. */
  nextPhraseAt(deckKey) {
    const ctx = this.ac();
    const d = this.decks[deckKey];
    const cur = d.live.find((x) => x.at <= ctx.currentTime && x.end > ctx.currentTime);
    const at = cur ? cur.end : ctx.currentTime + 0.05;
    this.lastSwitch = { mode: "phrase", from: cur?.at ?? null, now: ctx.currentTime, at };
    return at;
  },
  setDuck(v) {
    this.duck = v;
    const d = this.decks.b;
    if (d.gain && this.ctx) d.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  },
  /** Fade a deck out over `s` seconds and stop it there. */
  fadeOut(deckKey, s) {
    const ctx = this.ac();
    const d = this.decks[deckKey];
    if (!d.gain) return ctx.currentTime;
    const end = ctx.currentTime + s;
    d.gain.gain.cancelScheduledValues(ctx.currentTime);
    d.gain.gain.setValueAtTime(d.gain.gain.value, ctx.currentTime);
    d.gain.gain.linearRampToValueAtTime(0.0001, end);
    this.cut(deckKey, end);
    d.playing = false;
    return end;
  },
};
const benchPlays = [];            // what was actually BOOKED — the gate reads this
window.__bench = { engine: benchEngine, plays: benchPlays, takes: benchTakes };

function stopAllAudio() {
  sfxEngine.stop();
  const a = audioEl();
  if (a && !a.paused) a.pause();   // its onpause resets that row's ▶/⏸ button
}
function takeRow(domain, entityPath, take, extra = []) {
  const id = `${entityPath}/${take.id}`.replace(/\.(wav|ogg|m4a)$/, "");
  const row = h("div", { class: "take-row" });
  const sync = () => row.classList.toggle("rejected", fb(domain, id).status === "rejected");
  const btn = h("button", { class: "play-btn", "aria-label": "play", onclick: () => playTake(take.files, btn) }, "▶");
  // NB: skip null children explicitly — raw DOM append(null) renders a literal
  // "null" text node (players saw one on every non-chosen take, 2026-07-30).
  for (const c of [
    btn,
    h("span", { class: "take-name" }, take.id),
    take.chosen ? h("span", { class: "pill ok", title: "The take the game plays" }, "chosen") : null,
    ...extra,
    h("span", { class: "spacer" }),
    starsWidget(domain, id),
    verdictWidget(domain, id, { onchange: sync }),
  ]) if (c) row.append(c);
  sync();
  return row;
}

/* ----------------------------------------------------------------- views */
// ONE table for every section's player-facing NAME, icon and count. The
// route slugs stay as they are — they're URLs, and the feedback ids are
// repo paths — but nothing user-visible says "monsters" or "tiles" any more
// (maintainer 2026-07-30 named these). Add a section here and the nav, the
// start page, the headings and the back-links all follow.
const SECTIONS = {
  monsters:   { label: "Creatures",     noun: "creatures",  icon: "creatures",  count: (d) => d.counts.monsters },
  // "Races", not "Characters" (maintainer 2026-08-05: "Characters" reads too
  // close to "Creatures"). The nav counts RACES; the start tile keeps heroes.
  // "Races", not "Characters" (maintainer 2026-08-05: "Characters" reads too
  // close to "Creatures"). The count is the WHOLE cast — heroes and NPCs
  // together — because "2 heroes" undersold a section holding 193 people
  // (maintainer 2026-08-05). The word "characters" survives here, as the
  // count noun, which is exactly where it never collided with "creatures".
  characters: { label: "Races",         noun: "characters", icon: "characters",
                count: (d) => (d.counts.characters ?? 0) + (d.counts.npcs ?? 0) },
  // World counted its 8 TERRAIN TYPES in the nav while its card counted all
  // 4,372 tiles — one section quietly measuring itself two ways (maintainer
  // 2026-08-06: "use it in the menu as well"). One count per section now, and
  // `navCount` went with it: tiles was its only user.
  // TWO TILE SYSTEMS, SIDE BY SIDE, for as long as the migration takes
  // (maintainer 2026-08-16: "The tiles agent is working in what we call Tiles
  // 3.0 … Can you in the wiki have two tiles systems/pages? Tiles OLD and
  // World? World is the new Tiles 3.0 system (/tiles) … I will have to review
  // the new system to make it good").
  //
  // The NEW system takes the good name. `tiles` here is the tiles2 domain,
  // which has been the section called "World" since July and is now the one on
  // its way out; `world` is tiles/ (3.0). When tiles2 goes, this row goes with
  // it and nothing else has to move.
  //
  // A PLAYER SEES ONE GROUND SECTION, still called World, and it is the one
  // the game actually renders — tiles2, today. "Tiles OLD" is a migration
  // word: it means something to the Game Master and nothing to a reader, and
  // the encyclopedia must not degrade while the two systems overlap. So the
  // label is admin-dependent, and 3.0 is admin-only until it ships — an
  // unfinished ground system in the player's encyclopedia would be a promise
  // the game cannot keep. When tiles2 goes, this row goes with it, `world`
  // loses its adminOnly, and nothing else moves.
  tiles:      { label: () => (state.admin ? "Tiles OLD" : "World"),
                noun: "tiles",      icon: "world",      count: (d) => d.counts.tiles },
  // "Pairs" is how the factory counts this ground and how the Game Master
  // reviews it; a reader is looking at grounds. Same number either way — one
  // tile per pair is what a player is shown.
  world:      { label: "World",         noun: () => (state.admin ? "pairs" : "grounds"),
                icon: "world",      count: (d) => d.counts.world, adminOnly: true },
  objects:    { label: "Scenery",       noun: "props",      icon: "objects",    count: (d) => d.counts.objects },
  sounds:     { label: "Sound Effects", noun: "sounds",     icon: "sounds",     count: (d) => d.counts.sounds },
  music:      { label: "Music",         noun: "tracks",     icon: "music",      count: (d) => d.counts.music },
  items:      { label: "Items",         noun: "items",      icon: "items",      count: (d) => d.counts.items },
  // "tales", not "chapters": the section holds 9 chapters AND one people
  // article, and a tile reading "10 chapters" over a page whose Chapters
  // group says 9 reads as a bug.
  lore:       { label: "Lore",          noun: "tales",      icon: "lore",       count: (d) => d.counts.lore },
  // ADMIN-ONLY (maintainer 2026-07-30): parameters are designer machinery,
  // not encyclopedia — players must not even see the read-only page.
  tuning:     { label: "Parameters",    noun: "constants",  icon: "parameters", count: (d) => d.counts.constants, adminOnly: true },
};
// ONE list, read by both the nav (renderNav) and the Overview tiles
// (viewHome) — so the two can never disagree about the order.
// Races before Creatures: the people of Nangijala come before the things that
// hunt them (maintainer 2026-08-14, "feels like humans must be sorted before
// monsters").
// World (3.0) sits where the ground system has always sat; Tiles OLD follows
// it, because the thing being replaced should not be the one you reach first.
const SECTION_ORDER = ["characters", "monsters", "world", "tiles", "objects", "sounds", "music", "items", "lore", "tuning"];
// A section's label may depend on who is reading (see `tiles` above).
const label = (slug) => { const l = SECTIONS[slug]?.label; return (typeof l === "function" ? l() : l) ?? slug; };
/** What a section counts, in the voice of whoever is reading — the Game Master
 *  counts the units he works in, a player counts the things themselves. */
const noun = (slug) => { const n = SECTIONS[slug]?.noun; return (typeof n === "function" ? n() : n) ?? ""; };
/** The maintainer's 48x48 pixel art, drawn ONLY at whole multiples of 48 and
 *  never resampled — `image-rendering: pixelated` plus an exact CSS size, so
 *  a phone's 2x/3x device pixels land on clean pixel boundaries. */
function sectionIcon(slug, size = 48) {
  const icon = SECTIONS[slug]?.icon;
  if (!icon) return null;
  return h("img", { class: "sect-icon", src: `icons/${icon}.webp`, alt: "", width: String(size), height: String(size), loading: "lazy" });
}
/** Page heading with its icon beside it. */
// EVERY SECTION PAGE CARRIES A WAY BACK UP (maintainer 2026-08-14: "When you
// stand on Creatures, Races, Scenery, Music etc (a top headline). You have no
// back button to get to Overview the way you can go back from a Scenery
// entity to the Scenery overview"). An entity page has had its "← Scenery"
// crumb since the start; a section page was the one rung of the ladder with
// nothing above it, so the only way home was the ☰ menu.
//
// It lives HERE rather than in the twelve callers on purpose: sectionHead is
// what every section page already opens with, so one crumb covers Creatures,
// Races, World, Scenery, Sound Effects, Music, Items, Lore and Parameters —
// and any section added later gets it without anyone remembering to.
function sectionHead(slug) {
  return h("div", {},
    h("a", { class: "crumb", href: "#/" }, "← Overview"),
    h("div", { class: "sect-head" }, sectionIcon(slug), h("h1", {}, label(slug))));
}
function renderNav() {
  const cur = location.hash.replace(/^#\/?/, "").split("/")[0];
  const rows = [h("a", { href: "#/", class: cur === "" ? "active" : "" }, "Overview", h("span", { class: "count" }, ""))];
  for (const slug of SECTION_ORDER) {
    const s = SECTIONS[slug];
    if (s.adminOnly && !state.admin) continue;
    rows.push(h("a", { href: `#/${slug}`, class: cur === slug ? "active" : "" },
      label(slug), h("span", { class: "count" }, String(s.count(state.data) || ""))));
  }
  $("#nav").replaceChildren(...rows);
}

function entityBadge(domain, id) {
  const e = fb(domain, id);
  const out = [];
  if (e.rating) out.push(h("span", { class: "pill warn" }, `${"★".repeat(e.rating)}`));
  if (e.status === "approved") out.push(h("span", { class: "pill ok" }, "approved"));
  if (e.status === "rejected") out.push(h("span", { class: "pill err" }, "remove"));
  if (e.status === "redo") out.push(h("span", { class: "pill warn", title: "Kept — another variant of it is requested" }, "redo"));
  return out;
}

const matches = (q, ...hay) => !q || hay.some((s) => (s ?? "").toLowerCase().includes(q));

/* --- usage in the game world (built by ../build.mjs) ---
   Stats are always measured on the game's default world. That there are
   OTHER worlds is a development detail — the wiki never names one
   (maintainer 2026-07-30: the finished game has a single world). */
const worldInfo = () => state.data.world ?? null;
const tileUses = (rel) => worldInfo()?.tiles?.[rel] ?? 0;
const monsterSpawns = (id) => worldInfo()?.monsters?.[id] ?? null;
/** Where maps2 stands this NPC in the game's default world (npcs@1), keyed by
 *  the characters2 folder id — the same id this build uses. */
const npcPlacements = (id) => worldInfo()?.npcs?.[id] ?? null;
// "Referenced by the game" — bindings.json events / composer lookups for
// sounds, the director's chosen bed for music (see build.mjs).
function usePill(usedBy, whatUnused) {
  if (usedBy?.length) {
    return h("span", { class: "pill ok", title: `Referenced by: ${usedBy.join(", ")}` },
      usedBy.length === 1 && usedBy[0] === "background bed" ? "plays in game" : `in game · ${usedBy.length}×`);
  }
  return h("span", { class: "pill warn", title: whatUnused }, "unused");
}

// ← back crumb + prev/next through the domain's full list (wraps around).
// Layout rule (maintainer 2026-07-30): the "X / N" counter sits LEFT of the
// buttons so they stay in the same spot when the number gets wider.
/* -------------------------------------------------- prefetch (look-ahead) */
// "When I open a tree's page I want all states to load in the background, and
// also the tree on the next/prev page and all its states … to make the wiki
// faster and prepare for what I might look at next. Of course we should not
// reload something I have already loaded" (maintainer 2026-08-15).
//
// Reviewing is a rhythm: open a piece, click through its variants and
// directions, press ›, repeat. Every one of those clicks used to start a fetch
// at the moment of the click. This warms them while he is still looking at the
// current frame, in the order he is likely to want them, and never twice.
//
// Priority, one FIFO, staged so the useful things are in flight first:
//   1. every state × direction of THIS entity — its first asset (a strip is
//      the whole animation; a frame directory's first frame is what draws)
//   2. the same for the previous and next entity, so ‹ › is instant
//   3. the remaining frames of this entity's frame-directory clips
//   4. the remaining frames of the neighbours'
// TWO SETS, AND THE DIFFERENCE IS THE WHOLE BUG (maintainer 2026-08-15: "if I
// press next 20-30 times and stop on a tree … it feels like the preload stops
// working"). It did — completely. `warmed` used to be stamped at ENQUEUE time
// while a page change threw the pending queue away, so every URL that was
// queued-but-not-yet-fetched was marked "already fetched" and could never be
// asked for again. Paging fast poisoned exactly the corridor being paged
// through: measured on 25 fast presses, the piece landed on warmed 0 of its 14
// states and both neighbours 0 of theirs. So: `warmed` means STARTED (never
// twice), `warmQueued` is only a dedupe for what is waiting, and dropping the
// queue clears it — a URL abandoned unfetched is eligible again.
const warmed = new Set();           // a fetch was actually started for these
const warmQueued = new Set();       // waiting in warmQ right now
let warmQ = [], warmActive = 0, warmGen = 0;
const WARM_PARALLEL = 4;            // enough to fill a phone link, few enough to stay out of the way
// The DECODED images are kept too, not just their bytes. Two reasons: the
// origin serves `cache-control: no-cache`, so a second Image for the same URL
// would still make a revalidation round trip; and decoding a 920x184 strip
// again costs real milliseconds on a phone. Bounded by decoded SIZE — a
// monster's 40 strips are ~27 MB and scenery is far smaller, so this holds a
// creature and both its neighbours and then evicts oldest-first.
const warmImg = new Map();          // url -> a loaded HTMLImageElement
const WARM_BYTES = 64 * 1024 * 1024;
let warmBytes = 0;
function rememberWarm(url, im) {
  const size = (im.naturalWidth || 0) * (im.naturalHeight || 0) * 4;
  if (!size || warmImg.has(url)) return;
  warmImg.set(url, im);
  warmBytes += size;
  for (const [k, v] of warmImg) {
    if (warmBytes <= WARM_BYTES) break;
    warmImg.delete(k);
    warmBytes -= (v.naturalWidth || 0) * (v.naturalHeight || 0) * 4;
  }
}
/** A ready-to-draw image for this url — the warmed one when we have it. */
function warmHit(url) {
  const im = warmImg.get(url);
  return im && im.complete && im.naturalWidth ? im : null;
}
const warmIdle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1200 }) : setTimeout(fn, 300));
function warmPump() {
  while (warmActive < WARM_PARALLEL && warmQ.length) {
    const url = warmQ.shift();
    warmQueued.delete(url);
    warmed.add(url);                   // stamped HERE: the request is going out
    warmActive++;
    const im = new Image();
    // Low priority and async decode: the page the maintainer is LOOKING at
    // must never wait behind speculative work.
    im.decoding = "async";
    try { im.fetchPriority = "low"; } catch { /* older engines */ }
    const done = () => { warmActive--; warmPump(); };
    im.onload = () => { rememberWarm(url, im); done(); };
    im.onerror = done;                 // a 404 is warmed too — it must not retry
    im.src = url;
  }
}
function warmUrl(url) {
  if (!url || warmed.has(url) || warmQueued.has(url)) return;  // never twice
  warmQueued.add(url);
  warmQ.push(url);
  warmPump();
}
/** Every file behind one clip. `firstOnly` takes just the asset that draws. */
function clipUrls(clip, firstOnly) {
  if (!clip) return [];
  if (clip.strip) return [assetUrl(clip.strip)];      // a strip IS the whole animation
  if (!clip.framesDir) return [];
  const n = firstOnly ? 1 : Math.max(1, clip.frames ?? 1);
  return Array.from({ length: n }, (_, i) =>
    assetUrl(`${clip.framesDir}/${String(i).padStart(clip.framePad ?? 1, "0")}.${clip.frameExt ?? "png"}`));
}
const entityUrls = (e, firstOnly) => Object.values(e?.animations ?? {})
  .flatMap((a) => Object.values(a.dirs ?? {}).flatMap((c) => clipUrls(c, firstOnly)));
/** Warm this entity and its two neighbours in the list ‹ › walks. */
function prefetchAround(entity, list, id) {
  // Honour the reader's own connection settings — a data-saver phone gets the
  // page it asked for and nothing else.
  try { if (navigator.connection?.saveData) return; } catch { /* no NetworkInformation */ }
  // A new page abandons the old page's queue — and un-marks what it abandoned,
  // so paging through a piece never costs it its look-ahead later.
  const gen = ++warmGen;
  warmQ = [];
  warmQueued.clear();
  const i = Array.isArray(list) ? list.findIndex((x) => x.id === id) : -1;
  const near = i >= 0 && list.length > 1
    ? [list[(i - 1 + list.length) % list.length], list[(i + 1) % list.length]].filter((x) => x && x.id !== id)
    : [];
  const stage = (urls) => warmIdle(() => { if (gen === warmGen) urls.forEach(warmUrl); });
  stage(entityUrls(entity, true));
  stage(near.flatMap((n) => entityUrls(n, true)));
  stage(entityUrls(entity, false));
  stage(near.flatMap((n) => entityUrls(n, false)));
}

function crumbRow(backHref, backLabel, base, list, id) {
  const i = list.findIndex((x) => x.id === id);
  const prev = list[(i - 1 + list.length) % list.length];
  const next = list[(i + 1) % list.length];
  const nav = i >= 0 && list.length > 1
    ? h("span", { class: "detail-nav" },
        h("span", { class: "detail-count" }, `${i + 1} / ${list.length}`),
        h("a", { class: "nav-btn", href: `#/${base}/${prev.id}`, title: `Previous: ${prev.name}`, "aria-label": `Previous: ${prev.name}`,
          onclick: () => { keepScrollY = window.scrollY; } }, "‹"),
        h("a", { class: "nav-btn", href: `#/${base}/${next.id}`, title: `Next: ${next.name}`, "aria-label": `Next: ${next.name}`,
          onclick: () => { keepScrollY = window.scrollY; } }, "›"))
    : null;
  return h("div", { class: "crumb-row" }, h("a", { class: "crumb", href: backHref }, backLabel), nav);
}

/* ======================= THE MUSIC BENCH — the page ======================
 * Maintainer 2026-08-22, in full: a bench for the suite/pool/phrase score,
 * where a suite is one compatibility group (same key, same tempo, same phrase
 * length, so anything in it can switch on the beat or layer), and crossing
 * BETWEEN suites is silence rather than a musical transition.
 *
 * THE ORDER IS THE INSTRUMENT. What plays is a list of phrases, and a phrase
 * can come from any take of the track — "phrase 3 from v2 and phrase 5 from
 * v4, since that's how I'd actually pick the best ones". So the order is its
 * own row at the top, and every take's phrases sit under it waiting to be
 * added. Reordering is TAP-TO-PICK, TAP-TO-PLACE as well as drag: this is a
 * phone-first page and HTML5 drag does not exist on touch.
 *
 * THE SEAM BUTTONS LIVE IN THE JOINS of that order — "for any two phrases,
 * play the last 2 s of one straight into the first 2 s of the next, looped, so
 * I can judge a join in five seconds". A join in the order IS the pair.
 */
const BENCH_MODES = {
  beat:    { label: "next beat",  title: "Switch on the next beat (60/bpm). The combat cut-in — seamless inside a suite, because everything in one shares the tempo" },
  phrase:  { label: "next phrase", title: "Switch at the end of the phrase now sounding. Calm transitions" },
  instant: { label: "instant",    title: "Switch right now. Here to prove why the other two exist" },
  cross:   { label: "suite cross", title: "Fade out, hold silence, then the other suite. Crossing suites is meant to be silence, not a transition" },
};
const benchUI = {
  suite: null,
  deck: { a: { trackId: null, order: [] }, b: { trackId: null, order: [] } },
  mode: "phrase", crossS: 15, duckPct: -75,
  pick: null,              // the order chip picked up, waiting to be placed
  seam: null,              // {i} — which join is previewing
  judge: {},               // takeId -> which phrase's verdict row is open
};
const benchData = () => state.data.bench ?? null;
const benchTracksIn = (suite) => (benchData()?.tracks ?? []).filter((t) => t.suite === suite);
const benchTrack = (id) => (benchData()?.tracks ?? []).find((t) => t.id === id) ?? null;
/** The natural order of a take: every phrase of it, front to back. */
const benchNatural = (take) => Array.from({ length: take?.phrases ?? 0 }, (_, i) => ({ takeId: take.id, idx: i }));
const benchLabel = (item) => {
  const t = benchTake(item.takeId);
  const v = t?.version != null ? `v${String(t.version).padStart(2, "0")}` : "live";
  return `${v}#${item.idx + 1}`;
};
/** The measured key of one phrase, and whether it is the one that was asked
 *  for — an out-of-key phrase is marked red so a reject is informed. */
function benchPhraseKey(takeId, idx) {
  const t = benchTake(takeId);
  const p = t?.perPhrase?.[idx];
  if (!p) return { sv: null, off: false };
  return { sv: p.sv, off: !!t.wantSv && p.sv !== t.wantSv };
}
/** Re-stamp one phrase chip's verdict mark. The verdict row repaints ITSELF
 *  rather than the page — the music must not be interrupted to record an
 *  opinion — so the chip that shows "already judged" has to be told directly.
 *  Keyed by the feedback id, which is on the chip. */
function benchMarkChip(id) {
  const chip = document.querySelector(`.bench-chip[data-fb="${CSS.escape(id)}"]`);
  if (!chip) return;
  const v = fb("composer-music", id);
  chip.classList.remove("judged-ok", "judged-no", "judged");
  if (v.status === "approved") chip.classList.add("judged-ok");
  else if (v.status === "rejected") chip.classList.add("judged-no");
  else if (v.rating) chip.classList.add("judged");
}
const benchFbId = (kind, trackId, takeId, idx) =>
  kind === "track" ? `composer/music/${trackId}`
    : kind === "take" ? `composer/music/${takeId}`
      : `composer/music/${takeId}#${idx + 1}`;

function viewBench(opts = {}) {
  const B = benchData();
  if (!B?.tracks?.length) return h("p", {}, "The composer has not published a phrase score yet.");
  const showHeading = opts.heading !== false;
  /* THE MAIN SUITE LEADS AND OPENS SELECTED (maintainer 2026-08-22: "The
   * nangijala suites should be first and preselected"). Ordered by how many
   * beds each holds — nangijala 24, hole 6 — so the suite the game mostly
   * plays is the one the bench opens on, and a third suite lands in the right
   * place on its own without a name being hard-coded here. */
  const suites = Object.values(B.suites ?? {})
    .sort((a, b2) => benchTracksIn(b2.id).length - benchTracksIn(a.id).length || a.id.localeCompare(b2.id));
  benchUI.suite ??= (suites[0]?.id ?? B.tracks[0].suite);
  // READ THE SUITE EVERY PAINT, never once. Captured as consts, these went
  // stale the moment a suite chip was pressed: the picker kept offering the
  // old suite's beds and the selection silently cleared.
  const curSuite = () => B.suites?.[benchUI.suite] ?? null;
  const curTracks = () => benchTracksIn(benchUI.suite);
  benchUI.deck.a.trackId ??= curTracks()[0]?.id ?? null;
  // Every take of every track is addressable by id, for cross-take orders.
  benchTakes.clear();
  for (const t of B.tracks) for (const k of t.takes) benchTakes.set(k.id, { ...k, trackId: t.id });
  // A BENCH THAT OPENS EMPTY PLAYS NOTHING. Seed deck A with the live take's
  // own phrases, front to back, so ▶ works on arrival and every edit from
  // there is his.
  if (benchUI.deck.a.trackId && !benchUI.deck.a.order.length) {
    const t0 = benchTrack(benchUI.deck.a.trackId);
    const k0 = t0?.takes.find((k) => k.live) ?? t0?.takes[0];
    if (k0) benchUI.deck.a.order = benchNatural(k0);
  }

  const wrap = h("div", { class: "bench" });
  const paint = () => wrap.replaceChildren(...body());
  // The engine repaints the transport as phrases are booked, WITHOUT rebuilding
  // the page — a rebuild mid-audition would fight his thumb.
  const nowLine = h("div", { class: "bench-now muted" });
  // Why nothing is sounding, when nothing is sounding.
  const problemLine = h("div", { class: "bench-problem" });
  function benchProblem(order) {
    const bad = [...new Set(order.map((x) => x.takeId))].filter((id) => !benchEngine.ready?.has(id));
    problemLine.replaceChildren(...(bad.length
      ? [h("span", { class: "pill err" }, "no audio"),
        h("span", {}, ` ${bad.map((id) => benchEngine.errors.get(id) ?? "not loaded").join(" · ")}`)]
      : []));
  }
  benchEngine.onChange = () => {
    const d = benchEngine.decks.a, e = benchEngine.decks.b;
    const cur = (dk) => {
      const ctx = benchEngine.ctx;
      const s2 = ctx && dk.live.find((x) => x.at <= ctx.currentTime && x.end > ctx.currentTime);
      return s2 ? benchLabel(s2.item) : null;
    };
    const a = cur(d), b2 = cur(e);
    nowLine.textContent = a || b2
      ? `▶ ${a ? `A ${a}` : ""}${a && b2 ? "   +   " : ""}${b2 ? `B ${b2}` : ""}`
      : "";
  };

  function deckPicker(key) {
    const dk = benchUI.deck[key];
    const list = key === "b" ? (benchData()?.tracks ?? []) : curTracks();   // B may cross suites
    return h("div", { class: "bench-deck" },
      h("div", { class: "bench-deck-head" },
        h("b", {}, key === "a" ? "Deck A" : "Deck B"),
        key === "b" && dk.trackId ? h("button", { class: "ghost-btn", onclick: () => { benchEngine.stop("b"); dk.trackId = null; dk.order = []; paint(); } }, "✕ clear") : null),
      (() => {
        // The options are CHILDREN, not properties. They were being handed to
        // Object.assign, which copied their fields onto the <select> and left
        // it with nothing to pick from — the page still worked because the
        // default track comes from state, so only the picker was dead.
        const sel = h("select", { class: "bench-select" },
          ...[key === "b" ? h("option", { value: "" }, "— none —") : null,
            ...list.map((t) => h("option", { value: t.id }, `${t.pool} · ${t.name}`))].filter(Boolean));
        sel.value = dk.trackId ?? "";
        sel.onchange = (e) => {
          dk.trackId = e.target.value || null;
          const t = benchTrack(dk.trackId);
          dk.order = t ? benchNatural(t.takes.find((k) => k.live) ?? t.takes[0]) : [];
          benchUI.pick = null;
          // Start the decode the moment a bed is chosen, so the switch that
          // follows is a clock decision and nothing else.
          if (dk.order.length) { benchEngine.ac(); benchEngine.warm(dk.order); }
          paint();
        };
        return sel;
      })());
  }

  function orderRow() {
    const dk = benchUI.deck.a;
    const chips = [];
    dk.order.forEach((item, i) => {
      const k = benchPhraseKey(item.takeId, item.idx);
      const chip = h("button", {
        class: `bench-chip${k.off ? " off-key" : ""}${benchUI.pick === i ? " picked" : ""}`,
        draggable: "true",
        title: k.sv ? `${benchLabel(item)} — measured ${k.sv}${k.off ? " (not the key asked for)" : ""}` : benchLabel(item),
        onclick: () => {
          // TAP TO PICK, TAP TO PLACE. Works with a thumb, which drag does not.
          if (benchUI.pick == null) benchUI.pick = i;
          else if (benchUI.pick === i) benchUI.pick = null;
          else {
            const [moved] = dk.order.splice(benchUI.pick, 1);
            dk.order.splice(benchUI.pick < i ? i - 1 : i, 0, moved);
            benchUI.pick = null;
          }
          paint();
        },
      }, benchLabel(item), k.sv ? h("span", { class: "bench-chip-key" }, k.sv) : null);
      chip.addEventListener("dragstart", (e) => { benchUI.pick = i; e.dataTransfer.effectAllowed = "move"; });
      chip.addEventListener("dragover", (e) => e.preventDefault());
      chip.addEventListener("drop", (e) => {
        e.preventDefault();
        if (benchUI.pick == null || benchUI.pick === i) return;
        const [moved] = dk.order.splice(benchUI.pick, 1);
        dk.order.splice(benchUI.pick < i ? i - 1 : i, 0, moved);
        benchUI.pick = null; paint();
      });
      chips.push(chip);
      chips.push(h("button", {
        class: "bench-x", title: "Remove this phrase from the order",
        onclick: () => { dk.order.splice(i, 1); benchUI.pick = null; paint(); },
      }, "×"));
      // THE SEAM LIVES IN THE JOIN.
      if (i < dk.order.length - 1) {
        chips.push(h("button", {
          class: `bench-seam${benchUI.seam === i ? " on" : ""}`,
          title: "Hear this join: the last 2 s of this phrase straight into the first 2 s of the next, looped",
          onclick: () => { benchUI.seam = benchUI.seam === i ? null : i; playSeam(dk.order[i], dk.order[i + 1]); paint(); },
        }, "⌣"));
      }
    });
    return h("div", { class: "bench-order" }, ...(chips.length ? chips : [h("span", { class: "muted" }, "no phrases — add some from a take below")]));
  }

  function playSeam(a, b2) {
    const SEAM = 2;
    const sa = benchEngine.slice(a), sb = benchEngine.slice(b2);
    if (!sa || !sb) return;
    const order = [
      { takeId: a.takeId, idx: a.idx, startS: Math.max(0, sa.start + sa.dur - SEAM), durS: SEAM },
      { takeId: b2.takeId, idx: b2.idx, startS: sb.start, durS: SEAM },
    ];
    benchEngine.stop("a");
    benchEngine.start("a", order);
  }

  function takePanel(t, k) {
    const live = k.live;
    const barsOff = k.bars != null && Math.abs(k.bars - Math.round(k.bars)) > 0.02;
    return h("div", { class: `panel bench-take${live ? " is-live" : ""}` },
      h("div", { class: "panel-title" },
        k.version != null ? `Take v${String(k.version).padStart(2, "0")}` : "Take (live file)",
        live ? h("span", { class: "pill ok", title: "The take the game streams today" }, "live") : null,
        k.usable === false ? h("span", { class: "pill warn", title: "The composer marked this take unusable" }, "unusable") : null),
      h("div", { class: "card-sub metric-row" },
        h("span", { class: barsOff ? "pill err" : "", title: barsOff
          ? "Not a whole number of bars: the cut does not land on a bar line, so every join drops or adds part of a beat"
          : "A whole number of bars — the cut lands on a bar line" }, `bars ${k.bars != null ? k.bars.toFixed(2) : "—"}`),
        h("span", { title: "the take's own measured tempo" }, `${k.bpm != null ? k.bpm.toFixed(2) : "—"} BPM`),
        h("span", { title: "phrase length derived from this take's own bars and tempo" }, `${k.phraseMs ? (k.phraseMs / 1000).toFixed(2) : "—"} s`),
        k.inKey != null && k.perPhrase.length
          ? h("span", { class: k.inKey < k.perPhrase.length ? "pill err" : "pill ok",
            title: `${k.inKey} of ${k.perPhrase.length} phrases are in ${k.wantSv ?? "the key asked for"}` },
          `${k.inKey}/${k.perPhrase.length} i ${k.wantSv ?? "rätt tonart"}`)
          : null),
      // Every phrase of this take: number, measured key, red when off, and its
      // own ⚖ — the THIRD verdict level. The chip's own tap ADDS to the order
      // (the thing he does most), so judging gets its own target rather than a
      // mode to remember, the same shape the order row's × and ⌣ already have.
      h("div", { class: "bench-phrases" }, ...Array.from({ length: k.phrases ?? 0 }, (_, i) => {
        const pk = benchPhraseKey(k.id, i);
        const v = fb("composer-music", benchFbId("phrase", t.id, k.id, i));
        const mark = v.status === "approved" ? " judged-ok" : v.status === "rejected" ? " judged-no" : v.rating ? " judged" : "";
        const fid = benchFbId("phrase", t.id, k.id, i);
        return h("span", { class: "bench-pair" },
          h("button", {
            "data-fb": fid,
            class: `bench-chip add${pk.off ? " off-key" : ""}${mark}`,
            title: `Add phrase ${i + 1} to the order${pk.sv ? ` — measured ${pk.sv}` : ""}${v.status ? ` · ${v.status}` : ""}`,
            onclick: () => { benchUI.deck.a.order.push({ takeId: k.id, idx: i }); paint(); },
          }, `${i + 1}`, pk.sv ? h("span", { class: "bench-chip-key" }, pk.sv) : null),
          state.admin ? h("button", {
            class: `bench-judge${benchUI.judge[k.id] === i ? " on" : ""}`,
            title: `Judge phrase ${i + 1} on its own`,
            onclick: () => { benchUI.judge[k.id] = benchUI.judge[k.id] === i ? null : i; paint(); },
          }, "⚖") : null);
      })),
      state.admin && benchUI.judge[k.id] != null ? h("div", { class: "card-sub bench-judge-row" },
        h("span", { class: "muted" }, `phrase ${benchUI.judge[k.id] + 1}`),
        (() => {
          const pk = benchPhraseKey(k.id, benchUI.judge[k.id]);
          return pk.sv ? h("span", { class: pk.off ? "pill err" : "pill" }, pk.sv) : null;
        })(),
        benchFeedback(benchFbId("phrase", t.id, k.id, benchUI.judge[k.id]), benchMarkChip)) : null,
      state.admin ? h("div", { class: "card-sub" },
        h("span", { class: "muted" }, "take "),
        benchFeedback(benchFbId("take", t.id, k.id))) : null);
  }

  /** A verdict row that repaints ITSELF and never re-routes — the music has to
   *  keep playing while he judges (maintainer: "I need to judge in context"). */
  function benchFeedback(id, after) {
    const box = h("span", { class: "bench-fb" });
    const draw = () => box.replaceChildren(feedbackRow("composer-music", id, {
      onchange: () => { draw(); after?.(id); }, onStars: () => { draw(); after?.(id); },
      rejectTitle: "Tell the composer this one is not good enough",
      rejectedLabel: "slated for removal",
    }));
    draw();
    return box;
  }

  function transport() {
    const dk = benchUI.deck.a;
    const t = benchTrack(dk.trackId);
    const bpm = t?.bpm ?? curSuite()?.bpm ?? 120;
    // A PRESS ALWAYS SHOWS SOMETHING. These beds are ~2 MB and come from the
    // staging CDN, so the first press has a real wait — and when a fetch fails
    // the button used to just sit there (maintainer 2026-08-22: "I try to press
    // on A but nothing happens"). Now it says "loading…" while it decodes and
    // the reason underneath if it cannot.
    const bigBtn = (label2, title, fn, cls = "") => {
      const btn = h("button", { class: `bench-btn ${cls}`, title }, label2);
      btn.onclick = async () => {
        if (btn.disabled) return;
        const was = btn.textContent;
        btn.disabled = true; btn.textContent = "loading…";
        try { await fn(); } finally { btn.disabled = false; btn.textContent = was; }
      };
      return btn;
    };
    return h("div", { class: "bench-transport" },
      h("div", { class: "bench-row" },
        bigBtn("▶ A", "Play deck A's order, looping", async () => {
          await benchEngine.start("a", dk.order);
          benchProblem(dk.order);
          paint();
        }, "go"),
        bigBtn("▶ B", "Play deck B under A, ducked", async () => {
          const d2 = benchUI.deck.b;
          const t2 = benchTrack(d2.trackId);
          if (!t2) return;
          if (!d2.order.length) d2.order = benchNatural(t2.takes.find((k) => k.live) ?? t2.takes[0]);
          await benchEngine.start("b", d2.order);
          benchProblem(d2.order);
          paint();
        }, "go"),
        bigBtn("■ stop", "Stop both decks", () => { benchEngine.stopAll(); paint(); })),
      h("div", { class: "bench-row" },
        h("span", { class: "muted" }, "switch"),
        sortBar("wiki-bench-mode", Object.entries(BENCH_MODES).map(([id, m]) => [id, m.label, m.title]),
          benchUI.mode, (v) => { benchUI.mode = v; paint(); }, { persist: false })),
      // The switch itself: deck B's track becomes deck A's, in the chosen mode.
      h("div", { class: "bench-row" },
        bigBtn("⇄ switch to B", "Take deck B's bed onto deck A in the chosen mode", async () => {
          const d2 = benchUI.deck.b;
          const t2 = benchTrack(d2.trackId);
          if (!t2) { toast("Pick a bed on deck B first."); return; }
          const order = d2.order.length ? d2.order.slice() : benchNatural(t2.takes.find((k) => k.live) ?? t2.takes[0]);
          const mode = benchUI.mode;
          // WARM BEFORE READING THE CLOCK — see benchEngine.warm.
          benchEngine.ac();
          if (!benchEngine.isWarm(order)) { toast("Decoding that bed…"); await benchEngine.warm(order); }
          if (mode === "cross") {
            // A SUITE CROSS IS SILENCE, not a transition (the brief's own rule).
            const end = benchEngine.fadeOut("a", 0.6);
            const at = end + benchUI.crossS;
            benchEngine.stop("b");
            await benchEngine.start("a", order, at);
          } else {
            const at = mode === "beat" ? benchEngine.nextBeatAt("a", bpm)
              : mode === "phrase" ? benchEngine.nextPhraseAt("a")
                : benchEngine.ac().currentTime + 0.02;
            if (mode === "instant") benchEngine.lastSwitch = { mode: "instant", now: benchEngine.ac().currentTime, at };
            benchEngine.cut("a", at);
            benchEngine.stop("b");
            const mark = benchPlays.length;
            await benchEngine.start("a", order, at);
            const first = benchPlays[mark];
            const dA = benchEngine.decks.a;
            benchEngine.lastSwitch = { ...(benchEngine.lastSwitch ?? {}), booked: first?.at ?? null, bookedTake: first?.take ?? null,
              dbg: { playing: dA.playing, orderN: dA.order.length, nextAt: dA.nextAt, cursor: dA.cursor,
                inFlight: dA.live.length, ready: [...(benchEngine.ready?.keys() ?? [])].length,
                haveAll: order.every((x) => benchEngine.ready?.has(x.takeId)) } };
          }
          benchUI.deck.a.trackId = d2.trackId;
          benchUI.deck.a.order = order;
          paint();
        }, "go"),
        benchUI.mode === "cross" ? h("label", { class: "bench-slider" }, `silence ${benchUI.crossS}s`,
          Object.assign(h("input", { type: "range", min: "0", max: "30", step: "1", value: String(benchUI.crossS) }),
            { oninput: (e) => { benchUI.crossS = +e.target.value; paint(); } })) : null),
      // A LABEL HAS TO SAY WHAT THE CONTROL DOES (maintainer 2026-08-22: "I
      // have no idea what the slider does"). It was "duck B −50%" — a word
      // from a mixing desk, sitting on screen even with deck B empty.
      (() => {
        const hasB = !!benchTrack(benchUI.deck.b.trackId);
        return h("div", { class: `bench-row bench-duck${hasB ? "" : " idle"}` },
          h("label", { class: "bench-slider" },
            h("span", {}, `B plays ${Math.abs(benchUI.duckPct)}% quieter under A`),
            Object.assign(h("input", {
              type: "range", min: "-100", max: "0", step: "5", value: String(benchUI.duckPct),
              "aria-label": "how much quieter deck B sits under deck A",
            }), { oninput: (e) => { benchUI.duckPct = +e.target.value; benchEngine.setDuck(10 ** (benchUI.duckPct * 0.06 / 2)); paint(); } })),
          h("span", { class: "muted bench-hint" }, hasB
            ? "two beds at once — this is how far the second one sits under the first"
            : "pick a bed on deck B to hear two at once"));
      })(),
      nowLine, problemLine);
  }

  function body() {
    const dk = benchUI.deck.a;
    const t = benchTrack(dk.trackId);
    return [
      showHeading ? h("div", { class: "sect-head" }, h("h1", {}, "Dynamic Music")) : null,
      h("p", { class: "muted" },
        "One suite is one compatibility group — same key, same tempo, same phrase length — so anything inside it can switch on the beat or sit on top of anything else. Crossing between suites is silence, not a transition."),
      // The suite contract, in the composer's own numbers.
      h("div", { class: "bench-row" },
        sortBar("wiki-bench-suite", suites.map((s2) => [s2.id, s2.id, `${s2.keySv ?? ""} · ${s2.bpm ?? "?"} BPM · ${s2.bars ?? "?"} takter`]),
          benchUI.suite, (v) => {
            benchUI.suite = v;
            const first = benchTracksIn(v)[0];
            benchUI.deck.a.trackId = first?.id ?? null;
            benchUI.deck.a.order = first ? benchNatural(first.takes.find((k) => k.live) ?? first.takes[0]) : [];
            paint();
          }, { persist: false })),
      curSuite() ? h("p", { class: "muted" },
        `${curSuite().keySv ?? "?"} · ${curSuite().bpm ?? "?"} BPM · ${curSuite().bars ?? "?"} takter per fras · ${((curSuite().phraseMs ?? 0) / 1000).toFixed(2)} s`) : null,
      h("div", { class: "bench-decks" }, deckPicker("a"), deckPicker("b")),
      transport(),
      h("div", { class: "panel" },
        h("div", { class: "panel-title" }, "The order",
          h("span", { class: "pill" }, `${dk.order.length} phrase${dk.order.length === 1 ? "" : "s"}`),
          h("button", { class: "ghost-btn", title: "Random order — every phrase plays once before any repeats", onclick: () => {
            const o = dk.order.slice();
            for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
            dk.order = o; benchUI.pick = null; paint();
          } }, "🎲 shuffle"),
          h("button", { class: "ghost-btn", title: "Copy this order as text you can paste back to the composer agent", onclick: () => {
            const txt = `${dk.trackId} | ${dk.order.map(benchLabel).join(" ")}`;
            navigator.clipboard?.writeText(txt);
            toast(`Copied: ${txt.slice(0, 60)}${txt.length > 60 ? "…" : ""}`);
          } }, "⧉ copy order"),
          h("button", { class: "ghost-btn", title: "Back to this take's own order", onclick: () => {
            const k = t?.takes.find((x) => x.live) ?? t?.takes[0];
            dk.order = k ? benchNatural(k) : []; benchUI.pick = null; paint();
          } }, "↺ reset")),
        h("p", { class: "muted" }, benchUI.pick != null
          ? "Tap another phrase to drop the picked one in front of it."
          : "Tap a phrase to pick it up, then tap where it should go. ⌣ between two phrases plays that join, looped."),
        orderRow()),
      t ? h("div", {},
        h("div", { class: "sect-head" }, h("h2", {}, t.name),
          h("span", { class: "pill" }, t.pool ?? ""),
          t.key ? h("span", { class: "pill" }, t.key) : null),
        t.keyAsked ? h("p", { class: "muted" }, t.keyAsked) : null,
        state.admin ? h("div", { class: "card-sub" }, h("span", { class: "muted" }, "track "), benchFeedback(benchFbId("track", t.id))) : null,
        ...t.takes.map((k) => takePanel(t, k))) : null,
    ].filter(Boolean);
  }
  paint();
  return wrap;
}

function viewHome() {
  // Icon-led section tiles: the maintainer's pixel art carries each section,
  // the name is the headline and the count is the small print (2026-07-30 —
  // "the wiki start page looks so boring without icons").
  const tiles = SECTION_ORDER
    .filter((slug) => !SECTIONS[slug].adminOnly || state.admin)
    .map((slug) => [slug, SECTIONS[slug].count(state.data), noun(slug)]);
  /* THE START PAGE IS THE SECTIONS AND NOTHING ELSE (maintainer 2026-08-24:
   * "Everything under and including 'How feedback works' is not something not
   * even the admin wants to know/see").
   *
   * It carried a paragraph explaining what stars and ✕ and ✓ do, and a
   * "Resolved removals" panel listing rejected ids the agents had since
   * deleted. Both were written for someone learning the wiki; he built it and
   * uses it daily, and a manual on the front door is in the way of the door.
   * The controls carry their own tooltips where they are actually used. */
  return h("div", {},
    h("h1", {}, "Nangijala Wiki"),
    h("p", { class: "muted" }, state.admin
      ? "Everything the art and audio agents have made for the game — browse it, rate it, approve or remove it, and tune gameplay. Saves commit to live/ on main and stream straight into the running game."
      : "Every creature, hero, sound and song of Nangijala — the living encyclopedia of the world, always as fresh as the game you just played."),
    h("div", { class: "stat-tiles" }, ...tiles.map(([slug, n, noun]) =>
      h("a", { class: "stat-tile", href: `#/${slug}` },
        sectionIcon(slug, 96),
        h("div", { class: "n" }, label(slug)),
        h("div", { class: "l" }, `${n} ${noun}`)))),
  );
}

/* --- monsters --- */
/** Does this creature come for you unprompted? The game's rule exactly: a
 *  monster proximity-aggros only when its aggro radius is greater than zero,
 *  and the tuning default is 0 — PASSIVE by default, so most of the roster
 *  only ever retaliates. Read from the LIVE tuning doc through monsterStats,
 *  so editing a radius in the wiki re-colours the pill with no rebuild. */
const isAggressive = (st) => Number(st.aggro_radius_wu ?? 0) > 0;
function aggroPill(st) {
  const on = isAggressive(st);
  return h("span", { class: `pill ${on ? "err" : "ok"}`, title: on
      ? `Attacks on sight — it hunts anything that comes within ${st.aggro_radius_wu} world units of it.`
      : "Calm — it will not start a fight. Hit it and it fights back like any creature." },
    on ? "aggressive" : "calm");
}
/** A row of mutually exclusive sort buttons. Its own fixed-height row, so the
 *  grid below it never shifts as the order changes. */
/** `persist: false` for a strip whose choice belongs to the DATA rather than
 *  to this browser — the per-tile wall mode is one control per tile, and
 *  remembering hundreds of them in localStorage would be storing the document
 *  twice, in a place that can go stale against it. */
function sortBar(key, options, current, onPick, { persist = true } = {}) {
  // The row carries its storage key: three of these stack on the Scenery page
  // (type, sort, review status) and several share chip ids like "all", so
  // anything selecting a chip — including the gates — needs to say which row
  // it means.
  const row = h("div", { class: "sortbar", "data-bar": key, role: "radiogroup" });
  // A fourth tuple element DISABLES a chip. Used where an option exists in the
  // vocabulary but cannot apply here — a Raw chip on a pair the generator never
  // produced (maintainer 2026-08-27: "If no raw is available for a type. Just
  // make the state/button disabled instead"). Disabled beats absent: the row
  // keeps its shape between pairs, and the tooltip says why it is out.
  row.append(...options.map(([id, label, title, off]) => h("button", {
    class: `sortbar-btn${id === current ? " sel" : ""}${off ? " off" : ""}`, type: "button", title, "data-sort": id,
    role: "radio", "aria-checked": id === current ? "true" : "false",
    ...(off ? { disabled: "disabled" } : {}),
    onclick: off ? null : () => { if (persist) { try { localStorage.setItem(key, id); } catch { /* private mode */ } } onPick(id); },
  }, label)));
  // The strip pans instead of wrapping, so the chosen chip can start off
  // screen — 8 types do not fit a phone. Bring it into view once laid out.
  //
  // ATTACHED FIRST, MEASURED SECOND. The row is built here and appended by the
  // caller afterwards, so on the next frame it can still be detached — where
  // every rect is 0 and `scrollWidth <= clientWidth` is trivially true, which
  // returned early and left the strip wherever it happened to sit. That is
  // what put a half-cut "all 35" at the left edge of the tile filter on his
  // phone (2026-08-20). Retry across a few frames until it is really in the
  // document and has a width.
  let tries = 0;
  const bringIntoView = () => {
    if ((!row.isConnected || !row.clientWidth) && tries++ < 8) { requestAnimationFrame(bringIntoView); return; }
    const on = row.querySelector(".sel");
    if (!on || row.scrollWidth <= row.clientWidth) return;
    // Measured with rects, not offsetLeft: the strip is not a positioned
    // ancestor, so offsetLeft is relative to whatever is, and the arithmetic
    // would be off by that element's own left edge.
    const pad = 12;
    const rr = row.getBoundingClientRect(), br = on.getBoundingClientRect();
    if (br.left < rr.left + pad) row.scrollLeft -= (rr.left + pad) - br.left;
    else if (br.right > rr.right - pad) row.scrollLeft += br.right - (rr.right - pad);
  };
  requestAnimationFrame(bringIntoView);
  return row;
}
const MONSTER_SORT_KEY = "wiki-monster-sort";
/* WHICH ONES HAVE I ALREADY DONE? (maintainer 2026-08-22: "If I login with
 * admin the monster page should make it possible to filter by 'no shadow set'.
 * This is to be able to know what I have already fixed.")
 *
 * A shadow is SET when the monster carries its own {rx, ry} in
 * live/tuning/monsters.json — `shadowRaw` — rather than falling back to the
 * art-derived default. Every one of the 11 that has a size also has per-facet
 * offsets, so "half done" is not a real state and there is no chip for it.
 *
 * Counts ride on the chips, like the tile inbox: "no shadow 46" is the size of
 * the job, and it reaching 0 is what finishing looks like. And the filter
 * follows him ONTO the creature page — ‹ › then walks only the ones still
 * missing a shadow, because a filter you cannot navigate is the dead end he
 * hit on tiles ("I use your code to filter on NOT reviewed. I then click on
 * that tile set, but can't navigate further"). */
const MONSTER_SHADOW_KEY = "wiki-monster-shadow";
const MONSTER_SHADOWS = {
  all: { label: "all", title: "Every creature", hit: () => true },
  none: {
    label: "no shadow",
    title: "Creatures still drawing the art-derived default — these are the ones left to do",
    hit: (m) => !shadowRaw(m),
  },
  set: {
    label: "shadow set",
    title: "Creatures whose shadow you have already tuned — size and per-facet offsets",
    hit: (m) => !!shadowRaw(m),
  },
};
const shadowFilter = () => {
  if (!state.admin) return "all";
  try { return MONSTER_SHADOWS[localStorage.getItem(MONSTER_SHADOW_KEY)] ? localStorage.getItem(MONSTER_SHADOW_KEY) : "all"; }
  catch { return "all"; }
};
/** The creatures the current filter keeps, in the page's own order — the list
 *  ‹ › walks on a creature page. */
function monsterNav() {
  const mode = shadowFilter();
  const all = state.data.domains.monsters;
  if (mode === "all") return all;
  const kept = all.filter((m) => MONSTER_SHADOWS[mode].hit(m));
  return kept.length ? kept : all;   // never strand him on an empty pager
}
/* ---- THE CREATURES OVERVIEW IS A SHOWCASE ----
 * Maintainer 2026-08-18, round 1: "some big monsters are displayed with 0.5x
 * zoom and some smaller monsters are displayed with 1x zoom … the monsters are
 * so small it's hard to even see them … it's more impactful to just scroll in
 * the overview." Round 2, on the fix: "the Dewling now looks very big compared
 * to Diretusk. I think just showing the monsters in their TRUE SCALE (I think
 * the game uses what we call 2x) and just make some cards take up more space
 * instead. What if a card can be 1x1 (small), 2x1 (wide), 1x2 (tall) or 2x2 …
 * On mobile two 1x1 can fit on one row. This makes it possible for small
 * creatures to be displayed more densely and a big monster will get the
 * 'wow'-effect because it needs a bigger card."
 *
 * So: EVERY creature is drawn at the game's own scale — `data.artScale`, the
 * 2× the viewer and the game share — cropped free of its frame padding by the
 * measured `clip.bb`. Nothing is fitted, shrunk or blown up, which is the whole
 * point: a mammoth really is four times a poring and the page finally says so.
 *
 * WHAT VARIES IS THE CARD, NOT THE ZOOM. A creature that does not fit one cell
 * takes two — across, down, or both — and `grid-auto-flow: dense` packs the
 * small ones in around them. Measured on his phone: 45 creatures fit a single
 * cell, 3 need a tall one and 9 the full 2×2, so a scroll is a dense field of
 * small things with a giant every screen or so.
 *
 * THE SPANS ARE MEASURED, NOT ASSUMED. The cell is whatever the grid actually
 * gave it — a 360px phone is narrower than a 393px one and a desktop fits six
 * — so `fitShowcase` reads the real geometry after layout and again on resize,
 * and any creature wider or taller than one cell claims a second. Deciding from
 * a hardcoded cell width would clip art on the narrow phones.
 *
 * AND IT MOVES. The whole roster's idle clips are 296 KB, so each card animates
 * the same idle/south its own page opens on — a CSS steps() sweep over one
 * strip, no per-frame requests, nothing in a JS frame loop. An
 * IntersectionObserver arms a card near the viewport and disarms it after, so
 * off-screen cards hold no image and no animation.
 */
// ONE GRID ROW, IN PX — art + its two-line text block. TUNED TO THE ROSTER'S
// OWN SHAPE, not picked round: measured at 2×, 45 creatures stand 48–150px tall
// and 12 stand 172–284px, with a clean gap between. A row that leaves the art
// ~160px puts that gap exactly on the threshold, so the second cell goes to the
// dozen creatures that genuinely need it. At 184 the line fell mid-cluster and
// a 130px creature got a 322px stage — a near-twin of the 126px one beside it,
// looking twice its size for no reason anybody could see.
const SHOWCASE_ROW = 216;
const SHOWCASE_GAP = 10;
// NARROW ENOUGH THAT TWO FIT ON THE SMALLEST PHONE — his explicit
// requirement ("On mobile two 1x1 can fit on one row"). A 360px device leaves
// 332px of content, so 168 gave it ONE column and the whole point was lost;
// 150 keeps two there and simply gives a desktop more of them.
const SHOWCASE_MINCELL = 150;        // narrowest a 1×1 cell may be
const showcaseScale = () => state.data.iso?.artScale ?? state.data.artScale ?? 2;
const showcaseClip = (m) => m.animations?.idle?.dirs?.south
  ?? Object.values(m.animations?.idle?.dirs ?? {})[0]
  ?? Object.values(Object.values(m.animations ?? {})[0]?.dirs ?? {})[0]
  ?? null;
let showcaseWatch = null;
/** One card's art: the creature at the game's scale, cropped to its measured
 *  box, animated while it is on screen. */
function showcaseArt(m) {
  const clip = showcaseClip(m);
  const stage = h("div", { class: "showcase checker" });
  // No measurement (a clip the build could not read): fall back to the plain
  // preview rather than inventing a crop.
  if (!clip?.bb || !clip.strip) {
    stage.append(h("img", { class: "showcase-plain", src: assetUrl(m.preview), alt: m.name, loading: "lazy" }));
    return stage;
  }
  const [x0, y0, x1, y1] = clip.bb;
  // NOT `h` — that is the DOM helper this whole file is written with, and
  // shadowing it here put every h(...) below in the temporal dead zone.
  const aw = Math.max(1, x1 - x0), ah = Math.max(1, y1 - y0);
  const z = showcaseScale();
  const fw = clip.fw ?? m.frameW, fh = clip.fh ?? m.frameH, n = Math.max(1, clip.frames ?? 1);
  const art = h("div", { class: "showcase-art" });
  art.style.width = `${aw * z}px`;
  art.style.height = `${ah * z}px`;
  art.style.backgroundSize = `${fw * n * z}px ${fh * z}px`;
  // Frame 0, cropped: the strip is one image and this is a window onto it.
  art.style.setProperty("--f0", `${-x0 * z}px`);
  art.style.setProperty("--fn", `${-(x0 + n * fw) * z}px`);
  art.style.backgroundPositionX = `${-x0 * z}px`;
  art.style.backgroundPositionY = `${-y0 * z}px`;
  art.style.setProperty("--frames", String(n));
  art.style.setProperty("--dur", `${(n / 8).toFixed(2)}s`);   // the viewer's own baseFps
  art.dataset.strip = assetUrl(clip.strip);
  art.dataset.zoom = String(z);
  art.dataset.art = `${aw}x${ah}`;
  art.dataset.drawn = `${aw * z}x${ah * z}`;
  // The entity's own sprite, for the deleted-piece rule: a missing STRIP says
  // this creature's art is not here, and that rule is keyed on `preview`.
  art.dataset.preview = assetUrl(m.preview);
  stage.append(art);
  // LAZY BY OBSERVATION. 57 strips is 296 KB, but a phone should still not
  // fetch the bottom of the list to show the top of it — and an animation
  // nobody can see is work nobody asked for.
  showcaseWatch ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      const el = e.target;
      if (e.isIntersecting) armShowcase(el);
      else el.classList.remove("play");
    }
  }, { rootMargin: "300px 0px" });
  showcaseWatch.observe(art);
  return stage;
}
/* ---- A BACKGROUND IMAGE CANNOT REPORT A 404, so this one asks first ----
 *
 * Maintainer 2026-08-19: "when I restart the game and click on wiki … the
 * monsters not in the game will show an empty card. I then click on the first
 * empty card and back again and now all monsters display correctly."
 *
 * Every other image in this wiki is an <img>, and every one of them is covered
 * by the capture-phase `error` listener that asks the repo before believing a
 * piece is missing (see onArtMissing). The showcase draws its art as a CSS
 * `background-image` — it has to, the animation is one strip swept by steps()
 * — and a background that 404s fires NO event at all. So the whole recovery
 * path was silently bypassed and the card just stayed empty: no art, no note,
 * nothing to click.
 *
 * His "click one and come back" is that missing path happening by accident:
 * the creature's own page draws <img>s, one of them 404s, THAT handler asks the
 * repo, succeeds, and marks the domain repo-only — after which every card on
 * the way back resolves to the repo. The information was always one 404 away;
 * nothing on the overview was asking.
 *
 * So the paint goes through a detached Image() that CAN report failure, and a
 * miss follows the same three steps an <img> does: ask the repo, hold if the
 * repo base is still coming, and only then judge. Detached probes dispatch on
 * themselves and never reach the document, so this cannot re-enter the
 * capture-phase handler. */
const showcaseMisses = new Set();
function armShowcase(el) {
  el.classList.add("play");
  if (el.dataset.armed) return;
  el.dataset.armed = "1";
  paintShowcase(el);
}
function paintShowcase(el) {
  const url = el.dataset.strip;
  const probe = new Image();
  probe.onload = () => {
    if (!el.isConnected) return;
    el.style.backgroundImage = `url("${url}")`;
    el.closest(".showcase")?.classList.remove("art-failed", "art-gone");
  };
  probe.onerror = () => showcaseMissing(el, url);
  probe.src = url;
}
async function showcaseMissing(el, url) {
  const dom = new URL(url, location.href).pathname.replace(/^.*\/assets\//, "").split("/")[0];
  // 1. ASK THE REPO. The image holds what shipped; a domain still in
  //    development 404s there by arrangement, and one miss teaches every other
  //    card in the domain — which is what stops 33 creatures 404ing one by one.
  const twin = repoTwin(url);
  if (twin && twin !== url && !el.dataset.triedRepo) {
    el.dataset.triedRepo = "1";
    repoDomains.add(dom);
    el.dataset.strip = twin;
    repointShowcase(dom);
    paintShowcase(el);
    return;
  }
  // 2. THE BASE IS STILL COMING. Hold rather than judge — retryRepoMisses
  //    drains this the moment the repo base is up.
  if (!repoBaseKnown && state.admin && !el.dataset.triedRepo) { showcaseMisses.add(el); return; }
  // 3. NOW it can be judged, by the same rule as any other missing art: gone
  //    means the entity leaves the wiki, anything else stays visible and says
  //    it did not load.
  if (!el.isConnected) return;
  const verdict = await probeArt(url);
  if (verdict === "gone" && dropGoneEntity(el.dataset.preview || url)) return;
  if (!el.isConnected) return;
  const stage = el.closest(".showcase");
  if (!stage || stage.querySelector(".art-note")) return;
  el.remove();
  stage.classList.add(verdict === "gone" ? "art-gone" : "art-failed");
  stage.append(h("span", { class: "art-note" },
    verdict === "gone" ? "removed" : "not loading",
    h("small", {}, verdict === "gone" ? "the agent acted on this" : "the art did not load")));
}
/** One card's miss is the whole domain's answer: re-point every OTHER card of
 *  that domain that is still aimed at the image. Without this the grid heals
 *  one 404 at a time, which is 33 round trips and a visibly patchy page. */
function repointShowcase(dom) {
  for (const el of document.querySelectorAll(".showcase-art")) {
    const src = el.dataset.strip ?? "";
    if (!src.startsWith(String(ROOT))) continue;
    if (src.slice(String(ROOT).length).split("/")[0] !== dom) continue;
    const twin = repoTwin(src);
    if (!twin || twin === src) continue;
    el.dataset.strip = twin;
    if (el.dataset.preview) el.dataset.preview = repoTwin(el.dataset.preview) ?? el.dataset.preview;
    // Only ones already asked for: an unarmed card will read the new url when
    // it scrolls into view.
    if (el.dataset.armed) { el.style.backgroundImage = ""; el.dataset.triedRepo = "1"; paintShowcase(el); }
  }
}
/** Give every card the number of cells its creature actually needs — from the
 *  geometry the browser really laid out, never from arithmetic over the
 *  stylesheet. Runs after paint and on resize.
 *
 *  THE MEASUREMENT IS THE STAGE ITSELF. A first cut computed the art's room as
 *  row − text − padding and was 8px optimistic (it forgot the card's own gap
 *  and borders), so four creatures 130-134px tall were left in a 127px box with
 *  their ears and feet clipped off. Reading a real 1×1 card's stage cannot
 *  disagree with the CSS, whatever the CSS later becomes. */
function fitShowcase(grid) {
  if (!grid?.isConnected) return;
  const cards = [...grid.querySelectorAll(".showcase-card")];
  if (!cards.length) return;
  const gw = grid.getBoundingClientRect().width;
  if (!gw) return;
  const cols = Math.max(1, Math.floor((gw + SHOWCASE_GAP) / (SHOWCASE_MINCELL + SHOWCASE_GAP)));
  const cell = (gw - (cols - 1) * SHOWCASE_GAP) / cols;
  // A card that is CURRENTLY 1×1 measures the single-cell stage for everybody.
  // If none is (every creature big, a filtered list), one is borrowed for a
  // frame — cheaper than a full reset, which flashes the whole grid small.
  let probe = cards.find((c) => (c.dataset.span ?? "1x1") === "1x1");
  let restore = null;
  if (!probe) {
    probe = cards[0];
    restore = { c: probe.style.getPropertyValue("--c"), r: probe.style.getPropertyValue("--r") };
    probe.style.setProperty("--c", "1");
    probe.style.setProperty("--r", "1");
  }
  const el = probe.querySelector(".showcase");
  // THE CONTENT BOX, not the border box: the stage carries 3px of padding so a
  // creature never kisses its frame, and measuring inside it makes "does this
  // fit" an exact question with no fudge constant to drift out of step with
  // the stylesheet.
  const pad = el && getComputedStyle(el);
  const w1 = el ? el.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight) : 0;
  const h1 = el ? el.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom) : 0;
  if (restore) { probe.style.setProperty("--c", restore.c || "1"); probe.style.setProperty("--r", restore.r || "1"); }
  if (!(h1 > 0)) return;
  // What a span BUYS: one more column is a whole cell plus the gap; one more
  // row is a whole row plus the gap. Both measured off the single-cell stage.
  const w2 = w1 + cell + SHOWCASE_GAP, h2 = h1 + SHOWCASE_ROW + SHOWCASE_GAP;
  let over = 0;
  for (const card of cards) {
    const art = card.querySelector(".showcase-art");
    const [w, hgt] = (art?.dataset.drawn ?? "0x0").split("x").map(Number);
    // A creature that fits stays small; one that does not takes the second
    // cell. Two columns is the cap: a THIRD would only serve art nothing in the
    // roster is near, and it would leave holes dense packing cannot fill.
    const c = w > w1 && cols > 1 ? 2 : 1;
    const r = hgt > h1 ? 2 : 1;
    card.style.setProperty("--c", String(c));
    card.style.setProperty("--r", String(r));
    card.dataset.span = `${c}x${r}`;
    if (w > (c === 2 ? w2 : w1) || hgt > (r === 2 ? h2 : h1)) over++;
  }
  grid.dataset.cols = String(cols);
  // A creature too big even for 2×2 would be clipped, which is the one outcome
  // this layout must never produce silently. Nothing in the roster is close
  // (the tallest is 284px against a 321px double stage), so this is a tripwire
  // for the day the monsters agent ships something enormous.
  grid.dataset.over = String(over);
}
let showcaseFit = null;
function watchShowcase(grid) {
  const run = () => fitShowcase(grid);
  requestAnimationFrame(run);
  if (showcaseFit) window.removeEventListener("resize", showcaseFit);
  showcaseFit = () => { if (!grid.isConnected) { window.removeEventListener("resize", showcaseFit); showcaseFit = null; return; } run(); };
  window.addEventListener("resize", showcaseFit);
}

/** The grid itself — built here so the fit pass is armed the moment it exists,
 *  and never forgotten at a call site. */
function showcaseGrid(...cards) {
  const grid = h("div", { class: "showcase-grid" }, ...cards);
  grid.style.setProperty("--sc-row", `${SHOWCASE_ROW}px`);
  grid.style.setProperty("--sc-gap", `${SHOWCASE_GAP}px`);
  grid.style.setProperty("--sc-min", `${SHOWCASE_MINCELL}px`);
  watchShowcase(grid);
  return grid;
}

function viewMonsters() {
  const q = state.query;
  const list = state.data.domains.monsters.filter((m) => matches(q, m.id, m.name, m.kind, monsterLore(m), ...(m.loreStory ?? [])));
  // Default is BY NAME. The underlying order is the folder id, which reads as
  // random to anyone looking at display names (Emberwing, Nightmule, Ashfiend…).
  let sort = "name";
  try { sort = localStorage.getItem(MONSTER_SORT_KEY) || "name"; } catch { /* private mode */ }
  const stat = new Map(list.map((m) => [m.id, monsterStats(m.id)]));
  const byName = (a, b) => a.name.localeCompare(b.name);
  const lvl = (m) => Number(stat.get(m.id).level ?? 0);
  const CMP = {
    name: byName,
    level: (a, b) => lvl(b) - lvl(a) || byName(a, b),
    // Aggressive first, and hardest first within each half — "what can come
    // for me, worst first" is the question this sort answers.
    threat: (a, b) => (isAggressive(stat.get(b.id)) - isAggressive(stat.get(a.id))) || lvl(b) - lvl(a) || byName(a, b),
  };
  const mode = shadowFilter();
  const shown = list.filter((m) => MONSTER_SHADOWS[mode].hit(m));
  const sorted = [...shown].sort(CMP[sort] ?? byName);
  const nAggro = list.filter((m) => isAggressive(stat.get(m.id))).length;
  const nNone = list.filter((m) => !shadowRaw(m)).length;
  return h("div", {},
    sectionHead("monsters"),
    h("p", { class: "muted" }, state.admin
      ? `${list.length} creatures from the monsters agent — ${nAggro} attack on sight. Click one to preview every animation, check its shadow, edit its stats and loot.`
      : `${list.length} creatures roam Nangijala, ${nAggro} of them aggressive. Click one to watch every animation and study its stats.`),
    sortBar(MONSTER_SORT_KEY, [
      ["name", "by name", "Alphabetical"],
      ["level", "by level", "Hardest first"],
      ["threat", "aggressive first", "The ones that attack on sight, hardest first"],
    ], sort, () => route()),
    // HIS SHADOW QUEUE. Counts on the control itself, so "what is left" is
    // answered before a single card is read.
    state.admin ? sortBar(MONSTER_SHADOW_KEY,
      Object.entries(MONSTER_SHADOWS).map(([id, f]) => [id,
        `${f.label} ${id === "all" ? list.length : list.filter((m) => f.hit(m)).length}`, f.title]),
      mode, () => route()) : null,
    state.admin && mode !== "all" ? h("p", { class: "muted" },
      shown.length
        ? `${shown.length} of ${list.length} creature${list.length === 1 ? "" : "s"}. Open one and ‹ › walks only these.`
        : mode === "none"
          ? "Every creature has a tuned shadow. Nothing left to do."
          : "No creature has a tuned shadow yet.") : null,
    state.admin && mode === "all" && nNone ? h("p", { class: "muted" },
      `${nNone} of ${list.length} still draw the default shadow.`) : null,
    showcaseGrid(...sorted.map((m) => {
      // The card leads with what matters to a PLAYER — the creature's stats
      // (live/tuning/monsters.json), not image resolution (maintainer
      // 2026-07-30). "not in game yet" is dev info → admin only.
      const st = stat.get(m.id);
      const sp = monsterSpawns(m.id);
      // EVERYTHING THAT IS NOT THE PICTURE RIDES ON THE PICTURE, or takes one
      // line under it. A 1×1 card is 168px wide: a level row, a stats row and a
      // pill row would leave the creature a letterbox.
      //
      // ALL OF IT IN THE TOP CORNERS, stacked. Creatures stand centred and grow
      // upward from their feet, so the bottom of a full card is where the art
      // is — a pill parked bottom-left sat across Ashfiend's leg. The top
      // corners are the reliably empty ones.
      const stage = showcaseArt(m);
      stage.append(h("span", { class: "showcase-level", title: "How hard this creature is to fight" },
        "Lv ", h("b", {}, String(st.level ?? "?"))));
      // THE OTHER MARKS STACK IN THE OPPOSITE CORNER. A creature stands centred
      // on the bottom of its box and its head is top-CENTRE, so the two top
      // corners are the reliably empty ones — a pill parked bottom-left sat
      // across Ashfiend's leg, and both marks in one corner covered Emberjaw's
      // head.
      const marks = h("div", { class: "showcase-marks" },
        // ONLY THE AGGRESSIVE ONES ARE MARKED. "Will it attack me" is the
        // question this page answers at a glance, and a green "calm" chip on 48
        // of 57 cards answers it by shouting at everybody. Absence is the calm.
        ...(isAggressive(st) ? [h("span", { class: "pill err", title: "Attacks on sight" }, "aggressive")] : []),
        ...(sp ? [] : [h("span", { class: "pill showcase-nospawn", title: "No world places this creature yet — you will not meet it in the wild." }, "not spawned")]),
        // THE REVIEW BADGES RIDE UP HERE TOO — ★★★ / approved / remove — and
        // that is a layout rule, not a taste: they appear only once the Game
        // Master has judged a creature, so left in the text block they would
        // add a third line to SOME cards, shrinking those stages below the one
        // the span was measured from and clipping the art of exactly the
        // creatures he had just reviewed.
        ...entityBadge("monsters", m.path));
      if (marks.children.length) stage.append(marks);
      return h("a", { class: "card showcase-card", href: `#/monsters/${m.id}` },
        stage,
        // EXACTLY TWO LINES, ALWAYS. Every row of this grid is the same height,
        // so anything that appears on some cards and not others has to ride on
        // the art instead (see the marks above).
        h("div", { class: "showcase-text" },
          h("div", { class: "card-name" }, m.name),
          h("div", { class: "card-sub" },
            `HP ${st.max_hp ?? "?"} · DMG ${st.damage ?? "?"} · XP ${st.xp ?? "?"}${state.admin && !m.inGame ? " · not in game yet" : ""}`)));
    })));
}
const monsterLore = (m) => m.loreDesc ?? m.lore ?? `Travellers tell of the ${m.name} roaming the wilds of Nangijala. What it wants — and what it guards — no chronicler has written down yet.`;
// The admin tail is folded INTO the accessor, not added as a second <p>:
// loreSlot reserves the height of the tallest blurb by mapping ONE function
// over the domain, so the visible text and the ghost list must come from the
// same accessor or the reserve stops being the true maximum.
const objectBlurb = (o) => `${o.loreDesc ?? o.description ?? ""}${o.category ? ` · ${titleish(o.category)}` : ""}${state.admin && o.placement ? ` · world height ${o.placement.world_height_m}m (${o.placement.world_px_height}px)` : ""}`;
/** What a hero IS, in words a player understands — "Human · Female", never
 *  the pipeline folder id (maintainer 2026-07-30). */
const heroKind = (c) => [c.species, c.sex].filter(Boolean).join(" · ");
/** A game state as a READER sees it: "idle" → "Idle", "spell_wand" → "Spell
 *  wand". The keys are the game's own vocabulary, but they are still code —
 *  lowercase and underscored — and the viewer prints them on its buttons
 *  (maintainer 2026-08-01: "no technical names to the end user"). Anything
 *  genuinely technical is fixed where it is BUILT, not papered over here. */
// "LIGHTS_ON" is the scenery domain's key; "Lights On" is what a reader wants
// to see (maintainer 2026-08-14). Every word, not just the first.
// A SCENERY VARIANT IS A NUMBER AND A LAMP (maintainer 2026-08-14: "I don't
// like the text on the radio buttons ... my idea is to show 'not lit' as #1,
// #2, #3 and the lit version should show 💡#1, 💡#2 ... more clean and visual,
// and at the same time make the UI more compact"), and then "even more
// compact — can you remove the # character". So NOT_LIT_3 -> "3",
// LIT_2 -> "💡2", and a window's lone LIGHTS_OFF/LIGHTS_ON pair -> "1"/"💡1".
// Six chips of prose became six chips you read at a glance, and the row stops
// scrolling on a phone. Anything else — a monster's walk, a character's die —
// is still spelled out in words.
const VARIANT = /^(not[_-]?lit|lit|lights[_-]?off|lights[_-]?on)(?:[_-]?(\d+))?$/i;
/* IS THIS STATE LIT? (maintainer 2026-08-17: "some scenery is supposed to be
 * 'lit up' (like a lamp, campfire, glowing rune, etc). However! The AI that
 * generates the image might fail to produce the light, but the scenery overall
 * looks great. So I want a way to change the state from 'lit' to 'unlit' when
 * doing the review. So we don't have to throw away the art just because it's
 * lit state is wrong.")
 *
 * THE STATE'S NAME IS THE CLAIM; the picture is the truth. `LIT_2` says the
 * generator was asked for a glow, not that one came out — and a piece whose art
 * is good in every other way should not be thrown away over its label. So the
 * Game Master can correct it, and the correction is a PROPERTY of the state,
 * never a verdict on it: an ordinary LIT_2 that is really unlit is not bad art,
 * it is unlit art filed under the wrong name.
 *
 * The scenery domain's own contract is "read the state key, not the piece" —
 * `lights` on the piece is legacy and null wherever a piece carries both kinds
 * (scenery/README.md). So this reads the key, and the override corrects it.
 */
const SCENERY_LIGHT_KEY = "tuning/scenery_lights";
const sceneryLights = () => state.tuning.scenery_lights
  ?? (state.tuning.scenery_lights = { format: "pixel-wiki-scenery-lights@1", updated_at: "", overrides: {} });
/** What the state's NAME claims: true, false, or null for a state that says
 *  nothing about light at all (a piece's plain `static` / `base`). */
function litByName(st) {
  const m = VARIANT.exec(String(st ?? "").trim());
  if (!m) return null;
  return /^lit/i.test(m[1]) || /on$/i.test(m[1]);
}
const litKey = (path, st) => `${path}#${st}`;
/** What it REALLY is: his correction if he made one, else the name's claim,
 *  else unlit — a state nobody has called lit is the ordinary case. */
function litOf(path, st) {
  const o = sceneryLights().overrides?.[litKey(path, st)];
  if (o && typeof o.lit === "boolean") return o.lit;
  return litByName(st) ?? false;
}
const litCorrected = (path, st) => {
  const o = sceneryLights().overrides?.[litKey(path, st)];
  return !!o && typeof o.lit === "boolean" && o.lit !== (litByName(st) ?? false);
};
function setLit(path, st, lit) {
  const doc = sceneryLights();
  const key = litKey(path, st);
  // AGREEING WITH THE ART'S OWN NAME DELETES THE ENTRY. This file is a list of
  // CORRECTIONS; storing the ones that change nothing would grow it to every
  // state ever looked at and say nothing about any of them.
  if (lit === (litByName(st) ?? false)) delete (doc.overrides ??= {})[key];
  else (doc.overrides ??= {})[key] = { lit, was: st, updated_at: new Date().toISOString() };
  doc.updated_at = new Date().toISOString();
  touch(SCENERY_LIGHT_KEY, key);
  markDirty(SCENERY_LIGHT_KEY);
}
const LIT_MODES = {
  unlit: { label: "unlit", title: "No light in this art — whatever the state is called" },
  lit: { label: "💡 lit", title: "This art really does glow" },
};
/** The strip itself, which REDRAWS ITSELF: a pick-one that still shows the old
 *  pick after you press it is worse than no control at all. */
/* WALL OR GROUND — the placement kind, correctable in review (maintainer
 * 2026-08-28). Per PIECE, unlike the lit row's per-state: hanging on a wall
 * is a property of the object, not of an animation. Same size discipline as
 * litRow — the ordinary control size, not the tiles card's dense strip. */
const SCWALL_MODES = {
  ground: { label: "on the ground", title: "Stands in the world: it has a footprint, y-sorts against the player, and belongs in the hitbox queue" },
  wall: { label: "wall scenery", title: "Hangs on a house/mountain/cave wall: no hitbox, never sorted against the player" },
};
function wallRow(o, onChange) {
  const box = h("div", { class: "card-sub lit-mode" });
  const draw = () => {
    const wall = isWallScenery(o);
    const tag = taggedWall(o);
    const corrected = wall !== tag;
    box.replaceChildren(...[
      h("span", { class: "muted lit-label" }, "Placed"),
      sortBar(`scenery-wall:${o.path}`, Object.entries(SCWALL_MODES).map(([id, m]) => [id, m.label, m.title]),
        wall ? "wall" : "ground",
        (v) => { setWallScenery(o, v === "wall"); draw(); onChange?.(); }, { persist: false }),
      // The disagreement, once there is one — a correction is only readable
      // against what it corrects, and the scenery agent re-files from it.
      corrected ? h("span", { class: "pill warn", title: `The scenery agent tagged this ${o.type ?? "untyped"} — your correction overrides it until the agent re-files the piece` },
        `tagged ${tag ? "wall" : "ground"}`) : null,
    ].filter(Boolean));
  };
  draw();
  return box;
}
function litRow(path, st, onChange) {
  // NOT `.wall-mode`: that class exists to SHRINK a strip into a dense tiles
  // card (3px padding, 12px type), and reusing it made this the smallest thing
  // on a page full of normal controls (maintainer 2026-08-18: "why did you make
  // the unlit/lit switch so small to click on — smaller than the other
  // radio-group-buttons I use on the page"). It gets its own class and the
  // page's ordinary size.
  const box = h("div", { class: "card-sub lit-mode" });
  const draw = () => {
    const now = litOf(path, st);
    const claimed = litByName(st);
    box.replaceChildren(...[
      h("span", { class: "muted lit-label" }, "Light"),
      sortBar(`scenery-lit:${path}#${st}`, Object.entries(LIT_MODES).map(([id, m]) => [id, m.label, m.title]),
        now ? "lit" : "unlit",
        (v) => { setLit(path, st, v === "lit"); draw(); onChange?.(); }, { persist: false }),
      // WHAT IT WAS GENERATED AS, once the two disagree — a correction is only
      // legible beside the claim it corrects. Nothing at all when they agree:
      // this used to be a bare `null` in the argument list, and
      // replaceChildren STRINGIFIES a non-node, so the row read "Light unlit
      // 💡lit null" on every uncorrected state (his screenshot).
      claimed !== null && now !== claimed
        ? h("span", { class: "pill warn", title: `The scenery agent generated this state as ${stateWords(st)}` },
          `generated as ${claimed ? "💡 lit" : "unlit"}`)
        : null,
    ].filter(Boolean));
  };
  draw();
  return box;
}
function stateLabel(s) {
  const m = VARIANT.exec(String(s).trim());
  if (m) {
    const lit = /^lit/i.test(m[1]) || /on$/i.test(m[1]);
    return `${lit ? "💡" : ""}${m[2] ?? 1}`;
  }
  return String(s).replace(/[_-]+/g, " ").toLowerCase().replace(/\b./g, (c) => c.toUpperCase());
}
/** The same state written out, for a tooltip and for anywhere prose is right. */
const stateWords = (s) => String(s).replace(/[_-]+/g, " ").toLowerCase().replace(/\b./g, (c) => c.toUpperCase());
/** Authored in characters2/metadata.json; the placeholder only runs for a
 *  hero the characters agent has not written up yet. */
const heroLore = (c) => c.loreDesc ?? c.lore ?? (c.kind === "npc"
  ? "One of the folk of Nangijala. Who they are — a name, a home, a grudge — has not been written down yet."
  : "One of the heroes you can set out as. Their story has not been written down yet — the chroniclers of Nangijala are still at work.");
/** A lore paragraph that always occupies the height of the LONGEST lore in
 *  its domain, so paging next/next/next can't move the animation viewer
 *  below it (maintainer 2026-07-30: "the animation preview jumps up and
 *  down constantly"). Blurbs run 2-4 lines and the line count also depends
 *  on the column width, so a hardcoded min-height would be wrong on some
 *  phone; instead every blurb is stacked in ONE grid cell with only the real
 *  one visible — the row is then exactly as tall as the tallest, measured by
 *  the browser at whatever width it actually has. */
function loreSlot(text, all) {
  const ghosts = [...new Set(all)].filter((t) => t !== text)
    .map((t) => h("p", { class: "muted lore ghost", "aria-hidden": "true" }, t));
  return h("div", { class: "lore-slot" }, h("p", { class: "muted lore" }, text), ...ghosts);
}
/* ------------------------------------------------------------------- lore */
// Set by a "Read next" link, consumed by the next navigation. Null for every
// other kind of link, which simply starts at the top.
let pendingScroll = null;
// ‹ › KEEPS THE SCROLL (maintainer 2026-08-15). Reviewing a tall piece means
// scrolling down to see all of it; landing at the top of the next one and
// scrolling again, hundreds of times, is the actual cost. The pager stamps
// where the reader is standing and the next render puts them back there.
let keepScrollY = null;
const loreList = () => state.data.domains.lore ?? [];   // build.mjs sorted it; never re-sort
// One table for every category decision — the group heading AND the chip under
// the picture. An unknown category never throws and never prints a raw slug.
/** The race a "people" entry is about, taken from the cast's own species so
 *  the day Elves ship their entry chips itself. */
function raceOfEntry(e) {
  const races = [...new Set((state.data?.domains?.characters ?? []).map((c) => c.species || "Human"))];
  return races.find((r) => new RegExp(`\\b${r}s?\\b`, "i").test(e?.name ?? "")) ?? null;
}
const LORE_CATEGORY = {
  chapter: { plural: "Chapters", chip: (e) => (Number.isInteger(e.chapter) ? `Chapter ${e.chapter}` : "A chapter") },
  // "The Human Race", not "A people" (maintainer 2026-08-05) — the section is
  // called Races now and the chip should say so. The race is DERIVED from the
  // cast, not hardcoded: the species whose name appears in the entry's title
  // ("The Human Dead" → Human). An entry about a people we have no cast for
  // still reads as a race rather than falling back to the old word.
  people:  { plural: "Races",    chip: (e) => { const r = raceOfEntry(e); return r ? `The ${r} Race` : "A race"; } },
  place:   { plural: "Places",   chip: () => "A place" },
  faction: { plural: "Factions", chip: () => "A faction" },
};
const loreCat = (e) => LORE_CATEGORY[e?.category] ?? { plural: "Writings", chip: () => "A tale" };
const chipText = (e) => loreCat(e).chip(e);
/** An entry's 48×48 emblem, drawn at 48 or 96 and never resampled. Entry icons
 *  are REPO-relative (unlike sectionIcon, which is site-relative), so they go
 *  through assetUrl(). The size comes from the MARKUP so the box is reserved
 *  before the image loads — an unsized img that pops in shifts the list. */
function loreIcon(e, size = 48) {
  const src = e?.icon ?? state.data.loreMeta?.default_icon;
  if (!src) return h("span", { class: "item-icon item-noart", style: `width:${size}px;height:${size}px` });
  const img = h("img", { class: "lore-icon item-icon", src: assetUrl(src), alt: "", width: String(size), height: String(size), loading: "lazy" });
  // Hidden, never display:none — the reserved box must survive a 404 or the row collapses.
  img.addEventListener("error", () => { img.style.visibility = "hidden"; });
  return img;
}

/* --- the paged long text: ONE component for the story card and the red line.
   Only the CURRENT page is in the DOM. Deliberately NOT loreSlot's ghost stack:
   story pages legitimately run ~110..710px tall, so reserving the tallest would
   leave ~600px of dead cream on the short ones. The pager lives in the panel
   TITLE row instead — above every variable-height thing — and the panel is
   always the LAST element on its page, so nothing can move while paging. */
const STORY_PAGE_CHARS = 700;
const STORY_ORPHAN_CHARS = 140;
/** Greedy fill by character budget. PARAGRAPHS ARE ATOMIC — one re-wraps
 *  differently on every page and reads as a bug — so an oversized paragraph
 *  becomes its own page. Never paginate by paragraph COUNT: they run 30 to
 *  1262 characters. A last page that is one short paragraph joins the one
 *  before it rather than dangling. */
/* Lore v2 (2026-08-05): a paragraph is a STRING, or an array of segments
   {t, ref?} — the lore agent's inline links, so a name in running prose can
   point straight at the entity it names. paraText() is the ONE flattener
   (search, budgets, dedupe all use it); paraNode() is the ONE renderer, and
   its links follow the established landing rules EXACTLY: a chapter ref
   starts the reader at the top, an entity ref lands on that page's story
   card (maintainer 2026-08-05: "maintain the logic we have"). Segment text
   stays a TEXT NODE — no markup path, same rule as before. */
const paraText = (p) => (typeof p === "string" ? p : (p ?? []).map((s) => s?.t ?? "").join(""));
function paraNode(p) {
  if (typeof p === "string") return h("p", {}, p);
  return h("p", {}, ...(p ?? []).map((seg) => {
    const t = seg?.t ?? "";
    if (!seg?.ref) return t;
    const r = resolveRef(seg.ref);
    if (!r) return t;                            // a stale ref reads as prose, never as a broken link
    const a = h("a", { class: "lore-inline", href: r.href }, t);
    a.addEventListener("click", () => { pendingScroll = seg.ref.domain === "lore" ? "top" : "story"; });
    return a;
  }));
}
function paginate(paras, budget = STORY_PAGE_CHARS) {
  const pages = [];
  let cur = [], n = 0;
  for (const raw of paras ?? []) {
    const len = paraText(raw).trim().length;     // budget by VISIBLE text, rich or plain
    if (!len) continue;
    if (cur.length && n + len > budget) { pages.push(cur); cur = []; n = 0; }
    cur.push(raw); n += len;
  }
  if (cur.length) pages.push(cur);
  const last = pages[pages.length - 1];
  if (pages.length > 1 && last.length === 1 && paraText(last[0]).length < STORY_ORPHAN_CHARS) {
    pages[pages.length - 2] = pages[pages.length - 2].concat(pages.pop());
  }
  return pages;
}
/** Put an element's top just under the sticky topbar. */
function scrollToTopOf(el) {
  const bar = $("#topbar")?.getBoundingClientRect().height ?? 0;
  window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - bar - 8));
}
/** A story card must ALWAYS be able to reach the top of the viewport, so a
 *  link can drop a reader straight into it (maintainer 2026-07-31). It is the
 *  last thing on its page, so without a tail there is nothing to scroll into
 *  and a short card stays stranded mid-screen. Sized exactly — zero tail once
 *  the card is taller than the viewport — and recomputed on every page turn,
 *  because turning a page changes the card's height. */
function fitStoryTail() {
  const content = $("#content"), card = $(".story-card");
  if (!content) return;
  if (!card) { content.style.paddingBottom = ""; return; }
  const bar = $("#topbar")?.getBoundingClientRect().height ?? 0;
  const need = window.innerHeight - card.getBoundingClientRect().height - bar - 8;
  content.style.paddingBottom = `${Math.max(120, Math.round(need))}px`;
}
/* --- Back returns you to your place ---------------------------------------
   You read half of Stumpling's story, follow "Read next" to Sprigling, then
   press Back — and the wiki used to drop you at the top of Stumpling, with the
   story you were reading three screens down and its page reset (maintainer
   2026-07-31). Where the reader stood is stamped onto the history entry they
   LEAVE, so the browser carries it for us and every entry remembers its own
   spot, however deep the trail goes. */
/** Stamp the outgoing entry. Anchored to the story card rather than to a raw
 *  pixel offset whenever there is one: the art above it loads lazily and the
 *  animation stage sizes itself late, so a bare scrollY would point at
 *  different content by the time the reader comes back. */
function rememberSpot() {
  const card = $(".story-card");
  /* ON A LIST, ANCHOR TO A CARD, not to a pixel (check-back, red since the
   * lists grew lazy media: thumbnails finish AFTER the restore and push the
   * content, so a raw scrollY lands hundreds of px off — measured 1400 saved,
   * 2078 landed). The first on-screen link card is identity the rebuilt page
   * still has; scroll THAT back to where it stood. */
  let anchor = null;
  if (!card) {
    const bar = $("#topbar")?.getBoundingClientRect().height ?? 0;
    const a = [...document.querySelectorAll("a.card[href^='#/'], a.trans-row[href^='#/']")]
      .find((x) => x.getBoundingClientRect().bottom > bar + 4);
    if (a) anchor = { href: a.getAttribute("href"), off: Math.round(a.getBoundingClientRect().top) };
  }
  history.replaceState({ ...history.state, spot: {
    hash: location.hash,
    y: Math.round(window.scrollY),
    cardOff: card ? Math.round(card.getBoundingClientRect().top) : null,
    page: card?.pageIndex?.() ?? null,          // which page of the story
    anchor,
  } }, "");
}
/** Put the reader back. False if the stamp isn't for this page, so the caller
 *  can fall back to the top. */
function restoreSpot(spot) {
  if (!spot || spot.hash !== location.hash) return false;
  const card = $(".story-card");
  // The page FIRST: it changes the card's height, which fitStoryTail measures,
  // which decides whether the scroll below is even reachable.
  if (card && spot.page != null) card.goToPage(spot.page);
  fitStoryTail();
  if (card && spot.cardOff != null) {
    window.scrollTo(0, Math.max(0, card.getBoundingClientRect().top + window.scrollY - spot.cardOff));
    return true;
  }
  const toAnchor = () => {
    const a = spot.anchor && document.querySelector(`a[href="${spot.anchor.href}"]`);
    if (!a) return false;
    window.scrollTo(0, Math.max(0, a.getBoundingClientRect().top + window.scrollY - spot.anchor.off));
    return true;
  };
  if (!toAnchor()) window.scrollTo(0, spot.y);
  /* Re-anchor once the lazy media has settled — but never under a moving
   * finger (the 2026-08-15 lesson: an unconditional re-apply yanked the page
   * mid-scroll). */
  const settled = window.scrollY;
  setTimeout(() => { if (Math.abs(window.scrollY - settled) <= 1) toAnchor(); }, 500);
  return true;
}
/** @param pages array of THUNKS returning Node[] — only the visible page exists.
 *  @param title a string or a Node (the story card heads with its entity). */
function pagedPanel({ title, pages, aside = null, klass = "" }) {
  if (!pages.length) return null;
  let i = 0;
  const body = h("div", { class: "story-body" });
  const count = h("span", { class: "detail-count" });
  const mk = (glyph, lbl, step) => {
    const b = h("button", { class: "nav-btn", type: "button", title: lbl, "aria-label": lbl }, glyph);
    // A plain button re-rendering IN PLACE. Never the hash: a hashchange re-runs
    // route(), which rebuilds the whole view and destroys the animation player.
    b.addEventListener("click", () => {
      const t = i + step;
      if (t < 0 || t >= pages.length) return;
      i = t; draw();
      // A new page starts at ITS top — the control is at the bottom, so
      // without this you would be left staring at the end of the page you
      // just turned to (maintainer 2026-07-31).
      if (panel) { fitStoryTail(); scrollToTopOf(panel); }
    });
    return b;
  };
  let panel = null;
  const prev = mk("‹", "Previous page", -1), next = mk("›", "Next page", +1);
  const draw = () => {
    body.replaceChildren(...pages[i]());
    count.textContent = `${i + 1} / ${pages.length}`;   // mutated in place — the
    prev.disabled = i === 0;                             // buttons are never rebuilt
    next.disabled = i === pages.length - 1;              // under the reader's finger
    // A page turn NEVER scrolls: you are mid-card, not navigating. Turning
    // from a long page to a short one shrinks the document, so a reader parked
    // at the very bottom is carried up by the browser's own scroll clamp —
    // unavoidable without reserving the tallest page, which would cost ~600px
    // of dead space on the short ones.
  };
  draw();
  // READING ORDER (maintainer 2026-07-31): title, then the prose, then the
  // page control at the BOTTOM RIGHT where the text ends, then "Read next"
  // last of all. The pager and the links used to sit above the prose, between
  // the reader and the thing they opened the card for.
  panel = h("div", { class: `panel${klass ? ` ${klass}` : ""}` },
    h("div", { class: "panel-title" }, title),
    body,
    // Counter LEFT of the buttons (crumbRow's rule) so ‹ › keep their spot as
    // "9 / 16" widens.
    pages.length > 1 ? h("div", { class: "page-rail" }, count, prev, next) : null,
    aside);
  panel.goToPage = (n) => { if (n >= 0 && n < pages.length) { i = n; draw(); } };
  panel.pageIndex = () => i;                     // for Back — see rememberSpot()
  return panel;
}

/* --- cross-references. ALWAYS resolved against the OWNING domain in data.json,
   never against lore.json: almost no item has a lore record, so a lore-sourced
   label would be blank for nearly all of them. --- */
let _loreIx = null, _charIx = null, _objIx = null, _tileIx = null;
const loreById      = (id) => (_loreIx ??= new Map(loreList().map((e) => [e.id, e]))).get(id);
const characterById = (id) => (_charIx ??= new Map((state.data.domains.characters ?? []).map((c) => [c.id, c]))).get(id);
const objectById    = (id) => (_objIx  ??= new Map((state.data.domains.objects ?? []).map((o) => [o.id, o]))).get(id);
const tileTypeById  = (id) => (_tileIx ??= new Map((state.data.domains.tiles ?? []).map((t) => [t.id, t]))).get(id);
const refPic = (x) => (x?.preview
  ? h("img", { class: "item-icon mon-icon", src: assetUrl(x.preview), alt: "", width: "48", height: "48", loading: "lazy" })
  : h("span", { class: "item-icon item-noart" }));
function resolveRef(ref) {
  const { domain, id } = ref ?? {};
  if (!domain || !id) return null;
  if (domain === "lore")       { const e = loreById(id);      return e  && { href: `#/lore/${e.id}`,       name: e.name,        art: loreIcon(e, 48),    where: chipText(e) }; }
  if (domain === "monsters")   { const m = monsterById(id);   return m  && { href: `#/monsters/${m.id}`,   name: m.name,        art: refPic(m),          where: label("monsters") }; }
  // A person's context is their RACE, not the section they live under
  // (maintainer 2026-08-05): Jehanne reads as "Human", the way a URL
  // /races/human/<id> would. Everything else names its section.
  if (domain === "characters") { const c = characterById(id); return c  && { href: `#/characters/${c.id}`, name: c.name,        art: refPic(c),          where: c.species || label("characters") }; }
  if (domain === "items")      { const it = itemById(id);     return it && { href: `#/items/${it.id}`,     name: itemLabel(it), art: itemSprite(it, 48), where: label("items") }; }
  if (domain === "objects")    { const o = objectById(id);    return o  && { href: `#/objects/${o.id}`,    name: o.name,        art: refPic(o),          where: label("objects") }; }
  if (domain === "tiles")      { const t = tileTypeById(id);  return t  && { href: `#/tiles/${t.id}`,      name: t.name,        art: h("span", { class: "item-icon item-noart" }), where: label("tiles") }; }
  return null;                                  // an unknown domain is dropped
}
/** A chapter's readable paragraphs. the_falling's body[0] repeats its summary
 *  verbatim; exact match only, so a rewritten summary can never silently
 *  swallow a paragraph. Shared with hasStory() so the page and the "Read next"
 *  filter can never disagree about whether a chapter has anything in it. */
const chapterParas = (e) => (e?.body ?? []).filter((p, n) => !(n === 0 && paraText(p) === e.summary));
/** The entity behind a reference, for the four domains that render a story
 *  card. Tiles, sounds and music are absent ON PURPOSE: their pages have no
 *  card, so no amount of loreStory in the record would give a reader anything
 *  to land on. */
function storyEntity(domain, id) {
  if (domain === "monsters")   return monsterById(id);
  if (domain === "characters") return characterById(id);
  if (domain === "objects")    return objectById(id);
  if (domain === "items")      return itemById(id);
  return null;
}
/** Does this reference lead to something you can actually READ? "Read next" is
 *  a promise, and a page with no story keeps none of it — the reader clicks
 *  expecting prose and gets a stat sheet (maintainer 2026-07-31). Answered by
 *  the same paginate() the target page will run, so the two cannot drift. */
function hasStory(ref) {
  const { domain, id } = ref ?? {};
  if (domain === "lore") return chapterParas(loreById(id)).length > 0;
  return paginate(storyEntity(domain, id)?.loreStory).length > 0;
}
/** "Read next". Author order preserved (the lore agent chose it), deduped. A
 *  reference that is unresolvable — or that resolves to a page with no story —
 *  is DROPPED for players and flagged for the admin, who is the one who can
 *  get it written. */
function loreLinks(related, { title = "Read next" } = {}) {
  const seen = new Set(), rows = [];
  for (const ref of related ?? []) {
    const key = `${ref?.domain}/${ref?.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = resolveRef(ref);
    if (r && hasStory(ref)) {
      const a = h("a", { class: "drop-row", href: r.href }, r.art,
        h("span", { class: "drop-name" }, r.name), h("span", { class: "drop-worth muted" }, r.where));
      // Where the reader should LAND. A chapter is a thing you read from the
      // top; another entity's story is the middle of its page, so go to that
      // card rather than making the reader hunt for it (maintainer
      // 2026-07-31).
      a.addEventListener("click", () => { pendingScroll = ref.domain === "lore" ? "top" : "story"; });
      rows.push(a);
    }
    else if (state.admin) rows.push(h("div", { class: "drop-row" },
      r?.art ?? h("span", { class: "item-icon item-noart" }),
      h("span", { class: "drop-name" }, r ? r.name : key,
        h("span", { class: "pill warn" }, r ? "no story yet" : "no such entry"))));
  }
  if (!rows.length) return null;
  return h("div", { class: "see-also" },
    h("div", { class: "panel-title see-also-title" }, title),
    h("div", { class: "drop-list" }, ...rows));
}
/** The long story, in a card at the BOTTOM of an entity's page — many readers
 *  will never open it, so it must cost them nothing (maintainer 2026-07-31).
 *  No story ⇒ NO CARD AT ALL, never a placeholder. */
function storyCard({ label: what, art, name, paras, related }) {
  const chunks = paginate(paras);
  if (!chunks.length) return null;
  // The card RE-INTRODUCES its entity (maintainer 2026-07-31): a link can drop
  // a reader straight onto this card with the rest of the page above the fold,
  // so the card has to say who it is about on its own. Thumbnail left, name
  // right — smaller than the page's own h1, because this is a reminder, not a
  // second title.
  const head = h("div", { class: "story-head" },
    art ?? null,
    h("div", { class: "story-who" },
      h("div", { class: "story-name" }, name ?? ""),
      h("div", { class: "story-what muted" }, what)));
  return pagedPanel({
    title: head, klass: "story-card",
    aside: loreLinks(related),                       // last in the card
    pages: chunks.map((ps) => () => ps.map(paraNode)),
  });
}
const heroStoryTitle = (c) => (c.sex === "Female" ? "Her story" : c.sex === "Male" ? "His story" : "Their story");

/** The level chip that sits under a monster's picture — on the cards AND on
 *  the monster page, where it also gives the portrait column a constant
 *  height so paging next/next/next doesn't shift the animation (maintainer
 *  2026-07-30). Levels live in live/tuning/monsters.json; see build.mjs. */
function levelBadge(stats) {
  return h("div", { class: "thumb-chip", title: "How hard this creature is to fight" },
    "Level ", h("b", {}, String(stats.level ?? "?")));
}
/* --- loot: the item ↔ creature join (build.mjs precomputes both ways) --- */
let _itemIx = null, _monIx = null;
const itemById = (id) => (_itemIx ??= new Map((state.data.domains.items ?? []).map((i) => [i.id, i]))).get(id);
const monsterById = (id) => (_monIx ??= new Map((state.data.domains.monsters ?? []).map((m) => [m.id, m]))).get(id);
/** A drop chance (a FRACTION) as a percentage a human can read. The data spans
 *  0.006..0.45, so a fixed precision either prints "1%" for three different
 *  odds or "45.0%" for none of them: keep one decimal below 10%, whole
 *  numbers above, and never round a real chance down to "0%". */
function pct(chance) {
  const n = Number(chance);
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = Math.min(100, n * 100);
  if (p < 0.1) return "<0.1%";
  return `${p < 10 ? +p.toFixed(1) : Math.round(p)}%`;
}
/** Is this item's type bound 1-to-1 to a creature? Asked of the ITEMS AGENT'S
 *  own type table (`one_per_monster`), never by testing for "SOUL" — a future
 *  type that declares it inherits the treatment for free. */
const oneToOne = (it) => !!state.data.itemTypes?.[it?.type]?.one_per_monster;
const itemSources = (it) => it?.droppedBy ?? [];
/** What KIND of thing this is, in the maintainer's words. The items agent's
 *  own table is the source, except where the maintainer has named a type
 *  differently for players (2026-07-31: MISC reads "Miscellaneous", not the
 *  pipeline's "Junk") — asked of the tag, so a retitle upstream can't
 *  silently change what players read. */
const TYPE_NAMES = { MISC: "Miscellaneous" };
/** Order: the maintainer's word, then the type's own SHARED NAME when it has
 *  one — a type where every item carries the same name ("Soulstone") is
 *  called that, not the pipeline's prettier label ("Soul Stone") — then the
 *  label, then the raw tag. */
const typeLabel = (t) => {
  const ty = state.data.itemTypes?.[t];
  return TYPE_NAMES[t] ?? ty?.shared_name ?? ty?.label ?? t ?? "Item";
};
/** The maintainer's generic emblem for a whole item TYPE (a pearl for the
 *  junk, a stone for the souls) — the at-a-glance "what kind of thing is
 *  this" that rides on the chip. Authored 32×32 at 1×, drawn at 32 and never
 *  resampled. Keyed by tag: a type with no emblem simply gets none, so a new
 *  type is a file drop, not a code change. */
const TYPE_ICONS = { MISC: "type-misc", SOUL: "type-soul" };
function typeIcon(t, size = 32) {
  const icon = TYPE_ICONS[t];
  return icon
    ? h("img", { class: "type-icon", src: `icons/${icon}.webp`, alt: "", width: String(size), height: String(size), loading: "lazy" })
    : null;
}
/** The chip under an item's picture. For a 1-to-1 type it names the creature —
 *  every Soulstone is literally called "Soulstone", so the creature is the
 *  only thing that tells two of them apart. Decisions key off the SOURCE
 *  COUNT, never off soulOf alone: that is null for "unbound" AND for the
 *  "bound twice" the data must never contain but might. */
function itemChip(it) {
  // A 1-to-1 type has something better to say than its own name: the
  // creature. Everything else just says WHAT IT IS — not how rare it is
  // (maintainer 2026-07-31: "I don't like the Common/Uncommon/Rare/Epic
  // thing. This should just say the item type").
  // Both chips carry the type's emblem, so the KIND reads at a glance even
  // on a stone whose text is a creature's name (maintainer 2026-07-31).
  // The label is always its own element so the chip can lay out as a grid:
  // emblem pinned left, text centred in the WHOLE chip (maintainer
  // 2026-07-31) — a bare text node would become an anonymous grid item that
  // no selector can address.
  return h("div", { class: "thumb-chip has-icon", title: typeLabel(it.type) },
    typeIcon(it.type),
    h("span", { class: "chip-text" }, oneToOne(it) ? soulChip(it, true) : typeLabel(it.type)));
}
/** The creature a 1-to-1 stone belongs to. ALWAYS its name — a Soulstone
 *  carries no other identity. Bare = inline pill; `plain` = chip contents. */
function soulChip(it, plain = false) {
  const src = itemSources(it);
  const names = src.map((s) => monsterById(s.monster)?.name ?? s.monster);
  const wrap = (title, ...kids) => plain
    ? h("span", { title }, ...kids)
    : h("span", { class: "pill soul", title }, ...kids);
  if (names.length === 1) return wrap(`The soul of ${names[0]}`, names[0]);
  if (names.length === 0) return wrap("No creature carries this soul", "Unbound");
  return wrap(names.join(", "), names.join(" · "));
}
/** What an item sells for: the maintainer's gold coin and the number, no
 *  sentence around it (2026-07-31 — "this is more clean and says it all").
 *  The coin is authored 32×32 at 1×, so it is drawn at 32 and never resampled. */
function goldTag(it) {
  const v = Number(it?.value);
  if (!Number.isFinite(v) || v <= 0) return null;
  return h("span", { class: "gold-tag", title: `Sells for ${v} gold` },
    h("img", { class: "gold-coin", src: "icons/gold.webp", alt: "gold", width: "32", height: "32" }),
    h("b", {}, String(v)));
}
/** An item's sprite at a WHOLE multiple of its authored 48px (never resampled). */
function itemSprite(it, size = 48) {
  return it?.preview
    ? h("img", { class: "item-icon", src: assetUrl(it.preview), alt: "", width: String(size), height: String(size), loading: "lazy" })
    : h("span", { class: "item-icon item-noart", style: `width:${size}px;height:${size}px` });
}
/** WHAT THIS CREATURE DROPS — icon, name, worth, chance, each row a link to
 *  the item's page (maintainer 2026-07-31: the old list printed the folder id
 *  in a monospace chip and went nowhere). */
function dropsPanel(monsterId) {
  const stats = monsterStats(monsterId);
  const rows = (stats?.loot ?? [])
    .filter((l) => l?.item)                              // "+ add drop" writes a blank row
    .map((l) => ({ l, it: itemById(l.item) }))
    .filter((r) => r.it || state.admin)                  // an id the registry lost: never shown to players
    .sort((a, b) => (Number(b.l.chance) || -1) - (Number(a.l.chance) || -1)
      || String(a.it?.name ?? a.l.item).localeCompare(String(b.it?.name ?? b.l.item)));
  if (!rows.length) {
    return h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Drops"),
      h("p", { class: "muted" }, "Nothing yet — no loot has been assigned to this creature."));
  }
  return h("div", { class: "panel" },
    h("div", { class: "panel-title" }, "Drops", h("span", { class: "pill" }, String(rows.length))),
    h("div", { class: "drop-list" }, ...rows.map(({ l, it }) => {
      // A soul stone is named "Soulstone" everywhere, so its creature rides
      // beside it even here, on that very creature's own page (maintainer
      // 2026-07-31) — the row must stay readable wherever it is quoted.
      const bound = it && oneToOne(it) ? soulChip(it) : null;
      return h("a", { class: "drop-row", href: it ? `#/items/${it.id}` : "#/items" },
        itemSprite(it),
        h("span", { class: "drop-name" },
          it?.name ?? l.item,
          bound,
          !it ? h("span", { class: "pill warn" }, "unknown item") : null),
        h("span", { class: "drop-worth" }, goldTag(it) ?? ""),
        h("span", { class: "drop-pct" }, pct(l.chance) ?? "—"));
    })));
}
/** WHERE THIS ITEM COMES FROM — the same table reversed, each row a link to
 *  the creature's page. */
function droppedByPanel(it) {
  const src = itemSources(it);
  const soul = oneToOne(it);
  if (!src.length) {
    return h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Dropped by", h("span", { class: "pill" }, "none")),
      h("p", { class: "muted" }, soul
        ? "No creature in Nangijala carries this soul."
        : "Nothing in Nangijala is known to carry this."));
  }
  return h("div", { class: "panel" },
    h("div", { class: "panel-title" }, "Dropped by",
      h("span", { class: "pill" }, src.length === 1 ? "1 creature" : `${src.length} creatures`),
      soul && src.length > 1 ? h("span", { class: "pill warn", title: "A soul stone is meant to belong to exactly one creature" }, "should be one") : null),
    h("div", { class: "drop-list" }, ...src.map((s) => {
      const m = monsterById(s.monster);
      const st = monsterStats(s.monster);
      return h("a", { class: "drop-row", href: m ? `#/monsters/${m.id}` : "#/monsters" },
        m?.preview
          ? h("img", { class: "item-icon mon-icon", src: assetUrl(m.preview), alt: "", loading: "lazy" })
          : h("span", { class: "item-icon item-noart" }),
        h("span", { class: "drop-name" },
          m?.name ?? s.monster,
          !m ? h("span", { class: "pill warn" }, "unknown creature") : null),
        h("span", { class: "drop-worth muted" }, m && st?.level ? `Lv ${st.level}` : ""),
        h("span", { class: "drop-pct" }, pct(s.chance) ?? "—"));
    })));
}
/** A monster's effective stats: its tuned entry over the shared defaults. */
function monsterStats(id) {
  const t = state.tuning.monsters;
  return { ...(t?.defaults ?? {}), ...(t?.monsters?.[id] ?? {}) };
}
const STAT_FIELDS = [
  ["level", "Level", 1],
  ["max_hp", "Max HP", 1], ["damage", "Damage", 1], ["speed_wu", "Speed (wu/s)", 1],
  ["aggro_radius_wu", "Aggro radius (wu)", 1], ["attack_cooldown_ms", "Attack cooldown (ms)", 10],
  ["xp", "XP reward", 1], ["scale", "Display scale", 0.05],
];
function statsEditor(monsterId) {
  const t = state.tuning.monsters;
  if (!t) return h("p", { class: "muted" }, "tuning/monsters.json not loaded.");
  // Render from a copy; only a real edit installs the entry (viewing a page
  // must never sneak an entry into the next save).
  const stats = t.monsters[monsterId] ?? { ...t.defaults, loot: [] };
  if (!state.admin) {
    // Players see the stats read-only; the drops are their own panel now
    // (dropsPanel — icons, real names and a link to each item's page).
    return h("div", { class: "stat-grid ro" }, ...STAT_FIELDS.map(([key, label]) =>
      h("label", {}, label, h("span", { class: "stat-value" }, String(stats[key] ?? t.defaults[key] ?? 0)))));
  }
  const edited = () => {
    t.monsters[monsterId] = stats;
    touch("tuning/monsters", monsterId);
    markDirty("tuning/monsters");
  };
  const grid = h("div", { class: "stat-grid" }, ...STAT_FIELDS.map(([key, label, step]) => {
    const input = h("input", { type: "number", step: String(step), value: String(stats[key] ?? t.defaults[key] ?? 0) });
    input.addEventListener("change", () => { stats[key] = Number(input.value); edited(); });
    return h("label", {}, label, input);
  }));
  const lootBox = h("div", {});
  function renderLoot() {
    lootBox.replaceChildren(
      h("div", { class: "panel-title" }, "Loot / drops ", h("span", { class: "pill" }, "items agent: future")),
      ...(stats.loot ?? []).map((entry, i) =>
        h("div", { class: "loot-row" },
          Object.assign(h("input", { type: "text", placeholder: "item id (e.g. tusk)" , value: entry.item ?? "" }), { onchange: (e) => { entry.item = e.target.value; edited(); } }),
          Object.assign(h("input", { type: "number", class: "chance", min: "0", max: "100", step: "0.1", title: "drop chance %", value: String(+(100 * (entry.chance ?? 0)).toFixed(2)) }), { onchange: (e) => { entry.chance = Number(e.target.value) / 100; edited(); } }),
          h("span", { class: "muted" }, "%"),
          h("button", { class: "ghost-btn", onclick: () => { stats.loot.splice(i, 1); edited(); renderLoot(); } }, "✕"))),
      h("button", { class: "ghost-btn", onclick: () => { (stats.loot ?? (stats.loot = [])).push({ item: "", chance: 0.1 }); edited(); renderLoot(); } }, "+ add drop"));
  }
  renderLoot();
  return h("div", {}, grid, h("div", { style: "margin-top:14px" }, lootBox));
}
// "Where it lives": the world's own minimap with this monster's spawn zones
// drawn on it. The zones arrive as CELL SPANS (wiki/tools/world-map.py) —
// never as an outline. Projecting a zone's OUTLINE is what shipped broken on
// 2026-07-30: each vertex carries its corner's terrain height, which makes
// the projection non-linear, so a provably simple polygon tore into
// self-crossing shards across cliffs. A span is a run of cells at ONE level,
// so it maps through the affine cell→pixel transform and its union is the
// true, terrace-hugging footprint.
function zoneMapPanel(monsterId) {
  const wm = worldInfo()?.map;
  const zones = wm?.monsters?.[monsterId];
  if (!wm?.proj || !zones?.length) return null;
  const CSS_W = 900, k = CSS_W / wm.mapW, DPR = 2, s = k * DPR;
  const P = wm.proj;
  const canvas = h("canvas", {
    class: "zone-map", width: Math.round(wm.mapW * s), height: Math.round(wm.mapH * s),
    style: `width:${CSS_W}px`,
  });
  const ctx = canvas.getContext("2d");
  // Cell corner → canvas px. `ax/ay` offset within the tile box (the diamond's
  // top vertex is at +tile/2, its side vertices at +dy, its bottom at +2dy).
  const pt = (c, r, lv, ax, ay) => [
    (P.s * (P.ox + (c - r) * P.dx + ax) + P.offx) * s,
    (P.s * (P.oy + (c + r) * P.dy - lv * P.levelPx + ay) + P.offy) * s,
  ];
  const img = new Image();
  img.onload = () => {
    // A 0.15x LANCZOS bake of the whole world — smooth it down, don't
    // nearest-neighbour it (this is a map thumbnail, not 1:1 pixel art).
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#d97757";

    // Paint every span SOLID on an offscreen layer first: overlapping
    // translucent diamonds would blotch at their shared edges.
    const layer = document.createElement("canvas");
    layer.width = canvas.width; layer.height = canvas.height;
    const lx = layer.getContext("2d");
    lx.fillStyle = accent;
    lx.beginPath();
    for (const z of zones) {
      for (const [r, lv, c0, c1] of z.spans ?? []) {
        const a = pt(c0, r, lv, P.tile / 2, 0);          // top vertex, first cell
        const b = pt(c1, r, lv, P.tile, P.dy);           // right vertex, last cell
        const c = pt(c1, r, lv, P.tile / 2, 2 * P.dy);   // bottom vertex, last cell
        const d = pt(c0, r, lv, 0, P.dy);                // left vertex, first cell
        lx.moveTo(a[0], a[1]); lx.lineTo(b[0], b[1]); lx.lineTo(c[0], c[1]); lx.lineTo(d[0], d[1]);
        lx.closePath();
      }
    }
    lx.fill();

    // A solid rim (the layer nudged 4 ways) under a translucent body, so the
    // habitat reads at a glance without hiding the terrain inside it.
    const ring = 2 * DPR;
    for (const [dx, dy] of [[ring, 0], [-ring, 0], [0, ring], [0, -ring]]) ctx.drawImage(layer, dx, dy);
    ctx.globalAlpha = 0.42;
    ctx.drawImage(layer, 0, 0);
    ctx.globalAlpha = 1;

    // How many roam this particular habitat, at its centre of mass.
    ctx.font = `600 ${13 * DPR}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const z of zones) {
      const spans = z.spans ?? [];
      if (!spans.length) continue;
      let n = 0, sx = 0, sy = 0;
      for (const [r, lv, c0, c1] of spans) {
        const w = c1 - c0 + 1;
        const [x, y] = pt((c0 + c1) / 2 + 0.5, r + 0.5, lv, P.tile / 2, P.dy);
        sx += x * w; sy += y * w; n += w;
      }
      ctx.lineWidth = 4 * DPR;
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.strokeText(String(z.num), sx / n, sy / n);
      ctx.fillStyle = "#fff";
      ctx.fillText(String(z.num), sx / n, sy / n);
    }
  };
  img.src = assetUrl(wm.minimap);
  const total = zones.reduce((n, z) => n + z.num, 0);
  return h("div", { class: "panel" },
    h("div", { class: "panel-title" }, "Where it lives ",
      h("span", { class: "pill" }, `${total} in ${zones.length} ${zones.length === 1 ? "habitat" : "habitats"}`)),
    h("div", { class: "zone-map-wrap" }, canvas),
    state.admin ? h("p", { class: "muted", style: "margin:8px 0 0" },
      "zones: ", zones.map((z) => `${z.id || "?"} (${z.num})`).join(" · ")) : null);
}

function viewMonster(id) {
  const m = state.data.domains.monsters.find((x) => x.id === id);
  if (!m) return h("p", {}, "Unknown monster.");
  const facetPill = h("span", {});
  const facetBox = h("div", {});
  const player = makePlayer(m, "monster", { headerEl: facetHead(facetPill, facetBox) });
  activePlayers.push(player);
  // ONE ANIMATION IN ONE DIRECTION is the unit that gets regenerated, so it is
  // the unit that gets judged (maintainer 2026-08-14). "Walk is fine except
  // north-east" was previously unsayable — the only verdict available covered
  // all eight directions at once.
  const renderFacet = () => {
    const st = player.getState(), dir = player.getDir();
    facetPill.replaceChildren(facetName(st, dir));
    facetBox.replaceChildren(feedbackRow("monsters", `${m.path}#${st}#${dir}`, {
      // The chip the verdict belongs to turns green or red the moment it lands.
      onchange: () => player.refreshMarks(),
      // The hash of exactly this animation in exactly this direction, so the
      // producing agent can tell a live verdict from one about art it has
      // since regenerated.
      stamp: { art: m.animations?.[st]?.dirs?.[dir]?.h ?? null },
      stale: () => facetStale(m, st, dir, fb("monsters", `${m.path}#${st}#${dir}`)),
      rejectTitle: `Reject just this one — ${stateLabel(st)} facing ${dir} — for the monsters agent to regenerate`,
      rejectedLabel: "slated for removal",
    }));
  };
  player.onFacetChange = renderFacet;
  renderFacet();
  // Warm every animation of this creature and of the two either side of it,
  // so clicking Walk, turning to NE or pressing › does not start a download.
  prefetchAround(m, monsterNav(), m.id);
  return h("div", {},
    // The pager follows the FILTER, so a shadow queue can be walked with ›.
    crumbRow("#/monsters", `← ${label("monsters")}`, "monsters", monsterNav(), m.id),
    h("div", { class: "detail-head" },
      h("div", { class: "portrait-col" },
        h("div", { class: "portrait checker" }, h("img", { src: assetUrl(m.preview), alt: m.name })),
        levelBadge(monsterStats(m.id))),
      h("div", { class: "meta" },
        h("h1", {}, m.name),
        // How many roam the world, tucked under the name and above the
        // description (maintainer 2026-07-30).
        h("div", { class: "spawn-line" },
          // WHERE "CALM" LIVES NOW. The overview marks only the aggressive
          // ones — a green pill on 48 of 57 cards answers "will it attack me"
          // by shouting at everybody — so the creature's own page is where
          // both states are spelled out in words. The stat grid further down
          // says "Aggro radius (wu): 0", which is the same fact in a form that
          // assumes you already know the rule.
          aggroPill(monsterStats(m.id)),
          (() => {
          const sp = monsterSpawns(m.id);
          return sp
            ? h("span", { class: "pill ok" }, `${sp.spawned} roaming the world across ${sp.zones} ${sp.zones === 1 ? "habitat" : "habitats"}`)
            : h("span", { class: "pill warn", title: "No spawn zone places this creature in the world yet" }, "not spawned in the world");
        })()),
        // PLAYER-facing lore: the monsters domain's own blurb (monster.json
        // `lore`) when it ships one, else a generic placeholder until the
        // lore agent covers the stragglers (maintainer 2026-07-30). The lore
        // is the LAST thing in this column on purpose — the height it
        // reserves for the longest blurb then falls at the bottom of the
        // column, where it reads as the gap before the next panel instead of
        // opening a blank line in the middle of the page.
        loreSlot(monsterLore(m), state.data.domains.monsters.map(monsterLore)),
        // The art/render tech line (resolution, pads, foot metrics, kind) is
        // GONE — maintainer 2026-08-15: "only the text 'Open in PixelLab ↗' is
        // enough for the admin here". It was measurement output, useful while
        // the shadows and foot anchors were being calibrated and noise ever
        // since; every number in it is still in data.json for whoever needs it.
        state.admin && m.pixellab ? h("p", {}, h("a", { href: m.pixellab, target: "_blank", rel: "noopener" }, "Open in PixelLab ↗")) : null,
        feedbackRow("monsters", m.path))),
    h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Animations", h("span", { class: "pill" }, `${Object.keys(m.animations).length} states × 8 directions`)),
      player.el),
    zoneMapPanel(m.id),
    // What it drops, each row a link to that item's page.
    dropsPanel(m.id),
    h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Stats"),
      statsEditor(m.id)),
    // This creature's own sound events (none in the game yet — the Game
    // Master can assign one to any of its actions from here).
    entitySoundsCard("monsters", m),
    // The long story, last on the page ALWAYS — the pager is the only control
    // above variable-height content, so nothing may be appended below it.
    storyCard({ label: "The story", art: refPic(m), name: m.name, paras: m.loreStory, related: m.loreRelated }));
}

/* --- characters --- */
/** "Where you'll find them": the same world minimap the creatures use, with
 *  this NPC's standing spot marked (maintainer 2026-08-06). Deliberately an
 *  APPROXIMATE mark, not a pin: maps2 gives an exact cell, but an NPC who can
 *  walk will not be standing on that exact tile when you arrive — so the spot
 *  is a soft halo the size of a short wander, with a hard dot at its centre
 *  for "this is the place". Points, not spans: a person is one cell.
 *  Projection is the zone map's own affine, so both maps agree by
 *  construction. */
function npcMapPanel(c) {
  const wm = worldInfo()?.map;
  const spots = wm?.npcs?.[c.id];
  if (!wm?.proj || !spots?.length) return null;
  const P = wm.proj;
  // Cell → minimap px, at the diamond's CENTRE (+tile/2, +dy): where the feet
  // of a body standing in that cell are drawn.
  const at = (x, y, lv) => [
    P.s * (P.ox + (x - y) * P.dx + P.tile / 2) + P.offx,
    P.s * (P.oy + (x + y) * P.dy - lv * P.levelPx + P.dy) + P.offy,
  ];
  // The mark is a CSS overlay in PERCENT, not painted into a canvas: this map
  // is 1800px wide and shows at ~330 on a phone, so a canvas-drawn dot shrinks
  // to a speck exactly where it matters most. In percent it keeps its size on
  // every screen, and stays crisp.
  const marks = spots.map((sp) => {
    const [x, y] = at(sp.x, sp.y, sp.elev ?? 0);
    return h("span", {
      class: "npc-spot", title: `${sp.name || c.name}${sp.anchor ? ` — ${ANCHOR_WHERE[sp.anchor] ?? sp.anchor}` : ""}`,
      style: `left:${(x / wm.mapW * 100).toFixed(3)}%; top:${(y / wm.mapH * 100).toFixed(3)}%`,
    });
  });
  const one = spots[0];
  const where = ANCHOR_WHERE[one.anchor] ?? (one.anchor ? `near the ${one.anchor}` : "in the world");
  return h("div", { class: "panel" },
    h("div", { class: "panel-title" }, "Where you'll find them ",
      h("span", { class: "pill" }, where),
      spots.length > 1 ? h("span", { class: "pill" }, `${spots.length} spots`) : null),
    h("div", { class: "zone-map-wrap npc-map-wrap" },
      h("img", { class: "zone-map", src: assetUrl(wm.minimap), alt: `${worldInfo()?.name ?? "the world"} map`, loading: "lazy" }),
      ...marks),
    h("p", { class: "muted", style: "margin:8px 0 0" },
      "Roughly here — they keep to this part of the world, but they do not stand on one tile all day.",
      state.admin ? ` (${spots.map((x) => `${x.id || "?"} @ ${x.x},${x.y}${x.elev ? ` lv${x.elev}` : ""}`).join(" · ")})` : ""));
}
/** maps2' placement anchors, said the way a player would say them. */
const ANCHOR_WHERE = {
  arrival: "at the arrival point", house: "in the market", cave: "at the cave mouth",
  bridge: "at the bridge", road: "on the road", shore: "on the shore",
};
const npcCard = (c) => h("a", { class: "card npc-card", href: `#/characters/${c.id}` },
  h("div", { class: "thumb checker" }, h("img", { src: assetUrl(c.preview), alt: c.name, loading: "lazy" })),
  // Real names (characters2 2026-08-01), said QUIETLY: one line of name, one
  // muted line of trade, both truncating — a tile that grows a second line
  // re-flows the whole grid and the block stops reading as secondary.
  h("div", { class: "npc-name" }, c.name),
  // A dot on the tile marks the handful who actually stand in the world —
  // without it they are unfindable among 191 (it rides ON the thumbnail, so
  // the tile keeps its two text lines and the grid never re-flows).
  npcPlacements(c.id)?.length
    ? h("span", { class: "npc-placed", title: "Stands in the world" }) : null,
  c.role ? h("div", { class: "npc-role muted" }, c.role) : null,
  state.admin ? h("div", { class: "card-sub" }, c.id) : null,
  h("div", { class: "card-badges" }, ...entityBadge("characters", c.path)));
/** The NPC block, paged INSIDE its card: 20 tiles a page with ‹ › (maintainer
 *  2026-08-05 — one race's full cast would bury the next race the day a
 *  second one ships). In-place redraw, same idiom as the story pager; no
 *  scroll on a page turn, the reader is already looking at the grid. */
function npcPagedBlock(npcs) {
  if (!npcs.length) return null;
  const PER = 20;
  const pages = Math.ceil(npcs.length / PER);
  let page = 0;
  const grid = h("div", { class: "grid npc-grid" });
  const count = h("span", { class: "detail-count" });
  const mk = (glyph, lbl, step) => h("button", {
    class: "nav-btn", type: "button", title: lbl, "aria-label": lbl,
    onclick: () => { const t = page + step; if (t < 0 || t >= pages) return; page = t; draw(); },
  }, glyph);
  const prev = mk("‹", "Previous NPCs", -1), next = mk("›", "Next NPCs", +1);
  const draw = () => {
    grid.replaceChildren(...npcs.slice(page * PER, (page + 1) * PER).map(npcCard));
    count.textContent = `${page + 1} / ${pages}`;
    prev.disabled = page === 0;
    next.disabled = page === pages - 1;
  };
  draw();
  return h("div", { class: "npc-block" },
    h("h2", {}, "NPCs", h("span", { class: "pill", style: "margin-left:8px" }, npcs.length.toLocaleString())),
    h("p", { class: "muted" }, state.admin
      ? "The tag-driven NPC mirror — name, sex and trade authored by the characters agent from the art itself. Review and prune from here."
      : "The folk you will meet along the way. You cannot set out as one of them."),
    grid,
    pages > 1 ? h("div", { class: "page-rail" }, count, prev, next) : null);
}
/** The lore agent's write-up of a race — its "people" entry, matched by name
 *  (Human → "The Human Dead"). Their text wins, as everywhere. */
const raceLore = (race) => (state.data.domains.lore ?? []).find((e) => e.category === "people" && new RegExp(race, "i").test(e.name));
function viewCharacters() {
  const all = state.data.domains.characters;
  const heroes = all.filter((c) => c.kind !== "npc" && matches(state.query, c.id, c.name));
  const npcs = all.filter((c) => c.kind === "npc" &&
    matches(state.query, c.name, c.sex, c.role, ...(state.admin ? [c.id, c.pixellabName] : [])));
  // RACES (maintainer 2026-08-05): the page is grouped by race, each an inner
  // topic with the race's own description. Only Humans exist today — the
  // structure is what matters, so a second race lands as a second block.
  const races = [...new Set(all.map((c) => c.species || "Human"))].sort();
  return h("div", {},
    sectionHead("characters"),
    h("p", { class: "muted" }, state.admin
      ? "Every race of Nangijala — its playable heroes first, then its NPCs. From characters2; every game state, all 8 directions."
      : "The races of Nangijala — the heroes you can set out as, and the folk you will meet."),
    ...races.map((race) => {
      const rl = raceLore(race);
      const rHeroes = heroes.filter((c) => (c.species || "Human") === race);
      const rNpcs = npcs.filter((c) => (c.species || "Human") === race);
      if (!rHeroes.length && !rNpcs.length) return null;
      return h("div", { class: "race-block" },
        h("h2", {}, `${race}s`,
          rHeroes.length ? h("span", { class: "pill ok", style: "margin-left:8px" }, `${rHeroes.length} playable`) : null),
        // The race's short description — the lore agent's "people" entry
        // where one exists, with the way into the full write-up.
        rl ? h("p", { class: "muted race-blurb" }, rl.summary, " ", h("a", { href: `#/lore/${rl.id}` }, "Read more →"))
           : h("p", { class: "muted race-blurb" }, "The chroniclers have not written this race up yet."),
        rHeroes.length ? h("div", { class: "grid" }, ...rHeroes.map((c) =>
          h("a", { class: "card", href: `#/characters/${c.id}` },
            h("div", { class: "thumb checker" }, h("img", { src: assetUrl(c.preview), alt: c.name, loading: "lazy" })),
            h("div", { class: "card-name" }, c.name),
            // What the hero IS, not what the folder is called.
            h("div", { class: "card-sub" }, heroKind(c)),
            state.admin ? h("div", { class: "card-sub" }, `${c.id} · ${Object.keys(c.animations).length} states`) : null,
            h("div", { class: "card-badges" }, ...entityBadge("characters", c.path))))) : null,
        npcPagedBlock(rNpcs));
    }));
}
function viewCharacter(id) {
  const c = state.data.domains.characters.find((x) => x.id === id);
  if (!c) return h("p", {}, "Unknown character.");
  const facetPill = h("span", {});
  const facetBox = h("div", {});
  const player = makePlayer(c, "character", { headerEl: facetHead(facetPill, facetBox) });
  activePlayers.push(player);
  // Per animation AND direction, same as monsters — a walk that breaks only
  // when facing north-west is regenerated for north-west alone.
  const renderFacet = () => {
    const st = player.getState(), dir = player.getDir();
    facetPill.replaceChildren(facetName(st, dir));
    facetBox.replaceChildren(feedbackRow("characters", `${c.path}#${st}#${dir}`, {
      // The chip the verdict belongs to turns green or red the moment it lands.
      onchange: () => player.refreshMarks(),
      // The hash of exactly this animation in exactly this direction, so the
      // producing agent can tell a live verdict from one about art it has
      // since regenerated.
      stamp: { art: c.animations?.[st]?.dirs?.[dir]?.h ?? null },
      stale: () => facetStale(c, st, dir, fb("characters", `${c.path}#${st}#${dir}`)),
      rejectTitle: `Reject just this one — ${stateLabel(st)} facing ${dir} — for the characters agent to regenerate`,
      rejectedLabel: "slated for removal",
    }));
  };
  player.onFacetChange = renderFacet;
  renderFacet();
  // (the old Movement-sounds panel listed catalog takes; the entity card
  //  below replaces it with the character's OWN sound events, played by the
  //  mirrored engine — maintainer 2026-08-05)
  // Paging stays INSIDE the group: ‹ › from a hero walks the heroes, from an
  // NPC walks the NPCs — 191 Villagers between Man and Woman would bury the
  // playable cast the page is foremost about. Same group feeds the lore
  // reserve, so the viewer's height is constant within what you can page to.
  const isNpc = c.kind === "npc";
  const group = state.data.domains.characters.filter((x) => (x.kind === "npc") === isNpc);
  prefetchAround(c, group, c.id);
  return h("div", {},
    // Back-link names the RACE, not the section — the page reads as if it
    // sat at /races/human/<id> (maintainer 2026-08-05). It still LEADS to
    // the Races page; there is no per-race route to lead to.
    crumbRow("#/characters", `← ${c.species || label("characters")}`, "characters", group, c.id),
    h("div", { class: "detail-head" },
      // Species/sex rides under the thumbnail, exactly like a monster's level
      // chip — it balances the two columns (maintainer 2026-07-30).
      h("div", { class: "portrait-col" },
        h("div", { class: "portrait checker" }, h("img", { src: assetUrl(c.preview), alt: c.name })),
        heroKind(c) ? h("div", { class: "thumb-chip" }, heroKind(c)) : null),
      h("div", { class: "meta" },
        h("h1", {}, c.name),
        // The trade, quietly, under the name — WITH the world pills on that
        // same line. As its own row, "in the world" existed only for the
        // handful of NPCs maps2 actually places, so paging ‹ › through 191
        // characters shifted every panel below it up and down (maintainer
        // 2026-08-07: "I don't want the animation cart to jump up and down
        // when I press next NPC"). This row is now unconditional and cannot
        // wrap, so it is exactly one line tall for every character whether
        // they have a role, pills, both or neither.
        //
        // A MERCHANT's wares come straight from maps2' placement (validated
        // against items/ TYPE tags), so that pill says what you can actually
        // buy from them. It is the one that can run long, so it is the one
        // allowed to shrink and ellipsize — the full list stays in its title.
        h("div", { class: "npc-trade muted" }, ...(() => {
          const out = c.role ? [h("span", { class: "npc-role" }, c.role)] : [];
          // A constraint on the ART, not a fact about the character, so it is
          // the Game Master's business (maintainer 2026-08-07). characters2
          // sets `no_turn` when a character only reads right from one facing —
          // Thorne's breastplate stands beside him in south and south-west and
          // is missing in south-east, so a turn pops the prop in and out.
          if (state.admin && c.noTurn) out.push(h("span", { class: "pill warn npc-noturn", title: "characters2 `no_turn`: this character's art only reads right from ONE facing, so the game must never rotate them." }, "never turns"));
          const sp = npcPlacements(c.id);
          if (!sp?.length) return out;
          const merchant = sp.find((x) => x.type === "MERCHANT");
          const wares = [...new Set(sp.flatMap((x) => x.wares ?? []))].map((w) => w.toLowerCase());
          out.push(h("span", { class: "pill ok", title: "maps2 stands this character in the game's world" },
            merchant ? "merchant in the world" : "in the world"));
          if (wares.length) out.push(h("span", { class: "pill npc-wares", title: `The item types they deal in: ${wares.join(", ")}` }, `sells ${wares.join(", ")}`));
          return out;
        })()),
        // Folder id, frame size and state count are PIPELINE facts — admin
        // only (maintainer 2026-07-30). The NPC's PixelLab name is the same
        // class of fact: prompt junk a player must never meet.
        state.admin ? h("p", { class: "muted" }, `${c.id}${c.pixellabName ? ` · “${c.pixellabName}”` : ""} · ${c.frameW}×${c.frameH}px · ${Object.keys(c.animations).length} animation states`) : null,
        // Deduped: the 191 NPCs share one placeholder, and the reserve only
        // needs each DISTINCT height once, not 191 copies of the same ghost.
        loreSlot(heroLore(c), [...new Set(group.map(heroLore))]),
        feedbackRow("characters", c.path))),
    h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Animations"),
      player.el),
    // Standing in the world? Then the map showing roughly where.
    npcMapPanel(c),
    // The character's OWN sound events — their jump/fall voice today — with
    // the same cards, engine and admin features as the Sound Effects page.
    entitySoundsCard("characters", c),
    storyCard({ label: heroStoryTitle(c), art: refPic(c), name: c.name, paras: c.loreStory, related: c.loreRelated }));   // always last
}

/* --- tiles --- */
/* ------------------------------------------------------- WORLD (Tiles 3.0)
 * The ground system replacing tiles2. He reviews CANDIDATES: for each "A over
 * B" pair the tiles agent offers two or three generations, ranked by a
 * measured wall score, and asks which one to keep.
 *
 * The page is built around that question and nothing else. Every number on it
 * is the AGENT'S OWN measurement (wiki/build.mjs buildWorld) — the wiki never
 * scores a tile itself, or the two would drift and his verdict would be about
 * a ranking nobody else can reproduce.
 */
const worldCells = () => state.data.domains.world ?? [];
const worldMeta = () => state.data.worldMeta ?? {};
/* ---- THE GROUND TYPE IS A PAGE (maintainer 2026-08-21) ----
 * "World has Ground types. A Ground type has: Base tiles (can be 1, several or
 * a single color), On top of, Transitions ... I should be able to promote a
 * tile to be the base tile and also revoke that title. The page should show
 * the ground types base color ... and the ground tiles color palette."
 *
 * BASE TILES ARE A LIVE DESIGNATION, not manifest data: the Game Master
 * promotes and revokes; the tiles agent and the world agent consume. One entry
 * per tile key in tuning/base_tiles (pixel-wiki-base-tiles@1), carrying the
 * ground type it is the base OF — the key alone names a PAIR, and it is the
 * pair's TOP that the base tile paints.
 */
const BASE_KEY = "tuning/base_tiles";
const baseTilesDoc = () => state.tuning.base_tiles
  ?? (state.tuning.base_tiles = { format: "pixel-wiki-base-tiles@1", updated_at: "", overrides: {} });
const isBaseTile = (key) => !!baseTilesDoc().overrides?.[key];
/* ---- BASE TILE SETS — THE GROUND'S LOOK, AS HE CONFIGURES IT -------------
 * Maintainer 2026-08-25, replacing both the old single "base tile" and the
 * hardcoded per-material texture rules:
 *
 *   "Each ground type have a list of base tile sets. A base tile set is a list
 *   of tiles that look extremely good when used togather ... should also
 *   specify how likley (the weight/chance) tile_1 is to be used VS tile_2 ...
 *   In every base tile set the set can add a weight for how likley the
 *   clean/plain color should be used. Setting this to 0% will always draw with
 *   texture. Setting this to 100% will always draw a clean tile."
 *
 *   "Why do each tile type have several base tile sets? Because on one side of
 *   the world we can make the grass look different, but still look nice vs
 *   another side of the world. And the world-agent will always stick to a
 *   single base tile set at one location so it will always look good."
 *
 * SET 0 IS RESERVED. It is named Clean, holds nothing but the clean member, and
 * is never deleted — "all tile types always have a default Set #0 that is
 * special and can only contain 100% the clean/plain base color. How I get the
 * map-agent to never use that default set is to set the likleyness for this set
 * being used to 0%." Switching a set off by weight rather than deleting it also
 * guarantees every ground has one set that can still draw.
 *
 * IDS ARE STABLE AND NEVER RENUMBERED. A deleted set leaves a hole on purpose:
 * renumbering would repaint regions nobody touched, and the display name is
 * "<name> #<id>" — the number he reads is the identity, not the position.
 *
 * WEIGHTS ARE RAW NUMBERS, SHOWN AS PERCENTAGES. Percent is how he stated the
 * model; raw weights are what survives editing, because storing percentages
 * would silently rescale every other row each time he adds a tile.
 *
 * THE POOL IS tiles/base_candidates/, NOT the x-over-y review tiles. Those have
 * deliberately flat tops (palette.json flat_top) — they are wall showcases, and
 * picking a base tile from them asks him to judge a surface he is not being
 * shown ("the tile show a clean color top so I can't see the art under").
 *
 * Storage: live/tuning/base_tile_sets.json, bucket `grounds`, one entry per
 * ground type. Schema and the deterministic pick: wiki/lib/basesets.mjs.
 */
const SETS_KEY = "tuning/base_tile_sets";
const CLEAN_SET = 0;
const setsDoc = () => state.tuning.base_tile_sets
  ?? (state.tuning.base_tile_sets = { format: "pixel-wiki-base-tile-sets@1", updated_at: "", grounds: {} });
/* EVERY CANDIDATE THIS GROUND'S SETS MAY DRAW FROM — its PLATES first, then
 * the textured ballot.
 *
 * The ballot alone was the pool until 2026-08-27, and it exists for only five
 * grounds: on the other ten "+ Add tiles…" rendered disabled and did nothing
 * when pressed, which is exactly what the maintainer hit on Brown Paving
 * Stone. The tiles agent's plates/index.json states the real rule — "ground
 * G's pool is every approved candidate of every G__over__* cell" — and ships
 * it for all fifteen: 210 for paving where the ballot had none.
 *
 * A plate is also the better preview: it is the ground's own approved art
 * already conformed to transition geometry with the ground's OWN wall, so a
 * field of plates is literally what the game will draw. Its id is the review
 * key the tiles agent asks set members to carry, which resolves to the plate
 * by pure string with no lookup.
 *
 * The ballot stays, appended: its tiles are the pure corners of generated
 * transition sets — a different source, not duplicates — and they are the
 * grass he called insanely good. Nothing that was pickable stops being
 * pickable. */
function basePool(typeId) {
  const plates = patternLib()?.plates[typeId]?.pool ?? [];
  /* THE TOP-ONLY POOL LEADS (maintainer 2026-08-27: "The tiles generated now
   * is candidates for being 'details' tile or a 'base tile'. So you should
   * include this new set when I scroll over details tiles or base set tiles
   * that has not been rejected").
   *
   * Generated with the wall and overhang explicitly meaningless, so every one
   * of them is a ground surface and nothing else — which is exactly what a
   * base tile is judged on, and why these need no textured pass: there was
   * never a flattened top to undo. They lead because they are the pool built
   * FOR this decision; plates and ballot tiles follow as what came before.
   *
   * REJECTED ONES ARE NOT CANDIDATES, his words. A top-only tile has no review
   * cell, so its verdict rides the same feedback file keyed by its own path. */
  const tops = (worldMeta().tops?.[typeId] ?? [])
    .filter((c) => fb("tiles", c.id).status !== "rejected")
    /* THE PUBLISHED POST PASS, NOT MY BROWSER'S GUESS (tiles agent, blocking,
     * 2026-08-27: "the tops AUDITION is rendering the RAW pass, not post/").
     *
     * The sheets ship in the generator's own colour, and while no better pass
     * existed the audition corrected them in-browser (ppPath). There is one
     * now, and it is better than the approximation: the whole tile is
     * translated so its background lands exactly on the ground's clean
     * colour, which keeps every detail's own colour instead of dragging it
     * toward the anchor. Measured on the tile he was auditioning — black_rock
     * sheet_00_subtle tile_11 — the raw top face is 41 RGB off that colour
     * and the post file is 0.
     *
     * I MEASURED IT WRONG FIRST and nearly pushed back: over the WHOLE tile
     * raw reads closer than post. These are top-only tiles whose index says
     * `wall_is_meaningless`, so the whole tile is the wrong region — on the
     * top face, the only part anyone judges, the published pass wins outright.
     *
     * The identity stays the RAW path (his verdicts are keyed by it, and the
     * post file is a rendering of the same tile), and ppPath remains the
     * fallback for anything not yet republished. */
    .map((c) => ({
      id: c.id,
      art: c.post ?? ppPath(typeId, c.art),
      raw: c.art,
      from: null, flat: c.flat ?? 0, flavour: c.flavour, colours: c.colours,
      misfit: c.misfit, topOnly: true,
    }));
  const all = [
    ...tops,
    ...plates.map(([k, cell, flat]) => {
      const key = `tiles/${cell}/${k}`;
      // The plate stays the identity and the game's own geometry; what is
      // SHOWN is the textured pass where one exists.
      return { id: key, art: displayArt(key, null) ?? `tiles/plates/${typeId}/${k}.webp`, from: cell, flat: flat ?? 1 };
    }),
    ...((worldMeta().basePools ?? {})[typeId] ?? []).map((c) => ({ ...c, flat: c.flat ?? 0 })),
  ];
  /* EVERYTHING APPROVED IS OFFERED, most textured first (maintainer
   * 2026-08-27: "all accepted tiles for brown paving stone over x should be a
   * candidate here. So why do you try to make the button disabled in the
   * first place?"). An earlier build FILTERED tops >=90% one tone out of the
   * pool, which was a taste call that is his to make in the audition, not
   * mine to make in a build script. The measurement survives as the sort key
   * and a pill — the flat tops are all there, after the ones with something
   * to look at. */
  /* A TILE HE REJECTED IN REVIEW IS NOT A CANDIDATE (maintainer 2026-08-27:
   * "The only tops I don't want in this list is tiles I have rejected as a
   * x over y/x..."). The plates roster is approved-only already — a rejected
   * key has no plate — but a rejection made THIS session must drop now, not
   * on the tiles agent's next republish. */
  return all
    .filter((c) => !/^tiles\//.test(c.id) || fb("tiles", c.id).status !== "rejected")
    /* Top-only tiles lead — they are the pool he asked for, and the only one
     * where a flat reading is a property of the ART rather than of a
     * postprocess that flattened it. SUBTLE FIRST among them: the tiles agent
     * generated three subtle sheets per ground precisely because those are
     * the ones that survive being repeated across a field, which is what a
     * base tile set does. Detail sheets are the once-in-a-while showpieces and
     * follow; sorting them first by texture put the loudest tiles at the top
     * of the list a field is built from. Nothing is hidden — the flavour is in
     * every row's label, so he can still take a detail tile if he wants one. */
    .sort((a, b) => {
      if (a.topOnly !== b.topOnly) return a.topOnly ? -1 : 1;
      if (a.topOnly && a.flavour !== b.flavour) return a.flavour === "subtle" ? -1 : 1;
      return (a.flat ?? 1) - (b.flat ?? 1);
    });
}
const TOP_FLAT = 0.9;    // >= this share of one tone reads as a flat top
/* A MEMBER MAY COME FROM EITHER POOL. The ballot is the right one to pick from
 * and the one the picker offers — but he can also promote a tile straight from
 * an x-over-y review card, and that decision predates this model and should
 * keep working. Ballot ids (<pair>__<variant>) and review keys (tiles/<cell>/
 * <sha1>) cannot collide, so one lookup can serve both. */
/* EVERY REVIEW CANDIDATE BY KEY, built once. The audition resolves up to 471
 * candidates per ground and the old lookup scanned every cell for each one. */
let CAND_BY_KEY = null, CAND_BY_KEY_N = -1;
function candByKey(key) {
  const cells = worldCells();
  if (!CAND_BY_KEY || CAND_BY_KEY_N !== cells.length) {
    CAND_BY_KEY = new Map();
    CAND_BY_KEY_N = cells.length;
    for (const c of cells) for (const cand of c.candidates) CAND_BY_KEY.set(cand.key, cand);
  }
  return CAND_BY_KEY.get(key) ?? null;
}
/* THE TEXTURED PASS IS WHAT A BASE TILE LOOKS LIKE (tiles agent, 2026-08-27:
 * "the Add-to-Set audition still renders entry.after, so every clean-top
 * ground auditions as flat colour and he cannot judge set membership at all").
 *
 * `after` is the pass whose top the postprocess flattens, and a base tile is
 * judged ENTIRELY on its top — so the audition was showing the one thing it
 * exists to hide. Their `textured` pass is the after tile with the raw top
 * substituted against the ground's palette, relief intact. Plates carry the
 * same flat top, because they were conformed from `after`, so the preference
 * has to be applied to the PLATE POOL too and not only to review art. */
const displayArt = (key, fallback) => candByKey(key)?.tex ?? fallback ?? candByKey(key)?.art ?? null;
function memberArt(typeId, id) {
  /* A TOPS MEMBER DRAWS THE PUBLISHED POST PASS, exactly as the audition does
   * (maintainer 2026-08-28, on a Set #2 field glowing beside its clean ring:
   * "Why is this ground so bright? Didn't you normalize all tile tops to fit
   * togather?"). The art IS normalized — measured on his tile, the raw sheet's
   * top is V 160 against the palette's 125 and the post file is 121 — but this
   * branch predated the post pass and still routed set members through ppPath,
   * the in-browser guess the audition retired. So the same tile drew corrected
   * in the audition centre and raw-bright in the set field and every ring
   * around it: one tile, two colours, depending on which code path looked.
   * The pool entry is the single source now; ppPath stays only for a sheet
   * not yet republished. */
  if (/^tiles\/tops\//.test(id ?? "")) {
    const t = (worldMeta().tops?.[typeId] ?? []).find((c) => c.id === id);
    return t?.post ?? ppPath(typeId, id);
  }
  const p = basePool(typeId).find((c) => c.id === id);
  if (p) return p.art;
  const cand = candByKey(id);
  return cand ? (cand.tex ?? cand.art) : null;
}

/* THE SETS OF ONE GROUND, normalised: Clean #0 always present, ids ascending,
 * weights clamped non-negative, exactly one clean member per set. A ground with
 * no entry still gets Clean — the model has no "no sets" state, which is what
 * lets every caller render without a special case. Mirrors setsFor() in
 * wiki/lib/basesets.mjs; check-basesets.mjs proves the two agree. */
/* Memoised per (ground, doc revision): every write path stamps updated_at, so
 * the cache can never serve a set list older than the document — and a row
 * shell asking for the members costs a Map hit instead of a re-normalisation
 * of every member through memberArt. */
const SETS_CACHE = new Map();              // typeId -> { rev, sets }
function groundSets(typeId) {
  const rev = `${setsDoc().updated_at}|${(setsDoc().grounds?.[typeId]?.sets ?? []).length}`;
  const hit = SETS_CACHE.get(typeId);
  if (hit && hit.rev === rev) return hit.sets;
  const sets = groundSetsUncached(typeId);
  SETS_CACHE.set(typeId, { rev, sets });
  return sets;
}
function groundSetsUncached(typeId) {
  const raw = setsDoc().grounds?.[typeId]?.sets;
  const list = Array.isArray(raw) ? raw.slice() : [];
  if (!list.some((s) => s && s.id === CLEAN_SET)) {
    list.unshift({ id: CLEAN_SET, name: "Clean", weight: 1, members: [{ kind: "clean", weight: 1 }] });
  }
  return list
    .filter((s) => s && Number.isInteger(s.id) && s.id >= 0)
    .sort((a, b) => a.id - b.id)
    .map((s) => {
      const src = Array.isArray(s.members) ? s.members : [];
      const tiles = s.id === CLEAN_SET ? [] : src
        .filter((m) => m?.kind === "tile" && m.id)
        // `gone` rather than dropped: a candidate the tiles agent regenerated
        // away must be VISIBLE as a hole he can clear, not silently vanish and
        // leave a set whose percentages no longer add up to what he set.
        .map((m) => ({ id: m.id, art: memberArt(typeId, m.id) ?? m.tile ?? null, gone: !memberArt(typeId, m.id), weight: Math.max(0, Number(m.weight) || 0) }));
      const cm = src.find((m) => m?.kind === "clean");
      return {
        id: s.id,
        name: typeof s.name === "string" && s.name ? s.name : s.id === CLEAN_SET ? "Clean" : "Set",
        weight: Math.max(0, Number(s.weight) || 0),
        clean: cm ? Math.max(0, Number(cm.weight) || 0) : (tiles.length ? 0 : 1),
        members: tiles,
        /* PER-SET REJECTIONS (maintainer 2026-08-27: "rejecting a tile not
         * being good enough for Base Tile Set #1 doesn't mean the tile is not
         * good enough to be part of Base Tile Set #2"). A verdict about THIS
         * set, so it lives on the set — the audition skips these and he never
         * reviews the same top twice for the same set. */
        rejected: (Array.isArray(s.rejected) ? s.rejected : []).filter((x) => typeof x === "string"),
      };
    });
}
/** "Clean #0", "Set #1", "Meadow #2" — the number is the identity he reads. */
const setLabel = (s) => `${s.name} #${s.id}`;
/* WHAT A MEMBER IS, in words. Raw ids read as machine noise on a phone —
 * "tiles/brown_paving_stone__over__black_rock/3fd89e73" tells him nothing he
 * wants at a glance. What identifies a base tile to him is the WALL it was
 * generated over (that is what makes two tops of one ground differ) and a
 * short handle to tell twins apart. */
function memberLabel(typeId, id) {
  // A top-only tile names its flavour and its sheet — there is no wall to name
  // it by, which is the whole point of that pool.
  const to = /^tiles\/tops\/[^/]+\/sheet_(\d+)_(\w+?)_\d+\/tile_(\d+)\.webp$/.exec(id ?? "");
  if (to) return `${to[2]} top · sheet ${to[1]} · ${to[3]}`;
  const rk = /^tiles\/([^/]+)__over__([^/]+)\/([0-9a-f]{8})$/.exec(id ?? "");
  if (rk) return `over ${typeLabelWorld(rk[2]).toLowerCase()} · ${rk[3]}`;
  const bal = /^(.+)__to__(.+)__(a\d+_s\d+)$/.exec(id ?? "");
  if (bal) {
    const other = bal[1] === typeId ? bal[2] : bal[1];
    return `edge with ${typeLabelWorld(other).toLowerCase()} · ${bal[3]}`;
  }
  return String(id ?? "");
}
/** Every set of this ground that holds this candidate. A tile may sit in more
 *  than one — the same grass can belong to both a meadow and a lawn. */
const setsWith = (typeId, id) => groundSets(typeId).filter((x) => x.members.some((m) => m.id === id));
/** A set can draw a picture only if something in it has weight. */
const setDraws = (s) => s.clean > 0 || s.members.some((m) => m.weight > 0 && m.art);
/** Percent shares for a row of weights, which is what he set them in. */
function shareOf(weights) {
  const total = weights.reduce((n, w) => n + (w > 0 ? w : 0), 0);
  return total > 0 ? weights.map((w) => (w > 0 ? w : 0) / total) : weights.map(() => 0);
}
/* Not `pct` — that name belongs to the drop-chance formatter at the top of
 * this file, which takes a 1-in-N chance, not a share. */
const sharePct = (x) => `${Math.round(x * 100)}%`;

/* WRITE ONE GROUND. The save is a per-ground delta, so a set edit on grass can
 * never overwrite a set edit on snow — even from another tab. */
function writeSets(typeId, sets) {
  const doc = setsDoc();
  doc.grounds ??= {};
  doc.grounds[typeId] = {
    sets: sets.map((s) => ({
      id: s.id, name: s.name, weight: s.weight,
      ...(s.rejected?.length ? { rejected: s.rejected } : {}),
      members: [{ kind: "clean", weight: s.clean },
        /* `tile` is the REVIEW KEY when the member is one (tiles/<cell>/<key8>)
         * — the tiles agent's plates resolve maps it to a plate by pure string
         * (plates/index.json `expects`). A ballot member has no review key, so
         * its art path stands: its file IS transition geometry and serves as
         * its own plate, alpha verified byte-identical to the silhouette. */
        ...s.members.map((m) => ({ kind: "tile", id: m.id, tile: /^tiles\/[^/]+\/[0-9a-f]{8}$/.test(m.id ?? "") ? m.id : m.art, weight: m.weight }))],
    })),
  };
  doc.updated_at = new Date().toISOString();
  touch(SETS_KEY, typeId);
  markDirty(SETS_KEY);
}
const editSets = (typeId, fn) => { const s = groundSets(typeId); fn(s); writeSets(typeId, s); };
/** Lowest unused id, never reusing one that is merely hidden — see the note on
 *  stable ids. Starts at 1 because 0 belongs to Clean. */
const nextSetId = (typeId) => {
  const used = new Set(groundSets(typeId).map((s) => s.id));
  for (let i = 1; ; i++) if (!used.has(i)) return i;
};
function addSet(typeId) {
  const id = nextSetId(typeId);
  editSets(typeId, (sets) => sets.push({ id, name: "Set", weight: 1, clean: 0, members: [] }));
  return id;
}
function deleteSet(typeId, id) {
  if (id === CLEAN_SET) return;                       // Clean is switched off, never deleted
  editSets(typeId, (sets) => { const i = sets.findIndex((s) => s.id === id); if (i >= 0) sets.splice(i, 1); });
}
const renameSet = (typeId, id, name) =>
  editSets(typeId, (sets) => { const s = sets.find((x) => x.id === id); if (s) s.name = String(name ?? "").trim().slice(0, 24) || "Set"; });
const setSetWeight = (typeId, id, w) =>
  editSets(typeId, (sets) => { const s = sets.find((x) => x.id === id); if (s) s.weight = clampWeight(w); });
const setCleanWeight = (typeId, id, w) =>
  editSets(typeId, (sets) => { const s = sets.find((x) => x.id === id); if (s && s.id !== CLEAN_SET) s.clean = clampWeight(w); });
function addSetMember(typeId, id, candId) {
  editSets(typeId, (sets) => {
    const s = sets.find((x) => x.id === id);
    if (!s || s.id === CLEAN_SET || s.members.some((m) => m.id === candId)) return;
    s.members.push({ id: candId, art: memberArt(typeId, candId), gone: false, weight: 1 });
  });
}
/* Not good enough for THIS set — and only this set. */
const rejectForSet = (typeId, id, candId, on) =>
  editSets(typeId, (sets) => {
    const s2 = sets.find((x) => x.id === id);
    if (!s2) return;
    s2.rejected = (s2.rejected ?? []).filter((x) => x !== candId);
    if (on) s2.rejected.push(candId);
  });
const removeSetMember = (typeId, id, candId) =>
  editSets(typeId, (sets) => { const s = sets.find((x) => x.id === id); if (s) s.members = s.members.filter((m) => m.id !== candId); });
const setMemberWeight = (typeId, id, candId, w) =>
  editSets(typeId, (sets) => { const m = sets.find((x) => x.id === id)?.members.find((y) => y.id === candId); if (m) m.weight = clampWeight(w); });
/* 0 IS A LEGAL WEIGHT AND MUST STAY ONE — it is how he says "never", both for a
 * set ("the weight for using this set is 0") and for the clean member ("Setting
 * this to 0% will always draw with texture"). The old base-tile weight clamped
 * to a 0.1 floor, which quietly made "never" impossible to express. */
const clampWeight = (w) => Math.max(0, Math.min(100, +(+w).toFixed(2) || 0));
/* ---- THE SET EDITOR — the Base tab, rebuilt around sets ------------------
 * "The wiki will be responsible to both rework the wiki itself so I can see and
 * manage all base tile sets for every tile type" (maintainer 2026-08-25).
 *
 * A FIELD PREVIEW IS THE ONLY HONEST PICTURE of a set, and it is drawn with the
 * REAL pick — the same FNV-1a over (set id, x, y) the game uses — so what he
 * approves here is literally the ground he will walk on. Randomize therefore
 * moves the ORIGIN rather than reseeding a toy RNG: every roll is a different
 * real patch of the world, never a patch that could not occur. ("A great tile
 * repeated is still repetition", and a group is good when every roll looks like
 * the same ground.)
 */
const setOrigins = new Map();          // "type/set" -> [x0, y0] for Randomize
/* Ported from wiki/lib/basesets.mjs, which is the spec the game and the tiles
 * agent port too; check-basesets.mjs proves this copy still agrees with it. */
function fnv1a(str) {
  let x = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i) & 0xff; x = Math.imul(x, 0x01000193) >>> 0; }
  /* fmix32 — WITHOUT IT THE GROUND STRIPES. FNV-1a's last byte reaches only the
   * low bits while h/2^32 reads the high ones, and our keys end in the
   * coordinate that varies, so consecutive rows drew the same tile: measured
   * 89.2% against a 14.3% chance, runs of 50 down a column. See the reasoning
   * in wiki/lib/basesets.mjs, which this copy must match to the bit. */
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}
const unitHash = (s) => fnv1a(s) / 4294967296;
function pickWeighted(weights, u) {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (!(total > 0)) return -1;
  let acc = 0;
  const target = u * total;
  for (let i = 0; i < weights.length; i++) { acc += weights[i] > 0 ? weights[i] : 0; if (target < acc) return i; }
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return -1;
}
/* THE CLEAN MEMBER HAS REAL ART, and it is the ground's own x-over-x tile.
 * That tile's top is flat by design ("a clean flat top is the default for every
 * material", palette.json flat_top) — it IS what the game paints today wherever
 * no set is used, so drawing the clean member with it is not an illustration of
 * the clean colour, it is the clean colour's tile. Drawing it as a flat CSS fill
 * instead would put a rectangle behind a field of diamonds. */
function cleanArtOf(typeId) {
  /* THE PLATE FILE ITSELF, never a browser composite (maintainer 2026-08-28,
   * on Grey Paving Stone's Clean #0 drawing a fully textured field: "Why is
   * the base tile page not showing a single color grey plain top on Clean
   * #0?"). The old sub:<after>::<clean> composite was CORRECT — my probe
   * composed it flat, both inputs answered 200 with CORS at his exact pinned
   * sha — but it depended on getImageData, and a canvas his phone taints
   * (a cached no-CORS image entry is enough) throws there, and the fallback
   * for an unbuildable composite is the plain after tile: textured, for
   * paving, across every cell and the ring at once. A composite whose
   * failure mode is exactly the bug it exists to fix cannot be the clean
   * tile's source.
   *
   * tiles/plates/<g>/clean.webp IS the clean tile — flat top landed
   * integer-exactly on the palette colour, the ground's OWN wall, published
   * by the tiles agent for every ground — and a plain file cannot taint,
   * cannot half-fail, and costs one load instead of two plus a readback.
   * isoScene foot-centres its 64x46 geometry beside 64x64 review tiles. The
   * composite remains only for a ground without plates. */
  const plate = patternLib()?.plates[typeId]?.clean;
  if (plate) return plate;
  return xoverxArt(typeId);
}
/* THE GROUND'S OWN x-OVER-x TILE — the only WALL that was ever art. Approved
 * first, first otherwise; null for a ground with no self pair. The transition
 * page dresses each side's plate in this wall (maintainer 2026-08-28), while
 * the top stays whatever the pass chose. */
function xoverxArt(typeId) {
  const own = worldCells().find((c) => c.top === typeId && c.side === typeId);
  if (!own) return null;
  return (own.candidates.find((x) => fb("tiles", x.key).status === "approved") ?? own.candidates[0])?.art ?? null;
}
/* ---- THE BEST WALL FOR A TOP (maintainer 2026-08-28: "There might be
 * several x over x tiles to help with the wall and we should pick the tile
 * that is closest in color and shape vs the top only-tile ... you should not
 * just pick 'the first' x over x - you should pick the BEST") ----
 *
 * The build measures every x-over-x candidate's TEXTURED top (wallPools) and
 * every face the wiki dresses — top-only tiles and x-over-y candidates alike
 * — with the same ruler: mean top-face RGB, dominant share, distinct
 * colours. The pick is the argmin of colour distance plus a structure term;
 * his stepper override outranks it, stored per face key in
 * live/tuning/top_walls.json (agreeing with the auto pick DELETES the
 * override, the scenery-walls rule). */
const TOPWALL_KEY = "tuning/top_walls";
const topWallsDoc = () => state.tuning.top_walls
  ?? (state.tuning.top_walls = { format: "pixel-wiki-top-walls@1", updated_at: "", overrides: {} });
function setTopWall(faceKey, candKey) {
  const doc = topWallsDoc();
  doc.overrides ??= {};
  if (candKey == null) delete doc.overrides[faceKey];
  else doc.overrides[faceKey] = { wall: candKey, updated_at: new Date().toISOString() };
  doc.updated_at = new Date().toISOString();
  touch(TOPWALL_KEY, faceKey);
  markDirty(TOPWALL_KEY);
}
/** The ground's x-over-x candidates, rejected ones out, approved first. */
function wallPool(typeId) {
  const pool = worldMeta().wallPools?.[typeId] ?? [];
  const st = (k) => fb("tiles", k).status;
  const keep = pool.filter((c) => st(c.key) !== "rejected");
  return [...keep.filter((c) => st(c.key) === "approved"), ...keep.filter((c) => st(c.key) !== "approved")];
}
/* Face -> {stats, key}: tops by id/art/post, world candidates by key/art/tex.
 * Rebuilt when the manifest or data refreshes. */
let FACE_LOOKUP = null;
function faceLookup() {
  const rev = `${worldMeta() === FACE_LOOKUP?.meta ? 1 : 0}|${worldCells().length}`;
  if (FACE_LOOKUP && FACE_LOOKUP.rev === rev && FACE_LOOKUP.meta === worldMeta()) return FACE_LOOKUP;
  const stats = new Map(), keys = new Map();
  for (const list of Object.values(worldMeta().tops ?? {})) {
    for (const t of list) {
      const st = t.m ? { m: t.m, flat: t.tflat ?? t.flat ?? 0.5, k: t.tk ?? 6 } : null;
      for (const ref of [t.id, t.art, t.post]) if (ref) { if (st) stats.set(ref, st); keys.set(ref, t.id); }
    }
  }
  for (const c of worldCells()) {
    for (const cand of c.candidates ?? []) {
      const st = cand.tm ? { m: cand.tm, flat: cand.tflat ?? 0.5, k: cand.tk ?? 6 } : null;
      for (const ref of [cand.key, cand.art, cand.tex]) if (ref) { if (st) stats.set(ref, st); keys.set(ref, cand.key); }
    }
  }
  FACE_LOOKUP = { rev, meta: worldMeta(), stats, keys };
  return FACE_LOOKUP;
}
/** The world candidate a face path or key belongs to — for the fields the
 *  tile itself publishes (top_only, own_top, borrow_wall). */
function faceCandOf(ref) {
  const key = faceLookup().keys.get(ref) ?? ref;
  for (const c of worldCells()) {
    const hit = (c.candidates ?? []).find((x) => x.key === key);
    if (hit) return hit;
  }
  return null;
}
const faceRefOf = (face) => {
  const f = String(face ?? "");
  if (f.startsWith("pp:")) return f.slice(3).split("::")[0];
  if (f.startsWith("sub:") || f.startsWith("tex:")) return f.slice(4).split("::")[0];
  return face;
};
let BW_CACHE = { rev: "", map: new Map() };
/** The wall to dress `face` in: his override, else the measured best, else
 *  the pool's first (approved-first — the old rule, now the fallback). */
function bestWall(typeId, face, { ignoreOverride = false } = {}) {
  const rev = `${topWallsDoc().updated_at}|${state.feedback.tiles?.updated_at ?? ""}`;
  if (BW_CACHE.rev !== rev) BW_CACHE = { rev, map: new Map() };
  const ck = `${typeId}|${face}|${ignoreOverride ? 1 : 0}`;
  if (BW_CACHE.map.has(ck)) return BW_CACHE.map.get(ck);
  let pool = wallPool(typeId);
  const { stats, keys } = faceLookup();
  const ref = faceRefOf(face);
  const fkey0 = keys.get(ref) ?? ref;
  /* NEVER THE TILE'S OWN WALL (maintainer 2026-08-28: "I still don't
   * understand how the find-the-best-wall feature work if I select top
   * only"). It did not, on x-over-x pages: a tile's measured closest wall is
   * usually ITSELF, and top-only means exactly "this tile's own wall is
   * bad" — so the self-match handed back the wall he had just rejected and
   * the mark changed nothing on screen. The tile is out of its own pool. */
  const filtered = pool.filter((c) => c.key !== fkey0);
  if (filtered.length) pool = filtered;
  let out;
  if (!pool.length) out = { art: xoverxArt(typeId), key: null, i: -1, n: 0, auto: true, fkey: null };
  else {
    const fkey = fkey0;
    /* HIS OVERRIDE, THEN THE TILE'S OWN PUBLISHED PICK, THEN THE MEASUREMENT
     * (2026-08-29). The tiles agent resolves borrow_wall on the candidate
     * itself now (tiles3/review@3, after the games agent asked for one
     * source), and that is what the GAME reads — so reading it here keeps the
     * two identical by construction instead of by two implementations of one
     * formula agreeing. */
    const pub = faceCandOf(ref)?.borrowWall ?? null;
    const ov = (ignoreOverride ? null : topWallsDoc().overrides?.[fkey]?.wall) ?? pub;
    let i = ov ? pool.findIndex((c) => c.key === ov) : -1;
    const auto = i < 0;
    if (i < 0) {
      i = 0;
      const fst = stats.get(ref);
      if (fst?.m) {
        let bd = Infinity;
        pool.forEach((c, n2) => {
          if (!c.m) return;
          const d = Math.hypot(c.m[0] - fst.m[0], c.m[1] - fst.m[1], c.m[2] - fst.m[2]) / 441
            + 0.35 * Math.abs((c.flat ?? 0.5) - fst.flat)
            + 0.25 * Math.abs((c.k ?? 6) - fst.k) / 24;
          if (d < bd) { bd = d; i = n2; }
        });
      }
    }
    out = { art: pool[i].art, key: pool[i].key, i, n: pool.length, auto, fkey, pool };
  }
  BW_CACHE.map.set(ck, out);
  return out;
}
/** ‹ #i/N › — step through the ground's x-over-x walls for this face.
 *  Stepping onto the measured best DELETES the override (absent = auto). */
function wallStepper(typeId, face, onchange) {
  const cur2 = bestWall(typeId, face);
  const auto2 = bestWall(typeId, face, { ignoreOverride: true });
  const pool = cur2.pool ?? [];
  if (!state.admin || pool.length < 2) return null;
  const put = (idx) => {
    const i2 = (idx + pool.length) % pool.length;
    setTopWall(cur2.fkey, i2 === auto2.i ? null : pool[i2].key);
    onchange?.();
  };
  return h("div", { class: "card-sub wall-step" },
    h("span", { class: "muted" }, "Wall"),
    h("button", { class: "ghost-btn", title: "The previous x-over-x wall for this tile", onclick: (e) => { e.stopPropagation(); put(cur2.i - 1); } }, "‹"),
    h("span", { class: "muted mono" }, `#${cur2.i + 1}/${cur2.n}`),
    h("button", { class: "ghost-btn", title: "The next x-over-x wall for this tile", onclick: (e) => { e.stopPropagation(); put(cur2.i + 1); } }, "›"),
    cur2.auto
      ? h("span", { class: "pill", title: "Picked as the closest x-over-x in colour and structure. Step to another and your choice is stored instead." }, "auto · best match")
      : h("span", { class: "pill ok", title: "Your stored choice — stepping back onto the measured best clears it." }, "your pick"));
}
/** What fills cell (x,y) of a set: a member's art, or the ground's clean tile. */
function setCellArt(set, x, y, typeId) {
  const clean = typeId ? cleanArtOf(typeId) : null;
  const rows = [{ art: clean, weight: set.clean }, ...set.members.map((m) => ({ art: m.art, weight: m.art ? m.weight : 0 }))];
  const i = pickWeighted(rows.map((r) => r.weight), unitHash(`bts1|tile|${set.id}|${x}|${y}`));
  return i < 0 ? clean : rows[i].art;
}
/** A field of this set, drawn as the game would draw it from origin [x0,y0]. */
/* THE FIELD WEARS A RING OF THE GROUND'S OWN CLEAN TILE (maintainer
 * 2026-08-27, on a Set #1 whose front edge showed lava: "the base should be
 * all about the TOP ... This is just so I don't have to see the wall when I
 * preview a base tile that has nothing with wall todo. So lets make this 5x5
 * preview 7x7 instead so you can surround it with a 100% clean single color
 * top from x over x").
 *
 * The walls he saw are real: a member's art is its source cell's tile, and
 * brown paving's pool spans fifteen source cells, so the FRONT ROW of a bare
 * field shows whatever walls those members happened to be generated over. In
 * the iso stack every tile's wall is covered by the tile in front of it, so
 * one ring of the ground's own clean x-over-x tile hides every member wall
 * and the only walls on screen are the ground's own — exactly the "nothing
 * with wall todo" he asked for. The ring is presentation: cell coordinates
 * and the deterministic pick are unmoved, so the same origin still shows the
 * same patch. */
function setField(typeId, set, n, origin, scale = 1) {
  const box = h("div", { class: "iso-stage checker group-stage stage-clip" });
  const [x0, y0] = origin;
  const ring = cleanArtOf(typeId);
  const cells = [];
  for (let r = 0; r < n + 2; r++) for (let c = 0; c < n + 2; c++) {
    const edge = r === 0 || c === 0 || r === n + 1 || c === n + 1;
    cells.push({ c, r, img: edge ? ring : setCellArt(set, x0 + c - 1, y0 + r - 1, typeId) });
  }
  const paths = [...new Set(cells.map((x) => x.img).filter(Boolean))];
  if (!paths.length) { box.append(h("p", { class: "muted" }, "no art to draw this ground with")); return box; }
  loadImages(paths, (images) => box.replaceChildren(isoScene(cells.filter((x) => x.img), images, scale, 4, worldIso())));
  // Gate probe: which art each cell drew, so "the ring is clean" is checkable
  // without reverse-engineering pixels.
  box.dataset.field = JSON.stringify({ n: n + 2, ringClean: cells.filter((x) => x.img === ring && x.img).length });
  return box;
}
/* ---- LOOK AT ONE TILE CLOSELY (maintainer 2026-08-27) -------------------
 * "It would be awesome if I can click on a tile in a 'base tile list' to open
 * a dialog that shows that tile in x2. This makes it easy for me to find that
 * tile that makes a clear repeated pattern (can be hard when not able to look
 * at a given tile zoomed in)."
 *
 * WHAT HE IS ACTUALLY HUNTING is not the tile — it is the tile's PATTERN. A
 * set's field shows an obvious repeat and he needs to know which member causes
 * it, and one tile alone cannot answer that: a mark only reads as a pattern
 * once it lands next to itself. So the dialog shows both — the tile at the
 * zoom he asked for, and a field of that tile ALONE, which is the picture the
 * question is really about.
 *
 * 44px in a row is 0.7mm of a pixel on his phone; this opens at 2x and goes to
 * 6x, because "is that a seam or is that the art" is a per-pixel question. */
const TILE_ZOOMS = [2, 4, 6];
function openTileZoom(typeId, member) {
  document.querySelector(".tilezoom-modal")?.remove();
  const art = member?.art;
  if (!art) return;
  let z = 2;
  const solo = h("div", { class: "iso-stage checker tilezoom-solo" });
  const field = h("div", { class: "iso-stage checker group-stage" });
  const paint = () => {
    paintZoom();
    solo.replaceChildren(artNodeFor(art, "tilezoom-tile", member.id));
    solo.style.setProperty("--z", String(z));
    // A FIELD OF THIS TILE ALONE — five across, because a repeat that only
    // shows up every other tile needs more than a 3x3 to become visible.
    const cells = [];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) cells.push({ c, r, img: art });
    loadImages([art], (images) => field.replaceChildren(isoScene(cells, images, z >= 4 ? 2 : 1, 4, worldIso())));
  };
  // REBUILT ON EVERY PAINT, like the promote dialog's own pass bar: sortBar
  // renders the selection at build time, so a bar kept across a change shows
  // the chip he pressed a moment ago as unselected — the control disagreeing
  // with the picture it just changed.
  const zoomRow = h("div", { class: "player-controls" });
  const paintZoom = () => zoomRow.replaceChildren(
    h("span", { class: "muted" }, "Zoom"),
    sortBar("tilezoom", TILE_ZOOMS.map((n) => [String(n), `${n}×`, `Show the tile at ${n} times its own size`]),
      String(z), (v) => { z = +v; paint(); }, { persist: false }));
  const dlg = h("dialog", { class: "promote-modal tilezoom-modal" },
    h("div", { class: "promote-head" },
      h("b", {}, memberLabel(typeId, member.id)),
      h("button", { class: "ghost-btn", onclick: () => { dlg.close(); dlg.remove(); } }, "✕")),
    zoomRow,
    solo,
    h("p", { class: "muted" }, "The same tile five across — a mark only reads as a pattern once it sits next to itself."),
    field,
    // The way out at the bottom right, where an OK button lives — the lesson
    // the pool picker learned on 2026-08-27.
    h("div", { class: "pool-foot" },
      h("span", { class: "muted pool-tally" }, member.id),
      h("button", { class: "primary-btn pool-done", type: "button", onclick: () => { dlg.close(); dlg.remove(); } }, "Done")));
  paint();
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener("close", () => dlg.remove());
}

/* THE POOL PICKER. 161 grass candidates is too many to scroll past on a phone
 * while deciding, so it opens as a dialog over the set he is filling and closes
 * on the first pick — the decision is "does this one belong with those", which
 * is answered by the field behind it, not by the grid. */
function openPoolPicker(typeId, setId, onDone) {
  document.querySelector(".pool-modal")?.remove();
  const setNow = () => groundSets(typeId).find((s) => s.id === setId);
  const already = () => new Set(setNow()?.members.map((m) => m.id) ?? []);
  const rejectedHere = new Set(setNow()?.rejected ?? []);
  const pool = basePool(typeId).filter((c) => !already().has(c.id) && !rejectedHere.has(c.id));
  const rejectedN = rejectedHere.size;
  const setOf = () => groundSets(typeId).find((s) => s.id === setId) ?? { id: setId, name: "Set", clean: 0, members: [] };
  /* EVERY CANDIDATE IS AUDITIONED IN THE SET (maintainer 2026-08-27: "a
   * dialog/modal ... where I can scroll over lots of different tops and
   * preview them in a 7x7 tile preview, where the tile I may add is the
   * center 3x3 surrounded by a 2 border base tile set - according to how the
   * base tile set should be drawn (its weights)"). The bare-thumbnail grid
   * this replaces asked him to judge a tile alone, which is the one way a
   * base tile is never seen — the question is "does it belong with those",
   * and only the field can answer it.
   *
   * The ring is drawn with the REAL pick — setCellArt over world coordinates,
   * clean member included at its weight — so Randomize moves the ORIGIN, the
   * same rule as the set panels' "Another patch": every roll is a real patch
   * of the world as this set would paint it.
   *
   * BUILT LAZILY. 161 grass candidates x 49 cells composed up front would
   * hang the phone the dialog opens on; each field is composed when it
   * scrolls near, and a Randomize only rebuilds the ones already built. */
  let origin = [0, 0];
  let added = 0;
  /* 9x9 (maintainer 2026-08-27: "you need todo that preview 9x9 in order to
   * fit the x over x with clean wall around the current 7x7"): the centre 3x3
   * is the candidate, the 2-thick ring around it is the SET — the judgment
   * picture, unchanged — and the outermost ring is the ground's own clean
   * x-over-x tile, there only to stand in front of the set's walls. */
  const N = 9, RING = 3;
  const fieldFor = (cand) => {
    /* CLIPPED AND CENTRED, NEVER SCROLLED (maintainer 2026-08-27: "It
     * displays with 7x7, but with scroll. I want it centered without
     * scroll"). And the OUTERMOST ring is the ground's own clean x-over-x
     * tile, same rule as the set panels: a member's art carries its source
     * cell's wall — lava, ice, whatever it was generated over — and the
     * field's front edge was parading them. The candidate under judgment is
     * the 3x3 in the middle; one ring of the set around it; the clean ring
     * outside hides every foreign wall, and the clipping loses only it. */
    const box = h("div", { class: "iso-stage checker group-stage pool-stage stage-clip" });
    const set = setOf();
    const ring = cleanArtOf(typeId);
    const cells = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const edge = r === 0 || c === 0 || r === N - 1 || c === N - 1;
      const inCentre = c >= RING && c < N - RING && r >= RING && r < N - RING;
      cells.push({ c, r, img: inCentre ? cand.art : edge ? ring : setCellArt(set, origin[0] + c, origin[1] + r, typeId) });
    }
    box.dataset.field = JSON.stringify({
      n: N,
      ringClean: cells.filter((x) => (x.r === 0 || x.c === 0 || x.r === N - 1 || x.c === N - 1) && x.img === ring).length,
      centre: cells.filter((x) => x.img === cand.art).length,
    });
    loadImages([...new Set(cells.map((x) => x.img).filter(Boolean))], (images) => {
      box.replaceChildren(isoScene(cells.filter((x) => x.img), images, 1, 4, worldIso()));
    });
    return box;
  };
  const rows = new Map();               // cand.id -> its row (for rebuilds)
  const buildRow = (cand) => {
    const row = rows.get(cand.id);
    if (!row || row.dataset.built === "1") return;
    row.dataset.built = "1";
    row.querySelector(".pool-stage")?.replaceWith(fieldFor(cand));
  };
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { buildRow(pool.find((c) => c.id === e.target.dataset.cand)); seen.unobserve(e.target); }
  }, { rootMargin: "600px 0px" });
  const rowFor = (cand) => {
    const addBtn = h("button", { class: "ghost-btn pool-add", type: "button" }, `+ Add to ${setLabel(setOf())}`);
    /* THE OTHER VERDICT (maintainer 2026-08-27: "I need a reject button here
     * to not have to review the same tiles over and over again!"). Scoped to
     * THIS set — the same top stays a candidate for every other set — and
     * undoable in place, because a misthumb on a phone must not silently bury
     * a tile until someone edits a JSON file. */
    const rejBtn = h("button", { class: "ghost-btn pool-reject", type: "button", title: `Never offer this top for ${setLabel(setOf())} again — other sets still see it` }, "✕ not for this set");
    /* ADDING IS A TOGGLE, because a thumb slips (maintainer 2026-08-27: "I
     * missclicked and clicked + Add to Set #1. Now I'm unable to click -
     * Remove from Set #1. All I can do is cancel everything and start all
     * over").
     *
     * It used to disable itself on the way in, so one wrong tap could only be
     * undone by discarding every other decision in the sitting — the reject
     * button had been given an undo for exactly this reason and the add
     * button had not. The verdict is not a commitment until Commit, so the
     * dialog must let it be taken back in place. */
    const paintAdd = () => {
      const inSet = !!setNow()?.members.some((m) => m.id === cand.id);
      addBtn.replaceChildren(inSet ? `✓ in ${setLabel(setOf())} — tap to remove` : `+ Add to ${setLabel(setOf())}`);
      addBtn.title = inSet
        ? `Take it back out of ${setLabel(setOf())} — nothing is saved until you Commit`
        : `Put this top into ${setLabel(setOf())}`;
      row.classList.toggle("in-set", inSet);
      rejBtn.disabled = inSet;      // a member is not also a rejection
    };
    addBtn.onclick = () => {
      const inSet = !!setNow()?.members.some((m) => m.id === cand.id);
      if (inSet) removeSetMember(typeId, setId, cand.id);
      else addSetMember(typeId, setId, cand.id);
      added += inSet ? -1 : 1;
      paintAdd();
      retally();
    };
    rejBtn.onclick = () => {
      const on = !row.classList.contains("set-rejected");
      rejectForSet(typeId, setId, cand.id, on);
      added += on ? 1 : -1;        // a rejection is a change worth repainting for
      row.classList.toggle("set-rejected", on);
      addBtn.disabled = on;
      rejBtn.replaceChildren(on ? "↩ undo — offer it again" : "✕ not for this set");
      if (!on) paintAdd();
      retally();
    };
    const row = h("div", { class: "pool-cell", "data-cand": cand.id },
      h("div", { class: "pool-head" },
        // artNodeFor, not a bare <img>: a top-only tile's art is a pp: virtual
        // that has to be corrected onto a canvas.
        artNodeFor(cand.art, "pool-tile", cand.id),
        h("span", { class: "pool-name", title: cand.id }, memberLabel(typeId, cand.id)),
        (cand.flat ?? 0) >= TOP_FLAT ? h("span", { class: "pill", title: `The top is ${Math.round((cand.flat ?? 1) * 100)}% one tone — adding it draws close to the clean colour` }, "flat top") : null,
        /* FLAGGED, SORTED LAST, NEVER HIDDEN (tiles agent 2026-08-27: "They
         * are still written and still auditionable - SORT THEM LAST, do not
         * hide them; the maintainer may love one anyway and his verdict
         * outranks my flag"). 178 of 1,440 could not be landed on the clean
         * colour by translation alone. */
        cand.misfit ? h("span", { class: "pill warn", title: "The pass could not land this one on the ground's clean colour by moving it — its contrast was squeezed too far, or its hue sits too far off. Shown last, because you may still want it." }, "off-colour") : null,
        addBtn, rejBtn),
      h("div", { class: "iso-stage checker group-stage pool-stage" },
        h("p", { class: "muted" }, "…")));
    paintAdd();
    rows.set(cand.id, row);
    seen.observe(row);
    return row;
  };
  // All teardown lives on the close EVENT (Esc closes a dialog too), and the
  // button just asks for it — two paths into one handler, so onDone cannot
  // fire twice. One repaint at the end rather than one per add: the page
  // behind is stale while the dialog is up, and that is fine — the dialog IS
  // the page while it is open.
  const close = () => dlg.close();
  /* THE WAY OUT IS AT THE BOTTOM RIGHT (maintainer 2026-08-27: "After clicking
   * + Add to Set #2 where should I click for Ok/Close. Now I click at the very
   * right and that closes the wiki entire wiki ... Aaah now I see it. You added
   * the Close button at the top of the dialog and not the bottom right. I have
   * naver seen that UX before").
   *
   * The × at the top-right is the convention for DISMISSING a dialog; this one
   * is a task he finishes, and a finished task's button lives where every OK
   * button he has ever pressed lives. Reaching past a 400-row list to a header
   * to say "done" is not a thing anyone should have to discover — and while he
   * was looking for it he tapped outside and closed the whole wiki drawer.
   *
   * Sticky, because the list scrolls under it: the way out is never off screen.
   * It also carries what he just did, so "Done" is a summary and not a leap of
   * faith, and it names the Commit that still has to follow. */
  const tally = h("span", { class: "muted pool-tally" });
  const retally = () => {
    const set = setNow();
    const n = set?.members.length ?? 0;
    const rej = set?.rejected?.length ?? 0;
    /* ALWAYS THE SET'S STATE, never a session delta. "Nothing changed yet" sat
     * beside a save bar reading "1 change" and the two looked like they were
     * arguing; what he wants to know before pressing Done is what the set
     * HOLDS, and the Commit reminder is what is still owed. */
    tally.replaceChildren(
      `${n} tile${n === 1 ? "" : "s"} in ${setLabel(setOf())}${rej ? `, ${rej} rejected for it` : ""}`
      + (added ? " — Commit to save" : ""));
  };
  let poolClosed = false;
  const dlg = h("dialog", { class: "promote-modal pool-modal" },
    h("div", { class: "promote-head" },
      h("b", {}, `Add to ${setLabel(setOf())}`),
      h("span", { class: "pill" }, `${pool.length} to audition`),
      rejectedN ? h("span", { class: "pill", title: "Rejected for this set earlier — other sets still offer them" }, `${rejectedN} rejected here`) : null,
      h("button", {
        class: "ghost-btn", type: "button",
        title: "Re-roll the surrounding set — a candidate belongs when every roll still looks like one ground",
        onclick: () => {
          origin = [origin[0] + 7, origin[1] + 3];
          for (const [id, row] of rows) if (row.dataset.built === "1") { row.dataset.built = "0"; buildRow(pool.find((c) => c.id === id)); }
        },
      }, "🎲 Randomize")),
      /* NO SECOND WAY OUT. This dialog once carried "✕ Close" up here as well
       * as Done at the foot — two buttons doing the identical thing, since the
       * picks are staged the moment they are made and neither one discards
       * anything (maintainer 2026-08-27: "you added a Done button, but didn't
       * remove the X Close button at the top. So now we have both"). Done, at
       * the bottom right, is the way out; the header is for what the dialog IS
       * and the one control that changes what it shows. */
    h("p", { class: "muted" },
      pool.length
        ? `Each candidate sits as the centre 3×3 in two rings of ${setLabel(setOf())}, drawn by its weights — judge the field, then add.`
        : basePool(typeId).length
          ? "Every candidate for this ground is already in this set."
          : "No textured candidates for this ground yet — the tiles agent publishes them to tiles/base_candidates/. Until then this ground can only draw its clean colour."),
    (() => {
      /* IN SLICES, NEVER IN ONE PASS (maintainer 2026-08-27: "Pressing the
       * + Add tiles button lags and make the entire game freeze"). Building
       * all 373 row shells synchronously was one 6.7-SECOND main-thread task
       * — and the wiki lives in the game's drawer, so that thread is the
       * game's thread and the whole game hung with it. The fields were
       * already lazy; the shells were the freeze.
       *
       * The first slice paints before the dialog is even readable and each
       * later one is a frame's worth of work, so scrolling meets rows that
       * already exist — the IntersectionObserver's 600px margin covers the
       * gap. Building stops the moment the dialog closes. */
      const listEl = h("div", { class: "pool-list" });
      const SLICE = 30;
      let at = 0;
      const build = () => {
        if (poolClosed) return;                      // closed mid-build
        const frag = document.createDocumentFragment();
        for (const end = Math.min(pool.length, at + SLICE); at < end; at++) frag.append(rowFor(pool[at]));
        listEl.append(frag);
        if (at < pool.length) requestAnimationFrame(build);
      };
      build();
      return listEl;
    })(),
    h("div", { class: "pool-foot" }, tally,
      h("button", { class: "primary-btn pool-done", type: "button", onclick: close }, "Done")));
  retally();
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener("close", () => { poolClosed = true; seen.disconnect(); dlg.remove(); if (added) onDone?.(); });
}
/** One weight box: he edits the number, the percentage beside it tells him what
 *  the number MEANS in this row. 0 is legal and is how he says "never". */
const weightBox = (value, title, onset) => h("label", { class: "weight-label", title },
  "weight ",
  Object.assign(h("input", { type: "number", class: "weight-input", min: "0", max: "100", step: "0.5", value: String(value) }),
    { onchange: (e) => onset(e.target.value) }));
/* THE GROUP MODEL IS GONE, superseded by base tile sets (maintainer 2026-08-25).
 * Groups were sets without a name, without a weight of their own, and without a
 * clean member — "a base tile group is a set of tiles that togather make
 * tileing/seems dissapears" was the same idea one iteration earlier. What the
 * new model adds is what he asked for: how often a set is chosen for an area,
 * and how often that set paints the plain colour instead of a tile.
 *
 * tuning/base_tiles stays readable (BASE_KEY above) so nothing that consumes it
 * breaks mid-migration, but the wiki no longer writes it — the ground's look is
 * tuning/base_tile_sets now. It held no promotions when this landed, so there
 * was nothing to migrate. */
/** Weighted pick of a member's art path — the composites and the game agree
 *  that weight means "how often this one appears". */
function pickBaseMember(members, rnd) {
  const total = members.reduce((n, m) => n + m.weight, 0);
  let roll = rnd() * total;
  for (const m of members) { roll -= m.weight; if (roll <= 0) return m; }
  return members[members.length - 1];
}
const groundTypeMeta = (id) => (worldMeta().groundTypes ?? []).find((g) => g.id === id) ?? { id };
/** The ground's base colour: the promoted base tile's measured flat top when
 *  one exists, else the game palette's own colour for the type ("often the bg
 *  on the base tile or alone if no base tile exist"). */
function groundBaseColor(typeId) {
  /* THE CLEAN COLOUR IS THE PALETTE'S, not a tile's. It used to be measured off
   * whichever tile happened to be promoted first, which made the ground's own
   * colour move every time he changed a set — and the clean member of a set is
   * defined as "the ground's flat palette colour", so it has to be the palette
   * that answers. */
  const t = groundTypeMeta(typeId);
  if (t.top) return { c: t.top, from: "the game palette (no base tile promoted yet)" };
  return t.hex ? { c: t.hex, from: "the generator's intended colour" } : null;
}
/** What the surface taxonomy means, in his words (tiles/config/palette.json
 *  transition_surface, published through worldMeta.groundTypes). */
const SURFACE_LABEL = {
  own: { text: "always its own texture", cls: "", title: "This ground always draws its own texture — transitions keep the material's look right up to the boundary." },
  base: { text: "repeats the base tile", cls: "", title: "A patterned surface (paving, parquet): transitions mimic the base tile's texture so the pattern reads as continuous." },
  flat: { text: "clean colour for now", cls: "warn", title: "Painted as a clean flat colour until a texture beats it — the maintainer's declared stopgap, not the goal." },
};
const transitionsOf = (typeId) => (worldMeta().transitions ?? []).filter((t) => t.a === typeId || t.b === typeId);
/* EVERY NEIGHBOUR, not just the generated ones (maintainer 2026-08-25,
 * clicking Black Rock -> Transitions and finding nothing: "I expected to
 * see/find transitions for all tiles VS all tiles"). With the pattern library
 * a transition needs no pregenerated art, so the tab lists every other ground;
 * a pair that also has generated sets keeps them, and is the only place Raw
 * exists. Without the library (data too old) it degrades to the generated
 * list rather than to a page of dead cards. */
function allTransitionsOf(typeId) {
  if (!patternLib()) return transitionsOf(typeId);
  const gen = worldMeta().transitions ?? [];
  /* THE PLATES INDEX IS THE ROSTER, not the config vocabulary: the config
   * still says paving_stone while the palette, the plates and his sets split
   * it into brown/grey — a transition composes for exactly the grounds that
   * have plates, so that list is the honest one (15 today, 14 neighbours). */
  return Object.keys(patternLib().plates)
    .filter((id) => id !== typeId)
    .map((other) => {
      const g = gen.find((x) => (x.a === typeId && x.b === other) || (x.a === other && x.b === typeId));
      /* THE PAGE'S GROUND COMES FIRST, whatever order the art was generated
       * in (maintainer 2026-08-28: "The Ice ↔ grass page should sort the list
       * so tiles with the highest percentage of ice is at the top") — the
       * directory's own order survives as dirA/dirB, because RAW file paths
       * and the raw Wang indices live in that orientation. */
      return g ? { a: typeId, b: other, sets: g.sets, generated: true, dirA: g.a, dirB: g.b }
        : { a: typeId, b: other, sets: [], generated: false };
    });
}
/* ---- GROUND DETAILS — the fourth tab, and the second review axis ----
 * Maintainer 2026-08-21: "There are a LOT of tiles that look AMAZING if you
 * not show them to often! ... Tiles here will NEVER EVER show the wall side.
 * So the WALL is irrelevant ... This can be a flower or a small stone.
 * Something you cant repeat, but every nice tile that didn't make it into the
 * other categories can still have a chance to once in a while be in the game!
 * ... We have lots of tiles that at leat I have never seen how the top even
 * looks like! So you should be able to toggle a button to 'review the top' on
 * other tile pages ... and if the top looks great you can give it a top star
 * and approval."
 *
 * THE TOP IS ITS OWN REVIEW, stored in the same feedback doc under the same
 * key with a `#top` suffix — exactly how a monster's per-facet verdicts ride
 * `path#state#dir`. Independent by design: a tile rejected AS A PAIR (bad
 * wall) can still be a top-approved detail — "didn't make it into the other
 * categories" is the point — and the tiles agent is told to keep the art of
 * any top-approved tile even when the pair-tile itself is rejected.
 *
 * THE PICTURE IS THE GAME'S: the tile centred in a 3×3 of the ground's base
 * group — how a detail actually appears, once in a while, in a field. And it
 * shows the RAW top (`before`): the pair postprocess flattens every top to
 * the clean colour, which is WHY he has never seen most of them.
 */
const topKey = (key) => `${key}#top`;
/* The top review's rating mark — "instead of stars lets use something like a
 * roof emoji" (maintainer 2026-08-21). ⌂ IS a roof over a base, and being a
 * text glyph it takes the stars' sizing and colours instead of fighting them. */
const ROOF_GLYPH = { lit: "⌂", dim: "⌂", cls: "roofs", name: "roof" };
const topFb = (key) => fb("tiles", topKey(key));
const topReviewed = (key) => { const e = topFb(key); return !!(e.rating || e.status); };
/** The art the top review judges: the unflattened raw when it exists. */
/** THE ART EVERY COMPOSITION DRAWS WITH. After by default — what the game
 *  actually ships is what a tile has to look good as (maintainer 2026-08-21:
 *  "AFTER postprocessing should be default and the switch can take you to
 *  BEFORE. That switch will then change on all 3x3 tiles"). My first cut
 *  hardcoded the raw top on the theory that he had never seen it: the theory
 *  was right, the default was wrong.
 *
 *  ONE RULE FOR EVERY TILE IN THE PICTURE — the centre AND the ground around
 *  it. A 3×3 with a raw centre on postprocessed neighbours is a comparison of
 *  two different passes pretending to be one field, which is exactly the lie
 *  the before/after switch exists to prevent. A tile with no raw generation
 *  keeps showing its shipped art rather than a hole. */
/* THE THIRD PASS IS SYNTHESIZED IN THE BROWSER (maintainer 2026-08-21: "I'm
 * not talking about before postprocessing, I'm talking about an alternative
 * postprocessing where the top texture is maintained, but still colored in the
 * correct tile palette"). No such file exists anywhere in the pipeline, so the
 * wiki composes it from the two that do:
 *
 *   1. Start from AFTER — the shipped tile: palette-corrected wall, clean top.
 *   2. Find what the flattening painted: every colour covering >=15% of the
 *      opaque pixels (a transition tile has TWO grounds, hence up to three).
 *      A tile whose after-top is already textured (parquet, the pavings) has no
 *      such colour, and the synthesis correctly leaves it alone.
 *   3. On exactly those pixels, take the RAW pixel and shift it per channel so
 *      the region's MEAN lands ON the clean colour. The texture — every
 *      speckle, every blade — survives 1:1, and a field of it still reads as
 *      the right ground from a distance, because its average IS the clean
 *      colour. That is "the texture maintained, in the correct palette".
 *
 * Cached per art path; falls back to plain After when there is no raw art or
 * the canvas is tainted (foreign-origin staging root). */
const TEX_CACHE = new Map();   // "art::raw" -> HTMLCanvasElement | null
function texSynth(afterImg, rawImg) {
  const w = afterImg.naturalWidth, ht = afterImg.naturalHeight;
  if (!w || !ht || !rawImg.naturalWidth) return null;
  const cv = document.createElement("canvas"); cv.width = w; cv.height = ht;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.imageSmoothingEnabled = false;
  cx.drawImage(afterImg, 0, 0);
  const A = cx.getImageData(0, 0, w, ht);
  const rc = document.createElement("canvas"); rc.width = w; rc.height = ht;
  const rcx = rc.getContext("2d", { willReadFrequently: true });
  rcx.imageSmoothingEnabled = false;
  rcx.drawImage(rawImg, 0, 0, w, ht);   // raw scaled onto after's grid
  const R = rcx.getImageData(0, 0, w, ht).data;
  const d = A.data;
  const counts = new Map(); let opaque = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue; opaque++;
    const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (!opaque) return null;
  const flats = [...counts.entries()].filter(([, n]) => n / opaque >= 0.15)
    .sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k]) => k);
  if (!flats.length) return null;   // nothing was flattened — After is honest
  // Group the flattened pixels BEFORE touching any of them.
  const regions = new Map(flats.map((k) => [k, []]));
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200 || R[i + 3] < 200) continue;
    const list = regions.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    if (list) list.push(i);
  }
  const cl = (x) => Math.max(0, Math.min(255, Math.round(x)));
  let changed = 0;
  for (const [clean, list] of regions) {
    if (list.length < 12) continue;
    const tgt = [(clean >> 16) & 255, (clean >> 8) & 255, clean & 255];
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (const i of list) sum += R[i + c];
      const mean = sum / list.length;
      // HOW FAR THE TEXTURE ACTUALLY SWINGS, ignoring the top 2% so one stray
      // pixel cannot squash the whole surface.
      const devs = list.map((i) => Math.abs(R[i + c] - mean)).sort((a, b) => a - b);
      const p98 = devs[Math.min(devs.length - 1, Math.floor(devs.length * 0.98))] || 0;
      // THE ROOM THIS PALETTE COLOUR HAS, either side of itself. A dark green
      // (82) can swing ±82 before it hits black; a near-black (20) cannot.
      const head = Math.min(tgt[c], 255 - tgt[c]);
      const k = (p98 > head && p98 > 0) ? head / p98 : 1;
      for (const i of list) d[i + c] = cl(tgt[c] + (R[i + c] - mean) * k);
    }
    changed += list.length;
  }
  if (!changed) return null;        // raw is transparent under the whole top
  cx.putImageData(A, 0, 0);
  return cv;
}
/** Resolve one textured-top canvas, cached. cb(null) = cannot synthesize — the
 *  caller shows plain After, which is always true, never wrong. */
function texFor(art, raw, cb) {
  const key = `${art}::${raw}`;
  if (TEX_CACHE.has(key)) { cb(TEX_CACHE.get(key)); return; }
  let a = null, r = null, left = 2;
  const done = () => {
    if (--left > 0) return;
    let c = null;
    try { c = (a && r) ? texSynth(a, r) : null; } catch { c = null; /* tainted canvas — foreign staging root */ }
    TEX_CACHE.set(key, c); capCache(TEX_CACHE);
    window.__wikiTex = (window.__wikiTex ?? 0) + 1;   // gate probe
    cb(c);
  };
  const mk = (path, set) => {
    const im = new Image();
    /* CORS, OR THE SYNTHESIS CANNOT READ ITS OWN PIXELS (maintainer 2026-08-22:
     * "Textured doesn't work and also displays the clean single color version
     * right now").
     *
     * Tile review art is NOT in the deploy image — /assets/tiles/review/… is
     * 404 in production — so it comes from the staging CDN, a different origin.
     * An <img> loaded without crossOrigin taints any canvas it is drawn into,
     * getImageData throws SecurityError, texSynth returns null, and the caller
     * falls back to the plain After image: the clean single colour, exactly
     * what he saw. raw.githubusercontent answers
     * access-control-allow-origin: *, so asking for CORS costs nothing.
     *
     * MY GATES COULD NOT SEE THIS. The local server has ASSETS_ROOT at the repo
     * root, so /assets/tiles/… is same-origin in every test and tainting never
     * happens — the one difference between the test and the real thing was the
     * only thing that mattered. */
    im.crossOrigin = "anonymous";
    im.onload = im.onerror = () => { set(im.naturalWidth ? im : null); done(); };
    im.src = assetUrl(path);
  };
  mk(art, (x) => { a = x; }); mk(raw, (x) => { r = x; });
}
/* ---- TOP SUBSTITUTION — the wall he is reviewing, under the ground he chose --
 * Maintainer 2026-08-25: "That page as you know focuses on the walls, but you
 * should be able to see the walls with different grounds based on what you
 * select. Remember a base tile set is all about the ground. I pick tiles to be
 * part of the base tile set if I like how the top looks with the knowlage this
 * will never define a wall."
 *
 * So a "Set #N" view of an x-over-y tile keeps that tile's WALL — the thing
 * under review — and replaces only its TOP FACE with a tile from the set.
 *
 * THE GEOMETRY, measured here rather than assumed:
 *   Review tiles are 64x64 with the art ending at wall-foot row 54; ballot
 *   tiles are 64x46 ending at row 45. The offset is 9 — taken from the WALL
 *   FOOT, which is rigid, never from the apex, which is not. See alignTiles.
 *   The top face is per COLUMN, from the silhouette: rows [ymin, ymax-16].
 *   Not a rhombus formula — the pipeline's top_face() replaced one of those
 *   because it was a pixel short at every extreme, counting a genuine ring of
 *   top face as wall. WALL_D = 17, the same constant the manifest publishes as
 *   iso.wall_px.
 *   THE TWO SILHOUETTES ARE NOT IDENTICAL: measured on grass, the review tile
 *   starts one row higher than the ballot tile in 48 of 64 columns. Copying
 *   pixel-for-pixel would leave that row unpainted — "leaving a few edge pixels
 *   like this looks like shit" — so each column is extended, repeating the
 *   ballot tile's first top pixel upward, exactly as _extend_base does.
 */
const SUB_CACHE = new Map();          // "cand::base" -> HTMLCanvasElement | null
const WALL_D = 17;                    // rows of wall under every column (tiles/pipeline/transition_render.py)
/** Per column, the first and last opaque row. -1 where the column is empty. */
function colSpans(data, w, h) {
  const top = new Int16Array(w).fill(-1), bot = new Int16Array(w).fill(-1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) if (data[(y * w + x) * 4 + 3] > 8) { if (top[x] < 0) top[x] = y; bot[x] = y; }
  }
  return { top, bot };
}
/** Review tile + ballot tile -> the review tile wearing the ballot tile's top.
 *  The browser copy of wiki/lib/topsub.mjs; check-topsub.mjs runs both over the
 *  same art and fails if they disagree by a pixel. */
function topSub(candImg, baseImg) {
  const w = candImg.naturalWidth, h = candImg.naturalHeight;
  if (!w || !baseImg.naturalWidth) return null;
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.imageSmoothingEnabled = false;
  cx.drawImage(candImg, 0, 0);
  const out = cx.getImageData(0, 0, w, h);           // throws if tainted — caller falls back
  const bw = baseImg.naturalWidth, bh = baseImg.naturalHeight;
  const bc = document.createElement("canvas"); bc.width = bw; bc.height = bh;
  const bx = bc.getContext("2d", { willReadFrequently: true });
  bx.imageSmoothingEnabled = false;
  bx.drawImage(baseImg, 0, 0);
  const base = bx.getImageData(0, 0, bw, bh);
  const A = colSpans(out.data, w, h), B = colSpans(base.data, bw, bh);
  /* ALIGN ON THE WALL FOOT, NOT THE APEX — measured over all 5,838 review tiles
   * and 356 ballot tiles. The bottom edge is a rigid translate (the per-column
   * offset is identical in 95.8% of columns and votes 9 on 97% of tiles); the
   * TOP edge never is — every one of the 5,838 tiles has at least a pixel of
   * spread, which is the same outline mismatch _extend_base was written for.
   * It also follows from the definition: the top face is derived from the
   * bottom (bot - WALL_D), so sharing a bottom is sharing the top-face
   * boundary. Measured cost of getting it wrong on grass over dark_mud: at the
   * bottom-aligned dy=9 all 910 top pixels land on real top face; at the dy=10
   * apex-matching answers, 50 fall off it. Voted per column so one deformed
   * silhouette cannot move the whole tile. */
  const dx = (w - bw) >> 1;
  const votes = new Map();
  for (let x = 0; x < w; x++) {
    const sx = x - dx;
    if (A.bot[x] < 0 || sx < 0 || sx >= bw || B.bot[sx] < 0) continue;
    const d = A.bot[x] - B.bot[sx];
    votes.set(d, (votes.get(d) ?? 0) + 1);
  }
  if (!votes.size) return null;
  let dy = 0, best = -1;
  for (const [d, n] of [...votes].sort((a, b) => a[0] - b[0])) if (n > best) { dy = d; best = n; }
  for (let x = 0; x < w; x++) {
    if (A.top[x] < 0) continue;
    const sx = x - dx;
    if (sx < 0 || sx >= bw || B.top[sx] < 0) continue;
    const sTop = B.top[sx];
    /* CLAMP INTO THE SOURCE'S OWN TOP FACE, not its silhouette. _extend_base
     * runs on tiles of one size and never needed the distinction; here,
     * sampling one row lower would paint the BALLOT TILE'S WALL into the new
     * top — the one material that must never appear there. */
    const sBot = Math.max(sTop, B.bot[sx] - WALL_D);
    const kBot = A.bot[x] - WALL_D;                  // keep's last top-face row
    for (let y = A.top[x]; y <= kBot; y++) {
      const di = (y * w + x) * 4;
      if (!(out.data[di + 3] > 0)) continue;         // top_face() is m & alpha
      let sy = y - dy;
      if (sy < sTop) sy = sTop; else if (sy > sBot) sy = sBot;
      const si = (sy * bw + sx) * 4;
      out.data[di] = base.data[si]; out.data[di + 1] = base.data[si + 1]; out.data[di + 2] = base.data[si + 2];
      // ALPHA IS THE REVIEW TILE'S, ALWAYS. The silhouette under review must not
      // gain or lose a pixel to the ground painted on it.
    }
  }
  cx.putImageData(out, 0, 0);
  return cv;
}
/* ---- THE TOP-ONLY POOL, POSTPROCESSED IN THE BROWSER --------------------
 * Maintainer 2026-08-27, auditioning black_rock: "Ofc I don't want to see the
 * tile as raw here. I want to see the top as textured, but postprocessed ...
 * In order to see how this tile should look like if it was part of this base
 * tile set."
 *
 * He is right and the numbers agree: the top-only sheets are raw generator
 * output, and raw means raw COLOUR — measured against the palette, grass tops
 * average 84 RGB units off (lime green against the game's blue-green), ice 31.
 * The texture needs no synthesis; the colour does.
 *
 * THE RULE IS THE PIPELINE'S OWN, palette_snap.substitute(): hue and
 * saturation are SET from the palette, never read off the art, and only the
 * value carries through — recentred on the target with its spread compressed
 * (SPILL_SPREAD 16, the tiles2 grass measurement), clamped to ±58 of the
 * target. Same constants, same maths, so what this shows is what the tiles
 * agent's corrected pass will produce when it lands — at which point their
 * files replace this synthesis and nothing else changes.
 */
const PP_CACHE = new Map();           // "path::hex" -> HTMLCanvasElement | null
function ppSynth(img, hex) {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.imageSmoothingEnabled = false;
  cx.drawImage(img, 0, 0);
  const im = cx.getImageData(0, 0, w, h);            // throws if tainted — caller falls back
  const d = im.data;
  const [tr, tg, tb] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const tM = Math.max(tr, tg, tb);
  const unit = tM ? [tr / tM, tg / tM, tb / tM] : [1, 1, 1];
  let sum = 0, sumSq = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const v = Math.max(d[i], d[i + 1], d[i + 2]);
    sum += v; sumSq += v * v; n++;
  }
  if (!n) return null;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const scale = Math.min(1, 16 / (std || 16));       // SPILL_SPREAD, compressed only
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const v = Math.max(d[i], d[i + 1], d[i + 2]);
    let v2 = tM + (v - mean) * scale;
    v2 = Math.max(tM - 58, Math.min(tM + 58, v2));   // the guard's own clamp
    v2 = Math.max(0, Math.min(255, v2));
    /* The pixel's value v2, wearing the target's hue and saturation exactly:
     * scale the target's own channel proportions to v2. out = v2 · (tc / tM)
     * keeps H and S identical to the target by construction — the same
     * "nothing here reads anything off the art" property substitute() has. */
    d[i]     = Math.round(v2 * unit[0]);
    d[i + 1] = Math.round(v2 * unit[1]);
    d[i + 2] = Math.round(v2 * unit[2]);
  }
  cx.putImageData(im, 0, 0);
  return cv;
}
function ppFor(path, hex, cb) {
  const key = `${path}::${hex}`;
  if (PP_CACHE.has(key)) { cb(PP_CACHE.get(key)); return; }
  const im = new Image();
  im.crossOrigin = "anonymous";       // same reason as texFor — see the note there
  im.onload = im.onerror = () => {
    let c = null;
    try { c = im.naturalWidth ? ppSynth(im, hex) : null; } catch { c = null; }
    PP_CACHE.set(key, c); capCache(PP_CACHE);
    window.__wikiPP = (window.__wikiPP ?? 0) + 1;    // gate probe
    cb(c);
  };
  im.src = assetUrl(path);
}
/** The pp: virtual path for a top-only tile, or the plain path when the
 *  ground has no palette colour to correct to. */
function ppPath(typeId, art) {
  const hex = groundTypeMeta(typeId)?.top;
  return /^#[0-9a-f]{6}$/i.test(hex ?? "") ? `pp:${art}::${hex}` : art;
}

/** Async resolve of a virtual "sub:<cand>::<base>" path, mirroring texFor. */
function subFor(cand, base, cb) {
  const key = `${cand}::${base}`;
  if (SUB_CACHE.has(key)) { cb(SUB_CACHE.get(key)); return; }
  let a = null, b = null, left = 2;
  const done = () => {
    if (--left > 0) return;
    let c = null;
    try { c = (a && b) ? topSub(a, b) : null; } catch { c = null; /* tainted canvas — foreign staging root */ }
    SUB_CACHE.set(key, c); capCache(SUB_CACHE);
    window.__wikiSub = (window.__wikiSub ?? 0) + 1;   // gate probe
    cb(c);
  };
  const mk = (path, set) => {
    const im = new Image();
    im.crossOrigin = "anonymous";     // same reason as texFor — see the note there
    im.onload = im.onerror = () => { set(im.naturalWidth ? im : null); done(); };
    im.src = assetUrl(path);
  };
  mk(cand, (x) => { a = x; }); mk(base, (x) => { b = x; });
}
/** The art one VIEW shows for one candidate. "tex:" paths are virtual —
 *  loadImages resolves them to a synthesized canvas. */
/* THE TOP GROUND OF A CANDIDATE, from its own key. A review key is
 * tiles/<top>__over__<side>/<sha1>, so the ground whose surface this tile shows
 * is already in hand — no call site has to pass it, and none can pass a wrong
 * one. */
function candTop(cand) {
  const cell = cand?.key?.split("/")[1];
  const i = cell?.indexOf("__over__") ?? -1;
  return i > 0 ? cell.slice(0, i) : null;
}
const viewArtIn = (view, cand) => {
  if (!cand) return undefined;
  if (view === PASS_RAW) return cand.raw ?? cand.art;
  /* A SET IS NOT A PASS OF THIS TILE — it is a different ground painted on it.
   * The wall under review is kept and only the top face is replaced, which is
   * the whole reason he can judge a wall against a ground he configured. The
   * cell coordinates are the tile's own position in whatever field draws it;
   * a lone card is cell (0,0), which is a real cell, not a placeholder. */
  const top = candTop(cand);
  /* OWN TOP WINS OVER EVERYTHING COMPOSED (maintainer 2026-08-27: "This option
   * will have higher priority and be used instead of swapping out the top").
   * The tile's generated art already carries the top he is protecting, so the
   * answer is simply the art itself — no composition at all. */
  if (cand.art && ownTop(cand.key)) return cand.art;
  const set = top ? passSet(top, view) : null;
  if (set && cand.art) {
    const face = setCellArt(set, cand.subX ?? 0, cand.subY ?? 0, top);
    if (face) return `sub:${cand.art}::${face}`;
  }
  /* CLEAN #0 IS COMPOSED TOO, NOT INHERITED (maintainer 2026-08-27: "if I
   * press on Brown Paving Stone and click on Clean #0 the tiles doesn't
   * become clean ... The idea with the big task was to normalize and make all
   * tile types work the same way"). The shipped after-art only LOOKS clean on
   * grounds whose postprocess flattened the top; paving and parquet keep
   * their texture, so showing cand.art under Clean showed texture — the old
   * per-material rule leaking through the new model. The clean plate is the
   * ground's flat colour in tile geometry, and topSub puts it on this tile's
   * own wall. Falls back to cand.art only when the library is not published. */
  const cleanPlate = top ? patternLib()?.plates[top]?.clean : null;
  if (cand.art && cleanPlate) return `sub:${cand.art}::${cleanPlate}`;
  return cand.art;
};
const viewArt = (cand) => viewArtIn(worldView(), cand);
/** An element showing one art path — <img> for a real path, a painted canvas
 *  for a virtual "tex:" one. For the few places that show a tile OUTSIDE an
 *  isoScene composition. */
function artNodeFor(path, cls, alt) {
  const p = String(path ?? "");
  const virt = p.startsWith("tex:") ? "tex" : p.startsWith("sub:") ? "sub" : p.startsWith("mix:") ? "mix" : p.startsWith("pp:") ? "pp" : null;
  if (!virt) return h("img", { class: cls, src: assetUrl(path), alt });
  const cv = h("canvas", { class: cls, width: 64, height: 46, "aria-label": alt });
  const [a, b] = p.slice(4).split("::");
  const paint = (src, w, ht) => {
    cv.width = w; cv.height = ht;
    const cx = cv.getContext("2d");
    cx.imageSmoothingEnabled = false;
    cx.drawImage(src, 0, 0);
  };
  /* BOTH VIRTUALS FALL BACK TO THE PLAIN TILE, never to nothing. A composite
   * that cannot be computed (a tainted canvas, art that 404s) must still show
   * the tile — an empty box would read as "this tile is gone". */
  const fall = () => {
    const im = new Image();
    im.onload = () => { if (im.naturalWidth) paint(im, im.naturalWidth, im.naturalHeight); };
    im.src = assetUrl(a);
  };
  const take = (c) => { if (c) paint(c, c.width, c.height); else fall(); };
  if (virt === "pp") {
    const [a2, hex] = p.slice(3).split("::");
    ppFor(a2, hex, (c) => {
      if (c) paint(c, c.width, c.height);
      else { const im = new Image(); im.onload = () => { if (im.naturalWidth) paint(im, im.naturalWidth, im.naturalHeight); }; im.src = assetUrl(a2); }
    });
    return cv;
  }
  if (virt === "mix") {
    const [row, idx, pa, pb] = p.slice(4).split("|");
    mixFor(+row, +idx, pa, pb, (c) => {
      if (c) paint(c, c.width, c.height);
      else { const im = new Image(); im.onload = () => { if (im.naturalWidth) paint(im, im.naturalWidth, im.naturalHeight); }; im.src = assetUrl(pa); }
    });
    return cv;
  }
  if (virt === "tex") texFor(a, b, take); else subFor(a, b, take);
  return cv;
}
/** Every candidate whose TOP belongs to this ground — every pair of the type,
 *  the wall deliberately ignored. */
/* EVERY TOP OF THIS GROUND — the x-over-y candidates AND the top-only tiles
 * (maintainer 2026-08-27: "you should include this new set when I scroll over
 * details tiles or base set tiles that has not been rejected").
 *
 * A top-only tile has no cell: it was generated with the wall meaningless, so
 * there is no "over what" to name and no wall verdict to give. It gets a
 * cell-SHAPED stand-in whose `side` is null, which is what every caller reads
 * to decide whether a wall question even applies — and which keeps these out
 * of anything that walks worldCells, where an x-over-y verdict lives.
 *
 * DETAIL SHEETS FIRST here, the mirror of subtle-first in the base-tile pool:
 * the tiles agent generates three of each per ground, and a detail is by
 * construction the once-in-a-while showpiece this tab collects. */
const typeTops = (typeId) => [
  // TOP-ONLY FIRST: purpose-built for this decision, where an x-over-y
  // candidate's top is a by-product of a tile generated to show a wall.
  ...(worldMeta().tops?.[typeId] ?? [])
    .slice()
    .sort((a, b) => (a.flavour === b.flavour ? 0 : a.flavour === "detail" ? -1 : 1))
    .map((t) => ({
      cell: { id: t.id, top: typeId, side: null, name: `${typeLabelWorld(typeId)} · ${t.flavour ?? "top"}`, topOnly: true },
      // POST IS WHAT TO SHOW (maintainer 2026-08-28: "Ofc I want to see the
      // center tile with a postprocessed top") — same rule the base-set pool
      // and set members already follow. ppPath stays only for a sheet the
      // postprocess could not align; the raw pass is what Raw means.
      cand: { key: t.id, art: t.post ?? ppPath(typeId, t.art), raw: t.art, tex: null, topOnly: true, flavour: t.flavour, paletteTop: null },
    })),
  ...worldCells().filter((c) => c.top === typeId)
    .flatMap((c) => c.candidates.map((cand) => ({ cell: c, cand }))),
];
/** The ground's detail collection: tops he approved. */
const detailsOf = (typeId) => typeTops(typeId).filter(({ cand }) => topFb(cand.key).status === "approved");
/** The boredom queue: tops nobody has judged yet. */
const detailQueue = (typeId) => typeTops(typeId).filter(({ cand }) => !topReviewed(cand.key));
/* FIVE BY FIVE, THE DETAIL EXACTLY ONCE (maintainer 2026-08-28: "A detail is
 * supposed to only be displayed once and not tiled. So the 5x5 preview should
 * display the base tile set selected on all tiles except the center tile. The
 * center tile should be the detail tile I'm currently reviewing.").
 *
 * This replaces the 2026-08-23 nine-in-a-ring: a detail is a thing the map
 * agent scatters ONCE in a while — a flower, a stone — so nine of it was a
 * picture of exactly the repetition it must never have.
 *
 * THE RING IS THE SWITCH, live: each ring cell is the selected pass's own
 * per-cell pick — Clean draws the clean plate, Set #N the set's members with
 * the game's hash, Raw keeps the ring clean and shows the detail's raw top in
 * the centre. And every cell wears the ground's x-over-x WALL (his rule: "a
 * base tile set should never show a wall so we need help from the x over x"),
 * through the same tex2 dressing the transitions use. */
function detailField(typeId, cand, view, origin = [0, 0], scale = 1) {
  const box = h("div", { class: "iso-stage checker group-stage" });
  const lib = patternLib();
  const clean = lib?.plates[typeId]?.clean ?? cleanArtOf(typeId);
  // every face wears the wall MEASURED closest to it, as the game will
  const dress = (face) => {
    if (!face || !clean) return face;
    const w = bestWall(typeId, face).art;
    return w ? `tex2:${w}::${face}::${clean}` : face;
  };
  const set = passSet(typeId, view);
  const [x0, y0] = origin;
  /* THE TEXTURED PASS, never After (maintainer 2026-08-28: "They need to
   * show their postprocessed top that is not clean/plain! How should I else
   * be able to approve their top texture being part of details?"). An
   * x-over-y tile of a flat-top ground SHIPS with the clean colour on top —
   * the After pass is the law, not a picture of the texture — so judging a
   * top needs `tex`. A top-only tile has no tex and its art IS the
   * postprocessed top; Raw stays the generator's own. */
  const centreTop = view === PASS_RAW ? (cand?.raw ?? cand?.art) : (cand?.tex ?? cand?.art);
  const ringAt = (x, y) => {
    if (set) return setCellArt(set, x, y, typeId) ?? clean;
    return clean;                       // Clean and Raw ring alike: the ground as it ships
  };
  const cells = [];
  let ringFaces = new Set();
  /* QA probe: the composition, measured — 25 cells with the detail at index 12
   * and no cell of it on an edge, which is WHY it never shows a wall. */
  (window.__wikiDetailField ??= []).unshift({ type: typeId, cells: 25, centre: 12, edge: 0 });
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
    const centre = c === 2 && r === 2;
    const face = centre ? centreTop : ringAt(x0 + c, y0 + r);
    if (!centre && face) ringFaces.add(face);
    cells.push({ c, r, img: dress(face) });
  }
  // QA probe: what this composition believes, for the gate.
  const centreWall = bestWall(typeId, centreTop);
  window.__wikiDetail = {
    view, typeId, centre: centreTop ?? null, dressed: !!(centreWall.art && clean),
    wall: centreWall.key, wallIdx: centreWall.i, wallAuto: centreWall.auto, wallN: centreWall.n,
    ringDistinct: ringFaces.size, ringSample: [...ringFaces][0] ?? null,
  };
  const paths = [...new Set(cells.map((x) => x.img).filter(Boolean))];
  if (!paths.length) { box.append(h("p", { class: "muted" }, "no ground to stand this on yet")); return box; }
  loadImages(paths, (images) => box.replaceChildren(isoScene(cells.filter((x) => x.img), images, scale, 4, worldIso())));
  return box;
}

/** A transition set's tile path — derivable, never shipped (build.mjs ships
 *  metadata only). `post` picks the retextured pass once the tiles agent
 *  publishes it. */
/* ---- COMPOSED TRANSITIONS: two plates and a mask -------------------------
 * Maintainer 2026-08-25: "By studying how this is done we can without
 * generating more transition tiles get transition tiles for everything
 * automatically by using the formula and inserting the base tile from tile
 * type A on one side and base tile from tile type B on the other side."
 *
 * The tiles agent measured his hypothesis and it held: the 284 pregenerated
 * sets collapse to 18 (roughness, seed) patterns whose boundary is material-
 * independent (95% pixel agreement across ~17 pairs each). tiles/patterns/
 * publishes those 18 boundaries as one mask sheet; tiles/plates/ publishes
 * every approved ground conformed into 64x46 plates whose alpha is
 * byte-identical to the shared silhouette. Composition is therefore exactly
 * the three canvas ops published in patterns/index.json — draw mask, draw
 * plate_b through source-in, fill the rest from plate_a with destination-over
 * — with no geometry knowledge here at all.
 *
 * WHAT THE PASS SWITCH MEANS HERE: Clean #0 fills each side with that
 * ground's clean plate; Set #N fills each side from that ground's OWN set N,
 * picked per cell with the same hash the game uses. Raw stays what it always
 * was — the generator's own pregenerated tiles — and exists only for the 26
 * pairs that were ever generated.
 *
 * WHAT COMPOSITION HONESTLY CANNOT DO (patterns/index.json `reproduces`): it
 * reproduces the boundary SHAPE, not the generator's shading along the seam —
 * no grass blades leaning over a road edge. That is the declared cost of
 * transitions-for-every-pair, and the pregenerated art stays reachable under
 * Raw so he can compare and rule.
 */
const patternLib = () => worldMeta().patternLib ?? null;
/* HOW EACH SIDE OF A TRANSITION IS VIEWED — per GROUND, not per page
 * (maintainer 2026-08-27: "On the Transitions tab we always got two different
 * tile types. The tile art here has to be per tile type. So we need two radio
 * button groups ... 1: How do you want to view tile type A? 2: How do you want
 * to view tile type B?"). One remembered choice per ground, shared by every
 * pair that ground appears in, defaulting to the ground's own page-level pass
 * — so a ground with 4 sets and a ground with none each offer exactly their
 * own list, which is the whole point of making it per type. */
/* RAW IS NOT A SIDE'S CHOICE (maintainer 2026-08-27: "when switching between
 * Raw and Clean #0 today both radio button group changes state"). He is right,
 * and it was forced: a raw transition tile is ONE generated picture of both
 * materials, so if Raw sits in both per-side groups then every correct
 * implementation must move both together — otherwise one group would claim a
 * state the picture does not have.
 *
 * So Raw LEAVES the per-side groups. Each side keeps a purely composed choice
 * (Clean #0, Set #N) that nothing else can move, and the pair carries one
 * Composed/Raw control of its own. That makes the two groups genuinely
 * independent, which is what he asked the split for in the first place.
 *
 * The flag is wanted-vs-effective: a pair the generator never produced has no
 * raw to show, so its Raw chip is DISABLED and the row draws Composed while
 * the preference survives for pairs that do have it. The chip always shows
 * what is on screen. */
const TRANS_RAW_KEY = "wiki-trans-raw";
const transRawWanted = () => { try { return localStorage.getItem(TRANS_RAW_KEY) === "1"; } catch { return false; } };
const setTransRaw = (on) => { try { localStorage.setItem(TRANS_RAW_KEY, on ? "1" : "0"); } catch { /* private mode */ } };
/** Raw is only ON where the generator actually produced this pair + pattern. */
const rawOn = (genSet) => transRawWanted() && !!genSet;
const rawBarOptions = (genSet) => [
  ["composed", "Composed", "Built live from the pattern's mask and each side's own base tiles — what the game will draw"],
  [PASS_RAW, "Raw", genSet
    ? "The generator's own pregenerated tiles for this pattern, seam shading and all — the comparison composition cannot reproduce"
    : "No raw art exists for this pair and pattern — it was never pregenerated, so there is nothing to show",
    !genSet],
];
const TRANS_SIDES_KEY = "wiki-trans-sides";
const transSideViews = new Map(); // ground -> pass id override
try {
  for (const [g, v] of Object.entries(JSON.parse(localStorage.getItem(TRANS_SIDES_KEY) ?? "{}"))) transSideViews.set(g, v);
} catch { /* private mode */ }
const saveSideViews = () => { try { localStorage.setItem(TRANS_SIDES_KEY, JSON.stringify(Object.fromEntries(transSideViews))); } catch { /* private mode */ } };
/* Defaults to Clean #0, NOT to the page-level pass: the whole point is that a
 * transition side is viewed per TYPE, and a global preference like "set:1"
 * leaking into fourteen different B-sides is the genericity he rejected. */
const sideViewOf = (g) => {
  const v = transSideViews.get(g);
  return v && passOptions(g, { raw: false }).some(([id]) => id === v) ? v : PASS_CLEAN;
};
/** One side's composed choice. Nothing else moves — that is the point. */
function setSideView(g, id) { transSideViews.set(g, id); saveSideViews(); }
const passLabelOf = (g, view) => view === PASS_RAW ? "Raw"
  : view === PASS_CLEAN ? "Clean #0"
  : (passSet(g, view) ? setLabel(passSet(g, view)) : "Clean #0");

const patternOf = (id) => patternLib()?.patterns.find((x) => x.id === id) ?? null;
/* side_b is whichever ground appears LATER in the library's side_order
 * (wettest to built) — a total order, so two consumers never disagree about
 * which way a boundary fades and a 3-way vertex has a defined answer. */
function transSides(a, b) {
  const ord = patternLib()?.sideOrder ?? [];
  const ia = ord.indexOf(a), ib = ord.indexOf(b);
  return (ib > ia) ? { sideA: a, sideB: b } : { sideA: b, sideB: a };
}
/* THE PLATE A SET MEMBER COMPOSES WITH. Two member kinds, two resolutions:
 * a review key (tiles/<cell>/<key8>) maps to tiles/plates/<top>/<key8>.webp by
 * pure string — the tiles agent's published rule, backed by the key list in
 * patternLib so a rejected key degrades to clean instead of a 404. A ballot id
 * (<pair>__<variant>) IS transition geometry already: its file is the pure
 * corner tile of a generated set, and its alpha was verified byte-identical to
 * the library silhouette, so it serves as its own plate. */
function memberPlate(typeId, m) {
  const lib = patternLib();
  if (!lib) return null;
  const ground = lib.plates[typeId];
  if (!m || m.kind === "clean" || m.clean) return ground?.clean ?? null;
  /* THE FACE IS THE MEMBER'S OWN ART — the same file the Base tab's field
   * draws (maintainer 2026-08-28, Black Rock Set #1: "the black rock on the
   * preview is clean single color black rock and not the same set you see on
   * image 1"). Review-key members used to map to tiles/plates/<key8>, which
   * is the SAME tile flattened: on a flat-surface ground the plate's top is
   * the clean colour by the tiles agent's own design, so the set he audited
   * textured composed clean — two files for one key, and the transition chose
   * the wrong one. The plates' remaining job here was geometry, and the
   * composer now takes any framing (centred, silhouette-clipped, face-
   * backfilled), so what he sees in the set IS what the transition wears.
   * The wall never comes from the face — tex2 dressing takes it from the
   * ground's x-over-x tile — so a member's foreign wall cannot leak. */
  return m.art ?? basePool(typeId).find((c) => c.id === m.id)?.art ?? ground?.clean ?? null;
}
/** Which plate fills cell (x,y) of this ground under the current pass. */
function platePickAt(typeId, x, y, view = null) {
  const lib = patternLib();
  if (!lib) return null;
  const clean = lib.plates[typeId]?.clean ?? null;
  const set = passSet(typeId, view ?? worldViewFor(typeId));
  if (!set) return clean;
  const rows = [{ kind: "clean", weight: set.clean }, ...set.members];
  const i = pickWeighted(rows.map((m) => (m.kind === "clean" ? m.weight : (m.art ? m.weight : 0))), unitHash(`bts1|tile|${set.id}|${x}|${y}`));
  return i < 0 ? clean : memberPlate(typeId, rows[i]);
}
/* The library's sheets — masks and borders — each fetched once, frames cut on
 * demand. crossOrigin for the same reason as texFor: they live on the staging
 * origin, and a gate must be able to read the composed pixels back.
 *
 * ALWAYS CALLS BACK, with null on failure. The single-sheet loader this
 * replaces dropped its waiters when the fetch failed, so `left` never reached
 * zero and the callback never fired — a scene that could not get its mask
 * would sit blank for ever instead of falling back to a plate. A loader that
 * can silently never answer is worse than one that answers "no". */
const SHEETS = new Map();            // path -> HTMLImageElement | null | undefined (loading)
const SHEET_WAIT = new Map();        // path -> [cb]
function sheet(path, cb) {
  if (!path) { cb(null); return; }
  if (SHEETS.has(path) && SHEETS.get(path) !== undefined) { cb(SHEETS.get(path)); return; }
  const waiting = SHEET_WAIT.get(path);
  if (waiting) { waiting.push(cb); return; }
  SHEET_WAIT.set(path, [cb]);
  SHEETS.set(path, undefined);
  const im = new Image();
  im.crossOrigin = "anonymous";
  im.onload = im.onerror = () => {
    const got = im.naturalWidth ? im : null;
    SHEETS.set(path, got);
    (SHEET_WAIT.get(path) ?? []).splice(0).forEach((f) => f(got));
    SHEET_WAIT.delete(path);
  };
  im.src = assetUrl(path);
}
/* One composed transition tile: mask frame (row, idx) + plate_a + plate_b,
 * through the library's published canvas ops. The result's alpha is the
 * silhouette because both plates already carry it and the mask is a subset. */
/* THE TOP-FACE MASK: the library silhouette minus its bottom WALL_D rows per
 * column — the stencil that lets a plate take one ground's WALL and another
 * source's TOP with drawImage alone. Built once from the 112-byte silhouette;
 * that is the ONLY getImageData in the transition path, deliberately: reading
 * ART pixels is what tainted on his phone before (the Grey Paving Clean #0
 * case), and a composite whose failure mode is the bug it exists to fix
 * cannot be load-bearing. If even the silhouette read fails, sides fall back
 * to today's flat-walled plates rather than to anything invented. */
let TOPFACE_MASK;                     // canvas | null (failed) | undefined (not tried)
const TOPFACE_WAIT = [];
function topFaceMask(cb) {
  if (TOPFACE_MASK !== undefined) { cb(TOPFACE_MASK); return; }
  TOPFACE_WAIT.push(cb);
  if (TOPFACE_WAIT.length > 1) return;
  const im = new Image();
  im.crossOrigin = "anonymous";
  im.onload = im.onerror = () => {
    let cv = null;
    if (im.naturalWidth) {
      /* NO PIXEL READS. The first cut derived this with getImageData, which
       * throws on a tainted canvas — and his phone taints (a cached no-CORS
       * image entry is enough; the documented poisoned-cache case). The
       * fallback was "no mask, flat plates", so on HIS phone every transition
       * wall composed flat while every gate here saw texture: the harness
       * differing from production in exactly the dimension under test, again.
       *
       * The same mask by construction instead: a pixel is TOP FACE iff the
       * silhouette is opaque there AND still opaque 17 rows further down
       * (columns are contiguous spans, so y+wall_d inside means y is above
       * the wall). That is the silhouette intersected with itself shifted up
       * — two drawImage calls, taint-immune, byte-identical to the pixel
       * derivation on the published silhouette. */
      cv = document.createElement("canvas");
      cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      const cx = cv.getContext("2d");
      cx.imageSmoothingEnabled = false;
      cx.drawImage(im, 0, 0);
      cx.globalCompositeOperation = "destination-in";
      cx.drawImage(im, 0, -17);
      cx.globalCompositeOperation = "source-over";
    }
    TOPFACE_MASK = cv;
    TOPFACE_WAIT.splice(0).forEach((f) => f(cv));
  };
  im.src = assetUrl(patternLib()?.silhouette ?? "tiles/patterns/silhouette.webp");
}
/* A SIDE PLATE WITH THE GROUND'S REAL WALL (maintainer 2026-08-28: "the
 * transition should work on the wall. Going from the x-over-x wall texture to
 * the y-over-y wall texture using the same transition mask" — and "asking for
 * wall help from x-over-x doesn't mean we will change the top texture. If I
 * select Set #6 I should see the Set #6 base set top textures").
 *
 * So a side is TWO sources: the ground's own x-over-x tile for the wall — the
 * only wall that was ever art — and the pass's face for the top. Composite ops
 * only: draw the x-over-x tile, then the face clipped through the top-face
 * mask over it. Both framings centre-align (a 64x46 plate at 0, the 64x64
 * review/tops framing at -9, wall foot on row 45 either way — measured).
 * Cached per (wall art, face); a virtual "tex2:<wall>::<face>" path names it
 * so mixFor's cache keys stay honest. */
/* tex2:<wall>::<face>::<clean> — the FACE may itself be a virtual path that
 * contains "::" (a pp: substitution does), so the wall is everything before
 * the FIRST separator and the clean everything after the LAST; the face is
 * the middle, verbatim. A naive split ate the pp: hex and the centre of every
 * detail field fell back to a broken URL. */
function parseTex2(p) {
  const body = p.slice(5);
  const i1 = body.indexOf("::"), i2 = body.lastIndexOf("::");
  if (i1 < 0) return { wall: body, face: null, clean: null };
  if (i2 === i1) return { wall: body.slice(0, i1), face: body.slice(i1 + 2), clean: null };
  return { wall: body.slice(0, i1), face: body.slice(i1 + 2, i2), clean: body.slice(i2 + 2) || null };
}
/* THE COMPOSE CACHES ARE CAPPED (2026-08-28): every browsed pair adds
 * composed canvases these maps held FOREVER, and a phone's renderer pays for
 * every backing store. FIFO — Map iteration order is insertion order. */
const CACHE_CAP = 600;
const capCache = (m) => { while (m.size > CACHE_CAP) m.delete(m.keys().next().value); };
const SIDE_CACHE = new Map();         // "wall::face::clean" -> canvas | null
function sidePlateCanvas(wallArt, face, clean, cb) {
  const key = `${wallArt}::${face}::${clean}`;
  if (SIDE_CACHE.has(key)) { cb(SIDE_CACHE.get(key)); return; }
  const lib = patternLib();
  let wImg = null, fImg = null, cImg = null, mask = null, silImg = null, left = 5;
  const done = () => {
    if (--left > 0) return;
    let cv = null;
    if (wImg && fImg && mask && silImg && lib) {
      const W2 = lib.frameW, H2 = lib.frameH;
      cv = document.createElement("canvas");
      cv.width = W2; cv.height = H2;
      const cx = cv.getContext("2d");
      cx.imageSmoothingEnabled = false;
      const cy = (img) => Math.round((H2 - (img.naturalHeight ?? img.height)) / 2);
      const cxx = (img) => Math.round((W2 - (img.naturalWidth ?? img.width)) / 2);
      cx.drawImage(wImg, cxx(wImg), cy(wImg));
      /* TWO BACKFILLS UNDER EVERYTHING. Review outlines vary a pixel from the
       * library silhouette both ways, and a FACE that is itself review-framed
       * art (a set member) shares the variance — so first the face stands
       * under the wall, and under them both the ground's CLEAN PLATE, whose
       * alpha IS the silhouette. Without the second, a rim pixel neither
       * source covered was filled by the compose from the OTHER side of the
       * transition: 14 grass pixels inside a pure paving tile, the stripe bug
       * in miniature, found by the gate comparing against both sources. */
      cx.globalCompositeOperation = "destination-over";
      cx.drawImage(fImg, cxx(fImg), cy(fImg));
      if (cImg) cx.drawImage(cImg, cxx(cImg), cy(cImg));
      cx.globalCompositeOperation = "source-over";
      const tmp = document.createElement("canvas");
      tmp.width = W2; tmp.height = H2;
      const tx = tmp.getContext("2d");
      tx.imageSmoothingEnabled = false;
      tx.drawImage(mask, 0, 0);
      tx.globalCompositeOperation = "source-in";
      tx.drawImage(fImg, cxx(fImg), cy(fImg));
      cx.drawImage(tmp, 0, 0);
      /* CLIPPED TO THE SILHOUETTE, both ways. A review outline can EXCEED the
       * library silhouette by a pixel as well as fall short of it — the same
       * ±1 variance — and an extra pixel survives every later composite (the
       * wang mask only ever clips plate_b; plate_a fills by destination-over).
       * Measured before the clip: 2 stray alpha pixels on black_rock ↔ snow. */
      cx.globalCompositeOperation = "destination-in";
      cx.drawImage(silImg, 0, 0);
      cx.globalCompositeOperation = "source-over";
    }
    SIDE_CACHE.set(key, cv); capCache(SIDE_CACHE);
    cb(cv);
  };
  sheet(lib?.silhouette ?? "tiles/patterns/silhouette.webp", (x) => { silImg = x; done(); });
  topFaceMask((m) => { mask = m; done(); });
  const mk = (path, set) => {
    // A face can be a pp: substitution (a raw top-only tile corrected to the
    // palette in the browser); it resolves to a canvas, which draws like an
    // image everywhere this function uses it.
    if (String(path).startsWith("pp:")) {
      const [a2, hex] = path.slice(3).split("::");
      ppFor(a2, hex, (c) => { set(c); done(); });
      return;
    }
    /* AND a sub:/tex: composite (a tile wearing a set member's top — the
     * pair page's face under any Set view). Loading these as URLs failed the
     * whole compose and the 5x5 centre drew as a HOLE (maintainer
     * 2026-08-28, Black Rock over black rock under Set #3). */
    if (String(path).startsWith("sub:")) {
      const [a2, b2] = path.slice(4).split("::");
      subFor(a2, b2, (c) => { set(c); done(); });
      return;
    }
    if (String(path).startsWith("tex:")) {
      const [a2, b2] = path.slice(4).split("::");
      texFor(a2, b2, (c) => { set(c); done(); });
      return;
    }
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = im.onerror = () => { set(im.naturalWidth ? im : null); done(); };
    im.src = assetUrl(path);
  };
  mk(wallArt, (x) => { wImg = x; });
  mk(face, (x) => { fImg = x; });
  if (clean) mk(clean, (x) => { cImg = x; });
  else done();
}
const MIX_CACHE = new Map();          // "row|idx|a|b" -> HTMLCanvasElement | null
function mixFor(row, idx, plateA, plateB, cb) {
  const key = `${row}|${idx}|${plateA}|${plateB}`;
  if (MIX_CACHE.has(key)) { cb(MIX_CACHE.get(key)); return; }
  const lib = patternLib();
  const bord = lib?.border ?? null;
  let a = null, b = null, maskS = null, bordS = null;
  let left = 3 + (bord ? 1 : 0);
  const done = () => {
    if (--left > 0) return;
    let cv = null;
    if (a && b && maskS && lib) {
      const W2 = lib.frameW, H2 = lib.frameH;
      const sx = idx * W2, sy = row * H2;
      cv = document.createElement("canvas");
      cv.width = W2; cv.height = H2;
      const cx = cv.getContext("2d");
      cx.imageSmoothingEnabled = false;
      /* A PLATE MAY ARRIVE ON A TALLER CANVAS. tiles/tops art is exact plate
       * content (2012 opaque px, the silhouette's own count) vertically
       * CENTERED on a 64x64 frame — the same rows-9..54 convention review
       * tiles use. Drawn at (0,0) it sat 9 rows low, so wherever the mask
       * wanted this side the top rows were transparent and destination-over
       * filled them from the OTHER side: the maintainer's paving set composed
       * with grass stripes through it (2026-08-28). Centering is exact for
       * both geometries: (46-46)/2 = 0 for a real plate, (46-64)/2 = -9 for
       * tops and review framing. Measured: foot-aligned tops cover the
       * silhouette with 0 uncovered pixels. */
      const plateY = (img) => Math.round((H2 - (img.naturalHeight ?? img.height)) / 2);
      const plateX = (img) => Math.round((W2 - (img.naturalWidth ?? img.width)) / 2);
      cx.drawImage(maskS, sx, sy, W2, H2, 0, 0, W2, H2);
      cx.globalCompositeOperation = "source-in";
      cx.drawImage(b, plateX(b), plateY(b));
      cx.globalCompositeOperation = "destination-over";
      cx.drawImage(a, plateX(a), plateY(a));
      cx.globalCompositeOperation = "source-over";
      /* THE 1PX SEAM (tiles agent b64c3f97d, maintainer verdict): a transition
       * is not a bare 0-100 cut through the mask — the two grounds meet along a
       * border, and without it this draws a hard edge the generator never drew.
       *
       * ONE MASK SERVES BOTH SIDES because it DARKENS what is already there:
       * each side comes out a darker shade of ITS OWN ground, never a blend of
       * the two — measured 5-8 per channel darker, never lighter. Black at
       * overlay_alpha over the border mask is exactly multiply by `tone`, so
       * the whole seam is one more drawImage and no per-pixel work.
       *
       * Frames 0 and 15 are empty on all 18 patterns (verified), so a field of
       * a single ground carries no marks — if a grid appears, the wrong frame
       * is being cut. The mask is symmetric under the polarity flip (verified,
       * 0 of 423,936 px differ), so `idx` here cannot get the seam backwards.
       * A third of it lies on the WALL, the vertical seam a cliff shows
       * edge-on, which is why it is drawn before nothing and after everything. */
      if (bordS) {
        const sc = document.createElement("canvas");
        sc.width = W2; sc.height = H2;
        const bx = sc.getContext("2d", { willReadFrequently: true });
        bx.imageSmoothingEnabled = false;
        bx.drawImage(bordS, sx, sy, W2, H2, 0, 0, W2, H2);
        /* EXACT, NOT ALMOST. The library's canvas_ops paint the seam as black
         * at overlay_alpha, which is multiply-by-tone in ideal arithmetic — but
         * canvas composites premultiplied in 8 bits, so it lands up to 2 per
         * channel away from the reference's own np.rint(v * tone). Measured on
         * four pairs: every seam pixel darkened, none lightened, max delta 2.
         *
         * Invisible, and still worth closing: the game will render these tiles
         * too, and a wiki that rounds differently makes every screenshot argue
         * with the build. So the seam is applied per pixel with the reference's
         * rounding — half-to-EVEN, which is np.rint and is NOT Math.round
         * (25 * 0.82 = 20.5 rints to 20 and rounds to 21).
         *
         * The published drawImage path is kept as the fallback for the one case
         * that cannot read pixels back: a tainted canvas, when the art comes
         * from an origin that refused CORS. Off by a rounding step beats not
         * drawing the seam at all. */
        try {
          const bd = bx.getImageData(0, 0, W2, H2).data;
          const im2 = cx.getImageData(0, 0, W2, H2);
          const px = im2.data, tone = bord.tone;
          const rint = (v) => {
            const f = Math.floor(v), d = v - f;
            return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1);
          };
          for (let i = 0; i < px.length; i += 4) {
            if (bd[i + 3] === 0 || px[i + 3] === 0) continue;
            px[i] = rint(px[i] * tone);
            px[i + 1] = rint(px[i + 1] * tone);
            px[i + 2] = rint(px[i + 2] * tone);
          }
          cx.putImageData(im2, 0, 0);
        } catch {
          bx.globalCompositeOperation = "source-in";
          bx.fillStyle = `rgb(${(bord.rgb ?? [0, 0, 0]).join(",")})`;
          bx.fillRect(0, 0, W2, H2);
          cx.globalAlpha = bord.alpha;
          cx.drawImage(sc, 0, 0);
          cx.globalAlpha = 1;
        }
      }
    }
    MIX_CACHE.set(key, cv); capCache(MIX_CACHE);
    window.__wikiMix = (window.__wikiMix ?? 0) + 1;   // gate probe
    cb(cv);
  };
  const mk = (path, set) => {
    /* A "tex2:<wall>::<face>" plate is composed first — the ground's x-over-x
     * wall wearing the pass's top. It resolves to a canvas; a canvas draws
     * like an image. When it cannot be built the FACE alone stands in, which
     * is exactly yesterday's plate — degradation to the previous behaviour,
     * never to something invented. */
    if (String(path).startsWith("tex2:")) {
      const { wall: wallArt, face, clean: cleanP } = parseTex2(path);
      sidePlateCanvas(wallArt, face, cleanP, (cv2) => {
        if (cv2) { set(cv2); done(); }
        else {
          const im2 = new Image();
          im2.crossOrigin = "anonymous";
          im2.onload = im2.onerror = () => { set(im2.naturalWidth ? im2 : null); done(); };
          im2.src = assetUrl(face);
        }
      });
      return;
    }
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = im.onerror = () => { set(im.naturalWidth ? im : null); done(); };
    im.src = assetUrl(path);
  };
  sheet(lib?.masks ?? "tiles/patterns/masks.webp", (x) => { maskS = x; done(); });
  // The seam is required, but a sheet that will not load must not take the
  // whole transition with it: the composite still draws, without its border.
  if (bord) sheet(bord.file, (x) => { bordS = x; done(); });
  mk(plateA, (x) => { a = x; });
  mk(plateB, (x) => { b = x; });
}
const transTile = (a, b, setId, i, post) =>
  `tiles/transitions/${a}__to__${b}/${setId}/${post ? "post/" : ""}tile_${String(i).padStart(2, "0")}.webp`;
/* WHAT ONE TRANSITION TILE SHOWS UNDER THE CURRENT PASS — one rule, so the
 * strips and the composed scenes cannot disagree (maintainer 2026-08-24: "Its
 * good that you fixed so the Transition page now renders After correctly. But
 * now it looks like Before instead fails to render correctly").
 *
 * It did: I taught wangScene to follow the switch and left both plain STRIPS —
 * the rows on the Transitions tab and the 16 corner tiles on the demo page —
 * passing the set's `post` FLAG where the pass belongs. They showed the
 * processed tiles under every setting, so Before looked identical to After.
 *
 * `hasPost` is whether the processed pass exists at all; the pass decides what
 * to draw with it. */
/* WHAT THE STRIP UNDER IT IS SHOWING (maintainer 2026-08-24: "If I press
 * 'Before' the pill still reads 'postprocessed'").
 *
 * It did, because the pill named what the SET HAS rather than what the page is
 * DRAWING — useful back when almost nothing had a processed pass, and merely
 * confusing now that 283 of 284 sets do. It names the pass on screen instead,
 * and the one set still lacking a processed pass says so, which is both what is
 * drawn AND the fact worth knowing about it. */
/* WHAT THE STRIP OR SCENE IS SHOWING, in words. The pill names what is DRAWN,
 * never what merely exists (maintainer 2026-08-24: "If I press Before the pill
 * still reads postprocessed") — and under the pattern library there are two
 * honest kinds of picture: a COMPOSED one (two plates through a mask, works
 * for every pair) and the generator's RAW art (exists only for pregenerated
 * pairs). */
function transPassPill(a, b, genSet) {
  const lib = patternLib();
  if (rawOn(genSet)) {
    return h("span", { class: "pill", title: "The generator's own pregenerated tiles for this pattern — one picture of both materials, which is why Raw belongs to the pair and not to a side" }, "raw · generated");
  }
  if (!lib) return h("span", { class: "pill warn" }, "pattern library missing");
  const la = passLabelOf(a, sideViewOf(a)), lb = passLabelOf(b, sideViewOf(b));
  return h("span", { class: "pill ok", title: "Composed live: each side is that ground's own choice through the pattern's mask — what the game will draw" },
    la === lb ? `composed · ${la}` : `composed · ${la} ↔ ${lb}`);
}
/* ONE COMPOSED TILE of pair (a, b) — pattern `patId`, Wang index `idxA` whose
 * bits mean "ground `a` owns the corner" (the pregenerated sets' own
 * convention, kept so scenes and captions did not have to change). The
 * LIBRARY's bits mean "side_b owns" with side_b fixed by side_order, so the
 * frame flips to 15-idxA when `a` is side_a — polarity is decided in exactly
 * one place, here, because backwards polarity still renders beautifully and
 * is exactly wrong. (x, y) are the cell's coordinates, so each side's plate is
 * that ground's own per-cell pick and a field of composed tiles varies the way
 * the ground itself does. */
function mixTile(a, b, patId, idxA, x, y) {
  const lib = patternLib();
  const pat = patternOf(patId);
  if (!lib || !pat) return null;
  const { sideA, sideB } = transSides(a, b);
  const frame = (a === sideB) ? idxA : 15 - idxA;
  /* Each side under ITS OWN ground's chosen view — the two radio groups — and
   * wearing ITS OWN x-over-x WALL (maintainer 2026-08-28: the flat plate wall
   * is not the focus but it is what the eye lands on, so the wall is the real
   * reviewed wall art, the top stays the set's, and at the boundary the wall
   * transitions through the same mask bands the top does). A ground without
   * an approved x-over-x tile keeps the plain plate. */
  const dress = (g, facePath) => {
    if (!facePath) return facePath;
    // the wall measured closest to THIS face — a set member is a top too
    const wall = bestWall(g, facePath).art ?? xoverxArt(g);
    const clean = lib.plates[g]?.clean ?? "";
    return wall ? `tex2:${wall}::${facePath}::${clean}` : facePath;
  };
  const pa = dress(sideA, platePickAt(sideA, x, y, sideViewOf(sideA)));
  const pb = dress(sideB, platePickAt(sideB, x, y, sideViewOf(sideB)));
  if (!pa || !pb) return null;
  return `mix:${pat.row}|${frame}|${pa}|${pb}`;
}
/* What one transition tile shows under the current pass — one rule, so the
 * strips and the composed scenes cannot disagree. Raw is the pregenerated art
 * and only exists where a generated set does; every other pass composes. */
const transArt = (a, b, patId, i, genSet, x = 0, y = 0) => {
  if (rawOn(genSet)) {
    // Raw art lives in the DIRECTORY's orientation: its files are named
    // <dirA>__to__<dirB> and a set bit means dirA. On a page reading the pair
    // the other way round, the path keeps the directory names and the index
    // flips — the same complement the mask polarity uses.
    const da = genSet.dirA ?? a, db = genSet.dirB ?? b;
    return transTile(da, db, patId, a === da ? i : 15 - i, false);
  }
  return mixTile(a, b, patId, i, x, y) ?? (genSet ? transTile(a, b, patId, i, genSet.post) : null);
};
/** Seeded RNG for the composites — a Randomize press swaps the seed, and the
 *  same seed always paints the same field (mulberry32; deterministic keeps the
 *  gates honest). */
function seededRnd(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A 3×3 with ONE tile pinned centre and the group around it — the member
 *  review's right half, and the promotion modal's whole point ("the model
 *  should show this tile in the center with members around it"). */
function centeredField(centerArt, members, seed, scale = 1, pass = null) {
  const box = h("div", { class: "iso-stage checker group-stage" });
  const rnd = seededRnd(seed);
  const others = members.length ? members : [{ weight: 1, hit: { cand: { art: centerArt } } }];
  const cells = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    // `pass` lets a caller compose in a pass other than the stored one — the
    // Details tab draws Textured even when the section is set to After,
    // because a clean-colour top is nothing to judge.
    const surroundCand = pickBaseMember(others, rnd).hit?.cand;
    const img = (c === 1 && r === 1) ? centerArt
      : (pass ? viewArtIn(pass, surroundCand) : viewArt(surroundCand));
    cells.push({ c, r, img });
  }
  const paths = [...new Set(cells.map((x) => x.img).filter(Boolean))];
  loadImages(paths, (images) => box.replaceChildren(isoScene(cells.filter((x) => x.img), images, scale, 4, worldIso())));
  return box;
}
/** A Wang-corner scene: `corner(x, y)` returns 1 where material A (the pair's
 *  first name — the set-bit material) owns the lattice point. Index per cell =
 *  8·NW + 4·NE + 2·SW + 1·SE, exactly the sets' own convention. */
/** A Wang-corner scene: `corner(x, y)` returns 1 where material A (the pair's
 *  first name) owns the lattice point. Index per cell = 8·NW + 4·NE + 2·SW +
 *  1·SE. Under Raw (a generated pair) the cells are the generator's tiles;
 *  under Clean/Set each cell is composed from the two grounds' plates, picked
 *  per cell so the field varies like the grounds themselves do. */
function wangScene(a, b, patId, genSet, n, corner, scale = 1) {
  const box = h("div", { class: "iso-stage checker trans-stage" });
  const cells = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const idx = 8 * corner(c, r) + 4 * corner(c + 1, r) + 2 * corner(c, r + 1) + corner(c + 1, r + 1);
    cells.push({ c, r, img: transArt(a, b, patId, idx, genSet, c, r) });
  }
  loadImages([...new Set(cells.map((x) => x.img).filter(Boolean))], (images) =>
    box.replaceChildren(isoScene(cells.filter((x) => x.img), images, scale, 4, worldIso())));
  return box;
}

/* THE PAIRS ARE READ LIVE FROM THE AGENT, NOT FROM THE BUILD.
 * Every other domain is settled art: a build a few hours old describes it
 * perfectly. Tiles 3.0 is a factory running right now — the matrix is 14
 * ground types over each other and 9 pairs existed the day this shipped — so
 * a baked list is stale by the time he opens it, and he would be reviewing
 * yesterday's generations while the agent waits on today's.
 *
 * So for the ADMIN the World section refetches `tiles/review/manifest.json`
 * from the repo, through the same staging root his art already comes from
 * (`ROOT`), and rebuilds the pairs from it. That is the tiles agent's own
 * published contract, so this cannot drift from what they meant. The baked
 * copy stays the fallback — and the whole thing is one ~30 KB fetch, once per
 * session, on a page only he opens.
 */
let worldLive = null;   // null = not fetched yet, [] = fetched and empty
let worldLiveAt = 0;    // when, for the unpinned-base revalidation below
/** The BAKED candidate for a key — data.json carries the build's own
 *  measurements, which the live manifest does not. */
let BAKED_CANDS = null;
/** Snapshot the baked candidates BEFORE the live list replaces them. */
function snapshotBaked() {
  if (BAKED_CANDS) return;
  BAKED_CANDS = new Map();
  for (const c of (state.data?.domains?.world ?? [])) {
    for (const x of (c.candidates ?? [])) BAKED_CANDS.set(x.key, x);
  }
}
function bakedCand(key) {
  if (!BAKED_CANDS) {
    BAKED_CANDS = new Map();
    for (const c of (state.data?.domains?.world ?? [])) {
      for (const x of (c.candidates ?? [])) BAKED_CANDS.set(x.key, x);
    }
  }
  return BAKED_CANDS.get(key) ?? null;
}
async function refreshWorldPairs() {
  if (!state.admin) return false;
  /* REVALIDATE WHEN THE BASE CANNOT GUARANTEE CONSISTENCY (tiles' ask,
   * 2026-08-27, after the audition holes: "so the names a page uses always
   * match the deployment it is fetching from"). Two regimes:
   *  - Base pinned to a SHA: one fetch per page life is CORRECT, not lazy —
   *    every URL under that sha is immutable, so refetching returns the same
   *    bytes and a rename on main cannot strand anything.
   *  - Base is `main` (the GitHub API rate-limited the pin — 60/hr, easy to
   *    hit from his phone) or an injected override: names can move under the
   *    page, so the manifest refetches when it is older than three minutes.
   *    With the tiles agent retaining current + one previous generation, a
   *    rename inside that window still resolves. */
  const unpinned = repoBase && /\/(main)\/$|127\.0\.0\.1|localhost/.test(repoBase.href);
  if (worldLive && (!unpinned || Date.now() - worldLiveAt < 3 * 60 * 1000)) return false;
  // THROUGH assetUrl, so it goes where the ART goes: tiles/ is a repo-only
  // domain and the image answers 404 for every path under it.
  const man = await fetchJson(assetUrl("tiles/review/manifest.json"));
  const cells = Object.entries(man?.cells ?? {});
  // A FAILED FETCH MUST NOT EMPTY THE SECTION (2026-08-17, on a World page
  // reading "0 ground types · 0 pairs"). worldLive doubles as the "already
  // refreshed" flag, so assigning [] both replaced the baked 56 pairs with
  // nothing AND made the guard above refuse to try again for the rest of the
  // session — one bad response and the section stayed empty until a reload.
  // Leaving it null keeps the baked list on screen and lets the next visit
  // retry: the live list is an IMPROVEMENT on the build, never a replacement
  // for it.
  if (!cells.length) return false;
  worldLiveAt = Date.now();
  const names = new Map((worldMeta().groundTypes ?? []).map((g) => [g.id, g.name]));
  const nice = (id) => names.get(id) ?? String(id ?? "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const dead = new Set(worldMeta().tombstoned ?? []);
  snapshotBaked();          // before worldLive replaces the baked list
  worldLive = cells.map(([id, cell]) => {
    const cands = (cell.candidates ?? []).map((c) => ({
      /* `tex` is the TEXTURED pass (tiles agent, 2026-08-27): the after tile
       * with its top face substituted from the RAW top against the ground's
       * palette hue and saturation, keeping the art's own relief — the wall
       * treatment, applied to the top. It is what a base tile actually looks
       * like, and without it every clean-top ground auditioned as flat colour.
       * Nullable: manifests written before that pass have no field. */
      key: c.key, art: c.after ?? c.file ?? null, raw: c.before ?? null, tex: c.textured ?? null,
      wallScore: c.wall_score ?? null, wall: c.wall ?? null, topShare: c.top_share ?? null,
      overhang: c.overhang ?? null, clarity: c.clarity ?? null, paletteTop: c.palette_top ?? null,
      tileId: c.tile_id ?? null, style: c.style ?? null, prompt: c.prompt ?? null,
      /* THE MEASUREMENTS SURVIVE THE LIVE REFRESH (maintainer 2026-08-29:
       * "Pressing top only will always pick the first tile and not match and
       * find the best"). tm/tflat/tk are measured at BUILD time — the browser
       * cannot decode 3,000 tiles — so a candidate rebuilt from the live
       * manifest had none, and bestWall's argmin, which runs only when the
       * face has stats, kept index 0 while still labelling itself "best
       * match". Carried over from the baked candidate of the same key, and
       * the tile's own published fields with them. */
      ...(() => {
        const b = bakedCand(c.key);
        return b ? { tm: b.tm ?? null, tflat: b.tflat ?? null, tk: b.tk ?? null,
          borrowWall: c.borrow_wall ?? b.borrowWall ?? null,
          topOnlyPub: c.top_only === true ? true : (b.topOnlyPub ?? null),
          ownTopPub: c.own_top === true ? true : (b.ownTopPub ?? null) }
          : { borrowWall: c.borrow_wall ?? null,
            topOnlyPub: c.top_only === true ? true : null,
            ownTopPub: c.own_top === true ? true : null };
      })(),
    }))
      .filter((c) => c.art && c.key)
      // BEST FIRST — the wiki's own promise, kept here because the manifest
      // stopped keeping it. Measured 2026-08-20 on black_rock over black_rock:
      // wall scores arrived 3.21, 4.33, 1.18, 3.78, … so "#1" named an
      // arbitrary tile and the panel's "ranked by wall score" pill was simply
      // false. The order is presentation, the KEY is identity, and verdicts
      // ride the key — so sorting here cannot disturb a single review.
      .sort((a, b) => (b.wallScore ?? -Infinity) - (a.wallScore ?? -Infinity));
    const top = cell.top ?? id.split("__over__")[0], side = cell.side ?? id.split("__over__")[1];
    return {
      id, name: `${nice(top)} over ${nice(side).toLowerCase()}`, top, side,
      path: `tiles/${id}`, preview: cands[0]?.art ?? null, candidates: cands,
      best: cands[0]?.wallScore ?? null, tombstoned: dead.has(id),
    };
  }).filter((c) => c.candidates.length).sort((a, b) => a.name.localeCompare(b.name));
  // An art file the manifest names but the repo has not pushed yet simply
  // fails to load and the card says so — the same contract as every other
  // domain. What must not happen is the LIST being older than the agent.
  const was = state.data.domains.world?.length ?? 0;
  state.data.domains.world = worldLive;
  syncCounts("world");
  // The live manifest OUTRANKS anything pruned from the baked list: a pair
  // dropped because the build named a path the agent has since renamed is not
  // deleted, it just moved, and the manifest is where it says so.
  pruned.world = 0;
  return worldLive.length !== was || true;
}
/** Passed / short of the agent's own acceptance bar, so a score reads as a
 *  verdict rather than a number. */
function wallVerdict(score) {
  const min = worldMeta().accept?.min_wall_score;
  if (score == null || min == null) return null;
  return score >= min
    ? { cls: "ok", text: `wall ${score} — over the bar (${min})` }
    : { cls: "warn", text: `wall ${score} — under the bar (${min})` };
}
/** Where a pair stands with HIM — entirely the sum of its tiles' verdicts,
 *  since a pair carries none of its own (see viewWorldPair). */
function cellReview(cell) {
  let approved = 0, rejected = 0;
  for (const c of cell.candidates) {
    const st = fb("tiles", c.key).status;
    if (st === "approved") approved++;
    else if (st === "rejected") rejected++;
  }
  if (approved) return { key: "picked", cls: "ok", text: `picked${approved > 1 ? ` (${approved})` : ""}` };
  if (rejected === cell.candidates.length) return { key: "redo", cls: "err", text: "all rejected — redo" };
  if (rejected) return { key: "partly", cls: "warn", text: `${rejected} of ${cell.candidates.length} rejected` };
  return { key: "open", cls: "", text: "not reviewed" };
}
// `cellReview` above survives as the SET's aggregate state — the pill on each
// card. The pair-level filter BAR it used to feed is gone (see viewWorldType):
// it duplicated the tile filter's vocabulary without its navigation, and the
// maintainer walked straight into the dead end. `wiki-world-filter` may still
// sit in a browser's localStorage; nothing reads it.
/* ------------------------------------------------ THE TILES WITH NO STAR
 * Maintainer 2026-08-20: "I have now reviewed all tiles in the new /tiles and
 * given 1 star to every tile that doesn't have an issue. The tiles-agent have
 * fixed everything I rejected, so I need to be able to filter on tiles that
 * doesn't have any stars ... If at least one tile inside a tiletype has null
 * stars, that tile group is visible and not filtered out. If I click on that
 * tile group I only see tiles with null stars. If I click on a tile 'next next
 * next' will iterate all tiles with null stars."
 *
 * A STAR IS THE MARK OF HAVING LOOKED. He rated the whole matrix once, the
 * agent regenerated what he rejected, and the replacements arrive carrying no
 * rating at all — so "no star" is exactly "new since my last pass", and this
 * filter is his inbox. It is deliberately a FILTER and not a sort (his own
 * correction mid-message): with 1,700 tiles a sort still makes him scroll past
 * the settled ones, and ‹ › would still walk into them.
 *
 * IT CASCADES THROUGH ALL THREE LEVELS, because the levels are one question
 * asked at three grains:
 *   overview   → ground types holding at least one unrated tile
 *   type page  → that type's pairs holding at least one unrated tile
 *   pair page  → only the unrated tiles, and ‹ › walks EVERY pair that has
 *                any — across types, which is what makes it an inbox rather
 *                than a per-type chore.
 */
/* ...AND THE SAME MACHINE ANSWERS THE VERDICT QUESTIONS (maintainer
 * 2026-08-20, immediately after the star pass: "Can you also add a filter for
 * rejected/approved/undecided? I will need this when I go over the set a
 * second time. Should work like the old filter.")
 *
 * A star and a verdict are different marks on the same tile — "I have looked
 * at this" and "this one is in / this one is out" — so the filter is ONE
 * pick-one control over five mutually exclusive questions rather than two bars
 * that could contradict each other. Everything below is written against a MODE
 * instead of a boolean, so the cascade, the ‹ › route, the counts and the
 * empty states are the same code for all five.
 *
 * `undecided` is NOT `no stars`: he starred tiles in the first pass without
 * approving them, so "not judged yet" and "not looked at yet" are genuinely
 * different sets, and the second pass is about the first of those. */
const WORLD_STAR_KEY = "wiki-world-stars";       // the key predates the modes
const WORLD_STARS = {
  all: { label: "all", title: "Every tile still in play — the ones you rejected sit behind the rejected chip, so a verdict you have already given never costs you the same glance twice" },
  unrated: { label: "no stars", title: "Only tiles you have neither starred nor judged — your actual inbox. A rejected tile is the AGENT's queue, not yours, so it does not show here" },
  rejected: { label: "rejected", title: "Only tiles you rejected — the ones the agent owes you a replacement for" },
  approved: { label: "approved", title: "Only tiles you approved — the set as it will ship" },
  undecided: { label: "undecided", title: "Only tiles with no verdict yet — neither approved nor rejected, whatever their stars" },
};
/** What each mode asks of ONE tile's feedback entry. */
const TILE_MATCH = {
  /* "ALL" IS EVERY TILE STILL IN PLAY, NOT EVERY TILE (maintainer 2026-08-29,
   * on a tile he threw out on the 23rd and kept meeting: "Why is this tile
   * visible in the wiki? ... I CAN STILL SEE THIS STUPID TILE!!!!"). His
   * rejection is recorded; the tiles agent has not carried it out, and 94 of
   * that day's rejections are in the same state — so the art is still in
   * their manifest and the wiki was dutifully listing it. A verdict he has
   * already given should not cost him the same glance twice: rejected tiles
   * live behind their own chip now, which is where he goes to see what the
   * agent owes him. */
  all: (e) => e.status !== "rejected",
  // NOT just "no star" (maintainer 2026-08-21, seeing a set of 7 tiles he had
  // rejected sitting in his no-stars inbox as "7 of 7 without a star": "Why
  // don't you maintain and remove old reviews I have already rejected?").
  // A star OR a verdict is him having dealt with the tile — a rejected tile
  // is the agent's TODO, not his — so the inbox is the tiles carrying
  // NEITHER.
  unrated: (e) => !e.rating && !e.status,
  rejected: (e) => e.status === "rejected",
  approved: (e) => e.status === "approved",
  undecided: (e) => !e.status,
};
/** How a count of them reads, and how "none of them" reads — the same phrase
 *  is needed on the overview pill, the set card, the pair pill and the ‹ ›
 *  crumb, and they must not drift apart. */
const TILE_MATCH_NOUN = { unrated: "waiting for you", rejected: "rejected", approved: "approved", undecided: "undecided" };
const TILE_MATCH_NONE = { unrated: "nothing waiting", rejected: "none rejected", approved: "none approved", undecided: "all decided" };
/** What the set page calls the panel it is filtering. */
const TILE_MATCH_PANEL = {
  unrated: "Tiles waiting for you", rejected: "Rejected tiles",
  approved: "Approved tiles", undecided: "Undecided tiles",
};
const TILE_MATCH_EMPTY = {
  unrated: "Every tile here is starred or judged — nothing waiting for you.",
  rejected: "Nothing here is rejected.",
  approved: "Nothing here is approved yet.",
  undecided: "Every tile here has a verdict.",
};
const starFilter = () => {
  try { const v = localStorage.getItem(WORLD_STAR_KEY); return WORLD_STARS[v] ? v : "all"; }
  catch { return "all"; }
};
const tileHit = (cand, mode) => (TILE_MATCH[mode] ?? TILE_MATCH.all)(fb("tiles", cand.key));
/** How many of a pair's tiles the mode keeps. */
const pairHits = (cell, mode) => (cell.candidates ?? []).filter((x) => tileHit(x, mode)).length;
const tileCount = (n, mode) => `${n} ${TILE_MATCH_NOUN[mode] ?? "shown"}`;
/** Every pair holding a matching tile, across ALL types, in the order the
 *  section lists them (type name, then pair name) — the ‹ › route when the
 *  filter is on. `keep` is the pair being viewed: it stays in the list even
 *  once he has marked its last tile, or the page he is standing on would fall
 *  out from under the pager mid-review. */
function filterRoute(mode, keep = null) {
  const out = [];
  for (const t of worldTypes()) {
    for (const c of t.pairs) {
      if (pairHits(c, mode) || (keep && c.id === keep.id)) out.push(c);
    }
  }
  return out;
}
/* SEE THE TILE BEFORE THE POSTPROCESS TOUCHED IT (maintainer 2026-08-17: "a
 * button/switch to view a tile before it was post processed. I think the
 * tiles-agent has prepared for this feature").
 *
 * They had: `tiles3/review@2` gives every candidate a `before` (the
 * generator's raw output) beside its `after` (what the game gets). This is the
 * viewer for it.
 *
 * The switch is a PREFERENCE, not a per-card toggle: he pages ‹ › through
 * pairs while judging one property at a time, and a mode that reset on every
 * page turn would make him re-press it 34 times. It also flips the overview,
 * so the section never shows two different truths at once.
 *
 * Both images are always in the DOM and CSS decides which is visible, so the
 * flip is instant and A/B actually comparable — a src swap re-decodes and the
 * blink is exactly what a comparison must not have. They are ~2 KB each. */
const WORLD_VIEW_KEY = "wiki-world-view";
/* THE PASS SWITCH IS THE GROUND'S SETS (maintainer 2026-08-25: "This also means
 * the 'After'/'Texture'/'Raw' instead will be 'Set #1'/'Set #2'/'Set #3'/'Raw'
 * ... So the wiki UI will with this change draw something like this: 'Clean
 * #0'/'Set #1'/'Set #2'/'Set #3'/'Raw'. And if no set has been created yet at
 * least draw: 'Clean #0'/'Raw'").
 *
 * WHAT EACH ONE MEANS NOW:
 *   Clean #0  the flat palette colour on top — what the game ships today, and
 *             what "After" used to be called. Renamed because it is no longer a
 *             pass of the postprocess, it is set 0 of the ground.
 *   Set #N    the ground as that set paints it, drawn with the SAME pick the
 *             game uses, so this is not an impression of the set — it is it.
 *   Raw       the generator's own output, untouched. Unchanged, and still
 *             stored as `before` so nobody's saved preference resets.
 *
 * "TEXTURED" IS GONE, and its going is the point. It was a browser-side GUESS at
 * what a kept texture might look like, because there was no data for it. A set
 * member is that texture as real art he chose, so the guess has nothing left to
 * do.
 *
 * IDS ARE THE SHARED VOCABULARY ACROSS GROUNDS. The stored value is one of
 * "clean" | "set:<id>" | "before", so a page showing many grounds at once can
 * offer "Set #1" and have each ground answer with its OWN set 1 — and a ground
 * that has no set 1 falls back to clean instead of showing nothing.
 */
const PASS_CLEAN = "clean";
const PASS_RAW = "before";
const PASS_TITLE = {
  [PASS_CLEAN]: "The ground's flat palette colour on top — what the game paints today wherever no set is used",
  [PASS_RAW]: "The generator's own output, untouched — original colours, original top, no postprocess at all",
};
/* His stored preference, migrated. `after` and `texture` are the old passes:
 * After IS Clean #0 under the new model, and Textured was a synthesis that sets
 * replace, so both land on clean rather than silently resetting to nothing. */
function storedPass() {
  let v = null;
  try { v = localStorage.getItem(WORLD_VIEW_KEY); } catch { /* private mode */ }
  if (v === "after" || v === "texture" || !v) return PASS_CLEAN;
  return v;
}
/* The passes a page can offer. A page about ONE ground offers that ground's
 * own sets between Clean and Raw. A page showing MANY grounds offers ONLY
 * Clean #0 and Raw (maintainer 2026-08-27: "Different ground types have
 * different number of base tile sets. So how is it possible to have a generic
 * change on this page? Some might have 1 some 3 some 8... The only safe
 * option here is Clean #0 ... Raw"). Offering the union of everyone's set
 * numbers was my invention, and he is right that it does not generalize. */
function passOptions(typeId, { raw = true } = {}) {
  const sets = typeId
    ? groundSets(typeId).filter((s) => s.id !== CLEAN_SET && setDraws(s))
    : [];
  return [
    [PASS_CLEAN, `Clean #${CLEAN_SET}`, PASS_TITLE[PASS_CLEAN]],
    ...sets.map((s) => [`set:${s.id}`, setLabel(s),
      `This ground painted with ${setLabel(s)}, drawn the way the game will draw it`]),
    // A transition's sides omit Raw — see the note on transRawWanted.
    ...(raw ? [[PASS_RAW, "Raw", PASS_TITLE[PASS_RAW]]] : []),
  ];
}
/** The pass in force on a page, after falling back to something it can show. */
function worldViewFor(typeId) {
  const v = storedPass();
  return passOptions(typeId).some(([id]) => id === v) ? v : PASS_CLEAN;
}
/* The STORED pass, unvalidated — for renderers that resolve per ground. A
 * stored "set:2" on a ground without set 2 falls to clean where the set is
 * looked up (passSet returns null), which is the per-ground fallback; running
 * it through worldViewFor(null) instead would clamp every set pass to clean
 * everywhere, because the many-grounds option list no longer names sets. */
const worldView = () => storedPass();
/** The set a pass names, or null for Clean/Raw. */
function passSet(typeId, view) {
  const m = /^set:(\d+)$/.exec(view ?? "");
  if (!m) return null;
  return groundSets(typeId).find((s) => s.id === +m[1]) ?? null;
}
/** One switch, wherever it appears — the ground in context decides the chips. */
const passBar = (typeId, onpick) =>
  sortBar(WORLD_VIEW_KEY, passOptions(typeId), worldViewFor(typeId), onpick);
/* ONE TILE CAN PEEK ON ITS OWN (maintainer 2026-08-17: "When looking at tiles
 * in Tiles in this set I sometimes want to toggle between before and after, but
 * that button might be higher up so I have to scroll. Can you place that button
 * so I have access to it for each tile?").
 *
 * The set-wide switch stays what it is — a MODE, remembered across pairs — and
 * every tile gets a chip on its own picture that overrides it for that tile
 * only. Overriding rather than flipping the mode is what makes it a comparison:
 * the tile under his thumb changes and the ones beside it hold still, so a
 * difference he sees is the postprocess and not the page.
 *
 * The override is DELIBERATELY NOT PERSISTED, and clears when the set-wide
 * switch is used or another pair is opened: it answers "what did this one look
 * like before", which is a question about the tile in front of him, not a
 * setting he wants to find again tomorrow.
 */
const tileViews = new Map();
let tileViewsPair = null;
const tileView = (key) => tileViews.get(key) ?? worldView();

/* THE 3.0 LATTICE CLOSES AT A PITCH OF 14, THE GAME DRAWS AT 15 (maintainer
 * 2026-08-17: "The new tiles are meant to be drawn with DY=14 and not DY=15 as
 * we used in the old tile system").
 *
 * It is the art that differs, not a preference: a 3.0 tile's top diamond is
 * 64x28, so a vertical pitch of 14 is the largest step at which each tile's
 * wall is fully covered by the tile in front of it. The tiles agent measured
 * every pitch from 12 to 17 by painting the top and the walls and counting wall
 * pixels that still have top surface below them — zero at 14, 960 at 15
 * (tiles/docs/GEOMETRY.md). That leak is the faint grid across a flat field and
 * the ragged step in a plateau's back edge.
 *
 * SO THE TWO GENERATIONS ARE DRAWN AT DIFFERENT PITCHES HERE, deliberately.
 * `games2/shared` ships ISO_DY = 15 and Tiles OLD keeps it — his verdict, shown
 * all three: "15 looks best on tiles2 (less zigzaggy), 14 looks best on tiles
 * 3.0" — and the constant moves to 14 with the switch to 3.0. Until then the
 * World section has to draw 3.0 the way 3.0 is meant to be drawn, or he would
 * be judging tiles through a projection they were never made for.
 *
 * NOT THE WIKI'S NUMBER TO INVENT: it is the tiles agent's measurement, and it
 * has been asked to publish the projection in its manifest so this follows the
 * art instead of tracking it by hand.
 */
const WORLD_DY = 14;
const worldIso = () => ({ ...(state.data.iso ?? { tilePx: 64, dx: 32, levelPx: 16 }), dy: WORLD_DY });
/** The pair of images every World card draws. `raw` is optional — a candidate
 *  from before @2 has none, and then there is nothing to compare and no switch
 *  worth showing on it. */
/* THE CARD THUMBNAIL FOLLOWS THE SWITCH TOO, and it is the ground in the tile's
 * OWN key that decides which sets are on offer — a grid mixes grounds, and each
 * card must answer with its own.
 *
 * Both layers stay in the DOM and CSS crossfades between them, which is what
 * makes this a comparison rather than a reload: the picture under his thumb
 * changes and the ones beside it hold still. A composed pass (a set's ground
 * substituted onto this wall) has no file to point an <img> at, so it is a
 * canvas painted when the composite answers — and falls back to the plain tile
 * rather than to an empty box if it cannot be built. */
/* The card thumbnail, following the switch. `viewOverride` exists for pages
 * that show MANY grounds and offer only Clean/Raw: their cards must render the
 * pass the page's own bar shows, not each card's private reading of the stored
 * preference — a bar saying Clean over cards drawing a set is the "Clean
 * doesn't clean" bug wearing a different hat. */
function worldArt(cand, alt, box = "thumb", viewOverride = null) {
  const top = candTop(cand);
  const v = viewOverride ?? worldViewFor(top);
  const showRaw = v === PASS_RAW && cand.raw;
  const set = passSet(top, v);
  /* Everything that is not Raw is COMPOSED now — a set member's top, or the
   * clean plate's. viewArtIn owns that decision; this only paints its answer. */
  const composed = showRaw ? null : viewArtIn(v, cand);
  const showSub = !!(composed && String(composed).startsWith("sub:"));
  const cv = showSub ? h("canvas", { class: "art-tex", "aria-label": `${alt} — ${set ? setLabel(set) : "clean top"}` }) : null;
  if (cv) {
    const [a, bArt] = composed.slice(4).split("::");
    const paint = (src, w2, ht) => {
      cv.width = w2; cv.height = ht;
      const cx = cv.getContext("2d");
      cx.imageSmoothingEnabled = false;
      cx.drawImage(src, 0, 0);
    };
    subFor(a, bArt, (c) => {
      if (c) paint(c, c.width, c.height);
      else { const im = new Image(); im.onload = () => { if (im.naturalWidth) paint(im, im.naturalWidth, im.naturalHeight); }; im.src = assetUrl(cand.art); }
    });
  }
  return h("div", { class: `${box} checker world-art${showRaw ? " on-before" : ""}${showSub ? " on-texture" : ""}` },
    h("img", { class: "art-after", src: assetUrl(cand.art), alt, loading: "lazy" }),
    cand.raw ? h("img", { class: "art-before", src: assetUrl(cand.raw), alt: `${alt} — raw, before postprocess`, loading: "lazy" }) : null,
    cv,
    // The badge is not decoration: mid-comparison, "which one am I looking
    // at" is the one question the screen must always answer. Clean gets no
    // badge — it is the ground's normal state, not a mode worth naming.
    showRaw ? h("span", { class: "art-tag" }, "raw") : null,
    set && showSub ? h("span", { class: "art-tag" }, setLabel(set)) : null,
    v === PASS_RAW && !cand.raw ? h("span", { class: "art-tag muted-tag" }, "no raw") : null);
}
/** The ground TYPES — grass, ice, snow — grouped from the pairs that use them
 *  as their walkable top. Derived rather than baked, so the live manifest
 *  refresh reshapes the whole section without a rebuild. */
function worldTypes() {
  const by = new Map();
  for (const c of worldCells()) {
    const t = c.top ?? "other";
    if (!by.has(t)) by.set(t, { id: t, name: typeLabelWorld(t), pairs: [] });
    by.get(t).pairs.push(c);
  }
  for (const t of by.values()) {
    t.pairs.sort((a, b) => a.name.localeCompare(b.name));
    // THE TYPE'S FACE IS ITS SELF PAIR — grass over grass, ice over ice
    // (maintainer 2026-08-17). A card that big shows the WALL as much as the
    // top, so picking the best-scoring tile from any pair meant "Grass" was
    // represented by grass over light soil and "Snow" by snow over parquet:
    // the thumbnail advertised the neighbour instead of the ground. Over
    // itself, everything in the picture is the type.
    //
    // Within that pair, a tile he has APPROVED outranks the highest-scoring
    // one — once he has picked, the pick is what this ground looks like.
    const self = t.pairs.find((p) => p.side === t.id);
    const faceOf = (p) => p && (p.candidates.find((c) => fb("tiles", c.key).status === "approved") ?? p.candidates[0]);
    // No self pair generated yet: fall back to the best tile anywhere, so a
    // type is never faceless while the agent is still filling the matrix.
    t.face = faceOf(self)
      ?? t.pairs.flatMap((p) => p.candidates).sort((a, b) => (b.wallScore ?? 0) - (a.wallScore ?? 0))[0]
      ?? null;
    t.selfFaced = !!self;
    t.open = t.pairs.filter((p) => cellReview(p).key === "open").length;
    t.picked = t.pairs.filter((p) => cellReview(p).key === "picked").length;
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}
const typeLabelWorld = (id) => (worldMeta().groundTypes ?? []).find((g) => g.id === id)?.name
  ?? String(id ?? "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/* THREE LEVELS, because that is how he thinks about ground (maintainer
 * 2026-08-17: "The top level tiles are still grass, ice, snow, etc. When
 * clicking on a tile type, lets say grass you will get to a page with all
 * different grass pairs/sets … Clicking on grass over snow will make it
 * possible to review every tile that is part of that set").
 *
 *   #/world                → the ground types
 *   #/world/<top>          → every pair that walks on that ground
 *   #/world/<top>/<side>   → the review page for one pair
 *
 * The pair is addressed by its two HALVES rather than its cell id: the pair
 * IS "grass over snow", and a url that says so survives the agent renaming
 * their cell keys.
 */
/* IS THE REVIEW UP TO DATE? — the question this section could never answer
 * (maintainer 2026-08-22, refusing to go on: "The wiki is full with already
 * reviewed stuff. I will not review until everything is up to date").
 *
 * He was right about what he saw and wrong about what it meant, and only
 * because nothing here ever told him: every page was full of reviewed tiles
 * because he had REVIEWED THEM ALL. The wiki showed him 3,990 cards and never
 * once said "7 of these are yours to do". A queue you cannot see the end of
 * looks identical to a queue nobody is working.
 *
 * So the section opens with its own ledger, counted live off the manifest and
 * his own verdicts — never a claim, never a cached number:
 *
 *   TILES     rated vs total, and exactly where the rest are.
 *   VERDICTS  his rejections that the tiles agent has already carried out —
 *             the tile is GONE from the manifest — against any still standing.
 *             This is the "is anyone acting on me" number.
 *   TOPS      the second axis, judged vs total. Untouched at 0 of 3,990,
 *             because until the Textured pass there was no way to see one.
 */
function reviewLedger() {
  const cells = worldCells();
  const tiles = cells.flatMap((c) => c.candidates.map((cand) => ({ cell: c, cand })));
  const judged = (k) => { const e = fb("tiles", k); return !!(e.rating || e.status); };
  const left = tiles.filter((x) => !judged(x.cand.key));
  const approved = tiles.filter((x) => fb("tiles", x.cand.key).status === "approved").length;
  // A rejection the agent has NOT acted on yet: the tile is still in the
  // manifest wearing his ✕.
  const standing = tiles.filter((x) => fb("tiles", x.cand.key).status === "rejected").length;
  // A rejection it HAS acted on: his verdict names a tile that no longer
  // exists. That orphan row is the receipt.
  const liveKeys = new Set(tiles.map((x) => x.cand.key));
  const entries = state.feedback.tiles?.entries ?? {};
  const carried = Object.keys(entries).filter((k) =>
    !k.endsWith("#top") && !liveKeys.has(k) && entries[k]?.status === "rejected").length;
  const tops = tiles.filter((x) => judged(topKey(x.cand.key))).length;
  const byPair = new Map();
  for (const x of left) {
    const id = `${x.cell.top}/${x.cell.side}`;
    byPair.set(id, { n: (byPair.get(id)?.n ?? 0) + 1, name: x.cell.name });
  }
  // Which ground has the most unjudged tops — where the top review starts.
  const topsBy = new Map();
  for (const x of tiles) {
    if (judged(topKey(x.cand.key))) continue;
    topsBy.set(x.cell.top, (topsBy.get(x.cell.top) ?? 0) + 1);
  }
  const biggestTops = [...topsBy.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  return { total: tiles.length, left, approved, standing, carried, tops, byPair, biggestTops };
}
function reviewLedgerPanel() {
  const L = reviewLedger();
  if (!L.total) return null;
  const done = L.total - L.left.length;
  const pairs = [...L.byPair.entries()].sort((a, b) => b[1].n - a[1].n);
  // FLOORED, never rounded: "100%" over seven unfinished tiles is the exact
  // lie this panel exists to stop telling.
  const pct = L.left.length ? Math.min(99, Math.floor((done / L.total) * 100)) : 100;
  const clear = !L.left.length && !L.standing;
  const line = (label, body, pill) => h("div", { class: "ledger-line" },
    h("span", { class: "ledger-label" }, label),
    h("span", { class: "ledger-body" }, body),
    pill ?? null);
  return h("div", { class: `panel ledger${clear ? " clear" : ""}` },
    h("div", { class: "panel-title" }, "Where the review stands",
      h("span", { class: `pill ${clear ? "ok" : "warn"}` },
        clear ? "up to date" : `${L.left.length + L.standing} waiting for someone`)),
    line("Tiles", `${done.toLocaleString()} of ${L.total.toLocaleString()} rated (${pct}%)`,
      L.left.length
        ? h("span", { class: "pill warn" }, `${L.left.length} left`)
        : h("span", { class: "pill ok" }, "all yours are done")),
    // WHERE the rest are, and one press to stand in front of them with the
    // inbox filter already on — the whole point of counting them.
    L.left.length ? h("div", { class: "ledger-jump" },
      ...pairs.slice(0, 3).map(([id, v]) => h("button", {
        class: "ghost-btn",
        title: `Open ${v.name} with the "no stars" filter on — ‹ › then walks only what is left`,
        onclick: () => {
          try { localStorage.setItem(WORLD_STAR_KEY, "unrated"); } catch { /* private mode */ }
          location.hash = `#/world/${id}`;
        },
      }, `${v.name} — ${v.n} left`)),
      pairs.length > 3 ? h("span", { class: "muted" }, `+${pairs.length - 3} more set${pairs.length - 3 === 1 ? "" : "s"}`) : null) : null,
    line("Your rejections", L.carried
      ? `${L.carried} carried out — the tiles agent deleted those tiles and moved on`
      : "none outstanding",
    L.standing
      ? h("span", { class: "pill warn", title: "Rejected, but the tile is still in the manifest — the agent has not run since" }, `${L.standing} not yet acted on`)
      : h("span", { class: "pill ok" }, "nothing waiting on the agent")),
    line("Tops", `${L.tops.toLocaleString()} of ${L.total.toLocaleString()} judged — the second axis, and the one that is open`,
      L.tops ? null : h("span", { class: "pill warn" }, "untouched")),
    L.biggestTops ? h("div", { class: "ledger-jump" },
      h("button", {
        class: "ghost-btn",
        title: "Open that ground's Details tab — every top nobody has judged, each one textured in the ground it would decorate",
        onclick: () => {
          groundTab.set(L.biggestTops[0], "details");
          // Open on a set if the ground has one — that is where a top is
          // visible at all. Clean would land him on the flat colour again.
          const firstSet = groundSets(L.biggestTops[0]).find((x) => x.id !== CLEAN_SET && setDraws(x));
          try { localStorage.setItem(WORLD_VIEW_KEY, firstSet ? `set:${firstSet.id}` : PASS_CLEAN); } catch { /* private mode */ }
          tileViews.clear();
          location.hash = `#/world/${L.biggestTops[0]}`;
        },
      }, `Start on ${typeLabelWorld(L.biggestTops[0]).toLowerCase()} — ${L.biggestTops[1].toLocaleString()} tops`),
      h("span", { class: "muted" }, "opens on a set, so you see the real top")) : null,
    /* WHICH FADE PAIRS ARE STILL UNTOUCHED (maintainer 2026-08-28: "I didn't
     * accept/reject everything, but if there is a pair that doesn't have a
     * single accept/reject I must have missed it"). A pair counts as visited
     * the moment ANY of its fade tiles carries a rating or a verdict — both
     * orientation halves merged, pairs with nothing published excluded (there
     * is nothing there to miss). */
    ...(() => {
      const pairsIdx = fadesIndex?.pairs;
      if (!pairsIdx) return [];
      const merged = new Map();
      for (const [k, list] of Object.entries(pairsIdx)) {
        const g = k.split("__to__").sort().join("|");
        if (!merged.has(g)) merged.set(g, []);
        merged.get(g).push(...list.map((t) => t.key));
      }
      const withTiles = [...merged.entries()].filter(([, keys]) => keys.length);
      const untouched = withTiles
        .filter(([, keys]) => !keys.some((k2) => { const e = fb("tiles", k2); return e.rating || e.status; }))
        .map(([g]) => g.split("|"))
        .sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));
      return [
        line("Fade tiles", untouched.length
          ? `${withTiles.length - untouched.length} of ${withTiles.length} published pairs carry your votes`
          : `every one of the ${withTiles.length} published pairs carries at least one of your votes`,
          untouched.length
            ? h("span", { class: "pill warn", title: "Pairs whose fade tiles have not a single rating or verdict from you" }, `${untouched.length} untouched`)
            : h("span", { class: "pill ok" }, "all visited")),
        untouched.length ? h("div", { class: "ledger-jump" },
          ...untouched.slice(0, 3).map(([a2, b2]) => h("button", {
            class: "ghost-btn",
            title: "Open the pair page — the fade review is at the bottom",
            onclick: () => { location.hash = `#/world/transition/${a2}__to__${b2}`; },
          }, `${typeLabelWorld(a2)} ↔ ${typeLabelWorld(b2).toLowerCase()}`)),
          untouched.length > 3 ? h("span", { class: "muted" }, `+${untouched.length - 3} more pair${untouched.length - 3 === 1 ? "" : "s"}`) : null) : null,
      ];
    })(),
    h("p", { class: "muted ledger-foot" },
      "Counted from the tiles agent's live manifest and your own verdicts, every time this page opens."));
}
function viewWorld() {
  // the fade ledger line needs the index; cached, so this is one fetch a session
  refreshFades().then((changed) => { if (changed && location.hash.replace(/^#\/?/, "").split("/")[0] === "world") route(); });
  // Fire-and-forget: the baked list draws immediately, the live one replaces
  // it a moment later. Re-rendering only when the fetch actually landed keeps
  // the page still on every visit after the first.
  refreshWorldPairs().then((changed) => { if (changed && location.hash.startsWith("#/world")) route(); });
  const all = worldCells();
  const mode = state.admin ? starFilter() : "all";
  const on = mode !== "all";
  const allTypes = worldTypes().filter((t) => matches(state.query, t.id, t.name));
  // Types holding at least one tile the mode keeps.
  const hitTypes = allTypes.filter((t) => t.pairs.some((c) => pairHits(c, mode)));
  const types = on ? hitTypes : allTypes;
  const hitTiles = allTypes.reduce((n, t) => n + t.pairs.reduce((m, c) => m + pairHits(c, mode), 0), 0);
  // One count per mode, on the control itself — the size of each job, computed
  // over the same tiles the cascade will filter.
  const modeTypes = (m) => (m === "all" ? allTypes.length : allTypes.filter((t) => t.pairs.some((c) => pairHits(c, m))).length);
  return h("div", {},
    sectionHead("world"),
    h("p", { class: "muted" }, state.admin
      ? "Tiles 3.0 — the ground system being built to replace Tiles OLD. Open a ground type to see every wall it can stand on."
      : "The ground of Nangijala. Open a ground to see the cliffs it makes where the land steps down."),
    // THE "WHAT IS NEW" PANEL IS GONE, for everyone (maintainer 2026-08-17,
    // first "I feel this is too technical for players that visits the World
    // page. Normal players will just get confused", then, still seeing it as
    // admin: "didn't you fix that landing page on World overview to not have
    // that text?"). Hiding it from players was the wrong read of the first
    // note: colour zones and outline passes are the factory describing its own
    // process, and the person who asked for the section already knows how it is
    // made. What a ground page owes anyone, him included, is the grounds.
    // THE SECTION'S OWN SIZE, never the filtered one: a filter narrowing the
    // grid must not rewrite what the section IS, and mixing a filtered type
    // count with a total pair count read as "1 ground types · 225 pairs".
    // How many the filter kept is the line under the control.
    state.admin ? h("p", { class: "muted" },
      `${allTypes.length} ground type${allTypes.length === 1 ? "" : "s"} · ${all.length} pair${all.length === 1 ? "" : "s"} · ${state.data.counts?.world_candidates ?? 0} candidates`) : null,
    // THE LEDGER FIRST — before a single card. "Is there anything for me?" is
    // the question he arrives with, and it must not require reading a grid.
    state.admin ? reviewLedgerPanel() : null,
    state.admin ? passBar(null, () => { tileViews.clear(); route(); }) : null,
    // HIS INBOX, at the top of the section that owns it. The counts are on the
    // control itself: "no stars 137" is the size of the job, and it going to 0
    // is what finishing looks like.
    state.admin ? sortBar(WORLD_STAR_KEY,
      Object.entries(WORLD_STARS).map(([id, f]) => [id, `${f.label} ${modeTypes(id)}`, f.title]),
      mode, () => route()) : null,
    state.admin && on ? h("p", { class: "muted" },
      hitTiles
        ? `${hitTiles} tile${hitTiles === 1 ? "" : "s"} ${TILE_MATCH_NOUN[mode]}, in ${hitTypes.length} ground type${hitTypes.length === 1 ? "" : "s"}. Open one and ‹ › walks every set that has any — across ground types.`
        : `${TILE_MATCH_EMPTY[mode]} Nothing to walk through.`) : null,
    types.length ? h("div", { class: "grid" }, ...types.map((t) =>
      h("a", { class: "card", href: `#/world/${t.id}` },
        // The OVERVIEW mixes grounds, so its bar offers only Clean/Raw and
        // every card renders exactly what the bar says — never a per-card
        // reading of a set preference the bar cannot express.
        t.face ? worldArt(t.face, t.name, "thumb", worldViewFor(null)) : h("div", { class: "thumb checker" }),
        h("div", { class: "card-name" }, t.name),
        h("div", { class: "card-sub" }, state.admin
          ? `${t.pairs.length} pair${t.pairs.length === 1 ? "" : "s"}`
          // "Pair" is the factory's word for it. A reader is being told what
          // this ground can sit on top of.
          : `over ${t.pairs.length} ground${t.pairs.length === 1 ? "" : "s"}`),
        h("div", { class: "card-badges" },
          // Under a filter the ONLY number that matters is how much of THIS
          // job is in here; the review pills describe a different pass.
          state.admin && on
            ? h("span", { class: `pill ${mode === "approved" ? "ok" : "warn"}` },
              tileCount(t.pairs.reduce((m, c) => m + pairHits(c, mode), 0), mode))
            : null,
          state.admin && !on && t.open ? h("span", { class: "pill warn" }, `${t.open} to review`) : null,
          state.admin && !on && t.picked ? h("span", { class: "pill ok" }, `${t.picked} picked`) : null))))
      : h("p", { class: "muted" }, state.admin && on
        ? `${TILE_MATCH_EMPTY[mode]} Nothing is waiting for you.`
        : "No pairs generated yet — the tiles agent publishes them to tiles/review/manifest.json."));
}
/** One ground type — TABS (maintainer 2026-08-21, third pass: "we have so
 *  much stuff here so it should be tabs. Base tiles is the first tab, but if
 *  we have none this tab is disabled and a user ends up on the second tab
 *  instead"). The identity card stays above the tabs — it is what the ground
 *  IS, whatever you are looking at. */
const groundTab = new Map();          // typeId -> the tab chosen this session
const baseFieldSeeds = new Map();     // "type/group" -> composite seed (Randomize)
const detailShown = new Map();        // typeId -> how much of the queue is unrolled
function viewWorldType(top) {
  refreshWorldPairs().then((changed) => { if (changed && location.hash.startsWith("#/world")) route(); });
  const types = worldTypes();
  const t = types.find((x) => x.id === top);
  if (!t) return h("p", {}, "Unknown ground type.");
  const mode = state.admin ? starFilter() : "all";
  const on = mode !== "all";
  const list = state.admin && on ? t.pairs.filter((c) => pairHits(c, mode)) : t.pairs;
  const meta = groundTypeMeta(t.id);
  const baseCol = groundBaseColor(t.id);
  const surface = SURFACE_LABEL[meta.surface] ?? null;
  /* EVERY GROUND HAS SETS — Clean #0 is always there, so the Base tab is never
   * empty for the admin who manages them. For a PLAYER a ground whose only set
   * is the flat colour still has nothing to look at, and his original rule
   * stands: "if we have none this tab is disabled and a user ends up on the
   * second tab instead". */
  const sets = groundSets(t.id);
  const setsToShow = sets.filter((x) => x.id !== CLEAN_SET && setDraws(x));
  const baseDead = !state.admin && !setsToShow.length;
  const trans = allTransitionsOf(t.id);
  const details = detailsOf(t.id);
  // the Slope tab's inventory — refreshed live so the count appears the day
  // the tiles agent publishes, with no deploy on this side
  refreshSlopes().then((changed) => { if (changed && location.hash.startsWith("#/world/")) route(); });
  const slopes = slopeTilesFor(t.id);
  const slopesDead = !state.admin && !slopes.some((x) => fb("tiles", x.key).status === "approved");
  const queue = state.admin ? detailQueue(t.id) : [];
  const swatch = (c, title) => h("span", {
    class: "swatch ground-swatch", title,
    style: `background:${/^#[0-9a-f]{3,8}$/i.test(c) ? c : "transparent"}`,
  });
  // The tab: his rule verbatim — Base tiles first, disabled when empty.
  const wanted = groundTab.get(t.id);
  const detailsDead = !details.length && !state.admin;   // a player with nothing to see
  const tab = (wanted === "base" && baseDead) || (wanted === "details" && detailsDead) || (wanted === "slope" && slopesDead) ? "ontop"
    : wanted ?? (baseDead ? "ontop" : "base");
  const pickTab = (id) => { groundTab.set(t.id, id); keepScrollY = window.scrollY; route(); };
  /* ON THE DETAILS TAB, "AFTER" IS NOTHING TO JUDGE (maintainer 2026-08-22:
   * "When I press Details I expect the tile in the center to be the textured
   * version … a textured version that has gone through the postprocessing in a
   * way that still align/change it's colors, but doesn't force the top to be
   * clean/single color").
   *
   * That is exactly the Textured pass. But this tab opened on After, where the
   * flattening leaves 96% of the top face one colour — so the one thing the
   * tab exists to judge was the one thing it hid.
   *
   * SCOPED TO THIS TAB, NOT WRITTEN TO HIS PREFERENCE. Flipping the stored
   * pass on arrival would silently change every other page in the section, so
   * the details compositions simply ask for texture when the stored pass is
   * After; Textured and Before are respected as chosen. The hint under the
   * switch says so rather than letting the chip disagree with the picture. */
  /* ON THE DETAILS TAB, THE CLEAN COLOUR IS NOTHING TO JUDGE (maintainer
   * 2026-08-22: "I expect the tile in the center to be the textured version").
   * So when the page is set to Clean this tab quietly asks for the ground's
   * first drawing set instead — SCOPED TO THIS TAB, never written to his
   * preference, because flipping the stored pass on arrival would silently
   * change every other page in the section. With no set built yet there is
   * nothing better to show and Clean stands. */
  /* THE SWITCH DRIVES THE DETAILS TAB DIRECTLY (maintainer 2026-08-28:
   * "doesn't matter what Tile art option I click on, nothing changes in the
   * preview"). The old redirect quietly swapped Clean for the first set —
   * meant kindly, and it made the control a placebo: with only the centre
   * textured now, Clean is a real thing to judge a detail against, so every
   * chip means itself. */
  const detailPass = () => worldViewFor(t.id);
  const tabBtn = (id, label2, count, disabled, title) => h("button", {
    class: `groundtab${tab === id ? " sel" : ""}${disabled ? " off" : ""}`,
    type: "button", title,
    ...(disabled ? { disabled: "disabled" } : {}),
    onclick: disabled ? null : () => pickTab(id),
  }, label2, count == null ? null : h("span", { class: "tab-n" }, String(count)));

  /* ---------------- TAB: base (the ground's sets) ---------------- */
  const baseTab = () => {
    const sets = groundSets(t.id);
    const setShares = shareOf(sets.map((s) => s.weight));
    const pool = basePool(t.id);
    const flatN = pool.filter((c) => (c.flat ?? 0) >= TOP_FLAT).length;
    const setPanel = (s, share) => {
      const okey = `${t.id}/${s.id}`;
      const origin = setOrigins.get(okey) ?? [0, 0];
      const rows = [{ clean: true, weight: s.clean }, ...s.members];
      const mShares = shareOf(rows.map((m) => m.weight));
      const dead = !setDraws(s);
      return h("div", { class: `panel base-set${s.weight > 0 ? "" : " off"}` },
        h("div", { class: "panel-title" }, setLabel(s),
          // THE SET'S OWN CHANCE, in the units he set the model in. A set at 0
          // is not broken — it is switched off, which is how he asked to keep
          // Clean around without the map agent ever using it.
          h("span", { class: `pill ${s.weight > 0 ? "ok" : ""}`, title: "How often an area of this ground picks this set" },
            s.weight > 0 ? `${sharePct(share)} of areas` : "never used"),
          state.admin && s.id !== CLEAN_SET ? h("button", {
            class: "ghost-btn", title: "Delete this set — its number is never reused, so nothing else repaints",
            onclick: () => { deleteSet(t.id, s.id); keepScrollY = window.scrollY; route(); },
          }, "Delete") : null),
        state.admin ? h("div", { class: "set-controls" },
          s.id === CLEAN_SET ? null : Object.assign(
            h("input", { type: "text", class: "set-name", value: s.name, maxlength: "24", "aria-label": "Set name" }),
            { onchange: (e) => { renameSet(t.id, s.id, e.target.value); keepScrollY = window.scrollY; route(); } }),
          weightBox(s.weight, "How likely an area of this ground uses this set. 0 means never — the set stays, the world stops picking it.",
            (v) => { setSetWeight(t.id, s.id, v); keepScrollY = window.scrollY; route(); })) : null,
        dead
          ? h("p", { class: "muted" }, "Nothing in this set can draw — give the clean colour or a tile some weight.")
          : setField(t.id, s, 5, origin, 1),
        !dead && state.admin ? h("button", {
          class: "ghost-btn", title: "Show a different patch of the world — every roll here is a real patch, so a set is good when they all look like the same ground",
          onclick: () => { setOrigins.set(okey, [origin[0] + 5, origin[1] + 3]); keepScrollY = window.scrollY; route(); },
        }, "🎲 Another patch") : null,
        h("div", { class: "set-rows" }, ...rows.map((m, i) => h("div", { class: `set-row${m.weight > 0 ? "" : " off"}${m.gone ? " gone" : ""}` },
          m.clean
            ? h("span", { class: "swatch ground-swatch", title: "The ground's flat palette colour", style: `background:${groundBaseColor(t.id)?.c ?? "transparent"}` })
            : m.art ? h("button", {
              class: "set-row-zoom", type: "button",
              title: "Look at this tile close up — and at a field of it alone, which is where a repeat shows",
              onclick: () => openTileZoom(t.id, m),
            }, artNodeFor(m.art, "set-row-tile", m.id))
              : h("span", { class: "swatch ground-swatch" }),
          h("span", { class: "set-row-name", title: m.clean ? null : m.id },
            m.clean ? "Clean colour" : m.gone ? `${memberLabel(t.id, m.id)} — art is gone` : memberLabel(t.id, m.id)),
          h("span", { class: "pill", title: "How much of this set's ground this row paints" }, sharePct(mShares[i])),
          state.admin && !(m.clean && s.id === CLEAN_SET) ? weightBox(m.weight,
            m.clean ? "How often this set paints the plain colour instead of a tile. 0 always draws with texture; make it the only weight and the set is all clean."
              : "How often this tile is drawn versus its set-mates",
            (v) => { (m.clean ? setCleanWeight(t.id, s.id, v) : setMemberWeight(t.id, s.id, m.id, v)); keepScrollY = window.scrollY; route(); }) : null,
          state.admin && !m.clean ? h("button", {
            class: "ghost-btn", title: "Take this tile out of the set — the tile itself is untouched",
            onclick: () => { removeSetMember(t.id, s.id, m.id); keepScrollY = window.scrollY; route(); },
          }, "Remove") : null))),
        // SET 0 CANNOT HOLD A TILE, by his rule — it "can only contain 100% the
        // clean/plain base color". The button is absent rather than disabled:
        // a control that exists but never works is a worse answer than none.
        /* Disabled ONLY when the ground has no approved tiles at all, which no
         * ground has today — every approved tile is a candidate, flat or not,
         * and whether a flat top belongs in a set is decided in the audition. */
        state.admin && s.id !== CLEAN_SET ? h("button", {
          class: "ghost-btn add-tiles", ...(pool.length ? {} : { disabled: "disabled" }),
          title: pool.length ? `Audition any of this ground's ${pool.length} approved tops — most textured first`
            : "No approved tiles for this ground yet",
          onclick: pool.length ? () => openPoolPicker(t.id, s.id, () => { keepScrollY = window.scrollY; route(); }) : null,
        }, "+ Add tiles…") : null);
    };
    return h("div", {},
      /* THE FACTORY LINE IS THE ADMIN'S. A reader saw "383 candidates to build
       * them from" — his review vocabulary — on a page that should talk about
       * ground (check-world's own rule; the count is meaningless without the
       * audition anyway). */
      h("p", { class: "muted" }, state.admin
        ? `${sets.length} set${sets.length === 1 ? "" : "s"} · ${pool.length} candidate${pool.length === 1 ? "" : "s"} to build them from` +
          (flatN ? ` (${flatN} with a flat top)` : "") + ". " +
        "A set is a group of tiles that look good together; the world picks ONE set for an area and stays with it, then varies inside it."
        : `The looks this ground comes in — the world picks one for an area and stays with it.`),
      ...sets.map((s, i) => setPanel(s, setShares[i])),
      state.admin ? h("button", {
        class: "ghost-btn new-set",
        title: "Start another look for this ground — a different side of the world can use it",
        onclick: () => { addSet(t.id); keepScrollY = window.scrollY; route(); },
      }, "+ New set") : null);
  };
  /* ---------------- TAB: on top of (the x-over-y matrix, as before) ------- */
  const onTopTab = () => h("div", {},
    state.admin ? sortBar(WORLD_STAR_KEY, Object.entries(WORLD_STARS).map(([id, f]) => {
      const n = id === "all" ? t.pairs.length : t.pairs.filter((c) => pairHits(c, id)).length;
      return [id, `${f.label} ${n}`, f.title];
    }), mode, () => route()) : null,
    list.length ? h("div", { class: "grid" }, ...list.map((c) => {
      const r = cellReview(c);
      const v = wallVerdict(c.best);
      return h("a", { class: "card", href: `#/world/${c.top}/${c.side}` },
        worldArt(c.candidates[0], c.name),
        h("div", { class: "card-name" }, on ? c.name : `over ${typeLabelWorld(c.side).toLowerCase()}`),
        state.admin ? h("div", { class: "card-sub" }, on
          ? `${pairHits(c, mode)} of ${c.candidates.length} ${TILE_MATCH_NOUN[mode]}`
          : `${c.candidates.length} tile${c.candidates.length === 1 ? "" : "s"}`) : null,
        h("div", { class: "card-badges" },
          state.admin && v ? h("span", { class: `pill ${v.cls}` }, `wall ${c.best}`) : null,
          state.admin && r.key !== "open" ? h("span", { class: `pill ${r.cls}` }, r.text) : null,
          state.admin && c.tombstoned ? h("span", { class: "pill err" }, "tombstoned") : null));
    })) : h("p", { class: "muted" }, state.admin && on
      ? TILE_MATCH_EMPTY[mode]
      : "Nothing in this filter."));

  /* ---------------- TAB: transitions ---------------- */
  /* THE PASS SWITCH DOES NOT REACH THIS TAB YET (maintainer 2026-08-24: "The
   * Transitions tab seem to always render Before/raw even when I have After
   * selected … Can you fix this or have the tiles-agent not committed all
   * states yet?").
   *
   * The second one: measured today, 0 of 284 sets carry a `post/` pass, so
   * there is no After for a transition to render and the switch above the tabs
   * has nothing to switch to. That was only ever said by a small pill on each
   * row, which is far too quiet for a control sitting right above it claiming
   * otherwise — so the tab says it in a line of its own, and names what is
   * missing. The moment the tiles agent publishes post/, every one of these
   * flips with no wiki change. */
  const transAnyGen = trans.some((x) => x.sets.length);
  const transTab = () => h("div", {},
    /* Group 1 of his two: how THIS ground is viewed on every pair below. The
     * second group is per pair — fourteen different neighbours cannot share
     * one — and lives on each pair's own page, where exactly two types exist. */
    state.admin && trans.length ? h("div", { class: `ground-pass${transRawWanted() && transAnyGen ? " idle" : ""}` },
      h("span", { class: "muted" }, t.name),
      sortBar(`trans-side-${t.id}`, passOptions(t.id, { raw: false }), sideViewOf(t.id),
        (id) => { setSideView(t.id, id); tileViews.clear(); keepScrollY = window.scrollY; route(); },
        { persist: false })) : null,
    /* Raw across the page. Enabled when ANY row was pregenerated; the rows that
     * were not keep composing and say so in their own pill, which is the honest
     * answer for a directory of fourteen neighbours with different histories. */
    state.admin && trans.length ? h("div", { class: "ground-pass" },
      h("span", { class: "muted" }, "Tile art"),
      sortBar("trans-raw", rawBarOptions(transAnyGen), transRawWanted() && transAnyGen ? PASS_RAW : "composed",
        (id) => { setTransRaw(id === PASS_RAW); tileViews.clear(); keepScrollY = window.scrollY; route(); },
        { persist: false })) : null,
    state.admin && trans.length ? h("p", { class: "muted" },
      "Each neighbour draws its own side as chosen on its pair page — open one for its second switch.") : null,
    state.admin && trans.length && fadesIndex?.pairs ? h("div", { class: "ground-pass" },
      h("span", { class: "muted" }, "Fade review"),
      sortBar("fade-order", [
        ["all", "all", "Every neighbour, in the usual order"],
        ["left", "most left first", "Neighbours with the most unreviewed fade tiles first"],
        ["todo", "to review", "Only neighbours that still have fade tiles without a verdict"],
      ], fadeOrderMode(), (id) => { try { localStorage.setItem(FADE_ORDER_KEY, id); } catch {} keepScrollY = window.scrollY; route(); }, { persist: false })) : null,
    trans.length
      ? h("div", {}, ...orderTransitions(trans, state.admin ? fadeOrderMode() : "all").map((x) => {
        const other = x.a === t.id ? x.b : x.a;
        // The strip previews the pair's DEFAULT look: the library's default
        // pattern (or the pair's straightest generated set under Raw), four
        // mixed indices, composed under the current pass.
        const patId = x.sets[0]?.id ?? patternLib()?.defaultPattern;
        const genSet = x.sets[0] ? { ...x.sets[0], dirA: x.dirA ?? x.a, dirB: x.dirB ?? x.b } : null;
        const picks = [1, 3, 12, 14].map((i) => transArt(x.a, x.b, patId, i, genSet)).filter(Boolean);
        return h("a", { class: "trans-row", href: `#/world/transition/${x.a}__to__${x.b}` },
          h("span", { class: "trans-name" }, `${t.name} ↔ ${typeLabelWorld(other).toLowerCase()}`),
          x.generated
            ? h("span", { class: "muted", title: "This pair was also pregenerated — its raw art is reachable under Raw" }, ` ${x.sets.length} generated set${x.sets.length === 1 ? "" : "s"}`)
            : null,
          transPassPill(x.a, x.b, genSet),
          state.admin ? fadeReviewPill(x.a, x.b) : null,
          h("div", { class: "trans-strip checker" }, ...picks.map((f) =>
            artNodeFor(f, "", `${t.name} to ${other} transition tile`))));
      }))
      : h("p", { class: "muted" }, state.admin
        ? "The pattern library has not been published yet (tiles/patterns/) — nothing to compose transitions from."
        : "The edges where this ground meets its neighbours are still being painted."));

  return h("div", {},
    crumbRow("#/world", `← ${label("world")}`, "world", types, t.id),
    h("div", { class: "sect-head" }, h("h1", {}, t.name)),
    h("div", { class: "spawn-line ground-idcard" },
      baseCol ? h("span", { class: "pill ground-base", title: `Base colour ${baseCol.c} — ${baseCol.from}` },
        swatch(baseCol.c), ` base ${baseCol.c}`) : null,
      /* AND WHAT ITS TEXTURE ACTUALLY AVERAGES TO, when that differs from the
       * clean colour (maintainer 2026-08-27: "our clean/plain tile single
       * color is not at all an avarage/median of how the tile top with texture
       * looks like ... How did you pick a ground types single/clean color?").
       * It was never measured from the art: it is palette.json types[g].top,
       * authored against tiles2. Measured against 3.0 it is 17-22 RGB units
       * off on grass, ice, light beach and light soil, and DARKER on all four
       * — which is exactly why a clean tile among textured ones reads as a
       * patch. palette.json belongs to the tiles agent, so the wiki's job is
       * to show the number, not to quietly draw a different colour than the
       * game will. */
      (() => {
        const avg = meta.topAvg, dec = baseCol?.c;
        if (!avg || !dec || !/^#[0-9a-f]{6}$/i.test(dec)) return null;
        const px = (h2) => [1, 3, 5].map((i) => parseInt(h2.slice(i, i + 2), 16));
        const [a, b2] = [px(dec), px(avg)];
        const gap = Math.round(Math.hypot(a[0] - b2[0], a[1] - b2[1], a[2] - b2[2]));
        if (gap < 8) return null;      // indistinguishable; no note earns its space
        const darker = a[0] + a[1] + a[2] < b2[0] + b2[1] + b2[2];
        return h("span", { class: "pill warn", title:
          `The clean colour is ${dec}, from the tiles agent's palette.json — it is NOT measured from this ground's art. Its textured tops average ${avg}, ${gap} RGB units ${darker ? "lighter" : "darker"} than the clean colour, which is why a clean tile among textured ones shows as a patch. Changing it is the tiles agent's call.` },
          swatch(avg), ` texture averages ${avg}`);
      })(),
      surface ? h("span", { class: `pill ${surface.cls}`, title: surface.title }, surface.text) : null,
      meta.category ? h("span", { class: "pill", title: meta.category === "liquid" ? "A liquid ground — bodies swim rather than walk" : "A solid ground — bodies walk on it" }, meta.category) : null),
    (meta.palette ?? []).length ? h("div", { class: "ground-palette", title: "The measured palette of this ground's own tiles — every colour its art actually uses, largest share first" },
      ...meta.palette.map((x) => swatch(x.c, `${x.c} — ${(x.share * 100).toFixed(1)}% of the painted pixels`))) : null,
    /* THE PASS SWITCH LIVES ABOVE THE TABS (maintainer 2026-08-21, after a
     * hunt: "I have browsed around on the entire wiki and can still not find a
     * way to render tiles without the 'clean color top'. This makes it
     * impossible to promote anything at all because promoted tiles will show
     * the real top").
     *
     * It WAS on two tabs of four — not on Base tiles, which is exactly where a
     * group is judged, and not inside the promote modal, which is exactly
     * where the promotion is decided. And the judgement is worthless in After:
     * the postprocess flattens a top to 96% one colour, so EVERY group hides
     * its seams and every field looks perfect. One switch, always on screen,
     * whatever tab is open. */
    /* NO EXPLAINING TEXT BESIDE THE SWITCH (maintainer 2026-08-25: "I don't
     * like the text to the right side of After/Textured/Raw … this makes the
     * entire site jump up and down when pressing the buttons. So it's hard to
     * see how the individual pixels changed due to the jump. And I don't need
     * this explaining text").
     *
     * The three hints were different lengths, so one wrapped to two lines and
     * another to one — the row changed height on every press and took the art
     * with it. A switch whose whole purpose is comparing two pictures must not
     * move the pictures. The chips keep their tooltips; that is where an
     * explanation belongs. */
    /* NOT ON THE BASE TAB (maintainer 2026-08-27: "When I click on the Base
     * tab - it makes no sense to be able to change the Tile art. That is for
     * reviewing other pages how they look with a different base set. This is
     * where you look at the individual base sets and looking at Set #2 as if
     * it was Set #1 makes no sense"). The editor's panels each draw their OWN
     * set; a pass switch above them is a control with nothing to control. It
     * stays on the review tabs, which is what it is for. */
    /* ...and not on Transitions either (maintainer 2026-08-27: "The tile art
     * here has to be per tile type") — that tab draws its own bar, labelled
     * with this ground's name, controlling this ground's SIDE of every pair.
     * The other side of each pair keeps its own choice, made on the pair's
     * page, so a global bar here would claim rows it does not control. */
    state.admin && tab !== "base" && tab !== "trans" && tab !== "slope" ? h("div", { class: "ground-pass" },
      h("span", { class: "muted" }, "Tile art"),
      passBar(t.id, () => { tileViews.clear(); keepScrollY = window.scrollY; route(); })) : null,
    h("div", { class: "groundtabs", role: "tablist" },
      // "Base", not "Base tiles" (maintainer 2026-08-25: "so the entire radio
      // button group/tabs fit on the page (it's cut right now)"). Four tabs
      // with counts overflowed a phone and clipped Transitions; the tooltip
      // still says what it is, and the tab that got shorter is the one whose
      // second word was doing the least work.
      /* NO COUNT ON BASE. The other tabs' counts are inventory he cannot
       * otherwise know (15 walls, 10 neighbours); the number of sets is his own
       * small number, visible the moment the tab opens — and adding a chip here
       * put the strip 3px over the edge again at 360px, which is the one thing
       * he asked this row never to do. */
      tabBtn("base", "Base", null, baseDead,
        state.admin ? "The sets this ground paints its fields from — what is in each, how often, and how often each set is used"
          : "The looks this ground comes in"),
      tabBtn("details", "Details", details.length || null, detailsDead,
        details.length ? "The tops that look amazing once in a while — this ground's small wonders" : state.admin ? "No details approved yet — the queue inside is your TODO" : "No details approved for this ground yet"),
      /* SHORT LABELS, ONE ROW (maintainer 2026-08-28: "We need to change the
       * title button to fit all buttons on the same row. You can call 'On top
       * of' just 'Wall' instead. You can call 'Transitions' just 'Fade'.").
       * Five tabs with counts wrapped to two rows at every phone width; his
       * words are the labels and the tooltips keep the long form. */
      tabBtn("ontop", "Wall", t.pairs.length, false, "Every wall this ground can stand on — the x-over-y matrix"),
      tabBtn("trans", "Fade", trans.length || null, false, "Where this ground meets its neighbours — the transitions, and the fade tiles that warm up to them"),
      /* SLOPE (maintainer 2026-08-28): a fifth tile type — the walkable ramp.
       * Present for the admin even before the tiles agent publishes, so the
       * review is ready the moment the art lands. */
      tabBtn("slope", "Slope", slopes.length || null, slopesDead,
        slopes.length ? "Ramps of this ground — one level split into two half steps, walkable without a jump"
          : state.admin ? "The tiles agent is generating slope tiles — this tab fills the moment their index lands"
            : "No slopes for this ground yet")),
    state.admin && !setsToShow.length && tab === "ontop" ? h("p", { class: "muted" },
      `This ground only draws its clean colour. Open Base to build a set from its ${basePool(t.id).length} textured candidates.`) : null,
    tab === "base" ? baseTab() : tab === "details" ? detailsTab() : tab === "trans" ? transTab() : tab === "slope" ? slopeTab() : onTopTab());

  /* ---------------- TAB: slopes — the walkable ramp (maintainer 2026-08-28:
   * "makes a 1 level block look like two 0.5 level blocks so the player can
   * run straight up without jumping ... We need the same as usual. A
   * Accept/Reject/Star/Note.") ---- */
  function slopeTab() {
    /* WALL-LESS SETS ARE PARKED, not listed (maintainer 2026-08-28, three
     * grounds in a row: parquet "still thin", slime, snow — the 64x30 batch
     * has no cliff in the art, so there is no ramp to review and 240 broken
     * cards per ground were only an invitation to keep reporting them).
     * One line says how many wait; the cards return when the tiles agent
     * republishes with a wall — the index is read live. */
    const all = state.admin ? slopes : slopes.filter((x) => fb("tiles", x.key).status === "approved");
    // one measurement per set, once; a set whose height arrives late re-renders
    const unmeasured = [...new Set(all.map((x) => x.set))].filter((d2) => d2 && !SLOPE_H.has(d2));
    if (unmeasured.length) {
      let left = unmeasured.length;
      for (const d2 of unmeasured) {
        const first = all.find((x) => x.set === d2);
        slopeHeight(d2, first.file, () => { if (--left <= 0) { keepScrollY = window.scrollY; route(); } });
      }
    }
    const parked = all.filter(slopeNoCliff).length;
    const list = all.filter((x) => !slopeNoCliff(x));
    if (!list.length && parked) return h("p", { class: "muted" },
      `All ${parked} slope tiles of ${t.name.toLowerCase()} came from wall-less sets — flat top faces with no cliff, nothing to walk up. The tiles agent was asked to regenerate them (2026-08-28); they appear here the moment the republished index lands.`);
    if (!list.length) return h("p", { class: "muted" }, state.admin
      ? "The tiles agent is generating slope tiles now (their jobs are queued in tiles/slopes/). The moment tiles/slopes/index.json lands on main, this tab fills with them — it reads live, no deploy in between."
      : `No slopes for ${t.name.toLowerCase()} yet.`);
    const shown = slopeShown.get(t.id) ?? 12;
    const parkedNote = parked ? h("p", { class: "muted" },
      `${parked} more tiles are parked: their sets shipped with no cliff, awaiting the tiles agent's regeneration.`) : null;
    const label2 = (x) => x.seed != null || x.amplitude != null
      ? ["slope", x.seed != null ? `seed ${x.seed}` : null, x.amplitude != null ? `amp ${x.amplitude}` : null].filter(Boolean).join(" · ")
      : x.key.split("/").slice(-2).join(" · ");
    return h("div", {},
      h("p", { class: "muted" }, `One level split into two half steps — the player runs straight up, no jump.${state.admin ? " Approve the ones the game may ship; reject the ones the tiles agent should regenerate." : ""}`),
      h("div", { class: "grid detail-grid" }, ...list.slice(0, shown).map((x) => h("div", { class: "card slope-card" },
        h("div", { class: "iso-stage checker slope-stage" }, artNodeFor(x.file, "slope-tile", x.key)),
        h("div", { class: "card-sub" },
          h("span", { class: "muted", title: x.key }, label2(x)),
          x.pair && x.pair.split("__over__")[1] !== t.id
            ? h("span", { class: "pill" }, `over ${typeLabelWorld(x.pair.split("__over__")[1]).toLowerCase()}`) : null,
          slopeNoCliff(x) ? h("span", { class: "pill err", title: "This set was generated with no wall — a flat top face only, so there is no ramp to judge. Regeneration asked of the tiles agent 2026-08-28; nothing to review here until it lands." }, "no cliff — awaiting regeneration") : null,
          x.cliff ? h("span", { class: "pill warn", title: "The tiles agent's post pass detected this cliff face as ANOTHER ground and palettized it that way — judge whether that reads right" },
            `cliff reads ${typeLabelWorld(x.cliff).toLowerCase()}`) : null),
        state.admin ? feedbackRow("tiles", x.key, {

          rejectTitle: "Not slope material — the tiles agent regenerates it on its next run",
          rejectedLabel: "slated for removal",
        }) : null))),
      list.length > shown ? h("button", {
        class: "ghost-btn", style: "margin-top:10px",
        onclick: () => { slopeShown.set(t.id, shown + 12); keepScrollY = window.scrollY; route(); },
      }, `Show 12 more (${list.length - shown} left)`) : null,
      parkedNote);
  }

  /* ---------------- TAB: ground details — "where the fun begins" ----------
   * The collection first (the tops he approved, each composed the way the
   * game will show it: alone in a field of the base ground), then the QUEUE —
   * every top nobody has judged, reviewable in place: "Then I will have
   * something TODO when I get bored :)" */
  function detailsTab() {
    const seedKey = `${t.id}/details`;
    const dSeed = baseFieldSeeds.get(seedKey) ?? 5;
    const shownQueue = detailShown.get(t.id) ?? 12;
    const dPass = detailPass();
    /* SIMPLIFIED TO THE ONE DECISION (maintainer 2026-08-28: "Remove the
     * 'add to a base tile set..' button and make the rating have normal
     * stars"). Promotion to a set lives on the Base tab's pool picker; this
     * card asks only "is this a detail, and how good".
     *
     * NO onStars ROUTE — that was the invisible-rating bug he reported
     * ("I can't see it getting any stars ... the 'x changes' just keep
     * counting up"): a rated tile leaves the judged-by-nobody queue, so the
     * re-route removed the card MID-TAP and the next tile slid under his
     * thumb — every further tap starred a different tile, one more pending
     * change each. The stars now fill in place and the card stays until the
     * next natural render. The roof glyph went with it: lit and dim ⌂ differ
     * only by colour, which is exactly what he could not see. */
    const detailCard = ({ cell, cand }) => h("div", { class: "card detail-card" },
      detailField(t.id, cand, dPass, [dSeed % 89, (dSeed * 7) % 83], 1),
      /* NO WALL PICKER ON A DETAIL (maintainer 2026-09-03: "Why did you add
       * the wall selector to details? A detail only has a top and will never
       * be displayed close to a wall so wall will never ever be visible...
       * This is why I review details alone in the center in a 5x5 grid").
       * He is right and the card said so above his head: the detail sits at
       * (2,2) of a 5x5 field, ringed on every side, so its wall is drawn
       * nowhere — in this preview or in the game. The picker offered 35
       * choices that changed nothing he could see, and invited a verdict on
       * art that is not part of the product. The tiles domain says the same
       * from its side: every detail sheet ships kind "top_only" with
       * wall_is_meaningless true. It stays on the BASE tab's top-only row,
       * where a borrowed wall really is drawn at a cliff edge and where he
       * asked for it (2026-08-28). */
      h("div", { class: "card-sub" },
        /* A TOP-ONLY TILE HAS NOWHERE TO LINK TO. It is not a cell — there is
         * no "over what" — so the link would have been #/world/<g>/null, a
         * dead end. It names its sheet instead, which is the only thing that
         * distinguishes one from another. */
        cell.topOnly
          ? h("span", { class: "muted", title: cand.key }, memberLabel(cell.top, cand.key))
          : h("a", { href: `#/world/${cell.top}/${cell.side}` }, `from ${cell.name.toLowerCase()}`),
        // Only ever says something when the picture is NOT what the switch
        // asked for: a tile with no raw generation cannot show a "before".
        dPass === PASS_RAW && !cand.raw
          ? h("span", { class: "pill warn", title: "No raw art for this tile (pre-@2 generation) — showing the postprocessed top" }, "after only")
          : null),
      state.admin ? h("div", { class: "card-sub" },
        feedbackRow("tiles", topKey(cand.key), {
          onchange: () => { keepScrollY = window.scrollY; route(); },
          // ...but not from a star: it fills in place and the card stays.
          onStarChange: null,
          /* THE CARD HOLDS STILL UNDER A STAR (maintainer
           * 2026-08-28: "when clicking on the rating today I can't see it
           * getting any stars. So I click again and again and the 'x changes'
           * just keep counting up"). A judged tile leaves the judged-by-nobody
           * queue, so re-rendering here slid the NEXT card under his thumb and
           * every further tap judged a different tile. It came back the moment
           * a star started writing the approval too (2026-09-03) and reached
           * this row's onchange; the star is now routed past it instead. An
           * explicit approve still moves the card into the collection, which is
           * its own pinned behaviour. */
          reject: "✕ not a detail",
          rejectTitle: "This top is not ground-detail material — the tile itself is untouched",
          rejectedLabel: "not a detail",
          note: false,
        })) : null);
    return h("div", {},
      h("p", { class: "muted" }, state.admin
        ? `The detail ONCE in the centre of the ground it would decorate. Tops that look amazing when they appear ONCE IN A WHILE — a flower, a stone, a glint. The wall never shows, so only the top is judged. ${dPass === worldViewFor(t.id) ? `Drawn ${dPass === PASS_RAW ? "RAW — the generator's own" : passSet(t.id, dPass) ? `in ${setLabel(passSet(t.id, dPass))}` : "on the clean colour"}, as the switch says.` : "Drawn in this ground's first set whatever the switch says: the clean colour flattens a top to one tone, which is nothing to judge. Pick Raw for the generator's own."}`
        : `The small wonders of ${t.name.toLowerCase()} — details that appear once in a while as you walk.`),
      h("div", { class: "panel" },
        h("div", { class: "panel-title" }, "This ground's details",
          h("span", { class: "pill" }, details.length ? `${details.length} approved` : "none yet"),
          h("button", { class: "ghost-btn", title: "Re-roll every composition", onclick: () => { baseFieldSeeds.set(seedKey, (dSeed * 16807 + 7) % 2147483647); keepScrollY = window.scrollY; route(); } }, "🎲 Randomize")),
        details.length
          ? h("div", { class: "grid detail-grid" }, ...details.map(detailCard))
          : h("p", { class: "muted" }, state.admin
            ? "Nothing approved yet — the queue below is where they come from."
            : "None yet — they are being picked right now.")),
      state.admin ? h("div", { class: "panel" },
        h("div", { class: "panel-title" }, "Tops nobody has judged",
          h("span", { class: "pill" }, String(queue.length)),
          h("span", { class: "muted", style: "font-weight:400;font-size:12.5px" }, " — your when-bored queue")),
        queue.length
          ? h("div", {},
            h("div", { class: "grid detail-grid" }, ...queue.slice(0, shownQueue).map(detailCard)),
            queue.length > shownQueue ? h("button", {
              class: "ghost-btn", style: "margin-top:10px",
              onclick: () => { detailShown.set(t.id, shownQueue + 12); keepScrollY = window.scrollY; route(); },
            }, `Show 12 more (${queue.length - shownQueue} left)`) : null)
          : h("p", { class: "muted" }, "Every top of this ground has been judged. Boredom will have to find something else.")) : null);
  }
}
/* ---- THE TRANSITION PAGE — a demo, not a list (maintainer 2026-08-21:
 * "Clicking on a transition will get you to that transition page. Here we can
 * show in preview how the transition looks like in different directions. See
 * it as a 'demo page' and a way for me to see all content without running
 * around in the game. Make the page look good and ambitious.") ---- */
const transState = new Map();   // pair -> { set, seed }
const fadeShown = new Map();    // unordered pair -> fade tiles shown (12 at a time)
/** The fade list's order for the pair being visited: { key, keys, firstDone }. */
let fadeOrder = { key: null, keys: [], firstDone: 0 };
/* ---- FADE TILES: both grounds on ONE top (maintainer 2026-08-28) ---------
 * "This is tiles the map-agent can use to start warming up the player for a
 * new ground-type long before the transition happens. So this is tiles
 * generated that have both ground type A and ground type B on the same tile.
 * I want to be able to approve/reject/give stars and add a note to all tiles
 * like this."
 *
 * READ LIVE, like the review manifest: the tiles agent is publishing these
 * now ("it will be in main soon"), and a section that waits for a wiki
 * deploy to notice them would be stale on arrival. Absent index = no
 * section; the moment tiles/fades/index.json lands on main, every pair page
 * grows its review list with no deploy on this side.
 *
 * THE CONTRACT (posted to the tiles board, theirs to counter-propose):
 *   { schema: "tiles3/fade-tiles@1",
 *     pairs: { "<a>__to__<b>": [ { key, file, pct: { "<a>": 62.5, "<b>": 37.5 } } ] } }
 * key must be STABLE for the life of the art (their own positional-key lesson)
 * — verdicts ride live/feedback/tiles.json on it, exactly like review tiles.
 * The % lives with the tile because the maintainer ruled it does: "I think
 * that data belongs to the tile."
 */
/* ---- SLOPES (maintainer 2026-08-28): "makes a 1 level block look like two
 * 0.5 level blocks so the player can run straight up without jumping." Read
 * LIVE like the fades: the tiles agent is generating now
 * (tiles/slopes/jobs.json), and the moment tiles/slopes/index.json lands on
 * main the Slope tab fills — no wiki deploy between their push and his
 * review. Contract posted to their board (tiles3/slopes@1); the reader takes
 * pairs keyed "<a>__over__<b>" or a grounds map, key+file required per tile,
 * everything else optional. */
let slopesIndex;                      // undefined = not fetched, null = absent
let slopesAt = 0;
async function refreshSlopes() {
  if (!state.admin) return false;
  /* WAIT FOR THE REPO BASE (maintainer 2026-08-28: "Slime shows nothing!
   * BUG!" — 236 tiles were on main). tiles/** is never in the deploy image,
   * so before the base resolves this URL is a guaranteed 404 against the
   * game's origin, and caching THAT as "no index" blanked the tab for the
   * life of the page. Nothing is remembered here: the next render retries. */
  if (!repoBase) return false;
  // a pinned page re-pins to HEAD first: the index is published while he
  // reviews, and the boot pin would otherwise hide it for the page's life
  if (slopesIndex !== undefined && Date.now() - slopesAt < 3 * 60 * 1000) return false;
  useMainRef();
  const idx = await fetchJson(assetUrl("tiles/slopes/index.json"));
  slopesAt = Date.now();
  const had = !!slopesIndex;
  // A failed fetch must not empty a tab that had data — the manifest law.
  if (!idx || (!idx.pairs && !idx.grounds && !idx.sets)) { if (slopesIndex === undefined) slopesIndex = null; return false; }
  slopesIndex = idx;
  return !had;
}
/** Every slope whose ground is this one — THEIR published shape first
 *  (tiles3/slopes@1, landed 2026-08-28: a LIST of Wang-on-elevation sets,
 *  16 tiles each, the corner bitmask meaning RAISED; the display file is
 *  dir/post/<post_files[i]> — "read the name, never build it" — and
 *  cliff_ground names the ground their post pass DETECTED on each cliff
 *  face). My proposed pairs/grounds-map shapes stay accepted. */
function slopeTilesFor(typeId) {
  if (!slopesIndex) return [];
  const out = [];
  for (const set of (Array.isArray(slopesIndex.sets) ? slopesIndex.sets : [])) {
    if (set?.ground !== typeId || !set.dir) continue;
    const n = set.n_tiles ?? Object.keys(set.tiles ?? {}).length;
    for (let i = 0; i < n; i++) {
      const pf = set.post_files?.[i];
      const raw = set.tiles?.[String(i)];
      const file = pf ? `${set.dir}/post/${pf}` : raw ? `${set.dir}/${raw}` : null;
      if (!file) continue;
      out.push({
        key: `${set.dir}/tile_${String(i).padStart(2, "0")}`, file, pair: null,
        // 64x46 = top + one level of wall; 64x30 = top face only, which
        // cannot be a slope at all (maintainer 2026-08-28: "super thin and
        // doesn't look like the other tiles generated"). Reported to tiles.
        // measured, never declared — see slopeHeight below
        set: set.dir,
        cliff: set.cliff_ground?.[i] && set.cliff_ground[i] !== set.ground ? set.cliff_ground[i] : null,
      });
    }
  }
  const grounds = slopesIndex.grounds;
  for (const [k, list] of Object.entries(slopesIndex.pairs ?? {})) {
    if (k.split("__over__")[0] !== typeId) continue;
    for (const t of list ?? []) if (t?.key && t?.file) out.push({ ...t, pair: k });
  }
  if (grounds && !Array.isArray(grounds)) {
    for (const t of (grounds[typeId] ?? [])) if (t?.key && t?.file) out.push({ ...t, pair: null });
  }
  return out;
}
const slopeShown = new Map();         // typeId -> how many slope cards are unrolled
/* IS THIS SET WALL-LESS? MEASURED, NOT DECLARED (maintainer 2026-08-29:
 * "Parquet Floor has no slope in the wiki" — the tiles agent had already
 * republished those five grounds at 64x46 with real walls, but left `size`
 * at [64,30] in the index, and the parking trusted it. A file's own height
 * is the fact; the field is a claim). One image per SET, cached; unknown
 * counts as fine, so a slow measurement never hides art. */
const SLOPE_H = new Map();            // set dir -> measured frame height
function slopeHeight(dir, file, cb) {
  if (SLOPE_H.has(dir)) { cb(SLOPE_H.get(dir)); return; }
  const im = new Image();
  im.onload = () => { SLOPE_H.set(dir, im.naturalHeight); cb(im.naturalHeight); };
  im.onerror = () => { SLOPE_H.set(dir, null); cb(null); };
  im.src = assetUrl(file);
}
const slopeNoCliff = (t) => (SLOPE_H.get(t.set) ?? 99) < 40;

let fadesIndex;                       // undefined = not fetched, null = absent
let fadesAt = 0;
async function refreshFades() {
  if (!state.admin) return false;
  /* WAIT FOR THE REPO BASE (maintainer 2026-08-28: "Slime shows nothing!
   * BUG!" — 236 tiles were on main). tiles/** is never in the deploy image,
   * so before the base resolves this URL is a guaranteed 404 against the
   * game's origin, and caching THAT as "no index" blanked the tab for the
   * life of the page. Nothing is remembered here: the next render retries. */
  if (!repoBase) return false;
  // a pinned page re-pins to HEAD first: the index is published while he
  // reviews, and the boot pin would otherwise hide it for the page's life
  if (fadesIndex !== undefined && Date.now() - fadesAt < 3 * 60 * 1000) return false;
  useMainRef();
  const idx = await fetchJson(assetUrl("tiles/fades/index.json"));
  fadesAt = Date.now();
  const had = !!fadesIndex;
  // A failed fetch must not empty a section that had data — same law as the
  // review manifest. null only when we have never seen it.
  if (!idx?.pairs) { if (fadesIndex === undefined) fadesIndex = null; return false; }
  fadesIndex = idx;
  return !had;
}
/* The pair's fade tiles, sorted for THIS page: the page's first ground's
 * share, highest first — "The Grass ↔ ice page should sort the list so tiles
 * with the highest percentage of grass is at the top", and the reversed page
 * the other way round, same tiles. */
function fadeTilesFor(a, b) {
  const pairs = fadesIndex?.pairs;
  if (!pairs) return [];
  /* BOTH ORIENTATION KEYS, MERGED. The published index (tiles3/fade-tiles@1,
   * landed 2026-08-28) keys each tile by its GENERATION direction, so one
   * unordered pair appears as two keys with disjoint tile lists — grass↔ice
   * is 26 under grass__to__ice plus 26 under ice__to__grass. Taking either
   * alone shows each page direction a different half, which is exactly what
   * the maintainer ruled out: "both pages will ofc show the same tiles
   * (since it's the same transition)". Deduped by key in case the tiles
   * agent ever republishes a tile under the flipped orientation. */
  const seen = new Set();
  const list = [...(pairs[`${a}__to__${b}`] ?? []), ...(pairs[`${b}__to__${a}`] ?? [])]
    .filter((t) => t && t.key && !seen.has(t.key) && seen.add(t.key));
  return list
    .filter((t) => t.file && t.pct && isFinite(t.pct[a]))
    .map((t) => ({ key: t.key, file: t.file, pctA: +t.pct[a], pctB: isFinite(t.pct[b]) ? +t.pct[b] : 100 - +t.pct[a] }))
    .sort((x, y) => y.pctA - x.pctA);
}
/* HOW MUCH OF A PAIR'S FADE REVIEW IS LEFT (maintainer 2026-09-02: "I have a
 * hard time knowing how much fade tiles I have left to review for a given
 * tile pair ... It's very hard to click on each pair to see if I have
 * reviewed this already or not"). One number per pair, computed from the
 * same list the pair page reviews: total tiles, and how many still carry
 * neither approve nor reject. `null` while the index has not loaded — that
 * is "unknown", never "0 left". */
const fadeJudged = (k) => { const st = fb("tiles", k).status; return st === "approved" || st === "rejected"; };
function fadeReview(a, b) {
  if (!fadesIndex?.pairs) return null;
  const tiles = fadeTilesFor(a, b);
  const left = tiles.filter((t) => !fadeJudged(t.key)).length;
  return { total: tiles.length, left, done: tiles.length - left };
}
/** The pill that says it — on the Fade tab's rows and wherever a pair is listed. */
function fadeReviewPill(a, b) {
  const r = fadeReview(a, b);
  if (!r) return h("span", { class: "pill muted fade-left", title: "The fade index has not loaded yet" }, "fade tiles: …");
  if (!r.total) return h("span", { class: "pill muted fade-left", "data-left": "0", "data-total": "0", title: "The tiles agent has published no fade tiles for this pair" }, "no fade tiles");
  if (!r.left) return h("span", { class: "pill ok fade-left", "data-left": "0", "data-total": String(r.total), title: `All ${r.total} fade tiles carry your approve or reject` }, `fades: all ${r.total} reviewed`);
  return h("span", { class: "pill warn fade-left", "data-left": String(r.left), "data-total": String(r.total), title: `${r.left} of ${r.total} fade tiles still without an approve or reject` }, `${r.left} of ${r.total} fades left`);
}
/* THE FADE TAB'S OWN ORDER (same ask): "left first" sorts the neighbours by
 * how many fade tiles still wait, most first; "to review" hides the pairs
 * that are done. Persisted, and the pair page's ‹ › walks the same order. */
const FADE_ORDER_KEY = "wiki-fade-order";
const fadeOrderMode = () => { try { return localStorage.getItem(FADE_ORDER_KEY) || "all"; } catch { return "all"; } };
function orderTransitions(list, mode) {
  if (mode === "all" || !fadesIndex?.pairs) return list;
  const withN = list.map((x) => ({ x, r: fadeReview(x.a, x.b) ?? { left: 0, total: 0 } }));
  const kept = mode === "todo" ? withN.filter((e) => e.r.left > 0) : withN;
  return kept.sort((p, q) => q.r.left - p.r.left || q.r.total - p.r.total).map((e) => e.x);
}
/* One fade tile, reviewed IN THE FIELD: the wandering-edge scene at rough
 * 0.12 · s4 (his pick), with every pure cell of the tile's MAJORITY side
 * drawn as the fade tile — "display the fade tile on the grass side if grass
 * is >= 50%" — dressed in that ground's own x-over-x wall like everything
 * else, and the boundary composed as it really is. A field, not a lone tile,
 * because a tile the map agent will scatter is judged by how it repeats. */
/* DOES THIS TILE'S GROUND MATCH THE GROUND IT LANDS ON? (maintainer
 * 2026-09-03, on grey paving ↔ light beach: "I really feel the Grey Paving
 * Stone is fading into the wrong grey colour ... the grey always feels out of
 * touch ... it's almost as if the stone belongs to brown paving stone.")
 *
 * He was right, and it is measurable: the paving field is RGB(167,166,170) —
 * a slight BLUE cast — while all 67 fade tiles that stand in it are warmer,
 * the worst by b* +17, which is 18% of the way to brown paving stone. The
 * cause is in the tiles domain (palette.json defines that ground as perfectly
 * neutral, #a8a8a8, so a normalized tile is neutral at best and drifts warm
 * from there) and is posted to their board — but the JUDGEMENT is his, every
 * card, and an eye cannot hold a 2-point b* difference across a scroll.
 *
 * So the card says it. Measured off the COMPOSED CANVAS, never from the
 * manifest: the fade tile's own diamond against a pure field diamond in the
 * same scene, which is exactly the comparison his eye is making. Median, not
 * mean — one bright rock must not move the reading. */
const medianRgb = (px) => [0, 1, 2].map((k) => {
  const v = px.map((p) => p[k]).sort((a, b) => a - b);
  return v[v.length >> 1];      // median, never mean: one bright rock must not move the reading
});
function srgbToLab([r, g, b]) {
  const f = (v) => { v /= 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; };
  const [R, G, B] = [f(r), f(g), f(b)];
  const xyz = [(0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047,
               (0.2126 * R + 0.7152 * G + 0.0722 * B),
               (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883];
  const t3 = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const [fx, fy, fz] = xyz.map(t3);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];   // b* is the warm/cool axis
}
/** One cell's TOP FACE, off the scene that was just drawn. The rim is left out
 *  — those pixels belong to neither cell — and a tainted canvas throws here,
 *  which the caller reads as "no reading" rather than as a match. */
function diamondPixels(ctx, iso, pad, c, r, N) {
  const x0 = (c - r) * iso.dx + (N - 1) * iso.dx + pad;      // px(cell) − minX + pad
  const y0 = (c + r) * iso.dy + pad;                          // py(cell) − minY + pad
  const cx = x0 + iso.tilePx / 2, cy = y0 + iso.dy;
  const w = Math.round(iso.dx), hgt = Math.round(iso.dy);
  let d;
  try { d = ctx.getImageData(Math.round(cx - w), Math.round(cy - hgt), w * 2, hgt * 2).data; } catch { return null; }
  const out = [];
  for (let y = 0; y < hgt * 2; y++) for (let x = 0; x < w * 2; x++) {
    if (Math.abs(x - w) / w + Math.abs(y - hgt) / hgt > 0.7) continue;
    const i = (y * w * 2 + x) * 4;
    if (d[i + 3] > 200) out.push([d[i], d[i + 1], d[i + 2]]);
  }
  return out.length > 60 ? out : null;
}
/** The chip: how far this tile's ground is from the ground around it, and
 *  WHICH WAY — "warm" and "cool" are the words he used, so they are the words
 *  it says. Under 3 dE is a match; a difference he can see starts around 5. */
function toneChip(tileLab, fieldLab, ground) {
  const dE = Math.hypot(tileLab[0] - fieldLab[0], tileLab[1] - fieldLab[1], tileLab[2] - fieldLab[2]);
  const db = tileLab[2] - fieldLab[2];
  const way = Math.abs(db) < 1 ? "" : db > 0 ? " warm" : " cool";
  const title = `This tile's ${ground.replace(/_/g, " ")} reads L*${tileLab[0].toFixed(1)} b*${tileLab[2].toFixed(1)}; the ground it stands on reads L*${fieldLab[0].toFixed(1)} b*${fieldLab[2].toFixed(1)}. Positive b* is warmer (toward brown), negative is cooler (toward blue). Measured off this very scene, top face against top face.`;
  const cls = dE < 3 ? "ok" : dE < 6 ? "" : "warn";
  return h("span", { class: `pill ${cls} tone-chip`, "data-de": dE.toFixed(1), "data-db": db.toFixed(1), title },
    dE < 3 ? "tone: matches the field" : `tone: ${dE.toFixed(0)} off${way}`);
}
const FADE_PATTERN = "a12_s4";
function fadeScene(a, b, tile) {
  const N = 6;
  const onA = tile.pctA >= 50;
  /* ONE EDGE FOR EVERY SCENE, held near the middle (maintainer 2026-08-28:
   * "you should not randomize the 'A wandering edge'. Keep it the same and
   * somewhat centered"). The seed is a constant, so every card on the page —
   * and every visit — walks the identical boundary: the tile under review is
   * the only variable. The walk is clamped one column off either border so
   * both grounds always keep a pure column for the tile to stand in. */
  const rnd = seededRnd(fnv1a("fade|edge") || 1);
  const walk = [];
  let wx = Math.floor(N / 2) + 1;
  for (let y = 0; y <= N; y++) { walk.push(wx); wx = Math.max(2, Math.min(N - 1, wx + Math.floor(rnd() * 3) - 1)); }
  const corner = (x, y) => (x < walk[Math.min(y, N)] ? 1 : 0);   // 1 = ground `a`
  const lib = patternLib();
  const majority = onA ? a : b;
  const wall = bestWall(majority, tile.file).art ?? xoverxArt(majority);
  const clean = lib?.plates[majority]?.clean ?? "";
  const dressed = wall ? `tex2:${wall}::${tile.file}::${clean}` : tile.file;
  const box = h("div", { class: "iso-stage checker trans-stage" });
  const genSet = null;                 // fades always compose; raw never exists
  /* THE FADE TILE APPEARS ONCE, near the centre, on its majority side
   * (maintainer 2026-08-28: "I also only want to see 1 tile near the center
   * ... The 'fade' tiles are not meant to be repeated like that!"). It is a
   * warm-up tile the map agent scatters — like a detail, filling every pure
   * cell with it showed a repetition that will never exist. Every other cell
   * is the ordinary wandering-edge composition. */
  const grid = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const idx = 8 * corner(c, r) + 4 * corner(c + 1, r) + 2 * corner(c, r + 1) + corner(c + 1, r + 1);
    const pure = idx === 0 || idx === 15;
    const isMaj = (idx === 15) === (majority === a);
    grid.push({ c, r, idx, pure, isMaj });
  }
  const mid = (N - 1) / 2;
  const spot = grid.filter((g) => g.pure && g.isMaj)
    .sort((x, y) => (Math.hypot(x.c - mid, x.r - mid) - Math.hypot(y.c - mid, y.r - mid)) || (x.r - y.r) || (x.c - y.c))[0] ?? null;
  const cells = grid.map((g) => ({ c: g.c, r: g.r,
    img: g === spot ? dressed : transArt(a, b, FADE_PATTERN, g.idx, genSet, g.c, g.r) }));
  // QA probe: where the fade tile actually landed, per scene, for the gate —
  // MEASURED off the composed cells, never restated from the intent.
  (window.__wikiFades ??= []).push({
    key: tile.key, majority, walk: [...walk],
    majorityCells: grid.filter((g) => g.pure && g.isMaj).length,
    fadeOnMajority: cells.filter((x, i) => x.img === dressed && grid[i].pure && grid[i].isMaj).length,
    fadeOnMinority: cells.filter((x, i) => x.img === dressed && grid[i].pure && !grid[i].isMaj).length,
    spot: spot ? { c: spot.c, r: spot.r, dist: +Math.hypot(spot.c - mid, spot.r - mid).toFixed(2) } : null,
  });
  loadImages([...new Set(cells.map((x) => x.img).filter(Boolean))], (images) => {
    const iso = worldIso();
    const canvas = isoScene(cells.filter((x) => x.img), images, 1, 2, iso);
    box.replaceChildren(canvas);
    /* THE TILE AGAINST THE FIELD IT STANDS IN, off the pixels just drawn —
     * which follows whatever plate set he has chosen, because that is the grey
     * his eye is comparing against. On Clean #0 both sides are the palette
     * colour and it honestly reads as a match; pick a textured set and the
     * difference he can see is the number it shows. */
    if (!spot) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const mine = diamondPixels(ctx, iso, 2, spot.c, spot.r, N);
    const around = grid.filter((g) => g.pure && g.isMaj && g !== spot)
      .map((g) => diamondPixels(ctx, iso, 2, g.c, g.r, N)).filter(Boolean);
    if (!mine || !around.length) return;
    const fLab = srgbToLab(medianRgb(around.flat()));
    // Only this tile's rendition of THAT ground: a fade tile carries two, and
    // the other one is supposed to look different.
    const near = mine.filter((p) => {
      const l = srgbToLab(p);
      return Math.hypot(l[0] - fLab[0], l[1] - fLab[1], l[2] - fLab[2]) < 30;
    });
    if (near.length < 60) return;
    const tLab = srgbToLab(medianRgb(near));
    box.append(toneChip(tLab, fLab, majority));
    (window.__wikiTone ??= []).push({ key: tile.key, majority,
      tile: medianRgb(near), field: medianRgb(around.flat()) });
  });
  return box;
}

function viewWorldTransition(pairId) {
  refreshFades().then((changed) => { if (changed && location.hash.includes("/transition/")) route(); });
  /* ANY PAIR IS A PAGE now, not only the pregenerated ones — a pair that was
   * never generated is composed live from the pattern library, which is the
   * point of the library ("transition tiles for everything automatically").
   * A generated pair keeps its sets: they are the same 18 pattern ids, and
   * the only place a Raw pass exists. */
  const [pa, pb] = pairId.split("__to__");
  let tr = null;
  {
    const g = (worldMeta().transitions ?? []).find((x) =>
      (x.a === pa && x.b === pb) || (x.a === pb && x.b === pa));
    if (g) tr = { a: pa, b: pb, sets: g.sets, generated: true, dirA: g.a, dirB: g.b };
    else {
      const lib = patternLib();
      const known = (id) => !!lib?.plates[id];
      if (lib && known(pa) && known(pb)) tr = { a: pa, b: pb, sets: [], generated: false };
      else return h("p", {}, "Unknown transition.");
    }
  }
  /* The picker is the LIBRARY's 18 patterns — every one of them composes for
   * every pair. Where this pair was also generated, the matching pattern
   * additionally carries the generator's raw art. */
  const lib = patternLib();
  const pickable = lib?.patterns ?? tr.sets;
  const st = transState.get(pairId) ?? { set: tr.sets[0]?.id ?? lib?.defaultPattern ?? pickable[0]?.id, seed: 2 };
  transState.set(pairId, st);
  const pat = pickable.find((x) => x.id === st.set) ?? pickable[0];
  const found = tr.sets.find((x) => x.id === pat.id) ?? null;
  const genSet = found ? { ...found, dirA: tr.dirA ?? tr.a, dirB: tr.dirB ?? tr.b } : null;
  const nameA = typeLabelWorld(tr.a), nameB = typeLabelWorld(tr.b);
  const rerender = () => { keepScrollY = window.scrollY; route(); };
  // The scenes: the same boundary crossing the field in every direction —
  // corner(x,y) = 1 where material A owns the lattice point (the sets' own
  // bit convention; see each set's meta.json).
  const N = 6;
  const rnd = seededRnd(st.seed);
  // A wandering edge: a random-walk boundary column per row of lattice.
  const walk = [];
  let wx = Math.floor(N / 2) + 1;
  for (let y = 0; y <= N; y++) { walk.push(wx); wx = Math.max(1, Math.min(N, wx + Math.floor(rnd() * 3) - 1)); }
  // An island: a rounded blob of A in a sea of B.
  const cx = N / 2 + (rnd() - 0.5), cy = N / 2 + (rnd() - 0.5), rad = N / 3 + rnd() * 0.8;
  const SCENES = [
    { name: `${nameA} west, ${nameB.toLowerCase()} east`, sub: "a straight north–south boundary",
      corner: (x) => (x <= N / 2 ? 1 : 0) },
    { name: `${nameA} north, ${nameB.toLowerCase()} south`, sub: "a straight east–west boundary",
      corner: (x, y) => (y <= N / 2 ? 1 : 0) },
    { name: "Diagonal", sub: "the corner-set's honest 32px stair — geometry, not a bad tile (docs/TRANSITIONS.md)",
      corner: (x, y) => (x + y <= N ? 1 : 0) },
    { name: `An island of ${nameA.toLowerCase()}`, sub: `${nameA.toLowerCase()} surrounded by ${nameB.toLowerCase()}`,
      corner: (x, y) => ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad ? 1 : 0) },
    { name: "A wandering edge", sub: "a random boundary — press Randomize and it wanders differently",
      corner: (x, y) => (x < walk[Math.min(y, N)] ? 1 : 0) },
  ];
  return h("div", {},
    // BASE "world", NOT "world/transitions": crumbRow builds `#/<base>/<id>`,
    // and with the ids already spelled `transition/<a>__to__<b>` the old base
    // produced #/world/transitions/transition/… — a route nothing handles, so
    // ‹ › on a pair page landed on a broken page (found 2026-09-02 by the gate
    // that walks it).
    crumbRow("#/world", `← ${label("world")}`, "world",
      // The Fade tab's order — "most left first" / "to review" — is the order
      // ‹ › walks here too, with THIS pair kept in even when it is done.
      orderTransitions(allTransitionsOf(tr.a), state.admin ? fadeOrderMode() : "all")
        .filter((x, i, arr) => arr.indexOf(x) === i)
        .concat(allTransitionsOf(tr.a).filter((x) => x.a === tr.a && x.b === tr.b))
        .filter((x, i, arr) => arr.findIndex((y) => y.a === x.a && y.b === x.b) === i)
        .map((x) => ({ id: `transition/${x.a}__to__${x.b}`, name: `${typeLabelWorld(x.a)} ↔ ${typeLabelWorld(x.b).toLowerCase()}` })),
      `transition/${tr.a}__to__${tr.b}`),
    h("div", { class: "sect-head" }, h("h1", {}, `${nameA} ↔ ${nameB.toLowerCase()}`)),
    h("div", { class: "spawn-line" },
      h("a", { class: "pill", href: `#/world/${tr.a}` }, nameA.toLowerCase()),
      h("a", { class: "pill", href: `#/world/${tr.b}` }, nameB.toLowerCase()),
      tr.sets.length ? h("span", { class: "pill", title: "This pair was also pregenerated — those sets carry the generator's own raw art" }, `${tr.sets.length} generated set${tr.sets.length === 1 ? "" : "s"}`)
        : h("span", { class: "pill", title: "Composed live from the pattern library — no pregenerated art exists or is needed" }, "composed live"),
      transPassPill(tr.a, tr.b, genSet)),
    h("p", { class: "muted" },
      `Where ${nameA.toLowerCase()} meets ${nameB.toLowerCase()} — the same Wang corner set drawn across every direction a boundary can run. `,
      "The whole world's edges will look like this page."),
    /* THE PASS SWITCH BELONGS HERE TOO (maintainer 2026-08-24: "on this page I
     * have no controller to change it. Usually we have a way to change on the
     * entire page on top and on the individual preview up in the top-right
     * corner"). It is the same control as every other World page — and while
     * no set carries a postprocessed pass it is shown INERT with the reason,
     * rather than offered as a choice that silently does nothing. */
    /* TWO GROUPS, ONE PER TYPE (maintainer 2026-08-27: "we need two radio
     * button groups on this page. 1: How do you want to view tile type A?
     * 2: How do you want to view tile type B?"). Each bar lists exactly its
     * own ground's composed passes — a ground with 4 sets and one with none
     * stop having to share a control that fits neither — and moving one moves
     * nothing else. Raw is NOT here; it belongs to the pair, below.
     *
     * Under Raw the two are dimmed rather than hidden: their choice does not
     * apply to a generated tile, and a control that vanishes would move every
     * picture beneath it on a page whose whole job is comparing pictures. */
    ...(state.admin ? [tr.a, tr.b].map((g) => h("div", { class: `ground-pass${rawOn(genSet) ? " idle" : ""}` },
      h("span", { class: "muted" }, typeLabelWorld(g)),
      sortBar(`trans-side-${g}`, passOptions(g, { raw: false }), sideViewOf(g),
        (id) => { setSideView(g, id); tileViews.clear(); keepScrollY = window.scrollY; route(); },
        { persist: false }))) : []),
    /* THE PAIR'S OWN SOURCE. Raw is disabled outright where the generator never
     * produced this pair and pattern ("If no raw is available for a type. Just
     * make the state/button disabled instead") — and it is per PATTERN, since a
     * pair can be pregenerated at one roughness and not another. */
    state.admin ? h("div", { class: "ground-pass" },
      h("span", { class: "muted" }, "Tile art"),
      sortBar("trans-raw", rawBarOptions(genSet), rawOn(genSet) ? PASS_RAW : "composed",
        (id) => { setTransRaw(id === PASS_RAW); tileViews.clear(); keepScrollY = window.scrollY; route(); },
        { persist: false })) : null,
    /* The pattern picker: the library's 18 boundaries, every one of which
     * composes for every pair — these are "the alternatives we downloaded when
     * building the perfect road", distilled. A pattern that also exists as a
     * generated set for THIS pair says so in its tooltip: that is where Raw
     * art lives. Chip labels stay his vocabulary (straight / rough · seed). */
    pickable.length > 1 ? sortBar(`trans-set-${pairId}`, pickable.map((x) => {
      const gen = tr.sets.some((y) => y.id === x.id);
      return [x.id,
        `${x.amplitude === 0 ? "straight" : `rough ${x.amplitude}`} · s${x.seed}`,
        `boundary_amplitude ${x.amplitude}, seed ${x.seed}`
        + (x.agreement != null ? ` — voted from the generated sets, ${Math.round(x.agreement * 100)}% pixel agreement` : "")
        + (gen ? " — also pregenerated for this pair (Raw shows the generator's art)" : "")];
    }),
    pat.id, (id) => { st.set = id; rerender(); }, { persist: false }) : null,
    h("div", { class: "player-controls" },
      h("button", { class: "ghost-btn", title: "Re-roll the island and the wandering edge", onclick: () => { st.seed = (st.seed * 16807 + 11) % 2147483647; rerender(); } }, "🎲 Randomize")),
    ...SCENES.map((sc) => h("div", { class: "panel trans-scene" },
      h("div", { class: "panel-title" }, sc.name),
      h("p", { class: "muted" }, sc.sub),
      wangScene(tr.a, tr.b, pat.id, genSet, N, sc.corner, 1))),
    h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "The 16 corner tiles",
        h("span", { class: "pill" }, `pattern ${pat.id}`)),
      h("p", { class: "muted" }, `Index = 8·NW + 4·NE + 2·SW + 1·SE, a set bit meaning ${nameA.toLowerCase()}. 0 is pure ${nameB.toLowerCase()}, 15 pure ${nameA.toLowerCase()}.`),
      h("div", { class: "trans-strip checker trans-all" }, ...Array.from({ length: 16 }, (_, i) => {
        const node = artNodeFor(transArt(tr.a, tr.b, pat.id, i, genSet), "", `tile ${i}`);
        node.title = `index ${i}`;
        return node;
      }))),
    /* ---- FADE TILES, reviewed here (maintainer 2026-08-28: "The tiles
     * should be shown/should be reviewed at the bottom of the transition
     * pair page"). Sorted by this page's FIRST ground's share, so the two
     * directions of one pair show the same tiles in opposite orders. The
     * section exists only once the tiles agent's index does. */
    ...(state.admin ? (() => {
      const tiles2 = fadeTilesFor(tr.a, tr.b);
      /* AN EMPTY PAIR SAYS SO (maintainer 2026-08-28, on black_rock ↔
       * parquet floor: "doesn't render/show any fading tiles for me to vote
       * on" — a silent absence reads as a broken page, when the truth was a
       * coverage gap in the tiles agent's index: 3 pairs shipped none). Only
       * when the index itself exists — before it is published the section
       * stays absent, page-wide. */
      if (!tiles2.length) return fadesIndex ? [h("div", { class: "panel" },
        h("div", { class: "panel-title" }, "Fade tiles", h("span", { class: "pill" }, "0")),
        h("p", { class: "muted" },
          `The tiles agent has published no fade tiles for ${nameA.toLowerCase()} ↔ ${nameB.toLowerCase()} yet — nothing to review here until they land (asked on their board 2026-08-28).`))] : [];
      /* TWELVE AT A TIME (the audition's lesson, relearned the day the real
       * index landed with up to 80 tiles in one merged pair): every row
       * composes a full wandering-edge field, and eighty of those up front
       * is a hung phone. The count is shared by both directions of the pair
       * — the tiles are the same, only the order flips. */
      const fkey = [tr.a, tr.b].sort().join("|");
      const shown = fadeShown.get(fkey) ?? 12;
      /* WHAT IS LEFT TO REVIEW COMES FIRST (maintainer 2026-09-02: "the same
       * sorting, but unreviewed tiles should have a higher sort order. So
       * first comes the tiles I still have to approve/reject (sorted
       * individually the same way). Once the tiles I have still not
       * approved/rejected is over the already reviewed tiles will come (again
       * individually sorted by %)"). Two blocks, each in the % order the page
       * already had; "reviewed" is a verdict — approved or rejected — because
       * that is the decision he is trying to find the gaps in.
       *
       * FROZEN FOR THE VISIT. A verdict re-renders the page, and if the
       * partition were recomputed on every render the tile he just approved
       * would drop out of the top block and everything below would slide up
       * under his thumb — the slider-text bug in a new coat. So the order is
       * taken once per visit to this pair (either direction) and kept until
       * he leaves it; coming back re-sorts, which is when he wants it. */
      const judged = (k) => { const st = fb("tiles", k).status; return st === "approved" || st === "rejected"; };
      const dirKey = `${fkey}|${tr.a}`;
      if (fadeOrder.key !== dirKey) {
        const pending = tiles2.filter((t) => !judged(t.key)).map((t) => t.key);
        const done = tiles2.filter((t) => judged(t.key)).map((t) => t.key);
        fadeOrder = { key: dirKey, keys: [...pending, ...done], firstDone: pending.length };
      }
      const rank = new Map(fadeOrder.keys.map((k, i) => [k, i]));
      // A tile that arrived since the visit began (a live index refresh) sorts
      // by % among the unreviewed rather than vanishing.
      const pos = (t) => rank.get(t.key) ?? (-1 - t.pctA / 1000);   // new arrivals lead, % descending
      const ordered = [...tiles2].sort((x, y) => pos(x) - pos(y));
      const left = tiles2.filter((t) => !judged(t.key)).length;
      // The count ticks down IN PLACE as he judges: a verdict re-renders only
      // its own row (no route()), so the frozen order never moves — and this
      // pill is the one thing on the page that should change.
      const leftPill = h("span", { title: "Tiles without an approve or reject come first, in the same % order; the ones you have judged follow, in the same order. The order holds while you work and re-sorts when you come back." });
      const paintLeft = () => {
        const n = tiles2.filter((t) => !judged(t.key)).length;
        leftPill.className = `pill${n ? " warn" : " ok"}`;
        leftPill.textContent = n ? `${n} to review first` : "all reviewed";
      };
      paintLeft();
      // QA probe: the frozen order and the live count, for the gate.
      // (__wikiFades is the scene's cell audit array — a different probe.)
      window.__wikiFadeOrder = { key: fadeOrder.key, firstDone: fadeOrder.firstDone, n: fadeOrder.keys.length, tiles: tiles2.length, left, shown };
      return [h("div", { class: "panel" },
        h("div", { class: "panel-title" }, "Fade tiles",
          h("span", { class: "pill" }, `${tiles2.length}`),
          h("span", { class: "pill", title: `Sorted by ${nameA.toLowerCase()} share, highest first — the reversed page sorts the same tiles the other way` }, `most ${nameA.toLowerCase()} first`),
          leftPill),
        h("p", { class: "muted" },
          `Both grounds on one top — what the map agent scatters to warm a player up for ${nameB.toLowerCase()} long before the boundary. Each sits in the wandering edge on the side it mostly is.`),
        ...ordered.slice(0, shown).flatMap((t, i) => [
          // The seam between the blocks, named — so a reviewed tile near the
          // top is never mistaken for an unreviewed one.
          i === fadeOrder.firstDone && fadeOrder.firstDone > 0 && i < ordered.length
            ? h("div", { class: "fade-divider muted" }, "already reviewed — same order") : null,
          /* THE CARD WEARS ITS VERDICT (maintainer 2026-09-03: "When I approved
           * or rejected a tile before on the fade page — the card border
           * became green/red. This made it easy for me to see what has been
           * approved/rejected since the tile-agent looked at my review. A
           * review in queue/just committed should have the card with a
           * green/red border"). Same outline the world candidates already
           * wear, painted from the local doc — so it appears the instant he
           * taps, queued or committed alike, and it is still there when the
           * page is reopened before the tiles agent has acted. */
          (() => {
            const card = h("div", { class: "fade-tile" },
              h("div", { class: "player-controls" },
                h("b", {}, `${Math.round(t.pctA)}% ${nameA.toLowerCase()} · ${Math.round(t.pctB)}% ${nameB.toLowerCase()}`),
                h("span", { class: "muted mono fade-key", title: t.key }, t.key.split("/").pop())),
              fadeScene(tr.a, tr.b, t));
            const paintCard = () => {
              const st = fb("tiles", t.key).status;
              card.classList.toggle("reviewed", i >= fadeOrder.firstDone);
              card.classList.toggle("picked", st === "approved");
              card.classList.toggle("dropped", st === "rejected");
            };
            paintCard();
            card.append(feedbackRow("tiles", t.key, { onchange: () => { paintCard(); paintLeft(); } }));
            return card;
          })(),
        ].filter(Boolean)),
        tiles2.length > shown ? h("button", {
          class: "ghost-btn", style: "margin-top:10px",
          onclick: () => { fadeShown.set(fkey, shown + 12); keepScrollY = window.scrollY; route(); },
        }, `Show 12 more (${tiles2.length - shown} left)`) : null)];
    })() : []));
}

/* ---- THE PROMOTION MODAL (maintainer 2026-08-21: "That will open a
 * pop-up/model so we can see how this tile looks in the different 'base tile
 * groups'. The model should show this tile in the center with members around
 * it. And a randomize button ... if you have several you might have to scroll
 * inside the model. You can from here promote this tile to the base tile
 * set.") ---- */
function openPromoteModal(cell, cand, onDone) {
  document.querySelector(".promote-modal")?.remove();
  const typeId = cell.top;
  /* PROMOTING IS ADDING TO A SET now, not creating a group (maintainer
   * 2026-08-25). The question the dialog asks is unchanged — "does this tile
   * belong with those" — and the answer is still a field with the candidate in
   * the middle and the set around it. What changed is where the answer is
   * written, and that a set carries the clean colour as a member, so a tile
   * added to a mostly-clean set correctly appears only now and then. */
  const setsHere = () => groundSets(typeId).filter((x) => x.id !== CLEAN_SET);
  const dlg = h("dialog", { class: "promote-modal" });
  let seed = 1;
  const body = h("div", { class: "promote-body" });
  const ringOf = (set) => set.members.filter((m) => m.art)
    .map((m) => ({ key: m.id, weight: m.weight, hit: { cand: { art: m.art, raw: null } } }));
  const paint = () => {
    // The head carries the pass switch, whose label depends on the pass — so
    // it is rebuilt with the previews rather than left showing the old state.
    const head = dlg.querySelector(".promote-pass");
    if (head) {
      head.replaceChildren(
        h("span", { class: "muted" }, "Tile art"),
        passBar(typeId, () => { tileViews.clear(); paint(); }),
      );
    }
    const sets = setsHere();
    body.replaceChildren(
      ...sets.map((g) => {
        const has = g.members.some((m) => m.id === cand.key);
        return h("div", { class: "promote-group" },
          h("div", { class: "panel-title" }, `In ${setLabel(g)}`,
            h("span", { class: "pill" }, `${g.members.length} tile${g.members.length === 1 ? "" : "s"}`)),
          centeredField(viewArt(cand), ringOf(g), seed, 1),
          h("button", {
            class: "ghost-btn promote-into", ...(has ? { disabled: "disabled" } : {}),
            onclick: has ? null : () => {
              addSetMember(typeId, g.id, cand.key);
              dlg.close(); dlg.remove(); onDone?.();
              toast(`Added to ${setLabel(g)} — commit when you are done.`);
            },
          }, has ? `Already in ${setLabel(g)}` : `Add to ${setLabel(g)}`));
      }),
      h("div", { class: "promote-group" },
        h("div", { class: "panel-title" }, sets.length ? "Or start a new set" : "Start the first set",
          h("span", { class: "pill" }, "just this tile")),
        centeredField(viewArt(cand), [], seed, 1),
        h("button", {
          class: "ghost-btn promote-into",
          onclick: () => {
            const id = addSet(typeId);
            addSetMember(typeId, id, cand.key);
            dlg.close(); dlg.remove(); onDone?.();
            toast(`Started Set #${id} with this tile — commit when you are done.`);
          },
        }, sets.length ? `Start Set #${nextSetId(typeId)} with this tile` : "Make it the first base tile")));
  };
  paint();
  dlg.append(
    h("div", { class: "promote-head" },
      h("b", {}, `${typeLabelWorld(typeId)} — where does this tile belong?`),
      h("button", { class: "ghost-btn", title: "Re-roll every preview", onclick: () => { seed = (seed * 16807 + 7) % 2147483647; paint(); } }, "🎲 Randomize"),
      h("button", { class: "ghost-btn", onclick: () => { dlg.close(); dlg.remove(); } }, "✕ Close")),
    // THE PASS SWITCH IS IN THE DIALOG TOO. This is where the promotion is
    // actually decided, and in After every field looks seamless — the
    // postprocess flattens the top to one colour, so the picture cannot answer
    // the only question the dialog asks. Flipping here repaints the previews
    // in place and leaves the page set the same way.
    h("div", { class: "promote-pass" },
      h("span", { class: "muted" }, "Tile art"),
      // NO PER-PASS TEXT HERE EITHER (maintainer 2026-08-25, after the same
      // thing on the ground page): "raw" / "textured, in palette" / "clean
      // colour" are three different widths, so the dialog's header reflowed on
      // every press and moved the very previews it exists to compare.
      passBar(typeId,
        () => { tileViews.clear(); paint(); })),
    h("p", { class: "muted promote-hint" }, "The candidate sits in the centre of every field. It belongs in a group when you cannot find it."),
    body);
  document.body.append(dlg);
  dlg.showModal();
  // The dialog's pass switch writes the SECTION's preference, so a flip made
  // in here has to be on the page when the dialog goes away — otherwise the
  // page keeps claiming "After" over compositions the reader just changed.
  const passAtOpen = worldView();
  dlg.addEventListener("close", () => {
    dlg.remove();
    if (worldView() !== passAtOpen) { keepScrollY = window.scrollY; route(); }
  });
}
/* ---- HOW THE SET LOOKS WHEN IT IS TILED ----
 * Maintainer 2026-08-17: "we need to make that page where I review the
 * individual tiles in the tileset help me understand how the tileset looks
 * like when tiled together. I need both a 3x3 flat ground and the V shape from
 * tiles 2.0 had. What tiles should be used in this visualization? You should
 * use random tiles from the tileset." That first cut was one shared card per
 * PAIR with a Randomize button and an approved/unreviewed pool; it was replaced
 * the same day by a preview per TILE (see tileScenes), which needs no roll and
 * sits beside the wall switch that decides how its cliff is built.
 *
 * Both shapes are drawn by `isoScene`, the SAME composer Tiles OLD uses — the
 * game's own projection at the game's own scale, so a strip here measures what
 * a strip measures in the world. The V is that page's cliff corner verbatim:
 * three 3-high stacks meeting at a corner.
 *
 * A REJECTED TILE IS NEVER IN THE POOL, under either setting. He rejected it;
 * showing it in the picture of what the ground will look like would be the
 * wiki arguing with him.
 */
/* CAN THIS TILE BUILD ITS OWN WALL? (maintainer 2026-08-17, after seeing the
 * cliffs: "some tiles in fact do look good and can build a wall and some need
 * help from the stone over stone / grass over grass (the pure tile). By
 * default a tile should be able to create it's own wall, but I as an admin
 * should be able to change the tile to top tile only. A top-tile-only tile
 * should then use the 100% (x over x) tile for building the wall.")
 *
 * A PROPERTY OF THE TILE, not a verdict on it — a top-tile-only tile is not
 * worse, it is a tile with one job — so it rides its own live document rather
 * than overloading the feedback file four other agents share. Per TILE and not
 * per pair, because the wall metrics that decide it (tiling, discretion,
 * structure) are measured per tile: one generation of a pair can stack and its
 * neighbour cannot.
 *
 * DEFAULT IS "OWN WALL", which is what he asked for and also the safe way
 * round: a wrongly-defaulted tile shows a bad wall in the preview and gets
 * marked, where a wrongly-defaulted "top only" would silently hide a tile that
 * was fine.
 */
const TILEWALL_KEY = "tuning/tile_walls";
const tileWalls = () => state.tuning.tile_walls ?? (state.tuning.tile_walls = { format: "pixel-wiki-tile-walls@1", updated_at: "", overrides: {} });
const topOnly = (key) => tileWalls().overrides?.[key]?.top_only === true;
function setTopOnly(key, on) {
  const doc = tileWalls();
  // Absent means the default, so "own wall" DELETES rather than writing false:
  // a file of explicit defaults would grow to every tile ever generated and
  // say nothing.
  if (!on) delete (doc.overrides ??= {})[key];
  else (doc.overrides ??= {})[key] = { top_only: true, updated_at: new Date().toISOString() };
  doc.updated_at = new Date().toISOString();
  touch(TILEWALL_KEY, key);
  markDirty(TILEWALL_KEY);
}
const WALL_MODES = {
  own: { label: "own wall", title: "This tile stacks to build its own cliff — the default" },
  top: { label: "top only", title: "Only ever the top of a column; whatever stacks under it is the pure tile" },
};
/* DOES THIS TILE KEEP ITS OWN TOP? (maintainer 2026-08-27: "Some on top
 * of-tiles have graphics that looks very very good with its own top texture.
 * Replacing with the base tile sets top doesn't transition as nicely toward
 * the wall. So if I can mark tiles that should always use its own top ... we
 * will be able to maintain some tiles transition towards the top.")
 *
 * The mirror of the wall designation one row up, for the other face: a
 * property of the TILE, on its own live document, defaulting to the ground's
 * configured surface. A tile marked own_top is EXEMPT from the base-tile-set
 * swap — higher priority than the composition, his rule — because the art it
 * was generated with meets its own wall in a way a pasted top cannot.
 *
 * Absent means the default, same law as tile_walls: the file only ever names
 * the exceptions, so it stays a list of decisions instead of a census. */
const TILETOP_KEY = "tuning/tile_tops";
const tileTops = () => state.tuning.tile_tops ?? (state.tuning.tile_tops = { format: "pixel-wiki-tile-tops@1", updated_at: "", overrides: {} });
const ownTop = (key) => tileTops().overrides?.[key]?.own_top === true;
function setOwnTop(key, on) {
  const doc = tileTops();
  if (!on) delete (doc.overrides ??= {})[key];
  else (doc.overrides ??= {})[key] = { own_top: true, updated_at: new Date().toISOString() };
  doc.updated_at = new Date().toISOString();
  touch(TILETOP_KEY, key);
  markDirty(TILETOP_KEY);
}
const TOP_MODES = {
  base: { label: "base tile top", title: "The top follows the ground's configured surface — the clean colour or the chosen set — which is the default" },
  own: { label: "own top", title: "This tile always draws the top it was generated with — its texture meets its own wall better than a swapped top would" },
};

/* ---- HOW THIS ONE TILE LOOKS WHEN IT IS TILED ----
 * Maintainer 2026-08-17: "The individual tile preview under Tiles in this set
 * should inside the same preview have the 3x3 on the left side and the V stack
 * on the right side. I feel I need this in order to review individual tiles.
 * This also makes sense because it's on the individual tile we have the own
 * wall / top only selection … we can remove the old Laid out as ground card.
 * That card is no longer needed." And on why they share one box: "just to save
 * space on the page."
 *
 * So the preview belongs to the TILE, beside the numbers and the wall mode
 * that describe it, and there is nothing to randomize any more — one tile, one
 * picture, the same every time you look at it. Both shapes share one
 * chessboard and carry no captions of their own: the whole point of putting
 * them together is the space it saves, and two headings would spend it again.
 */
function tileScenes(cell, cand, onView) {
  // TWO PREVIEWS, TWO BOXES (maintainer 2026-08-17, after a rule between them
  // was not enough: "I don't like it, there should be some separation between
  // the preview on top and bottom (it's not the same preview)"). They are not
  // at the same scale, so one chessboard makes them one picture and a 2× tile
  // over a 1:1 field becomes a lie about how big the tile is. A line drawn
  // across a shared box says "same window, new section"; two boxes with the
  // card's own surface between them say what is true.
  const stage = h("div", { class: "tile-preview" });
  const zoomBox = h("div", { class: "iso-stage checker tile-stage zoom-box" });
  const sceneBox = h("div", { class: "iso-stage checker tile-stage scene-box" });
  stage.append(zoomBox, sceneBox);
  // THE COURSES FOLLOW THIS TILE'S OWN WALL MODE — which is the reason the
  // preview belongs on the card carrying that switch. "own wall" stacks the
  // tile itself; "top only" stacks the pure <side> over <side> tile, the one
  // the game uses when a cell is not on top.
  const pure = worldCells().find((x) => x.top === cell.side && x.side === cell.side);
  const pureArt = pure?.candidates.find((c) => fb("tiles", c.key).status === "approved")
    ?? pure?.candidates.find((c) => fb("tiles", c.key).status !== "rejected")
    ?? pure?.candidates[0];
  // The chip lives ON the picture it changes and is never rebuilt, so its label
  // turns over the instant it is pressed rather than when the art finishes
  // decoding. Admin-only: it is a review instrument, like everything else the
  // Game Master gets on this card.
  const chip = state.admin ? h("button", { class: "stage-flip", type: "button" }) : null;
  chip?.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!cand.raw) return;
    /* THE SAME CYCLE AS THE PAGE SWITCH, for this one tile: Clean #0, then
     * every set this ground has, then Raw. Built from the passes actually on
     * offer rather than from a fixed list, so a ground with three sets cycles
     * through three and a ground with none flips clean/raw. `onView` lets the
     * card swap its review row along — the rating must always target what the
     * picture shows. */
    const CYCLE = passOptions(candTop(cand)).map(([id]) => id);
    tileViews.set(cand.key, CYCLE[(CYCLE.indexOf(tileView(cand.key)) + 1) % CYCLE.length]);
    paint();
    onView?.();
  });
  function paint() {
    const mode = cand.raw ? tileView(cand.key) : PASS_CLEAN;
    const art = (c) => viewArtIn(mode, c);
    const face = art(cand);
    // No pure tile for that material yet: stack the tile itself and say so,
    // rather than draw a cliff out of nothing.
    const bw = topOnly(cand.key) ? bestWall(cell.side, cand.tex ?? cand.art) : null;
    /* the courses draw the PICKED wall's own art, not its view-mapped pass:
     * under Clean the view maps every candidate to the plate, which erased
     * the pick from the picture entirely (maintainer 2026-08-28, "Are you
     * sure that feature work?" — measured: course clean.webp under every
     * pick). The crown above keeps following the view; the wall IS the
     * thing being chosen. */
    const course = topOnly(cand.key) ? (bw?.art ?? (pureArt ? art(pureArt) : face)) : face;
    const flat = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => ({ c, r, img: face })));
    const vee = [{ c: 1, r: 1 }, { c: 0, r: 1 }, { c: 1, r: 0 }].map((pos) => ({
      ...pos, lvl: 2, img: course, top: face, stack: [course, course],
    }));
    // What the scene was actually composed from — the crown and the courses.
    // Published because a canvas cannot be inspected the way an <img> can, and
    // both the before/after switch and the wall mode are only meaningful if what
    // they produced can be read back.
    stage.dataset.face = face ?? "";
    stage.dataset.course = course ?? "";
    stage.dataset.wallpick = bw?.key ?? "";
    stage.dataset.view = mode;
    stage.dataset.dy = String(worldIso().dy);
    if (chip) {
      // The chip says WHAT YOU ARE LOOKING AT, not what pressing it does: mid
      // comparison, "which one is this" is the one question the picture must
      // always answer, and it is the same job the ⟳ badge does on the portrait.
      const chipSet = passSet(candTop(cand), mode);
      chip.textContent = !cand.raw ? "no raw"
        : mode === PASS_RAW ? "⇄ raw" : chipSet ? `⇄ ${setLabel(chipSet)}` : "⇄ clean";
      chip.className = `stage-flip${mode !== PASS_CLEAN && cand.raw ? " on" : ""}`;
      chip.disabled = !cand.raw;
      chip.title = !cand.raw ? "No raw output was published for this tile"
        : mode === PASS_RAW ? "The generator's raw output — tap to come back round"
          : chipSet ? `This wall under ${setLabel(chipSet)} — tap for the next one`
            : "The clean colour on top, what the game paints today — tap for the next set";
    }
    // TEXTURED IS THE TOP REVIEW (maintainer 2026-08-21: "to make it even more
    // clear you only review the top/ground right now it should be the center of
    // 3x3 tiles (base tiles)"). A wall answers nothing about a top, so the
    // 3×3-of-itself and the cliff corner give way to the one composition that
    // matters here: this top, textured, centred in the ground's base tiles.
    /* A REAL TOP IS ON SCREEN whenever a SET is chosen — that is what a set
     * member is. Under the old model this was the synthesized "texture" pass,
     * the only way to see a top at all; now it is any of his sets. */
    if (passSet(cell.top, mode)) {
      /* THE SAME PICTURE THE DETAILS TAB USES, and the same 2026-08-28 rule:
       * the top under review appears ONCE, in the centre, with the chosen
       * set's own per-cell picks around it and the ground's x-over-x wall on
       * every cell — the two places he judges a top must keep agreeing. */
      const lib2 = patternLib();
      const clean2 = lib2?.plates[cell.top]?.clean ?? cleanArtOf(cell.top);
      const dress2 = (f2) => {
        if (!f2 || !clean2) return f2;
        const w2 = bestWall(cell.top, f2).art;
        return w2 ? `tex2:${w2}::${f2}::${clean2}` : f2;
      };
      const set2 = passSet(cell.top, mode);
      const cells = [];
      for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
        const centre = c === 2 && r === 2;
        const f2 = centre ? face : (setCellArt(set2, c, r, cell.top) ?? clean2);
        cells.push({ c, r, img: centre ? dress2(face) : dress2(f2) });
      }
      loadImages([face, ...cells.map((x) => x.img)].filter(Boolean), (images) => {
        const iso = worldIso();
        zoomBox.replaceChildren(...[h("div", { class: "tile-row zooms" }, zoomTile(images[face], 2)), chip].filter(Boolean));
        sceneBox.replaceChildren(h("div", { class: "tile-row scenes" }, isoScene(cells.filter((x) => x.img), images, 1, 2, iso)));
      });
      return;
    }
    // pad 2, not the usual 4: the two canvases sit on one chessboard that already
    // frames them, and 8px of transparent margin is 8px the cliff does not have
    // on a phone.
    loadImages([face, course].filter(Boolean), (images) => {
      const iso = worldIso();
      // Both rows are CENTRED — left-aligned, the 27px the scenes leave over all
      // piled up on the right and read as a lopsided box (maintainer 2026-08-17:
      // "look how much space we have on left vs right side").
      zoomBox.replaceChildren(...[h("div", { class: "tile-row zooms" }, zoomTile(images[face], 2)), chip].filter(Boolean));
      sceneBox.replaceChildren(h("div", { class: "tile-row scenes" }, isoScene(flat, images, 1, 2, iso), isoScene(vee, images, 1, 2, iso)));
    });
  }
  paint();
  return stage;
}
/* THE TILE ITSELF, MAGNIFIED, ABOVE THE SCENES (maintainer 2026-08-17: "another
 * preview where you show a single 2x zoomed tile … This preview should be just
 * on top of the preview we have now"). It shipped as a 2x/4x pair for half an
 * hour and came straight back — "the 4x was way too big, it's enough with one
 * centered at 2x" — which also gave the card its page margins back: 128px asks
 * nothing of the layout, where 384px of art on a 393px screen asked for
 * everything.
 *
 * The scenes answer "does it tile"; this answers "what IS it" — 2x is where the
 * postprocess's palette snap and the clipped outline are readable at all.
 * INTEGER scale and nearest neighbour, like every other pixel in this repo:
 * each art pixel lands on a whole block, which is the only reason a magnified
 * pixel-art tile is worth looking at.
 */
function zoomTile(im, z) {
  if (!im) return null;
  const canvas = h("canvas", { width: im.width * z, height: im.height * z, class: "iso-canvas zoom-tile" });
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(im, 0, 0, im.width * z, im.height * z);
  canvas.dataset.zoom = String(z);
  return canvas;
}

function viewWorldPair(top, side) {
  refreshWorldPairs().then((changed) => { if (changed && location.hash.startsWith("#/world")) route(); });
  const siblings = worldTypes().find((t) => t.id === top)?.pairs ?? [];
  const c = siblings.find((x) => x.side === side);
  if (!c) return h("p", {}, "Unknown pair.");
  const r = cellReview(c);
  const t = worldMeta().tile ?? {};
  const mode = state.admin ? starFilter() : "all";
  const nHits = pairHits(c, mode);
  // A peek belongs to the pair it was taken in. Keyed on the pair rather than
  // cleared on every render, because this function re-runs whenever a verdict
  // lands or the live manifest refreshes — and a peek that vanished under his
  // thumb would be worse than no peek at all.
  if (tileViewsPair !== c.id) { tileViews.clear(); tileViewsPair = c.id; }
  // A verdict or a wall-mode change repaints the tile it was cast on — its
  // cliff is built from its own setting, so the picture has to follow.
  const cards = h("div", { class: "grid world-cands" });
  // A READER SEES ONE GROUND, not the three tries it took to get there: the
  // one he approved, or the agent's best if he has not looked yet. Three
  // near-identical pictures with no explanation is the same confusion as the
  // numbers under them, in another form.
  // ‹ › WALKS THE JOB, NOT THE TYPE, while any filter is on: every pair that
  // still holds a matching tile, in section order, across ground types
  // (maintainer: "If I click on a tile 'next next next' will iterate all tiles
  // with null stars ... I will jump from one tile group to another").
  //
  // DECLARED BEFORE `shown`, which reads it on the very first drawCards() —
  // a const declared after that call is in its temporal dead zone and throws.
  const crossGroup = state.admin && mode !== "all";
  const route2 = crossGroup ? filterRoute(mode, c) : null;
  const shown = () => {
    if (!state.admin) {
      return [c.candidates.find((x) => fb("tiles", x.key).status === "approved") ?? c.candidates[0]].filter(Boolean);
    }
    // THE MARKED ONES LEAVE AS HE MARKS THEM. Recomputed inside `shown`
    // rather than captured once, so a tile he stars (or judges, under the
    // verdict modes) drops out of the set on the same repaint that records the
    // mark — the list shrinking IS the progress bar, and what is left is
    // always exactly what is left to do.
    if (crossGroup) return c.candidates.filter((x) => tileHit(x, mode));
    // ...and under "all" too, which no longer means "including the ones he
    // threw out" (2026-08-29): the rejected chip is where those live.
    return c.candidates.filter((x) => tileHit(x, "all"));
  };
  // A mark both removes its tile from the list AND can finish the whole set —
  // and "finished" is a fact the HEADER carries (the pill, the "press ›"
  // line), which a cards-only repaint cannot reach. So the last mark in a set
  // re-routes the page, keeping his scroll position. Under a VERDICT mode the
  // mark that empties a set is the verdict, so this is wired to both hooks.
  const onMarkChange = () => {
    drawCards();
    if (crossGroup && !pairHits(c, mode)) { keepScrollY = window.scrollY; route(); }
  };
  const drawCards = () => cards.replaceChildren(...shown().map((cand, i) =>
    worldCandidate(c, cand, i, crossGroup ? onMarkChange : drawCards, onMarkChange)));
  drawCards();
  return h("div", {},
    crossGroup
      ? crumbRow("#/world", `← ${label("world")}`, "world",
        // id = "<top>/<side>": crumbRow builds `#/world/<id>`, which is exactly
        // the pair url. Names carry the whole pair, because the next press can
        // land in any ground type.
        route2.map((x) => ({ id: `${x.top}/${x.side}`, name: `${x.name} — ${tileCount(pairHits(x, mode), mode)}` })),
        `${c.top}/${c.side}`)
      : crumbRow(`#/world/${top}`, `← ${typeLabelWorld(top)}`, `world/${top}`,
        siblings.map((x) => ({ id: x.side, name: x.name })), c.side),
    h("div", { class: "detail-head" },
      h("div", { class: "portrait-col" }, worldArt(c.candidates[0], c.name, "portrait")),
      h("div", { class: "meta" },
        h("h1", {}, c.name),
        h("div", { class: "spawn-line" },
          h("span", { class: "pill" }, `walk on ${typeLabelWorld(c.top).toLowerCase()}`),
          h("span", { class: "pill" }, `wall of ${typeLabelWorld(c.side).toLowerCase()}`),
          state.admin ? h("span", { class: `pill ${r.cls}` }, r.text) : null,
          // Under a filter, how much of THIS set is left — the number that
          // decides whether › is the next press.
          crossGroup ? h("span", { class: `pill ${nHits ? (mode === "approved" ? "ok" : "warn") : "ok"}` },
            nHits ? tileCount(nHits, mode) : TILE_MATCH_NONE[mode]) : null),
        // NO VERDICT ON THE PAIR (maintainer 2026-08-17: "you can also remove
        // the approve/reject/rate at the top of the page. The review will only
        // ever happen on the individual tiles themselves"). The pair is a
        // heading now, not a thing to judge — which also means one place to
        // cast a verdict instead of two that could disagree.
        h("p", { class: "muted" }, state.admin
          ? (() => { const n2 = pairHits(c, "all"); const gone = c.candidates.length - n2;
            return `${n2} tile${n2 === 1 ? "" : "s"} in this set. Approve the ones to keep; reject the ones to regenerate.${gone ? ` ${gone} rejected — behind the rejected chip until the tiles agent removes them.` : ""}`; })()
          : `${typeLabelWorld(c.top)} you walk on, ${typeLabelWorld(c.side).toLowerCase()} in the cliff below it.`))),
    h("div", { class: "panel" },
      state.admin
        ? h("div", { class: "panel-title" },
          crossGroup ? TILE_MATCH_PANEL[mode] : "Tiles in this set",
          h("span", { class: "pill" }, crossGroup ? `${nHits} of ${c.candidates.length}` : "ranked by wall score"))
        : h("div", { class: "panel-title" }, "How it looks"),
      state.admin ? h("div", { class: "world-viewbar" },
        h("span", { class: "muted" }, "Show"),
        passBar(c.top, () => { tileViews.clear(); route(); }),
        c.candidates.every((x) => !x.raw) ? h("span", { class: "muted" }, "— no raw output published for this pair") : null) : null,
      // The inbox switch lives here too: the page it hides tiles on is a page
      // he must be able to un-hide them from, without walking back up.
      state.admin ? sortBar(WORLD_STAR_KEY, Object.entries(WORLD_STARS).map(([id, f]) => {
        // "all" counts what the list SHOWS, which no longer includes the
        // ones he rejected (2026-08-29) — a chip whose number disagrees with
        // the cards under it is worse than no chip.
        const n = pairHits(c, id);
        return [id, `${f.label} ${n}`, f.title];
      }), mode, () => route()) : null,
      h("p", { class: "muted", style: "margin:2px 0 0" }, state.admin
        ? (passSet(c.top, worldViewFor(c.top))
          ? "Each top sits in the centre of a field of this ground's set — the ⌂ row rates the top, not the tile."
          : "Each tile is shown as a 3×3 field and as a cliff corner, built the way its wall setting says.")
        : "A field of it, and the corner where the land steps down."),
      cards,
      // A set he has just finished does not vanish under him — it stays open,
      // says so, and › is the way out.
      crossGroup && !nHits ? h("p", { class: "muted" },
        `${TILE_MATCH_EMPTY[mode]} Press › for the next set that has one.`) : null,
      // How it was generated is workshop talk.
      state.admin ? h("p", { class: "muted", style: "margin:10px 0 0" },
        `Generated at ${t.size ?? 64}px, ${t.view ?? "high top-down"}${t.outline_mode ? `, outline mode “${t.outline_mode}”` : ""}.`) : null));
}
/** One generation of one pair: the art, what was measured about it, and the
 *  verdict. The metrics are the agent's own — `wall_score` is what it ranks
 *  by, and the four parts are published so a low score is explainable rather
 *  than merely low. */
/** The wall-mode strip, which has to REDRAW ITSELF: a pick-one that keeps
 *  showing the old pick after you press it is worse than no control at all. */
function wallModeRow(cand, onVerdict, side) {
  const box = h("div", { class: "card-sub wall-mode" });
  // replaceChildren stringifies a bare null into a literal "null" text node —
  // the trap verdictWidget documents; filter, always.
  const draw = () => box.replaceChildren(...[

    h("span", { class: "muted" }, "Wall"),
    sortBar(`tile-wall:${cand.key}`, Object.entries(WALL_MODES).map(([id, m]) => [id, m.label, m.title]),
      topOnly(cand.key) ? "top" : "own",
      (v) => { setTopOnly(cand.key, v === "top"); draw(); onVerdict?.(); }, { persist: false }),
    /* THE STEPPER LIVES WHERE THE MARK IS MADE (maintainer 2026-08-28: "When
     * I click on a x over x/y tile and mark it as top only ... It should
     * also be possible for me to change what x over x tile we use"): the
     * moment a tile is top-only, the borrowed wall is choosable right here,
     * and the cliff preview above rebuilds with each step. */
    topOnly(cand.key) && side ? wallStepper(side, cand.tex ?? cand.art, () => { draw(); onVerdict?.(); }) : null,
  ].filter(Boolean));
  draw();
  return box;
}
function topModeRow(cand, onVerdict) {
  const box = h("div", { class: "card-sub wall-mode" });
  const draw = () => box.replaceChildren(
    h("span", { class: "muted" }, "Top"),
    sortBar(`tile-top:${cand.key}`, Object.entries(TOP_MODES).map(([id, m]) => [id, m.label, m.title]),
      ownTop(cand.key) ? "own" : "base",
      (v) => { setOwnTop(cand.key, v === "own"); draw(); onVerdict?.(); }, { persist: false }));
  draw();
  return box;
}
/* THE BRIM, AND WHETHER IT SHIPPED (maintainer 2026-08-22, painting on a
 * screenshot of deep water over grass: "I have painted RED on the overhang
 * that should be deep_water, but currently is green/grass").
 *
 * The card had already told him the opposite. It printed "overhang 1.00",
 * which is true and useless: `overhang` counts how much of the top SPILLED
 * over the edge, and all of it did — those pixels just ship in the WALL's
 * colour. Nothing on the card asked the question his red line asks.
 *
 * So the build measures the two passes the tiles agent publishes and keys the
 * answer by tile: how much of the brim reads as the top material as DRAWN, and
 * how much still does as SHIPPED (wiki/lib/overhang.mjs).
 *
 * PER FACE, and that turned out to be the whole story. Averaged over the tile
 * his came out a mild-looking 98 -> 52, which points at nothing; split by face
 * it is RIGHT 95 -> 93 and LEFT 100 -> 11. One face is untouched and the other
 * is gone. Across the library the left face fails 104 times to the right's 44 —
 * the same face fix_left_wall.py was written for.
 *
 * Only a real LOSS is worth a warning. The agent's own `clarity` sits at a
 * median of 0.35 across cross-material tiles, so flagging on it would paint
 * half the library orange and mean nothing. */
const FRINGE_LOSS = 25;                       // percentage points
const fringeOf = (key) => (worldMeta().fringe ?? {})[key] ?? null;
/* AND THE OTHER HALF OF IT (maintainer 2026-08-22, on deep water over slime:
 * "RED = SHOULD BE SLIME. PURPLE = SHOULD BE DARK WATER").
 *
 * He marked a thin brim of water over a body that should be slime — and the
 * shipped tile paints that whole body water. The BRIM measurement calls those
 * tiles perfect, correctly: the brim survived. What died is everything under
 * it. All five tiles of that cell go from ~5% water in the generator's pass to
 * 95-100% in the shipped one.
 *
 * Which is the failure fix_left_wall.py describes in its own docstring — and
 * that routine landed as code only, never applied, so dark mud over slime
 * still measures 97% here. */
const swallowOf = (key) => (worldMeta().swallow ?? {})[key] ?? null;
const SWALLOW_AFTER = 70, SWALLOW_GAIN = 40;
function fringeRow(cand, topName, sideName) {
  const f = fringeOf(cand.key);
  const sw = swallowOf(cand.key);
  const cl = cand.clarity;
  if (!f && !sw && cl == null) return null;
  const [drawn, kept, side] = f ?? [];
  const bad = f && drawn >= 60 && drawn - kept >= FRINGE_LOSS;
  const face = side === "right" ? "right" : "left";
  return h("div", { class: "card-sub metric-row" },
    f ? h("span", {
      class: bad ? "pill err" : "",
      title: bad
        ? `The generator draped the top over the ${face} wall — ${drawn}% of that face's brim reads as ${topName.toLowerCase()} in the BEFORE pass — and the postprocess repainted it: only ${kept}% still does in the tile the game gets. The overhang ships in the wall's palette on this face.`
        : `Of the brim under the top's edge, ${drawn}% reads as ${topName.toLowerCase()} as the generator drew it and ${kept}% still does after the postprocess — the overhang survives. (Worst of the two faces: ${face}.)`,
    }, `brim ${face} ${kept}% kept of ${drawn}% drawn`) : null,
    cl != null ? h("span", {
      title: "the agent's fringe_clarity — how decisively the spilled fringe can be told apart from the wall it landed on. Low on materials that are close in hue, which is a generation problem no postprocess can repair",
    }, `clarity ${cl.toFixed(2)}`) : null,
    // The swallowed face gets its own pill, because it is a bigger failure than
    // a lost brim and the brim line reads GREEN while it is happening.
    (() => {
      if (!sw) return null;
      const [raw, after, side] = sw;
      const gone = after >= SWALLOW_AFTER && after - raw >= SWALLOW_GAIN;
      if (!gone) return null;
      return h("span", {
        class: "pill err",
        title: `The ${side} wall face ships as ${topName.toLowerCase()}, not ${sideName.toLowerCase()}: ${after}% of that face reads as the TOP material in the tile the game gets, against ${raw}% in the generator's own pass. The generator drew the wall correctly and the postprocess handed the whole face to the top material — only the thin brim at the very top should be ${topName.toLowerCase()}.`,
      }, `${side} wall ships as ${topName.toLowerCase()} (${after}%, drawn ${raw}%)`);
    })());
}
function worldCandidate(cell, cand, i, onVerdict, onStars) {
  const v = wallVerdict(cand.wallScore);
  const st = state.admin ? fb("tiles", cand.key).status : null;
  const num = (x, d = 2) => (typeof x === "number" ? x.toFixed(d) : "—");
  /* ONE REVIEW ROW, AND IT REVIEWS WHAT THE PICTURE SHOWS (maintainer
   * 2026-08-21: "it's so confusing with two rating systems on the same
   * card!"). On After/Before the stars judge the TILE. The moment the view is
   * Textured — the top, centred in its base tiles — the same row turns into
   * roofs (⌂) and judges the `#top` entry instead. The old "review the top"
   * expander is gone; this row plus the view cycle replaces it. */
  const reviewBox = state.admin ? h("div", { class: "card-sub review-box" }) : null;
  const drawReview = () => {
    if (!reviewBox) return;
    const onTop = !!cand.raw && !!passSet(cell.top, tileView(cand.key));
    reviewBox.replaceChildren(...[
      onTop ? h("p", { class: "muted top-hint" },
        "⌂ rating the TOP as a once-in-a-while ground detail — the tile keeps its own stars") : null,
      // Same rule here: the moment this row judges the TOP as a detail, the
      // wall it would wear is never drawn — the top is shown centred in its
      // base tiles, ringed exactly as the game places it.

      onTop
        ? feedbackRow("tiles", topKey(cand.key), {
          glyph: ROOF_GLYPH,
          reject: "✕ not a detail",
          rejectTitle: "This top is not ground-detail material — the tile itself is untouched",
          rejectedLabel: "not a detail",
        })
        : feedbackRow("tiles", cand.key, {
          onchange: onVerdict,
          // Under a filter this tile can disappear the moment it is marked, so
          // the whole set has to repaint; with the filter off, repainting 35
          // canvas previews on every star press would be a stutter for no gain
          // — so `onStars` is only wired when a filter is on.
          onStars: starFilter() !== "all" ? (onStars ?? onVerdict) : undefined,
          rejectTitle: "Reject this generation — the agent deletes it on PixelLab and generates another",
          rejectedLabel: "slated for removal",
        }),
    ].filter(Boolean));
  };
  drawReview();
  return h("div", { class: `card world-cand${st === "approved" ? " picked" : st === "rejected" ? " dropped" : ""}` },
    tileScenes(cell, cand, drawReview),
    // THE RANK AND THE MEASUREMENTS ARE THE REVIEW, not the ground. A reader
    // gets the picture; a number called "discretion 0.81" only asks them to
    // wonder what they are supposed to do about it.
    state.admin ? h("div", { class: "card-name" }, `#${i + 1}`,
      v ? h("span", { class: `pill ${v.cls}`, title: v.text, style: "margin-left:8px" }, `wall ${cand.wallScore}`) : null) : null,
    state.admin && cand.wall ? h("div", { class: "card-sub metric-row" },
      // Named, not lettered: he has to be able to read WHY one beat another.
      h("span", { title: "how well the wall repeats without a visible seam" }, `tiling ${num(cand.wall.tiling)}`),
      h("span", { title: "how quietly the wall texture sits — loud walls fight the art on top" }, `discretion ${num(cand.wall.discretion)}`),
      h("span", { title: "whether the wall reads as a real surface rather than noise" }, `structure ${num(cand.wall.structure)}`)) : null,
    state.admin && (cand.topShare != null || cand.overhang != null)
      ? h("div", { class: "card-sub metric-row" },
        cand.topShare != null ? h("span", { title: "how much of the top surface is a single flat colour — what lets a whole field paint from one tile" }, `top ${(cand.topShare * 100).toFixed(1)}% flat`) : null,
        // New in @2, and the point of "A over B": the top should droop over
        // the wall rather than be cut off at it.
        cand.overhang != null ? h("span", { title: "how far the top surface droops over the wall instead of being cut off at it" }, `overhang ${num(cand.overhang)}`) : null,
        cand.paletteTop ? h("span", { class: "swatch-wrap", title: `the flat colour the top settled on — ${cand.paletteTop}` },
          h("span", { class: "swatch", style: `background:${/^#[0-9a-f]{3,8}$/i.test(cand.paletteTop) ? cand.paletteTop : "transparent"}` }), cand.paletteTop) : null)
      : null,
    // Only on a cross-material tile: "does the top drape over the wall" is not
    // a question about grass over grass.
    state.admin && cell.top !== cell.side ? fringeRow(cand, typeLabelWorld(cell.top), typeLabelWorld(cell.side)) : null,
    // CAN IT BUILD A WALL? Its own row, above the verdict: this is not a
    // judgement on the tile, it is what the tile is FOR, and a tile marked
    // top-only is still a keeper.
    state.admin ? wallModeRow(cand, onVerdict, cell.side) : null,
    // AND ITS TOP — the same kind of designation for the other face.
    state.admin ? topModeRow(cand, onVerdict) : null,
    // IS IT THE GROUND'S BASE TILE? Promotion goes through a MODAL that shows
    // this tile sitting centred in EVERY existing group ("so we can see how
    // this tile looks in the different base tile groups ... with members
    // around it. And a randomize button"), then promotes into a chosen group
    // or starts a new one. Revoking is direct — you can see what you are
    // undoing.
    state.admin ? (() => {
      /* A TILE CAN BELONG TO SEVERAL SETS — the same grass can be in both a
       * meadow and a lawn — so the button offers the modal whether or not it is
       * already in one, and removal happens per set on the Base tab where the
       * consequences are visible. */
      const inSets = setsWith(cell.top, cand.key);
      return h("div", { class: "card-sub base-row" },
        inSets.length ? h("span", { class: "pill ok", title: `${typeLabelWorld(cell.top)} paints fields from this tile` },
          `in ${inSets.map(setLabel).join(", ")}`) : null,
        h("button", {
          class: `ghost-btn base-btn${inSets.length ? " on" : ""}`,
          title: `See how this tile sits in each set of ${typeLabelWorld(cell.top)}, then add it to one`,
          onclick: (e) => { e.stopPropagation(); openPromoteModal(cell, cand, onVerdict); },
        }, inSets.length ? "☗ in another set too…" : "☖ add to a base tile set…"));
    })() : null,
    /* A REJECTED TILE THAT IS STILL HERE SAYS WHY (maintainer 2026-08-29:
     * "This tile was removed/rejected a long time ago. Now it's back again").
     * It never came back — the rejection is recorded and the tiles agent has
     * not carried it out yet, and 94 of his 2026-08-23 rejections are in that
     * state. A card that shows the verdict but not the WAIT reads as the
     * verdict having been lost. */
    state.admin && fb("tiles", cand.key).status === "rejected" ? h("div", { class: "card-sub" },
      h("span", { class: "pill warn", title: "Your rejection is recorded. The tile is still in the tiles agent's manifest, so it still appears here until their next run removes or replaces it." },
        `rejected ${(fb("tiles", cand.key).updated_at ?? "").slice(0, 10) || "earlier"} · still in the manifest, waiting on the tiles agent`)) : null,
    reviewBox,
    state.admin && cand.prompt
      ? h("details", { class: "world-prompt" }, h("summary", {}, "prompt"), h("p", {}, cand.prompt),
        cand.tileId ? h("p", { class: "muted mono" }, cand.tileId) : null)
      : null);
}
/* topReviewBlock is gone (maintainer 2026-08-21: "The current button and
 * everything that expands when clicking on the 'review the top' should be
 * removed (it's so confusing with two rating systems on the same card!)").
 * The top review lives in the card's ONE review row, which targets `#top`
 * whenever the view is Textured — see worldCandidate. */

function viewTiles() {
  const list = state.data.domains.tiles.filter((t) => matches(state.query, t.id, t.name, t.description));
  return h("div", {},
    sectionHead("tiles"),
    h("p", { class: "muted" }, state.admin
      ? "The tiles2 ground library. Open a type to rate or remove individual tiles — rejected tiles tell the tiles agent (and the maps agent) to retire them."
      : "The ground the world is built from — every tile of every terrain type."),
    h("div", { class: "grid" }, ...list.map((t) => {
      const first = t.groups[0];
      return h("a", { class: "card", href: `#/tiles/${t.id}` },
        h("div", { class: "thumb checker" }, first ? h("img", { src: assetUrl(`${first.dir}/${first.tiles[0]}`), alt: t.name, loading: "lazy" }) : null),
        h("div", { class: "card-name" }, t.name),
        // own sheets only — foreign (incoming-transition) groups are another
        // type's art, listed on this page but never counted as this type's
        h("div", { class: "card-sub" }, `${t.tileCount} tiles · ${t.groups.filter((g) => !g.foreign).length} sheets`),
        h("div", { class: "card-badges" }, ...entityBadge("tiles", t.path)));
    })));
}
// Is this tile one of the maps agent's "clean base" palette for its type?
// (`solid` = the small set it paints regions + cliff walls with; `plain` =
// the single canonical one — see wiki/tools/clean-base.py.)
function cleanBaseRank(type, relPath) {
  const cb = type.cleanBase;
  if (!cb) return null;
  if (cb.plain === relPath) return "plain";
  if (cb.solid?.includes(relPath)) return "solid";
  return null;
}
function tileCell(type, group, file) {
  const rel = `${group.dir}/${file}`;
  const id = stripExt(rel);
  const cell = h("div", { class: "tile-cell" });
  const sync = () => {
    const e = fb("tiles", id);
    cell.classList.toggle("rejected", e.status === "rejected");
    cell.classList.toggle("approved", e.status === "approved");
  };
  const rank = cleanBaseRank(type, rel);
  const uses = tileUses(rel);
  if (!uses) cell.classList.add("unused-tile");
  // Skip null children — raw DOM append(null) renders a literal "null" text
  // node (players saw one under every tile, 2026-07-30).
  for (const c of [
    h("a", {
      href: `#/tiles/${type.id}/${encodeURIComponent(rel)}`, class: "tile-link",
      title: `${id}\n${uses ? `used ${uses.toLocaleString()}× in the world` : "unused"}`,
    }, h("img", { src: assetUrl(rel), alt: file, loading: "lazy" })),
    rank ? h("span", { class: "base-pill", title: "The maps agent paints clean ground and cliff walls with this tile" }, "clean base") : null,
    uses ? h("span", { class: "use-pill", title: `Placed ${uses.toLocaleString()}× in the world` }, `×${uses > 999 ? `${Math.round(uses / 1000)}k` : uses}`) : null,
    starsWidget("tiles", id),
    state.admin ? h("button", {
      class: "tile-x", title: "Reject this tile (toggles)",
      // The grid's own ✕ is a remove button like any other, so it unstars too.
      onclick: () => {
        const on = fb("tiles", id).status === "rejected";
        setFb("tiles", id, on ? { status: null } : { status: "rejected", rating: null });
        for (const el of fbPeers("tiles", id, "stars")) el.__render?.();
        sync();
      },
    }, "✕") : null,
  ]) if (c) cell.append(c);
  sync();
  return cell;
}
function viewTileType(id) {
  const t = state.data.domains.tiles.find((x) => x.id === id);
  if (!t) return h("p", {}, "Unknown tile type.");
  const kinds = [["base", "Base tiles"], ["elevation", "Elevation objects"], ["transition", "Transitions"]];
  return h("div", {},
    crumbRow("#/tiles", `← ${label("tiles")}`, "tiles", state.data.domains.tiles, t.id),
    h("h1", {}, t.name),
    h("p", { class: "muted" }, `${t.description} · ${t.tilePx}px iso · ${t.tileCount} tiles`),
    // How much of this type the DEFAULT world actually uses.
    (() => {
      // The type's OWN tiles only — incoming (foreign) transitions belong to
      // the source type and are excluded from tileCount too.
      const all = t.groups.filter((g) => !g.foreign).flatMap((g) => g.tiles.map((f) => `${g.dir}/${f}`));
      const used = all.filter((rel) => tileUses(rel) > 0);
      const placements = used.reduce((n, rel) => n + tileUses(rel), 0);
      return h("p", { class: "muted" },
        h("span", { class: used.length ? "pill ok" : "pill warn" },
          `${used.length} of ${all.length} tiles used`),
        placements ? h("span", { class: "pill", style: "margin-left:6px" }, `${placements.toLocaleString()} placements`) : null);
    })(),
    h("div", { class: "fb-row" }, h("span", { class: "muted" }, "Whole type:"), starsWidget("tiles", t.path), verdictWidget("tiles", t.path)),
    ...kinds.map(([kind, label]) => {
      const groups = t.groups.filter((g) => g.kind === kind);
      if (!groups.length) return null;
      return h("div", {},
        h("h2", {}, label, " ", h("span", { class: "pill" }, `${groups.reduce((n, g) => n + g.tiles.length, 0)} tiles`)),
        ...groups.map((g, i) =>
          h("details", { class: "tile-group", ...(kind === "base" && i < 2 ? { open: "" } : {}) },
            h("summary", {}, `${g.label} · ${g.sheet} `, h("span", { class: "pill" }, String(g.tiles.length))),
            h("div", { class: "tile-grid" }, ...g.tiles.map((f) => tileCell(t, g, f))))));
    }));
}

/* --- tile instance (one tile, composed with the game's real iso geometry) --- */
// Draw a list of cells {c, r, lvl, img, top} onto a canvas: the WORLD_FORMAT
// projection (x=(c−r)·dx, y=(c+r)·dy − lvl·levelPx; a cell of elevation L
// stacks its tile L times, 16px apart, then draws the top). Painter order:
// back-to-front by (c+r), then by level.
/** Compose cells with the GAME's own iso geometry, at the GAME's own scale.
 *  scale is 1 on purpose: `data.iso` carries the real numbers (tile 64,
 *  dx 32 = ISO_DX, dy 15 = ISO_DY), so one art pixel is one CSS pixel and a
 *  3×3 field here measures what a 3×3 patch measures in the world. Drawing
 *  at 2 made every scene twice the size the game shows (maintainer
 *  2026-07-31) — and pushed the wider scenes past the column, where
 *  `max-width:100%` then RESAMPLED the pixel art by a fraction. */
/** [a, b] -> [a, divider, b]; a lone cell is left alone. */
const withDivider = (cells) => (cells.length > 1 ? [cells[0], h("div", { class: "pair-div" }), cells[1]] : cells);
function isoScene(cells, images, scale = 1, pad = 4, isoIn = null) {
  const iso = isoIn ?? state.data.iso ?? { tilePx: 64, dx: 32, dy: 15, levelPx: 16 };
  const draws = [];
  for (const cell of cells) {
    const lvl = cell.lvl ?? 0;
    // `stack[i]` overrides the tile drawn at face level i (the game stacks
    // ONE tile per level) — that's how a tile can sit mid-wall with a
    // different tile above AND below it.
    for (let i = 0; i < lvl; i++) draws.push({ ...cell, z: i, img: cell.stack?.[i] ?? cell.img });
    draws.push({ ...cell, z: lvl, img: cell.top ?? cell.img });
  }
  draws.sort((a, b) => (a.c + a.r) - (b.c + b.r) || a.r - b.r || a.z - b.z);
  const px = (d) => (d.c - d.r) * iso.dx - iso.tilePx / 2;
  const py = (d) => (d.c + d.r) * iso.dy - d.z * iso.levelPx - iso.dy;
  const minX = Math.min(...draws.map(px)), maxX = Math.max(...draws.map((d) => px(d) + iso.tilePx));
  const minY = Math.min(...draws.map(py)), maxY = Math.max(...draws.map((d) => py(d) + iso.tilePx));
  const canvas = h("canvas", {
    width: (maxX - minX + pad * 2) * scale,
    height: (maxY - minY + pad * 2) * scale,
    class: "iso-canvas",
  });
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  for (const d of draws) {
    const im = images[d.img];
    if (!im) continue;
    // NATIVE ASPECT, not a square: a review tile is 64×64 but a transition
    // tile is 64×46 (top diamond + a 17-row wall extrusion), and stretching
    // it to 64×64 bends every boundary it exists to show. Width is the iso
    // contract; height follows the art.
    const iw = im.naturalWidth || im.width || iso.tilePx;
    const dh = iso.tilePx * ((im.naturalHeight || im.height || iw) / iw);
    /* CENTRED IN THE SLOT, which is FOOT-ALIGNED. A 64x46 transition-geometry
     * tile beside a 64x64 review tile top-anchored floats 9px high, because
     * the review render pads the same 46 rows of art with 9 above and 9 below
     * (apex 9, wall foot 54 = 45+9 — measured). (tilePx - height)/2 is that 9
     * exactly, and 0 for full-height tiles, so uniform fields only translate.
     * Latent until a SET mixed the two geometries: a ballot member (its own
     * 64x46 file) in a ring of review-key members. */
    const dyOff = (iso.tilePx - dh) / 2;
    ctx.drawImage(im, (px(d) - minX + pad) * scale, (py(d) + dyOff - minY + pad) * scale, iso.tilePx * scale, dh * scale);
  }
  return canvas;
}
function loadImages(paths, cb) {
  // Count UNIQUE paths — the viewed tile can BE the clean base (T === B),
  // and a duplicate-based countdown would then never reach zero.
  const uniq = [...new Set(paths)];
  const out = {};
  let left = uniq.length;
  if (!left) { cb(out); return; }
  /* ASK FOR CORS, THEN FALL BACK. Composed scenes draw art that lives on the
   * staging origin (tile review art is not in the deploy image), and an <img>
   * fetched without crossOrigin taints every canvas it lands in — which is how
   * the textured pass came to fail silently in production. Requesting it keeps
   * these scenes readable, which is what lets a gate check the PICTURE rather
   * than the plumbing. If an origin ever refuses CORS the image would not load
   * at all, so a refusal retries plainly: a tainted tile still beats a missing
   * one on a page whose whole job is showing tiles. */
  const plain = (p, key) => {
    const done = (im) => { out[key] = im?.naturalWidth ? im : null; if (--left <= 0) cb(out); };
    const bare = () => {
      const im2 = new Image();
      im2.onload = im2.onerror = () => done(im2);
      im2.src = assetUrl(p);
    };
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => done(im);
    im.onerror = bare;
    im.src = assetUrl(p);
  };
  for (const p of uniq) {
    // A virtual "tex:<after>::<raw>" path resolves to the synthesized
    // textured-top canvas — or to plain After when it cannot be built.
    // A "sub:<cand>::<base>" path is the same idea for the other composite:
    // the reviewed tile wearing a set member's top face. "mix:row|idx|a|b" is
    // the third — a transition composed from two plates and a mask frame.
    const virt = String(p).startsWith("tex:") ? "tex" : String(p).startsWith("sub:") ? "sub"
      : String(p).startsWith("mix:") ? "mix" : String(p).startsWith("pp:") ? "pp"
      : String(p).startsWith("tex2:") ? "tex2" : null;
    if (virt) {
      // "tex2:<wall>::<face>::<clean>" — one plate dressed in its ground's
      // x-over-x wall, drawable on its own in any scene (the fade review
      // fields use it to stand a top-only tile on a real wall).
      if (virt === "tex2") {
        const { wall: wallA, face: faceA, clean: cleanA } = parseTex2(p);
        sidePlateCanvas(wallA, faceA, cleanA, (c) => {
          if (c) { out[p] = c; if (--left <= 0) cb(out); }
          else if (String(faceA).startsWith("pp:")) {
            const [a3, hex3] = faceA.slice(3).split("::");
            ppFor(a3, hex3, (c2) => { out[p] = c2 ?? null; if (--left <= 0) cb(out); });
          } else if (String(faceA).startsWith("sub:") || String(faceA).startsWith("tex:")) {
            // an undressable composite still beats a hole
            const [a3, b3] = faceA.slice(4).split("::");
            (faceA.startsWith("sub:") ? subFor : texFor)(a3, b3, (c2) => { out[p] = c2 ?? null; if (--left <= 0) cb(out); });
          } else plain(faceA, p);
        });
        continue;
      }
      if (virt === "pp") {
        const [a2, hex] = p.slice(3).split("::");
        ppFor(a2, hex, (c) => {
          if (c) { out[p] = c; if (--left <= 0) cb(out); }
          else plain(a2, p);      // uncorrectable still beats missing
        });
        continue;
      }
      if (virt === "mix") {
        const [row, idx, a2, b2] = p.slice(4).split("|");
        mixFor(+row, +idx, a2, b2, (c) => {
          // A composite that cannot be built falls back to plate_a — a plate
          // is a real tile of one of the two grounds, never an empty box.
          if (c) { out[p] = c; if (--left <= 0) cb(out); }
          else plain(a2, p);
        });
        continue;
      }
      const [a, b] = p.slice(4).split("::");
      const take = (c) => {
        if (c) { out[p] = c; if (--left <= 0) cb(out); }
        else plain(a, p);
      };
      if (virt === "tex") texFor(a, b, take); else subFor(a, b, take);
      continue;
    }
    plain(p, p);
  }
}
function viewTileInstance(typeId, rel) {
  const t = state.data.domains.tiles.find((x) => x.id === typeId);
  if (!t) return h("p", {}, "Unknown tile type.");
  const all = t.groups.flatMap((g) => g.tiles.map((f) => ({ id: encodeURIComponent(`${g.dir}/${f}`), name: f, rel: `${g.dir}/${f}`, group: g })));
  const cur = all.find((x) => x.rel === rel);
  if (!cur) return h("p", {}, "Unknown tile.");
  const id = stripExt(rel);
  const plain = t.cleanBase?.plain ?? rel; // no classification → self-surround
  const rank = cleanBaseRank(t, rel);

  // The five composition scenes (maintainer 2026-07-30): clean-ground
  // surround, self surround, self stack (cliff), and the tile mid-wall with
  // clean-base flanks — both wall faces.
  const T = rel, B = plain;
  const grid3 = (centre, ring) => [
    ...[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => ({ c, r, img: c === 1 && r === 1 ? centre : ring }))),
  ];
  // Cliff corner: the front stack plus one arm up-left (c−1) and one
  // up-right (r−1) on screen — three 3-high stacks meeting in a V.
  const vCliff = [{ c: 1, r: 1 }, { c: 0, r: 1 }, { c: 1, r: 0 }]
    .map((p) => ({ ...p, lvl: 2, img: T, top: T }));
  // Mid-wall: 3 cells along the run × 3 face levels, the tile dead centre so
  // clean base sits above, below, both sides and on every diagonal.
  const wallStack = (mid) => (mid ? [B, T, B] : [B, B, B]);
  // Copy is short on purpose: two scenes share a row, so each caption gets
  // half the column (maintainer 2026-07-31).
  const scenes = [
    ["On clean ground", "Surrounded by the clean base — open terrain.", grid3(T, B)],
    ["Tiled with itself", "Only this tile — repetition and seams.", grid3(T, T)],
    ["Stacked — a cliff of itself", "Three 3-high stacks meeting at a corner.", vCliff],
    ["In a wall — face ↘", "Wall running down-right, the tile dead centre.", [0, 1, 2].map((c) => ({ c, r: 0, lvl: 3, img: B, stack: wallStack(c === 1), top: B }))],
    ["In a wall — face ↙", "The same wall running down-left.", [0, 1, 2].map((r) => ({ c: 0, r, lvl: 3, img: B, stack: wallStack(r === 1), top: B }))],
  ];
  // TWO SCENES PER ROW, sharing one chessboard (maintainer 2026-07-31: "we
  // can reuse the same chessbox to draw both examples ... this way we can
  // click next next next and see more on the same screen"). Pairs are chosen
  // so the two halves belong together — the two flat fields, then the two
  // wall faces — with the cliff standing alone between them.
  const PAIRS = [[0, 1], [2], [3, 4]];
  const sceneBox = h("div", { class: "iso-scenes" }, ...PAIRS.map((pair) =>
    h("div", { class: `iso-scene${pair.length > 1 ? " paired" : ""}` },
      // The divider is its own 1px GRID COLUMN, not a border on one cell —
      // a border would make the right half 1px + its padding narrower, and
      // these halves have to hold a 192px canvas each with nothing to spare.
      h("div", { class: "pair-row heads" }, ...withDivider(pair.map((i) => h("div", { class: "pair-cell" },
        h("div", { class: "panel-title" }, scenes[i][0]),
        h("p", { class: "muted iso-hint" }, scenes[i][1]))))),
      h("div", { class: "pair-row iso-stage checker" }, ...withDivider(pair.map((i) =>
        h("div", { class: "pair-cell stage-cell", "data-scene": String(i) },
          h("span", { class: "muted" }, "rendering…"))))))));
  loadImages([T, B], (imgs) => {
    // pad 0 on a shared row: the built-in 4px margin each side is what would
    // push two 3x3 fields (200px each) past a phone column, and trimming
    // transparent padding is free — unlike scaling, which resamples the art.
    for (const cell of sceneBox.querySelectorAll(".stage-cell")) {
      const i = Number(cell.dataset.scene);
      const paired = cell.parentElement.children.length > 1;
      cell.replaceChildren(isoScene(scenes[i][2], imgs, 1, paired ? 0 : 4));
    }
  });

  return h("div", {},
    crumbRow(`#/tiles/${t.id}`, `← ${t.name}`, `tiles/${t.id}`, all, cur.id),
    h("div", { class: "detail-head" },
      h("div", { class: "portrait checker tile-portrait" }, h("img", { src: assetUrl(rel), alt: cur.name })),
      h("div", { class: "meta" },
        h("h1", {}, stripExt(cur.name)),
        // ONE row of pills, not two stacked lines: a clean-base tile carries
        // an extra pill, and stacking made its header taller than an
        // ordinary tile's — so paging shifted the page (maintainer
        // 2026-07-31). The type name is already in the back-link above and
        // on the thumbnail; the group label is what the first pill says.
        h("div", { class: "pill-row" },
          rank ? h("span", { class: "pill ok", title: rank === "plain" ? `THE canonical clean tile of ${t.name}` : "In the maps agent's clean-base palette" }, cur.group.label) : null,
          (() => {
            const uses = tileUses(rel);
            return uses
              ? h("span", { class: "pill ok" }, `used ${uses.toLocaleString()}× ${uses === 1 ? "time" : "times"}`)
              : h("span", { class: "pill warn", title: "No cell or prop in the world uses this tile" }, "unused");
          })()),
        // Sheet id and file path are pipeline facts — admin only.
        state.admin ? h("p", { class: "muted" }, `${cur.group.label} · ${cur.group.sheet}`, " ", h("code", {}, id)) : null,
        feedbackRow("tiles", id))),
    sceneBox);
}

/* --- objects --- */
// THE REVIEW QUEUE (maintainer 2026-08-13: "As an admin I should be able to
// sort the Scenery on the latest generated content first or/and with a
// approved/unapproved filter … If I put a filter at the overview that filter
// should hold when clicking on a Scenery and press next next next").
//
// ONE function decides the order and the membership, and BOTH the overview
// grid and the ‹ › pager on the entity page read it — that is the whole
// mechanism behind "the filter holds". The choice lives in localStorage, so
// it also survives a reload and the trip in and out of a piece. Public
// visitors always get the full domain in its natural order.
const OBJ_SORT_KEY = "wiki-obj-sort";
const OBJ_FILTER_KEY = "wiki-obj-filter";
const OBJ_TYPE_KEY = "wiki-obj-type";
// WHAT KIND OF THING IT IS (maintainer 2026-08-14: "on scenery it's hard to
// find the objects I'm looking for — can you make a filter on type"). The
// taxonomy is NOT the wiki's: every group in scenery/config/factory.json
// carries a `type`, and build.mjs copies it onto the piece. Adding a type
// there makes it appear here on the next build with no change to this file —
// which is the point, because the scenery agent owns what its pieces are.
const OBJ_TYPES = {
  TREE: "Trees", WINDOW: "Windows", MOUNTAIN_WALL: "Mountain wall", TOWN: "Town",
  INDOOR: "Indoor", NATURE: "Nature", OTHER: "Other",
};
const objTypeLabel = (t) => OBJ_TYPES[t] ?? titleish(t ?? "other");
// A VERDICT BELONGS TO THE ART IT WAS GIVEN ON. The scenery agent deletes
// rejected pieces and regenerates them AT THE SAME PATH, and the feedback
// store is keyed by path — so without this, brand-new art silently inherits
// the judgement of the piece it replaced. That is why the maintainer found
// only 3 unreviewed pieces after hours of new content (2026-08-13): 20 of them
// were carrying his verdict on art he had never seen. `added` is the date the
// CURRENT sprite arrived (build.mjs, by content hash), so an older verdict is
// a verdict about something else.
// The scenery domain began shipping a `rotations` map on 2026-08-14 — south,
// south-east and south-west so far — and the builder turns each one into a
// one-frame clip on the synthesised `still`. So "how many ways does this piece
// face" is just how many directions that still has.
// Since 2026-08-14 a piece can also carry STATES (LIGHTS_ON / LIGHTS_OFF), one
// sprite set each, so "still" is no longer the only key a static piece has.
const stillStates = (o) => Object.keys(o?.animations ?? {});
const stillDirs = (o) => Math.max(0, ...stillStates(o).map((s) => Object.keys(o.animations[s]?.dirs ?? {}).length));
/** "2 states × 3 directions", "3 directions", or "" when there is one of each. */
function stillShape(o) {
  const st = stillStates(o).length, d = stillDirs(o);
  if (st > 1 && d > 1) return `${st} states × ${d} directions`;
  if (st > 1) return `${st} states`;
  if (d > 1) return `${d} directions`;
  return "";
}

/** Card/page badges for a scenery piece, honest about stale verdicts. */
function objBadges(o) {
  const v = objVerdict(o);
  // Half-done is worth seeing in the grid, not only through the filter: it is
  // the one state you cannot infer from the piece's own verdict.
  const t = state.admin ? facetTally(o) : { done: 0, total: 0 };
  const partly = t.done > 0 && t.done < t.total
    ? [h("span", { class: "pill warn",
        title: t.stale
          ? `You have judged ${t.done} of this piece's ${t.total} states; ${t.stale} more were regenerated after you judged them and need another look`
          : `You have judged ${t.done} of this piece's ${t.total} states — the rest are untouched` },
        `${t.done}/${t.total}`)]
    : [];
  if (!v.stale) return [...partly, ...entityBadge("objects", o.path)];
  return [...partly, h("span", {
    class: "pill warn",
    title: `You marked this "${v.status}" on ${String(v.at).slice(0, 16).replace("T", " ")}, but the scenery agent has regenerated the art at this path since. This is a different piece — it needs a fresh look.`,
  }, "re-review")];
}
function objVerdict(o) {
  const e = fb("objects", o.path);
  if (!e.status) return { status: null, stale: false };
  // A verdict is about BYTES, not about a date. New verdicts carry the sprite
  // hash they were given on (verdictWidget's stamp), so staleness is exact.
  // Legacy verdicts without a hash fall back to the date comparison — but
  // ONLY against a date the build actually knows (addedGuess=false): the
  // deploy image invents dates for pieces its committed cache has not met,
  // and trusting one threw 129 already-reviewed pieces back into the queue
  // (maintainer 2026-08-14). An invented date proves nothing about the art.
  const stale = e.art && o.artHash
    ? e.art !== o.artHash
    : !!(o.added && !o.addedGuess && e.updated_at && e.updated_at < o.added);
  return { status: e.status, at: e.updated_at, stale };
}
// HOW FAR THROUGH A PIECE'S OWN STATES YOU ARE. A verdict lives per state ×
// direction, so a piece with 14 states and 3 judged is a piece you started and
// put down — which is exactly the set the maintainer could not find
// (2026-08-15: "it's hard for me to find scenery objects that need partly
// reviewed items ... if I haven't started reviewing individual states that
// means I don't care and this object is not partly reviewed").
// A facet counts as TOUCHED on a status OR a rating: giving one state four
// stars is starting on it, whether or not approve was pressed after.
// A VERDICT IS ABOUT THE ART IT WAS GIVEN TO. Reject a state, the scenery
// agent regenerates it, and the old rejection is a judgement of a picture that
// no longer exists — so the state needs looking at again and the piece is
// partly reviewed once more (maintainer 2026-08-15: "I reject one state and
// the AI generates a new state. The new filter will now let me see the tree
// that has a new state that still needs review").
//
// THE STAMP MUST BE A REAL FACET STAMP BEFORE IT CAN GO STALE. Verdicts given
// before per-clip hashes existed carry the PIECE's hash — 921 of the 1,013 on
// file today — and treating those as mismatches would re-queue nearly every
// verdict he has ever given, which is the mass re-review he was rightly
// furious about in August. A stamp equal to the piece's own hash is ambiguous
// (a legacy stamp, or genuinely the base state, whose clip IS the sprite), so
// it is trusted. Only a stamp that once matched THIS clip and no longer does
// is stale. New verdicts all carry the clip's own hash, so the rule sharpens
// itself as he reviews.
function facetStale(o, st, dir, e) {
  const h = o?.animations?.[st]?.dirs?.[dir]?.h;
  if (!e.art || !h) return false;
  return e.art !== h && e.art !== o.artHash;
}
function facetTally(o) {
  let done = 0, total = 0, stale = 0;
  for (const [st, anim] of Object.entries(o?.animations ?? {})) {
    for (const dir of Object.keys(anim.dirs ?? {})) {
      total++;
      const e = fb("objects", `${o.path}#${st}#${dir}`);
      if (!(e.status || e.rating)) continue;
      if (facetStale(o, st, dir, e)) { stale++; continue; }   // judged, but about art that is gone
      done++;
    }
  }
  return { done, total, stale };
}
/** Started on its states, not finished with them. Untouched pieces are NOT in. */
function partlyReviewed(o) {
  const t = facetTally(o);
  return t.done > 0 && t.done < t.total;
}
const OBJ_FILTERS = {
  all: { label: "all", title: "Every piece", match: () => true, empty: "Nothing here at all — the scenery domain is empty." },
  // A PIECE NEEDS REVIEW WHILE ANY OF ITS STATES IS UNJUDGED.
  //
  // PATCHED BY THE SCENERY AGENT 2026-08-16 — please keep or replace, the same
  // way you patched my .player-stage bug in August. The maintainer had been
  // refreshing an EMPTY review queue for hours while 617 pieces sat with zero
  // states judged and 2,079 states were unjudged in total.
  //
  // The cause: this matched on the PIECE verdict alone. Every one of his 801
  // scenery pieces carries a piece-level verdict from when a piece WAS a single
  // sprite, and none of those are stale — so all 801 read as reviewed and the
  // filter rendered nothing. It degraded gradually as the scenery domain grew
  // states (he saw "73 of 828" yesterday) and hit exactly zero once the last
  // piece acquired a piece verdict. `partial` did not catch them either: it
  // requires done > 0, and these have done == 0.
  //
  // facetTally is yours and already counts per state × direction, so this reuses
  // it rather than inventing a second notion of "reviewed".
  unreviewed: { label: "needs review", title: "Never judged, or judged before the art was regenerated — the review queue",
    match: (v, o) => {
      if (!v.status || v.stale) return true;
      const t = facetTally(o);
      return t.total > 0 && t.done < t.total;
    },
    empty: "Nothing needs review — you have judged every piece in the library. The art is all still here; new pieces will appear as the scenery agent generates them." },
  partial: { label: "partly reviewed", title: "You judged some of this piece's states and not the rest — pick up where you left off",
    match: (v, o) => partlyReviewed(o),
    empty: "Nothing is half-done — every piece whose states you started on, you finished. A piece you have not started on at all does not count as partly reviewed." },
  approved: { label: "approved", title: "Approved, and the art has not changed since", match: (v) => v.status === "approved" && !v.stale,
    empty: "No piece is approved yet." },
  rejected: { label: "rejected", title: "Slated for removal, and the art has not changed since", match: (v) => v.status === "rejected" && !v.stale,
    empty: "No piece is waiting to be removed — the scenery agent has cleared them." },
  // Redo lives on a STATE now, so a piece is in this queue when any of its
  // states carries one (2026-09-03).
  redo: { label: "redo", title: "A state of this piece is waiting for another take from the scenery agent",
    match: (v, o) => Object.entries(o?.animations ?? {}).some(([st2, a2]) =>
      Object.keys(a2?.dirs ?? {}).some((d2) => fb("objects", `${o.path}#${st2}#${d2}`).status === "redo")),
    empty: "No state is waiting for another take." },
};
const OBJ_SORTS = {
  group: { label: "by group", title: "Grouped by kind, alphabetical — the classic view" },
  newest: { label: "newest first", title: "Latest generated content first" },
};
/* WHICH PIECES STILL NEED A HITBOX (maintainer 2026-08-27: "also be able to
 * filter on Scenery objects not having a hitbox VS having a hitbox").
 *
 * THREE CHIPS, NOT TWO. He named two, but "not having a hitbox" is two
 * different facts: a piece nobody has looked at, and a piece he has decided
 * needs none because it hangs on a wall. 134 of the 739 are MOUNTAIN_WALL or
 * WINDOW, so the second group is large and permanent — folding it into the
 * first would make the queue never reach zero and hide what is actually left.
 * Same shape as the monster shadow filter: counts on the chips, so "to do 605"
 * is the size of the job and its reaching 0 is what finishing looks like. */
const OBJ_HITBOX_KEY = "wiki-object-hitbox";
const OBJ_HITBOXES = {
  all: { label: "all", title: "Every piece", hit: () => true },
  todo: {
    label: "no hitbox yet",
    title: "Nobody has decided about these — the ones left to do",
    hit: (o) => hitboxPieceState(o) === "todo",
  },
  has: {
    label: "hitbox set",
    title: "Pieces whose ground footprint you have drawn — one ellipse or several",
    hit: (o) => hitboxPieceState(o) === "has",
  },
  none: {
    label: "needs none",
    title: "Decided piece by piece: this one needs no hitbox — for the odd standing piece that still should not collide",
    hit: (o) => hitboxPieceState(o) === "none",
  },
  flat: {
    label: "no collision",
    title: "Flat on the floor — carpets, rugs, puddles. The player walks over them: no collision, and never in front of them",
    hit: (o) => hitboxPieceState(o) === "flat",
  },
  wall: {
    label: "wall scenery",
    title: "Windows and mountain-wall pieces — hung on a wall, so a hitbox does not apply. Decided by their type; nothing here ever needs marking",
    hit: (o) => hitboxPieceState(o) === "wall",
  },
};
const hitboxFilter = () => {
  if (!state.admin) return "all";
  try { return OBJ_HITBOXES[localStorage.getItem(OBJ_HITBOX_KEY)] ? localStorage.getItem(OBJ_HITBOX_KEY) : "all"; }
  catch { return "all"; }
};
function objectQueue() {
  const all = state.data.domains.objects;
  const read = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
  // The TYPE filter is for everyone — it is a way to find things, not a review
  // tool — so it is read before the admin gate. Sort and review-status stay
  // admin-only. All three ride the same pager: "if I filter on TREES and click
  // on a tree, next next next should only display trees."
  const typed = read(OBJ_TYPE_KEY, "all");
  const type = typed === "all" || all.some((o) => o.type === typed) ? typed : "all";
  const byType = type === "all" ? all : all.filter((o) => o.type === type);
  if (!state.admin) {
    return { list: byType, sort: "group", filter: "all", type, active: type !== "all", total: all.length };
  }
  const sort = OBJ_SORTS[read(OBJ_SORT_KEY, "group")] ? read(OBJ_SORT_KEY, "group") : "group";
  const filter = OBJ_FILTERS[read(OBJ_FILTER_KEY, "all")] ? read(OBJ_FILTER_KEY, "all") : "all";
  let list = byType;
  if (filter !== "all") list = list.filter((o) => OBJ_FILTERS[filter].match(objVerdict(o), o));
  // The hitbox filter rides the SAME queue as type/sort/review, so ‹ › on a
  // piece page walks only the pieces still missing one — "a filter you cannot
  // navigate is the dead end he hit on tiles".
  const hb = hitboxFilter();
  if (hb !== "all") list = list.filter((o) => OBJ_HITBOXES[hb].hit(o));
  // `added` is the commit that introduced the piece (build.mjs). Undated art
  // sorts last rather than first — a missing date is not a claim of newness.
  if (sort === "newest") list = [...list].sort((a, b) => String(b.added ?? "").localeCompare(String(a.added ?? "")));
  return { list, sort, filter, type, hitbox: hb, active: filter !== "all" || sort !== "group" || type !== "all" || hb !== "all", total: all.length };
}
function viewObjects() {
  const q = objectQueue();
  const list = q.list.filter((o) => matches(state.query, o.id, o.name, o.category, o.description));
  const cats = [...new Set(list.map((o) => o.category))].sort();
  /* WHAT A PIECE IS, WITHOUT OPENING IT (maintainer 2026-08-29: "When
   * scrolling over Scenery I want it to be clearer to see how many states,
   * directions and if it's animated. The states should be a x3, x7 pill in
   * the top right corner ... To hard to know now without clicking on it").
   *
   * Three facts, three places: the STATE COUNT rides the thumbnail's top
   * right, and the row under the name carries the facings and whether it
   * moves. Counted from the published clips, so an animated state and a
   * still one are told apart by their frames rather than by a flag. */
  const shapeOf = (o) => {
    const anims = Object.values(o.animations ?? {});
    const states = anims.length;
    const dirs = new Set();
    let animated = 0, animatedDirs = 0;
    for (const a of anims) {
      let moves = false;
      for (const [d, c] of Object.entries(a.dirs ?? {})) {
        dirs.add(d);
        if ((c.frames ?? 1) > 1) { moves = true; animatedDirs++; }
      }
      if (moves) animated++;
    }
    return { states, dirs: dirs.size, animated, animatedDirs };
  };
  const DIR_SHORT = { south: "S", "south-east": "SE", "south-west": "SW", east: "E", west: "W", north: "N", "north-east": "NE", "north-west": "NW" };
  const dirWord = (o) => {
    const seen = Object.values(o.animations ?? {}).flatMap((a) => Object.keys(a.dirs ?? {}));
    const order = ["south-west", "south", "south-east", "west", "east", "north-west", "north", "north-east"];
    const uniq = order.filter((d) => seen.includes(d));
    return uniq.length <= 1 ? "" : uniq.map((d) => DIR_SHORT[d] ?? d).join("/");
  };
  const card = (o) => {
    const sh = shapeOf(o);
    return h("a", { class: "card", href: `#/objects/${o.id}` },
      h("div", { class: "thumb checker" },
        h("img", { src: assetUrl(o.preview), alt: o.name, loading: "lazy" }),
        sh.states > 1 ? h("span", { class: "thumb-count", title: `${sh.states} states — variants of this piece you can switch between` }, `×${sh.states}`) : null,
        sh.animated ? h("span", { class: "thumb-play", title: sh.animated === sh.states
          ? `Animated — every state moves (${sh.animatedDirs} clip${sh.animatedDirs === 1 ? "" : "s"})`
          : `Animated — ${sh.animated} of ${sh.states} states move` }, "▶") : null),
      h("div", { class: "card-name" }, o.name),
      // The synthesised `still` must not read as an animation here — the
      // list is where you scan for what actually moves.
      h("div", { class: "card-sub obj-shape" },
        sh.animated
          ? h("span", { class: "pill ok", title: sh.animated === sh.states ? "Every state is animated" : `${sh.animated} of ${sh.states} states are animated` },
            sh.animated === sh.states ? "animated" : `animated ${sh.animated}/${sh.states}`)
          : h("span", { class: "muted" }, "static"),
        dirWord(o) ? h("span", { class: "pill", title: `${sh.dirs} facings: ${dirWord(o)}` }, dirWord(o)) : null,
        hitboxPieceState(o) === "flat"
          ? h("span", { class: "pill", title: "No collision — the player walks over this" }, "walk over") : null),
    // A stale verdict must not wear the badge of a live one — "remove" on a
    // piece regenerated since that call would read as a decision about the
    // art on screen.
      h("div", { class: "card-badges" }, ...objBadges(o)));
  };
  return h("div", {},
    sectionHead("objects"),
    h("p", { class: "muted" }, "The scenery of the world — animated props and map objects."),
    // Counted chips, and only the types the domain actually has — an empty
    // "Indoor 0" is a dead end you can press.
    sortBar(OBJ_TYPE_KEY, [
      ["all", `all ${q.total}`, "Every kind of scenery"],
      ...Object.keys(OBJ_TYPES)
        .map((t) => [t, t, state.data.domains.objects.filter((o) => o.type === t).length])
        .filter(([, , n]) => n > 0)
        .map(([t, , n]) => [t, `${objTypeLabel(t)} ${n}`, `Only ${objTypeLabel(t).toLowerCase()} — ${n} pieces`]),
    ], q.type, () => route()),
    state.admin ? sortBar(OBJ_HITBOX_KEY, Object.entries(OBJ_HITBOXES).map(([id, f]) =>
      // COUNTED WITHIN THE CHOSEN TYPE, like the review bar right below it —
      // with Trees selected, "no hitbox yet 61" has to mean sixty-one trees or
      // the two bars contradict each other. Counting the whole domain here was
      // the first cut and it made "all 739" sit above a page of 83.
      [id, `${f.label} ${state.data.domains.objects.filter((o) => (q.type === "all" || o.type === q.type) && f.hit(o)).length}`,
        q.type === "all" ? f.title : `${f.title} — within ${objTypeLabel(q.type)}`]), q.hitbox, () => route()) : null,
    state.admin ? sortBar(OBJ_SORT_KEY, Object.entries(OBJ_SORTS).map(([id, s]) => [id, s.label, s.title]), q.sort, () => route()) : null,
    // COUNT ON EVERY CHIP. The filter is sticky, and a sticky filter can
    // legitimately empty the page: the maintainer reviewed the whole domain,
    // the scenery agent deleted what he rejected, and "needs review" fell to
    // zero — so the Scenery page he came back to was blank and read as "I
    // can't see more scenery art" (2026-08-13). With the counts on the chips
    // the pieces are never unaccounted for, whatever is selected.
    state.admin ? sortBar(OBJ_FILTER_KEY, Object.entries(OBJ_FILTERS).map(([id, f]) =>
      // Counted WITHIN the chosen type: with Trees selected, "needs review 12"
      // has to mean twelve trees, or the two bars contradict each other.
      [id, `${f.label} ${state.data.domains.objects.filter((o) => (q.type === "all" || o.type === q.type) && f.match(objVerdict(o), o)).length}`,
        q.type === "all" ? f.title : `${f.title} — within ${objTypeLabel(q.type)}`]), q.filter, () => route()) : null,
    q.active
      ? h("p", { class: "muted", style: "margin:-6px 0 12px" },
          `${list.length} of ${q.total} pieces${q.type === "all" ? "" : ` · ${objTypeLabel(q.type)} only`} — ‹ › inside a piece walks this set only.`)
      : null,
    // An empty grid must never be mistaken for missing art.
    state.admin && !list.length ? h("div", { class: "panel empty-queue" },
      h("p", {}, state.query
        ? `No piece matches “${state.query}”${q.filter === "all" ? "" : ` in “${OBJ_FILTERS[q.filter].label}”`}${q.type === "all" ? "" : ` among ${objTypeLabel(q.type)}`}.`
        : q.type === "all" ? OBJ_FILTERS[q.filter].empty
          : `No ${objTypeLabel(q.type)} piece is “${OBJ_FILTERS[q.filter].label}”. The art is all still here — the other types have their own.`),
      h("button", {
        class: "ghost-btn", onclick: () => {
          try { localStorage.setItem(OBJ_FILTER_KEY, "all"); localStorage.setItem(OBJ_TYPE_KEY, "all"); } catch { /* private mode */ }
          route();
        },
      }, `Show all ${q.total} pieces`)) : null,
    // Newest-first cuts ACROSS groups, so the group headings would be noise —
    // one flat grid in the chosen order instead.
    ...(q.sort === "newest"
      ? [h("div", { class: "grid" }, ...list.map(card))]
      : cats.map((cat) => h("div", {},
          h("h2", { title: cat }, titleish(cat)),
          h("div", { class: "grid" }, ...list.filter((o) => o.category === cat).map(card))))));
}
// THE HEADER MUST BE ONE HEIGHT FOR EVERY PIECE (maintainer 2026-08-13: "The
// scenery title and text is so big the animation viewer is pushed down
// differently when I press next next next"). Scenery names run long and their
// descriptions are whole generation prompts, so the old header — full name as
// the H1, blurb ghost-stacked to the tallest prompt in the domain — was both
// tall and variable. Now: the name's " · lit"-style suffixes become pills, the
// title clamps to a fixed two-line box (the full name is in its tooltip), and
// the prompt sits behind "Read more…". Expanding is the reader's own action;
// paging re-renders, so every page arrives collapsed and the viewer below
// never moves. The ghost reservation is gone with the text it reserved for.
function objectHead(o) {
  const [title, ...nameTags] = String(o.name).split(" · ");
  const desc = objectBlurb(o);
  const descP = h("p", { class: "muted obj-desc" }, desc);
  const moreBtn = desc ? h("button", {
    class: "ghost-btn obj-more",
    onclick: () => {
      const open = descP.classList.toggle("open");
      moreBtn.textContent = open ? "Read less" : "Read more…";
    },
  }, "Read more…") : null;
  return h("div", { class: "detail-head" },
    h("div", { class: "portrait checker" }, h("img", { src: assetUrl(o.preview), alt: o.name })),
    h("div", { class: "meta" },
      h("h1", { class: "obj-title", title: o.name }, title),
      // One unconditional row — pills when the name carries tags, the button
      // when there is text — so its height never depends on the piece. The
      // re-review notice rides IN it for the same reason: as its own line it
      // grew the header only for the pieces that had it, so paging ‹ › moved
      // the animation viewer 22px whenever a stale verdict went by — the very
      // jumping the maintainer had this header rebuilt to stop. The full
      // sentence lives in the pill's tooltip, and the card badge says it too.
      h("div", { class: "obj-sub" },
        ...nameTags.map((t) => h("span", { class: "pill" }, t)),
        (() => {
          const v = objVerdict(o);
          return v.stale ? h("span", {
            class: "pill warn",
            title: `You marked this “${v.status}” on ${String(v.at).slice(0, 16).replace("T", " ")}, but the art here has been regenerated since — this is a different piece.`,
          }, "re-review") : null;
        })(),
        moreBtn),
      descP,
      /* THE PIECE ITSELF TAKES ONE VERDICT (maintainer 2026-09-03: "You added
       * 2 buttons (the redo button) on the scenery object itself. That object
       * should only have a remove button"). Redo belongs to a STATE — see the
       * facet row below. */
      feedbackRow("objects", o.path, { stamp: { art: o.artHash ?? null },
        rejectTitle: "Remove = not good enough; the scenery agent deletes this piece on its next run" })));
}
// The Man's idle/south frame 0 + measured content box — everything the size
// reference needs to draw him by the viewer's own rules. Null when the
// characters domain is missing or unmeasured, and the toggle simply never
// renders.
const HUMAN_REF_KEY = "wiki-obj-human";
function humanRefData() {
  const boy = (state.data.domains.characters ?? []).find((c) => c.id === "default_boy");
  const clip = boy?.animations?.idle?.dirs?.south;
  if (!clip?.bb || !clip.framesDir) return null;
  return {
    url: assetUrl(`${clip.framesDir}/${String(0).padStart(clip.framePad ?? 1, "0")}.${clip.frameExt ?? "png"}`),
    fw: clip.fw ?? boy.frameW, fh: clip.fh ?? boy.frameH, bb: clip.bb,
  };
}
function viewObject(id) {
  const o = state.data.domains.objects.find((x) => x.id === id);
  if (!o) return h("p", {}, "Unknown object.");
  // 368 of the 371 scenery pieces ship no animation, and the page used to just
  // say "No animations." and stop — which was true, and useless: the viewer is
  // the only place the wiki draws a piece at its measured size, cropped free of
  // padding, next to a zoom control. The builder gives a static piece a
  // one-frame `still` clip, so the viewer opens for everything now; only the
  // heading distinguishes them (maintainer 2026-08-13).
  const hasAnims = Object.keys(o.animations).length > 0;
  // The size-review toggle (admin): the Man beside the piece, same scale.
  // Sticky by request — "if I toggle this mode on I like it to keep being on
  // if I change to next scenery" — so the choice lives in localStorage and
  // every page render reads it back.
  const ref = state.admin ? humanRefData() : null;
  const humanOn = !!ref && localStorage.getItem(HUMAN_REF_KEY) === "1";
  let playerEl = null, player = null;
  // FEEDBACK ON THE STATE YOU ARE LOOKING AT (maintainer 2026-08-14: "when I
  // give feedback to an agent I can't do it on individual animations or
  // individual states … I would like the Scenery preview card to have an
  // accept/reject/rate/comment on individual states, placed in the same card
  // but UNDER the preview, since the entire entity is rated OVER the card").
  // Same widget, same key convention (`path#state`) and same position as the
  // monster and character pages have had since 2026-07-30 — a LIGHTS_ON that
  // came out wrong is now rejectable without condemning the whole piece.
  const facetBox = h("div", {});
  const facetPill = h("span", {});
  /* IS THIS PIECE DRAWN AT ITS OWN PIXELS? (maintainer 2026-09-04: "what I
   * want is for the scenery to be drawn in the same scale as the player is
   * drawn ... if the player is 100px and a table is 50px I want the player to
   * be twice as high as the table. I don't want any smart logic here.")
   *
   * That is the law, and today the game does not obey it: a piece declares a
   * height in METRES, the game renders to it (world_px_height re-based from
   * the contract's 64px person to the game's 88px one), and the art is
   * resampled to fit. Measured across all 707 published pieces, only 31 land
   * within 2% of their own pixels. The fix is the ART — regenerate each piece
   * at the size the metres imply, and the scale factor becomes 1 by itself —
   * so what this page owes him is the NUMBER, per piece, while that happens:
   * what the art is, what the game will draw, and how far apart they are. */
  const scalePill = () => {
    const pl = o.placement, sc = state.data.sceneryScale;
    const st2 = player?.getState(), dir2 = player?.getDir();
    const bb = o.animations?.[st2]?.dirs?.[dir2]?.bb;
    const wph = +pl?.world_px_height;
    if (!bb || !(wph > 0) || !sc) return null;
    const cpx = +pl?.character_height_px > 0 ? +pl.character_height_px : sc.contractCharacterPx;
    // The piece's own base sprite, the height the game scales from.
    const native = +pl?.content_px_height > 0 ? +pl.content_px_height : bb[3] - bb[1];
    const drawn = (wph * sc.characterBodyPx) / cpx;
    const f = drawn / native;
    if (!(native > 0) || !isFinite(f)) return null;
    const off = Math.abs(f - 1) > 0.02;
    return h("span", {
      class: `pill ${off ? "warn" : "ok"} scale-pill`, "data-factor": f.toFixed(3),
      title: off
        ? `The art is ${Math.round(native)}px tall. The game draws this piece ${Math.round(drawn)}px tall, because its placement declares ${pl.world_height_m} m and a character is ${sc.characterBodyPx}px. So every pixel is resampled at ${f.toFixed(2)}× — nearest-neighbour, so nothing blurs, but ${Math.round(Math.abs(1 - f) * 100)}% of the rows and columns are dropped or doubled. The art wants to be ${Math.round(drawn)}px, not ${Math.round(native)}px.`
        : `The art is ${Math.round(native)}px tall and the game draws it ${Math.round(drawn)}px tall — its own pixels, one to one, which is the rule.`,
    }, off ? `art ${Math.round(native)}px → drawn ${Math.round(drawn)}px · ${f.toFixed(2)}×` : `1:1 · ${Math.round(native)}px`);
  };
  const renderFacet = () => {
    const st = player?.getState(), dir = player?.getDir();
    if (!st || !dir) return;
    facetPill.replaceChildren(...[facetName(st, dir), scalePill()].filter(Boolean));
    // IS IT REALLY LIT? Above the verdict, because it is not one: a LIT_2 that
    // came out dark is not art to reject, it is art filed under the wrong name
    // (maintainer 2026-08-17). Per STATE, not per direction — the light is a
    // property of the sprite, and scenery is south-only anyway.
    facetBox.replaceChildren(...[
      // Placement first: whether it is wall scenery decides whether the hitbox
      // machinery below even applies, so the correction sits above it.
      state.admin ? wallRow(o, () => { player?.refreshMarks?.(); route(); }) : null,
      state.admin ? litRow(o.path, st, () => player.refreshMarks()) : null,
      feedbackRow("objects", `${o.path}#${st}#${dir}`, {
        // The chip the verdict belongs to turns green or red the moment it lands.
        onchange: () => player.refreshMarks(),
        // THIS STATE'S OWN ART HASH — plain md5 of the file, published per clip
        // by build.mjs. The piece's hash used to be stamped here, which meant a
        // verdict on LIGHTS_ON could not be told apart from one on LIGHTS_OFF
        // and the producing agent could not auto-consume it (scenery agent,
        // 2026-08-15: "for state verdicts to self-consume, the wiki needs to
        // record the state's own hash rather than the piece's"). Falls back to
        // the piece's while a clip is still unmeasured.
        stamp: { art: o.animations?.[st]?.dirs?.[dir]?.h ?? o.artHash ?? null },
        stale: () => facetStale(o, st, dir, fb("objects", `${o.path}#${st}#${dir}`)),
        /* THE STATE IS THE ONE REVIEW WITH BOTH (maintainer 2026-09-03: "The
         * scenery states is the only review that should have both a 'remove'
         * and 'redo' button"). Remove deletes this state; Redo keeps it and
         * asks for another take of it. The button was labelled "✕ redo" while
         * it was the only one, which made a lone red button read as a redo —
         * "If only one button exist it is a 'remove' button". */
        rejectTitle: `Remove just this one — ${stateLabel(st)} facing ${dir}. The scenery agent deletes this state; the piece stays.`,
        redo: { label: "↻ redo", title: `Keep this state and generate another take of it — ${stateLabel(st)} facing ${dir}. Nothing is deleted.`, doneLabel: "another take requested" },
      }),
    ].filter(Boolean));
  };
  if (hasAnims) {
    player = makePlayer(o, "object", { headerEl: facetHead(facetPill, facetBox), ...(ref ? { humanRef: { ...ref, on: humanOn } } : {}) });
    activePlayers.push(player);
    playerEl = player.el;
    player.onFacetChange = renderFacet;
    renderFacet();
  }
  const humanBtn = ref && player ? h("button", {
    class: `ghost-btn human-toggle${humanOn ? " on" : ""}`,
    title: "Show the Man beside this piece, at the same scale — for judging whether its size is believable",
    onclick: () => {
      const on = localStorage.getItem(HUMAN_REF_KEY) !== "1";
      if (on) localStorage.setItem(HUMAN_REF_KEY, "1"); else localStorage.removeItem(HUMAN_REF_KEY);
      player.humanToggle(on);
      humanBtn.classList.toggle("on", on);
    },
  }, "🧍 vs human") : null;
  // The overview's filter/sort decides what ‹ › walks here. A piece reached
  // from search or a link may sit OUTSIDE the current filter — it goes in
  // front rather than losing its pager, and the banner says so, because a
  // disappearing Next with no explanation is exactly the confusion the
  // maintainer asked to avoid.
  const q = objectQueue();
  const inQueue = q.list.some((x) => x.id === o.id);
  const navList = inQueue ? q.list : [o, ...q.list];
  // navList, not the whole domain: with a filter on, ‹ › walks the filtered
  // set, so the piece worth warming is the next one HE will see.
  prefetchAround(o, navList, o.id);
  return h("div", {},
    crumbRow("#/objects", `← ${label("objects")}`, "objects", navList, o.id),
    q.active ? h("a", {
      class: "queue-note", href: "#/objects",
      title: "The Scenery overview sets this — click to go there and change it",
    },
      h("span", { class: "pill warn" }, "filtered"),
      // Each active narrowing named once, then the count. "Trees only · needs
      // review only · 12 of 764" — every word of it is why ‹ › stops where it
      // stops.
      /* EVERY NARROWING IS NAMED. The hitbox queue rode the pager without
       * appearing here, so "Trees only · newest first · 65 of 710" was the
       * banner over a list that was really trees WITHOUT a hitbox — the count
       * was the only hint, and it reads as the number of trees. */
      [q.type === "all" ? null : `${objTypeLabel(q.type)} only`,
        q.filter === "all" ? null : `${OBJ_FILTERS[q.filter].label} only`,
        !q.hitbox || q.hitbox === "all" ? null : `${OBJ_HITBOXES[q.hitbox].label} only`,
        q.sort === "group" ? null : OBJ_SORTS[q.sort].label,
        `${q.list.length} of ${q.total}`].filter(Boolean).join(" · "),
      inQueue ? null : h("span", { class: "pill err" }, "this one is outside the filter")) : null,
    objectHead(o),
    hasAnims
      ? h("div", { class: "panel" },
          // Headed like a monster is — a word, then a pill counting what there
          // is to look at ("2 states × 3 directions"). The controls under it
          // are the same controls in the same order, so the two pages read as
          // one wiki (maintainer 2026-08-14: "it's the same wiki so we want
          // the same look and feel").
          h("div", { class: "panel-title" },
            // "Preview", not "Still" — maintainer 2026-08-14: "Still sounds so
            // boring". It is also the truer word now: the card holds states
            // and directions, not one frozen picture.
            o.stillOnly ? "Preview" : "Animations",
            stillShape(o) ? h("span", { class: "pill" }, stillShape(o)) : null,
            humanBtn),
          playerEl)
      : h("p", { class: "muted" }, "No animations."),
    entitySoundsCard("objects", o),
    storyCard({ label: "The story", art: refPic(o), name: o.name, paras: o.loreStory, related: o.loreRelated }));   // always last
}

/* --- sounds --- */
// Temporarily silence the RUNNING GAME while auditioning wiki audio
// (maintainer 2026-07-30). Only meaningful inside the game's wiki drawer —
// the parent (wikipanel.ts) flips gameAudio and RESTORES the player's real
// settings when the drawer closes, so this is never a persistent choice.
/* --- the game's SOUND ENGINE, mirrored -------------------------------------
   Playing a sound event here must sound EXACTLY like it does in the game
   (maintainer 2026-08-05), so this is a faithful mirror of the composer's
   one-shot player — games2/composer/engine/oneshot.ts — using the SAME data
   (the catalog, the composer's foley sets, and the engine constants build.mjs
   reads out of the composer's own source, drift-guarded):

   - take pick: round-robin, never the same take twice (oneshot.pickTake);
     "primary take only" where the composer pins one (pure-mode/EVENT_FOLEY).
   - pitch: 2^(semis/12) × the layer's rate. The jitter ranges in data.json
     are ALREADY scaled by the engine's gentleness factor (×0.35) at build.
   - gain: mix_gain_db + event trim + the bus fader, ± gentled gain jitter.
   - per-layer lowpass (grass's hi-hat shave), 30 ms retrigger debounce.
   - NOT mirrored, honestly: scale-snap (needs the running score), pan and
     distance (needs a world position), beat quantize. Those apply on top in
     the game; everything the maintainer tunes per sound is identical here.

   BufferSource, never HTMLAudio: an <audio> el pitch-PRESERVES on rate
   change by default — 2× would speed a voice up without raising it, which is
   exactly the wrong sound for the half-speed-authored vocal takes. */
const sfxPlays = [];                                // test/debug: what actually played
window.__sfxPlays = sfxPlays;
const sfxEngine = {
  ctx: null, buffers: new Map(), lastTake: new Map(), lastAt: new Map(),
  live: new Set(),                                  // sources still sounding
  gen: 0,                                           // bumped by stop(); stale decodes check it
  ac() { return (this.ctx ??= new (window.AudioContext || window.webkitAudioContext)()); },
  /** Cut everything that is sounding, right now. Auditioning your way down a
   *  list means each ▶ must replace the last one instantly (maintainer
   *  2026-08-06) — two overlapping takes tell you nothing about either.
   *  The generation bump matters as much as the stop: a take whose decode is
   *  still in flight must not start playing after you have already moved on. */
  stop() {
    this.gen++;
    for (const s of this.live) { try { s.stop(); } catch {} }
    this.live.clear();
  },
  /** Every source goes through here so `stop()` can reach it. */
  track(src) {
    this.live.add(src);
    src.addEventListener("ended", () => this.live.delete(src), { once: true });
  },
  /** Decode a take, trying each format the catalog ships until one WORKS.
   *  Not a nicety: the library auditioned `.m4a` first, and Chromium carries
   *  no AAC decoder — so every catalog sound in the raw list and the picker
   *  failed to load while the composer's .wav sets played fine. Order is
   *  ogg (Chrome/Firefox) → m4a (Safari, which has no ogg) → wav (always).
   *  Resolves to {buf, file} so callers can report what actually played. */
  async buffer(rel) {
    const cands = (Array.isArray(rel) ? rel : [rel]).filter(Boolean);
    const key = cands.join("|");
    if (this.buffers.has(key)) return this.buffers.get(key);
    const p = (async () => {
      for (const file of cands) {
        try {
          const r = await fetch(file.startsWith("composer/") ? await composerUrl(file) : assetUrl(file));
          if (!r.ok) continue;
          const buf = await this.ac().decodeAudioData(await r.arrayBuffer());
          if (buf) return { buf, file };
        } catch { /* next format */ }
      }
      return null;
    })();
    this.buffers.set(key, p);
    return p;
  },
  pickTake(key, takes, primaryOnly) {
    if (primaryOnly || takes.length === 1) return 0;
    const last = this.lastTake.get(key) ?? -1;
    let idx = Math.floor(Math.random() * takes.length);
    if (idx === last) idx = (idx + 1) % takes.length;   // oneshot.pickFrom, verbatim
    this.lastTake.set(key, idx);
    return idx;
  },
  /** One LAYER of an event, with the engine's whole chain. */
  async playLayer(layer, over = {}) {
    const eng = state.data.sfx?.engine ?? {};
    const key = layer.set ?? layer.soundId;
    const now = performance.now();
    if (now - (this.lastAt.get(key) ?? -1e9) < (eng.debounceMs ?? 30)) return;  // oneshot.play debounce
    this.lastAt.set(key, now);
    // Silence the last one BEFORE the fetch, not after: an uncached take takes
    // a network round-trip to decode, and waiting would leave the two sounds
    // overlapping for exactly as long as the file is slow to arrive.
    if (over.solo !== false) this.stop();
    const gen = this.gen;
    const idx = this.pickTake(key, layer.takes, /primary/.test(layer.pick ?? ""));
    const take = layer.takes[idx];
    const got = await this.buffer(take.file);
    if (!got) { toast(`Could not load ${take.name}`); return; }
    if (gen !== this.gen) return;                   // you moved on while it decoded
    const buf = got.buf;
    const ctx = this.ac();
    const rand = (a, b) => a + Math.random() * (b - a);
    const semis = layer.jitterSemis ? rand(layer.jitterSemis[0], layer.jitterSemis[1]) : 0;
    const rate = Math.pow(2, semis / 12) * (layer.rate ?? 1) * (over.rate ?? 1);
    let db = (layer.mixGainDb ?? 0) + (layer.trimDb ?? 0) + (eng.busDb?.[layer.bus] ?? 0) + (over.gainDb ?? 0);
    if (layer.gainJitterDb) db += rand(layer.gainJitterDb[0], layer.gainJitterDb[1]);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    let head = src;
    if (layer.lowpassHz) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = layer.lowpassHz;
      head.connect(lp); head = lp;
    }
    const g = ctx.createGain();
    g.gain.value = Math.pow(10, db / 20);           // catalog.dbToGain
    head.connect(g); g.connect(ctx.destination);
    this.track(src);
    src.start();
    sfxPlays.push({ file: got.file, rate: +rate.toFixed(4), db: +db.toFixed(2), lowpassHz: layer.lowpassHz ?? null });
  },
  /** The whole EVENT: every layer at once — that is what the game does
   *  (grass footstep = the grass set AND dirt underneath, same instant). */
  playEvent(ev) {
    this.stop();                                    // the previous audition, not this event's own layers
    // TWO KINDS OF MULTI-SOUND EVENT, and they are opposites. A LAYERED event
    // plays every sound at once (a grass footstep IS grass plus dirt
    // underneath). Several ASSIGNED sounds ROTATE — one per trigger, the
    // engine's round-robin — so playing them together would be four thunder
    // cracks on top of each other, which is not a sound the game can make.
    const list = ev.rotates ? [ev.sounds[Math.floor(Math.random() * ev.sounds.length)]] : ev.sounds;
    for (const l of list) void this.playLayer(l, { solo: false });
  },
  /** The admin's all-sounds list: raw file, or the audition sliders. */
  async rawOrAudition(file, { rate = 1, gainDb = 0, maxSemis = 0 } = {}) {
    this.stop();                                    // before the fetch — see playLayer
    const gen = this.gen;
    const got = await this.buffer(file);
    if (!got) { toast("Could not load the take"); return; }
    if (gen !== this.gen) return;                   // you moved on while it decoded
    const ctx = this.ac();
    const semis = maxSemis ? (Math.random() * 2 - 1) * maxSemis : 0;
    const r = rate * Math.pow(2, semis / 12);
    const src = ctx.createBufferSource();
    src.buffer = got.buf; src.playbackRate.value = r;
    const g = ctx.createGain();
    g.gain.value = Math.pow(10, gainDb / 20);
    src.connect(g); g.connect(ctx.destination);
    this.track(src);
    src.start();
    sfxPlays.push({ file: got.file, rate: +r.toFixed(4), db: +gainDb.toFixed(2), lowpassHz: null, raw: true });
  },
};

// A full-page wiki tab has no game to mute → no button.
let gameMuted = false;
const muteLabel = (on) => (on ? "🔊 Unmute the game" : "🔇 Mute the game while listening");
/** The ONE place that flips the game's audio, so the button and the picker
 *  can never disagree. Labels are refreshed by query rather than through the
 *  button's own closure, because the picker mutes from outside that scope —
 *  and a stale label is how someone ends up unable to get their game sound
 *  back. */
function setGameMuted(on) {
  if (window.parent === window || on === gameMuted) return;
  gameMuted = on;
  window.parent.postMessage({ type: "wiki:muteGame", on }, location.origin);
  for (const b of document.querySelectorAll(".mute-game")) b.textContent = muteLabel(on);
}
function muteGameBtn() {
  if (window.parent === window) return null;
  const btn = h("button", { class: "ghost-btn mute-game" }, muteLabel(gameMuted));
  btn.addEventListener("click", () => setGameMuted(!gameMuted));
  return btn;
}
/* --- Sound Effects, organized by IN-GAME EVENT (maintainer 2026-08-05) ----
   The unit is the EVENT that triggers sound — "Footsteps · Grass", "Jump" —
   not the audio file. An event can layer several sounds at once (grass +
   dirt underneath) or alternate takes; ▶ on the event plays exactly what
   the game plays, ▶ on a row plays that one sound alone, both through the
   mirrored engine above. Players see only events that make sound; the
   silent events, the stars, the add-a-sound requests and the raw all-sounds
   list at the bottom are the Game Master's. */
const stFmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0$/, ""));
/** Every format a catalog take ships, best decoder first. Ogg leads because
 *  Chrome and Firefox both decode it and it is a tenth of the wav's bytes;
 *  m4a is there for Safari (no ogg); wav always works. */
const audioCandidates = (t) => [t?.files?.ogg, t?.files?.m4a, t?.files?.wav].filter(Boolean);
/** The id of a BINDING — this sound attached to this event. Rating, approving
 *  and removing here is about the PAIRING, never the recording (maintainer
 *  2026-08-06: "If I remove a sound from an event doesn't mean I want to
 *  delete the sound … it just means I want to unbind it"). The file's own
 *  stars, approval and removal live in All sounds, where "remove" really does
 *  retire the recording. */
/** Which binding a verdict is about. Without a take it names the whole
 *  LAYER — "this sound should not play at this moment". With one it names a
 *  single RECORDING inside a multi-take binding: "Coin Pickup plays two
 *  recordings and I only want take02 gone" (maintainer 2026-08-06). Both are
 *  UNBIND, never delete — the file stays in the library either way. */
const bindingId = (ev, layer, take) => take
  ? `${ev.id}#${take.file}`
  : `${ev.id}#${layer.source === "composer" ? `composer/${layer.set}` : layer.soundId}`;
/** ONE PLAY BUTTON PER THING YOU CAN ACTUALLY HEAR SEPARATELY (maintainer
 *  2026-08-06: "why is the group in a group? Why 3 play buttons and not 2? A
 *  non admin will probably not even understand why we have 2 and not 1").
 *  A single-sound, single-take event was rendering THREE ▶ — event, layer,
 *  take — every one of them playing the identical file. A button earns its
 *  place only by doing something its parent does not:
 *    · the EVENT's ▶ is always there — it is what the game does at this moment;
 *    · a LAYER's ▶ only when the event has more than one sound (layered or in
 *      rotation), because otherwise the event's ▶ already is it;
 *    · a TAKE's ▶ only when its layer holds more than one recording.
 *  So one sound = one button, and every extra button means a different sound. */
function sfxLayerRow(ev, layer, { soleLayer = false } = {}) {
  const totalDb = (layer.mixGainDb ?? 0) + (layer.trimDb ?? 0) + (state.data.sfx.engine.busDb?.[layer.bus] ?? 0);
  const jit = layer.jitterSemis;
  const jitTxt = jit ? (Math.abs(jit[0]) === Math.abs(jit[1]) ? `±${stFmt(Math.abs(jit[1]))} st` : `${stFmt(jit[0])}…${stFmt(jit[1])} st`) : null;
  const n = layer.takes.length;
  const rows = [
    h("div", { class: "sfx-layer-head" },
      soleLayer ? null
        : h("button", { class: "play-btn", "aria-label": "play this sound alone", onclick: () => void sfxEngine.playLayer(layer) }, "▶"),
      h("span", { class: "take-name" }, layer.label),
      layer.voiceRate ? h("span", { class: "pill ok", title: "The vocal takes are authored at half speed — 2× is the true voice" }, `voice ×${stFmt(layer.voiceRate)}`) : null,
      layer.rate !== 1 && !layer.voiceRate ? h("span", { class: "pill", title: "playbackRate — pitch and speed together" }, `pitch ×${stFmt(layer.rate)}`) : null,
      h("span", { class: "pill", title: `How loud it plays: the recording's own level (${stFmt(layer.mixGainDb ?? 0)} dB), this event's trim (${stFmt(layer.trimDb ?? 0)} dB) and the game's ${layer.bus === "ui" ? "interface" : layer.bus === "ambience" ? "ambience" : "sound-effects"} fader (${stFmt(state.data.sfx.engine.busDb?.[layer.bus] ?? 0)} dB), added up` }, `volume ${totalDb > 0 ? "+" : ""}${stFmt(totalDb)} dB`),
      jitTxt ? h("span", { class: "pill", title: "Random pitch on every play (already scaled by the engine's gentleness ×0.35)" }, `pitch jitter ${jitTxt}`) : null,
      layer.gainJitterDb ? h("span", { class: "pill", title: "Random volume on every play (gentled)" }, `vol ±${stFmt(Math.abs(layer.gainJitterDb[1]))} dB`) : null,
      layer.lowpassHz ? h("span", { class: "pill", title: "Fixed tone shaping" }, `lowpass ${layer.lowpassHz} Hz`) : null,
      // One sound is one sound (maintainer 2026-08-05/06): the engine BINDS
      // exactly what it plays, so `takes` is the whole truth — a single-take
      // layer with spare recordings means the set's other takes are unbound
      // and live only in the admin's All sounds library.
      // With one recording there is no take row to carry its length, and
      // "1 take" told nobody anything — show the length itself instead.
      h("span", { class: "pill muted-pill", title: n > 1
          ? "Each play picks a take at random, never the same one twice in a row"
          : layer.spareTakes ? `The one bound recording; the ${layer.spareTakes} other recording(s) of this set are unbound (see All sounds)`
          : "One recording" },
        n === 1 ? (layer.takes[0]?.dur != null ? `${stFmt(layer.takes[0].dur)}s` : "1 take") : `${n} takes · equal 1/${n}`),
      // WHICH recording is bound is the Game Master's business and nobody
      // else's — it is the difference between take01 and cand07.
      n === 1 && state.admin && layer.takes[0]
        ? h("span", { class: "pill", title: "The exact recording this event plays" }, layer.takes[0].name) : null,
      layer.layerNote ? h("span", { class: "pill", title: layer.layerNote }, "layer") : null),
  ];
  // The verdict belongs to the BINDING, and it sits on the binding's own row —
  // not on each take. A take is a recording; judging it (and deleting it) is
  // the library's job. Here the question is only "is this the right sound for
  // this moment", and ✕ detaches it from this event, nothing more.
  const multi = n > 1;
  if (state.admin) {
    const bid = bindingId(ev, layer);
    rows.push(h("div", { class: "take-row sfx-bind-verdict" },
      h("span", { class: "muted", style: "font-size:12px" }, multi ? "these sounds, for this event:" : "this sound, for this event:"),
      h("span", { class: "spacer" }),
      starsWidget("bindings", bid),
      verdictWidget("bindings", bid, {
        // "REMOVE", like every other reject button (maintainer 2026-09-03).
        // What it removes is the SOUND FROM THIS EVENT; the title says so and
        // the recording stays in the library.
        reject: multi ? "✕ remove all" : "✕ remove",
        rejectTitle: multi
          ? `Detach all ${n} recordings from THIS event — they stay in the library. To drop just one, use the ✕ on its own row.`
          : "Detach this sound from THIS event only — the recording stays in the library. To retire the recording itself, reject it under All sounds.",
        rejectedLabel: "to be unbound",
      })));
  }
  // Only when there is a CHOICE. A lone recording is the layer, and its row
  // was a third button playing the same file — its name and length now sit on
  // the layer's own line instead.
  for (const t of (n > 1 ? layer.takes : [])) {
    // PER-RECORDING UNBIND (maintainer 2026-08-06: "I wanted to unbind
    // coin_pickup__take02.wav from Coin Pickup, but the unbind is not on the
    // sound itself … I don't want to delete the sound, just unbind it").
    // An event that plays several recordings has several bindings, and the ✕
    // has to sit on the one you want gone. Only when there IS a choice: with
    // one take the layer's own ✕ already means exactly this, and two ✕ for a
    // single action reads as two different powers.
    const tid = bindingId(ev, layer, t);
    const drop = multi && state.admin
      ? verdictWidget("bindings", tid, {
        /* "REMOVE", NOT "UNBIND" (maintainer 2026-09-03: every reject button
         * "should be called 'remove' and nothing else"). What it removes is
         * this SOUND FROM THIS EVENT — the recording is untouched, which the
         * title says. */
        rejectOnly: true, rejectedLabel: "to be unbound",
        rejectTitle: `Remove ONLY ${t.name} from this event — the other ${n - 1} recording(s) keep playing and the file stays in the library.`,
      })
      : null;
    rows.push(h("div", { class: "take-row sfx-take" },
      h("button", { class: "play-btn", "aria-label": "play take", onclick: () => void sfxEngine.playLayer({ ...layer, takes: [t], pick: "primary take only" }) }, "▶"),
      h("span", { class: "take-name muted" }, t.name),
      t.dur ? h("span", { class: "pill" }, `${stFmt(t.dur)}s`) : null,
      drop));   // right-aligned by CSS margin — a spacer would force the wrap
  }
  if (layer.spareTakes > 0 && state.admin) {
    rows.push(h("p", { class: "muted sfx-unbound-note" },
      `${layer.spareTakes} more recording(s) of this set exist, unbound to any event — audition them under All sounds.`));
  }
  return h("div", { class: "sfx-layer" }, ...rows);
}
/** A queued request, said the way it was picked: the exact recording, not the
 *  folder it came from (older entries carry only `sound`). */
const reqSound = (r) => (r.take ? r.take.split("/").pop().replace(/\.\w+$/, "") : r.sound);
function setSfxRequest(id, val) {
  const doc = state.tuning.sfx_requests ?? (state.tuning.sfx_requests = { format: "pixel-wiki-sfx-requests@1", updated_at: "", requests: {} });
  if (val === null) delete doc.requests[id];
  else doc.requests[id] = val;
  doc.updated_at = new Date().toISOString();
  touch("tuning/sfx_requests", id);
  markDirty("tuning/sfx_requests");
}
/* ---- the sound PICKER ---------------------------------------------------
   Assigning a sound is a listening job, not a dropdown job (maintainer
   2026-08-06: "I must be able to listen to the sound I'm about to add and
   the UX should make it easy to listen to the next sound … iterate the list
   and search for the perfect sound"). So it is a real dialog: search, one
   row per sound with its own ▶ and its length, and Prev/Next (or ↑/↓) that
   step AND play as they go. Every play cuts the previous one dead —
   sfxEngine.stop() runs before the fetch, so even an uncached take can't
   overlap the one you were just listening to. */
/** The composer ships its candidates as `<action>_<flavour>` siblings — ten
 *  alternatives for one action (board, 2026-08-05: "ideally grouped by action
 *  prefix so the ten alternatives for an action sit together"). Derive the
 *  action instead of hardcoding it: a set's group is its LONGEST underscore
 *  prefix that at least one sibling shares, so hit_taken_gut and
 *  hit_taken_oof land together and a lone set falls to "Other". */
function composerGroups(names) {
  const count = new Map();
  for (const n of names) {
    const parts = n.split("_");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("_");
      count.set(p, (count.get(p) ?? 0) + 1);
    }
  }
  const of = new Map();
  for (const n of names) {
    const parts = n.split("_");
    let g = null;
    for (let i = parts.length; i >= 1; i--) {
      const p = parts.slice(0, i).join("_");
      if ((count.get(p) ?? 0) >= 2) { g = p; break; }
    }
    of.set(n, g);
  }
  // A "group" of one is not a group — those read better collected at the end.
  const size = new Map();
  for (const g of of.values()) if (g) size.set(g, (size.get(g) ?? 0) + 1);
  for (const [n, g] of of) if (!g || (size.get(g) ?? 0) < 2) of.set(n, "Other");
  return of;
}
/** Every RECORDING the Game Master can pick — one row per take, not per set
 *  (maintainer 2026-08-06: "you don't let me select the sound. You point to a
 *  group! We have way more sounds than this"). A set is a folder of
 *  alternatives: `ui_tick` holds three different clicks and `jump_voice` four
 *  different grunts, and picking the set says nothing about WHICH. Listing
 *  sets showed 128 rows for 183 real recordings, and take 2 of anything was
 *  unreachable.
 *
 *  ...and one row per take was STILL not every generated sound (maintainer,
 *  same day: "Every single generated sound? Or something else missing?").
 *  The answer was no: the composer scores a whole POOL per brief and copies
 *  only the winners out as takes, so 91 generated recordings existed on disk
 *  that no page in this wiki could reach. They are listed here as
 *  "alternative", right under the take they lost to — see build.mjs. */
function sfxLibraryList() {
  const out = [];
  // Which recordings the game actually plays today — computed from the event
  // table's own bound take files, so "in game" is exact per RECORDING rather
  // than "something in this folder is used".
  const bound = new Set();
  for (const e of state.data.sfx.events ?? []) for (const l of e.sounds) for (const t of l.takes) bound.add(t.file);

  // The composer's purpose-made candidates lead: that is what a Game Master
  // is auditioning through. The catalog follows, grouped by its category.
  const sets = Object.keys(state.data.sfx.composerSets);
  const group = composerGroups(sets);
  const ordered = [...sets].sort((a, b) => {
    const ga = group.get(a), gb = group.get(b);
    if (ga !== gb) return ga === "Other" ? 1 : gb === "Other" ? -1 : ga.localeCompare(gb);
    return a.localeCompare(b);
  });
  for (const set of ordered) {
    const cs = state.data.sfx.composerSets[set];
    const g = group.get(set);
    // Under "HIT TAKEN", the row that matters is "armor" / "gut" / "oof" —
    // repeating the action in every row only truncates the flavour, which is
    // the one thing you are choosing between. A multi-take set adds "take N".
    const flavour = g !== "Other" && set.startsWith(`${g}_`) ? set.slice(g.length + 1) : set;
    const row = (t, key, label) => out.push({
      key, wire: `composer/${set}`, take: t.file, kind: "composer",
      name: `${set} ${t.name}`, label,
      group: g === "Other" ? "Other composer sounds" : titleish(g),
      sub: cs.voice ? "voice" : "foley", file: t.file, dur: t.dur ?? null,
      voice: !!cs.voice, used: bound.has(t.file), added: cs.added ?? null,
    });
    cs.takes.forEach((t, i) => row(t, `set:${set}#${i}`,
      cs.takes.length > 1 ? `${flavour} · take ${i + 1}` : flavour));
    // The rest of the pool this set's take was chosen out of, best-scoring
    // first. Nothing about them is second-rate for YOUR event — they lost a
    // contest for a brief that is not the one you are casting.
    (cs.alts ?? []).forEach((t, i) => row(t, `alt:${set}#${i}`, `${flavour} · alternative ${i + 1}`));
  }
  for (const s of [...state.data.domains.sounds].sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name))) {
    s.takes.forEach((t, i) => out.push({
      key: `cat:${s.id}#${t.id}`, wire: s.id, take: t.files.wav, kind: "catalog",
      name: `${s.name} ${s.id} ${t.id}`,
      label: s.takes.length > 1 ? `${s.name} · take ${i + 1}` : s.name,
      group: `Catalog · ${titleish(s.category ?? "sounds")}`, sub: s.category,
      file: audioCandidates(t), dur: t.dur ?? s.duration_s ?? null,
      voice: false, used: bound.has(t.files.wav), added: null,
    }));
  }
  return out;
}
// A slug is how the domains talk to each other; it is not how a page should
// read (maintainer 2026-08-14: "the sub titles on the Scenery overview page is
// a bit technical with _ … 'ancient_trees' should be 'Ancient Trees'"). Little
// joining words stay lowercase unless they lead — "Chairs and Benches", not
// "Chairs And Benches".
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
const titleish = (s) => String(s).replace(/[_-]+/g, " ").trim().toLowerCase()
  .replace(/\S+/g, (w, i) => (i && SMALL_WORDS.has(w) ? w : w.replace(/./, (c) => c.toUpperCase())));
function openSoundPicker({ title, forWhat, onPick }) {
  // NOTHING MAY BE SOUNDING WHEN THE PICKER OPENS (maintainer 2026-08-06).
  // The modal blocks every control that could stop it, and the game's own
  // "🔇 Mute the game" button exists ONLY on the Sound Effects and Music
  // pages — so a picker opened from a monster or character card had no way
  // to reach it at all. Silence the wiki's two players AND the game.
  stopAllAudio();
  // Restore only what WE muted: the same contract the drawer keeps with the
  // player's own switches (wikipanel.ts). If the Game Master had already hit
  // Mute, closing the picker leaves the game quiet, as they asked.
  const unmuteOnClose = !gameMuted;
  setGameMuted(true);
  const all = sfxLibraryList();
  let list = all, sel = 0;
  const search = h("input", { type: "search", class: "picker-search", placeholder: `Search ${all.length} sounds…`, autocomplete: "off" });
  const listEl = h("div", { class: "picker-list" });
  // SORT: by action (the folder grouping) or newest first (maintainer
  // 2026-08-06). `added` is the composer's own per-SET `generated_at`, so a
  // set's takes and its pool candidates share one date. Newest-first reuses
  // the existing sticky group headers, grouping by DAY — "Today",
  // "Yesterday", then the date — so "what did he generate this morning" is
  // one tap, and no new per-row markup can disturb the layout.
  let sortMode = "action";
  const dayLabel = (iso) => {
    if (!iso) return "Older — the original sound library";
    const d = new Date(iso);
    if (Number.isNaN(+d)) return "Undated";
    const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const days = Math.round((midnight(new Date()) - midnight(d)) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  };
  const sortRow = h("div", { class: "picker-sort" });
  const setSort = (m) => {
    sortMode = m;
    for (const b of sortRow.children) b.classList.toggle("sel", b.dataset.mode === m);
    relist();
  };
  sortRow.append(
    h("button", { class: "picker-sort-btn sel", type: "button", "data-mode": "action",
      title: "Grouped by the action they were made for — kicks together, footsteps together",
      onclick: () => setSort("action") }, "by action"),
    h("button", { class: "picker-sort-btn", type: "button", "data-mode": "newest",
      title: "Most recently generated first, grouped by the day the composer made them",
      onclick: () => setSort("newest") }, "newest first"));
  /** Filter + sort + regroup. The list's height is FIXED in CSS, so whatever
   *  this produces — 281 rows, 3 rows, none — the Prev/Play/Next bar below it
   *  never moves. That is the rule this dialog is built around. */
  const relist = () => {
    const q = search.value.trim().toLowerCase();
    const hit = q ? all.filter((it) => `${it.name} ${it.kind} ${it.sub}`.toLowerCase().includes(q)) : all;
    if (sortMode === "newest") {
      // Undated (the original catalog) sorts LAST, never interleaved into the
      // dated run — an unknown date is not a recent one.
      list = hit.slice()
        .sort((a, b) => (b.added ?? "").localeCompare(a.added ?? "") || a.name.localeCompare(b.name))
        .map((it) => ({ ...it, group: dayLabel(it.added) }));
    } else {
      list = hit;
    }
    sel = 0;
    paint();
  };
  // The audition controls: pitch, volume, max random pitch — the SAME three
  // numbers the request carries, so what you hear is what you ask for.
  // Volume's normal value is 0 dB = exactly as recorded (maintainer).
  // `signed` marks a control whose number is a RANGE either side of the
  // pitch, not an absolute setting: it reads "±6 st", because 6 st alone says
  // "six semitones up" and that is not what it does (maintainer 2026-08-06:
  // "random pitch do work but it says 6st and not ± amount"). Zero stays a
  // plain "0 st" — "±0" is a contradiction, and 0 means never varies.
  const ctl = (min, max, step, val, unit, label, hint, signed = false) => {
    const show = (v) => `${signed && v > 0 ? "±" : ""}${stFmt(v)}${unit}`;
    const out = h("code", { class: "sfx-val" }, show(val));
    const inp = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(val), title: hint });
    inp.addEventListener("input", () => { out.textContent = show(Number(inp.value)); });
    return { row: h("label", { class: "picker-ctl" }, h("span", {}, label), inp, out), inp,
      get: () => Number(inp.value), set: (v) => { inp.value = String(v); out.textContent = show(v); } };
  };
  const pitch = ctl(0.25, 4, 0.05, 1, "×", "pitch", "Speed and pitch together — 1× is the recording as it is");
  const vol = ctl(-24, 12, 1, 0, " dB", "volume", "0 dB is the recording as it is; negative is quieter");
  const rnd = ctl(0, 6, 0.1, 0, " st", "random pitch",
    "Each play lands within this many semitones EITHER SIDE of the pitch above — 0 means always identical", true);
  const note = h("input", { type: "text", class: "picker-note", placeholder: "note to the composer (optional)" });
  const assign = h("button", { class: "primary-btn" }, "Assign this sound");
  const play = () => {
    const it = list[sel];
    if (!it?.file) return;
    void sfxEngine.rawOrAudition(it.file, { rate: pitch.get(), gainDb: vol.get(), maxSemis: rnd.get() });
  };
  let rowEls = [];
  const move = (d) => {
    if (!list.length) return;
    sel = (sel + d + list.length) % list.length;
    paint();
    rowEls[sel]?.scrollIntoView({ block: "nearest" });
    play();
  };
  const paint = () => {
    const kids = [];
    rowEls = [];
    let g = null;
    list.forEach((it, i) => {
      if (it.group && it.group !== g) { g = it.group; kids.push(h("div", { class: "picker-group" }, g)); }
      const row = h("button", {
      class: `picker-row${i === sel ? " sel" : ""}`, type: "button",
      onclick: () => { sel = i; paint(); play(); },
    },
      h("span", { class: "play-btn", "aria-hidden": "true" }, "▶"),
      h("span", { class: "take-name", title: it.name }, it.label ?? it.name),
      it.dur != null ? h("span", { class: "pill" }, fmtDur(it.dur)) : null,
      it.voice ? h("span", { class: "pill ok", title: "Vocal takes are authored at half speed — 2× is the true voice" }, "voice ×2") : null,
      it.used ? h("span", { class: "pill ok", title: "The game plays THIS recording somewhere today" }, "in game")
        : h("span", { class: "pill", title: "Nothing plays this recording yet" }, "unused"));
      rowEls.push(row);
      kids.push(row);
    });
    // The empty state lives INSIDE the list, whose height is fixed — nothing
    // below the list may change height, or the modal re-centres and the
    // buttons move out from under your finger.
    if (!list.length) kids.push(h("div", { class: "picker-empty muted" }, "Nothing matches that search."));
    listEl.replaceChildren(...kids);
    const it = list[sel];
    assign.disabled = !it;
    // A voice's honest playback is 2× — snap the slider when you land on one,
    // exactly like the raw library does, or every voice auditions wrong.
    if (it?.voice && pitch.get() === 1) pitch.set(2);
    if (it && !it.voice && pitch.get() === 2) pitch.set(1);
  };
  search.addEventListener("input", relist);
  // `autofocus` + tabindex on the DIALOG is the standards-blessed way to stop
  // showModal() from focusing the first field (and popping the keyboard):
  // showModal focuses the autofocus element when there is one.
  const dlg = h("dialog", { class: "sfx-picker", tabindex: "-1", autofocus: "" },
    h("h3", {}, title),
    h("p", { class: "muted picker-for" }, forWhat),
    search,
    sortRow,
    listEl,
    // Nothing in this row may change size as you step: the modal is centred,
    // so a line that wraps on a long name moves every button under your
    // finger (maintainer 2026-08-06 — and the selected row is already marked
    // in the accent colour, so naming it again was never needed).
    h("div", { class: "picker-bar" },
      h("button", { class: "ghost-btn", type: "button", onclick: () => move(-1) }, "← Prev"),
      h("button", { class: "ghost-btn picker-play", type: "button", onclick: play }, "▶ Play"),
      h("button", { class: "ghost-btn", type: "button", onclick: () => move(1) }, "Next →")),
    h("div", { class: "picker-ctls" }, pitch.row, vol.row, rnd.row),
    note,
    h("div", { class: "dialog-row" },
      h("button", { class: "ghost-btn", type: "button", onclick: () => dlg.close() }, "Cancel"),
      assign));
  assign.addEventListener("click", () => {
    const it = list[sel];
    if (!it) return;
    // `sound` stays the set/catalog id the composer already parses; `take` is
    // the EXACT recording that was auditioned — the whole point of listing
    // takes. Bind that one, not "something from that folder".
    onPick({ sound: it.wire, take: it.take, pitch: pitch.get(), volume_db: vol.get(), max_random_pitch_semis: rnd.get(), note: note.value.trim() || undefined });
    dlg.close();
  });
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter" && e.target !== assign) { e.preventDefault(); assign.click(); }
  });
  // Closing must silence whatever is playing — a dialog that keeps sounding
  // after it is gone is a sound you cannot stop. Fires for Cancel, Assign and
  // Escape alike, so the game always gets its audio back the same way.
  dlg.addEventListener("close", () => {
    stopAllAudio();
    if (unmuteOnClose) setGameMuted(false);
    dlg.remove();
  });
  document.body.append(dlg);
  paint();
  dlg.showModal();
  // NO autofocus on a touch device (maintainer 2026-08-06): focusing the
  // search box makes the phone keyboard leap up over the list you opened the
  // dialog to browse. The keyboard belongs to the moment you TAP the search
  // box, not to opening the picker. A desktop keeps the focus — there the
  // caret costs nothing and typing straight away is the point.
  if (matchMedia("(hover: hover) and (pointer: fine)").matches) {
    search.focus();
  } else {
    // The autofocus attribute above is the standard way to say this, but it is
    // not honoured everywhere, so take the focus back by hand — synchronously,
    // in the same task as showModal(), which is why the keyboard never gets a
    // frame to slide up in.
    document.activeElement?.blur?.();
    dlg.focus();
  }
  return dlg;
}
/** The chain, in the button's own ink. `h()` speaks HTML only, and an SVG
 *  needs its own namespace, so the markup goes in as a static string. */
function linkIcon() {
  const s = h("span", { class: "ico-link", "aria-hidden": "true" });
  s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">'
    + '<path d="M9.5 14.5 14.5 9.5"/>'
    + '<path d="M12.4 6.6 14.2 4.8a3.9 3.9 0 0 1 5.5 5.5l-1.8 1.8"/>'
    + '<path d="M11.6 17.4 9.8 19.2a3.9 3.9 0 0 1-5.5-5.5l1.8-1.8"/></svg>';
  return s;
}
/** ONE button for both places (maintainer 2026-08-06: "the same button"): an
 *  event card's card and an entity's assign card open the same picker and must
 *  read the same. */
const assignSoundBtn = (another, onclick) =>
  h("button", { class: "ghost-btn sfx-add-open", onclick },
    linkIcon(), " ", another ? "Assign another sound…" : "Assign a sound…");
function sfxAddForm(ev) {
  const queue = (req) => {
    setSfxRequest(`${ev.id}/${Date.now().toString(36)}`, { event: ev.id, ...req, requested_at: new Date().toISOString() });
    toast("Request queued — Save sends it to the composer.");
    route();
  };
  return h("div", { class: "sfx-add" },
    // The title NAMES THE TARGET (maintainer 2026-08-06): once you are three
    // screens down a list of 117 sounds, "Assign a sound" alone no longer
    // tells you what you are listening for. "Assign a sound to Drop" does.
    assignSoundBtn(ev.sounds.length > 0, () => openSoundPicker({
      title: `${ev.sounds.length ? "Assign another sound to" : "Assign a sound to"} ${ev.name}`,
      forWhat: "Plays whenever the game fires this moment. Listen your way down the list — the composer wires in what you pick.",
      onPick: queue,
    })));
}
function sfxEventCard(ev, { shared = false } = {}) {
  const reqs = state.admin ? Object.entries(state.tuning.sfx_requests?.requests ?? {}).filter(([, r]) => r?.event === ev.id) : [];
  // The event id as a stable hook. The visible id pill is admin-only, so a
  // gate that identified cards by their first pill silently matched nothing in
  // the player view and passed vacuously.
  return h("div", { class: "panel sfx-event", "data-event": ev.id },
    h("div", { class: "panel-title" },
      ev.sounds.length ? h("button", { class: "play-btn play-event", "aria-label": "play the event as the game plays it",
        onclick: () => sfxEngine.playEvent(ev) }, "▶") : null,
      ev.name,
      state.admin ? h("span", { class: "pill" }, ev.id) : null,
      // Shown ONLY on an entity page, where the reasonable assumption is that
      // a card belongs to the creature you are looking at. It does not.
      shared ? h("span", { class: "pill warn", title: "The game plays this for EVERY creature — the engine has no per-creature routing for it yet. Changing or unbinding it here changes it for all of them." }, "every creature") : null,
      ev.duck ? h("span", { class: "pill", title: "The music dips while this plays" }, "ducks music") : null,
      ev.sounds.length > 1 ? (ev.rotates
        ? h("span", { class: "pill ok", title: "One of these plays each time, never the same one twice in a row — ▶ picks one, like the game does" }, `${ev.sounds.length} in rotation`)
        : h("span", { class: "pill ok", title: "All of these play at the same time" }, `${ev.sounds.length} layered`)) : null,
      // The three states a Game Master needs at a glance: green = players
      // hear this, coral = nothing assigned, red = assigned but the game
      // never triggers it (maintainer 2026-08-06). Players only ever see
      // in-game events, so the green chip is the admin's own signal.
      !ev.sounds.length ? h("span", { class: "pill warn", title: "Nothing is assigned to this moment yet — assign a sound below" }, "no sound yet") : null,
      state.admin && ev.bound && !ev.emitted ? h("span", { class: "pill err", title: "A sound is assigned, but no game code triggers this moment — nobody can ever hear it" }, "not fired yet") : null,
      state.admin && ev.sounds.length && ev.emitted
        ? h("span", { class: "pill ok", title: "Assigned AND triggered by the game — players hear this" }, "in game") : null),
    // `note` describes the SOUND ("loops while you are in the region"); the
    // pipeline line ("assigned by the Game Master in the wiki") is shop talk
    // and was being shown to players on every creature page.
    ev.note ? h("p", { class: "muted", style: "margin:0 0 6px" }, ev.note) : null,
    state.admin && ev.adminNote ? h("p", { class: "muted", style: "margin:0 0 6px" }, ev.adminNote) : null,
    ...ev.sounds.map((l) => sfxLayerRow(ev, l, { soleLayer: ev.sounds.length === 1 })),
    ...reqs.map(([id, r]) => h("div", { class: "take-row sfx-req" },
      h("span", { class: "pill warn" }, "requested"),
      h("span", { class: "take-name" }, `${reqSound(r)} · pitch ×${stFmt(r.pitch ?? 1)} · ${stFmt(r.volume_db ?? 0)} dB · ±${stFmt(r.max_random_pitch_semis ?? 0)} st${r.note ? ` — ${r.note}` : ""}`),
      h("span", { class: "spacer" }),
      h("button", { class: "x-btn", title: "withdraw this request", onclick: () => { setSfxRequest(id, null); route(); } }, "✕"))),
    state.admin ? sfxAddForm(ev) : null);
}
/** The Game Master's raw library: EVERY take, used or not, played raw —
 *  except voices, whose honest raw is 2× (authored at half speed) — with
 *  audition sliders for pitch / volume / max random pitch. */
function sfxAllSounds() {
  const rows = [];
  const slider = (min, max, step, val, unit, title) => {
    const out = h("code", { class: "sfx-val" }, `${stFmt(val)}${unit}`);
    const inp = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(val), title });
    inp.addEventListener("input", () => { out.textContent = `${stFmt(Number(inp.value))}${unit}`; });
    return { inp, out, get: () => Number(inp.value) };
  };
  const entryRow = (name, sub, takes, { voice = false, usedBy = [] } = {}) => {
    const pitch = slider(0.25, 4, 0.05, voice ? 2 : 1, "×", "pitch");
    const vol = slider(-24, 12, 1, 0, " dB", "volume");
    const rnd = slider(0, 6, 0.1, 0, " st", "max random pitch");
    rows.push(h("div", { class: "sfx-lib-row" },
      h("div", { class: "sfx-lib-head" },
        h("span", { class: "take-name" }, name),
        h("span", { class: "pill" }, sub),
        voice ? h("span", { class: "pill ok", title: "Vocal takes are authored at half speed — raw playback is 2×" }, "voice · raw ×2") : null,
        usedBy.length
          ? h("span", { class: "pill ok", title: usedBy.join(", ") }, `used · ${usedBy.length} event${usedBy.length > 1 ? "s" : ""}`)
          : h("span", { class: "pill warn", title: "No event or routing references this — auditionable, not played by the game" }, "unused")),
      h("div", { class: "sfx-lib-ctl" },
        h("label", { class: "muted" }, "pitch ", pitch.inp, pitch.out),
        h("label", { class: "muted" }, "vol ", vol.inp, vol.out),
        h("label", { class: "muted" }, "±pitch ", rnd.inp, rnd.out)),
      ...takes.map((t) => h("div", { class: "take-row sfx-take" },
        h("button", { class: "play-btn", "aria-label": "play raw with the sliders", onclick: () =>
          void sfxEngine.rawOrAudition(t.file, { rate: pitch.get(), gainDb: vol.get(), maxSemis: rnd.get() }) }, "▶"),
        h("span", { class: "take-name muted" }, t.name),
        t.dur != null ? h("span", { class: "pill" }, fmtDur(t.dur)) : null,
        h("span", { class: "spacer" }),
        // THE recording's own verdict: ✕ here retires the file itself, which
        // is why it lives down here and not on an event's binding.
        starsWidget(t.dom, t.fid),
        verdictWidget(t.dom, t.fid, {
          rejectTitle: "Retire this RECORDING — the producing agent deletes it on its next run. To take a sound off one event without deleting it, unbind it on that event's card.",
        })))));
  };
  for (const s of state.data.domains.sounds) {
    entryRow(s.name, s.category, s.takes.map((t) => ({
      name: t.id, file: audioCandidates(t), dur: t.dur ?? null,
      dom: "sounds", fid: `${s.path}/${t.id}`.replace(/\.\w+$/, ""),
    })), { usedBy: s.usedBy ?? [] });
  }
  for (const [set, cs] of Object.entries(state.data.sfx.composerSets)) {
    // Takes and the pool they were picked from, in one row: this page is
    // "every recording in the library", and the pool is recordings.
    entryRow(set, "composer", [...cs.takes, ...(cs.alts ?? [])].map((t) => ({
      name: t.name, file: t.file, dur: t.dur ?? null,
      dom: "composer", fid: t.file.replace(/\.\w+$/, ""),
    })), { voice: cs.voice, usedBy: cs.usedBy ?? [] });
  }
  return h("div", { class: "sfx-lib" },
    h("h2", {}, "All sounds ", h("span", { class: "pill" }, "Game Master")),
    h("p", { class: "muted" }, "Every recording in the library, used or not, played raw — voices at their honest 2×. The sliders audition pitch, volume and a max random pitch without touching the game. This is where a sound is judged as a RECORDING: ✕ here retires the file everywhere. To take a sound off one event and keep it, unbind it on that event's card."),
    ...rows);
}
/* --- an ENTITY's sounds: the same cards, the same engine, the same admin
   features as the Sound Effects page — scoped to the one entity (maintainer
   2026-08-05). A hero shows their Jump and Fall (their OWN voice, routed by
   character in the game); a monster or prop with no sound yet shows nothing
   to players and an assign card to the Game Master. */
function entityAddCard(domain, ent) {
  // A synthesised `still` is not an action — nothing in the game ever fires
  // `objects.<id>.still`, so it must not appear as something to hang a sound
  // on. Static scenery has no actions at all, exactly as before it gained a
  // viewer.
  const actions = ent.stillOnly ? [] : Object.keys(ent.animations ?? {});
  if (!actions.length) return null;
  const evId = () => `${domain}.${ent.id}.${act.value}`;
  const act = h("select", { class: "sfx-pick" }, ...actions.map((a2) => h("option", { value: a2 }, stateLabel(a2))));
  const btn = assignSoundBtn(false, () => openSoundPicker({
    // Names the target the same way an event card does — here the target is
    // the entity's own action, read at the moment the button is pressed.
    title: `Assign a sound to ${ent.name ?? ent.id} · ${stateLabel(act.value)}`,
    forWhat: "A new sound event for this animation. Listen your way down the list — the composer wires in what you pick.",
    onPick: (req) => {
      setSfxRequest(`${evId()}/${Date.now().toString(36)}`, {
        event: evId(), scope: { domain, id: ent.id }, action: act.value, ...req,
        requested_at: new Date().toISOString(),
      });
      toast("Request queued — Save sends it to the composer.");
      route();
    },
  }));
  const pending = Object.entries(state.tuning.sfx_requests?.requests ?? {})
    .filter(([, r]) => r?.scope?.domain === domain && r?.scope?.id === ent.id);
  return h("div", { class: "panel sfx-entity-add" },
    // This card MAKES an event — the cards above it are events that already
    // exist — so it is titled for what it produces (maintainer 2026-08-06).
    h("div", { class: "panel-title" }, "New sound effect event ", h("span", { class: "pill" }, "Game Master")),
    h("p", { class: "muted", style: "margin:0 0 6px" }, "Assign a sound effect to a new event: pick one of this page's game actions and the sound it should play — the composer agent wires it into the engine."),
    h("div", { class: "sfx-add-row" }, h("label", { class: "muted" }, "action ", act), btn),
    ...pending.map(([id, r]) => h("div", { class: "take-row sfx-req" },
      h("span", { class: "pill warn" }, "requested"),
      h("span", { class: "take-name" }, `${stateLabel(r.action ?? "")}: ${reqSound(r)} · pitch ×${stFmt(r.pitch ?? 1)} · ${stFmt(r.volume_db ?? 0)} dB · ±${stFmt(r.max_random_pitch_semis ?? 0)} st${r.note ? ` — ${r.note}` : ""}`),
      h("span", { class: "spacer" }),
      h("button", { class: "x-btn", title: "withdraw this request", onclick: () => { setSfxRequest(id, null); route(); } }, "✕"))));
}
function entitySoundsCard(domain, ent) {
  const all = state.data.sfx?.events ?? [];
  const visible = (e) => state.admin || (e.sounds.length && e.emitted);
  // This entity's OWN events (a hero's voice — the engine routes them by who
  // you play).
  const mine = all.filter((e) => e.scope && e.scope.domain === domain && e.scope.id === ent.id).filter(visible);
  // …and the events this KIND of entity fires, which the engine does not yet
  // route per individual. A monster page showed neither, so its sounds looked
  // unassigned and there was nothing to unbind — the Game Master could only
  // ever add (maintainer 2026-08-06). They render as full cards, with the
  // same per-recording unbind, marked `shared` so it is never a surprise that
  // ✕ here takes the sound off EVERY creature.
  const shared = all.filter((e) => e.sharedWith === domain).filter(visible);
  const kids = [
    ...mine.map((e) => sfxEventCard(e)),
    ...shared.map((e) => sfxEventCard(e, { shared: true })),
  ];
  if (state.admin) { const add = entityAddCard(domain, ent); if (add) kids.push(add); }
  if (!kids.length) return null;
  return h("div", { class: "sfx-entity" }, ...kids);
}
function viewSounds() {
  const q = state.query;
  const sfx = state.data.sfx;
  if (!sfx?.events?.length) return h("div", {}, sectionHead("sounds"), h("p", { class: "muted" }, "No sound-event table in this build."));
  // Entity-SCOPED events (a hero's jump, one day a monster's roar) live on
  // that entity's page, not here — this page is the GENERIC soundscape.
  let events = sfx.events.filter((e) => !e.scope)
    .filter((e) => matches(q, e.id, e.name, e.group, ...e.sounds.map((l) => l.label)));
  // Players hear what IS IN THE GAME: an event must have a sound AND be fired
  // by game code. Wired-but-never-fired bindings (chest_open, potions…) were
  // audible here before — "sounds I have never heard inside the game"
  // (maintainer 2026-08-05). The admin keeps seeing everything, flagged.
  if (!state.admin) events = events.filter((e) => e.sounds.length && e.emitted);
  const groups = [...new Set(events.map((e) => e.group))];
  const ORDER = ["Movement", "Interface", "Items", "Tools", "Combat", "Progress", "World", "Weather", "Ambience", "System"];
  groups.sort((a, b) => (ORDER.indexOf(a) + 99 * (ORDER.indexOf(a) < 0)) - (ORDER.indexOf(b) + 99 * (ORDER.indexOf(b) < 0)));
  return h("div", {},
    sectionHead("sounds"),
    h("p", { class: "muted" }, state.admin
      ? "Every in-game sound EVENT: ▶ plays it exactly as the game does (same engine, same processing). Rate takes, withdraw or file add-a-sound requests, and audition the raw library at the bottom."
      : "What the world sounds like, by the moment that triggers it — ▶ plays it exactly as it plays in the game."),
    muteGameBtn(),
    ...groups.map((g) => h("div", {},
      h("h2", {}, g, " ", h("span", { class: "pill" }, String(events.filter((e) => e.group === g).length))),
      ...events.filter((e) => e.group === g).map((e) => sfxEventCard(e)))),
    state.admin ? sfxAllSounds() : null);
}

/* --- music --- */
/** One track panel — the same card for a music-domain track and a composer
 *  bed; only where its feedback goes and how it says "is this in the game"
 *  differ. */
function musicPanel(t) {
  const composer = t.source === "composer";
  // Feedback id = the audio file's repo path sans extension (the README
  // contract), not meta.id — they can diverge. A composer bed belongs to the
  // composer, so its verdict goes to that domain, next to its foley.
  const master = t.files.wav ?? t.files.ogg ?? t.files.m4a ?? t.files.mp3;
  const dir = master.split("/").slice(0, -1).join("/");
  const takeId = master.split("/").pop().replace(/\.\w+$/, "");
  return h("div", { class: "panel", "data-track": t.id },
    h("div", { class: "panel-title" }, t.name,
      h("span", { class: "pill" }, fmtDur(t.duration_s)),
      t.bpm ? h("span", { class: "pill" }, `${t.bpm} bpm`) : null,
      t.key ? h("span", { class: "pill" }, `${t.key.root} ${String(t.key.mode).replace(/_/g, " ")}`) : null,
      t.loopable ? h("span", { class: "pill" }, "loopable") : null,
      // A bed says whether the GAME can currently reach it — generating a
      // track and routing it are two different decisions, and the wiki must
      // not imply the second just because the first happened.
      composer
        ? (t.routed
            ? h("span", { class: "pill ok", title: "The game plays this today" }, "in game")
            : h("span", { class: "pill warn", title: "Generated and ready — nothing in the game switches to it yet" }, "not routed yet"))
        : usePill(t.usedBy, "The score's director picks one catalog track as the background bed — this one isn't it")),
    t.use ? h("p", { class: "muted", style: "margin:0 0 8px" }, t.use) : null,
    t.sections?.length ? h("p", { class: "muted", style: "margin:0 0 8px" }, "sections: ", t.sections.join(" → ")) : null,
    t.feeling?.length ? h("p", { class: "muted", style: "margin:0 0 8px" }, "feels: ", t.feeling.join(" · ")) : null,
    state.admin && composer && t.loopStart != null
      ? h("p", { class: "muted", style: "margin:0 0 8px" }, `loops ${stFmt(t.loopStart)}s → ${stFmt(t.loopEnd)}s${t.lufs != null ? ` · ${stFmt(t.lufs)} LUFS` : ""}`) : null,
    takeRow(composer ? "composer" : "music", dir, { id: takeId, chosen: true, files: t.files }));
}
/* TWO KINDS OF MUSIC, ONE SECTION (maintainer 2026-08-23: "I don't like Music
 * bench being it's own top section. I feel this is more like tabs under music.
 * This is 'Dynamic Music' and what we had before is 'Static Music'. Static
 * Music should be preselected.")
 *
 * His names, and his ordering: STATIC is the finished track that plays start to
 * end, DYNAMIC is the suite/pool/phrase score that is assembled while you play.
 * A module variable, not a stored preference — "preselected" means the page
 * opens on Static every time, while a tab chosen mid-session survives the
 * re-render a verdict causes. Players never see the tab strip at all: there is
 * nothing behind Dynamic for them. */
let musicTab = "static";
function viewMusic() {
  if (!state.admin) musicTab = "static";
  const tab = (id, label2, title) => h("button", {
    class: `pagetab${musicTab === id ? " sel" : ""}`, type: "button", title,
    onclick: () => { musicTab = id; keepScrollY = window.scrollY; route(); },
  }, label2);
  const tabs = state.admin && (state.data.bench?.tracks ?? []).length
    ? h("div", { class: "pagetabs", role: "tablist" },
      tab("static", "Static Music", "Finished tracks that play from start to end"),
      tab("dynamic", "Dynamic Music", "The suite/pool/phrase score — assembled while you play, and auditioned here"))
    : null;
  // ONE ORDER FOR BOTH TABS: crumb, title, then the tabs (maintainer
  // 2026-08-24: "Static Music have the tab over the breadcrumb (wrong).
  // Dynamic Music have the tab under the title (correct)"). Static rendered
  // its own sectionHead as its first child, so composing `tabs` in front of it
  // put the strip above the crumb on one tab and below the title on the other.
  return h("div", {}, sectionHead("music"), tabs,
    state.admin && musicTab === "dynamic" ? viewBench({ heading: false }) : viewMusicStatic({ heading: false }));
}
function viewMusicStatic(opts = {}) {
  const list = (state.data.domains.music ?? []).filter((t) => matches(state.query, t.id, t.name, t.use));
  const domainTracks = list.filter((t) => t.source !== "composer");
  const beds = list.filter((t) => t.source === "composer");
  return h("div", {},
    opts.heading === false ? null : sectionHead("music"),
    h("p", { class: "muted" }, "Everything written for the game to play — the music agent's tracks, and the composer's own situation beds."),
    muteGameBtn(),
    domainTracks.length ? h("h2", {}, "Tracks ", h("span", { class: "pill" }, String(domainTracks.length))) : null,
    ...domainTracks.map(musicPanel),
    // The composer's beds are a SECOND source of music and were missing from
    // this page entirely (maintainer 2026-08-06: "he did 5 new songs and you
    // are listing nothing but the old 2").
    beds.length ? h("h2", { style: "margin-top:26px" }, "Situation beds ", h("span", { class: "pill" }, String(beds.length))) : null,
    beds.length ? h("p", { class: "muted" }, "The composer's own score, one track per situation. What plays where is not wired yet — listen, then say which belongs where.") : null,
    ...beds.map(musicPanel));
}

/* --- items --- */
/** Every item that carries a usable id, normalised. Foreign data: never
 *  produce a feedback key of "undefined". Ordered by type (the items agent's
 *  own table order), then by what it is worth, so a page opens on the
 *  headline loot rather than on whatever sorted first alphabetically. */
function itemOrder() {
  const typeRank = Object.keys(state.data.itemTypes ?? {});
  return (state.data.domains.items ?? [])
    .filter((it) => it && (it.path || it.id))
    .map((it) => ({ ...it, path: it.path ?? `items/${it.id}`, name: it.name ?? it.id }))
    .sort((a, b) => (typeRank.indexOf(a.type) - typeRank.indexOf(b.type))
      || (Number(b.value) || 0) - (Number(a.value) || 0)
      || String(a.name).localeCompare(String(b.name)));
}
/** A soul stone's display name is the same for all of them, so it is always
 *  followed by its creature — in the nav counter, in search hits, anywhere. */
const itemLabel = (it) => {
  if (!oneToOne(it)) return it.name;
  const src = itemSources(it);
  return src.length === 1 ? `${it.name} — ${monsterById(src[0].monster)?.name ?? src[0].monster}` : `${it.name} — unbound`;
};
const itemBlurb = (it) => it.loreDesc ?? it.description ?? "";
// The Items browser's own view state: which type, and how it is sorted.
// Kept across renders so coming back from an item keeps your place.
const itemView = { type: "", sort: "value", dir: -1 };
function viewItems() {
  const all = itemOrder();
  if (!all.length) {
    return h("div", {}, sectionHead("items"),
      h("div", { class: "panel" },
        h("div", { class: "panel-title" }, "No items yet"),
        h("p", { class: "muted" }, "Nothing has been forged yet — loot appears here as it is made.")));
  }
  // Only offer types that actually HAVE items — five of the seven are
  // contracted with no art yet, and an empty filter is a dead end.
  const present = Object.keys(state.data.itemTypes ?? {}).filter((t) => all.some((it) => it.type === t));
  if (itemView.type && !present.includes(itemView.type)) itemView.type = "";
  const list = all
    .filter((it) => !itemView.type || it.type === itemView.type)
    .filter((it) => matches(state.query, it.id, it.name, it.description, it.category, it.rarity, itemLabel(it)))
    .sort((a, b) => itemView.dir * (itemView.sort === "name"
      ? String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id))
      : (Number(a.value) || 0) - (Number(b.value) || 0) || String(a.name).localeCompare(String(b.name))));

  const typeSeg = h("span", { class: "seg" });
  for (const [t, text] of [["", "All"], ...present.map((t) => [t, objTypeLabel(t)])]) {
    const b = h("button", { title: t ? objTypeLabel(t) : "Everything" }, text);
    if (t === itemView.type) b.classList.add("on");
    b.addEventListener("click", () => { itemView.type = t; route(); });
    typeSeg.append(b);
  }
  // Sort control: icons, not words — a coin for price, letters for name,
  // and one arrow that flips the direction (maintainer 2026-07-31).
  const sortSeg = h("span", { class: "seg" });
  for (const [s, glyph, title] of [
    ["value", null, "Sort by what it sells for"],
    ["name", "A–Z", "Sort by name"],
  ]) {
    const b = h("button", { title }, s === "value"
      ? h("img", { class: "gold-coin", src: "icons/gold.webp", alt: "price", width: "32", height: "32" })
      : glyph);
    if (s === itemView.sort) b.classList.add("on");
    b.addEventListener("click", () => { itemView.sort = s; route(); });
    sortSeg.append(b);
  }
  const dirBtn = h("button", { class: "ghost-btn dir-btn", title: itemView.dir < 0
    ? (itemView.sort === "name" ? "Z to A" : "Most valuable first")
    : (itemView.sort === "name" ? "A to Z" : "Least valuable first") },
    itemView.dir < 0 ? "↓" : "↑");
  dirBtn.addEventListener("click", () => { itemView.dir = -itemView.dir; route(); });

  return h("div", {},
    sectionHead("items"),
    h("p", { class: "muted" }, state.admin
      ? `${all.length} items from the items agent. Click one to see what drops it, what it sells for, and to rate or remove it.`
      : "Everything you can pick up, sell or merge — and the creatures that carry it."),
    h("div", { class: "item-tools" }, typeSeg, sortSeg, dirBtn),
    /* AN INVENTORY, NOT A SHELF OF POSTERS (maintainer 2026-08-24: "Items are
     * so small and we have so many … It's unreasonable the card is as big as a
     * monster … It also gives a more WOW feeling scrolling over a lot of
     * different graphics and be proud of the game having so many").
     *
     * Every item icon is 48x48 with a content box around 38x40 — measured on
     * all 105 — and it was sitting in a 110px-tall thumb inside a two-column
     * card built for a creature that stands 150px. Four items on a phone
     * screen, for art that fits in a thumbnail.
     *
     * So the grid is the art: one 48px icon per cell drawn at its native size
     * (pixel art at 1x, never scaled), the name under it in two clamped lines,
     * and auto-fill columns — five across a phone, more on anything wider.
     * Roughly 35 items in view where four used to be.
     *
     * NO RARITY COLOUR, deliberately: he threw the Common/Uncommon/Rare/Epic
     * vocabulary off these cards in July ("This should just say the item
     * type"), so the only mark a cell carries is the type emblem it already
     * had, plus his own review badge. */
    h("div", { class: "item-grid" }, ...list.map((it) => {
      const src = itemSources(it);
      const badges = entityBadge("items", it.path);
      return h("a", {
        class: `item-cell${src.length ? "" : " dim"}`,
        href: `#/items/${it.id}`,
        // The tile is 72px wide and a name can be four words long, so the full
        // label lives here — the caption below is the glance, this is the read.
        title: `${itemLabel(it)}${Number(it.value) > 0 ? ` · ${it.value} gold` : ""}${src.length ? ` · dropped by ${src.length}` : ""}`,
      },
        h("span", { class: "item-cell-art checker" }, itemSprite(it, 48)),
        h("span", { class: "item-cell-type", title: typeLabel(it.type) }, typeIcon(it.type)),
        badges.length ? h("span", { class: "item-cell-mark" }, ...badges) : null,
        // THE HALF THAT TELLS THEM APART. Twenty-eight of these are soulstones
        // and `name` is "Soulstone" for every one of them — the creature is the
        // difference, and the type emblem in the corner already says what KIND
        // it is. The full "Soulstone — Frostwraith" stays on the tooltip.
        h("span", { class: "item-cell-name" }, oneToOne(it) ? soulChip(it, true) : it.name),
        // WHAT IT IS WORTH, because you can sort on it (maintainer 2026-08-24:
        // "can you fit how much it's worth then to? I feel that is important
        // since you can sort on that"). A sort you cannot read down the page is
        // a sort you have to take on trust.
        //
        // WITH HIS COIN ON IT (maintainer 2026-08-24: "This gold coin icon is
        // smaller (I like icons, feels more like a game that way)") — he drew a
        // 24x24 single coin for exactly this, where the 32x32 pile the sort
        // control uses had no room at 1x. Both are drawn at their authored
        // size; nothing here is ever scaled to fit.
        Number(it.value) > 0
          ? h("span", { class: "item-cell-value", title: `Sells for ${it.value} gold` },
            h("img", { class: "coin-24", src: "icons/coin.webp", alt: "gold", width: "24", height: "24", loading: "lazy" }),
            String(it.value))
          : null);
    })));
}
function viewItem(id) {
  const all = itemOrder();
  const it = all.find((x) => x.id === id);
  if (!it) return h("p", {}, "Unknown item.");
  const type = state.data.itemTypes?.[it.type];
  return h("div", {},
    crumbRow("#/items", `← ${label("items")}`, "items", all.map((x) => ({ id: x.id, name: itemLabel(x) })), it.id),
    h("div", { class: "detail-head" },
      h("div", { class: "portrait-col" },
        h("div", { class: "portrait checker" }, itemSprite(it, 96)),
        itemChip(it)),
      h("div", { class: "meta" },
        h("h1", {}, it.name),
        goldTag(it) ? h("div", { class: "spawn-line" }, goldTag(it)) : null,
        // Pipeline facts stay behind the admin flag, as everywhere else.
        state.admin ? h("p", { class: "muted" },
          `${it.id} · ${it.type}${type?.label ? ` (${type.label})` : ""}${it.category ? ` · ${it.category}` : ""}${it.rarity ? ` · ${it.rarity}` : ""}${it.stackable ? ` · stacks to ${it.max_stack}` : ""}`) : null,
        // LAST variable-height element in this column — see loreSlot.
        loreSlot(itemBlurb(it), all.map(itemBlurb)),
        feedbackRow("items", it.path))),
    // NO "what it grants" panel: merging is not in the game yet, and the
    // wiki does not promise mechanics that do not exist (maintainer
    // 2026-07-31). It returns when the effects are real.
    droppedByPanel(it),
    storyCard({ label: "The story", art: itemSprite(it, 48), name: itemLabel(it), paras: it.loreStory, related: it.loreRelated }));   // always last
}

/* --- lore views --- */
function viewLore() {
  const list = loreList();
  if (!list.length) {
    return h("div", {}, sectionHead("lore"),
      h("div", { class: "panel" },
        h("div", { class: "panel-title" }, "Nothing written down"),
        h("p", { class: "muted" }, "No chapter of Nangijala is set down here.")));
  }
  // Groups in FIRST-APPEARANCE order of the already-sorted array, so Chapters
  // is always first and a future category appends with no code change.
  const groups = [];
  for (const e of list) {
    const key = e.category ?? "";
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, head: loreCat(e).plural, rows: [] }));
    g.rows.push(e);
  }
  const row = (e) => h("a", { class: "drop-row lore-row", href: `#/lore/${e.id}` },
    // Empty for a non-chapter, so every title still starts on the same x.
    h("span", { class: "lore-no" }, Number.isInteger(e.chapter) ? String(e.chapter) : ""),
    e.preview ? h("img", { class: "item-icon", src: assetUrl(e.preview), alt: "", width: "48", height: "48", loading: "lazy" }) : loreIcon(e, 48),
    h("span", { class: "drop-name lore-row-text" },
      h("span", { class: "lore-name" }, e.name),
      h("span", { class: "lore-sum" }, e.summary ?? "")),
    h("span", { class: "card-badges" }, ...entityBadge("lore", e.path)));
  return h("div", {},
    sectionHead("lore"),
    h("p", { class: "muted" }, state.admin
      ? `${list.length} tales from the lore agent — the one author who now writes every description in this wiki. Rate a chapter, approve it or send it back, and leave a note; the lore agent reads the verdicts on its next run.`
      // The second half must EARN the first (maintainer 2026-07-31): the old
      // "Nothing here is required" excused the reader from the page it was
      // trying to open. Promise them something instead.
      : "The chronicles of Nangijala — what the world still remembers of itself. Read them in order and it assembles itself; read one alone and it will still name something you have already walked past."),
    // The desk sits FIRST because it is the editor-in-chief's home screen and
    // the admin must not scroll the whole contents to reach the red line. It
    // costs players nothing — they never render it.
    state.admin ? loreDesk() : null,
    ...groups.flatMap((g) => [
      h("h2", {}, g.head, h("span", { class: "pill", style: "margin-left:8px" }, String(g.rows.length))),
      h("div", { class: "drop-list lore-list" }, ...g.rows.map(row)),
    ]));
}
/** Admin only — a progress report is legal here, and nowhere else. */
function loreDesk() {
  const list = loreList();
  const LORE_DOMS = ["monsters", "characters", "items", "objects", "tiles"];
  const hasLore = (e) => !!(e.loreDesc || e.loreStory?.length);
  // Derived from the entities actually rendered, so it can never claim
  // coverage the pages do not have.
  const row = (slug) => {
    const dom = state.data.domains[slug] ?? [];
    const covered = dom.filter(hasLore).length;
    const missing = dom.filter((e) => !hasLore(e)).map((e) => e.name ?? e.id);
    return h("a", { class: "drop-row", href: `#/${slug}`,
      title: missing.length && missing.length <= 12 ? `Still to write: ${missing.join(", ")}` : "" },
      sectionIcon(slug, 48),
      h("span", { class: "drop-name" }, label(slug)),
      h("span", { class: "drop-worth muted" }, `${covered} of ${dom.length}`),
      h("span", { class: "drop-pct" }, dom.length ? `${Math.round((100 * covered) / dom.length)}%` : "—"));
  };
  const unjudged = list.filter((e) => { const f = fb("lore", e.path); return !f.status && !f.rating; }).length;
  const rl = state.data.loreMeta?.redLine;
  return h("div", { class: "panel" },
    h("div", { class: "panel-title" }, "The lore agent's desk",
      h("span", { class: "pill" }, `${list.length} tales`),
      unjudged ? h("span", { class: "pill warn" }, `${unjudged} unjudged`) : null),
    h("p", { class: "muted" }, "One author writes all of it: the chapters below, and the short line and the long story on every creature, hero, prop and item page. Where the lore agent has written a description, it replaces the one the owning domain shipped."),
    h("h3", {}, "Written up"),
    h("div", { class: "drop-list" }, ...LORE_DOMS.map(row)),
    rl ? h("div", {},
      h("h3", {}, "The red line"),
      h("p", { class: "muted" }, "The Game Master's document — the backbone every chapter hangs off: five laws, three ages, one antagonist, and the questions it refuses to answer."),
      h("p", { class: "muted" }, RED_LINE_HONESTY),
      h("a", { class: "ghost-btn", href: "#/lore/red-line" }, "The red line →")) : null);
}
function viewLoreEntry(e) {
  const list = loreList();
  const i = list.findIndex((x) => x.id === e.id);
  const prev = list[(i - 1 + list.length) % list.length], next = list[(i + 1) % list.length];
  // the_falling's body[0] is byte-identical to its summary — without this the
  // same sentence prints twice, three lines apart, on the first chapter a
  // reader opens.
  const bodyParas = chapterParas(e);
  return h("div", { class: "lore-read" },
    crumbRow("#/lore", `← ${label("lore")}`, "lore", list, e.id),
    h("div", { class: "detail-head" },
      // No .checker behind the emblem: a chessboard says "here is a sprite's
      // alpha"; this is a plaque. The chip is load-bearing — it gives the left
      // column its own height so the summary's reserve lands beside something
      // taller instead of opening a hole.
      h("div", { class: "portrait-col" },
        h("div", { class: "portrait" }, loreIcon(e, 96)),
        h("div", { class: "thumb-chip" }, chipText(e))),
      h("div", { class: "meta" },
        h("h1", {}, e.name),
        state.admin ? h("p", { class: "muted" },
          `${e.id} · ${e.path} · ${e.category}${Number.isInteger(e.chapter) ? ` · chapter ${e.chapter}` : ""} · icon ${e.icon_id ?? "—"}${e.tags?.length ? ` · ${e.tags.join(", ")}` : ""} · ${(e.body ?? []).reduce((n, p) => n + paraText(p).split(/\s+/).length, 0).toLocaleString()} words in ${(e.body ?? []).length} paragraphs`) : null,
        loreSlot(e.summary ?? "", list.map((x) => x.summary ?? "")),
        feedbackRow("lore", e.path))),
    // Every paragraph is a TEXT NODE. No innerHTML, no markdown path for
    // lore.json content — "plain text only" is an authoring convention backed
    // by a partial checker, so markup that slips through must show up as
    // literal characters: obvious, and unmistakably the lore agent's bug.
    h("div", { class: "chapter-body" }, ...bodyParas.map(paraNode)),
    loreLinks(e.related) ? h("div", { class: "panel" }, loreLinks(e.related)) : null,
    // After three screens of prose the crumbRow is far off-screen; the rail
    // names the destination where the reader actually is.
    list.length > 1 ? h("div", { class: "read-rail" },
      h("a", { href: `#/lore/${prev.id}` }, h("span", { class: "rail-label" }, "Previous"), prev.name),
      h("a", { class: "to-next", href: `#/lore/${next.id}` }, h("span", { class: "rail-label" }, "Next"), next.name)) : null);
}

/* --- the red line: the Game Master's document, admin only --- */
// THE HONESTY SENTENCE. lore/RED_LINE.md is served at /assets/lore/RED_LINE.md
// by a bare express.static mount on an --allow-unauthenticated service, from a
// public repository. The wiki controls who is INVITED to read it, not who CAN.
// The words private/secret/secure/hidden may appear only inside a sentence
// that denies them, and there is no fake gate — no token, no obfuscation —
// because that would imply protection the server does not provide.
const RED_LINE_HONESTY = "Kept out of the player wiki, but not hidden: it is served at /assets/lore/RED_LINE.md and lives in the public repository. Treat it as unpublished, never as secret.";
let redLineText = null;
async function fetchText(url) {
  try { const r = await fetch(url, { cache: "no-cache" }); return r.ok ? await r.text() : null; }
  catch { return null; }
}
/** Split on the document's own `## ` boundaries. A character budget would cut a
 *  law in half; these never do. */
function redLineSections(md) {
  const out = [];
  let cur = { num: null, title: "The Red Line", lines: [] };
  for (const line of md.split(/\r?\n/)) {
    if (/^## /.test(line)) {
      out.push(cur);
      const t = line.slice(3).trim(), m = t.match(/^(\d+)\.\s*(.*)$/);
      cur = { num: m ? m[1] : null, title: m ? m[2] : t, lines: [] };
    } else if (/^# /.test(line) && !out.length && !cur.lines.length) {
      /* the page's own h1 already names the document */
    } else cur.lines.push(line);
  }
  out.push(cur);
  return out;
}
/* The ONLY markdown surface in the wiki, written against this one file's
   inventory. lore.json is plain text by contract and must NEVER reach it.
   No innerHTML anywhere: anything unhandled ships as literal characters. */
function mdInline(str) {
  const out = [];
  for (const part of String(str).split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_)/g)) {
    if (!part) continue;
    if (/^\*\*[\s\S]+\*\*$/.test(part)) out.push(h("strong", {}, part.slice(2, -2)));
    else if (/^`[^`]+`$/.test(part)) out.push(h("code", {}, part.slice(1, -1)));
    else if (/^\*[^*]+\*$/.test(part) || /^_[^_]+_$/.test(part)) out.push(h("em", {}, part.slice(1, -1)));
    else out.push(document.createTextNode(part));
  }
  return out;
}
function mdBlocks(lines) {
  const out = [];
  let i = 0;
  const take = (re) => { const buf = []; while (i < lines.length && re.test(lines[i])) buf.push(lines[i++]); return buf; };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^#{1,2} /.test(line)) { out.push(h("h2", {}, ...mdInline(line.replace(/^#{1,2} /, "")))); i++; continue; }
    if (/^### /.test(line)) { out.push(h("h3", {}, ...mdInline(line.slice(4)))); i++; continue; }
    if (/^-{3,}$/.test(line.trim())) { out.push(h("hr", {})); i++; continue; }
    if (/^> ?/.test(line)) { out.push(h("blockquote", {}, ...take(/^> ?/).map((l) => h("p", {}, ...mdInline(l.replace(/^> ?/, "")))))); continue; }
    if (/^\s*[-*] /.test(line)) { out.push(h("ul", {}, ...take(/^\s*[-*] /).map((l) => h("li", {}, ...mdInline(l.replace(/^\s*[-*] /, "")))))); continue; }
    if (/^\s*\d+\. /.test(line)) { out.push(h("ol", {}, ...take(/^\s*\d+\. /).map((l) => h("li", {}, ...mdInline(l.replace(/^\s*\d+\. /, "")))))); continue; }
    if (/^\|/.test(line)) {
      const rows = take(/^\|/).map((l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()))
        .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)));
      if (rows.length) {
        out.push(h("div", { class: "table-scroll" }, h("table", { class: "tune" },
          h("thead", {}, h("tr", {}, ...rows[0].map((c) => h("th", {}, ...mdInline(c))))),
          h("tbody", {}, ...rows.slice(1).map((r) => h("tr", {}, ...r.map((c) => h("td", {}, ...mdInline(c)))))))));
      }
      continue;
    }
    const para = take(/^(?!\s*$|#{1,3} |-{3,}$|> ?|\s*[-*] |\s*\d+\. |\|)/);
    if (para.length) out.push(h("p", {}, ...mdInline(para.join(" "))));
    else i++;
  }
  return out;
}
/** How much of the backbone the published texts actually tell (lore v2,
 *  2026-08-05): the lore build maps every beat of the root as revealed,
 *  hinted or hidden and ships the COUNTS. Drawn as one segmented bar — the
 *  GM's one-glance answer to "how much has the story given away?". */
function redLineMeter() {
  const p = state.data.loreMeta?.redLineProgress;
  if (!p) return null;
  const total = (p.revealed ?? 0) + (p.hinted ?? 0) + (p.hidden ?? 0);
  if (!total) return null;
  const seg = (n, cls, label) => (n ? h("span", { class: `rl-seg ${cls}`, style: `flex:${n}`, title: `${n} ${label}` }) : null);
  return h("div", { class: "rl-meter-box" },
    h("div", { class: "rl-meter", role: "img", "aria-label": `${p.revealed} of ${total} beats revealed` },
      seg(p.revealed, "rl-revealed", "revealed"), seg(p.hinted, "rl-hinted", "hinted"), seg(p.hidden, "rl-hidden", "still hidden")),
    h("div", { class: "muted rl-meter-legend" },
      `${p.revealed} of ${total} beats revealed in the published texts · ${p.hinted} hinted · ${p.hidden} still hidden`));
}
function viewRedLine() {
  const box = h("div", {}, h("p", { class: "loading" }, "Opening the red line…"));
  const render = (md) => {
    if (md == null) {
      box.replaceChildren(h("p", { class: "muted" }, "The red line is not in this build. It lives at lore/RED_LINE.md in the repository."));
      return;
    }
    const secs = redLineSections(md);
    // The card title is the CONSTANT string: a varying section title plus the
    // counter and two buttons will not fit one flex row at drawer width, and
    // the pager would drop to a second row on some pages and not others.
    const panel = pagedPanel({
      title: "The red line",
      pages: secs.map((sec, n) => () => (n ? [h("h2", {}, sec.title), ...mdBlocks(sec.lines)] : mdBlocks(sec.lines))),
    });
    const jump = h("div", { class: "drop-list" }, ...secs.map((sec, n) => {
      const b = h("button", { class: "drop-row", type: "button" },
        h("span", { class: "lore-no" }, sec.num ?? ""),
        h("span", { class: "drop-name" }, sec.title));
      b.addEventListener("click", () => panel.goToPage(n));
      return b;
    }));
    box.replaceChildren(
      // A <details> is closed and constant-height, so opening it and paging
      // never moves anything.
      h("details", { class: "tile-group" }, h("summary", {}, `Jump to a section (${secs.length})`), jump),
      panel);
  };
  if (redLineText != null) render(redLineText);
  else fetchText(assetUrl("lore/RED_LINE.md")).then((md) => { if (md != null) redLineText = md; render(md); });
  return h("div", { class: "lore-read" },
    h("div", { class: "crumb-row" }, h("a", { class: "crumb", href: "#/lore" }, `← ${label("lore")}`)),
    h("h1", {}, "The Red Line"),
    h("div", { class: "pill-row" },
      h("span", { class: "pill" }, "Game Master"),
      h("span", { class: "pill warn" }, "not in the game yet")),
    h("p", { class: "muted" }, "Written for you, not for players — they are meant to find this out by reading the chapters and playing."),
    h("p", { class: "muted" }, RED_LINE_HONESTY),
    redLineMeter(),
    box);
}

/* --- tuning --- */
function viewTuning() {
  const t = state.tuning.constants;
  const q = state.query;
  const rows = state.data.constants.filter((c) => matches(q, c.name, c.description, c.source));
  return h("div", {},
    sectionHead("tuning"),
    h("p", { class: "muted" }, state.admin
      ? "Game constants discovered in games2/shared. Set an override and Save — it commits to live/tuning/constants.json and is pushed to the running game and every client over the WebSocket, no redeploy. (Each system adopts its overrides as the games agent wires them in.)"
      : "The knobs behind the game — live values the designer can tune while the world runs."),
    h("div", { class: "panel table-scroll" },
      h("table", { class: "tune" },
        h("thead", {}, h("tr", {},
          h("th", {}, "constant"), h("th", {}, "game value"), h("th", {}, "override"), h("th", {}, "what it does"), h("th", {}, "source"))),
        h("tbody", {}, ...rows.map((c) => {
          const cur = t?.overrides?.[c.name];
          let overrideCell;
          if (state.admin) {
            const input = h("input", { type: "number", step: "any", value: cur !== undefined ? String(cur) : "", placeholder: String(c.value), class: cur !== undefined ? "overridden" : "" });
            input.addEventListener("change", () => {
              if (input.value === "" || Number(input.value) === c.value) delete t.overrides[c.name];
              else t.overrides[c.name] = Number(input.value);
              input.classList.toggle("overridden", t.overrides[c.name] !== undefined);
              t.updated_at = new Date().toISOString();
              touch("tuning/constants", c.name);
              markDirty("tuning/constants");
            });
            overrideCell = input;
          } else {
            overrideCell = cur !== undefined ? h("span", { class: "pill warn" }, String(cur)) : h("span", { class: "muted" }, "—");
          }
          return h("tr", {},
            h("td", {}, h("code", {}, c.name)),
            h("td", { class: "num" }, String(c.value)),
            h("td", {}, overrideCell),
            h("td", { class: "muted" }, c.description ?? ""),
            h("td", { class: "muted" }, h("code", {}, `${c.source.replace("games2/shared/src/", "")}:${c.line}`)));
        })))));
}

/* --- search --- */
function viewSearch() {
  const q = state.query;
  if (!q) return viewHome();
  const d = state.data.domains;
  const hits = [];
  d.monsters.forEach((m) => matches(q, m.id, m.name) && hits.push(["monsters", m.name, `#/monsters/${m.id}`, m.preview]));
  // The whole cast is searchable now that every NPC has a real name (they
  // were excluded while all 191 were called "Villager" — 191 identical rows
  // would have drowned every query). Name, sex and trade for a player; the
  // folder key and the duplicate PixelLab name stay admin-only.
  d.characters.forEach((c) => {
    if (matches(q, c.name, ...(c.kind === "npc" ? [c.sex, c.role] : [c.id]),
                ...(state.admin ? [c.id, c.pixellabName] : []))) {
      hits.push(["characters", c.name, `#/characters/${c.id}`, c.preview]);
    }
  });
  d.tiles.forEach((t) => matches(q, t.id, t.name, t.description) && hits.push(["tiles", t.name, `#/tiles/${t.id}`, t.groups[0] ? `${t.groups[0].dir}/${t.groups[0].tiles[0]}` : null]));
  d.objects.forEach((o) => matches(q, o.id, o.name, o.description) && hits.push(["objects", o.name, `#/objects/${o.id}`, o.preview]));
  d.sounds.forEach((s) => matches(q, s.id, s.name, s.description, s.usage) && hits.push(["sounds", s.name, "#/sounds", null]));
  d.music.forEach((t) => matches(q, t.id, t.name, t.use) && hits.push(["music", t.name, "#/music", null]));
  // Entry ids and tags are pipeline slugs — admin only, so a player cannot
  // surface an entry by typing a folder id.
  (d.lore ?? []).forEach((e) => matches(q, e.name, e.summary, ...(e.body ?? []).map(paraText), ...(state.admin ? [e.id, ...(e.tags ?? [])] : []))
    && hits.push(["lore", e.name, `#/lore/${e.id}`, loreIcon(e, 96)]));
  // A soul stone's name is shared by all of them — search its creature too,
  // and label the hit with the creature so 28 identical rows never appear.
  (d.items ?? []).forEach((it) => matches(q, it.id, it.name, it.description, it.category, it.rarity, itemLabel(it))
    && hits.push(["items", itemLabel(it), `#/items/${it.id}`, it.preview]));
  if (state.admin) state.data.constants.forEach((c) => matches(q, c.name, c.description) && hits.push(["tuning", c.name, "#/tuning", null]));
  return h("div", {},
    h("h1", {}, `Search: “${q}”`),
    h("p", { class: "muted" }, `${hits.length} hits`),
    h("div", { class: "grid" }, ...hits.slice(0, 60).map(([domain, name, href, img]) =>
      h("a", { class: "card", href },
        // A repo-relative path OR a ready Node (the lore emblem, which gets
        // no chessboard — it is a plaque, not a sprite).
        img ? h("div", { class: typeof img === "string" ? "thumb checker" : "thumb" },
          typeof img === "string" ? h("img", { src: assetUrl(img), loading: "lazy", alt: name }) : img) : null,
        h("div", { class: "card-name" }, name),
        h("div", { class: "card-sub" }, label(domain))))));
}

/* ------------------------------------------------- "what am I next to?" */
/* THE 🔍 BUTTON'S PAGE (maintainer 2026-09-02, through the games-ui agent:
 * "To the left of the Wiki in-game button will be a square search icon that
 * will also take you to the wiki, but will go directly to the search with the
 * results sorted by how far away they are from the player. This is a way to
 * fast find what you stand next to.").
 *
 * The contract is games2/spec/WIKI_NEAR.md and the seam is a postMessage: the
 * game sends one `wiki:near` snapshot when the drawer opens, and this page may
 * ask for a fresh one with `wiki:wantNear` at any time. The game FREEZES its
 * loop behind the drawer, so a snapshot is exact and cannot go stale while he
 * reads it.
 *
 * WHAT THIS PAGE DOES NOT DO: invent. Every row is (domain, id) straight from
 * the game — its route is `#/<domain>/<id>` — so a row that fails to resolve
 * is a row whose id this build has never heard of (a roster entry newer than
 * the last data.json), and it is shown PLAINLY rather than dropped. Dropping
 * it would hide the very thing he is standing next to. */
let nearSnap = null;            // the last wiki:near, or null before one lands
let nearAsked = false;          // one wantNear per visit, not one per render
const nearDist = (d) => {
  if (!(d > 0)) return "under you";
  // Never "0 cells" for something a step away, and never "1 cells".
  const n = Math.max(1, Math.round(d));
  return `${n} cell${n === 1 ? "" : "s"}`;
};
/** The card for one row: the wiki's own art and name where the id is known. */
function nearRow(it) {
  const dom = String(it?.domain ?? ""), id = String(it?.id ?? "");
  let name = id, art = null, href = `#/${dom}/${encodeURIComponent(id)}`, where = label(dom);
  if (dom === "monsters")      { const m = monsterById(id);   if (m) { name = m.name; art = m.preview; } }
  else if (dom === "characters") { const c = characterById(id); if (c) { name = c.name; art = c.preview; } }
  else if (dom === "objects")  { const o = objectById(id);    if (o) { name = o.name; art = o.preview; } }
  else if (dom === "items")    { const t = itemById(id);      if (t) { name = itemLabel(t); art = t.preview; } }
  else if (dom === "tiles")    {
    const t = tileTypeById(id);
    // The instance the player is standing on, when the game names the file.
    if (it.path) href = `#/tiles/${encodeURIComponent(id)}`;
    if (t) { name = t.name; art = it.path ?? (t.groups?.[0] ? `${t.groups[0].dir}/${t.groups[0].tiles[0]}` : null); }
    else if (it.path) art = it.path;
  } else if (dom === "world")  {
    const g = (worldMeta().groundTypes ?? []).find((x) => x.id === id);
    if (g) { name = g.name ?? id; }
    where = "Ground";
  }
  const unknown = name === id && !art && dom !== "world";
  return h("a", { class: "card", href },
    art ? h("div", { class: "thumb checker" }, h("img", { src: assetUrl(art), loading: "lazy", alt: name })) : null,
    h("div", { class: "card-name" }, name),
    h("div", { class: "card-sub" },
      h("span", { class: "pill" }, nearDist(+it.dist)),
      it.n > 1 ? h("span", { class: "muted" }, ` ×${it.n}`) : null,
      h("span", { class: "muted" }, ` · ${where}`),
      // An id this build does not know is SHOWN, and named as what it is.
      unknown ? h("span", { class: "pill warn", title: "This build's data.json has never seen this id — it is newer than the wiki's last rebuild. The page may be empty." }, "new") : null));
}
/* HEARING (maintainer 2026-09-02: "Does the #/near also contain music playing
 * right now and sound effects triggered the last 30s? (filtered on how
 * recently the sound effect was played)?"). Audio rows ride in the same items
 * array under two more domains — music, the bed playing now, and sounds, the
 * EVENTS fired in the last 30 s — carrying `ago` in seconds instead of `dist`.
 * They are their own section: seconds must never sit in a list of cells, and
 * "what is that noise" is a different question from "what is that thing". */
const isAudioRow = (it) => it?.domain === "music" || it?.domain === "sounds";
const nearAgo = (a) => (!(a > 0.5) ? "playing now" : a < 60 ? `${Math.round(a)} s ago` : `${Math.round(a / 60)} min ago`);
function nearAudioRow(it) {
  const dom = String(it.domain), id = String(it.id);
  let name = id, sub = label(dom), known = false, silent = false;
  let href = `#/${dom}/${encodeURIComponent(id)}`;
  if (dom === "music") {
    const t = (state.data.domains.music ?? []).find((x) => x.id === id);
    if (t) { name = t.name ?? id; known = true; }
  } else {
    const evs = state.data.sfx?.events ?? [];
    let ev = evs.find((x) => x.id === id);
    /* THE GAME FIRES THE FAMILY, THE TABLE KEYS THE VOICE (games-ui, 2026-09-02:
     * "player.jump ... not in your sfx.events list, so the card shows the raw
     * id and a 'new' pill for an event that has played since July"). The
     * engine emits `player.jump` and picks the hero's voice itself; the wiki
     * lists `player.jump@default_boy` and `@default_girl`, each on its hero's
     * page. So an unscoped id resolves to its scoped family: named from it,
     * and linked to the hero page where that card lives. */
    if (!ev) {
      const fam = evs.filter((x) => x.id.startsWith(`${id}@`) && x.scope?.domain && x.scope?.id);
      if (fam.length) {
        ev = fam[0];
        href = `#/${ev.scope.domain}/${encodeURIComponent(ev.scope.id)}/${encodeURIComponent(ev.id)}`;
      }
    }
    if (ev) { name = ev.name ?? id; sub = ev.group ? `${ev.group} · ${label(dom)}` : label(dom); known = true; }
    // The heard block says what actually PLAYED. sound:null on the latest
    // firing means the event fired and nothing was assigned — the row he
    // would want to give a sound to, so it is named as such.
    const last = (nearSnap?.heard?.sfx ?? []).find((x) => x?.event === id);
    if (last && last.sound === null) silent = true;
  }
  return h("a", { class: "card", href },
    h("div", { class: "thumb" }, h("span", { class: "near-glyph" }, dom === "music" ? "♪" : "🔊")),
    h("div", { class: "card-name" }, name),
    h("div", { class: "card-sub" },
      h("span", { class: "pill" }, nearAgo(+it.ago)),
      it.n > 1 ? h("span", { class: "muted" }, ` ×${it.n}`) : null,
      h("span", { class: "muted" }, ` · ${sub}`),
      silent ? h("span", { class: "pill warn", title: "This event fired but has no sound assigned — nothing was heard. Assign one on its page." }, "silent") : null,
      known ? null : h("span", { class: "pill warn", title: "This build has never seen this id — newer than the wiki's last rebuild." }, "new")));
}
function viewNear() {
  const all = nearSnap?.items ?? [];
  const rows = all.filter((it) => !isAudioRow(it));
  // Newest first, whatever order they arrived in; music (playing now) leads.
  const heard = all.filter(isAudioRow).sort((a, b2) => (a.domain === "music") - (b2.domain === "music") ? (a.domain === "music" ? -1 : 1) : (+a.ago || 0) - (+b2.ago || 0));
  const inGame = window.parent !== window;
  if (!nearSnap && inGame && !nearAsked) { nearAsked = true; askNear(); }
  return h("div", {},
    h("h1", {}, "What you are standing next to"),
    !inGame
      ? h("p", { class: "muted" }, "This page works from inside the game — tap the 🔍 button beside the Wiki button and it lists what is around you, nearest first.")
      : !nearSnap
      ? h("p", { class: "muted" }, "Asking the game what is around you…")
      : nearSnap.world === null
      ? h("p", { class: "muted" }, "You are on the select screen, so there is nothing around you yet. Enter a world and tap 🔍 again.")
      : h("div", {},
        !rows.length
          ? h("p", { class: "muted" }, `Nothing within ${nearSnap.radius ?? 12} cells — open water, or a long way from anything.`)
          : h("div", {},
            h("p", { class: "muted" }, `${rows.length} within ${nearSnap.radius ?? 12} cells, nearest first`),
            h("div", { class: "grid" }, ...rows.map(nearRow))),
        heard.length ? h("div", { class: "near-hearing" },
          h("h2", {}, "Hearing"),
          h("p", { class: "muted" }, "The music playing now, and every sound fired in the last 30 seconds, newest first."),
          h("div", { class: "grid" }, ...heard.map(nearAudioRow))) : null),
    // A snapshot is frozen by design; this is how he takes another one without
    // closing the drawer and tapping 🔍 again.
    inGame && nearSnap ? h("p", {},
      h("button", { class: "ghost-btn", onclick: () => { nearSnap = null; askNear(); route(); } }, "↻ look again")) : null);
}
function askNear() {
  if (window.parent === window) return;
  try { window.parent.postMessage({ type: "wiki:wantNear" }, location.origin); } catch {}
}

/** Scroll one card into view and flash it — after the view is in the DOM. */
function spotlight(sel) {
  requestAnimationFrame(() => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.classList.add("spot");
    el.scrollIntoView({ block: "center" });
    setTimeout(() => el.classList.remove("spot"), 2400);
  });
}
/* ---------------------------------------------------------------- router */
function route() {
  destroyPlayers();
  stopAllAudio();   // both players: a long audition used to survive the nav
  const hash = location.hash.replace(/^#\/?/, "");
  const [page, id, sub] = hash.split("/").map(decodeURIComponent);
  // THE BENCH SURVIVES A RE-RENDER, and only a re-render. Committing a verdict
  // calls route(), and the music must not stop for it — "I need to judge in
  // context" — but walking away from the page must silence it.
  const onBench = page === "bench" || (page === "music" && musicTab === "dynamic");
  if (!onBench) { benchEngine.stopAll(); benchEngine.onChange = null; }
  // Leaving a transition pair drops the fade list's frozen order, so the next
  // visit re-sorts (unreviewed first); staying on the pair — a verdict's
  // re-render, Show 12 more — keeps it.
  if (!(page === "world" && id === "transition")) fadeOrder = { key: null, keys: [], firstDone: 0 };
  let view;
  if (state.query && !id) view = viewSearch();
  else if (page === "monsters") view = id ? viewMonster(id) : viewMonsters();
  // #/characters/<hero>/<event> lights that hero's own sound card — where the
  // 🔍 page's voice-scoped rows (player.jump@default_boy) land.
  else if (page === "characters") { view = id ? viewCharacter(id) : viewCharacters(); if (id && sub) spotlight(`[data-event="${CSS.escape(sub)}"]`); }
  else if (page === "tiles") view = id ? (sub ? viewTileInstance(id, sub) : viewTileType(id)) : viewTiles();
  else if (page === "world") view = id === "transition" && sub ? viewWorldTransition(sub)
    : id ? (sub ? viewWorldPair(id, sub) : viewWorldType(id)) : viewWorld();
  else if (page === "objects") view = id ? viewObject(id) : viewObjects();
  else if (page === "near") view = viewNear();
  // #/sounds/<event> and #/music/<track> open the page and light that card —
  // the 🔍 page's audio rows land here (2026-09-02). "dynamic" stays the tab.
  else if (page === "sounds") { view = viewSounds(); if (id) spotlight(`[data-event="${CSS.escape(id)}"]`); }
  else if (page === "music") {
    if (id === "dynamic" && state.admin) musicTab = "dynamic";
    view = viewMusic();
    if (id && id !== "dynamic") spotlight(`[data-track="${CSS.escape(id)}"]`);
  }
  else if (page === "items") view = id ? viewItem(id) : viewItems();
  else if (page === "lore") {
    // Resolve the ENTRY first so a future entry can never be shadowed by the
    // reserved slug — structurally impossible, not merely unlikely.
    const e = id ? loreList().find((x) => x.id === id) : null;
    if (e) view = viewLoreEntry(e);
    else if (id === "red-line") view = state.admin ? viewRedLine() : viewLore();
    else view = viewLore();          // an unknown id lands on the list, never a dead page
  }
  // Tuning is admin-only INCLUDING by direct link — players get the overview.
  else if (page === "tuning") view = state.admin ? viewTuning() : viewHome();
  // #/bench was its own section for a day; keep the link alive as the tab.
  else if (page === "bench") { if (state.admin) musicTab = "dynamic"; view = state.admin ? viewMusic() : viewHome(); }
  else view = viewHome();
  $("#content").replaceChildren(view);
  renderNav();
  closeMenuForNav();
  // A story card must always be able to reach the top of the viewport.
  fitStoryTail();
}

// Open/close the mobile nav; keep the scrim and the hosting game drawer
// (when embedded — same-origin iframe) in sync.
//
// THE MENU OWNS ONE HISTORY ENTRY, ARMED HERE IN THE WIKI'S OWN WINDOW —
// never in the hosting drawer. Same-origin frames share ONE joint session
// history, and round one had the game drawer push/pop an entry for this
// menu: the moment a nav link stacked its new page on top, the host's pop
// removed the NAVIGATION instead of the menu — the maintainer tapped
// Overview, watched it highlight, and stayed on the same page (2026-08-14,
// with screenshots). Only the window that owns the top entry can pop it
// safely, and while the menu is open that window is this one.
//
// So: opening the menu pushes {wikiMenu}; the phone's back gesture pops it
// and we just un-draw the menu; the ✕/scrim/host close it by handing the
// entry back; and a MENU LINK navigates with location.replace while armed,
// so the destination REPLACES the menu's entry — back from the new page
// returns to the page the menu was opened over, and nothing can undo the
// click. Standalone tabs get the same behaviour free.
let menuArmed = false;
function applyMenu(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#menu-scrim").classList.toggle("on", open);
  if (window.parent !== window) {
    window.parent.postMessage({ type: "wiki:menu", open }, location.origin);
  }
}
function setMenu(open) {
  const was = $("#sidebar").classList.contains("open");
  applyMenu(open);
  if (open && !was && !menuArmed) {
    menuArmed = true;
    history.pushState({ wikiMenu: 1 }, "");
  } else if (!open && was && menuArmed) {
    menuArmed = false;
    history.back();          // hand the entry back; the popstate below sees armed=false and stays out
  }
}
// A navigation that was NOT a menu link (typed hash, code) while the menu is
// open: close the menu visually but leave its now-buried entry alone —
// popping blind is exactly the round-one bug.
function closeMenuForNav() {
  menuArmed = false;
  applyMenu(false);
}
window.addEventListener("popstate", () => {
  if (menuArmed) { menuArmed = false; applyMenu(false); }   // back gesture: menu first
});

/* ----------------------------------------------------------------- boot */
async function fetchJson(url, fallback = null) {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return fallback;
    return await res.json();
  } catch { return fallback; }
}
async function loadLiveFiles() {
  // The game server's live store is the always-fresh copy of live/** on main
  // (push-refreshed, see live/README.md). Static /assets/live files are the
  // offline fallback (viewing the wiki without the game server).
  const apiState = await fetchJson(API("/api/live/state"));
  const fromApi = (get) => { try { return get(apiState) ?? null; } catch { return null; } };
  const [monTune, constTune, sfxReq, shadowNotes, tileWalls, sceneryLightsDoc, baseTiles, baseSets, tileTopsDoc, hitboxDoc, sceneryWallsDoc, ...fbs] = apiState
    ? [fromApi((s) => s.tuning.monsters), fromApi((s) => s.tuning.constants), fromApi((s) => s.tuning.sfx_requests),
       fromApi((s) => s.tuning.shadow_notes), fromApi((s) => s.tuning.tile_walls),
       fromApi((s) => s.tuning.scenery_lights), fromApi((s) => s.tuning.base_tiles),
       fromApi((s) => s.tuning.base_tile_sets),
       fromApi((s) => s.tuning.tile_tops),
       fromApi((s) => s.tuning.scenery_hitbox),
       fromApi((s) => s.tuning.scenery_walls),
       ...FEEDBACK_DOMAINS.map((d) => fromApi((s) => s.feedback[d]))]
    : await Promise.all([
        fetchJson(new URL("live/tuning/monsters.json", ROOT)),
        fetchJson(new URL("live/tuning/constants.json", ROOT)),
        fetchJson(new URL("live/tuning/sfx_requests.json", ROOT)),
        fetchJson(new URL("live/tuning/shadow_notes.json", ROOT)),
        fetchJson(new URL("live/tuning/tile_walls.json", ROOT)),
        fetchJson(new URL("live/tuning/scenery_lights.json", ROOT)),
        fetchJson(new URL("live/tuning/base_tiles.json", ROOT)),
        fetchJson(new URL("live/tuning/base_tile_sets.json", ROOT)),
        fetchJson(new URL("live/tuning/tile_tops.json", ROOT)),
        fetchJson(new URL("live/tuning/scenery_hitbox.json", ROOT)),
        fetchJson(new URL("live/tuning/scenery_walls.json", ROOT)),
        ...FEEDBACK_DOMAINS.map((d) => fetchJson(new URL(`live/feedback/${d}.json`, ROOT))),
      ]);
  state.tuning.monsters = monTune ?? { format: "pixel-wiki-tuning-monsters@1", updated_at: "", defaults: {}, monsters: {} };
  state.tuning.constants = constTune ?? { format: "pixel-wiki-tuning-constants@1", updated_at: "", overrides: {} };
  state.tuning.sfx_requests = sfxReq ?? { format: "pixel-wiki-sfx-requests@1", updated_at: "", requests: {} };
  state.tuning.shadow_notes = shadowNotes ?? { format: "pixel-wiki-shadow-notes@1", updated_at: "", overrides: {} };
  state.tuning.tile_walls = tileWalls ?? { format: "pixel-wiki-tile-walls@1", updated_at: "", overrides: {} };
  // FOUND MISSING 2026-08-21: the lights doc was served by /api/live/state and
  // never read into state — his committed lit-corrections vanished from the
  // wiki on every reload while the file was perfectly fine. The lazy accessor
  // (sceneryLights) papered over it with an empty doc.
  state.tuning.scenery_lights = sceneryLightsDoc ?? { format: "pixel-wiki-scenery-lights@1", updated_at: "", overrides: {} };
  state.tuning.base_tiles = baseTiles ?? { format: "pixel-wiki-base-tiles@1", updated_at: "", overrides: {} };
  state.tuning.base_tile_sets = baseSets ?? { format: "pixel-wiki-base-tile-sets@1", updated_at: "", grounds: {} };
  state.tuning.tile_tops = tileTopsDoc ?? { format: "pixel-wiki-tile-tops@1", updated_at: "", overrides: {} };
  state.tuning.scenery_hitbox = hitboxDoc ?? { format: "pixel-wiki-scenery-hitbox@1", updated_at: "", overrides: {} };
  state.tuning.scenery_walls = sceneryWallsDoc ?? { format: "pixel-wiki-scenery-walls@1", updated_at: "", overrides: {} };
  FEEDBACK_DOMAINS.forEach((d, i) => {
    state.feedback[d] = fbs[i] ?? { format: "pixel-wiki-feedback@1", domain: d, updated_at: "", entries: {} };
  });
}
function initChrome() {
  // Theme: READ ONLY here. The wiki has no toggle of its own (maintainer
  // 2026-07-30) — light/dark is picked on the character-select screen, which
  // writes localStorage["wiki-theme"] and, while the wiki is open in the
  // game's drawer, mirrors data-theme straight onto this document
  // (games2/client/src/wikipanel.ts). Unset = follow the OS.
  const saved = localStorage.getItem("wiki-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  // The sticky crumb row sits directly under the sticky topbar, so it needs
  // the topbar's REAL height — it changes with the phone's font size, and a
  // hardcoded value would either gap or overlap.
  const measureBar = () => {
    const bar = $("#topbar")?.getBoundingClientRect().height;
    // CEIL, not round: the topbar measures 64.3px on a phone, and rounding
    // down parks the crumb row 0.2px over its bottom border — a hairline of
    // the wrong colour on a 3x screen.
    if (bar) document.documentElement.style.setProperty("--topbar-h", `${Math.ceil(bar)}px`);
  };
  measureBar();
  window.addEventListener("resize", measureBar);
  // sidebar (mobile) — a drawer of its own: scrim right of it closes it, and
  // the game drawer hosting us mirrors the state (double-dark game strip that
  // closes the menu first; see wikipanel.ts).
  $("#menu-btn").addEventListener("click", () => setMenu(!$("#sidebar").classList.contains("open")));
  $("#menu-scrim").addEventListener("click", () => setMenu(false));
  // Menu links replace the menu's own history entry (see setMenu) — this is
  // the click that used to be silently undone.
  $("#sidebar").addEventListener("click", (e) => {
    const a = e.target?.closest?.("a[href]");
    if (!a || !menuArmed) return;
    e.preventDefault();
    closeMenuForNav();
    location.replace(a.getAttribute("href"));
  });
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin) return;
    if (e.data?.type === "wiki:closeMenu") { setMenu(false); return; }
    /* THE SNAPSHOT (games2/spec/WIKI_NEAR.md). Same origin + same source as
     * the menu traffic. It is kept even when the reader is elsewhere in the
     * wiki, so walking Overview → back to #/near shows what the game sent
     * rather than asking again for a list that cannot have changed: the game
     * is frozen behind the drawer. */
    if (e.data?.type === "wiki:near") {
      if (window.parent !== window && e.source !== window.parent) return;
      const d = e.data;
      nearSnap = {
        world: d.world ?? null, at: d.at ?? null, radius: d.radius ?? 12,
        items: Array.isArray(d.items) ? d.items.filter((x) => x && x.domain && x.id) : [],
        // What actually played (spec: `heard`) — detail the rows cannot carry.
        heard: d.heard && typeof d.heard === "object" ? d.heard : null,
      };
      nearAsked = false;
      // NOT before the index is in. The game pushes its snapshot on the
      // iframe's `load`, and that beats the data.json fetch every time — in
      // the real drawer this route() ran on state.data === null and nearRow
      // threw at worldMeta() (games-ui, 2026-09-02, caught by their end-to-end
      // gate). Boot's own route() draws the snapshot already in hand.
      if (state.data && location.hash.replace(/^#\/?/, "").split("/")[0] === "near") route();
    }
  });
  // search
  let debounce = null;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.query = e.target.value.trim().toLowerCase();
      route();
    }, 160);
  });
  // commit / cancel
  $("#save-btn").addEventListener("click", saveAll);
  $("#discard-btn").addEventListener("click", discardAll);
  // admin login/logout
  const dlg = $("#login-dialog");
  $("#admin-btn").addEventListener("click", () => {
    if (state.admin) {
      if (state.dirty.size && !confirm("You have unsaved changes — sign out and discard them?")) return;
      localStorage.removeItem("wiki-admin-token");
      setAdmin(false);
      toast("Signed out.");
    } else {
      $("#login-error").textContent = "";
      dlg.showModal();
    }
  });
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#login-error").textContent = "";
    const btn = $("#login-submit");
    btn.disabled = true;
    try {
      const res = await fetch(API("/api/wiki/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: $("#login-user").value.trim(), password: $("#login-pass").value }),
      });
      if (!res.ok) {
        $("#login-error").textContent = res.status === 401 ? "Wrong username or password." : `Login failed (HTTP ${res.status}).`;
        return;
      }
      const { token } = await res.json();
      localStorage.setItem("wiki-admin-token", token);
      $("#login-pass").value = "";
      dlg.close();
      setAdmin(true);
      toast("Signed in — edit away.");
    } catch (err) {
      $("#login-error").textContent = `Login failed: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
  // A NEW PAGE STARTS AT ITS BEGINNING (maintainer 2026-07-31): reaching the
  // end of a chapter and tapping the next one must not drop you at that one's
  // end. Bound to the NAVIGATION event, not to route() itself, so in-place
  // re-renders — the item filter and sort — leave the reader where they are.
  // Stamp the page the reader is leaving. Capture phase, so it runs before the
  // hash changes and while the old view is still measurable. Every in-app link
  // counts, not just the story card's: Back out of a creature should land you
  // where you were in the creature list too.
  document.addEventListener("click", (e) => {
    if (e.target?.closest?.("a[href^='#/']")) rememberSpot();
  }, true);
  // Ours to place, not the browser's — it would restore its own idea of the
  // scroll after we set ours, and race us for the last word.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  /* A PAGE THAT DIES MUST SAY SO (maintainer 2026-08-28: "new Transitions
   * will not load and I have to restart the game" — unreproducible in four
   * harness set-ups, which is exactly why the page itself must carry the
   * report). One dismissible strip, first error wins, full text on it. */
  const errStrip = (msg) => {
    if (document.querySelector(".err-strip")) return;
    const bar = h("div", { class: "err-strip" },
      h("button", { class: "update-go", type: "button", style: "cursor:text",
        title: "The page hit an error — this text is what to report" }, `⚠ ${msg}`.slice(0, 220)),
      h("button", { class: "update-x", type: "button", title: "Dismiss",
        onclick: () => bar.remove() }, "✕"));
    document.body.append(bar);
  };
  window.addEventListener("error", (e) => errStrip(`${e.message ?? e.error ?? "error"} @ ${(e.filename ?? "").split("/").pop()}:${e.lineno ?? "?"}`));
  window.addEventListener("unhandledrejection", (e) => errStrip(`unhandled: ${String(e.reason).slice(0, 180)}`));
  window.addEventListener("hashchange", () => {
    const want = pendingScroll; pendingScroll = null;
    // Only an entry we stamped on the way out carries a spot, so this is a
    // Back or a Forward to a page the reader has already stood on.
    const spot = history.state?.spot;
    route();
    // A "Read next" link that points at another ENTITY lands on that entity's
    // story card — the reader asked for a story, not for a stat block. Clear
    // of the sticky topbar. Anything else, including every chapter, starts at
    // the top.
    if (want === "story") {
      const card = $(".story-card");
      if (card) {
        const bar = $("#topbar")?.getBoundingClientRect().height ?? 0;
        window.scrollTo(0, Math.max(0, card.getBoundingClientRect().top + window.scrollY - bar - 8));
        return;
      }
    }
    if (keepScrollY != null) {
      const want = keepScrollY; keepScrollY = null;
      const maxY = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      let set = Math.min(want, maxY());
      window.scrollTo(0, set);
      // A piece drawn at a different size settles its height a frame or two
      // later, so a restore CLAMPED short is worth re-trying. But only then,
      // and only while the reader has not touched the page: the first cut
      // re-applied unconditionally at 300ms and yanked the page back under a
      // moving finger — measured 560 -> 500 mid-scroll, which is what the
      // maintainer saw as the pinned bar jumping a few pixels (2026-08-15).
      const again = () => {
        if (set >= want) return;                        // nothing was clamped away
        if (Math.abs(window.scrollY - set) > 1) return; // the reader is driving now
        const next = Math.min(want, maxY());
        if (next !== set) { set = next; window.scrollTo(0, set); }
      };
      requestAnimationFrame(again);
      setTimeout(again, 300);
      return;
    }
    if (restoreSpot(spot)) return;
    window.scrollTo(0, 0);
  });
  window.addEventListener("resize", fitStoryTail);
  window.addEventListener("beforeunload", (e) => { if (state.dirty.size) e.preventDefault(); });
}

function setAdmin(on, { keepEdits = false } = {}) {
  state.admin = on;
  document.documentElement.classList.toggle("is-admin", on);
  const btn = $("#admin-btn");
  btn.textContent = on ? "Sign out (Game Master)" : "Game Master";
  btn.title = on ? "Signed in as the game designer" : "Game-designer sign in";
  if (!on && !keepEdits) { state.dirty.clear(); state.touched = {}; }
  updateSavebar();
  if (state.data) route();
}

// Validate a stored session against the server (tokens expire / restart).
async function checkAdmin() {
  if (!adminToken()) return false;
  try {
    const res = await fetch(API("/api/wiki/me"), { headers: { Authorization: `Bearer ${adminToken()}` } });
    if (!res.ok) return false;
    return !!(await res.json()).admin;
  } catch { return false; }
}

/** ADMIN SEES THE WHOLE REPO. The deployed data.json is built from the image's
 *  curated /assets, so it lists only in-game entities — correct for a player,
 *  useless for reviewing content that is not in the game yet. The repo's
 *  COMMITTED data.json is built from the full tree by the wiki agent, so an
 *  admin simply reads that one, and re-points ROOT so every thumbnail resolves
 *  against the repo too.
 *
 *  Falls back to the local copy on any failure: a CDN hiccup, a rate-limited
 *  GitHub API or an offline phone must degrade to "the wiki shows in-game
 *  content", never to a blank page. */
/* THE ART SWITCH IS NOT CONDITIONAL ON THE MANIFEST FETCH — that was the bug
 * behind "I can't see any tiles at all" (maintainer 2026-08-17, every World
 * card reading "removed").
 *
 * ROOT used to move to the repo only if the 1.1 MB data.json came back. When
 * that fetch was slow or failed, ROOT stayed on the IMAGE — which by design
 * does not carry a domain that has not shipped — so every Tiles 3.0 tile 404'd
 * and the wiki dutifully reported the whole section as deleted. The art and
 * the manifest are two different needs: the art is the one that MUST come from
 * the repo, and it is cheap.
 *
 * So a small reachable probe decides the switch (constants.json, a few hundred
 * bytes) and the big manifest is fetched separately and may fail without
 * costing anything.
 */
/* THE IMAGE SERVES THE ART; THE REPO IS THE FALLBACK. The wiki used to point
 * ROOT at the repo wholesale for an admin, which made every one of ~800 cards
 * depend on one external origin being healthy — and when it was not, the page
 * reported the entire domain as deleted.
 *
 * The image is same-origin, instant, and holds everything that has SHIPPED.
 * What it cannot hold is art that has not — Tiles 3.0 today — so a 404 against
 * it is the signal to ask the repo (see repoRetry). The cost is that a piece
 * whose art changed IN PLACE since the last deploy shows the deployed version
 * until the next one; the deploy fires on every art push, so that window is
 * minutes, and it is a far smaller price than a section that will not render.
 */
let repoBase = null;                 // set once the repo's sha is known
async function useStagingRoot() {
  // THE BASE FIRST, THE SHA SECOND. Pinning to a commit is a caching nicety;
  // KNOWING WHERE THE REPO IS decides where the first card asks for its art,
  // and every miss before that is a card that 404s at the image and cannot be
  // retried. `main` is correct immediately, the pinned sha replaces it a round
  // trip later, and an injected base needs no sha at all.
  repoBase = stagingBase("main");
  retryRepoMisses();
  repoBase = stagingBase(await stagingSha());
  retryRepoMisses();
  return await fetchJson(new URL("wiki/site/data.json", repoBase));
}
/** The same art, asked of the repo instead of the image. */
function repoTwin(url) {
  if (!repoBase) return null;
  const rel = new URL(url, location.href).pathname.replace(/^.*\/assets\//, "");
  if (!rel || rel.startsWith("/")) return null;
  return new URL(rel, repoBase).href;
}

/** The topbar's build stamp — a function because the staging upgrade replaces
 *  the data underneath it and the stamp has to follow. */
function drawStamp(data) {
  const d = new Date(data.generated_at);
  const p = (n) => String(n).padStart(2, "0");
  $("#build-stamp").replaceChildren(
    h("div", { class: "stamp-date" }, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`),
    ...(data.git_sha ? [h("div", { class: "stamp-sha", title: "The registry snapshot this page reads: repo HEAD when you are signed in as Game Master (so unreleased art is current), the deployed build's own registry otherwise. The character screen's badge names the deployed game build — the two can differ by the pushes still in flight." }, data.git_sha)] : []),
    // A STAMP THAT CANNOT LIE QUIETLY. The deploy image rebuilds this registry
    // from its own tree; if that ever fails it falls back to the committed one
    // and sets this flag (games2/Dockerfile), which used to be an invisible
    // condition — the wiki simply showed yesterday's sha as if it were today's
    // build. Now the page says so.
    ...(data.registry_stale
      ? [h("div", { class: "stamp-stale", title: "The deploy could not rebuild the wiki's registry, so this page is describing the last COMMITTED one. The sha above is that commit, not the running build." }, "stale registry")]
      : []));
}
/* THE ADMIN'S FULLER COPY ARRIVES AFTER THE FIRST PAINT, NOT BEFORE IT.
 *
 * An admin reads the REPO rather than the image, so the boot used to await:
 * a GitHub API call for HEAD's sha, then the whole 1.1 MB data.json from
 * jsDelivr at that sha — and main moves every few minutes, so the sha is
 * almost always one the CDN has never served and has to fetch cold. All of it
 * in front of the first paint, which is what he sat through: "the game is
 * currently stuck in loading the wiki … it was just very slow" (2026-08-17).
 *
 * The image's own data.json is already local and already complete for
 * everything that ships, so the wiki paints from that at once and the repo's
 * copy swaps in when it lands — the same pattern the World pairs use. Nothing
 * is lost: the staging copy is what carries art the game has not shipped, and
 * it replaces the list the moment it arrives.
 */
let stagingPending = false;
async function upgradeToStaging() {
  stagingPending = true;
  try {
    const full = await useStagingRoot();
    if (!full) return;
    // STAMP THE SHA WE FETCHED AT, not the file's self-label. build.mjs stamps
    // `git rev-parse HEAD` at build time, which in a working tree that has not
    // committed yet names the PARENT — so the committed registry's label runs
    // one commit behind and the maintainer saw the wiki claim f6cb03743 while
    // the select screen (the image's own sha) said c76d47eb8 (2026-08-20,
    // "The wiki shows something different than the game"). The sha this page
    // PINNED its fetch to is the truth about what it is reading.
    try {
      const pinned = (JSON.parse(sessionStorage.getItem("ml-staging-sha2") ?? "null")?.sha || "").slice(0, 9);
      if (pinned && pinned !== "main") full.git_sha = pinned;
    } catch { /* private mode */ }
    state.data = full;
    // The World pairs are read LIVE from the tiles agent and are newer than
    // ANY build, including this one — so the swap must not throw them away.
    // (Caught by check-world: after the upgrade the section fell back to the
    // build's ground types and lost the one the agent had just generated.)
    if (worldLive) { state.data.domains.world = worldLive; syncCounts("world"); }
    pruneKnownGone();
    drawStamp(full);
    keepScrollY = window.scrollY;
    route();
  } finally {
    stagingPending = false;
    // No base after all (offline, a blocked fetch): stop holding art hostage.
    repoBaseKnown = true;
    if (!repoBase) for (const img of [...repoMisses]) { repoMisses.delete(img); onArtMissing(img); }
  }
}

(async function boot() {
  initChrome();
  // Everything the first paint needs, in parallel — the live files do not
  // depend on the manifest, so they no longer wait for it.
  const [data, admin] = await Promise.all([
    fetchJson(new URL("data.json", location.href)),
    checkAdmin(),
    // WHAT THIS DEPLOY ACTUALLY CARRIES — one small same-origin file, fetched
    // beside the manifest rather than after it, because the answer decides
    // WHERE the first card's art is asked for. Its absence is not an error:
    // unknown falls back to asking the image and learning from the miss.
    loadShipset(),
  ]);
  if (admin) setAdmin(true); // before first route() so widgets render editable
  else localStorage.removeItem("wiki-admin-token");
  if (!data) {
    $("#content").replaceChildren(h("p", {}, "data.json missing — run ", h("code", {}, "node wiki/build.mjs"), " and reload."));
    return;
  }
  state.data = data;
  pruneKnownGone();   // pieces this session already found deleted never come back
  await loadLiveFiles();
  drawStamp(data);
  route();
  // …and only now, with the wiki on screen and usable, fetch the repo's copy.
  if (admin) upgradeToStaging();
  // Headless QA hook (mirrors the games2 __ml convention).
  window.__wiki = {
    state, route,
    // The pass -> art-path resolver, so a gate can assert WHICH pass a card
    // resolves to without counting network requests — which measures the HTTP
    // cache once anything has been viewed, not the page.
    viewArtIn,
    counts: () => state.data.counts,
    fb, setFb,
    // The synthesized third pass, exposed so QA can render it at 6x and LOOK
    // at it — a colour-count metric said "textured" about a top the maintainer
    // could see was flat (2026-08-22), so the gate now measures the surviving
    // spread and a human checks the picture.
    texSynth,
    // …and the LOADER too, because the bug that made Textured show the clean
    // tile in production was not in the maths but in how the images were
    // fetched: without CORS they taint the canvas and the synthesis dies
    // silently. The gate drives this, not a copy of it.
    texFor,
    dirty: () => [...state.dirty],
    // Static-file QA only: flips the UI to admin (the server still rejects
    // every save without a real session token).
    forceAdmin: (on = true) => setAdmin(on),
    // What the look-ahead has actually got. A network trace cannot answer
    // this — a warm URL is warm precisely because nothing is requested for it
    // — so QA (and the maintainer's "does it still work if I page fast?")
    // needs to see the cache itself.
    warmInfo: (urls) => ({
      started: warmed.size, queued: warmQ.length, active: warmActive, decoded: warmImg.size,
      mb: +(warmBytes / 1048576).toFixed(1), gen: warmGen,
      ...(Array.isArray(urls) ? {
        ready: urls.filter((u) => !!warmHit(assetUrl(u))).length,
        pending: urls.filter((u) => !warmHit(assetUrl(u)) && (warmed.has(assetUrl(u)) || warmQueued.has(assetUrl(u)))).length,
        cold: urls.filter((u) => !warmHit(assetUrl(u)) && !warmed.has(assetUrl(u)) && !warmQueued.has(assetUrl(u))).length,
        of: urls.length,
      } : {}),
    }),
  };
})();

/* GATE PROBE. The set model and the compositor are pure functions of published
 * data, so a gate can call them directly instead of inferring them from pixels
 * on screen — which is how a pass that "worked" could ship flat. */
/* A RUNNING PAGE LEARNS ABOUT NEW BUILDS (maintainer 2026-08-27, on a fix that
 * was live while his screen still ran the previous build). The wiki is a
 * single-page app he keeps in a tab or the game's drawer; nothing ever told a
 * running page that a deploy landed.
 *
 * IT COMPARES THE BEACON WITH THE BEACON, never with the page's own stamp.
 * The first cut compared version.json against state.data.git_sha — and for the
 * ADMIN those are different quantities: his page re-stamps git_sha with the
 * REPO HEAD it pinned its staging fetch to, while the beacon names the
 * DEPLOYED BUILD. Every Commit he makes to live/ moves main without deploying,
 * so the two diverged permanently and the bar returned on every tab switch,
 * pointing at an OLDER build than the one his header showed. His words: "I
 * press it and change app to claude and switch back. The same message AGAIN!"
 *
 * So the beacon read at startup IS "the build I am running", and only a later
 * beacon that differs from it means anything. Like with like, and a reload
 * re-anchors it, which is what makes the loop impossible rather than unlikely.
 *
 * It never reloads on its own — he may be mid-review with unsaved verdicts —
 * and the bar can be dismissed, so a wrong one can never trap him again. */
(() => {
  let boot = null;                    // the beacon as it read when this page started
  let bar = null, dismissed = null;
  const show = (sha) => {
    if (bar || dismissed === sha) return;
    bar = h("div", { class: "update-bar" },
      h("button", { class: "update-go", type: "button",
        title: "A newer build of the wiki is deployed. Reload to run it — unsaved changes are lost, so Commit first if the save bar is up.",
        onclick: () => location.reload() },
        `A newer build is live (${sha}) · tap to reload`),
      h("button", { class: "update-x", type: "button", title: "Not now",
        onclick: () => { dismissed = sha; bar?.remove(); bar = null; } }, "✕"));
    document.body.append(bar);
  };
  const check = async () => {
    let v = null;
    try {
      const r = await fetch(new URL("version.json", location.href), { cache: "no-store" });
      if (!r.ok) return;
      v = await r.json();
    } catch { return; }               // offline is not stale
    const sha = v?.git_sha;
    if (!sha) return;
    if (!boot) { boot = sha; return; }   // first read anchors, never offers
    if (sha !== boot) show(sha);
  };
  check();
  setInterval(check, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
})();
window.__basesets = { basePool, memberArt, groundSets, setCellArt, topSub, assetUrl, passOptions, worldViewFor, setLabel, fnv1a, pickWeighted, setsFor: groundSets, patternLib, mixTile, mixFor, platePickAt, memberPlate, transSides, xoverxArt };
