// "Save your character" (src/account/attach.ts): Google verification, attach,
// login-by-provider with rotation, the no-oracle rule, and THE trap — a
// room's stale record must never undo a rotation or a link.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import {
  IDENTITY_FIELDS,
  MemoryAccountStore,
  hashSecret,
  loginKey,
  mintId,
  mintSecret,
  newAccount,
  progressionOf,
  resolveAccount,
  secretMatches,
} from "../src/account/store.js";
import {
  accountStatus,
  attachLogin,
  loginWithProvider,
  registerAccountRoutes,
  verifyGoogleCredential,
  type ProviderIdentity,
  type Verifier,
} from "../src/account/attach.js";

const CLIENT = "123456-abc.apps.googleusercontent.com";
const NOW = 1_800_000_000_000;
/** The SHAPE of a credential is all the verifier checks locally; tokeninfo
 *  is what decodes it. The subject is smuggled in so the fake can answer. */
const credentialFor = (sub: string) => `hdr.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.sig`;
const subOf = (credential: string) => JSON.parse(Buffer.from(credential.split(".")[1], "base64url").toString()).sub as string;

/** A fake tokeninfo: answers with the claims `make` builds for the token. */
function fakeTokeninfo(make: (sub: string) => Record<string, unknown> | null, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const token = new URL(url).searchParams.get("id_token") || "";
    const claims = make(subOf(token));
    return new Response(JSON.stringify(claims ?? { error: "invalid_token" }), {
      status: claims ? 200 : 400,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const good = (sub: string) => ({ aud: CLIENT, iss: "https://accounts.google.com", exp: String(NOW / 1000 + 3600), sub, email: "x@y" });

/** The verifier the route tests use: "google" + a well-shaped credential is
 *  whoever the credential names. */
const fakeVerifier: Verifier = async (provider, credential) =>
  provider === "google" && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(credential) ? { provider: "google", subject: subOf(credential) } : null;

test("the verifier trusts Google's answer only when aud, iss, exp and sub all check out", async () => {
  const calls: string[] = [];
  const ok = await verifyGoogleCredential(credentialFor("777"), CLIENT, fakeTokeninfo(good, calls), NOW);
  assert.deepEqual(ok, { provider: "google", subject: "777" });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith("https://oauth2.googleapis.com/tokeninfo?id_token="));

  const cases: Array<[string, (sub: string) => Record<string, unknown> | null]> = [
    ["another app's audience", (sub) => ({ ...good(sub), aud: "someone-else.apps.googleusercontent.com" })],
    ["a foreign issuer", (sub) => ({ ...good(sub), iss: "https://evil.example" })],
    ["an expired token", (sub) => ({ ...good(sub), exp: String(NOW / 1000 - 1) })],
    ["no expiry at all", (sub) => ({ ...good(sub), exp: undefined })],
    ["no subject", (sub) => ({ ...good(sub), sub: "" })],
    ["a subject that is not a clean id", (sub) => ({ ...good(sub), sub: "a/b" })],
    ["Google says invalid (400)", () => null],
  ];
  for (const [why, make] of cases) {
    assert.equal(await verifyGoogleCredential(credentialFor("777"), CLIENT, fakeTokeninfo(make), NOW), null, why);
  }
  // A network failure is a sign-in to retry, never an identity.
  const down = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
  assert.equal(await verifyGoogleCredential(credentialFor("777"), CLIENT, down, NOW), null);
  // Garbage never leaves the process, and no client id means no verification.
  const never: string[] = [];
  const spy = fakeTokeninfo(good, never);
  for (const bad of ["", "not a jwt", "a.b", "x".repeat(5000), "a.b.c.d", "ä.b.c"]) {
    assert.equal(await verifyGoogleCredential(bad, CLIENT, spy, NOW), null, JSON.stringify(bad.slice(0, 12)));
  }
  assert.equal(await verifyGoogleCredential(credentialFor("777"), "", spy, NOW), null);
  assert.equal(never.length, 0, "nothing malformed was ever sent to Google");
});

test("attach links a login to the account that presents the right pair, once", async () => {
  const store = new MemoryAccountStore();
  const me = await resolveAccount(store, undefined, "Ari", "default_girl");
  const ident: ProviderIdentity = { provider: "google", subject: "1001" };

  const r = await attachLogin(store, { id: me.id, secret: me.secret }, ident);
  assert.deepEqual(r, { ok: true, providers: ["google"] });
  assert.equal((await store.load(me.id))!.providers?.google, "1001", "recorded on the account");
  assert.equal(await store.lookupLogin(loginKey("google", "1001")), me.id, "and the login row points back");

  // Again: idempotent, not an error.
  assert.deepEqual(await attachLogin(store, { id: me.id, secret: me.secret }, ident), { ok: true, providers: ["google"] });
  // A DIFFERENT Google identity on the same account: one per provider.
  const other = await attachLogin(store, { id: me.id, secret: me.secret }, { provider: "google", subject: "1002" });
  assert.deepEqual(other, { ok: false, reason: "attached" });
  assert.equal(await store.lookupLogin(loginKey("google", "1002")), undefined, "nothing was claimed for it");

  const st = await accountStatus(store, { id: me.id, secret: me.secret });
  assert.deepEqual(st, { ok: true, providers: ["google"], name: "Ari", character: "default_girl", level: 1 });
});

test("a wrong pair attaches nothing and reveals nothing", async () => {
  const store = new MemoryAccountStore();
  const me = await resolveAccount(store, undefined, "Ari", "default_girl");
  const ident: ProviderIdentity = { provider: "google", subject: "1001" };
  const wrong = await attachLogin(store, { id: me.id, secret: mintSecret() }, ident);
  const unknown = await attachLogin(store, { id: mintId(), secret: me.secret }, ident);
  const none = await attachLogin(store, undefined, ident);
  assert.deepEqual(wrong, { ok: false, reason: "unauthorized" });
  assert.deepEqual(unknown, wrong, "an unknown id answers exactly like a wrong secret");
  assert.deepEqual(none, wrong);
  assert.equal(await store.lookupLogin(loginKey("google", "1001")), undefined, "no row was claimed");
  assert.equal((await store.load(me.id))!.providers, undefined);
  assert.deepEqual(await accountStatus(store, { id: me.id, secret: "nope" }), { ok: false, reason: "unauthorized" });
});

test("an identity already saved to another character is refused, naming that character", async () => {
  const store = new MemoryAccountStore();
  const laptop = await resolveAccount(store, undefined, "Ari", "default_girl");
  const rec = (await store.load(laptop.id))!;
  rec.level = 14;
  await store.save(laptop.id, rec);
  const ident: ProviderIdentity = { provider: "google", subject: "1001" };
  assert.equal((await attachLogin(store, { id: laptop.id, secret: laptop.secret }, ident)).ok, true);

  const phone = await resolveAccount(store, undefined, "Ari again", "default_boy");
  const r = await attachLogin(store, { id: phone.id, secret: phone.secret }, ident);
  assert.deepEqual(r, { ok: false, reason: "taken", other: { name: "Ari", character: "default_girl", level: 14 } });
  assert.equal(await store.lookupLogin(loginKey("google", "1001")), laptop.id, "still the laptop's");
  assert.equal((await store.load(phone.id))!.providers, undefined, "the phone's account is untouched");
});

test("login by provider returns a NEW pair, and the old one is dead", async () => {
  const store = new MemoryAccountStore();
  const laptop = await resolveAccount(store, undefined, "Ari", "default_girl");
  const rec = (await store.load(laptop.id))!;
  rec.level = 14;
  rec.inv = [{ item: "wolf_fang", n: 3 }];
  await store.save(laptop.id, rec);
  const ident: ProviderIdentity = { provider: "google", subject: "1001" };
  assert.equal((await attachLogin(store, { id: laptop.id, secret: laptop.secret }, ident)).ok, true);

  const r = await loginWithProvider(store, ident);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.id, laptop.id, "the same account");
  assert.match(r.secret, /^[0-9a-f]{64}$/);
  assert.notEqual(r.secret, laptop.secret, "rotated");
  assert.equal(r.level, 14);
  assert.equal(r.name, "Ari");

  // The laptop's pair is dead at its next join: it becomes a NEW player, not
  // Ari (the no-oracle rule), and Ari is untouched.
  const stale = await resolveAccount(store, { id: laptop.id, secret: laptop.secret }, "Ari", "default_girl");
  assert.notEqual(stale.id, laptop.id);
  assert.equal(stale.rec.level, 1);
  // The phone's pair is Ari.
  const fresh = await resolveAccount(store, { id: r.id, secret: r.secret }, "ignored", "ignored");
  assert.equal(fresh.id, laptop.id);
  assert.equal(fresh.rec.level, 14);
  assert.deepEqual(fresh.rec.inv, [{ item: "wolf_fang", n: 3 }]);
  assert.equal(fresh.secret, undefined, "no re-issue on a normal return");

  // Nobody attached this one.
  assert.deepEqual(await loginWithProvider(store, { provider: "google", subject: "9999" }), { ok: false, reason: "unknown" });
});

test("THE TRAP: a room's stale record can never undo a rotation or a link", async () => {
  // The room loads the document at join and rewrites it on every save. A
  // login on a NEW device rotates the secret while the old session is still
  // in the room; the join that kicks it makes it save. If that save wrote the
  // held record whole, the OLD hash would come back and the new device's pair
  // would die on its next join — the exact bug the account system exists to
  // end. So a save writes progression only, and identity survives it.
  const store = new MemoryAccountStore();
  const joined = await resolveAccount(store, undefined, "Ari", "default_girl");
  const held = joined.rec; // what Player.rec holds for the whole session

  const ident: ProviderIdentity = { provider: "google", subject: "1001" };
  assert.equal((await attachLogin(store, { id: joined.id, secret: joined.secret }, ident)).ok, true);
  const phone = await loginWithProvider(store, ident);
  assert.equal(phone.ok, true);
  if (!phone.ok) return;

  // The kicked room saves: it earned a level and its `held` still carries the
  // OLD hash and no providers.
  held.level = 2;
  held.xp = 50;
  held.pos["the_game"] = { x: 1, y: 2, elev: 0 };
  assert.equal(held.providers, undefined);
  await store.save(joined.id, held);

  const after = (await store.load(joined.id))!;
  assert.equal(after.level, 2, "the progression it earned landed");
  assert.deepEqual(after.pos["the_game"], { x: 1, y: 2, elev: 0 });
  assert.ok(secretMatches(phone.secret, after.secretHash), "the ROTATED secret is still the one on record");
  assert.ok(!secretMatches(joined.secret!, after.secretHash), "the old pair stays dead");
  assert.equal(after.providers?.google, "1001", "the link survived the stale save");
  assert.equal(after.createdAt, joined.rec.createdAt);

  // The invariant behind it: identity is never in a save's payload.
  const payload = progressionOf(newAccount(hashSecret("s"), "A", "c"));
  for (const f of IDENTITY_FIELDS) assert.ok(!(f in payload), `${f} is not a progression field`);
  // ...and a save to a document that does not exist yet writes the whole
  // record (a fresh mint, and the seeding tests rely on it).
  const id = mintId();
  await store.save(id, newAccount(hashSecret("seed"), "Seed", "c"));
  assert.ok(secretMatches("seed", (await store.load(id))!.secretHash));
});

test("the routes: config, attach, status, login, taken, unconfigured", async () => {
  const store = new MemoryAccountStore();
  const app = express();
  app.use("/api", express.json());
  registerAccountRoutes(app, { store, verify: fakeVerifier, config: { google: CLIENT } });
  const srv = app.listen(0);
  await new Promise<void>((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const cfg = await fetch(`${base}/api/account/config`);
    assert.equal(cfg.headers.get("cache-control"), "no-store");
    assert.deepEqual(await cfg.json(), { google: CLIENT });

    const me = await resolveAccount(store, undefined, "Ari", "default_girl");
    const rec = (await store.load(me.id))!;
    rec.level = 7;
    await store.save(me.id, rec);

    assert.equal((await post("/api/account/attach", { id: me.id, secret: me.secret })).status, 400, "no provider/credential");
    assert.equal((await post("/api/account/attach", { id: me.id, secret: me.secret, provider: "apple", credential: credentialFor("1") })).status, 400, "unknown provider");
    assert.equal((await post("/api/account/attach", { id: me.id, secret: me.secret, provider: "google", credential: "garbage" })).status, 401, "bad credential");
    assert.equal((await post("/api/account/attach", { id: me.id, secret: "wrong", provider: "google", credential: credentialFor("1001") })).status, 401, "wrong pair");

    const ok = await post("/api/account/attach", { id: me.id, secret: me.secret, provider: "google", credential: credentialFor("1001") });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, providers: ["google"] });

    const st = await post("/api/account/status", { id: me.id, secret: me.secret });
    assert.deepEqual(await st.json(), { ok: true, providers: ["google"], name: "Ari", character: "default_girl", level: 7 });
    assert.equal((await post("/api/account/status", { id: me.id, secret: "wrong" })).status, 401);

    // Another browser: the identity is taken, and it learns by whom.
    const other = await resolveAccount(store, undefined, "Bo", "default_boy");
    const taken = await post("/api/account/attach", { id: other.id, secret: other.secret, provider: "google", credential: credentialFor("1001") });
    assert.equal(taken.status, 409);
    assert.deepEqual(await taken.json(), { error: "taken", other: { name: "Ari", character: "default_girl", level: 7 } });

    // ...so it logs in instead and gets Ari's NEW pair.
    assert.equal((await post("/api/account/login", { provider: "google", credential: credentialFor("2002") })).status, 404, "nobody attached 2002");
    const login = await post("/api/account/login", { provider: "google", credential: credentialFor("1001") });
    assert.equal(login.status, 200);
    const pair = (await login.json()) as { ok: true; id: string; secret: string; name: string; level: number };
    assert.equal(pair.id, me.id);
    assert.equal(pair.level, 7);
    assert.notEqual(pair.secret, me.secret);
    assert.equal((await post("/api/account/status", { id: me.id, secret: me.secret })).status, 401, "the old pair is dead");
    assert.equal((await post("/api/account/status", { id: pair.id, secret: pair.secret })).status, 200, "the new one is Ari");
  } finally {
    srv.close();
  }

  // A server without GOOGLE_CLIENT_ID says so instead of failing sign-ins.
  const bare = express();
  bare.use("/api", express.json());
  registerAccountRoutes(bare, { store, verify: fakeVerifier, config: {} });
  const srv2 = bare.listen(0);
  await new Promise<void>((r) => srv2.once("listening", r));
  const base2 = `http://127.0.0.1:${(srv2.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await (await fetch(`${base2}/api/account/config`)).json(), { google: null });
    const res = await fetch(`${base2}/api/account/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "google", credential: credentialFor("1") }),
    });
    assert.equal(res.status, 503);
  } finally {
    srv2.close();
  }
});
