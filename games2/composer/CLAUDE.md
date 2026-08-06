# CLAUDE.md — games-audio / composer agent

Domain notes live in `README.md`. This file is only for the things the
maintainer has had to say more than once.

## ALWAYS REPORT THE SHA

**Every time you push, write the commit SHA in your reply to him.** Short SHA
is fine; if a push contains several commits, list them all. Do this without
being asked, in the same message that reports the work — not as a follow-up.

> "Please how many times do I have to tell you. Always write the sha after you
> push." — 2026-08-06, after several pushes reported with no SHA

He tracks work by SHA. A reply that says "pushed to main" makes him go and
look it up, which is why he keeps asking. If a generator bot's commit carries
the actual output (`composer: regenerate foley sets`), name that SHA too — the
one he cares about is the one holding the files.

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
