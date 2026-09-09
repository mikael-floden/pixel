# Items and lore pages

The Items inventory, "read next", lore v2 and the back navigation. Moved verbatim out of `wiki/README.md` (2026-09-09), which keeps the rules and points here; rewrite in place under the root doc law.

## The Items page is an inventory, not a shelf of posters

Maintainer 2026-08-24: *"Items are so small and we have so many … Can you
redesign the page so we can fit a lot more items on a single page? It's
unreasonable the card is as big as a monster. It also gives a more WOW feeling
scrolling over a lot of different graphics and be proud of the game having so
many."*

Every item icon is authored **48×48** (content box ≈38×40, measured on all 105)
and each was sitting in a 110px thumb inside a two-column card built for a
creature that stands 150px. Measured on his phone viewport:

| | before | after |
| --- | --- | --- |
| items in view | **2** | **24–28** |
| scroll per item | **314px** | **28px** |

(The library doubled from 105 to 226 the same day the items agent gave all 57
creatures a Soulstone, which is why the gate measures scroll **per item** rather
than total page height — an absolute ceiling would go red for that agent doing
its job.)

The grid is now the art: one 48px icon per cell **at its authored size** — pixel
art is never resampled here — with the name clamped under it and **what it is
worth** under that.

**Four across a phone, fixed.** `auto-fill` gave four on a 393px viewport and
five on his wider device, so the count drifted with the hardware; a fixed four
holds the cell wide enough for a name *and* a price on every phone (verified at
393, 412 and 430). Past 760px it goes back to filling the width.

**The price is on the tile because he sorts by it** — a sort you cannot read
down the page is one you have to take on trust. It reads 295, 285, 285, 280,
275 down the grid on the default sort, tabular so the column reads as a column.

**With his coin on it.** The first cut was the number alone, because the
existing coin is authored 32×32 and an 85px cell has no room for it at 1× —
and halving pixel art to fit is the one thing this repo does not do. He drew a
**24×24 single coin** for exactly this (*"I like icons, feels more like a game
that way"*), so `icons/coin.webp` sits beside the price at 24, and the 32×32
pile stays on the sort control. Neither is ever scaled: that is the whole
reason there are two of them.

Converted the repo's way — lossless **and** exact — and verified by decoding the
result with the wiki's own VP8L decoder and comparing every pixel to the source:
24×24, 440 B, **0 mismatches**. `games2/scripts/to-webp.py` needs Pillow, which
this container no longer has, so `wiki/tools/png-to-webp.mjs` does the same job
with a wasm encoder and the same round-trip refusal.

**Density must not cost identity.** 71 of these are soulstones whose `name` is
literally "Soulstone", so the caption carries the **creature** — Frostwraith,
Magmashell, Balefiend — with the full `Soulstone — Frostwraith · 295 gold` on
the tooltip, where a clamped caption cannot reach. The one caption allowed to
repeat is **"Unbound"**: a soulstone the items agent has not tied to a creature
yet, which is a true statement about that item and worth seeing on the grid.

**No rarity colour**, deliberately: he threw the Common/Uncommon/Rare/Epic
vocabulary off these cards in July (*"This should just say the item type"*), so
the only marks a cell carries are the type emblem it already had and his own
review badge.

Gated by `check-items.mjs` in the units that decide it — cells in view, page
height, cell height against the creature cards, the icon drawn at 48, no two
captions the same, and a tap target of at least 44px that opens the item.

## "Read next" is a promise

A link under *Read next* says there is more to read at the other end. If the
target page has no story, the reader lands on a stat sheet and learns the links
lie — so `hasStory(ref)` drops those refs (maintainer 2026-07-31). The rules:

- **Answer with the target's own renderer.** `hasStory()` runs the same
  `paginate()` the destination page will run, and chapters go through the same
  `chapterParas()` the chapter page uses. A predicate that reasons about the
  data independently *will* drift from what the page draws.
- **A domain with no story card can never pass.** `storyEntity()` knows only
  monsters, characters, objects and items. Tiles, sounds and music render no
  card, so loreStory in one of their records is unreachable text — if you add a
  card to a domain, add it to `storyEntity()` in the same commit or its links
  stay hidden.
- **Hidden for players, flagged for the admin.** Same path as an unresolvable
  ref: the admin sees the row with a `no story yet` pill and the entity's name,
  because the admin is who can get it written. Don't "fix" this by showing
  players a disabled row.
- **Tell the lore agent.** The refs are theirs; the wiki just declines to
  promise. 24 refs are hidden today — every creature story links to its
  soulstone, and no soulstone has a story yet (board request sent 2026-07-31).

`check-deadend.mjs` walks every page that offers *Read next*, follows every link
and asserts the destination has prose. Run it after any lore-shaped change.

## Lore v2: inline links and the reveal meter

The lore agent's v2 (2026-08-05) made two things the wiki renders:

- **Rich paragraphs.** A paragraph is a string OR an array of `{t, ref?}`
  segments — inline links where a name in running prose points at the entity
  it names. `paraText()` is the one flattener (pagination budgets, search,
  the summary-dedupe all use it) and `paraNode()` the one renderer; segment
  text stays a TEXT NODE, so the no-markup rule holds. Inline links follow
  the SAME landing rules as "Read next": a chapter ref starts the reader at
  the top, an entity ref lands on that page's story card, and Back returns
  to the prose you left. Never render a paragraph with `h("p", {}, p)`
  directly — a rich one prints "[object Object]".
- **The reveal meter.** lore.json ships `red_line_progress` counts
  ({revealed, hinted, hidden} beats); the Game-Master-only red-line page
  draws them as one segmented bar. Counts only — the beat-by-beat map stays
  in lore/canon/revelations.json, which never reaches a player.

## Back returns you to your place

Following *Read next* out of a story and pressing Back used to land you at the
top of the page you came from, with the story three screens down and its page
reset to 1 (maintainer 2026-07-31). `rememberSpot()` stamps where the reader
stood onto the history entry they are **leaving**; `restoreSpot()` reads it back
on the way in. The browser carries the state, so every entry in a trail
remembers its own spot however deep it goes.

- **Stamp on the way out, not on the way in.** A capture-phase click listener on
  every `a[href^="#/"]` runs while the old view is still measurable. By
  `hashchange` the entry has already switched and the position is gone.
- **Anchor to the story card, not to a pixel.** The art above a card loads
  lazily and the animation stage sizes itself late, so a bare `scrollY` points
  at different content by the time the reader returns. The stamp records the
  card's viewport offset and the restore re-derives the scroll from wherever the
  card ended up.
- **Restore the story's page before measuring.** `goToPage()` changes the card's
  height, `fitStoryTail()` measures that height to size the tail, and the tail
  decides whether the scroll is reachable at all. That order is load-bearing.
- **`history.scrollRestoration = "manual"`.** Otherwise the browser restores its
  own idea of the scroll after we set ours and races us for the last word.
- Only entries we stamped carry a `spot`, so a forward navigation (state `null`)
  still starts at the top — that rule is untouched.

`check-back.mjs` walks Stumpling → Sprigling → Back, a three-deep
trail, and list → creature → Back.
