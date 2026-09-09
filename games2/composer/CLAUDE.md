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

## THREE DOMAINS, ONE AGENT — AND THE FILES ARE SPLIT SO THAT CAN CHANGE

I currently work three domains, and each one is SELF-CONTAINED so a dedicated
agent can be hired into it without a single file moving (maintainer 2026-09-02,
the restructure that made this true: *"I was thinking this was how you did it.
You took the role as 3 agents, but seperated the work so a dedicated sound or
music agent could come in later on and have all it's responsibility in a single
folder."*)

| directory | what it owns | who could own it |
|---|---|---|
| `sounds/` | every sound EFFECT: the 44-sound catalog, the 422-set foley library (`sounds/foley/`), both generators (`sounds/pipeline/`), `bindings.json` | a sound agent |
| `music/` | every piece of MUSIC: the domain tracks, the score beds (`music/beds/`), the archive (`music/beds/pool/`), the briefs, both pipelines (`music/pipeline/`), `tracks.json`, `MUSIC_DESIGN.md` | a music agent |
| `games2/composer/` | BINDING ONLY: the engine, the viewers, `assignments.json`, `ambience.json`. Consumes the other two and generates nothing | the games-audio agent |

**NOTHING GENERATED LIVES IN `games2/composer/` ANY MORE, and the reason it
did is worth remembering: the engine resolved every take with
`import.meta.glob`, and Vite's workspace root is `games2` — so a build-time
glob could only see files inside it. The BUNDLER was choosing the repo layout.
Both manifests publish a `root` field now and every consumer JOINS it, so where
the files live is data.** If a build-time import of an asset ever creeps back
in, the split silently re-forms around it.

The engine reads three fetched documents and no bundled audio at all:
`/assets/sounds/foley/index.json`, `/assets/music/tracks.json`, and the
catalog's own `viewer_data.json`. All three are served from the domains that
own them, which also means they are content-hashed and immutable like every
other asset — the composer's old `/assets/composer/...` mounts were 404 in
production and are deleted.

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
