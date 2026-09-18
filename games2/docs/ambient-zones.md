# Zone ambient

Which ambient effects are on WHERE, decided by the server, the same for every
player. The law is in `games2/CLAUDE.md`; this is the measurement and the trap
list. Code: `shared/src/ambientzones.ts` (the resolver, imported by server and
client), `server/src/rooms/WorldRoom.ts` (`refreshAmbientZones`, the "ambient"
message), `client/src/scenes/WorldScene.ts` (`applyAmbient`), the zones
themselves in `maps2/worlds3/<world>/ambient.json` (`maps2/spec/AMBIENT.md`).
Gate: `server/test/ambientzones.test.ts`.

- **The zones are maps2's.** `ambient.json` (pixel-maps3/ambient@1): 84 zones
  for the_game, each a spawns@1 polygon (cell-centre, even-odd), an optional
  `elev` band (caves, the slime pools), and `effects: {name: share 1..100}` —
  how often the effect should be on there. The `world` zone carries the
  always-on effects (foam, water, drips, chimney… at 100); weather is always
  a place. The game reads it with `readWorldDoc` like `spawns.json`; the
  client fetches it beside `places.json`. A world without one keeps the old
  single rolled sky (`DEFAULT_ZONE`, `rollAmbientSet`).
- **THE ROLL IS A FUNCTION OF THE CLOCK.** Every zone rolls once per
  `AMBIENT_HOLD_S` = 600 s window, seeded by (zone id, window index):
  every zone room, a restarted process and a fresh room compute the same
  table for the same second, so nothing is persisted, published or handed
  off — the clock is the sync (maintainer: "in sync with all players on the
  server", "hold an ambient effect active for ~10min"). Windows are phased
  by a hash of the id so the world does not turn all at once: 84 zones →
  a change somewhere every ~7 s, each zone holding 10 min. Not a bus
  document like the clock — a document has an origin and an adopt step, and
  a per-zone table would have needed 84 of them.
- **Shares are hit exactly over time.** A window is an independent draw
  (`rollZoneSet`): each `exclusive` group of the doc (one weather at a time,
  birds/bats, fireflies/pollen) is one lottery with the shares as slices of
  the window and the rest "none" (a group past 100 is normalised); every
  other effect is its own coin; then the matrix (`shared/src/ambient.ts`)
  drops an independent that cannot join a group winner. Measured over 20 000
  windows: gnats 85 → 0.85 ± 0.02, drizzle 25 + rain 12 → 0.37 together,
  never an incompatible pair.
- **The point rule** (`resolveAmbientAt`): for each effect the covering zone
  with the LARGEST share owns it (tie: the smaller zone); on iff on in the
  owner's window; then conflicts (groups, then the matrix) keep the larger
  share. Across overlapping weather provinces this trims the loser: a cell
  under rain 18 and snow 35 + windy 25 snows 35% and rains ~7% (18% × the
  windows with neither snow nor wind). The spec's "shares as weights of one
  draw" holds inside a zone; a per-point draw would need a per-point sync
  and could not be held — rejected.
- **The wire**: `state.ambientZones` = `"id=a,b;id2=;…"` (≈5 KB, resent on
  every turn, ~7 s — a MapSchema of strings would send less but the client
  reads the whole table at once anyway). `state.ambient` is now the room's
  OVERRIDE: `ambientForced` true while a gate or the demo button forced a
  sky on the whole world (the "ambient" {set} message; lapses after
  `EPISODE_S[1]`; `{}` releases at once). A client takes the forced sky,
  else the table at ITS OWN cell (`col,row,round(litLevel)`), re-resolved
  when the table turns or the cell changes — the 84-polygon test runs per
  cell, never per frame.
- **Nothing rolls in on join**: the gloom snaps on the first resolvable sync
  (doc fetched or absent, avatar placed); before that the room's sky stands
  and no chat line is logged. Chat logs only a WEATHER change ("Weather:
  rain,thunder") — walking into a crab zone is not news.
- **`__ml.weather(idx)` pins a LOCAL set** (`ambientPinned`): the table turns
  every few seconds, so the 17 gates that drive the old ring would have had
  their sky overwritten mid-screenshot; `__ml.worldAmbient()` releases the
  pin (a gate that forces the server's sky wants the server's answer).
- **The ambient runtime's side** (games-ambient's `ambient/runtime`): the
  director in zone control applies `env.active` = `__ml.ambientActive()`
  verbatim — every episode named is on, the rest off; fields still self-gate
  on the ground (a share never forces crabs onto grass). Settings "Forced"
  (`__mlAmbient.zoneControl(false)`, games-ui's switch) is untouched: the
  player's own picks, the table ignored.
- Probes: `__ml.ambientZonesInfo()` (the zones under me with their window
  sets and shares, the cell, forced, the resolved set), `__ml.ambientActive()`,
  `__mlAmbient.director()`.
