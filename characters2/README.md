# characters2 — the game's two heroes

The **real** game's main characters (the earlier `characters/` and `objects/`
work was exploration). The two heroes — a boy and a girl — are now **DECIDED**:
each is locked to a specific PixelLab character that was picked in the UI. This
domain now **mirrors** those two characters (base model + animations +, later,
outfits) into the repo. **PixelLab is the source of truth.**

## The two heroes (locked)

| Hero | PixelLab character |
|------|--------------------|
| `default_boy`  | `af374339-7e4e-4266-a8be-79296b81938d` |
| `default_girl` | `bc21eab2-4f08-47ac-b58f-65ee1b98a935` |

They live on the fixed human skeleton: **low top-down**, **low detail**, default
outline, native **112 × 112** canvas. The IDs are pinned in
`config.json:pixellab_characters`.

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

A scheduled GitHub Action (`.github/workflows/characters2.yml`) runs the sync
every 30 minutes, so anything added in the UI lands in the repo automatically. It
commits/pushes only when something changed.

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
      animations/
        walking/
          south/ 0.png 1.png …       frames per direction
          north/ …
          preview.gif                animated preview (first available direction)
        breathing-idle/  running-8-frames/  running-jump/  …
    default_girl/  (same shape)
    _experiments/                archived vNNN reroll experiments (pre-decision history)
  pipeline/
    pixellab_client.py           character client (get_character, rotations, download)
    sync.py                      mirror the pinned heroes from PixelLab (the main tool)
    generate.py                  legacy explorer that produced the _experiments/ vNNN takes
```

To use a hero in the game: load `humans/<id>/base/<direction>.png` for the static
facing, or `humans/<id>/animations/<anim>/<direction>/<frame>.png` for animation
frames. Each animation folder also has a `preview.gif` for quick eyeballing.

## Outfits / extra models (coming)

Once animations are settled, the user will add outfits and extra models in the
UI. PixelLab groups a character's outfits via a shared `group_id` (recorded in
each `character.json`). When those exist, `sync.py` will be extended to mirror
them under `humans/<id>/outfits/<name>/` alongside the base model.
