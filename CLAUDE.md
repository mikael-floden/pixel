# CLAUDE.md — working notes for this repo

## What this is

A factory for side-view pixel characters built as **layered sprites sharing ONE
skeleton**. PixelLab paints pixels; this repo owns the skeleton, pose library,
compositing, and QA. Read `spec/MODULAR_PIXEL_CHARACTER_SPEC.md` first.

## The Rule (never break it)

Every body part and gear piece is rendered on the **same 48×64 canvas**, posed by
the **same skeleton**, transparent everywhere else. Compositing is **alpha-over
in z-order**. Gear equips by **hiding the base layers it covers**
(`skeleton.slot_hides`). Any change that breaks layer parity (different canvas,
different skeleton, baked-in backgrounds) is wrong.

## Conventions

- Coordinates: image **y grows downward**. Angles in degrees: `0=+x`, `90=down`,
  `-90=up`. All pose bone angles are **absolute world angles**.
- Poses are authored **facing right**; left is a final horizontal flip, so never
  interpolate `facing`.
- Keyframes list **only changed fields** vs `skeleton.json:bind_pose`.
- The deterministic code must stay **pure/deterministic** — same input, same
  pixels. No `Date.now()`/RNG in the pixel path; QA depends on it.

## Pipeline modules

- `pipeline/skeleton.py` — joint solve + procedural placeholder rasterizer
  (`render_pose`). PixelLab replaces the rasterizer; joints stay the contract.
- `pipeline/compositor.py` — `load_palette`, `composite`, `pixelate`,
  `expand_animation`, `pack_strip`, `pack_grid`, `write_manifest`, `render_frame`.
  `python pipeline/compositor.py` runs the synthetic QA + contact sheet.
- `pipeline/qa.py` — the gate. Run before committing any asset.
- `pipeline/pixellab_client.py` — STUBBED API wrapper; all calls are TODOs.
- `pipeline/generate_character.py`, `pipeline/generate_gear.py` — generators;
  `--placeholder` runs the deterministic rig with no network.

## pixelate (exact order, applied identically to every frame)

downscale NEAREST → binary alpha → snap each opaque pixel to nearest palette
color → 1px selective dark outline.

## Guardrails

- **Never commit secrets.** `PIXELLAB_API_KEY` lives in a gitignored `.env`.
- **Pass `qa.py` before committing assets.** Border clean, no stray blobs,
  on-palette, correct size, non-empty.
- **Keep the palette locked** once `config/palette.json:locked` is true.
- **Commit assets** (they are intentionally NOT gitignored). Keep PRs small.

## Don't call PixelLab without

a key set AND `api.pixellab.ai` egress allowed. Until then, use `--placeholder`.
