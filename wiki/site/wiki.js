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
  composerBase = (await stagingSha().then((sha) => stagingBase(sha))) ?? ROOT;
  return composerBase;
}

const assetUrl = (rel) => {
  // A domain the image has already proved it does not carry is fetched from
  // the repo directly — one 404 per domain, not one per card.
  if (repoBase && typeof rel === "string" && repoDomains.has(rel.split("/")[0])) return new URL(rel, repoBase).href;
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
async function stagingSha() {
  try {
    const hit = sessionStorage.getItem("ml-staging-sha");
    if (hit) return hit;
  } catch {}
  try {
    const r = await fetch(`https://api.github.com/repos/${STAGING_REPO}/commits/main`);
    const sha = (await r.json())?.sha;
    if (sha) {
      try { sessionStorage.setItem("ml-staging-sha", sha); } catch {}
      return sha;
    }
  } catch {}
  return "main"; // still correct, just not immutably cacheable
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
 *  does not carry goes straight there instead of 404ing first. */
const repoDomains = new Set();
async function onArtMissing(img) {
  const url = img.src;
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
  const verdict = /\/icons\//.test(url) ? "failed" : await probeArt(url);
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
const FEEDBACK_DOMAINS = ["monsters", "characters", "tiles", "objects", "sounds", "music", "items", "lore", "composer", "bindings"];
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
  knownIds: new Set(),
  query: "",
};
function touch(key, id) {
  (state.touched[key] ?? (state.touched[key] = new Set())).add(id);
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
function starsWidget(domain, id) {
  if (!state.admin) {
    const val = fb(domain, id).rating ?? 0;
    return val ? h("span", { class: "stars ro", "aria-label": `${val} stars` }, "★".repeat(val)) : h("span");
  }
  const wrap = h("span", { class: "stars", role: "radiogroup", "aria-label": "rating" });
  const render = () => {
    const val = fb(domain, id).rating ?? 0;
    wrap.replaceChildren(...[1, 2, 3, 4, 5].map((n) =>
      h("button", {
        class: n <= val ? "lit" : "", title: `${n} star${n > 1 ? "s" : ""}`,
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); setFb(domain, id, { rating: fb(domain, id).rating === n ? null : n }); render(); },
      }, n <= val ? "★" : "☆")));
  };
  render();
  return wrap;
}
// `stamp` rides into every verdict this widget writes — the scenery pages
// pass { art: <sprite hash> } so a verdict records the exact bytes it judged
// (objVerdict's staleness is then byte-exact, immune to invented dates).
function verdictWidget(domain, id, { onchange, reject = "✕ remove", rejectTitle = "Reject = the producing agent removes/replaces this on its next run", rejectedLabel = "slated for removal", rejectOnly = false, stamp = null } = {}) {
  if (!state.admin) {
    const st = fb(domain, id).status;
    if (st === "approved") return h("span", { class: "pill ok" }, "approved");
    if (st === "rejected") return h("span", { class: "pill err" }, rejectedLabel);
    return h("span");
  }
  const wrap = h("span", { class: "verdict" });
  const render = () => {
    const st = fb(domain, id).status;
    // NB: replaceChildren stringifies null into a literal "null" text node —
    // the same trap h() guards against. Filter, never pass a bare null.
    wrap.replaceChildren(...[
      // rejectOnly: a per-take unbind on an already-narrow row, where the
      // approval of the binding as a whole lives one row up.
      rejectOnly ? null : h("button", { class: st === "approved" ? "approved" : "", onclick: (e) => { e.stopPropagation(); setFb(domain, id, { status: st === "approved" ? null : "approved", ...(stamp ?? {}) }); render(); onchange?.(); } }, "✓ approve"),
      h("button", { class: st === "rejected" ? "rejected" : "", title: rejectTitle, onclick: (e) => { e.stopPropagation(); setFb(domain, id, { status: st === "rejected" ? null : "rejected", ...(stamp ?? {}) }); render(); onchange?.(); } }, reject),
    ].filter(Boolean));
  };
  render();
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
    starsWidget(domain, id),
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
    : doc.overrides;
  const v = bucket?.[id];
  return v === undefined ? null : v;
}
async function apiSaveFile(key) {
  const snapshot = new Set(state.touched[key] ?? []);
  if (!snapshot.size) { state.dirty.delete(key); return; }
  const set = Object.fromEntries([...snapshot].map((id) => [id, valueOf(key, id)]));
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
  await loadLiveFiles();
  updateSavebar();
  route();
  // "Cancel", never "Discard" (maintainer 2026-08-14: "Discard for me sounds
  // like 'discard all scenery objects'"). It throws away the pending verdicts
  // and nothing else — worth saying, since the button sits next to a page
  // full of art.
  toast("Cancelled — your uncommitted changes are back to what the game has.");
}

/* ------------------------------------------------- nadir shadow notes (admin)
 * "It has been really hard to get the nadir shadow correct in the game ... a
 * button that makes it easy to drag and resize the nadir shadow on a monster
 * direction/animation, and commit them all the same way approve/reject
 * commits" (maintainer 2026-08-15). Explicitly NOT a per-monster override:
 * "the game agent will use this data to improve the shadow placement on all
 * further monsters ... it's a way to learn how the shadows should be placed."
 *
 * So an entry records BOTH sides of the correction — what the wiki drew from
 * the art-measured metrics, and where he put it — in FRAME PIXELS at scale 1,
 * the same units monsters.json speaks. Anyone learning from this needs the
 * before as much as the after, and a note that only carried the after would be
 * unreadable the moment the measurement changes.
 */
const SHADOW_KEY = "tuning/shadow_notes";
const shadowNotes = () => state.tuning.shadow_notes ?? (state.tuning.shadow_notes = { format: "pixel-wiki-shadow-notes@1", updated_at: "", overrides: {} });
const shadowNoteId = (entity, st, dir) => `${entity.path}#${st}#${dir}`;
const shadowNote = (entity, st, dir) => shadowNotes().overrides?.[shadowNoteId(entity, st, dir)] ?? null;
/** The ellipse the wiki draws with no note: the game's own numbers. */
function shadowBase(entity, clip) {
  const fh = clip?.fh ?? entity.frameH ?? 64;
  const bb = clip?.bb ?? [0, 0, clip?.fw ?? 64, fh];
  return {
    w: entity.shadow?.w ?? 0, h: entity.shadow?.h ?? 0,
    // Where the ellipse sits, in the SAME frame pixels: x is the content
    // box's centre, y the art-measured foot line.
    cx: (bb[0] + bb[2]) / 2,
    cy: (entity.artBottom ?? 1) * fh + (entity.hoverPx ?? 0),
  };
}
/** Base plus his correction — what to draw. */
function shadowNow(entity, clip, st, dir) {
  const base = shadowBase(entity, clip);
  const n = shadowNote(entity, st, dir);
  if (!n) return { ...base, edited: false };
  return { w: n.w ?? base.w, h: n.h ?? base.h, cx: base.cx + (n.dx ?? 0), cy: base.cy + (n.dy ?? 0), edited: true };
}
function setShadowNote(entity, clip, st, dir, patch) {
  const doc = shadowNotes();
  const id = shadowNoteId(entity, st, dir);
  const base = shadowBase(entity, clip);
  // A NOTE THAT CORRECTS NOTHING IS NOT A NOTE. Dragging out and coming back —
  // which the pad's fine zone invites, since a nudge is now a real gesture —
  // otherwise stored `dx 0, dy 0, w = was.w, h = was.h`, and the games agent
  // would read that as "he confirmed this one", a claim he never made. There
  // is no gesture for confirming a shadow, so a no-op can only be an accident:
  // it drops the entry instead, which also un-does a committed note when he
  // decides the measurement was right after all.
  const noop = patch && Math.abs(patch.cx - base.cx) < 0.05 && Math.abs(patch.cy - base.cy) < 0.05
    && Math.abs(patch.w - base.w) < 0.05 && Math.abs(patch.h - base.h) < 0.05;
  if (!patch || noop) delete (doc.overrides ??= {})[id];
  else {
    (doc.overrides ??= {})[id] = {
      // What he moved it to, as a delta from the measurement — a delta is what
      // generalises; an absolute position only describes this one creature.
      dx: +(patch.cx - base.cx).toFixed(2), dy: +(patch.cy - base.cy).toFixed(2),
      w: +patch.w.toFixed(2), h: +patch.h.toFixed(2),
      // …and what the game drew before he touched it, so the correction can be
      // read without re-deriving the metrics of the day.
      was: { w: +base.w.toFixed(2), h: +base.h.toFixed(2), cx: +base.cx.toFixed(2), cy: +base.cy.toFixed(2) },
      frame: { w: clip?.fw ?? entity.frameW ?? null, h: clip?.fh ?? entity.frameH ?? null },
      updated_at: new Date().toISOString(),
    };
  }
  doc.updated_at = new Date().toISOString();
  touch(SHADOW_KEY, id);
  markDirty(SHADOW_KEY);
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
    const { ex, ey, rx, ry } = shadowHit;
    const near = (hx, hy) => Math.abs(p2.x - hx) <= GRIP && Math.abs(p2.y - hy) <= GRIP;
    const sh = shadowNow(entity, clip, cur.state, cur.dir);
    let mode = null;
    if (near(ex + rx, ey)) mode = "w";
    else if (near(ex, ey + ry)) mode = "h";
    else if (((p2.x - ex) / Math.max(1, rx)) ** 2 + ((p2.y - ey) / Math.max(1, ry)) ** 2 <= 1.6) mode = "move";
    if (!mode) return;
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
    // The origin is kept in CLIENT coordinates, with the canvas→frame scale
    // captured once: growing the ellipse grows the CANVAS (so the grip stays
    // reachable), which moves the element under the finger. A drag measured in
    // canvas pixels would read that resize as pointer movement and run away.
    const r = canvas.getBoundingClientRect();
    shadowDrag = { mode, sx: ev.clientX, sy: ev.clientY, from: { ...sh }, k: (canvas.width / (r.width || 1)) / (shadowHit.s || 1) };
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!shadowDrag) return;
    const dxF = (ev.clientX - shadowDrag.sx) * shadowDrag.k;   // frame px
    const dyF = (ev.clientY - shadowDrag.sy) * shadowDrag.k;
    const f = shadowDrag.from;
    const next = shadowDrag.mode === "move"
      ? { ...f, cx: f.cx + dxF, cy: f.cy + dyF }
      : shadowDrag.mode === "w"
        ? { ...f, w: Math.max(2, f.w + dxF * 2) }
        : { ...f, h: Math.max(2, f.h + dyF * 2) };
    setShadowNote(entity, clip, cur.state, cur.dir, next);
    onShadowEdit?.();
    refreshShadowBar();
    draw();
  });
  const endDrag = (ev) => {
    if (!shadowDrag) return;
    shadowDrag = null;
    try { canvas.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }
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
        selfMeasure(target, Array.from({ length: n }, (_, i) => [im, i * fw]), fw, fh);
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
  // clip's measured content box (build.mjs + wiki/tools/webp-pixels.mjs) and everyone
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
  function draw() {
    const fw = clip?.fw ?? entity.frameW ?? 64, fh = clip?.fh ?? entity.frameH ?? 64;
    const bb = clip?.bb ?? [0, 0, fw, fh];   // content box in frame px
    const s = cur.zoom || (state.data.artScale || 2);
    const cw = Math.max(1, bb[2] - bb[0]), ch = Math.max(1, bb[3] - bb[1]);
    // A hovering creature (butterfly_dragon) floats hoverPx above the ground,
    // so its shadow sits that much BELOW its foot line.
    const hover = (entity.hoverPx ?? 0) * s;
    const foot = (entity.artBottom ?? 1) * fh;          // ground line, frame px
    const showShadow = cur.shadow && entity.shadow;
    const shadowY = (foot - bb[1]) * s + hover;
    const shNow = showShadow ? shadowNow(entity, clip, cur.state, cur.dir) : null;
    const shBase = showShadow ? shadowBase(entity, clip) : null;
    const offX = shNow ? (shNow.cx - shBase.cx) * s : 0, offY = shNow ? (shNow.cy - shBase.cy) * s : 0;
    // THE CANVAS MUST NOT RESIZE WHILE HE IS EDITING. The stage centres the
    // canvas, so a canvas that grows or shrinks with the ellipse drags the
    // MONSTER along with it: measured, a 16px push up moved the shadow only 8px
    // on screen (the canvas shed 16px of height, the re-centring gave 8 back)
    // and the art slid under his thumb the whole time. So in edit mode the box
    // is derived from the CLIP ALONE — the frame's width, and depth enough for
    // the deepest shadow the rails can dial — which is constant for as long as
    // he stays on this animation and direction. Out of edit mode it still hugs
    // the drawn ellipse, so an ordinary preview is unchanged.
    // The reserved box is the measured ellipse plus SLACK — not the whole
    // frame, which is mostly padding (cropping it away is why this viewer
    // exists) and which left the creature marooned in a screen-wide
    // checkerboard. The slack is sized off his own corrections: the first 25
    // notes moved the ellipse by up to 12.5px and at most doubled its depth.
    const ROOM = 28;                                  // frame px, every side
    const boxW = shBase ? Math.max(shBase.w + 2 * ROOM, shBase.w * 1.6) : 0;
    const boxH = shBase ? Math.max(shBase.h + 2 * ROOM, shBase.h * 2.2) : 0;
    const shPad = cur.editShadow ? GRIP : 2;
    const wantW = Math.ceil(cur.editShadow
      ? Math.max(cw * s, boxW * s) + 2 * shPad
      : Math.max(cw * s, shNow ? 2 * (Math.abs(offX) + (shNow.w * s) / 2 + shPad) : 0));
    const wantH = Math.ceil(cur.editShadow
      ? Math.max(ch * s, shadowY + (boxH / 2) * s + shPad)
      : Math.max(ch * s, shNow ? shadowY + offY + (shNow.h * s) / 2 + shPad : 0));
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW; canvas.height = wantH;
    }
    sizeStage();   // after the canvas is sized — the stage only grows for it
    placeHuman(s); // and the size reference tracks the same scale + baseline
    updateOverflowNote();
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!clip) { frameNo.textContent = "—"; return; }
    // The frame is drawn shifted so its content box lands centred at y=0 —
    // the padding simply falls outside the canvas.
    const dx = Math.round(canvas.width / 2 - ((bb[0] + bb[2]) / 2) * s);
    const dy = Math.round(-bb[1] * s);
    if (showShadow) {
      // The game's ground ellipse — or where the Game Master says it belonged.
      const sh = shNow, base = shBase;
      // Frame pixels -> canvas pixels: the frame is drawn with its content box
      // centred, so the ellipse follows the same mapping the sprite does.
      const ex = canvas.width / 2 + offX;
      const ey = shadowY + offY;
      ctx.fillStyle = "rgba(20,16,8,0.38)";
      ctx.beginPath();
      ctx.ellipse(ex, ey, (sh.w * s) / 2, (sh.h * s) / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      shadowHit = { ex, ey, rx: (sh.w * s) / 2, ry: (sh.h * s) / 2, s };
      if (cur.editShadow) {
        // The measurement's own ellipse stays visible as a dashed ghost: a
        // correction is only readable against what it corrects.
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "rgba(217,119,87,0.75)"; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(canvas.width / 2, shadowY, (base.w * s) / 2, (base.h * s) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(217,119,87,1)"; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(ex, ey, (sh.w * s) / 2, (sh.h * s) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
        // Two grips: the right rim widens, the bottom rim flattens.
        ctx.fillStyle = "rgba(217,119,87,1)";
        for (const [hx, hy] of [[ex + (sh.w * s) / 2, ey], [ex, ey + (sh.h * s) / 2]]) {
          ctx.fillRect(hx - GRIP / 2, hy - GRIP / 2, GRIP, GRIP);
        }
        ctx.restore();
      }
    } else shadowHit = null;
    const f = Math.min(cur.frame, clip.frames - 1);
    if (img?.complete && img.naturalWidth) {
      ctx.drawImage(img, f * (img.naturalWidth / clip.frames), 0, img.naturalWidth / clip.frames, img.naturalHeight, dx, dy, fw * s, fh * s);
    } else if (frameImgs[f]?.complete && frameImgs[f].naturalWidth) {
      ctx.drawImage(frameImgs[f], dx, dy, fw * s, fh * s);
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
          loadClip(); renderStateSeg(); revealActiveState(); renderDirPad(); refreshShadowBar(); onFacetChange?.();
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
        onclick: () => { cur.dir = d; loadClip(); renderDirPad(); refreshShadowBar(); onFacetChange?.(); },
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
  const shadowResetBtn = h("button", {
    class: "ghost-btn",
    title: "Drop your note for this animation and direction — back to the shadow the game measures itself",
    onclick: () => { setShadowNote(entity, clip, cur.state, cur.dir, null); onShadowEdit?.(); refreshShadowBar(); draw(); },
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
      from: { ...shadowNow(entity, clip, cur.state, cur.dir) },
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
    setShadowNote(entity, clip, cur.state, cur.dir, { ...f, cx: f.cx + dx * padDrag.k, cy: f.cy + dy * padDrag.k });
    onShadowEdit?.(); refreshShadowBar(); draw();
  });
  const padEnd = (ev) => {
    if (!padDrag) return;
    padDrag = null;
    padEl.classList.remove("held");
    padKnob.style.transform = "";
    try { padEl.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }
  };
  padEl.addEventListener("pointerup", padEnd);
  padEl.addEventListener("pointercancel", padEnd);

  // Size is two sliders rather than two more pads: a slider is an ABSOLUTE
  // value, so the thumb can be anywhere along a rail he is not looking at
  // while his eye stays on the ellipse — and it shows how much range is left
  // in each direction, which a relative gesture cannot.
  const mkSizer = (kind, label) => {
    const inp = h("input", { type: "range", class: "shadow-slider", min: "2", step: "0.5", "aria-label": label });
    const apply = () => {
      const sh = shadowNow(entity, clip, cur.state, cur.dir);
      setShadowNote(entity, clip, cur.state, cur.dir, { ...sh, [kind]: +inp.value });
      onShadowEdit?.(); refreshShadowBar(); draw();
    };
    inp.addEventListener("input", apply);
    return inp;
  };
  const wSlider = mkSizer("w", "shadow width"), hSlider = mkSizer("h", "shadow depth");
  // The numbers lead, because they are what is being read; the instruction
  // trails, because it is only needed once.
  const shadowBar = h("div", { class: "shadow-bar hidden" },
    h("div", { class: "player-controls" }, shadowRead, shadowResetBtn),
    h("div", { class: "shadow-tools" },
      h("div", { class: "shadow-sliders" },
        h("label", {}, h("span", {}, "W"), wSlider),
        h("label", {}, h("span", {}, "H"), hSlider)),
      padEl),
    h("span", { class: "muted shadow-hint" }, "Drag the pad to move it, the rails to resize."));
  const shadowBtn = state.admin && entity.shadow
    ? h("button", {
      class: "ghost-btn shadow-btn",
      title: "Show where this shadow belonged — one note per animation and direction, committed with everything else",
      onclick: () => setEditShadow(!cur.editShadow),
    }, "✎ Edit nadir shadow")
    : null;
  function setEditShadow(on) {
    cur.editShadow = !!on && !!shadowBtn;
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
    const sh = shadowNow(entity, clip, cur.state, cur.dir), base = shadowBase(entity, clip);
    const signed = (n) => `${n < 0 ? "−" : "+"}${Math.abs(n).toFixed(1)}`;
    shadowResetBtn.disabled = !sh.edited;
    // The rails span what a shadow could sensibly be for THIS frame, so their
    // travel means something on a 34px frog and a 256px mammoth alike. Max
    // before value, or the browser clamps the value to the previous max.
    const fw = clip?.fw ?? entity.frameW ?? 64, fh = clip?.fh ?? entity.frameH ?? 64;
    wSlider.max = String(Math.max(32, Math.round(fw)));
    hSlider.max = String(Math.max(16, Math.round(fh / 2)));
    // Never fight the finger that is on the rail: writing the value back mid
    // -drag would snap the knob to the rounded number under it.
    if (document.activeElement !== wSlider) wSlider.value = String(sh.w);
    if (document.activeElement !== hSlider) hSlider.value = String(sh.h);
    shadowRead.replaceChildren(
      h("b", {}, `${sh.w.toFixed(1)} × ${sh.h.toFixed(1)} px`),
      sh.edited
        // Both halves of the correction, because both are what the games agent
        // has to learn from: where it went, and what it was moved off.
        ? ` · moved ${signed(sh.cx - base.cx)}, ${signed(sh.cy - base.cy)} — was ${base.w.toFixed(1)} × ${base.h.toFixed(1)}`
        : " · the game's own measurement, untouched",
    );
  }

  const controls2 = h("div", { class: "player-controls" },
    noTransport ? null : playBtn,
    noTransport ? null : h("button", { class: "ghost-btn", title: "Previous frame", onclick: () => step(-1) }, "⏮"),
    noTransport ? null : h("button", { class: "ghost-btn", title: "Next frame", onclick: () => step(1) }, "⏭"),
    noTransport ? null : frameNo,
    noTransport ? null : speedSeg,
    zoomSeg,
    entity.shadow ? h("label", { class: "chk" }, shadowChk, "Show shadow") : null,
    shadowBtn,
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
    stage, overflowNote, shadowBar, controls2);
  return {
    el: rootEl,
    destroy: () => cancelAnimationFrame(rafTimer),
    getState: () => cur.state,
    getDir: () => cur.dir,
    /** Repaint the approved/rejected marks — call after a verdict changes. */
    refreshMarks() { renderStateSeg(); revealActiveState(); renderDirPad(); },
    /** Nadir-shadow editing: drag/resize on the canvas, one note per facet. */
    editShadow(on) { setEditShadow(on); },
    isEditingShadow: () => cur.editShadow,
    set onShadowEdit(fn) { onShadowEdit = fn; },
    resetShadow() { setShadowNote(entity, clip, cur.state, cur.dir, null); refreshShadowBar(); draw(); },
    shadowFacet: () => ({ st: cur.state, dir: cur.dir, note: shadowNote(entity, cur.state, cur.dir), now: shadowNow(entity, clip, cur.state, cur.dir), base: shadowBase(entity, clip) }),
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
  world:      { label: "World",         noun: "pairs",      icon: "world",      count: (d) => d.counts.world, adminOnly: true },
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

function viewHome() {
  // Icon-led section tiles: the maintainer's pixel art carries each section,
  // the name is the headline and the count is the small print (2026-07-30 —
  // "the wiki start page looks so boring without icons").
  const tiles = SECTION_ORDER
    .filter((slug) => !SECTIONS[slug].adminOnly || state.admin)
    .map((slug) => [slug, SECTIONS[slug].count(state.data), SECTIONS[slug].noun]);
  // Feedback whose asset no longer exists = the producing agent acted on it.
  const resolved = [];
  for (const [domain, f] of Object.entries(state.feedback)) {
    for (const [id, entry] of Object.entries(f?.entries ?? {})) {
      if (entry.status === "rejected" && !state.knownIds.has(id.split("#")[0])) resolved.push({ domain, id });
    }
  }
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
    ...(state.admin ? [
      h("h2", {}, "How feedback works"),
      h("p", {}, "★ ratings steer style (no rating is the default). ", h("code", {}, "✕ remove"), " tells the producing agent to delete or replace the asset on its next run. ", h("code", {}, "✓ approve"), " locks in a keeper. Notes travel with the entry. Press ", h("strong", {}, "Save"), " when you're done — the game server commits ", h("code", {}, "live/feedback/*.json"), " and ", h("code", {}, "live/tuning/*.json"), " to main and pushes tuning to every connected player instantly."),
      resolved.length ? h("div", { class: "panel" },
        h("div", { class: "panel-title" }, "Resolved removals ", h("span", { class: "pill ok" }, String(resolved.length))),
        h("p", { class: "muted" }, "Assets you rejected that no longer exist in the repo — the agents acted on them."),
        ...resolved.slice(0, 30).map((r) => h("div", { class: "muted" }, h("code", {}, r.id)))) : null,
    ] : []),
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
  row.append(...options.map(([id, label, title]) => h("button", {
    class: `sortbar-btn${id === current ? " sel" : ""}`, type: "button", title, "data-sort": id,
    role: "radio", "aria-checked": id === current ? "true" : "false",
    onclick: () => { if (persist) { try { localStorage.setItem(key, id); } catch { /* private mode */ } } onPick(id); },
  }, label)));
  // The strip pans instead of wrapping, so the chosen chip can start off
  // screen — 8 types do not fit a phone. Bring it into view once laid out.
  requestAnimationFrame(() => {
    const on = row.querySelector(".sel");
    if (!on || row.scrollWidth <= row.clientWidth) return;
    // Measured with rects, not offsetLeft: the strip is not a positioned
    // ancestor, so offsetLeft is relative to whatever is, and the arithmetic
    // would be off by that element's own left edge.
    const pad = 12;
    const rr = row.getBoundingClientRect(), br = on.getBoundingClientRect();
    if (br.left < rr.left + pad) row.scrollLeft -= (rr.left + pad) - br.left;
    else if (br.right > rr.right - pad) row.scrollLeft += br.right - (rr.right - pad);
  });
  return row;
}
const MONSTER_SORT_KEY = "wiki-monster-sort";
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
  const sorted = [...list].sort(CMP[sort] ?? byName);
  const nAggro = list.filter((m) => isAggressive(stat.get(m.id))).length;
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
    h("div", { class: "grid" }, ...sorted.map((m) => {
      // The card leads with what matters to a PLAYER — the creature's stats
      // (live/tuning/monsters.json), not image resolution (maintainer
      // 2026-07-30). "not in game yet" is dev info → admin only.
      const st = stat.get(m.id);
      const sp = monsterSpawns(m.id);
      return h("a", { class: "card", href: `#/monsters/${m.id}` },
        h("div", { class: "thumb checker" }, h("img", { src: assetUrl(m.preview), alt: m.name, loading: "lazy" })),
        levelBadge(st),
        h("div", { class: "card-name" }, m.name),
        h("div", { class: "card-sub" },
          `HP ${st.max_hp ?? "?"} · DMG ${st.damage ?? "?"} · XP ${st.xp ?? "?"}${state.admin && !m.inGame ? " · not in game yet" : ""}`),
        // The habitat count is gone from here (maintainer 2026-08-06) — will
        // it come for me matters more at a glance, and the count is still on
        // the creature's own page. "not spawned" stays beside it because it
        // is a different fact from calm: that one is in no world at all.
        h("div", { class: "card-sub card-pills" }, aggroPill(st),
          sp ? null : h("span", { class: "pill", title: "No world places this creature yet — you will not meet it in the wild." }, "not spawned")),
        h("div", { class: "card-badges" }, ...entityBadge("monsters", m.path)));
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
  history.replaceState({ ...history.state, spot: {
    hash: location.hash,
    y: Math.round(window.scrollY),
    cardOff: card ? Math.round(card.getBoundingClientRect().top) : null,
    page: card?.pageIndex?.() ?? null,          // which page of the story
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
  if (card && spot.cardOff != null)
    window.scrollTo(0, Math.max(0, card.getBoundingClientRect().top + window.scrollY - spot.cardOff));
  else window.scrollTo(0, spot.y);
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
      reject: "✕ redo",
      rejectTitle: `Reject just this one — ${stateLabel(st)} facing ${dir} — for the monsters agent to regenerate`,
      rejectedLabel: "to be redone",
    }));
  };
  player.onFacetChange = renderFacet;
  renderFacet();
  // Warm every animation of this creature and of the two either side of it,
  // so clicking Walk, turning to NE or pressing › does not start a download.
  prefetchAround(m, state.data.domains.monsters, m.id);
  return h("div", {},
    crumbRow("#/monsters", `← ${label("monsters")}`, "monsters", state.data.domains.monsters, m.id),
    h("div", { class: "detail-head" },
      h("div", { class: "portrait-col" },
        h("div", { class: "portrait checker" }, h("img", { src: assetUrl(m.preview), alt: m.name })),
        levelBadge(monsterStats(m.id))),
      h("div", { class: "meta" },
        h("h1", {}, m.name),
        // How many roam the world, tucked under the name and above the
        // description (maintainer 2026-07-30).
        h("div", { class: "spawn-line" }, (() => {
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
      reject: "✕ redo",
      rejectTitle: `Reject just this one — ${stateLabel(st)} facing ${dir} — for the characters agent to regenerate`,
      rejectedLabel: "to be redone",
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
async function refreshWorldPairs() {
  if (!state.admin || worldLive) return false;
  const man = await fetchJson(new URL("tiles/review/manifest.json", ROOT));
  const cells = Object.entries(man?.cells ?? {});
  if (!cells.length) { worldLive = []; return false; }
  const names = new Map((worldMeta().groundTypes ?? []).map((g) => [g.id, g.name]));
  const nice = (id) => names.get(id) ?? String(id ?? "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const dead = new Set(worldMeta().tombstoned ?? []);
  worldLive = cells.map(([id, cell]) => {
    const cands = (cell.candidates ?? []).map((c) => ({
      key: c.key, art: c.after ?? c.file ?? null, raw: c.before ?? null,
      wallScore: c.wall_score ?? null, wall: c.wall ?? null, topShare: c.top_share ?? null,
      overhang: c.overhang ?? null, paletteTop: c.palette_top ?? null,
      tileId: c.tile_id ?? null, style: c.style ?? null, prompt: c.prompt ?? null,
    })).filter((c) => c.art && c.key);
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
/** Where a cell stands with HIM, which is not the same as where it stands with
 *  the agent: a cell is settled once one of its candidates is approved. */
function cellReview(cell) {
  let approved = 0, rejected = 0;
  for (const c of cell.candidates) {
    const st = fb("tiles", c.key).status;
    if (st === "approved") approved++;
    else if (st === "rejected") rejected++;
  }
  const piece = fb("tiles", cell.path).status;
  if (piece === "rejected") return { key: "dropped", cls: "err", text: "drop the pair" };
  if (approved) return { key: "picked", cls: "ok", text: `picked${approved > 1 ? ` (${approved})` : ""}` };
  if (rejected === cell.candidates.length) return { key: "redo", cls: "err", text: "all rejected — redo" };
  if (rejected) return { key: "partly", cls: "warn", text: `${rejected} of ${cell.candidates.length} rejected` };
  return { key: "open", cls: "", text: "not reviewed" };
}
const WORLD_FILTERS = {
  all: { label: "all", title: "Every pair the agent has generated" },
  open: { label: "not reviewed", title: "No candidate judged yet — the work to do" },
  partly: { label: "partly", title: "Some candidates judged, none picked yet" },
  picked: { label: "picked", title: "A candidate approved — this pair is settled" },
  redo: { label: "redo", title: "Every candidate rejected, or the pair dropped" },
};
const WORLD_FILTER_KEY = "wiki-world-filter";
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
const WORLD_VIEWS = {
  after: { label: "After", title: "What the game gets — the postprocessed tile" },
  before: { label: "Before", title: "The generator's raw output, before any postprocess" },
};
const worldView = () => {
  try { return WORLD_VIEWS[localStorage.getItem(WORLD_VIEW_KEY)] ? localStorage.getItem(WORLD_VIEW_KEY) : "after"; }
  catch { return "after"; }
};
/** The pair of images every World card draws. `raw` is optional — a candidate
 *  from before @2 has none, and then there is nothing to compare and no switch
 *  worth showing on it. */
function worldArt(cand, alt, box = "thumb") {
  const showRaw = worldView() === "before" && cand.raw;
  return h("div", { class: `${box} checker world-art${showRaw ? " on-before" : ""}` },
    h("img", { class: "art-after", src: assetUrl(cand.art), alt, loading: "lazy" }),
    cand.raw ? h("img", { class: "art-before", src: assetUrl(cand.raw), alt: `${alt} — before postprocess`, loading: "lazy" }) : null,
    // The badge is not decoration: mid-comparison, "which one am I looking
    // at" is the one question the screen must always answer.
    showRaw ? h("span", { class: "art-tag" }, "before") : null,
    worldView() === "before" && !cand.raw ? h("span", { class: "art-tag muted-tag" }, "no before") : null);
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
function viewWorld() {
  // Fire-and-forget: the baked list draws immediately, the live one replaces
  // it a moment later. Re-rendering only when the fetch actually landed keeps
  // the page still on every visit after the first.
  refreshWorldPairs().then((changed) => { if (changed && location.hash.startsWith("#/world")) route(); });
  const all = worldCells();
  const types = worldTypes().filter((t) => matches(state.query, t.id, t.name));
  return h("div", {},
    sectionHead("world"),
    h("p", { class: "muted" }, state.admin
      ? "Tiles 3.0 — the ground system being built to replace Tiles OLD. Open a ground type to see every wall it can stand on."
      : "The ground of Nangijala — every walkable surface over every wall it can stand on."),
    h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "What is new",
        h("span", { class: "pill" }, `${types.length} ground types`),
        h("span", { class: "pill" }, `${all.length} pairs`),
        h("span", { class: "pill" }, `${state.data.counts?.world_candidates ?? 0} candidates`)),
      h("ul", { class: "plain-list" },
        h("li", {}, h("b", {}, "No baked outline"), " — generated as colour zones, so none of Tiles OLD's four outline-fighting passes exist."),
        h("li", {}, h("b", {}, "Top and wall are separate"), " — “grass over grey stone”, so the map agent picks the surface you walk on and the wall you see independently."),
        h("li", {}, h("b", {}, "A flat top by measurement"), " — the top surface is one colour, so a whole field paints from one tile with no visible repeat."))),
    state.admin ? sortBar(WORLD_VIEW_KEY, Object.entries(WORLD_VIEWS).map(([id, v]) => [id, v.label, v.title]), worldView(), () => route()) : null,
    types.length ? h("div", { class: "grid" }, ...types.map((t) =>
      h("a", { class: "card", href: `#/world/${t.id}` },
        t.face ? worldArt(t.face, t.name) : h("div", { class: "thumb checker" }),
        h("div", { class: "card-name" }, t.name),
        h("div", { class: "card-sub" }, `${t.pairs.length} pair${t.pairs.length === 1 ? "" : "s"}`),
        h("div", { class: "card-badges" },
          state.admin && t.open ? h("span", { class: "pill warn" }, `${t.open} to review`) : null,
          state.admin && t.picked ? h("span", { class: "pill ok" }, `${t.picked} picked`) : null))))
      : h("p", { class: "muted" }, "No pairs generated yet — the tiles agent publishes them to tiles/review/manifest.json."));
}
/** One ground type: every wall it can stand on. */
function viewWorldType(top) {
  refreshWorldPairs().then((changed) => { if (changed && location.hash.startsWith("#/world")) route(); });
  const types = worldTypes();
  const t = types.find((x) => x.id === top);
  if (!t) return h("p", {}, "Unknown ground type.");
  const read = (() => { try { return localStorage.getItem(WORLD_FILTER_KEY) || "all"; } catch { return "all"; } })();
  const filter = WORLD_FILTERS[read] ? read : "all";
  const hit = (c) => {
    const r = cellReview(c).key;
    return filter === "all" || (filter === "redo" ? r === "redo" || r === "dropped" : r === filter);
  };
  const list = state.admin ? t.pairs.filter(hit) : t.pairs;
  return h("div", {},
    crumbRow("#/world", `← ${label("world")}`, "world", types, t.id),
    h("div", { class: "sect-head" }, h("h1", {}, t.name)),
    h("p", { class: "muted" }, `Walking on ${t.name.toLowerCase()} — every wall it can stand on.`),
    state.admin ? sortBar(WORLD_VIEW_KEY, Object.entries(WORLD_VIEWS).map(([id, v]) => [id, v.label, v.title]), worldView(), () => route()) : null,
    state.admin ? sortBar(WORLD_FILTER_KEY, Object.entries(WORLD_FILTERS).map(([id, f]) => {
      const n = id === "all" ? t.pairs.length : t.pairs.filter((c) => (id === "redo" ? ["redo", "dropped"] : [id]).includes(cellReview(c).key)).length;
      return [id, `${f.label} ${n}`, f.title];
    }), filter, () => route()) : null,
    list.length ? h("div", { class: "grid" }, ...list.map((c) => {
      const r = cellReview(c);
      const v = wallVerdict(c.best);
      return h("a", { class: "card", href: `#/world/${c.top}/${c.side}` },
        worldArt(c.candidates[0], c.name),
        // The TOP is the page you are on, so the card names the wall.
        h("div", { class: "card-name" }, `over ${typeLabelWorld(c.side).toLowerCase()}`),
        h("div", { class: "card-sub" }, `${c.candidates.length} tile${c.candidates.length === 1 ? "" : "s"}`),
        h("div", { class: "card-badges" },
          v ? h("span", { class: `pill ${v.cls}` }, `wall ${c.best}`) : null,
          state.admin && r.key !== "open" ? h("span", { class: `pill ${r.cls}` }, r.text) : null,
          c.tombstoned ? h("span", { class: "pill err" }, "tombstoned") : null));
    })) : h("p", { class: "muted" }, "Nothing in this filter."));
}
/* ---- HOW THE SET LOOKS WHEN IT IS TILED ----
 * Maintainer 2026-08-17: "we need to make that page where I review the
 * individual tiles in the tileset help me understand how the tileset looks
 * like when tiled together. I need both a 3x3 flat ground and the V shape from
 * tiles 2.0 had. What tiles should be used in this visualization? You should
 * use random tiles from the tileset … a Randomize button … and of course we
 * need a toggle for if we should only have approved tiles or include
 * unreviewed tiles in the randomization set."
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

const WORLD_POOL_KEY = "wiki-world-pool";
const WORLD_POOLS = {
  open: { label: "+ unreviewed", title: "Randomize over approved AND unreviewed tiles — rejected ones never appear" },
  approved: { label: "approved only", title: "Randomize over the tiles you have approved" },
};
const worldPool = () => {
  try { return WORLD_POOLS[localStorage.getItem(WORLD_POOL_KEY)] ? localStorage.getItem(WORLD_POOL_KEY) : "open"; }
  catch { return "open"; }
};
function poolFor(cell) {
  const live = cell.candidates.filter((c) => fb("tiles", c.key).status !== "rejected");
  const approved = live.filter((c) => fb("tiles", c.key).status === "approved");
  return worldPool() === "approved" ? approved : live;
}
/** A small deterministic PRNG so one Randomize press gives ONE picture, not a
 *  different one per shape — the two views have to be showing the same roll. */
const mulberry = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** What the courses under the crown are made of, in words — the flag is only
 *  useful if the picture says which rule it is following. */
function wallSource(cell, pool) {
  const walkers = pool.filter((c) => !topOnly(c.key));
  const base = worldCells().find((x) => x.top === cell.side && x.side === cell.side);
  const haveBase = base && poolFor(base).some((c) => !topOnly(c.key));
  if (walkers.length === pool.length && pool.length) return "Three 3-high stacks; this set builds its own wall.";
  if (walkers.length) return `Three 3-high stacks; the wall is built from the ${walkers.length} tile${walkers.length === 1 ? "" : "s"} in this set that can stack.`;
  if (haveBase) return `Three 3-high stacks; every tile here is top-only, so the wall is ${typeLabelWorld(cell.side).toLowerCase()} over itself.`;
  return "Three 3-high stacks; no wall-capable tile yet, so the set is stacked as it is.";
}
function worldScenes(cell, seed) {
  const pool = poolFor(cell);
  const box = h("div", { class: "world-scenes" });
  if (!pool.length) {
    box.append(h("p", { class: "muted" }, worldPool() === "approved"
      ? "No approved tiles in this set yet — switch to “+ unreviewed” to see it tiled."
      : "Every tile in this set is rejected, so there is nothing to lay out."));
    return box;
  }
  const rnd = mulberry(seed);
  const pick = () => {
    const c = pool[Math.floor(rnd() * pool.length) % pool.length];
    return (worldView() === "before" && c.raw) ? c.raw : c.art;
  };
  // 3x3 FLAT GROUND — the same patch Tiles OLD's tile page uses, so a field of
  // 3.0 is judged in the shape he has been judging 2.0 in. Nine cells, each
  // rolling its own tile: the seams that matter are the ones between
  // neighbours on BOTH axes, which a single row cannot show.
  const flat = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => ({ c, r, img: pick() })));
  // THE V, from Tiles OLD's tile page: three 3-high stacks meeting at a corner.
  //
  // ONLY THE CROWN IS THE PAIR. Maintainer 2026-08-17: "The two bottom layers
  // in a V shape should always take the tile from grass over grass, ice over
  // ice etc. That tile type is the type that always should be used in the game
  // when a tile is not at the top."
  //
  // A buried cell is all WALL — its own top is covered by the cell above — so
  // the tile that belongs there is the wall material over itself: for "grass
  // over ice" the crown is grass-topped with ice walls and everything under it
  // is ice over ice. Rolling the pair at every level instead left the pair's
  // OWN top peeking as a rim between courses (visible in the first cut: bands
  // of grass between the ice), which is a cliff the game will never build.
  // WHAT STACKS UNDER THE CROWN. By default a tile builds its own wall, so the
  // courses come from this set — but only from the tiles that CAN: one marked
  // "top only" is exactly the tile that must not appear in a wall. When none
  // of them can, the wall is the pure tile, the wall material over itself.
  const walkers = pool.filter((c) => !topOnly(c.key));
  const base = worldCells().find((x) => x.top === cell.side && x.side === cell.side);
  const basePool = base ? poolFor(base).filter((c) => !topOnly(c.key)) : [];
  const artOf = (c) => ((worldView() === "before" && c.raw) ? c.raw : c.art);
  // Nothing left to build with — no wall-capable tile in the set and no self
  // pair for the material yet (the agent is still filling the matrix). Fall
  // back to the set, since a rim is a smaller lie than a hole.
  const pickBase = () => {
    const from = walkers.length ? walkers : basePool.length ? basePool : pool;
    return artOf(from[Math.floor(rnd() * from.length) % from.length]);
  };
  const vee = [{ c: 1, r: 1 }, { c: 0, r: 1 }, { c: 1, r: 0 }].map((pos) => ({
    ...pos, lvl: 2, img: pickBase(), top: pick(), stack: [pickBase(), pickBase()],
  }));
  const paths = [...new Set([...flat, ...vee].flatMap((d) => [d.img, d.top, ...(d.stack ?? [])]).filter(Boolean))];
  loadImages(paths, (images) => {
    box.replaceChildren(
      h("div", { class: "world-scene" },
        h("div", { class: "panel-title" }, "Tiled flat — 3×3"),
        h("p", { class: "muted iso-hint" }, "Nine cells of open ground, each its own tile from the set."),
        h("div", { class: "iso-stage checker" }, isoScene(flat, images))),
      h("div", { class: "world-scene", "data-tiles": [...new Set(vee.flatMap((d) => [d.img, ...(d.stack ?? [])]))].join(" ") },
        h("div", { class: "panel-title" }, "Stacked — a cliff corner"),
        h("p", { class: "muted iso-hint" }, wallSource(cell, pool)),
        h("div", { class: "iso-stage checker" }, isoScene(vee, images))));
  });
  return box;
}
function viewWorldPair(top, side) {
  refreshWorldPairs().then((changed) => { if (changed && location.hash.startsWith("#/world")) route(); });
  const siblings = worldTypes().find((t) => t.id === top)?.pairs ?? [];
  const c = siblings.find((x) => x.side === side);
  if (!c) return h("p", {}, "Unknown pair.");
  const r = cellReview(c);
  const t = worldMeta().tile ?? {};
  // The roll lives OUTSIDE the render so Randomize repaints only the scenes:
  // re-routing would rebuild the verdict rows under his finger and lose the
  // page's scroll.
  let seed = (Date.now() ^ (c.id.length * 2654435761)) | 0;
  const sceneBox = h("div", {}, worldScenes(c, seed));
  const mixPill = h("span", { class: "pill" }, `${poolFor(c).length} of ${c.candidates.length} in the mix`);
  const reroll = () => { seed = (seed * 1103515245 + 12345) | 0; sceneBox.replaceChildren(worldScenes(c, seed)); };
  // A VERDICT CHANGES THE PICTURE. Rejecting a tile takes it out of the mix,
  // approving one puts it in — and both were computed at render time, so the
  // layout and its count stayed stale until the page was left and re-entered.
  // That is the whole point of the pool toggle: what he is looking at has to
  // be what his verdicts say the ground will be made of.
  const onVerdict = () => {
    mixPill.textContent = `${poolFor(c).length} of ${c.candidates.length} in the mix`;
    sceneBox.replaceChildren(worldScenes(c, seed));
  };
  return h("div", {},
    // The pager walks the SIDES within this ground type — crumbRow builds
    // `#/<base>/<id>`, and here the last path segment is the wall, not the
    // cell key.
    crumbRow(`#/world/${top}`, `← ${typeLabelWorld(top)}`, `world/${top}`,
      siblings.map((x) => ({ id: x.side, name: x.name })), c.side),
    h("div", { class: "detail-head" },
      h("div", { class: "portrait-col" }, worldArt(c.candidates[0], c.name, "portrait")),
      h("div", { class: "meta" },
        h("h1", {}, c.name),
        h("div", { class: "spawn-line" },
          h("span", { class: "pill" }, `walk on ${typeLabelWorld(c.top).toLowerCase()}`),
          h("span", { class: "pill" }, `wall of ${typeLabelWorld(c.side).toLowerCase()}`),
          state.admin ? h("span", { class: `pill ${r.cls}` }, r.text) : null),
        h("p", { class: "muted" }, `${c.candidates.length} tile${c.candidates.length === 1 ? "" : "s"} in this set. ${state.admin ? "Approve the ones to keep; reject the ones to regenerate." : ""}`),
        state.admin ? h("div", {},
          h("div", { class: "muted", style: "margin:10px 0 4px" }, "The pair itself"),
          feedbackRow("tiles", c.path, {
            reject: "✕ drop this pair",
            rejectTitle: "This pairing should not exist — the agent tombstones it and never generates it again",
            rejectedLabel: "dropped",
          })) : null)),
    // THE TILED VIEW COMES FIRST. "Does this set work as ground" is the
    // question the individual verdicts are answers to, so it is read before
    // them, not after.
    h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Laid out as ground", mixPill),
      state.admin ? h("div", { class: "world-viewbar" },
        h("button", { class: "ghost-btn", onclick: reroll, title: "Roll a different set of tiles into both layouts" }, "🎲 Randomize"),
        sortBar(WORLD_POOL_KEY, Object.entries(WORLD_POOLS).map(([id, v]) => [id, v.label, v.title]), worldPool(), () => route()),
        h("span", { class: "muted" }, "rejected tiles never appear")) : null,
      sceneBox),
    h("div", { class: "panel" },
      h("div", { class: "panel-title" }, "Tiles in this set",
        h("span", { class: "pill" }, "ranked by wall score")),
      state.admin ? h("div", { class: "world-viewbar" },
        h("span", { class: "muted" }, "Show"),
        sortBar(WORLD_VIEW_KEY, Object.entries(WORLD_VIEWS).map(([id, v]) => [id, v.label, v.title]), worldView(), () => route()),
        c.candidates.every((x) => !x.raw) ? h("span", { class: "muted" }, "— no raw output published for this pair") : null) : null,
      h("div", { class: "grid world-cands" }, ...c.candidates.map((cand, i) => worldCandidate(c, cand, i, onVerdict))),
      h("p", { class: "muted", style: "margin:10px 0 0" },
        `Generated at ${t.size ?? 64}px, ${t.view ?? "high top-down"}${t.outline_mode ? `, outline mode “${t.outline_mode}”` : ""}.`)));
}
/** One generation of one pair: the art, what was measured about it, and the
 *  verdict. The metrics are the agent's own — `wall_score` is what it ranks
 *  by, and the four parts are published so a low score is explainable rather
 *  than merely low. */
/** The wall-mode strip, which has to REDRAW ITSELF: a pick-one that keeps
 *  showing the old pick after you press it is worse than no control at all. */
function wallModeRow(cand, onVerdict) {
  const box = h("div", { class: "card-sub wall-mode" });
  const draw = () => box.replaceChildren(
    h("span", { class: "muted" }, "Wall"),
    sortBar(`tile-wall:${cand.key}`, Object.entries(WALL_MODES).map(([id, m]) => [id, m.label, m.title]),
      topOnly(cand.key) ? "top" : "own",
      (v) => { setTopOnly(cand.key, v === "top"); draw(); onVerdict?.(); }, { persist: false }));
  draw();
  return box;
}
function worldCandidate(cell, cand, i, onVerdict) {
  const v = wallVerdict(cand.wallScore);
  const st = state.admin ? fb("tiles", cand.key).status : null;
  const num = (x, d = 2) => (typeof x === "number" ? x.toFixed(d) : "—");
  return h("div", { class: `card world-cand${st === "approved" ? " picked" : st === "rejected" ? " dropped" : ""}` },
    worldArt(cand, `${cell.name} — generation ${i + 1}`),
    h("div", { class: "card-name" }, `#${i + 1}`,
      v ? h("span", { class: `pill ${v.cls}`, title: v.text, style: "margin-left:8px" }, `wall ${cand.wallScore}`) : null),
    cand.wall ? h("div", { class: "card-sub metric-row" },
      // Named, not lettered: he has to be able to read WHY one beat another.
      h("span", { title: "how well the wall repeats without a visible seam" }, `tiling ${num(cand.wall.tiling)}`),
      h("span", { title: "how quietly the wall texture sits — loud walls fight the art on top" }, `discretion ${num(cand.wall.discretion)}`),
      h("span", { title: "whether the wall reads as a real surface rather than noise" }, `structure ${num(cand.wall.structure)}`)) : null,
    cand.topShare != null || cand.overhang != null
      ? h("div", { class: "card-sub metric-row" },
        cand.topShare != null ? h("span", { title: "how much of the top surface is a single flat colour — what lets a whole field paint from one tile" }, `top ${(cand.topShare * 100).toFixed(1)}% flat`) : null,
        // New in @2, and the point of "A over B": the top should droop over
        // the wall rather than be cut off at it.
        cand.overhang != null ? h("span", { title: "how far the top surface droops over the wall instead of being cut off at it" }, `overhang ${num(cand.overhang)}`) : null,
        cand.paletteTop ? h("span", { class: "swatch-wrap", title: `the flat colour the top settled on — ${cand.paletteTop}` },
          h("span", { class: "swatch", style: `background:${/^#[0-9a-f]{3,8}$/i.test(cand.paletteTop) ? cand.paletteTop : "transparent"}` }), cand.paletteTop) : null)
      : null,
    // CAN IT BUILD A WALL? Its own row, above the verdict: this is not a
    // judgement on the tile, it is what the tile is FOR, and a tile marked
    // top-only is still a keeper.
    state.admin ? wallModeRow(cand, onVerdict) : null,
    state.admin ? h("div", { class: "card-sub" },
      feedbackRow("tiles", cand.key, {
        onchange: onVerdict,
        reject: "✕ redo",
        rejectTitle: "Reject this generation — the agent deletes it on PixelLab and generates another",
        rejectedLabel: "to be redone",
      })) : null,
    state.admin && cand.prompt
      ? h("details", { class: "world-prompt" }, h("summary", {}, "prompt"), h("p", {}, cand.prompt),
        cand.tileId ? h("p", { class: "muted mono" }, cand.tileId) : null)
      : null);
}

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
      onclick: () => { setFb("tiles", id, { status: fb("tiles", id).status === "rejected" ? null : "rejected" }); sync(); },
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
function isoScene(cells, images, scale = 1, pad = 4) {
  const iso = state.data.iso ?? { tilePx: 64, dx: 32, dy: 15, levelPx: 16 };
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
    ctx.drawImage(im, (px(d) - minX + pad) * scale, (py(d) - minY + pad) * scale, iso.tilePx * scale, iso.tilePx * scale);
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
  for (const p of uniq) {
    const im = new Image();
    im.onload = im.onerror = () => { out[p] = im.naturalWidth ? im : null; if (--left <= 0) cb(out); };
    im.src = assetUrl(p);
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
};
const OBJ_SORTS = {
  group: { label: "by group", title: "Grouped by kind, alphabetical — the classic view" },
  newest: { label: "newest first", title: "Latest generated content first" },
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
  // `added` is the commit that introduced the piece (build.mjs). Undated art
  // sorts last rather than first — a missing date is not a claim of newness.
  if (sort === "newest") list = [...list].sort((a, b) => String(b.added ?? "").localeCompare(String(a.added ?? "")));
  return { list, sort, filter, type, active: filter !== "all" || sort !== "group" || type !== "all", total: all.length };
}
function viewObjects() {
  const q = objectQueue();
  const list = q.list.filter((o) => matches(state.query, o.id, o.name, o.category, o.description));
  const cats = [...new Set(list.map((o) => o.category))].sort();
  const card = (o) => h("a", { class: "card", href: `#/objects/${o.id}` },
    h("div", { class: "thumb checker" }, h("img", { src: assetUrl(o.preview), alt: o.name, loading: "lazy" })),
    h("div", { class: "card-name" }, o.name),
    // The synthesised `still` must not read as an animation here — the
    // list is where you scan for what actually moves.
    h("div", { class: "card-sub" }, o.stillOnly || !Object.keys(o.animations).length
      // Static, but not necessarily one-sided or single-state: say so before
      // you open it. Kept short — this is a card, not a header.
      ? (stillShape(o) ? `static · ${stillShape(o).replace(" directions", " views")}` : "static")
      : Object.keys(o.animations).join(", ")),
    // A stale verdict must not wear the badge of a live one — "remove" on a
    // piece regenerated since that call would read as a decision about the
    // art on screen.
    h("div", { class: "card-badges" }, ...objBadges(o)));
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
      feedbackRow("objects", o.path, { stamp: { art: o.artHash ?? null } })));
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
  const renderFacet = () => {
    const st = player?.getState(), dir = player?.getDir();
    if (!st || !dir) return;
    facetPill.replaceChildren(facetName(st, dir));
    facetBox.replaceChildren(feedbackRow("objects", `${o.path}#${st}#${dir}`, {
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
      reject: "✕ redo",
      rejectTitle: `Reject just this one — ${stateLabel(st)} facing ${dir} — the scenery agent regenerates it, the piece stays`,
      rejectedLabel: "to be redone",
    }));
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
      [q.type === "all" ? null : `${objTypeLabel(q.type)} only`,
        q.filter === "all" ? null : `${OBJ_FILTERS[q.filter].label} only`,
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
        reject: multi ? "✕ unbind all" : "✕ unbind",
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
        reject: "✕ unbind", rejectOnly: true, rejectedLabel: "to be unbound",
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
  return h("div", { class: "panel" },
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
function viewMusic() {
  const list = (state.data.domains.music ?? []).filter((t) => matches(state.query, t.id, t.name, t.use));
  const domainTracks = list.filter((t) => t.source !== "composer");
  const beds = list.filter((t) => t.source === "composer");
  return h("div", {},
    sectionHead("music"),
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
    h("div", { class: "grid" }, ...list.map((it) => {
      const src = itemSources(it);
      return h("a", { class: `card${src.length ? "" : " dim"}`, href: `#/items/${it.id}` },
        h("div", { class: "thumb checker" }, itemSprite(it, 96)),
        itemChip(it),
        h("div", { class: "card-name" }, it.name),
        goldTag(it) ? h("div", { class: "card-sub" }, goldTag(it)) : null,
        // Nothing at all when nothing drops it — silence reads better
        // than "not dropped yet" (maintainer 2026-07-31).
        src.length
          ? h("div", { class: "card-sub" }, `Dropped by ${src.length} ${src.length === 1 ? "creature" : "creatures"}`)
          : null,
        h("div", { class: "card-badges" }, ...entityBadge("items", it.path)));
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

/* ---------------------------------------------------------------- router */
function route() {
  destroyPlayers();
  stopAllAudio();   // both players: a long audition used to survive the nav
  const hash = location.hash.replace(/^#\/?/, "");
  const [page, id, sub] = hash.split("/").map(decodeURIComponent);
  let view;
  if (state.query && !id) view = viewSearch();
  else if (page === "monsters") view = id ? viewMonster(id) : viewMonsters();
  else if (page === "characters") view = id ? viewCharacter(id) : viewCharacters();
  else if (page === "tiles") view = id ? (sub ? viewTileInstance(id, sub) : viewTileType(id)) : viewTiles();
  else if (page === "world") view = id ? (sub ? viewWorldPair(id, sub) : viewWorldType(id)) : viewWorld();
  else if (page === "objects") view = id ? viewObject(id) : viewObjects();
  else if (page === "sounds") view = viewSounds();
  else if (page === "music") view = viewMusic();
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
  const [monTune, constTune, sfxReq, shadowNotes, tileWalls, ...fbs] = apiState
    ? [fromApi((s) => s.tuning.monsters), fromApi((s) => s.tuning.constants), fromApi((s) => s.tuning.sfx_requests),
       fromApi((s) => s.tuning.shadow_notes), fromApi((s) => s.tuning.tile_walls),
       ...FEEDBACK_DOMAINS.map((d) => fromApi((s) => s.feedback[d]))]
    : await Promise.all([
        fetchJson(new URL("live/tuning/monsters.json", ROOT)),
        fetchJson(new URL("live/tuning/constants.json", ROOT)),
        fetchJson(new URL("live/tuning/sfx_requests.json", ROOT)),
        fetchJson(new URL("live/tuning/shadow_notes.json", ROOT)),
        fetchJson(new URL("live/tuning/tile_walls.json", ROOT)),
        ...FEEDBACK_DOMAINS.map((d) => fetchJson(new URL(`live/feedback/${d}.json`, ROOT))),
      ]);
  state.tuning.monsters = monTune ?? { format: "pixel-wiki-tuning-monsters@1", updated_at: "", defaults: {}, monsters: {} };
  state.tuning.constants = constTune ?? { format: "pixel-wiki-tuning-constants@1", updated_at: "", overrides: {} };
  state.tuning.sfx_requests = sfxReq ?? { format: "pixel-wiki-sfx-requests@1", updated_at: "", requests: {} };
  state.tuning.shadow_notes = shadowNotes ?? { format: "pixel-wiki-shadow-notes@1", updated_at: "", overrides: {} };
  state.tuning.tile_walls = tileWalls ?? { format: "pixel-wiki-tile-walls@1", updated_at: "", overrides: {} };
  FEEDBACK_DOMAINS.forEach((d, i) => {
    state.feedback[d] = fbs[i] ?? { format: "pixel-wiki-feedback@1", domain: d, updated_at: "", entries: {} };
  });
}
function buildKnownIds() {
  const d = state.data.domains;
  const add = (id) => state.knownIds.add(id);
  d.monsters.forEach((m) => add(m.path));
  d.characters.forEach((c) => add(c.path));
  d.objects.forEach((o) => add(o.path));
  d.music.forEach((t) => { add(t.path); add(`${t.path}/${t.id}`); });
  d.items.forEach((it) => add(it.path));
  (d.lore ?? []).forEach((e) => add(e.path));   // else a rejected chapter reads as "resolved"
  d.tiles.forEach((t) => { add(t.path); t.groups.forEach((g) => g.tiles.forEach((f) => add(stripExt(`${g.dir}/${f}`)))); });
  d.sounds.forEach((s) => { add(s.path); s.takes.forEach((t) => add(`${s.path}/${t.id}`)); });
  // Composer foley recordings (feedback domain "composer") — ids are file
  // paths, and the generation pool is as rateable as the chosen take.
  Object.values(state.data.sfx?.composerSets ?? {}).forEach((cs) =>
    [...cs.takes, ...(cs.alts ?? [])].forEach((t) => add(t.file.replace(/\.\w+$/, ""))));
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
    if (e.origin === location.origin && e.data?.type === "wiki:closeMenu") setMenu(false);
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
  repoBase = stagingBase(await stagingSha());
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
    ...(data.git_sha ? [h("div", { class: "stamp-sha" }, data.git_sha)] : []));
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
    state.data = full;
    // The World pairs are read LIVE from the tiles agent and are newer than
    // ANY build, including this one — so the swap must not throw them away.
    // (Caught by check-world: after the upgrade the section fell back to the
    // build's ground types and lost the one the agent had just generated.)
    if (worldLive) { state.data.domains.world = worldLive; syncCounts("world"); }
    pruneKnownGone();
    buildKnownIds();
    drawStamp(full);
    keepScrollY = window.scrollY;
    route();
  } finally { stagingPending = false; }
}

(async function boot() {
  initChrome();
  // Everything the first paint needs, in parallel — the live files do not
  // depend on the manifest, so they no longer wait for it.
  const [data, admin] = await Promise.all([
    fetchJson(new URL("data.json", location.href)),
    checkAdmin(),
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
  buildKnownIds();
  drawStamp(data);
  route();
  // …and only now, with the wiki on screen and usable, fetch the repo's copy.
  if (admin) upgradeToStaging();
  // Headless QA hook (mirrors the games2 __ml convention).
  window.__wiki = {
    state, route,
    counts: () => state.data.counts,
    fb, setFb,
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
