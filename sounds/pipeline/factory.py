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

import postprocess
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
    man = _base_manifest(spec, engine="procedural", cfg=cfg)
    man.update({
        "quality": "rejected-lowfi",
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


def build_prompt(cfg: dict, spec: dict) -> str:
    """Compose the full foley brief sent to the model: the sound's own AAA prompt,
    plus the catalog-wide production directives (fidelity, dryness, exclusions).
    A precise, material-rich brief is what separates production-ready foley from a
    vague approximation."""
    parts = [spec.get("ai_prompt") or spec["description"]]
    directives = cfg["engine"]["ai"].get("prompt_directives")
    if directives:
        parts.append(directives)
    return ". ".join(p.strip().rstrip(".") for p in parts if p) + "."


def generate_ai(client, cfg: dict, spec: dict) -> dict:
    """Render `spec` with ElevenLabs SFX (the quality engine): request lossless
    48 kHz PCM, wrap → WAV, master (trim/normalize/fade), and — for `variants` > 1
    — keep every take so a human can pick the best, with take 1 as the primary.
    Writes a quality-rich manifest. `client` must be an available ElevenLabsClient."""
    ai_cfg = cfg["engine"]["ai"]
    req_fmt = ai_cfg["output_format"]
    prompt = build_prompt(cfg, spec)
    influence = spec.get("prompt_influence", cfg["defaults"]["prompt_influence"])
    loop = bool(spec.get("loop", cfg["defaults"]["loop"]))
    n = max(1, int(spec.get("variants", cfg["defaults"].get("variants", 1))))

    d = sound_dir(spec)
    os.makedirs(d, exist_ok=True)

    takes = []
    primary_file = primary_stats = None
    out_fmt = req_fmt
    for i in range(1, n + 1):
        audio, out_fmt = client.generate_best(
            prompt, primary_format=out_fmt, duration_seconds=spec.get("duration_hint"),
            prompt_influence=influence, loop=loop, model_id=ai_cfg["model_id"],
        )
        _, sr_hint = client.parse_format(out_fmt)  # rate hint for headerless PCM only
        # Decode by ACTUAL content (the API may return MP3 even for a PCM request),
        # then master to a clean 48 kHz WAV. Only if decoding is impossible (no
        # ffmpeg) do we store the compressed bytes verbatim.
        try:
            samples, real_sr = postprocess.decode_audio(audio, sr_hint)
            samples = postprocess.master(samples, real_sr,
                                         fade_out_ms=40.0 if loop else 15.0)
            fname = f"{spec['id']}.wav" if n == 1 else f"{spec['id']}__take{i:02d}.wav"
            stats = postprocess.write_wav(samples, os.path.join(d, fname), real_sr)
            stats["requested_format"] = req_fmt
            stats["delivered"] = postprocess._sniff(audio)
        except RuntimeError as e:
            container = postprocess._sniff(audio)
            ext = container if container in ("mp3", "ogg", "flac", "wav") else "bin"
            print(f"  ! decode failed ({e}); storing {ext} verbatim", flush=True)
            fname = f"{spec['id']}.{ext}" if n == 1 else f"{spec['id']}__take{i:02d}.{ext}"
            with open(os.path.join(d, fname), "wb") as f:
                f.write(audio)
            stats = {"bytes": len(audio), "requested_format": req_fmt, "delivered": container}
        rel = os.path.join(spec["category"], spec["id"], fname)
        takes.append(rel)
        if primary_file is None:
            primary_file, primary_stats = rel, stats

    fmt = os.path.splitext(primary_file)[1].lstrip(".")
    mastered = fmt == "wav"
    man = _base_manifest(spec, engine="ai", cfg=cfg)
    man.update({
        "quality": "aaa",
        "file": primary_file,
        "format": fmt,
        "audio": primary_stats,
        "takes": takes,
        "ai": {
            "provider": ai_cfg["provider"],
            "model_id": ai_cfg["model_id"],
            "prompt": prompt,
            "prompt_influence": influence,
            "loop": loop,
            "variants": n,
            "requested_format": req_fmt,
        },
        "mastering": ("trim + peak-normalize(-1 dBFS) + edge-fades" if mastered
                      else "none (stored compressed; ffmpeg unavailable to master)"),
        "source": f"{ai_cfg['provider']} text-to-sound-effects ({ai_cfg['model_id']})",
    })
    return man


def sound_mix_variation(cfg: dict, spec: dict) -> tuple[float, dict]:
    """The game-facing mix gain (per-category trim, dB) and the anti-repetition
    variation contract (per-sound override, else catalog default) for a spec."""
    gain = (cfg.get("mix", {}).get("category_gain_db", {})).get(spec["category"], 0.0)
    variation = spec.get("variation") or cfg.get("defaults", {}).get("variation", {})
    return gain, variation


def _base_manifest(spec: dict, engine: str, cfg: dict | None = None) -> dict:
    """The engine-independent metadata block, incl. the design-craft fields the
    game consumes: `feel` (emotional intent), `mix_gain_db` (balance vs music), and
    `variation` (round-robin + jitter so repeating sounds don't feel looped)."""
    man = {
        "manifest_version": MANIFEST_VERSION,
        "id": spec["id"],
        "name": spec["name"],
        "category": spec["category"],
        "description": spec["description"],
        "feel": spec.get("feel", ""),
        "tags": spec.get("tags", []),
        "usage": spec.get("usage", ""),
        "loop": bool(spec.get("loop", False)),
        "engine": engine,
        "license": LICENSE,
        "status": "complete",
    }
    if cfg is not None:
        gain, variation = sound_mix_variation(cfg, spec)
        man["mix_gain_db"] = gain
        man["variation"] = variation
    return man


def generate(client, cfg: dict, spec: dict) -> dict:
    """Generate one sound and write its manifest. With an ElevenLabs client this
    produces the AAA-quality AI take; with `client=None` it falls back to the
    REJECTED low-fi procedural placeholder (explicit opt-in only — never shipped
    as the real asset). Returns the written manifest."""
    if client is not None:
        man = generate_ai(client, cfg, spec)
    else:
        man = generate_procedural(cfg, spec)
    with open(manifest_path(spec), "w") as f:
        json.dump(man, f, indent=2)
    return man
