"""The sounds factory: resolve a catalog spec -> render audio -> write a detailed
`sound.json` manifest. Two interchangeable engines:

- **procedural** (default, free, offline): sfxr presets in `sfxr.py`, deterministic
  per (preset, seed). Writes a 16-bit mono WAV.
- **ai** (optional, paid): ElevenLabs text-to-SFX (`elevenlabs_client.py`). Writes
  an MP3.

Each sound lives in its own subfolder `sounds/<category>/<id>/` holding the audio
file plus `sound.json` (the contract other agents/games read). The manifest is as
self-describing as possible: what the sound is, how it was made (engine + exact
params or prompt), the audio format, and how a game should use it.
"""

from __future__ import annotations

import hashlib
import json
import os
import random

import sfxr

# sounds/ domain root (this file is sounds/pipeline/factory.py).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config", "sounds.json")

MANIFEST_VERSION = 1
LICENSE = "CC0-1.0"  # procedural output is not copyrightable; AI output per ElevenLabs terms

# Some seeds yield a near-empty envelope (a <30 ms click). For a one-shot SFX we
# want something audible, so `resolve_params` re-rolls the derived seed until the
# estimated length clears this floor (footsteps opt lower via spec.min_duration).
DEFAULT_MIN_DURATION = 0.14
MAX_REROLL = 48


def load_config() -> dict:
    with open(CONFIG_PATH) as f:
        return json.load(f)


def sound_specs(cfg: dict) -> list[dict]:
    """The ordered list of sounds to produce (currently the curated catalog)."""
    return list(cfg.get("catalog", []))


def derive_seed(sound_id: str) -> int:
    """Stable 32-bit seed from the id, so a given sound is reproducible without
    pinning a magic number in the catalog."""
    h = hashlib.sha256(sound_id.encode("utf-8")).hexdigest()
    return int(h[:8], 16)


def sound_dir(spec: dict) -> str:
    return os.path.join(ROOT, spec["category"], spec["id"])


def manifest_path(spec: dict) -> str:
    return os.path.join(sound_dir(spec), "sound.json")


def read_manifest(spec: dict) -> dict | None:
    p = manifest_path(spec)
    if not os.path.exists(p):
        return None
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _audio_exists(spec: dict, man: dict | None) -> bool:
    if not man:
        return False
    rel = man.get("file")
    return bool(rel) and os.path.exists(os.path.join(ROOT, rel))


def has_sound(spec: dict) -> bool:
    """A sound is 'done' when its manifest and the audio it points at both exist."""
    man = read_manifest(spec)
    return _audio_exists(spec, man)


def _estimate_duration(p: sfxr.Params, sample_rate: int = sfxr.SAMPLE_RATE) -> float:
    """Cheap analytic length estimate (sfxr emits one output sample per envelope
    tick, so total length ~ attack+sustain+decay). An upper bound: a frequency
    limit can only cut it shorter — good enough to reject inaudible seeds."""
    ticks = sum(max(1, int(v * v * 100000.0))
                for v in (p.p_env_attack, p.p_env_sustain, p.p_env_decay))
    return ticks / sample_rate


def resolve_params(spec: dict) -> tuple[sfxr.Params, int, str]:
    """Build the sfxr Params for a spec: run its preset with the derived seed and
    apply any explicit `params` overrides. If the result would be inaudibly short,
    re-roll the seed deterministically (base+1, base+2, …) up to MAX_REROLL and
    take the first that clears the duration floor, else the longest candidate.
    Returns (params, seed, preset) — a pure function of the spec, so `regen`
    reproduces it exactly."""
    preset = spec.get("preset", "blipSelect")
    base_seed = int(spec.get("seed", derive_seed(spec["id"])))
    floor = float(spec.get("min_duration", DEFAULT_MIN_DURATION))
    gen = sfxr.PRESETS.get(preset, sfxr.blip_select)
    overrides = spec.get("params") or {}

    best = None  # (params, seed, est) with the longest estimate seen so far
    for i in range(MAX_REROLL):
        seed = base_seed + i
        params = gen(random.Random(seed))
        for k, v in overrides.items():
            if hasattr(params, k):
                setattr(params, k, v)
        est = _estimate_duration(params)
        if est >= floor:
            return params, seed, preset
        if best is None or est > best[2]:
            best = (params, seed, est)
    return best[0], best[1], preset


