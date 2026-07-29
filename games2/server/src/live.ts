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
//     would be world-readable). Sessions are random bearer tokens in memory;
//   - GET  /api/wiki/me       — is this session an admin?
//   - POST /api/wiki/save     — admin-only, per-entry delta. The server merges
//     it into the current doc, COMMITS to GitHub with ITS OWN token
//     (WIKI_GITHUB_TOKEN env — set on the Cloud Run service, never shipped to
//     any client), then applies in memory and notifies the rooms.
//
// WorldRoom subscribes via onLiveChange() and broadcasts "live:update" over
// the existing Colyseus WebSocket — that's how every connected client gets
// new tuning within seconds of a save, with zero polling.

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import type express from "express";

const REPO = process.env.WIKI_REPO || "mikael-floden/pixel";
const BRANCH = process.env.WIKI_BRANCH || "main";
// Overridable for tests (point both at a local mock).
const RAW_BASE = process.env.LIVE_RAW_BASE || `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const GH_API = process.env.LIVE_GH_API || "https://api.github.com";
const ghToken = () => process.env.WIKI_GITHUB_TOKEN || "";

const FEEDBACK_DOMAINS = ["monsters", "characters", "tiles", "objects", "sounds", "music", "items"] as const;
// repo path (under live/) -> state key
const LIVE_FILES: Record<string, string> = {
  "tuning/monsters.json": "tuning/monsters",
  "tuning/constants.json": "tuning/constants",
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
  return { format: "pixel-wiki-feedback@1", domain: key.split("/")[1], updated_at: "", entries: {} };
};

const docs = new Map<string, Doc>();
let fetchedAt = "";
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
  await Promise.all(Object.entries(LIVE_FILES).map(async ([rel, key]) => {
    const doc = (await fetchRaw(rel)) ?? readBaked(assetsRoot, rel) ?? emptyDoc(key);
    docs.set(key, doc);
  }));
  fetchedAt = new Date().toISOString();
  console.log(`[live] loaded ${docs.size} live files (repo=${REPO}@${BRANCH})`);
}

// Refresh: re-fetch raw, apply changed files, notify rooms if tuning moved.
// Coalesced + rate-limited: bursts of pushes trigger one trailing refresh.
let refreshing = false;
let refreshQueued = false;
let lastRefresh = 0;
const REFRESH_MIN_MS = Number(process.env.LIVE_REFRESH_MIN_MS ?? 5000);

export async function refreshLive(): Promise<void> {
  if (refreshing) { refreshQueued = true; return; }
  refreshing = true;
  try {
    const wait = lastRefresh + REFRESH_MIN_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRefresh = Date.now();
    let tuningChanged = false;
    await Promise.all(Object.entries(LIVE_FILES).map(async ([rel, key]) => {
      const doc = await fetchRaw(rel);
      if (!doc) return; // unreachable/missing → keep what we have
      if (JSON.stringify(doc) !== JSON.stringify(docs.get(key))) {
        docs.set(key, doc);
        if (key.startsWith("tuning/")) tuningChanged = true;
      }
    }));
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
const sessions = new Map<string, number>(); // token -> expiry epoch ms

function checkPassword(user: unknown, pass: unknown): boolean {
  if (user !== ADMIN_USER || typeof pass !== "string") return false;
  const got = createHash("sha256").update(pass, "utf8").digest();
  const want = Buffer.from(ADMIN_PASS_SHA256, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

function isAdmin(req: express.Request): boolean {
  const m = /^Bearer\s+([a-f0-9]{48})$/.exec(String(req.headers.authorization ?? ""));
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(m[1]); return false; }
  return true;
}

// ------------------------------------------------------- GitHub commit path
// Saves are serialized through one promise chain: the contents API needs the
// current blob sha per file, and two racing PUTs would 409.
let commitChain: Promise<void> = Promise.resolve();

async function ghCommitFile(rel: string, doc: Doc): Promise<void> {
  const token = ghToken();
  if (!token) throw Object.assign(new Error("WIKI_GITHUB_TOKEN is not configured on the server"), { status: 503 });
  const url = `${GH_API}/repos/${REPO}/contents/live/${rel}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "nangijala-wiki",
  };
  let sha: string | undefined;
  const cur = await fetch(`${url}?ref=${BRANCH}`, { headers, signal: AbortSignal.timeout(10000) });
  if (cur.ok) sha = ((await cur.json()) as { sha?: string }).sha;
  else if (cur.status !== 404) throw new Error(`GitHub GET live/${rel}: HTTP ${cur.status}`);
  const body: Record<string, unknown> = {
    message: `live: admin update — ${rel}`,
    content: Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8").toString("base64"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`GitHub PUT live/${rel}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// Apply a per-entry delta {id: value|null} to a COPY of the current doc.
function applyDelta(key: string, delta: Record<string, unknown>): Doc {
  const cur = docs.get(key) ?? emptyDoc(key);
  const next: Doc = JSON.parse(JSON.stringify(cur));
  const bucket = key.startsWith("feedback/") ? "entries" : key === "tuning/monsters" ? "monsters" : "overrides";
  const map = (next[bucket] ?? {}) as Record<string, unknown>;
  for (const [id, value] of Object.entries(delta)) {
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
    res.json({
      fetched_at: fetchedAt,
      tuning: { monsters: docs.get("tuning/monsters"), constants: docs.get("tuning/constants") },
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
    const token = randomBytes(24).toString("hex");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    res.json({ token, expires_in_s: SESSION_TTL_MS / 1000 });
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
    const rel = Object.entries(LIVE_FILES).find(([, k]) => k === file)![0];
    const run = async () => {
      const next = applyDelta(file, set);
      await ghCommitFile(rel, next); // GitHub is the truth — commit FIRST
      docs.set(file, next);          // then adopt + push to clients
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
  sessions.clear();
  fetchedAt = "";
  lastRefresh = 0;
}
