"""The sounds loop.

Each **unit** of work is one sound: render the audio (procedural sfxr by default,
ElevenLabs AI when a key is present), write its `sound.json`, rebuild the viewer
index, refresh the coordination heartbeat, then commit + push. The next missing
unit is derived purely from the filesystem, so the loop is fully **resumable** —
stop it any time and the next run continues where it left off.

Run a bounded chunk (intended for a scheduled Routine / GitHub Action):
    python sounds/pipeline/loop.py --max-minutes 50
Other flags: --max-units N, --once, --no-push, --engine {auto,procedural,ai}.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import time

import coordination
import factory
import viewer_build


# --- git --------------------------------------------------------------------

def _git(*args, check=True):
    return subprocess.run(["git", *args], cwd=factory.ROOT, capture_output=True,
                          text=True, check=check)


def _current_branch():
    return _git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() or "main"


def commit_push(message, push=True):
    """Commit only the sounds/ domain (disjoint from the other domains, so
    concurrent pushes rebase cleanly) plus our own coordination heartbeat — the
    one file we may write outside the domain dir."""
    _git("add", "-A", ".")
    _git("add", "--", "../coordination/sounds.json", check=False)
    status = _git("status", "--porcelain", "--", ".", "../coordination/sounds.json").stdout.strip()
    if not status:
        return False
    _git("commit", "-m", message)
    if push:
        branch = _current_branch()
        r = None
        for attempt in range(4):
            r = _git("push", "-u", "origin", branch, check=False)
            if r.returncode == 0:
                break
            # Remote may have advanced (a concurrent domain's push); rebase + retry.
            _git("fetch", "origin", branch, check=False)
            _git("rebase", f"origin/{branch}", check=False)
            time.sleep(2 ** (attempt + 1))
        else:
            print("  ! push failed after retries:", (r.stderr[:200] if r else ""))
    return True


# --- planning ---------------------------------------------------------------

def next_spec(cfg):
    """The next catalog sound that has no audio yet, or None when all are done."""
    for spec in factory.sound_specs(cfg):
        if not factory.has_sound(spec):
            return spec
    return None


# --- one unit ---------------------------------------------------------------

def advance(client, cfg, push=True):
    spec = next_spec(cfg)
    if spec is None:
        print("== all catalog sounds complete ==")
        return None
    man = factory.generate(client, cfg, spec)
    dur = (man.get("audio") or {}).get("duration_seconds", "?")
    desc = f"{spec['id']}: {spec['name']} [{man['engine']}] — {spec['description']} ({dur}s)"

    viewer_build.build()
    budget = client.credits_remaining() if client is not None else None
    coordination.publish(current=desc, progress=coordination.progress_snapshot(cfg),
                         budget_remaining=budget)
    commit_push(f"sounds: {desc}", push=push)
    print("  +", desc)
    return desc


# --- main -------------------------------------------------------------------

class NoQualityEngine(RuntimeError):
    """Raised when the AAA engine can't run and we refuse to ship low-fi."""


def _make_client(engine, cfg):
    """Resolve the engine to a client. Returns an ElevenLabsClient for the AAA
    quality engine, or None for the REJECTED low-fi placeholder (explicit
    `--engine placeholder` only).

    'auto'/'ai' REQUIRE ELEVENLABS_API_KEY. If it's missing we STOP rather than
    silently emit the chiptune placeholder — shipping low-fi as if it were the
    real asset is exactly the mistake we're correcting."""
    from elevenlabs_client import ElevenLabsClient, ElevenLabsError
    if engine == "placeholder":
        print("!! --engine placeholder: emitting REJECTED low-fi sfxr audio "
              "(offline test only; do NOT ship).")
        return None
    if engine in ("auto", "ai"):
        if ElevenLabsClient.available():
            return ElevenLabsClient()
        raise NoQualityEngine(
            "ELEVENLABS_API_KEY is not set — the AAA sound engine cannot run.\n"
            "  Set it (Pro tier for lossless 48 kHz) as an env var or GitHub secret:\n"
            "    export ELEVENLABS_API_KEY=...\n"
            "  Refusing to generate low-fi placeholder audio. To force the rejected\n"
            "  offline synth anyway (NOT for shipping), pass --engine placeholder.")
    raise ValueError(f"unknown engine {engine}")


