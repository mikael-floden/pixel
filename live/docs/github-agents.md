# The github agents — an agent that starts itself when you review

A review is an EVENT, not something that waits for the next agent run
(maintainer 2026-09-18: *"I want to wake up an agent when a wiki review is
committed to process it immediately without me having to tell the agent"*).

**The event already exists.** A wiki admin save is committed to `main` by the
game server itself — `games2/server/src/live.ts` `ghCommitDelta`, one commit per
save, path `live/feedback/<domain>.json`, message
`live: admin update — feedback/<domain>.json`. So every verdict is already a
precise, per-domain, machine-detectable push. What is missing is only the last
hop: something that STARTS an agent on it. Until then a verdict sits until the
domain agent's next run reads the file (PROTOCOL rule 4), which can be hours.

The Claude GitHub App is installed on `mikael-floden/pixel` (checked
2026-09-18), so the hop is one workflow file.

**They are called github agents** (maintainer 2026-09-18: *"every agent I have
also have a github agent. This is how I think about it"*, and of the words this
used to use — wake, verdict session, stand-in — *"I feel this is insanely
confusing"*). One per agent, named `<agent>-github-agent`, with its own board at
`coordination/<agent>-github-agent.json`. Use those words everywhere he can see
them: the workflow name, the run title, the job name, the wiki.

## The workflow

`.github/workflows/github-agents.yml` — armed, and the file itself is the
authority: it carries the reasoning in its own comments and the prompt each
github agent is started with. This doc does not copy it. (A doc that duplicates
a workflow drifts from it, and then two things claim to be the rule.)

The shape, in one breath: a push to `live/feedback/*.json` whose commit message
is the wiki server's `live: admin update` waits four minutes, then one job per
reviewed domain runs Claude in a fresh checkout as `<agent>-github-agent`.



## Why it starts when it starts (measured 2026-09-18)

The first green run, end to end: **82s** for the detect job to CHECK OUT THE
REPO just to read a log, **171s** for the agent's own checkout, 7s pip, and only
then Claude — 4m45s, on top of a 2-4 minute artificial wait. Maintainer: *"if we
can get the agent up and running fast it will feel live/realtime"*, and of the
wait, *"Remove it completely!"*. It is now **~27 seconds** from the push to
Claude reading its first file:

- **The detect job does not clone at all.** It asks the API "has this feedback
  file been touched in the last 30 minutes", one cheap call per file: 3s.
- **The agent's checkout is partial AND sparse**: `filter: blob:none`,
  `fetch-depth: 50`, and a cone of its own domain plus `coordination/`,
  `live/`, `wiki/lib`, `games2/scripts` (the root always comes with cone mode,
  so CLAUDE.md and requirements.txt are there): 8s, from 171s. It can widen the
  cone itself with `git sparse-checkout add`, which the prompt tells it.
- **Nothing waits.** The `debounce` job is gone — see the law below.
- **Python is not set up for it.** `setup-python` + `pip install -r
  requirements.txt` cost 6s of every start, and a session that only clears a
  verdict or answers "nothing to do" never needs them. The runner ships python3;
  the prompt tells the agent to install the requirements itself the moment it
  reaches for a pipeline.
- **The CLI is NOT cached, on purpose.** Caching the binary and handing the
  action `path_to_claude_code_executable` saved ~8s and then killed a real
  scenery review 5 seconds in: the cache reported a hit, the path held nothing,
  and the run died with "Claude Code native binary not found ... errorClass:
  executable_not_found" — a failure that looks nothing like its cause. Three
  commits, one broken run, reverted. Let the action install it.
- **The cone is three directories**: the domain, `coordination/`, `live/`.
  `games2/scripts` and `wiki/lib` are not fetched until the agent asks, which
  the prompt tells it to do.
- **The `detect` job is gone too, and the parallelism stayed** (maintainer
  2026-09-18: *"we want them to be able to run in parallel! But we also need
  lower latency ... think hard and we can get the best of both worlds"*). A
  matrix needs a list, and computing the list needed a job in front of the work
  — ~5s of runner and API to learn what the push payload already said. So there
  is no matrix: `github-agents.yml` declares ONE JOB PER DOMAIN, each with a
  job-level `if` over `github.event.commits.*.modified`, and each calls the
  reusable `github-agent-run.yml`. The matching domain starts immediately; the
  others are never created, so they cost nothing and do not even appear in the
  run. Independent jobs, so two domains still run side by side.
- What is left is GitHub's own floor: one runner assignment and the clone.
  Below that needs a self-hosted runner with a warm clone and the CLI already
  installed (~3-5s to first token) — a machine to own and patch, which is a
  different decision.


**THE FEEDBACK FILE IS NOT THE DIRECTORY.** He reviews scenery and the wiki
writes `live/feedback/objects.json`; the domain on disk is `scenery/` and its
agent is the scenery agent. Same for `characters.json` → `characters2/`. The
`detect` job maps the file to the domain before naming anything — without it the
job is called `objects-github-agent` and sent to read `objects/README.md`, which
does not exist. Found on his first real scenery review (2026-09-18), on a run
that fired correctly and would have confused the session it started.

Skipped, with the reason: `bindings` is an `<event>#<sound>` review, not a
domain; `composer` and `composer-music` belong to `games2/composer`, one corner
of a directory six agents share — a stand-in there needs the games2 split
decided first.

## The laws this encodes

- **One github agent per domain, shaped by that domain's own docs** (maintainer
  2026-09-18: *"when I do a review on a monster and click redo that agent has to
  know how to be the monster agent. And when I redo a scenery it should know how
  to be a scenery agent"*). The domain is DERIVED from which feedback file he
  wrote — `detect` reads the commit log of the last 30 minutes, not this push's
  diff, because the debounce collapsed a sitting into one surviving run whose
  own `before..after` is a single commit. Each domain gets its own matrix job,
  its own concurrency group and a prompt that sends it to
  `<domain>/README.md`. Never one session across two domains: that session is a
  second writer in both.
- **The shape is two documents, not a prompt.** The prompt only says which
  domain and in what order to read: `live/docs/review-contract.md` for how a
  review is acted on and cleaned up (the part no session may improvise), the
  domain's README for what the verdicts mean and which pipeline command does
  each. Rules live in the repo where every agent reads them, not in YAML.
- **`bindings.json` is skipped.** It is the composer's attachment review, not a
  domain directory — there is no `bindings/` agent to stand in for.
- **The woken session is a THIRD writer** in `monsters/`, after the agent and
  its assistant, so the prompt binds it to PROTOCOL's "Two writers per
  directory": read both boards, treat a claimed or acked verdict as consumed,
  claim on its own board (`coordination/monsters-github-agent.json`) before editing.
  Without that, two writers regenerate the same monster and PixelLab is paid
  twice for one file.
- **Only the maintainer's saves wake it.** Filtering on the server's commit
  message is what keeps the agent from being woken by its own verdict-clearing
  commit to the same file.
- **NOTHING WAITS** (maintainer 2026-09-18: *"So this is just an artificial
  sleep?!? Remove it completely! I dont care if we get several github agents in
  parallell! It's all about latency!"*). A `debounce` job used to sleep 2-4
  minutes in a cancel-in-progress group so a whole review sitting became ONE
  session that started after he stopped. It bought one session per sitting and
  cost that wait on every verdict. Removed.
- **What makes that safe is the WORK group, not a timer**: one session per
  DOMAIN at a time (`github-agent-<domain>`, `cancel-in-progress: false` — a run
  there may be mid-generation, and killing it loses art already paid for).
  Different domains run in parallel; two sessions in the same domain would be
  two writers in one directory, which is the collision PROTOCOL exists to
  prevent, and no amount of latency is worth it.
- **A burst still ends in one catch-up session.** While a session runs, the next
  verdict's run waits in that group and GitHub keeps only the NEWEST waiting
  run; that session reads the FILE rather than its own commit, so it sees every
  verdict of the sitting.

## Opus 5, on his Max plan, thinking hard

Three separate things, and all three are set in `github-agent-run.yml` so none
can drift (maintainer 2026-09-18: *"What Claude AI is running Opus 5 on MAX is
desired!"*):

- **The plan** — the session authenticates with `CLAUDE_CODE_OAUTH_TOKEN`, the
  1-year token minted from his Max subscription. Not `ANTHROPIC_API_KEY`, which
  would bill pay-as-you-go console credit. (The input for the key is still
  passed and simply empty; whichever secret exists is used.)
- **The model** — `--model claude-opus-5`, pinned, never the default. The run
  log prints the model it initialised with; that is how to check rather than
  assume.
- **The pace** — an instruction, not a budget (maintainer 2026-09-18: *"Opus 5
  can be fast if you tell Opus 5 to hurry up ... some instruction to try and
  fulfill the request as fast as possible and not spend time if not needed is
  the best approch"*). A forced `MAX_THINKING_TOKENS` floor was set for one
  commit and taken out again: it makes the one-deletion case as slow as the hard
  one. The prompt opens with a PACE rule instead — smallest correct thing then
  stop, read for the rule not the document, no exploring or tidying, run the
  domain's own command rather than re-deriving it, and deliberate in proportion
  to what is at stake (deleting art or spending credit, yes; clearing a verdict,
  no).

Symptom to recognise: a 401 `Invalid bearer token` means the SECRET is not a
token — an authorization code is what a token is minted from, and pasting the
code produces exactly that error (2026-09-18).

## What it CANNOT do

**Wake a session you are already chatting with.** A GitHub push has no path into
a live conversation: a session is reachable by a schedule bound to it (cron,
hourly at best) or by you typing in it. So an immediate wake is always a FRESH
session — a fresh clone, no memory of your conversations, gone when the runner
is. That is the trade: seconds and a github agent, or your own agent with its
context at its next run. The boards are what keep the two from colliding — the
github agent claims its unit, and the agent you talk to sees it consumed.

## What it does NOT replace

Every art agent still reads `live/feedback/<domain>.json` at run start. The github agent
changes LATENCY, never correctness — if the workflow is off, disabled, or the
run fails, the next ordinary agent run takes the verdicts as it always has. A
scheduled Routine ("if there are unconsumed verdicts, act on them") is the
belt-and-braces net for the same reason: one path can fail silently, two cannot
fail the same way.
