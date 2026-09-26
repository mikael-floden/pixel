# Shaders in the wiki — the contract

For the wiki agent. The maintainer's **Shaders** page (under Items) reviews
effects rendered exactly as the game renders them. The shaders domain ships
the STAGE that renders them — the viewer, embedded; the wiki owns the page,
the verdicts, the saves and the sound bindings. (The effects are GLSL and the
wiki draws on 2D canvases, so the rendering cannot be the wiki's: the stage
runs the game's own rules and the wiki drives it over postMessage.)

## What the stage renders — his list, item by item

| He asked for | The stage |
|---|---|
| render like the game | the game's iso projection (32/14 px, 32 wu a cell); bodies at game scale, pinned at the game's foot anchor (`anchorlib footAnchor`); the game's light (below) |
| a player and/or a monster | each effect's `stage` recipe: a caster and/or a target. A status (burning, poisoned, stunned) shows only its monster; a monster attack (claw swipe, ground slam, acid spit) is cast BY a monster AT the hero; a chain gets two extra victims |
| tiles under the player, next/prev ground type | the WIKI's floor plan (`shaders:ground`, from its ‹ › stepper): the ground's highest-weight base set, one member per cell drawn by weight — the wiki makes every choice the game makes, the stage paints the plan on the game's lattice (64x28 diamonds on the 14 px pitch, apex on the tile's top opaque row). Before the first plan it draws a procedural grass |
| per-effect tunables | the tune panel: sliders, colour pickers, checkboxes, selects from each effect's `tune` schema |
| power level 1-10 | the level slider |
| light rendered like the game (colour and reach) | the game's reserved slots: the hero's torch, ONE self-cast effect light, ONE monster one (`lightslots.ts`), each with `nightlight.ts`'s falloff — `(1 - d/r)^2` over cells, 0.6 per level of height, flicker, ember rim, capped at 1.25 and multiplied into the world; emissive layers are never darkened |
| a time-of-day slider | 0-4: 0.5 night, 1.5 morning, 2.5 day, 3.5 evening, blended between like the game (`WorldScene blendPhases`); the torch fades out by day like the game's |
| the wand / channel animation, in sync | the caster plays its real clip (`characters2/animation_map.json` states) and the spell leaves on the clip's KEY frame, from the wand tip / orb / arrow measured on that frame for each hero and facing |
| a special setup (smoke, blood) | the recipe has room for one; nothing in the library needs it yet |
| sounds on creation(s), channel, impact(s) | each effect's `sounds` slots with the game event names; the stage reports every moment as it fires (`shaders:event`) and the whole schedule up front (`shaders:timeline`), and draws that timeline under the stage |
| several projectiles in formation | `count` (1-6 here, 12 in the game) + `formation`: every copy fires its own release and impact with its index |

## Embedding

```html
<iframe src="/assets/shaders/viewer/index.html?embed=1&id=fire/fireball&level=5&tod=0.5&hero=default_boy&monster=diablo&count=3&formation=fan&torch=1"></iframe>
```

- It must be SERVED by the game (ES modules need JS MIME types;
  raw.githubusercontent answers text/plain): `/assets/shaders/...` 404s until
  `ASSET_DOMAINS` (`games2/server/src/index.ts`, `games2/client/vite.config.ts`)
  includes `shaders` — asked of games on the shaders board.
- **Same origin only.** The stage posts to `location.origin` and takes
  messages only from `window.parent` on the same origin.
- **Every stage setting is a URL parameter**, so an iframe that `#content`'s
  re-render reloads comes back as it was: keep the last `shaders:state` and
  write it into the `src`.

| param | values |
|---|---|
| `embed` | present: the stage hides its own header (the wiki draws the chrome) |
| `id` | an effect id (`fire/fireball`) |
| `level` | 1-10 |
| `tod` | 0-4 time of day (0.5 night, 1.5 morning, 2.5 day, 3.5 evening) |
| `torch` | 1 / 0 — the hero's torch |
| `hero` | `default_boy` / `default_girl` |
| `monster` (or `target`) | a monster that ships in the image — the list is `shaders/viewer/bodies.js`; the default is Palehusk (maintainer: "Instead of Werewolf as default please use Palehusk") |
| `count`, `formation` | a volley (effects whose `volley` is not null) |
| `speed` | 1 / 0.5 / 0.25 |
| `loop` | 1 / 0 |

Messages (JSON objects, `type` first):