# --- generation -------------------------------------------------------------

def generate_procedural(cfg: dict, spec: dict) -> dict:
    """Render `spec` with the sfxr engine, write the WAV, return the manifest."""
    params, seed, preset = resolve_params(spec)
    d = sound_dir(spec)
    os.makedirs(d, exist_ok=True)
    fname = f"{spec['id']}.wav"
    stats = sfxr.render_wav(
        params, os.path.join(d, fname),
        sample_rate=cfg["audio"]["sample_rate"],
        peak=cfg["audio"]["peak_normalize"],
    )
    man = _base_manifest(spec, engine="procedural")
    man.update({
        "file": os.path.join(spec["category"], spec["id"], fname),
        "format": "wav",
        "audio": stats,
        "procedural": {
            "family": "sfxr",
            "preset": preset,
            "seed": seed,
            "params": params.to_jsfxr_dict(),
            "reproduce": "python pipeline/regen.py " + spec["id"],
        },
        "source": "procedural sfxr synth (pipeline/sfxr.py) — deterministic per (preset, seed)",
    })
    return man


def generate_ai(client, cfg: dict, spec: dict) -> dict:
    """Render `spec` with the ElevenLabs engine, write the MP3, return the
    manifest. `client` must be an available ElevenLabsClient."""
    ai_cfg = cfg["engine"]["ai"]
    prompt = spec.get("ai_prompt") or spec.get("description")
    audio = client.generate(
        prompt,
        duration_seconds=spec.get("duration_hint"),
        prompt_influence=spec.get("prompt_influence", cfg["defaults"]["prompt_influence"]),
        loop=bool(spec.get("loop", cfg["defaults"]["loop"])),
        model_id=ai_cfg["model_id"],
        output_format=ai_cfg["output_format"],
    )
    d = sound_dir(spec)
    os.makedirs(d, exist_ok=True)
    fname = f"{spec['id']}.mp3"
    with open(os.path.join(d, fname), "wb") as f:
        f.write(audio)
    man = _base_manifest(spec, engine="ai")
    man.update({
        "file": os.path.join(spec["category"], spec["id"], fname),
        "format": "mp3",
        "audio": {
            "bytes": len(audio),
            "output_format": ai_cfg["output_format"],
            "duration_hint_seconds": spec.get("duration_hint"),
        },
        "ai": {
            "provider": ai_cfg["provider"],
            "model_id": ai_cfg["model_id"],
            "prompt": prompt,
            "prompt_influence": spec.get("prompt_influence", cfg["defaults"]["prompt_influence"]),
            "loop": bool(spec.get("loop", cfg["defaults"]["loop"])),
        },
        "source": f"{ai_cfg['provider']} text-to-sound-effects ({ai_cfg['model_id']})",
    })
    return man


def _base_manifest(spec: dict, engine: str) -> dict:
    """The engine-independent metadata block."""
    return {
        "manifest_version": MANIFEST_VERSION,
        "id": spec["id"],
        "name": spec["name"],
        "category": spec["category"],
        "description": spec["description"],
        "tags": spec.get("tags", []),
        "usage": spec.get("usage", ""),
        "loop": bool(spec.get("loop", False)),
        "engine": engine,
        "license": LICENSE,
        "status": "complete",
    }


def generate(client, cfg: dict, spec: dict) -> dict:
    """Generate one sound with the best available engine and write its manifest.
    Uses AI when a client is supplied, else the procedural engine. Returns the
    written manifest."""
    if client is not None:
        man = generate_ai(client, cfg, spec)
    else:
        man = generate_procedural(cfg, spec)
    with open(manifest_path(spec), "w") as f:
        json.dump(man, f, indent=2)
    return man
