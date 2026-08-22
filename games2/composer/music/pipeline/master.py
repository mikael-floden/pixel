"""DSP for the composer's own score: decode → measure → master → encode.

Why this exists at all (the composer's quality bar for BACKGROUND music):

  1. LOUDNESS MATCHING is not optional. Six beds cross-fade into each other
     (battle ⇄ cave ⇄ town ⇄ home ⇄ night ⇄ adventure), and two takes from the
     same model routinely land 4-6 LU apart. Un-matched, every context switch
     is a volume jump — the single most audible "amateur" tell in game audio.
     We measure ITU-R BS.1770 K-weighted loudness and ship a per-track gain so
     every bed sits at the SAME perceived level.
  2. LOOP POINTS decide whether a bed sounds composed or sounds like an mp3 on
     repeat. The engine crossfades loop_end → loop_start (MusicDirector), so we
     search for the (start, end) pair whose surrounding audio MATCHES — a
     spectral + level similarity search over the real audio, beat-snapped when
     the plan gave us a tempo. Generated music is never sample-loop-perfect;
     picking the seam is what makes the loop disappear.
  3. We generate LOSSLESS (pcm_44100) so measuring and gain-staging happen on
     the real signal, and encode ONCE at the end. Mastering a lossy file means
     decoding and re-encoding — two generations of artefacts on a bed the
     player hears for hours.

Delivery is opus (.ogg) + AAC (.m4a), not mp3: at 96 kbps opus beats 160 kbps
mp3 and is ~40% smaller, and .m4a covers Safari/iOS where opus-in-ogg will not
decode. Between them every browser is served (the same pair the music domain
ships, and the same pick-by-canPlayType the engine already does for catalog
tracks). The WAV master is NOT committed — a 95 s stereo master is ~16 MB and
nothing at runtime reads it; every number measured from it lives in tracks.json.

numpy + scipy + soundfile; ffmpeg from PATH or the imageio-ffmpeg static build.
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import tempfile
import wave

import numpy as np

# ---------------------------------------------------------------- decoding

# --- mp3 frame header, so a coincidence cannot masquerade as a container ---
# THREE PAID GENERATIONS WERE THROWN AWAY BY A TWO-BYTE COINCIDENCE (measured
# 2026-08-22). The API delivers pcm_44100, and a two-byte "is the sync word
# there" test read raw PCM as mp3 whenever the FIRST SAMPLE was -1 — because
# s16le -1 is 0xFF 0xFF, which is a textbook frame sync. A bed that opens from
# silence has a first sample of 0 or -1 almost every time, so the coin came up
# mp3 for nangijala_explore_day_choir (twice) and nangijala_arrive_whistle:
# ffmpeg found one accidental frame, flooded "Header missing", and returned
# 0.07-0.35 s of a 55-165 s take, which the disqualifier then correctly binned.
# A real frame PREDICTS WHERE THE NEXT ONE STARTS, so requiring two chained
# headers is the cheap test that noise cannot pass.
_MP3_RATES = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)
_MP3_RATES_V2 = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0)
_MP3_SR = ((44100, 48000, 32000), (22050, 24000, 16000), (11025, 12000, 8000))


def _mp3_frame_len(b: bytes, i: int) -> int:
    """Length of the mpeg-audio frame starting at i, or 0 if that is not one."""
    if i + 4 > len(b) or b[i] != 0xFF or (b[i + 1] & 0xE0) != 0xE0:
        return 0
    ver, layer = (b[i + 1] >> 3) & 3, (b[i + 1] >> 1) & 3
    rate_i, sr_i, pad = b[i + 2] >> 4, (b[i + 2] >> 2) & 3, (b[i + 2] >> 1) & 1
    if ver == 1 or layer == 0 or rate_i in (0, 15) or sr_i == 3:
        return 0                                   # reserved = not audio
    sr = _MP3_SR[{3: 0, 2: 1, 0: 2}[ver]][sr_i]
    kbps = (_MP3_RATES if ver == 3 else _MP3_RATES_V2)[rate_i]
    if not kbps:
        return 0
    if layer == 3:                                 # layer I: 384 samples/frame
        return (12 * kbps * 1000 // sr + pad) * 4
    spf = 1152 if (layer == 1 and ver == 3) else (576 if layer == 1 else 1152)
    return spf // 8 * kbps * 1000 // sr + pad


def _is_mp3(b: bytes) -> bool:
    n = _mp3_frame_len(b, 0)
    return bool(n) and _mp3_frame_len(b, n) > 0


def sniff_container(b: bytes) -> str:
    """The API may DELIVER a container it wasn't asked for with a 200 OK, so
    never trust the requested format — sniff the bytes (music domain lesson).

    Ogg and MP4 are here because we now SHIP those: without them a delivery
    copy fell through to the raw-PCM branch and got read as s16le, which does
    not fail — it silently reports a 1.7 MB opus file as 9.8 seconds of
    clipping noise. Anything that reads our own output (`adopt`, QA) would have
    believed it.

    MP3 is the one format with no magic number of its own, so it is claimed
    LAST and only on two chained frame headers — see _is_mp3."""
    if b[:4] == b"RIFF":
        return "wav"
    if b[:4] == b"OggS":
        return "ogg"
    if len(b) > 8 and b[4:8] == b"ftyp":
        return "m4a"
    if b[:3] == b"ID3" or _is_mp3(b):
        return "mp3"
    return "pcm"


def find_ffmpeg() -> str | None:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        return None


def _decode_wav_bytes(b: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(b)) as w:
        sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw != 2:
        raise ValueError(f"unsupported WAV sample width {sw}")
    return np.frombuffer(raw, dtype="<i2").reshape(-1, ch), sr


def _decode_via_ffmpeg(b: bytes, suffix: str) -> tuple[np.ndarray, int]:
    ff = find_ffmpeg()
    if not ff:
        raise RuntimeError(f"cannot decode {suffix} without ffmpeg")
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(b)
        src = f.name
    dst = src + ".wav"
    try:
        subprocess.run([ff, "-y", "-v", "error", "-i", src, "-acodec", "pcm_s16le", dst],
                       check=True, timeout=600)
        with open(dst, "rb") as f:
            return _decode_wav_bytes(f.read())
    finally:
        for p in (src, dst):
            try:
                os.unlink(p)
            except OSError:
                pass


def decode(audio: bytes, sr_hint: int = 44100,
           expected_s: float | None = None) -> tuple[np.ndarray, int]:
    """Any delivered container → (float32 samples in [-1,1], shape (n, ch), sr)."""
    kind = sniff_container(audio)
    if kind == "wav":
        y, sr = _decode_wav_bytes(audio)
    elif kind in ("mp3", "ogg", "m4a"):
        try:
            y, sr = _decode_via_ffmpeg(audio, f".{kind}")
        except Exception:
            y, sr = np.zeros((0, 2), dtype="<i2"), sr_hint
        # BELT AND BRACES for the coincidence above: if the container decoded
        # to a fraction of what these bytes could hold, we sniffed wrong, and
        # raw PCM is the only other thing the API sends. Cheaper to check than
        # to re-generate — the mis-sniff cost three paid takes before it was
        # found, and reading a real short file as PCM is not possible here
        # because a real container decodes to its own honest length.
        if expected_s and len(y) / max(1, sr) < 0.25 * expected_s \
                and len(audio) > sr_hint * 2 * 2 * 0.5 * expected_s:
            print(f"  ! {kind} decoded {len(y) / max(1, sr):.2f}s from "
                  f"{len(audio)} bytes — re-reading the delivery as raw PCM")
            kind = "pcm"
    if kind == "pcm":
        # Raw s16le. Channel count is inferred from the length we asked for
        # (music_v1 delivers stereo natively).
        flat = np.frombuffer(audio[: len(audio) // 2 * 2], dtype="<i2")
        ch = 2
        if expected_s and expected_s > 0:
            ch = min(2, max(1, round(len(flat) / (sr_hint * expected_s))))
        y, sr = flat[: len(flat) // ch * ch].reshape(-1, ch), sr_hint
    return y.astype(np.float32) / 32768.0, sr


def to_mono(y: np.ndarray) -> np.ndarray:
    return y if y.ndim == 1 else y.mean(axis=1)


# ------------------------------------------------- loudness (ITU-R BS.1770)

# BS.1770-4's K-weighting, as TABULATED by the standard — at 48 kHz only.
# Stage 1 = the "head" high shelf, stage 2 = the RLB high-pass.
_K48_SHELF = (np.array([1.53512485958697, -2.69169618940638, 1.19839281085285]),
              np.array([1.0, -1.69065929318241, 0.73248077421585]))
_K48_HPF = (np.array([1.0, -2.0, 1.0]),
            np.array([1.0, -1.99004745483398, 0.99007225036621]))
_K48_SR = 48000.0


def _digital_to_analog(b: np.ndarray, a: np.ndarray, sr: float):
    """Invert the bilinear transform: digital biquad at `sr` → analog (s-domain).

    With s = c·(1−z⁻¹)/(1+z⁻¹) and c = 2·sr, the forward map is
        b0 = B0c² + B1c + B2,  b1 = −2B0c² + 2B2,  b2 = B0c² − B1c + B2
    which inverts in closed form.
    """
    c = 2.0 * sr

    def inv(p):
        return np.array([(p[0] - p[1] + p[2]) / (4 * c * c),
                         (p[0] - p[2]) / (2 * c),
                         (p[0] + p[1] + p[2]) / 4.0])
    return inv(b), inv(a)


def _analog_to_digital(B: np.ndarray, A: np.ndarray, sr: float):
    """Bilinear transform an analog biquad onto `sr` (inverse of the above)."""
    c = 2.0 * sr
    b = np.array([B[0] * c * c + B[1] * c + B[2],
                  -2 * B[0] * c * c + 2 * B[2],
                  B[0] * c * c - B[1] * c + B[2]])
    a = np.array([A[0] * c * c + A[1] * c + A[2],
                  -2 * A[0] * c * c + 2 * A[2],
                  A[0] * c * c - A[1] * c + A[2]])
    return b / a[0], a / a[0]


def k_weight_coeffs(sr: int):
    """K-weighting biquads AT ANY RATE, re-derived from the standard's own
    48 kHz coefficients through their analog prototype.

    Re-deriving from RBJ cookbook formulas does NOT reproduce the standard —
    tried it, and the shelf came out 0.2577 dB low at 997 Hz, which is exactly
    how far the calibration tone then misses −3.01 LKFS. Round-tripping the
    tabulated coefficients is exact at 48 kHz by construction and analog-correct
    everywhere else.
    """
    if abs(sr - _K48_SR) < 0.5:
        return _K48_SHELF, _K48_HPF
    out = []
    for b, a in (_K48_SHELF, _K48_HPF):
        B, A = _digital_to_analog(b, a, _K48_SR)
        out.append(_analog_to_digital(B, A, float(sr)))
    return out[0], out[1]


def _k_weight(y: np.ndarray, sr: int) -> np.ndarray:
    """BS.1770 K-weighting: high-shelf ("head") + RLB high-pass.
    Validated against the standard's calibration tone — see the self-test."""
    from scipy.signal import lfilter
    (b1, a1), (b2, a2) = k_weight_coeffs(sr)
    return lfilter(b2, a2, lfilter(b1, a1, y, axis=0), axis=0)


