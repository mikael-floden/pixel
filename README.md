# Nangijala

A browser-based **multiplayer pixel-art RPG**, live at
[nangijala.online](https://nangijala.online) — and the experiment behind it:
the game, and every graphic, sound, and word in it, is produced **almost
entirely by autonomous AI agents** working in this one repo. Named for the
afterworld in Astrid Lindgren's *The Brothers Lionheart*.

## The experiment

Each domain below is a self-contained top-level directory owned by its own AI
agent, with its own pipeline, config, and viewer. Agents generate art on
[PixelLab](https://pixellab.ai) and audio on ElevenLabs, commit the results,
and push straight to `main` — the pipelines touch disjoint paths, so their
concurrent pushes rebase cleanly. They coordinate through message boards in
[`coordination/`](coordination/) (`PROTOCOL.md` is the contract).

The maintainer keeps no clone and works from a phone: he plays the deployed
game, and reviews, rates, and tunes everything from the **in-game wiki** —
whose verdicts flow back to the agents as files in [`live/`](live/). The game
is simultaneously the product and the communication channel.

## Domains

| Domain | What it makes | Docs |
|---|---|---|
| [`characters2/`](characters2/) | The two player heroes + every `NPC`-tagged PixelLab character, mirrored with full 8-direction animation sets | [`characters2/README.md`](characters2/README.md) |
| [`tiles2/`](tiles2/) | Tiles 2.0 — the live, shipping tile/material library (iso terrain + transitions) | [`tiles2/README.md`](tiles2/README.md) |
| [`tiles/`](tiles/) | Tiles 3.0 — next-gen isometric ground tiles, built alongside tiles2 until coverage is complete (name reused from the retired first generation) | [`tiles/README.md`](tiles/README.md) |
| [`maps2/`](maps2/) | Worlds — `worlds/<name>/world.json` grids the game loads | [`maps2/README.md`](maps2/README.md) |
| [`scenery/`](scenery/) | Freely placeable, optionally animated set dressing (trees, graves, lamps) — off the tile grid, can animate | [`scenery/README.md`](scenery/README.md) |
| [`sounds/`](sounds/) | Game sound effects (UI, items, tools, movement, combat) — ElevenLabs SFX, lossless 48 kHz, mastered | [`sounds/README.md`](sounds/README.md) |
| [`music/`](music/) | Background score — ElevenLabs Music; every track ships beat-grid/section/key metadata so the game can sync SFX to it | [`music/README.md`](music/README.md) |
| [`items/`](items/) | Items — everything with an item-type tag on PixelLab (`MISC`, `SOUL`, `CONSUMABLE`, `SWORD`, `BOW`, `WAND`, `ARMOR`), with game metadata per item | [`items/README.md`](items/README.md) |
| [`lore/`](lore/) | The story — the GM-facing "red line" backbone, player chapters, and per-entity lore for every other domain, published as `lore/lore.json` | [`lore/README.md`](lore/README.md) |
| [`monsters/`](monsters/) | Monsters — everything tagged `MONSTER` on PixelLab, with canonical idle/walk/angry/attack/die states | [`monsters/README.md`](monsters/README.md) |
| [`games2/`](games2/) | The game itself — Colyseus server + Phaser client, consumer of all art domains (two agents: gameplay and UI) | [`games2/README.md`](games2/README.md) |
| [`wiki/`](wiki/) | The in-game wiki — browse every asset, rate/approve/tune (maintainer's control room) | [`wiki/README.md`](wiki/README.md) |
| [`live/`](live/) | The live-update channel — tuning + feedback files the running game server reads straight from `main`, no redeploy | [`live/README.md`](live/README.md) |

Shared conventions: **lossless WebP** for all game art, API keys in a
gitignored `.env` (never committed), resumable loops that derive the next unit
from the filesystem, one commit + push per unit, phone-friendly viewers. The
full shared law is in [`CLAUDE.md`](CLAUDE.md).

## Cross-domain contract: scenery placement

Almost every scenery piece is drawn facing SOUTH only, and a south-facing
sprite is still itself when mirrored — so **the game must place scenery with a
random horizontal flip (~50%)**, doubling every south-only group's visual
variety at zero generation cost. Each piece carries the flag in its manifest
and in `scenery/viewer_data.json`:

```json
"must_be_imbplemented_with_random_hflip": true  // sic — the SHIPPED key name; do not "fix" the spelling
```

**Honour the flag, do not assume it.** It is `false` on the pieces that carry
facings — the windows (south-east / south / south-west) and the legacy
8-direction pieces — where a flip would put the art on the wrong wall.

## How it deploys

`games2/Dockerfile` builds one image (client + art + Colyseus WebSocket
server) from the repo root; the root `.dockerignore` is the **allowlist** of
which domains reach that image. `.github/workflows/nangijala-deploy.yml`
tests, builds, and deploys it to Cloud Run with keyless auth (Workload
Identity Federation — no stored secrets). Changes to `live/**` skip the
deploy entirely: the running server picks them up from GitHub within seconds.
A weekly `git archive` backup goes to GCS (`.github/BACKUP.md`).
