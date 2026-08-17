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
- `scenery/` — scenery, formerly `objects/` (renamed 2026-08-12; its own
  **scenery agent**): freely placeable, optionally animated set dressing —
  trees, stones, graves, lamps. Unlike a tile it doesn't follow the tile
  grid, and it can animate (tiles can't). Generated on PixelLab (every store
  object tagged `SCENERY`); the maps2 agent places it in worlds. v2 factory:
  100 ranked GROUPS (`scenery/<group>/<id>/scenery.json`), quota by rank
  toward 2,650 pieces, half LIGHTS_ON / half LIGHTS_OFF, SOUTH-only, daily
  ~100-piece loop; three legacy top-level pieces (campfire, grave_cross,
  blood_spatter) are game-referenced and frozen. Rolled up into
  `scenery/viewer_data.json`. See `scenery/README.md`.
- `games2/` — the Nangijala game (consumer of the art domains; see
  `games2/CLAUDE.md`).
- `items/` — game items via PixelLab (its own agent; the item TYPE tags on
  PixelLab's objects store — `MISC`, `SOUL`, `CONSUMABLE`, `SWORD`, `BOW`,
  `WAND`, `ARMOR` — are the ground truth; one folder per item holding
  `item.json` + `sprite.webp` (lossless WebP, 67% under PNG and pixel-identical),
  rolled up into `items/viewer_data.json`; sync only, no generation loop). See
  `items/README.md`.
- `lore/` — the game's story (its own agent; no generation, no API). Owns the
  **red line** (`lore/RED_LINE.md`, the GM-facing backbone everything hangs
  off), player-facing **chapters**, and per-entity lore for every other
  domain's entities. Writes only `lore/**`; publishes `lore/lore.json`, where
  the owning domain's own text always wins and lore fills the gaps. Its build
  refuses to run when a cross-reference has gone stale. See `lore/README.md`.
- `monsters/` — pixel-art monsters via PixelLab (its own agent; the MONSTER
  tag on PixelLab — objects AND characters stores — is the ground truth;
  one folder per monster with canonical idle/walk/angry/attack/die states in
  `monsters/animation_map.json`; no loop yet — runs on demand). See
  `monsters/README.md`.
- RETIRED 2026-07-14: `characters/`, `maps/`, `games/`, `tiles/` (first-
  generation domains + game, incl. the #emission demo built from the old
  tiles registry) were deleted when the project committed to the 2nd
  generation. Their history lives in git.
- Repo root holds only shared/repo-level files: `README.md`, `CLAUDE.md`,
  `requirements.txt`, `.gitignore`, `.env` (gitignored), `.dockerignore`.

**LOSSLESS WEBP IS THE IMAGE FORMAT FOR ALL GAME ART.** Project default since
2026-07-31; every domain the game loads has migrated (characters2, monsters,
tiles2, maps2, scenery, items, wiki — zero PNGs between them). **Ship new art as
WebP.** VP8L is mathematically lossless, so this is not a quality trade: it is
the same pixels at ~33% of the bytes.

- Convert with the shared, verified script: `python3 games2/scripts/to-webp.py
  --write --replace <path>`. It re-decodes every file and refuses to replace one
  that does not round-trip exactly.
- **`lossless=True` and `exact=True` are BOTH non-default in Pillow.** Without
  the first you silently get lossy VP8 and ringing on every hard pixel-art edge
  — and lossy WILL move the foot anchors, shoulder waterlines and monster
  contact points the game renders with. Without the second, libwebp rewrites
  the RGB underneath fully-transparent pixels. If you write your own encoder
  call, pass both.
- A FULLY TRANSPARENT frame is a valid **28-byte** file (common at the end of
  die/fade animations). Never write a "smaller than N bytes means corrupt"
  guard — it is simply false for WebP.
- If your domain ships a manifest, put the REAL extension in it; the game reads
  it and never guesses. `games2/scripts/imagelib.mjs` reads both formats, so a
  stale `.png` path in your JSON keeps working while you convert.
- The deliberate PNG exceptions are PWA icons, hand-drawn build-source art,
  the WebP gate's test fixtures, and docs images — see `games2/CLAUDE.md`.

**`.dockerignore` decides what reaches the DEPLOYED GAME.** It is an allowlist:
a new top-level domain is invisible to the game image until it is added there,
and a subtree can be excluded from the image while staying in the repo. If an
asset 404s at `/assets/...` in the deployed game but exists on GitHub, THIS
FILE IS THE FIRST PLACE TO LOOK — it is the only thing that can produce that
symptom. Currently excluded from the image while remaining in the repo:
`tiles2/*/raw` (the tiles2 generator's pre-postprocess sheets, 4,648 files /
34 MB, served by nothing — see the comment there and the board messages to
tiles2/maps2/wiki, 2026-07-31).

**OFF-GITHUB BACKUP.** No human keeps a clone — the agents are the only ones
who touch git — so GitHub is a single point of failure.
**IT SILENTLY DID NOTHING FOR ITS FIRST THREE NIGHTS** (2026-08-15..17): the
bucket name came from a repo VARIABLE that a human was told to set by hand,
nobody did, and every run expanded to `gs:///` and died on a URL-parse error —
a backup system that exists, is scheduled, looks healthy and backs up nothing.
Two causes, both now fixed: the workflow DERIVES the bucket
(`<project>-nangijala-backups`, the same name the bootstrap creates) instead of
being told it, and fails with the exact paste-this line when the bucket is
missing; and the bootstrap, which said "run this on your machine", is a
Cloud-Shell one-liner like `ar-cleanup.sh` — the maintainer has no machine, which
is why it was never run. WHEN ADDING ANY OPS STEP HERE: if it needs a laptop, it
will not happen.

`.github/workflows/backup-gcs.yml` stores a WEEKLY (Mondays) `git archive HEAD`
zip (current state, no history; measured 291 MB) in a GCS bucket, kept 30 days
by a lifecycle rule — so ~4 snapshots spanning a month.
**WEEKLY, and the alternative is a trap worth remembering**: daily-with-a-
2-week-purge was considered and rejected because the bucket is NEARLINE, which
bills a **30-day minimum storage duration per object**. Deleting at 14 days is
still charged for 30, so that combination costs restore points and saves
nothing; Standard dodges the minimum but costs ~2x per GB. Measured on the real
archive in europe-north1: daily/30d ~8.7 GB-months (~0.95 kr), weekly/30d
~1.25 GB-months (~0.14 kr). FREQUENCY is the only lever that moves this bill.

**No secrets exist for it**: it reuses the deploy's keyless
Workload Identity Federation. The SA holds `objectCreator`+`objectViewer` on
that bucket and NOT `objectAdmin`, so CI can write and verify a backup but
*cannot* delete one — which is what keeps "backups live in the same GCP
project as prod" from meaning "one compromised pipeline loses both". Note the
archive ships **tracked files only**, which is what keeps the gitignored `.env`
out of cloud storage — a `tar` of the working tree would leak
`PIXELLAB_API_KEY`. ~0.14 kr/month. Setup + restore: `.github/BACKUP.md`.

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
