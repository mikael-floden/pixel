"""Composer foley pipeline — the composer's OWN generated audio.

Charter (maintainer 2026-07-18): the composer has the SAME generation rights
as the sound/music agents (ELEVENLABS_API_KEY). When the producers' catalog
falls short in-game, the composer regenerates the assets itself inside its
own domain (games2/composer/foley/). First target: FOOTSTEPS — the single
most-heard sound in the game — after the maintainer's QA verdicts on the
catalog sets (grass bad, sand bad, snow bad, stone/ice only okeyish).

One run generates every surface's takes, masters them (tight trim, de-click
fades, -1 dBFS peak — same recipe as the sound domain), and writes
`foley/foley.json`. The client bundles the WAVs via Vite import.meta.glob
(engine/foley.ts) — no server/asset-route changes needed.

Requires ELEVENLABS_API_KEY (Actions secret or local env). Self-contained on
purpose: domains keep their own pipeline copies (repo convention).

    python games2/composer/foley/pipeline/generate.py            # all surfaces
    python games2/composer/foley/pipeline/generate.py grass snow # a subset
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

# Take-to-take articulation so four generations read as one walker's
# natural variation, not four unrelated sounds.
ARTICULATIONS = [
    "heel-first, medium weight",
    "flat-footed, slightly lighter",
    "toe-first, soft settle",
    "medium weight, slightly faster",
]

# Per-surface briefs: material + mechanism + character. Surface keys match
# shared/SURFACES `sound` ids exactly.
BRIEFS: dict[str, str] = {
    "grass": (
        "a single footstep on dry meadow grass: a leather boot pressing into "
        "springy turf, light crisp rustle of grass blades over a soft earthy "
        "thud"
    ),
    "sand": (
        "a single footstep on loose dry sand: granular gritty crunch as the "
        "boot heel compresses the sand, with a fine short sandy slide as the "
        "foot settles"
    ),
    "snow": (
        "a single footstep in fresh dry powder snow: a clean muffled crunch "
        "of snow crystals compacting under a heavy winter boot"
    ),
    "stone": (
        "a single footstep on a flat stone paving slab: a hard leather boot "
        "heel striking dense rock, compact dry tap with a faint grit scuff"
    ),
    "ice": (
        "a single careful footstep on solid frozen lake ice: a hard boot tap "
        "with a thin glassy crackle and a very short slick slide"
    ),
    "wood": (
        "a single footstep on thick wooden planks: a boot heel landing on a "
        "timber balcony with a warm, slightly hollow knock"
    ),
    "dirt": (
        "a single footstep on packed dry dirt: a dull earthy thud of a boot "
        "on compacted soil with a tiny gravelly scuff"
    ),
    "swamp": (
        "a single squelching footstep in shallow bog mud: a wet sucking "
        "squish as a boot presses into soft marsh ground"
    ),
}


# ---- minimal decode + mastering (port of the sound domain's recipe) ----

def _decode(raw: bytes, fmt: str) -> np.ndarray:
    if fmt.startswith("pcm_"):
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg needed to decode compressed audio")
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(SR),
         "-f", "s16le", "pipe:1"],
        input=raw, capture_output=True, check=True,
    )
    return np.frombuffer(p.stdout, dtype="<i2").astype(np.float32) / 32768.0


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


def _generate(session: requests.Session, prompt: str) -> np.ndarray:
    # Lossless first (Pro tier); compressed fallback keeps free tiers working.
    for fmt in (f"pcm_{SR}", "mp3_44100_128"):
        r = session.post(
            GEN_URL,
            json={
                "text": prompt,
                "duration_seconds": 0.8,
                "prompt_influence": PROMPT_INFLUENCE,
                "loop": False,
                "model_id": MODEL_ID,
                "output_format": fmt,
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
    wanted = sys.argv[1:] or list(BRIEFS)
    session = requests.Session()
    session.headers.update({"xi-api-key": key})

    manifest_path = FOLEY_DIR / "foley.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for surface in wanted:
        brief = BRIEFS.get(surface)
        if not brief:
            print(f"unknown surface {surface!r} (have: {', '.join(BRIEFS)})")
            continue
        out_dir = FOLEY_DIR / surface
        out_dir.mkdir(parents=True, exist_ok=True)
        takes = []
        for i in range(TAKES):
            prompt = f"{brief}, {ARTICULATIONS[i % len(ARTICULATIONS)]}. {STYLE}"
            x = _master(_generate(session, prompt))
            path = out_dir / f"{surface}__take{i + 1:02d}.wav"
            dur = _write_wav(x, path)
            takes.append({"file": f"{surface}/{path.name}", "duration_seconds": dur})
            print(f"{surface} take {i + 1}/{TAKES}: {dur}s")
            time.sleep(0.5)  # be polite to the API
        manifest[surface] = {
            "takes": [t["file"] for t in takes],
            "durations_s": [t["duration_seconds"] for t in takes],
            "brief": brief,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "model_id": MODEL_ID,
        }
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"manifest → {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
