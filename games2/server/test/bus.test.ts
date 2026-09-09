import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, RedisBus, bus, useBus } from "../src/bus.js";

const tick = () => new Promise((r) => setImmediate(r));

/** The contract every backend keeps (spec/ZONES.md). Run against the fake
 *  always, and against a real Redis when REDIS_URL names one. */
async function contract(b: FakeBus | RedisBus) {
  // publish/subscribe delivers a COPY, asynchronously, to every subscriber
  // and to nobody after unsubscribe.
  const got: any[] = [];
  const off = b.subscribe("t:chan", (m) => got.push(m));
  const other: any[] = [];
  const off2 = b.subscribe("t:chan", (m) => other.push(m));
  const sent = { a: 1, nested: { x: [1, 2] } };
  if (b.kind === "redis") await new Promise((r) => setTimeout(r, 100)); // subscription round trip
  await b.publish("t:chan", sent);
  assert.equal(got.length, 0, "delivery is never synchronous");
  await tick();
  if (b.kind === "redis") await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(got, [sent]);
  assert.deepEqual(other, [sent]);
  assert.notEqual(got[0], sent, "a subscriber gets its own copy");
  got[0].nested.x.push(3);
  assert.equal(other[0].nested.x.length, 2, "handlers do not share the copy");
  off();
  await b.publish("t:chan", { b: 2 });
  await tick();
  if (b.kind === "redis") await new Promise((r) => setTimeout(r, 100));
  assert.equal(got.length, 1, "unsubscribed");
  assert.equal(other.length, 2);
  off2();
  // A throwing handler does not stop the others.
  const survived: any[] = [];
  const offA = b.subscribe("t:throw", () => { throw new Error("boom"); });
  const offB = b.subscribe("t:throw", (m) => survived.push(m));
  if (b.kind === "redis") await new Promise((r) => setTimeout(r, 100));
  await b.publish("t:throw", 1);
  await tick();
  if (b.kind === "redis") await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(survived, [1]);
  offA(); offB();
  // keys with TTL
  await b.set("t:k", "v", 1);
  assert.equal(await b.get("t:k"), "v");
  await b.del("t:k");
  assert.equal(await b.get("t:k"), null);
  // hashes
  await b.hset("t:h", "p1", "a");
  await b.hset("t:h", "p2", "b");
  assert.deepEqual(await b.hgetall("t:h"), { p1: "a", p2: "b" });
  assert.equal(await b.hget("t:h", "p1"), "a");
  assert.equal(await b.hget("t:h", "nope"), null);
  await b.hdel("t:h", "p1");
  assert.deepEqual(await b.hgetall("t:h"), { p2: "b" });
  await b.hdel("t:h", "p2");
  assert.deepEqual(await b.hgetall("t:h"), {});
}

test("the in-process bus keeps the contract", async () => {
  const b = new FakeBus();
  await contract(b);
  // TTL expiry is checked on read.
  await b.set("t:ttl", "x", 0.05);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await b.get("t:ttl"), null);
  assert.ok(b.log.some((e) => e.channel === "t:chan"), "the fake logs its traffic for tests");
  await b.close();
});

test("the process bus is the fake without REDIS_URL, and tests can swap it", () => {
  const saved = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  useBus(null);
  assert.equal(bus().kind, "fake");
  const mine = new FakeBus();
  useBus(mine);
  assert.equal(bus(), mine);
  useBus(null);
  if (saved !== undefined) process.env.REDIS_URL = saved;
});

test("a real Redis keeps the same contract", async (t) => {
  const url = process.env.REDIS_URL;
  if (!url) return t.skip("REDIS_URL not set");
  const b = new RedisBus(url);
  try {
    await contract(b);
  } finally {
    await b.close();
  }
});
