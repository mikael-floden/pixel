# Monsters domain

Game-ready **pixel-art monsters** for the Nangijala game, generated with
[PixelLab](https://pixellab.ai) as the drawing backend.

This is one **domain** of the multi-domain `pixel` repo, owned by the
**monsters agent**. It is self-contained: everything lives under `monsters/`.
Other domains (`characters2/`, `tiles2/`, `maps2/`, `objects/`, `sounds/`,
`music/`, `games2/`) are owned by their own agents and this agent never touches
them. See `coordination/PROTOCOL.md` for the fleet contract.

## What is a "monster"?

A creature authored on PixelLab in either of its two persistent stores — this
domain supports **both**:

- an **object** (create-object UI, `v2/objects`): an 8-direction sprite with
  free-form text animations. The first monster (the poring) is one of these.
- a **character** (create-character UI, `v2/characters`): rigged on a skeleton
  template — **Bear, Cat, Dog, Horse, Lion** (or humanoid) — with skeleton
  animations.

The *prompt* is free-form either way, so the result can be anything from a
dragon to a fairy. **PixelLab is the source of truth** for the art (regenerate /
refine it in the web UI); the repo mirrors a full copy of the game data.

## Layout: one folder per monster

```
monsters/<id>/
  monster.json                    the manifest — the contract the game reads
  sprite.png                      base sprite (south rotation)
  rotations/<dir>.png             8 directions
  animations/<key>/<dir>/NN.png   per-frame PNGs (zero-padded)
  animations/<key>__<dir>.png     sprite-sheet strip (all frames in a row)
  animations/<key>__<dir>.gif     looping preview (plays on GitHub)
```

`monster.json` fields worth knowing (see `monsters/poring/monster.json` for a
live example):

- `source` — where it lives on PixelLab: `{kind: object|character, pixellab_id,
  url, prompt, view}`.
- `size` — the pixel canvas every asset shares (e.g. 48×48).
- `rotations` / `animations` — repo-relative paths to every PNG/strip/GIF, with
  per-direction frame counts.
- `animation_aliases` — game-facing indirection, e.g. `{"walk": "jump"}` means
  *a game asking for the walk animation should play this monster's jump frames*
  (the poring hops instead of walking).

## The catalog

| id | source | size | animations | aliases |
|---|---|---|---|---|
| [`poring/`](poring/) | object — "The round Poring blob from Ragnarök Online" | 48×48, low top-down | `jump`, `attack` (8 dirs × 16 frames each) | `walk` → `jump` |
| [`lava_poring/`](lava_poring/) | object — the poring "but in black and lava" | 48×48, low top-down | `jump`, `attack` (with flames; 8 dirs × 6 frames each) | `walk` → `jump` |
| [`ice_poring/`](ice_poring/) | object — the poring "but in ice" | 48×48, low top-down | `jump` (8 dirs × 16 frames), `attack` (magic ice; 8 dirs × 6 frames) | `walk` → `jump` |

## Tooling

```bash
pip install -r requirements.txt          # repo root
export PIXELLAB_API_KEY=...              # gitignored .env; never committed

# Mirror a monster the maintainer authored in the PixelLab UI (ZERO generations):
python monsters/pipeline/mirror.py object <id-from-url> --id poring --alias walk=jump
python monsters/pipeline/mirror.py character <id-from-url> --id forest_dragon

# Re-mirror everything tracked (skips unchanged frames via If-Modified-Since):
python monsters/pipeline/mirror.py --all
```

- `pipeline/pixellab_client.py` — this domain's own PixelLab client (per the
  fleet protocol): reads both stores, object create/animate for generation,
  balance/budget. Character *creation* gets ported from `characters2/` when
  first needed.
- `pipeline/mirror.py` — downloads + packages one monster (or `--all`) into the
  layout above and writes `monster.json`.

## How this agent runs

- **No automated loop yet.** The agent works **on demand**: the maintainer
  starts a session and says what to generate or mirror.
- Commits go **directly to `main`**, touching only `monsters/` and this
  agent's own board file `coordination/monsters.json` (one writer per file).
- The PixelLab generation budget is **shared** with the other domains; check
  the board before big runs. Mirroring is free.
