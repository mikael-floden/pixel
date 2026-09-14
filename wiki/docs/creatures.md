# Creatures, heroes and their viewers

The shadow editor, the animation viewer, the showcase, usage stats and the review idioms of the creature pages. Moved verbatim out of `wiki/README.md` (2026-09-09), which keeps the rules and points here; rewrite in place under the root doc law.

## The 8-direction base is a state called "static"

Every creature's row opens with **static** — the eight rotations the animations
were made from — and **idle is still what opens** (maintainer 2026-09-11: *"I
should in the animation preview be able to select 'static' as a
state/animation type. Yes I know the original 8 direction static images is not
really an animation, but it's good for me to have a way to see them. I want
them to the left of 'idle', but I still want idle to be pre-selected."*)

- A rotation IS a one-frame clip, so it needs no special case in the viewer:
  `staticState()` publishes `monsters/<id>/rotations/<dir>` (or a candidate's
  `candidates/<id>/rotations/<dir>`) as `animations.static`, first in the
  object, carrying `still: true`. The viewer's own rule — idle if idle exists —
  keeps idle selected.
- **It is looked at, not judged.** The facet row is replaced by one line: no
  agent consumes a verdict on the base, and a rating nobody reads is worse than
  none. A bad base means the design goes, which is the verdict beside the
  creature's name; for a design still being animated the line points at its
  candidate page, where the 8 directions are the whole review.

## Parallel takes of one state — live, try, v3

The monsters agent builds a replacement beside the live animation instead of
over it, so a state can have several takes at once: `attack`, `attack_try`,
`attack_v3try`. He reviews them all (maintainer 2026-09-11: *"he might try to
create a different attack animation without deleting the old version in case
the old version in the end was better. He is now at 'v3' and I can only see a
single attack animation on the wiki so I can't see his new attempts. So we need
a way to ... see all different parallel versions (and review/rate all parallel
versions). In the end we will only have a single attack animation ofc."*)

- **A take is published as its own entry** carrying `takeOf` (the state it
  belongs to) and `takeLabel` (`v1`, `v2`, `try` — parsed from the slot name, so
  `attack_v3try` and `attack_v3` both read v3). Any folder matching `<state>_*`
  is a take of that state; anything else on disk is not a state at all.
- **A state can exist as VERSIONS ONLY.** The agent renamed its slots to
  `attack_v1, attack_v2, attack_v3` and stopped writing a bare `attack` folder,
  which dropped the state from the registry the hour the rename landed — both
  the build and the viewer were keyed on the bare folder. A state is present
  when its own folder OR any take of it is on disk; the bare folder, when there
  is one, is the take that ships and leads the row as "live". The viewer's
  state list is therefore derived from what each entry BELONGS to, never from
  the entries that belong to nothing.
- **The versions are sorted, live first, numbers in number order** — the agent
  is renaming them `v1, v2, v3`, so the row collates numerically and v10
  follows v9 rather than v1 (maintainer 2026-09-11).
- **One chip per STATE, versions on their own row.** The viewer's `takeRow`
  appears only while the state on screen has more than one take, and reads
  `live | try | v3`. A take is never a second state chip — it is the same
  state.
- **`cur.state` is the SLOT being shown**, so every verdict, art stamp, chip
  mark and clip lookup keeps working on a plain `animations` key and a verdict
  on v3 can never land on the live take: its feedback id is
  `<path>#attack_v3try#<dir>`. The judging pill says "Attack v3", never the raw
  slot.
- **The version he is reviewing follows him**, creature to creature and state
  to state (maintainer 2026-09-11: "When I stand on a monster and review the
  attack animation version today named 'try' I want to be able to click 'next
  next next' to see the next monsters attack 'try' animation. I don't want the
  wiki to switch back to the 'live' version."). Remembered as the LABEL
  (`wiki-viewer-take-<kind>`), never the slot: the slot is per state
  (`attack_v2`) while the question is per version — show me everyone's v2. A
  creature or state without that version opens on its live take and does NOT
  forget his choice, so stepping through Idle on the way back to Attack still
  lands on v2.
- The state chip carries the LIVE take's marks (that is the one that ships);
  each version chip carries its own.
- The Animations panel counts STATES and says "N parallel takes" beside it.
- In the end only one survives: the agent promotes a take into the state and
  deletes the rest, and the version row disappears on its own.

## One animation is REDONE, never removed

The per-animation row — one state in one direction, the unit the agent
regenerates — is **approve + redo**. There is no remove on it, and the reason
is a rule about the game, not about the row (maintainer 2026-09-10): *"we never
want a monster to 'not have an attack'. Redo is the only option. If we can't
generate the attack we need to remove the entire monster."* A creature ships
with all five states in all eight directions or it does not ship. So a bad clip
has exactly two ends: another take, or the whole creature goes. Removal is
therefore a verdict about the WHOLE creature and lives on the row beside its
name, which still carries it — and the redo button says so, for the day a state
simply cannot be generated.

- `redo` on `<path>#<state>#<dir>` in `live/feedback/<domain>.json`, stamped
  with that clip's own art hash, is the producing agent's cue to regenerate
  exactly that clip and nothing else. A creature can never be left with a state
  missing: an agent that cannot produce one asks for the creature to be
  removed rather than shipping it incomplete.
- A row whose verdict ALREADY says `rejected` still shows its remove button, so
  an old removal can be cleared rather than stranded on a row that can no
  longer set one.
- The chip carries it: a state or direction with a redo wears `judged-redo`
  (the accent ink every warn pill uses), and a redo OUTRANKS an approval on the
  same chip — it is the one still owed. Green means settled, red means gone.
- The SCENERY state row is the one review that keeps both (maintainer
  2026-09-03) — there, remove deletes a state the piece can do without.

## "Removed" must be TRUE — one 404 proves nothing

Maintainer 2026-09-11: *"When I first open the wiki or press on a page I get an
error saying 'removed'. I then click back and on the same page again and the
same img/monster loads."* Three routine things answer 404 for art that is on
main this second, and each of them showed him a deletion that had not happened:

- **the deployed image**, which carries only what the game reaches — a creature
  still being animated is staging by arrangement (`games2/scripts/shipset.mjs`);
- **the boot pin**, a sha cached for ten minutes while the art agents push every
  few;
- **a CDN that has not fetched the path yet.**

So a `gone` verdict has to survive being asked again at `main`, the newest ref
there is (`probeGone`). If main has the file it is not gone: the element is
repointed there and it loads — which is exactly what his second visit did by
hand. One extra HEAD, only on the miss path. A path neither side has is still
`gone`, and the piece still leaves the wiki.

STAGING IS ADMIN-ONLY, for the same reason. A player has no repo to fall back
to, so a creature the image does not carry would be a permanently broken card
for them: `creatures()` hides `pending` ones from the player face (and the
Candidates tab with them), which is what the shipset law already said — "stays
visible to a signed-in admin in the wiki". The nav count follows the same
accessor, and `setAdmin` drops the creature index so signing in or out changes
the roster immediately.

Gate: `wiki/tools/check-gone.mjs` drives it across TWO origins — the image 404s
the strip, the repo has it — and fails if the page says "removed" about art main
still has. It runs in `wiki-guard.yml`, which now starts `serve-repo.mjs` too.

## A deleted piece LEAVES the wiki — it does not become a tombstone

**The admin reads ART from HEAD of main and the PIECE LIST from the deployed
build.** That split is deliberate — `stagingSha()` pins staging reads to `main`
because reviewing art that is not in the game yet is the entire point — and its
consequence is that `data.json` can list a piece whose file the producing agent
has since deleted. **The REJECTED filter hits it every time**, because a
rejection IS the instruction to delete the piece. Nothing is broken when this
happens; the contract is working.

A "removed" tombstone card was tried and rejected (maintainer, 2026-08-16):
*"Why is the object not removed then removed? Why do I still see it but as
removed?"* A card he cannot open, judge or look at is not information, it is an
obstacle between him and the pieces he CAN review. So a 404'd piece is **dropped
from the loaded manifest** (`dropGoneEntity`), and every count, chip, filter and
‹ › pager follows for free, because they all read `state.data.domains.*`.

- **Keyed on the piece's own `preview`.** A missing animation FRAME means one
  state is gone, not the piece — that keeps its card and shows the note in the
  viewer.
- **A failure that is not a 404 keeps its card**, marked "not loading". The
  failure path spends one `HEAD` to tell the two apart: claiming a piece was
  removed because a CDN blinked would silently take real work out of his queue.
- **It never re-routes the page he is reading.** Dropping the piece whose own
  detail page is open would replace it with "unknown piece"; the lists correct
  themselves on the next navigation.
- **One re-render for the whole batch** (`scheduleGoneRerender`, 200ms). A
  stale build can carry a dozen deleted pieces whose images all 404 together —
  measured 14 in one filtered view — and re-routing per drop would rebuild
  hundreds of cards a dozen times over on his phone. Scroll is preserved
  through `keepScrollY`.
- **The session remembers** (`goneArt` in sessionStorage, applied by
  `pruneKnownGone` right after the manifest loads), so a page turn or a Back
  cannot resurrect a piece that is not there.
- **Discovery is progressive**, because images are lazy: a piece is only known
  gone once its card has been rendered. The counts therefore settle as he
  browses, and everything self-heals at the next deploy, when the piece leaves
  `data.json` entirely.

Gates: `wiki/tools/check-gone.mjs` (a 404 and a connection failure routed at
the network boundary — the piece leaves, the count follows it out, the other
one keeps its card, and nothing resurrects on a re-navigation) and
`check-queue.mjs`, which had to learn the same lesson: it now models the pieces
**on disk** rather than the ones the build listed, and forces the grid's lazy
images to load before judging it. A gate that models the manifest is asserting
a page that cannot exist.

## "Lit" is a CLAIM about the art, and he can correct it

Maintainer 2026-08-17: *"Some scenery is supposed to be 'lit up' (like a lamp,
campfire, glowing rune, etc). However! The AI that generates the image might
fail to produce the light, but the scenery overall looks great. So I want a way
to change the state from 'lit' to 'unlit' when doing the review. So we don't
have to throw away the art just because it's lit state is wrong."*

A scenery state is named `LIT_2` / `NOT_LIT_1` (or `LIGHTS_ON`/`LIGHTS_OFF` on a
window) by the pipeline that ordered it — the name says what was ASKED FOR, not
what came back. So the Scenery review carries a **Light** switch on the state
you are looking at, above its verdict row, and what it writes is a
**correction**, never a judgement.

- **It is a PROPERTY, not a verdict** — so it saves to
  `live/tuning/scenery_lights.json` (`pixel-wiki-scenery-lights@1`), not to
  `feedback/objects.json`. Rejecting a dark `LIT_2` would throw away the art he
  explicitly asked to keep; the piece is fine, its label is wrong.
- **Per STATE**, keyed `<piece path>#<state>` — the same unit the facet verdicts
  use. Not per piece (the scenery domain's own rule is "read the state key, not
  the piece": `lights` is legacy and null on anything carrying both kinds) and
  not per direction (the light is a property of the sprite; scenery is
  south-only anyway).
- **Absent means the name was right.** Setting it back to what the state is
  called deletes the entry — a file of agreements would grow to every state he
  ever opened and describe none of them.
- **The correction stays legible**: once the two disagree the strip carries a
  "generated as 💡 lit" chip, and the saved entry keeps `was: <state>` so the
  scenery agent can still tell what it was generated as after re-filing it.
- **It is the page's ordinary control size.** The first cut reused the tiles
  card's `.wall-mode` class, which exists to SHRINK a strip into a dense card,
  and shipped the smallest control on a page full of normal ones (maintainer
  2026-08-18). It also passed a bare `null` to `replaceChildren`, which
  stringifies a non-node — so every uncorrected state read "Light unlit 💡lit
  null". The gate now reads the row's own TEXT NODES and compares its buttons
  against the other pick-one controls on the same page; either defect fails it.

Gate: `wiki/tools/check-litstate.mjs` — drives the real page, corrects a state,
commits, and asserts the file, the key, the `was`, that nothing lands in the
feedback file, that agreeing again DELETES, that the switch follows the state
chip (unlit → 💡lit) and that a reader never sees the control at all.
## A new monster is judged on its 8 DIRECTIONS before it earns animations

A candidate is an 8-direction base and nothing else. The monsters agent
designs and generates its own monsters now, and "the first step before
generating a monster is generating a character in 8 directions. If you are
happy with this character you can go on and generate all animations needed"
(maintainer 2026-09-09) — and a bad facing cannot be fixed later, so the
verdict comes BEFORE the five states are spent on it.

- **Contract in:** `monsters/candidates/index.json` (`monster-candidates@1`).
  `build.mjs` publishes it as `domains.monsterCandidates` (+ `counts
  .monster_candidates`): id, name, tier, lore, biome, items, size, `version`,
  `generatedAt`, the 8 `rotations` paths, the agent's `qa` and its `review`.
- **Contract out:** `live/feedback/monsters.json` under
  `monsters/candidates/<id>` — `approved` = generate every animation in all 8
  directions; `redo` = same design, next seed; `rejected` = drop the design.
  Rating and note ride as on every other feedback entry.
- **Every verdict is stamped with the candidate's `version`.** A redo rolls
  the next seed and the agent deletes the old record, so a verdict carrying an
  older version is about a picture that no longer exists: the page shows
  "regenerated — judge again", the queue counts it as unjudged, and the agent
  must ignore it. (Same rule the scenery states use with their art hash.)
- **Pages:** `#/monsters/candidates` — chips `to judge | approved | redo |
  removed | all` with counts, "to judge" by default, newest first; the cards
  are the CREATURE SHOWCASE (below), same grid, same measured spans, same
  marks-on-the-art. `#/monsters/candidates/
  <id>` — the 8 facings in MIRROR-PAIR order (S, N, E, W, SE, SW, NE, NW), so
  the twin the generator gets wrong (a SE drawn as SW) is the next picture
  down, or beside it when two fit. The verdict row sits UNDER the pictures,
  where his thumb is after reading them. ‹ › walks the current chip's list.
- **TRUE SIZE ALWAYS — the BOX gets bigger, never the creature** (maintainer
  2026-09-10, on a grub scaled 11× to fill the screen: "11x zoom? WTF. I want
  to see it in the true size always! You just had todo the preview bigger and
  centered the monster!"). One zoom for every candidate, from the same ladder
  the overview uses — the largest of `2 · 1.5 · 1 · 0.75 · 0.5` at which the
  LARGEST canvas in the whole set fits the measured column (1.5× on a 393px
  phone) — and an IDENTICAL box on every design, its side that largest canvas
  at that zoom. A 32px grub is then 48px of art centred in the 360px box a
  240px warden fills edge to edge. Both per-design zooms are rejected and both
  were shipped and rejected by him: a fixed 1×/2×/3× ladder made the grub a
  64px stamp, and fitting each design to the column made it an 11× monster
  bigger on screen than the warden. The chips are the CREATURE PAGE'S OWN — `same`
  (default) `1×` `2×` `4×`, where "same" means there what it means here, every
  design at one scale so sizes compare between pages (maintainer 2026-09-10:
  "See how monsters is displayed on their details page. I think we have 1x 2x
  or 4x"). The chip is remembered (`wiki-cand-zoom`), and the steps are an
  ARRAY: integer-like object keys sort to the front and put "same" last. Magnifying grows the CREATURE, not the box: the box stops at the
  column and a magnified big design scrolls inside it, the preview-stage rule.
- **The label sits UNDER its facing.** Floating it on the art covered a small
  design completely, and the art is the thing being judged.
- **ONE ZOOM FOR THE WHOLE GRID, and the card is what varies** (maintainer
  2026-09-10: "It's important when I scroll the candidates overview I can see
  the monster in the correct scale. So I was thinking the cards could be the
  same as in the monster overview. In the monster overview we get bigger cards
  for bigger monsters."). The designs run 32px to 240px of native art — nearly
  twice the shipped roster's range — and the biggest at the game's own 2× is
  456px against a 386px double stage, so the grid picks the largest zoom on the
  ladder `2 · 1.5 · 1 · 0.75 · 0.5` at which the BIGGEST card still fits a 2×2
  (1.5× on a 393px phone: 56 designs take one cell, 33 the full four). Every
  card shares that zoom, so ratios between cards are ratios between designs; the
  cap is the game's 2×, and the page says which zoom it landed on. NOT
  per-card fitting — that is what he was looking at when he wrote the note:
  every thumbnail 150px, every creature the same size, the scale unreadable.
- **The agent's own `review` is a pill only where it DIFFERS from his verdict.**
  It mirrors his verdicts within the run, so an unconditional pill put "agent:
  approved" under his own "approved" on every judged card, and its idle values
  (`pending`, `not_picked`) say nothing at all. What earns a pill is the gap:
  an approval it has not acted on yet reads "waiting for the agent".
- **CREATURES AND CANDIDATES ARE TWO TABS OF ONE SECTION**, and nothing on
  screen moves between them (maintainer 2026-09-10: "I also feel the
  Creatures/Candidates should be a tab and not a warning div. Also when
  clicking on Candidates now the breadcrumb 'jumps' compared to the Creatures
  page"). Both pages open `sectionHead(...)` then `creatureTabs(...)`, in that
  order, so the crumb, the title and the tab row land on the same pixel on
  both. NOT an accent-bordered door on the Creatures page — a box in that
  colour reads as a warning, and it moved the head down one line.
- **An approved design that HAS animations is a normal creature** (maintainer
  2026-09-10: "Approved Candidates should become normal monsters. They may
  still not have all animations yet (that's a work in progress), but they
  should exist as a normal monster so I can look at the animations done so far
  and review them like a normal monster"). `buildCandidateMonsters` derives one
  from any candidate with strips under `candidates/<id>/animations/` — from the
  FILESYSTEM, not from a flag, because the agent only ever animates one he
  approved — and pushes it into `domains.monsters` beside the shipped roster,
  so the viewer, the per-state per-direction verdicts, the shadow editor and
  the stats all work on it unchanged. Its `path` is `monsters/<id>`, the
  identity it keeps once the agent writes `monster.json`, so no verdict is lost
  in the promotion; a real `monsters/<id>` folder always wins, so there is
  never a duplicate. Its state row is the DOMAIN'S list in the domain's
  order — `animation_map.json`'s `idle, walk, angry, attack, die` — never the
  filesystem's, which is alphabetical and had two creatures side by side
  disagreeing about where idle was (maintainer 2026-09-10: "I like the old
  monsters sort in the animation buttons"). A folder the map does not name is
  not a state — it is a parallel TAKE of one (below).
  It carries `pending: true` and `candidate: <path>`: the
  card shows "in the making", the Animations panel says "more coming", the page
  links back to the 8 directions, and the filter row grows an "in the making"
  chip. The nav count is the whole list — a design being animated is a
  creature he can review.
- Gate: `wiki/tools/check-candidates.mjs` (the two tabs and that the head does
  not move between them, an in-the-making creature opening as an ordinary
  creature page, chips, one shared zoom with
  true size ratios and bigger spans for bigger designs, 8 loaded facings, one
  box the smallest and biggest design share with their art at one zoom inside
  it, the same/1×/2×/4× chips in that order, the label under the art,
  approve stamps `version` and leaves the queue, an older-version verdict
  reads as judge-again). Runs in `wiki-guard.yml`.

## The facet block is ONE idiom — a label column, chip radios, a pill

Maintainer 2026-09-09: *"I can see you have added a lot of UX/UI that doesn't
follow the CSS style guide. And the page starts to become a bit hard to
understand."* Kind, Placed, Light, Facing and Animation had each arrived in
its own markup: two rows both called Light, a native select with a hex string
and a "per state" pill beside it, an orphaned "✕ embers" button, a reference
sentence as a line of its own, and an approve/redo pair above the state's
real approve/remove/redo.

The rule that keeps the block readable, and that the next row follows:

- **Every row is `div.card-sub.lit-mode`** = `span.muted.lit-label` (one
  84px column, so the labels line up) + a `sortBar(..., {persist:false})`
  chip radio + at most one `.pill` for a measurement. A select is
  `.wiki-select` (the seg look, the chips' 38px); a slider is the hitbox
  editor's `.shadow-sliders label > span / .shadow-slider / .shadow-val`.
- **A row's details are its SECOND LINE, not more rows** (`.lit-detail`,
  indented under the chips) and exist only while the row's chip says there is
  something to detail — the light's kind, colour, flame/embers, strength and
  radius appear under Light only while it is lit. The bonfire scale is the
  strength rail's tooltip.
- **One approve on the page.** The animation verdict is a three-chip radio —
  the agent's class | approved | redo — where choosing the agent's chip
  withdraws his verdict. The state's own approve/remove/redo row stays the
  only place those words appear as buttons.
- **The piece's rows above a rule, the state's below** (`.facet-divider`):
  Kind and Placed are one decision for the whole piece; everything under the
  line is about the state and facing named in the pill.
- **Chips are short.** "agent: probably bad" pushed the radio onto a second
  line on a 393px phone; the chip reads the class and the tooltip says whose
  call it is.

Gate: `wiki/tools/check-facet.mjs` (light details under the Light row, one
row called Light on an unlit state, a three-chip animation radio, no control
smaller than the page's others).
## "Which ones have I already done?" — the shadow queue

ONE FILTER ROW, ONE SORT ROW, and "in the making" belongs to the FILTER one
(maintainer 2026-09-10: "If I press in the making you still say 'all 94'. With
that filter it can't be 94."). It was a sort chip in the row above, so pressing
it left "all 94" selected in this row and the page claimed both at once. Every
chip HERE answers "which creatures" — all, in the making, no shadow, shadow set
— and a chip nothing can fill is not drawn. A filter also follows him onto a
creature page, which a sort cannot.

‹ › WALKS THE LIST HE IS LOOKING AT: `monsterNav()` applies the filter AND the
sort (`monsterSort`, the one comparator the overview uses), so "next" means what
the last screen showed. An empty filter never strands him — the pager falls back
to the whole roster.

THE ANIMATION HE IS REVIEWING SURVIVES THE PAGE (maintainer 2026-09-10: "going
to the next page should still show the attack animation if I was on the attack
animation"). `makePlayer` opens on the last state he picked, remembered per KIND and only for
CREATURES (`wiki-viewer-state-monster` / `-character`), whose five states are
one fixed vocabulary; a scenery piece's states are numbered per piece
(`lit_2`, `not_lit_3`) so carrying one across pieces lands him somewhere else
each time. Only honoured when the entity has that state — else idle, else its
first.


Maintainer 2026-08-22: *"If I login with admin the monster page should make it
possible to filter by 'no shadow set'. This is to be able to know what I have
already fixed."*

A shadow is **set** when the monster carries its own `{rx, ry}` in
`live/tuning/monsters.json` (`shadowRaw`), rather than falling back to the
art-derived default. Every one of the tuned monsters also has per-facet
offsets, so "half done" is not a real state and there is no chip for it.

`all 57 | no shadow 46 | shadow set 11` — admin only, counts on the chips, the
same vocabulary as the tile inbox. The count reaching zero is what finishing
looks like.

**The filter follows him onto the creature page.** With "no shadow" on, ‹ ›
walks only the untuned ones (`25 / 46`), and `prefetchAround` warms that queue
rather than the full roster. This is not a flourish: a filter you cannot
navigate is exactly the dead end he hit on tiles — *"I use your code to filter
on NOT reviewed. I then click on that tile set, but can't navigate further to
find the review. How was this supposed to work?"* If a filter empties, the
pager falls back to the whole roster rather than stranding him on nothing.

Gate (`check-creatures.mjs`): the expectation is derived from the live tuning
doc, so the counts move as he works and the gate never needs editing. It runs
in its OWN admin context — everything else in that file deliberately runs as a
player — and it checks that a player gets no filter and all 57 creatures **even
with a stale `wiki-monster-shadow` preference left in their browser** by an
admin session.

## One shadow per monster — its centre is the position, its size the hit box

Maintainer 2026-08-20, replacing the per-facet shadow notes: *"Lets say you
have something long and thin. I can create this shadow in S, N, E and W. But
not the other monster directions. So what I want is just a single shadow size
for the entire monster … if I change the size in S animation it will change
for all directions in all animations. The trick is to rotate the shadow around
the center using the current monster direction. The goal is to get the game to
use this shadow and the center of the shadow will be the monsters position.
The size will be the monsters hit box."*

**The record** is one ellipse per monster, inside its `live/tuning/monsters.json`
entry — game tuning exactly like `max_hp`, riding the same live channel, the
same save bar, the same hot push to running clients:

```json
"shadow": { "rx": 25.5, "ry": 10,
            "offsets": { "idle#south": { "ax": 0, "ay": 33.6 },
                         "idle#east":  { "ax": -9, "ay": 30.1 } } }
```

Frame pixels at scale 1 (art px ≈ wu). `rx`/`ry` are the semi-axes **as seen
facing south** — ONE size for the whole monster. The **offsets are per
animation × direction** (v2, his correction after tuning real monsters: *"The
shadow offset is per animation and direction"* — PixelLab frames each
direction's strip independently, so the body drifts inside the frame per facet
and a single offset made him chase his tail: fixing E broke S, and the big
compromise offsets it forced were also what inflated the canvas into a
scrollbar). Each offset places the ellipse centre relative to the **frame
centre**; the chain for a facet is: its own offset → the same direction's idle
offset → a v1 record's base `ax`/`ay` (no migration needed) → the art-derived
default. The centre IS the monster's position — the game anchors the sprite on
it per facet, so the art stands corrected over a shadow that never moves. No
record → the game stays on its legacy art-measured anchors, so the world
switches monster by monster as he tunes.

**The rotation is on the GROUND, not the screen.** The iso view squashes
ground-vertical by `ISO_DY/ISO_DX` (15/32). A screen-space quarter-turn of the
drawn ellipse would put that squash on the wrong axis: a long-thin body tuned
at S as 10×30 must show E as **64×4.7** — longer AND flatter — and SE as a
**43°-tilted 38.8×7.7**, not the naive (30, 10). So: unsquash the tuned depth,
rotate by the facing's ground angle, re-squash, and hand back radii + a screen
rotation via the closed-form 2×2 SVD — which Phaser (`setRotation` +
`setDisplaySize`) and canvas (`ctx.ellipse`) can both draw directly.
`shadowScreenEllipse` lives in `games2/shared/src/index.ts` for the game and
is mirrored in `wiki.js` for the editor; `wiki/tools/shadow-mirror.mts` +
the gate hold the two implementations equal to 5 decimals over 32 cases.

**The editor** (monster pages, "✎ Edit shadow") keeps the pad + W/H rails +
Reset, but the semantics are the game's:

- **The ellipse is PINNED and the monster moves.** Its centre is the monster's
  world position, so dragging the pad right stores `ax+` — **for the animation
  and direction on screen** — and slides the SPRITE left — *"when I move the
  shadow what really should happen is the monster should move the opposite
  direction."* The readout names where the offset in force comes from (`set
  for Walk · SE`, `inherited from Idle · SE`, `the measured default`), and
  Reset is two-stage to match: it drops this facet's offset first, and clears
  the whole record only when pressed with nothing facet-local (the button
  relabels itself). Turning the direction pad re-rotates the ellipse in place
  and the corrected art stands over it.
- **The layout is anchor-true and constant.** The canvas box is derived from
  the UNION of every clip's content box plus the ellipse's worst-case extents
  over all facings — one box for the whole monster — so switching animation or
  direction moves nothing and the shadow's canvas position never jumps
  (*"where the shadow is placed vertically has to be the same for the entire
  monster in all directions and animations"*). Horizontally the box is
  SYMMETRIC around the anchor, so the shadow sits at the canvas centre
  (*"the shadow will pick the center"*) — and at the VISIBLE centre: when a
  big monster's box must overflow the stage, the scroll auto-centres on
  resize, because a shadow at the centre of a canvas you can only see the
  left of is centred on nothing (his second phone report: an 83px overflow
  parked at the left edge rendered everything 41px off-centre and read as
  "the shadow got misplaced again"). Vertically the box hugs the monster,
  never the shadow (*"the monster will be rendered so far up if we do
  that"*). While editing, the box is FROZEN — but per GESTURE, not per
  session: it re-hugs on every pad/rail release, which is what keeps the
  12px travel slack from accumulating into a scrollbar, while the canvas
  still never resizes under a live drag (that bug cost him a night once
  already).
- **Untuned monsters start from the measurement**: `rx/ry` from the manifest's
  measured shadow, `ay` from `artBottom` + `hoverPx`, shown as a dashed ghost
  while editing. The readout says `tuned — the game uses this` or `untuned`;
  Reset deletes the record (there is no no-op collapse here — a record equal
  to the default is still the decision that switches the game over).

**What the game does with it** (games2, maintainer-directed 2026-08-20):
`WorldScene.addMonster`/`playMonsterAnim` anchor the sprite's origin on the
shadow centre — ONE origin for every direction and state, replacing the
per-direction ground contract, per-frame drift pinning, hover lift and
toe-kiss for tuned monsters — and the per-frame loop draws the rotated
ellipse at the monster's position. Committing from the wiki re-anchors
monsters already on screen (the live push handler re-applies origins).
Server-side, `monsterRadiusFor` derives the body radius from the tuned size
(mean of the GROUND semi-axes — the sim works in circles) for separation,
spacing, dodge and the player's swing range.

The old `pixel-wiki-shadow-notes@1` doc is **frozen**, kept as the training
data it was; the editor no longer writes it.

Gate: `wiki/tools/check-shadow.mjs` — the three-implementation equality above
(including SIGN-anchored diagonal checks: a monster walking south-east moves
down-right, so its long axis must point down-right — the check the first ship
lacked while all three implementations agreed about a mirror), then on the
live page: one record across 2 states × 8 directions, one pinned anchor for
all 16 views, no real scrollbar viewing and bounded auto-centred overflow
editing, the monster sliding exactly opposite the drag SAMPLED MID-GESTURE
(the release re-hugs, asserted separately), a 24-fast-click direction storm
leaving record, canvas, anchor and centring untouched, east/south/diagonal
ellipses matching the game's own numbers, Commit posting `tuning/monsters`
(never `shadow_notes`) with the on-screen values, Reset deleting rather than
storing a fake confirmation, and no editor for the public.

## The preview stage never outgrows the phone screen

Maintainer 2026-09-09, a tree at 4×: *"not the entire scenery is rendered in
the preview ... the tree is 'cut'/clipped at the exact preview div boundary."*
Nothing was clipped. The stage grew to 1,139px on a 740px phone, and once he
scrolled to the roots its top slid under the sticky topbar and crumb row
(118px) — which looks exactly like a clip and cannot be told from one.

- **The stage stops at the screen under the sticky bars**
  (`.player-stage { max-height: calc(100dvh - --topbar-h - --crumb-h - 24px) }`;
  both bar heights are measured, `measureBar()` / `measureCrumb()`, the
  crumb row after every route because it is rendered per page). The picture
  scrolls INSIDE the box on both axes, the way it already did sideways.
- **`safe center` on BOTH axes.** A centred flex child taller than its
  scroller parks half of itself in negative scroll space that nothing can
  reach — the same bug that hid the left edge of wide pieces in August, on
  the other axis.
- **Not a fit-to-screen.** Fit-scaling was retired on his instruction ("I
  want the default to review in x2 because that's what the game uses"); a 4×
  picture three screens tall is his explicit choice, and every pixel of it
  is reachable by a swipe in the box.

Gate: `wiki/tools/check-stage.mjs` — a 360×740 phone, the tree at 4×: the
canvas is taller than the visible screen, the stage is not, the canvas starts
at a non-negative scroll offset and the stage's scroll height covers it.

## The animation viewer scales by the CREATURE, not the frame

Sprite frames are mostly transparent padding, and the padding differs per
export — Lava Salamander and Lava Salamander II are the same 30×35 creature
in 78×48 and 48×48 frames. Scaling by frame size therefore rendered them
1.67× apart and drew the 32×23 frog 2.5× wider than the 77×121 mammoth
(maintainer 2026-07-30; the flaw shipped in the first version of the site).

`build.mjs` measures the union of opaque pixels for every clip (decoding the
WebP itself — `wiki/lib/webp-pixels.mjs`), and picks one `scale` for the
whole roster (so the view a page OPENS on — idle facing south — fits a 300px
stage). It folds the per-clip box in as `clip.bb` and publishes
`data.artScale`; the viewer crops the padding and draws everyone at that one
scale. Same creature ⇒ same size on screen; bigger creature ⇒ bigger.

The crop is **per clip**, never per entity: a creature sits at different
offsets in each direction, so an entity-wide union spans that drift and stops
describing the creature (measured: an entity union made one salamander 74px
and the other 48px again). Within a clip the box is fixed, so the animation
still moves inside it.

### A still is a one-frame animation

368 of the 371 scenery pieces ship no animation, and their page used to say
"No animations." and stop — true, and useless, because the viewer is the only
place the wiki draws a piece cropped free of padding at a known scale with a
zoom control (maintainer 2026-08-13: "the animation viewer shows the object in
its true scale and is a good tool for me to look at the object … We only need
this if no real animation exist"). `buildObjects()` gives a piece with no
animation a one-frame `still` clip pointing at its own `sprite.webp`, and flags
it `stillOnly`.

`stillOnly` is what keeps the synthesis honest everywhere else: the heading
reads *Still* rather than *Animations*, the list keeps calling the piece
"static" (that list is where you scan for what moves), and it is never offered
as a sound event to assign — nothing in the game fires `objects.<id>.still`.
The viewer drops the controls a single frame cannot use — play/pause, frame
step, speed, the frame counter, a state row with one button, a direction pad
with one direction — and keeps zoom, which is the whole point.

This grew the shared objects stage from 70×87 to 246×255 art px, because the
stage is sized to the largest thing in its domain. That is the same deal the
32×34 mystical frog already gets on the 213×202 monster stage: a fixed stage
per domain is what stops the layout moving while you page ‹ ›, and the cost is
empty checkerboard around the small pieces. Seven clips of 385 (the ancient
oaks and hanging willows) exceed a 393px phone at the default 2×, and scroll
inside their own stage — "1×" is one tap away.

### The back gesture peels one layer at a time

The wiki is an in-game drawer (`games2/client/src/wikipanel.ts`), not a page,
so the phone's back gesture had nothing of ours to pop and left the game
outright (maintainer 2026-08-13: "Opening the wiki and swipe back doesn't close
the wiki. It exits the game"). The panel now owns **one history entry per
visible layer** — one for itself, one more while the wiki's own side menu is
open — and back peels them in the order the dark strip and Escape already used:

```
menu open → back → wiki (menu closed) → back → game → back → quit
```

The subtle half is the *other* way out. Closing a layer by tapping the strip,
pressing Escape or using the wiki's own control hands its entry **back**
(`dropLayers`), or the player is left pressing back on entries that do nothing;
and a close that CAME from a back gesture must not touch history at all, since
the browser has already popped it. `selfPop` keeps those two paths from
handling the same event. An in-wiki walk is the player's own history and is
walked first, then the drawer closes — the same order the wiki's ← crumb uses.

`check-backgesture.mjs` covers all of it, including both hand-close paths. It
needs the game client (`npm run dev:client` in `games2/`) and SKIPs cleanly
without it, since every other wiki gate needs only the assets server.

### The scenery review queue (admin)

The overview carries a sort row (**by group** / **newest first**) and a filter
row (**all** / **unreviewed** / **approved** / **rejected**), admin-only and
remembered in `localStorage`. `objectQueue()` is the single place that decides
the order and the membership, and **both** the overview grid and the entity
page's ‹ › pager read it — that is the entire mechanism behind "the filter
holds when I press next next next" (maintainer 2026-08-13). Every filtered
page shows a banner saying which filter is on and how much of the domain it
covers, so a Next that skips 200 pieces explains itself; a piece reached from
search or a link while a filter is on keeps a working pager and is labelled as
outside it, rather than silently losing its ‹ ›.

**A verdict belongs to the art it was given on.** The scenery agent deletes
rejected pieces and regenerates them **at the same path**, and the feedback
store is keyed by path — so new art silently inherited the judgement of the
piece it replaced. That is why the maintainer found 3 unreviewed pieces after
hours of new content (2026-08-13): 20 of the 237 were carrying his verdict on
art he had never seen, and a stale *rejection* would have had the agent delete
the replacement too, on a loop. A verdict older than the piece's `added` date
is therefore not a review of what is on screen: those pieces read **re-review**
instead of approved/remove, are excluded from the approved and rejected
filters, and are counted in the review queue.

"Newest first" needs a date, and nothing in `scenery.json` carries one, so
`build.mjs` uses the commit that ADDED each piece — one `git log
--diff-filter=A` pass, cached in the committed `wiki/first_seen.json`. The
deploy image has no `.git` (the `.dockerignore` allowlist keeps it out), so
there the cache answers instead; a piece the cache does not know landed after
it was committed, i.e. is newer than everything in it, and gets stamped with
the build's own time — which sorts it exactly where a reviewer wants it,
first. Self-seeding, correct in both places, no cross-domain dependency. The
better long-term source is the scenery agent stamping `generated_at` into its
own manifest (asked for on the board 2026-08-13); this switches to it the day
it appears.

### The build measures the art itself — pushes are self-measuring

There is no separate measurement step. `build.mjs` decodes every clip's
pixels with **`wiki/lib/webp-pixels.mjs`** — a zero-dependency VP8L (WebP
lossless) decoder — and computes the content boxes, the per-domain stage
boxes and the shared scale in the same run that writes `data.json`. Since
the Dockerfile already reruns this build inside **every deploy's image
build**, any agent's art push deploys with its art measured, atomically.
No timers, no second pipeline, nothing for other agents to remember
(maintainer 2026-08-13: "It should just work when someone pushes").

`wiki/art_bounds.json` is only a **content-hash cache** of those
measurements: a clip whose file bytes (and declared slicing) are unchanged
is not re-decoded. Delete the file and the build re-measures everything in
~6s; with a warm cache the whole measurement pass is ~0.6s, and a deploy
that brings N new pieces pays only for those N. `rebuild.sh` refreshes the
committed cache and runs the proofs — one pass, idempotent.

The decoder earns its trust by comparison, not review:
`check-pixels.mjs` decodes art with both this decoder and Pillow and
compares the **md5 of the full RGBA buffer** — the bring-up run on
2026-08-13 covered all 24,103 files in the three viewer domains,
byte-identical (and caught a real sign bug in the LZ77 distance table on
the way, which is the point). `check-artbounds.mjs` additionally proves
the cache is only a cache: it deletes an entry, runs the real build, and
asserts the identical numbers come back.

Why all this exists: the measurement used to be a separate Python/numpy
pass reading this build's own `data.json` — circular, so a growing domain
needed two runs in the right order, and art pushed between them shipped
unmeasured. On 2026-08-13 the monsters agent imported 33 monsters and
rebuilt `data.json` correctly, but nobody ran the second pass: none of the
33 got a measured `bb`, the player fell back to the whole padded frame —
Cragback asked for a 472×472 canvas to draw a 402×350 creature on a 432px
stage and grew a scrollbar while Diretusk, measured in July, sat inside it
— and `seedMonsterLevels` read the missing measurements as *area 0*, so a
rabbit out-ranked a bear. Two of that day's defences remain because they
cost nothing and cover the build being unable to read a file:
`seedMonsterLevels` scores an unmeasured creature mid-field, and the
player **self-measures** any clip that reaches it without a `bb` (same
alpha cut, proven equal by `check-artbounds.mjs`).

The **stage** is fixed per domain (`data.artBox`, e.g. monsters 207×189 art
px): the widest and tallest pose any of them needs, shadow and hover
included, with the creature centred in it. Paging next/next/next therefore
swaps the creature without the layout moving at all. The stage — not the
canvas — carries that size, so a rare oversized pose can use the stage's own
scroll instead of inflating every page, and `max-width:100%` keeps it inside
a phone (measured 331×396 there, identical on all 24 monster pages).

Picking a zoom (1× 2× 4×) changes the **creature, not the layout**: the stage
keeps its default size and only grows when the zoomed sprite genuinely will
not fit (measured: the frog holds 331×396 at every zoom; the mammoth grows
only at 4×, where its pose is 410×542).

## Usage stats — measured on the DEFAULT world

"Is this actually in the game?" is answered against the world players really
enter (`DEFAULT_WORLD` in `games2/client/src/maps.ts`, read at build time so
it can't drift — `the_game`, the only world). The **UI never names the world**:
the other worlds are a development convenience, and the finished game has a
single world players never think of as one of several (maintainer
2026-07-30) — copy says "used 137× in the world" / "unused", never a world
id. `build.mjs` emits `data.json` `world`:

- `monsters[id] = {spawned, zones}` — summed from that world's `spawns.json`
  zones. Shown on the monster cards ("7 roaming · 2 habitats") and page.
- `tiles[<repo path>] = placements` — cells whose surface tile is that tile,
  plus props. (A raised cell stacks its tile for the cliff faces; that's the
  same placement seen from the side, not a second use.) Tile pages show
  "N of M tiles used", per-tile `×N` badges, and unused tiles render dimmed.
- `map` — the world's own `minimap.png` plus every monster's habitat as
  **cell spans** (`[row, level, col0, col1]`) and the affine cell→pixel
  transform, so the monster page's "Where it lives" panel fills the true
  footprint. **Never project a zone's OUTLINE**: a vertex's screen position
  includes its corner's terrain height, which makes the projection
  non-linear, so a provably simple polygon tears into self-crossing shards
  across cliffs (shipped once 2026-07-30; the maps agent proved the data
  clean and the bug was here). Spans are per-level runs, so they map through
  the affine transform and can't distort. Cells are filtered to the zone's
  `elev` band on whichever surface qualifies — base **or deck**, the game's
  `buildZoneRuntimes` rule — otherwise a bridge habitat (all deck) vanishes
  and a shoreline zone renders 2.6× too big. Produced by
  `python3 wiki/tools/world-map.py` → `wiki/world_map.json`; re-run it when a
  world's `spawns.json` or `minimap.png` changes (or the default world does).
  The tool derives cell→pixel from `maps2/pipeline/render2.py`'s layout and
  **fits** the minimap's own crop/resize by matching the predicted content
  bbox to the PNG's opaque bbox — it refuses to write if the x/y scales
  disagree or if zones project off the drawn map, so a silently-misaligned
  overlay can't ship.
- `npcs[<characters2 folder id>] = [{id, name, type, anchor, x, y, elev,
  wares}]` — the cast maps2 stands in the world (`maps2/worlds3/<w>/npcs.json`,
  `pixel-maps2/npcs@1`), keyed by the same folder id this build uses for an
  NPC, so the join needs no translation table. An NPC who is placed gets a
  **"Where you'll find them"** panel (maintainer 2026-08-06) — the creatures'
  own world minimap with their standing spot on it — plus an "in the world"
  chip, a merchant's wares, and a dot on their tile in the Races grid so the
  placed handful are findable among 191.
  - A person is a POINT, not a zone, and the mark is a **CSS overlay in
    percent**, not paint: the minimap is ~1800px wide and displays at ~330 on
    a phone, so a canvas-drawn dot shrinks to a speck exactly where it matters
    most. Percent holds its size on every screen and stays crisp. The
    projection is the zone map's own affine (cell → diamond CENTRE, `+tile/2`,
    `+dy`), so the two maps agree by construction — `check-npcmap.mjs`
    recomputes it from the data and compares against the rendered mark.
  - It is deliberately **approximate** — the maintainer's framing: an NPC who
    can walk will not be on that exact tile when you arrive. Hence a soft halo
    around the dot and "Roughly here…" under the map, never a pin.
  - maps2' `anchor` is provenance, so the panel says it the way a player would
    ("in the market", "at the cave mouth") via `ANCHOR_WHERE`.

Audio "used" is **referenced by the game**, not merely present:

- a sound is used when a `sounds/bindings.json` event names it (including
  `sound_by_surface` / `ambience_by_region` / layer maps) or the composer
  looks it up directly (`sounds.get("id")` in `games2/composer/**`);
- exactly one music track is used — the composer's director picks the
  background bed by scoring `use` text (mirrored from
  `composer/engine/music.ts`); the title/night beds are the composer's own
  mp3s, not music-domain tracks.

## Monster LEVEL — the one-glance difficulty

Every monster carries a `level` (1-20), shown as a chip **under its picture**
on the cards AND on the monster page, so the eye finds it in the same place
either way (maintainer 2026-07-30). Nothing in the monsters domain carries a
difficulty, so the first pass is DERIVED by `build.mjs` from the two things
this repo can actually measure, then tuned by hand in the admin Stats panel —
**the seed never overwrites a level that already exists**:

- **size** — the biggest the creature ever draws over every state and
  direction (`art_bounds.json`): Diretusk 176 art px of diagonal, Mirewart 33;
- **remoteness** — cells from the player's spawn (the bonfire) to the nearest
  cell of its nearest habitat: the classic level gate, what lives where you
  arrive is what a level-1 player meets first.

Both as RANK percentiles (one outlier can't squash the ladder), weighted
0.7/0.3 toward size, spread BY RANK over 1-20. Result: Mirewart 1 → the blobs
2-3 → Quillkin/Fluffang 4-5 → the mid-field cats and salamanders → Frostwraith
17, Balefiend/Mosscairn 18, Rimeshard 19, Diretusk 20. An unspawned monster
scores mid-field on remoteness rather than pretending it lives on the bonfire.

## Paging must not move the animation

The maintainer pages monsters with next/next/next and the viewer below must
not move a pixel. Three things had to be fixed, in this order:

1. the **title** wrapping to two lines — solved by the monsters agent's short
   in-game names (longest 11 chars; at the drawer's real geometry the title
   column is only ~248px beside the portrait, where 30px type wraps at ~15);
2. the **stage** resizing per creature — see the section above;
3. the **blurb** running 2-4 lines. Line count depends on the column width, so
   a hardcoded `min-height` is wrong on some phone; instead `loreSlot()` puts
   every blurb in the domain in ONE css-grid cell with only the real one
   visible, and the row comes out exactly as tall as the tallest at whatever
   width it actually has.

Reserving the tallest blurb costs slack on the short ones, and **where that
slack lands is the whole game** (maintainer 2026-07-30 circled it as "a lot
of extra unnecessary space"). Two rules keep it invisible on the monster
page:

- the blurb is the **last** thing in its column, so its reserve can never
  open a blank line between two visible elements. "N roaming the world" sits
  between the name and the blurb (maintainer's placement), never after it —
  put anything below the blurb and the reserve becomes a hole;
- the **chip lives under the thumbnail** — a creature's level, a hero's
  species/sex — so the left column carries its own height instead of leaving
  a void beside the text.

## Heroes say what they ARE

Folder ids (`default_boy`), frame sizes and state counts are pipeline facts
and are **admin-only** (maintainer 2026-07-30: "I don't even know what a
default_boy is"). Players get `Human · Male` under the thumbnail and the
hero's story beside it.

### NPCs are second, and quiet about it

`characters2/npcs/` (191 tag-driven mirrors, landed 2026-08-01) join the same
`characters` domain array with `kind: "npc"`, but the page is about the
**playable cast foremost** (maintainer 2026-08-01): heroes keep their big cards
on top, NPCs sit below in their own clearly secondary block under an
"NPCs · count" heading — half-size tiles (94px against a hero's 192px at 426px
wide, four to a row).

- **They are authored, not guessed.** characters2 ships `display_name`,
  `species`, `sex`, `role` and `lore` on each `character.json`, read from the
  ART. Never touch `pixellab_prompt`: it is the same copy-pasted "young female
  adventurer" text on all 191 and says female for every one of them. That
  prompt and the duplicate PixelLab name it produced stay admin-only, as does
  the folder key. `"Villager"` survives only as the fallback for an NPC synced
  before the agent has named it.
- **The tiles say who, quietly**: name (12px) over trade (10.5px muted), one
  line each, **ellipsised not wrapped** — a tile that grows a second line
  re-flows all 191 and the block stops reading as secondary. Verified 0 of 191
  names or trades clip at 360/393/426px.
- **The id is the folder key, unprefixed.** The lore fold matches
  `loreEntities[dom][e.id]`, so a wiki-invented prefix would silently fail to
  join the day the lore agent writes an NPC up.
- **No technical names reach a reader** (maintainer 2026-08-01). NPCs are
  absent from `animation_map.json`, so their state keys would otherwise be raw
  PixelLab folders — `custom-calm-still-idle-breathing`, plus an upstream typo
  variant `...stili...` on 39 of them. `npcState()` in build.mjs matches folder
  WORDS against the game's own state vocabulary, so both land on `idle` and the
  viewer prints "Idle"; a new slug lands right without anyone editing a table.
  `stateLabel()` in wiki.js then presents any state readably (`spell_wand` ->
  "Spell wand"). One NPC legitimately has two idle clips (different art, both
  folder spellings) and shows "Idle" and "Idle 2".
- **Search**: the whole cast is findable by name, sex or trade now that the
  names are real — they were excluded while all 191 were "Villager", because
  191 identical rows drown every query. Folder key and PixelLab name remain
  admin-only search terms.
- **`‹ ›` pages within the group.** A hero pages among the 2 heroes, an NPC
  among the 191 — otherwise the cast is buried between Man and Woman.
- The nav/start-page count stays **heroes only**; the block carries its own.
  `counts.npcs` exists separately in data.json.
- No Movement-sounds panel on NPC pages — that kit follows the player.
- **`no_turn` is the Game Master's, and only theirs.** characters2 sets it on
  an NPC whose ART only reads right from ONE facing, so the game must never
  rotate them — Thorne's armorer breastplate stands on the ground beside him
  in south and south-west and is absent in south-east, so a turn pops the prop
  in and out. The wiki reads `no_turn` off the character's own
  `character.json` and shows a **"never turns"** pill on the role line,
  admin-only: it is a constraint on the art, not a fact about the character,
  so a player has no use for it. Driven from the data, so it follows as more
  get tagged. `check-npcmap.mjs` asserts a player never sees it, the Game
  Master does, the tooltip explains it, an untagged NPC does not get it, and
  the row stays one line.
- Feedback ids are the repo path (`characters2/npcs/<key>`), so review works
  exactly like everything else.
- Verified layout-safe: the shared characters stage box (112×113 @ 2x) and
  scale did not move when the 191 joined the measurement set.

That copy is the characters agent's to author, in
**`characters2/metadata.json`** (`characters2-metadata@1`, keyed by folder
id: `display_name` `species` `sex` `lore`); their `sync.py` also merges the
record onto the generated `humans/<id>/character.json`, so either file
answers and `build.mjs` prefers the authored one. Add a field there and the
wiki picks it up on the next build.

**Never read any of this from `character.json`'s `prompt`** — both heroes
shipped the same copy-pasted prompt saying "female" for BOTH (checked
against the sprites; the art and the ids were right). A hero with no record
gets no species/sex line rather than a guessed one.

Do NOT try to win that by enlarging the portrait: at 160px it squeezes the
text under `.meta`'s 240px `min-width`, the columns stack, and the stage
drops 150px (measured).

Measured over all 24 monster pages at 360/380/400/412/426/440/460px: **0px of
movement** at every width (was 70px at 426px). Objects too (was 38px). Below
~346px a 20px step remains, from the state-tab row inside the Animations panel
wrapping for the 6 monsters whose `angry` falls back to idle (`angry (→idle)`
is a wider label) — not the header.

## The animation viewer shows only what exists

- **Direction buttons are the directions that ART EXISTS FOR** (maintainer
  2026-08-07: "only directions that exist should be visible as buttons").
  All eight used to render with the missing ones greyed out, so an NPC whose
  idle is south-only showed eight buttons and you had to press them to learn
  which way the art faces. Availability is **per state** — Mosscairn's `angry`
  ships 5 of 8 while its `walk` ships all 8 — so the pad rebuilds on every
  state change, which it already did. Picking a direction the next state lacks
  hops to one it has, so the selection is never stranded on a hidden button.
  `.dirpad` keeps a `min-height` so the panels below cannot move.
- **A character with NO animation art shows its standing rotations.** Three of
  the 191 NPCs synced with a `base/` folder and no `animations/` folder, so the
  player drew an empty chessboard with a "—" counter and no explanation
  ("Why is Morwenna not visible in the animation viewer?"). `baseRotationClip()`
  turns `base/<dir>.webp` into a one-frame `standing` clip — a synthesised
  clip, not a UI special case, so the player, the direction buttons and the
  state chip work unchanged and the card says "Standing" rather than
  impersonating an idle. Only directions whose file is on disk are emitted: a
  clip pointing at a missing rotation trades an empty viewer for a broken
  image. **It disables itself** — the fallback fires only when the animations
  map is empty, so a re-sync makes it stop applying with no cleanup.
- Gates: `check-segscroll.mjs` walks every state of a monster that ships both a
  partial and a full one, and checks the button count against **the art's own
  count per state** (not merely "fewer"), that no greyed button survives, that
  the selection is always visible, that each state still draws, and that the
  pad holds one height. `check-deadend.mjs` asserts no character has an empty
  animation map and that the standing fallback paints real pixels.

## Paging ‹ › must not move the panels

An NPC's role and its world pills share **one unwrappable row** (`.npc-trade`).
The "in the world" / "merchant in the world" / "sells …" pills used to be their
own `.spawn-line` row, and only the 19 placed NPCs of 191 had it — so stepping
through the cast with ‹ › shifted the Animations viewer up and down under the
maintainer's thumb (2026-08-07: "I don't want the animation cart to jump up and
down when I press next NPC").

Three things make the row exactly one line tall for *every* character — role
only, pills only, both, or neither:

- it renders **unconditionally**, with `min-height`, so an NPC with no role and
  no placement still occupies the same line;
- `flex-wrap: nowrap` on the row **and `white-space: nowrap` on every child**.
  The row rule alone is not enough: a `.pill` is an inline-block, so when space
  runs short it wraps its OWN text to a second line and the row grows anyway.
  That is exactly what the gate caught — 40px vs 22px at 426px wide;
- the role and the wares list may **shrink and ellipsize** (`min-width: 0` is
  what actually permits that); the `in the world` pill never shrinks, because
  it is the fact worth keeping whole. Full wares stay in the title.

Gate: `check-segscroll.mjs` starts on a MERCHANT (the longest possible row),
pages 14 NPCs, and asserts one distinct Animations-panel top, one distinct row
height, and zero horizontal page overflow — after first asserting the walk
crosses both placed and unplaced NPCs, or it would prove nothing. Verified 360
→ 1100px: row 22px and no overflow at every width.

## The Creatures overview is a SHOWCASE

Maintainer 2026-08-18: *"the Creatures overview page needs to showcase the art
a bit better … the monsters are so small it's hard to even see them … I feel
it's more impactful to just scroll in the overview."*

**Not per-card zoom-to-fit, in either direction.** The card drew `sprite.webp`
in a 110px box with `object-fit: contain`, SHRINKING a 256px frame (a mammoth
at 0.47×) while leaving a 34px one alone; cropping to the measured creature
(`clip.bb`) and zooming to fill the box is the same bug with the sign flipped —
fitting every creature to one box throws away the one thing the art is telling
you, which is **how big the thing is** (maintainer: *"the Dewling now looks very
big compared to Diretusk"*).

### True scale, and the CARD is what varies

*"I think just showing the monsters in their true scale (I think the game uses
what we call 2x) and just make some cards take up more space instead … what if
a card can be 1x1 (small), 2x1 (wide), 1x2 (tall) or 2x2 (wide and tall). On
mobile two 1x1 can fit on one row. This makes it possible for small creatures to
be displayed more densely and a big monster will get the 'wow'-effect because it
needs a bigger card."*

That is the design, and it is exactly what ships (the same reasoning sits on the
constants in `wiki/site/wiki.js` — change one, change both).

- **One scale for the whole roster: `data.artScale`**, the 2× the game and the
  animation viewer already draw at. No per-card zoom, no fitting; `clip.bb`
  survives only to crop the frame's padding away, never to change a size.
  Measured: creatures land between **48 and 284 drawn px tall** — a **242px**
  mammoth beside a **74px** poring — and that spread is the point.
- **A creature that does not fit one cell claims a second**, across, down or
  both, and `grid-auto-flow: dense` packs the small ones back into the holes.
  Roster on his phone: **45 single cells, 3 tall, 9 full 2×2**; on a desktop the
  narrower column tips one more creature wide, so all four spans appear (44 / 2
  / 10 / one 2×1).
- **The row height is tuned to the roster's own shape**, not picked round: at 2×
  the creatures fall into two groups with a clean gap — 45 stand 48–150px, 12
  stand 172–284px — and a **216px** row leaves the art **159px**, putting that
  gap exactly on the threshold. Not 184: that split the *cluster*, handing a
  130px creature a 322px stage while its 126px neighbour kept a 128px one.
- **Two 1×1 on one row on mobile, as asked.** The cell floor is **150px**, not
  the 168 the first cut used: a 360px phone leaves 332px of content and 168 gave
  it ONE column. Measured: 360px → 2 columns, 393px → 2, 1280px → 6. A desktop
  gets **more** creatures, never bigger ones — the mammoth is 156×242 on both.
- **Every creature is centred in its own stage**, whatever size the card is
  (maintainer, rejecting bottom-aligned 1×1s: *"Centering looks best."*). The
  card is a frame, not a diorama, and one rule across all four sizes reads
  calmer than two.

**The spans are measured, not computed.** `fitShowcase()` reads a real 1×1
card's stage after layout — and again on resize — and gives a second cell to any
creature wider or taller than it fits. Deriving the art's room from row − text −
padding instead was 8px optimistic (it forgot the card's gap and borders) and
clipped the ears and feet off four creatures. It measures the stage's CONTENT
box, so the 3px of breathing room is real padding rather than a JS constant that
drifts from the stylesheet. Two columns is the cap; `grid.dataset.over` counts
anything too big even for 2×2 — zero today, a tripwire for the day the monsters
agent ships something enormous.

**Chrome rides on the art, in the TOP corners.** Creatures stand on the bottom
of their box and grow upward, so the bottom corners are where the art is (a pill
parked bottom-left sat across Ashfiend's leg). Level chips top-right;
`aggressive`, `not spawned` and the Game Master's review badges stack top-left.
**A layout rule, not a taste**: badges appear only once he has starred or
rejected a creature, so in the text block they would add a third line to
*exactly those* cards, shrinking their stages below the one the spans were
measured from and clipping the art he had just reviewed. The text block is two lines on every card, always. The green `calm`
pill was dropped here — absence is the calm, and the word moved to the
creature's own page.

**And it moves.** The whole roster's idle clips are 296 KB, so each card
animates the same idle/south its own page opens on, as a CSS `steps()` sweep
over one strip: no per-frame requests, nothing in a JS frame loop. An
IntersectionObserver arms a card near the viewport and disarms it after, so an
off-screen card holds no image and no animation (measured: 6 of 57 animating at
the top of the list). `prefers-reduced-motion` gets the same picture, still.

Gate: `wiki/tools/check-showcase.mjs` re-derives every crop from `data.json` and
compares it against the RENDERED page: one scale and it is the game's, a mammoth
towering over a poring, four legal spans with the range genuinely used, no card
clipping its own art, the same size on a phone and a desktop, every creature
centred on both axes (measured off the art's own box), the background really
stepping through frames, the far end of the list idle while you are at the top,
and reduced motion stopping the animation without losing the art. It re-runs the whole layout at 360, 393 (his
phone) and 1280px and counts SHARED ROWS at each, because "two 1×1 fit on one
row" is a claim about the packing, not about a column count. Three of its checks
exist because this design can break without looking broken:

- **every single cell is the same box** — one 1×1 card is measured and its stage
  applied to all 57, so a card quietly shorter than the probe gets a span that
  clips it. This is the check that caught a stray `*/` in the stylesheet
  silently disabling the whole `.showcase` rule: the page still drew every
  creature, it had simply stopped being a layout.
- **the text block is exactly two lines, with no badge row in it** — the
  structural half of the badge rule, so it cannot come back through the markup.
- **a bigger card is one the creature needs** — every 2-row card must hold art
  that would not have fitted one row, every 2-column card art too wide for one
  column. "Some cards take up more space" only reads as size if the big card is
  big BECAUSE the creature is.

## A background-image cannot report a 404 — the showcase's silent empty card

**Maintainer 2026-08-19:** *"when I restart the game and click on wiki … the
monsters in game will be displayed on the Creatures overview page and the
monsters not in the game will show an empty card. I then click on the first
empty card and back again and now all monsters display correctly."*

Two facts had to line up. **The image ships 24 of the 57 creatures**, so
`monsters` is a SHIPPED domain with unshipped members — `isUnshipped()` answers
per DOMAIN and cannot see them, so every card asked the image for its art and 33
of them 404d. And **the showcase draws with `background-image`**, which it has to
(the animation is one strip swept by `steps()`) — and a background that 404s
fires no event whatsoever. Every other image in the wiki is an `<img>` covered by
the capture-phase `error` listener that asks the repo before believing anything
is missing; the showcase quietly opted out of all of it. No art, no note, no
retry: an empty box.

His click was that missing recovery happening BY ACCIDENT. The creature's own
page draws `<img>`s, one 404s, `onArtMissing` asks the repo, succeeds, and marks
the whole domain repo-only — so on the way back every card resolved correctly.
The information was always one 404 away; nothing on the overview was asking.

The fix gives the background art a real failure path: the paint goes through a
detached `Image()` that CAN report failure, and a miss follows the same three
steps an `<img>` does — ask the repo, hold if the repo base is still coming
(`showcaseMisses`, drained by `retryRepoMisses`), and only then judge, using the
same "gone means gone" rule keyed on the entity's own `preview`. One card's miss
also re-points every other card of that domain (`repointShowcase`), so the grid
heals in one round trip rather than 33.

Gate: **`check-unshipped.mjs`**, which already reproduces production with two
origins, now also simulates a MIXED domain — the image serving 24 creatures and
404ing the rest while the repo serves all — and asserts on the COLD LOAD, with
no clicking, that every card on screen actually draws. It re-fetches each
background url and asks it to DECODE, because a 404 leaves the CSS property set
and proves nothing when read back. Its sharpest check is `mute`: an armed card
showing neither art nor a note, which is the exact state he photographed. Then
it kills the repo too and asserts the page SAYS "not loading" rather than going
quiet — and never claims the agent removed a creature over a 503.

**A rule worth keeping:** any new way of putting art on this page — canvas,
background, `<picture>`, a worker — is outside the `<img>` recovery until it is
explicitly wired in. The wiki reads two origins by design; art that cannot
report a miss cannot participate in that.

## Creatures overview: sortable, and "will it attack me" at a glance

- **Sort by name / level / aggressive first** (maintainer 2026-08-06) in its
  own fixed-height `.sortbar`, persisted in
  `localStorage["wiki-monster-sort"]`. **by name** is the default (the raw
  order is the folder id, random against display names); **by level** is
  hardest first; **aggressive first** puts the ones that hunt you before the
  rest, each half hardest-first.
- **A red `aggressive` mark replaced the habitat line** (the habitat count
  stays on the creature's own page; whether it comes for you unprompted
  matters more in a grid). **Absence is the calm** — a green `calm` on 48 of
  57 cards answers "will it attack me" by shouting at everybody, so the WORD
  moved to the creature's own page, in the spawn line where a tooltip has room
  for the rule; the stat grid says the same thing as `Aggro radius (wu): 0`.
  `not spawned` survives beside it — a creature in no world at all is a
  different fact from a calm one.
  - **LIVE data, not a build-time snapshot**: proximity-aggro needs an aggro
    radius above zero, the tuning default is 0 (passive by default, 9 of 57
    hunt), and the mark reads through `monsterStats` — the same live doc the
    stats editor writes — so re-tuning a radius re-marks the card with no
    rebuild.
  - Gate: **`wiki/tools/check-creatures.mjs`** derives its expectation from
    `live/tuning/monsters.json`, not a list typed into the gate, and checks
    the mark against each creature's own radius in BOTH directions (absence
    checked as hard as presence). `aggressive` must be red-dominant by
    COMPUTED COLOUR on the overview — two words in the same colour pass a
    text-only check — and `calm` green-dominant on the creature page it moved
    to. Then all three sorts and the reload that proves the choice sticks.
  - **A selector that stops matching must FAIL the gate, not soften it**: it
    kept reading the old `.thumb-chip` after the showcase moved the level onto
    the art, so every card reported 0 and "by level is hardest first" spent a
    fortnight passing on 0 ≥ 0. A missing chip now returns `null`, never `0`,
    and the gate asserts a real spread (20 distinct levels), each equal to the
    TUNED level, before it judges the order.
