# CLAUDE.md — games-audio / composer agent

Domain notes live in `README.md`. This file is only for the things the
maintainer has had to say more than once.

## ALWAYS REPORT THE SHA — AS THE FIRST LINE, IN PLAIN TEXT

**Every time you push, the reply's FIRST line is the SHA, and the SHA is
BOLD.** Format, exactly — this line is markdown, not a code block:

SHA: \*\*28fe1d0f1\*\* — composer: cross_on plays his peat pick

Which renders as: SHA: **28fe1d0f1** — composer: cross_on plays his peat pick

NEVER put it in a code block or inline backticks — a fenced block renders in a
small monospace face and he read it as "extra small". Bold, full size, first
line, nothing above it. One such line per commit. If a generator bot committed
the actual output, its SHA gets its own line, labelled as the one holding the
files.

> "Please how many times do I have to tell you. Always write the sha after you
> push." — 2026-08-06
>
> "How many times do I have to tell you to write the sha" — 2026-08-06, on a
> reply that DID open with the SHA, in bold inside backticks.

The second complaint is the instructive one: the SHA was present and he still
could not find it. Dressed-up formatting and a SHA buried under a summary both
read as absent. Lead with the bare line, then report the work.

He tracks work by SHA. A reply that says "pushed to main" makes him go and
look it up, which is why he keeps asking. If a generator bot's commit carries
the actual output (`composer: regenerate foley sets`), name that SHA too — the
one he cares about is the one holding the files.

## I OWN ALL OF THE GAME'S AUDIO

**`sounds/`, `music/` and `games2/composer/` are all mine** (maintainer
2026-08-08: *"You have the entire responsibility for much music and sound right
now."*). That includes the 44-sound catalog, both `music/` tracks — the daytime
overworld bed `nangijala_cherry_valley` is the one players hear most — and
`sounds/bindings.json`.

Do not hedge about domain boundaries on anything that makes a sound. Deferring
to "the music agent" once already cost him: the day bed was left out of the
sequenceable rewrite for no reason other than which directory it lives in, and
it is the single most-heard piece of music in the game.

The root `CLAUDE.md` repo map still lists `sounds/` and `music/` as separate
domains. Treat this file as the newer instruction until that map is updated.

## HE MAPS SOUNDS TO EVENTS, NOT YOU

- A sound plays ONLY where he assigned it. An approval, a star, or a keep-list
  entry is **not** permission to wire anything.
- No engine-side fallback may play a set just because its name matches an
  event. That is mapping sounds, and he had to unbind six thunder takes by
  hand because of it: *"I'm the one who map sound to events! NOT YOU!"*
- An unassigned event is SILENT. No exceptions.

## AN EVENT IS SOMETHING THE GAME TRIGGERS

An event with no sound is fine and normal — that is how he assigns one. An
event nothing fires must not exist. `scripts/verify-quiet.mjs` fails on it.

## A REQUEST IS A MESSAGE, NOT A RECORD

Wiring a wiki request into `EVENT_ASSIGNMENTS` and deleting the request entry
happen in the SAME COMMIT. `composer/assignments.json` is the record.
