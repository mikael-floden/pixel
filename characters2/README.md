# characters2 — the game's two heroes

The **real** game's main characters (the earlier `characters/` and `objects/`
work was exploration). Not exploring skeletons anymore: the human skeleton is
**fixed**, and there are exactly **two** characters — a boy and a girl — each
meant to look awesome, as if the game shipped with just these two options.

## The human skeleton (fixed)

| Param | Value |
|-------|-------|
| Camera view | **low top-down** |
| Sprite size | **80 × 80** |
| Detail | **low detail** |
| Outline | **default** (PixelLab default) |

Each hero is a persistent PixelLab **character** (`create-character-with-8-directions`)
— it shows in the PixelLab UI and renders the **8-direction static model only**.
No animations, no outfits yet (those come later, on request).

## Layout

```
characters2/
  config.json                     the fixed skeleton params + the two hero descriptions
  humans/
    default_boy/
      south.png north.png east.png … (8 direction sprites, 80×80-based)
      portrait.png                 the south view
      preview.png                  all 8 directions in a row
      character.json               manifest (pixellab_character_id, seed, variation, params)
    default_girl/  (same shape)
    .state.json                    reroll counter per character (drives "slightly different")
  pipeline/
    pixellab_client.py             character client
    generate.py                    ensure both exist; regenerate missing ones
```

To use a hero in the game: load `characters2/humans/<id>/<direction>.png` for the
facing you need (`south` is the default / portrait).

## Reroll until you're happy

The generator ensures both heroes exist. **Delete a character's folder and it is
regenerated as a fresh, slightly different variation** (a new seed, tracked in
`humans/.state.json`) — so you can delete the boy or girl repeatedly until each
one looks great. Nothing else is touched.

```bash
export PIXELLAB_API_KEY=...
python characters2/pipeline/generate.py              # create any missing hero
python characters2/pipeline/generate.py --force default_girl   # reroll the girl now
```

A scheduled GitHub Action (`.github/workflows/characters2.yml`) also watches for a
deleted hero and regenerates it, so you can reroll just by deleting the folder on
GitHub. It no-ops (no cost) when both heroes are present.
