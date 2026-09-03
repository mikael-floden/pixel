// live.ts — the game's LIVE-UPDATE channel + the wiki's admin API.
//
// The top-level /live folder on GitHub main is runtime state (tuning the game
// reads, feedback the art agents read — see live/README.md). This module:
//
//   - loads live/** at boot: GitHub raw first (the committed truth), the copy
//     baked into the image (ASSETS_ROOT/live) as offline fallback;
//   - GET  /api/live/state    — current state (the wiki + game clients read it);
//   - POST /api/live/refresh  — re-fetch from GitHub and broadcast the diff.
//     Fired by .github/workflows/live-notify.yml on every push touching
//     live/** — PUSH-based updates, no polling. Unauthenticated but harmless
//     (it only re-reads public data) and rate-limited;
//   - POST /api/wiki/login    — admin login. The password is checked against a
//     HARDCODED SHA-256 (the repo is public: a plaintext password in source
//     would be world-readable). The session is a SIGNED bearer token that
//     carries its own expiry — no server-side session table, so a deploy
//     cannot sign the Game Master out;
//   - GET  /api/wiki/me       — is this session an admin?
//   - POST /api/wiki/save     — admin-only, per-entry delta. The server merges
//     it into the current doc, COMMITS to GitHub with ITS OWN token
//     (WIKI_GITHUB_TOKEN env — set on the Cloud Run service, never shipped to
//     any client), then applies in memory and notifies the rooms.
//
// WorldRoom subscribes via onLiveChange() and broadcasts "live:update" over
// the existing Colyseus WebSocket — that's how every connected client gets
// new tuning within seconds of a save, with zero polling.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import type express from "express";

