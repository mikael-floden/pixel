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
- **`feedback/tiles` `#top` entries** (2026-08-21): an id of the form
  `<tile key>#top` judges the tile's TOP ALONE, as a once-in-a-while ground
  detail — a second review axis, independent of the pair verdict on the bare
  key. `status: approved` = this top is in the ground's Details collection;
  `rejected` = "not a detail" — **it does not reject the tile**, and the tiles
  agent must NOT treat `#top` entries as generation rejections. A top-approved
  tile's art must be kept even if the pair-tile itself is rejected: "every
  nice tile that didn't make it into the other categories can still have a
  chance". These are the Game Master's picks for the future detailed-variant
  pass.
- `live/tuning/base_tiles.json` — `pixel-wiki-base-tiles@1`. **Which tiles are
  a ground type's BASE tiles, in GROUPS** (maintainer 2026-08-21: "A base tile
  is a tile that can be repeated over and over again without being annoying ...
  A base tile group is a set of tiles that togather make tileing/seems
  dissapears. They are often very very close to eachother ... The world-agent
  will always start to draw with a base tile"). One entry per tile key (the
  review manifest's own key):
  `{ type: <ground type id>, group: "g1", weight: 1, promoted_at }`
  - `type` — the ground the tile is a base OF (a key names a PAIR; the base
    title is about the pair's walkable TOP).
  - `group` — the base-tile group, scoped to the type (`g1`, `g2`, …). A field
    is painted from ONE group's members, never mixed across groups.
  - `weight` — how often this tile spawns vs its group-mates (2 appears twice
    as often as 1). The wiki's composites roll with the same weights.
  Deleting the entry revokes the title; a group with no members is gone. A
  type may hold several groups or none — with none, the ground paints as its
  flat colour (`tiles/config/palette.json` `top`). Written from the wiki's
  ground-type pages (the promote modal + the Base tiles tab); **consumed by
  the tiles agent** (which tiles earn variant generation) **and the maps/world
  agent** (what a field is painted with — pick a group, then roll members by
  weight).
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
- `live/tuning/tile_tops.json` — `pixel-wiki-tile-tops@1`. **Which Tiles 3.0
  tiles always keep their own top.** The base-tile-set model swaps an
  x-over-y tile's top for the ground's configured surface — the clean colour
  or the chosen set member; a tile the Game Master marks **own top** is
  exempt and always draws the texture it was generated with, at **higher
  priority than the set composition** (maintainer 2026-08-27: *"Some on top
  of-tiles have graphics that looks very very good with its own top texture.
  Replacing with the base tile sets top doesn't transition as nicely toward
  the wall."*). **Consumed by whatever composes ground tops** — the wiki
  today, the game when it adopts the set model.
  - Keyed like tile_walls, by the review manifest's own key:
    `overrides["tiles/<cell>/<key8>"] = { own_top: true, updated_at }`.
  - **Absent means the default** (the ground's configured surface). Setting a
    tile back deletes its entry — the file only ever names the exceptions.
- `live/tuning/top_walls.json` — `pixel-wiki-top-walls@1`. **Which x-over-x
  tile builds the wall under a borrowed-wall top** (maintainer 2026-08-28:
  *"you should not just pick 'the first' x over x - you should pick the BEST
  ... closest in color/tune and structure"*). The wiki picks the measured
  closest match automatically (mean top-face RGB + dominant share + colour
  count, published in `wiki/site/data.json` `wallPools` and per-candidate
  `tm/tflat/tk`); an entry here is the Game Master's per-face override from
  the wall stepper. **Consumed by whatever composes ground tops** — the wiki
  today, the game when it borrows walls.
  - `overrides["<face key>"] = { wall: "tiles/<g>__over__<g>/<key8>", updated_at }`
    — the face key is a tops id (`tiles/tops/...webp`) or an x-over-y
    candidate key.
  - **Absent means the measured best**; stepping onto the measured best
    deletes the entry — the file only ever names his exceptions.
- `live/tuning/scenery_hitbox.json` — `pixel-wiki-scenery-hitbox@1`. **The
  ground a scenery piece occupies.** One or more ellipses per piece, in FRAME
  PIXELS with the origin at the frame's centre — the same quantity and units
  as a monster's nadir shadow, so a consumer that already resolves those needs
  no new arithmetic. **It is not a shadow and is never drawn** (maintainer
  2026-08-27: *"This scenery nadir 'shadow' is also not a shadow. This is just
  a hitbox and a way for the game to change rendering order."*). Each
  ellipse's centre line decides draw order: a player **above** it is drawn
  behind that part of the piece, **below** it in front.
  - **`no_collision`** (2026-08-29, maintainer: *"mark an object as no
    collision/collision less — this can be a carpet or something else flat on
    the floor"*). The **scenery domain owns the fact** and tags it in its own
    metadata; a piece-level `{ boxes: [], no_collision: <bool> }` here is his
    CORRECTION of that tag, and agreeing with it deletes the entry. It means
    the player **walks over** the piece — distinct from a plain `boxes: []`
    (hung on a wall, walked *past*) and from an absent record (undecided).
  - **Keyed per VARIATION** (2026-08-29, maintainer: *"different variations
    can be different size"*): `overrides["<path>#<state>"]`, e.g.
    `scenery/anchors/anchor_001#not_lit_2`. A record under the bare path is an
    older piece-level decision and still answers for a variation that has none
    of its own. `auto: true` marks the wiki's alpha-placed proposal, measured
    from that variation's own art — provisional for the game, and still "no
    hitbox yet" in the review until he accepts or edits it.
  - `overrides["scenery/<category>/<piece>"] = { boxes: [{ax, ay, rx, ry,
    rot, shape?}], updated_at }`. `rot` is degrees, 0–179 (both shapes are
    symmetric under a half turn).
  - **`shape`: `"rect"` / `"ellipse"`, absent = the piece's own tag** (2026-08-30, maintainer:
    *"town and indoor often have hitboxes that needs a rect and not an ellipse.
    Take a table or bookshelf … will make it possible for me to do a perfect
    hitbox on a bookshelf, bed, etc and the map-agent can then make use of the
    'perfect hitbox' to be able to place the furniture in a corner or against
    the wall"*). **Per BOX, not per piece** — an L-shaped counter is two rects,
    a well is a rect base with a round rim. `ax/ay/rx/ry/rot` mean exactly what
    they mean for an ellipse: same centre, same half-axes (so a rect is
    `2·rx` × `2·ry`), same rotation.
    - **RESOLUTION, for every consumer: `box.shape` ?? the piece's
      `hitbox_shape` ?? `"ellipse"`.** The scenery domain publishes
      `hitbox_shape` per piece in its own `scenery.json` (2026-09-02: 131
      rect, 576 ellipse) — the domain states the fact, a bookshelf being boxy
      whoever looks at it — and an entry here is the maintainer's CORRECTION
      of it, the same two-level arrangement as `no_collision`. Agreeing with
      the tag deletes the entry, so this file only ever names exceptions and
      the 3,673 records written before the field existed stay byte-identical.
    - Both spellings are therefore meaningful: `"ellipse"` on a rect-tagged
      bookshelf is a real correction, not a default written out. **Absent does
      NOT mean ellipse** — ask the piece.
    - **A RECT IS A GROUND RECTANGLE, DRAWN IN PERSPECTIVE** (2026-09-03,
      maintainer, with a drawing of a chest facing SE: *"the 3D perspective
      requires the shape to be a bit different … I want the hitbox to
      transform into this perspective so it can capture the furniture's
      contour"*). For a rect, `rot` and `rot_by_dir` are **ground degrees**,
      `rx` is the ground half-width and `ry/k` the ground half-depth
      (`k = dy/dx`). Corners: rotate `(±rx, ±ry/k)` by the ground angle, then
      project `(x, y) → (x, k·y)`. Facing south and unturned that is exactly
      the screen rectangle `rx × ry` every record already stores; on a facing
      it is a **parallelogram** whose edges follow the two ground axes
      (down-right and up-right at `atan(k)` = 25.1° today) — what a box on the
      ground actually looks like. A consumer that keeps drawing a rotated
      screen rectangle will miss the drawer front and the side at once.
    - **The facing's turn is 45° on the ground**, derived: `angle(dir) =
      rot_by_dir[dir] ?? rot − ground(dir)` with `ground(south-east) = 45`,
      `ground(south-west) = −45` (…east 90, west −90, north 180) — the sign
      as measured 2026-09-02. Nothing is stored for the derived case.
    - *(Superseded 2026-09-03 — kept one line so nobody re-implements it: the
      earlier rule rotated a SCREEN rectangle by `−atan2(k·sinθ, cosθ)`,
      25.1°; it could not match the perspective.)*
    - **A rect TURNS WITH THE FACING, and the turn is derived** (2026-09-02,
      maintainer: *"The default hitbox for objects that is rect should rotate
      with SE, SW the same amount the object rotates (same as we do for
      monsters) … we only have one width and height. The rotation should be
      pre-adjusted"*). `rot` is the **south** angle. For any other facing a
      rect is drawn at `rot + tilt(dir)`, where a ground turn of θ (45° per
      compass step) projects to `−atan2(k·sinθ, cosθ)` with `k = dy/dx` —
      **−25.1° for south-east today, +25.1° for south-west, not ±45°**, because
      the ground is squashed. The **sign is negative**, corrected 2026-09-02
      after shipping it mirrored: it had been read off the silhouette's bottom
      edge, which on a turned box is the front face nearest the camera and runs
      roughly PERPENDICULAR to the footprint's long axis. Nothing
      is stored for this: the tilt is arithmetic every consumer can do, from
      the same iso block the game already uses for a monster's shadow.
      Ellipses are left alone — a footprint with no corners reads the same
      turned.
    - **`rot_by_dir`: `{ "<dir>": deg }`, his correction for ONE facing.** The
      art is not always turned the way the compass says (across 14 rect pieces
      most mirror cleanly, a few do not), so
      aligning a bookshelf on south-east must not drag south and south-west
      out of true. Present only for facings he has aligned by hand; every
      other facing is the derived tilt. Resolution: `rot_by_dir[dir]` ??
      `rot + tilt(dir)` for a rect, `rot` for an ellipse.
    - **A consumer that ignores `shape` gets the inscribed ellipse of the
      rect** — smaller than the truth at the corners, the safe direction to be
      wrong while the game catches up, but the corner fit is exactly what the
      furniture was drawn for, so consumers should read it.
  - **Stored in SCREEN space, unlike a monster's.** A monster's `rx`/`ry` are
    ground-space, tuned facing south, and the game unsquashes, rotates and
    re-squashes them per facing. Scenery never turns, and the Game Master fits
    the ellipse to the art by eye — so what he draws is what is stored. A
    consumer wanting the **ground** footprint divides `ry` by the iso ratio
    (`dy/dx`, 15/32 today); the editor's default starts at a ground circle for
    exactly that reason. Named explicitly because a space nobody writes down
    is what two agents each assume differently and neither finds out.
  - **Several are normal** — *"the Scenery might have two collisions and not
    just one … an entrance with two pillars touching the ground"*.
  - **Three states, and the difference matters.** No entry = nobody has
    decided; `boxes: []` = decided, this piece needs none; `boxes: [...]` =
    the footprint. Written by the wiki's Scenery pages, consumed by the game
    for collision and draw order.
  - **Wall scenery never appears here at all** (maintainer 2026-08-28:
    *"Everything that is placed on a wall doesn't have a hitbox"*). Pieces of
    type `WINDOW` or `MOUNTAIN_WALL` — 134 of 715 — are no-hitbox **by
    type**, decided by the scenery agent's classification, not by review. A
    consumer must treat those types as hitbox-less without looking in this
    file, and must not read their absence here as "undecided".
- `live/tuning/scenery_walls.json` — `pixel-wiki-scenery-walls@1`. **The Game
  Master's corrections to which pieces are wall scenery** (maintainer
  2026-08-28: *"you have tagged some scenery as wall scenery that is not wall
  scenery and I can also find scenery that IS wall scenery, but you think
  it's not"*). Wall scenery hangs on a house/mountain/cave wall: no hitbox,
  never y-sorted against the player. The agent's own tag is the piece `type`
  (`MOUNTAIN_WALL` and `WINDOW` read as wall); an entry here overrides it.
  - `overrides["scenery/<category>/<piece>"] = { wall: true|false, was:
    "<the type the tag said>", updated_at }`. **Absent means the tag is
    right** — agreeing with the tag deletes the entry.
  - **Consumed by the scenery agent**, which re-files the piece's type and
    deletes the entry — the same contract as `scenery_lights`.
- `live/feedback/<domain>.json` — `pixel-wiki-feedback@1` for monsters,
  characters, tiles, objects, sounds, music, items, lore, composer. Star
  ratings (1-5), approve/reject verdicts and notes per asset id. **Consumed
  by the art agents, not the game**: each agent MUST read its domain file at
  the start of every run and act on it (rejected → remove/replace the asset
  and delete the feedback entry once handled; stars steer style). Written by
  the wiki (admin verdicts) and by agents (clearing handled entries).
  - **`status: "redo"` — scenery only, piece level** (2026-09-03, maintainer:
    *"I will go over all scenery and delete everything that is not good
    enough. But sometimes I might think the object is so good we should try
    to generate another variant/version"*). KEEP the piece and generate
    another variant of it. Distinct from `rejected` (= remove the piece) and
    from a per-state `rejected` under `<path>#<state>#<dir>` (= regenerate
    that one state). Any other domain still knows only approved / rejected.
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
