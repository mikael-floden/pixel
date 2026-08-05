"""Numpy-only audio analysis for metadata.json — the sub-second sync layer.

Everything a game needs to sync visuals/SFX to a track without listening to it:

- **RMS envelope** (50 ms hop): the loudness curve, for driving screen effects
  (fog density, light warmth, camera sway) from musical intensity.
- **Onsets** (spectral flux): every audible attack, with strength — for firing
  discrete effects (thunder, sparkles, footstep accents) exactly on a hit.
- **Measured tempo** (autocorrelation of the onset envelope): cross-checks the
  authored BPM that was prompted into the model.
- **Beat grid**: beat + downbeat timestamps from the authored BPM, anchored to
  the first strong onset — the quantization grid for anything rhythmic.

Pure numpy (no librosa/scipy) so it runs in this repo's minimal environment
and in CI with just `requirements.txt`.
"""

from __future__ import annotations

import numpy as np

EPS = 1e-10


def to_mono(y: np.ndarray) -> np.ndarray:
    """(n,) or (n, ch) int16/float -> float32 mono in [-1, 1]."""
    y = np.asarray(y)
    if y.dtype.kind in "iu":
        y = y.astype(np.float32) / 32768.0
    else:
        y = y.astype(np.float32)
    if y.ndim == 2:
        y = y.mean(axis=1)
    return y


def peak_dbfs(y: np.ndarray) -> float:
    return float(20.0 * np.log10(max(EPS, float(np.max(np.abs(to_mono(y)))))))


def rms_dbfs(y: np.ndarray) -> float:
    m = to_mono(y)
    return float(20.0 * np.log10(max(EPS, float(np.sqrt(np.mean(m * m))))))


def rms_envelope(y: np.ndarray, sr: int, hop_s: float = 0.05,
                 win_s: float = 0.10) -> tuple[float, list[float]]:
    """-> (hop_s, values_db) — windowed RMS in dBFS every `hop_s` seconds."""
    m = to_mono(y)
    hop, win = max(1, int(sr * hop_s)), max(1, int(sr * win_s))
    vals = []
    for start in range(0, len(m), hop):
        seg = m[start:start + win]
        vals.append(round(20.0 * np.log10(max(EPS, float(np.sqrt(np.mean(seg * seg) if len(seg) else 0.0)))), 1))
    return hop_s, vals


def _stft_mag(m: np.ndarray, nfft: int = 2048, hop: int = 512) -> np.ndarray:
    if len(m) < nfft:
        m = np.pad(m, (0, nfft - len(m)))
    frames = 1 + (len(m) - nfft) // hop
    window = np.hanning(nfft).astype(np.float32)
    idx = np.arange(nfft)[None, :] + hop * np.arange(frames)[:, None]
    return np.abs(np.fft.rfft(m[idx] * window, axis=1))


def onset_envelope(y: np.ndarray, sr: int, nfft: int = 2048,
                   hop: int = 512) -> tuple[np.ndarray, float]:
    """Spectral-flux novelty curve -> (envelope, frames_per_second).
    Log-compressed magnitudes, positive first differences summed over bins."""
    mag = _stft_mag(to_mono(y), nfft, hop)
    logmag = np.log1p(100.0 * mag)
    flux = np.diff(logmag, axis=0)
    env = np.maximum(flux, 0.0).sum(axis=1)
    env = np.concatenate([[0.0], env])
    if env.max() > 0:
        env = env / env.max()
    return env.astype(np.float32), sr / hop


def detect_onsets(env: np.ndarray, fps: float, min_gap_s: float = 0.10,
                  sensitivity: float = 1.5) -> tuple[list[float], list[float]]:
    """Peak-pick the novelty curve with a moving adaptive threshold.
    -> (onset_times_s, strengths 0..1)."""
    half = max(1, int(round(0.5 * fps)))            # ±0.5 s local context
    times, strengths = [], []
    last = -1e9
    for i in range(1, len(env) - 1):
        if env[i] <= env[i - 1] or env[i] < env[i + 1]:
            continue
        lo, hi = max(0, i - half), min(len(env), i + half)
        local = env[lo:hi]
        thresh = float(local.mean() + sensitivity * local.std())
        t = i / fps
        if env[i] >= max(thresh, 0.05) and (t - last) >= min_gap_s:
            times.append(round(t, 3))
            strengths.append(round(float(env[i]), 3))
            last = t
    return times, strengths


