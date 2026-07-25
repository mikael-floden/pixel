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
