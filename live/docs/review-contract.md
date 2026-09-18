# Acting on a wiki review — the contract every domain shares

The wiki is the Game Master's review surface and `live/feedback/<domain>.json`
is what he writes there. This file is the law for ACTING on those verdicts and
for the state the wiki is left in afterwards. The art work itself is each
domain's own business (`<domain>/README.md`); this is the part that is the same
everywhere, and the part a github agent must not improvise.

Written for anyone acting on a review — the domain agent, its assistant, or its
GITHUB AGENT, the one `.github/workflows/github-agents.yml` starts when a review
lands.

## The laws

1. **A verdict describes ONE generation of the art.** The moment you replace
   that art, his verdict and his note are about something that does not exist,
   and the wiki would show his old words under a new picture. **Delete the entry
   as part of doing the work** — not at the end of the sweep, not next run
   (maintainer 2026-09-18: *"I press redo with a comment ... the new state that
   will take its place should CLEAN the state and comment"*, *"I don't want to
   see redo marked with an OLD comment on my data! Ever!"*). Reference
   implementation: `monsters/pipeline/animate.py` `clear_verdict()`, called the
   moment a direction lands, so the window where the wiki can show a stale note
   is zero.

2. **An APPROVAL is never cleared.** It is his pick and it has to outlive the
   review. Only `redo` and `rejected` die with the art they judged.

3. **A removal is a removal EVERYWHERE.** "Once it has been removed I want it
   removed from the wiki as well" (maintainer 2026-09-18). That means, in one
   unit of work: the art on disk, the entry in the domain's index/manifest, the
   upstream record (PixelLab, for the domains that mirror it), **and every
   feedback entry keyed on it** — the entity-level key AND every facet key
   `<path>#<state>#<dir>`. Reference: `monsters/pipeline/candidates.py`
   `reconcile()`, which deletes the record and the folder, retires the design,
   rebuilds the index and prunes every dangling verdict; `items/pipeline/
   feedback.py` and `characters2/pipeline/verdicts.py` do the same for theirs.

4. **Never leave a verdict pointing at art that no longer exists.** That is the
   dangling row he is talking about, and it is the one failure this contract
   exists to prevent. After your unit, no key in your domain's feedback file may
   name a path, state or direction that is not on disk.

5. **Never write or edit a verdict, only clear the ones you acted on.** The
   feedback file is HIS channel. Re-applying a stale request overwrites a newer
   decision (PROTOCOL), and inventing a verdict puts words in his mouth.

6. **A verdict is taken ONCE.** Claimed or acked on ANY board — the agent's, its
   assistant's, its github agent's — means consumed. Claim before you edit, per
   PROTOCOL's "Two writers per directory".

7. **Rebuild what the wiki actually reads.** The domain's own index/manifest is
   what the registry is built from; a removal that is not in the index still
   shows. `wiki/site/data.json` is rebuilt from the whole tree inside the deploy
   image, so your change appears in the live wiki when the next deploy lands —
   do not hand-edit it (the wiki agent owns that file).

8. **A RUN THAT LEAVES NO ACCOUNT DID NOT HAPPEN** (maintainer 2026-09-18: *"it
   would be really good if you can write a law that they must say what they did
   and why they did it like that and push it. Just so we always know what they
   were thinking and why they acted like they did"*). Before your session ends,
   write on your board — and PUSH it — four things:
   - **what you took**: the verdicts you claimed, by key;
   - **what you did**: the commands you ran and what shipped, with the sha;
   - **what you did NOT do, and why**: a verdict you left for the domain agent,
     a take you judged too risky to regenerate, a budget you stopped against;
   - **what you cleared**: every feedback entry you removed, by key.

   **This binds a run that changed nothing just as hard.** "Nothing to do" is a
   DECISION and it is the one most worth reading: say what you read, what you
   concluded and from which file, and push that. Measured 2026-09-18: a github
   agent ran eight minutes on a live rejected state, reported success, wrote
   nothing and pushed nothing — and there is no way, afterwards, to know whether
   it was right. An empty push costs one commit to `coordination/`, which
   triggers no deploy; a silent run costs the only record of the reasoning.

## The guards that exist, and why they are not an excuse

The wiki already refuses to show a verdict as current when it can prove the art
moved under it: a candidate verdict is stamped with the candidate's `version`, a
monster's redo is compared against the clip's `generated_at`
(`animate.py prune-feedback`), and a scenery state carries its art hash. When
they disagree the page reads "regenerated — judge again" and the queue counts it
as unjudged.

That is a FAIL-SAFE for a verdict nobody got to yet. It is not permission to
leave the entry behind: "judge again" on work you have already done is still a
row he has to read and dismiss, and the note under it is still his old words.
Clear it.

## What the verdicts mean

The vocabulary is `live/README.md`; the per-domain meaning is the domain's
README. In short, and only as a map:

| domain | authority | approved | redo | rejected / removed |
| --- | --- | --- | --- | --- |
| `monsters` | `monsters/README.md` | candidate: generate every animation | same design, next seed / another take of that state | drop the design, prune every verdict on it |
| `scenery` | `scenery/README.md` | keep the piece / state | **facet key only**: keep the state, generate another take | facet: delete that state; piece: drop the piece |
| `items`, `characters2`, `tiles` | that domain's README | keep | (where the domain defines one) | remove the asset and its entries |
| bindings (`bindings.json`) | `live/README.md` | keep the attachment | — | unbind that sound from that event; the recording stays |

A domain that has no `redo` sense has only approved / rejected — do not invent
one.
