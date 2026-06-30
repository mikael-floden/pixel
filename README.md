# Modular Pixel Character Factory

An automated loop that generates **modular, game-ready pixel-art characters** in
the style of *Grave Seasons* / Stardew Valley, using [PixelLab](https://pixellab.ai)
as the drawing backend.

The repo explores **skeletons** — generation-parameter profiles (view, size,
number of directions, frames/animation, style…) — so you can A/B several before
committing to a winner. For each skeleton the loop builds a roster of characters,
gives each the full animation set, and generates modular gear, then moves on to
the next skeleton.

## How the loop works

```
skeletons/<id>/                     one skeleton = one parameter profile
  skeleton.json                     params + status
  characters/<char_xx>/
    rotations/<dir>.png             8-direction base art
    portrait.png
    animations/<key>__<dir>.png     per-direction frame strips (game-ready)
    animations/<key>.gif            preview (mobile-viewable)
    character.json
  gear/<slot>/<gear_id>.png         gear, shared across the skeleton's roster
  gear/gear.json
```

For each skeleton, in order (all driven by `config/factory.json`):
1. create **10 base characters** (8 rotations each),
2. give every character the **25 animations** (idle, walk, run, jump, crouch,
   fall, kicks/punches standing/crouching/air/running, low/med/high landings,
   and front/back/crouch damage reactions),
3. generate **3 gear items per equippable slot** (pants, boots, gloves,
   armor/tunic, helmet/hat) — shared across the roster,
4. mark the skeleton complete and open the next one with new parameters.

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

## Test on your phone

- **Zero setup:** browse the repo in the GitHub mobile app — every
  `animations/*.gif` plays inline, and `viewer_data.json` lists everything.
- **Nicer:** enable GitHub Pages (Settings → Pages → Deploy from `main`, `/root`)
  and open the repo's Pages URL. `index.html` is a phone-friendly viewer that
  loads `viewer_data.json` and lets you flip through every skeleton → character →
  animation → gear. It also works locally: `python -m http.server` then open `/`.

## Cost

On PixelLab a base character (8 rotations) ≈ 3 generations and each animation ≈ 1
per direction, so a side-view (east-only) character with all 25 animations ≈ ~28
generations. The loop is budget-aware; check remaining balance with the API's
`/balance` endpoint.

## Layout

```
config/factory.json     animations, gear slots, targets, skeleton variations
pipeline/
  pixellab_client.py    async PixelLab client (job polling, image decode, budget)
  factory.py            skeleton/character/animation/gear operations + packaging
  loop.py               orchestrator: next unit -> generate -> commit -> push
  viewer_build.py       scans skeletons/ -> viewer_data.json
index.html              mobile viewer (GitHub Pages / local)
skeletons/              generated, committed art
```

## Guardrails

Never commit secrets (`PIXELLAB_API_KEY` lives in `.gitignore`d `.env`) · the
loop pushes generated assets to `main` · keep PRs/changes scoped.
