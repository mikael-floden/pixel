# Backend: one world for 10,000 players

The rules are in `spec/ZONES.md`; this doc holds the measurements, the traps
and the rejected approaches as each phase lands. Rewrite in place.

## Interest management (2026-09-09)

- **A client receives only the players, monsters and drops within
  `INTEREST_WU` (32 cells) of its own player**, keeps them to
  `INTEREST_LEAVE_WU` (36 cells), always holds itself, and the set is
  recomputed every `INTEREST_TICKS` (4) ticks (`WorldRoom.stepInterest`, a
  `StateView` per client — `attachView` in onJoin, before the join snapshot
  is encoded so "me" is in the first patch). Time, weather, chess and the
  spawn-area overlay stay global. Gate: `server/test/interest.test.ts`.
- **`defineTypes` IGNORES `view: true`.** Only the `schema()` builder reads
  that flag; with `defineTypes` the fields registered as plain, `hasFilters`
  stayed false and every client received the whole room while the test said
  "140 < 140". The tag is applied as the decorator call itself:
  `view()(WorldState.prototype, field)` after `defineTypes` (WorldState.ts).
- **A client with no view receives NONE of a view-tagged field**, so
  "unlimited" is a view holding everything (`interestRadius: 0` → Infinity),
  never the absence of a view. The option is a room CREATE option for tests
  and QA; a client cannot ask for it.
- **The encoder buffer is sized in the room module** (`Encoder.BUFFER_SIZE`
  = 64 KB at the top of WorldRoom.ts): a test's own `Server` never runs
  index.ts, and the first patch after a join now carries the whole view —
  140 monsters for an unlimited test client overflowed the 8 KB default
  SILENTLY, fields arriving `undefined` on the client.
- The pass buckets every entity once (`INTEREST_BUCKET_WU` 16 cells) and each
  client queries at most 49 buckets; an entity that left the state was
  already DELETEd to every view that held it by the encoder, so `seen` drops
  it without a view call (a `view.remove` on a detached object is never
  issued).
- Tests that pick a monster by kind across the map (`combat`,
  `combat.review`, `monsters`, `noaggro`) create their room with
  `interestRadius: 0`.

## The bus (2026-09-09)

- `server/src/bus.ts`: `publish/subscribe/get/set(ttl)/del/hset/hdel/hgetall`
  on ioredis when `REDIS_URL` is set (two connections — a subscribed one
  cannot issue commands), else `FakeBus` in process. Gate:
  `server/test/bus.test.ts`, the same contract against both (the Redis arm
  runs when `REDIS_URL` names one).
- **The fake delivers asynchronously (`setImmediate`) and decodes a fresh
  copy per handler**, as a socket would: Redis never re-enters the publisher,
  and a handler mutating a shared object reached another handler in the first
  cut (caught by the contract test).
- Dev with the real thing: `docker run -p 6379:6379 redis` then
  `REDIS_URL=redis://127.0.0.1:6379 npm run dev`.
