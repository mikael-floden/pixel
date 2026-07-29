// The live-update channel + wiki admin API (src/live.ts): login gate,
// per-entry save → GitHub commit → in-memory adoption → room notification,
// and the push-based refresh path — all against a local mock GitHub.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
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
