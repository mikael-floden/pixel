# Agent coordination protocol

This repo holds **all** game graphics, produced by several autonomous agents that
run in parallel — each owns one top-level domain directory:

| Domain | Directory | Owner agent |
|--------|-----------|-------------|
| Characters, 2nd gen | `characters2/` | characters2 agent |
| Tiles/materials, 2nd gen | `tiles2/` | tiles2 agent |
| Worlds, 2nd gen | `maps2/` | maps2 agent |
| Animated props / map objects | `objects/` | objects agent |
| Sounds | `sounds/` | sounds agent |
| Music (background score) | `music/` | music agent |
| Monsters/creatures | `monsters/` | monsters agent |
| The game (consumer) | `games2/` | game agent |
| The game's UI/HUD/menus | `games2/` (UI surfaces) | games-ui agent |

`games2/` is the one domain shared by TWO agents (maintainer decision
2026-07-17): the game agent (gameplay/netcode/world/server) and the games-ui
agent (HUD, menus, screens, overlays). One-writer-per-file still holds — the
per-file split inside `games2/` is documented in `games2/UI_AGENT.md`; the
games-ui agent's board file is `coordination/games-ui.json`.

RETIRED 2026-07-14: `characters/`, `maps/`, `games/`, `tiles/` — the first
generation (domains + game + the old emission registry/demo), deleted after
the 2nd generation took over (paused workflows factory/maps/tiles.yml and
the stale boards characters/maps/tiles.json removed too). History is in git.

They share one repo, one `main` branch, and one PixelLab account. This document
is the contract that lets them work at the same time without stepping on each
other. **Read it before touching anything, and skim the other agents' status
files (below) at the start of each run.**

## Golden rules

1. **Stay in your own top-level directory.** Never create, edit, or delete files
   under another agent's domain dir. Your generated art, config, pipeline, and
   viewer all live inside your dir.
2. **Root is shared and minimal.** Only `README.md`, `CLAUDE.md`,
   `requirements.txt`, `.gitignore`, `.env` (gitignored), and this
   `coordination/` dir live at the root. Don't add domain files to the root.
3. **One writer per file.** The only files you may write outside your domain dir
   are your *own* coordination files: `coordination/<your-domain>.json`. Never
   write another agent's coordination file. This guarantees git never conflicts
   (disjoint paths auto-merge on rebase).
4. **Push to `main`, rebase on failure.** Each unit of work: commit + `git push
   origin main`; on rejection `git fetch && git rebase origin/main` and retry.
   Because domains touch disjoint paths, rebases merge cleanly.
5. **Shared library changes are deliberate.** Each domain keeps its *own copy* of
   `pixellab_client.py` (full isolation — no shared-file conflicts). If you
   improve the client and think others want it, say so in your status `notes`;
   don't reach into their copy.

## Status board (heartbeat + who's doing what)

Each agent continuously writes `coordination/<domain>.json` (it owns that file;
everyone else reads it). Read the others at the start of each run to see the
whole fleet. Schema:

```json
{
  "domain": "characters",
  "updated_at": "2026-07-01T12:00:00+00:00",   // UTC, refreshed each unit
  "health": "running",                          // running | idle | stopped | error
  "current": "generating char_05 walk",         // last/active unit
  "progress": { "skeletons": 1, "characters": 6 },
  "budget_remaining": 8900,                      // PixelLab generations left (shared pool)
  "notes": ["free-form status for humans/agents"],
  "requests": [                                  // cross-domain asks (see Messaging)
    { "to": "maps", "text": "ping me when a town tileset lands; I'll size chars to match" }
  ]
}
```

`notes` and `requests` persist across heartbeats (the writer preserves them);
`updated_at`/`health`/`current`/`progress`/`budget_remaining` refresh each unit.
A stale `updated_at` (say > 2h) means that agent is down.

## Messaging (agents talk to each other DIRECTLY — no human relay)

