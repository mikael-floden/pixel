# Pixel Object Factory

An automated loop that generates **game-ready pixel-art objects** — props, tools
and items (chest, gold coin, rock, bird, sword, shovel, tree, torch, potion…) —
in the style of *Grave Seasons* / Stardew Valley, using
[PixelLab](https://pixellab.ai) as the drawing backend.

This is one **domain** of the multi-domain `pixel` repo. It is self-contained:
everything lives under `objects/`. Characters live under `characters/` and maps
under `maps/` — each is owned by its own loop and this loop never touches them.

> **New here?** Jump to **[Using the objects in a game](#using-the-objects-in-a-game)**
> for the data format. That section is all a game developer needs.

---

## What is an "object"?

An **object** is a single, self-contained sprite asset: a chest, a coin, a tree,
a bird, a sword. **Each object is one folder** — `objects/<id>/` — and nothing
else. If you see a folder under `objects/` with an `object.json` in it, that's an
object; the only non-object folders are the tooling (`pipeline/`, `config/`,
`spec/`).

Every object has:

1. a **base sprite** — one transparent PNG, always;
2. optional **rotations** — the same object seen from 4 or 8 directions;
3. optional **animations** — short looping clips (coin spin, chest open, tree
   sway, torch flicker, bird flap…), packaged as per-frame PNGs, a horizontal
   **sprite-sheet strip**, and a preview **GIF**.

What an object gets is decided per object in [`config/objects.json`](config/objects.json).

---

## Folder layout of one object

```
objects/<id>/
  object.json                 the manifest — describes everything below (read this)
  sprite.png                  the base sprite (transparent PNG, the object facing `south`)
  rotations/                  present only if the object has rotations
    south.png  east.png ...   one PNG per direction (south == a copy of sprite.png)
  animations/                 present only if the object has animations
    <key>/                    per-frame PNGs, zero-padded: 00.png, 01.png, …
      00.png 01.png …
    <key>.png                 sprite-sheet STRIP: all frames in a horizontal row
    <key>.gif                 looping preview GIF (plays in the GitHub app / browser)
```

Concrete example (`objects/wooden_chest/`):

```
wooden_chest/
  object.json
  sprite.png                  64×64 closed chest
  animations/
    open/ 00.png 01.png 02.png 03.png
    open.png                  a 256×64 strip = 4 frames of 64×64
    open.gif                  the same 4 frames, looping
```

---

## Using the objects in a game

**Everything you need is in `objects/<id>/object.json`.** It is the contract; the
PNGs/GIFs are what it points at. You don't need to run any Python to consume the
art — just read the JSON and load the PNGs.

### `object.json` fields

```jsonc
{
  "id": "wooden_chest",
  "name": "Wooden Chest",
  "category": "container",              // container | valuable | tool | nature | light | creature | misc
  "description": "a closed wooden treasure chest with iron bands and a rounded lid",
  "view": "low top-down",              // camera the sprite is drawn for
  "direction": "south",                // the direction the base sprite faces
  "size": [64, 64],                    // [width, height] in pixels of EVERY frame/rotation of this object
  "sprite": "wooden_chest/sprite.png", // repo-relative path to the base sprite

  "rotations": {                        // {"count":0} when the object isn't rotated
    "count": 4,
    "directions": ["south", "east", "north", "west"],
    "files": { "south": "barrel/rotations/south.png", "east": "barrel/rotations/east.png", ... }
  },

  "animations": {                       // {} when the object has no animations
    "open": {
      "action": "opening",
      "view": "low top-down",
      "frames": 4,                      // number of frames actually produced
      "strip": "wooden_chest/animations/open.png",   // sprite sheet (frames left→right)
      "gif":   "wooden_chest/animations/open.gif",   // looping preview
      "frame_paths": [                  // individual frames, in order
        "wooden_chest/animations/open/00.png",
        "wooden_chest/animations/open/01.png",
        "wooden_chest/animations/open/02.png",
        "wooden_chest/animations/open/03.png"
      ],
      "ok": true                        // false if QA flagged the clip (blank/static) — see spec
    }
  },

  "status": "complete",                 // "in_progress" while the loop is still filling this object
  "generations_used": 5.0,
  "source": "pixellab.ai (generate-image-pixflux / rotate / animate-with-text)"
}
```

### How to load it

- **Static prop** (rock, crate, coin): draw `sprite.png`. Every frame/rotation of
  the object shares the `size` given in the manifest, so you can atlas-pack by
  `size` with no surprises.
- **Directional prop** (barrel, sign post): pick `rotations.files[direction]` for
  the facing you need. `south` is the same image as `sprite.png`.
- **Animated prop** (chest, coin, torch, tree):
  - **Sprite sheet:** load `animations.<key>.strip`. It's a single row of
    `frames` cells, each `size[0]` wide × `size[1]` tall — slice cell `i` at
    `x = i * size[0]`.
  - **Individual frames:** load `frame_paths` in order.
  - **Quick look:** open the `.gif`.
  - **Frame timing:** the GIF preview runs at ~140 ms/frame; pick whatever cadence
    suits your engine. Frame `0` is the object's rest pose (e.g. a closed chest),
    so `open` plays closed→open and `spin`/`sway`/`flicker` loop cleanly from rest.

All paths in the manifest are **repo-relative** (they start with the object id),
so they resolve the same whether you serve the repo over HTTP or read it from
disk.

### The whole catalog at a glance

`objects/viewer_data.json` is a single rolled-up index of every object (id, name,
category, sprite, rotations, animations) — handy for building a picker or
importing the whole set at once. It's regenerated after every object.

---

## Browse it (no setup)

- **Phone / GitHub app:** open any `objects/<id>/animations/*.gif` — it plays
  inline. `viewer_data.json` lists everything.
- **Viewer page:** enable GitHub Pages (or run `python -m http.server` in this
  folder) and open [`index.html`](index.html) — a phone-friendly gallery that
  loads `viewer_data.json` and lets you flip through every object's sprite,
  rotations and animations, filtered by category.

---

## Run / extend the loop

```bash
pip install -r ../requirements.txt
export PIXELLAB_API_KEY=...            # kept in a gitignored .env; never committed

python pipeline/loop.py --once                 # one unit (one generation)
python pipeline/loop.py --max-minutes 50       # a bounded chunk (for a schedule)
python pipeline/loop.py --max-units 5 --no-push
```

Each **unit** is one PixelLab generation (a base sprite, one rotation, or one
animation). After each unit the loop rebuilds `viewer_data.json`, commits, and
pushes. It reads the filesystem to find the next missing unit, so it is **fully
resumable** — stop it any time and the next run continues. It stops cleanly when
the PixelLab balance drops below `config/objects.json → budget.min_generations_remaining`.

**Add or change objects** by editing [`config/objects.json`](config/objects.json):
append to `catalog` (each entry = a unique object folder), or raise
`targets.num_objects` to let the loop keep synthesizing new objects from the
`procedural` pool. See [`spec/OBJECTS_SPEC.md`](spec/OBJECTS_SPEC.md) for the full
design and the exact PixelLab endpoints used.

### On a schedule

[`.github/workflows/objects.yml`](../.github/workflows/objects.yml) runs the loop
periodically (and on demand) and pushes each unit. Add `PIXELLAB_API_KEY` as a
repo Actions secret; without it the workflow no-ops with a warning.

---

## Notes / guardrails

- **Never commit secrets** — `PIXELLAB_API_KEY` lives in a gitignored `.env`.
- **The repo is the source of truth for objects.** PixelLab's object image tools
  (pixflux / rotate / animate-with-text) are *stateless* — unlike characters,
  there's no server-side object to edit and sync back — so a generated object
  lives only here. Re-generating is a fresh draw.
- This loop only ever *creates missing* assets; it never overwrites an object
  that's already on disk, so hand-tweaks you commit are safe.
