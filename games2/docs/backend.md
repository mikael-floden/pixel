# Backend: one world for 10,000 players

The rules are in `spec/ZONES.md`; this doc holds the measurements, the traps
and the rejected approaches as each phase lands. Rewrite in place.

## Interest management (2026-09-09)

- **A client receives only the players, monsters and drops within
  `INTEREST_WU` (32 cells) of its own player**, keeps them to
  `INTEREST_LEAVE_WU` (36 cells), always holds itself, and the set is
  recomputed every `INTEREST_TICKS` (4) ticks (`WorldRoom.stepInterest`, a
  `StateView` per client). Time, weather, chess and the spawn-area overlay
  stay global. Gate: `server/test/interest.test.ts`.
- **THE JOIN SNAPSHOT IS ALREADY A COMPLETE VIEW**: `attachView` runs the
  interest pass FOR THE JOINER (`interestPass`, the same computation as the
  room's own pass, one client) before onJoin resolves, so the first patch
  carries the whole neighbourhood and not just "me". (A me-only first
  snapshot cost nothing while a join was a fresh page — but a ZONE CROSSING
  binds the new room on it and reconciles every drawn body against it, so
  every monster on screen was removed and re-added up to 200 ms later:
  maintainer 2026-09-12, "all monsters glitch and disappear for a frame or
  two" running over a border. Gate: `scripts/verify-zonehop.mjs`; bisect
  `INTEREST_FILL_AT_JOIN=0`, which `server/test/interest.test.ts` fails on.)
- **A CROSSING IS JUDGED ON HIS DEVICE.** A headless client binds the new room
  1-2.7 s after the join, so the 200 ms window a phone meets cannot be
  reproduced there — `verify-zonehop.mjs` holds the crossing's shape (the
  join snapshot carries the neighbourhood, the swap removes nothing ON
  SCREEN, no frame loses its bodies) and the BEACON carries the evidence: the
  scene records every frame of the 3 s around a hand-off (`ZONE_WATCH_MS`,
  `__ml.zone().frames` — a probe poll cannot see one frame) and folds each
  crossing into one row under `zone.last` (`joinMs/stateMs/boundMs`,
  `snapMonsters`, `inView`, `visMed`/`visFloor`). A `visFloor` far below
  `visMed` IS a body that blinked, on the frame it happened.
