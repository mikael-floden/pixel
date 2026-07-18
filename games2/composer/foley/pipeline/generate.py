"""Composer foley pipeline — the composer's OWN generated audio.

Charter (maintainer 2026-07-18): the composer has the SAME generation rights
as the sound/music agents (ELEVENLABS_API_KEY). When the producers' catalog
falls short in-game, the composer regenerates the assets itself inside its
own domain (games2/composer/foley/). Targets so far, both after maintainer
in-game QA: FOOTSTEPS (grass/sand/snow bad, stone/ice okeyish) and the UI
BUTTONS ("sound like a piano and not like buttons" — the ui_* sets are
tactile mechanical clicks by construction).

One run generates every requested set's takes, masters them (tight trim,
de-click fades, -1 dBFS peak — same recipe as the sound domain), and writes
`foley/foley.json`. The client bundles the WAVs via Vite import.meta.glob
(engine/foley.ts) — no server/asset-route changes needed.

Requires ELEVENLABS_API_KEY (Actions secret or local env). Self-contained on
purpose: domains keep their own pipeline copies (repo convention).

    python games2/composer/foley/pipeline/generate.py              # all sets
    python games2/composer/foley/pipeline/generate.py grass ui_tick # a subset
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import time
import wave
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

FOLEY_DIR = Path(__file__).resolve().parent.parent
GEN_URL = "https://api.elevenlabs.io/v1/sound-generation"
MODEL_ID = "eleven_text_to_sound_v2"
SR = 48000
TAKES = 4
PROMPT_INFLUENCE = 0.45

# Catalog-wide production directives — precise prompts are what separate
# production foley from a vague approximation (sounds/README.md lesson).
STYLE = (
    "high-fidelity close-miked foley recording, dry studio, single isolated "
    "sound effect, realistic, professional game audio, no music, no voice, "
    "no room reverb, no background noise"
)

# Take-to-take articulation so four generations read as natural variation of
# ONE source (one walker, one button), not four unrelated sounds.
GAIT_VARIANTS = [
    "heel-first, medium weight",
    "flat-footed, slightly lighter",
    "toe-first, soft settle",
    "medium weight, slightly faster",
]
PRESS_VARIANTS = [
    "standard press",
    "slightly softer press",
    "slightly firmer press",
    "slightly quicker press",
]

# Each SET is one folder under foley/. Footstep set names match
# shared/SURFACES `sound` ids exactly; ui_* sets override the catalog's UI
# event sounds (engine/api.ts COMPOSER_EVENT_FOLEY). Maintainer QA
# 2026-07-18: the catalog UI clicks "sound like a piano, not like buttons"
# — these briefs are TACTILE by construction (and say so out loud, because
# the model loves drifting musical).
SETS: dict[str, dict] = {
    # ROUND 2 (maintainer QA 2026-07-18: black_mountain = the STONE set is
    # the good one; the rest "still not good enough"). What stone got right:
    # a COMPACT DISCRETE IMPACT — its takes trimmed to varied tight lengths,
    # while every disliked set sat at the full clip length (continuous
    # rustle/crunch texture instead of one step). Round-2 briefs copy stone's
    # "one compact impact + tiny character tail" formula, and max_ms
    # transient-tightening enforces it in post regardless of model rambling.
    "grass": {
        "brief": (
            "one single compact footstep on short dry grass: a firm boot impact "
            "thud with a brief crisp blade rustle only at the moment of impact, "
            "tight and dry, exactly one step, no walking sequence, no ambience, "
            "no wind, no birds"
        ),
        "duration_s": 0.6,
        "variants": GAIT_VARIANTS,
        "max_ms": 600,
        "judge": "step",
        "pool": 9,
    },
    "sand": {
        "brief": (
            "one single compact footstep on loose dry sand: a short gritty "
            "crunch as the boot compresses the sand, tight and dry, exactly one "
            "step, no walking sequence, no ambience, no wind"
        ),
        "duration_s": 0.6,
        "variants": GAIT_VARIANTS,
        "max_ms": 600,
        "judge": "step",
        "pool": 9,
    },
    "snow": {
        "brief": (
            "one single compact footstep in dry powder snow: a short muffled "
            "crunch of snow compacting under a boot, tight, exactly one step, "
            "no walking sequence, no ambience, no wind"
        ),
        "duration_s": 0.6,
        "variants": GAIT_VARIANTS,
        "max_ms": 600,
        "judge": "step",
        "pool": 9,
    },
    # LIKED (black_mountain verdict) — recipe frozen, do not regenerate
    # casually; if it ever must rerun, keep this brief verbatim.
    "stone": {
        "brief": (
            "a single footstep on a flat stone paving slab: a hard leather boot "
            "heel striking dense rock, compact dry tap with a faint grit scuff"
        ),
        "duration_s": 0.8,
        "variants": GAIT_VARIANTS,
    },
    "ice": {
        "brief": (
            "one single compact footstep on solid frozen ice: a hard boot tap "
            "like on stone with a brief thin glassy crackle, tight and dry, "
            "exactly one step, no walking sequence, no ambience"
        ),
        "duration_s": 0.6,
        "variants": GAIT_VARIANTS,
        "max_ms": 600,
        "judge": "step",
        "pool": 9,
    },
    "wood": {
        "brief": (
            "one single compact footstep on a thick wooden plank: a boot heel "
            "knock, hard like a tap on stone but hollow and woody, tight and "
            "dry, exactly one step, no walking sequence, no ambience"
        ),
        "duration_s": 0.6,
        "variants": GAIT_VARIANTS,
        "max_ms": 600,
        "judge": "step",
        "pool": 9,
    },
    "dirt": {
        "brief": (
            "one single compact footstep on hard-packed dry dirt: a dull firm "
            "boot thud with a tiny grit scuff, tight and dry, exactly one step, "
            "no walking sequence, no ambience"
        ),
        "duration_s": 0.6,
        "variants": GAIT_VARIANTS,
        "max_ms": 600,
        "judge": "step",
        "pool": 9,
    },
    "swamp": {
        "brief": (
            "one single compact squelching footstep in shallow mud: a short wet "
            "sucking squish of one boot press, tight, exactly one step, no "
            "walking sequence, no ambience, no water stream"
        ),
        "duration_s": 0.6,
        "variants": GAIT_VARIANTS,
        "max_ms": 700,
        "judge": "step",
        "pool": 9,
    },
    # Wet footstep for water TRANSITIONS (maintainer 2026-07-18): played on
    # the land->water and water->land edges (entering heavier, leaving
    # lighter — level only, same recording).
    "water_step": {
        "brief": (
            "one single wet splashing footstep in ankle-deep water at a lake "
            "edge: a boot plunging into shallow still water, one short clean "
            "splosh with a few small droplets right after, tight, exactly one "
            "step, no stream, no flowing water, no rain, no ambience"
        ),
        "duration_s": 0.7,
        "variants": GAIT_VARIANTS,
        "max_ms": 700,
        "judge": "step",
        "pool": 9,
    },
    # ---- world/weather (real sources, not disguises: the maintainer heard
    # straight through the slowed-explosion "thunder") ----
    # LIKED (maintainer 2026-07-18, once playback was synced to the flash
    # and levelled up) — FROZEN like stone; keep this brief verbatim if it
    # ever must rerun. NOTE the measured caveat for future big sounds: these
    # takes are ~100% sub-150 Hz (mid_peak_db very low) — inaudible on the
    # smallest speakers; the `boom` gate exists for when that matters.
    "thunder": {
        "brief": (
            "distant rolling thunder from a storm beyond the horizon: a deep "
            "natural low-frequency rumble rolling and echoing across a wide "
            "open valley sky, real outdoor storm recording, no rain, no wind"
        ),
        "duration_s": 6.0,
        "takes": 4,
        "variants": [
            "one long slow roll fading out",
            "a double rumble with a late soft tail",
            "slightly closer, a low crack then a long roll",
            "very far away, soft and very deep",
        ],
    },
    # ---- UI buttons. ROUND 3: "wooden button" briefs FAILED twice — wood
    # resonates, resonance is pitch, pitch reads as piano. The mechanisms
    # are now explicitly NON-RESONANT (switches, latches, mouse/keyboard),
    # and the strict `click` tonality gate auto-rejects any candidate that
    # rings — the pipeline can no longer ship a piano even if the model
    # produces one. ----
    "ui_tick": {
        "brief": (
            "a tiny dry mechanical click of a small plastic button, like a "
            "single quiet mouse click, one instant snap, no resonance, no "
            "ring, no echo, NOT musical, no chime, no piano, no tone, no "
            "wooden knock"
        ),
        "duration_s": 0.5,  # API minimum — 0.4 got a 400 (run 2)
        "variants": PRESS_VARIANTS,
        "max_ms": 250,
        "judge": "click",
        "pool": 9,
    },
    "ui_confirm": {
        "brief": (
            "a chunky mechanical latch click of a sturdy switch snapping on, "
            "like a heavy mechanical keyboard thock, one instant dry clack, "
            "no resonance, no ring, no echo, NOT musical, no chime, no "
            "piano, no tone, no wooden knock"
        ),
        "duration_s": 0.5,
        "variants": PRESS_VARIANTS,
        "max_ms": 350,
        "judge": "click",
        "pool": 9,
    },
    "ui_cancel": {
        "brief": (
            # Reworded (the previous "switch snapping off" phrasing hit an
            # unde codable API response twice in a row — set-specific).
            "a soft dull mechanical click of a button being released, lower "
            "and duller than a press click, one instant dry click, no "
            "resonance, no ring, no echo, NOT musical, no chime, no piano, "
            "no tone, no wooden knock"
        ),
        "duration_s": 0.5,
        "variants": PRESS_VARIANTS,
        "max_ms": 350,
        "judge": "click",
        "pool": 9,
    },
}


# ---- minimal decode + mastering (port of the sound domain's recipe) ----

def _ffmpeg_decode(raw: bytes) -> np.ndarray:
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg needed to decode compressed audio")
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(SR),
         "-f", "s16le", "pipe:1"],
        input=raw, capture_output=True,
    )
    if p.returncode != 0:
        # Surface WHAT the API actually sent (ui_cancel failed twice on a
        # payload ffmpeg rejects — the head bytes identify json errors etc).
        raise RuntimeError(
            f"ffmpeg decode failed (rc={p.returncode}, {len(raw)} bytes, "
            f"head={raw[:60]!r}, stderr={p.stderr[:120]!r})"
        )
    return np.frombuffer(p.stdout, dtype="<i2").astype(np.float32) / 32768.0


def _decode(raw: bytes, fmt: str) -> np.ndarray:
    # SNIFF the actual payload — never trust the requested format. Run 2
    # requested pcm_48000 in the BODY (the API wants it as a query param),
    # got mp3 back, and the byte-blind pcm decode turned every take into
    # identical-length garbage noise. Container magic wins over `fmt`.
    is_mp3 = raw[:3] == b"ID3" or (len(raw) > 1 and raw[0] == 0xFF and (raw[1] & 0xE0) == 0xE0)
    if raw[:4] == b"RIFF" or is_mp3:
        x = _ffmpeg_decode(raw)
    elif fmt.startswith("pcm_"):
        x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    else:
        x = _ffmpeg_decode(raw)
    if x.size < SR * 0.05:
        raise RuntimeError(f"decoded audio too short ({x.size} samples) — bad payload?")
    return x


def _features(x: np.ndarray) -> dict:
    """Objective QA features (round 3: the composer can't listen, so it
    MEASURES). tonality = normalized autocorrelation peak in the 80-2000 Hz
    pitch band over 250ms after the main peak — a piano-like ring scores
    high, real foley scores low. tail_ratio = energy after 400ms / total —
    a texture bed scores high, a discrete impact scores low."""
    n = x.size
    ax = np.abs(x)
    peak = float(np.max(ax)) or 1e-9
    rms = float(np.sqrt(np.mean(x ** 2))) or 1e-9
    peak_idx = int(np.argmax(ax))
    i400 = int(SR * 0.4)
    tail_ratio = float(np.sum(x[i400:] ** 2) / (np.sum(x ** 2) + 1e-12)) if n > i400 else 0.0
    seg = x[peak_idx : peak_idx + int(SR * 0.25)].astype(np.float64)
    tonality = 0.0
    if seg.size > int(SR / 80):
        seg = seg - seg.mean()
        f = np.fft.rfft(seg, 2 * seg.size)
        ac = np.fft.irfft(f * np.conj(f))[: seg.size]
        if ac[0] > 0:
            lo, hi = int(SR / 2000), min(int(SR / 80), seg.size - 1)
            if hi > lo + 1:
                tonality = float(np.max(ac[lo:hi]) / ac[0])
    spec = np.abs(np.fft.rfft(x))
    freqs = np.fft.rfftfreq(n, 1 / SR)
    centroid = float(np.sum(spec * freqs) / (np.sum(spec) + 1e-12))
    # Small-speaker audibility: the first thunder set measured 100% of its
    # energy BELOW 150 Hz — physically silent on phone/laptop speakers at
    # any gain (maintainer heard rain, never thunder). Whole-clip energy
    # fraction misjudges a short crack against a long roll, so measure the
    # LOUDEST 300ms of the 150-4000 Hz band instead: was there ever a
    # moment a small speaker could reproduce?
    power = spec ** 2
    mid = float(np.sum(power[(freqs >= 150) & (freqs < 4000)]) / (np.sum(power) + 1e-12))
    fspec = np.fft.rfft(x)
    fspec[(freqs < 150) | (freqs >= 4000)] = 0
    band = np.fft.irfft(fspec, n)
    win = max(1, int(SR * 0.3))
    csum = np.concatenate(([0.0], np.cumsum(band.astype(np.float64) ** 2)))
    win_rms = np.sqrt(np.max(csum[win:] - csum[:-win]) / win) if n > win else float(np.sqrt(np.mean(band ** 2)))
    mid_peak_db = 20 * np.log10(max(win_rms, 1e-9))
    return {
        "mid_peak_db": round(float(mid_peak_db), 1),
        "duration_s": round(n / SR, 3),
        "attack_ms": round(peak_idx / SR * 1000, 1),
        "tail_ratio": round(tail_ratio, 3),
        "tonality": round(tonality, 3),
        "crest": round(peak / rms, 2),
        "centroid_hz": round(centroid),
        "mid_ratio": round(mid, 3),
    }


# Acceptance gates per judge kind: {feature: (min, max, penalty_weight)}.
# CALIBRATED ON THE HUMAN-APPROVED REFERENCE: all four liked stone takes
# must PASS the step gates (measured tonality up to 0.93 — a hard tap on
# rock IS slightly pitched, and the maintainer likes it; the enemy of a
# footstep is the texture BED: high tail_ratio, low crest). For clicks the
# enemy IS tonality ("piano"), so the gate kills flagrant ring and the
# ranking prefers the least tonal candidate.
GATES: dict[str, dict[str, tuple[float, float, float]]] = {
    "step": {
        "tail_ratio": (0.0, 0.30, 40),
        "crest": (6.0, 99.0, 2),
        "tonality": (0.0, 0.95, 30),
    },
    "click": {
        "tonality": (0.0, 0.40, 60),
        "tail_ratio": (0.0, 0.15, 40),
        "crest": (5.0, 99.0, 2),
    },
    # Big atmospheric booms (thunder): MUST carry small-speaker-audible
    # mid-band energy, and the crack should land promptly (synced to the
    # lightning flash).
    "boom": {
        "mid_peak_db": (-28.0, 0.0, 3),
        "crest": (2.5, 99.0, 1),
    },
}

# Ranking among candidates (lower = better), per judge kind. Steps rank by
# dryness — NOT by low tonality, or crisp liked-style toks would lose to
# mushy thuds. Clicks rank hard by low tonality: the anti-piano selector.
RANK = {
    "step": lambda f: f["tail_ratio"] * 5 + f["tonality"] * 1,
    "click": lambda f: f["tonality"] * 10 + f["tail_ratio"] * 5,
    # Booms: strongest audible mid-band moment wins; early peak preferred
    # (the crack must land with the flash).
    "boom": lambda f: -f["mid_peak_db"] * 0.2 + f["attack_ms"] / 500,
}


def _judge(feat: dict, gates: dict[str, tuple[float, float, float]], kind: str) -> tuple[bool, float]:
    ok = True
    penalty = 0.0
    for key, (lo, hi, w) in gates.items():
        v = feat[key]
        if v < lo:
            ok = False
            penalty += (lo - v) * w
        elif v > hi:
            ok = False
            penalty += (v - hi) * w
    return ok, penalty + RANK[kind](feat)


def _tighten(x: np.ndarray, max_ms: float | None) -> np.ndarray:
    """Transient-anchored cut: keep from just before the strongest onset to
    max_ms after it. Round 2's enforcement of the stone-set lesson — a
    footstep is ONE discrete impact; if the model pads the clip with
    continuous texture, cut the step out of it instead of shipping the bed."""
    if max_ms is None or x.size == 0:
        return x
    # Anchor on the strongest peak with a short fixed pre-roll — threshold
    # onset-hunting latches onto the background texture floor instead.
    peak_idx = int(np.argmax(np.abs(x)))
    start = max(0, peak_idx - int(SR * 0.030))
    end = min(x.size, start + int(SR * max_ms / 1000))
    return x[start:end]


def _master(x: np.ndarray) -> np.ndarray:
    if x.size == 0:
        return x
    peak = float(np.max(np.abs(x))) or 1.0
    lead = np.where(np.abs(x) >= peak * 10 ** (-45 / 20))[0]
    tail = np.where(np.abs(x) >= peak * 10 ** (-60 / 20))[0]
    if lead.size and tail.size:
        x = x[max(0, lead[0] - int(SR * 0.006)):min(x.size, tail[-1] + int(SR * 0.04) + 1)]
    n_in = min(int(SR * 0.003), x.size // 2)
    n_out = min(int(SR * 0.015), x.size // 2)
    x = x.copy()
    if n_in:
        x[:n_in] *= np.sin(np.linspace(0, np.pi / 2, n_in)) ** 2
    if n_out:
        x[-n_out:] *= np.cos(np.linspace(0, np.pi / 2, n_out)) ** 2
    peak = float(np.max(np.abs(x))) or 1.0
    return np.clip(x * (10 ** (-1 / 20) / peak), -1.0, 1.0)


def _write_wav(x: np.ndarray, path: Path) -> float:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(np.int16(x * 32767).tobytes())
    return round(x.size / SR, 3)


def _generate(session: requests.Session, prompt: str, duration_s: float) -> np.ndarray:
    # Lossless first (Pro tier); compressed fallback keeps free tiers
    # working. output_format goes in the QUERY STRING — in the body the API
    # silently ignores it and returns mp3 (run 2's garbage-audio bug).
    duration_s = max(0.5, min(22.0, duration_s))  # API-enforced bounds; 0.4 → 400
    for fmt in (f"pcm_{SR}", "mp3_44100_128"):
        r = session.post(
            GEN_URL,
            params={"output_format": fmt},
            json={
                "text": prompt,
                "duration_seconds": duration_s,
                "prompt_influence": PROMPT_INFLUENCE,
                "loop": False,
                "model_id": MODEL_ID,
            },
            timeout=120,
        )
        if r.ok:
            return _decode(r.content, fmt)
        if r.status_code not in (400, 402, 403):  # format/tier issues → fallback
            r.raise_for_status()
    r.raise_for_status()
    raise RuntimeError("unreachable")


def main() -> int:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        print("ELEVENLABS_API_KEY not set — refusing to run (no low-fi fallbacks).")
        return 1
    wanted = sys.argv[1:] or list(SETS)
    session = requests.Session()
    session.headers.update({"xi-api-key": key})

    manifest_path = FOLEY_DIR / "foley.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    done: list[str] = []
    failed: list[str] = []
    for name in wanted:
        spec = SETS.get(name)
        if not spec:
            print(f"unknown set {name!r} (have: {', '.join(SETS)})")
            continue
        # One bad set must not zero out the whole run (run 2: ui_tick's 400
        # threw away nine already-generated sets) — isolate per set, commit
        # whatever succeeded.
        try:
            out_dir = FOLEY_DIR / name
            out_dir.mkdir(parents=True, exist_ok=True)
            variants = spec["variants"]
            n_takes = spec.get("takes", TAKES)
            # Round 3: generate a candidate POOL, measure every candidate,
            # ship only the best n_takes. Blind generation → selection.
            pool_n = max(n_takes, spec.get("pool", n_takes))
            gates = GATES.get(spec.get("judge", ""))
            cands: list[tuple[bool, float, np.ndarray, dict]] = []
            for i in range(pool_n):
                prompt = f"{spec['brief']}, {variants[i % len(variants)]}. {STYLE}"
                # Candidate-level isolation: one corrupt payload must not
                # kill the whole set (ui_cancel died twice on candidate 1).
                try:
                    x = _master(_tighten(_generate(session, prompt, spec["duration_s"]), spec.get("max_ms")))
                except Exception as ce:  # noqa: BLE001
                    print(f"{name} cand {i + 1}/{pool_n}: GENERATION FAILED — {ce}")
                    time.sleep(0.6)
                    continue
                feat = _features(x)
                ok, score = _judge(feat, gates, spec["judge"]) if gates else (True, 0.0)
                cands.append((ok, score, x, feat))
                print(f"{name} cand {i + 1}/{pool_n}: {'PASS ' if ok else 'REJECT'} {feat}")
                time.sleep(0.4)  # be polite to the API
            if not cands:
                raise RuntimeError("every candidate failed to generate")
            cands.sort(key=lambda c: (not c[0], c[1]))
            chosen = cands[:n_takes]
            passed = sum(1 for c in chosen if c[0])
            if passed < n_takes:
                print(f"  WARNING: only {passed}/{n_takes} shipped takes pass the {spec.get('judge')} gates")
            takes = []
            for i, (_ok, _score, x, feat) in enumerate(chosen):
                path = out_dir / f"{name}__take{i + 1:02d}.wav"
                dur = _write_wav(x, path)
                takes.append({"file": f"{name}/{path.name}", "duration_seconds": dur, "features": feat})
            # Keep the WHOLE pool (sorted best-first) for the human audition
            # page (/#foley): the maintainer listens and names winners, the
            # composer promotes them — measurable gates can't judge material
            # realism, ears can.
            pool_meta = []
            if pool_n > n_takes:
                pool_dir = out_dir / "pool"
                pool_dir.mkdir(exist_ok=True)
                for old in pool_dir.glob("*.wav"):
                    old.unlink()
                for j, (ok_j, score_j, x_j, feat_j) in enumerate(cands):
                    ppath = pool_dir / f"{name}__cand{j + 1:02d}.wav"
                    _write_wav(x_j, ppath)
                    pool_meta.append({
                        "file": f"{name}/pool/{ppath.name}",
                        "passed_gates": ok_j,
                        "rank": round(score_j, 2),
                        "features": feat_j,
                    })
            manifest[name] = {
                "takes": [t["file"] for t in takes],
                "durations_s": [t["duration_seconds"] for t in takes],
                "features": [t["features"] for t in takes],
                "qa": {"judge": spec.get("judge"), "pool": pool_n, "passed_gates": passed, "of": n_takes},
                "pool_candidates": pool_meta,
                "brief": spec["brief"],
                "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "model_id": MODEL_ID,
            }
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
            done.append(name)
        except Exception as e:  # noqa: BLE001 — isolate, report, continue
            print(f"FAILED set {name}: {e}")
            failed.append(name)
    print(f"generated: {', '.join(done) or 'none'}; failed: {', '.join(failed) or 'none'}")
    print(f"manifest → {manifest_path}")
    return 0 if done else 1


if __name__ == "__main__":
    raise SystemExit(main())
