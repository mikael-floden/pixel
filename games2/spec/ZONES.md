# ZONES.md — one world for 10,000 players

The picture the game agent and the account agent build against (maintainer
2026-09-09: one world, never separate universes; Redis in the loop from day
one so the multi-process code path is the one we test; dead simple, no
Kubernetes). Rules here are present tense; the measurements land in
`games2/docs/backend.md` as they are taken.

## The shape

- **The map is cut into ZONES.** `config/zones.json` names a grid per world
  (`cols` x `rows` over the cell grid; the_game starts at 4 x 4, 99 cells a
  zone). A zone is one Colyseus room (`zone`, matched by `world` + `zone`).
  Rooms are spread over processes; today every room runs in the one process
  we deploy, and nothing in the code knows the difference.
- **Ownership.** Every entity (player, monster, ground item) belongs to
  exactly one room: the zone containing its position. Ids are stable and
  world-unique — a player is keyed by a `pid` minted at first join (its
  `sid` is a synced field, so a client finds itself by `sid === room.sessionId`),
  a monster or drop by `z<zone>:<n>`.
- **Interest.** A client receives only the entities within `INTEREST_WU`
  (32 cells, Chebyshev in world units) of its own player, through a Colyseus
  `StateView` per client; hysteresis at `INTEREST_LEAVE_WU` (36 cells) so a
  body on the rim does not flap. Recomputed every `INTEREST_TICKS` (4) ticks
  from a bucket grid, never per entity per tick. Time, weather, chess boards
  and the spawn-area overlay stay global. A room option `interestRadius`
  (0 = the whole room) exists for tests and QA only.
- **Border ghosts.** A room publishes, at 10 Hz, snapshots of its entities
  within the border band (`INTEREST_LEAVE_WU`) of an edge on the bus channel
  `zone:<world>:<zone>:edge`; each neighbour subscribes and upserts them into
  its own maps as GHOSTS (server-only `ghostOf` = the owner zone; the client
  cannot tell). A ghost is never stepped locally (no sim, no brain, no combat)
  and expires 1 s after its last snapshot. Interest applies to ghosts like
  anything else, so a player near a border sees across it through ONE socket.
- **Hand-off.** When a player's position enters another zone, the home room
  writes the player's hot state (`pos`, `elev`, `dir`, hp/ep/level/xp, `inv`,
  the account id and record, `dirty`, the input `seq`, torch, no-aggro) to
  the bus key `handoff:<world>:<pid>` (10 s TTL) together with a 128-bit
  one-shot KEY minted for this crossing, keeps stepping the player, and sends
  the client `zone:go {zone, pid, key}`. The key, not the pid, is the
  capability: pids are visible to every neighbour, the key reaches only the
  crossing client, a join presents both, the receiving room consumes the
  document on a match and a mismatch is an ordinary join under a fresh id
  (the account agent's contract, 2026-09-09). The client joins the new
  zone room with that key WHILE the old socket stays open; the new room loads
  the hot state from the bus (no database read), places the player, publishes
  `handoff:done:<pid>`; the old room then deletes its entity (the neighbour's
  ghost keeps the body on everyone's screen) and the client drops the old
  room. Avatars keyed by pid survive the swap; `bindRoom` in swap mode
  re-binds existing sprites and removes only what the new view lacks.
  Prediction continues: the new room acks from the handed `seq`.
- **Monsters cross too.** A monster whose position leaves its rect is
  transferred with its full brain state (`monster:xfer`); every room holds the
  whole spawn-zone list but seeds only the cells inside its own rect (`num`
  split by cell share), so a transferred monster's zone rules still resolve.
- **Cross-border combat is forwarded** (phase 2b): an `engage` on a ghost is
  relayed to the owner room, which fights the ghost PLAYER it already holds;
  damage, xp and kills travel back over the bus to the player's home room.
  Until 2b lands, a ghost cannot be hit and does not hit.
- **The world clock is a bus document** (`clock:<world>`: timeIdx, the phase
  deadline as an epoch, timeSpeed, frozen, weather, aurora). Every room
  derives `phaseT` from the deadline and wall clock, so zones agree to the
  millisecond; a change publishes the document.
- **World-wide events go over the bus** (`world:<world>:events`: chat, the
  arrival star, level-ups) and every room broadcasts them to its clients;
  presence (`pid` → name, zone) lives in a bus hash.
- **The bus** is `server/src/bus.ts`: `publish/subscribe/get/set(ttl)/hset`
  on ioredis when `REDIS_URL` is set (a local `redis-server` or Docker in dev,
  Memorystore in prod), else an in-process fake with the same contract, so
  `npm test` and a plain `npm run dev` install nothing. The fake is the
  single-process truth; the real one is what a second process needs.
- **Routing** is a static table in `config/zones.json`: zone → URL path
  prefix. The client joins `serverEndpoint() + route(zone)`. Today every
  route is `""` (same origin). Splitting a zone group out is: one more Cloud
  Run service, one line in the HTTPS load balancer's URL map (`/z/<n>` → that
  service), one line in this table. No matchmaker, no service discovery.

## Phases and gates

1. Interest management in the one room (done first; gate
   `server/test/interest.test.ts`).
2. The bus with its fake (`server/test/bus.test.ts`).
3. Zone rooms, ghosts, hand-off, monster transfer, clock and events on the
   bus, client swap (gate: a walk across a border in one process keeps
   position, hp and inventory, and the neighbour saw the ghost first).
4. The load bot (`scripts/loadbot.mjs`): hundreds of fake clients walking,
   fighting and crossing borders — the players-per-room-per-CPU number.
5. Cross-border combat forwarding.
6. Infrastructure, when the load bot says a room is at its ceiling:
   Memorystore, the load balancer, a second service. The code does not
   change for it; the table does.

## Rejected

- Channels / instances of the world (maintainer: "I was not able to solve it
  in a true MMORPG way").
- A live matchmaker deciding routes (a table is a diff you can read).
- Two client sockets during normal play (ghosts give the view across the
  border through one; the second socket exists only for the seconds of a
  hand-off).
- Saving on a timer (writes are the Firestore bill; save on leave, death,
  level-up and inventory change).
