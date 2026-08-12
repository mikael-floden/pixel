# Nangijala Scenery

**Scenery** is the game's freely placeable, optionally animated set dressing —
campfires, grave crosses, street lamps, trees, wells… A scenery piece differs
from a tile in two ways that define this domain:

1. **It can be placed anywhere** — it does not have to follow the tile grid
   (tiles are `tiles2/`'s job).
2. **It can animate** — tiles cannot.

This domain is owned by the **scenery agent** (board file
`coordination/scenery.json`). It generates new scenery on
[PixelLab](https://pixellab.ai); the **maps2 agent** is the one that places
scenery in worlds; the game (`games2/`) renders it.

> **History:** this directory was `objects/` (the "object-agent"'s domain) until
> 2026-08-12, when the scenery agent took over and renamed the domain end to
> end: `objects/` → `scenery/`, `object.json` → `scenery.json`,
> `config/objects.json` → `config/factory.json`, workflow `objects.yml` →
> `scenery.yml`, heartbeat `coordination/objects.json` →
> `coordination/scenery.json`, and every consumer path (games2 Dockerfile +
> `/assets/scenery/...` URLs, `.dockerignore`, deploy triggers, wiki builder,
> lore builder). The wiki already labelled this content "Scenery"; its route
> slug `#/objects` and the wiki/lore internal data keys deliberately stay for
> now — they are URLs/ids, and renaming them is those agents' call. The 16
> deleted first-round props (axe, barrel, oak_tree…) live in git history.

## What ships today — three pieces, all drawn by the game

| id | what the game does with it |
| --- | --- |
| `campfire` | the spawn bonfire (`burn__south`, 16f) — also a real shader light; the tiles2 bonfire *tile* pins its exact light params |
| `grave_cross` | rises where a monster died (16-frame SOUTH-only `appear`, held, then played reversed to sink away) — the maintainer's own PixelLab object |
| `blood_spatter` | plays on every landed hit (8 direction variants, forward or reversed) — the maintainer's own PixelLab object, stored deliberately TRIMMED (see its manifest's `edited` note); never regenerate or mirror verbatim over the trims |

The generation loop is currently **parked**: `config/factory.json` pins
`targets.num_scenery` to 1 and `procedural.kinds` is empty, so running the loop
cannot silently refill the domain. That pin is deliberate — raise it **on
purpose, with the maintainer**, together with new catalog entries, when the
next generation round is green-lit.

## What is a scenery piece, on disk?

**One folder per piece** — `scenery/<id>/` with a `scenery.json` manifest. The
only non-scenery folders are the tooling (`pipeline/`, `config/`, `spec/`).
Every piece is a **persistent PixelLab object** (created with
`create-8-direction-object`, PixelLab's product term for the store entity), so
it also lives in the PixelLab **create-object** web tool — regenerate it there
and `sync.py` pulls the new art back.

```
scenery/<id>/
  scenery.json                the manifest — describes everything below (read this)
  sprite.webp                 the base sprite (transparent, facing `south`)
  rotations/                  one image per direction (south == sprite)
    south.webp east.webp ...
  animations/
    <key>/<dir>/NN.webp       per-frame images, zero-padded
    <key>__<dir>.webp         sprite-sheet STRIP: all frames in a horizontal row
    <key>__<dir>.gif          looping preview GIF (plays in the GitHub app)
```

### `scenery.json` fields

Same contract the old `object.json` carried: `id`, `name`, `category`,
`description`, `view`, `size` (square art px), `sprite`, `rotations`
(`{dir: path}`), `animations` (`{key: {description, frame_count, directions:
{dir: {frames, strip, gif, frame_paths}}}}`), and **`placement`** — the realism
rule. All paths are **domain-relative** (they start with the piece id).

### Sizing scenery in the world (important)

Art resolution ≠ world size. Render each sprite scaled so its on-screen height
equals **`placement.world_px_height`**, next to characters drawn at
`placement.character_height_px` (64px = 1.7m). A coin is ~8px, an oak ~226px.
Change heights in `config/factory.json → scale` and the loop rewrites every
manifest's `placement` on its next run — no regeneration.

### Manifest extensions may lag the art

**Lossless WebP is the repo-wide image format** (project default 2026-07-31;
this domain is fully converted — the manifests may still *name* `.png` in
places, and consumers resolve the real extension on disk). Two hard-won rules
from `games2/CLAUDE.md`: encode with Pillow's `lossless=True` **and**
`exact=True` (both non-default), and never write a "small file = corrupt" guard
— a fully transparent WebP frame is a valid 28-byte file.

⚠️ **`pipeline/sync.py` still writes `.png`.** It cannot be exercised without
the PixelLab API, and untested pipeline edits are worse than a documented gap.
After any real re-sync: `python3 games2/scripts/to-webp.py --write --replace
scenery/` then re-run `pipeline/viewer_build.py`.

## Who consumes this domain

- **games2** — bakes `scenery/` into its image (`games2/Dockerfile` →
  `/assets/scenery/...`) and hardcodes the three URLs it draws in
  `client/src/scenes/WorldScene.ts` (this domain ships no runtime manifest the
  game reads; if that changes, give the game a manifest and a board note).
- **wiki** — `wiki/build.mjs buildObjects()` reads every `scenery/<id>/scenery.json`
  into the wiki's "Scenery" section (internal domain key `objects` for now).
- **lore** — `lore/pipeline/build.py` reads the manifests for per-entity lore
  (`lore/entities/objects/<id>.json`, same key note as the wiki).
- **maps2** — will place scenery in worlds (no world references scenery yet).
- **Deploys**: a push touching `scenery/**` auto-deploys the game
  (`.github/workflows/nangijala-deploy.yml`), and `.dockerignore` must allowlist
  the domain (`!scenery`) or every asset 404s in prod — that file is the first
  place to look for that symptom.

Placement rule for anything emissive (campfires, lamps, glowing trees): the
renderer has **8 world light slots** — see `games2/spec/LIGHT_BUDGET.md` and run
`node games2/scripts/check-light-budget.mjs` before shipping worlds that place
glowing scenery.

## Browse it

- Phone / GitHub app: open any `scenery/<id>/animations/*.gif`.
- `index.html` + `viewer_data.json` (rebuilt by `pipeline/viewer_build.py`) —
  a gallery with a to-scale character comparison; serve the folder with
  `python -m http.server`.
- In-game wiki: the **Scenery** section at `/assets/wiki/site/`.

## Run / extend the loop

```bash
pip install -r ../requirements.txt
export PIXELLAB_API_KEY=...            # gitignored .env; NEVER committed

python pipeline/loop.py --once                 # one unit (one generation)
python pipeline/loop.py --max-minutes 50       # a bounded chunk (for a schedule)
python pipeline/sync.py --dry-run              # reconcile report, zero generations
```

Each **unit** is one PixelLab generation (a base 8-direction object, or one
animation across all 8 directions). After each unit the loop rebuilds
`viewer_data.json`, updates the heartbeat, commits and pushes. It reads the
filesystem to find the next missing unit, so it is **fully resumable**, and it
stops cleanly at the shared-budget floor
(`config/factory.json → budget.min_generations_remaining`, 2000 per
`coordination/PROTOCOL.md`).

**Add scenery** by appending to `config/factory.json → catalog` and raising
`targets.num_scenery`. See [`spec/SCENERY_SPEC.md`](spec/SCENERY_SPEC.md) for
the full design and the exact PixelLab endpoints.

### On a schedule

[`.github/workflows/scenery.yml`](../.github/workflows/scenery.yml) runs the
loop on demand (its cron is commented out while the domain is pinned). It
no-ops with a warning unless the `PIXELLAB_API_KEY` Actions secret is set.

## Coordinating with the other agents

Per [`coordination/PROTOCOL.md`](../coordination/PROTOCOL.md): this agent stays
inside `scenery/`, writes its heartbeat + requests to
**`coordination/scenery.json`** (the only file it writes outside the domain),
reads every other board file at the start of a run, and respects the shared
PixelLab budget floor. On the rare occasion it must touch another domain's
files (like the 2026-08-12 rename), it leaves that agent a note on the board.

## Don't

- **Never commit secrets** — `PIXELLAB_API_KEY` lives in a gitignored `.env`.
- Don't run the loop without checking the shared budget and the target pin.
- Don't regenerate the maintainer's own pieces (`grave_cross`, `blood_spatter`).
- Don't re-pose art locally — PixelLab owns rigging/animation; this domain owns
  orchestration, packaging, QA-of-output, and the viewer.
