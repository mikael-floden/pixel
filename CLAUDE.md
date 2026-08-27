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

Each domain's own `README.md` (games2: `CLAUDE.md`) is the authority on how it
works. This map answers one question only — whose directory is that.

- `characters2/` — the two locked heroes + the tag-driven `NPC` mirror.
- `tiles2/` — Tiles 2.0, the live, shipping tile/material library.
- `tiles/` — Tiles 3.0, built **alongside** tiles2; nothing migrates until it
  covers everything the game needs.
- `maps2/` — the worlds the game loads (`maps2/worlds/<name>/world.json`), and
  **the maps2 agent is who places scenery** in them.
- `scenery/` — freely placeable, optionally animated set dressing: off the tile
  grid, and it can animate (tiles can't).
- `sounds/` — game SFX; `music/` — background score, each track shipping sync
  metadata. Both via ElevenLabs (`ELEVENLABS_API_KEY`).
- `items/` — everything carrying an item TYPE tag on PixelLab's objects store.
- `monsters/` — everything tagged `MONSTER` (objects AND characters stores).
- `lore/` — the story; no generation, no API. Writes only `lore/**`, publishes
  `lore/lore.json` where **the owning domain's own text always wins** and lore
  only fills gaps.
- `games2/` — the game itself: consumer of every art domain and **read-only
  toward them**. The ONE domain shared by TWO agents (maintainer decision) —
  the game agent and the games-ui agent; split in `games2/UI_AGENT.md`.
- `wiki/` — browses everything the agents produce; the maintainer rates,
  approves/rejects and tunes from inside it.
- `live/` — the LIVE-UPDATE channel: read by the running game server **straight
  from GitHub `main`, no redeploy**. Tuning overrides + the maintainer's
  per-domain feedback files, which agents must read each run.
- `coordination/` — `PROTOCOL.md` (the inter-agent contract) + one board file
  per agent (`board.py` to use them).
- RETIRED 2026-07-14: the first generation (`characters/`, `maps/`, `games/`,
  the old tiles registry + #emission demo) — history in git. The `tiles/` name
  was reused for Tiles 3.0; `scenery/` was `objects/` until 2026-08-12.

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

**CACHE SAFETY IS ABSOLUTE (maintainer law, 2026-08-27).** "You must NEVER EVER EVER
introduce a cache bug again. The next time I see a cache bug I delete the entire
project." Cache bugs killed his last two projects; this is not hyperbole. The rule
that makes them structurally impossible: **a published, regenerable asset is never
rewritten under a stable name** - a regenerated file gets a NEW filename carrying its
content hash, the index points at the current name, the stale name is deleted, and
consumers read names from the index rather than constructing them. A stale cache may
then show a coherent old version or a 404 - never a mix of generations.
`tiles/pipeline/check_immutable.py` gates every tiles publish (0 mutable names, 0
dangling references, every content hash re-verified); any domain that serves or
caches assets follows the same rule. Write-once assets (raw generator output) may
keep stable names - the law binds anything a pipeline can regenerate.

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
