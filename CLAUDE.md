# CLAUDE.md — working notes

## What this is

An automated loop that generates modular *Grave Seasons*-style pixel characters
via the PixelLab API. The repo tries many **skeletons** (generation-parameter
profiles) before picking a winner. Read `README.md` and
`characters/spec/FACTORY_SPEC.md`.

## Repository layout (multi-domain, one repo for ALL game graphics)

Each art domain is a **self-contained top-level directory** and is owned by its
own agent/loop/Routine. Keep everything for a domain **inside its directory** —
do not add domain-specific files to the repo root.

- `characters2/` — character art, 2nd generation (its own agent).
- `tiles2/` — tile/material library, 2nd generation (its own agent).
- `maps2/` — worlds, 2nd generation (its own agent; `worlds/<name>/world.json`).
- `objects/` — animated props / map objects (a separate agent).
- `games2/` — the Nangijala game (consumer of the art domains; see
  `games2/CLAUDE.md`).
- `monsters/` — pixel-art monsters via PixelLab (its own agent; skeleton
  templates Bear/Cat/Dog/Horse/Lion + free-form prompt, one folder per
  monster; no loop yet — runs on demand). See `monsters/README.md`.
- RETIRED 2026-07-14: `characters/`, `maps/`, `games/`, `tiles/` (first-
  generation domains + game, incl. the #emission demo built from the old
  tiles registry) were deleted when the project committed to the 2nd
  generation. Their history lives in git.
- Repo root holds only shared/repo-level files: `README.md`, `CLAUDE.md`,
  `requirements.txt`, `.gitignore`, `.env` (gitignored).

The pipelines touch **disjoint paths**, so concurrent pushes to `main` rebase
cleanly. The only real cross-domain hazard is editing a *shared* file at once;
each domain currently keeps its own copy of `pixellab_client.py` (full
isolation) — if that's ever centralized, treat it as a deliberately shared lib.
All paths below are relative to `characters/`.

## Mental model

- A **skeleton** = a parameter profile (`config/factory.json:skeleton_variations`):
  view (`side` / `low top-down` / …), `width`×`height`, `animation_directions`
  (4 or 8, low/high top-down), resolution (32-256), outline/shading/detail, template.
- A **character** = one `create-character-v3` call → 8 rotations (~3 generations).
  The base is **undressed** (neutral body in plain underclothes).
- An **animation** = one `animate-character` call per direction (~1 gen each);
  frames return as raw `rgba_bytes` base64.
- An **outfit** ("dress") = one `create-character-state` call ("wearing X") → a
  sibling character stored on PixelLab (shared `group_id`), with its own
  regenerated animations. One outfit at a time; **no per-slot gear/layering**
  (PixelLab doesn't support it). PixelLab is the source of truth; `sync.py`
  mirrors characters + outfits into the repo (zero generations).

## The loop (pipeline/loop.py)

Each **unit** is one PixelLab op. `next_action`/`fill_next` read the filesystem
(resumable). Caps per skeleton: 5 characters, 5 animations (start idle+walk), 5
dresses. Invariant: every character has every animation undressed, and every
dress has every animation. Phase A bootstraps 5 skeletons (5 chars × idle+walk);
Phase B appends animations/dresses/characters to existing skeletons, fanning out.
After every unit: rebuild `viewer_data.json`, commit, **push to `main`**. Bounded
by `--max-minutes` / `--max-units` / budget.

## Conventions

- **Never commit secrets.** `PIXELLAB_API_KEY` is read from the environment /
  gitignored `.env`.
- All generated art is **committed** under `skeletons/` and pushed to `main`.
- PixelLab calls are async; `pixellab_client.py` polls background jobs and returns
  decoded Pillow images so callers are effectively synchronous.
- Keep code deterministic where possible: seeds are derived (`factory._seed`) from
  skeleton id + indices so re-runs are reproducible.
- CDN rotation URLs can briefly 404 right after a job completes — the client
  retries downloads.

## Adding a skeleton variation

Append to `config/factory.json:skeleton_variations` (or rely on
`procedural_variation` once the explicit list is exhausted). Vary `view`, size,
`animation_directions`, detail/outline/shading, `template_id`.

## Running the loop on a schedule

A scheduled Routine wakes a session that runs
`python characters/pipeline/loop.py --max-minutes 50`, which advances + pushes,
then exits; the next firing resumes from the filesystem. The loop also runs an
efficient sync at startup (mirrors PixelLab/UI edits in, unchanged frames skipped
via If-Modified-Since).

## Don't

- Don't call PixelLab without `PIXELLAB_API_KEY` set.
- Don't re-pose art locally — PixelLab owns rigging/animation; this repo owns
  orchestration, packaging, QA-of-output, and the viewer.
