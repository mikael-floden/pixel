"""Light mastering for AI-generated SFX so every clip ships production-clean.

Neural SFX models return usable but raw audio: leading/trailing near-silence,
inconsistent levels, and hard edges that click on playback. AAA delivery wants
each one-shot trimmed tight, level-matched, and edge-faded. This module does
exactly that — no synthesis, just cleanup — operating on the PCM the AI returns.

All functions work on a mono float32 array in [-1, 1]. `master()` is the pipeline.
"""

from __future__ import annotations

import wave

import numpy as np


def pcm16_to_float(raw: bytes) -> np.ndarray:
    """Decode signed-16-bit little-endian mono PCM (ElevenLabs `pcm_*`) to float."""
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def _db_to_amp(db: float) -> float:
    return float(10.0 ** (db / 20.0))


def trim_silence(x: np.ndarray, sr: int, thresh_db: float = -45.0,
                 pad_ms: float = 8.0) -> np.ndarray:
    """Trim leading/trailing audio below `thresh_db` (rel. to the clip's peak),
    keeping `pad_ms` of headroom either side so transients aren't clipped."""
    if x.size == 0:
        return x
    peak = float(np.max(np.abs(x))) or 1.0
    gate = peak * _db_to_amp(thresh_db)
    above = np.where(np.abs(x) >= gate)[0]
    if above.size == 0:
        return x
    pad = int(sr * pad_ms / 1000.0)
    start = max(0, above[0] - pad)
    end = min(x.size, above[-1] + pad + 1)
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


def master(x: np.ndarray, sr: int, *, trim: bool = True,
           target_dbfs: float = -1.0, fade_out_ms: float = 15.0) -> np.ndarray:
    """Trim → fade → peak-normalise. Returns the mastered float array."""
    if trim:
        x = trim_silence(x, sr)
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