const REPO = process.env.WIKI_REPO || "mikael-floden/pixel";
const BRANCH = process.env.WIKI_BRANCH || "main";
// Overridable for tests (point both at a local mock).
const RAW_BASE = process.env.LIVE_RAW_BASE || `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const GH_API = process.env.LIVE_GH_API || "https://api.github.com";
const ghToken = () => process.env.WIKI_GITHUB_TOKEN || "";

// "bindings" is not an art domain: its ids are `<eventId>#<sound>` pairs, and
// a rejected entry means UNBIND that sound from that event — the recording
// itself is untouched (maintainer 2026-08-06). The composer agent consumes it.
// "composer-music" is the MUSIC BENCH's channel (maintainer 2026-08-22): one
// file carrying verdicts at three levels — a whole track, one take of it, and
// one phrase of one take — keyed composer/music/<track>, …__v03 and …__v03#5.
const FEEDBACK_DOMAINS = ["monsters", "characters", "tiles", "objects", "sounds", "music", "items", "lore", "composer", "composer-music", "bindings"] as const;
// repo path (under live/) -> state key
const LIVE_FILES: Record<string, string> = {
  "tuning/monsters.json": "tuning/monsters",
  "tuning/constants.json": "tuning/constants",
  // The Game Master's "add this sound to that event" requests, written by the
  // wiki, consumed by the composer (games-audio) agent. See live/README.md.
  "tuning/sfx_requests.json": "tuning/sfx_requests",
  // WHERE THE GAME MASTER THINKS THE NADIR SHADOW BELONGED. Not a per-monster
  // fix: the games agent reads these as TRAINING DATA for the placement rules
  // it derives from the art (maintainer 2026-08-15: "the game agent will use
  // this data to improve the shadow placement on all further monsters ... it's
  // a way to learn how the shadows should be placed"). One entry per
  // <monster>#<state>#<direction>, each carrying what the wiki drew and what
  // he moved it to. See live/README.md.
  "tuning/shadow_notes.json": "tuning/shadow_notes",
  // WHICH TILES MAY BUILD THEIR OWN WALL. Tiles 3.0 generates a tile as "A
  // over B" — top A, walls B — and most can be stacked to make a cliff out of
  // themselves. Some cannot, and the Game Master marks those TOP TILE ONLY, so
  // whatever stacks under them is the pure "B over B" tile instead. Consumed
  // by the tiles agent and, when 3.0 ships, by whatever paints the ground.
  // See live/README.md.
  "tuning/tile_walls.json": "tuning/tile_walls",
  // WHICH TILES ALWAYS KEEP THEIR OWN TOP. The base-tile-set model swaps an
  // x-over-y tile's top for the ground's configured surface (clean colour or a
  // set member); a tile the Game Master marks own_top is exempt — its art
  // transitions toward the wall in a way a swapped top would destroy, so it
  // always draws the texture it was generated with. Higher priority than the
  // set composition, per the maintainer (2026-08-27). Written by the wiki;
  // consumed by whatever composes ground tops (the wiki today, the game when
  // it adopts the set model). See live/README.md.
  "tuning/tile_tops.json": "tuning/tile_tops",
  // THE GROUND A SCENERY PIECE OCCUPIES: one or more ellipses per piece, in
  // frame pixels from the frame centre — the same units as a monster's nadir
  // shadow. Not a shadow and never drawn; it is the hitbox, and each ellipse's
  // centre line decides whether the player is drawn in front of or behind that
  // part of the piece. Absent = undecided, [] = decided-none (wall-mounted).
  // Written by the wiki's Scenery pages. See live/README.md.
  "tuning/scenery_hitbox.json": "tuning/scenery_hitbox",
  // WHICH x-OVER-x TILE BUILDS THE WALL under a borrowed-wall top. The wiki
  // picks the measured closest match automatically; an entry here is the
  // Game Master's override for one face. Written by the wiki; consumed by
  // whatever composes ground tops. See live/README.md.
  "tuning/top_walls.json": "tuning/top_walls",
  // The Game Master's corrections to WHICH pieces are wall scenery — the
  // agent's type tag is wrong both ways sometimes. Same contract as
  // scenery_lights: wiki writes, the scenery agent re-files and deletes.
  "tuning/scenery_walls.json": "tuning/scenery_walls",
  "tuning/chess.json": "tuning/chess",
  // WHETHER A SCENERY STATE IS REALLY LIT. The generator names a state LIT_* or
  // NOT_LIT_*, but the AI that draws it sometimes fails to put the light in —
  // and the art is otherwise good (maintainer 2026-08-17: "I want a way to
  // change the state from lit to unlit when doing the review. So we don't have
  // to throw away the art just because it's lit state is wrong"). One entry per
  // <piece path>#<state>, correcting the name. Consumed by the scenery agent.
  // See live/README.md.
  "tuning/scenery_lights.json": "tuning/scenery_lights",
  // WHICH TILES ARE A GROUND TYPE'S BASE TILES. A base tile is the one the
  // world agent paints first and repeats forever — "does everything but noone
  // notice" (maintainer 2026-08-21). Promoted and revoked from the wiki's
  // ground-type pages, one entry per tile key carrying the ground type it is
  // the base OF. Consumed by the tiles agent (variant generation budget) and
  // the maps/world agent (what to paint a field with). See live/README.md.
  "tuning/base_tiles.json": "tuning/base_tiles",
  // THE GROUND'S LOOK, per ground type: an ordered list of BASE TILE SETS, each
  // a group of tiles that look good together with a weight apiece, plus a
  // "clean" member for the flat palette colour, and a set-level weight for how
  // likely a region picks that set. Set 0 is reserved for Clean and is switched
  // off by weight rather than deleted, so a ground can always draw.
  //
  // THE BUCKET HERE IS `grounds`, NOT `overrides` — one entry per ground type,
  // so a save is a per-ground delta. Consumed by the game's renderer, the maps
  // agent and the tiles agent; it REPLACES the per-material transition_surface
  // / always_own_texture / flat_top flags. Reference implementation and the
  // deterministic pick in wiki/lib/basesets.mjs. See live/README.md.
  "tuning/base_tile_sets.json": "tuning/base_tile_sets",
  ...Object.fromEntries(FEEDBACK_DOMAINS.map((d) => [`feedback/${d}.json`, `feedback/${d}`])),
};

type Doc = Record<string, unknown> & {
  entries?: Record<string, unknown>;
  monsters?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  grounds?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
};

