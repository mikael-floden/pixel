// The account of record (src/account/store.ts): identity resolution, the
// no-oracle rule, and the aliasing guard.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAccountStore,
  hashSecret,
  mintId,
  mintSecret,
  newAccount,
  resolveAccount,
  secretMatches,
} from "../src/account/store.js";

test("a minted secret verifies against its hash, and nothing else does", () => {
  const s = mintSecret();
  assert.equal(s.length, 64, "256 bits, hex");
  assert.ok(secretMatches(s, hashSecret(s)));
  assert.ok(!secretMatches(mintSecret(), hashSecret(s)), "a different secret");
  assert.ok(!secretMatches(s, "not-a-hash"), "a malformed hash is never a match");
  assert.ok(!secretMatches(s, ""), "an empty hash is never a match");
  // A stored hash of the wrong LENGTH must not throw inside timingSafeEqual.
  assert.ok(!secretMatches(s, "abcd"));
});

test("a first-time player is given an account with no screen and no claim", async () => {
  const store = new MemoryAccountStore();
  const got = await resolveAccount(store, undefined, "Ari", "default_girl");
  assert.match(got.id, /^[0-9a-f]{32}$/);
  assert.ok(got.secret, "the one moment the client is told its pair");
  assert.equal(got.rec.level, 1);
  assert.equal(got.rec.name, "Ari");
  assert.equal(got.rec.character, "default_girl");
  // ...and it was actually persisted, not just returned.
  const stored = await store.load(got.id);
  assert.ok(stored && secretMatches(got.secret!, stored.secretHash));
});

test("a returning player with the right pair gets their own account back", async () => {
  const store = new MemoryAccountStore();
  const first = await resolveAccount(store, undefined, "Ari", "default_girl");
  const rec = (await store.load(first.id))!;
  rec.level = 14;
  rec.inv = [{ item: "sword", n: 1 }];
  await store.save(first.id, rec);

  const back = await resolveAccount(
    store,
    { id: first.id, secret: first.secret },
    "ignored",
    "ignored",
  );
  assert.equal(back.id, first.id);
  assert.equal(back.rec.level, 14, "the character they earned");
  assert.deepEqual(back.rec.inv, [{ item: "sword", n: 1 }]);
  assert.equal(back.secret, undefined, "no re-issue on a normal return");
});

test("a wrong secret mints a NEW account and never reveals the id exists", async () => {
  const store = new MemoryAccountStore();
  const real = await resolveAccount(store, undefined, "Ari", "default_girl");
  const rec = (await store.load(real.id))!;
  rec.level = 30;
  await store.save(real.id, rec);

  const attacker = await resolveAccount(
    store,
    { id: real.id, secret: mintSecret() },
    "Mallory",
    "default_boy",
  );
  assert.notEqual(attacker.id, real.id, "never hands over the account");
  assert.equal(attacker.rec.level, 1, "a fresh level-1 character, not theirs");
  assert.ok(attacker.secret);
  // The real account is untouched.
  assert.equal((await store.load(real.id))!.level, 30);
});

test("an unknown id is answered exactly like no claim at all", async () => {
  const store = new MemoryAccountStore();
  const a = await resolveAccount(store, { id: mintId(), secret: mintSecret() }, "A", "c");
  const b = await resolveAccount(store, undefined, "A", "c");
  assert.equal(a.rec.level, b.rec.level);
  assert.equal(typeof a.secret, typeof b.secret, "both are told a new pair");
  assert.notEqual(a.id, b.id);
});

test("a malformed id is rejected before it ever reaches the store", async () => {
  const store = new MemoryAccountStore();
  let loads = 0;
  const spy = {
    load: (id: string) => { loads++; return store.load(id); },
    save: (id: string, r: any) => store.save(id, r),
  };
  for (const bad of ["", "../../etc/passwd", "x".repeat(200), "NOTHEX", "abc"]) {
    const got = await resolveAccount(spy, { id: bad, secret: mintSecret() }, "A", "c");
    assert.match(got.id, /^[0-9a-f]{32}$/, `minted a clean id for ${JSON.stringify(bad)}`);
  }
  assert.equal(loads, 0, "a malformed id is never looked up");
});

test("the store deep-copies at both boundaries (a live inv must not alias it)", async () => {
  const store = new MemoryAccountStore();
  const id = mintId();
  const rec = newAccount(hashSecret("s"), "Ari", "default_girl");
  rec.inv = [{ item: "apple", n: 1 }];
  await store.save(id, rec);

  rec.inv[0].n = 99; // mutate the caller's copy AFTER saving
  assert.equal((await store.load(id))!.inv[0].n, 1, "save copied in");

  const a = (await store.load(id))!;
  a.inv[0].n = 42; // mutate a loaded copy
  assert.equal((await store.load(id))!.inv[0].n, 1, "load copied out");
});
