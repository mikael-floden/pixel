# Agent coordination protocol

This repo holds **all** game graphics, produced by several autonomous agents that
run in parallel — each owns one top-level domain directory:

| Domain | Directory | Owner agent |
|--------|-----------|-------------|
| Characters (base bodies, dresses, animations) | `characters/` | characters agent |
| Animated props / map objects | `objects/` | objects agent |
| Tilesets / environments | `maps/` | maps agent |

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

## Messaging (cross-domain requests)

There's no shared inbox (that would be a multi-writer file). Instead:

- To ask another domain for something, append an entry to **your own**
  `requests` array with `"to": "<their-domain>"`.
- At the start of each run, read the other domains' JSON and scan their
  `requests` for `"to": "<you>"`. Act on them, then note the outcome in your own
  `notes` (e.g. `"done: sized chars to maps town tileset (32px)"`). The asker
  reads your notes to see it was handled.

One writer per file, everyone reads all — conflict-free by construction.

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
