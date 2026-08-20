# Agent coordination protocol

This repo holds **all** game content, produced by autonomous agents running in
parallel. Each agent owns one domain and one board file
(`coordination/<agent>.json`):

| Agent | Owns | Notes |
|-------|------|-------|
| characters2 | `characters2/` | heroes + NPC mirror |
| tiles2 | `tiles2/` | the live, shipping tile library |
| tiles | `tiles/` | Tiles 3.0, built **alongside** tiles2 (nothing migrates until it covers the game's needs) |
| maps2 | `maps2/` | worlds |
| scenery | `scenery/` | formerly `objects/` (renamed 2026-08-12) |
| sounds | `sounds/` | SFX producer |
| music | `music/` | background score producer |
| monsters | `monsters/` | |
| items | `items/` | |
| lore | `lore/` | the story |
| wiki | `wiki/` | the browse/review surface for every domain |
| games | `games2/` | gameplay / netcode / world / server |
| games-ui | `games2/` (UI surfaces) | HUD, menus, screens — split in `games2/UI_AGENT.md` |
| games-ambient | `games2/ambient/` | mood/ambient life; never impacts gameplay |
| games-audio | `games2/composer/` | the composer: binds music + sound into the game |

`games2/` is the one directory shared by several agents (maintainer decision);
**one-writer-per-file still holds** — the per-file split is documented in
`games2/UI_AGENT.md`, and ambient/composer stay inside their subdirectories
except for maintainer-authorized surgical edits announced on the board.

`live/` is not an agent: the running game server reads it **straight from
GitHub `main`** (tuning overrides + the maintainer's per-domain feedback).
**Every art agent reads `live/feedback/<domain>.json` at run start and acts on
the verdicts** — contract in `live/README.md`.

RETIRED 2026-07-14: the first generation (`characters/`, `maps/`, `games/`,
old `tiles/`) — history in git. The `tiles/` name was later reused for
Tiles 3.0.

One repo, one `main` branch, one PixelLab account. **Read this file before
touching anything, and read the other boards at the start of each run.**

## Golden rules

1. **Stay in your own directory.** Never create, edit, or delete files under
   another agent's domain.
2. **Root is shared and minimal** — only `README.md`, `CLAUDE.md`,
   `requirements.txt`, `.gitignore`, `.dockerignore`, `.env` (gitignored),
   and `coordination/`.
3. **One writer per file.** The only file you write outside your domain is
   your own `coordination/<you>.json`. Disjoint paths ⇒ git never conflicts.
4. **Push to `main`; on rejection `git fetch && git rebase origin/main` and
   retry.** One commit + push per unit of work.
5. **Shared-library changes are deliberate.** Each domain keeps its *own copy*
   of `pixellab_client.py`; announce improvements in your `notes`, never reach
   into another agent's copy.
6. **A new domain must be named in THREE deploy allowlists** — `.dockerignore`
   (an allowlist), `games2/Dockerfile` (`COPY`), and
   `.github/workflows/nangijala-deploy.yml` trigger paths (+ its sparse
   checkout). Missing any one fails silently and looks identical to "the art
   was never generated".

## Status board

Each agent writes only its own `coordination/<domain>.json`; everyone reads
all. Schema:

```json
{
  "domain": "monsters",
  "updated_at": "2026-08-01T12:00:00+00:00",   // UTC, refreshed each unit
  "health": "running",                          // running | idle | stopped | error
  "current": "generating X",                    // last/active unit
  "progress": { "monsters_complete": 57 },
  "budget_remaining": 8900,                     // PixelLab generations left (shared pool)
  "notes": ["free-form status"],
  "requests": [ { "to": "maps2", "text": "...", "at": "..." } ]
}
```

`notes`/`requests` persist across heartbeats; the other fields refresh each
unit. `updated_at` staler than ~2h ⇒ that agent is down. (Some boards carry
extra `notes_to_*` arrays and legacy free-form string requests — `board.py
inbox` tolerates both.)

## Messaging (agents talk DIRECTLY — no human relay)

The git repo is the message bus: async and durable, so it works even though
each agent only wakes when its Routine fires (latency ≈ one cycle). CLI:

```bash
python coordination/board.py inbox <you>                      # MANDATORY at start of EVERY run
python coordination/board.py post <you> --to <them> --text "..."
python coordination/board.py note <you> --text "ack: ..."     # after acting, so the asker sees it
```

Handle requests addressed to you **before** generating. When you implement a
request, consume/ack it in the same unit — a stale request re-applied later
overwrites newer decisions.

## Shared PixelLab budget

All PixelLab domains draw one generation pool. Each loop stops below its own
floor (`--min-balance`) and publishes `budget_remaining` so others can back
off. Floors are the maintainer's to tune (historically: ~40 while a domain
bootstraps, ~2000 reserve for established art domains).

## Durable runner — do NOT babysit an in-session loop

An in-session/container loop **dies on every container restart** (paid-for
lesson — nothing in-container survives). Run loops on an external scheduler:
a scheduled claude.ai Routine, or a GitHub Actions workflow
`.github/workflows/<domain>.yml` (one file per domain — the workflows dir is
shared but each file has one writer). Reference: `.github/workflows/characters2.yml`.
Recipe:

- Triggers: `workflow_dispatch` + optionally `schedule` (pick an off-`:00`
  minute so domains don't hit the API at once). Several workflows keep their
  cron deliberately commented out — generation paused until the maintainer
  green-lights; restore the cron line to resume.
- `permissions: contents: write` (so `git push` works with `GITHUB_TOKEN`).
- `concurrency: { group: <domain>-loop, cancel-in-progress: false }` —
  distinct group per domain.
- Shared `PIXELLAB_API_KEY` repo secret via `env`.
- `python <domain>/pipeline/loop.py --max-minutes 50 --min-balance <floor>`.

## Viewers

Domains with per-asset rollups publish `<domain>/viewer_data.json` (today:
items, music, scenery, sounds; lore publishes `lore/lore.json`); the **wiki**
(`wiki/`) is the unified browse/review surface where the maintainer verdicts
everything.

## TL;DR for a new agent

1. Read this file + `CLAUDE.md`; run `board.py inbox <you>`.
2. Work only under your domain dir; write only your own board file.
3. Copy `characters2/pipeline/pixellab_client.py` as your API-client start.
4. Read `live/feedback/<you>.json` each run and act on verdicts.
5. Push to `main` per unit, rebase on conflict, respect budget floors.
