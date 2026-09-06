# Nangijala Scenery

**Scenery** is the game's freely placeable, optionally animated set dressing —
trees, stones, graves, braziers, streetlights… Two properties define the
domain against tiles: a piece can be placed anywhere (it does not follow the
tile grid — `tiles2/`'s job), and it can animate (tiles cannot).

Owned by the **scenery agent** (board file `coordination/scenery.json`).
Generated on [PixelLab](https://pixellab.ai); the **maps2 agent** places
scenery in worlds; the game (`games2/`) renders it; the **maintainer**
approves/rejects/comments every piece in the wiki's Scenery section.
(Directory was `objects/` until 2026-08-12; the v1 8-direction factory and
its 16 props live in git history.)

## The v2 factory (maintainer's structure)

- **Ranked TYPES**, one group folder each (`scenery/<group>/`); rank =
  placement frequency (how often a world-builder drops one). Quota follows
  rank: `quota(rank) = max(2, 102 - 2*rank)`
  (`config/factory.json → quota_rule`; floor 2 so every type ships at least
  one lit + one unlit piece) — unless the group sets an explicit `quota`,
  which most now do (172 groups, 109 with explicit quota: demand multipliers,
  saturation freezes, rare/special caps). The catalog's full design AND the
  maintainer's accumulated taste laws live in `config/factory.json`
  (`groups` + the `_comment` changelog) — **read the `_comment` before
  touching any prompt**. Per-group quota/done: `viewer_data.json → groups`.
  **Never raise `quota_rule` or `budget` knobs on your own — maintainer's
  call.**
- **THE GOAL IS 1,000 LIVE PIECES, and generation stops there**
  (`config/factory.json → goal.target_pieces`, maintainer decision). No
  open-ended catalog, no scheduler: he tops up credits, the loop runs a
  bounded pass, he reviews. The count is live pieces on disk — his rejections
  DELETE, so the 1,000 are all pieces that survived review. The quota plan
  (~2,125 total and shrinking as groups freeze) only decides the MIX along
  the way; it is a priority ordering, not a target.
- **LIGHTS_ON / LIGHTS_OFF**: every type is half self-emissive, half not,
  interleaved — odd piece numbers unlit, even lit, each lit piece drawing one
  of the type's curated `glow_concepts`. Glow is lore-loaded: light is memory
  being kept (`lore/RED_LINE.md`).
- **`lights` is null on a piece carrying BOTH** `LIT_*` and `NOT_LIT_*`
  states. **Read the state key, not the piece**: `LIT_*` / `NOT_LIT_*` is the
  per-state truth (reading the piece field once made the wiki file a
  ten-unlit-variant tree under "lit"). Windows keep a non-null `lights` on
  purpose — one `LIGHTS_OFF` plus one `LIGHTS_ON` sibling is a real base
  condition plus an edit of it, not a mixed bag.
- **SOUTH only — scenery never rotates.** Exception: groups with
  `keep_directions` — windows ship SE/S/SW because walls face three ways
  (maintainer decision); the extra facings are free on the ≤168px path (the
  8-direction object generates them anyway) and each kept facing must pass
  the edge gate. Animations come later (S-only), one idle per type
  (`animation_idea`).
- **Every PixelLab object is tagged `SCENERY`** at creation.
- **Deterministic**: `pipeline/catalog.py` derives every piece's id, variety,
  glow, height and prompt from seeded hashes — the filesystem alone says what
  is next, so any run resumes exactly where the last one stopped.

### One full canvas per piece (v2.1, maintainer decision)

No multi-candidate batching (retired: shared-canvas candidates read as icons,
stranded review popups in the maintainer's UI, and carried the broken-pixel
bug — the first graves were per-pixel mush; single-canvas pieces were crisp).
Quality first — this is a AAA project:

- **≤168px** → `create-8-direction-object` (view `low top-down`), keeping
  only SOUTH plus any `keep_directions`. Generating a real 8-direction object
  keeps every piece a first-class animatable store citizen — the maintainer's
  "fool PixelLab" rule.
- **>168px** (the 8-rotation cap) → SINGLE-candidate
  `create-1-direction-object`: full canvas, auto-kept, never enters review.

Either path costs **20–40 generations per piece**. **Budget with ~$0.16 per
piece DELIVERED** (measured against USD credits 2026-08-15) — the headline
~$0.09 is one successful call; the pixel-grid and edge-bleed gates re-roll a
real fraction. The loop's budget floors make running out a clean pause, never
an error.

**Reserve credit for the state passes.** A window shipped without its
`LIGHTS_ON` state is INCOMPLETE art, not cheaper art — the game crossfades
the two on interior brightness, so a lone dark window can never be lit. Same
for a tree without its variants. When a pass is mostly windows, stop the loop
(`touch scenery/.stop` — drains in-flight jobs rather than dropping them)
with enough left to run `pipeline/lights_on.py`.

### Running a pass

**The schedule is DISABLED** (maintainer: generation is driven by hand,
together, until the 1,000 goal). Run from Actions → "Scenery factory loop" →
Run workflow (`.github/workflows/scenery.yml`); a pass is capped by
`budget.daily_pieces` (100) and `--max-minutes`. The budget gate stops
cleanly when the subscription pool is below `min_generations_remaining` (the
fleet's shared 2000 floor, `coordination/PROTOCOL.md`) AND credits are below
`min_usd`. If the cron is ever restored, add a missed-run fallback — the old
schedule silently skipped days.

Cadence: the loop COMMITS every piece but PUSHES at 10 pending pieces or
240 s, whichever comes first (maintainer rule — the deploy's concurrency
group keys on `github.sha` and collapses nothing, so push-per-piece ran ~180
concurrent Docker builds/hour and an older build finishing last can briefly
regress the live site). Several PixelLab jobs stay in flight at once
(`budget.parallel_jobs`) — never wait on one job before submitting the next.

### Motion animations: the maintainer picks from a candidate page

Nothing gets a motion animation until he has ticked its ID. The loop is:
`candidate_page.py` renders a review page (sprite, what I say should move, the
prompt, a PixelLab link, a tick box); he copies the IDs back; `animate_motion.py
--ids` runs exactly those. Briefs live in `config/motion_prompts.json` —
`animations` for the accepted, `declined` for the rejected WITH the reason
(they exist to stop the same piece being re-proposed).

- **Write the prompt after looking at that one image** (maintainer, verbatim:
  "You should write a dedicated propt for each image AFTER LOOKING AT the
  image."). One prompt pasted across a batch names things that are not in the
  sprite — molten veins described as a point of light — and he catches it.
- **Never propose a `windows` or `trees` group piece** (maintainer, 2026-08-29:
  "We are NOT working with windows and trees right now."). Enforced by
  `EXCLUDED_GROUPS` in `candidate_page.py`, which every page must go through.
  Match the group name exactly — `streetlights` contains the substring `tree`.
- **Never put the word "calmer" in a prompt.** It reads as an instruction to
  animate, not to restrain: measured, S1 went 4.5% → 19.5% and Q19 5.3% →
  15.8% when asked to be barely visible. The phrasing that works names the
  thing and caps it — "each shifting by a single pixel".
- **More frames does not fix a bad loop.** Q19, Q11 and Q4 all measured worse
  at 8 frames than at 4.
- Two families have never come back rejected: **hanging** (a hung object can
  only swing) and **flame** (the fire is already in the sprite). A **glow**
  works when it is a discrete shape — a vial, a gem, a rune — and fails when
  it is a wash over the whole object.
- Rejected as predictors, do not re-attempt: motion % as a quality proxy;
  "size predicts success" (tiny median 14.0% vs medium 14.0% — disproved);
  rotation (a turning wheel measured 39.6% and was rejected).

### THE REVIEW IS CLOSED (maintainer, 2026-08-20)

> "That was the last review! The remaining scenery must be kept unreviewed. I
> don't know if we will add them to the game or not. They will need custom code
> to look good."

Read the two halves separately, because the second is the one an eager agent
gets wrong.

**Quota generation is over.** Every piece in the catalog has been through his
hands: 0 pieces and 0 rejections outstanding. Do not refill a pruned slot, do
not "top up" a group that looks thin — 474 state slots are retired on purpose,
and a thin group is his decision, not a gap. `scenery-states.yml`'s schedule is
off for exactly this reason.

**NEVER RUN THE UNRESTRICTED LOOP AGAIN. `--plan` OR NOTHING.** The catalog is
at 725 of a 2,133 target, and quota fairness has no idea that the gap is his
pruning rather than unfinished work. `loop.py` with no `--plan` queues stones,
windows, bushes, hedges, cairns, fallen_logs — group after group he spent a
night rejecting — and bills him to resurrect them. He commissions new work by
name now, so name it:

    python3 pipeline/loop.py --plan chess_tables:4,chess_boards:4

Check it with `--dry-run` first; that branch honours `--plan` as of 2026-08-20.
Before that it returned before `--plan` was even parsed, so the dry run printed
the full quota-fair flood while the real run would have made only the four
tables — a safety check describing a different run than the one about to
happen, which is worse than no safety check at all.

**The cliff families ARE under review now (2026-08-27).** This section first
recorded them as deliberately unjudged, because they only read correctly against
a mountain wall and the game had no placement code. He has since started
reviewing them anyway and is rejecting freely — 63 cliff states in one batch.
So do NOT protect them from his verdicts: process cliff rejections exactly like
any other group. What stands from the original note is only the reason they were
held: whether they ship at all is still undecided, and they need custom
placement code to look right.

Never auto-approve anything, never drain his queue for him, and never delete a
piece for being merely unjudged — an unreviewed state is not a rejected one.

### Wiki verdicts are standing orders (maintainer)

Approve/reject clicks land in `live/feedback/objects.json` (the live server's
file — never edited from here). **A rejection is a standing removal order**:
every run starts with `pipeline/feedback.py`, which deletes each rejected
piece from the PixelLab store AND the repo; the planner refills the freed
slots with fresh rolls the same pass. Rails: the three legacy pieces are
never auto-deleted, and a verdict older than the piece's last sprite commit
is stale (it judged the slot's PREVIOUS occupant) — the re-roll survives
until re-reviewed. A whole group rejected means the group's PROMPT is wrong,
not the dice — fix `config/factory.json` before the slots refill.

### Pixel-perfect QA is the agent's own duty (maintainer)

PixelLab sometimes fails to draw clean deliberate pixels — an "absolute no
go" the agent removes on its own, without waiting for review.
`pipeline/pixel_qa.py` builds zoomed contact sheets of every piece no one's
eyes have cleared (`--sheet`); the agent LOOKS at them, condemns broken
pieces (`--condemn` → deleted from store + repo, slot re-rolls) and stamps
the rest (`--pass-rest`; log in `config/qa_log.json`). Deliberately visual —
no statistical gate: six metrics calibrated against 213 approved pieces, the
16 known-mush graves and 225 rejected sprites all overlapped completely (the
painterly style is legitimately gradient-dense), while zoomed inspection
separates them every time. Wiki verdicts count as checked by the maintainer's
own eyes (same staleness guard as feedback.py).

### Beyond the ranked outdoor types

The catalog also carries (all in `config/factory.json`): **mountain-wall
decor** (the `cliff_*` families — freely placeable over the repeating wall
tiles, the game's biggest empty surface), **indoor/house detail** so a house
feels lived in (`tables`, `chairs_and_benches`, `beds`,
`cupboards_and_shelves`, `hearths`, `rugs_and_hides`, `house_clutter`),
**`wall_hangings`** for the coming mechanic where a room's top walls stay
visible (bottom walls hide to unveil the player — those pieces render
face-on, pinned to interior walls), and capped **rare/special landmark
types**. Regional identity is the zoom-out goal: trees/stones variety axes
are deep so maps2 can theme AREAS with coherent subsets — one region's trees
are not another's.

## What a piece is, on disk

```
scenery/<group>/<piece>/
  scenery.json      the manifest (id, group, rank, name, lights, variety,
                    glow_concept, prompt, size, sprite, placement,
                    pixellab_object_id, tags, animations)
  sprite.webp       the SOUTH sprite (lossless WebP; lossless=True AND
                    exact=True — both non-default, both mandatory)
```

Three **legacy pieces** stay at the top level, 8-direction, game-referenced,
frozen — never regenerate them:

| id | what the game does with it |
| --- | --- |
| `campfire` | the spawn bonfire (`burn__south`) — also a real shader light; the tiles2 bonfire *tile* pins its exact light params |
| `grave_cross` | rises where a monster died — the maintainer's own PixelLab object |
| `blood_spatter` | plays on every landed hit — the maintainer's own, stored deliberately TRIMMED (see its manifest's `edited` note) |

### Sizing scenery in the world

Art resolution ≠ world size. Each piece carries `placement.world_px_height`
(from its seeded `world_height_m`; 64px = 1.7m character) — render the sprite
scaled to that height and everything composes at believable scale. Group art
sizes live in the config; heights vary per piece inside the group's range.

## Random horizontal flip — the game's half of the deal

Scenery is SOUTH-only, and a south-facing sprite is still itself mirrored:
placing each piece with a random horizontal flip doubles every group's
variety for nothing (maintainer decision). Every piece publishes

```json
"must_be_imbplemented_with_random_hflip": true  // sic — the SHIPPED key name; do not "fix" the spelling
```

(field name verbatim, misspelling and all), stamped by `loop.py` at birth and
republished in `viewer_data.json` — a consumer never infers it, and stamping
at birth keeps it true for pieces that do not exist yet.

**Read the flag PER PIECE — the field is the ground truth, and it is `false`
wherever left and right already mean something**: every `windows` piece
(mirroring a south-east window produces a south-west one, which the game
would then hang on an east-facing wall) and the three legacy 8-direction
pieces.

## Who consumes this domain

- **games2** — bakes `scenery/` into its image (`/assets/scenery/...`); draws
  the three legacy pieces via hardcoded URLs in `WorldScene.ts`.
- **wiki** — `wiki/build.mjs buildObjects()` scans every
  `scenery/<group>/<id>/scenery.json` (groups become the wiki's categories);
  the maintainer approves/rejects/comments pieces there. Internal domain key
  is still `objects` (route slugs are URLs — the wiki agent's call).
- **lore** — `lore/pipeline/build.py` reads the manifests for per-entity lore.
- **maps2** — places scenery in worlds (post a board request for specific
  props; check `viewer_data.json → groups` for what exists).
- **Deploys** — a push touching `scenery/**` auto-deploys the game;
  `.dockerignore` must allowlist the domain (`!scenery`) or assets 404 in prod.

**Light budget rule** for anything emissive (half of all scenery!): the
renderer has **8 world light slots** — `games2/spec/LIGHT_BUDGET.md`; run
`node games2/scripts/check-light-budget.mjs` before shipping worlds placing
glowing scenery. LIGHTS_ON art carries baked glow (self-emission in the
sprite); becoming a real shader light is a separate, budgeted decision made
at placement time (tiles2/emission.json pattern).

**`light` — how strong a piece shines (maintainer 2026-09-06; first pass
written by maps2, owned by scenery from here).** Every piece with a `LIT_*`
state (or legacy `lights: LIGHTS_ON`) carries in its manifest:

```
"light": {"strength": 0.6, "color": "#ffb45c", "radius": 5,
          "reference": "the spawn bonfire is 1.0 (radius 7) and NOT the maximum; strength 0 is no light",
          "states": {"LIT_1": {"strength": 0.6, "color": "#4bffde", "radius": 5},
                     "LIT_2": {"strength": 0.48, "color": "#ffb45c", "radius": 4}}}
```

- **The class table is `config/factory.json` `groups[].light`** — one entry per
  group: `strength` by what the thing IS (beacon 0.9, hearth 0.7, brazier 0.6,
  streetlight 0.5, torch 0.45, lantern post 0.35, crystal 0.3, waystone 0.2,
  mushroom 0.15, candle on furniture 0.05–0.1) and the group's default
  `color`. Pixel counts alone cannot rank a torch against a willow full of
  fireflies, so the class sets the order and the art only the nuance. **A new
  group with lit art must get an entry or `pipeline/light.py` refuses it** —
  maps2's budget audits a piece with no block at the bonfire's radius 7, so
  silence would make a candle a bonfire.
- `pipeline/light.py` derives the block and **fills gaps only**: the 500
  blocks from the first pass are the reviewed reference and are never
  rewritten without `--force`. `state_variants` and `loop` call it for every
  new lit state; `light.py --check` is the gate (every lit piece and state has
  an entry) and runs at the end of each pass.
- Per state: `strength` = class × {0.8, 1.0, 1.2} by the state's emissive
  pixel share (V ≥ 0.8, S ≥ 0.2) against the group's median share — below
  0.6× → 0.8, above 1.3× → 1.2. `color` is the brightness-weighted mean of
  those pixels **normalised so the brightest channel is 255** (colour carries
  hue, strength carries brightness); fewer than 24 such pixels and the group
  default is used. `radius` = `round(1 + 6·strength)`, **no cap** — the bonfire is the reference (1.0), not the ceiling (maintainer: "a normal light not even near what will be the max"). The 7-cell cap was games2 budget spec and is going.
- Measured fidelity of the derivation against the first pass
  (`light.py --compare`, 1,320 states): radius identical on 84%, the rest off
  by one cell, never more than two; strength exact on 60%; warm/cool family
  on 89%. Radius is what the budget reads. (The first pass's own script is not
  in the repo; these constants were fitted back out of its output.)
- Read contract: `states[<LIT state>]` wins for a placement drawn in that
  state, else the top-level piece default (`maps2/pipeline/world3.py
  light_meta`). Published whole in `viewer_data.json` as `light` so the wiki
  and the game read the same block.
- Flicker (a type + parameter beside strength/colour) is deliberately not
  here yet (maintainer: "not now").