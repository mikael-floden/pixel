# Monsters domain

Game-ready **pixel-art monsters** for the Nangijala game, generated with
[PixelLab](https://pixellab.ai) as the drawing backend.

This is one **domain** of the multi-domain `pixel` repo, owned by the
**monsters agent**. It is self-contained: everything lives under `monsters/`.
Other domains (`characters2/`, `tiles2/`, `maps2/`, `objects/`, `sounds/`,
`games2/`) are owned by their own agents and this agent never touches them.
See `coordination/PROTOCOL.md` for the fleet contract.

## What is a "monster"?

A monster is a creature generated via the PixelLab API. PixelLab provides
**skeleton templates** the generation can be rigged on:

- **Bear**, **Cat**, **Dog**, **Horse**, **Lion**

The *prompt* is free-form, so the result can be anything from a dragon to a
fairy — the skeleton just picks the body plan / animation rig that fits best
(a dragon might ride on the Horse or Lion skeleton, a small imp on the Cat).
Each generation pairs one skeleton with one unique prompt.

## Layout: one folder per monster

Every monster is downloaded from PixelLab and committed as **its own folder**:

```
monsters/<id>/            e.g. monsters/forest_dragon/
  monster.json            manifest: prompt, skeleton, sizes, files (planned)
  ...art files...         sprites / rotations / animation frames + preview GIFs
```

The only non-monster things under `monsters/` are docs and (future) tooling.
No monsters have been generated yet — the concrete manifest/file format will be
locked in with the first generation.

## How this agent runs

- **No automated loop yet.** The agent works **on demand**: the maintainer
  starts a session and says what to generate. A loop/Routine may come later.
- Commits go **directly to `main`**, touching only `monsters/` and this
  agent's own board file `coordination/monsters.json` (one writer per file).
- `PIXELLAB_API_KEY` comes from the environment / gitignored `.env` — never
  committed. The PixelLab generation budget is **shared** with all other
  domains; check the board before big runs.
