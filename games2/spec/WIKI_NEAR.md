# "What am I standing next to?" — the game ↔ wiki NEAR contract

Maintainer 2026-09-02: *"To the left of the Wiki in-game button will be a
square search icon that will also take you to the wiki, but will go directly
to the search with the results sorted by how far away they are from the
player. This is a way to fast find what you stand next to."*

Both halves shipped 2026-09-02 (game: `wikinear.ts` + `__ml.nearby()`; wiki:
`viewNear` in `wiki/site/wiki.js`, gate `wiki/tools/check-near.mjs`). Two agents
build this. The **games-ui** agent owns the button, the snapshot
of what surrounds the player, and the messaging (`client/src/wikinear.ts`).
The **wiki** agent owns the page that shows it. This file is the seam; change
it in the same commit as either side.

## The flow

1. The player taps the square 🔍 button (stacked left of the Wiki button).
2. The drawer opens on **`#/near`** — a new wiki route — with the game loop
   frozen behind it (`gamefreeze.ts`), so the snapshot is exactly what the
   player sees and it cannot go stale while they read.
3. The moment the iframe fires `load`, the game posts **one** `wiki:near`
   message (below). The wiki renders it as search results sorted by
   distance, nearest first.
4. The wiki may ask again at any time with `wiki:wantNear` — on a hash route
   to `#/near` reached by navigation rather than by the button, on a reload,
   or whenever it wants a fresh list. The game answers every request while
   the drawer is open. Both directions are `postMessage` with
   `location.origin` as the target and `e.origin === location.origin` +
   `e.source === frame.contentWindow` checks, the same shape as the existing
   `wiki:menu` / `wiki:muteGame` / `wiki:closeMenu` traffic.

## The message: game → wiki

```jsonc
{
  "type": "wiki:near",
  "world": "the_island2",          // the maps2 world id
  "at": { "col": 13.75, "row": 11.4 }, // the player, fractional cells
  "radius": 12,                    // cells searched for bodies and pieces
  "items": [                       // SORTED ascending by dist, nearest first
    { "domain": "tiles",      "id": "saturated_grass", "dist": 0,   "n": 41,
      "path": "tiles2/saturated_grass/base/base_246233070/tile_00.webp" },
    { "domain": "characters", "id": "05e26d78",        "dist": 1.3, "n": 1 },
    { "domain": "objects",    "id": "lantern_post_002","dist": 2.1, "n": 1 },
    { "domain": "items",      "id": "leather_scrap",   "dist": 3.7, "n": 2 },
    { "domain": "monsters",   "id": "forest_poring",   "dist": 5.9, "n": 3 }
  ]
}
```

- `domain` is the wiki's own domain key in `data.json` (`monsters`,
  `characters`, `items`, `objects`, `tiles`, `world`) and `id` is that
  domain's `id` — the pair is exactly the wiki's route `#/<domain>/<id>`.
  Nothing is invented on the game side: a monster's `id` is its roster id
  (`mv.kind`), an NPC's is its characters2 folder key (`charId`), a drop's
  is its item id, a scenery placement's is its bare piece id (the last
  segment of `category/piece` — unique across categories), and the GROUND
  is the cell's material under one of two domains: a Tiles 2.0 world's
  materials are `tiles` pages (`saturated_grass`), a Tiles 3.0 world's
  ground TYPES (`the_game` and every maps3 world: `grass`,
  `brown_paving_stone`, …) are `world` pages — `#/world/<type>`, the
  ground-type view. The wiki should still tolerate an id it does not know
  (a fresh roster entry the wiki has not rebuilt for yet) by showing the id
  plainly.
- **One row per (domain, id)**, at the NEAREST instance's distance, with
  `n` = how many are within the radius. Three dewlings are one row, not
  three.
- `dist` is the flat world distance in **cells** (world units ÷ 32), two
  decimals. `0` means "under your feet".
- `path` appears on ground rows when the world names a tile file per cell
  (Tiles 2.0): the exact tile drawn under the nearest instance, so the wiki
  can deep-link `#/tiles/<id>/<instance>` if it wants to; the material page
  alone is fine. Tiles 3.0 worlds resolve art at draw time and send none.
- The list is capped at 80 rows after sorting. Other PLAYERS are not
  included — they have no wiki page.
- `items` may be **empty** (a swim far from anything). The wiki should say
  so rather than show a blank page.

## `heard` — what the player is hearing (added 2026-09-02)

Maintainer: *"Does the #/near also contain music playing right now and sound
effects triggered the last 30s (filtered on how recently the sound effect was
played)?"* — one more field on the same message:

```jsonc
"heard": {
  "music": { "id": "nangijala_cherry_valley", "kind": "track",   // or "bed" / "title"
             "section": "A", "position": 42.1 },                 // null when silent
  "sfx": [                                                       // MOST RECENT FIRST, ≤ 30 s, ≤ 40 rows
    { "event": "combat.kick",  "sound": null,            "ago": 1.2, "at": 812345.6 },
    { "event": "player.jump",  "sound": "composer/jump_voice", "ago": 4.0, "at": 809512.0 },
    { "event": null,           "sound": "footstep_grass", "ago": 4.3, "at": 809201.3 }
  ]
}
```

- **`music.kind`**: `track` — a catalog track, `id` is the wiki's `music`
  domain id (`#/music`); `bed` — a context bed (`night`, `cave`, `home`,
  `town`, `adventure`, `battle`, …), the Dynamic tab; `title` — the select
  screen's theme. `section` is the score's current section name or null,
  `position` seconds into it. `null` when nothing plays (music off, or muted
  by the wiki's own mute button).
- **`sfx`**: every event the engine was ASKED to play in the window, newest
  first. `event` is the game's semantic id exactly as the wiki's `sfx.events`
  spells it (`item.drop`, `combat.kick`, `player.jump`, `ui.press`…), or null
  for a sound the composer played on its own (footsteps, flourishes).
  `sound` is what actually started — a catalog id from the `sounds` domain, or
  a composer take `composer/<set>` — or **null when the event is unassigned
  and played nothing**. The null is deliberate: an emitted-but-silent event is
  exactly what the Game Master would want to assign a sound to, and here it is
  with a timestamp. `ago` is seconds before the snapshot (one decimal), `at`
  the `performance.now()` it fired. The loop is frozen behind the drawer, so
  "4 s ago" stays true while he reads.
- Not recorded: events emitted while the engine is not ready (no AudioContext
  yet, sound switched off) — nothing was heard.
- Source: `gameAudio.heard()` (composer, `engine/api.ts`), the same ledger
  `__ml.audio().heard` shows. Probe for the whole message: `__mlNear.snapshot()`.

## The message: wiki → game

```jsonc
{ "type": "wiki:wantNear" }
```

Answered with a fresh `wiki:near` if the drawer is open over the world.
Opened from the **select screen** there is no world: the game answers with
`"items": []` and `"world": null`, and the wiki should say that this page
works from inside the game.

## What the wiki page should do (the ask, not the design)

- Route `#/near`. Render the rows as the search grid already does (card,
  thumbnail, name, domain label), nearest first, each carrying its distance
  ("under you", "2 cells", "11 cells") — the maintainer's words are "the
  search with the results sorted by how far away they are".
- Tapping a card goes to that page, exactly like a search hit. The drawer's
  spot store then remembers where the player went; reopening the Wiki
  button returns there, and the 🔍 button always starts a fresh `#/near`.
- Nothing about the existing search box changes.
