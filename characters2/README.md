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

## WebP migration (staged — art is still PNG)

Measured on **all 1419** files in this domain, lossless:

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

### Why the art hasn't flipped yet — the consumer contract

The pipeline is format-agnostic already (`config.json: "frame_format"` switches
it; `sync.py`/`verify_sync.py` follow it), so the flip is **one config change +
one command**. It is deliberately NOT done, because these frames are *decoded*
outside this domain:

| Consumer | What breaks |
|---|---|
| `games2/scripts/build-manifest.mjs` | hand-parses the PNG IHDR (`pngDims`) and decodes pixels (`pngAlpha`) to measure **foot anchors, shoulder waterlines, gait fps, foot plants** — silently wrong ⇒ detached shadows, floating characters |
| `games2` client (Phaser) | frame URLs end in `.png` |
| `wiki/build.mjs` | counts frames with `/^\d+\.png$/`, links `base/south.png` |

Order of operations: **games2 gains a WebP-capable decoder → this domain flips
`frame_format` and runs `to_webp.py --apply` → wiki widens its regex.** Flipping
first would ship a broken game.

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
