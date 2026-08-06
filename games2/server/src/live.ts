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
const FEEDBACK_DOMAINS = ["monsters", "characters", "tiles", "objects", "sounds", "music", "items", "lore", "composer", "bindings"] as const;
// repo path (under live/) -> state key
const LIVE_FILES: Record<string, string> = {
  "tuning/monsters.json": "tuning/monsters",
  "tuning/constants.json": "tuning/constants",
  // The Game Master's "add this sound to that event" requests, written by the
  // wiki, consumed by the composer (games-audio) agent. See live/README.md.
  "tuning/sfx_requests.json": "tuning/sfx_requests",
  ...Object.fromEntries(FEEDBACK_DOMAINS.map((d) => [`feedback/${d}.json`, `feedback/${d}`])),
};

type Doc = Record<string, unknown> & {
  entries?: Record<string, unknown>;
  monsters?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
};

const emptyDoc = (key: string): Doc => {
  if (key === "tuning/monsters") return { format: "pixel-wiki-tuning-monsters@1", updated_at: "", defaults: {}, monsters: {} };
  if (key === "tuning/constants") return { format: "pixel-wiki-tuning-constants@1", updated_at: "", overrides: {} };
  if (key === "tuning/sfx_requests") return { format: "pixel-wiki-sfx-requests@1", updated_at: "", requests: {} };
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

function ghHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${ghToken()}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "nangijala-wiki",
  };
}

async function ghGetContents(rel: string): Promise<{ doc: Doc | null; sha?: string }> {
  const url = `${GH_API}/repos/${REPO}/contents/live/${rel}?ref=${BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return { doc: null, sha: undefined };
  if (!res.ok) throw new Error(`GitHub GET live/${rel}: HTTP ${res.status}`);
  const j = (await res.json()) as { sha?: string; content?: string };
  try {
    return { doc: JSON.parse(Buffer.from((j.content ?? "").replace(/\n/g, ""), "base64").toString("utf8")) as Doc, sha: j.sha };
  } catch {
    return { doc: null, sha: j.sha };
  }
}

/** Merge the delta onto GitHub HEAD and commit; returns the merged doc. */
async function ghCommitDelta(rel: string, key: string, delta: Record<string, unknown>): Promise<Doc> {
  if (!ghToken()) throw Object.assign(new Error("WIKI_GITHUB_TOKEN is not configured on the server"), { status: 503 });
  const url = `${GH_API}/repos/${REPO}/contents/live/${rel}`;
  for (let attempt = 0; ; attempt++) {
    const { doc: base, sha } = await ghGetContents(rel);
    const merged = applyDelta(key, base ?? emptyDoc(key), delta);
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
      tuning: { monsters: docs.get("tuning/monsters"), constants: docs.get("tuning/constants"), sfx_requests: docs.get("tuning/sfx_requests") },
      feedback: Object.fromEntries(FEEDBACK_DOMAINS.map((d) => [d, docs.get(`feedback/${d}`)])),
    });
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
