"""Compose one track: plan -> compose -> decode -> master -> analyze -> metadata.

The output contract is `music/<id>/`:

    <id>.wav            mastered 16-bit 44.1 kHz audio (or <id>.mp3 when only a
                        lossy container could be produced/decoded)
    metadata.json       the full sub-second description of the track — see
                        music/README.md for the schema. THIS is the deliverable
                        that makes the audio usable: the game reads it to sync
                        effects, transitions and pitched SFX without ever
                        "listening" to the file.

Decode note: the API may deliver a different container than requested (with a
200), so we sniff actual bytes: RIFF/WAV, MP3 (ID3 or frame sync), else raw
s16le PCM. Raw PCM's channel count is inferred from the expected duration
(composition-plan total), since a headerless stream carries no layout.
MP3 is decoded through ffmpeg when present; without ffmpeg the track still
ships, with plan-derived timing and `analysis: null` (honestly marked).
"""

from __future__ import annotations

import datetime
import io
import json
import os
import shutil
import subprocess
import tempfile
import wave

import numpy as np

from analyze import analyze, to_mono
from elevenlabs_music_client import (ElevenLabsMusicClient, PlanUnavailable,
                                     plan_sections)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # music/

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MODE_STEPS = {
    "major":      [0, 2, 4, 5, 7, 9, 11],
    "minor":      [0, 2, 3, 5, 7, 8, 10],
    "dorian":     [0, 2, 3, 5, 7, 9, 10],
    "mixolydian": [0, 2, 4, 5, 7, 9, 10],
    "lydian":     [0, 2, 4, 6, 7, 9, 11],
}
# Scale degrees (0-based) that are safest for pitching arbitrary SFX into the
# key: the pentatonic subset — no semitone clashes against the harmony.
PENTATONIC_DEGREES = {"major": [0, 1, 2, 4, 5], "minor": [0, 2, 3, 4, 6],
                      "dorian": [0, 2, 3, 4, 6], "mixolydian": [0, 1, 2, 4, 5],
                      "lydian": [0, 1, 2, 4, 5]}


def load_config() -> dict:
    with open(os.path.join(ROOT, "config", "music.json")) as f:
        return json.load(f)


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- audio bytes

def sniff_container(b: bytes) -> str:
    if b[:4] == b"RIFF":
        return "wav"
    if b[:3] == b"ID3" or (len(b) > 1 and b[0] == 0xFF and (b[1] & 0xE0) == 0xE0):
        return "mp3"
    return "pcm"


def decode_wav(b: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(b)) as w:
        sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw != 2:
        raise ValueError(f"unsupported WAV sample width {sw}")
    y = np.frombuffer(raw, dtype="<i2").reshape(-1, ch)
    return y, sr


def decode_pcm(b: bytes, sr: int, expected_s: float | None) -> np.ndarray:
    """Raw s16le -> (n, ch). Channel count inferred from expected duration
    (stereo assumed when there is nothing to compare against — music_v1's
    native delivery is stereo)."""
    y = np.frombuffer(b[: len(b) // 2 * 2], dtype="<i2")
    ch = 2
    if expected_s and expected_s > 0:
        ch = min(2, max(1, round(len(y) / (sr * expected_s))))
    return y[: len(y) // ch * ch].reshape(-1, ch)


def decode_mp3_via_ffmpeg(b: bytes) -> tuple[np.ndarray, int] | None:
    if not shutil.which("ffmpeg"):
        return None
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(b)
        src = f.name
    dst = src + ".wav"
    try:
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src,
                        "-acodec", "pcm_s16le", dst], check=True, timeout=300)
        with open(dst, "rb") as f:
            return decode_wav(f.read())
    except (subprocess.SubprocessError, OSError, ValueError):
        return None
    finally:
        for p in (src, dst):
            try:
                os.unlink(p)
            except OSError:
                pass


def master(y: np.ndarray, sr: int, peak_target_dbfs: float = -1.0,
           edge_fade_ms: float = 15.0) -> np.ndarray:
    """Peak-normalize + de-click edge fades. Returns int16 (n, ch)."""
    f = y.astype(np.float32) / 32768.0
    peak = float(np.max(np.abs(f))) or 1.0
    f *= (10.0 ** (peak_target_dbfs / 20.0)) / peak
    n = min(len(f), max(1, int(sr * edge_fade_ms / 1000.0)))
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None]
    f[:n] *= ramp
    f[-n:] *= ramp[::-1]
    return (np.clip(f, -1.0, 1.0) * 32767.0).astype("<i2")


