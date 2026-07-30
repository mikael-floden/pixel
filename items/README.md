# Items domain

Every **item** in the Nangijala game — the loot monsters drop, the stones you
merge into gear, and (later) the potions, swords, bows, wands and armor you
carry. Art is authored on [PixelLab](https://pixellab.ai); this domain mirrors
it into the repo and owns all the **metadata** the game needs to make an item
mean something.

This is one **domain** of the multi-domain `pixel` repo, owned by the **items
agent**. It is self-contained: everything lives under `items/`. See
`coordination/PROTOCOL.md` for the fleet contract.

## Ground truth: the type tag on PixelLab

The maintainer draws each item in the PixelLab **create-object** UI and tags it
with its **type**. That tag decides both *which* items exist and *what kind*
each one is:

| Tag | What it is | Equips | Stacks |
|---|---|---|---|
| `MISC` | junk loot dropped by monsters — sold for gold | — | 99 |
| `SOUL` | a soul stone; merged into a weapon or armor to grant its power | — | 20 |
| `CONSUMABLE` | potions, elixirs, food — used from the bag | — | 20 |
| `SWORD` | melee weapon | weapon | — |
| `BOW` | ranged weapon | weapon | — |
| `WAND` | magic weapon | weapon | — |
| `ARMOR` | worn protection | armor | — |

The table lives in [`config/types.json`](config/types.json) — one entry per
type with its tag, stack rules, equip slot and the shared rarity ladder.
`sync.py` discovers by **exactly those tags**, so tagging a new object `SWORD`
on PixelLab is all it takes for swords to start flowing in.

**Currently shipped: `MISC` (77) and `SOUL` (28).** The other five types are
contracted in `types.json` and have no art yet.

## PixelLab owns the art, this repo owns the meaning

PixelLab has no field for "sells for 12 gold" or "grants +8 fire damage", so
the metadata lives in [`config/roster.json`](config/roster.json) — one entry per
item, pinned to its `pixellab_id`:

```jsonc
{
  "id": "wolf_fang",          // stable folder id — never changes
  "pixellab_id": "…",         // the object on PixelLab (membership + art)
  "type": "MISC",             // re-read from the live tag on every sync
  "name": "Wolf Fang",        // in-game name, MAX 12 CHARS, from what the art LOOKS like
  "category": "claw",         // MISC: material family · SOUL: element
  "rarity": "common",         // common | uncommon | rare | epic | legendary
  "value": 9,                 // shop sell price in gold (inside the rarity's band)
  "description": "…",         // one line of loot-codex flavour for the wiki
  "power": "+4 bleed damage"  // SOUL only: what a merge grants
}
```

Hand-tune any of it; sync preserves every field across runs. An object whose
tag disappears is dropped from the roster **and its folder is pruned**; a newly
tagged object is appended with `needs_review: true` and a placeholder id, so
the next run flags "look at this sprite and name it".

> **Names describe the art, not the prompt.** The maintainer generates in big
> batches ("Item drops from enemies in an MMORPG… I want variety"), so the
> PixelLab `name` field is useless. Every name here was chosen by *looking* at
> the sprite, and is ≤ 12 characters — same rule the monsters domain uses.

> **Every soul stone is called "Soulstone".** `SOUL` declares `shared_name` in
> `types.json`, so the 28 stones share one display name and differ by their
> **description**, element and power — sync enforces that instead of the
> unique-name rule the other types get.

## Where the drop mapping lives: `live/tuning/monsters.json`

Which monster drops which item is **not** stored in `items/`. It lives in
[`live/tuning/monsters.json`](../live/tuning/monsters.json), inside each
monster's entry:

```jsonc
"stone_turtle": {
  "level": 13, "max_hp": 20, …,
  "loot": [
    { "item": "banded_solar_stone", "chance": 0.012 },   // fraction, not %
    { "item": "stone_egg",          "chance": 0.18  }
  ]
}
```

That is the file the **maintainer** edits from the wiki's monster page ("Loot /
drops → + add drop"), and `live/**` is the game's live-update channel: a change
there is committed to `main` and pushed to the running server and every
connected client **within seconds, with no rebuild, redeploy or restart** (see
[`live/README.md`](../live/README.md)). Anything kept under `items/` would need
a deploy to take effect and could not be edited from the wiki — so this domain
deliberately keeps **no copy** of the mapping. One source of truth, owned by the
maintainer; `item` values are `items/<id>` folder ids, and
`items/viewer_data.json` is what resolves an id to a name, sprite and value.

The rules the mapping follows:

- a **SOUL** stone is dropped by **exactly one** monster — it is that
  creature's signature drop;
- a **MISC** item can drop from **several** monsters (a fang from every biter),
  and every item is dropped by at least one, or it would be unobtainable;
- drop chance follows the item's rarity (common ~15-50 %, uncommon ~6-25 %,
  rare ~1.5-10 %, epic ~0.4-3 %), and valuable loot comes off higher-level
  monsters.