def estimate_bpm(env: np.ndarray, fps: float, lo: float = 50.0,
                 hi: float = 200.0) -> float | None:
    """Tempo from the autocorrelation of the (mean-removed) novelty curve."""
    if len(env) < int(4 * fps):
        return None
    x = env - env.mean()
    ac = np.correlate(x, x, mode="full")[len(x) - 1:]
    if ac[0] <= 0:
        return None
    ac /= ac[0]
    lag_min, lag_max = int(fps * 60.0 / hi), int(np.ceil(fps * 60.0 / lo))
    lag_max = min(lag_max, len(ac) - 1)
    if lag_max <= lag_min + 2:
        return None
    lag = lag_min + int(np.argmax(ac[lag_min:lag_max]))
    # parabolic interpolation around the peak for sub-frame lag precision
    if 0 < lag < len(ac) - 1:
        a, b, c = ac[lag - 1], ac[lag], ac[lag + 1]
        denom = a - 2 * b + c
        if abs(denom) > EPS:
            lag = lag + float(np.clip(0.5 * (a - c) / denom, -0.5, 0.5))
    return round(60.0 * fps / lag, 2)


def beat_grid(duration_s: float, bpm: float, anchor_s: float = 0.0,
              beats_per_bar: int = 4) -> tuple[list[float], list[float]]:
    """Beat + downbeat timestamps across the track, anchored at `anchor_s`
    (grid extends backwards to 0 too). -> (beats_s, downbeats_s)."""
    period = 60.0 / bpm
    first = anchor_s - period * int(anchor_s / period)
    beats = np.arange(first, duration_s, period)
    beats = beats[beats >= 0]
    anchor_idx = int(np.argmin(np.abs(beats - anchor_s)))
    down = beats[anchor_idx % beats_per_bar::beats_per_bar]
    return [round(float(t), 3) for t in beats], [round(float(t), 3) for t in down]


def pick_peaks(onsets_s: list[float], strengths: list[float],
               top_n: int = 12) -> list[dict]:
    """The N strongest hits — natural cue points for one-shot effects."""
    order = np.argsort(strengths)[::-1][:top_n]
    peaks = [{"t_s": onsets_s[i], "strength": strengths[i], "label": "hit"}
             for i in sorted(order)]
    return peaks


def analyze(y: np.ndarray, sr: int, authored_bpm: float | None = None,
            beats_per_bar: int = 4, rms_hop_s: float = 0.05) -> dict:
    """Full analysis bundle for metadata.json. Uses `authored_bpm` (the tempo we
    prompted into the model) for the beat grid when given; the measured tempo is
    reported alongside for honesty."""
    m = to_mono(y)
    duration_s = len(m) / sr
    hop_s, rms_db = rms_envelope(m, sr, hop_s=rms_hop_s)
    env, fps = onset_envelope(m, sr)
    onsets_s, strengths = detect_onsets(env, fps)
    measured_bpm = estimate_bpm(env, fps)
    grid_bpm = authored_bpm or measured_bpm
    anchor = 0.0
    if onsets_s:
        strong = [t for t, s in zip(onsets_s, strengths) if s >= 0.5]
        anchor = strong[0] if strong else onsets_s[0]
    beats, downbeats = ([], [])
    if grid_bpm:
        beats, downbeats = beat_grid(duration_s, grid_bpm, anchor, beats_per_bar)
    return {
        "duration_s": round(duration_s, 3),
        "peak_dbfs": round(peak_dbfs(m), 2),
        "rms_dbfs": round(rms_dbfs(m), 2),
        "rms_envelope": {"hop_s": hop_s, "start_s": 0.0, "values_db": rms_db},
        "onsets_s": onsets_s,
        "onset_strengths": strengths,
        "peaks": pick_peaks(onsets_s, strengths),
        "tempo": {
            "authored_bpm": authored_bpm,
            "measured_bpm": measured_bpm,
            "grid_bpm": grid_bpm,
            "beat_anchor_s": round(anchor, 3),
            "beats_per_bar": beats_per_bar,
        },
        "beats_s": beats,
        "downbeats_s": downbeats,
    }


def _selftest() -> None:
    """Synthesize 8 s of 120 BPM clicks over a pad; the analyzer must find the
    tempo within 2 BPM and land onsets on the clicks."""
    sr = 44100
    t = np.arange(8 * sr) / sr
    y = 0.05 * np.sin(2 * np.pi * 220 * t)
    for beat in np.arange(0.5, 8.0, 0.5):          # 120 BPM clicks
        i = int(beat * sr)
        n = int(0.02 * sr)
        y[i:i + n] += 0.8 * np.sin(2 * np.pi * 1000 * t[:n]) * np.linspace(1, 0, n)
    r = analyze(y, sr, authored_bpm=None)
    bpm = r["tempo"]["measured_bpm"]
    assert bpm and (abs(bpm - 120) < 2 or abs(bpm - 60) < 1), f"bpm={bpm}"
    assert len(r["onsets_s"]) >= 12, f"onsets={len(r['onsets_s'])}"
    first_click = min(r["onsets_s"], key=lambda x: abs(x - 0.5))
    assert abs(first_click - 0.5) < 0.05, f"first onset at {first_click}"
    print(f"selftest OK: measured {bpm} bpm, {len(r['onsets_s'])} onsets, "
          f"peak {r['peak_dbfs']} dBFS")


if __name__ == "__main__":
    _selftest()