- **The old room's patches are not news once a swap is bound**: every
  `onRemove` in `bindRoom` (players, ghosts, monsters, ghost monsters, drops)
  returns when `room !== this.room`, so a room this client has left can never
  destroy a sprite the new one is drawing.
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
  record, seq, torch, no-aggro, `actionSeq`/`hitSeq` — mirrored by CHANGE on
  the client, so a counter rebuilt from zero replayed the last hit at the
  border; the client also re-seeds silently on any DECREASE) to `handoff:<world>:<pid>` with a 24-hex
  one-shot key (TTL 10 s) and sends `zone:go`; the client joins the new zone
  `fresh` (no seat reclaim) with pid + key, binds it in SWAP mode (adds are
  idempotent, a reconcile removes what the new view lacks), replays the
  inputs it buffered meanwhile, then leaves the old room; the receiving room
  consumes the key, adopts the body and publishes `handoff:done` to the
  sender's `ctl` channel, which deletes its copy without saving and marks the
  session `handed` so its leave holds no seat. A key that does not match, or
  was consumed, is an ordinary join under the session id. A hop nobody
  completes is forgotten after `HANDOFF_TIMEOUT_MS` and the body stays.
  THE HOP MUST NOT FREEZE THE BODY (maintainer 2026-09-09, playing with a
  friend: "the transition between zones is a bit laggy or buggy", and a
  teleport into a house): the first cut buffered the client's inputs while
  it joined the new room, so the body stood at the border for the whole
  hop, the client walked on alone, and the replay was throttled to the 0.25 s
  input budget — the body snapped back. Now inputs keep flowing to the OLD
  room (its body keeps walking, and the neighbours' ghost of it with it), the
  client keeps a log of what it sent and replays everything after the cut into
  the new room on bind, and the new room grants `HANDOFF_INPUT_CREDIT_S` (2 s)
  of integration credit for the burst.
  THE CUT IS WHERE THE BODY IS WHEN THE NEW ROOM TAKES IT, NOT WHERE IT WAS
  WHEN THE CROSSING WAS NOTICED (maintainer 2026-09-13: "Why does the player
  lag and sometimes teleport backwards when running from one zone to
  another? ... Why can't the old zone continue handling the player and hand it
  over with the most recent data when the transfer is ready?"). The hot state
  was written ONCE, at `zone:go`, so the old room's own ticks through the join
  — hundreds of ms of them on a phone — were thrown away: the new room adopted
  a body that old, and the client, whose `pending` buffer the OLD room had been
  acking all the while, reconciled onto it, lost exactly the distance covered
  during the join, and sprang forward when its replay landed. `refreshHandoff`
  now rewrites the document every tick under the same capability, so it always
  holds the live position, elevation, hp and the `seq` this room has acked —
  and whatever moved the body is carried, not only what the client can replay
  (a knockback, a fall, the deep current, a monster's hit). One `bus().set` per
  crossing player per tick, never doubled (`handoffWriting`), never issued
  under a capability that is no longer this player's hand-off. The client then
  replays from the seq THE NEW ROOM reports — `zone:go`'s own seq is only where
  the crossing was noticed, and replaying from it would re-integrate what the
  new room already has — and rebuilds `pending` from `predLog`, the same input
  records kept past their ack, because the acks that emptied `pending` came
  from the room being left. Gates: `server/test/handofffresh.test.ts` (the body
  runs ~76 wu during the join and is adopted 0 wu from its live spot; with the
  refresh disabled it is adopted 76 wu behind) and the beacon's hop row
  (`baseSeq`, `behind`, `replayed`). The new room is bound only after its
  FIRST STATE has landed (the join resolves before it; binding earlier left
  `state.players` undefined for a few frames and every per-frame read
  threw). A hand-off join does NOT resend `live:update` (91 KB the same
  client already holds). My own sprite is never removed mid-hop (the old room
  drops my body ~100 ms before its ghost of me arrives). The receiving room
  SAVES the body on adoption: a link dropped mid-hop that fails its seat
  reclaim rejoins from the last saved spot, which was minutes old — the
  house the maintainer was teleported into.
  MEASURED headless on the_game: the server's onJoin runs +230 ms after
  zone:go (matchmake + socket); a walked crossing samples at 100 ms show no
  step over 0.5 cells and `me` continuous across the hop. (The harness's own
  `joinMs` of 1-3 s is renderer starvation — two pages and art streaming on
  four cores — not the server.) Probe: `__ml.zone().lastHop`.
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
  every room of the world broadcasts them.
- **One live session per account, world-wide** (the account agent's contract,
  2026-09-09): presence is the hash `presence:<world>` keyed by ACCOUNT id →
  {pid, zone, name}; a join kicks the session it names (`kickPid` in-room,
  else `kick` on that zone's `ctl` channel), and a leave deletes only its own
  entry. The hand-off key is 128 bits from `randomBytes(16)`, sent only in
  `zone:go`, consumed once; `dirty` rides the hot state; the sending room
  never saves on a hand-off. Gate: the cross-zone kick test in
  `zones.test.ts`.
- NOT YET (spec phases 4-5): the load bot; cross-border combat (a ghost can
  be neither hit nor hit you); warm rooms.

## The load bot (2026-09-09)

`scripts/loadbot.mjs --n 200 --seconds 60 [--pack cx,cy | --border 99]
[--fight] [--nointerest]` against a running dev server: N fake clients
joining like the game (the spawn's zone), teleported to a spot, streaming
20 Hz inputs on a random walk, following every `zone:go`, optionally
engaging the nearest monster. It samples the server's own `/api/stats`
(tick p50/p95/max per room over the last 200 ticks, CPU of one core since
the last call, event-loop lag, rss) every second and measures its own ACK
LATENCY (input seq sent → seen acked), stuck bots, hand-offs and client
decode errors. Run two processes for more than ~250 bots: one bot process
is at ~75% of a core at 200. Its own loop lag is printed so a starved
harness cannot pass as a slow server.

Measured on this 4-core dev box, one server process, the_game with the 4x4
grid, all bots packed within a few cells in one zone (the crowded-room case):

| bots in one room | server CPU (mean, one core) | tick p50 / p95 ms | ack p50 / p95 ms | stuck |
|---|---|---|---|---|
| 40 | 10% | 0.4 / 0.8 | 52 / 102 | 0 |
| 100 | 27% | 1.6 / 3.9 | 51 / 102 | 0 |
| 200 | 50% | 2.5 / 11.8 | 101 / 105 | 0 |
| 400 (2 rooms of 200, see below) | 92% | 2.5 / 12.2 | 101 / 122 | 0 |

- **THE ENCODER BUFFER MUST HOLD EVERY CLIENT'S VIEW SECTION OF ONE PATCH.**
  Colyseus appends each client's view-encoded patch into the ONE shared
  buffer (`SchemaSerializer.applyPatches` advances the same iterator across
  clients), so the buffer grows with clients x visible entities, not with
  the state. At 64 KB, 100 packed bots overflowed on every patch (302,664
  warnings in one run, up to 656 KB asked for), the bytes past the end were
  garbage, 19 of 100 clients died on `"refId" not found` and stopped
  applying patches — ack p95 of seconds while the tick was 4 ms and CPU
  27%. `Encoder.BUFFER_SIZE` is 2 MB (WorldRoom.ts); two buffers per room.
  The first symptom of an undersized buffer is clients silently freezing,
  never a server error.
- **ONE ROOM PER ZONE PER PROCESS.** Two bot processes joining zone 11 at
  once got TWO zone-11 rooms of 200 each (`rooms 2 players 400` in the
  stats): joinOrCreate races while the first room is still in onCreate (the
  terrain load). The first room to finish owns `zoneRooms[world:zone]`,
  `autoDispose` off; a later one is a duplicate: locked, and every body that
  lands in it is handed to the owner. index.ts warms every zone room after
  listen (16 rooms of the_game in 1.7 s), so the race has no window in play
  and no join waits for a terrain load. Gate: the duplicate test in
  `zones.test.ts`.
- **ONE TERRAIN GRID PER WORLD PER PROCESS** (`loadWorldGrid` caches by
  world + hitbox stamp; the scenery restamp loads a fresh one under the new
  stamp and every room adopts it). Each warm room building its own grid and
  stamping 1,335 scenery pieces was 850 MB rss for 16 rooms — over the 512
  MiB Cloud Run instance; shared, 400 MB (dev, tsx) and the 16 rooms warm in
  0.9 s. The instance is 1 GiB now (deploy workflow) for headroom.
- **An empty room runs its sim every `IDLE_DIVISOR` (4) ticks** with the
  accumulated dt (the clock still moves every tick; edge snapshots keep
  flowing at the slower rate and a neighbour's client eases ghosts at rate
  12). Idle with 16 warm rooms was ~20% of a core (the monster brains; zone 6
  with 63 monsters ticks 2 ms p50); with the divisor it is 10%, 386 MB. A client
  brings the full rate back on its first tick (`/api/stats` reports `simHz`
  per room; gate `server/test/idle.test.ts`).
- **A JOIN BURST IS A LIMIT OF ITS OWN**: 400 bots joining one zone within
  10 s from two processes on a box already at 100% CPU expired 65 seat
  reservations ("seat reservation expired"), 100 joins failed, and every
  failed joinOrCreate created another room of the zone (50+ duplicates,
  each locked and handing its arrivals on — the guard held, rss reached
  1.5 GB). 200 joins in 10 s on a quiet core were clean. Hold the join rate
  near 20/s per core until reservations are measured on the real instance.
- Border crossings at 300 bots straddling x = 99 (two processes): 341
  hand-offs in 60 s, 0 stuck, 0 decode errors, ack p50 101 / p95 151 ms,
  the busiest room (zone 6, 62 monsters) at tick p95 8.8 ms, server ~100%
  of a core with 17 rooms live — the crossings themselves are cheap; the
  ghost bands are what the border rooms carry (up to 228 ghosts in zone
  10).
- Fights at 200 packed bots (`--fight`, everyone engaging the nearest
  monster): ack p50 101 / p95 104 ms, tick p95 12 ms, 65% of a core, 0
  stuck — combat adds nothing visible over walking at this scale.
- The ceiling for a packed room on one core is therefore around 200-250
  clients before ack latency moves; the cost is the per-client patch
  encoding, not the tick. Border crossings and fights at scale: not yet
  measured (the runs were cut short).

## Cross-border combat (2026-09-09)

- The fight runs in the MONSTER's room against the ghost player it mirrors
  (`swingLoop(…, ghost = true)`, the aggro scan and the hunt read
  `bodyOf(pid)` = player or ghost, `hurtBody` sends a ghost's hit home). What
  the home room must show or keep is a `ctl` message: `engage` (target set on
  the ghost; "" clears), `swing` (action/actionSeq/lastCombatAt/dir on the
  real body), `hurt` (the real `hurtPlayer`), `reward` (`grantXp`, split out
  of `killMonster`), `pickup`/`give` (a ghost drop is validated against the
  ghost's mirrored position in the owner room, deleted there, stacked at
  home; a full backpack drops it at the feet). The edge snapshot carries a
  player's no-aggro switch so a neighbour's monsters honour it.
- **A dead ghost may not swing** (its home room knows it died; the mirror
  lags a tick): the first cut let a dead body keep killing across the line.
- Gate: the combat test in `zones.test.ts` — a level-1 body at 12 wu from the
  line engages the weakest monster of a zone-1 area that reaches the border
  (pinned there with `dbgmonster {pin}`; a monster hauled out of its leash
  gives up, and one moved out of its polygon snaps back), is hit back, kills
  it, gets the xp at home and picks the loot from across the line.
- Not carried across the line: the flee slow (`hunted` is built from the
  room's own monsters). A dead body's respawn and the water sanctuary are the
  home room's as before.

## Positions on the wire (2026-09-09)

`shared/src/worldunits.ts`. Every body's position is synced as `px`/`py`:
int16, quarter world units, relative to the room's origin (`state.ox/oy`,
`state.pq` units per wu — 4 in a zone room, 2 in the whole-world room so
394 cells still fit). The server keeps float `x`/`y` and writes the wire
fields before every patch (`broadcastPatch` override — a position set in a
message handler must never reach a client a patch later than the flag set
beside it; the respawn test caught exactly that) and at every creation
point (the join snapshot is taken outside the patch loop). The client reads
`x`/`y` through getters on the schema base class; a decoded object carries
no link to its state, so the client `Decoder` is hooked and every reference
its tracker adds is remembered with its state (WeakMap). One installer
serves the browser (`client/src/net.ts`), the tests (installed by
WorldState.ts, the same library copy colyseus.js decodes with) and the load
bot (inlined). Any map size fits: a zone is 99 cells and ghosts reach 36
past its edge.

**Owner-only fields**: `seq` (the input ack), `slow` and `stamina` change
every tick for every body and mean nothing to anyone but the body's own
client. They carry `OWNER_VIEW_TAG` and reach only the view that added the
player with that tag (`attachView`). This was the larger share.

Measured, 200 bots packed in one room, KB/s per client (means over the run):

| encoding | KB/s per client | server CPU |
|---|---|---|
| float positions, seq to everyone | 38.4 | 75% |
| int16 quarter-unit positions | 32.4 | 69% |
| + owner-only seq/slow/stamina | 17.4 | 66% |

What is left per moving body per patch is framing (the ref id, a field index
per axis) plus 4 bytes of position, so the next lever is the PATCH RATE (a
10 Hz patch would halve it again for 50 ms of ack latency; not taken —
remote motion is eased at rate 12 and the maintainer is sensitive to it) and,
for the many bodies that walk routes (monsters, tap-to-move players), path
replay: send the route once and let clients replay it with periodic
corrections. Not built; a week-class subsystem with its own drift and
correction rules.
