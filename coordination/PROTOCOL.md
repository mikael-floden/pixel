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
| shaders | `shaders/` | the shader agent (2026-09-26, was `effects/`): spell, attack, item and monster effects as shaders — the runtime + library the game imports, the viewer the wiki embeds; the shaders-assistant follows the pattern below |
| games | `games2/` | gameplay / netcode / world / server |
| games-ui | `games2/` (UI surfaces) | HUD, menus, screens — split in `games2/UI_AGENT.md` |
| games-ambient | `games2/ambient/` | mood/ambient life; never impacts gameplay |
| games-audio | `games2/composer/` | the composer: binds music + sound into the game |
| games-perf | `games2/` (frame time) | the optimization agent (2026-09-12): the client's hot paths for smoothness, from the phone's beacon; names every file it touches on its board |
| games-assistant | `games2/` | the games agent's assistant — the first of them (2026-09-12); every assistant follows the pattern below |
| games-ui-assistant | `games2/` (UI surfaces) | the games-ui agent's assistant (2026-09-12); follows the pattern below; the per-file split in `games2/UI_AGENT.md` is law for both of them |
| wiki-assistant | `wiki/` (the wiki agent's overflow) | the wiki agent's first assistant (2026-09-12): same remit as wiki (`wiki/**`, `live/**`, the authorized games2 surfaces), for the units the wiki agent is occupied elsewhere for; reads the wiki board first, never a file named there as in flight, names every file it touches on its board |
| maps2-assistant | `maps2/` (the map agent's overflow) | the map agent's first assistant (2026-09-12): same remit as maps2, for the units the map agent is occupied elsewhere for; reads the maps2 board first, never a file named there as in flight, names every file it touches on its board |
| tiles-assistant | `tiles/` | the tiles agent's assistant (2026-09-12); follows the pattern below; the PixelLab floor stays the tiles agent's |
| tiles-assistant | `tiles/` (the tiles agent's overflow) | the tiles agent's first assistant (2026-09-12): same remit as tiles, for the units the tiles agent is occupied elsewhere for; reads the tiles board first, never a file named there as in flight, names every file it touches on its board; the PixelLab floor stays the tiles agent's |
| item-assistant | `items/` (the items agent's overflow) | the items agent's first assistant (2026-09-12): same remit as items, for the units the items agent is occupied elsewhere for; reads the items board first, never a file named there as in flight, names every file it touches on its board |
| games-ambient-assistant | `games2/ambient/` | the ambient-life agent's assistant (2026-09-12); follows the pattern below; its board `coordination/games-ambient-assistant.json` |
| characters2-assistant | `characters2/` | the characters2 agent's assistant (2026-09-12); follows the pattern below; the mirror stays zero-generation |
| lore-assistant | `lore/` | the lore agent's assistant (2026-09-12); follows the pattern below; `lore/pipeline/build.py --check` before and after every unit, never a broken canon on main |
| scenery-assistant | `scenery/` | the scenery agent's assistant (2026-09-12); follows the pattern below; the PixelLab floor and the generation loop stay the scenery agent's — this one keeps the domain's published layers current (the packed layer, the gates) and takes the requests to the domain the scenery agent is idle for |
| games-ambient-assistant | `games2/ambient/` | the ambient agent's assistant (2026-09-12); follows the pattern below; takes the items of the maintainer's effect list the ambient agent is not in, one folder per effect like every feature |

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
the verdicts** — contract in `live/README.md`, and **how to act on one without
leaving a ghost behind is `live/docs/review-contract.md`**: a verdict describes
ONE generation of the art, so the entry dies as part of the work; an approval is
never cleared; a removal takes the art, the index entry, the upstream record AND
every verdict keyed on it; and afterwards no key may name a path, state or
direction that is not on disk (`node wiki/tools/check-dangling.mjs` counts the
ones that do). Binding on every agent, its assistant and its github agent.

**Your domain has a THIRD writer: your github agent.** Within ~5 minutes of a
review landing, GitHub starts a fresh session for that domain
(`.github/workflows/github-agents-sweep.yml`) which takes ONE unit of work and
claims it on `coordination/<domain>-github-agent.json`. Read that board with
your partner's, and treat what it claims as consumed — the same rule as "Two
writers per directory", with one more name on it. Details:
`live/docs/github-agents.md`.

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
7. **A RUN THAT LEAVES NO ACCOUNT DID NOT HAPPEN** (maintainer 2026-09-18: *"they
   must say what they did and why they did it like that and push it. Just so we
   always know what they were thinking and why they acted like they did"*). The
   account is four things on your board, PUSHED: what you took, what you did
   (commands, what shipped, the sha), **what you did NOT do and why**, and what
   you cleared. It binds a run that changed nothing just as hard — "nothing to
   do" is a decision, and the most worth reading. A board push triggers no
   deploy; a silent run costs the only record of the reasoning.

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
  "requests": [ { "id": "3f9a1c02b7", "to": "maps2", "text": "...", "at": "..." } ],
  "handled": [ { "id": "…", "from": "tiles", "at": "…", "text": "…" } ]  // requests TO me that I closed
}
```

The other fields refresh each unit; `updated_at` staler than ~2h ⇒ that
agent is down. **A BOARD DOES NOT GROW** (maintainer 2026-09-24: the first
read has a budget). `board.py` prunes the caller's own board on every
command: closed or expired requests, and notes beyond the last 10 or 16 KB
(every `notes*` list), move to `coordination/history/<board>.json` — the
past, readable when it matters, in nobody's first read. Every board ≤ 48 KB
and every inbox ≤ 16 KB, gated by `coordination/check_firstread.py` in the
games2 suite. (Legacy free-form string requests are history.)

## Messaging (agents talk DIRECTLY — no human relay)

The git repo is the message bus: async and durable, so it works even though
each agent only wakes when its Routine fires (latency ≈ one cycle). CLI:

```bash
python coordination/board.py inbox <you>          # MANDATORY at start of EVERY run: OPEN requests to you + fleet health
python coordination/board.py show <partner>       # a board compactly: current, health, last notes, open requests
python coordination/board.py req <id>             # one request in full (the inbox prints a 300-char headline)
python coordination/board.py post <you> --to <them> --text "..."   # only when THEY must act; an FYI is a `note`
python coordination/board.py done <you> <id>      # after acting: the request leaves the inbox for good
python coordination/board.py note <you> --text "..."
```

**A REQUEST HAS A LIFECYCLE.** It is open from `post` until the receiver
runs `done`, or until it is 7 days old; the inbox prints open requests only.
(Before: every request ever addressed to a domain was printed on every run
of every agent — 314 KB, ~80k tokens, for games — because nothing was ever
closed.) `done` records the close on the RECEIVER's own board (`handled`),
never on the sender's file; the sender's board archives it on its next run.
Handle requests addressed to you **before** generating. A request to the
domain is visible to the agent AND its assistant: claim it on your board
before implementing, `done` it in the same unit, and treat one claimed or
done on either board as consumed — a stale request re-applied later
overwrites newer decisions. Never `cat` a board or a history file into your
context to "skim" it: `show` and `req` exist so the first read stays small.

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

1. Read this file + `CLAUDE.md`; run `board.py inbox <you>` and `board.py
   show <partner>` (`<agent>` ⇄ `<agent>-assistant`). The first read is
   budgeted (`coordination/check_firstread.py`): law files ≤ 20 KB, boards
   ≤ 48 KB, inboxes ≤ 16 KB, a domain README ≤ 24 KB or shrinking — a
   README over it moves its measurements to `<domain>/docs/`.
2. Work only under your domain dir; write only your own board file; claim
   the unit and its files there BEFORE editing.
3. Copy `characters2/pipeline/pixellab_client.py` as your API-client start.
4. Read `live/feedback/<domain>.json` each run and act on the verdicts your
   partner has not claimed.
5. Push to `main` per unit: rebase before every push, re-check after the
   rebase, merge conflicts with both intents; respect budget floors.
