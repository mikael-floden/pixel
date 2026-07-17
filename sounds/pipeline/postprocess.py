"""Light mastering for AI-generated SFX so every clip ships production-clean.

Neural SFX models return usable but raw audio: leading/trailing near-silence,
inconsistent levels, and hard edges that click on playback. AAA delivery wants
each one-shot trimmed tight, level-matched, and edge-faded. This module does
exactly that — no synthesis, just cleanup — operating on the PCM the AI returns.

All functions work on a mono float32 array in [-1, 1]. `master()` is the pipeline.
"""

from __future__ import annotations

import io
import shutil
import subprocess
import wave

import numpy as np


def _sniff(raw: bytes) -> str:
    """Identify the container from magic bytes. CRITICAL: the API may return a
    format other than the one requested (e.g. an MP3 when pcm_48000 is asked for
    on a non-Pro key), so we must decode by ACTUAL content, never by the request."""
    if raw[:4] == b"RIFF":
        return "wav"
    if raw[:3] == b"ID3":
        return "mp3"
    if len(raw) >= 2 and raw[0] == 0xFF and (raw[1] & 0xE0) == 0xE0:
        return "mp3"  # MPEG audio frame sync
    if raw[:4] == b"OggS":
        return "ogg"
    if raw[:4] == b"fLaC":
        return "flac"
    return "pcm"  # assume headerless signed-16-bit LE PCM


def decode_audio(raw: bytes, default_sr: int, target_sr: int = 48000) -> tuple[np.ndarray, int]:
    """Decode API audio bytes to (mono float32 in [-1,1], sample_rate), by sniffing
    the real container: WAV/RIFF (any width, real rate), compressed (mp3/ogg/flac,
    via ffmpeg), or headerless signed-16-bit LE PCM. Odd-length raw PCM is trimmed
    rather than raising."""
    kind = _sniff(raw)
    if kind == "wav":
        with wave.open(io.BytesIO(raw)) as w:
            sw, sr, ch = w.getsampwidth(), w.getframerate(), w.getnchannels()
            frames = w.readframes(w.getnframes())
        x = _pcm_bytes_to_float(frames, sw)
        if ch > 1:
            x = x.reshape(-1, ch).mean(axis=1)
        return x, sr
    if kind in ("mp3", "ogg", "flac"):
        return _ffmpeg_decode(raw, target_sr), target_sr
    return _pcm_bytes_to_float(raw, 2), default_sr


def _ffmpeg_decode(raw: bytes, target_sr: int) -> np.ndarray:
    """Decode compressed audio to mono float32 via ffmpeg (present on CI runners).
    Reads from stdin, writes 32-bit float mono PCM at `target_sr` to stdout."""
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg not found — cannot decode compressed audio "
                           "(the API returned MP3/OGG). Install ffmpeg.")
    p = subprocess.run(
        [exe, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-f", "f32le", "-ac", "1", "-ar", str(target_sr), "pipe:1"],
        input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if p.returncode != 0 or not p.stdout:
        raise RuntimeError(f"ffmpeg decode failed: {p.stderr.decode()[:200]}")
    return np.frombuffer(p.stdout, dtype="<f4").astype(np.float32)


def _pcm_bytes_to_float(raw: bytes, sampwidth: int) -> np.ndarray:
    """Signed little-endian integer PCM bytes -> float32 in [-1, 1]."""
    if sampwidth == 2:
        if len(raw) % 2:
            raw = raw[:-1]
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if sampwidth == 4:
        if len(raw) % 4:
            raw = raw[: len(raw) - (len(raw) % 4)]
        return np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    if sampwidth == 3:  # 24-bit: widen each 3-byte sample to int32
        n = len(raw) // 3
        b = np.frombuffer(raw[: n * 3], dtype=np.uint8).reshape(n, 3).astype(np.int32)
        v = (b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16))
        v = np.where(v & 0x800000, v - 0x1000000, v)
        return v.astype(np.float32) / 8388608.0
    if sampwidth == 1:  # unsigned 8-bit
        return (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    raise ValueError(f"unsupported PCM sample width: {sampwidth}")


def _db_to_amp(db: float) -> float:
    return float(10.0 ** (db / 20.0))


def trim_silence(x: np.ndarray, sr: int, lead_db: float = -45.0,
                 tail_db: float = -60.0, lead_pad_ms: float = 6.0,
                 tail_pad_ms: float = 40.0) -> np.ndarray:
    """Trim dead air, ASYMMETRICALLY: cut the leading silence tight (a −45 dB
    gate — that's just latency), but keep the trailing DECAY (a much gentler
    −60 dB gate + generous pad), so a natural ring-out / reverb tail survives
    instead of being chopped to a click."""
    if x.size == 0:
        return x
    peak = float(np.max(np.abs(x))) or 1.0
    lead_gate = peak * _db_to_amp(lead_db)
    tail_gate = peak * _db_to_amp(tail_db)
    above_lead = np.where(np.abs(x) >= lead_gate)[0]
    above_tail = np.where(np.abs(x) >= tail_gate)[0]
    if above_lead.size == 0 or above_tail.size == 0:
        return x
    start = max(0, above_lead[0] - int(sr * lead_pad_ms / 1000.0))
    end = min(x.size, above_tail[-1] + int(sr * tail_pad_ms / 1000.0) + 1)
    return x[start:end]


def normalize_peak(x: np.ndarray, target_dbfs: float = -1.0) -> np.ndarray:
    """Peak-normalise so the loudest sample sits at `target_dbfs` (−1 dBFS keeps
    a hair of headroom, the standard for one-shot SFX)."""
    if x.size == 0:
        return x
    peak = float(np.max(np.abs(x)))
    if peak <= 0:
        return x
    return x * (_db_to_amp(target_dbfs) / peak)


def apply_fades(x: np.ndarray, sr: int, fade_in_ms: float = 3.0,
                fade_out_ms: float = 15.0) -> np.ndarray:
    """De-click the edges with short raised-cosine fades."""
    x = x.copy()
    n_in = min(int(sr * fade_in_ms / 1000.0), x.size // 2)
    n_out = min(int(sr * fade_out_ms / 1000.0), x.size // 2)
    if n_in > 0:
        x[:n_in] *= np.sin(np.linspace(0, np.pi / 2, n_in)) ** 2
    if n_out > 0:
        x[-n_out:] *= np.cos(np.linspace(0, np.pi / 2, n_out)) ** 2
    return x


def master(x: np.ndarray, sr: int, *, trim: bool = True, fades: bool = True,
           target_dbfs: float = -1.0, fade_out_ms: float = 15.0) -> np.ndarray:
    """Trim → fade → peak-normalise. Returns the mastered float array.

    For a **seamless loop** (ambience bed) pass `trim=False, fades=False`: trimming
    or edge-fading a loop creates an audible gap/dip at the seam. Loops are only
    peak-normalised; the model's loop mode handles seamlessness."""
    if trim:
        x = trim_silence(x, sr)
    if fades:
        x = apply_fades(x, sr, fade_out_ms=fade_out_ms)
    x = normalize_peak(x, target_dbfs)
    return np.clip(x, -1.0, 1.0)


def write_wav(x: np.ndarray, path: str, sr: int) -> dict:
    """Write a 16-bit mono WAV and return stats for the manifest."""
    pcm = np.int16(np.clip(x, -1.0, 1.0) * 32767)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return {
        "samples": int(x.size),
        "duration_seconds": round(x.size / sr, 3),
        "sample_rate": sr,
        "channels": 1,
        "bit_depth": 16,
        "peak_dbfs": -1.0,
    }
