# characters2 — the game's two heroes

The **real** game's main characters (the earlier `characters/` and `objects/`
work was exploration). The two heroes — a boy and a girl — are now **DECIDED**:
each is locked to a specific PixelLab character that was picked in the UI. This
domain now **mirrors** those two characters (base model + animations +, later,
outfits) into the repo. **PixelLab is the source of truth.**

## The two heroes (locked)

| Hero | PixelLab character |
|------|--------------------|
| `default_boy`  | `c883451f-41b0-4f5e-8ac7-c606cb007154` |
| `default_girl` | `bc21eab2-4f08-47ac-b58f-65ee1b98a935` |

They live on the fixed human skeleton: **low top-down**, **low detail**, default
outline, native **112 × 112** canvas. The IDs are pinned in
`config.json:pixellab_characters` — that file is the source of truth for **which**
characters to mirror; re-point an ID there and re-sync to swap a hero (the mirror
removes the old character's assets and imports the new one's). Each hero currently
carries a base 8-direction model + **14 animations** (idle, walking, running, and
custom moves: sword swing, punch, high kick, high jump, spellcasting, bow, etc.),
every animation at all 8 directions.

### Animation folder names (slugs)

PixelLab animation names can contain spaces, commas, even newlines (especially
`custom-*` ones), so `sync.py` slugifies each into a filesystem-safe folder name
(e.g. `custom-Running⏎steeplechase…` → `custom-running-steeplechase-jump-one-leg-front-one-leg`).
The exact PixelLab `animation_type` is preserved in `character.json` for matching,
so the slug is only ever the folder name.

## NPCs (`npcs/`) — tag-driven mirror

Beyond the two heroes, this domain mirrors **every PixelLab character tagged
`NPC`** — the tag is the ground truth, exactly like the monsters domain's
`MONSTER` tag. `sync.py` discovers the set by listing the account's characters,
mirrors each into `npcs/<folder>/` (same shape as a hero: `base/` 8 rotations +
`animations/<slug>/<dir>/N.webp` + `character.json`), and **prunes** any folder
whose character lost the tag or was deleted. Tag a character `NPC` in the
PixelLab UI and the next sync brings it in; untag it and the next sync removes
it.

- **Folders are keyed by the PixelLab id's first 8 hex chars** (`npcs/3749cceb/`),
  NOT the name: NPC names are duplicate prompt junk ("light armor with sho
  (copy 4)" ×7), and the id prefix is stable across renames. On a prefix
  collision the folder simply takes more of the id.
- **`npcs/index.json`** (`characters2-npcs@1`) is the roll-up consumers should
  read: every folder with its full PixelLab id, raw name, and animation slugs —
  no tree-walking needed.
- Authored facts (display names, lore, roles) belong in `metadata.json` under
  the same folder key, and merge onto the NPC's `character.json` like a hero's.
- `verify_sync.py` checks the set BOTH ways (nothing tagged is missing, nothing
  untagged survives) plus full per-NPC integrity.

```bash
python characters2/pipeline/sync.py npcs        # just the NPC set
python characters2/pipeline/sync.py             # heroes + NPCs (default)
```

## WebP — MIGRATED (2026-07-31)

All art in this domain is **lossless WebP**; there are zero PNGs left under
`humans/`. Measured on all 1419 files:

| | size | |
|---|---|---|
| PNG | 4.43 MiB | |
| WebP (lossless) | 1.44 MiB | **67.6% smaller**, 1419/1419 verified pixel-identical |

Two findings worth reusing in other domains:

- **`method=4` (Pillow's default), not `method=6`.** Over 120 sprites method 6
  matched method 4's size to within 0.1% while being **~76× slower**
  (99.5 ms vs 1.3 ms/file). Whole-domain conversion takes **2.5 s**, not minutes.
- **WebP must be saved explicitly lossless.** Pillow's default WebP encode is
  *lossy* — a bare `img.save("x.webp")` silently resamples every sprite. All
  writes go through `sync.py:save_image()`, which forces `lossless=True`.

```bash
python characters2/pipeline/to_webp.py            # dry run: measure + verify, writes nothing
python characters2/pipeline/to_webp.py --apply    # convert + git rm the PNGs
python characters2/pipeline/to_webp.py --revert   # back to PNG
```

`--apply` refuses to delete a single PNG unless **every** file round-tripped
pixel-identical, so a bad encode can't lose art.

### How it was proved safe

These frames are *decoded* outside this domain — `build-manifest.mjs` derives
**foot anchors, shoulder waterlines, gait fps and foot plants** from their
pixels, so a bad conversion means detached shadows and floating characters. That
risk was measured, not assumed:

1. Built the manifest from the real PNG art (baseline).
2. Converted a **shadow copy** to WebP and rebuilt with `ASSETS_ROOT` pointed at
   it (`build-manifest.mjs` honours that env var).
3. Diffed: `frameW/frameH`, `anchors`, `shoulders`, `gaitFps`, `plants` and
   `animations` came out **IDENTICAL** for both heroes. Only the URLs changed —
   the manifest emits `animExt: webp` and a `.webp` portrait.
4. `npm test` in `games2`: **117/117 pass** against the converted tree.

It holds because the measurement code reads only the **alpha** channel, and
alpha survives lossless conversion bit-exactly. (Lossy would move the anchors —
hence the hard rule.) Consumers read both formats: games2 via
`scripts/imagelib.mjs`, the wiki by resolving paths against the disk.

## Authored metadata (`metadata.json`) — `characters2-metadata@1`

Everything true about a character that **can't be derived from the art** lives in
**`characters2/metadata.json`**, keyed by the `humans/<id>` folder id:

```jsonc
{ "format": "characters2-metadata@1",
  "characters": {
    "default_boy": { "display_name": "Man", "species": "Human",
                     "sex": "Male", "lore": "A young man of the human race — …" } } }
```

`lore` (the wiki blurb — 1–2 sentences of RPG flavour, no stats) is just the
first field; **add more as needed** (tags, hometown, starting class, voice…) and
they flow through automatically — `sync.py` merges the *whole record*, so a new
field needs no code change.

Why a separate file: `humans/<id>/character.json` is **regenerated on every
sync**, so authored text can't live there — `sync.py` merges this record onto it
after each sync. Consumers may read either. PixelLab's own `name` (prompt junk
like `"Improve transparency"`) is kept there for traceability; `display_name` is
the human-facing one.

**Edit fields here, never in `character.json` (generated). Every field is
optional** — absent fields are simply omitted, so adding one can't break a
consumer.

## Game-state → folder mapping (`animation_map.json`)

The game refers to animations by **stable logical names** (`idle`, `walk`, `run`,
`jump`, `runjump`, `kick`, `sword`, …), but PixelLab's folder names change on a
whim and the two heroes can differ (boy `walking-6-frames` vs girl `walking`).
`animation_map.json` is the **contract** between the art and the game:

```jsonc
{ "states":    { "walk": "walking", "kick": "custom-high-kick", … },
  "overrides": { "default_boy": { "walk": "walking-6-frames", … } } }
```

`games2/scripts/build-manifest.mjs` reads this file (per-hero override wins) to
build the character manifest, so **when PixelLab renames a move, only this file
changes — no game code touches**. Previously the game hard-coded folder names and
silently dropped any that didn't match (renamed `high-kick`→`custom-high-kick`
etc. broke `jump`/`runjump`/`kick`/boy-`walk`).

