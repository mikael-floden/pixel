"""Light mastering for AI-generated SFX so every clip ships production-clean.

Neural SFX models return usable but raw audio: leading/trailing near-silence,
inconsistent levels, and hard edges that click on playback. AAA delivery wants
each one-shot trimmed tight, level-matched, and edge-faded. This module does
exactly that — no synthesis, just cleanup — operating on the PCM the AI returns.

All functions work on a mono float32 array in [-1, 1]. `master()` is the pipeline.
"""

from __future__ import annotations

import io
import wave

import numpy as np


def decode_audio(raw: bytes, default_sr: int) -> tuple[np.ndarray, int]:
    """Decode ElevenLabs audio bytes to (mono float32 in [-1,1], sample_rate),
    robust to how the API frames PCM. Handles a WAV/RIFF wrapper (any sample
    width, reads the real rate) and headerless signed-16-bit LE PCM; odd-length
    buffers are trimmed rather than raising."""
    # WAV/RIFF-wrapped: authoritative width + rate from the header.
    if raw[:4] == b"RIFF":
        with wave.open(io.BytesIO(raw)) as w:
            sw, sr, ch = w.getsampwidth(), w.getframerate(), w.getnchannels()
            frames = w.readframes(w.getnframes())
        x = _pcm_bytes_to_float(frames, sw)
        if ch > 1:  # downmix to mono
            x = x.reshape(-1, ch).mean(axis=1)
        return x, sr
    # Headerless raw PCM (ElevenLabs pcm_* = signed 16-bit LE).
    return _pcm_bytes_to_float(raw, 2), default_sr


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
