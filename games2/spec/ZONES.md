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
  the account id and record, `dirty`, the input `seq`, torch, no-aggro, the
  combat counters `actionSeq`/`hitSeq` — the client plays clips on their
  CHANGE, so a body rebuilt from zero replayed its last hit at the border) to
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
- **Cross-border combat runs in the MONSTER's room.** An `engage` on a ghost
  monster is relayed to its owner (`engage` on that zone's `ctl` channel),
  which fights the ghost PLAYER it already mirrors: the ghost swings there,
  the monster hunts and hits the ghost there, and what the player's own room
  must show or keep travels home — `swing` (the clip, the facing, the combat
  clock), `hurt` (the flinch, the slow, the death), `reward` (the xp and the
  ding). Loot lies where the monster died; a `pickup` on a ghost drop is
  relayed the same way and the item comes home as `give`. A monster that
  chases across the line is transferred and the fight continues natively.
  Not carried: the flee slow of a hunt that lives in the other room.
- **The world clock is a bus document** (`clock:<world>`: timeIdx, the phase
  deadline as an epoch, timeSpeed, frozen, weather, aurora). Every room
  derives `phaseT` from the deadline and wall clock, so zones agree to the
  millisecond; a change publishes the document.
- **World-wide events go over the bus** (`world:<world>:events`: chat, the
  arrival star, level-ups) and every room broadcasts them to its clients;
  presence (`pid` → name, zone) lives in a bus hash.
- **Positions on the wire** are int16 quarter world units relative to the
  room's origin (`shared/src/worldunits.ts`): two bytes an axis at any map
  size, since everything a room holds lies within ~5,500 wu of its origin.
  A field only the owner needs (the input ack) is tagged owner-only.
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
5. Cross-border combat (done: the combat test in `zones.test.ts`).
6. Infrastructure, when the load bot says a room is at its ceiling:
   Memorystore, the load balancer, a second service. The code does not
   change for it; the table does.

## One live session, and no twin

A newcomer on an account kicks the older login: in-room first, then world-wide
through the presence hash (`kickOtherSession` → the zone's `ctl`). **A KICK MUST
REJECT A PARKED RECONNECT GRACE**, not merely leave the client. A non-consented
leave parks `onLeave` inside `allowReconnection` with the body still in state —
right for a dropped link — and `kickPid` reaching for `this.clients` came up
empty ACROSS ROOMS, so the `?.` swallowed the kick and the old body stood in the
world (maintainer 2026-09-10: "sometimes when I login I see another version of
myself at the exact same spot I was spawned at"; measured in the browser, two
bodies for ~10 s). Cross-room is the shipped path, not an edge case: a fresh
login joins the world's SPAWN zone and is handed off to wherever it saved, so
the room that kicks is almost never the room holding the body. The room keeps
its parked graces by session id (`reconnects`) and the kick rejects one, which
lands in onLeave's own catch and runs the single removal path there is.
Gate: `server/test/zones.test.ts`, asserted from zone 0's own state well
inside the 45 s grace so a pass cannot come from it expiring.

## Seeing the zones

The **Map tab's layer row** draws the grid over the minimap: a chip per layer
above the map, `zones` first (`client/src/maplayers.ts`). Each rectangle is
one room, projected through the SAME arithmetic as the "you are here" dot
(`minimapCellPct`) so it can never drift from it; the zone you stand in is
filled blue and its red inset is the hand-off band (`INTEREST_LEAVE_WU`),
which is the strip where the neighbouring room mirrors you as a ghost. The
numbers are the ids the server logs and `__ml.zone()` reports.

Maintainer 2026-09-10, asking for it: "In order for me to better understand
the new zone system ... I want at the top of the Map tab to have small buttons
that can be pressed to draw different things on the map. In the future this
will be features like quests, dungeons, party members ... This will draw the
zones/zone boundaries so I more easily will be able to understand if a bug has
to do with this zone boundary or not." Adding a layer is one entry in `LAYERS`
— an id, a label and a draw function handed the projection; the chip row, the
persistence (`ml-map-layers`) and the redraw are generic. Data comes from
`__ml.zones()`, which derives the rectangles from the server's own
`zoneGrid`/`zoneRect` rather than a second copy of the arithmetic.

The **"zone borders" settings switch** draws the same grid IN THE WORLD, for
running around with the map shut (maintainer 2026-09-10: "I might not always
have the map open when running around — so having them on the screen like
spawn areas work would help me a lot"). Two marks, and the split is the point:

- every internal **border** is ONE SHARED LINE running the width of the world,
  in the spawn overlay's own blue ("I wanted the same blue we have for spawn
  zones"). It carries no direction and no tint, because it has none to carry:
  "from one zone this is the end and from the other it is the beginning".
- **my zone's inner boundary** — `INTEREST_LEAVE_WU` in from the border, where
  the neighbour starts mirroring me — is a **CLOSED RECTANGLE** in red, each
  side clipped to the rectangle's own corners, inset only on the sides that
  have a neighbour (the world's rim has no band).

Nothing is painted over the ground and nothing hangs off the lines. Four
things were tried on his screen and all four rejected: the spawn overlay's own
α .05 fill over the whole inside (invisible in red over grass and dark water);
α .14, which "painted the entire inner zone red-ish"; a four-step gradient hem
two cells deep, "an ugly fade" that also landed on the WRONG SIDE of its own
line (anything with WIDTH samples the ground level of the cell it steps into,
so at a cliff it jumps a storey and is drawn above the line); and inward ticks
("what is the perpendicular lines! So confusing!"). Running each side of the
inner boundary across the whole zone, rather than clipping it to the corners,
is what put a four-way cross on the screen near a corner — a rectangle says
inside and outside by being closed. The one-sided fill is the whole signal
  ("the fade only exist in one direction ... so I know if I walk out of this
  zone or into this zone"). A four-step gradient hem and a dashed line were
  both tried and rejected: "I want you to not invent something new here. The
  spawn area border looks fantastic."

The Map tab's `zones` layer uses the same legend — blue rectangle = the room,
red inside = the core, between them = the hand-off band.

The overlay is drawn ON TOP of everything (depth 900_002.4, beside the
collision overlay) and NOT at the spawn overlay's ground depth: a zone edge
runs across the whole world, so terrain between you and it ate the line and the
border stopped at the nearest hill. Lines are sampled per CELL so an edge
climbs a hill with the ground, through `projectZoneCorner` — never
`projectFlat`. It is redrawn on the toggle and on a zone hop (the fill is
one-sided and points into MY zone, so a hop must repaint it); `ml-zone-lines`
persists it, `__ml.zoneLines()` reads and sets it.

Both the row and the overlay are INJECTED into the Map page from outside,
because games-ui owns `hud.ts` — the same pattern the ambient agent's settings
button uses, polled from the scene's update so it survives the HudBar being
rebuilt on a rejoin. Overlay and marks are clipped to the image box: the
render is cropped to the island, so outer zones project off the image and
their lines and numbers would otherwise float over the game view.

## Rejected

- Channels / instances of the world (maintainer: "I was not able to solve it
  in a true MMORPG way").
- A live matchmaker deciding routes (a table is a diff you can read).
- Two client sockets during normal play (ghosts give the view across the
  border through one; the second socket exists only for the seconds of a
  hand-off).
- Saving on a timer (writes are the Firestore bill; save on leave, death,
  level-up and inventory change).
