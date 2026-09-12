# The World section — Tiles 3.0 in the wiki

How the ground pages, passes, transitions, ledger and filters work, and the breaks that shaped them. Moved verbatim out of `wiki/README.md` (2026-09-09), which keeps the rules and points here; rewrite in place under the root doc law.

## The queue does not move under his thumb

A verdict in a review QUEUE removes that card where it stands; nothing above it
re-renders (maintainer 2026-09-12, on a ground's details: *"if I press approve
the already reviewed element is moved down instead of the next item to review
moving up. This means I have to scroll before I can press approve again. This
takes time. I want to be able to not move my thumb and press approve/not a
detail on the exact same place over and over again until everything is
reviewed."*)

- The old behaviour re-rendered the page at the same `scrollY`, and the judged
  top joined the collection ABOVE — one card taller — so the queue and every
  button in it slid down a card. Same scroll position, different pixels.
- `judgedInPlace(card)` drops the card from the DOM and corrects the queue's
  count in place. The collection and the "N approved" pill catch up on the next
  natural render, which is the deal the stars have had since 2026-08-28.
- **THE QUEUE GROWS BY ITSELF AT THE BOTTOM** (maintainer 2026-09-12: "Can you
  automatically expand and show more once I'm at the bottom (will speed up the
  review). It's also important that the approve/remove button stay on same
  place after automatic expand."). An observer on a sentinel under the grid
  appends the next dozen 900px before he reaches the end; the "Show 12 more"
  button stays for a thumb that gets there first and calls the same function.
  Nothing is re-rendered — the cards are APPENDED — so nothing already on
  screen moves, and judging the last visible card appends rather than routes.
- **A FIELD IS DRAWN WHEN IT COMES NEAR THE SCREEN**, 800px out (`drawNear`).
  The old page decoded tiles and drew a 25-cell scene for every card the
  moment it rendered — the whole approved collection included — which is the
  lag he felt ("the page is very big and starts to lag. This lag in itself
  slows down the review"). Measured on deep water: 4 fields drawn on entry
  instead of 65, and an expand costs twelve cards instead of every card on the
  page.
- **The buttons sit on the RIGHT**, where a hand holding a phone already is,
  and the stars keep the left (`judge-right`, `margin-left: auto` on the
  verdict rather than a flex end on the row, so the stars do not move with
  them). The reject button says **"✕ remove"** — his word (2026-09-12), not
  "not a detail"; the tooltip still says what it touches, which is the detail
  pool and not the tile.
- Gate: `wiki/tools/check-queue.mjs` taps the same PIXEL four times and fails
  unless each tap judges a different top and lands on the same coordinates,
  asserts the labels and the right alignment, scrolls to the bottom to prove
  the queue grows with no button pressed, and checks that fewer fields are
  drawn than exist.

## The ground system: World (Tiles 3.0)

`tiles/` is THE tile library (tiles2 — the "Tiles OLD" row — was deleted
2026-09-09 with every world it painted; history in git). The section is plain
`world`, no `adminOnly`, and its feedback domain key stays `tiles` (the ids the
maintainer's verdicts already ride on).

**Three levels**, the way he thinks about ground (maintainer 2026-08-17):
`#/world` the ground types → `#/world/<top>` every wall that ground can stand
on → `#/world/<top>/<side>` the pair itself. The types are DERIVED from the
pairs, so the live manifest refresh reshapes the section without a rebuild, and
a pair is addressed by its two halves rather than its cell key — the pair IS
"grass over snow", and a url that says so survives the agent renaming keys.

**Both previews live on the TILE, in ONE box** (maintainer 2026-08-17: *"The
individual tile preview under 'Tiles in this set' should inside the same
preview have the 3x3 on the left side and the V stack on the right side. I feel
I need this in order to review individual tiles … Why I want the two types of
previews in the same preview is just to save space on the page"*). Left, a
**3×3 flat patch** — the shape Tiles OLD's tile page uses, so a field of 3.0 is
judged in the shape he has been judging 2.0 in, and the seams that matter are
the ones between neighbours on BOTH axes. Right, the **V from Tiles OLD**:
three 3-high stacks meeting at a corner. Both come from `isoScene()`, the same
composer Tiles OLD uses — the game's own projection at the game's own scale, so
a strip here measures what a strip measures in the world.

- **The tile itself is magnified above them** (maintainer 2026-08-17: *"another
  preview where you show a single 2x zoomed tile … This preview should be just
  on top of the preview we have now"*). The scenes answer "does it tile"; the
  zoom answers "what IS it" — 2× is where the palette snap and the clipped
  outline are readable at all. Integer scale and nearest neighbour, the only
  zoom pixel art survives; it flips with that tile's before/after chip like
  everything else on the card. It shipped for half an hour as a 2×/4× pair and
  came straight back — *"the 4x was way too big, it's enough with one centered
  at 2x"* — which also gave the page its margins back: 128px asks nothing of the
  layout, where 384px of art on a 393px screen asked for everything.
- **They are TWO boxes, not one with a line in it** (maintainer 2026-08-17,
  after a rule inside a shared chessboard was not enough: *"there should be some
  separation between the preview on top and bottom — it's not the same
  preview"*). They are not drawn at the same scale, so one unbroken chessboard
  makes them one picture and the 2× tile becomes a lie about how big a tile is.
  A line says "same window, new section"; a gap of the card's own surface says
  what is actually true.
- **Every row is centred.** Two canvases of fixed pixel widths never fill a
  fluid box, and packing them left piled the whole leftover on the right —
  27px of chessboard on one side and none on the other.
- **A tile's preview shows THAT tile**, never a roll of its neighbours. There
  is no seed, no Randomize and no approved-only pool: the earlier shared "laid
  out as ground" card mixed the whole set, which answered "does this set work"
  while the verdict under it asked "does this tile work". One question per
  card. The mixed card is gone.
- **The V follows the tile's own wall mode**, which is the other half of why
  the two shapes belong together: flipping "own wall" ⇄ "top only" on this card
  changes the cliff drawn six inches away, and there is nothing to compare it
  against if the cliff lives in a different card built from different tiles.

**The review unit is the CANDIDATE**, because that is the question the tiles
agent asks. `tiles/review/manifest.json` (`tiles3/review@2`) offers two or
three generations per "A over B" pair, ranked by a measured wall score, and
defines what a verdict means — *"`tile_id` is the PixelLab generation a
rejection should delete … A DELETED cell is tombstoned and never regenerated,
unlike a rejected one."* So the pair's page shows every candidate side by side
with its art, its score against the agent's own acceptance bar, the three
measurements behind that rank, how flat the top came out, and its prompt.

- **Verdicts ride the manifest's own keys** (`tiles/<cell>/<n>`) in the `tiles`
  feedback file that agent already reads — no id scheme of the wiki's invention
  to keep in sync. Feedback ids are repo paths, so two domains never collide
  in one file.
- **The pair carries NO verdict of its own** (maintainer 2026-08-17: *"You can
  also remove the approve/reject/rate at the top of the page. The review will
  only ever happen on the individual tiles themselves"*). The pair's state is
  the sum of its tiles', so the filters count approved/redo/unreviewed pairs
  from the candidates and nothing else — there is no "dropped pair" any more,
  and the wiki cannot tombstone a cell.
- **Every number is the agent's.** The wiki never scores a tile itself: the two
  would drift and his verdict would be about a ranking nobody else can
  reproduce. The gate asserts the scores match the manifest to the decimal.
- **The pairs are read LIVE**, not from the build. Every other domain is
  settled art; this one is a factory running right now, so the admin's World
  section refetches the manifest through the staging root his art already comes
  from and rebuilds the list from it. The baked copy is the fallback.

**The pure `X over X` tile is what ground IS.** Maintainer 2026-08-17: *"That
tile type is the type that always should be used in the game when a tile is not
at the top."* So the wiki uses it in the two places a tile stands for more than
itself — the type card on `#/world` (grass is shown as "grass over grass", not
whichever pairing sorts first) and the courses under a V. It is picked by
verdict, approved first, then unreviewed, never a rejected one; a type whose
self pair has not been generated yet falls back to its own art rather than
drawing an empty box. **This is a wiki rule, not a game change** — he asked for
it in the review surface (*"You should implement it in the wiki and not in the
game ofc"*).

- **Wall mode is per tile, and defaults to "own wall"** (maintainer 2026-08-17:
  *"some tiles in fact do look good and can build a wall and some need help
  from the … pure tile. By default a tile should be able to create it's own
  wall, but I as an admin should be able to change the tile to top tile
  only"*). The strip under each tile switches it; "top only" stacks the pure
  tile beneath that tile's crown instead. It is a PROPERTY, not a verdict —
  a top-tile-only tile is a tile with one job — so it saves to
  `live/tuning/tile_walls.json` (`pixel-wiki-tile-walls@1`), not to the
  feedback file, and clearing it deletes the entry rather than storing the
  default.
- **Before / after** (admin, whole-section) switches every tile between the
  generator's raw output (`before`) and what the postprocess made of it
  (`after`, the file that ships). One truth per screen: the pair's own portrait
  follows the switch too, and paging keeps the mode. A candidate with no
  `before` says "no before" rather than silently showing the after twice.
- **And the same switch sits on every tile**, as a chip on its own picture
  (maintainer 2026-08-17: *"that button might be higher up so I have to scroll.
  Can you place that button so I have access to it for each tile?"*). The chip
  **overrides for that tile only** — the tiles beside it hold still, so a
  difference he sees is the postprocess and not the page — and it says which of
  the two he is looking at, because mid-comparison that is the one question the
  picture must answer. It rides on the art rather than under it: a row below
  would push the next tile down and spend the vertical space the shared box
  just saved. The override is not persisted and clears when the set-wide switch
  is used or another pair is opened: it answers "what did this one look like
  before", which is a question about the tile in front of him, not a setting.

**Everything above is the GAME MASTER's page. A reader gets the ground.**
Maintainer 2026-08-17, looking at the "What is new" panel: *"I feel this is too
technical for players that visits the World page. Normal players will just get
confused."* The section is admin-only in the nav, but `#/world` renders for
anyone who has the link, so the page itself has to know who is reading. Behind
`state.admin`: the "What is new" panel, the rank and wall score, the four
measurements, the flat-top and overhang numbers, the palette swatch, the wall
mode, the verdicts, the before/after switch, the prompt, and "Generated at
64px…". What is left for a reader is what an encyclopedia is for — a picture of
the ground, the cliff it makes, and a sentence in plain words.

- **A reader sees ONE tile per pair** (the approved one, else the agent's
  best). Three near-identical pictures with no explanation is the same
  confusion as the numbers under them, in another form.
- **The counts change words with the audience**: the Game Master's "56 pairs"
  is a reader's "56 grounds", and a type card says "over 14 grounds" rather
  than "14 pairs". Same number, different question being answered.
- The gate reads the rendered text of all three levels as a player and fails on
  a word from the factory — and asserts the Game Master still sees each of them,
  so the check cannot pass by deleting his instruments.

Gate: `wiki/tools/check-world.mjs`.

## The sticky crumb sat on the content — at scroll zero, for weeks

Maintainer 2026-08-21, with a circle drawn round the clipped top of a tile
thumbnail: *"This page have the thimbnail preview cut/clipped and I can't
scroll up do show it."* He could not scroll up because the page was already at
the top: the opaque sticky crumb row was **resting on top of the content**.

The crumb row pins under the topbar and cancels `#content`'s top padding with a
negative margin, so that it RESTS exactly where it PINS — otherwise the first
few pixels of any scroll slide it and it visibly jumps (the 2026-08-15 fix). It
cancelled a hardcoded **-24px**, the desktop padding. The phone breakpoint sets
**16px**. So on every phone the row rested 8px ABOVE its pin, sticky pushed it
back down, and it painted over **the first 8.7px of whatever followed, at
scroll 0**, unreachable by scrolling. Every detail page in the wiki had it —
monsters included, where a sprite's transparent top padding hid it; a tile
thumbnail's checkerboard is what finally made the cut visible.

The padding is a variable now (`--content-pad-top`) and the row cancels exactly
it, so rest == pin at every breakpoint. What remains is 0.75px, the deliberate
CEIL of the measured topbar height, which is a sub-pixel and invisible.

Gate: `check-crumb.mjs` measures, at scroll 0, on the phone AND desktop
breakpoints, across a pair page / a monster / a section / a list, that the
sticky row covers no more than 1px of the element after it. A stale
compensation cannot come back quietly.

## The inbox means "waiting for YOU", and dead reviews get pruned

Maintainer 2026-08-21, seeing seven tiles he had rejected sitting in his
no-stars queue as "7 of 7 without a star": *"Why don't you maintain and remove
old reviews I have already rejected?"* Two fixes, one per half of the sentence:

- **A rejected tile leaves the inbox.** "No stars" now means *neither starred
  nor judged*: a verdict is him having dealt with the tile, and a rejected one
  is the AGENT's queue, not his. The counts read "waiting for you" so the
  words match the meaning.
- **`wiki/tools/prune-feedback.mjs` grooms `live/feedback/tiles.json`.** A
  rejection's whole job is to make the tiles agent delete the generation;
  once the tile is gone from the review manifest, the entry has done its work.
  First run pruned 2,392 dead entries (1,966 spent rejections) from under
  4,049 live tiles — a third of the file was verdicts about art that no longer
  exists. Dry-run by default, `--write` prunes; commit the file to publish
  (the push refreshes the game server's store). **The one thing never pruned:
  `#top` entries with status approved** — the Game Master's ground-detail
  picks must outlive the pair-tile's manifest row, and the tiles agent keeps
  that art on the same rule. The wiki agent runs this after the tiles agent's
  regeneration waves.

## "overhang 1.00" on a tile whose overhang shipped as grass

Maintainer 2026-08-22, painting on a screenshot of deep water over grass: *"I
have painted RED on the overhang that should be deep_water, but currently is
green/grass. I also marked in purple what should be grass so you don't take too
much."*

He had made this exact report once before, on dark mud over slime, and the
tiles agent's `fix_left_wall.py` quotes it in its own source: *"The overhang
should be brown, but the wall marked with blue should still be green."* That
fix protects the brim on the cell it repairs — but it repairs one cell, and
nothing measured whether the brim survived anywhere else.

**The card had told him the opposite.** It printed `overhang 1.00`, which is
true and useless: `overhang` counts how much of the top *spilled* over the
edge, and every one of those pixels spilled — they just ship in the **wall's**
colour. The agent also publishes `clarity` (its `fringe_clarity`: can the
fringe be told apart from the wall at all?), and the wiki was not showing that
either — but clarity alone is not the signal. Its median across cross-material
tiles is **0.35**, and the cell he already had repaired scores **0.23–0.37**
with a perfectly good brim. Flagging on it would paint half the library orange.

So `wiki/lib/overhang.mjs` asks the question his red line asks, by comparing
the two passes the agent already publishes:

- **drawn** — share of the 6-row brim under the top's edge that reads as the
  **top** material in the BEFORE pass;
- **kept** — share of those same pixels that still do in the AFTER pass.

Both are measured against anchors taken from that tile's own pixels *in that
pass* (the top face for "top", the wall well below the brim for "wall"), so
nothing depends on a palette file or on the two passes sharing colours. Same-
over-same tiles cannot answer the question and are excluded by construction.

### Per FACE — the first cut averaged the answer away

He looked at the first version and said *"Same as before. red = SHOULD BE dark
blue. purple = SHOULD BE green."* The band was right — an overlay at 8× put it
exactly on his red line — but measuring the tile as a **whole** averaged a
healthy face together with a destroyed one:

| cell | left face | right face | tile average |
| --- | --- | --- | --- |
| deep water over grass (his) | 100% → **11%** | 95% → 93% | 98% → 52% |
| dark mud over slime (repaired) | 94% → 100% | 79% → 92% | 87% → 96% |

"52% kept" points at nothing. **"The left face keeps 11% of what was drawn"**
points at a code path — and across the library the loss concentrates there:
**104 left-face failures against 44 right**, which is the same face
`fix_left_wall.py` was written for, its docstring already describing how the
darker-lit left face gets handed to the wrong material wholesale.

So the card names the face: `brim left 11% kept of 100% drawn`, red when the
generator clearly draped it (`drawn ≥ 60%`) and the postprocess took ≥25 points
— **148 of 3,218 cross-material tiles, 4.6%**. `clarity` sits beside it,
unstyled, for the cases where the two materials were drawn as one and no
postprocess can separate them.

**Same-over-same is never asked.** Its top and wall are one material, so the
brim differs from the wall only by lighting; measuring it flagged grass over
grass and ice over ice on shading alone until the cell's own materials — not a
colour-distance guess — settled it.

Measured for every tile on every build (~3s for 3,690), keyed by the agent's
own tile key so the admin's live-manifest refresh merges it in without decoding
anything in the browser.

## The other half of the same break — a whole wall face swallowed

Maintainer 2026-08-22, on deep water over slime: *"RED = SHOULD BE SLIME.
PURPLE = SHOULD BE DARK WATER."* He marked a thin brim of water at the top of
the left face, over a body that should be slime — and the shipped tile paints
that whole body water.

**The brim measurement calls those tiles perfect, and it is right to.** The brim
survived; what died is everything under it. One of them measures
`brim left 100% kept of 100% drawn` while its entire left wall ships as water.
A metric that only watches the brim reports green while the wall goes.

So the same pass measures the **body** — everything under the brim, per face —
as the share reading as the **top** material:

| cell | left body: drawn → shipped |
| --- | --- |
| deep water over slime (all five tiles) | 4→95, 0→95, 15→100, 5→99, 17→99 |
| dark mud over slime | 29 → **97** |

### Judged by HUE, and the first cut was judged by RGB distance — wrongly

That table's second row was **a false accusation, and it was mine.** Judged by
RGB distance, dark mud over slime read 97% mud on its left face and I reported
it to the tiles agent as broken. That wall is green in both passes, by eye and
by hue.

The reason is the exact trap `fix_left_wall.py`'s docstring describes: *"the
darker-lit LEFT face sits closer to the mud anchor than to slime's own wall."*
A wall is lit darker than the top, and in raw RGB a **dark slime** `(17,55,40)`
sits nearer deep water's dark blue than it does to slime's own bright green.
Measured on the same pixels:

| | hue | verdict |
| --- | --- | --- |
| shipped left face (broken) | 205° | water — deep water's palette is 211–216° |
| the same face repaired | 156° | slime |
| the healthy right face | 151° | slime |
| brightness of all three | 0.22–0.25 | says nothing |

So the body check compares **hue arcs** against the two materials' palette
entries, ignoring pixels too grey to have a hue at all. The tiles agent's own
`fringe_clarity` uses hue for the same reason, which I should have taken as the
hint it was.

It also cost a round in the other direction: with RGB distance, running their
repair on the broken cell changed nothing measurable (95% → 95%) even though
the face had visibly gone from blue to green. A metric that cannot see a repair
is worse than no metric.

**Anchors differ by pass, deliberately.** The AFTER pass is judged against the
tiles agent's own `palette.json`, because the postprocess snaps to it and it is
therefore ground truth for what shipped. The BEFORE pass has the generator's
arbitrary colours and is judged against anchors taken from the tile itself.

Flagged when a face ships ≥70% top-material having gained ≥40 points over what
was drawn — **95 of 3,218 tiles, 3.0%**, 59 right-face and 36 left. The card
carries it as its own red pill: `left wall ships as deep water (95%, drawn 4%)`.

**The brim and the body are opposite failures of one routine.** The brim loses
the top material to the wall; the body loses the wall to the top material. Both
are `_split_wall` putting the boundary in the wrong place, and a tile can have
one, the other, or both.

### The loop closed once already

He reported deep water over **grass** at 09:00 measuring `left 100% drawn → 11%
kept`; the tiles agent shipped *"deep water over grass keeps the droop on its
shaded face"* at 12:12 and it now measures **100 → 100**. That check is a
regression guard in `check-groundtype.mjs` now rather than a complaint — if the
repair slips, the gate goes red.

## The transition passes, once the processed set arrived

The tiles agent published `post/` on 2026-08-24 — **283 of 284 sets**
(`grass__to__slime/a23_s1` is the one without, and its per-set flag still says
so). Verified before trusting the pictures, because these paths are derived
rather than read from a manifest: **0 geometry mismatches**, every processed
tile still 64×46 like its raw twin, and the two passes genuinely differ (2,012
of 2,944 pixels on a sample).

**Then Before broke, and it was mine.** Maintainer: *"Its good that you fixed so
the Transition page now renders After correctly. But now it looks like Before
instead fails to render correctly."* `wangScene` had been taught to follow the
switch, but both plain **strips** — the rows on the Transitions tab and the 16
corner tiles on the demo page — were still passing the set's `post` **flag**
where the pass belongs, so they drew processed tiles under every setting.

One rule now, `transArt`, shared by every place that draws a transition tile,
and gated on the **files fetched**, which cannot lie:

| pass | post fetched | raw fetched |
| --- | --- | --- |
| After | 40 | 0 |
| Before | 0 | 40 |
| Textured | 45 | 40 (synthesized onto a canvas) |

## Transitions compose: two plates and a mask, for every pair

Maintainer 2026-08-25: *"By studying how this is done we can without generating
more transition tiles get transition tiles for everything automatically by
using the formula and inserting the base tile from tile type A on one side and
base tile from tile type B on the other side."* And, on finding Black Rock's
tab empty: *"I expected to see/find transitions for all tiles VS all tiles."*

The hypothesis held, measured by the tiles agent: the 284 pregenerated sets
collapse to **18 (roughness, seed) patterns** whose boundary is
material-independent (95% pixel agreement across ~17 pairs each). They publish
the boundary as `tiles/patterns/masks.webp` (18 × 16 Wang frames, alpha = the
mask) and every approved ground as `tiles/plates/` — 64×46 plates whose alpha
is **byte-identical to one shared silhouette**, so composition is exactly their
three published canvas ops: draw the mask frame, draw plate B through
`source-in`, fill the rest from plate A with `destination-over`. No geometry
knowledge on this side at all; that is what plates are for (composing from a
review tile instead puts 928 of 2012 px in the wrong alpha, their measurement).

- **The Transitions tab lists every neighbour** — 14 per ground. The roster is
  the plates index, *not* the config vocabulary: the config still says
  `paving_stone` while the palette, the plates and his sets split it into
  brown/grey.
- **The pass switch decides the plates.** Clean #0 = each side's clean plate;
  Set #N = each side's OWN set N, picked per cell with the game's hash, so a
  field of composed tiles varies the way the ground itself does. **Raw stays
  the generator's art** and exists only for the 26 pregenerated pairs; on the
  others the pill says "no raw — composed clean" rather than letting the
  switch look effective.
- **The 1px seam is not optional.** A transition is not a bare 0-100 cut
  through the mask: the two grounds meet along a border, and without it the
  wiki draws a hard edge the generator never drew (tiles agent, maintainer
  verdict 2026-08-27). `tiles/patterns/borders.webp` shares the mask sheet's
  layout, so the same frame arithmetic indexes it. **One mask serves both
  sides because it DARKENS what is already there** — each side becomes a
  darker shade of *its own* ground, never a blend. Frames 0 and 15 are empty
  on all 18 patterns (verified), so a field of one ground carries no marks —
  if a grid appears, the wrong frame is being cut. A third of the seam is on
  the **wall**, the vertical edge a cliff shows. It is symmetric under the
  polarity flip (verified, 0 of 423,936 px differ), so the seam cannot be
  applied backwards.
- **Applied per pixel with `np.rint`, not by `globalAlpha`.** The library's
  published `canvas_ops` paint the seam as black at 0.18, which is
  multiply-by-tone in ideal arithmetic — but canvas composites premultiplied
  in 8 bits and lands up to **2 per channel** off the reference's own
  `np.rint(v * tone)`. Invisible, and still closed: the game will render
  these tiles too, and a wiki that rounds differently makes every screenshot
  argue with the build. Half-to-**even**, which is not `Math.round` —
  `25 × 0.82 = 20.5` rints to 20 and rounds to 21. The published drawImage
  path stays as the fallback for a tainted canvas, where pixels cannot be
  read back at all.
- **Polarity is decided in exactly one place** (`mixTile`). The library's mask
  bit means side_b; side_b is whichever ground is later in the published
  `side_order` (a total order, wettest→built); the scenes' own convention (bit
  = first-named ground) flips the frame to `15-idx` when the first-named
  ground is side_a. Backwards polarity still renders beautifully — grass and
  rock simply trade places — which is why it gets one owner and a pixel gate.
- **What composition honestly cannot do** (`patterns/index.json reproduces`):
  the boundary *shape*, not the generator's seam shading — no grass blades
  leaning over a road edge. The pregenerated art stays reachable under Raw so
  he can compare and rule.

`check-transcompose.mjs` proves browser compose == the library's reference rule
(0 of 2012 px differ, alpha == silhouette) on four loud pairs, proves polarity
against **independent** truth (NW region of grass/deep_water = grass on
242/242 px; swapped sides read 0/242), and pins the screenshot that started
this: Black Rock lists all 14 neighbours, every strip canvas painted, the
"Being generated" empty state asserted gone.

**The polarity check was circular at first.** It parsed the plates back out of
the `mix:` path under test, so with the sides deliberately swapped it followed
the swap and still matched 242/242. The ground truth is now resolved by rule
(grass under Clean = `tiles/plates/grass/clean.webp`), never from the path —
and both fixtures were proven by breaking `mixTile` on purpose before trusting
the green. Same law as the blind-fixture lesson below: a gate is only as
honest as its independence from the thing it checks.

**Set members resolve to plates two ways.** A review key
(`tiles/<cell>/<key8>`) maps to `tiles/plates/<top>/<key8>.webp` by the tiles
agent's pure string rule, and it is what the member's `tile` field stores (their
`expects`). A ballot member (`<pair>__<variant>`) has no review key — its
`tiles/base_candidates/` file IS plate geometry (alpha verified identical to
the silhouette) and serves as its own plate.

## The pass switch IS the ground's base tile sets

Maintainer 2026-08-25: *"Each ground type have a list of base tile sets. A base
tile set is a list of tiles that look extremely good when used togather ...
should also specify how likley (the weight/chance) tile_1 is to be used VS
tile_2 ... In every base tile set the set can add a weight for how likley the
clean/plain color should be used. Setting this to 0% will always draw with
texture. Setting this to 100% will always draw a clean tile."* And: *"This also
means the After/Texture/Raw instead will be Set #1/Set #2/Set #3/Raw ... And if
no set has been created yet at least draw: Clean #0/Raw."*

The switch is built from the ground in context: `Clean #0`, every set that can
draw, then `Raw`. Stored values are `clean` | `set:<id>` | `before`; `after` and
`texture` migrate to `clean`, so no saved preference resets. Set IDs are the
shared vocabulary, so a page showing many grounds offers "Set #1" and each
ground answers with its own — one that has no set 1 falls back to clean and says
"no such set" rather than silently showing the same picture.

**Clean #0 is COMPOSED, never inherited** (maintainer 2026-08-27: *"if I press
on Brown Paving Stone and click on Clean #0 the tiles doesn't become clean ...
The idea with the big task was to normalize and make all tile types work the
same way"*). The shipped after-art only *looks* clean on grounds whose
postprocess flattened the top; paving and parquet keep their texture, so
showing `cand.art` under Clean showed texture — the old per-material rule
leaking through the new model. Every non-Raw pass now composes: a set member's
top, or the ground's clean plate, onto the tile's own wall. Gated on paving
specifically, because grass passes either way (top reads 1 colour under Clean,
the set's 8 under Set #1).

**A page of MANY grounds offers only Clean #0 / Raw** (maintainer 2026-08-27:
*"Different ground types have different number of base tile sets. So how is it
possible to have a generic change on this page? Some might have 1 some 3 some
8... The only safe option here is Clean #0 ... Raw"*). Offering the union of
everyone's set numbers was my invention and does not generalize. The overview's
cards render exactly what its bar shows — never a per-card reading of a stored
set preference the bar cannot express.

**Textured is gone, and its going is the point.** It was a browser-side *guess*
at what a kept texture might look like, because there was no data for it. A set
member IS that texture, as real art he chose, so the synthesis has nothing left
to do.

**Two levels of choice, deliberately not the same choice.** A SET is picked per
REGION (*"the world-agent will always stick to a single base tile set at one
location"*), a MEMBER per CELL. Picking the set per cell would shuffle three
different grasses into one meadow and undo the point of grouping them.

**Set 0 is reserved**, is named Clean, holds nothing but the clean member, and is
never deleted — it is switched off by weight (*"the weight for using this set is
0"*), which also guarantees every ground has one set that can still draw. IDs
are stable and never renumbered on delete: a deleted set leaves a hole on
purpose, because renumbering would repaint regions nobody touched.

**Weights are raw numbers, shown as percentages.** Percent is how he stated the
model; raw weights are what survives editing, since storing percentages would
rescale every other row each time he adds a tile. **0 is a legal weight and must
stay one** — the old base-tile weight clamped to a 0.1 floor, which quietly made
"never" impossible to express.

Storage is `live/tuning/base_tile_sets.json` (`pixel-wiki-base-tile-sets@1`),
bucket `grounds` — one entry per ground, because a set that holds no tiles
(Clean #0) cannot be represented in a tile-keyed bucket. The pick is FNV-1a/32
over `bts1|set|<ground>|<region>` and `bts1|tile|<set_id>|<x>|<y>`, specified in
`wiki/lib/basesets.mjs` with `TEST_VECTORS` so the game and the tiles agent can
prove a port without reading the source. This replaces `transition_surface` /
`always_own_texture` / `flat_top`: *"It's all normalized and conteolled using the
base tile sets."*

**The pool is `tiles/base_candidates/`, never the x-over-y review tiles.** Those
have deliberately flat tops (`palette.json flat_top`) — they are wall showcases,
and picking a base tile from them asks him to approve a surface he is not being
shown (*"the tile show a clean color top so I can't see the art under"*).

**The preview is the game.** Fields are drawn with the real pick, so Randomize
moves the ORIGIN rather than reseeding a toy RNG: every roll is a real patch of
the world, never one that could not occur.

### Choosing a set repaints the wall under review

*"That page as you know focuses on the walls, but you should be able to see the
walls with different grounds based on what you select ... I pick tiles to be part
of the base tile set if I like how the top looks with the knowlage this will
never define a wall."*

So an x-over-y tile keeps its wall and only its **top face** is replaced
(`topSub`, mirrored in `wiki/lib/topsub.mjs`). Measured on grass over dark_mud:
silhouette byte-identical, 0 holes, 910 of 910 top pixels replaced, 0 of 1,088
wall pixels touched, top colours 2 → 13.

**Align on the WALL FOOT, never the apex.** Over all 5,838 review tiles and 356
ballot tiles, every single tile has at least a pixel of spread between the two
TOP edges — the outline mismatch `_extend_base` was written for — while the
bottom is rigid (identical in 95.8% of columns, voting 9 on 97% of tiles). It
follows from the definition too, since the top face is derived from the bottom
(`bot - WALL_D`, WALL_D = 17). Cost of getting it wrong: bottom-aligned, all 910
top pixels land on real top face; apex-aligned, 50 fall off it. Clamp the
extension into the source's own **top face**, not its silhouette — one row lower
paints the ballot tile's WALL into the new top.

### A fixture that cannot show the defect reports safety

`check-basesets.mjs` **passed with that alignment deliberately broken.** Three of
its four fixtures had apex and wall-foot offsets that AGREE, so the wrong rule
gave the right answer; the fourth's base tile has a top face with **0.0%**
row-to-row change, so a row shift moved nothing.

Only **3 cells** in the whole review set can see a one-row error at all
(`grass__over__grass`, `grass__over__slime`, `ice__over__lava`, each against a
candidate with 48–82% vertical structure). All three are now fixtures, and their
apex/foot offsets and top-face structure are **re-measured every run**, so a
republished tile that flattens one fails loudly instead of quietly blinding the
check. Verified by reintroducing both broken alignments: 704 px and 736 px of
disagreement, where before there were 0.

This is the same lesson as the CORS one below, in a new place: **the harness
differed from the thing under test in exactly the dimension that mattered.**

## A switch for comparing pictures must not move the pictures

Maintainer 2026-08-25: *"I don't like the text to the right side of
After/Textured/Raw … this makes the entire site jump up and down when pressing
the buttons. So it's hard to see how the individual pixels changed due to the
jump. And I don't need this explaining text."*

The three hints were different lengths, so one wrapped to two lines and another
to one: the row changed height on every press and took the art below it with it.
The one thing that control exists for is comparing two pictures pixel by pixel,
and it was moving them. **The hints are gone**; the chips keep their tooltips,
which is where an explanation belongs.

Gated by measurement rather than by eye: across all three passes the switch
holds **31px** and the first tile under it stays **103px** below it.

*"And when I press on Raw the radio button group has no line space until the
next radio button group begins."* — `.ground-pass` zeroes its inner sortbar's
margin to stay tight and had no bottom margin of its own, so nothing separated
it from the set picker. It only showed on **Raw** because the longer hints on
the other passes used to wrap and fake the gap. It has a real 14px margin now,
asserted.

## The pass is called RAW, and the pill says what you are looking at

Maintainer 2026-08-24, twice in a row on the Transitions tab:

*"If I press 'Before' the pill still reads 'postprocessed'."* — It did. The pill
named what the SET HAS rather than what the page is DRAWING. That was useful
back when almost nothing had a processed pass and merely confusing once 283 of
284 sets did. `transPassPill` names the pass on screen: **postprocessed** /
**raw** / **textured**, with **raw only** reserved for a set that genuinely has
no processed pass — which is both what is drawn and the fact worth knowing.

*"I also feel the word 'Before' feels wrong and like to change it to 'Raw' (on
all pages with a similar feature/toggle and not just this one)."* — He is right:
**After** and **Textured** name what the pass *is*, and "Before" only named when
it happened. The chip is **Raw** everywhere now — the section switch, the
per-tile chip (`⇄ raw`), the badges on the A/B cards (`raw`, `no raw`) and every
line of copy that pointed at it. **The stored id stays `before`**, so nobody's
saved preference resets and no live document changes meaning.

And the strips had the same bug the scenes had: `wangScene` learned to follow the
switch but the two plain strips — the rows on the Transitions tab and the 16
corner tiles on the demo page — still passed the set's `post` FLAG where the
pass belonged, so Raw looked identical to After. One `transArt` helper now
answers that question for every surface.

## Three passes, and the third one does not exist on disk

Maintainer 2026-08-21, after the clean-colour switch still did not answer his
question: *"We have 3 states here: A: Original tile data (before
postprocessing) ... B: How the tile looks in the game today ... C: We don't
show this but I want it. A hypothetical image to see how this tile/top WOULD
have looked like if we didn't enforce a clean color on it. I'm not talking
about before postprocessing, I'm talking about an alternative postprocessing
where the top texture is maintained, but still colored in the correct tile
palette."*

**A** and **B** are files the tiles agent publishes (`*_before.webp`,
`*_after.webp`). **C is not a file anywhere in the pipeline**, so the wiki
synthesizes it per tile, in the browser (`texSynth` / `texFor`):

1. Start from **After** — the shipped tile, palette-corrected wall, clean top.
2. Find what the flattening painted: every colour covering **≥15%** of the
   opaque pixels. A transition tile carries two grounds, so up to three regions
   qualify; a tile the postprocess never flattened (parquet, the pavings —
   `flat_top: false`) has none, and the synthesis correctly leaves it alone.
3. On exactly those pixels, take the **raw** pixel and shift it per channel so
   the region's **mean lands on the clean colour**.

### And then it shipped silently falling back to the flat tile

Maintainer 2026-08-22: *"Textured doesn't work and also displays the clean
single color version right now."*

The maths was fine. The **fetch** was not. Tile review art is not in the deploy
image — `/assets/tiles/review/…` is **404** in production — so it loads from the
staging CDN, a **different origin**. An `<img>` fetched without `crossOrigin`
taints any canvas it is drawn into, `getImageData` throws `SecurityError`,
`texSynth` returns null, and the caller falls back to the plain After image:
the clean single colour, exactly what he saw. `crossOrigin = "anonymous"` now,
and raw.githubusercontent answers `access-control-allow-origin: *`.

**No gate could have caught it, because every gate ran same-origin.** The local
server roots `/assets` at the repo, so tile art is same-origin in every test
and tainting simply never happens — the one difference between the harness and
production was the only one that mattered. There is now a check that
deliberately loads both passes from the *second* origin and reads the pixels
back (27 colours), plus one that drives the page's own loader and asserts it
asks for CORS on every image it reads.

### The detail picture is 5×5 — nine of the tile inside a ring of ground

Maintainer 2026-08-23: *"On the details page I want to review the tile as 5x5
with the tile I'm reviewing as the center 3x3 surrounded by the base tile … The
idea with a base tile is a tile that looks better than a single color tile, so
if no base tile exist that mean the base tile is used 100% as the base tile."*

One tile in a 3×3 answered "how does this meet the ground". **Nine** of it
answers the question a repeated ground detail actually raises: what happens
when several land near each other. So `detailField` draws 5×5 with the middle
3×3 the tile under review and the outer ring the ground.

**And the ring is the ground as it is today.** `detailSurround` returns
`{ members, clean }`: the promoted base group when one exists, and otherwise
the **clean-colour tile** — because with nothing promoted, that flat tile *is*
what the game paints. Falling back to a textured neighbour would show him a
ground that does not exist yet, and let it flatter the tile under review.

The same picture now backs the per-tile Textured preview on a pair card, so the
two places a top can be judged agree with each other. The intro says which ring
it is drawing, so the picture is never ambiguous.

Gated on geometry rather than a screenshot: an N×N iso field spans
`(2N−2)·dx + tilePx + 8`, so 5×5 is 328px where 3×3 would be 200.

### Every composed scene asks for CORS

The ring exposed a second face of the tainting bug: `loadImages` fetched plainly,
so the moment a scene included staging-origin art the whole canvas became
unreadable — display fine, but no check could ever look at the picture. It
requests CORS now and retries plainly if an origin refuses, because a tainted
tile still beats a missing one on a page whose job is showing tiles.

### Details draws Textured, whatever the switch says

*"When I press Details I expect the tile in the center to be the textured
version … a textured version that has gone through the postprocessing in a way
that still align/change it's colors, but doesn't force the top to be
clean/single color."*

That is the Textured pass — but the tab opened on After, where the flattening
leaves 96% of a top one colour: the tab hid the only thing it exists to judge.
Its compositions now ask for texture when the stored pass is After, and the
intro says so. **Scoped to the tab, never written to his preference** — flipping
the stored pass on arrival would silently change every other page in the
section (measured: it broke 15 unrelated gate checks in one run).

### The first cut shipped flat, and the metric said it was fine

Maintainer, the same day: *"How can you call this top 'textured'? Yes I can
clearly see the original tile had a lot of texture, but if you remove it all
it's not 'textured'."* He was right.

Step 3 was a plain additive shift with a clamp. Moving a **bright** top onto a
**dark** palette colour (grass: raw mean `[107,162,74]` → target `#14523b` =
`[20,82,59]`, a shift of `[-87,-80,-15]`) pushed **29% of that tile's top
pixels through the 0 floor**, and a clamped pixel is a flat pixel: red's spread
collapsed from 27 to 18.8 and the eye read the surface as blank.

**The metric never caught it because the metric was worthless.** "Distinct
colours in the region" scored his tile **12 before the fix and 12 after** —
identical number, completely different picture. Colour count cannot see
crushing; only the *spread* can.

So step 3 fits the swing to the room the palette colour actually has:

```
dev  = raw − mean(raw over the region)
p98  = 98th percentile of |dev|          ← ignore outliers, not the surface
head = min(target, 255 − target)         ← the colour's own headroom
k    = p98 > head ? head / p98 : 1
out  = target + dev × k
```

A colour with room (grass green, target 82) keeps **100%** of its swing; a
near-black one (target 20) compresses rather than crushes. Measured across six
real tile pairs: the dominant channel keeps **≥94%** of its spread, and
**0.34%** of channel samples touch an end — the deliberate 2% outlier tail,
against 29% before.

I also checked whether the pipeline had a transform worth copying — least
squares on raw→after over each tile's *wall*, which the postprocess recolours
without flattening. The gains scatter from **0.01 to 1.12** across tiles, so
there is no consistent behaviour to borrow, and headroom-fitting stands on its
own.

**The lesson, recorded because it cost him a round:** a number that goes up is
not evidence the picture is right. The gate now measures surviving standard
deviation and crushing, `texSynth` is exposed on `window.__wiki` so it can be
rendered at 6× beside the raw and the shipped tile, and *looking at it* is part
of the check.

Virtual paths carry it: `tex:<after>::<raw>` resolves through `loadImages` and
`viewArtIn` to a synthesized canvas, so every existing composition — the 3×3
fields, the promote modal, the Wang transition scenes — gets the pass for free.
`isoScene` draws canvases and `<img>`s alike; `artNodeFor` covers the few
places that show a tile outside a composition. Cached per art pair; if the raw
art is missing or the canvas is tainted, it falls back to plain After, which is
always true and never wrong.

## The view IS the review — one rating row per card

Same message: *"The current button and everything that expands when clicking on
the 'review the top' should be removed (it's so confusing with two rating
systems on the same card!). So what we will do instead is that IF the top is
viewed the current rating system ... should target the top/details instead ...
But instead of stars lets use something like a roof emoji ... And to make it
even more clear you only review the top/ground right now it should be the
center of 3x3 tiles (base tiles)."*

`topReviewBlock` is deleted. A tile card now has **one** review row, and what
it rates follows what the picture shows:

| view | picture | the row rates |
| --- | --- | --- |
| After / Before | 3×3 field + cliff corner | the **tile** — ★ stars, "✕ redo" |
| Textured | the top centred in a 3×3 of the ground's base tiles | the **top** — ⌂ roofs, "✕ not a detail", written to `<key>#top` |

The per-tile chip cycles all three (`after → texture → before`) and hands
`tileScenes` an `onView` callback so the row swaps with the picture — the
rating can never target something other than what is on screen. The flip stays
**per tile**: the other cards keep their stars and their cliffs, which is what
makes it a comparison. `starsWidget` takes a `glyph`, so ⌂ inherits the stars'
sizing and colours instead of fighting them.

## The ledger — "is there anything left for me?"

Maintainer 2026-08-22, refusing to continue: *"The wiki is full with already
reviewed stuff. I will not review until everything is up to date."*

He was right about what he saw and wrong about what it meant, and only because
nothing here ever told him. Every page was full of reviewed tiles because he
had **reviewed them all**: 3,983 of 3,990 rated, all 66 of his rejections
already carried out by the tiles agent (the tiles are gone from the manifest),
7 tiles left in one set. A queue you cannot see the end of looks exactly like a
queue nobody is working.

So `#/world` opens with `reviewLedgerPanel()`, counted live off the manifest and
his own verdicts every time the page opens — never a cached number, never a
claim:

- **Tiles** — rated vs total, floored (never `100%` over unfinished work), plus
  a press per set that turns the "no stars" filter on and lands him on exactly
  what is left.
- **Your rejections** — how many the agent has **carried out** (his verdict
  names a tile that no longer exists; that orphan row is the receipt) against
  any **still standing** (rejected, but the tile is still in the manifest). This
  is the "is anyone acting on me" number.
- **Tops** — the second axis, judged vs total over EVERY top the Details tabs
  list (the x-over-y candidates AND the top-only sheets, one rule: `typeTops`
  / `detailQueue`), with the count still waiting as its pill and a press that
  opens the biggest queue in **Textured**. (Until 2026-09-12 it counted the
  x-over-y tops alone and read "all judged" over 9,008 waiting sheets.)

Note for whoever runs `prune-feedback.mjs` next: the orphan rejected rows *are*
the receipt the ledger reads. Pruning them is not wrong, but it zeroes "carried
out" — say so when you do it.

## The clean-colour top, and the switch that has to be everywhere

Maintainer 2026-08-21, after hunting for it: *"I have browsed around on the
entire wiki and can still not find a way to render tiles without the 'clean
color top'. This makes it impossible to promote anything at all becouse
promoted tiles will show the real top."*

**Measured, so the size of it is on record.** The pair postprocess snaps a top
to the ground's colour: on grass, black rock and light soil the top face comes
out **96.2% a single colour**, against 28–69% in the generator's own art.
Parquet and the pavings (`flat_top: false`) keep their texture, before and
after alike.

That makes the clean-colour pass **useless for the judgement it was blocking**.
A base-tile group exists to make seams disappear; a field of flat-colour tops
has no seams to find, so every group looks perfect and the review says nothing.
The raw pass is where the repeat is visible — and it is what a promoted tile
will actually ship as.

The switch existed. It was in two places out of five: On top of and Details —
**not** on Base tiles, where a group is judged, and **not** in the promote
modal, where the promotion is decided. So it now lives **above the tabs**, on
screen whatever tab is open, and **inside the modal**, repainting its previews
in place; flipping in the dialog leaves the page set the same way when it
closes. Both chips say what they mean rather than just naming a pass — After is
"the postprocess snaps the top to the ground's clean colour", Before is "THE
REAL TOP … a field of clean-colour tops hides seams no matter what".

Gate: the pass switch on all four tabs and in the modal; flipping on Base tiles
re-composes the group's 5×5 from the raw tops; flipping inside the modal
re-composes without closing it and the page behind adopts the setting. The
default-is-After check is asserted BEFORE the tab tour, because the pair cards
deliberately carry both passes at once (CSS decides which is visible, so the
A/B flip cannot blink) and would otherwise count as fetches no composition
asked for.

## The ground type is a page — base tiles, base colour, palette, transitions

Maintainer 2026-08-21, setting the World section's information architecture:
*"World has Ground types. A Ground type has: Base tiles (can be 1, several or a
single color), On top of, Transitions ... I should be able to promote a tile to
be the base tile and also revoke that title. The page should show the ground
types base color (often the bg on the base tile or alone if no base tile
exist). The page should also show the ground tiles color palette."*

The page has that shape, and **everything on it is read, never invented**. It
is TABS (*"we have so much stuff here so it should be tabs"*), in order: **Base
tiles / On top of / Transitions / Details** — Base tiles first, and DISABLED
when the type has none, landing the visitor on On top of.

- **The identity card** mirrors the tiles agent's `config/palette.json`: base
  colour (`top`, the maintainer's own ladder pick), category (solid/liquid),
  and the **surface taxonomy** in words — `own` ("always its own texture"),
  `base` ("repeats the base tile": paving, parquet, where transitions must
  mimic the pattern), `flat` ("clean colour for now", shown as a warning — he
  declared it a stopgap, not a goal).
- **The palette is MEASURED, not declared**: build.mjs decodes the type's
  own-wall tiles (`t over t`) with the same VP8L decoder that measures art
  bounds, counts exact colours and ships the top 10 by share. The dominant
  colour matches palette.json's declared `top` on 13 of 14 types; parquet_floor
  NOT matching is the page honestly showing review tiles that predate the
  palette re-snap.
- **Base tiles are a LIVE DESIGNATION** — `tuning/base_tiles`
  (pixel-wiki-base-tiles@1), one entry per manifest tile key carrying the type
  it is the base OF. Promote from any tile card ("☖ make base tile"), revoke
  from the card or the panel, the save bar commits it like every verdict. The
  page's base colour follows the promoted tile's measured flat top
  (`palette_top`), falling back to the game palette when none is promoted —
  *"often the bg on the base tile or alone if no base tile exist"*, verbatim. A
  designation whose tile is later regenerated away shows as orphaned rather
  than silently vanishing.
- **Base tiles come in GROUPS** — *"a set of tiles that togather make
  tileing/seems dissapears"*. A group is reviewed AS A WHOLE first (a 5×5
  weighted-random field with a Randomize button: *"here we can see how they
  look togather"*), then member by member — the double preview (the tile alone,
  and centred in a 3×3 of its group-mates), a spawn **weight** input, Remove
  from group. Promotion is a MODAL from any tile card composing the candidate
  in the centre of EVERY existing group, plus a start-a-new-group option: you
  promote it into the group where you cannot find it.
- **On top of** is his name for the x-over-y matrix — the existing pair grid
  with its filters, as the second tab.
- **Details** — *"the most fun section ... There are a LOT of tiles that look
  AMAZING if you not show them to often!"* A ground detail is a top judged on
  its OWN axis: the wall never shows, so the picture is the game's — the tile
  centred in a 3×3 of the ground's base group, composed as the game ships it.
  **After is the default, and the switch flips EVERY tile in the composition,
  centre and neighbours alike** (2026-08-21) — a raw centre on postprocessed
  neighbours is two passes pretending to be one field, the lie the switch
  exists to prevent. One rule (`viewArt`) feeds every tile on the page, and a
  tile with no raw generation keeps its shipped art rather than a hole. The
  verdict rides the tile's own key with a `#top` suffix in the tiles feedback
  doc — the same convention as a monster's per-facet verdicts — so it is
  INDEPENDENT of the pair review: a tile rejected for its wall can still be a
  top-approved detail ("every nice tile that didn't make it into the other
  categories can still have a chance"), and the gate asserts a top approval
  never leaks into the pair filters. **For the admin the tab opens on the
  queue** — **"Tops waiting for your verdict"**, twelve composed cards at a
  time — and the approved collection follows; the tab's chip is that queue's
  count in the to-do colour (✓ once it is 0), and the World overview's ground
  cards carry the same number, all three off one rule (`detailQueue`).
  (Maintainer 2026-09-11, on black_rock: *"I have tried to review the entire
  black_rock details. But I don't know if I have already or not becouse the
  wiki has no way for me to filter so I only see tiles I have not reviewed
  yet"* — the chip counted the 275 tops he had APPROVED and the 0 he needed
  sat under them, a 275-card scroll away on a phone.) Every pair-page tile
  card carries a collapsed
  **"☘ review the top"** toggle with its own stars and a "not a detail"
  verdict, wearing the top's state on the button; detail cards carry **promote
  to base tile**, the same modal as a tile card. Ground details are not in the
  game yet — this is the pick list the tiles agent's detailed-variant pass and
  the world agent will consume.
- **Transitions** mirror `tiles/transitions/` on disk, and each pair has its
  own DEMO PAGE (`#/world/transition/<a>__to__<b>`) composing the same Wang
  corner set across every direction a boundary can run — west|east,
  north|south, the diagonal (with its honest 32px stair named as geometry), an
  island, and a wandering random edge with a Randomize button — plus a set
  picker (straight/rough × seed) and the 16 corner tiles laid out with their
  index convention. `wangScene` composes through the SAME `isoScene` at DY=14
  the review previews use, so the page is the game's own projection. Every
  listing carries a **before postprocess / postprocessed** pill: the build
  probes `<set>/post/tile_XX.webp`, so the wiki prefers the retexture pass the
  moment the tiles agent publishes it, with no wiki change (the board asks them
  for exactly that path). `isoScene` also draws non-square tiles at native
  aspect — a transition tile is 64×46, and stretching it to 64×64 bent every
  boundary it exists to show.

Trap: `tuning/scenery_lights` was served by `/api/live/state` but never READ
into state, so his committed lit-corrections vanished from the wiki on every
reload while the file was fine (the lazy accessor that papered over it stays as
the fallback).

Gate: `wiki/tools/check-groundtype.mjs` re-derives the identity card from
palette.json, the palette from the decoder, and the transitions from a
readdir — then drives the whole promote/revoke round trip (title on the card,
panel entry, base colour, the tuning/base_tiles save carrying `{type}`, the
revoke deleting rather than tombstoning), checks the taxonomy reads
differently on parquet (base) and black rock (flat), and that a player gets
the palette and the transitions with none of the machinery.

## The tile filter — no stars, rejected, approved, undecided

Maintainer 2026-08-20: *"I need to be able to filter on tiles that doesn't have
any stars … Hmm that ofc makes NO-STAR a filter and not a sorting. Make it a
filter."*

**A star is the mark of having looked**, not a quality signal: he rated the
whole matrix once, the agent regenerated what he rejected, and the replacements
arrive with no rating — so "no star" is precisely "new since my last pass", and
this is his inbox. A filter *removes* the settled tiles; a sort would still make
him scroll past them and ‹ › would still walk into them.

**It cascades through all three levels**, because the levels are one question
asked at three grains:

| level | what the filter keeps |
| --- | --- |
| `#/world` | ground types holding at least one unstarred tile |
| `#/world/<top>` | that type's sets holding at least one |
| `#/world/<top>/<side>` | only the unstarred tiles themselves |

**‹ › walks the whole inbox, across ground types**, which makes it a work queue
rather than a per-type chore: `filterRoute(mode)` lists every set still holding
a matching tile, in section order, addressed as `<top>/<side>` (already the pair
url, so no routing changes), and the count reads `3 / 27` against the JOB, not
the type.

**Which means every headline has to name itself** (*"the tile group headline
has to be improved to mention 'x over y', not only X as we have today"*): under
the filter the type page's cards read `Black Rock over black rock` in full, not
the `over black rock` shorthand that only works inside one type; the set page's
crumb points at **World**; the pager's ›-title names the set it lands on and how
many tiles wait there.

**The verdict filters are the same machine** (*"Can you also add a filter for
rejected/approved/undecided? … Should work like the old filter."*): everything
above is written against a MODE, `TILE_MATCH` holds **one predicate per mode**,
and the control is **one pick-one row** of five rather than two bars that could
contradict each other.

| mode | keeps a tile when |
| --- | --- |
| `all` | always |
| `no stars` | it has no rating |
| `rejected` | its verdict is rejected |
| `approved` | its verdict is approved |
| `undecided` | it has no verdict, whatever its stars |

**`undecided` is not `no stars`**, and the distinction is the point of the
second pass: he starred tiles in the first pass *without* judging them.
Measured on the gate's fixture — every tile starred, most unjudged — `no stars`
keeps 0 ground types and `undecided` keeps 15.

The pair-level review filter (`all / not reviewed / partly / picked / redo`) is
untouched and still sits below: it asks about the SET, this asks about the
TILE, and the tile filter runs first.

**A mark removes its tile on the spot.** `starsWidget`'s `onStars` hook is
deliberately separate from the verdict's `onchange` and **only wired while a
filter is on** — repainting 35 canvas previews on every star press is a stutter
for no gain when nothing is being hidden. Under a verdict mode the mark that
empties a set is the *verdict*, so both hooks run the same handler. When the
last tile of a set is marked the page re-routes, keeping scroll: "finished" is a
fact the header carries (the `all starred` / `none rejected` pill, the "press ›
for the next one" line) and a cards-only repaint cannot reach it.

Gate: `wiki/tools/check-stars.mjs` builds his actual situation — star every
tile in the section, then un-star a handful across two ground types — and holds
the contract: that it is a FILTER (a settled type is *gone*, not sorted to the
bottom), that it cascades to all three levels, that ‹ › crosses into a
different ground type and every headline it lands on says "x over y", that a
star removes its tile without moving him, that finishing a set says so, that
the choice survives navigation, and that a player never sees the control.