def loudness_lufs(y: np.ndarray, sr: int) -> float:
    """Integrated loudness (LUFS), gated per BS.1770-4 (absolute −70 LUFS gate
    then the relative −10 LU gate). Stereo channels sum with weight 1.0."""
    if y.ndim == 1:
        y = y[:, None]
    k = _k_weight(y.astype(np.float64), sr)
    block = int(0.400 * sr)
    hop = max(1, int(block * 0.25))  # 75% overlap, per spec
    if len(k) < block:
        return -70.0
    starts = range(0, len(k) - block + 1, hop)
    # Mean square per block, summed over channels.
    powers = np.array([float((k[s:s + block] ** 2).mean(axis=0).sum()) for s in starts])
    with np.errstate(divide="ignore"):
        lj = -0.691 + 10 * np.log10(np.maximum(powers, 1e-12))
    keep = lj > -70.0
    if not keep.any():
        return -70.0
    rel = -0.691 + 10 * np.log10(powers[keep].mean()) - 10.0
    keep &= lj > rel
    if not keep.any():
        return -70.0
    return float(-0.691 + 10 * np.log10(powers[keep].mean()))


def true_peak_dbfs(y: np.ndarray, sr: int, oversample: int = 4) -> float:
    """Inter-sample peak: lossy codecs reconstruct BETWEEN samples, so a file
    that reads −0.1 dBFS can clip a phone's DAC after decoding."""
    from scipy.signal import resample_poly
    up = resample_poly(y.astype(np.float64), oversample, 1, axis=0)
    peak = float(np.max(np.abs(up))) if len(up) else 0.0
    return 20 * np.log10(max(peak, 1e-9))


