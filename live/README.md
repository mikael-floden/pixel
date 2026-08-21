# live/ — the game's LIVE-UPDATE channel

Files here are the repo's **runtime state**: the running game server reads
them **straight from GitHub `main`** — no redeploy, no image rebuild. A push
to `live/**` updates the running game within seconds.

## How an update flows (push-based, no polling)

1. Something commits to `live/**` on `main` — an admin save in the wiki (the
   game server itself makes that commit), or an agent's loop.
2. `.github/workflows/live-notify.yml` fires on the push and POSTs
   `https://nangijala.online/api/live/refresh`.
3. The server re-fetches `live/**` from GitHub raw, diffs, and broadcasts the
   new state over the existing Colyseus WebSocket to every connected client
   (`"live:update"`).
4. Clients apply the new tuning immediately. The wiki reads the same state via
   `GET /api/live/state`.

The laws around the flow:

- **Resolution order: live doc ← baked-into-image copy ← builtin defaults**
  (`games2/server/src/tuning.ts` is the only reader; merge rules live there).
  The game must always run fine with an empty/missing override — `live/`
  tunes defaults, it never becomes a hard dependency.
- Admin saves via the wiki skip the notify hop: the server merges the admin's
  per-entry delta onto the file's **current committed content** (GitHub
  contents API, conditional on the blob sha — a racing agent push re-merges,
  never gets reverted), commits, then adopts the result and broadcasts.
- The server loads `live/**` at boot (GitHub first, the copy baked into the
  image as fallback, retrying until GitHub answers) and holds saves/state
  queries (503) until the store is loaded.
- `live/**` is deliberately **excluded from the deploy workflow's trigger
  paths** — changing monster stats or rating a sound never restarts the game.

## Contents

- `live/tuning/monsters.json` — `pixel-wiki-tuning-monsters@1`. Per-monster
  stats (hp, damage, speed, aggro radius, attack cooldown, xp, scale) + loot
  tables. **Consumed by the game** (server + clients, via the live channel).
  Edited in the wiki's monster pages (admin only).
- `live/tuning/constants.json` — `pixel-wiki-tuning-constants@1`. Overrides
  for `games2/shared` gameplay constants, keyed by exported name. **Consumed
  by the game**. Edited in the wiki's Tuning page.
- `live/tuning/sfx_requests.json` — `pixel-wiki-sfx-requests@1`. The Game
  Master's "play this sound on that event" requests, keyed `<event id>/<n>`,
  written from the wiki's Sound Effects page. **Consumed by the composer
  (games-audio) agent**, which wires the assignment and deletes the acted-on
  entry in the same commit — a request is a message, not a record.
- `live/tuning/shadow_notes.json` — `pixel-wiki-shadow-notes@1`. Where the
  Game Master says a monster's **nadir shadow** belonged, one entry per
  `<monster path>#<animation>#<direction>` — the same unit the facet verdicts
  and the regeneration loop use. **Consumed by the games agent as TRAINING
  DATA** (maintainer: it teaches how shadows should be placed, it is not a
  fix-this-one-shadow feature) — NOT an override table, and the game must
  never read it as one: the placement rules derived from the art stay the
  thing that ships. Written from the wiki's monster pages ("✎ Edit nadir
  shadow"), committed with everything else on the save bar. Every entry
  carries BOTH sides of the correction, in **frame
  pixels at scale 1** (the units `monsters.json` speaks):
  - `dx`, `dy` — how far he moved the ellipse's centre off the measurement.
    A DELTA on purpose: a delta generalises, an absolute position only
    describes the one creature.
  - `w`, `h` — the ellipse size he settled on.
  - `was: {w, h, cx, cy}` — what the wiki drew before he touched it, derived
    from that monster's own `shadow` + `artBottom` + `hoverPx`. Without it a
    note becomes unreadable the moment the measurement changes.
  - `frame: {w, h}` — the frame those pixels are measured in, so a note can
    be scaled if the art is ever re-exported at another size.
  - `updated_at`. An entry with no `dx`/`dy`/size change cannot occur:
    clearing a note deletes the entry.
- `live/tuning/base_tiles.json` — `pixel-wiki-base-tiles@1`. **Which tiles are
  a ground type's BASE tiles** (maintainer 2026-08-21: "A base tile is a tile
  that can be repeated over and over again without being annoying ... The
  world-agent will always start to draw with a base tile ... The base tile is
  in the background and does everything but noone notice"). One entry per tile
  key (the review manifest's own key): `{ type: <ground type id>,
  promoted_at }` — the type it is the base OF, because a key names a PAIR and
  the base title is about the pair's walkable TOP. Deleting the entry revokes
  the title. A type may hold one, several, or none — with none, the ground
  paints as its flat colour (`tiles/config/palette.json` `top`). Written from
  the wiki's ground-type pages ("☖ make base tile" / "Revoke base title");
  **consumed by the tiles agent** (which tiles earn variant generation) **and
  the maps/world agent** (what a field is painted with).
- `live/tuning/tile_walls.json` — `pixel-wiki-tile-walls@1`. **Which Tiles
  3.0 tiles may build their own wall.** A tile is generated as "A over B"
  (top A, side walls B); the default is that a tile stacks into a cliff of
  itself, and the Game Master marks the exceptions **top tile only** —
  whatever stacks under those is the pure `B over B` (100%) tile (maintainer
  decision). **Consumed by the tiles agent** and, when 3.0 becomes the
  shipped ground, by whatever paints it.
  - Keyed by the tile, using the review manifest's own key:
    `overrides["tiles/<top>__over__<side>/<n>"] = { top_only: true, updated_at }`.
  - **Per TILE, not per pair** — the wall metrics that decide it (tiling,
    discretion, structure) are measured per tile, so one generation of a pair
    can stack and its neighbour cannot.
  - **Absent means the default** ("builds its own wall"). Setting a tile back
    deletes its entry rather than storing `false`: a file of explicit
    defaults would grow to every tile ever generated and say nothing — and
    the safe direction stays the default one (a wrongly-defaulted tile shows
    a bad wall in the wiki's cliff preview and gets marked; a wrongly
    top-only tile would silently hide a fine tile).
  - It is a PROPERTY, not a verdict — a top-tile-only tile is not worse, it
    has one job — which is why it does not live in `feedback/tiles.json`.
- `live/feedback/<domain>.json` — `pixel-wiki-feedback@1` for monsters,
  characters, tiles, objects, sounds, music, items, lore, composer. Star
  ratings (1-5), approve/reject verdicts and notes per asset id. **Consumed
  by the art agents, not the game**: each agent MUST read its domain file at
  the start of every run and act on it (rejected → remove/replace the asset
  and delete the feedback entry once handled; stars steer style). Written by
  the wiki (admin verdicts) and by agents (clearing handled entries).
- `live/feedback/bindings.json` — same format, but its ids are
  **`<eventId>#<sound>` PAIRS**, not assets: `player.water_enter#splash`,
  `ui.press#composer/ui_tick`. It rates an ATTACHMENT — is this the right
  sound for this moment — and `rejected` means **unbind that sound from that
  event**; the recording stays in the library untouched (maintainer decision:
  unbinding is not deleting). Retiring a recording is the file's own verdict
  in `sounds.json` / `composer.json`. **Consumed by the composer
  (games-audio) agent**, which removes the binding and deletes the handled
  entry.
  - The right-hand side is a SOUND **or a single RECORDING** — an event that
    plays several takes has several bindings, so the id can name the exact
    file: `ui.notify#sounds/ui/notification/notification__take02.wav`,
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
