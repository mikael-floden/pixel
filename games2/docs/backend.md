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

## Zone rooms (2026-09-09)

- **A world with an entry in `config/zones.json` runs as `cols x rows` zone
  rooms** (the_game: 4 x 4, 99 cells a zone; borders at cells 99, 198, 297),
  one `WorldRoom` per (world, zone) through `filterBy(["world", "zone"])`;
  no entry, no zone option, or a test = the whole-world room, whose behaviour
  is byte-for-byte the old one (the suite runs there). Geometry:
  `shared/src/zones.ts` (`zoneGrid/zoneAt/zoneRect/zoneNeighbours/
  distToRect/nearEdge/zoneRoute`), served at `/api/zones/<world>` for the
  client, which joins the room of the world's SPAWN and is handed on from
  there (a returning player's saved spot may lie elsewhere; the spawn room
  hands it over on its first tick, one hop). Gate: `server/test/zones.test.ts`
  (two zone rooms in one process over the fake bus: ghosts, the hand-off
  with hp/position/id intact, a refused stale key, a monster transfer, chat
  across zones).
- **Players are keyed by a STABLE id** — the session id of the first room
  they joined, carried through hand-offs (`Player.pid`, server-only) with
  the current session in the synced `sid`. So `state.players.get(r.sessionId)`
  still works in every single-room test and the client finds itself by
  `player.sid === room.sessionId` (`WorldScene.myId`), never by key.
  Monsters and drops of a zone room carry `z<zone>:` so ids are
  world-unique; the whole-world room's ids are unchanged.
- **Ghosts live in their own maps** (`state.ghosts/ghostMonsters/ghostDrops`,
  view-tagged like the real ones) so no server loop steps, fights or saves
  one; the client binds them to the same add/remove handlers and removes a
  sprite only when the id is in NEITHER map — the same id moves between the
  two as a body crosses. A room publishes its band (`GHOST_BAND_WU` =
  `INTEREST_LEAVE_WU`, plus anything of its own standing outside its rect)
  every `EDGE_TICKS` (2) ticks; a receiver keeps what lies within the band of
  ITS rect and skips ids it owns; a snapshot is that zone's whole band, so
  what it no longer carries is dropped at once and a quiet owner's ghosts
  expire after `GHOST_TTL_MS` (1 s).
- **The hand-off**: `stepZones` sees a body outside the rect, writes the hot
  state (`HotState`: position, dir, hp/ep/level/xp, backpack, the account
  record, seq, torch, no-aggro) to `handoff:<world>:<pid>` with a 24-hex
  one-shot key (TTL 10 s) and sends `zone:go`; the client joins the new zone
  `fresh` (no seat reclaim) with pid + key, binds it in SWAP mode (adds are
  idempotent, a reconcile removes what the new view lacks), replays the
  inputs it buffered meanwhile, then leaves the old room; the receiving room
  consumes the key, adopts the body and publishes `handoff:done` to the
  sender's `ctl` channel, which deletes its copy without saving and marks the
  session `handed` so its leave holds no seat. A key that does not match, or
  was consumed, is an ordinary join under the session id. A hop nobody
  completes is forgotten after `HANDOFF_TIMEOUT_MS` and the body stays.
  MEASURED headless on the_game: spawn (zone 11) → teleport to zone 4 → walk
  over cell 99 into zone 5: two hops, hp and position carried, the neighbour's
  monsters visible as ghosts on the line, the ground drawn after each swap.
  A hop into a zone whose room does not exist yet waits for that room's
  create (the terrain load, ~1-2 s on the_game); warming every zone room at
  server start is the obvious next step and is not built.
- **Monsters transfer with their brain** (`monster:xfer` on the receiver's
  `ctl` channel: kind, position, hp, area, home zone, orbit sign, chase
  anchor); the hunt survives only if the victim is a player of the new room,
  else it roams. Seeding takes each spawn polygon's cells inside the rect and
  a proportional share of `num`; a respawn goes to the `home` zone that
  seeded it (`monster:respawn`). `dbgmonster {id, x, y}` moves one for gates.
- **The world clock is the bus document `clock:<world>`** (index, phaseT,
  speed, frozen, weather, aurora, the phase deadline as an epoch, the
  writing room's id): every room adopts a publish it did not write, so zones
  agree; `resetWorldClocks()` deletes the documents. Wild stars are rolled by
  zone 0 (or the whole-world room) only.
- **Chat, the arrival star and level-ups go over `world:<world>:events`** and
  every room of the world broadcasts them; presence (`pid` → name, zone) is
  the hash `presence:<world>`.
- NOT YET (spec phases 4-5): the load bot; cross-border combat (a ghost can
  be neither hit nor hit you); warm rooms.