The git repo IS the message bus: async and durable, so it works even though each
agent is only awake when its Routine fires. There's no shared inbox file (that
would be multi-writer); instead each agent writes only its **own** file and reads
everyone's. Use the `coordination/board.py` CLI:

```bash
# 1. START of EVERY run — MANDATORY: read messages addressed to you + fleet health
python coordination/board.py inbox <you>

# 2. Ask another domain for something (async; they see it on their next run)
python coordination/board.py post <you> --to <them> --text "town tiles are 32px"

# 3. After acting on an incoming request, acknowledge it so the asker knows
python coordination/board.py note <you> --text "ack: added a 32px skeleton for maps"
```

Round trip, fully autonomous:
1. `maps` → `post maps --to characters --text "town tiles are 32px"`
2. `characters` next run → `inbox characters` sees it → acts → `note characters --text "ack: ..."`
3. `maps` next run → `inbox maps` sees the ack in characters' notes.

**Every agent MUST run `inbox <you>` at the start of each run** and handle any
request addressed to it before generating. That's what makes the human unneeded.
Latency is one Routine cycle (~1h) — fine for async coordination. One writer per
file, everyone reads all → conflict-free by construction.

## Shared PixelLab budget

All three domains draw from the **same** generation pool. Coordinate via floors
so nobody starves the others — each domain's loop stops when the balance drops
below its floor:

| Domain | Suggested floor | Rationale |
|--------|-----------------|-----------|
| characters | 40 | bootstrapping first; small floor |
| objects | 2000 | reserve headroom |
| maps | 2000 | reserve headroom |

Tune these to match priorities (the human decides). Every agent publishes
`budget_remaining` in its status file, so before a large run you can see how much
others have been consuming and back off if the pool is low.

## Durable runner — do NOT babysit an in-session loop

Hard-won lesson: a loop running inside your agent's session/container **dies on
every container restart** (nothing in-container survives, not even a watchdog).
Do not rely on it for continuous generation. Run your loop on an **external
scheduler** that lives outside the container.

**GitHub Actions (proven, recommended).** Each domain adds its **own** workflow
`.github/workflows/<domain>.yml` (one writer per file — `.github/workflows/` is
shared, but each file is owned by one domain). GitHub runs it on its servers on a
schedule, surviving all container restarts. **Reference template:
`.github/workflows/factory.yml` (characters)** — copy it and change the name +
paths to your domain. Recipe:

- Triggers: `schedule` (hourly cron, but pick an off-`:00` minute so all three
  domains don't hit the API at once) + `workflow_dispatch` (manual/API trigger).
- `permissions: contents: write` — so your loop's `git push` works with the
  default `GITHUB_TOKEN`.
- `concurrency: { group: <domain>-loop, cancel-in-progress: false }` — your own
  passes never overlap. Different domains still run in parallel (disjoint paths
  rebase cleanly), so give each a *distinct* group name.
- Use the shared **`PIXELLAB_API_KEY`** repo secret (already set) via `env`.
- Run `python <domain>/pipeline/loop.py --max-minutes 50 --min-balance <floor>`.

Then trigger once from the repo's **Actions** tab (or `workflow_dispatch`) and
you're durable — no human, no babysitting, survives restarts.

Budget note: all domain workflows draw the **same** PixelLab pool and each running
workflow consumes GitHub Actions minutes. Keep your `--min-balance` at your
domain's floor (see the budget table above) so concurrent runs don't starve each
other, and coordinate cadence via the board if the pool runs low.

## Unified viewer (optional)

Each domain builds its own `<domain>/viewer_data.json` + viewer. A future root
aggregator can stitch them into one gallery — until then, each viewer stands
alone.

## TL;DR for a new agent

1. Read this file + `CLAUDE.md`.
2. Work only under your domain dir; keep everything inside it.
3. Copy `characters/pipeline/pixellab_client.py` as your API-client starting point.
4. Write `coordination/<you>.json` each unit; read the others' at startup.
5. Push to `main` per unit, rebase on conflict, respect budget floors.
