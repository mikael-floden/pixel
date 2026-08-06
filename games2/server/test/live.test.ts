// The live-update channel + wiki admin API (src/live.ts): login gate,
// per-entry save → GitHub commit → in-memory adoption → room notification,
// and the push-based refresh path — all against a local mock GitHub.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { createHash, createHmac } from "crypto";
import express from "express";

// Mock GitHub (raw + contents API) — must be up BEFORE live.ts reads env.
const ghFiles = new Map<string, string>(); // "live/tuning/monsters.json" -> body
let ghPuts = 0;
const mock = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  // raw.githubusercontent.com style: /live/<rel>
  if (req.method === "GET" && url.pathname.startsWith("/live/")) {
    const body = ghFiles.get(url.pathname.slice(1));
    if (!body) { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(body);
    return;
  }
  // contents API: /repos/<repo>/contents/<path>
  const m = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(url.pathname);
  if (m) {
    const path = decodeURIComponent(m[1]);
    if (req.method === "GET") {
      const body = ghFiles.get(path);
      if (!body) { res.writeHead(404).end("{}"); return; }
      res.end(JSON.stringify({ sha: "sha-" + path, content: Buffer.from(body).toString("base64") }));
      return;
    }
    if (req.method === "PUT") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const put = JSON.parse(data) as { content: string };
        ghFiles.set(path, Buffer.from(put.content, "base64").toString("utf8"));
        ghPuts++;
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
  }
  res.writeHead(404).end();
});

let live: typeof import("../src/live.js");
let api: HttpServer;
let base = "";

before(async () => {
  await new Promise<void>((r) => mock.listen(0, r));
  const port = (mock.address() as AddressInfo).port;
  process.env.LIVE_RAW_BASE = `http://127.0.0.1:${port}`;
  process.env.LIVE_GH_API = `http://127.0.0.1:${port}`;
  process.env.WIKI_GITHUB_TOKEN = "test-token";
  process.env.LIVE_REFRESH_MIN_MS = "0";
  live = await import("../src/live.js");
  const app = express();
  app.use("/api", express.json());
  live.registerLiveRoutes(app);
  api = createServer(app);
  await new Promise<void>((r) => api.listen(0, r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(() => { mock.close(); api.close(); });

beforeEach(() => {
  live._resetLiveForTests();
  ghFiles.clear();
  ghPuts = 0;
  ghFiles.set("live/tuning/monsters.json", JSON.stringify({
    format: "pixel-wiki-tuning-monsters@1", updated_at: "t0",
    defaults: { max_hp: 20 }, monsters: { mammoth: { max_hp: 50, loot: [] } },
  }));
  ghFiles.set("live/tuning/constants.json", JSON.stringify({
    format: "pixel-wiki-tuning-constants@1", updated_at: "t0", overrides: { WALK_SPEED: 80 },
  }));
});

const PASSWORD = "ksyejjdjdjsjjdhsjsjbsj5637362762HshsjjfkdjsVdj6832Xhdjfjdkjfkdk736367374737hfjjfdjjdvcc9999hh";

async function login(): Promise<string> {
  const res = await fetch(`${base}/api/wiki/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { token: string }).token;
}

test("boot load pulls live/** from GitHub raw", async () => {
  await live.initLive("/nonexistent");
  const res = await fetch(`${base}/api/live/state`);
  const state = (await res.json()) as { tuning: { monsters: { monsters: Record<string, { max_hp: number }> } } };
  assert.equal(state.tuning.monsters.monsters.mammoth.max_hp, 50);
});

test("login rejects wrong credentials, accepts the admin", async () => {
  const bad = await fetch(`${base}/api/wiki/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "nope" }),
  });
  assert.equal(bad.status, 401);
  const token = await login();
  const me = await fetch(`${base}/api/wiki/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await me.json(), { admin: true });
  const anon = await fetch(`${base}/api/wiki/me`);
  assert.deepEqual(await anon.json(), { admin: false });
});

test("a session survives a restart — a deploy must not sign the Game Master out", async () => {
  const token = await login();
  // Everything a process restart loses. The old in-memory session map died
  // here, which is why every deploy (many a day) signed the admin out.
  live._resetLiveForTests();
  const me = await fetch(`${base}/api/wiki/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await me.json(), { admin: true });

  // It is genuinely SIGNED: the expiry is not a free-text claim a client can
  // stretch by editing the token.
  const [exp, sig] = token.split(".");
  const forged = await fetch(`${base}/api/wiki/me`, {
    headers: { Authorization: `Bearer ${Number(exp) + 999999}.${sig}` },
  });
  assert.deepEqual(await forged.json(), { admin: false });
});

