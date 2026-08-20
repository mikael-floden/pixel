# live/ — the game's LIVE-UPDATE channel

This folder is the repo's **runtime state**: files here are read by the game
server **directly from GitHub `main` while the game is running** — no
redeploy, no image rebuild. Pushing a change to `live/**` updates the running
game within seconds.

## How the update flows (push-based, no polling)

1. Something commits to `live/**` on `main` — the admin saving in the wiki
   (the game server itself makes that commit), or an agent's loop.
2. `.github/workflows/live-notify.yml` fires on the push and POSTs
   `https://nangijala.online/api/live/refresh`.
3. The game server re-fetches `live/**` from GitHub raw, diffs, and
   **broadcasts the new state over the existing Colyseus WebSocket** to every
   connected client (`"live:update"` message).
4. Clients apply the new tuning immediately. The wiki reads the same state
   via `GET /api/live/state`.

Admin saves via the wiki don't need that hop: the server merges the admin's
per-entry delta onto the file's **current committed content** (GitHub
contents API, conditional on the blob sha — a racing agent push re-merges,
never gets reverted), commits, then adopts the result and broadcasts
immediately. The server also loads `live/**` at boot (GitHub first, the copy
baked into the image as fallback, with retries until GitHub answers), and
holds saves/state queries (503) until the store is loaded.

`live/**` is deliberately **excluded from the deploy workflow's trigger
paths** — changing monster stats or rating a sound never restarts the game.

## Contents