# ------------------------------------------------------------- STFT & QA

def stft_mag(m: np.ndarray, nfft: int = 2048, hop: int = 512) -> np.ndarray:
    """Log-magnitude spectrogram frames (frames, bins), L2-normalized per frame
    so comparisons are about TIMBRE, not level."""
    if len(m) < nfft:
        return np.zeros((0, nfft // 2 + 1), dtype=np.float32)
    win = np.hanning(nfft).astype(np.float32)
    idx = np.arange(0, len(m) - nfft, hop)
    frames = np.stack([m[i:i + nfft] * win for i in idx])
    mag = np.abs(np.fft.rfft(frames, axis=1)).astype(np.float32)
    mag = np.log1p(mag * 20.0)
    norm = np.linalg.norm(mag, axis=1, keepdims=True)
    return mag / np.maximum(norm, 1e-6)


def rms_envelope(m: np.ndarray, sr: int, hop_s: float = 0.05) -> np.ndarray:
    hop = max(1, int(sr * hop_s))
    n = len(m) // hop
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    return np.sqrt((m[:n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-12)


def lead_in_s(m: np.ndarray, sr: int, thresh_db: float = -40.0) -> float:
    """Seconds before the music actually starts. The maintainer rejected a
    theme for exactly this ("the start is important … you might click away
    fast") — a bed that fades in from nothing reads as broken audio."""
    env = rms_envelope(m, sr)
    if not len(env):
        return 0.0
    ref = float(np.percentile(env, 90)) or 1e-9
    loud = np.where(20 * np.log10(env / ref) > thresh_db)[0]
    return float(loud[0] * 0.05) if len(loud) else float(len(env) * 0.05)


def spectral_centroid_hz(m: np.ndarray, sr: int) -> float:
    """Brightness. The composer's hard-won foley lesson (metallic == bright)
    applies to a bed too: an over-bright master is fatiguing on phone speakers
    over the hours a background track actually plays."""
    spec = stft_mag(m)
    if not len(spec):
        return 0.0
    freqs = np.fft.rfftfreq(2048, 1 / sr)
    w = spec.mean(axis=0)
    return float((freqs * w).sum() / max(w.sum(), 1e-9))


# Krumhansl-Schmuckler key profiles (major / natural minor), rotated to find
# the best-fitting tonic. The engine snaps tonal SFX onto the playing track's
# scale, so a bed that publishes no key silently switches that feature off.
_KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]
_MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10]


def chromagram(m: np.ndarray, sr: int, nfft: int = 8192, hop: int = 4096) -> np.ndarray:
    """Energy per pitch class over the whole track (12-vector, normalized)."""
    if len(m) < nfft:
        return np.zeros(12)
    win = np.hanning(nfft).astype(np.float32)
    idx = np.arange(0, len(m) - nfft, hop)
    chroma = np.zeros(12)
    freqs = np.fft.rfftfreq(nfft, 1 / sr)
    # Ignore sub-bass rumble and everything above the tonal range.
    band = (freqs > 55.0) & (freqs < 2200.0)
    fb = freqs[band]
    pc = np.round(12 * np.log2(fb / 440.0) + 69).astype(int) % 12
    for i in idx:
        mag = np.abs(np.fft.rfft(m[i:i + nfft] * win))[band]
        np.add.at(chroma, pc, mag)
    total = chroma.sum()
    return chroma / total if total > 0 else chroma


def detect_key(m: np.ndarray, sr: int) -> dict:
    """Best-fitting key by correlating the chromagram against rotated profiles.
    `sfx_safe_pitch_classes` is the scale a one-shot may be re-pitched onto."""
    ch = chromagram(m, sr)
    if not ch.any():
        return {"root": None, "mode": None, "confidence": 0.0,
                "midi_pitch_classes": None, "sfx_safe_pitch_classes": None}
    best = (-2.0, 0, "major")
    for rot in range(12):
        rolled = np.roll(ch, -rot)
        for profile, mode in ((_KS_MAJOR, "major"), (_KS_MINOR, "minor")):
            r = float(np.corrcoef(rolled, profile)[0, 1])
            if r > best[0]:
                best = (r, rot, mode)
    conf, root, mode = best
    steps = _MAJOR_STEPS if mode == "major" else _MINOR_STEPS
    pcs = sorted(((root + s) % 12) for s in steps)
    return {"root": _NOTE_NAMES[root], "mode": mode, "confidence": round(conf, 3),
            "midi_pitch_classes": pcs,
            # Drop the 4th and 7th: the most dissonant degrees to land a
            # non-harmonic one-shot on over an arbitrary chord.
            "sfx_safe_pitch_classes": sorted({(root + s) % 12 for s in steps
                                              if s not in (5, 11, 10)})}


def onset_envelope(m: np.ndarray, sr: int, nfft: int = 2048, hop: int = 512) -> np.ndarray:
    """Positive spectral flux — where energy ARRIVES (percussive events)."""
    if len(m) < nfft * 2:
        return np.zeros(0)
    win = np.hanning(nfft).astype(np.float32)
    idx = np.arange(0, len(m) - nfft, hop)
    mag = np.stack([np.abs(np.fft.rfft(m[i:i + nfft] * win)) for i in idx])
    flux = np.maximum(0.0, np.diff(mag, axis=0)).sum(axis=1)
    return flux / max(float(flux.max()), 1e-9)


def estimate_tempo(m: np.ndarray, sr: int, lo: float = 50.0, hi: float = 190.0,
                   prior_bpm: float | None = None) -> dict:
    """Tempo by autocorrelating the onset envelope, plus the phase of the beat
    grid (so the engine can say how long until the NEXT beat, not just how fast).

    Autocorrelation cannot tell a tempo from its multiples — it locks onto
    whichever subdivision is most strongly played, and measured against the
    briefs it came back at 2× (night: 123 for 62) and 3/2× (title: 140 for 92).
    So the raw peak is snapped onto the simple-ratio family and disambiguated by
    the tempo the brief ASKED for; with no prior we fall back to the usual
    "nearest a comfortable 100 BPM" heuristic.
    """
    env = onset_envelope(m, sr)
    if len(env) < 64:
        return {"bpm": None, "beat_anchor_s": 0.0, "confidence": 0.0}
    fps = sr / 512.0
    env = env - env.mean()
    ac = np.correlate(env, env, mode="full")[len(env) - 1:]
    lags = np.arange(len(ac))
    with np.errstate(divide="ignore", invalid="ignore"):
        bpms = 60.0 * fps / np.maximum(lags, 1e-9)
    ok = (bpms >= lo) & (bpms <= hi) & (lags > 0)
    if not ok.any():
        return {"bpm": None, "beat_anchor_s": 0.0, "confidence": 0.0}
    cand = np.where(ok)[0]
    peak = cand[int(np.argmax(ac[cand]))]
    raw = float(60.0 * fps / peak)
    strength = float(ac[peak] / max(ac[0], 1e-9))

    # Snap onto the simple-ratio family and pick by the prior.
    target = prior_bpm if prior_bpm and prior_bpm > 0 else 100.0
    options = [raw * r for r in (1 / 3, 1 / 2, 2 / 3, 1.0, 3 / 2, 2.0, 3.0)]
    options = [b for b in options if lo <= b <= hi] or [raw]
    bpm = min(options, key=lambda b: abs(np.log(b / target)))

    # Phase: shift a comb of the chosen period across one period, keep the best.
    period = max(1, int(round(60.0 * fps / bpm)))
    scores = [float(env[o::period].sum()) for o in range(period)]
    anchor = float(int(np.argmax(scores)) / fps) if scores else 0.0
    return {"bpm": round(float(bpm), 2), "beat_anchor_s": round(anchor, 3),
            "confidence": round(strength, 3), "raw_bpm": round(raw, 2)}


def stereo_correlation(y: np.ndarray) -> float:
    """+1 = mono-compatible, 0 = wide, negative = phase problems (a bed that
    partly CANCELS on a mono phone speaker)."""
    if y.ndim == 1 or y.shape[1] < 2:
        return 1.0
    l, r = y[:, 0], y[:, 1]
    if l.std() < 1e-6 or r.std() < 1e-6:
        return 1.0
    return float(np.corrcoef(l, r)[0, 1])


# --------------------------------------------------------- loop selection

def find_loop(m: np.ndarray, sr: int, bpm: float | None = None,
              min_loop_s: float = 30.0, window_s: float = 1.6,
              hop_s: float = 0.25) -> dict:
    """Pick the (loop_start, loop_end) whose surrounding audio matches best.

    The engine crossfades loop_end back into loop_start, so what must match is
    the audio LEADING INTO each point: blend two similar passages and the seam
    disappears. Score = spectral cosine similarity (timbre) + level continuity
    (no jump in loudness), and — when the plan handed us a tempo — a bonus for
    landing on the beat grid so the loop keeps time as well as colour.

    Returns seconds + the score, so a bad seam is visible in tracks.json rather
    than silently shipped.
    """
    dur = len(m) / sr
    spec = stft_mag(m)
    if not len(spec) or dur < min_loop_s + 4:
        return {"loop_start_s": 0.0, "loop_end_s": round(dur, 3),
                "crossfade_ms": 900, "score": 0.0, "beat_snapped": False}
    fps = sr / 512.0                     # stft hop → frames per second
    wf = max(2, int(window_s * fps))     # comparison window, in frames
    env = rms_envelope(m, sr)

    def env_at(t: float) -> float:
        i = min(len(env) - 1, max(0, int(t / 0.05)))
        return float(env[i])

    # Candidate ranges: start after any intro, end near (but not at) the tail.
    starts = np.arange(max(1.0, dur * 0.04), dur * 0.34, hop_s)
    ends = np.arange(dur * 0.72, dur - 0.35, hop_s)
    beat_s = 60.0 / bpm if bpm and bpm > 20 else None

    best = {"loop_start_s": 0.0, "loop_end_s": round(dur, 3),
            "crossfade_ms": 900, "score": 0.0, "beat_snapped": False}
    for s in starts:
        si = int(s * fps)
        if si - wf < 0:
            continue
        a = spec[si - wf:si]
        ea = env_at(s)
        for e in ends:
            if e - s < min_loop_s:
                continue
            ei = int(e * fps)
            if ei > len(spec) or ei - wf < 0:
                continue
            b = spec[ei - wf:ei]
            if len(a) != len(b):
                continue
            timbre = float((a * b).sum() / len(a))          # frames are L2-normed
            eb = env_at(e)
            level = 1.0 - min(1.0, abs(ea - eb) / max(ea, eb, 1e-6))
            # Weights sum to 1.0 so the reported seam is always 0..1.
            beat = 0.0
            if beat_s:                                       # keep the pulse across the seam
                phase = ((e - s) / beat_s) % 1.0
                beat = 1.0 - 2 * min(phase, 1 - phase)
            score = 0.70 * timbre + 0.25 * level + 0.05 * beat
            if score > best["score"]:
                best = {"loop_start_s": round(float(s), 3),
                        "loop_end_s": round(float(e), 3),
                        "crossfade_ms": 900,
                        "score": round(score, 4),
                        "beat_snapped": bool(beat_s)}
    return best


# ------------------------------------------------------------- mastering

TARGET_LUFS = -18.0   # a background bed: present, never competing with SFX
CEILING_DBTP = -1.5   # true-peak ceiling, headroom for lossy reconstruction


def master(y: np.ndarray, sr: int, target_lufs: float = TARGET_LUFS,
           trim_lead: bool = True) -> tuple[np.ndarray, dict]:
    """Trim dead air, match loudness, guarantee true-peak headroom.

    Gain is applied as ONE constant — no compression, no limiting: the model's
    own dynamics are the composition, and squashing a score to hit a number is
    exactly the "loudness war" mistake. If the matched gain would breach the
    ceiling we back the whole track off instead (headroom wins over the target;
    a bed 1 dB quiet is inaudible, a clipping bed is not).
    """
    info: dict = {}
    if trim_lead:
        lead = lead_in_s(to_mono(y), sr)
        if lead > 0.12:                       # a real silent head, not just a soft entry
            y = y[int((lead - 0.06) * sr):]   # keep 60 ms so the first note isn't clipped
            info["trimmed_lead_s"] = round(lead, 3)

    lufs_in = loudness_lufs(y, sr)
    gain_db = target_lufs - lufs_in
    gained = y * (10 ** (gain_db / 20))
    tp = true_peak_dbfs(gained, sr)
    if tp > CEILING_DBTP:                     # back off rather than limit
        gain_db -= tp - CEILING_DBTP
        gained = y * (10 ** (gain_db / 20))
        info["headroom_limited"] = True

    n = min(len(gained), max(1, int(sr * 0.012)))   # 12 ms de-click edges
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None]
    gained[:n] *= ramp
    gained[-n:] *= ramp[::-1]

    info.update({
        "lufs_in": round(lufs_in, 2),
        "gain_db": round(float(gain_db), 2),
        "lufs_out": round(loudness_lufs(gained, sr), 2),
        "true_peak_dbtp": round(true_peak_dbfs(gained, sr), 2),
    })
    return np.clip(gained, -1.0, 1.0), info


def musical_analysis(y: np.ndarray, sr: int, prior_bpm: float | None = None) -> dict:
    """Key + tempo, so the engine's musical clock and tonal-SFX scale-snap keep
    working when these beds are the score (they read it from tracks.json)."""
    m = to_mono(y)
    return {"key": detect_key(m, sr), "timing": estimate_tempo(m, sr, prior_bpm=prior_bpm)}


def measure(y: np.ndarray, sr: int) -> dict:
    """The QA card for one candidate — what the selector ranks on."""
    m = to_mono(y)
    env = rms_envelope(m, sr)
    peak = float(np.max(np.abs(m))) if len(m) else 0.0
    rms = float(np.sqrt((m ** 2).mean())) if len(m) else 0.0
    return {
        "duration_s": round(len(m) / sr, 2),
        "lufs": round(loudness_lufs(y, sr), 2),
        "true_peak_dbtp": round(true_peak_dbfs(y, sr), 2),
        "lead_in_s": round(lead_in_s(m, sr), 3),
        "tail_rms_ratio": round(float(env[-6:].mean() / max(env.mean(), 1e-9)), 3) if len(env) > 6 else 1.0,
        "crest_db": round(20 * np.log10(max(peak, 1e-9) / max(rms, 1e-9)), 2),
        "centroid_hz": round(spectral_centroid_hz(m, sr), 1),
        "stereo_corr": round(stereo_correlation(y), 3),
        "silence_frac": round(float((env < np.percentile(env, 90) * 0.02).mean()), 3) if len(env) else 1.0,
    }


def write_wav(path: str, y: np.ndarray, sr: int) -> None:
    ch = y.shape[1] if y.ndim == 2 else 1
    with wave.open(path, "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(y, -1, 1) * 32767.0).astype("<i2").tobytes())


VARIANTS = [
    {"ext": "ogg", "args": ["-c:a", "libopus", "-b:a", "96k", "-vbr", "on"],
     "mime": 'audio/ogg; codecs="opus"'},
    {"ext": "m4a", "args": ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"],
     "mime": "audio/mp4"},
]


def encode_variants(wav_path: str) -> list[dict]:
    """WAV master → the two delivery copies the engine picks between."""
    ff = find_ffmpeg()
    if not ff:
        raise RuntimeError("no ffmpeg (PATH or imageio-ffmpeg) — cannot encode delivery copies")
    stem = os.path.splitext(wav_path)[0]
    out = []
    for v in VARIANTS:
        dst = f"{stem}.{v['ext']}"
        try:
            subprocess.run([ff, "-y", "-v", "error", "-i", wav_path, *v["args"], dst],
                           check=True, timeout=900)
        except (subprocess.SubprocessError, OSError) as e:
            print(f"  ! {v['ext']} encode failed: {e}")
            continue
        out.append({"file": os.path.basename(dst), "mime": v["mime"],
                    "size_bytes": os.path.getsize(dst)})
    return out