test("a session lasts a week, expires on its own, and rotating the secret revokes it", async () => {
  const res = await fetch(`${base}/api/wiki/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PASSWORD }),
  });
  const { token, expires_in_s } = (await res.json()) as { token: string; expires_in_s: number };
  const WEEK = 7 * 24 * 3600;
  assert.equal(expires_in_s, WEEK);
  assert.ok(Math.abs(Number(token.split(".")[0]) - (Date.now() / 1000 + WEEK)) < 60, "expiry is a week out");

  // An EXPIRED token, correctly signed with the server's own derived key, is
  // still refused. (Signing it here pins the token format on purpose: change
  // the scheme and this test tells you.)
  const key = createHash("sha256").update(`wiki-session|${process.env.WIKI_GITHUB_TOKEN}`, "utf8").digest();
  const past = String(Math.floor(Date.now() / 1000) - 60);
  const expired = `${past}.${createHmac("sha256", key).update(past).digest("hex")}`;
  const old = await fetch(`${base}/api/wiki/me`, { headers: { Authorization: `Bearer ${expired}` } });
  assert.deepEqual(await old.json(), { admin: false });

  // Rotating the server secret invalidates every live session — the
  // revocation lever a stateless scheme would otherwise lack.
  process.env.WIKI_SESSION_SECRET = "rotated";
  live._resetLiveForTests();
  const after = await fetch(`${base}/api/wiki/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await after.json(), { admin: false });
  delete process.env.WIKI_SESSION_SECRET;
  live._resetLiveForTests();
  const back = await fetch(`${base}/api/wiki/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await back.json(), { admin: true }, "and putting it back restores them");
});

test("save without login is refused; with login it commits + notifies rooms", async () => {
  await live.initLive("/nonexistent");
  const denied = await fetch(`${base}/api/wiki/save`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: "tuning/monsters", set: { mammoth: { max_hp: 99 } } }),
  });
  assert.equal(denied.status, 401);

  let pushed: ReturnType<typeof live.liveTuning> | null = null;
  const off = live.onLiveChange((t) => (pushed = t));
  const token = await login();
  const ok = await fetch(`${base}/api/wiki/save`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ file: "tuning/monsters", set: { mammoth: { max_hp: 99, loot: [] } } }),
  });
  assert.equal(ok.status, 200);
  off();
  assert.equal(ghPuts, 1); // committed to GitHub…
  const committed = JSON.parse(ghFiles.get("live/tuning/monsters.json")!) as { monsters: Record<string, { max_hp: number }> };
  assert.equal(committed.monsters.mammoth.max_hp, 99);
  // …adopted in memory and pushed to rooms:
  assert.ok(pushed, "rooms were notified");
  const t = live.liveTuning();
  assert.equal((t.monsters.monsters as Record<string, { max_hp: number }>).mammoth.max_hp, 99);
});

test("save deletes an entry when the value is null", async () => {
  await live.initLive("/nonexistent");
  const token = await login();
  const res = await fetch(`${base}/api/wiki/save`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ file: "tuning/constants", set: { WALK_SPEED: null } }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(live.liveTuning().constants.overrides, {});
});

test("refresh picks up an external push and notifies only on change", async () => {
  await live.initLive("/nonexistent");
  let notified = 0;
  const off = live.onLiveChange(() => notified++);
  await live.refreshLive(); // nothing changed
  assert.equal(notified, 0);
  ghFiles.set("live/tuning/constants.json", JSON.stringify({
    format: "pixel-wiki-tuning-constants@1", updated_at: "t1", overrides: { WALK_SPEED: 120 },
  }));
  await live.refreshLive();
  off();
  assert.equal(notified, 1);
  assert.equal((live.liveTuning().constants.overrides as Record<string, number>).WALK_SPEED, 120);
});

test("state + save answer 503 until the boot load finishes", async () => {
  // _resetLiveForTests left ready=false and no initLive has run.
  const st = await fetch(`${base}/api/live/state`);
  assert.equal(st.status, 503);
  const token = await login();
  const sv = await fetch(`${base}/api/wiki/save`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ file: "tuning/constants", set: { X: 1 } }),
  });
  assert.equal(sv.status, 503);
  assert.equal(ghPuts, 0);
});

test("save merges onto GitHub HEAD, not server memory (agent push preserved)", async () => {
  await live.initLive("/nonexistent");
  // An agent commits directly to GitHub AFTER our boot load — server memory
  // doesn't know about `agent_added` yet (no refresh ran).
  ghFiles.set("live/tuning/monsters.json", JSON.stringify({
    format: "pixel-wiki-tuning-monsters@1", updated_at: "t9",
    defaults: { max_hp: 20 }, monsters: { mammoth: { max_hp: 50, loot: [] }, agent_added: { max_hp: 7, loot: [] } },
  }));
  const token = await login();
  const res = await fetch(`${base}/api/wiki/save`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ file: "tuning/monsters", set: { mammoth: { max_hp: 99, loot: [] } } }),
  });
  assert.equal(res.status, 200);
  const committed = JSON.parse(ghFiles.get("live/tuning/monsters.json")!) as { monsters: Record<string, { max_hp: number }> };
  assert.equal(committed.monsters.mammoth.max_hp, 99, "admin edit landed");
  assert.equal(committed.monsters.agent_added?.max_hp, 7, "concurrent agent entry survived the save");
  // …and the server adopted the merged truth (agent entry now in memory too).
  assert.equal((live.liveTuning().monsters.monsters as Record<string, { max_hp: number }>).agent_added.max_hp, 7);
});

test("refresh never rolls back to an OLDER (CDN-stale) document", async () => {
  await live.initLive("/nonexistent");
  const fresh = { format: "pixel-wiki-tuning-constants@1", updated_at: "2026-07-30T10:00:00Z", overrides: { WALK_SPEED: 120 } };
  ghFiles.set("live/tuning/constants.json", JSON.stringify(fresh));
  await live.refreshLive();
  assert.equal((live.liveTuning().constants.overrides as Record<string, number>).WALK_SPEED, 120);
  // The CDN regresses to an older cached copy — must NOT be adopted.
  ghFiles.set("live/tuning/constants.json", JSON.stringify({
    format: "pixel-wiki-tuning-constants@1", updated_at: "2026-07-30T09:00:00Z", overrides: { WALK_SPEED: 80 },
  }));
  await live.refreshLive();
  assert.equal((live.liveTuning().constants.overrides as Record<string, number>).WALK_SPEED, 120, "stale copy rejected");
  ghFiles.set("live/tuning/constants.json", JSON.stringify(fresh));
});

test("initLive notifies rooms so boot-window joiners get the real tuning", async () => {
  let notified = 0;
  const off = live.onLiveChange(() => notified++);
  await live.initLive("/nonexistent");
  off();
  assert.equal(notified, 1);
});

test("save with no server token fails closed (memory untouched)", async () => {
  const saveToken = process.env.WIKI_GITHUB_TOKEN;
  delete process.env.WIKI_GITHUB_TOKEN;
  try {
    await live.initLive("/nonexistent");
    const token = await login();
    const res = await fetch(`${base}/api/wiki/save`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ file: "tuning/constants", set: { WALK_SPEED: 999 } }),
    });
    assert.equal(res.status, 503);
    assert.equal((live.liveTuning().constants.overrides as Record<string, number>).WALK_SPEED, 80);
  } finally {
    process.env.WIKI_GITHUB_TOKEN = saveToken;
  }
});