const emptyDoc = (key: string): Doc => {
  if (key === "tuning/chess") return { format: "nangijala-chess-boards@1", updated_at: "", worlds: {} };
  if (key === "tuning/monsters") return { format: "pixel-wiki-tuning-monsters@1", updated_at: "", defaults: {}, monsters: {} };
  if (key === "tuning/constants") return { format: "pixel-wiki-tuning-constants@1", updated_at: "", overrides: {} };
  if (key === "tuning/sfx_requests") return { format: "pixel-wiki-sfx-requests@1", updated_at: "", requests: {} };
  if (key === "tuning/shadow_notes") return { format: "pixel-wiki-shadow-notes@1", updated_at: "", overrides: {} };
  if (key === "tuning/tile_walls") return { format: "pixel-wiki-tile-walls@1", updated_at: "", overrides: {} };
  if (key === "tuning/tile_tops") return { format: "pixel-wiki-tile-tops@1", updated_at: "", overrides: {} };
  if (key === "tuning/scenery_hitbox") return { format: "pixel-wiki-scenery-hitbox@1", updated_at: "", overrides: {} };
  if (key === "tuning/top_walls") return { format: "pixel-wiki-top-walls@1", updated_at: "", overrides: {} };
  if (key === "tuning/scenery_walls") return { format: "pixel-wiki-scenery-walls@1", updated_at: "", overrides: {} };
  if (key === "tuning/scenery_lights") return { format: "pixel-wiki-scenery-lights@1", updated_at: "", overrides: {} };
  if (key === "tuning/base_tiles") return { format: "pixel-wiki-base-tiles@1", updated_at: "", overrides: {} };
  if (key === "tuning/base_tile_sets") return { format: "pixel-wiki-base-tile-sets@1", updated_at: "", grounds: {} };
  return { format: "pixel-wiki-feedback@1", domain: key.split("/")[1], updated_at: "", entries: {} };
};

const docs = new Map<string, Doc>();
let fetchedAt = "";
// Boot gate: until initLive finishes, /api/live/state and /api/wiki/save
// answer 503 (the wiki then uses its static fallback / retries) — a save
// must never run against an empty store, and an empty state response must
// never masquerade as "no feedback exists".
let ready = false;
const listeners = new Set<(tuning: LiveTuning) => void>();

export type LiveTuning = { monsters: Doc; constants: Doc };
export const liveTuning = (): LiveTuning => ({
  monsters: docs.get("tuning/monsters") ?? emptyDoc("tuning/monsters"),
  constants: docs.get("tuning/constants") ?? emptyDoc("tuning/constants"),
});

/** live/tuning/scenery_hitbox.json `.overrides` — the ground each scenery piece
 *  stands on. Not in the socket payload (1 MB across 3,704 records); the game
 *  reads it as an asset, and the SERVER reads it here for collision. */
export function sceneryHitboxOverrides(): Record<string, any> | null {
  const d = docs.get("tuning/scenery_hitbox") as { overrides?: Record<string, any> } | undefined;
  return d?.overrides ?? null;
}