**Maintain it:** after a sync, `verify_sync.py` checks every hero×state resolves
to a real folder and FAILS if one is missing (so a rename can't silently break
the game again). If PixelLab renames a move, update its value here and re-verify.

## Staying in sync

The user keeps adding **animations** in the PixelLab UI (and later outfits /
extra models). `sync.py` pulls the current state down with **zero generations** —
it only downloads what actually changed:

- base rotations are re-fetched only when their source URL changes;
- an animation is skipped entirely when its `animation_group_id` is unchanged and
  all its frames are already on disk (so newly-added *directions* of an existing
  animation are still picked up);
- it is a true mirror — animations / directions / stray frames deleted in the UI
  are removed locally too.

```bash
export PIXELLAB_API_KEY=...
python characters2/pipeline/sync.py                # mirror both, commit + push
python characters2/pipeline/sync.py default_girl   # just one
python characters2/pipeline/sync.py --no-push      # local only
```

There's a GitHub Action (`.github/workflows/characters2.yml`) that runs the sync,
but its **schedule is currently paused** (at the user's request — no timer runs).
Trigger a sync on demand via the Actions "Run workflow" button, or run `sync.py`
locally. It commits/pushes only when something changed.

## Layout

```
characters2/
  config.json                    pinned hero IDs (+ legacy explorer params)
  humans/
    default_boy/
      character.json             manifest: pixellab id, prompt, style, per-file source URLs
      base/
        south.png … south-west.png   the static 8-direction model (native 112×112)
        preview.png                  all 8 directions in a row
      animations/                  one folder per animation (slugged name)
        walking-6-frames/
          south/ 0.png 1.png …       frames per direction
          north/ …
          preview.gif                animated preview (first available direction)
        breathing-idle/  running-8-frames/  custom-swing-a-sword/  custom-high-kick/  …
    default_girl/  (same shape)
    _experiments/                archived vNNN reroll experiments (pre-decision history)
  pipeline/
    pixellab_client.py           character client (get_character, rotations, download)
    sync.py                      mirror the pinned heroes from PixelLab (the main tool)
    verify_sync.py               re-fetch from PixelLab and assert the repo is an EXACT mirror
    generate.py                  legacy explorer that produced the _experiments/ vNNN takes
```

Verify a sync is exact (read-only; re-fetches PixelLab and diffs the repo — checks
every animation/direction/frame-count, PNG validity, and flags stale folders):

```bash
python characters2/pipeline/verify_sync.py            # both, exits nonzero on any mismatch
```

To use a hero in the game: load `humans/<id>/base/<direction>.png` for the static
facing, or `humans/<id>/animations/<anim>/<direction>/<frame>.png` for animation
frames. Each animation folder also has a `preview.gif` for quick eyeballing.

## Outfits / extra models (coming)

Once animations are settled, the user will add outfits and extra models in the
UI. PixelLab groups a character's outfits via a shared `group_id` (recorded in
each `character.json`). When those exist, `sync.py` will be extended to mirror
them under `humans/<id>/outfits/<name>/` alongside the base model.
