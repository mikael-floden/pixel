# Waking an agent the moment a review is committed

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

## The workflow

Not armed: this file is the recipe, not the trigger. `.github/workflows/` is a
shared surface and the wake starts a THIRD writer inside `monsters/` — it is
added on the maintainer's explicit go-ahead, never silently.

```yaml
name: verdict wake

on:
  push:
    branches: [main]
    paths:
      - "live/feedback/monsters.json"

# QUEUE, NEVER CANCEL. A run may be halfway through a PixelLab generation, so a
# newer verdict must not kill it. GitHub keeps one running + one pending per
# group and drops older pendings — exactly the debounce a review burst needs:
# a stream of saves collapses into one follow-up run that sees them all.
concurrency:
  group: verdict-wake-monsters
  cancel-in-progress: false

jobs:
  monsters:
    # ONLY HIS SAVES. The wiki server stamps every admin save with this exact
    # message; the monsters agent clears verdicts through the SAME file with its
    # own message, and waking on that wakes the agent with its own footprints —
    # a loop that terminates but pays for a session each lap.
    # KILL SWITCH WITHOUT SETUP: runs unless the repo variable VERDICT_WAKE is
    # "off" (Settings → Secrets and variables → Actions → Variables). Nothing to
    # configure for the normal path — the backup workflow's "derive, don't ask".
    if: >-
      startsWith(github.event.head_commit.message, 'live: admin update')
      && vars.VERDICT_WAKE != 'off'
    runs-on: ubuntu-latest
    timeout-minutes: 90
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # it rebases on origin/main before pushing
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -r requirements.txt
      - uses: anthropics/claude-code-action@v1
        env:
          PIXELLAB_API_KEY: ${{ secrets.PIXELLAB_API_KEY }}
        with:
          # Whichever of the two auth secrets the repo holds; the empty one is
          # ignored, so the app's OAuth token and a plain API key both work.
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          claude_args: "--max-turns 120"
          prompt: |
            A wiki review just landed on main: the Game Master committed verdicts to
            live/feedback/monsters.json. You are standing in for the monsters agent for
            this one unit of work, in a fresh checkout with no memory of earlier runs.

            Read first, in this order: CLAUDE.md (the law of the repo),
            coordination/PROTOCOL.md (its "Two writers per directory" section is binding
            on you), monsters/README.md (the authority on what each verdict means), and
            live/README.md (the feedback contract).

            Then:
            1. Read coordination/monsters.json and coordination/monsters-assistant.json.
               A verdict either board has claimed or acked is CONSUMED — leave it alone.
               If either board's `current` names a file you would touch, that unit is not
               yours; a collision goes to the original agent.
            2. Take only the verdicts in live/feedback/monsters.json that nobody has
               claimed and that the art on disk does not yet reflect. Derive that from the
               filesystem, never from the verdict count.
            3. Claim them on coordination/monsters-wake.json — your own board, same schema
               as the others: the unit and EVERY file you will touch — and push that claim
               BEFORE you do any work. A claim that ships with the work protects nothing.
            4. Do what the verdicts ask (monsters/README.md is the authority), run the
               domain's checks, `git fetch && git rebase origin/main`, re-run the checks if
               main moved under monsters/, push to main, then release the claim with what
               shipped.

            If PixelLab credits are low, stop cleanly and say so on your board rather than
            half-generating. If nothing is left unconsumed, write one line saying so and
            exit without committing — an empty run is the correct outcome when the agent
            got there first.
```

## The laws this encodes

- **One job per domain, never one session across domains.** A session that
  writes in two domains is a second writer in both. Add a domain by adding its
  feedback file to `paths` AND giving it its own job.
- **Monsters first, on purpose.** It is the domain where the latency costs
  something real — a redo verdict is a generation that cannot start until
  someone reads it. A domain whose verdict only needs reading at next run is not
  worth a session per save.
- **The woken session is a THIRD writer** in `monsters/`, after the agent and
  its assistant, so the prompt binds it to PROTOCOL's "Two writers per
  directory": read both boards, treat a claimed or acked verdict as consumed,
  claim on its own board (`coordination/monsters-wake.json`) before editing.
  Without that, two writers regenerate the same monster and PixelLab is paid
  twice for one file.
- **Only the maintainer's saves wake it.** Filtering on the server's commit
  message is what keeps the agent from being woken by its own verdict-clearing
  commit to the same file.
- **Queue, never cancel.** Cancelling a run mid-generation loses the PixelLab
  work already paid for; the queue is also the debounce for a review burst.

## What it does NOT replace

Every art agent still reads `live/feedback/<domain>.json` at run start. The wake
changes LATENCY, never correctness — if the workflow is off, disabled, or the
run fails, the next ordinary agent run takes the verdicts as it always has. A
scheduled Routine ("if there are unconsumed verdicts, act on them") is the
belt-and-braces net for the same reason: one path can fail silently, two cannot
fail the same way.
