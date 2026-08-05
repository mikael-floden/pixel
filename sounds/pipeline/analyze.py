"""Analyze a rendered sound into the musical + timing metadata the composer needs
to place it WITHOUT listening: pitch/tonality (so a tonal SFX can be transposed into
the music's key) and a sub-second envelope (onset/peak/attack, so effects sync to the
transient). Pure numpy DSP over the mastered WAV.

Consumed by `factory` (embedded into each `metadata.json`) and the migration.
"""

from __future__ import annotations

import math
import wave

import numpy as np

_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def load_mono(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, "rb") as w:
        n, sr, sw, ch = w.getnframes(), w.getframerate(), w.getsampwidth(), w.getnchannels()
        raw = w.readframes(n)
    dt = {1: np.int8, 2: "<i2", 4: "<i4"}.get(sw, "<i2")
    x = np.frombuffer(raw, dtype=dt).astype(np.float32)
    x = x / float(1 << (8 * sw - 1))
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


def hz_to_note(f: float) -> dict | None:
    if not f or f <= 0:
        return None
    midi = 69 + 12 * math.log2(f / 440.0)
    m = int(round(midi))
    return {"note": _NOTE_NAMES[m % 12] + str(m // 12 - 1), "midi": m,
            "cents_off": round((midi - m) * 100)}


def _spectral_flatness(x: np.ndarray) -> float:
    """Geometric/arithmetic mean of the magnitude spectrum: ~0 = tonal (pitched),
    ~1 = flat/noisy (atonal, e.g. wind, explosion)."""
    if x.size < 32:
        return 1.0
    mag = np.abs(np.fft.rfft(x * np.hanning(x.size))) + 1e-9
    return float(np.exp(np.mean(np.log(mag))) / np.mean(mag))


def _autocorr_pitch(x: np.ndarray, sr: int, fmin: float = 55.0,
                    fmax: float = 2000.0) -> tuple[float, float]:
    """(fundamental_hz, confidence 0..1) via autocorrelation. Confidence is the
    normalised autocorrelation peak height (peak / zero-lag) — a real measure of
    how periodic (pitched) the signal is, not a guess."""
    x = x - np.mean(x)
    if np.max(np.abs(x)) < 1e-4:
        return 0.0, 0.0
    corr = np.correlate(x, x, mode="full")[x.size - 1:]
    if corr[0] <= 0:
        return 0.0, 0.0
    # Skip past the first zero-crossing so we don't pick the small-lag bias (which
    # makes noisy/bass-heavy signals look like a high-pitched tone). A genuine
    # pitch shows a strong autocorr PEAK at the period, after decorrelation.
    neg = np.where(corr < 0)[0]
    if neg.size == 0:
        return 0.0, 0.0  # never decorrelates → no clear pitch (DC / sub-bass wash)
    lo = max(int(neg[0]), int(sr / fmax))
    hi = min(corr.size - 1, int(sr / fmin))
    if hi <= lo + 1:
        return 0.0, 0.0
    peak = int(np.argmax(corr[lo:hi])) + lo
    conf = float(max(0.0, min(1.0, corr[peak] / corr[0])))
    return (sr / peak if corr[peak] > 0 else 0.0), conf


def _envelope(x: np.ndarray, sr: int) -> dict:
    a = np.abs(x)
    peak = float(a.max()) if a.size else 0.0
    if peak <= 0:
        return {"duration_ms": round(1000 * x.size / sr, 1), "onset_ms": 0.0,
                "peak_ms": 0.0, "attack_ms": 0.0, "peak_dbfs": -120.0, "rms": 0.0, "crest": 0.0}
    gate = peak * 10 ** (-40 / 20)
    above = np.where(a >= gate)[0]
    onset = int(above[0]) if above.size else 0
    peak_i = int(np.argmax(a))
    rms = float(np.sqrt(np.mean(x ** 2)))
    return {
        "duration_ms": round(1000 * x.size / sr, 1),
        "onset_ms": round(1000 * onset / sr, 1),
        "peak_ms": round(1000 * peak_i / sr, 1),
        "attack_ms": round(1000 * max(0, peak_i - onset) / sr, 1),
        "peak_dbfs": round(20 * math.log10(peak), 1),
        "rms": round(rms, 4),
        "crest": round(peak / rms, 1) if rms > 0 else 0.0,
    }


def analyze_wav(path: str) -> dict:
    """Return {'envelope': {...}, 'musical': {...}} for the composer: sub-second
    timing + pitch/tonality (with a repitchable flag so tonal SFX can be keyed to
    the music, atonal ones only jittered)."""
    x, sr = load_mono(path)
    env = _envelope(x, sr)

    # Pitch on the loudest ~250 ms window (the tone body), not the whole clip.
    win = min(x.size, int(sr * 0.25))
    if win >= 64 and x.size:
        c = int(np.argmax(np.abs(x)))
        s = max(0, min(c - win // 2, x.size - win))
        seg = x[s:s + win]
    else:
        seg = x
    flat = _spectral_flatness(seg)
    f0, conf = _autocorr_pitch(seg, sr)
    # Tonality is driven by periodicity confidence (the corrected autocorr peak),
    # with spectral flatness as a secondary sanity gate. Broadband foley (footsteps,
    # explosions, wind) must land 'atonal' so the composer never scale-shifts them.
    if conf > 0.7 and flat < 0.30:
        tonality = "tonal"
    elif conf > 0.5 and flat < 0.45:
        tonality = "mixed"
    else:
        tonality = "atonal"
    tonal = tonality in ("tonal", "mixed")
    note = hz_to_note(f0) if (tonal and f0) else None
    # The composer's contract: only scale-snap tonal SFX; cap the shift; snapping
    # REPLACES random pitch-jitter (never stacked).
    music = {
        "tonal": tonal,
        "root_midi": note["midi"] if note else None,
        "note": note["note"] if note else None,
        "fundamental_hz": round(f0, 1) if (tonal and f0) else None,
        "cents_off": note["cents_off"] if note else None,
        "pitch_confidence": round(conf, 3),
        "max_shift_semitones": 3 if tonal else 0,
        "scale_snap_replaces_jitter": tonal,
        "tonality": tonality,
        "spectral_flatness": round(flat, 3),
    }
    # Named, MEASURED sync point: the main transient (composer can trigger visuals
    # / thunder / SFX layers on it).
    sync = [{"t_ms": env["peak_ms"], "name": "transient",
             "note": "main attack — measured; safe sync/trigger point"}] if env["peak_dbfs"] > -40 else []
    return {"envelope": env, "music": music, "sync_points": sync}


if __name__ == "__main__":
    import sys
    for p in sys.argv[1:]:
        import json
        print(p, json.dumps(analyze_wav(p)))
