# lore/ — the story of Nangijala

The narrative domain. Everything in this game that is *text about the world*
belongs here: the backbone the whole setting hangs off, the chapters players
read, and the individual story of every monster, item, character, place and
people in it.

Owned by the **lore agent** (board file `coordination/lore.json`). Like every
other domain it writes only inside its own directory.

## Why this exists

Until now each agent invented a description for its own entities, in isolation.
That got text into the game quickly and it worked, but it cannot produce a
*world*: nothing referenced anything, nothing had a history, and two agents
could — and did — write facts that quietly contradicted each other.

This domain owns the connective tissue. A monster is not a paragraph of
atmosphere; it is a thing that came from somewhere, that relates to an item,
that illustrates a law, that a chapter explains. When that is written down
once, properly, dialogue and quests stop being creative work and start being
lookups.

## Layout

```
lore/
  RED_LINE.md              THE ROOT. Game-Master-facing. Not shipped to players.
  canon/
    GLOSSARY.md            controlled vocabulary — the words we are allowed to use
    CONSTRAINTS.md         verified repo facts the lore must not contradict
  entries/<id>/entry.json  standalone articles: chapters, peoples, places, factions
  entities/<domain>/<id>.json   per-entity lore, keyed by the owning domain's folder id
  pipeline/build.py        rollup + canon integrity check
  lore.json                GENERATED — the single file the wiki reads
```

## The red line

`RED_LINE.md` is the backbone. Five laws, three ages, one argument, one
antagonist, and a list of things deliberately left unanswered. Every chapter
and every entity blurb is downstream of a claim it makes.

It is written for the Game Master, not for players — players are meant to
*find out* this material by reading chapters and playing. It is deliberately
kept **out of `lore.json`** so it never ships as content.

> That is not secrecy. This repository is public, and `wiki/site/data.json` is
> served statically to anyone who asks. Treat "GM-facing" as "not written into
> the game yet", never as "hidden".

Changing the five laws is a **root change**: it invalidates every chapter and
every entity file downstream. Everything else can be extended freely.

## The two kinds of lore

**Entries** (`entries/<id>/entry.json`) are articles that stand on their own —
a chapter, a people, a place, a faction. A chapter is an entity like any other
and can be linked to.

**Entity records** (`entities/<domain>/<id>.json`) attach story to something
another agent owns: a monster, an item, a hero. Each carries a short `blurb`
(card-sized) and a longer `story` (the entity's page), plus `related` links.

Both use `related: [{ "domain", "id" }]` for cross-references — never inline
link syntax, because the wiki renders plain text nodes and any markup would
ship as literal characters.

## Build

```bash
python3 lore/pipeline/build.py           # validate, then write lore/lore.json
python3 lore/pipeline/build.py --check   # validate only
```

The build **refuses to write a broken canon**. It checks that every
cross-reference still resolves against the live repo, that ids match their
folders, that blurbs fit the wiki's shared-height layout, and that no markup
sneaked into text destined for a text node. It also reports **drift** — when a
display name this domain quotes has been re-authored by its owning agent, so
the prose can be re-read.

Run it at the start and end of every run. It is how this domain finds out that
somebody deleted a monster.

## Contract with the other agents

The lore agent writes `lore/**` and `coordination/lore.json`, and **nothing
else** — not `monsters/config/roster.json`, not `items/config/roster.json`, not
`characters2/metadata.json`, not `wiki/**`.

Text reaches the game through `lore/lore.json`, and there are **two different
texts per entity** that must not be confused:

- `entities.<domain>.<id>.description` — the **short line under the entity's
  name**, always visible at the top of its page. **This replaces the owning
  domain's own description** (maintainer, 2026-07-31: the lore agent has full
  control over text). Where we publish nothing, the domain's own text stands,
  so partial coverage degrades gracefully.
- `entities.<domain>.<id>.lore` — the **long read-more text**, an array of
  paragraphs, shown only when a reader chooses to expand it. No length limit.
  Nothing else in the repo produces this.
- `entries[]` — standalone articles, shaped exactly like every other domain's
  entity list (`{id, name, path, preview, summary, ...}`) so the wiki can adopt
  them as a section with no new plumbing.

**The layout guarantee.** The wiki reserves the height of the longest
description in a domain, so a long one makes every page in that domain taller.
Because ours *replace* rather than add, the rule that makes substitution
provably free is: never be longer than the longest description that domain
already ships. `build.py` measures that budget per domain from the live repo
and **refuses to write** when it is exceeded — so it stays correct as other
agents rewrite their own copy. `lore.json` publishes the measured budget it was
built against as `layout_budget`.

If you own a domain and want lore for your entities, you do not need to do
anything: say so on the board and it will appear in `lore.json` keyed by your
folder ids. If you rename or delete an entity, you do not need to tell anyone —
the canon check finds it. That is the design.

## The doctrine of loss

This domain assumes everything it references will eventually be deleted,
renamed or regenerated by somebody else, because that is what the repo does.
The fiction was built to absorb it: in Nangijala, things being forgotten is how
the world works, not an error in it. An entity that disappears **went Quiet**.
A renamed one **drifted**. A regenerated map is **a Turn**.

So the practical rules are:

- Chapters never depend on one monster, item or place existing. They are
  written around the laws.
- Entity records are cheap and disposable — delete them when their subject
  goes.
- Nothing is ever keyed on a display name, only on a folder id.
- No geography is ever described by coordinate.

See `canon/CONSTRAINTS.md` for the full table.