| direction | message | meaning |
|---|---|---|
| stage -> wiki | `{ type: "shaders:ready", ids, state }` | booted; the library it has, the stage it shows |
| stage -> wiki | `{ type: "shaders:state", state }` | a stage setting changed: `{ id, level, tod, torch, hero, monster, count, formation, speed, loop }` — keep it for the iframe `src` |
| stage -> wiki | `{ type: "shaders:selected", id, key, level, version }` | he picked another effect inside the stage |
| stage -> wiki | `{ type: "shaders:tune", id, key, values, defaults }` | a tunable changed: `values` = everything that differs from the default now (empty = back to defaults) |
| stage -> wiki | `{ type: "shaders:timeline", id, key, events, sounds }` | every play: the whole schedule (`events`: `{ event, index, t }`, t in s from the cast) and the effect's sound slots |
| stage -> wiki | `{ type: "shaders:event", id, key, event, index, t, slots }` | as each moment fires; `slots` = the sounds to play NOW (`{ slot, loop, sound_event }`); `event: "channel-end"` = stop a channel bed |
| wiki -> stage | `{ type: "shaders:open", id, level?, ...state }` | show this effect (with any stage settings) |
| wiki -> stage | `{ type: "shaders:set", state }` | change stage settings (any subset of the `state` keys) |
| wiki -> stage | `{ type: "shaders:time", u }` | time of day on the game's clock (0-4); `{ t }` (0-1 of the cycle) also works |
| wiki -> stage | `{ type: "shaders:ground", ground, name, set, tiles: [{ id, url, weight, share }], grid: { cols, rows, cells } }` | the floor plan (the wiki's spec): cell (c, r) draws `tiles[cells[(r mod rows) * cols + (c mod cols)]]` |
| stage -> wiki | `{ type: "shaders:ground-painted", ground, set }` | the plan's tiles loaded and the floor is repainted |
| wiki -> stage | `{ type: "shaders:tuning", table }` | the live `overrides` table: it becomes what the sliders start from |

## Sound binding

- Each effect's `sounds` (catalog) lists its slots in the order they happen:
  `{ slot, event, label, each, loop?, sound_event }`. `sound_event` is the
  game's audio event, `shaders.<family>-<name>.<slot>` — three dot-separated
  parts like `monsters.<kind>.<action>` (the id's `/` becomes `-`).
- Slots by kind: a projectile has `cast` (the gather, when it has one),
  `release` (creation — per copy of a volley) and `impact` (per copy); a
  melee `release` (the swing) and `hit`; a chain `release` and `hop` (per
  victim); a burst `peak` (per copy), plus `release` when its peak comes
  0.15 s or more after it starts (a meteor's fall, a heal's gather); a
  sustained effect `release` (onset), `channel` (a LOOP from the release to
  the stop) and `stop` (the fade).
- Preview: on `shaders:event`, play what is bound to each `slots[].sound_event`;
  a `loop` slot plays from its `release` until the `channel-end` event.
- Binding: the wiki's sound picker writing `live/tuning/sfx_requests.json`
  with `event` = the slot's `sound_event` is the whole path — the composer
  agent wires requests into the game. A channel slot needs LOOP playback,
  which neither the wiki's `sfxEngine` nor the composer engine has yet
  (asked of games-audio on the shaders board).

## The files (the wiki writes them, the shader agent and the game read them)

- **Verdicts** `live/feedback/shaders.json` — `pixel-wiki-feedback@1`, domain
  `shaders`, `entries` keyed by the catalog `key`
  (`shaders/library/fire/fireball`) with the usual `status` (approved |
  rejected | redo), `rating`, `note`, `updated_at`, and **stamped with the
  catalog `version`**: it changes whenever the effect's code, a shared
  snippet it uses or the GLSL prelude changes, so a stamp that differs means
  "changed — judge again". One entry per EFFECT (the level is the effect's
  own range, not a facet). The shader agent reads it every run.
- **Tuning** `live/tuning/shaders.json` — `pixel-wiki-tuning-shaders@1`:
  `{ format, updated_at, overrides: { "<key>": { <tunable>: value, ..., was: {...}, updated_at } } }`,
  the scenery-lighting shape. A save writes the `values` of the last
  `shaders:tune` for that key and `was` = the `defaults` it replaced; values
  equal to the default are dropped; an empty entry is deleted (absent means
  default). READ IT BACK before saving (`loadLiveFiles`): the server replaces a
  whole entry per key. The game applies the table live (`fx.setTuning`).

## The catalog

`shaders/shaders.json` (`nangijala-shaders-catalog@1`, generated, rebuilt
every unit). Top level: `families` (label + colour per element),
`cast_anims` (clip -> frames, fps, key frame), `formations` (label + what it
does), `cast_points` (the measured wand tips), `runtime`, `showcase`,
`viewer`, `count`, `effects`. Per effect: `id`, `key` (the feedback/tuning
key), `file`, `version`, `name`, `kind` + `kindLabel`, `family`, `category`,
`tags`, `thinking` (why it looks like this — show it), `levels` (what 1 to 10
changes — show it), `speed` (projectiles), `events`, `sustained`, `stage`
(`caster`, `target`, `extras`, `at`, `reach`, `move`, `hold`, `anim`,
`monster` hint, `release` — s from the clip's start to the spell, or ten
values by level), `sounds`, `volley` (`{ formations, max }` or null),
`radius`, `planes`, `light`, `layers`, `tune` (the tunables schema: `type`
color | range | bool | select, `def`, `min`, `max`, `step`, `label`).
