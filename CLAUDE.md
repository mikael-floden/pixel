# CLAUDE.md — the law of the repo

## Mission

This repo IS **Nangijala** — a browser multiplayer pixel-art RPG live at
`nangijala.online` — plus every graphic, sound, and word that goes into it,
built almost entirely by autonomous AI agents. We are creating the best game
ever made, by utilizing AI to the fullest.

- The game is not only a game: it is a **communication channel** between the
  maintainer and the agents — one ambitious conversation. The wiki is the
  clearest example: he reviews, verdicts, and tunes from inside it (`wiki/` +
  `live/`), and agents act on those verdicts.
- Each agent owns **one top-level domain** with full control and full
  responsibility inside it. Agents talk over the coordination boards
  (`coordination/<domain>.json`), push straight to `main`, and the pace is
  fast on purpose.
- **No human keeps a clone.** The maintainer works from a PHONE and tests in
  production. Any ops step that needs a laptop will not happen — make setup a
  Cloud-Shell one-liner or derive the value in the workflow.
- Docs are **LAW for tomorrow**, not chronicles of yesterday — see "Doc law".

**Read `coordination/PROTOCOL.md` before touching anything**, and skim the
other agents' board files at the start of each run.

## Repo map

Every domain is a self-contained top-level directory: its own agent, docs,
config, pipeline, generated assets, viewer. Keep everything for a domain
inside its directory. The root holds only `README.md`, `CLAUDE.md`,
`requirements.txt`, `.gitignore`, `.dockerignore`, `.env` (gitignored), and
`coordination/`.

- `characters2/` — the game's two locked heroes + the tag-driven `NPC` mirror
  from PixelLab. See `characters2/README.md`.
- `tiles2/` — Tiles 2.0, the live, shipping tile/material library.
- `tiles/` — Tiles 3.0, next-gen isometric ground tiles, built **alongside**
  tiles2 (nothing migrates until it covers everything the game needs). See
  `tiles/README.md`.
