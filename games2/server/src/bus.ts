// bus.ts — THE BUS between rooms (spec/ZONES.md).
//
// Everything a zone room needs from another room — border ghosts, a hand-off,
// a monster transfer, the world clock, chat and presence — travels here and
// nowhere else, so the code path is the same whether the rooms share a
// process (today) or fifty (10k players). ONE contract, two backends:
//
//  - `REDIS_URL` set → ioredis (a local `redis-server` or Docker in dev,
//    Memorystore in prod). Two connections, because a subscribed connection
//    cannot issue commands.
//  - unset → an in-process fake with the same contract, so `npm test` and a
//    plain `npm run dev` install nothing. The fake DELIVERS ASYNCHRONOUSLY on
//    purpose: Redis never re-enters the publisher, and a room written against
//    synchronous delivery would break the day it met the real thing.
//
// Messages are JSON. Keys and channels are namespaced by the caller
// (`zone:<world>:<zone>:edge`, `handoff:<world>:<pid>`, `clock:<world>`).

import Redis from "ioredis";

export interface Bus {
  publish(channel: string, msg: unknown): Promise<void>;
  /** Returns the unsubscribe. A handler that throws is logged, never fatal. */
  subscribe(channel: string, fn: (msg: any) => void): () => void;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec?: number): Promise<void>;
  del(key: string): Promise<void>;
  hset(key: string, field: string, value: string): Promise<void>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, field: string): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  close(): Promise<void>;
  readonly kind: "fake" | "redis";
}

type Handler = (msg: any) => void;

function dispatch(handlers: Set<Handler> | undefined, msg: any, channel: string) {
  if (!handlers) return;
  for (const fn of [...handlers]) {
    try {
      fn(msg);
    } catch (e) {
      console.error(`[bus] handler on ${channel} threw:`, e);
    }
  }
}

/** The in-process backend. TTLs are checked on read (no timers to leak). */
export class FakeBus implements Bus {
  readonly kind = "fake" as const;
  private subs = new Map<string, Set<Handler>>();
  private kv = new Map<string, { v: string; exp: number }>();
  private hashes = new Map<string, Map<string, string>>();
  /** Every publish so far, newest last — a test's window into the traffic. */
  readonly log: { channel: string; msg: unknown }[] = [];

  async publish(channel: string, msg: unknown): Promise<void> {
    const raw = JSON.stringify(msg);
    if (this.log.length < 10_000) this.log.push({ channel, msg });
    const handlers = this.subs.get(channel);
    if (!handlers?.size) return;
    // Decode per delivery, as a socket would: a handler mutating its copy
    // must never reach the publisher's object or another handler's.
    setImmediate(() => {
      for (const fn of [...(this.subs.get(channel) ?? [])]) dispatch(new Set([fn]), JSON.parse(raw), channel);
    });
  }
  subscribe(channel: string, fn: Handler): () => void {
    let set = this.subs.get(channel);
    if (!set) this.subs.set(channel, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.subs.delete(channel);
    };
  }
  async get(key: string): Promise<string | null> {
    const e = this.kv.get(key);
    if (!e) return null;
    if (e.exp && Date.now() >= e.exp) {
      this.kv.delete(key);
      return null;
    }
    return e.v;
  }
  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    this.kv.set(key, { v: value, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
  }
  async del(key: string): Promise<void> {
    this.kv.delete(key);
  }
  async hset(key: string, field: string, value: string): Promise<void> {
    let h = this.hashes.get(key);
    if (!h) this.hashes.set(key, (h = new Map()));
    h.set(field, value);
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hdel(key: string, field: string): Promise<void> {
    const h = this.hashes.get(key);
    h?.delete(field);
    if (h && !h.size) this.hashes.delete(key);
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }
  async close(): Promise<void> {
    this.subs.clear();
  }
}

/** The Redis backend. `maxRetriesPerRequest: null` keeps a command queued
 *  through a reconnect rather than failing the tick that issued it. */
export class RedisBus implements Bus {
  readonly kind = "redis" as const;
  private pub: Redis;
  private sub: Redis;
  private subs = new Map<string, Set<Handler>>();
  constructor(url: string) {
    const opts = { maxRetriesPerRequest: null as null, enableReadyCheck: true, lazyConnect: false };
    this.pub = new Redis(url, opts);
    this.sub = new Redis(url, opts);
    for (const c of [this.pub, this.sub]) c.on("error", (e) => console.error("[bus] redis:", e.message));
    this.sub.on("message", (channel: string, raw: string) => {
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      dispatch(this.subs.get(channel), msg, channel);
    });
  }
  async publish(channel: string, msg: unknown): Promise<void> {
    await this.pub.publish(channel, JSON.stringify(msg));
  }
  subscribe(channel: string, fn: Handler): () => void {
    let set = this.subs.get(channel);
    if (!set) {
      this.subs.set(channel, (set = new Set()));
      void this.sub.subscribe(channel).catch((e) => console.error(`[bus] subscribe ${channel}:`, e));
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) {
        this.subs.delete(channel);
        void this.sub.unsubscribe(channel).catch(() => {});
      }
    };
  }
  get(key: string) {
    return this.pub.get(key);
  }
  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    if (ttlSec) await this.pub.set(key, value, "EX", Math.max(1, Math.ceil(ttlSec)));
    else await this.pub.set(key, value);
  }
  async del(key: string): Promise<void> {
    await this.pub.del(key);
  }
  async hset(key: string, field: string, value: string): Promise<void> {
    await this.pub.hset(key, field, value);
  }
  hget(key: string, field: string) {
    return this.pub.hget(key, field);
  }
  async hdel(key: string, field: string): Promise<void> {
    await this.pub.hdel(key, field);
  }
  hgetall(key: string) {
    return this.pub.hgetall(key);
  }
  async close(): Promise<void> {
    this.subs.clear();
    await Promise.all([this.pub.quit().catch(() => {}), this.sub.quit().catch(() => {})]);
  }
}

let current: Bus | null = null;

/** The process's bus. Built once from the environment; tests swap it with
 *  `useBus(new FakeBus())` and read the fake's `log`. */
export function bus(): Bus {
  if (!current) {
    const url = process.env.REDIS_URL;
    current = url ? new RedisBus(url) : new FakeBus();
    if (!url) console.warn("[bus] in-process bus — one server process only (REDIS_URL=redis://... to share)");
  }
  return current;
}

export function useBus(b: Bus | null): void {
  current = b;
}