/** Rooms subscribe here; returns an unsubscribe. */
export function onLiveChange(cb: (tuning: LiveTuning) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function notifyTuning() {
  const t = liveTuning();
  for (const cb of listeners) {
    try { cb(t); } catch (err) { console.error("[live] listener failed:", err); }
  }
}

// ------------------------------------------------------------------ loading
async function fetchRaw(rel: string): Promise<Doc | null> {
  try {
    const res = await fetch(`${RAW_BASE}/live/${rel}`, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Doc;
  } catch {
    return null;
  }
}

function readBaked(assetsRoot: string, rel: string): Doc | null {
  try {
    return JSON.parse(readFileSync(join(assetsRoot, "live", rel), "utf8")) as Doc;
  } catch {
    return null;
  }
}

/** Boot load: GitHub main first, baked copy as fallback, empty as last resort. */
export async function initLive(assetsRoot: string): Promise<void> {
  let fromRaw = 0;
  await Promise.all(Object.entries(LIVE_FILES).map(async ([rel, key]) => {
    const raw = await fetchRaw(rel);
    if (raw) fromRaw++;
    const doc = raw ?? readBaked(assetsRoot, rel) ?? emptyDoc(key);
    docs.set(key, doc);
  }));
  fetchedAt = new Date().toISOString();
  ready = true;
  // Rooms created (and clients joined) during the boot fetch got empty
  // tuning — push the real state now that it exists.
  notifyTuning();
  console.log(`[live] loaded ${docs.size} live files, ${fromRaw} from GitHub (repo=${REPO}@${BRANCH})`);
  // If GitHub was unreachable we booted on the image-baked copy, which can
  // be arbitrarily old (live/** pushes never rebuild the image). Keep
  // retrying until a real refresh lands so the stale window is bounded.
  if (fromRaw < Object.keys(LIVE_FILES).length) {
    const retry = setInterval(() => {
      void refreshLive().then(() => {
        if (lastRefreshHadRaw) clearInterval(retry);
      });
    }, 60_000);
    retry.unref?.();
  }
}

// Refresh: re-fetch, apply changed files, notify rooms if tuning moved.
// Coalesced + rate-limited: bursts of pushes trigger one trailing refresh.
// Uses the contents API when a token is configured (strongly consistent —
// raw.githubusercontent.com sits behind a ~5-min CDN whose staleness could
// otherwise REVERT a just-saved admin edit); anonymous raw is the fallback.
let refreshing = false;
let refreshQueued = false;
let lastRefresh = 0;
let lastRefreshHadRaw = false;
const REFRESH_MIN_MS = Number(process.env.LIVE_REFRESH_MIN_MS ?? 5000);

async function fetchCurrent(rel: string): Promise<Doc | null> {
  if (ghToken()) {
    try {
      const { doc } = await ghGetContents(rel);
      if (doc) return doc;
    } catch { /* fall through to raw */ }
  }
  return fetchRaw(rel);
}

// Adopt a fetched doc only if it isn't OLDER than what we hold — every writer
// (this server, the wiki-era files, the agents' contract) stamps updated_at,
// and a CDN-stale raw response must never roll back a newer save.
function isNewer(doc: Doc, cur: Doc | undefined): boolean {
  if (!cur) return true;
  if (JSON.stringify(doc) === JSON.stringify(cur)) return false;
  const a = Date.parse(String(doc.updated_at ?? ""));
  const b = Date.parse(String(cur.updated_at ?? ""));
  if (Number.isFinite(a) && Number.isFinite(b)) return a >= b;
  return true; // timestamps unusable → different content wins (old behavior)
}

export async function refreshLive(): Promise<void> {
  if (refreshing) { refreshQueued = true; return; }
  refreshing = true;
  try {
    const wait = lastRefresh + REFRESH_MIN_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRefresh = Date.now();
    let tuningChanged = false;
    let sawAny = false;
    await Promise.all(Object.entries(LIVE_FILES).map(async ([rel, key]) => {
      const doc = await fetchCurrent(rel);
      if (!doc) return; // unreachable/missing → keep what we have
      sawAny = true;
      if (isNewer(doc, docs.get(key))) {
        docs.set(key, doc);
        if (key.startsWith("tuning/")) tuningChanged = true;
      }
    }));
    lastRefreshHadRaw = sawAny;
    fetchedAt = new Date().toISOString();
    if (tuningChanged) notifyTuning();
  } finally {
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; void refreshLive(); }
  }
}

// -------------------------------------------------------------- admin auth
// Only the SHA-256 of the admin password lives in source (public repo). The
// hash of a ~96-char random password is not invertible or brute-forceable.
const ADMIN_USER = "admin";
const ADMIN_PASS_SHA256 = "e04e6d2d09449022fb91188631b91f30a7fd058b9c5a41f53e88805edb267f37";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

// A SIGNED, STATELESS session: `<expiry-epoch-seconds>.<hmac>`.
//
// It used to be a random token in a `Map` — which dies with the process, and
// this service redeploys many times a day (every art push deploys), so the
// Game Master was silently signed out several times a day and blamed the
// 7-day TTL that was never the problem (maintainer 2026-08-06: "If I have
// logged in I should stay logged in for a week"). A signed token carries its
// own expiry, so it survives restarts, rolling deploys AND a scale-out to
// several instances (where a map on instance A 401s every request that lands
// on instance B).
let sessionKeyCache: Buffer | null = null;
function sessionKey(): Buffer {
  if (sessionKeyCache) return sessionKeyCache;
  // A stable server-side secret, in preference order. WIKI_GITHUB_TOKEN is the
  // honest default: an admin session is worthless without it (saves commit
  // with it), it is never in the repo or shipped to a client, and it outlives
  // restarts. Rotating it invalidates every session — the revocation lever a
  // stateless scheme otherwise lacks. With neither set (dev, tests) the key is
  // per-process random, i.e. exactly the old behaviour.
  const base = process.env.WIKI_SESSION_SECRET || ghToken();
  if (!base) console.warn("[live] no WIKI_SESSION_SECRET/WIKI_GITHUB_TOKEN — admin sessions will not survive a restart");
  sessionKeyCache = base
    ? createHash("sha256").update(`wiki-session|${base}`, "utf8").digest()
    : randomBytes(32);
  return sessionKeyCache;
}
function signSession(expiresAtMs: number): string {
  const exp = String(Math.floor(expiresAtMs / 1000));
  return `${exp}.${createHmac("sha256", sessionKey()).update(exp).digest("hex")}`;
}

function checkPassword(user: unknown, pass: unknown): boolean {
  if (user !== ADMIN_USER || typeof pass !== "string") return false;
  const got = createHash("sha256").update(pass, "utf8").digest();
  const want = Buffer.from(ADMIN_PASS_SHA256, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

function isAdmin(req: express.Request): boolean {
  const m = /^Bearer\s+(\d{10,12})\.([a-f0-9]{64})$/.exec(String(req.headers.authorization ?? ""));
  if (!m) return false;
  if (Number(m[1]) * 1000 <= Date.now()) return false;          // expired
  const want = createHmac("sha256", sessionKey()).update(m[1]).digest();
  const got = Buffer.from(m[2], "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

// ------------------------------------------------------- GitHub commit path
// Saves are serialized through one promise chain, and each save merges its
// delta onto the file's CURRENT committed content (contents API = strongly
// consistent), NOT onto server memory: memory can lag an agent's push by the
// notify/refresh latency, and a whole-file PUT from a stale base would
// silently revert the agent's commit. The blob sha from the same GET makes
// the PUT conditional — a mid-flight racing commit 409s and we re-merge.
let commitChain: Promise<void> = Promise.resolve();
/** Client perf telemetry: how many reports live/telemetry/perf.json keeps, and
 *  the floor between commits. One player on a phone, so this is about not
 *  writing a commit per frame, not about contention. */
const PERF_KEEP = 40;
const PERF_MIN_GAP_MS = 20_000;
let lastPerfCommit = 0;

function ghHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${ghToken()}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "nangijala-wiki",
  };
}

/* A FILE THAT EXISTS IS NEVER READ AS EMPTY (2026-09-02, 6,890 of the Game
 * Master's tile verdicts erased in one save). GitHub's contents API returns
 * the blob sha but NO content for a file over 1 MB — live/feedback/tiles.json
 * had grown to 1,058,285 bytes — and this function turned that into
 * `doc: null`, which ghCommitDelta then treated as "no file yet": it merged a
 * 53-entry delta onto an EMPTY document and PUT it with the valid sha.
 * GitHub accepted. Nothing errored. Now: no content + a sha means "too big
 * for this endpoint", so the blob is fetched through the git data API (base64
 * up to 100 MB); if that fails too the save FAILS LOUDLY. `doc: null` is
 * reserved for a true 404. */
async function ghGetContents(rel: string): Promise<{ doc: Doc | null; sha?: string }> {
  const url = `${GH_API}/repos/${REPO}/contents/live/${rel}?ref=${BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return { doc: null, sha: undefined };
  if (!res.ok) throw new Error(`GitHub GET live/${rel}: HTTP ${res.status}`);
  const j = (await res.json()) as { sha?: string; content?: string; size?: number };
  let text = Buffer.from((j.content ?? "").replace(/\n/g, ""), "base64").toString("utf8");
  if (!text.trim() && j.sha) {
    // Over the contents-API size limit: the blob endpoint serves any size.
    const bres = await fetch(`${GH_API}/repos/${REPO}/git/blobs/${j.sha}`, { headers: ghHeaders(), signal: AbortSignal.timeout(15000) });
    if (!bres.ok) throw new Error(`GitHub GET blob for live/${rel}: HTTP ${bres.status} (file is ${j.size ?? "?"} bytes — over the contents-API limit, and the blob fetch failed; refusing to save rather than start from empty)`);
    const b = (await bres.json()) as { content?: string };
    text = Buffer.from((b.content ?? "").replace(/\n/g, ""), "base64").toString("utf8");
  }
  try {
    return { doc: JSON.parse(text) as Doc, sha: j.sha };
  } catch {
    if (j.sha) throw new Error(`GitHub GET live/${rel}: the file exists (${j.size ?? "?"} bytes) but could not be read as JSON — refusing to save rather than start from empty`);
    return { doc: null, sha: j.sha };
  }
}

/** Merge the delta onto GitHub HEAD and commit; returns the merged doc. */
async function ghCommitDelta(rel: string, key: string, delta: Record<string, unknown>): Promise<Doc> {
  if (!ghToken()) throw Object.assign(new Error("WIKI_GITHUB_TOKEN is not configured on the server"), { status: 503 });
  const url = `${GH_API}/repos/${REPO}/contents/live/${rel}`;
  for (let attempt = 0; ; attempt++) {
    const { doc: base, sha } = await ghGetContents(rel);
    // Belt and braces for the wipe above: an existing file with no readable
    // base is a bug, never a fresh start; and a merge can only shrink a bucket
    // by the nulls the delta actually carries.
    if (sha && !base) throw Object.assign(new Error(`live/${rel} exists on GitHub but no base could be read — refusing to overwrite it`), { status: 502 });
    const merged = applyDelta(key, base ?? emptyDoc(key), delta);
    const bucketOf = (d: Doc | null) => {
      const b = key.startsWith("feedback/") ? d?.entries : key === "tuning/monsters" ? d?.monsters : key === "tuning/sfx_requests" ? (d as Record<string, unknown> | null)?.requests : key === "tuning/base_tile_sets" ? d?.grounds : d?.overrides;
      return b && typeof b === "object" ? Object.keys(b as object).length : 0;
    };
    const nulls = Object.values(delta).filter((v) => v === null || v === undefined).length;
    if (base && bucketOf(merged) < bucketOf(base) - nulls) {
      throw Object.assign(new Error(`live/${rel}: merge would drop ${bucketOf(base) - bucketOf(merged)} entries but the delta only deletes ${nulls} — refusing`), { status: 502 });
    }
    const body: Record<string, unknown> = {
      message: `live: admin update — ${rel}`,
      content: Buffer.from(JSON.stringify(merged, null, 2) + "\n", "utf8").toString("base64"),
      branch: BRANCH,
    };
    if (sha) body.sha = sha;
    const res = await fetch(url, { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (res.ok) return merged;
    // 409/422 = someone committed between our GET and PUT — re-merge on top.
    if ((res.status === 409 || res.status === 422) && attempt < 2) continue;
    throw new Error(`GitHub PUT live/${rel}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

// Apply a per-entry delta {id: value|null} to a COPY of the given doc.
function applyDelta(key: string, cur: Doc, delta: Record<string, unknown>): Doc {
  const next: Doc = JSON.parse(JSON.stringify(cur));
  const bucket = key.startsWith("feedback/") ? "entries"
    : key === "tuning/monsters" ? "monsters"
    : key === "tuning/sfx_requests" ? "requests"
    // Base tile sets are keyed by GROUND, not by tile: the whole point of the
    // model is that a set can exist with no tiles in it (Clean #0), which a
    // tile-keyed bucket cannot represent.
    : key === "tuning/base_tile_sets" ? "grounds"
    : "overrides";
  const map = (next[bucket] ?? {}) as Record<string, unknown>;
  for (const [id, value] of Object.entries(delta)) {
    if (id === "__proto__" || id === "constructor" || id === "prototype") continue;
    if (value === null || value === undefined) delete map[id];
    else map[id] = value;
  }
  next[bucket] = map;
  next.updated_at = new Date().toISOString();
  return next;
}

// ------------------------------------------------------------------ routes
export function registerLiveRoutes(app: express.Application): void {
  app.get("/api/live/state", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!ready) {
      // Booting: an empty 200 would masquerade as "no feedback exists" —
      // tell callers to fall back / retry instead.
      res.status(503).json({ error: "live store is still loading" });
      return;
    }
    res.json({
      fetched_at: fetchedAt,
      tuning: {
        monsters: docs.get("tuning/monsters"), constants: docs.get("tuning/constants"),
        sfx_requests: docs.get("tuning/sfx_requests"), shadow_notes: docs.get("tuning/shadow_notes"), tile_walls: docs.get("tuning/tile_walls"), chess: docs.get("tuning/chess"),
        scenery_lights: docs.get("tuning/scenery_lights"),
        base_tiles: docs.get("tuning/base_tiles"),
        tile_tops: docs.get("tuning/tile_tops"),
        scenery_hitbox: docs.get("tuning/scenery_hitbox"),
        top_walls: docs.get("tuning/top_walls"),
        scenery_walls: docs.get("tuning/scenery_walls"),
        base_tile_sets: docs.get("tuning/base_tile_sets"),
      },
      feedback: Object.fromEntries(FEEDBACK_DOMAINS.map((d) => [d, docs.get(`feedback/${d}`)])),
    });
  });

  /* CLIENT PERFORMANCE TELEMETRY — the maintainer's own device, measured.
   *
   * His phone is the only machine that reproduces the lag and the render
   * artefacts; the headless harness runs software GL at 1-3 fps and WALKS AT
   * ABOUT ONE CELL PER 24 SECONDS, so the code paths that only fire on fresh
   * terrain (the cell repaint, first-sight composition) never execute there and
   * every "cannot reproduce" from it was a test of code that never ran. His
   * idea (2026-09-03): let the CLIENT measure and commit the numbers to live/,
   * which agents already read straight from GitHub.
   *
   * OPT-IN and rate-limited: the client only posts with ?perf=1, at most one
   * report per PERF_MIN_GAP_MS, and the file keeps the last PERF_KEEP reports.
   * The payload is clamped here rather than trusted — it arrives from a browser
   * and lands in a committed file. No identity is stored beyond a random
   * per-session id the client makes up. */
  app.post("/api/perf", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!ghToken()) { res.status(503).json({ error: "no token" }); return; }
    const now = Date.now();
    if (now - lastPerfCommit < PERF_MIN_GAP_MS) { res.status(429).json({ error: "too soon" }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const num = (v: unknown, lo: number, hi: number) =>
      typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v * 100) / 100)) : null;
    const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
    const flat = (v: unknown, keys: number, hi: number) => {
      if (!v || typeof v !== "object") return null;
      const out: Record<string, number> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, keys)) {
        const n = num(val, 0, hi);
        if (n !== null) out[k.slice(0, 40)] = n;
      }
      return out;
    };
    const report = {
      at: new Date(now).toISOString(),
      build: str(body.build, 40),
      where: str(body.where, 60),
      tod: str(body.tod, 16),
      zoom: num(body.zoom, 0, 16),
      dpr: num(body.dpr, 0, 8),
      view: str(body.view, 24),
      secs: num(body.secs, 0, 3600),
      frames: flat(body.frames, 12, 100000),
      sections: flat(body.sections, 40, 100000),
      counts: flat(body.counts, 40, 1e9),
      // The ground-texture sample: where the dark texels sit on the tile
      // lattice, measured on HIS device because the harness never reproduces it.
      ground: body.ground && typeof body.ground === "object"
        ? Object.fromEntries(
            Object.entries(body.ground as Record<string, unknown>).slice(0, 16).map(([k, v]) => [
              k.slice(0, 24),
              typeof v === "number" ? v : Array.isArray(v) ? v.slice(0, 12).map((x) => String(x).slice(0, 24)) : String(v).slice(0, 48),
            ]),
          )
        : null,
      worst: Array.isArray(body.worst)
        ? (body.worst as unknown[]).slice(0, 8).map((w) => str(JSON.stringify(w), 400))
        : null,
    };
    if (report.frames === null && report.sections === null) { res.status(400).json({ error: "empty report" }); return; }
    lastPerfCommit = now;
    const id = `${report.at.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    const run = async () => {
      const url = `${GH_API}/repos/${REPO}/contents/live/telemetry/perf.json`;
      for (let attempt = 0; ; attempt++) {
        const got = await fetch(`${url}?ref=${BRANCH}`, { headers: ghHeaders(), signal: AbortSignal.timeout(15000) });
        let cur: { reports?: unknown[] } = {};
        let sha: string | undefined;
        if (got.ok) {
          const j = (await got.json()) as { content?: string; sha?: string };
          sha = j.sha;
          try { cur = JSON.parse(Buffer.from(j.content ?? "", "base64").toString("utf8")); } catch { cur = {}; }
        } else if (got.status !== 404) {
          throw new Error(`GET perf.json: HTTP ${got.status}`);
        }
        const reports = Array.isArray(cur.reports) ? cur.reports : [];
        reports.push({ id, ...report });
        const doc = {
          format: "nangijala-client-perf@1",
          _comment:
            "PER-DEVICE FRAME TIMINGS, posted by the game client with ?perf=1 and committed here " +
            "by the server. The maintainer plays on a phone and tests in production; the headless " +
            "harness walks ~1 cell per 24 s and never reaches the fresh-terrain code paths, so these " +
            "are the only honest numbers for the paths that matter. Newest last; the file keeps the " +
            "most recent reports only.",
          updated_at: new Date(now).toISOString(),
          reports: reports.slice(-PERF_KEEP),
        };
        const body2: Record<string, unknown> = {
          message: "live: client perf report",
          content: Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8").toString("base64"),
          branch: BRANCH,
        };
        if (sha) body2.sha = sha;
        const put = await fetch(url, { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body2), signal: AbortSignal.timeout(15000) });
        if (put.ok) return;
        if ((put.status === 409 || put.status === 422) && attempt < 2) continue;
        throw new Error(`PUT perf.json: HTTP ${put.status}`);
      }
    };
    const job = commitChain.then(run, run);
    commitChain = job.then(() => undefined, () => undefined);
    try { await job; res.json({ ok: true, id }); }
    catch (e) { res.status(502).json({ error: String((e as Error).message).slice(0, 200) }); }
  });

  app.post("/api/live/refresh", (_req, res) => {
    void refreshLive();
    res.status(202).json({ ok: true });
  });

  app.post("/api/wiki/login", async (req, res) => {
    // A fixed small delay keeps even a naive brute force below ~4 guesses/s.
    await new Promise((r) => setTimeout(r, 250));
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    if (!checkPassword(username, password)) {
      res.status(401).json({ error: "wrong username or password" });
      return;
    }
    res.json({ token: signSession(Date.now() + SESSION_TTL_MS), expires_in_s: SESSION_TTL_MS / 1000 });
  });

  app.get("/api/wiki/me", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ admin: isAdmin(req) });
  });

  app.post("/api/wiki/save", (req, res) => {
    if (!isAdmin(req)) {
      res.status(401).json({ error: "admin login required" });
      return;
    }
    const { file, set } = (req.body ?? {}) as { file?: string; set?: Record<string, unknown> };
    if (!file || !(file in Object.fromEntries(Object.entries(LIVE_FILES).map(([r, k]) => [k, r]))) ||
        !set || typeof set !== "object" || Array.isArray(set)) {
      res.status(400).json({ error: "body must be {file: <live key>, set: {id: value|null}}" });
      return;
    }
    if (!ready) {
      res.status(503).json({ error: "live store is still loading — retry in a moment" });
      return;
    }
    const rel = Object.entries(LIVE_FILES).find(([, k]) => k === file)![0];
    const run = async () => {
      // Merge onto GitHub HEAD (not memory) and commit; adopt what landed.
      const merged = await ghCommitDelta(rel, file, set);
      docs.set(file, merged);
      fetchedAt = new Date().toISOString();
      if (file.startsWith("tuning/")) notifyTuning();
    };
    const job = commitChain.then(run, run);
    commitChain = job.then(() => undefined, () => undefined);
    job.then(
      () => res.json({ ok: true }),
      (err: Error & { status?: number }) => {
        console.error("[live] save failed:", err.message);
        res.status(err.status ?? 502).json({ error: err.message });
      },
    );
  });
}

/** Test hook: reset in-memory state. */
export function _resetLiveForTests(): void {
  docs.clear();
  sessionKeyCache = null;      // re-derived; a configured secret survives, a random one does not
  fetchedAt = "";
  lastRefresh = 0;
  ready = false;
}
