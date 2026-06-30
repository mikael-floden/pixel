# Modular Pixel Character Factory

Side-view (Grave Seasons / Stardew-style) pixel characters built as **layered
sprites that share ONE skeleton**, so animations and gear amortize across the
whole roster. PixelLab paints the pixels; this repo owns the **skeleton, pose
library, compositing, and QA**.

> **The Rule:** every body part and gear piece is rendered on the same 48×64
> canvas, posed by the same skeleton, transparent everywhere else. Compositing is
> alpha-over in z-order. Gear equips by hiding the base layers it covers.

See [`spec/MODULAR_PIXEL_CHARACTER_SPEC.md`](spec/MODULAR_PIXEL_CHARACTER_SPEC.md)
for the full design.

## Layout

```
config/      skeleton.json, animations.json (25 starter anims), palette.json, project.json
pipeline/    compositor.py, qa.py, pixellab_client.py, skeleton.py,
             generate_character.py, generate_gear.py
spec/        MODULAR_PIXEL_CHARACTER_SPEC.md
assets/      committed sprite output (preview/, characters/, gear/)
```

## Setup

```bash
pip install -r requirements.txt          # Pillow, numpy, requests
```

## Prove the deterministic path (no PixelLab, no key needed)

```bash
python pipeline/compositor.py            # synthetic pixelate+QA, then a contact sheet
```

This writes `assets/preview/contact_sheet.png` (one row per animation, one column
per frame), per-animation strips, a manifest, and QAs every frame.

Render a character or gear with the procedural placeholder rig:

```bash
python pipeline/generate_character.py --id rowan --desc "freckled farmhand" \
    --archetype villager --placeholder
python pipeline/generate_gear.py --id straw_hat --slot helm \
    --archetype villager --desc "wide straw sun hat" --placeholder
```

QA a single frame:

```bash
python pipeline/qa.py assets/preview/strip_walk.png
```

## Going live with PixelLab (Phase 0)

1. `export PIXELLAB_API_KEY=...` (keep it in a **gitignored** `.env`; never commit it).
2. Allow outbound egress to `api.pixellab.ai`.
3. Implement the stubbed calls in `pipeline/pixellab_client.py` and
   `_paint_base_layers` / `_paint_gear`, then drop `--placeholder`.
4. Paint the pilot character and **lock the palette** from it
   (`config/palette.json` → `"locked": true`).

## Guardrails

- Never commit secrets.
- Every committed frame must pass `pipeline/qa.py`.
- Once the palette is locked, don't recolor mid-roster.
- Keep PRs small.