`pipeline/drops.py` is the items agent's side of that contract — it **verifies**
those rules against the live file, can **apply** an assignment plan, and prints
the tables. It never regenerates the file: `live/` is durable maintainer state.

```bash
python items/pipeline/drops.py            # verify (read-only)
python items/pipeline/drops.py --report   # + print every monster's loot table
```

## Layout: one folder per item

```
items/<id>/
  item.json      the manifest — the contract the game reads (below)
  sprite.png     the item icon, transparent PNG (48×48 today)
```

`item.json`:

```jsonc
{
  "id": "wolf_fang",
  "name": "Wolf Fang",
  "type": "MISC",
  "type_label": "Junk",
  "category": "claw",
  "rarity": "common",
  "value": 9,
  "stackable": true, "max_stack": 99,
  "equip_slot": null, "sellable": true,
  "description": "Yellowed, still sharp, and worth more to a collector than it ever was to the wolf.",
  "sprite": "items/wolf_fang/sprite.png",   // repo-relative
  "size": [48, 48],
  "soul": { "element": "ember", "power": "…", "merge_into": ["weapon", "armor"] },  // SOUL only
  "source": { "store": "objects", "pixellab_id": "…", "tags": ["MISC"], "prompt": "…",
              "created_at": "…", "last_modified": "…" },
  "synced_at": "…"
}
```

**[`viewer_data.json`](viewer_data.json)** is the rolled-up registry: every
item in one file (plus the type table and the rarity ladder), repo-relative
paths, regenerated by every sync. Load that one file to get the whole catalog —
it is also what `wiki/build.mjs` picks up for the wiki's **Items** section.

## Tooling

```bash
pip install -r requirements.txt          # repo root
export PIXELLAB_API_KEY=...              # gitignored .env; never committed

python items/pipeline/sync.py            # THE command: discover by tag, reconcile the
                                         #   roster, prune, mirror, rebuild the registry,
                                         #   verify the metadata
python items/pipeline/sync.py --dry-run  # print the plan only
python items/pipeline/sync.py --fresh    # re-download every sprite
python items/pipeline/sync.py --only <id>
```

- `pipeline/sync.py` — the reconciler (discover → roster → prune → mirror →
  registry → verify). Does not commit; the caller commits one atomic change.
- `pipeline/mirror.py` — mirrors ONE item and writes its manifest. Unchanged
  art is skipped via `If-Modified-Since`, and a no-op sync leaves an empty diff.
- `pipeline/pixellab_client.py` — this domain's own client (tag discovery with
  pagination, still-sprite resolution, conditional downloads).

Verification is part of every sync and fails loudly in the summary: names
present, unique and ≤ 12 chars; a sprite on disk; a category, a description and
a positive gold value inside its rarity band; and every `SOUL` stone carrying a
`power`.

## Browse it

- **Phone / GitHub app:** open any `items/<id>/sprite.png`.
- **In game:** the wiki's **Items** section (`/assets/wiki/site/index.html`).
- **Viewer page:** [`index.html`](index.html) — a phone-friendly gallery that
  loads `viewer_data.json`, filters by type and shows value / rarity / soul
  power. Works over GitHub Pages or `python -m http.server` from this folder.

## How this agent runs

- **Sync only, no generation loop.** The maintainer authors and tags items on
  PixelLab; this agent mirrors them in, names them and maintains the metadata.
  Mirroring costs **zero generations** (download only).
- Commits go **directly to `main`**, touching only `items/` and
  `coordination/items.json` (one writer per file).
- Never commit secrets — `PIXELLAB_API_KEY` lives in a gitignored `.env`.
