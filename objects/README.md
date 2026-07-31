# Pixel Object Factory

> ## STATUS 2026-07-31: DORMANT — one asset, no agent
>
> **There is no objects agent, and there has not been one for a long time.** The
> maintainer will recreate it when there is time. Until then this domain is
> caretaken by the games agent and it holds exactly **one** asset: the
> **campfire**, which the game draws as the spawn bonfire.
>
> The other 16 objects (axe, barrel, clay_pot, fishing_rod, gem_ruby,
> gold_coin, gold_ingot, hammer, iron_key, oak_tree, pickaxe, pine_tree,
> shovel, sword, wooden_chest, wooden_crate) were **deleted**. Nothing
> referenced them: no `maps2` world has ever pointed at `objects/` — verified
> across all 10 `world.json` files, zero references — and the game loads
> exactly one file from this domain (`campfire/animations/burn__south`). They
> were 34 MB of art with no consumer. Their history is in git if the agent
> returns and wants them back.
>
> `config/objects.json` was pinned to match reality: `targets.num_objects`
> 75 → **1**, the catalog trimmed from 67 entries to the campfire, and
> `procedural.kinds` emptied. **That pin is deliberate** — the loop's whole
> job was to build *toward* 75, and the procedural generator invents new kinds
> once the catalog runs out, so leaving either in place would have quietly
> refilled the domain with props nothing asked for the moment anyone ran it.
> If you are the recreated agent: raise those numbers on purpose, with the
> maintainer, rather than treating the current values as a bug.
>
> **Art here is lossless WebP** (project default since 2026-07-31; 0.82 MB →
> 0.28 MB, 34%, pixel-verified). ⚠️ **`pipeline/sync.py` still writes `.png`.**
> It was not changed because it cannot be exercised without the PixelLab API,
> and untested pipeline edits are worse than a documented gap. If you re-sync
> this domain, run `python3 games2/scripts/to-webp.py --write --replace
> objects/` afterwards and re-run `pipeline/viewer_build.py`, or teach `sync.py`
> to save WebP directly — see `games2/CLAUDE.md` for the conversion rules
> (lossless only; `exact=True`).

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
a bird, a sword. **Each object is one folder** — `objects/<id>/`. If you see a
folder under `objects/` with an `object.json` in it, that's an object; the only
non-object folders are the tooling (`pipeline/`, `config/`, `spec/`).

Every object is a **persistent PixelLab object** (created with
`create-8-direction-object`), which means it also lives in your PixelLab
**create-object** web tool — so you can open it and press **regenerate** if it
looks bad, and [`sync.py`](#staying-in-sync-no-loose-pointers) pulls the new art
back into the repo. Each object has:

1. **8 rotations** — always 8 directions (`rotations/<dir>.png`, `sprite.png` =
   south);
2. **3 animations** chosen to fit the object (chest → open/close/rattle, coin →
   spin/flip/bounce, tree → sway/rustle/shake…), each generated across **all 8
   directions** at **max frames (16)**, packaged as per-frame PNGs + a
   **sprite-sheet strip** + a preview **GIF** per direction;
3. a **type-appropriate size** (a coin is small, an oak is large) and a
   **`placement`** that keeps it to scale next to a character.

What each object gets is defined in [`config/objects.json`](config/objects.json).

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

  "placement": {                        // REALISM RULE — how big this is in the world
    "world_height_m": 0.7,              // the object's real-world height (metres)
    "world_px_height": 26,              // => render the sprite scaled to THIS pixel height
    "character_height_px": 64,          // ...next to a character drawn 64px tall
    "character_height_m": 1.7           // (so 64px == 1.7m; a coin ~8px, an oak ~226px)
  },

  "status": "complete",                 // "in_progress" while the loop is still filling this object
  "generations_used": 5.0,
  "source": "pixellab.ai (generate-image-pixflux / rotate / animate-with-text)"
}
```

### Sizing objects in the world (important)

Sprites are generated at whatever **art** resolution looks best (`size`), which is
**not** how big the object is in the world. Use **`placement.world_px_height`** for
that: render each sprite scaled so its on-screen height equals `world_px_height`,
and draw characters at `placement.character_height_px` (64px). Then everything is
to scale — a gold coin is ~8px beside a 64px character, an oak tree towers at
~226px. This is a hard rule the loop enforces: every object carries a real
`world_height_m` and the derived `world_px_height`, so nothing lands
unrealistically sized. (Change the reference or an object's height in
`config/objects.json → scale`, and the loop rewrites every manifest's `placement`
on its next run, no re-generation.)

### How to load it

- **Static prop** (rock, crate, coin): draw `sprite.png`, scaled to
  `placement.world_px_height`. The object's frames/rotations all share the art
  `size`, so you can atlas-pack by `size` with no surprises.
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

## Coordinating with the other agents

This repo is worked by three parallel agents (characters / objects / maps) sharing
one `main` and **one PixelLab account**. Coordination follows
[`coordination/PROTOCOL.md`](../coordination/PROTOCOL.md):

- Each unit, the loop publishes a heartbeat to **`coordination/objects.json`**
  (the only file it writes outside `objects/`) — health, progress,
  `budget_remaining` — and reads the other domains' heartbeats at startup,
  acting on any `requests` addressed to `objects`.
- The loop respects a **shared-budget floor** (`budget.min_generations_remaining`,
  set to **2000** per the protocol) so it never drains the pool the characters
  and maps loops also draw from.

## Staying in sync (no loose pointers)

`pipeline/sync.py` keeps the repo and PixelLab consistent, and runs automatically
at the start of every loop pass (zero generations). Unlike characters — which
persist on PixelLab and are edited/synced there — **objects are generated
statelessly and don't live on PixelLab** (`POST /v2/objects` → 405), so the repo
is the source of truth. Sync therefore:

1. **Prunes loose pointers** — any manifest/viewer reference to a file that no
   longer exists is dropped; an object whose `sprite.png` is gone is removed
   entirely, so the viewer can never point at a dead file.
2. **Mirrors PixelLab-side deletions** — if an object the repo mirrored from the
   PixelLab UI (tagged `pixellab_object_id`) is deleted there, its repo folder is
   removed too. Generated objects (no such id) are never touched.
3. **Imports UI-authored objects** — anything made in the PixelLab Object creator
   is mirrored in (best-effort, with `If-Modified-Since` change detection like the
   characters agent); anything it can't import is reported, not silently dropped.

```bash
python pipeline/sync.py            # reconcile + push
python pipeline/sync.py --dry-run  # report only, change nothing
```

## Notes / guardrails

- **Never commit secrets** — `PIXELLAB_API_KEY` lives in a gitignored `.env`.
- **The repo is the source of truth for objects.** PixelLab's object image tools
  (pixflux / rotate / animate-with-text) are *stateless* — unlike characters,
  there's no server-side object to edit and sync back — so a generated object
  lives only here. Re-generating is a fresh draw.
- This loop only ever *creates missing* assets; it never overwrites an object
  that's already on disk, so hand-tweaks you commit are safe.
