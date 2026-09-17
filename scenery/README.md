# Nangijala Scenery

**Scenery** is the game's freely placeable, optionally animated set dressing —
trees, stones, graves, braziers, streetlights… Two properties define the
domain against tiles: a piece can be placed anywhere (it does not follow the
tile grid — `tiles2/`'s job), and it can animate (tiles cannot).

Owned by the **scenery agent** (board file `coordination/scenery.json`),
with the **scenery-assistant** (2026-09-12, `coordination/scenery-assistant.json`)
taking the units the scenery agent is idle or occupied for — it reads the
scenery board first, never touches a file named there as in flight, and
names every file it touches on its own board.
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

### Roof-mounted: `chimneys` (maintainer 2026-09-13, commissioned by name)

**THE GROUP IS ITS OWN TYPE, `CHIMNEY`** (maintainer 2026-09-13: "I can't find
a separate filter for Chimney"), for the same reason `WINDOW` is one: a fixture
that belongs to a building is reviewed and placed on its own, not scattered
through TOWN. This domain owns the taxonomy (`config/factory.json` `types`,
"the type is your responsibility the very second he commits"), so minting one
is a line here plus the group's `type` — but the WIKI's two lists are hard-coded
against it: `wiki/build.mjs` maps any type outside its literal `TYPES` array to
OTHER, and the Scenery page's chip row iterates a literal `OBJ_TYPES`. Until the
wiki reads the domain's list, a NEW type shows as "Other" there with no chip of
its own. Mint a type and post to the wiki in the same run.

"Generate a chimney in section town we can put on housed with chimney ... 3
chimney with 5 variations / scenery (a total of 15 different chimney). They
should be NOT_LIT." Three pieces, five NOT_LIT states each, no lit state at
all: `lights: "LIGHTS_OFF"` pins every piece unlit and `state_plan: [5, 0]`
pins the ladder (`state_variants.py`'s NOT_LIT rungs run to 10 so a group may
ask for five; the 4-own/2-opposite default is unchanged).

- **A ROOF-MOUNTED PIECE CARRIES ITS OWN `modifiers` AND ITS OWN
  `scale_phrases`** — the windows lesson, and the same trap: the shared
  `structure` pool and the default size ladder both describe a prop standing
  on the ground ("knee-high", "with fallen leaves collected at its base"),
  which is how a chimney ends up drawn in a garden.
- **THE CANVAS IS THE SCALE KNOB.** `world_px_height` IS the art's own alpha
  bbox (`rescale.py`), and the world is **51.2 px per metre** (the 87 px
  avatar over 1.7 m), so what decides how tall a new group reads is the canvas
  it is drawn on. Measured over the 706 shipped pieces: a 64 px canvas fills
  0.78 of itself (≈ 0.98 m), **96 px fills 0.75 (≈ 1.40 m)**, 128 px fills
  0.83 (≈ 2.07 m). Chimneys are 96 px, and the three landed at 1.15, 1.27 and
  1.68 m — the fill is a median, not a promise, so measure after a pass and
  re-roll what reads wrong rather than editing a number.
- **The pixel-grid gate is expensive for masonry, and it is right.** It counts
  same-colour runs exactly one pixel long, and a flat brick face honestly has
  few: the first three rolls scored 0.426-0.565 against the 96 px threshold of
  0.597 and were all re-rolled. The fix is detail in the ART — the description
  asks for every course and joint picked out pixel by pixel and dithered
  shading across the faces — never a lower bar. Budget for it: 11 rolls bought
  3 pieces (~$0.09 a roll), so a masonry group costs ~4x the domain's usual
  $0.16 a piece.
- **A pinned-lights group takes its indices IN ORDER** (`catalog.next_indices`,
  2026-09-13). Parity there carries the LIGHTS_ON/OFF promise, which a pinned
  group does not have, and the scatter is not free: the first pass planned
  002, 001, 004 — a gap at 003 that reads as a retired piece, and because the
  variety picker strides modulo the list, index 4 drew the SAME design as
  index 1. Two of his three chimneys came back one design; the group now
  carries twelve so a re-roll cannot collide.
- **`placed` — WHICH STATES THE WORLD ACTUALLY PUTS IN THE GAME**, per piece
  (`{"LIT_2": 1, "LIT_3": 1}`; absent = in no published world). The domain
  publishes every state a piece has and the world picks one or two of them, so a
  review of "hearth_001 lit_1" can be perfectly applied, deployed and verified
  on the live server and still change nothing anybody sees — which is exactly
  what happened (maintainer 2026-09-15: "I feel the change I did on that scenery
  light is still not in the game"; the world places that hearth as LIT_2 and
  LIT_3 and LIT_1 nowhere). MEASURED THE SAME DAY: 1319 LIT states published,
  77 placed — so a lighting review picked at random is 1 in 17 to be visible.
  The join is `pipeline/pack.py` `placed_states()`, the same closure the packed
  layer already uses (`games2/config/publish.json` -> `maps2/worlds3/<w>/
  world.json`), published by `viewer_build` and never fatal: if the worlds are
  not on disk the field is simply absent.
- **A TUNING REVIEW IS NOT LIVE UNTIL THIS DOMAIN APPLIES IT** (maintainer
  2026-09-15: "is the change I did live yet? Me doing a review doesn't redeploy
  the game as far as I know" — he is right). THE GAME'S LIVE TUNING IS THREE
  DOCUMENTS, not every file in `live/tuning`: `LiveTuning` in
  `games2/server/src/live.ts` is `{monsters, constants, scenery_animation}`, and
  the client fetches five tiles3 ground docs of its own (`tiles3runtime.ts`).
  Every other channel this domain owns — `scenery_lighting`, `scenery_hitbox`,
  `scenery_types`, `scenery_flips`, `scenery_lights`, `scenery_collision` — is
  registered by the server but read by NOBODY in the game: a light block reaches
  it from the PIECE'S OWN `scenery.json` under `/assets` (`scenery3.ts`), which
  is baked into the deploy image. So his correction sits inert until
  `pipeline/consume_review.py` applies it and the push deploys it (`scenery/**`
  is a `nangijala-deploy` path; his hearth went live six minutes after the
  apply). The opposite trap is in the same sentence: `scenery_animation` IS
  live-read, so retiring a spent entry there changes the running game the moment
  it lands — clear one only when the manifest already carries the same verdict,
  and verify that before pushing, never after.
- **THE LIGHT LADDER, AND WHERE THE NUMBERS COME FROM.** `strength` is a
  multiplier on THE SPAWN CAMPFIRE, not an absolute: games2 computes the slot's
  intensity as `CAMPFIRE_PEAK (1.9) x strength` and normalises the hex colour by
  its own brightest channel (`games2/client/src/scenerylights.ts`,
  `lightFromBlock`), so the hex sets the HUE and `strength` sets the brightness.
  `radius` is in CELLS and is passed through uncapped (maintainer 2026-09-07:
  "the campfire is one light, not the game's maximum"). Two fixed points to
  judge a new piece against, and the second one is the one he actually sees in
  play: the campfire is strength 1.0 at radius 7, and THE PLAYER'S OWN TORCH is
  the game's `[0.85, 0.58, 0.32]` at radius 6 — the same three numbers a
  manifest would write as **#ffae60, strength 0.45, radius 6** (0.85 / 1.9), a
  gentle flicker of 0.35, held at waist height, only ever your own, and ×1.6
  overbright while you are dead. Anything at strength 0.45 lights a room as
  much as walking in with a torch does. The published spread today: median
  strength 0.12 and median radius 2, up through a lantern post (0.42, r7), a
  streetlight (0.60, r11), a hearth (0.84, r16) to the beacons at 1.0, r18.
  That ladder is on the wiki's strength slider too — the `reference` string in
  every light block is what the wiki shows as the rail's title
  (`wiki/site/wiki.js`, `rail("strength", ...)`), so it is where a number he
  needs mid-review belongs; `pipeline/light.py`'s `REFERENCE` writes it and the
  500 pieces that carry one are backfilled with it.
- **THE TAG A CONSUMER READS — `mount`, `fixture`, `vent`** (maintainer
  2026-09-13: "make some form of tag so the game/ambient-agent knows what this
  scenery is and can place it and attach an effect to it properly ... he will
  need to know where the chimney center hole is"). Three published fields, none
  of them inferable from a group's name — the `light.kind` lesson, where 99 of
  500 pieces override their own group:
  | field | where | what it says |
  |---|---|---|
  | `mount` | piece (group default) | the surface a placer may put it on: `roof`, `wall` (windows, wall_hangings), `cliff` (the cliff_* families). ABSENT means ordinary ground — read a missing mount as `ground`, never guess from the id |
  | `fixture` | piece (group default) | WHAT it is, for a consumer attaching behaviour: `chimney` today |
  | `vent` | per STATE, and the anchor's copy at the piece root | where the effect comes out: `{dx, dy, conf}` in FRAME PIXELS FROM THE CANVAS CENTRE, the `light_frames` convention, so the packed layer's `ox`/`oy` shift it like any other measured point |
  `vent` is measured by `pipeline/vent.py`, per STATE because every variant
  draws its own cap, AND PER FACING — SE and SW are real three-quarter views
  and the hole is not where the south view puts it. `conf` says how it was
  found: `opening` (a dark hole), `flue_top` (the top of the narrow flue, for
  a pot whose mouth is drawn light rather than as a hole) or `silhouette`
  (neither). Measured over the 40 states x 3 facings: 117 `opening`, 3
  `flue_top`, and every anchor lands on a pixel of its own art that is dark —
  which `--check` proves on every run (`OFF THE HOLE` is a failure).
  **THE MAINTAINER MARKED FOUR ROUNDS OF THIS BY HAND, and every correction is
  a rule now** (2026-09-13, his red circles on the measurement against green
  crosses on the truth). They are listed because each one is a trap the next
  measurement of anything on a sprite will fall into:
  - **THE FLUE IS THE NARROW THING AT THE TOP, and the mouth is in IT.** The
    measurement had put it on the CAP beside the pot, where the socket's shadow
    is bigger and darker than the pot's own opening. So the search walks down
    from the topmost row while the silhouette stays under 55% of its widest
    row; that run is the pot or pipe, and nothing below it can win. A plain
    capped stack has no such run and is searched from its top as before.
  - **AN OPENING IS COMPARED WITH THE SILHOUETTE AT ITS WIDEST ROW**, never at
    its top one. On a capped stack the hole IS the big dark rhombus, and the
    width test was throwing it away: in a three-quarter view the opening's top
    row is the cap's far corner, where the silhouette is narrowest, so a 31 px
    opening measured 31/29 and read as a mortar course.
  - **THE SMOKE STARTS IN THE MIDDLE OF THE HOLE, not at its rim.** Only the
    DARKEST part of a big opening clears the cut — the deep shadow under the
    far rim — while the near inner wall catches light, so the winning blob is
    grown over a relaxed cut (1.37x the cut that found it) before its middle is
    taken.
  - **AND THE MIDDLE MUST BE A PIXEL OF THE HOLE.** "You nailed everyone except
    the 3 I posted": on three stacks the cross sat on the lit course just UNDER
    the opening, and on a fourth on the rim above it. Four rules came out of
    that round, and they are the ones to copy for any future measurement:
    - A GROW CAN WALK OUT OF THE HOLE. A cap's rim casts a dark band that runs
      wall to wall under the mouth and joins it through one shadowed mortar
      joint; the mean of mouth+band lands on the band. A mouth is never as wide
      as the stack, so a grown shape that is gets thrown away and the darkest
      core alone is the hole.
    - THE MIDDLE IS THE BOX CENTRE, NOT THE MEAN. A mouth carries a ragged dark
      fringe down its shaded side and the mean rides into it (5 px off his mark
      on chimney_009, where the box centre landed 1 px away). The point is then
      SNAPPED to the nearest pixel actually in the region.
    - A DARK CAP NEEDS A DARKER CUT. A wooden crown is as dark as its own
      cavity at one cut, so the two fuse, touch the outline and are dropped —
      the piece fell back to its silhouette and put the smoke on the rim. The
      cut walks down a ladder until the cavity separates; the first rung that
      finds anything wins, so pieces that already worked are untouched.
    - THE OUTLINE IS THE OUTSIDE, NOT ANY TRANSPARENT PIXEL. A cap raised on
      legs is drawn with real holes through it and the mouth under it touches
      them; only the background the piece floats in disqualifies a blob, so the
      transparent pixels are flood-filled from the canvas edge first.
  A mouth must also BEGIN in the top third of the piece (a shadow a third of
  the way down a stack is not a hole), and INSIDE A POT the highest dark thing
  is the mouth — the size slack that lets a cap's far rim win belongs to caps,
  and it was handing a pot's shaded flank the anchor instead of its little
  ellipse of a mouth. **INSIDE A POT, ONE ROW OF SHADOW IS A MOUTH**: the 2-row
  floor throws out mortar lines on a masonry cap, but a pot has no mortar and
  in this projection its mouth is often a single row of deep shadow under the
  far rim with the rest of the bowl merely shaded. Holding the floor at 2 left
  those pieces on the `flue_top` fallback, which anchors on the rim's top edge
  — 5 px above the mouth, and he marked every facing of that pot (his fifth
  round, 2026-09-13).
  **A FLUE HOLDS ITS WIDTH; A CORNER NEVER DOES** — this is what tells a pot
  from the top corner of a box in three-quarter view, where every box starts
  narrow. A pot widens from its rim and then repeats one width down its body
  (7, 11, 13, 15, 17, 17, 17, 17); a corner gains a couple of pixels every row
  and repeats nothing, so the test is a PLATEAU (one width over 30% of the
  run). Two simpler rules died here and are not coming back: a ratio bound (a
  pot tapers 2.6x from rim to foot, so the bound that stopped corners threw
  pots away and let the anchor wander onto the brickwork beside one) and a
  step-out under the run (in three-quarter the cap under the pot starts at ITS
  own corner, so there is no step to find).
  The rules that survive from the first pass: the darkness cut is a fraction of
  the piece's OWN median luma (a percentile finds a "darkest fifth" even where
  there is no hole); a blob must span 2+ rows (a pot's mouth is a two-row
  ellipse in a three-quarter view); and on a plain cap a blob must stand back
  from the silhouette or it is the rim's own shadow.
  **A MEASUREMENT OF WHERE AN EFFECT LEAVES A PIECE CANNOT BE GATED, ONLY
  LOOKED AT.** Four cuts of this passed their own checks and read plausibly on
  a contact sheet; his eye on the art caught every one. `--sheet` draws a
  crosshair on every mouth: run it and LOOK. The counter-gate in `--check` is
  the cheap half of the lesson — it re-reads every published anchor and fails
  any that is off the art or on lit material — and it would have caught three
  of the four.
  **AND THE SHEET HAS TO SURVIVE THE PHONE, or the review is about the sheet
  instead of the art.** He reviews on a phone, where a 3516 px sheet is drawn
  at ~1000 px: the original one-pixel cross became a third of a screen pixel
  and disappeared into the art, so he circled a light MORTAR JUNCTION as
  "yours" on two different pieces — both times the measurement under his own
  green cross was already correct to 3 px. A marker for a phone review is drawn
  at the TILE's scale (arms 5x the zoom, thickness the zoom, a black halo, a
  ring, and a hole in the middle so the anchor pixel stays visible) in a colour
  the art never uses (cyan), and **every tile carries its NUMBER** — that is
  what lets him say which tile is wrong instead of drawing on it, and what lets
  this side map a mark back without guessing from the artwork.
- **SE/S/SW COST NOTHING** and are already a standing order (his 2026-08-28:
  "Everything under 'Indoor' and under 'Town' should have SW, S and SE").
  Anything 168 px or under went down `create-8-direction-object`, so PixelLab
  generated all eight facings at birth and has stored them since;
  `pipeline/add_facings.py` downloads SE/SW for any INDOOR/TOWN state that
  lacks them, at zero generations, and the group's `keep_directions` keeps new
  pieces shipping them from birth. Scenery still never ROTATES — three facings
  exist because a wall (and a roof ridge) faces three ways.
- **THE GAME CANNOT YET DRAW ONE ON A ROOF** (measured 2026-09-13, raised with
  games + maps2). A placement whose cell is under a `roof` or `cave` deck is
  flagged `roofed` (`games2/client/src/scenery3.ts roofedCells`) and is drawn
  ONLY while that roof is cut away — it is the mechanism that furnishes
  interiors — and maps2's `render3` drops it from the still render entirely.
  So a chimney placed on a house today is invisible from outside and appears
  when you walk in. The art is finished and reviewable; putting it on a house
  needs a placement that sits ON a deck (drawn at the deck's level, never
  indoor furniture) from those two domains.

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

## THE PACKED LAYER (games2 reads it; `pipeline/pack.py` writes it)

Every piece the published worlds place carries `packed/`: each art file the
game draws, cut to its STATE's box — the union of the opaque boxes of the
state's still, its rotations and every frame of its clips, plus 1 px — under a
content-hashed name (`packed/<same subpath>.<sha8>.webp`), with
`packed/index.json` naming the current file per raw path and the cut (`ox,
oy, w, h` on the `srcW x srcH` canvas). The game loads the packed twin,
measures it back on its source canvas and registers the still's rectangle in
the packed texels, so no placement, hitbox, `light_frames` offset or
emissive centre moves (games2/docs/scenery.md; its gate
`games2/scripts/verify-scenery-pack.mjs` proves it). Measured on the_game's
192 pieces: the art fills 27% of its canvases, one box per state keeps 73%
of the decoded bytes (291 -> 211 MB), 36 MB on disk.

- **The raw files are untouched and stay the truth**: the wiki, the viewer,
  render3, the bbox table and every review read them. Packing changes what
  the game UPLOADS, never what anyone measures.
- **A box is one canvas**: a file on a different canvas than its still
  (crystal_tree_002's 68-px frames under a 64-px still) is not packed and
  draws raw, exactly as before.
- **Run it after anything changes what the worlds place or what a placed
  piece looks like**: `python3 scenery/pipeline/pack.py` (placed pieces;
  `--all` for the whole domain, `--only group/id`, `--check` exits 1 when a
  placed piece is stale). Resumable: a family whose raw bytes hash to the
  index's `src` is skipped. A newly placed piece draws raw until it runs —
  correct, just bigger.
- **Cache law**: never a stable name; current + one back (`prev`) so an open
  page keeps rendering through a deploy.
- **Who runs it — nobody, by hand** (scenery-assistant 2026-09-12; the games
  agent wrote the script under the maintainer's grant and asked this domain to
  keep it current). Two hooks, both incremental (a family whose raw bytes hash
  to its index's `src` is skipped: ~1 s over the 192 placed pieces when
  nothing changed): `viewer_build.build()` calls `pack.refresh(jobs=1)` at the
  end of EVERY pipeline script, so a re-rolled placed piece is re-cut in the
  unit that re-rolled it; and `.github/workflows/scenery-pack.yml` packs after
  a push that changes `maps2/worlds3/*/world.json`, `games2/config/publish.json`
  or `scenery/**` outside `packed/`, commits, and dispatches the deploy when it
  pushed anything (a bot-token push triggers no workflow on its own — so it
  cannot loop, and cannot roll without the dispatch). Packing never fails a
  publish: a piece that will not pack draws raw. `pack.py --check` is the gate
  either way.

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
- **Reach is not brightness** (maintainer 2026-09-06: "A streetlight should
  reach 2x the bonfire, but it doesn't have to be brighter at the core — just
  reach twice as long"). Two numbers, two knobs:
  - `strength` is the CORE, relative to the bonfire (1.0). Per state: class ×
    {0.8, 1.0, 1.2} by the state's emissive pixel share (V ≥ 0.8, S ≥ 0.2)
    against the group's median — below 0.6× → 0.8, above 1.3× → 1.2.
  - `radius` is the REACH in cells, from the group's `light.reach` in config.
    Anchor: streetlights **9** (the bonfire is 7); every other group in
    proportion to its class strength so the first pass's ORDER is kept
    (beacon 16, hearth 13, brazier 11, torch 8, lantern post 6, crystal 5,
    waystone 4, mushroom 3, candle on furniture 1–2). The anchor is the one
    number to turn: changing it rescales the whole table by the same
    percentage. (Set to 14 first — "a bit overkill" — then 9.) Per state in proportion to that
    state's strength against the piece default. Edit any group's reach by
    hand; `light.py --reach --write` re-applies. `round(1+6·strength)` is only
    the fallback for a group with no reach.
  - `color` is the brightness-weighted mean of the emissive pixels
    **normalised so the brightest channel is 255** (colour carries hue,
    strength carries brightness); fewer than 24 such pixels and the group
    default is used.
- Measured fidelity of the derivation against the first pass
  (`light.py --compare`, 1,320 states): strength exact on 60% — the rest one
  nudge step off in the fuzzy middle band; warm/cool colour family on 89%.
  Radius is reach × that state's nudge, so a one-step strength disagreement
  now shows as up to ±3 cells on a 14-cell streetlight (radius identical on
  67%). The 500 first-pass blocks are kept as the reference; only regenerated
  pieces feel this. (The first pass's own script is not in the repo; these
  constants were fitted back out of its output.)
- **What KIND of light it is** — `kind`, a two-level path, read off the art
  piece by piece (2026-09-08), plus two booleans derived from it so no
  consumer parses the path:
  | kind | `flame` | `embers` | what it is |
  |---|---|---|---|
  | `fire/open` | yes | **yes** | a visible flame: torch, candle, hearth, campfire |
  | `fire/ember` | yes | **yes** | coals, hot metal, molten rock, smoulder — heat, no flame |
  | `fire/enclosed` | yes | no | a flame behind glass or horn: lantern, oil lamp, street lamp |
  | `glow/magic` | no | no | runes, wisps, enchanted liquid, spirit light, electricity |
  | `glow/mineral` | no | no | crystal, geode, gem, meteor |
  | `glow/bio` | no | no | fireflies, fungi, foliage, blossom, honey, moss |
  | `glow/water` | no | no | well, spring, fountain, pool |
  | `none` | no | no | the LIT art shows no emitter — do not light it |

  **`embers` is not `flame`**: a lantern is a real fire and throws nothing,
  because the glass is between it and the world. **The group name is not the
  answer** — `brazier_001` is a bowl of teal crystals, `brazier_010` is
  smouldering coals with no flame, `lantern_post_017` is an open flame on a
  post, and `torch_post_004`'s fire is blue. 99 of 500 pieces override their
  group, so a name- or colour-based test is wrong roughly one time in five.
  Group default in `config/factory.json` `groups[].light.kind`, per-piece
  override in the manifest's `light.kind`; `light.py --kinds` stamps the block
  and `--check` fails if any is missing. One `kind` per piece, read from its
  first LIT state — if a piece ever needs one per state, that is the extension.
- **Animation review** — `review` on every animation, one of
  ANIMATION_PROBABLY_GOOD / _BAD (this domain's) or ANIMATION_APPROVED /
  ANIMATION_REDO (his, from `live/tuning/scenery_animation.json`, never
  overwritten). The game plays GOOD and APPROVED and shows nothing for REDO.
  The test is **how far the outline moves**, not whether pixels changed: the
  share of the piece's bottom 15% whose ALPHA silhouette shifts, worst frame
  and worst facing, `<= 0.10`. A trunk repainted with different dither changes
  every pixel and moves nothing. (Calibrated on his 263 approvals — median
  0.003, p95 0.042, 0.10 covers 98% — and tree_009, whose roots genuinely
  swing, sits at 0.632 and stays out. A colour-based version rejected 221 of
  the 263 he then approved; the per-class table it needed is gone with it.)
- **Per-frame light on LIT animations** — `light_frames` beside each
  direction's `frame_paths` (windows excluded), one `{intensity, dx, dy}` per
  frame in frame order. `intensity` is relative to the clip's own mean, so
  `strength × intensity` is that frame's strength and a loop averages to the
  block; clamped to 0.5–1.5 (a frame the emissive test barely catches would
  otherwise strobe the room — dimmer is the effect, blackout is not).
  `dx`/`dy` are the emissive centroid's offset from the frame centre in frame
  pixels, the hitbox convention. Measured from the same emissive pixels as
  `color` (V ≥ 0.8, S ≥ 0.2), V-weighted. A pure function of the frames, always
  recomputed; `light_frames.py --check` gates it. (maintainer 2026-09-09: "the
  spotlight differs a bit with the animation and the game will feel more alive")
- **Animation shape, and the strip trap.** Every animation object carries
  top-level `frame_paths`, `strip` and `light_frames` for SOUTH (the game's
  `parseAnims` reads only the top level and drops a clip with neither), with
  `directions` holding the per-facing detail; `normalize_anims.py` lifts them
  and is idempotent. **An anchor state's strips live at the PIECE ROOT** while
  its animation is registered under `states.<ANCHOR>` — a strip is dead only
  when no state and no root animation names it. (Paid for 2026-09-10: a rule
  that checked the root's animations alone deleted 288 live strips and the map
  agent lit a brazier off a verdict on a clip the game could not find.)
  The wiki resolves `directions.<dir>.strip`, then top-level `strip` for
  south, then the on-disk name — a recorded strip wins, and a recorded strip
  counts only if the file exists (hundreds carried the legacy `__strip.webp`
  name after the file was gone; parseAnims takes any string and 404s it).
  `anim_review.py --check` refuses a playable verdict on a clip either
  consumer cannot resolve, or whose strip is missing.
  **A regenerated clip is unpublished until `finish_clips.py` has run on it**
  — strips rebuilt from the CURRENT frames under content-hashed names
  (`<name>__<dir>.<sha8>.webp`, previous kept) and recorded, fields lifted,
  `review` stamped, `light_frames` recomputed, piece re-packed, viewer
  rebuilt, gate run. `redo_facing_anim.py` ends with it; any tool that
  rewrites frames must. `finish_clips.py --check` is the gate (0 unfinished,
  0 unreadable, and the review / light_frames / pack gates green) and it is
  run before a push, not after. (Paid for 2026-09-15: the redo tool popped
  `frame_paths`/`strip`/`review` off 18 clips — every hearth clip among them
  — and pushed; parseAnims dropped all 18, the hearth in his house went
  still, and the untouched strips on disk kept showing the wiki the OLD
  flame. `repair_strips.py` skips a strip that exists, so it cannot refresh
  one — that is finish_clips' job.) The packer's closure follows
  `directions.<dir>.frame_paths` as well as the flat list: a turned placement
  plays the facing's own frames, and a path the index lacks is served raw
  under a stable name, outside the hashed layer (2026-09-17, 65 families).
- **A redo brief names the piece's OWN moving thing** — `config/redo_prompts.json`,
  keyed `<group>/<piece>#<STATE>#<anim>`, read by `redo_facing_anim.py`; the
  generic flame brief is the fallback, never the rule. Wording alone does not
  hold a piece still if the subject is wrong (2026-09-15: "ONLY the flame
  flickers" sent to a barrel of water, a skull's eye-light, a bush's leaves and
  a cairn's ripple measured 0.16–0.81; the same wording with the right subject
  is what took the hearths to 0.003–0.028). `--only a,b,c` restricts any
  selector; `--rounds N` re-selects only the still-PROBABLY_BAD targets after
  each finish (maintainer 2026-09-17: "give them 2 new rounds if they need
  it") and prints what is still over the line at the end.
- **Removed art is published, not just deleted: `scenery/retired.json`**
  (`scenery/retired@1`; `pipeline/retired.py`, republished by every
  `viewer_build.build()`, `--check` gates it against the retirement records).
  `pieces` are gone whole; `states` are gone while their piece stays and carry
  the piece's `surviving` states so a consumer can re-state a placement rather
  than drop it. This is the join point for the world (maps2) and the game's
  gate — the thing that ends "the art is gone, the world still places it"
  (maintainer 2026-09-17: "You need a way to directly remove/replace assets
  from the game when you have revoked/removed them"; cupboard_004 x2 in
  August, chimney_002 x2 from 09-14 — both sat red until someone else ran).
  Consumers read this file, never `config/retired_*.json`. **A retirement
  record means the art is DELETED** — `retired_ids.json` / `retired_states.json`
  are facts about the art, never planner flags: an id with a manifest, or a
  state its manifest still carries, must not be on them (`retired.py --check`
  fails; `--clean` un-lists them). (2026-09-17: six live pieces were listed —
  chess_table_006/009, placed in the_game, and four graves — and the
  maintainer read "retired" as "removed": "I love the chess-tables!" Un-listing
  is safe: the loop creates only MISSING assets, so an id with a manifest is
  never re-rolled either way.)
- Read contract: `states[<LIT state>]` wins for a placement drawn in that
  state, else the top-level piece default (`maps2/pipeline/world3.py
  light_meta`). Published whole in `viewer_data.json` as `light` so the wiki
  and the game read the same block.
- Flicker (a type + parameter beside strength/colour) is deliberately not
  here yet (maintainer: "not now").