- `live/tuning/monsters.json` — `pixel-wiki-tuning-monsters@1`. Per-monster
  stats (hp, damage, speed, aggro radius, attack cooldown, xp, scale) +
  loot tables. **Consumed by the game** (server + clients, via the live
  channel). Edited in the wiki's monster pages (admin only).
  - A per-monster entry may also carry the monster's **one shadow**
    (2026-08-20, replacing the per-facet shadow notes below):
    `shadow: { rx, ry, ax, ay }` in **frame pixels at scale 1** (art px ≈ wu).
    `rx`/`ry` are the ellipse's semi-axes AS SEEN FACING SOUTH; `ax`/`ay` put
    the ellipse's centre relative to the FRAME CENTRE (+x right, +y down).
    One record for every animation and every direction. The game rotates the
    ellipse by the facing's GROUND angle (`shadowScreenEllipse` in
    games2/shared — the same function the wiki previews with), anchors the
    sprite on the ellipse's centre (that centre IS the monster's world
    position, so the art rotates around it on turns), and derives the body
    radius from the size (`shadowBodyRadius` — "the size will be the monsters
    hit box"). **No record = the legacy art-measured anchors, untouched**, so
    the game switches monster by monster as the Game Master tunes. Written
    from the wiki's monster pages ("✎ Edit shadow").
- `live/tuning/constants.json` — `pixel-wiki-tuning-constants@1`. Overrides
  for `games2/shared` gameplay constants, keyed by exported name.
  **Consumed by the game**. Edited in the wiki's Tuning page.
- `live/tuning/sfx_requests.json` — `pixel-wiki-sfx-requests@1`. The Game
  Master's "play this sound on that event" requests, keyed `<event id>/<n>`.
  **Consumed by the composer (games-audio) agent**, which wires the assignment
  and deletes the acted-on entry in the same commit — a request is a message,
  not a record. Written from the wiki's Sound Effects page.
- `live/tuning/shadow_notes.json` — `pixel-wiki-shadow-notes@1`. **FROZEN
  2026-08-20** — the wiki no longer writes it; the per-monster `shadow` field
  in `tuning/monsters.json` above replaced it ("just a single shadow size for
  the entire monster … rotate the shadow around the center using the current
  monster direction"). The entries below remain as the training data they
  were. Historically: where the Game Master said a monster's **nadir shadow**
  belonged, one entry per
  `<monster path>#<animation>#<direction>` — the same unit the facet verdicts
  and the regeneration loop use. **Consumed by the games agent, as TRAINING
  DATA** (maintainer 2026-08-15: "it's not a 'fix this shadow only' feature.
  It's a way to learn how the shadows should be placed"), so it is NOT an
  override table and the game must never read it as one — the placement rules
  it derives from the art stay the thing that ships. Written from the wiki's
  monster pages ("✎ Edit nadir shadow"), committed with everything else on the
  save bar. Every entry carries BOTH sides of the correction, in **frame
  pixels at scale 1** (the units `monsters.json` speaks):
  - `dx`, `dy` — how far he moved the ellipse's centre off the measurement.
    A DELTA on purpose: a delta generalises, an absolute position only
    describes the one creature.
  - `w`, `h` — the ellipse size he settled on.
  - `was: {w, h, cx, cy}` — what the wiki drew before he touched it, derived
    from that monster's own `shadow` + `artBottom` + `hoverPx`. Without it a
    note becomes unreadable the moment the measurement changes.
  - `frame: {w, h}` — the frame those pixels are measured in, so a note can be
    scaled if the art is ever re-exported at another size.
  - `updated_at` — when it was made. An entry with no `dx`/`dy`/size change
    cannot occur: clearing a note deletes the entry.
- `live/tuning/tile_walls.json` — `pixel-wiki-tile-walls@1`. **Which Tiles 3.0
  tiles may build their own wall.** A tile is generated as "A over B" — top A,
  side walls B — and most stack into a cliff of themselves; some do not, and
  the Game Master marks those **top tile only**, meaning whatever stacks under
  them is the pure `B over B` tile (maintainer 2026-08-17: "by default a tile
  should be able to create it's own wall, but I as an admin should be able to
  change the tile to top tile only. A top-tile-only tile should then use the
  100% (x over x) tile for building the wall"). **Consumed by the tiles agent**
  and, when 3.0 becomes the shipped ground, by whatever paints it.
  - Keyed by the tile, using the review manifest's own key:
    `overrides["tiles/<top>__over__<side>/<n>"] = { top_only: true, updated_at }`.
  - **Per TILE, not per pair** — the wall metrics that decide it (tiling,
    discretion, structure) are measured per tile, so one generation of a pair
    can stack and its neighbour cannot.
  - **Absent means the default**, which is "builds its own wall". Setting a
    tile back deletes its entry rather than storing `false`: a file of explicit
    defaults would grow to every tile ever generated and say nothing. That also
    makes the safe direction the default one — a wrongly-defaulted tile shows a
    bad wall in the wiki's cliff preview and gets marked, where a wrongly
    top-only tile would silently hide a tile that was fine.
  - It is a PROPERTY, not a verdict: a top-tile-only tile is not worse, it is a
    tile with one job, which is why it does not live in `feedback/tiles.json`.
- `live/tuning/scenery_lights.json` — `pixel-wiki-scenery-lights@1`. **Which
  scenery states are REALLY lit.** The scenery pipeline names a state `LIT_*` or
  `NOT_LIT_*` (`LIGHTS_ON`/`LIGHTS_OFF` on windows) — but that name records what
  the generator was ASKED for, and the AI that draws it sometimes fails to put
  the light in while the piece comes out good in every other way (maintainer
  2026-08-17: "the AI that generates the image might fail to produce the light,
  but the scenery overall looks great. So I want a way to change the state from
  lit to unlit when doing the review. So we don't have to throw away the art
  just because it's lit state is wrong"). **Consumed by the scenery agent.**
  - Keyed `<piece path>#<state>` — the same unit the facet verdicts use:
    `overrides["scenery/anchors/anchor_001#lit_1"] = { lit: false, was: "lit_1",
    updated_at }`. The state key is lower-cased exactly as the wiki's clip keys
    are; `was` carries the name it was generated under so a correction stays
    readable after the state is re-filed.
  - **Per STATE, not per piece and not per direction.** The scenery domain's own
    rule is "read the state key, not the piece" — `lights` on the piece is
    legacy and null wherever a piece carries both kinds — and the light is a
    property of the sprite, so all of a state's directions share it.
  - **Absent means the state's own name is right**, which is the ordinary case.
    Agreeing with the name again DELETES the entry rather than storing it: this
    file is a list of CORRECTIONS, and one full of agreements would grow to
    every state ever opened and say nothing about any of them.
  - It is a PROPERTY, not a verdict, which is why it is not in
    `feedback/objects.json`: a `LIT_2` that came out dark is not bad art to
    reject, it is unlit art filed under the wrong name. Rejecting it would throw
    away exactly what he asked to keep.
- `live/feedback/<domain>.json` — `pixel-wiki-feedback@1` for monsters,
  characters, tiles, objects, sounds, music, items, lore, composer. Star
  ratings (1-5), approve/reject verdicts and notes per asset id. **Consumed
  by the art agents, not the game**: each agent MUST read its domain file at
  the start of every run and act on it (rejected → remove/replace the asset
  and delete the feedback entry once handled; stars steer style). Written by
  the wiki (admin verdicts) and by agents (clearing handled entries).
- `live/feedback/bindings.json` — the same format, but its ids are
  **`<eventId>#<sound>` PAIRS**, not assets: `player.water_enter#splash`,
  `ui.press#composer/ui_tick`. It rates an ATTACHMENT — is this the right
  sound for this moment — and a `rejected` entry means **unbind that sound
  from that event**. The recording is untouched and stays in the library
  (maintainer 2026-08-06: "if I remove a sound from an event that doesn't
  mean I want to delete the sound … it just means I want to unbind it").
  Retiring a recording is the file's own verdict in `sounds.json` /
  `composer.json`. **Consumed by the composer (games-audio) agent**, which
  removes the binding and deletes the handled entry.
  - The right-hand side is a SOUND **or a single RECORDING** (maintainer
    2026-08-06: "I wanted to unbind `coin_pickup__take02.wav` from Coin
    Pickup, but the unbind is not on the sound itself"). An event that plays
    several takes has several bindings, so the id can name the exact file:
    `ui.notify#sounds/ui/notification/notification__take02.wav`,
    `player.jump@default_girl#composer/foley/jump_voice/jump_voice__take03.wav`.
    Rule of thumb: **contains a `/` or an extension → one recording; a bare
    name or `composer/<set>` → the whole sound.** Unbinding one take leaves
    the event playing the rest; the layer row's "unbind all" still emits the
    old set-level id.

## Rules

- Asset ids in feedback files: repo-relative file path without extension for
  individual files, entity directory path for whole entities
  (`monsters/mammoth`), `<entity>#<state>` for one animation state.
- Agents edit **their own domain's feedback file** only (read-modify-write,
  pull before push — the wiki server merges per-entry, so conflicts are rare
  and rebases are clean).
- Nothing in `live/` is generated at build time — it is durable state. Don't
  regenerate or bulk-rewrite these files.
- The game must always run fine with an empty/missing override — `live/`
  tunes defaults, it never becomes a hard dependency.