def write_wav(path: str, y: np.ndarray, sr: int) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(y.shape[1] if y.ndim == 2 else 1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(y.astype("<i2").tobytes())


# ------------------------------------------------------------------ metadata

def scale_info(root: str, mode: str, concert_a_hz: float = 440.0) -> dict:
    root_pc = NOTE_NAMES.index(root)
    steps = MODE_STEPS[mode]
    pcs = [(root_pc + s) % 12 for s in steps]
    notes = [NOTE_NAMES[pc] for pc in pcs]
    root_midi = 60 + ((root_pc - 0) % 12)          # root in the C4..B4 octave
    if root_midi > 66:                              # keep the reference near middle C
        root_midi -= 12
    root_hz = concert_a_hz * 2 ** ((root_midi - 69) / 12.0)
    penta = PENTATONIC_DEGREES[mode]
    return {
        "root": root, "mode": mode, "concert_a_hz": concert_a_hz,
        "notes": notes,
        "midi_pitch_classes": pcs,
        "root_midi_reference": root_midi,
        "root_hz_reference": round(root_hz, 2),
        "sfx_safe_pitch_classes": [pcs[d] for d in penta],
        "sfx_safe_notes": [notes[d] for d in penta],
    }


def sections_from_plan(plan: dict, intent_sections: list[dict]) -> list[dict]:
    """Composition-plan sections -> timeline with absolute start/end.
    `intent_sections` (authored, same arc as the prompt) contribute the human
    description + sync hints, matched by order."""
    out, t = [], 0.0
    for i, sec in enumerate(plan_sections(plan)):
        dur = sec["duration_ms"] / 1000.0
        intent = intent_sections[i] if i < len(intent_sections) else {}
        out.append({
            "name": sec["name"],
            "start_s": round(t, 3),
            "end_s": round(t + dur, 3),
            "duration_s": round(dur, 3),
            "styles": sec["styles"],
            "description": intent.get("description", ""),
            "sync_hints": intent.get("sync_hints", []),
        })
        t += dur
    return out


def sections_from_analysis(analysis: dict, intent_sections: list[dict]) -> list[dict]:
    """No plan available: split the measured duration across the authored arc by
    its relative weights — clearly marked as approximate."""
    total = analysis["duration_s"]
    weights = [s.get("weight", 1.0) for s in intent_sections] or [1.0]
    wsum = sum(weights)
    out, t = [], 0.0
    for sec, w in zip(intent_sections, weights):
        dur = total * w / wsum
        out.append({
            "name": sec.get("name", "section"),
            "start_s": round(t, 3), "end_s": round(t + dur, 3),
            "duration_s": round(dur, 3), "styles": [],
            "description": sec.get("description", ""),
            "sync_hints": sec.get("sync_hints", []),
            "approximate": True,
        })
        t += dur
    return out


def section_intensity(sections: list[dict], analysis: dict | None) -> None:
    """0..1 per section from its mean RMS (measured, not guessed)."""
    if not analysis:
        return
    hop = analysis["rms_envelope"]["hop_s"]
    vals = analysis["rms_envelope"]["values_db"]
    means = []
    for sec in sections:
        lo, hi = int(sec["start_s"] / hop), max(int(sec["start_s"] / hop) + 1,
                                                int(sec["end_s"] / hop))
        seg = vals[lo:hi] or [-60.0]
        means.append(float(np.mean(seg)))
    lo_db, hi_db = min(means), max(means)
    span = max(1e-6, hi_db - lo_db)
    for sec, m in zip(sections, means):
        sec["intensity"] = round((m - lo_db) / span, 2)


def build_metadata(track: dict, cfg: dict, *, audio_file: str, fmt: str,
                   sr: int, channels: int, analysis: dict | None,
                   plan: dict | None, prompt: str) -> dict:
    key = track["key"]
    sections = (sections_from_plan(plan, track.get("sections", []))
                if plan else
                sections_from_analysis(analysis or {"duration_s": track["length_ms"] / 1000.0},
                                       track.get("sections", [])))
    section_intensity(sections, analysis)
    duration = (analysis["duration_s"] if analysis
                else round(sum(s["duration_s"] for s in sections), 3))
    loop_cfg = track.get("loop", {})
    meta = {
        "schema": "music.metadata/v1",
        "id": track["id"],
        "name": track["name"],
        "domain": "music",
        "created_at": _now(),
        "intent": {
            "use": track.get("use", ""),
            "feeling": track.get("feeling", []),
            "narrative": track.get("narrative", ""),
            "references": track.get("references", []),
        },
        "musical": {
            "key": scale_info(key["root"], key["mode"]),
            "tempo_bpm": track["bpm"],
            "time_signature": track.get("time_signature", "4/4"),
            "sfx_pitching": {
                "note": ("Pitch one-shot SFX (footsteps, UI, chimes) to "
                         "musical.key.sfx_safe_pitch_classes so they sit inside "
                         "the harmony; quantize their trigger time to timing."
                         "beats_s (or downbeats_s for big moments)."),
            },
        },
        "audio": {
            "file": f"{track['id']}/{audio_file}",
            "format": fmt,
            "sample_rate": sr,
            "channels": channels,
            "duration_s": duration,
            "peak_dbfs": analysis["peak_dbfs"] if analysis else None,
            "rms_dbfs": analysis["rms_dbfs"] if analysis else None,
        },
        "structure": {
            "source": "elevenlabs-composition-plan" if plan else "authored-arc-approximate",
            "sections": sections,
        },
        "timing": None,
        "events": None,
        "dynamics": None,
        "loop": {
            "loopable": bool(loop_cfg.get("loopable", False)),
            "seamless": False,
            "recommended": loop_cfg.get("recommended",
                                        {"loop_start_s": 0.0,
                                         "loop_end_s": duration,
                                         "crossfade_ms": 400}),
            "note": ("Generated audio is not sample-loop-perfect; crossfade "
                     "loop_end into loop_start over crossfade_ms."),
        },
        "engine": {
            "provider": "elevenlabs",
            "model_id": cfg["engine"]["model_id"],
            "prompt": prompt,
            "composition_plan": plan,
        },
        "mastering": (f"peak-normalize({cfg['mastering']['peak_dbfs']} dBFS) + "
                      f"{cfg['mastering']['edge_fade_ms']} ms edge fades"
                      if fmt == "wav" else "as-delivered (lossy container)"),
    }
    if analysis:
        meta["timing"] = {
            "tempo": analysis["tempo"],
            "beats_s": analysis["beats_s"],
            "downbeats_s": analysis["downbeats_s"],
        }
        meta["events"] = {
            "onsets_s": analysis["onsets_s"],
            "onset_strengths": analysis["onset_strengths"],
            "peaks": analysis["peaks"],
            "note": ("onsets_s = every audible attack (fire discrete FX here); "
                     "peaks = the strongest hits (thunder/flash-worthy)."),
        }
        meta["dynamics"] = {
            "rms_db": analysis["rms_envelope"],
            "note": ("50 ms loudness curve in dBFS — drive continuous effects "
                     "(light, fog, camera) from this, index = t / hop_s."),
        }
    return meta


# ----------------------------------------------------------------- top level

def compose_track(track: dict, cfg: dict, client: ElevenLabsMusicClient) -> str:
    """Generate + package one track. Returns the track directory."""
    eng = cfg["engine"]
    track_dir = os.path.join(ROOT, track["id"])
    os.makedirs(track_dir, exist_ok=True)

    prompt = track["prompt"]
    negatives = eng.get("global_negative_styles", [])
    if negatives:
        prompt = prompt + " Avoid: " + ", ".join(negatives) + "."

    print(f"[{track['id']}] planning composition ({track['length_ms']} ms) ...")
    plan = None
    try:
        plan = client.plan(prompt, track["length_ms"], model_id=eng["model_id"])
        secs = plan_sections(plan)
        print(f"  plan: {len(secs)} sections: "
              + ", ".join(f"{s['name']}({s['duration_ms']}ms)" for s in secs))
    except PlanUnavailable as e:
        print(f"  ! no composition plan ({str(e)[:120]}); composing from prompt")

    print(f"[{track['id']}] composing ...")
    kw = ({"composition_plan": plan} if plan
          else {"prompt": prompt, "music_length_ms": track["length_ms"]})
    audio, fmt_req = client.compose_best(primary_format=eng["primary_format"],
                                         model_id=eng["model_id"], **kw)
    container = sniff_container(audio)
    print(f"  got {len(audio)} bytes, requested {fmt_req}, sniffed {container}")

    expected_s = (sum(s["duration_ms"] for s in plan_sections(plan)) / 1000.0
                  if plan else track["length_ms"] / 1000.0)
    sr = 44100
    y = None
    if container == "wav":
        y, sr = decode_wav(audio)
    elif container == "pcm":
        _, sr = _requested_rate(fmt_req)
        y = decode_pcm(audio, sr, expected_s)
    else:                                           # mp3
        dec = decode_mp3_via_ffmpeg(audio)
        if dec:
            y, sr = dec

    if y is not None:
        y = master(y, sr, cfg["mastering"]["peak_dbfs"], cfg["mastering"]["edge_fade_ms"])
        audio_file = f"{track['id']}.wav"
        write_wav(os.path.join(track_dir, audio_file), y, sr)
        fmt, channels = "wav", (y.shape[1] if y.ndim == 2 else 1)
        analysis = analyze(y, sr, authored_bpm=track.get("bpm"),
                           beats_per_bar=int(track.get("time_signature", "4/4").split("/")[0]),
                           rms_hop_s=cfg["analysis"]["rms_hop_ms"] / 1000.0)
    else:
        audio_file = f"{track['id']}.mp3"
        with open(os.path.join(track_dir, audio_file), "wb") as f:
            f.write(audio)
        fmt, channels, analysis = "mp3", 2, None
        print("  ! shipped as mp3 without measured analysis (no ffmpeg) — "
              "metadata timing comes from the composition plan only")

    meta = build_metadata(track, cfg, audio_file=audio_file, fmt=fmt, sr=sr,
                          channels=channels, analysis=analysis, plan=plan,
                          prompt=prompt)
    with open(os.path.join(track_dir, "metadata.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"[{track['id']}] done -> {track_dir} "
          f"({meta['audio']['duration_s']} s, {fmt}, "
          f"{len(meta['structure']['sections'])} sections)")
    return track_dir


def _requested_rate(fmt: str) -> tuple[bool, int]:
    parts = fmt.split("_")
    sr = 44100
    for p in parts[1:]:
        if p.isdigit() and int(p) >= 8000:
            sr = int(p)
            break
    return parts[0] == "pcm", sr


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Compose one catalog track")
    ap.add_argument("track_id")
    args = ap.parse_args()
    cfg = load_config()
    matches = [t for t in cfg["catalog"] if t["id"] == args.track_id]
    if not matches:
        raise SystemExit(f"unknown track id {args.track_id!r}; catalog: "
                         + ", ".join(t["id"] for t in cfg["catalog"]))
    client = ElevenLabsMusicClient()
    client.ensure_budget(cfg["budget"]["min_ai_credits_remaining"])
    compose_track(matches[0], cfg, client)
