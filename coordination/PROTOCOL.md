# Agent coordination protocol

This repo holds **all** game content, produced by autonomous agents running in
parallel. Each domain is worked by one agent and that agent's assistant, and
every one of them owns one board file (`coordination/<agent>.json`):

| Agent | Owns | Notes |
|-------|------|-------|
| characters2 | `characters2/` | heroes + NPC mirror |
| tiles | `tiles/` | Tiles 3.0 — THE tile library (tiles2 retired 2026-09-09, history in git) |
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
| games-perf | `games2/` (frame time) | the optimization agent (2026-09-12): the client's hot paths for smoothness, from the phone's beacon; names every file it touches on its board |
| games-assistant | `games2/` | the games agent's assistant — the first of them (2026-09-12); every assistant follows the pattern below |
| wiki-assistant | `wiki/` (the wiki agent's overflow) | the wiki agent's first assistant (2026-09-12): same remit as wiki (`wiki/**`, `live/**`, the authorized games2 surfaces), for the units the wiki agent is occupied elsewhere for; reads the wiki board first, never a file named there as in flight, names every file it touches on its board |
| maps2-assistant | `maps2/` (the map agent's overflow) | the map agent's first assistant (2026-09-12): same remit as maps2, for the units the map agent is occupied elsewhere for; reads the maps2 board first, never a file named there as in flight, names every file it touches on its board |
| tiles-assistant | `tiles/` | the tiles agent's assistant (2026-09-12); follows the pattern below; the PixelLab floor stays the tiles agent's |

**Every agent above has an assistant, `<agent>-assistant`** (maintainer
2026-09-12: "an assistant that works with the same tasks and in the same
folder as the original agent"): the same directory, the same remit, the same
README/`CLAUDE.md` and `live/feedback` as law, its own board
`coordination/<agent>-assistant.json`. So no directory has one writer any
more — "Two writers per directory" below is what keeps two agents in one
folder from overwriting each other. `games2/` is shared wider still
(maintainer decision): the per-file split is `games2/UI_AGENT.md`, and
ambient/composer stay inside their subdirectories except for
maintainer-authorized surgical edits announced on the board.

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
3. **One writer per file AT A TIME — the boards say who.** The only file you
   write outside your domain is your own `coordination/<you>.json`. Inside
   your domain, a file your partner's board names in flight is not yours
   until that unit ships.
4. **Push to `main`; `git fetch && git rebase origin/main` before EVERY push,
   re-check after the rebase, merge conflicts with both intents.** One
   commit + push per unit of work. Procedure: "Two writers per directory".
5. **Shared-library changes are deliberate.** Each domain keeps its *own copy*
   of `pixellab_client.py`; announce improvements in your `notes`, never reach
   into another agent's copy.
6. **A new domain must be named in THREE deploy allowlists** — `.dockerignore`
   (an allowlist), `games2/Dockerfile` (`COPY`), and
   `.github/workflows/nangijala-deploy.yml` trigger paths (+ its sparse
   checkout). Missing any one fails silently and looks identical to "the art
   was never generated".

## Two writers per directory

Your assistant (or your agent) works the same tasks in the same directory.
Two writers in one folder is exactly the case the old law excluded, so a
rebase can now conflict — and a rebase that applies cleanly can still be
broken: the partner may have changed the function you call, the doc you
rewrote, or the index you regenerated. Every unit, in this order:

1. **Start on `origin/main`**: `git fetch && git rebase origin/main` (or a
   fresh checkout). Read the partner's board — `current`, its latest notes,
   the requests to the domain — before choosing a unit.
2. **Claim, then push the claim**: set your board's `current` to the unit
   AND every file it will touch (paths, not descriptions), commit, push. The
   push carries only the board, so it costs one cycle of latency and no
   deploy (`coordination/**` is not a deploy trigger); a claim that ships
   with the work protects nothing. Never take a unit or a file the partner's
   board names in flight. When both boards name the same file, the original
   agent's claim stands and the assistant re-plans — a fixed tie-break beats
   a two-cycle standoff.
3. **Do the unit.** Run the domain's checks as usual.
4. **Rebase before the push, not on rejection**: `git fetch && git rebase
   origin/main`. If `origin/main` moved under your directory, the checks run
   AGAIN on the rebased tree — typecheck, tests, gates — and a regenerable
   index (`viewer_data.json`, a manifest, a catalog) is rebuilt from the
   filesystem, never merged hunk by hunk. What passed before the rebase
   proves nothing about what you are about to push.
5. **Conflicts are merged, never overruled.** Read the partner's commit
   (`git log -p origin/main -- <file>`) and keep both intents. Never
   `--ours`/`--theirs` over a partner's hunk; never a force-push; never a
   revert of a partner's commit to make yours apply. Both sides changed the
   same logic and either choice loses behaviour → keep that file out of the
   push, post to the partner naming both versions, ship the rest.
6. **Push, then release the claim**: note what shipped (commit hash + the
   files) and set `current` to the next unit or to idle, so the partner's
   next run sees those files free.

Requests to the domain and `live/feedback/<domain>.json` verdicts are read by
both of you and taken ONCE: whoever claims one on their board first has it,
and claimed or acked on EITHER board means consumed — the same request
implemented twice re-applies a stale decision over the newer one.

Loops (`loop.py` and the like) derive the next unit from the filesystem AND
the partner's claim: two loops that both fill "the missing assets" generate
the same asset twice, paying twice for one PixelLab file and colliding on
its path. The shared budget floor is per pool, not per agent.

## Status board

Each agent writes only its own `coordination/<domain>.json`; everyone reads
all. Schema:

```json
{
  "domain": "monsters",
  "updated_at": "2026-08-01T12:00:00+00:00",   // UTC, refreshed each unit
  "health": "running",                          // running | idle | stopped | error
  "current": "generating X — files: a/b.py, a/c.json", // the active unit + every file it touches (the claim)
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

Handle requests addressed to you **before** generating. A request to the
domain is visible to the agent AND its assistant: claim it on your board
before implementing, consume/ack it in the same unit, and treat one claimed
or acked on either board as consumed — a stale request re-applied later
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
`.github/workflows/<agent>.yml` (one file per agent, the assistant's its own —
the workflows dir is shared but each file has one writer). Reference:
`.github/workflows/characters2.yml`.
Recipe:

- Triggers: `workflow_dispatch` + optionally `schedule` (pick an off-`:00`
  minute so domains don't hit the API at once). Several workflows keep their
  cron deliberately commented out — generation paused until the maintainer
  green-lights; restore the cron line to resume.
- `permissions: contents: write` (so `git push` works with `GITHUB_TOKEN`).
- `concurrency: { group: <agent>-loop, cancel-in-progress: false }` —
  distinct group per agent (the assistant's loop runs beside its agent's;
  the board claim, not the runner, keeps them off the same files).
- Shared `PIXELLAB_API_KEY` repo secret via `env`.
- `python <domain>/pipeline/loop.py --max-minutes 50 --min-balance <floor>`.

## Viewers

Domains with per-asset rollups publish `<domain>/viewer_data.json` (today:
items, music, scenery, sounds; lore publishes `lore/lore.json`); the **wiki**
(`wiki/`) is the unified browse/review surface where the maintainer verdicts
everything.

## TL;DR for a new agent

1. Read this file + `CLAUDE.md`; run `board.py inbox <you>`; read your
   partner's board (`<agent>` ⇄ `<agent>-assistant`).
2. Work only under your domain dir; write only your own board file; claim
   the unit and its files there BEFORE editing.
3. Copy `characters2/pipeline/pixellab_client.py` as your API-client start.
4. Read `live/feedback/<domain>.json` each run and act on the verdicts your
   partner has not claimed.
5. Push to `main` per unit: rebase before every push, re-check after the
   rebase, merge conflicts with both intents; respect budget floors.