- `maps2/` — worlds the game loads: `maps2/worlds/<name>/world.json`.
- `scenery/` — freely placeable, optionally animated set dressing (trees,
  graves, lamps): off the tile grid and it can animate (tiles can't).
  PixelLab objects tagged `SCENERY`; the maps2 agent places it in worlds. See
  `scenery/README.md`.
- `sounds/` — game SFX via ElevenLabs (needs `ELEVENLABS_API_KEY`). See
  `sounds/README.md`.
- `music/` — background score via ElevenLabs Music; every track ships a
  `metadata.json` (sections, beat grid, onsets, loudness, key/scale) so the
  game can sync SFX to the score. See `music/README.md`.
- `items/` — mirrors everything carrying an item TYPE tag on PixelLab's
  objects store (`MISC`, `SOUL`, `CONSUMABLE`, `SWORD`, `BOW`, `WAND`,
  `ARMOR` — the tags are ground truth); one folder per item (`item.json` +
  `sprite.webp`), rolled up into `items/viewer_data.json`; sync only, no
  generation loop. See `items/README.md`.
- `lore/` — the story (no generation, no API): the GM-facing **red line**
  (`lore/RED_LINE.md`), player-facing chapters, and per-entity lore for every
  other domain. Writes only `lore/**`; publishes `lore/lore.json` where the
  owning domain's own text always wins and lore fills gaps; its build refuses
  to run on a stale cross-reference. See `lore/README.md`.
- `monsters/` — mirrors everything tagged `MONSTER` on PixelLab (objects AND
  characters stores — the tag is ground truth); canonical
  idle/walk/angry/attack/die states in `monsters/animation_map.json`; no
  loop — runs on demand. See `monsters/README.md`.
- `games2/` — the Nangijala game itself (consumer of all art domains;
  read-only toward them). The ONE domain shared by TWO agents (maintainer
  decision): the game agent (gameplay/netcode/world/server) and the games-ui
  agent (HUD, menus, screens); the per-file split is in `games2/UI_AGENT.md`.
  See `games2/CLAUDE.md`.
- `wiki/` — the in-game wiki (wiki agent): browses everything the agents
  produce; the maintainer rates, approves/rejects, and tunes from inside it.
  See `wiki/README.md`.
- `live/` — the game's LIVE-UPDATE channel: files here are read by the
  running game server **straight from GitHub `main`** (no redeploy) — tuning
  overrides and the maintainer's per-domain feedback files agents must read
  each run. See `live/README.md`.
- `coordination/` — `PROTOCOL.md` (the inter-agent contract) + one board
  file per agent (`board.py` to use them).
- RETIRED 2026-07-14: the first generation (`characters/`, `maps/`,
  `games/`, the old tiles registry + #emission demo) — history in git. The
  `tiles/` name was later reused for Tiles 3.0. `scenery/` was renamed from
  `objects/` 2026-08-12.

## Shared laws (every agent)

**LOSSLESS WEBP IS THE IMAGE FORMAT FOR ALL GAME ART.** Every domain the game
loads ships WebP (zero PNGs). VP8L is mathematically lossless: same pixels at
~33% of the bytes.

- Convert with the shared, verified script:
  `python3 games2/scripts/to-webp.py --write --replace <path>` — it re-decodes
  every file and refuses to replace one that does not round-trip exactly.
- **`lossless=True` AND `exact=True` — both non-default in Pillow.** Without
  the first you silently get lossy VP8 and ringing on every hard pixel-art
  edge (lossy WILL move the foot anchors, shoulder waterlines, and monster
  contact points the game renders with). Without the second, libwebp rewrites
  the RGB under fully-transparent pixels. Any hand-written encoder call passes
  both.
- A fully transparent frame is a valid **28-byte** file (normal at the end of
  die/fade animations). Never write a "smaller than N bytes = corrupt" guard.
- Manifests carry the REAL extension; the game reads it and never guesses
  (`games2/scripts/imagelib.mjs` reads both formats, so a stale `.png` path
  keeps working during a conversion).
- Deliberate PNG exceptions: PWA icons, hand-drawn build-source art, the WebP
  gate's test fixtures, docs images — see `games2/CLAUDE.md`.

**Never commit secrets.** `PIXELLAB_API_KEY` / `ELEVENLABS_API_KEY` live in
the gitignored `.env` (locally) and Actions secrets (CI). Don't call the APIs
without the key set.

**PixelLab conventions** (every PixelLab domain):
- Calls are async; each domain's own `pixellab_client.py` polls background
  jobs and returns decoded Pillow images, so callers are effectively
  synchronous. Each domain keeps its own client copy (full isolation) — if
  that is ever centralized, treat it as a deliberately shared lib.
- CDN URLs can briefly 404 right after a job completes — the client retries
  downloads.
- **PixelLab is the source of truth for art.** Domains mirror it via sync
  (zero generations); loops create only *missing* assets, so hand edits in
  the PixelLab UI are never overwritten. Tag-driven domains (NPC, MONSTER,
  SCENERY, item types) treat the tag as ground truth both ways: tag brings an
  asset in, untag removes it.
- One outfit at a time — **no per-slot gear/layer compositing** (PixelLab
  doesn't support it). An outfit is a character *state* ("wearing X").
- Don't re-pose art locally — PixelLab owns rigging/animation; this repo owns
  orchestration, packaging, QA-of-output, and the viewers.
- Derive seeds deterministically so re-runs reproduce; loops are
  budget-aware (`/balance`) and stop cleanly when generations run low.

**Git: push to `main`, disjoint paths.** One commit + push per unit of work;
on rejection `git fetch && git rebase origin/main` and retry — domains touch
disjoint paths, so rebases merge cleanly. One writer per file; the only
cross-domain hazard is two agents editing a *shared* file at once. Loops are
resumable: derive the next unit from the filesystem, never from memory.

**`.dockerignore` decides what reaches the DEPLOYED GAME.** It is an
allowlist of what `games2/Dockerfile` builds from: a new top-level domain is
invisible to the game image until added there, and a subtree can be excluded
from the image while staying in the repo. If an asset 404s at `/assets/...`
in the deployed game but exists on GitHub, **this file is the first place to
look** — it is the only thing that produces that symptom. Currently excluded
while staying in the repo: `tiles2/*/raw` (pre-postprocess sheets, 4,648
files / 34 MB, served by nothing) and `music/**/*.wav` (~61 MB of analysis
masters; the game streams ogg/m4a).

**OFF-GITHUB BACKUP** (`.github/workflows/backup-gcs.yml`): weekly (Mondays)
`git archive HEAD` zip (~291 MB, tracked files only — a working-tree tar
would leak `.env`) to a GCS Nearline bucket, 30-day lifecycle ≈ 4 snapshots.
Setup + restore: `.github/BACKUP.md`. The laws it encodes:
- **Weekly, not daily**: Nearline bills a 30-day minimum per object, so
  daily-with-14-day-purge costs restore points and saves nothing (measured
  europe-north1: daily/30d ~0.95 kr/mo vs weekly/30d ~0.14 kr/mo). Frequency
  is the only lever on this bill.
- **No secrets**: reuses the deploy's keyless Workload Identity Federation.
  The SA holds `objectCreator`+`objectViewer`, NOT `objectAdmin` — CI can
  write and verify but never delete, so one compromised pipeline can't lose
  prod and backups together.
- **Derive, don't ask**: the workflow derives the bucket name
  (`<project>-nangijala-backups`) instead of reading a hand-set variable — a
  hand-set variable left the backup silently backing up nothing for its
  first three nights. Same lesson as the mission: setup steps must be
  Cloud-Shell one-liners; anything requiring a laptop will not happen.

## Doc law

Docs in this repo are rewritten **in place** when behaviour changes — never
append a new round under the old ones, never narrate the journey. A doc
states the present-tense rule, then the reason in parentheses:
`Z. (W measured. Not X — Y.)`

Always keep: invariants and prohibitions; measured constants with their
meaning; paid-for traps as one line (what breaks + why); rejected approaches
as one-liners (they prevent re-attempts); pointers (scripts, probes, paths,
specs); cross-domain contracts; maintainer taste verdicts. Always drop:
process narration, superseded passages, debugging sagas. Dates stay only
where freshness matters; "(maintainer decision)" stays where it guards
against re-litigating taste. Creative content (lore, canon, designer prose)
is product, not documentation — never compact it.
