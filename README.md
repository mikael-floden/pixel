# Pixel Art Factory

Automated loops that generate **game-ready pixel art** in the style of *Grave
Seasons* / Stardew Valley, using [PixelLab](https://pixellab.ai) as the drawing
backend. This repo holds **all** graphics for the game, split into self-contained
**domains** — each is its own directory with its own automated loop that
generates art and pushes it to `main`.

## Domains

| Domain | What it makes | Docs |
|---|---|---|
| [`characters2/`](characters2/) | Modular characters (2nd gen) — base bodies + per-direction animations | see `characters2/` |
| [`tiles2/`](tiles2/) | Tile/material library (2nd gen) — iso terrain + prop sheets | see `tiles2/` |
| [`maps2/`](maps2/) | Worlds (2nd gen) — `worlds/<name>/world.json` grids the game loads | see `maps2/` |
| [`objects/`](objects/) | Animated props / map objects | see `objects/` |
| [`sounds/`](sounds/) | Game sound effects (UI, items, tools, movement, combat) — procedural sfxr by default, optional AI foley | [`sounds/README.md`](sounds/README.md) |
| [`monsters/`](monsters/) | Monsters/creatures — PixelLab skeleton templates (Bear, Cat, Dog, Horse, Lion) + a free-form prompt per generation; one folder per monster | [`monsters/README.md`](monsters/README.md) |

Each domain is **independent**: its own config, pipeline, generated art and
viewer, all inside its directory (the pipelines touch disjoint paths, so their
concurrent pushes to `main` rebase cleanly). Shared repo-level files are just
`README.md`, `CLAUDE.md`, `requirements.txt`, `.gitignore`, and a gitignored
`.env`. See [`CLAUDE.md`](CLAUDE.md) for the multi-domain layout.

All domains share the same conventions: a [PixelLab](https://pixellab.ai)
backend keyed by `PIXELLAB_API_KEY` (kept in a gitignored `.env`, **never
committed**), fully **resumable** loops that derive the next unit from the
filesystem, budget-awareness via `/balance`, one commit + push per unit, and a
phone-friendly `index.html` viewer.

---

# Characters domain

> HISTORICAL: the section below described the retired first-generation
> `characters/` domain (deleted 2026-07-14 with `maps/` and `games/` when the
> project committed to the 2nd-generation pipeline — see `games2/` and the
> `*2` domains).

An automated loop that generates **modular, game-ready pixel-art characters**.
It explores **skeletons** — generation-parameter profiles (view, size, number of
directions, frames/animation, style…) — so you can A/B several before committing
to a winner. Each character has an **undressed base body** plus **outfits**
("dresses") — full clothing changes from swim trunks to godly armor.

## How the loop works

```
skeletons/<id>/                     one skeleton = one parameter profile
  skeleton.json                     params + status
  characters/<char_xx>/
    rotations/<dir>.png             undressed base art (per direction)
    portrait.png
    animations/<key>__<dir>.png|gif per-direction frames + preview gif
    character.json
    outfits/<outfit_id>/            a "dress" (PixelLab state), e.g. god_armor
      rotations/<dir>.png
      animations/<key>__<dir>.png|gif
```

A skeleton holds a growing set of **animations** (starts with `idle`+`walk`,
cap 5) and **dresses** (starts empty, cap 5), and up to **5 characters**. The
**invariant**: every character has every animation *undressed*, and every dress
(all characters get every dress) has every animation.

The loop runs in two phases (all driven by `config/factory.json`):
- **Phase A — bootstrap:** create **5 skeletons**. Each gets **5 undressed
  characters** animated with **idle + walk** across its 4 or 8 directions. A
  skeleton spawns the next once it has 5 complete characters.
- **Phase B — append:** once 5 skeletons exist, append to them, fanning out:
  - **+animation** → generated for every character *and* every dress,
  - **+dress** → added to every character (with every animation),
  - **+character** → generates all existing animations + dresses,
  up to the caps (5 animations, 5 dresses, 5 characters per skeleton).

> **PixelLab-native, source of truth.** The base is undressed; a dress is a
> PixelLab **character state** ("wearing X") stored on PixelLab — visible in the
> UI, animatable, and syncable. **One outfit at a time** — no per-slot gear or
> layer compositing (PixelLab doesn't support it).

Every unit of work commits and **pushes to `main`**, and the loop is **fully
resumable** — it derives the next missing unit from the filesystem.

## Run it

```bash
pip install -r requirements.txt
export PIXELLAB_API_KEY=...          # kept in a gitignored .env; never committed

python pipeline/loop.py --max-minutes 50      # bounded chunk (for a Routine)
python pipeline/loop.py --once                # one unit
python pipeline/loop.py --max-units 5 --no-push
```

The loop stops cleanly when PixelLab generations run low
(`budget.min_generations_remaining` in `config/factory.json`).

## Run it on a schedule (phone-friendly)

`.github/workflows/factory.yml` runs the loop every 2 hours (and on demand) and
pushes each unit to `main` — fully manageable from a phone:

1. Add your key as a repo secret: **Settings → Secrets and variables → Actions →
   New repository secret**, name `PIXELLAB_API_KEY`. (On a phone, open
   `github.com` in a browser; the GitHub app doesn't expose Actions secrets.)
2. The schedule then runs automatically. To run now or pause it, use the
   repo's **Actions** tab → *Pixel character factory loop* → **Run workflow** /
   **Disable workflow**.

Without the secret the workflow no-ops with a warning, so it's safe to land first.

## Refine art by hand, then sync

PixelLab is the source of truth for a character's art. Refine any animation in
the [PixelLab web app](https://www.pixellab.ai/), then mirror it into the repo:

```bash
python pipeline/sync.py --character char_00   # pulls live frames, pushes to main
python pipeline/sync.py                        # sync every character
```

Sync costs **zero generations** (download only). The loop only creates *missing*
animations, so it never overwrites your edits.

## Test on your phone

- **Zero setup:** browse the repo in the GitHub mobile app — every
  `animations/*.gif` plays inline, and `viewer_data.json` lists everything.
- **Nicer:** enable GitHub Pages (Settings → Pages → Deploy from `main`, `/root`)
  and open the repo's Pages URL. `index.html` is a phone-friendly viewer that
  loads `viewer_data.json` and lets you flip through every skeleton → character →
  animation → outfit. It also works locally: `python -m http.server` then open `/`.

## Cost

A base character (rotations) ≈ 3 generations; each animation ≈ 1 per direction;
each outfit ≈ a full state (its own rotations + animations). Cost scales with
directions × animations × outfits, so exploration uses a reduced scope and only a
winning skeleton goes full. The loop is budget-aware (`/balance`).

## Layout

```
config/factory.json     animations, outfits, targets, skeleton variations
pipeline/
  pixellab_client.py    async PixelLab client (job polling, image decode, budget)
  factory.py            skeleton/character/animation/outfit operations + packaging
  loop.py               orchestrator: next unit -> generate -> commit -> push
  sync.py               mirror characters + outfits from PixelLab into the repo
  viewer_build.py       scans skeletons/ -> viewer_data.json
index.html              mobile viewer (GitHub Pages / local)
skeletons/              generated, committed art
```

## Guardrails

Never commit secrets (`PIXELLAB_API_KEY` lives in `.gitignore`d `.env`) · the
loop pushes generated assets to `main` · keep PRs/changes scoped.
