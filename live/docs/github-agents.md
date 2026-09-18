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
- **Two gates, because waiting and working want opposite rules.** A review is a
  BURST — every save is its own commit (maintainer: *"When I review I usually
  press commit a lot of times... It would be dumb to create a new agent for each
  commit"*). So the `debounce` job waits 4 minutes with
  `cancel-in-progress: true` and each new push kills the previous wait: exactly
  one run, the last commit's, survives to do the work and it reads the file
  after he has stopped. The work job's own group is `cancel-in-progress: false`
  — a run there may be mid-generation, and killing it loses art already paid
  for. A dispatched run skips the wait.

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