def main():
    ap = argparse.ArgumentParser(description="Run the sounds factory loop.")
    ap.add_argument("--max-units", type=int, default=0, help="0 = unlimited")
    ap.add_argument("--max-minutes", type=float, default=0, help="0 = unlimited")
    ap.add_argument("--once", action="store_true", help="Do a single unit and exit.")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--engine", choices=["auto", "ai", "placeholder"], default="auto",
                    help="auto/ai = AAA ElevenLabs engine (needs ELEVENLABS_API_KEY); "
                         "placeholder = REJECTED offline low-fi synth (never ship).")
    ap.add_argument("--min-credits", type=int, default=None,
                    help="Stop the AI engine when credits fall below this "
                         "(default: budget.min_ai_credits_remaining).")
    args = ap.parse_args()

    cfg = factory.load_config()
    try:
        client = _make_client(args.engine, cfg)
    except NoQualityEngine as e:
        print(f"\n== sounds loop BLOCKED ==\n{e}")
        coordination.publish(
            current="blocked: ELEVENLABS_API_KEY not set (AAA engine unavailable)",
            progress=coordination.progress_snapshot(cfg),
            budget_remaining=None, health="blocked",
            add_notes=["BLOCKED: needs ELEVENLABS_API_KEY (Pro tier, 48 kHz) to "
                       "generate AAA sound. Procedural low-fi was rejected by the "
                       "product owner; the loop refuses to ship placeholder audio."])
        commit_push("sounds heartbeat: blocked (no ELEVENLABS_API_KEY)", push=not args.no_push)
        return
    min_credits = args.min_credits if args.min_credits is not None \
        else cfg["budget"]["min_ai_credits_remaining"]

    # Fleet awareness: read peers and surface any request addressed to us.
    peers = coordination.read_peers()
    print("peers:", coordination.peer_summary(peers))
    for dom, s in peers.items():
        for req in (s.get("requests") or []):
            # Peers write their own status files; tolerate loose shapes (a request
            # may be a bare string, not a {to, text} dict).
            if isinstance(req, dict) and req.get("to") == coordination.DOMAIN:
                print(f"  » request from {dom}: {req.get('text')}")

    engine_name = "AAA ai (elevenlabs SFX v2)" if client is not None \
        else "REJECTED low-fi placeholder (sfxr)"
    print(f"sounds loop starting — engine: {engine_name}")
    coordination.publish(current="startup", progress=coordination.progress_snapshot(cfg),
                         budget_remaining=(client.credits_remaining() if client else None),
                         health="running")

    start = time.monotonic()
    units = 0
    while True:
        if client is not None:
            from elevenlabs_client import BudgetExhausted
            try:
                client.ensure_budget(min_credits)
            except BudgetExhausted as e:
                print(f"stopping: {e}")
                break
        result = advance(client, cfg, push=not args.no_push)
        if result is None:
            print("stopping: nothing left to generate")
            break
        units += 1
        if args.once or (args.max_units and units >= args.max_units):
            break
        if args.max_minutes and (time.monotonic() - start) / 60 >= args.max_minutes:
            print("stopping: time budget reached")
            break

    progress = coordination.progress_snapshot(cfg)
    done = progress["sounds_complete"] >= progress["sounds_target"]
    health = "idle" if done else "running"
    coordination.publish(current=f"idle after {units} unit(s) this pass",
                         progress=progress,
                         budget_remaining=(client.credits_remaining() if client else None),
                         health=health)
    commit_push(f"sounds heartbeat: {health} ({units} unit(s) this pass)", push=not args.no_push)
    print(f"done — {units} unit(s) this pass; {progress['sounds_complete']}/{progress['sounds_target']} complete")


if __name__ == "__main__":
    main()
