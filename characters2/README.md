# characters2 — heroes + NPCs (the PixelLab character mirror)

This domain mirrors the game's characters from PixelLab: the **two locked
heroes** plus **every character tagged `NPC`**. **PixelLab is the source of
truth** — `pipeline/sync.py` mirrors it into the repo with **zero generations**.
(The earlier `characters/` skeleton-exploration domain is retired; history in git.)

Two agents work it (maintainer 2026-09-12): the **characters2 agent** and its
**characters2-assistant** — the same remit, for the units the characters2 agent
is not in. The assistant reads `coordination/characters2.json` first, never
touches a file named there as in flight, and names every file it touches on
`coordination/characters2-assistant.json` before pushing.

## PixelLab mental model + conventions

- A **skeleton** = a generation-parameter profile: view, canvas size,
  `animation_directions`, resolution, outline/shading/detail, template.
  Exploration over skeletons is over — this domain is pinned to ONE (below).
- A **character** = one `create-character-v3` call → 8 rotations (~3
  generations). The base is **undressed** (neutral body in plain underclothes).
- An **animation** = one `animate-character` call per direction (~1 generation
  each); frames return as raw `rgba_bytes` base64.
- An **outfit** ("dress") = one `create-character-state` call ("wearing X") → a
  sibling character on PixelLab (shared `group_id`), with its own regenerated
  animations. **One outfit at a time; no per-slot gear/layering** (PixelLab
  doesn't support it).
- PixelLab calls are async; `pipeline/pixellab_client.py` polls background jobs
  and returns decoded Pillow images, so callers are effectively synchronous.
  CDN rotation URLs can briefly 404 right after a job completes — the client
  retries downloads.
- **Don't re-pose art locally** — PixelLab owns rigging/animation; this repo
  owns orchestration, packaging, QA-of-output, and the viewer.
- **Never commit secrets.** `PIXELLAB_API_KEY` comes from the environment /
  gitignored `.env`; don't call the API without it.

## The two heroes (locked)

| Hero | PixelLab character |
|------|--------------------|
| `default_boy`  | `c883451f-41b0-4f5e-8ac7-c606cb007154` |
| `default_girl` | `bc21eab2-4f08-47ac-b58f-65ee1b98a935` |

Fixed human skeleton: **low top-down**, **low detail**, default outline, native
**112 × 112** canvas. The IDs are pinned in `config.json:pixellab_characters` —
that file decides **which** characters to mirror; re-point an ID and re-sync to
swap a hero (the mirror removes the old character's assets and imports the new
one's). Each hero carries a base 8-direction model + **13 animations** (all
`custom-*` cycles: idle, walk, run, jump, kick, punch, sword, bow, two spells,
hurt, pickup, die), every animation at all 8 directions.

### Animation folder names (slugs)

PixelLab animation names can contain spaces, commas, even newlines (especially
`custom-*` ones), so `sync.py` slugifies each into a filesystem-safe folder
name. The exact PixelLab `animation_type` is preserved in `character.json` for
matching — the slug is only ever the folder name.

## NPCs (`npcs/`) — tag-driven mirror

Every PixelLab character tagged **`NPC`** is mirrored — the tag is the ground
truth, exactly like the monsters domain's `MONSTER` tag. `sync.py` discovers
the set by listing the account's characters, mirrors each into `npcs/<folder>/`
(same shape as a hero: `base/` 8 rotations + `animations/<slug>/<dir>/N.webp` +
`character.json`), and **prunes** any folder whose character lost the tag or
was deleted. Tag in the PixelLab UI → next sync brings it in; untag → removed.

- **Folders are keyed by the PixelLab id's first 8 hex chars**
  (`npcs/3749cceb/`), NOT the name — NPC names are duplicate prompt junk
  ("light armor with sho (copy 4)" ×7); the id prefix is stable across renames.
  On a prefix collision the folder takes more of the id.
- **`npcs/index.json`** (`characters2-npcs@1`) is the roll-up consumers read:
  every folder with its full PixelLab id, raw name, animation slugs, states,
  and authored metadata — no tree-walking needed.
- **Every NPC is authored**: `metadata.json` carries `display_name`, `species`,
  `sex`, `role`, `lore` for all 191, keyed by folder. Sex and role were read
  from the **ART** (every south sprite inspected on contact sheets) — never
  from `pixellab_prompt`, which is the same copy-pasted "young female
  adventurer" text on all 191 and says female for everyone. 107 female /
  84 male, 191 unique names, 38 roles. These merge onto each `character.json`
  AND into `index.json`, so the wiki renders the whole cast from one file.
- **GAME STATES, not PixelLab names** (`animation_map.json:npcs`): a PixelLab
  animation name is GENERATION TEXT — reworded freely to coax motion out of the
  model, typos included (152 NPCs say `still`, **40 say `stilI`**, one ships
  both). The game must never depend on it. States are declared once, matched by
  keyword on the slug, and `sync.py` PUBLISHES the resolved map as `states` on
  each `character.json` and in `index.json`:

  ```jsonc
  "states": { "idle": "custom-calm-stili-idle-breathing" }
  ```

  Consumers read `states.idle` and never guess. When several animations match,
  the richest wins (most frames, then directions, then slug order) —
  determinism instead of filesystem order. `overrides.<npc>.<state>` pins an
  exact folder. Adding a state (walk, talk, work) is one entry — no code change.
- **`no_turn`** (bool on the NPC's `metadata.json` record) marks an NPC whose
  ART only reads right from ONE facing — the game must never turn it.
  **Thorne** is the only one so far (his breastplate prop appears in
  south/south-west but not south-east, so a turn makes it pop). Absent = false.
- `verify_sync.py` checks the set BOTH ways (nothing tagged missing, nothing
  untagged surviving), full per-NPC integrity, AND that every REQUIRED state
  resolves to a folder with real frames — an NPC without an idle can never
  ship silently frozen.

```bash
python characters2/pipeline/sync.py npcs        # just the NPC set
python characters2/pipeline/sync.py             # heroes + NPCs (default)
```

## WebP (the domain format)

All art here is **lossless WebP**; zero PNGs. Measured on all 1419 files:
PNG 4.43 MiB → WebP 1.44 MiB, **67.6% smaller**, 1419/1419 pixel-identical.

- **`method=4` (Pillow's default), not `method=6`.** Over 120 sprites, method 6
  matched method 4's size to within 0.1% while ~76× slower (99.5 vs
  1.3 ms/file). Whole-domain conversion: 2.5 s.
- **WebP must be saved explicitly lossless.** Pillow's default WebP encode is
  lossy — a bare `img.save("x.webp")` silently resamples every sprite. All
  writes go through `sync.py:save_image()`, which forces `lossless=True`.
- **Lossless is proven safe for the game's measurements**:
  `games2/scripts/build-manifest.mjs` derives foot anchors, shoulder
  waterlines, gait fps and foot plants from these pixels. A shadow-copy
  conversion + rebuild produced a measurement-for-measurement IDENTICAL
  manifest (and 117/117 games2 tests passed) — it holds because the
  measurement code reads only the **alpha** channel, which lossless preserves
  bit-exactly. Lossy would move the anchors — hence the hard rule.
- Consumers read both formats: games2 via `scripts/imagelib.mjs`, the wiki by
  resolving paths against the disk.

```bash
python characters2/pipeline/to_webp.py            # dry run: measure + verify
python characters2/pipeline/to_webp.py --apply    # convert + git rm the PNGs
python characters2/pipeline/to_webp.py --revert   # back to PNG
```

`--apply` refuses to delete a single PNG unless **every** file round-tripped
pixel-identical.

## Authored metadata (`metadata.json`) — `characters2-metadata@1`

Everything true about a character that **can't be derived from the art** lives
in `characters2/metadata.json`, keyed by folder id (heroes and NPCs alike):

```jsonc
{ "format": "characters2-metadata@1",
  "characters": {
    "default_boy": { "display_name": "Man", "species": "Human",
                     "sex": "Male", "lore": "A young man …" } } }
```

- **Edit fields here, never in `character.json`** — that file is regenerated on
  every sync; `sync.py` merges this record onto it afterwards.
- `lore` = the wiki blurb (1–2 sentences of RPG flavour, no stats). **Every
  field is optional** and the *whole record* is merged, so adding a field
  (tags, hometown, class, voice…) needs no code change and can't break a
  consumer. PixelLab's own `name` (prompt junk) stays in `character.json` for
  traceability; `display_name` is the human-facing one.

## Game-state → folder mapping (`animation_map.json`)

The game refers to hero animations by **stable logical names** (`idle`, `walk`,
`run`, `jump`, `sword`, …); PixelLab folder names change on a whim and the two
heroes can differ. `animation_map.json` is the **contract**:

```jsonc
{ "states":    { "idle": "custom-calm-idle", "walk": "custom-walking-full-cycle-until-the", … },
  "overrides": { "default_boy": { "walk": "custom-full-walk-cycle-walking-until", … } } }
```

`games2/scripts/build-manifest.mjs` reads this file (per-hero override wins) —
**when PixelLab renames a move, only this file changes; no game code touches.**
(Before this contract the game hard-coded folder names and silently dropped any
that didn't match — renames broke `jump`/`kick`/boy-`walk` without an error.)
After a sync, `verify_sync.py` checks every hero×state resolves to a real
folder and FAILS if one is missing. There is deliberately **ONE `jump` state**
(maintainer decision): the old high-jump and `runjump` were consolidated into
the steeplechase run-jump.

## Retouch layer (`retouch.json`) — `characters2-retouch@1`

PixelLab is the source of truth for art, and its generator sometimes bakes in
what the GAME must own. The pick-up animation came back with a different
hallucinated object per direction (white scroll, dark pot, blue crystal…) in
the hero's hand — while the picked-up item in the game is dynamic. Those
pixels are declared away here: not painted over in the mirror (a `--force`
resync would silently restore them) and not prompted away on PixelLab (the
maintainer could not — generation text is not a control surface).

- `retouch.json` maps a frame key (`humans/<hero>/animations/<slug>/<dir>/<i>`)
  to a pixel patch — `erase` spans and `paint` spans (repaired outlines) —
  pinned to `source_sha256`, the decoded-pixel sha of the PixelLab frame it was
  authored for, plus `result_sha256` of the frame the mirror ships.
- `sync.py` applies the patch to every frame it downloads whose source sha
  matches. When it does not (the animation was regenerated on PixelLab) the RAW
  frame is written and a `RETOUCH STALE` line printed: a patch is never applied
  to pixels it was not authored for, so a regenerated frame shows the real new
  art (object and all) until the rules are re-authored.
- `verify_sync.py` checks both shas against the live API on every run;
  `python characters2/pipeline/retouch.py --check` verifies the on-disk result
  without the API.
- Authoring: `pipeline/retouch_author.py` holds the per-frame boxes (RULES) and
  the erase logic — foreign colours (never ≥20× in the hero's object-free
  animations), explicitly listed colours (the pot is drawn in his hair grey,
  the scroll in eye white), disconnected components, then the object's own
  outline; holes inside the body are inpainted and body that now borders
  transparency gets its black outline back. Re-run it after a PixelLab
  regeneration (`--src <pristine tree>` or straight from the API); it writes
  the JSON and the frames. Review in the viewer before committing. Never
  hand-edit `retouch.json`.
- Today: 117 frames of the heroes' `pickup` state (65 boy, 52 girl; 4626 px
  erased). W/NW/SW derive from E/NE/SE, which PixelLab mirrors exactly.
- The game sees only pixels: frame counts, paths and the `animation_map.json`
  contract are unchanged; whatever is in the hand is the game's to draw.

## Staying in sync

The maintainer adds animations (and later outfits / extra models) in the
PixelLab UI. `sync.py` pulls the current state with **zero generations** and
downloads only what changed:

- base rotations re-fetched only when their source URL changes;
- an animation skipped entirely when its `animation_group_id` is unchanged and
  all frames are on disk (newly-added *directions* still get picked up);
- a true mirror — animations / directions / stray frames deleted in the UI are
  removed locally too;
- **a direction regenerated in the UI keeps its old take in the record**, with
  no timestamp and no current-flag, so a direction can arrive twice — the take
  that ships is **the LAST one in the record** (`sync._pick_take`), which is
  the take the PixelLab editor renders. (Not the newest by CDN Last-Modified:
  the monsters domain measured that ranking against the editor over 19 real
  doubled directions and it agreed about half the time, and the maintainer
  lost finished animations to the disagreement. `verify_sync.py` expects the
  same take.)
- **the packed layer is re-cut at the end of every NPC pass** (`pack_npcs`,
  before the commit), so a commit that carries new raw art always carries the
  packed frames the game draws from — see "THE PACKED LAYER";
- **the sync's commit stages only the mirror** (`humans/`, `npcs/`) — a local
  `sync.py --no-push` from a dirty tree used to sweep pipeline edits into a
  commit titled "sync N NPCs" (2026-09-12); it cannot now.
- declared retouches (`retouch.json`) re-applied to every downloaded frame —
  see "Retouch layer" above.

```bash
export PIXELLAB_API_KEY=...
python characters2/pipeline/sync.py                # mirror all, commit + push
python characters2/pipeline/sync.py default_girl   # just one
python characters2/pipeline/sync.py --no-push      # local only
```

`.github/workflows/characters2.yml` runs the sync, but its **schedule is
paused** (maintainer request — no timer runs). Trigger via the Actions "Run
workflow" button or run locally; it commits/pushes only on change.

## Layout

```
characters2/
  config.json                    pinned hero IDs (+ frame_format: webp)
  metadata.json                  authored metadata for ALL characters (see above)
  animation_map.json             game-state -> folder contract (see above)
  retouch.json                   pixel patches on the mirror, sha-pinned (see above)
  humans/
    default_boy/
      character.json             manifest: pixellab id, prompt, style, states, per-file source URLs
      base/
        south.webp … south-west.webp   static 8-direction model (native 112×112)
        preview.webp                   all 8 directions in a row
      animations/<slug>/<dir>/N.webp   frames per direction (+ preview.gif per animation)
    default_girl/  (same shape)
    _experiments/                archived pre-decision reroll takes
  npcs/
    index.json                   the NPC roll-up (characters2-npcs@1)
    <id8>/                       one NPC, same shape as a hero
      packed/                    THE PACKED LAYER games2 loads (below)
  pipeline/
    pixellab_client.py  sync.py  verify_sync.py  retouch.py  retouch_author.py
    to_webp.py  generate.py (legacy explorer)  pack.py (the packed layer)
```

## THE PACKED LAYER (`npcs/<id>/packed/`; games2 reads it, `pipeline/pack.py` writes it)

Every NPC carries `packed/`: each art file (8 rotations, every idle frame)
cut to ONE box per NPC — the union of the opaque boxes of all its files, +1
px — under a content-hashed name (`packed/<same subpath>.<sha8>.webp`), with
`packed/index.json` naming the box and the current file per raw path. The
game draws an NPC as one sprite whose origin is the foot anchor as a fraction
of the frame and swaps rotations and idle frames under it, so every texture
of an NPC must be the same size with the art at the same offset — hence one
box per NPC, not per file. Measured over the roster (191 NPCs, 4,436 files):
a body fills 38% of its 112x112 canvas; the packed frames are 223 -> 84 MB
of decoded texels, 24 MB on disk.

- **The raw files are untouched and stay the truth**: the wiki, the previews,
  `verify_sync.py` and the anchor measurement read them. games2's
  `build-npcs-manifest.mjs` measures the foot anchors on the RAW frames
  (footAnchor's band and lift scale with the frame height) and converts them
  into the packed frame; its gate `games2/scripts/verify-npc-pack.mjs` proves
  the packed feet land on the raw pixel.
- **It runs at the end of every NPC sync** (`sync.py` calls `pack.py` before
  it commits, 2026-09-12 — a step someone has to remember is a step that gets
  skipped, and an NPC whose raw art changed draws from STALE packed frames
  until it is re-cut). By hand: `python3 characters2/pipeline/pack.py`
  (resumable: an NPC whose raw bytes hash to its index is skipped, ~2 s for
  the roster; `--check` exits 1 when any NPC is stale; `--only`). `sync.py`'s
  mirror pass never touches `packed/` — it prunes inside `base/` and
  `animations/` only. An NPC without a current packed layer draws raw.
- **Cache law**: never a stable name; current + one back (`prev`) so an open
  page keeps rendering through a deploy.

Verify a sync is exact (read-only; re-fetches PixelLab and diffs the repo —
every animation/direction/frame-count, image validity, stale folders, states):

```bash
python characters2/pipeline/verify_sync.py     # exits nonzero on any mismatch
```

## Outfits / extra models (coming)

PixelLab groups a character's outfits via a shared `group_id` (recorded in each
`character.json`). When the maintainer adds outfits in the UI, `sync.py` will
be extended to mirror them under `humans/<id>/outfits/<name>/`.
