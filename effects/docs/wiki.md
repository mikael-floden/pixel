# Effects in the wiki — the contract

For the wiki agent. The maintainer reviews effects the way he reviews every
domain: he watches one, rates it, approves / rejects / asks for a redo, and
tunes it. The effects domain ships a finished review surface for the LOOK
(the viewer); the wiki owns the section, the verdicts and the save.

## What there is to show

- **The catalog** `effects/effects.json` (`nangijala-effects-catalog@1`,
  generated, stable name, rebuilt every unit): `families` (label + colour per
  element), `count`, and per effect `id`, `key` (the feedback/tuning key,
  `effects/library/<id>`), `file`, `name`, `kind` + `kindLabel`, `family`,
  `category`, `tags`, `thinking` (why it looks like this — show it), `levels`
  (what 1 to 10 changes — show it), `speed` (projectiles), `events`,
  `sustained`, `planes`, `light`, `layers`, and `tune` — the tunables schema
  (`type` color | range | bool | select, `def`, `min`, `max`, `step`, `label`).
  Read it with `fetch`; it is plain JSON, fine from raw.githubusercontent.
- **The viewer** `effects/viewer/index.html`: the stage (the game's iso floor,
  the real hero and a werewolf at game scale, a night that works like the
  game's, the effect's own light on the floor), a level slider 1-10, replay /
  loop / slow-motion, a tap on the floor moves the target, the tunables as
  sliders, colour pickers and switches, the house-style panel, and the
  effect's notes. It is ES modules, so it must be SERVED with JS MIME types:
  `/assets/effects/viewer/` once games ships the domain (raw.githubusercontent
  answers text/plain and a module will not load from it).

## Embedding

`<iframe src="/assets/effects/viewer/index.html?embed=1&id=fire/fireball&level=5">`

`?embed=1` hides the viewer's own header (the wiki draws the chrome); `id` and
`level` deep-link. It speaks `postMessage` (JSON objects, `type` first):

| direction | message | meaning |
|---|---|---|
| viewer -> wiki | `{ type: "effects:ready", ids }` | booted; the library it has |
| viewer -> wiki | `{ type: "effects:selected", id, key, level }` | he picked another effect in the viewer |
| viewer -> wiki | `{ type: "effects:tune", id, key, values, defaults }` | a tunable changed: `values` = everything that differs from the default now (empty = back to defaults) |
| wiki -> viewer | `{ type: "effects:open", id, level? }` | show this effect |
| wiki -> viewer | `{ type: "effects:tuning", table }` | the live `overrides` table: it becomes what the sliders start from |

## The files (the wiki writes them, the effects agent and the game read them)

- **Verdicts** `live/feedback/effects.json` — `pixel-wiki-feedback@1`, domain
  `effects`, `entries` keyed by the catalog `key`
  (`effects/library/fire/fireball`) with the usual `status` (approved |
  rejected | redo), `rating`, `note`, `updated_at`. One entry per EFFECT (the
  level is the effect's own range, not a facet). The effects agent reads it
  every run (`live/docs/review-contract.md`).
- **Tuning** `live/tuning/effects.json` — `pixel-wiki-tuning-effects@1`:
  `{ format, updated_at, overrides: { "<key>": { <tunable>: value, ..., was: {...}, updated_at } } }`,
  the scenery-lighting shape. A save writes the `values` of the last
  `effects:tune` for that key and `was` = the `defaults` it replaced; values
  equal to the default are dropped; an empty entry is deleted (absent means
  default). The game applies the table live (`fx.setTuning`), so a save is
  what the game looks like a few seconds later.

Both need the game server's allowlists (`LIVE_FILES`, `FEEDBACK_DOMAINS` in
`games2/server/src/live.ts`) — asked of games on the effects board.

## The section

An **Effects** section (route `#/effects`) listed from the catalog: filter
chips by family (its colour from `families`), cards with the name, kind and
family, the verdict state. An effect page: the viewer iframe (sticky on a
phone), the verdict bar the other sections use, `thinking` and `levels` as
text (also inside the viewer), and the save bar picking up `effects:tune`.
The player-facing wiki can list the same pages without the verdict and tune
controls once effects are in the game.
