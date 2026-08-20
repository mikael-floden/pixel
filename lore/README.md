# lore/ — the story of Nangijala

The narrative domain: every word of text *about the world* — the GM-facing
backbone, the player-facing chapters, and the individual story of every
monster, item, character, place and people. Owned by the **lore agent** (board
file `coordination/lore.json`); no generation, no API. It exists because
descriptions written per-domain in isolation cannot make a *world* — nothing
referenced anything, and two agents did write quietly contradicting facts.
With the connective tissue written down once, dialogue and quests are lookups,
not creative work.

## Layout

```
lore/
  RED_LINE.md              THE ROOT. Game-Master-facing. Not shipped to players.
  revelations.json         GM beats ledger — what may be told (hidden|hinted|revealed)
  canon/
    GLOSSARY.md            controlled vocabulary — the words we are allowed to use
    CONSTRAINTS.md         verified repo facts the lore must not contradict
  entries/<id>/entry.json  standalone articles: chapters, peoples, places, factions
  entities/<domain>/<id>.json   per-entity lore, keyed by the owning domain's folder id
  icons/                   the maintainer's 48x48 pixel art + icons.json catalogue
  pipeline/build.py        rollup + canon integrity check
  lore.json                GENERATED (format pixel-lore@2) — the single file the wiki reads
```

The scenery domain is keyed **`objects`** in `entities/` and `lore.json` (the
disk rename `objects/` → `scenery/` 2026-08-12 moved only the path, not lore's
key).

## The red line

`RED_LINE.md` is the backbone — the five laws, the story, the beats, the cast
registry. Every chapter and every entity blurb is downstream of a claim it
makes. Changing the five laws is a **root change** that invalidates everything
downstream; everything else extends freely.

It is written for the Game Master — players *find out* this material by
playing — and is deliberately kept **out of `lore.json`** so it never ships as
content. That is not secrecy: this repo is public and `wiki/site/data.json` is
served statically to anyone who asks. Treat "GM-facing" as "not written into
the game yet", never as "hidden".

## The two kinds of lore

**Entries** (`entries/<id>/entry.json`) stand on their own — a chapter, a
people, a place, a faction. A chapter is an entity like any other and can be
linked to.

**Entity records** (`entities/<domain>/<id>.json`) attach story to something
another agent owns. Each carries a short `description`, a longer `lore` (array
of paragraphs), `related` links, and `name_seen` — the display name at time of
writing, which is what powers drift detection.

Cross-references are data, never markup (the wiki renders plain text nodes;
markup would ship as literal characters — the build rejects it):

- standalone: `related: [{ "domain", "id" }]`
- in running prose: `[[domain/id|Name]]` — the build parses each mention into
  text/link segments and validates the target; raw `[[ ]]` never ships.

## Build

```bash
python3 lore/pipeline/build.py           # validate, then write lore/lore.json
python3 lore/pipeline/build.py --check   # validate only
```

Run it at the start and end of every run — it is how this domain finds out
that somebody deleted a monster. It **refuses to write a broken canon**: every
cross-reference and mention is checked against the live repo, ids against
folders, descriptions against the layout budget and for markup, icons against
their art, and the revelations ledger for consistency. Report lines:

- `BROKEN` — build fails, nothing written: a referenced entity is gone
  ("went Quiet — delete this file"), id/folder mismatch, markup, a busted
  budget, a malformed beat.
- `DRIFT` — advisory: a `name_seen` no longer matches the live display name
  (re-read any prose quoting the old name), or a chapter runs past 1100 words.
- `HIDDEN` — advisory: a link points at a target with no `lore` of its own;
  the wiki hides such links (landing a reader on a stat sheet after "read
  next" is worse than no link).

## Contract with the other agents

The lore agent writes `lore/**` and `coordination/lore.json`, and **nothing
else** — not `monsters/config/roster.json`, not `items/config/roster.json`,
not `characters2/metadata.json`, not `wiki/**`.

Text reaches the game through `lore/lore.json`. **Two texts per entity, never
confused:**

- `entities.<domain>.<id>.description` — the **short line under the entity's
  name**, always visible at the top of its page. **It REPLACES the owning
  domain's own description** (maintainer decision: the lore agent has full
  control over text). Where lore publishes nothing, the domain's own text
  stands, so partial coverage degrades gracefully. The substitution happens at
  the wiki's read — the owning domain always keeps its own copy.
- `entities.<domain>.<id>.lore` — the **long read-more text**, an array of
  paragraphs, shown only on expand. No length limit. Nothing else in the repo
  produces this.
- `entries[]` — standalone articles shaped exactly like every other domain's
  entity list (`{id, name, path, preview, summary, ...}`) so the wiki adopts
  them with no new plumbing; each carries an `icon` (repo-relative 48×48 png
  path) and its `icon_id`.

A paragraph (in `lore` or `body`) is EITHER a plain string OR an array of
segments `{t}` / `{t, ref: {domain, id}}` — render `t` as a text node, a
segment with `ref` as a link. No markup ever.

**The layout guarantee.** The wiki reserves the height of the longest
description in a domain, so one long description makes every page in that
domain taller. Because ours *replace* rather than add, substitution is
provably free under one rule: never be longer than the longest description
that domain already ships. `build.py` measures that budget per domain from the
live repo and **refuses to write** past it — so it stays correct as other
agents rewrite their own copy — and `lore.json` publishes it as
`layout_budget`.

If you own a domain and want lore for your entities: say so on the board and
it appears in `lore.json` keyed by your folder ids. If you rename or delete an
entity you need tell no one — the canon check finds it. That is the design.

## Icons

Chapter icons are the **maintainer's own pixel art**, stored byte-for-byte as
delivered in `lore/icons/`, catalogued in `lore/icons/icons.json`.

- **`rune` is the default.** An entry naming no icon gets the carved standing
  stone; `lore.json` publishes that path as `default_icon`.
- An entry opts in with `"icon": "<id>"`; the build **fails** if that id has
  no art — a chapter can never ship pointing at a missing icon.
- **Never re-encode, resize or resample one.** They are 48×48, hard alpha
  (zero semi-transparent pixels, verified), 29–63 colours. Draw them at whole
  multiples of 48 with `image-rendering: pixelated` and no `max-width` — a
  fractional width softens every edge, and resampled pixel art is the one
  thing this project never ships.
- Unassigned icons (`used_by: null`) stay in the library with a `held_for`
  note. Never delete one for being unused — more arrive over time.

## The doctrine of loss

Everything this domain references will eventually be deleted, renamed or
regenerated by somebody else — that is what the repo does — and the fiction
was built to absorb it: an entity that disappears **went Quiet**; a renamed
one **drifted**; a regenerated map is **a Turn**. Hence:

- Chapters never depend on one monster, item or place existing. They are
  written around the laws.
- Entity records are cheap and disposable — delete them when their subject
  goes.
- Nothing is ever keyed on a display name, only on a folder id.
- No geography is ever described by coordinate.

Full table: `canon/CONSTRAINTS.md`.
